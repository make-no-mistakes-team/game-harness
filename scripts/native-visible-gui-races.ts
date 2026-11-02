import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { encodeNativeFramePng } from "../src/server/actor-frames.ts";
import { HOST_MONOTONIC_CLOCK_ID } from "../src/server/performance.ts";
import { decodeNativeVideoHeader } from "../src/shared/video.ts";
import type { VisibleScreenOperation, VisibleScreenSnapshot } from "../src/shared/control.ts";
import type { GameActionResult } from "../src/shared/contracts.ts";
import { evidence, pause, requireProof, until } from "../src/evaluation/native-game.ts";
import { ownedWindowInput } from "../src/evaluation/owned-window-input.ts";
import type { VisibleGuiCase, VisibleGuiHarness } from "./native-visible-gui.ts";
import { visiblePlayerSlots } from "./native-visible-gui.ts";

const activeGuiSchema = z.looseObject({ active: z.literal(true), operation_index: z.number().int().nonnegative(),
  phase: z.string(), held: z.boolean(), applied_prefix: z.number().int().nonnegative(), mutation_count: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(), receipt_nonce: z.number().int().nonnegative() });
function slotOperation(view: VisibleScreenSnapshot, id: number): VisibleScreenOperation {
  const source = view.slots.find(slot => slot.slot_id === id); requireProof(source, "Chosen visible race slot disappeared");
  return { kind: "slot", slot_id: id, button: "left", mode: "ordinary", hotbar_slot: null,
    expected_cursor: view.cursor, expected_slots: [{ slot_id: id, value: source.value }] };
}
async function held(ctx: VisibleGuiHarness) {
  const deadline = performance.now() + 4000;
  let latest: unknown;
  while (performance.now() < deadline) {
    const raw = await ctx.fixture.diagnostics(); latest = raw.visible_gui;
    const parsed = activeGuiSchema.safeParse(latest);
    if (parsed.success && parsed.data.held && parsed.data.phase === "pressed") return parsed.data;
    await pause(0);
  }
  throw new Error(`GUI perturbation never reached actual held phase: ${JSON.stringify(latest)}`);
}
function noInput(result: GameActionResult) {
  const native = evidence(result);
  requireProof(result.status === "failed" && native.world_effect_emitted === false && native.mutation_count === 0 && native.applied_prefix === 0,
    "Conflicting local assumption was not rejected before input");
}

/** Bounded delivered-frame tap across a dimension change; writes occur only after the critical input. */
function resizeFrames(ctx: VisibleGuiHarness) {
  const frames: Array<{ packet: Uint8Array; received_at_ms: number; received_monotonic_ms: number }> = [];
  let bytes = 0, omitted = 0;
  const unsubscribe = ctx.fixture.bridge.subscribeFrames(packet => {
    if (frames.length === 96 || bytes + packet.byteLength > 256 * 1024 ** 2) { omitted++; return; }
    bytes += packet.byteLength;
    frames.push({ packet, received_at_ms: Date.now(), received_monotonic_ms: performance.now() });
  });
  return { stop: unsubscribe, async save() {
    requireProof(omitted === 0, "Resize evidence tap exhausted its declared 96-frame/256MiB bound");
    const directory = path.join(ctx.fixture.evidenceDirectory, "resize-transition");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const rows = [];
    let first: bigint | null = null;
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]!, header = decodeNativeVideoHeader(frame.packet);
      requireProof(header, "Resize evidence contains an invalid native packet");
      const native = BigInt(header.capture.readback_started_ns); first ??= native;
      const name = String(index).padStart(4, "0");
      await writeFile(path.join(directory, `${name}.ghv2`), frame.packet, { mode: 0o600, flag: "wx" });
      const image = await encodeNativeFramePng(frame.packet, frame.received_at_ms);
      await writeFile(path.join(directory, `${name}.png`), image.png, { mode: 0o600, flag: "wx" });
      rows.push({ frame: `${name}.png`, raw: `${name}.ghv2`, sequence: header.sequence, width: header.width, height: header.height,
        captured_at_ms: header.capturedAt, relative_native_ms: Number(native - first) / 1e6,
        received_at_ms: frame.received_at_ms, received_monotonic_ms: frame.received_monotonic_ms,
        host_clock_id: HOST_MONOTONIC_CLOCK_ID, capture: header.capture });
    }
    await writeFile(path.join(directory, "frames.json"), JSON.stringify({ rows, omitted, bytes,
      timing: "Relative native monotonic readback time; host receipts remain separate", audio: "not_recorded",
      presentation: "Original delivered packets and opaque native RGB, dimensions preserved; no synthetic resize reconstruction" }, null, 2), { mode: 0o600, flag: "wx" });
    return { directory, rows, omitted, bytes };
  } };
}

