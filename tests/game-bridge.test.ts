import { expect, test } from "bun:test";
import { GameBridgeClient } from "../src/server/game-bridge.ts";
import { ControllerScreenReadSupersededError, NativeRequestFault } from "../src/server/controller-channel.ts";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Server, type Socket } from "node:net";
import type {
  NativeProcess,
  NativeSession,
} from "../src/server/minecraft-client.ts";
import type {
  BridgeNotice,
  GameAction,
  GameActionResult,
  PlayerLife,
} from "../src/shared/contracts.ts";
import type { EffectEnvelope } from "../src/shared/control.ts";
import { minecraftProfileConfiguration } from "../src/shared/minecraft.ts";
import { nativeFrame } from "./helpers/native-frame.ts";
import {
  effectScope,
  minecraftObservationFixture,
  minecraftTestAdapter,
  minecraftTestBinding,
  sha256,
} from "./helpers/adapter-contract.ts";
import { z } from "zod";
import { effectEnvelopeSchema } from "../src/shared/control.ts";
import { gameActionSchema } from "../src/shared/validation.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import type {
  NativeControlTiming,
  NativeControllerApplicationTiming,
  NativeControllerLeaseTiming,
  NativeControllerOpportunityBatch,
} from "../src/server/performance.ts";

const adapter = minecraftTestAdapter();
function capturedFrame<T extends {
  inventory: { captured_native_ns: string };
  dynamic_entities: { native_tick: number; captured_native_ns: string };
}>(frame: T, frameSequence: number, tick: number) {
  const nanos = nativeFixtureNanos();
  return { ...frame, frame_seq: frameSequence, native_tick: tick, captured_native_ns: nanos,
    inventory: { ...frame.inventory, captured_native_ns: nanos },
    dynamic_entities: { ...frame.dynamic_entities, native_tick: tick, captured_native_ns: nanos } };
}
const ordinaryInput: GameAction = {
  kind: "world_input",
  steps: [
    {
      ticks: 1,
      held: {
        forward: false,
        back: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        sneak: false,
        attack: false,
        use: false,
      },
      edges: [],
      view: { kind: "unchanged" },
      selected_hotbar: null,
    },
  ],
};
function envelope(
  action: GameAction,
  session?: NativeSession,
  life = 1,
  space = 1,
  selected = adapter,
): EffectEnvelope<GameAction> {
  const scope = {
    ...effectScope(),
    ...(session
      ? {
          world_id: session.world_id,
          session_id: session.session_id,
          epoch: session.epoch,
        }
      : {}),
    native_boot_id: "fixture-native-boot",
    life_id: life,
    space_epoch: space,
    execution_id: "transport-diagnostic",
  };
  return {
    operation_id: randomUUID(),
    compatibility_hash: sha256(selected.descriptor),
    scope,
    invocation: {
      kind: "diagnostic",
      execution_id: scope.execution_id,
      source_hash: scope.source_hash,
    },
    action,
    expected_screen: { kind: "absent" },
  };
}
function hello(session: NativeSession, selected = adapter) {
  return {
    protocol: 4,
    secret: session.secret,
    session_id: session.session_id,
    world_id: session.world_id,
    epoch: session.epoch,
    native_boot_id: "fixture-native-boot",
    descriptor: selected.descriptor,
  };
}
function fixture(selected = adapter, dead = false) {
  const bridge = new GameBridgeClient(process.cwd(), {
    descriptor: selected.descriptor,
    schemas: selected.schemas,
    adapter: selected,
  });
  // Real owned OS-process closure is under test; a fake clock cannot terminate
  // this child or acknowledge its actual socket/process exit.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {},1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = Promise.withResolvers<void>();
  child.once("close", () => closed.resolve());
  const session: NativeSession = {
    secret: randomBytes(32).toString("hex"),
    session_id: randomUUID(),
    world_id: randomUUID(),
    epoch: 2 ** 31 + 7,
    host: "127.0.0.1",
    port: 25565,
    control_port: 0,
    video_port: 0,
    evaluation: null,
  };
  const owned: NativeProcess = {
    child,
    closed: closed.promise,
    session,
    username: "fixture",
    diagnostics: [],
  };
  let life: PlayerLife = {
    life_id: 1,
    status: dead ? "dead" : "alive",
    can_respawn: false,
    death: null,
  };
  Reflect.set(bridge, "owned", owned);
  Reflect.set(bridge, "state", {
    ...bridge.snapshot(),
    status: "connected",
    world_id: session.world_id,
    epoch: session.epoch,
    session_id: session.session_id,
    life,
    binding: minecraftTestBinding(selected),
    space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
  });
  const peers: Socket[] = [];
  async function channel(kind: "control" | "video", frame?: Uint8Array) {
    const port: number = await Reflect.get(bridge, "listener").call(
      bridge,
      kind,
    );
    const server = (Reflect.get(bridge, "servers") as Server[]).at(-1)!;
    const received = Promise.withResolvers<void>();
    server.once("connection", (socket) =>
      socket.once("data", () => received.resolve()),
    );
    const peer = createConnection({ host: "127.0.0.1", port });
    peers.push(peer);
    peer.on("error", () => {});
    await new Promise<void>((resolve) => peer.once("connect", resolve));
    peer.write(
      Buffer.concat([
        Buffer.from(JSON.stringify(hello(session, selected)) + "\n"),
        Buffer.from(frame ?? []),
      ]),
    );
    await received.promise;
    return peer;
  }
  function notice(next: PlayerLife, generation: number, spaceEpoch = 1) {
    life = next;
    return {
      type: "life",
      world_id: session.world_id,
      epoch: session.epoch,
      session_id: session.session_id,
      native_boot_id: "fixture-native-boot",
      generation,
      life,
      neutralized: true,
      space: { dimension_id: "minecraft:overworld", space_epoch: spaceEpoch },
      screen: null,
    };
  }
  async function close() {
    for (const peer of peers) peer.destroy();
    await bridge.close();
    child.kill("SIGKILL");
    await closed.promise;
  }
  return {
    bridge,
    child,
    closed: closed.promise,
    session,
    owned,
    peers,
    channel,
    notice,
    close,
  };
}
function reply(peer: Socket, id: number, data: unknown) {
  peer.write(JSON.stringify({ id, ok: true, data }) + "\n");
}
function nativeFixtureNanos() {
  return String(1_000_000_000n + BigInt(Math.floor(performance.now() * 1e6)));
}
function timedReply(
  peer: Socket,
  id: number,
  data: unknown,
  opportunities?: NativeControlTiming["controller_opportunities"],
) {
  const ns = nativeFixtureNanos();
  peer.write(
    JSON.stringify({
      id,
      ok: true,
      data,
      timing: {
        schema_version: 1,
        clock_id: "fixture-native-boot",
        received_ns: ns,
        replied_ns: ns,
        client_tick: 10,
        ...(opportunities ? { controller_opportunities: opportunities } : {}),
      },
    }) + "\n",
  );
}
function opportunityBatch(): NativeControllerOpportunityBatch {
  return {
    schema_version: 1,
    identity: {
      owner_operation_id: "opportunity-owner",
      controller_generation: "1",
      native_boot_id: "fixture-native-boot",
      source_hash: "a".repeat(64),
    },
    counts: {
      attempted: "1",
      accepted: "1",
      omitted: "0",
      contended: "0",
      exhausted: "0",
      closed_omitted: "0",
      drained: "0",
      retained: 1,
      sealed: false,
    },
    final_batch: false,
    unattached_retained: 0,
    counts_consistent: true,
    complete: false,
    events: [
      {
        kind: "begin",
        outcome: "empty",
        eventseq: "1",
        native_ns: "-9223372036854775808",
        checked_native_ns: "-9007199254740993",
        tick: "10",
        preparation_ordinal: "1",
        request_id: null,
        sequence: null,
        frame_sequence: null,
        captured_native_ns: null,
        pending_count: "0",
        head_request_id: null,
        head_sequence: null,
        head_frame_sequence: null,
        predecessor_request_id: null,
        predecessor_sequence: null,
        predecessor_frame_sequence: null,
        applying_request_id: null,
        applying_sequence: null,
        applying_frame_sequence: null,
        last_completed_request_id: null,
        last_completed_sequence: null,
        last_completed_frame_sequence: null,
        last_completed_tick: null,
        last_applied_native_ns: null,
        applied_native_ns: null,
        diagnostic_completion_native_ns: null,
        evaluated_mask: "7",
        value_mask: "0",
        last_sampled_tick: null,
        state_mask: null,
        stage: "0",
      },
    ],
  };
}
const requestSchema = z.object({
  id: z.number().int().positive(),
  method: z.string(),
  generation: z.number().int(),
  params: z.record(z.string(), jsonSchema),
});
type WireRequest = z.infer<typeof requestSchema>;
const effectRequestSchema = effectEnvelopeSchema(gameActionSchema);
function requests(peer: Socket, receive: (request: WireRequest) => void) {
  let input = "";
  peer.on("data", (chunk) => {
    input += chunk.toString();
    let end: number;
    while ((end = input.indexOf("\n")) >= 0) {
      const request = requestSchema.parse(JSON.parse(input.slice(0, end)));
      input = input.slice(end + 1);
      receive(request);
    }
  });
}
function effectReply(request: WireRequest, result: GameActionResult) {
  const effect = effectRequestSchema.parse(request.params);
  return {
    operation_id: effect.operation_id,
    compatibility_hash: effect.compatibility_hash,
    scope: effect.scope,
    result,
  };
}

