import { z } from "zod";
import type {
  ActivityEvent,
  AppSnapshot,
  AuthState,
  Json,
  ProgramEvidenceView,
  RunView,
  AdapterGoal,
} from "../../src/shared/contracts.ts";
import type {
  ExperienceView,
  PromotionDeclaration,
} from "../../src/server/experience.ts";
import type { HistoryPage } from "../../src/server/history-protocol.ts";
import type {
  ImprovementFeedbackCursor,
  ObjectiveMetricUpdate,
  ProgramVersionEvidence,
  TracePage,
  VersionComparison,
  VersionComparisonCursor,
} from "../../src/shared/execution-evidence.ts";
import type { PlanProjection } from "../../src/shared/planning.ts";
import { adapterBindingSchema, activeExecutableValidationSchema, historicalExecutableValidationSchema, programCompatibilitySchema } from "../../src/shared/adapter.ts";
import { effectInvocationSchema, effectScopeSchema, screenRefSchema, spaceRefSchema } from "../../src/shared/control.ts";
import { adapterActorProjectionSchema } from "../../src/shared/observations.ts";
import { goalSchema, gameActionSchema } from "../../src/shared/validation.ts";
import { residentLimitsSchema, residentSnapshotSchema, residentStateSchema } from "../../src/shared/resident.ts";
import { PREPARED_START_LIMITS, preparedStartRequestSchema, type PreparedStartRequest, type PreparedStartView } from "../../src/shared/prepared-start.ts";

const nullableText = z.string().nullable();
const historyProjectionSchema = z.object({
  generation: z.int().nonnegative(), source_through: z.int().nonnegative(),
  source_available: z.int().nonnegative(), has_pending: z.boolean(),
}).refine(value => value.source_available >= value.source_through &&
  (value.has_pending || value.source_available === value.source_through));
