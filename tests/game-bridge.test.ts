import { expect, test } from "bun:test";
import { GameBridgeClient } from "../src/server/game-bridge.ts";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Server, type Socket } from "node:net";
import type { NativeProcess, NativeSession } from "../src/server/minecraft-client.ts";
import type { BridgeNotice, GameAction, GameActionResult, PlayerLife } from "../src/shared/contracts.ts";
import type { EffectEnvelope } from "../src/shared/control.ts";
import { minecraftProfileConfiguration } from "../src/shared/minecraft.ts";
import { nativeFrame } from "./helpers/native-frame.ts";
import { effectScope, minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding, sha256 } from "./helpers/adapter-contract.ts";
import { z } from "zod";
import { effectEnvelopeSchema } from "../src/shared/control.ts";
import { gameActionSchema } from "../src/shared/validation.ts";
import { jsonSchema } from "../src/shared/primitives.ts";

const adapter = minecraftTestAdapter();
function envelope(action: GameAction, session?: NativeSession, life = 1, space = 1, selected = adapter): EffectEnvelope<GameAction> {
  const scope = { ...effectScope(), ...(session ? { world_id: session.world_id, session_id: session.session_id, epoch: session.epoch } : {}),
    native_boot_id: "fixture-native-boot", life_id: life, space_epoch: space, execution_id: "transport-diagnostic" };
  return { operation_id: randomUUID(), compatibility_hash: sha256(selected.descriptor), scope,
    invocation: { kind: "diagnostic", execution_id: scope.execution_id, source_hash: scope.source_hash }, action, expected_screen: null };
}
function hello(session: NativeSession, selected = adapter) {
  return { protocol: 3, secret: session.secret, session_id: session.session_id, world_id: session.world_id,
    epoch: session.epoch, native_boot_id: "fixture-native-boot", descriptor: selected.descriptor };
}
function fixture(selected = adapter, dead = false) {
  const bridge = new GameBridgeClient(process.cwd(), { descriptor: selected.descriptor, schemas: selected.schemas, adapter: selected });
  // Real owned OS-process closure is under test; a fake clock cannot terminate
  // this child or acknowledge its actual socket/process exit.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = Promise.withResolvers<void>(); child.once("close", () => closed.resolve());
  const session: NativeSession = { secret: randomBytes(32).toString("hex"), session_id: randomUUID(), world_id: randomUUID(), epoch: 2 ** 31 + 7,
    host: "127.0.0.1", port: 25565, control_port: 0, video_port: 0 };
  const owned: NativeProcess = { child, closed: closed.promise, session, username: "fixture", diagnostics: [] };
  let life: PlayerLife = { life_id: 1, status: dead ? "dead" : "alive", can_respawn: false, death: null };
  Reflect.set(bridge, "owned", owned);
  Reflect.set(bridge, "state", { ...bridge.snapshot(), status: "connected", world_id: session.world_id, epoch: session.epoch,
    session_id: session.session_id, life, binding: minecraftTestBinding(selected), space: { dimension_id: "minecraft:overworld", space_epoch: 1 } });
  const peers: Socket[] = [];
  async function channel(kind: "control" | "video", frame?: Uint8Array) {
    const port: number = await Reflect.get(bridge, "listener").call(bridge, kind);
    const server = (Reflect.get(bridge, "servers") as Server[]).at(-1)!;
    const received = Promise.withResolvers<void>(); server.once("connection", socket => socket.once("data", () => received.resolve()));
    const peer = createConnection({ host: "127.0.0.1", port }); peers.push(peer); peer.on("error", () => {});
    await new Promise<void>(resolve => peer.once("connect", resolve));
    peer.write(Buffer.concat([Buffer.from(JSON.stringify(hello(session, selected)) + "\n"), Buffer.from(frame ?? [])]));
    await received.promise; return peer;
  }
  function notice(next: PlayerLife, generation: number, spaceEpoch = 1) {
    life = next;
    return { type: "life", world_id: session.world_id, epoch: session.epoch, session_id: session.session_id,
      native_boot_id: "fixture-native-boot", generation, life, neutralized: true,
      space: { dimension_id: "minecraft:overworld", space_epoch: spaceEpoch }, screen: null };
  }
  async function close() { for (const peer of peers) peer.destroy(); await bridge.close(); child.kill("SIGKILL"); await closed.promise; }
  return { bridge, child, closed: closed.promise, session, owned, peers, channel, notice, close };
}
function reply(peer: Socket, id: number, data: unknown) { peer.write(JSON.stringify({ id, ok: true, data }) + "\n"); }
const requestSchema = z.object({ id: z.number().int().positive(), method: z.string(), generation: z.number().int(),
  params: z.record(z.string(), jsonSchema) });
