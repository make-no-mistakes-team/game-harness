import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SurvivalMacroController } from "../src/server/survival-macro/controller.ts";
import { hasConfirmedTerraEffect } from "../src/shared/survival-agent-ui.ts";
import {
  parseMacroIntent, parseMacroPlanning, type MacroBasis, type MacroIntent, type MacroObservation, type MacroOpportunity,
  type MacroProposal, type MacroRequest, type MacroStrategist,
} from "../src/server/survival-macro/protocol.ts";

async function fixture(confirmNativeExit?: () => Promise<boolean>, strategist?: MacroStrategist, maxRequests = 1) {
  const dir = await mkdtemp(path.join(tmpdir(), "survival-macro-controller-"));
  const run = path.basename(dir);
  const actor = new SurvivalMacroController({
    runDir: dir, run, strategy: "terra", confirmNativeExit, limits: { maxRequests, pollMs: 1_000, maxObservationAgeMs: 10_000 },
    strategist: strategist ?? (async ({ observation: { run, life, tick, epoch } }) => ({
      basis: { run, life, tick, epoch }, model: "test-strategist", outcome: "completed",
      costUsd: null, usage: null, dispatched: false,
      proposal: {
        subgoal: "See the terrain", reason: "A safe survey is offered", successCondition: "Camera turns to the offered angle",
        contingency: "Wait if the survey is no longer visible", alternative: "Leave the camera still", expiresTick: tick + 100,
        action: { kind: "opportunity", opportunityId: "survey-left" },
      },
    })),
  });
  const file = (name: string) => path.join(actor.directory, name);
  const observation = (tick: number, life = 1, epoch = 5): MacroObservation => ({
    v: 1, run, life, epoch, tick, goal: "wooden_pickaxe", health: 20, food: 20, inventory: {},
    opportunities: [{ id: "survey-left", verb: "survey", risk: "read", summary: "Survey left", evidence: "Witnessed ground" }],
    recent: [], quiescent: false,
  });
  const publish = async (name: string, sample: unknown) => {
    await writeFile(file(`${name}.partial`), JSON.stringify(sample) + "\n", { mode: 0o600 });
    await rename(file(`${name}.partial`), file(name));
  };
  async function pending(): Promise<MacroIntent> {
    await publish("observation.json", observation(10));
    for (let iteration = 0; iteration < 4 && actor.status().issued === 0; iteration++) await actor.poll();
    return parseMacroIntent(JSON.parse(await readFile(file("intent.json"), "utf8")));
  }
  async function awaitWithdrawal() {
    const until = performance.now() + 1_000;
    while (performance.now() < until) {
      if (!await access(file("active.json")).then(() => true, () => false)) return;
      await delay(10);
    }
    throw new Error("Host did not withdraw native authority.");
  }
  await actor.start();
  return { actor, file, run, pending, publish, observation, awaitWithdrawal, clean: () => rm(dir, { recursive: true, force: true }) };
}

async function durableFixture(strategist: MacroStrategist, objective?: string, maxRequests = 2) {
  const dir = await mkdtemp(path.join(tmpdir(), "survival-work-"));
  const run = path.basename(dir);
  const actor = new SurvivalMacroController({
    runDir: dir, run, strategy: "terra", strategist, objective, durableWork: true, confirmNativeExit: async () => true,
    limits: { maxRequests, pollMs: 1000, maxObservationAgeMs: 10_000, requestTimeoutMs: 3500 },
  });
  const file = (name: string) => path.join(actor.directory, name);
  const observation = (tick: number, change: Partial<MacroObservation> = {}): MacroObservation => ({
    v: 1, run, life: 1, epoch: 1, tick, goal: "wooden_pickaxe", health: 20, food: 20, inventory: {},
    opportunities: [], recent: [], quiescent: false, safety: { clear: true, revision: 1 }, ...change,
  });
  async function observe(tick: number, change?: Partial<MacroObservation>) {
    await writeFile(file("observation.pending"), JSON.stringify(observation(tick, change)), { mode: 0o600 });
    await rename(file("observation.pending"), file("observation.json"));
    await actor.poll();
  }
  const order = async () => JSON.parse(await readFile(file("work.json"), "utf8"));
  function receipt(id: string, tick: number, status: "accepted" | "completed" | "interrupted" | "refused") {
    return writeFile(file("native-receipts.jsonl"), `${JSON.stringify({
      v: 1, id, run, life: 1, tick, status, detail: `native job ${status}`,
    })}\n`, { flag: "a", mode: 0o600 });
  }
  await actor.start();
  return { actor, observe, order, receipt, file, clean: () => rm(dir, { recursive: true, force: true }) };
}

function workReply(request: MacroRequest, action: MacroProposal["action"], ttl = 1100) {
  const { run, life, tick, epoch } = request.observation;
  return {
    basis: { run, life, tick, epoch }, model: "test-strategist", outcome: "completed" as const,
    costUsd: null, usage: null, dispatched: true,
    proposal: {
      subgoal: "Build stock", reason: "Bounded goal", successCondition: "Inventory reaches target", contingency: "Stop on risk",
      alternative: "Reassess stock", expiresTick: tick + ttl, action,
    },
  };
}

