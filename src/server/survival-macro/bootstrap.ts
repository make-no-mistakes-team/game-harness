import type { Context, Tool } from "@oh-my-pi/pi-ai";
import { SURVIVAL_AGENT_GOALS, type SurvivalAgentGoal } from "../../shared/survival-agent-ui.ts";
import {
  MACRO_MAX_WORK_STAGES, parseMacroWorkPolicy, parseMacroWorkStages, type MacroInference, type MacroObservation,
  type MacroStockFloor, type MacroWorkPolicy, type MacroWorkStage,
} from "./protocol.ts";
import {
  VANILLA_HARVEST_SOURCES as harvestSources, VANILLA_TIMBER_RECIPES as timber, VANILLA_WORK_RECIPE_KEYS,
} from "./vanilla-work.ts";

export const PRE_SPAWN_GOAL_ONLY = "pre_spawn_goal_only";
const TOOL = "propose_survival_first_plan";
const MAX_REPLY_BYTES = 4_096;
const MAX_FLOORS = 4;
const MAX_BRANCHES = 3;
const WITNESSED_TIMBER = "witnessed_timber";
const WITNESSED_LOG = "witnessed_log";
const BOUND_SOURCE = { kind: "bound_source" } as const;
const BOUND_PLANKS = { kind: "bound_planks" } as const;
const CRAFT_BOUND_PLANKS = { kind: "craft_bound_planks" } as const;
const PLACE_TABLE = "place:minecraft:crafting_table";
const DEFER_CATEGORIES = ["constraint_not_expressible", "needs_world_evidence", "no_supported_opening"] as const;
const wholeLogs = [...timber.keys()].filter(item => item.endsWith("_log") && !item.startsWith("minecraft:stripped_"));

export interface FirstPlanRequest {
  readonly goal: SurvivalAgentGoal;
  readonly objective?: string;
}

type StockReference = string | typeof BOUND_SOURCE | typeof BOUND_PLANKS;
type FirstPlanFloor = { readonly item: StockReference; readonly count: number };

interface ConditionalStage {
  readonly requires: readonly FirstPlanFloor[];
  readonly policy: Omit<MacroWorkPolicy, "target" | "allowedEffects" | "costCaps" | "reserves"> & {
    readonly target: FirstPlanFloor & { readonly kind: "stock" };
    readonly allowedEffects: readonly (string | typeof CRAFT_BOUND_PLANKS)[];
    readonly costCaps: readonly FirstPlanFloor[];
    readonly reserves: readonly FirstPlanFloor[];
  };
}

interface FirstPlanBranch {
  readonly policy:
    | { readonly kind: "harvest_stock"; readonly resource: string; readonly count: number; readonly maxBreaks: number }
    | { readonly kind: "plank_stock"; readonly source: string; readonly count: number; readonly maxBreaks: number;
        readonly maxCrafts: number };
  readonly requires: readonly FirstPlanFloor[];
  readonly then?: readonly ConditionalStage[];
}

export type FirstPlanAdvice = { readonly kind: "defer"; readonly category?: (typeof DEFER_CATEGORIES)[number] } | {
  readonly kind: "first_policy";
  readonly branches: readonly FirstPlanBranch[];
  readonly reserves: readonly FirstPlanFloor[];
};

export interface FirstPlanInference extends Omit<MacroInference, "basis" | "proposal" | "frameSha256" | "dispatched"> {
  readonly stage: typeof PRE_SPAWN_GOAL_ONLY;
  readonly proposal: FirstPlanAdvice | null;
  readonly dispatched: boolean;
}

export type FirstPlanStrategist = (
  request: FirstPlanRequest, signal: AbortSignal, onDispatch: (startedAtMs: number) => void,
) => Promise<FirstPlanInference>;

