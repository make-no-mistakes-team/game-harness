import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvaluationCaps } from "../src/evaluation/contracts.ts";
import { NativeFixture, bounded, pause, requireProof, until } from "../src/evaluation/native-game.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { ActionArbiter } from "../src/server/action-arbiter.ts";
import type { Store } from "../src/server/store.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { ResidentLimits, ResidentSnapshot } from "../src/shared/resident.ts";
import type { SkillExecutionView } from "../src/shared/programs.ts";
import { singletonExecutableModuleBundle } from "../src/shared/program-modules.ts";
import type { GameAction, Json } from "../src/shared/contracts.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import type { MinecraftControllerFrame } from "../src/shared/minecraft.ts";
import type { ControllerInput } from "../src/shared/controller.ts";
import { controllerInputSchema, revocationAckSchema, type RevocationAck } from "../src/shared/controller.ts";
import { effectScopeSchema, expectedEffectOwnerSchema, sameEffectScope, type ExpectedEffectOwner } from "../src/shared/control.ts";
import { ResidentSdkCaller, residentBowSource, residentGuiSource, residentThrowSource, residentStopSource,
  residentColdFailureSource, residentInactiveSource } from "./native-resident-agent.ts";

interface WorkerStepTrace {
  started_host_ms: number;
  frame_seq: number;
  captured_native_ns: string;
  native_tick: number;
  active_use: MinecraftControllerFrame["player"]["active_use"];
  last_input: MinecraftControllerFrame["last_input"];
  effect_updates: MinecraftControllerFrame["effect_updates"];
  screen_identity: NonNullable<MinecraftControllerFrame["screen"]>["identity"] | null;
  intent: Json;
  returned_host_ms: number | null;
  input?: ControllerInput;
  status?: string;
  failure?: string;
}
interface WorkerTrace {
  source_sha256: string;
  compile_started_at: string;
  compile_ready_at: string | null;
  compile_failure: string | null;
  close_started_at: string | null;
  close_completed_at: string | null;
  steps: WorkerStepTrace[];
}
interface Session {
  caller: ResidentSdkCaller;
  runtime: Runtime;
  runId: string;
  entry: Record<string, unknown>;
  workers: WorkerTrace[];
  grants: NativeGrantTrace[];
  current(): SkillExecutionView | undefined;
  resident(): ResidentSnapshot | null;
}
interface NativeGrantTrace {
  owner: ExpectedEffectOwner;
  controller_generation: number;
  granted_host_ms: number;
}
type EvaluatorFaultIntervention = { commands: readonly string[] } | { action: GameAction };
type StepExecution = Extract<SkillExecutionView, { entry: "step" }>;
const executionScopeProjection = effectScopeSchema.strip();

/** A cleanup deadline is a verdict, not permission to abandon its owner.
 * Keep the actual close promise joined even after its allowance expires. */
export async function joinResidentCleanup(operation: Promise<unknown>, deadlineHostMs: number, message: string): Promise<void> {
  let failed = false, failure: unknown;
  try { await operation; } catch (error) { failed = true; failure = error; }
  if (performance.now() > deadlineHostMs)
    throw new Error(message, failed ? { cause: failure } : undefined);
  if (failed) throw failure;
}

export function assertLiveResidentFaultOwner(execution: SkillExecutionView): asserts execution is StepExecution {
  requireProof(execution.entry === "step" && execution.status === "running" && execution.ended_at === null &&
    execution.resident?.status === "running" && execution.resident.cleanup.worker === "open" &&
    execution.resident.cleanup.native === "open" && execution.resident.last_input?.held.use === true &&
    execution.resident.last_input.input_application === "confirmed" && execution.resident.last_input.ordered_edge_prefix === 1 &&
    execution.resident.counters.ordered_edge_prefix === 1,
  "Scope fault requires a still-running original resident with actual confirmed held use and one consumed press");
}

/** Reject false-positive lifecycle evidence; this is not a gameplay verifier. */
export function assertResidentFaultRetirement(original: SkillExecutionView, terminal: SkillExecutionView,
  grant: NativeGrantTrace, acknowledgement: RevocationAck) {
  assertLiveResidentFaultOwner(original);
  requireProof(terminal.entry === "step" && terminal.status === "cancelled" && terminal.ended_at !== null &&
    terminal.resident?.status === "stopped" && terminal.resident.intent_version === 0 &&
    terminal.resident.cleanup.worker === "closed" && terminal.resident.cleanup.native === "retired",
  "Scope fault must cancel and actually retire the live original root, not accept an unrelated source failure");
  const scope = executionScopeProjection.parse(original), after = executionScopeProjection.parse(terminal);
  const owner = expectedEffectOwnerSchema.parse(grant.owner), ack = revocationAckSchema.parse(acknowledgement);
  requireProof(sameEffectScope(scope, after) && sameEffectScope(scope, owner.scope) &&
    original.compatibility_hash === terminal.compatibility_hash &&
    terminal.resident.execution_id === original.execution_id && terminal.resident.source_hash === original.source_hash,
  "Scope-fault execution and native grant must preserve the original sealed source/session/life/space identity");
  requireProof(ack.owner.operation_id === owner.operation_id && ack.owner.generation === owner.generation &&
    sameEffectScope(ack.owner.scope, owner.scope) && ack.controller_generation === grant.controller_generation &&
    original.resident!.controller_generation === grant.controller_generation &&
    terminal.resident.controller_generation === grant.controller_generation,
  "Scope-fault retirement must match the actual original native owner and both generations");
  const beforeSequence = original.resident!.counters.applied_sequence, afterSequence = terminal.resident.counters.applied_sequence;
  requireProof(terminal.resident.counters.ordered_edge_prefix === 1 && ack.ordered_edge_prefix === 1 &&
    afterSequence >= beforeSequence && ack.last_applied_sequence >= afterSequence &&
    ack.unresolved_operation_refs.includes(owner.operation_id),
  "Scope-fault retirement lost or duplicated its consumed prefix, regressed applications, or erased unresolved effects");
  return { owner_operation_id: owner.operation_id, native_owner_generation: owner.generation,
    controller_generation: grant.controller_generation, ordered_edge_prefix: ack.ordered_edge_prefix,
    application_sequence_advance: ack.last_applied_sequence - beforeSequence };
}

