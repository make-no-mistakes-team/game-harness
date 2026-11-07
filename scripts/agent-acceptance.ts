import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import type { AuthManager } from "../src/server/auth.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { Store } from "../src/server/store.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { Json, ObservationV3, VerificationResult } from "../src/shared/contracts.ts";
import type { EvaluationCaps, EvaluationConfig, EvaluationPurpose } from "../src/evaluation/contracts.ts";
import { createEvaluationCaps, createEvaluationConfig, DEFAULT_EVALUATION_CAPS, loadEvidenceProfile } from "../src/evaluation/config.ts";
import { AttemptLedger, type AttemptRecord } from "../src/evaluation/policy.ts";
import { evaluationPaths, type EvaluationPaths } from "../src/evaluation/paths.ts";
import { classifyEvaluation, costToResult, readUsageMetrics, usageMetrics, waitCoverage, type EvaluationCaseReport, type EvaluationOutcome } from "../src/evaluation/results.ts";
import { NATURAL_WORLD_CONDITIONS, type ScenarioId } from "../src/evaluation/scenarios.ts";
import { NATURAL_SCENARIOS, selectNaturalScenarios, scenarioGoal, captureScenarioVerification, verifyScenarioCompletion, type NaturalScenario, type MinecraftAcceptanceTask } from "../src/evaluation/adapter-scenarios.ts";
import { developmentTask, minecraftDevelopmentSchema, type MinecraftDevelopmentDeclaration } from "../src/evaluation/minecraft-development.ts";
import { NativeFixture, bounded, pause, requireProof } from "../src/evaluation/native-game.ts";
import { ModelProgramEvidence, type EvidenceSummary } from "../src/evaluation/model-evidence.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { StudyLedger, readRegisteredStudy, readStudyObservationProfile, summarizeStudyUsage, type AttemptReservation, type StudyAcceptanceSelection, type StudyManifest, type StudyRequestReservation, type StudySlot } from "../src/evaluation/studies.ts";
import { assertNativeArtifactFresh } from "../src/evaluation/tiers.ts";
import { contractHash } from "../src/server/adapter-contract.ts";
import { minecraftProfileConfigurationSchema } from "../src/shared/minecraft.ts";
import type { StrategicRequestAdmission } from "../src/server/strategic.ts";
import { ArtifactRetention, type ArtifactRetentionOptions, type ArtifactRun } from "../src/evaluation/artifact-retention.ts";
import { checkArtifactCapacity } from "../src/evaluation/artifact-retention-monitor.ts";

interface AcceptanceCommonOptions {
  allowNative: boolean;
  allowInference: boolean;
  /** Existing GameHarness DATA directory containing auth/gameharness.sqlite. Opened in place. */
  authDirectory: string;
  scenario?: ScenarioId | "all";
  modelId?: string;
  purpose?: EvaluationPurpose;
  justification?: string;
  projectRoot?: string;
  paths?: Partial<EvaluationPaths>;
  caps?: Partial<EvaluationCaps>;
  admissionOnly?: boolean;
  /** Disclosed diagnostic condition: SSE and at most one inference dispatch per admission. */
  singleInferenceDispatch?: boolean;
  nativeJar?: string;
  evidenceProfile?: string;
  /** Explicit fresh-seeded Minecraft development; never a registered study. */
  development?: MinecraftDevelopmentDeclaration;
}
export type AgentAcceptanceOptions = AcceptanceCommonOptions & (
  { study?: undefined; hypothesisId: string; platformEvidenceRevision: string }
  | { study: StudyAcceptanceSelection; hypothesisId?: never; platformEvidenceRevision?: never }
);
type AcceptanceConfig = Omit<EvaluationConfig, "hypothesisId"> & { hypothesisId?: string };
const terminal = (runtime: Runtime | undefined) => !runtime?.snapshot() || ["completed", "stopped", "failed"].includes(runtime.snapshot()!.status);
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

function priorCosts(attempts: readonly AttemptRecord[]) {
  return costToResult(attempts.map(attempt => ({
    outcome: attempt.settlement?.outcome ?? classifyEvaluation({ inferenceAdmitted: true, goalVerified: null,
      platformChecksComplete: false, providerError: false, providerSettled: false, reasons: ["prior_attempt_unsettled"] }),
    usage: readUsageMetrics(attempt.settlement?.usage),
  })));
}

