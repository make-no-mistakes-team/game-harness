import { expect, test } from "bun:test";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { minecraftControllerFrameSchema, minecraftControllerFrameRequestSchema, minecraftObservationV3Schema,
  minecraftProfileConfigurationSchema, soundCursorSchema, soundPageSchema } from "../src/shared/minecraft.ts";
import { getGameAPIReference } from "../src/shared/validation.ts";
import { createMinecraftAdapter } from "../src/server/minecraft-adapter.ts";
import { RegisteredAdapterContract } from "../src/server/registered-adapter.ts";
import { contractHash } from "../src/server/adapter-contract.ts";
import { minecraftObservationFixture, minecraftTestAdapter } from "./helpers/adapter-contract.ts";
import { controllerFrameFixture as frame } from "./helpers/controller-frame.ts";

const seed = frame(), space = seed.space, target = seed.view.crosshair.target, position = seed.player.position;
const at = seed.captured_at, event = seed.audible.events[0]!, page = seed.audible;

test("controller frame keeps signed nanosecond precision, drowning air and infinite own effects", () => {
  const parsed = minecraftControllerFrameSchema.parse(frame());
  expect(parsed.captured_native_ns).toBe("-9007199254740993");
  expect(parsed.view.render_capture?.capture_native_ns).toBe("-9007199254740998");
  expect(parsed.audible.events[0]!.heard_native_ns).toBe("-9007199254740997");
  expect(parsed.player.air_ticks).toBe(-12);
  expect(parsed.player.status_effects[0]!.duration_ticks).toBe(-1);
  expect(parsed.visible_world?.captured_at).toBe("2026-10-29T11:59:58.000Z");
  expect(parsed.view.render_capture?.yaw_radians).toBe(-1);
  expect(parsed.view.applied_pose.yaw_radians).toBe(0.5);
});

test("capture metadata preserves actual unwrapped camera yaw after several full turns", () => {
  const f = frame();
  const parsed = minecraftControllerFrameSchema.parse({ ...f,
    view: { ...f.view, render_capture: { ...f.view.render_capture, yaw_radians: 6 * Math.PI } } });
  expect(parsed.view.render_capture?.yaw_radians).toBe(6 * Math.PI);
});

test("world acquisition cannot come from the future or relabel expired geometry as fresh", () => {
  const f = frame(), captured = BigInt(f.captured_native_ns);
  const worldAt = (age: bigint, stale: boolean) => ({ ...f, visible_world: { ...f.visible_world,
    captured_native_ns: String(captured - age), stale } });
  expect(minecraftControllerFrameSchema.safeParse(worldAt(0n, false)).success).toBe(true);
  expect(minecraftControllerFrameSchema.safeParse(worldAt(1_000_000_000n, false)).success).toBe(true);
  expect(minecraftControllerFrameSchema.safeParse(worldAt(1_000_000_001n, false)).success).toBe(false);
  expect(minecraftControllerFrameSchema.safeParse(worldAt(1_000_000_001n, true)).success).toBe(true);
  expect(minecraftControllerFrameSchema.safeParse(worldAt(-1n, false)).success).toBe(false);
  expect(minecraftControllerFrameSchema.safeParse(worldAt(-1n, true)).success).toBe(false);
});