/** Actual zero-provider SDK -> immutable step -> Docker -> native smoke.
 * The exported fixture has no import-time launch or provider initialization. */
export async function runNativeResidentFixture(project: string, caps: EvaluationCaps): Promise<NativeFixture> {
  // This must precede every config-bound Runtime/Sandbox import below.
  const fixture = await NativeFixture.create("native-resident", { projectRoot: project, caps });
  const started = performance.now();
  const cleanupReserveMs = 4 * caps.cleanupMs;
  const workAllowanceMs = caps.totalMs - cleanupReserveMs;
  const abort = new AbortController();
  let failure: unknown, recorder: EpisodeRecorder | undefined, store: Store | undefined;
  let sandbox: SandboxService | undefined, activeRuntime: Runtime | undefined;
  let activeWorkers: WorkerTrace[] | null = null;
  let activeNativeGrants: NativeGrantTrace[] | null = null;
  const stop = (reason: string) => {
    failure ??= new Error(reason); abort.abort(failure);
    // close() fences real Runtime ownership synchronously before its drain.
    if (activeRuntime) void activeRuntime.close().catch(error => { failure ??= error; });
  };
  const interrupt = () => stop("Resident smoke interrupted");
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const deadline = setTimeout(() => stop("Resident smoke work deadline; remaining allowance is reserved for actual cleanup"), Math.max(1, workAllowanceMs));
  fixture.report.classification = "Evaluator-authored zero-provider native platform smoke; not acquired/model gameplay, principal survival, E01 cohort completion, or competence";
  fixture.report.actual_provider_calls = 0; fixture.report.actual_jev_calls = 0;
  fixture.report.source_authorship = "All source and synthetic SDK calls are evaluator-authored; Runtime's generic model-labelled event vocabulary does not establish model authorship";
  fixture.report.scope = { synthetic_reasoning_ms: 15_000, frequency_hz: 20, e01_cells_exercised: false,
    older_P02_P03_P05_rerun_claim: false, source_publication: "slot-private fresh working programs only; no operator library, promotion or experience acquisition" };
  fixture.report.application_age_provenance = "Execution resident.timings.input_age_ms is the production controller's actual ACK-to-retained-submitted-capture native-clock join; worker traces retain independent captured frames and last actual ACKs, not send-time latency";
  fixture.report.allowances = { total_ms: caps.totalMs, work_ms: workAllowanceMs, cleanup_reserved_ms: cleanupReserveMs,
    cleanup_barrier_ms: caps.cleanupMs, late_cleanup_is_failure_not_timely_retirement: true };
  fixture.report.artifact_names = { report: "evidence/report.json", sources: "evidence/resident-sources.json",
    worker_trace: "evidence/<case>-workers.json", sdk: "evidence/<case>-sdk.json", events: "evidence/<case>-events.json",
    recording: "evidence/resident/recording-manifest.json", frames: "evidence/resident/frames.jsonl", replay: "evidence/resident/replay.ffconcat" };
  const remaining = () => {
    requireProof(!abort.signal.aborted, String(abort.signal.reason ?? "Resident smoke stopped"));
    const ms = workAllowanceMs - (performance.now() - started);
    requireProof(ms > 0, "Resident smoke exhausted its finite total allowance");
    return ms;
  };
  const wait = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, ms: number, message: string) =>
    await until(async () => { remaining(); return await read(); }, accepts, Math.min(ms, remaining()), message);
  const limits = (stepMs = 100, analysisJobs = 0): ResidentLimits => ({ duration_ms: Math.floor(Math.min(caps.runMs, 60_000, remaining())), frequency_hz: 20,
    step_ms: stepMs, max_steps: 1200, max_frames: 1200, max_edges: 32, max_edges_per_second: 32,
    max_events: 8, max_analysis_jobs: analysisJobs, analysis_job_ms: 500, max_analysis_ms: analysisJobs * 500 });
  const root = (session: Session) => {
    const execution = session.current(); requireProof(execution?.entry === "step", "Actual selected resident root missing");
    return execution;
  };
  const captureEvents = (runId: string) => {
    requireProof(store, "Private Store unavailable");
    const events = []; let after = 0;
    for (let page = 0; page < caps.reportEventPages; page++) {
      const values = store.eventsAfter(runId, after, caps.eventPageRecords);
      events.push(...values); if (values.length < caps.eventPageRecords) return events;
      after = values.at(-1)!.event_seq;
    }
    requireProof(store.eventsAfter(runId, after, 1).length === 0, "Resident smoke event evidence exceeds declared finite page capacity");
    return events;
  };
  const submit = async (session: Session, name: string, source: string, initial_state: Json, args: Json, stepMs = 100, analysisJobs = 0) => {
    session.entry.generated_source = source;
    session.entry.selected_entry = "step"; session.entry.initial_state = initial_state; session.entry.original_intent = args;
    const selectedLimits = limits(stepMs, analysisJobs); session.entry.resident_limits = selectedLimits;
    requireProof(selectedLimits.duration_ms >= 1000, "Resident smoke requires at least one second root allowance");
    await session.caller.call("program_submit", { entry: "step", name, source, args, initial_state, limits: selectedLimits,
      card: { purpose: "Evaluator-authored P06 native platform smoke", applicability: "Only the evaluator-prepared technical arena",
        method: "Dispatch one declared selected resident entry through actual SDK, Runtime, Docker and native input",
        reason: "Exercise platform mechanics without provider calls", limitations: "Not model-authored gameplay, reusable experience, principal survival or competence evidence" } });
    await wait(async () => session.current(), execution => execution !== undefined, caps.startMs, "SDK publication did not create an immutable execution");
    requireProof(root(session).source_hash !== null, "Actual immutable source identity missing");
  };
  const drained = async (session: Session) => {
    const execution = await wait(async () => session.current(), value => !!value?.ended_at, caps.cleanupMs, "Actual resident root did not settle and drain");
    requireProof(execution?.entry === "step", "Resident terminal source entry changed");
    if (execution.resident) requireProof(execution.resident.cleanup.worker === "closed" && execution.resident.cleanup.native === "retired",
      `Actual resident cleanup remains unconfirmed: ${JSON.stringify(execution.resident.cleanup)}`);
    requireProof(!ActionArbiter.current(fixture.bridge)?.busy, "Actual arbiter retained an input owner after resident drain");
    const diagnostic = await fixture.diagnostics(); session.entry.native_after_drain = diagnostic;
    requireProof(diagnostic.controls_neutral && !diagnostic.motor_active, "Actual native input did not become neutral after worker drain");
    return execution;
  };
  const run = async (name: string, source: string, setup: string[], builtin: boolean, work: (session: Session) => Promise<void>,
    permittedInterventions: readonly EvaluatorFaultIntervention[] = []) => {
    await fixture.case(name, { evaluator_authored: true, zero_provider: true, selected_entry: "step",
      privileged_setup_only_before_admission: permittedInterventions.length === 0,
      permitted_evaluator_fault_interventions: permittedInterventions }, async entry => {
      requireProof(store && sandbox, "Real Store/Docker owner unavailable");
      remaining();
      await fixture.flat(); await fixture.console(["clear @a", "kill @e[type=minecraft:arrow]", ...setup]);
      entry.before = await fixture.observe();
      const caller = new ResidentSdkCaller(); entry.source_original_sha256 = createHash("sha256").update(source).digest("hex");
      const workers: WorkerTrace[] = []; activeWorkers = workers;
      const grants: NativeGrantTrace[] = []; activeNativeGrants = grants; entry.native_grants = grants;
      const prior = ActionArbiter.current(fixture.bridge);
      const { Runtime } = await import("../src/server/runtime.ts");
      const runtime = new Runtime(store, caller.auth, fixture.bridge, sandbox, () => {}, {
        adapter: () => fixture.bridge.adapter(), strategicAgentFactory: caller.auth,
      });
      activeRuntime = runtime;
      requireProof(!prior || ActionArbiter.current(fixture.bridge) === prior, "Runtime replaced the bridge's sole arbiter");
      let runId: string | undefined, caseFailure: unknown;
      try {
        await runtime.initialize();
        const adapter = fixture.bridge.adapter(); requireProof(adapter, "Actual native adapter unavailable");
        const goal = builtin ? adapter.goals.find(value => value.goal_id === "craft_crafting_table") :
          { adapter_id: adapter.descriptor.adapter.id, goal_id: "custom", parameters: {}, verifier: null };
        requireProof(goal && (!builtin || goal.verifier), "Actual registered craft_crafting_table builtin is required; no invented planks goal or possession substitute");
        entry.registered_goals = adapter.goals; entry.declared_goal = goal;
        const created = await runtime.createRun({ task: `Evaluator-only P06 resident ${name}; zero-provider platform smoke, not model competence`,
          goal, model_id: caller.modelId, working_programs: "fresh" });
        runId = created.run_id; entry.run_id = runId;
        const commandsBefore = fixture.commands.length;
        await runtime.control(runId, "start");
        await bounded(caller.waitReady(), Math.min(caps.startMs, remaining()), "Synthetic SDK request did not pass actual before-model gate");
        const session: Session = { caller, runtime, runId, entry, workers, grants,
          current: () => store!.allSkillExecutions(runId!).find(value => value.parent_execution_id === null),
          resident: () => {
            const selected = store!.allSkillExecutions(runId!).find(value => value.parent_execution_id === null);
            return selected?.entry === "step" ? selected.resident : null;
          } };
        await work(session);
        const interventions = fixture.commands.slice(commandsBefore);
        requireProof(JSON.stringify(interventions.map(value => value.action ? { action: value.action } : { commands: value.commands })) ===
          JSON.stringify(permittedInterventions),
          "Post-admission evaluator commands differ from the exact declared fault interventions");
        // Only after the playing root has drained may an independent read-only
        // console witness run; callers store its predicate for this exact point.
        entry.console_admission_count_unchanged = interventions.length === 0;
        entry.actual_declared_fault_interventions = interventions;
      } catch (error) { caseFailure = error; }
      finally {
        try {
          const deadline = performance.now() + caps.cleanupMs;
          await joinResidentCleanup(runtime.close(), deadline, "Actual Runtime cleanup exceeded its allowance");
          entry.runtime_cleanup = { settled: true, within_allowance: true };
        } catch (error) {
          entry.runtime_cleanup = { settled: true, failure: String(error) };
          caseFailure ??= error;
        }
        // The close promise has actually settled, including on a late failure.
        // Never clear these references merely because a race timer fired.
        activeRuntime = undefined; activeWorkers = null; activeNativeGrants = null;
        if (runId) {
          try {
            entry.run = store.getRun(runId); entry.executions = store.allSkillExecutions(runId);
            entry.immutable_sources = store.skills(runId);
            const events = captureEvents(runId);
            entry.event_artifact = `${name}-events.json`; await fixture.writeJson(`${name}-events.json`, events);
            requireProof(store.allSkillExecutions(runId).length === 1, "Smoke must admit exactly one immutable root per case without retry/replay");
            requireProof(store.selectedAction(runId, "latest") === null && !events.some(event => event.type === "action.accepted") &&
              store.allSkillExecutions(runId).every(value => value.calls === 0 && value.actions === 0),
            "Resident smoke acquired a dummy finite ActionView or consumed finite taskflow calls/actions");
            const admissions = events.filter(event => event.type === "controller.admitted");
            entry.native_admissions = admissions;
            if (admissions.length) requireProof(workers[0]?.compile_ready_at !== null && workers[0]?.compile_ready_at !== undefined &&
              workers[0].compile_ready_at <= admissions[0]!.at, "Actual worker source was not ready before native grant");
            entry.retirement_evidence = events.filter(event => event.type === "controller.retired" || event.type === "controller.contained");
          } catch (error) { caseFailure ??= error; }
        }
        try {
          await fixture.writeJson(`${name}-sdk.json`, caller.transcript);
          await fixture.writeJson(`${name}-workers.json`, workers);
          entry.sdk_artifact = `${name}-sdk.json`; entry.worker_artifact = `${name}-workers.json`;
        } catch (error) { caseFailure ??= error; }
      }
      if (caseFailure) throw caseFailure;
      const predicate = entry.independent_server_predicate;
      if (typeof predicate === "string") {
        const marker = `resident_${randomUUID().replaceAll("-", "")}`;
        const output = await fixture.console([`execute ${predicate} run say ${marker}`]); entry.independent_server_check = output;
        requireProof(String(output).includes(marker), "Independent server retention/projectile witness failed after actual root drain");
      }
    });
    requireProof(fixture.cases.at(-1)?.status === "passed", `Resident smoke ${name} failed; later cases are not run`);
  };
  try {
    requireProof(caps.runMs >= 25_000 && workAllowanceMs >= 30_000,
      "This smoke requires >=25s root and >=30s work after reserving four cleanup barriers");
    const sources = { bow: residentBowSource, gui_table: residentGuiSource, throw: residentThrowSource, stop_compute: residentStopSource,
      cold_failure: residentColdFailureSource, inactive_candidate: residentInactiveSource };
    await fixture.writeJson("resident-sources.json", sources);
    fixture.report.fixture_sources = await Promise.all(["scripts/native-resident.ts", "scripts/native-resident-agent.ts",
      "src/server/resident-controller.ts", "src/shared/resident.ts", "src/server/skills.ts", "src/server/runtime.ts",
      "src/server/sandbox.ts", "src/server/native-evaluation.ts", "src/server/minecraft-client.ts", "src/server/game-bridge.ts",
      "src/evaluation/native-game.ts", "sandbox/guardian.mjs", "sandbox/worker.mjs", "package.json", "bun.lock"].map(async file => ({
      path: file, sha256: createHash("sha256").update(await readFile(path.join(project, file))).digest("hex") })));
    await bounded(fixture.start(), remaining(), "Actual native startup exceeded the finite smoke work allowance");
    requireProof(fixture.ownedClient().session.evaluation === null, "Ordinary resident proof must use actual disabled evaluation mode");
    const initialBinding = fixture.bridge.snapshot().binding, initialSession = fixture.bridge.snapshot().session_id;
    const deniedEvaluation: Array<{ method: string; rejected: boolean; error: string | null }> = [];
    fixture.report.default_evaluation_denial = { actual_session_evaluation: null, requests: deniedEvaluation };
    for (const method of ["evaluation_status", "evaluation_arm_inventory_replacement"]) {
      const evidence: { method: string; rejected: boolean; error: string | null } = { method, rejected: false, error: null };
      try { await Reflect.get(fixture.bridge, "request").call(fixture.bridge, method, {}, Math.min(caps.diagnosticsMs, remaining())); }
      catch (error) { evidence.rejected = true; evidence.error = String(error); }
      deniedEvaluation.push(evidence);
      const state = fixture.bridge.snapshot();
      requireProof(evidence.rejected && state.status === "connected" && state.error === null &&
        state.session_id === initialSession && state.binding?.ready &&
        state.binding.native_boot_id === initialBinding?.native_boot_id,
      "Default-mode evaluator request was accepted or lost its original responsive native session");
    }
    const initialDiagnostics = await fixture.diagnostics();
    requireProof(initialDiagnostics.controls_neutral && !initialDiagnostics.motor_active,
      "Default-denied evaluator requests emitted native controls");
    requireProof(fixture.bridge.openController, "Actual native controller grant tracing is unavailable");
    const openController = fixture.bridge.openController.bind(fixture.bridge);
    fixture.bridge.openController = async (...args) => {
      const channel = await openController(...args);
      activeNativeGrants?.push({ owner: structuredClone(channel.owner), controller_generation: channel.controllerGeneration,
        granted_host_ms: performance.now() });
      return channel;
    };
    const { Store } = await import("../src/server/store.ts");
    const { SandboxService } = await import("../src/server/sandbox.ts");
    const { programEvidence } = await import("../src/server/program-evidence.ts");
    store = new Store(fixture.root);
    sandbox = new SandboxService(project, () => {});
    await bounded(sandbox.prepare(), Math.min(caps.startMs, remaining()), "Actual Docker worker preparation timed out");
    fixture.report.sandbox = sandbox.snapshot(); requireProof(sandbox.snapshot().status === "ready", "Actual Docker/guardian unavailable");
    // Passive tracing around the real service only: no alternate input channel,
    // fake worker result, execution engine, source validator or cleanup owner.
    const createWorker = sandbox.createResidentWorker.bind(sandbox);
    sandbox.createResidentWorker = async (bundle, stepMs, signal) => {
      const trace: WorkerTrace = { source_sha256: bundle.source_hash, compile_started_at: new Date().toISOString(),
        compile_ready_at: null, compile_failure: null, close_started_at: null, close_completed_at: null, steps: [] };
      activeWorkers?.push(trace);
      let worker;
      try { worker = await createWorker(bundle, stepMs, signal); trace.compile_ready_at = new Date().toISOString(); }
      catch (error) { trace.compile_failure = String(error); throw error; }
      return {
        step: async (frame, state, intent, stepSignal) => {
          requireProof(trace.steps.length < 1200, "Finite passive worker trace capacity exhausted");
          const sample: WorkerStepTrace = { started_host_ms: performance.now(), frame_seq: frame.frame_seq,
            captured_native_ns: frame.captured_native_ns, native_tick: frame.native_tick, active_use: frame.player.active_use,
            last_input: frame.last_input, effect_updates: frame.effect_updates, screen_identity: frame.screen?.identity ?? null,
            intent, returned_host_ms: null };
          trace.steps.push(sample);
          try {
            const result = await worker.step(frame, state, intent, stepSignal);
            requireProof("input" in result, "Legacy resident input probe cannot accept an executive task command");
            sample.returned_host_ms = performance.now(); sample.input = controllerInputSchema.parse(result.input); sample.status = result.status;
            return result;
          } catch (error) { sample.failure = String(error); sample.returned_host_ms = performance.now(); throw error; }
        },
        close: async () => { trace.close_started_at ??= new Date().toISOString(); await worker.close(); trace.close_completed_at = new Date().toISOString(); },
      };
    };
    const native = fixture.bridge.snapshot();
    fixture.report.materialized_binding = native.binding;
    fixture.report.adapter_descriptor = fixture.bridge.adapter()?.descriptor;
    requireProof(native.world_id && native.session_id, "Recording scope missing");
    const recorderMs = Math.min(180_000, Math.floor(remaining()));
    recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, "resident"), bridge: fixture.bridge,
      identity: { episode_id: randomUUID(), run_id: randomUUID(), world_id: native.world_id, session_id: native.session_id },
      limits: { maxDurationMs: recorderMs, maxFrames: Math.min(6000, Math.ceil(recorderMs / 20)), maxStoredFrameBytes: 2 * 1024 ** 3 }, onIncomplete: stop });
    fixture.report.recording_limits = { maxDurationMs: recorderMs, maxFrames: Math.min(6000, Math.ceil(recorderMs / 20)), maxStoredFrameBytes: 2 * 1024 ** 3 };
    await run("bow_reasoning_overlap", residentBowSource, ["item replace entity @a hotbar.0 with minecraft:bow", "give @a minecraft:arrow 2"], false, async session => {
      await submit(session, "P06 evaluator continuous bow", residentBowSource, { phase: "start" }, { release: false }, 100, 1);
      await wait(async () => session.resident(), value => !!value?.last_input?.held.use && value.counters.applied_sequence >= 1,
        caps.startMs, "Actual resident bow press never applied");
      const overlapStarted = performance.now(); session.entry.reasoning_started_host_ms = overlapStarted;
      // This explicitly synthetic reasoning await is independent of the resident
      // step pump and of normal source publication/actual inactive compilation.
      let reasoningFinished: number | null = null, overlapWorkFinished: number | null = null;
      const reasoning = pause(15_000).then(() => {
        reasoningFinished = performance.now(); session.entry.reasoning_finished_host_ms = reasoningFinished;
      });
      const compile = (async () => {
        await session.caller.call("program_write", { entry: "step", name: "P06 evaluator inactive candidate", source: residentInactiveSource,
          card: { purpose: "Evaluator-only inactive source compilation", applicability: "Bounded P06 overlap smoke only",
            method: "Publish normally, compile the checked immutable module, close without stepping or granting input",
            reason: "Measure actual source-authoring/compile overlap with ongoing ordinary resident input",
            limitations: "Never activated; no gameplay, source replacement, model authorship or acquired-skill claim" } });
        const candidate = store!.skills(session.runId).find(value => value.name === "P06 evaluator inactive candidate");
        requireProof(candidate?.entry === "step", "Normal source publisher did not retain the inactive selected-entry candidate");
        session.entry.inactive_candidate = candidate;
        const candidateWorker = await sandbox!.createResidentWorker(singletonExecutableModuleBundle(candidate.source, "step"), 100, abort.signal);
        try { session.entry.inactive_compile_completed_host_ms = performance.now(); }
        finally { await candidateWorker.close(); }
        await session.caller.call("program_inspect", { view: "history", after: 0, limit: 25 });
        await session.caller.call("program_inspect", { view: "source", name: candidate.name, version: candidate.version });
        const analysisSource = "export function analyze(input) { return {sum: input.values.reduce((total,value) => total + value, 0)}; }";
        await session.caller.call("program_write", { entry: "analyze", name: "P06 evaluator pure numeric job", source: analysisSource });
        const jobStarted = performance.now();
        const job = jsonSchema.parse(await session.caller.call("program_run", { operation: "analyze",
          name: "P06 evaluator pure numeric job", input: { values: [2, 4, 7] }, expected_intent_version: 0 }));
        requireProof(job && typeof job === "object" && !Array.isArray(job) && job.status === "completed" &&
          job.input_version === 0 && job.controller_execution_id === root(session).execution_id &&
          job.controller_source_hash === root(session).source_hash, "Actual pure job lost its original resident/source/intent provenance");
        const output = job.output;
        requireProof(output && typeof output === "object" && !Array.isArray(output) && output.sum === 13 &&
          typeof job.elapsed_ms === "number" && Number.isFinite(job.elapsed_ms) && job.elapsed_ms >= 0 && job.elapsed_ms <= 500,
        "Actual isolated pure job did not compute the declared result within its separate guarded allowance");
        const duringJob = session.workers[0]!.steps.filter(value => value.started_host_ms >= jobStarted &&
          value.returned_host_ms !== null && value.last_input?.held.use && value.active_use?.item === "bow");
        requireProof(duringJob.length >= 2 && duringJob.at(-1)!.native_tick > duringJob[0]!.native_tick,
          "Pure job startup/evaluation blocked actual resident feedback and applied held use");
        requireProof(store!.allSkillExecutions(session.runId).length === 1,
          "Pure analysis acquired a second playing execution");
        session.entry.pure_analysis = { source: analysisSource, result: job, actual_concurrent_native_ticks: duringJob.map(value => value.native_tick),
          interpretation: "Pure result retained separately; no automatic intent or input adoption" };
        overlapWorkFinished = performance.now(); session.entry.overlap_work_finished_host_ms = overlapWorkFinished;
      })();
      await bounded(Promise.all([reasoning, compile]), Math.min(caps.runMs, remaining()), "Declared reasoning/normal inactive compile overlap did not finish");
      requireProof(reasoningFinished !== null && overlapWorkFinished !== null && overlapWorkFinished <= reasoningFinished,
        "Actual inactive compile/history work did not finish inside the declared 15-second synthetic reasoning interval");
      const beforeRelease = root(session); requireProof(beforeRelease.resident?.status === "running", `Resident did not survive actual overlap: ${beforeRelease.resident?.reason}`);
      session.entry.before_release = beforeRelease;
      requireProof(performance.now() - overlapStarted >= 15_000, "Synthetic reasoning interval was shortened");
      const bowSteps = session.workers[0]!.steps;
      const held = bowSteps.filter(value => value.started_host_ms >= overlapStarted && value.last_input?.held.use);
      requireProof(held.length >= 2 && held.every(value => value.active_use?.item === "bow"),
        "Actual overlap trace does not preserve vanilla bow use");
      const first = held[0]!.active_use, last = held.at(-1)!.active_use;
      requireProof(first && last, "Actual bow own-body samples are missing");
      requireProof(last.elapsed_ticks > first.elapsed_ticks + 200, "Actual native elapsed bow use did not span the reasoning wait");
      requireProof(session.workers.length === 2 && session.workers[1]!.steps.length === 0,
        "Inactive candidate was activated or never compiled through the actual worker");
      await session.caller.call("program_run", { operation: "update_intent", expected_version: beforeRelease.resident.intent_version, intent: { release: true } });
      const final = await drained(session); requireProof(final.status === "succeeded", `Authored neutral/release failed: ${final.result?.summary ?? final.status}`);
      requireProof(final.resident?.last_input?.held.use === false && final.resident.counters.ordered_edge_prefix === 2,
        "Actual press/release prefix does not establish one press and one explicit release");
      session.entry.vanilla_release_consequence = "Explicit authored use release can fire a vanilla bow projectile; retirement does not reverse it";
      session.entry.independent_server_predicate = "if entity @e[type=minecraft:arrow]";
    });
    await run("gui_builtin_table", residentGuiSource, ["give @a minecraft:oak_planks 4"], true, async session => {
      const before = await fixture.observe(); session.entry.setup_observation = before;
      requireProof(before.data.player.inventory.reduce((n, value) => n + (value.name === "oak_planks" ? value.count : 0), 0) === 4 &&
        !before.data.player.inventory.some(value => value.name === "crafting_table"), "Actual GUI setup must supply four planks and no table");
      session.entry.recipe_choice = "Registered craft_crafting_table: four supplied oak_planks -> actual four-cell 2x2 result-slot take -> one retained table; no registered planks builtin invented";
      await submit(session, "P06 evaluator resident GUI table", residentGuiSource, { phase: "start", pending: null, receipts: [] }, null);
      await session.caller.finishTurn();
      await wait(async () => captureEvents(session.runId), events => events.some(event => event.type === "goal.verified"),
        caps.runMs, "Actual Runtime builtin verifier did not confirm resident GUI production plus fresh retention");
      await wait(async () => store!.getRun(session.runId), value => value?.status === "completed", caps.cleanupMs, "Verified builtin Runtime did not complete its actual review/drain");
      await drained(session);
      const events = captureEvents(session.runId), receipts = events.filter(event => event.type === "controller.receipted");
      session.entry.resident_receipts = receipts;
      session.entry.adapter_evidence = events.filter(event => event.type === "adapter.evidence");
      const evidence = programEvidence(store!, session.runId); session.entry.program_evidence = evidence;
      requireProof(receipts.length >= 7 && evidence.some(value => value.goal_associations.some(link => link.relationship === "direct_receipt" &&
        link.action_id === null && link.controller_input && link.controller_input.sequence > 0)),
      "Actual resident sequence/source goal association missing or forged through a finite action_id");
      const after = await fixture.observe(); session.entry.retention_observation = after;
      requireProof(after.data.player.inventory.reduce((n, value) => n + (value.name === "crafting_table" ? value.count : 0), 0) === 1 &&
        !after.data.player.inventory.some(value => value.name === "oak_planks"), "Independent authoritative fresh retention/input consumption missing");
      session.entry.independent_server_predicate = 'if data entity @a[limit=1] Inventory[{id:"minecraft:crafting_table",count:1}] unless items entity @a[limit=1] inventory.* minecraft:oak_planks unless items entity @a[limit=1] hotbar.* minecraft:oak_planks';
    });
    await run("cold_source_failure", residentColdFailureSource, [], false, async session => {
      await submit(session, "P06 evaluator cold module fault", residentColdFailureSource, null, null);
      const final = await drained(session);
      requireProof(final.status === "failed" && session.workers.length === 1 && session.workers[0]!.compile_failure !== null &&
        session.workers[0]!.steps.length === 0 && !captureEvents(session.runId).some(event => event.type === "controller.admitted"),
      "Cold source failure acquired native input, executed a step, or was silently retried as another entry");
      session.entry.fault_classification = "Actual cold module failure before native grant; no native application claim";
    });
    await run("authored_worker_throw", residentThrowSource, ["item replace entity @a hotbar.0 with minecraft:bow", "give @a minecraft:arrow 2"], false, async session => {
      await submit(session, "P06 evaluator owned worker throw", residentThrowSource, { pressed: false }, null);
      const final = await drained(session);
      requireProof(final.status === "failed" && (final.resident?.counters.applied_sequence ?? 0) >= 1 && session.workers[0]!.steps.some(value =>
        value.failure && value.last_input?.held.use),
      "Authored worker throw did not occur after actual native ownership/application");
      session.entry.fault_classification = "Real worker throw after applied bow ownership; Stop/retirement release may produce vanilla projectile";
    });
    await run("stop_during_worker_compute", residentStopSource, ["item replace entity @a hotbar.0 with minecraft:bow", "give @a minecraft:arrow 2"], false, async session => {
      await submit(session, "P06 evaluator Stop compute", residentStopSource, { pressed: false }, { compute: false }, 500);
      const owned = await wait(async () => session.resident(), value => !!value?.last_input?.held.use, caps.startMs, "Stop fixture never owned actual applied native use");
      requireProof(owned, "Stop fixture resident disappeared");
      await session.caller.call("program_run", { operation: "update_intent", expected_version: owned.intent_version, intent: { compute: true } });
      const inFlight = await wait(async () => session.workers[0]!.steps.find(value => value.intent !== null && typeof value.intent === "object" &&
        !Array.isArray(value.intent) && value.intent.compute === true && value.returned_host_ms === null),
        value => value !== undefined, caps.diagnosticsMs, "Authored infinite-loop invocation was never actually dispatched to the real worker");
      await pause(25);
      requireProof(inFlight?.returned_host_ms === null, "Compute ended before Stop; no overlap proof");
      session.entry.stop_requested_host_ms = performance.now(); session.entry.compute_dispatch_at_stop = { ...inFlight };
      // Real operator Stop, not a private controller/diagnostic substitute.
      await bounded(session.runtime.control(session.runId, "stop"), caps.cleanupMs, "Actual Runtime Stop failed to drain worker/native ownership");
      const final = await drained(session);
      requireProof(final.status === "cancelled" && final.resident?.cleanup.worker === "closed" && final.resident.cleanup.native === "retired",
        `Stop during compute did not cancel and drain the actual resident: ${final.status}`);
      const terminal = final.resident; const traceCount = session.workers[0]!.steps.length;
      await pause(300);
      requireProof(session.workers[0]!.steps.length === traceCount && session.resident()?.counters.applied_sequence === terminal.counters.applied_sequence,
        "Stale worker result/input appeared after actual Stop/drain");
      session.entry.after_stop = session.resident();
      session.entry.fault_classification = "Authored infinite-loop step dispatched and still outstanding at real Runtime Stop while prior native use owned; no claim of observing an instruction pointer";
    });
    for (const fault of [
      { name: "death", setup: [], commands: ["kill @a"], restore: [] },
      { name: "same_life_teleport", setup: [], commands: ["tp @a 2.5 240 2.5"], restore: [] },
      { name: "dimension_change",
        setup: ["execute in minecraft:the_nether run forceload add -16 -16 15 15",
          "execute in minecraft:the_nether run fill -2 239 -2 2 239 2 minecraft:stone"],
        commands: ["execute in minecraft:the_nether run tp @a 0.5 240 0.5"],
        restore: ["execute in minecraft:overworld run tp @a 0.5 240 0.5"] },
    ]) {
      await run(`resident_scope_fault_${fault.name}`, residentBowSource,
        ["item replace entity @a hotbar.0 with minecraft:bow", "give @a minecraft:arrow 2", ...fault.setup], false, async session => {
          await submit(session, `P06 evaluator ${fault.name} fence`, residentBowSource, { phase: "start" }, { release: false });
          const owned = await wait(async () => session.resident(), value => !!value?.last_input?.held.use,
            caps.startMs, "Scope-fault source did not first own actual applied use");
          requireProof(owned?.last_input, "Scope fault lacks actual prior native ownership");
          const before = await fixture.observe(), original = root(session);
          assertLiveResidentFaultOwner(original);
          requireProof(session.grants.length === 1, "Scope fault must retain exactly one actual original native grant");
          const grant = session.grants[0]!;
          session.entry.before_fault = { execution: original, observation: before, applied: owned.last_input };
          await fixture.console(fault.commands);
          const changed = await wait(async () => fixture.observe(), observation => fault.name === "death"
            ? observation.life.status === "dead"
            : observation.space.space_epoch !== before.space.space_epoch,
          caps.observationMs, "Declared native scope transition was not observed");
          if (fault.name === "same_life_teleport")
            requireProof(changed.life.life_id === before.life.life_id && changed.space.dimension_id === before.space.dimension_id,
              "Same-life teleport was replaced by another life or dimension");
          if (fault.name === "dimension_change")
            requireProof(changed.space.dimension_id === "minecraft:the_nether" && changed.life.life_id === before.life.life_id,
              "Dimension fault did not preserve the same actual life");
          const terminal = await drained(session);
          const events = captureEvents(session.runId);
          const admissions = events.filter(event => event.type === "controller.admitted");
          const retirements = events.filter(event => event.type === "controller.retired");
          requireProof(admissions.length === 1 && retirements.length === 1,
            "Scope fault requires one original admission and one actual native retirement");
          const admission = admissions[0]!.details;
          requireProof(admission && typeof admission === "object" && !Array.isArray(admission) &&
            admission.operation_id === grant.owner.operation_id && admission.controller_generation === grant.controller_generation &&
            sameEffectScope(effectScopeSchema.parse(admission.scope), grant.owner.scope),
          "Persisted admission differs from the actual original native grant");
          const retirement = retirements[0]!.details;
          requireProof(retirement && typeof retirement === "object" && !Array.isArray(retirement),
            "Actual native retirement evidence is missing");
          session.entry.scope_retirement_assertion = assertResidentFaultRetirement(original, terminal, grant,
            revocationAckSchema.parse(retirement.ack));
          const stepCount = session.workers[0]!.steps.length, applied = terminal.resident?.counters.applied_sequence;
          await pause(150);
          requireProof(session.workers[0]!.steps.length === stepCount && session.resident()?.counters.applied_sequence === applied,
            "Old-scope worker/input resumed after its actual retirement");
          session.entry.after_fault = { observation: changed, execution: terminal };
          // The fault must have retired the original root without this Stop.
          // End its recovery/strategy authority before evaluator-only recovery
          // takes over; otherwise Runtime correctly fences a foreign respawn.
          await session.runtime.control(session.runId, "stop");
          session.entry.evaluator_recovery_after_run_stop = true;
          if (fault.name === "death") {
            await wait(async () => fixture.observe(), observation => observation.life.status === "dead" && observation.life.can_respawn,
              caps.observationMs, "Actual death screen did not become explicitly respawn-ready");
            session.entry.explicit_evaluator_respawn = await fixture.action({ kind: "respawn" });
            const alive = await wait(async () => fixture.observe(),
              observation => observation.life.status === "alive" && observation.life.life_id > before.life.life_id,
              caps.observationMs, "Explicit respawn did not confirm a new life");
            requireProof(session.current()?.execution_id === original.execution_id &&
              session.workers[0]!.steps.length === stepCount, "Respawn restarted or replaced old authored work");
            session.entry.after_explicit_respawn = alive;
          }
          if (fault.restore.length) {
            await fixture.console(fault.restore);
            session.entry.evaluator_restored_space = await wait(async () => fixture.observe(),
              observation => observation.space.dimension_id === "minecraft:overworld" &&
                observation.space.space_epoch !== changed.space.space_epoch,
              caps.observationMs, "Evaluator did not restore its own arena after the drained dimension fault");
          }
          session.entry.fault_classification = "Declared privileged lifecycle perturbation after actual generated/native ownership; old scope retired, no automatic replay or acquired gameplay claim";
        }, [{ commands: fault.commands },
          ...(fault.name === "death" ? [{ action: { kind: "respawn" as const } }] : []),
          ...(fault.restore.length ? [{ commands: fault.restore }] : [])]);
    }
    await run("resident_stop_during_native_stall_and_ordinary_saturation", residentBowSource,
      ["item replace entity @a hotbar.0 with minecraft:bow", "give @a minecraft:arrow 2"], false, async session => {
        await submit(session, "P06 evaluator stalled native Stop", residentBowSource, { phase: "start" }, { release: false });
        const owned = await wait(async () => session.resident(), value => !!value?.last_input?.held.use,
          caps.startMs, "Stall source never acquired actual native use");
        requireProof(owned?.last_input?.ordered_edge_prefix === 1, "Stall source lacks its actual consumed single press");
        const pings: Promise<unknown>[] = [];
        let stopping: Promise<unknown> | undefined, settled = false;
        const started = performance.now();
        const timing: { requested_host_ms: number | null; cleanup_deadline_host_ms: number | null;
          settled_host_ms: number | null; settlement_elapsed_ms: number | null; outcome: "fulfilled" | "rejected" | null;
          evidence_completed_host_ms: number | null; post_settlement_evidence_ms: number | null } = {
          requested_host_ms: null, cleanup_deadline_host_ms: null, settled_host_ms: null, settlement_elapsed_ms: null,
          outcome: null, evidence_completed_host_ms: null, post_settlement_evidence_ms: null };
        session.entry.stop_timing = timing;
        session.entry.native_stall_started_host_ms = started;
        await fixture.suspendedClient(async () => {
          for (let index = 0; index < 16; index++)
            pings.push(Reflect.get(fixture.bridge, "request").call(fixture.bridge, "ping", {}, 2000)
              .then((reply: unknown) => ({ reply }), (error: unknown) => ({ error: String(error) })));
          timing.requested_host_ms = performance.now();
          timing.cleanup_deadline_host_ms = timing.requested_host_ms + caps.cleanupMs;
          const recordSettlement = (outcome: "fulfilled" | "rejected") => {
            settled = true; timing.outcome = outcome; timing.settled_host_ms = performance.now();
            timing.settlement_elapsed_ms = timing.settled_host_ms - timing.requested_host_ms!;
          };
          stopping = session.runtime.control(session.runId, "stop").then(value => {
            recordSettlement("fulfilled"); return value;
          }, error => { recordSettlement("rejected"); throw error; });
          void stopping.catch(() => {});
          await pause(600);
          requireProof(!settled, "Stopped native thread falsely confirmed actual Runtime Stop");
          session.entry.stall_host_ms_before_resume = performance.now() - started;
        });
        requireProof(stopping && timing.cleanup_deadline_host_ms !== null, "Real Runtime Stop was never dispatched during the native stall");
        await joinResidentCleanup(stopping, timing.cleanup_deadline_host_ms, "Stalled native Runtime Stop exceeded its original cleanup deadline");
        session.entry.ordinary_backlog_results = await Promise.all(pings);
        const terminal = await drained(session);
        requireProof(terminal.status === "cancelled" && terminal.resident?.counters.ordered_edge_prefix === 1 &&
          terminal.resident.cleanup.worker === "closed" && terminal.resident.cleanup.native === "retired",
          "Resumed native Stop lost the consumed press prefix, replayed input or failed actual dual cleanup");
        session.entry.after_stalled_stop = terminal;
        timing.evidence_completed_host_ms = performance.now();
        timing.post_settlement_evidence_ms = timing.evidence_completed_host_ms - timing.settled_host_ms!;
        session.entry.fault_classification = "Actual native process SIGSTOP plus sixteen ordinary RPCs and real Runtime Stop; reserved retirement waits real resume/drain, not a 250ms physical release guarantee";
      });
    fixture.report.performance = fixture.bridge.performanceMetrics();
  } catch (error) { failure ??= error; abort.abort(error); }
  finally {
    clearTimeout(deadline); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (activeRuntime) try {
      const deadline = performance.now() + caps.cleanupMs;
      await joinResidentCleanup(activeRuntime.close(), deadline, "Actual Runtime final cleanup exceeded its allowance");
    } catch (error) { failure ??= error; }
    if (sandbox) try {
      const deadline = performance.now() + caps.cleanupMs;
      await joinResidentCleanup(sandbox.close(), deadline, "Actual Docker/guardian final cleanup exceeded its allowance");
      fixture.report.sandbox_cleanup = { settled: true, within_allowance: true };
    } catch (error) {
      fixture.report.sandbox_cleanup = { settled: true, failure: String(error) };
      failure ??= error;
    }
    if (recorder) try {
      const recording = await recorder.finish({ endedAt: Date.now(), reason: failure ? "resident_smoke_failed" : "resident_smoke_completed" });
      fixture.report.recording = recording;
      requireProof(recording.status === "complete", "Resident original-speed recording incomplete; not a shortened successful replay");
      // Parent owns offline playback/render verification. All original delivered
      // frames/index/ffconcat remain even on smoke failure; no wait compression.
    } catch (error) { failure ??= error; }
    try {
      const deadline = performance.now() + caps.cleanupMs;
      await joinResidentCleanup(fixture.close(), deadline, "Actual native/server final cleanup exceeded its allowance");
    } catch (error) { failure ??= error; }
    store?.close();
    fixture.report.total_host_ms = performance.now() - started;
    if (performance.now() - started > caps.totalMs) failure ??= new Error("Actual cleanup exceeded the total allowance; late retirement is not a timely pass");
    await fixture.finish(failure);
  }
  return fixture;
}
