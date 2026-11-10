import { z } from "zod";
import type { AdapterDescriptor, AdapterEvidence, AdapterGoal, Json, RuntimeAdapter, VerificationManifest, VerificationResult } from "../shared/contracts.ts";
import { effectScopeSchema, safeCounterSchema, screenPreconditionMatches, visibleScreenSnapshotSchema } from "../shared/control.ts";
import { jsonSchema } from "../shared/primitives.ts";
import type { ObservationV3 } from "../shared/observations.ts";
import { minecraftActionSchema, minecraftBlockRemovalFactSchema, minecraftControllerFrameSchema, minecraftEffectUncertaintyFactSchema, minecraftObservationV3Schema,
  minecraftProductionFactSchema, minecraftGuiTransactionFactSchema, confirmedMinecraftGuiTransactions, confirmedMinecraftCraftStages,
  minecraftProfileConfigurationSchema, type MinecraftObservation, type MinecraftObservationData } from "../shared/minecraft.ts";
import { adapterCompatibility, canonicalContractJson, contractHash } from "./adapter-contract.ts";
import { minecraftSchemaCatalog } from "./native-contract.ts";

const inventorySchema = z.record(z.string(), safeCounterSchema).refine(value => Object.keys(value).length <= 64);
export const minecraftGoalBaselineSchema = z.object({ schema_version: z.literal(1), world_id: z.string(), session_id: z.string(), epoch: safeCounterSchema,
  native_boot_id: z.string(), life_id: safeCounterSchema, observation_seq: safeCounterSchema,
  captured_at: z.string(), inventory: inventorySchema }).strict();
export type MinecraftGoalBaseline = z.infer<typeof minecraftGoalBaselineSchema>;
interface VerifierLifeProgress {
  wood: { at: number; ref: string } | null;
  products: Record<string, { life: number; at: number; item: string; ref: string }>;
  uncertainProduction: boolean;
}

export function minecraftInventoryCounts(data: MinecraftObservationData): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const item of data.player.inventory) {
    const count = (counts[item.name] ?? 0) + item.count;
    if (!Number.isSafeInteger(count)) throw new Error("Own inventory count exceeds exact identity range");
    counts[item.name] = count;
  }
  return counts;
}
export function eligibleMinecraftWood(name: string): boolean {
  return /_(log|wood|stem|hyphae)$/.test(name);
}
function ownScope(event: AdapterEvidence, manifest: VerificationManifest): boolean {
  return event.scope.run_id === manifest.run_id && event.scope.world_id === manifest.world_id &&
    event.scope.session_id === manifest.session_id && event.scope.epoch === manifest.epoch &&
    event.scope.native_boot_id === manifest.native_boot_id && effectScopeSchema.safeParse(event.scope).success;
}
function gain(counts: Readonly<Record<string, number>>, baseline: Readonly<Record<string, number>>, wood: boolean) {
  for (const name of Object.keys(counts))
    if ((wood ? eligibleMinecraftWood(name) : name === "stone" || name === "cobblestone") && counts[name]! > (baseline[name] ?? 0)) return true;
  return false;
}

