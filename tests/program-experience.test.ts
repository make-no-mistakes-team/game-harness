import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameAction, GameActionResult, Json } from "../src/shared/contracts.ts";
import type { MinecraftObservation } from "../src/shared/minecraft.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import type { SkillExecutionView, SkillRef } from "../src/shared/programs.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { SkillManager } from "../src/server/skills.ts";
import {
  HISTORICAL_PROGRAM_COMPATIBILITY_V3,
  ExperienceLibrary,
  type PromotionDeclaration,
} from "../src/server/experience.ts";
import { programEvidence } from "../src/server/program-evidence.ts";
import { ExecutionTrace } from "../src/server/execution-trace.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { dispatchHistoryQuery } from "../src/server/history-dispatch.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { readImprovementFeedback } from "../src/server/program-feedback.ts";
import { compareProgramVersions, compareProgramVersionsPage } from "../src/server/program-comparison.ts";
import { objectiveMetrics } from "../src/server/objective-metrics.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { emptyRunUsage, recordCall, recordUsage } from "../src/server/usage.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import { observationEvidence } from "../src/server/adapter-evidence.ts";
import { promotionEvidence } from "../web/src/evidence.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding, sha256 } from "./helpers/adapter-contract.ts";
import { retainResidentReceipt } from "../src/server/resident-evidence.ts";
import { DEFAULT_RESIDENT_LIMITS } from "../src/shared/resident.ts";
import type { ControllerInput, ControllerEffectUpdate } from "../src/shared/controller.ts";

const adapter = minecraftTestAdapter();
const currentCompatibility = { descriptor: adapter.descriptor, compatibility_hash: sha256(adapter.descriptor) };
const customGoal = adapter.goals.find(goal => goal.goal_id === "custom")!;
const resources: {
  directory: string;
  store: Store;
  library: ExperienceLibrary;
  reader?: HistoryReader;
}[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const resource of resources.splice(0)) {
    try {
      try {
        await resource.reader?.close();
      } finally {
        try { resource.library.close(); }
        finally {
          try { resource.store.close(); }
          finally { rmSync(resource.directory, { recursive: true, force: true }); }
        }
      }
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Experience fixture cleanup failed");
});
function learningFixture(store: Store): ImprovementLearning {
  const resource = resources.find((value) => value.store === store)!;
  resource.reader ??= new HistoryReader(store.readLocation());
  return new ImprovementLearning(store, resource.reader);
}
function preparationOptions() {
  return { deadlineHostMs: performance.now() + 30_000 };
}
const card = {
  purpose: "Measure a declared inventory predicate",
  applicability: "Current authorized observations",
  method: "Resolve targets from fresh observations",
  reason: "Retain verified execution evidence",
  limitations: "No stored world observations or call stack",
};
function observation(run: StoredRun): MinecraftObservation {
  return minecraftObservationFixture(adapter, { world_id: run.world_id, epoch: run.epoch,
    session_id: run.session_id!, life: { life_id: run.life_id!, status: "alive", can_respawn: false, death: null },
    observation_seq: 1, captured_at: new Date().toISOString(),
    native_boot_id: run.native_boot_id!, space: { dimension_id: "minecraft:overworld", space_epoch: run.space_epoch! },
  });
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-experience-"));
  const store = new Store(join(directory, "runs")),
    library = new ExperienceLibrary(
      join(directory, "library"),
      currentCompatibility,
    );
  const run = minecraftRunFixture(adapter, {
    world_id: crypto.randomUUID(),
    epoch: 1,
    session_id: crypto.randomUUID(),
    life_id: 1,
    task: "Measure current inventory",
    model_id: "fixture-model",
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    turns: 0,
    model_status: "idle",
    error: null,
  });
  run.baseline = adapter.captureBaseline(customGoal, observation(run));
  store.saveRun(run);
  store.event(
    run.run_id,
    "run.adapter",
    "Explicit native descriptor fixture",
    jsonSchema.parse(currentCompatibility),
  );
  const manager = new SkillManager(
    store,
    {
      runSkill: async () => ({
        status: "completed",
        summary: "Fixture",
        result: null,
      }),
    },
    {
      authorize: () => {},
      adapter: () => adapter, binding: () => minecraftTestBinding(adapter),
      observe: async () => observation(run),
      action: async () => ({
        status: "unknown",
        summary: "Not called",
        evidence: null,
      }),
      queryCapability: async () => null,
      cancelActions: async () => {},
      changed: () => {},
      unsafe: () => {},
      recover: async () => { throw new Error("Fixture does not authorize respawn"); },
    },
  );
  resources.push({ directory, store, library });
  return { directory, store, library, run, manager };
}
async function authored(
  manager: SkillManager,
  run: StoredRun,
  name = "fixture",
  dependencies: SkillRef[] = [],
) {
  return await manager.register(run.run_id, { entry: "run",
    name,
    source:
      'const state = await game.observe(); return {status:"completed",summary:"Current observation",result:state.data.player.position.x};',
    card,
    dependencies,
  });
}
function execution(
  store: Store,
  run: StoredRun,
  skill: SkillRef,
): SkillExecutionView {
  const view = store.admitSkill(run.run_id, { entry: "run",
    skill_id: skill.skill_id,
    version: skill.version,
    start_key: crypto.randomUUID(),
    ...executionScopeFixture(run),
    args: { world_specific: { x: 123, y: 64, z: 456 } },
    limits: { ...DEFAULT_SKILL_LIMITS },
  }).view;
  view.status = "running";
  view.started_at = new Date(Date.now() - 1000).toISOString();
  store.updateSkillExecution(
    view,
    "skill.running",
    "Trusted fixture dispatched",
  );
  return view;
}
function finish(store: Store, view: SkillExecutionView) {
  view.status = "succeeded";
  view.result = {
    status: "completed",
    summary: "Program self-report",
    result: null,
  };
  view.ended_at = new Date().toISOString();
  store.updateSkillExecution(view, "skill.closed", "Trusted fixture closed");
}
function action(
  store: Store,
  run: StoredRun,
  owner: SkillExecutionView,
  evidence: Json,
  request: GameAction = { kind: "look", yaw: 0, pitch: 0 },
) {
  const admitted = store.admitAction(
    run.run_id,
    crypto.randomUUID(),
    request,
    "skill",
    owner.execution_id,
    actionAuthority(run, owner),
  );
  const result: GameActionResult = {
    status: "succeeded",
    summary: "Trusted action result",
    evidence,
  };
  admitted.action.view.status = "succeeded";
  admitted.action.view.result = result;
  admitted.action.view.ended_at = new Date().toISOString();
  store.saveAction(run.run_id, admitted.action.view);
  return admitted.action.view;
}
function actionAuthority(run: StoredRun, owner: SkillExecutionView) {
  return { scope: { run_id: run.run_id, world_id: run.world_id, epoch: owner.epoch, session_id: owner.session_id!, native_boot_id: owner.native_boot_id!,
    run_generation: owner.run_generation!, life_id: owner.life_id!, space_epoch: owner.space_epoch!, execution_id: owner.execution_id, source_hash: owner.source_hash! },
    invocation: { kind: "skill" as const, execution_id: owner.execution_id, source_hash: owner.source_hash! }, compatibility_hash: run.compatibility_hash! };
}
function inventoryObservation(store: Store, run: StoredRun, counts: Record<string, number>) {
  const current = observation(run);
  current.observation_seq = 2;
  current.data.player.inventory = Object.entries(counts).map(([name, count], slot) => ({ name, display_name: name, count, slot }));
  const evidence = observationEvidence(adapter, { run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!, epoch: run.epoch,
    native_boot_id: run.native_boot_id!, run_generation: 1, life_id: run.life_id!, space_epoch: run.space_epoch! }, current);
  return store.event(run.run_id, "adapter.evidence", "Current registered own inventory observation fixture", jsonSchema.parse(evidence));
}
function declaration(
  event_seq: number,
  portability: "portable" | "world_local" = "portable",
): PromotionDeclaration {
  return {
    portability,
    retained_world_data: false,
    predicate: {
      kind: "inventory_gain",
      item: "stone",
      min_gain: 2,
      event_seq,
    },
  };
}

test("self-report and confirmed movement do not qualify as verified inventory effectiveness", async () => {
  const { store, library, run, manager } = fixture();
  const skill = await authored(manager, run),
    view = execution(store, run, skill);
  action(store, run, view, {
    effect_confirmed: true,
    inventory_before: { stone: 0 },
    inventory_after: { stone: 0 },
  });
  const evidence = inventoryObservation(store, run, { stone: 2 });
  finish(store, view);
  expect(() =>
    library.promote(
      store,
      run.run_id,
      view,
      "Unproven",
      declaration(evidence.event_seq),
    ),
  ).toThrow();
  const measured = programEvidence(store, run.run_id)[0]!;
  expect(measured.evidence_status).toBe("confirmed_effects");
  expect(measured.confirmed_effects).toBe(1);
  expect(measured.verified_event_seqs).toEqual([]);
});

for (const producer of ["crafting", "trading", "anvil"] as const) {
  test(`craft qualification attributes GUI ${producer} through actual production rather than transferred possession`, async () => {
    const { store, library, run, manager } = fixture();
    run.goal = adapter.goals.find(goal => goal.goal_id === "craft_crafting_table")!; store.saveRun(run);
    const owner = execution(store, run, await authored(manager, run));
    const gui = action(store, run, owner, { effect_confirmed: true, gui_transactions: [{
      kind: "gui_transaction", mechanism: "visible_gui", operation_index: 0, receipt_ref: "server:1:9",
      input_application: "confirmed", effect_status: "confirmed", inventory_before: {}, inventory_after: {},
      productions: [{ producer, item: "crafting_table", count: 1, source: "server_result_slot_take", production_confirmed: true }],
    }] }, { kind: "screen_input", screen: { screen_id: "view", incarnation: 1, layout_revision: 1 },
      operations: [{ kind: "slot", slot_id: 0, button: "left", mode: "ordinary", hotbar_slot: null,
        expected_cursor: { item: null, count: 0 }, expected_slots: [{ slot_id: 0, value: { item: "crafting_table", count: 1 } }] }] });
    const event = store.event(run.run_id, "goal.verified", "Trusted verifier fixture", {
      status: "verified", adapter_id: run.goal.adapter_id, verifier_id: run.goal.verifier!.id, verifier_version: run.goal.verifier!.version,
    });
    finish(store, owner);
    const promote = () => library.promote(store, run.run_id, owner, "Confirmed GUI crafting", {
      portability: "portable", retained_world_data: false, predicate: { kind: "goal_verified", event_seq: event.event_seq },
    });
    if (producer === "crafting") expect(promote().evidence.action_ids).toEqual([gui.action_id]);
    else expect(promote).toThrow();
  });
}

