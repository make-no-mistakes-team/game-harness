import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runner from '../scripts/native-resident-benchmark.ts';
import { EpisodeRecorder } from '../src/server/recording.ts';
import { nativeFrame } from './helpers/native-frame.ts';
import { osMonotonicNs } from '../src/server/os-monotonic.ts';
import { P13_VOLUME_CLASSIFICATION } from '../src/evaluation/resident-volume.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function closedRawSlot(largeClip = false) {
  const directory = await mkdtemp(join(tmpdir(), 'resident-benchmark-media-')); roots.push(directory);
  const recordingDirectory = join(directory, 'recording');
  await mkdir(recordingDirectory);
  let listener: ((frame: Uint8Array) => void) | undefined, now = 10000;
  const recorder = new EpisodeRecorder({ directory: recordingDirectory, captureMode: "lossless_png",
    identity: { episode_id: 'episode', run_id: 'run', world_id: 'world', session_id: 'session' },
    bridge: { subscribeFrames(callback) { listener = callback; return () => { listener = undefined; }; } },
    now: () => now, monotonicNow: () => now - 10000, onIncomplete: reason => { throw new Error(reason); } });
  const offsets = largeClip ? Array.from({ length: 80 }, (_, index) => index * 33) : [0, 33, 67];
  const size = largeClip ? 128 : 2;
  for (const [index, offset] of offsets.entries()) {
    now = 10005 + offset;
    const pixels = new Uint8Array(size * size * 4);
    for (let pixel = 0; pixel < pixels.length; pixel += 4) {
      pixels[pixel] = (pixel * 73 + index * 91) % 256;
      pixels[pixel + 1] = (pixel * 19 + index * 37) % 256;
      pixels[pixel + 2] = (pixel * 11 + index * 53) % 256;
      pixels[pixel + 3] = 255;
    }
    listener!(nativeFrame({ width: size, height: size, sequence: index + 1, capturedAt: 10000 + offset, pixels }));
  }
  const recording = await recorder.finish({ endedAt: 10000 + (largeClip ? 2640 : 100), reason: 'full_original_window_completed' });
  const concat_sha256 = createHash('sha256').update(await readFile(join(recordingDirectory, 'replay.ffconcat'))).digest('hex');
  const reservation = { studyId: 'media-study', manifestSha256: 'a'.repeat(64), reservationId: 'reserved-once',
    slot: { study_id: 'media-study', arm: 'healthy', initial_state_id: 'arena', repetition: 1 } };
  const media = { recording_manifest: join(recordingDirectory, 'recording-manifest.json'),
    frames: join(recordingDirectory, 'frames.jsonl'), replay: null, playback: 'pending_full_original_speed_review' as const };
  const offline_replay = { status: 'deferred_parent_derivation' as const, concat_sha256 };
  const report = { full_window_completed: true, native_fixture_created: true, final_resident: null, native_retirements: [],
    interrupted: false, recording, capture_gaps: [],
    // This original native slot wall has already expired. It is not renewed by deriving media.
    deadlines: { original_deadline_epoch_ms: Date.now() - 1000 },
    cleanup: { confirmed: true, resident_worker_closed: true, resident_native_retired: true, sandbox_closed: true,
      history_reader_closed: true, store_closed: true, runtime_closed: true, recorder_closed: true, journal_closed: true, native_closed: true },
    media, offline_replay };
  const result = { study_id: reservation.studyId, reservation_id: reservation.reservationId, slot: reservation.slot,
    platform_status: 'pass' as const, cleanup_confirmed: true, report: join(directory, 'slot-report.json'),
    native_report: join(directory, 'native-report.json'), classification: 'technical' };
  await writeFile(result.native_report, JSON.stringify({ cleanup: true }));
  await writeFile(result.report, JSON.stringify(report));
  await writeFile(join(directory, 'platform-result.json'), JSON.stringify(result));
  const observation = { order: 0, reservation, report_directory: directory,
    child: { pid: 123, exit_code: 0, signal: null, close_observed: true, elapsed_ms: 200000,
      deadline_requested: false, kill_requested: false, error: null, phase: 'finalizing' as const },
    result, result_error: null, platform_status: 'pass' as const, cleanup_confirmed: true, media, offline_replay };
  const immutableFiles = [result.report, result.native_report, join(directory, 'platform-result.json'),
    media.recording_manifest, media.frames, join(recordingDirectory, 'replay.ffconcat')];
  const snapshot = () => Promise.all(immutableFiles.map(file => readFile(file, 'utf8')));
  return { directory, recordingDirectory, observation, report, snapshot };
}