export async function runVisibleGuiRace(stage: VisibleGuiCase, entry: Record<string, unknown>, ctx: VisibleGuiHarness) {
  if (stage === "local-races") {
    await ctx.setup(["setblock 0 240 2 minecraft:furnace", "item replace entity @a inventory.0 with minecraft:iron_ore 4"]);
    await ctx.block("furnace");
    const old = await ctx.read(), source = visiblePlayerSlots(old).find(slot => slot.value.item === "iron_ore");
    requireProof(source, "Prepared local source was not visible"); entry.before_noise = old;
    await ctx.setup(["item replace block 0 240 2 container.2 with minecraft:iron_ingot 1"]);
    const changed = await until(ctx.read, view => view.slots.find(slot => slot.slot_id === 2)?.value.item === "iron_ingot",
      ctx.caps.observationMs, "Unrelated furnace-output update was not visible");
    requireProof(changed.content_revision !== old.content_revision && changed.identity.layout_revision === old.identity.layout_revision,
      "Unrelated output update was relabelled as layout replacement");
    entry.noise = changed;
    entry.unrelated_output_result = await ctx.apply(old, [slotOperation(old, source.slot_id)]);
    requireProof(entry.unrelated_output_result && typeof entry.unrelated_output_result === "object" &&
      "status" in entry.unrelated_output_result && entry.unrelated_output_result.status === "succeeded",
      "Unrelated output blocked a locally satisfied source/cursor operation");
    requireProof((await ctx.read()).cursor.count === 4, "Accepted local pickup did not preserve actual cursor custody");
    await ctx.slot(source.slot_id);
    const beforeSource = await ctx.read();
    await ctx.setup(["item replace entity @a inventory.0 with minecraft:iron_ore 5"]);
    await until(ctx.read, view => view.slots.find(slot => slot.slot_id === source.slot_id)?.value.count === 5,
      ctx.caps.observationMs, "Conflicting source update was not observed");
    const sourceResult = await ctx.apply(beforeSource, [slotOperation(beforeSource, source.slot_id)]);
    entry.source_conflict = sourceResult; noInput(sourceResult);
    const beforeCursor = await ctx.read(), destination = visiblePlayerSlots(beforeCursor).find(slot => slot.value.item === null);
    requireProof(destination, "No visible empty target for cursor conflict");
    await ctx.slot(source.slot_id);
    const cursorResult = await ctx.apply(beforeCursor, [slotOperation(beforeCursor, destination.slot_id)]);
    entry.cursor_conflict = cursorResult; noInput(cursorResult);
    const custody = await ctx.read(); entry.custody = custody;
    requireProof(custody.cursor.item === "iron_ore" && custody.cursor.count === 5 &&
      custody.slots.find(slot => slot.slot_id === destination.slot_id)?.value.item === null,
      "Rejected cursor conflict altered real custody");
    await ctx.slot(source.slot_id); await ctx.close();
    entry.server = await ctx.server('if data entity @a[limit=1] Inventory[{Slot:9b,id:"minecraft:iron_ore",count:5}]', "source/cursor conflict preserved five ore");
    entry.production_claim = "Injected output is unproven noise, never credited as smelting";
    return;
  }
  if (stage === "modifiers") {
    await ctx.setup(["item replace entity @a inventory.0 with minecraft:stone 8", "item replace entity @a inventory.1 with minecraft:dirt 3"]);
    await ctx.inventory(); let view = await ctx.read();
    const source = visiblePlayerSlots(view).find(slot => slot.value.item === "stone"); requireProof(source, "Prepared shift source absent");
    entry.shift = await ctx.slot(source.slot_id, "left", "shift"); view = await ctx.read();
    requireProof(view.slots.find(slot => slot.slot_id === source.slot_id)?.value.item === null &&
      view.slots.some(slot => slot.slot_id >= 36 && slot.slot_id <= 44 && slot.value.item === "stone" && slot.value.count === 8),
      "Shift did not use ordinary inventory-to-hotbar routing");
    const dirt = visiblePlayerSlots(view).find(slot => slot.value.item === "dirt"); requireProof(dirt, "Prepared hotbar-swap source absent");
    entry.hotbar = await ctx.slot(dirt.slot_id, "left", "hotbar", 0);
    entry.server_swap = await ctx.server('if data entity @a[limit=1] Inventory[{Slot:0b,id:"minecraft:dirt",count:3}]', "normal hotbar swap reached server slot zero");
    const physical = ownedWindowInput(ctx.fixture.ownedClient().child.pid!);
    const before = await ctx.fixture.diagnostics(); entry.native_before_physical = before;
    try {
      physical.press();
      const current = await ctx.read(), selected = current.slots.find(slot => slot.slot_id === 36);
      requireProof(selected?.value.item === "dirt" && selected.value.count === 3, "Expected actual selected hotbar dirt");
      entry.physical_pickup = await ctx.slot(36);
      const carried = await ctx.read(); entry.physical_custody = carried;
      requireProof(carried.cursor.item === "dirt" && carried.cursor.count === 3,
        "Physical Control/buttons changed ordinary authored GUI pickup semantics");
      const after = await ctx.fixture.diagnostics(); entry.native_during_physical = after;
      requireProof(after.owned_window_glfw_control_pressed === true && after.game_forward_poll_pressed === false &&
        typeof before.blocked_keyboard_callbacks === "number" && typeof after.blocked_keyboard_callbacks === "number" &&
        after.blocked_keyboard_callbacks >= before.blocked_keyboard_callbacks + 2,
        "Physical GUI negative probe did not reach actual suppression boundary");
      await ctx.slot(36);
    } finally { physical.release(); }
    entry.escape = await ctx.apply(await ctx.read(), [{ kind: "key", key: "escape", phase: "press" }]);
    requireProof((entry.escape as GameActionResult).status === "succeeded" && await ctx.maybeRead() === null,
      "Ordinary Escape did not close the actual inventory");
    entry.server_conservation = await ctx.server('if data entity @a[limit=1] Inventory[{Slot:10b,id:"minecraft:stone",count:8}]', "swap preserved eight stone");
    return;
  }
  if (stage === "resize") {
    await ctx.setup(["item replace entity @a inventory.0 with minecraft:oak_planks 4"]);
    await ctx.inventory(); const old = await ctx.read(), source = visiblePlayerSlots(old).find(slot => slot.value.item === "oak_planks");
    requireProof(source, "Prepared resize source absent");
    const packet = ctx.fixture.bridge.latestFrame(), dimensions = packet ? decodeNativeVideoHeader(packet) : null;
    requireProof(dimensions, "Actual native dimensions unavailable");
    const probe = ownedWindowInput(ctx.fixture.ownedClient().child.pid!);
    const tap = resizeFrames(ctx);
    const beforeRecording = await ctx.stopRecording(entry, "recording_before_resize");
    let restored = false;
    try {
      const result = ctx.apply(old, [slotOperation(old, source.slot_id)]);
      entry.held_before_resize = await held(ctx);
      probe.resize(1024, 640);
      const settled = await result; entry.result = settled;
      const current = await ctx.read(); entry.resized_screen = current;
      const native = evidence(settled), gestures = native.pointer_gestures;
      requireProof(current.identity.screen_id === old.identity.screen_id && current.identity.layout_revision !== old.identity.layout_revision &&
        settled.status === "unknown" && native.neutralized === true && Array.isArray(gestures) &&
        gestures.every(gesture => gesture !== null && typeof gesture === "object" && !Array.isArray(gesture) && gesture.released !== true),
        "Resize did not fence the actual held old-layout release");
      entry.resized_frame = await ctx.fixture.frame("visible-gui-resized");
      probe.resize(dimensions.width, dimensions.height); restored = true;
      await until(async () => {
        const frame = ctx.fixture.bridge.latestFrame(); return frame ? decodeNativeVideoHeader(frame) : null;
      }, header => header?.width === dimensions.width && header.height === dimensions.height,
      ctx.caps.observationMs, "Original owned framebuffer dimensions did not return");
      ctx.startRecording("resize_restored");
    } finally {
      if (!restored) probe.resize(dimensions.width, dimensions.height);
      tap.stop();
      const capture = await tap.save(); entry.transition_capture = capture;
      requireProof(capture.rows.some(row => row.width === dimensions.width && row.height === dimensions.height) &&
        capture.rows.some(row => row.width === 1024 && row.height === 640),
        "Delivered native frame evidence did not bridge both actual framebuffer dimensions");
    }
    entry.before_replay = await beforeRecording.renderReplay({ signal: ctx.signal });
    await ctx.close();
    return;
  }
  if (stage === "replacement") {
    await ctx.setup(["setblock 0 240 2 minecraft:chest", 'item replace block 0 240 2 container.0 with minecraft:cobblestone 4']);
    await ctx.block("chest"); const old = await ctx.read();
    const result = ctx.apply(old, [slotOperation(old, 0)]);
    entry.held_before_replacement = await held(ctx);
    await ctx.setup(["setblock 0 240 2 minecraft:furnace"]);
    const settled = await result; entry.result = settled;
    const state = await ctx.maybeRead(); entry.after = state;
    const native = evidence(settled), gestures = native.pointer_gestures;
    requireProof(settled.status === "unknown" && native.neutralized === true &&
      (state === null || state.identity.screen_id !== old.identity.screen_id || state.identity.incarnation !== old.identity.incarnation) &&
      Array.isArray(gestures) && gestures.every(gesture => gesture !== null && typeof gesture === "object" && !Array.isArray(gesture) && gesture.released !== true),
      "Replacement did not fence the old handler's held release");
    entry.server = await ctx.server("if block 0 240 2 minecraft:furnace", "replacement remains actual furnace");
    return;
  }
  if (stage === "lost-receipt") {
    await ctx.setup(["setblock 0 240 2 minecraft:chest", 'item replace block 0 240 2 container.0 with minecraft:cobblestone 4']);
    await ctx.block("chest"); const old = await ctx.read();
    const start = ctx.effects.length, result = ctx.apply(old, [slotOperation(old, 0)]);
    entry.held_before_stall = await held(ctx);
    const settled = await ctx.fixture.suspendedServer(async () => await result); entry.result = settled;
    const native = evidence(settled);
    requireProof(settled.status === "unknown" && native.world_effect_emitted === true && native.neutralized === true &&
      Array.isArray(native.gui_transactions) && native.gui_transactions.length === 0,
      "Missing finish ACK invented a confirmed transaction or safe no-effect result");
    requireProof(ctx.effects.slice(start).filter(effect => effect.action.kind === "screen_input").length === 1,
      "Uncertain GUI input was automatically retried");
    const unknown = JSON.stringify(settled);
    entry.after = await ctx.read();
    const carried = await ctx.read(), destination = visiblePlayerSlots(carried).find(slot => slot.value.item === null);
    requireProof(carried.cursor.item === "cobblestone" && carried.cursor.count === 4 && destination,
      "Late server progress did not reconcile actual carried custody");
    entry.fresh_retention = await ctx.slot(destination.slot_id);
    requireProof(JSON.stringify(settled) === unknown, "Late ACK upgraded the previous unknown result");
    await ctx.close();
    entry.server = await ctx.server('if data entity @a[limit=1] Inventory[{id:"minecraft:cobblestone",count:4}] unless data block 0 240 2 Items[{Slot:0b}]',
      "Fresh distinct retention after late ACK conserved the once-taken four cobblestone");
    entry.claim = "One emitted input, missing ACK retained unknown, server resumed in finally, no replay or inferred production";
    return;
  }
  if (stage === "receipt-timing") {
    await ctx.setup(["setblock 0 240 2 minecraft:chest", 'item replace block 0 240 2 container.0 with minecraft:cobblestone 4']);
    await ctx.block("chest"); const old = await ctx.read();
    let completed = false;
    const result = ctx.apply(old, [slotOperation(old, 0)]).then(value => { completed = true; return value; });
    entry.held_before_delay = await held(ctx);
    const started = performance.now();
    await ctx.fixture.suspendedServer(async () => {
      await pause(600);
      requireProof(!completed, "Delayed-receipt fixture did not actually hold a pending native completion");
    });
    entry.server_suspended_ms = performance.now() - started;
    const settled = await result; entry.result = settled;
    const native = evidence(settled);
    requireProof(settled.status === "succeeded" && Array.isArray(native.gui_transactions) && native.gui_transactions.length === 1,
      "Delayed within-deadline server ACK did not confirm exactly one actual transaction");
    const view = await ctx.read(), destination = visiblePlayerSlots(view).find(slot => slot.value.item === null);
    requireProof(view.cursor.item === "cobblestone" && view.cursor.count === 4 && destination,
      "Delayed single take did not preserve four cobblestone in carried custody");
    await ctx.slot(destination.slot_id); await ctx.close();
    entry.server = await ctx.server('if data entity @a[limit=1] Inventory[{id:"minecraft:cobblestone",count:4}] unless data block 0 240 2 Items[{Slot:0b}]',
      "Delayed ACK confirmed a single take, not duplicate inventory");
    return;
  }
  throw new Error(`No visible-GUI race implementation for ${stage}`);
}