for (const validReceipt of [true, false]) {
  test(`craft-sequence qualification ${validReceipt ? "credits confirmed stages" : "rejects mismatched stage quantities"}`, async () => {
    const { store, library, run, manager } = fixture();
    run.goal = adapter.goals.find(goal => goal.goal_id === "craft_crafting_table")!; store.saveRun(run);
    const owner = execution(store, run, await authored(manager, run));
    const stage = (stage_index: number, item: string, executions: number, output_per_execution: number,
      inventory_before: Record<string, number>, inventory_after: Record<string, number>) => ({
      stage_index, item, executions, output_per_execution, completed_executions: executions, confirmed_executions: executions,
      status: "succeeded", inventory_receipt_confirmed: true, inventory_custody_confirmed: true,
      cursor_count: 0, grid_count: 0, receipt_ref: `server:craft:${stage_index}`, inventory_before, inventory_after,
    });
    const crafted = action(store, run, owner, { effect_confirmed: true, inventory_receipt_confirmed: true,
      inventory_before: { oak_log: 2 }, inventory_after: { oak_planks: 4, crafting_table: 1 },
      craft_stages: [
        stage(0, "oak_planks", 2, 4, { oak_log: 2 }, { oak_planks: 8 }),
        stage(1, "crafting_table", 1, 1, { oak_planks: 8 }, { oak_planks: 4, crafting_table: validReceipt ? 1 : 2 }),
      ] }, { kind: "craft", sequence: [{ item: "oak_planks", executions: 2 }, { item: "crafting_table", executions: 1 }] });
    const event = store.event(run.run_id, "goal.verified", "Trusted verifier fixture", {
      status: "verified", adapter_id: run.goal.adapter_id, verifier_id: run.goal.verifier!.id, verifier_version: run.goal.verifier!.version,
    });
    finish(store, owner);
    const promote = () => library.promote(store, run.run_id, owner, "Confirmed recipe sequence", {
      portability: "portable", retained_world_data: false, predicate: { kind: "goal_verified", event_seq: event.event_seq },
    });
    if (validReceipt) expect(promote().evidence.action_ids).toEqual([crafted.action_id]);
    else expect(promote).toThrow();
  });
}

test("confirmed GUI transfer qualifies inventory gain without being relabelled as helper production", async () => {
  const { store, library, run, manager } = fixture(), owner = execution(store, run, await authored(manager, run));
  const transfer = action(store, run, owner, { effect_confirmed: true, gui_transactions: [{
    kind: "gui_transaction", mechanism: "visible_gui", operation_index: 0, receipt_ref: "server:1:10",
    input_application: "confirmed", effect_status: "confirmed", inventory_before: {}, inventory_after: { stone: 2 }, productions: [],
  }] }, { kind: "screen_input", screen: { screen_id: "view", incarnation: 1, layout_revision: 1 },
    operations: [{ kind: "slot", slot_id: 0, button: "left", mode: "ordinary", hotbar_slot: null,
      expected_cursor: { item: null, count: 0 }, expected_slots: [{ slot_id: 0, value: { item: "stone", count: 2 } }] }] });
  const observed = inventoryObservation(store, run, { stone: 2 }); finish(store, owner);
  expect(library.promote(store, run.run_id, owner, "Visible transfer", declaration(observed.event_seq)).evidence.action_ids).toEqual([transfer.action_id]);
  expect(objectiveMetrics(store, run.run_id)[0]).toMatchObject({ inventory_delta: { stone: 2 }, inventory_receipts: 1 });
});

for (const retained of ["matching", "tampered", "missing"] as const) {
  test(`retained GUI crafting ${retained} receipt links only actual server-confirmed production`, async () => {
    const { store, run, manager } = fixture();
    run.goal = adapter.goals.find(goal => goal.goal_id === "craft_crafting_table")!; store.saveRun(run);
    const owner = execution(store, run, await authored(manager, run));
    const request: GameAction = { kind: "screen_input", screen: { screen_id: "view", incarnation: 1, layout_revision: 1 },
      operations: [{ kind: "slot", slot_id: 0, button: "left", mode: "ordinary", hotbar_slot: null,
        expected_cursor: { item: null, count: 0 }, expected_slots: [{ slot_id: 0, value: { item: "crafting_table", count: 1 } }] }] };
    const receipt = action(store, run, owner, { effect_confirmed: true, gui_transactions: [{
      kind: "gui_transaction", mechanism: "visible_gui", operation_index: 0, receipt_ref: "server:1:11",
      input_application: "confirmed", effect_status: "confirmed", inventory_before: { oak_planks: 4 }, inventory_after: {},
      productions: [{ producer: "crafting", item: "crafting_table", count: 1, source: "server_result_slot_take", production_confirmed: true }],
    }] }, request);
    const facts = adapter.effectEvidence!(actionAuthority(run, owner).scope, receipt.action_id, request, receipt.result!, receipt.ended_at!);
    if (retained !== "missing") for (const fact of facts)
      store.event(run.run_id, "adapter.evidence", "Retained native GUI transaction fixture", jsonSchema.parse(fact));
    const current = observation(run); current.observation_seq = 2;
    current.data.player.inventory = [{ name: "crafting_table", display_name: "Crafting Table", count: 1, slot: 0 }];
    const read = observationEvidence(adapter, actionAuthority(run, owner).scope, current);
    store.event(run.run_id, "adapter.evidence", "Independent later retention", jsonSchema.parse(read));
    const verdict = adapter.verifyCompletion({ goal: run.goal, run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!,
      epoch: run.epoch, native_boot_id: run.native_boot_id!, baseline: run.baseline }, [...facts, read]);
    expect(verdict.status).toBe("verified");
    const goal = store.event(run.run_id, "goal.verified", "Registered GUI crafting verdict", jsonSchema.parse(verdict));
    if (retained === "tampered") {
      receipt.result = { status: "succeeded", summary: "Unconfirmed replacement diagnostic", evidence: {
        effect_confirmed: true, gui_transactions: [], inventory_after: { crafting_table: 1 }, inventory_receipt_confirmed: true,
      } };
      store.saveAction(run.run_id, receipt);
    }
    finish(store, owner);
    const projected = programEvidence(store, run.run_id)[0]!;
    if (retained === "matching") {
      expect(projected.verified_event_seqs).toEqual([goal.event_seq]);
      expect(projected.goal_associations).toEqual([{ event_seq: goal.event_seq, relationship: "direct_receipt",
        action_id: receipt.action_id, causal_item_origin: "unknown" }]);
    } else {
      expect(projected.verified_event_seqs).toEqual([]);
      expect(projected.goal_associations).toEqual([]);
    }
    // Taking output into cursor is not an inventory gain; fake top-level inventory cannot replace native facts.
    expect(objectiveMetrics(store, run.run_id)[0]!.inventory_delta).not.toHaveProperty("crafting_table");
  });
}

