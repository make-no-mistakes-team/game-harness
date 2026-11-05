import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { canonicalContractJson } from "../server/adapter-contract.ts";
import {
  DEFAULT_RESIDENT_BENCHMARK_PROTOCOL,
  RESIDENT_BENCHMARK_SLOT_WALL_MS,
  RESIDENT_BENCHMARK_SOURCE,
  residentBenchmarkProtocolSchema,
  residentBenchmarkSchedule,
  validateResidentBenchmarkDeclaration,
  type ResidentBenchmarkCell,
  type ResidentBenchmarkProtocol,
} from "./resident-benchmark.ts";
import { validateStudyManifest, type StudyManifest } from "./studies.ts";

export const P13_VOLUME_ACTIONS = Object.freeze([
  30, 300, 3000, 10000, 60000,
] as const);
export type P13Volume = (typeof P13_VOLUME_ACTIONS)[number];
export const P13_VOLUME_CLASSIFICATION =
  "P13_volume_technical_assay_not_E01_acceptance" as const;

const volumeActionsSchema = z.tuple([
  z.literal(30),
  z.literal(300),
  z.literal(3000),
  z.literal(10000),
  z.literal(60000),
]);
const epochMs = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nanoseconds = z
  .string()
  .max(40)
  .regex(/^[1-9][0-9]*$/);
