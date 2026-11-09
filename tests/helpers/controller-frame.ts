/** Synthetic wire input for semantic frame/transport guards, never gameplay or producer evidence. */
export function controllerFrameFixture(lifeId = 3, spaceEpoch = 4) {
  const space = { dimension_id: "minecraft:overworld", space_epoch: spaceEpoch };
  const target = { target_id: "authorized-stone", incarnation: 2, life_id: lifeId, space };
  const position = { x: -1.5, y: 64, z: 2.5 }, at = "2026-10-29T12:00:00.000Z";
  const event = { sequence: 11, category: "combat", cue: "creeper_primed", direction: "NE", distance: "near",
    heard_at: at, heard_native_ns: "-9007199254740997" };
  const stream = `life${lifeId}-space${spaceEpoch}`;
  const page = { stream_id: stream, after_sequence: 9, next_cursor: { stream_id: stream, sequence: 11 },
    gap: true, omitted_before: 1, has_more: false, events: [event] };
  return { schema_version: 3, frame_seq: 7, native_tick: 125, captured_native_ns: "-9007199254740993", captured_at: at,
    profile_id: "minecraft_assisted_rgb_360_r8_control_v6", profile_version: 6, life_id: lifeId, space,
    player: { position, velocity_blocks_per_tick: { x: 0.1, y: -0.3, z: 0 }, health: 18, food: 16,
      on_ground: false, in_water: true, submerged_in_water: true, in_lava: false, air_ticks: -12, max_air_ticks: 300,
      sprinting: false, sneaking: false, swimming: true, gliding: false, vehicle_type: null, selected_hotbar: 2,
      xp_level: 4, xp_progress: 0.25, blocking: false, active_use: { hand: "main", item: "bow", elapsed_ticks: 8, remaining_ticks: 71992 },
      equipment: [{ slot: "main", item: "bow", count: 1, durability: null }, { slot: "off", item: null, count: 0, durability: null }],
      status_effects: [{ id: "minecraft:water_breathing", amplifier: 0, duration_ticks: -1 }] },
    inventory: { source: "client_prediction", captured_native_ns: "-9007199254740993",
      items: [{ name: "oak_log", display_name: "Oak Log", count: 2, slot: 0 }] },
    view: { applied_pose: { yaw_radians: 0.5, pitch_radians: 0.25 }, attack_indicator: 0.5,
      crosshair: { kind: "block", hit_position: { x: -1, y: 65, z: 3 }, block_position: { x: -1, y: 65, z: 3 },
        face: "north", target },
      render_capture: { capture_sequence: 42, client_tick: 120, render_invocation: 99,
        sampled_native_ns: "-9007199254740999", capture_native_ns: "-9007199254740998", position,
        yaw_radians: -1, pitch_radians: -0.25 } },
    screen: null,
    visible_world: { source: "last_authorized_observation", observation_seq: 20, captured_at: "2026-10-29T11:59:58.000Z",
      captured_native_ns: "-9007199256740993", stale: true,
      blocks: [{ target, name: "stone", position, observed_at: "2026-10-29T11:59:58.000Z", current: true }], entities: [] },
    dynamic_entities: { source: "current_authorized_tick", native_tick: 125, captured_native_ns: "-9007199254740993",
      captured_at: at, partial: true, entities: [] },
    mechanics: [], mechanics_omitted: 0,
    audible: page, last_input: null, effect_updates: [], effect_updates_omitted: 0 };
}