test("an unstarted native bridge closes idempotently without inventing video", async () => {
  const bridge = new GameBridgeClient();
  await bridge.close();
  await bridge.close();
  expect(bridge.snapshot().status).toBe("disconnected");
  expect(bridge.snapshot().video.status).toBe("idle");
  expect(bridge.latestFrame()).toBeNull();
});
for (const fence of [
  "binding",
  "world_id",
  "epoch",
  "session_id",
  "life_id_regressed",
  "life_status_regressed",
  "space_epoch_regressed",
  "screen_identity",
  "life_before_space_and_screen",
] as const) {
  test(`observation rejection attributes ${fence} without rereading or accepting stale scope`, async () => {
    const f = fixture();
    try {
      const peer = await f.channel("control"),
        notices: BridgeNotice[] = [],
        methods: string[] = [],
        spans: Array<{
          request_id: number;
          started_monotonic_ms: number;
          ended_monotonic_ms: number;
        }> = [];
      f.bridge.subscribe((notice) => notices.push(notice));
      f.bridge.subscribeControlTiming((span) => {
        if (span.method === "observe") spans.push(span);
      });
      const capturedAt = "2026-11-06T12:00:00.000Z";
      let stale = false,
        nativeRequests = 0,
        responseHostTime = 0;
      const changedLife = {
        life_id:
          fence === "life_id_regressed" ||
          fence === "life_before_space_and_screen"
            ? 2
            : 1,
        status:
          fence === "life_status_regressed"
            ? ("dead" as const)
            : ("alive" as const),
        can_respawn: false,
        death: null,
      };
      const notice = {
        ...f.notice(
          changedLife,
          2,
          fence === "space_epoch_regressed" ||
            fence === "life_before_space_and_screen"
            ? 2
            : 1,
        ),
        type: "scope",
        screen:
          fence === "screen_identity" || fence === "life_before_space_and_screen"
            ? { screen_id: "private-screen", incarnation: 2, revision: 1 }
            : null,
      };
      const hasNotice =
        fence === "life_id_regressed" ||
        fence === "life_status_regressed" ||
        fence === "space_epoch_regressed" ||
        fence === "screen_identity" ||
        fence === "life_before_space_and_screen";
      requests(peer, (request) => {
        methods.push(request.method);
        if (request.method !== "observe") return;
        const data = minecraftObservationFixture(adapter, {
          world_id: f.session.world_id,
          session_id: f.session.session_id,
          epoch: f.session.epoch,
          observation_seq: ++nativeRequests,
          captured_at: capturedAt,
        });
        if (!stale) {
          reply(peer, request.id, data);
          return;
        }
        if (fence === "binding") data.native_boot_id = "obsolete-native-boot";
        if (fence === "world_id") data.world_id = "obsolete-world";
        if (fence === "epoch") data.epoch--;
        if (fence === "session_id") data.session_id = "obsolete-session";
        responseHostTime = performance.now();
        // Drive the real response/notice parser in one callback so the notice
        // advances authority before the awaiting observation can resume.
        const control = Reflect.get(f.bridge, "control") as Socket;
        control.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: request.id, ok: true, data })}\n${hasNotice ? `${JSON.stringify({ notice })}\n` : ""}`,
          ),
        );
      });
      await f.bridge.observe();
      expect(notices.filter((notice) => notice.type === "game_event")).toEqual([]);
      const accepted = f.bridge.snapshot();
      stale = true;
      await expect(f.bridge.observe()).rejects.toThrow(
        fence === "binding"
          ? "Observation does not belong to the negotiated native/profile binding"
          : "Native observation has stale authority.",
      );
      const events = notices
        .filter((notice) => notice.type === "game_event")
        .map((notice) => notice.data);
      const span = spans[1]!;
      expect(events).toHaveLength(hasNotice ? 2 : 1);
      expect(events.at(-1)).toEqual({
        type: "observation_authority_rejected",
        schema_version: 1,
        first_failed_fence:
          fence === "life_before_space_and_screen" ? "life_id_regressed" : fence,
        request_id: span.request_id,
        requested_host_monotonic_ms: span.started_monotonic_ms,
        responded_host_monotonic_ms: span.ended_monotonic_ms,
        observation_seq: 2,
        observation_captured_at: capturedAt,
        scope_notice_generation: hasNotice ? 2 : null,
      });
      expect(span.started_monotonic_ms).toBeLessThanOrEqual(responseHostTime);
      expect(span.ended_monotonic_ms).toBeGreaterThanOrEqual(responseHostTime);
      expect(JSON.stringify(events.at(-1)).length).toBeLessThan(768);
      expect(methods).toEqual(["observe", "observe"]);
      expect(
        notices.filter((notice) => notice.type === "observation"),
      ).toHaveLength(1);
      expect(f.bridge.snapshot()).toMatchObject({
        life: notice.life,
        space: notice.space,
        screen: notice.screen,
        last_observation_at: accepted.last_observation_at,
        presentation: accepted.presentation,
      });
      expect(f.child.killed).toBe(false);
    } finally {
      await f.close();
    }
  });
}
test("successful observation reads emit no host rejection diagnostics", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control"),
      notices: BridgeNotice[] = [],
      methods: string[] = [];
    f.bridge.subscribe((notice) => notices.push(notice));
    let sequence = 0;
    requests(peer, (request) => {
      methods.push(request.method);
      reply(
        peer,
        request.id,
        minecraftObservationFixture(adapter, {
          world_id: f.session.world_id,
          session_id: f.session.session_id,
          epoch: f.session.epoch,
          observation_seq: ++sequence,
        }),
      );
    });
    for (let index = 1; index <= 3; index++)
      expect((await f.bridge.observe()).observation_seq).toBe(index);
    expect(methods).toEqual(["observe", "observe", "observe"]);
    expect(notices.map((notice) => notice.type)).toEqual([
      "observation",
      "observation",
      "observation",
    ]);
  } finally {
    await f.close();
  }
});
test("trusted timing subscribers receive correlated native lease deadlines even on a rejected heartbeat", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control");
    const samples: Array<
      ReturnType<
        GameBridgeClient["performanceMetrics"]
      >["control_timeline"]["samples"][number]
    > = [];
    const off = f.bridge.subscribeControlTiming((sample) =>
      samples.push(sample),
    );
    const owner = {
      operation_id: "lease-proof",
      generation: 3,
      scope: effectScope(),
    };
    const lease: NativeControllerLeaseTiming = {
      schema_version: 1,
      event: "refused",
      owner,
      controller_generation: 1,
      checked_native_ns: "-9007199254740993",
      requested_deadline_native_ns: "-9007199004740993",
      previous_deadline_native_ns: "-9007199254741000",
      effective_deadline_native_ns: "-9007199254741000",
      task_deadline_native_ns: "-9007198004740993",
      accepted: false,
      first_fence_reason: "native_input_lease_expired",
      first_fence_native_ns: "-9007199254740993",
      retirement_trigger: null,
      retirement_native_ns: null,
    };
    requests(peer, (request) =>
      peer.write(
        JSON.stringify({
          id: request.id,
          ok: false,
          error: "Controller request rejected: native_input_lease_expired",
          timing: {
            schema_version: 1,
            clock_id: "fixture-native-boot",
            received_ns: "-9007199254740994",
            replied_ns: "-9007199254740992",
            client_tick: 10,
            controller_lease: lease,
          },
        }) + "\n",
      ),
    );
    await expect(
      Reflect.get(f.bridge, "request").call(
        f.bridge,
        "controller_heartbeat",
        {},
        1000,
      ),
    ).rejects.toThrow("native_input_lease_expired");
    off();
    expect(f.bridge.snapshot().binding?.ready).toBe(true);
    expect(samples).toMatchObject([
      {
        method: "controller_heartbeat",
        status: "error",
        native_timing: { controller_lease: lease },
      },
    ]);
    const retained = f.bridge
      .performanceMetrics()
      .control_timeline.samples.at(-1)!;
    expect(retained.native_timing?.controller_lease).toEqual(lease);
    expect(
      BigInt(
        retained.native_timing!.controller_lease!.effective_deadline_native_ns,
      ) - BigInt(retained.native_timing!.controller_lease!.checked_native_ns),
    ).toBe(-7n);
  } finally {
    await f.close();
  }
});
test("early byte admission is known unsent and allocates no pending native request", async () => {
  const f = fixture();
  try {
    await f.channel("control");
    const request = Reflect.get(f.bridge, "request").bind(f.bridge);
    const outcome = await request("controller_submit", { payload: "x".repeat(65536) }, 1000).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(NativeRequestFault);
    expect(outcome).toMatchObject({ status: "not_dispatched", method: "controller_submit", requestId: null, dispatch: "not_dispatched" });
    expect((Reflect.get(f.bridge, "pending") as Map<number, unknown>).size).toBe(0);
    expect(f.child.killed).toBe(false);
    expect(f.bridge.snapshot().binding?.ready).toBe(true);
  } finally { await f.close(); }
});
test("an initiating request timeout survives emitter-closed fanout to an earlier heartbeat", async () => {
  const f = fixture();
  try {
    await f.channel("control");
    const request = Reflect.get(f.bridge, "request").bind(f.bridge);
    const heartbeat = request("controller_heartbeat", {}, 1000);
    const submission = request("controller_submit", {}, 20);
    const results = await Promise.allSettled([heartbeat, submission]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
    const first = (results[0] as PromiseRejectedResult).reason;
    const initiating = (results[1] as PromiseRejectedResult).reason;
    expect(first).toBeInstanceOf(NativeRequestFault);
    expect(initiating).toBeInstanceOf(NativeRequestFault);
    expect(first).toMatchObject({ status: "request_timeout", method: "controller_heartbeat", dispatch: "dispatched",
      initiatingRequestId: initiating.requestId, initiatingMethod: "controller_submit" });
    expect(initiating).toMatchObject({ status: "request_timeout", method: "controller_submit", dispatch: "dispatched",
      initiatingRequestId: initiating.requestId, initiatingMethod: "controller_submit" });
    expect(first.requestId).not.toBe(initiating.requestId);
  } finally { await f.close(); }
});
test("a successful native application retains exact queue and hook timing without expanding its receipt", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control");
    const application: NativeControllerApplicationTiming = {
      schema_version: 1,
      owner: {
        operation_id: "application-proof",
        generation: 3,
        scope: effectScope(),
      },
      controller_generation: 1,
      sequence: 9,
      frame_seq: 19,
      admitted_native_ns: "-9007199254740992",
      pending_ahead: 2,
      applying_ahead_sequence: 7,
      admitted_preparation_ordinal: 4,
      began_native_ns: "-9007199254740990",
      began_native_tick: 10,
      began_preparation_ordinal: 6,
      prepared_native_ns: "-9007199254740989",
      consumed_native_ns: null,
      sampled_native_ns: null,
      settled_native_ns: "-9007199254740985",
      settled_native_tick: 11,
    };
    requests(peer, (request) =>
      peer.write(
        JSON.stringify({
          id: request.id,
          ok: true,
          data: { original_receipt: true },
          timing: {
            schema_version: 1,
            clock_id: "fixture-native-boot",
            received_ns: "-9007199254740993",
            replied_ns: "-9007199254740984",
            client_tick: 12,
            controller_application: application,
          },
        }) + "\n",
      ),
    );
    const result = await Reflect.get(f.bridge, "request").call(
      f.bridge,
      "controller_submit",
      {},
      1000,
    );
    expect(result).toEqual({ original_receipt: true });
    const retained = f.bridge
      .performanceMetrics()
      .control_timeline.samples.at(-1)!;
    expect(retained.native_timing?.controller_application).toEqual(application);
    expect(
      BigInt(retained.native_timing!.controller_application!.began_native_ns) -
        BigInt(
          retained.native_timing!.controller_application!.admitted_native_ns,
        ),
    ).toBe(2n);
    expect(f.bridge.snapshot().binding?.ready).toBe(true);
  } finally {
    await f.close();
  }
});
test("empty native opportunities remain private exact facts, detached across socket observers and snapshots", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control"),
      batch = opportunityBatch();
    const seen: NativeControlTiming["controller_opportunities"][] = [];
    f.bridge.subscribeControlTiming((span) => {
      const value = span.native_timing?.controller_opportunities;
      if (!value || value.counts === null) return;
      value.identity.owner_operation_id = "observer-mutation";
      value.counts.accepted = "0";
      value.events[0]!.outcome = "admitted";
      value.events.length = 0;
    });
    f.bridge.subscribeControlTiming((span) =>
      seen.push(span.native_timing?.controller_opportunities),
    );
    requests(peer, (request) =>
      timedReply(peer, request.id, { original_receipt: true }, batch),
    );
    const result = await Reflect.get(f.bridge, "request").call(
      f.bridge,
      "ping",
      {},
      1000,
    );
    expect(result).toEqual({ original_receipt: true });
    expect(seen).toEqual([batch]);
    const retained = f.bridge
      .performanceMetrics()
      .control_timeline.samples.at(-1)!.native_timing!;
    expect(retained.controller_opportunities).toEqual(batch);
    expect(retained.controller_opportunities!.events[0]).toMatchObject({
      kind: "begin",
      outcome: "empty",
      request_id: null,
      sequence: null,
      frame_sequence: null,
      native_ns: "-9223372036854775808",
      pending_count: "0",
    });
    retained.controller_opportunities!.identity.source_hash = "b".repeat(64);
    retained.controller_opportunities!.events.pop();
    expect(
      f.bridge.performanceMetrics().control_timeline.samples.at(-1)!
        .native_timing?.controller_opportunities,
    ).toEqual(batch);
    expect(JSON.stringify(f.bridge.snapshot())).not.toContain(
      "controller_opportunities",
    );
    expect(f.bridge.snapshot().binding?.ready).toBe(true);
  } finally {
    await f.close();
  }
});
for (const unavailable of [
  "busy",
  "committed_prefix_pending",
  "seal_pending",
  "owner_capacity",
  "serialization_oversize",
] as const) {
  test(`native opportunity ${unavailable} is explicit unknown without changing a valid response`, async () => {
    const f = fixture();
    try {
      const peer = await f.channel("control");
      const marker = {
        schema_version: 1 as const,
        identity: opportunityBatch().identity,
        counts: null,
        final_batch: false as const,
        complete: false as const,
        events: [] as [],
        unavailable,
      };
      requests(peer, (request) =>
        timedReply(peer, request.id, { active_receipt: true }, marker),
      );
      expect(
        await Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000),
      ).toEqual({ active_receipt: true });
      expect(
        f.bridge.performanceMetrics().control_timeline.samples.at(-1)!
          .native_timing?.controller_opportunities,
      ).toEqual(marker);
      expect(f.bridge.snapshot().binding?.ready).toBe(true);
    } finally {
      await f.close();
    }
  });
}
for (const state of [
  "bounded_suffix",
  "omitted_terminal",
  "concurrent_counts",
  "complete_terminal",
] as const) {
  test(`native opportunity ${state} preserves the actual reply and truthful bookkeeping`, async () => {
    const f = fixture();
    try {
      const peer = await f.channel("control"),
        batch = opportunityBatch();
      if (state === "bounded_suffix") {
        batch.events = Array.from({ length: 64 }, (_, index) => ({
          ...batch.events[0]!,
          eventseq: String(index + 1),
        }));
        batch.counts.attempted = batch.counts.accepted = "65536";
        batch.counts.retained = 65536;
        batch.unattached_retained = 65472;
      } else if (state === "omitted_terminal") {
        batch.counts.attempted = "2";
        batch.counts.omitted = batch.counts.contended = "1";
        batch.events[0]!.eventseq = "2";
        batch.final_batch = batch.counts.sealed = true;
      } else if (state === "concurrent_counts") {
        batch.counts.attempted = "2";
        batch.counts_consistent = false;
      } else {
        batch.final_batch = batch.counts.sealed = batch.complete = true;
      }
      requests(peer, (request) =>
        timedReply(peer, request.id, { original_receipt: true }, batch),
      );
      expect(
        await Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000),
      ).toEqual({ original_receipt: true });
      expect(
        f.bridge.performanceMetrics().control_timeline.samples.at(-1)!
          .native_timing?.controller_opportunities,
      ).toEqual(batch);
      expect(f.bridge.snapshot().binding?.ready).toBe(true);
    } finally {
      await f.close();
    }
  });
}
const malformedOpportunities: Array<
  [string, (batch: NativeControllerOpportunityBatch) => void]
> = [
  [
    "batch event bound",
    (batch) => {
      batch.events = Array.from({ length: 65 }, () => ({
        ...batch.events[0]!,
      }));
    },
  ],
  [
    "ring capacity bound",
    (batch) => {
      batch.counts.retained = 65537;
    },
  ],
  [
    "unattached suffix",
    (batch) => {
      batch.unattached_retained = 1;
    },
  ],
  [
    "negative suffix",
    (batch) => {
      batch.unattached_retained = -1;
    },
  ],
  [
    "unsafe counter string",
    (batch) => {
      batch.counts.attempted = "9007199254740992";
    },
  ],
  [
    "negative counter string",
    (batch) => {
      batch.events[0]!.tick = "-1";
    },
  ],
  [
    "noncanonical counter string",
    (batch) => {
      batch.events[0]!.preparation_ordinal = "01";
    },
  ],
  [
    "out of range signed nanoseconds",
    (batch) => {
      batch.events[0]!.native_ns = "-9223372036854775809";
    },
  ],
  [
    "empty owner",
    (batch) => {
      batch.identity.owner_operation_id = "";
    },
  ],
  [
    "oversized owner",
    (batch) => {
      batch.identity.owner_operation_id = "x".repeat(161);
    },
  ],
  [
    "zero generation",
    (batch) => {
      batch.identity.controller_generation = "0";
    },
  ],
  [
    "unsafe generation",
    (batch) => {
      batch.identity.controller_generation = "9007199254740992";
    },
  ],
  [
    "invalid source",
    (batch) => {
      batch.identity.source_hash = "not-a-source-hash";
    },
  ],
  [
    "foreign boot",
    (batch) => {
      batch.identity.native_boot_id = "other-boot";
    },
  ],
  [
    "false complete claim",
    (batch) => {
      batch.complete = true;
    },
  ],
  [
    "missing known field",
    (batch) => {
      Reflect.deleteProperty(batch.events[0]!, "request_id");
    },
  ],
  [
    "unknown event field",
    (batch) => {
      Reflect.set(batch.events[0]!, "invented_input", true);
    },
  ],
  [
    "inconsistent omission counters",
    (batch) => {
      batch.counts.omitted = "1";
    },
  ],
  [
    "inconsistent count flag",
    (batch) => {
      batch.counts_consistent = false;
    },
  ],
  [
    "unknown count field",
    (batch) => {
      Reflect.set(batch.counts, "ignored_omissions", "1");
    },
  ],
];
for (const [label, mutate] of malformedOpportunities) {
  test(`malformed native opportunity ${label} fails the original socket boundary closed`, async () => {
    const f = fixture();
    try {
      const peer = await f.channel("control"),
        batch = opportunityBatch();
      mutate(batch);
      requests(peer, (request) =>
        timedReply(peer, request.id, { must_not_resolve: true }, batch),
      );
      await expect(
        Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000),
      ).rejects.toThrow();
      expect(
        f.bridge
          .performanceMetrics()
          .control_timeline.samples.some(
            (span) =>
              span.native_timing?.controller_opportunities !== undefined,
          ),
      ).toBe(false);
      await f.bridge.close();
      expect(f.bridge.snapshot().binding?.ready).not.toBe(true);
    } finally {
      await f.close();
    }
  });
}
test("an internally matching opportunity boot still fails closed against the actual bound native owner", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control"),
      batch = opportunityBatch();
    batch.identity.native_boot_id = "foreign-boot";
    requests(peer, (request) =>
      peer.write(
        JSON.stringify({
          id: request.id,
          ok: true,
          data: {},
          timing: {
            schema_version: 1,
            clock_id: "foreign-boot",
            received_ns: "1",
            replied_ns: "1",
            client_tick: 1,
            controller_opportunities: batch,
          },
        }) + "\n",
      ),
    );
    await expect(
      Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000),
    ).rejects.toThrow();
    await f.bridge.close();
    expect(f.bridge.snapshot().binding?.ready).not.toBe(true);
  } finally {
    await f.close();
  }
});

test("reserved Stop reaches the native barrier while ordinary and eight-heartbeat lanes are saturated", async () => {
  const f = fixture(),
    pending: Promise<unknown>[] = [];
  try {
    const peer = await f.channel("control"),
      received: WireRequest[] = [];
    requests(peer, (request) => {
      received.push(request);
      if (request.method === "cancel")
        reply(peer, request.id, {
          neutralized: true,
          matched_owner: true,
          generation: 2,
          session_id: f.session.session_id,
          life_id: 1,
        });
    });
    for (let index = 0; index < 16; index++)
      pending.push(
        Reflect.get(f.bridge, "request")
          .call(f.bridge, "ping")
          .catch(() => null),
      );
    for (let index = 0; index < 8; index++)
      pending.push(
        Reflect.get(f.bridge, "request")
          .call(f.bridge, "controller_heartbeat", {}, 1000)
          .catch(() => null),
      );
    await expect(
      Reflect.get(f.bridge, "request").call(f.bridge, "controller_heartbeat", {}, 1000),
    ).rejects.toThrow(/lane bound/);
    await f.bridge.emergencyStop("Saturated ordinary lane");
    expect(f.child.killed).toBe(false);
    expect(f.bridge.snapshot().status).toBe("connected");
    expect(
      received.filter((request) => request.method === "cancel"),
    ).toHaveLength(1);
    expect(received.filter(request => request.method === "controller_heartbeat")).toHaveLength(8);
    for (const request of received)
      if (request.method !== "cancel") reply(peer, request.id, {});
    await Promise.all(pending);
  } finally {
    await f.close();
    await Promise.all(pending);
  }
});
test.each([false, true])("socket controller writes overlapping heartbeats before inputs and Stop joins every held reply (failed=%s)", async failed => {
  const f = fixture(), held: WireRequest[] = [], ordered: WireRequest[] = [];
  const neutral = { forward: false, back: false, left: false, right: false, jump: false, sprint: false,
    sneak: false, attack: false, use: false };
  const retiredResponse = Promise.withResolvers<void>();
  let stopped = false, captureSequence = 0, lastApplied = 0;
  let nextApplied = Promise.withResolvers<void>();
  const unsubscribe = f.bridge.subscribeControlTiming(span => {
    if (span.method === "controller_revoke") retiredResponse.resolve();
  });
  try {
    const peer = await f.channel("control");
    requests(peer, request => {
      if (request.method === "controller_open") {
        lastApplied = 0;
        timedReply(peer, request.id, {
          owner: request.params.owner, controller_generation: request.params.controller_generation,
        });
      } else if (request.method === "controller_sample") {
        captureSequence++;
        timedReply(peer, request.id, capturedFrame(controllerFrameFixture(1, 1), captureSequence, 10 + captureSequence));
      } else if (request.method === "controller_heartbeat") {
        ordered.push(request);
        if (request.generation === 1) held.push(request);
        else timedReply(peer, request.id, {});
      } else if (request.method === "controller_submit") {
        ordered.push(request);
        lastApplied = request.params.sequence as number;
        timedReply(peer, request.id, {
          controller_generation: 1, sequence: lastApplied, ordered_edge_prefix: 0,
          applied_native_tick: 20 + lastApplied, applied_native_ns: nativeFixtureNanos(),
          held: neutral, applied_pose: { yaw_radians: 0, pitch_radians: 0 },
          input_application: "confirmed", reason: null,
        });
      } else if (request.method === "controller_revoke") {
        ordered.push(request);
        timedReply(peer, request.id, {
          generation: request.generation + 1,
          ack: {
            owner: request.params.owner, controller_generation: request.params.controller_generation,
            admission_revoked: true, last_applied_sequence: lastApplied, ordered_edge_prefix: 0,
            retirement_applied_native_tick: 30, retirement_applied_native_ns: nativeFixtureNanos(),
            input_application: "confirmed", unresolved_operation_refs: [],
          },
        });
      } else timedReply(peer, request.id, {});
    });
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping");
    const { action: _, ...reservation } = envelope(ordinaryInput, f.session);
    const channel = await f.bridge.openController(reservation, 1, performance.now() + 10000,
      () => nextApplied.resolve(), () => {});
    let frame = await channel.sample(null);
    for (let index = 0; index < 3; index++) {
      if (index > 0) frame = await channel.sample(null);
      nextApplied = Promise.withResolvers<void>();
      await channel.renew(frame);
      expect(channel.submit(frame, {
        kind: "world", held: neutral, edges: [], view: { kind: "unchanged" }, selected_hotbar: null,
      }).status).toBe("submitted");
      await nextApplied.promise;
    }
    expect(held).toHaveLength(3);
    expect(ordered.map(request => request.method)).toEqual(Array.from({ length: 3 }, () =>
      ["controller_heartbeat", "controller_submit"]).flat());
    for (const request of held) {
      expect<unknown>(request.params.owner).toEqual(channel.owner);
      expect(request.params.controller_generation).toBe(1);
    }
    expect(held.map(request => request.id)).toEqual([...held.map(request => request.id)].sort((a, b) => a - b));
    const stopping = f.bridge.emergencyStop("Join overlapped heartbeat responses").then(() => { stopped = true; });
    await retiredResponse.promise;
    expect(stopped).toBe(false);
    expect(channel.snapshot()).toMatchObject({ fenced: true, applied_sequence: 3 });
    await expect(channel.renew(frame)).rejects.toThrow();
    expect(() => f.bridge.openController(reservation, 2, performance.now() + 10000, () => {}, () => {}))
      .toThrow(/sole native writer/);
    timedReply(peer, held[2]!.id, {});
    if (failed) peer.write(JSON.stringify({
      id: held[0]!.id, ok: false, error: "native_input_lease_expired",
    }) + "\n");
    else timedReply(peer, held[0]!.id, {});
    // This later response is a socket-order barrier for the two released replies.
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping");
    expect(stopped).toBe(false);
    expect(ordered.filter(request => request.method === "controller_revoke")).toHaveLength(1);
    timedReply(peer, held[1]!.id, {});
    await stopping;
    if (failed) expect(channel.snapshot().reason).toContain("native_input_lease_expired");

    const { action: _replacementAction, ...replacementReservation } = envelope(ordinaryInput, f.session);
    const replacement = await f.bridge.openController(replacementReservation, 2, performance.now() + 10000, () => {}, () => {});
    expect(replacement.owner.generation).toBe(2);
    const fresh = await replacement.sample(null);
    await replacement.renew(fresh);
    await replacement.renew(null);
    // An old channel cannot write or release the replacement owner.
    expect(channel.submit(frame, {
      kind: "world", held: neutral, edges: [], view: { kind: "unchanged" }, selected_hotbar: null,
    }).status).toBe("rejected");
    await channel.revoke();
    expect(replacement.snapshot()).toMatchObject({ fenced: false, retired: false, submitted_sequence: 0 });
    await replacement.revoke();
  } finally {
    unsubscribe();
    await f.close();
  }
});
test("a controller retains the sole writer through submitted input and the actual retirement ACK", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control"),
      applied = Promise.withResolvers<void>(),
      retiring = Promise.withResolvers<WireRequest>();
    const submitted = Promise.withResolvers<WireRequest>();
    let captureSequence = 0;
    requests(peer, (request) => {
      if (request.method === "controller_open")
        timedReply(peer, request.id, {
          owner: request.params.owner,
          controller_generation: 1,
        });
      else if (request.method === "controller_sample")
        timedReply(peer, request.id, capturedFrame(controllerFrameFixture(1, 1), ++captureSequence, 10));
      else if (request.method === "controller_submit")
        submitted.resolve(request);
      else if (request.method === "controller_revoke")
        retiring.resolve(request);
      else if (request.method === "execute")
        timedReply(
          peer,
          request.id,
          effectReply(request, {
            status: "succeeded",
            summary: "Finite input after actual retirement",
            evidence: { effect_confirmed: false },
          }),
        );
      else timedReply(peer, request.id, {});
    });
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping");
    const effect = envelope(ordinaryInput, f.session),
      { action: _, ...reservation } = effect;
    const channel = await f.bridge.openController(
      reservation,
      1,
      performance.now() + 5000,
      () => applied.resolve(),
      () => {},
    );
    const frame = await channel.sample(null);
    const held = {
      forward: true,
      back: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      sneak: false,
      attack: false,
      use: false,
    };
    const submission = channel.submit(frame, {
      kind: "world",
      held,
      edges: [{ kind: "button", button: "forward", phase: "press", count: 1 }],
      view: { kind: "unchanged" },
      selected_hotbar: null,
    });
    expect(submission.status).toBe("submitted");
    expect(channel.snapshot().applied_sequence).toBe(0);
    // A native response is deliberately absent: admission is not input application.
    expect(
      (
        await f.bridge.execute(
          envelope(ordinaryInput, f.session),
          new AbortController().signal,
        )
      ).status,
    ).toBe("failed");
    const diagnostic = opportunityBatch();
    diagnostic.identity.owner_operation_id = channel.owner.operation_id;
    diagnostic.identity.source_hash = channel.owner.scope.source_hash;
    timedReply(
      peer,
      (await submitted.promise).id,
      {
        controller_generation: 1,
        sequence: 1,
        ordered_edge_prefix: 1,
        applied_native_tick: 11,
        applied_native_ns: nativeFixtureNanos(),
        held,
        applied_pose: { yaw_radians: 0, pitch_radians: 0 },
        input_application: "confirmed",
        reason: null,
      },
      diagnostic,
    );
    await applied.promise;
    expect(channel.snapshot().ordered_edge_prefix).toBe(1);
    expect(channel.snapshot().applied_sequence).toBe(1);
    expect(
      f.bridge
        .performanceMetrics()
        .control_timeline.samples.find(
          (span) => span.method === "controller_submit",
        )?.native_timing?.controller_opportunities,
    ).toEqual(diagnostic);
    expect(JSON.stringify(channel.snapshot())).not.toContain(
      "controller_opportunities",
    );
    const retirement = channel.revoke(),
      request = await retiring.promise;
    expect(channel.snapshot().retired).toBe(false);
    expect(
      (
        await f.bridge.execute(
          envelope(ordinaryInput, f.session),
          new AbortController().signal,
        )
      ).status,
    ).toBe("failed");
    timedReply(peer, request.id, {
      generation: 2,
      ack: {
        owner: channel.owner,
        controller_generation: 1,
        admission_revoked: true,
        last_applied_sequence: 1,
        ordered_edge_prefix: 1,
        retirement_applied_native_tick: 12,
        retirement_applied_native_ns: nativeFixtureNanos(),
        input_application: "confirmed",
        unresolved_operation_refs: [effect.operation_id],
      },
    });
    await retirement;
    expect(channel.snapshot().retired).toBe(true);
    expect(
      (
        await f.bridge.execute(
          envelope(ordinaryInput, f.session),
          new AbortController().signal,
        )
      ).status,
    ).toBe("succeeded");
  } finally {
    await f.close();
  }
});
for (const [label, rootMs, applicationDelay, expected] of [
  ["allows a lawful GUI sequence beyond two seconds", 10000, 2100, "applied"],
  ["caps GUI application by immutable root authority", 350, 1000, "contained"],
] as const) {
  test(`controller transport ${label}`, async () => {
    const f = fixture(),
      applied = Promise.withResolvers<"applied">();
    let delayed: NodeJS.Timeout | undefined;
    try {
      const peer = await f.channel("control");
      Reflect.set(f.bridge, "state", {
        ...f.bridge.snapshot(),
        screen: feedbackScreen,
      });
      requests(peer, (request) => {
        if (request.method === "controller_open")
          timedReply(peer, request.id, {
            owner: request.params.owner,
            controller_generation: 1,
          });
        else if (request.method === "controller_sample")
          timedReply(peer, request.id, capturedFrame(projectedFeedback(), 1, 10));
        else if (request.method === "controller_submit")
          delayed = setTimeout(
            () =>
              timedReply(peer, request.id, {
                controller_generation: 1,
                sequence: 1,
                ordered_edge_prefix: 16,
                applied_native_tick: 11,
                applied_native_ns: nativeFixtureNanos(),
                held: {
                  forward: false,
                  back: false,
                  left: false,
                  right: false,
                  jump: false,
                  sprint: false,
                  sneak: false,
                  attack: false,
                  use: false,
                },
                applied_pose: { yaw_radians: 0, pitch_radians: 0 },
                input_application: "confirmed",
                reason: null,
              }),
            applicationDelay,
          );
        else timedReply(peer, request.id, {});
      });
      await Reflect.get(f.bridge, "request").call(f.bridge, "ping");
      const { action: _, ...reservation } = envelope(ordinaryInput, f.session);
      reservation.expected_screen = {
        kind: "transaction",
        screen: feedbackScreen,
      };
      const channel = await f.bridge.openController(
        reservation,
        1,
        performance.now() + rootMs,
        () => applied.resolve("applied"),
        () => {},
      );
      const captured = await channel.sample(null);
      const empty = { item: null, count: 0 },
        planks = { item: "oak_planks", count: 4 };
      const operations = Array.from({ length: 16 }, (_, index) => {
        const half = index % 4,
          slot_id = half === 0 || half === 3 ? 36 : 37;
        return {
          kind: "slot" as const,
          slot_id,
          button: "left" as const,
          mode: "ordinary" as const,
          hotbar_slot: null,
          expected_cursor: half % 2 === 0 ? empty : planks,
          expected_slots: [{ slot_id, value: half % 2 === 0 ? planks : empty }],
        };
      });
      expect(
        channel.submit(captured, {
          kind: "screen",
          screen: {
            screen_id: feedbackScreen.screen_id,
            incarnation: feedbackScreen.incarnation,
            layout_revision: 7,
          },
          operations,
        }).status,
      ).toBe("submitted");
      const outcome = await Promise.race([
        applied.promise,
        f.closed.then(() => "contained" as const),
      ]);
      expect(outcome).toBe(expected);
      expect(channel.snapshot().applied_sequence).toBe(
        expected === "applied" ? 1 : 0,
      );
    } finally {
      if (delayed) clearTimeout(delayed);
      await f.close();
    }
  });
}
test("resident renewal refuses an aged decision without disguising it as a fresh heartbeat", async () => {
  const f = fixture();
  let heartbeats = 0;
  try {
    const peer = await f.channel("control");
    requests(peer, (request) => {
      if (request.method === "controller_open")
        timedReply(peer, request.id, {
          owner: request.params.owner,
          controller_generation: 1,
        });
      else if (request.method === "controller_sample")
        timedReply(peer, request.id, capturedFrame(controllerFrameFixture(1, 1), 1, 10));
      else {
        if (request.method === "controller_heartbeat") heartbeats++;
        timedReply(peer, request.id, {});
      }
    });
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping");
    const { action: _, ...reservation } = envelope(ordinaryInput, f.session);
    const channel = await f.bridge.openController(
      reservation,
      1,
      performance.now() + 10000,
      () => {},
      () => {},
    );
    const captured = await channel.sample(null);
    await channel.renew(captured);
    const aged = Promise.withResolvers<void>();
    setTimeout(aged.resolve, 180);
    await aged.promise;
    await expect(channel.renew(captured)).rejects.toThrow();
    expect(heartbeats).toBe(1);
    await channel.renew(null);
    expect(heartbeats).toBe(2);
    expect(channel.snapshot().submitted_sequence).toBe(0);
  } finally {
    await f.close();
  }
});
test("cancelled undispatched actions never claim a confirmed effect", async () => {
  const bridge = new GameBridgeClient(),
    controller = new AbortController();
  controller.abort();
  const result = await bridge.execute(
    envelope({ kind: "move", controls: { forward: true }, duration_ms: 200 }),
    controller.signal,
  );
  expect(result.status).toBe("cancelled");
  expect(result.evidence).toEqual({
    effect_confirmed: false,
    neutralized_effect: false,
  });
  await bridge.close();
});
test("an unnegotiated emitter refuses before dispatch without inventing another adapter or an unknown emitted effect", async () => {
  const bridge = new GameBridgeClient();
  const result = await bridge.execute(
    envelope({ kind: "look", yaw: 0, pitch: 0 }),
    new AbortController().signal,
  );
  expect(result.status).toBe("failed");
  expect(result.requires_reconnect).toBeUndefined();
  expect(bridge.adapter()).toBeNull();
  expect(bridge.latestFrame()).toBeNull();
  await bridge.close();
});
test("ordinary world input refuses an open screen without dispatching or auto-closing it", async () => {
  const f = fixture(),
    screen = { screen_id: "inventory", incarnation: 1, revision: 1 };
  try {
    const peer = await f.channel("control"),
      methods: string[] = [];
    requests(peer, (request) => {
      methods.push(request.method);
      if (request.method === "execute")
        reply(
          peer,
          request.id,
          effectReply(request, {
            status: "succeeded",
            summary: "Unexpected dispatch",
            evidence: { effect_confirmed: false },
          }),
        );
    });
    Reflect.set(f.bridge, "state", { ...f.bridge.snapshot(), screen });
    const effect = {
      ...envelope(ordinaryInput, f.session),
      expected_screen: { kind: "transaction" as const, screen },
    };
    const result = await f.bridge.execute(effect, new AbortController().signal);
    expect(result.status).toBe("failed");
    expect(methods).toEqual([]);
    expect(f.bridge.snapshot().screen).toEqual(screen);
    expect(f.child.killed).toBe(false);
    expect(result.evidence).toEqual({
      effect_confirmed: false,
      neutralized_effect: false,
    });
  } finally {
    await f.close();
  }
});

test("visible screen read uses only its registered route and validates complete native geometry without effects", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control"),
      methods: string[] = [];
    let projected: unknown = {
      identity: { screen_id: "view", incarnation: 1, layout_revision: 2 },
      content_revision: 3,
      screen_kind: "generic_container",
      viewport: { width: 320, height: 240, scale_factor: 2 },
      slots: [
        {
          slot_id: 0,
          value: { item: null, count: 0 },
          bounds: { x: 10, y: 20, width: 16, height: 16 },
          enabled: true,
        },
      ],
      cursor: { item: null, count: 0 },
      elements: [],
      progress: [],
    };
    requests(peer, (request) => {
      methods.push(request.method);
      reply(peer, request.id, projected);
    });
    const value = await f.bridge.queryCapability(
      "minecraft.visible_screen",
      1,
      {},
    );
    expect(value).toMatchObject({
      cursor: { item: null, count: 0 },
      slots: [{ slot_id: 0, value: { item: null, count: 0 } }],
    });
    await expect(
      f.bridge.queryCapability("minecraft.visible_screen", 1, {
        hidden_offers: true,
      }),
    ).rejects.toThrow();
    await expect(
      f.bridge.queryCapability("arbitrary.world.query", 1, {}),
    ).rejects.toThrow();
    projected = { ...(projected as object), cursor: undefined };
    await expect(
      f.bridge.queryCapability("minecraft.visible_screen", 1, {}),
    ).rejects.toThrow();
    projected = null;
    expect(
      await f.bridge.queryCapability("minecraft.visible_screen", 1, {}),
    ).toBeNull();
    expect(methods).toEqual([
      "visible_screen",
      "visible_screen",
      "visible_screen",
    ]);
    expect(f.child.killed).toBe(false);
  } finally {
    await f.close();
  }
});

const feedbackScreen = {
  screen_id: "feedback-view-A",
  incarnation: 4,
  revision: 2,
};
function projectedFeedback() {
  return {
    ...controllerFrameFixture(1, 1),
    screen: {
      identity: {
        screen_id: feedbackScreen.screen_id,
        incarnation: feedbackScreen.incarnation,
        layout_revision: 7,
      },
      content_revision: 2,
      screen_kind: "generic_container",
      viewport: { width: 320, height: 240, scale_factor: 2 },
      slots: [],
      cursor: { item: null, count: 0 },
      elements: [],
      progress: [],
    },
  };
}
for (const [name, replacement] of [
  ["close", null],
  [
    "replacement",
    { screen_id: "feedback-view-B", incarnation: 5, revision: 1 },
  ],
  [
    "reincarnation",
    { screen_id: feedbackScreen.screen_id, incarnation: 5, revision: 1 },
  ],
] as const) {
  test(`controller feedback refuses a coalesced ${name} notice that obsoletes its screen`, async () => {
    const f = fixture();
    try {
      const peer = await f.channel("control");
      let replace = false,
        sequence = 0;
      Reflect.set(f.bridge, "state", {
        ...f.bridge.snapshot(),
        screen: feedbackScreen,
      });
      requests(peer, (request) => {
        if (request.method !== "controller_frame") {
          reply(peer, request.id, {});
          return;
        }
        const data = { ...projectedFeedback(), frame_seq: ++sequence };
        if (!replace) {
          reply(peer, request.id, data);
          return;
        }
        const notice = {
          ...f.notice(
            { life_id: 1, status: "alive", can_respawn: false, death: null },
            2,
          ),
          type: "scope",
          screen: replacement,
        };
        // One actual parser callback, not an assumption about TCP chunk coalescing.
        const control = Reflect.get(f.bridge, "control") as Socket;
        control.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: request.id, ok: true, data })}\n${JSON.stringify({ notice })}\n`,
          ),
        );
      });
      const args = { audio_cursor: { stream_id: "life1-space1", sequence: 9 } };
      expect(
        await f.bridge.queryCapability("minecraft.controller_frame", 2, args),
      ).toHaveProperty("frame_seq", 1);
      replace = true;
      await expect(
        f.bridge.queryCapability("minecraft.controller_frame", 2, args),
      ).rejects.toBeInstanceOf(ControllerScreenReadSupersededError);
      expect(f.bridge.snapshot().screen).toEqual(replacement);
    } finally {
      await f.close();
    }
  });
}
for (const [name, initial, replacement] of [
  ["open", null, feedbackScreen],
  ["close", feedbackScreen, null],
  ["replacement", feedbackScreen, { screen_id: "fresh-feedback-B", incarnation: 5, revision: 1 }],
  ["reincarnation", feedbackScreen, { screen_id: feedbackScreen.screen_id, incarnation: 5, revision: 1 }],
] as const) {
  test(`fresh controller feedback follows a ${name} during the read without adopting an old screen`, async () => {
    const f = fixture();
    try {
      const peer = await f.channel("control");
      Reflect.set(f.bridge, "state", { ...f.bridge.snapshot(), screen: initial });
      requests(peer, request => {
        if (request.method !== "controller_frame") { reply(peer, request.id, {}); return; }
        const projected = projectedFeedback();
        const screen = replacement ? { ...projected.screen,
          identity: { ...projected.screen.identity, screen_id: replacement.screen_id, incarnation: replacement.incarnation } } : null;
        const notice = { ...f.notice({ life_id: 1, status: "alive", can_respawn: false, death: null }, 2),
          type: "scope", screen: replacement };
        const control = Reflect.get(f.bridge, "control") as Socket;
        control.emit("data", Buffer.from(
          `${JSON.stringify({ id: request.id, ok: true, data: { ...projected, screen } })}\n${JSON.stringify({ notice })}\n`,
        ));
      });
      const result = await f.bridge.queryCapability("minecraft.controller_frame", 2, { audio_cursor: null });
      expect(result).toMatchObject({ screen: replacement ? {
        identity: { screen_id: replacement.screen_id, incarnation: replacement.incarnation },
      } : null });
      expect(f.bridge.snapshot().screen).toEqual(replacement);
    } finally { await f.close(); }
  });
}