function schema(properties: Record<string, unknown>) {
  return { type: "object", required: Object.keys(properties), properties, additionalProperties: false };
}
const choice = (...values: string[]) => ({ type: "string", enum: values });
const integer = { type: "integer" };
const timberChoices = [WITNESSED_LOG, WITNESSED_TIMBER, ...timber.keys()];
const harvestChoices = [...timberChoices, "minecraft:cobblestone", "minecraft:coal"];
const stageEffects = [PLACE_TABLE, ...VANILLA_WORK_RECIPE_KEYS
  .filter(key => !key.endsWith("_planks")).map(key => `craft:${key}`)];
const itemSchema = { anyOf: [{ type: "string" }, schema({ kind: choice(BOUND_SOURCE.kind, BOUND_PLANKS.kind) })] };
const floorList = (minItems: number, maxItems: number) =>
  ({ type: "array", minItems, maxItems, items: schema({ item: itemSchema, count: integer }) });
const floorsSchema = floorList(0, MAX_FLOORS);
const stageSchema = schema({ requires: floorList(1, 32), policy: schema({
  target: schema({ kind: choice("stock"), item: itemSchema, count: integer }),
  allowedEffects: { type: "array", maxItems: 64, items: { anyOf: [
    choice(...stageEffects), schema({ kind: choice(CRAFT_BOUND_PLANKS.kind) }),
  ] } },
  costCaps: floorList(0, 32), reserves: floorList(0, 32),
  maxBreaks: { type: "integer", enum: [0] }, maxCrafts: integer, maxPlacements: integer,
}) });
const branchFields = { requires: floorsSchema, policy: { anyOf: [
  schema({ kind: choice("harvest_stock"), resource: choice(...harvestChoices), count: integer, maxBreaks: integer }),
  schema({ kind: choice("plank_stock"), source: choice(...timberChoices), count: integer, maxBreaks: integer, maxCrafts: integer }),
] } };
const branchSchema = { anyOf: [schema(branchFields), schema({ ...branchFields,
  then: { type: "array", minItems: 1, maxItems: MACRO_MAX_WORK_STAGES - 1, items: stageSchema },
})] };
const firstPlanTool: Tool = {
  name: TOOL,
  description: "Return alternatives for one bounded first policy with optional conditional follow-through, or defer. This tool does not observe or act.",
  strict: true,
  parameters: schema({ advice: { anyOf: [
    schema({ kind: choice("defer") }),
    schema({ kind: choice("defer"), category: choice(...DEFER_CATEGORIES) }),
    schema({
      kind: choice("first_policy"), reserves: floorsSchema,
      branches: { type: "array", minItems: 1, maxItems: MAX_BRANCHES, items: branchSchema },
    }),
  ] } }),
};

