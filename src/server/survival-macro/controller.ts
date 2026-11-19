import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  MACRO_CAPABILITIES_VERSION, MACRO_MAX_HANDOFF_TTL_TICKS, MACRO_MAX_INTENT_TTL_TICKS, MACRO_MAX_PLAN_TTL_TICKS,
  MacroDirectory, parseMacroHandoff, parseMacroIntent, parseMacroObservation,
  parseMacroProposal, parseMacroReceipt, parseMacroRevocation, validateMacroId,
  type MacroBasis, type MacroFeedback, type MacroFrame, type MacroHandoff, type MacroInference, type MacroIntent,
  type MacroObservation, type MacroOpportunity,
  type MacroProposal, type MacroReceipt, type MacroRequest, type MacroSkillReceipt, type MacroStrategist,
  type MacroTrigger, type NativeReceiptCursor,
} from "./protocol.ts";
import { StrategicEpisodeLedger } from "./episode-memory.ts";
import type { NativeGapReview } from "./gap-review.ts";
import type { MacroSkillProposal, SurvivalMacroSkills } from "./skills.ts";

export interface MacroLimits {
  readonly maxRequests: number;
  readonly maxRuntimeMs: number;
  readonly requestTimeoutMs: number;
  readonly maxSkillCandidates: number;
  readonly maxSkillEffects: number;
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
  maxSkillCandidates: 1, maxSkillEffects: 3, skillTimeoutMs: 240_000, maxResponseBytes: 16 * 1024,
  maxIntentTtlTicks: MACRO_MAX_INTENT_TTL_TICKS, maxPlanTtlTicks: MACRO_MAX_PLAN_TTL_TICKS,
  maxObservationAgeMs: 2_000, pollMs: 125, stuckAfterMs: 12_000,
};
const HARD_LIMITS: MacroLimits = {
  maxRequests: Number.MAX_SAFE_INTEGER, maxRuntimeMs: Number.MAX_SAFE_INTEGER, requestTimeoutMs: 120_000,
  maxSkillCandidates: 8, maxSkillEffects: 3, skillTimeoutMs: 900_000, maxResponseBytes: 16 * 1024,
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
  readonly nativeReview?: NativeGapReview;
  readonly limits?: Partial<MacroLimits>;
  readonly capabilitiesVersion?: string;
  readonly signal?: AbortSignal;
  /** Trusted supervisor joins the exact launched Java child; no PID guesses. */
  readonly confirmNativeExit?: () => Promise<boolean>;
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
  readonly lateCompletedReceipts: number;
  readonly unresolvedIntents: number;
  readonly nativeAuthority: "not_activated" | "unconfirmed" | "revoked" | "exited";
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
  readonly testedSkills: NonNullable<MacroRequest["testedSkills"]>;
  readonly selectedSkillHash?: string;
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
  readonly continuation?: Segment;
}

interface ProvenCandidate {
  readonly hash: string;
  readonly verb: string;
  readonly generation: number;
}

type Ready = { readonly plan: Plan } & (
  { readonly kind: "plan" } |
  { readonly kind: "candidate"; readonly candidate: ProvenCandidate } |
  { readonly kind: "promotion"; readonly candidate: ProvenCandidate; readonly offer: MacroOpportunity; readonly neutralBasis: boolean } |
  { readonly kind: "selection"; readonly selection: Selection }
);

interface Issued {
  readonly requestId: string;
  readonly intent: MacroIntent;
  readonly scope: MacroObservation;
  readonly offer: MacroOpportunity;
  withdrawn?: true;
  accepted?: MacroReceipt;
  terminal?: MacroReceipt;
}

interface Segment {
  readonly plan: Plan;
  readonly hash: string;
  readonly generation: number;
  readonly maxEffects: number;
  readonly receipts: MacroSkillReceipt[];
  readonly seen: Set<string>;
  effects: number;
  health: number;
  waiting?: Issued;
}

type Busy =
  | { readonly kind: "inference"; readonly work: Work<MacroInference> }
  | { readonly kind: "trial"; readonly work: Work<SkillCheck>; readonly plan: Plan }
  | { readonly kind: "shadow"; readonly work: Work<MacroOpportunity | undefined>; readonly plan: Plan;
      readonly candidate: ProvenCandidate; readonly barrierOffer?: MacroOpportunity }
  | { readonly kind: "selection"; readonly work: Work<Selection>; readonly plan: Plan; readonly continuation?: Segment };

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

function sameGoalAndLife(left: MacroObservation, right: MacroObservation): boolean {
  return left.run === right.run && left.life === right.life && left.goal === right.goal;
}

function scope(left: MacroObservation, right: MacroObservation): boolean {
  return sameGoalAndLife(left, right) && left.epoch === right.epoch;
}

