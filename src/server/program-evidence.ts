import type {
  ActivityEvent,
  Json,
  ProgramEvidenceView,
} from "../shared/contracts.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import { z } from "zod";
import { programCompatibilitySchema } from "../shared/adapter.ts";
import { effectScopeSchema } from "../shared/control.ts";
import { confirmedMinecraftGuiTransactions, minecraftGuiTransactionFactSchema, minecraftBlockRemovalFactSchema, minecraftObservationV3Schema, minecraftProductionFactSchema } from "../shared/minecraft.ts";
import { verificationResultSchema } from "../shared/validation.ts";
import { jsonSchema } from "../shared/primitives.ts";
import type { Store, StoredAction, StoredRun } from "./store.ts";
import { canonicalContractJson, contractHash } from "./adapter-contract.ts";
import { minecraftGoalBaselineSchema, minecraftInventoryCounts } from "./minecraft-adapter.ts";
import type { ObjectiveMetrics } from "../shared/execution-evidence.ts";
import { confirmedRemoval, eligibleLog, objectiveMetrics, receiptedInventoryDelta } from "./objective-metrics.ts";
import { residentReceiptSchema, type ResidentReceipt } from "./resident-evidence.ts";
export type DetailedProgramEvidence = ProgramEvidenceView & {
  metrics: ObjectiveMetrics;
  goal_associations: { event_seq: number; relationship: "direct_receipt" | "block_removal_contributor" | "inventory_collector"; action_id: string | null;
    controller_input?: { input_id: string; generation: number; sequence: number }; causal_item_origin: "unknown" }[];
};
const object = (value: Json): Record<string, Json> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
type GoalRelationship = DetailedProgramEvidence["goal_associations"][number]["relationship"];
type OwnedAction = { owner: SkillExecutionView; action: StoredAction };
type OwnedController = { owner: SkillExecutionView; receipt: ResidentReceipt; event: ActivityEvent };
const removalSchemaHash = contractHash(jsonSchema.parse(z.toJSONSchema(minecraftBlockRemovalFactSchema)));
const productionSchemaHash = contractHash(jsonSchema.parse(z.toJSONSchema(minecraftProductionFactSchema)));
const transactionSchemaHash = contractHash(jsonSchema.parse(z.toJSONSchema(minecraftGuiTransactionFactSchema)));

