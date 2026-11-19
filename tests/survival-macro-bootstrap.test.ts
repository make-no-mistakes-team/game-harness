import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewPauseJournal } from "../survival-agent/pause-evidence.ts";
import {
  bindFirstPlan, firstPlanContext, parseFirstPlanToolArguments, PRE_SPAWN_GOAL_ONLY, type FirstPlanInference,
  type FirstPlanRequest, type FirstPlanStrategist,
} from "../src/server/survival-macro/bootstrap.ts";
import { composeTerraSurvival, declareTerraStrategy } from "../src/server/survival-macro/compose.ts";
import { SurvivalMacroController } from "../src/server/survival-macro/controller.ts";
import type { MacroObservation, MacroOpportunity } from "../src/server/survival-macro/protocol.ts";
import { TERRA_MODEL_ID } from "../src/shared/survival-agent-ui.ts";

const GOAL = "stone_pickaxe";
const planks = {
  kind: "first_policy",
  policy: { kind: "plank_stock", source: "witnessed_timber", count: 4, maxBreaks: 1, maxCrafts: 1 },
  requires: [], reserves: [],
} as const;

function offer(id: string, verb: "break" | "continue", subject: string, spends = {}): MacroOpportunity {
  return { id, verb, summary: "Observed native opportunity", evidence: "Witnessed by the native actor",
    risk: "guarded", material: { subject, target: `target-${id}`, spends } };
}

const spruce = offer("spruce-face", "break", "block:minecraft:spruce_log");
const birch = offer("birch-face", "break", "block:minecraft:birch_log");

function view(change: Partial<MacroObservation> = {}): MacroObservation {
  return { v: 1, run: "run", life: 1, epoch: 1, tick: 5, goal: GOAL, health: 20, food: 20,
    inventory: {}, opportunities: [], recent: [], quiescent: true, safety: { clear: true, revision: 1 }, ...change };
}

const request = { goal: GOAL } as const;
const liveScope = { run: "run", first: view(), protectedReserves: [] };

test("goal-only context cannot serialize a player, frame, observation, source files, private run ID, or world data", () => {
  const untrusted = {
    ...request, objective: "Keep one spruce log", run: "private-run", seed: "private-seed",
    frame: "private-image", observation: view({ inventory: { "minecraft:spruce_log": 8 } }),
  };
  const context = firstPlanContext(untrusted);
  expect(context?.messages[0]?.content).toBe('{"goal":"stone_pickaxe","objective":"Keep one spruce log"}');
  expect(JSON.stringify(context)).not.toContain("private-");
  expect(context?.tools?.map(tool => tool.name)).toEqual(["propose_survival_first_plan"]);
});

test("only exact bounded advisory and defer schemas are admitted", () => {
  expect(parseFirstPlanToolArguments('{"advice":{"kind":"defer"}}')).toEqual({ kind: "defer" });
  expect(parseFirstPlanToolArguments(JSON.stringify({ advice: planks }))).toEqual(planks);
  expect(parseFirstPlanToolArguments('{"advice":{"kind":"defer"}')).toBeNull();
  for (const raw of [
    { ...planks, basis: view() },
    { ...planks, policy: { ...planks.policy, maxCrafts: 3 } },
    { ...planks, policy: { ...planks.policy, source: "minecraft:any_log" } },
    { ...planks, policy: { ...planks.policy, source: "minecraft:air" } },
    { ...planks, policy: { ...planks.policy, code: "export function act() {}" } },
    { ...planks, reserves: [{ item: "minecraft:air", count: 1 }] },
    { ...planks, requires: [{ item: "minecraft:coal", count: 1 }, { item: "minecraft:coal", count: 2 }] },
    { kind: "defer", reason: "Pretend I saw a tree" },
  ]) expect(parseFirstPlanToolArguments(JSON.stringify({ advice: raw }))).toBeNull();
});