function samePlayableScope(left: MacroObservation, right: MacroObservation): boolean {
  return scope(left, right) && alive(right);
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
  private nativeAuthority: MacroStatus["nativeAuthority"] = "not_activated";
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
  private lateCompletedReceipts = 0;
  private publishedIntents = 0;
  private journal: NativeReceiptCursor | null = null;
  private latestReceiptFile?: MacroReceipt;
  private readonly issued = new Map<string, Issued>();
  private readonly episodeMemory = new StrategicEpisodeLedger();
  private readonly effectKeys = new Set<string>();
  private readonly queryKeys = new Set<string>();
  private readonly testedSkillVerbs = new Map<string, string>();
  private readonly testedCandidates = new Map<string, ProvenCandidate>();
  private handoffAfterTick = -1;
  private pending?: Issued;
  private segment?: Segment;
  private lease?: { readonly value: MacroHandoff; readonly plan: Plan };
  private busy?: Busy;
  private ready?: Ready;
  private stopListener = () => { void this.stop().catch(() => {}); };

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
      this.nativeAuthority = "unconfirmed";
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
      this.pending || this.segment ? "executing" : this.busy?.kind === "inference" ? "inferring" :
      this.busy?.kind === "trial" ? "testing-skill" : this.ready || this.busy ? "awaiting-handoff" :
      this.budget ? "budget-limited" : this.unavailable ? "provider-unavailable" : "waiting";
    return {
      strategy: this.config.strategy, state, capabilitiesVersion: this.capabilitiesVersion, limits: this.limits,
      models: [...this.models], elapsedMs: this.startedAt === undefined ? 0 : Math.round((this.endedAt ?? performance.now()) - this.startedAt),
      requests: this.requests, providerDispatches: this.providerDispatches, unreportedDispatches: this.unreportedDispatches,
      skillCandidates: this.skillCandidates, staleDecisions: this.staleDecisions, issued: this.publishedIntents,
      terminalReceipts: this.terminalReceipts, completedReceipts: this.completedReceipts,
      lateCompletedReceipts: this.lateCompletedReceipts, unresolvedIntents: this.issued.size - this.terminalReceipts,
      nativeAuthority: this.nativeAuthority,
      budget: this.budget, lastReceipt: this.lastReceipt, lastProviderOutcome: this.lastProviderOutcome, lastDisposition: this.lastDisposition,
    };
  }

  isNeutralHandoff(observation: MacroObservation): boolean {
    return this.isCurrentHandoff(observation) && observation.quiescent;
  }

  private isCurrentHandoff(observation: MacroObservation): boolean {
    const now = performance.now();
    return this.markerLive && !this.closing && !this.faulted && !this.pending && this.view?.observation === observation &&
      observation.tick > this.handoffAfterTick && alive(observation) && now - this.observedAt <= this.limits.maxObservationAgeMs &&
      now - this.startedAt! < this.limits.maxRuntimeMs;
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
    if (await ipc.read("revoked.json", parseMacroRevocation)) {
      throw new Error("Native macro authority was unexpectedly revoked.");
    }
    await this.refresh();
    await this.readReceipts();
    if (this.closing) return;
    const [mailbox, barrier] = await Promise.all([
      ipc.read("intent.json", parseMacroIntent), ipc.read("handoff.json", parseMacroHandoff),
    ]);
    if (mailbox ? !this.pending || digest(mailbox) !== digest(this.pending.intent) : !!this.pending) {
      throw new Error("Survival macro intent mailbox changed outside its owner.");
    }
    if (barrier ? !this.lease || digest(barrier) !== digest(this.lease.value) : !!this.lease) {
      throw new Error("Survival macro handoff mailbox changed outside its owner.");
    }
    const now = performance.now();
    const view = this.view;
    const current = view && now - this.observedAt <= this.limits.maxObservationAgeMs ? view.observation : undefined;
    const runtimeExpired = now - this.startedAt! >= this.limits.maxRuntimeMs;

    const lease = this.lease;
    if (lease && (runtimeExpired || !current || !samePlayableScope(lease.plan.observation, current) ||
        current.tick > lease.value.expiresTick)) {
      await this.releaseHandoff();
      if (this.ready?.plan === lease.plan) this.ready = undefined;
      if ((this.busy?.kind === "selection" || this.busy?.kind === "shadow") && this.busy.plan === lease.plan) {
        this.busy.work.cancel.abort(new Error("handoff_lease_expired"));
      }
      await this.rejectStale(lease.plan, "neutral_handoff_expired");
    }
    if (this.pending && (runtimeExpired || !current || !scope(this.pending.scope, current) || !alive(current) ||
      current.tick > this.pending.intent.expiresTick)) {
      await this.withdraw(runtimeExpired ? "runtime_wall_limit" : "native_scope_or_ttl_changed");
    }
    const segment = this.segment;
    if (segment && (runtimeExpired || !current || !sameGoalAndLife(segment.plan.observation, current) ||
        !alive(current) || current.health < segment.health ||
        current.tick >= segment.plan.proposal.expiresTick || !this.isSelectedSkill(segment.hash, segment.generation))) {
      if (this.pending === segment.waiting && this.pending) await this.withdraw("segment_scope_ttl_or_selection_changed");
      await this.finishSegment(runtimeExpired ? "runtime_wall_limit" : "segment_scope_ttl_or_selection_changed");
    }
    if (this.busy && !this.busy.work.cancel.signal.aborted) {
      const work = this.busy.work;
      // Candidate-only validation is independent of the ordinary plan. Never
      // cancel it merely because the player moved or the old action expired.
      const stale = this.busy.kind !== "trial" && (!current ||
        (this.busy.kind === "inference"
          ? !sameGoalAndLife(work.context.observation, current) || !alive(current)
          : !samePlayableScope(work.context.observation, current) || current.tick >= this.busy.plan.proposal.expiresTick));
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
      this.ready = undefined;
      // Continue reading receipts and draining any actual provider settlement, but no longer issue.
      return;
    }
    if (current && !this.busy && this.isNeutralHandoff(current)) await this.restoreSelection(current);
    if (this.ready) await this.handoff(current);
    if (this.lease && !this.ready && !this.busy) await this.releaseHandoff();
    if (this.closing || this.pending || this.busy || this.ready || !current) return;
    if (this.segment) {
      await this.advanceSegment(current);
      return;
    }
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
      selection?.generation ?? null, this.availableCandidates(selection?.generation), this.currentFeedback(observation) ?? null]);
  }

  private availableCandidates(generation: number | undefined): NonNullable<MacroRequest["testedSkills"]> {
    const skills = this.config.skills;
    return [...this.testedCandidates.values()].filter(candidate =>
      candidate.generation === generation && skills?.status(candidate.hash) === "trial").map(({ hash, verb }) => ({ hash, verb }));
  }

  private currentFeedback(observation: MacroObservation): MacroFeedback | undefined {
    return this.feedback && scope(this.feedback.observation, observation) ? this.feedback.value : undefined;
  }

  private async readReceipts(closing = false): Promise<void> {
    const ipc = this.ipc!;
    const maxBytes = Math.min(Number.MAX_SAFE_INTEGER, (2 * this.issued.size + 2) * 4_097);
    let batch = await ipc.readNativeReceiptLines(this.journal, maxBytes);
    const fallback = batch ? null : await ipc.read("receipt.json", parseMacroReceipt);
    // Native publishes the append-only receipt before the corresponding latest file.
    if (fallback) batch = await ipc.readNativeReceiptLines(this.journal, maxBytes);
    if (batch) {
      do {
        this.journal = batch.cursor;
        for (const receipt of batch.receipts) await this.receive(receipt);
        if (closing && batch.partial) throw new Error("Native receipt journal was not fully settled at authority closure.");
        if (!batch.more || !closing) break;
        batch = await ipc.readNativeReceiptLines(this.journal, maxBytes);
      } while (batch);
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
    const staleLife = (this.view?.observation.life ?? receipt.life) > receipt.life;
    const eligible = !record.withdrawn && !staleLife;
    await this.append(this.receipts, { requestId: record.requestId, intent: record.intent, receipt, eligible,
      ...(record.withdrawn ? { afterWithdrawal: true } : {}), ...(staleLife ? { priorLife: true } : {}) });
    if (receipt.status === "accepted") {
      record.accepted = receipt;
      return;
    }
    record.terminal = receipt;
    if (eligible) this.episodeMemory.terminal(record.requestId, record.offer, receipt);
    this.terminalReceipts++;
    if (receipt.status === "completed") {
      if (eligible) this.completedReceipts++;
      else this.lateCompletedReceipts++;
    }
    if (eligible && (!this.lastReceipt || this.lastReceipt.tick <= receipt.tick)) this.lastReceipt = receipt;
    if (this.pending === record) {
      this.pending = undefined;
      await this.ipc!.remove("intent.json");
    }
    if (this.segment?.waiting === record) {
      const segment = this.segment;
      segment.waiting = undefined;
      if (receipt.status !== "completed" || !eligible) {
        await this.finishSegment(!eligible ? "late_native_receipt" : `native_${receipt.status}`);
      } else {
        segment.receipts.push(Object.freeze({ tick: receipt.tick, verb: record.offer.verb, status: receipt.status, detail: receipt.detail }));
        if (segment.effects >= segment.maxEffects) await this.finishSegment("segment_effect_limit");
      }
    }
    this.handoffAfterTick = Math.max(this.handoffAfterTick, receipt.tick - 1);
    if (this.view) this.view = { ...this.view, query: this.queryKey(this.view.observation, this.view.evidence) };
  }

  private async withdraw(reason: string): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    pending.withdrawn = true;
    await this.ipc!.remove("intent.json");
    this.pending = undefined;
    const tick = this.view?.observation.tick ?? pending.intent.basisTick;
    this.handoffAfterTick = Math.max(this.handoffAfterTick, tick);
    await this.disposition("intent_withdrawn", { reason, id: pending.intent.id });
    this.episodeMemory.withdrawn(pending.requestId, pending.offer, pending.intent.id, tick);
    if (this.segment?.waiting === pending) await this.finishSegment(reason);
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
    const skillVerbs = this.config.trial && this.skillCandidates < this.limits.maxSkillCandidates &&
      this.testedCandidates.size === 0 ? skills?.allowedVerbs() : undefined;
    const selectedSkillHash = selection?.hash && this.testedSkillVerbs.has(selection.hash) &&
      skills?.status(selection.hash) === "active" ? selection.hash : undefined;
    const testedSkills = this.availableCandidates(selection?.generation);
    const generation = selection && (selectedSkillHash || skillVerbs?.length || testedSkills.length) ? selection.generation : null;
    const request: MacroRequest = {
      observation, objective: this.objective, trigger, capabilitiesVersion: this.capabilitiesVersion,
      skillGeneration: generation, skillVerbs, selectedSkillHash, testedSkills,
      maxSkillEffects: this.limits.maxSkillEffects,
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
      work: this.work({ requestId, observation, generation, testedSkills, selectedSkillHash }, this.limits.requestTimeoutMs, async signal => {
        let frame: MacroFrame | undefined;
        try {
          frame = await this.capture(observation, observedAt, requestId, signal);
          signal.throwIfAborted();
        } catch (error) {
          if (error instanceof FrameRejected) throw error;
          throw new FrameRejected(signal.aborted ? "stale" : "invalid", "The request stopped before provider dispatch.");
        }
        // Authoring source and the in-memory history projection are not copied to the request log.
        return this.config.strategist!({
          ...request, frame, nativeReview: this.config.nativeReview?.context,
          strategicEpisodes: this.episodeMemory.forObservation(observation),
        }, signal);
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
    const stale = runtimeExpired || !current || !samePlayableScope(context.observation, current) ||
      (busy.kind !== "inference" && current.tick >= busy.plan.proposal.expiresTick);
    const late = result.settledAt > busy.work.until || busy.work.cancel.signal.aborted;
    if (busy.kind === "inference") {
      const inference = busy.work.result!;
      await this.settleInference(context, inference, busy.work.startedAt, current, stale, late, runtimeExpired);
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
      if (runtimeExpired || this.closing || late || context.generation === null ||
          this.config.skills!.selection().generation !== context.generation) {
        this.config.skills!.quarantine(hash, "authored-plan-expired");
        await this.rejectStale(context, "skill_trial_outlived_plan");
      } else if (proof?.status === "passed" && proof.verb && original?.verb === proof.verb && shadow?.skillHash === hash) {
        const candidate = { hash, verb: proof.verb, generation: context.generation };
        this.testedCandidates.set(hash, candidate);
        await this.disposition("skill_tested", { requestId: context.requestId, ...candidate,
          reusedOldPlan: false, oldPlanStale: stale });
        if (this.view) this.view = { ...this.view, query: this.queryKey(this.view.observation, this.view.evidence) };
      } else {
        this.config.skills!.quarantine(hash, "ordinary-shadow-and-trial-did-not-agree");
        await this.disposition("skill_rejected", { requestId: context.requestId,
          reason: proof?.status === "passed" ? "Trial did not attest the ordinary shadow effect verb." : trial.value.detail });
      }
    } else if (busy.kind === "shadow") {
      const projection = busy.work.result!;
      if (stale || late || !projection.ok || !projection.value || (busy.barrierOffer && !sameOffer(busy.barrierOffer, projection.value))) {
        if (stale || late) await this.rejectStale(context, "fresh_shadow_outlived_plan");
        else await this.disposition("skill_rejected", { requestId: context.requestId,
          reason: projection.ok ? "Fresh shadow did not select an effect of the independently tested verb." : projection.detail });
      } else {
        this.ready = { kind: "promotion", plan: busy.plan, candidate: busy.candidate, offer: projection.value,
          neutralBasis: !!busy.barrierOffer };
      }
    } else {
      const selection = busy.work.result!;
      if (busy.continuation && this.segment !== busy.continuation) return;
      if (stale || late) {
        await this.rejectStale(context, "skill_selection_outlived_plan");
        if (busy.continuation) await this.finishSegment("stale_continuation");
      } else if (!selection.ok) {
        await this.disposition("skill_rejected", { requestId: context.requestId, reason: selection.detail });
        if (busy.continuation) await this.finishSegment("skill_rejected");
      } else if (!selection.value.offer) {
        await this.disposition("skill_abstained", { requestId: context.requestId });
        if (busy.continuation) await this.finishSegment("skill_abstained");
      } else this.ready = { kind: "selection", plan: busy.plan, selection: selection.value };
    }
  }

  private async settleInference(
    context: Decision, result: NonNullable<Work<MacroInference>["result"]>, startedAt: number,
    current: MacroObservation | undefined, stale: boolean, late: boolean, runtimeExpired: boolean,
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
    // Keep candidate contents only in private review storage, not the run trace.
    const hadReviewPatch = proposal?.action.kind === "gap" && !!proposal.action.reviewPatch;
    const recordedProposal: MacroProposal | null = proposal?.action.kind === "gap" && hadReviewPatch
      ? { ...proposal, action: { kind: "gap", capability: proposal.action.capability, suggestion: proposal.action.suggestion } }
      : proposal;
    await this.append(this.proposals, {
      requestId: context.requestId, basis: basis(original), goal: original.goal, capabilitiesVersion: this.capabilitiesVersion,
      skillGeneration: context.generation, model, usage: usageEvidence(inference?.usage ?? null), costUsd: positiveFinite(inference?.costUsd),
      providerOutcome: inference?.outcome ?? null, dispatched: inference?.dispatched ?? (preflight ? false : null),
      latencyMs: Math.round(result.settledAt - startedAt), providerLatencyMs: positiveFinite(inference?.latencyMs),
      frameSha256: inference?.frameSha256 && /^[a-f0-9]{64}$/.test(inference.frameSha256) ? inference.frameSha256 : null,
      disposition, reason, proposal: recordedProposal,
      ...(hadReviewPatch ? { reviewPatchProposed: true } : {}),
    });
    if (!proposal || !current || this.closing) return;
    if (disposition !== "proposed") {
      // The provider chose a pure function, not a durable live command. A
      // stale movement premise may still yield bounded independent testing,
      // but never promotion or reissue from this old request.
      if (disposition === "stale" && !runtimeExpired && !late && model && ttlValid && basisMatches &&
          sameGoalAndLife(context.observation, current) && alive(current)) {
        if (proposal.action.kind !== "abstain") {
          this.episodeMemory.chosen(context.requestId, original, proposal.subgoal, proposal.successCondition);
          this.episodeMemory.rejected(context.requestId, "stale");
        }
        if (proposal.action.kind === "skill") await this.beginSkill({ ...context, proposal });
        // An inert draft may still be reviewed after movement made the gameplay
        // premise stale; this branch does not reach any actuation or skill gate.
        if (proposal.action.kind === "gap" && proposal.action.reviewPatch) await this.recordGap(context.requestId, proposal.action);
      }
      return;
    }
    if (proposal.action.kind !== "abstain") {
      this.episodeMemory.chosen(context.requestId, original, proposal.subgoal, proposal.successCondition);
    }
    switch (proposal.action.kind) {
      case "abstain":
        await this.disposition("abstained", { requestId: context.requestId });
        return;
      case "gap":
        await this.recordGap(context.requestId, proposal.action);
        return;
      case "skill":
        await this.beginSkill({ ...context, proposal });
        return;
      case "tested-skill": {
        const action = proposal.action;
        const candidate = this.testedCandidates.get(action.skillHash);
        if (!candidate || candidate.generation !== context.generation ||
            !context.testedSkills.some(offer => offer.hash === candidate.hash) ||
            this.config.skills?.status(candidate.hash) !== "trial") {
          await this.disposition("skill_unavailable", { requestId: context.requestId });
          return;
        }
        this.ready = { kind: "candidate", plan: { ...context, proposal }, candidate };
        return;
      }
      case "opportunity":
        this.ready = { kind: "plan", plan: { ...context, proposal } };
        return;
      case "selected-skill":
        if (!context.selectedSkillHash) {
          await this.disposition("skill_unavailable", { requestId: context.requestId });
          return;
        }
        this.ready = { kind: "plan", plan: { ...context, proposal } };
    }
  }

  private async recordGap(requestId: string, action: Extract<MacroProposal["action"], { kind: "gap" }>): Promise<void> {
    const review = await this.config.nativeReview?.store({
      requestId, capability: action.capability, suggestion: action.suggestion, reviewPatch: action.reviewPatch,
    }).catch(() => ({ status: "no-patch" as const, reason: "storage-unavailable" }));
    await this.disposition("native_capability_gap", {
      requestId, capability: action.capability, reviewSuggestion: action.suggestion ?? null,
      review: review ?? { status: "no-patch", reason: action.reviewPatch ? "review-unavailable" : "not-proposed" },
    });
  }

  private async beginSkill(plan: Plan): Promise<void> {
    const skills = this.config.skills;
    const trial = this.config.trial;
    if (!skills || !trial || plan.proposal.action.kind !== "skill" || plan.generation === null ||
        this.skillCandidates >= this.limits.maxSkillCandidates || this.testedCandidates.size !== 0 ||
        skills.selection().generation !== plan.generation ||
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
    if (!current || !samePlayableScope(plan.observation, current) || current.tick >= plan.proposal.expiresTick) {
      this.ready = undefined;
      await this.rejectStale(plan, "scope_or_ttl_changed_before_handoff");
      if (ready.kind === "selection" && ready.selection.continuation) await this.finishSegment("stale_continuation");
      return;
    }
    if (!this.isCurrentHandoff(current)) return;
    const skills = this.config.skills;
    if (ready.kind === "selection") {
      this.ready = undefined;
      const selection = ready.selection;
      const { offer, basis: selectedAt, hash, generation, requiredOffer, continuation } = selection;
      if (continuation && this.segment !== continuation) return;
      if (!offer || offer.skillHash !== hash || !this.isSelectedSkill(hash, generation)) {
        await this.rejectStale(plan, "skill_selection_changed_before_handoff");
        if (continuation) await this.finishSegment("selection_changed");
        return;
      }
      const observed = selectedAt.opportunities.find(item => item.id === offer.opportunityId);
      if (!observed || observed.verb !== this.testedSkillVerbs.get(hash) || (requiredOffer && !sameOffer(requiredOffer, observed))) {
        await this.disposition("unproven_skill_effect_refused", { requestId: plan.requestId, hash });
        if (continuation) await this.finishSegment("unproven_effect");
        return;
      }
      if (!await this.issue(plan, selectedAt, offer.opportunityId, selection) && continuation) {
        await this.finishSegment("continuation_not_issued");
      }
      return;
    }
    if (plan.proposal.action.kind === "opportunity") {
      this.ready = undefined;
      await this.issue(plan, plan.observation, plan.proposal.action.opportunityId);
      return;
    }
    if (!skills || plan.generation === null || skills.selection().generation !== plan.generation) {
      this.ready = undefined;
      await this.rejectStale(plan, "skill_generation_changed_before_handoff");
      return;
    }
    if (ready.kind === "candidate") {
      this.ready = undefined;
      this.shadowCandidate(plan, ready.candidate, current);
      return;
    }
    if (ready.kind === "promotion") {
      const { candidate, offer } = ready;
      await this.refresh();
      const fresh = this.view!.observation;
      if (!this.isCurrentHandoff(fresh) || !samePlayableScope(current, fresh) || fresh.tick >= plan.proposal.expiresTick ||
          !sameOffer(offer, fresh.opportunities.find(item => item.id === offer.id))) {
        this.ready = undefined;
        await this.rejectStale(plan, "promotion_opportunity_changed_before_handoff");
        return;
      }
      if (!this.lease) {
        await this.requestHandoff(plan, fresh);
        return;
      }
      if (!this.isNeutralHandoff(fresh) || fresh.tick <= this.lease.value.basisTick) return;
      this.ready = undefined;
      if (!ready.neutralBasis) {
        // Quiescence is selector-visible. A pre-barrier digest cannot be
        // reused to admit source against the now-neutral projection.
        this.shadowCandidate(plan, candidate, fresh, offer);
        return;
      }
      if (!skills.promote(candidate.hash, plan.generation, fresh)) {
        await this.disposition("skill_promotion_refused", { requestId: plan.requestId, hash: candidate.hash });
        return;
      }
      this.testedSkillVerbs.set(candidate.hash, candidate.verb);
      this.testedCandidates.delete(candidate.hash);
      await this.record("skill_promoted", { requestId: plan.requestId, selection: skills.selection(), basis: basis(fresh), offer });
    } else this.ready = undefined;
    const { hash, generation } = skills.selection();
    if (!hash || !this.testedSkillVerbs.has(hash) || (ready.kind !== "promotion" && hash !== plan.selectedSkillHash)) {
      await this.disposition("skill_unavailable", { requestId: plan.requestId });
      return;
    }
    this.chooseSkill(plan, this.view!.observation, hash, generation, ready.kind === "promotion" ? ready.offer : undefined);
  }

  private shadowCandidate(plan: Plan, candidate: ProvenCandidate, observation: MacroObservation, barrierOffer?: MacroOpportunity): void {
    this.busy = { kind: "shadow", plan, candidate, barrierOffer, work: this.work(plan, this.limits.skillTimeoutMs, async signal => {
      const projection = await this.config.skills!.shadow(candidate.hash, observation, signal);
      return projection?.skillHash === candidate.hash ? observation.opportunities.find(offer =>
        offer.id === projection.opportunityId && offer.verb === candidate.verb && offer.risk !== "guarded") : undefined;
    }) };
  }

  private isSelectedSkill(hash: string, generation: number): boolean {
    const skills = this.config.skills;
    const active = skills?.selection();
    return active?.hash === hash && active.generation === generation && skills?.status(hash) === "active";
  }

  private chooseSkill(plan: Plan, current: MacroObservation, hash: string, generation: number,
    requiredOffer?: MacroOpportunity, continuation?: Segment): void {
    const previousReceipts = continuation ? Object.freeze([...continuation.receipts]) : undefined;
    this.busy = { kind: "selection", plan, continuation, work: this.work(plan, this.limits.skillTimeoutMs, async signal => ({
      hash, generation, basis: current, offer: await this.config.skills!.select(current, signal, previousReceipts),
      requiredOffer, continuation,
    })) };
  }

  private async advanceSegment(current: MacroObservation): Promise<void> {
    const segment = this.segment!;
    const last = segment.receipts.at(-1);
    if (!last || current.tick < last.tick || !this.isCurrentHandoff(current)) return;
    const verb = this.testedSkillVerbs.get(segment.hash);
    if (!current.opportunities.some(offer => offer.verb === verb && offer.risk !== "guarded" &&
        !segment.seen.has(digest(offer)))) {
      await this.finishSegment("no_new_safe_tested_opportunity");
      return;
    }
    // Rebase only the admitted function, never an old world target. The model's
    // lease, life and goal remain fixed for the whole invocation.
    const plan = { ...segment.plan, observation: current };
    this.chooseSkill(plan, current, segment.hash, segment.generation, undefined, segment);
  }

  private async finishSegment(reason: string): Promise<void> {
    const segment = this.segment;
    if (!segment) return;
    this.segment = undefined;
    if (this.busy?.kind === "selection" && this.busy.continuation === segment) {
      this.busy.work.cancel.abort(new Error(reason));
    }
    if (this.ready?.kind === "selection" && this.ready.selection.continuation === segment) this.ready = undefined;
    await this.record("skill_segment_finished", { requestId: segment.plan.requestId, hash: segment.hash, reason,
      issued: segment.effects, completed: segment.receipts.length, maxEffects: segment.maxEffects });
  }

  private async requestHandoff(plan: Plan, observation: MacroObservation): Promise<void> {
    const value = parseMacroHandoff({
      v: 1, run: observation.run, life: observation.life, epoch: observation.epoch, basisTick: observation.tick,
      expiresTick: Math.min(plan.proposal.expiresTick, observation.tick + MACRO_MAX_HANDOFF_TTL_TICKS),
    });
    await this.record("neutral_handoff_requested", { requestId: plan.requestId, handoff: value });
    if (!this.isCurrentHandoff(observation)) return;
    this.lease = { value, plan };
    await this.ipc!.write("handoff.json", value);
  }

  private async releaseHandoff(): Promise<void> {
    if (!this.lease) return;
    await this.ipc!.remove("handoff.json");
    this.lease = undefined;
  }

  private async issue(plan: Plan, witnessed: MacroObservation, opportunityId: string, selection?: Selection): Promise<boolean> {
    await this.refresh();
    const view = this.view!;
    const current = view.observation;
    const before = witnessed.opportunities.find(offer => offer.id === opportunityId);
    if (!before) {
      await this.disposition("proposal_refused", { requestId: plan.requestId, reason: "Opportunity was never offered on its basis." });
      return false;
    }
    const after = current.opportunities.find(offer => offer.id === opportunityId);
    if (!this.isCurrentHandoff(current) || !samePlayableScope(witnessed, current) || current.tick >= plan.proposal.expiresTick ||
        !sameOffer(before, after) || (selection && after?.risk === "guarded")) {
      await this.rejectStale(plan, "opportunity_no_longer_witnessed");
      return false;
    }
    const key = digest([current.life, current.epoch, current.goal, after]);
    const segmentKey = digest(after);
    if (this.effectKeys.has(key) || selection?.continuation?.seen.has(segmentKey)) {
      await this.disposition("duplicate_intent_refused", { requestId: plan.requestId, opportunityId });
      return false;
    }
    const intent = parseMacroIntent({
      v: 1, id: randomUUID(), run: current.run, life: current.life, epoch: current.epoch, basisTick: current.tick,
      expiresTick: Math.min(plan.proposal.expiresTick, current.tick + this.limits.maxIntentTtlTicks), opportunityId,
      skillHash: selection?.hash ?? null,
    });
    await this.record("intent_prepared", { requestId: plan.requestId, intent, witnessed: before });
    await this.refresh();
    const refreshed = this.view!.observation;
    if (!this.isCurrentHandoff(refreshed) || !samePlayableScope(current, refreshed) || refreshed.tick >= intent.expiresTick ||
        !sameOffer(after, refreshed.opportunities.find(offer => offer.id === opportunityId)) ||
        (selection && (!selection.offer || !this.isSelectedSkill(selection.hash, selection.generation) ||
          !this.config.skills!.matchesSelection(selection.offer, refreshed, selection.continuation?.receipts)))) {
      await this.rejectStale(plan, "intent_basis_changed_at_publication");
      return false;
    }
    const macro: Issued = { requestId: plan.requestId, intent, scope: refreshed, offer: after! };
    this.pending = macro;
    this.issued.set(intent.id, macro);
    this.effectKeys.add(key);
    await this.ipc!.write("intent.json", intent);
    this.episodeMemory.issued(plan.requestId);
    this.publishedIntents++;
    if (selection) {
      const segment = selection.continuation ?? {
        plan, hash: selection.hash, generation: selection.generation, maxEffects: this.limits.maxSkillEffects,
        health: refreshed.health, receipts: [], seen: new Set<string>(), effects: 0,
      };
      this.segment = segment;
      segment.health = refreshed.health;
      segment.effects++;
      segment.waiting = macro;
      segment.seen.add(segmentKey);
      await this.record("skill_segment_intent", { requestId: plan.requestId, hash: segment.hash, id: intent.id,
        step: segment.effects, maxEffects: segment.maxEffects, confirmedPriorEffects: segment.receipts.length });
    }
    await this.releaseHandoff();
    await this.disposition("intent_issued", { requestId: plan.requestId, id: intent.id });
    return true;
  }

  private async rejectStale(context: Decision, reason: string): Promise<void> {
    this.staleDecisions++;
    await this.disposition("stale", { requestId: context.requestId, reason });
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
    if (typeof fields.requestId === "string") this.episodeMemory.rejected(fields.requestId, event);
    const detail = FEEDBACK[event];
    if (detail && this.view) {
      const { observation, evidence } = this.view;
      this.feedback = { observation, value: Object.freeze({ kind: event, detail }) };
      this.view = { ...this.view, query: this.queryKey(observation, evidence) };
    }
  }

  private async revoke(): Promise<void> {
    const ipc = this.ipc;
    if (!ipc) return;
    if (this.pending) this.pending.withdrawn = true;
    const errors: unknown[] = [];
    try { await ipc.remove("active.json"); this.markerLive = false; } catch (error) { errors.push(error); }
    try { await ipc.remove("intent.json"); } catch (error) { errors.push(error); }
    try { await ipc.remove("handoff.json"); this.lease = undefined; } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Could not remove all native macro authority files.");
  }

  private async fail(error: unknown): Promise<void> {
    this.faulted = true;
    this.busy?.work.cancel.abort(error);
    this.lastDisposition = "protocol_fault";
    await this.record("protocol_fault", { reason: describe(error) }).catch(() => {});
    await this.revoke().catch(revokeError =>
      this.record("revocation_ipc_failure", { reason: describe(revokeError) }).catch(() => {}));
  }

  stop(): Promise<void> {
    return this.stopPromise ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    this.config.signal?.removeEventListener("abort", this.stopListener);
    if (this.timer) clearTimeout(this.timer);
    this.busy?.work.cancel.abort(new Error("Survival macro stopped."));
    await this.startPromise?.catch(() => {});
    await this.polling;
    try {
      if (this.history) {
        const pending = this.pending;
        const errors: unknown[] = [];
        const remember = async (error: unknown) => {
          errors.push(error);
          await this.record("shutdown_fault", { reason: describe(error) }).catch(() => {});
        };
        // Remove authority before joining any independent worker or waiting
        // for the runner's child drain. File removal alone is not evidence.
        try { await this.revoke(); } catch (error) {
          await this.record("revocation_ipc_failure", { reason: describe(error) }).catch(() => {});
        }
        this.pending = undefined;
        if (pending) {
          await this.disposition("intent_withdrawn", { reason: "stop", id: pending.intent.id }).catch(remember);
        }
        try { await this.confirmNativeRevocation(pending); } catch (error) { await remember(error); }
        await this.readReceipts(this.nativeAuthority === "revoked" || this.nativeAuthority === "exited").catch(remember);
        await this.finishSegment("run_stopped").catch(remember);
        const busy = this.busy;
        if (busy?.kind === "inference") {
          const grace = new AbortController();
          try {
            await Promise.race([busy.work.done, delay(2_000, undefined, { signal: grace.signal })]);
          } finally {
            grace.abort();
          }
        } else if (busy) await busy.work.done;
        if (this.busy?.work.result) await this.settle(this.view?.observation, false).catch(remember);
        this.ready = undefined;
        this.endedAt = performance.now();
        this.stopped = true;
        if (errors.length) this.faulted = true;
        for (const record of this.issued.values()) {
          if (!record.terminal) await this.record("intent_unresolved", { id: record.intent.id, accepted: !!record.accepted });
        }
        await this.record("stopped", { status: this.status(), unresolvedRequestId: this.busy?.work.context.requestId ?? null,
          unresolvedIntentId: pending && !pending.terminal ? pending.intent.id : null });
        if (errors.length) throw new AggregateError(errors, "Survival macro authority or evidence did not close cleanly.");
      }
    } catch (error) {
      this.faulted = true;
      throw error;
    } finally {
      this.endedAt ??= performance.now();
      this.stopped = true;
      await this.closeFiles();
    }
  }

  private async confirmNativeRevocation(pending: Issued | undefined): Promise<void> {
    if (this.nativeAuthority !== "unconfirmed") return;
    const ipc = this.ipc!;
    const latest = this.view?.observation;
    const minimumTick = Math.max(latest?.tick ?? 0, pending?.intent.basisTick ?? 0, pending?.accepted?.tick ?? 0);
    const minimumLife = Math.max(latest?.life ?? 0, pending?.intent.life ?? 0);
    const minimumEpoch = Math.max(latest?.epoch ?? 0, pending?.intent.epoch ?? 0);
    const fallback = this.config.confirmNativeExit;
    let exited = false;
    const exit = fallback ? Promise.resolve().then(fallback).then(value => (exited = value === true), () => false) : undefined;
    const until = performance.now() + 750;
    while (!exited && performance.now() < until) {
      try {
        const ack = await ipc.read("revoked.json", parseMacroRevocation);
        if (ack) {
          if (ack.run !== this.config.run || ack.life < minimumLife || ack.tick < minimumTick || ack.epoch < minimumEpoch) {
            throw new Error("Native revocation did not match the current run generation.");
          }
          this.nativeAuthority = "revoked";
          await this.record("native_revocation_confirmed", { acknowledgement: ack });
          return;
        }
      } catch (error) {
        await this.record("native_revocation_ack_failed", { reason: describe(error) }).catch(() => {});
        break;
      }
      await delay(25);
    }
    if (!exited && exit) {
      const grace = new AbortController();
      try { exited = await Promise.race([exit, delay(90_000, false, { signal: grace.signal })]); }
      finally { grace.abort(); }
    }
    if (!exited) throw new Error("Neither native neutrality nor exact owned Java exit confirmed macro revocation.");
    this.nativeAuthority = "exited";
    await this.record("native_revocation_confirmed", { exactOwnedJavaExit: true });
  }

  private async closeFiles(): Promise<void> {
    await Promise.allSettled([this.history?.close(), this.proposals?.close(), this.receipts?.close(), this.ipc?.close()]);
    this.history = this.proposals = this.receipts = undefined;
    this.ipc = undefined;
  }
}