const lineage = {
  session_id: nullableText,
  life_id: z.number().int().nonnegative().nullable(),
};
const life = z.object({
  life_id: z.number().int().nonnegative(),
  status: z.enum(["loading", "alive", "dead", "respawning"]),
  can_respawn: z.boolean(),
  death: z.object({
    death_id: z.string(),
    at: z.string(),
    message: nullableText,
  }).nullable(),
});
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
export const eventSchema: z.ZodType<ActivityEvent> = z.object({
  event_seq: z.number().int(),
  run_id: nullableText,
  at: z.string(),
  type: z.string(),
  summary: z.string(),
  details: json,
});
const card = z.object({
  purpose: z.string(),
  applicability: z.string(),
  method: z.string(),
  reason: z.string(),
  limitations: z.string(),
});
const auth: z.ZodType<AuthState> = z.object({
  status: z.enum([
    "signed_out",
    "authorizing",
    "discovering",
    "ready",
    "unavailable",
    "error",
  ]),
  authenticated: z.boolean(),
  provider: z.literal("openai-codex"),
  account_label: nullableText,
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      provider: z.string(),
      context_window: z.number().nullable(),
      input_modalities: z.array(z.string()).optional(),
      capability_provenance: z.literal("discovered_sdk_descriptor_not_live_vision").optional(),
    }),
  ),
  login: z
    .object({
      id: z.string(),
      mode: z.enum(["browser", "device"]),
      url: nullableText,
      instructions: nullableText,
      prompt: z
        .object({
          label: z.string(),
          secret: z.boolean(),
          allow_empty: z.boolean(),
        })
        .nullable(),
    })
    .nullable(),
  error: nullableText,
});
const skillRef = z.object({ skill_id: z.string(), version: z.number().int() });
const limits = z.object({
  duration_ms: z.number(),
  max_actions: z.number(),
  max_calls: z.number(),
  max_depth: z.number(),
});
const skill = skillRef.extend({
  entry: z.enum(["run", "step", "analyze", "library"]).optional(),
  name: z.string(),
  source: z.string(),
  hash: z.string(),
  card,
  dependencies: z.array(skillRef.extend({ import_path: z.string().optional() })),
  parent_version: z.number().nullable(),
  state: z.enum(["validated", "quarantined", "retired"]),
  validation: z.object({
    fingerprint: z.string(),
    formatted_lines: z.number(),
    complexity: z.number(),
    nesting: z.number(),
    runtime_version: z.number().optional(),
    api_version: z.number().int().positive().optional(),
    validator_version: z.number().int().positive().optional(),
    compatibility_hash: z.string().optional(),
    runtime_features: z.array(z.literal("pure_modules_v1")).max(1).optional(),
  }),
  created_at: z.string(),
});
const executionBase = skillRef.extend({
  ...lineage,
  world_id: nullableText,
  native_boot_id: nullableText,
  run_generation: z.number().nullable(),
  space_epoch: z.number().nullable(),
  source_hash: nullableText,
  compatibility_hash: nullableText,
  execution_id: z.string(),
  run_id: z.string(),
  start_key: z.string(),
  parent_execution_id: nullableText,
  root_execution_id: z.string(),
  epoch: z.number(),
  args: json,
  status: z.enum([
    "accepted",
    "running",
    "cancel_requested",
    "succeeded",
    "blocked",
    "failed",
    "cancelled",
    "unknown",
  ]),
  started_at: nullableText,
  ended_at: nullableText,
  deadline_at: z.string(),
  actions: z.number(),
  calls: z.number(),
  result: z
    .object({
      status: z.enum(["completed", "blocked", "failed"]),
      summary: z.string(),
      result: json,
    })
    .nullable(),
  error: nullableText,
  diagnostic: z.object({ type: z.string(), message: z.string(), source_hash: z.string(),
    location: z.object({ mapping: z.literal("unmapped") }), code: z.string().optional(),
    output: z.object({ phase: z.literal("terminal_result"),
      reason: z.enum(["utf8_bytes", "json_depth", "json_serialization"]),
      maximum_bytes: z.literal(65536), actual_bytes: z.number().int().nonnegative().nullable(),
      completed_capability_calls: z.number().int().nonnegative() }).optional(),
  }).optional(),
});
const execution = z.discriminatedUnion("entry", [
  executionBase.extend({ entry: z.literal("run"), limits }),
  executionBase.extend({ entry: z.literal("step"), limits: residentLimitsSchema, initial_state: residentStateSchema,
    resident: residentSnapshotSchema.nullable() }),
  executionBase.extend({ entry: z.null(), limits }),
]);
const tokenUsage = z.object({
  uncached_input: z.number().nullable(),
  cache_read: z.number().nullable(),
  cache_write: z.number().nullable(),
  output: z.number().nullable(),
  calls: z.number().nullable(),
  known_cost: z.number().nullable(),
  legacy_input: z.number().nullable(),
});
const runUsage = tokenUsage.extend({
  accounting_basis: z.literal("sdk_reported_subtotal"),
  by_purpose: z.object({
    authoring: tokenUsage,
    planning: tokenUsage,
    replanning: tokenUsage,
    improvement: tokenUsage,
    other: tokenUsage,
  }),
});
const preparedStart: z.ZodType<PreparedStartView> = preparedStartRequestSchema.omit({ request_id: true }).extend({
  preparation_id: z.string().min(1),
  phase: z.enum(["authoring", "compiling", "ready", "joining", "activating", "started", "cancelling", "cancelled", "failed"]),
  started_at: z.iso.datetime(),
  deadline_at: z.iso.datetime(),
  ready_at: z.iso.datetime().nullable(),
  run_id: nullableText,
  requests_admitted: z.int().nonnegative(),
  tools_used: z.int().nonnegative(),
  source_versions: z.int().nonnegative(),
  analysis_jobs: z.int().nonnegative(),
  analysis_ms: z.number().nonnegative(),
  program: z.object({ name: z.string(), version: z.int().positive() }).nullable(),
  usage: runUsage,
  limits: z.object({
    duration_ms: z.int().positive(),
    max_requests: z.int().positive(),
    max_tools: z.int().positive(),
    max_source_versions: z.literal(PREPARED_START_LIMITS.max_source_versions),
    max_source_bytes: z.literal(PREPARED_START_LIMITS.max_source_bytes),
    max_analysis_jobs: z.literal(PREPARED_START_LIMITS.max_analysis_jobs),
    analysis_job_ms: z.literal(PREPARED_START_LIMITS.analysis_job_ms),
    max_analysis_ms: z.literal(PREPARED_START_LIMITS.max_analysis_ms),
  }),
  closure: z.enum(["open", "draining", "closed", "transferred", "unknown"]),
  error: nullableText,
});
const actionInput = gameActionSchema;
const decision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue"), reason: z.string().optional() }),
  z.object({ kind: z.literal("replan"), reason: z.string() }),
  z.object({ kind: z.literal("interrupt"), reason: z.string() }),
  z.object({
    kind: z.literal("replace"),
    action: actionInput,
    reason: z.string(),
  }),
]);
const run: z.ZodType<RunView> = z.object({
  ...lineage,
  native_boot_id: nullableText,
  space_epoch: z.number().nullable(),
  compatibility_hash: nullableText,
  run_id: z.string(),
  world_id: z.string(),
  epoch: z.number(),
  task: z.string(),
  goal: z.union([goalSchema, z.enum([
    "break_log",
    "collect_wood",
    "craft_crafting_table",
    "craft_stone_pickaxe",
    "custom",
  ])]),
  model_id: z.string(),
  status: z.enum([
    "created",
    "bootstrapping",
    "running",
    "reviewing",
    "pausing",
    "paused",
    "stopping",
    "stopped",
    "completed",
    "failed",
  ]),
  started_at: nullableText,
  ended_at: nullableText,
  turns: z.number(),
  model_status: z.enum(["idle", "thinking", "waiting", "error"]),
  operator: z.object({
    state: z.enum(["created", "bootstrapping", "running", "reviewing", "pausing", "paused", "stopping",
      "stopped", "completed", "failed", "acting", "executing", "thinking", "waiting", "recovering", "blocked", "provider_unavailable"]),
    pause_cause: z.enum(["operator", "provider_failure", "provider_aborted", "deadline",
      "observation_unavailable", "preparation_failed", "safety"]).nullable(),
    cleanup_error: nullableText,
    completion: z.enum(["verified", "model_reported_unverified"]).nullable(),
    progress: z.object({
      event_seq: z.number().int(), at: z.string(), summary: z.string(), execution_id: nullableText,
      source: z.literal("model_program"), verification: z.literal("unverified"),
    }).nullable(),
  }),
  action: z
    .object({
      ...lineage,
      scope: effectScopeSchema.nullable(),
      invocation: effectInvocationSchema.nullable(),
      compatibility_hash: nullableText,
      action_id: z.string(),
      kind: z.string(),
      status: z.enum([
        "accepted",
        "running",
        "cancel_requested",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
      ]),
      origin: z.enum(["strategist", "policy", "skill", "diagnostic"]),
      execution_id: nullableText,
      summary: z.string(),
      started_at: nullableText,
      ended_at: nullableText,
      result: z
        .object({
          status: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
          summary: z.string(),
          evidence: json,
          requires_reconnect: z.boolean().optional(),
        })
        .nullable(),
    })
    .nullable(),
  policies: z.array(
    z.object({
      backend: z.enum(["javascript", "jev"]),
      choices: z.array(z.object({ id: z.string(), decision })).nullable(),
      policy_id: z.string(),
      version: z.number(),
      name: z.string(),
      hash: z.string(),
      state: z.enum([
        "draft",
        "validated",
        "trial",
        "active",
        "quarantined",
        "retired",
      ]),
      source: z.string(),
      card,
      priority: z.number(),
      interval_ms: z.number(),
      evaluations: z.number(),
      effects: z.number(),
      last_error: nullableText,
      validation: z.union([activeExecutableValidationSchema, historicalExecutableValidationSchema]).optional(),
    }),
  ),
  skills: z.array(skill),
  executions: z.array(execution),
  error: nullableText,
  usage: runUsage,
});
const snapshot: z.ZodType<AppSnapshot> = z.object({
  auth,
  server: z.object({
    status: z.enum([
      "not_installed",
      "eula_required",
      "preparing",
      "stopped",
      "starting",
      "running",
      "error",
    ]),
    version: z.literal("1.21.4"),
    host: z.literal("127.0.0.1"),
    port: z.number(),
    world_id: nullableText,
    eula_accepted: z.boolean(),
    error: nullableText,
  }),
  game: z.object({
    status: z.enum(["disconnected", "connecting", "connected", "error"]),
    username: z.string(),
    version: z.string(),
    world_id: nullableText,
    epoch: z.number(),
    session_id: nullableText,
    life: life.nullable(),
    binding: adapterBindingSchema.nullable(),
    space: spaceRefSchema.nullable(),
    screen: screenRefSchema.nullable(),
    presentation: adapterActorProjectionSchema.nullable(),
    video: z.object({
      status: z.enum(["idle", "starting", "streaming", "stale", "error"]),
      width: z.number(),
      height: z.number(),
      fps: z.number().nullable(),
      frames: z.number(),
      last_frame_at: nullableText,
      error: nullableText,
    }),
    last_observation_at: nullableText,
    error: nullableText,
  }),
  sandbox: z.object({
    status: z.enum(["checking", "ready", "unavailable"]),
    image: z.string(),
    error: nullableText,
  }),
  run: run.nullable(),
  prepared_start: preparedStart.nullable(),
  goals: z.array(
    z.object({
      id: z.string(),
      goal: goalSchema,
      label: z.string(),
      prompt: z.string(),
    }),
  ),
  events: z.array(eventSchema),
});

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

