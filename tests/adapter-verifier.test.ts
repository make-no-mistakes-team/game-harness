import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import type { AuthManager } from "../src/server/auth.ts";
import type { GameBridge, ObservationV3, RuntimeAdapter, VerificationManifest } from "../src/shared/contracts.ts";
import { adapterDescriptorSchema } from "../src/shared/adapter.ts";
import { minecraftObservationV3Schema, type HistoricalObservationV2, type MinecraftObservation } from "../src/shared/minecraft.ts";
import { observationEvidence } from "../src/server/adapter-evidence.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { Runtime } from "../src/server/runtime.ts";
import { Store } from "../src/server/store.ts";
import { HISTORICAL_NATURAL_SCENARIOS_V1, captureHistoricalGoalBaselineV1, verifyHistoricalScenarioGoalV1, type GoalAction } from "../src/evaluation/scenarios.ts";
import { activeObservation, binding, descriptor, effectScope, historicalObservation, minecraftTestAdapter, schemaCatalog, sha256 } from "./helpers/adapter-contract.ts";

type Verdict = "verified" | "failed" | "incomplete" | "unknown";
const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0)) await close(); });

async function runtimeFixture(custom = false, unsupportedVerifier = false) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-adapter-verifier-"));
  const store = new Store(directory), scope = effectScope();
  let sequence = 0, verdict: Verdict = "incomplete", effects = 0, disconnects = 0;
  const value = adapterDescriptorSchema.parse(descriptor());
  value.game = { id: "contract_fixture_only", version: "1" };
  value.adapter.id = "contract_fixture_only";
  const schemas = { ...schemaCatalog(), payload: { type: "object", properties: { fixture_counter: { type: "integer" },
    permitted_message: { type: "string" } }, required: ["fixture_counter", "permitted_message"], additionalProperties: false }, capabilities: {} };
  value.capabilities = [];
  value.observation.payload_schema = { id: "contract_fixture_counter_v1", version: 1, hash: sha256(schemas.payload) };
  value.observation.profile = { id: "contract_fixture_counter_v1", version: 1, configuration: { counter_threshold: 9 },
    configuration_hash: sha256({ counter_threshold: 9 }) };
  const actualDescriptor = adapterDescriptorSchema.parse(value);
  const currentBinding = { ready: true, native_boot_id: scope.native_boot_id, compatibility_hash: sha256(actualDescriptor), descriptor: actualDescriptor };
  const observation = () => ({ ...activeObservation({ fixture_counter: 9, permitted_message: "own visible state" }, ++sequence),
    compatibility_hash: currentBinding.compatibility_hash, profile_id: value.observation.profile.id,
    profile_configuration_hash: value.observation.profile.configuration_hash,
    space: { dimension_id: "fixture-space", space_epoch: scope.space_epoch } });
  const contexts: unknown[] = [], tools = new Map<string, AgentTool>(), prompted = Promise.withResolvers<void>();
  void prompted.promise.catch(() => {});
  const payload = (input: ObservationV3) => {
    const data = input.data;
    if (data === null || typeof data !== "object" || Array.isArray(data) || typeof data.fixture_counter !== "number")
      throw new Error("Synthetic counter fixture requires its actual registered payload");
    return data;
  };
  const adapter: RuntimeAdapter & { evaluator_only: unknown } = {
    descriptor: actualDescriptor, schemas, action_capability: null, supports_respawn: false, bindings: [],
    effectDeadlineMs: () => { throw new Error("Counter fixture declares no effect capability"); },
    goals: [{ adapter_id: value.adapter.id, goal_id: "fixture_goal",
      verifier: { id: "fixture_visible_counter", version: 1 }, parameters: { threshold: 9 } }],
    // Separate trusted evaluator state must never be serialized as actor context.
    evaluator_only: { seed: "hidden-fixture-seed", fight_state: "hidden-fixture-fight",
      annotations: ["hidden-fixture-annotation"] },
    projectObservation: input => ({ state: payload(input),
      summary: "Contract-only visible counter", metadata: { counter_unit: "fixture_events" } }),
    captureBaseline: (_goal, input) => ({ seq: input.observation_seq, counter: payload(input).fixture_counter! }),
    verifyCompletion: manifest => {
      if (!manifest.goal.verifier) throw new Error("Unverified custom completion has no counter verifier authority");
      return ({
      adapter_id: value.adapter.id, verifier_id: manifest.goal.verifier.id, verifier_version: manifest.goal.verifier.version,
      status: verdict, reason: "fixture_visible_counter_predicate", evidence_refs: verdict === "verified" ? ["fixture-observation-2"] : [],
      });
    },
  };
  // This adapter implements only an interface fixture, not a Freedoom engine,
  // supported game, real GUI proof producer or native gameplay capability.
  const game = {
    connect: async () => {}, disconnect: async () => { disconnects++; },
    snapshot: () => ({ status: "connected", username: "fixture", version: "1", world_id: scope.world_id,
      session_id: scope.session_id, epoch: scope.epoch, life: { life_id: scope.life_id, status: "alive", can_respawn: false, death: null },
      binding: currentBinding, space: { dimension_id: "fixture-space", space_epoch: scope.space_epoch }, screen: null,
      presentation: null, last_observation_at: null, error: null,
      video: { status: "streaming", width: 2, height: 2, fps: 30, frames: 1, last_frame_at: null, error: null } }),
    observe: async () => observation(), neutralize: async () => {}, cancel: async () => {},
    adapter: () => adapter, emergencyStop: async () => {},
    execute: async () => { effects++; throw new Error("No effects are permitted in verifier dispatch fixture"); },
    subscribe: () => () => {},
  } as unknown as GameBridge;
  const selectTools = (selected: AgentTool[]) => { for (const tool of selected) tools.set(tool.name, tool); };
  const hooks = new DiagnosticModelHooks();
  const agent = { addBeforeModelCallHook: hooks.add, setBeforeModelCall: () => {}, setTools: selectTools, subscribe: () => () => {},
    replaceMessages: () => {}, prompt: async (text: string) => { contexts.push(JSON.parse(text)); prompted.resolve(); },
    abort: () => {}, waitForIdle: async () => {} } as unknown as Agent;
  const auth = { snapshot: () => ({ status: "ready", models: [{ id: "fixture-model", input_modalities: ["text"] }] }),
    createAgent: async (configuration: { tools: AgentTool[] }) => { selectTools(configuration.tools); return agent; },
    releaseAgent: async () => {} } as unknown as AuthManager;
  const sandbox = { snapshot: () => ({ status: "ready", error: null }) } as unknown as SandboxService;
  const options = { adapter, actorFrames: undefined };
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, options);
  resources.push(async () => { await runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  await runtime.initialize();
  const registeredGoal = adapter.goals[0];
  if (!registeredGoal) throw new Error("Missing synthetic counter goal");
  const selectedGoal = custom ? { adapter_id: value.adapter.id, goal_id: "custom", verifier: null, parameters: {} }
    : unsupportedVerifier ? { ...registeredGoal, verifier: { id: "unregistered-verifier", version: 99 } } : registeredGoal;
  if (!selectedGoal) throw new Error("Missing explicit synthetic fixture goal");
  const run = await runtime.createRun({ task: "Contract-only visible counter goal",
    goal: selectedGoal, model_id: "fixture-model", working_programs: "fresh" });
  const stopWatching = store.subscribe(event => {
    if (event.run_id !== run.run_id || event.type !== "run.state") return;
    const current = runtime.snapshot();
    if (current && ["paused", "failed", "stopped"].includes(current.status))
      prompted.reject(new Error(`Counter fixture did not enter its actual strategic prompt: ${JSON.stringify({ status: current.status, error: current.error })}`));
  });
  try { await runtime.control(run.run_id, "start"); await prompted.promise; }
  finally { stopWatching(); }
  return { runtime, store, run, contexts, tools, game, adapter,
    setVerdict: (next: Verdict) => { verdict = next; }, counters: () => ({ effects, disconnects }) };
}

test("generic Runtime consumes adapter payload/projection without Minecraft player or inventory emulation", async () => {
  const f = await runtimeFixture();
  const selected = await f.runtime.modelObservation();
  expect(selected.observation).toHaveProperty("data", { fixture_counter: 9, permitted_message: "own visible state" });
  expect(selected.observation).not.toHaveProperty("player");
  expect(selected.images).toEqual([]);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.contexts.length).toBeGreaterThan(0);
  const prompt = JSON.stringify(f.contexts);
  expect(prompt).toContain("fixture_counter");
  expect(prompt).not.toContain('"inventory"');
  expect(prompt).not.toContain('"hunger"');
  expect(f.counters()).toEqual({ effects: 0, disconnects: 0 });
});

