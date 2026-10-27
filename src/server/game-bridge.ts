import { createServer, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AdapterDescriptor, AdapterSchemaCatalog, BridgeConnection, BridgeNotice, GameActionResult, GameBridge, GameState, Json, MotorProfile, RuntimeAdapter } from "../shared/contracts.ts";
import type { EffectEnvelope, EffectOwnerRef } from "../shared/control.ts";
import { effectEnvelopeSchema, effectScopeSchema, identitySchema, safeCounterSchema, sameEffectScope, sameScreen, screenRefSchema, spaceRefSchema } from "../shared/control.ts";
import { jsonSchema, playerLifeSchema } from "../shared/primitives.ts";
import { gameActionResultSchema, motorProfileSchema } from "../shared/validation.ts";
import { minecraftProfileConfiguration } from "../shared/minecraft.ts";
import { ADAPTER_NEGOTIATION_LIMITS, assertActiveObservation, bindNativeDescriptor, contractHash, nativeHelloSchema, negotiateAdapterDescriptor } from "./adapter-contract.ts";
import { adapterDescriptorSchema } from "../shared/adapter.ts";
import { createMinecraftAdapter } from "./minecraft-adapter.ts";
import { RegisteredAdapterContract } from "./registered-adapter.ts";
import { readNativeArtifactContract, type NativeArtifactContract } from "./native-artifact.ts";
import { assertNativeContractFresh } from "./native-contract.ts";
import { MinecraftClient, type NativeOptions, type NativeProcess } from "./minecraft-client.ts";

const noticeSchema = z.object({ type: z.enum(["life", "scope"]), world_id: identitySchema, epoch: safeCounterSchema,
  session_id: identitySchema, native_boot_id: identitySchema, generation: safeCounterSchema.min(1), life: playerLifeSchema,
  space: spaceRefSchema.nullable(), screen: screenRefSchema.nullable(), neutralized: z.boolean(),
}).strict();
const response = z.union([
  z.object({ id: safeCounterSchema.min(1), ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ id: safeCounterSchema.min(1), ok: z.literal(false), error: z.string().max(500) }).strict(),
  z.object({ notice: noticeSchema }).strict(),
]);
const effectSchema = effectEnvelopeSchema(jsonSchema);
const effectReplySchema = z.object({ operation_id: identitySchema, compatibility_hash: z.string().regex(/^[a-f0-9]{64}$/),
  scope: effectScopeSchema, result: gameActionResultSchema }).strict();
const MAX_FRAME = 32 + 1920 * 1080 * 4;
/** GHV1 remains unchanged; packets emitted to subscribers are immutable owned bytes. */
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
      chunk.copy(this.buffer, this.used, offset, offset + n); this.used += n; offset += n;
      if (this.used === 32 && this.expected === 32) {
        const w = this.buffer.readUInt32LE(4), h = this.buffer.readUInt32LE(8), bytes = this.buffer.readUInt32LE(12),
          seq = this.buffer.readUInt32LE(16), flags = this.buffer.readUInt32LE(20), captured = this.buffer.readDoubleLE(24);
        if (this.buffer.readUInt32LE(0) !== 0x47485631 || w < 1 || h < 1 || w > 1920 || h > 1080 || bytes !== w * h * 4 ||
          flags > 1 || !Number.isFinite(captured) || Math.abs(Date.now() - captured) > 5000 ||
          this.sequence !== null && ((seq - this.sequence) >>> 0 > 0x7fffffff || seq === this.sequence)) throw new Error("Invalid native video framing.");
        this.expected = 32 + bytes; this.sequence = seq;
      }
      if (this.used === this.expected && this.expected > 32) {
        const frame = Buffer.from(this.buffer.subarray(0, this.expected)); this.used = 0; this.expected = 32; this.receive(frame);
      }
    }
  }
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface OwnedEffect { effect: EffectEnvelope; generation: number }