/** No goal logic or Minecraft DTO interpretation is required in the generic Runtime. */
export function createMinecraftAdapter(descriptor: AdapterDescriptor, options: { now?: () => number } = {}): RuntimeAdapter {
  const schemas = minecraftSchemaCatalog();
  const compatibility = adapterCompatibility(descriptor, schemas);
  descriptor = compatibility.descriptor;
  if (descriptor.observation.profile.id !== "minecraft_assisted_rgb_fov_r8_control_v8" || descriptor.observation.profile.version !== 8)
    throw new Error("Minecraft adapter requires its registered control-feedback profile");
  const configuration = minecraftProfileConfigurationSchema.parse(descriptor.observation.profile.configuration);
  const now = options.now ?? Date.now;
  const adapterId = descriptor.adapter.id;
  const goal = (id: string, verifier: string, parameters: Json): AdapterGoal => ({ adapter_id: adapterId,
    goal_id: id, verifier: { id: verifier, version: 2 }, parameters });
  const catalog: Record<string, AdapterGoal> = {
    break_log: goal("break_log", "minecraft_block_removal_v2", {}),
    collect_wood: goal("collect_wood", "minecraft_possession_v2", { criterion: "eligible_wood_inventory_gain" }),
    obtain_stone: goal("obtain_stone", "minecraft_possession_v2", { criterion: "stone_or_cobblestone_inventory_gain" }),
    craft_crafting_table: goal("craft_crafting_table", "minecraft_possession_v2", { criterion: "produced_and_retained", item: "crafting_table" }),
    craft_stone_pickaxe: goal("craft_stone_pickaxe", "minecraft_possession_v2", { criterion: "produced_and_retained", item: "stone_pickaxe" }),
    craft_iron_pickaxe: goal("craft_iron_pickaxe", "minecraft_possession_v2", { criterion: "produced_and_retained", item: "iron_pickaxe" }),
    collect_and_craft_table: goal("collect_and_craft_table", "minecraft_collection_craft_v2", { criterion: "prior_own_wood_then_produced_retained_table" }),
    custom: { adapter_id: adapterId, goal_id: "custom", verifier: null, parameters: {} },
  };
  const descriptions: Record<string, { label: string; prompt: string }> = {
    break_log: { label: "Break a log", prompt: "Remove an eligible log, wood, stem or hyphae block with a confirmed own server block-removal receipt. Inventory gain is not required." },
    collect_wood: { label: "Collect wood", prompt: "Acquire additional own log, wood, stem or hyphae inventory relative to the run-start baseline." },
    obtain_stone: { label: "Obtain stone", prompt: "Acquire additional own stone or cobblestone inventory relative to the run-start baseline." },
    craft_crafting_table: { label: "Craft a crafting table", prompt: "Produce a crafting table with authoritative own effect evidence and retain a table in fresh alive inventory." },
    craft_stone_pickaxe: { label: "Craft a stone pickaxe", prompt: "Produce a stone pickaxe with authoritative own effect evidence and retain it in fresh alive inventory." },
    craft_iron_pickaxe: { label: "Craft an iron pickaxe", prompt: "Produce an iron pickaxe with authoritative own effect evidence and retain it in fresh alive inventory." },
    collect_and_craft_table: { label: "Collect wood and craft a table", prompt: "Establish own wood acquisition before producing a crafting table, then retain a table in fresh alive inventory." },
    custom: { label: "Custom task", prompt: "Pursue the supplied task; task_finish reports unverified model completion, never trusted verification." },
  };
  function declaredGoal(selected: AdapterGoal): AdapterGoal {
    if (!Object.hasOwn(catalog, selected.goal_id)) throw new Error("Adapter goal verifier is not registered");
    const expected = catalog[selected.goal_id]!;
    if (selected.adapter_id !== adapterId || selected.verifier?.id !== expected.verifier?.id ||
      selected.verifier?.version !== expected.verifier?.version || canonicalContractJson(selected.parameters) !== canonicalContractJson(expected.parameters))
      throw new Error("Adapter goal/verifier identity does not match its declared criterion");
    return expected;
  }
  function observation(value: ObservationV3) {
    const parsed = minecraftObservationV3Schema.parse(value);
    if (parsed.compatibility_hash !== compatibility.compatibility_hash || parsed.profile_id !== descriptor.observation.profile.id ||
      parsed.profile_configuration_hash !== descriptor.observation.profile.configuration_hash || parsed.freshness.max_age_ms > configuration.sampler.max_age_ms)
      throw new Error("Minecraft observation does not match its negotiated effective profile");
    return parsed;
  }
  const productionHash = contractHash(schemas.evidence!["minecraft_item_production_v1@1"]);
  const transactionHash = contractHash(schemas.evidence!["minecraft_gui_transaction_v1@1"]);
  const removalHash = contractHash(schemas.evidence!["minecraft_block_removal_v1@1"]);
  const uncertaintyHash = contractHash(schemas.evidence!["minecraft_effect_uncertainty_v1@1"]);
  // Runtime and independent evaluation own distinct manifest objects. Retain only
  // criterion facts, never whole observation history or shared evaluator state.
  const progress = new WeakMap<VerificationManifest, { lives: Map<number, VerifierLifeProgress>; removal: string | null }>();
  return {
    descriptor: compatibility.descriptor, schemas, goals: Object.values(catalog),
    capabilityValidators: { "minecraft.action@4": action => minecraftActionSchema.safeParse(action).success },
    goalChoices: Object.entries(descriptions).map(([id, value]) => ({ id, goal: catalog[id]!, ...value })),
    action_capability: { id: "minecraft.action", version: 4 },
    supports_respawn: true,
    bindings: [{ name: "recipes", capability_id: "minecraft.recipes", version: 1, parameters: ["item"],
      result: { type: "Json", schema: { type: "array", items: {},
        description: "Read only client-synchronized, unlocked shaped/shapeless crafting displays matching item, an item registry path without a namespace. [] means no matching display is currently exposed/unlocked; it does not prove recipe impossibility or absence of world resources. This is not a complete recipe catalogue." } } },
      { name: "screen", capability_id: "minecraft.visible_screen", version: 1, parameters: [],
        result: { type: "VisibleScreenSnapshot|null", schema: jsonSchema.parse(z.toJSONSchema(visibleScreenSnapshotSchema.nullable())) } },
      { name: "frame", capability_id: "minecraft.controller_frame", version: 2, parameters: ["audio_cursor"],
        result: { type: "MinecraftControllerFrame", schema: jsonSchema.parse(z.toJSONSchema(minecraftControllerFrameSchema)) } }],
    screenPrecondition(action, screen) {
      const request = minecraftActionSchema.parse(action);
      if (request.kind !== "screen_input") return screen ? { kind: "transaction", screen: { ...screen } } : { kind: "absent" };
      const expected = { kind: "layout" as const, screen: { ...request.screen } };
      if (!screenPreconditionMatches(expected, screen)) throw new Error("Visible GUI identity/incarnation is stale");
      return expected;
    },
    effectDeadlineMs(action) {
      const request = minecraftActionSchema.parse(action);
      if (request.kind === "screen_input") return 5000 + 4000 * request.operations.length;
      if (request.kind === "world_input") return request.steps.reduce((ticks, step) => ticks + step.ticks, 0) * 50 + 2000;
      if (request.kind === "move" || request.kind === "navigate") return request.duration_ms + 2000;
      if (request.kind === "respawn") return 15000;
      // Native gestures keep world time advancing; include its bounded session
      // deadline and receipt drain without extending the owning root budget.
      if (request.kind === "craft") return 13000 + 35000 * ("sequence" in request
        ? request.sequence.reduce((total, stage) => total + stage.executions, 0) : request.executions);
      if (request.kind === "equip") return 15000;
      if (request.kind === "place") return 23000;
      return request.kind === "dig" ? 12000 : 5000;
    },
    projectObservation(value, previous) {
      const current = observation(value);
      const counts = minecraftInventoryCounts(current.data);
      const prior = previous && previous.world_id === current.world_id && previous.session_id === current.session_id &&
        previous.native_boot_id === current.native_boot_id && previous.life.life_id === current.life.life_id
        ? minecraftInventoryCounts(observation(previous).data) : counts;
      const changes: Record<string, number> = Object.create(null);
      for (const name of Object.keys(prior)) if ((counts[name] ?? 0) !== prior[name]) changes[name] = (counts[name] ?? 0) - prior[name]!;
      for (const name of Object.keys(counts)) if (!(name in prior) && counts[name] !== 0) changes[name] = counts[name]!;
      return { state: current.data, summary: "Authorized own-player state and assisted nearby observations",
        metadata: { adapter_id: adapterId, profile_id: descriptor.observation.profile.id,
          position_units: "world_blocks", yaw_units: "absolute_world_radians", pitch_units: "absolute_radians_positive_up",
          actor_image_alignment: "unsynchronized", terrain_sampler: "camera_independent_raycast_radius_8",
          entity_sampler: "actual_render_camera_same_framebuffer_optical_radius_8",
          inventory_counts: counts, inventory_change: changes } };
    },
    captureBaseline(selected, value) {
      declaredGoal(selected);
      const current = observation(value);
      return { schema_version: 1, world_id: current.world_id, session_id: current.session_id, epoch: current.epoch,
        native_boot_id: current.native_boot_id, life_id: current.life.life_id, observation_seq: current.observation_seq,
        captured_at: current.captured_at, inventory: minecraftInventoryCounts(current.data) };
    },
    verifyCompletion(manifest, events) {
      const selected = declaredGoal(manifest.goal);
      const verdict = (status: VerificationResult["status"], reason: string, refs: string[] = []): VerificationResult => ({
        adapter_id: adapterId, verifier_id: selected.verifier?.id ?? "custom_unverified", verifier_version: selected.verifier?.version ?? 0,
        status, reason, evidence_refs: refs,
      });
      if (selected.verifier === null) return verdict("unknown", "custom_completion_is_model_reported_unverified");
      const baseline = minecraftGoalBaselineSchema.safeParse(manifest.baseline);
      if (!baseline.success) return verdict("unknown", "own_inventory_baseline_unavailable");
      const initial = baseline.data;
      if (initial.world_id !== manifest.world_id || initial.session_id !== manifest.session_id || initial.epoch !== manifest.epoch ||
        initial.native_boot_id !== manifest.native_boot_id) return verdict("unknown", "goal_scope_changed");
      const baselineAt = Date.parse(initial.captured_at);
      if (!Number.isFinite(baselineAt)) return verdict("unknown", "baseline_time_unavailable");
      let latest: MinecraftObservation | null = null, latestRef: string | null = null;
      let retained = progress.get(manifest);
      if (!retained) { retained = { lives: new Map(), removal: null }; progress.set(manifest, retained); }
      let removal: string | null = retained.removal;
      const wood: Record<string, { at: number; ref: string }> = Object.create(null);
      const products: { life: number; at: number; item: string; ref: string }[] = [];
      const uncertainProduction: Record<string, true> = Object.create(null);
      for (const [life, state] of retained.lives) {
        if (state.wood) wood[life] = state.wood;
        for (const product of Object.values(state.products)) products.push(product);
        if (state.uncertainProduction) uncertainProduction[life] = true;
      }
      for (const event of events) {
        if (event.adapter_id !== adapterId || !ownScope(event, manifest)) continue;
        const at = Date.parse(event.observed_at);
        if (!Number.isFinite(at) || at < baselineAt) continue;
        if (event.schema.id === "observation_v3" && event.schema.version === 3 && event.schema.hash === descriptor.observation.schema_hash) {
          const parsed = minecraftObservationV3Schema.safeParse(event.data);
          if (!parsed.success) continue;
          const current = parsed.data;
          if (current.world_id !== manifest.world_id || current.session_id !== manifest.session_id || current.epoch !== manifest.epoch ||
            current.native_boot_id !== manifest.native_boot_id || current.compatibility_hash !== compatibility.compatibility_hash ||
            current.profile_id !== descriptor.observation.profile.id || current.profile_configuration_hash !== descriptor.observation.profile.configuration_hash ||
            current.life.life_id !== event.scope.life_id || current.space.space_epoch !== event.scope.space_epoch ||
            current.observation_seq <= initial.observation_seq) continue;
          const capturedAt = Date.parse(current.captured_at);
          if (!Number.isFinite(capturedAt) || capturedAt < baselineAt) continue;
          if (!latest || current.observation_seq > latest.observation_seq) { latest = current; latestRef = event.evidence_id; }
          if (selected.goal_id === "collect_and_craft_table" && current.life.status === "alive" &&
            gain(minecraftInventoryCounts(current.data), initial.inventory, true)) {
            const previous = wood[current.life.life_id];
            if (!previous || capturedAt < previous.at) wood[current.life.life_id] = { at: capturedAt, ref: event.evidence_id };
          }
        } else if (event.schema.id === "minecraft_item_production_v1" && event.schema.version === 1 && event.schema.hash === productionHash) {
          const parsed = minecraftProductionFactSchema.safeParse(event.data);
          if (!parsed.success) continue;
          const fact = parsed.data;
          if ((fact.inventory_after[fact.item] ?? 0) <= (fact.inventory_before[fact.item] ?? 0)) continue;
          products.push({ life: event.scope.life_id, at, item: fact.item, ref: event.evidence_id });
          if (gain(fact.inventory_before, initial.inventory, true) || gain(fact.inventory_after, initial.inventory, true)) {
            const previous = wood[event.scope.life_id];
            if (!previous || at < previous.at) wood[event.scope.life_id] = { at, ref: event.evidence_id };
          }
        } else if (event.schema.id === "minecraft_gui_transaction_v1" && event.schema.version === 1 && event.schema.hash === transactionHash) {
          const parsed = minecraftGuiTransactionFactSchema.safeParse(event.data);
          if (!parsed.success) continue;
          for (const production of parsed.data.productions) if (production.production_confirmed && production.producer === "crafting")
            products.push({ life: event.scope.life_id, at, item: production.item, ref: event.evidence_id });
          if (gain(parsed.data.inventory_before, initial.inventory, true) || gain(parsed.data.inventory_after, initial.inventory, true)) {
            const previous = wood[event.scope.life_id];
            if (!previous || at < previous.at) wood[event.scope.life_id] = { at, ref: event.evidence_id };
          }
        } else if (event.schema.id === "minecraft_block_removal_v1" && event.schema.version === 1 && event.schema.hash === removalHash) {
          const fact = minecraftBlockRemovalFactSchema.safeParse(event.data);
          if (fact.success && eligibleMinecraftWood(fact.data.target_name)) removal = event.evidence_id;
        } else if (event.schema.id === "minecraft_effect_uncertainty_v1" && event.schema.version === 1 && event.schema.hash === uncertaintyHash) {
          const fact = minecraftEffectUncertaintyFactSchema.safeParse(event.data);
          if (fact.success && (fact.data.operation_kind === "craft" || fact.data.operation_kind === "screen_input")) uncertainProduction[event.scope.life_id] = true;
        }
      }
      if (latest) for (const life of retained.lives.keys()) if (life !== latest.life.life_id) retained.lives.delete(life);
      const lifeProgress = (life: number) => {
        if (latest && life !== latest.life.life_id) return null;
        let state = retained.lives.get(life);
        if (!state) { state = { wood: null, products: Object.create(null), uncertainProduction: false }; retained.lives.set(life, state); }
        return state;
      };
      for (const key of Object.keys(wood)) { const state = lifeProgress(Number(key)); if (state) state.wood = wood[key]!; }
      for (const product of products) if (product.item === "crafting_table" || product.item === "stone_pickaxe" || product.item === "iron_pickaxe") {
        const state = lifeProgress(product.life);
        if (state && (!state.products[product.item] || product.at > state.products[product.item]!.at)) state.products[product.item] = product;
      }
      for (const key of Object.keys(uncertainProduction)) { const state = lifeProgress(Number(key)); if (state) state.uncertainProduction = true; }
      retained.removal = removal;
      if (selected.goal_id === "break_log") return removal ? verdict("verified", "own_server_confirmed_block_removal", [removal])
        : verdict("incomplete", "eligible_block_removal_not_observed");
      if (!latest || !latestRef) return verdict("unknown", "fresh_own_observation_unavailable");
      const capturedAt = Date.parse(latest.captured_at), age = now() - capturedAt;
      if (age < -1000 || age > latest.freshness.max_age_ms || latest.freshness.max_age_ms > configuration.sampler.max_age_ms)
        return verdict("unknown", "own_observation_is_stale_or_future_dated");
      if (latest.life.status !== "alive") return verdict("incomplete", "own_alive_possession_not_observed");
      const counts = minecraftInventoryCounts(latest.data);
      if (selected.goal_id === "collect_wood" || selected.goal_id === "obtain_stone")
        return gain(counts, initial.inventory, selected.goal_id === "collect_wood")
          ? verdict("verified", "own_inventory_gain", [latestRef]) : verdict("incomplete", "eligible_inventory_gain_not_observed");
      const item = selected.goal_id === "craft_stone_pickaxe" ? "stone_pickaxe" : selected.goal_id === "craft_iron_pickaxe" ? "iron_pickaxe" : "crafting_table";
      if ((counts[item] ?? 0) <= 0) return verdict("incomplete", "produced_item_not_retained");
      for (const product of products) {
        if (product.item !== item || product.life !== latest.life.life_id || product.at > capturedAt) continue;
        if (selected.goal_id === "collect_and_craft_table") {
          const acquisition = wood[product.life];
          if (!acquisition || acquisition.at > product.at) continue;
          return verdict("verified", "prior_own_wood_then_produced_retained_table", [acquisition.ref, product.ref, latestRef]);
        }
        return verdict("verified", "own_production_and_retained_possession", [product.ref, latestRef]);
      }
      return uncertainProduction[latest.life.life_id] ? verdict("unknown", "own_production_receipt_unconfirmed")
        : verdict("incomplete", "authoritative_own_production_not_observed");
    },
    effectEvidence(scope, operationId, action, result, at) {
      const parsed = minecraftActionSchema.safeParse(action);
      if (!parsed.success) return [];
      const request = parsed.data;
      const evidence = result.evidence !== null && typeof result.evidence === "object" && !Array.isArray(result.evidence) ? result.evidence : null;
      if (request.kind === "screen_input") {
        const facts: AdapterEvidence[] = [];
        // Confirmed prefix receipts remain real even when later application/ACK is unknown.
        for (const fact of confirmedMinecraftGuiTransactions(request, evidence)) {
          facts.push({ evidence_id: `${operationId}:gui:${fact.operation_index}`, adapter_id: adapterId,
            schema: { id: "minecraft_gui_transaction_v1", version: 1, hash: transactionHash }, scope, observed_at: at, data: fact });
        }
        if (result.status === "unknown" || evidence?.transaction_status === "unknown") {
          const data = minecraftEffectUncertaintyFactSchema.parse({ kind: "effect_uncertainty", actor: "own_player", mechanism: "visible_gui",
            operation_kind: request.kind, effect_status: "unknown", receipt_ref: operationId, reason: "effect_unconfirmed" });
          facts.push({ evidence_id: `${operationId}:uncertainty`, adapter_id: adapterId,
            schema: { id: "minecraft_effect_uncertainty_v1", version: 1, hash: uncertaintyHash }, scope, observed_at: at, data });
        }
        return facts;
      }
      if (request.kind === "craft" && ("sequence" in request || evidence?.craft_stages !== undefined)) {
        const requested = "sequence" in request ? request.sequence : [request];
        const facts: AdapterEvidence[] = [];
        const stages = confirmedMinecraftCraftStages(request, evidence);
        const confirmedStages = stages.filter(stage => stage.status === "succeeded").length;
        for (const stage of stages) {
          const data = minecraftProductionFactSchema.parse({ kind: "item_production", item: stage.item, actor: "own_player",
            mechanism: "helper", input_application: "confirmed", effect_status: "confirmed",
            inventory_before: stage.inventory_before, inventory_after: stage.inventory_after, receipt_ref: stage.receipt_ref });
          facts.push({ evidence_id: `${operationId}:craft:${stage.stage_index}:production`, adapter_id: adapterId,
            schema: { id: "minecraft_item_production_v1", version: 1, hash: productionHash }, scope, observed_at: at, data });
        }
        if (result.status === "unknown" || result.status === "succeeded" && confirmedStages !== requested.length) {
          const data = minecraftEffectUncertaintyFactSchema.parse({ kind: "effect_uncertainty", actor: "own_player", mechanism: "helper",
            operation_kind: request.kind, effect_status: "unknown", receipt_ref: operationId,
            reason: result.status === "unknown" ? "effect_unconfirmed" : "inventory_receipt_unconfirmed" });
          facts.push({ evidence_id: `${operationId}:uncertainty`, adapter_id: adapterId,
            schema: { id: "minecraft_effect_uncertainty_v1", version: 1, hash: uncertaintyHash }, scope, observed_at: at, data });
        }
        return facts;
      }
      if (result.status === "unknown" || request.kind === "craft" && result.status === "succeeded" &&
        (evidence?.effect_confirmed !== true || evidence?.inventory_receipt_confirmed !== true)) {
        const data = minecraftEffectUncertaintyFactSchema.parse({ kind: "effect_uncertainty", actor: "own_player", mechanism: "helper",
          operation_kind: request.kind, effect_status: "unknown", receipt_ref: operationId,
          reason: result.status === "unknown" ? "effect_unconfirmed" : "inventory_receipt_unconfirmed" });
        return [{ evidence_id: `${operationId}:uncertainty`, adapter_id: adapterId,
          schema: { id: "minecraft_effect_uncertainty_v1", version: 1, hash: uncertaintyHash }, scope, observed_at: at, data }];
      }
      if (result.status !== "succeeded" || evidence?.effect_confirmed !== true) return [];
      if (request.kind === "dig" && evidence.source === "server_block_update" && typeof evidence.target_name === "string") {
        const data = minecraftBlockRemovalFactSchema.safeParse({ kind: "block_removal", actor: "own_player", mechanism: "helper",
          effect_status: "confirmed", source: evidence.source, target_name: evidence.target_name, receipt_ref: operationId });
        return data.success ? [{ evidence_id: `${operationId}:block-removal`, adapter_id: adapterId,
          schema: { id: "minecraft_block_removal_v1", version: 1, hash: removalHash }, scope, observed_at: at, data: data.data }] : [];
      }
      // Current helpers are one factual producer, NOT a universal verifier rule.
      if (request.kind !== "craft" || !("item" in request) || evidence.inventory_receipt_confirmed !== true) return [];
      const data = minecraftProductionFactSchema.safeParse({ kind: "item_production", item: request.item, actor: "own_player", mechanism: "helper",
        input_application: "confirmed", effect_status: "confirmed", inventory_before: evidence.inventory_before,
        inventory_after: evidence.inventory_after, receipt_ref: operationId });
      return data.success ? [{ evidence_id: `${operationId}:production`, adapter_id: adapterId,
        schema: { id: "minecraft_item_production_v1", version: 1, hash: productionHash }, scope, observed_at: at, data: data.data }] : [];
    },
  };
}
