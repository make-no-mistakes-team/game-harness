import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { canonicalContractJson } from "../server/adapter-contract.ts";
import { validateStudyManifest, type StudyManifest } from "./studies.ts";
import type { InputSubmission } from "../shared/controller.ts";
import type { GameState } from "../shared/contracts.ts";
import type { EffectScope } from "../shared/control.ts";

export function waitResidentBenchmarkUntil(
  deadlineHostMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isFinite(deadlineHostMs))
    throw new Error(
      "Benchmark wait requires a finite original monotonic deadline",
    );
  const pending = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout>;
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  };
  const cancel = () => {
    done();
    pending.reject(signal.reason);
  };
  const check = () => {
    if (signal.aborted) {
      cancel();
      return;
    }
    const remaining = deadlineHostMs - performance.now();
    if (remaining <= 0) {
      done();
      pending.resolve();
      return;
    }
    timer = setTimeout(check, Math.ceil(remaining));
  };
  signal.addEventListener("abort", cancel, { once: true });
  check();
  return pending.promise;
}

/** Fixture teardown cannot destroy the channel still needed by resident retirement.
 * A rejected drain stays a separately recorded resident failure, not a native ACK. */
export async function closeResidentBenchmarkNativeAfterDrain(
  drain: Promise<unknown> | undefined,
  close: () => Promise<{ closed: boolean }>,
): Promise<{ closed: boolean }> {
  if (drain) await drain.catch(() => undefined);
  return close();
}

/** Evaluator-only mechanical source; never an actor library or competence baseline. */
export const RESIDENT_BENCHMARK_SOURCE = `const held = {forward:true,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:true};
export function step(frame,state,intent) {
  if (frame.screen !== null) throw new Error("Prepared mechanical controller requires an absent GUI");
  const use = frame.player.active_use;
  if (state.started && frame.last_input && frame.last_input.held.use &&
      (!use || use.item !== "bow" || state.last_use !== null && use.elapsed_ticks < state.last_use))
    throw new Error("Actual ordinary held bow use ended or restarted");
  return {input:{kind:"world",held,edges:state.started?[]:[
    {kind:"button",button:"forward",phase:"press",count:1},
    {kind:"button",button:"use",phase:"press",count:1}],
    view:{kind:"rate",yaw_radians_per_second:0.25,pitch_radians_per_second:0},selected_hotbar:state.started?null:0},
    next_state:{started:true,count:state.count+1,last_use:use?use.elapsed_ticks:null},status:"running",events:[]};
}
`;
/** Prospective technical E01 allocation; root, windows and cleanup remain separate. */
export const RESIDENT_BENCHMARK_SLOT_WALL_MS = 300_000;
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const residentBenchmarkProtocolSchema = z
  .object({
    schema_version: z.literal(3),
    timing_capture: z.literal("full_window_native_and_resident_streams"),
    mode: z.enum(["cohort", "calibration"]),
    warmup_ms: integer,
    measurement_ms: integer,
    root_ms: integer,
    step_ms: integer,
    measured_frontier: z.literal(
      "settle_within_original_root_before_evaluator_stop",
    ),
    history_records: integer,
    history_interval_ms: integer,
    acceptance: z
      .object({
        p95_ms: z.number().positive().finite(),
        p99_ms: z.number().positive().finite(),
        max_gap_ms: integer,
      })
      .strict(),
    recording: z
      .object({
        maxDurationMs: integer,
        maxFrames: integer,
        maxStoredFrameBytes: integer,
        maxPendingRawBytes: integer,
      })
      .strict(),
    journal: z
      .object({ maxTextBytes: integer, maxPendingBytes: integer })
      .strict(),
  })
  .strict();
export type ResidentBenchmarkProtocol = z.infer<
  typeof residentBenchmarkProtocolSchema
>;
export const DEFAULT_RESIDENT_BENCHMARK_PROTOCOL: Readonly<ResidentBenchmarkProtocol> =
  Object.freeze({
    schema_version: 3,
    timing_capture: "full_window_native_and_resident_streams",
    mode: "cohort",
    warmup_ms: 30000,
    measurement_ms: 120000,
    root_ms: 165000,
    step_ms: 25,
    history_records: 4096,
    history_interval_ms: 2000,
    measured_frontier: "settle_within_original_root_before_evaluator_stop",
    acceptance: Object.freeze({ p95_ms: 50, p99_ms: 100, max_gap_ms: 1000 }),
    recording: Object.freeze({
      maxDurationMs: 180000,
      maxFrames: 6000,
      maxStoredFrameBytes: 8 * 1024 ** 3,
      maxPendingRawBytes: 128 * 1024 ** 2,
    }),
    journal: Object.freeze({
      maxTextBytes: 256 * 1024 ** 2,
      maxPendingBytes: 16 * 1024 ** 2,
    }),
  });
