import { expect, test } from "bun:test";
import { fetchHistory } from "../web/src/api.ts";

// Exercise the public consumer's actual JSON/Zod boundary, not source wording.
// Visible labels belong to the parent's throwaway UI smoke.
test("runtime history DTO retains SDK-subtotal basis and nullable legacy counters without zero filling", async () => {
  const bucket = { uncached_input: null, cache_read: null, cache_write: null, output: null,
    calls: null, known_cost: null, legacy_input: 41 };
  const dto = { run_id: "accounting-schema-run", world_id: "accounting-schema-world", epoch: 1,
    native_boot_id: null, space_epoch: null, compatibility_hash: null,
    session_id: null, life_id: null, task: "Historical subtotal fixture", goal: "custom", model_id: "offline-only",
    status: "failed", started_at: null, ended_at: null, turns: 1, model_status: "idle", action: null,
    policies: [], skills: [], executions: [], error: null,
    usage: { ...bucket, accounting_basis: "sdk_reported_subtotal",
      by_purpose: { authoring: { ...bucket }, planning: { ...bucket }, replanning: { ...bucket },
        improvement: { ...bucket }, other: { ...bucket } } } };
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    expect(input).toBe("/v1/runs");
    expect(options?.method).toBe("GET");
    return new Response(JSON.stringify({ runs: [dto] }), { headers: { "Content-Type": "application/json" } });
  }, { preconnect: originalFetch.preconnect });
  try {
    const [decoded] = await fetchHistory();
    expect(decoded?.usage).toMatchObject({ accounting_basis: "sdk_reported_subtotal", uncached_input: null,
      cache_read: null, cache_write: null, output: null, calls: null, legacy_input: 41, known_cost: null,
      by_purpose: { other: { uncached_input: null, output: null, calls: null, legacy_input: 41 } } });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