for (const boundary of ["matching", "different retained input", "no retained receipt"] as const) {
  test(`resident ${boundary} links a confirmed GUI prefix without inventing a finite action`, async () => {
    const { directory, store, run, manager } = fixture();
    run.goal = adapter.goals.find(goal => goal.goal_id === "craft_crafting_table")!; store.saveRun(run);
    const skill = await manager.register(run.run_id, { entry: "step", name: "resident-prefix",
      source: "export function step(frame,state,intent) { return null; }", card, dependencies: [] });
    const owner = store.admitSkill(run.run_id, { entry: "step", skill_id: skill.skill_id, version: skill.version,
      start_key: crypto.randomUUID(), ...executionScopeFixture(run), args: null, initial_state: null, limits: { ...DEFAULT_RESIDENT_LIMITS } }).view;
    owner.status = "running"; owner.started_at = new Date().toISOString(); store.updateSkillExecution(owner, "skill.running", "Resident admitted");
    const input: ControllerInput = { kind: "screen", screen: { screen_id: "view", incarnation: 1, layout_revision: 1 }, operations: [
      { kind: "slot", slot_id: 0, button: "left", mode: "ordinary", hotbar_slot: null,
        expected_cursor: { item: null, count: 0 }, expected_slots: [{ slot_id: 0, value: { item: "crafting_table", count: 1 } }] },
      { kind: "close" },
    ] };
    const update: ControllerEffectUpdate = { controller_generation: 1, sequence: 7, recorded_native_ns: "123456",
      result: { status: "unknown", summary: "Confirmed first operation; suffix unknown", evidence: {
        effect_confirmed: false, transaction_status: "unknown", gui_transactions: [{
          kind: "gui_transaction", mechanism: "visible_gui", operation_index: 0, receipt_ref: "server:resident:1",
          input_application: "confirmed", effect_status: "confirmed", inventory_before: { oak_planks: 4 }, inventory_after: {},
          productions: [{ producer: "crafting", item: "crafting_table", count: 1, source: "server_result_slot_take", production_confirmed: true }],
        }],
      } } };
    const facts = retainResidentReceipt(store, adapter, owner, input, update);
    const db = new Database(join(directory, "runs", "runs.sqlite"));
    expect(db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM actions WHERE run_id=?").get(run.run_id)!.count).toBe(0);
    const current = observation(run); current.observation_seq = 2;
    current.data.player.inventory = [{ name: "crafting_table", display_name: "Crafting Table", count: 1, slot: 0 }];
    const read = observationEvidence(adapter, actionAuthority(run, owner).scope, current);
    store.event(run.run_id, "adapter.evidence", "Retained possession", jsonSchema.parse(read));
    const verdict = adapter.verifyCompletion({ goal: run.goal, run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!,
      epoch: run.epoch, native_boot_id: run.native_boot_id!, baseline: run.baseline }, [...facts, read]);
    expect(verdict.status).toBe("verified");
    const goal = store.event(run.run_id, "goal.verified", "Receipt prefix and independent possession", jsonSchema.parse(verdict));
    if (boundary === "no retained receipt")
      db.query("DELETE FROM events WHERE run_id=? AND type='controller.receipted'").run(run.run_id);
    if (boundary === "different retained input")
      db.query("UPDATE events SET details=json_set(details,'$.input.operations',json('[]')) WHERE run_id=? AND type='controller.receipted'").run(run.run_id);
    db.close();
    owner.status = "unknown"; owner.ended_at = new Date().toISOString(); owner.error = "Suffix unknown";
    store.updateSkillExecution(owner, "skill.closed", "Resident retired with unknown suffix");
    const projected = programEvidence(store, run.run_id).find(entry => entry.execution_id === owner.execution_id)!;
    expect(projected.status).toBe("unknown");
    if (boundary === "matching") {
      expect(projected.verified_event_seqs).toEqual([goal.event_seq]);
      expect(projected.goal_associations).toEqual([{ event_seq: goal.event_seq, relationship: "direct_receipt",
        action_id: null, controller_input: { input_id: `controller:${owner.execution_id}:1:7`, generation: 1, sequence: 7 },
        causal_item_origin: "unknown" }]);
    } else expect(projected.verified_event_seqs).toEqual([]);
  });
}

for (const boundary of ["matching", "no prefix", "source mismatch", "origin mismatch", "unrelated prefix"] as const) {
  test(`retained unknown GUI action ${boundary} preserves only its own confirmed crafting prefix association`, async () => {
    const { store, run, manager } = fixture();
    run.goal = adapter.goals.find(goal => goal.goal_id === "craft_crafting_table")!;
    store.saveRun(run);
    const owner = execution(store, run, await authored(manager, run));
    const request: GameAction = { kind: "screen_input", screen: { screen_id: "view", incarnation: 1, layout_revision: 1 },
      operations: [
        { kind: "slot", slot_id: 0, button: "left", mode: "ordinary", hotbar_slot: null,
          expected_cursor: { item: null, count: 0 }, expected_slots: [{ slot_id: 0, value: { item: "crafting_table", count: 1 } }] },
        { kind: "slot", slot_id: 5, button: "left", mode: "ordinary", hotbar_slot: null,
          expected_cursor: { item: "crafting_table", count: 1 }, expected_slots: [{ slot_id: 5, value: { item: null, count: 0 } }] },
      ] };
    const authority = actionAuthority(run, owner);
    if (boundary === "source mismatch") {
      authority.scope.source_hash = sha256("another program source");
      authority.invocation.source_hash = authority.scope.source_hash;
    }
    const receipt = store.admitAction(run.run_id, crypto.randomUUID(), request, "skill", owner.execution_id, authority).action.view;
    const prefix: Json = {
      kind: "gui_transaction", mechanism: "visible_gui", operation_index: 0, receipt_ref: "server:1:12",
      input_application: "confirmed", effect_status: "confirmed", inventory_before: { oak_planks: 4 }, inventory_after: {},
      productions: [{ producer: "crafting", item: "crafting_table", count: 1, source: "server_result_slot_take", production_confirmed: true }],
    };
    receipt.status = "unknown";
    receipt.ended_at = new Date().toISOString();
    receipt.result = { status: "unknown", summary: "Second operation acknowledgement lost", evidence: {
      effect_confirmed: false, transaction_status: "unknown", gui_transactions: [prefix],
    } };
    if (boundary === "origin mismatch") receipt.origin = "diagnostic";
    store.saveAction(run.run_id, receipt);
    const facts = adapter.effectEvidence!(authority.scope, receipt.action_id, request, receipt.result, receipt.ended_at);
    expect(facts.map(fact => fact.schema.id)).toEqual(["minecraft_gui_transaction_v1", "minecraft_effect_uncertainty_v1"]);
    for (const fact of facts)
      store.event(run.run_id, "adapter.evidence", "Retained confirmed prefix and unresolved suffix", jsonSchema.parse(fact));
    const current = observation(run);
    current.observation_seq = 2;
    current.data.player.inventory = [{ name: "crafting_table", display_name: "Crafting Table", count: 1, slot: 0 }];
    const read = observationEvidence(adapter, actionAuthority(run, owner).scope, current);
    store.event(run.run_id, "adapter.evidence", "Fresh retained possession after unknown GUI suffix", jsonSchema.parse(read));
    const verdict = adapter.verifyCompletion({ goal: run.goal, run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!,
      epoch: run.epoch, native_boot_id: run.native_boot_id!, baseline: run.baseline }, [...facts, read]);
    expect(verdict.status).toBe("verified");
    expect(verdict.evidence_refs).toEqual([`${receipt.action_id}:gui:0`, read.evidence_id]);
    const goal = store.event(run.run_id, "goal.verified", "Actual prefix production and retained possession verdict", jsonSchema.parse(verdict));
    if (boundary === "unrelated prefix") {
      const other = store.admitAction(run.run_id, crypto.randomUUID(), request, "skill", owner.execution_id,
        actionAuthority(run, owner)).action.view;
      other.status = "unknown";
      other.ended_at = receipt.ended_at;
      other.result = structuredClone(receipt.result);
      store.saveAction(run.run_id, other);
    }
    if (boundary === "no prefix" || boundary === "unrelated prefix") {
      receipt.result.evidence = { effect_confirmed: false, transaction_status: "unknown", gui_transactions: [] };
      store.saveAction(run.run_id, receipt);
    }
    owner.status = "unknown";
    owner.ended_at = new Date().toISOString();
    owner.error = "Unresolved GUI suffix";
    store.updateSkillExecution(owner, "skill.closed", "Unknown program effect tail retained");
    const before = store.getAction(run.run_id, receipt.action_id)!.view;
    const beforeSeq = store.lastEventSeq();
    const projections = programEvidence(store, run.run_id);
    const projected = projections.find(entry => entry.execution_id === owner.execution_id)!;
    expect(projected.status).toBe("unknown");
    expect(projected.confirmed_effects).toBe(0);
    expect(projected.metrics.outcome).toBe("unknown");
    expect(projected.metrics.inventory_delta).not.toHaveProperty("crafting_table");
    if (boundary === "matching") {
      expect(projected.evidence_status).toBe("verified_goal");
      expect(projected.verified_event_seqs).toEqual([goal.event_seq]);
      expect(projected.goal_associations).toEqual([{ event_seq: goal.event_seq, relationship: "direct_receipt",
        action_id: receipt.action_id, causal_item_origin: "unknown" }]);
      expect(projected.metrics.inventory_receipts).toBe(1);
      expect(projected.metrics.inventory_delta).toEqual({ oak_planks: -4 });
    } else {
      expect(projections.every(entry => entry.goal_associations.length === 0 && entry.verified_event_seqs.length === 0)).toBe(true);
      expect(projected.evidence_status).not.toBe("verified_goal");
    }
    expect(store.getAction(run.run_id, receipt.action_id)!.view).toEqual(before);
    expect(store.getAction(run.run_id, receipt.action_id)!.view).toMatchObject({
      status: "unknown", result: { status: "unknown", evidence: { effect_confirmed: false, transaction_status: "unknown" } },
    });
    expect(store.skillExecution(run.run_id, { execution_id: owner.execution_id })).toMatchObject({
      status: "unknown", error: "Unresolved GUI suffix",
    });
    expect(store.lastEventSeq()).toBe(beforeSeq);
  });
}

test("persisted named memory revisions survive duplicate names, paging and SQLite compaction", async () => {
  const { directory, store, library, run, manager } = fixture();
  const qualify = async (programName: string, memoryName: string) => {
    const skill = await authored(manager, run, programName);
    const view = execution(store, run, skill);
    action(store, run, view, { effect_confirmed: true, inventory_receipt_confirmed: true,
      inventory_before: { stone: 0 }, inventory_after: { stone: 2 } });
    const receipt = inventoryObservation(store, run, { stone: 2 });
    finish(store, view);
    return library.promote(store, run.run_id, view, memoryName, declaration(receipt.event_seq));
  };
  const removedFixture = await qualify("temporary gap", "temporary gap");
  const first = await qualify("first named source", "shared memory");
  const second = await qualify("second named source", "shared memory");
  const other = await qualify("other named source", "other memory");
  const firstVersion = library.snapshotVersion(first.experience_id, run.model_id)!;
  const secondVersion = library.snapshotVersion(second.experience_id, run.model_id)!;
  const otherVersion = library.snapshotVersion(other.experience_id, run.model_id)!;
  const db = new Database(join(directory, "library", "experience.sqlite"));
  const original = db.query<{ payload: string }, [string]>("SELECT payload FROM bundles WHERE id=?").get(first.experience_id)!.payload;
  db.query("DELETE FROM bundles WHERE id=?").run(removedFixture.experience_id);
  db.exec("VACUUM");
  expect(db.query<{ payload: string }, [string]>("SELECT payload FROM bundles WHERE id=?").get(first.experience_id)!.payload).toBe(original);
  expect(library.named(run.model_id, run.world_id, "shared memory", firstVersion)?.experience_id).toBe(first.experience_id);
  expect(library.named(run.model_id, run.world_id, "shared memory")?.experience_id).toBe(second.experience_id);
  expect(library.snapshotVersion(second.experience_id, run.model_id)).toBe(secondVersion);
  const page = library.catalog(run.model_id, run.world_id, 0, 1);
  expect(page.records).toMatchObject([{ name: "other memory", version: otherVersion }]);
  expect(page.has_more).toBe(true);
  expect(library.catalog(run.model_id, run.world_id, page.next_after, 1).records).toMatchObject([{ name: "shared memory", version: secondVersion }]);
  db.close();
});

test("portable exact snapshot accepts live coordinate reads but does not restore invocation coordinates", async () => {
  const { store, library, run, manager } = fixture();
  const child = await authored(manager, run, "child");
  const root = await manager.register(run.run_id, { entry: "run",
    name: "root",
    source: `const result = await game.call({name:\"child\",version:${child.version}}, \"dependency\"); return {status:\"completed\",summary:\"Composed exact dependency\",result};`,
    card,
    dependencies: [{ skill_id: child.skill_id, version: child.version }],
  });
  const view = execution(store, run, root);
  const effect = action(store, run, view, {
    effect_confirmed: true,
    inventory_receipt_confirmed: true,
    inventory_before: { stone: 0 },
    inventory_after: { stone: 2 },
  });
  const evidence = inventoryObservation(store, run, { stone: 2 });
  finish(store, view);
  const promoted = library.promote(
    store,
    run.run_id,
    view,
    "Verified current-observation program",
    declaration(evidence.event_seq),
  );
  expect(promoted.evidence.action_ids).toEqual([effect.action_id]);
  expect(library.list("other-model", run.world_id)).toEqual([]);
  const destination: StoredRun = {
    ...run,
    run_id: crypto.randomUUID(),
    world_id: crypto.randomUUID(),
    status: "created",
  };
  store.saveRun(destination);
  const hydrated = await library.hydrate(
    promoted.experience_id,
    destination.model_id,
    destination.world_id,
    destination.run_id,
    manager,
  );
  expect(hydrated.hash).toBe(root.hash);
  expect(hydrated.dependencies).toHaveLength(1);
  expect(hydrated.dependencies[0]?.skill_id).toBe(child.skill_id);
  expect(store.skillExecutions(destination.run_id)).toEqual([]);
  expect(library.list(run.model_id, destination.world_id)).toHaveLength(1);
  destination.status = "running";
  store.saveRun(destination);
  let invocations = 0;
  const reusedManager = new SkillManager(
    store,
    {
      runSkill: async (_source, args, handle) => {
        invocations++;
        if (args === "parent")
          await handle({
            kind: "call",
            skill: { name: "child", version: child.version },
            args: "dependency",
          });
        return {
          status: "completed",
          summary: "Exact dependency settled",
          result: null,
        };
      },
    },
    {
      authorize: () => {},
      adapter: () => adapter, binding: () => minecraftTestBinding(adapter),
      observe: async () => observation(destination),
      action: async () => ({
        status: "unknown",
        summary: "Not used",
        evidence: null,
      }),
      queryCapability: async () => null,
      cancelActions: async () => {},
      changed: () => {},
      unsafe: () => {},
      recover: async () => { throw new Error("Fixture does not authorize respawn"); },
    },
  );
  const settled = Promise.withResolvers<void>();
  const admitted = reusedManager.start(destination.run_id, { entry: "run",
    skill_id: hydrated.skill_id,
    version: hydrated.version,
    start_key: "warm-exact-composition",
    ...executionScopeFixture(destination),
    args: "parent",
    limits: { ...DEFAULT_SKILL_LIMITS },
  });
  const unsubscribe = store.subscribe((event) => {
    if (
      event.type === "skill.closed" &&
      store.skillExecution(destination.run_id, {
        execution_id: admitted.execution_id,
      })?.status === "succeeded"
    )
      settled.resolve();
  });
  await settled.promise;
  unsubscribe();
  await reusedManager.closeAll("Fixture complete");
  expect(invocations).toBe(2);
  expect(
    reusedManager.get(destination.run_id, {
      execution_id: admitted.execution_id,
    })?.status,
  ).toBe("succeeded");
  await expect(
    library.hydrate(
      promoted.experience_id,
      "other-model",
      destination.world_id,
      destination.run_id,
      manager,
    ),
  ).rejects.toThrow();
});

test("world-bound declarations cannot masquerade as portable and world-local snapshots cannot cross worlds", async () => {
  const { store, library, run, manager } = fixture();
  const skill = await authored(manager, run),
    view = execution(store, run, skill);
  action(store, run, view, {
    effect_confirmed: true,
    inventory_receipt_confirmed: true,
    inventory_before: { stone: 0 },
    inventory_after: { stone: 2 },
  });
  const evidence = inventoryObservation(store, run, { stone: 2 });
  finish(store, view);
  expect(() =>
    library.promote(store, run.run_id, view, "Invalid declaration", {
      ...declaration(evidence.event_seq),
      retained_world_data: true,
    }),
  ).toThrow();
  const local = library.promote(
    store,
    run.run_id,
    view,
    "World-local program",
    {
      ...declaration(evidence.event_seq, "world_local"),
      retained_world_data: true,
    },
  );
  const otherWorld = crypto.randomUUID();
  expect(library.list(run.model_id, otherWorld)).toEqual([]);
  await expect(
    library.hydrate(
      local.experience_id,
      run.model_id,
      otherWorld,
      run.run_id,
      manager,
    ),
  ).rejects.toThrow();
});

test("program history counts actual strategic requests separately from Jev and compactness", async () => {
  const { store, run, manager } = fixture();
  const skill = await authored(manager, run),
    view = execution(store, run, skill);
  store.event(run.run_id, "model.call", "Actual strategic request", {
    request_id: "strategic-1",
    purpose: "planning",
  });
  store.event(run.run_id, "model.call", "Actual finite Jev request", {
    request_id: "jev-1",
    backend: "jev",
    purpose: "other",
  });
  const effect = action(store, run, view, { effect_confirmed: true });
  store.saveAction(run.run_id, effect);
  finish(store, view);
  const measured = programEvidence(store, run.run_id)[0]!;
  expect(measured.strategic_requests).toBe(1);
  expect(measured.confirmed_effects).toBe(1);
  expect(measured.duration_ms).toBeGreaterThanOrEqual(1000);
  expect(measured.evidence_status).toBe("confirmed_effects");
  expect(measured.compactness.formatted_lines).toBeGreaterThan(0);
});

test("usage separates uncached input, read cache, written cache and explicit request purpose", () => {
  const usage = emptyRunUsage();
  recordCall(usage, "authoring");
  recordUsage(usage, "authoring", {
    input: 10,
    cacheRead: 30,
    cacheWrite: 4,
    output: 6,
  });
  recordCall(usage, "replanning");
  recordUsage(usage, "replanning", {
    input: 2,
    cacheRead: 7,
    cacheWrite: 0,
    output: 3,
  });
  expect(usage.uncached_input).toBe(12);
  expect(usage.cache_read).toBe(37);
  expect(usage.cache_write).toBe(4);
  expect(usage.output).toBe(9);
  expect(usage.calls).toBe(2);
  expect(usage.known_cost).toBeNull();
  expect(usage.legacy_input).toBeNull();
  expect(usage.by_purpose.authoring.calls).toBe(1);
  expect(usage.by_purpose.authoring.output).toBe(6);
  expect(usage.by_purpose.replanning.output).toBe(3);
  expect(usage.by_purpose.planning.calls).toBe(0);
});

test("runtime subtotals keep missing first counters null and retain earlier contributions across later missing fields", () => {
  const usage = emptyRunUsage();
  recordCall(usage, "planning");
  expect(usage).toMatchObject({ accounting_basis: "sdk_reported_subtotal",
    uncached_input: null, cache_read: null, cache_write: null, output: null, calls: 1 });
  recordUsage(usage, "planning", { input: 7, cacheRead: 3, cacheWrite: 0, output: null });
  recordCall(usage, "planning");
  recordUsage(usage, "planning", { input: null, cacheRead: null, cacheWrite: null, output: 4 });
  expect(usage).toMatchObject({ uncached_input: 7, cache_read: 3, cache_write: 0, output: 4, calls: 2,
    by_purpose: { planning: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 4 } } });
});

