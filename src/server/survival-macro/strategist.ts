import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Context, Tool } from "@oh-my-pi/pi-ai";
import type { ProviderPendingSpan } from "../../../survival-agent/pause-evidence.ts";
import { survivalModelIdentity, type SurvivalModelSelection } from "../../shared/survival-agent-ui.ts";
import { osMonotonicNs } from "../os-monotonic.ts";

const REQUEST_TIMEOUT_MS = 40_000;
const POLL_MS = 350;
const MIN_COOLDOWN_MS = 6_000;
const DISCOVERY_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = `You are the asynchronous macro strategist for an autonomous Minecraft Survival player.
The local player handles continuous 3D A* pathfinding, smooth human-like movement and camera control, crafting/furnace GUI clicks, auto-eating, lava/drowning escape, and real-time combat reflexes. It NEVER pauses while you think.

Your job is high-level macro strategy: inspect the live JSON state (goal, vitals, position, inventory, active/queued tasks, recent outcomes, visible environment, and any available ore targets) and submit a crisp ordered queue of 1 to 5 macro tasks via submit_survival_plan.

Available task kinds:
- gather_wood: chop trees & pick up logs. target="logs", count=desired total logs (e.g. 4..8).
- mine_stone: mine stone/cobblestone (digs down through soil if needed). target="stone", count=desired total cobblestone (e.g. 14..20).
- mine_ore: navigate/dig safely to mine coal, iron, or diamond ore. target="coal"|"iron"|"diamond", count=desired total drops (e.g. coal=6, iron=4, diamond=3). Optional x,y,z to pick a specific listed ore coordinate.
- craft: craft an item (automatically crafts missing planks/sticks/crafting_table and places/uses a crafting table for 3x3 recipes!). target=recipe name ("crafting_table", "wooden_pickaxe", "stone_pickaxe", "stone_sword", "furnace", "torch", "iron_pickaxe", "iron_sword", "bucket", "shield", "diamond_pickaxe"), count=desired total count.
- smelt: place/use furnace to smelt raw_iron into iron_ingot or raw_meat into cooked meat. target="raw_iron"|"raw_meat", count=desired total cooked/smelted items.
- gather_food: harvest visible berries or hunt visible food animals. target="food", count=desired food count (e.g. 4).
- dig_down: dig a safe navigable staircase down to a target Y level (count=targetY, e.g. 16 for iron or -54 for diamonds).
- explore: explore terrain to find trees, stone, caves, or food animals. target="explore", count=20.
- navigate: 3D A* navigate to x,y,z within count blocks.
- collect_drops: pick up nearby dropped items.

Strategic rules:
1. Respect Minecraft's tech tree: wood -> crafting_table + wooden_pickaxe -> cobblestone -> stone_pickaxe + furnace (+ stone_sword for safety!) -> coal/torches + iron_ore -> smelt raw_iron -> iron_pickaxe -> diamond_ore (3 diamonds) -> diamond_pickaxe.
2. Keep wood/sticks in reserve AND a spare stone_pickaxe before descending deep underground (so iron_pickaxe durability is conserved for ores/diamonds instead of breaking on stone/deepslate, and diamond_pickaxe can be crafted underground!).
3. Choose excavationMode="safe_staircase" when health < 14, near lava, or descending deep; "fast" only when healthy and clear.
4. Before descending deep underground, if visibleFoodAnimals > 0 or visibleBerries > 0 and no food is carried, consider a quick gather_food so you can heal from cave damage. Also prioritize gather_food (or smelt raw_meat) whenever health < 12 or food <= 10.
5. During long smelts (activeFurnace present), the local player automatically mines nearby ore/stone or chops nearby wood when safe and returns before smelting finishes — do not interrupt an active smelt unless urgent.
6. Do not repeat a failed task unchanged — adapt (e.g., craft missing prerequisite, pick another ore coordinate, gather fuel, or explore).
7. Queue 2-4 coherent sequential steps ahead so the player transitions smoothly with zero pauses!`;

const TASK_KINDS = [
  "gather_wood", "mine_stone", "mine_ore", "craft", "smelt",
  "gather_food", "dig_down", "explore", "navigate", "collect_drops",
] as const;

