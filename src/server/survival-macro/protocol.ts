import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import actorManifest from "../../../survival-agent/src/main/resources/fabric.mod.json";
import { SURVIVAL_AGENT_GOALS, type SurvivalAgentGoal } from "../../shared/survival-agent-ui.ts";
import { VANILLA_HARVEST, VANILLA_TIMBER_LEAVES } from "./vanilla-harvest.ts";

export const MACRO_CAPABILITIES_VERSION = `survival-macro/v${actorManifest.custom["gameharness:terra_work_wire"]}`;
export const MACRO_MAX_INTENT_TTL_TICKS = 1_200;
export const MACRO_MAX_PLAN_TTL_TICKS = 7_200;
export const MACRO_MAX_HANDOFF_TTL_TICKS = 100;
export const MACRO_MAX_PLANNING_IDLE_MS = 3_000;
export const MACRO_MAX_STRATEGIC_EPISODES = 3;
export const MACRO_MAX_DIRECT_EFFECTS = 4;
export const MACRO_MAX_DIRECT_MS = 30_000;
export const MACRO_LOOKAHEAD_MAX_AGE_TICKS = 40;
export const MACRO_LOOKAHEAD_MAX_CRACK = 0.65;
export const MACRO_MAX_WORK_STAGES = 3;
export const MACRO_SMELT_OVERLAP_MIN_COOK_TICKS = 80;
export const MACRO_PENDING_SIDE_MAX_TICKS = 600;
export const MACRO_PENDING_SIDE_MAX_EFFECTS = 4;
export const MACRO_COLLECT_PENDING = "collect_pending";
export const MACRO_DEFER_PENDING = "defer_pending";

export function isPendingWorkVerb(verb: string): boolean {
  return verb === MACRO_COLLECT_PENDING || verb === MACRO_DEFER_PENDING;
}

export const MACRO_IRON_SMELT = "smelt:minecraft:iron_ingot";
export const MACRO_FURNACE_PLACEMENT = "place:minecraft:furnace";
export const MACRO_DIAMOND_PROSPECT = "prospect:minecraft:diamond";
export const MACRO_PROSPECT_TORCH = "place:minecraft:torch";
export const MACRO_PROSPECT_SUPPORT = "place:minecraft:cobblestone";
export const MACRO_WATER_FILL = "fill:minecraft:water";
export const MACRO_WATER_CLUE = "fill_water";
export const MACRO_WATER_SOURCE = "fluid:minecraft:water_source";
export const MACRO_FOOD_CLUE = "forage";
const foodSources: ReadonlyMap<string, string> = new Map([
  ["block:minecraft:sweet_berry_bush", "minecraft:sweet_berries"],
  ["block:minecraft:cave_vines", "minecraft:glow_berries"],
  ["block:minecraft:cave_vines_plant", "minecraft:glow_berries"],
  ["entity:minecraft:cow", "minecraft:beef"],
  ["entity:minecraft:mooshroom", "minecraft:beef"],
  ["entity:minecraft:pig", "minecraft:porkchop"],
  ["entity:minecraft:sheep", "minecraft:mutton"],
  ["entity:minecraft:rabbit", "minecraft:rabbit"],
]);
const foodEffectPrefix = "forage:";
export const MACRO_WORK_TABLE_PLACEMENT = "place:minecraft:crafting_table";
export const MACRO_LIVE_ONLY_EFFECTS = [
  MACRO_IRON_SMELT, MACRO_FURNACE_PLACEMENT, MACRO_DIAMOND_PROSPECT,
  MACRO_PROSPECT_TORCH, MACRO_PROSPECT_SUPPORT, MACRO_WATER_FILL,
  ...Array.from(foodSources.keys(), subject => `${foodEffectPrefix}${subject}`),
] as const;
export const MACRO_BREAK_EFFECTS: readonly string[] = Object.freeze(
  [...VANILLA_HARVEST.keys(), ...VANILLA_TIMBER_LEAVES].map(id => `break:${id}`),
);
const liveEffects = new Set([...MACRO_BREAK_EFFECTS, MACRO_WORK_TABLE_PLACEMENT, ...MACRO_LIVE_ONLY_EFFECTS]);
const craftEffect = /^craft:[a-z0-9_]{1,96}$/;

// Vanilla 1.21.4 durations for the exact fuels the bounded iron work supports.
// Neither these durations nor a readable station count as observed furnace heat.
export const MACRO_IRON_FUEL_TICKS: ReadonlyMap<string, number> = new Map([
  ["minecraft:coal", 1_600], ["minecraft:charcoal", 1_600], ["minecraft:stick", 100],
  ...["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak", "bamboo"]
    .map(species => [`minecraft:${species}_planks`, 300] as const),
]);

const FILE_BYTES = {
  "active.json": 512,
  "handoff.json": 2 * 1024,
  "planning.json": 1024,
  "native-planning-final.json": 8 * 1024,
  "observation.json": 64 * 1024,
  "intent.json": 2 * 1024,
  "work.json": 16 * 1024,
  "receipt.json": 4 * 1024,
  "revoked.json": 1024,
} as const;
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const itemPattern = /^[a-z0-9_.:/-]{1,128}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface MacroBasis {
  readonly run: string;
  readonly life: number;
  readonly tick: number;
  readonly epoch: number;
}

export interface MacroOpportunity {
  readonly id: string;
  readonly verb: string;
  readonly summary: string;
  readonly risk: "read" | "low" | "guarded";
  readonly evidence: string;
  /** Stable identity of a rendered local clue, independent of the offer ID or camera bearing. */
  readonly anchor?: { readonly subject: string; readonly target: string };
  /** Native evidence for a guarded primitive or a read-only source clue; spends bound item-count loss. */
  readonly material?: {
    readonly subject: string;
    readonly target: string;
    readonly spends: Readonly<Record<string, number>>;
  };
}

const prospectRock = ["minecraft:stone", "minecraft:deepslate", "minecraft:andesite",
  "minecraft:diorite", "minecraft:granite", "minecraft:tuff"] as const;
const surfaceCaps = ["minecraft:grass_block", "minecraft:dirt", ...prospectRock] as const;
const MIN_GROUND_SCOUT_WINDOW = 0.75; // Matches the native level, advance-and-stop admission bound.

export interface MacroTravelAnchor {
  readonly subject: string;
  readonly target: string;
}

/** A visible goal and its current physical approach evidence, never material authority. */
export type MacroTravelHint = MacroTravelAnchor & {
  readonly kind: "resource" | "cave_frontier" | "woodland_frontier";
  readonly bearingDegrees: number;
} & (
  | { readonly footing: "dry" | "shallow_water_with_bank"; readonly windowBlocks: number }
  | { readonly footing: "one_block_grade"; readonly heightChange: -1 | 1 }
);

export interface MacroObservation extends MacroBasis {
  readonly v: 1;
  readonly goal: string;
  readonly health: number;
  readonly food: number;
  readonly inventory: Readonly<Record<string, number>>;
  readonly opportunities: readonly MacroOpportunity[];
  readonly recent: readonly string[];
  readonly quiescent: boolean;
  /** Native stance generation; camera turns and inventory changes do not advance it. */
  readonly stance?: number;
  readonly safety?: { readonly clear: boolean; readonly revision: number };
  /** A matching accepted break had actual vanilla crack progress this tick. */
  readonly working?: { readonly intentId: string; readonly crack: number };
  /** Native job disposition, not evidence that movement or another effect advanced. */
  readonly workOrder?: MacroWorkState;
  /** A process in the world, not inventory, a completed effect or a permission. */
  readonly pendingWork?: MacroPendingWork;
  /** A reachable dry natural wall contact, not a selectable opportunity or a proved passage. */
  readonly prospectOpening?: {
    readonly block: (typeof prospectRock)[number];
    readonly target: string;
    readonly tool: string;
    readonly maxToolLoss: 0 | 1;
  };
  /** One witnessed dry cap beside the stance. It proves no buried stock, descent, or opportunity. */
  readonly surfaceOpening?: {
    readonly block: (typeof surfaceCaps)[number];
    readonly target: string;
    readonly tool: string;
    readonly maxToolLoss: 0 | 1;
  };
  /** One reachable leaf in the way of an earlier physical approach; not stock, a route or an opportunity ID. */
  readonly timberObstruction?: {
    readonly block: string;
    readonly target: string;
    readonly toward: MacroTravelAnchor;
    readonly timber: string;
  };
  readonly travelHint?: MacroTravelHint;
}

export interface MacroIntent {
  readonly v: 1;
  readonly id: string;
  readonly run: string;
  readonly life: number;
  readonly epoch: number;
  readonly basisTick: number;
  readonly expiresTick: number;
  readonly opportunityId: string;
  readonly skillHash: string | null;
}

export type MacroHandoff = Pick<MacroIntent, "v" | "run" | "life" | "epoch" | "basisTick" | "expiresTick">;

/** Host-owned notice; grants no authority to act, pause safety, or renew native idle time. */
export type MacroPlanning = Pick<MacroIntent, "v" | "run" | "life" | "epoch" | "basisTick" | "id">;

export interface MacroReceipt {
  readonly v: 1;
  readonly id: string;
  readonly run: string;
  readonly life: number;
  readonly tick: number;
  readonly status: "accepted" | "completed" | "refused" | "interrupted";
  readonly detail: string;
}

export type MacroParkedReceipt = Omit<MacroReceipt, "status"> & { readonly status: "parked" };
type NativeMacroReceipt = MacroReceipt | MacroParkedReceipt;

export interface MacroSkillReceipt {
  readonly tick: number;
  readonly verb: string;
  readonly status: "completed";
  readonly detail: string;
}

export interface MacroSkillCandidate {
  readonly source: string;
  readonly parentGeneration: number;
  readonly verbs: readonly string[];
}

const NATIVE_REVIEW_PACKAGE = "java/io/gameharness/survival";
const NATIVE_REVIEW_CLIENT = `survival-agent/src/client/${NATIVE_REVIEW_PACKAGE}`;
export const NATIVE_REVIEW_PUBLIC_PATHS = [
  `${NATIVE_REVIEW_CLIENT}/AgentCraftClick.java`,
  `${NATIVE_REVIEW_CLIENT}/mixin/AgentHandledScreenAccess.java`,
  `${NATIVE_REVIEW_CLIENT}/mixin/AgentMouseAccess.java`,
] as const;
export const NATIVE_REVIEW_NEW_SOURCE = `${NATIVE_REVIEW_CLIENT}/AgentCapabilityProposal.java`;
export const NATIVE_REVIEW_TEST_PATH = `survival-agent/src/test/${NATIVE_REVIEW_PACKAGE}/AgentCapabilityProposalTest.java`;
export const NATIVE_REVIEW_PATHS = [...NATIVE_REVIEW_PUBLIC_PATHS, NATIVE_REVIEW_NEW_SOURCE, NATIVE_REVIEW_TEST_PATH] as const;
export const NATIVE_REVIEW_MAX_FILE_BYTES = 8 * 1024;
export const NATIVE_REVIEW_MAX_BYTES = 10 * 1024;

