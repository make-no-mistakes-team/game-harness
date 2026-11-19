import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SURVIVAL_AGENT_GOALS, TERRA_MODEL_ID } from "../../shared/survival-agent-ui.ts";
import {
  bindFirstPlan, firstPlanScopeMatches, parseFirstPlanAdvice, PRE_SPAWN_GOAL_ONLY,
  type FirstPlanInference, type FirstPlanRequest, type FirstPlanStrategist,
} from "./bootstrap.ts";
import {
  MACRO_CAPABILITIES_VERSION, MACRO_MAX_HANDOFF_TTL_TICKS, MACRO_MAX_INTENT_TTL_TICKS, MACRO_MAX_PLAN_TTL_TICKS,
  MACRO_MAX_DIRECT_EFFECTS, MACRO_MAX_DIRECT_MS, MACRO_MAX_PLANNING_IDLE_MS, MACRO_LOOKAHEAD_MAX_AGE_TICKS, MACRO_LOOKAHEAD_MAX_CRACK,
  MacroDirectory, MacroObservationRotating,
  hasDirectAuthority, matchesMaterial, parseMacroHandoff, parseMacroIntent, parseMacroObservation, parseMacroPlanning,
  parseMacroProposal, parseMacroReceipt, parseMacroRevocation, parseMacroWorkOrder, validateMacroId,
  type MacroBasis, type MacroDirectAction, type MacroFeedback, type MacroFrame, type MacroHandoff, type MacroInference, type MacroIntent,
  type MacroLookahead, type MacroObservation, type MacroOpportunity, type MacroPlanning,
  type MacroProposal, type MacroReceipt, type MacroRequest, type MacroSkillReceipt, type MacroStockFloor,
  type MacroStrategist, type MacroSuccessor,
  type MacroTrigger, type MacroWorkDemand, type MacroWorkMode, type MacroWorkOrder, type MacroWorkPolicy, type MacroWorkStage,
  type NativeReceiptCursor,
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
const WORK_ADMISSION_TICKS = 40;
const WORK_REPLAN_GAP_TICKS = 80;
// Native views are published every 5 ticks. Permit at most two follow-up
// publications and a short wall-clock bound for the first rendered offer.
const FIRST_ACTIONABLE_VIEW_TICKS = 10;
const FIRST_ACTIONABLE_VIEW_MS = 600;

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
  /** Only ordinary, explicitly admitted Terra uses outcome-level jobs. */
  readonly durableWork?: boolean;
  readonly strategist?: MacroStrategist;
  readonly firstPlan?: { readonly request: FirstPlanRequest; readonly infer: FirstPlanStrategist };
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

interface WorkJobStatus {
  readonly id: string;
  readonly origin: MacroWorkOrder["origin"];
  readonly target: MacroWorkPolicy["target"];
  readonly requestId: string | null;
  readonly accepted: MacroReceipt | null;
  readonly terminal: MacroReceipt | null;
}

interface WorkProgramCompletion {
  readonly requestId: string;
  readonly stages: number;
  readonly goal: string;
  readonly invocationItemCount: number | null;
  readonly finalOrder: MacroWorkOrder;
  readonly accepted: MacroReceipt;
  readonly receipt: MacroReceipt;
  readonly basis: MacroBasis;
  readonly stock: readonly { readonly item: string; readonly required: number; readonly observed: number }[];
}

export interface MacroStatus {
  readonly strategy: SurvivalMacroConfig["strategy"];
  readonly state: MacroState;
  readonly models: readonly string[];
  readonly capabilitiesVersion: string;
  readonly limits: MacroLimits;
  readonly elapsedMs: number;
  readonly planningIdleMs: typeof MACRO_MAX_PLANNING_IDLE_MS;
  readonly planningEpisodeId: string | null;
  readonly directContinuation: { readonly requestId: string; readonly issued: number; readonly maxEffects: number } | null;
  readonly lookahead: { readonly predecessorId: string; readonly phase: "inferring" | "conditional" } | null;
  readonly workOrder: WorkJobStatus | null;
  readonly lastWorkOrder: WorkJobStatus | null;
  readonly issuedWorkOrders: number;
  readonly completedWorkOrders: number;
  readonly completedModelWorkOrders: number;
  readonly completedWorkPrograms: number;
  readonly completedWorkProgram: WorkProgramCompletion | null;
  readonly unresolvedWorkOrders: number;
  readonly workQueuedAfter: string | null;
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
  readonly lastProviderLatencyMs: number | null;
  readonly lastDisposition: string | null;
}

interface View {
  readonly observation: MacroObservation;
  readonly changedAt: number;
  readonly evidence: string;
  readonly query: string;
}

interface FirstPlanning {
  readonly requestId: string;
  readonly request: FirstPlanRequest;
  readonly startedAt: number;
  readonly until: number;
  readonly cancel: AbortController;
  readonly done: Promise<void>;
  first?: { readonly view: MacroObservation; readonly observedAt: number };
  actionable?: MacroObservation;
  result?: { readonly inference: FirstPlanInference | null; readonly settledAt: number;
    readonly advice: ReturnType<typeof parseFirstPlanAdvice> };
  dispatchedAt?: number;
  recorded?: true;
  rejection?: string;
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
  readonly lookahead?: Lookahead;
  readonly workDemand?: MacroWorkDemand;
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
  readonly reserves?: readonly MacroStockFloor[];
  readonly priorTargets?: ReadonlySet<string>;
  withdrawn?: true;
  lookedAhead?: true;
  accepted?: MacroReceipt;
  terminal?: MacroReceipt;
}

interface WorkJob {
  readonly order: MacroWorkOrder;
  readonly policy: MacroWorkPolicy;
  readonly source: MacroObservation;
  readonly requestId: string | null;
  health: number;
  bootstrap?: true;
  accepted?: MacroReceipt;
  terminal?: MacroReceipt;
  withdrawn?: true;
}

interface QueuedWork {
  readonly after: WorkJob | null;
  readonly plan: Plan;
  readonly stages: readonly MacroWorkStage[];
  readonly next: number;
}

function workStatus(job: WorkJob | undefined): WorkJobStatus | null {
  return job ? { id: job.order.id, origin: job.order.origin, target: job.policy.target, requestId: job.requestId,
    accepted: job.accepted ?? null, terminal: job.terminal ?? null } : null;
}

interface Lookahead {
  readonly origin: Issued;
  readonly evidence: MacroLookahead;
  readonly workingBasis: MacroObservation;
  health: number;
  lastWorkingTick: number;
  lastWorkingSeenAt: number;
}

interface Conditional {
  readonly lookahead: Lookahead;
  readonly plan: Plan;
  readonly action: MacroSuccessor;
  readonly offer: MacroOpportunity;
  readonly providerStartedAt: number | null;
  readonly settledAt: number;
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

interface DirectContinuation {
  readonly plan: Plan;
  readonly action: MacroDirectAction;
  readonly until: number;
  readonly maxEffects: number;
  readonly usedIds: Set<string>;
  readonly usedTargets: Set<string>;
  health: number;
  stage: number;
  stageEffects: number;
  issued: number;
  completed: number;
  waiting?: Issued;
  completedAction?: Issued;
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
    left.risk === right.risk && left.evidence === right.evidence && sameMaterial(left.material, right.material);
}

function sameMaterial(left: MacroOpportunity["material"], right: MacroOpportunity["material"]): boolean {
  if (!left || !right) return left === right;
  return left.subject === right.subject && left.target === right.target &&
    Object.keys(left.spends).length === Object.keys(right.spends).length &&
    Object.entries(left.spends).every(([item, count]) => right.spends[item] === count);
}

function stock(observation: MacroObservation, item: string): number {
  return observation.inventory[item] ?? 0;
}

function protectsStock(reserves: readonly MacroStockFloor[], observation: MacroObservation, offer: MacroOpportunity): boolean {
  const costs = offer.material?.spends;
  return !!costs && reserves.every(({ item, count }) => stock(observation, item) - (costs[item] ?? 0) >= count);
}

function successorStock(conditional: Conditional, current: MacroObservation, offer: MacroOpportunity): boolean {
  return conditional.action.requires.every(({ item, count }) => stock(current, item) >= count) &&
    protectsStock(conditional.lookahead.evidence.reserves, current, offer) &&
    protectsStock(conditional.action.reserves, current, offer);
}

function successorScope(conditional: Conditional, current: MacroObservation, now = performance.now()): boolean {
  return now - conditional.settledAt < MACRO_MAX_DIRECT_MS &&
    current.tick < conditional.plan.proposal.expiresTick && lookaheadScope(conditional.lookahead, current);
}

function lookaheadScope(lookahead: Lookahead, current: MacroObservation): boolean {
  const { origin, workingBasis, health } = lookahead;
  return !origin.withdrawn && (!origin.terminal || origin.terminal.status === "completed") &&
    sameGoalAndLife(workingBasis, current) && alive(current) && current.health >= health && current.safety?.clear === true &&
    current.safety.revision === workingBasis.safety?.revision &&
    (!current.working || current.working.intentId === origin.intent.id) &&
    (origin.terminal !== undefined || current.epoch === origin.intent.epoch);
}

function directConditions(direct: DirectContinuation, observation: MacroObservation): boolean {
  const until = direct.action.steps[direct.stage]!.until;
  const prior = direct.stageEffects === 0 ? direct.action.steps[direct.stage - 1]?.until : null;
  return (!until || stock(observation, until.item) < until.count) &&
    (!prior || stock(observation, prior.item) >= prior.count);
}

function directScope(direct: DirectContinuation, observation: MacroObservation, now = performance.now()): boolean {
  const initial = direct.plan.observation;
  return now < direct.until && observation.tick < direct.plan.proposal.expiresTick &&
    sameGoalAndLife(initial, observation) && alive(observation) && observation.health >= direct.health &&
    observation.safety?.clear === true && observation.safety.revision === initial.safety?.revision;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function guardBand(value: number): number {
  return value <= 0 ? 0 : value <= 6 ? 1 : value <= 12 ? 2 : 3;
}

function orderedOpportunities(observation: MacroObservation): MacroOpportunity[] {
  return [...observation.opportunities].sort((a, b) => a.id.localeCompare(b.id));
}

function evidenceKey(observation: MacroObservation): string {
  return digest([
    observation.life, observation.epoch, observation.goal, guardBand(observation.health), guardBand(observation.food),
    Object.entries(observation.inventory).sort(([a], [b]) => a.localeCompare(b)),
    orderedOpportunities(observation), observation.quiescent,
    [...new Set(observation.recent)].sort(),
  ]);
}

function alive(observation: MacroObservation): boolean {
  return observation.health > 0;
}

function workScope(initial: MacroObservation, current: MacroObservation, health = initial.health): boolean {
  return sameGoalAndLife(initial, current) && alive(current) && current.health >= health &&
    current.safety?.clear === true && current.safety.revision === initial.safety?.revision;
}

function workPolicyKey(policy: MacroWorkPolicy): string {
  return digest([
    policy.target, policy.allowedEffects, policy.costCaps, policy.reserves,
    policy.maxBreaks, policy.maxCrafts, policy.maxPlacements,
  ]);
}

function hasStock(observation: MacroObservation, required: readonly MacroStockFloor[]): boolean {
  return required.every(({ item, count }) => stock(observation, item) >= count);
}

function confirmsWorkStock(observation: MacroObservation, { target, reserves }: MacroWorkPolicy): boolean {
  return (target.kind === "preset" || stock(observation, target.item) >= target.count) && hasStock(observation, reserves);
}

function workEvidence(observation: MacroObservation, lastReceipt: MacroReceipt | null): string {
  return digest([observation.run, observation.life, observation.goal, observation.safety,
    lastReceipt?.life === observation.life ? lastReceipt.id : null,
    Object.entries(observation.inventory).sort(([a], [b]) => a.localeCompare(b))]);
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
  private readonly workMode?: MacroWorkMode;
  private readonly marker: Readonly<Record<string, string | number>>;
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
  private lastProviderLatencyMs: number | null = null;
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
  private readonly jobs = new Map<string, WorkJob>();
  private job?: WorkJob;
  /** Until candidate acceptance, native still owns this exact older lease. */
  private previousJob?: WorkJob;
  private queuedWork?: QueuedWork;
  private newestJob?: WorkJob;
  private lastAcceptedJob?: WorkJob;
  private lastJobOutcome?: WorkJob;
  private workQuery?: { readonly key: string; readonly tick: number; readonly evidence: string; abstained?: true };
  private readonly workHandoffQueries = new Set<string>();
  private floorScope?: { readonly life: number; readonly reserves: readonly MacroStockFloor[] };
  private completedWorkOrders = 0;
  private completedModelWorkOrders = 0;
  private completedWorkPrograms = 0;
  private completedWorkProgram: WorkProgramCompletion | null = null;
  private settledWorkOrders = 0;
  private bootstrappedWork = false;
  private firstPlanning?: FirstPlanning;
  private segment?: Segment;
  private direct?: DirectContinuation;
  private conditional?: Conditional;
  private lease?: { readonly value: MacroHandoff; readonly plan: Plan };
  private planning?: { readonly notice: MacroPlanning; readonly startedAt: number };
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
    if (config.durableWork && config.strategy === "terra") this.workMode = this.objective ? "constrained" : "preset";
    this.marker = { v: 1, run: config.run, ...(this.workMode ? { workMode: this.workMode } : {}) };
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
        directContinuationLimits: { maxEffects: MACRO_MAX_DIRECT_EFFECTS, maxWallMs: MACRO_MAX_DIRECT_MS },
        planningIdleMs: MACRO_MAX_PLANNING_IDLE_MS,
        workMode: this.workMode ?? null,
        authoring: !!(this.config.skills && this.config.trial && this.limits.maxSkillCandidates), objective: this.objective ?? null,
        admittedSkillVerbs: this.config.skills?.allowedVerbs() ?? [],
      });
      if (this.unavailable) await this.disposition("provider_unavailable", { reason: "No admitted Terra strategist." });
      this.config.signal?.throwIfAborted();
      this.markerLive = true;
      await this.ipc.write("active.json", this.marker);
      this.nativeAuthority = "unconfirmed";
      this.config.signal?.addEventListener("abort", this.stopListener, { once: true });
      if (this.config.signal?.aborted) this.stopListener();
      if (this.workMode && this.config.strategist && this.config.firstPlan &&
          this.capabilitiesVersion === MACRO_CAPABILITIES_VERSION) await this.beginFirstPlan(this.config.firstPlan);
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
      this.pending || this.segment || (this.previousJob ?? this.job)?.accepted ? "executing" :
      this.busy?.kind === "inference" || (this.firstPlanning && !this.firstPlanning.result) ? "inferring" :
      this.busy?.kind === "trial" ? "testing-skill" : this.ready || this.busy || this.direct ? "awaiting-handoff" :
      this.budget ? "budget-limited" : this.unavailable ? "provider-unavailable" : "waiting";
    return {
      strategy: this.config.strategy, state, capabilitiesVersion: this.capabilitiesVersion, limits: this.limits,
      models: [...this.models], elapsedMs: this.startedAt === undefined ? 0 : Math.round((this.endedAt ?? performance.now()) - this.startedAt),
      planningIdleMs: MACRO_MAX_PLANNING_IDLE_MS, planningEpisodeId: this.planning?.notice.id ?? null,
      directContinuation: this.direct ? { requestId: this.direct.plan.requestId, issued: this.direct.issued,
        maxEffects: this.direct.maxEffects } : null,
      lookahead: this.conditional ? { predecessorId: this.conditional.lookahead.origin.intent.id, phase: "conditional" } :
        this.busy?.kind === "inference" && this.busy.work.context.lookahead ?
          { predecessorId: this.busy.work.context.lookahead.origin.intent.id, phase: "inferring" } : null,
      workOrder: workStatus(this.previousJob ?? this.job), lastWorkOrder: workStatus(this.lastAcceptedJob ?? this.newestJob),
      issuedWorkOrders: this.jobs.size, completedWorkOrders: this.completedWorkOrders,
      completedModelWorkOrders: this.completedModelWorkOrders,
      completedWorkPrograms: this.completedWorkPrograms,
      completedWorkProgram: this.completedWorkProgram,
      unresolvedWorkOrders: this.jobs.size - this.settledWorkOrders,
      workQueuedAfter: this.queuedWork?.after?.order.id ?? null,
      requests: this.requests, providerDispatches: this.providerDispatches, unreportedDispatches: this.unreportedDispatches,
      skillCandidates: this.skillCandidates, staleDecisions: this.staleDecisions, issued: this.publishedIntents,
      terminalReceipts: this.terminalReceipts, completedReceipts: this.completedReceipts,
      lateCompletedReceipts: this.lateCompletedReceipts, unresolvedIntents: this.issued.size - this.terminalReceipts,
      nativeAuthority: this.nativeAuthority,
      budget: this.budget, lastReceipt: this.lastReceipt, lastProviderOutcome: this.lastProviderOutcome, lastDisposition: this.lastDisposition,
      lastProviderLatencyMs: this.lastProviderLatencyMs,
    };
  }

  isNeutralHandoff(observation: MacroObservation): boolean {
    return this.isCurrentHandoff(observation) && observation.quiescent;
  }

  private isCurrentHandoff(observation: MacroObservation): boolean {
    const now = performance.now();
    const native = observation.workOrder;
    return this.markerLive && !this.closing && !this.faulted && !this.pending && !this.job &&
      (!native || (native.state !== "working" && (native.state !== "needs_replan" || !!this.jobs.get(native.id)?.terminal))) &&
      this.view?.observation === observation &&
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
    const marker = this.marker;
    if (!active || typeof active !== "object" || Object.keys(active).length !== Object.keys(marker).length ||
        Object.entries(marker).some(([key, value]) => (active as Record<string, unknown>)[key] !== value)) {
      throw new Error("Survival macro active marker was revoked or changed.");
    }
    if (await ipc.read("revoked.json", parseMacroRevocation)) {
      throw new Error("Native macro authority was unexpectedly revoked.");
    }
    const observed = await this.refresh();
    await this.readReceipts();
    if (this.closing) return;
    const [mailbox, barrier, planning, order] = await Promise.all([
      ipc.read("intent.json", parseMacroIntent), ipc.read("handoff.json", parseMacroHandoff), ipc.read("planning.json", parseMacroPlanning),
      this.workMode ? ipc.read("work.json", parseMacroWorkOrder) : null,
    ]);
    if (mailbox ? !this.pending || digest(mailbox) !== digest(this.pending.intent) : !!this.pending) {
      throw new Error("Survival macro intent mailbox changed outside its owner.");
    }
    if (barrier ? !this.lease || digest(barrier) !== digest(this.lease.value) : !!this.lease) {
      throw new Error("Survival macro handoff mailbox changed outside its owner.");
    }
    if (planning ? !this.planning || digest(planning) !== digest(this.planning.notice) : !!this.planning) {
      throw new Error("Survival macro planning notice changed outside its owner.");
    }
    if (order ? !this.job || digest(order) !== digest(this.job.order) : !!this.job) {
      throw new Error("Survival macro work mailbox changed outside its owner.");
    }
    const now = performance.now();
    const view = this.view;
    const current = view && now - this.observedAt <= this.limits.maxObservationAgeMs ? view.observation : undefined;
    const runtimeExpired = now - this.startedAt! >= this.limits.maxRuntimeMs;
    if (this.firstPlanning) {
      await this.advanceFirstPlan(current, !!observed, runtimeExpired ? "runtime_wall_limit" : undefined);
      // A single provider slot is shared across both stages, even while abort
      // is draining. An admitted first job is handled on the next poll.
      if (this.firstPlanning || this.job || this.closing) return;
    }
    const job = this.job;
    if (job) {
      if (runtimeExpired || !current || !workScope(job.source, current, job.health) || current.tick >= job.order.expiresTick) {
        if (runtimeExpired || !current || !await this.restorePreviousWork(job, current, "candidate_scope_safety_or_ttl_changed")) {
          await this.withdrawWork(runtimeExpired ? "runtime_wall_limit" : "work_scope_safety_or_ttl_changed");
        }
      } else if (!job.accepted && current.tick - job.order.basisTick >= WORK_ADMISSION_TICKS) {
        if (!await this.restorePreviousWork(job, current, "native_work_admission_unconfirmed")) {
          await this.withdrawWork("native_work_admission_unconfirmed");
        }
      } else {
        job.health = current.health;
        if (this.previousJob) this.previousJob.health = Math.max(this.previousJob.health, current.health);
      }
    }

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
    const direct = this.direct;
    if (direct) {
      if (runtimeExpired || !current || !directScope(direct, current, now)) {
        const reason = runtimeExpired ? "runtime_wall_limit" : "direct_scope_safety_or_ttl_changed";
        if (this.pending && this.pending === direct.waiting) await this.withdraw(reason);
        else await this.finishDirect(reason);
      } else {
        direct.health = current.health;
      }
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
    const lookahead = this.conditional?.lookahead ??
      (this.busy?.kind === "inference" ? this.busy.work.context.lookahead : undefined);
    const lookaheadStale = !!lookahead && (!current || !lookaheadScope(lookahead, current));
    if (lookahead && current && observed && !lookaheadStale) {
      lookahead.health = current.health;
      if (current.working?.intentId === lookahead.origin.intent.id && current.tick > lookahead.lastWorkingTick) {
        lookahead.lastWorkingTick = current.tick;
        lookahead.lastWorkingSeenAt = this.observedAt;
      }
    }
    if (this.conditional && (runtimeExpired || lookaheadStale || !successorScope(this.conditional, current!, now))) {
      await this.finishLookahead(this.conditional, runtimeExpired ? "runtime_wall_limit" :
        lookaheadStale ? "predecessor_scope_lost" : "condition_expired");
    }
    if (this.busy && !this.busy.work.cancel.signal.aborted) {
      const work = this.busy.work;
      // Candidate-only validation is independent of the ordinary plan. Never
      // cancel it merely because the player moved or the old action expired.
      const stale = this.busy.kind !== "trial" && (!current ||
        (this.busy.kind === "inference"
          ? work.context.lookahead ? lookaheadStale : work.context.workDemand ? !workScope(work.context.observation, current) :
            !sameGoalAndLife(work.context.observation, current) || !alive(current)
          : !samePlayableScope(work.context.observation, current) || current.tick >= this.busy.plan.proposal.expiresTick));
      if (runtimeExpired || stale || (!work.result && now >= work.until)) {
        work.cancel.abort(new Error(runtimeExpired ? "runtime_wall_limit" : stale ? "stale_scope" : "work_timeout"));
        await this.record("work_cancelled", { requestId: work.context.requestId, kind: this.busy.kind,
          reason: describe(work.cancel.signal.reason) });
      }
    }
    if (this.planning && this.busy?.kind === "inference") {
      const { work } = this.busy;
      if (work.result) await this.endPlanning("settled");
      else if (work.cancel.signal.aborted) await this.endPlanning("cancelled");
      else if (!current || (work.context.lookahead ? lookaheadStale : work.context.workDemand ?
        !workScope(work.context.observation, current) : !samePlayableScope(work.context.observation, current)))
        await this.endPlanning("stale_scope");
    }
    // A displaced observation must not trigger dispatch, promotion, segment
    // continuation or effect publication from the cached view. Housekeeping
    // above can still enforce timeouts; retain a settled result for the retry.
    if (!observed && current && !runtimeExpired) return;
    if (this.busy?.work.result) await this.settle(current, runtimeExpired);
    if (this.queuedWork) await this.advanceQueuedWork(current, runtimeExpired);
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
    if (this.closing || this.busy || this.ready || this.queuedWork || !current) return;
    if (this.pending) {
      if (!this.conditional) await this.tryLookahead(view!);
      return;
    }
    if (this.direct) {
      await this.advanceDirect(current);
      if (this.direct || !this.conditional || this.pending) return;
    }
    if (this.segment) {
      await this.advanceSegment(current);
      return;
    }
    if (this.conditional) {
      await this.advanceLookahead(current);
      if (this.conditional || this.pending) return;
    }
    if (this.workMode === "preset" && !this.bootstrappedWork && !this.job && this.config.strategist &&
        !this.unavailable && alive(current) && current.safety?.clear === true) {
      this.bootstrappedWork = true;
      const goal = SURVIVAL_AGENT_GOALS.find(goal => goal === current.goal);
      // The already-authorized built-in opening does not spend a model request.
      if (goal) await this.publishWork(current, {
        target: { kind: "preset", goal }, allowedEffects: [], costCaps: [],
        reserves: this.floorScope?.life === current.life ? this.floorScope.reserves : [],
        maxBreaks: 32, maxCrafts: 24, maxPlacements: 2,
      }, "preset", null, current.tick + this.limits.maxIntentTtlTicks);
      if (this.job) return;
    }
    if (this.requests >= this.limits.maxRequests) {
      if (!this.budget) {
        this.budget = "requests";
        await this.disposition("budget_limited", { budget: this.budget });
      }
      return;
    }
    // The journal can retire an effect before observation.json reaches its
    // terminal tick. Do not spend a decision on a pre-effect view plus its outcome.
    if (!this.job && current.tick <= this.handoffAfterTick) return;
    if (this.workMode) {
      await this.scheduleWork(this.view!);
      return;
    }
    if (!this.config.strategist || !alive(current) || current.safety?.clear === false ||
        (!current.quiescent && !current.opportunities.length)) return;
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

  private get renewLeadTicks(): number {
    return Math.ceil(this.limits.requestTimeoutMs / 50) + 40;
  }

  private async beginFirstPlan({ request, infer }: NonNullable<SurvivalMacroConfig["firstPlan"]>): Promise<void> {
    if (this.closing || this.config.signal?.aborted || this.requests >= this.limits.maxRequests ||
        request.objective !== this.objective || !SURVIVAL_AGENT_GOALS.includes(request.goal)) return;
    const requestId = randomUUID();
    await this.record("first_plan_requested", { requestId, stage: PRE_SPAWN_GOAL_ONLY, goal: request.goal, basis: null });
    const startedAt = performance.now();
    const until = Math.min(startedAt + this.limits.requestTimeoutMs, this.startedAt! + this.limits.maxRuntimeMs);
    if (this.closing || this.config.signal?.aborted || startedAt >= until) {
      await this.record("first_plan_rejected", { requestId, stage: PRE_SPAWN_GOAL_ONLY, basis: null,
        reason: this.closing || this.config.signal?.aborted ? "stop" : "runtime_wall_limit" });
      return;
    }
    const cancel = new AbortController();
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(Math.ceil(until - startedAt))]);
    const done = Promise.resolve().then(() => infer(request, signal, dispatchedAt => {
      if (work.dispatchedAt !== undefined || positiveFinite(dispatchedAt) === null) return;
      work.dispatchedAt = dispatchedAt;
      this.providerDispatches++;
      void this.record("first_plan_dispatched", {
        requestId, stage: PRE_SPAWN_GOAL_ONLY, basis: null, providerStartedAtMs: dispatchedAt,
      }).catch(() => { /* The settled or unresolved request records the transport evidence again. */ });
    })).then(inference => {
      const advice = inference.stage === PRE_SPAWN_GOAL_ONLY && inference.model === TERRA_MODEL_ID &&
        inference.dispatched === true && inference.outcome === "completed" ? parseFirstPlanAdvice(inference.proposal) : null;
      work.result = { inference, advice, settledAt: performance.now() };
    }, () => { work.result = { inference: null, advice: null, settledAt: performance.now() }; });
    const work: FirstPlanning = { requestId, request, startedAt, until, cancel, done };
    this.requests++;
    this.unreportedDispatches++;
    this.firstPlanning = work;
  }

  private async advanceFirstPlan(current: MacroObservation | undefined, observed: boolean, terminal?: string): Promise<void> {
    const work = this.firstPlanning!;
    const { requestId, request } = work;
    const scope = { requestId, stage: PRE_SPAWN_GOAL_ONLY };
    const now = performance.now();
    if (observed && current) work.first ??= { view: current, observedAt: this.observedAt };
    const first = work.first?.view;
    const inViewWindow = !!first && !!current && now - work.first!.observedAt <= FIRST_ACTIONABLE_VIEW_MS &&
      current.tick - first.tick <= FIRST_ACTIONABLE_VIEW_TICKS;
    if (terminal || this.closing || this.config.signal?.aborted) work.rejection = terminal ?? "stop";
    else if (first && (!current || !firstPlanScopeMatches(request, first, current, this.config.run)))
      work.rejection ??= current ? "live_scope_changed" : "live_observation_stale";
    else if ((!work.result && now >= work.until) || (work.result && work.result.settledAt > work.until))
      work.rejection ??= "request_timeout";
    else if (!work.actionable && observed && inViewWindow && current?.opportunities.length)
      work.actionable = current;
    if (first && !work.actionable && !inViewWindow && !work.result)
      work.rejection ??= "first_actionable_view_deadline";
    if (work.rejection && !work.result) work.cancel.abort();
    const result = work.result;
    if (!result) return;

    const { inference, advice } = result;
    const modelMatches = inference?.stage === PRE_SPAWN_GOAL_ONLY && inference.model === TERRA_MODEL_ID;
    if (!work.recorded) {
      const dispatched = work.dispatchedAt !== undefined ? true : inference?.dispatched ?? null;
      await this.append(this.proposals, {
        ...scope, basis: null, goal: request.goal, model: modelMatches ? inference.model : null,
        usage: usageEvidence(inference?.usage ?? null), costUsd: positiveFinite(inference?.costUsd),
        providerOutcome: inference?.outcome ?? null, dispatched,
        latencyMs: Math.round(result.settledAt - work.startedAt), providerLatencyMs: positiveFinite(inference?.latencyMs),
        providerStartedAtMs: work.dispatchedAt ?? positiveFinite(inference?.providerStartedAtMs), localSettledAtMs: result.settledAt,
        disposition: advice?.kind ?? (inference?.outcome === "completed" ? "invalid" : inference?.outcome ?? "provider_error"),
        proposal: advice,
      });
      work.recorded = true;
      if (dispatched !== null) {
        this.unreportedDispatches--;
        if (dispatched && work.dispatchedAt === undefined) this.providerDispatches++;
      }
      if (modelMatches) this.models.add(inference.model);
      if (inference) {
        this.lastProviderOutcome = inference.outcome;
        this.lastProviderLatencyMs = positiveFinite(inference.latencyMs);
      }
    }

    const reject = async (reason: string, latest = current) => {
      this.firstPlanning = undefined;
      if (reason === "live_scope_changed" || reason === "live_observation_stale" || reason === "fresh_binding_changed")
        this.staleDecisions++;
      await this.disposition("first_plan_rejected", { ...scope, basis: latest ? basis(latest) : null,
        firstBasis: first ? basis(first) : null, reason,
        ...(advice?.kind === "defer" && advice.category ? { deferCategory: advice.category } : {}) });
    };
    if (work.rejection) return reject(work.rejection);
    if (!advice || advice.kind === "defer") {
      return reject(advice ? "model_deferred" : !inference ? "provider_error" :
        inference.outcome === "completed" ? "invalid" : inference.outcome);
    }
    if (!current || !first) return;
    const bindingScope = {
      run: this.config.run, first, protectedReserves: this.floorScope?.life === first.life ? this.floorScope.reserves : [],
    };
    const actionable = work.actionable;
    if (!actionable) {
      // Even before rendering, native inventory is real. Do not wait for an
      // explicitly false condition, nor use a view arriving after this window.
      const check = bindFirstPlan(request, advice, current, bindingScope);
      if ("reason" in check && (check.reason === "stock_prerequisite_missing" || check.reason === "protected_stock_missing"))
        return reject(check.reason);
      if (!inViewWindow) return reject("first_actionable_view_deadline");
      return;
    }
    if (!observed) return;
    const original = bindFirstPlan(request, advice, actionable, bindingScope);
    if ("reason" in original) return reject(original.reason);
    const key = workPolicyKey(original.policy);
    let bound = original;
    let freshRejection: string | undefined;
    const job = await this.publishWork(actionable, original.policy, "model", requestId, actionable.tick + this.limits.maxIntentTtlTicks,
      original.requires, undefined, fresh => {
        if (this.job || performance.now() - this.observedAt > this.limits.maxObservationAgeMs) {
          freshRejection = this.job ? "native_work_incumbent" : "live_observation_stale";
          return false;
        }
        const binding = bindFirstPlan(request, advice, fresh, bindingScope, original.branchIndex);
        if ("reason" in binding || binding.input !== original.input || workPolicyKey(binding.policy) !== key) {
          freshRejection = "reason" in binding ? binding.reason : "fresh_binding_changed";
          return false;
        }
        bound = binding;
        return true;
      });
    if (!job) return reject(freshRejection ?? (this.closing || this.config.signal?.aborted ? "stop" :
      job === null ? "live_observation_rotating" : "fresh_work_admission_rejected"), this.view?.observation);
    job.bootstrap = true;
    this.firstPlanning = undefined;
    const usedAt = performance.now();
    await this.record("first_plan_bound", {
      ...scope, id: job.order.id, basis: basis(job.source), firstBasis: basis(first), actionableBasis: basis(actionable),
      branchIndex: bound.branchIndex, branchCount: advice.branches.length, input: bound.input, liveTargets: bound.liveTargets,
      disposition: "work_order_published", nativeAccepted: false,
      timeToFirstUseMs: Math.round(usedAt - (work.dispatchedAt ?? inference?.providerStartedAtMs ?? work.startedAt)),
      firstLiveToFirstUseMs: Math.round(usedAt - work.first!.observedAt),
    });
  }

  private async scheduleWork(view: View): Promise<void> {
    const { observation } = view;
    if (!this.config.strategist || this.unavailable || !alive(observation) || observation.safety?.clear !== true) return;
    const job = this.job;
    const complete = this.completedWorkProgram;
    if (!job && complete?.finalOrder.target.kind === "preset" &&
        complete.basis.life === observation.life && complete.goal === observation.goal) return;
    if (this.previousJob) return; // A published candidate has not settled; the incumbent remains authoritative.
    const nativeState = job && observation.workOrder?.id === job.order.id ? observation.workOrder : null;
    const previous = this.workQuery;
    const replan = nativeState?.progress?.replan;
    const needsRenewal = !!job && (replan === "expiry_near" || job.order.expiresTick - observation.tick <= this.renewLeadTicks);
    const target = job?.policy.target;
    const lastEffect = nativeState?.progress?.lastEffect;
    const productive = !!lastEffect && observation.tick - lastEffect.tick <= 120;
    let nearStockTarget = false;
    if (job?.accepted && target?.kind === "stock") {
      const observed = stock(observation, target.item);
      const prior = stock(job.source, target.item);
      const remaining = target.count - observed;
      nearStockTarget = observed > prior && remaining > 0 && (remaining <= 2 ||
        remaining <= Math.ceil((target.count - prior) / 2));
    }
    const preparingCraftResult = replan === "target_near" && nativeState?.progress?.phase === "craft";
    const nextCourse = nearStockTarget || preparingCraftResult || (productive && (replan === "target_near" || replan === "cap_near"));
    if (job && !job.accepted && observation.tick - job.order.basisTick < WORK_ADMISSION_TICKS / 2) return;
    // New targets and camera sweeps on a productive live job are not replan demand.
    if (previous && job && !needsRenewal && !nextCourse) return;
    const outcome = this.lastJobOutcome && sameGoalAndLife(this.lastJobOutcome.source, observation) ? this.lastJobOutcome : undefined;
    const outcomeState = outcome && outcome.order.id === observation.workOrder?.id ? observation.workOrder : null;
    const evidence = workEvidence(observation, this.lastReceipt);

    let demand: MacroWorkDemand["demand"];
    let key: string;
    if (!previous) {
      demand = "first";
      key = needsRenewal ? `renew:${job!.order.id}` : `first:${observation.life}`;
    } else if (nextCourse) {
      demand = "successor";
      key = `successor:${job!.order.id}`;
    } else if (needsRenewal) {
      demand = "renew";
      key = `renew:${job!.order.id}`;
    } else if (outcome?.terminal && observation.tick >= outcome.terminal.tick) {
      demand = outcomeState?.state === "blocked" || outcome.terminal.status === "refused" ? "blocked" : "outcome";
      key = digest([observation.life, demand, workPolicyKey(outcome.policy), outcome.terminal.status, outcome.terminal.detail, evidence]);
    } else {
      demand = "changed";
      key = evidence;
    }
    if (previous && observation.tick - previous.tick < WORK_REPLAN_GAP_TICKS && demand !== "renew") return;
    const unchanged = previous && (key === previous.key || (!job && demand === "changed" && previous.evidence === evidence));
    // A durable demand can stay unchanged while an abstention's premise gains
    // a witnessed option or a neutral handoff. Use the live view after settlement.
    if (unchanged) {
      const asked = this.lastAsked?.observation;
      if (job || !previous.abstained || !asked ||
          (!(observation.quiescent && !asked.quiescent) && !observation.opportunities.some(offer =>
            !sameOffer(offer, asked.opportunities.find(prior => prior.id === offer.id))))) return;
    }
    const handoffQuery = !job && (observation.quiescent || observation.opportunities.length > 0)
      ? digest([evidence, observation.quiescent, orderedOpportunities(observation)]) : null;
    if (unchanged && (!handoffQuery || this.workHandoffQueries.has(handoffQuery))) return;
    if (handoffQuery) this.workHandoffQueries.add(handoffQuery);
    this.workQuery = { key, tick: observation.tick, evidence };
    await this.begin(view, undefined, {
      mode: this.workMode!, demand,
      protectedReserves: this.floorScope?.life === observation.life ? this.floorScope.reserves : [],
      current: job ? { id: job.order.id, origin: job.order.origin, policy: job.policy,
        expiresTick: job.order.expiresTick, accepted: job.accepted ?? null, nativeState } : null,
      lastOutcome: outcome?.terminal ? { id: outcome.order.id, policy: outcome.policy,
        receipt: outcome.terminal, nativeState: outcomeState } : null,
    });
  }

  private async advanceQueuedWork(current: MacroObservation | undefined, runtimeExpired: boolean): Promise<void> {
    const queued = this.queuedWork!;
    const { after, plan, stages, next } = queued;
    const terminal = after?.terminal;
    let reason: string;
    if (runtimeExpired || this.closing || !current || !workScope(plan.observation, current) ||
        current.tick >= plan.proposal.expiresTick || after?.withdrawn) reason = "scope_or_ttl_changed";
    else if (!after) {
      await this.startWorkStage(queued);
      return;
    } else if (!terminal || current.tick < terminal.tick) return;
    else if (terminal.status !== "completed" || !after.accepted || this.job) reason = "predecessor_did_not_complete";
    else if (!confirmsWorkStock(current, after.policy)) reason = "predecessor_stock_not_confirmed";
    else {
      if (next === stages.length) {
        this.queuedWork = undefined;
        this.completedWorkPrograms++;
        const target = after.policy.target;
        const checked = target.kind === "stock" ? [...after.policy.reserves, target] : after.policy.reserves;
        const completed: WorkProgramCompletion = {
          requestId: plan.requestId, stages: next, goal: current.goal, finalOrder: after.order,
          invocationItemCount: SURVIVAL_AGENT_GOALS.some(goal => goal !== "nether_portal" && goal === current.goal)
            ? stock(current, `minecraft:${current.goal}`) : null,
          accepted: after.accepted, receipt: terminal, basis: basis(current),
          stock: checked.map(({ item, count }) => ({ item, required: count, observed: stock(current, item) })),
        };
        this.completedWorkProgram = completed;
        await this.record("work_program_completed", { ...completed });
      } else await this.startWorkStage(queued);
      return;
    }
    this.queuedWork = undefined;
    await this.record("work_successor_discarded", { requestId: plan.requestId, afterWorkId: after?.order.id ?? null, stage: next + 1, reason });
  }

  private async startWorkStage({ plan, stages, next: index, after }: QueuedWork): Promise<void> {
    const { policy, requires } = stages[index]!;
    const successor = stages[index + 1]?.policy;
    // Only IDs are announced ahead of time; later policy and stock still go through ordinary admission.
    const stage = stages.length > 1 ? { id: `${plan.requestId}:${index + 1}`,
      nextWorkId: successor && successor.maxCrafts > 0 && successor.allowedEffects.some(effect => effect.startsWith("craft:"))
        ? `${plan.requestId}:${index + 2}` : undefined } : undefined;
    const job = await this.publishWork(plan.observation, policy, "model", plan.requestId, plan.proposal.expiresTick,
      requires, after?.policy, undefined, stage);
    if (job === null) return; // A rotating observation is not a denied program stage.
    this.queuedWork = undefined;
    if (job && (stages.length > 1 || (job.order.origin === "model" && policy.target.kind === "preset"))) {
      this.queuedWork = { after: job, plan, stages, next: index + 1 };
      await this.record("work_program_stage", { requestId: plan.requestId, id: job.order.id, stage: index + 1, stages: stages.length });
    }
  }

  private async publishWork(
    witness: MacroObservation, policy: MacroWorkPolicy, origin: MacroWorkOrder["origin"], requestId: string | null,
    expiresTick: number, requires: readonly MacroStockFloor[] = [], predecessor?: MacroWorkPolicy,
    admitFresh?: (observation: MacroObservation) => boolean,
    stage?: { readonly id: string; readonly nextWorkId?: string },
  ): Promise<WorkJob | null | undefined> {
    const fresh = await this.refresh();
    if (!fresh) return null;
    if (admitFresh && !admitFresh(fresh)) return;
    if (!workScope(witness, fresh) || fresh.tick >= expiresTick || this.closing || this.previousJob ||
        performance.now() - this.startedAt! >= this.limits.maxRuntimeMs || this.pending || this.direct || this.segment || this.lease) {
      if (requestId) await this.disposition("proposal_refused", { requestId, reason: "No currently usable work-order basis." });
      return;
    }
    const previous = this.job;
    const equivalent = !!previous && workPolicyKey(previous.policy) === workPolicyKey(policy);
    const { target, reserves } = policy;
    const inherited = this.floorScope?.life === fresh.life ? this.floorScope.reserves : [];
    const reduced = inherited.some(({ item, count }) => (reserves.find(floor => floor.item === item)?.count ?? 0) < count);
    if (reduced || !hasStock(fresh, requires) || (predecessor && !confirmsWorkStock(fresh, predecessor)) ||
        (target.kind === "preset" && target.goal !== fresh.goal) ||
        (target.kind === "stock" && confirmsWorkStock(fresh, policy))) {
      if (requestId) await this.disposition("proposal_refused", { requestId, reason: "Live stock or target does not support the proposed work policy." });
      return;
    }
    if (equivalent && (previous.order.expiresTick >= expiresTick ||
        previous.order.expiresTick - fresh.tick > this.renewLeadTicks)) {
      await this.record("work_order_retained", { requestId, id: previous.order.id, expiresTick: previous.order.expiresTick });
      return previous;
    }
    const order = parseMacroWorkOrder({
      v: 1, id: stage?.id ?? randomUUID(), run: fresh.run, life: fresh.life, epoch: fresh.epoch, basisTick: fresh.tick,
      expiresTick: Math.min(expiresTick, fresh.tick + this.limits.maxIntentTtlTicks),
      safetyRevision: fresh.safety!.revision, origin: equivalent ? previous.order.origin : origin, ...policy,
      ...(!equivalent && stage?.nextWorkId ? { nextWorkId: stage.nextWorkId } : {}),
    });
    await this.record("work_order_prepared", { requestId, order, previousId: previous?.order.id ?? null, equivalent });
    if (this.closing || this.config.signal?.aborted) return;
    await this.ipc!.write("work.json", order, previous ? "work-only" : undefined);
    if (previous?.accepted) this.previousJob = previous;
    this.job = this.newestJob = { order, policy, requestId, source: fresh, health: fresh.health };
    this.jobs.set(order.id, this.job);
    await this.disposition(previous ? equivalent ? "work_order_renewal_proposed" : "work_order_replacement_proposed" : "work_order_issued",
      { requestId, id: order.id, previousId: previous?.order.id ?? null, origin: order.origin });
    return this.job;
  }

  private async restorePreviousWork(candidate: WorkJob, current: MacroObservation, reason: string): Promise<boolean> {
    const previous = this.previousJob;
    const native = current.workOrder;
    if (this.closing || !previous || this.job !== candidate || candidate.accepted ||
        previous.withdrawn || previous.terminal || current.tick >= previous.order.expiresTick ||
        !workScope(previous.source, current, previous.health)) return false;
    // An unconfirmed candidate is safe to roll back only when admission has
    // already expired and a fresh native sample still identifies the incumbent.
    if (!candidate.terminal && (native?.id !== previous.order.id ||
        (native.state !== "working" && native.state !== "needs_replan") ||
        (current.tick < candidate.order.expiresTick && current.tick - candidate.order.basisTick < WORK_ADMISSION_TICKS))) return false;
    if (!candidate.terminal) candidate.withdrawn = true;
    await this.ipc!.write("work.json", previous.order, "work-only");
    this.job = previous;
    this.previousJob = undefined;
    await this.record("work_order_replacement_not_admitted", {
      requestId: candidate.requestId, rejectedId: candidate.order.id, retainedId: previous.order.id, reason,
    });
    return true;
  }

  private async withdrawWork(reason: string, requestId?: string): Promise<void> {
    const job = this.job;
    if (!job) return;
    job.withdrawn = true;
    const previous = this.previousJob;
    if (previous) previous.withdrawn = true;
    await this.ipc!.remove("work.json");
    this.job = undefined;
    this.previousJob = undefined;
    this.handoffAfterTick = Math.max(this.handoffAfterTick, this.view?.observation.tick ?? job.order.basisTick);
    await this.record("work_order_withdrawn", { id: job.order.id, previousId: previous?.order.id ?? null,
      reason, requestId: requestId ?? job.requestId });
  }

  private async refresh(): Promise<MacroObservation | undefined> {
    let observation: MacroObservation | null;
    try { observation = await this.ipc!.read("observation.json", parseMacroObservation); }
    catch (error) {
      if (error instanceof MacroObservationRotating) return;
      throw error;
    }
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
      if (before.safety && (!observation.safety || observation.safety.revision < before.safety.revision ||
          (observation.safety.revision === before.safety.revision && observation.safety.clear !== before.safety.clear))) {
        throw new Error("Native survival macro safety scope regressed or changed without a revision.");
      }
      if (observation.tick === before.tick && observation.epoch === before.epoch) {
        if (digest(observation) !== digest(before)) throw new Error("Native survival macro changed a previously published tick.");
        return before;
      }
    }
    const complete = this.completedWorkProgram;
    if (complete && (complete.basis.life !== observation.life || complete.goal !== observation.goal || !alive(observation) ||
        observation.safety?.clear !== true || complete.finalOrder.safetyRevision !== observation.safety.revision ||
        !confirmsWorkStock(observation, complete.finalOrder))) this.completedWorkProgram = null;
    const evidence = evidenceKey(observation);
    this.observedAt = performance.now();
    this.view = {
      observation, evidence, query: this.queryKey(observation, evidence),
      changedAt: this.view?.evidence === evidence ? this.view.changedAt : this.observedAt,
    };
    return observation;
  }

  private queryKey(observation: MacroObservation, evidence: string): string {
    const receipt = this.lastReceipt;
    const selection = this.config.skills?.selection();
    return digest([evidence, receipt?.life === observation.life ? receipt.id : null,
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
    const maxBytes = Math.min(Number.MAX_SAFE_INTEGER, (2 * (this.issued.size + this.jobs.size) + 2) * 4_097);
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
    const job = this.jobs.get(receipt.id);
    if (job) {
      await this.receiveWork(job, receipt);
      return;
    }
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
    if (this.direct?.waiting === record) {
      this.direct.waiting = undefined;
      if (receipt.status === "completed" && eligible && record.accepted && !this.closing) {
        this.direct.completedAction = record;
      } else {
        await this.finishDirect(!eligible || this.closing ? "late_native_receipt" :
          receipt.status === "completed" ? "missing_native_acceptance" : `native_${receipt.status}`);
      }
    }
    this.handoffAfterTick = Math.max(this.handoffAfterTick, receipt.tick - 1);
    if (this.view) this.view = { ...this.view, query: this.queryKey(this.view.observation, this.view.evidence) };
  }

  private async receiveWork(job: WorkJob, receipt: MacroReceipt): Promise<void> {
    const { order } = job;
    const prior = receipt.status === "accepted" ? job.accepted : job.terminal;
    if (receipt.run !== order.run || receipt.life !== order.life || receipt.tick < order.basisTick ||
        ((receipt.status === "accepted" || receipt.status === "completed") && receipt.tick > order.expiresTick) ||
        (prior ? digest(prior) !== digest(receipt) : job.terminal ||
          (job.accepted && receipt.tick < job.accepted.tick) || (receipt.status === "completed" && !job.accepted))) {
      throw new Error("Native work receipt does not match its admitted job.");
    }
    if (prior) return;
    const priorLife = (this.view?.observation.life ?? receipt.life) > receipt.life;
    const eligible = !job.withdrawn && !priorLife;
    await this.append(this.receipts, { requestId: job.requestId, order, receipt, eligible,
      ...(job.bootstrap ? { stage: PRE_SPAWN_GOAL_ONLY } : {}),
      ...(job.withdrawn ? { afterWithdrawal: true } : {}), ...(priorLife ? { priorLife: true } : {}) });
    if (receipt.status === "accepted") {
      job.accepted = receipt;
      if (eligible) {
        this.lastAcceptedJob = job;
        this.completedWorkProgram = null;
        if (job.policy.reserves.length) this.floorScope = { life: job.order.life, reserves: job.policy.reserves };
      }
      if (this.job === job) this.previousJob = undefined;
      return;
    }
    job.terminal = receipt;
    this.settledWorkOrders++;
    if (eligible && receipt.status === "completed") {
      this.completedWorkOrders++;
      if (order.origin === "model") this.completedModelWorkOrders++;
    }
    if (!this.lastJobOutcome || receipt.tick >= this.lastJobOutcome.terminal!.tick) this.lastJobOutcome = job;
    if (this.job === job) {
      const current = this.view?.observation;
      if (receipt.status === "refused" && current && await this.restorePreviousWork(job, current, "native_refused_candidate")) return;
      await this.ipc!.remove("work.json");
      this.job = undefined;
      this.previousJob = undefined;
      this.handoffAfterTick = Math.max(this.handoffAfterTick, receipt.tick - 1);
    }
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
    if (this.direct?.waiting === pending) await this.finishDirect(reason);
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

  private async tryLookahead(view: View): Promise<void> {
    const origin = this.pending!;
    const { observation } = view;
    const working = observation.working;
    if (!this.config.strategist || this.requests >= this.limits.maxRequests || this.capabilitiesVersion !== MACRO_CAPABILITIES_VERSION ||
        this.segment || this.lease || origin.lookedAhead || origin.intent.skillHash || origin.offer.verb !== "break" ||
        !origin.offer.material || !origin.accepted || !working || working.intentId !== origin.intent.id ||
        working.crack > MACRO_LOOKAHEAD_MAX_CRACK || observation.tick <= origin.accepted.tick ||
        observation.tick - origin.scope.tick > MACRO_LOOKAHEAD_MAX_AGE_TICKS ||
        !samePlayableScope(origin.scope, observation) || observation.health < origin.scope.health ||
        !observation.safety?.clear || observation.safety.revision !== origin.scope.safety?.revision) return;
    const direct = this.direct;
    if (direct && (direct.waiting !== origin || direct.stage !== direct.action.steps.length - 1 ||
        direct.stageEffects < direct.action.steps[direct.stage]!.maxEffects || direct.action.steps[direct.stage]!.until)) return;

    const reserves = origin.reserves ?? [];
    const candidates = origin.scope.opportunities.filter(offer => offer.id !== origin.offer.id && !!offer.material &&
      offer.material.target !== origin.offer.material!.target && !origin.priorTargets?.has(offer.material.target) &&
      protectsStock(reserves, observation, offer));
    if (!candidates.length) return;
    origin.lookedAhead = true;
    const evidence: MacroLookahead = {
      predecessor: { intentId: origin.intent.id, acceptedTick: origin.accepted.tick, verb: origin.offer.verb, summary: origin.offer.summary },
      witnessBasis: basis(origin.scope), candidates, reserves,
    };
    await this.begin(view, { origin, evidence, workingBasis: observation, health: observation.health,
      lastWorkingTick: observation.tick, lastWorkingSeenAt: this.observedAt });
  }

  private async begin(view: View, lookahead?: Lookahead, workDemand?: MacroWorkDemand): Promise<void> {
    const trigger = this.trigger(view);
    const observation = view.observation;
    const observedAt = this.observedAt;
    const requestId = randomUUID();
    const skills = lookahead || workDemand?.current ? undefined : this.config.skills;
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
      ...(lookahead ? { lookahead: lookahead.evidence } : {}),
      ...(workDemand ? { work: workDemand } : {}),
    };
    if (!lookahead) {
      this.queryKeys.add(view.query);
      this.lastAsked = view;
    }
    await this.record("request", { requestId, evidenceKey: view.evidence, request });
    if (this.closing || performance.now() - this.startedAt! >= this.limits.maxRuntimeMs) {
      await this.disposition("request_not_dispatched", { requestId, reason: this.closing ? "stop" : "runtime_wall_limit" });
      return;
    }
    const notice = parseMacroPlanning({
      v: 1, id: requestId, run: observation.run, life: observation.life, epoch: observation.epoch, basisTick: observation.tick,
    });
    this.planning = { notice, startedAt: performance.now() };
    await this.ipc!.write("planning.json", notice);
    if (this.closing || performance.now() - this.startedAt! >= this.limits.maxRuntimeMs) {
      await this.endPlanning(this.closing ? "stop" : "cancelled");
      await this.disposition("request_not_dispatched", { requestId, reason: this.closing ? "stop" : "runtime_wall_limit" });
      return;
    }
    this.requests++;
    this.unreportedDispatches++;
    this.busy = {
      kind: "inference",
      work: this.work({ requestId, observation, generation, testedSkills, selectedSkillHash, lookahead, workDemand }, this.limits.requestTimeoutMs, async signal => {
        if (lookahead) return this.config.strategist!(request, signal);
        if (workDemand?.current) return this.config.strategist!({ ...request,
          strategicEpisodes: this.episodeMemory.forObservation(observation) }, signal);
        let frame: MacroFrame | undefined;
        try {
          frame = await this.capture(observation, observedAt, requestId, signal, !!workDemand);
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

  private async capture(
    observation: MacroObservation, observedAt: number, requestId: string, signal: AbortSignal, durable: boolean,
  ): Promise<MacroFrame | undefined> {
    if (!this.config.frame) return;
    let sample: MacroFrame | undefined;
    try { sample = await this.config.frame(observation, signal, requestId); }
    catch { throw new FrameRejected("invalid", "The trusted display capture did not settle."); }
    signal.throwIfAborted();
    const ipc = this.ipc!;
    const checkScope = async () => {
      let latest: MacroObservation | null;
      try { latest = await ipc.read("observation.json", parseMacroObservation); }
      catch (error) {
        if (!(error instanceof MacroObservationRotating)) throw error;
        latest = null;
      }
      if (!latest || !(durable ? workScope(observation, latest) : samePlayableScope(observation, latest)) || latest.tick < observation.tick ||
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
    const stale = runtimeExpired || !current || (context.lookahead ? !lookaheadScope(context.lookahead, current) :
      context.workDemand ? !workScope(context.observation, current) : !samePlayableScope(context.observation, current)) ||
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
    if (inference) {
      this.lastProviderOutcome = inference.outcome;
      this.lastProviderLatencyMs = positiveFinite(inference.latencyMs);
    }
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
      ...(context.lookahead ? { conditionalOn: context.lookahead.origin.intent.id } : {}),
      ...(context.workDemand ? {
        workDemand: context.workDemand.demand,
        coScheduledJobId: context.workDemand.current?.id ?? null,
        nativeAcceptedAtBasis: context.workDemand.current?.accepted ?? null,
        // Time bounds only: the continuity evaluator intersects provider and native evidence.
        providerStartedAtMs: positiveFinite(inference?.providerStartedAtMs), localSettledAtMs: result.settledAt,
      } : {}),
      ...(hadReviewPatch ? { reviewPatchProposed: true } : {}),
    });
    const lookahead = context.lookahead;
    if (lookahead) {
      const action = proposal?.action;
      const offer = action?.kind === "successor" && lookahead.evidence.candidates.find(offer => offer.id === action.opportunityId);
      const providerStartedAt = positiveFinite(inference?.providerStartedAtMs);
      if (disposition !== "proposed" || !offer || !proposal || action?.kind !== "successor" ||
          action.afterIntentId !== lookahead.origin.intent.id || this.closing) {
        await this.recordLookahead(lookahead, context.requestId, providerStartedAt, result.settledAt,
          this.closing ? "stop" : disposition !== "proposed" ? disposition : action?.kind === "abstain" ? "abstained" : "invalid_successor");
        return;
      }
      this.conditional = { lookahead, plan: { ...context, proposal }, action, offer, providerStartedAt, settledAt: result.settledAt };
      await this.record("lookahead_conditional", { requestId: context.requestId, predecessorId: action.afterIntentId,
        opportunityId: action.opportunityId, requires: action.requires, reserves: action.reserves });
      return;
    }
    if (!proposal || !current || this.closing) return;
    // An otherwise valid abstention may have outlived its old view. It still
    // authorized no effect, and must not suppress a newly witnessed decision.
    if (proposal.action.kind === "abstain" && context.workDemand && this.workQuery &&
        model && basisMatches && ttlValid && !runtimeExpired && !late) this.workQuery.abstained = true;
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
    const action = proposal.action;
    if (action.kind === "work" || action.kind === "work-program" || action.kind === "revoke-work") {
      if (!context.workDemand) {
        await this.disposition("proposal_refused", { requestId: context.requestId, reason: "Durable work was not offered." });
        return;
      }
      if (action.kind === "revoke-work") {
        if (context.workDemand.current?.id !== action.workOrderId || this.job?.order.id !== action.workOrderId) {
          await this.disposition("proposal_refused", { requestId: context.requestId, reason: "Revoke requires the same observed job." });
        } else await this.withdrawWork("model_revoked", context.requestId);
        return;
      }
      const stages = action.kind === "work-program" ? action.stages : [{ policy: action.policy, requires: [] }];
      const plan = { ...context, proposal };
      if (stages.some(({ policy: { target } }) => target.kind === "preset" && target.goal !== current.goal)) {
        await this.disposition("proposal_refused", { requestId: context.requestId, reason: "Work preset does not match the live goal." });
        return;
      }
      if (action.afterWorkId) {
        const after = this.jobs.get(action.afterWorkId);
        if (!after?.accepted || context.workDemand.current?.id !== after.order.id ||
            !context.workDemand.current?.accepted || after.withdrawn ||
            (after.terminal ? after.terminal.status !== "completed" : this.job !== after)) {
          await this.disposition("proposal_refused", { requestId: context.requestId, reason: "Successor requires the same accepted work job." });
          return;
        }
        this.queuedWork = { after, plan, stages, next: 0 };
        await this.record("work_successor_queued", { requestId: context.requestId, afterWorkId: after.order.id, stages: stages.length });
        return;
      }
      this.queuedWork = { after: null, plan, stages, next: 0 };
      return;
    }
    if (context.workDemand?.current && action.kind !== "abstain" && action.kind !== "gap") {
      await this.disposition("proposal_refused", { requestId: context.requestId,
        reason: "Only bound policy changes or a scoped revoke may replace ongoing native work." });
      return;
    }
    if (context.workDemand && !samePlayableScope(original, current) && action.kind !== "abstain" && action.kind !== "gap") {
      await this.rejectStale(context, "primitive_premise_changed");
      return;
    }
    if (proposal.action.kind !== "abstain") {
      this.episodeMemory.chosen(context.requestId, original, proposal.subgoal, proposal.successCondition);
    }
    switch (proposal.action.kind) {
      case "successor":
        await this.disposition("proposal_refused", { requestId: context.requestId,
          reason: "A conditional successor is valid only on a lookahead request." });
        return;
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
      case "continuation": {
        const action = proposal.action;
        if (this.workMode === "constrained" || !hasDirectAuthority(action, original, this.capabilitiesVersion)) {
          await this.disposition("proposal_refused", { requestId: context.requestId,
            reason: "The first ID or a material selector was not witnessed on the proposal basis." });
          return;
        }
        this.direct = {
          plan: { ...context, proposal }, action, until: Math.min(result.settledAt + MACRO_MAX_DIRECT_MS, this.startedAt! + this.limits.maxRuntimeMs),
          maxEffects: action.steps.reduce((sum, step) => sum + step.maxEffects, 0),
          usedIds: new Set(), usedTargets: new Set(), health: original.health, stage: 0, stageEffects: 0, issued: 0, completed: 0,
        };
        await this.record("direct_continuation_authorized", { requestId: context.requestId, basis: basis(original),
          maxEffects: this.direct.maxEffects, maxWallMs: MACRO_MAX_DIRECT_MS, expiresTick: proposal.expiresTick });
        return;
      }
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
      const fresh = await this.refresh();
      if (!fresh) return;
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

  private async advanceDirect(current: MacroObservation): Promise<void> {
    const direct = this.direct!;
    const { plan, action } = direct;
    if (!this.isCurrentHandoff(current)) return;
    if (!directScope(direct, current) || (!direct.issued && !samePlayableScope(plan.observation, current))) {
      await this.finishDirect("direct_scope_safety_or_ttl_changed");
      return;
    }
    const completed = direct.completedAction;
    if (completed) {
      const receipt = completed.terminal!;
      if (current.tick <= receipt.tick) return;
      direct.completedAction = undefined;
      direct.completed++;
      const before = completed.scope;
      const samples = new Set([
        ...Object.keys(before.inventory), ...Object.keys(current.inventory),
        ...action.reserves.map(floor => floor.item), ...action.steps.flatMap(step => step.until ? [step.until.item] : []),
      ]);
      await this.record("direct_continuation_stock", { requestId: plan.requestId, intentId: receipt.id,
        before: basis(before), after: basis(current),
        observedStock: [...samples].map(item => ({ item, before: stock(before, item), after: stock(current, item) })) });
    }
    if (action.reserves.some(({ item, count }) => stock(current, item) < count)) {
      await this.finishDirect("inventory_reserve");
      return;
    }

    for (; direct.stage < action.steps.length; direct.stage++, direct.stageEffects = 0) {
      const step = action.steps[direct.stage]!;
      const reached = step.until && stock(current, step.until.item) >= step.until.count;
      if (reached && !direct.issued) {
        await this.finishDirect("initial_stock_floor_already_met");
        return;
      }
      if (reached || (!step.until && direct.stageEffects >= step.maxEffects)) continue;
      if (direct.stageEffects >= step.maxEffects) {
        await this.finishDirect("stock_floor_unmet");
        return;
      }
      if (!directConditions(direct, current)) {
        await this.finishDirect("stock_floor_changed");
        return;
      }
      // A non-observable sample grants no authority; it does not establish a world absence.
      if (!current.quiescent && !current.opportunities.length) {
        await this.finishDirect("no_current_material_evidence");
        return;
      }
      const witnessed = direct.issued ? current : plan.observation;
      const offers = witnessed.opportunities.filter(offer => matchesMaterial(offer, step.selector) &&
        (!direct.issued ? offer.id === action.opportunityId
          : !direct.usedIds.has(offer.id) && !direct.usedTargets.has(offer.material!.target)));
      const choice = offers.find(offer => protectsStock(direct.action.reserves, current, offer));
      if (!choice) {
        await this.finishDirect(offers.length ? "inventory_reserve" : "no_fresh_material_opportunity");
        return;
      }
      if (await this.issue(plan, witnessed, choice.id, direct) === false) await this.finishDirect("opportunity_not_issued");
      return;
    }
    await this.finishDirect("steps_complete");
  }

  private async finishDirect(reason: string): Promise<void> {
    const direct = this.direct;
    if (!direct) return;
    this.direct = undefined;
    await this.record("direct_continuation_finished", { requestId: direct.plan.requestId, reason,
      issued: direct.issued, completed: direct.completed, maxEffects: direct.maxEffects });
  }

  private async advanceLookahead(current: MacroObservation): Promise<void> {
    const conditional = this.conditional!;
    const { lookahead, offer, plan, action } = conditional;
    const { origin } = lookahead;
    const completed = origin.terminal;
    if (!successorScope(conditional, current)) {
      await this.finishLookahead(conditional, "condition_expired");
      return;
    }
    if (!origin.accepted || !completed || current.working || current.tick <= completed.tick || !this.isCurrentHandoff(current)) return;
    const live = current.opportunities.find(candidate => candidate.id === action.opportunityId);
    if (!sameOffer(live, offer)) {
      await this.finishLookahead(conditional, "target_not_reconfirmed");
      return;
    }
    if (!successorStock(conditional, current, live)) {
      await this.finishLookahead(conditional, "stock_condition_unmet");
      return;
    }
    const issued = await this.issue(plan, current, live.id, conditional);
    if (issued !== null) await this.finishLookahead(conditional, issued ? "issued" : "publication_refused");
  }

  private async finishLookahead(conditional: Conditional, outcome: string): Promise<void> {
    this.conditional = undefined;
    await this.recordLookahead(conditional.lookahead, conditional.plan.requestId, conditional.providerStartedAt, conditional.settledAt, outcome);
  }

  private async recordLookahead(lookahead: Lookahead, requestId: string, providerStartedAt: number | null, settledAt: number,
    outcome: string): Promise<void> {
    await this.record("lookahead_finished", { requestId, predecessorId: lookahead.origin.intent.id, outcome,
      observedWorkingFromTick: lookahead.workingBasis.tick, observedWorkingThroughTick: lookahead.lastWorkingTick,
      predecessorTerminalTick: lookahead.origin.terminal?.tick ?? null,
      // The host-side envelope between positive samples can include gaps; raw no-work is measured natively.
      hostPaidCrackEnvelopeMs: providerStartedAt === null ? null :
        Math.max(0, Math.round(Math.min(settledAt, lookahead.lastWorkingSeenAt) - providerStartedAt)),
      ...(outcome === "issued" && this.pending ? { successorId: this.pending.intent.id } : {}),
    });
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

  private async issue(plan: Plan, witnessed: MacroObservation, opportunityId: string,
    authority?: Selection | DirectContinuation | Conditional): Promise<boolean | null> {
    const direct = authority && "usedTargets" in authority ? authority : undefined;
    const conditional = authority && "lookahead" in authority ? authority : undefined;
    const selection = authority && "hash" in authority ? authority : undefined;
    const current = await this.refresh();
    if (!current) {
      if (direct || conditional) return null; // Observation rotation: retry from a fresh witness.
      await this.rejectStale(plan, "observation_unavailable_at_handoff");
      return false;
    }
    const before = witnessed.opportunities.find(offer => offer.id === opportunityId);
    if (!before) {
      await this.disposition("proposal_refused", { requestId: plan.requestId, reason: "Opportunity was never offered on its basis." });
      return false;
    }
    const reserves = this.floorScope?.life === current.life ? this.floorScope.reserves : [];
    if (before.risk === "guarded" && (this.workMode === "constrained" ||
        (reserves.length && !protectsStock(reserves, current, before)))) {
      await this.disposition("proposal_refused", { requestId: plan.requestId,
        reason: "This material effect is not authorized by the constrained policy or would break a protected reserve." });
      return false;
    }
    const after = current.opportunities.find(offer => offer.id === opportunityId);
    if (!this.isCurrentHandoff(current) || !samePlayableScope(witnessed, current) || current.tick >= plan.proposal.expiresTick ||
        !sameOffer(before, after) || (selection && after?.risk === "guarded") ||
        (direct && (!directScope(direct, current) || !directConditions(direct, current) || !protectsStock(direct.action.reserves, current, after!))) ||
        (conditional && (current.working || !successorScope(conditional, current) || !successorStock(conditional, current, after!)))) {
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
      expiresTick: Math.min(plan.proposal.expiresTick, current.tick + this.limits.maxIntentTtlTicks,
        direct ? current.tick + Math.max(1, Math.floor((direct.until - performance.now()) / 50)) : Infinity),
      opportunityId,
      skillHash: selection?.hash ?? null,
    });
    await this.record("intent_prepared", { requestId: plan.requestId, intent, witnessed: before,
      ...(direct ? { authority: "direct-continuation", stage: direct.stage + 1,
        selector: direct.action.steps[direct.stage]!.selector, reserves: direct.action.reserves } : {}),
      ...(conditional ? { authority: "conditional-successor", predecessorId: conditional.action.afterIntentId,
        preconditions: conditional.action.requires, originalWitness: conditional.lookahead.evidence.witnessBasis } : {}) });
    const refreshed = await this.refresh();
    if (!refreshed && (direct || conditional)) return null;
    if (!refreshed || !this.isCurrentHandoff(refreshed) || !samePlayableScope(current, refreshed) || refreshed.tick >= intent.expiresTick ||
        !sameOffer(after, refreshed.opportunities.find(offer => offer.id === opportunityId)) ||
        (before.risk === "guarded" && reserves.length > 0 && !protectsStock(reserves, refreshed, after!)) ||
        (direct && (!directScope(direct, refreshed) || !directConditions(direct, refreshed) || !protectsStock(direct.action.reserves, refreshed, after!))) ||
        (conditional && (refreshed.working || !successorScope(conditional, refreshed) || !successorStock(conditional, refreshed, after!))) ||
        (selection && (!selection.offer || !this.isSelectedSkill(selection.hash, selection.generation) ||
          !this.config.skills!.matchesSelection(selection.offer, refreshed, selection.continuation?.receipts)))) {
      await this.rejectStale(plan, "intent_basis_changed_at_publication");
      return false;
    }
    const macro: Issued = { requestId: plan.requestId, intent, scope: refreshed, offer: after!,
      ...(direct ? { reserves: direct.action.reserves, priorTargets: direct.usedTargets } : {}),
      ...(conditional ? { lookedAhead: true } : {}),
    };
    this.pending = macro;
    this.issued.set(intent.id, macro);
    this.effectKeys.add(key);
    await this.ipc!.write("intent.json", intent);
    if (conditional) this.episodeMemory.chosen(plan.requestId, witnessed, plan.proposal.subgoal, plan.proposal.successCondition);
    this.episodeMemory.issued(plan.requestId);
    this.publishedIntents++;
    if (direct) {
      direct.health = refreshed.health;
      direct.issued++;
      direct.stageEffects++;
      direct.waiting = macro;
      direct.usedIds.add(opportunityId);
      direct.usedTargets.add(after!.material!.target);
      await this.record("direct_continuation_intent", { requestId: plan.requestId, id: intent.id, stage: direct.stage + 1,
        issued: direct.issued, completed: direct.completed, maxEffects: direct.maxEffects });
    }
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
    try { await this.withdrawWork("authority_revoked"); await ipc.remove("work.json"); } catch (error) { errors.push(error); }
    try { await ipc.remove("intent.json"); } catch (error) { errors.push(error); }
    try { await ipc.remove("handoff.json"); this.lease = undefined; } catch (error) { errors.push(error); }
    try { await this.endPlanning("revoked"); } catch (error) { errors.push(error); }
    if (this.queuedWork) await this.advanceQueuedWork(undefined, true);
    if (errors.length) throw new AggregateError(errors, "Could not remove all native macro authority files.");
  }

  private async endPlanning(reason: "settled" | "cancelled" | "stale_scope" | "stop" | "revoked"): Promise<void> {
    const episode = this.planning;
    // Also clear an unrecognized mailbox when fail-closing due to tampering.
    if (episode || reason === "revoked") await this.ipc!.remove("planning.json");
    this.planning = undefined;
    if (episode) await this.record("planning_notice_closed", {
      requestId: episode.notice.id, reason, pendingMs: Math.round(performance.now() - episode.startedAt),
    });
  }

  private async fail(error: unknown): Promise<void> {
    this.faulted = true;
    this.busy?.work.cancel.abort(error);
    if (this.firstPlanning) {
      this.firstPlanning.rejection = "protocol_fault";
      this.firstPlanning.cancel.abort(error);
    }
    this.lastDisposition = "protocol_fault";
    await this.record("protocol_fault", { reason: describe(error) }).catch(() => {});
    await this.revoke().catch(revokeError =>
      this.record("revocation_ipc_failure", { reason: describe(revokeError) }).catch(() => {}));
    await this.finishDirect("protocol_fault").catch(() => {});
    if (this.conditional) await this.finishLookahead(this.conditional, "protocol_fault").catch(() => {});
  }

  stop(): Promise<void> {
    return this.stopPromise ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    this.config.signal?.removeEventListener("abort", this.stopListener);
    if (this.timer) clearTimeout(this.timer);
    this.busy?.work.cancel.abort(new Error("Survival macro stopped."));
    this.firstPlanning?.cancel.abort();
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
        await this.finishDirect("run_stopped").catch(remember);
        if (this.conditional) await this.finishLookahead(this.conditional, "stop").catch(remember);
        const firstPlanning = this.firstPlanning;
        if (firstPlanning) {
          const grace = new AbortController();
          try { await Promise.race([firstPlanning.done, delay(2_000, undefined, { signal: grace.signal })]); }
          finally { grace.abort(); }
          if (firstPlanning.result) {
            await this.advanceFirstPlan(this.view?.observation, false,
              firstPlanning.rejection === "protocol_fault" ? "protocol_fault" : "stop").catch(remember);
          } else {
            await this.record("first_plan_unresolved", {
              requestId: firstPlanning.requestId, stage: PRE_SPAWN_GOAL_ONLY, basis: null,
              dispatched: firstPlanning.dispatchedAt !== undefined ? true : null,
              providerStartedAtMs: firstPlanning.dispatchedAt ?? null,
            }).catch(remember);
          }
        }
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
        for (const job of this.jobs.values()) {
          if (!job.terminal) await this.record("work_order_unresolved", { id: job.order.id, accepted: !!job.accepted });
        }
        await this.record("stopped", { status: this.status(),
          unresolvedRequestId: this.firstPlanning?.requestId ?? this.busy?.work.context.requestId ?? null,
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
    const job = this.newestJob;
    const minimumTick = Math.max(latest?.tick ?? 0, pending?.intent.basisTick ?? 0, pending?.accepted?.tick ?? 0,
      job?.order.basisTick ?? 0, job?.accepted?.tick ?? 0);
    const minimumLife = Math.max(latest?.life ?? 0, pending?.intent.life ?? 0, job?.order.life ?? 0);
    const minimumEpoch = Math.max(latest?.epoch ?? 0, pending?.intent.epoch ?? 0, job?.order.epoch ?? 0);
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