test("dynamic entities retain actual render identity, original time and pose without retiming terrain", () => {
  const f = frame();
  const entity = { target, name: "husk", position, observed_at: at, current: true,
    bounds: { min: position, max: { ...position, y: position.y + 2 } }, aim_position: position };
  const render = f.view.render_capture;
  const dynamic = { ...f.dynamic_entities, native_tick: render.client_tick,
    captured_native_ns: render.sampled_native_ns, render_invocation: render.render_invocation,
    capture_sequence: render.capture_sequence, entities: [entity] };
  const parsed = minecraftControllerFrameSchema.parse({ ...f, dynamic_entities: dynamic });
  expect(parsed.visible_world?.captured_at).toBe(f.visible_world.captured_at);
  expect(parsed.dynamic_entities.entities[0]!.name).toBe("husk");
  for (const invalid of [
    { ...dynamic, native_tick: f.native_tick + 1 },
    { ...dynamic, captured_native_ns: String(BigInt(f.captured_native_ns) + 1n) },
    { ...dynamic, captured_native_ns: f.captured_native_ns },
    { ...dynamic, render_invocation: render.render_invocation + 1 },
    { ...dynamic, capture_sequence: render.capture_sequence + 1 },
    { ...dynamic, render_invocation: null, capture_sequence: null },
    { ...dynamic, entities: [{ ...entity, observed_at: "2026-10-29T12:00:00.001Z" }] },
    { ...dynamic, entities: [{ ...entity, current: false }] },
    { ...dynamic, entities: [{ ...entity, target: { ...target, life_id: 99 } }] },
    { ...dynamic, entities: [{ ...entity, health: 20 }] },
    { ...dynamic, rejected_count: 100 },
    { ...dynamic, entities: Array.from({ length: 33 }, () => entity) },
  ]) expect(minecraftControllerFrameSchema.safeParse({ ...f, dynamic_entities: invalid }).success).toBe(false);
  expect(minecraftControllerFrameSchema.safeParse({ ...f, captured_native_ns: String(BigInt(render.sampled_native_ns) + 250_000_001n),
    dynamic_entities: dynamic }).success).toBe(false);
  expect(minecraftControllerFrameSchema.safeParse({ ...f, dynamic_entities: dynamic,
    view: { ...f.view, render_capture: null } }).success).toBe(false);
  const crosshair = { kind: "entity", hit_position: position, target };
  expect(minecraftControllerFrameSchema.safeParse({ ...f, dynamic_entities: dynamic,
    view: { ...f.view, crosshair } }).success).toBe(true);
  expect(minecraftControllerFrameSchema.safeParse({ ...f, view: { ...f.view, crosshair } }).success).toBe(false);
  expect(minecraftControllerFrameSchema.safeParse({ ...f, view: { ...f.view, crosshair: { ...crosshair, target: null } } }).success).toBe(false);
});

test("mechanical attack evidence distinguishes consumed keys from callbacks and damage", () => {
  const f = frame();
  const callback = { event_seq: 1, controller_generation: 2, sequence: 3, edge_ordinal: 4,
    stage: "attack_callback", native_tick: f.native_tick, recorded_native_ns: f.captured_native_ns, crosshair: "entity" };
  expect(minecraftControllerFrameSchema.parse({ ...f, mechanics: [callback] }).mechanics[0]!.edge_ordinal).toBe(4);
  for (const invalid of [{ ...callback, damage: 5 }, { ...callback, stage: "accepted_damage" },
    { ...callback, native_tick: f.native_tick + 1 }])
    expect(minecraftControllerFrameSchema.safeParse({ ...f, mechanics: [invalid] }).success).toBe(false);
});

test("own blocking, selected durability and heard combat cues remain actor facts", () => {
  const f = frame();
  const player = { ...f.player, blocking: true,
    active_use: { hand: "off", item: "shield", elapsed_ticks: 6, remaining_ticks: 71994 },
    equipment: [{ slot: "main", item: "wooden_sword", count: 1, durability: { damage: 58, maximum: 59 } },
      { slot: "off", item: "shield", count: 1, durability: { damage: 0, maximum: 336 } }] };
  expect(minecraftControllerFrameSchema.parse({ ...f, player }).player.blocking).toBe(true);
  expect(minecraftControllerFrameSchema.safeParse({ ...f, player: { ...player,
    equipment: [{ ...player.equipment[0], durability: { damage: 60, maximum: 59 } }] } }).success).toBe(false);
  for (const cue of ["shield_block", "shield_break", "item_break", "attack_nodamage", "mob_hurt", "mob_death"])
    expect(soundPageSchema.safeParse({ ...page, events: [{ ...event, cue }] }).success).toBe(true);
});

test("capture sequence follows the actual unsigned GHV2 counter including wrap to zero", () => {
  const f = frame();
  const withSequence = (capture_sequence: number) => ({ ...f,
    view: { ...f.view, render_capture: { ...f.view.render_capture, capture_sequence } } });
  expect(minecraftControllerFrameSchema.parse(withSequence(0)).view.render_capture?.capture_sequence).toBe(0);
  expect(minecraftControllerFrameSchema.parse(withSequence(4294967295)).view.render_capture?.capture_sequence).toBe(4294967295);
  for (const sequence of [-1, 4294967296])
    expect(minecraftControllerFrameSchema.safeParse(withSequence(sequence)).success).toBe(false);
});