type WireRequest = z.infer<typeof requestSchema>;
const effectRequestSchema = effectEnvelopeSchema(gameActionSchema);
function requests(peer: Socket, receive: (request: WireRequest) => void) {
  let input = "";
  peer.on("data", chunk => { input += chunk.toString(); let end: number;
    while ((end = input.indexOf("\n")) >= 0) { const request = requestSchema.parse(JSON.parse(input.slice(0, end))); input = input.slice(end + 1); receive(request); } });
}
function effectReply(request: WireRequest, result: GameActionResult) {
  const effect = effectRequestSchema.parse(request.params);
  return { operation_id: effect.operation_id, compatibility_hash: effect.compatibility_hash, scope: effect.scope, result };
}

test("an unstarted native bridge closes idempotently without inventing video", async () => {
  const bridge = new GameBridgeClient(); await bridge.close(); await bridge.close();
  expect(bridge.snapshot().status).toBe("disconnected"); expect(bridge.snapshot().video.status).toBe("idle"); expect(bridge.latestFrame()).toBeNull();
});
test("cancelled undispatched actions never claim a confirmed effect", async () => {
  const bridge = new GameBridgeClient(), controller = new AbortController(); controller.abort();
  const result = await bridge.execute(envelope({ kind: "move", controls: { forward: true }, duration_ms: 200 }), controller.signal);
  expect(result.status).toBe("cancelled"); expect(result.evidence).toEqual({ effect_confirmed: false, neutralized_effect: false }); await bridge.close();
});
test("an unnegotiated emitter refuses before dispatch without inventing another adapter or an unknown emitted effect", async () => {
  const bridge = new GameBridgeClient();
  const result = await bridge.execute(envelope({ kind: "look", yaw: 0, pitch: 0 }), new AbortController().signal);
  expect(result.status).toBe("failed"); expect(result.requires_reconnect).toBeUndefined(); expect(bridge.adapter()).toBeNull(); expect(bridge.latestFrame()).toBeNull(); await bridge.close();
});
test("expected-owner cancellation still awaits already-owned terminal cleanup without a socket", async () => {
  const bridge = new GameBridgeClient(), exited = Promise.withResolvers<void>(), effect = envelope({ kind: "look", yaw: 0, pitch: 0 });
  Reflect.set(bridge, "closing", exited.promise); let returned = false;
  const cancellation = bridge.cancel("Terminal owner still draining", { operation_id: effect.operation_id, scope: effect.scope }).then(() => { returned = true; });
  try { await new Promise<void>(resolve => setImmediate(resolve)); expect(returned).toBe(false); exited.resolve(); await cancellation; expect(returned).toBe(true); }
  finally { exited.resolve(); await cancellation; Reflect.set(bridge, "closing", null); await bridge.close(); }
});
test("authoritative death preserves session/video/unknown history; explicit respawn changes life and space only", async () => {
  // Actual sockets/process ownership, deliberately synthetic native packets: no game-hook proof.
  const f = fixture(), notices: BridgeNotice[] = []; f.bridge.subscribe(value => notices.push(value));
  try {
    const peer = await f.channel("control");
    const dead: PlayerLife = { life_id: 1, status: "dead", can_respawn: false,
      death: { death_id: "first", at: new Date().toISOString(), message: null } };
    requests(peer, request => {
      if (request.method === "ping") reply(peer, request.id, {});
      if (request.method === "motor_profile") {
        const selected = minecraftTestAdapter(z.enum(["balanced", "precise", "fast"]).parse(request.params.profile));
        reply(peer, request.id, { profile: request.params.profile, descriptor: selected.descriptor });
      }
      if (request.method !== "execute") return;
      const effect = effectRequestSchema.parse(request.params), action = effect.action;
      if (action.kind !== "respawn") {
        peer.write(JSON.stringify({ notice: f.notice(dead, 2) }) + "\n");
        reply(peer, request.id, effectReply(request, { status: "unknown", summary: "Synthetic interrupted effect",
          evidence: { effect_confirmed: false, neutralized: true, life_fenced: true } }));
      } else {
        expect(effect.scope.life_id).toBe(1); expect(request.generation).toBe(2);
        const life: PlayerLife = { life_id: 2, status: "alive", can_respawn: false, death: null };
        peer.write(JSON.stringify({ notice: f.notice(life, 3, 2) }) + "\n");
        reply(peer, request.id, effectReply(request, { status: "succeeded", summary: "Synthetic replacement receipt", evidence: jsonSchema.parse({ effect_confirmed: true, life }) }));
      }
    });
    peer.write(JSON.stringify({ notice: { ...f.notice(dead, 2), epoch: f.session.epoch - 1 } }) + "\n" +
      JSON.stringify({ notice: { ...f.notice(dead, 2), session_id: "obsolete-session" } }) + "\n");
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000);
    const first = await f.bridge.execute(envelope({ kind: "move", controls: { forward: true }, duration_ms: 200 }, f.session), new AbortController().signal);
    expect(first.status).toBe("unknown"); expect(first.requires_reconnect).toBeUndefined(); expect(f.bridge.snapshot().life).toEqual(dead);
    expect(f.bridge.snapshot().status).toBe("connected"); expect(f.child.killed).toBe(false);
    expect(notices.find(value => value.type === "game_event")?.data).toMatchObject({ type: "death", epoch: f.session.epoch });
    const frame = nativeFrame({ width: 1, height: 1 }), delivered = Promise.withResolvers<void>();
    f.bridge.subscribeFrames(() => delivered.resolve()); await f.channel("video", frame); await delivered.promise;
    expect(f.bridge.latestFrame()).toEqual(Buffer.from(frame)); expect(f.bridge.snapshot().video.status).toBe("streaming");
    await f.bridge.setMotorProfile("fast");
    expect(f.bridge.snapshot().binding?.descriptor.observation.profile.configuration).toEqual(minecraftProfileConfiguration("fast"));
    expect(f.bridge.snapshot().life?.status).toBe("dead");
    peer.write(JSON.stringify({ notice: f.notice({ ...dead, can_respawn: true }, 2) }) + "\n");
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000);
    const respawn = await f.bridge.execute(envelope({ kind: "respawn" }, f.session, 1, 1, minecraftTestAdapter("fast")), new AbortController().signal);
    expect(respawn.status).toBe("succeeded"); expect(f.bridge.snapshot().life?.life_id).toBe(2); expect(f.bridge.snapshot().space?.space_epoch).toBe(2);
    expect(f.bridge.snapshot().session_id).toBe(f.session.session_id); expect(f.bridge.snapshot().epoch).toBe(f.session.epoch); expect(f.child.killed).toBe(false);
    peer.write(JSON.stringify({ notice: f.notice({ ...dead, life_id: 2, death: { ...dead.death!, death_id: "second" } }, 4, 2) }) + "\n");
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000);
    expect(f.bridge.snapshot().life?.status).toBe("dead"); expect(f.bridge.snapshot().error).toBeNull();
    peer.end(); await f.closed; await f.bridge.disconnect();
    expect(f.bridge.snapshot().status).toBe("error"); expect(f.bridge.snapshot().life).toBeNull();
  } finally { await f.close(); }
}, 10000);
test("expected-owner barrier accepts its ACK before newer death notice without advancing the native clock speculatively", async () => {
  const f = fixture(adapter, true);
  try {
    const peer = await f.channel("control"), effect = envelope({ kind: "look", yaw: 0, pitch: 0 }, f.session);
    Reflect.set(f.bridge, "ownedEffect", { effect, generation: 1 });
    let count = 0; const received = Promise.withResolvers<WireRequest>(); requests(peer, request => { count++; received.resolve(request); });
    const owner = { operation_id: effect.operation_id, scope: effect.scope };
    let completed = false;
    const a = f.bridge.neutralize(owner).then(() => { completed = true; }), b = f.bridge.neutralize(owner);
    const request = await received.promise; expect(completed).toBe(false); expect(count).toBe(1);
    expect(request.params.expected_owner).toMatchObject({ ...owner, generation: 1 }); expect(request.generation).toBe(1);
    peer.write(JSON.stringify({ id: request.id, ok: true, data: { neutralized: true, matched_owner: true, generation: 2,
      session_id: f.session.session_id, life_id: 1 } }) + "\n" + JSON.stringify({ notice: f.notice({ life_id: 1, status: "dead", can_respawn: false, death: null }, 3) }) + "\n");
    await Promise.all([a, b]); expect(completed).toBe(true); expect(f.child.killed).toBe(false); expect(f.bridge.snapshot().error).toBeNull();
    const next = Promise.withResolvers<WireRequest>(); peer.once("data", chunk => next.resolve(requestSchema.parse(JSON.parse(chunk.toString().trim()))));
    const barrier = f.bridge.neutralize(owner), nextRequest = await next.promise;
    expect(nextRequest.generation).toBe(3);
    // Owner A is already retired: this receipt must not revoke B or advance the clock.
    reply(peer, nextRequest.id, { neutralized: true, matched_owner: false, generation: 3, session_id: f.session.session_id, life_id: 1 });
    await barrier; expect(f.child.killed).toBe(false); expect(f.bridge.snapshot().status).toBe("connected");
  } finally { await f.close(); }
}, 10000);
test("alive connection waits for the loading screen to close before publishing readiness", async () => {
  const f = fixture(), methods: string[] = [], loading = { screen_id: "loading", incarnation: 1, revision: 1 };
  const seenLoading = Promise.withResolvers<void>();
  let screen: typeof loading | null = loading;
  Reflect.set(f.bridge, "owned", null);
  Reflect.set(Reflect.get(f.bridge, "launcher"), "launch", async (_config: unknown, controlPort: number) => {
    const peer = createConnection({ host: "127.0.0.1", port: controlPort }); f.peers.push(peer); peer.on("error", () => {});
    peer.once("connect", () => peer.write(JSON.stringify(hello(f.session)) + "\n"));
    requests(peer, request => {
      methods.push(request.method); if (request.method !== "observe") return;
      const observation = minecraftObservationFixture(adapter, { world_id: f.session.world_id, session_id: f.session.session_id,
        epoch: f.session.epoch });
      observation.screen = screen;
      reply(peer, request.id, observation);
    });
    return f.owned;
  });
  f.bridge.subscribe(notice => {
    if (notice.type === "observation" && f.bridge.snapshot().screen?.screen_id === loading.screen_id) seenLoading.resolve();
  });
  try {
    const connecting = f.bridge.connect({ host: "127.0.0.1", port: 25565, version: "1.21.4", world_id: f.session.world_id, epoch: f.session.epoch });
    await seenLoading.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.bridge.snapshot().status).toBe("connecting");
    screen = null;
    await connecting;
    expect(f.bridge.snapshot().status).toBe("connected");
    expect((await f.bridge.observe()).screen).toBeNull();
    expect(methods.every(method => method === "observe")).toBe(true);
  } finally { await f.close(); }
}, 10000);
test("saved-dead connection negotiates the real declared profile without execute or automatic respawn", async () => {
  const selected = minecraftTestAdapter("fast"), f = fixture(selected, true), methods: string[] = [];
  // Loading seam only: substitute launcher beneath actual connect/hello/observe.
  Reflect.set(f.bridge, "owned", null);
  Reflect.set(Reflect.get(f.bridge, "launcher"), "launch", async (_config: unknown, controlPort: number) => {
    const peer = createConnection({ host: "127.0.0.1", port: controlPort }); f.peers.push(peer); peer.on("error", () => {});
    peer.once("connect", () => peer.write(JSON.stringify(hello(f.session, selected)) + "\n"));
    requests(peer, request => {
      methods.push(request.method); if (request.method !== "observe") return;
      const observation = minecraftObservationFixture(selected, { world_id: f.session.world_id, session_id: f.session.session_id,
        epoch: f.session.epoch, life: { life_id: 1, status: "dead", can_respawn: false, death: null } }); observation.data.player.health = 0;
      reply(peer, request.id, observation);
    });
    return f.owned;
  });
  try {
    await f.bridge.connect({ host: "127.0.0.1", port: 25565, version: "1.21.4", world_id: f.session.world_id, epoch: f.session.epoch, motor_profile: "fast" });
    expect(f.bridge.snapshot().status).toBe("connected"); expect(f.bridge.snapshot().life?.status).toBe("dead");
    expect(f.bridge.snapshot().binding?.descriptor.observation.profile.configuration).toEqual(minecraftProfileConfiguration("fast")); expect(methods).toEqual(["observe"]);
    const ready = Promise.withResolvers<void>(); f.bridge.subscribe(notice => { if (notice.type === "state" && f.bridge.snapshot().life?.can_respawn) ready.resolve(); });
    f.peers[0]!.write(JSON.stringify({ notice: f.notice({ life_id: 1, status: "dead", can_respawn: true, death: null }, 1) }) + "\n"); await ready.promise;
    expect(f.bridge.snapshot().life?.can_respawn).toBe(true); expect(methods).toEqual(["observe"]); expect(f.child.killed).toBe(false);
  } finally { await f.close(); }
}, 10000);