test("an unregistered goal verifier cannot silently inherit the adapter's successful predicate", async () => {
  await expect(runtimeFixture(false, true)).rejects.toThrow();
});

for (const verdict of ["verified", "failed", "incomplete", "unknown"] as const) {
  test(`adapter ${verdict} verdict never becomes a different completion claim`, async () => {
    const f = await runtimeFixture(); f.setVerdict(verdict);
    await f.runtime.modelObservation();
    await new Promise<void>(resolve => setImmediate(resolve));
    const events = f.store.eventsAfter(f.run.run_id, 0, 500);
    const verified = events.filter(event => event.type === "goal.verified");
    expect(events.filter(event => event.type === "goal.verification").some(event =>
      event.details !== null && typeof event.details === "object" && !Array.isArray(event.details) &&
      event.details.status === verdict)).toBe(true);
    expect(verified).toHaveLength(verdict === "verified" ? 1 : 0);
    if (verdict === "verified") expect(verified[0]!.details).toMatchObject({
      adapter_id: "contract_fixture_only", verifier_id: "fixture_visible_counter", verifier_version: 1,
      status: "verified", evidence_refs: ["fixture-observation-2"],
    });
    else expect(f.runtime.snapshot()?.status).not.toBe("completed");
    expect(f.counters()).toEqual({ effects: 0, disconnects: 0 });
  });
}

