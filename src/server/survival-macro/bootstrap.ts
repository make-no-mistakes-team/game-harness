import type { Context, Tool } from "@oh-my-pi/pi-ai";
import { SURVIVAL_AGENT_GOALS, type SurvivalAgentGoal } from "../../shared/survival-agent-ui.ts";
import { parseMacroWorkPolicy, type MacroInference, type MacroObservation, type MacroStockFloor, type MacroWorkPolicy } from "./protocol.ts";

export const PRE_SPAWN_GOAL_ONLY = "pre_spawn_goal_only";
const TOOL = "propose_survival_first_plan";
const MAX_REPLY_BYTES = 4_096;
const MAX_FLOORS = 4;
const WITNESSED_TIMBER = "witnessed_timber";

// Public vanilla 1.21.4 resource/recipe facts, not assumptions about where the player spawns.
const timber = new Map<string, { recipe: string; batch: number }>();
for (const [species, forms] of [
  ["oak", ["log", "wood"]], ["spruce", ["log", "wood"]], ["birch", ["log", "wood"]],
  ["jungle", ["log", "wood"]], ["acacia", ["log", "wood"]], ["dark_oak", ["log", "wood"]],
  ["mangrove", ["log", "wood"]], ["cherry", ["log", "wood"]], ["pale_oak", ["log", "wood"]],
  ["crimson", ["stem", "hyphae"]], ["warped", ["stem", "hyphae"]], ["bamboo", ["block"]],
] as const) {
  for (const form of forms) {
    const output = { recipe: `${species}_planks`, batch: species === "bamboo" ? 2 : 4 };
    for (const prefix of ["", "stripped_"]) timber.set(`minecraft:${prefix}${species}_${form}`, output);
  }
}
const harvestOutputs = new Map([
  ["minecraft:stone", "minecraft:cobblestone"], ["minecraft:cobblestone", "minecraft:cobblestone"],
  ["minecraft:coal_ore", "minecraft:coal"], ["minecraft:deepslate_coal_ore", "minecraft:coal"],
]);

export interface FirstPlanRequest {
  readonly goal: SurvivalAgentGoal;
  readonly objective?: string;
}