const workflowAuthoritySchema = z
  .object({
    path: z.string().trim().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const p13VolumeProtocolSchema = residentBenchmarkProtocolSchema
  .extend({
    schema_version: z.literal(4),
    mode: z.literal("p13_volume"),
    volume_actions: volumeActionsSchema,
    workload: z
      .object({
        corpus: z.literal("raw_admitted_terminal_owned_actions"),
        initial_projection: z.literal("measurement_only"),
        late_update_offsets_ms: z.tuple([
          z.literal(20000),
          z.literal(40000),
          z.literal(60000),
          z.literal(80000),
          z.literal(100000),
        ]),
        sample_interval_ms: z.literal(2000),
        memory_interval_ms: z.literal(1000),
        raw_seed_actions_per_turn: z.literal(16),
        page_limit: z.literal(8),
        feedback_limit: z.literal(16),
      })
      .strict(),
    workflow: z
      .object({
        authority: workflowAuthoritySchema,
        started_epoch_ms: epochMs,
        deadline_epoch_ms: epochMs,
        started_monotonic_ns: nanoseconds,
        deadline_monotonic_ns: nanoseconds,
        includes_preparation_and_playback: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type P13VolumeProtocol = z.infer<typeof p13VolumeProtocolSchema>;
export type ResidentTimingProtocol =
  ResidentBenchmarkProtocol | P13VolumeProtocol;
export type ResidentTimingCell = ResidentBenchmarkCell & {
  actions?: P13Volume;
};
export type ValidatedResidentTimingAssay =
  | {
      assay: "e01";
      manifest: StudyManifest;
      protocol: ResidentBenchmarkProtocol;
      cells: ResidentBenchmarkCell[];
      source: string;
    }
  | {
      assay: "p13_volume";
      manifest: StudyManifest;
      protocol: P13VolumeProtocol;
      cells: (ResidentBenchmarkCell & { actions: P13Volume })[];
      source: string;
    };

// The checked permission file is the operator-controlled authority, not a
// shipped user grant. Registration must retain its wall/OS-monotonic pair,
// including the sub-millisecond part, rather than renew a study allowance.
const originalAuthoritySchema = z
  .object({
    schema_version: z.literal(1),
    authorization: z.string().trim().min(1).max(4096),
    allowed_volumes: volumeActionsSchema,
    native_slots_max: z.literal(5),
    automatic_retries: z.literal(false),
    full27_e01_authorized: z.literal(false),
    llm_jev_allowed: z.literal(false),
    audio_allowed: z.literal(false),
    selected_control_hz: z.literal(20),
    warmup_ms: z.literal(30000),
    measurement_ms: z.literal(120000),
    root_ms: z.literal(165000),
    slot_ms: z.literal(300000),
    overall_cleanup_reserve_ms: z.literal(25000),
    series_ms: z.literal(10800000),
    workflow_started_wall_ns: nanoseconds,
    workflow_started_monotonic_ns: nanoseconds,
    workflow_deadline_wall_ns: nanoseconds,
    workflow_deadline_monotonic_ns: nanoseconds,
    deadline_policy: z.string().trim().min(1).max(4096),
  })
  .strict();

function requireDeclaration(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function checkedText(
  root: string,
  identity: { path: string; sha256: string },
): string {
  const bytes = readFileSync(resolve(root, identity.path));
  requireDeclaration(
    createHash("sha256").update(bytes).digest("hex") === identity.sha256,
    "Resident timing identity changed while reading",
  );
  return bytes.toString("utf8");
}

export function residentTimingSchedule(
  studyId: string,
  protocol: ResidentTimingProtocol,
): StudyManifest["schedule"] {
  if (protocol.mode !== "p13_volume")
    return residentBenchmarkSchedule(studyId, protocol.mode);
  return P13_VOLUME_ACTIONS.map((actions, order) => ({
    slot: {
      study_id: studyId,
      arm: "hertz_20",
      initial_state_id: `history_actions_${actions}`,
      repetition: 2,
    },
    order,
    group: `history_actions_${actions}`,
    optional_block: null,
  }));
}

export function residentTimingWorkflowBounds(
  protocol: ResidentTimingProtocol,
): {
  deadlineEpochMs: number;
  deadlineMonotonicNs: bigint;
} | null {
  if (protocol.mode !== "p13_volume") return null;
  return {
    deadlineEpochMs: protocol.workflow.deadline_epoch_ms,
    deadlineMonotonicNs: BigInt(protocol.workflow.deadline_monotonic_ns),
  };
}

/** Closure is a joined owner plus observed child exit and stdout drain, not a flag. */
export function residentVolumeCleanupConfirmed(value: unknown): boolean {
  const record = (entry: unknown): entry is Record<string, unknown> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry);
  if (
    !record(value) ||
    value.closed !== true ||
    value.learning_closed !== true ||
    value.reader_closed !== true ||
    value.tasks_joined !== true
  )
    return false;
  const owner = value.reader_owner;
  if (
    !record(owner) ||
    owner.closed !== true ||
    owner.active !== false ||
    owner.queued !== 0
  )
    return false;
  const child = owner.child;
  if (child === null) return true;
  if (
    !record(child) ||
    typeof child.pid !== "number" ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 0
  )
    return false;
  return [
    "exitObservedHostMs",
    "stdoutDrainObservedHostMs",
    "closedHostMs",
  ].every((field) => {
    const timestamp = child[field];
    return (
      typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      timestamp >= 0
    );
  });
}

export function validateResidentTimingAssay(
  input: unknown,
  options: { projectRoot: string },
): ValidatedResidentTimingAssay {
  // Generic validation owns file confinement, complete source/build/profile
  // inventories and zero-provider capability checks for both assay families.
  const manifest = validateStudyManifest(input, options);
  const declaration: unknown = JSON.parse(
    checkedText(options.projectRoot, manifest.task.verifier),
  );
  if (!(
    declaration &&
    typeof declaration === "object" &&
    "mode" in declaration &&
    declaration.mode === "p13_volume"
  )) {
    return {
      assay: "e01",
      ...validateResidentBenchmarkDeclaration(input, options),
    };
  }
  const protocol = p13VolumeProtocolSchema.parse(declaration);
  requireDeclaration(
    manifest.execution.controller_mode === "resident_platform",
    "P13 requires the explicit zero-provider resident platform variant",
  );
  const expected = DEFAULT_RESIDENT_BENCHMARK_PROTOCOL;
  requireDeclaration(
    protocol.warmup_ms === expected.warmup_ms &&
      protocol.measurement_ms === expected.measurement_ms &&
      protocol.root_ms === expected.root_ms &&
      protocol.step_ms === expected.step_ms &&
      protocol.history_records === expected.history_records &&
      protocol.history_interval_ms === expected.history_interval_ms &&
      canonicalContractJson(protocol.acceptance) ===
        canonicalContractJson(expected.acceptance) &&
      canonicalContractJson(protocol.recording) ===
        canonicalContractJson(expected.recording) &&
      canonicalContractJson(protocol.journal) ===
        canonicalContractJson(expected.journal),
    "P13 must preserve the exact E01 timing, 4096-event load, acceptance and full-stream evidence capacities",
  );
  requireDeclaration(
    manifest.task.horizon_ms === expected.root_ms &&
      manifest.allowances.per_attempt.wall_ms ===
        RESIDENT_BENCHMARK_SLOT_WALL_MS &&
      manifest.allowances.per_attempt.workers === 1 &&
      manifest.allowances.cohort.workers === 1 &&
      manifest.allowances.cohort.attempt_wall_ms ===
        RESIDENT_BENCHMARK_SLOT_WALL_MS * P13_VOLUME_ACTIONS.length &&
      manifest.allowances.cohort.elapsed_ms === 10800000,
    "P13 requires five sequential 300-second slots under the original three-hour workflow",
  );
  requireDeclaration(
    canonicalContractJson(manifest.schedule) ===
      canonicalContractJson(
        residentTimingSchedule(manifest.study_id, protocol),
      ) &&
      manifest.optional_blocks.length === 0 &&
      manifest.repetitions === 3,
    "P13 schedule requires exactly five ordered 20Hz/30-second logical repetition-2 cells without optional blocks",
  );
  requireDeclaration(
    canonicalContractJson(manifest.arms.map((arm) => arm.id)) ===
      canonicalContractJson(["hertz_20"]) &&
      canonicalContractJson(
        manifest.initial_states.map((state) => state.id),
      ) ===
        canonicalContractJson(
          P13_VOLUME_ACTIONS.map((actions) => `history_actions_${actions}`),
        ) &&
      manifest.initial_states.every(
        (state) =>
          state.settings?.fresh_world_per_slot === true &&
          state.settings.level_type === "minecraft:normal" &&
          state.settings.structures === true,
      ),
    "P13 requires one 20Hz arm and five explicit-volume fresh normal worlds with structures",
  );
  requireDeclaration(
    canonicalContractJson(protocol.workflow.authority) ===
      canonicalContractJson(manifest.permission.record),
    "P13 workflow authority must be the original checked permission record",
  );
  const authority = originalAuthoritySchema.parse(
    JSON.parse(checkedText(options.projectRoot, protocol.workflow.authority)),
  );
  const startWallNs = BigInt(authority.workflow_started_wall_ns);
  const deadlineWallNs = BigInt(authority.workflow_deadline_wall_ns);
  const startMonotonicNs = BigInt(authority.workflow_started_monotonic_ns);
  const deadlineMonotonicNs = BigInt(authority.workflow_deadline_monotonic_ns);
  requireDeclaration(
    deadlineWallNs - startWallNs === 10800000000000n &&
      deadlineMonotonicNs - startMonotonicNs === 10800000000000n &&
      protocol.workflow.started_epoch_ms === Number(startWallNs / 1000000n) &&
      protocol.workflow.deadline_epoch_ms ===
        Number(deadlineWallNs / 1000000n) &&
      protocol.workflow.deadline_epoch_ms -
        protocol.workflow.started_epoch_ms ===
        10800000 &&
      protocol.workflow.started_monotonic_ns ===
        authority.workflow_started_monotonic_ns &&
      protocol.workflow.deadline_monotonic_ns ===
        authority.workflow_deadline_monotonic_ns,
    "P13 workflow must retain the original conservative wall and OS-monotonic clocks; registration cannot renew authority",
  );
  requireDeclaration(
    manifest.identities.controller !== null,
    "P13 requires its checked mechanical source",
  );
  const source = checkedText(
    options.projectRoot,
    manifest.identities.controller,
  );
  requireDeclaration(
    source === RESIDENT_BENCHMARK_SOURCE,
    "P13 must preserve the exact evaluator mechanical source",
  );
  return {
    assay: "p13_volume",
    manifest,
    protocol,
    cells: P13_VOLUME_ACTIONS.map((actions) => ({
      frequency_hz: 20,
      delay_ms: 30000,
      repetition: 2,
      actions,
    })),
    source,
  };
}