export interface MacroReviewPatch {
  readonly baseVersion: string;
  readonly baseSha256: string;
  readonly scope: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

export interface MacroReviewContext {
  readonly baseVersion: string;
  readonly baseSha256: string;
  readonly source: readonly { readonly path: string; readonly sha256: string; readonly content: string }[];
  readonly newSourcePath: string;
  readonly testPath: string;
}

export type MacroStockFloor = { readonly item: string; readonly count: number };

export interface MacroPendingWork {
  readonly id: string;
  readonly kind: "iron-smelting";
  readonly goal: string;
  readonly invested: readonly MacroStockFloor[];
  readonly output: MacroStockFloor;
  readonly location: string;
  readonly state: "estimated" | "unknown" | "collectible" | "blocked";
  readonly remainingTicks?: number;
  readonly yieldable: boolean;
  readonly parked: boolean;
  readonly collectOfferId?: string;
  readonly deferOfferId?: string;
  readonly historical?: true;
  /** A currently supported connection, not permission to recall while another job owns input. */
  readonly returnClue?: "local_face" | "walked_route";
  /** Remembered restrictions, never remembered inventory or authority. */
  readonly protectedReserves?: readonly MacroStockFloor[];
  /** Present only on a settled, current world view after the parked controls are released. */
  readonly worksite?: { readonly routes: string };
}

export type MacroWorkMode = "preset" | "constrained";
export type MacroWorkTarget =
  | { readonly kind: "stock"; readonly item: string; readonly count: number }
  | { readonly kind: "preset"; readonly goal: SurvivalAgentGoal };
export interface MacroWorkPolicy {
  readonly target: MacroWorkTarget;
  readonly allowedEffects: readonly string[];
  readonly costCaps: readonly MacroStockFloor[];
  readonly reserves: readonly MacroStockFloor[];
  readonly maxBreaks: number;
  /** Recipe executions plus smelted units; a pending furnace batch uses this budget before collection. */
  readonly maxCrafts: number;
  readonly maxPlacements: number;
}
export interface MacroWorkOrder extends MacroWorkPolicy {
  readonly v: 1;
  readonly id: string;
  readonly run: string;
  readonly life: number;
  readonly epoch: number;
  readonly basisTick: number;
  readonly expiresTick: number;
  readonly safetyRevision: number;
  readonly origin: "preset" | "model";
  /** May retain a clean personal screen for this exact, not-yet-admitted program stage. */
  readonly nextWorkId?: string;
  /** Separately metered ordinary work while this paid ticket remains outstanding. */
  readonly duringWaitFor?: string;
  /** Host-bound starting approach only. Never a selectable ID or a grant to harvest. */
  readonly travelAnchor?: MacroTravelAnchor;
  /** First harvest is bound to this exact in-reach material, not a route or a new break permission. */
  readonly harvestAnchor?: MacroTravelAnchor;
  /** First surface cut is bound to this exact cap, not to a guessed source or neighboring tile. */
  readonly surfaceAnchor?: MacroTravelAnchor;
}
export interface MacroWorkState {
  readonly id: string;
  readonly state: "working" | "needs_replan" | "blocked" | "parked" | "complete";
  readonly detail: string;
  /** Observed operation and confirmed counters, not a claim of useful play each tick. */
  readonly progress?: {
    readonly phase: "route" | "harvest" | "collect" | "craft" | "smelt" | "fill" | "equip" | "place" | "search" | "hold" | "complete";
    readonly status: string;
    readonly target?: { readonly item: string; readonly count: number; readonly required: number };
    readonly breaks: number;
    readonly crafts: number;
    readonly placements: number;
    readonly lastEffect?: { readonly tick: number; readonly detail: string };
    readonly replan?: "target_near" | "cap_near" | "expiry_near";
    /** Paid inputs settled and the exact vanilla furnace showed a rising cook bar. Not inventory. */
    readonly smeltBurn?: { readonly burnTick: number; readonly units: number; readonly remainingCookTicks: number };
  };
}
export interface MacroWorkStage {
  readonly policy: MacroWorkPolicy;
  readonly requires: readonly MacroStockFloor[];
}
export interface MacroWorkDemand {
  readonly mode: MacroWorkMode;
  readonly demand: "first" | "renew" | "successor" | "blocked" | "outcome" | "changed";
  readonly protectedReserves: readonly MacroStockFloor[];
  readonly current: {
    readonly id: string;
    readonly origin: MacroWorkOrder["origin"];
    readonly expiresTick: number;
    readonly policy: MacroWorkPolicy;
    readonly accepted: MacroReceipt | null;
    readonly nativeState: MacroWorkState | null;
  } | null;
  /** Time-only authority for this accepted ordinary job, offered only on a renew demand. */
  readonly renewal?: { readonly workOrderId: string };
  /** The one native ticket this decision may use for independent work. */
  readonly duringWaitFor?: string;
  /** A parked decision uses fresh local facts, or explicitly reports a bounded view wait. */
  readonly parkedWorksite?: "settled" | "view-unavailable";
  /** Accepted production dependency, not spendable stock. Absent for historical tickets. */
  readonly pendingPredecessor?: { readonly id: string; readonly queuedTarget?: MacroWorkTarget };
  /** Available camera-only openings for a single ordinary work policy. */
  readonly openingViewIds?: readonly string[];
  /** The original model's stated reason, not evidence or a dependent authorization. */
  readonly pendingPurpose?: { readonly id: string; readonly subgoal: string; readonly reason: string };
  readonly lastOutcome: {
    readonly id: string;
    readonly policy: MacroWorkPolicy;
    readonly receipt: MacroReceipt;
    readonly nativeState: MacroWorkState | null;
  } | null;
}

export interface MacroSuccessor {
  readonly kind: "successor";
  readonly afterIntentId: string;
  readonly opportunityId: string;
  readonly requires: readonly MacroStockFloor[];
  readonly reserves: readonly MacroStockFloor[];
}

export interface MacroLookahead {
  readonly predecessor: { readonly intentId: string; readonly acceptedTick: number; readonly verb: string; readonly summary: string };
  readonly witnessBasis: MacroBasis;
  readonly candidates: readonly MacroOpportunity[];
  readonly reserves: readonly MacroStockFloor[];
}

export interface MacroDirectAction {
  readonly kind: "continuation";
  readonly opportunityId: string;
  readonly steps: readonly {
    readonly selector: { readonly verb: string; readonly subject: string };
    readonly maxEffects: number;
    readonly until: MacroStockFloor | null;
  }[];
  readonly reserves: readonly MacroStockFloor[];
}

export interface MacroProposal {
  readonly subgoal: string;
  readonly reason: string;
  readonly successCondition: string;
  readonly contingency: string;
  readonly alternative: string;
  readonly expiresTick: number;
  readonly action:
    | { readonly kind: "opportunity"; readonly opportunityId: string }
    | MacroDirectAction
    | MacroSuccessor
    | { readonly kind: "work"; readonly policy: MacroWorkPolicy; readonly openingViewId?: string;
        readonly afterWorkId?: string; readonly duringWaitFor?: string;
        readonly duringWait?: { readonly policy: MacroWorkPolicy; readonly maxTicks: number } }
    | { readonly kind: "work-program"; readonly stages: readonly MacroWorkStage[]; readonly afterWorkId?: string }
    | { readonly kind: "renew-work"; readonly workOrderId: string }
    | { readonly kind: "revoke-work"; readonly workOrderId: string }
    | { readonly kind: "collect-pending" | "defer-pending"; readonly pendingWorkId: string }
    | { readonly kind: "skill"; readonly candidate: MacroSkillCandidate }
    | { readonly kind: "tested-skill"; readonly skillHash: string }
    | { readonly kind: "selected-skill" }
    | { readonly kind: "gap"; readonly capability: string; readonly suggestion?: string; readonly reviewPatch?: MacroReviewPatch }
    | { readonly kind: "abstain" };
}

export interface MacroFrame {
  readonly source: "verified-game-display";
  readonly run: string;
  readonly life: number;
  readonly epoch: number;
  readonly tick: number;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Private supervisor custody. Removed before the frame is sent to a strategist. */
  readonly artifact?: {
    readonly relativePath: string;
    readonly sha256: string;
    readonly discard?: () => Promise<void>;
  };
}

export type MacroTrigger = "first" | "premise" | "progress" | "receipt" | "risk" | "stuck";

export interface MacroFeedback {
  readonly kind: string;
  readonly detail: string;
}

export const MACRO_NOT_ISSUED_DISPOSITIONS = [
  "stale", "native_capability_gap", "proposal_refused", "duplicate_intent_refused",
  "skill_rejected", "skill_abstained", "skill_unavailable", "skill_promotion_refused", "unproven_skill_effect_refused",
] as const;

export type MacroEpisodeOutcome =
  | { readonly source: "native"; readonly status: Exclude<MacroReceipt["status"], "accepted">;
    readonly id: string; readonly tick: number; readonly verb: string; readonly summary: string; readonly detail: string }
  | { readonly source: "host"; readonly status: "not-issued"; readonly disposition: typeof MACRO_NOT_ISSUED_DISPOSITIONS[number] }
  | { readonly source: "host"; readonly status: "withdrawn"; readonly id: string; readonly tick: number;
    readonly verb: string; readonly summary: string };

export interface MacroStrategicEpisode {
  /** Original model decision; native outcome IDs refer to individual intents, not opportunity IDs. */
  readonly requestId: string;
  readonly basis: MacroBasis;
  readonly hypothesis: { readonly subgoal: string; readonly expected: string };
  /** The terminal native receipt establishes only the primitive's report. */
  readonly objectiveStatus: "not-evaluated";
  readonly outcome: MacroEpisodeOutcome;
}

export interface MacroRequest {
  readonly observation: MacroObservation;
  readonly objective?: string;
  readonly trigger: MacroTrigger;
  readonly lastReceipt: MacroReceipt | null;
  readonly lookahead?: MacroLookahead;
  readonly work?: MacroWorkDemand;
  readonly feedback?: MacroFeedback;
  /** Same-life, same-goal history; newest first, at most MACRO_MAX_STRATEGIC_EPISODES. Never actionable. */
  readonly strategicEpisodes?: readonly MacroStrategicEpisode[];
  readonly capabilitiesVersion: string;
  readonly skillGeneration: number | null;
  readonly skillVerbs?: readonly string[];
  readonly selectedSkillHash?: string;
  readonly testedSkills?: readonly { readonly hash: string; readonly verb: string }[];
  readonly nativeReview?: MacroReviewContext;
  readonly maxSkillEffects?: number;
  readonly maxResponseBytes: number;
  readonly maxIntentTtlTicks: number;
  readonly maxPlanTtlTicks: number;
  readonly frame?: MacroFrame;
}

export interface MacroUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

const replyRejections = {
  required_tool: "Return exactly one call to the supplied proposal tool.",
  missing_arguments: "The proposal tool call had no complete arguments.",
  argument_bytes: "The proposal tool arguments exceed maxResponseBytes. Shorten the proposal.",
  argument_json: "The proposal tool arguments must be a complete JSON object.",
  schema: "The proposal does not match the supplied tool schema.",
  expiry: "Use an absolute expiresTick after basis.tick and within this action's TTL limit.",
  successor: "A conditional successor must name the offered predecessor and a candidate from this lookahead.",
  work_unavailable: "A work policy requires an offered work context.",
  wrong_work_id: "Use the exact applicable work ID from this request; a successor needs a matching accepted job.",
  renewal_expiry: "Set expiresTick after the current work expiry and within maxIntentTtlTicks of basis.tick.",
  wrong_preset_goal: "A preset work target must equal the live invocation goal.",
  active_work: "An active job admits work policies, a scoped revoke, a genuine gap, or abstention; not a primitive or skill.",
  missing_opportunity: "Select an exact opportunityId offered in the current observation.",
  opening_view: "Use an offered openingViewId only for a camera check relevant to the quoted physical job; otherwise use ordinary work without it.",
  guarded_opportunity: "Constrained work mode does not admit guarded primitives. Use a bounded work policy with explicit costs and reserves for supported effects.",
  continuation: "A continuation needs direct authority and currently witnessed material selectors. Constrained mode does not admit continuations.",
  candidate: "A skill candidate must use the offered skillGeneration and only admitted skillVerbs.",
  selected_skill: "A selected-skill proposal requires selectedSkillHash in the request.",
  tested_skill: "Use an offered testedSkills hash with a matching current read or low-risk opportunity.",
  review_patch: "A review patch requires nativeReview context. Report a genuine gap without a patch if that context is missing.",
} as const;

export class MacroValidationError extends Error {
  constructor(field: string) { super(`Invalid survival macro field: ${field}.`); }
}

export type MacroReplyRejection = keyof typeof replyRejections | MacroValidationError;

export function macroReplyRejectionDetail(rejection: MacroReplyRejection): string {
  return rejection instanceof MacroValidationError ? rejection.message : replyRejections[rejection];
}

export interface MacroInference {
  readonly proposal: unknown;
  readonly model: string;
  readonly basis: MacroBasis;
  readonly usage: MacroUsage | null;
  readonly costUsd: number | null;
  readonly outcome: "completed" | "refused" | "invalid" | "cancelled" | "provider_error" | "provider_unavailable" | "stale";
  readonly latencyMs?: number;
  readonly frameSha256?: string;
  readonly dispatched?: boolean;
  readonly providerStartedAtMs?: number;
  /** Host validation only, and set only for a transport-completed invalid reply. */
  readonly invalidReply?: MacroReplyRejection;
  /** The dispatch preflight could not sample the observation. No provider request was sent. */
  readonly observationRotating?: true;
}

export type MacroStrategist = (request: MacroRequest, signal: AbortSignal) => Promise<MacroInference>;

function invalid(field: string): never {
  throw new MacroValidationError(field);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function shape(value: unknown, field: string, required: readonly string[], optional: readonly string[] = []) {
  const record = object(value, field);
  if (required.some(key => !Object.hasOwn(record, key)) ||
      Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) invalid(field);
  return record;
}

function whole(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
}

function finite(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) invalid(field);
  return value;
}

function itemKey(value: unknown, field: string): string {
  if (typeof value !== "string" || !itemPattern.test(value) ||
      value === "__proto__" || value === "constructor" || value === "prototype") invalid(field);
  return value;
}

function stockFloors(value: unknown, field: string, work = false): readonly MacroStockFloor[] {
  const floors = bounds(value, field, work ? 32 : 8).map(value => {
    const raw = shape(value, "inventory floor", ["item", "count"]);
    return Object.freeze({
      item: work ? vanillaItem(raw.item, "floor item") : itemKey(raw.item, "floor item"),
      count: whole(raw.count, "floor count", 1, work ? 2_304 : 65_535),
    });
  });
  if (new Set(floors.map(floor => floor.item)).size !== floors.length) invalid(field);
  return Object.freeze(floors);
}

function vanillaItem(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^minecraft:[a-z0-9_]{1,96}$/.test(value) || value === "minecraft:air") invalid(field);
  return value;
}