async function request(
  path: string,
  body?: unknown,
  method?: "POST" | "DELETE",
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const deadline = window.setTimeout(() => controller.abort(), 90_000);
  try {
    if (body !== undefined && !csrfToken)
      throw new ApiError(
        "Local session is not connected. Reconnect before sending a command.",
        0,
        "session_missing",
      );
    const response = await fetch(path, {
      method: body === undefined ? "GET" : (method ?? "POST"),
      credentials: "same-origin",
      signal: signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal,
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken!,
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: unknown;
    try {
      data = response.status === 204 ? null : await response.json();
    } catch {
      throw new ApiError(
        "The local service returned an unreadable response. Check the backend and reconnect.",
        response.status,
        "invalid_response",
      );
    }
    if (!response.ok) {
      const error = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(data);
      throw new ApiError(
        error.success
          ? error.data.error.message
          : `Local service request failed (HTTP ${response.status}).`,
        response.status,
        error.success ? error.data.error.code : "request_failed",
      );
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      controller.signal.aborted
        ? "The local service did not respond in time. Command outcome is unknown; reconnect to inspect state before trying again."
        : "Cannot reach the local GameHarness service. Check that the backend is running, then reconnect.",
      0,
      "service_unavailable",
    );
  } finally {
    window.clearTimeout(deadline);
  }
}

export async function openSession(): Promise<void> {
  const parsed = z
    .object({ csrf_token: z.string().min(1) })
    .safeParse(await request("/v1/session"));
  if (!parsed.success)
    throw new ApiError(
      "The local service returned an invalid session. Reconnect after checking the backend.",
      0,
      "invalid_session",
    );
  csrfToken = parsed.data.csrf_token;
}

export async function fetchState(): Promise<AppSnapshot> {
  const parsed = snapshot.safeParse(await request("/v1/state"));
  if (!parsed.success)
    throw new ApiError(
      "State from the local service does not match this UI. Check that the backend and frontend use the same version.",
      0,
      "invalid_state",
    );
  return parsed.data;
}

export async function mutate(path: string, body: unknown = {}): Promise<void> {
  await request(path, body);
}

function preparationResponse(value: unknown): PreparedStartView {
  const parsed = preparedStart.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      "The service returned an unreadable preparation. Reconnect to inspect its state before starting another.",
      0,
      "invalid_preparation",
    );
  return parsed.data;
}

export async function prepareAndPlay(body: PreparedStartRequest): Promise<PreparedStartView> {
  return preparationResponse(await request("/v1/prepared-start", preparedStartRequestSchema.parse(body)));
}

export async function cancelPreparation(preparationId: string): Promise<PreparedStartView> {
  const id = z.string().min(1).parse(preparationId);
  return preparationResponse(await request(`/v1/prepared-start/${encodeURIComponent(id)}/cancel`, {}));
}

export async function createRun(body: {
  task: string;
  goal: AdapterGoal;
  model_id: string;
  experience_id?: string;
  working_programs: "continue" | "fresh";
}): Promise<RunView> {
  const parsed = run.safeParse(await request("/v1/runs", body));
  if (!parsed.success)
    throw new ApiError(
      "The service admitted a request but returned an unreadable run. Reconnect to inspect state before creating another run.",
      0,
      "invalid_run",
    );
  return parsed.data;
}

export async function fetchHistory(): Promise<RunView[]> {
  return z.object({ runs: z.array(run) }).parse(await request("/v1/runs")).runs;
}

export async function fetchJev() {
  return z
    .object({
      configured: z.boolean(),
      state: z.enum(["unavailable", "configured", "closed"]),
      selection: z.object({
        model_id: z.string(), request_timeout_ms: z.number(),
      }).nullable(),
      models: z.array(z.object({ id: z.string(), name: z.string() })),
      active_requests: z.number(),
      limits: z.object({
        max_concurrent: z.number(), requests_per_minute: z.number(),
        max_request_ms: z.number(), reactive_request_ms: z.number(), max_attempts: z.number(),
      }),
    })
    .parse(await request("/v1/jev"));
}

export async function setJevKey(key: string): Promise<void> {
  await request("/v1/jev", { key });
}

export async function removeJevKey(): Promise<void> {
  await request("/v1/jev", {}, "DELETE");
}

const predicate = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goal_verified"), event_seq: z.number().int() }),
  z.object({
    kind: z.literal("inventory_gain"),
    item: z.string(),
    min_gain: z.number(),
    event_seq: z.number().int(),
  }),
]);
const experienceSchema: z.ZodType<ExperienceView> = z.object({
  experience_id: z.string(),
  name: z.string(),
  model_id: z.string(),
  profile_id: z.string(),
  preset_id: z.string().optional(),
  source_run_id: z.string(),
  source_world_id: z.string(),
  portability: z.enum(["portable", "world_local"]),
  retained_world_data: z.boolean(),
  root: skillRef,
  created_at: z.string(),
  evidence: z.object({
    execution_id: z.string(),
    action_ids: z.array(z.string()),
    predicate,
  }),
  compatibility: z.union([programCompatibilitySchema, z.object({
    adapter_id: z.string(), game_version: z.string(), observation_schema: z.union([z.literal(1), z.literal(2)]),
    profile_id: z.string(), preset_id: z.string(), skill_protocol: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }).strict()]),
});