test("witnessed timber binds exact live species and spend; absent, mismatched or ambiguous evidence does not", () => {
  expect(bindFirstPlan(request, planks, view(), liveScope)).toEqual({ reason: "no_matching_live_material" });
  expect(bindFirstPlan(request, planks, view({ opportunities: [spruce] }), liveScope)).toMatchObject({
    policy: {
      target: { kind: "stock", item: "minecraft:spruce_planks", count: 4 },
      allowedEffects: ["break:minecraft:spruce_log", "craft:spruce_planks"],
      costCaps: [{ item: "minecraft:spruce_log", count: 1 }],
      maxBreaks: 1, maxCrafts: 1, maxPlacements: 0,
    },
  });
  const specific = { ...planks, policy: { ...planks.policy, source: "minecraft:oak_log" } };
  expect(bindFirstPlan(request, specific, view({ opportunities: [birch] }), liveScope)).toEqual({
    reason: "no_matching_live_material",
  });
  expect(bindFirstPlan(request, planks, view({ opportunities: [spruce, birch] }), liveScope)).toEqual({
    reason: "ambiguous_material_binding",
  });
  expect(bindFirstPlan(request, planks, view({ opportunities: [
    offer("risk", "break", "block:minecraft:spruce_log", { "minecraft:wooden_axe": 1 }),
  ] }), liveScope)).toEqual({ reason: "no_matching_live_material" });
});

test("stock and recipe evidence must agree, and planks cannot consume protected logs", () => {
  const log = "minecraft:stripped_dark_oak_wood";
  const reserve = { item: log, count: 2 };
  const observation = view({
    inventory: { [log]: 3 },
    opportunities: [offer("recipe", "continue", "recipe:planks", { [log]: 1 })],
  });
  expect(bindFirstPlan(request, { ...planks, reserves: [reserve] }, observation, liveScope)).toMatchObject({
    policy: {
      target: { kind: "stock", item: "minecraft:dark_oak_planks", count: 4 },
      allowedEffects: ["craft:dark_oak_planks"], maxBreaks: 0, maxCrafts: 1,
      costCaps: [{ item: log, count: 1 }], reserves: [reserve],
    },
  });
  expect(bindFirstPlan(request, { ...planks, reserves: [reserve] },
    { ...observation, inventory: { [log]: 2 } }, liveScope)).toEqual({ reason: "no_matching_live_material" });
  expect(bindFirstPlan(request, planks, { ...observation, opportunities: [] }, liveScope)).toEqual({
    reason: "no_matching_live_material",
  });
});

test("stone is bound to cobblestone only when seen as an actually harvestable exact effect", () => {
  const stone = { kind: "first_policy", policy: { kind: "harvest_stock", resource: "minecraft:cobblestone",
    count: 2, maxBreaks: 3 }, requires: [{ item: "minecraft:wooden_pickaxe", count: 1 }], reserves: [] } as const;
  const seen = view({ inventory: { "minecraft:wooden_pickaxe": 1 },
    opportunities: [offer("face", "break", "block:minecraft:stone")] });
  expect(bindFirstPlan(request, stone, seen, liveScope)).toMatchObject({
    policy: { target: { kind: "stock", item: "minecraft:cobblestone", count: 1 },
      allowedEffects: ["break:minecraft:stone"], costCaps: [], maxBreaks: 1, maxCrafts: 0, maxPlacements: 0 },
  });
  expect(bindFirstPlan(request, stone, { ...seen, inventory: {} }, liveScope)).toEqual({ reason: "stock_prerequisite_missing" });
});

test("a goal-only result cannot migrate to another goal, life, or safety revision", () => {
  const live = view({ opportunities: [spruce] });
  for (const sample of [
    { ...live, run: "other" },
    { ...live, goal: "diamond" },
    { ...live, life: 2, epoch: 2, tick: 8 },
    { ...live, health: 0 },
    { ...live, health: 19 },
    { ...live, safety: { clear: false, revision: 2 } },
  ]) expect(bindFirstPlan(request, planks, sample, liveScope)).toEqual({ reason: "live_scope_changed" });
});

const result = (proposal: FirstPlanInference["proposal"], outcome: FirstPlanInference["outcome"] = "completed") =>
  ({ stage: PRE_SPAWN_GOAL_ONLY, model: TERRA_MODEL_ID, outcome, proposal, dispatched: true,
    latencyMs: 2, providerStartedAtMs: performance.now(), usage: null, costUsd: null }) satisfies FirstPlanInference;

