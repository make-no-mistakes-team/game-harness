import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuthManager } from "../src/server/auth.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { Store } from "../src/server/store.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { Observation } from "../src/shared/contracts.ts";
import type { EvaluationCaps, EvaluationConfig, EvaluationPurpose } from "../src/evaluation/contracts.ts";
import { createEvaluationConfig, DEFAULT_EVALUATION_CAPS } from "../src/evaluation/config.ts";
import { AttemptLedger, type AttemptRecord } from "../src/evaluation/policy.ts";
import { evaluationPaths, type EvaluationPaths } from "../src/evaluation/paths.ts";
import { classifyEvaluation, costToResult, waitCoverage, type EvaluationCaseReport, type EvaluationOutcome, type UsageMetrics } from "../src/evaluation/results.ts";
import { NATURAL_SCENARIOS, NATURAL_WORLD_CONDITIONS, captureGoalBaseline, verifyScenarioGoal, type GoalVerification, type NaturalScenario, type ScenarioId } from "../src/evaluation/scenarios.ts";
import { NativeFixture, bounded, pause, requireProof } from "../src/evaluation/native-game.ts";
import { ModelProgramEvidence, type EvidenceSummary } from "../src/evaluation/model-evidence.ts";

export interface AgentAcceptanceOptions {
  allowNative: boolean;
  allowInference: boolean;
  /** Existing GameHarness DATA directory containing auth/gameharness.sqlite. Opened in place. */
  authDirectory: string;
  hypothesisId: string;
  platformEvidenceRevision: string;
  scenario?: ScenarioId | "all";
  modelId?: string;
  purpose?: EvaluationPurpose;
  justification?: string;
  projectRoot?: string;
  paths?: Partial<EvaluationPaths>;
  caps?: Partial<EvaluationCaps>;
}
const terminal = (runtime: Runtime | undefined) => !runtime?.snapshot() || ["completed", "stopped", "failed"].includes(runtime.snapshot()!.status);
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

function historicalUsage(attempt: AttemptRecord): UsageMetrics | null {
  const value = attempt.settlement?.usage;
  if (!value || typeof value !== "object" || !("admissions" in value) || !("coverage" in value) || !("reported_subtotal" in value)) return null;
  return value as UsageMetrics;
}
function priorCosts(attempts: readonly AttemptRecord[]) {
  return costToResult(attempts.map(attempt => ({
    outcome: attempt.settlement?.outcome ?? classifyEvaluation({ inferenceAdmitted: true, goalVerified: null,
      platformChecksComplete: false, providerError: false, providerSettled: false, reasons: ["prior_attempt_unsettled"] }),
    usage: historicalUsage(attempt),
  })));
}