test("custom task_finish remains unverified and retains strict:false with host argument validation", async () => {
  const f = await runtimeFixture(true);
  const finish = f.tools.get("task_finish");
  expect(finish).toBeDefined();
  expect(finish!.strict).toBe(false);
  const invalid = await finish!.execute("invalid-finish", { all_requested_work_complete: true, summary: "Report only", scope: effectScope() });
  expect(invalid.isError).toBe(true);
  const response = await finish!.execute("custom-finish", { all_requested_work_complete: true, summary: "Own visible counter is nine" });
  expect(response).not.toMatchObject({ isError: true });
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  expect(events.some(event => event.type === "goal.verified")).toBe(false);
  expect(events.filter(event => event.type === "task.completion_reported")).toHaveLength(1);
  expect(events.find(event => event.type === "task.completion_reported")!.details).toMatchObject({ verification: "unverified" });
});

test("a built-in adapter goal cannot substitute model-reported task_finish for verifier authority", async () => {
  const f = await runtimeFixture();
  const finish = f.tools.get("task_finish")!;
  const response = await finish.execute("forged-built-in-finish", { all_requested_work_complete: true, summary: "Trust the model" });
  expect(response.isError).toBe(true);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).some(event => event.type === "goal.verified")).toBe(false);
});

test("private evaluator state never enters actor observations, prompts, ordinary tools or logs", async () => {
  const f = await runtimeFixture();
  const observe = f.tools.get("observe")!;
  const response = await observe.execute("actor-observation", {});
  const rejected = await observe.execute("actor-invalid-query", { seed: true });
  await new Promise<void>(resolve => setImmediate(resolve));
  const publicBytes = JSON.stringify({ observation: response, error: rejected, prompts: f.contexts,
    events: f.store.eventsAfter(f.run.run_id, 0, 500), snapshot: f.runtime.snapshot() });
  for (const secret of ["hidden-fixture-seed", "hidden-fixture-fight", "hidden-fixture-annotation"])
    expect(publicBytes).not.toContain(secret);
});

