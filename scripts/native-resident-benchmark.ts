import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonicalContractJson } from '../src/server/adapter-contract.ts';
import { renderEpisodeReplay } from '../src/server/recording.ts';
import { evaluationPaths } from '../src/evaluation/paths.ts';
import { assertNativeArtifactFresh, requireTierOptIn } from '../src/evaluation/tiers.ts';
import { residentBenchmarkSchedule, validateResidentBenchmarkDeclaration, type ResidentBenchmarkCell, type ResidentBenchmarkProtocol } from '../src/evaluation/resident-benchmark.ts';
import { readRegisteredStudy, StudyLedger, type AttemptReservation, type StudyManifest, type StudyRef, type StudySlot, type StudyState } from '../src/evaluation/studies.ts';
import type { ResidentBenchmarkSlotResult } from './native-resident-benchmark-slot.ts';

const text = z.string().min(1);
const slotSchema = z.object({ study_id: text, arm: text, initial_state_id: text, repetition: z.number().int().positive() }).strict();
const reservationSchema = z.object({ studyId: text, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), reservationId: text, slot: slotSchema }).strict();
const resultSchema = z.object({ study_id: text, reservation_id: text, slot: slotSchema,
  platform_status: z.enum(['pass', 'fail', 'unknown']), cleanup_confirmed: z.boolean(), report: text,
  native_report: text.nullable(), classification: text }).strict();
