import { expect, test } from "bun:test";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import type { AdapterDescriptor, AdapterEvidence, GameActionResult, Json, VerificationManifest } from "../src/shared/contracts.ts";
import type { EffectScope } from "../src/shared/control.ts";
import type { HistoricalObservationV2, MinecraftObservation, MinecraftSoundObservation } from "../src/shared/minecraft.ts";
import { historicalObservationV2Schema, minecraftObservationV3Schema, minecraftProfileConfiguration } from "../src/shared/minecraft.ts";
import { getGameAPIReference } from "../src/shared/validation.ts";
import { contractHash } from "../src/server/adapter-contract.ts";
import { createMinecraftAdapter } from "../src/server/minecraft-adapter.ts";
import { minecraftSchemaCatalog } from "../src/server/native-contract.ts";
import { RegisteredAdapterContract } from "../src/server/registered-adapter.ts";
import { historicalObservation } from "./helpers/adapter-contract.ts";

const now = Date.parse("2026-10-25T12:00:00Z");
function fixture(goalId: string, initial: Record<string, number> = {}) {
  const schemas = minecraftSchemaCatalog(), configuration = minecraftProfileConfiguration();
  // Schema/predicate conformance only. An arbitrary test build ID is not a claim
  // that native gameplay, a GUI receipt producer or a second game was exercised.
  const descriptor: AdapterDescriptor = { descriptor_schema: 1, game: { id: "minecraft", version: "1.21.4" },
    adapter: { id: "fabric-owned-client", version: "1.0.0", build_hash: "a".repeat(64) },
    observation: { schema_version: 3, schema_hash: contractHash(schemas.observation),
      payload_schema: { id: "minecraft_observation_v1", version: 2, hash: contractHash(schemas.payload) },
      profile: { id: "minecraft_assisted_rgb_360_r8_control_v6", version: 6, configuration, configuration_hash: contractHash(configuration) } },
    capabilities: [
      { id: "minecraft.action", version: 4, schema_hash: contractHash(schemas.capabilities["minecraft.action@4"]) },
      { id: "minecraft.recipes", version: 1, schema_hash: contractHash(schemas.capabilities["minecraft.recipes@1"]) },
      { id: "minecraft.visible_screen", version: 1, schema_hash: contractHash(schemas.capabilities["minecraft.visible_screen@1"]) },
      { id: "minecraft.controller_frame", version: 2, schema_hash: contractHash(schemas.capabilities["minecraft.controller_frame@2"]) },
    ], actuator: "native", executable: { api_version: 5, validator_version: 5, runtime_version: 5 } };
  const adapter = createMinecraftAdapter(descriptor, { now: () => now });
  const scope: EffectScope = { world_id: "world", session_id: "session", epoch: 2147483665, native_boot_id: "boot",
    run_id: "run", run_generation: 7, life_id: 3, space_epoch: 4, execution_id: "own-invocation", source_hash: "b".repeat(64) };
  function observation(inventory: Record<string, number>, seq = 2, at = now): MinecraftObservation {
    return { schema_version: 3, world_id: scope.world_id, session_id: scope.session_id, epoch: scope.epoch,
      native_boot_id: scope.native_boot_id, life: { life_id: scope.life_id, status: "alive", can_respawn: false, death: null },
      space: { dimension_id: "minecraft:overworld", space_epoch: scope.space_epoch }, screen: null,
      observation_seq: seq, captured_at: new Date(at).toISOString(), compatibility_hash: contractHash(adapter.descriptor),
      profile_id: descriptor.observation.profile.id, profile_configuration_hash: descriptor.observation.profile.configuration_hash,
      freshness: { max_age_ms: 1000, partial: true }, data: {
        player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false,
          inventory: Object.entries(inventory).map(([name, count], slot) => ({ name, count, slot, display_name: name })) },
        blocks: [], entities: [], sounds: [],
      } };
  }
  const goal = adapter.goals.find(value => value.goal_id === goalId)!;
  const baseline = adapter.captureBaseline(goal, observation(initial, 1, now - 10000));
  const manifest: VerificationManifest = { goal, run_id: scope.run_id, world_id: scope.world_id, session_id: scope.session_id,
    epoch: scope.epoch, native_boot_id: scope.native_boot_id, baseline };
  function observed(current: MinecraftObservation): AdapterEvidence {
    return { evidence_id: `observation-${current.observation_seq}`, adapter_id: descriptor.adapter.id,
      schema: { id: "observation_v3", version: 3, hash: descriptor.observation.schema_hash },
      scope: { ...scope, life_id: current.life.life_id, space_epoch: current.space.space_epoch },
      observed_at: current.captured_at, data: JSON.parse(JSON.stringify(current)) };
  }
  function production(item: string, before: Record<string, number>, after: Record<string, number>, at = now - 500) {
    const result: GameActionResult = { status: "succeeded", summary: "Contract-only confirmed native helper receipt",
      evidence: { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: before, inventory_after: after } };
    return adapter.effectEvidence!(scope, `produce-${item}`, { kind: "craft", item, executions: 1 }, result, new Date(at).toISOString());
  }
  return { adapter, descriptor, scope, manifest, observation, observed, production };
}

