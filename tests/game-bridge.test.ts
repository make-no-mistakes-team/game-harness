import { expect, test } from "bun:test";
import { GameBridgeClient } from "../src/server/game-bridge.ts";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Server, type Socket } from "node:net";
import type {
  NativeProcess,
  NativeSession,
} from "../src/server/minecraft-client.ts";
import type { BridgeNotice, PlayerLife } from "../src/shared/contracts.ts";

test("an unstarted native bridge closes idempotently without inventing video", async () => {
  const bridge = new GameBridgeClient();
  await bridge.close();
  await bridge.close();
  expect(bridge.snapshot().status).toBe("disconnected");
  expect(bridge.snapshot().video.status).toBe("idle");
  expect(bridge.latestFrame()).toBeNull();
});

test("cancelled undispatched actions do not claim a confirmed gameplay effect", async () => {
  const bridge = new GameBridgeClient();
  const controller = new AbortController();
  controller.abort();
  const outcome = await bridge.execute(
    { kind: "move", controls: { forward: true }, duration_ms: 200 },
    controller.signal,
  );
  expect(outcome.status).toBe("cancelled");
  expect(outcome.evidence).toEqual({
    effect_confirmed: false,
    neutralized_effect: false,
  });
  await bridge.close();
});

test("an unavailable native emitter never silently substitutes another game adapter", async () => {
  const bridge = new GameBridgeClient();
  const outcome = await bridge.execute(
    { kind: "look", yaw: 0, pitch: 0 },
    new AbortController().signal,
  );
  expect(outcome.status).toBe("unknown");
  expect(outcome.requires_reconnect).toBe(true);
  expect(outcome.evidence).toEqual({
    effect_confirmed: false,
    neutralized_effect: false,
  });
  expect(bridge.latestFrame()).toBeNull();
  await bridge.close();
});

test("cancel without a control socket waits for already-owned terminal cleanup", async () => {
  const bridge = new GameBridgeClient();
  const emitterExit = Promise.withResolvers<void>();
  Reflect.set(bridge, "closing", emitterExit.promise);
  let returned = false;
  const cancellation = bridge.cancel("Terminal emitter cleanup is still pending.").then(() => {
    returned = true;
  });
  try {
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(returned).toBe(false);
    emitterExit.resolve();
    await cancellation;
    expect(returned).toBe(true);
  } finally {
    emitterExit.resolve();
    await cancellation;
    Reflect.set(bridge, "closing", null);
    await bridge.close();
  }
});