async function fixture(infer: FirstPlanStrategist, signal?: AbortSignal, maxRequests = 1, strategy: "terra" | "deterministic" = "terra") {
  const dir = await mkdtemp(path.join(tmpdir(), "survival-first-plan-"));
  const run = path.basename(dir);
  let liveCalls = 0;
  const controller = new SurvivalMacroController({ runDir: dir, run, strategy, signal,
    ...(strategy === "terra" ? { durableWork: true, objective: "Mine a stone pickaxe" } : {}),
    limits: { maxRequests, pollMs: 1000 }, confirmNativeExit: async () => true,
    firstPlan: { request: { ...request, objective: "Mine a stone pickaxe" }, infer },
    strategist: async ({ observation: { run, life, epoch, tick } }) => {
      liveCalls++;
      return { basis: { run, life, epoch, tick }, outcome: "refused", model: TERRA_MODEL_ID,
        proposal: null, usage: null, costUsd: null, dispatched: true };
    },
  });
  const file = (name: string) => path.join(controller.directory, name);
  async function observe(change: Partial<MacroObservation> = {}) {
    await writeFile(file("observation.pending"), JSON.stringify(view({ ...change, run })), { mode: 0o600 });
    await rename(file("observation.pending"), file("observation.json"));
    await controller.poll();
  }
  async function log(name: string) {
    return (await readFile(file(name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  await controller.start();
  return { controller, observe, log, file, liveCalls: () => liveCalls, close: async () => {
    try { await controller.stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  } };
}

test("one paid startup request uses the existing quota and publishes only after a real matching view", async () => {
  const sent = Promise.withResolvers<FirstPlanRequest>();
  const reply = Promise.withResolvers<FirstPlanInference>();
  const f = await fixture(async input => { sent.resolve(input); return reply.promise; });
  try {
    expect(await sent.promise).toEqual({ goal: GOAL, objective: "Mine a stone pickaxe" });
    for (const name of ["observation.json", "planning.json", "intent.json", "work.json"])
      await expect(access(f.file(name))).rejects.toThrow();
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 0, issuedWorkOrders: 0 });
    reply.resolve(result(planks));
    await f.observe({ opportunities: [spruce] });
    expect(JSON.parse(await readFile(f.file("work.json"), "utf8"))).toMatchObject({
      origin: "model", life: 1, epoch: 1, basisTick: 5,
      target: { kind: "stock", item: "minecraft:spruce_planks", count: 4 },
    });
    await f.observe({ tick: 6, opportunities: [spruce] });
    expect(f.liveCalls()).toBe(0);
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 1, budget: "requests",
      issuedWorkOrders: 1, completedModelWorkOrders: 0 });
    expect(await f.log("proposals.jsonl")).toMatchObject([{ stage: PRE_SPAWN_GOAL_ONLY, basis: null, dispatched: true }]);
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_used")).toMatchObject({
      stage: PRE_SPAWN_GOAL_ONLY, basis: { tick: 5 }, timeToFirstUseMs: expect.any(Number),
    });
  } finally {
    reply.resolve(result(null, "cancelled"));
    await f.close();
  }
});

test("Stop while loading joins the startup call and records the charge even though no game observation existed", async () => {
  const abort = new AbortController();
  const started = Promise.withResolvers<void>();
  const f = await fixture(async (_input, signal, onDispatch) => {
    onDispatch(performance.now());
    started.resolve();
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return result(null, "cancelled");
  }, abort.signal);
  try {
    await started.promise;
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 1, unreportedDispatches: 1 });
    abort.abort();
    await f.controller.stop();
    expect(f.controller.status()).toMatchObject({ requests: 1, providerDispatches: 1, unreportedDispatches: 0,
      issuedWorkOrders: 0 });
    expect(await f.log("proposals.jsonl")).toMatchObject([{
      stage: PRE_SPAWN_GOAL_ONLY, basis: null, providerOutcome: "cancelled", dispatched: true,
    }]);
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_rejected")).toMatchObject({
      stage: PRE_SPAWN_GOAL_ONLY, reason: "stop", basis: null,
    });
    await expect(access(f.file("work.json"))).rejects.toThrow();
  } finally {
    abort.abort();
    await f.close();
  }
});

