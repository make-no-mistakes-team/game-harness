import { z } from "zod";
import type { Json, PlayerLife, Vec3Data } from "./contracts.ts";
import type { TargetRef, VisibleScreenOperation, VisibleScreenRef, VisibleScreenSnapshot, WorldInputStep } from "./control.ts";
import type { GameAPI } from "./programs.ts";
import { identitySchema, safeCounterSchema, screenInputActionSchema, spaceRefSchema, targetRefSchema, visibleScreenSnapshotSchema, worldInputActionSchema } from "./control.ts";
import { adapterObservationSchema, type ObservationV3 } from "./observations.ts";
import { jsonSchema, playerLifeSchema } from "./primitives.ts";
import { controllerEffectUpdateSchema, inputAppliedAckSchema, nativeNanosecondsSchema } from "./controller.ts";

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
  direction: "here" | "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  distance: "near" | "mid" | "far"; observed_at: string;
} & (
  | { category: "movement" | "interaction" | "combat" | "creature" | "weather"; cue: null }
  | { category: "combat"; cue: "creeper_primed" | "shield_block" | "shield_break" | "item_break"
      | "attack_strong" | "attack_weak" | "attack_nodamage" | "attack_crit" | "attack_sweep" | "attack_knockback"
      | "mob_hurt" | "mob_death" }
);
export type MinecraftObservationData = {
  player: MinecraftPlayer;
  blocks: MinecraftObservedBlock[];
  entities: MinecraftObservedEntity[];
  sounds: MinecraftSoundObservation[];
};
export type MinecraftObservation = ObservationV3<MinecraftObservationData>;
export interface MinecraftGameAPI extends GameAPI {
  recipes(item: string): Promise<Json>;
  screen(): Promise<VisibleScreenSnapshot | null>;
  frame(audio_cursor: SoundCursor | null): Promise<MinecraftControllerFrame>;
}
export type MinecraftControl = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";
export type MinecraftNavigationGaze = { kind: "navigation" } | { kind: "target"; target: TargetRef }
  | { kind: "free"; yaw: number; pitch: number };
export type MinecraftAction =
  | { kind: "world_input"; steps: WorldInputStep[] }
  | { kind: "screen_input"; screen: VisibleScreenRef; operations: VisibleScreenOperation[] }
  | { kind: "move"; controls: Partial<Record<MinecraftControl, boolean>>; duration_ms: number;
      look?: { yaw: number; pitch: number }; interaction?: { kind: "attack" | "use"; target?: TargetRef } }
  | { kind: "look"; yaw: number; pitch: number }
  | { kind: "dig"; target: TargetRef }
  | { kind: "place"; target: TargetRef; face: "up" | "down" | "north" | "south" | "east" | "west"; item: string }
  | { kind: "craft"; item: string; executions: number; table?: TargetRef }
  | { kind: "craft"; sequence: { item: string; executions: number }[]; table?: TargetRef }
  | { kind: "equip"; item: string; destination: "hand" | "off-hand" | "head" | "torso" | "legs" | "feet" }
  | { kind: "interact"; target: TargetRef }
  | { kind: "attack"; target: TargetRef }
  | { kind: "navigate"; target: TargetRef; range: number; duration_ms: number;
      arrival?: "position" | "interaction"; gaze?: MinecraftNavigationGaze }
  | { kind: "respawn" };