test("ordinary sound cues survive registered admission and projection with combat-only wire semantics", () => {
  const f = fixture("custom"), current = f.observation({});
  const registry = new RegisteredAdapterContract(f.adapter.descriptor, f.adapter.schemas, f.adapter.capabilityValidators);
  const helpPayload = Reflect.get(getGameAPIReference(f.adapter), "schemas").AdapterData;
  const generic: MinecraftSoundObservation = {
    category: "combat", cue: null, direction: "NE", distance: "near", observed_at: current.captured_at,
  };
  const primed: MinecraftSoundObservation = { ...generic, category: "combat", cue: "creeper_primed" };
  const withSounds = (sounds: Json[]) => ({ ...current, data: { ...current.data, sounds } });
  for (const category of ["movement", "interaction", "combat", "creature", "weather"] as const) {
    const value = withSounds([{ ...generic, category }, primed]);
    expect(minecraftObservationV3Schema.safeParse(value).success).toBe(true);
    expect(validateJsonSchemaValue(helpPayload, value.data).success).toBe(true);
    expect(registry.parseObservation(value).data).toEqual(value.data);
  }
  const { cue: _cue, ...missingCue } = generic;
  for (const invalid of [
    missingCue, { ...generic, cue: "creeper_fuse" },
    { ...primed, category: "movement" }, { ...primed, category: "creature" },
    { ...primed, source_position: { x: 1, y: 64, z: 1 } }, { ...primed, fuse_ticks: 20 },
    { ...primed, entity_id: "hidden-source" },
  ]) {
    const value = withSounds([invalid]);
    expect(minecraftObservationV3Schema.safeParse(value).success).toBe(false);
    expect(validateJsonSchemaValue(helpPayload, value.data).success).toBe(false);
    expect(() => registry.parseObservation(value)).toThrow();
  }
  for (const count of [8, 9]) {
    const value = withSounds(Array.from({ length: count }, () => primed));
    expect(minecraftObservationV3Schema.safeParse(value).success).toBe(count === 8);
    expect(validateJsonSchemaValue(helpPayload, value.data).success).toBe(count === 8);
    if (count === 8) expect(registry.parseObservation(value).data).toEqual(value.data);
    else expect(() => registry.parseObservation(value)).toThrow();
  }
});

test("historical schema2 sounds remain unchanged no-cue data, not active observation compatibility", () => {
  const historical: HistoricalObservationV2 = { ...historicalObservation(), sounds: [
    { category: "combat", direction: "NE", distance: "near", observed_at: "2026-10-22T00:00:00Z" },
  ] };
  expect(historicalObservationV2Schema.parse(historical)).toEqual(historical);
  expect(historicalObservationV2Schema.safeParse({ ...historical,
    sounds: historical.sounds.map(sound => ({ ...sound, cue: null })) }).success).toBe(false);
  const f = fixture("custom"), current = f.observation({});
  expect(minecraftObservationV3Schema.safeParse({ ...current,
    data: { ...current.data, sounds: historical.sounds } }).success).toBe(false);
  expect(minecraftObservationV3Schema.safeParse(historical).success).toBe(false);
});