const WORK_POLICY_KEYS = ["target", "allowedEffects", "costCaps", "reserves", "maxBreaks", "maxCrafts", "maxPlacements"] as const;
const WORK_LIMITS = { maxBreaks: 64, maxCrafts: 64, maxPlacements: 8 } as const;

export function parseMacroWorkPolicy(value: unknown): MacroWorkPolicy {
  return workPolicy(shape(value, "work policy", WORK_POLICY_KEYS));
}

function workPolicy(raw: Record<string, unknown>): MacroWorkPolicy {
  const target = object(raw.target, "work target");
  const kind = choice(target.kind, "work target kind", ["stock", "preset"] as const);
  const parsedTarget: MacroWorkTarget = kind === "stock"
    ? { kind, item: vanillaItem(shape(target, "stock target", ["kind", "item", "count"]).item, "target item"),
      count: whole(target.count, "target count", 1, 2_304) }
    : { kind, goal: choice(shape(target, "preset target", ["kind", "goal"]).goal, "preset goal", SURVIVAL_AGENT_GOALS) };
  const effects = bounds(raw.allowedEffects, "work effects", 64).map(effect => {
    if (typeof effect !== "string" || effect.trim() !== effect) invalid("work effect");
    if (!liveEffects.has(effect) && !craftEffect.test(effect)) {
      if (effect.startsWith("break:")) {
        const named = /^break:minecraft:[a-z0-9_]{1,96}$/.test(effect) ? ` ${effect}` : "";
        invalid(`allowedEffects (unsupported break effect${named}; choose an exact break from the tool schema)`);
      }
      invalid("work effect");
    }
    return effect;
  });
  if (new Set(effects).size !== effects.length) invalid("duplicate work effects");
  const byItem = (left: MacroStockFloor, right: MacroStockFloor) => left.item.localeCompare(right.item);
  const policy = {
    target: Object.freeze(parsedTarget), allowedEffects: Object.freeze(effects.sort()),
    costCaps: Object.freeze([...stockFloors(raw.costCaps, "work cost caps", true)].sort(byItem)),
    reserves: Object.freeze([...stockFloors(raw.reserves, "work reserves", true)].sort(byItem)),
    maxBreaks: whole(raw.maxBreaks, "work break cap", 0, WORK_LIMITS.maxBreaks),
    maxCrafts: whole(raw.maxCrafts, "work craft cap", 0, WORK_LIMITS.maxCrafts),
    maxPlacements: whole(raw.maxPlacements, "work placement cap", 0, WORK_LIMITS.maxPlacements),
  };
  const smelting = effects.includes(MACRO_IRON_SMELT);
  const placingFurnace = effects.includes(MACRO_FURNACE_PLACEMENT);
  const prospecting = effects.includes(MACRO_DIAMOND_PROSPECT);
  if (smelting && (parsedTarget.kind !== "stock" || parsedTarget.item !== "minecraft:iron_ingot" ||
      !policy.maxCrafts || !policy.costCaps.some(({ item }) => item === "minecraft:raw_iron") ||
      !policy.costCaps.some(({ item }) => MACRO_IRON_FUEL_TICKS.has(item)))) invalid("iron smelt scope or costs");
  if (placingFurnace && (!smelting || !policy.maxPlacements ||
      !policy.costCaps.some(({ item }) => item === "minecraft:furnace"))) invalid("furnace placement scope or cost");
  if (prospecting && (parsedTarget.kind !== "stock" || parsedTarget.item !== "minecraft:diamond" ||
      !policy.maxBreaks || !effects.some(effect => effect === "break:minecraft:diamond_ore" ||
        effect === "break:minecraft:deepslate_diamond_ore"))) invalid("diamond prospect scope");
  if (effects.includes(MACRO_PROSPECT_TORCH) && (!prospecting || !policy.maxPlacements ||
      !policy.costCaps.some(({ item }) => item === "minecraft:torch"))) invalid("prospect torch scope or cost");
  if (effects.includes(MACRO_PROSPECT_SUPPORT) && (!prospecting || !policy.maxPlacements ||
      !policy.costCaps.some(({ item }) => item === "minecraft:cobblestone"))) invalid("prospect support scope or cost");
  if (effects.includes(MACRO_WATER_FILL) && (effects.length !== 1 || parsedTarget.kind !== "stock" ||
      parsedTarget.item !== "minecraft:water_bucket" || parsedTarget.count !== 1 ||
      policy.maxBreaks || policy.maxCrafts || policy.maxPlacements || policy.costCaps.length !== 1 ||
      policy.costCaps[0]!.item !== "minecraft:bucket" || policy.costCaps[0]!.count !== 1)) invalid("water fill scope or cost");
  if (effects.some(effect => effect.startsWith(foodEffectPrefix)) &&
      (effects.length !== 1 || parsedTarget.kind !== "stock" ||
        parsedTarget.item !== foodSources.get(effects[0]!.slice(foodEffectPrefix.length)) ||
        policy.maxBreaks || policy.maxCrafts || policy.maxPlacements || policy.costCaps.length))
    invalid("food forage scope or cost");
  return Object.freeze(policy);
}

export function isFoodWork(policy: MacroWorkPolicy): boolean {
  return policy.allowedEffects.some(effect => effect.startsWith(foodEffectPrefix));
}

export function foodWorkWitness(observation: MacroObservation, policy: MacroWorkPolicy): MacroOpportunity | undefined {
  if (!isFoodWork(policy) || policy.target.kind !== "stock" || !observation.safety?.clear || observation.pendingWork ||
      (observation.inventory[policy.target.item] ?? 0) >= policy.target.count ||
      policy.reserves.some(({ item, count }) => (observation.inventory[item] ?? 0) < count)) return;
  return observation.opportunities.find(offer => offer.verb === MACRO_FOOD_CLUE && offer.risk === "read" &&
    offer.material && policy.allowedEffects[0] === `${foodEffectPrefix}${offer.material.subject}`);
}

function singleLiveWork(policy: MacroWorkPolicy) {
  return policy.allowedEffects.includes(MACRO_IRON_SMELT) || policy.allowedEffects.includes(MACRO_DIAMOND_PROSPECT) ||
    policy.allowedEffects.includes(MACRO_WATER_FILL) || isFoodWork(policy);
}

