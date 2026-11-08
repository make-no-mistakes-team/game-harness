import { expect, test, vi } from "bun:test";
import type { ExpectedEffectOwner, WorldHeld, WorldInputEdge } from "../src/shared/control.ts";
import { minecraftControllerFrameSchema } from "../src/shared/minecraft.ts";
import { controllerInputFrameSchema, controllerInputSchema, inputAppliedAckSchema, inputSubmissionSchema,
  residentFrameContextSchema, revocationAckSchema,
  type ControllerInputFrame, type InputAppliedAck, type RevocationAck } from "../src/shared/controller.ts";
import { ControllerInputs } from "../src/server/controller-inputs.ts";
import { NativeControllerChannel, type ControllerChannelTransport } from "../src/server/controller-channel.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";

const neutral: WorldHeld = { forward: false, back: false, left: false, right: false, jump: false,
  sprint: false, sneak: false, attack: false, use: false };
const owner = (): ExpectedEffectOwner => ({ operation_id: "resident-owner", generation: 3,
  scope: { session_id: "session", world_id: "world", epoch: 1, native_boot_id: "boot", run_id: "run",
    run_generation: 2, life_id: 4, space_epoch: 5, execution_id: "controller", source_hash: "a".repeat(64) } });
const world = (frame_seq: number, held: WorldHeld = { ...neutral }, edges: WorldInputEdge[] = []): ControllerInputFrame => ({
  context: { owner: owner(), controller_generation: 7, source_hash: "a".repeat(64), frame_seq,
    observed_native_tick: 10, captured_native_ns: "1000000000" },
  input: { kind: "world", held, edges, view: { kind: "unchanged" }, selected_hotbar: null },
});
const screen = (frame_seq: number, count = 1): ControllerInputFrame => ({ ...world(frame_seq),
  input: { kind: "screen", screen: { screen_id: "inventory", incarnation: 1, layout_revision: 2 },
    operations: Array.from({ length: count }, () => ({ kind: "close" as const })) } });
const ack = (sequence: number, ordered_edge_prefix = 0, overrides: Partial<InputAppliedAck> = {}): InputAppliedAck => ({
  controller_generation: 7, sequence, ordered_edge_prefix, applied_native_tick: 11,
  applied_native_ns: "1010000000", held: { ...neutral }, applied_pose: { yaw_radians: 9, pitch_radians: .25 },
  input_application: "confirmed", reason: null, ...overrides,
});
const retirement = (overrides: Partial<RevocationAck> = {}): RevocationAck => ({ owner: owner(), controller_generation: 7,
  admission_revoked: true, last_applied_sequence: 0, ordered_edge_prefix: 0, retirement_applied_native_tick: 12,
  retirement_applied_native_ns: "1020000000", input_application: "confirmed", unresolved_operation_refs: [], ...overrides });
const press = (button: keyof WorldHeld, count = 1): WorldInputEdge => ({ kind: "button", button, phase: "press", count });
const release = (button: keyof WorldHeld): WorldInputEdge => ({ kind: "button", button, phase: "release", count: 1 });
const submit = (ledger: ControllerInputs, frame: ControllerInputFrame) => ledger.submit(frame, "1000000000");

// Catches substituting neutral-start world_input validation for stateful resident admission.
test("submitted unacknowledged held press remains the basis for a later release", () => {
  const ledger = new ControllerInputs(owner(), 7);
  expect(submit(ledger, world(1, { ...neutral, use: true }, [press("use")])).status).toBe("submitted");
  expect(submit(ledger, world(2, { ...neutral, use: true })).status).toBe("submitted");
  expect(submit(ledger, world(3, { ...neutral }, [release("use")])).status).toBe("submitted");
  expect(ledger.snapshot()).toMatchObject({ applied_sequence: 0, pending_frames: 3, pending_edges: 2, last_input: null });
  expect(ledger.take()?.frame.context.frame_seq).toBe(1);
  expect(ledger.take()?.frame.context.frame_seq).toBe(2);
  expect(ledger.take()?.frame.context.frame_seq).toBe(3);
  expect(ledger.take()).toBeNull();
});

test("unexplained held transition fences admission without discarding unresolved input", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, world(1, { ...neutral, attack: true }, [press("attack")]));
  expect(submit(ledger, world(2)).status).toBe("rejected");
  expect(ledger.snapshot()).toMatchObject({ fenced: true, pending_frames: 1, pending_edges: 1, applied_sequence: 0 });
  expect(submit(ledger, world(3, { ...neutral, attack: true })).status).toBe("rejected");
});

test("last compatible unsent snapshot coalesces with new identity without jumping ordered work", () => {
  const ledger = new ControllerInputs(owner(), 7);
  const first = submit(ledger, world(1, { ...neutral, forward: true }, [press("forward")]));
  const second = submit(ledger, world(2, { ...neutral, forward: true }));
  const latest = world(3, { ...neutral, forward: true });
  if (latest.input.kind === "world") latest.input.view = { kind: "rate", yaw_radians_per_second: 2, pitch_radians_per_second: -1 };
  const third = submit(ledger, latest);
  expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
  expect(third.status).toBe("coalesced");
  expect(ledger.snapshot()).toMatchObject({ submitted_sequence: 3, applied_sequence: 0, pending_frames: 2 });
  expect(ledger.take()).toMatchObject({ sequence: 1, ordered_edge_start: 0, ordered_edge_end: 1 });
  expect(ledger.take()).toMatchObject({ sequence: 3, frame: { context: { frame_seq: 3 } }, ordered_edge_start: 1, ordered_edge_end: 1 });
  expect(ledger.acceptAck(ack(2))).toBe(false);
  expect(ledger.snapshot()).toMatchObject({ fenced: true, applied_sequence: 0, pending_edges: 1 });
});

