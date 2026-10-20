import { z } from "zod";
import type {
  ActivityEvent,
  AppSnapshot,
  AuthState,
  Json,
  RunView,
} from "../../src/shared/contracts.ts";

const nullableText = z.string().nullable();
const vec = z.object({ x: z.number(), y: z.number(), z: z.number() });
const inventory = z.object({
  name: z.string(),
  display_name: z.string(),
  count: z.number(),
  slot: z.number(),
});
const player = z.object({
  position: vec,
  yaw: z.number(),
  pitch: z.number(),
  health: z.number(),
  food: z.number(),
  on_ground: z.boolean(),
  in_water: z.boolean(),
  inventory: z.array(inventory),
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
const run: z.ZodType<RunView> = z.object({
  run_id: z.string(),
  world_id: z.string(),
  epoch: z.number(),
  task: z.string(),
  goal: z.enum([
    "collect_wood",
    "craft_crafting_table",
    "craft_stone_pickaxe",
    "custom",
  ]),
  model_id: z.string(),
  status: z.enum([
    "created",
    "bootstrapping",
    "running",
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
  action: z
    .object({
      action_id: z.string(),
      kind: z.enum([
        "move",
        "look",
        "dig",
        "place",
        "craft",
        "equip",
        "interact",
        "attack",
        "navigate",
      ]),
      status: z.enum([
        "accepted",
        "running",
        "cancel_requested",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
      ]),
      origin: z.enum(["strategist", "policy"]),
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
    }),
  ),
  error: nullableText,
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    known_cost: z.number().nullable(),
  }),
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
    viewer_ready: z.boolean(),
    viewer_url: nullableText,
    last_observation_at: nullableText,
    player: player.nullable(),
    error: nullableText,
  }),
  sandbox: z.object({
    status: z.enum(["checking", "ready", "unavailable"]),
    image: z.string(),
    error: nullableText,
  }),
  run: run.nullable(),
  goals: z.array(
    z.object({
      id: z.enum([
        "collect_wood",
        "craft_crafting_table",
        "craft_stone_pickaxe",
        "custom",
      ]),
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

async function request(path: string, body?: unknown): Promise<unknown> {
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
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      signal: controller.signal,
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

export async function createRun(body: {
  task: string;
  goal: string;
  model_id: string;
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