function pendingSidePolicy(policy: MacroWorkPolicy): MacroWorkPolicy {
  pendingOrdinaryPolicy(policy);
  const { target, maxBreaks, maxCrafts, maxPlacements, allowedEffects } = policy;
  if (target.kind !== "stock" || maxPlacements || maxBreaks + maxCrafts < 1 ||
      maxBreaks + maxCrafts > MACRO_PENDING_SIDE_MAX_EFFECTS || !allowedEffects.length ||
      !allowedEffects.every(effect => (maxBreaks > 0 && effect.startsWith("break:")) ||
        (maxCrafts > 0 && effect.startsWith("craft:"))))
    invalid("finite local pending side policy");
  return policy;
}

export function isIndependentPendingPolicy(policy: MacroWorkPolicy): boolean {
  return policy.target.kind === "stock" && policy.target.item !== "minecraft:iron_ingot" &&
    !policy.allowedEffects.includes(MACRO_IRON_SMELT) && !isFoodWork(policy);
}

function pendingOrdinaryPolicy(policy: MacroWorkPolicy): MacroWorkPolicy {
  if (!isIndependentPendingPolicy(policy)) invalid("independent pending work policy");
  return policy;
}

export function parseMacroWorkStages(value: unknown): readonly MacroWorkStage[] {
  const totals = { maxBreaks: 0, maxCrafts: 0, maxPlacements: 0 };
  const totalCosts = new Map<string, number>();
  const reserves = new Map<string, number>();
  const targets = new Set<string>();
  const stages = bounds(value, "work program stages", MACRO_MAX_WORK_STAGES).map(value => {
    const raw = shape(value, "work stage", ["policy", "requires"]);
    const policy = parseMacroWorkPolicy(raw.policy);
    if (singleLiveWork(policy)) invalid("this effect requires a single live work policy");
    const target = JSON.stringify(policy.target);
    if (targets.has(target)) invalid("duplicate work program target");
    targets.add(target);
    for (const key of ["maxBreaks", "maxCrafts", "maxPlacements"] as const) {
      if ((totals[key] += policy[key]) > WORK_LIMITS[key]) invalid("work program effect caps");
    }
    for (const { item, count } of policy.costCaps) {
      const total = (totalCosts.get(item) ?? 0) + count;
      if (total > 2_304) invalid("work program item cost cap");
      totalCosts.set(item, total);
    }
    for (const [item, count] of reserves) {
      if (!policy.reserves.some(floor => floor.item === item && floor.count >= count)) invalid("work program reserves regressed");
    }
    for (const floor of policy.reserves) reserves.set(floor.item, floor.count);
    return Object.freeze({ policy, requires: stockFloors(raw.requires, "work stage requires", true) });
  });
  if (stages.length < 2) invalid("work program needs multiple stages");
  return Object.freeze(stages);
}

function parseWorkProgress(value: unknown, tick: number): NonNullable<MacroWorkState["progress"]> {
  const raw = shape(value, "native work progress", ["phase", "status", "breaks", "crafts", "placements"],
    ["target", "lastEffect", "replan", "smeltBurn"]);
  const target = raw.target === undefined ? undefined : shape(raw.target, "native work stock", ["item", "count", "required"]);
  const last = raw.lastEffect === undefined ? undefined : shape(raw.lastEffect, "native last work effect", ["tick", "detail"]);
  const burn = raw.smeltBurn === undefined ? undefined : shape(raw.smeltBurn, "native furnace burn", ["burnTick", "units", "remainingCookTicks"]);
  if (burn && raw.phase !== "smelt") invalid("native furnace burn requires smelt progress");
  const units = burn ? whole(burn.units, "native furnace batch size", 1, WORK_LIMITS.maxCrafts) : 0;
  return Object.freeze({
    phase: choice(raw.phase, "work progress phase", ["route", "harvest", "collect", "craft", "smelt", "fill", "equip", "place", "search", "hold", "complete"] as const),
    status: text(raw.status, "work progress status", 1_024),
    breaks: whole(raw.breaks, "confirmed work breaks", 0, WORK_LIMITS.maxBreaks),
    crafts: whole(raw.crafts, "confirmed work crafts", 0, WORK_LIMITS.maxCrafts),
    placements: whole(raw.placements, "confirmed work placements", 0, WORK_LIMITS.maxPlacements),
    ...(target ? { target: Object.freeze({
      item: vanillaItem(target.item, "native stock item"),
      count: whole(target.count, "observed stock count", 0, 65_535),
      required: whole(target.required, "native work target", 1, 2_304),
    }) } : {}),
    ...(last ? { lastEffect: Object.freeze({
      tick: whole(last.tick, "native last work effect tick", 1, tick),
      detail: text(last.detail, "native last work effect detail", 1_024),
    }) } : {}),
    ...(raw.replan !== undefined ? { replan: choice(raw.replan, "native replanning reason", ["target_near", "cap_near", "expiry_near"] as const) } : {}),
    ...(burn ? { smeltBurn: Object.freeze({
      burnTick: whole(burn.burnTick, "native furnace cook edge tick", 1, tick),
      units,
      remainingCookTicks: whole(burn.remainingCookTicks, "native remaining cook ticks", 0, units * 200),
    }) } : {}),
  });
}

export function parseMacroWorkOrder(value: unknown): MacroWorkOrder {
  const record = shape(value, "work order", [
    "v", "id", "run", "life", "epoch", "basisTick", "expiresTick", "safetyRevision", "origin", ...WORK_POLICY_KEYS,
  ], ["nextWorkId", "duringWaitFor", "travelAnchor", "harvestAnchor", "surfaceAnchor"]);
  const id = validateMacroId(record.id, "work id");
  const origin = choice(record.origin, "work origin", ["preset", "model"] as const);
  const policy = workPolicy(record);
  if (origin === "preset" && (policy.target.kind !== "preset" || policy.allowedEffects.length || policy.costCaps.length ||
      policy.maxBreaks > 32 || policy.maxCrafts > 24 || policy.maxPlacements > 2)) invalid("preset work scope");
  const nextWorkId = Object.hasOwn(record, "nextWorkId") ? validateMacroId(record.nextWorkId, "next work id") : undefined;
  const duringWaitFor = Object.hasOwn(record, "duringWaitFor") ? validateMacroId(record.duringWaitFor, "pending ticket id") : undefined;
  let travelAnchor: MacroTravelAnchor | undefined;
  if (Object.hasOwn(record, "travelAnchor")) {
    const raw = shape(record.travelAnchor, "work travel anchor", ["subject", "target"]);
    const anchor = parseStartAnchor(raw, "travel anchor");
    if (origin !== "model" || duringWaitFor || !travelKinds.some(kind =>
      travelSubjectMatchesPolicy(kind, anchor.subject, policy))) invalid("work travel anchor scope");
    travelAnchor = anchor;
  }
  let harvestAnchor: MacroTravelAnchor | undefined;
  if (Object.hasOwn(record, "harvestAnchor")) {
    const raw = shape(record.harvestAnchor, "work harvest anchor", ["subject", "target"]);
    harvestAnchor = parseStartAnchor(raw, "harvest anchor");
    if (origin !== "model" || duringWaitFor || nextWorkId || /:[123]$/.test(id) || travelAnchor ||
        !harvestAnchorMatchesPolicy(harvestAnchor, policy))
      invalid("work harvest anchor scope");
  }
  let surfaceAnchor: MacroTravelAnchor | undefined;
  if (Object.hasOwn(record, "surfaceAnchor")) {
    const raw = shape(record.surfaceAnchor, "work surface anchor", ["subject", "target"]);
    surfaceAnchor = parseStartAnchor(raw, "surface anchor");
    if (origin !== "model" || duringWaitFor || nextWorkId || /:[123]$/.test(id) || travelAnchor || harvestAnchor ||
        !surfaceTargetPattern.test(surfaceAnchor.target) || !surfaceAnchorMatchesPolicy(surfaceAnchor, policy))
      invalid("work surface anchor scope");
  }
  if (duringWaitFor) {
    if (origin !== "model" || nextWorkId || duringWaitFor === id || /:[123]$/.test(id)) invalid("pending ordinary order scope");
    pendingOrdinaryPolicy(policy);
  }
  if (singleLiveWork(policy) && (nextWorkId || /:[123]$/.test(id)))
    invalid("this effect requires a single live work order");
  if (nextWorkId) {
    const stage = /^(.+):([12])$/.exec(id);
    if (origin !== "model" || !stage || nextWorkId !== `${stage[1]}:${Number(stage[2]) + 1}`) invalid("work successor scope");
  }
  const basisTick = whole(record.basisTick, "work basis tick", 1, Number.MAX_SAFE_INTEGER - MACRO_MAX_INTENT_TTL_TICKS);
  return Object.freeze({
    v: version(record.v), id, run: validateMacroId(record.run, "run"),
    life: whole(record.life, "life", 1, 2_147_483_647), epoch: whole(record.epoch, "epoch", 1), basisTick,
    expiresTick: whole(record.expiresTick, "work expiry", basisTick + 1, basisTick + MACRO_MAX_INTENT_TTL_TICKS),
    safetyRevision: whole(record.safetyRevision, "work safety revision", 1), origin,
    ...(nextWorkId ? { nextWorkId } : {}), ...(duringWaitFor ? { duringWaitFor } : {}),
    ...(travelAnchor ? { travelAnchor } : {}), ...(harvestAnchor ? { harvestAnchor } : {}),
    ...(surfaceAnchor ? { surfaceAnchor } : {}), ...policy,
  });
}

function text(value: unknown, field: string, max: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max ||
      (multiline ? /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/ : /[\x00-\x1F\x7F]/).test(value)) invalid(field);
  return value;
}

export function validateMacroId(value: unknown, field: string): string {
  if (typeof value !== "string" || !idPattern.test(value) || value === "." || value === "..") invalid(field);
  return value;
}

function version(value: unknown): 1 {
  if (value !== 1) invalid("v");
  return 1;
}

function choice<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid(field);
  return value as T;
}

function bounds(value: unknown, field: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  return value;
}

function basis(record: Record<string, unknown>): MacroBasis {
  return {
    run: validateMacroId(record.run, "run"), life: whole(record.life, "life", 1, 2_147_483_647),
    tick: whole(record.tick, "tick", 1), epoch: whole(record.epoch, "epoch", 1),
  };
}

function directMaterialPrefix(verb: string): string | undefined {
  switch (verb) {
    case "break": return "block:";
    case "collect": return "item:";
    case "continue": return "recipe:";
  }
}

const woodlandAnchorSubject = "landmark:woodland";
const travelKinds = ["resource", "cave_frontier", "woodland_frontier"] as const;
const surfaceTargetPattern = /^m-[1-9][0-9]*$/;

function parseStartAnchor(record: Record<string, unknown>, field: string): MacroTravelAnchor {
  const subject = record.subject;
  if (typeof subject !== "string" || subject !== woodlandAnchorSubject && !/^block:minecraft:[a-z0-9_]{1,96}$/.test(subject))
    invalid(`${field} subject`);
  return Object.freeze({ subject, target: validateMacroId(record.target, `${field} target`) });
}