test("new provider evidence never fabricates a breakdown for aggregate-only legacy usage", () => {
  const usage = emptyRunUsage();
  usage.uncached_input = null;
  usage.cache_read = null;
  usage.cache_write = null;
  usage.calls = null;
  usage.legacy_input = 100;
  recordCall(usage, "planning");
  recordUsage(usage, "planning", {
    input: 2,
    cacheRead: 3,
    cacheWrite: 0,
    output: 4,
  });
  expect(usage.uncached_input).toBeNull();
  expect(usage.cache_read).toBeNull();
  expect(usage.cache_write).toBeNull();
  expect(usage.calls).toBeNull();
  expect(usage.legacy_input).toBe(100);
  expect(usage.by_purpose.planning.uncached_input).toBe(2);
  expect(usage.by_purpose.planning.calls).toBe(1);
});

test("authorized execution traces persist exact lineage, bounded pages and explicit payload omissions", async () => {
  const { directory, store, run, manager } = fixture();
  const skill = await authored(manager, run), view = execution(store, run, skill);
  const trace = new ExecutionTrace(store);
  trace.observe(view, observation(run), { call_id: "observe-1" });
  trace.record(view, "branch", { diagnostic_only: true, events: [{ point_id: 1, decision: false }] });
  for (let n = 0; n < 8; n++) trace.record(view, "capability_result", { text: "a".repeat(18000), n }, { call_id: `call-${n}` });
  trace.record(view, "capability_result", { text: "b".repeat(30000) }, { call_id: "oversize", life_id: 2 });
  let cursor = 0, total = 0, omitted = false;
  do {
    const page = store.tracePage(run.run_id, cursor, 100, view.execution_id);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
    expect(page.records.length).toBeGreaterThan(0);
    for (const record of page.records) {
      expect(record.hash).toBe(skill.hash);
      expect(record.root_execution_id).toBe(view.execution_id);
      expect(record.session_id).toBe(run.session_id);
      if (record.call_id === "oversize") {
        expect(record.life_id).toBe(2);
        expect(record.payload).toBeNull();
        expect(record.omission?.reason).toBe("record_byte_budget");
        omitted = true;
      }
    }
    total += page.records.length;
    expect(page.next_after).toBeGreaterThan(cursor);
    cursor = page.next_after;
    if (!page.has_more) break;
  } while (true);
  expect(total).toBe(11);
  expect(omitted).toBe(true);
  expect(store.tracePage(run.run_id).budget.omitted_records).toBe(1);
  const reopened = new Store(join(directory, "runs"));
  try {
    expect(reopened.tracePage(run.run_id).budget.recorded).toBe(11);
    expect(reopened.tracePage(run.run_id).records[0]?.hash).toBe(skill.hash);
  } finally { reopened.close(); }
  expect(store.tracePage(run.run_id, 0, 100, "unrelated-root").records).toEqual([]);
  const measured = programEvidence(store, run.run_id)[0]!;
  expect(measured.evidence_status).not.toBe("verified_goal");
  expect(measured.metrics.trace_complete).toBe(false);
});

test("objective metrics separate removed blocks, receipted counts, measured motion and life-discontinuous samples", async () => {
  const { store, run, manager } = fixture();
  const skill = await authored(manager, run), view = execution(store, run, skill);
  const trace = new ExecutionTrace(store);
  trace.observe(view, observation(run));
  const next = observation(run);
  next.observation_seq = 2; next.data.player.position.x = 3; next.data.player.yaw = Math.PI / 2;
  trace.observe(view, next);
  const newLife = observation(run);
  newLife.observation_seq = 3; newLife.life.life_id = 2; newLife.data.player.position.x = 1000;
  trace.observe(view, newLife);
  trace.span(view, "capability_wait", 100, 120);
  const admitted = store.admitAction(run.run_id, crypto.randomUUID(), { kind: "dig", target: { target_id: "observed-block", incarnation: 1,
    life_id: run.life_id!, space: { dimension_id: "minecraft:overworld", space_epoch: run.space_epoch! } } }, "skill", view.execution_id, actionAuthority(run, view));
  const effect = admitted.action.view;
  effect.status = "succeeded"; effect.ended_at = new Date().toISOString();
  effect.result = { status: "succeeded", summary: "Server block update", evidence: { effect_confirmed: true, block_removed: true, source: "server_block_update", target_name: "oak_log", target_position: { x: 1, y: 64, z: 0 }, inventory_before: { oak_log: 0 }, inventory_after: { oak_log: 99 }, travel_distance: 2, rotation_yaw_radians: Math.PI / 2, rotation_pitch_radians: 0 } };
  store.saveAction(run.run_id, effect);
  action(store, run, view, { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: { oak_log: 0 }, inventory_after: { oak_log: 1 } });
  const metric = objectiveMetrics(store, run.run_id)[0]!;
  expect(metric.confirmed_block_removals).toBe(1);
  expect(metric.removed_blocks).toEqual({ oak_log: 1 });
  expect(metric.inventory_delta).toEqual({ oak_log: 1 });
  expect(metric.inventory_receipts).toBe(1);
  expect(metric.sampled_travel_distance).toBe(3);
  expect(metric.sampled_rotation_degrees).toBe(90);
  expect(metric.receipted_travel_distance).toBe(2);
  expect(metric.receipted_rotation_degrees).toBe(90);
  expect(metric.spans_ms.capability_wait).toBe(20);
});