export async function fetchExperience(
  modelId: string,
): Promise<ExperienceView[]> {
  return z
    .object({ experience: z.array(experienceSchema) })
    .parse(
      await request(`/v1/experience?model_id=${encodeURIComponent(modelId)}`),
    ).experience;
}

export async function fetchRunEvents(
  runId: string,
  after: number,
): Promise<{
  events: ActivityEvent[];
  next_cursor: number;
  has_more: boolean;
  omitted_details: number[];
}> {
  return z
    .object({
      events: z.array(eventSchema),
      next_cursor: z.number().int(),
      has_more: z.boolean(),
      omitted_details: z.array(z.number().int()),
    })
    .parse(
      await request(
        `/v1/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=50`,
      ),
    );
}

export async function promoteExperience(
  runId: string,
  executionId: string,
  name: string,
  declaration: PromotionDeclaration,
): Promise<ExperienceView> {
  return experienceSchema.parse(
    await request(`/v1/runs/${encodeURIComponent(runId)}/experience`, {
      execution_id: executionId,
      name,
      declaration,
    }),
  );
}

export type SkillEvidencePage = HistoryPage<ProgramEvidenceView> & {
  projection: z.infer<typeof historyProjectionSchema>;
};

export async function fetchSkillEvidence(
  runId: string,
  after = 0,
  limit = 25,
  signal?: AbortSignal,
): Promise<SkillEvidencePage> {
  const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const query = z.object({
    after: count,
    limit: z.number().int().min(1).max(100),
  }).parse({ after, limit });
  const item: z.ZodType<ProgramEvidenceView> = z.object({
    execution_id: z.string(),
    skill_id: z.string(),
    version: z.number(),
    root_execution_id: z.string(),
    status: executionBase.shape.status,
    duration_ms: z.number().nullable(),
    actions: z.number(),
    calls: z.number(),
    strategic_requests: z.number(),
    confirmed_effects: z.number(),
    evidence_status: z.enum([
      "verified_goal",
      "verified_predicate",
      "confirmed_effects",
      "self_reported",
      "unknown",
    ]),
    verified_event_seqs: z.array(z.number().int()),
    compactness: skill.shape.validation,
  });
  return z
    .object({
      records: z.array(item).max(query.limit),
      next_after: count,
      has_more: z.boolean(),
      total: count,
      projection: historyProjectionSchema,
      omissions: z.array(z.object({
        index: count,
        reason: z.string(),
        original_bytes: count,
        reference: json.optional(),
        url: z.string().optional(),
      })).max(query.limit),
    })
    .refine(page => page.records.length + page.omissions.length <= query.limit)
    .parse(
      await request(
        `/v1/runs/${encodeURIComponent(runId)}/skill-evidence?after=${query.after}&limit=${query.limit}`,
        undefined,
        undefined,
        signal,
      ),
    );
}

