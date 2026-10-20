import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import type {
  BridgeConnection,
  BridgeNotice,
  GameAction,
  GameActionResult,
  GameBridge,
  GameState,
  Json,
  Observation,
} from "../shared/contracts.ts";
import { gameActionSchema } from "../shared/validation.ts";
const MAX_LINE = 131072;
const vector = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();
const player = z
  .object({
    position: vector,
    yaw: z.number().finite(),
    pitch: z.number().finite(),
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
const stateSchema: z.ZodType<GameState> = z
  .object({
    status: z.enum(["disconnected", "connecting", "connected", "error"]),
    username: z.string().max(32),
    version: z.string().max(32),
    world_id: z.string().max(160).nullable(),
    epoch: z.number().int().nonnegative(),
    viewer_ready: z.boolean(),
    viewer_url: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:\d+\/viewer\/$/)
      .nullable(),
    last_observation_at: z.string().max(40).nullable(),
    player: player.nullable(),
    error: z.string().max(500).nullable(),
  })
  .strict();
const observed = z
  .object({
    id: z.string().max(160),
    name: z.string().max(100),
    position: vector,
    observed_at: z.string().max(40),
    current: z.boolean(),
  })
  .strict();
const observationSchema: z.ZodType<Observation> = z
  .object({
    schema_version: z.literal(1),
    world_id: z.string().max(160),
    epoch: z.number().int().nonnegative(),
    observation_seq: z.number().int().nonnegative(),
    captured_at: z.string().max(40),
    profile_id: z.literal("player-observable-structured"),
    preset_id: z.literal("minecraft-observable-initial-r1"),
    player,
    blocks: z.array(observed).max(256),
    entities: z.array(observed).max(256),
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
      o.player.inventory.length +
        o.blocks.length +
        o.entities.length +
        o.sounds.length <=
      256,
  );
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
const actionResult: z.ZodType<GameActionResult> = z
  .object({
    status: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
    summary: z.string().max(1000),
    evidence: json,
    requires_reconnect: z.boolean().optional(),
  })
  .strict();
const envelope = z.union([
  z
    .object({
      id: z.number().int().positive(),
      ok: z.literal(true),
      data: z.unknown(),
    })
    .strict(),
  z
    .object({
      id: z.number().int().positive(),
      ok: z.literal(false),
      error: z.string().max(500),
    })
    .strict(),
  z
    .object({
      notice: z
        .object({
          type: z.enum(["state", "observation", "game_event", "viewer"]),
          data: z.unknown(),
        })
        .strict(),
    })
    .strict(),
]);
interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
export class GameBridgeClient implements GameBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exit: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private listeners = new Set<(notice: BridgeNotice) => void>();
  private closing: Promise<void> | null = null;
  private state: GameState = {
    status: "disconnected",
    username: "GameHarness",
    version: "1.21.4",
    world_id: null,
    epoch: 0,
    viewer_ready: false,
    viewer_url: null,
    last_observation_at: null,
    player: null,
    error: null,
  };
  constructor(private projectRoot = process.cwd()) {}
  snapshot() {
    return this.state;
  }
  subscribe(listener: (notice: BridgeNotice) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(notice: BridgeNotice) {
    for (const listener of this.listeners) {
      try {
        listener(notice);
      } catch {
        /* One consumer must not break the bridge transport. */
      }
    }
  }
  private start() {
    if (this.child) return;
    if (this.closing) throw new Error("The bridge is still closing.");
    const child = spawn(
      "node",
      [resolve(this.projectRoot, "dist/bridge/index.mjs")],
      {
        cwd: this.projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: resolve(this.projectRoot, "local/runtime/bridge"),
          NODE_ENV: "production",
        },
      },
    );
    this.child = child;
    this.buffer = Buffer.alloc(0);
    const exited = Promise.withResolvers<void>();
    this.exit = exited.promise;
    child.once("close", () => {
      if (this.child === child) {
        this.child = null;
        this.buffer = Buffer.alloc(0);
        const error = new Error("The Minecraft bridge connection closed.");
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(error);
        }
        this.pending.clear();
        this.state = {
          ...this.state,
          status: "disconnected",
          viewer_ready: false,
          viewer_url: null,
          player: null,
          error:
            this.state.status === "disconnected"
              ? this.state.error
              : "The Minecraft bridge connection closed.",
        };
        this.emit({ type: "state", data: this.state });
      }
      exited.resolve();
    });
    child.once("error", () => {
      void this.terminate();
    });
    // Third-party diagnostics are intentionally not surfaced to models, events, or operators.
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const end = this.buffer.indexOf(10);
        if (end < 0) break;
        if (end > MAX_LINE) {
          void this.terminate();
          return;
        }
        const line = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 1);
        if (!this.receive(line)) {
          void this.terminate();
          return;
        }
      }
      if (this.buffer.length > MAX_LINE) void this.terminate();
    });
  }
  private receive(line: string) {
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      return false;
    }
    const parsed = envelope.safeParse(input);
    if (!parsed.success) return false;
    const message = parsed.data;
    if ("notice" in message) {
      const notice = message.notice;
      if (notice.type === "state") {
        const data = stateSchema.safeParse(notice.data);
        if (!data.success) return false;
        this.state = data.data;
        this.emit({ type: "state", data: this.state });
      } else if (notice.type === "observation") {
        const data = observationSchema.safeParse(notice.data);
        if (
          !data.success ||
          Buffer.byteLength(JSON.stringify(data.data)) > 65536
        )
          return false;
        this.state = {
          ...this.state,
          player: data.data.player,
          last_observation_at: data.data.captured_at,
        };
        this.emit({ type: "observation", data: data.data });
      } else if (notice.type === "game_event") {
        const data = z
          .object({
            type: z.string().max(80),
            summary: z.string().max(1000),
            kind: z.string().max(80).optional(),
            status: z.string().max(80).optional(),
          })
          .strict()
          .safeParse(notice.data);
        if (!data.success) return false;
        this.emit({ type: "game_event", data: data.data });
      }
      return true;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    message.ok
      ? pending.resolve(message.data)
      : pending.reject(new Error(message.error));
    return true;
  }
  private request(
    method: string,
    params?: unknown,
    timeout = 10000,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed)
      return Promise.reject(new Error("The Minecraft bridge is not running."));
    if (this.pending.size >= 32)
      return Promise.reject(
        new Error("The Minecraft bridge request limit was reached."),
      );
    const id = ++this.sequence;
    const frame =
      JSON.stringify({
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }) + "\n";
    if (Buffer.byteLength(frame) > MAX_LINE)
      return Promise.reject(
        new Error("The Minecraft bridge request exceeds its bound."),
      );
    const response = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      void this.terminate();
    }, timeout);
    this.pending.set(id, {
      resolve: response.resolve,
      reject: response.reject,
      timer,
    });
    child.stdin.write(frame, (error) => {
      if (error) void this.terminate();
    });
    return response.promise;
  }
  async connect(config: BridgeConnection) {
    if (this.closing) await this.closing;
    this.start();
    try {
      this.state = stateSchema.parse(
        await this.request("connect", config, 45000),
      );
    } catch {
      await this.terminate();
      throw new Error(
        "Could not join the managed Minecraft server or start the viewer.",
      );
    }
  }
  async observe() {
    return observationSchema.parse(await this.request("observe"));
  }
  async recipes(item: string) {
    return json.parse(await this.request("recipes", { item }));
  }
  async execute(
    action: GameAction,
    signal: AbortSignal,
  ): Promise<GameActionResult> {
    const parsed = gameActionSchema.safeParse(action);
    if (!parsed.success)
      return {
        status: "failed",
        summary: "The action does not match the game-action schema.",
        evidence: { effect_confirmed: false, neutralized_effect: false },
      };
    if (signal.aborted)
      return {
        status: "cancelled",
        summary: "The action was cancelled before dispatch.",
        evidence: { effect_confirmed: false, neutralized_effect: false },
      };
    let cancellation: Promise<void> | null = null;
    const onAbort = () => {
      cancellation = this.cancel("Action aborted.");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const data = actionResult.parse(
        await this.request("execute", parsed.data, 45000),
      );
      if (cancellation) await cancellation;
      return data;
    } catch {
      await this.terminate();
      return {
        status: "unknown",
        summary:
          "The action result is uncertain; the game bridge was terminated.",
        evidence: { effect_confirmed: false, neutralized_effect: false },
        requires_reconnect: true,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  async cancel(reason: string) {
    if (!this.child) return;
    try {
      const data = z
        .object({ neutralized: z.literal(true), state: stateSchema })
        .strict()
        .parse(
          await this.request("cancel", { reason: reason.slice(0, 200) }, 5000),
        );
      this.state = data.state;
    } catch {
      await this.terminate();
    }
  }
  async disconnect() {
    if (!this.child) return;
    try {
      this.state = stateSchema.parse(
        await this.request("disconnect", undefined, 5000),
      );
    } catch {
      // A lost reply is not evidence of neutralization. The owned process's
      // confirmed exit below is the stronger emitter-fencing boundary.
    } finally {
      await this.terminate();
    }
  }
  private async terminate() {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return;
    const exit = this.exit;
    this.closing = (async () => {
      child.kill("SIGKILL");
      await exit;
    })();
    try {
      await this.closing;
    } finally {
      this.closing = null;
    }
  }
  async close() {
    await this.disconnect();
    this.listeners.clear();
  }
}
