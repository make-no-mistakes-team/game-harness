import { z } from "zod";
import type { PlayerLife, Vec3Data } from "./contracts.ts";
import type { TargetRef } from "./control.ts";
import { identitySchema, safeCounterSchema, targetRefSchema } from "./control.ts";
import { adapterObservationSchema, type ObservationV3 } from "./observations.ts";
import { playerLifeSchema } from "./primitives.ts";

export type MinecraftInventoryItem = { name: string; display_name: string; count: number; slot: number };
export type MinecraftPlayer = {
  position: Vec3Data; yaw: number; pitch: number; health: number; food: number;
  on_ground: boolean; in_water: boolean; inventory: MinecraftInventoryItem[];
};
export type MinecraftObservedBlock = {
  target: TargetRef; name: string; position: Vec3Data; observed_at: string; current: boolean;
};
export type MinecraftObservedEntity = MinecraftObservedBlock & { item_name?: string };
export type MinecraftSoundObservation = {
  category: "movement" | "interaction" | "combat" | "creature" | "weather";
  direction: "here" | "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  distance: "near" | "mid" | "far"; observed_at: string;
};
export type MinecraftObservationData = {
  player: MinecraftPlayer;
  blocks: MinecraftObservedBlock[];
  entities: MinecraftObservedEntity[];
  sounds: MinecraftSoundObservation[];
};
export type MinecraftObservation = ObservationV3<MinecraftObservationData>;
export type MinecraftControl = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";
export type MinecraftNavigationGaze = { kind: "navigation" } | { kind: "target"; target: TargetRef }
  | { kind: "free"; yaw: number; pitch: number };
export type MinecraftAction =
  | { kind: "move"; controls: Partial<Record<MinecraftControl, boolean>>; duration_ms: number;
      look?: { yaw: number; pitch: number }; interaction?: { kind: "attack" | "use"; target?: TargetRef } }
  | { kind: "look"; yaw: number; pitch: number }
  | { kind: "dig"; target: TargetRef }
  | { kind: "place"; target: TargetRef; face: "up" | "down" | "north" | "south" | "east" | "west"; item: string }
  | { kind: "craft"; item: string; executions: number; table?: TargetRef }
  | { kind: "equip"; item: string; destination: "hand" | "off-hand" | "head" | "torso" | "legs" | "feet" }
  | { kind: "interact"; target: TargetRef }
  | { kind: "attack"; target: TargetRef }
  | { kind: "navigate"; target: TargetRef; range: number; duration_ms: number; gaze?: MinecraftNavigationGaze }
  | { kind: "respawn" };

const vector = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const timestamp = z.string().min(1).max(40);
const itemName = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const yawUnits = "Absolute world yaw in radians, not degrees or a relative turn: 0 faces +Z, +pi/2 faces -X, -pi/2 faces +X, +/-pi faces -Z.";
const pitchUnits = "Absolute pitch in radians, positive up and negative down; 0 is level and +/-pi/2 is vertical.";
export const minecraftInventoryItemSchema = z.object({ name: z.string().max(100), display_name: z.string().max(200),
  count: safeCounterSchema, slot: safeCounterSchema }).strict();
export const minecraftPlayerSchema = z.object({ position: vector.describe("Own feet/runtime origin in continuous world block coordinates; Y increases upward."),
  yaw: z.number().finite().describe(`${yawUnits} Observation is wrapped to [-pi,pi).`), pitch: z.number().finite().describe(pitchUnits),
  health: z.number().finite(), food: z.number().finite(), on_ground: z.boolean(), in_water: z.boolean(),
  inventory: z.array(minecraftInventoryItemSchema).max(64),
}).strict() satisfies z.ZodType<MinecraftPlayer>;
const observedFields = { name: z.string().max(100), position: vector.describe("Block-cell center (x+0.5,y+0.5,z+0.5); floor recovers the cell, including negative coordinates."),
  observed_at: timestamp, current: z.boolean() };