/** Explicitly opt-in, finite actual-provider sample. Negative goals never trigger repetition. */
export async function runAgentAcceptance(options: AgentAcceptanceOptions) {
  requireProof(options.allowNative && options.allowInference, "Agent acceptance requires --allow-native AND --allow-inference");
  requireProof(options.purpose !== "api_control", "Natural scenarios are acceptance/comparison work, not an API-control diagnostic");
  requireProof(options.authDirectory, "Pass --auth-dir with the existing GameHarness data directory; credentials are never copied");
  const project = path.resolve(options.projectRoot ?? process.cwd());
  const authDirectory = path.resolve(options.authDirectory);
  const authFile = await lstat(path.join(authDirectory, "auth/gameharness.sqlite"));
  requireProof(authFile.isFile() && !authFile.isSymbolicLink(), "Existing GameHarness auth storage must be a regular file; this command never creates a replacement identity");
  const selected = NATURAL_SCENARIOS.filter(scenario => !options.scenario || options.scenario === "all" || scenario.id === options.scenario);
  requireProof(selected.length > 0, "Choose collect_wood, craft_crafting_table, obtain_stone or all");
  const paths = evaluationPaths(project, options.paths);
  const caps = Object.freeze({ ...DEFAULT_EVALUATION_CAPS, ...options.caps });
  process.env.GAMEHARNESS_NATIVE_PROOF = "1";
  const fixture = await NativeFixture.create("agent-acceptance", { projectRoot: project, paths, caps, authDirectory, conditions: NATURAL_WORLD_CONDITIONS });
  const ledger = new AttemptLedger(paths.governanceRoot, { projectRoot: project });
  const batchId = randomUUID();
  const clockId = `acceptance-${batchId}`;
  const started = performance.now();
  let auth: AuthManager | undefined, store: Store | undefined, runtime: Runtime | undefined, sandbox: SandboxService | undefined;
  let evidence: ModelProgramEvidence | undefined;
  let config: EvaluationConfig | undefined;
  let closing = false, abortReason: string | null = null, activeRun: string | null = null;
  let stopping: Promise<unknown> | null = null;
  const report: Record<string, unknown> = {
    schema_version: 1, batch_id: batchId, tier: "agent-acceptance", classification: "natural_normal_survival_finite_actual_provider_sample",
    conditions: NATURAL_WORLD_CONDITIONS, declared_scenarios: selected, results: [],
    credential_policy: "Existing GameHarness auth storage opened in place. No login/logout, copies, identity dumps, ambient account imports or fallback model.",
    comparison_scope: "Fixed seed/settings and fresh world per case. Vanilla timing and provider behavior are not controlled; no causal or cross-model improvement claim.",
    source_policy: "Only the actual provider authors gameplay and optional game guards. No supplied programs, targets, inventory, console commands or required tool sequence.",
    private_evidence_root: fixture.root, caps,
    native_evidence: "native-report.json",
  };
  const caseReports: Array<Record<string, unknown>> = [];
  report.results = caseReports;
  function assertOpen() { requireProof(!closing && abortReason === null, "The finite acceptance scope is closed"); }
  function stop(runId: string, why: string) {
    const current = runtime?.snapshot();
    if (!current || current.run_id !== runId || terminal(runtime) || stopping) return;
    report.last_stop_reason = why;
    // Production Stop fences provider/tool authority synchronously before awaiting drain.
    const drain = Promise.withResolvers<unknown>();
    stopping = drain.promise;
    void stopping.catch(() => {});
    try { void runtime!.control(runId, "stop").then(drain.resolve, drain.reject); }
    catch (error) { drain.reject(error); }
  }
  function interrupt(why: string) {
    abortReason ??= why;
    if (activeRun) stop(activeRun, why);
  }
  const expiry = Promise.withResolvers<never>();
  void expiry.promise.catch(() => {});
  const timer = setTimeout(() => { interrupt("entire_sample_deadline"); expiry.reject(new Error("Finite acceptance sample deadline reached")); }, caps.totalMs);
  const sigint = () => { interrupt("operator_sigint"); expiry.reject(new Error("Acceptance interrupted by operator")); };
  const sigterm = () => { interrupt("operator_sigterm"); expiry.reject(new Error("Acceptance interrupted by operator")); };
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  let failure: unknown;
  let activeReservation: string | null = null;
  const cleanup: Array<{ resource: string; closed: boolean }> = [];
  async function close(resource: string, operation: () => unknown | Promise<unknown>) {
    try { await bounded(Promise.resolve().then(operation), caps.cleanupMs, `${resource} cleanup deadline`); cleanup.push({ resource, closed: true }); }
    catch { cleanup.push({ resource, closed: false }); }
  }
  async function authenticate() {
    // Config-consuming production modules load only AFTER fixture isolation is established.
    const { AuthManager } = await import("../src/server/auth.ts");
    let changed = () => {};
    await bounded(AuthManager.create(authDirectory, () => changed()).then(async manager => {
      auth = manager;
      if (closing || abortReason) { await manager.close(); throw new Error("Authorization opened after scope closure"); }
    }), caps.authMs, "Opening existing auth storage timed out");
    const ready = Promise.withResolvers<void>();
    changed = () => {
      const state = auth!.snapshot();
      if (state.status === "ready" && state.authenticated) ready.resolve();
      else if (["signed_out", "unavailable", "error"].includes(state.status)) ready.reject(new Error("Existing authorization is unavailable; no login or substitute account/model is permitted"));
    };
    changed();
    await bounded(ready.promise, caps.discoveryMs, "Actual model discovery timed out");
    changed = () => {};
    assertOpen();
    const state = auth!.snapshot();
    config = createEvaluationConfig({ discoveredModels: state.models, modelId: options.modelId, purpose: options.purpose ?? "ordinary_acceptance",
      justification: options.justification, hypothesisId: options.hypothesisId, platformEvidenceRevision: options.platformEvidenceRevision, caps });
    report.config = config;
    report.auth = { provider: state.provider, authenticated: state.authenticated, selected_model: config.model };
  }
  async function runCase(scenario: NaturalScenario, index: number) {
    assertOpen();
    if (runtime) { await bounded(runtime.close(), caps.cleanupMs, "Previous run drain timed out"); runtime = undefined; }
    if (index === 0) await fixture.start();
    else await fixture.nextWorld();
    assertOpen();
    const { Runtime } = await import("../src/server/runtime.ts");
    runtime = new Runtime(store!, auth!, fixture.bridge, sandbox!, () => {}, { adapter_id: "fabric-owned-client" });
    await bounded(runtime.initialize(), caps.startMs, "Production runtime initialization timed out");
    assertOpen();
    evidence!.bindRuntime(runtime);
    const run = await bounded(runtime.createRun({ task: scenario.prompt, goal: scenario.runtimeGoal, model_id: config!.model.id, working_programs: "fresh" }), caps.startMs, "Run creation timed out");
    activeRun = run.run_id;
    const initial = await bounded(fixture.bridge.observe(), caps.observationMs, "Run-start observation timed out");
    const baseline = captureGoalBaseline(run.run_id, initial);
    const hostBaseline = structuredClone(store!.getRun(run.run_id)!.baseline);
    await fixture.writeJson(`case-${scenario.id}-declaration.json`, { scenario, baseline, host_run_baseline: hostBaseline,
      conditions: fixture.report.world_conditions, declared_before_inference: true });
    assertOpen();
    // Reservation is durable before Runtime.start can admit the first provider request.
    const reservation = ledger.admitAttempt(config!, { reportDirectory: fixture.evidenceDirectory, promptRevision: scenario.verifier.revision, scenarioId: scenario.id });
    activeReservation = reservation.attemptId;
    const caseStart = performance.now();
    let verification: GoalVerification = verifyScenarioGoal(scenario, baseline, run.run_id, null, []);
    let latest: Observation | null = null;
    let caseFailure: unknown;
    let deadlineReached = false;
    const runTimer = setTimeout(() => { deadlineReached = true; stop(run.run_id, "finite_run_deadline"); }, caps.runMs);
    try {
      assertOpen();
      await bounded(runtime.control(run.run_id, "start"), caps.startMs, "Production run start timed out");
      while (!terminal(runtime)) {
        assertOpen();
        if (runtime.snapshot()?.status === "paused") { stop(run.run_id, "runtime_paused_no_automatic_resume"); break; }
        latest = await evidence!.measure(run.run_id, "observation", () => bounded(fixture.bridge.observe(), caps.observationMs, "Authorized observation timed out"));
        verification = verifyScenarioGoal(scenario, baseline, run.run_id, latest, evidence!.actions(run.run_id));
        if (verification.verified) { stop(run.run_id, "declared_semantic_goal_verified"); break; }
        if (stopping || deadlineReached || evidence!.hasProviderFailure(run.run_id)) { stop(run.run_id, "provider_failure_no_repeat"); break; }
        await pause(caps.pollMs);
      }
    } catch (error) { caseFailure = error; }
    finally {
      clearTimeout(runTimer);
      if (!terminal(runtime)) stop(run.run_id, "case_scope_closed");
      if (stopping) { await bounded(stopping, caps.cleanupMs, "Production Stop did not confirm drain"); stopping = null; }
    }
    assertOpen();
    const harnessFaults: string[] = [];
    let neutral = false;
    try {
      latest = await evidence!.measure(run.run_id, "observation", () => bounded(fixture.bridge.observe(), caps.observationMs, "Final authorized observation timed out"));
      const finalVerification = verifyScenarioGoal(scenario, baseline, run.run_id, latest, evidence!.actions(run.run_id));
      if (!verification.verified) verification = finalVerification;
      const diagnostics = await bounded(fixture.diagnostics(), caps.diagnosticsMs, "Native neutralization diagnostics timed out");
      neutral = diagnostics.controls_neutral && !diagnostics.motor_active;
      if (!neutral) harnessFaults.push("native_neutralization_failed");
    } catch (error) { caseFailure ??= error; }
    const baselinePreserved = JSON.stringify(hostBaseline) === JSON.stringify(store!.getRun(run.run_id)?.baseline);
    if (!baselinePreserved) harnessFaults.push("run_inventory_baseline_changed");
    if (fixture.commands.length) harnessFaults.push("ordinary_world_privileged_commands_used");
    const summary = evidence!.summary(run.run_id);
    harnessFaults.push(...summary.confirmed_harness_faults);
    const actualRun = runtime.getRun(run.run_id);
    const unclassifiedRuntimeFailure = actualRun?.status === "failed" && !summary.provider_error && harnessFaults.length === 0;
    const connected = fixture.bridge.snapshot().status === "connected" && fixture.bridge.snapshot().error === null;
    if (!connected) harnessFaults.push("native_session_unavailable");
    const usage = summary.usage;
    const outcome = classifyEvaluation({ inferenceAdmitted: usage.admissions > 0,
      goalVerified: verification.verified ? true : verification.evidence_status === "insufficient" ? null : false,
      platformChecksComplete: neutral && connected && baselinePreserved && summary.observer_error === null && !caseFailure && !summary.unclassified_tool_failures && !unclassifiedRuntimeFailure,
      confirmedHarnessFaults: harnessFaults, providerError: summary.provider_error, providerSettled: summary.provider_settled,
      reasons: [...(deadlineReached ? ["finite_run_deadline_reached"] : []), ...(caseFailure ? ["case_ended_with_unclassified_error"] : []),
        ...(summary.unclassified_tool_failures ? ["tool_failure_requires_classification"] : []),
        ...(unclassifiedRuntimeFailure ? ["runtime_failure_requires_classification"] : [])],
    });
    const caseEnd = performance.now();
    const entry = { scenario_id: scenario.id, declared_verifier: scenario.verifier, prompt: scenario.prompt, attempt_id: reservation.attemptId,
      run_id: run.run_id, conditions: NATURAL_WORLD_CONDITIONS, outcome, verification, baseline,
      host_baseline_preserved: baselinePreserved, runtime_status: actualRun?.status, usage, actions: summary.actions,
      wait_coverage: waitCoverage({ start_ms: caseStart, end_ms: caseEnd, clock_id: clockId }, evidence!.intervals(run.run_id, caseEnd)),
      omissions: summary.omissions, failure: caseFailure ? reason(caseFailure) : null,
      evidence: await evidence!.save(run.run_id),
    };
    const artifact = fixture.report.native_artifact;
    const nativeHash = artifact && typeof artifact === "object" && "sha256" in artifact && typeof artifact.sha256 === "string" ? artifact.sha256 : null;
    const compact = compactReport(scenario, config!, outcome, summary, entry.evidence, nativeHash);
    const compactName = `${batchId}-${scenario.id}.json`;
    await writeFile(path.join(paths.reportsRoot, compactName), JSON.stringify(compact, null, 2), { mode: 0o600, flag: "wx" });
    ledger.settleAttempt(reservation.attemptId, { outcome, usage, evidence: [entry.evidence, compactName] });
    activeReservation = null;
    activeRun = null;
    caseReports.push(entry);
    await fixture.writeJson(`case-${scenario.id}.json`, entry);
    await fixture.writeReport(report);
    // No green-seeking loop. One independent predeclared case per scenario only.
  }
  async function work() {
    await authenticate();
    assertOpen();
    await fixture.writeReport(report);
    const { Store } = await import("../src/server/store.ts");
    const { SandboxService } = await import("../src/server/sandbox.ts");
    store = new Store(fixture.root);
    sandbox = new SandboxService(project, () => {});
    await bounded(sandbox.prepare(), caps.startMs, "Production Docker sandbox preparation timed out");
    requireProof(sandbox.snapshot().status === "ready", "Actual production sandbox isolation is unavailable");
    assertOpen();
    evidence = new ModelProgramEvidence(store, fixture.evidenceDirectory, caps, clockId, stop);
    evidence.observeAuthAgents(auth!);
    await mkdir(paths.reportsRoot, { recursive: true, mode: 0o700 });
    for (let index = 0; index < selected.length; index++) {
      try { await runCase(selected[index]!, index); }
      catch (error) {
        if (activeReservation) throw error;
        // Policy refusal is terminal for this finite sample, never a new hypothesis or directory retry.
        caseReports.push({ scenario_id: selected[index]!.id, outcome: classifyEvaluation({ inferenceAdmitted: false, goalVerified: null,
          platformChecksComplete: false, providerError: false, providerSettled: false, reasons: ["case_not_admitted"] }), failure: reason(error) });
        throw error;
      }
    }
  }
  try {
    await fixture.writeReport(report);
    await Promise.race([work(), expiry.promise]);
  }
  catch (error) { failure = error; }
  finally {
    closing = true;
    clearTimeout(timer);
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
    if (activeRun) stop(activeRun, "sample_cleanup");
    await close("runtime", () => runtime?.close());
    evidence?.close();
    await close("auth_without_logout", () => auth?.close());
    await close("sandbox", () => sandbox?.close());
    await close("native_game", async () => { const result = await fixture.close(); requireProof(result.closed, "Owned native cleanup was not confirmed"); });
    await close("store", () => store?.close());
    if (activeReservation) ledger.interruptAttempt(activeReservation, abortReason ?? "sample_interrupted_before_settlement");
    report.resource_cleanup = cleanup;
    report.cleanup_confirmed = cleanup.every(entry => entry.closed);
    report.failure = failure ? reason(failure) : null;
    report.elapsed_ms = performance.now() - started;
    if (config) {
      const history = ledger.listAttempts(config.hypothesisId);
      report.cost_to_result = Object.fromEntries(selected.map(scenario => [scenario.id,
        priorCosts(history.filter(attempt => attempt.metadata.scenarioId === scenario.id))]));
      report.cost_to_result_scope = "All durable attempts for this hypothesis, grouped by declared scenario, including unsuccessful attempts and unknown interrupted usage; model changes do not erase prior costs";
    }
    await fixture.writeReport(report);
    ledger.close();
  }
  return { report_directory: fixture.evidenceDirectory, outcomes: caseReports.map(entry => entry.outcome),
    platform_complete: caseReports.length === selected.length && caseReports.every(entry => (entry.outcome as EvaluationOutcome).platform_status === "pass") && cleanup.every(entry => entry.closed),
    failure: failure ? reason(failure) : null };
}

