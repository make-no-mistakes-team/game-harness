import path from "node:path";
import { NativeFixture, bounded, requireProof } from "../src/evaluation/native-game.ts";
import type { EvaluationCaps } from "../src/evaluation/contracts.ts";
import type { AdapterEvidence, GameAction, GameActionResult } from "../src/shared/contracts.ts";
import type { EffectEnvelope, VisibleScreenOperation, VisibleScreenSnapshot } from "../src/shared/control.ts";
import { visibleScreenSnapshotSchema } from "../src/shared/control.ts";
import { minecraftGuiTransactionFactSchema } from "../src/shared/minecraft.ts";
import { gameActionSchema } from "../src/shared/validation.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { runCoreVisibleGuiCase } from "./native-visible-gui-core.ts";
import { runCustomVisibleGuiCase } from "./native-visible-gui-custom.ts";
import { runVisibleGuiRace } from "./native-visible-gui-races.ts";

export const VISIBLE_GUI_CASES = ["chest", "crafting", "batch-crafting", "recipe-book", "furnace", "merchant", "anvil",
  "stonecutter", "loom", "enchanting", "beacon", "worker-api", "local-races", "modifiers", "resize", "replacement", "receipt-timing", "lost-receipt"] as const;
export type VisibleGuiCase = (typeof VISIBLE_GUI_CASES)[number];
export interface VisibleGuiEffect {
  action: GameAction; envelope: EffectEnvelope; result: GameActionResult; facts: readonly AdapterEvidence[];
}
export interface VisibleGuiHarness {
  fixture: NativeFixture;
  caps: EvaluationCaps;
  signal: AbortSignal;
  effects: VisibleGuiEffect[];
  read(): Promise<VisibleScreenSnapshot>;
  maybeRead(): Promise<VisibleScreenSnapshot | null>;
  setup(commands: string[]): Promise<string>;
  block(name: string): Promise<GameActionResult>;
  inventory(): Promise<GameActionResult>;
  apply(view: VisibleScreenSnapshot, operations: VisibleScreenOperation[], signal?: AbortSignal): Promise<GameActionResult>;
  slot(id: number, button?: "left" | "right", mode?: "ordinary" | "shift" | "hotbar", hotbar?: number | null): Promise<GameActionResult>;
  click(id: string): Promise<GameActionResult>;
  close(): Promise<GameActionResult>;
  server(condition: string, label: string): Promise<{ label: string; condition: string; marker: string; output: string }>;
  production(from: number, producer: "crafting" | "smelting" | "trading" | "anvil", item: string, count: number): void;
  afterNativeClose(close: () => void | Promise<void>): void;
  stopRecording(entry: Record<string, unknown>, key: string): Promise<EpisodeRecorder>;
  startRecording(suffix: string): void;
}

/** Pure selection only; debug subsets never replace the complete acceptance set. */
export function selectVisibleGuiCases(selection: string | undefined): readonly VisibleGuiCase[] {
  if (selection === undefined) return VISIBLE_GUI_CASES;
  const names = selection.split(",");
  requireProof(names.length > 0 && new Set(names).size === names.length &&
    names.every(name => VISIBLE_GUI_CASES.some(known => known === name)), "Pass distinct supported visible-gui stage names");
  return VISIBLE_GUI_CASES.filter(name => names.includes(name));
}

/** Explicit fixture choice over current visible player slots, not a production/game policy. */
export function visiblePlayerSlots(view: VisibleScreenSnapshot) {
  const first = view.screen_kind === "inventory" ? 9 : view.slots.length - 36;
  const last = view.screen_kind === "inventory" ? 45 : view.slots.length;
  return view.slots.filter(slot => slot.slot_id >= first && slot.slot_id < last && slot.enabled);
}

