import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { SkillManager } from "../src/server/skills.ts";
import { DEFAULT_RESIDENT_LIMITS, type ControllerStepResult, type ResidentAnalysisWorker, type ResidentLimits, type ResidentWorker } from "../src/shared/resident.ts";
import type { ControllerInputChannel, RevocationAck } from "../src/shared/controller.ts";
import { executionScopeFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";
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
async function fixture(analysisFactory?: (budget: number) => Promise<ResidentAnalysisWorker>, limits: Partial<ResidentLimits> = {}) {
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
    return { input: { kind: "world", held: {forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false}, edges: [], view: {kind: "unchanged"}, selected_hotbar: null }, next_state: {visits: visits + 1}, status: output, events: [] };
  }, async close() { closed++; } };
  const manager = new SkillManager(store, { runSkill: async () => { finiteCalls++; throw new Error("Resident must not dispatch legacy capability execution"); },
    async createResidentWorker(_source, _budget, signal) { compiled.resolve(); if (holdCompile) await finishCompile.promise; if (signal.aborted) { await worker.close(); throw new Error("compile aborted"); } return worker; },
    async createResidentAnalysisWorker(_source, budget) { return analysisFactory ? await analysisFactory(budget) : { analyze: async (input: Json, _signal?: AbortSignal, report?: (ms: number) => void) => { report?.(1); return input; }, close: async () => {} }; },
  }, { adapter: () => adapter, binding: () => minecraftTestBinding(adapter),
    authorize: scope => { if (run.status !== "running" || scope.run_id !== run.run_id || scope.life_id !== run.life_id) throw new Error("scope revoked"); },
    observe: async () => { throw new Error("No ordinary observation polling in resident fixture"); },
    action: async () => { throw new Error("No finite effect in resident fixture"); }, queryCapability: async () => null,
    cancelActions: async () => {}, changed: () => {}, unsafe: () => {}, recover: async () => { throw new Error("No respawn"); },
    async openController(execution, generation, _deadline, _applied, _effect, lifecycle) {
      opened++;
      const owner = { operation_id: "controller", generation: 1, scope: { session_id: run.session_id!, epoch: run.epoch,
        life_id: run.life_id!, native_boot_id: run.native_boot_id!, run_generation: 1, space_epoch: run.space_epoch!,
        run_id: run.run_id, world_id: run.world_id, execution_id: execution.execution_id, source_hash: execution.source_hash! } };
      let retired = false;
      return { owner, controllerGeneration: generation, async sample() { const frame = controllerFrameFixture(run.life_id!, run.space_epoch!); frame.frame_seq = ++sequence; frame.native_tick = sequence; frame.captured_native_ns = String(BigInt(sequence) * 50000000n); return jsonSchema.parse(frame); },
        submit() { throw new Error("Completed neutral step must retire without input"); }, renew: async () => {},
        async revoke() { lifecycle.fence("retire"); await lifecycle.drain(); retired = true; return { owner, controller_generation: generation, admission_revoked: true, last_applied_sequence: 0, ordered_edge_prefix: 0, retirement_applied_native_tick: sequence, retirement_applied_native_ns: String(BigInt(sequence) * 50000000n), input_application: "confirmed", unresolved_operation_refs: [] } satisfies RevocationAck; },
        snapshot: () => ({ fenced: retired, retired, submitted_sequence: 0, applied_sequence: 0, ordered_edge_prefix: 0, pending_frames: 0, pending_edges: 0, last_input: null, reason: null }),
      } satisfies ControllerInputChannel;
    },
  });
  cleanup.push(async () => { finishCompile.resolve(); await manager.closeAll("Fixture cleanup"); store.close(); rmSync(directory, {recursive:true,force:true}); });
  const program = await manager.register(run.run_id, {entry:"step", name:"resident", source, card, dependencies:[]});
  const start = () => manager.start(run.run_id, {entry:"step", skill_id:program.skill_id, version:program.version, start_key:crypto.randomUUID(), ...executionScopeFixture(run), args:{goal:"wait"}, initial_state:0, limits:{...DEFAULT_RESIDENT_LIMITS, duration_ms:10000, ...limits}});
  return { store, run, manager, program, start, compiled, finishCompile, firstStep, hold() {holdCompile=true;}, running() {output="running";}, get opened(){return opened;}, get closed(){return closed;}, get finiteCalls(){return finiteCalls;} };
}

test("selected resident root persists state and cleanup without spending finite program call budgets", async () => {
  const f = await fixture(), execution = f.start();
  await until(f.store, f.run.run_id, () => !!f.manager.get(f.run.run_id, {execution_id:execution.execution_id})!.ended_at);
  const final = f.manager.get(f.run.run_id, {execution_id:execution.execution_id})!;
  expect(final.status).toBe("succeeded"); expect(final.entry).toBe("step");
  if (final.entry !== "step") throw new Error("Wrong selected entry");
  expect(final.resident).toMatchObject({state:{visits:1}, cleanup:{worker:"closed",native:"retired"}, counters:{steps:1,submissions:0}});
  expect(final.calls).toBe(0); expect(final.actions).toBe(0); expect(f.finiteCalls).toBe(0); expect(f.opened).toBe(1); expect(f.closed).toBe(1);
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