test("no late startup authority is admitted after respawn; the ordinary strategist waits for settlement", async () => {
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<FirstPlanInference>();
  const f = await fixture(async () => { started.resolve(); return reply.promise; }, undefined, 2);
  try {
    await started.promise;
    await f.observe({ opportunities: [spruce] });
    expect(f.liveCalls()).toBe(0);
    await f.observe({ tick: 6, life: 2, epoch: 2, opportunities: [spruce] });
    expect(f.liveCalls()).toBe(0);
    reply.resolve(result(planks));
    await f.observe({ tick: 7, life: 2, epoch: 2, opportunities: [spruce] });
    expect(f.liveCalls()).toBe(1);
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_rejected")).toMatchObject({
      reason: "live_scope_changed", basis: { life: 2 },
    });
  } finally {
    reply.resolve(result(null, "cancelled"));
    await f.close();
  }
});

test("a settled plan cannot substitute another species after the first observed match changed", async () => {
  const reply = Promise.withResolvers<FirstPlanInference>();
  const f = await fixture(async () => reply.promise, undefined, 2);
  try {
    await f.observe({ opportunities: [spruce] });
    reply.resolve(result(planks));
    await f.observe({ tick: 6, opportunities: [birch] });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect((await f.log("history.jsonl")).find(row => row.event === "first_plan_rejected")).toMatchObject({
      reason: "fresh_binding_changed", basis: { tick: 6 }, firstBasis: { tick: 5 },
    });
  } finally {
    reply.resolve(result(null, "cancelled"));
    await f.close();
  }
});

test("deterministic and prepared diagnostic never admit a paid first plan", async () => {
  let called = false;
  const f = await fixture(async () => { called = true; return result(planks); }, undefined, 1, "deterministic");
  try {
    const diagnostic = declareTerraStrategy({ maxRequests: 1, startup: "allow" }, 1_000, { preparedDiagnostic: true });
    expect(diagnostic.startup).toBe("off");
    expect(() => composeTerraSurvival({ declaration: diagnostic, firstPlanGoal: GOAL, projectRoot: "/example",
      dir: "/example/local/survival-agent/diagnostic-runs/test", actorJarSha256: "unused",
      display: { display: "unused", authority: "unused", stillOwned: () => false },
      width: 1, height: 1, ffmpeg: "unused", signal: new AbortController().signal,
      authDirectory: "unused", onDisplayLoss: () => {}, confirmNativeExit: async () => true,
    })).toThrow("did not admit goal-only startup inference");
    expect(declareTerraStrategy({ maxRequests: 1, startup: "off" }, 1_000).startup).toBe("off");
    expect(declareTerraStrategy({ maxRequests: 1 }, 1_000).startup).toBe("allow");
    expect(f.controller.status().requests).toBe(0);
    expect(called).toBe(false);
  } finally { await f.close(); }
});

test("provider time before observed play is tagged separately and does not count as native work or pause", () => {
  const note = reviewPauseJournal(
    "v1\trun\nstate\t1000000000\t1\tidle\nstate\t1200000000\t2\troute\ninput\t1200000000\t2\nend\t1400000000\t3\tgoal_completed\n",
    { run: "run", runStartedNs: 0n, cutoffNs: 1_400_000_000n,
      providerSpans: [{ startNs: 500_000_000n, endNs: 1_100_000_000n, terminalObserved: true, stage: PRE_SPAWN_GOAL_ONLY }] },
  );
  expect(note).toMatchObject({
    startupProviderPendingBeforeGameplayMs: 500,
    allGameplay: { longestIdleMs: 200 },
    providerOverlap: { pendingGameplayMs: 100, usefulOverlapMs: 0 },
    providerSpans: [{ stage: PRE_SPAWN_GOAL_ONLY, startMs: -500, endMs: 100 }],
  });
});