function historicalMinecraftObservation(inventory: Record<string, number>, sequence: number): HistoricalObservationV2 {
  const current = historicalObservation();
  return { ...current, observation_seq: sequence,
    captured_at: new Date(Date.parse(current.captured_at) + sequence * 1000).toISOString(),
    player: { ...current.player, inventory: Object.entries(inventory).map(([name, count], slot) => ({ name, count, slot, display_name: name })) } };
}
const minecraftPredicateFixture = minecraftTestAdapter("balanced", { now: () => Date.parse("2026-10-22T00:00:06Z") });
function minecraftObservation(inventory: Record<string, number>, sequence: number): MinecraftObservation {
  const old = historicalMinecraftObservation(inventory, sequence);
  return minecraftObservationV3Schema.parse({ ...activeObservation({ player: old.player, blocks: [], entities: [], sounds: [] }, sequence),
    epoch: old.epoch, life: { ...old.life }, captured_at: old.captured_at,
    compatibility_hash: sha256(minecraftPredicateFixture.descriptor) });
}
function minecraftBaseline(current: ReturnType<typeof minecraftObservation>) {
  const goal = minecraftPredicateFixture.goals.find(goal => goal.goal_id === "craft_crafting_table")!;
  return { observation_seq: current.observation_seq, manifest: { goal, run_id: "run", world_id: current.world_id,
    session_id: current.session_id, epoch: current.epoch, native_boot_id: current.native_boot_id,
    baseline: minecraftPredicateFixture.captureBaseline(goal, current) } satisfies VerificationManifest };
}
const productionFactSchema = minecraftPredicateFixture.schemas.evidence!["minecraft_item_production_v1@1"]!;
function factAction(item = "crafting_table", before: Record<string, number> = { oak_planks: 4 }, after: Record<string, number> = { crafting_table: 1 }) {
  return { run_id: "run", fingerprint: "fact-fixture", request: { kind: "look", yaw: 0, pitch: 0 }, view: {
    scope: { ...effectScope(), run_id: "run", epoch: 1, life_id: 1, execution_id: "invocation" },
    invocation: { kind: "skill", execution_id: "invocation", source_hash: effectScope().source_hash },
    compatibility_hash: sha256(minecraftPredicateFixture.descriptor),
    action_id: "production", kind: "look", session_id: "contract-session", life_id: 1, status: "succeeded", origin: "skill", execution_id: "invocation",
    summary: "Contract-only authoritative effect fact", started_at: "2026-10-22T00:00:02Z", ended_at: "2026-10-22T00:00:03Z",
    result: { status: "succeeded", summary: "Typed effect fact", evidence: {
      facts: [{ evidence_id: "fact-production", adapter_id: "fabric-owned-client",
        schema: { id: "minecraft_item_production_v1", version: 1, hash: sha256(productionFactSchema) },
        scope: { ...effectScope(), epoch: 1, life_id: 1, run_id: "run", execution_id: "invocation" },
        observed_at: "2026-10-22T00:00:03Z", data: { kind: "item_production", item,
          actor: "own_player", mechanism: "helper", input_application: "confirmed", effect_status: "confirmed",
          inventory_before: before, inventory_after: after, receipt_ref: "native-inventory-receipt" } }],
    } },
  } } satisfies GoalAction;
}
function verifyNewCriterion(combined: boolean, baseline: ReturnType<typeof minecraftBaseline>, current: ReturnType<typeof minecraftObservation>, actions: ReturnType<typeof factAction>[]) {
  const goal = minecraftPredicateFixture.goals.find(goal => goal.goal_id === (combined ? "collect_and_craft_table" : "craft_crafting_table"))!;
  const read = observationEvidence(minecraftPredicateFixture, { ...effectScope(), run_id: "run", epoch: 1, life_id: 1 }, current);
  // Interpreter contract only: these explicit fixture facts are not produced by
  // an arbitrary look action in production and are not live gameplay evidence.
  return minecraftPredicateFixture.verifyCompletion({ ...baseline.manifest, goal },
    [...actions.flatMap(action => action.view.result.evidence.facts), read]);
}