const SLOT_WALL_MS = 240_000;
const CLEANUP_GRACE_MS = 25_000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const offlineReplaySchema = z.object({ status: z.literal('deferred_parent_derivation'),
  concat_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type OfflineReplayHandoff = z.infer<typeof offlineReplaySchema>;

interface CliOptions { manifestPath: string; reservation: AttemptReservation | null; reportDirectory: string | null }
interface BenchmarkDeclaration { manifest: StudyManifest; protocol: ResidentBenchmarkProtocol; cells: ResidentBenchmarkCell[]; source: string }
interface NativeArtifact { jarPath: string; sha256: string; newestInput: string | null }
interface SlotMedia { recording_manifest: string | null; frames: string | null; replay: string | null; playback: 'pending_full_original_speed_review' }
interface ChildObservation {
  pid: number | null; exit_code: number | null; signal: NodeJS.Signals | null; close_observed: boolean;
  elapsed_ms: number; deadline_requested: boolean; kill_requested: boolean; error: string | null;
  phase: 'work' | 'finalizing';
}
interface SlotObservation {
  order: number; reservation: AttemptReservation; report_directory: string;
  child: ChildObservation; result: ResidentBenchmarkSlotResult | null; result_error: string | null;
  platform_status: 'pass' | 'fail' | 'unknown'; cleanup_confirmed: boolean;
  media: SlotMedia | null;
  offline_replay: OfflineReplayHandoff | null;
}
interface ReplayDerivation {
  order: number; reservation_id: string; source_report: string | null; concat_sha256: string | null;
  status: 'rendered' | 'failed' | 'refused' | 'not_run'; replay: string | null; error: string | null;
  started_at: string; ended_at: string | null; elapsed_ms: number; budget_ms: number;
}

function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sameSlot(a: StudySlot, b: StudySlot): boolean { return canonicalContractJson(a) === canonicalContractJson(b); }
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix.length > 0 && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function realFile(path: string): string {
  const info = lstatSync(path);
  requireCondition(info.isFile() && !info.isSymbolicLink() && realpathSync(path) === path, 'Evidence must be an existing regular file without symlinks');
  return path;
}
function readJson(path: string): unknown {
  realFile(path);
  requireCondition(lstatSync(path).size <= MAX_JSON_BYTES, 'Evidence JSON exceeds the finite reader limit');
  return JSON.parse(readFileSync(path, 'utf8'));
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value, null, 2);
  requireCondition(Buffer.byteLength(bytes) <= MAX_JSON_BYTES, 'Aggregate JSON exceeds the finite evidence bound');
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
function parseOptions(input: readonly string[]): CliOptions {
  const args = [...input];
  const native = args.indexOf('--allow-native');
  requireCondition(native >= 0, 'Real Minecraft/Docker requires explicit --allow-native opt-in');
  args.splice(native, 1);
  const take = (flag: string): string => {
    const index = args.indexOf(flag);
    requireCondition(index >= 0 && !!args[index + 1] && !args[index + 1]!.startsWith('--'), `Provide ${flag} <value>`);
    const value = args[index + 1]!; args.splice(index, 2); return value;
  };
  const manifestPath = take('--manifest');
  const child = args.includes('--slot-child');
  const reservation = child ? reservationSchema.parse(JSON.parse(take('--slot-child'))) : null;
  const reportDirectory = child ? take('--report-directory') : null;
  requireCondition(args.length === 0, `Unexpected benchmark arguments: ${args.join(' ')}`);
  return { manifestPath, reservation, reportDirectory };
}

export function validateResult(directory: string, reservation: AttemptReservation): {
  result: ResidentBenchmarkSlotResult; media: SlotMedia | null; offline_replay: OfflineReplayHandoff | null;
} {
  const result = resultSchema.parse(readJson(join(directory, 'platform-result.json')));
  requireCondition(result.study_id === reservation.studyId && result.reservation_id === reservation.reservationId && sameSlot(result.slot, reservation.slot),
    'Child result does not match the actual reserved study/slot');
  for (const file of [result.report, result.native_report].filter((value): value is string => value !== null)) {
    requireCondition(isAbsolute(file) && within(directory, file), 'Child result evidence escaped the private slot directory');
    realFile(file);
  }
  const report = readJson(result.report);
  requireCondition(report !== null && typeof report === 'object' && !Array.isArray(report), 'Child technical report is not an object');
  if (result.cleanup_confirmed) {
    const cleanup: unknown = Reflect.get(report, 'cleanup');
    requireCondition(cleanup !== null && typeof cleanup === 'object' && !Array.isArray(cleanup) &&
      ['confirmed', 'resident_worker_closed', 'resident_native_retired', 'sandbox_closed', 'store_closed', 'native_closed',
        'runtime_closed', 'recorder_closed', 'journal_closed']
        .every(key => Reflect.get(cleanup, key) === true), 'Technical report does not confirm every actual owner drain');
    if (result.native_report !== null) {
      const native = readJson(result.native_report);
      requireCondition(native !== null && typeof native === 'object' && !Array.isArray(native) && Reflect.get(native, 'cleanup') === true,
        'Native report does not confirm actual native/server drain');
    } else {
      requireCondition(result.platform_status === 'fail' && Reflect.get(report, 'native_fixture_created') === false &&
        Reflect.get(report, 'full_window_completed') === false && Reflect.get(report, 'final_resident') === null &&
        Array.isArray(Reflect.get(report, 'native_retirements')) && Reflect.get(report, 'native_retirements').length === 0,
        'Missing native report is allowed only for a failed admission before native fixture creation');
    }
  }
  const mediaValue: unknown = Reflect.get(report, 'media');
  let media: SlotMedia | null = null;
  if (mediaValue !== undefined) {
    media = z.object({ recording_manifest: text.nullable(), frames: text.nullable(), replay: z.null(),
      playback: z.literal('pending_full_original_speed_review') }).strict().parse(mediaValue);
    for (const path of [media.recording_manifest, media.frames, media.replay]) {
      if (path === null) continue;
      requireCondition(isAbsolute(path) && within(directory, path), 'Media evidence escaped the private slot directory');
      realFile(path);
    }
  }
  requireCondition(result.platform_status !== 'pass' || media !== null && media.recording_manifest !== null && media.frames !== null,
    'A passing slot requires retained recording manifest and original frame evidence');
  const handoff: unknown = Reflect.get(report, 'offline_replay');
  // Failed/incomplete children may explicitly retain a not-run explanation, but
  // only the current strict sealed handoff authorizes a parent encoder.
  const offline_replay = handoff !== null && typeof handoff === 'object' &&
    Reflect.get(handoff, 'status') === 'deferred_parent_derivation' ? offlineReplaySchema.parse(handoff) : null;
  if (result.platform_status === 'pass') {
    const recording: unknown = Reflect.get(report, 'recording');
    requireCondition(offline_replay !== null && Reflect.get(report, 'full_window_completed') === true &&
      Reflect.get(report, 'interrupted') === false && recording !== null && typeof recording === 'object' &&
      Reflect.get(recording, 'status') === 'complete' &&
      Reflect.get(recording, 'delivered_frames') === Reflect.get(recording, 'stored_frames') &&
      Array.isArray(Reflect.get(report, 'capture_gaps')) && Reflect.get(report, 'capture_gaps').length === 0,
      'A passing raw slot requires a complete capture/window and current sealed parent handoff');
  }
  return { result, media, offline_replay };
}

/** Consumes closed raw children once; never changes their reports or ledger outcomes. */
export async function deriveResidentBenchmarkReplays(options: {
  observations: readonly SlotObservation[]; deadlineEpochMs: number; signal?: AbortSignal;
}): Promise<{ complete: boolean; records: ReplayDerivation[] }> {
  requireCondition(Number.isSafeInteger(options.deadlineEpochMs), 'Derivation requires the original registered cohort deadline');
  requireCondition(options.observations.length <= 27 &&
    new Set(options.observations.map(value => value.order)).size === options.observations.length &&
    new Set(options.observations.map(value => value.report_directory)).size === options.observations.length,
    'Derivation requires a bounded, unique set of actual raw children');
  const deadline = performance.now() + options.deadlineEpochMs - Date.now();
  const allClosed = options.observations.every(value => value.cleanup_confirmed &&
    residentBenchmarkCleanupConfirmed(value.child, value.result));
  const records: ReplayDerivation[] = [];
  for (const observed of options.observations) {
    const started = performance.now();
    const record: ReplayDerivation = { order: observed.order, reservation_id: observed.reservation.reservationId,
      source_report: observed.result?.report ?? null, concat_sha256: observed.offline_replay?.concat_sha256 ?? null,
      status: 'refused', replay: null, error: null, started_at: new Date().toISOString(), ended_at: null, elapsed_ms: 0, budget_ms: 0 };
    records.push(record);
    let encoding = false;
    try {
      if (options.signal?.aborted || performance.now() >= deadline || Date.now() >= options.deadlineEpochMs) {
        record.status = 'not_run';
        throw options.signal?.reason ?? new Error('Original registered cohort allowance exhausted before offline derivation');
      }
      requireCondition(allClosed, 'Every actual child/native owner must close and confirm resource drain before any derivation');
      const current = validateResult(observed.report_directory, observed.reservation);
      requireCondition(observed.result && canonicalContractJson(current.result) === canonicalContractJson(observed.result),
        'Raw child result changed after actual close');
      requireCondition(current.media && canonicalContractJson(current.media) === canonicalContractJson(observed.media),
        'Raw child media paths changed after actual close');
      requireCondition(observed.offline_replay && current.offline_replay &&
        canonicalContractJson(current.offline_replay) === canonicalContractJson(observed.offline_replay),
        'Missing or changed sealed offline replay handoff');
      const directory = join(observed.report_directory, 'recording');
      requireCondition(current.media.recording_manifest === join(directory, 'recording-manifest.json') &&
        current.media.frames === join(directory, 'frames.jsonl') && current.media.replay === null,
        'Offline replay requires the current raw-only recording layout');
      const report = readJson(current.result.report) as Record<string, unknown>;
      requireCondition(report.full_window_completed === true && report.interrupted === false &&
        Array.isArray(report.capture_gaps) && report.capture_gaps.length === 0,
        'Interrupted or incomplete original capture/window cannot authorize derivation');
      const manifest = readJson(current.media.recording_manifest) as Record<string, unknown>;
      requireCondition(manifest && typeof manifest === 'object' && manifest.schema_version === 1 &&
        canonicalContractJson(manifest) === canonicalContractJson(report.recording) &&
        manifest.status === 'complete' && manifest.index === 'frames.jsonl' && manifest.concat === 'replay.ffconcat' &&
        Number.isSafeInteger(manifest.stored_frames) && Number(manifest.stored_frames) > 0 &&
        manifest.stored_frames === manifest.delivered_frames && Array.isArray(manifest.failures) && manifest.failures.length === 0,
        'Original recording manifest does not confirm complete delivered-frame capture');
      const health = manifest.health;
      requireCondition(health !== null && typeof health === 'object' && Reflect.get(health, 'accepting') === false &&
        ['pending_raw_bytes', 'active_encoders', 'queued_frames'].every(key => Reflect.get(health, key) === 0),
        'Original capture encoder/index ownership is not drained');
      const cleanup = report.cleanup;
      requireCondition(cleanup !== null && typeof cleanup === 'object' &&
        ['confirmed', 'runtime_closed', 'resident_worker_closed', 'resident_native_retired', 'sandbox_closed', 'store_closed',
          'recorder_closed', 'journal_closed', 'native_closed'].every(key => Reflect.get(cleanup, key) === true),
        'Original report does not confirm every capture/runtime/native owner drain');
      const indexFile = realFile(current.media.frames);
      requireCondition(lstatSync(indexFile).size <= 64 * 1024 ** 2, 'Raw recording index exceeds its finite evidence bound');
      const index = readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      requireCondition(index.filter(value => value.kind === 'frame').length === manifest.stored_frames &&
        index.at(-1)?.kind === 'end' && !index.some(value => value.kind === 'failure' || value.kind === 'upstream_gap'),
        'Raw recording index is incomplete or retains a capture gap/failure');
      const concat = realFile(join(directory, 'replay.ffconcat'));
      requireCondition(lstatSync(concat).size <= MAX_JSON_BYTES &&
        createHash('sha256').update(readFileSync(concat)).digest('hex') === observed.offline_replay.concat_sha256,
        'Recording concat changed after the sealed raw handoff');
      options.signal?.throwIfAborted();
      record.budget_ms = Math.min(30_000, deadline - performance.now(), options.deadlineEpochMs - Date.now());
      if (record.budget_ms <= 0) {
        record.status = 'not_run';
        throw new Error('Original registered cohort allowance exhausted before encoder admission');
      }
      encoding = true;
      const replay = await renderEpisodeReplay({ directory, concatSha256: observed.offline_replay.concat_sha256,
        timeoutMs: record.budget_ms, signal: options.signal });
      options.signal?.throwIfAborted();
      requireCondition(performance.now() < deadline && Date.now() < options.deadlineEpochMs,
        'Offline replay closed after the original registered cohort allowance');
      record.replay = realFile(join(directory, replay));
      record.status = 'rendered';
    } catch (cause) {
      if (encoding) record.status = 'failed';
      else if (options.signal?.aborted) record.status = 'not_run';
      record.error = message(cause);
    } finally {
      record.ended_at = new Date().toISOString();
      record.elapsed_ms = performance.now() - started;
    }
  }
  return { complete: records.length > 0 && records.every((record, index) => record.status === 'rendered' &&
    options.observations[index]!.platform_status === 'pass'), records };
}

/** Resolves only on the OS close event, never on a timeout, exit event, or kill request. */
export async function launchResidentBenchmarkChild(options: {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  deadlineEpochMs: number; cleanupMs: number;
  setChild(child: ChildProcess | null): void;
}): Promise<ChildObservation> {
  const started = performance.now();
  requireCondition(Number.isSafeInteger(options.deadlineEpochMs) && Number.isSafeInteger(options.cleanupMs) && options.cleanupMs > 0,
    'Child requires its original finite absolute deadline and cleanup reserve');
  const admissionEpochMs = Date.now();
  const totalDeadline = started + options.deadlineEpochMs - admissionEpochMs, workDeadline = totalDeadline - options.cleanupMs;
  const workDeadlineEpochMs = options.deadlineEpochMs - options.cleanupMs;
  let deadlineRequested = false, killRequested = false, error: string | null = null;
  let totalReached = false;
  let phase: 'work' | 'finalizing' = 'work';
  let child: ChildProcess;
  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: options.env,
    });
  } catch (cause) {
    return { pid: null, exit_code: null, signal: null, close_observed: false, elapsed_ms: performance.now() - started,
      deadline_requested: false, kill_requested: false, error: message(cause), phase };
  }
  options.setChild(child);
  const closed = Promise.withResolvers<ChildObservation>();
  // Only the trusted host child owns this IPC endpoint. Generated code remains
  // in the existing Docker worker and cannot advertise host finalization.
  child.on('message', value => {
    if (value === null || typeof value !== 'object' || !('type' in value) || value.type !== 'resident_benchmark_phase') return;
    const parsed = z.object({type:z.literal('resident_benchmark_phase'),version:z.literal(1),phase:z.literal('finalizing'),
      entered_epoch_ms:z.number().int().safe().positive()}).strict().safeParse(value);
    if (!parsed.success || phase !== 'work' || parsed.data.entered_epoch_ms < admissionEpochMs || parsed.data.entered_epoch_ms > Date.now()) {
      error ??= 'Invalid or duplicate trusted child phase transition';
      deadlineRequested = true; return;
    }
    phase = 'finalizing';
    // Delivery can lag behind phase entry. The host child's entry timestamp,
    // not IPC receipt ordering against the timer, establishes the work cutoff.
    deadlineRequested = totalReached || error !== null || parsed.data.entered_epoch_ms > workDeadlineEpochMs;
  });
  const workTimer = setTimeout(() => {
    if (phase === 'finalizing') return;
    deadlineRequested = true;
    // Do not signal an already-finalizing child whose phase notice is queued.
    // Its trusted handler fences active work only; the hard total wall remains.
    if (child.connected) child.send({type:'resident_benchmark_work_cutoff',version:1}, cause => { if (cause) error ??= message(cause); });
  }, Math.max(1, workDeadline - performance.now()));
  // No fresh grace period after TERM: total admission wall is absolute.
  const totalTimer = setTimeout(() => {
    totalReached = true; deadlineRequested = true; killRequested = true; child.kill('SIGKILL');
  }, Math.max(1, totalDeadline - performance.now()));
  child.on('error', cause => { error ??= message(cause); });
  child.once('close', (code, signal) => {
    clearTimeout(workTimer); clearTimeout(totalTimer);
    if (performance.now() >= totalDeadline) deadlineRequested = true;
    if (phase !== 'finalizing' && code === 0) error ??= 'Child closed without its trusted finalization transition';
    options.setChild(null);
    closed.resolve({ pid: child.pid ?? null, exit_code: code, signal, close_observed: true, elapsed_ms: performance.now() - started,
      deadline_requested: deadlineRequested, kill_requested: killRequested || signal === 'SIGKILL', error, phase });
  });
  return await closed.promise;
}

