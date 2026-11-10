import type { AppSnapshot, RunOperatorView, RunUsage, RunView } from "../../src/shared/contracts.ts";
import { preparedStartActive, type PreparedStartView } from "../../src/shared/prepared-start.ts";
import { taskTextSchema } from "../../src/shared/tasks.ts";

export function currentTaskText(task: string, suppliedPrompt: boolean) {
  const showFull = !suppliedPrompt && (task.length > 144 || /[\r\n]/.test(task));
  const normalized = task.replace(/\s+/g, " ").trim();
  return { excerpt: showFull ? normalized.length > 144 ? `${normalized.slice(0, 144).trimEnd()}…` : normalized : task, showFull };
}

export function stopControl(status: RunView["status"] | undefined, cleanupError: string | null) {
  const retry = status === "stopping" && !!cleanupError;
  const draining = status === "stopping" && !cleanupError;
  return { label: retry ? "Retry Stop" : draining ? "Stopping" : "Stop run", retry, draining };
}

export function operatorLabel(state: RunOperatorView["state"], completion: RunOperatorView["completion"]): string {
  if (state === "stopped" && completion === "model_reported_unverified") return "Model reported completion · unverified";
  if (state === "completed" && completion === "verified") return "Goal verified";
  const labels: Partial<Record<RunOperatorView["state"], string>> = {
    provider_unavailable: "Model request failed · paused", thinking: "Model thinking",
    executing: "Program running", acting: "Acting", waiting: "Waiting", recovering: "Recovering", blocked: "Blocked",
  };
  return labels[state] ?? state[0]!.toUpperCase() + state.slice(1);
}

export function canRefreshModels(status: RunView["status"] | undefined): boolean {
  return status === undefined || ["paused", "stopped", "completed", "failed"].includes(status);
}

export function commandAvailable(
  serviceReady: boolean,
  hasSnapshot: boolean,
  pending: ReadonlySet<string>,
  id?: string,
): boolean {
  const stop = id === "stop-run" || id === "stop-game" || id === "cancel-preparation";
  return hasSnapshot && (serviceReady || stop) &&
    (pending.size === 0 || stop && !pending.has(id!));
}

type PreparationState = {
  auth: Pick<AppSnapshot["auth"], "authenticated" | "status" | "models">;
  server: Pick<AppSnapshot["server"], "status" | "eula_accepted">;
  sandbox: Pick<AppSnapshot["sandbox"], "status">;
  game: Pick<AppSnapshot["game"], "status" | "session_id">;
  run: Pick<RunView, "status"> | null;
  goals: ReadonlyArray<Pick<AppSnapshot["goals"][number], "id">>;
  prepared_start: PreparedStartView | null;
};

export function preparationPrerequisite(
  state: PreparationState | null,
  draft: { task: string; choiceId: string; modelId: string; experienceId: string },
): string | null {
  if (!state) return "Connect to the local service before preparing a task.";
  if (preparedStartActive(state.prepared_start))
    return state.prepared_start?.closure === "unknown"
      ? "Preparation closure is unknown. New startup is blocked; inspect preparation and retry cleanup."
      : "Preparation owns startup. Cancel it before changing the task or world.";
  if (state.run && !["stopped", "completed", "failed"].includes(state.run.status))
    return "Stop this run before preparing another task.";
  if (state.game.status !== "disconnected" || state.game.session_id !== null)
    return "Prepare & play needs a disconnected client. Use Create run for the connected world.";
  if (draft.experienceId)
    return "Prepare & play starts with fresh programs. Clear the selected bundle, or use Start world and Create run to load it.";
  if (!state.auth.authenticated || state.auth.status !== "ready")
    return "Connect OpenAI and finish model discovery before preparing.";
  const model = state.auth.models.find(item => item.id === draft.modelId);
  if (!model) return "Select an available strategic model.";
  if (!model.input_modalities?.includes("image"))
    return "Select a model with discovered image input for the first game frame.";
  if (!state.server.eula_accepted || state.server.status !== "stopped")
    return state.server.status === "running"
      ? "Stop world before preparing, or use Create run in the connected world."
      : "Accept the EULA and prepare the server; leave the world stopped.";
  if (state.sandbox.status !== "ready")
    return "Isolation is not ready. Check the isolation error in Settings.";
  if (!state.goals.some(item => item.id === draft.choiceId))
    return "Select an available success check or Custom.";
  if (!taskTextSchema.safeParse(draft.task).success)
    return "Enter a valid task before preparing.";
  return null;
}

export function preparationLabel(view: PreparedStartView): string {
  const labels: Record<PreparedStartView["phase"], string> = {
    authoring: "Preparing source",
    compiling: "Compiling source",
    ready: "Source ready · awaiting world start",
    joining: "Starting world",
    activating: "Activating on a real frame",
    started: "Preparation transferred to run",
    cancelling: "Cancelling preparation",
    cancelled: "Preparation cancelled",
    failed: "Preparation failed",
  };
  return `${labels[view.phase]}${view.closure === "unknown" ? " · closure unknown" : ""}`;
}

export function preparationCancellation(view: PreparedStartView | null) {
  const available = view !== null && view.phase !== "started" && view.closure !== "transferred" &&
    preparedStartActive(view);
  const draining = available && view.phase === "cancelling" && view.closure !== "unknown";
  return { available, draining, label: draining ? "Cancelling preparation" : "Cancel preparation" };
}

export function preparationTiming(view: PreparedStartView, now: number) {
  const active = preparedStartActive(view) && view.phase !== "started" && view.closure !== "transferred";
  return {
    elapsed_ms: active ? Math.max(0, now - Date.parse(view.started_at)) : null,
    deadline_reached: active && now >= Date.parse(view.deadline_at),
  };
}

export function detachedPreparation(state: {
  prepared_start: PreparedStartView | null;
  run: Pick<RunView, "run_id" | "status"> | null;
}): PreparedStartView | null {
  const view = state.prepared_start;
  if (!view || view.run_id === state.run?.run_id) return null;
  if (state.run && (view.phase === "started" ||
    !["stopped", "completed", "failed"].includes(state.run.status))) return null;
  return view;
}

export function currentUsage(state: {
  prepared_start: PreparedStartView | null;
  run: Pick<RunView, "run_id" | "status" | "usage"> | null;
}): RunUsage | null {
  return detachedPreparation(state)?.usage ?? state.run?.usage ?? state.prepared_start?.usage ?? null;
}