const PROMPT = `Give a conditional first Survival policy using only the invocation goal, optional task and public Minecraft rules. No player or world observation exists yet. Do not assume a life, inventory, spawn, terrain, tools, recipe affordance or successful action. This is advice only. The host can bind one opening to an actual safe first native observation or elect normal live planning instead. Never produce coordinates, code, opportunity IDs or a full playthrough.
Use first_policy only if this small vocabulary can express a goal-relevant opening consistent with the exact task (the task does not change the invocation goal). Otherwise return defer. Give 1 to ${MAX_BRANCHES} independent branches in priority order. Only one branch can bind: alternatives never contribute stock, effects, budgets or authority to each other.
If ideal starting stock, species, or another prerequisite is unknown, include a separate safe acquisition branch when allowed, with its own explicit caps and real prerequisites, or defer instead of guessing. A branch with maxBreaks zero can never harvest. Keep the same task constraints in every alternative. Do not assume a surplus above a reserve, and do not omit a user's no-spend condition to make an alternative possible. These are the only first-stage policies:
- harvest_stock: retain a total count of a supported vanilla item after a witnessed break or pickup. Resource may be an exact timber item, a timber selector below, minecraft:cobblestone, or minecraft:coal. Stone and coal require the right equipped tool and a fresh native harvest offer. maxBreaks is 0..4 (0 means pickup only).
- plank_stock: retain a total count of planks from one exact eligible timber input or use a timber selector below. The host binds a uniquely supported input to its actual vanilla plank output using a matching inventory recipe, a witnessed drop, or a safe native break offer. maxCrafts is 1..2, and maxBreaks is 0..2 (0 forbids breaking). Each craft may spend one exact timber item and no other item.
Use witnessed_log for one witnessed unstripped Overworld log species. Use witnessed_timber only if any supported source form, including wood, stripped logs, stems or bamboo blocks, is allowed. Do not assume a species. Exact item IDs always stay exact.
For either policy, count is the total stock target from 1..8, not an amount to add. Size one useful batch around the task's downstream material needs and retained stock, not merely the smallest possible first action. Give explicit finite effect caps appropriate to that batch. One matching live opportunity can start it; this is not proof that the rest of the batch exists. Mining permission requires a matching zero-spend break offer and binds at most one exact block type. A pickup or recipe alone cannot grant mining. The native actor verifies each subsequent action against current evidence, and may stop if it cannot safely continue. The first stage cannot place anything or spend outside plank_stock.
Each floor is {item,count}, with a count from 1..2304. item is an exact minecraft:item ID, {"kind":"bound_source"} (the one actual timber input or harvest output), or {"kind":"bound_planks"} (the exact vanilla plank output of the actual timber, unavailable for stone or coal). These are inventory items, never block IDs, wildcards or species sums.
Each branch's requires (0..4) are starting inventory prerequisites, true on the first native observation and at admission. Shared reserves (0..4) protect exact stock in every branch. A zero-spend first harvest may earn its exact reserve only within the target, cap and actually witnessed means. A spending first stage requires the reserves and adequate surplus. Do not put future stock into the starting requires.
A branch may include then (1..${MACRO_MAX_WORK_STAGES - 1}) only for useful adjacent work on the same opening. Each entry has positive requires and a normal finite stock policy. requires are real inventory thresholds rechecked after the previous stage's accepted and completed native receipts. The target is total stock, which can be the invocation item when the recipes and ingredients are supported; do not target portal entry or smelting. Include only necessary exact craft effects, {"kind":"craft_bound_planks"} for the bound timber, and place:minecraft:crafting_table only if needed and capped (0..1 per stage). Later stages never grant block breaking. costCaps are explicit aggregate ingredient/placement costs for that stage, not grants to spend reserves. A stage's reserves add to the inherited reserves and can never reduce them. Put a reserve not yet held in its own producing stage; no earlier stage may spend that stock below the proposed reserve. No speculative receipt, ingredient, workstation, or stocked intermediate authorizes action.
Check vanilla ingredients and batch yields before proposing numbers. Account for retained stock in addition to spend on the result, missing intermediate recipes, and a crafting table if not already supported. Include every required cost and effect within the caps. Reuse held gear through a real starting prerequisite instead of remaking it; a carried table is different from a placed, witnessed table. Defer if the task or floor is contradictory, universal or summed across species, or the available vocabulary cannot express it. Optionally provide one of the structured defer categories, never private reasoning.`;

export function firstPlanContext({ goal, objective }: FirstPlanRequest): Context | undefined {
  if (!SURVIVAL_AGENT_GOALS.includes(goal) || (objective !== undefined &&
      (typeof objective !== "string" || !objective.trim() || objective.length > 2_048 ||
        /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(objective)))) return;
  return {
    systemPrompt: [PROMPT], messages: [{ role: "user", timestamp: Date.now(), content: JSON.stringify({ goal, objective }) }],
    tools: [firstPlanTool],
  };
}

function fields(value: unknown, names: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length === names.length && names.every(name => Object.hasOwn(raw, name))) return raw;
}

function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function stockReference(value: unknown): StockReference | undefined {
  if (typeof value === "string" && /^minecraft:[a-z0-9_]{1,96}$/.test(value) && value !== "minecraft:air") return value;
  const kind = fields(value, ["kind"])?.kind;
  return kind === BOUND_SOURCE.kind ? BOUND_SOURCE : kind === BOUND_PLANKS.kind ? BOUND_PLANKS : undefined;
}

