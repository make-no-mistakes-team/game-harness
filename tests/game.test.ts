import { expect, jest, test } from "bun:test";
import { EventEmitter } from "node:events";
import { TrustedGame } from "../src/bridge/game.ts";
import { Perception, vec } from "../src/bridge/perception.ts";
import type { BridgeBot } from "../src/bridge/types.ts";
import type { BridgeConnection } from "../src/shared/contracts.ts";

const config: BridgeConnection = {
  host: "127.0.0.1",
  port: 25565,
  username: "Fixture",
  version: "1.21.4",
  world_id: "private-unit-fixture",
  epoch: 1,
  viewer_token: "x".repeat(32),
  operator_origins: ["http://127.0.0.1:3000"],
};
// Capture the real event-loop boundary before any test enables fake timers.
const realSetImmediate = setImmediate;
function deadlineTest(name: string, work: () => Promise<void>) {
  test(name, async () => {
    jest.useFakeTimers();
    try {
      await work();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
}

function fixture(existing?: TrustedGame, generation = 0) {
  const controls = new Map<string, boolean>();
  const packets: { name: string; packet: Record<string, unknown> }[] = [];
  const wire: {
    onWrite?: (name: string, packet: Record<string, unknown>) => void;
  } = {};
  const client = Object.assign(new EventEmitter(), {
    socket: {
      writable: true,
      destroyed: false,
      destroy() {
        this.destroyed = true;
        this.writable = false;
      },
    },
    serializer: { writable: true },
    end: () => {},
    write(name: string, packet: Record<string, unknown>) {
      packets.push({ name, packet });
      wire.onWrite?.(name, packet);
    },
  });
  const bot = Object.assign(new EventEmitter(), {
    entity: {
      position: vec({ x: 0.5, y: 0, z: 0.5 }),
      eyeHeight: 1.62,
      metadata: {},
      type: "player",
      yaw: 0,
      pitch: 0,
    },
    entities: {},
    jumpQueued: false,
    targetDigBlock: null as null | { position: ReturnType<typeof vec> },
    usingHeldItem: false,
    getControlState: (name: string) => controls.get(name) ?? false,
    setControlState: (name: string, value: boolean) => {
      controls.set(name, value);
    },
    clearControlStates: () => controls.clear(),
    stopDigging: () => {},
    deactivateItem: () => {},
    look: async (yaw: number, pitch: number) => {
      bot.entity.yaw = yaw;
      bot.entity.pitch = pitch;
    },
    _client: client,
    registry: { blocksByStateId: { 0: { name: "air" }, 1: { name: "stone" } } },
    blockAt: () => ({ stateId: 1 }),
  });
  const perception = new Perception(
    bot as unknown as BridgeBot,
    config,
    () => [],
    () => {},
    () => {},
  );
  const game = existing ?? new TrustedGame(() => {});
  Object.assign(game, {
    bot,
    perception,
    generation,
    inputSequence: 0,
    acknowledgedSequence: 0,
    state: { ...game.snapshot(), status: "connected" },
  });
  Reflect.get(game, "trackInputs").call(game, bot, generation);
  return { game, bot, perception, packets, wire };
}

test("cancel drains an in-flight bounded look before ownership transfers without reconnecting", async () => {
  const { game, bot } = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  bot.look = async (yaw, pitch) => {
    entered.resolve();
    await release.promise;
    bot.entity.yaw = yaw;
    bot.entity.pitch = pitch;
  };
  const action = game.execute({
    kind: "move",
    controls: { forward: true },
    duration_ms: 2000,
    look: { yaw: 1, pitch: 0 },
  });
  await entered.promise;
  let acknowledged = false;
  const cancellation = game.cancel("trial ended").then(() => {
    acknowledged = true;
  });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  expect(bot.getControlState("forward")).toBe(false);
  expect((await game.execute({ kind: "look", yaw: 2, pitch: 0 })).status).toBe(
    "failed",
  );
  release.resolve();
  const outcome = await action;
  await cancellation;
  expect(outcome.status).toBe("cancelled");
  expect(outcome.requires_reconnect).toBeUndefined();
  expect(game.snapshot().status).toBe("connected");
  bot.look = async (yaw, pitch) => {
    bot.entity.yaw = yaw;
    bot.entity.pitch = pitch;
  };
  expect((await game.execute({ kind: "look", yaw: 2, pitch: 0 })).status).toBe(
    "succeeded",
  );
});

function retainedBlock(perception: Perception) {
  const record = {
    kind: "block",
    value: {
      id: "known",
      name: "stone",
      position: { x: 0, y: 1, z: -2 },
      observed_at: new Date().toISOString(),
      current: true,
    },
    state_id: 1,
    eye: perception.eye(),
    revision: 0,
    seen: Date.now(),
    dependencies: new Map([["0,1,-1", 0]]),
  };
  Object.assign(perception, { records: new Map([["known", record]]) });
  return record;
}

test("retained dig proof survives sampling age, but never refreshes observable freshness", () => {
  const { perception } = fixture();
  const record = retainedBlock(perception);
  const valid = perception.retainBlockProof("known");
  expect(valid).not.toBeNull();
  record.seen -= 2000;
  expect(perception.target("known", true)).toBeNull();
  expect(valid!()).toBe(true);
});

test("retained dig proof ignores unrelated chunk arrivals without refreshing observations", () => {
  const { perception, bot } = fixture();
  retainedBlock(perception);
  const valid = perception.retainBlockProof("known")!;
  for (const position of [
    { x: 80, y: 0, z: 48 },
    { x: -80, y: 0, z: 48 },
    { x: 112, y: 0, z: 80 },
  ])
    bot.emit("chunkColumnLoad", vec(position));
  bot.emit("chunkColumnUnload", vec({ x: 80, y: 0, z: 48 }));
  expect(perception.target("known", true)).toBeNull();
  expect(valid()).toBe(true);
});

test("retained dig proof fails closed when bounded chunk revision history is discarded", () => {
  const { perception, bot } = fixture();
  retainedBlock(perception);
  const valid = perception.retainBlockProof("known")!;
  for (let i = 0; i <= 4096; i++)
    bot.emit("chunkColumnLoad", vec({ x: 160 + 16 * i, y: 0, z: 0 }));
  expect(valid()).toBe(false);
});

test("retained dig proof fails closed on changed geometry, eye, relevant chunks or world reset", () => {
  for (const change of [
    "geometry",
    "eye",
    "chunk",
    "replace",
    "reload",
    "reset",
  ] as const) {
    const { perception, bot } = fixture();
    retainedBlock(perception);
    const valid = perception.retainBlockProof("known")!;
    if (change === "geometry")
      bot.emit("blockUpdate", null, { position: vec({ x: 0, y: 1, z: -1 }) });
    else if (change === "eye") bot.entity.position.x += 0.1;
    else if (change === "chunk")
      bot.emit("chunkColumnUnload", vec({ x: 0, y: 0, z: 0 }));
    else if (change === "replace")
      bot.emit("chunkColumnLoad", vec({ x: 0, y: 0, z: -16 }));
    else if (change === "reload") {
      bot.emit("chunkColumnUnload", vec({ x: 0, y: 0, z: -16 }));
      bot.emit("chunkColumnLoad", vec({ x: 0, y: 0, z: -16 }));
    } else bot.emit("blockUpdate", null, null);
    expect(valid()).toBe(false);
  }
});

function digFixture(existing?: TrustedGame, generation = 0) {
  const context = fixture(existing, generation);
  const { bot, perception } = context;
  const record = retainedBlock(perception);
  const position = vec(record.value.position);
  const looking = Promise.withResolvers<void>();
  const look = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const task = Promise.withResolvers<void>();
  let delayLook = false,
    delaySettlement = false,
    stopThrows = false;
  Object.assign(bot, {
    blockAt: () => ({ stateId: 1, position }),
    canDigBlock: () => true,
    digTime: () => 3000,
    dig: async () => {
      looking.resolve();
      if (delayLook) await look.promise;
      bot._client.write("block_dig", {
        status: 0,
        location: position,
        face: 1,
      });
      bot.targetDigBlock = { position };
      bot.stopDigging = () => {
        if (!bot.targetDigBlock) return;
        if (stopThrows) throw new Error("SDK cleanup failed");
        bot._client.write("block_dig", {
          status: 1,
          location: position,
          face: 1,
        });
        bot.targetDigBlock = null;
        stopped.resolve();
        if (!delaySettlement) task.reject(new Error("Digging aborted"));
      };
      started.resolve();
      await task.promise;
    },
  });
  const ack = (sequenceId: unknown) =>
    bot._client.emit("acknowledge_player_digging", { sequenceId });
  const automaticAck = () => {
    context.wire.onWrite = (name, packet) => {
      if (name === "block_dig" && packet.status === 1) ack(packet.sequence);
    };
  };
  const serverAir = () =>
    bot._client.emit("block_change", { location: position, type: 0 });
  const finish = () => {
    bot._client.write("block_dig", { status: 2, location: position, face: 1 });
    bot.targetDigBlock = null;
    task.resolve();
  };
  return {
    ...context,
    record,
    position,
    looking,
    look,
    started,
    stopped,
    task,
    ack,
    automaticAck,
    serverAir,
    finish,
    delayLook: () => {
      delayLook = true;
    },
    delaySettlement: () => {
      delaySettlement = true;
    },
    failStop: () => {
      stopThrows = true;
    },
    execute: () => context.game.execute({ kind: "dig", target_id: "known" }),
  };
}

test("pre-FINISH cancellation drains the SDK and ACK without claiming rollback or effect credit", async () => {
  const f = digFixture();
  f.delaySettlement();
  f.automaticAck();
  const pending = f.execute();
  await f.started.promise;
  const cancellation = f.game.cancel("new model proposal");
  await f.stopped.promise;
  expect(
    (await f.game.execute({ kind: "look", yaw: 2, pitch: 0 })).status,
  ).toBe("failed");
  f.task.reject(new Error("Digging aborted"));
  await cancellation;
  const outcome = await pending;
  expect(outcome.status).toBe("cancelled");
  expect(outcome.requires_reconnect).toBeUndefined();
  expect(outcome.evidence).toMatchObject({
    cancellation_confirmed: true,
    prior_effects: "unverified",
    effect_confirmed: false,
    neutralized_effect: false,
    sdk_settled: true,
    local_channels_neutral: true,
    dig_started: true,
    dig_finish_submitted: false,
    abort_acknowledged: true,
  });
  expect(f.game.snapshot().status).toBe("connected");
  expect(
    (await f.game.execute({ kind: "look", yaw: 2, pitch: 0 })).status,
  ).toBe("succeeded");
  expect(
    f.packets.filter(
      ({ name, packet }) => name === "block_dig" && packet.status === 0,
    ),
  ).toHaveLength(1);
});

test("initial-look cancellation retains ownership until the real task drains and prevents late START", async () => {
  const f = digFixture();
  f.delayLook();
  const pending = f.execute();
  await f.looking.promise;
  const cancellation = f.game.cancel("cancel while looking");
  expect(
    (await f.game.execute({ kind: "look", yaw: 2, pitch: 0 })).status,
  ).toBe("failed");
  f.look.resolve();
  await cancellation;
  expect((await pending).evidence).toMatchObject({
    cancellation_confirmed: true,
    dig_started: false,
    sdk_settled: true,
    prior_effects: "unverified",
    effect_confirmed: false,
    neutralized_effect: false,
  });
  expect(
    f.packets.some(
      ({ name, packet }) => name === "block_dig" && packet.status === 0,
    ),
  ).toBe(false);
  expect(f.game.snapshot().status).toBe("connected");
});

test("cancellation reentered during START waits for SDK stop installation before confirming", async () => {
  const f = digFixture();
  let cancellation: Promise<void> | undefined;
  f.wire.onWrite = (name, packet) => {
    if (name !== "block_dig") return;
    if (packet.status === 0) cancellation = f.game.cancel("START boundary");
    if (packet.status === 1) f.ack(packet.sequence);
  };
  const pending = f.execute();
  await f.started.promise;
  const outcome = await pending;
  await cancellation;
  expect(outcome.status).toBe("cancelled");
  expect(outcome.evidence).toMatchObject({
    abort_acknowledged: true,
    sdk_settled: true,
  });
});

test("cumulative ACKs use a unique shared namespace across item use, placement, digging, and release", async () => {
  const f = digFixture();
  const pending = f.execute();
  await f.started.promise;
  f.bot._client.write("use_item", { hand: 0, sequence: 1 });
  f.bot._client.write("block_place", { location: f.position, sequence: 0 });
  const cancellation = f.game.cancel("coalesced acknowledgement");
  await f.stopped.promise;
  f.bot._client.write("block_dig", {
    status: 5,
    location: f.position,
    sequence: 0,
  });
  const interactions = f.packets.filter(({ name }) =>
    ["block_dig", "block_place", "use_item"].includes(name),
  );
  expect(interactions.map(({ packet }) => packet.sequence)).toEqual([
    1, 2, 3, 4, 5,
  ]);
  f.ack(5);
  await cancellation;
  expect((await pending).status).toBe("cancelled");
});

test("an old connection ACK cannot confirm a new connection's identically numbered ABORT", async () => {
  const old = digFixture();
  old.automaticAck();
  const previous = old.execute();
  await old.started.promise;
  await old.game.cancel("first connection cancellation");
  expect((await previous).status).toBe("cancelled");
  old.perception.close();
  const current = digFixture(old.game, 1);
  const pending = current.execute();
  await current.started.promise;
  const cancellation = current.game.cancel("new connection cancellation");
  await current.stopped.promise;
  const abort = current.packets.find(({ packet }) => packet.status === 1)!;
  old.ack(abort.packet.sequence);
  // Cross an event-loop turn, not an elapsed-time sleep: SDK continuations have
  // drained, but the new connection has still received no valid ACK.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(
    (await current.game.execute({ kind: "look", yaw: 2, pitch: 0 })).status,
  ).toBe("failed");
  current.ack(abort.packet.sequence);
  await cancellation;
  expect((await pending).status).toBe("cancelled");
});

test("a START-time server removal wins cancellation only with actual inbound block evidence", async () => {
  const f = digFixture();
  const pending = f.execute();
  await f.started.promise;
  f.serverAir();
  f.bot.targetDigBlock = null;
  f.task.resolve();
  await f.game.cancel("completion race");
  const outcome = await pending;
  expect(outcome.status).toBe("succeeded");
  expect(outcome.evidence).toMatchObject({
    effect_confirmed: true,
    source: "server_block_update",
  });
});

test("delayed dig completion keeps the admitted relevant-chunk proof and server-confirmed success", async () => {
  const f = digFixture();
  const pending = f.execute();
  await f.started.promise;
  f.record.seen -= 2000;
  f.bot.emit("chunkColumnLoad", vec({ x: 112, y: 0, z: 80 }));
  f.finish();
  f.serverAir();
  const outcome = await pending;
  expect(outcome.status).toBe("succeeded");
  expect(outcome.evidence).toMatchObject({
    effect_confirmed: true,
    source: "server_block_update",
  });
});

test("invalidated FINISH is suppressed without throwing from the SDK timer boundary", async () => {
  const f = digFixture();
  const pending = f.execute();
  await f.started.promise;
  f.bot.emit("blockUpdate", null, { position: vec({ x: 0, y: 1, z: -1 }) });
  expect(() => f.finish()).not.toThrow();
  const outcome = await pending;
  expect(outcome.status).toBe("unknown");
  expect(outcome.requires_reconnect).toBe(true);
  expect(
    f.packets.some(
      ({ name, packet }) => name === "block_dig" && packet.status === 2,
    ),
  ).toBe(false);
});

deadlineTest(
  "local completion and cancellation after FINISH never manufacture a removal proof",
  async () => {
    const f = digFixture();
    const pending = f.execute();
    await f.started.promise;
    f.finish();
    const cancellation = f.game.cancel("FINISH already sent");
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    jest.advanceTimersToNextTimer();
    await cancellation;
    const outcome = await pending;
    expect(outcome.status).toBe("unknown");
    expect(outcome.requires_reconnect).toBe(true);
    expect(outcome.evidence).toMatchObject({
      effect_confirmed: false,
      cancellation_confirmed: false,
      dig_finish_submitted: true,
    });
    expect(f.game.snapshot().status).toBe("disconnected");
  },
);

test("FINISH completion may win cancellation when raw server removal is confirmed", async () => {
  const f = digFixture();
  const pending = f.execute();
  await f.started.promise;
  f.finish();
  const cancellation = f.game.cancel("completion race");
  f.serverAir();
  await cancellation;
  expect((await pending).status).toBe("succeeded");
  expect(f.game.snapshot().status).toBe("connected");
});

deadlineTest(
  "uncancelled local FINISH without server removal remains unknown",
  async () => {
    const f = digFixture();
    const pending = f.execute();
    await f.started.promise;
    f.finish();
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    jest.advanceTimersToNextTimer();
    const outcome = await pending;
    expect(outcome.status).toBe("unknown");
    expect(outcome.requires_reconnect).toBe(true);
    expect(outcome.evidence).toMatchObject({ effect_confirmed: false });
  },
);

deadlineTest(
  "missing, malformed, stale, or impossible future ACK cannot confirm cancellation",
  async () => {
    for (const ack of ["missing", "malformed", "stale", "future"] as const) {
      const f = digFixture();
      const pending = f.execute();
      await f.started.promise;
      const cancellation = f.game.cancel("no valid ACK");
      await f.stopped.promise;
      if (ack === "malformed") f.ack("2");
      else if (ack === "stale") f.ack(1);
      else if (ack === "future") f.ack(999);
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      jest.advanceTimersToNextTimer();
      await cancellation;
      const outcome = await pending;
      expect(outcome.status).toBe("unknown");
      expect(outcome.requires_reconnect).toBe(true);
      expect(outcome.evidence).toMatchObject({
        cancellation_confirmed: false,
        effect_confirmed: false,
      });
      const abort = f.packets.find(({ packet }) => packet.status === 1)!;
      f.ack(abort.packet.sequence);
      expect(f.game.snapshot().status).toBe("disconnected");
    }
  },
);

deadlineTest(
  "ACK without real SDK settlement stays fenced and rejects the abandoned continuation",
  async () => {
    const f = digFixture();
    f.delaySettlement();
    f.automaticAck();
    const pending = f.execute();
    await f.started.promise;
    const cancellation = f.game.cancel("SDK will not settle");
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    jest.advanceTimersToNextTimer();
    await cancellation;
    const outcome = await pending;
    expect(outcome.status).toBe("unknown");
    expect(outcome.requires_reconnect).toBe(true);
    expect(outcome.evidence).toMatchObject({
      sdk_settled: false,
      cancellation_confirmed: false,
    });
    expect(() =>
      f.bot._client.write("block_dig", { status: 0, location: f.position }),
    ).toThrow();
    f.task.reject(new Error("late SDK settlement"));
  },
);

deadlineTest(
  "an uncooperative initial look fences instead of releasing its late START",
  async () => {
    const f = digFixture();
    f.delayLook();
    const pending = f.execute();
    await f.looking.promise;
    const cancellation = f.game.cancel("initial look never drains");
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    jest.advanceTimersToNextTimer();
    await cancellation;
    expect((await pending).evidence).toMatchObject({
      cancellation_confirmed: false,
      dig_started: false,
      sdk_settled: false,
    });
    expect(f.game.snapshot().status).toBe("disconnected");
    f.look.resolve();
    expect(
      (await f.game.execute({ kind: "look", yaw: 2, pitch: 0 })).status,
    ).toBe("failed");
  },
);

test("transport loss or cleanup failure cannot be promoted by an ABORT ACK", async () => {
  for (const failure of [
    "transport",
    "cleanup",
    "unwritable",
    "held",
  ] as const) {
    const f = digFixture();
    f.automaticAck();
    const pending = f.execute();
    await f.started.promise;
    if (failure === "transport") f.bot._client.socket.destroy();
    else if (failure === "unwritable")
      f.bot._client.serializer.writable = false;
    else if (failure === "held") {
      f.bot.setControlState("forward", true);
      f.bot.clearControlStates = () => {};
    } else f.failStop();
    await f.game.cancel("failed shutdown");
    const outcome = await pending;
    expect(outcome.status).toBe("unknown");
    expect(outcome.requires_reconnect).toBe(true);
    expect(outcome.evidence).toMatchObject({
      cancellation_confirmed: false,
      neutralized_effect: false,
    });
    f.task.reject(new Error("late SDK settlement"));
  }
});

test("transport loss after ACK but before SDK drain still fences ownership", async () => {
  const f = digFixture();
  f.delaySettlement();
  f.automaticAck();
  const pending = f.execute();
  await f.started.promise;
  const cancellation = f.game.cancel("transport lost after ACK");
  await f.stopped.promise;
  f.bot._client.socket.destroy();
  f.task.reject(new Error("Digging aborted"));
  await cancellation;
  const outcome = await pending;
  expect(outcome.status).toBe("unknown");
  expect(outcome.requires_reconnect).toBe(true);
  expect(outcome.evidence).toMatchObject({
    cancellation_confirmed: false,
    abort_acknowledged: true,
    neutralized_effect: false,
  });
});

test("irreversible non-dig SDK interactions remain conservative on cancellation", async () => {
  const f = digFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  Object.assign(f.bot, {
    activateBlock: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const pending = f.game.execute({ kind: "interact", target_id: "known" });
  await entered.promise;
  await f.game.cancel("irreversible interaction");
  const outcome = await pending;
  expect(outcome.status).toBe("unknown");
  expect(outcome.requires_reconnect).toBe(true);
  expect(f.game.snapshot().status).toBe("disconnected");
  release.resolve();
});