export function parseMacroObservation(value: unknown): MacroObservation {
  const record = shape(value, "observation", [
    "v", "run", "life", "tick", "epoch", "goal", "health", "food", "inventory", "opportunities", "recent", "quiescent",
  ], ["safety", "working", "workOrder", "pendingWork", "stance", "prospectOpening", "surfaceOpening", "timberObstruction", "travelHint"]);
  const inventory = Object.create(null) as Record<string, number>;
  const entries = Object.entries(object(record.inventory, "inventory"));
  if (entries.length > 128) invalid("inventory");
  for (const [item, count] of entries) {
    inventory[itemKey(item, "inventory item")] = whole(count, "inventory count", 0, 65_535);
  }
  const ids = new Set<string>();
  const opportunities = bounds(record.opportunities, "opportunities", 64).map(value => {
    const offer = shape(value, "opportunity", ["id", "verb", "summary", "risk", "evidence"], ["material", "anchor"]);
    const id = validateMacroId(offer.id, "opportunity id");
    if (ids.has(id)) invalid("duplicate opportunity id");
    ids.add(id);
    const verb = validateMacroId(offer.verb, "verb");
    const risk = choice(offer.risk, "risk", ["read", "low", "guarded"] as const);
    const waterClue = verb === MACRO_WATER_CLUE;
    const foodClue = verb === MACRO_FOOD_CLUE;
    if (waterClue && risk !== "read") invalid("water clue risk");
    if (foodClue && (risk !== "read" || !Object.hasOwn(offer, "material"))) invalid("food clue risk or material");
    let anchor: MacroOpportunity["anchor"];
    if (Object.hasOwn(offer, "anchor")) {
      const raw = shape(offer.anchor, "rendered anchor", ["subject", "target"]);
      const subject = itemKey(raw.subject, "rendered anchor subject");
      const valid = verb === "inspect" && risk === "read" || verb === "survey" && risk === "read"
        ? subject.startsWith("block:minecraft:")
        : verb === "approach" && risk === "low"
          ? subject === "route:dry" || subject === "route:dry_landing" ||
            subject === woodlandAnchorSubject || subject.startsWith("block:minecraft:")
          : (verb === "survey" || verb === "follow") && risk === "guarded" && subject === "route:dry";
      if (!valid) invalid("rendered anchor subject/verb");
      anchor = Object.freeze({ subject, target: validateMacroId(raw.target, "rendered anchor target") });
    }
    let material: MacroOpportunity["material"];
    if (Object.hasOwn(offer, "material")) {
      const prefix = directMaterialPrefix(verb);
      const raw = shape(offer.material, "material", ["subject", "target", "spends"]);
      const subject = itemKey(raw.subject, "material subject");
      const costs = Object.entries(object(raw.spends, "material spends"));
      if (foodClue && (!foodSources.has(subject) || costs.length !== 0 || typeof raw.target !== "string" ||
          !surfaceTargetPattern.test(raw.target))) invalid("food clue material");
      if (!foodClue && (waterClue ? subject !== MACRO_WATER_SOURCE || costs.length !== 1 ||
          costs[0]![0] !== "minecraft:bucket" || costs[0]![1] !== 1 :
          risk !== "guarded" || !prefix || !subject.startsWith(prefix) || subject.length === prefix.length)) invalid("material subject/verb");
      if (costs.length > 36) invalid("material spends");
      const spends = Object.create(null) as Record<string, number>;
      for (const [item, count] of costs) spends[itemKey(item, "spend item")] = whole(count, "spend count", 1, 64);
      material = Object.freeze({ subject, target: validateMacroId(raw.target, "material target"), spends: Object.freeze(spends) });
    }
    return Object.freeze({
      id, verb, summary: text(offer.summary, "summary", 512), risk,
      evidence: text(offer.evidence, "evidence", 512),
      ...(anchor ? { anchor } : {}),
      ...(material ? { material } : {}),
    });
  });
  if (typeof record.quiescent !== "boolean") invalid("quiescent");
  let safety: MacroObservation["safety"];
  if (Object.hasOwn(record, "safety")) {
    const raw = shape(record.safety, "safety", ["clear", "revision"]);
    if (typeof raw.clear !== "boolean") invalid("safety clear");
    safety = Object.freeze({ clear: raw.clear, revision: whole(raw.revision, "safety revision", 1) });
  }
  let working: MacroObservation["working"];
  if (Object.hasOwn(record, "working")) {
    const raw = shape(record.working, "working", ["intentId", "crack"]);
    const crack = finite(raw.crack, "working crack", 1);
    if (crack <= 0 || crack >= 1 || !safety?.clear || record.quiescent) invalid("working observation");
    working = Object.freeze({ intentId: validateMacroId(raw.intentId, "working intent"), crack });
  }
  let workOrder: MacroWorkState | undefined;
  if (Object.hasOwn(record, "workOrder")) {
    const raw = shape(record.workOrder, "native work state", ["id", "state", "detail"], ["progress"]);
    workOrder = Object.freeze({
      id: validateMacroId(raw.id, "native work id"),
      state: choice(raw.state, "native work state", ["working", "needs_replan", "blocked", "parked", "complete"] as const),
      detail: text(raw.detail, "native work detail", 1_024),
      ...(raw.progress === undefined ? {} : { progress: parseWorkProgress(raw.progress, whole(record.tick, "tick", 1)) }),
    });
  }
  let pendingWork: MacroPendingWork | undefined;
  if (Object.hasOwn(record, "pendingWork")) {
    const raw = shape(record.pendingWork, "native pending work", ["id", "kind", "goal", "invested", "output", "location",
      "state", "yieldable", "parked"], ["remainingTicks", "collectOfferId", "deferOfferId", "historical", "returnClue", "protectedReserves", "worksite"]);
    const id = validateMacroId(raw.id, "pending work id");
    const kind = choice(raw.kind, "pending production kind", ["iron-smelting"] as const);
    const goal = text(raw.goal, "pending parent goal", 256);
    const invested = stockFloors(raw.invested, "pending invested stock", true);
    const output = stockFloors([raw.output], "pending output", true)[0]!;
    const state = choice(raw.state, "pending work state", ["estimated", "unknown", "collectible", "blocked"] as const);
    const { yieldable, parked, historical } = raw;
    const fuel = invested.find(({ item }) => MACRO_IRON_FUEL_TICKS.has(item));
    if (typeof yieldable !== "boolean" || typeof parked !== "boolean" || (historical !== undefined && historical !== true) ||
        (historical && (!parked || yieldable)) || invested.length !== 2 || !fuel ||
        !invested.some(({ item, count }) => item === "minecraft:raw_iron" && count === output.count) ||
        output.item !== "minecraft:iron_ingot" || output.count > WORK_LIMITS.maxCrafts ||
        fuel.count * MACRO_IRON_FUEL_TICKS.get(fuel.item)! < output.count * 200 ||
        (yieldable && (output.count < 2 || state === "blocked" || !safety?.clear || working ||
          (!parked && workOrder?.id !== id)))) invalid("native pending work scope");
    const offer = (value: unknown, verb: string) => {
      if (value === undefined) return;
      const id = validateMacroId(value, `${verb} opportunity id`);
      if (!opportunities.some(offer => offer.id === id && offer.verb === verb && offer.risk !== "read") ||
          !safety?.clear || working || state === "blocked") invalid(`${verb} pending work opportunity`);
      return id;
    };
    const collectOfferId = offer(raw.collectOfferId, MACRO_COLLECT_PENDING);
    const deferOfferId = offer(raw.deferOfferId, MACRO_DEFER_PENDING);
    if ((collectOfferId && (!parked || workOrder?.state === "working" || workOrder?.state === "needs_replan" && !raw.worksite)) ||
        (deferOfferId && (parked || !yieldable))) invalid("pending work operation");
    const returnClue = raw.returnClue === undefined ? undefined :
      choice(raw.returnClue, "pending return clue", ["local_face", "walked_route"] as const);
    const protectedReserves = raw.protectedReserves === undefined ? undefined :
      stockFloors(raw.protectedReserves, "pending protected reserves", true);
    let worksite: MacroPendingWork["worksite"];
    if (raw.worksite !== undefined) {
      if (!parked || yieldable || working || !safety?.clear || workOrder?.state === "working") invalid("parked worksite scope");
      const local = shape(raw.worksite, "parked worksite", ["routes"]);
      worksite = Object.freeze({ routes: text(local.routes, "parked worksite routes", 512) });
    }
    pendingWork = Object.freeze({
      id, kind, goal, invested, output, state, location: text(raw.location, "pending location clue", 512), yieldable, parked,
      ...(raw.remainingTicks !== undefined ? { remainingTicks: whole(raw.remainingTicks, "estimated remaining ticks", 0, output.count * 200) } : {}),
      ...(collectOfferId ? { collectOfferId } : {}), ...(deferOfferId ? { deferOfferId } : {}),
      ...(historical ? { historical } : {}),
      ...(returnClue ? { returnClue } : {}),
      ...(protectedReserves?.length ? { protectedReserves } : {}),
      ...(worksite ? { worksite } : {}),
    });
  }
  if (opportunities.some(offer => offer.verb === "follow" && offer.risk === "low"))
    invalid("unscoped low-risk dry follow");
  if (opportunities.some(offer => offer.verb === "survey" && offer.risk === "low"))
    invalid("unscoped low-risk cave survey");
  let prospectOpening: MacroObservation["prospectOpening"];
  if (Object.hasOwn(record, "prospectOpening")) {
    const raw = shape(record.prospectOpening, "prospect opening", ["block", "target", "tool", "maxToolLoss"]);
    if (record.stance === undefined || !safety?.clear || working || pendingWork || workOrder?.state === "working")
      invalid("prospect opening scope");
    const { maxToolLoss } = raw;
    if (maxToolLoss !== 0 && maxToolLoss !== 1) invalid("prospect opening tool loss");
    prospectOpening = Object.freeze({
      block: choice(raw.block, "prospect opening rock", prospectRock),
      target: validateMacroId(raw.target, "prospect opening target"),
      tool: vanillaItem(raw.tool, "prospect opening tool"),
      maxToolLoss,
    });
  }
  let surfaceOpening: MacroObservation["surfaceOpening"];
  if (Object.hasOwn(record, "surfaceOpening")) {
    const raw = shape(record.surfaceOpening, "surface opening", ["block", "target", "tool", "maxToolLoss"]);
    if (record.stance === undefined || !safety?.clear || working || pendingWork ||
        workOrder?.state === "working" || workOrder?.state === "needs_replan")
      invalid("surface opening scope");
    const { maxToolLoss } = raw;
    if (maxToolLoss !== 0 && maxToolLoss !== 1) invalid("surface opening tool loss");
    const block = choice(raw.block, "surface opening cap", surfaceCaps);
    const target = validateMacroId(raw.target, "surface opening target");
    if (!surfaceTargetPattern.test(target)) invalid("surface opening target");
    const tool = raw.tool === "minecraft:air" ? raw.tool : vanillaItem(raw.tool, "surface opening tool");
    if (tool === "minecraft:air" && (maxToolLoss !== 0 || block !== "minecraft:grass_block" && block !== "minecraft:dirt"))
      invalid("surface opening empty hand scope");
    surfaceOpening = Object.freeze({ block, target, tool, maxToolLoss });
  }
  let timberObstruction: MacroObservation["timberObstruction"];
  if (Object.hasOwn(record, "timberObstruction")) {
    const raw = shape(record.timberObstruction, "timber obstruction", ["block", "target", "toward", "timber"]);
    if (record.stance === undefined || !safety?.clear || working || pendingWork || workOrder?.state !== "blocked")
      invalid("timber obstruction scope");
    const block = vanillaItem(raw.block, "timber obstruction block");
    const timber = vanillaItem(raw.timber, "timber obstruction stock");
    const target = validateMacroId(raw.target, "timber obstruction target");
    const toward = parseStartAnchor(shape(raw.toward, "timber direction", ["subject", "target"]), "timber direction");
    if (!VANILLA_TIMBER_LEAVES.has(block) || !woodlandStock.test(timber) || target === toward.target ||
        (toward.subject !== woodlandAnchorSubject && toward.subject !== `block:${timber}`))
      invalid("timber obstruction association");
    timberObstruction = Object.freeze({ block, target, toward, timber });
  }
  let travelHint: MacroTravelHint | undefined;
  if (Object.hasOwn(record, "travelHint")) {
    const raw = shape(record.travelHint, "travel hint",
      ["kind", "subject", "target", "footing", "bearingDegrees"], ["windowBlocks", "heightChange"]);
    if (record.stance === undefined || !safety?.clear || working || pendingWork || workOrder?.state === "working")
      invalid("travel hint scope");
    const anchor = parseStartAnchor(raw, "travel hint");
    const kind = choice(raw.kind, "travel hint kind", travelKinds);
    if (kind === "woodland_frontier" ? anchor.subject !== woodlandAnchorSubject :
        kind === "cave_frontier" ? !naturalFrontier(anchor.subject) : !resourceTravelSubject(anchor.subject))
      invalid("travel hint subject/kind");
    const { bearingDegrees } = raw;
    if (typeof bearingDegrees !== "number" || !Number.isFinite(bearingDegrees) ||
        Math.abs(bearingDegrees) > 180) invalid("travel hint bearing");
    const footing = choice(raw.footing, "travel hint footing", ["dry", "shallow_water_with_bank", "one_block_grade"] as const);
    if (footing === "one_block_grade") {
      const { heightChange } = raw;
      if (Object.hasOwn(raw, "windowBlocks") || (heightChange !== -1 && heightChange !== 1))
        invalid("travel hint grade");
      travelHint = Object.freeze({ ...anchor, kind, bearingDegrees, footing, heightChange });
    } else {
      const windowBlocks = finite(raw.windowBlocks, "travel hint window", 3);
      if (windowBlocks <= 0 || Object.hasOwn(raw, "heightChange")) invalid("travel hint window");
      travelHint = Object.freeze({ ...anchor, kind, bearingDegrees, footing, windowBlocks });
    }
  }
  let scoutSeen = false;
  for (const offer of opportunities) if (isGroundScout(offer)) {
    if (scoutSeen || record.stance === undefined || !safety?.clear || working || pendingWork ||
        workOrder?.state === "working" || workOrder?.state === "needs_replan" || workOrder?.state === "parked")
      invalid("ground reconnaissance requires a current neutral dry stance");
    if (offer.anchor.subject !== "route:dry_landing" && (travelHint?.footing !== "dry" ||
        travelHint.windowBlocks < MIN_GROUND_SCOUT_WINDOW || !sameTravelTarget(offer.anchor, travelHint)))
      invalid("ground reconnaissance requires a current dry landmark");
    scoutSeen = true;
  }
  const food = opportunities.filter(offer => offer.verb === MACRO_FOOD_CLUE);
  if (food.length && (record.stance === undefined || !safety?.clear || working || pendingWork || workOrder?.state === "working" ||
      food.length > 2 || new Set(food.map(offer => offer.material!.subject)).size !== food.length))
    invalid("food clue scope");
  return Object.freeze({
    v: version(record.v), ...basis(record), goal: text(record.goal, "goal", 256),
    health: finite(record.health, "health", 1_024), food: whole(record.food, "food", 0, 20),
    inventory: Object.freeze(inventory), opportunities: Object.freeze(opportunities),
    recent: Object.freeze(bounds(record.recent, "recent", 32).map(entry => text(entry, "recent entry", 512))),
    quiescent: record.quiescent, ...(safety ? { safety } : {}), ...(working ? { working } : {}),
    ...(prospectOpening ? { prospectOpening } : {}), ...(travelHint ? { travelHint } : {}),
    ...(surfaceOpening ? { surfaceOpening } : {}),
    ...(timberObstruction ? { timberObstruction } : {}),
    ...(workOrder ? { workOrder } : {}), ...(pendingWork ? { pendingWork } : {}),
    ...(Object.hasOwn(record, "stance") ? { stance: whole(record.stance, "stance", 1) } : {}),
  });
}