const timingSummary = z.object({
  count: z.number().int().nonnegative(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  p99: z.number().nullable(),
  max: z.number().nullable(),
});
const performanceSchema = z.object({
  backend: z.object({
    sample_window_ms: z.number().nonnegative().nullable(),
    percentile_window_samples: z.number().int().positive(),
    cpu_percent_of_one_core: z.number().nullable(),
    rss_bytes: z.number().nonnegative(),
    event_loop_lag_ms: timingSummary,
    timings: z.object({
      observation_read_ms: timingSummary,
      action_round_trip_ms: timingSummary,
      video_forward_ms: timingSummary,
    }),
  }),
  video: z.object({
    status: z.enum(["idle", "starting", "streaming", "stale", "error"]),
    width: z.number(),
    height: z.number(),
    fps: z.number().nullable(),
    frames: z.number(),
    last_frame_at: nullableText,
    error: nullableText,
  }),
  video_transport: z.object({
    published_frames: z.number().int().nonnegative(),
    send_attempts: z.number().int().nonnegative(),
    queued_sends: z.number().int().nonnegative(),
    rejected_sends: z.number().int().nonnegative(),
    backpressure_skips: z.number().int().nonnegative(),
    drain_events: z.number().int().nonnegative(),
    clients: z.array(
      z.object({
        ready_state: z.number().int(),
        buffered_bytes: z.number().nonnegative(),
        last_sequence: z.number().int().nullable(),
      }),
    ),
  }),
  native: json,
});

export type PerformanceSnapshot = z.infer<typeof performanceSchema>;

export async function fetchPerformance(
  signal: AbortSignal,
): Promise<PerformanceSnapshot> {
  return performanceSchema.parse(
    await request("/v1/performance", undefined, undefined, signal),
  );
}

const versionEvidence = skillRef.extend({ run_id: z.string(), hash: z.string() });
const pauseCategory = z.enum(["native_action", "dispatch", "receipt", "readiness", "sandbox", "capability_wait", "strategic_request", "scheduler_handoff", "life_recovery"]);
const objectiveMetrics = z.object({
  execution_id: z.string(), root_execution_id: z.string(), outcome: z.string(),
  confirmed_block_removals: z.number(), removed_blocks: z.record(z.string(), z.number()),
  inventory_delta: z.record(z.string(), z.number()), inventory_receipts: z.number(),
  target_switches: z.number(), target_position_switches: z.number(),
  sampled_travel_distance: z.number(), sampled_rotation_degrees: z.number(),
  receipted_travel_distance: z.number(), receipted_rotation_degrees: z.number(),
  motion_receipts: z.number(),
  observation_samples: z.number(),
  spans_ms: z.partialRecord(pauseCategory, z.number()),
  span_samples: z.partialRecord(pauseCategory, z.number()),
  evidence_event_seqs: z.array(z.number()), trace_complete: z.boolean(),
  limitations: z.array(z.string()),
});
const traceRecord = z.object({
  ...lineage,
  run_id: z.string(), execution_id: nullableText, root_execution_id: nullableText,
  parent_execution_id: nullableText, skill_id: nullableText, version: z.number().nullable(),
  hash: nullableText, call_id: nullableText.optional(), action_id: nullableText.optional(),
  observation_seq: z.number().nullable().optional(), capability: nullableText.optional(),
  event_seq: z.number().nullable().optional(),
  kind: z.enum(["capability_request", "capability_result", "observation", "branch", "intent", "span", "omission"]),
  payload: json, trace_seq: z.number(), at: z.string(),
  omission: z.object({ reason: z.literal("record_byte_budget"), original_bytes: z.number() }).nullable(),
});
const tracePage: z.ZodType<TracePage> = z.object({
  records: z.array(traceRecord), next_after: z.number(), has_more: z.boolean(),
  budget: z.object({
    max_records: z.number(), max_bytes: z.number(), recorded: z.number(), bytes: z.number(),
    omitted_records: z.number(), omitted_bytes: z.number(),
  }),
});
const feedbackCursorSchema: z.ZodType<ImprovementFeedbackCursor> = z.object({
  schema_version: z.literal(2),
  opportunity_change_seq: z.int().nonnegative(),
  metric_change_seq: z.int().nonnegative(),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().refine(cursor => cursor.scope_hash !== null ||
  cursor.opportunity_change_seq === 0 && cursor.metric_change_seq === 0);
const comparisonCursorSchema: z.ZodType<VersionComparisonCursor> = z.object({
  schema_version: z.literal(2),
  before_generation: z.int().positive(),
  after_generation: z.int().positive(),
  offset: z.int().nonnegative(),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const feedbackSchema = z.object({
  opportunities: z.array(z.object({
    opportunity_id: z.string(), run_id: z.string(), kind: z.enum(["death", "failure", "outcome"]),
    version: versionEvidence, execution_id: z.string(), event_seqs: z.array(z.number()),
    created_at: z.string(),
    resolution: z.object({
      decision: z.enum(["revise", "keep", "insufficient_evidence"]), reason: z.string(),
      revision: versionEvidence.nullable(), event_seqs: z.array(z.number()),
      measured: z.boolean(), at: z.string(),
    }).nullable(),
  })),
  metrics: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("replace"), execution_id: z.string(), revision: z.int().nonnegative(),
      generation: z.int().positive(), program: z.object({ name: z.string().min(1), version: z.int().positive() }),
      execution_ordinal: z.int().positive(), metric: objectiveMetrics,
    }).strict().refine(update => update.execution_id === update.metric.execution_id),
    z.object({
      kind: z.literal("retract"), execution_id: z.string(), revision: z.int().nonnegative(),
      generation: z.int().positive(), program: z.object({ name: z.string().min(1), version: z.int().positive() }),
      execution_ordinal: z.int().positive(), reason: z.literal("execution_removed"),
    }).strict(),
  ]) satisfies z.ZodType<ObjectiveMetricUpdate>).max(100),
  next_after: feedbackCursorSchema,
  has_more: z.boolean(),
  omitted: z.array(z.object({
    kind: z.string(), id: z.string(), reason: z.string(), original_bytes: z.number(),
    reference: json.optional(), url: z.string().optional(),
  })),
  projection: historyProjectionSchema,
  opportunity_budget: z.object({ max_records: z.number(), reached: z.boolean(), omission: z.string() }),
  review: z.object({ effect_free: z.literal(true), max_decisions: z.number() }),
}).refine(page => page.opportunities.length + page.metrics.length + page.omitted.length <= 32 &&
  page.metrics.every(update => update.generation <= page.projection.generation));