export interface ResidentBenchmarkCell {
  frequency_hz: 1 | 5 | 20;
  delay_ms: 15000 | 30000 | 90000;
  repetition: number;
}
function benchmarkCells(
  mode: "cohort" | "calibration",
): ResidentBenchmarkCell[] {
  // Logical repetition 2 matches the failed cell; calibration still has one attempt.
  if (mode === "calibration")
    return [{ frequency_hz: 20, delay_ms: 30000, repetition: 2 }];
  const rates: (1 | 5 | 20)[] = [1, 5, 20],
    delays: (15000 | 30000 | 90000)[] = [15000, 30000, 90000];
  const cells: ResidentBenchmarkCell[] = [];
  for (const rate of rates)
    for (const delay of delays)
      for (let repetition = 1; repetition <= 3; repetition++)
        cells.push({ frequency_hz: rate, delay_ms: delay, repetition });
  return cells;
}
export function residentBenchmarkSchedule(
  studyId: string,
  mode: "cohort" | "calibration",
): StudyManifest["schedule"] {
  return benchmarkCells(mode).map((cell, order) => ({
    slot: {
      study_id: studyId,
      arm: `hertz_${cell.frequency_hz}`,
      initial_state_id: `delay_${cell.delay_ms}`,
      repetition: cell.repetition,
    },
    order,
    group: `delay_${cell.delay_ms}`,
    optional_block: null,
  }));
}
function requireDeclaration(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
function checkedText(root: string, identity: { path: string; sha256: string }) {
  const bytes = readFileSync(resolve(root, identity.path));
  requireDeclaration(
    createHash("sha256").update(bytes).digest("hex") === identity.sha256,
    "Benchmark identity changed while reading",
  );
  return bytes.toString("utf8");
}
export function validateResidentBenchmarkDeclaration(
  input: unknown,
  options: { projectRoot: string },
) {
  const manifest = validateStudyManifest(input, options);
  requireDeclaration(
    manifest.execution.controller_mode === "resident_platform",
    "Benchmark requires the explicit zero-provider platform variant",
  );
  const protocol = residentBenchmarkProtocolSchema.parse(
    JSON.parse(checkedText(options.projectRoot, manifest.task.verifier)),
  );
  requireDeclaration(
    protocol.warmup_ms === 30000 &&
      protocol.measurement_ms === 120000 &&
      protocol.root_ms === 165000 &&
      protocol.step_ms === 25,
    "E01 requires full 30-second warmup, 120-second measurement and the declared original root/compute bounds",
  );
  requireDeclaration(
    protocol.history_records === 4096 && protocol.history_interval_ms === 2000,
    "E01 load cannot be silently reduced",
  );
  requireDeclaration(
    protocol.acceptance.p95_ms === 50 &&
      protocol.acceptance.p99_ms === 100 &&
      protocol.acceptance.max_gap_ms === 1000,
    "New E01 declarations require capture-to-applied p95<=50ms/p99<=100ms; no infrastructure-caused one-second gap is acceptable",
  );
  const requiredRecording = DEFAULT_RESIDENT_BENCHMARK_PROTOCOL.recording,
    requiredJournal = DEFAULT_RESIDENT_BENCHMARK_PROTOCOL.journal;
  requireDeclaration(
    canonicalContractJson(protocol.recording) ===
      canonicalContractJson(requiredRecording) &&
      canonicalContractJson(protocol.journal) ===
        canonicalContractJson(requiredJournal),
    "Benchmark evidence capacities must match the frozen finite protocol",
  );
  requireDeclaration(
    manifest.task.horizon_ms === protocol.root_ms &&
      manifest.allowances.per_attempt.wall_ms ===
        RESIDENT_BENCHMARK_SLOT_WALL_MS &&
      manifest.allowances.cohort.workers === 1 &&
      manifest.allowances.cohort.elapsed_ms === 10_800_000,
    "Benchmark requires original root lifetime, one sequential native owner, a 300-second slot and a three-hour series including overhead",
  );
  const expected = residentBenchmarkSchedule(manifest.study_id, protocol.mode);
  // Maximum study label, not the number of calibration attempts.
  requireDeclaration(
    canonicalContractJson(manifest.schedule) ===
      canonicalContractJson(expected) &&
      manifest.optional_blocks.length === 0 &&
      manifest.repetitions === 3,
    "Benchmark schedule must retain every prescribed rate/delay/repetition in declared order",
  );
  const rates = protocol.mode === "cohort" ? [1, 5, 20] : [20],
    delays = protocol.mode === "cohort" ? [15000, 30000, 90000] : [30000];
  requireDeclaration(
    canonicalContractJson(manifest.arms.map((arm) => arm.id)) ===
      canonicalContractJson(rates.map((rate) => `hertz_${rate}`)) &&
      canonicalContractJson(
        manifest.initial_states.map((state) => state.id),
      ) === canonicalContractJson(delays.map((delay) => `delay_${delay}`)) &&
      manifest.initial_states.every(
        (state) => state.settings?.fresh_world_per_slot === true,
      ),
    "Benchmark cells require explicit fresh owned prepared arenas, not relabelled reused saves",
  );
  requireDeclaration(
    manifest.initial_states.every(
      (state) =>
        state.settings?.level_type === "minecraft:normal" &&
        state.settings.structures === true,
    ),
    "Fixed benchmark supports only minecraft:normal generation with structures=true",
  );
  requireDeclaration(
    manifest.identities.controller !== null,
    "Benchmark requires its checked mechanical source",
  );
  const source = checkedText(
    options.projectRoot,
    manifest.identities.controller,
  );
  requireDeclaration(
    source === RESIDENT_BENCHMARK_SOURCE,
    "Benchmark must use its exact declared evaluator mechanical source, not an alternate actor or tactic",
  );
  const cells = benchmarkCells(protocol.mode);
  return { manifest, protocol, cells, source };
}

/** Whitelist only; never retain seed, RCON or unrelated server configuration. */
export function checkResidentBenchmarkWorldProperties(properties: string) {
  const expected = {
    gamemode: "survival",
    "force-gamemode": "true",
    difficulty: "normal",
    hardcore: "false",
    "level-type": "minecraft:normal",
    "generate-structures": "true",
  };
  const actual: Record<string, string> = {};
  for (const line of properties.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    if (!Object.hasOwn(expected, key)) continue;
    requireDeclaration(
      !Object.hasOwn(actual, key),
      "Duplicate selected world property",
    );
    actual[key] = line.slice(separator + 1).replaceAll("\\:", ":");
  }
  requireDeclaration(
    Object.entries(expected).every(([key, value]) => actual[key] === value),
    "Actual owned server properties differ from supported declared normal survival world settings",
  );
  return actual;
}

export function residentBenchmarkSummary(
  values: readonly number[],
  omittedSamples = 0,
) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? null,
    omitted_samples: omittedSamples,
  };
}

