import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { SkillManager, type SkillHost } from "../src/server/skills.ts";
import { SourcePrograms } from "../src/server/source-programs.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { RuntimeTools, type RuntimeToolHost } from "../src/server/runtime-tools.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import type { ReactiveRuntime } from "../src/server/reactive.ts";
import { SandboxService } from "../src/server/sandbox.ts";
import type { LookaheadConfig } from "../src/shared/planning.ts";
import { DEFAULT_RESIDENT_LIMITS, type ControllerStepResult, type ResidentAnalysisWorker, type ResidentLimits, type ResidentWorker } from "../src/shared/resident.ts";
import type { ControllerInputChannel, RevocationAck } from "../src/shared/controller.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import type { Json } from "../src/shared/contracts.ts";
import { spawn } from "node:child_process";
import { residentActivationResultSchema, residentDecisionSchema } from "../src/shared/resident.ts";
import { ResidentWorkerFault, residentSourceAdvisory, type ResidentWorkerFaultOrigin } from "../src/server/resident-worker-fault.ts";
import { preparationFailure } from "../src/server/prepared-source-error.ts";
import { MAX_SKILL_LIMITS, type ExecutableModuleBundle, type SkillLimits } from "../src/shared/programs.ts";
import { executableModuleBundleHash, singletonExecutableModuleBundle } from "../src/shared/program-modules.ts";
import { controlSessionConfigSchema } from "../src/shared/control-session.ts";
import { residentAnalysisProcess } from "./helpers/resident-analysis-process.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const card = { purpose: "Resident root lifecycle", applicability: "Isolated host integration", method: "Selected pure modules", reason: "Preserve source and effect authority", limitations: "No native gameplay proof" };
const source = "export function step(frame,state,intent) { return {input: {kind: 'world', held: {forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false},edges:[],view:{kind:'unchanged'},selected_hotbar:null},next_state:state,status:'completed',events:[]}; }";
function until(store: Store, runId: string, predicate: () => boolean) {
  if (predicate()) return Promise.resolve();
  return new Promise<void>(resolve => { const off = store.subscribe(event => { if (event.run_id === runId && predicate()) { off(); resolve(); } }); });
}
async function fixture(analysisFactory?: (budget: number, bundle: ExecutableModuleBundle, signal: AbortSignal) => Promise<ResidentAnalysisWorker>, limits: Partial<ResidentLimits> = {},
  hooks: { prepareLookahead?: SkillHost["prepareLookahead"]; changed?: SkillHost["changed"];
    retire?: () => Promise<void>; runSkill?: SandboxService["runSkill"];
    createResidentWorker?: SandboxService["createResidentWorker"];
    sessionTask?: SkillHost["sessionTask"]; superviseSessionTask?: SkillHost["superviseSessionTask"];
    retireSessionTask?: SkillHost["retireSessionTask"];
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
    createResidentWorker: hooks.createResidentWorker ?? (async (_bundle, _budget, signal) => { compiled.resolve(); if (holdCompile) await finishCompile.promise; if (signal.aborted) { await worker.close(); throw new Error("compile aborted"); } return worker; }),
    async createResidentAnalysisWorker(_bundle, budget, signal) { return analysisFactory ? await analysisFactory(budget, _bundle, signal) : { analyze: async (input: Json, _signal?: AbortSignal, report?: (ms: number) => void) => { report?.(1); return input; }, close: async () => {} }; },
  }, { adapter: () => adapter, binding: () => minecraftTestBinding(adapter),
    authorize: scope => { if (run.status !== "running" || scope.run_id !== run.run_id || scope.life_id !== run.life_id) throw new Error("scope revoked"); },
    observe: async () => { throw new Error("No ordinary observation polling in resident fixture"); },
    action: async () => { throw new Error("No finite effect in resident fixture"); }, queryCapability: async () => jsonSchema.parse(controllerFrameFixture(run.life_id!, run.space_epoch!)),
    cancelActions: async () => {}, changed: hooks.changed ?? (() => {}), prepareLookahead: hooks.prepareLookahead,
    sessionTask: hooks.sessionTask, superviseSessionTask: hooks.superviseSessionTask, retireSessionTask: hooks.retireSessionTask,
    unsafe: () => {}, recover: async () => { throw new Error("No respawn"); },
    async openController(execution, generation, _deadline, _applied, _effect, lifecycle) {
      opened++;
      const owner = { operation_id: "controller", generation: 1, scope: { session_id: run.session_id!, epoch: run.epoch,
        life_id: run.life_id!, native_boot_id: run.native_boot_id!, run_generation: 1, space_epoch: run.space_epoch!,
        run_id: run.run_id, world_id: run.world_id, execution_id: execution.execution_id, source_hash: execution.source_hash! } };
      let retired = false, submitted = 0;
      return { owner, controllerGeneration: generation, async sample() {
        const frame = controllerFrameFixture(run.life_id!, run.space_epoch!);
        frame.frame_seq = ++sequence; frame.native_tick = sequence;
        frame.captured_native_ns = String(BigInt(sequence) * 50000000n);
        frame.inventory.captured_native_ns = frame.captured_native_ns;
        frame.dynamic_entities.native_tick = frame.native_tick;
        frame.dynamic_entities.captured_native_ns = frame.captured_native_ns;
        return jsonSchema.parse(frame);
      },
        submit() { if (output !== "running") throw new Error("Completed neutral step must retire without input");
          return { sequence: ++submitted, status: "submitted", reason: null }; }, renew: async () => {},
        async revoke() { await hooks.retire?.(); lifecycle.fence("retire"); await lifecycle.drain(); retired = true; return { owner, controller_generation: generation, admission_revoked: true, last_applied_sequence: 0, ordered_edge_prefix: 0, retirement_applied_native_tick: sequence, retirement_applied_native_ns: String(BigInt(sequence) * 50000000n), input_application: "confirmed", unresolved_operation_refs: [] } satisfies RevocationAck; },
        snapshot: () => ({ fenced: retired, retired, submitted_sequence: submitted, applied_sequence: 0, ordered_edge_prefix: 0, pending_frames: retired ? 0 : submitted, pending_edges: 0, last_input: null, reason: null, fault: null }),
      } satisfies ControllerInputChannel;
    },
  });
  cleanup.push(async () => { finishCompile.resolve(); await manager.closeAll("Fixture cleanup"); store.close(); rmSync(directory, {recursive:true,force:true}); });
  const sources = new SourcePrograms(store, { adapter: () => adapter, binding: () => minecraftTestBinding(adapter),
    changed: () => hooks.changed?.(false) });
  const program = await sources.register(run.run_id, {entry:"step", name:"resident", source, card, dependencies:[]});
  const start = (lookahead?: LookaheadConfig) => manager.start(run.run_id, {entry:"step", skill_id:program.skill_id, version:program.version, start_key:crypto.randomUUID(), ...executionScopeFixture(run), args:{goal:"wait"}, initial_state:0, limits:{...DEFAULT_RESIDENT_LIMITS, duration_ms:10000, ...limits}, ...(lookahead ? { lookahead } : {})});
  return { store, run, manager, sources, program, start, compiled, finishCompile, firstStep, hold() {holdCompile=true;}, running() {output="running";}, get opened(){return opened;}, get closed(){return closed;}, get finiteCalls(){return finiteCalls;} };
}

/** Controlled guardian frames exercise the actual host decoder and process
 * closure, not Docker isolation, measured CPU, native control or gameplay. */