test("break_log qualification never fabricates inventory and cross-root pickup cannot qualify the removing root", async () => {
  const { store, library, run, manager } = fixture();
  run.goal = adapter.goals.find(goal => goal.goal_id === "collect_wood")!; store.saveRun(run);
  const skill = await authored(manager, run), remover = execution(store, run, skill);
  const look = action(store, run, remover, { effect_confirmed: true });
  const admitted = store.admitAction(run.run_id, crypto.randomUUID(), { kind: "dig", target: { target_id: "log", incarnation: 1,
    life_id: run.life_id!, space: { dimension_id: "minecraft:overworld", space_epoch: run.space_epoch! } } }, "skill", remover.execution_id, actionAuthority(run, remover));
  const effect = admitted.action.view;
  effect.status = "succeeded"; effect.ended_at = new Date().toISOString();
  effect.result = { status: "succeeded", summary: "Confirmed removal without pickup", evidence: { effect_confirmed: true, block_removed: true, source: "server_block_update", target_name: "oak_log", inventory_before: { oak_log: 0 }, inventory_after: { oak_log: 0 }, inventory_receipt_confirmed: true } };
  store.saveAction(run.run_id, effect);
  finish(store, remover);
  const collector = execution(store, run, skill);
  const pickup = action(store, run, collector, { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: { oak_log: 0 }, inventory_after: { oak_log: 1 } });
  const current = observation(run); current.observation_seq = 2; current.data.player.inventory = [{ name: "oak_log", display_name: "Oak Log", count: 1, slot: 0 }];
  const read = observationEvidence(adapter, actionAuthority(run, collector).scope, current);
  store.event(run.run_id, "adapter.evidence", "Retained own-player pickup observation", jsonSchema.parse(read));
  const verdict = adapter.verifyCompletion({ goal: run.goal, run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!,
    epoch: run.epoch, native_boot_id: run.native_boot_id!, baseline: run.baseline }, [read]);
  expect(verdict.status).toBe("verified");
  const goal = store.event(run.run_id, "goal.verified", "Trusted pickup", jsonSchema.parse(verdict));
  finish(store, collector);
  expect(() => library.promote(store, run.run_id, remover, "Not a collection proof", { portability: "portable", retained_world_data: false, predicate: { kind: "goal_verified", event_seq: goal.event_seq } })).toThrow();
  const projections = programEvidence(store, run.run_id);
  expect(projections.find((value) => value.execution_id === remover.execution_id)?.evidence_status).toBe("confirmed_effects");
  expect(projections.find((value) => value.execution_id === remover.execution_id)?.goal_associations[0]?.relationship).toBe("block_removal_contributor");
  expect(projections.find((value) => value.execution_id === collector.execution_id)?.evidence_status).toBe("verified_goal");
  expect(projections.find((value) => value.execution_id === collector.execution_id)?.goal_associations).toEqual([
    { event_seq: goal.event_seq, relationship: "inventory_collector", action_id: pickup.action_id, causal_item_origin: "unknown" },
  ]);
  const successEvents = store.eventsAfter(run.run_id, 0, 500).filter((event) => event.type === "action.succeeded");
  const lookEvent = successEvents.find((event) => event.details && typeof event.details === "object" && !Array.isArray(event.details) && event.details.action_id === look.action_id)!;
  expect(() => library.promote(store, run.run_id, remover, "Wrong declared action", { portability: "portable", retained_world_data: false, predicate: { kind: "break_log", event_seq: lookEvent.event_seq } })).toThrow();
  const removalEvent = successEvents.find((event) => event.details && typeof event.details === "object" && !Array.isArray(event.details) && event.details.action_id === effect.action_id)!;
  const promoted = library.promote(store, run.run_id, remover, "Actual block removal", { portability: "portable", retained_world_data: false, predicate: { kind: "break_log", event_seq: removalEvent.event_seq } });
  expect(promoted.evidence.predicate.kind).toBe("break_log");
  expect(promoted.evidence.action_ids).toEqual([effect.action_id]);
});

for (const goalId of ["break_log", "craft_crafting_table"] as const) {
  test(`versioned ${goalId} evidence resolves its retained fact to the confirmed owning receipt`, async () => {
    const { store, run, manager } = fixture();
    run.goal = adapter.goals.find(goal => goal.goal_id === goalId)!;
    store.saveRun(run);
    const owner = execution(store, run, await authored(manager, run));
    const request: GameAction = goalId === "break_log"
      ? { kind: "dig" as const, target: { target_id: "log", incarnation: 1, life_id: run.life_id!,
          space: { dimension_id: "minecraft:overworld", space_epoch: run.space_epoch! } } }
      : { kind: "craft" as const, item: "crafting_table", executions: 1 };
    const admitted = store.admitAction(run.run_id, crypto.randomUUID(), request, "skill", owner.execution_id, actionAuthority(run, owner));
    const receipt = admitted.action.view;
    receipt.status = "succeeded"; receipt.ended_at = new Date().toISOString();
    receipt.result = { status: "succeeded", summary: "Confirmed fixture effect", evidence: goalId === "break_log"
      ? { effect_confirmed: true, block_removed: true, source: "server_block_update", target_name: "oak_log" }
      : { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: { crafting_table: 1 } } };
    store.saveAction(run.run_id, receipt);
    const facts = adapter.effectEvidence!(actionAuthority(run, owner).scope, receipt.action_id, request, receipt.result, receipt.ended_at);
    expect(facts).toHaveLength(1);
    for (const fact of facts) store.event(run.run_id, "adapter.evidence", "Retained adapter effect fact", jsonSchema.parse(fact));
    const current = observation(run);
    current.observation_seq = 2;
    current.data.player.inventory = goalId === "break_log" ? [] : [{ name: "crafting_table", display_name: "Crafting Table", count: 1, slot: 0 }];
    const read = observationEvidence(adapter, actionAuthority(run, owner).scope, current);
    store.event(run.run_id, "adapter.evidence", "Retained possession observation", jsonSchema.parse(read));
    const verdict = adapter.verifyCompletion({ goal: run.goal, run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!,
      epoch: run.epoch, native_boot_id: run.native_boot_id!, baseline: run.baseline }, [...facts, read]);
    expect(verdict.status).toBe("verified");
    const goal = store.event(run.run_id, "goal.verified", "Registered verifier result", jsonSchema.parse(verdict));
    finish(store, owner);
    const projected = programEvidence(store, run.run_id).find(entry => entry.execution_id === owner.execution_id)!;
    expect(projected.evidence_status).toBe("verified_goal");
    expect(projected.verified_event_seqs).toEqual([goal.event_seq]);
    expect(projected.goal_associations).toEqual([
      { event_seq: goal.event_seq, relationship: "direct_receipt", action_id: receipt.action_id, causal_item_origin: "unknown" },
    ]);
  });
}

test("combined goal resolves pre-consumption planks production separately from the final table receipt", async () => {
  const { store, run, manager } = fixture();
  run.goal = adapter.goals.find(goal => goal.goal_id === "collect_and_craft_table")!;
  store.saveRun(run);
  const owner = execution(store, run, await authored(manager, run));
  const produced = (item: string, before: Record<string, number>, after: Record<string, number>) => {
    const request: GameAction = { kind: "craft", item, executions: 1 };
    const admitted = store.admitAction(run.run_id, crypto.randomUUID(), request, "skill", owner.execution_id, actionAuthority(run, owner));
    const receipt = admitted.action.view;
    receipt.status = "succeeded"; receipt.ended_at = new Date().toISOString();
    receipt.result = { status: "succeeded", summary: "Confirmed helper fixture production", evidence: {
      effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: before, inventory_after: after } };
    store.saveAction(run.run_id, receipt);
    const facts = adapter.effectEvidence!(actionAuthority(run, owner).scope, receipt.action_id, request, receipt.result, receipt.ended_at);
    for (const fact of facts) store.event(run.run_id, "adapter.evidence", "Retained actual adapter production fact", jsonSchema.parse(fact));
    return { receipt, facts };
  };
  const planks = produced("oak_planks", { oak_log: 1 }, { oak_planks: 4 });
  const table = produced("crafting_table", { oak_planks: 4 }, { crafting_table: 1 });
  const current = observation(run); current.observation_seq = 2;
  current.data.player.inventory = [{ name: "crafting_table", display_name: "Crafting Table", count: 1, slot: 0 }];
  const read = observationEvidence(adapter, actionAuthority(run, owner).scope, current);
  store.event(run.run_id, "adapter.evidence", "Retained table possession after wood consumption", jsonSchema.parse(read));
  const verdict = adapter.verifyCompletion({ goal: run.goal, run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!,
    epoch: run.epoch, native_boot_id: run.native_boot_id!, baseline: run.baseline }, [...planks.facts, ...table.facts, read]);
  expect(verdict.status).toBe("verified");
  expect(verdict.evidence_refs).toEqual([`${planks.receipt.action_id}:production`, `${table.receipt.action_id}:production`, read.evidence_id]);
  const goal = store.event(run.run_id, "goal.verified", "Combined registered all-of verifier result", jsonSchema.parse(verdict));
  finish(store, owner);
  const projected = programEvidence(store, run.run_id)[0]!;
  expect(projected.evidence_status).toBe("verified_goal");
  expect(projected.verified_event_seqs).toEqual([goal.event_seq]);
  expect(projected.goal_associations).toEqual([
    { event_seq: goal.event_seq, relationship: "inventory_collector", action_id: planks.receipt.action_id, causal_item_origin: "unknown" },
    { event_seq: goal.event_seq, relationship: "direct_receipt", action_id: table.receipt.action_id, causal_item_origin: "unknown" },
  ]);
  planks.receipt.result!.evidence = { effect_confirmed: false, inventory_receipt_confirmed: false };
  store.saveAction(run.run_id, planks.receipt);
  const missingAcquisition = programEvidence(store, run.run_id)[0]!;
  expect(missingAcquisition.evidence_status).not.toBe("verified_goal");
  expect(missingAcquisition.goal_associations).toEqual([]);
});