interface BenchmarkSubmission {
  host_ms: number;
  captured_host_ms: number;
  frame_seq: number;
  result: InputSubmission;
}
interface BenchmarkApplication {
  received_host_ms: number;
  age_ms: number | null;
  ack: {
    sequence: number;
    input_application: "confirmed" | "partial" | "unknown";
  };
}
/** Select decisions by frame admission, not ACK receipt. Called after the actual drain. */
export function residentBenchmarkDecisionPopulation(options: {
  start: number;
  end: number;
  submissions: readonly BenchmarkSubmission[];
  acks: readonly BenchmarkApplication[];
  terminalReason: string | null;
  frames?: readonly { frame_seq: number; captured_host_ms: number }[];
}) {
  const applications = new Map<number, BenchmarkApplication[]>();
  for (const ack of options.acks) {
    const rows = applications.get(ack.ack.sequence) ?? [];
    rows.push(ack);
    applications.set(ack.ack.sequence, rows);
  }
  const replaced = new Set(
    options.submissions
      .filter((row) => row.result.status === "coalesced")
      .map((row) => row.result.sequence - 1),
  );
  const submittedFrames = new Set(
    options.submissions.map((row) => row.frame_seq),
  );
  const candidates: Array<{
    frame_seq: number;
    captured_host_ms: number;
    host_ms: number | null;
    result: InputSubmission | null;
  }> = [
    ...options.submissions,
    ...(options.frames ?? [])
      .filter((row) => !submittedFrames.has(row.frame_seq))
      .map((row) => ({ ...row, host_ms: null, result: null })),
  ];
  const decisions = candidates
    .filter(
      (row) =>
        row.captured_host_ms >= options.start &&
        row.captured_host_ms < options.end,
    )
    .sort((a, b) => a.captured_host_ms - b.captured_host_ms)
    .map((row) => {
      const acks =
        row.result === null || row.result.status === "rejected"
          ? []
          : (applications.get(row.result.sequence) ?? []);
      const confirmed = acks.find(
        (ack) =>
          ack.ack.input_application === "confirmed" && ack.age_ms !== null,
      );
      const disposition =
        row.result?.status === "rejected"
          ? "refused"
          : confirmed
            ? "confirmed"
            : acks.some((ack) => ack.ack.input_application === "unknown")
              ? "unknown"
              : acks.some((ack) => ack.ack.input_application === "partial")
                ? "partial"
                : row.result !== null && replaced.has(row.result.sequence)
                  ? "coalesced"
                  : options.terminalReason ===
                      "benchmark_full_original_window_completed"
                    ? "terminal_censored"
                    : options.terminalReason !== null
                      ? "cancelled"
                      : "unconfirmed";
      return {
        ...row,
        disposition,
        age_ms: confirmed?.age_ms ?? null,
        confirmed_received_host_ms: confirmed?.received_host_ms ?? null,
        terminal_reason:
          disposition === "confirmed" ? null : options.terminalReason,
        acks,
      };
    });
  const confirmed = decisions.filter((row) => row.disposition === "confirmed");
  const unconfirmed = decisions.length - confirmed.length;
  return {
    admitted_decisions: decisions.length,
    confirmed_decisions: confirmed.length,
    unconfirmed_decisions: unconfirmed,
    confirmed_after_window: confirmed.filter(
      (row) => row.confirmed_received_host_ms! >= options.end,
    ).length,
    full_population_confirmed: decisions.length > 0 && unconfirmed === 0,
    input_age_ms: residentBenchmarkSummary(
      confirmed.map((row) => row.age_ms!),
      unconfirmed,
    ),
    decisions,
  };
}

