import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  MACRO_CAPABILITIES_VERSION, MACRO_MAX_INTENT_TTL_TICKS, MACRO_MAX_PLAN_TTL_TICKS, MacroDirectory, parseMacroIntent, parseMacroObservation,
  parseMacroProposal, parseMacroReceipt, validateMacroId,
  type MacroBasis, type MacroFeedback, type MacroFrame, type MacroInference, type MacroIntent, type MacroObservation, type MacroOpportunity,
  type MacroProposal, type MacroReceipt, type MacroRequest, type MacroStrategist, type MacroTrigger, type NativeReceiptCursor,
} from "./protocol.ts";
import type { MacroSkillProposal, SurvivalMacroSkills } from "./skills.ts";

export interface MacroLimits {
  readonly maxRequests: number;
  readonly maxRuntimeMs: number;
  readonly requestTimeoutMs: number;
  readonly maxSkillCandidates: number;
  readonly skillTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxIntentTtlTicks: number;
  readonly maxPlanTtlTicks: number;
  readonly maxObservationAgeMs: number;
  readonly pollMs: number;
  readonly stuckAfterMs: number;
}

const DEFAULT_LIMITS: MacroLimits = {
  maxRequests: 8, maxRuntimeMs: 600_000, requestTimeoutMs: 35_000,
  maxSkillCandidates: 1, skillTimeoutMs: 240_000, maxResponseBytes: 16 * 1024,
  maxIntentTtlTicks: MACRO_MAX_INTENT_TTL_TICKS, maxPlanTtlTicks: MACRO_MAX_PLAN_TTL_TICKS,
  maxObservationAgeMs: 2_000, pollMs: 125, stuckAfterMs: 12_000,
};
const HARD_LIMITS: MacroLimits = {
  maxRequests: 128, maxRuntimeMs: 12 * 60 * 60 * 1_000, requestTimeoutMs: 120_000,
  maxSkillCandidates: 8, skillTimeoutMs: 900_000, maxResponseBytes: 16 * 1024,
  maxIntentTtlTicks: MACRO_MAX_INTENT_TTL_TICKS, maxPlanTtlTicks: MACRO_MAX_PLAN_TTL_TICKS,
  maxObservationAgeMs: 10_000, pollMs: 1_000, stuckAfterMs: 300_000,
};
const FEEDBACK: Readonly<Record<string, string>> = Object.freeze({
  native_capability_gap: "The previous proposal reported a missing capability. It applied no effect. Choose an observed alternative or abstain.",
  proposal_refused: "The previous proposal named an opportunity not witnessed on its basis. Choose only a current offered ID.",
  duplicate_intent_refused: "The same witnessed opportunity was already issued on this unchanged premise. Choose a different current observation or action.",
  skill_rejected: "The candidate did not pass trusted skill admission. It applied no ordinary effect. Try an offered alternative.",
  skill_abstained: "The selected skill did not return a currently admitted opportunity. No intent was issued.",
  skill_unavailable: "No independently tested skill is available for this request. Choose a currently offered primitive or abstain.",
  skill_promotion_refused: "The candidate did not pass the fresh promotion gate. It applied no ordinary effect.",
  skill_reverted: "A quarantined skill was withdrawn at a neutral handoff. This changed code selection, not the game world.",
  unproven_skill_effect_refused: "The selected skill returned an effect outside its in-game attestation. No intent was issued.",
});

type TrialResult =
  | { readonly status: "passed"; readonly detail: string; readonly verb: string }
  | { readonly status: "failed" | "abstained"; readonly detail: string };
export interface MacroTrialRunner {
  run(hash: string, skills: SurvivalMacroSkills, signal: AbortSignal): Promise<TrialResult>;
}

export interface SurvivalMacroConfig {
  readonly runDir: string;
  readonly run: string;
  readonly strategy: "deterministic" | "terra";
  readonly objective?: string;
  readonly strategist?: MacroStrategist;
  readonly skills?: SurvivalMacroSkills;
  readonly trial?: MacroTrialRunner;
  readonly limits?: Partial<MacroLimits>;
  readonly capabilitiesVersion?: string;
  readonly signal?: AbortSignal;
  /** Optional trusted display capture; no path, credential or ownership supplied to the model. */
  readonly frame?: (observation: MacroObservation, signal: AbortSignal, requestId: string) => Promise<MacroFrame | undefined>;
}

type MacroState = "new" | "deterministic" | "waiting" | "inferring" | "testing-skill" | "awaiting-handoff" |
  "executing" | "provider-unavailable" | "budget-limited" | "faulted" | "stopped";

export interface MacroStatus {
  readonly strategy: SurvivalMacroConfig["strategy"];
  readonly state: MacroState;
  readonly models: readonly string[];
  readonly capabilitiesVersion: string;
  readonly limits: MacroLimits;
  readonly elapsedMs: number;
  readonly requests: number;
  readonly providerDispatches: number;
  readonly unreportedDispatches: number;
  readonly skillCandidates: number;
  readonly staleDecisions: number;
  readonly issued: number;
  readonly terminalReceipts: number;
  readonly completedReceipts: number;
  readonly budget: "requests" | "wall-time" | null;
  readonly lastReceipt: MacroReceipt | null;
  readonly lastProviderOutcome: MacroInference["outcome"] | null;
  readonly lastDisposition: string | null;
}

interface View {
  readonly observation: MacroObservation;
  readonly changedAt: number;
  readonly evidence: string;
  readonly query: string;
}

interface Work<T> {
  readonly context: Decision;
  readonly cancel: AbortController;
  readonly startedAt: number;
  readonly until: number;
  readonly done: Promise<void>;
  result?: { readonly ok: true; readonly value: T; readonly settledAt: number } |
    { readonly ok: false; readonly detail: string; readonly settledAt: number; readonly preflight?: "stale" | "invalid" };
}

interface Decision {
  readonly requestId: string;
  readonly observation: MacroObservation;
  readonly generation: number | null;
}

class FrameRejected extends Error {
  constructor(readonly disposition: "stale" | "invalid", message: string) { super(message); }
}