function floors(value: unknown, max = MAX_FLOORS): FirstPlanFloor[] | undefined {
  if (!Array.isArray(value) || value.length > max) return;
  const result: FirstPlanFloor[] = [];
  for (const entry of value) {
    const floor = fields(entry, ["item", "count"]);
    if (!floor || !bounded(floor.count, 1, 2_304)) return;
    const item = stockReference(floor.item);
    if (!item || result.some(prior => prior.item === item)) return;
    result.push({ item, count: floor.count });
  }
  return result;
}

function parseConditionalStage(value: unknown): ConditionalStage | undefined {
  const stage = fields(value, ["policy", "requires"]);
  const requires = floors(stage?.requires, 32);
  const policy = fields(stage?.policy, ["target", "allowedEffects", "costCaps", "reserves", "maxBreaks", "maxCrafts", "maxPlacements"]);
  const target = fields(policy?.target, ["kind", "item", "count"]);
  const item = stockReference(target?.item);
  const costCaps = floors(policy?.costCaps, 32);
  const reserves = floors(policy?.reserves, 32);
  if (!requires?.length || !policy || target?.kind !== "stock" || !item || !bounded(target.count, 1, 2_304) ||
      !costCaps || !reserves || policy.maxBreaks !== 0 || !bounded(policy.maxCrafts, 0, 64) ||
      !bounded(policy.maxPlacements, 0, 1) || !Array.isArray(policy.allowedEffects) || policy.allowedEffects.length > 64) return;
  const allowedEffects: (string | typeof CRAFT_BOUND_PLANKS)[] = [];
  for (const raw of policy.allowedEffects) {
    const effect = typeof raw === "string" && stageEffects.includes(raw) ? raw :
      fields(raw, ["kind"])?.kind === CRAFT_BOUND_PLANKS.kind ? CRAFT_BOUND_PLANKS : undefined;
    if (!effect || allowedEffects.includes(effect)) return;
    allowedEffects.push(effect);
  }
  if (allowedEffects.some(effect => effect !== PLACE_TABLE) !== (policy.maxCrafts > 0) ||
      allowedEffects.includes(PLACE_TABLE) !== (policy.maxPlacements > 0)) return;
  return { requires, policy: { target: { kind: "stock", item, count: target.count }, allowedEffects, costCaps, reserves,
    maxBreaks: 0, maxCrafts: policy.maxCrafts, maxPlacements: policy.maxPlacements } };
}

function parseBranch(value: unknown): FirstPlanBranch | undefined {
  const branch = fields(value, ["policy", "requires"]) ?? fields(value, ["policy", "requires", "then"]);
  const requires = floors(branch?.requires);
  if (!branch || !requires) return;
  let then: ConditionalStage[] | undefined;
  if (Object.hasOwn(branch, "then")) {
    if (!Array.isArray(branch.then) || branch.then.length === 0 || branch.then.length >= MACRO_MAX_WORK_STAGES) return;
    then = [];
    for (const value of branch.then) {
      const stage = parseConditionalStage(value);
      if (!stage) return;
      then.push(stage);
    }
  }
  const harvest = fields(branch.policy, ["kind", "resource", "count", "maxBreaks"]);
  if (harvest?.kind === "harvest_stock" && typeof harvest.resource === "string" && harvestChoices.includes(harvest.resource) &&
      bounded(harvest.count, 1, 8) && bounded(harvest.maxBreaks, 0, 4)) {
    const { kind, resource, count, maxBreaks } = harvest;
    return { policy: { kind, resource, count, maxBreaks }, requires, ...(then ? { then } : {}) };
  }
  const plank = fields(branch.policy, ["kind", "source", "count", "maxBreaks", "maxCrafts"]);
  if (plank?.kind === "plank_stock" && typeof plank.source === "string" && timberChoices.includes(plank.source) &&
      bounded(plank.count, 1, 8) && bounded(plank.maxBreaks, 0, 2) && bounded(plank.maxCrafts, 1, 2)) {
    const { kind, source, count, maxBreaks, maxCrafts } = plank;
    return { policy: { kind, source, count, maxBreaks, maxCrafts }, requires, ...(then ? { then } : {}) };
  }
}