test("own wood collection requires real gain over baseline, not existing wood, planks or visible blocks", () => {
  const f = fixture("collect_wood", { oak_log: 1 });
  const unchanged: Record<string, number>[] = [{ oak_log: 1 }, { oak_planks: 4 }];
  for (const inventory of unchanged)
    expect(f.adapter.verifyCompletion(f.manifest, [f.observed(f.observation(inventory))]).status).toBe("incomplete");
  expect(f.adapter.verifyCompletion(f.manifest, [f.observed(f.observation({ oak_log: 2 }))])).toMatchObject({
    status: "verified", verifier_id: "minecraft_possession_v2", verifier_version: 2, evidence_refs: ["observation-2"] });
});

for (const item of ["stone", "cobblestone"]) {
  test(`own ${item} inventory gain is accepted independently of any action label`, () => {
    const f = fixture("obtain_stone");
    expect(f.adapter.verifyCompletion(f.manifest, [f.observed(f.observation({ [item]: 1 }))]).status).toBe("verified");
  });
}

test("crafting consumes typed production facts and retained own possession, never a universal action.kind predicate", () => {
  const f = fixture("craft_crafting_table");
  const current = f.observed(f.observation({ crafting_table: 1 }));
  expect(f.adapter.verifyCompletion(f.manifest, [current]).status).toBe("incomplete");
  const facts = f.production("crafting_table", { oak_planks: 4 }, { crafting_table: 1 });
  expect(f.adapter.verifyCompletion(f.manifest, [...facts, current])).toMatchObject({ status: "verified", verifier_id: "minecraft_possession_v2" });
  expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({}))]).status).toBe("incomplete");
});

test("iron crafting retains production across polls while independent evaluation must consume its own evidence", () => {
  const f = fixture("craft_iron_pickaxe");
  const facts = f.production("iron_pickaxe", {}, { iron_pickaxe: 1 });
  const current = f.observed(f.observation({ iron_pickaxe: 1 }));
  expect(f.adapter.verifyCompletion(f.manifest, facts)).toMatchObject({
    status: "unknown", reason: "fresh_own_observation_unavailable" });
  expect(f.adapter.verifyCompletion(f.manifest, [current])).toMatchObject({
    status: "verified", verifier_id: "minecraft_possession_v2", verifier_version: 2,
    reason: "own_production_and_retained_possession", evidence_refs: ["produce-iron_pickaxe:production", "observation-2"] });
  const independent = { ...f.manifest };
  expect(f.adapter.verifyCompletion(independent, [current]).status).toBe("incomplete");
  expect(f.adapter.verifyCompletion(independent, [...facts, current]).status).toBe("verified");
  expect(f.adapter.verifyCompletion(f.manifest, [f.observed(f.observation({}, 3))])).toMatchObject({
    status: "incomplete", reason: "produced_item_not_retained" });
});

for (const preexisting of [false, true]) {
  test(`${preexisting ? "preexisting" : "gifted"} iron possession cannot replace own iron production`, () => {
    const f = fixture("craft_iron_pickaxe", preexisting ? { iron_pickaxe: 1 } : {});
    const current = f.observed(f.observation({ iron_pickaxe: 1, stone_pickaxe: 1 }));
    expect(f.adapter.verifyCompletion(f.manifest, [current])).toMatchObject({
      status: "incomplete", reason: "authoritative_own_production_not_observed" });
    expect(f.adapter.verifyCompletion(f.manifest, [...f.production("stone_pickaxe", {}, { stone_pickaxe: 1 }), current]).status)
      .toBe("incomplete");
  });
}

