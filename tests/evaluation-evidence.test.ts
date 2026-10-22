import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type StoredRun } from "../src/server/store.ts";
import { emptyRunUsage } from "../src/server/usage.ts";
import { DEFAULT_EVALUATION_CAPS } from "../src/evaluation/config.ts";
import { ModelProgramEvidence } from "../src/evaluation/model-evidence.ts";

const resources: Array<{ store: Store; observer: ModelProgramEvidence; root: string }> = [];
afterEach(() => {
  for (const { store, observer, root } of resources.splice(0)) {
    observer.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
function setup(maxAdmissions = 2) {
  const root = mkdtempSync(path.join(tmpdir(), "gameharness-evaluation-evidence-"));
  const store = new Store(root);
  const run: StoredRun = { run_id: crypto.randomUUID(), world_id: crypto.randomUUID(), epoch: 1, session_id: crypto.randomUUID(), life_id: 1,
    task: "Test-only observer seam", goal: "custom", model_id: "test-only-no-provider", status: "running", started_at: null, ended_at: null,
    turns: 0, model_status: "idle", error: null, usage: emptyRunUsage(), baseline: {} };
  const stops: string[] = [];
  const observer = new ModelProgramEvidence(store, root, { ...DEFAULT_EVALUATION_CAPS, hostRequestAdmissions: maxAdmissions }, "test-host-clock", (_id, reason) => { stops.push(reason); });
  resources.push({ store, observer, root });
  store.saveRun(run);
  const emit = (type: string, details: Parameters<Store["event"]>[3]) => store.event(run.run_id, type, "Explicit synthetic test event; no provider", details);
  return { store, observer, run, emit, stops };
}

test("the observer uses the configured admission cap, not a private hardcoded limit", () => {
  const { emit, observer, run, stops } = setup(1);
  emit("model.call", { request_id: "request-1" });
  expect(stops).toEqual(["host_request_admission_bound_reached"]);
  expect(observer.summary(run.run_id).usage).toMatchObject({ admissions: 1, reported_messages: 0, uncached_input: null, output: null, wire_attempts: null });
});

test("durable usage retains reported subtotals when the final admitted request is unreported", () => {
  const { emit, observer, run } = setup();
  emit("model.call", { request_id: "request-1" });
  emit("model.usage", { request_id: "request-1", uncached_input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 5 });
  emit("model.request_settled", { request_id: "request-1", stop_reason: "toolUse", usage_reported: true });
  expect(observer.summary(run.run_id)).toMatchObject({ provider_settled: true, usage: { coverage: "complete", uncached_input: 7, output: 5 } });
  emit("model.call", { request_id: "request-2" });
  emit("model.request_unsettled", { request_id: "request-2", usage_reported: false });
  expect(observer.summary(run.run_id)).toMatchObject({ provider_settled: false, usage: { admissions: 2, reported_messages: 1,
    coverage: "incomplete", output: null, reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 5 }, subscription_cost: null } });
});

test("cached action evidence follows actual durable receipt updates rather than initial admission views", () => {
  const { store, observer, run } = setup();
  const accepted = store.admitAction(run.run_id, "craft-action", { kind: "craft", item: "crafting_table", executions: 1 }, "strategist").action;
  expect(observer.actions(run.run_id)[0]?.view.status).toBe("accepted");
  store.saveAction(run.run_id, { ...accepted.view, status: "succeeded", result: { status: "succeeded", summary: "Synthetic native-receipt test data only", evidence: {
    inventory_receipt_confirmed: true, inventory_before: { crafting_table: 0 }, inventory_after: { crafting_table: 1 }, effect_confirmed: true,
  } } });
  expect(observer.actions(run.run_id)[0]?.view.status).toBe("succeeded");
  expect(observer.summary(run.run_id).actions).toMatchObject({ count: 1, inventory_receipts: 1, inventory_delta: { crafting_table: 1 }, uncertain_outcomes: 0 });
});

test("provider errors stop the sample and remain distinct from a confirmed harness fault", () => {
  const { emit, observer, run, stops } = setup();
  emit("model.call", { request_id: "request-1" });
  emit("model.request_settled", { request_id: "request-1", stop_reason: "error", usage_reported: false });
  expect(observer.hasProviderFailure(run.run_id)).toBe(true);
  expect(stops).toEqual(["provider_failure_or_unsettled_no_repeat"]);
  expect(observer.summary(run.run_id)).toMatchObject({ provider_error: true, provider_settled: false, confirmed_harness_faults: [] });
});