/** Current verdicts link retained typed facts, never item-name guesses from a new event shape. */
function currentGoalLinks(
  run: StoredRun,
  event: ActivityEvent,
  retained: Map<string, ActivityEvent | null>,
  compatibility: z.infer<typeof programCompatibilitySchema> | null,
  confirmed: Map<string, OwnedAction>,
  receipted: Map<string, OwnedAction>,
  controllers: Map<string, OwnedController | null>,
): Map<string, GoalRelationship> | null {
  if (typeof run.goal === "string" || !run.goal.verifier || !compatibility ||
    compatibility.compatibility_hash !== run.compatibility_hash ||
    compatibility.descriptor.adapter.id !== run.goal.adapter_id) return null;
  const verdict = verificationResultSchema.safeParse(event.details);
  if (!verdict.success || verdict.data.status !== "verified" || verdict.data.adapter_id !== run.goal.adapter_id ||
    verdict.data.verifier_id !== run.goal.verifier.id || verdict.data.verifier_version !== run.goal.verifier.version) return null;
  const baseline = minecraftGoalBaselineSchema.safeParse(run.baseline);
  if (!baseline.success || baseline.data.world_id !== run.world_id || baseline.data.session_id !== run.session_id ||
    baseline.data.epoch !== run.epoch || baseline.data.native_boot_id !== run.native_boot_id) return null;
  const links = new Map<string, GoalRelationship>();
  const collection = run.goal.goal_id === "collect_wood" || run.goal.goal_id === "obtain_stone";
  const wood = run.goal.goal_id === "collect_wood" || run.goal.goal_id === "collect_and_craft_table";
  const product = run.goal.goal_id === "craft_stone_pickaxe" ? "stone_pickaxe" : "crafting_table";
  const combined = run.goal.goal_id === "collect_and_craft_table";
  const acquisitions: { life: number; at: number }[] = [];
  const productions: { life: number; at: number }[] = [];
  const possessions: { life: number; at: number }[] = [];
  const recordTransaction = (fact: z.infer<typeof minecraftGuiTransactionFactSchema>, life: number, at: number, effectId: string) => {
    const woodAcquisition = combined && [fact.inventory_before, fact.inventory_after].some(counts =>
      Object.keys(counts).some(item => eligibleLog(item) && counts[item]! > (baseline.data.inventory[item] ?? 0)));
    const finalProduct = fact.productions.some(production => production.production_confirmed &&
      production.producer === "crafting" && production.item === product);
    if (!woodAcquisition && !finalProduct) return false;
    if (woodAcquisition) acquisitions.push({ life, at });
    if (finalProduct) productions.push({ life, at });
    links.set(effectId, finalProduct ? "direct_receipt" : "inventory_collector");
    return true;
  };
  for (const id of new Set(verdict.data.evidence_refs)) {
    const reference = retained.get(id);
    if (!reference || reference.event_seq >= event.event_seq || reference.at > event.at) return null;
    const evidence = object(reference.details), schema = object(evidence?.schema ?? null);
    const scope = effectScopeSchema.safeParse(evidence?.scope);
    if (!evidence || evidence.adapter_id !== run.goal.adapter_id || !scope.success ||
      scope.data.run_id !== run.run_id || scope.data.world_id !== run.world_id || scope.data.session_id !== run.session_id ||
      scope.data.epoch !== run.epoch || scope.data.native_boot_id !== run.native_boot_id ||
      typeof evidence.observed_at !== "string" || !Number.isFinite(Date.parse(evidence.observed_at)) ||
      Date.parse(evidence.observed_at) > Date.parse(event.at) ||
      Date.parse(evidence.observed_at) < Date.parse(baseline.data.captured_at)) return null;
    if (schema?.id === "observation_v3" && schema.version === 3 &&
      schema.hash === compatibility.descriptor.observation.schema_hash) {
      const parsed = minecraftObservationV3Schema.safeParse(evidence.data);
      if (!parsed.success) return null;
      const observation = parsed.data;
      if (observation.world_id !== run.world_id || observation.session_id !== run.session_id || observation.epoch !== run.epoch ||
        observation.native_boot_id !== run.native_boot_id || observation.compatibility_hash !== run.compatibility_hash ||
        observation.profile_id !== compatibility.descriptor.observation.profile.id ||
        observation.profile_configuration_hash !== compatibility.descriptor.observation.profile.configuration_hash ||
        observation.life.life_id !== scope.data.life_id || observation.space.space_epoch !== scope.data.space_epoch ||
        observation.life.status !== "alive" || observation.observation_seq <= baseline.data.observation_seq ||
        !Number.isFinite(Date.parse(observation.captured_at)) || Date.parse(observation.captured_at) > Date.parse(event.at)) return null;
      let counts: Record<string, number>;
      try { counts = minecraftInventoryCounts(observation.data); } catch { return null; }
      const gained = new Set(Object.keys(counts).filter(item => counts[item]! > (baseline.data.inventory[item] ?? 0) &&
        (collection ? wood ? eligibleLog(item) : item === "stone" || item === "cobblestone" : wood && eligibleLog(item))));
      if (combined && gained.size > 0) acquisitions.push({ life: scope.data.life_id, at: Date.parse(observation.captured_at) });
      if (combined && (counts[product] ?? 0) > 0) possessions.push({ life: scope.data.life_id, at: Date.parse(observation.captured_at) });
      for (const [actionId, { action, owner }] of confirmed) {
        if (!action.view.scope || action.view.origin !== "skill" || action.view.compatibility_hash !== run.compatibility_hash ||
          action.view.scope.run_id !== run.run_id || action.view.scope.world_id !== run.world_id ||
          action.view.scope.session_id !== run.session_id || action.view.scope.epoch !== run.epoch ||
          action.view.scope.native_boot_id !== scope.data.native_boot_id || action.view.scope.source_hash !== owner.source_hash ||
          action.view.scope.life_id !== scope.data.life_id ||
          action.view.scope.run_generation !== scope.data.run_generation || owner.native_boot_id !== scope.data.native_boot_id ||
          !action.view.ended_at || Date.parse(action.view.ended_at) > Date.parse(observation.captured_at)) continue;
        const delta = receiptedInventoryDelta(action);
        if ([...gained].some(item => (delta?.[item] ?? 0) > 0)) {
          if (!links.has(actionId)) links.set(actionId, "inventory_collector");
        } else if (wood && confirmedRemoval(action)) {
          const receipt = object(action.view.result?.evidence ?? null);
          if (typeof receipt?.target_name === "string" && eligibleLog(receipt.target_name) && !links.has(actionId))
            links.set(actionId, "block_removal_contributor");
        }
      }
    } else {
      const removal = schema?.id === "minecraft_block_removal_v1" && schema.version === 1 && schema.hash === removalSchemaHash
        ? minecraftBlockRemovalFactSchema.safeParse(evidence.data) : null;
      const production = schema?.id === "minecraft_item_production_v1" && schema.version === 1 && schema.hash === productionSchemaHash
        ? minecraftProductionFactSchema.safeParse(evidence.data) : null;
      const transaction = schema?.id === "minecraft_gui_transaction_v1" && schema.version === 1 && schema.hash === transactionSchemaHash
        ? minecraftGuiTransactionFactSchema.safeParse(evidence.data) : null;
      const fact = removal?.success ? removal.data : production?.success ? production.data : transaction?.success ? transaction.data : null;
      if (!fact) return null;
      if (transaction?.success && typeof evidence.evidence_id === "string") {
        const suffix = `:gui:${transaction.data.operation_index}`;
        const inputId = evidence.evidence_id.endsWith(suffix) ? evidence.evidence_id.slice(0, -suffix.length) : "";
        const streamed = controllers.get(inputId);
        if (streamed) {
          const { receipt, owner, event: retainedReceipt } = streamed;
          if (retainedReceipt.event_seq >= event.event_seq || retainedReceipt.at > evidence.observed_at ||
            !owner.started_at || retainedReceipt.at < owner.started_at || owner.ended_at && retainedReceipt.at > owner.ended_at ||
            canonicalContractJson(receipt.scope) !== canonicalContractJson(scope.data) ||
            receipt.input.kind !== "screen" ||
            !confirmedMinecraftGuiTransactions({ kind: "screen_input", screen: receipt.input.screen, operations: receipt.input.operations },
              receipt.update.result.evidence).some(value => canonicalContractJson(value) === canonicalContractJson(transaction.data)) ||
            !recordTransaction(transaction.data, scope.data.life_id, Date.parse(evidence.observed_at), inputId)) return null;
          continue;
        }
      }
      const matched = transaction?.success ? [...receipted].find(([actionId, entry]) =>
        evidence.evidence_id === `${actionId}:gui:${transaction.data.operation_index}` &&
        confirmedMinecraftGuiTransactions(entry.action.request, entry.action.view.result?.evidence)
          .some(receipt => canonicalContractJson(receipt) === canonicalContractJson(transaction.data)))
        : [fact.receipt_ref, confirmed.get(fact.receipt_ref)] as const;
      const actionId = matched?.[0], entry = matched?.[1];
      if (!entry || !entry.action.view.scope || entry.action.view.origin !== "skill" ||
        entry.action.view.compatibility_hash !== run.compatibility_hash ||
        entry.action.view.scope.source_hash !== entry.owner.source_hash ||
        canonicalContractJson(entry.action.view.scope) !== canonicalContractJson(scope.data) ||
        !entry.action.view.ended_at || entry.action.view.ended_at > event.at ||
        Date.parse(entry.action.view.ended_at) > Date.parse(evidence.observed_at)) return null;
      const receipt = object(entry.action.view.result?.evidence ?? null);
      if (removal?.success) {
        if (!confirmedRemoval(entry.action) || receipt?.target_name !== removal.data.target_name ||
          !eligibleLog(removal.data.target_name)) return null;
        links.set(fact.receipt_ref, run.goal.goal_id === "break_log" ? "direct_receipt" : "block_removal_contributor");
      } else if (production?.success) {
        const delta = receiptedInventoryDelta(entry.action);
        const fact = production.data;
        const woodAcquisition = combined && [fact.inventory_before, fact.inventory_after].some(counts =>
          Object.keys(counts).some(item => eligibleLog(item) && counts[item]! > (baseline.data.inventory[item] ?? 0)));
        const finalProduct = fact.item === product;
        if ((!finalProduct && !woodAcquisition) || (delta?.[fact.item] ?? 0) <= 0 ||
          canonicalContractJson(receipt?.inventory_before ?? null) !== canonicalContractJson(production.data.inventory_before) ||
          canonicalContractJson(receipt?.inventory_after ?? null) !== canonicalContractJson(production.data.inventory_after)) return null;
        if (woodAcquisition) acquisitions.push({ life: scope.data.life_id, at: Date.parse(evidence.observed_at) });
        if (finalProduct) productions.push({ life: scope.data.life_id, at: Date.parse(evidence.observed_at) });
        links.set(fact.receipt_ref, finalProduct ? "direct_receipt" : "inventory_collector");
      } else if (transaction?.success && actionId) {
        if (!recordTransaction(transaction.data, scope.data.life_id, Date.parse(evidence.observed_at), actionId)) return null;
      }
    }
  }
  return combined && !productions.some(produced =>
    acquisitions.some(acquired => acquired.life === produced.life && acquired.at <= produced.at) &&
    possessions.some(possessed => possessed.life === produced.life && possessed.at >= produced.at)) ? null : links;
}
/** Measured counters, never a weighted efficiency score or source-length proxy. */
export function programEvidence(
  store: Store,
  runId: string,
): DetailedProgramEvidence[] {
  const executions = store.allSkillExecutions(runId);
  const projections = new Map<string, ProgramEvidenceView>();
  const owners = new Map<string, SkillExecutionView>();
  for (const execution of executions) {
    owners.set(execution.execution_id, execution);
    const start = execution.started_at
      ? Date.parse(execution.started_at)
      : null;
    projections.set(execution.execution_id, {
      execution_id: execution.execution_id,
      skill_id: execution.skill_id,
      version: execution.version,
      root_execution_id: execution.root_execution_id,
      status: execution.status,
      duration_ms:
        start === null
          ? null
          : Math.max(
              0,
              (execution.ended_at
                ? Date.parse(execution.ended_at)
                : Date.now()) - start,
            ),
      actions: execution.actions,
      calls: execution.calls,
      strategic_requests: 0,
      confirmed_effects: 0,
      evidence_status: execution.result ? "self_reported" : "unknown",
      verified_event_seqs: [],
      compactness: store.skill(runId, execution).validation,
    });
  }
  const inInterval = (
    execution: SkillExecutionView,
    event: ActivityEvent,
  ): boolean =>
    !!execution.started_at &&
    event.at >= execution.started_at &&
    (!execution.ended_at || event.at <= execution.ended_at);
  const run = store.getRun(runId);
  const confirmed = new Map<string, OwnedAction>();
  const receipted = new Map<string, OwnedAction>();
  const controllers = new Map<string, OwnedController | null>();
  const retained = new Map<string, ActivityEvent | null>();
  let compatibility: z.infer<typeof programCompatibilitySchema> | null = null;
  const goals: ActivityEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = store.eventsAfter(runId, cursor, 500);
    for (const event of page) {
      const details = object(event.details);
      if (event.type === "run.adapter") {
        const parsed = programCompatibilitySchema.safeParse(event.details);
        if (parsed.success && parsed.data.compatibility_hash === run?.compatibility_hash) compatibility = parsed.data;
      } else if (event.type === "adapter.evidence" && typeof details?.evidence_id === "string") {
        retained.set(details.evidence_id, retained.has(details.evidence_id) ? null : event);
      } else if (event.type === "controller.receipted") {
        const parsed = residentReceiptSchema.safeParse(event.details);
        if (parsed.success) {
          const receipt = parsed.data, scope = receipt.scope, owner = owners.get(scope.execution_id);
          if (owner?.entry === "step" && owner.source_hash === scope.source_hash && owner.compatibility_hash === receipt.compatibility_hash &&
            receipt.compatibility_hash === run?.compatibility_hash && owner.run_id === scope.run_id && owner.world_id === scope.world_id &&
            owner.session_id === scope.session_id && owner.epoch === scope.epoch && owner.native_boot_id === scope.native_boot_id &&
            owner.run_generation === scope.run_generation && owner.life_id === scope.life_id && owner.space_epoch === scope.space_epoch &&
            scope.source_hash === store.skill(runId, owner).hash &&
            receipt.input_id === `controller:${owner.execution_id}:${receipt.update.controller_generation}:${receipt.update.sequence}`) {
            controllers.set(receipt.input_id, controllers.has(receipt.input_id) ? null : { owner, receipt, event });
          }
        }
      }
      if (event.type === "model.call" && details?.backend !== "jev") {
        for (const execution of executions)
          if (inInterval(execution, event))
            projections.get(execution.execution_id)!.strategic_requests++;
      } else if (
        ["action.succeeded", "action.failed", "action.cancelled", "action.unknown"].includes(event.type) &&
        typeof details?.action_id === "string" &&
        !receipted.has(details.action_id)
      ) {
        const action = store.getAction(runId, details.action_id);
        if (!action?.view.execution_id || event.type !== `action.${action.view.status}`) continue;
        const wholeConfirmed = action.view.status === "succeeded" &&
          object(action.view.result?.evidence ?? null)?.effect_confirmed === true;
        if (!wholeConfirmed && !confirmedMinecraftGuiTransactions(action.request, action.view.result?.evidence).length) continue;
        let owner = owners.get(action.view.execution_id);
        if (!owner) {
          const loaded = store.skillExecution(runId, {
            execution_id: action.view.execution_id,
          });
          if (!loaded) continue;
          owners.set(loaded.execution_id, loaded);
          owner = loaded;
        }
        receipted.set(details.action_id, { owner, action });
        // Receipt-level GUI prefixes link goals without confirming the enclosing action or its suffix.
        if (!wholeConfirmed) continue;
        confirmed.set(details.action_id, { owner, action });
        for (const id of new Set([
          owner.execution_id,
          owner.root_execution_id,
        ])) {
          const projection = projections.get(id);
          if (projection) {
            projection.confirmed_effects++;
            if (
              projection.evidence_status === "self_reported" ||
              projection.evidence_status === "unknown"
            )
              projection.evidence_status = "confirmed_effects";
          }
        }
      } else if (event.type === "goal.verified") goals.push(event);
      else if (event.type === "experience.promoted" && details) {
        const evidence = object(details.evidence ?? null);
        if (typeof evidence?.execution_id !== "string") continue;
        const projection = projections.get(evidence.execution_id),
          predicate = object(evidence.predicate ?? null);
        if (projection && typeof predicate?.event_seq === "number") {
          projection.evidence_status =
            predicate.kind === "goal_verified"
              ? "verified_goal"
              : "verified_predicate";
          projection.verified_event_seqs.push(predicate.event_seq);
        }
      }
    }
    if (page.length < 500) break;
    cursor = page[page.length - 1]!.event_seq;
  }
  const associations = new Map<string, DetailedProgramEvidence["goal_associations"]>();
  for (const event of goals) {
    const details = object(event.details);
    const current = run && typeof run.goal !== "string";
    if (!current && (!run || typeof details?.goal !== "string" || details.goal !== run.goal)) continue;
    const links = current ? currentGoalLinks(run, event, retained, compatibility, confirmed, receipted, controllers) : null;
    if (current && !links) continue;
    for (const [actionId, { owner, action }] of current ? receipted : confirmed) {
      const receipt = object(action.view.result?.evidence ?? null);
      const item = !current && typeof details?.item === "string" ? details.item : null;
      const delta = receiptedInventoryDelta(action);
      const relationship = links?.get(actionId);
      const collector = current ? relationship === "inventory_collector" : item !== null && (delta?.[item] ?? 0) > 0;
      const removal = current ? relationship === "block_removal_contributor" : confirmedRemoval(action) && typeof receipt?.target_name === "string" && eligibleLog(receipt.target_name);
      const direct = current ? relationship === "direct_receipt" : details?.action_id === actionId && (details?.goal === "break_log" ? removal : collector || action.request.kind === "craft");
      if (!direct && !collector && !removal) continue;
      for (const id of new Set([owner.execution_id, owner.root_execution_id])) {
        const projection = projections.get(id);
        if (!projection || (action.view.ended_at && action.view.ended_at > event.at)) continue;
        const linked = associations.get(id) ?? [];
        linked.push({ event_seq: event.event_seq, relationship: direct ? "direct_receipt" : collector ? "inventory_collector" : "block_removal_contributor", action_id: actionId, causal_item_origin: "unknown" });
        associations.set(id, linked);
        if (direct || collector && run && typeof run.goal !== "string" &&
          (run.goal.goal_id === "collect_wood" || run.goal.goal_id === "obtain_stone")) {
          projection.evidence_status = "verified_goal";
          projection.verified_event_seqs.push(event.event_seq);
        }
      }
    }
    if (current && links) for (const [inputId, entry] of controllers) {
      if (!entry) continue;
      const relationship = links.get(inputId);
      if (!relationship) continue;
      const { owner, receipt } = entry;
      for (const id of new Set([owner.execution_id, owner.root_execution_id])) {
        const projection = projections.get(id);
        if (!projection) continue;
        const linked = associations.get(id) ?? [];
        linked.push({ event_seq: event.event_seq, relationship, action_id: null,
          controller_input: { input_id: inputId, generation: receipt.update.controller_generation, sequence: receipt.update.sequence },
          causal_item_origin: "unknown" });
        associations.set(id, linked);
        if (relationship === "direct_receipt") {
          projection.evidence_status = "verified_goal";
          projection.verified_event_seqs.push(event.event_seq);
        }
      }
    }
  }
  for (const projection of projections.values())
    projection.verified_event_seqs = [
      ...new Set(projection.verified_event_seqs),
    ];
  const metrics = new Map(objectiveMetrics(store, runId).map((metric) => [metric.execution_id, metric]));
  return [...projections.values()].map((projection) => ({ ...projection, metrics: metrics.get(projection.execution_id)!, goal_associations: associations.get(projection.execution_id) ?? [] }));
}