for (const field of ["run_id", "world_id", "session_id", "epoch", "native_boot_id", "life_id"] as const) {
  test(`iron crafting rejects production from a different ${field}`, () => {
    const f = fixture("craft_iron_pickaxe");
    const facts = f.production("iron_pickaxe", {}, { iron_pickaxe: 1 }).map(event => ({
      ...event, scope: { ...event.scope, [field]: typeof event.scope[field] === "number" ? Number(event.scope[field]) + 1 : "foreign" },
    }));
    expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({ iron_pickaxe: 1 }))])).toMatchObject({
      status: "incomplete", reason: "authoritative_own_production_not_observed" });
  });
}

for (const boundary of ["stale", "future", "dead", "baseline sequence", "foreign world", "foreign session"] as const) {
  test(`iron crafting cannot use ${boundary} possession`, () => {
    const f = fixture("craft_iron_pickaxe"), current = f.observation({ iron_pickaxe: 1 });
    if (boundary === "stale") current.captured_at = new Date(now - 1001).toISOString();
    if (boundary === "future") current.captured_at = new Date(now + 1001).toISOString();
    if (boundary === "dead") current.life.status = "dead";
    if (boundary === "baseline sequence") current.observation_seq = 1;
    if (boundary === "foreign world") current.world_id = "foreign";
    if (boundary === "foreign session") current.session_id = "foreign";
    expect(f.adapter.verifyCompletion(f.manifest, [...f.production("iron_pickaxe", {}, { iron_pickaxe: 1 }), f.observed(current)]).status)
      .not.toBe("verified");
  });
}

for (const at of [now - 10001, now + 1, now + 1001]) {
  test(`iron production at ${at - now}ms must occur within the run and no later than possession`, () => {
    const f = fixture("craft_iron_pickaxe");
    expect(f.adapter.verifyCompletion(f.manifest, [
      ...f.production("iron_pickaxe", {}, { iron_pickaxe: 1 }, at), f.observed(f.observation({ iron_pickaxe: 1 })),
    ]).status).toBe("incomplete");
  });
}

test("iron production at the possession timestamp is eligible without an inventory gain over the baseline tool count", () => {
  const f = fixture("craft_iron_pickaxe", { iron_pickaxe: 1 });
  expect(f.adapter.verifyCompletion(f.manifest, [
    ...f.production("iron_pickaxe", {}, { iron_pickaxe: 1 }, now), f.observed(f.observation({ iron_pickaxe: 1 })),
  ]).status).toBe("verified");
});

for (const receipt of ["unknown", "unconfirmed effect", "unconfirmed inventory", "no production gain"] as const) {
  test(`an iron ${receipt} receipt cannot certify possession`, () => {
    const f = fixture("craft_iron_pickaxe");
    const facts = f.adapter.effectEvidence!(f.scope, "iron-receipt", { kind: "craft", item: "iron_pickaxe", executions: 1 },
      { status: receipt === "unknown" ? "unknown" : "succeeded", summary: "Contract-only iron receipt",
        evidence: { effect_confirmed: receipt !== "unconfirmed effect", inventory_receipt_confirmed: receipt !== "unconfirmed inventory",
          inventory_before: receipt === "no production gain" ? { iron_pickaxe: 1 } : {}, inventory_after: { iron_pickaxe: 1 } } },
      new Date(now - 500).toISOString());
    expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({ iron_pickaxe: 1 }))])).toMatchObject(
      receipt === "no production gain" ? { status: "incomplete", reason: "authoritative_own_production_not_observed" }
        : { status: "unknown", reason: "own_production_receipt_unconfirmed" });
  });
}

for (const [field, value] of [["actor", "another_player"], ["input_application", "unknown"], ["effect_status", "unknown"]] as const) {
  test(`iron production rejects native ${field}=${value}`, () => {
    const f = fixture("craft_iron_pickaxe");
    const facts = f.production("iron_pickaxe", {}, { iron_pickaxe: 1 }).map(event => {
      const data = event.data;
      return { ...event, data: { ...(data !== null && typeof data === "object" && !Array.isArray(data) ? data : {}), [field]: value } };
    });
    expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({ iron_pickaxe: 1 }))]).status).toBe("incomplete");
  });
}