/** Concrete Minecraft transport; generic Runtime sees only negotiated envelopes and adapter registration. */
export class GameBridgeClient implements GameBridge {
  private readonly launcher: MinecraftClient;
  private readonly options: NativeOptions;
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
  private registration: RegisteredAdapterContract | null = null;
  private runtimeAdapter: RuntimeAdapter | null = null;
  private expectedDescriptor: AdapterDescriptor | null = null;
  private schemas: AdapterSchemaCatalog | null = null;
  private prepared: NativeArtifactContract | null = null;
  private ownedEffect: OwnedEffect | null = null;
  private motorProfile: MotorProfile = "balanced";
  private scopeNoticeSeen = false;
  private state: GameState = { status: "disconnected", username: "", version: "1.21.4", world_id: null, epoch: 0,
    session_id: null, life: null, binding: null, space: null, screen: null, presentation: null,
    video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
    last_observation_at: null, error: null };

  constructor(private readonly projectRoot = process.cwd(), options: NativeOptions = {}) {
    this.options = options; this.launcher = new MinecraftClient(projectRoot, options);
  }
  adapter() { return this.state.binding?.ready ? this.runtimeAdapter : null; }
  performanceMetrics(): Json { return { native: this.nativeMetrics, video: { ...this.state.video } }; }
  snapshot(): GameState { return { ...this.state, video: { ...this.state.video } }; }
  subscribe(listener: (notice: BridgeNotice) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  subscribeFrames(listener: (frame: Uint8Array) => void) { this.frameListeners.add(listener); return () => { this.frameListeners.delete(listener); }; }
  latestFrame() { return this.frame; }
  private emit(notice: BridgeNotice) { for (const listener of this.listeners) { try { listener(notice); } catch {} } }
  private ensureProvidedRegistration() {
    if (this.registration) return;
    const schemas = this.options.schemas;
    if (this.options.descriptor === undefined || !schemas) throw new Error("Native contract has not been prepared");
    this.expectedDescriptor = adapterDescriptorSchema.parse(this.options.descriptor); this.schemas = schemas;
    this.registration = new RegisteredAdapterContract(this.expectedDescriptor, schemas);
    this.runtimeAdapter = this.options.adapter ?? null;
  }
  private async prepareRegistration() {
    if (this.options.descriptor !== undefined) { this.ensureProvidedRegistration(); return; }
    const artifact = path.join(this.projectRoot, "native/minecraft/build/libs/gameharness-native-1.0.0.jar");
    const actual = await readNativeArtifactContract(artifact);
    const resource = await assertNativeContractFresh(this.projectRoot, actual.resource);
    this.prepared = actual;
    const descriptor = structuredClone(resource.descriptor);
    descriptor.observation.profile.configuration = minecraftProfileConfiguration(this.motorProfile);
    descriptor.observation.profile.configuration_hash = contractHash(descriptor.observation.profile.configuration);
    this.expectedDescriptor = descriptor; this.schemas = resource.schemas;
    this.registration = new RegisteredAdapterContract(descriptor, resource.schemas);
    this.runtimeAdapter = createMinecraftAdapter(this.registration.compatibility.descriptor);
  }
  private async listener(kind: "control" | "video") {
    const server = createServer(socket => this.accept(socket, kind)); server.maxConnections = 2; this.servers.push(server);
    const ready = Promise.withResolvers<number>();
    server.once("error", () => ready.reject(new Error("Native loopback listener failed.")));
    server.listen(0, "127.0.0.1", () => { const address = server.address();
      if (address && typeof address !== "string") ready.resolve(address.port); else ready.reject(new Error("Native listener has no port.")); });
    return ready.promise;
  }
  private accept(socket: Socket, kind: "control" | "video") {
    socket.setNoDelay(true); socket.setTimeout(10000, () => socket.destroy());
    let authorized = false, authenticated = false, text = Buffer.alloc(0);
    const decoder = kind === "video" ? new NativeFrameDecoder(frame => this.onFrame(frame)) : null;
    socket.on("data", (chunk: Buffer) => {
      if (authorized && socket !== (kind === "control" ? this.control : this.videoSocket)) return;
      try {
        if (!authorized) {
          text = Buffer.concat([text, chunk]); const end = text.indexOf(10);
          if (end < 0) { if (text.length > ADAPTER_NEGOTIATION_LIMITS.hello_bytes) socket.destroy(); return; }
          if (end > ADAPTER_NEGOTIATION_LIMITS.hello_bytes) throw new Error("Oversized native handshake");
          const raw = JSON.parse(text.subarray(0, end).toString("utf8")), session = this.owned?.session;
          const secret = Buffer.from(String(raw.secret)), expected = Buffer.from(session?.secret ?? "");
          if (!session || secret.length !== expected.length || !timingSafeEqual(secret, expected) || raw.world_id !== session.world_id ||
            raw.epoch !== session.epoch || raw.session_id !== session.session_id) throw new Error("Native authentication rejected");
          authenticated = true;
          const hello = nativeHelloSchema.parse(raw); this.ensureProvidedRegistration();
          const bound = bindNativeDescriptor(hello, this.expectedDescriptor!, this.schemas!);
          if (this.state.binding && (this.state.binding.native_boot_id !== bound.native_boot_id ||
            this.state.binding.compatibility_hash !== bound.compatibility_hash)) throw new Error("Native control/video bindings disagree");
          if (kind === "control" ? this.control : this.videoSocket) throw new Error("Duplicate native channel");
          this.state = { ...this.state, binding: bound, version: bound.descriptor.game.version };
          authorized = true; socket.setTimeout(kind === "control" ? 15000 : 120000);
          if (kind === "control") this.control = socket; else this.videoSocket = socket;
          chunk = text.subarray(end + 1); text = Buffer.alloc(0);
        }
        if (decoder) { decoder.push(chunk); return; }
        text = Buffer.concat([text, chunk]); if (text.length > 131072) throw new Error("Native response exceeded bound");
        let end: number;
        while ((end = text.indexOf(10)) >= 0) {
          const message = response.parse(JSON.parse(text.subarray(0, end).toString("utf8"))); text = text.subarray(end + 1);
          if ("notice" in message) { this.receiveNotice(message.notice); continue; }
          const pending = this.pending.get(message.id); if (!pending) throw new Error("Uncorrelated native response");
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.ok) pending.resolve(message.data); else pending.reject(new Error(message.error));
        }
      } catch {
        socket.destroy();
        if (authorized || authenticated) void this.terminate("Native negotiation, framing or authority failed.");
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => { if (authorized && !this.closing && (socket === this.control || socket === this.videoSocket)) void this.terminate("Native transport closed."); });
  }
  private receiveNotice(notice: z.infer<typeof noticeSchema>) {
    const session = this.owned?.session, binding = this.state.binding;
    if (!session || notice.session_id !== session.session_id || notice.world_id !== session.world_id || notice.epoch !== session.epoch) return;
    if (!binding || notice.native_boot_id !== binding.native_boot_id) throw new Error("Native notice has stale boot authority");
    const previous = this.state.life;
    if (previous && notice.life.life_id < previous.life_id || this.state.space && notice.space && notice.space.space_epoch < this.state.space.space_epoch) return;
    this.generation = Math.max(this.generation, notice.generation);
    this.scopeNoticeSeen = true;
    this.state = { ...this.state, life: notice.life, space: notice.space, screen: notice.screen };
    const died = notice.life.status === "dead" && (!previous || previous.status === "alive" || previous.status === "loading" || previous.life_id !== notice.life.life_id);
    this.emit({ type: "game_event", data: { ...notice, type: died ? "death" : notice.type,
      summary: died ? "Player life ended; native inputs are fenced and the owned session remains available." : "Authoritative native scope changed." } });
    this.emit({ type: "state", data: this.snapshot() });
  }
  private onFrame(frame: Buffer) {
    this.frame = frame; const now = Date.now();
    if (!this.frameStarted) { this.frameStarted = now; this.videoSocket?.setTimeout(10000); }
    const previous = this.state.video;
    this.state = { ...this.state, video: { status: "streaming", width: frame.readUInt32LE(4), height: frame.readUInt32LE(8),
      fps: now - this.frameStarted >= 1000 ? (previous.frames + 1) * 1000 / (now - this.frameStarted) : null,
      frames: previous.frames + 1, last_frame_at: new Date(frame.readDoubleLE(24)).toISOString(), error: null } };
    if (previous.status !== "streaming") this.emit({ type: "state", data: this.snapshot() });
    for (const listener of this.frameListeners) { try { listener(frame); } catch {} }
  }
  private request(method: string, params: unknown = {}, timeout = 10000): Promise<unknown> {
    const socket = this.control, binding = this.state.binding;
    if (!socket || socket.destroyed || !binding?.ready) return Promise.reject(new Error("Negotiated native control is unavailable."));
    if (this.pending.size >= 16 || this.sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error("Native request identity/pending bound reached."));
    const id = ++this.sequence, reply = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { void this.terminate("Native operation deadline expired."); }, timeout);
    this.pending.set(id, { resolve: reply.resolve, reject: reply.reject, timer });
    socket.write(JSON.stringify({ id, method, params, world_id: this.state.world_id, epoch: this.state.epoch, generation: this.generation,
      native_boot_id: binding.native_boot_id, session_id: this.owned?.session.session_id ?? this.state.session_id }) + "\n",
      error => { if (error) void this.terminate("Native request write failed."); });
    return reply.promise;
  }
  async connect(config: BridgeConnection) {
    if (this.connecting) throw new Error("A native connection is already in progress.");
    this.connecting = true;
    await this.disconnect();
    const controller = new AbortController(); this.connectionAbort = controller; this.generation = 1; this.sequence = 0;
    this.frame = null; this.frameStarted = 0; this.nativeMetrics = null;
    this.scopeNoticeSeen = false;
    this.state = { ...this.state, status: "connecting", world_id: config.world_id, epoch: safeCounterSchema.parse(config.epoch), session_id: null,
      life: null, binding: null, space: null, screen: null, presentation: null, error: null,
      video: { status: "starting", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null } };
    if (config.motor_profile) this.motorProfile = motorProfileSchema.parse(config.motor_profile);
    this.emit({ type: "state", data: this.snapshot() });
    try {
      await this.prepareRegistration(); controller.signal.throwIfAborted();
      if (config.version !== this.expectedDescriptor!.game.version) throw new Error("Requested game version does not match the actual native build");
      const [controlPort, videoPort] = await Promise.all([this.listener("control"), this.listener("video")]);
      const launching = this.launcher.launch({ ...config, motor_profile: this.motorProfile }, controlPort, videoPort, controller.signal, this.prepared ?? undefined);
      this.launching = launching;
      try { this.owned = await launching; } finally { if (this.launching === launching) this.launching = null; }
      const owned = this.owned; this.state = { ...this.state, session_id: owned.session.session_id };
      owned.child.once("error", () => { void this.terminate("Authenticated Minecraft client could not launch."); });
      void owned.closed.then(() => { if (this.owned === owned && !this.closing) void this.terminate("Authenticated Minecraft client exited."); });
      const deadline = Date.now() + 120000; let observed = false;
      while (Date.now() < deadline && this.owned === owned && !controller.signal.aborted) {
        if (this.control) { try {
          const current = await this.observe();
          // Joining can report an alive player before vanilla closes its loading screen.
          if (current.life.status === "alive" && current.screen === null || current.life.status === "dead") { observed = true; break; }
        } catch {} }
        const delay = Promise.withResolvers<void>(); setTimeout(delay.resolve, 250); await delay.promise;
      }
      if (this.owned !== owned || controller.signal.aborted) throw new Error("Native connection authority closed before ready.");
      if (!observed) throw new Error(`Authenticated Minecraft player did not join the private server.${owned.diagnostics.length ? ` Launch categories: ${owned.diagnostics.join(", ").slice(0, 300)}` : ""}`);
      this.state = { ...this.state, status: "connected", username: owned.username, error: null };
      this.emit({ type: "state", data: this.snapshot() });
      this.heartbeat = setInterval(() => {
        void this.request("diagnostics", {}, 5000).then(value => { this.nativeMetrics = jsonSchema.parse(value); }).catch(() => {});
        const last = this.state.video.last_frame_at;
        if (last && Date.now() - Date.parse(last) > 2000 && this.state.video.status !== "stale") {
          this.state = { ...this.state, video: { ...this.state.video, status: "stale" } }; this.emit({ type: "state", data: this.snapshot() });
        }
      }, 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Native Minecraft launch failed.";
      await this.terminate(message); throw new Error(message);
    } finally { this.connecting = false; }
  }
  async observe() {
    const started = performance.now();
    try {
      if (!this.state.binding || !this.registration) throw new Error("Native observation binding is unavailable.");
      const observation = this.registration.parseObservation(await this.request("observe"));
      const current = assertActiveObservation(observation, this.state.binding);
      if (current.world_id !== this.state.world_id || current.epoch !== this.state.epoch || current.session_id !== this.owned?.session.session_id ||
        this.state.life && (current.life.life_id < this.state.life.life_id || current.life.life_id === this.state.life.life_id && current.life.status === "alive" && this.state.life.status !== "alive") ||
        this.state.space && current.space.space_epoch < this.state.space.space_epoch ||
        this.scopeNoticeSeen && !sameScreen(current.screen, this.state.screen)) throw new Error("Native observation has stale authority.");
      const presentation = this.runtimeAdapter ? this.runtimeAdapter.projectObservation(current) : {
        state: current.data, summary: "Registered adapter observation", metadata: { payload_schema_id: this.state.binding.descriptor.observation.payload_schema.id } };
      this.state = { ...this.state, life: current.life, space: current.space, screen: current.screen, session_id: current.session_id,
        last_observation_at: current.captured_at, presentation };
      this.emit({ type: "observation", data: current }); return current;
    } finally { try { this.options.onTiming?.("observation_read_ms", performance.now() - started); } catch {} }
  }
  async queryCapability(id: string, version: number, args: Json): Promise<Json> {
    if (!this.registration || id !== "minecraft.recipes" || version !== 1) throw new Error("The selected adapter does not implement this read capability.");
    const parsed = this.registration.parseCapability(id, version, args);
    return jsonSchema.parse(await this.request("recipes", parsed));
  }
  async setMotorProfile(profile: MotorProfile) {
    const parsed = motorProfileSchema.parse(profile);
    if (this.control) {
      const response = z.object({ profile: z.literal(parsed), descriptor: adapterDescriptorSchema }).strict().parse(await this.request("motor_profile", { profile: parsed }, 5000));
      const expected = structuredClone(this.expectedDescriptor!);
      expected.observation.profile.configuration = minecraftProfileConfiguration(parsed);
      expected.observation.profile.configuration_hash = contractHash(expected.observation.profile.configuration);
      const compatible = negotiateAdapterDescriptor(expected, response.descriptor, this.schemas!);
      this.expectedDescriptor = compatible.descriptor; this.registration = new RegisteredAdapterContract(compatible.descriptor, this.schemas!);
      this.runtimeAdapter = createMinecraftAdapter(compatible.descriptor);
      this.state = { ...this.state, binding: { ...compatible, ready: true, native_boot_id: this.state.binding!.native_boot_id } };
    }
    this.motorProfile = parsed; this.emit({ type: "state", data: this.snapshot() });
  }
  async execute(value: EffectEnvelope, signal: AbortSignal): Promise<GameActionResult> {
    const parsed = effectSchema.safeParse(value), binding = this.state.binding;
    if (signal.aborted) return { status: "cancelled", summary: "Cancelled before dispatch.", evidence: { effect_confirmed: false, neutralized_effect: false } };
    if (!parsed.success || !binding?.ready || !this.registration || this.ownedEffect || parsed.data.compatibility_hash !== binding.compatibility_hash ||
      parsed.data.scope.native_boot_id !== binding.native_boot_id || parsed.data.scope.session_id !== this.state.session_id ||
      parsed.data.scope.world_id !== this.state.world_id || parsed.data.scope.epoch !== this.state.epoch ||
      parsed.data.scope.life_id !== this.state.life?.life_id || parsed.data.scope.space_epoch !== this.state.space?.space_epoch ||
      !sameScreen(parsed.data.expected_screen, this.state.screen))
      return { status: "failed", summary: "The effect does not match current negotiated native authority.", evidence: { effect_confirmed: false, neutralized_effect: false } };
    let effect = parsed.data;
    try {
      const action = this.registration.parseCapability("minecraft.action", 1, effect.action);
      effect = { ...effect, action };
    } catch { return { status: "failed", summary: "The action does not match its registered adapter capability.", evidence: { effect_confirmed: false, neutralized_effect: false } }; }
    const owned: OwnedEffect = { effect, generation: this.generation }; this.ownedEffect = owned;
    const started = performance.now(); let cancelling: Promise<void> | null = null;
    const abort = () => { cancelling = this.cancel("Action cancelled.", { operation_id: effect.operation_id, scope: effect.scope }); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const deadline = Math.max(45000, (this.runtimeAdapter?.effectDeadlineMs(effect.action) ?? 40000) + 5000);
      const reply = effectReplySchema.parse(await this.request("execute", effect, deadline));
      if (reply.operation_id !== effect.operation_id || reply.compatibility_hash !== effect.compatibility_hash || !sameEffectScope(reply.scope, effect.scope)) throw new Error("Native effect receipt has stale authority");
      if (cancelling) await cancelling;
      return reply.result;
    } catch {
      await this.terminate("Native action acknowledgement was lost or mismatched.");
      return { status: "unknown", summary: "Action outcome is unknown; its emitter was closed, never replayed or treated as effect confirmation.",
        evidence: { effect_confirmed: false, neutralized_effect: false }, requires_reconnect: true };
    } finally {
      signal.removeEventListener("abort", abort); if (this.ownedEffect === owned) this.ownedEffect = null;
      try { this.options.onTiming?.("action_round_trip_ms", performance.now() - started); } catch {}
    }
  }
  async neutralize(owner: EffectOwnerRef) {
    if (!owner) throw new Error("Expected native operation owner is required; no global cleanup alias exists.");
    const active = this.ownedEffect;
    if (!active || active.effect.operation_id !== owner.operation_id || !sameEffectScope(active.effect.scope, owner.scope)) return;
    if (this.neutralizing) return this.neutralizing;
    const barrier = this.cancellationBarrier({ expected_owner: { operation_id: owner.operation_id, scope: owner.scope, generation: active.generation } });
    this.neutralizing = barrier;
    try { await barrier; } finally { if (this.neutralizing === barrier) this.neutralizing = null; }
  }
  private async cancellationBarrier(params: unknown) {
    if (!this.control || this.control.destroyed) throw new Error("Native input barrier is unavailable; no neutralization proof exists.");
    const minimum = this.generation, owned = this.owned;
    const ack = z.object({ neutralized: z.literal(true), matched_owner: z.boolean(), generation: safeCounterSchema,
      session_id: identitySchema, life_id: safeCounterSchema }).strict().parse(await this.request("cancel", params, 5000));
    if (!owned || this.owned !== owned || ack.session_id !== owned.session.session_id || ack.generation < minimum ||
      ack.matched_owner && ack.generation <= minimum) throw new Error("Native input barrier has stale authority.");
    this.generation = Math.max(this.generation, ack.generation);
  }
  async cancel(_reason: string, owner: EffectOwnerRef) {
    // Expected-owner cleanup cannot claim closure while a prior terminal owner
    // is still draining, even when its control socket has already disappeared.
    if (!this.control && this.closing) { await this.closing; return; }
    try { await this.neutralize(owner); } catch { await this.terminate("Native owner cancellation could not be acknowledged."); }
  }
  async emergencyStop(_reason: string) {
    if (!this.control) { if (this.connecting || this.owned || this.closing || this.launching) await this.terminate(); return; }
    try { await this.cancellationBarrier({ emergency: true }); } catch { await this.terminate("Native emergency Stop could not be acknowledged."); }
  }
  async disconnect() { await this.terminate(); }
  private async terminate(error: string | null = null) {
    if (this.closing) return this.closing;
    this.connectionAbort?.abort(); this.connectionAbort = null; const owned = this.owned;
    this.closing = (async () => {
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Native client emitter closed.")); }
      this.pending.clear(); this.control?.destroy(); this.videoSocket?.destroy(); this.control = null; this.videoSocket = null;
      for (const server of this.servers) server.close(); this.servers = [];
      const late = this.launching ? await this.launching.catch(() => null) : null;
      if (late && late !== owned) { late.child.kill("SIGKILL"); await late.closed; if (this.owned === late) this.owned = null; }
      if (owned) { owned.child.kill("SIGKILL"); await owned.closed; }
      if (this.owned === owned) this.owned = null; this.ownedEffect = null; this.frame = null;
      const cause = this.state.error ?? error;
      this.state = { ...this.state, status: cause ? "error" : "disconnected", presentation: null, session_id: null, life: null,
        binding: null, space: null, screen: null, error: cause, video: { ...this.state.video, status: cause ? "error" : "idle", error: cause } };
      this.emit({ type: "state", data: this.snapshot() });
    })();
    try { await this.closing; } finally { this.closing = null; }
  }
  async close() { await this.disconnect(); this.listeners.clear(); this.frameListeners.clear(); }
}
