import { Buffer } from "node:buffer";
import { z } from "zod";
import type {
  GameAction,
  GameActionResult,
  Json,
  MotorProfile,
  NavigationGaze,
  Observation,
  PlayerLife,
  PlayerLifeEvent,
  PolicyDecision,
  PolicySpec,
} from "./contracts.ts";
import type {
  GameAPI,
  SkillCapabilityRequest,
  SkillLimits,
  SkillResult,
  SkillStartRequest,
  WorkingProgramMode,
} from "./programs.ts";
import { DEFAULT_SKILL_LIMITS, MAX_SKILL_LIMITS, SKILL_API_VERSION } from "./programs.ts";
import type { LookaheadConfig, LookaheadRequest } from "./planning.ts";

export const sessionIdSchema = z.string().min(1).max(160);
export const lifeIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const motorProfileSchema = z.enum(["precise", "balanced", "fast"]) satisfies z.ZodType<MotorProfile>;
export const workingProgramModeSchema = z.enum(["continue", "fresh"]) satisfies z.ZodType<WorkingProgramMode>;
export const playerLifeSchema: z.ZodType<PlayerLife> = z
  .object({
    life_id: lifeIdSchema,
    status: z.enum(["loading", "alive", "dead", "respawning"]),
    can_respawn: z.boolean(),
    death: z
      .object({
        death_id: z.string().min(1).max(160),
        at: z.string().min(1).max(40),
        message: z.string().max(1000).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((life) => !life.can_respawn || life.status === "dead", {
    message: "Only a dead life can be ready for explicit respawn",
  })
  .refine((life) => life.status !== "alive" || life.death === null, {
    message: "An alive life cannot retain death data",
  })
  .describe(
    "Native-authoritative player incarnation within one game session. Loading is not alive; death retains the deceased life_id. Death data stays null when no death episode was observed, including initial saved-dead worlds; never invent a death time, cause or episode. Only confirmed new-life readiness increments life_id. Respawn is explicit and can_respawn is true only when the vanilla dead screen is ready.",
  );

export const playerLifeEventSchema: z.ZodType<PlayerLifeEvent> = z
  .object({
    type: z.enum(["death", "life"]),
    session_id: sessionIdSchema,
    world_id: z.string().min(1).max(160),
    epoch: z.number().int().nonnegative(),
    life: playerLifeSchema,
    summary: z.string().max(1000),
    neutralized: z.literal(true),
  })
  .strict();

const vector = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();
const yawUnits =
  "Absolute world yaw in radians, not degrees or a relative turn: 0 faces +Z, +pi/2 faces -X, -pi/2 faces +X, and +/-pi faces -Z.";
const pitchUnits =
  "Absolute pitch in radians, not degrees or a relative turn: 0 is level, positive looks up, negative looks down; +/-pi/2 is straight up/down.";
const player = z
  .object({
    position: vector.describe(
      "Player feet/runtime origin in continuous world block coordinates, not eye position or an integer block-cell index. Y increases upward.",
    ),
    yaw: z.number().finite().describe(`${yawUnits} Observed yaw is wrapped to [-pi, pi).`),
    pitch: z.number().finite().describe(pitchUnits),
    health: z.number().finite(),
    food: z.number().finite(),
    on_ground: z.boolean(),
    in_water: z.boolean(),
    inventory: z
      .array(
        z
          .object({
            name: z.string().max(100),
            display_name: z.string().max(200),
            count: z.number().int().nonnegative(),
            slot: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
const observed = z
  .object({
    id: z.string().max(160),
    name: z.string().max(100),
    position: vector.describe(
      "Block-cell center in world block coordinates: integer cell (x, y, z) is reported as (x + 0.5, y + 0.5, z + 0.5), not its integer origin. Math.floor of each component recovers the cell index, including negative coordinates.",
    ),
    observed_at: z.string().max(40),
    current: z.boolean(),
  })
  .strict();
const observedEntity = observed
  .extend({
    position: vector.describe(
      "Entity runtime origin in continuous world block coordinates (native Entity.getPos()), not its bounding-box center or an integer block-cell index. Y increases upward.",
    ),
    item_name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^(?:[a-z0-9_.-]+:)?[a-z][a-z0-9_./-]*$/)
      .optional(),
  })
  .strict()
  .refine(
    (entity) =>
      entity.item_name === undefined ||
      entity.name === "item" ||
      entity.name === "minecraft:item",
    { message: "Only visible ItemEntity observations can carry item_name" },
  );
export const observationSchema: z.ZodType<Observation> = z
  .object({
    schema_version: z.literal(2),
    world_id: z.string().max(160),
    epoch: z.number().int().nonnegative(),
    session_id: sessionIdSchema,
    life: playerLifeSchema,
    observation_seq: z.number().int().nonnegative(),
    captured_at: z.string().max(40),
    profile_id: z.literal("player-observable-structured"),
    preset_id: z.literal("minecraft-observable-initial-r2"),
    player,
    blocks: z.array(observed).max(200),
    entities: z.array(observedEntity).max(32),
    sounds: z
      .array(
        z
          .object({
            category: z.enum([
              "movement",
              "interaction",
              "combat",
              "creature",
              "weather",
            ]),
            direction: z.enum([
              "here",
              "N",
              "NE",
              "E",
              "SE",
              "S",
              "SW",
              "W",
              "NW",
            ]),
            distance: z.enum(["near", "mid", "far"]),
            observed_at: z.string().max(40),
          })
          .strict(),
      )
      .max(8),
    coverage: z
      .object({
        partial: z.literal(true),
        max_age_ms: z.number().int().min(0).max(1000),
      })
      .strict(),
  })
  .strict()
  .refine(
    (o) =>
      o.blocks.length +
        o.entities.length +
        o.sounds.length +
        o.player.inventory.length <=
      256,
  )
  .describe(
    "Schema 2 player-observable DTO for the current authenticated session and native-authoritative life, including dead/loading/respawning states. Inventory entries use name, display_name, count and slot. Only already-visible nonempty ItemEntity stacks may expose optional registry item_name; no exact count, NBT or hidden stack data. Visibility, freshness and collection bounds are unchanged. Combined blocks, entities, sounds and inventory entries must not exceed 256.",
  );

export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);

export const gameActionResultSchema: z.ZodType<GameActionResult> = z
  .object({
    status: z.enum(["succeeded", "failed", "cancelled", "unknown"]).describe(
      "Mechanical outcome of the requested action, not task completion. For dig, succeeded means the matching target block removal was confirmed by the server; it does not mean a dropped item was picked up or inventory increased. A failure before world-effect emission means this action emitted no world effect, though preparatory camera rotation may have occurred; do not infer this from failed status alone when world effects were already emitted. Unknown means prior effects remain uncertain, even after inputs are confirmed neutralized; never treat it as failure-with-no-effect or replay permission.",
    ),
    summary: z.string().max(1000).describe(
      "Human-readable outcome summary, not a machine-readable success discriminator. Use status and documented structured evidence fields, not substring searches of this text or serialized JSON.",
    ),
    evidence: jsonSchema.describe(
      "Action-specific structured evidence, not a serialized-text protocol. Native world_effect_emitted:boolean records world-effect/input emission separately from camera_changed:boolean; preparatory camera movement alone does not establish a world effect. Native confirmed dig removal uses block_removed:true and source:'server_block_update', attributed to target_id/target_name/target_position when present. Block removal proves neither item pickup nor inventory gain. inventory_before and inventory_after alone do not establish a confirmed inventory receipt; inventory_receipt_confirmed:true identifies receipted inventory_after counts. Await a fresh game.observe() for current inventory and task state; do not guess outcomes with JSON.stringify(evidence).includes(...).",
    ),
    requires_reconnect: z.boolean().optional().describe(
      "Transport/control recovery requirement, separate from mechanical outcome uncertainty. Confirmed input neutralization does not turn an unknown past effect into a known result.",
    ),
  })
  .strict()
  .describe(
    "Result returned by awaited game.action(...) or game.respawn(). Inspect status and action-specific structured evidence directly. In particular, successful dig is server-confirmed target block removal, not item collection or goal completion; obtain a fresh authorized observation for inventory and task decisions.",
  );

export const skillRefSchema = z
  .object({
    skill_id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
    version: z.number().int().positive(),
  })
  .strict();

export const namedProgramRefSchema = z.object({
  name: z.string().trim().min(1).max(80),
  version: z.number().int().positive().optional(),
}).strict();

export const skillLimitsSchema = z
  .object({
    duration_ms: z.number().int().min(100).max(MAX_SKILL_LIMITS.duration_ms),
    max_actions: z.number().int().min(1).max(MAX_SKILL_LIMITS.max_actions),
    max_calls: z.number().int().min(1).max(MAX_SKILL_LIMITS.max_calls),
    max_depth: z.number().int().min(1).max(MAX_SKILL_LIMITS.max_depth),
  })
  .strict() satisfies z.ZodType<SkillLimits>;

export const lookaheadConfigSchema = z
  .object({
    after_ms: z.number().int().min(0).max(600000),
    activation: z.enum(["manual", "on_predecessor_success"]).default("manual").describe(
      "Main root-start authorization for manual activation or one automatic continuation after the exact predecessor succeeds and drains. Speculative staging cannot mint or expand this permit.",
    ),
    reason: z.string().min(1).max(300).refine((reason) => reason.trim().length > 0, {
      message: "Lookahead reason must not be blank",
    }),
    budget: z
      .object({
        calls: z.number().int().min(1).max(4),
        tools: z.number().int().min(1).max(16),
        duration_ms: z.number().int().min(1000).max(30000).describe(
          "Total flight/draft lifetime in milliseconds starting after after_ms; includes model/tool work, waiting for predecessor, fresh observation, optional game guard and activation admission. All must fit before this same deadline; no separate staged lifetime.",
        ),
      })
      .strict(),
  })
  .strict()
  .describe(
    "Explicit bounded one-shot speculative planning opt-in for this skill root. Omission creates no request. The host binds the newly admitted root identity; matching start retries do not create another lookahead. Activation defaults to manual. Automatic continuation requires this Main root-start authorization plus fresh observation, host session/life/task/source checks and any optional game guard.",
  ) satisfies z.ZodType<LookaheadConfig>;

export const lookaheadRequestSchema = lookaheadConfigSchema
  .extend({ root_execution_id: z.uuid() })
  .strict() satisfies z.ZodType<LookaheadRequest>;

/** New work must name a real session and life; historical null lineage is not admissible. */
export const skillStartRequestSchema: z.ZodType<SkillStartRequest> = skillRefSchema
  .extend({
    start_key: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
    epoch: z.number().int().nonnegative(),
    session_id: sessionIdSchema,
    life_id: lifeIdSchema,
    args: jsonSchema,
    limits: skillLimitsSchema.default({ ...DEFAULT_SKILL_LIMITS }),
    lookahead: lookaheadConfigSchema.optional(),
  })
  .strict();

export const skillResultSchema: z.ZodType<SkillResult> = z
  .object({
    status: z.enum(["completed", "blocked", "failed"]),
    summary: z.string().min(1).max(2000),
    result: jsonSchema,
  })
  .strict();

const target = z.string().min(1).max(160);
const item = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const angle = z
  .number()
  .finite()
  .min(-2 * Math.PI)
  .max(2 * Math.PI)
  .describe(yawUnits);
const pitch = z
  .number()
  .finite()
  .min(-Math.PI / 2)
  .max(Math.PI / 2)
  .describe(pitchUnits);
const look = z.object({ yaw: angle, pitch }).strict();
export const navigationGazeSchema: z.ZodType<NavigationGaze> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("navigation") }).strict(),
    z.object({ kind: z.literal("target"), target_id: target }).strict(),
    z.object({ kind: z.literal("free"), yaw: angle, pitch }).strict(),
  ]);
const controls = z
  .object({
    forward: z.boolean().optional(),
    back: z.boolean().optional(),
    left: z.boolean().optional(),
    right: z.boolean().optional(),
    jump: z.boolean().optional(),
    sprint: z.boolean().optional(),
    sneak: z.boolean().optional(),
  })
  .strict();

export const gameActionSchema: z.ZodType<GameAction> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("move"),
        controls,
        duration_ms: z.number().int().min(50).max(2000),
        look: look.optional(),
        interaction: z
          .object({
            kind: z.enum(["attack", "use"]),
            target_id: target.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z.object({ kind: z.literal("look"), yaw: angle, pitch }).strict(),
    z.object({ kind: z.literal("dig"), target_id: target }).strict(),
    z
      .object({
        kind: z.literal("place"),
        target_id: target,
        face: z.enum(["up", "down", "north", "south", "east", "west"]),
        item,
      })
      .strict(),
    z
      .object({
        kind: z.literal("craft"),
        item,
        executions: z.number().int().min(1).max(16),
        table_id: target.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("equip"),
        item,
        destination: z.enum([
          "hand",
          "off-hand",
          "head",
          "torso",
          "legs",
          "feet",
        ]),
      })
      .strict(),
    z.object({ kind: z.literal("interact"), target_id: target }).strict(),
    z.object({ kind: z.literal("attack"), target_id: target }).strict(),
    z.object({ kind: z.literal("respawn") }).strict(),
    z
      .object({
        kind: z.literal("navigate"),
        target_id: target,
        range: z.number().finite().min(0.5).max(4),
        duration_ms: z.number().int().min(100).max(10000),
        gaze: navigationGazeSchema.optional(),
      })
      .strict(),
  ],
);

export const skillCapabilitySchema: z.ZodType<SkillCapabilityRequest> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("observe") }).strict(),
    z.object({ kind: z.literal("respawn") }).strict(),
    z.object({ kind: z.literal("action"), action: gameActionSchema }).strict(),
    z
      .object({
        kind: z.literal("recipes"),
        item: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
      })
      .strict(),
    z
      .object({
        kind: z.literal("call"),
        skill: namedProgramRefSchema,
        args: jsonSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("progress"),
        summary: z.string().min(1).max(1000),
        details: jsonSchema,
      })
      .strict(),
  ]);