export const minecraftObservedBlockSchema = z.object({ target: targetRefSchema, ...observedFields }).strict();
const itemProjection = z.string().min(1).max(100).regex(/^(?:[a-z0-9_.-]+:)?[a-z][a-z0-9_./-]*$/).optional();
export const minecraftObservedEntitySchema = minecraftObservedBlockSchema.extend({ item_name: itemProjection,
  position: vector.describe("Entity runtime origin, not bounding-box center or a block-cell index.") }).strict()
  .refine(entity => entity.item_name === undefined || entity.name === "item" || entity.name === "minecraft:item",
    { message: "Only visible ItemEntity observations may expose item registry identity" });
export const minecraftSoundSchema = z.object({ category: z.enum(["movement", "interaction", "combat", "creature", "weather"]),
  direction: z.enum(["here", "N", "NE", "E", "SE", "S", "SW", "W", "NW"]), distance: z.enum(["near", "mid", "far"]),
  observed_at: timestamp }).strict();
export const minecraftObservationDataSchema = z.object({ player: minecraftPlayerSchema,
  blocks: z.array(minecraftObservedBlockSchema).max(144), entities: z.array(minecraftObservedEntitySchema).max(32),
  sounds: z.array(minecraftSoundSchema).max(8),
}).strict().refine(data => data.blocks.length + data.entities.length + data.sounds.length + data.player.inventory.length <= 256,
  { message: "Minecraft observation exceeds combined item bound" }) satisfies z.ZodType<MinecraftObservationData>;
function targetsMatchObservation(targets: readonly MinecraftObservedBlock[], observation: ObservationV3<unknown>) {
  for (const item of targets) {
    if (item.target.life_id !== observation.life.life_id || item.target.space.dimension_id !== observation.space.dimension_id ||
      item.target.space.space_epoch !== observation.space.space_epoch) return false;
  }
  return true;
}
export const minecraftObservationV3Schema = adapterObservationSchema(minecraftObservationDataSchema).superRefine((observation, context) => {
  if (!targetsMatchObservation(observation.data.blocks, observation) || !targetsMatchObservation(observation.data.entities, observation))
    context.addIssue({ code: "custom", message: "Observed target belongs to another life or space" });
});
const yaw = z.number().finite().min(-2 * Math.PI).max(2 * Math.PI).describe(yawUnits);
const pitch = z.number().finite().min(-Math.PI / 2).max(Math.PI / 2).describe(pitchUnits);
const look = z.object({ yaw, pitch }).strict();
export const minecraftNavigationGazeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigation") }).strict(),
  z.object({ kind: z.literal("target"), target: targetRefSchema }).strict(),
  z.object({ kind: z.literal("free"), yaw, pitch }).strict(),
]);
export const minecraftActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), controls: z.object({ forward: z.boolean().optional(), back: z.boolean().optional(),
    left: z.boolean().optional(), right: z.boolean().optional(), jump: z.boolean().optional(), sprint: z.boolean().optional(),
    sneak: z.boolean().optional() }).strict(), duration_ms: z.number().int().min(50).max(2000), look: look.optional(),
    interaction: z.object({ kind: z.enum(["attack", "use"]), target: targetRefSchema.optional() }).strict().optional() }).strict(),
  z.object({ kind: z.literal("look"), yaw, pitch }).strict(),
  z.object({ kind: z.literal("dig"), target: targetRefSchema }).strict(),
  z.object({ kind: z.literal("place"), target: targetRefSchema, face: z.enum(["up", "down", "north", "south", "east", "west"]), item: itemName }).strict(),
  z.object({ kind: z.literal("craft"), item: itemName, executions: z.number().int().min(1).max(16), table: targetRefSchema.optional() }).strict(),
  z.object({ kind: z.literal("equip"), item: itemName, destination: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"]) }).strict(),
  z.object({ kind: z.literal("interact"), target: targetRefSchema }).strict(),
  z.object({ kind: z.literal("attack"), target: targetRefSchema }).strict(),
  z.object({ kind: z.literal("navigate"), target: targetRefSchema, range: z.number().finite().min(0.5).max(4),
    duration_ms: z.number().int().min(100).max(10000), gaze: minecraftNavigationGazeSchema.optional() }).strict(),
  z.object({ kind: z.literal("respawn") }).strict(),
]) satisfies z.ZodType<MinecraftAction>;
export const minecraftRecipesRequestSchema = z.object({ item: itemName }).strict();