export function parseFirstPlanAdvice(data: unknown): FirstPlanAdvice | null {
  if (fields(data, ["kind"])?.kind === "defer") return { kind: "defer" };
  const defer = fields(data, ["kind", "category"]);
  if (defer?.kind === "defer") {
    const category = DEFER_CATEGORIES.find(category => category === defer.category);
    return category ? { kind: "defer", category } : null;
  }
  const reply = fields(data, ["kind", "branches", "reserves"]);
  if (reply?.kind !== "first_policy" || !Array.isArray(reply.branches) ||
      reply.branches.length === 0 || reply.branches.length > MAX_BRANCHES) return null;
  const reserves = floors(reply.reserves);
  if (!reserves) return null;
  const branches: FirstPlanBranch[] = [];
  for (const value of reply.branches) {
    const branch = parseBranch(value);
    if (!branch) return null;
    branches.push(branch);
  }
  return { kind: "first_policy", branches, reserves };
}

export function parseFirstPlanToolArguments(raw: string | undefined): FirstPlanAdvice | null {
  if (!raw || Buffer.byteLength(raw) > MAX_REPLY_BYTES) return null;
  try {
    const advice = fields(JSON.parse(raw), ["advice"]);
    // Use the exact terminal wire JSON, not the SDK's repaired partial arguments.
    return advice ? parseFirstPlanAdvice(advice.advice) : null;
  } catch { return null; }
}

export function firstPlanScopeMatches(request: FirstPlanRequest, first: MacroObservation, live: MacroObservation, run: string): boolean {
  return first.run === run && live.run === run && first.goal === request.goal && live.goal === request.goal &&
    live.life === first.life && live.epoch >= first.epoch && live.tick >= first.tick && first.health > 0 && live.health >= first.health &&
    first.safety?.clear === true && live.safety?.clear === true && live.safety.revision === first.safety.revision &&
    !live.working && (!live.workOrder || (live.workOrder.state !== "working" && live.workOrder.state !== "needs_replan"));
}

interface FirstPlanScope {
  readonly run: string;
  readonly first: MacroObservation;
  readonly protectedReserves: readonly MacroStockFloor[];
}

interface FirstPlanCandidate {
  readonly input: string;
  readonly policy: MacroWorkPolicy;
  readonly liveTargets: readonly string[];
  readonly requires: readonly MacroStockFloor[];
  readonly then?: readonly MacroWorkStage[];
}

type NoBinding = "stock_prerequisite_missing" | "protected_stock_missing" |
  "no_matching_live_material" | "ambiguous_material_binding" | "invalid_conditional_program" | "opening_target_already_held";
type FirstPlanBinding = (FirstPlanCandidate & { readonly branchIndex: number }) | {
  readonly reason: "model_deferred" | "live_scope_changed" | NoBinding;
};

