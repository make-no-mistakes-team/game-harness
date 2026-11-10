import { expect, test } from "bun:test";
import {
  currentTaskText, stopControl, canRefreshModels, commandAvailable, currentUsage,
  preparationPrerequisite, preparationLabel, preparationCancellation, preparationTiming, detachedPreparation,
} from "./operator-state.ts";
import type { RunUsage } from "../../src/shared/contracts.ts";
import { PREPARED_START_LIMITS, type PreparedStartView } from "../../src/shared/prepared-start.ts";

test("long custom task keeps meaningful wording while preserving full-task disclosure", () => {
  const task = "Return to the worksite with a second load.\n" + "Keep the collected items in the same chest. ".repeat(12);
  const result = currentTaskText(task, false);
  expect(result.excerpt).toStartWith("Return to the worksite with a second load. Keep the collected items");
  expect(result.excerpt.length).toBeLessThanOrEqual(145);
  expect(result.showFull).toBe(true);
  expect(currentTaskText(task, true)).toEqual({ excerpt: task, showFull: false });
});

test("Stop retry depends only on actual cleanup failure, not a previous provider error", () => {
  expect(stopControl("stopping", null)).toMatchObject({ retry: false, draining: true });
  expect(stopControl("stopping", "Emitter closure unconfirmed")).toMatchObject({ retry: true, draining: false });
  expect(stopControl("paused", null)).toMatchObject({ retry: false, draining: false });
});

test("same-account model refresh is available while paused but never implies Resume", () => {
  expect(canRefreshModels("paused")).toBe(true);
  expect(canRefreshModels("running")).toBe(false);
  expect(canRefreshModels("stopping")).toBe(false);
  expect(canRefreshModels("stopped")).toBe(true);
});

function preparationUsage(): RunUsage {
  const token = { uncached_input: 14, cache_read: null, cache_write: 0, output: 7,
    calls: 1, known_cost: null, legacy_input: null };
  return { ...token, accounting_basis: "sdk_reported_subtotal",
    by_purpose: { authoring: { ...token }, planning: { ...token }, replanning: { ...token },
      improvement: { ...token }, other: { ...token } } };
}

function preparationView(patch: Partial<PreparedStartView> = {}): PreparedStartView {
  return {
    preparation_id: "preparation", task: "Collect supplies", model_id: "discovered-image-model",
    goal: { adapter_id: "minecraft", goal_id: "custom", verifier: null, parameters: {} },
    phase: "authoring", started_at: "2026-11-10T10:00:00.000Z", deadline_at: "2026-11-10T10:05:00.000Z",
    ready_at: null, run_id: null, requests_admitted: 1, tools_used: 2, source_versions: 1,
    analysis_jobs: 0, analysis_ms: 0, program: null, usage: preparationUsage(),
    limits: PREPARED_START_LIMITS, closure: "open", error: null, ...patch,
  };
}

function preparationState(): NonNullable<Parameters<typeof preparationPrerequisite>[0]> {
  return {
    auth: { authenticated: true, status: "ready", models: [{ id: "discovered-image-model",
      name: "Discovered image model", provider: "openai-codex", context_window: null,
      input_modalities: ["text", "image"], capability_provenance: "discovered_sdk_descriptor_not_live_vision" }] },
    server: { status: "stopped", eula_accepted: true },
    sandbox: { status: "ready" }, game: { status: "disconnected", session_id: null },
    run: null, prepared_start: null, goals: [{ id: "custom" }],
  };
}

const preparationDraft = {
  task: "Collect supplies", choiceId: "custom", modelId: "discovered-image-model", experienceId: "",
};

test("preparation admission requires genuine disconnected prerequisites and never drops a bundle choice", () => {
  const state = preparationState();
  expect(preparationPrerequisite(state, preparationDraft)).toBeNull();
  expect(preparationPrerequisite(null, preparationDraft)).toContain("local service");
  for (const status of ["connecting", "connected", "error"] as const)
    expect(preparationPrerequisite({ ...state, game: { status, session_id: "session" } }, preparationDraft))
      .toContain("disconnected client");
  expect(preparationPrerequisite({ ...state, game: { status: "disconnected", session_id: "unclosed-session" } }, preparationDraft))
    .toContain("disconnected client");
  expect(preparationPrerequisite(state, { ...preparationDraft, experienceId: "explicit-bundle" })).toContain("Clear the selected bundle");
  for (const status of ["created", "running", "paused", "stopping"] as const)
    expect(preparationPrerequisite({ ...state, run: { status } }, preparationDraft)).toContain("Stop this run");
  expect(preparationPrerequisite({ ...state, auth: { ...state.auth, status: "discovering" } }, preparationDraft))
    .toContain("finish model discovery");
  expect(preparationPrerequisite(state, { ...preparationDraft, modelId: "invented-model" })).toContain("available strategic model");
  for (const input_modalities of [undefined, ["text"]])
    expect(preparationPrerequisite({ ...state, auth: { ...state.auth,
      models: state.auth.models.map(model => ({ ...model, input_modalities })) } }, preparationDraft)).toContain("discovered image input");
  expect(preparationPrerequisite({ ...state, server: { status: "stopped", eula_accepted: false } }, preparationDraft))
    .toContain("Accept the EULA");
  expect(preparationPrerequisite({ ...state, server: { status: "running", eula_accepted: true } }, preparationDraft))
    .toContain("Stop world");
  expect(preparationPrerequisite({ ...state, sandbox: { status: "checking" } }, preparationDraft)).toContain("Isolation");
  expect(preparationPrerequisite(state, { ...preparationDraft, choiceId: "missing" })).toContain("success check");
  expect(preparationPrerequisite(state, { ...preparationDraft, task: "  " })).toContain("valid task");
});