test("death and respawn require iron production in the new life, even with cumulative old receipts", () => {
  const f = fixture("craft_iron_pickaxe"), facts = f.production("iron_pickaxe", {}, { iron_pickaxe: 1 });
  expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({ iron_pickaxe: 1 }))]).status).toBe("verified");
  const dead = f.observation({ iron_pickaxe: 1 }, 3);
  dead.life.status = "dead";
  expect(f.adapter.verifyCompletion(f.manifest, [f.observed(dead)])).toMatchObject({
    status: "incomplete", reason: "own_alive_possession_not_observed" });
  const respawned = f.observation({ iron_pickaxe: 1 }, 4);
  respawned.life.life_id = 4;
  const current = f.observed(respawned);
  expect(f.adapter.verifyCompletion(f.manifest, [...facts, current]).status).toBe("incomplete");
  expect(f.adapter.verifyCompletion(f.manifest, [current]).status).toBe("incomplete");
  const newLifeProduction = facts.map(event => ({ ...event, evidence_id: "new-life-production",
    observed_at: new Date(now).toISOString(), scope: { ...event.scope, life_id: 4 } }));
  expect(f.adapter.verifyCompletion(f.manifest, [...newLifeProduction, current])).toMatchObject({
    status: "verified", evidence_refs: ["new-life-production", "observation-4"] });
});

test("a reset iron baseline cannot inherit earlier production from the prior manifest", () => {
  const f = fixture("craft_iron_pickaxe"), facts = f.production("iron_pickaxe", {}, { iron_pickaxe: 1 });
  expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({ iron_pickaxe: 1 }))]).status).toBe("verified");
  const reset = { ...f.manifest, baseline: f.adapter.captureBaseline(f.manifest.goal, f.observation({ iron_pickaxe: 1 }, 3, now - 250)) };
  const current = f.observed(f.observation({ iron_pickaxe: 1 }, 4));
  expect(f.adapter.verifyCompletion(reset, [...facts, current]).status).toBe("incomplete");
  expect(f.adapter.verifyCompletion(reset, [
    ...f.production("iron_pickaxe", {}, { iron_pickaxe: 1 }, now - 100), current,
  ]).status).toBe("verified");
});

test("combined proof retains actual pre-consumption wood across independent polls without spare logs", () => {
  const f = fixture("collect_and_craft_table");
  const consumed = f.production("oak_planks", { oak_log: 1 }, { oak_planks: 4 }, now - 1000);
  const crafted = f.production("crafting_table", { oak_planks: 4 }, { crafting_table: 1 });
  const result = f.adapter.verifyCompletion(f.manifest, [...consumed, ...crafted, f.observed(f.observation({ crafting_table: 1 }))]);
  expect(result.status).toBe("verified");
  expect(result.evidence_refs).toContain("produce-oak_planks:production");
  expect(result.evidence_refs).toContain("produce-crafting_table:production");
});

test("combined proof does not borrow baseline wood or consume an acquisition from another life", () => {
  const f = fixture("collect_and_craft_table", { oak_log: 1 });
  const consumed = f.production("oak_planks", { oak_log: 1 }, { oak_planks: 4 }, now - 1000);
  const crafted = f.production("crafting_table", { oak_planks: 4 }, { crafting_table: 1 });
  expect(f.adapter.verifyCompletion(f.manifest, [...consumed, ...crafted, f.observed(f.observation({ crafting_table: 1 }))]).status).not.toBe("verified");
  const fresh = fixture("collect_and_craft_table");
  const oldLife = fresh.production("oak_planks", { oak_log: 1 }, { oak_planks: 4 }, now - 1000).map(event => ({ ...event, scope: { ...event.scope, life_id: 2 } }));
  expect(fresh.adapter.verifyCompletion(fresh.manifest, [...oldLife, ...fresh.production("crafting_table", { oak_planks: 4 }, { crafting_table: 1 }),
    fresh.observed(fresh.observation({ crafting_table: 1 }))]).status).not.toBe("verified");
});