/** The advisory mentions no location. Resolve it only against exact current native evidence. */
export function bindFirstPlan(
  request: FirstPlanRequest, advice: FirstPlanAdvice, live: MacroObservation, scope: FirstPlanScope, pinnedBranch?: number,
): FirstPlanBinding {
  if (advice.kind === "defer") return { reason: "model_deferred" };
  if (!firstPlanScopeMatches(request, scope.first, live, scope.run)) return { reason: "live_scope_changed" };
  const stock = (item: string) => live.inventory[item] ?? 0;
  const holds = ({ item, count }: MacroStockFloor) => (scope.first.inventory[item] ?? 0) >= count && stock(item) >= count;

  const breaks = new Map<string, Set<string>>();
  const drops = new Map<string, Set<string>>();
  const recipes = new Map<string, Set<string>>();
  for (const { verb, risk, material } of live.opportunities) {
    if (!material || risk !== "guarded") continue;
    const add = (map: typeof breaks, item: string) => {
      let targets = map.get(item);
      if (!targets) map.set(item, targets = new Set());
      targets.add(material.target);
    };
    if (verb === "break" && material.subject.startsWith("block:") && Object.keys(material.spends).length === 0)
      add(breaks, material.subject.slice("block:".length));
    else if (verb === "collect" && material.subject.startsWith("item:") && Object.keys(material.spends).length === 0)
      add(drops, material.subject.slice("item:".length));
    else if (verb === "continue" && material.subject === "recipe:planks") {
      for (const [item, count] of Object.entries(material.spends)) if (count === 1 && timber.has(item)) add(recipes, item);
    }
  }

  let reason: NoBinding = "stock_prerequisite_missing";
  const witnesses = { breaks, drops, recipes };
  const reserves = [...advice.reserves, ...scope.protectedReserves];
  for (let branchIndex = 0; branchIndex < advice.branches.length; branchIndex++) {
    if (pinnedBranch !== undefined && pinnedBranch !== branchIndex) continue;
    const branch = advice.branches[branchIndex]!;
    const result = bindBranch(branch, stock, holds, reserves, witnesses, request.objective === undefined);
    if (typeof result !== "string") return { ...result, branchIndex };
    if (result === "ambiguous_material_binding") return { reason: result };
    if (result === "invalid_conditional_program" || result === "opening_target_already_held" ||
        reason === "stock_prerequisite_missing" || (result === "no_matching_live_material" &&
          reason !== "invalid_conditional_program" && reason !== "opening_target_already_held")) reason = result;
  }
  return { reason };
}

type Witnesses = ReadonlyMap<string, ReadonlySet<string>>;

function resolveStock(item: StockReference, source: string): string | undefined {
  if (typeof item === "string") return item;
  if (item.kind === BOUND_SOURCE.kind) return source;
  const planks = timber.get(source);
  return planks ? `minecraft:${planks}` : undefined;
}

function resolvedFloors(floors: readonly FirstPlanFloor[], source: string): MacroStockFloor[] | undefined {
  const exact = new Map<string, number>();
  for (const { item, count } of floors) {
    const id = resolveStock(item, source);
    if (!id) return;
    exact.set(id, Math.max(exact.get(id) ?? 0, count));
  }
  return [...exact].map(([item, count]) => ({ item, count }));
}

function resolveStages(first: MacroWorkStage, then: readonly ConditionalStage[], source: string): readonly MacroWorkStage[] | undefined {
  const stages = [first];
  const inherited = new Map(first.policy.reserves.map(({ item, count }) => [item, count]));
  for (const stage of then) {
    const { policy } = stage;
    const item = resolveStock(policy.target.item, source);
    const requires = resolvedFloors(stage.requires, source);
    const costCaps = resolvedFloors(policy.costCaps, source);
    const reserves = resolvedFloors(policy.reserves, source);
    if (!item || !requires || !costCaps || costCaps.length !== policy.costCaps.length || !reserves) return;
    const allowedEffects: string[] = [];
    for (const effect of policy.allowedEffects) {
      if (typeof effect === "string") allowedEffects.push(effect);
      else {
        const recipe = timber.get(source);
        if (!recipe) return;
        allowedEffects.push(`craft:${recipe}`);
      }
    }
    for (const { item, count } of reserves) {
      if (count < (inherited.get(item) ?? 0) || stages.some(({ policy }) =>
        policy.costCaps.some(cost => cost.item === item) && !policy.reserves.some(floor => floor.item === item && floor.count >= count))) return;
      inherited.set(item, count);
    }
    stages.push({ requires, policy: { ...policy, target: { ...policy.target, item }, allowedEffects, costCaps,
      reserves: [...inherited].map(([item, count]) => ({ item, count })) } });
  }
  try { return parseMacroWorkStages(stages).slice(1); }
  catch { return; }
}