for (const invalid of ["missing retained reference", "wrong verifier version", "wrong adapter", "unconfirmed receipt"] as const) {
  test(`versioned verifier projection refuses ${invalid} instead of inventing goal attribution`, async () => {
    const { store, run, manager } = fixture();
    run.goal = adapter.goals.find(goal => goal.goal_id === "craft_crafting_table")!;
    store.saveRun(run);
    const owner = execution(store, run, await authored(manager, run));
    const request = { kind: "craft" as const, item: "crafting_table", executions: 1 };
    const admitted = store.admitAction(run.run_id, crypto.randomUUID(), request, "skill", owner.execution_id, actionAuthority(run, owner));
    const receipt = admitted.action.view;
    receipt.status = "succeeded"; receipt.ended_at = new Date().toISOString();
    receipt.result = { status: "succeeded", summary: "Fixture production receipt", evidence: {
      effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: { crafting_table: 1 } } };
    store.saveAction(run.run_id, receipt);
    const facts = adapter.effectEvidence!(actionAuthority(run, owner).scope, receipt.action_id, request, receipt.result, receipt.ended_at);
    if (invalid !== "missing retained reference") for (const fact of facts)
      store.event(run.run_id, "adapter.evidence", "Retained production fact", jsonSchema.parse(fact));
    const current = observation(run); current.observation_seq = 2;
    current.data.player.inventory = [{ name: "crafting_table", display_name: "Crafting Table", count: 1, slot: 0 }];
    const read = observationEvidence(adapter, actionAuthority(run, owner).scope, current);
    store.event(run.run_id, "adapter.evidence", "Retained observation", jsonSchema.parse(read));
    const verdict = adapter.verifyCompletion({ goal: run.goal, run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!,
      epoch: run.epoch, native_boot_id: run.native_boot_id!, baseline: run.baseline }, [...facts, read]);
    expect(verdict.status).toBe("verified");
    if (invalid === "wrong verifier version") verdict.verifier_version++;
    if (invalid === "wrong adapter") verdict.adapter_id = "another-adapter";
    if (invalid === "unconfirmed receipt") {
      receipt.result.evidence = { effect_confirmed: false, inventory_receipt_confirmed: false };
      store.saveAction(run.run_id, receipt);
    }
    store.event(run.run_id, "goal.verified", "Unavailable or invalid reference boundary", jsonSchema.parse(verdict));
    finish(store, owner);
    const projected = programEvidence(store, run.run_id)[0]!;
    expect(projected.evidence_status).not.toBe("verified_goal");
    expect(projected.verified_event_seqs).toEqual([]);
    expect(projected.goal_associations).toEqual([]);
  });
}

test("historical v1 goal payload keeps its explicit receipt association without relabeling", async () => {
  const { store, run, manager } = fixture();
  run.goal = "collect_wood"; store.saveRun(run);
  const owner = execution(store, run, await authored(manager, run));
  const pickup = action(store, run, owner, { effect_confirmed: true, inventory_receipt_confirmed: true,
    inventory_before: { oak_log: 0 }, inventory_after: { oak_log: 1 } });
  const details = { goal: "collect_wood", item: "oak_log", action_id: pickup.action_id };
  const goal = store.event(run.run_id, "goal.verified", "Historical v1 payload", details);
  finish(store, owner);
  expect(programEvidence(store, run.run_id)[0]!).toMatchObject({ evidence_status: "verified_goal",
    verified_event_seqs: [goal.event_seq], goal_associations: [
      { event_seq: goal.event_seq, relationship: "direct_receipt", action_id: pickup.action_id, causal_item_origin: "unknown" },
    ] });
  expect(store.eventsAfter(run.run_id, goal.event_seq - 1, 1)[0]?.details).toEqual(details);
});

test("custom-task typed inventory selection reaches actual qualification while preserving receipt attribution", async () => {
  const { store, library, run, manager } = fixture();
  const owner = execution(store, run, await authored(manager, run));
  const pickup = action(store, run, owner, { effect_confirmed: true, inventory_receipt_confirmed: true,
    inventory_before: { stone: 0 }, inventory_after: { stone: 2 } });
  const observed = inventoryObservation(store, run, { stone: 2 });
  finish(store, owner);
  expect(promotionEvidence(observed, run, owner, store.eventsAfter(run.run_id, 0, 500))).toEqual({ kind: "inventory_gain", counts: { stone: 2 } });
  const promoted = library.promote(store, run.run_id, owner, "Confirmed custom inventory gain", declaration(observed.event_seq));
  expect(promoted.evidence.action_ids).toEqual([pickup.action_id]);
  expect(promoted.evidence.predicate).toEqual({ kind: "inventory_gain", item: "stone", min_gain: 2, event_seq: observed.event_seq });
  expect(store.eventsAfter(run.run_id, 0, 500).some(event => event.type === "goal.verified")).toBe(false);
});

test("historical inventory counts remain selectable as historical data, not current adapter qualification", async () => {
  const { store, library, run, manager } = fixture();
  const owner = execution(store, run, await authored(manager, run));
  const historical = store.event(run.run_id, "observation.inventory", "Historical inventory payload", { counts: { stone: 2 } });
  finish(store, owner);
  expect(promotionEvidence(historical, { ...run, goal: "custom", native_boot_id: null, compatibility_hash: null }, owner, store.eventsAfter(run.run_id, 0, 500)))
    .toEqual({ kind: "inventory_gain", counts: { stone: 2 } });
  expect(promotionEvidence(historical, run, owner, store.eventsAfter(run.run_id, 0, 500))).toBeNull();
  expect(() => library.promote(store, run.run_id, owner, "Not a current observation", declaration(historical.event_seq))).toThrow();
  expect(store.eventsAfter(run.run_id, historical.event_seq - 1, 1)[0]?.details).toEqual({ counts: { stone: 2 } });
});

for (const invalid of ["other run", "other life", "other boot", "dead player", "wrong schema", "out of interval"] as const) {
  test(`operator inventory candidate rejects ${invalid} before presenting typed evidence as selectable`, async () => {
    const { store, library, run, manager } = fixture();
    const owner = execution(store, run, await authored(manager, run));
    action(store, run, owner, { effect_confirmed: true, inventory_receipt_confirmed: true,
      inventory_before: { stone: 0 }, inventory_after: { stone: 2 } });
    const current = observation(run); current.observation_seq = 2;
    current.data.player.inventory = [{ name: "stone", display_name: "Stone", count: 2, slot: 0 }];
    const read = observationEvidence(adapter, actionAuthority(run, owner).scope, current);
    if (invalid === "other run") read.scope.run_id = "foreign-run";
    if (invalid === "other life") { read.scope.life_id++; current.life.life_id++; read.data = jsonSchema.parse(current); }
    if (invalid === "other boot") { read.scope.native_boot_id = "foreign-boot"; current.native_boot_id = "foreign-boot"; read.data = jsonSchema.parse(current); }
    if (invalid === "dead player") { current.life.status = "dead"; read.data = jsonSchema.parse(current); }
    if (invalid === "wrong schema") read.schema.version = 999;
    const event = store.event(run.run_id, "adapter.evidence", "Nonselectable typed inventory boundary", jsonSchema.parse(read));
    finish(store, owner);
    if (invalid === "out of interval") event.at = new Date(Date.parse(owner.ended_at!) + 1000).toISOString();
    expect(promotionEvidence(event, run, owner, store.eventsAfter(run.run_id, 0, 500))).toBeNull();
    if (invalid === "other run" || invalid === "other boot" || invalid === "dead player")
      expect(() => library.promote(store, run.run_id, owner, "Rejected typed inventory", declaration(event.event_seq))).toThrow();
  });
}

test("death episodes and improvement decisions deduplicate and preserve exact candidate version evidence", async () => {
  const { store, run, manager } = fixture();
  const first = await authored(manager, run), view = execution(store, run, first);
  const event = store.event(run.run_id, "fixture.authoritative_death", "Observed authoritative death");
  const episode = { death_id: "death-1", session_id: run.session_id!, life_id: run.life_id!, last_observation: observation(run), current_root_execution_id: view.execution_id, action_id: null, event_seqs: [event.event_seq] };
  store.recordDeathEpisode(run.run_id, episode); store.recordDeathEpisode(run.run_id, episode);
  view.status = "unknown"; view.ended_at = new Date().toISOString(); view.error = "Interrupted life";
  store.updateSkillExecution(view, "skill.closed", "Unknown interrupted effects");
  const learning = learningFixture(store);
  await learning.prepareFeedback(run.run_id, preparationOptions());
  const feedback = readImprovementFeedback(store, run.run_id);
  expect(Buffer.byteLength(JSON.stringify(feedback))).toBeLessThanOrEqual(65536);
  expect(feedback.opportunities.filter((value) => value.kind === "death")).toHaveLength(1);
  expect(feedback.opportunities.filter((value) => value.kind === "failure")).toHaveLength(1);
  await learning.prepareFeedback(run.run_id, preparationOptions());
  expect(readImprovementFeedback(store, run.run_id).opportunities).toHaveLength(2);
  expect(store.deathEpisodesPage(run.run_id).episodes).toHaveLength(1);
  const second = await manager.register(run.run_id, { entry: "run", name: first.name, source: 'const state = await game.observe(); return {status:"blocked",summary:"Current state reported",result:state.data.player.health};', card, dependencies: [] });
  const before = { run_id: run.run_id, skill_id: first.skill_id, version: first.version, hash: first.hash };
  const after = { run_id: run.run_id, skill_id: second.skill_id, version: second.version, hash: second.hash };
  const undispatched = store.admitSkill(run.run_id, { entry: "run", skill_id: after.skill_id, version: after.version,
    start_key: "never-dispatched", ...executionScopeFixture(run), args: null, limits: { ...DEFAULT_SKILL_LIMITS } }).view;
  undispatched.status = "cancelled"; undispatched.ended_at = new Date().toISOString();
  store.updateSkillExecution(undispatched, "skill.closed", "Cancelled before dispatch");
  const chosen = feedback.opportunities[0]!;
  const decision = { decision: "revise" as const, reason: "Model-authored candidate; not measured", revision: after, event_seqs: [event.event_seq] };
  expect(learning.resolve(run.run_id, chosen.opportunity_id, decision).resolution?.measured).toBe(false);
  expect(learning.resolve(run.run_id, chosen.opportunity_id, decision).resolution?.decision).toBe("revise");
  expect(() => learning.resolve(run.run_id, chosen.opportunity_id, { decision: "keep", reason: "Conflict", revision: null, event_seqs: [] })).toThrow();
  await learning.prepareFeedback(run.run_id, preparationOptions());
  const scope = { kind: "model" as const, run_id: run.run_id, model_id: run.model_id };
  const comparison = compareProgramVersions(store, before, after, scope);
  expect(comparison.sample_count).toEqual({ before: 1, after: 0 });
  expect(comparison.source_diff.added.join("\\n")).toContain("state.data.player.health");
  expect(comparison.conclusion).toBe("descriptive_only_no_causal_improvement_claim");
  const page = compareProgramVersionsPage(store, before, after, scope, null, 1);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
  expect(page.comparison.sample_count).toEqual({ before: 1, after: 0 });
  expect(page.comparison.samples.before).toHaveLength(1);
  expect(store.skill(run.run_id, first).source).toBe(first.source);
  expect(() => compareProgramVersions(store, { ...before, hash: "wrong" }, after, scope)).toThrow();
  expect(store.retainWorkingPrograms(run.run_id, run.session_id!).find((candidate) => candidate.root.version === second.version)?.measured_execution_ids).toEqual([]);
});

