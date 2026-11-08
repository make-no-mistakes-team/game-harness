import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { SkillManager, type SkillHost } from "../src/server/skills.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { RuntimeTools, type RuntimeToolHost } from "../src/server/runtime-tools.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import type { ReactiveRuntime } from "../src/server/reactive.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { LookaheadConfig } from "../src/shared/planning.ts";
import { DEFAULT_RESIDENT_LIMITS, type ControllerStepResult, type ResidentAnalysisWorker, type ResidentLimits, type ResidentWorker } from "../src/shared/resident.ts";
import type { ControllerInputChannel, RevocationAck } from "../src/shared/controller.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import type { Json } from "../src/shared/contracts.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const card = { purpose: "Resident root lifecycle", applicability: "Isolated host integration", method: "Selected pure modules", reason: "Preserve source and effect authority", limitations: "No native gameplay proof" };
const source = "export function step(frame,state,intent) { return {input: {kind: 'world', held: {forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false},edges:[],view:{kind:'unchanged'},selected_hotbar:null},next_state:state,status:'completed',events:[]}; }";
function until(store: Store, runId: string, predicate: () => boolean) {
  if (predicate()) return Promise.resolve();
  return new Promise<void>(resolve => { const off = store.subscribe(event => { if (event.run_id === runId && predicate()) { off(); resolve(); } }); });
}
async function fixture(analysisFactory?: (budget: number) => Promise<ResidentAnalysisWorker>, limits: Partial<ResidentLimits> = {},
  hooks: { prepareLookahead?: SkillHost["prepareLookahead"]; changed?: SkillHost["changed"];
    retire?: () => Promise<void>; runSkill?: SandboxService["runSkill"];
    workerOutput?: (result: ControllerStepResult) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-resident-root-")), store = new Store(directory), adapter = minecraftTestAdapter();
  const run = minecraftRunFixture(adapter); store.saveRun(run);
  let opened = 0, closed = 0, finiteCalls = 0, sequence = 0;
  const compiled = Promise.withResolvers<void>(), finishCompile = Promise.withResolvers<void>();
  let holdCompile = false;
  let output: ControllerStepResult["status"] = "completed";
  const firstStep = Promise.withResolvers<void>();
  const worker: ResidentWorker = { async step(_frame, state) {
    const visits = typeof state === "number" ? state
      : state !== null && typeof state === "object" && !Array.isArray(state) && typeof state.visits === "number" ? state.visits : null;
    if (visits === null) throw new Error("Fixture received an invalid resident visit state");
    firstStep.resolve();
    const result: ControllerStepResult = { input: { kind: "world", held: {forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false}, edges: [], view: {kind: "unchanged"}, selected_hotbar: null }, next_state: {visits: visits + 1}, status: output, events: [] };
    hooks.workerOutput?.(result);
    return result;
  }, async close() { closed++; } };
  const manager = new SkillManager(store, { runSkill: hooks.runSkill ?? (async () => { finiteCalls++; throw new Error("Resident must not dispatch legacy capability execution"); }),
    async createResidentWorker(_source, _budget, signal) { compiled.resolve(); if (holdCompile) await finishCompile.promise; if (signal.aborted) { await worker.close(); throw new Error("compile aborted"); } return worker; },
    async createResidentAnalysisWorker(_source, budget) { return analysisFactory ? await analysisFactory(budget) : { analyze: async (input: Json, _signal?: AbortSignal, report?: (ms: number) => void) => { report?.(1); return input; }, close: async () => {} }; },
  }, { adapter: () => adapter, binding: () => minecraftTestBinding(adapter),
    authorize: scope => { if (run.status !== "running" || scope.run_id !== run.run_id || scope.life_id !== run.life_id) throw new Error("scope revoked"); },
    observe: async () => { throw new Error("No ordinary observation polling in resident fixture"); },
    action: async () => { throw new Error("No finite effect in resident fixture"); }, queryCapability: async () => null,
    cancelActions: async () => {}, changed: hooks.changed ?? (() => {}), prepareLookahead: hooks.prepareLookahead,
    unsafe: () => {}, recover: async () => { throw new Error("No respawn"); },
    async openController(execution, generation, _deadline, _applied, _effect, lifecycle) {
      opened++;
      const owner = { operation_id: "controller", generation: 1, scope: { session_id: run.session_id!, epoch: run.epoch,
        life_id: run.life_id!, native_boot_id: run.native_boot_id!, run_generation: 1, space_epoch: run.space_epoch!,
        run_id: run.run_id, world_id: run.world_id, execution_id: execution.execution_id, source_hash: execution.source_hash! } };
      let retired = false, submitted = 0;
      return { owner, controllerGeneration: generation, async sample() { const frame = controllerFrameFixture(run.life_id!, run.space_epoch!); frame.frame_seq = ++sequence; frame.native_tick = sequence; frame.captured_native_ns = String(BigInt(sequence) * 50000000n); return jsonSchema.parse(frame); },
        submit() { if (output !== "running") throw new Error("Completed neutral step must retire without input");
          return { sequence: ++submitted, status: "submitted", reason: null }; }, renew: async () => {},
        async revoke() { await hooks.retire?.(); lifecycle.fence("retire"); await lifecycle.drain(); retired = true; return { owner, controller_generation: generation, admission_revoked: true, last_applied_sequence: 0, ordered_edge_prefix: 0, retirement_applied_native_tick: sequence, retirement_applied_native_ns: String(BigInt(sequence) * 50000000n), input_application: "confirmed", unresolved_operation_refs: [] } satisfies RevocationAck; },
        snapshot: () => ({ fenced: retired, retired, submitted_sequence: submitted, applied_sequence: 0, ordered_edge_prefix: 0, pending_frames: retired ? 0 : submitted, pending_edges: 0, last_input: null, reason: null }),
      } satisfies ControllerInputChannel;
    },
  });
  cleanup.push(async () => { finishCompile.resolve(); await manager.closeAll("Fixture cleanup"); store.close(); rmSync(directory, {recursive:true,force:true}); });
  const program = await manager.register(run.run_id, {entry:"step", name:"resident", source, card, dependencies:[]});
  const start = (lookahead?: LookaheadConfig) => manager.start(run.run_id, {entry:"step", skill_id:program.skill_id, version:program.version, start_key:crypto.randomUUID(), ...executionScopeFixture(run), args:{goal:"wait"}, initial_state:0, limits:{...DEFAULT_RESIDENT_LIMITS, duration_ms:10000, ...limits}, ...(lookahead ? { lookahead } : {})});
  return { store, run, manager, program, start, compiled, finishCompile, firstStep, hold() {holdCompile=true;}, running() {output="running";}, get opened(){return opened;}, get closed(){return closed;}, get finiteCalls(){return finiteCalls;} };
}

test("ordinary named resident handoff holds admission until native retirement then starts exact step limits once", async () => {
  const retiring = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let nativeRetired = false;
  const f = await fixture(undefined, {}, { retire: async () => {
    retiring.resolve(); await release.promise; nativeRetired = true;
  } });
  cleanup.unshift(async () => { release.resolve(); });
  const adapter = minecraftTestAdapter(), history = new HistoryReader(f.store.readLocation());
  const learning = new ImprovementLearning(f.store, history);
  cleanup.unshift(async () => { await history.close(); });
  const scope = () => ({ run_id: f.run.run_id, generation: 1, session_id: f.run.session_id!, world_id: f.run.world_id!,
    epoch: f.run.epoch, life_id: f.run.life_id!, life_status: "alive" as const, task: f.run.task,
    goal: adapter.goals.find(goal => goal.goal_id === "custom")!, native_boot_id: f.run.native_boot_id!,
    space_epoch: f.run.space_epoch!, compatibility_hash: f.run.compatibility_hash!, screen: null });
  const observation = () => minecraftObservationFixture(adapter, {
    world_id: f.run.world_id, session_id: f.run.session_id!, epoch: f.run.epoch,
    native_boot_id: f.run.native_boot_id!, life: { life_id: f.run.life_id!, status: "alive", can_respawn: false, death: null },
  });
  const planning = new SpeculativePlanning({ contract: () => adapter, admissionContext: scope, context: () => null,
    skill: ref => f.store.skill(f.run.run_id, ref), observe: async () => observation(),
    evaluateGuard: async () => { throw new Error("No speculative guard"); },
    admit: async (request, permit) => { permit.assertCurrent(); return f.manager.start(f.run.run_id, request); },
    evidence: () => {}, wake: () => {} });
  const host: RuntimeToolHost = { run: () => f.run, assertCurrent: () => f.run, observe: async () => observation(),
    adapter: () => adapter, generation: () => 1, attentionAfter: () => {}, admitted: () => {},
    history: () => history, planning: () => planning, learning: () => learning, toolAuthority: () => () => {},
    finishTask: () => { throw new Error("No task completion"); } };
  const catalog = new RuntimeTools(f.store, f.manager, {} as ReactiveRuntime, null, host);
  const tool = catalog.build(1).find(tool => tool.name === "program_run")!;
  f.running();
  const predecessor = f.start();
  await f.firstStep.promise;
  const successor = await f.manager.register(f.run.run_id, { entry: "step", name: "exact successor", source, card, dependencies: [] });
  const limits = { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 8000, max_steps: 17, max_frames: 11 };
  const input = { operation: "start", entry: "step", name: successor.name, args: { goal: "new authored intent" }, initial_state: 0, limits,
    handoff: { name: f.program.name, version: f.program.version, execution_ordinal: 1 } };
  const pending = tool.execute("resident-handoff", input);
  await retiring.promise;
  expect(f.opened).toBe(1);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  expect(f.manager.effectScope(predecessor.execution_id)).toBeNull();
  release.resolve();
  const result = await pending;
  expect(result.isError).not.toBe(true);
  expect(nativeRetired).toBe(true);
  const next = f.store.latestRootExecution(f.run.run_id)!;
  expect(next).toMatchObject({ entry: "step", skill_id: successor.skill_id, version: successor.version, limits, args: input.args, initial_state: 0 });
  await until(f.store, f.run.run_id, () => f.opened === 2);
  expect(f.opened).toBe(2);
  expect(f.closed).toBe(1);
  expect(f.manager.get(f.run.run_id, { execution_id: predecessor.execution_id })!.status).toBe("cancelled");
  expect(f.finiteCalls).toBe(0);
  await tool.execute("resident-handoff", input);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(2);
  expect(f.manager.effectScope(next.execution_id)).not.toBeNull();
});

test("resident prepared continuation cannot start until actual native retirement completes", async () => {
  const retiring = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), rootClosed = Promise.withResolvers<void>();
  let planner: SpeculativePlanning, rootId = "", successorStarted = false, nativeRetired = false;
  const f = await fixture(undefined, {}, {
    prepareLookahead: config => planner.prepareOptIn(config),
    changed: (wake, execution) => {
      if (wake && execution?.execution_id === rootId) {
        planner.predecessorSettled(rootId); rootClosed.resolve();
      }
    },
    retire: async () => { retiring.resolve(); await release.promise; nativeRetired = true; },
    runSkill: async () => {
      expect(nativeRetired).toBe(true); successorStarted = true;
      return { status: "completed", summary: "Fresh continuation ran", result: null };
    },
  });
  cleanup.unshift(async () => { release.resolve(); planner?.invalidate(); });
  const adapter = minecraftTestAdapter();
  const scope = () => ({
    run_id: f.run.run_id, generation: 1, session_id: f.run.session_id!, world_id: f.run.world_id!,
    epoch: f.run.epoch, life_id: f.run.life_id!, life_status: "alive" as const, task: f.run.task,
    goal: adapter.goals.find(goal => goal.goal_id === "custom")!, native_boot_id: f.run.native_boot_id!,
    space_epoch: f.run.space_epoch!, compatibility_hash: f.run.compatibility_hash!, screen: null,
  });
  planner = new SpeculativePlanning({
    contract: () => adapter, admissionContext: scope,
    context: () => {
      const root = f.store.latestRootExecution(f.run.run_id);
      return root ? { ...scope(), root: { execution_id: root.execution_id, skill_id: root.skill_id,
        version: root.version, hash: root.source_hash!, status: root.status } } : null;
    },
    skill: ref => f.store.skill(f.run.run_id, ref),
    observe: async () => minecraftObservationFixture(adapter),
    evaluateGuard: async () => { throw new Error("No guard supplied"); },
    admit: async (request, permit) => { permit.assertCurrent(); return f.manager.start(f.run.run_id, request); },
    evidence: (type, details) => { f.store.event(f.run.run_id, type, type, details); }, wake: () => {},
  });
  const next = await f.manager.register(f.run.run_id, { entry: "run", name: "prepared follow-up",
    source: 'return {status:"completed",summary:"Follow-up",result:null};', card, dependencies: [] });
  f.hold();
  const root = f.start({ after_ms: 0, reason: "Prepare while resident runs",
    activation: "on_predecessor_success", budget: { calls: 2, tools: 4, duration_ms: 10000 } });
  rootId = root.execution_id; await f.compiled.promise;
  expect(planner.projection()).toMatchObject({ state: "armed", basis: { root: { execution_id: rootId } } });
  const draft = planner.begin()!;
  await planner.stage({ plan_id: draft.plan_id, skill: { skill_id: next.skill_id, version: next.version }, args: null,
    limits: { duration_ms: 1000, max_actions: 1, max_calls: 1, max_depth: 1 } });
  planner.finish(draft.plan_id); f.finishCompile.resolve(); await retiring.promise;
  expect(successorStarted).toBe(false);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  release.resolve(); await rootClosed.promise;
  expect(await planner.pendingActivation(rootId)).toMatchObject({ state: "activated" });
  const successor = f.store.latestRootExecution(f.run.run_id)!;
  await until(f.store, f.run.run_id, () => !!f.manager.get(f.run.run_id, { execution_id: successor.execution_id })!.ended_at);
  expect(successorStarted).toBe(true);
  expect(f.manager.get(f.run.run_id, { execution_id: rootId })!.status).toBe("succeeded");
});