test("frame admission requires the whole basic feedback shape rather than a legacy player or defaults", () => {
  const complete = frame();
  for (const field of Object.keys(complete)) {
    const missing: Record<string, unknown> = { ...complete }; delete missing[field];
    expect(minecraftControllerFrameSchema.safeParse(missing).success).toBe(false);
  }
  for (const field of Object.keys(complete.player)) {
    const player: Record<string, unknown> = { ...complete.player }; delete player[field];
    expect(minecraftControllerFrameSchema.safeParse({ ...complete, player }).success).toBe(false);
  }
  const adapter = minecraftTestAdapter();
  expect(minecraftControllerFrameSchema.safeParse({ ...complete, player: minecraftObservationFixture(adapter).data.player }).success).toBe(false);
  expect(minecraftObservationV3Schema.safeParse(complete).success).toBe(false);
});

test("frame projection rejects hidden state, private scope and pretend atomic image alignment", () => {
  const f = frame();
  for (const invalid of [
    { ...f, scope: { world_id: "private-save", native_boot_id: "private-boot" } },
    { ...f, seed: "private-seed" },
    { ...f, player: { ...f.player, nbt: {} } },
    { ...f, inventory: { ...f.inventory, source: "server_confirmed" } },
    { ...f, view: { ...f.view, image_alignment: "atomic" } },
    { ...f, view: { ...f.view, render_capture: { ...f.view.render_capture, scope: { life_id: 3 } } } },
    { ...f, view: { ...f.view, crosshair: { ...f.view.crosshair, health: 20, fuse_ticks: 20 } } },
    { ...f, audible: { ...page, events: [{ ...event, source_position: position }] } },
    { ...f, audible: { ...page, events: [{ ...event, entity_id: "hidden-source" }] } },
  ]) expect(minecraftControllerFrameSchema.safeParse(invalid).success).toBe(false);
});

test("application feedback admits actual input ACK separately from a later uncertain GUI receipt", () => {
  const value = { ...frame(),
    last_input: { controller_generation: 2, sequence: 4, ordered_edge_prefix: 1,
      applied_native_tick: 124, applied_native_ns: "-9007199254741000",
      held: { forward: false, back: false, left: false, right: false, jump: false,
        sprint: false, sneak: false, attack: false, use: false },
      applied_pose: { yaw_radians: 0, pitch_radians: 0 }, input_application: "confirmed", reason: null },
    effect_updates: [{ controller_generation: 2, sequence: 4, recorded_native_ns: "-9007199254740995",
      result: { status: "unknown", summary: "Server receipt not confirmed", evidence: { effect_confirmed: false } } }],
    effect_updates_omitted: 3,
  };
  const parsed = minecraftControllerFrameSchema.safeParse(value);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.last_input?.input_application).toBe("confirmed");
  expect(parsed.data.effect_updates[0]?.result.status).toBe("unknown");
  expect(minecraftControllerFrameSchema.safeParse({ ...value,
    last_input: { ...value.last_input, owner: { operation_id: "private-owner" } } }).success).toBe(false);
  expect(minecraftControllerFrameSchema.safeParse({ ...value,
    last_input: { ...value.last_input, applied_native_tick: 126 } }).success).toBe(false);
  expect(minecraftControllerFrameSchema.safeParse({ ...value,
    last_input: { ...value.last_input, applied_native_ns: "-9007199254740992" } }).success).toBe(false);
  expect(minecraftControllerFrameSchema.safeParse({ ...value, effect_updates: [{
    ...value.effect_updates[0], recorded_native_ns: "-9007199254740992",
  }] }).success).toBe(false);
});