test("controller feedback retains the same screen across unrelated transaction revisions", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control");
    Reflect.set(f.bridge, "state", {
      ...f.bridge.snapshot(),
      screen: feedbackScreen,
    });
    requests(peer, (request) => {
      if (request.method !== "controller_frame") {
        reply(peer, request.id, {});
        return;
      }
      const notice = {
        ...f.notice(
          { life_id: 1, status: "alive", can_respawn: false, death: null },
          2,
        ),
        type: "scope",
        screen: { ...feedbackScreen, revision: 99 },
      };
      const control = Reflect.get(f.bridge, "control") as Socket;
      control.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ id: request.id, ok: true, data: projectedFeedback() })}\n${JSON.stringify({ notice })}\n`,
        ),
      );
    });
    const result = await f.bridge.queryCapability(
      "minecraft.controller_frame",
      2,
      { audio_cursor: { stream_id: "life1-space1", sequence: 9 } },
    );
    expect(result).toHaveProperty(
      "screen.identity.screen_id",
      "feedback-view-A",
    );
    expect(f.bridge.snapshot().screen?.revision).toBe(99);
  } finally {
    await f.close();
  }
});

test("GUI dispatch uses exact action layout authority rather than unrelated transaction revisions", async () => {
  const f = fixture(),
    screen = { screen_id: "furnace", incarnation: 4, revision: 999 };
  try {
    const peer = await f.channel("control"),
      methods: string[] = [];
    requests(peer, (request) => {
      methods.push(request.method);
      reply(
        peer,
        request.id,
        effectReply(request, {
          status: "succeeded",
          summary: "Scoped persistence",
          evidence: { effect_confirmed: false },
        }),
      );
    });
    Reflect.set(f.bridge, "state", { ...f.bridge.snapshot(), screen });
    const layout = {
      screen_id: screen.screen_id,
      incarnation: screen.incarnation,
      layout_revision: 1,
    };
    const action = { kind: "screen_input", screen: layout, operations: [] };
    const effect: EffectEnvelope = {
      ...envelope(action, f.session),
      expected_screen: { kind: "layout", screen: layout },
    };
    expect(
      (await f.bridge.execute(effect, new AbortController().signal)).status,
    ).toBe("succeeded");
    expect(f.bridge.snapshot().screen).toEqual(screen);
    expect(
      (
        await f.bridge.execute(
          {
            ...effect,
            expected_screen: {
              kind: "layout",
              screen: { ...layout, layout_revision: 2 },
            },
          },
          new AbortController().signal,
        )
      ).status,
    ).toBe("failed");
    expect(
      (
        await f.bridge.execute(
          { ...effect, expected_screen: { kind: "transaction", screen } },
          new AbortController().signal,
        )
      ).status,
    ).toBe("failed");
    expect(methods).toEqual(["execute"]);
  } finally {
    await f.close();
  }
});

test("a lost zero-operation GUI ACK has its finite scoped deadline without replay or implicit close", async () => {
  const f = fixture(),
    layout = { screen_id: "persistent", incarnation: 1, layout_revision: 1 };
  try {
    const peer = await f.channel("control"),
      methods: string[] = [];
    requests(peer, (request) => {
      methods.push(request.method);
    });
    Reflect.set(f.bridge, "state", {
      ...f.bridge.snapshot(),
      screen: { screen_id: "persistent", incarnation: 1, revision: 200 },
    });
    const effect: EffectEnvelope = {
      ...envelope(
        { kind: "screen_input", screen: layout, operations: [] },
        f.session,
      ),
      expected_screen: { kind: "layout", screen: layout },
    };
    const started = performance.now(),
      result = await f.bridge.execute(effect, new AbortController().signal);
    expect(performance.now() - started).toBeLessThan(8000);
    expect(result).toMatchObject({
      status: "unknown",
      requires_reconnect: true,
    });
    expect(methods).toEqual(["execute"]);
    expect(f.child.killed).toBe(true);
  } finally {
    await f.close();
  }
}, 10000);

test("selected scroll preserves exact layout authority and native unhandled rejection without retry", async () => {
  const f = fixture(),
    screen = { screen_id: "stonecutter", incarnation: 4, revision: 999 };
  try {
    const peer = await f.channel("control"),
      dispatched: unknown[] = [];
    const operation = {
      kind: "scroll",
      element_id: "current-region",
      horizontal: 0.5,
      vertical: -1,
    };
    const layout = {
      screen_id: screen.screen_id,
      incarnation: screen.incarnation,
      layout_revision: 7,
    };
    const action = {
      kind: "screen_input",
      screen: layout,
      operations: [operation],
    };
    const effect: EffectEnvelope = {
      ...envelope(action, f.session),
      expected_screen: { kind: "layout", screen: layout },
    };
    requests(peer, (request) => {
      dispatched.push(request.params);
      reply(
        peer,
        request.id,
        effectReply(request, {
          status: "failed",
          summary: "Native region did not handle scroll.",
          evidence: { effect_confirmed: false, neutralized_effect: true },
        }),
      );
    });
    Reflect.set(f.bridge, "state", { ...f.bridge.snapshot(), screen });
    const result = await f.bridge.execute(effect, new AbortController().signal);
    expect(result).toMatchObject({
      status: "failed",
      evidence: { effect_confirmed: false, neutralized_effect: true },
    });
    expect(dispatched).toEqual([effect]);
    expect(f.bridge.snapshot().screen).toEqual(screen);
    expect(
      (
        await f.bridge.execute(
          {
            ...effect,
            expected_screen: {
              kind: "layout",
              screen: { ...layout, layout_revision: 8 },
            },
          },
          new AbortController().signal,
        )
      ).status,
    ).toBe("failed");
    Reflect.set(f.bridge, "state", {
      ...f.bridge.snapshot(),
      screen: { ...screen, incarnation: 5 },
    });
    expect(
      (await f.bridge.execute(effect, new AbortController().signal)).status,
    ).toBe("failed");
    expect(dispatched).toEqual([effect]);
    expect(f.child.killed).toBe(false);
  } finally {
    await f.close();
  }
});

test("a stalled ordinary input ACK closes the actual emitter on its own finite deadline without replay or neutralization claims", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control"),
      methods: string[] = [];
    requests(peer, (request) => {
      methods.push(request.method);
    });
    const started = performance.now();
    const result = await f.bridge.execute(
      envelope(ordinaryInput, f.session),
      new AbortController().signal,
    );
    expect(performance.now() - started).toBeLessThan(6000);
    expect(result).toMatchObject({
      status: "unknown",
      requires_reconnect: true,
      evidence: { effect_confirmed: false, neutralized_effect: false },
    });
    expect(methods).toEqual(["execute"]);
    expect(f.child.killed).toBe(true);
    await f.closed;
    expect(f.bridge.snapshot().status).toBe("error");
  } finally {
    await f.close();
  }
}, 10000);
test("ordinary cancellation confirms emitter containment without inventing acknowledged native release or effect confirmation", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control"),
      methods: string[] = [],
      emitted = Promise.withResolvers<void>();
    requests(peer, (request) => {
      methods.push(request.method);
      if (request.method === "execute") emitted.resolve();
    });
    const effect = envelope(ordinaryInput, f.session);
    const executing = f.bridge.execute(effect, new AbortController().signal);
    await emitted.promise;
    await f.bridge.cancel("Unacknowledged ordinary cancellation", {
      operation_id: effect.operation_id,
      scope: effect.scope,
    });
    expect(await executing).toMatchObject({
      status: "unknown",
      evidence: { effect_confirmed: false, neutralized_effect: false },
    });
    expect(methods).toEqual(["execute", "cancel"]);
    expect(f.child.killed).toBe(true);
  } finally {
    await f.close();
  }
}, 10000);
test("expected-owner cancellation still awaits already-owned terminal cleanup without a socket", async () => {
  const bridge = new GameBridgeClient(),
    exited = Promise.withResolvers<void>(),
    effect = envelope({ kind: "look", yaw: 0, pitch: 0 });
  Reflect.set(bridge, "closing", exited.promise);
  let returned = false;
  const cancellation = bridge
    .cancel("Terminal owner still draining", {
      operation_id: effect.operation_id,
      scope: effect.scope,
    })
    .then(() => {
      returned = true;
    });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    exited.resolve();
    await cancellation;
    expect(returned).toBe(true);
  } finally {
    exited.resolve();
    await cancellation;
    Reflect.set(bridge, "closing", null);
    await bridge.close();
  }
});
test("authoritative death preserves session/video/unknown history; explicit respawn changes life and space only", async () => {
  // Actual sockets/process ownership, deliberately synthetic native packets: no game-hook proof.
  const f = fixture(),
    notices: BridgeNotice[] = [];
  f.bridge.subscribe((value) => notices.push(value));
  try {
    const peer = await f.channel("control");
    const dead: PlayerLife = {
      life_id: 1,
      status: "dead",
      can_respawn: false,
      death: { death_id: "first", at: new Date().toISOString(), message: null },
    };
    requests(peer, (request) => {
      if (request.method === "ping") reply(peer, request.id, {});
      if (request.method === "motor_profile") {
        const selected = minecraftTestAdapter(
          z.enum(["balanced", "precise", "fast"]).parse(request.params.profile),
        );
        reply(peer, request.id, {
          profile: request.params.profile,
          descriptor: selected.descriptor,
        });
      }
      if (request.method !== "execute") return;
      const effect = effectRequestSchema.parse(request.params),
        action = effect.action;
      if (action.kind !== "respawn") {
        peer.write(JSON.stringify({ notice: f.notice(dead, 2) }) + "\n");
        reply(
          peer,
          request.id,
          effectReply(request, {
            status: "unknown",
            summary: "Synthetic interrupted effect",
            evidence: {
              effect_confirmed: false,
              neutralized: true,
              life_fenced: true,
            },
          }),
        );
      } else {
        expect(effect.scope.life_id).toBe(1);
        expect(request.generation).toBe(2);
        const life: PlayerLife = {
          life_id: 2,
          status: "alive",
          can_respawn: false,
          death: null,
        };
        peer.write(JSON.stringify({ notice: f.notice(life, 3, 2) }) + "\n");
        reply(
          peer,
          request.id,
          effectReply(request, {
            status: "succeeded",
            summary: "Synthetic replacement receipt",
            evidence: jsonSchema.parse({ effect_confirmed: true, life }),
          }),
        );
      }
    });
    peer.write(
      JSON.stringify({
        notice: { ...f.notice(dead, 2), epoch: f.session.epoch - 1 },
      }) +
        "\n" +
        JSON.stringify({
          notice: { ...f.notice(dead, 2), session_id: "obsolete-session" },
        }) +
        "\n",
    );
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000);
    const first = await f.bridge.execute(
      envelope(
        { kind: "move", controls: { forward: true }, duration_ms: 200 },
        f.session,
      ),
      new AbortController().signal,
    );
    expect(first.status).toBe("unknown");
    expect(first.requires_reconnect).toBeUndefined();
    expect(f.bridge.snapshot().life).toEqual(dead);
    expect(f.bridge.snapshot().status).toBe("connected");
    expect(f.child.killed).toBe(false);
    expect(
      notices.find((value) => value.type === "game_event")?.data,
    ).toMatchObject({ type: "death", epoch: f.session.epoch });
    const frame = nativeFrame({ width: 1, height: 1 }),
      delivered = Promise.withResolvers<void>();
    f.bridge.subscribeFrames(() => delivered.resolve());
    await f.channel("video", frame);
    await delivered.promise;
    expect(f.bridge.latestFrame()).toEqual(Buffer.from(frame));
    expect(f.bridge.snapshot().video.status).toBe("streaming");
    await f.bridge.setMotorProfile("fast");
    expect(
      f.bridge.snapshot().binding?.descriptor.observation.profile.configuration,
    ).toEqual(minecraftProfileConfiguration("fast"));
    expect(f.bridge.snapshot().life?.status).toBe("dead");
    peer.write(
      JSON.stringify({ notice: f.notice({ ...dead, can_respawn: true }, 2) }) +
        "\n",
    );
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000);
    const respawn = await f.bridge.execute(
      envelope(
        { kind: "respawn" },
        f.session,
        1,
        1,
        minecraftTestAdapter("fast"),
      ),
      new AbortController().signal,
    );
    expect(respawn.status).toBe("succeeded");
    expect(f.bridge.snapshot().life?.life_id).toBe(2);
    expect(f.bridge.snapshot().space?.space_epoch).toBe(2);
    expect(f.bridge.snapshot().session_id).toBe(f.session.session_id);
    expect(f.bridge.snapshot().epoch).toBe(f.session.epoch);
    expect(f.child.killed).toBe(false);
    peer.write(
      JSON.stringify({
        notice: f.notice(
          {
            ...dead,
            life_id: 2,
            death: { ...dead.death!, death_id: "second" },
          },
          4,
          2,
        ),
      }) + "\n",
    );
    await Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000);
    expect(f.bridge.snapshot().life?.status).toBe("dead");
    expect(f.bridge.snapshot().error).toBeNull();
    peer.end();
    await f.closed;
    await f.bridge.disconnect();
    expect(f.bridge.snapshot().status).toBe("error");
    expect(f.bridge.snapshot().life).toBeNull();
  } finally {
    await f.close();
  }
}, 10000);
for (const order of ["owner-first", "stop-first"] as const) {
  test(`overlapping ${order} cancellation and Stop drain the single native retirement slot without closing a healthy session`, async () => {
    const f = fixture();
    try {
      const peer = await f.channel("control"),
        effect = envelope(
          {
            kind: "dig",
            target: {
              target_id: "deadline-dig",
              incarnation: 1,
              space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
              life_id: 1,
            },
          },
          f.session,
        ),
        emitted = Promise.withResolvers<WireRequest>(),
        firstBarrier = Promise.withResolvers<WireRequest>(),
        barriers: WireRequest[] = [],
        abort = new AbortController();
      let nativeGeneration = 1;
      const acknowledge = (request: WireRequest) => {
        const matched = request.params.emergency === true || nativeGeneration === 1;
        if (matched) nativeGeneration++;
        reply(peer, request.id, {
          neutralized: true,
          matched_owner: matched,
          generation: nativeGeneration,
          session_id: f.session.session_id,
          life_id: 1,
        });
      };
      requests(peer, (request) => {
        if (request.method === "execute") emitted.resolve(request);
        if (request.method === "cancel") {
          barriers.push(request);
          if (barriers.length === 1) firstBarrier.resolve(request);
          else acknowledge(request);
        }
        if (request.method === "ping") reply(peer, request.id, {});
      });
      const executing = f.bridge.execute(effect, abort.signal),
        executeRequest = await emitted.promise;
      let stopping: Promise<void>;
      if (order === "owner-first") {
        abort.abort();
        await firstBarrier.promise;
        stopping = f.bridge.emergencyStop("Finite gameplay deadline");
      } else {
        stopping = f.bridge.emergencyStop("Finite gameplay deadline");
        await firstBarrier.promise;
        abort.abort();
      }
      const duplicateStop = f.bridge.emergencyStop("Same finite deadline");
      const first = await firstBarrier.promise;
      // The game thread drains the old effect before publishing the reserved ACK.
      reply(peer, executeRequest.id, {
        operation_id: effect.operation_id,
        compatibility_hash: effect.compatibility_hash,
        scope: effect.scope,
        result: {
          status: "unknown",
          summary: "The prior dig outcome remains unconfirmed.",
          evidence: { effect_confirmed: false, neutralized_effect: false },
        },
      });
      acknowledge(first);
      await Promise.all([stopping, duplicateStop]);
      expect(await executing).toMatchObject({
        status: "unknown",
        evidence: { effect_confirmed: false, neutralized_effect: false },
      });
      expect(f.child.killed).toBe(false);
      expect(f.bridge.snapshot().status).toBe("connected");
      expect(f.bridge.snapshot().error).toBeNull();
      expect(barriers).toHaveLength(2);
      expect(barriers[0]!.generation).toBe(1);
      expect(barriers[1]!.generation).toBe(2);
      const ownerRequest = barriers.find(
        (request) => request.params.expected_owner,
      )!;
      expect(ownerRequest.params.expected_owner).toMatchObject({
        operation_id: effect.operation_id,
        scope: effect.scope,
        generation: 1,
      });
      expect(nativeGeneration).toBe(order === "owner-first" ? 3 : 2);
      await Reflect.get(f.bridge, "request").call(f.bridge, "ping", {}, 1000);
      expect(Reflect.get(f.bridge, "generation")).toBe(nativeGeneration);
    } finally {
      await f.close();
    }
  }, 10000);
}
test("an emergency Stop cannot accept an unmatched-owner ACK as global neutralization", async () => {
  const f = fixture();
  try {
    const peer = await f.channel("control");
    requests(peer, (request) =>
      reply(peer, request.id, {
        neutralized: true,
        matched_owner: false,
        generation: request.generation,
        session_id: f.session.session_id,
        life_id: 1,
      }),
    );
    await Promise.all([
      f.bridge.emergencyStop("Invalid global ACK"),
      f.bridge.emergencyStop("Same invalid global ACK"),
    ]);
    expect(f.child.killed).toBe(true);
    expect(f.bridge.snapshot().status).toBe("error");
    expect(f.bridge.snapshot().error).toBe(
      "Native emergency Stop could not be acknowledged.",
    );
  } finally {
    await f.close();
  }
}, 10000);
for (const invalid of [
  "stale-generation",
  "foreign-session",
  "not-neutralized",
  "native-error",
] as const) {
  test(`overlapping Stop fails closed on ${invalid} owner ACK without replaying the unknown effect`, async () => {
    const f = fixture();
    try {
      const peer = await f.channel("control"),
        effect = envelope(ordinaryInput, f.session),
        emitted = Promise.withResolvers<void>(),
        received = Promise.withResolvers<WireRequest>(),
        methods: string[] = [],
        abort = new AbortController();
      requests(peer, (request) => {
        methods.push(request.method);
        if (request.method === "execute") emitted.resolve();
        if (request.method === "cancel") received.resolve(request);
      });
      const executing = f.bridge.execute(effect, abort.signal);
      await emitted.promise;
      abort.abort();
      const request = await received.promise,
        stopping = f.bridge.emergencyStop("Overlapping invalid owner ACK");
      if (invalid === "native-error")
        peer.write(
          JSON.stringify({
            id: request.id,
            ok: false,
            error: "Native retirement failed.",
          }) + "\n",
        );
      else
        reply(peer, request.id, {
          neutralized: invalid !== "not-neutralized",
          matched_owner: true,
          generation: invalid === "stale-generation" ? 1 : 2,
          session_id:
            invalid === "foreign-session" ? randomUUID() : f.session.session_id,
          life_id: 1,
        });
      await stopping;
      expect(await executing).toMatchObject({
        status: "unknown",
        requires_reconnect: true,
        evidence: { effect_confirmed: false, neutralized_effect: false },
      });
      expect(methods).toEqual(["execute", "cancel"]);
      expect(f.child.killed).toBe(true);
      expect(f.bridge.snapshot().status).toBe("error");
    } finally {
      await f.close();
    }
  }, 10000);
}
test("expected-owner barrier accepts its ACK before newer death notice without advancing the native clock speculatively", async () => {
  const f = fixture(adapter, true);
  try {
    const peer = await f.channel("control"),
      effect = envelope({ kind: "look", yaw: 0, pitch: 0 }, f.session);
    Reflect.set(f.bridge, "ownedEffect", { effect, generation: 1 });
    let count = 0;
    const received = Promise.withResolvers<WireRequest>();
    requests(peer, (request) => {
      count++;
      received.resolve(request);
    });
    const owner = { operation_id: effect.operation_id, scope: effect.scope };
    let completed = false;
    const a = f.bridge.neutralize(owner).then(() => {
        completed = true;
      }),
      b = f.bridge.neutralize(owner);
    const request = await received.promise;
    expect(completed).toBe(false);
    expect(count).toBe(1);
    expect(request.params.expected_owner).toMatchObject({
      ...owner,
      generation: 1,
    });
    expect(request.generation).toBe(1);
    peer.write(
      JSON.stringify({
        id: request.id,
        ok: true,
        data: {
          neutralized: true,
          matched_owner: true,
          generation: 2,
          session_id: f.session.session_id,
          life_id: 1,
        },
      }) +
        "\n" +
        JSON.stringify({
          notice: f.notice(
            { life_id: 1, status: "dead", can_respawn: false, death: null },
            3,
          ),
        }) +
        "\n",
    );
    await Promise.all([a, b]);
    expect(completed).toBe(true);
    expect(f.child.killed).toBe(false);
    expect(f.bridge.snapshot().error).toBeNull();
    const next = Promise.withResolvers<WireRequest>();
    peer.once("data", (chunk) =>
      next.resolve(requestSchema.parse(JSON.parse(chunk.toString().trim()))),
    );
    const barrier = f.bridge.neutralize(owner),
      nextRequest = await next.promise;
    expect(nextRequest.generation).toBe(3);
    // Owner A is already retired: this receipt must not revoke B or advance the clock.
    reply(peer, nextRequest.id, {
      neutralized: true,
      matched_owner: false,
      generation: 3,
      session_id: f.session.session_id,
      life_id: 1,
    });
    await barrier;
    expect(f.child.killed).toBe(false);
    expect(f.bridge.snapshot().status).toBe("connected");
  } finally {
    await f.close();
  }
}, 10000);
test("alive connection waits for the loading screen and actual overlay input eligibility", async () => {
  const f = fixture(),
    methods: string[] = [],
    loading = { screen_id: "loading", incarnation: 1, revision: 1 };
  const seenLoading = Promise.withResolvers<void>();
  let screen: typeof loading | null = loading;
  let diagnostics: Record<string, boolean> = {};
  let diagnosticRead = Promise.withResolvers<void>();
  Reflect.set(f.bridge, "owned", null);
  Reflect.set(
    Reflect.get(f.bridge, "launcher"),
    "launch",
    async (_config: unknown, controlPort: number) => {
      const peer = createConnection({ host: "127.0.0.1", port: controlPort });
      f.peers.push(peer);
      peer.on("error", () => {});
      peer.once("connect", () =>
        peer.write(JSON.stringify(hello(f.session)) + "\n"),
      );
      requests(peer, (request) => {
        methods.push(request.method);
        if (request.method === "diagnostics") {
          reply(peer, request.id, diagnostics);
          diagnosticRead.resolve();
          return;
        }
        if (request.method !== "observe") return;
        const observation = minecraftObservationFixture(adapter, {
          world_id: f.session.world_id,
          session_id: f.session.session_id,
          epoch: f.session.epoch,
        });
        observation.screen = screen;
        reply(peer, request.id, observation);
      });
      return f.owned;
    },
  );
  f.bridge.subscribe((notice) => {
    if (
      notice.type === "observation" &&
      f.bridge.snapshot().screen?.screen_id === loading.screen_id
    )
      seenLoading.resolve();
  });
  try {
    const connecting = f.bridge.connect({
      host: "127.0.0.1",
      port: 25565,
      version: "1.21.4",
      world_id: f.session.world_id,
      epoch: f.session.epoch,
    });
    await seenLoading.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.bridge.snapshot().status).toBe("connecting");
    screen = null;
    for (const next of [
      { overlay_present: true, world_input_events_ready: false },
      { overlay_present: false, world_input_events_ready: false },
      { overlay_present: false, world_input_events_ready: true },
    ]) {
      await diagnosticRead.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.bridge.snapshot().status).toBe("connecting");
      diagnostics = next;
      diagnosticRead = Promise.withResolvers<void>();
    }
    await connecting;
    expect(f.bridge.snapshot().status).toBe("connected");
    expect((await f.bridge.observe()).screen).toBeNull();
    expect(methods).not.toContain("execute");
    expect(methods).not.toContain("respawn");
    expect(methods).not.toContain("controller_open");
  } finally {
    await f.close();
  }
}, 10000);
test("saved-dead connection negotiates the real declared profile without execute or automatic respawn", async () => {
  const selected = minecraftTestAdapter("fast"),
    f = fixture(selected, true),
    methods: string[] = [];
  // Loading seam only: substitute launcher beneath actual connect/hello/observe.
  Reflect.set(f.bridge, "owned", null);
  Reflect.set(
    Reflect.get(f.bridge, "launcher"),
    "launch",
    async (_config: unknown, controlPort: number) => {
      const peer = createConnection({ host: "127.0.0.1", port: controlPort });
      f.peers.push(peer);
      peer.on("error", () => {});
      peer.once("connect", () =>
        peer.write(JSON.stringify(hello(f.session, selected)) + "\n"),
      );
      requests(peer, (request) => {
        methods.push(request.method);
        if (request.method !== "observe") return;
        const observation = minecraftObservationFixture(selected, {
          world_id: f.session.world_id,
          session_id: f.session.session_id,
          epoch: f.session.epoch,
          life: { life_id: 1, status: "dead", can_respawn: false, death: null },
        });
        observation.data.player.health = 0;
        reply(peer, request.id, observation);
      });
      return f.owned;
    },
  );
  try {
    await f.bridge.connect({
      host: "127.0.0.1",
      port: 25565,
      version: "1.21.4",
      world_id: f.session.world_id,
      epoch: f.session.epoch,
      motor_profile: "fast",
    });
    expect(f.bridge.snapshot().status).toBe("connected");
    expect(f.bridge.snapshot().life?.status).toBe("dead");
    expect(
      f.bridge.snapshot().binding?.descriptor.observation.profile.configuration,
    ).toEqual(minecraftProfileConfiguration("fast"));
    expect(methods).toEqual(["observe"]);
    const ready = Promise.withResolvers<void>();
    f.bridge.subscribe((notice) => {
      if (notice.type === "state" && f.bridge.snapshot().life?.can_respawn)
        ready.resolve();
    });
    f.peers[0]!.write(
      JSON.stringify({
        notice: f.notice(
          { life_id: 1, status: "dead", can_respawn: true, death: null },
          1,
        ),
      }) + "\n",
    );
    await ready.promise;
    expect(f.bridge.snapshot().life?.can_respawn).toBe(true);
    expect(methods).toEqual(["observe"]);
    expect(f.child.killed).toBe(false);
  } finally {
    await f.close();
  }
}, 10000);
