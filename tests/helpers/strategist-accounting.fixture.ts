import { mock } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(join(tmpdir(), "gameharness-strategist-"));
const signal = new AbortController();
const model = { provider: "fixture", modelId: "accounting" };
let now = 100_000;
Date.now = () => now;
mock.module("../../src/server/auth.ts", () => ({
  AuthManager: { create: async () => ({
    snapshot: () => ({ status: "ready", authenticated: true, provider: model.provider,
      models: [{ id: model.modelId, provider: model.provider }] }),
    createInferenceSession: () => ({
      signal: signal.signal, model, getApiKey: () => "", sessionId: "test",
      streamFn: () => ({
        async *[Symbol.asyncIterator]() {},
        result: async () => ({ content: [{ type: "toolCall", name: "submit_survival_plan", arguments: {
          rationale: "gather", replaceQueue: true, excavationMode: "safe_staircase",
          tasks: [{ kind: "gather_wood", target: "logs", count: 4, x: null, y: null, z: null }],
        } }] }),
      }),
    }),
    close: async () => {},
  }) },
}));
const { composeMacroStrategist } = await import("../../src/server/survival-macro/strategist.ts");
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  for (let i = 0; i < 150; i++) {
    const value = await read().catch(() => null);
    if (value !== null && accept(value)) return value;
    await delay(20);
  }
  throw new Error("Strategist did not reach expected state");
}
try {
  await mkdir(join(root, "auth"));
  await writeFile(join(root, "auth/gameharness.sqlite"), "");
  const dir = join(root, "run");
  const state = { v: 2, run: basename(dir), life: 1, tick: 1, goal: "diamond", health: 20,
    food: 20, y: 64, status: "playing", inventory: {}, queuedTasks: [], recentReceipts: [] };
  const strategist = composeMacroStrategist({ model, dir, goal: "diamond", objective: "", authDirectory: root,
    signal: signal.signal, maxRequests: 2, maxRuntimeMs: 60_000, assertDisplay() {} });
  await mkdir(join(dir, "strategist"), { recursive: true });
  const save = (value: unknown) => writeFile(join(dir, "strategist/state.json"), JSON.stringify(value));
  await save(state);
  await strategist.start();
  await until(async () => strategist.outcome().plansPublished, n => n === 1);
  const first = JSON.parse(await readFile(join(dir, "strategist/plan.json"), "utf8"));
  now += 30_000;
  await save({ ...state, tick: 2, inventory: { raw_iron: 3 } });
  await until(async () => strategist.outcome().plansPublished, n => n === 2);
  const second = JSON.parse(await readFile(join(dir, "strategist/plan.json"), "utf8"));
  if (first.planId === second.planId) throw new Error("Expected two distinct published plans");
  await save({ ...state, appliedPlan: { planId: second.planId, tick: 3 } });
  await until(async () => strategist.outcome().plansApplied, n => n === 1);
  await strategist.stop();
  await strategist.stop();
  const result = strategist.outcome();
  if (result.plansApplied !== 1 || result.plansPublished !== 2) throw new Error(JSON.stringify(result));
  console.log("one applied plan, two published plans, repeated stop: counted once");
} finally {
  signal.abort();
  await rm(root, { recursive: true, force: true });
}