async function probeTimes(file: string): Promise<number[]> {
  const child = Bun.spawn(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file], { stdout: 'pipe', stderr: 'pipe' });
  // Only a real subprocess deadlock guard, not a substitute for observed exit or media timing.
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`Actual FFprobe failed (${exit}): ${stderr}`);
    return JSON.parse(stdout).frames.map((frame: { best_effort_timestamp_time: string }) => Number(frame.best_effort_timestamp_time));
  } finally { clearTimeout(timer); await child.exited; }
}

test('closed raw capture derives real full-timeline media after its slot wall, under the original cohort wall, without rewriting child evidence', async () => {
  const source = await closedRawSlot(), before = await source.snapshot();
  const cohortDeadline = Date.now() + 5000;
  const derived = await runner.deriveResidentBenchmarkReplays({ assay: "e01", observations: [source.observation], deadlineEpochMs: cohortDeadline });
  expect(derived.complete).toBe(true);
  expect(derived.records).toHaveLength(1);
  const record = derived.records[0]!;
  expect(record.status).toBe('rendered');
  expect(record.budget_ms).toBeGreaterThan(0);
  expect(record.budget_ms).toBeLessThanOrEqual(5000);
  expect(record.ended_at).not.toBeNull();
  expect(await probeTimes(record.replay!)).toEqual([0, .033, .067, .1]);
  expect(await source.snapshot()).toEqual(before);
  expect(source.observation.result.platform_status).toBe('pass');
});

for (const fault of ['missing_handoff', 'replaced_handoff', 'tampered_concat', 'unknown_cleanup', 'unclosed_child', 'incomplete_capture'] as const) {
  test(`parent media refuses ${fault} and retains the original raw/native result`, async () => {
    const source = await closedRawSlot();
    if (fault === 'missing_handoff') delete (source.report as Partial<typeof source.report>).offline_replay;
    if (fault === 'replaced_handoff') source.report.offline_replay = { status: 'deferred_parent_derivation', concat_sha256: 'b'.repeat(64) };
    if (fault === 'tampered_concat') await writeFile(join(source.recordingDirectory, 'replay.ffconcat'), "ffconcat version 1.0\nfile '/must-not-be-consumed.png'\n");
    if (fault === 'unknown_cleanup') source.observation.cleanup_confirmed = false;
    if (fault === 'unclosed_child') source.observation.child.close_observed = false;
    if (fault === 'incomplete_capture') source.report.recording.status = 'incomplete';
    await writeFile(source.observation.result.report, JSON.stringify(source.report));
    const before = await source.snapshot();
    const derived = await runner.deriveResidentBenchmarkReplays({ assay: "e01", observations: [source.observation], deadlineEpochMs: Date.now() + 5000 });
    expect(derived.complete).toBe(false);
    expect(derived.records[0]!.status).not.toBe('rendered');
    expect(derived.records[0]!.error).toBeTruthy();
    expect(derived.records[0]!.replay).toBeNull();
    await expect(access(join(source.recordingDirectory, 'replay.mp4'))).rejects.toThrow();
    expect(await source.snapshot()).toEqual(before);
    expect(source.observation.result.platform_status).toBe('pass');
  });
}

for (const stop of ['expired_original_cohort', 'interrupted'] as const) test(`${stop} cannot start a fresh derivation allowance or complete raw success`, async () => {
  const source = await closedRawSlot(), before = await source.snapshot(), abort = new AbortController();
  if (stop === 'interrupted') abort.abort(new Error('Original cohort interrupted'));
  const derived = await runner.deriveResidentBenchmarkReplays({ assay: "e01", observations: [source.observation],
    deadlineEpochMs: Date.now() + (stop === 'expired_original_cohort' ? -1 : 5000), signal: abort.signal });
  expect(derived.complete).toBe(false);
  expect(derived.records[0]!.status).toBe('not_run');
  expect(derived.records[0]!.error).toBeTruthy();
  await expect(access(join(source.recordingDirectory, 'replay.mp4'))).rejects.toThrow();
  expect(await source.snapshot()).toEqual(before);
});

test('a failed raw/native outcome stays failed even when its eligible complete capture derives', async () => {
  const source = await closedRawSlot();
  const failedResult = { ...source.observation.result, platform_status: 'fail' as const };
  const failed = { ...source.observation, result: failedResult, platform_status: 'fail' as const };
  await writeFile(join(source.directory, 'platform-result.json'), JSON.stringify(failedResult));
  const before = await source.snapshot();
  const derived = await runner.deriveResidentBenchmarkReplays({ assay: "e01", observations: [failed], deadlineEpochMs: Date.now() + 5000 });
  expect(derived.records[0]!.status).toBe('rendered');
  expect(derived.complete).toBe(false);
  expect(await source.snapshot()).toEqual(before);
  expect(failed.result.platform_status).toBe('fail');
});