export function parseMacroIntent(value: unknown): MacroIntent {
  const record = shape(value, "intent", [
    "v", "id", "run", "life", "epoch", "basisTick", "expiresTick", "opportunityId", "skillHash",
  ]);
  const basisTick = whole(record.basisTick, "basisTick", 1, Number.MAX_SAFE_INTEGER - MACRO_MAX_INTENT_TTL_TICKS);
  if (record.skillHash !== null && (typeof record.skillHash !== "string" || !hashPattern.test(record.skillHash))) invalid("skillHash");
  return Object.freeze({
    v: version(record.v), id: validateMacroId(record.id, "intent id"), run: validateMacroId(record.run, "run"),
    life: whole(record.life, "life", 1, 2_147_483_647), epoch: whole(record.epoch, "epoch", 1), basisTick,
    expiresTick: whole(record.expiresTick, "expiresTick", basisTick + 1, basisTick + MACRO_MAX_INTENT_TTL_TICKS),
    opportunityId: validateMacroId(record.opportunityId, "opportunity id"), skillHash: record.skillHash,
  });
}

export function parseMacroHandoff(value: unknown): MacroHandoff {
  const record = shape(value, "handoff", ["v", "run", "life", "epoch", "basisTick", "expiresTick"]);
  const basisTick = whole(record.basisTick, "basisTick", 1, Number.MAX_SAFE_INTEGER - MACRO_MAX_INTENT_TTL_TICKS);
  return {
    v: version(record.v), run: validateMacroId(record.run, "run"), life: whole(record.life, "life", 1, 2_147_483_647),
    epoch: whole(record.epoch, "epoch", 1), basisTick,
    expiresTick: whole(record.expiresTick, "expiresTick", basisTick + 1, basisTick + MACRO_MAX_HANDOFF_TTL_TICKS),
  };
}

export function parseMacroPlanning(value: unknown): MacroPlanning {
  const record = shape(value, "planning", ["v", "run", "life", "epoch", "basisTick", "id"]);
  return {
    v: version(record.v), run: validateMacroId(record.run, "run"), life: whole(record.life, "life", 1, 2_147_483_647),
    epoch: whole(record.epoch, "epoch", 1), basisTick: whole(record.basisTick, "basisTick", 1),
    id: validateMacroId(record.id, "planning request id"),
  };
}

export function parseMacroReceipt(value: unknown): MacroReceipt {
  const receipt = parseNativeReceipt(value);
  if (receipt.status === "parked") invalid("primitive receipt status");
  return receipt;
}

function parseNativeReceipt(value: unknown): NativeMacroReceipt {
  const record = shape(value, "receipt", ["v", "id", "run", "life", "tick", "status", "detail"]);
  return Object.freeze({
    v: version(record.v), id: validateMacroId(record.id, "receipt id"), run: validateMacroId(record.run, "run"),
    life: whole(record.life, "life", 1, 2_147_483_647), tick: whole(record.tick, "tick", 1),
    status: choice(record.status, "receipt status", ["accepted", "completed", "refused", "interrupted", "parked"] as const),
    detail: text(record.detail, "receipt detail", 1_024),
  });
}

export function parseMacroRevocation(value: unknown): MacroBasis {
  const record = shape(value, "native revocation", ["v", "run", "life", "tick", "epoch"]);
  version(record.v);
  return basis(record);
}

export function parseMacroReviewPatch(value: unknown): MacroReviewPatch {
  const patch = shape(value, "review patch", ["baseVersion", "baseSha256", "scope", "files"]);
  if (typeof patch.baseVersion !== "string" || !/^[A-Za-z0-9._:/-]{1,128}$/.test(patch.baseVersion)) invalid("review base version");
  if (typeof patch.baseSha256 !== "string" || !hashPattern.test(patch.baseSha256)) invalid("review base digest");
  const scope = text(patch.scope, "review scope", 1024);
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(scope)) invalid("review scope");
  const paths = new Set<string>();
  let totalBytes = 0;
  const files = bounds(patch.files, "review files", NATIVE_REVIEW_PATHS.length).map(value => {
    const file = shape(value, "review file", ["path", "content"]);
    const path = choice(file.path, "review file path", NATIVE_REVIEW_PATHS);
    if (paths.has(path)) invalid("duplicate review file");
    paths.add(path);
    const content = text(file.content, "review file content", NATIVE_REVIEW_MAX_FILE_BYTES, true);
    // Printable ASCII and exact LF endings keep the review diff visually unambiguous.
    if (/[^\x20-\x7e\n\t]/.test(content) || !content.endsWith("\n")) invalid("review file content");
    totalBytes += content.length;
    return Object.freeze({ path, content });
  });
  if (paths.size < 2 || !paths.has(NATIVE_REVIEW_TEST_PATH)) invalid("review code and test files");
  if (totalBytes > NATIVE_REVIEW_MAX_BYTES) invalid("review file byte limit");
  return Object.freeze({ baseVersion: patch.baseVersion, baseSha256: patch.baseSha256, scope, files: Object.freeze(files) });
}