/** Explicitly opt-in, finite actual-provider sample. Negative goals never trigger repetition. */
export async function runAgentAcceptance(options: AgentAcceptanceOptions) {
  const started = performance.now();
  requireProof(!options.singleInferenceDispatch || !options.study,
    "Single-dispatch inference is a diagnostic condition, not an override of a frozen study");
  const development = options.development ? minecraftDevelopmentSchema.parse(options.development) : undefined;
  requireProof(!development || (!options.study && !options.scenario && !options.admissionOnly),
    "Minecraft development cannot inherit study/scenario admission or restored starts");
  const executingRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  if (options.study && options.projectRoot !== undefined && realpathSync(path.resolve(options.projectRoot)) !== executingRoot)
    throw new Error("Study source authority must be the executing acceptance module tree; foreign projectRoot overrides are unsupported");
  const project = options.study ? executingRoot : path.resolve(options.projectRoot ?? process.cwd());
  requireProof(!options.admissionOnly || !options.evidenceProfile, "Admission-only mode forbids evidence profile resource flags");
  const evidenceProfile = loadEvidenceProfile(project, options.evidenceProfile);
  const requireCaptureHorizon = (horizonMs: number) => {
    requireProof(evidenceProfile.profile.recording.maxDurationMs >= horizonMs &&
      evidenceProfile.profile.recording.maxFrames >= Math.ceil(horizonMs * 30 / 1000) + 1,
    "Evidence profile cannot cover the requested capture horizon and nominal 30 Hz final frame");
  };
  const paths = evaluationPaths(project, options.paths);
  let studies: StudyLedger | undefined, studyManifest: StudyManifest | undefined, studyAttempt: AttemptReservation | undefined;
  let caps: EvaluationCaps, selected: readonly MinecraftAcceptanceTask[];
  let studyDeadlineAt: number | undefined;
  let conditions = NATURAL_WORLD_CONDITIONS;
  if (options.study) {
    studies = new StudyLedger(paths.governanceRoot, { projectRoot: project });
    try {
      const declaration = readRegisteredStudy(studies, options.study, project);
      studyManifest = declaration.manifest;
      requireProof(studyManifest.execution.controller_mode === "whole_agent",
        "Whole-agent acceptance does not execute released-reference controller studies; use their dedicated admitted entry");
      const admissionOnly = studyManifest.admission_mode === "admission_only";
      requireProof(Boolean(options.admissionOnly) === admissionOnly, "Study admission-only mode must match its immutable manifest");
      if (evidenceProfile.source.path !== null)
        requireProof(studyManifest.identities.preprocessing.some(identity => identity.path === evidenceProfile.source.path &&
          identity.sha256 === evidenceProfile.source.sha256),
        "Evidence profile override must be captured exactly in registered study preprocessing identities");
      if (admissionOnly) {
        requireProof(!options.allowNative && !options.allowInference && !options.authDirectory && !options.nativeJar && !options.modelId && !options.caps,
          "Admission-only mode forbids native/inference/auth/JAR/model/budget resource flags");
        studyAttempt = studies.reserveStudyAttempt(declaration.ref, options.study.slot, { reportDirectory: paths.reportsRoot });
        const outcome: EvaluationOutcome = { platform_status: "pass", agent_status: "not_run", provider_status: "not_called", goal_verified: null,
          classification_reason: ["Durable admission-only transaction; no actor, provider or game was run"] };
        const usage = usageMetrics({ admissions: 0, admitted_request_ids: [], messages: [], events_omitted: false });
        studies.settleStudyAttempt(studyAttempt, { outcome, usage, evidence: [], stop_reason: null });
        studies.confirmStudyResourceDrain(studyAttempt, { requests_drained: true, runtime_closed: true, native_closed: true,
          evidence: ["admission_only_no_external_resources_acquired"] });
        studies.close();
        return { platform_complete: true, failure: null, outcomes: [outcome], study_id: studyManifest.study_id, slot: studyAttempt.slot,
          reservation_id: studyAttempt.reservationId, outcome, usage };
      }
      requireProof(options.allowNative && options.allowInference, "Study execution requires --allow-native AND --allow-inference");
      requireProof(options.authDirectory, "Live study requires --auth-dir for the existing authorization; no implicit account selection");
      requireProof(options.purpose !== "api_control", "Natural study execution is not an API-control diagnostic");
      const arm = studyManifest.arms.find(arm => arm.id === options.study!.slot.arm)!;
      requireProof(!options.modelId || options.modelId === arm.model!.id, "Model override mismatches frozen study manifest arm");
      const per = studyManifest.allowances.per_attempt, cohort = studyManifest.allowances.cohort;
      const totalMs = Math.min(per.wall_ms, cohort.elapsed_ms);
      caps = createEvaluationCaps({ hostRequestAdmissions: per.host_requests, runMs: studyManifest.task.horizon_ms, totalMs,
        authMs: Math.min(DEFAULT_EVALUATION_CAPS.authMs, totalMs), discoveryMs: Math.min(DEFAULT_EVALUATION_CAPS.discoveryMs, totalMs),
        startMs: Math.min(DEFAULT_EVALUATION_CAPS.startMs, totalMs), ...options.caps });
      requireProof(caps.hostRequestAdmissions === per.host_requests, "Study request-cap overrides must exactly match the immutable manifest allowance");
      requireProof(caps.runMs <= studyManifest.task.horizon_ms && caps.totalMs <= totalMs,
        "Budget override exceeds frozen study manifest allowance");
      requireCaptureHorizon(caps.runMs);
      selected = NATURAL_SCENARIOS.filter(scenario => scenario.prompt === studyManifest!.task.text);
      requireProof(selected.length === 1 && (!options.scenario || options.scenario === selected[0]!.id),
        "Unsupported or mismatched study natural task/scenario; no implicit all expansion");
      requireProof(studyManifest.task.verifier.path === "src/server/minecraft-adapter.ts" &&
        studyManifest.task.verifier.sha256 === createHash("sha256").update(readFileSync(fileURLToPath(new URL("../src/server/minecraft-adapter.ts", import.meta.url)))).digest("hex"),
        "Registered verifier identity mismatches the actual adapter-owned versioned predicate implementation");
      const initial = studyManifest.initial_states.find(state => state.id === options.study!.slot.initial_state_id)!;
      conditions = Object.freeze({ ...NATURAL_WORLD_CONDITIONS, seed: initial.seed! });
      const nativeJar = path.join(project, "native/minecraft/build/libs/gameharness-native-1.0.0.jar");
      requireProof(path.resolve(project, studyManifest.identities.build.path) === nativeJar && (!options.nativeJar || path.resolve(project, options.nativeJar) === nativeJar),
        "Native build identity must match the actual supported fixture artifact; JAR override refused");
      const artifact = assertNativeArtifactFresh(project, nativeJar);
      requireProof(artifact.sha256 === studyManifest.identities.build.sha256, "Actual native artifact mismatches frozen manifest identity");
      process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 = artifact.sha256;
      studyAttempt = studies.reserveStudyAttempt(declaration.ref, options.study.slot, { reportDirectory: paths.reportsRoot });
      const admission = studies.readStudy(declaration.ref);
      const reserved = admission.attempts.find(attempt => attempt.reservationId === studyAttempt!.reservationId)!;
      studyDeadlineAt = Math.min(admission.registeredAt + cohort.elapsed_ms, reserved.reservedAt + per.wall_ms, reserved.reservedAt + caps.totalMs);
    } catch (error) { studies.close(); throw error; }
  } else {
    requireProof(!options.admissionOnly, "Admission-only execution requires a registered study manifest");
    // Resolve its exact registered criterion from the negotiated adapter before
    // run creation/inference, not from a second task/verifier registry.
    selected = development ? [{ id: "minecraft-development", prompt: development.task,
      adapter_goal_id: development.criterion, verifier: null }] : selectNaturalScenarios(options.scenario);
    caps = createEvaluationCaps(options.caps);
    // Development recording begins before gameplay and drains afterwards.
    // Its existing profile declaration must cover that complete bounded window.
    requireCaptureHorizon(development ? caps.totalMs : caps.runMs);
    if (development) conditions = Object.freeze({ ...NATURAL_WORLD_CONDITIONS, seed: development.seed });
  }
  requireProof(options.allowNative && options.allowInference, "Agent acceptance requires --allow-native AND --allow-inference");
  requireProof(options.purpose !== "api_control", "Natural scenarios are acceptance/comparison work, not an API-control diagnostic");
  requireProof(options.authDirectory, "Pass --auth-dir with the existing GameHarness data directory; credentials are never copied");
  const authDirectory = path.resolve(options.authDirectory);
  requireProof(selected.length > 0, "Choose collect_wood, craft_crafting_table, obtain_stone, collect_and_craft_table or all (original three cases)");
  const taskDeadline = studyDeadlineAt === undefined ? started + caps.totalMs :
    performance.now() + Math.max(0, studyDeadlineAt - Date.now());
  const workDeadline = studyDeadlineAt === undefined ? taskDeadline - caps.cleanupMs : taskDeadline;
  const preparationDeadline = development ? Math.min(workDeadline, started + 300_000) : workDeadline;
  process.env.GAMEHARNESS_NATIVE_PROOF = "1";
  let fixture: NativeFixture;
  let retention: ArtifactRetention | undefined, artifactRun: ArtifactRun | undefined;
  const artifactOptions: ArtifactRetentionOptions = {
    runtimeRoot: paths.runtimeRoot,
    metadataRoot: path.join(path.dirname(paths.governanceRoot), "artifact-retention"),
    protectedPaths: [authDirectory, paths.governanceRoot, path.join(homedir(), ".minecraft"),
      path.join(project, "local/runtime/minecraft")],
    readOnlyRoots: [paths.reportsRoot],
  };
  const artifactAttemptIds: string[] = [];
  const artifactEvidenceRefs: string[] = [];
  let fixtureCreated = false, fixtureCreationStarted = false;
  let earlyInterruption: string | null = null;
  let earlyCleanupDeadline = Infinity;
  const earlyDone = Promise.withResolvers<void>();
  const earlyInterrupt = (why: string) => {
    // A later signal tightens shutdown even when the original work deadline
    // already supplied the interruption reason.
    if (why === "operator_sigint" || why === "operator_sigterm")
      earlyCleanupDeadline = Math.min(earlyCleanupDeadline, taskDeadline, performance.now() + Math.min(caps.cleanupMs, 9000));
    if (earlyInterruption) return;
    if (studies && studyAttempt) studies.interruptStudyAttempt(studyAttempt, why);
    earlyInterruption = why;
  };
  const unregisterEarly = postmortem.register(`acceptance-startup-${studyAttempt?.reservationId ?? randomUUID()}`, why => {
    earlyInterrupt(why === postmortem.Reason.SIGINT ? "operator_sigint" : why === postmortem.Reason.SIGTERM ? "operator_sigterm" : `process_${why}`);
    return earlyDone.promise;
  }, { exitOnly: true });
  const earlyTimer = setTimeout(() => earlyInterrupt("entire_sample_deadline"), Math.max(1, workDeadline - performance.now()));
  try {
    if (performance.now() >= workDeadline) earlyInterrupt("entire_sample_deadline");
    requireProof(!earlyInterruption, "Insufficient original sample budget before native preparation");
    const authFile = await lstat(path.join(authDirectory, "auth/gameharness.sqlite"));
    requireProof(authFile.isFile() && !authFile.isSymbolicLink(), "Existing GameHarness auth storage must be a regular file; this command never creates a replacement identity");
    requireProof(!earlyInterruption && performance.now() < preparationDeadline, "Original sample startup budget expired before native preparation");
    if (!studyManifest) {
      retention = new ArtifactRetention(artifactOptions);
      artifactRun = retention.acquire({ reservationBytes: 3 * 1024 ** 3, headroomBytes: 512 * 1024 ** 2,
        attempt: { purpose: "development", declaration: JSON.stringify({ development, model: options.modelId ?? "gpt-6-luna",
          tasks: selected.map(task => ({ id: task.id, prompt: task.prompt })),
          hypothesis: options.hypothesisId, evidence_revision: options.platformEvidenceRevision, caps }) } });
    }
    // Creation remains owned until settlement. A timeout is not cancellation,
    // and must never abandon a late fixture or admit a replacement.
    fixtureCreationStarted = true;
    fixture = await NativeFixture.create("agent-acceptance", { projectRoot: project,
      paths: artifactRun ? { ...paths, runtimeRoot: artifactRun.directory } : paths, caps, authDirectory, conditions,
      deadlineHostMs: taskDeadline, preparationDeadlineHostMs: preparationDeadline });
    fixtureCreated = true;
    if (earlyInterruption && studies) {
      const closed = await fixture.close();
      if (closed.closed) studies!.confirmStudyResourceDrain(studyAttempt!, { requests_drained: true, runtime_closed: true, native_closed: true,
        evidence: ["interrupted_native_fixture_creation_joined_before_any_auth_or_runtime_startup"] });
      throw new Error("Study startup interrupted; no inference or replacement slot admitted");
    }
  } catch (error) {
    // Storage bookkeeping cannot stand between a startup owner and its drain.
    let drained = !fixtureCreationStarted;
    if (fixtureCreated) {
      try { drained = (await fixture!.close()).closed; } catch { drained = false; }
    }
    try {
      if (retention && artifactRun) {
        retention.beginDrain(artifactRun.id);
        if (drained) retention.closeRun(artifactRun.id, { drained: true,
          outcome: { status: "failure", attemptIds: [], reasons: ["startup_failed_before_model_admission"], evidenceRefs: [] },
          drainEvidence: ["startup_preparation_owner_joined_before_model_admission"] });
      }
    } catch {
      // The active/draining registration remains protected when persistence fails.
    } finally { try { retention?.close(); } catch {} }
    if (studies && studyAttempt) {
      if (!earlyInterruption) studies.settleStudyAttempt(studyAttempt, { outcome: { platform_status: "fail", agent_status: "not_run", provider_status: "not_called", goal_verified: null,
        classification_reason: ["Scheduled startup failed before model inference; external resource ownership may be unconfirmed"] }, usage: null, evidence: [], stop_reason: "invalid_platform" });
      studies.close();
    }
    earlyDone.resolve();
    throw error;
  } finally { clearTimeout(earlyTimer); unregisterEarly?.(); }
  const ledger = new AttemptLedger(paths.governanceRoot, { projectRoot: project });
  const batchId = randomUUID();
  const clockId = `acceptance-${batchId}`;
  let auth: AuthManager | undefined, store: Store | undefined, runtime: Runtime | undefined, sandbox: SandboxService | undefined;
  let evidence: ModelProgramEvidence | undefined;
  let recorder: EpisodeRecorder | undefined;
  let config: AcceptanceConfig | undefined, diagnosticConfig: EvaluationConfig | undefined;
  const scope = new AbortController();
  const capacityScope = new AbortController();
  let capacityTimer: ReturnType<typeof setTimeout> | undefined;
  let capacityWork: Promise<void> | undefined;
  let artifactDrainRegistered = false;
  // An already-running startup finalizer keeps this same completion barrier
  // across handoff; fixture creation is not joined logical sample cleanup.
  const completed = earlyDone;
  let closing = false, abortReason: string | null = null, activeRun: string | null = null;
  let stopping: Promise<unknown> | null = null;
  let activeReservation: string | null = studyAttempt?.reservationId ?? null, reservationInterrupted = false;
  let studySettled = false;
  let studyAdmissionFault: string | null = null;
  const studyRequests = new Map<string, { receipt: StudyRequestReservation; terminal: boolean; drained: boolean }>();
  const developmentRequests = new Map<string, { transport_closed: boolean | null; drained: boolean }>();
  let authenticatedProvider: string | null = null;
  let developmentDeadline = Infinity;
  const governedRequestAdmission: StrategicRequestAdmission | undefined = studies && studyAttempt ? {
    reserve(requestId, model) {
      const frozen = studyManifest!.arms.find(arm => arm.id === studyAttempt!.slot.arm)!.model!;
      if (model.id !== frozen.id || model.provider !== frozen.provider || model.api !== frozen.api) {
        studyAdmissionFault = "actual_transport_model_identity_mismatches_registered_study";
        throw new Error(studyAdmissionFault);
      }
      const receipt = studies!.reserveStudyRequest(studyAttempt!, { requestId, path: "strategic" });
      studyRequests.set(requestId, { receipt, terminal: false, drained: false });
    },
    transportEnded(requestId, closed) {
      const owned = studyRequests.get(requestId);
      requireProof(owned, "Transport has no registered study request owner");
      if (!owned.terminal) { studies!.settleStudyRequest(owned.receipt, { status: closed ? "settled" : "unknown",
        evidence: [closed ? "actual_sdk_stream_iterator_exhausted" : "sdk_iterator_did_not_confirm_transport_closure"] }); owned.terminal = true; owned.drained = closed; }
    },
    drained(requestIds) {
      for (const requestId of requestIds) {
        const owned = studyRequests.get(requestId);
        requireProof(owned, "Drained transport has no registered study owner");
        if (!owned.terminal) { studies!.settleStudyRequest(owned.receipt, { status: "unknown", evidence: ["agent_closed_without_confirmed_terminal_stream"] }); owned.terminal = true; }
        if (!owned.drained) { studies!.confirmStudyRequestDrain(owned.receipt, ["actual_agent_idle_turn_joined_and_auth_scope_released"]); owned.drained = true; }
      }
    },
  } : development ? {
    reserve(requestId, model) {
      requireProof(activeReservation && !reservationInterrupted && !scope.signal.aborted &&
        performance.now() < developmentDeadline, "Development attempt has no live finite reservation");
      requireProof(config && model.id === config.model.id && model.provider === authenticatedProvider,
        "Development transport mismatches its declared model/account provider");
      requireProof(!developmentRequests.has(requestId), "Development request already has an admitted owner");
      if (developmentRequests.size >= caps.hostRequestAdmissions) {
        // Refuse the NEXT call, after the last admitted response and its tools.
        // Fence synchronously so the planner cannot count this host refusal as
        // empty model work while the existing Stop owner joins actual drain.
        report.development_host_request_admission_refused = true;
        if (activeRun) stop(activeRun, "host_request_admission_bound_reached");
        throw new Error("Development pre-transport request allowance exhausted");
      }
      developmentRequests.set(requestId, { transport_closed: null, drained: false });
    },
    transportEnded(requestId, closed) {
      const owned = developmentRequests.get(requestId);
      requireProof(owned, "Development transport has no admitted owner");
      owned.transport_closed = closed;
      owned.drained = closed;
    },
    drained(requestIds) {
      for (const id of requestIds) {
        const owned = developmentRequests.get(id);
        requireProof(owned, "Development drain has no admitted owner");
        owned.drained = true;
      }
    },
  } : undefined;
  const requestAdmission: StrategicRequestAdmission = {
    reserve(requestId, model) {
      // Check the original clock at the actual pre-transport boundary as well
      // as on timer callbacks; a delayed event loop cannot admit a late call.
      assertOpen();
      governedRequestAdmission?.reserve(requestId, model);
    },
    transportEnded: (requestId, closed) => governedRequestAdmission?.transportEnded(requestId, closed),
    drained: requestIds => governedRequestAdmission?.drained(requestIds),
  };
  let activeCase: Record<string, unknown> | null = null;
  let failure: unknown;
  let replayWork: Promise<string> | undefined;
  let ownedWork: Promise<void> | undefined;
  const preparationWork = new Set<Promise<unknown>>();
  function ownPreparation<T>(operation: Promise<T>): Promise<T> {
    preparationWork.add(operation);
    void operation.finally(() => preparationWork.delete(operation)).catch(() => {});
    return operation;
  }
  const cleanup: Array<{ resource: string; closed: boolean }> = [];
  let cleanupDeadline = Infinity, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const report: Record<string, unknown> = {
    schema_version: 1, batch_id: batchId, tier: "agent-acceptance", classification: "natural_normal_survival_finite_actual_provider_sample",
    conditions, declared_scenarios: selected, results: [],
    inference_transport: options.singleInferenceDispatch
      ? { condition: "single_dispatch_sse", max_host_inference_http_dispatches_per_admission: 1, redirects: "manual", authentication_replay: false }
      : { condition: "ordinary_sdk_defaults", max_host_inference_http_dispatches_per_admission: null },
    inference_reasoning: { condition: development?.reasoning ? "explicit_supported_effort" : "backend_default_unspecified",
      requested_effort: development?.reasoning ?? null,
      evidence: "Declaration only; actual serialization is recorded by the per-request SDK onPayload event, not inferred from motor profile." },
    credential_policy: "Existing GameHarness auth storage opened in place. No login/logout, copies, identity dumps, ambient account imports or fallback model.",
    comparison_scope: "Fixed seed/settings and fresh world per case. Vanilla timing and provider behavior are not controlled; no causal or cross-model improvement claim.",
    source_policy: "Only the actual provider authors gameplay and optional game guards. No supplied programs, targets, inventory, console commands or required tool sequence.",
    private_evidence_root: fixture.root, caps, evidence_profile: evidenceProfile,
    artifact_retention: artifactRun ? { bundle_id: artifactRun.id, directory: artifactRun.directory,
      reservation_bytes: artifactRun.reservationBytes, headroom_bytes: artifactRun.headroomBytes,
      project_budget_bytes: 20 * 1024 ** 3, max_unpinned_runs: 10, max_age_days: 14,
      protected_legacy_payloads: true, capacity_check_interval_ms: 5000 } : null,
    timing: { scope: "original_task_submission_through_actual_cleanup", preparation_allowance_ms: development ? 300_000 : null,
      cleanup_reserved_ms: studyDeadlineAt === undefined ? caps.cleanupMs : 0 },
    capture_scope: { minimum_task_horizon_ms: caps.runMs, nominal_hz: 30, final_frame_margin: 1,
      required_retention_horizon_ms: development ? caps.totalMs : caps.runMs,
      prelude_and_drain: "Recorder also covers actual prelude and drain; profile exhaustion remains explicit incomplete evidence" },
    native_evidence: "native-report.json",
    cleanup_confirmed: false, cleanup_state: "not_started",
  };
  if (studyAttempt) Object.assign(report, { study_id: studyAttempt.studyId, slot: studyAttempt.slot, reservation_id: studyAttempt.reservationId,
    manifest_sha256: studyAttempt.manifestSha256, isolation: { store: "fresh_fixture_private", working_programs: "fresh", experience: "disabled_cold_no_global_library", publication: "unavailable_until_cohort_closure" } });
  if (development) Object.assign(report, { tier: "minecraft-development",
    classification: "declared_fresh_seeded_minecraft_development_actual_provider",
    development, comparison_scope: "Disclosed selected fresh seed; not an untouched generalization test or registered study",
    development_host_admissions: developmentRequests.size });
  const caseReports: Array<Record<string, unknown>> = [];
  report.results = caseReports;
  let reportTail: Promise<void> = Promise.resolve();
  function writeReport() {
    // One report writer: interruption snapshots cannot race a case's pending
    // write and replace durable cleanup truth with an older passing report.
    const write = reportTail.then(() => fixture.writeReport(report));
    reportTail = write.catch(() => { report.report_persistence_failed = true; });
    return write;
  }
  function assertOpen() {
    if (!abortReason && performance.now() >= workDeadline) interrupt("entire_sample_deadline");
    requireProof(!closing && !scope.signal.aborted && abortReason === null, "The finite acceptance scope is closed");
  }
  function assertPreparing() {
    assertOpen();
    requireProof(performance.now() < preparationDeadline, "Original preparation allowance expired before resource acquisition");
  }
  function scheduleCapacityCheck() {
    if (!artifactRun || closing || capacityScope.signal.aborted) return;
    capacityTimer = setTimeout(() => {
      if (closing || capacityScope.signal.aborted) return;
      capacityWork = checkArtifactCapacity(artifactOptions, artifactRun!.id,
        { timeoutMs: 10_000, signal: capacityScope.signal }).then(sample => {
          report.artifact_capacity = sample;
        }).catch(() => {
          if (!closing && !capacityScope.signal.aborted) interrupt("artifact_capacity_check_failed");
        }).finally(() => { if (!closing && !capacityScope.signal.aborted) scheduleCapacityCheck(); });
    }, 5000);
  }
  async function prepareWithin<T>(operation: () => Promise<T>, capMs: number, message: string): Promise<T> {
    assertPreparing();
    return await bounded(ownPreparation(operation()), Math.min(capMs,
      Math.max(1, preparationDeadline - performance.now())), message);
  }
  function armCleanup(signalExit = false) {
    // The SDK hard-exits signal cleanup after ten seconds. Reserve time for
    // durable truth rather than promising the normal 25 seconds per resource.
    const now = performance.now();
    const end = Math.min(taskDeadline, earlyCleanupDeadline, now + Math.min(caps.cleanupMs, signalExit ? 9000 : caps.cleanupMs));
    const budget = Math.max(0, end - now);
    if (end >= cleanupDeadline) return;
    cleanupDeadline = end;
    clearTimeout(cleanupTimer);
    report.cleanup_budget_ms = budget;
    cleanupTimer = setTimeout(() => {
      report.cleanup_deadline_reached = true;
      report.cleanup_confirmed = false;
      report.cleanup_state = "deadline_exceeded_owned_drain_unconfirmed";
      report.resource_cleanup = cleanup;
      void writeReport().catch(() => {});
    }, budget);
  }
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
    failure ??= new Error(`Acceptance interrupted: ${abortReason}`);
    scope.abort(failure);
    armCleanup(why === "operator_sigint" || why === "operator_sigterm");
    if (studies && studyAttempt) studies.closeStudyAdmissions({ studyId: studyAttempt.studyId, manifestSha256: studyAttempt.manifestSha256 }, abortReason);
    if (activeReservation && !reservationInterrupted) {
      try {
        if (studies && studyAttempt) studies.interruptStudyAttempt(studyAttempt, abortReason);
        else ledger.interruptAttempt(activeReservation, abortReason);
        reservationInterrupted = true;
      }
      catch { report.reservation_interruption_failed = true; }
    }
    if (activeCase) report.interrupted_case = structuredClone(activeCase);
    report.failure = reason(failure);
    report.cleanup_confirmed = false;
    if (activeRun) stop(activeRun, why);
  }
  const expiry = Promise.withResolvers<never>();
  void expiry.promise.catch(() => {});
  const timer = setTimeout(() => { interrupt("entire_sample_deadline"); expiry.reject(new Error("Finite acceptance sample deadline reached")); },
    Math.max(1, workDeadline - performance.now()));
  if (earlyInterruption || performance.now() >= workDeadline) {
    interrupt(earlyInterruption ?? "entire_sample_deadline");
    expiry.reject(failure);
  }
  const unregisterCleanup = postmortem.register(`agent-acceptance-${batchId}`, why => {
    interrupt(why === postmortem.Reason.SIGINT ? "operator_sigint" :
      why === postmortem.Reason.SIGTERM ? "operator_sigterm" : `process_${why}`);
    expiry.reject(failure);
    return completed.promise;
  }, { exitOnly: true });
  async function close(resource: string, operation: () => unknown | Promise<unknown>) {
    const entry = { resource, closed: false }; cleanup.push(entry);
    const draining = Promise.resolve().then(operation);
    try { await bounded(draining, Math.max(1, cleanupDeadline - performance.now()), `${resource} cleanup deadline`); entry.closed = true; }
    catch {
      // A deadline is not cancellation or proof of closure. Keep ownership
      // until actual settlement; the SDK may force exit, leaving the early
      // interrupted ledger/report explicitly unconfirmed instead of fabricated.
      try { await draining; entry.closed = true; } catch {}
    }
  }
  async function authenticate() {
    assertPreparing();
    // Config-consuming production modules load only AFTER fixture isolation is established.
    const { AuthManager } = await import("../src/server/auth.ts");
    let changed = () => {};
    assertPreparing();
    await bounded(ownPreparation(AuthManager.create(authDirectory, () => changed(), { singleInferenceDispatch: options.singleInferenceDispatch,
      reasoning: development?.reasoning }).then(async manager => {
      auth = manager;
      if (closing || abortReason) { await manager.close(); throw new Error("Authorization opened after scope closure"); }
    })), Math.min(caps.authMs, Math.max(1, preparationDeadline - performance.now())), "Opening existing auth storage timed out");
    const ready = Promise.withResolvers<void>();
    changed = () => {
      const state = auth!.snapshot();
      if (state.status === "ready" && state.authenticated) ready.resolve();
      else if (["signed_out", "unavailable", "error"].includes(state.status)) ready.reject(new Error("Existing authorization is unavailable; no login or substitute account/model is permitted"));
    };
    changed();
    await bounded(ready.promise, Math.min(caps.discoveryMs, Math.max(1, preparationDeadline - performance.now())), "Actual model discovery timed out");
    changed = () => {};
    assertOpen();
    const state = auth!.snapshot();
    authenticatedProvider = state.provider;
    if (studyManifest) {
      const selection = studyManifest.arms.find(arm => arm.id === studyAttempt!.slot.arm)!.model!;
      const model = state.models.find(model => model.id === selection.id);
      requireProof(state.provider === selection.provider && model?.provider === selection.provider,
        "Actual provider/model discovery mismatches frozen study identity; no fallback");
      requireProof(model, "Frozen study model was not discovered; no fallback");
      config = Object.freeze({ model: structuredClone(model), purpose: options.purpose ?? "comparison", justification: studyManifest.purpose,
        platformEvidenceRevision: studyManifest.platform_evidence_revision, caps, subscriptionMonetaryCost: null });
    } else {
      requireProof(!options.study, "Diagnostic identity cannot be fabricated for a study");
      diagnosticConfig = createEvaluationConfig({ discoveredModels: state.models, modelId: options.modelId, purpose: options.purpose ?? "ordinary_acceptance",
        justification: options.justification, hypothesisId: options.hypothesisId, platformEvidenceRevision: options.platformEvidenceRevision, caps });
      config = diagnosticConfig;
    }
    requireProof(state.models.find(model => model.id === config!.model.id)?.input_modalities?.includes("image"),
      "Recorded image-enabled acceptance requires discovered SDK image input capability before reservation or inference; this does not prove live vision");
    report.config = config;
    report.auth = { provider: state.provider, authenticated: state.authenticated, selected_model: config.model };
  }
  async function runCase(scenario: MinecraftAcceptanceTask, index: number) {
    assertOpen();
    if (runtime) { await bounded(runtime.close(), caps.cleanupMs, "Previous run drain timed out"); runtime = undefined; }
    assertOpen();
    if (index === 0) await fixture.start();
    else await fixture.nextWorld();
    assertPreparing();
    const { Runtime } = await import("../src/server/runtime.ts");
    assertOpen();
    let hostBaseline: Json | null = null;
    runtime = new Runtime(store!, auth!, fixture.bridge, sandbox!, () => {
      const active = runtime?.snapshot();
      // Capture once on trusted preflight publication, before strategic
      // transport. Created runs do not have an observation baseline yet.
      if (hostBaseline === null && active?.status === "running" && active.started_at)
        hostBaseline = structuredClone(store!.getRun(active.run_id)!.baseline);
    }, { adapter: () => fixture.bridge.adapter(), actorFrames: fixture.bridge, requestAdmission });
    await prepareWithin(() => runtime!.initialize(), caps.startMs, "Production runtime initialization timed out");
    assertOpen();
    evidence!.bindRuntime(runtime);
    const adapter = fixture.bridge.adapter();
    requireProof(adapter, "No actual negotiated adapter is available before run creation");
    if (development) {
      scenario = developmentTask(development, adapter);
      report.declared_scenarios = [scenario];
    }
    const run = await prepareWithin(() => runtime!.createRun({ task: scenario.prompt, goal: scenarioGoal(adapter, scenario), model_id: config!.model.id, working_programs: "fresh" }), caps.startMs, "Run creation timed out");
    assertOpen();
    activeRun = run.run_id;
    const recordingDirectory = `case-${scenario.id}-recording`;
    recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, recordingDirectory), bridge: fixture.bridge,
      captureMode: studyManifest ? "lossless_png" : "live_compressed",
      limits: evidenceProfile.profile.recording,
      identity: { episode_id: randomUUID(), run_id: run.run_id, world_id: run.world_id, session_id: run.session_id! },
      onIncomplete: why => { report.recording_failure = why; stop(run.run_id, "recording_evidence_incomplete"); } });
    const initial = await prepareWithin(() => fixture.bridge.observe(), caps.observationMs, "Run-start observation timed out");
    assertOpen();
    if (studyManifest) {
      const profile = readStudyObservationProfile(studyManifest, project);
      const expectedHash = contractHash(profile);
      requireProof(initial.schema_version === profile.observation.schema_version && initial.profile_id === profile.observation.profile.id &&
        initial.profile_configuration_hash === profile.observation.profile.configuration_hash && initial.compatibility_hash === expectedHash,
        "Actual observation profile/schema mismatches registered study before inference");
      const declaredConfiguration = minecraftProfileConfigurationSchema.parse(profile.observation.profile.configuration);
      const actualBinding = fixture.bridge.snapshot().binding;
      requireProof(actualBinding?.ready && actualBinding.compatibility_hash === expectedHash, "Actual negotiated adapter descriptor mismatches registered study");
      const actualConfiguration = minecraftProfileConfigurationSchema.parse(actualBinding.descriptor.observation.profile.configuration);
      requireProof(actualConfiguration.motor_profile === declaredConfiguration.motor_profile,
        "Actual bridge motor profile mismatches the complete registered configuration");
      const nativeConfiguration = await bounded(fixture.diagnostics(), caps.diagnosticsMs, "Study native configuration preflight timed out");
      assertOpen();
      requireProof(nativeConfiguration.motor_profile === declaredConfiguration.motor_profile,
        "Actual native motor profile mismatches the complete registered configuration");
    }
    evidence!.recordObservation(run.run_id, initial);
    const independentVerifier = captureScenarioVerification(adapter, scenario, run.run_id, initial, index + 1);
    const baseline = independentVerifier.manifest.baseline;
    report.active_verifier = { scenario_id: scenario.id, manifest: independentVerifier.manifest };
    await fixture.writeJson(`case-${scenario.id}-declaration.json`, { scenario, baseline, development: development ?? null,
      evidence_profile: evidenceProfile,
      inference_reasoning: report.inference_reasoning,
      host_baseline_timing: "Captured once on trusted host-preflight running publication, before strategic transport",
      conditions: fixture.report.world_conditions, declared_before_inference: true });
    assertOpen();
    // Reservation is durable before Runtime.start can admit the first provider request.
    const reservation = studyAttempt ? { attemptId: studyAttempt.reservationId } :
      ledger.admitAttempt(diagnosticConfig!, { reportDirectory: fixture.evidenceDirectory, promptRevision: scenario.verifier?.revision ?? "custom_unverified", scenarioId: scenario.id });
    activeReservation = reservation.attemptId;
    reservationInterrupted = false;
    if (retention && artifactRun) {
      artifactAttemptIds.push(reservation.attemptId);
      retention.register(artifactRun.id, { attemptIds: [reservation.attemptId], evidenceRefs: [fixture.evidenceDirectory] });
    }
    const caseStart = performance.now();
    let verification: VerificationResult | null = scenario.verifier ? verifyScenarioCompletion(independentVerifier, null, []) : null;
    activeCase = { scenario_id: scenario.id, run_id: run.run_id, attempt_id: reservation.attemptId,
      baseline, verifier_manifest: independentVerifier.manifest, verification };
    report.active_case = activeCase;
    report.observation_policy = {
      during_gameplay: development ? "production_runtime_only" : "evaluator_authorized_observation_polling",
      initial_and_final_evaluator_observations: true,
      evaluator_poll_refreshes_actor_geometry: !development,
    };
    let latest: ObservationV3 | null = null;
    let caseFailure: unknown;
    let deadlineReached = false;
    const runTimer = setTimeout(() => { deadlineReached = true; stop(run.run_id, "finite_run_deadline"); }, caps.runMs);
    developmentDeadline = performance.now() + caps.runMs;
    try {
      assertOpen();
      await prepareWithin(() => runtime!.control(run.run_id, "start"), caps.startMs, "Production run start timed out");
      assertOpen();
      if (hostBaseline !== null) await fixture.writeJson(`case-${scenario.id}-host-baseline.json`, hostBaseline);
      while (!terminal(runtime)) {
        assertOpen();
        if (runtime.snapshot()?.status === "paused") { stop(run.run_id, "runtime_paused_no_automatic_resume"); break; }
        if (!development) {
          latest = await evidence!.measure(run.run_id, "observation", () => bounded(fixture.bridge.observe(), caps.observationMs, "Authorized observation timed out"));
          assertOpen();
          evidence!.recordObservation(run.run_id, latest);
          verification = scenario.verifier ? verifyScenarioCompletion(independentVerifier, latest, evidence!.actions(run.run_id)) : null;
          activeCase.verification = verification;
          if (verification?.status === "verified") { stop(run.run_id, "declared_semantic_goal_verified"); break; }
        }
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
      assertOpen();
      evidence!.recordObservation(run.run_id, latest);
      const finalVerification = scenario.verifier ? verifyScenarioCompletion(independentVerifier, latest, evidence!.actions(run.run_id)) : null;
      if (verification?.status !== "verified") verification = finalVerification;
      activeCase.verification = verification;
      const diagnostics = await bounded(ownPreparation(fixture.diagnostics()), caps.diagnosticsMs, "Native neutralization diagnostics timed out");
      assertOpen();
      neutral = diagnostics.controls_neutral && !diagnostics.motor_active;
      if (!neutral) harnessFaults.push("native_neutralization_failed");
    } catch (error) { caseFailure ??= error; }
    assertOpen();
    const baselinePreserved = hostBaseline !== null && JSON.stringify(hostBaseline) === JSON.stringify(store!.getRun(run.run_id)?.baseline);
    if (!baselinePreserved) harnessFaults.push("run_inventory_baseline_changed");
    if (fixture.commands.length) harnessFaults.push("ordinary_world_privileged_commands_used");
    const historyOptions = { signal: scope.signal, deadlineHostMs: workDeadline };
    const summary = await evidence!.summary(run.run_id, historyOptions);
    assertOpen();
    if (studyAdmissionFault) harnessFaults.push(studyAdmissionFault);
    harnessFaults.push(...summary.confirmed_harness_faults);
    const actualRun = runtime.getRun(run.run_id);
    const ordinaryPlanningFailure = actualRun?.status === "failed" && await evidence!.eventCount(run.run_id, "scheduler.planning_stalled", undefined, historyOptions) > 0;
    assertOpen();
    const ordinaryVerifierFailure = actualRun?.status === "failed" && await evidence!.eventCount(run.run_id, "goal.verification", "failed", historyOptions) > 0;
    assertOpen();
    const unclassifiedRuntimeFailure = actualRun?.status === "failed" && !ordinaryPlanningFailure && !ordinaryVerifierFailure && !summary.provider_error && harnessFaults.length === 0;
    const connected = fixture.bridge.snapshot().status === "connected" && fixture.bridge.snapshot().error === null;
    if (!connected) harnessFaults.push("native_session_unavailable");
    const usage = summary.usage;
    // Persist independently observed goal facts before optional postprocessing.
    // A signal may interrupt rendering without erasing an already verified gain.
    activeCase.usage = usage;
    await writeReport();
    assertOpen();
    const recording = await recorder.finish({ endedAt: Date.now(), reason: caseFailure ? "case_failed" : String(report.last_stop_reason ?? "case_ended") });
    assertOpen();
    if (recording.status !== "complete") harnessFaults.push("recording_evidence_incomplete");
    let replay: string | null = null;
    try {
      replayWork = recorder.renderReplay({ signal: scope.signal, timeoutMs: evidenceProfile.profile.render_timeout_ms });
      replay = await replayWork;
    }
    catch { harnessFaults.push("offline_replay_render_failed"); }
    assertOpen();
    const journal = await evidence!.finalize(run.run_id, { status: caseFailure ? "failed" : "finished",
      reason: caseFailure ? "case_failure" : String(report.last_stop_reason ?? "case_ended") }, historyOptions);
    assertOpen();
    if (!journal.evidence_complete) harnessFaults.push("private_model_evidence_incomplete");
    const outcome = classifyEvaluation({ inferenceAdmitted: usage.admissions > 0,
      goalVerified: verification?.status === "verified" ? true : !verification || verification.status === "unknown" ? null : false,
      platformChecksComplete: neutral && connected && baselinePreserved && summary.observer_error === null && !caseFailure && !summary.unclassified_tool_failures && !unclassifiedRuntimeFailure,
      confirmedHarnessFaults: harnessFaults, providerError: summary.provider_error, providerSettled: summary.provider_settled,
      reasons: [...(deadlineReached ? ["finite_run_deadline_reached"] : []), ...(caseFailure ? ["case_ended_with_unclassified_error"] : []),
        ...(report.development_host_request_admission_refused === true ? ["host_request_admission_bound_reached"] : []),
        ...(ordinaryPlanningFailure ? ["planning_stalled"] : []),
        ...(ordinaryVerifierFailure ? ["adapter_verifier_failed"] : []),
        ...(summary.unclassified_tool_failures ? ["tool_failure_requires_classification"] : []),
        ...(unclassifiedRuntimeFailure ? ["runtime_failure_requires_classification"] : [])],
    });
    const caseEnd = performance.now();
    const entry = { scenario_id: scenario.id, declared_verifier: scenario.verifier, prompt: scenario.prompt, attempt_id: reservation.attemptId,
      run_id: run.run_id, conditions, outcome, verification, baseline, verifier_manifest: independentVerifier.manifest,
      host_baseline_preserved: baselinePreserved, runtime_status: actualRun?.status, usage, actions: summary.actions,
      wait_coverage: waitCoverage({ start_ms: caseStart, end_ms: caseEnd, clock_id: clockId }, evidence!.intervals(run.run_id, caseEnd)),
      omissions: summary.omissions, failure: caseFailure ? reason(caseFailure) : null,
      evidence: await evidence!.save(run.run_id, historyOptions),
      evidence_profile: evidenceProfile,
      private_journal: journal, recording: { directory: recordingDirectory, manifest: "recording-manifest.json", replay,
        replay_inspection: "Parent must inspect offline replay; render success is not visual inspection." },
      completion_claim: scenario.verifier ? "registered_independent_verifier" :
        await evidence!.eventCount(run.run_id, "task.completion_reported", undefined, historyOptions) > 0
          ? "model_reported_unverified" : "custom_not_completed_unverified",
    };
    if (studyAttempt) Object.assign(entry, { study_id: studyAttempt.studyId, slot: studyAttempt.slot, reservation_id: studyAttempt.reservationId });
    assertOpen();
    const artifact = fixture.report.native_artifact;
    const nativeHash = artifact && typeof artifact === "object" && "sha256" in artifact && typeof artifact.sha256 === "string" ? artifact.sha256 : null;
    const natural = NATURAL_SCENARIOS.find(candidate => candidate.id === scenario.id);
    requireProof(development || natural, "Acceptance task lacks an explicit declaration");
    const compact = development ? { schema_version: 1, tier: "minecraft-development", development,
      inference_reasoning: report.inference_reasoning,
      model_id: config!.model.id, hypothesis_id: config!.hypothesisId, outcome, usage,
      verification, completion_claim: entry.completion_claim, evidence: entry.evidence } :
      compactReport(natural!, config!, outcome, summary, entry.evidence, nativeHash, studyAttempt);
    const compactName = `${batchId}-${scenario.id}.json`;
    await writeFile(path.join(paths.reportsRoot, compactName), JSON.stringify(compact, null, 2), { mode: 0o600, flag: "wx" });
    assertOpen();
    const caseEvidence = [entry.evidence, journal.manifest, `${recordingDirectory}/recording-manifest.json`, compactName];
    if (retention && artifactRun) {
      artifactEvidenceRefs.push(...caseEvidence.slice(0, -1).map(file => path.join(fixture.evidenceDirectory, file)),
        path.join(paths.reportsRoot, compactName));
      retention.register(artifactRun.id, { attemptIds: [reservation.attemptId], evidenceRefs: artifactEvidenceRefs });
      if (outcome.goal_verified === true)
        retention.pin(artifactRun.id, "manual-review", "Verified goal candidate awaiting operator visual review");
    }
    if (studies && studyAttempt) {
      studies.settleStudyAttempt(studyAttempt, { outcome, usage, evidence: caseEvidence, stop_reason: outcome.platform_status === "pass" ? null : "invalid_platform" });
      studySettled = true;
    } else ledger.settleAttempt(reservation.attemptId, { outcome, usage, evidence: caseEvidence });
    activeReservation = null;
    activeRun = null;
    activeCase = null;
    recorder = undefined;
    replayWork = undefined;
    report.active_case = null;
    report.active_verifier = null;
    caseReports.push(entry);
    await fixture.writeJson(`case-${scenario.id}.json`, entry);
    assertOpen();
    await writeReport();
    assertOpen();
    // No green-seeking loop. One independent predeclared case per scenario only.
  }
  async function work() {
    await authenticate();
    assertOpen();
    await writeReport();
    assertOpen();
    const { Store } = await import("../src/server/store.ts");
    const { SandboxService } = await import("../src/server/sandbox.ts");
    assertPreparing();
    store = new Store(fixture.root);
    sandbox = new SandboxService(project, () => {});
    await bounded(ownPreparation(sandbox.prepare()), Math.min(caps.startMs, Math.max(1, preparationDeadline - performance.now())), "Production Docker sandbox preparation timed out");
    requireProof(sandbox.snapshot().status === "ready", "Actual production sandbox isolation is unavailable");
    assertOpen();
    evidence = new ModelProgramEvidence(store, fixture.evidenceDirectory, caps, clockId, (runId, why) => {
      // These routes deny requests BEFORE transport. The after-admission
      // observer must not cancel the final admitted call.
      if ((studyAttempt || development) && why === "host_request_admission_bound_reached") {
        report.host_request_allocation_fully_admitted = true;
        return;
      }
      stop(runId, why);
    }, { limits: evidenceProfile.profile.journal });
    evidence.observeAuthAgents(auth!);
    await mkdir(paths.reportsRoot, { recursive: true, mode: 0o700 });
    assertOpen();
    for (let index = 0; index < selected.length; index++) {
      try { await runCase(selected[index]!, index); }
      catch (error) {
        if (scope.signal.aborted) throw error;
        if (activeReservation) throw error;
        // Policy refusal is terminal for this finite sample, never a new hypothesis or directory retry.
        caseReports.push({ scenario_id: selected[index]!.id, outcome: classifyEvaluation({ inferenceAdmitted: false, goalVerified: null,
          platformChecksComplete: false, providerError: false, providerSettled: false, reasons: ["case_not_admitted"] }), failure: reason(error) });
        throw error;
      }
    }
  }
  try {
    try {
      scheduleCapacityCheck();
      await writeReport();
      assertOpen();
      ownedWork = work();
      await Promise.race([ownedWork, expiry.promise]);
    }
    catch (error) { failure ??= error; }
    finally {
      closing = true;
      clearTimeout(capacityTimer);
      capacityScope.abort(new Error("Acceptance artifact producers are draining"));
      clearTimeout(timer);
      if (failure && !abortReason && studies && studyAttempt && !studySettled && !reservationInterrupted && studyRequests.size === 0) {
        studies.settleStudyAttempt(studyAttempt, { outcome: { platform_status: "fail", agent_status: "not_run", provider_status: "not_called", goal_verified: null,
          classification_reason: ["Scheduled startup/discovery failed before strategic transport; no fallback or replacement slot"] },
          usage: usageMetrics({ admissions: 0, admitted_request_ids: [], messages: [], events_omitted: false }), evidence: [], stop_reason: "invalid_platform" });
        studySettled = true; activeReservation = null;
      }
      if (failure && !abortReason) interrupt("outer_failure");
      scope.abort(failure ?? new Error("Acceptance scope closed"));
      armCleanup();
      report.cleanup_state = "draining";
      report.resource_cleanup = cleanup;
      if (activeCase) report.interrupted_case = structuredClone(activeCase);
      if (activeRun) stop(activeRun, "sample_cleanup");
      // Start fencing/drain before joining work: a case may itself be awaiting
      // Runtime Stop or native startup. Keep these exact owners for final join.
      const runtimeDrain = runtime?.close();
      void runtimeDrain?.catch(() => {});
      const nativeDrain = failure ? fixture.close() : undefined;
      void nativeDrain?.catch(() => {});
      const sandboxDrain = sandbox?.close();
      void sandboxDrain?.catch(() => {});
      try {
        if (retention && artifactRun) {
          try { retention.beginDrain(artifactRun.id); artifactDrainRegistered = true; }
          catch {
            failure ??= new Error("Artifact retention could not persist draining state");
            report.artifact_retention_failure = "begin_drain_persistence_failed";
          }
        }
        await writeReport().catch(() => {});
        await close("acceptance_work", async () => { await ownedWork?.catch(() => {}); });
        await close("preparation", async () => { await Promise.allSettled([...preparationWork]); });
        await close("artifact_capacity_monitor", async () => { await capacityWork; });
        await close("runtime", () => runtimeDrain);
        await close("recording", async () => {
          if (recorder) report.interrupted_recording = await recorder.finish({ endedAt: Date.now(), reason: abortReason ?? "outer_failure" });
          // Never respawn offline rendering during cleanup. The scope-aborted
          // original render owns termination through its actual close event.
          if (replayWork) {
            try { report.interrupted_replay = await replayWork; }
            catch { report.interrupted_replay = "render_failed_original_frames_retained"; }
          }
        });
        await close("private_model_evidence", async () => {
          const historyOptions = { deadlineHostMs: cleanupDeadline };
          const errors: unknown[] = [];
          try {
            if (activeRun && evidence) report.interrupted_evidence = await evidence.finalize(activeRun, { status: "interrupted", reason: abortReason ?? "outer_failure" }, historyOptions);
          } catch (error) { errors.push(error); }
          finally {
            // The observer owns a reader independently of Runtime. A failed
            // journal manifest must not bypass its actual child/pipe barrier.
            try { await evidence?.close(historyOptions); }
            catch (error) { errors.push(error); }
          }
          if (errors.length) {
            report.private_model_evidence_failures = errors.map(reason);
            const error = errors.length === 1 ? errors[0] : new AggregateError(errors, "Private model evidence finalization and closure failed");
            failure ??= error;
            throw error;
          }
        });
        await close("auth_without_logout", () => auth?.close());
        await close("sandbox", () => sandboxDrain ?? sandbox?.close());
        await close("native_game", async () => { const result = await (nativeDrain ?? fixture.close()); requireProof(result.closed, "Owned native cleanup was not confirmed"); });
        await close("store", () => store?.close());
        if (activeReservation && !reservationInterrupted) {
          if (studies && studyAttempt) studies.interruptStudyAttempt(studyAttempt, abortReason ?? "sample_interrupted_before_settlement");
          else ledger.interruptAttempt(activeReservation, abortReason ?? "sample_interrupted_before_settlement");
          reservationInterrupted = true;
        }
        if (studies && studyAttempt && cleanup.every(entry => entry.closed) && [...studyRequests.values()].every(request => request.drained)) {
          studies.confirmStudyResourceDrain(studyAttempt, { requests_drained: true, runtime_closed: true, native_closed: true,
            evidence: ["acceptance_owned_work_runtime_auth_recording_native_and_store_joined"] });
        }
        if (retention && artifactRun && artifactDrainRegistered && cleanup.every(entry => entry.closed)) {
          // Reconcile old eligible bundles while this one remains protected as
          // draining. Include rotation in the original final-report deadline;
          // never expire the result we are still publishing.
          try { report.artifact_rotation = retention.rotate(); }
          catch { failure ??= new Error("Artifact rotation failed after resource drain"); }
        }
        if (performance.now() >= cleanupDeadline) report.cleanup_deadline_reached = true;
        report.cleanup_confirmed = !report.cleanup_deadline_reached && !report.report_persistence_failed && cleanup.every(entry => entry.closed);
        report.cleanup_state = report.cleanup_confirmed ? "closed" : "unconfirmed";
        report.failure = failure ? reason(failure) : null;
        report.elapsed_ms = performance.now() - started;
        if (development) {
          report.development_host_admissions = developmentRequests.size;
          report.development_request_ownership = [...developmentRequests].map(([request_id, ownership]) => ({ request_id, ...ownership }));
        }
        if (diagnosticConfig) {
          const history = ledger.listAttempts(diagnosticConfig.hypothesisId);
          if (development) {
            // A single development entry accepts different whole requests.
            // Grouping them by its launcher name would invent task equivalence.
            report.diagnostic_history = history.map(attempt => ({
              attempt_id: attempt.attemptId, model_id: attempt.config.model.id,
              evidence_revision: attempt.platformEvidenceRevision, state: attempt.state,
              scenario_id: attempt.metadata.scenarioId ?? null,
              goal_verified: attempt.settlement?.outcome.goal_verified ?? null,
              outcome: attempt.settlement?.outcome ?? null, usage: attempt.settlement?.usage ?? null,
            }));
            report.cost_scope = "Per-attempt actual usage and complete diagnostic history; no cross-task cost-to-result aggregate";
          } else {
            report.cost_to_result = Object.fromEntries(selected.map(scenario => [scenario.id,
              priorCosts(history.filter(attempt => attempt.metadata.scenarioId === scenario.id))]));
            report.cost_to_result_scope = "All durable attempts for this hypothesis, grouped by declared scenario, including unsuccessful attempts and unknown interrupted usage; model changes do not erase prior costs";
          }
        }
        if (studies && studyAttempt) report.study_usage = summarizeStudyUsage(studies.readStudy({ studyId: studyAttempt.studyId, manifestSha256: studyAttempt.manifestSha256 }));
        await writeReport();
        clearTimeout(cleanupTimer);
        // Persistence is required work too. Its actual settlement can turn an
        // otherwise timely drain into late, unconfirmed cleanup.
        if (performance.now() >= cleanupDeadline) {
          report.cleanup_deadline_reached = true;
          report.cleanup_confirmed = false;
          report.cleanup_state = "unconfirmed";
          report.elapsed_ms = performance.now() - started;
          await writeReport();
        }
        await reportTail;
        if (retention && artifactRun && artifactDrainRegistered && cleanup.every(entry => entry.closed)) {
          try {
            retention.closeRun(artifactRun.id, { drained: true,
              outcome: { status: !failure && !abortReason && caseReports.length === selected.length &&
                  caseReports.every(entry => (entry.outcome as EvaluationOutcome).goal_verified === true) ? "success" : "failure",
                attemptIds: artifactAttemptIds,
                reasons: [...caseReports.flatMap(entry => (entry.outcome as EvaluationOutcome).classification_reason),
                  ...(failure ? [reason(failure)] : abortReason ? [abortReason] : [])],
                evidenceRefs: [path.join(fixture.evidenceDirectory, "report.json"), ...artifactEvidenceRefs] },
              drainEvidence: cleanup.map(entry => `${entry.resource}:closed`) });
          } catch {
            failure ??= new Error("Artifact retention finalization failed after resource drain");
          }
        }
      } finally {
        try { ledger.close(); }
        finally {
          try { studies?.close(); }
          finally { retention?.close(); }
        }
      }
    }
    const finalizationWithinBudget = performance.now() < cleanupDeadline;
    if (!finalizationWithinBudget) failure ??= new Error("Acceptance finalization exceeded its original cleanup deadline");
    return { report_directory: fixture.evidenceDirectory,
      artifact_payload_state: "retained",
      artifact_bundle_id: artifactRun?.id ?? null,
      finalization_within_budget: finalizationWithinBudget,
      outcomes: caseReports.map(entry => entry.outcome),
      platform_complete: !failure && abortReason === null && report.cleanup_confirmed === true &&
        caseReports.length === selected.length && caseReports.every(entry => (entry.outcome as EvaluationOutcome).platform_status === "pass"),
      failure: failure ? reason(failure) : null };
  } finally {
    clearTimeout(timer); clearTimeout(cleanupTimer);
    completed.resolve();
    unregisterCleanup();
  }
}

