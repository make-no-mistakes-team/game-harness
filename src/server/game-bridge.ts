import { createServer, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
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
  MotorProfile,
} from "../shared/contracts.ts";
import {
  gameActionResultSchema,
  gameActionSchema,
  jsonSchema,
  observationSchema,
  playerLifeSchema,
  motorProfileSchema,
} from "../shared/validation.ts";
import {
  MinecraftClient,
  type NativeOptions,
  type NativeProcess,
} from "./minecraft-client.ts";

const response = z.union([
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
          type: z.literal("life"),
          world_id: z.string().max(160),
          epoch: z.number().int().nonnegative(),
          session_id: z.string().max(160),
          generation: z.number().int().positive(),
          life: playerLifeSchema,
          neutralized: z.literal(true),
        })
        .strict(),
    })
    .strict(),
]);
const MAX_FRAME = 32 + 1920 * 1080 * 4;
/** A strict bounded native framing decoder; malformed framing is terminal, never resynchronized. */
export class NativeFrameDecoder {
  private buffer = Buffer.allocUnsafe(MAX_FRAME);
  private used = 0;
  private expected = 32;
  private sequence: number | null = null;
  constructor(private readonly receive: (frame: Buffer) => void) {}
  push(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(this.expected - this.used, chunk.length - offset);
      chunk.copy(this.buffer, this.used, offset, offset + n);
      this.used += n;
      offset += n;
      if (this.used === 32 && this.expected === 32) {
        const w = this.buffer.readUInt32LE(4),
          h = this.buffer.readUInt32LE(8),
          bytes = this.buffer.readUInt32LE(12),
          seq = this.buffer.readUInt32LE(16),
          flags = this.buffer.readUInt32LE(20),
          captured = this.buffer.readDoubleLE(24);
        if (
          this.buffer.readUInt32LE(0) !== 0x47485631 ||
          w < 1 ||
          h < 1 ||
          w > 1920 ||
          h > 1080 ||
          bytes !== w * h * 4 ||
          flags > 1 ||
          !Number.isFinite(captured) ||
          Math.abs(Date.now() - captured) > 5000 ||
          (this.sequence !== null &&
            ((seq - this.sequence) >>> 0 > 0x7fffffff || seq === this.sequence))
        )
          throw new Error("Invalid native video framing.");
        this.expected = 32 + bytes;
        this.sequence = seq;
      }
      if (this.used === this.expected && this.expected > 32) {
        const frame = Buffer.from(this.buffer.subarray(0, this.expected));
        this.used = 0;
        this.expected = 32;
        this.receive(frame);
      }
    }
  }
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
export class GameBridgeClient implements GameBridge {
  private readonly launcher: MinecraftClient;
  private owned: NativeProcess | null = null;
  private control: Socket | null = null;
  private videoSocket: Socket | null = null;
  private servers: Server[] = [];
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private generation = 1;
  private listeners = new Set<(notice: BridgeNotice) => void>();
  private frameListeners = new Set<(frame: Uint8Array) => void>();
  private frame: Buffer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private closing: Promise<void> | null = null;
  private neutralizing: Promise<void> | null = null;
  private frameStarted = 0;
  private nativeMetrics: Json = null;
  private connectionAbort: AbortController | null = null;
  private connecting = false;
  private launching: Promise<NativeProcess> | null = null;
  private readonly onTiming: NativeOptions["onTiming"];
  private state: GameState = {
    status: "disconnected",
    username: "",
    version: "1.21.4",
    world_id: null,
    epoch: 0,
    session_id: null,
    life: null,
    motor_profile: "balanced",
    video: {
      status: "idle",
      width: 0,
      height: 0,
      fps: null,
      frames: 0,
      last_frame_at: null,
      error: null,
    },
    last_observation_at: null,
    player: null,
    error: null,
  };
  constructor(projectRoot = process.cwd(), options: NativeOptions = {}) {
    this.launcher = new MinecraftClient(projectRoot, options);
    this.onTiming = options.onTiming;
  }
  performanceMetrics(): Json {
    return { native: this.nativeMetrics, video: { ...this.state.video } };
  }
  snapshot() {
    return { ...this.state, video: { ...this.state.video } };
  }
  subscribe(listener: (notice: BridgeNotice) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeFrames(listener: (frame: Uint8Array) => void) {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }
  latestFrame() {
    return this.frame;
  }
  private emit(notice: BridgeNotice) {
    for (const listener of this.listeners) {
      try {
        listener(notice);
      } catch {}
    }
  }
  private async listener(kind: "control" | "video") {
    const server = createServer((socket) => this.accept(socket, kind));
    server.maxConnections = 2;
    this.servers.push(server);
    const ready = Promise.withResolvers<number>();
    server.once("error", () =>
      ready.reject(new Error("Native loopback listener failed.")),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address !== "string") ready.resolve(address.port);
      else ready.reject(new Error("Native listener has no port."));
    });
    return ready.promise;
  }
  private accept(socket: Socket, kind: "control" | "video") {
    socket.setNoDelay(true);
    socket.setTimeout(10000, () => socket.destroy());
    let authorized = false;
    let text = Buffer.alloc(0);
    const decoder =
      kind === "video"
        ? new NativeFrameDecoder((frame) => this.onFrame(frame))
        : null;
    socket.on("data", (chunk: Buffer) => {
      if (
        authorized &&
        socket !== (kind === "control" ? this.control : this.videoSocket)
      )
        return;
      try {
        if (!authorized) {
          text = Buffer.concat([text, chunk]);
          const end = text.indexOf(10);
          if (end < 0) {
            if (text.length > 1024) socket.destroy();
            return;
          }
          if (end > 1024) throw new Error("Oversized native handshake");
          const hello = JSON.parse(text.subarray(0, end).toString("utf8"));
          const session = this.owned?.session;
          const secret = Buffer.from(String(hello.secret)),
            expected = Buffer.from(session?.secret ?? "");
          if (
            !session ||
            secret.length !== expected.length ||
            !timingSafeEqual(secret, expected) ||
            hello.protocol !== 2 ||
            hello.world_id !== session.world_id ||
            hello.epoch !== session.epoch ||
            hello.session_id !== session.session_id ||
            (kind === "control" ? this.control : this.videoSocket)
          )
            throw new Error("Native handshake rejected");
          authorized = true;
          socket.setTimeout(kind === "control" ? 15000 : 120000);
          if (kind === "control") this.control = socket;
          else this.videoSocket = socket;
          chunk = text.subarray(end + 1);
          text = Buffer.alloc(0);
        }
        if (decoder) {
          decoder.push(chunk);
          return;
        }
        text = Buffer.concat([text, chunk]);
        if (text.length > 131072)
          throw new Error("Native response exceeded bound");
        let end: number;
        while ((end = text.indexOf(10)) >= 0) {
          const message = response.parse(
            JSON.parse(text.subarray(0, end).toString("utf8")),
          );
          text = text.subarray(end + 1);
          if ("notice" in message) {
            const session = this.owned?.session;
            if (
              !session ||
              message.notice.session_id !== session.session_id ||
              message.notice.world_id !== this.state.world_id ||
              message.notice.epoch !== this.state.epoch
            )
              continue;
            const previous = this.state.life;
            if (previous && message.notice.life.life_id < previous.life_id) continue;
            this.generation = Math.max(this.generation, message.notice.generation);
            this.state = {
              ...this.state,
              session_id: message.notice.session_id,
              life: message.notice.life,
              error: null,
              player: message.notice.life.status === "dead" && this.state.player
                ? { ...this.state.player, health: 0 }
                : this.state.player,
            };
            const died = message.notice.life.status === "dead" &&
              (!previous || previous.status === "alive" || previous.status === "loading" ||
                previous.life_id !== message.notice.life.life_id);
            this.emit({
              type: "game_event",
              data: {
                type: died ? "death" : "life",
                summary: died ? "Player life ended; native inputs are neutralized and the connected client remains available." : "Authoritative player life state changed.",
                world_id: this.state.world_id,
                epoch: this.state.epoch,
                session_id: message.notice.session_id,
                life: message.notice.life,
                neutralized: true,
              },
            });
            this.emit({ type: "state", data: this.snapshot() });
            continue;
          }
          const pending = this.pending.get(message.id);
          if (!pending) throw new Error("Uncorrelated native response");
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          message.ok
            ? pending.resolve(message.data)
            : pending.reject(new Error(message.error));
        }
      } catch {
        socket.destroy();
        if (authorized)
          void this.terminate("Native transport framing or authority failed.");
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (
        authorized &&
        !this.closing &&
        (socket === this.control || socket === this.videoSocket)
      )
        void this.terminate("Native transport closed.");
    });
  }
  private onFrame(frame: Buffer) {
    this.frame = frame;
    const now = Date.now();
    if (!this.frameStarted) {
      this.frameStarted = now;
      this.videoSocket?.setTimeout(10000);
    }
    const v = this.state.video;
    this.state = {
      ...this.state,
      video: {
        status: "streaming",
        width: frame.readUInt32LE(4),
        height: frame.readUInt32LE(8),
        fps:
          now - this.frameStarted >= 1000
            ? ((v.frames + 1) * 1000) / (now - this.frameStarted)
            : null,
        frames: v.frames + 1,
        last_frame_at: new Date(frame.readDoubleLE(24)).toISOString(),
        error: null,
      },
    };
    if (v.status !== "streaming")
      this.emit({ type: "state", data: this.snapshot() });
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {}
    }
  }
  private request(
    method: string,
    params: unknown = {},
    timeout = 10000,
  ): Promise<unknown> {
    const socket = this.control;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error("Native client control is unavailable."));
    if (this.pending.size >= 16)
      return Promise.reject(new Error("Native pending-request bound reached."));
    const id = ++this.sequence,
      reply = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      void this.terminate("Native operation deadline expired.");
    }, timeout);
    this.pending.set(id, {
      resolve: reply.resolve,
      reject: reply.reject,
      timer,
    });
    socket.write(
      JSON.stringify({
        id,
        method,
        params,
        world_id: this.state.world_id,
        epoch: this.state.epoch,
        generation: this.generation,
        session_id: this.owned?.session.session_id ?? this.state.session_id,
        life_id: this.state.life?.life_id ?? 0,
      }) + "\n",
      (error) => {
        if (error) void this.terminate("Native request write failed.");
      },
    );
    return reply.promise;
  }
  async connect(config: BridgeConnection) {
    if (this.connecting)
      throw new Error("A native connection is already in progress.");
    this.connecting = true;
    await this.disconnect();
    const controller = new AbortController();
    this.connectionAbort = controller;
    this.generation = 1;
    this.frame = null;
    this.frameStarted = 0;
    this.nativeMetrics = null;
    this.state = {
      ...this.state,
      status: "connecting",
      world_id: config.world_id,
      epoch: config.epoch,
      session_id: null,
      life: null,
      motor_profile: config.motor_profile ?? "balanced",
      player: null,
      error: null,
      video: {
        status: "starting",
        width: 0,
        height: 0,
        fps: null,
        frames: 0,
        last_frame_at: null,
        error: null,
      },
    };
    this.emit({ type: "state", data: this.snapshot() });
    try {
      const [controlPort, videoPort] = await Promise.all([
        this.listener("control"),
        this.listener("video"),
      ]);
      controller.signal.throwIfAborted();
      const launching = this.launcher.launch(
        config,
        controlPort,
        videoPort,
        controller.signal,
      );
      this.launching = launching;
      try {
        this.owned = await launching;
      } finally {
        if (this.launching === launching) this.launching = null;
      }
      const owned = this.owned;
      this.state = { ...this.state, session_id: owned.session.session_id };
      owned.child.once("error", () => {
        void this.terminate("Authenticated Minecraft client could not launch.");
      });
      void owned.closed.then(() => {
        if (this.owned === owned && !this.closing)
          void this.terminate("Authenticated Minecraft client exited.");
      });
      const deadline = Date.now() + 120000;
      let observed: Observation | null = null;
      while (Date.now() < deadline && this.owned === owned) {
        if (this.control) {
          try {
            observed = await this.observe();
            if (observed.life.status === "alive" || observed.life.status === "dead") break;
            observed = null;
          } catch {}
        }
        const delay = Promise.withResolvers<void>();
        setTimeout(delay.resolve, 250);
        await delay.promise;
      }
      if (this.owned !== owned || controller.signal.aborted)
        throw new Error("Native connection authority closed before ready.");
      if (!observed)
        throw new Error(
          `Authenticated Minecraft player did not join the private Fabric server.${owned.diagnostics.length ? ` Launch categories: ${owned.diagnostics.join(", ").slice(0, 300)}` : ""}`,
        );
      this.state = {
        ...this.state,
        status: "connected",
        username: owned.username,
        error: null,
      };
      this.emit({ type: "state", data: this.snapshot() });
      this.heartbeat = setInterval(() => {
        void this.request("diagnostics", {}, 5000)
          .then((value) => {
            this.nativeMetrics = jsonSchema.parse(value);
          })
          .catch(() => {});
        const last = this.state.video.last_frame_at;
        if (
          last &&
          Date.now() - Date.parse(last) > 2000 &&
          this.state.video.status !== "stale"
        ) {
          this.state = {
            ...this.state,
            video: { ...this.state.video, status: "stale" },
          };
          this.emit({ type: "state", data: this.snapshot() });
        }
      }, 3000);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Native Minecraft launch failed.";
      await this.terminate(message);
      this.state = {
        ...this.state,
        status: "error",
        error: message,
        video: { ...this.state.video, status: "error", error: message },
      };
      this.emit({ type: "state", data: this.snapshot() });
      throw new Error(message);
    } finally {
      this.connecting = false;
    }
  }
  async observe() {
    const started = performance.now();
    try {
      const o = observationSchema.parse(await this.request("observe"));
      if (o.world_id !== this.state.world_id || o.epoch !== this.state.epoch ||
          o.session_id !== this.owned?.session.session_id ||
          (this.state.life && (o.life.life_id < this.state.life.life_id ||
            (o.life.life_id === this.state.life.life_id && o.life.status === "alive" && this.state.life.status !== "alive"))))
        throw new Error("Native observation has stale authority.");
      this.state = {
        ...this.state,
        player: o.player,
        session_id: o.session_id,
        life: o.life,
        last_observation_at: o.captured_at,
      };
      this.emit({ type: "observation", data: o });
      return o;
    } finally {
      try {
        this.onTiming?.("observation_read_ms", performance.now() - started);
      } catch {}
    }
  }
  async recipes(item: string) {
    if (!/^[a-z0-9_]{1,100}$/.test(item)) throw new Error("Invalid item name.");
    return jsonSchema.parse(await this.request("recipes", { item }));
  }
  async setMotorProfile(profile: MotorProfile) {
    const parsed = motorProfileSchema.parse(profile);
    if (this.control) {
      z.object({ profile: z.literal(parsed) }).strict().parse(
        await this.request("motor_profile", { profile: parsed }, 5000),
      );
    }
    this.state = { ...this.state, motor_profile: parsed };
    this.emit({ type: "state", data: this.snapshot() });
  }
  async execute(
    action: GameAction,
    signal: AbortSignal,
  ): Promise<GameActionResult> {
    const parsed = gameActionSchema.safeParse(action);
    if (!parsed.success)
      return {
        status: "failed",
        summary: "The action does not match the native action contract.",
        evidence: { effect_confirmed: false, neutralized_effect: false },
      };
    if (signal.aborted)
      return {
        status: "cancelled",
        summary: "Cancelled before dispatch.",
        evidence: { effect_confirmed: false, neutralized_effect: false },
      };
    const started = performance.now();
    let cancelling: Promise<void> | null = null;
    const abort = () => {
      cancelling = this.cancel("Action cancelled.");
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = gameActionResultSchema.parse(
        await this.request("execute", parsed.data, 45000),
      );
      if (cancelling) await cancelling;
      return result;
    } catch {
      await this.terminate("Native action acknowledgement was lost.");
      const evidence: Record<string, Json> = {
        effect_confirmed: false,
        neutralized_effect: false,
      };
      return {
        status: "unknown",
        summary: "Action outcome is unknown; the native emitter was closed, not treated as effect confirmation.",
        evidence,
        requires_reconnect: true,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      try {
        this.onTiming?.("action_round_trip_ms", performance.now() - started);
      } catch {}
    }
  }
  async cancel(_reason: string) {
    if (!this.control) {
      if (this.connecting || this.owned || this.closing || this.launching) {
        this.connectionAbort?.abort();
        await this.terminate();
      }
      return;
    }
    try {
      await this.neutralize();
    } catch {
      await this.terminate("Native cancellation could not be acknowledged.");
    }
  }
  async neutralize() {
    if (this.neutralizing) return this.neutralizing;
    if (!this.control || this.control.destroyed)
      throw new Error("Native input barrier is unavailable; no neutralization proof exists.");
    const barrier = (async () => {
      const generation = ++this.generation;
      const owned = this.owned;
      const sessionId = owned?.session.session_id;
      try {
      const ack = z.object({
        neutralized: z.literal(true),
        generation: z.number().int().positive(),
        session_id: z.string().min(1).max(160),
        life_id: z.number().int().nonnegative(),
      }).strict().parse(await this.request("cancel", {}, 5000));
      if (!owned || this.owned !== owned || ack.session_id !== sessionId || ack.generation < generation)
        throw new Error("Native input barrier has stale authority.");
      this.generation = Math.max(this.generation, ack.generation);
      } catch (error) {
        await this.terminate("Native input barrier could not be acknowledged.");
        throw error;
      }
    })();
    this.neutralizing = barrier;
    try {
      await barrier;
    } finally {
      if (this.neutralizing === barrier) this.neutralizing = null;
    }
  }
  async disconnect() {
    // terminate already aborts the launch, fences requests, kills our emitter and awaits its exit.
    // Do not kill first and then await IPC: that window mislabels our expected EOF as a fault.
    await this.terminate();
  }
  private async terminate(error: string | null = null) {
    if (this.closing) return this.closing;
    this.connectionAbort?.abort();
    this.connectionAbort = null;
    const owned = this.owned;
    this.closing = (async () => {
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
      this.generation++;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Native client emitter closed."));
      }
      this.pending.clear();
      this.control?.destroy();
      this.videoSocket?.destroy();
      this.control = null;
      this.videoSocket = null;
      for (const server of this.servers) server.close();
      this.servers = [];
      const late = this.launching
        ? await this.launching.catch(() => null)
        : null;
      if (late && late !== owned) {
        late.child.kill("SIGKILL");
        await late.closed;
        if (this.owned === late) this.owned = null;
      }
      if (owned) {
        owned.child.kill("SIGKILL");
        await owned.closed;
      }
      if (this.owned === owned) this.owned = null;
      this.frame = null;
      const cause = this.state.error ?? error;
      this.state = {
        ...this.state,
        status: cause ? "error" : "disconnected",
        player: null,
        session_id: null,
        life: null,
        error: cause,
        video: {
          ...this.state.video,
          status: cause ? "error" : "idle",
          error: cause,
        },
      };
      this.emit({ type: "state", data: this.snapshot() });
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
    this.frameListeners.clear();
  }
}