export function parseMacroProposal(value: unknown): MacroProposal {
  const record = shape(value, "proposal", [
    "subgoal", "reason", "successCondition", "contingency", "alternative", "expiresTick", "action",
  ]);
  const rawAction = object(record.action, "action");
  const kind = choice(rawAction.kind, "action kind",
    ["opportunity", "continuation", "successor", "work", "work-program", "renew-work", "revoke-work", "collect-pending", "defer-pending",
      "skill", "tested-skill", "selected-skill", "gap", "abstain"] as const);
  let action: MacroProposal["action"];
  switch (kind) {
    case "work": {
      shape(rawAction, "work action", ["kind", "policy"], ["afterWorkId", "duringWaitFor", "duringWait", "openingViewId"]);
      const policy = parseMacroWorkPolicy(rawAction.policy);
      const afterWorkId = Object.hasOwn(rawAction, "afterWorkId") ? validateMacroId(rawAction.afterWorkId, "predecessor work id") : undefined;
      const duringWaitFor = Object.hasOwn(rawAction, "duringWaitFor") ? validateMacroId(rawAction.duringWaitFor, "pending ticket id") : undefined;
      const contingent = Object.hasOwn(rawAction, "duringWait") ? shape(rawAction.duringWait, "quoted pending side policy", ["policy", "maxTicks"]) : undefined;
      const openingViewId = Object.hasOwn(rawAction, "openingViewId") ? validateMacroId(rawAction.openingViewId, "opening view id") : undefined;
      if (Number(!!afterWorkId) + Number(!!duringWaitFor) + Number(!!contingent) + Number(!!openingViewId) > 1 ||
          (contingent && !policy.allowedEffects.includes(MACRO_IRON_SMELT))) invalid("exclusive work relationship");
      action = { kind, policy: duringWaitFor ? pendingOrdinaryPolicy(policy) : policy,
        ...(openingViewId ? { openingViewId } : {}),
        ...(afterWorkId ? { afterWorkId } : {}),
        ...(duringWaitFor ? { duringWaitFor } : {}),
        ...(contingent ? { duringWait: Object.freeze({ policy: pendingSidePolicy(parseMacroWorkPolicy(contingent.policy)),
          maxTicks: whole(contingent.maxTicks, "quoted pending side ticks", 1, MACRO_PENDING_SIDE_MAX_TICKS) }) } : {}) };
      break;
    }
    case "work-program":
      shape(rawAction, "work program", ["kind", "stages"], ["afterWorkId"]);
      action = { kind, stages: parseMacroWorkStages(rawAction.stages),
        ...(Object.hasOwn(rawAction, "afterWorkId") ? { afterWorkId: validateMacroId(rawAction.afterWorkId, "predecessor work id") } : {}) };
      break;
    case "renew-work":
    case "revoke-work":
      shape(rawAction, kind, ["kind", "workOrderId"]);
      action = { kind, workOrderId: validateMacroId(rawAction.workOrderId, "work order id") };
      break;
    case "collect-pending":
    case "defer-pending":
      shape(rawAction, "pending work action", ["kind", "pendingWorkId"]);
      action = { kind, pendingWorkId: validateMacroId(rawAction.pendingWorkId, "pending work id") };
      break;
    case "opportunity":
      shape(rawAction, "opportunity action", ["kind", "opportunityId"]);
      action = { kind, opportunityId: validateMacroId(rawAction.opportunityId, "opportunity id") };
      break;
    case "continuation": {
      shape(rawAction, "continuation action", ["kind", "opportunityId", "steps", "reserves"]);
      const floor = (value: unknown) => {
        const raw = shape(value, "inventory floor", ["item", "count"]);
        return Object.freeze({ item: itemKey(raw.item, "floor item"), count: whole(raw.count, "floor count", 1, 65_535) });
      };
      const steps = bounds(rawAction.steps, "continuation steps", MACRO_MAX_DIRECT_EFFECTS).map(value => {
        const step = shape(value, "continuation step", ["selector", "maxEffects", "until"]);
        const selector = shape(step.selector, "material selector", ["verb", "subject"]);
        const verb = validateMacroId(selector.verb, "selector verb"), subject = itemKey(selector.subject, "selector subject");
        const prefix = directMaterialPrefix(verb);
        if (!prefix || !subject.startsWith(prefix) || subject.length === prefix.length) invalid("material selector");
        return Object.freeze({
          selector: Object.freeze({ verb, subject }),
          maxEffects: whole(step.maxEffects, "step effects", 1, MACRO_MAX_DIRECT_EFFECTS),
          until: step.until === null ? null : floor(step.until),
        });
      });
      const reserves = bounds(rawAction.reserves, "continuation reserves", 8).map(floor);
      if (!steps.length || steps.reduce((sum, step) => sum + step.maxEffects, 0) > MACRO_MAX_DIRECT_EFFECTS ||
          new Set(reserves.map(reserve => reserve.item)).size !== reserves.length) invalid("continuation limits");
      action = { kind, opportunityId: validateMacroId(rawAction.opportunityId, "opportunity id"),
        steps: Object.freeze(steps), reserves: Object.freeze(reserves) };
      break;
    }
    case "successor":
      shape(rawAction, "successor action", ["kind", "afterIntentId", "opportunityId", "requires", "reserves"]);
      action = { kind, afterIntentId: validateMacroId(rawAction.afterIntentId, "predecessor intent"),
        opportunityId: validateMacroId(rawAction.opportunityId, "opportunity id"),
        requires: stockFloors(rawAction.requires, "successor requires"), reserves: stockFloors(rawAction.reserves, "successor reserves") };
      break;
    case "skill": {
      shape(rawAction, "skill action", ["kind", "candidate"]);
      const candidate = shape(rawAction.candidate, "candidate", ["source", "parentGeneration", "verbs"]);
      const verbs = bounds(candidate.verbs, "candidate verbs", 8).map(verb => validateMacroId(verb, "candidate verb"));
      if (!verbs.length || new Set(verbs).size !== verbs.length) invalid("candidate verbs");
      action = { kind, candidate: Object.freeze({
        source: text(candidate.source, "candidate source", 8 * 1024, true),
        parentGeneration: whole(candidate.parentGeneration, "parent generation"),
        verbs: Object.freeze(verbs),
      }) };
      break;
    }
    case "gap":
      shape(rawAction, "capability gap", ["kind", "capability"], ["suggestion", "reviewPatch"]);
      action = { kind, capability: text(rawAction.capability, "capability gap", 512),
        ...(Object.hasOwn(rawAction, "suggestion") ? { suggestion: text(rawAction.suggestion, "review suggestion", 4 * 1024, true) } : {}),
        ...(Object.hasOwn(rawAction, "reviewPatch") ? { reviewPatch: parseMacroReviewPatch(rawAction.reviewPatch) } : {}),
      };
      break;
    case "selected-skill":
    case "abstain":
      shape(rawAction, kind, ["kind"]);
      action = { kind };
      break;
    case "tested-skill":
      shape(rawAction, kind, ["kind", "skillHash"]);
      if (typeof rawAction.skillHash !== "string" || !hashPattern.test(rawAction.skillHash)) invalid("skillHash");
      action = { kind, skillHash: rawAction.skillHash };
      break;
  }
  return Object.freeze({
    subgoal: text(record.subgoal, "subgoal", 512), reason: text(record.reason, "reason", 1_024),
    successCondition: text(record.successCondition, "success condition", 512),
    contingency: text(record.contingency, "contingency", 512), alternative: text(record.alternative, "alternative", 512),
    expiresTick: whole(record.expiresTick, "proposal expiry", 1), action: Object.freeze(action),
  });
}

export function matchesMaterial(offer: MacroOpportunity, selector: MacroDirectAction["steps"][number]["selector"]): boolean {
  return offer.risk === "guarded" && offer.verb === selector.verb && offer.material?.subject === selector.subject;
}

export function isGroundScout(offer: MacroOpportunity): offer is MacroOpportunity & { readonly anchor: MacroTravelAnchor } {
  return offer.verb === "approach" && offer.risk === "low" && !!offer.anchor && offer.anchor.subject !== "route:dry";
}

export function isOpeningView(offer: MacroOpportunity): boolean {
  return offer.verb === "survey" && (offer.anchor ? offer.risk === "guarded" && offer.anchor.subject === "route:dry" :
    offer.risk === "read") || offer.verb === "inspect" && offer.risk === "read" && !!offer.anchor;
}

function rollingGatheringPolicy(policy: MacroWorkPolicy): boolean {
  return policy.target.kind === "stock" && policy.maxBreaks > 0 &&
    policy.allowedEffects.some(effect => effect.startsWith("break:")) &&
    !policy.allowedEffects.includes(MACRO_IRON_SMELT) && !policy.allowedEffects.includes(MACRO_WATER_FILL);
}