export type FirstPlanAdvice = { readonly kind: "defer" } | {
  readonly kind: "first_policy";
  readonly policy:
    | { readonly kind: "harvest_stock"; readonly resource: string; readonly count: number; readonly maxBreaks: number }
    | { readonly kind: "plank_stock"; readonly source: string; readonly count: number; readonly maxBreaks: number;
        readonly maxCrafts: number };
  readonly requires: readonly MacroStockFloor[];
  readonly reserves: readonly MacroStockFloor[];
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
const timberChoices = [WITNESSED_TIMBER, ...timber.keys()];
const harvestChoices = [...timberChoices, "minecraft:cobblestone", "minecraft:coal"];
const floorsSchema = { type: "array", items: schema({ item: { type: "string" }, count: integer }) };
const firstPlanTool: Tool = {
  name: TOOL,
  description: "Return one bounded advisory first policy or defer. This tool does not observe or act in the game.",
  strict: true,
  parameters: schema({ advice: { anyOf: [
    schema({ kind: choice("defer") }),
    schema({
      kind: choice("first_policy"), requires: floorsSchema, reserves: floorsSchema,
      policy: { anyOf: [
        schema({ kind: choice("harvest_stock"), resource: choice(...harvestChoices), count: integer, maxBreaks: integer }),
        schema({ kind: choice("plank_stock"), source: choice(...timberChoices), count: integer, maxBreaks: integer, maxCrafts: integer }),
      ] },
    }),
  ] } }),
};

const PROMPT = `Give a conditional first Survival policy using only the invocation goal, optional task and public Minecraft rules. No player or world observation exists yet. Do not assume a life, inventory, spawn, terrain, tools, recipe affordance or successful action. This is advice only. The host can bind one policy to an actual safe first native observation or elect normal live planning instead. Never produce coordinates, code, opportunity IDs or a full plan.
Use first_policy only if this small vocabulary can express a goal-relevant opening consistent with the exact task (the task does not change the invocation goal). Otherwise return defer. These are the only public policy branches:
- harvest_stock: retain a total count of a supported vanilla item after a witnessed break or pickup. Resource may be an exact timber item, witnessed_timber (only if any supported timber species is allowed), minecraft:cobblestone, or minecraft:coal. Stone and coal require the right equipped tool and a fresh native harvest offer. maxBreaks is 0..4 (0 means pickup only).
- plank_stock: retain a total count of planks from one exact eligible timber input, or use witnessed_timber only if any supported timber species is allowed. The host binds a uniquely supported input to its actual vanilla plank output using a matching inventory recipe, a witnessed drop, or a safe native break offer. maxCrafts is 1..2, and maxBreaks is 0..2 (0 forbids breaking). Each craft may spend one exact timber item and no other item.
For either policy, count is a total inventory target from 1..8, not a quantity to add. The host narrows caps to the actually witnessed stock or opportunity, binding at most one exact break material. It may reject ambiguous or unobserved bindings. No placements or other spending are authorized.
Use requires as current inventory prerequisites and reserves as all applicable inventory floors that must already be met and protected while doing the opening. Both are lists (0..4 each) of {item,count} with distinct exact minecraft: item IDs and counts from 1..2304. Do not present future stock as already present. Defer if safety or task compatibility depends on unavailable context, restrictions cannot be represented, or the suggested opening would spend below a user floor.`;

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

function floors(value: unknown): MacroStockFloor[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FLOORS) return;
  const result: MacroStockFloor[] = [];
  for (const entry of value) {
    const floor = fields(entry, ["item", "count"]);
    if (!floor || typeof floor.item !== "string" || !/^minecraft:[a-z0-9_]{1,96}$/.test(floor.item) ||
        floor.item === "minecraft:air" || !bounded(floor.count, 1, 2_304) || result.some(({ item }) => item === floor.item)) return;
    result.push({ item: floor.item, count: floor.count });
  }
  return result;
}

export function parseFirstPlanAdvice(data: unknown): FirstPlanAdvice | null {
  if (fields(data, ["kind"])?.kind === "defer") return { kind: "defer" };
  const reply = fields(data, ["kind", "policy", "requires", "reserves"]);
  if (reply?.kind !== "first_policy") return null;
  const requires = floors(reply.requires), reserves = floors(reply.reserves);
  if (!requires || !reserves) return null;
  const harvest = fields(reply.policy, ["kind", "resource", "count", "maxBreaks"]);
  if (harvest?.kind === "harvest_stock" && typeof harvest.resource === "string" && harvestChoices.includes(harvest.resource) &&
      bounded(harvest.count, 1, 8) && bounded(harvest.maxBreaks, 0, 4)) {
    const { kind, resource, count, maxBreaks } = harvest;
    return { kind: "first_policy", policy: { kind, resource, count, maxBreaks }, requires, reserves };
  }
  const plank = fields(reply.policy, ["kind", "source", "count", "maxBreaks", "maxCrafts"]);
  if (plank?.kind === "plank_stock" && typeof plank.source === "string" && timberChoices.includes(plank.source) &&
      bounded(plank.count, 1, 8) && bounded(plank.maxBreaks, 0, 2) && bounded(plank.maxCrafts, 1, 2)) {
    const { kind, source, count, maxBreaks, maxCrafts } = plank;
    return { kind: "first_policy", policy: { kind, source, count, maxBreaks, maxCrafts }, requires, reserves };
  }
  return null;
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
}

type FirstPlanBinding = FirstPlanCandidate | { readonly reason:
  "model_deferred" | "live_scope_changed" | "stock_prerequisite_missing" | "protected_stock_missing" |
  "no_matching_live_material" | "ambiguous_material_binding" };

