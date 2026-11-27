import { z } from "zod";
import { SURVIVAL_AGENT_GOALS, SURVIVAL_AGENT_STRATEGIES, SURVIVAL_AGENT_STRATEGY_OUTCOMES,
  type SurvivalAgentSnapshot, type SurvivalAgentStart } from "../../src/shared/goals.ts";
import type { AuthState } from "../../src/shared/auth-types.ts";
const nullableText = z.string().nullable();
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

export async function mutate(path: string, body: unknown = {}): Promise<void> {
  await request(path, body);
}

const survivalAgentSnapshot: z.ZodType<SurvivalAgentSnapshot> = z.object({
  phase: z.enum(["idle", "starting", "playing", "stopping", "ended"]),
  goal: z.enum(SURVIVAL_AGENT_GOALS).nullable(),
  strategy: z.enum(SURVIVAL_AGENT_STRATEGIES).nullable(),
  model: z.string().min(1).nullable(),
  strategyOutcome: z.enum(SURVIVAL_AGENT_STRATEGY_OUTCOMES).nullable(),
  status: z.string(), won: z.boolean().nullable(), run: nullableText,
  elapsedMs: z.number().nonnegative(), health: z.number().nullable(), food: z.number().nullable(),
  deaths: z.number().int().nonnegative().nullable(),
});

function survivalAgentResponse(value: unknown): SurvivalAgentSnapshot {
  const parsed = survivalAgentSnapshot.safeParse(value);
  if (!parsed.success)
    throw new ApiError("Minecraft Survival Agent status could not be read. Check status before starting again.", 0, "invalid_agent");
  return parsed.data;
}

export async function fetchSurvivalAgent(signal: AbortSignal): Promise<SurvivalAgentSnapshot> {
  return survivalAgentResponse(await request("/v1/survival-agent", undefined, undefined, signal));
}

export async function startSurvivalAgent(input: SurvivalAgentStart): Promise<SurvivalAgentSnapshot> {
  return survivalAgentResponse(await request("/v1/survival-agent/start", input));
}

export async function stopSurvivalAgent(): Promise<SurvivalAgentSnapshot> {
  return survivalAgentResponse(await request("/v1/survival-agent/stop", {}));
}

const launcherState = z.object({ auth, eulaAccepted: z.boolean(), preparing: z.boolean(), preparationError: nullableText });
export async function fetchState() { return launcherState.parse(await request("/v1/state")); }