export type ImprovementFeedback = z.infer<typeof feedbackSchema>;
const comparisonSchema: z.ZodType<VersionComparison> = z.object({
  before: versionEvidence, after: versionEvidence,
  source_diff: z.object({
    common_prefix_lines: z.number(), common_suffix_lines: z.number(),
    removed: z.array(z.string()), added: z.array(z.string()),
  }),
  card_diff: z.record(z.string(), z.object({ before: z.string(), after: z.string() })),
  samples: z.object({ before: z.array(objectiveMetrics), after: z.array(objectiveMetrics) }),
  sample_count: z.object({ before: z.number(), after: z.number() }),
  controlled_conditions: json.nullable(),
  conclusion: z.literal("descriptive_only_no_causal_improvement_claim"),
});
const planSchema: z.ZodType<PlanProjection> = z.object({
  plan_id: z.string(),
  state: z.enum(["armed", "planning", "staged", "validating", "activated", "rejected", "invalidated", "expired", "empty"]),
  planning_active: z.boolean(),
  reason: z.enum(["session_changed", "life_changed", "space_changed", "profile_changed", "screen_changed", "task_changed", "predecessor_changed", "predecessor_unsuccessful", "predecessor_pending", "predecessor_already_settled", "source_changed", "guard_failed", "guard_error", "budget_exhausted", "deadline", "cancelled", "already_activated", "not_staged", "admission_failed"]).nullable(),
  intent: z.string(),
  basis: z.object({
    run_id: z.string(), generation: z.number(), session_id: z.string(), world_id: z.string(),
    epoch: z.number(), life_id: z.number(), life_status: life.shape.status,
    native_boot_id: z.string(), space_epoch: z.number(), compatibility_hash: z.string(), screen: screenRefSchema.nullable(),
    task: z.string(), goal: goalSchema,
    root: skillRef.extend({ hash: z.string(), execution_id: z.string(), status: executionBase.shape.status }),
  }),
  candidate: skillRef.extend({ hash: z.string() }).nullable(),
  guard_hash: nullableText,
  guard_status: z.enum(["omitted", "pending", "passed", "failed", "error"]),
  activation: z.enum(["manual", "on_predecessor_success"]),
  activation_permit: z.enum(["not_authorized", "available", "consumed", "revoked"]),
  activation_trigger: z.enum(["manual", "automatic"]).nullable(),
  predecessor_closed: z.boolean(),
  deadline_at: z.string(),
  budget: z.object({ calls: z.number(), tools: z.number(), duration_ms: z.number() }),
  calls: z.number(), tools: z.number(), observation_seq: z.number().nullable(),
  activation_execution_id: nullableText, overlap_ms: z.number(),
});

