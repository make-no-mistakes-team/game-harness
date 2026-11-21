import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTrustedFrameCapture } from "../src/server/survival-macro/compose.ts";
import { SurvivalMacroController, type SurvivalMacroConfig } from "../src/server/survival-macro/controller.ts";
import { hasConfirmedTerraEffect } from "../src/shared/survival-agent-ui.ts";
import {
  MACRO_DIAMOND_PROSPECT, MacroDirectory, MacroObservationRotating, parseMacroIntent, parseMacroPlanning,
  type MacroBasis, type MacroInference, type MacroIntent, type MacroObservation, type MacroOpportunity,
  type MacroProposal, type MacroRequest, type MacroStrategist,
} from "../src/server/survival-macro/protocol.ts";

async function fixture(
  confirmNativeExit?: () => Promise<boolean>, strategist?: MacroStrategist, maxRequests = 1,
  frameFor?: (dir: string) => SurvivalMacroConfig["frame"],
) {
  const dir = await mkdtemp(path.join(tmpdir(), "survival-macro-controller-"));
  const run = path.basename(dir);
  const actor = new SurvivalMacroController({
    runDir: dir, run, strategy: "terra", confirmNativeExit, limits: { maxRequests, pollMs: 1_000, maxObservationAgeMs: 10_000 },
    frame: frameFor?.(dir),
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
  function receipt(id: string, tick: number, status: "accepted" | "parked" | "completed" | "interrupted" | "refused",
    detail = `native job ${status}`) {
    return writeFile(file("native-receipts.jsonl"), `${JSON.stringify({
      v: 1, id, run, life: 1, tick, status, detail,
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

const captureJpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AH//Z", "base64");
const captureHash = createHash("sha256").update(captureJpeg).digest("hex");

test.each(["stable", "unavailable", "newer tick", "new life", "display lost", "not dispatched"] as const)(
  "A live camera request with %s admits only an owned, exact-basis frame",
  async condition => {
    let owned = true;
    let shots = 0;
    let beforeBytes: (() => Promise<void>) | undefined;
    const requests: MacroRequest[] = [];
    const f = await fixture(async () => true, async request => {
      requests.push(request);
      // The private archive must already exist when the strategist receives bytes.
      const files = await readdir(archive);
      if (request.frame) expect(await readFile(path.join(archive, files[0]!))).toEqual(captureJpeg);
      return {
        ...workReply(request, { kind: "abstain" }),
        dispatched: condition !== "not dispatched",
        frameSha256: condition !== "not dispatched" && request.frame ? captureHash : undefined,
      };
    }, 1, dir => createTrustedFrameCapture({
      dir, width: 1, height: 1, signal: new AbortController().signal,
      assertDisplay: () => { if (!owned) throw new Error("Private display no longer owned."); },
      readJpeg: async () => {
        shots++;
        await beforeBytes?.();
        return condition === "unavailable" ? { cause: "unavailable", failure: "empty_output" } : { bytes: captureJpeg };
      },
    }));
    const archive = f.file("../macro-frames");
    beforeBytes = async () => {
      if (condition === "newer tick") await f.publish("observation.json", f.observation(11));
      if (condition === "new life") await f.publish("observation.json", f.observation(11, 2, 6));
      if (condition === "display lost") owned = false;
    };
    try {
      await mkdir(archive, { mode: 0o700 });
      await f.publish("observation.json", f.observation(10));
      const until = performance.now() + 1_000;
      do {
        await f.actor.poll();
        const status = f.actor.status();
        if (status.state === "faulted" || (status.requests && !status.unreportedDispatches)) break;
        await delay(10);
      } while (performance.now() < until);
      expect(shots).toBe(1);
      expect(f.actor.status().state).not.toBe("faulted");
      expect(f.actor.status()).toMatchObject({ requests: 1, unreportedDispatches: 0 });
      await f.actor.stop();
      const proposals = (await readFile(f.file("proposals.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(proposals).toHaveLength(1);
      expect(proposals[0].frameSha256).toBe(condition === "stable" ? captureHash : null);
      if (condition === "new life") {
        expect(proposals[0]).toMatchObject({ basis: { life: 1, epoch: 5, tick: 10 },
          dispatched: false, disposition: "stale", proposal: null });
      }
      if (condition === "new life" || condition === "display lost") expect(requests).toHaveLength(0);
      else expect(requests).toHaveLength(1);
      if (condition === "stable" || condition === "not dispatched") {
        expect(requests[0]?.frame).toMatchObject({ run: f.run, life: 1, epoch: 5, tick: 10, data: captureJpeg });
        expect(requests[0]?.frame?.artifact).toBeUndefined();
      } else {
        expect(requests[0]?.frame).toBeUndefined();
      }
      expect(await readdir(archive)).toHaveLength(condition === "stable" ? 1 : 0);
      if (condition === "newer tick" || condition === "unavailable") {
        const history = (await readFile(f.file("history.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
        expect(history).toContainEqual(expect.objectContaining({
          event: "request_frame_omitted", cause: condition === "newer tick" ? "basis_changed" : "unavailable",
          ...(condition === "unavailable" ? { failure: "empty_output" } : {}),
        }));
        expect(requests[0]?.observation.tick).toBe(10);
      }
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

const xvfbTools = Object.fromEntries(["xvfb-run", "Xvfb", "xauth", "xsetroot", "scrot", "ffmpeg"]
  .map(name => [name, Bun.which(name, { PATH: "/usr/bin:/bin" })]));
const scrotVersion = xvfbTools.scrot && /\bscrot version (\d+)\.(\d+)\b/.exec(
  Bun.spawnSync([xvfbTools.scrot, "--version"], { stderr: "ignore" }).stdout.toString(),
);

test.skipIf(!Object.values(xvfbTools).every(Boolean) || !scrotVersion ||
  !(+scrotVersion[1]! > 1 || (+scrotVersion[1]! === 1 && +scrotVersion[2]! >= 10)))(
  "Production scrot archives the real pixels of an owned private Xvfb",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "private-frame-xvfb-"));
    try {
      const authority = path.join(dir, "Xauthority");
      await writeFile(authority, "", { flag: "wx", mode: 0o600 });
      const worker = Bun.spawn([
        xvfbTools["xvfb-run"]!, "-a", "-f", authority,
        "-s", `-screen 0 1280x720x24 -nolisten tcp -noreset -auth ${authority}`,
        process.execPath, "--no-env-file", path.join(import.meta.dir, "helpers/survival-frame-xvfb.fixture.ts"),
        xvfbTools.Xvfb!, xvfbTools.xsetroot!, xvfbTools.ffmpeg!,
      ], { cwd: dir, env: { PATH: "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([
        worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text(),
      ]);
      expect({ exit, stdout: stdout.trim(), stderr }).toEqual({ exit: 0, stdout: "owned-visual-frame", stderr: "" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

const bucketStock = {
  inventory: { "minecraft:iron_ingot": 3, "minecraft:iron_pickaxe": 1 },
  opportunities: [{ id: "o-7", verb: "interact", risk: "guarded",
    summary: "Open visible minecraft:crafting_table", evidence: "A lit workstation face is inside vanilla use reach." }],
} as const;

function invalidBucketReply(request: MacroRequest): MacroInference {
  return { ...workReply(request, { kind: "abstain" }), outcome: "invalid", proposal: null, invalidReply: "guarded_opportunity" };
}

test.each(["exact source", "only flow", "reserved bucket", "select clue"] as const)(
  "Live bucket fill admission with %s",
  async condition => {
    const bucket = "minecraft:bucket", pickaxe = "minecraft:iron_pickaxe";
    const waterBucket = "minecraft:water_bucket", id = "o-water";
    const reserves = condition === "reserved bucket" ? [{ item: pickaxe, count: 1 }, { item: bucket, count: 1 }]
      : [{ item: pickaxe, count: 1 }];
    const f = await durableFixture(async request => workReply(request, condition === "select clue"
      ? { kind: "opportunity", opportunityId: id }
      : { kind: "work", policy: {
        target: { kind: "stock", item: waterBucket, count: 1 }, allowedEffects: ["fill:minecraft:water"],
        costCaps: [{ item: bucket, count: 1 }], reserves, maxBreaks: 0, maxCrafts: 0, maxPlacements: 0,
      } }), "Fill the bucket only from a reachable source without losing the pickaxe.", condition === "exact source" ? 2 : 1);
    try {
      await f.observe(20, {
        goal: "diamond", quiescent: true, inventory: { [bucket]: 1, [pickaxe]: 1 },
        opportunities: [{ id, verb: "fill_water", risk: "read",
          summary: condition === "only flow" ? "Flowing water without a reachable source" : "Witnessed source water in bucket reach",
          evidence: "Rendered from dry footing",
          ...(condition === "only flow" ? {} : { material: {
            subject: "fluid:minecraft:water_source", target: "m-water", spends: { [bucket]: 1 },
          } }),
        }],
      });
      await f.actor.poll();
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      if (condition === "exact source") {
        const fill = await f.order();
        expect(fill).toMatchObject({ origin: "model", basisTick: 20,
          target: { item: waterBucket, count: 1 }, allowedEffects: ["fill:minecraft:water"], reserves });
        await f.receipt(fill.id, 21, "accepted");
        await f.observe(fill.expiresTick - 30, { goal: "diamond", inventory: { [bucket]: 1, [pickaxe]: 1 },
          workOrder: { id: fill.id, state: "working", detail: "Awaiting the exact vanilla bucket swap" } });
        expect(await f.order()).toEqual(fill);
        expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 0, providerDispatches: 1 });
      } else {
        await expect(access(f.file("work.json"))).rejects.toThrow();
        expect(await readFile(f.file("history.jsonl"), "utf8")).toContain(condition === "only flow"
          ? "flowing water but no witnessed source" : condition === "reserved bucket"
            ? "2 minecraft:bucket at entry" : "A water clue grants no primitive");
      }
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

test("An invalid constrained reply gets one fresh correction to craft a bucket at the witnessed table", async () => {
  const requests: MacroRequest[] = [];
  const reserves = [{ item: "minecraft:iron_pickaxe", count: 1 }];
  const f = await durableFixture(async request => {
    requests.push(request);
    if (requests.length === 1) return workReply(request, { kind: "work", policy: { ...ironPolicy, reserves } });
    if (requests.length === 2) return invalidBucketReply(request);
    return workReply(request, { kind: "work", policy: {
      target: { kind: "stock", item: "minecraft:bucket", count: 1 },
      allowedEffects: ["craft:bucket"],
      costCaps: [{ item: "minecraft:iron_ingot", count: 3 }],
      reserves,
      maxBreaks: 0, maxCrafts: 1, maxPlacements: 0,
    } });
  }, "Prepare a bucket without spending the iron pickaxe.", 3);
  try {
    await f.observe(100, { goal: "diamond", inventory: {
      [ironItem]: 1, [rawIronItem]: 2, [fuelItem]: 2, [furnaceItem]: 1, "minecraft:iron_pickaxe": 1,
    } });
    await f.actor.poll();
    const furnace = await f.order();
    await f.receipt(furnace.id, 104, "accepted");
    await f.receipt(furnace.id, 749, "completed");
    const table = { ...bucketStock, goal: "diamond", workOrder: {
      id: furnace.id, state: "complete", detail: "Collected the two furnace-produced iron ingots.",
    } } satisfies Partial<MacroObservation>;

    await f.observe(1136, table);
    await f.actor.poll();
    await f.observe(1215, table);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.work).toMatchObject({ demand: "outcome", current: null });
    await expect(access(f.file("intent.json"))).rejects.toThrow();
    await expect(access(f.file("work.json"))).rejects.toThrow();

    await f.observe(1216, table);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({
      observation: { tick: 1216, ...bucketStock },
      feedback: { kind: "invalid_reply", detail: expect.stringContaining("guarded") },
      work: { demand: "outcome", current: null, lastOutcome: { receipt: { id: furnace.id, tick: 749, status: "completed" } } },
      lastReceipt: null,
    });
    await f.actor.poll();
    expect(await f.order()).toMatchObject({
      basisTick: 1216, target: { item: "minecraft:bucket", count: 1 }, allowedEffects: ["craft:bucket"],
      reserves: [{ item: "minecraft:iron_pickaxe", count: 1 }],
    });
    expect(f.actor.status()).toMatchObject({ requests: 3, providerDispatches: 3, completedWorkOrders: 1 });
    expect(await readFile(f.file("proposals.jsonl"), "utf8")).toContain('"proposal":null');
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["invalid", "malformed", "abstain", "gap", "incomplete"] as const)(
  "A repeated %s reply cannot spin queries on unchanged native stock",
  async outcome => {
    const requests: MacroRequest[] = [];
    const f = await durableFixture(async request => {
      requests.push(request);
      if (outcome === "abstain") return workReply(request, { kind: "abstain" });
      if (outcome === "gap") return workReply(request, { kind: "gap", capability: "No useful supported action" });
      if (outcome === "incomplete") return { ...invalidBucketReply(request), invalidReply: undefined };
      if (outcome === "malformed") return {
        ...workReply(request, { kind: "abstain" }), proposal: { action: "raw-private-provider-content" },
      };
      return invalidBucketReply(request);
    }, "Prepare a bucket.", 8);
    try {
      await f.observe(10, bucketStock);
      await f.observe(100, bucketStock);
      await f.observe(200, bucketStock);
      const sameTable = { ...bucketStock.opportunities[0], id: "o-8" };
      await f.observe(300, { ...bucketStock, opportunities: [sameTable] });
      expect(requests).toHaveLength(outcome === "invalid" || outcome === "malformed" ? 2 : 1);
      if (outcome === "abstain") {
        await f.observe(350, { ...bucketStock, opportunities: [sameTable, { id: "camera-only", verb: "survey", risk: "read",
          summary: "Turn away from the workstation", evidence: "The camera can turn in place." }] });
        expect(requests).toHaveLength(1);
        const recipe = { id: "o-9", verb: "continue", risk: "guarded", summary: "Craft a bucket at the visible table",
          evidence: "The inventory has the ingredients and the table is in reach.",
          material: { subject: "recipe:bucket", target: "bucket-recipe", spends: { "minecraft:iron_ingot": 3 } } } as const;
        await f.observe(400, { ...bucketStock, opportunities: [sameTable, recipe] });
        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({ observation: { tick: 400, opportunities: [sameTable, recipe] } });
        expect(requests[1]?.feedback).toBeUndefined(); // Newly actionable recipe, not schema repair.
        await f.observe(500, { ...bucketStock, opportunities: [
          { ...sameTable, id: "o-10" }, { ...recipe, id: "o-11" },
        ] });
        expect(requests).toHaveLength(2);
      }
      if (outcome === "malformed") {
        expect(requests[1]?.feedback?.detail).toContain("Invalid survival macro field: proposal.");
        expect(await readFile(f.file("proposals.jsonl"), "utf8")).not.toContain("raw-private-provider-content");
        expect(await readFile(f.file("history.jsonl"), "utf8")).not.toContain("raw-private-provider-content");
      }
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      await expect(access(f.file("work.json"))).rejects.toThrow();
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

const caveSurvey = { id: "left", verb: "survey", risk: "read", summary: "Survey left from this stance",
  evidence: "A bounded first-person turn over nearby terrain." } as const;
const caveFooting = { id: "dry-floor", verb: "approach", risk: "low", summary: "Walk to the adjacent flat tile",
  evidence: "Lit full top and clear dry sweep.", anchor: { target: "floor-1", subject: "route:dry" } } as const;
const cavePolicy = { target: { kind: "stock", item: "minecraft:diamond", count: 1 },
  allowedEffects: [MACRO_DIAMOND_PROSPECT, "break:minecraft:diamond_ore"],
  reserves: [{ item: "minecraft:iron_pickaxe", count: 1 }], costCaps: [],
  maxBreaks: 8, maxCrafts: 0, maxPlacements: 0 } as const;
const caveState = { goal: "diamond", stance: 2, inventory: { "minecraft:iron_pickaxe": 1 } } as const;

const wall = { block: "minecraft:stone", target: "wall-a", tool: "minecraft:iron_pickaxe", maxToolLoss: 0 } as const;
const wallPolicy = { ...cavePolicy, allowedEffects: [...cavePolicy.allowedEffects, "break:minecraft:stone"],
  reserves: [...cavePolicy.reserves, { item: "minecraft:raw_iron", count: 2 }] } as const;
const wallState = { ...caveState, inventory: { ...caveState.inventory, "minecraft:raw_iron": 2 } } as const;

const visibleTimber = { kind: "resource", subject: "block:minecraft:oak_log", target: "log-a",
  footing: "dry", bearingDegrees: -12, windowBlocks: 0.9 } as const;
const timberRiser = { kind: "resource", subject: visibleTimber.subject, target: visibleTimber.target,
  footing: "one_block_grade", bearingDegrees: -12, heightChange: 1 } as const;
const visibleWoodland = { ...visibleTimber, kind: "woodland_frontier", subject: "landmark:woodland", target: "canopy-a" } as const;
const timberPolicy = { target: { kind: "stock", item: "minecraft:oak_log", count: 1 },
  allowedEffects: ["break:minecraft:oak_log"], costCaps: [], reserves: [], maxBreaks: 2, maxCrafts: 0, maxPlacements: 0 } as const;

const oakObstruction = { block: "minecraft:oak_leaves", target: "leaf-a",
  toward: { subject: visibleTimber.subject, target: visibleTimber.target }, timber: "minecraft:oak_log" } as const;

test.each(["priced", "no leaf grant", "wrong leaf", "no log allowance", "changed leaf", "changed tree", "abstain"] as const)(
  "A timber obstruction can bind one ordinary stock replan, not a leaf action (%s)", async condition => {
    const reply = Promise.withResolvers<void>();
    const requests: MacroRequest[] = [];
    const f = await durableFixture(async request => {
      requests.push(request);
      if (requests.length === 1) return workReply(request, { kind: "work", policy: timberPolicy });
      await reply.promise;
      if (condition === "abstain") return workReply(request, { kind: "abstain" });
      const effect = condition === "wrong leaf" ? "break:minecraft:birch_leaves" : "break:minecraft:oak_leaves";
      return workReply(request, { kind: "work", policy: { ...timberPolicy,
        allowedEffects: condition === "no leaf grant" ? timberPolicy.allowedEffects : [...timberPolicy.allowedEffects, effect],
        maxBreaks: condition === "no log allowance" ? 1 : 2,
      } });
    }, "Gather oak logs; one visibly blocking leaf may be removed if needed.", 4);
    try {
      await f.observe(16, { stance: 2, travelHint: visibleTimber });
      await f.actor.poll();
      const earlier = await f.order();
      await f.receipt(earlier.id, 18, "accepted");
      await f.observe(18, { stance: 2, workOrder: { id: earlier.id, state: "working", detail: "Walking toward the witnessed oak." } });
      await f.receipt(earlier.id, 100, "interrupted", "The witnessed leaf needs one explicit preparatory break.");
      const blocked = { stance: 3, timberObstruction: oakObstruction,
        workOrder: { id: earlier.id, state: "blocked", detail: "The witnessed leaf needs one explicit preparatory break." } } as const;
      await f.observe(101, blocked);
      expect(requests[1]?.observation.timberObstruction).toEqual(oakObstruction);
      if (condition === "changed leaf" || condition === "changed tree") {
        const timberObstruction = condition === "changed leaf" ? { ...oakObstruction, target: "leaf-b" }
          : { ...oakObstruction, toward: { ...oakObstruction.toward, target: "log-b" } };
        await f.observe(102, { ...blocked, timberObstruction });
      }
      reply.resolve();
      await f.actor.poll();
      if (condition === "priced") {
        const order = await f.order();
        expect(order).toMatchObject({ maxBreaks: 2, travelAnchor: oakObstruction.toward });
        expect(new Set(order.allowedEffects)).toEqual(new Set(["break:minecraft:oak_log", "break:minecraft:oak_leaves"]));
      } else {
        await expect(access(f.file("work.json"))).rejects.toThrow();
      }
      if (condition === "abstain" || condition === "no leaf grant") {
        await f.observe(250, { ...blocked, opportunities: [{ ...caveSurvey, id: "new-id-same-survey" }] });
        expect(requests).toHaveLength(2);
      }
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      expect(f.actor.status().completedReceipts).toBe(0);
    } finally {
      reply.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each(["direct", "opening", "wade", "one-block step", "woodland instead", "exact harvest", "unpriced harvest",
  "wake", "other log", "lost runway", "unsafe", "unanchored look",
  "witness disappears", "clue used as ID", "yaw jitter"] as const)("A timber job starts only on its scoped live evidence (%s)", async condition => {
  const requests: MacroRequest[] = [];
  const reply = Promise.withResolvers<void>();
  const freshReply = Promise.withResolvers<void>();
  const direct = condition === "direct" || condition === "witness disappears" || condition === "clue used as ID" || condition === "yaw jitter";
  const idle = condition === "wake" || condition === "yaw jitter";
  const wrongOpening = condition === "other log" || condition === "unanchored look";
  const view = condition === "unanchored look" ? caveSurvey : {
    id: "inspect-log", verb: "inspect", risk: "read", summary: "Center the visible oak log",
    evidence: "The visible log is next to the edge of the frame.", anchor: { subject: visibleTimber.subject, target: visibleTimber.target },
  } as const;
  const spends: Record<string, number> = {};
  if (condition === "unpriced harvest") spends["minecraft:wooden_axe"] = 1;
  const harvest: MacroOpportunity = {
    id: "harvest-log", verb: "break", risk: "guarded", summary: "Break visible oak log",
    evidence: "The inspected vanilla face is in reach.",
    material: { subject: visibleTimber.subject, target: visibleTimber.target, spends },
  };
  const f = await durableFixture(async request => {
    requests.push(request);
    if (idle && requests.length === 1) return workReply(request, { kind: "abstain" });
    if (wrongOpening && requests.length > 1) {
      await freshReply.promise;
      return workReply(request, { kind: "work", policy: timberPolicy });
    }
    await reply.promise;
    if (condition === "clue used as ID") return workReply(request, { kind: "opportunity", opportunityId: visibleTimber.target });
    return workReply(request, { kind: "work", policy: timberPolicy,
      ...(direct || condition === "wake" ? {} : { openingViewId: view.id }) });
  }, "Collect oak logs from the visible tree.", idle || wrongOpening || condition === "lost runway" ? 2 : 1);
  try {
    await f.observe(16, { stance: 2, ...(direct ? { travelHint: visibleTimber } :
      { opportunities: condition === "wake" ? [] : [view] }) });
    if (idle) {
      await f.actor.poll();
      await f.observe(condition === "yaw jitter" ? 116 : 21, { stance: 2, travelHint: { ...visibleTimber, bearingDegrees: 2 } });
    }
    reply.resolve();
    if (condition === "witness disappears") await f.observe(21, { stance: 2 });
    else await f.actor.poll();
    if (!direct && condition !== "wake") {
      const travelHint = condition === "other log" ? { ...visibleTimber, target: "log-b" } :
        condition === "woodland instead" ? { ...visibleWoodland, target: visibleTimber.target } :
        condition === "wade" ? { ...visibleTimber, footing: "shallow_water_with_bank" as const } :
        condition === "one-block step" ? timberRiser : visibleTimber;
      const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
      await f.receipt(intent.id, 21, "accepted");
      await f.receipt(intent.id, 26, "completed");
      await f.observe(26, { stance: 2 });
      await expect(access(f.file("work.json"))).rejects.toThrow();
      await f.observe(31, { stance: 2, ...(condition === "unsafe" ? { safety: { clear: false, revision: 2 } } :
        condition === "exact harvest" || condition === "unpriced harvest" ? { opportunities: [harvest] } :
          condition === "lost runway" ? { opportunities: [{ ...view, id: "same-log-without-runway" }] } : { travelHint }) });
      if (condition === "lost runway") await f.observe(116, { stance: 2 });
      if (wrongOpening) {
        await f.observe(116, { stance: 2, travelHint });
        expect(requests[1]).toMatchObject({ observation: { tick: 116, travelHint },
          feedback: { kind: "opening_view_unconfirmed" }, lastReceipt: { id: intent.id, status: "completed" } });
        await expect(access(f.file("work.json"))).rejects.toThrow();
        await expect(access(f.file("intent.json"))).rejects.toThrow();
        freshReply.resolve();
        await f.actor.poll();
        expect(await f.order()).toMatchObject({ origin: "model", ...timberPolicy, basisTick: 116,
          travelAnchor: { subject: travelHint.subject, target: travelHint.target } });
      }
    }
    if (condition === "direct" || condition === "opening" || condition === "wade"
        || condition === "one-block step" || condition === "wake") {
      expect(await f.order()).toMatchObject({ origin: "model", ...timberPolicy,
        basisTick: condition === "direct" ? 16 : condition === "wake" ? 21 : 31,
        travelAnchor: { subject: visibleTimber.subject, target: visibleTimber.target } });
      expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 0, completedReceipts: 0 });
    } else if (condition === "exact harvest") {
      const order = await f.order();
      expect(order).toMatchObject({ origin: "model", ...timberPolicy, basisTick: 31,
        harvestAnchor: { subject: visibleTimber.subject, target: visibleTimber.target } });
      expect(order.travelAnchor).toBeUndefined();
    } else if (!wrongOpening) await expect(access(f.file("work.json"))).rejects.toThrow();
    await expect(access(f.file("intent.json"))).rejects.toThrow();
    expect(requests).toHaveLength(condition === "wake" || wrongOpening ? 2 : 1);
  } finally {
    reply.resolve();
    freshReply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test("A witnessed timber step starts one bounded job, but landing does not count as pickup", async () => {
  const requests: MacroRequest[] = [];
  const f = await durableFixture(async request => {
    requests.push(request);
    return workReply(request, { kind: "work", policy: timberPolicy });
  }, "Approach the visible tree and collect one oak log.", 1);
  try {
    await f.observe(16, { stance: 2, travelHint: timberRiser });
    await f.actor.poll();
    const order = await f.order();
    expect(order).toMatchObject({ ...timberPolicy, travelAnchor: { subject: timberRiser.subject, target: timberRiser.target } });
    await f.receipt(order.id, 17, "accepted");
    const workOrder = { id: order.id, state: "working", detail: "Landed on the witnessed step; no harvest yet.",
      progress: { phase: "route", status: "Landed", breaks: 0, crafts: 0, placements: 0 } } as const;
    await f.observe(35, { stance: 3, workOrder });
    expect(await f.order()).toEqual(order);
    expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 0, completedReceipts: 0 });
    await expect(access(f.file("intent.json"))).rejects.toThrow();
    await f.observe(48, { stance: 3, workOrder: { ...workOrder, detail: "Cut the witnessed oak; waiting for its drop.",
      progress: { ...workOrder.progress, phase: "collect", status: "Waiting for pickup", breaks: 1 } } });
    expect(await f.order()).toEqual(order);
    expect(f.actor.status().completedModelWorkOrders).toBe(0);
    await f.receipt(order.id, 52, "completed");
    await f.observe(52, { stance: 3, inventory: { [timberPolicy.target.item]: 1 },
      workOrder: { id: order.id, state: "complete", detail: "Vanilla inventory confirms the pickup." } });
    expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 1, providerDispatches: 1 });
    expect(requests).toHaveLength(1);
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("The first usable woodland window wakes idle work without offering a leaf or log effect", async () => {
  const requests: MacroRequest[] = [];
  const reply = Promise.withResolvers<void>();
  const f = await durableFixture(async request => {
    requests.push(request);
    if (requests.length === 1) return workReply(request, { kind: "abstain" });
    await reply.promise;
    return workReply(request, { kind: "work", policy: timberPolicy });
  }, "Find and collect one oak log without breaking leaves.", 2);
  try {
    await f.observe(16, { stance: 2 });
    await f.actor.poll();
    await f.observe(21, { stance: 2, travelHint: visibleWoodland });
    expect(requests[1]?.observation).toMatchObject({ inventory: {}, opportunities: [], travelHint: visibleWoodland });
    reply.resolve();
    await f.actor.poll();
    expect(await f.order()).toMatchObject({ ...timberPolicy, basisTick: 21,
      travelAnchor: { subject: visibleWoodland.subject, target: visibleWoodland.target } });
    expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 0, completedReceipts: 0 });
    await expect(access(f.file("intent.json"))).rejects.toThrow();
  } finally {
    reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["frontier", "ore", "after inspection", "lost reserve"] as const)(
  "A live diamond prospect uses a relevant ordinary braking window (%s)", async condition => {
    const frontier = condition === "frontier" || condition === "lost reserve";
    const travelHint = {
      ...visibleTimber,
      ...(frontier
        ? { kind: "cave_frontier", subject: "block:minecraft:deepslate", target: "frontier-a" } as const
        : { subject: "block:minecraft:diamond_ore", target: "ore-a" } as const),
      footing: "shallow_water_with_bank" as const,
    };
    const view = {
      id: "inspect-ore", verb: "inspect", risk: "read", summary: "Center the visible ore",
      evidence: "The rendered diamond ore is near the edge of the frame.",
      anchor: { subject: travelHint.subject, target: travelHint.target },
    } as const;
    const reply = Promise.withResolvers<void>();
    const f = await durableFixture(async request => {
      await reply.promise;
      return workReply(request, { kind: "work", policy: cavePolicy,
        ...(condition === "after inspection" ? { openingViewId: view.id } : {}) });
    }, "Find one diamond and keep the iron pickaxe.", 1);
    try {
      await f.observe(16, { ...caveState, ...(condition === "after inspection" ? { opportunities: [view] } : { travelHint }) });
      reply.resolve();
      if (condition === "lost reserve") await f.observe(21, { ...caveState, inventory: {}, travelHint });
      else await f.actor.poll();
      if (condition === "after inspection") {
        const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
        await f.receipt(intent.id, 21, "accepted");
        await f.receipt(intent.id, 26, "completed");
        await f.observe(31, { ...caveState, travelHint });
      }
      if (condition === "lost reserve") await expect(access(f.file("work.json"))).rejects.toThrow();
      else expect(await f.order()).toMatchObject({ origin: "model", ...cavePolicy,
        allowedEffects: ["break:minecraft:diamond_ore", MACRO_DIAMOND_PROSPECT],
        basisTick: condition === "after inspection" ? 31 : 16,
        travelAnchor: { subject: travelHint.subject, target: travelHint.target } });
      await expect(access(f.file("intent.json"))).rejects.toThrow();
    } finally {
      reply.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test("An iron leg can begin at an exact visible cave frontier without granting a cover break", async () => {
  const reply = Promise.withResolvers<void>();
  const travelHint = { ...visibleTimber, kind: "cave_frontier", footing: "shallow_water_with_bank",
    subject: "block:minecraft:stone", target: "frontier-a" } as const;
  const policy = { ...timberPolicy, target: { kind: "stock", item: "minecraft:raw_iron", count: 1 },
    allowedEffects: ["break:minecraft:iron_ore"], reserves: [{ item: "minecraft:stone_pickaxe", count: 1 }] } as const;
  const f = await durableFixture(async request => {
    await reply.promise;
    expect(request.observation.travelHint).toEqual(travelHint);
    return workReply(request, { kind: "work", policy });
  }, "Find raw iron and keep the stone pickaxe.", 1);
  try {
    await f.observe(16, { stance: 4, inventory: { "minecraft:stone_pickaxe": 1 }, travelHint });
    reply.resolve();
    await f.actor.poll();
    expect(await f.order()).toMatchObject({ ...policy, basisTick: 16,
      travelAnchor: { subject: travelHint.subject, target: travelHint.target } });
    await expect(access(f.file("intent.json"))).rejects.toThrow();
  } finally {
    reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["wall", "priced loss", "unknown", "wrong rock", "not allowed", "ore only", "short quota", "lost tool", "lost floor",
  "unpriced loss", "loss crosses floor", "different ore anchor", "changed stance"] as const)(
  "Only a matching fresh wall can open a quoted excavation (%s)", async condition => {
    const requests: MacroRequest[] = [];
    const reply = Promise.withResolvers<void>();
    const view = condition === "different ore anchor" ? { ...caveSurvey, verb: "inspect",
      anchor: { subject: "block:minecraft:diamond_ore", target: wall.target } } as const : caveSurvey;
    const policy = condition === "not allowed" ? cavePolicy :
      condition === "ore only" ? { ...wallPolicy, allowedEffects: ["break:minecraft:diamond_ore", "break:minecraft:stone"] } :
      condition === "short quota" ? { ...wallPolicy, maxBreaks: 1 } :
      condition === "loss crosses floor" || condition === "priced loss" ?
        { ...wallPolicy, costCaps: [{ item: wall.tool, count: 1 }] } : wallPolicy;
    const f = await durableFixture(async request => {
      requests.push(request);
      await reply.promise;
      return workReply(request, { kind: "work", policy, openingViewId: view.id });
    }, "Prospect for diamond on dry footing.", 1);
    try {
      await f.observe(16, { ...wallState, opportunities: [view] });
      expect(requests[0]?.observation.prospectOpening).toBeUndefined();
      expect(requests[0]?.work?.openingViewIds).toEqual([view.id]);
      reply.resolve();
      await f.actor.poll();
      const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
      await f.receipt(intent.id, 21, "accepted");
      await f.receipt(intent.id, 26, "completed");
      await f.observe(26, { ...wallState, prospectOpening: wall });
      await expect(access(f.file("work.json"))).rejects.toThrow();
      await f.observe(31, { ...wallState, opportunities: [],
        recent: ["The surrounding stone may contain diamond ore."],
        prospectOpening: condition === "unknown" ? undefined : condition === "wrong rock" ?
          { ...wall, block: "minecraft:granite" } :
          condition === "unpriced loss" || condition === "loss crosses floor" || condition === "priced loss" ?
            { ...wall, maxToolLoss: 1 } : wall,
        ...(condition === "lost tool" ? { inventory: { "minecraft:raw_iron": 2 } } :
          condition === "lost floor" ? { inventory: caveState.inventory } :
          condition === "priced loss" ? { inventory: { ...wallState.inventory, [wall.tool]: 2 } } :
          condition === "changed stance" ? { stance: 3 } : {}),
      });
      if (condition === "wall" || condition === "priced loss") expect(await f.order()).toMatchObject({ basisTick: 31, origin: "model",
        target: policy.target, maxBreaks: policy.maxBreaks });
      else await expect(access(f.file("work.json"))).rejects.toThrow();
      expect(requests).toHaveLength(1);
      expect(f.actor.status()).toMatchObject({ completedReceipts: 0, completedModelWorkOrders: 0 });
    } finally {
      reply.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each(["live", "disappeared", "different cell"] as const)(
  "An already witnessed excavation starts as ordinary work without camera input (%s)", async condition => {
    const reply = Promise.withResolvers<void>();
    const f = await durableFixture(async request => {
      expect(request.observation.prospectOpening).toEqual(wall);
      expect(request.observation.opportunities).not.toContainEqual(expect.objectContaining({ id: wall.target }));
      await reply.promise;
      return workReply(request, { kind: "work", policy: wallPolicy });
    }, "Prospect for diamond on dry footing.", 1);
    try {
      await f.observe(16, { ...wallState, opportunities: [caveSurvey], prospectOpening: wall });
      reply.resolve();
      await f.observe(21, { ...wallState, opportunities: [caveSurvey],
        prospectOpening: condition === "disappeared" ? undefined : condition === "different cell" ? { ...wall, target: "wall-b" } : wall });
      if (condition === "live") expect(await f.order()).toMatchObject({ basisTick: 21, origin: "model" });
      else await expect(access(f.file("work.json"))).rejects.toThrow();
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      expect(f.actor.status()).toMatchObject({ requests: 1, completedReceipts: 0 });
    } finally {
      reply.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each(["fresh route", "camera only", "failed", "no acceptance", "lost view", "hurt", "displaced", "expired",
  "stop", "paid transition", "reserve lost", "invented", "physical ID", "already justified", "unrelated face",
  "new ore face", "wrong post-view face", "paired lower lane", "wrong lower lane"] as const)(
  "An opening view can start its priced work without a second request (%s)", async condition => {
    const requests: MacroRequest[] = [];
    const reply = Promise.withResolvers<void>();
    const face = { id: "face", verb: "inspect", risk: "read", summary: "Center diamond ore", evidence: "Lit visible face",
      anchor: { subject: "block:minecraft:diamond_ore", target: "ore-a" } } as const;
    const ore = { id: "break-ore", verb: "break", risk: "guarded", summary: "Break visible diamond ore", evidence: "In reach",
      material: { subject: "block:minecraft:diamond_ore", target: "ore-a", spends: {} } } as const;
    const lower = { id: "lower-look", verb: "survey", risk: "guarded", summary: "Inspect the lower lane", evidence: "A lit lower face",
      anchor: { subject: "route:dry", target: "lower-a" } } as const;
    const lowerCase = condition === "paired lower lane" || condition === "wrong lower lane";
    const followed = { id: "lower-route", verb: "follow", risk: "guarded", summary: "Follow the dry lower lane",
      evidence: "One edge with a witnessed return", anchor: { ...lower.anchor,
        target: condition === "paired lower lane" ? "lower-a" : "lower-b" } } as const;
    const view = condition === "unrelated face" ? { ...face, anchor: { ...face.anchor, subject: "block:minecraft:copper_ore" } } :
      condition === "new ore face" || condition === "wrong post-view face" ? face : lowerCase ? lower : caveSurvey;
    const initial = condition === "physical ID" || condition === "already justified" ? [view, caveFooting] : [view];
    const f = await durableFixture(async request => {
      requests.push(request);
      await reply.promise;
      return workReply(request, { kind: "work", policy: cavePolicy,
        openingViewId: condition === "invented" ? "invented" : condition === "physical ID" ? caveFooting.id : view.id }, 1100);
    }, lowerCase ? "Prospect for diamond while preserving the iron pickaxe." : undefined, 1);
    try {
      if (!lowerCase) {
        await f.observe(10, caveState);
        const preset = await f.order();
        await f.receipt(preset.id, 12, "accepted");
        await f.receipt(preset.id, 13, "interrupted");
      }
      await f.observe(16, { ...caveState, opportunities: initial });
      expect(requests[0]?.work?.openingViewIds).toEqual([view.id]);
      reply.resolve();
      if (condition === "lost view") await f.observe(20, { ...caveState, opportunities: [{ ...view, id: "reissued" }] });
      else await f.actor.poll();
      if (["invented", "physical ID", "lost view", "already justified", "unrelated face"].includes(condition)) {
        await expect(access(f.file("intent.json"))).rejects.toThrow();
        await expect(access(f.file("work.json"))).rejects.toThrow();
        return;
      }
      const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
      expect(intent).toMatchObject({ basisTick: 16, opportunityId: view.id, skillHash: null });
      if (condition !== "no acceptance") await f.receipt(intent.id, 21, "accepted");
      await f.receipt(intent.id, 26, condition === "failed" ? "interrupted" : "completed");
      await f.observe(26, { ...caveState, opportunities: [caveFooting] });
      await expect(access(f.file("work.json"))).rejects.toThrow(); // Receipt tick is not a later view.
      expect(f.actor.status()).toMatchObject({ completedReceipts: 0, completedModelWorkOrders: 0 });
      const opportunities = condition === "camera only" ? [{ ...view, id: "right", summary: "Survey right" }] :
        condition === "new ore face" ? [ore] : condition === "wrong post-view face" ?
          [{ ...ore, material: { ...ore.material, target: "other-ore" } }] : lowerCase ? [followed] : [caveFooting];
      if (condition === "stop") await f.actor.stop();
      await f.observe(condition === "expired" ? 1116 : 31, { ...caveState, opportunities,
        ...(condition === "hurt" ? { health: 19 } : condition === "displaced" ? { stance: 3 } :
          condition === "reserve lost" ? { inventory: {} } : condition === "paid transition" ? {
            pendingWork: { ...paidIron("owed-iron", 20), yieldable: false, parked: true, historical: true },
          } : {}) });
      if (condition === "fresh route" || condition === "new ore face" || condition === "paired lower lane") {
        const { allowedEffects, ...quoted } = cavePolicy;
        const order = await f.order();
        expect(order).toMatchObject({ basisTick: 31, expiresTick: 1116, origin: "model", ...quoted });
        expect(new Set(order.allowedEffects)).toEqual(new Set(allowedEffects));
      } else await expect(access(f.file("work.json"))).rejects.toThrow();
      expect(requests).toHaveLength(1);
    } finally {
      reply.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each(["exact ore", "distinct approach", "reissued look", "different ore", "changed epoch", "expired recovery"] as const)(
  "A lost ore opening can make one fresh decision on a real alternative (%s)", async condition => {
    const requests: MacroRequest[] = [];
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const anchor = { subject: "block:minecraft:iron_ore", target: "ore-a" };
    const inspect = { id: "ore-view", verb: "inspect", risk: "read", summary: "Center the visible iron ore",
      evidence: "A lit iron face is visible away from the crosshair.", anchor } as const;
    const ore = { id: "ore-break", verb: "break", risk: "guarded", summary: "Break visible iron ore",
      evidence: "The lit face is now in harvest reach.", material: { ...anchor, spends: {} } } as const;
    const policy = { ...cavePolicy, target: { kind: "stock", item: "minecraft:raw_iron", count: 1 },
      allowedEffects: ["break:minecraft:iron_ore"], maxBreaks: 1 } as const;
    const f = await durableFixture(async request => {
      requests.push(request);
      if (requests.length === 1) {
        await first.promise;
        return workReply(request, { kind: "work", policy, openingViewId: inspect.id });
      }
      await second.promise;
      return workReply(request, condition === "distinct approach" ? { kind: "opportunity", opportunityId: caveFooting.id } :
        { kind: "work", policy });
    }, "Find diamond; preserve the iron pickaxe.", 5);
    try {
      await f.observe(1015, { ...caveState, opportunities: [inspect] });
      first.resolve();
      await f.observe(1105, { ...caveState, opportunities: [caveSurvey] });
      expect(f.actor.status()).toMatchObject({ staleDecisions: 1, issued: 0, issuedWorkOrders: 0 });
      const recoveryTick = condition === "expired recovery" ? 1205 : 1110;
      const candidate = condition === "reissued look" ? { ...inspect, id: "rekeyed" } :
        condition === "different ore" ? { ...ore, material: { ...ore.material, target: "ore-b" } } :
        condition === "distinct approach" ? caveFooting : ore;
      const scope = condition === "changed epoch" ? { ...caveState, epoch: 2 } : caveState;
      await f.observe(recoveryTick, { ...scope, opportunities: [candidate] });
      const recovers = condition === "exact ore" || condition === "distinct approach";
      expect(requests).toHaveLength(recovers ? 2 : 1);
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      await expect(access(f.file("work.json"))).rejects.toThrow();
      if (recovers) {
        expect(requests[1]).toMatchObject({ observation: { tick: recoveryTick, opportunities: [candidate] },
          lastReceipt: null, feedback: { kind: "failed_intent", detail: expect.stringContaining("No camera read or work started") } });
        second.resolve();
        if (condition === "exact ore") {
          await f.actor.poll();
          expect(await f.order()).toMatchObject({ basisTick: recoveryTick, origin: "model", ...policy });
          return;
        }
        // Lose the recovery action before it reaches the mailbox as well.
        await f.observe(1195, scope);
        expect(f.actor.status()).toMatchObject({ staleDecisions: 2, issued: 0, issuedWorkOrders: 0 });
      }
      await f.observe(recoveryTick + 100, { ...scope, opportunities: [ore, caveFooting] });
      expect(requests).toHaveLength(recovers ? 2 : 1);
    } finally {
      first.resolve();
      second.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test("A spent unanchored survey stays unavailable after waiting and rekeying, but a new exact face is usable", async () => {
  const requests: MacroRequest[] = [];
  const opposite = { ...caveSurvey, id: "right-new-id", summary: "Survey right from this stance" };
  const clue = { id: "coal", verb: "inspect", risk: "read", summary: "Center a visible coal face", evidence: "Lit material",
    anchor: { subject: "block:minecraft:coal_ore", target: "coal-face" } } as const;
  const f = await durableFixture(async request => {
    requests.push(request);
    return workReply(request, { kind: "opportunity",
      opportunityId: requests.length === 1 ? caveSurvey.id : requests.length === 2 ? opposite.id : clue.id });
  }, undefined, 5);
  try {
    await f.observe(10, caveState);
    const preset = await f.order();
    await f.receipt(preset.id, 12, "accepted");
    await f.receipt(preset.id, 13, "interrupted");
    await f.observe(16, { ...caveState, opportunities: [caveSurvey] });
    await f.actor.poll();
    const first = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
    await f.receipt(first.id, 20, "accepted");
    await f.receipt(first.id, 24, "completed");
    await f.observe(200, { ...caveState, epoch: 2, opportunities: [opposite] });
    await f.actor.poll();
    expect(requests[1]?.observation.opportunities).toEqual([]);
    expect(f.actor.status().issued).toBe(1);
    await expect(access(f.file("intent.json"))).rejects.toThrow();
    await f.observe(300, { ...caveState, epoch: 2, opportunities: [{ ...opposite, id: "another-id" }] });
    expect(requests).toHaveLength(2);
    await f.observe(305, { ...caveState, epoch: 2, opportunities: [opposite, clue] });
    await f.actor.poll();
    expect(requests[2]?.observation.opportunities).toEqual([clue]);
    expect(parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8"))).opportunityId).toBe(clue.id);
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

// Canopy trace: the last survey completed at 1092; the tick-1096 request
// chose o-17 and was refused before issuance in the same life/epoch. The
// refusal did not record its full live view; replay with a witnessed approach.
test.each(["alternate", "alternate lost", "rekeyed inspect", "only survey", "abstain", "expired", "death", "unsafe"] as const)(
  "A lost canopy inspect only reopens the decision for a live alternative (%s)",
  async condition => {
    const inspect = { id: "o-17", verb: "inspect", risk: "read", summary: "Center the visible minecraft:dark_oak_log",
      evidence: "A lit face is visible away from the current crosshair." } as const;
    const left = { id: "o-15", verb: "approach", risk: "low", summary: "Walk to the adjacent flat tile",
      evidence: "Lit full top and clear dry sweep, left of center from the current view." } as const;
    const right = { ...left, id: "o-14", evidence: "Lit full top and clear dry sweep, right of center from the current view." };
    const survey = { id: "o-12", verb: "survey", risk: "read", summary: "Survey left from this stance",
      evidence: "A bounded first-person turn over nearby terrain." } as const;
    const opening = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const requests: MacroRequest[] = [];
    const f = await durableFixture(async request => {
      requests.push(request);
      if (request.observation.tick === 986) {
        await opening.promise;
        return workReply(request, { kind: "opportunity", opportunityId: survey.id }, 300);
      }
      if (request.observation.tick === 1096) {
        await first.promise;
        return workReply(request, condition === "abstain" ? { kind: "abstain" } :
          { kind: "opportunity", opportunityId: inspect.id }, 300);
      }
      await second.promise;
      return workReply(request, { kind: "opportunity", opportunityId: left.id }, 300);
    }, undefined, 8);
    try {
      await f.observe(11);
      const job = await f.order();
      await f.receipt(job.id, 15, "accepted");
      await f.receipt(job.id, 15, "interrupted");
      const state = { epoch: 3, safety: { clear: true, revision: 2 },
        workOrder: { id: job.id, state: "blocked", detail: "No live source" } } as const;
      await f.observe(986, { ...state, opportunities: [survey] });
      opening.resolve();
      await f.observe(1076, { ...state, opportunities: [survey] });
      const surveyed = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
      await f.receipt(surveyed.id, 1081, "accepted");
      await f.receipt(surveyed.id, 1092, "completed");
      await f.observe(1096, { ...state, opportunities: [left, right, inspect] });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.lastReceipt).toMatchObject({ id: surveyed.id, tick: 1092, status: "completed" });
      first.resolve();
      const refusalTick = condition === "expired" ? 1396 : 1186;
      const recovery = condition === "alternate" || condition === "alternate lost";
      const remaining = condition === "rekeyed inspect" ? [left, right, { ...inspect, id: "o-20" }] :
        condition === "only survey" ? [survey] : [left, right];
      const fault = condition === "death" ? { health: 0, epoch: 4, safety: { clear: false, revision: 3 } } :
        condition === "unsafe" ? { epoch: 4, safety: { clear: false, revision: 3 } } : {};
      await f.observe(refusalTick, { ...state, ...fault, opportunities: remaining });
      await f.actor.poll();
      expect(requests).toHaveLength(recovery ? 3 : 2);
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      if (recovery) {
        expect(await readFile(f.file("history.jsonl"), "utf8")).toContain('"reason":"opportunity_no_longer_witnessed"');
        expect(requests[2]).toMatchObject({ observation: { tick: refusalTick, opportunities: [left, right] },
          feedback: { kind: "failed_intent" }, work: { current: null } });
        expect(f.actor.status()).toMatchObject({ issued: 1, staleDecisions: 1 });
        second.resolve();
        if (condition === "alternate") {
          await f.actor.poll();
          expect(parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")))).toMatchObject({
            basisTick: refusalTick, opportunityId: left.id, skillHash: null,
          });
          return;
        }
        await f.observe(refusalTick + 5, { ...state, opportunities: [right] });
        expect(f.actor.status()).toMatchObject({ issued: 1, staleDecisions: 2 });
      }
      for (const offset of [90, 170]) {
        await f.observe(refusalTick + offset, { ...state, ...fault });
        await f.observe(refusalTick + offset + 5, { ...state, ...fault,
          opportunities: remaining.map(offer => ({ ...offer, id: `${offer.id}-${offset}` })),
        });
      }
      expect(requests).toHaveLength(recovery ? 3 : 2);
      await expect(access(f.file("intent.json"))).rejects.toThrow();
    } finally {
      opening.resolve();
      first.resolve();
      second.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each([
  "same survey", "duplicate loss", "different angle", "never returned", "expired", "new life", "changed epoch",
  "changed safety", "changed health", "changed stock", "abstained", "unprimed gap", "stale gap",
] as const)("A lost stationary survey is reconsidered at most once (%s)", async condition => {
  const firstReply = Promise.withResolvers<void>();
  const gapReply = Promise.withResolvers<void>();
  const freshReply = Promise.withResolvers<void>();
  const requests: MacroRequest[] = [];
  const survey = { id: "o-1", verb: "survey", risk: "read", summary: "Survey the nearby ground",
    evidence: "A fixed downward camera angle from the current stance." } as const;
  const returned = { ...survey, id: "o-4" };
  const reconsider = condition === "same survey" || condition === "duplicate loss";
  const gap = { kind: "gap", capability: "The current view offers no usable action." } as const;
  const f = await durableFixture(async request => {
    requests.push(request);
    if (requests.length === 1 && condition !== "unprimed gap") {
      await firstReply.promise;
      return workReply(request, { kind: "opportunity", opportunityId: survey.id }, 600);
    }
    if (requests.length === 2 && condition === "abstained") return workReply(request, { kind: "abstain" });
    if (requests.length === 2 && condition === "stale gap") {
      await gapReply.promise;
      return workReply(request, gap, 5);
    }
    if (requests.length === 3 && reconsider) {
      await freshReply.promise;
      return workReply(request, { kind: "opportunity", opportunityId: returned.id });
    }
    return workReply(request, gap);
  }, undefined, 8);
  try {
    await f.observe(11);
    const job = await f.order();
    await f.receipt(job.id, 15, "accepted");
    await f.receipt(job.id, 15, "interrupted");
    const workOrder = { id: job.id, state: "blocked", detail: "No live source" } as const;
    await f.observe(16, { workOrder, opportunities: [survey] });
    expect(requests).toHaveLength(1);
    firstReply.resolve();
    await f.observe(106, { workOrder });
    if (condition === "stale gap") {
      gapReply.resolve();
      await f.observe(111, { workOrder });
    }
    await f.actor.poll();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ observation: { tick: 106, opportunities: [] }, work: { demand: "blocked", current: null } });
    expect(f.actor.status()).toMatchObject({
      issued: 0, staleDecisions: condition === "unprimed gap" ? 0 : condition === "stale gap" ? 2 : 1,
      lastDisposition: condition === "abstained" ? "abstained" : condition === "stale gap" ? "stale" : "native_capability_gap",
    });
    if (condition !== "unprimed gap") {
      expect(await readFile(f.file("history.jsonl"), "utf8")).toContain('"reason":"opportunity_no_longer_witnessed"');
    }
    await expect(access(f.file("intent.json"))).rejects.toThrow();

    const scopeChange: Partial<MacroObservation> = condition === "new life" ? { life: 2, epoch: 2 } :
      condition === "changed epoch" ? { epoch: 2 } :
      condition === "changed safety" ? { safety: { clear: true, revision: 2 }, epoch: 2 } :
      condition === "changed health" ? { health: 19 } :
      condition === "changed stock" ? { inventory: { "minecraft:stick": 1 } } : {};
    const normalReplan = condition === "new life" || condition === "changed safety" || condition === "changed stock";
    const alreadyAsked = normalReplan ? 3 : 2;
    await f.observe(185, { workOrder, ...scopeChange });
    await f.observe(186, { workOrder, ...scopeChange });
    await f.actor.poll();
    expect(requests).toHaveLength(alreadyAsked);
    if (normalReplan) expect(requests[2]?.observation.opportunities).toEqual([]);

    const returnTick = condition === "expired" ? 620 : 266;
    const liveOffer = condition === "different angle" ? { ...returned, summary: "Survey left from this stance" } : returned;
    const visible = condition === "never returned" ? [] : [liveOffer];
    // A transient health change must invalidate rather than on/off switch the allowance.
    const state = { workOrder, ...(condition !== "changed health" ? scopeChange : {}) };
    await f.observe(returnTick, { ...state, opportunities: visible });
    expect(requests).toHaveLength(reconsider ? 3 : alreadyAsked);
    await expect(access(f.file("intent.json"))).rejects.toThrow();
    if (reconsider) {
      expect(requests[2]).toMatchObject({ observation: { tick: returnTick, opportunities: [returned] },
        work: { demand: "blocked", current: null }, feedback: { kind: "native_capability_gap" } });
      if (condition === "duplicate loss") {
        freshReply.resolve();
        await f.observe(returnTick + 5, state);
        expect(f.actor.status()).toMatchObject({ staleDecisions: 2, issued: 0 });
      } else {
        freshReply.resolve();
        await f.actor.poll();
        const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
        expect(intent).toMatchObject({ basisTick: returnTick, opportunityId: returned.id, skillHash: null });
        await f.receipt(intent.id, returnTick + 1, "accepted");
        await f.receipt(intent.id, returnTick + 2, "completed");
        await f.observe(returnTick + 80, state);
        await f.actor.poll();
        expect(requests).toHaveLength(4); // A native receipt, not camera churn, warrants this ordinary gap.
        expect(requests[3]).toMatchObject({ lastReceipt: { id: intent.id, status: "completed" } });
      }
    }
    const count = requests.length;
    for (const tick of [returnTick + 160, returnTick + 240]) {
      await f.observe(tick, state);
      await f.observe(tick + 5, { ...state, opportunities: visible.map(offer => ({ ...offer, id: `o-${tick}` })) });
      expect(requests).toHaveLength(count);
    }
    await expect(access(f.file("intent.json"))).rejects.toThrow();
  } finally {
    firstReply.resolve();
    gapReply.resolve();
    freshReply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test.each([
  { opportunities: [] },
  { safety: { clear: false, revision: 2 } },
  { life: 2, epoch: 2, health: 0 },
] satisfies Partial<MacroObservation>[])("A closed table decision (%j) cannot reuse invalid-reply feedback", async closed => {
  const requests: MacroRequest[] = [];
  const f = await durableFixture(async request => {
    requests.push(request);
    return invalidBucketReply(request);
  }, "Prepare a bucket.", 8);
  try {
    await f.observe(10, bucketStock);
    await f.actor.poll();
    await f.observe(90, { ...bucketStock, ...closed });
    await f.observe(190, { ...bucketStock, ...closed });
    expect(requests).toHaveLength(1);
    await expect(access(f.file("intent.json"))).rejects.toThrow();
    await expect(access(f.file("work.json"))).rejects.toThrow();
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["stop", "request budget"] as const)("Invalid reply correction cannot bypass %s", async fence => {
  const f = await durableFixture(async request => invalidBucketReply(request), "Prepare a bucket.", fence === "stop" ? 4 : 1);
  try {
    await f.observe(10, bucketStock);
    await f.actor.poll();
    if (fence === "stop") await f.actor.stop();
    else await f.observe(100, bucketStock);
    expect(f.actor.status()).toMatchObject({ requests: 1, providerDispatches: 1, issued: 0, issuedWorkOrders: 0 });
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("An invalid policy reply does not use a correction to replace accepted native work", async () => {
  const f = await durableFixture(async request => invalidBucketReply(request), undefined, 4);
  try {
    await f.observe(10);
    const incumbent = await f.order();
    await f.receipt(incumbent.id, 11, "accepted");
    const working = { id: incumbent.id, state: "working", detail: "A native lease is still underway." } as const;
    await f.observe(12, { ...bucketStock, workOrder: working });
    await f.observe(100, { ...bucketStock, workOrder: working });
    await f.observe(200, { ...bucketStock, workOrder: working });
    expect(f.actor.status()).toMatchObject({ requests: 1, providerDispatches: 1, issued: 0, issuedWorkOrders: 1 });
    expect(await f.order()).toEqual(incumbent);
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("Rotated observation IPC defers both settlement and an uncharged correction preflight", async () => {
  const requests: MacroRequest[] = [];
  let rotateDispatch = true;
  const f = await durableFixture(async request => {
    requests.push(request);
    if (requests.length === 1) return invalidBucketReply(request);
    if (rotateDispatch) {
      rotateDispatch = false;
      return { ...invalidBucketReply(request), dispatched: false, outcome: "stale", invalidReply: undefined, observationRotating: true };
    }
    return workReply(request, { kind: "abstain" });
  }, "Prepare a bucket.", 2);
  const read = MacroDirectory.prototype.read;
  let rotatePoll = false;
  const mocked = spyOn(MacroDirectory.prototype, "read").mockImplementation(function (this: MacroDirectory, name, parse) {
    if (name === "observation.json" && rotatePoll) {
      rotatePoll = false;
      return Promise.reject(new MacroObservationRotating());
    }
    return read.call(this, name, parse);
  } as typeof read);
  try {
    await f.observe(10, bucketStock);
    rotatePoll = true;
    await f.observe(100, bucketStock);
    expect(requests).toHaveLength(1);
    await f.actor.poll();
    expect(requests).toHaveLength(2);
    await f.observe(101, bucketStock);
    await f.observe(102, bucketStock);
    expect(requests.map(request => request.observation.tick)).toEqual([10, 100, 101]);
    expect(f.actor.status()).toMatchObject({ requests: 2, providerDispatches: 2, unreportedDispatches: 0 });
  } finally {
    mocked.mockRestore();
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["corrected", "unchanged", "abstained"] as const)(
  "The ordinary Terra oak approach gets one candid reserve correction (%s)",
  async response => {
    const log = "minecraft:oak_log";
    const objective = "Gather enough wood to carry six logs for travel and continue toward a diamond.";
    // Ordinary run: empty first view, then the dry tick-97 oak approach with two logs held.
    const first = { goal: "diamond", epoch: 3, inventory: { [log]: 2, "minecraft:crafting_table": 1 },
      safety: { clear: true, revision: 2 } } as const;
    const anchor = { subject: `block:${log}`, target: "m-1" };
    const visible: Partial<MacroObservation> = {
      ...first, stance: 1,
      travelHint: { ...anchor, kind: "resource", bearingDegrees: 2.4176788, footing: "dry", windowBlocks: 1.6 },
      recent: ["dry route: Witnessed 4 paired dry edges in one forward strip."],
      opportunities: [
        { id: "o-1", verb: "follow", summary: "Follow a witnessed dry cave segment", risk: "guarded",
          evidence: "4 witnessed level edges with a distinct endpoint and a witnessed return. Recheck each edge before moving.",
          anchor: { subject: "route:dry", target: "m-2" } },
        { id: "o-2", verb: "continue", summary: "Craft planks in the inventory grid", risk: "guarded",
          evidence: "The visible inventory holds the ingredients for this vanilla recipe.",
          material: { subject: "recipe:planks", target: "recipe-planks", spends: { [log]: 1 } } },
        { id: "o-3", verb: "survey", summary: "Survey left from this stance", risk: "read",
          evidence: "A bounded first-person turn over nearby terrain." },
        { id: "o-4", verb: "survey", summary: "Survey right from this stance", risk: "read",
          evidence: "A bounded first-person turn over nearby terrain." },
        { id: "o-5", verb: "inspect", summary: `Center the visible ${log}`, risk: "read",
          evidence: "A lit face is visible away from the current crosshair.", anchor },
      ],
    };
    const refused = {
      target: { kind: "stock", item: log, count: 8 }, allowedEffects: [`break:${log}`], costCaps: [],
      reserves: [{ item: log, count: 6 }], maxBreaks: 6, maxCrafts: 0, maxPlacements: 0,
    } as const;
    const corrected = { ...refused, reserves: [{ item: log, count: 2 }] };
    const requests: MacroRequest[] = [];
    const f = await durableFixture(async request => {
      requests.push(request);
      if (requests.length === 1) return workReply(request, { kind: "abstain" }, 200);
      if (requests.length === 2) return workReply(request, { kind: "work", policy: refused }, 1200);
      return workReply(request, response === "abstained" ? { kind: "abstain" } :
        { kind: "work", policy: response === "corrected" ? corrected : refused }, 1200);
    }, objective, 32);
    try {
      await f.observe(1, first);
      await f.actor.poll();
      await f.observe(97, visible);
      await f.actor.poll();

      expect(requests.map(request => request.observation.tick)).toEqual([1, 97]);
      expect(requests[1]).toMatchObject({ objective, work: { mode: "constrained", demand: "changed",
        protectedReserves: [], current: null, lastOutcome: null, openingViewIds: ["o-3", "o-4", "o-5"] } });
      expect(f.actor.status()).toMatchObject({ lastProviderOutcome: "completed", lastDisposition: "proposal_refused",
        issued: 0, issuedWorkOrders: 0, unresolvedWorkOrders: 0 });
      await expect(access(f.file("work.json"))).rejects.toThrow();

      await f.observe(177, visible);
      await f.actor.poll();
      expect(requests[2]).toMatchObject({ observation: { tick: 177, inventory: first.inventory, travelHint: visible.travelHint },
        lastReceipt: null, work: { mode: "constrained", protectedReserves: [], current: null, lastOutcome: null },
        feedback: { kind: "invalid_reply", detail: expect.stringContaining("6 minecraft:oak_log reserved at entry, but only 2 are carried") } });
      const history = (await readFile(f.file("history.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const proposals = (await readFile(f.file("proposals.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const original = proposals[1];
      expect(original).toMatchObject({ basis: { tick: 97 }, providerOutcome: "completed", disposition: "proposed",
        proposal: { expiresTick: 1297, action: { kind: "work", policy: refused } } });
      expect(proposals[2].correctionOf).toBe(original.requestId);
      expect(history).toContainEqual(expect.objectContaining({ event: "proposal_refused", requestId: original.requestId,
        basis: expect.objectContaining({ tick: 97 }),
        reason: expect.stringContaining("6 minecraft:oak_log reserved at entry, but only 2 are carried") }));
      expect(history.some(event => event.event === "work_order_prepared" && event.requestId === original.requestId)).toBe(false);

      if (response === "corrected") {
        expect(await f.order()).toMatchObject({ origin: "model", basisTick: 177, travelAnchor: anchor, ...corrected });
      } else {
        await f.observe(265, visible);
        await f.observe(355, { ...visible, opportunities: visible.opportunities!.map((offer, index) =>
          ({ ...offer, id: `rekeyed-${index}` })) });
        await f.actor.poll();
        await expect(access(f.file("work.json"))).rejects.toThrow();
      }
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      expect(requests).toHaveLength(3);
      expect(await readFile(f.file("receipts.jsonl"), "utf8")).toBe("");
      expect(hasConfirmedTerraEffect(f.actor.status())).toBe(false);
      expect(f.actor.status()).toMatchObject({ requests: 3, providerDispatches: 3, unreportedDispatches: 0, issued: 0,
        issuedWorkOrders: response === "corrected" ? 1 : 0, completedModelWorkOrders: 0,
        lastDisposition: response === "corrected" ? "work_order_issued" : response === "unchanged" ? "proposal_refused" : "abstained" });
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

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
      : demand.renewal ? { kind: "renew-work", workOrderId: demand.renewal.workOrderId }
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
    await f.receipt(first.id, 1121, "interrupted", "Replaced by a compatible work order.");
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

test.each(["renew", "repeated policy", "repeated successor", "late reply", "wrong ID", "unchanged expiry",
  "native refusal", "late receipt", "incompatible receipt"] as const)(
  "The zWuI7n prospect keeps its existing grant across a renewal decision: %s", async choice => {
    const policy = {
      target: { kind: "stock", item: "minecraft:diamond", count: 1 },
      allowedEffects: ["prospect:minecraft:diamond", "break:minecraft:deepslate_diamond_ore",
        "break:minecraft:deepslate", "place:minecraft:torch", "place:minecraft:cobblestone"],
      costCaps: [{ item: "minecraft:torch", count: 3 }, { item: "minecraft:cobblestone", count: 2 }],
      reserves: [{ item: "minecraft:iron_pickaxe", count: 1 }],
      maxBreaks: 40, maxCrafts: 0, maxPlacements: 4,
    } as const;
    const requests: MacroRequest[] = [];
    const reply = Promise.withResolvers<void>();
    const f = await durableFixture(async request => {
      requests.push(request);
      if (requests.length === 1) return workReply(request, { kind: "work", policy }, 1200);
      await reply.promise;
      const id = request.work!.current!.id;
      if (choice === "repeated policy") return workReply(request, { kind: "work", policy });
      if (choice === "repeated successor") return workReply(request, { kind: "work", afterWorkId: id,
        policy: { ...policy, maxBreaks: 41 } });
      return workReply(request, { kind: "renew-work", workOrderId: choice === "wrong ID" ? "unaccepted-order" : id },
        choice === "unchanged expiry" ? 740 : 1100);
    }, "Continue the returnable prospect while preserving the iron pickaxe.", 4);
    const world = { goal: "diamond", inventory: { "minecraft:iron_pickaxe": 1, "minecraft:torch": 2, "minecraft:cobblestone": 1 } };
    try {
      await f.observe(2187, world);
      await f.actor.poll();
      const original = await f.order();
      expect(original.expiresTick).toBe(3387);
      await f.receipt(original.id, 2188, "accepted");
      const progress = { phase: "route", status: "Following a returnable shelf",
        breaks: 12, crafts: 0, placements: 2, replan: "expiry_near" } as const;
      const workOrder = { id: original.id, state: "needs_replan", detail: "Prospect running", progress } as const;
      await f.observe(2647, { ...world, workOrder });
      expect(requests[1]?.work).toMatchObject({
        demand: "renew", renewal: { workOrderId: original.id },
        current: { accepted: { tick: 2188 }, expiresTick: 3387, nativeState: { progress } },
      });

      // 8.1 seconds at 20 ticks/s; movement may change the observation epoch.
      await f.observe(choice === "late reply" ? 3387 : 2809, { ...world, epoch: 2, workOrder });
      reply.resolve();
      await f.actor.poll();
      if (choice === "late reply") {
        await expect(access(f.file("work.json"))).rejects.toThrow();
        expect(f.actor.status().issuedWorkOrders).toBe(1);
      } else if (choice === "repeated policy" || choice === "repeated successor" || choice === "wrong ID" || choice === "unchanged expiry") {
        expect(await f.order()).toEqual(original);
        expect(f.actor.status().workQueuedAfter).toBeNull();
        if (choice === "repeated successor") {
          await f.observe(2810, { ...world, epoch: 2, workOrder });
          await f.actor.poll();
          expect(requests[2]?.work).toMatchObject({ demand: "renew", renewal: { workOrderId: original.id } });
          expect(requests[2]?.feedback?.detail).toContain("renew-work");
          await f.observe(2860, { ...world, epoch: 2, workOrder });
          expect(requests).toHaveLength(3);
          expect(f.actor.status().workQueuedAfter).toBeNull();
        }
      } else {
        const renewed = await f.order();
        expect(renewed).toEqual({ ...original, id: renewed.id, basisTick: 2809, epoch: 2, expiresTick: 3747 });
        expect(renewed.id).not.toBe(original.id);
        expect(f.actor.status().workOrder?.id).toBe(original.id); // Publication is not native acceptance.
        if (choice === "native refusal") {
          await f.receipt(renewed.id, 2810, "refused");
          await f.observe(2810, { ...world, epoch: 2, workOrder });
          expect(await f.order()).toEqual(original);
          return;
        }
        const acceptedAt = choice === "late receipt" ? 3387 : 2810;
        await f.receipt(original.id, acceptedAt, "interrupted", choice === "incompatible receipt"
          ? "The finite work horizon expired." : "Replaced by a compatible work order.");
        await f.receipt(renewed.id, acceptedAt, "accepted");
        await f.observe(3388, { ...world, epoch: 2, workOrder: { ...workOrder, id: renewed.id,
          state: "working", progress: { ...progress, replan: undefined } } });
        if (choice === "late receipt" || choice === "incompatible receipt") {
          await expect(access(f.file("work.json"))).rejects.toThrow();
          expect(f.actor.status().lastWorkOrder?.id).toBe(original.id);
          const receipts = await readFile(f.file("receipts.jsonl"), "utf8");
          expect(receipts).toContain('"invalidRenewal":true');
          return;
        }
        expect(f.actor.status().workOrder).toMatchObject({ id: renewed.id, accepted: { tick: 2810 } });
        expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 2, completedWorkOrders: 0, providerDispatches: 2 });
      }
    } finally {
      reply.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

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
    expect(gather.nextWorkId).toBe(craft.id);
    await f.receipt(craft.id, 101, "accepted");
    await f.observe(119, { epoch: 3, inventory: { [log]: 2, [planks]: 12 },
      workOrder: { id: craft.id, state: "working", detail: "Craft in progress" } });
    expect(await f.order()).toEqual(craft);
    await f.receipt(craft.id, 120, "completed");
    await f.actor.poll();
    await expect(access(f.file("work.json"))).rejects.toThrow();
    // The native personal inventory can still be open: this is not a neutral primitive handoff.
    await f.observe(120, { epoch: 3, inventory: { [log]: 2, [planks]: 12 },
      workOrder: { id: craft.id, state: "complete", detail: "Confirmed stock" } });
    const pick = await f.order();
    expect(pick).toMatchObject({ target: { kind: "preset", goal: "wooden_pickaxe" }, expiresTick: gather.expiresTick });
    expect(craft.nextWorkId).toBe(pick.id);
    expect(pick.nextWorkId).toBeUndefined();
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

test("Resource feedback reaches an ordinary successor request while the safe gather job continues", async () => {
  const log = "minecraft:oak_log", planks = "minecraft:oak_planks", stick = "minecraft:stick", table = "minecraft:crafting_table";
  const reserve = { item: log, count: 1 };
  const requests: MacroRequest[] = [];
  const f = await durableFixture(async request => {
    requests.push(request);
    if (requests.length > 1) return workReply(request, { kind: "abstain" });
    return workReply(request, { kind: "work-program", stages: [
      { policy: { target: { kind: "stock", item: log, count: 4 }, allowedEffects: [`break:${log}`], costCaps: [],
        reserves: [reserve], maxBreaks: 4, maxCrafts: 0, maxPlacements: 0 }, requires: [] },
      { policy: { target: { kind: "stock", item: planks, count: 12 }, allowedEffects: ["craft:oak_planks"],
        costCaps: [{ item: log, count: 3 }], reserves: [reserve], maxBreaks: 0, maxCrafts: 3, maxPlacements: 0 },
        requires: [{ item: log, count: 4 }] },
      { policy: { target: { kind: "preset", goal: "wooden_pickaxe" },
        allowedEffects: ["craft:stick", "craft:crafting_table", "craft:wooden_pickaxe", `place:${table}`],
        costCaps: [{ item: planks, count: 9 }, { item: stick, count: 2 }, { item: table, count: 1 }],
        reserves: [reserve, { item: planks, count: 4 }], maxBreaks: 0, maxCrafts: 3, maxPlacements: 1 },
        requires: [{ item: planks, count: 12 }] },
    ] });
  }, "Make the pickaxe while keeping one log and four oak planks.");
  try {
    await f.observe(10, { inventory: { [log]: 1 } });
    await f.actor.poll();
    const gather = await f.order();
    expect(gather.target).toEqual({ kind: "stock", item: log, count: 4 });
    await f.receipt(gather.id, 11, "accepted");
    await f.observe(110, { epoch: 2, inventory: { [log]: 3 }, workOrder: {
      id: gather.id, state: "needs_replan", detail: "Harvest active",
      progress: { phase: "harvest", status: "Working toward the stock target", breaks: 2, crafts: 0, placements: 0,
        replan: "target_near", lastEffect: { tick: 108, detail: "Collected an oak log." } },
    } });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ work: { demand: "successor", current: { id: gather.id } },
      feedback: { kind: "work_resource_shortage", detail: expect.stringContaining("needs 13 minecraft:oak_planks") } });
    expect(await f.order()).toEqual(gather);
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

const ironItem = "minecraft:iron_ingot", rawIronItem = "minecraft:raw_iron";
const fuelItem = "minecraft:oak_planks", furnaceItem = "minecraft:furnace";
const ironPolicy = {
  target: { kind: "stock", item: ironItem, count: 3 }, allowedEffects: [`smelt:${ironItem}`, `place:${furnaceItem}`],
  costCaps: [{ item: rawIronItem, count: 2 }, { item: fuelItem, count: 2 }, { item: furnaceItem, count: 1 }],
  reserves: [{ item: fuelItem, count: 1 }], maxBreaks: 0, maxCrafts: 2, maxPlacements: 1,
} as const;

function paidIron(id: string, remainingTicks: number): NonNullable<MacroObservation["pendingWork"]> {
  return {
    id, kind: "iron-smelting", goal: "diamond", invested: [{ item: rawIronItem, count: 2 }, { item: fuelItem, count: 2 }],
    output: { item: ironItem, count: 2 }, location: "Dry stance beside the visible stone workshop.",
    state: "estimated", remainingTicks, yieldable: true, parked: false,
  };
}

test.each(["preset", "constrained"] as const)("A regular %s strategist can quote one iron batch; cooking is not completion", async mode => {
  const inventory = { [ironItem]: 1, [rawIronItem]: 2, [fuelItem]: 3, [furnaceItem]: 1 };
  const live = { goal: "diamond", inventory };
  let observedMode: string | undefined;
  let openingId: string | undefined;
  let requests = 0;
  const f = await durableFixture(async request => {
    if (++requests > 1) return workReply(request, { kind: "abstain" });
    observedMode = request.work?.mode;
    return workReply(request, { kind: "work", policy: ironPolicy });
  }, mode === "constrained" ? "Find diamonds, keeping at least one oak plank." : undefined);
  try {
    await f.observe(10, live);
    if (mode === "preset") {
      const opening = await f.order();
      openingId = opening.id;
      expect(opening).toMatchObject({ target: { kind: "preset", goal: "diamond" }, origin: "preset",
        allowedEffects: [], costCaps: [], maxBreaks: 32, maxCrafts: 24, maxPlacements: 2 });
      await f.receipt(opening.id, 11, "accepted");
      await f.observe(11, { ...live, workOrder: { id: opening.id, state: "working", detail: "Opening underway" } });
    }
    await f.actor.poll();
    const work = await f.order();
    expect(observedMode).toBe(mode);
    expect(work).toMatchObject({ origin: "model", target: ironPolicy.target, maxCrafts: 2, maxPlacements: 1,
      allowedEffects: [`place:${furnaceItem}`, `smelt:${ironItem}`], reserves: ironPolicy.reserves });
    expect(work.nextWorkId).toBeUndefined();
    if (openingId) await f.receipt(openingId, 12, "interrupted");
    await f.receipt(work.id, 12, "accepted");
    const cooking = { goal: live.goal, inventory: { [ironItem]: 1, [fuelItem]: 1 }, workOrder: {
      id: work.id, state: "working", detail: "Batch loaded",
      progress: { phase: "smelt", status: "Cooking two raw iron", breaks: 0, crafts: 0, placements: 1 },
    } } as const;
    await f.observe(13, cooking);
    await f.observe(work.expiresTick - 2, cooking);
    expect(requests).toBe(1);
    expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 0, completedWorkPrograms: 0 });
    expect(await f.order()).toEqual(work);
    await f.receipt(work.id, work.expiresTick - 1, "completed");
    await f.observe(work.expiresTick - 1, { goal: live.goal, inventory: { [ironItem]: 3, [fuelItem]: 1 } });
    expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 1, completedWorkPrograms: 0 });
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["bucket", "abstain", "wrong predecessor", "replacement", "revocation", "missing ingots", "missing station",
  "interrupted", "blocked", "new life", "late", "expired", "no budget"] as const)(
  "A paid iron batch allows only a fresh bound successor: %s", async result => {
    const bucket = "minecraft:bucket";
    const live = { goal: "diamond", inventory: { [ironItem]: 1, [rawIronItem]: 4, [fuelItem]: 5, [furnaceItem]: 1 } };
    const deposited = { [ironItem]: 1, [rawIronItem]: 2, [fuelItem]: 3 };
    const table = [{ id: "table", verb: "interact", risk: "guarded", summary: "Open visible minecraft:crafting_table",
      evidence: "A lit workstation face is inside vanilla use reach." }] as const;
    const policy = { target: { kind: "stock", item: bucket, count: 1 }, allowedEffects: ["craft:bucket"],
      costCaps: [{ item: ironItem, count: 3 }], reserves: ironPolicy.reserves,
      maxBreaks: 0, maxCrafts: 1, maxPlacements: 0 } as const;
    const release = Promise.withResolvers<void>();
    const requests: MacroRequest[] = [];
    let overlapSignal: AbortSignal | undefined;
    const f = await durableFixture(async (request, signal) => {
      requests.push(request);
      if (requests.length === 1) return workReply(request, { kind: "work", policy: ironPolicy });
      if (!request.work?.current) return workReply(request, { kind: "abstain" });
      overlapSignal = signal;
      await release.promise;
      const id = request.work.current.id;
      if (result === "abstain") return workReply(request, { kind: "abstain" });
      if (result === "revocation") return workReply(request, { kind: "revoke-work", workOrderId: id });
      if (result === "replacement") return workReply(request, { kind: "work", policy });
      return workReply(request, { kind: "work-program", afterWorkId: result === "wrong predecessor" ? "other-id" : id, stages: [
        { policy, requires: [{ item: ironItem, count: 3 }, { item: rawIronItem, count: 2 }, { item: fuelItem, count: 3 }] },
        { policy: { ...policy, target: { kind: "stock", item: "minecraft:stick", count: 4 }, allowedEffects: ["craft:stick"],
          costCaps: [{ item: fuelItem, count: 2 }] }, requires: [{ item: bucket, count: 1 }] },
      ] }, result === "expired" ? 300 : 1100);
    }, "Make a bucket while keeping one plank.", result === "no budget" ? 1 : 3);
    try {
      await f.observe(10, live);
      await f.actor.poll();
      const batch = await f.order();
      await f.receipt(batch.id, 11, "accepted");
      const loading = { id: batch.id, state: "working", detail: "A paid batch is loading",
        progress: { phase: "smelt", status: "Loading", breaks: 0, crafts: 0, placements: 1 } } as const;
      await f.observe(110, { goal: live.goal, inventory: deposited, workOrder: {
        ...loading, detail: "Vanilla furnace cooking advanced", // Free text alone cannot trigger a request.
      } });
      expect(requests).toHaveLength(1);
      const burn = { burnTick: 111, units: 2, remainingCookTicks: 395 };
      const burning = { ...loading, progress: { ...loading.progress, smeltBurn: burn } };
      const paid = paidIron(batch.id, burn.remainingCookTicks);
      await f.observe(115, { goal: live.goal, inventory: deposited, workOrder: burning, pendingWork: paid });
      if (result === "no budget") {
        expect(requests).toHaveLength(1);
        expect(await f.order()).toEqual(batch);
        return;
      }
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ observation: { inventory: deposited }, work: {
        demand: "successor", current: { id: batch.id, origin: "model", accepted: { tick: 11 },
          nativeState: { progress: { crafts: 0, smeltBurn: burn } } },
      } });
      expect(overlapSignal?.aborted).toBe(false);
      if (result !== "late" && result !== "interrupted" && result !== "blocked" && result !== "new life") release.resolve();
      await f.observe(225, { goal: live.goal, inventory: deposited, pendingWork: { ...paid, remainingTicks: 285 }, workOrder: {
        ...burning, progress: { ...burning.progress, smeltBurn: { ...burn, remainingCookTicks: 285 } },
      } });
      const shouldQueue = ["bucket", "missing ingots", "missing station", "expired"].includes(result);
      expect(f.actor.status()).toMatchObject({ workQueuedAfter: shouldQueue ? batch.id : null,
        issuedWorkOrders: 1, completedModelWorkOrders: 0 });
      await f.observe(335, { goal: live.goal, inventory: deposited, pendingWork: { ...paid, remainingTicks: 175 }, workOrder: {
        ...burning, progress: { ...burning.progress, smeltBurn: { ...burn, remainingCookTicks: 175 } },
      } });
      expect(requests).toHaveLength(2);
      expect(await f.order()).toEqual(batch);
      if (result === "blocked" || result === "new life") {
        await f.observe(340, { goal: live.goal, inventory: deposited, workOrder: result === "blocked" ? {
          ...loading, state: "blocked",
        } : undefined, ...(result === "new life" ? { life: 2, epoch: 2 } : {}) });
        expect(overlapSignal?.aborted).toBe(true);
        release.resolve();
        await f.actor.poll();
        expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 1, workQueuedAfter: null });
        if (result === "blocked") expect(await f.order()).toEqual(batch);
        return;
      }

      const completeTick = 530;
      if (result === "interrupted") await f.receipt(batch.id, completeTick, "interrupted");
      else await f.receipt(batch.id, completeTick, "completed");
      // Reading the journal before the corresponding inventory sample cannot start the craft.
      await f.observe(completeTick - 1, { goal: live.goal, inventory: deposited, workOrder: {
        ...burning, progress: { ...burning.progress, smeltBurn: { ...burn, remainingCookTicks: 0 } },
      } });
      await expect(access(f.file("work.json"))).rejects.toThrow();
      if (result === "late" || result === "interrupted") {
        expect(overlapSignal?.aborted).toBe(true);
        release.resolve();
      }
      await f.observe(completeTick, { goal: live.goal, epoch: 2,
        inventory: { ...deposited, ...(result === "missing ingots" ? { [ironItem]: 2, "minecraft:copper_ingot": 1 } : { [ironItem]: 3 }) },
        opportunities: result === "missing station" ? [] : table,
        workOrder: { id: batch.id, state: "complete", detail: "Vanilla confirmed inventory" },
      });
      if (result === "bucket") {
        expect(await f.order()).toMatchObject({ basisTick: completeTick, origin: "model", target: policy.target });
        expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 2, completedModelWorkOrders: 1 });
        expect(requests).toHaveLength(2);
        expect(await readFile(f.file("history.jsonl"), "utf8")).not.toContain('"event":"work_resource_shortage"');
      } else {
        await expect(access(f.file("work.json"))).rejects.toThrow();
        expect(f.actor.status().issuedWorkOrders).toBe(1);
      }
    } finally {
      release.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

const sideStone = {
  target: { kind: "stock", item: "minecraft:cobblestone", count: 3 },
  allowedEffects: ["break:minecraft:stone"], costCaps: [], reserves: ironPolicy.reserves,
  maxBreaks: 3, maxCrafts: 0, maxPlacements: 0,
} as const;
const witnessedStone = {
  id: "stone-face", verb: "break", risk: "guarded", summary: "Break visible stone beside the furnace",
  evidence: "Dry reach from the current rendered stance.",
  material: { subject: "block:minecraft:stone", target: "one-visible-stone", spends: {} },
} as const;
const returnOffer = {
  id: "fresh-furnace-return", verb: "collect_pending", risk: "guarded", summary: "Recheck the paid furnace",
  evidence: "A witnessed dry return to this station is still reachable.",
} as const;
const parkedCaveOffer = {
  id: "fresh-cave-edge", verb: "approach", risk: "low", summary: "Approach visible ore on a dry shelf",
  evidence: "The lit lane connects back to the paid furnace; no pickup or spend.",
} as const;
const parkedCave = {
  routes: "One paired dry level edge ahead. The witnessed workshop return remains connected.",
} as const;
const parkedStation = { routes: "Settled dry workshop; no cave edge was verified in this view." } as const;

test("Ordinary cave work can outlast cooking and renew without spending the queued batch output", async () => {
  const requests: MacroRequest[] = [];
  const goal = "diamond";
  const iron = "minecraft:raw_iron";
  const route = {
    id: "visible-ore-approach", verb: "approach", risk: "low",
    summary: "Approach a returnable shelf with visible iron", evidence: "Ore visible beyond direct break reach.",
  } as const;
  const mining = {
    target: { kind: "stock", item: iron, count: 6 },
    allowedEffects: ["break:minecraft:iron_ore", "break:minecraft:stone"],
    maxBreaks: 12, maxCrafts: 0, maxPlacements: 0, costCaps: [], reserves: ironPolicy.reserves,
  } as const;
  const bucket = {
    target: { kind: "stock", item: "minecraft:bucket", count: 1 },
    allowedEffects: ["craft:bucket"], costCaps: [{ item: ironItem, count: 3 }], reserves: ironPolicy.reserves,
    maxBreaks: 0, maxCrafts: 1, maxPlacements: 0,
  } as const;
  const f = await durableFixture(async request => {
    requests.push(request);
    const ticket = request.observation.pendingWork;
    if (requests.length === 1) return workReply(request, { kind: "work", policy: ironPolicy });
    if (request.observation.tick === 540 && request.work?.pendingPredecessor)
      return workReply(request, { kind: "work", policy: bucket, afterWorkId: request.work.pendingPredecessor.id });
    if (request.work?.renewal) return workReply(request, { kind: "renew-work", workOrderId: request.work.renewal.workOrderId });
    if (request.work?.duringWaitFor && request.work.current)
      return workReply(request, { kind: "work", policy: mining, duringWaitFor: request.work.duringWaitFor });
    if (ticket?.collectOfferId) return workReply(request, { kind: "collect-pending", pendingWorkId: ticket.id });
    return workReply(request, { kind: "abstain" });
  }, "Mine the visible cave and make a bucket only when the paid iron is held.", 8);
  try {
    const held = { [ironItem]: 1, [fuelItem]: 1, "minecraft:stone_pickaxe": 1, "minecraft:crafting_table": 1 };
    await f.observe(10, { goal, inventory: { ...held, [fuelItem]: 3, [iron]: 2, [furnaceItem]: 1 } });
    await f.actor.poll();
    const batch = await f.order();
    await f.receipt(batch.id, 11, "accepted");
    const ticket = paidIron(batch.id, 30);
    const cooking = { id: batch.id, state: "working", detail: "Paid",
      progress: { phase: "smelt", status: "Two paid units cooking", breaks: 0, crafts: 0, placements: 1,
        smeltBurn: { burnTick: 111, units: 2, remainingCookTicks: 30 } } } as const;
    await f.observe(114, { goal, inventory: held, workOrder: cooking });
    expect(requests).toHaveLength(1);
    await f.observe(115, { goal, inventory: held, workOrder: cooking, pendingWork: ticket, opportunities: [route] });
    await f.actor.poll();
    const leg = await f.order();
    expect(leg).toMatchObject({ duringWaitFor: batch.id, maxBreaks: 12, expiresTick: 1215 });
    expect(requests[1]?.observation.opportunities).toEqual([route]);
    await f.receipt(batch.id, 116, "parked");
    await f.receipt(leg.id, 116, "accepted");
    const parked = { ...ticket, parked: true, yieldable: false, returnClue: "walked_route" } as const;
    const routing = { id: leg.id, state: "working", detail: "One dry level down, along walked return",
      progress: { phase: "route", status: "Approaching visible ore", breaks: 0, crafts: 0, placements: 0 } } as const;
    await f.observe(500, { goal, epoch: 2, inventory: held, pendingWork: { ...parked, remainingTicks: 12 }, workOrder: routing });
    await f.observe(520, { goal, epoch: 2, inventory: held, pendingWork: { ...parked, state: "unknown", remainingTicks: 0 }, workOrder: routing });
    expect(requests).toHaveLength(2);
    await expect(access(f.file("intent.json"))).rejects.toThrow();
    const gatheredSome = { ...held, [iron]: 4 };
    await f.observe(540, { goal, epoch: 2, inventory: gatheredSome, pendingWork: { ...parked, state: "unknown", remainingTicks: 0 },
      workOrder: { ...routing, progress: { ...routing.progress, phase: "collect", breaks: 4, replan: "target_near",
        lastEffect: { tick: 540, detail: "Four raw iron gathered from visible ore." } } } });
    await f.actor.poll();
    expect(f.actor.status()).toMatchObject({ workQueuedAfter: batch.id, issuedWorkOrders: 2 });
    expect((await f.order()).id).toBe(leg.id);
    await f.observe(1140, { goal, epoch: 2, inventory: gatheredSome, pendingWork: parked, workOrder: routing });
    await f.actor.poll();
    const renewal = await f.order();
    expect(renewal).toMatchObject({ duringWaitFor: batch.id, maxBreaks: 12, basisTick: 1140 });
    expect(renewal.id).not.toBe(leg.id);
    expect(requests[3]?.work).toMatchObject({ demand: "renew", pendingPredecessor: { id: batch.id, queuedTarget: bucket.target } });
    expect(requests[3]?.observation.pendingWork?.returnClue).toBe("walked_route");
    expect(requests[3]?.observation.inventory[ironItem]).toBe(1);
    await f.receipt(leg.id, 1141, "interrupted", "Replaced by a compatible work order.");
    await f.receipt(renewal.id, 1141, "accepted");
    const mined = { ...held, [iron]: 6 };
    await f.receipt(renewal.id, 1230, "completed");
    const recall = { ...parked, state: "unknown", remainingTicks: 0, collectOfferId: returnOffer.id, worksite: parkedStation } as const;
    await f.observe(1230, { goal, epoch: 3, inventory: mined, pendingWork: recall, opportunities: [returnOffer], quiescent: true });
    await f.actor.poll();
    const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
    expect(intent.opportunityId).toBe(returnOffer.id);
    await f.receipt(intent.id, 1231, "accepted");
    await f.observe(1235, { goal, epoch: 3, inventory: mined, pendingWork: { ...parked, state: "unknown", remainingTicks: 0 } });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(requests).toHaveLength(5);
    expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 3, issued: 1, completedModelWorkOrders: 1, workQueuedAfter: batch.id });
    await f.receipt(batch.id, 1240, "completed");
    await f.observe(1240, { goal, epoch: 3, inventory: { ...mined, [ironItem]: 3 } });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    await f.receipt(intent.id, 1240, "completed");
    await f.observe(1241, { goal, epoch: 3, inventory: { ...mined, [ironItem]: 3 }, opportunities: [{
      id: "reachable-workbench", verb: "interact", risk: "guarded", summary: "Open visible minecraft:crafting_table",
      evidence: "A lit workstation face is inside vanilla use reach.",
    }] });
    expect(await f.order()).toMatchObject({ basisTick: 1241, target: bucket.target });
    expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 2, completedReceipts: 1 });
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["cave now", "ready but independent", "richer route", "blocked", "delayed view"] as const)(
  "A completed side order waits for its settled parked worksite and does not poll the furnace countdown: %s", async course => {
    const requests: MacroRequest[] = [];
    const goal = "diamond", ironPick = "minecraft:iron_pickaxe";
    const f = await durableFixture(async request => {
      requests.push(request);
      if (requests.length === 1)
        return workReply(request, { kind: "work", policy: ironPolicy, duringWait: { policy: sideStone, maxTicks: 600 } });
      const choice = request.observation.opportunities.find(offer => offer.id === parkedCaveOffer.id);
      if (choice && (course === "cave now" || course === "ready but independent"))
        return workReply(request, { kind: "opportunity", opportunityId: choice.id });
      return workReply(request, { kind: "abstain" });
    }, "Prepare a bucket and continue cave work when safe.", 6);
    try {
      const held = { [ironItem]: 1, [fuelItem]: 1, [ironPick]: 1 };
      await f.observe(10, { goal, inventory: { ...held, [fuelItem]: 3, [rawIronItem]: 2, [furnaceItem]: 1 } });
      await f.actor.poll();
      const batch = await f.order();
      await f.receipt(batch.id, 11, "accepted");
      const ticket = paidIron(batch.id, 395);
      await f.observe(115, { goal, inventory: held, pendingWork: ticket, opportunities: [witnessedStone],
        workOrder: { id: batch.id, state: "working", detail: "Paid burn",
          progress: { phase: "smelt", status: "Cooking two paid units", breaks: 0, crafts: 0, placements: 1,
            smeltBurn: { burnTick: 111, units: 2, remainingCookTicks: 395 } } } });
      await f.actor.poll();
      const side = await f.order();
      await f.receipt(batch.id, 116, "parked");
      await f.receipt(side.id, 116, "accepted");
      await f.receipt(side.id, 452, "completed");
      const heldAfterSide = { ...held, "minecraft:cobblestone": 3 };
      const parked = { ...ticket, parked: true, yieldable: false, remainingTicks: 370 };
      await f.observe(453, { goal, inventory: heldAfterSide, pendingWork: parked });
      await f.actor.poll();
      expect(requests).toHaveLength(1); // Inventory closure is not an idle world.
      if (course === "delayed view") {
        await f.observe(480, { goal, inventory: heldAfterSide, pendingWork: { ...parked, remainingTicks: 340 } });
        await f.actor.poll();
        expect(requests[1]?.work?.parkedWorksite).toBe("view-unavailable");
        await f.observe(495, { goal, inventory: heldAfterSide, pendingWork: { ...parked, remainingTicks: 330 } });
        expect(requests).toHaveLength(2);
      }
      const blocked = course === "blocked";
      const explore = course === "cave now" || course === "ready but independent";
      const local = { ...parked, ...(blocked ? { state: "blocked" as const } : { collectOfferId: returnOffer.id }),
        ...(course === "ready but independent" ? { state: "unknown" as const, remainingTicks: 0 } : {}),
        worksite: explore ? parkedCave :
          { routes: blocked ? "Water blocks the lane; no connected dry return is witnessed." : "No cave edge is yet witnessed." } };
      const world = { goal, inventory: heldAfterSide, pendingWork: local,
        opportunities: blocked ? [] : explore ? [returnOffer, parkedCaveOffer] : [returnOffer] };
      const worldTick = course === "delayed view" ? 500 : 458;
      await f.observe(worldTick, world);
      await f.actor.poll();
      expect(requests.at(-1)?.observation.tick).toBe(worldTick);
      expect(requests.at(-1)?.work?.parkedWorksite).toBe("settled");
      expect(requests.at(-1)?.observation.inventory[ironItem]).toBe(1);
      if (explore) {
        const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
        expect(intent).toMatchObject({ opportunityId: parkedCaveOffer.id, basisTick: worldTick, skillHash: null });
        return;
      }
      let expected = requests.length;
      await f.observe(worldTick + 5, { ...world, pendingWork: { ...local, remainingTicks: 360 } });
      expect(requests).toHaveLength(expected);
      if (course === "richer route") {
        await f.observe(worldTick + 80, { ...world, pendingWork: { ...local, remainingTicks: 355, worksite: parkedCave },
          opportunities: [returnOffer, parkedCaveOffer] });
        await f.actor.poll();
        expect(requests).toHaveLength(++expected);
        const renewed = { ...parkedCaveOffer, id: "same-edge-new-opaque-id" };
        await f.observe(worldTick + 85, { ...world, opportunities: [returnOffer, renewed],
          pendingWork: { ...local, remainingTicks: 350, worksite: parkedCave } });
        expect(requests).toHaveLength(expected);
      }
      await expect(access(f.file("intent.json"))).rejects.toThrow();
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each(["finished on return", "witnessed burn end", "hazard", "death"] as const)(
  "An explicit paid recall does not poll or credit cook time: %s", async branch => {
    const goal = "diamond";
    const requests: MacroRequest[] = [];
    const f = await durableFixture(async request => {
      requests.push(request);
      if (requests.length === 1) return workReply(request, { kind: "work", policy: ironPolicy,
        duringWait: { policy: sideStone, maxTicks: 600 } });
      const ticket = request.observation.pendingWork;
      return workReply(request, ticket?.collectOfferId
        ? { kind: "collect-pending", pendingWorkId: ticket.id } : { kind: "abstain" });
    }, "Use the paid ingots to make a bucket.", 5);
    try {
      const held = { [ironItem]: 1, [fuelItem]: 1, "minecraft:iron_pickaxe": 1 };
      await f.observe(10, { goal, inventory: { ...held, [fuelItem]: 3, [rawIronItem]: 2, [furnaceItem]: 1 } });
      await f.actor.poll();
      const batch = await f.order();
      await f.receipt(batch.id, 11, "accepted");
      const ticket = paidIron(batch.id, 395);
      await f.observe(115, { goal, inventory: held, pendingWork: ticket, opportunities: [witnessedStone],
        workOrder: { id: batch.id, state: "working", detail: "Paid burn",
          progress: { phase: "smelt", status: "Cooking both paid units", breaks: 0, crafts: 0, placements: 1,
            smeltBurn: { burnTick: 111, units: 2, remainingCookTicks: 395 } } } });
      await f.actor.poll();
      const side = await f.order();
      await f.receipt(batch.id, 116, "parked");
      await f.receipt(side.id, 116, "accepted");
      await f.receipt(side.id, 450, "interrupted");
      const parked = { ...ticket, parked: true, yieldable: false };
      const recall = { ...parked, remainingTicks: 63, worksite: parkedStation, collectOfferId: returnOffer.id };
      const idle = { goal, inventory: held, quiescent: true, opportunities: [returnOffer], pendingWork: recall };
      await f.observe(455, idle);
      await f.actor.poll();
      const first = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
      await f.receipt(first.id, 456, "accepted");
      const inScreen = { goal, inventory: held, pendingWork: { ...parked, remainingTicks: 40 } };
      await f.observe(480, inScreen);
      await f.actor.poll();
      expect(requests).toHaveLength(2);
      expect(f.actor.status()).toMatchObject({ issued: 1, completedReceipts: 0, completedModelWorkOrders: 0 });
      if (branch === "hazard" || branch === "death") {
        await f.observe(484, branch === "hazard"
          ? { ...inScreen, epoch: 2, safety: { revision: 2, clear: false } }
          : { goal, epoch: 2, life: 2, health: 0, inventory: {} });
        await f.actor.poll();
        await expect(access(f.file("intent.json"))).rejects.toThrow();
        expect(requests).toHaveLength(2);
        expect(f.actor.status()).toMatchObject({ issued: 1, completedReceipts: 0, completedModelWorkOrders: 0 });
        return;
      }
      if (branch === "finished on return") {
        await f.receipt(batch.id, 520, "completed");
        await f.receipt(first.id, 520, "completed");
        await f.observe(520, { goal, epoch: 2, inventory: { ...held, [ironItem]: 3 } });
        expect(f.actor.status()).toMatchObject({ issued: 1, completedReceipts: 1, completedModelWorkOrders: 1 });
        return;
      }
      await f.receipt(first.id, 483, "interrupted", "Fresh conserved slots were not close enough. The paid batch is still pending.");
      await f.observe(484, { ...idle, pendingWork: { ...recall, remainingTicks: 160 } });
      await f.observe(700, { ...idle, pendingWork: { ...recall, state: "unknown", remainingTicks: 0 } });
      expect(requests).toHaveLength(2);
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      const recheck = { ...returnOffer, evidence: `${returnOffer.evidence} The exact furnace was seen unlit after the last burning recheck; output is unproved.` };
      await f.observe(800, { ...idle, opportunities: [recheck], pendingWork: { ...recall, state: "unknown", remainingTicks: 0 } });
      await f.actor.poll();
      const fresh = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
      expect(fresh).toMatchObject({ basisTick: 800, opportunityId: first.opportunityId, skillHash: null });
      expect(fresh.id).not.toBe(first.id);
      expect(requests).toHaveLength(3);
      await f.receipt(fresh.id, 801, "accepted");
      await f.receipt(fresh.id, 804, "interrupted");
      await f.observe(850, { ...idle, opportunities: [recheck], pendingWork: { ...recall, state: "unknown", remainingTicks: 0 } });
      expect(requests).toHaveLength(3);
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      expect(f.actor.status()).toMatchObject({ issued: 2, completedReceipts: 0, completedModelWorkOrders: 0 });
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each(["prequoted", "fallback"] as const)("A %s side grant produces stock during cooking, then leaves collection to a fresh return", async approach => {
  const requests: MacroRequest[] = [];
  const releaseOldReturn = Promise.withResolvers<void>();
  const goal = "diamond";
  const held = { [ironItem]: 1, [fuelItem]: 1, "minecraft:iron_pickaxe": 1 };
  const f = await durableFixture(async request => {
    requests.push(request);
    if (requests.length === 1) return workReply(request, { kind: "work", policy: ironPolicy,
      ...(approach === "prequoted" ? { duringWait: { policy: sideStone, maxTicks: 600 } } : {}) });
    if (request.work?.duringWaitFor && request.work.current?.id === request.work.duringWaitFor)
      return workReply(request, { kind: "work", policy: sideStone, duringWaitFor: request.work.duringWaitFor });
    if (request.observation.tick === 550) await releaseOldReturn.promise;
    return workReply(request, request.observation.pendingWork?.collectOfferId
      ? { kind: "collect-pending", pendingWorkId: request.observation.pendingWork.id } : { kind: "abstain" });
  }, "Find diamond and keep one plank for the workshop.", 6);
  try {
    await f.observe(10, { goal, inventory: { ...held, [fuelItem]: 3, [rawIronItem]: 2, [furnaceItem]: 1 },
      opportunities: [witnessedStone] });
    await f.actor.poll();
    const batch = await f.order();
    await f.receipt(batch.id, 11, "accepted");
    const burning = {
      id: batch.id, state: "working", detail: "Furnace is cooking two paid inputs",
      progress: { phase: "smelt", status: "Rising vanilla cook bar", breaks: 0, crafts: 0, placements: 1,
        smeltBurn: { burnTick: 111, units: 2, remainingCookTicks: 395 } },
    } as const;
    await f.observe(112, { goal, inventory: held, workOrder: burning });
    expect(requests).toHaveLength(1);
    expect((await f.order()).id).toBe(batch.id);
    const ticket = paidIron(batch.id, 395);
    await f.observe(115, { goal, inventory: held, workOrder: burning, pendingWork: ticket, opportunities: [witnessedStone] });
    await f.actor.poll();
    const side = await f.order();
    expect(side).toMatchObject({ duringWaitFor: batch.id, basisTick: 115, target: sideStone.target });
    expect(side.id).not.toBe(batch.id);
    expect(requests).toHaveLength(approach === "prequoted" ? 1 : 2);
    expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 0 });

    await f.receipt(batch.id, 116, "parked");
    await f.receipt(side.id, 116, "accepted");
    const sideState = { id: side.id, state: "working", detail: "Nearby stone",
      progress: { phase: "harvest", status: "Confirmed stone pickup", breaks: 1, crafts: 0, placements: 0,
        lastEffect: { tick: 170, detail: "One cobblestone collected while the furnace still cooks." } } } as const;
    const parked = { ...ticket, parked: true, yieldable: false };
    await f.observe(170, { goal, inventory: { ...held, "minecraft:cobblestone": 1 }, workOrder: sideState,
      pendingWork: { ...parked, remainingTicks: 336 } });
    expect(f.actor.status()).toMatchObject({ workOrder: { id: side.id, accepted: { status: "accepted" } }, completedModelWorkOrders: 0 });
    const due = { ...parked, state: "unknown", remainingTicks: 0 } as const;
    await f.observe(507, { goal, inventory: { ...held, "minecraft:cobblestone": 2 }, workOrder: sideState, pendingWork: due });
    expect((await f.order()).id).toBe(side.id);
    await expect(access(f.file("intent.json"))).rejects.toThrow();

    await f.receipt(side.id, 550, "completed");
    const stocked = { ...held, "minecraft:cobblestone": 3 };
    await f.observe(550, { goal, inventory: stocked, quiescent: true, opportunities: [returnOffer],
      pendingWork: { ...due, collectOfferId: returnOffer.id, worksite: parkedStation } });
    expect(f.actor.status().completedModelWorkOrders).toBe(1);
    await f.observe(551, { goal, inventory: stocked, quiescent: true, pendingWork: due });
    releaseOldReturn.resolve();
    await f.actor.poll();
    await expect(access(f.file("intent.json"))).rejects.toThrow();
    const laterOffer = { ...returnOffer, id: "returned-furnace-after-recheck" };
    await f.observe(1150, { goal, inventory: stocked, quiescent: true, opportunities: [laterOffer],
      pendingWork: { ...due, collectOfferId: laterOffer.id, worksite: parkedStation } });
    await f.actor.poll();
    const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
    expect(intent).toMatchObject({ opportunityId: laterOffer.id, basisTick: 1150, skillHash: null });
    await f.receipt(intent.id, 1151, "accepted");
    await f.receipt(batch.id, 1160, "completed"); // Parked production can settle after its original order expiry.
    await f.receipt(intent.id, 1160, "completed");
    await f.observe(1160, { goal, inventory: { ...stocked, [ironItem]: 3 } });
    expect(f.actor.status()).toMatchObject({ completedModelWorkOrders: 2, completedReceipts: 1 });
  } finally {
    releaseOldReturn.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test("An optional local quote cannot wake on a later view after missing the first clean release", async () => {
  const requests: MacroRequest[] = [];
  const f = await durableFixture(async request => {
    requests.push(request);
    return workReply(request, requests.length === 1
      ? { kind: "work", policy: ironPolicy, duringWait: { policy: sideStone, maxTicks: 600 } }
      : { kind: "abstain" });
  }, "Find diamonds and keep one plank.", 4);
  try {
    const goal = "diamond";
    const inventory = { [ironItem]: 1, [fuelItem]: 1 };
    await f.observe(10, { goal, inventory: { ...inventory, [fuelItem]: 3, [rawIronItem]: 2, [furnaceItem]: 1 } });
    await f.actor.poll();
    const batch = await f.order();
    await f.receipt(batch.id, 11, "accepted");
    const workOrder = { id: batch.id, state: "working", detail: "Paid", progress: {
      phase: "smelt", status: "Cooking", breaks: 0, crafts: 0, placements: 1,
      smeltBurn: { burnTick: 111, remainingCookTicks: 395, units: 2 },
    } } as const;
    const pendingWork = paidIron(batch.id, 395);
    await f.observe(115, { goal, inventory, pendingWork, workOrder });
    await f.actor.poll();
    expect(requests[1]?.work?.duringWaitFor).toBe(batch.id);
    await f.observe(125, { goal, inventory, pendingWork, workOrder, opportunities: [witnessedStone] });
    await f.actor.poll();
    expect(requests).toHaveLength(2);
    expect(await f.order()).toEqual(batch);
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("A late independent reply cannot replace the paid job after safety changes", async () => {
  const reply = Promise.withResolvers<void>();
  const seen: MacroRequest[] = [];
  const f = await durableFixture(async request => {
    seen.push(request);
    if (seen.length === 1) return workReply(request, { kind: "work", policy: ironPolicy });
    await reply.promise;
    return workReply(request, { kind: "work", policy: sideStone, duringWaitFor: request.work!.duringWaitFor! });
  }, "Mine a safe cave shelf and keep the reserve plank.", 3);
  try {
    const goal = "diamond", held = { [ironItem]: 1, [fuelItem]: 1 };
    await f.observe(10, { goal, inventory: { ...held, [fuelItem]: 3, [rawIronItem]: 2, [furnaceItem]: 1 } });
    await f.actor.poll();
    const batch = await f.order();
    await f.receipt(batch.id, 11, "accepted");
    const workOrder = { id: batch.id, state: "working", detail: "Cooking two paid units", progress: {
      phase: "smelt", status: "Cooking", breaks: 0, crafts: 0, placements: 1,
      smeltBurn: { burnTick: 111, remainingCookTicks: 395, units: 2 },
    } } as const;
    await f.observe(115, { goal, inventory: held, workOrder, pendingWork: paidIron(batch.id, 395) });
    expect(seen[1]?.work?.duringWaitFor).toBe(batch.id);
    await f.observe(116, { goal, epoch: 2, inventory: held, workOrder, safety: { clear: false, revision: 2 } });
    reply.resolve();
    await f.actor.poll();
    expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 1, issued: 0 });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    await expect(access(f.file("intent.json"))).rejects.toThrow();
  } finally {
    reply.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["single charged unit", "held mouse", "protected stock", "dead", "wrong ticket"] as const)(
  "A side policy cannot take control through %s", async premise => {
    const one = premise === "single charged unit";
    const reserve = premise === "protected stock";
    const smelt = one ? { ...ironPolicy, target: { ...ironPolicy.target, count: 2 }, maxCrafts: 1 } : ironPolicy;
    const seen: MacroRequest[] = [];
    const f = await durableFixture(async request => {
      seen.push(request);
      if (seen.length === 1) return workReply(request, { kind: "work", policy: smelt });
      return workReply(request, { kind: "work", policy: sideStone,
        duringWaitFor: premise === "wrong ticket" ? "wrong-batch" : request.work?.current?.id ?? "missing-batch" });
    }, "Find diamond and reserve one oak plank.", 3);
    try {
      const held = { [ironItem]: 1, [fuelItem]: reserve ? 0 : 1, "minecraft:iron_pickaxe": 1 };
      await f.observe(10, { goal: "diamond", inventory: { ...held, [fuelItem]: 3, [rawIronItem]: 2, [furnaceItem]: 1 } });
      await f.actor.poll();
      const batch = await f.order();
      await f.receipt(batch.id, 11, "accepted");
      const state = { id: batch.id, state: "working", detail: "Cooking",
        progress: { phase: "smelt", status: "Paid burn", breaks: 0, crafts: 0, placements: 1,
          smeltBurn: { burnTick: 111, units: one ? 1 : 2, remainingCookTicks: one ? 195 : 395 } } } as const;
      await f.observe(115, { goal: "diamond", inventory: held, workOrder: state,
        ...(one || premise === "held mouse" || premise === "dead" ? {} : { pendingWork: paidIron(batch.id, 395) }),
        ...(premise === "held mouse" ? { working: { intentId: "held-break", crack: 0.5 } } : {}),
        ...(premise === "dead" ? { health: 0 } : {}), opportunities: [witnessedStone] });
      await f.actor.poll();
      expect(seen[1]?.work?.duringWaitFor).toBe(reserve || premise === "wrong ticket" ? batch.id : undefined);
      expect(f.actor.status().issuedWorkOrders).toBe(1);
      if (premise !== "dead") expect((await f.order()).id).toBe(batch.id);
      await expect(access(f.file("intent.json"))).rejects.toThrow();
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each([true, false])("Historical work stays untagged and preserves remembered reserves: %s", async keepFloor => {
  const requests: MacroRequest[] = [];
  const f = await durableFixture(async request => {
    requests.push(request);
    return workReply(request, { kind: "work", policy: { ...sideStone, reserves: keepFloor ? ironPolicy.reserves : [] } });
  }, "Continue toward diamonds.", 2);
  try {
    const old = { ...paidIron("old-paid-batch", 0), historical: true, state: "unknown", parked: true, yieldable: false,
      protectedReserves: ironPolicy.reserves, worksite: parkedStation } as const;
    await f.observe(10, { goal: "diamond", quiescent: true, inventory: { [fuelItem]: 1, "minecraft:stone_pickaxe": 1 },
      pendingWork: old, opportunities: [witnessedStone] });
    await f.actor.poll();
    expect(requests[0]?.work?.protectedReserves).toEqual(ironPolicy.reserves);
    expect(requests[0]?.work?.duringWaitFor).toBeUndefined();
    expect(requests[0]?.work?.pendingPredecessor).toBeUndefined();
    if (keepFloor) {
      expect(await f.order()).toMatchObject({ target: sideStone.target, reserves: ironPolicy.reserves });
      expect((await f.order()).duringWaitFor).toBeUndefined();
    } else await expect(access(f.file("work.json"))).rejects.toThrow();
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["invented follow", "direct stock quote", "ordinary work"] as const)(
  "Paid-cook context reaches the strategist without admitting %s", async attempted => {
    const route = "Current post-Escape view; travel descriptions grant no movement. Paired cave route: " +
      "one witnessed block down ahead, with a witnessed return and a current dry first-edge check.";
    const requests: MacroRequest[] = [];
    const defer = { id: "park-live-batch", verb: "defer_pending", risk: "low", summary: "Defer the paid batch",
      evidence: "Clean controls were released." } as const;
    const f = await durableFixture(async request => {
      requests.push(request);
      if (!request.work?.current) return workReply(request, { kind: "work", policy: ironPolicy });
      return workReply(request, attempted === "ordinary work" ? { kind: "work", policy: sideStone } :
        { kind: "opportunity", opportunityId: attempted === "invented follow" ? "follow-cave" : witnessedStone.id });
    }, "Prepare a bucket, then look for diamonds.", 2);
    try {
      const inventory = { [ironItem]: 1, [fuelItem]: 1, "minecraft:iron_pickaxe": 1 };
      await f.observe(10, { goal: "diamond", inventory: { ...inventory, [fuelItem]: 3, [rawIronItem]: 2, [furnaceItem]: 1 } });
      await f.actor.poll();
      const batch = await f.order();
      await f.receipt(batch.id, 11, "accepted");
      await f.observe(115, { goal: "diamond", inventory, recent: [route], opportunities: [defer, witnessedStone],
        workOrder: { id: batch.id, state: "working", detail: "Cooking",
          progress: { phase: "smelt", status: "Paid burn", breaks: 0, crafts: 0, placements: 1,
            smeltBurn: { burnTick: 111, units: 2, remainingCookTicks: 395 } } },
        pendingWork: { ...paidIron(batch.id, 395), deferOfferId: defer.id } });
      await f.actor.poll();
      expect(requests[1]?.work?.duringWaitFor).toBe(batch.id);
      expect(requests[1]?.observation.recent).toContain(route);
      expect(requests[1]?.observation.opportunities.map(({ verb }) => verb)).toEqual(["defer_pending", "break"]);
      expect(await f.order()).toEqual(batch);
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      expect(f.actor.status()).toMatchObject({ issuedWorkOrders: 1, completedReceipts: 0 });
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each(["wait", "fresh approach"] as const)(
  "Explicit deferral retires the owner only on a native park and does not count as production: %s", async course => {
  const defer = { id: "fresh-defer", verb: "defer_pending", risk: "low", summary: "Leave the paid workshop",
    evidence: "The exact paid furnace released the controls." } as const;
  const requests: MacroRequest[] = [];
  const f = await durableFixture(async request => {
    requests.push(request);
    if (request.observation.opportunities.some(({ id }) => id === parkedCaveOffer.id))
      return workReply(request, { kind: "opportunity", opportunityId: parkedCaveOffer.id });
    if (request.observation.pendingWork?.parked) return workReply(request, { kind: "abstain" });
    if (!request.work?.current) return workReply(request, { kind: "work", policy: ironPolicy });
    return workReply(request, { kind: "defer-pending", pendingWorkId: request.work.current.id });
  }, "Keep one plank and return to the furnace after pause.", 6);
  try {
    const held = { [ironItem]: 1, [fuelItem]: 1, "minecraft:iron_pickaxe": 1 };
    await f.observe(10, { goal: "diamond", inventory: { ...held, [fuelItem]: 3, [rawIronItem]: 2, [furnaceItem]: 1 } });
    await f.actor.poll();
    const batch = await f.order();
    await f.receipt(batch.id, 11, "accepted");
    const ticket = paidIron(batch.id, 395);
    await f.observe(115, { goal: "diamond", inventory: held, workOrder: { id: batch.id, state: "working", detail: "Cooking",
      progress: { phase: "smelt", status: "Paid burn", breaks: 0, crafts: 0, placements: 1,
        smeltBurn: { burnTick: 111, units: 2, remainingCookTicks: 395 } } },
      pendingWork: { ...ticket, deferOfferId: defer.id }, opportunities: [defer] });
    await f.actor.poll();
    const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
    expect(intent.opportunityId).toBe(defer.id);
    expect((await f.order()).id).toBe(batch.id);
    await f.receipt(batch.id, 116, "parked");
    await f.receipt(intent.id, 116, "accepted");
    await f.receipt(intent.id, 116, "completed");
    const parked = { ...ticket, parked: true, yieldable: false, worksite: parkedStation };
    const atWorkshop = { goal: "diamond", inventory: held, quiescent: true,
      workOrder: { id: batch.id, state: "parked", detail: "Paid output remains in the station." } } as const;
    if (course === "fresh approach") {
      expect(requests[1]?.observation.opportunities.map(({ id }) => id)).toEqual([defer.id]);
      const recoverable = { ...parked, collectOfferId: returnOffer.id };
      await f.observe(117, { ...atWorkshop, pendingWork: { ...parked, worksite: undefined } });
      await f.actor.poll();
      expect(requests).toHaveLength(2); // A park receipt alone creates no crossing authority.
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      await f.observe(126, { ...atWorkshop, opportunities: [returnOffer, parkedCaveOffer],
        pendingWork: { ...recoverable, worksite: parkedCave } });
      await f.actor.poll();
      const edge = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
      expect(edge).toMatchObject({ opportunityId: parkedCaveOffer.id, basisTick: 126, skillHash: null });
      expect(requests).toHaveLength(3);
      expect(f.actor.status().completedModelWorkOrders).toBe(0);
      return;
    }
    await f.observe(116, { ...atWorkshop, pendingWork: parked });
    await expect(access(f.file("work.json"))).rejects.toThrow();
    expect(f.actor.status()).toMatchObject({ workOrder: null, completedModelWorkOrders: 0, completedReceipts: 0 });
    await f.observe(210, { ...atWorkshop, pendingWork: { ...parked, remainingTicks: 300 } });
    await f.actor.poll();
    expect(requests).toHaveLength(3); // One request on the native park, not a periodic timer.
    await f.observe(300, { ...atWorkshop, pendingWork: { ...parked, remainingTicks: 210 } });
    await f.observe(400, { ...atWorkshop, pendingWork: { ...parked, remainingTicks: 110 } });
    expect(requests).toHaveLength(3);
    await f.observe(520, { ...atWorkshop, opportunities: [returnOffer],
      pendingWork: { ...parked, state: "unknown", remainingTicks: 0, collectOfferId: returnOffer.id } });
    expect(requests).toHaveLength(4);
    expect(requests[3]?.observation.pendingWork?.collectOfferId).toBe(returnOffer.id);
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test.each(["ordinary opportunity", "duplicate production", "remembered description only"] as const)(
  "A remembered ticket grants no authority through %s", async attempted => {
    const seen: MacroRequest[] = [];
    const f = await durableFixture(async request => {
      seen.push(request);
      return workReply(request, attempted === "ordinary opportunity" ? { kind: "opportunity", opportunityId: returnOffer.id } :
        attempted === "duplicate production" ? { kind: "work", policy: ironPolicy } :
          { kind: "collect-pending", pendingWorkId: "old-paid-batch" });
    }, "Keep one plank and recover only genuinely located resources.", 4);
    try {
      const returns = attempted !== "remembered description only";
      const live = { goal: "diamond", quiescent: true,
        inventory: { [ironItem]: 1, [fuelItem]: 3, [rawIronItem]: 2, [furnaceItem]: 1 },
        pendingWork: { ...paidIron("old-paid-batch", 0), historical: true, state: "unknown",
          parked: true, yieldable: false, worksite: parkedStation, ...(returns ? { collectOfferId: returnOffer.id } : {}) },
        opportunities: returns ? [returnOffer] : [],
      } as const;
      await f.observe(10, live);
      await f.actor.poll();
      await f.observe(150, live);
      await f.actor.poll();
      expect(seen).toHaveLength(1);
      await expect(access(f.file("work.json"))).rejects.toThrow();
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      expect(f.actor.status()).toMatchObject({ completedReceipts: 0, completedModelWorkOrders: 0 });
    } finally {
      await f.actor.stop();
      await f.clean();
    }
  },
);

test.each([
  [rawIronItem, "needs 3 minecraft:raw_iron"],
  [fuelItem, "only 300 ticks"],
])("Fresh protected %s makes the proposed smelt unaffordable", async (item, detail) => {
  const f = await durableFixture(async request => workReply(request, { kind: "work",
    policy: { ...ironPolicy, reserves: [{ item, count: 1 }] },
  }), `Find diamonds without spending the last ${item}.`, 1);
  try {
    await f.observe(10, { goal: "diamond", inventory: { [ironItem]: 1, [rawIronItem]: 2, [fuelItem]: 2, [furnaceItem]: 1 } });
    await f.actor.poll();
    expect(f.actor.status().issuedWorkOrders).toBe(0);
    await expect(access(f.file("work.json"))).rejects.toThrow();
    const history = await readFile(f.file("history.jsonl"), "utf8");
    expect(history).toContain('"event":"work_resource_shortage"');
    expect(history).toContain(detail);
  } finally {
    await f.actor.stop();
    await f.clean();
  }
});

test("A delayed resource repair cannot overwrite a program that advanced while the provider was pending", async () => {
  const log = "minecraft:oak_log", planks = "minecraft:oak_planks";
  let sent: MacroRequest | undefined;
  const release = Promise.withResolvers<void>();
  const craft = { target: { kind: "stock", item: planks, count: 8 } as const, allowedEffects: ["craft:oak_planks"],
    costCaps: [{ item: log, count: 2 }], reserves: [], maxBreaks: 0, maxCrafts: 2, maxPlacements: 0 };
  const f = await durableFixture(async request => {
    if (request.work?.current) {
      sent = request;
      await release.promise;
      return workReply(request, { kind: "work", afterWorkId: request.work.current.id, policy: craft });
    }
    return workReply(request, { kind: "work-program", stages: [
      { policy: { target: { kind: "stock", item: log, count: 4 }, allowedEffects: [`break:${log}`],
        costCaps: [], reserves: [], maxBreaks: 4, maxCrafts: 0, maxPlacements: 0 }, requires: [] },
      { policy: craft, requires: [{ item: log, count: 4 }] },
      { policy: { ...craft, target: { kind: "stock", item: "minecraft:stick", count: 4 }, allowedEffects: ["craft:stick"],
        costCaps: [{ item: planks, count: 2 }], maxCrafts: 1 }, requires: [{ item: planks, count: 12 }] },
    ] });
  }, "Gather supplies, then craft.");
  try {
    await f.observe(10, { inventory: { [log]: 1 } });
    await f.actor.poll();
    const gather = await f.order();
    await f.receipt(gather.id, 11, "accepted");
    await f.observe(110, { inventory: { [log]: 3 }, workOrder: {
      id: gather.id, state: "needs_replan", detail: "Harvest active",
      progress: { phase: "harvest", status: "Working toward the stock target", breaks: 2, crafts: 0, placements: 0,
        replan: "target_near", lastEffect: { tick: 108, detail: "Collected an oak log." } },
    } });
    expect(sent?.work?.current?.id).toBe(gather.id);
    await f.receipt(gather.id, 120, "completed");
    await f.observe(120, { epoch: 2, inventory: { [log]: 4 } });
    const active = await f.order();
    expect(active.id).toBe(gather.nextWorkId!);
    release.resolve();
    await f.actor.poll();
    expect(await f.order()).toEqual(active);
    expect(f.actor.status()).toMatchObject({ providerDispatches: 2, issuedWorkOrders: 2, workQueuedAfter: active.id });
    expect(await readFile(f.file("history.jsonl"), "utf8")).toContain('"reason":"overlap_successor_not_current"');
  } finally {
    release.resolve();
    await f.actor.stop();
    await f.clean();
  }
});

test.each([
  { terminal: "interrupted", actual: 5, required: 3, reason: "predecessor_did_not_complete" },
  { terminal: "completed", actual: 4, required: 3, reason: "predecessor_stock_not_confirmed" },
  { terminal: "completed", actual: 5, required: 6, reason: "Live stock or target does not support the proposed work policy." },
] as const)("A $terminal receipt with $actual live logs cannot unlock a stage requiring $required", async ({ terminal, actual, required, reason }) => {
  const log = "minecraft:oak_log";
  const f = await durableFixture(async request => workReply(request, { kind: "work-program", stages: [
    { policy: { target: { kind: "stock", item: log, count: 5 }, allowedEffects: ["break:minecraft:oak_log"],
      costCaps: [], reserves: [], maxBreaks: 6, maxCrafts: 0, maxPlacements: 0 }, requires: [] },
    { policy: { target: { kind: "stock", item: "minecraft:oak_planks", count: 8 }, allowedEffects: ["craft:oak_planks"],
      costCaps: [{ item: log, count: 2 }], reserves: [{ item: log, count: 1 }], maxBreaks: 0, maxCrafts: 2, maxPlacements: 0 },
      requires: [{ item: log, count: required }] },
  ] }), "Keep a log and make planks", 1);
  try {
    await f.observe(10);
    await f.actor.poll();
    const first = await f.order();
    expect(first.nextWorkId).toBeDefined();
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

test.each(["matching later witness", "camera receipt only"] as const)(
  "An inherited ceiling first view opens only the paid outlook and waits for %s", async condition => {
    const outlook = { id: "o-startup", verb: "survey", risk: "read", summary: "Frame the outlook ahead",
      evidence: "The current first-person view points almost straight up at nearby lit cover. Look forward from the same stance; no movement or contact is authorized." } as const;
    const resumed = { ...wallState, goal: "nether_portal" };
    const requests: MacroRequest[] = [];
    const quote = Promise.withResolvers<void>();
    const f = await durableFixture(async request => {
      requests.push(request);
      await quote.promise;
      return workReply(request, { kind: "work", policy: wallPolicy, openingViewId: outlook.id });
    }, "Find a diamond with the carried iron pickaxe and protect the existing raw iron.", 3);
    try {
      // Native has entered play but has no first usable render to publish yet.
      await f.actor.poll();
      expect(requests).toHaveLength(0);
      await f.observe(6, { ...resumed, opportunities: [outlook] });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ trigger: "first", observation: { tick: 6, opportunities: [outlook] },
        work: { demand: "first", openingViewIds: [outlook.id] } });
      await expect(access(f.file("intent.json"))).rejects.toThrow();
      await expect(access(f.file("work.json"))).rejects.toThrow();

      quote.resolve();
      await f.actor.poll();
      const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
      expect(intent).toMatchObject({ basisTick: 6, opportunityId: outlook.id, skillHash: null });
      await f.receipt(intent.id, 10, "accepted");
      await f.observe(16, resumed);
      await expect(access(f.file("work.json"))).rejects.toThrow();

      await f.receipt(intent.id, 22, "completed", "The first-person camera rendered the outlook ahead.");
      await f.observe(22, { ...resumed, prospectOpening: wall });
      await expect(access(f.file("work.json"))).rejects.toThrow();
      if (condition === "matching later witness") {
        await f.observe(27, { ...resumed, prospectOpening: wall });
        const order = await f.order();
        expect(order).toMatchObject({ basisTick: 27, origin: "model", reserves: wallPolicy.reserves });
        expect(new Set(order.allowedEffects)).toEqual(new Set(wallPolicy.allowedEffects));
      } else {
        await f.observe(27, resumed);
        await f.observe(182, { ...resumed, opportunities: [caveSurvey] });
        await expect(access(f.file("work.json"))).rejects.toThrow();
      }
      expect(requests).toHaveLength(1);
      expect(f.actor.status()).toMatchObject({ issued: 1, completedReceipts: 0, completedModelWorkOrders: 0 });
      await expect(access(f.file("intent.json"))).rejects.toThrow();
    } finally {
      quote.resolve();
      await f.actor.stop();
      await f.clean();
    }
  },
);

test("A first standalone fixed survey wakes constrained planning only for newly visible physical work", async () => {
  const requests: MacroRequest[] = [];
  const quote = Promise.withResolvers<void>();
  const f = await durableFixture(async request => {
    requests.push(request);
    await quote.promise;
    return workReply(request, requests.length === 1 ? { kind: "opportunity", opportunityId: caveSurvey.id } : { kind: "abstain" });
  }, "Look for a dry entrance to quarry for diamond.", 3);
  try {
    await f.observe(6, { ...wallState, opportunities: [caveSurvey] });
    expect(requests).toHaveLength(1);
    quote.resolve();
    await f.actor.poll();
    const intent = parseMacroIntent(JSON.parse(await readFile(f.file("intent.json"), "utf8")));
    await f.receipt(intent.id, 10, "accepted");
    await f.receipt(intent.id, 22, "completed", "The first-person camera rendered the requested survey angle.");
    await f.observe(91, { ...wallState, opportunities: [{ ...caveSurvey, id: "right", summary: "Survey right" }] });
    expect(requests).toHaveLength(1);
    expect(await readFile(f.file("history.jsonl"), "utf8")).toContain('"event":"survey_awaiting_witness"');
    await expect(access(f.file("work.json"))).rejects.toThrow();
    const station = { id: "furnace", verb: "interact", risk: "guarded", summary: "Open the visible furnace",
      evidence: "A lit station face is inside vanilla use reach." } as const;
    await f.observe(96, { ...wallState, opportunities: [station] });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ observation: { tick: 96, opportunities: [station] },
      lastReceipt: { id: intent.id, status: "completed" } });
  } finally {
    quote.resolve();
    await f.actor.stop();
    await f.clean();
  }
});