test("working candidates are same-session model-scoped definitions with no invocation state and freshly validated exact imports", async () => {
  const { store, run, manager } = fixture();
  const skill = await authored(manager, run), view = execution(store, run, skill);
  finish(store, view);
  const retained = store.retainWorkingPrograms(run.run_id, run.session_id!);
  expect(retained[0]?.qualification).toBe("working_candidate");
  expect(JSON.stringify(retained)).not.toContain("world_specific");
  expect(store.workingPrograms("another-model", run.session_id!)).toEqual([]);
  expect(store.workingPrograms(run.model_id, "another-session")).toEqual([]);
  const destination: StoredRun = { ...run, run_id: crypto.randomUUID(), baseline: {} };
  store.saveRun(destination);
  const imported = await store.hydrateWorkingPrograms(run.model_id, run.session_id!, destination.run_id, manager);
  expect(imported[0]?.hash).toBe(skill.hash);
  expect(imported[0]?.source).toBe(skill.source);
  expect(store.allSkillExecutions(destination.run_id)).toEqual([]);
});

test("legacy experience remains byte-identical and inspectable but cannot cross the schema2/protocol2 import fence", async () => {
  const { directory, library, run, manager } = fixture();
  const historical = JSON.stringify({
    experience_id: "legacy-immutable", name: "Historical fixture", model_id: run.model_id,
    profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r1",
    source_run_id: "old-run", source_world_id: run.world_id, portability: "portable", retained_world_data: false,
    compatibility: { ...HISTORICAL_PROGRAM_COMPATIBILITY_V3, observation_schema: 1, preset_id: "minecraft-observable-initial-r1", skill_protocol: 1 },
    root: { skill_id: "old-source", version: 1 }, created_at: "2026-01-01T00:00:00.000Z",
    evidence: { execution_id: "old-execution", action_ids: ["old-action"], predicate: { kind: "goal_verified", event_seq: 1 } }, skills: [],
  });
  const db = new Database(join(directory, "library", "experience.sqlite"));
  try {
    db.query("INSERT INTO bundles(id,model,payload) VALUES(?,?,?)").run("legacy-immutable", run.model_id, historical);
    expect(library.inspect("legacy-immutable", run.model_id)?.compatibility).toMatchObject({ observation_schema: 1, skill_protocol: 1 });
    expect(library.list(run.model_id, run.world_id)).toEqual([]);
    await expect(library.hydrate("legacy-immutable", run.model_id, run.world_id, run.run_id, manager)).rejects.toThrow();
    expect(db.query<{ payload: string }, [string]>("SELECT payload FROM bundles WHERE id=?").get("legacy-immutable")?.payload).toBe(historical);
  } finally { db.close(); }
});

test("same-model comparison authorization is enforced before either foreign source is read", async () => {
  const { store, run, manager } = fixture();
  const foreign: StoredRun = { ...run, run_id: crypto.randomUUID(), model_id: "other-model" };
  store.saveRun(foreign);
  const first = await authored(manager, foreign, "foreign");
  const second = await manager.register(foreign.run_id, { entry: "run", name: first.name, source: 'return {status:"blocked",summary:"Foreign version",result:null};', card, dependencies: [] });
  const ref = (skill: typeof first) => ({ run_id: foreign.run_id, skill_id: skill.skill_id, version: skill.version, hash: skill.hash });
  const read = store.skill.bind(store);
  let foreignReads = 0;
  store.skill = (runId, version) => { if (runId === foreign.run_id) foreignReads++; return read(runId, version); };
  expect(() => compareProgramVersionsPage(store, ref(first), ref(second), { kind: "model", run_id: run.run_id, model_id: run.model_id })).toThrow("requesting model scope");
  expect(foreignReads).toBe(0);
  await learningFixture(store).prepareFeedback(foreign.run_id, preparationOptions());
  expect(compareProgramVersionsPage(store, ref(first), ref(second), { kind: "operator" }).comparison.after.hash).toBe(second.hash);
});

test("fresh same-session working definitions replace stale names with a coherent exact dependency closure", async () => {
  const { store, run, manager } = fixture();
  const first = await authored(manager, run, "same-name");
  store.retainWorkingPrograms(run.run_id, run.session_id!);
  const fresh: StoredRun = { ...run, run_id: crypto.randomUUID() };
  store.saveRun(fresh);
  const dependency = await authored(manager, fresh, "fresh-dependency");
  const replacement = await authored(manager, fresh, "same-name", [{ skill_id: dependency.skill_id, version: dependency.version }]);
  expect(replacement.skill_id).not.toBe(first.skill_id);
  store.retainWorkingPrograms(fresh.run_id, fresh.session_id!);
  const next: StoredRun = { ...fresh, run_id: crypto.randomUUID() };
  store.saveRun(next);
  const imported = await store.hydrateWorkingPrograms(next.model_id, next.session_id!, next.run_id, manager);
  expect(imported.find((skill) => skill.name === "same-name")?.skill_id).toBe(replacement.skill_id);
  expect(store.skill(next.run_id, replacement).dependencies).toEqual([{ skill_id: dependency.skill_id, version: dependency.version }]);
  expect(store.workingPrograms(next.model_id, next.session_id!).every((candidate) => candidate.source_run_id === fresh.run_id)).toBe(true);
  expect(store.skill(run.run_id, first).source).toBe(first.source);
});

test("radian observation rotation uses shortest yaw across the pi seam", async () => {
  const { store, run, manager } = fixture();
  const skill = await authored(manager, run), view = execution(store, run, skill), trace = new ExecutionTrace(store);
  const first = observation(run); first.data.player.yaw = 3 * Math.PI / 4;
  const second = observation(run); second.observation_seq++; second.data.player.yaw = -3 * Math.PI / 4; second.data.player.pitch = Math.PI / 4;
  trace.observe(view, first); trace.observe(view, second);
  expect(objectiveMetrics(store, run.run_id)[0]!.sampled_rotation_degrees).toBeCloseTo(135);
});

test("death snapshot and detection event roll back together and commit before observers run", async () => {
  const { directory, store, run, manager } = fixture();
  const skill = await authored(manager, run), view = execution(store, run, skill);
  const db = new Database(join(directory, "runs", "runs.sqlite"));
  const episode = { death_id: "transactional-death", session_id: run.session_id!, life_id: run.life_id!, last_observation: observation(run), current_root_execution_id: view.execution_id, action_id: null, event_seqs: [] };
  try {
    db.exec("CREATE TRIGGER reject_death_event BEFORE INSERT ON events WHEN NEW.type='learning.death_episode' BEGIN SELECT RAISE(ABORT,'event append failure'); END;");
    expect(() => store.recordDeathEpisode(run.run_id, episode)).toThrow("event append failure");
    expect(store.deathEpisodesPage(run.run_id).episodes).toEqual([]);
    db.exec("DROP TRIGGER reject_death_event");
    let notifiedWithBothCommitted = false;
    const unsubscribe = store.subscribe((event) => {
      if (event.type === "learning.death_episode") notifiedWithBothCommitted = store.deathEpisodesPage(run.run_id).episodes.length === 1 && db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events WHERE type='learning.death_episode'").get()?.count === 1;
    });
    store.recordDeathEpisode(run.run_id, episode); unsubscribe();
    expect(notifiedWithBothCommitted).toBe(true);
    const reopened = new Store(join(directory, "runs"));
    const reader = new HistoryReader(reopened.readLocation());
    try {
      reopened.recordDeathEpisode(run.run_id, episode);
      await new ImprovementLearning(reopened, reader).prepareFeedback(run.run_id, preparationOptions());
      expect(readImprovementFeedback(reopened, run.run_id).opportunities.filter((opportunity) => opportunity.kind === "death")).toHaveLength(1);
    } finally {
      try { await reader.close(); } finally { reopened.close(); }
    }
  } finally { db.close(); }
});

test("known branch losses and unknown abrupt tails mark diagnostics incomplete without discarding real effects", async () => {
  const { store, run, manager } = fixture();
  const skill = await authored(manager, run), view = execution(store, run, skill), trace = new ExecutionTrace(store);
  action(store, run, view, { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: { stone: 1 } });
  trace.record(view, "branch", { diagnostic_only: true, events: [], omitted: 3, tail_incomplete: false, loss_reason: null });
  let metric = objectiveMetrics(store, run.run_id)[0]!;
  expect(metric.trace_complete).toBe(false);
  expect(metric.inventory_delta).toEqual({ stone: 1 });
  expect(metric.limitations.some((text) => text.includes("worker budget"))).toBe(true);
  trace.record(view, "branch", { diagnostic_only: true, events: [], omitted: 0, tail_incomplete: true, loss_reason: "worker_terminated" });
  metric = objectiveMetrics(store, run.run_id)[0]!;
  expect(metric.limitations.some((text) => text.includes("worker_terminated") && text.includes("count is unknown"))).toBe(true);
  expect(store.tracePage(run.run_id).budget.omitted_records).toBe(0);
  expect(programEvidence(store, run.run_id)[0]!.evidence_status).toBe("confirmed_effects");
});

test("trace paging reserves the final false envelope byte at the exact 64 KiB boundary", async () => {
  const { store, run, manager } = fixture();
  const skill = await authored(manager, run), view = execution(store, run, skill), trace = new ExecutionTrace(store);
  trace.record(view, "capability_result", { text: "x".repeat(22000) });
  trace.record(view, "capability_result", { text: "x".repeat(22000) });
  const seed = trace.record(view, "capability_result", { text: "" })!;
  const current = store.tracePage(run.run_id);
  let padding = 0;
  for (let iteration = 0; iteration < 4; iteration++) {
    const record = { ...seed, trace_seq: seed.trace_seq + 1, payload: { text: "x".repeat(padding) } };
    const { trace_seq: _seq, ...stored } = record;
    const candidate = { ...current, records: [...current.records, record], next_after: record.trace_seq, has_more: false,
      budget: { ...current.budget, recorded: current.budget.recorded + 1, bytes: current.budget.bytes + Buffer.byteLength(JSON.stringify(stored)) } };
    padding += 65537 - Buffer.byteLength(JSON.stringify(candidate));
  }
  trace.record(view, "capability_result", { text: "x".repeat(padding) });
  const page = store.tracePage(run.run_id);
  expect(page.records).toHaveLength(3);
  expect(page.has_more).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
  const last = store.tracePage(run.run_id, page.next_after);
  expect(last.records).toHaveLength(1);
  expect(last.has_more).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThanOrEqual(65536);
});