function compactReport(scenario: NaturalScenario, config: AcceptanceConfig, outcome: EvaluationOutcome,
  summary: EvidenceSummary, evidence: string, nativeHash: string | null, study?: AttemptReservation) {
  const tools = new Map<string, number>();
  for (const tool of summary.tools) tools.set(tool.name, (tools.get(tool.name) ?? 0) + tool.count);
  const common = { schema_version: 1 as const, scenario_id: scenario.id,
    platform_evidence_revision: config.platformEvidenceRevision, model_id: config.model.id, purpose: config.purpose,
    verifier_revision: scenario.verifier.revision, outcome, usage: summary.usage,
    actions: summary.actions, tools: [...tools].map(([name, count]) => ({ name, count })),
    provenance: { tier: "agent-acceptance" as const, source_author: "actual_provider" as const, native_artifact_sha256: nativeHash,
      declaration_artifact: `case-${scenario.id}-declaration.json`, full_evidence_artifact: evidence },
    omissions: ["private_full_evidence", "tool_arguments", "raw_logs_and_frames", "runtime_assets_and_worlds", "unreported_usage", "unattributed_waiting"],
  };
  if (study) return { ...common, study_id: study.studyId, slot: study.slot, reservation_id: study.reservationId };
  requireProof(config.hypothesisId, "Diagnostic compact report requires its actual hypothesis");
  return { ...common, hypothesis_id: config.hypothesisId } satisfies EvaluationCaseReport;
}

