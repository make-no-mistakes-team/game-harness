import { expect, test } from "bun:test";
import type { ExpectedEffectOwner, WorldHeld, WorldInputEdge } from "../src/shared/control.ts";
import { controllerInputFrameSchema, controllerInputSchema, inputAppliedAckSchema, inputSubmissionSchema,
  residentFrameContextSchema, revocationAckSchema,
  type ControllerInputFrame, type InputAppliedAck, type RevocationAck } from "../src/shared/controller.ts";
import { ControllerInputs } from "../src/server/controller-inputs.ts";

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
