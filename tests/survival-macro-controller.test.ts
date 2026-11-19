import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SurvivalMacroController } from "../src/server/survival-macro/controller.ts";
import {
  parseMacroIntent, parseMacroPlanning, type MacroBasis, type MacroIntent, type MacroObservation, type MacroStrategist,
} from "../src/server/survival-macro/protocol.ts";

async function fixture(confirmNativeExit?: () => Promise<boolean>, strategist?: MacroStrategist) {
  const dir = await mkdtemp(path.join(tmpdir(), "survival-macro-controller-"));
  const run = path.basename(dir);
  const actor = new SurvivalMacroController({
    runDir: dir, run, strategy: "terra", confirmNativeExit, limits: { maxRequests: 1, pollMs: 1_000, maxObservationAgeMs: 10_000 },
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