/** Privileged vanilla-GUI conformance, never actor source, retrieval or experience. */
export async function runNativeVisibleGuiFixture(project: string, caps: EvaluationCaps, selected: readonly VisibleGuiCase[]) {
  const fixture = await NativeFixture.create("native-visible-gui", { projectRoot: project, caps });
  let failure: unknown, recorder: EpisodeRecorder | undefined;
  const scope = new AbortController(), pending = new Set<Promise<GameActionResult>>();
  const afterNativeClose: Array<() => void | Promise<void>> = [];
  const effects: VisibleGuiEffect[] = [];
  const stop = (reason: string) => {
    failure ??= new Error(reason); scope.abort(failure);
    void fixture.close().catch(error => { failure ??= error; });
  };
  const interrupt = () => stop("Visible GUI proof interrupted");
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const deadline = setTimeout(() => stop("Visible GUI entire-process deadline"), caps.totalMs);
  fixture.report.classification = "Privileged evaluator-authored native visible-GUI conformance; no autonomous/model competence claim";
  fixture.report.actual_provider_calls = 0; fixture.report.actual_jev_calls = 0;
  fixture.report.selected_stages = selected; fixture.report.all_declared_stages = VISIBLE_GUI_CASES;
  fixture.report.full_stage_set = selected.length === VISIBLE_GUI_CASES.length;
  fixture.report.opening_assistance = "Disclosed semantic interaction only opens a selected freshly observed block/entity; GUI choices are explicit fixture operations";
  fixture.report.effects = effects;
  let activeEffects = 0, peakEffects = 0;
  const open = () => requireProof(!scope.signal.aborted, "Visible GUI fixture authority closed");
  const track = (result: Promise<GameActionResult>) => {
    pending.add(result); void result.then(() => pending.delete(result), () => pending.delete(result)); return result;
  };
  const maybeRead = async () => visibleScreenSnapshotSchema.nullable().parse(
    await fixture.bridge.queryCapability("minecraft.visible_screen", 1, {}));
  const read = async (): Promise<VisibleScreenSnapshot> => {
    const result = await maybeRead(); requireProof(result, "Expected an actual currently rendered vanilla GUI"); return result;
  };
  const apply = (view: VisibleScreenSnapshot, operations: VisibleScreenOperation[], signal = scope.signal) => track(fixture.action(
    gameActionSchema.parse({ kind: "screen_input", screen: view.identity, operations }), 6000 + 4000 * operations.length, signal));
  const slot = async (id: number, button: "left" | "right" = "left", mode: "ordinary" | "shift" | "hotbar" = "ordinary", hotbar: number | null = null) => {
    const view = await read(), source = view.slots.find(value => value.slot_id === id);
    requireProof(source?.enabled, "Chosen source is not a current visible enabled slot");
    const result = await apply(view, [{ kind: "slot", slot_id: id, button, mode, hotbar_slot: hotbar,
      expected_cursor: view.cursor, expected_slots: [{ slot_id: id, value: source.value }] }]);
    requireProof(result.status === "succeeded", `Actual ordinary slot operation failed: ${result.summary}`);
    return result;
  };
  const click = async (id: string) => {
    const view = await read();
    requireProof(view.elements.some(element => element.element_id === id && element.enabled), "Chosen element is not current visible/enabled");
    const result = await apply(view, [{ kind: "element", element_id: id, button: "left" }]);
    requireProof(result.status === "succeeded", `Actual visible element operation failed: ${result.summary}`); return result;
  };
  const close = async () => {
    const result = await apply(await read(), [{ kind: "close" }]);
    requireProof(result.status === "succeeded" && await maybeRead() === null, "Explicit vanilla close did not settle with absent GUI"); return result;
  };
  const block = async (name: string) => {
    const observed = await fixture.observe();
    const target = observed.data.blocks.find(value => value.current && value.name === name &&
      Math.floor(value.position.x) === 0 && Math.floor(value.position.y) === 240 && Math.floor(value.position.z) === 2);
    requireProof(target, "Prepared selected block was not in the authorized observation");
    const result = await track(fixture.action({ kind: "interact", target: target.target }, 12_000, scope.signal));
    requireProof(result.status === "succeeded", "Selected visible-block opening did not complete"); return result;
  };
  const server = async (condition: string, label: string) => {
    const marker = `ghgui_${crypto.randomUUID().replaceAll("-", "")}`;
    const output = await fixture.console([`execute ${condition} run say ${marker}`]);
    requireProof(output.includes(marker), `Independent server consequence missing: ${label}`); return { label, condition, marker, output };
  };
  const startRecording = (suffix: string) => {
    requireProof(!recorder, "Previous GUI evidence recorder must drain before a new segment");
    recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, suffix), bridge: fixture.bridge,
      identity: { episode_id: crypto.randomUUID(), run_id: crypto.randomUUID(), world_id: fixture.bridge.snapshot().world_id!,
        session_id: fixture.bridge.snapshot().session_id! },
      limits: { maxDurationMs: 90_000, maxFrames: 3000, maxStoredFrameBytes: 1024 ** 3 }, onIncomplete: stop });
  };
  const stopRecording = async (entry: Record<string, unknown>, key: string) => {
    requireProof(recorder, "Expected an active original-speed recorder"); const current = recorder;
    recorder = undefined;
    const recording = await current.finish({ endedAt: Date.now(), reason: key }); entry[key] = recording;
    requireProof(recording.status === "complete", "Visible GUI evidence incomplete"); return current;
  };
  const context: VisibleGuiHarness = { fixture, caps, signal: scope.signal, effects, read, maybeRead, apply, slot, click, close, block, server,
    setup: commands => fixture.console(commands), afterNativeClose: callback => { afterNativeClose.push(callback); }, startRecording, stopRecording,
    inventory: () => track(fixture.action(gameActionSchema.parse({ kind: "world_input", steps: [{ ticks: 1,
      held: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, attack: false, use: false },
      edges: [{ kind: "button", button: "inventory", phase: "press", count: 1 }], view: { kind: "unchanged" }, selected_hotbar: null }] }), 10_000, scope.signal)),
    production: (from, producer, item, count) => {
      let actual = 0;
      for (const effect of effects.slice(from)) for (const fact of effect.facts) {
        const parsed = minecraftGuiTransactionFactSchema.safeParse(fact.data);
        if (!parsed.success) continue;
        for (const output of parsed.data.productions)
          if (output.production_confirmed && output.producer === producer && output.item === item) actual += output.count;
      }
      requireProof(actual === count, `Registered authoritative GUI producer expected ${count} ${item}, observed ${actual}`);
    },
  };
  try {
    await fixture.start(); open();
    const execute = fixture.bridge.execute.bind(fixture.bridge);
    fixture.bridge.execute = async (envelope, signal) => {
      if (effects.length >= 1024) throw new Error("GUI effect evidence bound exceeded");
      activeEffects++; peakEffects = Math.max(peakEffects, activeEffects);
      try {
        const result = await execute(envelope, signal), action = gameActionSchema.parse(envelope.action);
        const adapter = fixture.bridge.adapter(); requireProof(adapter, "Actual GUI adapter disappeared");
        const facts = adapter.effectEvidence?.(envelope.scope, envelope.operation_id, action, result, new Date().toISOString()) ?? [];
        effects.push({ envelope, action, result, facts }); return result;
      } finally { activeEffects--; }
    };
    for (const stage of selected) {
      await fixture.case(`visible_gui_${stage}`, { evaluator_authored: true, model_inference: false,
        privileged_setup_and_server_checks: true, original_speed_recording: true }, async entry => {
        open();
        if (await maybeRead() !== null) entry.preparation_close = await close();
        await fixture.flat();
        await fixture.console(["clear @a", "effect clear @a", "tp @e[tag=gh_gui_trade] 0 -60 0", "kill @e[tag=gh_gui_trade]",
          "kill @e[type=minecraft:item]", "experience set @a 0 levels"]);
        const effectStart = effects.length;
        startRecording(stage);
        if (["chest", "crafting", "batch-crafting", "recipe-book", "furnace", "merchant", "anvil", "worker-api"].includes(stage))
          await runCoreVisibleGuiCase(stage, entry, context);
        else if (["stonecutter", "loom", "enchanting", "beacon"].includes(stage))
          await runCustomVisibleGuiCase(stage, entry, context);
        else await runVisibleGuiRace(stage, entry, context);
        open(); entry.effects = effects.slice(effectStart);
        entry.frame = await fixture.frame(`visible-gui-${stage}`);
        const recording = await stopRecording(entry, "recording");
        entry.replay = await recording.renderReplay({ signal: scope.signal });
        const diagnostics = await fixture.diagnostics(); entry.native_after = diagnostics;
        requireProof(activeEffects === 0 && peakEffects === 1 && diagnostics.controls_neutral && !diagnostics.motor_active &&
          (diagnostics.visible_gui === null || diagnostics.visible_gui === undefined), "GUI case left a foreground writer or unconfirmed input drain");
      });
      requireProof(fixture.cases.at(-1)?.status === "passed", `Visible GUI ${stage} failed; later stages cannot hide it`);
    }
    requireProof(fixture.cases.length === selected.length && fixture.cases.every(entry => entry.status === "passed"), "Requested GUI stages were not all exercised");
  } catch (error) { failure ??= error; }
  finally {
    clearTimeout(deadline); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (failure) { scope.abort(failure); try { await fixture.close(); } catch (error) { failure ??= error; } }
    if (pending.size) {
      try { await bounded(Promise.allSettled([...pending]), caps.cleanupMs, "GUI effect cleanup did not drain"); }
      catch (error) { failure ??= error; }
    }
    if (recorder) {
      try { fixture.report.interrupted_recording = await recorder.finish({ endedAt: Date.now(), reason: "visible_gui_failed" }); }
      catch (error) { failure ??= error; }
    }
    try { await fixture.close(); } catch (error) { failure ??= error; }
    for (const close of afterNativeClose) try { await close(); } catch (error) { failure ??= error; }
    fixture.report.peak_simultaneous_effects = peakEffects;
    await fixture.finish(failure);
  }
  return fixture;
}