test("authoritative death preserves the owned session, video, and unknown effect; respawn replaces only life", async () => {
  // Real socket/process ownership fixture; protocol receipts are not Minecraft gameplay proof.
  const bridge = new GameBridgeClient();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closure = Promise.withResolvers<void>();
  child.once("close", () => closure.resolve());
  const session: NativeSession = {
    secret: randomBytes(32).toString("hex"),
    session_id: randomUUID(),
    world_id: "transport-death-world",
    epoch: 7,
    host: "127.0.0.1",
    port: 25565,
    control_port: 0,
    video_port: 0,
  };
  const owned: NativeProcess = {
    child,
    closed: closure.promise,
    username: "fixture",
    session,
    diagnostics: [],
  };
  Reflect.set(bridge, "owned", owned);
  Reflect.set(bridge, "state", {
    ...bridge.snapshot(),
    status: "connected",
    world_id: session.world_id,
    epoch: session.epoch,
    session_id: session.session_id,
    life: { life_id: 1, status: "alive", can_respawn: false, death: null },
  });
  const notices: BridgeNotice[] = [];
  bridge.subscribe((notice) => notices.push(notice));
  let peer: Socket | null = null;
  let videoPeer: Socket | null = null;
  try {
    const port: number = await Reflect.get(bridge, "listener").call(
      bridge,
      "control",
    );
    const handshake = Promise.withResolvers<void>();
    const server = (Reflect.get(bridge, "servers") as Server[])[0]!;
    server.once("connection", (socket) =>
      socket.once("data", () => handshake.resolve()),
    );
    peer = createConnection({ host: "127.0.0.1", port });
    peer.on("error", () => {});
    const connected = Promise.withResolvers<void>();
    peer.once("connect", connected.resolve);
    await connected.promise;
    peer.write(JSON.stringify({ ...session, protocol: 2 }) + "\n");
    await handshake.promise;
    const death = {
      notice: {
        type: "life",
        world_id: session.world_id,
        epoch: session.epoch,
        session_id: session.session_id,
        generation: 2,
        neutralized: true,
        life: {
          life_id: 1,
          status: "dead",
          can_respawn: false,
          death: { death_id: "first", at: new Date().toISOString(), message: null },
        } satisfies PlayerLife,
      },
    };
    let input = "";
    peer.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      let end: number;
      while ((end = input.indexOf("\n")) >= 0) {
        const request = JSON.parse(input.slice(0, end)) as {
          id: number;
          method: string;
          params: { kind?: string; profile?: string };
          life_id: number;
          generation: number;
        };
        input = input.slice(end + 1);
        if (request.method === "ping")
          peer?.write(
            JSON.stringify({ id: request.id, ok: true, data: {} }) + "\n",
          );
        if (request.method === "motor_profile")
          peer?.write(JSON.stringify({ id: request.id, ok: true,
            data: { profile: request.params.profile } }) + "\n");
        if (request.method === "execute" && request.params.kind !== "respawn")
          peer?.write(JSON.stringify(death) + "\n" + JSON.stringify({
            id: request.id, ok: true, data: {
              status: "unknown", summary: "Unconfirmed interrupted effect",
              evidence: { effect_confirmed: false, neutralized: true, life_fenced: true },
            },
          }) + "\n");
        if (request.method === "execute" && request.params.kind === "respawn") {
          expect(request.life_id).toBe(1);
          expect(request.generation).toBe(death.notice.generation);
          const life = { life_id: 2, status: "alive", can_respawn: false, death: null };
          // Exercise the actual stream ordering: new-life event is processed before the RPC continuation.
          peer?.write(JSON.stringify({ notice: { ...death.notice, life } }) + "\n" +
            JSON.stringify({ id: request.id, ok: true, data: {
              status: "succeeded", summary: "Authoritative replacement receipt",
              evidence: { effect_confirmed: true, neutralized: true, life },
            } }) + "\n");
        }
      }
    });
    peer.write(
      JSON.stringify({ notice: { ...death.notice, epoch: 6 } }) + "\n",
    );
    peer.write(
      JSON.stringify({
        notice: { ...death.notice, session_id: "older-session" },
      }) + "\n",
    );
    await Reflect.get(bridge, "request").call(bridge, "ping", {}, 1000);
    expect(bridge.snapshot().status).toBe("connected");
    expect(child.killed).toBe(false);
    const result = await bridge.execute(
      { kind: "move", controls: { forward: true }, duration_ms: 200 },
      new AbortController().signal,
    );
    expect(result.status).toBe("unknown");
    expect(result.requires_reconnect).toBeUndefined();
    expect(bridge.snapshot().error).toBeNull();
    expect(bridge.snapshot().status).toBe("connected");
    expect(bridge.snapshot().session_id).toBe(session.session_id);
    expect(bridge.snapshot().life?.status).toBe("dead");
    expect(bridge.snapshot().life?.can_respawn).toBe(false);
    expect(child.killed).toBe(false);
    expect(bridge.snapshot().world_id).toBe(session.world_id);
    expect(bridge.snapshot().epoch).toBe(session.epoch);
    expect(
      notices.find((notice) => notice.type === "game_event")?.data,
    ).toMatchObject({
      type: "death",
      world_id: session.world_id,
      epoch: session.epoch,
    });
    const frame = Buffer.alloc(36);
    frame.writeUInt32LE(0x47485631, 0);
    frame.writeUInt32LE(1, 4); frame.writeUInt32LE(1, 8); frame.writeUInt32LE(4, 12);
    frame.writeDoubleLE(Date.now(), 24);
    const frameReceived = Promise.withResolvers<void>();
    bridge.subscribeFrames(() => frameReceived.resolve());
    const videoPort: number = await Reflect.get(bridge, "listener").call(bridge, "video");
    videoPeer = createConnection({ host: "127.0.0.1", port: videoPort });
    videoPeer.on("error", () => {});
    const videoOpened = Promise.withResolvers<void>();
    videoPeer.once("connect", videoOpened.resolve);
    await videoOpened.promise;
    videoPeer.write(Buffer.concat([Buffer.from(JSON.stringify({ ...session, protocol: 2 }) + "\n"), frame]));
    await frameReceived.promise;
    expect(bridge.latestFrame()).toEqual(frame);
    expect(bridge.snapshot().video.status).toBe("streaming");
    await bridge.setMotorProfile("fast");
    expect(bridge.snapshot().motor_profile).toBe("fast");
    expect(bridge.snapshot().life?.status).toBe("dead");
    peer.write(JSON.stringify({ notice: { ...death.notice,
      life: { ...death.notice.life, can_respawn: true },
    } }) + "\n");
    await Reflect.get(bridge, "request").call(bridge, "ping", {}, 1000);
    expect(bridge.snapshot().life).toEqual({ ...death.notice.life, can_respawn: true });
    expect(bridge.snapshot().session_id).toBe(session.session_id);
    expect(bridge.snapshot().epoch).toBe(session.epoch);
    expect(bridge.snapshot().error).toBeNull();
    const lifeEvents = notices.filter(notice => notice.type === "game_event").map(notice => notice.data);
    expect(lifeEvents).toHaveLength(2);
    expect(lifeEvents[1]).toMatchObject({ type: "life", session_id: session.session_id,
      life: { ...death.notice.life, can_respawn: true } });
    const respawn = await bridge.execute({ kind: "respawn" }, new AbortController().signal);
    expect(respawn.status).toBe("succeeded");
    expect(bridge.snapshot().life?.life_id).toBe(2);
    expect(bridge.snapshot().life?.status).toBe("alive");
    expect(bridge.snapshot().session_id).toBe(session.session_id);
    expect(bridge.snapshot().epoch).toBe(7);
    expect(child.killed).toBe(false);
    const secondDeath = { ...death.notice, generation: 3, life: {
      ...death.notice.life, life_id: 2,
      death: { ...death.notice.life.death, death_id: "second" },
    } };
    peer.write(JSON.stringify({ notice: secondDeath }) + "\n");
    await Reflect.get(bridge, "request").call(bridge, "ping", {}, 1000);
    expect(bridge.snapshot().life?.life_id).toBe(2);
    expect(bridge.snapshot().life?.status).toBe("dead");
    expect(bridge.snapshot().error).toBeNull();
    peer.end();
    await closure.promise;
    await bridge.disconnect();
    expect(child.killed).toBe(true);
    expect(bridge.snapshot().life).toBeNull();
    expect(bridge.snapshot().status).toBe("error");
  } finally {
    peer?.destroy();
    videoPeer?.destroy();
    await bridge.close();
    child.kill("SIGKILL");
    await closure.promise;
  }
}, 10000);