export async function fetchTrace(runId: string, after = 0, executionId = ""): Promise<TracePage> {
  const query = new URLSearchParams({ after: String(after), limit: "64" });
  if (executionId) query.set("execution_id", executionId);
  return tracePage.parse(await request(`/v1/runs/${encodeURIComponent(runId)}/trace?${query}`));
}
export async function fetchImprovementFeedback(
  runId: string,
  after: ImprovementFeedbackCursor = { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null },
): Promise<ImprovementFeedback> {
  const cursor = feedbackCursorSchema.parse(after);
  const query = new URLSearchParams({
    after: JSON.stringify(cursor),
    limit: "32",
  });
  const page = feedbackSchema.parse(await request(`/v1/runs/${encodeURIComponent(runId)}/improvements?${query}`));
  if (cursor.scope_hash !== null && page.next_after.scope_hash !== cursor.scope_hash ||
    page.next_after.opportunity_change_seq < cursor.opportunity_change_seq ||
    page.next_after.metric_change_seq < cursor.metric_change_seq ||
    page.has_more && page.next_after.opportunity_change_seq === cursor.opportunity_change_seq &&
      page.next_after.metric_change_seq === cursor.metric_change_seq)
    throw new Error("Improvement feedback returned an incompatible continuation");
  return page;
}
export async function fetchPlanning(runId: string): Promise<PlanProjection | null> {
  return z.object({ plan: planSchema.nullable() }).parse(
    await request(`/v1/runs/${encodeURIComponent(runId)}/planning`),
  ).plan;
}
export async function fetchDeaths(runId: string, after = 0) {
  return z.object({ episodes: z.array(z.object({
    death_id: z.string(), session_id: z.string(), life_id: z.number(),
    last_observation: json.nullable(), current_root_execution_id: nullableText,
    action_id: nullableText, event_seqs: z.array(z.number()),
    last_authorized_state: json.optional(),
    state_omission: json.optional(),
    // Retained schema2 evidence is displayed under its original historical key.
    last_authorized_player: json.optional(),
    observation_omission: json.nullable(),
    event_reference_omission: json.optional(),
  })), next_after: z.number(), has_more: z.boolean() }).parse(
    await request(`/v1/runs/${encodeURIComponent(runId)}/deaths?after=${after}&limit=32`),
  );
}
export async function fetchComparison(
  before: ProgramVersionEvidence, after: ProgramVersionEvidence, afterSample: VersionComparisonCursor | null = null,
) {
  const cursor = comparisonCursorSchema.nullable().parse(afterSample);
  const page = z.object({
    comparison: comparisonSchema, next_after: comparisonCursorSchema, has_more: z.boolean(),
    projection: z.object({ before: historyProjectionSchema, after: historyProjectionSchema }),
    omissions: z.array(z.object({
      field: z.string(), reason: z.string(), original_bytes: z.number(), reference: json,
    })),
  }).parse(await request("/v1/program-comparisons", {
    before, after, after_sample: cursor, limit: 25,
  }));
  if (cursor !== null && (page.next_after.before_generation !== cursor.before_generation ||
    page.next_after.after_generation !== cursor.after_generation || page.next_after.scope_hash !== cursor.scope_hash) ||
    page.projection.before.generation !== page.next_after.before_generation ||
    page.projection.after.generation !== page.next_after.after_generation ||
    page.next_after.offset < (cursor?.offset ?? 0) ||
    page.has_more && page.next_after.offset === (cursor?.offset ?? 0))
    throw new Error("Comparison returned an incompatible snapshot continuation");
  return page;
}
