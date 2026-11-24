import { sameTravelTarget, type MacroObservation, type MacroProposal } from "./protocol.ts";

export type PreparedStockFooting = "dry" | "shallow_water_with_bank";
export const PREPARED_STOCK = {
  ore: "minecraft:diamond_ore",
  diamond: "minecraft:diamond",
  tool: "minecraft:iron_pickaxe",
  effect: "break:minecraft:diamond_ore",
} as const;

export function preparedStockView(view: MacroObservation | undefined, footing: PreparedStockFooting) {
  // Native travelHint is published only for a settled, neutral, safe world view.
  // quiescent describes a separate promotion handoff, not ordinary stock readiness.
  return view?.goal === "diamond" && view.stance !== undefined && view.health === 20 && view.safety?.clear === true &&
    view.travelHint?.footing === footing && view.travelHint.kind === "resource" &&
    view.travelHint.subject === `block:${PREPARED_STOCK.ore}` && !view.working && !view.workOrder && !view.pendingWork &&
    (view.inventory[PREPARED_STOCK.diamond] ?? 0) === 0 && view.inventory[PREPARED_STOCK.tool] === 1;
}

export function samePreparedStockView(before: MacroObservation, after: MacroObservation, footing: PreparedStockFooting) {
  return preparedStockView(before, footing) && preparedStockView(after, footing) &&
    before.run === after.run && before.life === after.life && before.epoch === after.epoch &&
    before.stance === after.stance && before.safety!.revision === after.safety!.revision &&
    sameTravelTarget(before.travelHint!, after.travelHint);
}

export function preparedStockReady(footing: PreparedStockFooting) {
  let before: MacroObservation | undefined;
  return (view: MacroObservation): boolean => {
    if (!preparedStockView(view, footing)) {
      before = undefined;
      return false;
    }
    const ready = !!before && view.tick > before.tick && samePreparedStockView(before, view, footing);
    before = view;
    return ready;
  };
}

export function filterPreparedStockProposal(action: MacroProposal["action"], view: MacroObservation) {
  if (action.kind === "abstain")
    return { disposition: "abstained", reason: "Model abstained; no stock order was attempted." } as const;
  if (action.kind === "gap" && !action.reviewPatch)
    return { disposition: "reported_gap", reason: "Model reported a gap; no stock order was attempted." } as const;
  if (action.kind === "opportunity" && view.opportunities.some(offer => offer.id === action.opportunityId && offer.risk === "read"))
    return { disposition: "read_only", reason: "Model chose a read-only observation; this diagnostic issues no read intent." } as const;
  const refuse = (reason: string) => ({ disposition: "prepared_stock_refused", reason } as const);
  if (action.kind !== "work" || action.openingViewId || action.afterWorkId || action.duringWaitFor || action.duringWait)
    return refuse("Choose one live stock work order, without a camera opening, successor, or contingent work.");
  const { target, allowedEffects, costCaps, reserves, maxBreaks, maxCrafts, maxPlacements } = action.policy;
  if (target.kind !== "stock" || target.item !== PREPARED_STOCK.diamond || target.count !== 1)
    return refuse("Set the stock target to one minecraft:diamond.");
  if (allowedEffects.length !== 1 || allowedEffects[0] !== PREPARED_STOCK.effect ||
      maxBreaks !== 1 || maxCrafts !== 0 || maxPlacements !== 0)
    return refuse("Allow only break:minecraft:diamond_ore, with one break and zero crafts or placements.");
  if (costCaps.length !== 0 || reserves.length !== 1 || reserves[0]!.item !== PREPARED_STOCK.tool || reserves[0]!.count !== 1)
    return refuse("Set costCaps to [] and reserve one minecraft:iron_pickaxe.");
}
