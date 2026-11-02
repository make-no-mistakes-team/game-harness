import { createHash } from "node:crypto";
import { z } from "zod";
import { minecraftActionSchema, minecraftControllerFrameRequestSchema } from "../../src/shared/minecraft.ts";
import { observationV3Schema } from "../../src/shared/observations.ts";
import { jsonSchema } from "../../src/shared/validation.ts";
import { minecraftProfileConfiguration, type MinecraftObservation } from "../../src/shared/minecraft.ts";
import type { AdapterBinding, RuntimeAdapter } from "../../src/shared/contracts.ts";
import type { StoredRun } from "../../src/server/store.ts";
import type { SkillExecutionView } from "../../src/shared/programs.ts";
import { emptyRunUsage } from "../../src/server/usage.ts";
import { minecraftSchemaCatalog } from "../../src/server/native-contract.ts";
import { createMinecraftAdapter } from "../../src/server/minecraft-adapter.ts";
import { adapterDescriptorSchema } from "../../src/shared/adapter.ts";

// Contract-only data, not a supported second game or a native gameplay witness.
// Hashing here creates independent wire fixtures; production must validate/recompute them.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
export const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const sourceHash = createHash("sha256").update("contract fixture source\n").digest("hex");
// Actual schema documents supplied by the trusted fixture host, not hashes from hello.
// Transport conformance uses the real registered Minecraft action validator; it
// does not establish the native emitter implements a future capability.
export function schemaCatalog() {
  const action = jsonSchema.parse(z.toJSONSchema(minecraftActionSchema));
  if (action === null || typeof action !== "object" || Array.isArray(action)) throw new Error("Action fixture schema is not an object");
  return {
    observation: jsonSchema.parse(z.toJSONSchema(observationV3Schema)),
    payload: { type: "object", properties: { fixture_counter: { type: "integer" } },
      required: ["fixture_counter"], additionalProperties: false },
    capabilities: {
      "minecraft.action@4": action,
      "minecraft.recipes@1": { type: "object", properties: { item: { type: "string" } },
        required: ["item"], additionalProperties: false },
      "minecraft.visible_screen@1": { type: "object", properties: {}, additionalProperties: false },
      "minecraft.controller_frame@2": jsonSchema.parse(z.toJSONSchema(minecraftControllerFrameRequestSchema)),
    },
  };
}
export function descriptor() {
  const schemas = schemaCatalog();
  const configuration = {
    sampler: { radius_blocks: 8, max_blocks: 144, max_entities: 32, max_age_ms: 1000,
      camera_independent: true, occlusion_test: "native_raycast" },
    actor_image: { codec: "png", presentation: "opaque_rgb", alignment: "unsynchronized" },
    motor_profile: "balanced",
    assistance: { semantic_helpers: true },
    visible_gui: { projection: "current_visible_layout", max_slots: 128, max_elements: 64, max_progress: 32, coordinates: "logical_gui" },
    controller_feedback: { schema_version: 2, own_body: "current_client_state", inventory: "client_prediction",
      screen: "current_visible_layout", visible_world: "last_authorized_observation",
      render_capture: "capture_sequence_metadata_only", render_max_age_ms: 5000,
      last_input: "actual_application_ack", effect_updates: "bounded_later_receipts", max_effect_updates: 8,
      max_effect_update_bytes: 16384 },
    audible: { source: "actually_delivered_allowlisted", capacity: 128, ttl_ms: 1000,
      max_events_per_page: 8, cursors: "consumer_owned", creeper_primed: true },
  };
  return {
    descriptor_schema: 1,
    game: { id: "minecraft", version: "1.21.4" },
    adapter: { id: "fabric-owned-client", version: "1.0.0", build_hash: "a".repeat(64) },
    observation: {
      schema_version: 3, schema_hash: sha256(schemas.observation),
      payload_schema: { id: "contract_test_payload_v1", version: 1, hash: sha256(schemas.payload) },
      profile: { id: "minecraft_assisted_rgb_360_r8_control_v4", version: 4, configuration,
        configuration_hash: sha256(configuration) },
    },
    capabilities: [
      { id: "minecraft.action", version: 4, schema_hash: sha256(schemas.capabilities["minecraft.action@4"]) },
      { id: "minecraft.controller_frame", version: 2, schema_hash: sha256(schemas.capabilities["minecraft.controller_frame@2"]) },
      { id: "minecraft.recipes", version: 1, schema_hash: sha256(schemas.capabilities["minecraft.recipes@1"]) },
      { id: "minecraft.visible_screen", version: 1, schema_hash: sha256(schemas.capabilities["minecraft.visible_screen@1"]) },
    ],
    actuator: "native",
    executable: { api_version: 5, validator_version: 5, runtime_version: 5 },
  };
}
export function effectScope() {
  return { session_id: "contract-session", world_id: "contract-world", epoch: 2 ** 31 + 17,
    native_boot_id: "native-boot-A", run_id: "contract-run", run_generation: 7,
    life_id: 3, space_epoch: 4, execution_id: "host-invocation-A", source_hash: sourceHash };
}
export function binding(value = descriptor()) {
  return { ready: true, descriptor: value, compatibility_hash: sha256(value), native_boot_id: "native-boot-A" };
}
export function activeObservation<Data>(data: Data, seq = 2) {
  const scope = effectScope(), value = descriptor();
  return { schema_version: 3, world_id: scope.world_id, epoch: scope.epoch,
    session_id: scope.session_id, native_boot_id: scope.native_boot_id,
    life: { life_id: scope.life_id, status: "alive", can_respawn: false, death: null },
    space: { dimension_id: "minecraft:overworld", space_epoch: scope.space_epoch },
    screen: null,
    observation_seq: seq, captured_at: "2026-10-25T00:00:02.000Z",
    compatibility_hash: sha256(value), profile_id: value.observation.profile.id,
    profile_configuration_hash: value.observation.profile.configuration_hash,
    freshness: { max_age_ms: 1000, partial: true }, data };
}
export function historicalObservation() {
  return { schema_version: 2 as const, world_id: "contract-world", epoch: 1, session_id: "contract-session",
    life: { life_id: 1, status: "alive" as const, can_respawn: false, death: null },
    observation_seq: 1, captured_at: "2026-10-22T00:00:00Z",
    profile_id: "player-observable-structured" as const, preset_id: "minecraft-observable-initial-r2" as const,
    player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20,
      on_ground: true, in_water: false, inventory: [] },
    blocks: [], entities: [], sounds: [], coverage: { partial: true as const, max_age_ms: 1000 } };
}