test("sent snapshots never coalesce and delta view or selected hotbar never coalesce", () => {
  for (const special of ["sent", "delta", "hotbar", "screen", "ordered"] as const) {
    const ledger = new ControllerInputs(owner(), 7);
    const first = special === "screen" ? screen(1) : world(1);
    if (first.input.kind === "world") {
      if (special === "delta") first.input.view = { kind: "delta", yaw_radians: 1, pitch_radians: 0 };
      if (special === "hotbar") first.input.selected_hotbar = 1;
      if (special === "ordered") first.input.edges = [{ kind: "hand_swap" }];
    }
    submit(ledger, first);
    if (special === "sent") ledger.take();
    expect(submit(ledger, world(2)).status).toBe("submitted");
    expect(ledger.snapshot().pending_frames).toBe(2);
  }
});

test("new delta view and explicit selection are not lost by coalescing", () => {
  for (const value of ["delta", "hotbar"] as const) {
    const ledger = new ControllerInputs(owner(), 7);
    submit(ledger, world(1));
    const next = world(2);
    if (next.input.kind === "world") {
      if (value === "delta") next.input.view = { kind: "delta", yaw_radians: 1, pitch_radians: 0 };
      else next.input.selected_hotbar = 8;
    }
    expect(submit(ledger, next).status).toBe("submitted");
    expect(ledger.snapshot().pending_frames).toBe(2);
  }
});

test("four unresolved frames include sent and unsent and overflow preserves retirement", () => {
  const ledger = new ControllerInputs(owner(), 7);
  for (let i = 1; i <= 4; i++) {
    expect(submit(ledger, screen(i)).status).toBe("submitted");
    if (i <= 2) ledger.take();
  }
  expect(submit(ledger, screen(5)).status).toBe("rejected");
  expect(ledger.snapshot()).toMatchObject({ fenced: true, pending_frames: 4, pending_edges: 4, retired: false });
  ledger.revoke();
  expect(ledger.snapshot().retired).toBe(false);
  expect(ledger.acceptRevocation(retirement({ unresolved_operation_refs: ["screen-unknown"] }))).toBe(true);
  expect(ledger.snapshot()).toMatchObject({ fenced: true, retired: true, pending_frames: 0, pending_edges: 0 });
  expect(ledger.take()).toBeNull();
  expect(submit(ledger, world(6)).status).toBe("rejected");
});

test("fence and revocation prevent unsent backlog emission but retain already sent ACK authority", () => {
  for (const stop of ["revoke", "overflow"] as const) {
    const ledger = new ControllerInputs(owner(), 7);
    for (let i = 1; i <= 4; i++) submit(ledger, screen(i));
    ledger.take();
    if (stop === "revoke") ledger.revoke();
    else submit(ledger, screen(5));
    expect(ledger.take()).toBeNull();
    expect(ledger.acceptAck(ack(1, 1))).toBe(true);
    expect(ledger.snapshot()).toMatchObject({ fenced: true, pending_frames: 3, pending_edges: 3, applied_sequence: 1 });
    expect(ledger.take()).toBeNull();
  }
});

test("compatible unsent coalescing remains available at four-frame saturation", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, screen(1)); submit(ledger, screen(2)); submit(ledger, screen(3));
  submit(ledger, world(4));
  expect(submit(ledger, world(5))).toEqual({ sequence: 5, status: "coalesced", reason: null });
  expect(ledger.snapshot()).toMatchObject({ pending_frames: 4, fenced: false });
  expect(ledger.take()?.sequence).toBe(1);
  expect(ledger.take()?.sequence).toBe(2);
  expect(ledger.take()?.sequence).toBe(3);
  expect(ledger.take()?.sequence).toBe(5);
});

test("expanded edge budget survives snapshot ACK independently of consumed prefix", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, world(1, { ...neutral, attack: true }, [press("attack", 256)]));
  ledger.take();
  expect(ledger.acceptAck(ack(1, 0, { held: { ...neutral, attack: true } }))).toBe(true);
  expect(ledger.snapshot()).toMatchObject({ pending_frames: 0, pending_edges: 256, applied_sequence: 1 });
  expect(ledger.acceptAck(ack(1, 128, { held: { ...neutral, attack: true } }))).toBe(true);
  expect(ledger.snapshot().pending_edges).toBe(128);
  expect(submit(ledger, world(2, { ...neutral, attack: true }, [press("attack", 128)])).status).toBe("submitted");
  expect(ledger.snapshot().pending_edges).toBe(256);
  expect(submit(ledger, world(3, { ...neutral, attack: true }, [{ kind: "hand_swap" }])).status).toBe("rejected");
  expect(ledger.snapshot()).toMatchObject({ fenced: true, pending_edges: 256, pending_frames: 1 });
});

test("screen operations each consume ordered budget and require neutral submitted held", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, screen(1, 16));
  expect(ledger.take()).toMatchObject({ ordered_edge_start: 0, ordered_edge_end: 16 });
  const held = new ControllerInputs(owner(), 7);
  submit(held, world(1, { ...neutral, use: true }, [press("use")]));
  expect(submit(held, screen(2)).status).toBe("rejected");
  expect(held.snapshot()).toMatchObject({ fenced: true, pending_frames: 1, pending_edges: 1 });
});

test("native author age uses exact signed long precision and inclusive 150ms boundary", () => {
  for (const [captured, now, status] of [
    ["1000000000", "1150000000", "submitted"],
    ["1000000000", "1150000001", "rejected"],
    ["1000000001", "1000000000", "rejected"],
    ["-9007199254740993", "-9007199104740993", "submitted"],
    ["-9007199254740993", "-9007199104740992", "rejected"],
    ["-9223372036854775808", "-9223372036704775808", "submitted"],
    ["9223372036704775807", "9223372036854775807", "submitted"],
    ["-9223372036854775808", "9223372036854775807", "rejected"],
  ] as const) {
    const ledger = new ControllerInputs(owner(), 7), frame = world(1);
    frame.context.captured_native_ns = captured;
    expect(ledger.submit(frame, now).status).toBe(status);
    expect(ledger.snapshot()).toMatchObject({ applied_sequence: 0, last_input: null });
  }
});