async function hostFaultWorker(bundle: ExecutableModuleBundle, fault: Record<string, unknown>,
  exitCode = 0, timing = true) {
  const directory = mkdtempSync(join(tmpdir(), "resident-host-fault-"));
  const guardian = join(directory, "guardian.mjs");
  writeFileSync(guardian, `
    import {createInterface} from "node:readline";
    const send = value => process.stdout.write(JSON.stringify(value)+"\\n");
    send({v:1,type:"resident_ready",id:0,runtime_features:["pure_modules_v1","motion_track_v1"]});
    const lines=createInterface({input:process.stdin});
    lines.on("line", text => {
      const request=JSON.parse(text);
      if(request.type==="resident_init") send({v:1,type:"resident_compiled",id:0});
      else {
        send({...${JSON.stringify(fault)},id:request.id});
        if(${timing}) send({v:2,type:"guardian_analysis_evaluated",id:request.id,entry:"analyze",elapsed_ms:7,outcome:"terminated"});
      }
    });
    lines.on("close",()=>{process.exitCode=${exitCode};});
  `);
  const sandbox = new SandboxService(directory);
  Object.assign(sandbox, { state: { status: "ready", image: "controlled-guardian", error: null },
    runner: new URL("../sandbox/worker.mjs", import.meta.url).pathname, guardian });
  cleanup.push(async () => {
    try {
      if (exitCode === 0) await sandbox.close();
      else await expect(sandbox.close()).rejects.toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return await sandbox.createResidentAnalysisWorker(bundle, 1000, new AbortController().signal);
}

function diagnosticBundle(): ExecutableModuleBundle {
  const bundle = singletonExecutableModuleBundle("import {check} from './check.js'; export function analyze(input) { return check(input); }", "analyze");
  const library = singletonExecutableModuleBundle("export function check(input) { return input; }", "analyze").modules[0]!;
  const id = 'module:["check",1]';
  bundle.modules[0]!.imports.push({ specifier: "./check.js", module_id: id });
  bundle.modules.push({ ...library, id });
  bundle.source_hash = executableModuleBundleHash(bundle.entry, bundle.modules);
  return bundle;
}

function inspectionTools(f: Awaited<ReturnType<typeof fixture>>) {
  const adapter = minecraftTestAdapter(), history = new HistoryReader(f.store.readLocation());
  const learning = new ImprovementLearning(f.store, history);
  cleanup.unshift(async () => { await history.close(); });
  const scope = () => ({ run_id: f.run.run_id, generation: 1, session_id: f.run.session_id!, world_id: f.run.world_id,
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
  return new RuntimeTools(f.store, f.manager, f.sources, {} as ReactiveRuntime, null, host).build(1);
}

test("host decoder preserves source advice and exact bundle hash through following trusted terminated timing and cleanup", async () => {
  const bundle = diagnosticBundle();
  const diagnostic = { type: "TypeError", message: "assertion: explicit state required",
    source_hash: bundle.source_hash, location: { mapping: "unmapped" } };
  const worker = await hostFaultWorker(bundle, { v: 2, type: "guardian_resident_fault",
    origin: "source_throw", trusted_origin: false, diagnostic });
  const reports: number[] = [];
  let caught: unknown;
  try { await worker.analyze(null, undefined, elapsed => reports.push(elapsed)); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ResidentWorkerFault);
  expect(caught).toMatchObject({ origin: "source_throw", trustedOrigin: false, sourceDiagnostic: diagnostic });
  expect(reports).toEqual([7]);
  expect(preparationFailure(caught)).toMatchObject({ code: "source_throw",
    source_diagnostic: { advisory: true, trusted_origin: false, diagnostic } });
  expect((caught as Error).message).not.toContain(diagnostic.message);
  await worker.close();
});

test("host decoder rejects malformed, wrong-source and forged-trust source frames without exposing their text", async () => {
  const bundle = diagnosticBundle();
  const diagnostic = { type: "Error", message: "PRIVATE_HOST_SENTINEL",
    source_hash: bundle.source_hash, location: { mapping: "unmapped" } };
  const base = { v: 2, type: "guardian_resident_fault", origin: "source_throw", trusted_origin: false, diagnostic };
  const { diagnostic: _omitted, ...missing } = base;
  for (const fault of [missing, { ...base, trusted_origin: true }, { ...base, extra: "PRIVATE_EXTRA" },
    { ...base, diagnostic: { ...diagnostic, source_hash: "f".repeat(64) } },
    { ...base, diagnostic: { ...diagnostic, source_hash: bundle.modules[0]!.source_hash } },
    { ...base, diagnostic: { ...diagnostic, source_hash: bundle.source_hash.toUpperCase() } },
    { ...base, diagnostic: { ...diagnostic, type: "HostInternalError" } },
    { ...base, diagnostic: { ...diagnostic, message: "PRIVATE".repeat(200) } },
    { ...base, diagnostic: { ...diagnostic, stack: "PRIVATE_STACK" } },
    { ...base, diagnostic: { ...diagnostic, location: { mapping: "unmapped", path: "PRIVATE_PATH" } } },
    { ...base, origin: "watchdog" }, { ...base, origin: "transport" }, { ...base, origin: "opaque" }]) {
    const worker = await hostFaultWorker(bundle, fault);
    let caught: unknown;
    try { await worker.analyze(null); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ origin: "transport", trustedOrigin: true });
    expect(residentSourceAdvisory(caught)).toBeUndefined();
    expect(JSON.stringify(preparationFailure(caught))).not.toContain("PRIVATE");
    await worker.close();
  }
});

test("cleanup uncertainty supersedes a valid advisory without leaking source text", async () => {
  const bundle = singletonExecutableModuleBundle("export function analyze(input) { return input; }", "analyze");
  const worker = await hostFaultWorker(bundle, { v: 2, type: "guardian_resident_fault",
    origin: "source_throw", trusted_origin: false, diagnostic: { type: "Error",
      message: "PRIVATE_UNCONFIRMED_SOURCE", source_hash: bundle.source_hash, location: { mapping: "unmapped" } } }, 1);
  let caught: unknown;
  try { await worker.analyze(null); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ origin: "cleanup", trustedOrigin: true });
  expect(residentSourceAdvisory(caught)).toBeUndefined();
  expect(preparationFailure(caught).code).toBe("cleanup");
  expect(JSON.stringify(preparationFailure(caught))).not.toContain("PRIVATE");
  await expect(worker.close()).rejects.toThrow();
});

test("a raw-result candidate cannot retire an incumbent when the pinned request selects executive mode", async () => {
  const f = await fixture(undefined, {}, { sessionTask: async () => ({ status: "succeeded", summary: "unused", evidence: null }),
    superviseSessionTask: async () => {}, retireSessionTask: async () => {} });
  f.running();
  const incumbent = f.start(); await f.firstStep.promise;
  const request = { entry: "step" as const, skill_id: f.program.skill_id, version: f.program.version,
    start_key: "wrong-mode-successor", ...executionScopeFixture(f.run), args: null, initial_state: 0,
    limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 10000 },
    session: controlSessionConfigSchema.parse({ schema_version: 1 }) };
  await expect(f.manager.prepareResidentHandoff(f.run.run_id, request, incumbent.execution_id)).rejects.toThrow();
  expect(f.manager.get(f.run.run_id, { execution_id: incumbent.execution_id })).toMatchObject({
    status: "running", ended_at: null, resident: { status: "running" },
  });
  expect(f.opened).toBe(1);
});

test("shared root admission refuses legacy step roots in executive runs before dispatch", async () => {
  const f = await fixture(); f.run.control_mode = "executive"; f.store.saveRun(f.run);
  expect(() => f.start()).toThrow(/life-scoped step sessions/);
  expect(f.opened).toBe(0); expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("ordinary exact-return analysis keeps raw output, budgets and immutable flag-sensitive receipts without playing dispatch", async () => {
  const budgets: number[] = [];
  let disposed = 0;
  const f = await fixture(async (budget, bundle, signal) => {
    budgets.push(budget);
    const worker = await residentAnalysisProcess(bundle, budget, signal);
    return { analyze: worker.analyze, async close() { await worker.close(); disposed++; } };
  }, { analysis_job_ms: 500, max_analysis_ms: 2000, max_analysis_jobs: 4 });
  const adapter = minecraftTestAdapter(), history = new HistoryReader(f.store.readLocation());
  const learning = new ImprovementLearning(f.store, history);
  cleanup.unshift(async () => { await history.close(); });
  const scope = () => ({ run_id: f.run.run_id, generation: 1, session_id: f.run.session_id!, world_id: f.run.world_id,
    epoch: f.run.epoch, life_id: f.run.life_id!, life_status: "alive" as const, task: f.run.task,
    goal: adapter.goals.find(goal => goal.goal_id === "custom")!, native_boot_id: f.run.native_boot_id!,
    space_epoch: f.run.space_epoch!, compatibility_hash: f.run.compatibility_hash!, screen: null });
  const planning = new SpeculativePlanning({ contract: () => adapter, admissionContext: scope, context: () => null,
    skill: ref => f.store.skill(f.run.run_id, ref), observe: async () => minecraftObservationFixture(adapter),
    evaluateGuard: async () => { throw new Error("No speculative guard"); },
    admit: async (request, permit) => { permit.assertCurrent(); return f.manager.start(f.run.run_id, request); },
    evidence: () => {}, wake: () => {} });
  const host: RuntimeToolHost = { run: () => f.run, assertCurrent: () => f.run,
    observe: async () => minecraftObservationFixture(adapter), adapter: () => adapter, generation: () => 1,
    attentionAfter: () => {}, admitted: () => {}, history: () => history, planning: () => planning,
    learning: () => learning, toolAuthority: () => () => {}, finishTask: () => { throw new Error("No task completion"); } };
  const tool = new RuntimeTools(f.store, f.manager, f.sources, {} as ReactiveRuntime, null, host).build(1).find(tool => tool.name === "program_run")!;
  const analysis = await f.sources.register(f.run.run_id, { entry: "analyze", name: "exact-return software probe",
    source: `export function analyze(input) {
      if (input.refuse) return {refused:true,reason:'software only'};
      return {input:{kind:'world',held:{forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false},
        view:{kind:'unchanged'},selected_hotbar:null},next_state:input.oversize ? 'é'.repeat(8192) : {counter:input.counter},
        status:'running',events:[]}; }`, card, dependencies: [] });
  f.running(); const execution = f.start(); await f.firstStep.promise;
  const input = { operation: "analyze", target: "current", name: analysis.name, version: analysis.version,
    expected_intent_version: 0, input: { oversize: true, counter: 4 }, validate_as: "decision" };
  expect((await tool.execute("invalid-analysis-shape", { ...input, validate_as: "not-a-shape" })).isError).toBe(true);
  expect((await tool.execute("stale-analysis", { ...input, expected_intent_version: 1 })).isError).toBe(true);
  expect(budgets).toHaveLength(0);
  const failed = await tool.execute("invalid-return", input);
  expect(failed.details).toMatchObject({ status: "failed", output: { next_state: "é".repeat(8192) },
    diagnostic: { code: "invalid_program_result",
      issues: [{ code: "custom", path: "next_state", constraint: "utf8_bytes", maximum: 16384 }] } });
  const failedData = failed.details as { output: { input: object }; elapsed_ms: number };
  expect(Object.hasOwn(failedData.output.input, "edges")).toBe(false);
  expect(failedData.elapsed_ms).toBeGreaterThan(0); expect(failedData.elapsed_ms).toBeLessThanOrEqual(500);
  expect(disposed).toBe(1);
  expect((await tool.execute("invalid-return", input)).details).toEqual(failed.details);
  expect((await tool.execute("invalid-return", { ...input, validate_as: "activation" })).isError).toBe(true);
  expect(budgets).toHaveLength(1);
  const accepted = await tool.execute("valid-return", { ...input, input: { oversize: false, counter: 4 } });
  expect(accepted.details).toMatchObject({ status: "completed", output: { next_state: { counter: 4 } },
    validation: { validate_as: "decision", qualification: "software_return_shape_only" } });
  expect(Object.hasOwn((accepted.details as { output: { input: object } }).output.input, "edges")).toBe(false);
  const refusal = await tool.execute("valid-refusal-shape", { ...input, input: { refuse: true }, validate_as: "activation" });
  expect(refusal.details).toMatchObject({ status: "completed", output: { refused: true, reason: "software only" },
    validation: { validate_as: "activation", qualification: "software_return_shape_only" } });
  const current = f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!;
  if (current.entry !== "step") throw new Error("Resident analysis changed the playing entry");
  const snapshot = current.resident!;
  expect(snapshot.counters.analysis_jobs).toBe(3);
  expect(snapshot.counters.analysis_ms).toBeGreaterThanOrEqual(failedData.elapsed_ms);
  expect(snapshot.counters.analysis_ms).toBeLessThanOrEqual(1500);
  expect(budgets).toEqual([500, 500, 500]); expect(disposed).toBe(3);
  expect(f.opened).toBe(1); expect(f.finiteCalls).toBe(0);
});

test("ordinary resident analysis returns actual source assertions only as bounded untrusted advice", async () => {
  const f = await fixture(async (budget, bundle, signal) => await residentAnalysisProcess(bundle, budget, signal));
  f.running(); const execution = f.start(); await f.firstStep.promise;
  const analysis = await f.sources.register(f.run.run_id, { entry: "analyze", name: "assertion probe",
    source: "export function analyze(input) { if (!input) throw new TypeError('probe assertion: input required'); return input; }",
    card, dependencies: [] });
  const result = await f.manager.analyzeResident(f.run.run_id, execution.execution_id,
    { skill_id: analysis.skill_id, version: analysis.version }, false, 0);
  expect(result).toMatchObject({ status: "failed", output: null,
    source: { skill_id: analysis.skill_id, version: analysis.version, hash: analysis.hash },
    source_diagnostic: { advisory: true, trusted_origin: false, origin: "source_throw", diagnostic: {
      type: "TypeError", message: "probe assertion: input required", source_hash: analysis.hash,
      location: { mapping: "unmapped" },
    } } });
  expect(result.reason).not.toContain("probe assertion");
  expect(result.elapsed_ms).toBeGreaterThan(0);
  expect(f.opened).toBe(1); expect(f.finiteCalls).toBe(0);
});

test("ordinary resident analysis redacts host exceptions, structural spoofs and wrong-source diagnostics", async () => {
  let injected: unknown = new Error("PRIVATE_HOST_ANALYSIS");
  const f = await fixture(async () => ({ async analyze(_input, _signal, report) {
    report?.(1); throw injected;
  }, async close() {} }));
  f.running(); const execution = f.start(); await f.firstStep.promise;
  const analysis = await f.sources.register(f.run.run_id, { entry: "analyze", name: "host boundary probe",
    source: "export function analyze(input) { return input; }", card, dependencies: [] });
  for (const error of [injected, { origin: "source_throw", trustedOrigin: false, message: "PRIVATE_SPOOF",
    sourceDiagnostic: { type: "Error", message: "PRIVATE_SPOOF", source_hash: analysis.hash, location: { mapping: "unmapped" } } },
    new ResidentWorkerFault("source_throw", false, { type: "Error", message: "PRIVATE_WRONG_SOURCE",
      source_hash: "f".repeat(64), location: { mapping: "unmapped" } }),
    new ResidentWorkerFault("watchdog"), new ResidentWorkerFault("transport")]) {
    injected = error;
    const result = await f.manager.analyzeResident(f.run.run_id, execution.execution_id,
      { skill_id: analysis.skill_id, version: analysis.version }, null, 0);
    expect(result.status).toBe("failed"); expect(result.output).toBeNull();
    expect(result.source_diagnostic).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  }
});

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
  const catalog = new RuntimeTools(f.store, f.manager, f.sources, {} as ReactiveRuntime, null, host);
  const tool = catalog.build(1).find(tool => tool.name === "program_run")!;
  f.running();
  const predecessor = f.start();
  await f.firstStep.promise;
  const successor = await f.sources.register(f.run.run_id, { entry: "step", name: "exact successor", source, card, dependencies: [] });
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
  expect(f.closed).toBe(2); // Disposable shadow plus retired predecessor; clean successor remains open.
  expect(f.manager.get(f.run.run_id, { execution_id: predecessor.execution_id })!.status).toBe("cancelled");
  expect(f.finiteCalls).toBe(0);
  await tool.execute("resident-handoff", input);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(2);
  expect(f.manager.effectScope(next.execution_id)).not.toBeNull();
});

test("an admitted prepared successor keeps playing while its own lookahead slot is armed", async () => {
  let planner: SpeculativePlanning;
  const f = await fixture(undefined, {}, { prepareLookahead: config => planner.prepareOptIn(config) });
  const adapter = minecraftTestAdapter();
  const scope = () => ({ run_id: f.run.run_id, generation: 1, session_id: f.run.session_id!, world_id: f.run.world_id,
    epoch: f.run.epoch, life_id: f.run.life_id!, life_status: "alive" as const, task: f.run.task,
    goal: adapter.goals.find(goal => goal.goal_id === "custom")!, native_boot_id: f.run.native_boot_id!,
    space_epoch: f.run.space_epoch!, compatibility_hash: f.run.compatibility_hash!, screen: null });
  planner = new SpeculativePlanning({
    contract: () => adapter, admissionContext: scope,
    context: () => {
      const root = f.store.latestRootExecution(f.run.run_id);
      return root ? { ...scope(), root: { execution_id: root.execution_id, skill_id: root.skill_id,
        version: root.version, hash: root.source_hash!, status: root.status,
        intent_version: root.entry === "step" ? root.resident?.intent_version ?? 0 : null } } : null;
    },
    skill: ref => f.store.skill(f.run.run_id, ref),
    observe: async () => minecraftObservationFixture(adapter),
    evaluateGuard: async () => { throw new Error("No speculative guard in this lifecycle fixture"); },
    admit: async (request, permit) => { permit.assertCurrent(); return f.manager.start(f.run.run_id, request); },
    evidence: (type, details) => { f.store.event(f.run.run_id, type, type, details); }, wake: () => {},
  });
  cleanup.unshift(async () => { planner.invalidate(); });
  f.running();
  const predecessor = f.start(); await f.firstStep.promise;
  const successor = await f.sources.register(f.run.run_id, { entry: "step", name: "prepared with next", source, card, dependencies: [] });
  const request = { entry: "step" as const, skill_id: successor.skill_id, version: successor.version,
    start_key: "prepared-own-slot", ...executionScopeFixture(f.run), args: null, initial_state: 0,
    limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 9000 },
    lookahead: { after_ms: 8000, reason: "Independent later source", budget: { calls: 1, tools: 1, duration_ms: 3000 } } };
  const retired = await f.manager.retireForHandoff(f.run.run_id, request, predecessor.execution_id, undefined);
  retired();
  const admitted = f.manager.start(f.run.run_id, request);
  await until(f.store, f.run.run_id, () => {
    const view = f.manager.get(f.run.run_id, { execution_id: admitted.execution_id });
    return view?.ended_at !== null || view.entry === "step" && (view.resident?.counters.steps ?? 0) >= 2;
  });
  const playing = f.manager.get(f.run.run_id, { execution_id: admitted.execution_id })!;
  expect(playing).toMatchObject({ status: "running", ended_at: null, resident: { status: "running" } });
  expect(planner.projection()).toMatchObject({ state: "armed", basis: { root: { execution_id: admitted.execution_id } } });
  const originalScope = f.manager.effectScope(admitted.execution_id);
  await expect(f.manager.retireForHandoff(f.run.run_id, { ...request, start_key: "competing-prepared" },
    admitted.execution_id, undefined)).rejects.toMatchObject({ code: "conflict" });
  expect(f.manager.effectScope(admitted.execution_id)).toEqual(originalScope);
  planner.invalidate();
  await until(f.store, f.run.run_id, () => {
    const view = f.manager.get(f.run.run_id, { execution_id: admitted.execution_id });
    return view?.ended_at !== null || view.entry === "step" &&
      (view.resident?.counters.steps ?? 0) > (playing.entry === "step" ? playing.resident!.counters.steps : 0);
  });
  expect(f.manager.get(f.run.run_id, { execution_id: admitted.execution_id })).toMatchObject({ status: "running", ended_at: null });
});

// Shipped supervisor/module thread through a plain Node pipe. Docker and native
// application are deliberately substituted, not claimed by these lifecycle tests.
async function residentProcess(bundle: ExecutableModuleBundle, signal: AbortSignal): Promise<ResidentWorker> {
  const executable = Bun.which("node");
  if (!executable) throw new Error("Node is required for the shipped worker fixture");
  const child = spawn(executable, [new URL("../sandbox/worker.mjs", import.meta.url).pathname, "resident", "250"],
    { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" } });
  const exited = Promise.withResolvers<void>(), lines: unknown[] = [];
  const waiting: ReturnType<typeof Promise.withResolvers<unknown>>[] = [];
  let buffer = "", ended = false, sequence = 0;
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(frame); else lines.push(frame);
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.on("error", error => { for (const waiter of waiting.splice(0)) waiter.reject(error); });
  child.once("close", () => {
    ended = true; exited.resolve();
    for (const waiter of waiting.splice(0)) waiter.reject(new Error("Fixture resident exited"));
  });
  const read = () => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (ended) return Promise.reject(new Error("Fixture resident closed"));
    const result = Promise.withResolvers<unknown>(); waiting.push(result); return result.promise;
  };
  const close = async () => { signal.removeEventListener("abort", abort); child.stdin.end(); await exited.promise; };
  const abort = () => { child.stdin.end(); };
  signal.addEventListener("abort", abort, { once: true });
  cleanup.unshift(close);
  try {
    expect(await read()).toEqual({ v: 1, type: "resident_ready", id: 0,
      runtime_features: ["pure_modules_v1", "motion_track_v1"] });
    child.stdin.write(JSON.stringify({ v: 1, type: "resident_init", id: 0, entry: "step", bundle }) + "\n");
    expect(await read()).toEqual({ v: 1, type: "resident_compiled", id: 0 });
    const compute = async (type: string, frame: unknown, state: Json, intent: Json) => {
      const id = ++sequence;
      child.stdin.write(JSON.stringify({ v: 1, type, id, frame, state, intent }) + "\n");
      const reply = await read() as { type: string; value: unknown; origin: ResidentWorkerFaultOrigin; diagnostic?: unknown };
      if (reply.type !== "resident_result") {
        const failure = new ResidentWorkerFault(reply.origin, false, reply.diagnostic);
        if (reply.origin === "source_throw" && failure.sourceDiagnostic?.source_hash !== bundle.source_hash)
          throw new Error("Invalid fixture source fault identity");
        throw failure;
      }
      return reply.value;
    };
    return {
      step: async (frame, state, intent) => residentDecisionSchema.parse(await compute("resident_step", frame, state, intent)),
      activate: async (frame, state, intent) => residentActivationResultSchema.parse(await compute("resident_activate", frame, state, intent)),
      close,
    };
  } catch (error) { await close(); throw error; }
}

test("shipped worker classifies source throws independently of authored watchdog text", async () => {
  const worker = await residentProcess(singletonExecutableModuleBundle("export function step(frame,state,intent){throw new Error('resident_step_watchdog transport cleanup');}", "step"),
    new AbortController().signal);
  try {
    await expect(worker.step(controllerFrameFixture() as Parameters<ResidentWorker["step"]>[0], null, null))
      .rejects.toMatchObject({ origin: "source_throw", trustedOrigin: false });
  } finally { await worker.close(); }
});

test.each([false, true])("ordinary inspection retains actual source failure as separate untrusted advice (session=%s)", async session => {
  const f = await fixture(undefined, {}, {
    createResidentWorker: async (bundle, _budget, signal) => await residentProcess(bundle, signal),
    sessionTask: async () => { throw new Error("No task dispatch"); },
    superviseSessionTask: async () => {}, retireSessionTask: async () => {},
  });
  const tools = inspectionTools(f), runTool = tools.find(tool => tool.name === "program_run")!;
  const inspect = tools.find(tool => tool.name === "program_inspect")!;
  const library = await f.sources.register(f.run.run_id, { entry: "library", name: "point reader",
    source: "export function readX(state) { return state.lastPos.x; }", card, dependencies: [] });
  const failing = await f.sources.register(f.run.run_id, { entry: "step", name: "source fault",
    source: `import {readX} from "./point.js";
      export function activate(frame,state,intent) { readX(state); }
      export function step(frame,state,intent) { readX(state); }`, card,
    dependencies: [{ skill_id: library.skill_id, version: library.version, import_path: "./point.js" }] });
  const started = await runTool.execute("source-failure-start", { operation: "start", entry: "step",
    name: failing.name, version: failing.version, args: null, initial_state: {},
    ...(session ? { session: { schema_version: 1 } } : {}) });
  expect(started.isError).not.toBe(true);
  const execution = f.store.latestRootExecution(f.run.run_id)!;
  await until(f.store, f.run.run_id, () => f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!.ended_at !== null);
  expect(execution.source_hash).not.toBe(failing.hash);
  const reply = await inspect.execute("source-failure-inspect", {
    view: "execution", target: "latest", program: { name: failing.name, version: failing.version },
  });
  expect(reply.isError).not.toBe(true);
  const visible = JSON.parse(reply.content.filter(entry => entry.type === "text").map(entry => entry.text).join(""));
  const diagnostic = { type: "ResidentWorkerFailure", code: "resident_source_throw",
    message: "Resident worker failed (source_throw).", source_hash: execution.source_hash, location: { mapping: "unmapped" },
    source_diagnostic: { advisory: true, trusted_origin: false, origin: "source_throw", diagnostic: {
      type: "TypeError", message: "Cannot read properties of undefined (reading 'x')",
      source_hash: execution.source_hash, location: { mapping: "unmapped" },
    } } };
  expect(visible).toMatchObject({ name: failing.name, version: failing.version, status: "failed",
    error: diagnostic.message, diagnostic, result: { status: "failed", summary: diagnostic.message, result: null },
    resident: { status: "failed", cleanup: { worker: "closed", native: "retired" } },
  });
  const events = await inspect.execute("source-failure-events", { view: "events", after: 0, limit: 100 });
  expect(events.isError).not.toBe(true);
  const page = JSON.parse(events.content.filter(entry => entry.type === "text").map(entry => entry.text).join(""));
  const closed = page.records.find((event: { type: string; details: { execution_id?: string } }) =>
    event.type === "skill.closed" && event.details.execution_id === execution.execution_id);
  expect(closed).toMatchObject({
    type: "skill.closed", summary: diagnostic.message,
    details: { execution_id: execution.execution_id, root_execution_id: execution.root_execution_id,
      status: "failed", actions: 0, calls: 0, details: { diagnostic } },
  });
  expect(f.manager.effectScope(execution.execution_id)).toBeNull();
  expect(f.finiteCalls).toBe(0);
});

test.each([false, true])("ordinary inspection cannot promote unbranded or wrong-source failure advice (session=%s)", async session => {
  let injected: unknown;
  const f = await fixture(undefined, {}, { createResidentWorker: async () => { throw injected; },
    sessionTask: async () => { throw new Error("No task dispatch"); },
    superviseSessionTask: async () => {}, retireSessionTask: async () => {},
  });
  const tools = inspectionTools(f), runTool = tools.find(tool => tool.name === "program_run")!;
  const inspect = tools.find(tool => tool.name === "program_inspect")!;
  const diagnostic = { type: "TypeError", message: "PRIVATE_SOURCE", source_hash: "f".repeat(64),
    location: { mapping: "unmapped" } };
  const errors = [
    new Error("PRIVATE_HOST_PATH_ENV_PROVIDER_NATIVE"),
    Object.assign(new Error("Resident worker failed (source_throw). PRIVATE_HOST"), {
      name: "ResidentWorkerFault", origin: "source_throw", sourceDiagnostic: diagnostic,
      source_diagnostic: { advisory: true, trusted_origin: false, origin: "source_throw", diagnostic },
    }),
    { origin: "source_throw", trustedOrigin: false, sourceDiagnostic: diagnostic, message: "PRIVATE_STRUCTURAL" },
    Object.assign(Object.create(ResidentWorkerFault.prototype), { origin: "source_throw", sourceDiagnostic: diagnostic,
      message: "PRIVATE_PROTOTYPE", stack: "PRIVATE_STACK" }),
    new ResidentWorkerFault("source_throw", false, diagnostic),
    new ResidentWorkerFault("source_throw", false),
    new ResidentWorkerFault("watchdog"), new ResidentWorkerFault("transport"),
    new ResidentWorkerFault("opaque"), new ResidentWorkerFault("cleanup"),
  ];
  for (const [index, error] of errors.entries()) {
    injected = error;
    const started = await runTool.execute(`redacted-start-${index}`, { operation: "start", entry: "step",
      name: f.program.name, version: f.program.version, args: null, initial_state: 0,
      ...(session ? { session: { schema_version: 1 } } : {}) });
    expect(started.isError).not.toBe(true);
    const execution = f.store.latestRootExecution(f.run.run_id)!;
    await until(f.store, f.run.run_id, () => f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!.ended_at !== null);
    const reply = await inspect.execute(`redacted-inspect-${index}`, {
      view: "execution", target: "latest", program: { name: f.program.name, version: f.program.version },
    });
    expect(reply.isError).not.toBe(true);
    const text = reply.content.filter(entry => entry.type === "text").map(entry => entry.text).join("");
    const visible = JSON.parse(text);
    expect(visible.status).toBe("failed");
    expect(visible.diagnostic.source_diagnostic).toBeUndefined();
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("stack");
  }
  expect(f.opened).toBe(0); expect(f.finiteCalls).toBe(0);
});

test.each([false, true])("ordinary inspection redacts host failures after a live snapshot exists (session=%s)", async session => {
  let injected: unknown;
  let entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fail = async () => { entered.resolve(); await release.promise; throw injected; };
  const f = await fixture(undefined, {}, { createResidentWorker: async () => ({
    step: fail, activate: fail, close: async () => {},
  }),
    sessionTask: async () => { throw new Error("No task dispatch"); },
    superviseSessionTask: async () => {}, retireSessionTask: async () => {},
  });
  cleanup.unshift(async () => { release.resolve(); });
  const tools = inspectionTools(f), runTool = tools.find(tool => tool.name === "program_run")!;
  const inspect = tools.find(tool => tool.name === "program_inspect")!;
  const diagnostic = { type: "TypeError", message: "PRIVATE_WRONG_SOURCE", source_hash: "f".repeat(64),
    location: { mapping: "unmapped" } };
  const errors = [
    new Error("PRIVATE_HOST_PATH_ENV_PROVIDER_NATIVE"),
    { origin: "source_throw", trustedOrigin: false, sourceDiagnostic: diagnostic,
      message: "PRIVATE_STRUCTURAL", stack: "PRIVATE_STACK" },
    Object.assign(Object.create(ResidentWorkerFault.prototype), { origin: "source_throw",
      sourceDiagnostic: diagnostic, message: "PRIVATE_PROTOTYPE", stack: "PRIVATE_STACK" }),
    new ResidentWorkerFault("source_throw", false, diagnostic),
  ];
  for (const [index, error] of errors.entries()) {
    entered = Promise.withResolvers<void>(); release = Promise.withResolvers<void>(); injected = error;
    const started = await runTool.execute(`live-redacted-start-${index}`, { operation: "start", entry: "step",
      name: f.program.name, version: f.program.version, args: null, initial_state: 0,
      ...(session ? { session: { schema_version: 1 } } : {}) });
    expect(started.isError).not.toBe(true);
    await entered.promise;
    const execution = f.store.latestRootExecution(f.run.run_id)!;
    const before = await inspect.execute(`live-before-fault-${index}`, {
      view: "execution", target: "current", program: { name: f.program.name, version: f.program.version },
    });
    expect(before.details).toMatchObject({ status: "running", resident: { status: "running" } });
    release.resolve();
    await until(f.store, f.run.run_id, () => f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!.ended_at !== null);
    const reply = await inspect.execute(`live-redacted-inspect-${index}`, {
      view: "execution", target: "latest", program: { name: f.program.name, version: f.program.version },
    });
    expect(reply.isError).not.toBe(true);
    const text = reply.content.filter(entry => entry.type === "text").map(entry => entry.text).join("");
    const visible = JSON.parse(text);
    expect(visible).toMatchObject({ status: "failed", resident: { status: "failed",
      cleanup: { worker: "closed", native: "retired" } } });
    expect(visible.diagnostic.source_diagnostic).toBeUndefined();
    expect(visible.resident.reason).toBe(session ? visible.diagnostic.message : `resident_step: ${visible.diagnostic.message}`);
    expect(text).not.toContain("PRIVATE"); expect(text).not.toContain("stack");
  }
  expect(f.finiteCalls).toBe(0);
});

test.each([false, true])("ordinary inspection bounds source text without serializing hostile thrown objects (session=%s)", async session => {
  const f = await fixture(undefined, {}, {
    createResidentWorker: async (bundle, _budget, signal) => await residentProcess(bundle, signal),
    sessionTask: async () => { throw new Error("No task dispatch"); },
    superviseSessionTask: async () => {}, retireSessionTask: async () => {},
  });
  const tools = inspectionTools(f), runTool = tools.find(tool => tool.name === "program_run")!;
  const inspect = tools.find(tool => tool.name === "program_inspect")!;
  const cases = [
    { body: `throw {message:"PRIVATE_THROWN_OBJECT",stack:"PRIVATE_STACK",
        get name(){throw new Error("PRIVATE_GETTER");},toJSON(){throw new Error("PRIVATE_JSON");},
        toString(){throw new Error("PRIVATE_COERCION");}};`,
      type: "ThrownValue", message: "Generated program threw a non-error value (not serialized)" },
    { body: `throw new Error("UNTRUSTED_AUTHORED_TEXT ".repeat(100));`,
      type: "Error", message: "UNTRUSTED_AUTHORED_TEXT ".repeat(100).slice(0, 1000) },
  ];
  for (const [index, entry] of cases.entries()) {
    const selected = await f.sources.register(f.run.run_id, { entry: "step", name: `bounded source ${index}`,
      source: `export function activate(frame,state,intent){${entry.body}}
        export function step(frame,state,intent){${entry.body}}`, card, dependencies: [] });
    const started = await runTool.execute(`bounded-source-start-${index}`, { operation: "start", entry: "step",
      name: selected.name, version: selected.version, args: null, initial_state: 0,
      ...(session ? { session: { schema_version: 1 } } : {}) });
    expect(started.isError).not.toBe(true);
    const execution = f.store.latestRootExecution(f.run.run_id)!;
    await until(f.store, f.run.run_id, () => f.manager.get(f.run.run_id, { execution_id: execution.execution_id })!.ended_at !== null);
    const reply = await inspect.execute(`bounded-source-inspect-${index}`, {
      view: "execution", target: "latest", program: { name: selected.name, version: selected.version },
    });
    expect(reply.isError).not.toBe(true);
    const text = reply.content.filter(entry => entry.type === "text").map(entry => entry.text).join("");
    const visible = JSON.parse(text);
    expect(visible).toMatchObject({ status: "failed", error: "Resident worker failed (source_throw).",
      diagnostic: { source_diagnostic: { advisory: true, trusted_origin: false, origin: "source_throw",
        diagnostic: { type: entry.type, message: entry.message, source_hash: execution.source_hash,
          location: { mapping: "unmapped" } } } } });
    expect(visible.resident.reason).not.toContain("UNTRUSTED_AUTHORED_TEXT");
    expect(text).not.toContain("PRIVATE"); expect(text).not.toContain("stack");
  }
  expect(f.finiteCalls).toBe(0);
});

test("actual manager prepares both slow workers before retirement and discards shadow module globals", async () => {
  const shadowHeld = Promise.withResolvers<void>(), cleanHeld = Promise.withResolvers<void>();
  const releaseShadow = Promise.withResolvers<void>(), releaseClean = Promise.withResolvers<void>();
  let candidateSource = "", factories = 0, retired = false;
  const f = await fixture(undefined, {}, {
    retire: async () => { retired = true; },
    createResidentWorker: async (published, _budget, signal) => {
      if (published.modules.find(module => module.id === "root")?.source === candidateSource) {
        expect(retired).toBe(false);
        factories++;
        if (factories === 1) { shadowHeld.resolve(); await releaseShadow.promise; }
        else { cleanHeld.resolve(); await releaseClean.promise; }
      }
      return await residentProcess(published, signal);
    },
  });
  cleanup.unshift(async () => { releaseShadow.resolve(); releaseClean.resolve(); });
  const incumbent = await f.sources.register(f.run.run_id, { entry: "step", name: "useful incumbent",
    source: source.replace("status:'completed'", "status:'running'"), card, dependencies: [] });
  const request = { entry: "step" as const, skill_id: incumbent.skill_id, version: incumbent.version, start_key: "prepared-incumbent",
    ...executionScopeFixture(f.run), args: null, initial_state: 0, limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 10000, step_ms: 250 } };
  f.running();
  const old = f.manager.start(f.run.run_id, request);
  await until(f.store, f.run.run_id, () => {
    const execution = f.manager.get(f.run.run_id, { execution_id: old.execution_id });
    return execution?.entry === "step" && (execution.resident?.counters.steps ?? 0) >= 1;
  });
  const successor = await f.sources.register(f.run.run_id, { entry: "step", name: "private global successor", card, dependencies: [],
    source: `let visits=0; ${source.replace("next_state:state", "next_state:{visits:++visits,frame:frame.frame_seq}")}` });
  candidateSource = successor.source;
  const next = { ...request, skill_id: successor.skill_id, version: successor.version, start_key: "prepared-successor" };
  const transferring = f.manager.retireForHandoff(f.run.run_id, next, old.execution_id, undefined);
  await shadowHeld.promise;
  expect(f.manager.effectScope(old.execution_id)).not.toBeNull(); expect(retired).toBe(false);
  releaseShadow.resolve(); await cleanHeld.promise;
  expect(f.manager.effectScope(old.execution_id)).not.toBeNull(); expect(retired).toBe(false);
  releaseClean.resolve(); (await transferring)();
  expect(factories).toBe(2);
  const admitted = f.manager.start(f.run.run_id, next);
  await until(f.store, f.run.run_id, () => !!f.manager.get(f.run.run_id, { execution_id: admitted.execution_id })?.ended_at);
  const result = f.manager.get(f.run.run_id, { execution_id: admitted.execution_id })!;
  expect(result.status).toBe("succeeded");
  if (result.entry !== "step") throw new Error("Expected resident successor");
  expect(result.resident?.state).toMatchObject({ visits: 1 });
  expect(result.resident?.cleanup).toEqual({ worker: "closed", native: "retired" });
  expect(Date.parse(result.deadline_at)).toBeLessThanOrEqual(Date.parse(old.deadline_at) + 1);
  expect(factories).toBe(2); // No post-retirement factory, even with the same slow source.
});

test("prepared successor consumes predecessor identity at admission before its first live activation", async () => {
  let factories = 0, currentChecks = 0;
  const activated: number[] = [], closed: number[] = [];
  const f = await fixture(undefined, {}, { createResidentWorker: async () => {
    const id = ++factories;
    const decision = (state: Json, status: "running" | "completed") => ({
      input: { kind: "world" as const, held: { forward: false, back: false, left: false, right: false,
        jump: false, sprint: false, sneak: false, attack: false, use: false }, edges: [],
      view: { kind: "unchanged" as const }, selected_hotbar: null },
      next_state: state, status, events: [],
    });
    return {
      step: async (_frame, state) => {
        if (id !== 1) throw new Error("Prepared successor must activate before stepping");
        return decision(state, "running");
      },
      activate: async (frame, _state, _intent) => {
        activated.push(id);
        return decision({ worker: id, frame: frame.frame_seq }, "completed");
      },
      close: async () => { closed.push(id); },
    };
  } });
  f.running();
  const old = f.start();
  await until(f.store, f.run.run_id, () => f.opened === 1);
  const next = { entry: "step" as const, skill_id: f.program.skill_id, version: f.program.version,
    start_key: "prepared-identity-consumed", ...executionScopeFixture(f.run), args: null, initial_state: 0,
    limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 10000 } };
  await f.manager.prepareResidentHandoff(f.run.run_id, next, old.execution_id, undefined, () => {
    currentChecks++;
    if (f.store.latestRootExecution(f.run.run_id)?.execution_id !== old.execution_id)
      throw new Error("Predecessor-only admission permit is no longer current");
  });
  (await f.manager.retireForHandoff(f.run.run_id, next, old.execution_id, undefined))();
  const successor = f.manager.start(f.run.run_id, next), admissionChecks = currentChecks;
  await until(f.store, f.run.run_id, () => !!f.manager.get(f.run.run_id, { execution_id: successor.execution_id })?.ended_at);
  const final = f.manager.get(f.run.run_id, { execution_id: successor.execution_id })!;
  expect(final.status).toBe("succeeded");
  if (final.entry !== "step") throw new Error("Expected resident successor");
  expect(final.resident?.state).toMatchObject({ worker: 3 });
  expect(final.resident?.cleanup).toEqual({ worker: "closed", native: "retired" });
  expect(currentChecks).toBe(admissionChecks);
  expect(activated).toEqual([2, 3]);
  expect(closed).toEqual([2, 1, 3]);
  expect(f.opened).toBe(2);
  expect(factories).toBe(3);
});