test("frame rejects unsafe counters, malformed nanoseconds, nonfinite values and unbounded collections", () => {
  const f = frame();
  for (const captured_native_ns of [9007199254740992, "1.5", "1e9", "+1", "", "00", "1".repeat(21)])
    expect(minecraftControllerFrameSchema.safeParse({ ...f, captured_native_ns }).success).toBe(false);
  for (const invalid of [
    { ...f, frame_seq: 0 }, { ...f, native_tick: Number.MAX_SAFE_INTEGER + 1 }, { ...f, captured_at: "not-an-ISO-time" },
    { ...f, player: { ...f.player, velocity_blocks_per_tick: { ...position, x: Infinity } } },
    { ...f, player: { ...f.player, selected_hotbar: 9 } }, { ...f, player: { ...f.player, xp_progress: 1.01 } },
    { ...f, player: { ...f.player, air_ticks: -2147483649 } },
    { ...f, player: { ...f.player, status_effects: [{ id: "speed", amplifier: 0, duration_ticks: -2 }] } },
    { ...f, player: { ...f.player, status_effects: Array.from({ length: 33 }, () => f.player.status_effects[0]) } },
    { ...f, inventory: { ...f.inventory, items: Array.from({ length: 65 }, () => f.inventory.items[0]) } },
    { ...f, view: { ...f.view, attack_indicator: -0.01 } },
    { ...f, view: { ...f.view, crosshair: { ...f.view.crosshair, block_position: { ...position, x: 0.5 } } } },
    { ...f, visible_world: { ...f.visible_world, blocks: Array.from({ length: 145 }, () => f.visible_world.blocks[0]) } },
  ]) expect(minecraftControllerFrameSchema.safeParse(invalid).success).toBe(false);
});

test("independently sampled inventory and earlier render metadata do not pretend an atomic body/image snapshot", () => {
  const f = frame();
  const parsed = minecraftControllerFrameSchema.parse({ ...f, frame_seq: Number.MAX_SAFE_INTEGER,
    inventory: { ...f.inventory, captured_native_ns: "-9007199254740992" },
    player: { ...f.player, air_ticks: -2147483648, xp_progress: 1, active_use: null, vehicle_type: "minecraft:boat",
      status_effects: [], equipment: [{ slot: "feet", item: "leather_boots", count: 1, durability: { damage: 0, maximum: 65 } }] },
    screen: { identity: { screen_id: "actual-rendered-inventory", incarnation: 2, layout_revision: 1 },
      content_revision: 3, screen_kind: "inventory", viewport: { width: 320, height: 240, scale_factor: 2 },
      slots: [], cursor: { item: null, count: 0 }, elements: [], progress: [] } });
  expect(parsed.inventory.captured_native_ns).toBe("-9007199254740992");
  expect(parsed.view.render_capture?.capture_sequence).toBe(42);
  expect(parsed.view.render_capture?.client_tick).toBe(120);
  expect(parsed.native_tick).toBe(125);
  expect(parsed.screen?.screen_kind).toBe("inventory");
});

test("own equipment and use admission rejects duplicate slots, impossible empty stacks and hidden effect fields", () => {
  const f = frame();
  for (const player of [
    { ...f.player, equipment: [f.player.equipment[0], f.player.equipment[0]] },
    { ...f.player, equipment: [{ slot: "main", item: null, count: 1 }] },
    { ...f.player, equipment: [{ slot: "main", item: "bow", count: 0 }] },
    { ...f.player, active_use: { ...f.player.active_use, remaining_ticks: -1 } },
    { ...f.player, active_use: { ...f.player.active_use, hand: "third" } },
    { ...f.player, status_effects: [{ ...f.player.status_effects[0], hidden_duration: 120 }] },
  ]) expect(minecraftControllerFrameSchema.safeParse({ ...f, player }).success).toBe(false);
});

test("crosshair references and last-world samples cannot cross the frame life or dimension fence", () => {
  const f = frame();
  for (const foreign of [{ ...target, life_id: 4 }, { ...target, space: { ...space, space_epoch: 5 } },
    { ...target, space: { ...space, dimension_id: "minecraft:the_nether" } }]) {
    expect(minecraftControllerFrameSchema.safeParse({ ...f, view: { ...f.view,
      crosshair: { ...f.view.crosshair, target: foreign } } }).success).toBe(false);
    expect(minecraftControllerFrameSchema.safeParse({ ...f, visible_world: { ...f.visible_world,
      blocks: [{ ...f.visible_world.blocks[0], target: foreign }] } }).success).toBe(false);
  }
  for (const crosshair of [{ kind: "miss" },
    { ...f.view.crosshair, target: null }])
    expect(minecraftControllerFrameSchema.safeParse({ ...f, visible_world: null, view: { ...f.view, render_capture: null, crosshair } }).success).toBe(true);
});