test("rejected stale frame does not advance accepted frame identity", () => {
  const ledger = new ControllerInputs(owner(), 7);
  expect(ledger.submit(world(2), "1150000001").status).toBe("rejected");
  expect(submit(ledger, world(1)).status).toBe("submitted");
  expect(submit(ledger, world(1)).status).toBe("rejected");
  expect(ledger.snapshot().submitted_sequence).toBe(1);
});

test("unusable native clock input is rejected without fabricated application or sequence allocation", () => {
  for (const now of ["9223372036854775808", "-9223372036854775809", "1.5", "+1"]) {
    const ledger = new ControllerInputs(owner(), 7);
    expect(ledger.submit(world(1), now)).toMatchObject({ sequence: 0, status: "rejected" });
    expect(ledger.snapshot()).toMatchObject({ submitted_sequence: 0, pending_frames: 0, last_input: null });
    expect(submit(ledger, world(1)).status).toBe("submitted");
  }
});

test("every owner field plus generation and source is admission authority", () => {
  const base = owner();
  for (const key of Object.keys(base.scope) as (keyof typeof base.scope)[]) {
    const ledger = new ControllerInputs(owner(), 7), frame = world(1);
    const scope = frame.context.owner.scope;
    Object.assign(scope, { [key]: typeof scope[key] === "number" ? Number(scope[key]) + 1 : key === "source_hash" ? "b".repeat(64) : `${scope[key]}-other` });
    expect(submit(ledger, frame).status).toBe("rejected");
    expect(ledger.snapshot().pending_frames).toBe(0);
  }
  for (const edit of [
    (f: ControllerInputFrame) => { f.context.owner.operation_id = "other"; },
    (f: ControllerInputFrame) => { f.context.owner.generation++; },
    (f: ControllerInputFrame) => { f.context.controller_generation++; },
    (f: ControllerInputFrame) => { f.context.source_hash = "b".repeat(64); },
  ]) {
    const ledger = new ControllerInputs(owner(), 7), frame = world(1); edit(frame);
    expect(submit(ledger, frame).status).toBe("rejected");
  }
});

test("later sent ACK retires earlier snapshots but older and duplicate ACKs never earn credit", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, screen(1)); submit(ledger, screen(2)); ledger.take(); ledger.take();
  expect(ledger.acceptAck(ack(2, 1, { applied_native_tick: 20, applied_native_ns: "1100000000" }))).toBe(true);
  const before = ledger.snapshot();
  expect(before).toMatchObject({ applied_sequence: 2, ordered_edge_prefix: 1, pending_frames: 0, pending_edges: 1 });
  expect(ledger.acceptAck(ack(1, 1))).toBe(false);
  expect(ledger.acceptAck(ack(2, 1, { applied_native_tick: 20, applied_native_ns: "1100000000" }))).toBe(false);
  expect(ledger.acceptAck(ack(2, 2, { applied_native_tick: 19, applied_native_ns: "1100000000" }))).toBe(false);
  expect(ledger.acceptAck(ack(2, 2, { applied_native_tick: 20, applied_native_ns: "1099999999" }))).toBe(false);
  expect(ledger.snapshot()).toEqual(before);
  expect(ledger.acceptAck(ack(2, 2, { applied_native_tick: 21, applied_native_ns: "1100000001" }))).toBe(true);
  expect(ledger.snapshot()).toMatchObject({ pending_edges: 0, ordered_edge_prefix: 2 });
});

test("wrong generation ACK is ignored but unsent and future sequences fence without credit", () => {
  const old = new ControllerInputs(owner(), 7);
  submit(old, screen(1)); old.take();
  expect(old.acceptAck(ack(1, 1, { controller_generation: 6 }))).toBe(false);
  expect(old.snapshot()).toMatchObject({ fenced: false, pending_edges: 1, applied_sequence: 0 });
  for (const sequence of [1, 2]) {
    const ledger = new ControllerInputs(owner(), 7); submit(ledger, screen(1));
    expect(ledger.acceptAck(ack(sequence, 1))).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ fenced: true, pending_frames: 1, pending_edges: 1, applied_sequence: 0 });
  }
});

test("ACK cannot claim edges beyond its own sent range or regress the confirmed prefix", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, screen(1)); submit(ledger, screen(2)); ledger.take(); ledger.take();
  expect(ledger.acceptAck(ack(1, 2))).toBe(false);
  expect(ledger.snapshot()).toMatchObject({ fenced: true, pending_frames: 2, pending_edges: 2, ordered_edge_prefix: 0 });
  const valid = new ControllerInputs(owner(), 7);
  submit(valid, screen(1)); submit(valid, screen(2)); valid.take(); valid.take();
  valid.acceptAck(ack(1, 1));
  const before = valid.snapshot();
  expect(valid.acceptAck(ack(2, 0))).toBe(false);
  expect(valid.snapshot()).toEqual(before);
});

test("confirmed ACK held must match the submitted final state", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, world(1, { ...neutral, attack: true }, [press("attack")])); ledger.take();
  expect(ledger.acceptAck(ack(1, 1))).toBe(false);
  expect(ledger.snapshot()).toMatchObject({ fenced: true, pending_frames: 1, pending_edges: 1, last_input: null });
});

test("partial and unknown ACKs preserve truthful actual input and fence further admission", () => {
  for (const input_application of ["partial", "unknown"] as const) {
    const ledger = new ControllerInputs(owner(), 7);
    submit(ledger, world(1, { ...neutral, attack: true }, [press("attack", 4)])); ledger.take();
    expect(ledger.acceptAck(ack(1, 1, { input_application, reason: "native interruption" }))).toBe(true);
    expect(ledger.snapshot()).toMatchObject({ fenced: true, retired: false, pending_edges: 3,
      last_input: { input_application, held: neutral, ordered_edge_prefix: 1 } });
    expect(submit(ledger, world(2, { ...neutral, attack: true })).status).toBe("rejected");
  }
});