/** Real registered schemas/predicates with a clearly synthetic build identity; no gameplay support claim. */
export function minecraftTestAdapter(motorProfile: "precise" | "balanced" | "fast" = "balanced", options: { now?: () => number } = {}) {
  const schemas = minecraftSchemaCatalog(), value = descriptor();
  value.observation.schema_hash = sha256(schemas.observation);
  value.observation.payload_schema = { id: "minecraft_observation_v1", version: 1, hash: sha256(schemas.payload) };
  value.observation.profile.configuration = minecraftProfileConfiguration(motorProfile);
  value.observation.profile.configuration_hash = sha256(value.observation.profile.configuration);
  value.capabilities = Object.entries(schemas.capabilities).map(([key, schema]) => {
    const separator = key.lastIndexOf("@");
    return { id: key.slice(0, separator), version: Number(key.slice(separator + 1)), schema_hash: sha256(schema) };
  });
  return createMinecraftAdapter(adapterDescriptorSchema.parse(value), options);
}
/** New-shape live fixtures only; schema2 inputs are never converted or upgraded. */
export function minecraftObservationFixture(adapter: RuntimeAdapter, overrides: Partial<MinecraftObservation> = {}): MinecraftObservation {
  return { schema_version: 3, world_id: "world", session_id: "session", epoch: 1, native_boot_id: "fixture-native-boot",
    life: { life_id: 1, status: "alive", can_respawn: false, death: null },
    space: { dimension_id: "minecraft:overworld", space_epoch: 1 }, screen: null,
    observation_seq: 1, captured_at: new Date().toISOString(), compatibility_hash: sha256(adapter.descriptor),
    profile_id: adapter.descriptor.observation.profile.id,
    profile_configuration_hash: adapter.descriptor.observation.profile.configuration_hash,
    freshness: { partial: true, max_age_ms: 1000 },
    data: { player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20,
      on_ground: true, in_water: false, inventory: [] }, blocks: [], entities: [], sounds: [] }, ...overrides };
}
export function minecraftTestBinding(adapter: RuntimeAdapter, nativeBootId = "fixture-native-boot"): AdapterBinding {
  return { ready: true, descriptor: adapter.descriptor, compatibility_hash: sha256(adapter.descriptor), native_boot_id: nativeBootId };
}
export function minecraftRunFixture(adapter: RuntimeAdapter, overrides: Partial<StoredRun> = {}): StoredRun {
  return { run_id: crypto.randomUUID(), world_id: "world", epoch: 1, session_id: "session", life_id: 1,
    native_boot_id: "fixture-native-boot", space_epoch: 1, compatibility_hash: sha256(adapter.descriptor),
    task: "Explicit contract-only live fixture; no gameplay claim", goal: { adapter_id: adapter.descriptor.adapter.id, goal_id: "custom", verifier: null, parameters: {} },
    model_id: "fixture-model", status: "running", started_at: new Date().toISOString(), ended_at: null, turns: 0,
    model_status: "idle", error: null, usage: emptyRunUsage(), baseline: {}, ...overrides };
}
export function executionScopeFixture(run: StoredRun, runGeneration = 1) {
  if (!run.session_id || run.life_id === null || !run.native_boot_id || run.space_epoch === null || !run.compatibility_hash)
    throw new Error("Execution fixtures require actual explicit active authority");
  return { epoch: run.epoch, session_id: run.session_id, life_id: run.life_id, native_boot_id: run.native_boot_id,
    run_generation: runGeneration, space_epoch: run.space_epoch, compatibility_hash: run.compatibility_hash };
}
/** Storage-only declared diagnostic source; not a skill row or native gameplay proof. */
export function diagnosticAuthorityFixture(run: StoredRun, executionId = "fixture-diagnostic", runGeneration = 1) {
  const current = executionScopeFixture(run, runGeneration);
  return { scope: { run_id: run.run_id, world_id: run.world_id, session_id: current.session_id, epoch: current.epoch,
    native_boot_id: current.native_boot_id, life_id: current.life_id, space_epoch: current.space_epoch,
    run_generation: current.run_generation, execution_id: executionId, source_hash: sourceHash },
    invocation: { kind: "diagnostic" as const, execution_id: executionId, source_hash: sourceHash }, compatibility_hash: current.compatibility_hash };
}
export function skillAuthorityFixture(run: StoredRun, execution: SkillExecutionView) {
  if (!execution.world_id || !execution.session_id || !execution.native_boot_id || execution.run_generation === null || execution.life_id === null ||
    execution.space_epoch === null || !execution.source_hash || !execution.compatibility_hash) throw new Error("No active sealed skill authority in this fixture");
  return { scope: { run_id: run.run_id, world_id: execution.world_id, session_id: execution.session_id, epoch: execution.epoch,
    native_boot_id: execution.native_boot_id, life_id: execution.life_id, space_epoch: execution.space_epoch, run_generation: execution.run_generation,
    execution_id: execution.execution_id, source_hash: execution.source_hash },
    invocation: { kind: "skill" as const, execution_id: execution.execution_id, source_hash: execution.source_hash }, compatibility_hash: execution.compatibility_hash };
}