const PLAN_TOOL: Tool = {
  name: "submit_survival_plan",
  description: "Submit an ordered macro task queue (1-5 tasks) and excavation safety preference for the local Survival player.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["rationale", "replaceQueue", "excavationMode", "tasks"],
    properties: {
      rationale: { type: "string", description: "Concise 1-2 sentence explanation of the macro plan." },
      replaceQueue: { type: "boolean", description: "True to replace queued tasks now; false to append smoothly." },
      excavationMode: { type: "string", enum: ["safe_staircase", "fast"] },
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "target", "count", "x", "y", "z"],
          properties: {
            kind: { type: "string", enum: [...TASK_KINDS] },
            target: { type: "string" },
            count: { type: "integer" },
            x: { anyOf: [{ type: "integer" }, { type: "null" }] },
            y: { anyOf: [{ type: "integer" }, { type: "null" }] },
            z: { anyOf: [{ type: "integer" }, { type: "null" }] },
          },
        },
      },
    },
  },
};

export interface StrategistOptions {
  readonly model: SurvivalModelSelection;
  readonly dir: string;
  readonly goal: string;
  readonly objective: string;
  readonly authDirectory: string;
  readonly signal: AbortSignal;
  readonly maxRequests: number;
  readonly maxRuntimeMs: number;
  readonly assertDisplay: () => void;
}

interface LiveState {
  v: number;
  run: string;
  life: number;
  tick: number;
  goal: string;
  health: number;
  food: number;
  y: number;
  status: string;
  inventory: Record<string, number>;
  activeTask?: { id: string; kind: string; target: string; count: number; source: string };
  queuedTasks: { id: string; kind: string; target: string; count: number; source: string }[];
  recentReceipts: { id: string; kind: string; target: string; outcome: string; detail: string; tick: number }[];
  appliedPlan?: { planId: string; tick: number };
}

interface ParsedPlan {
  rationale: string;
  replaceQueue: boolean;
  excavationMode: "safe_staircase" | "fast";
  tasks: { kind: string; target: string; count: number; x: number | null; y: number | null; z: number | null }[];
}

function parsePlanArgs(raw: string): ParsedPlan | null {
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || typeof o.rationale !== "string" || typeof o.replaceQueue !== "boolean") return null;
    if (o.excavationMode !== "safe_staircase" && o.excavationMode !== "fast") return null;
    if (!Array.isArray(o.tasks) || o.tasks.length < 1 || o.tasks.length > 5) return null;
    const tasks = [];
    for (const t of o.tasks) {
      if (!t || typeof t !== "object" || !TASK_KINDS.includes(t.kind) || typeof t.target !== "string"
          || !Number.isSafeInteger(t.count)) return null;
      const coord = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v)) ? v : undefined;
      const x = coord(t.x), y = coord(t.y), z = coord(t.z);
      if (x === undefined || y === undefined || z === undefined) return null;
      tasks.push({ kind: t.kind, target: t.target, count: t.count, x, y, z });
    }
    return { rationale: o.rationale.slice(0, 400), replaceQueue: o.replaceQueue, excavationMode: o.excavationMode, tasks };
  } catch {
    return null;
  }
}

async function openAuthSession(options: StrategistOptions) {
  survivalModelIdentity(options.model);
  if (!isAbsolute(options.authDirectory)) throw new Error("Expected absolute authDirectory.");
  const authDir = join(options.authDirectory, "auth");
  const [folder, file] = await Promise.all([lstat(authDir), lstat(join(authDir, "gameharness.sqlite"))]);
  if (!folder.isDirectory() || !file.isFile()) throw new Error("Missing GameHarness private auth store.");

  const { AuthManager } = await import("../auth.ts");
  let changed = () => {};
  const auth = await AuthManager.create(options.authDirectory, () => changed(), { singleInferenceDispatch: true });
  const ready = Promise.withResolvers<boolean>();
  const onAbort = () => ready.resolve(false);
  const timer = setTimeout(onAbort, DISCOVERY_TIMEOUT_MS);
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    changed = () => {
      const snap = auth.snapshot();
      if (snap.status === "ready") {
        ready.resolve(snap.authenticated && snap.provider === options.model.provider
          && snap.models.some(m => m.id === options.model.modelId && m.provider === options.model.provider));
      } else if (snap.status !== "discovering") {
        ready.resolve(false);
      }
    };
    if (options.signal.aborted) onAbort();
    else changed();
    if (!(await ready.promise) || options.signal.aborted) {
      throw new Error(`Model ${survivalModelIdentity(options.model)} not discovered in GameHarness auth.`);
    }
    let inflight: Promise<unknown> | undefined;
    const session = auth.createInferenceSession({
      modelId: options.model.modelId,
      consumer: {
        revoke: () => {},
        drain: async () => { await inflight?.catch(() => {}); },
      },
    });
    return {
      auth,
      session,
      track<T>(p: Promise<T>): Promise<T> {
        inflight = p;
        return p.finally(() => { inflight = undefined; });
      },
      async close() {
        await auth.close();
      },
    };
  } catch (err) {
    await auth.close().catch(() => {});
    throw err;
  } finally {
    changed = () => {};
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
  }
}