test("dynamically invalid canonical candidate leaves the actual manager incumbent viable", async () => {
  let badSource = "", invalidClosed = 0;
  const f = await fixture(undefined, {}, { createResidentWorker: async (published, _budget, signal) => {
    const worker = await residentProcess(published, signal);
    return { ...worker, async close() { if (published.modules.find(module => module.id === "root")?.source === badSource) invalidClosed++; await worker.close(); } };
  } });
  f.running();
  const incumbent = await f.sources.register(f.run.run_id, { entry: "step", name: "retained incumbent",
    source: source.replace("status:'completed'", "status:'running'"), card, dependencies: [] });
  const request = { entry: "step" as const, skill_id: incumbent.skill_id, version: incumbent.version, start_key: "invalid-incumbent",
    ...executionScopeFixture(f.run), args: null, initial_state: 0, limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 10000, step_ms: 250 } };
  const old = f.manager.start(f.run.run_id, request);
  await until(f.store, f.run.run_id, () => f.opened === 1);
  const invalid = await f.sources.register(f.run.run_id, { entry: "step", name: "dynamic invalid", card, dependencies: [],
    source: "export function step(frame,state,intent){return {input:null,next_state:state,status:'running',events:[]};}" });
  badSource = invalid.source;
  await expect(f.manager.retireForHandoff(f.run.run_id, { ...request, skill_id: invalid.skill_id, version: invalid.version,
    start_key: "invalid-successor" }, old.execution_id, undefined)).rejects.toThrow();
  expect(f.manager.effectScope(old.execution_id)).not.toBeNull();
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  expect(invalidClosed).toBe(1);
});