function bindBranch(
  branch: FirstPlanBranch, stock: (item: string) => number, holds: (floor: MacroStockFloor) => boolean,
  floors: readonly FirstPlanFloor[], { breaks, drops, recipes }: { breaks: Witnesses; drops: Witnesses; recipes: Witnesses },
  skipSatisfiedOpening: boolean,
): FirstPlanCandidate | NoBinding {
  const { policy } = branch;
  const selector = policy.kind === "harvest_stock" ? policy.resource : policy.source;
  const sources = selector === WITNESSED_LOG ? wholeLogs : selector === WITNESSED_TIMBER ? timber.keys() : [selector];
  let candidate: FirstPlanCandidate | undefined;
  let ambiguous = false;
  let reason: NoBinding = "stock_prerequisite_missing";
  for (const item of sources) {
    const requires = resolvedFloors(branch.requires, item);
    if (!requires?.every(holds)) continue;
    if (reason === "stock_prerequisite_missing") reason = "no_matching_live_material";
    const reserves = resolvedFloors(floors, item);
    if (!reserves) { reason = "invalid_conditional_program"; continue; }
    const consider = (target: string, liveTargets: readonly string[], blockId?: string,
      craft?: { readonly recipe: string; readonly cap: number }, witnessedFloorStock = 0) => {
      if (!liveTargets.length) return;
      // A single offer is the entrance condition for a batch. Starting below
      // a reserve is different: today's evidence must still cover the deficit.
      if (reserves.length > 32 || reserves.some(floor => stock(floor.item) < floor.count &&
          (craft || floor.item !== target || witnessedFloorStock < floor.count || policy.count < floor.count))) {
        reason = "protected_stock_missing";
        return;
      }
      const compiled = parseMacroWorkPolicy({
        target: { kind: "stock", item: target, count: policy.count },
        allowedEffects: [...(blockId ? [`break:${blockId}`] : []), ...(craft ? [`craft:${craft.recipe}`] : [])],
        costCaps: craft ? [{ item, count: craft.cap }] : [], reserves,
        maxBreaks: blockId ? policy.maxBreaks : 0, maxCrafts: craft?.cap ?? 0, maxPlacements: 0,
      });
      const then = branch.then && resolveStages({ policy: compiled, requires }, branch.then, item);
      if (branch.then && !then) { reason = "invalid_conditional_program"; return; }
      const final = then?.at(-1)?.policy;
      // Without a custom task, don't gather a prefix solely to remake retained gear.
      if (skipSatisfiedOpening && final?.target.kind === "stock" && holds(final.target) && final.reserves.every(holds)) {
        reason = "opening_target_already_held";
        return;
      }
      if (candidate) { ambiguous = true; return; }
      candidate = { input: item, liveTargets, requires, policy: compiled, ...(then ? { then } : {}) };
    };
    if (policy.kind === "harvest_stock") {
      const held = stock(item);
      if (held >= policy.count) continue;
      const visibleDrops = drops.get(item);
      let blockId: string | undefined;
      let visibleBreaks: ReadonlySet<string> | undefined;
      if (policy.maxBreaks > 0) {
        for (const block of timber.has(item) ? [item] : harvestSources.get(item) ?? []) {
          const seen = breaks.get(block);
          if (!seen?.size) continue;
          if (blockId) return "ambiguous_material_binding";
          blockId = block;
          visibleBreaks = seen;
        }
      }
      // Each distinct offer can contribute one item to the conservative
      // reserve check; neither a break nor stack size is promised.
      const witnessedFloorStock = held + Math.max(visibleDrops?.size ?? 0, Math.min(policy.maxBreaks, visibleBreaks?.size ?? 0));
      consider(item, [...(visibleDrops ?? []), ...(visibleBreaks ?? [])], blockId, undefined, witnessedFloorStock);
    } else {
      const recipe = timber.get(item);
      if (!recipe) continue;
      const target = `minecraft:${recipe}`;
      if (stock(target) >= policy.count) continue;
      const hasSurplus = stock(item) > (reserves.find(floor => floor.item === item)?.count ?? 0);
      const craft = hasSurplus ? recipes.get(item) : undefined;
      const collect = drops.get(item);
      const mine = policy.maxBreaks > 0 ? breaks.get(item) : undefined;
      consider(target, [...(craft ?? []), ...(collect ?? []), ...(mine ?? [])], mine ? item : undefined,
        { recipe, cap: policy.maxCrafts });
    }
  }
  return ambiguous ? "ambiguous_material_binding" : candidate ?? reason;
}
