import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvaluationCaps } from "../src/evaluation/contracts.ts";
import { NativeFixture, bounded, pause, requireProof, until } from "../src/evaluation/native-game.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { ActionArbiter } from "../src/server/action-arbiter.ts";
import { minecraftControllerFrameSchema, type MinecraftControllerFrame } from "../src/shared/minecraft.ts";
import type { ControllerEffectUpdate, ControllerInput, ControllerInputChannel, InputAppliedAck, RevocationAck } from "../src/shared/controller.ts";
import type { WorldHeld } from "../src/shared/control.ts";

const neutral: WorldHeld = { forward: false, back: false, left: false, right: false, jump: false,
  sprint: false, sneak: false, attack: false, use: false };
const world = (held: WorldHeld = neutral, edges: Extract<ControllerInput, { kind: "world" }>["edges"] = [],
  view: Extract<ControllerInput, { kind: "world" }>["view"] = { kind: "unchanged" }, selected_hotbar: number | null = null): ControllerInput =>
  ({ kind: "world", held, edges, view, selected_hotbar });

/** Privileged deterministic conformance. No learned control, provider calls or smoothness/competence claim. */
export async function runNativeControllerStreamFixture(project: string, caps: EvaluationCaps) {
  const fixture = await NativeFixture.create("native-controller-stream", { projectRoot: project, caps });
  const source = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
  const scope = new AbortController();
  let failure: unknown, recorder: EpisodeRecorder | undefined;
  const stop = (reason: string) => { failure ??= new Error(reason); scope.abort(failure); void fixture.close().catch(error => { failure ??= error; }); };
  const interrupt = () => stop("Native stream proof interrupted");
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const deadline = setTimeout(() => stop("Native stream entire-process deadline"), caps.totalMs);
  fixture.report.actual_provider_calls = 0; fixture.report.actual_jev_calls = 0;
  fixture.report.classification = "Actual bounded native input/retirement conformance; evaluator-authored, not acquired skills or model competence";
  const run = async (name: string, work: (entry: Record<string, unknown>) => Promise<void>) => {
    await fixture.case(name, { evaluator_authored: true, privileged_setup: true, model_inference: false }, work);
    requireProof(fixture.cases.at(-1)?.status === "passed", `Native stream ${name} failed; later cases cannot hide it`);
  };
  const read = async (channel: ControllerInputChannel): Promise<MinecraftControllerFrame> =>
    minecraftControllerFrameSchema.parse(await channel.sample(null));
  const send = async (channel: ControllerInputChannel, input: ControllerInput, frame?: MinecraftControllerFrame) => {
    const captured = frame ?? await read(channel), submission = channel.submit(captured, input);
    requireProof(submission.status !== "rejected", `Fresh authored native input refused: ${submission.reason}`);
    const applicationWaitMs = input.kind === "screen" ? Math.min(20_000, 5000 + 4000 * input.operations.length) : caps.diagnosticsMs;
    const state = await until(async () => channel.snapshot(), value => value.applied_sequence >= submission.sequence || value.fenced,
      applicationWaitMs, "Actual native application ACK never arrived");
    requireProof(state.last_input?.sequence === submission.sequence && state.last_input.input_application === "confirmed",
      `Input admission did not become confirmed actual application: ${JSON.stringify(state)}`);
    return { captured, submission, ack: state.last_input, native_application_age_ms:
      Number(BigInt(state.last_input.applied_native_ns) - BigInt(captured.captured_native_ns)) / 1e6 };
  };
  const owned = async <T>(entry: Record<string, unknown>, work: (channel: ControllerInputChannel, effects: ControllerEffectUpdate[],
    stopRenewals: () => Promise<void>) => Promise<T>, renewal = true): Promise<T> => {
    const acks: InputAppliedAck[] = [], effects: ControllerEffectUpdate[] = [];
    entry.application_acks = acks; entry.later_effect_receipts = effects;
    return await fixture.withController(source, 20_000, ack => acks.push(ack), effect => effects.push(effect), async channel => {
      let running = true, renewalFailure: unknown;
      const renewals = renewal ? (async () => {
        while (running && !scope.signal.aborted) {
          await pause(80);
          if (!running || channel.snapshot().fenced) break;
          try { await channel.renew(null); } catch (error) { renewalFailure = error; break; }
        }
      })() : Promise.resolve();
      const stopRenewals = async () => {
        running = false;
        await renewals;
        if (renewalFailure) throw renewalFailure;
      };
      try {
        const result = await work(channel, effects, stopRenewals);
        if (renewalFailure) throw renewalFailure;
        return result;
      } finally {
        running = false;
        await renewals;
        entry.final_input_state = channel.snapshot();
      }
    });
  };
  try {
    await fixture.start(); await fixture.flat();
    recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, "stream"), bridge: fixture.bridge,
      identity: { episode_id: crypto.randomUUID(), run_id: crypto.randomUUID(), world_id: fixture.bridge.snapshot().world_id!,
        session_id: fixture.bridge.snapshot().session_id! },
      limits: { maxDurationMs: 180_000, maxFrames: 6000, maxStoredFrameBytes: 2 * 1024 ** 3 }, onIncomplete: stop });
    await run("held_movement_view_and_actual_application", async entry => {
      await owned(entry, async channel => {
        const before = await read(channel);
        entry.press = await send(channel, world({ ...neutral, forward: true }, [
          { kind: "button", button: "forward", phase: "press", count: 1 },
        ], { kind: "rate", yaw_radians_per_second: .2, pitch_radians_per_second: 0 }));
        await pause(150);
        entry.held = await send(channel, world({ ...neutral, forward: true }));
        await pause(150);
        entry.release = await send(channel, world(neutral, [{ kind: "button", button: "forward", phase: "release", count: 1 }]));
        const after = await read(channel);
        requireProof(Math.hypot(after.player.position.x - before.player.position.x, after.player.position.z - before.player.position.z) > .1,
          "Confirmed stream consumption did not cause independently observed ordinary movement");
        requireProof(channel.snapshot().ordered_edge_prefix === 2 && !channel.snapshot().last_input?.held.forward,
          "Submitted held snapshot lost its later ordered release");
        entry.before = before; entry.after = after; entry.frame = await fixture.frame("stream-movement");
      });
    });
    await run("held_bow_turn_without_release_repress", async entry => {
      await fixture.flat(); await fixture.console(["clear @a", "item replace entity @a hotbar.0 with minecraft:bow", "give @a minecraft:arrow 2"]);
      await owned(entry, async channel => {
        entry.start = await send(channel, world({ ...neutral, use: true }, [{ kind: "button", button: "use", phase: "press", count: 1 }],
          { kind: "delta", yaw_radians: 0, pitch_radians: .4 }, 0));
        const uses: MinecraftControllerFrame[] = [];
        for (let index = 0; index < 7; index++) {
          await pause(150);
          await send(channel, world({ ...neutral, use: true }, [], { kind: "delta", yaw_radians: .03, pitch_radians: 0 }));
          uses.push(await read(channel));
        }
        requireProof(uses.every(frame => frame.player.active_use?.item === "bow") &&
          uses.at(-1)!.player.active_use!.elapsed_ticks > uses[0]!.player.active_use!.elapsed_ticks + 10,
        "New ordinary held snapshots restarted or released the bow instead of preserving vanilla use");
        entry.held_use_frames = uses;
        entry.release = await send(channel, world(neutral, [{ kind: "button", button: "use", phase: "release", count: 1 }]));
        requireProof((await read(channel)).player.active_use === null, "Explicit stream release did not clear actual bow use");
        const marker = `stream_arrow_${crypto.randomUUID().replaceAll("-", "")}`;
        entry.independent_server_arrow = await fixture.console([`execute if entity @e[type=minecraft:arrow] run say ${marker}`]);
        requireProof(String(entry.independent_server_arrow).includes(marker), "Actual streamed bow release produced no independent server projectile witness");
      });
    });
    await run("ordered_selection_drop_and_server_retention", async entry => {
      await fixture.flat(); await fixture.console(["clear @a", "item replace entity @a hotbar.2 with minecraft:cobblestone 7"]);
      await owned(entry, async channel => {
        entry.application = await send(channel, world(neutral, [{ kind: "hotbar", slot: 2 }, { kind: "drop", all: false }],
          { kind: "unchanged" }, 2));
        const marker = `stream_drop_${crypto.randomUUID().replaceAll("-", "")}`;
        entry.independent_server = await fixture.console([`execute if data entity @a[limit=1] Inventory[{Slot:2b,id:"minecraft:cobblestone",count:6}] run say ${marker}`]);
        requireProof(String(entry.independent_server).includes(marker) && channel.snapshot().ordered_edge_prefix === 2,
          "Consumed hotbar/drop did not retain exactly six server-side source items");
      });
    });
    await run("visible_gui_application_and_later_receipt", async entry => {
      await fixture.flat(); await fixture.console(["clear @a", "item replace entity @a hotbar.0 with minecraft:oak_planks 4"]);
      await owned(entry, async (channel, effects) => {
        entry.open = await send(channel, world(neutral, [
          { kind: "button", button: "inventory", phase: "press", count: 1 },
          { kind: "button", button: "inventory", phase: "release", count: 1 },
        ]));
        const take = await read(channel), screen = take.screen;
        requireProof(screen, "Streamed ordinary inventory edge did not preserve a visible handler");
        const sourceSlot = screen.slots.find(slot => slot.slot_id === 36);
        requireProof(sourceSlot?.value.item === "oak_planks" && sourceSlot.value.count === 4, "Actual own visible source absent");
        entry.pickup = await send(channel, { kind: "screen", screen: screen.identity, operations: [{
          kind: "slot", slot_id: 36, button: "left", mode: "ordinary", hotbar_slot: null,
          expected_cursor: screen.cursor, expected_slots: [{ slot_id: 36, value: sourceSlot.value }],
        }] }, take);
        await until(async () => effects, values => values.length >= 1,
          caps.observationMs, "Actual GUI application ACK had no later receipt");
        const carried = await read(channel), visible = carried.screen;
        requireProof(visible && visible.cursor.item === "oak_planks" && visible.cursor.count === 4, "Actual carried custody was lost");
        const target = visible.slots.find(slot => slot.slot_id === 37);
        requireProof(target?.value.item === null, "Actual visible destination is not empty");
        entry.place = await send(channel, { kind: "screen", screen: visible.identity, operations: [{
          kind: "slot", slot_id: 37, button: "left", mode: "ordinary", hotbar_slot: null,
          expected_cursor: visible.cursor, expected_slots: [{ slot_id: 37, value: target.value }],
        }] }, carried);
        await until(async () => effects, values => values.length >= 2,
          caps.observationMs, "Second actual GUI receipt did not settle");
        const current = await read(channel); requireProof(current.screen, "GUI closed implicitly after transfer");
        entry.close = await send(channel, { kind: "screen", screen: current.screen.identity, operations: [{ kind: "close" }] }, current);
        const marker = `stream_gui_${crypto.randomUUID().replaceAll("-", "")}`;
        entry.independent_server = await fixture.console([`execute if data entity @a[limit=1] Inventory[{Slot:1b,id:"minecraft:oak_planks",count:4}] run say ${marker}`]);
        requireProof(String(entry.independent_server).includes(marker), "Application-only GUI result did not retain actual server destination");
        requireProof(effects.slice(0, 2).every(effect => effect.result.status === "succeeded"), "Actual transfer receipts remain unconfirmed");
        entry.frame = await fixture.frame("stream-gui");
      });
    });
    await run("gui_retirement_drains_applied_pending_receipt", async entry => {
      await fixture.flat(); await fixture.console(["clear @a", "item replace entity @a hotbar.0 with minecraft:oak_planks 4"]);
      await owned(entry, async (channel, effects, stopRenewals) => {
        await send(channel, world(neutral, [
          { kind: "button", button: "inventory", phase: "press", count: 1 },
          { kind: "button", button: "inventory", phase: "release", count: 1 },
        ]));
        const captured = await read(channel), screen = captured.screen;
        requireProof(screen, "Retirement fixture has no actual visible handler");
        const sourceSlot = screen.slots.find(slot => slot.slot_id === 36);
        requireProof(sourceSlot?.value.item === "oak_planks" && sourceSlot.value.count === 4, "Retirement fixture has no actual source");
        const submission = channel.submit(captured, { kind: "screen", screen: screen.identity, operations: [{
          kind: "slot", slot_id: 36, button: "left", mode: "ordinary", hotbar_slot: null,
          expected_cursor: screen.cursor, expected_slots: [{ slot_id: 36, value: sourceSlot.value }],
        }] });
        requireProof(submission.status === "submitted", "GUI retirement fixture did not admit its gesture");
        await until(() => fixture.diagnostics(), value => {
          const gui = value.visible_gui;
          return gui !== null && typeof gui === "object" && "phase" in gui && (gui.phase === "travel" || gui.phase === "pressed");
        }, caps.diagnosticsMs, "GUI retirement fixture never passed actual server ARM into pointer travel");
        await fixture.suspendedServer(async () => {
          const applied = await until(async () => channel.snapshot(), value => value.applied_sequence === submission.sequence,
            caps.diagnosticsMs, "Actual GUI input did not apply while its later server receipt was stopped");
          entry.applied_before_retirement = applied;
          requireProof(applied.last_input?.input_application === "confirmed" && effects.length === 0,
            "Fixture did not hold confirmed GUI application apart from an unresolved server receipt");
          await stopRenewals();
          const ack = await channel.revoke(); entry.retirement = ack;
          const terminal = effects.find(effect => effect.sequence === submission.sequence);
          requireProof(terminal?.result.status === "unknown" &&
            BigInt(terminal.recorded_native_ns) <= BigInt(ack.retirement_applied_native_ns),
          "Native retirement acknowledged before draining the old applied GUI driver and retaining its uncertain receipt");
          const diagnostics = await fixture.diagnostics(); entry.after_retirement = diagnostics;
          requireProof(diagnostics.visible_gui === null && diagnostics.controls_neutral,
            "Retired GUI pointer/receipt owner still owns native input");
          const arbiter = ActionArbiter.current(fixture.bridge);
          requireProof(arbiter, "Retirement fixture lost its sole arbiter");
          const replacement = await arbiter.reserveController(channel.owner.scope.execution_id, channel.controllerGeneration + 1,
            performance.now() + 5000, () => {}, () => {});
          try { entry.fresh_replacement_frame = await read(replacement); }
          finally { entry.replacement_retirement = await replacement.revoke(); }
          requireProof(fixture.bridge.snapshot().status === "connected", "Old GUI cleanup destroyed a freshly admitted native owner");
        });
      });
      const current = minecraftControllerFrameSchema.parse(await fixture.bridge.queryCapability("minecraft.controller_frame", 2, { audio_cursor: null }));
      requireProof(current.screen, "Retirement implicitly closed the visible handler or rolled back cursor custody");
      entry.explicit_close = await fixture.action({ kind: "screen_input", screen: current.screen.identity, operations: [{ kind: "close" }] });
    });
    await run("movement_samples_do_not_duplicate_ordered_presses", async entry => {
      const variants: Record<string, unknown>[] = []; entry.variants = variants;
      for (const [name, edges, prefix] of [
        ["split", [{ kind: "button", button: "forward", phase: "press", count: 1 },
          { kind: "button", button: "forward", phase: "press", count: 1 }], 1],
        ["counted", [{ kind: "button", button: "forward", phase: "press", count: 2 }], 1],
        ["release-repress", [{ kind: "button", button: "forward", phase: "press", count: 1 },
          { kind: "button", button: "forward", phase: "release", count: 1 },
          { kind: "button", button: "forward", phase: "press", count: 1 }], 2],
      ] as const) {
        await fixture.flat();
        const variant: Record<string, unknown> = { name }; variants.push(variant);
        await owned(variant, async channel => {
          const frame = await read(channel), submission = channel.submit(frame, world({ ...neutral, forward: true }, [...edges]));
          requireProof(submission.status === "submitted", "Valid repeated movement input was silently rejected instead of truthfully applied");
          const state = await until(async () => channel.snapshot(), value => value.last_input !== null, caps.diagnosticsMs, "No actual movement-sample ACK");
          variant.actual = state;
          requireProof(state.last_input?.input_application === "partial" && state.ordered_edge_prefix === prefix,
            "One actual movement sample fabricated multiple ordered presses or discarded its consumed sub-prefix");
          variant.retirement = await channel.revoke();
        }, false);
      }
    });
    await run("partial_counted_inventory_preserves_consumed_prefix", async entry => {
      await fixture.flat();
      await owned(entry, async channel => {
        const frame = await read(channel), submission = channel.submit(frame, world(neutral, [
          { kind: "button", button: "inventory", phase: "press", count: 3 },
        ]));
        requireProof(submission.status === "submitted", "Counted inventory application was not admitted");
        const state = await until(async () => channel.snapshot(), value => value.last_input !== null, caps.diagnosticsMs, "No counted inventory ACK");
        entry.application = state;
        requireProof(state.last_input?.input_application === "partial" && state.ordered_edge_prefix === 1,
          "The first actual inventory press was lost or its cleared queued suffix was falsely confirmed");
        const ack = await channel.revoke(); entry.retirement = ack;
        requireProof(ack.ordered_edge_prefix === 1, "Actual retirement forgot the consumed counted sub-prefix");
      }, false);
      const current = minecraftControllerFrameSchema.parse(await fixture.bridge.queryCapability("minecraft.controller_frame", 2, { audio_cursor: null }));
      requireProof(current.screen, "First counted inventory press did not actually open the visible handler");
      entry.explicit_close = await fixture.action({ kind: "screen_input", screen: current.screen.identity, operations: [{ kind: "close" }] });
    });
    await run("sixteen_operation_gui_keeps_its_actual_application_deadline", async entry => {
      await fixture.flat(); await fixture.console(["clear @a", "item replace entity @a hotbar.0 with minecraft:oak_planks 4"]);
      await owned(entry, async (channel, effects) => {
        await send(channel, world(neutral, [
          { kind: "button", button: "inventory", phase: "press", count: 1 },
          { kind: "button", button: "inventory", phase: "release", count: 1 },
        ]));
        let captured = await read(channel), expectedPrefix = 2;
        requireProof(captured.screen, "Long GUI sequence has no visible handler");
        if (captured.screen.elements.some(element => element.kind === "recipe" || element.kind === "text")) {
          const toggle = captured.screen.elements.find(element => element.enabled && element.text === "recipe_book_toggle");
          requireProof(toggle, "Open recipe book has no actual visible toggle");
          const closedBook = await send(channel, { kind: "screen", screen: captured.screen.identity,
            operations: [{ kind: "element", element_id: toggle.element_id, button: "left" }] }, captured);
          await until(async () => effects, values => values.some(value => value.sequence === closedBook.submission.sequence),
            caps.observationMs, "Actual recipe-book gesture receipt did not settle");
          captured = await read(channel); expectedPrefix++;
        }
        const screen = captured.screen;
        requireProof(screen && screen.cursor.item === null, "Long GUI sequence lost empty cursor custody");
        const sourceSlot = screen.slots.find(slot => slot.slot_id === 36), destination = screen.slots.find(slot => slot.slot_id === 37);
        requireProof(sourceSlot?.value.item === "oak_planks" && sourceSlot.value.count === 4 && destination?.value.item === null,
          "Long GUI sequence lacks its actual visible source/destination");
        const operations = Array.from({ length: 16 }, (_, index) => {
          const half = index % 4, slot_id = half === 0 || half === 3 ? 36 : 37;
          return { kind: "slot" as const, slot_id, button: "left" as const, mode: "ordinary" as const, hotbar_slot: null,
            expected_cursor: half % 2 === 0 ? screen.cursor : sourceSlot.value,
            expected_slots: [{ slot_id, value: half % 2 === 0 ? sourceSlot.value : destination.value }] };
        });
        const result = await send(channel, { kind: "screen", screen: screen.identity, operations }, captured);
        entry.application = result;
        requireProof(result.native_application_age_ms > 2000 && result.ack.ordered_edge_prefix === expectedPrefix + 16,
          "The sixteen genuine GUI operations were truncated or never exercised the longer lawful deadline");
        const receipt = await until(async () => effects.find(value => value.sequence === result.submission.sequence),
          value => value !== undefined, caps.observationMs, "Long GUI sequence has no actual final server receipt");
        requireProof(receipt?.result.status === "succeeded", "Sixteen input applications were falsely substituted for confirmed receipt settlement");
        entry.final_receipt = receipt;
        const current = await read(channel); requireProof(current.screen, "Long GUI sequence implicitly closed its handler");
        entry.close = await send(channel, { kind: "screen", screen: current.screen.identity, operations: [{ kind: "close" }] }, current);
        const marker = `stream_long_gui_${crypto.randomUUID().replaceAll("-", "")}`;
        entry.server_retention = await fixture.console([`execute if data entity @a[limit=1] Inventory[{Slot:0b,id:"minecraft:oak_planks",count:4}] run say ${marker}`]);
        requireProof(String(entry.server_retention).includes(marker), "Long GUI sequence lost or duplicated server-side source custody");
      });
    });
    await run("stale_scene_rejected_without_replay", async entry => {
      await fixture.flat();
      await owned(entry, async channel => {
        const stale = await read(channel); await pause(200);
        const refused = channel.submit(stale, world({ ...neutral, attack: true }, [{ kind: "button", button: "attack", phase: "press", count: 1 }]));
        entry.refused = refused;
        requireProof(refused.status === "rejected" && channel.snapshot().submitted_sequence === 0 && channel.snapshot().ordered_edge_prefix === 0,
          "Stale authored press was relabelled fresh, allocated or applied");
        entry.fresh = await send(channel, world());
      });
    });
    await run("native_stall_reserved_retirement_no_press_burst", async entry => {
      await fixture.flat();
      await owned(entry, async channel => {
        entry.press = await send(channel, world({ ...neutral, forward: true }, [{ kind: "button", button: "forward", phase: "press", count: 1 }]));
        const frame = await read(channel), pings: Promise<unknown>[] = [];
        let retirement: Promise<RevocationAck> | undefined, settled = false;
        const started = performance.now();
        await fixture.suspendedClient(async () => {
          const submission = channel.submit(frame, world({ ...neutral, attack: true }, [
            { kind: "button", button: "forward", phase: "release", count: 1 },
            { kind: "button", button: "attack", phase: "press", count: 1 },
          ]));
          requireProof(submission.status === "submitted", "Stall fixture did not really admit an unacknowledged press");
          const drainedMicrotasks = Promise.withResolvers<void>();
          setImmediate(drainedMicrotasks.resolve);
          await drainedMicrotasks.promise;
          for (let index = 0; index < 16; index++) pings.push(Reflect.get(fixture.bridge, "request").call(fixture.bridge, "ping", {}, 2000).catch(() => null));
          entry.submitted_before_retirement = channel.snapshot();
          retirement = channel.revoke().then(ack => { settled = true; return ack; });
          await pause(600);
          requireProof(!settled, "Native-stalled retirement was falsely acknowledged before physical application");
          entry.host_hold_ms_before_resume = performance.now() - started;
        });
        requireProof(retirement, "Reserved retirement was never submitted");
        const ack = await retirement; await Promise.all(pings); entry.retirement = ack;
        entry.actual_retirement_after_capture_ms = Number(BigInt(ack.retirement_applied_native_ns) - BigInt(frame.captured_native_ns)) / 1e6;
        requireProof(ack.last_applied_sequence === 1 && ack.ordered_edge_prefix === 1 &&
          Number(entry.actual_retirement_after_capture_ms) >= 550 && channel.snapshot().applied_sequence === 1,
        "Late native resume applied stale press backlog, replayed an edge or invented timely release");
        const diagnostics = await fixture.diagnostics(); entry.native_after_resume = diagnostics;
        requireProof(diagnostics.controls_neutral, "Actual resumed native thread did not neutralize held inputs");
      }, false);
    });
    await run("native_lease_expiry_actual_retirement", async entry => {
      await fixture.flat();
      await owned(entry, async channel => {
        entry.press = await send(channel, world({ ...neutral, forward: true }, [{ kind: "button", button: "forward", phase: "press", count: 1 }]));
        await pause(400);
        const diagnostics = await fixture.diagnostics(); entry.after_expiry = diagnostics;
        requireProof(diagnostics.controls_neutral, "Expired native lease retained actual movement keys");
        const ack = await channel.revoke(); entry.retirement = ack;
        requireProof(ack.last_applied_sequence === 1 && ack.ordered_edge_prefix === 1,
          "Mechanical expiry invented a later input or consumed edge");
      }, false);
    });
    fixture.report.performance = fixture.bridge.performanceMetrics();
    fixture.report.frame = await fixture.frame("stream-final");
  } catch (error) { failure ??= error; }
  finally {
    clearTimeout(deadline); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (failure) { scope.abort(failure); try { await fixture.close(); } catch (error) { failure ??= error; } }
    if (recorder) try {
      const recording = await recorder.finish({ endedAt: Date.now(), reason: failure ? "stream_failed" : "stream_completed" });
      fixture.report.recording = recording;
      if (!failure) {
        requireProof(recording.status === "complete", "Native stream footage is incomplete");
        fixture.report.replay = await recorder.renderReplay({ signal: scope.signal });
      }
    } catch (error) { failure ??= error; }
    try { await bounded(fixture.close(), caps.cleanupMs, "Stream native cleanup did not drain"); } catch (error) { failure ??= error; }
    await fixture.finish(failure);
  }
  return fixture;
}