type BenchmarkRootAuthority = {
  signal: AbortSignal;
  deadline_host_ms: number;
  current: () => boolean;
};

/** State can change before the next controller operation; running status is not native scope. */
export function residentBenchmarkNativeScopeCurrent(
  actual: GameState,
  original: Pick<
    EffectScope,
    | "world_id"
    | "session_id"
    | "native_boot_id"
    | "epoch"
    | "life_id"
    | "space_epoch"
  >,
): boolean {
  return (
    actual.status === "connected" &&
    actual.error === null &&
    actual.binding?.ready === true &&
    actual.binding.native_boot_id === original.native_boot_id &&
    actual.world_id === original.world_id &&
    actual.session_id === original.session_id &&
    actual.epoch === original.epoch &&
    actual.life?.status === "alive" &&
    actual.life.life_id === original.life_id &&
    actual.space?.space_epoch === original.space_epoch
  );
}

/** Recheck after synchronous readers too: they can outlast a deadline or revoke authority. */
export function assertResidentBenchmarkRootCurrent(
  options: BenchmarkRootAuthority,
): void {
  options.signal.throwIfAborted();
  if (
    !Number.isFinite(options.deadline_host_ms) ||
    performance.now() >= options.deadline_host_ms ||
    !options.current()
  )
    throw new Error(
      "Original measured-input root closed or expired before settlement",
    );
  options.signal.throwIfAborted();
  if (performance.now() >= options.deadline_host_ms)
    throw new Error(
      "Original measured-input deadline elapsed during authority validation",
    );
}

/** Choose evaluator-planned Stop only after measured inputs settle, never defer an actual Stop. */
export async function settleResidentBenchmarkMeasuredInputs(
  population: () => ReturnType<typeof residentBenchmarkDecisionPopulation>,
  options: BenchmarkRootAuthority,
) {
  for (;;) {
    assertResidentBenchmarkRootCurrent(options);
    const observed = population();
    assertResidentBenchmarkRootCurrent(options);
    if (observed.full_population_confirmed) return observed;
    if (
      observed.admitted_decisions === 0 ||
      observed.decisions.some(
        (row) =>
          row.disposition !== "confirmed" && row.disposition !== "unconfirmed",
      )
    )
      throw new Error(
        "Measured inputs cannot be confirmed; terminal dispositions remain unchanged",
      );
    await waitResidentBenchmarkUntil(
      Math.min(options.deadline_host_ms, performance.now() + 25),
      options.signal,
    );
  }
}