const vector = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const timestamp = z.string().min(1).max(40);
const itemName = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const recipeOutputItem = itemName.describe("Exact output item registry path without a namespace. Matching is literal, not a material family, tag, display name, ingredient name or alias.");
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
const ordinarySoundFields = {
  direction: z.enum(["here", "N", "NE", "E", "SE", "S", "SW", "W", "NW"]), distance: z.enum(["near", "mid", "far"]),
  observed_at: timestamp.describe("Original actually heard event time, not the observation or grouping time."),
};
export const minecraftSoundSchema = z.union([
  z.object({ ...ordinarySoundFields, category: z.enum(["movement", "interaction", "combat", "creature", "weather"]),
    cue: z.null().describe("No distinct allowlisted cue was heard for this group.") }).strict(),
  z.object({ ...ordinarySoundFields, category: z.literal("combat"),
    cue: z.enum(["creeper_primed", "shield_block", "shield_break", "item_break", "attack_strong", "attack_weak",
      "attack_nodamage", "attack_crit", "attack_sweep", "attack_knockback", "mob_hurt", "mob_death"])
      .describe("Actually heard allowlisted combat sound; no damage attribution, hidden HP, source identity or position.") }).strict(),
]);
export const minecraftObservationDataSchema = z.object({ player: minecraftPlayerSchema,
  blocks: z.array(minecraftObservedBlockSchema).max(144), entities: z.array(minecraftObservedEntitySchema).max(32),
  sounds: z.array(minecraftSoundSchema).max(8)
    .describe("Non-draining groups of actually delivered allowlisted sounds retained for 1000ms. Cue-distinct groups precede generic groups before the eight-group cap; groups retain original heard times."),
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
const craftStage = z.object({ item: recipeOutputItem, executions: z.number().int().min(1).max(16)
  .describe("Recipe executions/ingredient consumptions, not output items; multiply by the recipe output count.") }).strict();
const craftDescription = "Visible unlocked-recipe helper. Model selects exact outputs, execution counts, explicit order and optional fresh reachable table for the whole session. Uses one owned inventory/table screen, places bounded ingredient batches without overcrafting, and stops on the first refusal or uncertain outcome. Per-stage server receipts retain actual partial production and cursor/grid custody. No implicit retry. At most 16 total executions; native bound 10 seconds + 35 seconds per execution, still limited by the owning program.";
export const minecraftActionSchema = z.union([
  z.object({ kind: z.literal("move"), controls: z.object({ forward: z.boolean().optional(), back: z.boolean().optional(),
    left: z.boolean().optional(), right: z.boolean().optional(), jump: z.boolean().optional(), sprint: z.boolean().optional(),
    sneak: z.boolean().optional() }).strict(), duration_ms: z.number().int().min(50).max(2000), look: look.optional(),
    interaction: z.object({ kind: z.enum(["attack", "use"]), target: targetRefSchema.optional() }).strict().optional() }).strict()
    .describe("Raw held-input interval, not an arrival or task-progress promise. Success may include jumping in place. Receipts distinguish net/horizontal displacement, height change and own-body grounded/support/headroom/collision feedback from accumulated travel. For purposeful travel or ascent, compare fresh settled positions across a small bounded sequence; after at most three ineffective bursts, stop, reobserve and change the approach or return blocked. Allow bounded detours; jumping distance is not escape progress. A separate completed jump followed by observation/aim/equip may land before a later placement."),
  z.object({ kind: z.literal("look"), yaw, pitch }).strict(),
  z.object({ kind: z.literal("dig"), target: targetRefSchema }).strict()
    .describe("Stationary mining helper; does not move toward its target. Native preflight requires a current visible block, eye-to-centre distance at most 5 blocks and clear interaction line of sight. The observation radius is not mining reach. Passing preflight is not server-confirmed removal; inspect the actual result and fresh state."),
  z.object({ kind: z.literal("place"), target: targetRefSchema, face: z.enum(["up", "down", "north", "south", "east", "west"]), item: itemName }).strict()
    .describe("Place using a fresh support target and face; implicit equipment uses the same visible native inventory controller. Bounded native session up to 20 seconds, still limited by the owning program budget."),
  z.object({ kind: z.literal("equip"), item: itemName, destination: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"]) }).strict()
    .describe("Select an existing hotbar item directly or visibly transfer equipment through the native inventory. Bounded native session up to 12 seconds; owning program limits still apply."),
  z.object({ kind: z.literal("interact"), target: targetRefSchema }).strict()
    .describe("Right-click a current visible block or entity within native reach. Dropped items are proximity pickups, not right-click interactions: approach using ordinary movement or navigation and confirm collection from a fresh inventory receipt. Packet emission alone does not confirm an effect."),
  z.object({ kind: z.literal("attack"), target: targetRefSchema }).strict()
    .describe("One entity attack with built-in mechanical aiming; no prior look is required. Does not approach, select equipment, repeat strikes or wait for cooldown. Caller chooses movement and timing. Success confirms owned server damage, not a kill."),
  z.object({ kind: z.literal("navigate"), target: targetRefSchema, range: z.number().finite().min(0.5).max(4)
    .describe("Arrival distance in blocks. Position (default): full 3D distance from own feet to block centre or last-authorized entity origin. Interaction: eye-to-block-centre distance, also requiring current visibility and native mining reach; never increases reach. Unless already arrived, a separate helper envelope requires initial feet-to-target-centre distance <=8 blocks and current distance <=10. Observation samples integer block offsets around floor(feet) within radius 8, so a fresh observed centre can still exceed navigation's 8-block envelope. Refusal receipts give distances/limits. Reobserve and choose a permitted local approach, not the unchanged refused request."),
    duration_ms: z.number().int().min(100).max(10000)
      .describe("Finite movement interval, not a promise to arrive. Non-arrival stops input and awaits the owned completion receipt; confirmed settlement returns failed with partial effects retained. Missing receipt, lost target or scope remains unknown. Check fresh feedback before choosing another action."),
    arrival: z.enum(["position", "interaction"]).optional()
      .describe("Defaults to position; vertical separation counts. Choose interaction to approach a visible block for ordinary interaction/mining reach without mining it. Interaction requires a visible reachable block within range and rejects entity targets; position preserves entity/item navigation."),
    gaze: minecraftNavigationGazeSchema.optional() }).strict(),
  z.object({ kind: z.literal("respawn") }).strict(),
  worldInputActionSchema,
  screenInputActionSchema,
  z.object({ kind: z.literal("craft"), ...craftStage.shape, table: targetRefSchema.optional() }).strict()
  .describe(craftDescription),
  z.object({ kind: z.literal("craft"), sequence: z.array(craftStage).min(1).max(8), table: targetRefSchema.optional() }).strict()
    .refine(action => action.sequence.reduce((total, stage) => total + stage.executions, 0) <= 16,
      { message: "Craft sequence exceeds 16 total recipe executions" }).describe(craftDescription),
]) satisfies z.ZodType<MinecraftAction>;
export const minecraftRecipesRequestSchema = z.object({ item: recipeOutputItem }).strict();
export const minecraftVisibleScreenRequestSchema = z.object({}).strict()
  .describe("Read only the currently visible vanilla GUI, including empty slots, cursor and logical bounds, or null. Never opens/closes a screen; no hidden recipes/offers or synchronized image claim.");

const nativeNanoseconds = nativeNanosecondsSchema
  .describe("Signed decimal native monotonic nanoseconds, never a JavaScript number or wall-clock timestamp.");
const frameTimestamp = z.iso.datetime({ offset: true }).max(40);
const frameScalar = z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const frameVector = z.object({ x: frameScalar, y: frameScalar, z: frameScalar }).strict();
const framePitch = z.number().finite().min(-Math.PI / 2).max(Math.PI / 2).describe(pitchUnits);
const frameYaw = z.number().finite().min(-2 * Math.PI).max(2 * Math.PI).describe(yawUnits);
const registryName = z.string().min(1).max(100).regex(/^(?:[a-z0-9_.-]+:)?[a-z][a-z0-9_./-]*$/);
const nativeTicks = z.number().int().min(0).max(2147483647);

export const soundCursorSchema = z.object({ stream_id: identitySchema, sequence: safeCounterSchema }).strict()
  .describe("Consumer-owned continuation for one life/space audible stream. Foreign or future cursors reject; no global drain.");
export type SoundCursor = z.infer<typeof soundCursorSchema>;
export const soundEventSchema = z.object({
  sequence: safeCounterSchema.min(1), category: z.enum(["movement", "interaction", "combat", "creature", "weather"]),
  cue: z.enum(["creeper_primed", "shield_block", "shield_break", "item_break", "attack_strong", "attack_weak",
    "attack_nodamage", "attack_crit", "attack_sweep", "attack_knockback", "mob_hurt", "mob_death"]).nullable(),
  direction: z.enum(["here", "N", "NE", "E", "SE", "S", "SW", "W", "NW"]),
  distance: z.enum(["near", "mid", "far"]), heard_at: frameTimestamp, heard_native_ns: nativeNanoseconds,
}).strict().refine(event => event.cue === null || event.category === "combat",
  { message: "Distinct allowlisted cues must be actually heard combat sounds" });
export type SoundEvent = z.infer<typeof soundEventSchema>;
export const soundPageSchema = z.object({
  stream_id: identitySchema, after_sequence: safeCounterSchema, next_cursor: soundCursorSchema,
  gap: z.boolean(), omitted_before: safeCounterSchema, has_more: z.boolean(), events: z.array(soundEventSchema).max(8),
}).strict().superRefine((page, context) => {
  let previous = page.after_sequence;
  for (const [index, event] of page.events.entries()) {
    if (event.sequence - previous !== (index === 0 ? page.omitted_before + 1 : 1))
      context.addIssue({ code: "custom", path: ["events"],
        message: "Audible events must follow the declared omission and remain contiguous within a page" });
    previous = event.sequence;
  }
  const continuationMatches = page.events.length > 0 ? page.next_cursor.sequence === previous :
    page.next_cursor.sequence >= page.after_sequence && page.next_cursor.sequence - page.after_sequence === page.omitted_before;
  if (page.next_cursor.stream_id !== page.stream_id || !continuationMatches)
    context.addIssue({ code: "custom", path: ["next_cursor"], message: "Continuation must identify this page's stream and last returned sequence" });
  if (page.gap !== (page.omitted_before > 0))
    context.addIssue({ code: "custom", path: ["gap"], message: "Omitted audible events must be explicitly marked as a gap" });
});
export type SoundPage = z.infer<typeof soundPageSchema>;
export const minecraftOwnBodySchema = z.object({
  position: frameVector, velocity_blocks_per_tick: frameVector,
  health: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER), food: z.number().int().min(0).max(20),
  on_ground: z.boolean(), in_water: z.boolean(), submerged_in_water: z.boolean(), in_lava: z.boolean(),
  air_ticks: z.number().int().min(-2147483648).max(2147483647), max_air_ticks: nativeTicks,
  sprinting: z.boolean(), sneaking: z.boolean(), swimming: z.boolean(), gliding: z.boolean(),
  vehicle_type: registryName.nullable(), selected_hotbar: z.number().int().min(0).max(8),
  xp_level: nativeTicks, xp_progress: z.number().finite().min(0).max(1),
  active_use: z.object({ hand: z.enum(["main", "off"]), item: registryName,
    elapsed_ticks: nativeTicks, remaining_ticks: nativeTicks }).strict().nullable(),
  blocking: z.boolean().describe("Actual vanilla blocking readiness, distinct from a newly active item use."),
  equipment: z.array(z.object({ slot: z.enum(["main", "off", "head", "torso", "legs", "feet"]),
    item: registryName.nullable(), count: z.number().int().min(0).max(4096),
    durability: z.object({ damage: nativeTicks, maximum: nativeTicks.min(1) }).strict().nullable(),
  }).strict().refine(entry => (entry.item === null ? entry.count === 0 && entry.durability === null : entry.count > 0)
      && (entry.durability === null || entry.durability.damage <= entry.durability.maximum))).max(6),
  status_effects: z.array(z.object({ id: registryName, amplifier: nativeTicks,
    duration_ticks: z.number().int().min(-1).max(2147483647) }).strict()).max(32),
}).strict().refine(body => new Set(body.equipment.map(entry => entry.slot)).size === body.equipment.length,
  { message: "Own equipment slots must be unique" });
export type MinecraftOwnBody = z.infer<typeof minecraftOwnBodySchema>;
export const minecraftCrosshairSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("miss") }).strict(),
  z.object({ kind: z.literal("block"), hit_position: frameVector,
    block_position: z.object({ x: z.number().int().min(-2147483648).max(2147483647),
      y: z.number().int().min(-2147483648).max(2147483647), z: z.number().int().min(-2147483648).max(2147483647) }).strict(),
    face: z.enum(["up", "down", "north", "south", "east", "west"]), target: targetRefSchema.nullable() }).strict(),
  z.object({ kind: z.literal("entity"), hit_position: frameVector, target: targetRefSchema }).strict()
    .describe("Only an admitted same-render entity. Denied entity hits are whole misses, without a presence kind, coordinates or token."),
]);
export const minecraftRenderCaptureSchema = z.object({
  capture_sequence: z.number().int().min(0).max(4294967295), client_tick: safeCounterSchema, render_invocation: safeCounterSchema,
  sampled_native_ns: nativeNanoseconds, capture_native_ns: nativeNanoseconds,
  position: frameVector, yaw_radians: z.number().finite().describe("Actual unwrapped GHV2 camera yaw in radians; multiple full turns remain exact."),
  pitch_radians: framePitch,
}).strict().describe("Scalars from this actual GHV2 capture sequence, not later render updates. Actor PNG remains unsynchronized with current body, world and GUI.");
export const minecraftControllerFrameSchema = z.object({
  schema_version: z.literal(3), frame_seq: safeCounterSchema.min(1), native_tick: safeCounterSchema,
  captured_native_ns: nativeNanoseconds, captured_at: frameTimestamp,
  profile_id: z.literal("minecraft_assisted_rgb_fov_r8_control_v7"), profile_version: z.literal(7),
  life_id: safeCounterSchema, space: spaceRefSchema, player: minecraftOwnBodySchema,
  inventory: z.object({ source: z.literal("client_prediction"), captured_native_ns: nativeNanoseconds,
    items: z.array(minecraftInventoryItemSchema).max(64) }).strict()
    .describe("Current own client prediction only, never server-confirmed goal-verification evidence."),
  view: z.object({ applied_pose: z.object({ yaw_radians: frameYaw, pitch_radians: framePitch }).strict(),
    attack_indicator: z.number().finite().min(0).max(1), crosshair: minecraftCrosshairSchema,
    render_capture: minecraftRenderCaptureSchema.nullable() }).strict(),
  screen: visibleScreenSnapshotSchema.nullable(),
  visible_world: z.object({ source: z.literal("last_authorized_observation"), observation_seq: safeCounterSchema,
    captured_at: frameTimestamp, captured_native_ns: nativeNanoseconds, stale: z.boolean(),
    blocks: z.array(minecraftObservedBlockSchema).max(144), entities: z.array(minecraftObservedEntitySchema).max(0),
  }).strict().nullable().describe("Authorized r8 terrain cache with original acquisition sequence/time; 500ms controller cadence, explicit observe refresh, stale after 1000ms. Entities are exclusively in dynamic_entities."),
  dynamic_entities: z.object({ source: z.literal("rendered_camera_capture"), native_tick: safeCounterSchema,
    captured_at: frameTimestamp, captured_native_ns: nativeNanoseconds, partial: z.literal(true),
    render_invocation: safeCounterSchema.nullable(), capture_sequence: z.number().int().min(0).max(4294967295).nullable(),
    entities: z.array(minecraftObservedEntitySchema.safeExtend({
      bounds: z.object({ min: frameVector, max: frameVector }).strict(),
      aim_position: frameVector,
    })).max(32),
  }).strict().describe("Conservative optical r8 entity witnesses from the actual entity renderer and same completed GHV2 framebuffer; actual camera view/projection clip admission, at most 128 render candidates and 32 rows. Original render time and interpolated pose, never later live motion. Uncaptured renders neither replace nor refresh the last completed image's evidence. Fail closed on missing/replaced completed capture, wrong life/space, or age over 250ms; null capture identity means unavailable and requires no entities. Terrain remains independently assisted."),
  mechanics: z.array(z.object({ event_seq: safeCounterSchema.min(1), controller_generation: safeCounterSchema,
    sequence: safeCounterSchema.min(1), edge_ordinal: safeCounterSchema.min(1),
    stage: z.enum(["key_consumed", "attack_callback"]), native_tick: safeCounterSchema,
    recorded_native_ns: nativeNanoseconds, crosshair: z.enum(["entity", "block", "miss", "unavailable"]),
  }).strict()).max(32).describe("Ordinary stream attack key consumption and doAttack entry; neither proves a packet, accepted damage or a kill. Retained IDs are non-destructive, not new events on every frame."),
  mechanics_omitted: safeCounterSchema,
  audible: soundPageSchema,
  last_input: inputAppliedAckSchema.nullable(),
  effect_updates: z.array(controllerEffectUpdateSchema).max(8),
  effect_updates_omitted: safeCounterSchema,
  executive: jsonSchema.optional().describe("Trusted host-owned software status added after native capture; never world/evaluator evidence."),
}).strict().superRefine((frame, context) => {
  try {
    if (frame.last_input && (frame.last_input.applied_native_tick > frame.native_tick ||
      BigInt(frame.last_input.applied_native_ns) > BigInt(frame.captured_native_ns)))
      context.addIssue({ code: "custom", path: ["last_input"], message: "Input application cannot come from after this native capture" });
    if (frame.effect_updates.some(update => BigInt(update.recorded_native_ns) > BigInt(frame.captured_native_ns)))
      context.addIssue({ code: "custom", path: ["effect_updates"], message: "Later receipts cannot come from after this native capture" });
    if (frame.visible_world) {
      const age = BigInt(frame.captured_native_ns) - BigInt(frame.visible_world.captured_native_ns);
      if (age < 0n || (age > 1_000_000_000n && !frame.visible_world.stale))
        context.addIssue({ code: "custom", path: ["visible_world"],
          message: "World acquisition cannot follow this capture or label geometry older than 1000ms as fresh" });
    }
    if (frame.dynamic_entities.native_tick > frame.native_tick ||
      BigInt(frame.dynamic_entities.captured_native_ns) > BigInt(frame.captured_native_ns))
      context.addIssue({ code: "custom", path: ["dynamic_entities"], message: "Entity render time/tick cannot follow body capture" });
    const dynamic = frame.dynamic_entities, render = frame.view.render_capture;
    const witnessed = dynamic.render_invocation !== null && dynamic.capture_sequence !== null;
    if ((dynamic.render_invocation === null) !== (dynamic.capture_sequence === null) ||
      (!witnessed && dynamic.entities.length > 0) ||
      (witnessed && (!render || dynamic.render_invocation !== render.render_invocation ||
        dynamic.capture_sequence !== render.capture_sequence || dynamic.native_tick !== render.client_tick ||
        dynamic.captured_native_ns !== render.sampled_native_ns ||
        BigInt(frame.captured_native_ns) - BigInt(dynamic.captured_native_ns) > 250_000_000n)) ||
      dynamic.entities.some(entity => !entity.current || entity.observed_at !== dynamic.captured_at))
      context.addIssue({ code: "custom", path: ["dynamic_entities"], message: "Entities require fresh same-capture render witnesses with original times" });
    const entityCrosshair = frame.view.crosshair.kind === "entity" ? frame.view.crosshair : null;
    const crosshairTarget = entityCrosshair?.target;
    if (entityCrosshair && (!witnessed || !crosshairTarget ||
      !dynamic.entities.some(entity => entity.target.target_id === crosshairTarget.target_id &&
        entity.target.incarnation === crosshairTarget.incarnation)))
      context.addIssue({ code: "custom", path: ["view", "crosshair"], message: "Entity crosshair requires an admitted same-render entity, not a hidden presence marker" });
    if (frame.mechanics.some(event => event.native_tick > frame.native_tick ||
      BigInt(event.recorded_native_ns) > BigInt(frame.captured_native_ns)))
      context.addIssue({ code: "custom", path: ["mechanics"], message: "Mechanical facts cannot follow their containing frame" });
  } catch {
    context.addIssue({ code: "custom", path: ["captured_native_ns"], message: "Acquisition, application and receipt times require exact native decimal nanoseconds" });
  }
  if (new TextEncoder().encode(JSON.stringify(frame.effect_updates)).byteLength > 16384)
    context.addIssue({ code: "custom", path: ["effect_updates"], message: "Later receipts exceed the retained byte bound" });
  const matches = (target: TargetRef) => target.life_id === frame.life_id &&
    target.space.dimension_id === frame.space.dimension_id && target.space.space_epoch === frame.space.space_epoch;
  if (frame.view.crosshair.kind !== "miss" && frame.view.crosshair.target && !matches(frame.view.crosshair.target))
    context.addIssue({ code: "custom", path: ["view", "crosshair", "target"], message: "Crosshair target belongs to another life or space" });
  if (frame.visible_world) {
    for (const items of [frame.visible_world.blocks, frame.visible_world.entities])
      if (items.some(item => !matches(item.target)))
        context.addIssue({ code: "custom", path: ["visible_world"], message: "Cached world target belongs to another life or space" });
  }
  if (frame.dynamic_entities.entities.some(entity => !matches(entity.target)))
    context.addIssue({ code: "custom", path: ["dynamic_entities"], message: "Dynamic target belongs to another life or space" });
}).describe("Fresh local own-body/current-view feedback without a server inventory request. Last actual application ACK and bounded later GUI receipts have independent times; omitted receipt count is explicit. Distinct from authoritative game.observe(); no atomic PNG alignment or hidden state.");
export type MinecraftControllerFrame = z.infer<typeof minecraftControllerFrameSchema>;
export type ControllerFrame = MinecraftControllerFrame;
export const minecraftControllerFrameRequestSchema = z.object({ audio_cursor: soundCursorSchema.nullable() }).strict()
  .describe("Read basic controller feedback. First call requires audio_cursor:null; retain your own returned cursor for subsequent non-destructive sound pages.");