interface Plan extends Decision {
  readonly proposal: MacroProposal;
}

interface SkillCheck {
  readonly hash: string;
  readonly shadow: MacroSkillProposal | null;
  readonly trial: TrialResult | null;
  readonly detail: string;
}

interface Selection {
  readonly generation: number;
  readonly hash: string;
  readonly basis: MacroObservation;
  readonly offer: MacroSkillProposal | null;
  readonly requiredOffer?: MacroOpportunity;
}

interface ProvenCandidate {
  readonly hash: string;
  readonly verb: string;
}

type Ready = { readonly plan: Plan } & (
  { readonly kind: "plan" } |
  { readonly kind: "candidate"; readonly candidate: ProvenCandidate } |
  { readonly kind: "promotion"; readonly candidate: ProvenCandidate; readonly offer: MacroOpportunity } |
  { readonly kind: "selection"; readonly selection: Selection }
);

interface Issued {
  readonly intent: MacroIntent;
  readonly scope: MacroObservation;
  accepted?: MacroReceipt;
  terminal?: MacroReceipt;
}

type Busy =
  | { readonly kind: "inference"; readonly work: Work<MacroInference> }
  | { readonly kind: "trial"; readonly work: Work<SkillCheck>; readonly plan: Plan }
  | { readonly kind: "shadow"; readonly work: Work<MacroOpportunity | undefined>; readonly plan: Plan; readonly candidate: ProvenCandidate }
  | { readonly kind: "selection"; readonly work: Work<Selection>; readonly plan: Plan };

function checkedLimits(supplied?: Partial<MacroLimits>): MacroLimits {
  const limits = { ...DEFAULT_LIMITS, ...supplied };
  for (const key of Object.keys(HARD_LIMITS) as (keyof MacroLimits)[]) {
    const minimum = key === "maxSkillCandidates" ? 0 : key === "pollMs" ? 20 : 1;
    if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > HARD_LIMITS[key]) {
      throw new Error(`Invalid survival macro limit: ${key}.`);
    }
  }
  if (limits.maxPlanTtlTicks < limits.maxIntentTtlTicks) throw new Error("A skill plan limit cannot be shorter than the native intent limit.");
  return Object.freeze(limits);
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : "Unexpected survival macro error.").slice(0, 512);
}

function scope(left: MacroObservation, right: MacroObservation): boolean {
  return left.run === right.run && left.life === right.life && left.epoch === right.epoch && left.goal === right.goal;
}

function basis(observation: MacroObservation): MacroBasis {
  const { run, life, tick, epoch } = observation;
  return { run, life, tick, epoch };
}

function sameBasis(left: MacroBasis | undefined, right: MacroBasis): boolean {
  return left?.run === right.run && left.life === right.life && left.tick === right.tick && left.epoch === right.epoch;
}