/** A kill/close is not a resource-drain receipt. The separately checked report is required. */
export function residentBenchmarkCleanupConfirmed(child: ChildObservation, result: {cleanup_confirmed:boolean} | null): boolean {
  return child.close_observed && !child.kill_requested && child.error === null && result?.cleanup_confirmed === true;
}

function aggregate(options: {
  declaration: BenchmarkDeclaration; ref: StudyRef; state: StudyState;
  startedAt: string; started: number; reportDirectory: string; observations: readonly SlotObservation[];
  derivations: readonly ReplayDerivation[]; derivationDeadlineEpochMs: number;
  interruption: NodeJS.Signals | null; failure: string | null; jar: NativeArtifact;
}) {
  const { declaration, state } = options;
  const rows = residentBenchmarkSchedule(options.ref.studyId, declaration.protocol.mode).map(entry => {
    const disposition = state.slots.find(value => sameSlot(value.slot, entry.slot));
    const attempt = state.attempts.find(value => sameSlot(value.slot, entry.slot));
    const observed = options.observations.find(value => sameSlot(value.reservation.slot, entry.slot));
    return { ...entry, cell: declaration.cells[entry.order], disposition: disposition?.status ?? 'missing_ledger_row',
      attempt: attempt ?? null, actual: observed ?? null,
      media: { slot_report: observed?.result?.report ?? null, native_report: observed?.result?.native_report ?? null,
        private_slot_directory: observed?.report_directory ?? null, recording: observed?.media ?? null,
        parent_derived_replay: options.derivations.find(value => value.order === entry.order) ?? null,
        playback: 'pending_full_original_speed_review' } };
  });
  const complete = !options.failure && !options.interruption && rows.length === (declaration.protocol.mode === 'cohort' ? 27 : 1) && rows.every(row =>
    row.attempt?.state === 'settled' && row.attempt.cleanup.confirmed && row.attempt.settlement?.outcome.platform_status === 'pass' &&
    row.actual?.child.close_observed && row.actual.cleanup_confirmed && row.media.parent_derived_replay?.status === 'rendered');
  const unknown = rows.some(row => row.actual?.platform_status === 'unknown' || row.attempt && !row.attempt.cleanup.confirmed);
  const platformStatus = complete ? 'pass' : unknown ? 'unknown' : 'fail';
  return {
    schema_version: 1, classification: declaration.protocol.mode === 'calibration'
      ? 'zero_provider_single_cell_calibration_not_E01_completion' : 'zero_provider_native_resident_E01_technical_cohort_not_model_competence',
    mode: declaration.protocol.mode, platform_status: platformStatus, complete, e01_complete: complete && declaration.protocol.mode === 'cohort',
    media_review: 'pending_full_original_speed_review_not_visual_proof', actual_provider_calls: 0, actual_jev_calls: 0,
    agent_status: 'not_run', provider_status: 'not_called', goal_verified: null, usage: null,
    started_at: options.startedAt, ended_at: new Date().toISOString(), actual_elapsed_ms: performance.now() - options.started,
    registered_at: state.registeredAt, registered_elapsed_ms: Date.now() - state.registeredAt,
    study: options.ref, identities: declaration.manifest.identities, protocol_identity: declaration.manifest.task.verifier,
    manifest: declaration.manifest, protocol: declaration.protocol, native_artifact: options.jar,
    timing_ruling: {
      original_p95_target_ms: 50, original_target_status: 'unmet_not_relabelled_passed',
      retained_prior_native_smokes: [{ p95_ms: 51.95602, p99_ms: 52.536315 }, { p95_ms: 68.406017, p99_ms: 68.834093 }],
      prospective_acceptance: declaration.protocol.acceptance,
      ruling: 'Frozen before this run: capture-to-applied p95<=50ms, p99<=100ms during healthy tick progress, no infrastructure-caused gap>=1000ms while valid input is ready; lower rates remain subject to load independence, no native-tick or competence claim',
      provenance: 'Actual confirmed capture-native to application-native ages only; GUI dwell ACKs are not world-frame samples',
    },
    evidence_scope: 'Every scheduled row, failed/interrupted attempt, cleanup uncertainty and unstarted disposition retained; no retries or slot recycling',
    native_ownership_retained: state.attempts.filter(value => !value.cleanup.confirmed).map(value => value.reservationId),
    offline_derivation: { phase: 'parent_after_all_native_children_closed', deadline_epoch_ms: options.derivationDeadlineEpochMs,
      per_encoder_max_ms: 30_000, records: options.derivations },
    closure: state.closure, interruption: options.interruption, error: options.failure,
    scheduled_rows: rows.length, reserved_rows: state.attempts.length, rows,
    report_directory: options.reportDirectory,
  };
}