test("sound pages preserve independent continuation and reject contradictory or foreign cursors", () => {
  expect(soundPageSchema.parse(page).next_cursor.sequence).toBe(11);
  expect(soundCursorSchema.parse({ stream_id: "life3-space4", sequence: Number.MAX_SAFE_INTEGER }).sequence).toBe(Number.MAX_SAFE_INTEGER);
  const expired = { ...page, after_sequence: 20, next_cursor: { stream_id: page.stream_id, sequence: 140 },
    events: [], omitted_before: 120 };
  expect(soundPageSchema.parse(expired).next_cursor.sequence).toBe(140);
  expect(soundPageSchema.safeParse({ ...expired, next_cursor: { stream_id: page.stream_id, sequence: 20 } }).success).toBe(false);
  expect(soundPageSchema.parse({ ...page, after_sequence: 11, next_cursor: page.next_cursor,
    events: [], gap: false, omitted_before: 0 }).next_cursor.sequence).toBe(11);
  for (const invalid of [
    { ...page, next_cursor: { stream_id: "other-life", sequence: 11 } },
    { ...page, next_cursor: { stream_id: page.stream_id, sequence: 10 } },
    { ...page, after_sequence: 11 }, { ...page, gap: false },
    { ...page, events: [event, event] },
    { ...page, events: [{ ...event, sequence: 12 }, event] },
    { ...page, events: [event, { ...event, sequence: 13 }], next_cursor: { stream_id: page.stream_id, sequence: 13 } },
    { ...page, omitted_before: 2 },
    { ...page, events: Array.from({ length: 9 }, (_, i) => ({ ...event, sequence: 11 + i })) },
    { ...page, events: [{ ...event, cue: "creeper_fuse" }] },
    { ...page, events: [{ ...event, category: "movement" }] },
  ]) expect(soundPageSchema.safeParse(invalid).success).toBe(false);
});

test("registered frame request requires an explicit consumer cursor and generated help validates the strict response", () => {
  const adapter = minecraftTestAdapter();
  const registry = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas, adapter.capabilityValidators);
  expect(registry.parseCapability("minecraft.controller_frame", 2, { audio_cursor: null })).toEqual({ audio_cursor: null });
  expect(registry.parseCapability("minecraft.controller_frame", 2, { audio_cursor: page.next_cursor })).toEqual({ audio_cursor: page.next_cursor });
  for (const args of [{}, { audio_cursor: { stream_id: "x", sequence: -1 } },
    { audio_cursor: { stream_id: "x", sequence: Number.MAX_SAFE_INTEGER + 1 } },
    { audio_cursor: null, include_nbt: true }]) {
    expect(minecraftControllerFrameRequestSchema.safeParse(args).success).toBe(false);
    expect(() => registry.parseCapability("minecraft.controller_frame", 2, args)).toThrow();
  }
  const reference = getGameAPIReference(adapter), method = Reflect.get(reference, "methods").frame;
  expect(method.parameters).toEqual([{ name: "audio_cursor", type: "Json" }]);
  expect(method.result).toBe("MinecraftControllerFrame");
  expect(validateJsonSchemaValue(method.result_schema, frame()).success).toBe(true);
  expect(validateJsonSchemaValue(method.result_schema, { ...frame(), scope: {} }).success).toBe(false);
  expect(validateJsonSchemaValue(method.result_schema, { ...frame(), captured_native_ns: 9007199254740992 }).success).toBe(false);
  expect(validateJsonSchemaValue(method.result_schema, { ...frame(), view: { ...frame().view, image_alignment: "atomic" } }).success).toBe(false);
});