test("An admitted preset works during a paid request and an equivalent authorization leaves the job untouched", async () => {
  const request = Promise.withResolvers<MacroRequest>();
  const reply = Promise.withResolvers<void>();
  const f = await durableFixture(async input => {
    request.resolve(input);
    await reply.promise;
    return workReply(input, { kind: "work", policy: input.work!.current!.policy });
  });
  try {
    expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 0, requests: 0, providerDispatches: 0 });
    await f.observe(10);
    const first = await f.order();
    expect(first).toMatchObject({ origin: "preset", target: { kind: "preset", goal: "wooden_pickaxe" } });
    await f.receipt(first.id, 11, "accepted");
    await f.observe(11, { workOrder: { id: first.id, state: "working", detail: "native job admitted" } });
    expect((await request.promise).work).toMatchObject({ current: { id: first.id }, demand: "first" });
    reply.resolve();
    await f.observe(20, { epoch: 2, workOrder: { id: first.id, state: "working", detail: "route active" } });
    expect(await f.order()).toEqual(first);
    expect(f.actor.status()).toMatchObject({ providerDispatches: 1, completedWorkOrders: 0 });
    const history = await readFile(f.file("history.jsonl"), "utf8");
    expect(history).toContain('"event":"work_order_retained"');
  } finally {
    reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["opportunity", "neutral handoff"] as const)(
  "A post-receipt %s wakes work planning once after an in-flight abstention", async wake => {
    const reply = Promise.withResolvers<void>();
    const requests: MacroRequest[] = [];
    const survey = { id: "survey-left", verb: "survey", risk: "read", summary: "Survey left", evidence: "Witnessed ground" } as const;
    const approach = { id: "approach", verb: "approach", risk: "low", summary: "Walk to the adjacent tile", evidence: "Clear dry sweep" } as const;
    const f = await durableFixture(async request => {
      requests.push(request);
      if (requests.length === 2) return workReply(request, { kind: "opportunity", opportunityId: survey.id });
      if (requests.length === 3) {
        await reply.promise;
        return workReply(request, { kind: "abstain" }, wake === "neutral handoff" ? 80 : 1100);
      }
      return workReply(request, { kind: "abstain" });
    }, undefined, 6);
    try {
      await f.observe(10);
      const job = await f.order();
      await f.receipt(job.id, 12, "accepted");
      await f.observe(13);
      await f.receipt(job.id, 64, "interrupted");
      const workOrder = { id: job.id, state: "blocked", detail: "No live source" } as const;
      await f.observe(94, { workOrder, opportunities: [survey] });
      await f.actor.poll();
      const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
      expect(requests).toHaveLength(2);

      await f.receipt(intent.id, 174, "accepted");
      await f.receipt(intent.id, 180, "completed");
      await f.observe(177, { workOrder }); // The journal can outrun observation.json.
      expect(requests).toHaveLength(2);
      await f.observe(181, { workOrder });
      expect(requests[2]).toMatchObject({
        trigger: "receipt", observation: { tick: 181, opportunities: [], quiescent: false },
        lastReceipt: { id: intent.id, tick: 180, status: "completed" },
      });

      const fresh = wake === "opportunity" ? { opportunities: [approach] } : { quiescent: true };
      await f.observe(262, { workOrder, ...fresh });
      expect(requests).toHaveLength(3); // Still one inference in flight.
      reply.resolve();
      for (let i = 0; i < 4 && requests.length === 3; i++) await f.actor.poll();
      expect(requests[3]).toMatchObject({ observation: { tick: 262, ...fresh }, lastReceipt: { id: intent.id } });

      await f.receipt(intent.id, 180, "completed"); // Replayed terminal evidence is not a new edge.
      await f.observe(345, { workOrder, ...fresh });
      await f.observe(430, { workOrder, ...fresh });
      expect(requests).toHaveLength(4);
      expect(f.actor.status()).toMatchObject({
        requests: 4, providerDispatches: 4, issued: 1, completedReceipts: 1,
        staleDecisions: wake === "neutral handoff" ? 1 : 0,
      });
      await expect(access(f.file("intent.json"))).rejects.toThrow();
    } finally {
      reply.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test("Constrained stages require witnessed input stock and obsolete dispatched inference is still charged", async () => {
  const log = "minecraft:oak_log";
  const action = { kind: "work-program", stages: [{ policy: {
    target: { kind: "stock", item: "minecraft:oak_planks", count: 12 },
    allowedEffects: ["craft:oak_planks"], costCaps: [{ item: log, count: 1 }], reserves: [{ item: log, count: 2 }],
    maxBreaks: 0, maxCrafts: 1, maxPlacements: 0,
  }, requires: [{ item: log, count: 3 }] }, { policy: {
    target: { kind: "stock", item: "minecraft:stick", count: 4 },
    allowedEffects: ["craft:stick"], costCaps: [{ item: "minecraft:oak_planks", count: 2 }], reserves: [{ item: log, count: 2 }],
    maxBreaks: 0, maxCrafts: 1, maxPlacements: 0,
  }, requires: [{ item: "minecraft:oak_planks", count: 2 }] }] } as const;
  const second = Promise.withResolvers<void>();
  const f = await durableFixture(async input => {
    if (input.observation.tick > 10) await second.promise;
    return workReply(input, action);
  }, "Keep at least two oak logs");
  try {
    await f.observe(10, { inventory: { [log]: 2 } });
    await f.actor.poll();
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.actor.status().providerDispatches).toBe(1);
    await f.observe(210, { inventory: { [log]: 3 } });
    await f.observe(211, { epoch: 2, life: 2, inventory: { [log]: 7 } });
    second.resolve();
    for (let i = 0; i < 3; ++i) await f.actor.poll();
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({ providerDispatches: 2, issuedWorkOrders: 0, staleDecisions: 1 });
  } finally {
    second.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test("Renewal replaces the lease before exhaustion and revoke waits for the real native outcome", async () => {
  const demands: NonNullable<MacroRequest["work"]>[] = [];
  const f = await durableFixture(async request => {
    const demand = request.work!;
    demands.push(demand);
    return workReply(request, demands.length === 3
      ? { kind: "revoke-work", workOrderId: demand.current!.id }
      : { kind: "work", policy: demand.current!.policy });
  }, undefined, 3);
  try {
    await f.observe(10);
    const first = await f.order();
    const working = (id: string) => ({ id, state: "working", detail: "native job active" } as const);
    await f.receipt(first.id, 11, "accepted");
    await f.observe(11, { workOrder: working(first.id) });
    await f.actor.poll();
    await f.observe(1120, { epoch: 3, workOrder: working(first.id) });
    await f.actor.poll();
    const renewed = await f.order();
    expect(renewed).toMatchObject({ origin: "preset", basisTick: 1120, epoch: 3, target: first.target });
    expect(renewed.id).not.toBe(first.id);
    expect(renewed.expiresTick).toBeGreaterThan(first.expiresTick);
    expect(demands.map(demand => demand.demand)).toEqual(["first", "renew"]);
    await f.receipt(first.id, 1121, "interrupted");
    await f.receipt(renewed.id, 1121, "accepted");
    await f.observe(1121, { workOrder: working(renewed.id), epoch: 3 });
    expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 2, unresolvedWorkOrders: 1 });

    await f.observe(2111, { workOrder: working(renewed.id), epoch: 4 });
    await f.actor.poll();
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({ providerDispatches: 3, unresolvedWorkOrders: 1, completedWorkOrders: 0 });
    await f.receipt(renewed.id, 2112, "interrupted");
    await f.observe(2112, { epoch: 4 });
    expect(f.actor.status()).toMatchObject({ unresolvedWorkOrders: 0, completedWorkOrders: 0 });
    const receipts = (await readFile(f.file("receipts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(receipts.map(entry => entry.receipt.status)).toEqual(["accepted", "interrupted", "accepted", "interrupted"]);
    expect(receipts.at(-1)).toMatchObject({ eligible: false, afterWithdrawal: true });
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("Request exhaustion does not invent a successor or interrupt compatible admitted work", async () => {
  const f = await durableFixture(async request => workReply(request, { kind: "abstain" }), undefined, 1);
  try {
    await f.observe(10);
    const job = await f.order();
    const workOrder = { id: job.id, state: "working", detail: "native job active" } as const;
    await f.receipt(job.id, 11, "accepted");
    await f.observe(11, { workOrder });
    await f.actor.poll();
    await f.observe(1120, { workOrder });
    expect(await f.order()).toEqual(job);
    expect(f.actor.status()).toMatchObject({ budget: "requests", providerDispatches: 1, issuedWorkOrders: 1 });
    await f.receipt(job.id, 1121, "completed");
    await f.observe(1121, { workOrder: { ...workOrder, state: "complete" } });
    expect(f.actor.status()).toMatchObject({ completedWorkOrders: 1, completedReceipts: 0, issuedWorkOrders: 1 });
    expect(hasConfirmedTerraEffect(f.actor.status())).toBe(false);
    await expect(access(f.file("work.json"))).rejects.toThrow();
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("A refused replacement retains the incumbent byte-for-byte; provider loss does not revoke it", async () => {
  let calls = 0;
  const f = await durableFixture(async request => {
    ++calls;
    if (calls === 2) return {
      ...workReply(request, { kind: "abstain" }), outcome: "provider_unavailable", dispatched: false, proposal: null,
    };
    return workReply(request, { kind: "work", policy: {
      target: { kind: "stock", item: "minecraft:oak_log", count: 10 },
      allowedEffects: ["break:minecraft:oak_log"], costCaps: [], reserves: [],
      maxBreaks: 12, maxCrafts: 0, maxPlacements: 0,
    } });
  });
  try {
    await f.observe(10);
    const incumbent = await f.order();
    const workOrder = { id: incumbent.id, state: "working", detail: "incumbent remains active" } as const;
    await f.receipt(incumbent.id, 11, "accepted");
    await f.observe(11, { workOrder });
    await f.actor.poll();
    const candidate = await f.order();
    expect(candidate.id).not.toBe(incumbent.id);
    expect(f.actor.status().workOrder?.id).toBe(incumbent.id);

    await f.receipt(candidate.id, 12, "refused");
    await f.observe(12, { workOrder, epoch: 2 });
    expect(await f.order()).toEqual(incumbent);
    expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 2, unresolvedWorkOrders: 1, completedWorkOrders: 0 });

    await f.observe(1120, { workOrder, epoch: 3 });
    await f.actor.poll();
    expect(await f.order()).toEqual(incumbent);
    expect(f.actor.status()).toMatchObject({ providerDispatches: 1, lastProviderOutcome: "provider_unavailable" });
    await f.receipt(incumbent.id, 1121, "completed");
    await f.observe(1121, { epoch: 4 });
    expect(f.actor.status()).toMatchObject({
      completedWorkOrders: 1, completedModelWorkOrders: 0, unresolvedWorkOrders: 0,
      lastWorkOrder: { id: incumbent.id, origin: "preset", terminal: { status: "completed" } },
    });
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("Approaching a live stock goal starts successor planning without publishing it before native completion", async () => {
  const log = "minecraft:oak_log";
  const planks = "minecraft:oak_planks";
  const reply = Promise.withResolvers<void>();
  const renewal = Promise.withResolvers<MacroRequest>();
  let calls = 0;
  const f = await durableFixture(async request => {
    if (++calls === 1) return workReply(request, { kind: "work", policy: {
      target: { kind: "stock", item: log, count: 3 }, allowedEffects: ["break:minecraft:oak_log"],
      costCaps: [], reserves: [], maxBreaks: 5, maxCrafts: 0, maxPlacements: 0,
    } });
    renewal.resolve(request);
    await reply.promise;
    return workReply(request, { kind: "work", afterWorkId: request.work!.current!.id, policy: {
      target: { kind: "stock", item: planks, count: 4 }, allowedEffects: ["craft:oak_planks"],
      costCaps: [{ item: log, count: 1 }], reserves: [{ item: log, count: 2 }], maxBreaks: 0, maxCrafts: 1, maxPlacements: 0,
    } });
  }, "Gather wood and keep at least two logs once stocked");
  try {
    await f.observe(10);
    await f.actor.poll();
    const first = await f.order();
    await f.receipt(first.id, 11, "accepted");
    const workOrder = { id: first.id, state: "working", detail: "native job active" } as const;
    await f.observe(100, { epoch: 2, workOrder, inventory: { [log]: 2 } });
    expect((await renewal.promise).work).toMatchObject({ demand: "successor", current: { id: first.id } });
    reply.resolve();
    await f.actor.poll();
    expect(await f.order()).toEqual(first);
    expect(f.actor.status()).toMatchObject({ workQueuedAfter: first.id, completedWorkOrders: 0 });

    await f.receipt(first.id, 110, "completed");
    await f.observe(109, { epoch: 2, workOrder, inventory: { [log]: 2 } });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.actor.status().workQueuedAfter).toBe(first.id);
    await f.observe(110, { epoch: 3, workOrder: { ...workOrder, state: "complete" }, inventory: { [log]: 3 } });
    const next = await f.order();
    expect(next).toMatchObject({ basisTick: 110, epoch: 3, origin: "model", target: { kind: "stock", item: planks, count: 4 } });
    expect(next.id).not.toBe(first.id);
    expect(f.actor.status()).toMatchObject({ providerDispatches: 2, completedModelWorkOrders: 1, workQueuedAfter: null });
    expect(hasConfirmedTerraEffect(f.actor.status())).toBe(true);
  } finally {
    reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test("A single model work program crosses two native receipts and preserves reserves without extra approval", async () => {
  const log = "minecraft:oak_log";
  const planks = "minecraft:oak_planks";
  const f = await durableFixture(async request => workReply(request, { kind: "work-program", stages: [
    { policy: { target: { kind: "stock", item: log, count: 5 }, allowedEffects: ["break:minecraft:oak_log"],
      costCaps: [], reserves: [{ item: log, count: 1 }], maxBreaks: 6, maxCrafts: 0, maxPlacements: 0 }, requires: [] },
    { policy: { target: { kind: "stock", item: planks, count: 12 }, allowedEffects: ["craft:oak_planks"],
      costCaps: [{ item: log, count: 3 }], reserves: [{ item: log, count: 1 }],
      maxBreaks: 0, maxCrafts: 3, maxPlacements: 0 }, requires: [{ item: log, count: 4 }] },
    { policy: { target: { kind: "preset", goal: "wooden_pickaxe" },
      allowedEffects: ["craft:stick", "craft:crafting_table", "place:minecraft:crafting_table", "craft:wooden_pickaxe"],
      costCaps: [{ item: planks, count: 9 }, { item: "minecraft:crafting_table", count: 1 }, { item: "minecraft:stick", count: 2 }],
      reserves: [{ item: log, count: 1 }], maxBreaks: 0, maxCrafts: 3, maxPlacements: 1 },
      requires: [{ item: planks, count: 9 }, { item: log, count: 1 }] },
  ] }), "Keep one log when possible and make the pickaxe", 1);
  try {
    await f.observe(10);
    await f.actor.poll();
    const gather = await f.order();
    await f.receipt(gather.id, 11, "accepted");
    await f.observe(80, { inventory: { [log]: 3 }, workOrder: {
      id: gather.id, state: "needs_replan", detail: "Harvest active",
      progress: { phase: "harvest", status: "Breaking a witnessed log", breaks: 3, crafts: 0, placements: 0,
        lastEffect: { tick: 78, detail: "Collected a log" }, replan: "cap_near" },
    } });
    expect(await f.order()).toEqual(gather);
    await f.receipt(gather.id, 100, "completed");
    await f.observe(100, { epoch: 2, inventory: { [log]: 5 } });
    const craft = await f.order();
    expect(craft).toMatchObject({ target: { item: planks, count: 12 }, expiresTick: gather.expiresTick });
    await f.receipt(craft.id, 101, "accepted");
    await f.receipt(craft.id, 120, "completed");
    await f.observe(120, { epoch: 3, inventory: { [log]: 2, [planks]: 12 } });
    const pick = await f.order();
    expect(pick).toMatchObject({ target: { kind: "preset", goal: "wooden_pickaxe" }, expiresTick: gather.expiresTick });
    await f.receipt(pick.id, 121, "accepted");
    await f.receipt(pick.id, 140, "completed");
    await f.observe(140, { epoch: 4, inventory: { [log]: 2, [planks]: 3, "minecraft:wooden_pickaxe": 1 } });
    expect(f.actor.status()).toMatchObject({
      providerDispatches: 1, issuedWorkOrders: 3, completedModelWorkOrders: 3, completedWorkPrograms: 1, workQueuedAfter: null,
      completedWorkProgram: { stages: 3, goal: "wooden_pickaxe", invocationItemCount: 1, receipt: { id: pick.id, tick: 140, status: "completed" },
        basis: { tick: 140, epoch: 4, life: 1 }, stock: [{ item: log, observed: 2, required: 1 }] },
    });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    await f.observe(141, { epoch: 5, life: 2, inventory: {} });
    expect(f.actor.status()).toMatchObject({ completedWorkPrograms: 1, completedWorkProgram: null });
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test.each([
  { terminal: "interrupted", actual: 5, reason: "predecessor_did_not_complete" },
  { terminal: "completed", actual: 4, reason: "predecessor_stock_not_confirmed" },
] as const)("A $terminal receipt with $actual live logs cannot unlock the second stage", async ({ terminal, actual, reason }) => {
  const log = "minecraft:oak_log";
  const f = await durableFixture(async request => workReply(request, { kind: "work-program", stages: [
    { policy: { target: { kind: "stock", item: log, count: 5 }, allowedEffects: ["break:minecraft:oak_log"],
      costCaps: [], reserves: [], maxBreaks: 6, maxCrafts: 0, maxPlacements: 0 }, requires: [] },
    { policy: { target: { kind: "stock", item: "minecraft:oak_planks", count: 8 }, allowedEffects: ["craft:oak_planks"],
      costCaps: [{ item: log, count: 2 }], reserves: [{ item: log, count: 1 }], maxBreaks: 0, maxCrafts: 2, maxPlacements: 0 },
      requires: [{ item: log, count: 3 }] },
  ] }), "Keep a log and make planks", 1);
  try {
    await f.observe(10);
    await f.actor.poll();
    const first = await f.order();
    await f.receipt(first.id, 11, "accepted");
    await f.receipt(first.id, 50, terminal);
    await f.observe(50, { epoch: 2, inventory: { [log]: actual } });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 1, completedWorkPrograms: 0, workQueuedAfter: null });
    expect(await readFile(f.file("history.jsonl"), "utf8")).toContain(`"reason":"${reason}"`);
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("A completed stock program keeps its original zero invocation count even after a later pickup", async () => {
  const log = "minecraft:oak_log";
  const planks = "minecraft:oak_planks";
  const f = await durableFixture(async request => workReply(request, { kind: "work-program", stages: [
    { policy: { target: { kind: "stock", item: log, count: 2 }, allowedEffects: ["break:minecraft:oak_log"],
      costCaps: [], reserves: [], maxBreaks: 2, maxCrafts: 0, maxPlacements: 0 }, requires: [] },
    { policy: { target: { kind: "stock", item: planks, count: 4 }, allowedEffects: ["craft:oak_planks"],
      costCaps: [{ item: log, count: 1 }], reserves: [{ item: log, count: 1 }], maxBreaks: 0, maxCrafts: 1, maxPlacements: 0 },
      requires: [{ item: log, count: 2 }] },
  ] }), "Gather construction supplies", 1);
  try {
    await f.observe(10);
    await f.actor.poll();
    const first = await f.order();
    await f.receipt(first.id, 11, "accepted");
    await f.receipt(first.id, 50, "completed");
    await f.observe(50, { epoch: 2, inventory: { [log]: 2 } });
    const second = await f.order();
    await f.receipt(second.id, 51, "accepted");
    await f.receipt(second.id, 70, "completed");
    await f.observe(70, { epoch: 3, inventory: { [log]: 1, [planks]: 4 } });
    await f.observe(71, { epoch: 4, inventory: { [log]: 1, [planks]: 4, "minecraft:wooden_pickaxe": 1 } });
    expect(f.actor.status()).toMatchObject({ completedWorkPrograms: 1,
      completedWorkProgram: { invocationItemCount: 0, basis: { tick: 70 }, receipt: { id: second.id } } });
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("Stop joins matching native neutrality and preserves an interrupted in-flight intent", async () => {
  const f = await fixture();
  try {
    const intent = await f.pending();
    expect(intent.basisTick).toBe(10);
    const stopped = f.actor.stop();
    await f.awaitWithdrawal();
    const accepted = { v: 1, id: intent.id, run: intent.run, life: intent.life, tick: 11, status: "accepted", detail: "Admitted." };
    const interrupted = { ...accepted, status: "interrupted", detail: "Input retired.", tick: 12 };
    await writeFile(f.file("native-receipts.jsonl"), `${JSON.stringify(accepted)}\n${JSON.stringify(interrupted)}\n`, { mode: 0o600 });
    await f.publish("revoked.json", { v: 1, run: f.run, life: 1, epoch: 5, tick: 12 });
    await stopped;
    expect(f.actor.status()).toMatchObject({
      state: "stopped", nativeAuthority: "revoked", terminalReceipts: 1, completedReceipts: 0, unresolvedIntents: 0,
    });
    const receipts = (await readFile(f.file("receipts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(receipts.map(entry => entry.receipt.status)).toEqual(["accepted", "interrupted"]);
  } finally {
    await f.actor.stop().catch(() => {});
    await f.clean();
  }
});

test("Stop rejects a stale-life acknowledgement and does not invent a terminal receipt", async () => {
  const f = await fixture();
  try {
    await f.pending();
    await f.publish("observation.json", f.observation(20, 2, 6));
    await f.actor.poll();
    const stopped = f.actor.stop();
    const observedStop = stopped.catch(error => error);
    await f.awaitWithdrawal();
    const stale: MacroBasis = { run: f.run, life: 1, epoch: 5, tick: 30 };
    await f.publish("revoked.json", { v: 1, ...stale });
    expect(await observedStop).toBeInstanceOf(AggregateError);
    expect(f.actor.status()).toMatchObject({
      state: "faulted", nativeAuthority: "unconfirmed", terminalReceipts: 0, completedReceipts: 0, unresolvedIntents: 1,
    });
  } finally {
    await f.actor.stop().catch(() => {});
    await f.clean();
  }
});

test("Exact owned Java exit proves only authority loss; missing terminal effect remains unresolved", async () => {
  const exit = Promise.withResolvers<boolean>();
  const f = await fixture(() => exit.promise);
  try {
    await f.pending();
    let closed = false;
    const stopped = f.actor.stop().then(() => { closed = true; });
    await f.awaitWithdrawal();
    expect(closed).toBe(false);
    exit.resolve(true);
    await stopped;
    expect(f.actor.status()).toMatchObject({
      state: "stopped", nativeAuthority: "exited", terminalReceipts: 0, completedReceipts: 0, unresolvedIntents: 1,
    });
  } finally {
    exit.resolve(false);
    await f.actor.stop().catch(() => {});
    await f.clean();
  }
});

test("Unconfirmed native authority times out without treating the marker removal as clean", async () => {
  const f = await fixture();
  try {
    await expect(f.actor.stop()).rejects.toThrow("did not close cleanly");
    expect(f.actor.status()).toMatchObject({ state: "faulted", nativeAuthority: "unconfirmed", completedReceipts: 0 });
  } finally {
    await f.actor.stop().catch(() => {});
    await f.clean();
  }
});

test("At three seconds a pending provider remains live; routine ticks do not renew its native planning notice", async () => {
  const reply = Promise.withResolvers<void>();
  const dispatched = Promise.withResolvers<AbortSignal>();
  const f = await fixture(async () => true, async ({ observation: { run, life, tick, epoch } }, signal) => {
    dispatched.resolve(signal);
    await reply.promise;
    return {
      basis: { run, life, tick, epoch }, model: "test-strategist", outcome: "refused",
      latencyMs: 3_125, dispatched: true, costUsd: null, usage: null, proposal: null,
    };
  });
  try {
    await f.publish("observation.json", f.observation(10));
    await f.actor.poll();
    const signal = await dispatched.promise;
    const notice = parseMacroPlanning(JSON.parse(await readFile(f.file("planning.json"), "utf8")));
    expect(notice).toMatchObject({ v: 1, run: f.run, life: 1, epoch: 5, basisTick: 10 });
    expect(f.actor.status()).toMatchObject({ state: "inferring", planningIdleMs: 3_000, planningEpisodeId: notice.id });
    await delay(3_005);
    await f.publish("observation.json", f.observation(71));
    await f.actor.poll();
    expect(signal.aborted).toBe(false);
    expect(parseMacroPlanning(JSON.parse(await readFile(f.file("planning.json"), "utf8")))).toEqual(notice);
    await expect(access(f.file("intent.json"))).rejects.toThrow();

    reply.resolve();
    for (let iteration = 0; iteration < 4 && f.actor.status().lastProviderOutcome === null; iteration++) await f.actor.poll();
    await expect(access(f.file("planning.json"))).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({
      requests: 1, providerDispatches: 1, lastProviderLatencyMs: 3_125, planningEpisodeId: null, issued: 0,
    });
  } finally {
    reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
}, 10_000);

const mining = { verb: "break", subject: "block:minecraft:iron_ore" };
const crafting = { verb: "continue", subject: "recipe:stone_pickaxe" };
const rawIron = "minecraft:raw_iron";
const cobblestone = "minecraft:cobblestone";
function materialOffer(id: string, target: string, selector = mining, spends = {}): MacroOpportunity {
  return { id, verb: selector.verb, risk: "guarded", summary: "Native material offer", evidence: "Visible subject",
    material: { subject: selector.subject, target, spends } };
}

async function continuationFixture(steps: Extract<MacroProposal["action"], { kind: "continuation" }>["steps"],
  reserves: Extract<MacroProposal["action"], { kind: "continuation" }>["reserves"] = []) {
  const first = materialOffer("first-ore", "ore-a");
  const f = await fixture(async () => true, async ({ observation: { run, life, tick, epoch } }) => ({
    basis: { run, life, tick, epoch }, model: "test-strategist", outcome: "completed", costUsd: null, usage: null, dispatched: true,
    proposal: { subgoal: "Mine a fixed amount", reason: "The ore was witnessed", successCondition: "Check owned raw iron",
      contingency: "Stop if the material target or safe footing changes", alternative: "Reassess visible opportunities",
      expiresTick: tick + 100, action: { kind: "continuation", opportunityId: first.id, steps, reserves } },
  }));
  const observe = (tick: number, opportunities: readonly MacroOpportunity[], inventory: MacroObservation["inventory"] = {},
    change: Partial<MacroObservation> = {}) => f.publish("observation.json",
    { ...f.observation(tick), opportunities, inventory, safety: { clear: true, revision: 1 }, ...change });
  const intent = async () => parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
  const receipt = (pending: MacroIntent, tick: number, status: "accepted" | "completed") => ({
    v: 1, id: pending.id, run: pending.run, life: pending.life, tick, status, detail: "Matching native material effect",
  });
  const finish = async (pending: MacroIntent, tick: number, accepted = true) => {
    const lines = [...(accepted ? [receipt(pending, tick - 1, "accepted")] : []), receipt(pending, tick, "completed")];
    await writeFile(f.file("native-receipts.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n",
      { flag: "a", mode: 0o600 });
  };
  const firstIntent = async (others: readonly MacroOpportunity[] = [], supply?: MacroObservation["inventory"]) => {
    await observe(10, [first, ...others], supply);
    for (let iteration = 0; iteration < 4 && !f.actor.status().issued; iteration++) await f.actor.poll();
    return intent();
  };
  return { ...f, observe, intent, finish, firstIntent };
}

test("A bounded continuation uses a fresh distinct target and cannot advance past an unmet stock floor", async () => {
  const craft = materialOffer("craft-tool", "one-recipe", crafting, { [cobblestone]: 3 });
  const f = await continuationFixture([
    { selector: mining, maxEffects: 2, until: { item: rawIron, count: 2 } },
    { selector: crafting, maxEffects: 1, until: null },
  ]);
  try {
    const first = await f.firstIntent([craft], { [cobblestone]: 6 });
    await f.finish(first, 14);
    const duplicate = materialOffer("same-ore-other-face", "ore-a");
    const different = materialOffer("coal", "ore-b", { ...mining, subject: "block:minecraft:coal_ore" });
    const second = materialOffer("next-ore", "ore-c");
    await f.observe(14, [duplicate, different, second, craft], { [cobblestone]: 6 });
    await f.actor.poll();
    await expect(f.intent()).rejects.toThrow();
    await f.observe(15, [duplicate, different, second, craft], { [cobblestone]: 6 });
    await f.actor.poll();
    const next = await f.intent();
    expect(next).toMatchObject({ opportunityId: second.id, basisTick: 15, skillHash: null });
    expect(next.id).not.toBe(first.id);
    await f.finish(next, 19);
    await f.observe(20, [craft], { [cobblestone]: 6 }, { epoch: 6 });
    await f.actor.poll();
    await expect(f.intent()).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({ requests: 1, issued: 2, completedReceipts: 2 });
    const history = await readFile(f.file("history.jsonl"), "utf8");
    expect(history).toContain('"reason":"stock_floor_unmet"');
    expect(history).not.toContain(`"${rawIron}":2`);
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("A completed prior primitive does not spend through a currently protected inventory reserve", async () => {
  const craft = materialOffer("craft-tool", "one-recipe", crafting, { [cobblestone]: 3 });
  const f = await continuationFixture([
    { selector: mining, maxEffects: 1, until: null },
    { selector: crafting, maxEffects: 1, until: null },
  ], [{ item: cobblestone, count: 3 }]);
  try {
    const first = await f.firstIntent([craft], { [cobblestone]: 6 });
    await f.finish(first, 14);
    await f.observe(15, [craft], { [cobblestone]: 5 }, { epoch: 6 });
    await f.actor.poll();
    await expect(f.intent()).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({ requests: 1, issued: 1, completedReceipts: 1 });
    expect(await readFile(f.file("history.jsonl"), "utf8")).toContain('"reason":"inventory_reserve"');
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("Missing native stock evidence is not an empty known spend", async () => {
  const f = await continuationFixture([{ selector: mining, maxEffects: 2, until: null }],
    [{ item: cobblestone, count: 1 }]);
  try {
    const first = await f.firstIntent([], { [cobblestone]: 1 });
    await f.finish(first, 14);
    const { material: _unknown, ...noStockEvidence } = materialOffer("next-ore", "ore-b");
    await f.observe(15, [noStockEvidence], { [cobblestone]: 1 });
    await f.actor.poll();
    await expect(f.intent()).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({ issued: 1, completedReceipts: 1 });
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("An observed pickup floor unlocks one fresh recipe in the same bounded reply", async () => {
  const pickup = { verb: "collect", subject: `item:${rawIron}` };
  const drop = materialOffer("nearby-drop", "one-drop", pickup);
  const craft = materialOffer("craft-tool", "one-recipe", crafting, { [cobblestone]: 3 });
  const f = await continuationFixture([
    { selector: mining, maxEffects: 1, until: null },
    { selector: pickup, maxEffects: 1, until: { item: rawIron, count: 2 } },
    { selector: crafting, maxEffects: 1, until: null },
  ], [{ item: cobblestone, count: 3 }]);
  try {
    const first = await f.firstIntent([drop, craft], { [rawIron]: 1, [cobblestone]: 6 });
    await f.finish(first, 14);
    const currentDrop = materialOffer("newly-visible-drop", "second-drop", pickup);
    await f.observe(15, [currentDrop, craft], { [rawIron]: 1, [cobblestone]: 6 });
    await f.actor.poll();
    const collect = await f.intent();
    expect(collect.opportunityId).toBe(currentDrop.id);

    await f.finish(collect, 19);
    const currentRecipe = materialOffer("current-recipe", "one-recipe", crafting, { [cobblestone]: 3 });
    await f.observe(20, [currentRecipe], { [rawIron]: 2, [cobblestone]: 6 }, { epoch: 6 });
    await f.actor.poll();
    const recipe = await f.intent();
    expect(recipe).toMatchObject({ opportunityId: currentRecipe.id, epoch: 6, basisTick: 20, skillHash: null });
    await f.finish(recipe, 24);
    await f.observe(25, [currentRecipe], { [rawIron]: 2, [cobblestone]: 3 }, { epoch: 7 });
    await f.actor.poll();
    await expect(f.intent()).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({ requests: 1, providerDispatches: 1, issued: 3, completedReceipts: 3 });
    const stockSamples = (await readFile(f.file("history.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
      .filter(row => row.event === "direct_continuation_stock");
    expect(stockSamples[0].observedStock).toContainEqual({ item: rawIron, before: 1, after: 1 });
    expect(stockSamples[1].observedStock).toContainEqual({ item: rawIron, before: 1, after: 2 });
    expect(stockSamples[2].observedStock).toContainEqual({ item: cobblestone, before: 6, after: 3 });
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["missing acceptance", "prior life", "changed safety revision", "damage"] as const)(
  "A continuation cannot advance after %s", async fence => {
    const f = await continuationFixture([{ selector: mining, maxEffects: 2, until: null }]);
    try {
      const first = await f.firstIntent();
      await f.finish(first, 14, fence !== "missing acceptance");
      const change: Partial<MacroObservation> = fence === "prior life" ? { life: 2, epoch: 6 }
        : fence === "changed safety revision" ? { safety: { clear: true, revision: 2 }, epoch: 7 }
        : fence === "damage" ? { health: 19 } : {};
      await f.observe(15, [materialOffer("next-ore", "ore-b")], {}, change);
      await f.actor.poll();
      await expect(f.intent()).rejects.toThrow();
      expect(f.actor.status()).toMatchObject({ requests: 1, issued: 1 });
      expect(await readFile(f.file("history.jsonl"), "utf8")).not.toContain('"event":"direct_continuation_stock"');
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

test("Stop fences the remaining direct permission despite a late matching native completion", async () => {
  const f = await continuationFixture([{ selector: mining, maxEffects: 2, until: null }]);
  try {
    const first = await f.firstIntent();
    const stopped = f.actor.stop();
    await f.awaitWithdrawal();
    await f.finish(first, 14);
    await f.observe(15, [materialOffer("next-ore", "ore-b")]);
    await f.publish("revoked.json", { v: 1, run: f.run, life: 1, epoch: 5, tick: 15 });
    await stopped;
    expect(f.actor.status()).toMatchObject({ state: "stopped", issued: 1, completedReceipts: 0,
      lateCompletedReceipts: 1, directContinuation: null });
    expect(await readFile(f.file("history.jsonl"), "utf8")).not.toContain('"event":"direct_continuation_stock"');
  } finally {
    await f.actor.stop().catch(() => {});
    await f.clean();
  }
});

async function lookaheadFixture(mode: "single" | "remaining" | "short-gui" | "failure" = "single") {
  const originOffer = mode === "short-gui" ? materialOffer("origin", "current-recipe", crafting) : materialOffer("origin", "ore-a");
  const successorOffer = materialOffer("next-ore", "ore-b");
  const reply = Promise.withResolvers<void>();
  const requests: MacroRequest[] = [];
  const f = await fixture(async () => true, async request => {
    requests.push(request);
    const { run, life, tick, epoch } = request.observation;
    const basis = { run, life, tick, epoch };
    const common = { basis, model: "test-strategist", costUsd: null, usage: null, dispatched: true };
    if (request.lookahead) await reply.promise;
    if (request.lookahead && mode === "failure") return { ...common, outcome: "provider_error", proposal: null };
    const action: MacroProposal["action"] = request.lookahead ?
      { kind: "successor", afterIntentId: request.lookahead.predecessor.intentId, opportunityId: successorOffer.id,
        requires: [{ item: rawIron, count: 2 }], reserves: [{ item: cobblestone, count: 1 }] } :
      mode === "remaining" ? { kind: "continuation", opportunityId: originOffer.id,
        steps: [{ selector: mining, maxEffects: 2, until: null }], reserves: [] } :
      { kind: "opportunity", opportunityId: originOffer.id };
    return { ...common, outcome: "completed", proposal: { subgoal: "Use nearby material",
      reason: "Two exact offers were witnessed", successCondition: "Native verifies selected action",
      contingency: "Abort if footing or supply changes", alternative: "Wait for a fresh witness", expiresTick: tick + 100, action } };
  }, 2);
  const observe = (tick: number, opportunities: readonly MacroOpportunity[], inventory: MacroObservation["inventory"] = {},
    change: Partial<MacroObservation> = {}) => f.publish("observation.json", { ...f.observation(tick), opportunities, inventory,
    safety: { clear: true, revision: 1 }, ...change });
  const intent = async () => parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
  const receipt = (pending: MacroIntent, tick: number, status: "accepted" | "completed" | "interrupted") =>
    writeFile(f.file("native-receipts.jsonl"), JSON.stringify({ v: 1, run: pending.run, id: pending.id, life: pending.life,
      tick, status, detail: "Matching native receipt" }) + "\n", { flag: "a", mode: 0o600 });
  const firstIntent = async () => {
    await observe(10, [originOffer, successorOffer], { [cobblestone]: 1 });
    for (let i = 0; i < 4 && !f.actor.status().issued; i++) await f.actor.poll();
    return intent();
  };
  const startCrack = async (origin: MacroIntent, tick = 15) => {
    await observe(tick, [], { [cobblestone]: 1 }, { working: { intentId: origin.id, crack: 0.15 } });
    await f.actor.poll();
  };
  const settleConditional = async () => {
    reply.resolve();
    for (let i = 0; i < 4 && f.actor.status().lookahead?.phase === "inferring"; i++) await f.actor.poll();
  };
  return { ...f, observe, requests, reply, intent, receipt, firstIntent, startCrack, settleConditional, successorOffer };
}

test("Lookahead needs native acceptance and real work, then waits for fresh completion and stock", async () => {
  const f = await lookaheadFixture();
  try {
    const origin = await f.firstIntent();
    await f.startCrack(origin, 12);
    expect(f.requests.length).toBe(1);
    await f.receipt(origin, 13, "accepted");
    await f.observe(14, []);
    await f.actor.poll();
    expect(f.requests.length).toBe(1);
    await f.startCrack(origin);
    expect(f.requests.length).toBe(2);
    expect(f.requests[1]?.lookahead).toMatchObject({ predecessor: { intentId: origin.id, acceptedTick: 13 },
      witnessBasis: { tick: 10 }, candidates: [{ id: f.successorOffer.id }] });
    expect(f.requests[1]?.observation.inventory[rawIron]).toBeUndefined();
    await f.settleConditional();
    expect(f.actor.status().lookahead).toEqual({ predecessorId: origin.id, phase: "conditional" });
    expect(await f.intent()).toEqual(origin);
    await f.receipt(origin, 20, "completed");
    await f.observe(20, [f.successorOffer], { [rawIron]: 2, [cobblestone]: 1 }, { epoch: 6 });
    await f.actor.poll();
    await expect(f.intent()).rejects.toThrow();
    await f.observe(21, [f.successorOffer], { [rawIron]: 2, [cobblestone]: 1 }, { epoch: 6 });
    await f.actor.poll();
    const successor = await f.intent();
    expect(successor).toMatchObject({ opportunityId: f.successorOffer.id, basisTick: 21, epoch: 6, skillHash: null });
    expect(successor.id).not.toBe(origin.id);
    expect(f.actor.status()).toMatchObject({ requests: 2, issued: 2, lookahead: null });
    expect(await readFile(f.file("history.jsonl"), "utf8")).toContain('"outcome":"issued"');
  } finally {
    f.reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["low stock", "changed target", "interrupted", "other life", "danger", "owner change"] as const)(
  "A conditional lookahead does not actuate after %s", async fence => {
    const f = await lookaheadFixture();
    try {
      const origin = await f.firstIntent();
      await f.receipt(origin, 13, "accepted");
      await f.startCrack(origin);
      await f.settleConditional();
      await f.receipt(origin, 20, fence === "interrupted" ? "interrupted" : "completed");
      const live = fence === "changed target" ? materialOffer(f.successorOffer.id, "invalid-rebinding") : f.successorOffer;
      const change = fence === "other life" ? { life: 2, epoch: 6 } :
        fence === "danger" ? { safety: { clear: false, revision: 2 }, epoch: 6 } :
        fence === "owner change" ? { working: { intentId: "another-owner", crack: 0.2 } } : {};
      await f.observe(21, [live], { [rawIron]: fence === "low stock" ? 1 : 2, [cobblestone]: 1 }, change);
      await f.actor.poll();
      await expect(f.intent()).rejects.toThrow();
      expect(f.actor.status()).toMatchObject({ requests: 2, issued: 1, lookahead: null });
    } finally {
      f.reply.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each(["remaining", "short-gui"] as const)("Lookahead does not spend a call during %s", async mode => {
  const f = await lookaheadFixture(mode);
  try {
    const origin = await f.firstIntent();
    await f.receipt(origin, 13, "accepted");
    await f.startCrack(origin);
    expect(f.requests.length).toBe(1);
    expect(await f.intent()).toEqual(origin);
  } finally {
    f.reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test("A failed lookahead provider leaves the original work admitted", async () => {
  const f = await lookaheadFixture("failure");
  try {
    const origin = await f.firstIntent();
    await f.receipt(origin, 13, "accepted");
    await f.startCrack(origin);
    await f.settleConditional();
    expect(await f.intent()).toEqual(origin);
    expect(f.actor.status()).toMatchObject({ requests: 2, issued: 1, lookahead: null });
    await f.receipt(origin, 20, "completed");
    await f.observe(21, [f.successorOffer]);
    await f.actor.poll();
    expect(f.actor.status().completedReceipts).toBe(1);
  } finally {
    f.reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test("A late successor still uses current post-completion evidence without another paid request", async () => {
  const f = await lookaheadFixture();
  try {
    const origin = await f.firstIntent();
    await f.receipt(origin, 13, "accepted");
    await f.startCrack(origin);
    await f.receipt(origin, 20, "completed");
    await f.observe(21, [f.successorOffer], { [rawIron]: 2, [cobblestone]: 1 }, { epoch: 6 });
    await f.actor.poll();
    expect(f.actor.status()).toMatchObject({ requests: 2, issued: 1, lookahead: { phase: "inferring" } });
    await expect(f.intent()).rejects.toThrow();
    await f.settleConditional();
    expect(await f.intent()).toMatchObject({ opportunityId: f.successorOffer.id, basisTick: 21, epoch: 6 });
    expect(f.actor.status()).toMatchObject({ requests: 2, issued: 2 });
  } finally {
    f.reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test("Stop revokes a settled successor even with an exact late completion and supply witness", async () => {
  const f = await lookaheadFixture();
  try {
    const origin = await f.firstIntent();
    await f.receipt(origin, 13, "accepted");
    await f.startCrack(origin);
    await f.settleConditional();
    const stopped = f.actor.stop();
    await f.awaitWithdrawal();
    await f.receipt(origin, 20, "completed");
    await f.observe(21, [f.successorOffer], { [rawIron]: 2, [cobblestone]: 1 }, { epoch: 6 });
    await f.publish("revoked.json", { v: 1, run: f.run, life: 1, epoch: 6, tick: 21 });
    await stopped;
    expect(f.actor.status()).toMatchObject({ state: "stopped", requests: 2, issued: 1, lateCompletedReceipts: 1, lookahead: null });
  } finally {
    f.reply.resolve();
    await f.actor.stop().catch(() => {});
    await f.clean();
  }
});

test("A stale premise removes its planning notice and Stop leaves no planning authority", async () => {
  const reply = Promise.withResolvers<void>();
  const f = await fixture(async () => true, async ({ observation: { run, life, tick, epoch } }) => {
    await reply.promise;
    return {
      basis: { run, life, tick, epoch }, model: "test-strategist", outcome: "cancelled",
      dispatched: true, costUsd: null, usage: null, proposal: null,
    };
  });
  try {
    await f.publish("observation.json", f.observation(10));
    await f.actor.poll();
    const notice = parseMacroPlanning(JSON.parse(await readFile(f.file("planning.json"), "utf8")));
    expect(notice).toMatchObject({ v: 1, run: f.run, life: 1, epoch: 5, basisTick: 10 });
    expect(f.actor.status().planningEpisodeId).toBe(notice.id);
    await f.publish("observation.json", f.observation(15, 1, 6));
    await f.actor.poll();
    await expect(access(f.file("planning.json"))).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({ planningEpisodeId: null, requests: 1 });
    reply.resolve();
    await f.actor.stop();
    await expect(access(f.file("planning.json"))).rejects.toThrow();
  } finally {
    reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});