for (const failedFactory of [1, 2])
test(`candidate startup failure in preparation worker ${failedFactory} preserves incumbent`, async () => {
  let candidateSource = "", attempts = 0, candidateClosed = 0;
  const f = await fixture(undefined, {}, { createResidentWorker: async (published, _budget, signal) => {
    if (published.modules.find(module => module.id === "root")?.source === candidateSource && ++attempts === failedFactory) throw new Error("Injected startup failure");
    const worker = await residentProcess(published, signal);
    return { ...worker, async close() { if (published.modules.find(module => module.id === "root")?.source === candidateSource) candidateClosed++; await worker.close(); } };
  } });
  f.running();
  const incumbent = await f.sources.register(f.run.run_id, { entry: "step", name: "startup incumbent",
    source: source.replace("status:'completed'", "status:'running'"), card, dependencies: [] });
  const request = { entry: "step" as const, skill_id: incumbent.skill_id, version: incumbent.version, start_key: "startup-incumbent",
    ...executionScopeFixture(f.run), args: null, initial_state: 0, limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 10000, step_ms: 250 } };
  const old = f.manager.start(f.run.run_id, request);
  await until(f.store, f.run.run_id, () => f.opened === 1);
  const successor = await f.sources.register(f.run.run_id, { entry: "step", name: "startup successor", source, card, dependencies: [] });
  candidateSource = successor.source;
  await expect(f.manager.retireForHandoff(f.run.run_id, { ...request, skill_id: successor.skill_id, version: successor.version,
    start_key: "startup-successor" }, old.execution_id, undefined)).rejects.toThrow();
  expect(attempts).toBe(failedFactory);
  expect(candidateClosed).toBe(failedFactory - 1);
  expect(f.manager.effectScope(old.execution_id)).not.toBeNull();
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  expect(f.store.latestEvent(f.run.run_id, "program.preparation_failed")?.details).toMatchObject({
    predecessor_execution_id: old.execution_id, source_hash: successor.hash,
    stage: failedFactory === 1 ? "shadow_start" : "clean_start",
    fault: { kind: "opaque" }, predecessor_retirement_started: false,
  });
  expect(f.store.latestEvent(f.run.run_id, "program.preparation_cleanup")?.details).toMatchObject({ workers_closed: true });
});