test("feedback profile negotiation rejects old identities and omitted or inflated feedback permissions", () => {
  const adapter = minecraftTestAdapter(), descriptor = adapter.descriptor;
  for (const profile of [{ ...descriptor.observation.profile, id: "minecraft_assisted_rgb_360_r8_gui_v2", version: 2 },
    { ...descriptor.observation.profile, id: "minecraft_assisted_rgb_360_r8_control_v4", version: 4 },
    { ...descriptor.observation.profile, id: "minecraft_assisted_rgb_360_r8_control_v6", version: 6 },
    { ...descriptor.observation.profile, version: 2 }])
    expect(() => createMinecraftAdapter({ ...descriptor, observation: { ...descriptor.observation, profile } })).toThrow();
  expect(minecraftControllerFrameSchema.safeParse({ ...frame(),
    profile_id: "minecraft_assisted_rgb_360_r8_control_v4", profile_version: 4 }).success).toBe(false);
  const configuration = descriptor.observation.profile.configuration;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) throw new Error("Expected profile object");
  for (const invalid of [{ ...configuration, controller_feedback: undefined },
    { ...configuration, sampler: { ...(configuration.sampler as Record<string, unknown>), entity_camera: undefined } },
    { ...configuration, sampler: { ...(configuration.sampler as Record<string, unknown>), entity_max_age_ms: 1000 } },
    { ...configuration, sampler: { ...(configuration.sampler as Record<string, unknown>), camera_independent: true } },
    { ...configuration, controller_feedback: { inventory: "server_confirmed" } },
    { ...configuration, audible: { source: "all_sound_sources" } },
    { ...configuration, actor_image: { codec: "png", presentation: "opaque_rgb", alignment: "atomic" } }])
    expect(minecraftProfileConfigurationSchema.safeParse(invalid).success).toBe(false);
});

test("ordinary audible permissions require the exact bounded cue-distinct priority declaration", () => {
  const adapter = minecraftTestAdapter(), descriptor = adapter.descriptor;
  const configuration = minecraftProfileConfigurationSchema.parse(descriptor.observation.profile.configuration);
  for (const ordinary_groups of [undefined, {}, { max_groups: 8, cue_distinct: true },
    { max_groups: 9, cue_distinct: true, cue_priority: true },
    { max_groups: 8, cue_distinct: false, cue_priority: true },
    { max_groups: 8, cue_distinct: true, cue_priority: false },
    { max_groups: 8, cue_distinct: true, cue_priority: true, hidden_fuse: true }]) {
    const invalid = { ...configuration, audible: { ...configuration.audible, ordinary_groups } };
    expect(minecraftProfileConfigurationSchema.safeParse(invalid).success).toBe(false);
    const wireConfiguration = JSON.parse(JSON.stringify(invalid));
    const profile = { ...descriptor.observation.profile, configuration: wireConfiguration,
      configuration_hash: contractHash(wireConfiguration) };
    expect(() => createMinecraftAdapter({ ...descriptor, observation: { ...descriptor.observation, profile } })).toThrow();
  }
});

test("client-predicted controller inventory never becomes a server observation or a possession witness", () => {
  const adapter = minecraftTestAdapter(), current = minecraftObservationFixture(adapter, { observation_seq: 1 });
  const goal = adapter.goals.find(goal => goal.goal_id === "collect_wood")!;
  const baseline = adapter.captureBaseline(goal, current);
  const scope = { world_id: current.world_id, session_id: current.session_id, epoch: current.epoch,
    native_boot_id: current.native_boot_id, run_id: "run", run_generation: 1, life_id: current.life.life_id,
    space_epoch: current.space.space_epoch, execution_id: "frame-read", source_hash: "b".repeat(64) };
  const manifest = { goal, run_id: "run", world_id: current.world_id, session_id: current.session_id,
    epoch: current.epoch, native_boot_id: current.native_boot_id, baseline };
  const data = minecraftControllerFrameSchema.parse(frame());
  const evidence = { evidence_id: "frame-inventory", adapter_id: adapter.descriptor.adapter.id, scope, observed_at: at,
    schema: { id: "minecraft_controller_frame", version: 2, hash: contractHash(adapter.schemas.capabilities["minecraft.controller_frame@2"]) },
    data: JSON.parse(JSON.stringify(data)) };
  expect(adapter.verifyCompletion(manifest, [evidence]).status).not.toBe("verified");
  expect(adapter.verifyCompletion(manifest, [{ ...evidence,
    schema: { id: "observation_v3", version: 3, hash: adapter.descriptor.observation.schema_hash } }]).status).not.toBe("verified");
});