/** These values are compiled into the native resource and are the sampler's actual settings. */
export const minecraftProfileConfigurationSchema = z.object({
  sampler: z.object({ radius_blocks: z.literal(8), max_blocks: z.literal(144), max_entities: z.literal(32),
    max_age_ms: z.literal(1000), terrain_camera_independent: z.literal(true), occlusion_test: z.literal("native_raycast"),
    dynamic_candidate_limit: z.literal(128), entity_camera: z.literal("actual_render_view_projection"),
    entity_witness: z.literal("entity_renderer_same_completed_framebuffer"), entity_max_age_ms: z.literal(250),
    entity_pose: z.literal("original_render_interpolated"), entity_optical_gate: z.literal("air_water_bubble_only"),
    terrain_interval_ms: z.literal(500) }).strict(),
  actor_image: z.object({ codec: z.literal("png"), presentation: z.literal("opaque_rgb"), alignment: z.literal("unsynchronized") }).strict(),
  motor_profile: z.enum(["precise", "balanced", "fast"]),
  assistance: z.object({ semantic_helpers: z.literal(true) }).strict(),
  visible_gui: z.object({ projection: z.literal("current_visible_layout"), max_slots: z.literal(128),
    max_elements: z.literal(64), max_progress: z.literal(32), coordinates: z.literal("logical_gui") }).strict(),
  controller_feedback: z.object({ schema_version: z.literal(3), own_body: z.literal("current_client_state"),
    inventory: z.literal("client_prediction"), screen: z.literal("current_visible_layout"),
    visible_world: z.literal("last_authorized_observation"), render_capture: z.literal("capture_sequence_metadata_only"),
    render_max_age_ms: z.literal(5000), last_input: z.literal("actual_application_ack"),
    effect_updates: z.literal("bounded_later_receipts"), max_effect_updates: z.literal(8),
    max_effect_update_bytes: z.literal(16384), mechanics: z.literal("ordinary_attack_entry"),
    max_mechanics: z.literal(32), equipment_durability: z.literal(true), blocking: z.literal(true) }).strict(),
  audible: z.object({ source: z.literal("actually_delivered_allowlisted"), capacity: z.literal(128),
    ttl_ms: z.literal(1000), max_events_per_page: z.literal(8), cursors: z.literal("consumer_owned"),
    creeper_primed: z.literal(true), combat_cues: z.literal("hurt_death_shield_item_attack"), ordinary_groups: z.object({
      max_groups: z.literal(8), cue_distinct: z.literal(true), cue_priority: z.literal(true),
    }).strict() }).strict(),
}).strict();
export function minecraftProfileConfiguration(motorProfile: "precise" | "balanced" | "fast" = "balanced") {
  return minecraftProfileConfigurationSchema.parse({
    sampler: { radius_blocks: 8, max_blocks: 144, max_entities: 32, max_age_ms: 1000,
      terrain_camera_independent: true, occlusion_test: "native_raycast", dynamic_candidate_limit: 128,
      entity_camera: "actual_render_view_projection", entity_witness: "entity_renderer_same_completed_framebuffer",
      entity_max_age_ms: 250, entity_pose: "original_render_interpolated",
      entity_optical_gate: "air_water_bubble_only", terrain_interval_ms: 500 },
    actor_image: { codec: "png", presentation: "opaque_rgb", alignment: "unsynchronized" },
    motor_profile: motorProfile, assistance: { semantic_helpers: true },
    visible_gui: { projection: "current_visible_layout", max_slots: 128, max_elements: 64, max_progress: 32, coordinates: "logical_gui" },
    controller_feedback: { schema_version: 3, own_body: "current_client_state", inventory: "client_prediction",
      screen: "current_visible_layout", visible_world: "last_authorized_observation",
      render_capture: "capture_sequence_metadata_only", render_max_age_ms: 5000,
      last_input: "actual_application_ack", effect_updates: "bounded_later_receipts", max_effect_updates: 8,
      max_effect_update_bytes: 16384, mechanics: "ordinary_attack_entry", max_mechanics: 32,
      equipment_durability: true, blocking: true },
    audible: { source: "actually_delivered_allowlisted", capacity: 128, ttl_ms: 1000,
      max_events_per_page: 8, cursors: "consumer_owned", creeper_primed: true, combat_cues: "hurt_death_shield_item_attack",
      ordinary_groups: { max_groups: 8, cue_distinct: true, cue_priority: true } },
  });
}