for (const race of ["Stop", "scope", "intent", "source"] as const)
test(`prepared clean workers close on ${race} races without a second owner`, async () => {
  let created = 0, closedWorkers = 0;
  const f = await fixture(undefined, {}, { createResidentWorker: async () => {
    created++;
    let closed = false;
    return {
      step: async (_frame, state) => ({
        input: { kind: "world" as const, held: { forward: false, back: false, left: false, right: false,
          jump: false, sprint: false, sneak: false, attack: false, use: false }, edges: [],
        view: { kind: "unchanged" as const }, selected_hotbar: null },
        next_state: state, status: "running" as const, events: [],
      }),
      close: async () => { if (!closed) { closed = true; closedWorkers++; } },
    };
  } });
  f.running();
  const old = f.start();
  await until(f.store, f.run.run_id, () => f.opened === 1);
  const next = { entry: "step" as const, skill_id: f.program.skill_id, version: f.program.version,
    start_key: `ready-race-${race}`, ...executionScopeFixture(f.run), args: null, initial_state: 0,
    limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 10000 } };
  const prepared = await f.manager.prepareResidentHandoff(f.run.run_id, next, old.execution_id);
  expect(created).toBe(3); expect(closedWorkers).toBe(1);
  if (race === "Stop") f.manager.cancel(f.run.run_id, { execution_id: old.execution_id });
  if (race === "scope") { f.run.life_id = f.run.life_id! + 1; f.manager.fence("life changed"); }
  if (race === "intent") {
    f.manager.updateResidentIntent(f.run.run_id, old.execution_id, { changed: true }, 0);
    expect(prepared.assertCurrent).toThrow();
    await prepared.close();
    expect(f.manager.effectScope(old.execution_id)).not.toBeNull();
  }
  if (race === "source") {
    (await f.manager.retireForHandoff(f.run.run_id, next, old.execution_id, undefined))();
    const other = await f.sources.register(f.run.run_id, { entry: "step", name: "mismatched ready source", source, card, dependencies: [] });
    expect(() => f.manager.start(f.run.run_id, { ...next, skill_id: other.skill_id, version: other.version })).toThrow();
  }
  await prepared.close();
  if (race === "Stop" || race === "scope") await f.manager.closeAll("Race drained");
  expect(closedWorkers).toBe(race === "intent" ? 2 : 3);
  expect(f.opened).toBe(1);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
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
  const next = await f.sources.register(f.run.run_id, { entry: "run", name: "prepared follow-up",
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

test("session children cap finite invocation limits without shrinking aggregate session budgets", async () => {
  let workerLimits: SkillLimits | null = null;
  const noTask = async (): Promise<never> => { throw new Error("Budget test must not dispatch a session task"); };
  const f = await fixture(undefined, {}, {
    sessionTask: noTask, superviseSessionTask: noTask, retireSessionTask: noTask,
    runSkill: async (_source, _args, handle, limits) => {
      workerLimits = limits;
      await handle({ kind: "progress", summary: "Child capability accounting", details: null });
      return { status: "completed", summary: "Finite child settled", result: null };
    },
  });
  const child = await f.sources.register(f.run.run_id, { entry: "run", name: "bounded child",
    source: 'return {status:"completed",summary:"Child",result:null};', card, dependencies: [] });
  const parent = await f.sources.register(f.run.run_id, { entry: "step", name: "session budget owner",
    source, card, dependencies: [{ skill_id: child.skill_id, version: child.version }] });
  const session = controlSessionConfigSchema.parse({ schema_version: 1 });
  f.hold();
  const root = f.manager.start(f.run.run_id, { entry: "step", skill_id: parent.skill_id, version: parent.version,
    start_key: "session-finite-budgets", ...executionScopeFixture(f.run), args: null, initial_state: 0,
    limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 10000 }, session });
  await f.compiled.promise;
  f.manager.consumeSessionAction(root);
  const result = await f.manager.runSessionChild(root, { name: child.name, version: child.version }, null,
    1000, 1, new AbortController().signal);
  expect(result.status).toBe("succeeded");
  const admitted = f.store.allSkillExecutions(f.run.run_id).find(execution => execution.parent_execution_id === root.execution_id)!;
  expect(admitted.limits).toMatchObject({ max_actions: MAX_SKILL_LIMITS.max_actions,
    max_calls: MAX_SKILL_LIMITS.max_calls, max_depth: MAX_SKILL_LIMITS.max_depth });
  expect(workerLimits).toMatchObject({ max_actions: MAX_SKILL_LIMITS.max_actions,
    max_calls: MAX_SKILL_LIMITS.max_calls, max_depth: MAX_SKILL_LIMITS.max_depth - 1 });
  const current = f.manager.get(f.run.run_id, { execution_id: root.execution_id })!;
  expect(current).toMatchObject({ calls: 3, actions: 1, session });
  expect(f.manager.effectScope(root.execution_id)).not.toBeNull();
});

for (const exhausted of ["max_actions", "max_calls"] as const)
test(`direct session actions consume shared counters and enforce aggregate ${exhausted}`, async () => {
  const noTask = async (): Promise<never> => { throw new Error("Budget test must not dispatch a session task"); };
  const f = await fixture(undefined, {}, {
    sessionTask: noTask, superviseSessionTask: noTask, retireSessionTask: noTask,
  });
  f.hold();
  const root = f.manager.start(f.run.run_id, { entry: "step", skill_id: f.program.skill_id, version: f.program.version,
    start_key: `session-direct-action-budget-${exhausted}`, ...executionScopeFixture(f.run), args: null, initial_state: 0,
    limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 10000 },
    session: controlSessionConfigSchema.parse({ schema_version: 1,
      max_actions: exhausted === "max_actions" ? 1 : 2, max_calls: exhausted === "max_calls" ? 1 : 2 }) });
  await f.compiled.promise;
  f.manager.consumeSessionAction(root);
  expect(f.manager.get(f.run.run_id, { execution_id: root.execution_id })).toMatchObject({ calls: 1, actions: 1 });
  expect(() => f.manager.consumeSessionAction(root)).toThrow(new RegExp(exhausted));
  expect(f.manager.effectScope(root.execution_id)).toBeNull();
  expect(f.manager.get(f.run.run_id, { execution_id: root.execution_id })).toMatchObject({ calls: 1, actions: 1 });
  f.finishCompile.resolve();
  await f.manager.closeAll("Session action budget exhausted");
  expect(f.manager.get(f.run.run_id, { execution_id: root.execution_id })).toMatchObject({ status: "failed",
    diagnostic: { code: "budget_exceeded" } });
  expect(() => f.manager.consumeSessionAction(root)).toThrow(/live control session/);
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
  const analysis = await f.sources.register(f.run.run_id, { entry: "analyze", name: "analysis", source: "export function analyze(input) { return input; }", card, dependencies: [] });
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
