import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderPendingSpan } from "../../../survival-agent/pause-evidence.ts";
import { SURVIVAL_AGENT_GOALS, TERRA_MODEL_ID } from "../../shared/survival-agent-ui.ts";
import { validateMacroId, type MacroInference } from "./protocol.ts";
import { openTerraExpeditionAdvisor, TerraOwnerDrainError, type TerraExpeditionDecision } from "./terra.ts";

const REQUEST_TIMEOUT_MS = 35_000;
const MAX_STATE_AGE_MS = 5_000;
const POLL_MS = 250;
const COOLDOWN_MS = 8_000;
const ADVICE_TICKS = 900;
const MAX_STATE_BYTES = 16 * 1024;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const ITEM = /^minecraft:[a-z0-9_]{1,96}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ExpeditionOptions {
  readonly dir: string;
  readonly goal: string;
  readonly objective: string;
  readonly authDirectory: string;
  readonly signal: AbortSignal;
  readonly maxRequests: number;
  readonly maxRuntimeMs: number;
  readonly assertDisplay: () => void;
}

type VisibleState = Omit<TerraExpeditionDecision["view"], "objective">;
type ProviderMoment = Parameters<TerraExpeditionDecision["onProviderDispatch"]>[0];
interface Basis {
  readonly run: string;
  readonly life: number;
  readonly goal: string;
  readonly tick: number;
  readonly need: string;
}
interface Receipt {
  readonly id: string;
  readonly option: string;
  readonly tick: number;
}
interface ExpeditionState extends VisibleState {
  readonly run: string;
  readonly life: number;
  readonly tick: number;
  readonly applied?: Receipt;
}
interface Publication {
  readonly state: ExpeditionState;
  readonly mtimeMs: number;
}
interface Advice {
  readonly v: 1;
  readonly run: string;
  readonly life: number;
  readonly goal: string;
  readonly id: string;
  readonly basisTick: number;
  readonly expiresTick: number;
  readonly need: string;
  readonly option: string;
}
interface SentAdvice {
  readonly wire: Advice;
  readonly expiresAt: number;
  applied: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function text(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= maxBytes && !/[\x00-\x1f\x7f]/.test(value);
}

function parseState(value: unknown, run: string, goal: string): ExpeditionState | undefined {
  const state = object(value);
  if (!state || state.v !== 1 || state.run !== run || state.goal !== goal || !count(state.life) ||
      !count(state.tick, Number.MAX_SAFE_INTEGER - ADVICE_TICKS) || typeof state.need !== "string" || !ID.test(state.need) ||
      typeof state.health !== "number" || !Number.isFinite(state.health) || state.health < 0 || state.health > 2048 ||
      !count(state.food, 20) || !text(state.activity, 512) ||
      !Array.isArray(state.options) || state.options.length > 8) return;
  const items = object(state.inventory);
  if (!items || Object.keys(items).length > 128) return;
  const inventory: Record<string, number> = Object.create(null);
  for (const [item, amount] of Object.entries(items)) {
    if (ITEM.test(item) && count(amount, 65_535) && amount > 0) inventory[item] = amount;
  }
  const options: { id: string; summary: string }[] = [];
  for (const value of state.options) {
    const offer = object(value);
    if (!offer || typeof offer.id !== "string" || !ID.test(offer.id) || offer.id === "abstain" ||
        !text(offer.summary, 512) || !offer.summary.trim() || options.some(({ id }) => id === offer.id)) return;
    options.push({ id: offer.id, summary: offer.summary });
  }
  const receipt = object(state.applied);
  const applied = receipt && typeof receipt.id === "string" && UUID.test(receipt.id) &&
    typeof receipt.option === "string" && ID.test(receipt.option) && count(receipt.tick, state.tick)
    ? { id: receipt.id, option: receipt.option, tick: receipt.tick } : undefined;
  return { run, goal, life: state.life, tick: state.tick, need: state.need,
    inventory, options, health: state.health, food: state.food, activity: state.activity, applied };
}

async function readState(file: string, run: string, goal: string): Promise<Publication | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  try {
    const info = await handle.stat();
    const uid = process.getuid?.();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || (uid !== undefined && info.uid !== uid) ||
        info.size < 2 || info.size > MAX_STATE_BYTES) return;
    const bytes = Buffer.allocUnsafe(info.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) return;
    let value;
    try { value = JSON.parse(bytes.toString("utf8", 0, bytesRead)); } catch { return; }
    const state = parseState(value, run, goal);
    return state ? { state, mtimeMs: info.mtimeMs } : undefined;
  } finally {
    await handle.close();
  }
}

