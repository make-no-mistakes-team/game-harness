import { createHash } from "node:crypto";
import type { Json } from "../shared/contracts.ts";

/** Expanded public configuration; raw sampling and planning diagnostics remain private. */
export const OBSERVATION_PROFILE = {
  profile_id: "player-observable-structured",
  profile_version: 1,
  preset_id: "minecraft-observable-initial-r1",
  minecraft_version: "1.21.4",
  mineflayer_version: "4.39.0",
  minecraft_data_version: "3.117.0",
  geometry_revision: "prismarine-block-1.23.0-registry-state-shapes",
  physics_revision: "prismarine-physics-1.11.1",
  observation_radius_blocks: 32,
  navigation_geometry_radius_blocks: 8,
  refresh_interval_ms: 200,
  block_discovery_directions: 354,
  discovery_elevation_min_degrees: -75,
  discovery_elevation_max_degrees: 75,
  discovery_elevation_step_degrees: 15,
  discovery_azimuth_start_degrees: 0,
  discovery_azimuth_step_degrees: 11.25,
  discovery_poles_order: "up,down",
  block_direction_slots_per_batch: 128,
  entity_registry_slots_per_batch: 64,
  raw_cell_visits_per_batch: 65536,
  block_cell_visits_per_batch: 57344,
  entity_cell_visits_per_batch: 8192,
  target_points_per_candidate: 6,
  target_face_order: "-X,+X,-Y,+Y,-Z,+Z",
  target_face_inset_blocks: 1 / 1024,
  entity_inset_max_extent_fraction: 1 / 4,
  cell_visits_per_ray: 128,
  sampling_elapsed_guard_ms: 10,
  current_max_age_ms: 1000,
  authorized_index_records: 4096,
  search_default_records: 32,
  search_max_records: 128,
  read_default_records: 32,
  read_max_records: 128,
  output_records: 256,
  output_record_bytes: 2048,
  output_bytes: 65536,
  output_envelope_bytes: 4096,
  sound_records_per_batch: 8,
  sound_expiry_ms: 1000,
  sound_near_upper_exclusive_blocks: 8,
  sound_mid_upper_exclusive_blocks: 16,
  sound_far_upper_inclusive_blocks: 32,
  sound_here_horizontal_exclusive_blocks: 1,
  sound_direction_order: "here,N,NE,E,SE,S,SW,W,NW",
  sound_category_order: "movement,interaction,combat,creature,weather",
  sound_grouping: "135-presence-groups-latest-delivery-only-no-multiplicity",
  sound_whitelist: {
    "block.grass.step": "movement",
    "entity.player.swim": "movement",
    "block.stone.break": "interaction",
    "block.stone.place": "interaction",
    "block.wood.break": "interaction",
    "block.wood.place": "interaction",
    "entity.player.hurt": "combat",
    "entity.generic.hurt": "combat",
    "entity.generic.death": "combat",
    "entity.arrow.shoot": "combat",
    "entity.generic.explode": "combat",
    "entity.zombie.ambient": "creature",
    "entity.skeleton.ambient": "creature",
    "entity.lightning_bolt.thunder": "weather",
  },
  navigation_distinct_cells: 4913,
  navigation_cell_visits: 8192,
  navigation_expanded_nodes: 2048,
  navigation_queued_nodes: 4096,
  navigation_replan_min_interval_ms: 100,
  navigation_elapsed_guard_ms: 5,
  navigation_integer_offset_min: -8,
  navigation_integer_offset_max: 8,
  navigation_step_height_blocks: 1,
  discovery_algorithm: "world-aligned-elevation-azimuth-cycle-then-up-down",
  ray_algorithm: "closed-cube-supercover-entry-time-xyz-order",
  target_algorithm: "six-inset-faces-then-distinct-sorted-shape-centers",
  empty_geometry_algorithm: "confirmed-registry-known-empty-only-unit-voxel",
  entity_scan_algorithm: "maintained-ascending-protocol-id-resumable-wrap",
  sampling_source_order:
    "blocks-first-on-even-batches-entities-first-on-odd-batches",
  dependency_invalidation:
    "read-cell-revisions-entity-motion-eye-position-age-global-chunk-revisions",
  navigation_algorithm: "geometry-only-local-astar-f-g-xyz-ties-known-goal",
  output_algorithm: "authorized-current-blocks-entities-then-last-seen-memory",
  sound_algorithm: "delivered-whitelist-grouped-category-compass-distance",
  unknown_player_poses: "ineligible-until-supported-standing-or-crouching",
} as const satisfies Json;

// The preset contains finite JSON primitives and ASCII keys; sorting recursively is RFC 8785 canonical here.
function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`;
}
export const OBSERVATION_PROFILE_FINGERPRINT = createHash("sha256")
  .update(canonical(OBSERVATION_PROFILE))
  .digest("hex");