const inventoryCountsSchema = z.record(z.string().regex(/^(?:[a-z0-9_.-]+:)?[a-z][a-z0-9_./-]*$/), safeCounterSchema);
export const minecraftGuiTransactionFactSchema = z.object({
  kind: z.literal("gui_transaction"), mechanism: z.literal("visible_gui"),
  operation_index: z.number().int().min(0).max(15), receipt_ref: identitySchema,
  input_application: z.literal("confirmed"), effect_status: z.literal("confirmed"),
  inventory_before: inventoryCountsSchema.refine(value => Object.keys(value).length <= 128),
  inventory_after: inventoryCountsSchema.refine(value => Object.keys(value).length <= 128),
  productions: z.array(z.object({ producer: z.enum(["crafting", "smelting", "trading", "anvil"]),
    item: itemName, count: z.number().int().min(1).max(4096),
    source: z.literal("server_result_slot_take"), production_confirmed: z.boolean() }).strict()).max(128),
}).strict();
/** Only native-confirmed, action-indexed receipts; never infer facts from inventory differences or ACK alone. */
export function confirmedMinecraftGuiTransactions(action: unknown, evidence: unknown) {
  const request = minecraftActionSchema.safeParse(action);
  const facts: z.infer<typeof minecraftGuiTransactionFactSchema>[] = [];
  if (!request.success || request.data.kind !== "screen_input" || evidence === null || typeof evidence !== "object" ||
    !("gui_transactions" in evidence) || !Array.isArray(evidence.gui_transactions) || evidence.gui_transactions.length > 16) return facts;
  const receipts = new Set<string>(), indices = new Set<number>();
  for (const value of evidence.gui_transactions) {
    const fact = minecraftGuiTransactionFactSchema.safeParse(value);
    if (!fact.success || fact.data.operation_index >= request.data.operations.length ||
      receipts.has(fact.data.receipt_ref) || indices.has(fact.data.operation_index)) continue;
    receipts.add(fact.data.receipt_ref); indices.add(fact.data.operation_index); facts.push(fact.data);
  }
  return facts;
}
export const minecraftProductionFactSchema = z.object({
  kind: z.literal("item_production"), item: itemName, actor: z.literal("own_player"),
  mechanism: z.literal("helper"), input_application: z.literal("confirmed"), effect_status: z.literal("confirmed"),
  inventory_before: inventoryCountsSchema, inventory_after: inventoryCountsSchema, receipt_ref: identitySchema,
}).strict();
const craftReceiptSchema = z.object({
  stage_index: z.number().int().min(0).max(7), item: itemName, executions: z.number().int().min(1).max(16),
  output_per_execution: z.number().int().min(1).max(64), completed_executions: z.number().int().min(1).max(16),
  confirmed_executions: z.number().int().min(1).max(16), status: z.enum(["succeeded", "partial"]),
  inventory_receipt_confirmed: z.literal(true), inventory_custody_confirmed: z.literal(true),
  cursor_count: z.literal(0), grid_count: z.literal(0), receipt_ref: identitySchema,
  inventory_before: inventoryCountsSchema.refine(value => Object.keys(value).length <= 64),
  inventory_after: inventoryCountsSchema.refine(value => Object.keys(value).length <= 64),
}).strict();
/** Only the actual ordered server-confirmed prefix, including a final partial stage. */
export function confirmedMinecraftCraftStages(action: unknown, evidence: unknown) {
  const request = minecraftActionSchema.safeParse(action);
  const confirmed: z.infer<typeof craftReceiptSchema>[] = [];
  if (!request.success || request.data.kind !== "craft" || evidence === null || typeof evidence !== "object" ||
    !("craft_stages" in evidence) || !Array.isArray(evidence.craft_stages)) return confirmed;
  const requested = "sequence" in request.data ? request.data.sequence : [request.data];
  if (evidence.craft_stages.length > requested.length) return confirmed;
  const receipts = new Set<string>();
  let previousAfter: Record<string, number> | null = null;
  for (let index = 0; index < evidence.craft_stages.length; index++) {
    const parsed = craftReceiptSchema.safeParse(evidence.craft_stages[index]), selected = requested[index]!;
    if (!parsed.success) break;
    const stage = parsed.data;
    const actual = (stage.inventory_after[stage.item] ?? 0) - (stage.inventory_before[stage.item] ?? 0);
    if (stage.stage_index !== index || stage.item !== selected.item || stage.executions !== selected.executions ||
      stage.completed_executions > selected.executions || stage.confirmed_executions !== stage.completed_executions ||
      actual !== stage.confirmed_executions * stage.output_per_execution || receipts.has(stage.receipt_ref) ||
      (stage.status === "succeeded") !== (stage.confirmed_executions === selected.executions) ||
      previousAfter !== null && (Object.keys(previousAfter).length !== Object.keys(stage.inventory_before).length ||
        Object.keys(previousAfter).some(item => previousAfter![item] !== stage.inventory_before[item]))) break;
    receipts.add(stage.receipt_ref); confirmed.push(stage);
    if (stage.status !== "succeeded") break;
    previousAfter = stage.inventory_after;
  }
  return confirmed;
}
export const minecraftBlockRemovalFactSchema = z.object({
  kind: z.literal("block_removal"), actor: z.literal("own_player"), mechanism: z.literal("helper"),
  effect_status: z.literal("confirmed"), source: z.literal("server_block_update"), target_name: itemName,
  receipt_ref: identitySchema,
}).strict();
export const minecraftEffectUncertaintyFactSchema = z.object({
  kind: z.literal("effect_uncertainty"), actor: z.literal("own_player"), mechanism: z.enum(["helper", "visible_gui"]),
  operation_kind: z.string().min(1).max(80), effect_status: z.literal("unknown"), receipt_ref: identitySchema,
  reason: z.enum(["effect_unconfirmed", "inventory_receipt_unconfirmed"]),
}).strict();