export async function runNativeResidentBenchmark(input: readonly string[], projectRoot = fileURLToPath(new URL('..', import.meta.url))): Promise<number> {
  const options = parseOptions(input);
  requireTierOptIn('native-game', { allowNative: true });
  const project = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  requireCondition(realpathSync(resolve(projectRoot)) === project && realpathSync(process.cwd()) === project,
    'Benchmark authority must be the executing evaluator project in its actual project cwd');
  const manifestPath = realFile(resolve(project, options.manifestPath));
  const declaration = validateResidentBenchmarkDeclaration(readJson(manifestPath), { projectRoot: project });
  const artifact = assertNativeArtifactFresh(project, declaration.manifest.identities.build.path);
  requireCondition(artifact.sha256 === declaration.manifest.identities.build.sha256, 'Current native JAR differs from the declared build');
  if (options.reservation) {
    requireCondition(options.reportDirectory !== null && isAbsolute(options.reportDirectory), 'Child route requires its absolute private report directory');
    const directory = realpathSync(options.reportDirectory);
    requireCondition(directory === options.reportDirectory && within(join(project, 'local/evaluation/resident-benchmark'), directory),
      'Child report directory must be the trusted private parent-created directory');
    requireCondition(process.env.GAMEHARNESS_NATIVE_PROOF === '1' && process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 === artifact.sha256,
      'Internal child requires the parent checked native opt-in and exact JAR binding');
    // Preserve the process-fixed fixture/config import boundary: the cohort parent must never load native slot owners.
    const { runResidentBenchmarkSlot } = await import('./native-resident-benchmark-slot.ts');
    const result = await runResidentBenchmarkSlot({ project, manifestPath, reservation: options.reservation, reportDirectory: directory });
    return result.platform_status === 'pass' && result.cleanup_confirmed ? 0 : 1;
  }

  const paths = evaluationPaths(project);
  const ledger = new StudyLedger(paths.governanceRoot, { projectRoot: project });
  let active: ChildProcess | null = null;
  const derivationAbort = new AbortController();
  let interruption: NodeJS.Signals | null = null;
  let interruptionKill: NodeJS.Timeout | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interruption ??= signal;
    if (!derivationAbort.signal.aborted) derivationAbort.abort(new Error(`Original cohort interrupted by ${signal}`));
    if (active) {
      active.kill(signal);
      interruptionKill ??= setTimeout(() => { active?.kill('SIGKILL'); }, CLEANUP_GRACE_MS);
    }
  };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const started = performance.now(), startedAt = new Date().toISOString();
  const observations: SlotObservation[] = [];
  let derivations: ReplayDerivation[] = [];
  let failure: string | null = null;
  let ref: StudyRef | undefined, reportDirectory: string | undefined;
  let runAdmitted = false;
  let outstanding: AttemptReservation | null = null;
  try {
    const registered = readRegisteredStudy(ledger, { studyId: declaration.manifest.study_id, manifestPath,
      slot: declaration.manifest.schedule[0]!.slot }, project);
    ref = registered.ref;
    requireCondition(canonicalContractJson(registered.manifest) === canonicalContractJson(declaration.manifest), 'Registered benchmark declaration differs');
    const initial = ledger.readStudy(ref);
    const derivationDeadlineEpochMs = initial.registeredAt + declaration.manifest.allowances.cohort.elapsed_ms;
    const cohortDeadline = performance.now() + derivationDeadlineEpochMs - Date.now();
    requireCondition(initial.closure === null && initial.attempts.length === 0 && initial.slots.every(slot => slot.status === 'scheduled'),
      'Benchmark refuses consumed, interrupted, closed or partially run studies; no resume/retry/reopening');
    runAdmitted = true;
    const root = join(project, 'local/evaluation/resident-benchmark');
    await mkdir(root, { recursive: true, mode: 0o700 });
    requireCondition(realpathSync(root) === root, 'Private benchmark root must not traverse symlinks');
    reportDirectory = join(root, `${declaration.protocol.mode}-${Date.now()}-${randomUUID()}`);
    await mkdir(reportDirectory, { mode: 0o700 });
    await mkdir(join(reportDirectory, 'slots'), { mode: 0o700 });
    const save = async () => {
      const result = aggregate({ declaration, ref: ref!, state: ledger.readStudy(ref!), startedAt, started, reportDirectory: reportDirectory!,
        observations, derivations, derivationDeadlineEpochMs, interruption, failure, jar: artifact });
      await atomicJson(join(reportDirectory!, 'aggregate.json'), result);
      return result;
    };
    await save();
    try {
      for (const entry of residentBenchmarkSchedule(ref.studyId, declaration.protocol.mode)) {
        if (interruption) break;
        const current = ledger.readStudy(ref);
        requireCondition(current.closure === null, 'Cohort admissions already closed');
        requireCondition(current.slots.find(value => sameSlot(value.slot, entry.slot))?.status === 'scheduled', 'Exact next slot has already been consumed');
        const fresh = validateResidentBenchmarkDeclaration(readJson(manifestPath), { projectRoot: project });
        requireCondition(canonicalContractJson(fresh.manifest) === canonicalContractJson(declaration.manifest), 'Manifest changed between slots');
        const jar = assertNativeArtifactFresh(project, declaration.manifest.identities.build.path);
        requireCondition(jar.sha256 === artifact.sha256, 'Native artifact changed between slots');
        const directory = join(reportDirectory, 'slots', String(entry.order).padStart(2, '0'));
        await mkdir(directory, { mode: 0o700 });
        if (interruption) break;
        outstanding = ledger.reserveStudyAttempt(ref, entry.slot, { reportDirectory: directory });
        const reservation = outstanding;
        const reserved = ledger.readStudy(ref).attempts.find(value => value.reservationId === reservation.reservationId)!;
        const deadlineEpochMs = Math.min(reserved.reservedAt + SLOT_WALL_MS, current.registeredAt + declaration.manifest.allowances.cohort.elapsed_ms);
        const child = await launchResidentBenchmarkChild({
          command: process.execPath, args: ['--no-env-file', fileURLToPath(import.meta.url), '--allow-native', '--manifest', manifestPath,
            '--slot-child', JSON.stringify(reservation), '--report-directory', directory],
          cwd: project, deadlineEpochMs, cleanupMs: CLEANUP_GRACE_MS,
          env: { ...process.env, GAMEHARNESS_NATIVE_PROOF: '1', GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256: jar.sha256,
            GAMEHARNESS_BENCHMARK_DEADLINE_EPOCH_MS: String(deadlineEpochMs),
            GAMEHARNESS_EVALUATION_REPORTS_ROOT: join(project, 'local/evaluation/resident-benchmark-index'),
            GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT: paths.governanceRoot,
            GAMEHARNESS_EVALUATION_RUNTIME_ROOT: join(directory, 'native-runtime') },
          setChild(value) {
            active = value;
            if (value && interruption) value.kill(interruption);
            if (!value && interruptionKill) { clearTimeout(interruptionKill); interruptionKill = undefined; }
          } });
        let result: ResidentBenchmarkSlotResult | null = null, resultError: string | null = null, media: SlotMedia | null = null;
        let offline_replay: OfflineReplayHandoff | null = null;
        try {
          requireCondition(child.close_observed, 'Child OS close was not observed');
          ({ result, media, offline_replay } = validateResult(directory, reservation));
        } catch (cause) { resultError = message(cause); }
        const cleanup = residentBenchmarkCleanupConfirmed(child, result);
        const status = !result || !cleanup ? 'unknown' : child.exit_code !== 0 || child.signal !== null || child.deadline_requested || child.error
          ? 'fail' : result.platform_status;
        observations.push({ order: entry.order, reservation, report_directory: directory, child, result, result_error: resultError,
          platform_status: status, cleanup_confirmed: cleanup, media, offline_replay });
        const evidence = [join(directory, 'platform-result.json'), ...(result ? [result.report, ...(result.native_report ? [result.native_report] : [])] : []),
          `OS child close=${child.close_observed}; code=${child.exit_code}; signal=${child.signal}; pid=${child.pid}`,
          ...(resultError ? [`Result validation failed: ${resultError}`] : [])];
        if (interruption) ledger.interruptStudyAttempt(reservation, `operator_interrupt:${interruption}`);
        else ledger.settleStudyAttempt(reservation, { outcome: { platform_status: status, agent_status: 'not_run', provider_status: 'not_called',
          goal_verified: null, classification_reason: [result?.classification ?? 'Missing or invalid child result; actual cleanup remains unknown',
            ...(status !== result?.platform_status ? ['Parent retained nonclean child exit/deadline/cleanup uncertainty'] : [])] },
          usage: null, evidence, stop_reason: status === 'pass' ? null : 'invalid_platform' });
        outstanding = null;
        const attempt = ledger.readStudy(ref).attempts.find(value => value.reservationId === reservation.reservationId);
        requireCondition(attempt && attempt.requests.length === 0, 'Zero-provider benchmark acquired unexpected request ownership');
        if (cleanup) ledger.confirmStudyResourceDrain(reservation, { requests_drained: true, runtime_closed: true, native_closed: true,
          evidence: [...evidence, 'Validated helper cleanup confirms actual worker/sandbox/Store/native/server drain after child close'] });
        else ledger.closeStudyAdmissions(ref, 'unknown_cleanup_retains_native_ownership');
        await save();
        if (interruption || status !== 'pass' || !cleanup) break;
      }
    } catch (cause) {
      failure = message(cause);
      // A reservation is consumed even if launch/result/settlement handling fails. Never reserve a replacement.
      if (outstanding) {
        const attempt = ledger.readStudy(ref).attempts.find(value => value.reservationId === outstanding!.reservationId);
        if (attempt?.state === 'reserved') {
          if (interruption) ledger.interruptStudyAttempt(outstanding, `operator_interrupt:${interruption}`);
          else ledger.settleStudyAttempt(outstanding, { outcome: { platform_status: 'unknown', agent_status: 'not_run', provider_status: 'not_called',
            goal_verified: null, classification_reason: [`Cohort exception; cleanup unconfirmed: ${failure}`] }, usage: null,
            evidence: [reportDirectory, failure], stop_reason: 'invalid_platform' });
        }
        outstanding = null;
      }
      ledger.closeStudyAdmissions(ref, interruption ? `operator_interrupt:${interruption}` : 'benchmark_cohort_failure');
    }
    if (interruption) ledger.closeStudyAdmissions(ref, `operator_interrupt:${interruption}`);
    const state = ledger.readStudy(ref);
    if (state.closure === null) ledger.closeStudyAdmissions(ref, 'native_phase_closed_for_offline_derivation');
    const ownersClosed = active === null && outstanding === null && state.attempts.length === observations.length &&
      state.attempts.every(value => value.state !== 'reserved' && value.cleanup.confirmed);
    const phaseSignal = ownersClosed ? derivationAbort.signal : AbortSignal.abort(new Error('Actual ledger/native owner closure remains unknown'));
    // This conservative epoch bound retains the original monotonic cohort clock
    // as well as registered wall time. Neither phase transition nor interrupt
    // renews the allowance. No native admissions follow this point.
    const remainingDeadlineEpochMs = Math.min(derivationDeadlineEpochMs,
      Date.now() + Math.max(0, Math.floor(cohortDeadline - performance.now())));
    const derived = await deriveResidentBenchmarkReplays({ observations, deadlineEpochMs: remainingDeadlineEpochMs, signal: phaseSignal });
    derivations = derived.records;
    await atomicJson(join(reportDirectory, 'offline-replays.json'), { schema_version: 1,
      original_cohort_deadline_epoch_ms: derivationDeadlineEpochMs, per_encoder_max_ms: 30_000,
      records: derivations, complete: derived.complete });
    if (!derived.complete) failure ??= 'Required parent offline replay derivation is incomplete; immutable raw/native outcomes retained';
    const result = await save();
    console.log(JSON.stringify({ private_report: join(reportDirectory, 'aggregate.json'), mode: declaration.protocol.mode,
      platform_status: result.platform_status, complete: result.complete, e01_complete: result.e01_complete,
      actual_provider_calls: 0, media_review: result.media_review }));
    return result.complete && result.platform_status === 'pass' && !interruption && !failure ? 0 : 1;
  } catch (cause) {
    if (runAdmitted && ref) ledger.closeStudyAdmissions(ref, interruption ? `operator_interrupt:${interruption}` : 'benchmark_cohort_or_reporting_failure');
    throw cause;
  } finally {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    clearTimeout(interruptionKill);
    ledger.close();
  }
}

if (import.meta.main) {
  try { process.exitCode = await runNativeResidentBenchmark(process.argv.slice(2)); }
  catch (error) { console.error(message(error)); process.exitCode = 1; }
}