export function parseAgentAcceptanceArguments(args: readonly string[]): AgentAcceptanceOptions {
  const options: AcceptanceCommonOptions = { allowNative: false, allowInference: false, authDirectory: "" };
  let hypothesisId = "", platformEvidenceRevision = "", studyId = "", manifestPath = "";
  let slot: StudySlot | undefined;
  const value = (index: number) => { const result = args[index + 1]; if (!result || result.startsWith("--")) throw new Error(`Missing value for ${args[index]}`); return result; };
  const caps: { hostRequestAdmissions?: number; runMs?: number; totalMs?: number } = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    requireProof(flag && !seen.has(flag), "Duplicate acceptance argument");
    seen.add(flag);
    if (flag === "--allow-native") options.allowNative = true;
    else if (flag === "--allow-inference") options.allowInference = true;
    else if (flag === "--single-inference-dispatch") options.singleInferenceDispatch = true;
    else if (flag === "--admission-only") options.admissionOnly = true;
    else if (flag === "--study") studyId = value(index++);
    else if (flag === "--manifest") manifestPath = value(index++);
    else if (flag === "--slot") {
      try { slot = JSON.parse(value(index++)); }
      catch { throw new Error("Provide --slot as a JSON immutable study/arm/initial_state_id/repetition tuple"); }
    }
    else if (flag === "--jar") options.nativeJar = value(index++);
    else if (flag === "--evidence-profile") options.evidenceProfile = value(index++);
    else if (flag === "--auth-dir") options.authDirectory = value(index++);
    else if (flag === "--hypothesis") hypothesisId = value(index++);
    else if (flag === "--evidence-revision") platformEvidenceRevision = value(index++);
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
  if (Object.keys(caps).length) options.caps = caps;
  requireProof(!options.admissionOnly || !options.evidenceProfile, "Admission-only mode forbids evidence profile resource flags");
  if (studyId || manifestPath || slot || options.admissionOnly) {
    requireProof(!options.singleInferenceDispatch, "Single-dispatch inference cannot override a frozen study");
    requireProof(studyId && manifestPath && slot, "Pass a registered --study, matching --manifest and declared JSON --slot");
    requireProof(!hypothesisId && !platformEvidenceRevision, "A study cannot mint or override a diagnostic hypothesis/evidence identity");
    return { ...options, study: { studyId, manifestPath, slot } };
  }
  requireProof(hypothesisId && platformEvidenceRevision, "Pass stable --hypothesis and --evidence-revision values");
  return { ...options, hypothesisId, platformEvidenceRevision };
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