function createGameAPIReference() {
  return {
    binding: "game",
    runtime_version: SKILL_API_VERSION,
    asynchronous: true,
    concurrent_calls: false,
    methods: {
      observe: { parameters: [], result: "Observation" },
      action: {
        parameters: [{ name: "action", type: "GameAction" }],
        result: "GameActionResult",
      },
      respawn: { parameters: [], result: "GameActionResult" },
      recipes: {
        parameters: [{ name: "item", type: "string" }],
        result: "Json",
      },
      call: {
        parameters: [
          { name: "skill", type: "NamedProgramRef" },
          { name: "args", type: "Json" },
        ],
        result: "SkillResult",
      },
      progress: {
        parameters: [
          { name: "summary", type: "string" },
          { name: "details", type: "Json" },
        ],
        result: "null",
      },
    } satisfies Record<
      keyof GameAPI,
      { parameters: { name: string; type: string }[]; result: string }
    >,
    validation: "Source validation checks JavaScript syntax and compactness, not DTO field access or JavaScript types. Host runtime validators enforce request and result contracts. Methods may reject.",
    lifecycle: "Game sessions survive death and ordinary run completion/Pause/Stop. Ordinary effects require an alive current life; observe/recipes remain read-only while dead/loading/respawning. respawn() is an explicit model-selected vanilla request through the exclusive action arbiter, never an automatic retry. A successful respawn waits for authoritative new-life readiness; old-life handles and proposals remain fenced. Unknown outcomes remain unknown even after confirmed neutralization. Post-goal reviewing is effect-free.",
    navigation: "navigate.gaze defaults to navigation using local route geometry. target uses an authorized current-life target; free is an explicit orientation. Existing look and move.look remain explicit free orientation. range accepts 0.5 through 4 blocks; navigation never implies an automatic pickup policy.",
    progress: "game.progress statements are model-authored intent, not objective evidence or proof of success.",
    schemas: {
      Observation: z.toJSONSchema(observationSchema),
      PlayerLife: z.toJSONSchema(playerLifeSchema),
      GameAction: z.toJSONSchema(gameActionSchema),
      GameActionResult: z.toJSONSchema(gameActionResultSchema),
      NamedProgramRef: z.toJSONSchema(namedProgramRefSchema),
      SkillResult: z.toJSONSchema(skillResultSchema),
      Json: z.toJSONSchema(jsonSchema),
    },
  };
}