test("revocation requires exact confirmed actual retirement and never fabricates last input", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, screen(1)); ledger.take(); ledger.acceptAck(ack(1, 0)); ledger.revoke();
  const before = ledger.snapshot();
  for (const invalid of [
    retirement({ controller_generation: 6, last_applied_sequence: 1 }),
    retirement({ owner: { ...owner(), generation: 4 }, last_applied_sequence: 1 }),
    retirement({ last_applied_sequence: 0 }),
    retirement({ last_applied_sequence: 2 }),
    retirement({ last_applied_sequence: 1, ordered_edge_prefix: 2 }),
    retirement({ last_applied_sequence: 1, retirement_applied_native_tick: 10 }),
    retirement({ last_applied_sequence: 1, retirement_applied_native_ns: "1009999999" }),
  ]) expect(ledger.acceptRevocation(invalid)).toBe(false);
  expect(ledger.snapshot()).toEqual(before);
  const actual = retirement({ last_applied_sequence: 1, ordered_edge_prefix: 1 });
  expect(ledger.acceptRevocation(actual)).toBe(true);
  expect(ledger.snapshot()).toMatchObject({ retired: true, pending_frames: 0, pending_edges: 0,
    applied_sequence: 1, ordered_edge_prefix: 1, last_input: { sequence: 1, ordered_edge_prefix: 0 } });
  expect(ledger.acceptRevocation(actual)).toBe(false);
});

test("retirement cannot label an unsent or coalesced sequence applied", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, world(1)); submit(ledger, world(2)); ledger.revoke();
  expect(ledger.acceptRevocation(retirement({ last_applied_sequence: 1 }))).toBe(false);
  expect(ledger.acceptRevocation(retirement({ last_applied_sequence: 2 }))).toBe(false);
  expect(ledger.acceptRevocation(retirement())).toBe(true);
});

test("retirement prefix cannot include a later sent frame than its last actual application", () => {
  const ledger = new ControllerInputs(owner(), 7);
  submit(ledger, screen(1)); submit(ledger, screen(2)); ledger.take(); ledger.take(); ledger.revoke();
  expect(ledger.acceptRevocation(retirement({ last_applied_sequence: 1, ordered_edge_prefix: 2 }))).toBe(false);
  expect(ledger.acceptRevocation(retirement({ last_applied_sequence: 0, ordered_edge_prefix: 1 }))).toBe(false);
  expect(ledger.snapshot()).toMatchObject({ retired: false, ordered_edge_prefix: 0, pending_edges: 2 });
  expect(ledger.acceptRevocation(retirement({ last_applied_sequence: 1, ordered_edge_prefix: 1 }))).toBe(true);
});

test("retained authority frames and actual ACKs cannot be changed through caller aliases", () => {
  const identity = owner(), ledger = new ControllerInputs(identity, 7);
  identity.scope.life_id = 999;
  const frame = world(1, { ...neutral, use: true }, [press("use")]);
  submit(ledger, frame);
  if (frame.input.kind === "world") { frame.input.held.use = false; frame.input.edges.length = 0; }
  frame.context.owner.scope.life_id = 999;
  const taken = ledger.take()!;
  expect(taken.frame.context.owner.scope.life_id).toBe(4);
  if (taken.frame.input.kind === "world") { taken.frame.input.held.use = false; taken.frame.input.edges.length = 0; }
  const applied = ack(1, 1, { held: { ...neutral, use: true } });
  expect(ledger.acceptAck(applied)).toBe(true);
  applied.held.use = false; applied.applied_pose.pitch_radians = 1;
  const copy = ledger.snapshot(); copy.last_input!.held.use = false;
  expect(ledger.snapshot().last_input).toMatchObject({ held: { use: true }, applied_pose: { pitch_radians: .25 } });
  expect(submit(ledger, world(2, { ...neutral }, [release("use")])).status).toBe("submitted");
});

test("strict controller DTOs retain reused edge validation without neutral-start held validation", () => {
  const continuing = world(1, { ...neutral, use: true });
  expect(controllerInputFrameSchema.safeParse(continuing).success).toBe(true);
  expect(inputSubmissionSchema.safeParse({ sequence: 1, status: "submitted", reason: null }).success).toBe(true);
  for (const input of [
    { ...world(1).input, extra: true },
    { ...world(1).input, held: { ...neutral, fly: false } },
    { ...world(1).input, edges: [press("attack", 257)] },
    { ...world(1).input, edges: [press("attack", 256), { kind: "hand_swap" }] },
    { ...world(1).input, edges: [{ kind: "button", button: "use", phase: "release", count: 2 }] },
    { ...world(1).input, edges: [{ kind: "hotbar", slot: 1 }, { kind: "hotbar", slot: 1 }] },
    { ...world(1).input, selected_hotbar: 2, edges: [{ kind: "hotbar", slot: 1 }] },
    { ...world(1).input, edges: [{ kind: "drop", all: false }, { kind: "drop", all: true }] },
    { ...screen(1, 16).input, operations: Array.from({ length: 17 }, () => ({ kind: "close" })) },
  ]) expect(controllerInputSchema.safeParse(input).success).toBe(false);
  expect(controllerInputSchema.safeParse(world(1, { ...neutral, attack: true }, [press("attack", 256)]).input).success).toBe(true);
});