test("confirmed historical acquisition observation survives consumption without becoming the current freshness witness", () => {
  const f = fixture("collect_and_craft_table");
  const prior = f.observed(f.observation({ oak_log: 1 }, 2, now - 1500));
  const current = f.observed(f.observation({ crafting_table: 1 }, 3));
  const result = f.adapter.verifyCompletion(f.manifest, [prior, ...f.production("crafting_table", { oak_planks: 4 }, { crafting_table: 1 }), current]);
  expect(result.status).toBe("verified");
  expect(result.evidence_refs).toContain("observation-2");
  expect(result.evidence_refs).toContain("observation-3");
});

for (const reason of ["stale", "future", "foreign scope", "dead", "old life production"] as const) {
  test(`${reason} cannot certify current own crafting possession`, () => {
    const f = fixture("craft_crafting_table"), observation = f.observation({ crafting_table: 1 });
    let facts = f.production("crafting_table", { oak_planks: 4 }, { crafting_table: 1 });
    if (reason === "stale") observation.captured_at = new Date(now - 1001).toISOString();
    if (reason === "future") observation.captured_at = new Date(now + 1001).toISOString();
    if (reason === "foreign scope") observation.session_id = "another-session";
    if (reason === "dead") observation.life.status = "dead";
    if (reason === "old life production") facts = facts.map(event => ({ ...event, scope: { ...event.scope, life_id: 2 } }));
    expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(observation)]).status).not.toBe("verified");
  });
}

test("an unknown helper effect remains unknown even when a table is now possessed", () => {
  const f = fixture("craft_crafting_table");
  const unknown = f.adapter.effectEvidence!(f.scope, "unknown-craft", { kind: "craft", item: "crafting_table", executions: 1 },
    { status: "unknown", summary: "Original receipt lost", evidence: { effect_confirmed: false } }, new Date(now - 500).toISOString());
  const result = f.adapter.verifyCompletion(f.manifest, [...unknown, f.observed(f.observation({ crafting_table: 1 }))]);
  expect(result.status).toBe("unknown");
  expect(result.reason).toBe("own_production_receipt_unconfirmed");
});

test("custom completion is never promoted to trusted adapter verification", () => {
  const f = fixture("custom");
  expect(f.adapter.verifyCompletion(f.manifest, [f.observed(f.observation({ crafting_table: 1 }))])).toMatchObject({
    status: "unknown", reason: "custom_completion_is_model_reported_unverified" });
});

const guiAction = { kind: "screen_input", screen: { screen_id: "visible", incarnation: 1, layout_revision: 1 },
  operations: [{ kind: "slot", slot_id: 0, button: "left", mode: "ordinary", hotbar_slot: null,
    expected_cursor: { item: null, count: 0 }, expected_slots: [{ slot_id: 0, value: { item: "crafting_table", count: 1 } }] }] };
function guiFact(producer: "crafting" | "smelting" | "trading" | "anvil" | null, item = "crafting_table") {
  return { kind: "gui_transaction", mechanism: "visible_gui", operation_index: 0, receipt_ref: "native:3:17",
    input_application: "confirmed", effect_status: "confirmed", inventory_before: { oak_planks: 4 }, inventory_after: {},
    productions: producer ? [{ producer, item, count: 1, source: "server_result_slot_take", production_confirmed: true }] : [] };
}

for (const producer of ["crafting", "smelting", "trading", "anvil", null] as const) {
  test(`iron GUI ${producer ?? "transfer"} receipts require confirmed crafting and separately retained possession`, () => {
    const f = fixture("craft_iron_pickaxe");
    const action = { ...guiAction, operations: [{ ...guiAction.operations[0]!,
      expected_slots: [{ slot_id: 0, value: { item: "iron_pickaxe", count: 1 } }] }] };
    const fact = { ...guiFact(producer, "iron_pickaxe"), inventory_before: {} };
    const facts = f.adapter.effectEvidence!(f.scope, "gui-iron", action,
      { status: "succeeded", summary: "Contract-only native GUI receipt", evidence: { effect_confirmed: true, gui_transactions: [fact] } },
      new Date(now - 500).toISOString());
    expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({}))]).status).toBe("incomplete");
    expect(f.adapter.verifyCompletion(f.manifest, [f.observed(f.observation({ iron_pickaxe: 1 }, 3))]).status)
      .toBe(producer === "crafting" ? "verified" : "incomplete");
  });
}