export function composeMacroStrategist(options: StrategistOptions) {
  const runId = basename(options.dir);
  const stratDir = join(options.dir, "strategist");
  const statePath = join(stratDir, "state.json");
  const planPath = join(stratDir, "plan.json");
  const eventsPath = join(stratDir, "events.jsonl");
  const modelName = survivalModelIdentity(options.model);

  const declaration = {
    strategy: "model" as const,
    model: modelName,
    selection: { ...options.model },
    control: "local" as const,
    mode: "async-macro-task-queue" as const,
    task: options.objective || null,
    limits: {
      maxRequests: options.maxRequests,
      maxRuntimeMs: options.maxRuntimeMs,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
  };

  let admission: "not_opened" | "admitted" | "unavailable" = "not_opened";
  let drain: "not_started" | "running" | "closed" | "failed" = "not_started";
  let requests = 0;
  let plansPublished = 0;
  let plansApplied = 0;
  let providerErrors = 0;
  let lastPlanId = "";
  let lastTriggerKey = "";
  let lastRequestAt = 0;
  let loopTask: Promise<void> | undefined;
  let authHandle: Awaited<ReturnType<typeof openAuthSession>> | undefined;
  let stopped = false;
  const spans: ProviderPendingSpan[] = [];

  const logEvent = (event: string, fields: Record<string, unknown> = {}) =>
    appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 }).catch(() => {});

  async function readState(): Promise<LiveState | null> {
    try {
      const raw = await readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as LiveState;
      if (parsed?.v !== 2 || parsed.run !== runId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function computeTriggerKey(st: LiveState): string {
    const lastReceipt = st.recentReceipts.at(-1);
    const inv = st.inventory;
    const tier = (inv.diamond_pickaxe ? 4 : inv.iron_pickaxe ? 3 : inv.stone_pickaxe ? 2 : inv.wooden_pickaxe ? 1 : 0);
    const iron = (inv.raw_iron ?? 0) + (inv.iron_ingot ?? 0);
    const diamonds = inv.diamond ?? 0;
    const lowHp = st.health < 12 ? 1 : 0;
    return JSON.stringify([
      st.life,
      tier,
      iron >= 3 ? 3 : iron,
      diamonds >= 3 ? 3 : diamonds,
      lowHp,
      st.queuedTasks.length === 0 ? "empty" : "queued",
      lastReceipt ? `${lastReceipt.id}:${lastReceipt.outcome}` : "none",
    ]);
  }

  async function callModel(st: LiveState): Promise<void> {
    if (!authHandle || options.signal.aborted || stopped) return;
    const { session } = authHandle;
    if (!session.streamFn) return;
    options.assertDisplay();

    const startedNs = osMonotonicNs();
    const startedMs = performance.now();
    const reqAbort = new AbortController();
    const timer = setTimeout(() => reqAbort.abort(), REQUEST_TIMEOUT_MS);
    const reqSignal = AbortSignal.any([options.signal, session.signal, reqAbort.signal]);
    requests++;

    const userText = options.objective
      ? `Objective: ${options.objective}\nLive state:\n${JSON.stringify(st)}`
      : `Live state:\n${JSON.stringify(st)}`;

    const context: Context = {
      systemPrompt: [SYSTEM_PROMPT],
      messages: [{ role: "user", content: userText, timestamp: Date.now() }],
      tools: [PLAN_TOOL],
    };

    try {
      let toolArgs = "";
      const stream = await authHandle.track(Promise.resolve(session.streamFn(session.model, context, {
        apiKey: session.getApiKey(session.model),
        sessionId: session.sessionId,
        signal: reqSignal,
        reasoning: session.thinkingLevel,
        hideThinkingSummary: true,
        toolChoice: "required",
        cacheRetention: "none",
      })));
      for await (const _ev of stream) {
        // drain streaming events
      }
      const msg = await stream.result();
      const finishedNs = osMonotonicNs();
      spans.push({ startNs: startedNs, endNs: finishedNs, terminalObserved: true });

      const calls = msg.content.filter(b => b.type === "toolCall");
      if (calls.length >= 1 && calls[0]?.name === PLAN_TOOL.name) {
        const rawArgs = typeof calls[0].arguments === "string"
          ? calls[0].arguments
          : JSON.stringify(calls[0].arguments ?? {});
        toolArgs = rawArgs;
      }
      const parsed = toolArgs ? parsePlanArgs(toolArgs) : null;
      if (!parsed) {
        providerErrors++;
        await logEvent("plan_invalid", { latencyMs: Math.round(performance.now() - startedMs), stopReason: msg.stopReason });
        return;
      }

      const planId = randomUUID();
      const wire = {
        v: 2,
        run: runId,
        planId,
        basisTick: st.tick,
        rationale: parsed.rationale,
        replaceQueue: parsed.replaceQueue,
        excavationMode: parsed.excavationMode,
        tasks: parsed.tasks,
      };
      const tmp = join(stratDir, `.plan-${planId}.tmp`);
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(wire) + "\n");
      } finally {
        await handle.close();
      }
      if (options.signal.aborted || stopped) {
        await unlink(tmp).catch(() => {});
        return;
      }
      await rename(tmp, planPath);
      lastPlanId = planId;
      plansPublished++;
      await logEvent("plan_published", {
        planId,
        basisTick: st.tick,
        latencyMs: Math.round(performance.now() - startedMs),
        rationale: parsed.rationale,
        excavationMode: parsed.excavationMode,
        tasks: parsed.tasks,
      });
    } catch (err) {
      const finishedNs = osMonotonicNs();
      spans.push({ startNs: startedNs, endNs: finishedNs, terminalObserved: false });
      if (!reqSignal.aborted && !stopped) {
        providerErrors++;
        await logEvent("provider_error", {
          latencyMs: Math.round(performance.now() - startedMs),
          category: err instanceof Error ? err.name : "unknown",
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function loop() {
    let seenApplied = "";
    try {
      authHandle = await openAuthSession(options);
      admission = "admitted";
      await logEvent("strategist_admitted", { model: modelName });
    } catch (err) {
      admission = "unavailable";
      await logEvent("strategist_unavailable", { reason: err instanceof Error ? err.message : "unknown" });
      return;
    }

    while (!options.signal.aborted && !stopped) {
      const st = await readState();
      if (st) {
        if (st.appliedPlan && st.appliedPlan.planId && st.appliedPlan.planId !== seenApplied) {
          seenApplied = st.appliedPlan.planId;
          plansApplied++;
          await logEvent("plan_applied", { planId: seenApplied, tick: st.appliedPlan.tick });
        }

        const key = computeTriggerKey(st);
        const now = Date.now();
        const queueLow = st.queuedTasks.length <= 1;
        const lastFailed = st.recentReceipts.at(-1)?.outcome === "failed";
        const urgent = st.health < 12 || lastFailed;
        const shouldCall = requests < options.maxRequests
          && now - lastRequestAt >= (urgent ? MIN_COOLDOWN_MS : 12_000)
          && (requests === 0 || (queueLow && key !== lastTriggerKey) || (urgent && key !== lastTriggerKey)
              || (st.queuedTasks.length === 0 && now - lastRequestAt >= 25_000));

        if (shouldCall) {
          lastTriggerKey = key;
          lastRequestAt = now;
          await callModel(st);
        }
      }
      await delay(POLL_MS, undefined, { signal: options.signal }).catch(() => {});
    }
  }

  return {
    declaration,
    async start() {
      await mkdir(stratDir, { recursive: true, mode: 0o700 });
      drain = "running";
      loopTask = loop().catch(() => {});
    },
    async stop() {
      stopped = true;
      try {
        await loopTask;
        const finalState = await readState();
        if (finalState?.appliedPlan?.planId === lastPlanId && lastPlanId && plansApplied < plansPublished) {
          plansApplied++;
        }
        await authHandle?.close();
        drain = "closed";
      } catch {
        drain = "failed";
        throw new Error("Macro strategist did not drain cleanly.");
      }
    },
    providerTimeline(): ProviderPendingSpan[] {
      return [...spans];
    },
    outcome() {
      const outcome = admission === "unavailable" ? "provider_unavailable"
        : plansApplied > 0 ? "strategy_applied"
        : "no_advice_applied";
      return {
        ...declaration,
        admission,
        drain,
        outcome,
        requests,
        plansPublished,
        plansApplied,
        providerErrors,
      };
    },
  };
}