test('one unknown owner blocks derivation of every otherwise closed raw capture', async () => {
  const safe = await closedRawSlot(), uncertain = await closedRawSlot();
  uncertain.observation.order = 1;
  uncertain.observation.cleanup_confirmed = false;
  const derived = await runner.deriveResidentBenchmarkReplays({ assay: "e01", observations: [safe.observation, uncertain.observation],
    deadlineEpochMs: Date.now() + 5000 });
  expect(derived.complete).toBe(false);
  expect(derived.records).toHaveLength(2);
  for (const record of derived.records) expect(record.status).not.toBe('rendered');
  await expect(access(join(safe.recordingDirectory, 'replay.mp4'))).rejects.toThrow();
  await expect(access(join(uncertain.recordingDirectory, 'replay.mp4'))).rejects.toThrow();
});

test('interruption during real parent encoding fails that derivative and never starts the next clip', async () => {
  const current = await closedRawSlot(true), next = await closedRawSlot(), abort = new AbortController();
  next.observation.order = 1;
  const before = await current.snapshot();
  // The actual encoder's output creation, not a guessed delay, triggers interruption.
  const watcher = watch(current.recordingDirectory, (_event, filename) => {
    if (filename === 'replay.mp4') abort.abort(new Error('Operator interrupted active parent encoder'));
  });
  try {
    const derived = await runner.deriveResidentBenchmarkReplays({ assay: "e01", observations: [current.observation, next.observation],
      deadlineEpochMs: Date.now() + 10000, signal: abort.signal });
    expect(abort.signal.aborted).toBe(true);
    expect(derived.complete).toBe(false);
    expect(derived.records[0]).toMatchObject({ status: 'failed', replay: null });
    expect(derived.records[0]!.error).toMatch(/interrupt/i);
    expect(derived.records[1]).toMatchObject({ status: 'not_run', replay: null, budget_ms: 0 });
    await expect(access(join(next.recordingDirectory, 'replay.mp4'))).rejects.toThrow();
    expect(await current.snapshot()).toEqual(before);
  } finally { watcher.close(); }
});

test('P13 replay cannot renew its expired original OS-monotonic workflow clock despite later wall time', async () => {
  const source = await closedRawSlot(), before = await source.snapshot();
  const derived = await runner.deriveResidentBenchmarkReplays({
    assay: 'p13_volume', observations: [source.observation],
    deadlineEpochMs: Date.now() + 5000,
    deadlineMonotonicNs: osMonotonicNs() - 1n,
  });
  expect(derived.complete).toBe(false);
  expect(derived.records[0]).toMatchObject({ status: 'not_run', replay: null, budget_ms: 0 });
  expect(await source.snapshot()).toEqual(before);
  await expect(access(join(source.recordingDirectory, 'replay.mp4'))).rejects.toThrow();
});

test('a later persisted P13 drain loss blocks every encoder before the first otherwise eligible clip', async () => {
  const safe = await closedRawSlot(), uncertain = await closedRawSlot();
  uncertain.observation.order = 1;
  for (const source of [safe, uncertain]) {
    source.observation.result.classification = P13_VOLUME_CLASSIFICATION;
    Object.assign(source.report, {
      assay: 'p13_volume', classification: P13_VOLUME_CLASSIFICATION,
      p13_volume_preparation_started: true,
      p13_volume: { closed: true, learning_closed: true, reader_closed: true, tasks_joined: true,
        reader_owner: { closed: true, active: false, queued: 0,
          child: { pid: 123, exitObservedHostMs: 1, stdoutDrainObservedHostMs: 2, closedHostMs: 3 } } },
    });
    await writeFile(source.observation.result.report, JSON.stringify(source.report));
    await writeFile(join(source.directory, 'platform-result.json'), JSON.stringify(source.observation.result));
  }
  Reflect.deleteProperty(uncertain.report, 'p13_volume');
  await writeFile(uncertain.observation.result.report, JSON.stringify(uncertain.report));
  await writeFile(join(uncertain.directory, 'platform-result.json'),
    JSON.stringify({ ...uncertain.observation.result, cleanup_confirmed: false }));
  const before = [await safe.snapshot(), await uncertain.snapshot()];
  const derived = await runner.deriveResidentBenchmarkReplays({
    assay: 'p13_volume', observations: [safe.observation, uncertain.observation],
    deadlineEpochMs: Date.now() + 5000, deadlineMonotonicNs: osMonotonicNs() + 5_000_000_000n,
  });
  expect(derived.complete).toBe(false);
  expect(derived.records.map(value => value.status)).toEqual(['refused', 'refused']);
  expect(derived.records.every(value => value.budget_ms === 0)).toBe(true);
  await expect(access(join(safe.recordingDirectory, 'replay.mp4'))).rejects.toThrow();
  await expect(access(join(uncertain.recordingDirectory, 'replay.mp4'))).rejects.toThrow();
  expect([await safe.snapshot(), await uncertain.snapshot()]).toEqual(before);
});