test("DTOs reject unsafe counters private actor ACK authority and malformed native signed longs", () => {
  for (const captured_native_ns of ["9223372036854775808", "-9223372036854775809", "01", "+1", "1e9", "1.2", "", 1]) {
    expect(residentFrameContextSchema.safeParse({ ...world(1).context, captured_native_ns }).success).toBe(false);
    expect(inputAppliedAckSchema.safeParse({ ...ack(1), applied_native_ns: captured_native_ns }).success).toBe(false);
    expect(revocationAckSchema.safeParse({ ...retirement(), retirement_applied_native_ns: captured_native_ns }).success).toBe(false);
  }
  for (const captured_native_ns of ["-9223372036854775808", "9223372036854775807"])
    expect(residentFrameContextSchema.safeParse({ ...world(1).context, captured_native_ns }).success).toBe(true);
  for (const invalid of [
    { ...world(1).context, source_hash: "b".repeat(64) }, { ...world(1).context, controller_generation: 0 },
    { ...world(1).context, frame_seq: 0 }, { ...world(1).context, observed_native_tick: Number.MAX_SAFE_INTEGER + 1 },
  ]) expect(residentFrameContextSchema.safeParse(invalid).success).toBe(false);
  for (const invalid of [
    { ...ack(1), owner: owner() }, { ...ack(1), source_hash: "a".repeat(64) }, { ...ack(1), sequence: 0 },
    { ...ack(1), ordered_edge_prefix: Number.MAX_SAFE_INTEGER + 1 }, { ...ack(1), held: { ...neutral, fly: true } },
    { ...ack(1), applied_pose: { yaw_radians: Infinity, pitch_radians: 0 } },
    { ...ack(1), applied_pose: { yaw_radians: 0, pitch_radians: Math.PI } },
  ]) expect(inputAppliedAckSchema.safeParse(invalid).success).toBe(false);
  expect(inputAppliedAckSchema.parse(ack(1)).applied_pose).toEqual({ yaw_radians: 9, pitch_radians: .25 });
  expect(revocationAckSchema.safeParse({ ...retirement(), input_application: "unknown" }).success).toBe(false);
  expect(revocationAckSchema.safeParse({ ...retirement(), unresolved_operation_refs: Array(257).fill("unknown") }).success).toBe(false);
  expect(() => new ControllerInputs(owner(), 0)).toThrow();
});

function nativeChannel(operationId = "resident-owner", generation = 3, deadlineHostMs = 10000) {
  const identity = { ...owner(), operation_id: operationId, generation };
  const frame = controllerFrameFixture(identity.scope.life_id, identity.scope.space_epoch);
  frame.frame_seq = 1; frame.native_tick = 10;
  frame.captured_native_ns = frame.inventory.captured_native_ns = "1000000000";
  const calls: string[] = [], applied: InputAppliedAck[] = [];
  let retired = false;
  let request: ControllerChannelTransport["request"] = async method => {
    if (method === "controller_revoke") return { ack: retirement({ owner: identity,
      last_applied_sequence: applied.at(-1)?.sequence ?? 0, ordered_edge_prefix: applied.at(-1)?.ordered_edge_prefix ?? 0 }), generation: generation + 1 };
    if (method === "controller_submit") return ack(1);
    return {};
  };
  const transport: ControllerChannelTransport = {
    async request(...args) { calls.push(args[0]); return await request(...args); },
    async sample() { return minecraftControllerFrameSchema.parse(structuredClone(frame)); },
    clock: () => ({ clock_id: "native-test", host_sent_ms: 0, host_received_ms: 0,
      native_received_ns: "1000000000", native_replied_ns: "1000000000", native_processing_ms: 0,
      residual_round_trip_ms: 0, offset_lower_ms: 1000, offset_upper_ms: 1000, uncertainty_ms: 0 }),
    assertCurrent() { if (retired) throw new Error("Controller owner has retired."); },
    retired() { retired = true; }, async failed() { throw new Error("Unexpected unconfirmed retirement"); },
  };
  const channel = new NativeControllerChannel(identity, 7, deadlineHostMs, transport, value => applied.push(value), () => {});
  return { channel, calls, applied, frame, request(fn: typeof request) { request = fn; } };
}
async function settleChannel() { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); }

test.each([false, true])("partial GUI ACK retains its cause through queued rejection and retirement (contained=%s)", async contained => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  const first = Promise.withResolvers<unknown>(), queued = Promise.withResolvers<unknown>();
  const retiring = Promise.withResolvers<unknown>();
  const partial = ack(1, 1, { input_application: "partial", reason: "screen_incarnation_changed_during_application" });
  h.request(async (method, params) => {
    if (method === "controller_submit") {
      const { sequence } = params as { sequence: number };
      return await (sequence === 1 ? first.promise : queued.promise);
    }
    if (method === "controller_revoke") return await retiring.promise;
    throw new Error(`Unexpected native request: ${method}`);
  });
  try {
    const frame = await h.channel.sample(null);
    expect(h.channel.submit(frame, screen(1, 2).input).status).toBe("submitted");
    h.frame.frame_seq = 2;
    const next = await h.channel.sample(null);
    expect(h.channel.submit(next, screen(2).input).status).toBe("submitted");
    await settleChannel();
    expect(h.calls).toEqual(["controller_submit", "controller_submit"]);

    if (contained) h.channel.contained();
    first.resolve(partial);
    await settleChannel();
    expect(h.channel.snapshot()).toMatchObject({ fenced: true, retired: false, applied_sequence: 1,
      pending_frames: 1, pending_edges: 2, reason: "screen_incarnation_changed_during_application", last_input: partial });
    expect(h.applied).toEqual([partial]);
    expect(h.calls).toEqual(["controller_submit", "controller_submit", "controller_revoke"]);
    await expect(h.channel.renew(next)).rejects.toThrow(/screen_incarnation_changed_during_application/);

    retiring.resolve({ ack: retirement({ last_applied_sequence: 1, ordered_edge_prefix: 1,
      unresolved_operation_refs: ["screen-unknown"] }), generation: 4 });
    await settleChannel();
    let retired = false;
    const retirementComplete = h.channel.revoke().then(() => { retired = true; });
    await settleChannel();
    expect(retired).toBe(false);

    queued.reject(new Error("Controller retired without confirmed application: partial_input_application"));
    await retirementComplete;
    expect(h.channel.snapshot()).toMatchObject({ fenced: true, retired: true, applied_sequence: 1,
      pending_frames: 0, pending_edges: 0, reason: "screen_incarnation_changed_during_application", last_input: partial });
    await expect(h.channel.sample(null)).rejects.toThrow(/screen_incarnation_changed_during_application/);
    expect(h.channel.submit(next, screen(2).input)).toMatchObject({ status: "rejected",
      reason: "screen_incarnation_changed_during_application" });
    await expect(h.channel.renew(next)).rejects.toThrow(/screen_incarnation_changed_during_application/);
    expect(h.channel.snapshot().reason).toBe("screen_incarnation_changed_during_application");
    expect(h.calls).toEqual(["controller_submit", "controller_submit", "controller_revoke"]);
  } finally {
    first.resolve(partial);
    queued.resolve(ack(2, 3));
    retiring.resolve({ ack: retirement({ last_applied_sequence: 1, ordered_edge_prefix: 1 }), generation: 4 });
    await settleChannel();
    clock.mockRestore();
  }
});

