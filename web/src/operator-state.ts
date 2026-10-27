import type { RunOperatorView, RunView } from "../../src/shared/contracts.ts";

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