test("source phases lock new startup, unknown closure stays blocked, transfer removes preparation cancellation", () => {
  const state = preparationState();
  for (const phase of ["authoring", "compiling", "ready", "joining", "activating", "cancelling"] as const) {
    const view = preparationView({ phase });
    expect(preparationPrerequisite({ ...state, prepared_start: view }, preparationDraft)).toContain("owns startup");
    expect(preparationCancellation(view).available).toBe(true);
    expect(preparationLabel(view).toLowerCase()).not.toContain("playing");
  }
  expect(preparationCancellation(preparationView({ phase: "cancelling", closure: "draining" })))
    .toMatchObject({ available: true, draining: true });
  const unknown = preparationView({ phase: "failed", closure: "unknown", error: "Worker closure unconfirmed" });
  expect(preparationPrerequisite({ ...state, prepared_start: unknown }, preparationDraft)).toContain("closure is unknown");
  expect(preparationCancellation(unknown)).toMatchObject({ available: true, draining: false });
  for (const phase of ["cancelled", "failed"] as const) {
    const view = preparationView({ phase, closure: "closed" });
    expect(preparationCancellation(view).available).toBe(false);
    expect(preparationPrerequisite({ ...state, prepared_start: view }, preparationDraft)).toBeNull();
  }
  const transferred = preparationView({ phase: "started", run_id: "actual-run", closure: "transferred" });
  expect(preparationLabel(transferred)).toBe("Preparation transferred to run");
  expect(preparationCancellation(transferred).available).toBe(false);
  expect(preparationCancellation(preparationView({ phase: "activating", closure: "transferred" })).available).toBe(false);
  expect(preparationPrerequisite({ ...state, prepared_start: transferred, run: { status: "paused" } }, preparationDraft))
    .toContain("Stop this run");
});

test("Stop and preparation cancellation bypass unrelated pending calls without permitting duplicate commands", () => {
  const pending = new Set(["prepare-play"]);
  for (const id of ["stop-run", "stop-game", "cancel-preparation"]) {
    expect(commandAvailable(true, true, pending, id)).toBe(true);
    expect(commandAvailable(false, true, pending, id)).toBe(true);
    expect(commandAvailable(true, true, new Set([...pending, id]), id)).toBe(false);
    expect(commandAvailable(true, false, pending, id)).toBe(false);
  }
  for (const id of [undefined, "prepare-play", "start-game", "logout", "motor-save"])
    expect(commandAvailable(true, true, pending, id)).toBe(false);
  expect(commandAvailable(false, true, new Set(), "prepare-play")).toBe(false);
});

test("deadline measures elapsed time without inventing a completed preparation duration", () => {
  const view = preparationView();
  expect(preparationTiming(view, Date.parse("2026-11-10T10:00:42.000Z"))).toEqual({ elapsed_ms: 42000, deadline_reached: false });
  expect(preparationTiming(view, Date.parse("2026-11-10T10:05:01.000Z"))).toEqual({ elapsed_ms: 301000, deadline_reached: true });
  for (const phase of ["started", "cancelled", "failed"] as const)
    expect(preparationTiming(preparationView({ phase, closure: phase === "started" ? "transferred" : "closed" }), Date.now()))
      .toEqual({ elapsed_ms: null, deadline_reached: false });
});

test("preparation uses its own usage until attachment, then the real run total exactly once", () => {
  const view = preparationView();
  expect(currentUsage({ prepared_start: null, run: null })).toBeNull();
  expect(currentUsage({ prepared_start: view, run: null })).toBe(view.usage);
  expect(currentUsage({ prepared_start: view, run: null })?.cache_read).toBeNull();
  expect(currentUsage({ prepared_start: view, run: null })?.cache_write).toBe(0);
  const previous = { run_id: "previous-run", status: "stopped" as const, usage: { ...preparationUsage(), calls: 8 } };
  expect(detachedPreparation({ prepared_start: view, run: previous })).toBe(view);
  expect(currentUsage({ prepared_start: view, run: previous })).toBe(view.usage);
  const attached = { ...previous, run_id: "actual-run", status: "paused" as const, usage: { ...preparationUsage(), calls: 5 } };
  const transferred = preparationView({ phase: "started", closure: "transferred", run_id: attached.run_id });
  expect(detachedPreparation({ prepared_start: transferred, run: attached })).toBeNull();
  expect(currentUsage({ prepared_start: transferred, run: attached })).toBe(attached.usage);
  expect(currentUsage({ prepared_start: transferred, run: attached })?.calls).toBe(5);
  expect(detachedPreparation({ prepared_start: transferred, run: { ...attached, run_id: "later-run" } })).toBeNull();
});