test("native submission failure retains its actual phase and frame instead of becoming admission_revoked", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  h.request(async method => {
    if (method === "controller_submit") throw new Error("Controller retired without confirmed application: queued_frame_expired_before_application");
    return { ack: retirement(), generation: 4 };
  });
  try {
    const frame = await h.channel.sample(null);
    expect(h.channel.submit(frame, world(1).input).status).toBe("submitted");
    await settleChannel();
    expect(h.channel.snapshot()).toMatchObject({ fenced: true, retired: true, applied_sequence: 0, last_input: null });
    expect(h.channel.snapshot().reason).toContain("controller_submit");
    expect(h.channel.snapshot().reason).toContain("queued_frame_expired_before_application");
    expect(h.channel.snapshot().reason).toContain("frame_seq=1");
    await expect(h.channel.renew(frame)).rejects.toThrow(/queued_frame_expired_before_application/);
    expect(h.calls.filter(method => method === "controller_heartbeat")).toEqual([]);
    expect(h.applied).toEqual([]);
  } finally { clock.mockRestore(); }
});

test("heartbeat failure retains native expiry and decision-clock evidence without reviving the owner", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  h.request(async method => {
    if (method === "controller_heartbeat") throw new Error("Controller request rejected: native_input_lease_expired");
    return { ack: retirement(), generation: 4 };
  });
  try {
    const frame = await h.channel.sample(null);
    clock.mockReturnValue(20);
    await h.channel.renew(frame);
    await settleChannel();
    expect(h.channel.snapshot()).toMatchObject({ fenced: true, retired: true, submitted_sequence: 0, applied_sequence: 0 });
    expect(h.channel.snapshot().reason).toContain("controller_heartbeat");
    expect(h.channel.snapshot().reason).toContain("frame_seq=1");
    expect(h.channel.snapshot().reason).toContain("native_age_upper_ns=20000002");
    await expect(h.channel.renew(frame)).rejects.toThrow(/native_input_lease_expired/);
    expect(h.calls.filter(method => method === "controller_heartbeat")).toHaveLength(1);
    const replacement = nativeChannel("replacement-owner", 4);
    const fresh = await replacement.channel.sample(null);
    await replacement.channel.renew(fresh);
    expect(replacement.channel.submit(fresh, world(1).input).status).toBe("submitted");
    await settleChannel();
    expect(replacement.channel.snapshot()).toMatchObject({ fenced: false, applied_sequence: 1 });
    expect(h.channel.snapshot()).toMatchObject({ fenced: true, retired: true, submitted_sequence: 0 });
    await replacement.channel.revoke();
  } finally { clock.mockRestore(); }
});

test("fresh input dispatch does not wait for the ordered heartbeat response or fabricate application", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  const heartbeat = Promise.withResolvers<unknown>(), application = Promise.withResolvers<unknown>();
  let renewed = false, stopped = false;
  h.request(async method => {
    if (method === "controller_heartbeat") return await heartbeat.promise;
    if (method === "controller_submit") return await application.promise;
    return { ack: retirement(), generation: 4 };
  });
  try {
    const frame = await h.channel.sample(null);
    const renewal = h.channel.renew(frame).then(() => { renewed = true; });
    await settleChannel();
    expect(renewed).toBe(true);
    await renewal;
    clock.mockReturnValue(40);
    expect(h.channel.submit(frame, world(1).input).status).toBe("submitted");
    await settleChannel();
    expect(h.calls).toEqual(["controller_heartbeat", "controller_submit"]);
    expect(h.channel.snapshot()).toMatchObject({ submitted_sequence: 1, applied_sequence: 0, last_input: null });
    expect(h.applied).toEqual([]);

    // Even a successful heartbeat is not an input application ACK.
    heartbeat.resolve({}); await settleChannel();
    expect(h.channel.snapshot().applied_sequence).toBe(0);
    const stopping = h.channel.revoke().then(() => { stopped = true; });
    await settleChannel();
    expect(stopped).toBe(false);
    application.reject(new Error("Controller retired without confirmed application"));
    await stopping;
    expect(h.channel.snapshot()).toMatchObject({ retired: true, applied_sequence: 0, last_input: null });
  } finally {
    heartbeat.resolve({}); application.resolve(ack(1));
    await settleChannel(); clock.mockRestore();
  }
});

test.each([false, true])("retirement joins every out-of-order heartbeat response after its own ACK (failed=%s)", async failed => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  const heartbeats = Array.from({ length: 3 }, () => Promise.withResolvers<unknown>());
  let dispatched = 0;
  let stopped = false;
  h.request(async method => {
    if (method === "controller_heartbeat") return await heartbeats[dispatched++]!.promise;
    return { ack: retirement(), generation: 4 };
  });
  try {
    const frame = await h.channel.sample(null);
    for (let index = 0; index < 3; index++) await h.channel.renew(frame);
    await settleChannel();
    const stopping = h.channel.revoke().then(() => { stopped = true; });
    await settleChannel();
    expect(h.calls).toEqual([...Array(3).fill("controller_heartbeat"), "controller_revoke"]);
    expect(stopped).toBe(false);
    await expect(h.channel.renew(frame)).rejects.toThrow();
    heartbeats[2]!.resolve({});
    if (failed) heartbeats[0]!.reject(new Error("Controller request rejected: native_input_lease_expired"));
    else heartbeats[0]!.resolve({});
    await settleChannel();
    expect(stopped).toBe(false);
    expect(h.calls).toHaveLength(4);
    heartbeats[1]!.resolve({});
    await stopping;
    expect(h.channel.snapshot()).toMatchObject({ fenced: true, retired: true, applied_sequence: 0 });
    if (failed) expect(h.channel.snapshot().reason).toContain("native_input_lease_expired");
    expect(h.applied).toEqual([]);
  } finally { for (const heartbeat of heartbeats) heartbeat.resolve({}); await settleChannel(); clock.mockRestore(); }
});