let gameAPIReference: ReturnType<typeof createGameAPIReference> | undefined;

/** Demand-driven public reference generated from the host validators once. */
export function getGameAPIReference() {
  return (gameAPIReference ??= createGameAPIReference());
}

export const policyDecisionSchema: z.ZodType<PolicyDecision> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("continue"),
        reason: z.string().max(500).optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal("replan"), reason: z.string().min(1).max(500) })
      .strict(),
    z
      .object({
        kind: z.literal("interrupt"),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    z
      .object({
        kind: z.literal("replace"),
        action: gameActionSchema,
        reason: z.string().min(1).max(500),
      })
      .strict(),
  ]);

export const policySpecSchema: z.ZodType<PolicySpec> = z
  .object({
    backend: z.enum(["javascript", "jev"]),
    choices: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
            decision: policyDecisionSchema,
          })
          .strict(),
      )
      .min(2)
      .max(16)
      .nullable(),
    name: z.string().min(1).max(80),
    source: z
      .string()
      .min(1)
      .max(32768)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 32768,
        "Policy source exceeds 32 KiB",
      ),
    card: z
      .object({
        purpose: z.string().min(1).max(1000),
        applicability: z.string().min(1).max(1000),
        method: z.string().min(1).max(2000),
        reason: z.string().min(1).max(1000),
        limitations: z.string().min(1).max(1000),
      })
      .strict(),
    priority: z.number().int().min(0).max(100),
    interval_ms: z.number().int().min(200).max(5000),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (
      (spec.backend === "javascript" && spec.choices !== null) ||
      (spec.backend === "jev" && spec.choices === null)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "JavaScript requires null choices; Jev requires finite choices",
      });
    if (
      spec.choices &&
      new Set(spec.choices.map((choice) => choice.id)).size !==
        spec.choices.length
    )
      ctx.addIssue({ code: "custom", message: "Choice IDs must be unique" });
  });

export const goalSchema = z.enum([
  "break_log",
  "collect_wood",
  "craft_crafting_table",
  "craft_stone_pickaxe",
  "custom",
]);
