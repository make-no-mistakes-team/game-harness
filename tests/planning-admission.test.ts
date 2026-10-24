import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservationV3 } from "../src/shared/contracts.ts";
import type { SkillView } from "../src/shared/programs.ts";
import { SkillManager } from "../src/server/skills.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const resources: { manager: SkillManager; planner: SpeculativePlanning; store: Store; directory: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.planner.invalidate();
    await resource.manager.closeAll("Test complete");
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  { activation: "manual", order: "stage_first" },
  { activation: "on_predecessor_success", order: "stage_first" },
  { activation: "on_predecessor_success", order: "closure_first" },
] as const) {
test(`real durable ${scenario.activation} admission after ${scenario.order} preserves running predecessor and fresh game guard`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-plan-admission-"));
  const store = new Store(directory), adapter = minecraftTestAdapter();
  const run = minecraftRunFixture(adapter, { task: "Observe authorized state" });
  const goal = adapter.goals.find(goal => goal.goal_id === "custom")!;
  store.saveRun(run);
  let sequence = 0;
  const observe = async (): Promise<ObservationV3> => minecraftObservationFixture(adapter, { observation_seq: ++sequence });
  const started = Promise.withResolvers<void>();
  const continueRoot = Promise.withResolvers<void>();
  const continued = Promise.withResolvers<void>();
  const finishRoot = Promise.withResolvers<void>();
  const closed = new Map<string, () => void>();
  const unsafe: unknown[] = [];
  let planner: SpeculativePlanning;
  let rootId = "";
  let rootSource: SkillView;
  const runner: SandboxService["runSkill"] = async (_source, args, handle, _limits, signal) => {
    const revoked = Promise.withResolvers<void>();
    const onAbort = () => revoked.resolve();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (args === "predecessor") {
        started.resolve();
        await Promise.race([continueRoot.promise, revoked.promise]);
        if (!signal?.aborted) await handle({ kind: "observe" });
        continued.resolve();
        await Promise.race([finishRoot.promise, revoked.promise]);
      } else if (!signal?.aborted) await handle({ kind: "observe" });
      return { status: "completed", summary: "Neutral fixture finished", result: null };
    } finally { signal?.removeEventListener("abort", onAbort); }
  };
  const manager = new SkillManager(store, { runSkill: runner }, {
    authorize: scope => {
      if (scope.run_id !== run.run_id || scope.epoch !== 1 || scope.session_id !== "session" || scope.life_id !== 1 ||
        scope.native_boot_id !== run.native_boot_id || scope.space_epoch !== run.space_epoch || run.status !== "running") throw new Error("Revoked admission");
    },
    adapter: () => adapter, binding: () => minecraftTestBinding(adapter),
    observe,
    action: async () => { throw new Error("No effects are permitted in this regression"); },
    queryCapability: async () => [],
    recover: async () => { throw new Error("No recovery in this regression"); },
    cancelActions: async () => {},
    prepareLookahead: (config) => planner.prepareOptIn(config),
    changed: (wake, execution) => {
      if (wake && execution) {
        planner.predecessorSettled(execution.root_execution_id);
        closed.get(execution.execution_id)?.();
      }
    },
    unsafe: () => { unsafe.push("Unconfirmed cleanup"); },
  });
  planner = new SpeculativePlanning({
    contract: () => adapter,
    admissionContext: () => ({
      run_id: run.run_id, generation: 1, session_id: "session", world_id: "world", epoch: 1,
      life_id: 1, life_status: "alive", task: run.task, goal,
      native_boot_id: run.native_boot_id!, space_epoch: run.space_epoch!, compatibility_hash: run.compatibility_hash!, screen: null,
    }),
    context: () => {
      const root = store.latestRootExecution(run.run_id);
      return root ? {
        run_id: run.run_id, generation: 1, session_id: "session", world_id: "world", epoch: 1,
        life_id: 1, life_status: "alive", task: run.task, goal,
        native_boot_id: run.native_boot_id!, space_epoch: run.space_epoch!, compatibility_hash: run.compatibility_hash!, screen: null,
        root: { execution_id: root.execution_id, skill_id: root.skill_id, version: root.version, hash: store.skill(run.run_id, root).hash, status: root.status },
      } : null;
    },
    skill: (ref) => store.skill(run.run_id, ref), observe,
    evaluateGuard: async (_source, observation, args) => {
      expect(observation.observation_seq).toBe(2);
      expect(args).toBeNull();
      expect(observation).not.toHaveProperty("predecessor");
      expect(observation).not.toHaveProperty("task");
      return true;
    },
    admit: async (request, permit) => { permit.assertCurrent(); return manager.start(run.run_id, request); },
    evidence: (type, details) => { store.event(run.run_id, type, type, details); },
    wake: () => {},
  });
  resources.push({ manager, planner, store, directory });
  const card = { purpose: "Observe", applicability: "Authorized state", method: "Fresh observation", reason: "Neutral mechanics regression", limitations: "No gameplay claim" };
  rootSource = await manager.register(run.run_id, { name: "predecessor", source: 'await game.observe(); return {status:"completed",summary:"Observed",result:null};', card, dependencies: [] });
  const candidate = await manager.register(run.run_id, {
    name: "follow-up", source: 'const fresh = await game.observe(); return {status:"completed",summary:"Fresh observation",result:fresh.observation_seq};', card, dependencies: [],
  });
  const rootRequest = {
    skill_id: rootSource.skill_id, version: rootSource.version, start_key: "predecessor",
    ...executionScopeFixture(run), args: "predecessor",
    limits: { duration_ms: 10_000, max_actions: 1, max_calls: 2, max_depth: 1 },
    lookahead: { after_ms: 0, reason: "Independent follow-up", activation: scenario.activation, budget: { calls: 2, tools: 4, duration_ms: 10_000 } },
  };
  expect(() => manager.start(run.run_id, {
    ...rootRequest,
    lookahead: { ...rootRequest.lookahead, budget: { ...rootRequest.lookahead.budget, calls: 5 } },
  })).toThrow();
  expect(store.skillExecutions(run.run_id)).toHaveLength(0);
  const root = manager.start(run.run_id, rootRequest);
  rootId = root.execution_id;
  const draft = planner.projection()!;
  expect(draft).toMatchObject({ state: "armed", basis: { root: { execution_id: rootId, status: "accepted" } } });
  expect(manager.start(run.run_id, rootRequest).execution_id).toBe(rootId);
  expect(planner.projection()?.plan_id).toBe(draft.plan_id);
  expect(store.eventsAfter(run.run_id, 0, 500).filter((event) => event.type === "planning.requested")).toHaveLength(1);
  expect(() => manager.start(run.run_id, { ...rootRequest, start_key: "competing_root" })).toThrow("Only one");
  expect(store.skillExecutions(run.run_id)).toHaveLength(1);
  await started.promise;
  planner.begin();
  continueRoot.resolve(); await continued.promise;
  expect(manager.get(run.run_id, { execution_id: rootId })?.status).toBe("running");
  expect(sequence).toBe(1);
  const rootClosed = Promise.withResolvers<void>(); closed.set(rootId, rootClosed.resolve);
  if (scenario.order === "closure_first") {
    finishRoot.resolve(); await rootClosed.promise;
    expect(planner.projection()).toMatchObject({ predecessor_closed: true, state: "planning", planning_active: true });
    expect(store.skillExecutions(run.run_id)).toHaveLength(1);
  }
  await planner.stage({
    plan_id: draft.plan_id, skill: { skill_id: candidate.skill_id, version: candidate.version },
    args: null, limits: { duration_ms: 10_000, max_actions: 1, max_calls: 2, max_depth: 1 },
    guard_source: 'return observation.life.status === "alive";',
  });
  planner.finish(draft.plan_id);
  if (scenario.order === "stage_first") {
    expect(store.skillExecutions(run.run_id)).toHaveLength(1);
    finishRoot.resolve(); await rootClosed.promise;
  }
  const activated = scenario.activation === "manual"
    ? await planner.activate(draft.plan_id)
    : (await planner.pendingActivation(rootId))!;
  expect(activated).toMatchObject({ state: "activated", observation_seq: 2 });
  const nextId = activated.activation_execution_id!;
  const next = manager.get(run.run_id, { execution_id: nextId });
  expect(next).toMatchObject({ start_key: `plan_${draft.plan_id}`, session_id: "session", life_id: 1, skill_id: candidate.skill_id, version: candidate.version });
  expect(store.skillExecutions(run.run_id)).toHaveLength(2);
  expect(unsafe).toEqual([]);
});
}