test("new Minecraft craft criterion consumes authoritative production facts, not action.kind=craft", () => {
  const baseline = minecraftBaseline(minecraftObservation({}, 1));
  const result = verifyNewCriterion(false, baseline, minecraftObservation({ crafting_table: 1 }, 5), [factAction()]);
  expect(result).toMatchObject({ status: "verified", verifier_id: "minecraft_possession_v2" });
  expect(result.evidence_refs).toContain("fact-production");
});

test("combined criterion retains pre-consumption own wood proof through typed effect facts", () => {
  const baseline = minecraftBaseline(minecraftObservation({}, 1));
  const consumed = factAction("oak_planks", { oak_log: 1 }, { oak_planks: 4 });
  consumed.view.action_id = "pre-consumption";
  consumed.view.started_at = "2026-10-22T00:00:01Z"; consumed.view.ended_at = "2026-10-22T00:00:02Z";
  const facts = consumed.view.result.evidence.facts;
  facts[0]!.evidence_id = "own-wood-before-consumption"; facts[0]!.observed_at = "2026-10-22T00:00:02Z";
  const result = verifyNewCriterion(true, baseline, minecraftObservation({ crafting_table: 1 }, 5), [consumed, factAction()]);
  expect(result.status).toBe("verified");
  expect(result.evidence_refs).toContain("own-wood-before-consumption");
  expect(result.evidence_refs).toContain("fact-production");
});

for (const rejection of ["foreign actor", "foreign run", "foreign life", "unconfirmed application", "unknown effect", "stale observation", "dead possession", "baseline wood only"] as const) {
  test(`Minecraft typed evidence rejects ${rejection} without relabeling it verified`, () => {
    const baseline = minecraftBaseline(minecraftObservation(rejection === "baseline wood only" ? { oak_log: 1 } : {}, 1));
    const current = minecraftObservation({ crafting_table: 1 }, 5), produced = factAction();
    const fact = produced.view.result.evidence.facts[0]!;
    switch (rejection) {
      case "foreign actor": fact.data.actor = "other_player"; break;
      case "foreign run": fact.scope.run_id = "other-run"; break;
      case "foreign life": fact.scope.life_id = 0; break;
      case "unconfirmed application": fact.data.input_application = "unknown"; break;
      case "unknown effect": fact.data.effect_status = "unknown"; break;
      case "stale observation": current.observation_seq = baseline.observation_seq; break;
      case "dead possession": current.life.status = "dead"; break;
      case "baseline wood only": fact.data.inventory_before = { oak_log: 1 }; break;
    }
    const result = verifyNewCriterion(rejection === "baseline wood only", baseline, current, [produced]);
    expect(["failed", "incomplete", "unknown"]).toContain(result.status);
  });
}

test("original natural_collection_craft_v1 criterion/report remains immutable and independently readable", () => {
  const original = HISTORICAL_NATURAL_SCENARIOS_V1.find(value => value.id === "collect_and_craft_table")!;
  expect(original.verifier.revision).toBe("natural_collection_craft_v1");
  const baseline = captureHistoricalGoalBaselineV1("run", historicalMinecraftObservation({}, 1));
  const before = JSON.stringify(original);
  const result = verifyHistoricalScenarioGoalV1(original, baseline, "run", historicalMinecraftObservation({ crafting_table: 1 }, 5), [factAction()]);
  expect(result).toMatchObject({ verified: false, evidence_status: "not_verified" });
  expect(JSON.stringify(original)).toBe(before);
});