test("selected resident root persists state and cleanup without spending finite program call budgets", async () => {
  const f = await fixture(), execution = f.start();
  await until(f.store, f.run.run_id, () => !!f.manager.get(f.run.run_id, {execution_id:execution.execution_id})!.ended_at);
  const final = f.manager.get(f.run.run_id, {execution_id:execution.execution_id})!;
  expect(final.status).toBe("succeeded"); expect(final.entry).toBe("step");
  if (final.entry !== "step") throw new Error("Wrong selected entry");
  expect(final.resident).toMatchObject({state:{visits:1}, cleanup:{worker:"closed",native:"retired"}, counters:{steps:1,submissions:0}});
  expect(final.calls).toBe(0); expect(final.actions).toBe(0); expect(f.finiteCalls).toBe(0); expect(f.opened).toBe(1); expect(f.closed).toBe(1);
});

for (const edges of ["explicit", "omitted"] as const)
test(`invalid resident return with ${edges} edges reports its public field failure only after retirement`, async () => {
  const f = await fixture(undefined, {}, { workerOutput: result => {
    Reflect.deleteProperty(result.input, "selected_hotbar");
    if (edges === "omitted") Reflect.deleteProperty(result.input, "edges");
    result.next_state = { private_note: "not-a-diagnostic-value" };
  } });
  f.running();
  const execution = f.start();
  await until(f.store, f.run.run_id, () => !!f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!.ended_at);
  const final = f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!;
  expect(final.status).toBe("failed");
  expect(final.diagnostic).toMatchObject({ type: "GeneratedControllerResultValidationError",
    code: "invalid_program_result", source_hash: f.program.hash });
  expect(final.error).toContain("input.selected_hotbar");
  expect(final.error).not.toContain("input.edges");
  expect(JSON.stringify(final.diagnostic)).not.toContain("not-a-diagnostic-value");
  if (final.entry !== "step") throw new Error("Wrong selected entry");
  expect(final.resident).toMatchObject({ cleanup: { worker: "closed", native: "retired" }, counters: { submissions: 0 } });
  expect(f.closed).toBe(1);
});