test("feedback omission metadata cannot overfill a nearly full metrics page", async () => {
  const { store, run, manager } = fixture();
  const skill = await authored(manager, run);
  const first = execution(store, run, skill), second = execution(store, run, skill), oversized = execution(store, run, skill);
  const counts = (length: number) => Object.fromEntries(Array.from({ length }, (_, index) => [`fixture_item_${index}`, 1]));
  action(store, run, first, { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: counts(1000) });
  const oversizedAction = action(store, run, oversized, { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: counts(10000) });
  const admitted = store.admitAction(run.run_id, crypto.randomUUID(), { kind: "look", yaw: 0, pitch: 0 }, "skill", second.execution_id, actionAuthority(run, second));
  const learning = learningFixture(store);
  const delta: Record<string, number> = {};
  admitted.action.view.status = "succeeded";
  admitted.action.view.ended_at = new Date().toISOString();
  admitted.action.view.result = { status: "succeeded", summary: "Receipt fixture", evidence: { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: delta } };
  store.saveAction(run.run_id, admitted.action.view);
  await learning.prepareFeedback(run.run_id, preparationOptions());
  const baseline = readImprovementFeedback(store, run.run_id);
  expect(baseline.omitted).toHaveLength(1);
  const predictedBytes = () => Buffer.byteLength(JSON.stringify({
    ...baseline, omitted: [], has_more: true,
    metrics: baseline.metrics.map(value => value.kind === "replace" && value.execution_id === second.execution_id
      ? { ...value, metric: { ...value.metric, inventory_delta: delta } } : value),
  }));
  let index = 0;
  while (predictedBytes() < 65300) delta[`fixture_gain_${index++}`] = 1;
  const remaining = 65400 - predictedBytes();
  expect(remaining).toBeGreaterThan(10);
  delta[`p${"x".repeat(remaining - 6)}`] = 1;
  expect(predictedBytes()).toBe(65400);
  // Change each actual contribution in order, then read only this generation's
  // replacements rather than treating update sequences as insertion ordinals.
  action(store, run, first, { effect_confirmed: true, inventory_receipt_confirmed: true,
    inventory_before: {}, inventory_after: { x: 1 } });
  store.saveAction(run.run_id, admitted.action.view);
  oversizedAction.result!.evidence = { effect_confirmed: true, inventory_receipt_confirmed: true,
    inventory_before: {}, inventory_after: counts(10000), native_action_ms: 1 };
  store.saveAction(run.run_id, oversizedAction);
  await learning.prepareFeedback(run.run_id, preparationOptions());
  const checkpoint = store.historyProjectionCheckpoint(run.run_id);
  const sourceThrough = store.historySourceHighwater(run.run_id), eventThrough = store.lastEventSeq();
  const page = readImprovementFeedback(store, run.run_id, baseline.next_after);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
  expect(page.has_more).toBe(true);
  const delivered = [...page.metrics], omissions = [...page.omitted];
  let last = page;
  while (last.has_more) {
    const next = readImprovementFeedback(store, run.run_id, last.next_after);
    expect(Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: next }) + "\n")).toBeLessThanOrEqual(65536);
    expect(next.next_after.metric_change_seq).toBeGreaterThan(last.next_after.metric_change_seq);
    delivered.push(...next.metrics); omissions.push(...next.omitted); last = next;
  }
  expect(delivered.filter(value => value.execution_id === first.execution_id)).toHaveLength(1);
  const replacements = delivered.filter(value => value.execution_id === second.execution_id);
  expect(replacements).toHaveLength(1);
  expect(replacements[0]!.kind).toBe("replace");
  if (replacements[0]!.kind !== "replace") throw new Error("Expected a retained metric replacement");
  expect(replacements[0]!.metric.inventory_delta).toEqual(delta);
  expect(omissions.map(omission => omission.id)).toEqual([oversized.execution_id]);
  const reference = omissions[0]!.reference;
  if (!reference || typeof reference !== "object" || Array.isArray(reference) ||
    typeof reference.generation !== "number" || typeof reference.url !== "string")
    throw new Error("Oversized feedback metric must retain an exact HTTP metric reference");
  expect(reference.url).toContain(`/objective-metrics/${oversized.execution_id}?generation=${reference.generation}`);
  const expected = objectiveMetrics(store, run.run_id).find(value => value.execution_id === oversized.execution_id)!;
  let after = { record_index: 0, chunk_index: 0 };
  const chunks: string[] = [];
  const named = new ProgramWorkspace(store, run.run_id);
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(1000);
    const exported = dispatchHistoryQuery(store, { kind: "model_inspect", run_id: run.run_id,
      input: { view: "metric", program: { name: skill.name, version: skill.version },
        execution_ordinal: store.executionReferences(run.run_id, oversized.execution_id)[0]!.execution_ordinal,
        generation: reference.generation, after, limit: 1 } });
    if (!exported || typeof exported !== "object" || Array.isArray(exported) ||
      !Array.isArray(exported.records) || !exported.next_after || typeof exported.next_after !== "object" || Array.isArray(exported.next_after))
      throw new Error("Expected a named metric archive page");
    for (const record of exported.records) {
      if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.text !== "string")
        throw new Error("Oversized metric must remain losslessly chunked");
      chunks.push(record.text);
    }
    expect(Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: exported }) + "\n")).toBeLessThanOrEqual(65536);
    if (!exported.has_more) {
      expect(JSON.parse(chunks.join(""))).toEqual(named.metricView(expected));
      break;
    }
    const next = exported.next_after;
    if (typeof next.record_index !== "number" || typeof next.chunk_index !== "number")
      throw new Error("Metric archive must return a logical continuation");
    after = { record_index: next.record_index, chunk_index: next.chunk_index };
  }
  expect(store.historyProjectionCheckpoint(run.run_id)).toEqual(checkpoint);
  expect(store.historySourceHighwater(run.run_id)).toBe(sourceThrough);
  expect(store.lastEventSeq()).toBe(eventThrough);
}, 180_000);

test("durable latest-root lookup survives more than 100 sequential children without expanding presentation snapshots", async () => {
  const { store, run, manager } = fixture();
  const skill = await authored(manager, run), root = execution(store, run, skill);
  for (let index = 0; index < 101; index++) {
    const child = store.admitSkill(run.run_id, { entry: "run",
      skill_id: skill.skill_id, version: skill.version, start_key: `child-${index}`,
      ...executionScopeFixture(run),
      args: null, limits: { ...DEFAULT_SKILL_LIMITS },
    }, { parent_execution_id: root.execution_id, root_execution_id: root.execution_id }).view;
    child.status = "running"; child.started_at = new Date().toISOString();
    store.updateSkillExecution(child, "skill.running", "Child dispatched");
    finish(store, child);
  }
  root.calls = 101;
  store.updateSkillExecution(root, "skill.progress", "Sequential child calls settled");
  if (root.entry !== "run") throw new Error("Expected the selected run root");
  expect(root.calls).toBeLessThan(root.limits.max_calls);
  const presentation = store.skillExecutions(run.run_id);
  expect(presentation).toHaveLength(100);
  expect(presentation.every((execution) => execution.parent_execution_id === root.execution_id)).toBe(true);
  expect(store.latestRootExecution(run.run_id)?.execution_id).toBe(root.execution_id);
  expect(store.latestRootExecution(run.run_id)?.status).toBe("running");
  finish(store, root);
  expect(store.latestRootExecution(run.run_id)?.status).toBe("succeeded");
  const next = execution(store, run, skill);
  expect(store.latestRootExecution(run.run_id)?.execution_id).toBe(next.execution_id);
  const empty: StoredRun = { ...run, run_id: crypto.randomUUID() };
  store.saveRun(empty);
  expect(store.latestRootExecution(empty.run_id)).toBeNull();
});

test("invalid decision/revision pairs reject actionably without a record before an explicit candidate-experiment correction", async () => {
  const { store, library, run, manager } = fixture();
  const first = await authored(manager, run), firstExecution = execution(store, run, first);
  finish(store, firstExecution);
  const learning = learningFixture(store);
  await learning.prepareFeedback(run.run_id, preparationOptions());
  const opportunity = readImprovementFeedback(store, run.run_id).opportunities.find((value) => value.execution_id === firstExecution.execution_id)!;
  const second = await manager.register(run.run_id, { entry: "run",
    name: first.name,
    source: 'const state = await game.observe(); return {status:"completed",summary:"Candidate observation experiment",result:state.data.player.health};',
    card, dependencies: [],
  });
  const secondExecution = execution(store, run, second);
  finish(store, secondExecution);
  const evidence = store.eventsAfter(run.run_id, 0, 500).find((event) => event.type === "skill.closed" && event.details && typeof event.details === "object" && !Array.isArray(event.details) && event.details.execution_id === secondExecution.execution_id)!;
  const revision = { run_id: run.run_id, skill_id: second.skill_id, version: second.version, hash: second.hash };
  const reason = "Performed the candidate v2 trial; observations are descriptive and do not establish better efficacy.";
  const beforeSeq = store.lastEventSeq();
  let rejection: unknown;
  try {
    learning.resolve(run.run_id, opportunity.opportunity_id, { decision: "insufficient_evidence", reason, revision, event_seqs: [evidence.event_seq] });
  } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(RuntimeFault);
  if (!(rejection instanceof RuntimeFault)) throw new Error("Expected a typed semantic rejection");
  expect(rejection.code).toBe("invalid_request");
  expect(store.lastEventSeq()).toBe(beforeSeq);
  expect(readImprovementFeedback(store, run.run_id).opportunities.find((value) => value.opportunity_id === opportunity.opportunity_id)?.resolution).toBeNull();
  const corrected = { decision: "revise" as const, reason, revision, event_seqs: [evidence.event_seq] };
  const accepted = learning.resolve(run.run_id, opportunity.opportunity_id, corrected);
  expect(accepted.resolution?.decision).toBe("revise");
  expect(accepted.resolution?.revision).toEqual(revision);
  expect(accepted.resolution?.measured).toBe(true);
  expect(learning.resolve(run.run_id, opportunity.opportunity_id, corrected)).toEqual(accepted);
  const resolutions = store.eventsAfter(run.run_id, 0, 500).filter((event) => event.type === "learning.resolved");
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]?.details).toMatchObject({ qualification: "measured_not_causally_proven" });
  expect(library.list(run.model_id, run.world_id)).toEqual([]);
  expect(store.skill(run.run_id, first).hash).toBe(first.hash);
  expect(store.skill(run.run_id, second).hash).toBe(second.hash);
});
