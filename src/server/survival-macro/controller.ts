import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SURVIVAL_AGENT_GOALS } from "../../shared/survival-agent-ui.ts";
import {
  bindFirstPlan, firstPlanScopeMatches, parseFirstPlanAdvice, PRE_SPAWN_GOAL_ONLY,
  type FirstPlanInference, type FirstPlanRequest, type FirstPlanStrategist,
} from "./bootstrap.ts";
import { filterPreparedStockProposal } from "./prepared-stock.ts";
import {
  MACRO_CAPABILITIES_VERSION, MACRO_COLLECT_PENDING, MACRO_DEFER_PENDING, MACRO_DIAMOND_PROSPECT, MACRO_FOOD_CLUE,
  MACRO_IRON_SMELT, MACRO_WATER_CLUE, MACRO_WATER_FILL,
  MACRO_RECON, MACRO_RECON_ANCHOR, MACRO_RECON_MAX_TICKS, MACRO_VISUAL_WITNESS_MAX_TICKS,
  MACRO_SMELT_OVERLAP_MIN_COOK_TICKS,
  MACRO_MAX_HANDOFF_TTL_TICKS, MACRO_MAX_INTENT_TTL_TICKS, MACRO_MAX_PLAN_TTL_TICKS,
  MACRO_MAX_DIRECT_EFFECTS, MACRO_MAX_DIRECT_MS, MACRO_MAX_PLANNING_IDLE_MS, MACRO_LOOKAHEAD_MAX_AGE_TICKS, MACRO_LOOKAHEAD_MAX_CRACK,
  MacroDirectory, MacroObservationRotating, MacroValidationError,
  foodWorkWitness, hasDirectAuthority, independentGroundScout, isFoodWork, isGroundScout, isIndependentPendingPolicy,
  isOpeningView, isPendingWorkVerb, liveCorrectionEvidence, macroReplyRejectionDetail,
  harvestAnchorMatchesPolicy, hasSurfaceCoverEffect, matchesMaterial, openingViewMatchesPolicy,
  sameTravelTarget, surfaceAnchorMatchesPolicy, travelHintMatchesPolicy,
  parseMacroHandoff, parseMacroIntent, parseMacroObservation, parseMacroPlanning,
  parseMacroProposal, parseMacroReceipt, parseMacroRevocation, parseMacroVisualProbe, parseMacroVisualProbeResult,
  parseMacroWorkOrder, sameLiveCorrectionScope, validateMacroCaptureId, validateMacroId,
  type MacroBasis, type MacroDirectAction, type MacroFeedback, type MacroFrame, type MacroHandoff, type MacroInference, type MacroIntent,
  type MacroLookahead, type MacroObservation, type MacroOpportunity, type MacroParkedReceipt, type MacroPendingWork, type MacroPlanning,
  type MacroProposal, type MacroReceipt, type MacroReplyRejection, type MacroRequest, type MacroSkillReceipt, type MacroStockFloor,
  type MacroStrategist, type MacroSuccessor,
  type MacroTravelHint, type MacroTrigger, type MacroVisualBinding, type MacroVisualProbe, type MacroVisualProbeResult,
  type MacroWorkDemand, type MacroWorkMode, type MacroWorkOrder,
  type MacroWorkPolicy, type MacroWorkStage,
  type NativeReceiptCursor,
} from "./protocol.ts";
import { StrategicEpisodeLedger } from "./episode-memory.ts";
import type { NativeGapReview } from "./gap-review.ts";
import type { MacroSkillProposal, SurvivalMacroSkills } from "./skills.ts";
import { VANILLA_HARVEST } from "./vanilla-harvest.ts";
import { preflightVanillaWork, type VanillaWorkDiagnostic } from "./vanilla-work.ts";
import { sameNativeFrameScope } from "./visual-capture.ts";

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
const COMPATIBLE_WORK_RECEIPT = "Replaced by a compatible work order.";
const PARKED_VIEW_WAIT_TICKS = 20;
const PARKED_VIEW_WAIT_MS = 1_200;
const SURVEY_RECOVERY_TICKS = 600;
const SURVEY_RECOVERY_MS = 30_000;
const ALTERNATIVE_RECOVERY_TICKS = WORK_REPLAN_GAP_TICKS + 20;
const ALTERNATIVE_RECOVERY_MS = 5_000;
// Native views are published every 5 ticks. Permit at most two follow-up
// publications and a short wall-clock bound for a fresh physical handoff.
const FIRST_ACTIONABLE_VIEW_TICKS = 10;
const FIRST_ACTIONABLE_VIEW_MS = 600;
const VISUAL_PROBE_TICKS = 40;
const VISUAL_WITNESS_MS = 30_000;
const POST_LOOK_TICKS = 80;
const POST_LOOK_MS = 4_000;

type TrialResult =
  | { readonly status: "passed"; readonly detail: string; readonly verb: string }
  | { readonly status: "failed" | "abstained"; readonly detail: string };
export interface MacroTrialRunner {
  run(hash: string, skills: SurvivalMacroSkills, signal: AbortSignal): Promise<TrialResult>;
}

export type DisplayCaptureFailure = "spawn_failed" | "process_failed" | "timeout" | "io_error" |
  "empty_output" | "output_too_large" | "invalid_image" | "unexpected_dimensions";

export type UnavailableFrame = {
  readonly cause: "unavailable";
  readonly failure: DisplayCaptureFailure;
  readonly adapter?: "scrot" | "ffmpeg";
  readonly captureSource?: MacroFrame["captureSource"];
  readonly nativeOmission?: string;
  readonly nativeCaptureMs?: number;
};

type FrameCapture = MacroFrame | UnavailableFrame | { readonly cause: "basis_changed";
  readonly captureSource?: MacroFrame["captureSource"]; readonly nativeOmission?: string; readonly nativeCaptureMs?: number };

export interface SurvivalMacroConfig {
  readonly runDir: string;
  readonly run: string;
  readonly strategy: "deterministic" | "model";
  readonly model?: string;
  readonly objective?: string;
  /** Outcome-level jobs require explicitly admitted Model. */
  readonly durableWork?: boolean;
  /** One prepared stock request, after matching rendered evidence; no other effects. */
  readonly preparedStockReady?: (observation: MacroObservation) => boolean;
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
  readonly frame?: (observation: MacroObservation, signal: AbortSignal, requestId: string) => Promise<FrameCapture>;
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
  readonly declaredStages?: number;
  readonly executedStages?: readonly number[];
  readonly goal: string;
  readonly invocationItemCount: number | null;
  readonly finalOrder: MacroWorkOrder;
  readonly accepted: MacroReceipt;
  readonly receipt: MacroReceipt;
  readonly basis: MacroBasis;
  readonly stock: readonly { readonly item: string; readonly required: number; readonly observed: number }[];
  readonly stage?: typeof PRE_SPAWN_GOAL_ONLY;
  readonly branchIndex?: number;
}