type HistoricalSoundObservationV2 = {
  category: "movement" | "interaction" | "combat" | "creature" | "weather";
  direction: "here" | "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  distance: "near" | "mid" | "far"; observed_at: string;
};
const historicalSoundV2Schema = z.object({
  category: z.enum(["movement", "interaction", "combat", "creature", "weather"]),
  direction: z.enum(["here", "N", "NE", "E", "SE", "S", "SW", "W", "NW"]),
  distance: z.enum(["near", "mid", "far"]), observed_at: timestamp,
}).strict() satisfies z.ZodType<HistoricalSoundObservationV2>;

/** Explicit read codec. This shape is never an active adapter observation. */
export interface HistoricalObservationV2 {
  schema_version: 2; world_id: string; epoch: number; session_id: string; life: PlayerLife;
  observation_seq: number; captured_at: string; profile_id: "player-observable-structured";
  preset_id: "minecraft-observable-initial-r2"; player: MinecraftPlayer;
  blocks: { id: string; name: string; position: Vec3Data; observed_at: string; current: boolean }[];
  entities: { id: string; name: string; position: Vec3Data; observed_at: string; current: boolean; item_name?: string }[];
  sounds: HistoricalSoundObservationV2[]; coverage: { partial: true; max_age_ms: number };
}
const historicalBlock = z.object({ id: z.string().max(160), ...observedFields }).strict();
export const historicalObservationV2Schema = z.object({ schema_version: z.literal(2), world_id: z.string().max(160),
  epoch: safeCounterSchema, session_id: identitySchema, life: playerLifeSchema, observation_seq: safeCounterSchema,
  captured_at: z.string().max(40), profile_id: z.literal("player-observable-structured"), preset_id: z.literal("minecraft-observable-initial-r2"),
  player: minecraftPlayerSchema, blocks: z.array(historicalBlock).max(200),
  entities: z.array(historicalBlock.extend({ item_name: itemProjection }).strict()).max(32), sounds: z.array(historicalSoundV2Schema).max(8),
  coverage: z.object({ partial: z.literal(true), max_age_ms: z.number().int().min(0).max(1000) }).strict(),
}).strict().refine(value => value.blocks.length + value.entities.length + value.sounds.length + value.player.inventory.length <= 256) satisfies z.ZodType<HistoricalObservationV2>;