test("unconfirmed iron GUI production stays unknown despite a later owned tool", () => {
  const f = fixture("craft_iron_pickaxe");
  const fact = { ...guiFact("crafting", "iron_pickaxe"), inventory_before: {},
    productions: [{ ...guiFact("crafting", "iron_pickaxe").productions[0]!, production_confirmed: false }] };
  const facts = f.adapter.effectEvidence!(f.scope, "gui-iron-unknown", guiAction,
    { status: "unknown", summary: "GUI production unconfirmed", evidence: { gui_transactions: [fact] } },
    new Date(now - 500).toISOString());
  expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({ iron_pickaxe: 1 }))])).toMatchObject({
    status: "unknown", reason: "own_production_receipt_unconfirmed" });
});

for (const producer of ["crafting", "smelting", "trading", "anvil", null] as const) {
  test(`GUI ${producer ?? "transfer"} receipts do not confuse crafting mechanism with possession`, () => {
    const f = fixture("craft_crafting_table");
    const facts = f.adapter.effectEvidence!(f.scope, "gui-owned", guiAction,
      { status: "succeeded", summary: "Native GUI transaction", evidence: { effect_confirmed: true, gui_transactions: [guiFact(producer)] } },
      new Date(now - 500).toISOString());
    expect(facts).toHaveLength(1);
    expect(facts[0]!.schema.id).toBe("minecraft_gui_transaction_v1");
    // The result was taken into cursor first; retention is independently observed later.
    expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({ crafting_table: 1 }))]).status)
      .toBe(producer === "crafting" ? "verified" : "incomplete");
  });
}

test("lost GUI acknowledgement cannot invent production from acquired inventory and never projects helper facts", () => {
  const f = fixture("craft_crafting_table");
  const facts = f.adapter.effectEvidence!(f.scope, "lost-gui", guiAction,
    { status: "unknown", summary: "ACK lost", evidence: { inventory_after: { crafting_table: 1 } } }, new Date(now - 500).toISOString());
  expect(facts.map(fact => fact.schema.id)).toEqual(["minecraft_effect_uncertainty_v1"]);
  expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({ crafting_table: 1 }))]).status).toBe("unknown");
});

test("GUI projection admits an independently confirmed prefix but rejects duplicate, out-of-range and unconfirmed receipts", () => {
  const f = fixture("craft_crafting_table"), fact = guiFact("crafting");
  const facts = f.adapter.effectEvidence!(f.scope, "partial-gui", guiAction, { status: "unknown", summary: "Second ACK lost",
    evidence: { gui_transactions: [fact, fact, { ...fact, operation_index: 1, receipt_ref: "other" },
      { ...fact, receipt_ref: "unconfirmed", effect_status: "unknown" }] } }, new Date(now - 500).toISOString());
  expect(facts.map(fact => fact.schema.id)).toEqual(["minecraft_gui_transaction_v1", "minecraft_effect_uncertainty_v1"]);
  expect(f.adapter.verifyCompletion(f.manifest, [...facts, f.observed(f.observation({ crafting_table: 1 }))]).status).toBe("verified");
});

test("GUI effect bounds scale with actual operation count including legal empty persistence", () => {
  const f = fixture("custom");
  expect(f.adapter.effectDeadlineMs({ ...guiAction, operations: [] })).toBe(5000);
  expect(f.adapter.effectDeadlineMs(guiAction)).toBe(9000);
  expect(f.adapter.effectDeadlineMs({ ...guiAction, operations: Array.from({ length: 16 }, () => ({ kind: "close" })) })).toBe(69000);
});