const earlyCaveSources: Readonly<Record<string, readonly string[]>> = {
  "minecraft:coal": ["coal_ore", "deepslate_coal_ore"],
  "minecraft:cobblestone": ["stone", "cobblestone"],
  "minecraft:cobbled_deepslate": ["deepslate", "cobbled_deepslate"],
  "minecraft:raw_iron": ["iron_ore", "deepslate_iron_ore"],
};
const diamondOreSources = ["diamond_ore", "deepslate_diamond_ore"] as const;
const woodlandStock = /^minecraft:(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/;

function earlySurfaceSources(target: MacroWorkTarget): readonly string[] | undefined {
  return target.kind === "stock" && (target.item === "minecraft:cobblestone" || target.item === "minecraft:coal" ||
    target.item === "minecraft:raw_iron") ? earlyCaveSources[target.item] : undefined;
}

export function hasSurfaceCoverEffect(policy: MacroWorkPolicy): boolean {
  const sources = earlySurfaceSources(policy.target);
  return !!sources && surfaceCaps.some(block => !sources.includes(block.slice("minecraft:".length)) &&
    policy.allowedEffects.includes(`break:${block}`));
}

export function surfaceAnchorMatchesPolicy(anchor: MacroTravelAnchor, policy: MacroWorkPolicy): boolean {
  const sources = earlySurfaceSources(policy.target);
  return !!sources && rollingGatheringPolicy(policy) && policy.maxBreaks >= 2 &&
    surfaceCaps.some(block => anchor.subject === `block:${block}` &&
      !sources.includes(block.slice("minecraft:".length)) && policy.allowedEffects.includes(`break:${block}`)) &&
    sources.some(block => policy.allowedEffects.includes(`break:minecraft:${block}`)) &&
    policy.allowedEffects.every(effect => sources.some(block => effect === `break:minecraft:${block}`) ||
      surfaceCaps.some(block => effect === `break:${block}`));
}

function naturalFrontier(subject: string): boolean {
  return prospectRock.some(block => subject === `block:${block}`);
}

function frontierMatchesPolicy(subject: string, policy: MacroWorkPolicy): boolean {
  if (!naturalFrontier(subject) || policy.target.kind !== "stock") return false;
  const sources = policy.target.item === "minecraft:diamond" && policy.allowedEffects.includes(MACRO_DIAMOND_PROSPECT)
    ? diamondOreSources : earlyCaveSources[policy.target.item];
  return sources?.some(block => policy.allowedEffects.includes(`break:minecraft:${block}`)) === true;
}

function resourceTravelSubject(subject: string): boolean {
  return subject.startsWith("block:") && !subject.endsWith("_leaves");
}

function resourceMatchesPolicy(subject: string, policy: MacroWorkPolicy): boolean {
  const earlySources = earlySurfaceSources(policy.target);
  return resourceTravelSubject(subject) && policy.allowedEffects.includes(`break:${subject.slice(6)}`) &&
    (!earlySources || earlySources.some(block => subject === `block:minecraft:${block}`)) &&
    (!policy.allowedEffects.includes(MACRO_DIAMOND_PROSPECT) ||
      diamondOreSources.some(block => subject === `block:minecraft:${block}`));
}

function travelSubjectMatchesPolicy(kind: MacroTravelHint["kind"], subject: string, policy: MacroWorkPolicy): boolean {
  if (!rollingGatheringPolicy(policy)) return false;
  switch (kind) {
    case "cave_frontier": return frontierMatchesPolicy(subject, policy);
    case "woodland_frontier":
      return subject === woodlandAnchorSubject && policy.target.kind === "stock" && woodlandStock.test(policy.target.item) &&
        policy.allowedEffects.includes(`break:${policy.target.item}`);
    case "resource": return resourceMatchesPolicy(subject, policy);
  }
}

export function sameTravelTarget(left: MacroTravelAnchor, right: MacroTravelAnchor | undefined): boolean {
  return !!right && left.subject === right.subject && left.target === right.target;
}

export function travelHintMatchesPolicy(hint: MacroTravelHint, policy: MacroWorkPolicy): boolean {
  return travelSubjectMatchesPolicy(hint.kind, hint.subject, policy);
}

export function harvestAnchorMatchesPolicy(anchor: MacroTravelAnchor, policy: MacroWorkPolicy): boolean {
  return travelSubjectMatchesPolicy("resource", anchor.subject, policy);
}

export function openingViewMatchesPolicy(offer: MacroOpportunity, policy: MacroWorkPolicy): boolean {
  return isOpeningView(offer) && rollingGatheringPolicy(policy) &&
    (!offer.anchor || (offer.anchor.subject === "route:dry" ? policy.allowedEffects.includes(MACRO_DIAMOND_PROSPECT) :
      (earlySurfaceSources(policy.target) ?
        resourceMatchesPolicy(offer.anchor.subject, policy) || surfaceAnchorMatchesPolicy(offer.anchor, policy) :
        policy.allowedEffects.includes(`break:${offer.anchor.subject.slice(6)}`)) ||
      frontierMatchesPolicy(offer.anchor.subject, policy)));
}

export function hasDirectAuthority(action: MacroDirectAction, observation: MacroObservation, capabilitiesVersion: string): boolean {
  const first = action.steps[0];
  return !!first && capabilitiesVersion === MACRO_CAPABILITIES_VERSION && observation.safety?.clear === true &&
    observation.opportunities.some(offer => offer.id === action.opportunityId && matchesMaterial(offer, first.selector)) &&
    action.steps.every(({ selector }) => observation.opportunities.some(offer => matchesMaterial(offer, selector)));
}

export function sameLiveCorrectionScope(source: MacroObservation, current: MacroObservation): boolean {
  return source.run === current.run && source.life === current.life && source.goal === current.goal &&
    source.epoch === current.epoch && current.health > 0 && current.health >= source.health &&
    current.safety?.clear !== false && current.safety?.revision === source.safety?.revision &&
    !current.working && current.workOrder?.state !== "working" && current.workOrder?.state !== "needs_replan" &&
    (current.quiescent || current.opportunities.length > 0 || !!current.travelHint || !!current.timberObstruction || !!current.surfaceOpening);
}

export function liveCorrectionEvidence(observation: MacroObservation): string {
  // A new heartbeat or a reissued opaque ID is not a new opportunity.
  const offers = observation.opportunities.map(({ verb, summary, risk, evidence, material, anchor }) =>
    JSON.stringify(anchor ? [verb, risk, anchor, material] : [verb, summary, risk, evidence, material])).sort();
  const pending = observation.pendingWork;
  const travel = observation.travelHint;
  return JSON.stringify([observation.quiescent, offers, observation.prospectOpening ?? null, observation.surfaceOpening ?? null, observation.timberObstruction ?? null,
    travel ? [travel.kind, travel.subject, travel.target, travel.footing,
      travel.footing === "one_block_grade" ? travel.heightChange : null] : null,
    pending ? [pending.id, pending.state, pending.parked, pending.yieldable, !!pending.collectOfferId, !!pending.deferOfferId] : null,
    Object.entries(observation.inventory).sort(([a], [b]) => a.localeCompare(b))]);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** A verified observation inode was displaced before it could be sampled. */
export class MacroObservationRotating extends Error {
  constructor() { super("Native macro observation is being replaced."); }
}

/** Use the opened Linux directory, not a string which can be retargeted during IPC. */
export class MacroDirectory {
  private constructor(private readonly handle: FileHandle) {}

  static async open(directory: string): Promise<MacroDirectory> {
    if (process.platform !== "linux" || !isAbsolute(directory)) throw new Error("Macro IPC requires a private absolute Linux directory.");
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) {
        throw new Error("Macro IPC directory is not private.");
      }
      return new MacroDirectory(handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private entry(name: string): string {
    if (!/^[A-Za-z0-9.-]{1,96}$/.test(name) || name === "." || name === "..") throw new Error("Invalid macro IPC entry name.");
    return `/proc/self/fd/${this.handle.fd}/${name}`;
  }

  async read<T>(name: keyof typeof FILE_BYTES, parse: (value: unknown) => T): Promise<T | null> {
    const entry = this.entry(name);
    for (let retry = 0; ; retry++) {
      let file: FileHandle;
      try {
        file = await open(entry, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (!missing(error)) throw error;
        if (retry !== 0) throw new MacroObservationRotating();
        return null;
      }
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o022) !== 0 ||
            info.size < 1 || info.size > FILE_BYTES[name]) throw new Error(`Invalid macro IPC file: ${name}.`);
        if (name === "observation.json" && info.nlink === 0) {
          // Native publishes by atomic replacement. A displaced, otherwise
          // admissible snapshot is not evidence; reopen the pinned path once.
          if (retry !== 0) throw new MacroObservationRotating();
          continue;
        }
        if (info.nlink !== 1) throw new Error(`Invalid macro IPC file: ${name}.`);
        const bytes = Buffer.allocUnsafe(info.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length !== info.size) throw new Error(`Macro IPC file changed during read: ${name}.`);
        return parse(JSON.parse(utf8.decode(bytes.subarray(0, length))));
      } finally {
        await file.close();
      }
    }
  }

  async write(name: "active.json" | "intent.json" | "handoff.json" | "planning.json" | "work.json", value: unknown,
    replace?: "work-only"): Promise<void> {
    if (replace && name !== "work.json") throw new Error("Only a durable work order may be replaced atomically.");
    const content = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(content) > FILE_BYTES[name]) throw new Error(`Macro IPC output exceeds cap: ${name}.`);
    const partial = `.tmp-${randomUUID()}` as const;
    const temporary = this.entry(partial);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(content); } finally { await file.close(); }
      // Primitive mailboxes carry one pending item; work can transition between compatible jobs on one tick.
      if (replace) await rename(temporary, this.entry(name));
      else await link(temporary, this.entry(name));
    } finally {
      await this.remove(partial);
    }
  }

  async remove(name: "active.json" | "intent.json" | "handoff.json" | "planning.json" | "work.json" | `.tmp-${string}`): Promise<void> {
    try { await unlink(this.entry(name)); } catch (error) { if (!missing(error)) throw error; }
  }

  async createLog(name: "history.jsonl" | "proposals.jsonl" | "receipts.jsonl"): Promise<FileHandle> {
    return open(this.entry(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  }

  /** The producer may be appending a line as we read. Only complete lines advance the cursor. */
  async readNativeReceiptLines(cursor: NativeReceiptCursor | null, maxBytes: number): Promise<NativeReceiptBatch | null> {
    let file: FileHandle;
    try {
      file = await open(this.entry("native-receipts.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing(error) && cursor === null) return null;
      throw error;
    }
    try {
      const info = await file.stat({ bigint: true });
      const offset = cursor?.offset ?? 0;
      if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o022n) !== 0n ||
          info.size < BigInt(offset) || info.size > BigInt(maxBytes) ||
          (cursor !== null && (info.dev !== cursor.device || info.ino !== cursor.inode))) {
        throw new Error("Invalid native macro receipt journal.");
      }
      const available = Number(info.size) - offset;
      const count = Math.min(16 * 1024, available);
      const bytes = Buffer.allocUnsafe(count);
      let filled = 0;
      while (filled < count) {
        const { bytesRead } = await file.read(bytes, filled, count - filled, offset + filled);
        if (bytesRead === 0) throw new Error("Native macro receipt journal was truncated.");
        filled += bytesRead;
      }
      const receipts: NativeMacroReceipt[] = [];
      let start = 0;
      for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, start)) {
        if (end === start || end - start > FILE_BYTES["receipt.json"]) throw new Error("Invalid native macro receipt line.");
        receipts.push(parseNativeReceipt(JSON.parse(utf8.decode(bytes.subarray(start, end)))));
        start = end + 1;
      }
      if ((count === available || !start) && count - start > FILE_BYTES["receipt.json"]) {
        throw new Error("Native macro receipt line exceeds cap.");
      }
      return { cursor: { device: info.dev, inode: info.ino, offset: offset + start }, receipts,
        more: count < available, partial: count === available && count > start };
    } finally {
      await file.close();
    }
  }
}

export interface NativeReceiptCursor {
  readonly device: bigint;
  readonly inode: bigint;
  readonly offset: number;
}

interface NativeReceiptBatch {
  readonly cursor: NativeReceiptCursor;
  readonly receipts: readonly NativeMacroReceipt[];
  readonly more: boolean;
  readonly partial: boolean;
}

async function withMacroDirectory<T>(directory: string, use: (ipc: MacroDirectory) => Promise<T>): Promise<T> {
  const ipc = await MacroDirectory.open(directory);
  try { return await use(ipc); } finally { await ipc.close(); }
}

export function readMacroObservation(directory: string, preserveRotation = false): Promise<MacroObservation | null> {
  return withMacroDirectory(directory, async ipc => {
    try { return await ipc.read("observation.json", parseMacroObservation); }
    catch (error) {
      if (!preserveRotation && error instanceof MacroObservationRotating) return null;
      throw error;
    }
  });
}

export function readMacroReceipt(directory: string): Promise<MacroReceipt | null> {
  return withMacroDirectory(directory, ipc => ipc.read("receipt.json", parseMacroReceipt));
}

export function writeMacroIntent(directory: string, intent: MacroIntent): Promise<void> {
  return withMacroDirectory(directory, ipc => ipc.write("intent.json", parseMacroIntent(intent)));
}
