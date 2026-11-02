import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { NativeFixture, bounded, requireProof } from "../src/evaluation/native-game.ts";
import { createEvaluationCaps } from "../src/evaluation/config.ts";
import { evaluationPaths } from "../src/evaluation/paths.ts";
import { PrivateJournal } from "../src/evaluation/private-journal.ts";
import { assertResidentBenchmarkRootCurrent, checkResidentBenchmarkWorldProperties, closeResidentBenchmarkNativeAfterDrain, residentBenchmarkDecisionPopulation, residentBenchmarkNativeScopeCurrent, residentBenchmarkSummary, settleResidentBenchmarkMeasuredInputs, validateResidentBenchmarkDeclaration, waitResidentBenchmarkUntil } from "../src/evaluation/resident-benchmark.ts";
import { readStudyObservationProfile, StudyLedger, type AttemptReservation, type StudySlot } from "../src/evaluation/studies.ts";
import { assertNativeArtifactFresh, requireTierOptIn } from "../src/evaluation/tiers.ts";
import { canonicalContractJson } from "../src/server/adapter-contract.ts";
import { minecraftControllerFrameSchema, type MinecraftControllerFrame } from "../src/shared/minecraft.ts";
import { decodeNativeVideoHeader } from "../src/shared/video.ts";
import type { ControllerInput, ControllerInputChannel, InputAppliedAck, InputSubmission, RevocationAck } from "../src/shared/controller.ts";
import type { ResidentSnapshot, ResidentWorker } from "../src/shared/resident.ts";
import type { ResidentController } from "../src/server/resident-controller.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { Store, StoredRun } from "../src/server/store.ts";
import type { EpisodeRecorder, RecordingManifest } from "../src/server/recording.ts";