test("fresh captures dispatch overlapping immutable leases without an oldest-response expiry fence", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  const heartbeats = Array.from({ length: 4 }, () => Promise.withResolvers<unknown>());
  const deadlines: string[] = [];
  h.request(async (method, params) => {
    if (method === "controller_heartbeat") {
      deadlines.push((params as { deadline_native_ns: string }).deadline_native_ns);
      return await heartbeats[deadlines.length - 1]!.promise;
    }
    return { ack: retirement(), generation: 4 };
  });
  try {
    const frame = await h.channel.sample(null);
    await h.channel.renew(frame);
    clock.mockReturnValue(100);
    await h.channel.renew(frame);
    const forged = structuredClone(h.frame); forged.captured_native_ns = "1100000000";
    await expect(h.channel.renew(forged)).rejects.toThrow(/actual host-retained/);
    clock.mockReturnValue(161);
    await expect(h.channel.renew(frame)).rejects.toThrow(/stale decision/);
    expect(h.calls).toEqual(["controller_heartbeat", "controller_heartbeat"]);

    // A new genuine capture writes a new lease despite both older held replies.
    h.frame.frame_seq = 2;
    h.frame.captured_native_ns = h.frame.inventory.captured_native_ns = "1161000000";
    const fresh = await h.channel.sample(null);
    await h.channel.renew(fresh);
    expect(deadlines.map(BigInt)).toEqual([1249999998n, 1349999998n, 1410999998n]);
    clock.mockReturnValue(250);
    await h.channel.renew(fresh);
    expect(h.calls).toEqual(Array(4).fill("controller_heartbeat"));
    expect(deadlines.map(BigInt)).toEqual([1249999998n, 1349999998n, 1410999998n, 1499999998n]);
    // Neither an out-of-order ACK nor an old success grants time at receipt.
    heartbeats[2]!.resolve({}); heartbeats[0]!.resolve({}); await settleChannel();
    clock.mockReturnValue(500);
    h.frame.frame_seq = 3;
    h.frame.captured_native_ns = h.frame.inventory.captured_native_ns = "1500000000";
    const expired = await h.channel.sample(null);
    await expect(h.channel.renew(expired)).rejects.toThrow(/latest dispatched lease deadline/);
    expect(h.channel.snapshot().fenced).toBe(true);
    expect(h.calls).toEqual([...Array(4).fill("controller_heartbeat"), "controller_revoke"]);
    for (const heartbeat of heartbeats) heartbeat.resolve({});
    await h.channel.revoke();
    expect(h.channel.snapshot().reason).toContain("lease deadline");
  } finally { for (const heartbeat of heartbeats) heartbeat.resolve({}); await settleChannel(); clock.mockRestore(); }
});

test("eight held heartbeat responses fail closed on overflow while retirement remains dispatchable", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  const heartbeats = Array.from({ length: 8 }, () => Promise.withResolvers<unknown>());
  let dispatched = 0, stopped = false;
  h.request(async method => {
    if (method === "controller_heartbeat") return await heartbeats[dispatched++]!.promise;
    return { ack: retirement(), generation: 4 };
  });
  try {
    const frame = await h.channel.sample(null);
    for (let index = 0; index < 8; index++) await h.channel.renew(frame);
    await expect(h.channel.renew(frame)).rejects.toThrow(/outstanding response bound/);
    expect(h.calls).toEqual([...Array(8).fill("controller_heartbeat"), "controller_revoke"]);
    expect(h.channel.snapshot().fenced).toBe(true);
    const stopping = h.channel.revoke().then(() => { stopped = true; });
    for (const heartbeat of heartbeats.slice(1)) heartbeat.resolve({});
    await settleChannel();
    expect(stopped).toBe(false);
    heartbeats[0]!.resolve({});
    await stopping;
    expect(h.channel.snapshot().retired).toBe(true);
  } finally { for (const heartbeat of heartbeats) heartbeat.resolve({}); await settleChannel(); clock.mockRestore(); }
});

test("overlapping heartbeat deadlines stay capped by the original root and late successes cannot revive it", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel("resident-owner", 3, 300);
  const heartbeat = Promise.withResolvers<unknown>(), deadlines: bigint[] = [];
  h.request(async (method, params) => {
    if (method === "controller_heartbeat") {
      deadlines.push(BigInt((params as { deadline_native_ns: string }).deadline_native_ns));
      return await heartbeat.promise;
    }
    return { ack: retirement(), generation: 4 };
  });
  try {
    await h.channel.renew(await h.channel.sample(null));
    clock.mockReturnValue(200);
    h.frame.frame_seq = 2;
    h.frame.captured_native_ns = h.frame.inventory.captured_native_ns = "1200000000";
    const frame = await h.channel.sample(null);
    await h.channel.renew(frame);
    expect(deadlines).toEqual([1249999998n, 1299999998n]);
    clock.mockReturnValue(300); heartbeat.resolve({}); await settleChannel();
    await expect(h.channel.renew(frame)).rejects.toThrow(/expired/);
    expect(h.channel.submit(frame, world(1).input).status).toBe("rejected");
    expect(h.calls.filter(method => method === "controller_heartbeat")).toHaveLength(2);
    await h.channel.revoke();
  } finally { heartbeat.resolve({}); await settleChannel(); clock.mockRestore(); }
});