function compactReport(scenario: NaturalScenario, config: EvaluationConfig, outcome: EvaluationOutcome,
  summary: EvidenceSummary, evidence: string, nativeHash: string | null): EvaluationCaseReport {
  const tools = new Map<string, number>();
  for (const tool of summary.tools) tools.set(tool.name, (tools.get(tool.name) ?? 0) + 1);
  return { schema_version: 1, scenario_id: scenario.id, hypothesis_id: config.hypothesisId,
    platform_evidence_revision: config.platformEvidenceRevision, model_id: config.model.id, purpose: config.purpose,
    verifier_revision: scenario.verifier.revision, outcome, usage: summary.usage,
    actions: summary.actions, tools: [...tools].map(([name, count]) => ({ name, count })),
    provenance: { tier: "agent-acceptance", source_author: "actual_provider", native_artifact_sha256: nativeHash,
      declaration_artifact: `case-${scenario.id}-declaration.json`, full_evidence_artifact: evidence },
    omissions: ["private_full_evidence", "tool_arguments", "raw_logs_and_frames", "runtime_assets_and_worlds", "unreported_usage", "unattributed_waiting"],
  };
}

export function parseAgentAcceptanceArguments(args: readonly string[]): AgentAcceptanceOptions {
  const options: AgentAcceptanceOptions = { allowNative: false, allowInference: false, authDirectory: "", hypothesisId: "", platformEvidenceRevision: "" };
  const value = (index: number) => { const result = args[index + 1]; if (!result || result.startsWith("--")) throw new Error(`Missing value for ${args[index]}`); return result; };
  const caps: { hostRequestAdmissions?: number; runMs?: number; totalMs?: number } = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--allow-native") options.allowNative = true;
    else if (flag === "--allow-inference") options.allowInference = true;
    else if (flag === "--auth-dir") options.authDirectory = value(index++);
    else if (flag === "--hypothesis") options.hypothesisId = value(index++);
    else if (flag === "--evidence-revision") options.platformEvidenceRevision = value(index++);
    else if (flag === "--model") options.modelId = value(index++);
    else if (flag === "--justification") options.justification = value(index++);
    else if (flag === "--scenario") {
      const selected = value(index++);
      requireProof(["all", ...NATURAL_SCENARIOS.map(scenario => scenario.id)].includes(selected), "Unknown natural scenario");
      options.scenario = selected as ScenarioId | "all";
    } else if (flag === "--purpose") {
      const purpose = value(index++);
      requireProof(["ordinary_acceptance", "comparison", "justified_acceptance"].includes(purpose), "Natural scenarios require ordinary_acceptance, comparison or justified_acceptance");
      options.purpose = purpose as EvaluationPurpose;
    } else if (flag === "--max-requests" || flag === "--run-ms" || flag === "--total-ms") {
      const count = Number(value(index++));
      requireProof(Number.isSafeInteger(count) && count > 0, "Acceptance bounds must be finite positive integers");
      if (flag === "--max-requests") caps.hostRequestAdmissions = count;
      else if (flag === "--run-ms") caps.runMs = count;
      else caps.totalMs = count;
    } else throw new Error(`Unknown agent-acceptance argument ${flag}`);
  }
  requireProof(options.hypothesisId && options.platformEvidenceRevision, "Pass stable --hypothesis and --evidence-revision values");
  options.caps = caps;
  return options;
}

if (import.meta.main) {
  try {
    const result = await runAgentAcceptance(parseAgentAcceptanceArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.platform_complete) process.exitCode = 1;
  } catch {
    // Auth/provider failures can contain private upstream details; full evidence remains private.
    console.error("Agent acceptance did not complete; inspect the private evaluation report. No fallback model or automatic retry was started.");
    process.exitCode = 1;
  }
}