function actionable(publication: Publication | undefined): publication is Publication {
  if (!publication) return false;
  const { state, mtimeMs } = publication;
  const age = Date.now() - mtimeMs;
  return age >= -1_000 && age <= MAX_STATE_AGE_MS && state.health > 0 && state.need !== "none" && state.options.length >= 2;
}

function decisionKey(state: ExpeditionState) {
  const offers = state.options.slice().sort((a, b) => a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
  // Changing a stack count by one should not usually trigger another request.
  const material = Object.keys(state.inventory).sort().map(item => [item, Math.floor(Math.log2(state.inventory[item]!))]);
  return JSON.stringify([state.life, state.need, offers, material]);
}

function sameNeed(state: ExpeditionState, basis: Basis) {
  return state.run === basis.run && state.life === basis.life && state.goal === basis.goal && state.need === basis.need &&
    state.tick >= basis.tick && state.tick <= basis.tick + ADVICE_TICKS;
}

async function publishAdvice(directory: string, advice: Advice, signal: AbortSignal) {
  const temporary = join(directory, `.advice-${advice.id}`);
  const writer = await open(temporary, "wx", 0o600);
  try {
    try { await writer.writeFile(JSON.stringify(advice)); }
    finally { await writer.close(); }
    if (signal.aborted) return false;
    await rename(temporary, join(directory, "advice.json"));
    return true;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

function timing(moment: ProviderMoment) {
  return { monotonicMs: moment.monotonicMs, wallMs: moment.wallMs, osNs: moment.osNs.toString() };
}

/** Ordinary native play never waits for this optional, one-request-at-a-time advisor. */
export function composeExpeditionAdvisor(options: ExpeditionOptions) {
  const { dir, goal, authDirectory, maxRequests, maxRuntimeMs, assertDisplay } = options;
  const run = validateMacroId(basename(dir), "Expedition run");
  const objective = options.objective.trim();
  if (!(SURVIVAL_AGENT_GOALS as readonly string[]).includes(goal) || !count(maxRequests) ||
      !count(maxRuntimeMs, 2_147_483_647) || maxRuntimeMs === 0 || Buffer.byteLength(objective) > 8_192 ||
      /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(objective))
    throw new Error("Invalid expedition goal, objective, or advisory limits.");
  const declaration = {
    strategy: "terra", model: TERRA_MODEL_ID, control: "local", mode: "expedition_advisory", authoring: null,
    task: objective || null, input: "visible_state_text",
    limits: { maxRequests, maxRuntimeMs, requestTimeoutMs: REQUEST_TIMEOUT_MS, cooldownMs: COOLDOWN_MS },
  } as const;
  const directory = join(dir, "expedition");
  const stateFile = join(directory, "state.json");
  const end = new AbortController();
  const runtime = new AbortController();
  const signal = AbortSignal.any([options.signal, end.signal]);
  const authority = AbortSignal.any([signal, runtime.signal]);
  const spans: ProviderPendingSpan[] = [];
  const attemptedKeys = new Set<string>();
  const published = new Map<string, SentAdvice>();
  let pending: SentAdvice | undefined;
  let journal: FileHandle | undefined;
  let journalTail = Promise.resolve(true);
  let startup: Promise<void> | undefined;
  let worker: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;
  let admission: "not_opened" | "admitted" | "unavailable" = "not_opened";
  let drain: "not_started" | "closed" | "failed" = "not_started";
  let lastProviderOutcome: MacroInference["outcome"] | undefined;
  let budget: "requests" | "time" | null = null;
  let displayLost = false;
  let authLost = false;
  let protocolFault = false;
  let cleanupFailed = false;
  let timingIncomplete = false;
  let attempts = 0;
  let providerDispatches = 0;
  let providerSettlements = 0;
  let applied = 0;
  let lastAttemptAt = -Infinity;

  function log(event: string, fields: object = {}) {
    if (!journal) return Promise.resolve(false);
    const writer = journal;
    const line = `${JSON.stringify({ v: 1, run, event, wallMs: Date.now(), ...fields })}\n`;
    journalTail = journalTail.then(async ok => {
      if (!ok) return false;
      try {
        await writer.appendFile(line);
        if (event === "applied") await writer.sync();
        return true;
      } catch {
        protocolFault = true;
        end.abort();
        return false;
      }
    });
    return journalTail;
  }

  async function acknowledge(state: ExpeditionState | undefined) {
    const receipt = state?.applied;
    if (!state || !receipt) return;
    const sent = published.get(receipt.id);
    if (!sent || sent.applied) return;
    const { wire } = sent;
    if (state.run !== wire.run || state.goal !== wire.goal || state.life !== wire.life ||
        receipt.option !== wire.option || receipt.tick < wire.basisTick || receipt.tick > wire.expiresTick) return;
    if (!await log("applied", { advice: wire, receipt, observedTick: state.tick })) return;
    sent.applied = true;
    applied++;
    if (pending === sent) pending = undefined;
  }

  function checkDisplay() {
    try {
      assertDisplay();
      return true;
    } catch {
      if (!signal.aborted) displayLost = true;
      return false;
    }
  }

  type Provider = Awaited<ReturnType<typeof openTerraExpeditionAdvisor>>;
  async function ask(provider: Provider, state: ExpeditionState, key: string) {
    const { life, tick, need, inventory, options, health, food, activity } = state;
    const basis: Basis = { run, goal, life, tick, need };
    const expiresAt = performance.now() + ADVICE_TICKS * 50;
    const attempt = ++attempts;
    lastAttemptAt = performance.now();
    attemptedKeys.add(key);
    const view = { goal, ...(objective ? { objective } : {}), need, options, inventory, health, food, activity };
    if (!await log("decision", { attempt, basis, view })) return;
    let span: number | undefined;
    const result = await provider.choose({
      view,
      async assertDispatch() {
        const current = await readState(stateFile, run, goal).catch(() => {
          protocolFault = true;
          return undefined;
        });
        return !authority.aborted && actionable(current) && performance.now() <= expiresAt &&
          sameNeed(current.state, basis) && decisionKey(current.state) === key && checkDisplay();
      },
      onProviderDispatch(moment) {
        providerDispatches++;
        span = spans.length;
        spans.push({ startNs: moment.osNs, endNs: null, terminalObserved: false, stage: "live_observation" });
        void log("dispatch", { attempt, basis, timing: timing(moment) });
      },
      onProviderSettled(moment) {
        const start = span === undefined ? undefined : spans[span];
        if (!start || span === undefined) {
          timingIncomplete = true;
          return;
        }
        const terminal = moment.providerTerminalOsNs;
        spans[span] = { ...start, endNs: terminal ?? moment.osNs, terminalObserved: terminal !== undefined };
        void log("settlement", { attempt, timing: timing(moment), terminalOsNs: terminal?.toString(),
          providerTerminalWallMs: moment.providerTerminalWallMs, providerTerminalMonotonicMs: moment.providerTerminalMonotonicMs });
      },
    });
    if (result.dispatched) {
      providerSettlements++;
      if (span === undefined) {
        providerDispatches++;
        timingIncomplete = true;
      }
    }
    lastProviderOutcome = result.outcome;
    const proposal = result.proposal;
    let disposition: string = result.outcome;
    let advice: Advice | undefined;
    if (proposal?.option === null) disposition = "abstained";
    else if (proposal) {
      const current = authority.aborted ? undefined : await readState(stateFile, run, goal);
      const option = options.find(({ id }) => id === proposal.option);
      if (option && actionable(current) && performance.now() <= expiresAt && sameNeed(current.state, basis) &&
          current.state.options.some(({ id, summary }) => id === option.id && summary === option.summary) && checkDisplay()) {
        const wire = { v: 1, run, goal, life, id: randomUUID(), basisTick: tick, expiresTick: tick + ADVICE_TICKS,
          need, option: option.id } as const;
        if (await publishAdvice(directory, wire, authority)) {
          advice = wire;
          pending = { wire, expiresAt, applied: false };
          published.set(wire.id, pending);
        }
      }
      disposition = advice ? "published" : authority.aborted ? "cancelled" : "stale";
    }
    await log("disposition", { attempt, basis, result: result.outcome, dispatched: result.dispatched, usage: result.usage,
      latencyMs: result.latencyMs, proposal, disposition, advice,
      invalidReply: typeof result.invalidReply === "string" ? result.invalidReply : undefined });
    if (result.outcome === "provider_unavailable") authLost = true;
  }

  async function background() {
    let provider: Provider | undefined;
    const timer = setTimeout(() => { budget ??= "time"; runtime.abort(); }, maxRuntimeMs);
    async function closeProvider() {
      const owner = provider;
      provider = undefined;
      if (owner) await owner.close().catch(() => { throw new TerraOwnerDrainError("The expedition provider did not drain."); });
    }
    try {
      if (maxRequests === 0) {
        budget = "requests";
        return;
      }
      try {
        provider = await openTerraExpeditionAdvisor({
          strategy: "terra", authDirectory, runId: run, signal: authority, requestTimeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof TerraOwnerDrainError) throw error;
        if (!authority.aborted) admission = "unavailable";
        await log("admission", { admission, budget });
        return;
      }
      admission = "admitted";
      await log("admission", { admission });
      while (!signal.aborted) {
        if (provider?.authoritySignal.aborted && !authority.aborted) authLost = true;
        if (attempts >= maxRequests) budget ??= "requests";
        if (budget || authLost || displayLost || protocolFault) await closeProvider();
        const current = await readState(stateFile, run, goal);
        const state = current?.state;
        await acknowledge(state);
        const waiting = pending;
        if (waiting && (performance.now() > waiting.expiresAt || (state && (state.life !== waiting.wire.life ||
            state.tick > waiting.wire.expiresTick || state.need !== waiting.wire.need ||
            !state.options.some(({ id }) => id === waiting.wire.option))))) {
          pending = undefined;
          await log("advice_no_longer_current", { advice: waiting.wire });
        }
        if (!provider && !pending) break;
        if (provider && !pending && !authority.aborted && actionable(current) && performance.now() - lastAttemptAt >= COOLDOWN_MS) {
          const key = decisionKey(current.state);
          if (!attemptedKeys.has(key)) await ask(provider, current.state, key);
        }
        await delay(POLL_MS, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      }
    } catch (error) {
      if (error instanceof TerraOwnerDrainError) throw error;
      protocolFault = true;
      await log("protocol_fault");
    } finally {
      clearTimeout(timer);
      if (attempts >= maxRequests) budget ??= "requests";
      await closeProvider();
    }
  }

  async function initialize() {
    signal.throwIfAborted();
    await mkdir(directory, { mode: 0o700 });
    journal = await open(join(directory, "decisions.jsonl"), "wx", 0o600);
    await writeFile(join(directory, "active.json"), JSON.stringify({ v: 1, run }), { flag: "wx", mode: 0o600 });
    if (!signal.aborted) worker = background().catch(() => { cleanupFailed = true; });
  }

  async function close() {
    await startup?.catch(() => {});
    await worker;
    if (journal) {
      if (published.size > applied) {
        try { await acknowledge((await readState(stateFile, run, goal))?.state); }
        catch { protocolFault = true; }
      }
      await log(cleanupFailed ? "drain_failed" : "closed",
        { pending: pending?.wire.id, budget, providerDispatches, providerSettlements, applied });
      try { await journal.sync(); }
      finally { await journal.close(); }
      journal = undefined;
    }
    if (cleanupFailed) throw new TerraOwnerDrainError("The expedition provider did not drain.");
  }

  return {
    declaration,
    start: () => startup ??= initialize(),
    stop() {
      end.abort();
      return stopped ??= close().then(() => { drain = "closed"; }, error => { drain = "failed"; throw error; });
    },
    outcome() {
      const outcome = drain === "failed" || cleanupFailed ? "cleanup_failed" : applied > 0 ? "strategy_applied" :
        protocolFault ? "protocol_fault" : displayLost ? "display_lost" :
        admission === "unavailable" || authLost ? "provider_unavailable" : budget ? "budget_limited" :
        lastProviderOutcome === "refused" || lastProviderOutcome === "provider_error" ? lastProviderOutcome : "no_advice_applied";
      return { ...declaration, admission, drain, outcome,
        status: { requests: attempts, providerDispatches, providerSettlements, published: published.size, applied,
          budget, lastProviderOutcome } } as const;
    },
    providerTimeline: () => timingIncomplete || spans.some(({ endNs }) => endNs === null) ? undefined : spans.slice(),
  };
}