test("an older rejected heartbeat fences dispatch despite a newer success and retirement joins the remaining response", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  const heartbeats = Array.from({ length: 3 }, () => Promise.withResolvers<unknown>());
  const retiring = Promise.withResolvers<unknown>();
  let dispatched = 0, stopped = false;
  h.request(async method => {
    if (method === "controller_heartbeat") return await heartbeats[dispatched++]!.promise;
    if (method === "controller_revoke") return await retiring.promise;
    throw new Error(`Unexpected native request: ${method}`);
  });
  try {
    const frame = await h.channel.sample(null);
    for (let index = 0; index < 3; index++) await h.channel.renew(frame);
    heartbeats[2]!.resolve({}); await settleChannel();
    heartbeats[0]!.reject(new Error("Controller request rejected: native_input_lease_expired"));
    await settleChannel();
    expect(h.channel.submit(frame, world(1).input)).toMatchObject({ status: "rejected" });
    await expect(h.channel.renew(frame)).rejects.toThrow(/native_input_lease_expired/);
    expect(h.calls).toEqual([...Array(3).fill("controller_heartbeat"), "controller_revoke"]);
    expect(h.channel.snapshot()).toMatchObject({ fenced: true, retired: false, submitted_sequence: 0, last_input: null });
    expect(h.channel.snapshot().reason).toContain("controller_heartbeat");
    retiring.resolve({ ack: retirement(), generation: 4 });
    const stopping = h.channel.revoke().then(() => { stopped = true; });
    await settleChannel();
    expect(stopped).toBe(false);
    heartbeats[1]!.resolve({});
    await stopping;
    expect(h.channel.snapshot().reason).toContain("native_input_lease_expired");
  } finally {
    for (const heartbeat of heartbeats) heartbeat.resolve({});
    retiring.resolve({ ack: retirement(), generation: 4 });
    await settleChannel(); clock.mockRestore();
  }
});

test("mechanical renewal joins the newest actual pending heartbeat instead of returning on an older ACK", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  const heartbeats = Array.from({ length: 3 }, () => Promise.withResolvers<unknown>());
  let dispatched = 0, settled = false;
  h.request(async method => {
    if (method === "controller_heartbeat") return await heartbeats[dispatched++]!.promise;
    return { ack: retirement(), generation: 4 };
  });
  try {
    const frame = await h.channel.sample(null);
    for (let index = 0; index < 3; index++) await h.channel.renew(frame);
    const renewal = h.channel.renew(null).then(() => { settled = true; });
    heartbeats[0]!.resolve({}); heartbeats[1]!.resolve({});
    await settleChannel();
    expect(settled).toBe(false);
    expect(dispatched).toBe(3);
    heartbeats[2]!.resolve({});
    await renewal;
    expect(settled).toBe(true);
    await h.channel.revoke();
  } finally { for (const heartbeat of heartbeats) heartbeat.resolve({}); await settleChannel(); clock.mockRestore(); }
});

test.each([false, true])("trusted mechanical renewal still awaits its actual heartbeat response (failed=%s)", async failed => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  const heartbeat = Promise.withResolvers<unknown>();
  let settled = false;
  h.request(async method => {
    if (method === "controller_heartbeat") return await heartbeat.promise;
    return { ack: retirement(), generation: 4 };
  });
  try {
    const renewal = h.channel.renew(null).then(() => { settled = true; return null; }, error => {
      settled = true; return error as Error;
    });
    await settleChannel();
    expect(settled).toBe(false);
    expect(h.calls).toEqual(["controller_heartbeat"]);
    if (failed) heartbeat.reject(new Error("Controller request rejected: native_input_lease_expired"));
    else heartbeat.resolve({});
    const error = await renewal;
    expect(settled).toBe(true);
    if (failed) {
      expect(error?.message).toContain("native_input_lease_expired");
      await h.channel.revoke();
    } else {
      expect(error).toBeNull();
      expect(h.channel.snapshot()).toMatchObject({ fenced: false, applied_sequence: 0 });
      await h.channel.revoke();
    }
  } finally { heartbeat.resolve({}); await settleChannel(); clock.mockRestore(); }
});

test("decision renewal refuses unretained, wrong-scope, stale and root-expired captures before heartbeat dispatch", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel();
  try {
    await expect(h.channel.renew(h.frame)).rejects.toThrow();
    const frame = await h.channel.sample(null);
    await expect(h.channel.renew({ ...h.frame, life_id: h.frame.life_id + 1 })).rejects.toThrow();
    clock.mockReturnValue(151);
    await expect(h.channel.renew(frame)).rejects.toThrow();
    clock.mockReturnValue(10000);
    await expect(h.channel.renew(frame)).rejects.toThrow();
    expect(h.calls).toEqual([]);
    expect(h.applied).toEqual([]);
    expect(h.channel.snapshot()).toMatchObject({ submitted_sequence: 0, applied_sequence: 0 });
  } finally { clock.mockRestore(); }
});

test("a delayed heartbeat cannot make the old decision fresh for submission or another renewal", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), h = nativeChannel(), heartbeat = Promise.withResolvers<unknown>();
  h.request(async method => {
    if (method === "controller_heartbeat") return await heartbeat.promise;
    return { ack: retirement(), generation: 4 };
  });
  try {
    const frame = await h.channel.sample(null);
    const renewal = h.channel.renew(frame);
    clock.mockReturnValue(161); heartbeat.resolve({});
    await renewal;
    const rejected = h.channel.submit(frame, world(1).input);
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toContain("stale_native_frame");
    expect(rejected.reason).toContain("native_age_upper_ns=161000002");
    await expect(h.channel.renew(frame)).rejects.toThrow(/stale decision/);
    expect(h.calls).toEqual(["controller_heartbeat"]);
    expect(h.channel.snapshot()).toMatchObject({ submitted_sequence: 0, applied_sequence: 0 });
    h.frame.frame_seq = 2; h.frame.native_tick = 11;
    h.frame.captured_native_ns = h.frame.inventory.captured_native_ns = "1161000000";
    const fresh = await h.channel.sample(null);
    h.request(async () => ({}));
    await h.channel.renew(fresh);
    expect(h.calls).toEqual(["controller_heartbeat", "controller_heartbeat"]);
    expect(h.channel.snapshot().fenced).toBe(false);
    expect(h.applied).toEqual([]);
  } finally { heartbeat.resolve({}); clock.mockRestore(); }
});