/** The advisory mentions no location. Resolve it only against exact current native evidence. */
export function bindFirstPlan(
  request: FirstPlanRequest, advice: FirstPlanAdvice, live: MacroObservation, scope: FirstPlanScope,
): FirstPlanBinding {
  if (advice.kind === "defer") return { reason: "model_deferred" };
  if (!firstPlanScopeMatches(request, scope.first, live, scope.run)) return { reason: "live_scope_changed" };
  const stock = (item: string) => live.inventory[item] ?? 0;
  if (advice.requires.some(({ item, count }) => stock(item) < count)) return { reason: "stock_prerequisite_missing" };
  const protectedStock = new Map(advice.reserves.map(({ item, count }) => [item, count]));
  for (const { item, count } of scope.protectedReserves)
    protectedStock.set(item, Math.max(count, protectedStock.get(item) ?? 0));
  const reserves = [...protectedStock].map(([item, count]) => ({ item, count }));
  if (reserves.length > 32 || reserves.some(({ item, count }) => stock(item) < count)) return { reason: "protected_stock_missing" };

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

  let candidate: FirstPlanCandidate | undefined;
  let ambiguous = false;
  function consider(input: string, target: string, targetCount: number, liveTargets: readonly string[],
    maxBreaks: number, maxCrafts = 0, recipe?: string, blockId = input) {
    if (targetCount <= stock(target) || !liveTargets.length) return;
    if (candidate) { ambiguous = true; return; }
    candidate = { input, liveTargets, policy: parseMacroWorkPolicy({
      target: { kind: "stock", item: target, count: targetCount },
      allowedEffects: [...(maxBreaks ? [`break:${blockId}`] : []), ...(recipe ? [`craft:${recipe}`] : [])],
      costCaps: recipe ? [{ item: input, count: maxCrafts }] : [], reserves, maxBreaks, maxCrafts, maxPlacements: 0,
    }) };
  }
  const policy = advice.policy;
  if (policy.kind === "harvest_stock") {
    const harvests = policy.resource === WITNESSED_TIMBER ? timber.keys() : [policy.resource];
    for (const item of harvests) {
      const held = stock(item);
      if (held >= policy.count) continue;
      const visibleDrops = drops.get(item);
      // A visible drop proves an opportunity, not the quantity in its stack.
      if (visibleDrops?.size) {
        consider(item, item, Math.min(policy.count, held + visibleDrops.size), [...visibleDrops], 0);
        continue;
      }
      const sources = timber.has(item) ? [item] : [...harvestOutputs].filter(([, output]) => output === item).map(([key]) => key);
      for (const block of sources) {
        const seen = breaks.get(block);
        const cap = Math.min(policy.maxBreaks, seen?.size ?? 0, policy.count - held);
        if (cap) consider(item, item, held + cap, [...seen!], cap, 0, undefined, block);
      }
    }
  } else {
    const inputs = policy.source === WITNESSED_TIMBER ? timber.keys() : [policy.source];
    for (const item of inputs) {
      const output = timber.get(item);
      if (!output) continue;
      const target = `minecraft:${output.recipe}`, held = stock(target);
      if (held >= policy.count) continue;
      const available = stock(item) - (protectedStock.get(item) ?? 0);
      const need = Math.min(policy.maxCrafts, Math.ceil((policy.count - held) / output.batch));
      const recipe = recipes.get(item);
      const collect = drops.get(item);
      const mine = breaks.get(item);
      // Prefer known stock, then a proven pickup, then exact observed break targets.
      const onHand = recipe ? Math.min(available, need) : 0;
      const pickup = !onHand ? Math.min(need, collect?.size ?? 0) : 0;
      const harvest = !onHand && !pickup ? Math.min(need, policy.maxBreaks, mine?.size ?? 0) : 0;
      const crafts = onHand || pickup || harvest;
      if (crafts) consider(item, target, Math.min(policy.count, held + crafts * output.batch),
        [...(onHand ? recipe! : pickup ? collect! : mine!)], harvest, crafts, output.recipe);
    }
  }
  return ambiguous ? { reason: "ambiguous_material_binding" } : candidate ?? { reason: "no_matching_live_material" };
}