function sameOffer(left: MacroOpportunity | undefined, right: MacroOpportunity | undefined): left is MacroOpportunity {
  return !!left && !!right && left.id === right.id && left.verb === right.verb && left.summary === right.summary &&
    left.risk === right.risk && left.evidence === right.evidence;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function guardBand(value: number): number {
  return value <= 0 ? 0 : value <= 6 ? 1 : value <= 12 ? 2 : 3;
}

function evidenceKey(observation: MacroObservation): string {
  return digest([
    observation.life, observation.epoch, observation.goal, guardBand(observation.health), guardBand(observation.food),
    Object.entries(observation.inventory).sort(([a], [b]) => a.localeCompare(b)),
    [...observation.opportunities].sort((a, b) => a.id.localeCompare(b.id)),
    [...new Set(observation.recent)].sort(),
  ]);
}

function alive(observation: MacroObservation): boolean {
  return observation.health > 0;
}

function usageEvidence(value: MacroInference["usage"]): MacroInference["usage"] {
  if (!value) return null;
  const { input, output, cacheRead, cacheWrite, totalTokens } = value;
  return [input, output, cacheRead, cacheWrite, totalTokens].every(counter => Number.isSafeInteger(counter) && counter >= 0) ?
    { input, output, cacheRead, cacheWrite, totalTokens } : null;
}

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export class SurvivalMacroController {
  readonly directory: string;
  private readonly runDir: string;
  private readonly limits: MacroLimits;
  private readonly capabilitiesVersion: string;
  private readonly objective?: string;
  private ipc?: MacroDirectory;
  private history?: FileHandle;
  private historyTail: Promise<void> = Promise.resolve();
  private proposals?: FileHandle;
  private receipts?: FileHandle;
  private markerLive = false;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private closing = false;
  private stopped = false;
  private faulted = false;
  private unavailable = false;
  private startedAt?: number;
  private endedAt?: number;
  private observedAt = 0;
  private view?: View;
  private lastAsked?: View;
  private heldQuery?: string;
  private feedback?: { readonly observation: MacroObservation; readonly value: MacroFeedback };
  private lastReceipt: MacroReceipt | null = null;
  private lastProviderOutcome: MacroInference["outcome"] | null = null;
  private lastDisposition: string | null = null;
  private budget: MacroStatus["budget"] = null;
  private readonly models = new Set<string>();
  private requests = 0;
  private providerDispatches = 0;
  private unreportedDispatches = 0;
  private skillCandidates = 0;
  private staleDecisions = 0;
  private terminalReceipts = 0;
  private completedReceipts = 0;
  private publishedIntents = 0;
  private journal: NativeReceiptCursor | null = null;
  private latestReceiptFile?: MacroReceipt;
  private readonly issued = new Map<string, Issued>();
  private readonly effectKeys = new Set<string>();
  private readonly queryKeys = new Set<string>();
  private readonly testedSkillVerbs = new Map<string, string>();
  private handoffAfterTick = -1;
  private pending?: Issued;
  private busy?: Busy;
  private ready?: Ready;
  private stopListener = () => { void this.stop(); };

  constructor(private readonly config: SurvivalMacroConfig) {
    this.runDir = path.resolve(config.runDir);
    validateMacroId(config.run, "run");
    if (path.basename(this.runDir) !== config.run) throw new Error("Survival macro run ID does not match its private directory.");
    if (config.strategy !== "deterministic" && config.strategy !== "terra") throw new Error("Invalid survival strategy.");
    this.directory = path.join(this.runDir, "macro");
    this.limits = checkedLimits(config.limits);
    this.capabilitiesVersion = config.capabilitiesVersion ?? MACRO_CAPABILITIES_VERSION;
    if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(this.capabilitiesVersion)) throw new Error("Invalid survival macro capability version.");
    if (config.objective !== undefined) {
      const objective = config.objective.trim();
      if (config.strategy !== "terra" || !objective || objective.length > 2_048 || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(objective)) {
        throw new Error("Invalid survival macro task.");
      }
      this.objective = objective;
    }
  }

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Survival macro controller is closed."));
    return this.startPromise ??= this.initialize();
  }

  private async initialize(): Promise<void> {
    this.config.signal?.throwIfAborted();
    this.startedAt = performance.now();
    if (this.config.strategy === "deterministic") return;
    const info = await lstat(this.runDir);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 ||
        await realpath(this.runDir) !== this.runDir) {
      throw new Error("Survival macro run directory is not private and canonical.");
    }
    await mkdir(this.directory, { mode: 0o700 });
    try {
      this.ipc = await MacroDirectory.open(this.directory);
      this.history = await this.ipc.createLog("history.jsonl");
      this.proposals = await this.ipc.createLog("proposals.jsonl");
      this.receipts = await this.ipc.createLog("receipts.jsonl");
      this.unavailable = !this.config.strategist;
      await this.record("declared", {
        strategy: this.config.strategy, capabilitiesVersion: this.capabilitiesVersion, limits: this.limits,
        authoring: !!(this.config.skills && this.config.trial && this.limits.maxSkillCandidates), objective: this.objective ?? null,
        admittedSkillVerbs: this.config.skills?.allowedVerbs() ?? [],
      });
      if (this.unavailable) await this.disposition("provider_unavailable", { reason: "No admitted Terra strategist." });
      this.config.signal?.throwIfAborted();
      this.markerLive = true;
      await this.ipc.write("active.json", { v: 1, run: this.config.run });
      this.config.signal?.addEventListener("abort", this.stopListener, { once: true });
      if (this.config.signal?.aborted) this.stopListener();
      this.schedule();
    } catch (error) {
      await this.revoke().catch(() => {});
      await this.closeFiles();
      this.faulted = true;
      throw error;
    }
  }

  status(): MacroStatus {
    const state: MacroState = this.faulted ? "faulted" : this.stopped ? "stopped" :
      this.startedAt === undefined ? "new" : this.config.strategy === "deterministic" ? "deterministic" :
      this.pending ? "executing" : this.busy?.kind === "inference" ? "inferring" :
      this.busy?.kind === "trial" ? "testing-skill" : this.ready || this.busy ? "awaiting-handoff" :
      this.budget ? "budget-limited" : this.unavailable ? "provider-unavailable" : "waiting";
    return {
      strategy: this.config.strategy, state, capabilitiesVersion: this.capabilitiesVersion, limits: this.limits,
      models: [...this.models], elapsedMs: this.startedAt === undefined ? 0 : Math.round((this.endedAt ?? performance.now()) - this.startedAt),
      requests: this.requests, providerDispatches: this.providerDispatches, unreportedDispatches: this.unreportedDispatches,
      skillCandidates: this.skillCandidates, staleDecisions: this.staleDecisions, issued: this.publishedIntents,
      terminalReceipts: this.terminalReceipts, completedReceipts: this.completedReceipts,
      budget: this.budget, lastReceipt: this.lastReceipt, lastProviderOutcome: this.lastProviderOutcome, lastDisposition: this.lastDisposition,
    };
  }

  isNeutralHandoff(observation: MacroObservation): boolean {
    const now = performance.now();
    return this.markerLive && !this.closing && !this.faulted && !this.pending && this.view?.observation === observation &&
      observation.tick > this.handoffAfterTick && observation.quiescent && alive(observation) &&
      now - this.observedAt <= this.limits.maxObservationAgeMs && now - this.startedAt! < this.limits.maxRuntimeMs;
  }

  private schedule(): void {
    if (this.closing || this.faulted || !this.markerLive) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule());
    }, this.limits.pollMs);
    this.timer.unref?.();
  }

  /** One serialized file/decision pass. The provider and trial never block polling. */
  poll(): Promise<void> {
    if (this.closing || this.faulted || !this.markerLive) return Promise.resolve();
    return this.polling ??= this.step().catch(error => this.fail(error)).finally(() => { this.polling = undefined; });
  }

  private async step(): Promise<void> {
    const ipc = this.ipc!;
    const active = await ipc.read("active.json", value => value);
    if (!active || typeof active !== "object" || Object.keys(active).length !== 2 ||
        (active as { v?: unknown }).v !== 1 || (active as { run?: unknown }).run !== this.config.run) {
      throw new Error("Survival macro active marker was revoked or changed.");
    }
    await this.refresh();
    await this.readReceipts();
    if (this.closing) return;
    const mailbox = await ipc.read("intent.json", parseMacroIntent);
    if (mailbox ? !this.pending || digest(mailbox) !== digest(this.pending.intent) : !!this.pending) {
      throw new Error("Survival macro intent mailbox changed outside its owner.");
    }
    const now = performance.now();
    const view = this.view;
    const current = view && now - this.observedAt <= this.limits.maxObservationAgeMs ? view.observation : undefined;
    const runtimeExpired = now - this.startedAt! >= this.limits.maxRuntimeMs;

    if (this.pending && (runtimeExpired || !current || !scope(this.pending.scope, current) || !alive(current) ||
      current.tick > this.pending.intent.expiresTick)) {
      await this.withdraw(runtimeExpired ? "runtime_wall_limit" : "native_scope_or_ttl_changed");
    }
    if (this.busy && !this.busy.work.cancel.signal.aborted) {
      const work = this.busy.work;
      const stale = !current || !scope(work.context.observation, current) || !alive(current) ||
        (this.busy.kind !== "inference" && current.tick >= this.busy.plan.proposal.expiresTick);
      if (runtimeExpired || stale || (!work.result && now >= work.until)) {
        work.cancel.abort(new Error(runtimeExpired ? "runtime_wall_limit" : stale ? "stale_scope" : "work_timeout"));
        await this.record("work_cancelled", { requestId: work.context.requestId, kind: this.busy.kind,
          reason: describe(work.cancel.signal.reason) });
      }
    }
    if (this.busy?.work.result) await this.settle(current, runtimeExpired);
    if (runtimeExpired) {
      if (this.budget !== "wall-time") {
        this.budget = "wall-time";
        await this.disposition("budget_limited", { budget: this.budget });
      }
      this.discardReady("runtime-wall-limit");
      // Continue reading receipts and draining any actual provider settlement, but no longer issue.
      return;
    }
    if (current && !this.busy && this.isNeutralHandoff(current)) await this.restoreSelection(current);
    if (this.ready) await this.handoff(current);
    if (this.closing || this.pending || this.busy || this.ready || !current) return;
    if (this.requests >= this.limits.maxRequests) {
      if (!this.budget) {
        this.budget = "requests";
        await this.disposition("budget_limited", { budget: this.budget });
      }
      return;
    }
    if (!this.config.strategist || !alive(current) || (!current.quiescent && !current.opportunities.length)) return;
    const latest = this.view!;
    if (this.queryKeys.has(latest.query)) {
      if (this.heldQuery !== latest.query && latest.query === this.lastAsked?.query && now - latest.changedAt >= this.limits.stuckAfterMs) {
        this.heldQuery = latest.query;
        await this.record("replan_held", { basis: basis(current), reason: "No new native or admission evidence." });
      }
      return;
    }
    await this.begin(latest);
  }

  private async refresh(): Promise<void> {
    const observation = await this.ipc!.read("observation.json", parseMacroObservation);
    if (!observation) {
      if (this.view) throw new Error("Native survival macro observation disappeared.");
      return;
    }
    if (observation.run !== this.config.run) throw new Error("Native survival macro observation has a foreign run.");
    const before = this.view?.observation;
    if (before) {
      if (observation.tick < before.tick || observation.life < before.life || observation.epoch < before.epoch ||
          (!scope(observation, before) && observation.epoch === before.epoch)) {
        throw new Error("Native survival macro scope regressed or changed without an epoch.");
      }
      if (observation.tick === before.tick && observation.epoch === before.epoch) {
        if (digest(observation) !== digest(before)) throw new Error("Native survival macro changed a previously published tick.");
        return;
      }
    }
    const evidence = evidenceKey(observation);
    this.observedAt = performance.now();
    this.view = {
      observation, evidence, query: this.queryKey(observation, evidence),
      changedAt: this.view?.evidence === evidence ? this.view.changedAt : this.observedAt,
    };
  }

  private queryKey(observation: MacroObservation, evidence: string): string {
    const receipt = this.lastReceipt;
    const selection = this.config.skills?.selection();
    return digest([evidence, receipt?.life === observation.life ? [receipt.status, receipt.detail] : null,
      selection?.generation ?? null, this.currentFeedback(observation) ?? null]);
  }

  private currentFeedback(observation: MacroObservation): MacroFeedback | undefined {
    return this.feedback && scope(this.feedback.observation, observation) ? this.feedback.value : undefined;
  }

  private async readReceipts(): Promise<void> {
    const ipc = this.ipc!;
    const cap = (2 * this.limits.maxRequests + 2) * 4_097;
    let batch = await ipc.readNativeReceiptLines(this.journal, cap);
    const fallback = batch ? null : await ipc.read("receipt.json", parseMacroReceipt);
    // Native publishes the append-only receipt before the corresponding latest file.
    if (fallback) batch = await ipc.readNativeReceiptLines(this.journal, cap);
    if (batch) {
      this.journal = batch.cursor;
      for (const receipt of batch.receipts) await this.receive(receipt);
      return;
    }
    const receipt = fallback;
    if (!receipt) return;
    if (this.latestReceiptFile && digest(receipt) === digest(this.latestReceiptFile)) return;
    this.latestReceiptFile = receipt;
    await this.receive(receipt);
  }

  private async receive(receipt: MacroReceipt): Promise<void> {
    const record = this.issued.get(receipt.id);
    if (!record || receipt.run !== this.config.run || receipt.life !== record.intent.life ||
        receipt.tick < record.intent.basisTick ||
        ((receipt.status === "accepted" || receipt.status === "completed") && receipt.tick > record.intent.expiresTick)) {
      throw new Error("Native survival macro receipt has a foreign or stale intent.");
    }
    const prior = receipt.status === "accepted" ? record.accepted : record.terminal;
    if (prior) {
      if (digest(prior) !== digest(receipt)) throw new Error("Conflicting native survival macro receipt.");
      return;
    }
    if (record.terminal || (record.accepted && receipt.tick < record.accepted.tick)) {
      throw new Error("Native survival macro receipt order is invalid.");
    }
    await this.append(this.receipts, { intent: record.intent, receipt });
    if (receipt.status === "accepted") {
      record.accepted = receipt;
      return;
    }
    record.terminal = receipt;
    this.terminalReceipts++;
    if (receipt.status === "completed") this.completedReceipts++;
    if (!this.lastReceipt || this.lastReceipt.tick <= receipt.tick) this.lastReceipt = receipt;
    if (this.pending === record) {
      this.pending = undefined;
      await this.ipc!.remove("intent.json");
    }
    this.handoffAfterTick = Math.max(this.handoffAfterTick, receipt.tick - 1);
    if (this.view) this.view = { ...this.view, query: this.queryKey(this.view.observation, this.view.evidence) };
  }

  private async withdraw(reason: string): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    await this.ipc!.remove("intent.json");
    this.pending = undefined;
    this.handoffAfterTick = Math.max(this.handoffAfterTick, this.view?.observation.tick ?? pending.intent.basisTick);
    await this.disposition("intent_withdrawn", { reason, id: pending.intent.id });
  }

  private trigger(view: View): MacroTrigger {
    const previous = this.lastAsked;
    if (!previous) return "first";
    if (!scope(view.observation, previous.observation)) return "premise";
    if (guardBand(view.observation.health) < guardBand(previous.observation.health) ||
        guardBand(view.observation.food) < guardBand(previous.observation.food)) return "risk";
    if (this.lastReceipt?.life === view.observation.life && this.lastReceipt.tick >= previous.observation.tick) return "receipt";
    if (performance.now() - previous.changedAt >= this.limits.stuckAfterMs) return "stuck";
    return "progress";
  }

  private async begin(view: View): Promise<void> {
    const trigger = this.trigger(view);
    const observation = view.observation;
    const observedAt = this.observedAt;
    const requestId = randomUUID();
    const skills = this.config.skills;
    const selection = skills?.selection();
    const skillVerbs = this.config.trial && this.skillCandidates < this.limits.maxSkillCandidates ? skills?.allowedVerbs() : undefined;
    const selectedSkillHash = selection?.hash && this.testedSkillVerbs.has(selection.hash) &&
      skills?.status(selection.hash) === "active" ? selection.hash : undefined;
    const generation = selection && (selectedSkillHash || skillVerbs?.length) ? selection.generation : null;
    const request: MacroRequest = {
      observation, objective: this.objective, trigger, capabilitiesVersion: this.capabilitiesVersion,
      skillGeneration: generation, skillVerbs, selectedSkillHash,
      maxResponseBytes: this.limits.maxResponseBytes, maxIntentTtlTicks: this.limits.maxIntentTtlTicks,
      maxPlanTtlTicks: this.limits.maxPlanTtlTicks,
      lastReceipt: this.lastReceipt?.life === observation.life ? this.lastReceipt : null,
      feedback: this.currentFeedback(observation),
    };
    this.queryKeys.add(view.query);
    this.lastAsked = view;
    await this.record("request", { requestId, evidenceKey: view.evidence, request });
    if (this.closing || performance.now() - this.startedAt! >= this.limits.maxRuntimeMs) {
      await this.disposition("request_not_dispatched", { requestId, reason: this.closing ? "stop" : "runtime_wall_limit" });
      return;
    }
    this.requests++;
    this.unreportedDispatches++;
    this.busy = {
      kind: "inference",
      work: this.work({ requestId, observation, generation }, this.limits.requestTimeoutMs, async signal => {
        const frame = await this.capture(observation, observedAt, requestId, signal);
        signal.throwIfAborted();
        return this.config.strategist!(frame ? { ...request, frame } : request, signal);
      }),
    };
  }

  private async capture(observation: MacroObservation, observedAt: number, requestId: string, signal: AbortSignal): Promise<MacroFrame | undefined> {
    if (!this.config.frame) return;
    let sample: MacroFrame | undefined;
    try { sample = await this.config.frame(observation, signal, requestId); }
    catch { throw new FrameRejected("invalid", "The trusted display capture did not settle."); }
    signal.throwIfAborted();
    const ipc = this.ipc!;
    const checkScope = async () => {
      const latest = await ipc.read("observation.json", parseMacroObservation);
      if (!latest || !scope(latest, observation) || !alive(latest) || latest.tick < observation.tick ||
          performance.now() - observedAt > this.limits.maxObservationAgeMs) {
        throw new FrameRejected("stale", "The observation scope or freshness changed during display capture.");
      }
      return latest;
    };
    if (!sample) {
      await this.record("request_frame_omitted", { requestId, reason: "No verified image matched the request basis." });
      await checkScope();
      return;
    }
    if (sample.source !== "verified-game-display" || !(sample.data instanceof Uint8Array) ||
        sample.data.length < 1 || sample.data.length > 2 * 1024 * 1024 ||
        !Number.isSafeInteger(sample.width) || !Number.isSafeInteger(sample.height) ||
        sample.width < 1 || sample.height < 1 || sample.width > 2_048 || sample.height > 2_048 ||
        (sample.mimeType !== "image/jpeg" && sample.mimeType !== "image/png")) {
      throw new FrameRejected("invalid", "The display capture exceeded its admitted shape.");
    }
    const sha256 = createHash("sha256").update(sample.data).digest("hex");
    const extension = sample.mimeType === "image/jpeg" ? "jpg" : "png";
    const { artifact, ...frame } = sample;
    const relativePath = artifact?.relativePath ?? null;
    if (artifact && (relativePath !== `macro-frames/${requestId}.${extension}` || artifact.sha256 !== sha256)) {
      throw new FrameRejected("invalid", "The display capture archive did not match its request or bytes.");
    }
    const discard = async () => {
      try { await artifact?.discard?.(); }
      catch { throw new FrameRejected("invalid", "The archived display capture could not be withdrawn."); }
    };
    try {
      signal.throwIfAborted();
      if (!sameBasis(sample, observation)) throw new FrameRejected("stale", "The display capture used a stale observation basis.");
      await this.record("request_frame", { requestId, basis: basis(observation), sha256, relativePath,
        bytes: sample.data.length, width: sample.width, height: sample.height, mimeType: sample.mimeType });
      const latest = await checkScope();
      signal.throwIfAborted();
      if (sameBasis(latest, observation)) return frame;
    } catch (error) {
      await discard();
      throw error;
    }
    await discard();
    await this.record("request_frame_omitted", { requestId, reason: "A newer tick arrived before dispatch; retained the original observation only." });
    await checkScope();
  }

  private work<T>(context: Decision, limit: number, start: (signal: AbortSignal) => Promise<T>): Work<T> {
    const cancel = new AbortController();
    const startedAt = performance.now();
    const until = Math.min(startedAt + limit, this.startedAt! + this.limits.maxRuntimeMs);
    // Every settlement is value-only; only the serialized poll can publish an intent.
    const done = Promise.resolve().then(() => start(cancel.signal)).then(
      value => { work.result = { ok: true, value, settledAt: performance.now() }; },
      error => { work.result = { ok: false, detail: describe(error), settledAt: performance.now(),
        ...(error instanceof FrameRejected ? { preflight: error.disposition } : {}) }; },
    );
    const work: Work<T> = { context, cancel, startedAt, until, done };
    return work;
  }

  private async settle(current: MacroObservation | undefined, runtimeExpired: boolean): Promise<void> {
    const busy = this.busy!;
    this.busy = undefined;
    const result = busy.work.result!;
    const context = busy.work.context;
    const stale = runtimeExpired || !current || !scope(context.observation, current) || !alive(current) ||
      (busy.kind !== "inference" && current.tick >= busy.plan.proposal.expiresTick);
    const late = result.settledAt > busy.work.until || busy.work.cancel.signal.aborted;
    if (busy.kind === "inference") {
      const inference = busy.work.result!;
      await this.settleInference(context, inference, busy.work.startedAt, current, stale, late);
    } else if (busy.kind === "trial") {
      const trial = busy.work.result!;
      if (!trial.ok) {
        await this.disposition("skill_rejected", { requestId: context.requestId, reason: trial.detail });
        return;
      }
      await this.record("skill_trial", { requestId: context.requestId, hash: trial.value.hash,
        shadow: trial.value.shadow, trial: trial.value.trial, detail: trial.value.detail });
      const { hash, shadow, trial: proof } = trial.value;
      const original = context.observation.opportunities.find(offer => offer.id === shadow?.opportunityId);
      if (stale || late) {
        this.config.skills!.quarantine(hash, "authored-plan-expired");
        await this.rejectStale(context, "skill_trial_outlived_plan");
      } else if (proof?.status === "passed" && proof.verb && original?.verb === proof.verb && shadow?.skillHash === hash) {
        this.ready = { kind: "candidate", plan: busy.plan, candidate: { hash, verb: proof.verb } };
      } else {
        this.config.skills!.quarantine(hash, "ordinary-shadow-and-trial-did-not-agree");
        await this.disposition("skill_rejected", { requestId: context.requestId,
          reason: proof?.status === "passed" ? "Trial did not attest the ordinary shadow effect verb." : trial.value.detail });
      }
    } else if (busy.kind === "shadow") {
      const projection = busy.work.result!;
      if (stale || late || !projection.ok || !projection.value) {
        this.config.skills!.quarantine(busy.candidate.hash, "fresh-shadow-did-not-admit-tested-effect");
        if (stale || late) await this.rejectStale(context, "fresh_shadow_outlived_plan");
        else await this.disposition("skill_rejected", { requestId: context.requestId,
          reason: projection.ok ? "Fresh shadow did not select an effect of the independently tested verb." : projection.detail });
      } else {
        this.ready = { kind: "promotion", plan: busy.plan, candidate: busy.candidate, offer: projection.value };
      }
    } else {
      const selection = busy.work.result!;
      if (stale || late) await this.rejectStale(context, "skill_selection_outlived_plan");
      else if (!selection.ok) await this.disposition("skill_rejected", { requestId: context.requestId, reason: selection.detail });
      else if (!selection.value.offer) await this.disposition("skill_abstained", { requestId: context.requestId });
      else this.ready = { kind: "selection", plan: busy.plan, selection: selection.value };
    }
  }

  private async settleInference(
    context: Decision, result: NonNullable<Work<MacroInference>["result"]>, startedAt: number,
    current: MacroObservation | undefined, stale: boolean, late: boolean,
  ): Promise<void> {
    let proposal: MacroProposal | null = null;
    const inference = result.ok ? result.value : null;
    const model = inference?.model && /^[A-Za-z0-9._:/-]{1,128}$/.test(inference.model) ? inference.model : null;
    if (model) this.models.add(model);
    if (typeof inference?.dispatched === "boolean") {
      this.unreportedDispatches--;
      if (inference.dispatched) this.providerDispatches++;
    } else if (!result.ok && result.preflight) this.unreportedDispatches--;
    if (inference) this.lastProviderOutcome = inference.outcome;
    let reason: string | null = result.ok ? null : result.detail;
    if (inference?.outcome === "completed") {
      try {
        proposal = parseMacroProposal(inference.proposal);
        if (Buffer.byteLength(JSON.stringify(proposal)) > this.limits.maxResponseBytes) {
          throw new Error("Survival macro plan exceeds the response byte cap.");
        }
      } catch (error) {
        proposal = null;
        reason = describe(error);
      }
    }
    const original = context.observation;
    const basisMatches = sameBasis(inference?.basis, original);
    const ttlValid = !!proposal && proposal.expiresTick > original.tick &&
      proposal.expiresTick - original.tick <= (proposal.action.kind === "skill" ? this.limits.maxPlanTtlTicks : this.limits.maxIntentTtlTicks);
    const expired = !!proposal && !!current && current.tick >= proposal.expiresTick;
    const preflight = result.ok ? undefined : result.preflight;
    const disposition = stale || expired || (!!inference && !basisMatches) || inference?.outcome === "stale" || preflight === "stale" ? "stale" :
      late ? "timed_out" : preflight === "invalid" ? "invalid" : !inference ? "provider_error" : inference.outcome !== "completed" ? inference.outcome :
      !proposal || !ttlValid || !model ? "invalid" : "proposed";
    if (disposition === "stale") this.staleDecisions++;
    this.unavailable = disposition === "provider_unavailable";
    this.lastDisposition = disposition;
    await this.append(this.proposals, {
      requestId: context.requestId, basis: basis(original), goal: original.goal, capabilitiesVersion: this.capabilitiesVersion,
      skillGeneration: context.generation, model, usage: usageEvidence(inference?.usage ?? null), costUsd: positiveFinite(inference?.costUsd),
      providerOutcome: inference?.outcome ?? null, dispatched: inference?.dispatched ?? (preflight ? false : null),
      latencyMs: Math.round(result.settledAt - startedAt), providerLatencyMs: positiveFinite(inference?.latencyMs),
      frameSha256: inference?.frameSha256 && /^[a-f0-9]{64}$/.test(inference.frameSha256) ? inference.frameSha256 : null,
      disposition, reason, proposal,
    });
    if (disposition !== "proposed" || !proposal || !current || this.closing) return;
    switch (proposal.action.kind) {
      case "abstain":
        await this.disposition("abstained", { requestId: context.requestId });
        return;
      case "gap":
        await this.disposition("native_capability_gap", { requestId: context.requestId,
          capability: proposal.action.capability, reviewSuggestion: proposal.action.suggestion ?? null });
        return;
      case "skill":
        await this.beginSkill({ ...context, proposal });
        return;
      case "opportunity":
      case "selected-skill":
        this.ready = { kind: "plan", plan: { ...context, proposal } };
    }
  }

  private async beginSkill(plan: Plan): Promise<void> {
    const skills = this.config.skills;
    const trial = this.config.trial;
    if (!skills || !trial || plan.proposal.action.kind !== "skill" || plan.generation === null ||
        this.skillCandidates >= this.limits.maxSkillCandidates || skills.selection().generation !== plan.generation ||
        plan.proposal.action.candidate.parentGeneration !== plan.generation) {
      await this.disposition("skill_rejected", { requestId: plan.requestId, reason: "Skill not authorized, generation changed, or candidate cap reached." });
      return;
    }
    this.skillCandidates++;
    const candidate = plan.proposal.action.candidate;
    this.busy = {
      kind: "trial", plan,
      work: this.work(plan, this.limits.skillTimeoutMs, async signal => {
        signal.throwIfAborted();
        const hash = skills.draft(candidate);
        try {
          if (!await skills.validate(hash, signal)) return { hash, shadow: null, trial: null, detail: "Independent validation rejected the candidate." };
          signal.throwIfAborted();
          const shadow = await skills.shadow(hash, plan.observation, signal);
          signal.throwIfAborted();
          if (!shadow) return { hash, shadow: null, trial: null, detail: "Ordinary shadow produced no admitted effect." };
          const effect = await trial.run(hash, skills, signal);
          return { hash, shadow, trial: effect, detail: effect.detail };
        } catch (error) {
          skills.quarantine(hash, "admission-aborted-or-faulted");
          throw error;
        }
      }),
    };
  }

  private async handoff(current: MacroObservation | undefined): Promise<void> {
    const ready = this.ready!;
    const plan = ready.plan;
    if (!current || !scope(plan.observation, current) || !alive(current) || current.tick >= plan.proposal.expiresTick) {
      this.discardReady("handoff-expired");
      await this.rejectStale(plan, "scope_or_ttl_changed_before_handoff");
      return;
    }
    if (!this.isNeutralHandoff(current)) return;
    const skills = this.config.skills;
    if (ready.kind === "selection") {
      this.ready = undefined;
      const { offer, basis: selectedAt, hash, generation, requiredOffer } = ready.selection;
      const active = skills?.selection();
      if (!offer || offer.skillHash !== hash || active?.hash !== hash || active.generation !== generation || skills?.status(hash) !== "active") {
        await this.rejectStale(plan, "skill_selection_changed_before_handoff");
        return;
      }
      const observed = selectedAt.opportunities.find(item => item.id === offer.opportunityId);
      if (!observed || observed.verb !== this.testedSkillVerbs.get(hash) || (requiredOffer && !sameOffer(requiredOffer, observed))) {
        await this.disposition("unproven_skill_effect_refused", { requestId: plan.requestId, hash });
        return;
      }
      await this.issue(plan, selectedAt, offer.opportunityId, hash);
      return;
    }
    if (plan.proposal.action.kind === "opportunity") {
      this.ready = undefined;
      await this.issue(plan, plan.observation, plan.proposal.action.opportunityId, null);
      return;
    }
    this.ready = undefined;
    if (!skills || plan.generation === null || skills.selection().generation !== plan.generation) {
      if (ready.kind === "candidate" || ready.kind === "promotion") skills?.quarantine(ready.candidate.hash, "parent-generation-changed");
      await this.rejectStale(plan, "skill_generation_changed_before_handoff");
      return;
    }
    if (ready.kind === "candidate") {
      const candidate = ready.candidate;
      this.busy = { kind: "shadow", plan, candidate, work: this.work(plan, this.limits.skillTimeoutMs, async signal => {
        const projection = await skills.shadow(candidate.hash, current, signal);
        return projection?.skillHash === candidate.hash ? current.opportunities.find(offer =>
          offer.id === projection.opportunityId && offer.verb === candidate.verb && offer.risk !== "guarded") : undefined;
      }) };
      return;
    }
    if (ready.kind === "promotion") {
      const { candidate, offer } = ready;
      await this.refresh();
      const fresh = this.view!.observation;
      if (!this.isNeutralHandoff(fresh) || !scope(current, fresh) || fresh.tick >= plan.proposal.expiresTick ||
          !sameOffer(offer, fresh.opportunities.find(item => item.id === offer.id)) ||
          !skills.promote(candidate.hash, plan.generation, fresh)) {
        skills.quarantine(candidate.hash, "fresh-promotion-refused");
        await this.disposition("skill_promotion_refused", { requestId: plan.requestId, hash: candidate.hash });
        return;
      }
      this.testedSkillVerbs.set(candidate.hash, candidate.verb);
      await this.record("skill_promoted", { requestId: plan.requestId, selection: skills.selection(), basis: basis(fresh), offer });
    }
    const { hash, generation } = skills.selection();
    if (!hash || !this.testedSkillVerbs.has(hash)) {
      await this.disposition("skill_unavailable", { requestId: plan.requestId });
      return;
    }
    const observation = this.view!.observation;
    this.busy = { kind: "selection", plan, work: this.work(plan, this.limits.skillTimeoutMs, async signal => ({
      hash, generation, basis: observation, offer: await skills.select(observation, signal),
      ...(ready.kind === "promotion" ? { requiredOffer: ready.offer } : {}),
    })) };
  }

  private async issue(plan: Plan, witnessed: MacroObservation, opportunityId: string, skillHash: string | null): Promise<void> {
    await this.refresh();
    const view = this.view!;
    const current = view.observation;
    const before = witnessed.opportunities.find(offer => offer.id === opportunityId);
    if (!before) {
      await this.disposition("proposal_refused", { requestId: plan.requestId, reason: "Opportunity was never offered on its basis." });
      return;
    }
    const after = current.opportunities.find(offer => offer.id === opportunityId);
    if (!this.isNeutralHandoff(current) || !scope(witnessed, current) || current.tick >= plan.proposal.expiresTick ||
        !sameOffer(before, after) || (skillHash && after?.risk === "guarded")) {
      await this.rejectStale(plan, "opportunity_no_longer_witnessed");
      return;
    }
    const key = digest([current.life, current.epoch, current.goal, after]);
    if (this.effectKeys.has(key)) {
      await this.disposition("duplicate_intent_refused", { requestId: plan.requestId, opportunityId });
      return;
    }
    const intent = parseMacroIntent({
      v: 1, id: randomUUID(), run: current.run, life: current.life, epoch: current.epoch, basisTick: current.tick,
      expiresTick: Math.min(plan.proposal.expiresTick, current.tick + this.limits.maxIntentTtlTicks), opportunityId, skillHash,
    });
    await this.record("intent_prepared", { requestId: plan.requestId, intent, witnessed: before });
    if (!this.isNeutralHandoff(current)) return;
    const macro = { intent, scope: current };
    this.pending = macro;
    this.issued.set(intent.id, macro);
    this.effectKeys.add(key);
    await this.ipc!.write("intent.json", intent);
    this.publishedIntents++;
    await this.disposition("intent_issued", { requestId: plan.requestId, id: intent.id });
  }

  private async rejectStale(context: Decision, reason: string): Promise<void> {
    this.staleDecisions++;
    await this.disposition("stale", { requestId: context.requestId, reason });
  }

  private discardReady(reason: string): void {
    const current = this.ready;
    this.ready = undefined;
    if (current?.kind === "candidate" || current?.kind === "promotion") {
      this.config.skills!.quarantine(current.candidate.hash, reason);
    }
  }

  private async restoreSelection(observation: MacroObservation): Promise<void> {
    const skills = this.config.skills;
    const active = skills?.selection();
    if (!skills || !active?.hash || skills.status(active.hash) !== "quarantined") return;
    if (skills.revert(active.generation, observation)) {
      await this.disposition("skill_reverted", { previous: active, selection: skills.selection(), basis: basis(observation) });
      this.view = { ...this.view!, query: this.queryKey(observation, this.view!.evidence) };
    }
  }

  private async append(file: FileHandle | undefined, value: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - this.startedAt!), ...value }) + "\n";
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error("Survival macro audit record exceeds its byte cap.");
    await file!.appendFile(line);
  }

  private record(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    return this.historyTail = this.historyTail.catch(() => {}).then(() => this.append(this.history, { event, ...fields }));
  }

  private async disposition(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    this.lastDisposition = event;
    await this.record(event, fields);
    const detail = FEEDBACK[event];
    if (detail && this.view) {
      const { observation, evidence } = this.view;
      this.feedback = { observation, value: Object.freeze({ kind: event, detail }) };
      this.view = { ...this.view, query: this.queryKey(observation, evidence) };
    }
  }

  private async revoke(): Promise<void> {
    if (!this.markerLive) return;
    try {
      await this.ipc!.remove("active.json");
      this.markerLive = false;
    } finally {
      await this.ipc!.remove("intent.json");
    }
  }

  private async fail(error: unknown): Promise<void> {
    this.faulted = true;
    this.busy?.work.cancel.abort(error);
    await this.revoke().catch(() => {});
    this.lastDisposition = "protocol_fault";
    await this.record("protocol_fault", { reason: describe(error) }).catch(() => {});
  }

  stop(): Promise<void> {
    return this.stopPromise ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    this.config.signal?.removeEventListener("abort", this.stopListener);
    if (this.timer) clearTimeout(this.timer);
    await this.startPromise?.catch(() => {});
    this.busy?.work.cancel.abort(new Error("Survival macro stopped."));
    await this.polling;
    try {
      if (this.history) {
        const pending = this.pending;
        await this.revoke();
        if (pending) {
          this.pending = undefined;
          await this.disposition("intent_withdrawn", { reason: "stop", id: pending.intent.id });
          const until = performance.now() + 500;
          while (!pending.terminal && performance.now() < until && !this.faulted) {
            await this.readReceipts();
            if (!pending.terminal) await delay(25);
          }
        } else if (!this.faulted) await this.readReceipts();
        const busy = this.busy;
        if (busy?.kind === "inference") {
          const grace = new AbortController();
          try {
            await Promise.race([busy.work.done, delay(2_000, undefined, { signal: grace.signal })]);
          } finally {
            grace.abort();
          }
        } else if (busy) await busy.work.done;
        if (this.busy?.work.result) await this.settle(this.view?.observation, false);
        this.discardReady("run-stopped-before-promotion");
        this.endedAt = performance.now();
        this.stopped = true;
        await this.record("stopped", { status: this.status(), unresolvedRequestId: this.busy?.work.context.requestId ?? null,
          unresolvedIntentId: pending && !pending.terminal ? pending.intent.id : null });
      }
    } catch (error) {
      await this.fail(error);
    } finally {
      this.endedAt ??= performance.now();
      this.stopped = true;
      await this.closeFiles();
    }
  }

  private async closeFiles(): Promise<void> {
    await Promise.allSettled([this.history?.close(), this.proposals?.close(), this.receipts?.close(), this.ipc?.close()]);
    this.history = this.proposals = this.receipts = undefined;
    this.ipc = undefined;
  }
}