test("neutralize accepts its bound acknowledgement before a newer death fence in the same stream chunk", async () => {
  const bridge = new GameBridgeClient();
  await expect(bridge.neutralize()).rejects.toThrow("no neutralization proof");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closure = Promise.withResolvers<void>();
  child.once("close", () => closure.resolve());
  const session: NativeSession = {
    secret: randomBytes(32).toString("hex"), session_id: randomUUID(),
    world_id: "barrier-world", epoch: 3, host: "127.0.0.1", port: 25565,
    control_port: 0, video_port: 0,
  };
  Reflect.set(bridge, "owned", { child, closed: closure.promise, session, username: "fixture", diagnostics: [] });
  Reflect.set(bridge, "state", { ...bridge.snapshot(), status: "connected",
    world_id: session.world_id, epoch: 3, session_id: session.session_id,
    life: { life_id: 1, status: "dead", can_respawn: false, death: null } });
  let peer: Socket | null = null;
  try {
    const port: number = await Reflect.get(bridge, "listener").call(bridge, "control");
    const accepted = Promise.withResolvers<void>();
    const server = (Reflect.get(bridge, "servers") as Server[])[0]!;
    server.once("connection", socket => socket.once("data", () => accepted.resolve()));
    peer = createConnection({ host: "127.0.0.1", port });
    peer.on("error", () => {});
    const opened = Promise.withResolvers<void>();
    peer.once("connect", opened.resolve);
    await opened.promise;
    peer.write(JSON.stringify({ ...session, protocol: 2 }) + "\n");
    await accepted.promise;
    let requestReceived = Promise.withResolvers<{ id: number; generation: number }>();
    let requests = 0;
    let input = "";
    peer.on("data", chunk => {
      input += chunk.toString();
      let end: number;
      while ((end = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        const request = JSON.parse(line);
        requests++;
        requestReceived.resolve(request);
      }
    });
    let completed = false;
    const first = bridge.neutralize().then(() => { completed = true; });
    const second = bridge.neutralize();
    const request = await requestReceived.promise;
    expect(completed).toBe(false);
    expect(requests).toBe(1);
    const laterGeneration = request.generation + 1;
    peer.write(JSON.stringify({ id: request.id, ok: true, data: {
      neutralized: true, generation: request.generation, session_id: session.session_id, life_id: 1,
    } }) + "\n" + JSON.stringify({ notice: {
      type: "life", world_id: session.world_id, epoch: session.epoch, session_id: session.session_id,
      generation: laterGeneration, neutralized: true,
      life: { life_id: 1, status: "dead", can_respawn: false, death: null },
    } }) + "\n");
    await Promise.all([first, second]);
    expect(completed).toBe(true);
    expect(child.killed).toBe(false);
    expect(bridge.snapshot().life?.status).toBe("dead");
    expect(bridge.snapshot().status).toBe("connected");
    expect(bridge.snapshot().error).toBeNull();
    requestReceived = Promise.withResolvers<{ id: number; generation: number }>();
    const nextBarrier = bridge.neutralize();
    const nextRequest = await requestReceived.promise;
    expect(nextRequest.generation).toBe(laterGeneration + 1);
    peer.write(JSON.stringify({ id: nextRequest.id, ok: true, data: {
      neutralized: true, generation: nextRequest.generation, session_id: session.session_id, life_id: 1,
    } }) + "\n");
    await nextBarrier;
    expect(child.killed).toBe(false);
    await bridge.disconnect();
    expect(child.killed).toBe(true);
  } finally {
    peer?.destroy();
    await bridge.close();
    child.kill("SIGKILL");
    await closure.promise;
  }
}, 10000);

test("a saved-dead player connects without emitting an execute or respawn request", async () => {
  const bridge = new GameBridgeClient();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closure = Promise.withResolvers<void>();
  child.once("close", () => closure.resolve());
  const methods: string[] = [];
  const peers: Socket[] = [];
  Reflect.set(Reflect.get(bridge, "launcher"), "launch", async (
    config: { world_id: string; epoch: number; motor_profile?: string },
    controlPort: number,
    videoPort: number,
  ) => {
    const session: NativeSession = {
      secret: randomBytes(32).toString("hex"), session_id: randomUUID(),
      world_id: config.world_id, epoch: config.epoch, host: "127.0.0.1",
      port: 25565, control_port: controlPort, video_port: videoPort,
    };
    const peer = createConnection({ host: "127.0.0.1", port: controlPort });
    peers.push(peer);
    peer.on("error", () => {});
    peer.once("connect", () => peer.write(JSON.stringify({ ...session, protocol: 2 }) + "\n"));
    let input = "";
    peer.on("data", chunk => {
      input += chunk.toString();
      let end: number;
      while ((end = input.indexOf("\n")) >= 0) {
        const request = JSON.parse(input.slice(0, end));
        input = input.slice(end + 1);
        methods.push(request.method);
        if (request.method !== "observe") continue;
        peer.write(JSON.stringify({ id: request.id, ok: true, data: {
          schema_version: 2, preset_id: "minecraft-observable-initial-r2",
          profile_id: "player-observable-structured",
          session_id: session.session_id, world_id: session.world_id, epoch: session.epoch,
          observation_seq: 1, captured_at: new Date().toISOString(),
          life: { life_id: 1, status: "dead", can_respawn: false, death: null },
          player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0,
            health: 0, food: 20, on_ground: true, in_water: false, inventory: [] },
          blocks: [], entities: [], sounds: [], coverage: { partial: true, max_age_ms: 1000 },
        } }) + "\n");
      }
    });
    return { child, closed: closure.promise, session, username: "fixture", diagnostics: [] };
  });
  try {
    await bridge.connect({ host: "127.0.0.1", port: 25565, version: "1.21.4",
      world_id: "saved-dead-world", epoch: 4, motor_profile: "fast" });
    expect(bridge.snapshot().status).toBe("connected");
    expect(bridge.snapshot().life).toEqual({
      life_id: 1, status: "dead", can_respawn: false, death: null,
    });
    expect(bridge.snapshot().error).toBeNull();
    expect(bridge.snapshot().motor_profile).toBe("fast");
    expect(methods).toEqual(["observe"]);
    expect(child.killed).toBe(false);
    const ready = Promise.withResolvers<void>();
    bridge.subscribe(notice => {
      if (notice.type === "state" && bridge.snapshot().life?.can_respawn) ready.resolve();
    });
    peers[0]!.write(JSON.stringify({ notice: {
      type: "life", world_id: "saved-dead-world", epoch: 4,
      session_id: bridge.snapshot().session_id, generation: 1, neutralized: true,
      life: { life_id: 1, status: "dead", can_respawn: true, death: null },
    } }) + "\n");
    await ready.promise;
    expect(bridge.snapshot().life).toEqual({
      life_id: 1, status: "dead", can_respawn: true, death: null,
    });
    expect(bridge.snapshot().status).toBe("connected");
    expect(bridge.snapshot().error).toBeNull();
    expect(methods).toEqual(["observe"]);
    expect(child.killed).toBe(false);
  } finally {
    for (const peer of peers) peer.destroy();
    await bridge.close();
    child.kill("SIGKILL");
    await closure.promise;
  }
}, 10000);