test("arbitrary resident host failure diagnostics still hide exception messages", async () => {
  const f = await fixture(undefined, {}, { workerOutput: () => { throw new Error("host-private-path-or-credential"); } });
  const execution = f.start();
  await until(f.store, f.run.run_id, () => !!f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!.ended_at);
  const final = f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!;
  expect(final.status).toBe("failed");
  expect(final.diagnostic?.type).toBe("ExecutionFailure");
  expect(JSON.stringify(final.diagnostic)).not.toContain("host-private-path-or-credential");
});

test("Stop during module readiness drains compiler ownership before any native grant", async () => {
  const f = await fixture(); f.hold(); const execution = f.start(); await f.compiled.promise;
  f.manager.cancel(f.run.run_id, {execution_id:execution.execution_id}, "stop during compile");
  const closing = f.manager.closeAll("stop during compile"); let settled = false; void closing.then(()=>{settled=true;}); await Promise.resolve();
  expect(settled).toBe(false); expect(f.opened).toBe(0); f.finishCompile.resolve(); await closing;
  expect(f.manager.get(f.run.run_id, {execution_id:execution.execution_id})!.status).toBe("cancelled"); expect(f.closed).toBe(1); expect(f.opened).toBe(0);
});

test("SkillManager preserves remaining analysis compute after failed evaluation with separately held cleanup", async () => {
  const evaluated = Promise.withResolvers<void>(), removal = Promise.withResolvers<void>();
  let jobs = 0, settled = false, closed = 0;
  const budgets: number[] = [];
  const f = await fixture(async budget => {
    budgets.push(budget);
    const first = ++jobs === 1;
    return {
      async analyze(input: Json, _signal?: AbortSignal, onEvaluation?: (ms: number) => void) {
        onEvaluation?.(first ? 7 : 8);
        if (first) {
          evaluated.resolve();
          await removal.promise; // External worker promise still joins actual removal.
          throw new Error("authored computation failed");
        }
        return input;
      },
      async close() { closed++; },
    };
  }, { max_analysis_ms: 20, analysis_job_ms: 20 });
  cleanup.unshift(async () => { removal.resolve(); });
  f.running(); const execution = f.start(); await f.firstStep.promise;
  const analysis = await f.manager.register(f.run.run_id, { entry: "analyze", name: "analysis", source: "export function analyze(input) { return input; }", card, dependencies: [] });
  const ref = { skill_id: analysis.skill_id, version: analysis.version, hash: analysis.hash };
  const first = f.manager.analyzeResident(f.run.run_id, execution.execution_id, ref, { value: 1 }, 0);
  void first.then(() => { settled = true; });
  await evaluated.promise;
  await Bun.sleep(40);
  expect(settled).toBe(false);
  const pending = f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!;
  if (pending.entry !== "step") throw new Error("Wrong selected entry");
  expect(pending.resident?.pending.analysis).toBe(true);
  expect(pending.resident?.status).toBe("running");
  expect(pending.resident?.counters.analysis_ms).toBe(7);
  await expect(f.manager.analyzeResident(f.run.run_id, execution.execution_id, ref, null, 0)).rejects.toThrow(/already running/);
  removal.resolve(); const failed = await first;
  expect(failed.status).toBe("failed"); expect(failed.elapsed_ms).toBe(7);
  expect(failed.post_evaluation_ms).toBeGreaterThanOrEqual(35);
  expect(closed).toBe(1);
  const next = await f.manager.analyzeResident(f.run.run_id, execution.execution_id, ref, { value: 2 }, 0);
  expect(next.status).toBe("completed"); expect(next.output).toEqual({ value: 2 });
  expect(next.elapsed_ms).toBe(8); expect(next.post_evaluation_ms).toBeGreaterThanOrEqual(0);
  expect(budgets).toEqual([20, 13]);
  const final = f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!;
  if (final.entry !== "step") throw new Error("Wrong selected entry");
  expect(final.resident?.counters.analysis_ms).toBe(15);
});