export interface MacroStatus {
  readonly strategy: SurvivalMacroConfig["strategy"];
  readonly model: string | null;
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

interface PreparedStockDecision {
  readonly requestId: string;
  readonly disposition: string;
  readonly reason: string;
}

interface ReplyCorrection {
  readonly requestId: string;
  readonly observation: MacroObservation;
  readonly key: string;
  readonly feedback: MacroFeedback;
  readonly renewal?: WorkJob;
}

interface TravelReacquisition {
  readonly requestId: string;
  readonly source: MacroObservation;
  readonly hint: MacroTravelHint;
  readonly until: number;
}

interface IntentRecoveryScope {
  readonly requestId: string;
  readonly basis: MacroBasis;
  readonly health: number;
  readonly evidence: string;
  readonly offer: Omit<MacroOpportunity, "id">;
  readonly key: string;
  readonly expiresTick: number;
  readonly until: number;
}

type IntentRecovery = IntentRecoveryScope & (
  | { readonly kind: "restored-survey"; gapSeen?: true }
  | { readonly kind: "superseded-opening"; readonly source: MacroObservation;
      readonly policy: MacroWorkPolicy; readonly replacement: ProspectOpening | MacroTravelHint; readonly proposalExpiresTick: number }
  | { readonly kind: "alternative"; readonly opening?: { readonly source: MacroObservation; readonly policy: MacroWorkPolicy } }
);

interface FirstPlanning {
  readonly requestId: string;
  readonly request: FirstPlanRequest;
  readonly startedAt: number;
  readonly until: number;
  readonly cancel: AbortController;
  readonly done: Promise<void>;
  first?: { readonly view: MacroObservation; readonly observedAt: number };
  actionable?: MacroObservation;
  resourceView?: MacroObservation;
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
    { readonly ok: false; readonly detail: string; readonly settledAt: number; readonly preflight?: "stale" | "invalid" | "rotation" };
}

type CameraFrame = MacroVisualBinding & { readonly imageSha256: string };

interface Decision {
  readonly requestId: string;
  readonly observation: MacroObservation;
  readonly generation: number | null;
  readonly testedSkills: NonNullable<MacroRequest["testedSkills"]>;
  readonly selectedSkillHash?: string;
  readonly lookahead?: Lookahead;
  readonly workDemand?: MacroWorkDemand;
  readonly workOverlap?: WorkOverlap;
  readonly replyKey?: string;
  readonly correction?: ReplyCorrection;
  readonly reconsideration?: IntentRecovery;
  readonly reacquiredTravelOf?: string;
  readonly firstLiveReadOf?: string;
  readonly visual?: MacroRequest["visual"];
  readonly visualFollowup?: true;
  readonly postLook?: PostLook;
  providerDispatched?: true;
  deliveredVisual?: CameraFrame & { readonly verify: () => Promise<boolean> };
  comparisonFrame?: CameraFrame; // Sent pixels for a later camera comparison; never a nomination grant.
}

interface VisualProbe {
  readonly wire: MacroVisualProbe;
  readonly source: MacroObservation;
  readonly startedAt: number;
  readonly until: number;
}

interface VisualFinding {
  readonly probe: VisualProbe;
  readonly result: MacroVisualProbeResult;
  readonly receivedAt: number;
  followedUp?: true;
}

interface PostLook {
  readonly issued: Issued;
  readonly terminalTick: number;
  readonly until: number;
  readonly expiresTick: number;
}

class FrameRejected extends Error {
  constructor(readonly disposition: "stale" | "invalid" | "rotation", message: string) { super(message); }
}

async function discardFrame(frame: MacroFrame): Promise<void> {
  try { await frame.artifact?.discard?.(); }
  catch { throw new FrameRejected("invalid", "The archived display capture could not be withdrawn."); }
}

interface Plan extends Decision {
  readonly proposal: MacroProposal;
}

interface OpeningView {
  readonly plan: Plan;
  readonly policy: MacroWorkPolicy;
  readonly issued: Issued;
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
  readonly openingWorkView?: true;
  readonly paidCameraRead?: true;
  readonly cameraFrame?: CameraFrame;
  readonly reserves?: readonly MacroStockFloor[];
  readonly priorTargets?: ReadonlySet<string>;
  readonly reconUntil?: number;
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
  readonly renews?: WorkJob;
  bootstrap?: number;
  smeltLookedAhead?: true;
  pendingPurpose?: Pick<MacroProposal, "subgoal" | "reason">;
  preparedSide?: NonNullable<Extract<MacroProposal["action"], { kind: "work" }>["duringWait"]>;
  independentPublished?: true;
  parked?: MacroParkedReceipt;
  collector?: Issued;
  accepted?: MacroReceipt;
  terminal?: MacroReceipt;
  withdrawn?: true;
}

interface QueuedWork {
  readonly after: WorkJob | null;
  readonly plan: Pick<Plan, "requestId" | "observation" | "replyKey" | "correction" | "postLook"> & {
    readonly proposal: Pick<MacroProposal, "expiresTick">;
  };
  readonly stages: readonly MacroWorkStage[];
  readonly next: number;
  readonly bootstrap?: { readonly branchIndex: number; readonly declaredStages: number; readonly stageOffset: number };
  readonly smeltSuccessor?: true;
  readonly travelWait?: { readonly tick: number; readonly until: number };
  readonly pendingPurpose?: WorkJob["pendingPurpose"];
  readonly preparedSide?: WorkJob["preparedSide"];
}

interface WorkOverlap {
  readonly incumbent: WorkJob;
  readonly queue: QueuedWork | undefined;
  readonly smeltBurnTick?: number;
}

interface WorkStageIds {
  readonly id: string;
  nextWorkId?: string;
}

function workStageIds(requestId: string, stages: readonly MacroWorkStage[], index: number, offset = 0): WorkStageIds {
  const successor = stages[index + 1]?.policy;
  // Only the adjacent ID is announced; subsequent permissions are still unadmitted.
  return { id: `${requestId}:${offset + index + 1}`,
    nextWorkId: successor && successor.maxCrafts > 0 && successor.allowedEffects.some(effect => effect.startsWith("craft:"))
      ? `${requestId}:${offset + index + 2}` : undefined };
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
  return !!left && !!right && left.id === right.id && sameAffordance(left, right);
}

function sameAffordance(left: Omit<MacroOpportunity, "id">, right: MacroOpportunity): boolean {
  if (left.anchor || right.anchor) return left.verb === right.verb && left.risk === right.risk &&
    left.anchor?.subject === right.anchor?.subject && left.anchor?.target === right.anchor?.target;
  return left.verb === right.verb && left.summary === right.summary &&
    left.risk === right.risk && left.evidence === right.evidence && sameMaterial(left.material, right.material);
}

function offersAffordance(observation: MacroObservation, offer: Omit<MacroOpportunity, "id">): boolean {
  return observation.opportunities.some(current => sameAffordance(offer, current));
}

function workAffordance(offer: MacroOpportunity): boolean {
  return offer.verb !== MACRO_RECON && (offer.risk !== "read" || offer.material !== undefined || !!offer.anchor && isOpeningView(offer));
}

function emptyFirstWorkView(view: MacroObservation): boolean {
  return !view.quiescent && !view.working && !view.workOrder && !view.pendingWork && !view.opportunities.length &&
    !view.travelHint && !view.timberObstruction && !view.prospectOpening && !view.surfaceOpening;
}

function firstWorkRead(offer: MacroOpportunity): boolean {
  return offer.risk === "read" && isOpeningView(offer) && !isGroundScout(offer);
}

function meaningfulPrimitive(offer: MacroOpportunity): boolean {
  return !isPendingWorkVerb(offer.verb) && offer.verb !== MACRO_WATER_CLUE && offer.verb !== MACRO_FOOD_CLUE &&
    (workAffordance(offer) || offer.verb === "inspect");
}

function primitiveEffectKey(observation: MacroObservation, offer: MacroOpportunity): string {
  if (isGroundScout(offer)) return digest(["ground scout", observation.life, observation.goal, offer.anchor.target]);
  if (isOpeningView(offer)) {
    // Left, right and down are one unanchored read of this stance.
    return digest(["view", observation.life, observation.goal, observation.stance, observation.safety?.revision, offer.anchor]);
  }
  return digest([observation.life, observation.epoch, observation.goal, offer]);
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
    orderedOpportunities(observation).filter(offer => offer.verb !== MACRO_RECON),
    observation.quiescent, observation.prospectOpening, observation.surfaceOpening, observation.timberObstruction,
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

function sameOpeningStance(source: MacroObservation, current: MacroObservation): boolean {
  return source.stance !== undefined && source.stance === current.stance && scope(source, current) &&
    workScope(source, current) && !current.pendingWork && !current.working;
}

type ProspectOpening = NonNullable<MacroObservation["prospectOpening"]>;
type SurfaceOpening = NonNullable<MacroObservation["surfaceOpening"]>;

function sameOpeningCut(left: SurfaceOpening, right: SurfaceOpening | undefined): boolean {
  return right !== undefined && left.target === right.target && left.block === right.block &&
    left.tool === right.tool && left.maxToolLoss === right.maxToolLoss;
}

function pricedProspectOpening(observation: MacroObservation, policy: MacroWorkPolicy): ProspectOpening | undefined {
  const clue = observation.prospectOpening;
  const { target, allowedEffects, costCaps, reserves, maxBreaks } = policy;
  if (!clue || target.kind !== "stock" || target.item !== "minecraft:diamond" || maxBreaks < 2 ||
      !allowedEffects.includes(MACRO_DIAMOND_PROSPECT) || !allowedEffects.includes(`break:${clue.block}`) ||
      !hasStock(observation, reserves)) return;
  const carriedTool = stock(observation, clue.tool);
  const floor = reserves.find(({ item }) => item === clue.tool)?.count ?? 0;
  if (carriedTool < 1 || carriedTool - clue.maxToolLoss < floor ||
      clue.maxToolLoss > (costCaps.find(({ item }) => item === clue.tool)?.count ?? 0)) return;
  return clue;
}

type TimberObstruction = NonNullable<MacroObservation["timberObstruction"]>;

function sameTimberObstruction(left: TimberObstruction, right: TimberObstruction | undefined): boolean {
  return !!right && left.target === right.target && left.block === right.block && left.timber === right.timber &&
    sameTravelTarget(left.toward, right.toward);
}

function pricedTimberObstruction(observation: MacroObservation, policy: MacroWorkPolicy): TimberObstruction | undefined {
  const clue = observation.timberObstruction;
  const { target, allowedEffects, maxBreaks, reserves } = policy;
  if (!clue || target.kind !== "stock" || target.item !== clue.timber || !hasStock(observation, reserves) ||
      !allowedEffects.includes(`break:${clue.block}`) || !allowedEffects.includes(`break:${clue.timber}`)) return;
  const missing = target.count - stock(observation, target.item);
  if (missing > 0 && maxBreaks > missing) return clue;
}

type SurfaceWitness = { readonly surfaceOpening: SurfaceOpening };
type OpeningWitness = MacroOpportunity | ProspectOpening | MacroTravelHint | SurfaceWitness;
type WorkStart = Pick<MacroWorkOrder, "travelAnchor" | "harvestAnchor" | "surfaceAnchor">;

const ironHarvestPicks = ["minecraft:stone_pickaxe", "minecraft:iron_pickaxe", "minecraft:diamond_pickaxe",
  "minecraft:netherite_pickaxe"] as const;
const earlyHarvestPicks = ["minecraft:wooden_pickaxe", "minecraft:golden_pickaxe", ...ironHarvestPicks] as const;

function surfaceAnchor(clue: SurfaceOpening): NonNullable<MacroWorkOrder["surfaceAnchor"]> {
  return { subject: `block:${clue.block}`, target: clue.target };
}

function pricedSurfaceOpening(observation: MacroObservation, policy: MacroWorkPolicy): SurfaceOpening | undefined {
  const clue = observation.surfaceOpening;
  const { target, costCaps, reserves, maxBreaks } = policy;
  if (!clue || target.kind !== "stock" || !surfaceAnchorMatchesPolicy(surfaceAnchor(clue), policy) ||
      !hasStock(observation, reserves)) return;
  if (clue.tool !== "minecraft:air") {
    const count = stock(observation, clue.tool);
    const floor = reserves.find(({ item }) => item === clue.tool)?.count ?? 0;
    const cap = costCaps.find(({ item }) => item === clue.tool)?.count ?? 0;
    if (count < 1 || count - clue.maxToolLoss < floor || clue.maxToolLoss > cap) return;
  }
  // Inventory proves only a carried type. Native rechecks the exact usable stack, wear, and room.
  const picks = target.item === "minecraft:raw_iron" ? ironHarvestPicks : earlyHarvestPicks;
  if (!picks.some(item => stock(observation, item) > (item === clue.tool ? clue.maxToolLoss : 0))) return;
  const missing = target.count - stock(observation, target.item);
  if (missing > 0 && maxBreaks > missing) return clue;
}

function sameTravelHint(left: MacroTravelHint, right: MacroTravelHint | undefined): boolean {
  return left.kind === right?.kind && sameTravelTarget(left, right) &&
    (left.footing === "one_block_grade"
      ? right.footing === left.footing && left.heightChange === right.heightChange
      : right.footing !== "one_block_grade");
}

function sameTravelReacquisitionScope(source: MacroObservation, fresh: MacroObservation): boolean {
  return sameOpeningStance(source, fresh) && guardBand(source.food) === guardBand(fresh.food);
}

function sameTravelReacquisitionHint(source: MacroTravelHint, fresh: MacroTravelHint | undefined): boolean {
  return source.footing === fresh?.footing && sameTravelHint(source, fresh);
}

function sameOpeningWitness(left: OpeningWitness, right: OpeningWitness): boolean {
  if ("footing" in left) return "footing" in right && sameTravelHint(left, right);
  if ("block" in left) return "block" in right && sameOpeningCut(left, right);
  if ("surfaceOpening" in left) return "surfaceOpening" in right && sameOpeningCut(left.surfaceOpening, right.surfaceOpening);
  return "verb" in right && sameAffordance(left, right);
}

function matchingTravelHint(observation: MacroObservation, policy: MacroWorkPolicy): MacroTravelHint | undefined {
  const clue = observation.travelHint;
  return clue && travelHintMatchesPolicy(clue, policy) && hasStock(observation, policy.reserves) ? clue : undefined;
}

function openingWorkWitness(observation: MacroObservation, policy: MacroWorkPolicy, view: Pick<MacroOpportunity, "anchor">): OpeningWitness | undefined {
  const { anchor } = view;
  const clue = pricedProspectOpening(observation, policy);
  if (clue && (!anchor || (anchor.target === clue.target && anchor.subject === `block:${clue.block}`))) return clue;
  const material = observation.opportunities.find(offer => {
    const witness = offer.material ?? offer.anchor;
    if (!witness || (anchor && (witness.target !== anchor.target || witness.subject !== anchor.subject))) return false;
    if (witness.subject === "route:dry") {
      return (offer.verb === "follow" || offer.verb === "approach") && policy.allowedEffects.includes(MACRO_DIAMOND_PROSPECT);
    }
    return offer.verb === "break" && offer.risk === "guarded" && offer.material &&
      harvestAnchorMatchesPolicy(offer.material, policy) &&
      protectsStock(policy.reserves, observation, offer) &&
      Object.entries(offer.material.spends).every(([item, count]) =>
        policy.costCaps.some(cap => cap.item === item && cap.count >= count) && stock(observation, item) >= count);
  });
  if (material) return material;
  // A bare turn did not name a particular resource or frontier. It cannot
  // acquire a rolling approach to whichever unrelated clue happened to render.
  if (anchor) {
    const travel = matchingTravelHint(observation, policy);
    if (travel && sameTravelTarget(anchor, travel)) return travel;
  }
  const surface = pricedSurfaceOpening(observation, policy);
  if (surface && (!anchor || sameTravelTarget(anchor, surfaceAnchor(surface)))) return { surfaceOpening: surface };
}

function replacementOpeningWitness(observation: MacroObservation, policy: MacroWorkPolicy,
  camera: Omit<MacroOpportunity, "id">): ProspectOpening | MacroTravelHint | undefined {
  const { anchor, verb } = camera;
  if (!anchor) return verb === "survey" && !offersAffordance(observation, camera)
    ? pricedProspectOpening(observation, policy) : undefined;
  if (verb !== "inspect") return;
  const travel = matchingTravelHint(observation, policy);
  if (travel?.kind !== "resource") return;
  if (sameTravelTarget(anchor, travel)) return travel;
  // A fresh, different face can inform another decision, but never answer the
  // old inspect. A permitted cover break alone is not a source of the stock.
  if (travel.target !== anchor.target && !offersAffordance(observation, camera) && policy.target.kind === "stock" &&
      VANILLA_HARVEST.get(travel.subject.slice("block:".length))?.item === policy.target.item) return travel;
}

function openingSupersessionFeedback(recovery: Extract<IntentRecovery, { kind: "superseded-opening" }>): MacroFeedback {
  const { replacement, offer } = recovery;
  const observed = "footing" in replacement
    ? offer.anchor && sameTravelTarget(offer.anchor, replacement)
      ? "A fresh approach now names the same resource."
      : `A fresh approach names a different stock source, not the inspected block (${offer.anchor?.target}). ` +
        "If the objective requires the original target, do not substitute it."
    : "A fresh wall now fits the quoted prospecting policy.";
  return { kind: "failed_intent", detail: "The opening view could not be issued. No camera read or work started. " +
    `${observed} Decide from this observation whether to authorize ordinary work without an opening view, choose a supported alternative, or abstain.` };
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

function openingHandoff(after: WorkJob, observation: MacroObservation): boolean {
  if (!after.terminal || observation.tick < after.terminal.tick || observation.working) return false;
  const state = observation.workOrder;
  // Native quiescence normally describes a primitive lease. A completed native
  // job may instead retain its clean personal grid only for the adjacent ID.
  return state ? state.id === after.order.id && state.state === "complete" : observation.quiescent;
}

function offeredOpeningStart(observation: MacroObservation, policy: MacroWorkPolicy): boolean {
  const { target, allowedEffects, costCaps, reserves } = policy;
  return target.kind === "stock" && observation.opportunities.some(({ risk, verb, material }) => {
    if (risk !== "guarded" || !material) return false;
    if (verb === "collect") return material.subject === `item:${target.item}` && Object.keys(material.spends).length === 0;
    if (verb !== "continue" || !material.subject.startsWith("recipe:")) return false;
    const recipe = material.subject.slice("recipe:".length);
    if (target.item !== `minecraft:${recipe}` || !allowedEffects.includes(`craft:${recipe}`)) return false;
    const spends = Object.entries(material.spends);
    return spends.length > 0 && spends.every(([item, count]) => costCaps.some(cap => cap.item === item && cap.count >= count) &&
        stock(observation, item) - count >= (reserves.find(floor => floor.item === item)?.count ?? 0));
  });
}

function witnessedSideStart(observation: MacroObservation, policy: MacroWorkPolicy): boolean {
  if (confirmsWorkStock(observation, policy) || !hasStock(observation, policy.reserves) || policy.costCaps.some(({ item, count }) =>
    stock(observation, item) - count < (policy.reserves.find(floor => floor.item === item)?.count ?? 0))) return false;
  if (offeredOpeningStart(observation, policy)) return true;
  if (policy.maxBreaks && observation.opportunities.some(offer => offer.risk === "guarded" && offer.verb === "break" &&
      offer.material?.subject.startsWith("block:") &&
      policy.allowedEffects.includes(`break:${offer.material.subject.slice("block:".length)}`) &&
      protectsStock(policy.reserves, observation, offer))) return true;
  return policy.maxCrafts > 0 && policy.target.kind === "stock" &&
    policy.allowedEffects.includes(`craft:${policy.target.item.slice("minecraft:".length)}`) &&
    preflightVanillaWork(observation, [{ policy, requires: [] }]).kind === "possible";
}

function postLookWorkStart(observation: MacroObservation, policy: MacroWorkPolicy): boolean {
  return policy.target.kind === "stock" && hasStock(observation, policy.reserves) && stock(observation, policy.target.item) < policy.target.count &&
    (witnessedSideStart(observation, policy) || !!foodWorkWitness(observation, policy) ||
      !!matchingTravelHint(observation, policy) || !!openingWorkWitness(observation, policy, {}) ||
      !!pricedTimberObstruction(observation, policy));
}

function workEvidence(observation: MacroObservation, lastReceipt: MacroReceipt | null): string {
  const pending = observation.pendingWork;
  return digest([observation.run, observation.life, observation.goal, observation.stance, observation.safety,
    lastReceipt?.life === observation.life ? lastReceipt.id : null,
    pending ? [pending.id, pending.state, pending.parked, pending.yieldable, !!pending.collectOfferId, !!pending.deferOfferId] : null,
    observation.timberObstruction,
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
  private replyCorrection?: ReplyCorrection;
  private readonly correctedContexts = new Set<string>();
  private feedback?: { readonly observation: MacroObservation; readonly value: MacroFeedback;
    readonly requestId?: string; readonly workStageIndex?: number };
  private lastReceipt: MacroReceipt | null = null;
  private lastWorkQueryReceipt: MacroReceipt | null = null;
  private lastProviderOutcome: MacroInference["outcome"] | null = null;
  private lastProviderLatencyMs: number | null = null;
  private lastDisposition: string | null = null;
  private preparedStockDecision?: PreparedStockDecision;
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
  private visualProbe?: VisualProbe;
  private visualFinding?: VisualFinding;
  private readonly visualBases = new Set<string>();
  private postLook?: PostLook;
  private readonly postLookBases = new Set<string>();
  private readonly jobs = new Map<string, WorkJob>();
  private job?: WorkJob;
  /** Until candidate acceptance, native still owns this exact older lease. */
  private previousJob?: WorkJob;
  private queuedWork?: QueuedWork;
  /** Paid production owns a dependency, not the player or the next open slot. */
  private pendingSuccessor?: QueuedWork;
  private newestJob?: WorkJob;
  private lastAcceptedJob?: WorkJob;
  private lastJobOutcome?: WorkJob;
  private firstLiveWorkView?: { readonly tick: number; readonly observedAt: number };
  private workQuery?: {
    readonly key: string; tick: number; readonly evidence: string; mayRecoverOnAffordance?: true;
    failedOpeningPolicy?: MacroWorkPolicy;
    reacquireTravel?: TravelReacquisition;
    emptyStartAbstention?: { readonly source: MacroObservation; readonly requestId: string };
  };
  private parkedWorkQueries?: {
    readonly id: string; readonly life: number; readonly tick: number; readonly since: number;
    readonly seen: Set<string>; settled?: true; reported?: true; recallLost?: true; lastQueryTick?: number;
  };
  private intentRecovery?: IntentRecovery;
  private readonly recoveredIntents = new Set<string>();
  private readonly workHandoffQueries = new Set<string>();
  private readonly workOverlapRequests = new Set<string>();
  private readonly collectedTickets = new Set<string>();
  private returnWitnessRevision = 0;
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
  private openingView?: OpeningView;
  private planning?: { readonly notice: MacroPlanning; readonly startedAt: number };
  private busy?: Busy;
  private ready?: Ready;
  private stopListener = () => { void this.stop().catch(() => {}); };

  constructor(private readonly config: SurvivalMacroConfig) {
    this.runDir = path.resolve(config.runDir);
    validateMacroId(config.run, "run");
    if (path.basename(this.runDir) !== config.run) throw new Error("Survival macro run ID does not match its private directory.");
    if (config.strategy !== "deterministic" && config.strategy !== "model") throw new Error("Invalid survival strategy.");
    this.directory = path.join(this.runDir, "macro");
    this.limits = checkedLimits(config.limits);
    this.capabilitiesVersion = config.capabilitiesVersion ?? MACRO_CAPABILITIES_VERSION;
    if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(this.capabilitiesVersion)) throw new Error("Invalid survival macro capability version.");
    if (config.objective !== undefined) {
      const objective = config.objective.trim();
      if (config.strategy !== "model" || !objective || objective.length > 2_048 || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(objective)) {
        throw new Error("Invalid survival macro task.");
      }
      this.objective = objective;
    }
    if (config.durableWork && config.strategy === "model") this.workMode = this.objective ? "constrained" : "preset";
    if (config.preparedStockReady && (this.workMode !== "constrained" || this.limits.maxRequests !== 1 ||
        config.firstPlan || config.skills || config.trial || config.nativeReview))
      throw new Error("Prepared stock work requires one constrained live request and no secondary authority.");
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
      if (this.unavailable) await this.disposition("provider_unavailable", { reason: "No admitted Model strategist." });
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
      strategy: this.config.strategy, model: this.config.model ?? null, state, capabilitiesVersion: this.capabilitiesVersion, limits: this.limits,
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
      workQueuedAfter: this.queuedWork?.after?.order.id ?? this.pendingSuccessor?.after?.order.id ?? null,
      requests: this.requests, providerDispatches: this.providerDispatches, unreportedDispatches: this.unreportedDispatches,
      skillCandidates: this.skillCandidates, staleDecisions: this.staleDecisions, issued: this.publishedIntents,
      terminalReceipts: this.terminalReceipts, completedReceipts: this.completedReceipts,
      lateCompletedReceipts: this.lateCompletedReceipts, unresolvedIntents: this.issued.size - this.terminalReceipts,
      nativeAuthority: this.nativeAuthority,
      budget: this.budget, lastReceipt: this.lastReceipt, lastProviderOutcome: this.lastProviderOutcome, lastDisposition: this.lastDisposition,
      lastProviderLatencyMs: this.lastProviderLatencyMs,
    };
  }

  stockNotExercised(): PreparedStockDecision | undefined {
    if (!this.config.preparedStockReady || this.polling || this.closing || this.faulted || this.unreportedDispatches ||
        !this.preparedStockDecision || this.busy || this.queuedWork || this.job || this.lastAcceptedJob) return;
    const job = this.newestJob;
    if (job) return { requestId: this.preparedStockDecision.requestId, disposition: "native_not_admitted",
      reason: job.terminal ? "The native actor ended the stock order before accepting it." :
        "The host withdrew the stock order without an eligible native acceptance." };
    return this.preparedStockDecision;
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

  private isVisualHandoff(observation: MacroObservation): boolean {
    return !!this.workMode && this.capabilitiesVersion === MACRO_CAPABILITIES_VERSION &&
      !this.firstPlanning && !this.config.preparedStockReady &&
      !this.queuedWork && !this.pendingSuccessor && !this.direct && !this.segment && !this.conditional && !this.lease &&
      this.isCurrentHandoff(observation) && observation.visualReady === true &&
      observation.stance !== undefined && observation.safety?.clear === true && !observation.pendingWork && !observation.working;
  }

  private visualBasis(observation: MacroObservation): string {
    // Ticks, opaque render IDs and animated pixels alone are not a new physical premise.
    return digest([observation.run, observation.life, observation.epoch, observation.goal, observation.stance, observation.safety?.revision]);
  }

  private currentVisualFinding(observation: MacroObservation): VisualFinding | undefined {
    const finding = this.visualFinding;
    if (finding && sameOpeningStance(finding.probe.source, observation) && observation.tick >= finding.result.tick &&
        observation.tick < finding.result.tick + MACRO_VISUAL_WITNESS_MAX_TICKS &&
        performance.now() - finding.probe.startedAt < VISUAL_WITNESS_MS) return finding;
  }

  private reconOffer(observation: MacroObservation, finding = this.currentVisualFinding(observation)): MacroOpportunity | undefined {
    const result = finding?.result;
    const reserves = this.floorScope?.life === observation.life ? this.floorScope.reserves : [];
    if (result?.status !== "witnessed" || !this.isVisualHandoff(observation) || !hasStock(observation, reserves)) return;
    return observation.opportunities.find(offer => offer.verb === MACRO_RECON && offer.risk === "low" &&
      offer.anchor?.subject === MACRO_RECON_ANCHOR && offer.anchor.target === result.candidateId &&
      !this.effectKeys.has(digest([MACRO_RECON, observation.life, observation.epoch, result.candidateId])));
  }

  private visualContext(observation: MacroObservation): MacroRequest["visual"] {
    if (!this.isVisualHandoff(observation)) return;
    const finding = this.currentVisualFinding(observation);
    const mayNominate = !!this.config.frame && !this.visualBases.has(this.visualBasis(observation));
    if (!finding) return mayNominate ? { mayNominate } : undefined;
    const { result, probe } = finding;
    const { tick } = result;
    const read = result.status === "witnessed"
      ? { tick, region: probe.wire.region, status: result.status,
        candidateId: result.candidateId, subject: result.subject, distanceBlocks: result.distanceBlocks }
      : { tick, region: probe.wire.region, status: result.status };
    const offer = this.reconOffer(observation, finding);
    return { mayNominate, read, ...(offer ? { reconOpportunityId: offer.id } : {}) };
  }

  private visualWake(observation: MacroObservation): VisualFinding | undefined {
    if (!this.isVisualHandoff(observation)) return;
    const finding = this.currentVisualFinding(observation);
    if (!finding || finding.followedUp) return;
    // A witnessed result and its optional motor offer may arrive in either order.
    if (finding.result.status === "witnessed" && !this.reconOffer(observation, finding) &&
        observation.tick - finding.result.tick < FIRST_ACTIONABLE_VIEW_TICKS &&
        performance.now() - finding.receivedAt < FIRST_ACTIONABLE_VIEW_MS) return;
    return finding;
  }

  private armPostLook(issued: Issued): void {
    const receipt = issued.terminal;
    if (!issued.paidCameraRead || !this.config.frame || this.config.preparedStockReady || this.closing ||
        this.capabilitiesVersion !== MACRO_CAPABILITIES_VERSION || this.requests >= this.limits.maxRequests ||
        !issued.accepted || receipt?.status !== "completed" || issued.withdrawn || issued.scope.stance === undefined) return;
    const { run, life, goal, stance } = issued.scope;
    const key = digest([run, life, goal, stance]);
    if (this.postLookBases.has(key)) return;
    this.postLookBases.add(key);
    this.postLook = { issued, terminalTick: receipt.tick, until: performance.now() + POST_LOOK_MS,
      expiresTick: Math.min(issued.intent.expiresTick, receipt.tick + POST_LOOK_TICKS) };
  }

  private retainedPostLook(look: PostLook, current: MacroObservation): boolean {
    return sameOpeningStance(look.issued.scope, current) && current.tick < look.expiresTick &&
      performance.now() < look.until;
  }

  private postLookHasOrdinaryStart(look: PostLook, observation: MacroObservation): boolean {
    return !!(observation.travelHint || observation.prospectOpening || observation.surfaceOpening || observation.timberObstruction ||
      observation.opportunities.some(offer => !isOpeningView(offer) &&
        (meaningfulPrimitive(offer) || offer.verb === MACRO_FOOD_CLUE || offer.verb === MACRO_WATER_CLUE) &&
        !offersAffordance(look.issued.scope, offer)));
  }

  private async tryPostLook(view: View): Promise<void> {
    const look = this.postLook;
    if (!look) return;
    const { observation } = view;
    if (!this.retainedPostLook(look, observation) || this.job || this.pending || this.lastReceipt?.id !== look.issued.intent.id) {
      this.postLook = undefined;
      return;
    }
    if (observation.tick <= look.terminalTick || !this.isVisualHandoff(observation) ||
        (this.visualBases.has(this.visualBasis(observation)) && !look.issued.cameraFrame) ||
        this.closing || !this.config.strategist || this.unavailable || this.requests >= this.limits.maxRequests) return;
    const reserves = this.floorScope?.life === observation.life ? this.floorScope.reserves : [];
    if (!hasStock(observation, reserves) || this.postLookHasOrdinaryStart(look, observation)) return;
    this.postLook = undefined;
    const workDemand: MacroWorkDemand = { mode: this.workMode!, demand: "changed", protectedReserves: reserves,
      current: null, lastOutcome: null };
    await this.begin(view, { workDemand }, undefined, look);
  }

  private async finishVisualProbe(reason: string, result?: MacroVisualProbeResult): Promise<void> {
    const probe = this.visualProbe;
    if (!probe) return;
    await this.ipc!.remove("visual-probe.json");
    this.visualProbe = undefined;
    await this.record("visual_probe_outcome", { requestId: probe.wire.requestId, id: probe.wire.id, reason, ...(result ? { result } : {}) });
    if (result) this.visualFinding = { probe, result, receivedAt: performance.now() };
  }

  private async advanceVisualProbe(current: MacroObservation | undefined, runtimeExpired: boolean): Promise<void> {
    const probe = this.visualProbe;
    if (!probe) return;
    const wire = probe.wire;
    if (runtimeExpired || !current || !sameOpeningStance(probe.source, current) ||
        current.tick >= wire.expiresTick || performance.now() >= probe.until) {
      await this.finishVisualProbe(runtimeExpired ? "runtime_wall_limit" :
        !current || !sameOpeningStance(probe.source, current) ? "visual_scope_changed" : "visual_probe_expired");
      return;
    }
    let result: MacroVisualProbeResult | null;
    try { result = await this.ipc!.read("visual-probe-result.json", parseMacroVisualProbeResult); }
    catch (error) {
      if (error instanceof MacroObservationRotating) return;
      throw error;
    }
    if (!result || result.id !== wire.id) return;
    if (result.run !== wire.run || result.life !== wire.life || result.epoch !== wire.epoch ||
        result.requestId !== wire.requestId || result.captureId !== wire.captureId || result.imageSha256 !== wire.imageSha256 ||
        result.tick < wire.basisTick || result.tick > wire.expiresTick) {
      await this.finishVisualProbe("visual_result_binding_mismatch");
      return;
    }
    if (result.tick > current.tick) return;
    await this.finishVisualProbe("native_result", result);
  }

  private async nominateVisual(plan: Plan, action: Extract<MacroProposal["action"], { kind: "nominate-visible" }>): Promise<void> {
    const delivered = plan.deliveredVisual;
    const reason = "Visual nomination requires the exact native render and bytes actually dispatched for this request.";
    if (!plan.visual?.mayNominate || !delivered || delivered.captureId !== action.captureId ||
        delivered.imageSha256 !== action.imageSha256 || !await delivered.verify()) {
      await this.record("visual_nomination_refused", { requestId: plan.requestId, reason });
      return;
    }
    const current = await this.refresh();
    const source = plan.observation;
    if (!current || !this.isVisualHandoff(current) || !sameOpeningStance(source, current) ||
        current.tick >= Math.min(plan.proposal.expiresTick, source.tick + MACRO_VISUAL_WITNESS_MAX_TICKS)) {
      await this.record("visual_nomination_refused", { requestId: plan.requestId, reason: "The live camera or probe expiry changed." });
      return;
    }
    const key = this.visualBasis(source);
    // One completed, paid camera turn may expose a distinct image on the same stance.
    // begin() checks that image against the one actually sent before the turn.
    if (this.visualBases.has(key) && !plan.postLook?.issued.cameraFrame) {
      await this.record("visual_nomination_refused", { requestId: plan.requestId, reason: "This unchanged visual stance was already nominated." });
      return;
    }
    const expiresTick = Math.min(plan.proposal.expiresTick, current.tick + VISUAL_PROBE_TICKS,
      source.tick + MACRO_VISUAL_WITNESS_MAX_TICKS);
    const wire = parseMacroVisualProbe({ v: 1, run: current.run, life: current.life, epoch: current.epoch, basisTick: current.tick,
      id: randomUUID(), requestId: plan.requestId, captureId: action.captureId, imageSha256: action.imageSha256, expiresTick,
      region: action.region });
    await this.record("visual_probe_prepared", { requestId: plan.requestId, probe: wire, imageBasis: basis(source) });
    if (this.closing) return;
    const fresh = await this.refresh();
    if (!fresh || !this.isVisualHandoff(fresh) || !sameOpeningStance(current, fresh) || fresh.tick >= expiresTick) {
      await this.record("visual_nomination_refused", { requestId: plan.requestId, reason: "The live camera changed before publication." });
      return;
    }
    this.visualBases.add(key);
    this.visualFinding = undefined;
    const startedAt = performance.now();
    this.visualProbe = { wire, source, startedAt, until: startedAt + VISUAL_PROBE_TICKS * 50 };
    await this.ipc!.write("visual-probe.json", wire);
    await this.record("visual_probe_issued", { requestId: plan.requestId, id: wire.id });
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
    const [mailbox, barrier, planning, order, probe] = await Promise.all([
      ipc.read("intent.json", parseMacroIntent), ipc.read("handoff.json", parseMacroHandoff), ipc.read("planning.json", parseMacroPlanning),
      this.workMode ? ipc.read("work.json", parseMacroWorkOrder) : null,
      ipc.read("visual-probe.json", parseMacroVisualProbe),
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
    if (probe ? !this.visualProbe || digest(probe) !== digest(this.visualProbe.wire) : !!this.visualProbe) {
      throw new Error("Survival macro visual mailbox changed outside its owner.");
    }
    const now = performance.now();
    const view = this.view;
    const current = view && now - this.observedAt <= this.limits.maxObservationAgeMs ? view.observation : undefined;
    const runtimeExpired = now - this.startedAt! >= this.limits.maxRuntimeMs;
    if (this.visualProbe) {
      if (!observed && current && !runtimeExpired) return;
      await this.advanceVisualProbe(current, runtimeExpired);
      if (this.visualProbe || this.closing) return;
    }
    if (this.intentRecovery && (runtimeExpired || !current || this.pending || this.job || this.queuedWork ||
        !this.intentRecoveryCurrent(this.intentRecovery, current))) this.intentRecovery = undefined;
    if (this.firstPlanning) {
      await this.advanceFirstPlan(current, !!observed, runtimeExpired ? "runtime_wall_limit" : undefined);
      // A single provider slot is shared across both stages, even while abort
      // is draining. An admitted first job is handled on the next poll.
      if (this.firstPlanning || this.job || this.closing) return;
    }
    const job = this.job;
    if (job) {
      if (runtimeExpired || !current || !workScope(job.source, current, job.health) || current.tick >= job.order.expiresTick ||
          (job.renews && !job.accepted && current.tick >= job.renews.order.expiresTick)) {
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
      (isPendingWorkVerb(this.pending.offer.verb) && !workScope(this.pending.scope, current)) ||
      (this.pending.intent.recon && (!workScope(this.pending.scope, current) || !hasStock(current, this.pending.reserves ?? []) ||
        now >= this.pending.reconUntil! || !this.pending.accepted &&
        (!sameOpeningStance(this.pending.scope, current) || current.tick - this.pending.intent.basisTick >= WORK_ADMISSION_TICKS))) ||
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
          ? work.context.correction ? (!!observed && !this.replyCorrectionApplies(work.context.correction, current)) :
            work.context.reconsideration?.kind === "superseded-opening" ?
              (!!observed && !this.supersededOpeningCurrent(work.context.reconsideration, current)) :
            work.context.lookahead ? lookaheadStale : work.context.workDemand ?
              !workScope(work.context.observation, current) || !this.pendingDecisionCurrent(work.context, current) :
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
    if (this.openingView) {
      await this.advanceOpeningView(current, runtimeExpired);
      return;
    }
    if (this.pendingSuccessor) await this.advancePendingSuccessor(current, runtimeExpired);
    if (this.queuedWork) await this.advanceQueuedWork(current, runtimeExpired);
    if (this.replyCorrection && (!current || !this.replyCorrectionApplies(this.replyCorrection, current))) {
      this.replyCorrection = undefined;
    }
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
    if (this.closing || this.busy || this.ready || !current) return;
    if (this.queuedWork) {
      if (this.requests < this.limits.maxRequests) await this.scheduleWork(this.view!, this.queuedWork);
      return;
    }
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
    const finished = this.completedWorkProgram;
    if (!this.job && finished?.stage === PRE_SPAWN_GOAL_ONLY && finished.basis.life === current.life &&
        finished.goal === current.goal && (finished.invocationItemCount ?? 0) > 0 &&
        stock(current, `minecraft:${current.goal}`) > 0) return;
    if (this.workMode === "preset" && !this.bootstrappedWork && !this.job && !current.pendingWork && this.config.strategist &&
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
    // A chosen contingent side needs no second provider request and may run
    // even after the request budget is exhausted.
    if (this.workMode && await this.tryPreparedSide(current)) return;
    if (this.requests >= this.limits.maxRequests) {
      if (!this.budget) {
        this.budget = "requests";
        await this.disposition("budget_limited", { budget: this.budget });
      }
      return;
    }
    // The journal can retire an effect before observation.json reaches its
    // terminal tick. Do not spend a decision on a pre-effect view plus its outcome.
    if (!this.job && current.tick <= this.handoffAfterTick && !(this.workMode && current.pendingWork?.parked)) return;
    if (this.workMode) {
      if (this.requests === 0 && this.config.preparedStockReady && !this.config.preparedStockReady(current)) return;
      await this.scheduleWork(this.view!, undefined, this.visualWake(current));
      if (!this.busy && !this.job && !this.pending && this.view?.observation === current) await this.tryPostLook(this.view);
      return;
    }
    if (!this.config.strategist || !alive(current) || current.safety?.clear === false ||
        (!current.quiescent && !current.opportunities.some(offer => offer.verb !== MACRO_RECON))) return;
    const latest = this.view!;
    const correction = this.replyCorrection;
    if (!correction && this.queryKeys.has(latest.query)) {
      if (this.heldQuery !== latest.query && latest.query === this.lastAsked?.query && now - latest.changedAt >= this.limits.stuckAfterMs) {
        this.heldQuery = latest.query;
        await this.record("replan_held", { basis: basis(current), reason: "No new native or admission evidence." });
      }
      return;
    }
    await this.begin(latest, { correction });
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
      const advice = inference.stage === PRE_SPAWN_GOAL_ONLY && inference.model === this.config.model &&
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
    const insideFirstView = (view: MacroObservation) => !!first &&
      performance.now() - work.first!.observedAt <= FIRST_ACTIONABLE_VIEW_MS && view.tick - first.tick <= FIRST_ACTIONABLE_VIEW_TICKS;
    const inViewWindow = !!current && insideFirstView(current);
    if (terminal || this.closing || this.config.signal?.aborted) work.rejection = terminal ?? "stop";
    else if (first && (!current || !firstPlanScopeMatches(request, first, current, this.config.run)))
      work.rejection ??= current ? "live_scope_changed" : "live_observation_stale";
    else if ((!work.result && now >= work.until) || (work.result && work.result.settledAt > work.until))
      work.rejection ??= "request_timeout";
    else if (observed && inViewWindow && current) {
      if (current.travelHint?.kind === "resource") work.resourceView ??= current;
      if (current.opportunities.length) work.actionable ??= current;
    }
    if (first && !work.actionable && !work.resourceView && !inViewWindow && !work.result)
      work.rejection ??= "first_actionable_view_deadline";
    if (work.rejection && !work.result) work.cancel.abort();
    const result = work.result;
    if (!result) return;

    const { inference, advice } = result;
    const modelMatches = inference?.stage === PRE_SPAWN_GOAL_ONLY && inference.model === this.config.model;
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
    const { actionable: offered, resourceView: resource } = work;
    const firstStart = offered && (!resource || offered.tick <= resource.tick) ? offered : resource;
    if (!firstStart) {
      // Even before rendering, native inventory is real. Do not wait for an
      // explicitly false condition, nor use a view arriving after this window.
      const check = bindFirstPlan(request, advice, current, bindingScope);
      if ("reason" in check && (check.reason === "stock_prerequisite_missing" || check.reason === "protected_stock_missing"))
        return reject(check.reason);
      if (!inViewWindow) return reject("first_actionable_view_deadline");
      return;
    }
    if (!observed) return;
    const firstBinding = bindFirstPlan(request, advice, firstStart, bindingScope);
    // An inspect offer can precede the actual rendered approach. Give only a
    // new resource hint the rest of the existing first-view window, not a new quote.
    // An unrelated hint by itself does not displace the first ordinary offer.
    const missingStart = "reason" in firstBinding && firstBinding.reason === "no_matching_live_material";
    const secondStart = missingStart ? (firstStart === offered ? resource : offered) : undefined;
    if (missingStart && !secondStart && (!offered || !resource) && inViewWindow) return;
    const secondBinding = secondStart && secondStart !== firstStart ? bindFirstPlan(request, advice, secondStart, bindingScope) : undefined;
    // A second publication behind a real offer can add a physical approach,
    // not substitute a later ordinary offer for the original one.
    const useSecond = secondBinding && (firstStart !== offered || "reason" in secondBinding || !!secondBinding.travelHint);
    const original = useSecond ? secondBinding : firstBinding;
    const actionable = useSecond ? secondStart! : firstStart;
    if ("reason" in original) return reject(original.reason);
    const stageOffset = original.stockSatisfied?.length ?? 0;
    const travel = original.travelHint;
    if ((stageOffset || travel) && !inViewWindow) return reject("first_actionable_view_deadline");
    const key = workPolicyKey(original.policy);
    const startingStock = original.stockSatisfied ? digest(original.stockSatisfied) : null;
    const expiresTick = actionable.tick + this.limits.maxIntentTtlTicks;
    const declared = original.then ? [{ policy: original.policy, requires: original.requires }, ...original.then] : undefined;
    const stageIds = declared ? workStageIds(requestId, declared, 0, stageOffset) : undefined;
    let stages = declared;
    let diagnostic: VanillaWorkDiagnostic | undefined;
    let bound = original;
    let freshRejection: string | undefined;
    const rebind = (fresh: MacroObservation) => {
      if (this.job || performance.now() - this.observedAt > this.limits.maxObservationAgeMs) {
        freshRejection = this.job ? "native_work_incumbent" : "live_observation_stale";
        return false;
      }
      if (stageOffset || travel) {
        if (!insideFirstView(fresh)) {
          freshRejection = "first_actionable_view_deadline";
          return false;
        }
        if (fresh.epoch !== actionable.epoch || (travel &&
            (!this.isCurrentHandoff(fresh) || !sameTravelReacquisitionScope(actionable, fresh)))) {
          freshRejection = "fresh_binding_changed";
          return false;
        }
      }
      const binding = bindFirstPlan(request, advice, fresh, bindingScope, original.branchIndex);
      if ("reason" in binding || binding.input !== original.input || workPolicyKey(binding.policy) !== key ||
          (travel ? !sameTravelReacquisitionHint(travel, binding.travelHint) : !!binding.travelHint) ||
          (binding.stockSatisfied ? digest(binding.stockSatisfied) : null) !== startingStock ||
          (declared && (!binding.liveTargets.some(target => original.liveTargets.includes(target)) ||
            digest(binding.then) !== digest(original.then)))) {
        freshRejection = "reason" in binding ? binding.reason : "fresh_binding_changed";
        return false;
      }
      bound = binding;
      return true;
    };
    const job = await this.publishWork(actionable, original.policy, "model", requestId, expiresTick,
      original.requires, undefined, rebind, stageIds, declared && !stageOffset ? (fresh => {
        const checked = preflightVanillaWork(fresh, declared);
        if ("detail" in checked && checked.detail !== undefined) diagnostic = checked;
        if (checked.kind === "shortage") {
          if (checked.stageIndex === 0) {
            freshRejection = "work_resource_shortage";
            return false;
          }
          stages = declared.slice(0, checked.stageIndex);
          stageIds!.nextWorkId = workStageIds(requestId, stages, 0).nextWorkId;
        }
        return true;
      }) : undefined, undefined, undefined,
      travel ? (_basis, latest) => rebind(latest) : undefined,
      travel ? () => ({ travelAnchor: { subject: travel.subject, target: travel.target } }) : undefined);
    if (!job) {
      if (diagnostic && freshRejection === "work_resource_shortage") await this.reportWorkShortage(requestId, diagnostic, this.view!.observation);
      return reject(freshRejection ?? (this.closing || this.config.signal?.aborted ? "stop" :
        job === null ? "live_observation_rotating" : "fresh_work_admission_rejected"), this.view?.observation);
    }
    job.bootstrap = stageOffset + 1;
    const usedAt = performance.now();
    if (diagnostic) {
      await this.reportWorkShortage(requestId, diagnostic, job.source);
      if (declared && stages && stages.length < declared.length)
        await this.record("work_successor_discarded", { requestId, afterWorkId: null, stage: diagnostic.stageIndex + 1,
          programSource: PRE_SPAWN_GOAL_ONLY, reason: "work_resource_shortage", detail: diagnostic.detail });
    }
    if (declared && stages && (stages.length > 1 || stageOffset > 0)) {
      const declaredStages = declared.length + stageOffset;
      this.queuedWork = { after: job, plan: { requestId, observation: job.source, proposal: { expiresTick } },
        stages, next: 1, bootstrap: { branchIndex: original.branchIndex, declaredStages, stageOffset } };
      await this.record("work_program_stage", {
        requestId, id: job.order.id, stage: stageOffset + 1, stages: declaredStages, programSource: PRE_SPAWN_GOAL_ONLY,
      });
    }
    this.firstPlanning = undefined;
    await this.record("first_plan_bound", {
      ...scope, id: job.order.id, basis: basis(job.source), firstBasis: basis(first), actionableBasis: basis(actionable),
      branchIndex: bound.branchIndex, branchCount: advice.branches.length, input: bound.input, liveTargets: bound.liveTargets,
      ...(travel ? { travelHint: travel } : {}),
      ...(declared ? { declaredStages: declared.length + stageOffset } : {}),
      ...(bound.stockSatisfied ? { firstIssuedStage: stageOffset + 1, eligibleSuffixStages: stages!.length,
        stockSatisfied: bound.stockSatisfied.map(({ item, count }, index) =>
          ({ stage: index + 1, item, required: count, observed: stock(job.source, item) })) }
        : declared ? { eligiblePrefixStages: stages!.length } : {}),
      disposition: "work_order_published", nativeAccepted: false,
      timeToFirstUseMs: Math.round(usedAt - (work.dispatchedAt ?? inference?.providerStartedAtMs ?? work.startedAt)),
      firstLiveToFirstUseMs: Math.round(usedAt - work.first!.observedAt),
    });
  }

  private workQueryEvidence(observation: MacroObservation): string {
    return digest([workEvidence(observation, this.lastWorkQueryReceipt), this.returnWitnessRevision]);
  }

  private intentRecoveryCurrent(recovery: IntentRecovery, current: MacroObservation, evidence = this.workQueryEvidence(current)): boolean {
    return current.tick < recovery.expiresTick && performance.now() < recovery.until &&
      current.run === recovery.basis.run && current.life === recovery.basis.life && current.epoch === recovery.basis.epoch &&
      current.health === recovery.health && current.safety?.clear === true && evidence === recovery.evidence;
  }

  private supersededOpeningWitnessCurrent(recovery: Extract<IntentRecovery, { kind: "superseded-opening" }>,
    current: MacroObservation, evidence = this.workQueryEvidence(current)): boolean {
    if (current.tick >= recovery.proposalExpiresTick || current.health !== recovery.health || evidence !== recovery.evidence ||
        !sameOpeningStance(recovery.source, current)) return false;
    const fresh = replacementOpeningWitness(current, recovery.policy, recovery.offer);
    return !!fresh && sameOpeningWitness(recovery.replacement, fresh);
  }

  private supersededOpeningCurrent(recovery: Extract<IntentRecovery, { kind: "superseded-opening" }>,
    current: MacroObservation, evidence?: string): boolean {
    return this.openingHandoff(recovery.source, current, recovery.policy) &&
      this.supersededOpeningWitnessCurrent(recovery, current, evidence);
  }

  private alternativeRecovery(current: MacroObservation, evidence?: string): Extract<IntentRecovery, { kind: "alternative" }> | undefined {
    const recovery = this.intentRecovery;
    if (recovery?.kind !== "alternative" || current.tick - recovery.basis.tick < WORK_REPLAN_GAP_TICKS ||
        current.working || !this.isCurrentHandoff(current) || !this.intentRecoveryCurrent(recovery, current, evidence)) return;
    const opening = recovery.opening;
    if (opening) {
      if (!this.openingHandoff(opening.source, current, opening.policy)) return;
      if (openingWorkWitness(current, opening.policy, recovery.offer)) return recovery;
      if (current.opportunities.some(offer => {
        if (sameAffordance(recovery.offer, offer) || this.effectKeys.has(primitiveEffectKey(current, offer))) return false;
        return (offer.verb === "approach" && offer.risk === "low" && offer.anchor?.subject === "route:dry") ||
          (offer.verb === "follow" && offer.risk === "guarded" && offer.anchor?.subject === "route:dry" &&
            (this.workMode === "preset" || opening.policy.allowedEffects.includes(MACRO_DIAMOND_PROSPECT))) ||
          (!!offer.anchor && openingViewMatchesPolicy(offer, opening.policy));
      })) return recovery;
      return;
    }
    const ticket = current.pendingWork;
    const reserves = this.floorScope?.life === current.life ? this.floorScope.reserves : [];
    if (ticket?.parked) {
      if (!ticket.worksite) return;
      const collect = ticket.collectOfferId && current.opportunities.find(offer => offer.id === ticket.collectOfferId);
      if (collect && this.parkedCollectionOwned(ticket, current.life) &&
          !this.effectKeys.has(digest([current.life, "collect-pending", ticket.id, collect.evidence]))) return recovery;
    }
    if (current.opportunities.some(offer => {
      if (!meaningfulPrimitive(offer) || this.effectKeys.has(primitiveEffectKey(current, offer))) return false;
      if (offer.risk === "guarded" && (this.workMode === "constrained" ||
          (reserves.length > 0 && !protectsStock(reserves, current, offer)))) return false;
      return !sameAffordance(recovery.offer, offer);
    })) return recovery;
  }

  private parkedCollectionOwned(ticket: MacroPendingWork, life: number): boolean {
    const owner = this.jobs.get(ticket.id);
    if (this.collectedTickets.has(`${life}:${ticket.id}`)) return false;
    return ticket.historical || (owner?.order.life === life && owner.terminal?.status !== "completed" &&
      (!!owner.parked || (!!owner.accepted && owner.terminal?.status === "interrupted")));
  }

  private pendingPredecessor(ticket: MacroPendingWork | undefined, life: number): MacroWorkDemand["pendingPredecessor"] {
    const owner = ticket && this.jobs.get(ticket.id);
    if (!owner?.accepted || owner.order.life !== life || owner.withdrawn || owner.terminal) return;
    const queuedTarget = this.pendingSuccessor?.after === owner ? this.pendingSuccessor.stages[0]?.policy.target : undefined;
    return { id: owner.order.id, ...(queuedTarget ? { queuedTarget } : {}) };
  }

  private parkedOrdinaryWindow(ticketId: string, observation: MacroObservation, incumbent = this.job): boolean {
    const ticket = observation.pendingWork;
    const owner = this.jobs.get(ticketId);
    if (!ticket?.parked || ticket.id !== ticketId || ticket.historical || ticket.goal !== observation.goal ||
        !owner?.parked || owner.order.life !== observation.life || owner.terminal || owner.withdrawn ||
        observation.safety?.clear !== true || this.pending || this.previousJob || this.job !== incumbent) return false;
    if (!incumbent) return !!ticket.worksite && !observation.working && this.isCurrentHandoff(observation);
    return incumbent.order.duringWaitFor === ticketId && !!incumbent.accepted && !incumbent.terminal &&
      !incumbent.withdrawn && !incumbent.policy.allowedEffects.includes(MACRO_WATER_FILL) &&
      workScope(incumbent.source, observation, incumbent.health);
  }

  private canRenewWork(job: WorkJob, observation: MacroObservation): boolean {
    const native = observation.workOrder;
    const { order, policy } = job;
    return this.job === job && !this.previousJob && !!job.accepted && job.accepted.tick <= observation.tick &&
      !job.terminal && !job.withdrawn && !job.parked && observation.tick < order.expiresTick &&
      native?.id === order.id && (native.state === "working" || native.state === "needs_replan") &&
      workScope(job.source, observation, job.health) &&
      !policy.allowedEffects.includes(MACRO_IRON_SMELT) && !policy.allowedEffects.includes(MACRO_WATER_FILL) &&
      !isFoodWork(policy) &&
      (!order.duringWaitFor || this.parkedOrdinaryWindow(order.duringWaitFor, observation, job));
  }

  private async scheduleWork(view: View, queue?: QueuedWork, visualWake?: VisualFinding): Promise<void> {
    const { observation } = view;
    const job = this.job;
    const ticket = observation.pendingWork;
    const previous = this.workQuery;
    const travel = observation.travelHint;
    const reacquisition = previous?.reacquireTravel;
    let recoveryEvidence: string | undefined;
    let reacquiredTravelOf: string | undefined;
    if (previous && reacquisition) {
      const { source, hint, until, requestId } = reacquisition;
      if (queue || !this.isCurrentHandoff(observation) || !sameTravelReacquisitionScope(source, observation) ||
          observation.tick - source.tick >= ALTERNATIVE_RECOVERY_TICKS || performance.now() >= until ||
          (travel && !sameTravelReacquisitionHint(hint, travel)) ||
          (recoveryEvidence = this.workQueryEvidence(observation)) !== previous.evidence) {
        previous.reacquireTravel = undefined;
      } else if (travel && observation.tick > source.tick) reacquiredTravelOf = requestId;
    }
    if (!job && !queue && ticket?.parked) {
      await this.scheduleParkedWork(view, ticket);
      return;
    }
    if (!ticket?.parked) this.parkedWorkQueries = undefined;
    if (!this.config.strategist || this.unavailable || !alive(observation) || observation.safety?.clear !== true) return;
    const complete = this.completedWorkProgram;
    if (!job && complete?.finalOrder.target.kind === "preset" &&
        complete.basis.life === observation.life && complete.goal === observation.goal) return;
    if (this.previousJob) return; // A published candidate has not settled; the incumbent remains authoritative.
    if (!previous && !job && !queue && !this.config.preparedStockReady && emptyFirstWorkView(observation)) {
      // The first ordinary dispatch can land between native idle publications,
      // including after a pre-spawn refusal. Let the camera settle, without holding the game.
      const first = this.firstLiveWorkView ??= { tick: observation.tick, observedAt: this.observedAt };
      if (observation.tick - first.tick < FIRST_ACTIONABLE_VIEW_TICKS &&
          performance.now() - first.observedAt < FIRST_ACTIONABLE_VIEW_MS) return;
    }
    const nativeState = job && observation.workOrder?.id === job.order.id ? observation.workOrder : null;
    let overlap: WorkOverlap | undefined;
    if (job?.policy.allowedEffects.includes(MACRO_IRON_SMELT)) {
      // A paid batch cannot be renewed or replaced. Only an observed cook can
      // open a one-shot, contingent successor query while this batch runs.
      const burn = nativeState?.progress?.smeltBurn;
      // A paid multi-unit batch publishes its offers only after clean Esc.
      // Don't spend the fallback request on an earlier occupied GUI view.
      if (burn && burn.units > 1 && !observation.pendingWork) return;
      const handsFree = this.paidReleaseWindow(job, observation);
      const wallTicks = (this.startedAt! + this.limits.maxRuntimeMs - performance.now()) / 50;
      if (queue || job.order.origin !== "model" || !job.accepted || job.terminal || job.withdrawn || job.smeltLookedAhead ||
          nativeState?.state !== "working" || !burn || burn.burnTick <= job.accepted.tick ||
          burn.units > job.policy.maxCrafts || (!handsFree && (burn.units !== 1 || observation.working ||
            burn.remainingCookTicks < MACRO_SMELT_OVERLAP_MIN_COOK_TICKS ||
            burn.remainingCookTicks >= Math.min(job.order.expiresTick - observation.tick, this.limits.maxIntentTtlTicks, wallTicks)))) return;
      overlap = { incumbent: job, queue, smeltBurnTick: burn.burnTick };
    }
    const replan = nativeState?.progress?.replan;
    const needsRenewal = !!job && this.canRenewWork(job, observation) &&
      (replan === "expiry_near" || job.order.expiresTick - observation.tick <= this.renewLeadTicks);
    const target = job?.policy.target;
    const lastEffect = nativeState?.progress?.lastEffect;
    const productive = !!lastEffect && observation.tick - lastEffect.tick <= 120;
    const owner = queue?.plan.requestId ?? (job?.bootstrap ? job.requestId : null);
    const shortagePending = !!owner && this.feedback?.requestId === owner &&
      (this.feedback.workStageIndex ?? -1) >= (queue?.next ?? 1) &&
      this.currentFeedback(observation)?.kind === "work_resource_shortage";
    const progressedStock = target?.kind === "stock" && !!job && stock(observation, target.item) > stock(job.source, target.item);
    const phase = nativeState?.progress?.phase;
    const gathering = !!job && target?.kind === "stock" && (phase === "harvest" || phase === "collect" ||
      phase === "route" && job.policy.maxBreaks > 0);
    const repair = shortagePending && gathering && (progressedStock || productive && phase !== "route");
    const openingTail = !!queue?.bootstrap && queue.next === queue.stages.length && productive && replan === "target_near" &&
      target?.kind === "stock" && target.item !== `minecraft:${observation.goal}` && stock(observation, `minecraft:${observation.goal}`) === 0;
    overlap ??= owner && !this.workOverlapRequests.has(owner) && job?.accepted && !job.terminal && !job.withdrawn &&
      (!queue || queue.after === job) && (nativeState?.state === "working" || nativeState?.state === "needs_replan") &&
      (repair || openingTail) ? { incumbent: job, queue } : undefined;
    // Programs already supply the next course and share one fixed expiry.
    // Only query over a queued path for the existing overlap decisions.
    if ((queue || shortagePending) && !overlap) return;
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
    if (previous && job && !needsRenewal && !nextCourse && !overlap) return;
    const outcome = this.lastJobOutcome && sameGoalAndLife(this.lastJobOutcome.source, observation) ? this.lastJobOutcome : undefined;
    const outcomeState = outcome && outcome.order.id === observation.workOrder?.id ? observation.workOrder : null;
    const evidence = recoveryEvidence ?? this.workQueryEvidence(observation);
    const protectedReserves = this.floorScope?.life === observation.life ? this.floorScope.reserves : [];
    const emptyStart = previous?.emptyStartAbstention;
    let firstLiveReadOf: string | undefined;
    if (previous && emptyStart) {
      const { source, requestId } = emptyStart;
      if (job || queue || observation.workOrder || previous.evidence !== evidence || !sameOpeningStance(source, observation) ||
          !hasStock(observation, protectedReserves)) previous.emptyStartAbstention = undefined;
      else if (observation.tick > source.tick && this.isCurrentHandoff(observation) &&
          observation.opportunities.some(offer => firstWorkRead(offer) &&
            !this.effectKeys.has(primitiveEffectKey(observation, offer)))) firstLiveReadOf = requestId;
    }

    let demand: MacroWorkDemand["demand"];
    let key: string;
    if (overlap) {
      demand = "successor";
      key = overlap.smeltBurnTick === undefined ? `queued-successor:${owner}:${overlap.incumbent.order.id}` :
        `smelt-successor:${overlap.incumbent.order.id}`;
    } else if (needsRenewal) {
      demand = "renew";
      key = `renew:${job!.order.id}`;
    } else if (!previous) {
      demand = "first";
      key = `first:${observation.life}`;
    } else if (nextCourse) {
      demand = "successor";
      key = `successor:${job!.order.id}`;
    } else if (outcome?.terminal && observation.tick >= outcome.terminal.tick) {
      demand = outcomeState?.state === "blocked" || outcome.terminal.status === "refused" ? "blocked" : "outcome";
      key = digest([observation.life, demand, workPolicyKey(outcome.policy), outcome.terminal.status, outcome.terminal.detail, evidence]);
    } else {
      demand = "changed";
      key = evidence;
    }
    const asked = this.lastAsked?.observation;
    const visualStart = !job && !queue && !this.postLook && asked?.visualReady !== true && this.visualContext(observation)?.mayNominate
      ? digest(["first visual handoff", this.visualBasis(observation)]) : undefined;
    const newVisualStart = !!asked && !!visualStart && !this.workHandoffQueries.has(visualStart);
    const scout = !job && !queue && this.isCurrentHandoff(observation) && hasStock(observation,
      this.floorScope?.life === observation.life ? this.floorScope.reserves : [])
      ? observation.opportunities.find(offer => isGroundScout(offer) && !this.effectKeys.has(primitiveEffectKey(observation, offer)))
      : undefined;
    const scoutQuery = scout ? digest(["ground scout available", observation.life, observation.stance,
      observation.safety?.revision, scout.anchor]) : null;
    const newScout = !!asked && !!scout && !!scoutQuery &&
      !offersAffordance(asked, scout) && !this.workHandoffQueries.has(scoutQuery);
    const obstruction = !job && !travel ? observation.timberObstruction : undefined;
    const obstructionQuery = obstruction ? digest(["timber obstruction", observation.life, observation.stance,
      observation.safety?.revision, obstruction, stock(observation, obstruction.timber)]) : null;
    const newObstruction = obstruction && !!asked && !sameTimberObstruction(obstruction, asked.timberObstruction);
    const surface = !job && !queue && this.workMode === "constrained" && this.isCurrentHandoff(observation)
      ? observation.surfaceOpening : undefined;
    const surfaceQuery = surface ? digest(["surface opening", observation.life, observation.stance,
      observation.safety?.revision, surface]) : null;
    const newSurfaceStart = !!asked && !!surface && !sameOpeningCut(surface, asked.surfaceOpening) &&
      !!surfaceQuery && !this.workHandoffQueries.has(surfaceQuery);
    const failedOpening = previous?.failedOpeningPolicy;
    const newTravelStart = !!asked && previous?.mayRecoverOnAffordance && travel && this.isCurrentHandoff(observation) &&
      !sameTravelHint(travel, asked.travelHint) && (!failedOpening || !!matchingTravelHint(observation, failedOpening));
    const candidate = this.intentRecovery;
    const superseded = candidate?.kind === "superseded-opening" && !job && !queue &&
      observation.tick < candidate.expiresTick && performance.now() < candidate.until &&
      this.supersededOpeningCurrent(candidate, observation, evidence) ? candidate : undefined;
    if (candidate?.kind === "superseded-opening" && !superseded) this.intentRecovery = undefined;
    if (previous && observation.tick - previous.tick < WORK_REPLAN_GAP_TICKS && demand !== "renew" &&
        !newTravelStart && !newObstruction && !newSurfaceStart && !newScout && !reacquiredTravelOf && !superseded && !firstLiveReadOf &&
        !visualWake && !newVisualStart) return;
    const pendingCorrection = this.replyCorrection;
    const correction = pendingCorrection?.renewal
      ? demand === "renew" && pendingCorrection.renewal === job && observation.tick > pendingCorrection.observation.tick
        ? pendingCorrection : undefined
      : !job ? pendingCorrection : undefined;
    const unchanged = previous && (key === previous.key || (!job && demand === "changed" && previous.evidence === evidence));
    const recovery = this.intentRecovery;
    const reconsideration = !job && !correction && !queue && !visualWake ? (
      superseded ?? (recovery?.kind === "restored-survey" && recovery.gapSeen && !observation.working &&
        this.isCurrentHandoff(observation) && this.intentRecoveryCurrent(recovery, observation, evidence) &&
        offersAffordance(observation, recovery.offer) ? recovery : this.alternativeRecovery(observation, evidence))
    ) : undefined;
    if (obstructionQuery && this.workHandoffQueries.has(obstructionQuery) && !correction && !superseded && !visualWake) return;
    // An idle abstention can recover on a genuinely new actionable witness or
    // neutral handoff, not when the same affordance is issued a different ID.
    const ordinaryUnchanged = unchanged && !correction && !reconsideration && !reacquiredTravelOf && !firstLiveReadOf && !visualWake &&
      !newVisualStart;
    if (ordinaryUnchanged) {
      if (!newSurfaceStart && !newScout && (job || !previous.mayRecoverOnAffordance || !asked ||
          (!(observation.quiescent && !asked.quiescent) &&
            !(observation.prospectOpening && !sameOpeningCut(observation.prospectOpening, asked.prospectOpening)) &&
            !newObstruction &&
            !newTravelStart &&
            !observation.opportunities.some(offer =>
            !isGroundScout(offer) && workAffordance(offer) && !offersAffordance(asked, offer))))) return;
    }
    const handoffQuery = !job && (observation.quiescent || observation.prospectOpening || surface || observation.travelHint || obstruction ||
      observation.opportunities.some(workAffordance))
      ? digest([evidence, liveCorrectionEvidence({ ...observation, opportunities: observation.opportunities.filter(workAffordance) })]) : null;
    if (ordinaryUnchanged && (!handoffQuery || this.workHandoffQueries.has(handoffQuery))) return;
    if (handoffQuery) this.workHandoffQueries.add(handoffQuery);
    if (obstructionQuery) this.workHandoffQueries.add(obstructionQuery);
    if (surfaceQuery) this.workHandoffQueries.add(surfaceQuery);
    if (scoutQuery) this.workHandoffQueries.add(scoutQuery);
    if (visualStart) this.workHandoffQueries.add(visualStart);
    if (!correction && !visualWake) this.workQuery = { key, tick: observation.tick, evidence };
    this.firstLiveWorkView = undefined;
    if (overlap?.smeltBurnTick !== undefined) overlap.incumbent.smeltLookedAhead = true;
    else if (overlap && owner) this.workOverlapRequests.add(owner);
    const purpose = ticket && this.jobs.get(ticket.id)?.pendingPurpose;
    const pendingPredecessor = this.pendingPredecessor(ticket, observation.life);
    const duringWaitFor = job && this.paidReleaseWindow(job, observation) ? job.order.id :
      job?.order.duringWaitFor && this.parkedOrdinaryWindow(job.order.duringWaitFor, observation) ? job.order.duringWaitFor : undefined;
    const workDemand: MacroWorkDemand = {
      mode: this.workMode!, demand,
      protectedReserves,
      current: job ? { id: job.order.id, origin: job.order.origin, policy: job.policy,
        expiresTick: job.order.expiresTick, accepted: job.accepted ?? null, nativeState } : null,
      ...(demand === "renew" && job ? { renewal: { workOrderId: job.order.id } } : {}),
      ...(duringWaitFor ? { duringWaitFor } : {}),
      ...(pendingPredecessor ? { pendingPredecessor } : {}),
      ...(purpose ? { pendingPurpose: { id: ticket!.id, ...purpose } } : {}),
      lastOutcome: outcome?.terminal ? { id: outcome.order.id, policy: outcome.policy,
        receipt: outcome.terminal, nativeState: outcomeState } : null,
    };
    await this.begin(view, { workDemand, workOverlap: overlap, correction, reconsideration, reacquiredTravelOf, firstLiveReadOf }, visualWake);
  }

  private async scheduleParkedWork(view: View, ticket: NonNullable<MacroObservation["pendingWork"]>): Promise<void> {
    const { observation } = view;
    const now = performance.now();
    let window = this.parkedWorkQueries;
    if (window?.id !== ticket.id || window.life !== observation.life) {
      window = this.parkedWorkQueries = { id: ticket.id, life: observation.life, tick: observation.tick,
        since: now, seen: new Set() };
    }
    const waited = observation.tick - window.tick >= PARKED_VIEW_WAIT_TICKS || now - window.since >= PARKED_VIEW_WAIT_MS;
    // A closing inventory and a frozen capture are not evidence that the cave has no way forward.
    if (!ticket.worksite && (!waited || window.settled)) return;
    if (!this.isCurrentHandoff(observation) || observation.working || observation.safety?.clear !== true) {
      if (waited && !window.reported) {
        window.reported = true;
        await this.record("parked_worksite_blocked", { basis: basis(observation), pendingWorkId: ticket.id,
          reason: "A safe, current handoff did not become available; the paid ticket is still outstanding." });
      }
      return;
    }
    if (!this.config.strategist || this.unavailable) return;
    const outcome = this.lastJobOutcome;
    const terminal = outcome?.terminal && sameGoalAndLife(outcome.source, observation) ? outcome.terminal : undefined;
    const collect = ticket.collectOfferId ? observation.opportunities.find(offer => offer.id === ticket.collectOfferId) : undefined;
    const key = ticket.worksite ? digest([observation.safety.revision, ticket.state === "blocked", ticket.returnClue, collect?.evidence ?? null,
      terminal ? [workPolicyKey(outcome!.policy), terminal.status, terminal.detail] : null,
      Object.entries(observation.inventory).sort(([a], [b]) => a.localeCompare(b)),
      observation.opportunities.filter(meaningfulPrimitive)
        .map(({ verb, risk, summary, material }) => digest([verb, risk, summary, material])).sort()]) : "no-view";
    // ETA and opaque offer IDs do not cause rethinking. An actual change in station evidence can.
    // A selected but unissued recall can also be reconsidered once if it lost and regained its witness.
    const retry = window.recallLost && !!ticket.collectOfferId && !window.seen.has(`${key}:recall-rechecked`);
    const correction = ticket.worksite ? this.replyCorrection : undefined;
    const reconsideration = !correction ? this.alternativeRecovery(observation) : undefined;
    if (!correction && !reconsideration && !retry && window.seen.has(key)) return;
    if (!correction && !reconsideration && !retry && window.settled && window.lastQueryTick !== undefined &&
        (terminal?.tick ?? -1) <= window.lastQueryTick &&
        observation.tick - window.lastQueryTick < WORK_REPLAN_GAP_TICKS) return;
    if (retry) {
      window.recallLost = undefined;
      window.seen.add(`${key}:recall-rechecked`);
    }
    window.seen.add(key);
    window.lastQueryTick = observation.tick;
    if (ticket.worksite) window.settled = true;
    const owner = this.jobs.get(ticket.id);
    const pendingPredecessor = this.pendingPredecessor(ticket, observation.life);
    await this.begin(view, { correction, reconsideration, workDemand: {
      mode: this.workMode!, demand: !ticket.worksite || ticket.state === "blocked" ? "blocked" : terminal ? "outcome" : "changed",
      protectedReserves: this.floorScope?.life === observation.life ? this.floorScope.reserves : [],
      current: null, parkedWorksite: ticket.worksite ? "settled" : "view-unavailable",
      ...(this.parkedOrdinaryWindow(ticket.id, observation) ? { duringWaitFor: ticket.id } : {}),
      ...(pendingPredecessor ? { pendingPredecessor } : {}),
      ...(owner?.pendingPurpose ? { pendingPurpose: { id: ticket.id, ...owner.pendingPurpose } } : {}),
      lastOutcome: outcome && terminal ? { id: outcome.order.id, policy: outcome.policy, receipt: terminal,
        nativeState: outcome.order.id === observation.workOrder?.id ? observation.workOrder : null } : null,
    } });
  }

  private paidReleaseWindow(job: WorkJob, observation: MacroObservation): boolean {
    const ticket = observation.pendingWork;
    const burn = observation.workOrder?.progress?.smeltBurn;
    return this.job === job && !this.previousJob && !this.pending && !this.queuedWork &&
      !!job.accepted && !job.terminal && !job.withdrawn && !job.parked && !job.independentPublished && !observation.working &&
      job.policy.allowedEffects.includes(MACRO_IRON_SMELT) &&
      !!ticket?.yieldable && !ticket.parked && !ticket.historical && ticket.id === job.order.id &&
      ticket.goal === observation.goal &&
      observation.workOrder?.id === job.order.id && observation.workOrder.state === "working" &&
      !!burn && burn.burnTick > job.accepted.tick && ticket.output.count === burn.units && burn.units <= job.policy.maxCrafts &&
      observation.tick < job.order.expiresTick &&
      performance.now() - this.observedAt <= this.limits.maxObservationAgeMs &&
      workScope(job.source, observation, job.health);
  }

  private async tryPreparedSide(current: MacroObservation): Promise<boolean> {
    const job = this.job;
    const side = job?.preparedSide;
    if (!job || !side || !job.requestId || !this.paidReleaseWindow(job, current)) return false;
    job.preparedSide = undefined;
    if (!witnessedSideStart(current, side.policy)) return false;
    return !!await this.publishPendingOrdinary(job.order.id, current, job.requestId, side.policy, current.tick + side.maxTicks, true);
  }

  private publishPendingOrdinary(ticketId: string, witness: MacroObservation, requestId: string,
    policy: MacroWorkPolicy, expiresTick: number, prequoted = false): Promise<WorkJob | null | undefined> {
    const incumbent = this.job;
    return this.publishWork(witness, policy, "model", requestId, expiresTick, [], undefined,
      fresh => this.job === incumbent && !this.queuedWork &&
        (incumbent?.order.id === ticketId ? this.paidReleaseWindow(incumbent, fresh) : this.parkedOrdinaryWindow(ticketId, fresh, incumbent)) &&
        hasStock(fresh, this.floorScope?.life === fresh.life ? this.floorScope.reserves : []) &&
        (!prequoted || witnessedSideStart(fresh, policy)), undefined, prequoted ? undefined : async fresh => {
        const checked = preflightVanillaWork(fresh, [{ policy, requires: [] }]);
        if (checked.kind !== "shortage") return true;
        await this.reportWorkShortage(requestId, checked, fresh);
        return false;
      }, ticketId);
  }

  private pendingDecisionCurrent(context: Decision, current: MacroObservation): boolean {
    const witness = context.observation.pendingWork;
    if (witness && (current.pendingWork?.id !== witness.id || current.pendingWork.parked !== witness.parked)) return false;
    if (context.workDemand?.parkedWorksite === "view-unavailable" && current.pendingWork?.worksite) return false;
    const currentJob = context.workDemand?.current;
    if (witness?.parked && currentJob && this.job?.order.id !== currentJob.id) return false;
    const overlap = context.workOverlap;
    if (overlap?.smeltBurnTick === undefined) return true;
    const { incumbent } = overlap;
    const nativeState = current.workOrder;
    return this.job === incumbent && !incumbent.withdrawn && !incumbent.terminal && this.queuedWork === overlap.queue &&
      nativeState?.id === incumbent.order.id && nativeState.state === "working" &&
      nativeState.progress?.smeltBurn?.burnTick === overlap.smeltBurnTick;
  }

  private async preemptQueuedWork(requestId: string): Promise<void> {
    const queued = this.queuedWork;
    if (queued) await this.discardQueuedWork(queued, "live_work_preempted", { preemptedBy: requestId });
  }

  private async discardQueuedWork(queued: QueuedWork, reason: string, extra?: Record<string, unknown>): Promise<void> {
    const { plan, after, next, stages, bootstrap } = queued;
    if (this.pendingSuccessor === queued) this.pendingSuccessor = undefined;
    if (this.queuedWork === queued) this.queuedWork = undefined;
    const stage = bootstrap?.stageOffset ? bootstrap.stageOffset + Math.min(next + 1, stages.length) : next + 1;
    await this.record("work_successor_discarded", { requestId: plan.requestId, afterWorkId: after?.order.id ?? null,
      stage, reason, ...(bootstrap ? { programSource: PRE_SPAWN_GOAL_ONLY } : {}), ...extra });
  }

  private async advancePendingSuccessor(current: MacroObservation | undefined, runtimeExpired: boolean): Promise<void> {
    const queued = this.pendingSuccessor!;
    const after = queued.after!;
    const terminal = after.terminal;
    if (runtimeExpired || this.closing || !current || !workScope(queued.plan.observation, current) ||
        current.tick >= queued.plan.proposal.expiresTick || after.withdrawn)
      return this.discardQueuedWork(queued, "scope_or_ttl_changed");
    if (!terminal) {
      if (current.workOrder?.id === after.order.id && current.workOrder.state === "blocked")
        return this.discardQueuedWork(queued, "predecessor_blocked");
      return;
    }
    if (terminal.status !== "completed") return this.discardQueuedWork(queued, "predecessor_did_not_complete");
    if (after.parked) {
      const collector = after.collector;
      if (!collector || (!collector.terminal && !collector.withdrawn)) return;
      if (!collector.accepted || collector.withdrawn || collector.terminal?.status !== "completed")
        return this.discardQueuedWork(queued, "pending_collection_did_not_complete");
    }
    if (current.tick < terminal.tick || current.pendingWork?.id === after.order.id || this.job || this.pending ||
        this.queuedWork || this.direct || this.segment || this.lease || this.busy || this.ready) return;
    this.pendingSuccessor = undefined;
    this.queuedWork = queued;
  }

  private async advanceQueuedWork(current: MacroObservation | undefined, runtimeExpired: boolean): Promise<void> {
    const queued = this.queuedWork!;
    const { after, plan, stages, next, bootstrap } = queued;
    const terminal = after?.terminal;
    let reason: string;
    if (runtimeExpired || this.closing || !current || !workScope(plan.observation, current, bootstrap ? after?.health : undefined) ||
        current.tick >= plan.proposal.expiresTick || after?.withdrawn) reason = "scope_or_ttl_changed";
    else if (!after) {
      if (queued.travelWait?.tick === current.tick && performance.now() < queued.travelWait.until) return;
      await this.startWorkStage(queued);
      return;
    } else if (queued.smeltSuccessor && next === 0 && !terminal && current.workOrder?.id === after.order.id &&
        current.workOrder.state === "blocked") reason = "predecessor_blocked";
    else if (!terminal || current.tick < terminal.tick) return;
    else if (terminal.status !== "completed" || !after.accepted || this.job) reason = "predecessor_did_not_complete";
    else if (!confirmsWorkStock(current, after.policy)) reason = "predecessor_stock_not_confirmed";
    else if (bootstrap && !openingHandoff(after, current)) reason = "opening_handoff_not_confirmed";
    else {
      if (after.order.duringWaitFor && current.pendingWork?.id === after.order.duringWaitFor && !current.pendingWork.worksite) return;
      if (next === stages.length) {
        this.queuedWork = undefined;
        const stageOffset = bootstrap?.stageOffset ?? 0;
        if (bootstrap && next + stageOffset !== bootstrap.declaredStages) return;
        this.completedWorkPrograms++;
        const target = after.policy.target;
        const checked = target.kind === "stock" ? [...after.policy.reserves, target] : after.policy.reserves;
        const completed: WorkProgramCompletion = {
          requestId: plan.requestId, stages: next, goal: current.goal, finalOrder: after.order,
          invocationItemCount: SURVIVAL_AGENT_GOALS.some(goal => goal !== "nether_portal" && goal === current.goal)
            ? stock(current, `minecraft:${current.goal}`) : null,
          accepted: after.accepted, receipt: terminal, basis: basis(current),
          stock: checked.map(({ item, count }) => ({ item, required: count, observed: stock(current, item) })),
          ...(bootstrap ? { stage: PRE_SPAWN_GOAL_ONLY, branchIndex: bootstrap.branchIndex } : {}),
          ...(bootstrap && stageOffset ? { declaredStages: bootstrap.declaredStages,
            executedStages: stages.map((_, index) => index + stageOffset + 1) } : {}),
        };
        this.completedWorkProgram = completed;
        await this.record("work_program_completed", { ...completed });
      } else await this.startWorkStage(queued);
      return;
    }
    if (queued.travelWait && !this.closing) await this.rejectStale(plan, "physical_work_scope_or_ttl_changed");
    await this.discardQueuedWork(queued, reason);
  }

  private async startWorkStage(queued: QueuedWork): Promise<void> {
    const { plan, stages, next: index, after, bootstrap } = queued;
    const { policy, requires } = stages[index]!;
    const food = foodWorkWitness(plan.observation, policy);
    const stageOffset = bootstrap?.stageOffset ?? 0;
    const duringWaitFor = after?.order.duringWaitFor;
    const stage = stages.length > 1 && !duringWaitFor ? workStageIds(plan.requestId, stages, index, stageOffset) : undefined;
    const afterSmelt = queued.smeltSuccessor && index === 0 ? after : null;
    const clue = !after ? plan.observation.travelHint : undefined;
    const approach = clue && travelHintMatchesPolicy(clue, policy) ? clue : undefined;
    const mayCorrectSurface = index === 0 && !after && !bootstrap && !plan.postLook &&
      !plan.observation.pendingWork && !this.config.preparedStockReady;
    const unpricedSurfaceReason = "Surface entry needs a witnessed exact opening and a fully priced ordinary stock job, either alone or as the first stage.";
    let surface: SurfaceWitness | undefined;
    let unpricedSurface: SurfaceWitness | undefined;
    if (!after && approach?.kind !== "resource" && this.workMode === "constrained" && !this.job &&
        hasSurfaceCoverEffect(policy) && !offeredOpeningStart(plan.observation, policy)) {
      const witness = openingWorkWitness(plan.observation, policy, {});
      if (witness && "surfaceOpening" in witness && (!stage || (index === 0 && stageOffset === 0))) {
        surface = witness;
      } else if (!approach && (!witness || "surfaceOpening" in witness)) {
        const opening = plan.observation.surfaceOpening;
        if (mayCorrectSurface && opening) {
          unpricedSurface = { surfaceOpening: opening };
        } else {
          this.queuedWork = undefined;
          await this.disposition("proposal_refused", { requestId: plan.requestId, reason: unpricedSurfaceReason });
          return;
        }
      }
    }
    const surfaceEntry = surface ?? unpricedSurface;
    const travel = surface ? undefined : approach;
    const wall = !after && !travel && !surfaceEntry ? pricedProspectOpening(plan.observation, policy) : undefined;
    const timberClue = !after && !travel && !wall && !surfaceEntry ? plan.observation.timberObstruction : undefined;
    const timber = timberClue ? pricedTimberObstruction(plan.observation, policy) : undefined;
    if (timberClue && !timber && policy.target.kind === "stock" && policy.target.item === timberClue.timber) {
      this.queuedWork = undefined;
      await this.disposition("proposal_refused", { requestId: plan.requestId,
        reason: "The witnessed timber obstruction requires its exact leaf break plus enough breaks for the remaining timber stock." });
      return;
    }
    const wait = queued.travelWait;
    let failedStart: { observation: MacroObservation; reason: string } | undefined;
    const withoutStart = (observation: MacroObservation, reason: string) => {
      failedStart = { observation, reason };
      return false;
    };
    let travelRefusal: { observation: MacroObservation; reason: string } | undefined;
    let surfaceRefusal: { observation: MacroObservation; reason: string } | undefined;
    const refuseSurface = (observation: MacroObservation, reason: string) => {
      surfaceRefusal = { observation, reason };
      return false;
    };
    const physical = travel ?? wall ?? timber ?? surfaceEntry;
    const currentStart = food ? (fresh: MacroObservation) => {
      const current = foodWorkWitness(fresh, policy);
      return (this.isCurrentHandoff(fresh) && sameOpeningStance(plan.observation, fresh) &&
        current?.material?.target === food.material!.target) ||
        withoutStart(fresh, "food_source_no_longer_witnessed");
    } : physical ? (fresh: MacroObservation) => {
      if (!this.isCurrentHandoff(fresh) || !sameOpeningStance(plan.observation, fresh) ||
          fresh.tick >= plan.proposal.expiresTick) return withoutStart(fresh, "physical_work_scope_or_ttl_changed");
      if ("surfaceOpening" in physical) {
        if (!sameOpeningCut(physical.surfaceOpening, unpricedSurface ? fresh.surfaceOpening : pricedSurfaceOpening(fresh, policy)))
          return withoutStart(fresh, "surface_opening_no_longer_witnessed_or_priced");
        if (unpricedSurface) return refuseSurface(fresh, unpricedSurfaceReason);
        if (mayCorrectSurface) {
          const missing = requires.find(({ item, count }) => stock(fresh, item) < count);
          if (missing) {
            const { item, count } = missing;
            if (stock(plan.observation, item) >= count) return withoutStart(fresh, "surface_entry_stock_changed_before_work_admission");
            return refuseSurface(fresh, `The first surface stage requires ${count} ${item} at entry, but only ${stock(fresh, item)} are carried.`);
          }
        }
        return true;
      }
      if (!("footing" in physical)) return "timber" in physical
        ? sameTimberObstruction(physical, pricedTimberObstruction(fresh, policy)) ||
          withoutStart(fresh, "timber_obstruction_no_longer_witnessed_or_priced")
        : sameOpeningCut(physical, pricedProspectOpening(fresh, policy)) ||
          withoutStart(fresh, "prospect_opening_no_longer_witnessed_or_priced");
      if (wait) {
        if (fresh.tick - wait.tick > FIRST_ACTIONABLE_VIEW_TICKS || performance.now() >= wait.until)
          return withoutStart(fresh, "travel_hint_did_not_return_in_time");
        if (!this.openingHandoff(plan.observation, fresh, policy, queued) || !hasStock(fresh, requires))
          return withoutStart(fresh, "deferred_travel_grant_no_longer_current");
      }
      const current = fresh.travelHint;
      if (!current) return withoutStart(fresh, "travel_hint_missing");
      if (!sameTravelHint(physical, current) || (wait && physical.footing !== current.footing))
        return withoutStart(fresh, "travel_hint_changed");
      if (wait) return true; // The deferred handoff gate already rechecked the live floors.
      const missing = policy.reserves.find(({ item, count }) => stock(fresh, item) < count);
      if (!missing) return true;
      const { item, count } = missing;
      travelRefusal = { observation: fresh,
        reason: `The witnessed approach requires ${count} ${item} reserved at entry, but only ${stock(fresh, item)} are carried.` };
      return false;
    } : undefined;
    let rejection = "fresh_work_admission_rejected";
    const job = await this.publishWork(plan.observation, policy, "model", plan.requestId, plan.proposal.expiresTick,
      requires, after?.policy, afterSmelt ? fresh => !this.job && fresh.tick >= afterSmelt.terminal!.tick &&
        workScope(afterSmelt.source, fresh, afterSmelt.health) && !fresh.pendingWork &&
        performance.now() - this.observedAt <= this.limits.maxObservationAgeMs :
        duringWaitFor ? fresh => this.parkedOrdinaryWindow(duringWaitFor, fresh) :
        bootstrap && after ? fresh => {
        if (this.job || !openingHandoff(after, fresh) || !workScope(after.source, fresh, after.health) ||
            performance.now() - this.observedAt > this.limits.maxObservationAgeMs) {
          rejection = "opening_handoff_not_confirmed";
          return false;
        }
        if (!hasStock(fresh, requires)) {
          rejection = "stock_prerequisite_missing";
          return false;
        }
        // A newly declared floor can be earned only from the stage's own target,
        // and never by a stage authorized to spend that unfulfilled floor.
        const { target, reserves, costCaps } = policy;
        if (reserves.some(({ item, count }) => stock(fresh, item) < count &&
            (target.kind !== "stock" || target.item !== item || target.count < count || costCaps.some(cap => cap.item === item)))) {
          rejection = "protected_stock_missing";
          return false;
        }
        return true;
      } : currentStart, stage, async fresh => {
        if (index === 0 && plan.correction && !this.sameReplyContext(plan.correction, fresh)) {
          await this.rejectStale(plan, "correction_context_changed_before_work_admission");
          return false;
        }
        if (plan.postLook && (!sameOpeningStance(plan.observation, fresh) || !postLookWorkStart(fresh, policy)))
          return false;
        if (food) return true; // The exact live recheck admits one source, not a projected yield.
        const checked = preflightVanillaWork(fresh, [stages[index]!]);
        if (afterSmelt && checked.kind !== "possible") {
          rejection = "smelt_successor_live_path_not_confirmed";
          if (checked.detail !== undefined) await this.reportWorkShortage(plan.requestId, checked, fresh);
          return false;
        }
        if (checked.kind === "shortage") {
          if (bootstrap) rejection = "work_resource_shortage";
          await this.reportWorkShortage(plan.requestId, checked, fresh);
          if (surface && mayCorrectSurface) return refuseSurface(fresh, checked.detail);
          return false;
        }
        if (bootstrap && !offeredOpeningStart(fresh, policy) &&
            !(checked.kind === "possible" && policy.target.kind === "stock" && policy.maxCrafts > 0 &&
              policy.allowedEffects.includes(`craft:${policy.target.item.slice("minecraft:".length)}`))) {
          rejection = "opening_start_not_confirmed";
          if ("detail" in checked && checked.detail !== undefined)
            await this.reportWorkShortage(plan.requestId, checked, fresh);
          return false;
        }
        return true;
      }, duringWaitFor, undefined, currentStart || plan.postLook ? (before, latest) => {
        if (latest.tick - before.tick >= WORK_ADMISSION_TICKS)
          return withoutStart(latest, "physical_work_admission_basis_aged");
        if (surface && plan.correction && !this.sameReplyContext(plan.correction, latest))
          return withoutStart(latest, "correction_context_changed_before_work_admission");
        return (!plan.postLook || sameOpeningStance(plan.observation, latest) && postLookWorkStart(latest, policy)) &&
          (currentStart?.(latest) ?? true);
      } : undefined,
      travel ? () => ({ travelAnchor: { subject: travel.subject, target: travel.target } }) :
        timber ? () => ({ travelAnchor: timber.toward }) :
        surface ? () => ({ surfaceAnchor: surfaceAnchor(surface.surfaceOpening) }) : undefined);
    if (job === null) return; // A rotating observation is not a denied program stage.
    if (!job && (bootstrap || afterSmelt || duringWaitFor)) return this.discardQueuedWork(queued, rejection);
    if (!job && failedStart) {
      const { observation, reason } = failedStart;
      if (reason === "travel_hint_missing" && travel &&
          this.openingHandoff(plan.observation, observation, policy, queued) && hasStock(observation, requires) &&
          (!plan.correction || this.sameReplyContext(plan.correction, observation))) {
        // Hold the same grant, not a promise that the last visible route still works.
        if (!wait) {
          this.queuedWork = { ...queued, travelWait: { tick: observation.tick, until: performance.now() + FIRST_ACTIONABLE_VIEW_MS } };
          await this.disposition("work_start_deferred", { requestId: plan.requestId, basis: basis(observation), reason,
            travelAnchor: { subject: travel.subject, target: travel.target } });
        }
        return;
      }
      this.queuedWork = undefined;
      await this.rejectStale(plan, reason);
      return;
    }
    this.queuedWork = undefined;
    if (!job && surfaceRefusal) {
      const { observation, reason } = surfaceRefusal;
      await this.disposition("proposal_refused", { requestId: plan.requestId, basis: basis(observation), reason }, null);
      if (!this.pendingSuccessor) this.offerReplyCorrection(plan, observation, { kind: "invalid_reply",
        detail: `${reason} No work was issued. Price the exact cover break in addition to the remaining stock, ` +
          "price any witnessed tool loss without lowering work.protectedReserves, and require only stock carried at entry. " +
          "Choose a currently witnessed alternative or abstain if the start cannot be met." });
    }
    if (!job && travelRefusal) {
      const { observation, reason } = travelRefusal;
      // This is not a lost opportunity ID. Keep the concrete reason on this decision and its bounded correction only.
      await this.disposition("proposal_refused", { requestId: plan.requestId, basis: basis(observation), reason }, null);
      this.offerReplyCorrection(plan, observation, { kind: "invalid_reply",
        detail: `${reason} No work was issued. Set the stock target to the desired total after gathering. ` +
          "An approach can reserve only carried stock at entry, and it must preserve work.protectedReserves. " +
          "If you cannot meet those protections, choose a witnessed alternative or abstain." });
    }
    if (job) {
      if (queued.preparedSide) job.preparedSide = queued.preparedSide;
      if (queued.pendingPurpose) job.pendingPurpose = queued.pendingPurpose;
    }
    if (job && (stages.length > 1 || (job.order.origin === "model" && policy.target.kind === "preset"))) {
      if (bootstrap) job.bootstrap = index + stageOffset + 1;
      this.queuedWork = { ...queued, after: job, next: index + 1, travelWait: undefined };
      await this.record("work_program_stage", { requestId: plan.requestId, id: job.order.id, stage: index + stageOffset + 1,
        stages: bootstrap?.declaredStages ?? stages.length, ...(bootstrap ? { programSource: PRE_SPAWN_GOAL_ONLY } : {}) });
    }
  }

  private async publishWork(
    witness: MacroObservation, policy: MacroWorkPolicy, origin: MacroWorkOrder["origin"], requestId: string | null,
    expiresTick: number, requires: readonly MacroStockFloor[] = [], predecessor?: MacroWorkPolicy,
    admitFresh?: (observation: MacroObservation) => boolean,
    stage?: WorkStageIds,
    preflight?: (observation: MacroObservation) => boolean | Promise<boolean>,
    duringWaitFor?: string,
    renewal?: WorkJob,
    recheck?: (basis: MacroObservation, latest: MacroObservation) => boolean,
    bindStart?: (basis: MacroObservation) => WorkStart | undefined,
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
    if (previous && isFoodWork(previous.policy)) {
      if (requestId) await this.disposition("proposal_refused", { requestId, reason: "Wait for the one-source food work to settle." });
      return;
    }
    if ((previous?.policy.allowedEffects.includes(MACRO_IRON_SMELT) && duringWaitFor !== previous.order.id) ||
        previous?.policy.allowedEffects.includes(MACRO_WATER_FILL)) {
      if (requestId) await this.disposition("proposal_refused", { requestId, reason: previous.policy.allowedEffects.includes(MACRO_WATER_FILL)
        ? "Wait for the finite bucket work order to settle." : "Wait for the finite iron work order to settle." });
      return;
    }
    const liveTicket = fresh.pendingWork;
    if (liveTicket?.parked && !liveTicket.historical && this.jobs.get(liveTicket.id)?.parked && liveTicket.id !== duringWaitFor) {
      if (requestId) await this.disposition("proposal_refused", { requestId, reason: "A parked ticket needs the same explicit independent work authorization." });
      return;
    }
    if (policy.allowedEffects.includes(MACRO_IRON_SMELT) && fresh.pendingWork) {
      if (requestId) await this.disposition("proposal_refused", { requestId, reason: "One pending production obligation is already outstanding." });
      return;
    }
    const equivalent = !!previous && previous.order.duringWaitFor === duringWaitFor &&
      (previous.policy === policy || workPolicyKey(previous.policy) === workPolicyKey(policy));
    const { target, reserves } = policy;
    const inherited = this.floorScope?.life === fresh.life ? this.floorScope.reserves : [];
    const reduced = inherited.some(({ item, count }) => (reserves.find(floor => floor.item === item)?.count ?? 0) < count);
    if (reduced || !hasStock(fresh, requires) || (predecessor && !confirmsWorkStock(fresh, predecessor)) ||
        (target.kind === "preset" && target.goal !== fresh.goal) ||
        (target.kind === "stock" && confirmsWorkStock(fresh, policy))) {
      if (requestId) await this.disposition("proposal_refused", { requestId, reason: "Live stock or target does not support the proposed work policy." });
      return;
    }
    if (equivalent && !renewal) {
      await this.record("work_order_retained", { requestId, id: previous.order.id, expiresTick: previous.order.expiresTick });
      return previous;
    }
    if (preflight && !await preflight(fresh)) return;
    const { travelAnchor, harvestAnchor, surfaceAnchor } = renewal?.order ?? bindStart?.(fresh) ?? {};
    const order = parseMacroWorkOrder({
      v: 1, id: stage?.id ?? randomUUID(), run: fresh.run, life: fresh.life, epoch: fresh.epoch, basisTick: fresh.tick,
      expiresTick: Math.min(expiresTick, fresh.tick + this.limits.maxIntentTtlTicks),
      safetyRevision: fresh.safety!.revision, origin: equivalent ? previous.order.origin : origin, ...policy,
      ...(!equivalent && stage?.nextWorkId ? { nextWorkId: stage.nextWorkId } : {}),
      ...(duringWaitFor ? { duringWaitFor } : {}),
      ...(travelAnchor ? { travelAnchor } : {}), ...(harvestAnchor ? { harvestAnchor } : {}),
      ...(surfaceAnchor ? { surfaceAnchor } : {}),
    });
    await this.record("work_order_prepared", { requestId, order, previousId: previous?.order.id ?? null, equivalent });
    if (recheck) {
      const latest = await this.refresh();
      if (!latest) return null;
      if (!recheck(fresh, latest)) return;
    }
    if (this.closing || this.config.signal?.aborted) return;
    await this.ipc!.write("work.json", order, previous ? "work-only" : undefined);
    if (duringWaitFor === previous?.order.id && previous) previous.independentPublished = true;
    if (previous?.accepted) this.previousJob = previous;
    this.job = this.newestJob = { order, policy, requestId, source: renewal?.source ?? fresh, health: fresh.health,
      ...(renewal ? { renews: renewal } : {}) };
    this.jobs.set(order.id, this.job);
    await this.disposition(previous ? equivalent ? "work_order_renewal_proposed" : "work_order_replacement_proposed" : "work_order_issued",
      { requestId, id: order.id, previousId: previous?.order.id ?? null, origin: order.origin });
    return this.job;
  }

  private async restorePreviousWork(candidate: WorkJob, current: MacroObservation, reason: string): Promise<boolean> {
    const previous = this.previousJob;
    const native = current.workOrder;
    if (this.closing || !previous || this.job !== candidate || candidate.accepted || previous.parked ||
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
    if (observation.pendingWork?.collectOfferId &&
        (before?.pendingWork?.id !== observation.pendingWork.id || !before.pendingWork.collectOfferId))
      this.returnWitnessRevision++;
    if (observation.pendingWork?.protectedReserves)
      this.retainFloors(observation.life, observation.pendingWork.protectedReserves);
    const evidence = evidenceKey(observation);
    this.observedAt = performance.now();
    this.view = {
      observation, evidence, query: this.queryKey(observation, evidence),
      changedAt: this.view?.evidence === evidence ? this.view.changedAt : this.observedAt,
    };
    return observation;
  }

  private retainFloors(life: number, additional: readonly MacroStockFloor[]): void {
    const reserves = this.floorScope?.life === life ? this.floorScope.reserves : [];
    if (additional.every(floor => reserves.some(prior => prior.item === floor.item && prior.count >= floor.count))) return;
    const byItem = new Map(reserves.map(({ item, count }) => [item, count]));
    for (const { item, count } of additional) byItem.set(item, Math.max(count, byItem.get(item) ?? 0));
    this.floorScope = { life, reserves: Array.from(byItem, ([item, count]) => ({ item, count })) };
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
    const feedback = this.feedback;
    if (feedback && (feedback.value.kind === "work_resource_shortage"
      ? sameGoalAndLife(feedback.observation, observation) : scope(feedback.observation, observation))) return feedback.value;
  }

  private liveReplyKey(observation: MacroObservation): string {
    const { run, life, epoch, goal, stance, safety, food } = observation;
    return digest([run, life, epoch, goal, stance, safety, guardBand(food), liveCorrectionEvidence(observation),
      this.lastReceipt?.life === life ? this.lastReceipt.id : null, this.lastJobOutcome?.terminal?.id,
      this.config.skills?.selection().generation, this.floorScope?.reserves]);
  }

  private replyCorrectionApplies(correction: ReplyCorrection, current: MacroObservation): boolean {
    if (correction.renewal) return this.sameReplyContext(correction, current);
    return !this.job && !this.previousJob && !this.queuedWork && !this.pending && !this.direct && !this.segment &&
      !this.conditional && !this.lease && this.sameReplyContext(correction, current);
  }

  private offerReplyCorrection(context: Pick<Decision, "requestId" | "observation" | "replyKey" | "correction">,
    current: MacroObservation, feedback: MacroFeedback): void {
    const key = context.replyKey;
    if (this.closing || context.correction || !key || this.correctedContexts.has(key)) return;
    const correction = { requestId: context.requestId, observation: context.observation, key, feedback };
    if (this.replyCorrectionApplies(correction, current)) this.replyCorrection = correction;
  }

  private sameReplyContext(correction: ReplyCorrection, current: MacroObservation): boolean {
    if (correction.renewal) return this.canRenewWork(correction.renewal, current) &&
      workScope(correction.observation, current);
    return sameLiveCorrectionScope(correction.observation, current) && this.liveReplyKey(current) === correction.key;
  }

  private async readReceipts(closing = false): Promise<void> {
    const ipc = this.ipc!;
    const maxBytes = Math.min(Number.MAX_SAFE_INTEGER, (2 * this.issued.size + 3 * this.jobs.size + 2) * 4_097);
    let batch = await ipc.readNativeReceiptLines(this.journal, maxBytes);
    const fallback = batch ? null : await ipc.read("receipt.json", value => {
      // A park has to be journaled alongside acceptance and terminal settlement.
      return (value as { status?: unknown } | null)?.status === "parked" ? null : parseMacroReceipt(value);
    });
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

  private async receive(receipt: MacroReceipt | MacroParkedReceipt): Promise<void> {
    const job = this.jobs.get(receipt.id);
    if (receipt.status === "parked") {
      if (!job || !job.policy.allowedEffects.includes(MACRO_IRON_SMELT) || !job.accepted ||
          receipt.run !== job.order.run || receipt.life !== job.order.life || receipt.tick < job.accepted.tick ||
          receipt.tick > job.order.expiresTick ||
          (job.parked ? digest(job.parked) !== digest(receipt) : !!job.terminal))
        throw new Error("Native park receipt does not match its admitted production job.");
      if (job.parked) return;
      job.parked = receipt;
      const eligible = !job.withdrawn && (this.view?.observation.life ?? receipt.life) === receipt.life;
      await this.append(this.receipts, { requestId: job.requestId, order: job.order, receipt, eligible });
      if (this.job === job) {
        await this.ipc!.remove("work.json");
        this.job = undefined;
        this.handoffAfterTick = Math.max(this.handoffAfterTick, receipt.tick - 1);
      }
      if (this.previousJob === job) this.previousJob = undefined;
      return;
    }
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
    if (record.terminal || (record.accepted && receipt.tick < record.accepted.tick) ||
        (record.intent.recon && receipt.status === "completed" && !record.accepted)) {
      throw new Error("Native survival macro receipt order is invalid.");
    }
    const staleLife = (this.view?.observation.life ?? receipt.life) > receipt.life;
    const current = this.view?.observation;
    const reconScopeLost = !!record.intent.recon && !!current &&
      (!scope(record.scope, current) || !workScope(record.scope, current) || !hasStock(current, record.reserves ?? []));
    const eligible = !record.withdrawn && !staleLife && !reconScopeLost;
    await this.append(this.receipts, { requestId: record.requestId, intent: record.intent, receipt, eligible,
      ...(record.withdrawn ? { afterWithdrawal: true } : {}), ...(staleLife ? { priorLife: true } : {}),
      ...(reconScopeLost ? { reconScopeLost: true } : {}) });
    if (receipt.status === "accepted") {
      record.accepted = receipt;
      return;
    }
    record.terminal = receipt;
    if (eligible && record.accepted && receipt.status === "completed" && record.offer.verb === MACRO_COLLECT_PENDING &&
        record.scope.pendingWork) this.collectedTickets.add(`${receipt.life}:${record.scope.pendingWork.id}`);
    if (eligible) this.episodeMemory.terminal(record.requestId, record.offer, receipt);
    this.terminalReceipts++;
    if (receipt.status === "completed" && !record.openingWorkView && record.offer.verb !== MACRO_DEFER_PENDING) {
      if (eligible) this.completedReceipts++;
      else this.lateCompletedReceipts++;
    }
    if (eligible && (!this.lastReceipt || this.lastReceipt.tick <= receipt.tick)) this.lastReceipt = receipt;
    // A constrained camera-only check can wake planning on a new affordance,
    // not on a receipt. A scout likewise needs its fresh displaced stance.
    const standaloneSurvey = !record.openingWorkView && this.workMode === "constrained" &&
      record.offer.verb === "survey" && record.offer.risk === "read" && !record.offer.anchor;
    if (standaloneSurvey && eligible && receipt.status === "completed" && record.accepted && this.workQuery) {
      this.workQuery.mayRecoverOnAffordance = true;
      await this.record("survey_awaiting_witness", { requestId: record.requestId, intentId: record.intent.id,
        reason: "The fixed camera view completed. Only a fresh physical affordance or a checked new native image can wake planning." });
      this.armPostLook(record);
    }
    const scout = isGroundScout(record.offer);
    const recon = !!record.intent.recon;
    if (recon && eligible && record.accepted && this.workQuery) this.workQuery.mayRecoverOnAffordance = true;
    if (eligible && !record.openingWorkView && !standaloneSurvey && !scout && !recon &&
        (!this.lastWorkQueryReceipt || this.lastWorkQueryReceipt.tick <= receipt.tick))
      this.lastWorkQueryReceipt = receipt;
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
    this.handoffAfterTick = Math.max(this.handoffAfterTick, standaloneSurvey || scout || recon ? receipt.tick : receipt.tick - 1);
    if (this.view) this.view = { ...this.view, query: this.queryKey(this.view.observation, this.view.evidence) };
  }

  private async receiveWork(job: WorkJob, receipt: MacroReceipt): Promise<void> {
    const { order } = job;
    const prior = receipt.status === "accepted" ? job.accepted : job.terminal;
    if (receipt.run !== order.run || receipt.life !== order.life || receipt.tick < order.basisTick ||
        ((receipt.status === "accepted" || (receipt.status === "completed" && !job.parked)) && receipt.tick > order.expiresTick) ||
        (job.parked && receipt.tick < job.parked.tick) ||
        (prior ? digest(prior) !== digest(receipt) : job.terminal ||
          (job.accepted && receipt.tick < job.accepted.tick) || (receipt.status === "completed" && !job.accepted))) {
      throw new Error("Native work receipt does not match its admitted job.");
    }
    if (prior) return;
    const priorLife = (this.view?.observation.life ?? receipt.life) > receipt.life;
    const incumbent = job.renews;
    const invalidRenewal = receipt.status === "accepted" && incumbent && (
      receipt.tick >= incumbent.order.expiresTick || receipt.tick - order.basisTick >= WORK_ADMISSION_TICKS ||
      incumbent.terminal?.status !== "interrupted" ||
      incumbent.terminal.tick !== receipt.tick || incumbent.terminal.detail !== COMPATIBLE_WORK_RECEIPT);
    const eligible = !job.withdrawn && !priorLife && !invalidRenewal;
    await this.append(this.receipts, { requestId: job.requestId, order, receipt, eligible,
      ...(job.bootstrap ? { stage: PRE_SPAWN_GOAL_ONLY, programStage: job.bootstrap } : {}),
      ...(invalidRenewal ? { invalidRenewal: true } : {}),
      ...(job.withdrawn ? { afterWithdrawal: true } : {}), ...(priorLife ? { priorLife: true } : {}) });
    if (receipt.status === "accepted") {
      if (order.duringWaitFor && !this.jobs.get(order.duringWaitFor)?.parked)
        throw new Error("Native independent work was accepted without parking its production predecessor.");
      job.accepted = receipt;
      if (eligible) {
        this.lastAcceptedJob = job;
        this.completedWorkProgram = null;
        this.retainFloors(job.order.life, job.policy.reserves);
      }
      if (invalidRenewal && this.job === job) {
        await this.withdrawWork("native_renewal_not_compatible", job.requestId ?? undefined);
        return;
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
    await this.begin(view, { lookahead: { origin, evidence, workingBasis: observation, health: observation.health,
      lastWorkingTick: observation.tick, lastWorkingSeenAt: this.observedAt } });
  }

  private async begin(
    view: View, { lookahead, workDemand, workOverlap, correction, reconsideration, reacquiredTravelOf, firstLiveReadOf }:
      Pick<Decision, "lookahead" | "workDemand" | "workOverlap" | "correction" | "reconsideration" | "reacquiredTravelOf" | "firstLiveReadOf">,
    visualWake?: VisualFinding,
    postLook?: PostLook,
  ): Promise<void> {
    const trigger = this.trigger(view);
    const observation = view.observation;
    let disclosed = observation;
    if (workDemand && !lookahead && !postLook) {
      const lostOpening = reconsideration?.kind === "superseded-opening" ||
        (reconsideration?.kind === "alternative" && reconsideration.opening) ? reconsideration.offer : undefined;
      const canScout = !workDemand.current && !observation.pendingWork && this.isCurrentHandoff(observation) &&
        hasStock(observation, workDemand.protectedReserves);
      const opportunities = observation.opportunities.filter(offer =>
        (!lostOpening || !sameAffordance(lostOpening, offer)) &&
        (isGroundScout(offer) ? canScout && !this.effectKeys.has(primitiveEffectKey(observation, offer)) :
          !isOpeningView(offer) || !this.effectKeys.has(primitiveEffectKey(observation, offer))));
      if (opportunities.length !== observation.opportunities.length) disclosed = { ...observation, opportunities };
      if (workDemand.current === null && !workDemand.parkedWorksite && !observation.pendingWork && !observation.working &&
          observation.stance !== undefined && observation.safety?.clear === true &&
          !this.queuedWork && !this.pendingSuccessor && this.isCurrentHandoff(observation)) {
        const openingViewIds = opportunities.filter(isOpeningView).map(({ id }) => id);
        if (openingViewIds.length) workDemand = { ...workDemand, openingViewIds };
      }
    }
    const observedAt = this.observedAt;
    const requestId = randomUUID();
    const skills = lookahead || workDemand?.current || postLook ? undefined : this.config.skills;
    const selection = skills?.selection();
    const skillVerbs = this.config.trial && this.skillCandidates < this.limits.maxSkillCandidates &&
      this.testedCandidates.size === 0 ? skills?.allowedVerbs() : undefined;
    const selectedSkillHash = selection?.hash && this.testedSkillVerbs.has(selection.hash) &&
      skills?.status(selection.hash) === "active" ? selection.hash : undefined;
    const testedSkills = this.availableCandidates(selection?.generation);
    const generation = selection && (selectedSkillHash || skillVerbs?.length || testedSkills.length) ? selection.generation : null;
    const visual: MacroRequest["visual"] = postLook ? { mayNominate: true, postLook: true } :
      !lookahead && !workDemand?.current && !workDemand?.parkedWorksite && !reconsideration ?
      this.visualContext(observation) : undefined;
    const resultingRead = visual?.read && (visualWake ?? this.currentVisualFinding(observation));
    // Candidate IDs outside this request's independently confirmed read are not planner or skill affordances.
    const opportunities = disclosed.opportunities.filter(offer => (offer.verb !== MACRO_RECON || offer.id === visual?.reconOpportunityId) &&
      (!postLook || !isOpeningView(offer)));
    if (opportunities.length !== disclosed.opportunities.length) disclosed = { ...disclosed, opportunities };
    const request: MacroRequest = {
      observation: disclosed, objective: this.objective, trigger, capabilitiesVersion: this.capabilitiesVersion,
      skillGeneration: generation, skillVerbs, selectedSkillHash, testedSkills,
      maxSkillEffects: this.limits.maxSkillEffects,
      maxResponseBytes: this.limits.maxResponseBytes, maxIntentTtlTicks: this.limits.maxIntentTtlTicks,
      maxPlanTtlTicks: this.limits.maxPlanTtlTicks,
      lastReceipt: this.lastReceipt?.life === observation.life ? this.lastReceipt : null,
      feedback: postLook ? { kind: "post_look_visual", detail: "The camera read completed, but no physical work was issued. " +
        (postLook.issued.cameraFrame ? "This is the newly rendered view after that look. " :
          "This is the first native-bound image for that look; it does not establish what the earlier pixels showed. ") +
        "Nominate a useful visible region, abstain, or quote separate ordinary work only if a current structured witness supports it. Do not request another camera read." } :
        reconsideration?.kind === "superseded-opening" ? openingSupersessionFeedback(reconsideration) :
        reconsideration?.kind === "alternative" ? {
        kind: "failed_intent",
        detail: reconsideration.opening
          ? "The opening view lost its witness before issuance. No camera read or work started. If the fresh physical clue already supports the job, use ordinary work without an opening view. Otherwise choose a distinct supported alternative or abstain."
          : "The previous chosen opportunity lost its witness before issuance. No effect was applied. Choose only from the current observation, or abstain.",
      } : correction?.feedback ?? this.currentFeedback(observation),
      ...(lookahead ? { lookahead: lookahead.evidence } : {}),
      ...(workDemand ? { work: workDemand } : {}),
      ...(visual ? { visual } : {}),
    };
    if (!lookahead && !postLook) {
      this.postLook = undefined; // A normal follow-up took the slot instead of the optional image.
      this.queryKeys.add(view.query);
      this.lastAsked = view;
    }
    const replyKey = !postLook && !correction && !reconsideration && !lookahead && !workDemand?.current && !this.job && !this.queuedWork &&
      sameLiveCorrectionScope(observation, observation) ? this.liveReplyKey(observation) : undefined;
    await this.record("request", { requestId, evidenceKey: view.evidence, request,
      ...(correction ? { correctionOf: correction.requestId } : {}),
      ...(reconsideration ? { reconsiderationOf: reconsideration.requestId, reconsideration: reconsideration.kind } : {}),
      ...(reacquiredTravelOf ? { reacquiredTravelOf } : {}),
      ...(firstLiveReadOf ? { firstLiveReadOf } : {}),
      ...(postLook ? { postLookOf: postLook.issued.requestId, cameraIntentId: postLook.issued.intent.id,
        cameraTerminalTick: postLook.terminalTick } : {}),
      ...(resultingRead ? { visualFollowupOf: resultingRead.probe.wire.requestId } : {}) });
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
    if (resultingRead) resultingRead.followedUp = true;
    if (correction) this.replyCorrection = undefined;
    if (reconsideration) this.recoveredIntents.add(reconsideration.key);
    // A newer decision supersedes a failed primitive. Only a restored survey
    // can carry its allowance through one subsequent model-reported gap.
    if (reconsideration || this.intentRecovery?.kind === "alternative" || this.intentRecovery?.kind === "superseded-opening")
      this.intentRecovery = undefined;
    const context: Decision = { requestId, observation, generation, testedSkills, selectedSkillHash,
      lookahead, workDemand, workOverlap, replyKey, correction, reconsideration, reacquiredTravelOf, firstLiveReadOf, visual,
      ...(visualWake ? { visualFollowup: true } : {}), ...(postLook ? { postLook } : {}) };
    this.busy = {
      kind: "inference",
      work: this.work(context, this.limits.requestTimeoutMs, async signal => {
        if (lookahead) return this.config.strategist!(request, signal);
        if (workDemand?.parkedWorksite === "view-unavailable" ||
            workDemand?.current && (workDemand.current.id !== workDemand.duringWaitFor || !this.config.frame)) return this.config.strategist!({ ...request,
          strategicEpisodes: this.episodeMemory.forObservation(observation) }, signal);
        let sample: MacroFrame | undefined;
        try {
          sample = await this.capture(observation, observedAt, requestId, signal, !!workDemand, correction,
            reacquiredTravelOf ? observation.travelHint : undefined);
          signal.throwIfAborted();
          if (reconsideration?.kind === "superseded-opening") {
            const latest = await this.ipc!.read("observation.json", parseMacroObservation);
            if (!latest || !this.supersededOpeningWitnessCurrent(reconsideration, latest))
              throw new FrameRejected("stale", "The fresh physical start no longer supersedes the unissued opening view.");
          }
          if (firstLiveReadOf) {
            const latest = await this.ipc!.read("observation.json", parseMacroObservation);
            if (!latest || latest.tick < observation.tick || !sameOpeningStance(observation, latest) ||
                latest.workOrder || !hasStock(latest, workDemand!.protectedReserves) ||
                !disclosed.opportunities.some(offer => firstWorkRead(offer) &&
                  latest.opportunities.some(fresh => sameOffer(offer, fresh))))
              throw new FrameRejected("stale", "The first usable read is no longer offered on the same safe stance.");
            signal.throwIfAborted();
          }
        } catch (error) {
          if (sample) await discardFrame(sample);
          if (error instanceof FrameRejected) throw error;
          if (error instanceof MacroObservationRotating) throw new FrameRejected("rotation", error.message);
          throw new FrameRejected(signal.aborted ? "stale" : "invalid", "The request stopped before provider dispatch.");
        }
        // Authoring source and the in-memory history projection are not copied to the request log.
        const input = {
          ...request, nativeReview: workDemand?.current || postLook ? undefined : this.config.nativeReview?.context,
          strategicEpisodes: this.episodeMemory.forObservation(observation),
        };
        if (postLook) {
          const prior = postLook.issued.cameraFrame;
          const next = sample?.visualBinding;
          // The accepted camera completion proves a real look; neither an ID
          // change nor heartbeat alone supplies the new image.
          if (!next || prior && (next.captureId === prior.captureId || next.renderFrame <= prior.renderFrame ||
              sample?.artifact?.sha256 === prior.imageSha256)) {
            if (sample) await discardFrame(sample);
            throw new FrameRejected("stale", "The completed camera read did not supply a distinct native-bound image.");
          }
        }
        if (!sample) return this.config.strategist!(input, signal);
        const { artifact, visualBinding, ...ordinaryFrame } = sample;
        const verify = artifact?.verify;
        // Only an owned, immutable archive can carry native visual authority.
        const binding = visual?.mayNominate && verify ? visualBinding : undefined;
        const compareOnly = visual?.mayNominate === false && !!visual.read && !!visualBinding && sample.captureSource !== "x11";
        const frame: MacroFrame = binding ? { ...ordinaryFrame, visualBinding: binding } : ordinaryFrame;
        let sent = false;
        try {
          if (verify && !await verify()) {
            await this.record("request_frame_omitted", { requestId, basis: basis(observation), cause: "unavailable",
              reason: "The archived image was replaced before dispatch." });
            if (postLook) throw new FrameRejected("stale", "The post-look image was replaced before dispatch.");
            return this.config.strategist!(input, signal);
          }
          signal.throwIfAborted();
          let dispatchVerified = false;
          const verifyFrameDispatch = (binding || compareOnly) && verify ? async () => {
            const latest = await this.ipc!.read("observation.json", parseMacroObservation);
            dispatchVerified = sameNativeFrameScope(observation, latest) &&
              (!postLook || latest !== null && this.retainedPostLook(postLook, latest) &&
                !this.postLookHasOrdinaryStart(postLook, latest) && hasStock(latest, workDemand!.protectedReserves)) && await verify();
            return dispatchVerified;
          } : verify;
          const result = await this.config.strategist!({ ...input, frame, verifyFrameDispatch }, signal);
          sent = result.dispatched === true && result.frameSha256 === artifact?.sha256;
          if (sent && dispatchVerified && binding && verify && artifact &&
              result.frameVisualBinding?.captureId === binding.captureId && result.frameVisualBinding.renderFrame === binding.renderFrame) {
            context.deliveredVisual = { ...binding, imageSha256: artifact.sha256, verify };
          } else if (sent && dispatchVerified && compareOnly && visualBinding && artifact) {
            context.comparisonFrame = { ...visualBinding, imageSha256: artifact.sha256 };
          }
          return result;
        } finally {
          if (!sent) await discardFrame(sample);
        }
      }),
    };
  }

  private async capture(
    observation: MacroObservation, observedAt: number, requestId: string, signal: AbortSignal, durable: boolean, correction?: ReplyCorrection,
    reacquiredTravel?: MacroTravelHint,
  ): Promise<MacroFrame | undefined> {
    if (!this.config.frame) return;
    let sample: FrameCapture;
    try { sample = await this.config.frame(observation, signal, requestId); }
    catch (error) {
      if (correction && error instanceof MacroObservationRotating) throw error;
      throw new FrameRejected(signal.aborted ? "stale" : "invalid", "The trusted display capture did not settle.");
    }
    const ipc = this.ipc!;
    const checkScope = async () => {
      let latest: MacroObservation | null;
      try { latest = await ipc.read("observation.json", parseMacroObservation); }
      catch (error) {
        if (correction || !(error instanceof MacroObservationRotating)) throw error;
        latest = null;
      }
      if (!latest || !(durable ? workScope(observation, latest) : samePlayableScope(observation, latest)) ||
          (correction && !this.sameReplyContext(correction, latest)) || latest.tick < observation.tick ||
          performance.now() - observedAt > this.limits.maxObservationAgeMs) {
        throw new FrameRejected("stale", "The observation scope or freshness changed during display capture.");
      }
      if (reacquiredTravel && (!sameTravelReacquisitionScope(observation, latest) ||
          !sameTravelReacquisitionHint(reacquiredTravel, latest.travelHint) ||
          this.workQuery?.evidence !== this.workQueryEvidence(latest)))
        throw new FrameRejected("stale", "The reacquired approach changed before provider dispatch.");
      return latest;
    };
    if ("cause" in sample) {
      signal.throwIfAborted();
      await this.record("request_frame_omitted", { requestId, basis: basis(observation), ...sample,
        reason: sample.cause === "unavailable" ? "The display capture did not produce an admissible image." :
          "The published observation changed during display capture." });
      await checkScope();
      return;
    }
    try {
      signal.throwIfAborted();
      if (sample.source !== "verified-game-display" || !(sample.data instanceof Uint8Array) ||
          sample.data.length < 1 || sample.data.length > 2 * 1024 * 1024 ||
          !Number.isSafeInteger(sample.width) || !Number.isSafeInteger(sample.height) ||
          sample.width < 1 || sample.height < 1 || sample.width > 2_048 || sample.height > 2_048 ||
          (sample.mimeType !== "image/jpeg" && sample.mimeType !== "image/png")) {
        throw new FrameRejected("invalid", "The display capture exceeded its admitted shape.");
      }
      const sha256 = createHash("sha256").update(sample.data).digest("hex");
      const extension = sample.mimeType === "image/jpeg" ? "jpg" : "png";
      const { artifact } = sample;
      const relativePath = artifact?.relativePath ?? null;
      if (artifact && (relativePath !== `macro-frames/${requestId}.${extension}` || artifact.sha256 !== sha256)) {
        throw new FrameRejected("invalid", "The display capture archive did not match its request or bytes.");
      }
      if (sample.visualBinding) {
        const binding = sample.visualBinding;
        validateMacroCaptureId(binding.captureId);
        if (!artifact?.verify || sample.mimeType !== "image/jpeg" || sample.captureSource === "x11" ||
            !Number.isSafeInteger(binding.renderFrame) || binding.renderFrame < 1) {
          throw new FrameRejected("invalid", "The native visual binding did not have an owned image and render identity.");
        }
      }
      if (!sameBasis(sample, observation)) throw new FrameRejected("stale", "The display capture used a stale observation basis.");
      await this.record("request_frame", { requestId, basis: basis(observation), sha256, relativePath,
        bytes: sample.data.length, width: sample.width, height: sample.height, mimeType: sample.mimeType,
        ...(sample.captureSource || sample.visualBinding ? { captureSource: sample.captureSource ?? "native" } : {}),
        ...(sample.nativeOmission ? { nativeOmission: sample.nativeOmission } : {}),
        ...(sample.nativeCaptureMs !== undefined ? { nativeCaptureMs: sample.nativeCaptureMs } : {}),
        ...(sample.visualBinding ? { visualBinding: sample.visualBinding } : {}) });
      const latest = await checkScope();
      signal.throwIfAborted();
      if (sameBasis(latest, observation) || sample.visualBinding && sameNativeFrameScope(observation, latest)) return sample;
    } catch (error) {
      await discardFrame(sample);
      throw error;
    }
    await discardFrame(sample);
    await this.record("request_frame_omitted", { requestId, basis: basis(observation), cause: "basis_changed",
      reason: "A newer tick arrived before dispatch; retained the original observation only." });
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
    const stale = runtimeExpired || !current || (context.correction && !this.replyCorrectionApplies(context.correction, current)) ||
      (context.reconsideration?.kind === "superseded-opening" && !this.supersededOpeningCurrent(context.reconsideration, current)) ||
      (context.lookahead ? !lookaheadScope(context.lookahead, current) :
      context.workDemand ? !workScope(context.observation, current) || !this.pendingDecisionCurrent(context, current) :
        !samePlayableScope(context.observation, current)) ||
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
    if (inference?.dispatched === true) context.providerDispatched = true;
    const model = inference?.model && /^[A-Za-z0-9._:/-]{1,257}$/.test(inference.model) &&
      (!this.config.model || inference.model === this.config.model) ? inference.model : null;
    if (model) this.models.add(model);
    if (typeof inference?.dispatched === "boolean") {
      this.unreportedDispatches--;
      if (inference.dispatched) this.providerDispatches++;
    } else if (!result.ok && result.preflight) this.unreportedDispatches--;
    if (context.postLook && (inference?.dispatched === false || !result.ok && result.preflight)) {
      // No provider received an eligible post-look image. Releasing the reserved
      // slot does not recreate the one-shot camera handoff.
      this.requests--;
      await this.record("post_look_visual_skipped", { requestId: context.requestId,
        cameraIntentId: context.postLook.issued.intent.id,
        reason: result.ok ? result.value.outcome : result.detail });
    }
    if (inference) {
      this.lastProviderOutcome = inference.outcome;
      this.lastProviderLatencyMs = positiveFinite(inference.latencyMs);
    }
    let rejection: MacroReplyRejection | undefined = inference?.outcome === "invalid" ? inference.invalidReply : undefined;
    if (inference?.outcome === "completed") {
      try {
        proposal = parseMacroProposal(inference.proposal);
        if (Buffer.byteLength(JSON.stringify(proposal)) > this.limits.maxResponseBytes) {
          proposal = null;
          rejection = "argument_bytes";
        }
      } catch (error) {
        proposal = null;
        rejection = error instanceof MacroValidationError ? error : "schema";
      }
    }
    const original = context.observation;
    const basisMatches = sameBasis(inference?.basis, original);
    const ttlValid = !!proposal && proposal.expiresTick > original.tick &&
      proposal.expiresTick - original.tick <= (proposal.action.kind === "skill" ? this.limits.maxPlanTtlTicks : this.limits.maxIntentTtlTicks);
    if (proposal && !ttlValid) rejection = "expiry";
    const expired = !!proposal && ttlValid && !!current && current.tick >= proposal.expiresTick;
    const preflight = result.ok ? undefined : result.preflight;
    const rotation = !!context.correction && (preflight === "rotation" || (inference?.observationRotating && inference.dispatched === false));
    const decision = rotation ? "deferred_rotation" :
      stale || expired || (!!inference && !basisMatches) || inference?.outcome === "stale" || preflight === "stale" ? "stale" :
      late ? "timed_out" : preflight === "invalid" ? "invalid" : !inference ? "provider_error" : inference.outcome !== "completed" ? inference.outcome :
      !proposal || !ttlValid || !model ? "invalid" : "proposed";
    const filtered = this.config.preparedStockReady && decision === "proposed" && proposal
      ? filterPreparedStockProposal(proposal.action, original) : undefined;
    const disposition = filtered?.disposition ?? decision;
    const reason = rotation ? "A rotating observation deferred the correction before provider dispatch." :
      rejection ? macroReplyRejectionDetail(rejection) : expired ?
        `The reply expired at tick ${proposal!.expiresTick} before admission at tick ${current!.tick}.` :
        filtered?.reason ?? (result.ok ? null : result.detail);
    if (this.config.preparedStockReady) this.preparedStockDecision = {
      requestId: context.requestId, disposition, reason: reason ?? (
        decision === "proposed" ? "No stock order could be published from the current physical witness." :
        decision === "stale" ? "The live stock witness or request basis changed before a job could be authorized." :
        decision === "invalid" ? "Model returned no valid stock decision." :
        `The single request ended as ${decision}; no stock work was authorized.`),
    };
    const recovery = this.intentRecovery;
    if (recovery?.kind === "restored-survey") {
      // Only the next valid, idle gap can confirm the interruption. The
      // failed choice and absence on both views supply the link, not gap text.
      if (!recovery.gapSeen && disposition === "proposed" && proposal?.action.kind === "gap" &&
          context.workDemand?.current === null && current && this.isCurrentHandoff(current) &&
          !original.working && !current.working && original.tick > recovery.basis.tick &&
          this.intentRecoveryCurrent(recovery, original) && this.intentRecoveryCurrent(recovery, current) &&
          !offersAffordance(original, recovery.offer) && !offersAffordance(current, recovery.offer)) {
        recovery.gapSeen = true;
      } else this.intentRecovery = undefined;
    }
    const correction = context.correction;
    if (correction) {
      if (rotation) {
        // A displaced inode is not a decision or a dispatched request.
        this.requests--;
        if (!this.closing && !stale && !late) this.replyCorrection = correction;
      } else {
        this.correctedContexts.add(correction.key);
        if (this.workQuery) this.workQuery.tick = original.tick;
      }
    } else if (!this.config.preparedStockReady && !context.visualFollowup && disposition === "invalid" && reason && rejection &&
        inference?.dispatched === true && current) {
      this.offerReplyCorrection(context, current,
        { kind: "invalid_reply", detail: `The previous tool reply was invalid. No effect was authorized. ${reason}` });
    }
    if (disposition === "stale") this.staleDecisions++;
    if (disposition === "stale" && inference?.outcome === "stale" && inference.dispatched === false && basisMatches &&
        !stale && !late && !this.config.preparedStockReady && context.workDemand?.current === null && !context.workDemand.parkedWorksite &&
        !context.correction && !context.reconsideration && !context.reacquiredTravelOf &&
        current && this.isCurrentHandoff(current) && sameTravelReacquisitionScope(original, current) &&
        original.travelHint && (!current.travelHint || sameTravelReacquisitionHint(original.travelHint, current.travelHint)) &&
        this.workQuery && this.workQuery.evidence === this.workQueryEvidence(current)) {
      // The miss spent one request slot but did not ask Model. Only a newer view of this exact approach can reopen it.
      this.workQuery.reacquireTravel = { requestId: context.requestId, source: original, hint: original.travelHint,
        until: performance.now() + ALTERNATIVE_RECOVERY_MS };
    }
    this.unavailable = disposition === "provider_unavailable";
    this.lastDisposition = disposition;
    // Keep candidate contents only in private review storage, not the run trace.
    const hadReviewPatch = !rejection && disposition !== "invalid" && proposal?.action.kind === "gap" && !!proposal.action.reviewPatch;
    const recordedProposal: MacroProposal | null = rejection || disposition === "invalid" ||
      filtered?.disposition === "prepared_stock_refused" ? null : proposal?.action.kind === "gap" && hadReviewPatch
      ? { ...proposal, action: { kind: "gap", capability: proposal.action.capability, suggestion: proposal.action.suggestion } }
      : proposal;
    await this.append(this.proposals, {
      requestId: context.requestId, basis: basis(original), goal: original.goal, capabilitiesVersion: this.capabilitiesVersion,
      skillGeneration: context.generation, model, usage: usageEvidence(inference?.usage ?? null), costUsd: positiveFinite(inference?.costUsd),
      providerOutcome: inference?.outcome ?? null, dispatched: inference?.dispatched ?? (preflight ? false : null),
      latencyMs: Math.round(result.settledAt - startedAt), providerLatencyMs: positiveFinite(inference?.latencyMs),
      frameSha256: inference?.frameSha256 && /^[a-f0-9]{64}$/.test(inference.frameSha256) ? inference.frameSha256 : null,
      ...(context.deliveredVisual ? { captureId: context.deliveredVisual.captureId, renderFrame: context.deliveredVisual.renderFrame } : {}),
      ...(context.postLook ? { postLookOf: context.postLook.issued.requestId } : {}),
      disposition, reason, proposal: recordedProposal,
      ...(filtered ? { filteredAction: proposal?.action.kind } : {}),
      ...(correction ? { correctionOf: correction.requestId } : {}),
      ...(context.reacquiredTravelOf ? { reacquiredTravelOf: context.reacquiredTravelOf } : {}),
      ...(context.firstLiveReadOf ? { firstLiveReadOf: context.firstLiveReadOf } : {}),
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
    // No prepared read, gap, out-of-scope or stale reply acquires native authority.
    if (this.config.preparedStockReady && disposition !== "proposed") return;
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
    const smeltOverlap = context.workOverlap?.smeltBurnTick !== undefined;
    if (smeltOverlap && proposal.action.kind !== "abstain" && proposal.action.kind !== "work" &&
        proposal.action.kind !== "work-program" && proposal.action.kind !== "defer-pending") {
      if (disposition === "proposed") await this.record("work_successor_discarded", { requestId: context.requestId,
        afterWorkId: context.workOverlap!.incumbent.order.id, reason: "overlap_requires_bound_successor" });
      return;
    }
    // The incumbent's planned wait (including a blocking furnace cook) is
    // one-shot. Idle abstention is different: even an expired reply authorized
    // nothing and must not hide a newly actionable witness. Explicit deferral
    // instead advances on the native park/return transitions, not this flag.
    if (proposal.action.kind === "abstain" && !context.reconsideration && context.workDemand?.current === null &&
        !context.workDemand.parkedWorksite && this.workQuery &&
        model && basisMatches && ttlValid && !runtimeExpired && !late) {
      this.workQuery.mayRecoverOnAffordance = true;
      if (inference?.dispatched === true && !this.config.preparedStockReady && context.workDemand.demand === "first" &&
          !this.lastReceipt && !current.workOrder && emptyFirstWorkView(original) && sameOpeningStance(original, current) &&
          hasStock(current, context.workDemand.protectedReserves)) {
        this.workQuery.emptyStartAbstention = { source: original, requestId: context.requestId };
      }
    }
    if (disposition !== "proposed") {
      // The provider chose a pure function, not a durable live command. A
      // stale movement premise may still yield bounded independent testing,
      // but never promotion or reissue from this old request.
      if (!correction && disposition === "stale" && !runtimeExpired && !late && model && ttlValid && basisMatches &&
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
    if (context.postLook && (!context.deliveredVisual || !sameOpeningStance(original, current) ||
        (action.kind !== "nominate-visible" && action.kind !== "abstain" &&
          (action.kind !== "work" || action.openingViewId || action.afterWorkId || action.duringWaitFor || action.duringWait ||
            !postLookWorkStart(original, action.policy) || !postLookWorkStart(current, action.policy))))) {
      await this.record("post_look_visual_refused", { requestId: context.requestId,
        reason: "The checked image allows nomination, abstention, or independently witnessed ordinary work without another look." });
      return;
    }
    if (action.kind === "work" && isFoodWork(action.policy) &&
        (this.job || action.afterWorkId || action.duringWaitFor || action.duringWait || action.openingViewId ||
          !foodWorkWitness(original, action.policy))) {
      await this.disposition("proposal_refused", { requestId: context.requestId,
        reason: "Food work needs a single exact live source with the protected stock already held." });
      return;
    }
    if (context.workDemand?.parkedWorksite === "view-unavailable" && action.kind !== "abstain" && action.kind !== "gap") {
      await this.disposition("proposal_refused", { requestId: context.requestId,
        reason: "A parked worksite with no current world view grants no live action." });
      return;
    }
    if (action.kind === "renew-work") {
      const job = this.job;
      if (context.workDemand?.demand === "renew" && context.workDemand.renewal?.workOrderId === action.workOrderId &&
          job?.order.id === action.workOrderId && proposal.expiresTick > job.order.expiresTick &&
          this.canRenewWork(job, current)) {
        const renewed = await this.publishWork(original, job.policy, job.order.origin, context.requestId, proposal.expiresTick,
          [], undefined, fresh => this.canRenewWork(job, fresh) && this.pendingDecisionCurrent(context, fresh),
          undefined, undefined, job.order.duringWaitFor, job);
        if (renewed) return;
      }
      await this.disposition("proposal_refused", { requestId: context.requestId,
        reason: "Renewal requires the same offered ordinary job to still be active and a later finite expiry." });
      return;
    }
    if (action.kind === "collect-pending" || action.kind === "defer-pending") {
      const ticket = context.observation.pendingWork;
      if (!context.workDemand || ticket?.id !== action.pendingWorkId) {
        await this.disposition("proposal_refused", { requestId: context.requestId, reason: "Pending action requires the live observed ticket." });
        return;
      }
      const offerId = action.kind === "collect-pending" ? ticket.collectOfferId : ticket.deferOfferId;
      if (!offerId) {
        await this.disposition("proposal_refused", { requestId: context.requestId, reason: "The pending action had no fresh native offer." });
        return;
      }
      const issued = await this.issue({ ...context, proposal }, context.observation, offerId);
      const window = this.parkedWorkQueries;
      if (issued === false && action.kind === "collect-pending" && window?.id === ticket.id &&
          this.view?.observation.pendingWork?.id === ticket.id && this.view.observation.pendingWork.collectOfferId !== offerId) {
        window.recallLost = true;
      }
      return;
    }
    if (action.kind === "work" || action.kind === "work-program" || action.kind === "revoke-work") {
      if (!context.workDemand) {
        await this.disposition("proposal_refused", { requestId: context.requestId, reason: "Durable work was not offered." });
        return;
      }
      const overlap = context.workOverlap;
      if (action.kind === "work" && action.duringWaitFor) {
        const admitted = action.duringWaitFor === context.workDemand.duringWaitFor &&
          await this.publishPendingOrdinary(action.duringWaitFor, original, context.requestId, action.policy, proposal.expiresTick);
        if (!admitted) await this.disposition("proposal_refused", { requestId: context.requestId,
          reason: "Independent work requires the same paid ticket, a current work handoff, and protected stock." });
        return;
      }
      if (overlap) {
        const { incumbent, queue } = overlap;
        const sameIncumbent = this.job === incumbent || (!this.job && incumbent.terminal?.status === "completed");
        if (this.queuedWork !== queue || !sameIncumbent || incumbent.withdrawn ||
            action.kind === "revoke-work" || action.afterWorkId !== incumbent.order.id) {
          await this.record("work_successor_discarded", { requestId: context.requestId, afterWorkId: incumbent.order.id,
            reason: "overlap_successor_not_current" });
          return;
        }
      }
      if (action.kind === "revoke-work") {
        if (context.workDemand.current?.id !== action.workOrderId || this.job?.order.id !== action.workOrderId) {
          await this.disposition("proposal_refused", { requestId: context.requestId, reason: "Revoke requires the same observed job." });
        } else await this.withdrawWork("model_revoked", context.requestId);
        return;
      }
      const stages = action.kind === "work-program" ? action.stages : [{ policy: action.policy, requires: [] }];
      const plan = { ...context, proposal, replyKey: inference?.dispatched === true ? context.replyKey : undefined };
      if (stages.some(({ policy: { target } }) => target.kind === "preset" && target.goal !== current.goal)) {
        await this.disposition("proposal_refused", { requestId: context.requestId, reason: "Work preset does not match the live goal." });
        return;
      }
      if (action.kind === "work" && action.openingViewId) {
        const offer = original.opportunities.find(offer => offer.id === action.openingViewId);
        if (!context.workDemand.openingViewIds?.includes(action.openingViewId) || !offer ||
            !openingViewMatchesPolicy(offer, action.policy) || openingWorkWitness(original, action.policy, offer)) {
          await this.disposition("proposal_refused", { requestId: plan.requestId,
            reason: "The opening view was not offered, is unrelated to this job, or the job already has a current witness." });
          return;
        }
        this.episodeMemory.chosen(plan.requestId, original, proposal.subgoal, proposal.successCondition);
        if (await this.issue(plan, original, offer.id) && this.pending) {
          this.openingView = { plan, policy: action.policy, issued: this.pending };
        }
        return;
      }
      if (action.afterWorkId) {
        const after = this.jobs.get(action.afterWorkId);
        const paidPredecessor = after && (context.workDemand.pendingPredecessor?.id === after.order.id || smeltOverlap &&
          context.workDemand.current?.id === after.order.id);
        if (!after?.accepted || after.withdrawn || (!paidPredecessor && (context.workDemand.current?.id !== after.order.id ||
            !context.workDemand.current.accepted)) ||
            (after.terminal ? after.terminal.status !== "completed" : paidPredecessor ? !after.parked && this.job !== after : this.job !== after)) {
          await this.disposition("proposal_refused", { requestId: context.requestId, reason: "Successor requires the same accepted work job." });
          return;
        }
        const previousTarget = after.policy.target;
        const nextTarget = stages[0]!.policy.target;
        if (previousTarget.kind === "stock" && nextTarget.kind === "stock" &&
            nextTarget.item === previousTarget.item && nextTarget.count === previousTarget.count) {
          const reason = "That stock target would already be satisfied after the predecessor completes.";
          await this.disposition("proposal_refused", { requestId: context.requestId, reason });
          const key = `renew:${after.order.id}`;
          if (!context.correction && !this.correctedContexts.has(key) && context.workDemand.renewal?.workOrderId === after.order.id &&
              this.canRenewWork(after, current) && after.order.expiresTick - current.tick > WORK_ADMISSION_TICKS) {
            this.replyCorrection = { requestId: context.requestId, observation: original, key,
              renewal: after,
              feedback: { kind: "invalid_reply", detail: `${reason} No work was queued. Use renew-work to continue the same job, select a different objective, or abstain.` } };
          }
          return;
        }
        if (!paidPredecessor && after.order.duringWaitFor && stages.some(({ policy }) => !isIndependentPendingPolicy(policy))) {
          await this.disposition("proposal_refused", { requestId: context.requestId,
            reason: "A successor to independent work cannot use the owed batch, start another batch, or inherit preset authority." });
          return;
        }
        const completed = after.terminal && current.tick >= after.terminal.tick;
        // An accepted model job can supply a conditional projection; its outcome is
        // not stock. The built-in preset may take paths outside the explicit recipe policy.
        if (paidPredecessor) {
          const units = current.pendingWork?.id === after.order.id ? current.pendingWork.output.count :
            current.workOrder?.progress?.smeltBurn?.units;
          if (!completed && units) await this.previewWorkResources(context.requestId, current, stages, undefined, units);
          if (this.pendingSuccessor) await this.discardQueuedWork(this.pendingSuccessor, "live_work_preempted", { preemptedBy: context.requestId });
          this.pendingSuccessor = { after, plan, stages, next: 0, smeltSuccessor: true };
        } else if (completed || after.order.origin === "model") {
          await this.previewWorkResources(context.requestId, current, stages, completed ? undefined : after.policy);
        }
        if (!paidPredecessor) {
          await this.preemptQueuedWork(context.requestId);
          this.queuedWork = { after, plan, stages, next: 0 };
        }
        await this.record("work_successor_queued", { requestId: context.requestId, afterWorkId: after.order.id, stages: stages.length });
        return;
      }
      if (context.workDemand.duringWaitFor || this.job?.order.duringWaitFor) {
        await this.disposition("proposal_refused", { requestId: context.requestId,
          reason: "Name the outstanding ticket with duringWaitFor to continue independent work." });
        return;
      }
      if (action.kind !== "work" || !isFoodWork(action.policy)) await this.previewWorkResources(context.requestId, current, stages);
      await this.preemptQueuedWork(context.requestId);
      this.queuedWork = { after: null, plan, stages, next: 0,
        ...(action.kind === "work" && action.policy.allowedEffects.includes(MACRO_IRON_SMELT)
          ? { pendingPurpose: { subgoal: proposal.subgoal, reason: proposal.reason } } : {}),
        ...(action.kind === "work" && action.duringWait ? { preparedSide: action.duringWait } : {}) };
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
    if (action.kind === "nominate-visible") {
      await this.nominateVisual({ ...context, proposal }, action);
      return;
    }
    if (action.kind === "recon" && (inference?.dispatched !== true || context.visual?.reconOpportunityId !== action.opportunityId)) {
      await this.record("visual_recon_refused", { requestId: context.requestId, reason: "A separate dispatched choice must name the confirmed recon offer." });
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
      case "recon":
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
    if (plan.proposal.action.kind === "opportunity" || plan.proposal.action.kind === "recon") {
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

  private openingHandoff(source: MacroObservation, fresh: MacroObservation, policy: MacroWorkPolicy, queued?: QueuedWork): boolean {
    const inherited = this.floorScope?.life === fresh.life ? this.floorScope.reserves : [];
    return this.isCurrentHandoff(fresh) && sameOpeningStance(source, fresh) && this.queuedWork === queued && !this.pendingSuccessor &&
      !this.direct && !this.segment && !this.conditional && !this.lease && hasStock(fresh, policy.reserves) &&
      !confirmsWorkStock(fresh, policy) &&
      inherited.every(floor => policy.reserves.some(kept => kept.item === floor.item && kept.count >= floor.count));
  }

  private async advanceOpeningView(current: MacroObservation | undefined, runtimeExpired: boolean): Promise<void> {
    const { plan, policy, issued } = this.openingView!;
    const receipt = issued.terminal;
    let reason: string;
    if (runtimeExpired || !current || this.closing || !sameOpeningStance(issued.scope, current) ||
        current.tick >= plan.proposal.expiresTick || issued.withdrawn) {
      if (this.pending === issued) await this.withdraw("opening_view_scope_lost");
      reason = "opening_view_scope_lost";
    } else if (!receipt || current.tick <= receipt.tick) return;
    else if (!issued.accepted || receipt.status !== "completed") reason = "opening_view_not_completed";
    else {
      const admits = (fresh: MacroObservation) => fresh.tick > receipt.tick && fresh.tick < plan.proposal.expiresTick &&
        this.openingHandoff(issued.scope, fresh, policy) && openingWorkWitness(fresh, policy, issued.offer);
      const job = await this.publishWork(issued.scope, policy, "model", plan.requestId, plan.proposal.expiresTick,
        [], undefined, fresh => !!admits(fresh), undefined, async fresh => {
          const check = preflightVanillaWork(fresh, [{ policy, requires: [] }]);
          if (check.kind !== "shortage") return true;
          await this.reportWorkShortage(plan.requestId, check, fresh);
          return false;
        }, undefined, undefined, (before, latest) => {
          const witnessed = openingWorkWitness(before, policy, issued.offer);
          const stillVisible = admits(latest);
          return !!witnessed && !!stillVisible && latest.tick - before.tick < WORK_ADMISSION_TICKS &&
            sameOpeningWitness(witnessed, stillVisible);
        }, fresh => {
          const witnessed = openingWorkWitness(fresh, policy, issued.offer);
          if (!witnessed) return;
          if ("footing" in witnessed) return { travelAnchor: { subject: witnessed.subject, target: witnessed.target } };
          if ("surfaceOpening" in witnessed) return { surfaceAnchor: surfaceAnchor(witnessed.surfaceOpening) };
          if (issued.offer.anchor && "material" in witnessed && witnessed.material) {
            const { subject, target } = witnessed.material;
            return { harvestAnchor: { subject, target } };
          }
        });
      if (job === null) return; // Rotating observation: wait for a sample, never act on the cache.
      reason = job ? "work_issued" : "no_supported_physical_start";
      if (!job && this.currentFeedback(current)?.kind !== "work_resource_shortage") this.feedback = {
        observation: current, value: { kind: "opening_view_unconfirmed",
          detail: "The completed camera check did not establish a current start for the quoted job. No work was authorized." },
      };
    }
    await this.finishOpeningView(reason);
  }

  private async finishOpeningView(reason: string): Promise<void> {
    const opening = this.openingView;
    if (!opening) return;
    this.openingView = undefined;
    if (reason !== "work_issued" && this.workQuery) {
      this.workQuery.mayRecoverOnAffordance = true;
      this.workQuery.failedOpeningPolicy = opening.policy;
    }
    if (reason === "no_supported_physical_start") this.armPostLook(opening.issued);
    await this.record("opening_view_finished", { requestId: opening.plan.requestId, intentId: opening.issued.intent.id,
      terminalTick: opening.issued.terminal?.tick ?? null, reason,
      workOrderId: reason === "work_issued" ? this.job?.order.id : null });
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

  private rememberFailedIntent(plan: Plan, witnessed: MacroObservation, lost: MacroOpportunity, current: MacroObservation): void {
    const action = plan.proposal.action;
    const opening = action.kind === "work" && action.openingViewId === lost.id &&
      openingViewMatchesPolicy(lost, action.policy) ? { source: witnessed, policy: action.policy } : undefined;
    if (plan.reconsideration || (!opening && action.kind !== "opportunity") || plan.workDemand?.current !== null ||
        this.queuedWork || witnessed.working || current.working || !this.isCurrentHandoff(current) ||
        !scope(witnessed, current) || !workScope(witnessed, current) || witnessed.health !== current.health ||
        current.tick >= plan.proposal.expiresTick) return;
    const stillOffered = current.opportunities.some(offer => sameOffer(lost, offer));
    if (opening) {
      if (!this.openingHandoff(witnessed, current, opening.policy) ||
          (stillOffered && !openingWorkWitness(current, opening.policy, lost))) return;
    } else if (current.opportunities.some(offer => offer.id === lost.id) || offersAffordance(current, lost)) return;
    const evidence = this.workQueryEvidence(current);
    const shared = { requestId: plan.requestId, basis: basis(witnessed), health: current.health, offer: lost, evidence };
    if (opening) {
      const replacement = replacementOpeningWitness(current, opening.policy, lost);
      const newPhysicalWitness = replacement && ("footing" in replacement
        ? !openingWorkWitness(witnessed, opening.policy, { anchor: replacement })
        : witnessed.prospectOpening?.target !== replacement.target);
      if (newPhysicalWitness && workEvidence(witnessed, this.lastWorkQueryReceipt) === workEvidence(current, this.lastWorkQueryReceipt)) {
        const key = digest(["superseded-opening", current.epoch, evidence]);
        if (!this.recoveredIntents.has(key)) this.intentRecovery = { ...shared, kind: "superseded-opening",
          ...opening, replacement, key, proposalExpiresTick: plan.proposal.expiresTick,
          expiresTick: Math.min(plan.proposal.expiresTick, current.tick + ALTERNATIVE_RECOVERY_TICKS),
          until: performance.now() + ALTERNATIVE_RECOVERY_MS };
        return;
      }
      if (!lost.anchor) return; // A contextual survey alone is never a recovery.
    }
    if ((opening || lost.risk !== "guarded" && meaningfulPrimitive(lost)) &&
        workEvidence(witnessed, this.lastWorkQueryReceipt) === workEvidence(current, this.lastWorkQueryReceipt)) {
      // Spend one recovery per unchanged work premise, independent of which
      // opaque ID or camera bearing happened to fail.
      const key = digest(["alternative", current.epoch, evidence]);
      if (!this.recoveredIntents.has(key)) this.intentRecovery = { ...shared, kind: "alternative", key,
        ...(opening ? { opening } : {}),
        expiresTick: Math.min(plan.proposal.expiresTick, current.tick + ALTERNATIVE_RECOVERY_TICKS),
        until: performance.now() + ALTERNATIVE_RECOVERY_MS };
    } else if (lost.verb === "survey" && !workAffordance(lost) && evidence === this.workQuery?.evidence) {
      // A pure camera survey needs its own model-reported gap and the exact
      // affordance restored; losing it does not justify an alternate by itself.
      const key = digest(["restored-survey", current.epoch, current.health, evidence, lost.verb, lost.summary, lost.evidence]);
      if (!this.recoveredIntents.has(key)) this.intentRecovery = { ...shared, kind: "restored-survey", key,
        expiresTick: Math.min(plan.proposal.expiresTick, current.tick + SURVEY_RECOVERY_TICKS),
        until: performance.now() + SURVEY_RECOVERY_MS };
    }
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
    const recovery = plan.reconsideration;
    if ((recovery?.kind === "superseded-opening" || (recovery?.kind === "alternative" && recovery.opening)) &&
        sameAffordance(recovery.offer, before)) {
      await this.disposition("proposal_refused", { requestId: plan.requestId, reason: "The refused opening view is not a distinct recovery action." });
      return false;
    }
    if (before.verb === MACRO_WATER_CLUE || before.verb === MACRO_FOOD_CLUE) {
      await this.disposition("proposal_refused", { requestId: plan.requestId, reason: "A source clue grants no primitive or skill action." });
      return false;
    }
    const action = plan.proposal.action;
    const recon = action.kind === "recon" ? action : undefined;
    const reconFinding = recon ? this.currentVisualFinding(current) : undefined;
    if ((before.verb === MACRO_RECON) !== !!recon || (recon && (authority ||
        plan.visual?.reconOpportunityId !== opportunityId || !reconFinding || !sameOffer(before, this.reconOffer(current, reconFinding))))) {
      await this.disposition("proposal_refused", { requestId: plan.requestId,
        reason: "Visual reconnaissance needs a separate bounded model choice of the exact current confirmed candidate." });
      return false;
    }
    const pendingAction = action.kind === "collect-pending" || action.kind === "defer-pending" ? action : undefined;
    const openingPolicy = action.kind === "work" && action.openingViewId === opportunityId ? action.policy : undefined;
    const scout = isGroundScout(before);
    const reserves = this.floorScope?.life === current.life ? this.floorScope.reserves : [];
    if (scout && (!this.workMode || authority || action.kind !== "opportunity" || this.queuedWork || this.pendingSuccessor ||
        !hasStock(witnessed, reserves))) {
      await this.disposition("proposal_refused", { requestId: plan.requestId,
        reason: "Ground reconnaissance needs a standalone model choice with all protected stock already held." });
      return false;
    }
    if (isPendingWorkVerb(before.verb) !== !!pendingAction || (pendingAction && authority)) {
      await this.disposition("proposal_refused", { requestId: plan.requestId, reason: "Pending station use needs explicit ticket authorization." });
      return false;
    }
    const usableHandoff = (observation: MacroObservation) => {
      if (recon) return reconFinding === this.currentVisualFinding(observation) && sameOpeningStance(witnessed, observation) &&
        hasStock(observation, reserves) && sameOffer(before, this.reconOffer(observation, reconFinding));
      if (scout) return this.isCurrentHandoff(observation) && sameOpeningStance(witnessed, observation) &&
        hasStock(observation, reserves) && (independentGroundScout(before.anchor.subject) ||
          observation.travelHint?.footing === "dry" && sameTravelTarget(before.anchor, observation.travelHint));
      if (openingPolicy) return this.openingHandoff(witnessed, observation, openingPolicy) &&
        !openingWorkWitness(observation, openingPolicy, before);
      if (!pendingAction) return this.isCurrentHandoff(observation);
      const ticket = observation.pendingWork;
      const ticketOwner = ticket && this.jobs.get(ticket.id);
      if (ticket?.id !== pendingAction.pendingWorkId || !workScope(witnessed, observation) ||
          observation.working || this.queuedWork || this.closing) return false;
      if (pendingAction.kind === "defer-pending")
        return before.verb === MACRO_DEFER_PENDING && ticket.deferOfferId === opportunityId && !!ticketOwner &&
          this.paidReleaseWindow(ticketOwner, observation);
      return before.verb === MACRO_COLLECT_PENDING && ticket.collectOfferId === opportunityId && ticket.parked &&
        this.parkedCollectionOwned(ticket, observation.life) &&
        this.isCurrentHandoff(observation);
    };
    if (!pendingAction && !openingPolicy && before.risk === "guarded" && (this.workMode === "constrained" ||
        (reserves.length && !protectsStock(reserves, current, before)))) {
      await this.disposition("proposal_refused", { requestId: plan.requestId,
        reason: "This material effect is not authorized by the constrained policy or would break a protected reserve." });
      return false;
    }
    const after = current.opportunities.find(offer => offer.id === opportunityId);
    if (!usableHandoff(current) || !samePlayableScope(witnessed, current) || current.tick >= plan.proposal.expiresTick ||
        !after || !sameOffer(before, after) || (selection && after.risk === "guarded") ||
        (direct && (!directScope(direct, current) || !directConditions(direct, current) || !protectsStock(direct.action.reserves, current, after))) ||
        (conditional && (current.working || !successorScope(conditional, current) || !successorStock(conditional, current, after)))) {
      if (!authority && !recon) this.rememberFailedIntent(plan, witnessed, before, current);
      await this.rejectStale(plan, "opportunity_no_longer_witnessed");
      return false;
    }
    const key = pendingAction
      ? digest([current.life, pendingAction.kind, pendingAction.pendingWorkId, after?.evidence])
      : recon ? digest([MACRO_RECON, current.life, current.epoch, before.anchor!.target])
      : primitiveEffectKey(current, after);
    const segmentKey = digest(after);
    if (this.effectKeys.has(key) || selection?.continuation?.seen.has(segmentKey)) {
      if (this.workQuery && isOpeningView(after)) this.workQuery.mayRecoverOnAffordance = true;
      await this.disposition("duplicate_intent_refused", { requestId: plan.requestId, opportunityId });
      return false;
    }
    const intent = parseMacroIntent({
      v: 1, id: randomUUID(), run: current.run, life: current.life, epoch: current.epoch, basisTick: current.tick,
      expiresTick: Math.min(plan.proposal.expiresTick, current.tick + this.limits.maxIntentTtlTicks,
        direct ? current.tick + Math.max(1, Math.floor((direct.until - performance.now()) / 50)) : Infinity,
        reconFinding ? Math.min(current.tick + MACRO_RECON_MAX_TICKS, reconFinding.result.tick + MACRO_VISUAL_WITNESS_MAX_TICKS) : Infinity),
      opportunityId,
      skillHash: selection?.hash ?? null,
      ...(recon ? { recon: { maxLegs: recon.maxLegs, maxBlocks: recon.maxBlocks } } : {}),
    });
    await this.record("intent_prepared", { requestId: plan.requestId, intent, witnessed: before,
      ...(openingPolicy ? { authority: "opening-view" } : {}),
      ...(reconFinding ? { authority: "visual-recon", readRequestId: reconFinding.probe.wire.requestId,
        candidateId: before.anchor!.target, reserves } : {}),
      ...(direct ? { authority: "direct-continuation", stage: direct.stage + 1,
        selector: direct.action.steps[direct.stage]!.selector, reserves: direct.action.reserves } : {}),
      ...(conditional ? { authority: "conditional-successor", predecessorId: conditional.action.afterIntentId,
        preconditions: conditional.action.requires, originalWitness: conditional.lookahead.evidence.witnessBasis } : {}) });
    const refreshed = await this.refresh();
    if (!refreshed && (direct || conditional)) return null;
    if (!refreshed || !usableHandoff(refreshed) || !samePlayableScope(current, refreshed) || refreshed.tick >= intent.expiresTick ||
        !sameOffer(after, refreshed.opportunities.find(offer => offer.id === opportunityId)) ||
        (!pendingAction && !openingPolicy && before.risk === "guarded" && reserves.length > 0 && !protectsStock(reserves, refreshed, after!)) ||
        (direct && (!directScope(direct, refreshed) || !directConditions(direct, refreshed) || !protectsStock(direct.action.reserves, refreshed, after!))) ||
        (conditional && (refreshed.working || !successorScope(conditional, refreshed) || !successorStock(conditional, refreshed, after!))) ||
        (selection && (!selection.offer || !this.isSelectedSkill(selection.hash, selection.generation) ||
          !this.config.skills!.matchesSelection(selection.offer, refreshed, selection.continuation?.receipts)))) {
      if (!authority && !recon && refreshed) this.rememberFailedIntent(plan, witnessed, before, refreshed);
      await this.rejectStale(plan, "intent_basis_changed_at_publication");
      return false;
    }
    const beforeLook = plan.deliveredVisual ?? plan.comparisonFrame;
    const macro: Issued = { requestId: plan.requestId, intent, scope: refreshed, offer: after!,
      ...(openingPolicy ? { openingWorkView: true } : {}),
      ...(plan.providerDispatched && !authority && (openingPolicy || before.verb === "survey" && before.risk === "read" && !before.anchor)
        ? { paidCameraRead: true, ...(beforeLook ? { cameraFrame: {
          captureId: beforeLook.captureId, renderFrame: beforeLook.renderFrame, imageSha256: beforeLook.imageSha256,
        } } : {}) } : {}),
      ...(reconFinding ? { reserves, reconUntil: Math.min(performance.now() + MACRO_RECON_MAX_TICKS * 50,
        reconFinding.probe.startedAt + VISUAL_WITNESS_MS) } : {}),
      ...(direct ? { reserves: direct.action.reserves, priorTargets: direct.usedTargets } : {}),
      ...(conditional ? { lookedAhead: true } : {}),
    };
    this.pending = macro;
    this.issued.set(intent.id, macro);
    this.effectKeys.add(key);
    await this.ipc!.write("intent.json", intent);
    if (pendingAction?.kind === "collect-pending") {
      const owner = this.jobs.get(pendingAction.pendingWorkId);
      if (owner) owner.collector = macro;
    }
    if (pendingAction) this.episodeMemory.chosen(plan.requestId, witnessed, plan.proposal.subgoal, plan.proposal.successCondition);
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

  private async rejectStale(context: Pick<Decision, "requestId">, reason: string): Promise<void> {
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

  private async previewWorkResources(
    requestId: string, observation: MacroObservation, stages: readonly MacroWorkStage[], prior?: MacroWorkPolicy, paidSmeltUnits?: number,
  ): Promise<void> {
    // This private preview projects only this batch's output. Its input and fuel
    // are already out of the observed inventory. Live admission never uses it.
    const preview = paidSmeltUnits ? {
      inventory: { ...observation.inventory, "minecraft:iron_ingot": stock(observation, "minecraft:iron_ingot") + paidSmeltUnits },
      opportunities: observation.opportunities,
    } : observation;
    const check = preflightVanillaWork(preview, prior ? [{ policy: prior, requires: [] }, ...stages] : stages);
    if (check.kind !== "possible" && (!paidSmeltUnits || check.kind === "shortage") && check.detail !== undefined) {
      const stageIndex = check.stageIndex - (prior ? 1 : 0);
      if (stageIndex >= 0) await this.reportWorkShortage(requestId, {
        stageIndex, detail: prior ? check.detail.replace(/^Stage \d+/, `Stage ${stageIndex + 1}`) : check.detail,
      }, observation);
    } else if (this.currentFeedback(observation)?.kind === "work_resource_shortage") {
      this.feedback = undefined;
      if (this.view) this.view = { ...this.view, query: this.queryKey(this.view.observation, this.view.evidence) };
    }
  }

  private async reportWorkShortage(
    requestId: string, { stageIndex, detail }: VanillaWorkDiagnostic, observation: MacroObservation,
  ): Promise<void> {
    const kind = "work_resource_shortage";
    const feedback = `On the previous proposed path: ${detail} Recheck current carried stock and visible alternatives before changing the policy.`;
    if (this.feedback?.requestId === requestId && this.currentFeedback(observation)?.detail === feedback) return;
    this.feedback = { observation, value: Object.freeze({ kind, detail: feedback }), requestId, workStageIndex: stageIndex };
    if (this.view) this.view = { ...this.view, query: this.queryKey(this.view.observation, this.view.evidence) };
    await this.record(kind, { requestId, stage: stageIndex + 1, detail, basis: basis(observation) });
  }

  private async disposition(event: string, fields: Record<string, unknown> = {}, detail = FEEDBACK[event] ?? null): Promise<void> {
    this.lastDisposition = event;
    await this.record(event, fields);
    if (typeof fields.requestId === "string") this.episodeMemory.rejected(fields.requestId, event);
    if (detail && this.view && !(event === "proposal_refused" && this.feedback?.requestId === fields.requestId &&
        this.currentFeedback(this.view.observation)?.kind === "work_resource_shortage")) {
      const { observation, evidence } = this.view;
      this.feedback = { observation, value: Object.freeze({ kind: event, detail }) };
      this.view = { ...this.view, query: this.queryKey(observation, evidence) };
    }
  }

  private async revoke(): Promise<void> {
    const ipc = this.ipc;
    if (!ipc) return;
    this.intentRecovery = undefined;
    this.postLook = undefined;
    if (this.pending) this.pending.withdrawn = true;
    const errors: unknown[] = [];
    try { await ipc.remove("active.json"); this.markerLive = false; } catch (error) { errors.push(error); }
    try { await this.withdrawWork("authority_revoked"); await ipc.remove("work.json"); } catch (error) { errors.push(error); }
    try { await ipc.remove("intent.json"); } catch (error) { errors.push(error); }
    try { await ipc.remove("handoff.json"); this.lease = undefined; } catch (error) { errors.push(error); }
    try { await this.finishVisualProbe("authority_revoked"); await ipc.remove("visual-probe.json"); }
    catch (error) { errors.push(error); }
    try { await this.endPlanning("revoked"); } catch (error) { errors.push(error); }
    if (this.pendingSuccessor) await this.advancePendingSuccessor(undefined, true);
    if (this.queuedWork) await this.advanceQueuedWork(undefined, true);
    await this.finishOpeningView("authority_revoked");
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