/** These values are compiled into the native resource and are the sampler's actual settings. */
export const minecraftProfileConfigurationSchema = z.object({
  sampler: z.object({ radius_blocks: z.literal(8), max_blocks: z.literal(144), max_entities: z.literal(32),
    max_age_ms: z.literal(1000), camera_independent: z.literal(true), occlusion_test: z.literal("native_raycast") }).strict(),
  actor_image: z.object({ codec: z.literal("png"), presentation: z.literal("opaque_rgb"), alignment: z.literal("unsynchronized") }).strict(),
  motor_profile: z.enum(["precise", "balanced", "fast"]),
  assistance: z.object({ semantic_helpers: z.literal(true) }).strict(),
}).strict();
export function minecraftProfileConfiguration(motorProfile: "precise" | "balanced" | "fast" = "balanced") {
  return minecraftProfileConfigurationSchema.parse({
    sampler: { radius_blocks: 8, max_blocks: 144, max_entities: 32, max_age_ms: 1000,
      camera_independent: true, occlusion_test: "native_raycast" },
    actor_image: { codec: "png", presentation: "opaque_rgb", alignment: "unsynchronized" },
    motor_profile: motorProfile, assistance: { semantic_helpers: true },
  });
}

const inventoryCountsSchema = z.record(z.string().regex(/^(?:[a-z0-9_.-]+:)?[a-z][a-z0-9_./-]*$/), safeCounterSchema);
export const minecraftProductionFactSchema = z.object({
  kind: z.literal("item_production"), item: itemName, actor: z.literal("own_player"),
  mechanism: z.literal("helper"), input_application: z.literal("confirmed"), effect_status: z.literal("confirmed"),
  inventory_before: inventoryCountsSchema, inventory_after: inventoryCountsSchema, receipt_ref: identitySchema,
}).strict();
export const minecraftBlockRemovalFactSchema = z.object({
  kind: z.literal("block_removal"), actor: z.literal("own_player"), mechanism: z.literal("helper"),
  effect_status: z.literal("confirmed"), source: z.literal("server_block_update"), target_name: itemName,
  receipt_ref: identitySchema,
}).strict();
export const minecraftEffectUncertaintyFactSchema = z.object({
  kind: z.literal("effect_uncertainty"), actor: z.literal("own_player"), mechanism: z.literal("helper"),
  operation_kind: z.string().min(1).max(80), effect_status: z.literal("unknown"), receipt_ref: identitySchema,
  reason: z.enum(["effect_unconfirmed", "inventory_receipt_unconfirmed"]),
}).strict();

/** Explicit read codec. This shape is never an active adapter observation. */
export interface HistoricalObservationV2 {
  schema_version: 2; world_id: string; epoch: number; session_id: string; life: PlayerLife;
  observation_seq: number; captured_at: string; profile_id: "player-observable-structured";
  preset_id: "minecraft-observable-initial-r2"; player: MinecraftPlayer;
  blocks: { id: string; name: string; position: Vec3Data; observed_at: string; current: boolean }[];
  entities: { id: string; name: string; position: Vec3Data; observed_at: string; current: boolean; item_name?: string }[];
  sounds: MinecraftSoundObservation[]; coverage: { partial: true; max_age_ms: number };
}
const historicalBlock = z.object({ id: z.string().max(160), ...observedFields }).strict();
export const historicalObservationV2Schema = z.object({ schema_version: z.literal(2), world_id: z.string().max(160),
  epoch: safeCounterSchema, session_id: identitySchema, life: playerLifeSchema, observation_seq: safeCounterSchema,
  captured_at: z.string().max(40), profile_id: z.literal("player-observable-structured"), preset_id: z.literal("minecraft-observable-initial-r2"),
  player: minecraftPlayerSchema, blocks: z.array(historicalBlock).max(200),
  entities: z.array(historicalBlock.extend({ item_name: itemProjection }).strict()).max(32), sounds: z.array(minecraftSoundSchema).max(8),
  coverage: z.object({ partial: z.literal(true), max_age_ms: z.number().int().min(0).max(1000) }).strict(),
}).strict().refine(value => value.blocks.length + value.entities.length + value.sounds.length + value.player.inventory.length <= 256) satisfies z.ZodType<HistoricalObservationV2>;