export interface ResidentBenchmarkSlotOptions {
  project: string; manifestPath: string; reservation: AttemptReservation; reportDirectory: string;
}
export interface ResidentBenchmarkSlotResult {
  study_id: string; reservation_id: string; slot: StudySlot;
  platform_status: "pass" | "fail" | "unknown"; cleanup_confirmed: boolean;
  report: string; native_report: string | null; classification: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const inactiveSource = `export function step(frame,state,intent) {
  return {input:{kind:"world",held:{forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false},edges:[],view:{kind:"unchanged"},selected_hotbar:null},next_state:state,status:"running",events:[]};
}\n`;
const card = (purpose: string) => ({ purpose, applicability: "Evaluator-prepared P06 mechanical arena only",
  method: "Actual checked pure step module in the production isolated worker", reason: "Zero-provider platform timing and lifecycle measurement",
  limitations: "Evaluator-authored, not model gameplay, experience, competence or an actor library" });
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
/** One already-reserved, process-isolated real slot. Never reserves or settles ledger authority. */
export async function runResidentBenchmarkSlot(options: ResidentBenchmarkSlotOptions): Promise<ResidentBenchmarkSlotResult> {
  const started = performance.now(), startedAt = new Date().toISOString();
  const project = await realpath(options.project), reportDirectory = path.resolve(options.reportDirectory);
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  requireProof(await realpath(reportDirectory) === reportDirectory, "Slot report directory must not traverse symlinks");
  const artifactPath = (name: string) => {
    const target = path.resolve(reportDirectory, name), relative = path.relative(reportDirectory, target);
    requireProof(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Slot artifact escaped its trusted directory");
    return target;
  };
  const reportPath = artifactPath("slot-report.json");
  const { reservation } = options;
  const classification = "evaluator_authored_zero_provider_resident_platform_not_model_gameplay_or_competence";
  const cleanup = { confirmed: false, runtime_closed: false, resident_worker_closed: false, resident_native_retired: false,
    sandbox_closed: false, store_closed: false, recorder_closed: false, journal_closed: false,
    native_closed: false, deadline_reached: false, errors: [] as string[] };
  const report: Record<string, unknown> = { schema_version: 1, study_id: reservation.studyId, reservation_id: reservation.reservationId,
    slot: reservation.slot, classification, started_at: startedAt, parent_pid: process.ppid, child_pid: process.pid,
    full_window_completed: false, native_fixture_created: false,
    agent_status: "not_run", provider_status: "not_called", actual_provider_calls: 0, usage: null, goal_verified: null,
    cleanup, original_provisional_target: { p95_ms: 50, status: "unmet_in_prior_smokes", prior_actual_p95_ms: [51.95602, 68.406017],
      prior_actual_p99_ms: [52.536315, 68.834093], ruling: "New declared acceptance is capture-to-applied 50/100ms; prior failed results remain separate, not an improvement or competence claim" },
    media: { recording_manifest: null, frames: null, replay: null, playback: "pending_full_original_speed_review" },
    limitations: ["Prepared technical Normal Survival arena, cheats/forceload/no mobs/fixed daylight/supplied bow and arrows, not principal survival.",
      "Fresh independently owned world; no paired-save/seed equivalence claim.", "Native release can fire a bow; neutralization does not reverse effects.",
      "Raw confirmed ACK native-clock joins, not host/native clock subtraction; GUI ACK dwell is not world-frame latency.",
      "ResidentSnapshot retains only its last 512 timing samples; full-window quantiles below use separately retained complete bounded samples.",
      "Full original-speed playback is parent-owned and remains pending, including when offline rendering succeeds."] };
  let fixture: NativeFixture | undefined, sandbox: SandboxService | undefined, store: Store | undefined;
  let recorder: EpisodeRecorder | undefined, journal: PrivateJournal | undefined, resident: ResidentController | undefined;
  let selectedWorker: ResidentWorker | undefined, inactiveWorker: ResidentWorker | undefined;
  let nativeClose: Promise<{ closed: boolean }> | undefined, residentStop: Promise<void> | undefined;
  let controllerWork: Promise<void> | undefined;
  let failure: unknown, finalSnapshot: ResidentSnapshot | null = null, nativeReport: string | null = null;
  let recording: RecordingManifest | undefined, interrupted = false, nativeOpened = false, censored = false;
  let sealedConcatSha256: string | null = null;
  let finalizationStarted = false;
  let warmupStart: number | null = null, measurementStart: number | null = null, measurementEnd: number | null = null;
  const abort = new AbortController(), loadAbort = new AbortController();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const captures = new Map<number, { native_ns: string; captured_host_ms: number; input: ControllerInput; age_recorded: boolean }>();
  const ackRecords: Array<{ received_host_ms: number; captured_host_ms: number | null; captured_native_ns: string | null;
    age_ms: number | null; ack: InputAppliedAck; attribution: string }> = [];
  const stepRecords: Array<{ started_host_ms: number; ended_host_ms: number; captured_host_ms: number; frame_seq: number; native_tick: number;
    captured_native_ns: string; active_use: MinecraftControllerFrame["player"]["active_use"]; last_input: MinecraftControllerFrame["last_input"];
    status: string | null; failure: string | null }> = [];
  const submissionRecords: Array<{ host_ms: number; captured_host_ms: number; frame_seq: number; captured_native_ns: string; result: InputSubmission }> = [];
  const historyRecords: Array<Record<string, unknown>> = [], diagnosticRecords: Array<Record<string, unknown>> = [];
  const retirements: Array<{ requested_host_ms: number; received_host_ms: number; ack: RevocationAck }> = [];
  let lastSampleHost = 0, lastSampleNative: string | null = null;
  const note = (kind: string, value: unknown) => {
    if (journal && !journal.append(kind, value)) stop("Private journal refused a bounded evidence record");
  };
  const stop = (reason: unknown) => {
    failure ??= reason instanceof Error ? reason : new Error(String(reason));
    if (!abort.signal.aborted) abort.abort(failure);
    if (!loadAbort.signal.aborted) loadAbort.abort(failure);
    if (resident) {
      residentStop ??= resident.stop("benchmark_scope_closed");
      void residentStop.catch(error => { cleanup.errors.push(message(error)); });
    }
    if (fixture) {
      const owned = fixture;
      nativeClose ??= closeResidentBenchmarkNativeAfterDrain(residentStop, () => owned.close());
      void nativeClose.catch(error => { cleanup.errors.push(message(error)); });
    }
  };
  const onSignal = (signal: string) => {
    interrupted = true;
    stop(`Slot interrupted by ${signal}`);
  };
  const sigint = () => onSignal("SIGINT"), sigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", sigint); process.on("SIGTERM", sigterm);
  // Admission/setup/work cannot consume the 25-second actual owner-cleanup reserve.
  let wallDeadline = started + 240_000, workDeadline = wallDeadline - 25_000;
  const workDeadlineReached = () => stop("Slot work wall bound reached; actual cleanup reserve begins");
  const parentWorkCutoff = (value: unknown) => {
    if (value !== null && typeof value === "object" && "type" in value && value.type === "resident_benchmark_work_cutoff" &&
      "version" in value && value.version === 1 && !finalizationStarted) workDeadlineReached();
  };
  process.on("message", parentWorkCutoff);
  let workTimer = setTimeout(workDeadlineReached, Math.max(1, workDeadline - performance.now()));
  const remaining = () => {
    abort.signal.throwIfAborted();
    const ms = workDeadline - performance.now(); requireProof(ms > 0, "Slot work exhausted the original wall allowance"); return ms;
  };
  const workBound = async <T>(promise: Promise<T>, label: string) => {
    try { const value = await bounded(promise, remaining(), label); abort.signal.throwIfAborted(); return value; }
    catch (error) { stop(error); throw error; }
  };
  let reasoningTask: Promise<void> | undefined, inactiveTask: Promise<void> | undefined, historyTask: Promise<void> | undefined;
  try {
    requireTierOptIn("native-game", { allowNative: process.argv.includes("--allow-native") });
    requireProof(process.env.GAMEHARNESS_NATIVE_PROOF === "1", "Fresh explicitly opted-in native child required");
    const declaration = validateResidentBenchmarkDeclaration(JSON.parse(await readFile(path.resolve(project, options.manifestPath), "utf8")), { projectRoot: project });
    const { manifest, protocol, source, cells } = declaration;
    const paths = evaluationPaths(project, { runtimeRoot: artifactPath("native-runtime") });
    const { ref, row, cell, registeredAt } = (() => {
      const ledger = new StudyLedger(paths.governanceRoot, { projectRoot: project });
      try {
        // Read-only checks; never close parent admissions. Retain detached data only.
        const ref = ledger.getStudyRef(reservation.studyId);
        requireProof(canonicalContractJson(ref) === canonicalContractJson({ studyId: reservation.studyId, manifestSha256: reservation.manifestSha256 }), "Slot registered manifest reference changed");
        const state = ledger.readStudy(ref);
        requireProof(state.closure === null && canonicalContractJson(state.manifest) === canonicalContractJson(manifest), "Slot study is closed or manifest differs from its immutable registration");
        const row = state.attempts.find(value => value.reservationId === reservation.reservationId);
        requireProof(row && row.state === "reserved" && row.ownerPid === process.ppid && row.settlement === null && row.interruption === null &&
          !row.cleanup.confirmed && row.cleanup.evidence.length === 0 && row.requests.length === 0 &&
          canonicalContractJson(row.slot) === canonicalContractJson(reservation.slot), "Slot is not the actual current parent-owned zero-provider reserved row");
        requireProof(state.attempts.filter(value => value.state === "reserved" || !value.cleanup.confirmed).length === 1, "Another reserved or undrained study owner remains allocated");
        const matching = manifest.schedule.filter(value => canonicalContractJson(value.slot) === canonicalContractJson(reservation.slot));
        requireProof(matching.length === 1, "Reservation must identify exactly one declared schedule cell");
        const cell = cells[matching[0]!.order]; requireProof(cell, "Schedule cell is absent");
        return structuredClone({ ref, row, cell, registeredAt: state.registeredAt });
      } finally { ledger.close(); }
    })();
    requireProof(Date.now() < row.reservedAt + manifest.allowances.per_attempt.wall_ms, "Parent reservation wall allowance already elapsed");
    const deadlineEpochMs = Number(process.env.GAMEHARNESS_BENCHMARK_DEADLINE_EPOCH_MS);
    requireProof(Number.isSafeInteger(deadlineEpochMs) && deadlineEpochMs === Math.min(
      row.reservedAt + manifest.allowances.per_attempt.wall_ms, registeredAt + manifest.allowances.cohort.elapsed_ms),
      "Child absolute deadline differs from the original reservation/cohort wall");
    wallDeadline = Math.min(wallDeadline, performance.now() + deadlineEpochMs - Date.now());
    workDeadline = wallDeadline - 25_000;
    clearTimeout(workTimer);
    workTimer = setTimeout(workDeadlineReached, Math.max(1, workDeadline - performance.now()));
    remaining();
    const artifact = assertNativeArtifactFresh(project, manifest.identities.build.path);
    requireProof(artifact.sha256 === manifest.identities.build.sha256 && process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 === artifact.sha256,
      "Selected JAR, current fresh build, immutable manifest and parent launch pin differ");
    const descriptor = readStudyObservationProfile(manifest, project);
    report.identities = { manifest_sha256: ref.manifestSha256, source: manifest.identities.source, build: manifest.identities.build,
      dependencies: manifest.identities.dependencies, profile: manifest.identities.profile, controller: manifest.identities.controller,
      protocol_file: manifest.task.verifier, original_source_sha256: digest(source), original_source: source,
      nativehello: 4, action_protocol: 4, controller_frame: 2, profile_version: 4, video: "GHV2", executable_abi: 5 };
    report.protocol = protocol; report.cell = cell; report.ledger = { reserved_at: row.reservedAt, owner_pid: row.ownerPid, requests: row.requests };
    report.deadlines = { original_deadline_epoch_ms: deadlineEpochMs, work_deadline_host_ms: workDeadline,
      total_deadline_host_ms: wallDeadline, cleanup_reserve_ms: 25_000, authority: "Parent reservation/cohort absolute wall; no post-signal extension" };
    fixture = await NativeFixture.create("native-resident-benchmark", { projectRoot: project, paths,
      caps: createEvaluationCaps({ runMs: protocol.root_ms, totalMs: 240_000, cleanupMs: 25_000 }) });
    report.native_fixture_created = true;
    nativeReport = path.join(fixture.evidenceDirectory, "report.json");
    report.native_report = nativeReport;
    // Production config-bound modules are loaded only after the fresh fixture sets process-fixed paths.
    const [{ Store }, { SandboxService }, { ResidentController }, { EpisodeRecorder }, { validateSkill },
      { minecraftSchemaCatalog }, { HOST_MONOTONIC_CLOCK_ID }, { emptyRunUsage }, { programEvidence }, { ActionArbiter }] = await Promise.all([
      import("../src/server/store.ts"), import("../src/server/sandbox.ts"), import("../src/server/resident-controller.ts"),
      import("../src/server/recording.ts"), import("../src/server/program-validation.ts"), import("../src/server/native-contract.ts"),
      import("../src/server/performance.ts"), import("../src/server/usage.ts"), import("../src/server/program-evidence.ts"), import("../src/server/action-arbiter.ts"),
    ]);
    await workBound(fixture.start(), "Actual native startup exhausted slot allowance");
    const nativeEvaluation = fixture.ownedClient().session.evaluation;
    requireProof(nativeEvaluation === null, "E01 requires an actual default-mode native session");
    report.native_evaluation = nativeEvaluation;
    const ownedWorld = fixture.server.snapshot().world_id;
    requireProof(ownedWorld && path.basename(ownedWorld) === ownedWorld, "Actual owned server world identity is invalid");
    const selectedState = manifest.initial_states.find(state => state.id === reservation.slot.initial_state_id)!;
    const actualProperties = checkResidentBenchmarkWorldProperties(await workBound(
      readFile(path.join(fixture.root, "minecraft/worlds", ownedWorld, "server.properties"), "utf8"),
      "Actual owned world properties could not be checked before task admission"));
    report.world_settings = { declared: selectedState.settings, actual_safe_properties: actualProperties, world_id: ownedWorld,
      fresh_owned_fixture: true, arena: "25x25 evaluator preparation within the verified normal world; not a flat generator",
      excluded_properties: "Seed, RCON and all non-whitelisted server settings are neither retained here nor passed to step" };
    const binding = fixture.bridge.snapshot().binding, actualDescriptor = fixture.bridge.adapter()?.descriptor;
    requireProof(binding?.ready && actualDescriptor && canonicalContractJson(actualDescriptor) === canonicalContractJson(descriptor), "Actual native binding differs from checked materialized profile/descriptor");
    const packet = fixture.bridge.latestFrame(); requireProof(packet && decodeNativeVideoHeader(packet), "Actual GHV2 capture not negotiated");
    report.binding = binding; report.descriptor = actualDescriptor; report.host_clock_id = HOST_MONOTONIC_CLOCK_ID;
    await workBound(fixture.flat(), "Actual declared arena setup exhausted slot allowance");
    await workBound(fixture.console(["difficulty normal", "gamemode survival @a", "clear @a", "kill @e[type=minecraft:arrow]",
      "item replace entity @a hotbar.0 with minecraft:bow", "give @a minecraft:arrow 64"]), "Actual bow setup exhausted slot allowance");
    report.setup_observation = await workBound(fixture.observe(), "Prepared own-body read timed out");
    const current = fixture.bridge.snapshot();
    requireProof(current.world_id && current.session_id && current.space && current.life?.status === "alive" && current.binding?.ready,
      "Prepared native world lacks live current authority");
    const rootState = { world_id: current.world_id, session_id: current.session_id, native_boot_id: current.binding.native_boot_id,
      epoch: current.epoch, life_id: current.life.life_id, space_epoch: current.space.space_epoch };
    store = new Store(artifactPath("inactive-history-store")); sandbox = new SandboxService(project);
    const run: StoredRun = { run_id: randomUUID(), ...rootState, compatibility_hash: current.binding.compatibility_hash,
      task: "P06 evaluator-only inactive publication/history load; zero-provider; never a playing root",
      goal: { adapter_id: actualDescriptor.adapter.id, goal_id: "custom", parameters: {}, verifier: null },
      model_id: "zero-provider-evaluator-history-not-a-model", status: "stopped", started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      turns: 0, model_status: "idle", error: null, usage: emptyRunUsage(), baseline: {} };
    store.saveRun(run);
    journal = new PrivateJournal(artifactPath("journal"), run.run_id, (_id, reason) => stop(reason), protocol.journal);
    note("identity", { manifest_sha256: ref.manifestSha256, binding, descriptor: actualDescriptor, source, authorship: "evaluator", host_clock_id: HOST_MONOTONIC_CLOCK_ID });
    const seedStart = performance.now();
    // Initial nonplaying corpus, not ongoing gameplay logging. One durable commit
    // avoids thousands of setup fsyncs starving the live native transport.
    remaining();
    store.appendEvents(run.run_id, Array.from({ length: protocol.history_records }, (_, index) => ({
      type: "benchmark.evaluator_history", summary: "Nonplaying evaluator-only history load", details: { index },
    })));
    remaining();
    report.history_seed = { records: protocol.history_records, method: "atomic_Store_batch_FULL_durable_commit_before_warmup",
      started_host_ms: seedStart, ended_host_ms: performance.now(), elapsed_ms: performance.now() - seedStart };
    await workBound(sandbox.prepare(), "Actual production sandbox preparation exhausted slot allowance");
    requireProof(sandbox.snapshot().status === "ready", "Actual Docker guardian/worker unavailable"); report.sandbox = sandbox.snapshot();
    const contract = { descriptor: actualDescriptor, schemas: minecraftSchemaCatalog() };
    const selected = await workBound(validateSkill({ entry: "step", name: "P06 evaluator selected mechanical source", source,
      card: card("Selected immutable evaluator mechanical resident"), dependencies: [] }, contract), "Selected source validation exhausted slot allowance");
    const canonicalHash = digest(selected.source);
    report.selected_source = { ...selected, original_sha256: digest(source), canonical_sha256: canonicalHash };
    note("selected_source", report.selected_source);
    recorder = new EpisodeRecorder({ directory: artifactPath("recording"), bridge: fixture.bridge,
      identity: { episode_id: randomUUID(), run_id: run.run_id, world_id: current.world_id, session_id: current.session_id },
      limits: protocol.recording, onIncomplete: reason => stop(`Recording incomplete: ${reason}`) });
    report.media = { recording_manifest: artifactPath("recording/recording-manifest.json"), frames: artifactPath("recording/frames.jsonl"),
      replay: null, playback: "pending_full_original_speed_review" };
    const authorityCommands = fixture.commands.length;
    const rootAdmission = performance.now(), rootDeadline = rootAdmission + protocol.root_ms;
    report.root_admitted_host_ms = rootAdmission; report.original_root_deadline_host_ms = rootDeadline;
    await workBound(fixture.withControllerContext(canonicalHash, rootDeadline, context => {
      controllerWork = (async () => {
      note("root_context", context);
      const compileStart = performance.now();
      report.selected_compile = { started_host_ms: compileStart, status: "compiling" };
      try { selectedWorker = await workBound(sandbox!.createResidentWorker(selected.source, protocol.step_ms, abort.signal), "Selected real worker compile exhausted root/slot allowance"); }
      catch (error) {
        report.selected_compile = { started_host_ms: compileStart, ended_host_ms: performance.now(), elapsed_ms: performance.now() - compileStart,
          status: "failed_or_interrupted", failure: message(error) };
        throw error;
      }
      const compileEnd = performance.now(); report.selected_compile = { started_host_ms: compileStart, ended_host_ms: compileEnd, elapsed_ms: compileEnd - compileStart, status: "ready" };
      requireProof(compileEnd + protocol.warmup_ms + protocol.measurement_ms < context.deadline_host_ms, "Actual initial compilation leaves insufficient original root lifetime for the full warmup and measurement");
      const rawWorker = selectedWorker;
      const tracedWorker: ResidentWorker = {
        step: async (frame, state, intent, signal) => {
          requireProof(stepRecords.length < 4000, "Complete worker timing capacity exhausted");
          note("permitted_controller_frame", frame); note("authored_step_input", { frame_seq: frame.frame_seq, state, intent });
          const record = { started_host_ms: performance.now(), ended_host_ms: 0, captured_host_ms: lastSampleHost,
            frame_seq: frame.frame_seq, native_tick: frame.native_tick,
            captured_native_ns: frame.captured_native_ns, active_use: frame.player.active_use, last_input: frame.last_input, status: null as string | null, failure: null as string | null };
          stepRecords.push(record);
          try { const result = await rawWorker.step(frame, state, intent, signal); record.status = result.status; note("authored_step_result", { frame_seq: frame.frame_seq, result }); return result; }
          catch (error) { record.failure = message(error); throw error; }
          finally { record.ended_host_ms = performance.now(); note("step_timing", record); }
        },
        close: async () => { note("selected_worker_close_requested", {}); await rawWorker.close(); cleanup.resident_worker_closed = true; note("selected_worker_closed", {}); },
      };
      const captureAck = (ack: InputAppliedAck) => {
        requireProof(ackRecords.length < 8000, "Full raw ACK evidence capacity exhausted");
        const captured = captures.get(ack.sequence), received = performance.now();
        let age: number | null = null, attribution = captured ? ack.input_application : "unknown_capture";
        if (captured && ack.input_application === "confirmed" && !captured.age_recorded) {
          const nanos = BigInt(ack.applied_native_ns) - BigInt(captured.native_ns);
          requireProof(nanos >= 0n, "Actual native ACK preceded its submitted capture");
          age = Number(nanos) / 1e6; captured.age_recorded = true;
        } else if (captured?.age_recorded) attribution = "duplicate_application";
        const record = { received_host_ms: received, captured_host_ms: captured?.captured_host_ms ?? null,
          captured_native_ns: captured?.native_ns ?? null, age_ms: age, ack, attribution };
        ackRecords.push(record); note("raw_native_application_ack", record);
        for (const [sequence] of captures) if (sequence < ack.sequence) captures.delete(sequence);
      };
      resident = new ResidentController({ execution_id: context.execution_id, source_hash: canonicalHash,
        controller_generation: context.controller_generation, deadline_host_ms: context.deadline_host_ms,
        limits: { duration_ms: protocol.root_ms, frequency_hz: cell.frequency_hz, step_ms: protocol.step_ms,
          max_steps: 4000, max_frames: 4000, max_edges: 8, max_edges_per_second: 8, max_events: 0,
          max_analysis_jobs: 0, analysis_job_ms: 500, max_analysis_ms: 0 },
        initial_state: { started: false, count: 0, last_use: null }, intent: null, worker: tracedWorker,
        clock: { id: HOST_MONOTONIC_CLOCK_ID, now: () => performance.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout) },
        current: () => !abort.signal.aborted,
        open: async (deadline, applied, effect, lifecycle) => {
          requireProof(deadline === context.deadline_host_ms, "Original root deadline was replaced");
          const channel = await context.open(ack => { try { captureAck(ack); } catch (error) { stop(error); } applied(ack); },
            update => { note("raw_native_effect_update", update); effect(update); }, lifecycle);
          nativeOpened = true;
          note("actual_native_owner", { owner: channel.owner, controller_generation: channel.controllerGeneration, deadline_host_ms: deadline, compile_ready_host_ms: compileEnd });
          const wrapper: ControllerInputChannel = {
            get owner() { return channel.owner; }, get controllerGeneration() { return channel.controllerGeneration; },
            sample: async cursor => {
              const value = await channel.sample(cursor), frame = minecraftControllerFrameSchema.parse(value);
              lastSampleHost = performance.now(); lastSampleNative = frame.captured_native_ns;
              return value;
            },
            submit: (wire, input) => {
              const frame = minecraftControllerFrameSchema.parse(wire);
              requireProof(lastSampleNative === frame.captured_native_ns && captures.size < 512, "Passive attribution capture identity/capacity mismatch");
              requireProof(submissionRecords.length < 4000, "Full submitted/coalesced/refused evidence capacity exhausted");
              const result = channel.submit(wire, input);
              submissionRecords.push({ host_ms: performance.now(), captured_host_ms: lastSampleHost,
                frame_seq: frame.frame_seq, captured_native_ns: frame.captured_native_ns, result });
              note("actual_native_submission", { frame_seq: frame.frame_seq, captured_native_ns: frame.captured_native_ns, input, result });
              if (result.status !== "rejected") {
                if (result.status === "coalesced") { note("coalesced_capture", { sequence: result.sequence - 1, capture: captures.get(result.sequence - 1) }); captures.delete(result.sequence - 1); }
                captures.set(result.sequence, { native_ns: frame.captured_native_ns, captured_host_ms: lastSampleHost, input, age_recorded: false });
              }
              return result;
            },
            renew: async frame => { requireProof(frame !== null, "Benchmark cannot perform unconditional native lease renewal"); await channel.renew(frame); },
            revoke: async () => { const requested = performance.now(); const ack = await channel.revoke();
              const value = { requested_host_ms: requested, received_host_ms: performance.now(), ack }; retirements.push(value); note("actual_native_retirement", value); return ack; },
            snapshot: () => channel.snapshot(),
          };
          return wrapper;
        },
        event: event => note("resident_event", event), effect: (input, event) => note("actual_native_effect", { input, event }),
        changed: (snapshot, terminal) => { finalSnapshot = snapshot; note("resident_phase", { terminal, snapshot }); },
        // Declared zero analysis jobs: this capability is unreachable and must not invent an analysis result.
        analysis: async () => { throw new Error("Benchmark declares no analysis jobs"); },
      });
      await workBound(resident.start(), "Actual resident admission exhausted slot allowance");
      requireProof(resident.snapshot().status === "running", "Selected resident never became running");
      warmupStart = performance.now(); report.warmup_started_host_ms = warmupStart; note("warmup_started", { host_ms: warmupStart });
      // Read-only evaluator diagnostics: never passed to authored step, never renew, and never submit.
      const probeStart = warmupStart; let heldFrame: MinecraftControllerFrame | null = null, neutralFrame: MinecraftControllerFrame | null = null;
      for (let index = 0; index < 15; index++) {
        await waitResidentBenchmarkUntil(probeStart + index * 100, abort.signal);
        const frame = minecraftControllerFrameSchema.parse(await workBound(fixture!.bridge.queryCapability("minecraft.controller_frame", 2, { audio_cursor: null }), "Read-only initial controller diagnostic timed out"));
        const diagnostics = await workBound(fixture!.diagnostics(), "Actual initial native neutralization diagnostic timed out");
        const received = performance.now();
        const witness = { requested_host_ms: probeStart + index * 100, received_host_ms: received, frame, diagnostics };
        diagnosticRecords.push(witness); note("evaluator_only_initial_diagnostic_not_worker_input", witness);
        if (!heldFrame && frame.last_input?.held.use && frame.last_input.input_application === "confirmed" && frame.player.active_use?.item === "bow" && !diagnostics.controls_neutral) heldFrame = frame;
        const snapshot = resident.snapshot();
        if (cell.frequency_hz < 20 && heldFrame && !neutralFrame && frame.native_tick > heldFrame.native_tick &&
          frame.player.active_use === null && diagnostics.controls_neutral && !diagnostics.motor_active &&
          BigInt(frame.captured_native_ns) - BigInt(heldFrame.captured_native_ns) >= 150_000_000n) {
          requireProof(snapshot.status === "running" && snapshot.reason === null && stepRecords.every(value => value.failure === null),
            "An unrelated worker/authority failure preceded the alleged lower-rate expiry");
          requireProof(frame.life_id === rootState.life_id && frame.space.space_epoch === rootState.space_epoch && frame.player.health > 0,
            "Scope/death change is not a lower-rate expiry");
          requireProof(frame.screen === null && diagnostics.screen_type === null && fixture!.bridge.snapshot().error === null,
            "GUI/transport intervention is not a lower-rate expiry");
          neutralFrame = frame;
          if (cell.frequency_hz === 1) requireProof(received - warmupStart < 1000 && snapshot.counters.steps === 1,
            "1Hz expiry was not actually witnessed before the next decision slot");
          censored = true; report.censor_started_host_ms = received;
          residentStop = resident.stop("benchmark_observed_lower_rate_native_neutralization");
          await workBound(residentStop, "Observed lower-rate resident did not actually retire");
          const ack = retirements.at(-1)?.ack;
          requireProof(ack && BigInt(ack.retirement_applied_native_ns) <= BigInt(frame.captured_native_ns),
            "Lower-rate native retirement was not already applied before evaluator Stop; cannot attribute neutralization to expiry");
          report.lower_rate_expiry = { witnessed: true, continuity_claim: false, held_frame: heldFrame, neutral_frame: neutralFrame,
            before_next_1hz_slot: cell.frequency_hz === 1, retirement: ack,
            reason_provenance: "Observed prior native retirement, responsive neutral body and keys without host revoke/renew/regrant; lease explanation follows the checked 250ms native lease mechanism, not an exposed reason field" };
        }
        if (!censored) requireProof(snapshot.status === "running", `Unrelated resident stopped during warmup: ${snapshot.status}/${snapshot.reason}`);
      }
      report.initial_diagnostics = { samples: diagnosticRecords.length, held_witness: heldFrame !== null, neutral_witness: neutralFrame !== null, excluded_from_measurement: true };
      if (cell.frequency_hz === 1) requireProof(censored && heldFrame && neutralFrame, "1Hz expected expiry was not actually witnessed; no assumed expiry success");
      requireProof(heldFrame !== null, "Actual initial held vanilla bow use was not witnessed");
      await waitResidentBenchmarkUntil(warmupStart + protocol.warmup_ms, abort.signal);
      requireProof(performance.now() >= warmupStart + protocol.warmup_ms, "Original 30-second warmup was shortened");
      if (!censored) requireProof(resident.snapshot().status === "running", `Resident stopped before measurement: ${resident.snapshot().reason}`);
      measurementStart = performance.now(); measurementEnd = measurementStart + protocol.measurement_ms;
      report.measurement_started_host_ms = measurementStart; report.measurement_deadline_host_ms = measurementEnd;
      report.resident_at_measurement_start = resident.snapshot();
      histogram.reset(); histogram.enable();
      report.native_diagnostics_before_measurement = { scope: "producer_global_cumulative_at_boundary_not_window_mean", value: await workBound(fixture!.diagnostics(), "Measurement-boundary diagnostics failed") };
      note("measurement_started", { host_ms: measurementStart, censored });
      const reasoningStart = performance.now(); report.synthetic_reasoning = { requested_ms: cell.delay_ms, started_host_ms: reasoningStart, actual_provider_calls: 0, status: "waiting" };
      reasoningTask = waitResidentBenchmarkUntil(reasoningStart + cell.delay_ms, abort.signal).then(() => {
        report.synthetic_reasoning = { requested_ms: cell.delay_ms, started_host_ms: reasoningStart, ended_host_ms: performance.now(), elapsed_ms: performance.now() - reasoningStart, actual_provider_calls: 0, status: "completed" };
        note("synthetic_reasoning_finished", report.synthetic_reasoning);
      }).catch(error => {
        report.synthetic_reasoning = { requested_ms: cell.delay_ms, started_host_ms: reasoningStart, ended_host_ms: performance.now(),
          elapsed_ms: performance.now() - reasoningStart, actual_provider_calls: 0, status: "interrupted", failure: message(error) };
        note("synthetic_reasoning_interrupted", report.synthetic_reasoning);
        throw error;
      });
      inactiveTask = (async () => {
        const began = performance.now();
        report.inactive_compile = { started_host_ms: began, status: "validating" };
        report.inactive_original_source = { source: inactiveSource, sha256: digest(inactiveSource) };
        try {
        const validated = await validateSkill({ entry: "step", name: "P06 evaluator inactive candidate", source: inactiveSource,
          card: card("Nonplaying source publication/compile during synthetic reasoning"), dependencies: [] }, contract);
        abort.signal.throwIfAborted();
        const registered = await store!.registerSkill(run.run_id, validated, undefined, () => abort.signal.throwIfAborted());
        report.inactive_candidate = { ...registered, original_source: inactiveSource, original_sha256: digest(inactiveSource), canonical_sha256: digest(registered.source),
          started_host_ms: began, registered_host_ms: performance.now(), playing_execution: false, steps_invoked: 0, native_admissions: 0 };
        note("inactive_published_source", report.inactive_candidate);
        report.inactive_compile = { started_host_ms: began, status: "compiling", canonical_sha256: registered.hash };
        inactiveWorker = await sandbox!.createResidentWorker(registered.source, protocol.step_ms, abort.signal);
        const ready = performance.now();
        await inactiveWorker.close(); inactiveWorker = undefined;
        const ended = performance.now();
        report.inactive_compile = { started_host_ms: began, ready_host_ms: ready, closed_host_ms: ended, elapsed_ms: ended - began,
          completed_during_reasoning: ended <= reasoningStart + cell.delay_ms, steps_invoked: 0, native_admissions: 0, status: "compiled_and_closed" };
        note("inactive_compile_closed", report.inactive_compile);
        requireProof(ended <= reasoningStart + cell.delay_ms, "Actual inactive validation/publication/compile did not complete during the original synthetic wait");
        } catch (error) {
          report.inactive_compile = { ...(report.inactive_compile as object), status: "failed_or_interrupted",
            ended_host_ms: performance.now(), elapsed_ms: performance.now() - began, failure: message(error) };
          note("inactive_compile_failed", report.inactive_compile);
          throw error;
        }
      })();
      historyTask = (async () => {
        for (let index = 0; index * protocol.history_interval_ms < protocol.measurement_ms; index++) {
          const scheduled = measurementStart! + index * protocol.history_interval_ms;
          await waitResidentBenchmarkUntil(scheduled, loadAbort.signal);
          requireProof(historyRecords.length < 64, "Finite real history-load record capacity exhausted");
          const began = performance.now(); let count = 0, cursor = 0, error: string | null = null;
          try {
            for (let page = 0; page < 10; page++) {
              const rows = store!.eventsAfter(run.run_id, cursor, 500); count += rows.length;
              if (rows.length < 500) break; cursor = rows.at(-1)!.event_seq;
              requireProof(page < 9, "Real inactive Store history exceeded finite load page capacity");
            }
            requireProof(count >= protocol.history_records, "History load read fewer than the original 4096 evaluator records");
            const evidence = programEvidence(store!, run.run_id); const programs = store!.skills(run.run_id);
            note("history_program_evidence", { events: count, program_evidence: evidence, programs });
          } catch (cause) { error = message(cause); }
          const record = { index, scheduled_host_ms: scheduled, started_host_ms: began, ended_host_ms: performance.now(),
            duration_ms: performance.now() - began, queue_delay_ms: began - scheduled, events_read: count, error };
          historyRecords.push(record); note("actual_store_history_load", record);
          if (error) throw new Error(error);
        }
      })();
      // Attach rejection handlers immediately; failures fence real authority rather than become a detached rejected load.
      for (const task of [reasoningTask, inactiveTask, historyTask]) void task.catch(error => { if (!loadAbort.signal.aborted) stop(error); });
      while (performance.now() < measurementEnd) {
        await waitResidentBenchmarkUntil(Math.min(measurementEnd, performance.now() + 100), abort.signal);
        if (!censored) {
          const snapshot = resident.snapshot();
          requireProof(snapshot.status === "running" && snapshot.reason === null, `Actual resident failed/stopped during measurement: ${snapshot.status}/${snapshot.reason}`);
        }
        const stateNow = fixture!.bridge.snapshot();
        requireProof(residentBenchmarkNativeScopeCurrent(stateNow, rootState),
          "Native authority/scope became unsafe during the retained measurement window");
      }
      report.measurement_ended_host_ms = performance.now(); histogram.disable();
      report.resident_at_measurement_end = resident.snapshot();
      requireProof(performance.now() - measurementStart >= protocol.measurement_ms, "Original 120-second measurement was shortened");
      await workBound(Promise.all([reasoningTask, inactiveTask, historyTask]), "Original synthetic wait/compile/history did not finish");
      note("measurement_ended", { host_ms: performance.now(), censored });
      report.native_diagnostics_after_measurement = { scope: "producer_global_cumulative_at_boundary_not_window_mean", value: await workBound(fixture!.diagnostics(), "Final native producer diagnostics failed") };
      report.native_performance_after_measurement = { scope: "retained_production_timeline_and_producer_globals_not_full_window_quantiles",
        value: fixture!.bridge.performanceMetrics() };
      if (!censored) {
        const began = performance.now();
        const frontierAuthority = { signal: abort.signal, deadline_host_ms: Math.min(context.deadline_host_ms, workDeadline),
          current: () => resident!.snapshot().status === "running" &&
            residentBenchmarkNativeScopeCurrent(fixture!.bridge.snapshot(), rootState) };
        const settled = await workBound(settleResidentBenchmarkMeasuredInputs(
          () => residentBenchmarkDecisionPopulation({ start: measurementStart!, end: measurementEnd!,
            submissions: submissionRecords, frames: stepRecords, acks: ackRecords, terminalReason: resident!.snapshot().reason }),
          frontierAuthority),
        "Original measured inputs did not settle before the original work/root deadline");
        report.measured_frontier_settlement = { started_host_ms: began, ended_host_ms: performance.now(),
          original_measurement_deadline_host_ms: measurementEnd, original_root_deadline_host_ms: context.deadline_host_ms,
          admitted_decisions: settled.admitted_decisions, confirmed_decisions: settled.confirmed_decisions,
          confirmed_after_window: settled.confirmed_after_window, extended_measurement: false };
        note("measured_frontier_settled_before_planned_stop", report.measured_frontier_settlement);
        report.resident_before_stop = resident.snapshot();
        assertResidentBenchmarkRootCurrent(frontierAuthority);
        residentStop = resident.stop("benchmark_full_original_window_completed");
        await workBound(residentStop, "Real selected resident worker/native retirement did not drain");
      }
      finalSnapshot = resident.snapshot();
      cleanup.resident_worker_closed = finalSnapshot.cleanup.worker === "closed";
      cleanup.resident_native_retired = finalSnapshot.cleanup.native === "retired";
      requireProof(cleanup.resident_worker_closed && cleanup.resident_native_retired && !ActionArbiter.current(fixture!.bridge)?.busy,
        "Actual resident/native arbiter drain remains unknown");
      requireProof(retirements.length > 0, "Actual native retirement acknowledgment was not retained");
      report.retirement_effect_uncertainty = {
        unresolved_operation_refs: retirements.flatMap(value => value.ack.unresolved_operation_refs),
        input_retirement: "confirmed_separately_from_prior_world_effects",
        release_consequence: "Ordinary bow release can fire an arrow; retirement does not confirm or reverse that world effect",
      };
      requireProof(fixture!.commands.length === authorityCommands + 1, "Privileged effect intervention occurred after root admission");
      report.final_responsive_frame = minecraftControllerFrameSchema.parse(await workBound(fixture!.bridge.queryCapability("minecraft.controller_frame", 2, { audio_cursor: null }), "Final responsive own-body read failed"));
      const finalFrame = report.final_responsive_frame as MinecraftControllerFrame;
      const finalDiagnostics = await workBound(fixture!.diagnostics(), "Final actual neutral native diagnostics failed");
      report.final_neutral_diagnostics = finalDiagnostics;
      requireProof(finalDiagnostics.controls_neutral && !finalDiagnostics.motor_active && finalFrame.player.active_use === null && finalFrame.player.health > 0,
        "Actual final native state is not neutral, healthy and responsive after drain");
      report.final_authoritative_observation = await workBound(fixture!.observe(), "Final post-drain authoritative own-body observation failed");
      })();
      return controllerWork;
    }), "Original admitted root did not complete within slot work allowance");
    report.full_window_completed = true;
    requireProof(measurementStart !== null && measurementEnd !== null && warmupStart !== null, "Original measurement boundaries absent");
    const population = residentBenchmarkDecisionPopulation({ start: measurementStart, end: measurementEnd,
      submissions: submissionRecords, frames: stepRecords, acks: ackRecords,
      terminalReason: (finalSnapshot as ResidentSnapshot | null)?.reason ?? null });
    const ageSummary = population.input_age_ms;
    const ages = population.decisions.flatMap(value => value.age_ms === null ? [] : [value.age_ms]);
    const applied = ackRecords.filter(value => value.ack.input_application === "confirmed" && value.age_ms !== null &&
      value.received_host_ms >= measurementStart! && value.received_host_ms <= measurementEnd!);
    const gaps: number[] = [];
    // Include the actual previous warmup application to expose the first measurement inter-ACK gap.
    let previous = ackRecords.filter(value => value.received_host_ms < measurementStart! && value.age_ms !== null).at(-1);
    for (const record of applied) {
      if (previous) { const delta = BigInt(record.ack.applied_native_ns) - BigInt(previous.ack.applied_native_ns);
        requireProof(delta >= 0n, "Nonmonotonic actual native application time"); gaps.push(Number(delta) / 1e6); }
      previous = record;
    }
    const measuredSteps = stepRecords.filter(value => value.started_host_ms >= measurementStart! && value.started_host_ms < measurementEnd!);
    const gapSummary = residentBenchmarkSummary(gaps);
    const countersAtStart = (report.resident_at_measurement_start as ResidentSnapshot).counters;
    const countersAtEnd = (report.resident_at_measurement_end as ResidentSnapshot).counters;
    report.measurement = { window_definition: "Decision population: permitted frame receipt in [measurement_start,measurement_deadline); confirmed application ACKs joined after actual resident/native drain, including post-window receipts. Native-native age subtraction only.",
      gap_window_definition: "Separate continuity population: confirmed ACK host receipt within measurement window, including previous warmup application for the first native-native inter-ACK gap. Tail gap uses host receipt only.",
      warmup_actual_ms: measurementStart - warmupStart, requested_measurement_ms: 120_000, actual_measurement_ms: Number(report.measurement_ended_host_ms) - measurementStart,
      control_censored: censored, censored_window_ms: censored ? 120_000 : 0, expected_decision_slots: cell.frequency_hz * 120,
      actual_decisions: measuredSteps.length, censored_decision_slots: censored ? cell.frequency_hz * 120 : 0,
      actual_resident_counter_deltas: Object.fromEntries(Object.keys(countersAtStart).map(key => {
        const counter = key as keyof ResidentSnapshot["counters"];
        return [counter, countersAtEnd[counter] - countersAtStart[counter]];
      })),
      decision_population: population, input_age_ms: ageSummary, native_inter_ack_gap_ms: gapSummary, native_inter_ack_gaps_ms: gaps,
      step_ms: residentBenchmarkSummary(measuredSteps.map(value => value.ended_host_ms - value.started_host_ms)),
      timing_sample_capacity: 4000, attribution_pending: [...captures].filter(([, capture]) => !capture.age_recorded).map(([sequence, capture]) => ({ sequence, ...capture })),
      partial_acks: ackRecords.filter(value => value.ack.input_application === "partial").length,
      unknown_acks: ackRecords.filter(value => value.ack.input_application === "unknown" || value.attribution === "unknown_capture").length,
      submissions_by_disposition: {
        submitted: submissionRecords.filter(value => value.result.status === "submitted").length,
        coalesced: submissionRecords.filter(value => value.result.status === "coalesced").length,
        refused: submissionRecords.filter(value => value.result.status === "rejected").length,
        scope: "whole_root_including_warmup_all_raw_rows_retained",
      },
      tail_host_receipt_gap_ms: previous ? measurementEnd - previous.received_host_ms : null,
      last512_resident_summary_is_not_full_quantile_proof: true };
    report.event_loop_delay_measurement_ms = { scope: "measurement_window_host_event_loop", resolution_ms: 10,
      count: histogram.count, min: histogram.count ? histogram.min / 1e6 : null, mean: histogram.count ? histogram.mean / 1e6 : null,
      p50: histogram.count ? histogram.percentile(50) / 1e6 : null, p95: histogram.count ? histogram.percentile(95) / 1e6 : null,
      p99: histogram.count ? histogram.percentile(99) / 1e6 : null, max: histogram.count ? histogram.max / 1e6 : null };
    report.raw_timing_artifact = artifactPath("raw-timings.json");
    await atomicJson(artifactPath("raw-timings.json"), { acks: ackRecords, steps: stepRecords, submissions: submissionRecords, history: historyRecords,
      retirements, initial_evaluator_diagnostics: diagnosticRecords, final_resident: finalSnapshot });
    const latencyBoundMet = ages.length > 0 && ageSummary.p95 !== null && ageSummary.p99 !== null &&
      ageSummary.p95 <= protocol.acceptance.p95_ms && ageSummary.p99 <= protocol.acceptance.p99_ms &&
      gaps.length > 0 && gaps.every(value => value < protocol.acceptance.max_gap_ms) && previous !== undefined &&
      measurementEnd - previous.received_host_ms < protocol.acceptance.max_gap_ms;
    report.prospective_latency_acceptance = { required_for: "healthy_20hz", met: censored ? null : latencyBoundMet,
      thresholds: protocol.acceptance, lower_rate_scope: "exploratory overhead/expiry characterization, not exempt from load independence; expiration is not continuity" };
    if (cell.frequency_hz === 20) requireProof(latencyBoundMet,
      "Required full-window capture-to-applied 50/100ms native application bounds were not met");
    const stoppedSnapshot = finalSnapshot as ResidentSnapshot | null;
    report.post_window_unconfirmed_at_stop = [...captures].filter(([, capture]) =>
      !capture.age_recorded && capture.captured_host_ms >= measurementEnd!).map(([sequence, capture]) => ({
      sequence, captured_host_ms: capture.captured_host_ms, captured_native_ns: capture.native_ns,
      disposition: "unconfirmed_after_observation_window_during_planned_stop",
      input_application: "not_confirmed", effect_status: "unknown",
    }));
    if (cell.frequency_hz === 20) requireProof(!censored && measuredSteps.length > 0 && stoppedSnapshot?.status === "stopped" &&
      stoppedSnapshot.reason === "benchmark_full_original_window_completed" &&
      !ackRecords.some(value => value.ack.input_application !== "confirmed" || value.attribution === "unknown_capture") &&
      population.full_population_confirmed && ![...captures.values()].some(value =>
        !value.age_recorded && value.captured_host_ms < measurementEnd!),
      "Healthy 20Hz continuity cannot be inferred from an expired/failed/censored root or uncertain application");
    report.platform_classification = censored ? "observed_lower_rate_native_expiry_full_wait_retained_no_continuity_claim" :
      cell.frequency_hz === 20 ? "full_window_20hz_mechanical_platform_bounds_met_playback_pending" : "full_window_5hz_overhead_characterization_not_tick_rate_continuity";
  } catch (error) { failure ??= error; stop(error); }
  finally {
    clearTimeout(workTimer); histogram.disable();
    finalizationStarted = true;
    const finalizationEpochMs = Date.now();
    if (performance.now() >= workDeadline) failure ??= new Error("Active work crossed its original cutoff before finalization");
    // One-way trusted host transition before cleanup. Docker code has no
    // access to this parent's process IPC endpoint and cannot renew the wall.
    if (process.send) {
      try { process.send({ type: "resident_benchmark_phase", version: 1, phase: "finalizing", entered_epoch_ms: finalizationEpochMs }); }
      catch (error) { failure ??= error; }
    }
    report.finalization_started_host_ms = performance.now();
    if (report.event_loop_delay_measurement_ms === undefined) {
      report.event_loop_delay_measurement_ms = { scope: "partial_or_unstarted_measurement_not_full_window",
        measurement_started_host_ms: measurementStart, observed_until_host_ms: performance.now(), resolution_ms: 10,
        count: histogram.count, min: histogram.count ? histogram.min / 1e6 : null,
        mean: histogram.count ? histogram.mean / 1e6 : null, p50: histogram.count ? histogram.percentile(50) / 1e6 : null,
        p95: histogram.count ? histogram.percentile(95) / 1e6 : null, p99: histogram.count ? histogram.percentile(99) / 1e6 : null,
        max: histogram.count ? histogram.max / 1e6 : null };
    }
    if (!loadAbort.signal.aborted) loadAbort.abort(new Error("Measurement load scope closed"));
    const cleanupStart = performance.now(), cleanupDeadline = Math.min(wallDeadline, cleanupStart + 25_000);
    report.cleanup_started_host_ms = cleanupStart;
    const clean = async (label: string, operation: () => Promise<unknown>, confirmed?: () => void) => {
      try { const remainingMs = cleanupDeadline - performance.now(); requireProof(remainingMs > 0, "Actual cleanup reserve exhausted");
        await bounded(Promise.resolve().then(operation), remainingMs, `${label} cleanup remains unknown at its bound`); confirmed?.(); }
      catch (error) { cleanup.errors.push(`${label}: ${message(error)}`); cleanup.deadline_reached ||= performance.now() >= cleanupDeadline; failure ??= error; }
    };
    await clean("resident", async () => {
      if (resident) { residentStop ??= resident.stop("benchmark_finalization"); await residentStop; finalSnapshot = resident.snapshot();
        cleanup.resident_worker_closed = finalSnapshot.cleanup.worker === "closed"; cleanup.resident_native_retired = finalSnapshot.cleanup.native === "retired";
        requireProof(cleanup.resident_worker_closed && cleanup.resident_native_retired, "Actual resident drain remains unknown");
      } else if (selectedWorker) { await selectedWorker.close(); cleanup.resident_worker_closed = true; cleanup.resident_native_retired = !nativeOpened; }
      else { cleanup.resident_worker_closed = true; cleanup.resident_native_retired = true; }
    });
    await clean("owned work and sandbox", async () => {
      if (!abort.signal.aborted) abort.abort(new Error("Selected and inactive work scope finalized"));
      const closing = sandbox ? sandbox.close().then(() => { cleanup.sandbox_closed = true; }) : Promise.resolve().then(() => { cleanup.sandbox_closed = true; });
      const tasks = [reasoningTask, inactiveTask, historyTask].filter((value): value is Promise<void> => value !== undefined);
      await Promise.all([closing, Promise.allSettled(tasks)]);
      if (inactiveWorker) { await inactiveWorker.close(); inactiveWorker = undefined; }
    });
    await clean("original capture", async () => {
      if (recorder) { recording = await recorder.finish({ endedAt: Date.now(), reason: failure ? message(failure) : "full_original_window_completed" });
        cleanup.recorder_closed = true; report.recording = recording;
        const indexFile = artifactPath("recording/frames.jsonl"), indexStat = await stat(indexFile);
        requireProof(indexStat.size <= 64 * 1024 ** 2, "Finite recording index evidence bound exceeded");
        const index = (await readFile(indexFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
        const gaps = index.filter(value => value.kind === "upstream_gap" || value.kind === "failure");
        report.capture_gaps = gaps;
        const frames = index.filter(value => value.kind === "frame");
        report.capture_timing = { stored_frames: frames.length, first_capture_at: frames[0]?.captured_at ?? null, last_capture_at: frames.at(-1)?.captured_at ?? null,
          native_capture_span_ms: frames.length > 1 ? Number(frames.at(-1)!.captured_at) - Number(frames[0]!.captured_at) : 0 };
        requireProof(recording.status === "complete" && recording.delivered_frames === recording.stored_frames, "Full delivered-frame evidence is incomplete");
        requireProof(gaps.length === 0, "Actual capture gap/failure remains visible and fails evidence");
        sealedConcatSha256 = createHash("sha256").update(await readFile(artifactPath("recording/replay.ffconcat"))).digest("hex");
      } else cleanup.recorder_closed = true;
    });
    await clean("journal", async () => {
      if (journal) { note("final_resident_and_retirement", { snapshot: finalSnapshot, retirements, failure: failure ? message(failure) : null });
        const finalized = await journal.finalize({ status: failure ? "failed" : "completed", reason: failure ? message(failure) : "full_original_window_completed" });
        // PrivateJournal does not expose a separate handle-close receipt on its incomplete path.
        cleanup.journal_closed = finalized.evidence_complete;
        report.journal = { ...finalized, journal: artifactPath(`journal/${finalized.journal}`), manifest: artifactPath(`journal/${finalized.manifest}`) };
        requireProof(finalized.evidence_complete, "Private journal evidence remains incomplete");
      } else cleanup.journal_closed = true;
    });
    await clean("inactive Store", async () => { store?.close(); cleanup.store_closed = true; });
    await clean("native client/server/arbiter", async () => {
      if (fixture) {
        const owned = fixture;
        nativeClose ??= closeResidentBenchmarkNativeAfterDrain(residentStop, () => owned.close());
        const result = await nativeClose; requireProof(result.closed, "Actual native processes/server/arbiter are not confirmed closed");
      }
      cleanup.native_closed = true;
    });
    await clean("actual controller context", async () => {
      if (controllerWork) await Promise.allSettled([controllerWork]);
      cleanup.runtime_closed = true;
    });
    report.runtime_owner = "NativeFixture actual diagnosticContext/ActionArbiter and ResidentController lifecycle; no Agent or separate Runtime instance";
    cleanup.confirmed = cleanup.runtime_closed && cleanup.resident_worker_closed && cleanup.resident_native_retired &&
      cleanup.sandbox_closed && cleanup.store_closed && cleanup.recorder_closed && cleanup.journal_closed &&
      cleanup.native_closed && !cleanup.deadline_reached;
    report.cleanup_ended_host_ms = performance.now(); report.final_resident = finalSnapshot; report.native_retirements = retirements;
    // Seal the actual finished concat before child exit. The cohort parent owns
    // derivation only after every native child and resource owner has closed.
    if (sealedConcatSha256 && recording?.status === "complete" && recording.delivered_frames === recording.stored_frames &&
      cleanup.confirmed && !interrupted && report.full_window_completed === true && Array.isArray(report.capture_gaps) && report.capture_gaps.length === 0) {
      report.offline_replay = { status: "deferred_parent_derivation", concat_sha256: sealedConcatSha256 };
    } else if (recorder) {
      report.offline_replay = { status: "not_run", reason: "Interrupted, incomplete capture/window or actual cleanup unknown; raw evidence retained" };
    }
    process.removeListener("SIGINT", sigint); process.removeListener("SIGTERM", sigterm);
    process.removeListener("message", parentWorkCutoff);
  }
  // Failure paths retain all raw outcomes as well, including partial compile/admission/measurement traces.
  if (report.raw_timing_artifact === undefined) {
    await atomicJson(artifactPath("raw-timings.json"), { acks: ackRecords, steps: stepRecords, submissions: submissionRecords, history: historyRecords,
      retirements, initial_evaluator_diagnostics: diagnosticRecords, final_resident: finalSnapshot });
    report.raw_timing_artifact = artifactPath("raw-timings.json");
    if (measurementStart !== null && measurementEnd !== null) {
      report.partial_decision_population = residentBenchmarkDecisionPopulation({ start: measurementStart, end: measurementEnd,
        submissions: submissionRecords, frames: stepRecords, acks: ackRecords,
        terminalReason: (finalSnapshot as ResidentSnapshot | null)?.reason ?? "failed_or_interrupted" });
    }
  }
  const platformStatus = !cleanup.confirmed ? "unknown" : failure ? "fail" : "pass";
  report.platform_status = platformStatus; report.failure = failure ? message(failure) : null;
  report.interrupted = interrupted; report.ended_at = new Date().toISOString(); report.elapsed_ms = performance.now() - started;
  requireProof(Number(report.elapsed_ms) < 240_000 || platformStatus !== "pass", "A slot beyond its original wall allowance cannot pass");
  if (fixture) {
    fixture.report.classification = classification; fixture.report.benchmark_report = reportPath;
    fixture.report.pass = platformStatus === "pass"; fixture.report.actual_provider_calls = 0;
    fixture.report.benchmark_platform_status = platformStatus; fixture.report.ended_at = report.ended_at;
    await fixture.flush();
  }
  await atomicJson(reportPath, report);
  const result: ResidentBenchmarkSlotResult = { study_id: reservation.studyId, reservation_id: reservation.reservationId, slot: reservation.slot,
    platform_status: platformStatus, cleanup_confirmed: cleanup.confirmed, report: reportPath, native_report: nativeReport, classification };
  await atomicJson(artifactPath("platform-result.json"), result);
  return result;
}
