import { createServer, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { PreparationContract } from "./prepared-source-contract.ts";
import type {
  AdapterDescriptor,
  AdapterSchemaCatalog,
  BridgeConnection,
  BridgeNotice,
  GameActionResult,
  GameBridge,
  GameState,
  Json,
  MotorProfile,
  RuntimeAdapter,
} from "../shared/contracts.ts";
import type { EffectEnvelope, EffectOwnerRef, ProducerSupervision } from "../shared/control.ts";
import {
  effectEnvelopeSchema,
  effectScopeSchema,
  expectedEffectOwnerSchema,
  identitySchema,
  safeCounterSchema,
  sameEffectScope,
  sameScreen,
  screenPreconditionMatches,
  screenRefSchema,
  spaceRefSchema,
  visibleScreenSnapshotSchema,
} from "../shared/control.ts";
import {
  controllerEffectUpdateSchema,
  controllerReservationSchema,
  nativeNanosecondsSchema,
  type ControllerEffectUpdate,
  type ControllerInputChannel,
  type ControllerReservation,
  type InputAppliedAck,
} from "../shared/controller.ts";
import {
  gameActionResultSchema,
  jsonSchema,
  playerLifeSchema,
} from "../shared/primitives.ts";
import { motorProfileSchema } from "../shared/validation.ts";
import {
  minecraftActionSchema,
  minecraftControllerFrameSchema,
  minecraftProfileConfiguration,
} from "../shared/minecraft.ts";
import {
  ADAPTER_NEGOTIATION_LIMITS,
  assertActiveObservation,
  bindNativeDescriptor,
  contractHash,
  nativeHelloSchema,
  negotiateAdapterDescriptor,
} from "./adapter-contract.ts";
import { adapterDescriptorSchema } from "../shared/adapter.ts";
import { createMinecraftAdapter } from "./minecraft-adapter.ts";
import { RegisteredAdapterContract } from "./registered-adapter.ts";
import {
  readNativeArtifactContract,
  type NativeArtifactContract,
} from "./native-artifact.ts";
import { assertNativeContractFresh } from "./native-contract.ts";
import {
  MinecraftClient,
  type NativeOptions,
  type NativeProcess,
} from "./minecraft-client.ts";
import {
  decodeNativeVideoHeader,
  MAX_NATIVE_VIDEO_FRAME_BYTES,
  NATIVE_VIDEO_HEADER_BYTES,
} from "../shared/video.ts";
import {
  NativeControlTimeline,
  type NativeControlTiming,
  type NativeRequestSpan,
} from "./performance.ts";
import {
  controllerNativeDeadline,
  NativeControllerChannel,
  NativeRequestFault,
  type NativeRequestStatus,
} from "./controller-channel.ts";

const noticeSchema = z
  .object({
    type: z.enum(["life", "scope"]),
    world_id: identitySchema,
    epoch: safeCounterSchema,
    session_id: identitySchema,
    native_boot_id: identitySchema,
    generation: safeCounterSchema.min(1),
    life: playerLifeSchema,
    space: spaceRefSchema.nullable(),
    screen: screenRefSchema.nullable(),
    neutralized: z.boolean(),
  })
  .strict();
const nativeCounterStringSchema = z
  .string()
  .max(16)
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
const nativeOpportunityEventSchema = z
  .object({
    kind: z.enum([
      "admission",
      "begin",
      "completion",
      "application_stage",
      "sample_ready",
      "prepare_entry",
      "prepare_exit",
      "prepare_branch",
      "sample_render",
    ]),
    outcome: z.enum([
      "admitted",
      "admission_failed",
      "expired",
      "applying",
      "empty",
      "stale",
      "began",
      "completed",
      "stage",
      "not_rendered",
      "retired",
      "no_owner",
      "wrong_owner",
      "not_new_tick",
      "ready",
      "observed",
      "passed",
      "blocked",
    ]),
    eventseq: nativeCounterStringSchema.refine((value) => value !== "0"),
    native_ns: nativeNanosecondsSchema,
    checked_native_ns: nativeNanosecondsSchema.nullable(),
    tick: nativeCounterStringSchema.nullable(),
    preparation_ordinal: nativeCounterStringSchema.nullable(),
    request_id: nativeCounterStringSchema.nullable(),
    sequence: nativeCounterStringSchema.nullable(),
    frame_sequence: nativeCounterStringSchema.nullable(),
    captured_native_ns: nativeNanosecondsSchema.nullable(),
    pending_count: nativeCounterStringSchema.nullable(),
    head_request_id: nativeCounterStringSchema.nullable(),
    head_sequence: nativeCounterStringSchema.nullable(),
    head_frame_sequence: nativeCounterStringSchema.nullable(),
    predecessor_request_id: nativeCounterStringSchema.nullable(),
    predecessor_sequence: nativeCounterStringSchema.nullable(),
    predecessor_frame_sequence: nativeCounterStringSchema.nullable(),
    applying_request_id: nativeCounterStringSchema.nullable(),
    applying_sequence: nativeCounterStringSchema.nullable(),
    applying_frame_sequence: nativeCounterStringSchema.nullable(),
    last_completed_request_id: nativeCounterStringSchema.nullable(),
    last_completed_sequence: nativeCounterStringSchema.nullable(),
    last_completed_frame_sequence: nativeCounterStringSchema.nullable(),
    last_completed_tick: nativeCounterStringSchema.nullable(),
    last_applied_native_ns: nativeNanosecondsSchema.nullable(),
    applied_native_ns: nativeNanosecondsSchema.nullable(),
    diagnostic_completion_native_ns: nativeNanosecondsSchema.nullable(),
    evaluated_mask: nativeCounterStringSchema.nullable(),
    value_mask: nativeCounterStringSchema.nullable(),
    last_sampled_tick: nativeCounterStringSchema.nullable(),
    state_mask: nativeCounterStringSchema.nullable(),
    stage: nativeCounterStringSchema.nullable(),
  })
  .strict();
const nativeOpportunityIdentitySchema = z
  .object({
    owner_operation_id: identitySchema,
    controller_generation: nativeCounterStringSchema.refine(
      (value) => value !== "0",
    ),
    native_boot_id: identitySchema,
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const nativeOpportunityBatchSchema = z
  .object({
    schema_version: z.literal(1),
    identity: nativeOpportunityIdentitySchema,
    counts: z
      .object({
        attempted: nativeCounterStringSchema,
        accepted: nativeCounterStringSchema,
        omitted: nativeCounterStringSchema,
        contended: nativeCounterStringSchema,
        exhausted: nativeCounterStringSchema,
        closed_omitted: nativeCounterStringSchema,
        drained: nativeCounterStringSchema,
        retained: safeCounterSchema.max(65536),
        sealed: z.boolean(),
      })
      .strict(),
    final_batch: z.boolean(),
    unattached_retained: safeCounterSchema.max(65536),
    counts_consistent: z.boolean(),
    complete: z.boolean(),
    events: z.array(nativeOpportunityEventSchema).max(64),
  })
  .strict()
  .superRefine((batch, context) => {
    const counts = batch.counts,
      attempted = BigInt(counts.attempted),
      accepted = BigInt(counts.accepted),
      omitted = BigInt(counts.omitted);
    const consistent = attempted === accepted + omitted;
    const complete =
      batch.final_batch &&
      counts.retained === batch.events.length &&
      omitted === 0n &&
      attempted === accepted;
    if (
      counts.retained < batch.events.length ||
      batch.unattached_retained !== counts.retained - batch.events.length ||
      accepted !== BigInt(counts.drained) + BigInt(counts.retained) ||
      omitted !==
        BigInt(counts.contended) +
          BigInt(counts.exhausted) +
          BigInt(counts.closed_omitted) ||
      batch.counts_consistent !== consistent ||
      batch.complete !== complete ||
      (batch.final_batch && !counts.sealed)
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent native opportunity batch bookkeeping",
      });
    let previous = 0n;
    for (const event of batch.events) {
      const sequence = BigInt(event.eventseq);
      if (sequence <= previous || sequence > attempted)
        context.addIssue({
          code: "custom",
          message: "Unordered native opportunity event sequence",
        });
      previous = sequence;
    }
  });
const nativeOpportunityTimingSchema = z.union([
  nativeOpportunityBatchSchema,
  z
    .object({
      schema_version: z.literal(1),
      identity: nativeOpportunityIdentitySchema,
      counts: z.null(),
      final_batch: z.literal(false),
      complete: z.literal(false),
      events: z.tuple([]),
      unavailable: z.enum([
        "busy",
        "committed_prefix_pending",
        "seal_pending",
        "owner_capacity",
        "serialization_oversize",
      ]),
    })
    .strict(),
]);
const nativeTimingSchema = z
  .object({
    schema_version: z.literal(1),
    clock_id: identitySchema,
    received_ns: z
      .string()
      .max(20)
      .regex(/^-?(?:0|[1-9]\d{0,18})$/),
    replied_ns: z
      .string()
      .max(20)
      .regex(/^-?(?:0|[1-9]\d{0,18})$/),
    client_tick: safeCounterSchema,
    controller_lease: z
      .object({
        schema_version: z.literal(1),
        event: z.enum(["open", "renew", "refused", "retirement"]),
        owner: expectedEffectOwnerSchema,
        controller_generation: safeCounterSchema.min(1),
        checked_native_ns: nativeNanosecondsSchema,
        requested_deadline_native_ns: nativeNanosecondsSchema.nullable(),
        previous_deadline_native_ns: nativeNanosecondsSchema.nullable(),
        effective_deadline_native_ns: nativeNanosecondsSchema,
        task_deadline_native_ns: nativeNanosecondsSchema,
        accepted: z.boolean(),
        first_fence_reason: z.string().max(500).nullable(),
        first_fence_native_ns: nativeNanosecondsSchema.nullable(),
        retirement_trigger: z.string().max(500).nullable(),
        retirement_native_ns: nativeNanosecondsSchema.nullable(),
      })
      .strict()
      .optional(),
    controller_application: z
      .object({
        schema_version: z.literal(1),
        owner: expectedEffectOwnerSchema,
        controller_generation: safeCounterSchema.min(1),
        sequence: safeCounterSchema.min(1),
        frame_seq: safeCounterSchema.min(1),
        admitted_native_ns: nativeNanosecondsSchema,
        pending_ahead: safeCounterSchema.max(3),
        applying_ahead_sequence: safeCounterSchema,
        admitted_preparation_ordinal: safeCounterSchema,
        began_native_ns: nativeNanosecondsSchema,
        began_native_tick: safeCounterSchema,
        began_preparation_ordinal: safeCounterSchema.min(1),
        prepared_native_ns: nativeNanosecondsSchema.nullable(),
        consumed_native_ns: nativeNanosecondsSchema.nullable(),
        sampled_native_ns: nativeNanosecondsSchema.nullable(),
        settled_native_ns: nativeNanosecondsSchema,
        settled_native_tick: safeCounterSchema,
      })
      .strict()
      .optional(),
    controller_opportunities: nativeOpportunityTimingSchema.optional(),
  })
  .strict()
  .refine(
    (timing) =>
      !timing.controller_opportunities ||
      timing.controller_opportunities.identity.native_boot_id ===
        timing.clock_id,
    { message: "Native opportunity boot differs from its timing clock" },
  );
const response = z.union([
  z
    .object({
      id: safeCounterSchema.min(1),
      ok: z.literal(true),
      data: z.unknown(),
      timing: nativeTimingSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: safeCounterSchema.min(1),
      ok: z.literal(false),
      error: z.string().max(500),
      timing: nativeTimingSchema.optional(),
    })
    .strict(),
  z.object({ notice: noticeSchema }).strict(),
  z
    .object({
      controller_effect: controllerEffectUpdateSchema
        .extend({ owner: expectedEffectOwnerSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      controller_progress: z
        .object({
          owner: expectedEffectOwnerSchema,
          controller_generation: safeCounterSchema.min(1),
          sequence: safeCounterSchema,
          native_tick: safeCounterSchema,
          captured_native_ns: nativeNanosecondsSchema,
          telemetry_omitted: safeCounterSchema,
        })
        .strict(),
    })
    .strict(),
]);
const effectSchema = effectEnvelopeSchema(jsonSchema);
const effectReplySchema = z
  .object({
    operation_id: identitySchema,
    compatibility_hash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: effectScopeSchema,
    result: gameActionResultSchema,
  })
  .strict();
/** Complete GHV2 packets emitted to subscribers are immutable owned bytes. */
export class NativeFrameDecoder {
  private buffer = Buffer.allocUnsafe(MAX_NATIVE_VIDEO_FRAME_BYTES);
  private used = 0;
  private expected = NATIVE_VIDEO_HEADER_BYTES;
  private sequence: number | null = null;
  constructor(private readonly receive: (frame: Buffer) => void) {}
  push(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(this.expected - this.used, chunk.length - offset);
      chunk.copy(this.buffer, this.used, offset, offset + n);
      this.used += n;
      offset += n;
      if (
        this.used === NATIVE_VIDEO_HEADER_BYTES &&
        this.expected === NATIVE_VIDEO_HEADER_BYTES
      ) {
        const header = decodeNativeVideoHeader(
            this.buffer.subarray(0, NATIVE_VIDEO_HEADER_BYTES),
          ),
          now = Date.now();
        if (
          !header ||
          header.capturedAt > now + 2000 ||
          now - header.capturedAt > 5000 ||
          (this.sequence !== null &&
            ((header.sequence - this.sequence) >>> 0 > 0x7fffffff ||
              header.sequence === this.sequence))
        )
          throw new Error("Invalid native video framing.");
        this.expected = header.headerBytes + header.width * header.height * 4;
        this.sequence = header.sequence;
      }
      if (
        this.used === this.expected &&
        this.expected > NATIVE_VIDEO_HEADER_BYTES
      ) {
        const frame = Buffer.from(this.buffer.subarray(0, this.expected));
        this.used = 0;
        this.expected = NATIVE_VIDEO_HEADER_BYTES;
        this.receive(frame);
      }
    }
  }
}
type ControlLane = "ordinary" | "input" | "sample" | "heartbeat" | "retirement";
const laneLimits: Record<ControlLane, number> = {
  ordinary: 16,
  input: 4,
  sample: 1,
  heartbeat: 8,
  retirement: 1,
};
function controlLane(method: string): ControlLane {
  if (
    method === "cancel" ||
    method === "disconnect" ||
    method === "controller_revoke"
  )
    return "retirement";
  if (method === "controller_submit") return "input";
  if (method === "controller_sample") return "sample";
  if (method === "controller_heartbeat") return "heartbeat";
  return "ordinary";
}
interface Pending {
  lane: ControlLane;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  receipt?: NativeRequestReceipt;
  timing: Omit<
    NativeRequestSpan,
    | "request_id"
    | "ended_monotonic_ms"
    | "status"
    | "observation_seq"
    | "native_timing"
  >;
}
interface NativeRequestReceipt {
  request_id: number | null;
  requested_host_monotonic_ms: number | null;
  responded_host_monotonic_ms: number | null;
}
type ObservationAuthorityFence =
  | "binding"
  | "world_id"
  | "epoch"
  | "session_id"
  | "life_id_regressed"
  | "life_status_regressed"
  | "space_epoch_regressed"
  | "screen_identity";
interface OwnedEffect {
  effect: EffectEnvelope;
  generation: number;
}

/** Concrete Minecraft transport; generic Runtime sees only negotiated envelopes and adapter registration. */
export class GameBridgeClient implements GameBridge {
  private readonly launcher: MinecraftClient;
  private readonly options: NativeOptions;
  private owned: NativeProcess | null = null;
  private control: Socket | null = null;
  private videoSocket: Socket | null = null;
  private servers: Server[] = [];
  private pending = new Map<number, Pending>();
  private pendingCounts: Record<ControlLane, number> = {
    ordinary: 0,
    input: 0,
    sample: 0,
    heartbeat: 0,
    retirement: 0,
  };
  private sequence = 0;
  private generation = 1;
  private listeners = new Set<(notice: BridgeNotice) => void>();
  private frameListeners = new Set<(frame: Uint8Array) => void>();
  private frame: Buffer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private closing: Promise<void> | null = null;
  private neutralizing: Promise<void> | null = null;
  private emergencyStopping: Promise<void> | null = null;
  private cancellationBarrierPending: Promise<void> | null = null;
  private frameStarted = 0;
  private nativeMetrics: Json = null;
  private readonly controlTimeline = new NativeControlTimeline();
  private connectionAbort: AbortController | null = null;
  private connecting = false;
  private launching: Promise<NativeProcess> | null = null;
  private registration: RegisteredAdapterContract | null = null;
  private runtimeAdapter: RuntimeAdapter | null = null;
  private expectedDescriptor: AdapterDescriptor | null = null;
  private schemas: AdapterSchemaCatalog | null = null;
  private prepared: NativeArtifactContract | null = null;
  private ownedEffect: OwnedEffect | null = null;
  private controller: NativeControllerChannel | null = null;
  private controllerReservation: ControllerReservation | null = null;
  private controllerOpening: Promise<NativeControllerChannel> | null = null;
  private controllerProgress: Json = null;
  private motorProfile: MotorProfile = "balanced";
  private scopeNoticeSeen = false;
  private scopeNoticeGeneration: number | null = null;
  private state: GameState = {
    status: "disconnected",
    username: "",
    version: "1.21.4",
    world_id: null,
    epoch: 0,
    session_id: null,
    life: null,
    binding: null,
    space: null,
    screen: null,
    presentation: null,
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
    error: null,
  };

  constructor(
    private readonly projectRoot = process.cwd(),
    options: NativeOptions = {},
  ) {
    this.options = options;
    this.launcher = new MinecraftClient(projectRoot, options);
  }
  adapter() {
    return this.state.binding?.ready ? this.runtimeAdapter : null;
  }
  /** Artifact/schema knowledge only; this neither joins a player nor establishes native authority. */
  async prepareExecutableContract(): Promise<PreparationContract> {
    const assertDisconnected = () => {
      if (this.connecting || this.owned || this.closing || this.state.status !== "disconnected" ||
        this.options.descriptor !== undefined)
        throw new Error("Prejoin source preparation requires an idle disconnected native client and actual installed artifact");
    };
    assertDisconnected();
    const { actual, adapter } = await this.readExecutableContract();
    assertDisconnected();
    return { adapter, artifact_sha256: actual.artifact_sha256 };
  }
  performanceMetrics() {
    return {
      native: this.nativeMetrics,
      video: { ...this.state.video },
      control_timeline: this.controlTimeline.snapshot(),
      controller_progress: this.controllerProgress,
    };
  }
  subscribeControlTiming(
    listener: Parameters<NativeControlTimeline["subscribe"]>[0],
  ) {
    return this.controlTimeline.subscribe(listener);
  }
  snapshot(): GameState {
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
  private ensureProvidedRegistration() {
    if (this.registration) return;
    const schemas = this.options.schemas;
    if (this.options.descriptor === undefined || !schemas)
      throw new Error("Native contract has not been prepared");
    this.expectedDescriptor = adapterDescriptorSchema.parse(
      this.options.descriptor,
    );
    this.schemas = schemas;
    this.runtimeAdapter = this.options.adapter ?? null;
    this.registration = new RegisteredAdapterContract(
      this.expectedDescriptor,
      schemas,
      this.runtimeAdapter?.capabilityValidators,
    );
  }
  private async prepareRegistration() {
    if (this.options.descriptor !== undefined) {
      this.ensureProvidedRegistration();
      return;
    }
    const { actual, adapter } = await this.readExecutableContract();
    this.prepared = actual;
    this.expectedDescriptor = adapter.descriptor;
    this.schemas = adapter.schemas;
    this.runtimeAdapter = adapter;
    this.registration = new RegisteredAdapterContract(
      adapter.descriptor, adapter.schemas, adapter.capabilityValidators,
    );
  }
  private async readExecutableContract() {
    const artifact = path.join(
      this.projectRoot,
      "native/minecraft/build/libs/gameharness-native-1.0.0.jar",
    );
    const actual = await readNativeArtifactContract(artifact);
    const resource = await assertNativeContractFresh(
      this.projectRoot,
      actual.resource,
    );
    const descriptor = structuredClone(resource.descriptor);
    descriptor.observation.profile.configuration =
      minecraftProfileConfiguration(this.motorProfile);
    descriptor.observation.profile.configuration_hash = contractHash(
      descriptor.observation.profile.configuration,
    );
    return { actual, adapter: createMinecraftAdapter(descriptor) };
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
    let authorized = false,
      authenticated = false,
      text = Buffer.alloc(0);
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
      const receivedAt = performance.now();
      try {
        if (!authorized) {
          text = Buffer.concat([text, chunk]);
          const end = text.indexOf(10);
          if (end < 0) {
            if (text.length > ADAPTER_NEGOTIATION_LIMITS.hello_bytes)
              socket.destroy();
            return;
          }
          if (end > ADAPTER_NEGOTIATION_LIMITS.hello_bytes)
            throw new Error("Oversized native handshake");
          const raw = JSON.parse(text.subarray(0, end).toString("utf8")),
            session = this.owned?.session;
          const secret = Buffer.from(String(raw.secret)),
            expected = Buffer.from(session?.secret ?? "");
          if (
            !session ||
            secret.length !== expected.length ||
            !timingSafeEqual(secret, expected) ||
            raw.world_id !== session.world_id ||
            raw.epoch !== session.epoch ||
            raw.session_id !== session.session_id
          )
            throw new Error("Native authentication rejected");
          authenticated = true;
          const hello = nativeHelloSchema.parse(raw);
          this.ensureProvidedRegistration();
          const bound = bindNativeDescriptor(
            hello,
            this.expectedDescriptor!,
            this.schemas!,
          );
          if (
            this.state.binding &&
            (this.state.binding.native_boot_id !== bound.native_boot_id ||
              this.state.binding.compatibility_hash !==
                bound.compatibility_hash)
          )
            throw new Error("Native control/video bindings disagree");
          if (kind === "control" ? this.control : this.videoSocket)
            throw new Error("Duplicate native channel");
          this.state = {
            ...this.state,
            binding: bound,
            version: bound.descriptor.game.version,
          };
          authorized = true;
          socket.setTimeout(kind === "control" ? 15000 : 120000);
          if (kind === "control") {
            this.control = socket;
            this.controlTimeline.bindBoot(bound.native_boot_id);
          } else this.videoSocket = socket;
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
            this.receiveNotice(message.notice);
            continue;
          }
          if ("controller_effect" in message) {
            const { owner, ...update } = message.controller_effect;
            this.controller?.acceptEffect(owner, update);
            continue;
          }
          if ("controller_progress" in message) {
            const { owner, ...progress } = message.controller_progress,
              channel = this.controller;
            if (
              channel &&
              owner.operation_id === channel.owner.operation_id &&
              owner.generation === channel.owner.generation &&
              sameEffectScope(owner.scope, channel.owner.scope) &&
              progress.controller_generation === channel.controllerGeneration
            )
              this.controllerProgress = {
                ...progress,
                received_host_ms: receivedAt,
                input_or_effect_confirmation: false,
              };
            continue;
          }
          const pending = this.pending.get(message.id);
          if (!pending) throw new Error("Uncorrelated native response");
          if (
            message.timing?.controller_opportunities &&
            message.timing.controller_opportunities.identity.native_boot_id !==
              pending.timing.native_boot_id
          )
            throw new Error(
              "Native opportunity trace has stale boot authority",
            );
          this.pending.delete(message.id);
          this.pendingCounts[pending.lane]--;
          clearTimeout(pending.timer);
          if (pending.receipt)
            pending.receipt.responded_host_monotonic_ms = receivedAt;
          const data =
            message.ok &&
            message.data !== null &&
            typeof message.data === "object"
              ? (message.data as Record<string, unknown>)
              : null;
          this.finishTiming(
            message.id,
            pending,
            message.ok ? "ok" : "error",
            receivedAt,
            message.timing ?? null,
            typeof data?.observation_seq === "number" &&
              Number.isSafeInteger(data.observation_seq) &&
              data.observation_seq >= 0
              ? data.observation_seq
              : null,
          );
          if (message.ok) pending.resolve(message.data);
          else pending.reject(new NativeRequestFault("native_rejected", pending.timing.method, message.id,
            "dispatched", message.error, message.timing ?? null));
        }
      } catch {
        socket.destroy();
        if (authorized || authenticated)
          void this.terminate(
            "Native negotiation, framing or authority failed.",
            { status: "protocol_invalid", requestId: null },
          );
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
  private receiveNotice(notice: z.infer<typeof noticeSchema>) {
    const session = this.owned?.session,
      binding = this.state.binding;
    if (
      !session ||
      notice.session_id !== session.session_id ||
      notice.world_id !== session.world_id ||
      notice.epoch !== session.epoch
    )
      return;
    if (!binding || notice.native_boot_id !== binding.native_boot_id)
      throw new Error("Native notice has stale boot authority");
    const previous = this.state.life;
    if (
      (previous && notice.life.life_id < previous.life_id) ||
      (this.state.space &&
        notice.space &&
        notice.space.space_epoch < this.state.space.space_epoch)
    )
      return;
    this.generation = Math.max(this.generation, notice.generation);
    this.scopeNoticeSeen = true;
    this.scopeNoticeGeneration = notice.generation;
    this.state = {
      ...this.state,
      life: notice.life,
      space: notice.space,
      screen: notice.screen,
    };
    const died =
      notice.life.status === "dead" &&
      (!previous ||
        previous.status === "alive" ||
        previous.status === "loading" ||
        previous.life_id !== notice.life.life_id);
    this.emit({
      type: "game_event",
      data: {
        ...notice,
        type: died ? "death" : notice.type,
        summary: died
          ? "Player life ended; native inputs are fenced and the owned session remains available."
          : "Authoritative native scope changed.",
      },
    });
    this.emit({ type: "state", data: this.snapshot() });
  }
  private onFrame(frame: Buffer) {
    this.frame = frame;
    const now = Date.now();
    if (!this.frameStarted) {
      this.frameStarted = now;
      this.videoSocket?.setTimeout(10000);
    }
    const previous = this.state.video;
    this.state = {
      ...this.state,
      video: {
        status: "streaming",
        width: frame.readUInt32LE(4),
        height: frame.readUInt32LE(8),
        fps:
          now - this.frameStarted >= 1000
            ? ((previous.frames + 1) * 1000) / (now - this.frameStarted)
            : null,
        frames: previous.frames + 1,
        last_frame_at: new Date(frame.readDoubleLE(24)).toISOString(),
        error: null,
      },
    };
    if (previous.status !== "streaming")
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
    receipt?: NativeRequestReceipt,
  ): Promise<unknown> {
    const socket = this.control,
      binding = this.state.binding;
    if (!socket || socket.destroyed || !binding?.ready)
      return Promise.reject(
        new NativeRequestFault("not_dispatched", method, null, "not_dispatched", "Negotiated native control is unavailable."),
      );
    const lane = controlLane(method);
    if (
      this.pendingCounts[lane] >= laneLimits[lane] ||
      this.sequence >= Number.MAX_SAFE_INTEGER
    )
      return Promise.reject(
        new NativeRequestFault("not_dispatched", method, null, "not_dispatched", "Native request identity/lane bound reached."),
      );
    const id = this.sequence + 1;
    let packet: Buffer;
    try {
      packet = Buffer.from(
        JSON.stringify({
          id,
          method,
          params,
          world_id: this.state.world_id,
          epoch: this.state.epoch,
          generation: this.generation,
          native_boot_id: binding.native_boot_id,
          session_id: this.owned?.session.session_id ?? this.state.session_id,
        }) + "\n",
      );
    } catch {
      return Promise.reject(new NativeRequestFault("not_dispatched", method, null, "not_dispatched",
        "Native request serialization failed before dispatch."));
    }
    const bound = lane === "retirement" ? 1024 * 1024 : 1024 * 1024 - 4096;
    if (
      packet.length > (lane === "retirement" ? 4096 : 65536) ||
      socket.writableLength + packet.length > bound
    )
      return Promise.reject(
        new NativeRequestFault("not_dispatched", method, null, "not_dispatched", "Native request byte bound reached; no input was submitted."),
      );
    this.sequence = id;
    const reply = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      void this.terminate("Native operation deadline expired.", { status: "request_timeout", requestId: id });
    }, timeout);
    const effect =
      method === "execute"
        ? (params as EffectEnvelope)
        : method.startsWith("controller_")
          ? this.controllerReservation
          : null;
    this.pendingCounts[lane]++;
    const started = performance.now();
    if (receipt) {
      receipt.request_id = id;
      receipt.requested_host_monotonic_ms = started;
    }
    this.pending.set(id, {
      lane,
      resolve: reply.resolve,
      reject: reply.reject,
      timer,
      receipt,
      timing: {
        method,
        operation_id: effect?.operation_id ?? null,
        run_id: effect?.scope.run_id ?? null,
        execution_id: effect?.scope.execution_id ?? null,
        source_hash: effect?.scope.source_hash ?? null,
        native_boot_id: binding.native_boot_id,
        started_monotonic_ms: started,
      },
    });
    try {
      socket.write(packet, (error) => {
        if (error) void this.terminate("Native request write failed.", { status: "write_failed", requestId: id });
      });
    } catch {
      void this.terminate("Native request write failed.", { status: "write_failed", requestId: id });
    }
    return reply.promise;
  }
  private finishTiming(
    id: number,
    pending: Pending,
    status: NativeRequestSpan["status"],
    ended: number,
    nativeTiming: NativeControlTiming | null,
    observationSeq: number | null = null,
  ) {
    this.controlTimeline.record({
      ...pending.timing,
      request_id: id,
      ended_monotonic_ms: ended,
      status,
      observation_seq: observationSeq,
      native_timing: nativeTiming,
    });
  }
  async connect(config: BridgeConnection) {
    if (this.connecting)
      throw new Error("A native connection is already in progress.");
    this.connecting = true;
    await this.disconnect();
    const controller = new AbortController();
    this.connectionAbort = controller;
    this.generation = 1;
    this.sequence = 0;
    this.frame = null;
    this.frameStarted = 0;
    this.nativeMetrics = null;
    this.controlTimeline.bindBoot(null);
    this.scopeNoticeSeen = false;
    this.scopeNoticeGeneration = null;
    this.state = {
      ...this.state,
      status: "connecting",
      world_id: config.world_id,
      epoch: safeCounterSchema.parse(config.epoch),
      session_id: null,
      life: null,
      binding: null,
      space: null,
      screen: null,
      presentation: null,
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
    if (config.motor_profile)
      this.motorProfile = motorProfileSchema.parse(config.motor_profile);
    this.emit({ type: "state", data: this.snapshot() });
    try {
      await this.prepareRegistration();
      controller.signal.throwIfAborted();
      if (config.version !== this.expectedDescriptor!.game.version)
        throw new Error(
          "Requested game version does not match the actual native build",
        );
      const [controlPort, videoPort] = await Promise.all([
        this.listener("control"),
        this.listener("video"),
      ]);
      const launching = this.launcher.launch(
        { ...config, motor_profile: this.motorProfile },
        controlPort,
        videoPort,
        controller.signal,
        this.prepared ?? undefined,
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
      let observed = false;
      while (
        Date.now() < deadline &&
        this.owned === owned &&
        !controller.signal.aborted
      ) {
        if (this.control) {
          try {
            const current = await this.observe();
            // Joining can report an alive player before vanilla closes its loading screen.
            if (
              (current.life.status === "alive" && current.screen === null) ||
              current.life.status === "dead"
            ) {
              observed = true;
              break;
            }
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
          `Authenticated Minecraft player did not join the private server.${owned.diagnostics.length ? ` Launch categories: ${owned.diagnostics.join(", ").slice(0, 300)}` : ""}`,
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
      const message =
        error instanceof Error
          ? error.message
          : "Native Minecraft launch failed.";
      await this.terminate(message);
      throw new Error(message);
    } finally {
      this.connecting = false;
    }
  }
  async observe() {
    const started = performance.now();
    try {
      if (!this.state.binding || !this.registration)
        throw new Error("Native observation binding is unavailable.");
      const receipt: NativeRequestReceipt = {
        request_id: null,
        requested_host_monotonic_ms: null,
        responded_host_monotonic_ms: null,
      };
      const observation = this.registration.parseObservation(
        await this.request("observe", {}, 10000, receipt),
      );
      let current;
      try {
        current = assertActiveObservation(observation, this.state.binding);
      } catch (error) {
        this.emitObservationRejection(observation, receipt, "binding");
        throw error;
      }
      // Preserve short-circuit order: later fences are not evaluated for diagnostics.
      let failedFence: ObservationAuthorityFence | null = null;
      if (current.world_id !== this.state.world_id) failedFence = "world_id";
      else if (current.epoch !== this.state.epoch) failedFence = "epoch";
      else if (current.session_id !== this.owned?.session.session_id)
        failedFence = "session_id";
      else if (
        this.state.life &&
        current.life.life_id < this.state.life.life_id
      )
        failedFence = "life_id_regressed";
      else if (
        this.state.life &&
        current.life.life_id === this.state.life.life_id &&
        current.life.status === "alive" &&
        this.state.life.status !== "alive"
      )
        failedFence = "life_status_regressed";
      else if (
        this.state.space &&
        current.space.space_epoch < this.state.space.space_epoch
      )
        failedFence = "space_epoch_regressed";
      else if (
        this.scopeNoticeSeen &&
        !sameScreen(current.screen, this.state.screen)
      )
        failedFence = "screen_identity";
      if (failedFence) {
        this.emitObservationRejection(current, receipt, failedFence);
        throw new Error("Native observation has stale authority.");
      }
      const presentation = this.runtimeAdapter
        ? this.runtimeAdapter.projectObservation(current)
        : {
            state: current.data,
            summary: "Registered adapter observation",
            metadata: {
              payload_schema_id:
                this.state.binding.descriptor.observation.payload_schema.id,
            },
          };
      this.state = {
        ...this.state,
        life: current.life,
        space: current.space,
        screen: current.screen,
        session_id: current.session_id,
        last_observation_at: current.captured_at,
        presentation,
      };
      this.emit({ type: "observation", data: current });
      return current;
    } finally {
      try {
        this.options.onTiming?.(
          "observation_read_ms",
          performance.now() - started,
        );
      } catch {}
    }
  }
  private emitObservationRejection(
    observation: { observation_seq: number; captured_at: string },
    receipt: NativeRequestReceipt,
    failedFence: ObservationAuthorityFence,
  ) {
    this.emit({
      type: "game_event",
      data: {
        type: "observation_authority_rejected",
        schema_version: 1,
        first_failed_fence: failedFence,
        request_id: receipt.request_id,
        requested_host_monotonic_ms: receipt.requested_host_monotonic_ms,
        responded_host_monotonic_ms: receipt.responded_host_monotonic_ms,
        observation_seq: observation.observation_seq,
        observation_captured_at: new Date(observation.captured_at).toISOString(),
        scope_notice_generation: this.scopeNoticeGeneration,
      },
    });
  }
  async queryCapability(
    id: string,
    version: number,
    args: Json,
  ): Promise<Json> {
    if (
      !this.registration ||
      version !== (id === "minecraft.controller_frame" ? 2 : 1) ||
      (id !== "minecraft.recipes" &&
        id !== "minecraft.visible_screen" &&
        id !== "minecraft.controller_frame")
    )
      throw new Error(
        "The selected adapter does not implement this read capability.",
      );
    const parsed = this.registration.parseCapability(id, version, args);
    if (id === "minecraft.visible_screen")
      return visibleScreenSnapshotSchema
        .nullable()
        .parse(await this.request("visible_screen", parsed));
    if (id === "minecraft.controller_frame")
      return await this.readControllerFrame(() =>
        this.request("controller_frame", parsed),
      );
    return jsonSchema.parse(await this.request("recipes", parsed));
  }
  private async readControllerFrame(read: () => Promise<unknown>) {
    const binding = this.state.binding,
      life = this.state.life,
      space = this.state.space,
      screen = this.state.screen;
    const session = this.state.session_id,
      world = this.state.world_id,
      epoch = this.state.epoch;
    if (!binding?.ready || !life || !space)
      throw new Error("Current controller feedback authority is unavailable.");
    const frame = minecraftControllerFrameSchema.parse(await read());
    const current = this.state.binding;
    if (
      !current?.ready ||
      current.native_boot_id !== binding.native_boot_id ||
      current.compatibility_hash !== binding.compatibility_hash ||
      this.state.session_id !== session ||
      this.state.world_id !== world ||
      this.state.epoch !== epoch ||
      this.state.life?.life_id !== life.life_id ||
      this.state.space?.dimension_id !== space.dimension_id ||
      this.state.space.space_epoch !== space.space_epoch ||
      frame.profile_id !== current.descriptor.observation.profile.id ||
      frame.profile_version !==
        current.descriptor.observation.profile.version ||
      frame.life_id !== life.life_id ||
      frame.space.dimension_id !== space.dimension_id ||
      frame.space.space_epoch !== space.space_epoch
    )
      throw new Error(
        "Controller feedback has stale profile or life/space authority.",
      );
    if (
      this.state.screen?.screen_id !== screen?.screen_id ||
      this.state.screen?.incarnation !== screen?.incarnation ||
      frame.screen?.identity.screen_id !== this.state.screen?.screen_id ||
      frame.screen?.identity.incarnation !== this.state.screen?.incarnation
    )
      throw new Error(
        "Controller feedback has stale or unavailable screen authority.",
      );
    return frame;
  }
  private assertControllerScope(reservation: ControllerReservation) {
    const scope = reservation.scope,
      binding = this.state.binding;
    if (
      !binding?.ready ||
      reservation.compatibility_hash !== binding.compatibility_hash ||
      scope.native_boot_id !== binding.native_boot_id ||
      scope.session_id !== this.state.session_id ||
      scope.world_id !== this.state.world_id ||
      scope.epoch !== this.state.epoch ||
      scope.life_id !== this.state.life?.life_id ||
      scope.space_epoch !== this.state.space?.space_epoch ||
      this.state.life.status !== "alive"
    )
      throw new Error(
        "Controller reservation no longer matches current native authority.",
      );
  }
  openController(
    reservation: ControllerReservation,
    controllerGeneration: number,
    deadlineHostMs: number,
    applied: (ack: InputAppliedAck) => void,
    effect: (update: ControllerEffectUpdate) => void,
  ): Promise<ControllerInputChannel> {
    const parsed = controllerReservationSchema.parse(reservation);
    if (
      this.ownedEffect ||
      this.controllerReservation ||
      this.controllerOpening ||
      this.neutralizing
    )
      throw new Error("The sole native writer has not retired.");
    this.assertControllerScope(parsed);
    if (!screenPreconditionMatches(parsed.expected_screen, this.state.screen))
      throw new Error("Controller initial screen authority differs.");
    safeCounterSchema.min(1).parse(controllerGeneration);
    const clock = this.controlTimeline.currentCorrespondence();
    const deadline = controllerNativeDeadline(clock, deadlineHostMs);
    const owner = {
      operation_id: parsed.operation_id,
      scope: parsed.scope,
      generation: this.generation,
    };
    this.controllerReservation = parsed;
    const opening = (async () => {
      try {
        const result = z
          .object({
            owner: expectedEffectOwnerSchema,
            controller_generation: safeCounterSchema.min(1),
          })
          .strict()
          .parse(
            await this.request(
              "controller_open",
              {
                owner,
                compatibility_hash: parsed.compatibility_hash,
                invocation: parsed.invocation,
                expected_screen: parsed.expected_screen,
                controller_generation: controllerGeneration,
                deadline_native_ns: deadline,
                clock_uncertainty_ms: clock!.uncertainty_ms,
              },
              2000,
            ),
          );
        this.assertControllerScope(parsed);
        if (
          result.owner.operation_id !== owner.operation_id ||
          result.owner.generation !== owner.generation ||
          !sameEffectScope(result.owner.scope, owner.scope) ||
          result.controller_generation !== controllerGeneration
        )
          throw new Error(
            "Controller native admission ACK differs from its immutable reservation.",
          );
        const channel = new NativeControllerChannel(
          owner,
          controllerGeneration,
          deadlineHostMs,
          {
            request: (method, params, timeout) =>
              this.request(method, params, timeout),
            sample: (params) =>
              this.readControllerFrame(() =>
                this.request("controller_sample", params, 2000),
              ),
            clock: () => this.controlTimeline.currentCorrespondence(),
            retirementTiming: () => {
              const samples = this.controlTimeline.snapshot().samples;
              for (let index = samples.length - 1; index >= 0; index--) {
                const sample = samples[index]!, lease = sample.native_timing?.controller_lease;
                if (sample.method === "controller_revoke" && lease?.owner.operation_id === owner.operation_id &&
                  lease.owner.generation === owner.generation && lease.controller_generation === controllerGeneration)
                  return sample.native_timing;
              }
              return null;
            },
            applicationEvidence: sequence => {
              const samples = this.controlTimeline.snapshot().samples;
              for (let index = samples.length - 1; index >= 0; index--) {
                const sample = samples[index]!;
                const application = sample.native_timing?.controller_application;
                if (sample.method === "controller_submit" && sample.native_timing?.clock_id === owner.scope.native_boot_id &&
                  application?.sequence === sequence && application.controller_generation === controllerGeneration &&
                  application.owner.operation_id === owner.operation_id && application.owner.generation === owner.generation &&
                  sameEffectScope(application.owner.scope, owner.scope))
                  return { request_id: sample.request_id, timing: sample.native_timing };
              }
              return null;
            },
            assertCurrent: () => {
              if (
                this.controller !== channel ||
                this.controllerReservation !== parsed
              )
                throw new Error("Controller owner has retired.");
              this.assertControllerScope(parsed);
            },
            retired: (_ack, generation) => {
              if (
                this.controller !== channel ||
                this.controllerReservation !== parsed
              )
                throw new Error(
                  "Old controller retirement cannot release a replacement owner.",
                );
              this.generation = Math.max(this.generation, generation);
              this.controller = null;
              this.controllerReservation = null;
            },
            failed: () =>
              this.terminate(
                "Controller retirement is uncertain; its emitter is closed, never replayed.",
              ),
          },
          applied,
          effect,
        );
        this.controller = channel;
        return channel;
      } catch (error) {
        await this.terminate(
          "Controller admission is uncertain; its emitter is closed, never replayed.",
        );
        throw error;
      } finally {
        this.controllerOpening = null;
      }
    })();
    this.controllerOpening = opening;
    return opening;
  }
  async setMotorProfile(profile: MotorProfile) {
    const parsed = motorProfileSchema.parse(profile);
    if (this.control) {
      const response = z
        .object({
          profile: z.literal(parsed),
          descriptor: adapterDescriptorSchema,
        })
        .strict()
        .parse(await this.request("motor_profile", { profile: parsed }, 5000));
      const expected = structuredClone(this.expectedDescriptor!);
      expected.observation.profile.configuration =
        minecraftProfileConfiguration(parsed);
      expected.observation.profile.configuration_hash = contractHash(
        expected.observation.profile.configuration,
      );
      const compatible = negotiateAdapterDescriptor(
        expected,
        response.descriptor,
        this.schemas!,
      );
      this.runtimeAdapter = createMinecraftAdapter(compatible.descriptor);
      this.expectedDescriptor = compatible.descriptor;
      this.registration = new RegisteredAdapterContract(
        compatible.descriptor,
        this.schemas!,
        this.runtimeAdapter.capabilityValidators,
      );
      this.state = {
        ...this.state,
        binding: {
          ...compatible,
          ready: true,
          native_boot_id: this.state.binding!.native_boot_id,
        },
      };
    }
    this.motorProfile = parsed;
    this.emit({ type: "state", data: this.snapshot() });
  }
  async execute(
    value: EffectEnvelope,
    signal: AbortSignal,
  ): Promise<GameActionResult> {
    const parsed = effectSchema.safeParse(value),
      binding = this.state.binding;
    if (signal.aborted)
      return {
        status: "cancelled",
        summary: "Cancelled before dispatch.",
        evidence: { effect_confirmed: false, neutralized_effect: false },
      };
    if (
      !parsed.success ||
      !binding?.ready ||
      !this.registration ||
      this.ownedEffect ||
      this.controllerReservation ||
      parsed.data.compatibility_hash !== binding.compatibility_hash ||
      parsed.data.scope.native_boot_id !== binding.native_boot_id ||
      parsed.data.scope.session_id !== this.state.session_id ||
      parsed.data.scope.world_id !== this.state.world_id ||
      parsed.data.scope.epoch !== this.state.epoch ||
      parsed.data.scope.life_id !== this.state.life?.life_id ||
      parsed.data.scope.space_epoch !== this.state.space?.space_epoch ||
      !screenPreconditionMatches(parsed.data.expected_screen, this.state.screen)
    )
      return {
        status: "failed",
        summary:
          "The effect does not match current negotiated native authority.",
        evidence: { effect_confirmed: false, neutralized_effect: false },
      };
    let effect = parsed.data,
      ordinaryDeadline: number | null = null;
    try {
      const action = minecraftActionSchema.parse(
        this.registration.parseCapability("minecraft.action", 4, effect.action),
      );
      if (action.kind === "world_input") {
        if (
          effect.expected_screen.kind !== "absent" ||
          this.state.screen !== null
        )
          return {
            status: "failed",
            summary:
              "Ordinary world input requires no open screen and explicit absent screen authority.",
            evidence: { effect_confirmed: false, neutralized_effect: false },
          };
        ordinaryDeadline =
          action.steps.reduce((ticks, step) => ticks + step.ticks, 0) * 50 +
          3000;
      }
      if (action.kind === "screen_input") {
        if (
          effect.expected_screen.kind !== "layout" ||
          effect.expected_screen.screen.screen_id !== action.screen.screen_id ||
          effect.expected_screen.screen.incarnation !==
            action.screen.incarnation ||
          effect.expected_screen.screen.layout_revision !==
            action.screen.layout_revision
        )
          return {
            status: "failed",
            summary: "GUI input requires its exact layout precondition.",
            evidence: { effect_confirmed: false, neutralized_effect: false },
          };
        ordinaryDeadline = 5000 + 4000 * action.operations.length;
      } else if (effect.expected_screen.kind === "layout") {
        return {
          status: "failed",
          summary: "Only visible GUI input may select layout authority.",
          evidence: { effect_confirmed: false, neutralized_effect: false },
        };
      }
      effect = { ...effect, action };
    } catch {
      return {
        status: "failed",
        summary: "The action does not match its registered adapter capability.",
        evidence: { effect_confirmed: false, neutralized_effect: false },
      };
    }
    const owned: OwnedEffect = { effect, generation: this.generation };
    this.ownedEffect = owned;
    const started = performance.now();
    let cancelling: Promise<void> | null = null;
    const abort = () => {
      cancelling = this.cancel("Action cancelled.", {
        operation_id: effect.operation_id,
        scope: effect.scope,
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      // Ordinary input has a short native tick/wall bound and a finite receipt
      // drain, never the legacy helper floor. A lost ACK closes the emitter;
      // it is not proof that the stalled client thread neutralized its inputs.
      const deadline =
        ordinaryDeadline ??
        Math.max(
          45000,
          (this.runtimeAdapter?.effectDeadlineMs(effect.action) ?? 40000) +
            5000,
        );
      const reply = effectReplySchema.parse(
        await this.request("execute", effect, deadline),
      );
      if (
        reply.operation_id !== effect.operation_id ||
        reply.compatibility_hash !== effect.compatibility_hash ||
        !sameEffectScope(reply.scope, effect.scope)
      )
        throw new Error("Native effect receipt has stale authority");
      if (cancelling) await cancelling;
      return reply.result;
    } catch {
      await this.terminate(
        "Native action acknowledgement was lost or mismatched.",
      );
      return {
        status: "unknown",
        summary:
          "Action outcome is unknown; its emitter was closed, never replayed or treated as effect confirmation.",
        evidence: { effect_confirmed: false, neutralized_effect: false },
        requires_reconnect: true,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.ownedEffect === owned) this.ownedEffect = null;
      try {
        this.options.onTiming?.(
          "action_round_trip_ms",
          performance.now() - started,
        );
      } catch {}
    }
  }
  async superviseProducer(executionId: string, supervision: ProducerSupervision): Promise<boolean> {
    const owned = this.ownedEffect;
    if (!owned || owned.effect.scope.execution_id !== executionId) return false;
    const expected = owned.effect.supervision;
    if (!expected || expected.session_id !== supervision.session_id ||
      expected.behavior_generation !== supervision.behavior_generation)
      throw new Error("Semantic supervision cannot adopt another producer or source generation");
    const response = z.object({ renewed: z.boolean(), lease_deadline_native_ns: nativeNanosecondsSchema.nullable() }).strict()
      .parse(await this.request("producer_supervise", { owner: { operation_id: owned.effect.operation_id,
        scope: owned.effect.scope, generation: owned.generation }, ...supervision }, 1000));
    if (response.renewed && this.ownedEffect === owned) owned.effect.supervision = { ...supervision };
    return response.renewed;
  }
  async neutralize(owner: EffectOwnerRef) {
    if (!owner)
      throw new Error(
        "Expected native operation owner is required; no global cleanup alias exists.",
      );
    const reservation = this.controllerReservation;
    if (
      reservation?.operation_id === owner.operation_id &&
      sameEffectScope(reservation.scope, owner.scope)
    ) {
      const channel = this.controller ?? (await this.controllerOpening);
      if (channel) await channel.revoke();
      return;
    }
    const active = this.ownedEffect;
    if (
      !active ||
      active.effect.operation_id !== owner.operation_id ||
      !sameEffectScope(active.effect.scope, owner.scope)
    )
      return;
    if (this.neutralizing) return this.neutralizing;
    const barrier = this.cancellationBarrier({
      expected_owner: {
        operation_id: owner.operation_id,
        scope: owner.scope,
        generation: active.generation,
      },
    });
    this.neutralizing = barrier;
    try {
      await barrier;
    } finally {
      if (this.neutralizing === barrier) this.neutralizing = null;
    }
  }
  private async cancellationBarrier(
    params:
      | { emergency: true }
      | { expected_owner: EffectOwnerRef & { generation: number } },
  ) {
    const previous = this.cancellationBarrierPending,
      owned = this.owned,
      control = this.control;
    // Native has one reserved retirement slot through its drained ACK.
    // Callers coalesce to one owner cancellation and one emergency Stop;
    // serialize that bounded pair without restarting the predecessor's timer.
    const barrier = (async () => {
      if (previous) await previous;
      if (
        !owned ||
        this.owned !== owned ||
        !control ||
        this.control !== control ||
        control.destroyed
      )
        throw new Error(
          "Native input barrier is unavailable; no neutralization proof exists.",
        );
      const minimum = this.generation;
      const ack = z
        .object({
          neutralized: z.literal(true),
          matched_owner: z.boolean(),
          generation: safeCounterSchema,
          session_id: identitySchema,
          life_id: safeCounterSchema,
        })
        .strict()
        .parse(await this.request("cancel", params, 5000));
      if (
        this.owned !== owned ||
        this.control !== control ||
        ack.session_id !== owned.session.session_id ||
        ack.generation < minimum ||
        (ack.matched_owner && ack.generation <= minimum) ||
        ("emergency" in params && !ack.matched_owner)
      )
        throw new Error("Native input barrier has stale authority.");
      this.generation = Math.max(this.generation, ack.generation);
    })();
    this.cancellationBarrierPending = barrier;
    try {
      await barrier;
    } finally {
      if (this.cancellationBarrierPending === barrier)
        this.cancellationBarrierPending = null;
    }
  }
  async cancel(_reason: string, owner: EffectOwnerRef) {
    // Expected-owner cleanup cannot claim closure while a prior terminal owner
    // is still draining, even when its control socket has already disappeared.
    if (!this.control && this.closing) {
      await this.closing;
      return;
    }
    try {
      await this.neutralize(owner);
    } catch {
      await this.terminate(
        "Native owner cancellation could not be acknowledged.",
      );
    }
  }
  async emergencyStop(_reason: string) {
    if (!this.control) {
      if (this.connecting || this.owned || this.closing || this.launching)
        await this.terminate();
      return;
    }
    if (this.controllerReservation) {
      try {
        const channel = this.controller ?? (await this.controllerOpening);
        if (channel) await channel.revoke();
      } catch {
        await this.terminate(
          "Native controller Stop could not be acknowledged.",
        );
      }
      return;
    }
    if (this.emergencyStopping) return this.emergencyStopping;
    const stopping = (async () => {
      try {
        await this.cancellationBarrier({ emergency: true });
      } catch {
        await this.terminate("Native emergency Stop could not be acknowledged.");
      }
    })();
    this.emergencyStopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.emergencyStopping === stopping) this.emergencyStopping = null;
    }
  }
  async disconnect() {
    await this.terminate();
  }
  private async terminate(error: string | null = null,
    initiating: { status: NativeRequestStatus; requestId: number | null } | null = null) {
    if (this.closing) return this.closing;
    this.connectionAbort?.abort();
    this.connectionAbort = null;
    const owned = this.owned;
    this.closing = (async () => {
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
      this.controller?.contained();
      const initiatingMethod = initiating?.requestId === null || !initiating ? null :
        this.pending.get(initiating.requestId)?.timing.method ?? null;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        this.finishTiming(id, pending, "unknown", performance.now(), null);
        pending.reject(new NativeRequestFault(initiating?.status ?? "transport_closed", pending.timing.method, id,
          "dispatched", error ?? "Native client emitter closed.", null, initiating?.requestId ?? null, initiatingMethod));
      }
      this.controlTimeline.bindBoot(null);
      this.pending.clear();
      for (const lane of Object.keys(this.pendingCounts) as ControlLane[])
        this.pendingCounts[lane] = 0;
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
      this.ownedEffect = null;
      this.controller = null;
      this.controllerReservation = null;
      this.controllerProgress = null;
      this.frame = null;
      const cause = this.state.error ?? error;
      this.state = {
        ...this.state,
        status: cause ? "error" : "disconnected",
        presentation: null,
        session_id: null,
        life: null,
        binding: null,
        space: null,
        screen: null,
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
