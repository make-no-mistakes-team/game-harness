import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { GameAction, GameActionResult, ObservationV3 } from "../shared/contracts.ts";
import type { NativeProcess } from "../server/minecraft-client.ts";
import { normalizeNativeEvaluation, type NativeEvaluationOptions } from "../server/native-evaluation.ts";
import type { GameBridgeClient } from "../server/game-bridge.ts";
import type { MinecraftServer } from "../server/minecraft-server.ts";
import type { EvaluationCaps } from "./contracts.ts";
import type { WorldConditions } from "./scenarios.ts";
import { minecraftObservationV3Schema, type MinecraftObservation, type MinecraftObservationData } from "../shared/minecraft.ts";
import { Store, type StoredRun } from "../server/store.ts";
import { ActionArbiter, type ActionArbiterHost } from "../server/action-arbiter.ts";
import { emptyRunUsage } from "../server/usage.ts";
import { jsonSchema } from "../shared/primitives.ts";
import { decodeNativeVideoHeader } from "../shared/video.ts";
import { DEFAULT_EVALUATION_CAPS } from "./config.ts";
import { evaluationPaths, type EvaluationPaths } from "./paths.ts";
import type { EffectScope } from "../shared/control.ts";
import type { ControllerEffectUpdate, ControllerInputChannel, InputAppliedAck } from "../shared/controller.ts";
import type { ResidentLifecycle } from "../shared/resident.ts";

export interface NativeControllerContext {
  execution_id: string;
  controller_generation: number;
  deadline_host_ms: number;
  open(applied: (ack: InputAppliedAck) => void, effect: (update: ControllerEffectUpdate) => void,
    lifecycle?: ResidentLifecycle): Promise<ControllerInputChannel>;
}

type OwnedServer = { child: ChildProcessWithoutNullStreams; ready: boolean; closed: Promise<void> };
const diagnosticsSchema = z.object({
  screen_type: z.string().nullable(), death_screen: z.boolean(), controls_neutral: z.boolean(),
  motor_active: z.boolean(), motor_tick_count: z.number(), motor_profile: z.enum(["precise", "balanced", "fast"]),
  max_yaw_degrees_per_second: z.number(), max_pitch_degrees_per_second: z.number(),
  yaw_acceleration_degrees_per_second_squared: z.number(), pitch_acceleration_degrees_per_second_squared: z.number(),
  camera_integration_clock: z.string(), yaw_velocity_degrees_per_second: z.number().optional(),
  pitch_velocity_degrees_per_second: z.number().optional(), target_yaw_degrees: z.number().optional(),
  target_pitch_degrees: z.number().optional(), route_points: z.number().optional(),
  navigation_left: z.boolean().optional(), navigation_right: z.boolean().optional(),
}).passthrough();
export type NativeDiagnostics = z.infer<typeof diagnosticsSchema>;
export interface NeutralPoseSample {
  elapsed_ms: number; position: MinecraftObservationData["player"]["position"]; yaw: number; diagnostics: NativeDiagnostics;
}
export interface FixtureIdentity {
  world_id: string; session_id: string; epoch: number; life_id: number;
  life_status: ObservationV3["life"]["status"]; health: number; pid: number | undefined;
  native_boot_id: string; space_epoch: number;
}
export const pause = (ms: number) => {
  const delay = Promise.withResolvers<void>();
  setTimeout(delay.resolve, ms);
  return delay.promise;
};
export function requireProof(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export async function bounded<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(message)), ms);
  try { return await Promise.race([work, deadline.promise]); }
  finally { clearTimeout(timer); }
}
export async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, ms: number, message: string): Promise<T> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const value = await bounded(read(), Math.max(1, end - performance.now()), message);
    if (accepts(value)) return value;
    await pause(50);
  }
  throw new Error(message);
}
export function wrap(angle: number) { return Math.atan2(Math.sin(angle), Math.cos(angle)); }
export function distance(a: MinecraftObservationData["player"]["position"], b: MinecraftObservationData["player"]["position"]) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
export function evidence(result: GameActionResult): Record<string, unknown> {
  requireProof(result.evidence && typeof result.evidence === "object" && !Array.isArray(result.evidence), "Native result lacks structured evidence");
  return result.evidence;
}
export interface NativeFixtureOptions {
  projectRoot?: string;
  evaluation?: NativeEvaluationOptions;
  paths?: Partial<EvaluationPaths>;
  caps?: EvaluationCaps;
  /** Existing GameHarness data root; only nonsecret provisioning consent is copied. */
  authDirectory?: string;
  /** Omitted only for explicitly synthetic technical diagnostics. */
  conditions?: WorldConditions;
  /** Trusted conformance label; exercises the actual checked Java long boundary. */
  initialEpoch?: number;
  /** Original caller-owned monotonic task deadline, including actual cleanup. */
  deadlineHostMs?: number;
  /** Original preparation deadline; never renewed by a nested startup stage. */
  preparationDeadlineHostMs?: number;
}

/** Evaluator-only infrastructure, never a gameplay/source library or model API.
 * Reuses the historical native proof's actual production owners and receipts.
 * Importing it does not load config: runtime imports must follow create().
 */
export class NativeFixture {
  readonly report: Record<string, unknown>;
  readonly cases: Array<Record<string, unknown>> = [];
  readonly clients: NativeProcess[] = [];
  readonly commands: Array<Record<string, unknown>> = [];
  readonly timeline: Array<Record<string, unknown>> = [];
  readonly evidenceDirectory: string;
  server!: MinecraftServer;
  bridge!: GameBridgeClient;
  frames = 0;
  private stoppedServer: number | null = null;
  private stoppedClient: NativeProcess | null = null;
  private controllerGeneration = 0;
  private closed = false;
  private closePromise: Promise<{ closed: boolean }> | null = null;
  private readonly startupOperations = new Set<Promise<unknown>>();
  private nativeArtifactHash: string | null = null;
  private diagnosticStore: Store | null = null;
  private diagnosticSource: string | null = null;
  private readonly evaluationSessions: Array<Readonly<NativeEvaluationOptions> | null> = [];
  private readonly detach: Array<() => void> = [];
  private constructor(readonly project: string, readonly root: string, readonly port: number,
    readonly caps: EvaluationCaps, private readonly authDirectory: string, private readonly conditions?: WorldConditions,
    private readonly initialEpoch = 1, private readonly evaluation: Readonly<NativeEvaluationOptions> | null = null,
    private readonly deadlineHostMs = Infinity, private readonly preparationDeadlineHostMs = Infinity) {
    this.evidenceDirectory = path.join(root, "evidence");
    this.report = { root, port, started_at: new Date().toISOString(), pass: false, cleanup: false,
      classification: conditions ? "natural_normal_survival_actual_model_acceptance" : "synthetic_caller_privileged_evaluator_infrastructure_not_model_gameplay",
      provider_calls: conditions ? null : 0, experience_promotions: 0,
      native_evaluation: { declared: evaluation, actual_sessions: this.evaluationSessions },
      credential_policy: "Only existing nonsecret provisioning consent is copied. Auth storage remains in place; no credentials enter Docker or reports.",
      unknown_flags: { real_provider_behavior_unmeasured: true, gameplay_efficacy_unmeasured: true,
        causal_speedup_unmeasured: true, framebuffer_text_not_ocr_verified: true, exact_respawn_wire_packet_count_unmeasured: true,
        native_third_party_stdout_not_captured_only_redacted_diagnostics: true, cross_process_durations_not_subtracted: true },
      cases: this.cases, console_commands: this.commands, timeline: this.timeline,
      artifacts: { private_runtime_root: root, compact_reports_are_separate: true, historical_artifacts_unchanged: true },
    };
  }
  static async create(name: string, options: NativeFixtureOptions = {}): Promise<NativeFixture> {
    requireProof(process.env.GAMEHARNESS_NATIVE_PROOF === "1", "Explicit native opt-in is required: GAMEHARNESS_NATIVE_PROOF=1");
    const evaluation = normalizeNativeEvaluation(options.evaluation ?? null, process.env.GAMEHARNESS_NATIVE_PROOF === "1");
    requireProof(!options.conditions || evaluation === null, "Natural fixtures cannot enable native evaluation");
    requireProof(/^[a-zA-Z0-9_-]{1,80}$/.test(name), "Native fixture name must be a bounded identifier");
    const project = path.resolve(options.projectRoot ?? process.cwd());
    const paths = evaluationPaths(project, options.paths);
    const authDirectory = path.resolve(options.authDirectory ?? process.env.GAMEHARNESS_EVALUATION_AUTH_DIR ?? process.env.GAMEHARNESS_DATA_DIR ?? path.join(project, "local/runtime"));
    const assertPreparation = () => requireProof(performance.now() < Math.min(options.deadlineHostMs ?? Infinity,
      options.preparationDeadlineHostMs ?? Infinity), "Original native preparation deadline reached");
    assertPreparation();
    await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    const root = path.join(paths.runtimeRoot, `${name}-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(root, { mode: 0o700 });
    await mkdir(path.join(root, "evidence"), { mode: 0o700 });
    assertPreparation();
    const reservation = createServer();
    const portReady = Promise.withResolvers<number>();
    reservation.once("error", portReady.reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      if (!address || typeof address === "string") { reservation.close(); portReady.reject(new Error("No ephemeral fixture port")); return; }
      reservation.close(error => error ? portReady.reject(error) : portReady.resolve(address.port));
    });
    const port = await portReady.promise;
    // Test/evaluator module-loading boundary: production config captures these at import.
    process.env.GAMEHARNESS_DATA_DIR = root;
    process.env.GAMEHARNESS_MINECRAFT_PORT = String(port);
    requireProof(Number.isSafeInteger(options.initialEpoch ?? 1) && (options.initialEpoch ?? 1) >= 0, "Native fixture epoch must be a nonnegative safe integer");
    const fixture = new NativeFixture(project, root, port, options.caps ?? DEFAULT_EVALUATION_CAPS, authDirectory, options.conditions, options.initialEpoch ?? 1, evaluation,
      options.deadlineHostMs, options.preparationDeadlineHostMs);
    await fixture.flush();
    return fixture;
  }
  private assertOpen() { requireProof(!this.closed, "Native fixture has closed"); }
  private assertPreparation() {
    this.assertOpen();
    requireProof(performance.now() < Math.min(this.deadlineHostMs, this.preparationDeadlineHostMs), "Original native preparation deadline reached");
  }
  private async prepareWithin<T>(operation: () => Promise<T>, capMs: number, message: string): Promise<T> {
    this.assertPreparation();
    const work = operation();
    this.startupOperations.add(work);
    void work.finally(() => this.startupOperations.delete(work)).catch(() => {});
    return await bounded(work, Math.min(capMs, Math.max(1, Math.min(this.deadlineHostMs,
      this.preparationDeadlineHostMs) - performance.now())), message);
  }
  async start() {
    this.assertPreparation();
    const consent = JSON.parse(await readFile(path.join(this.authDirectory, "provisioning-consent.json"), "utf8"));
    requireProof(consent.eulaAccepted === true && consent.minecraftVersion === "1.21.4" && consent.eulaUrl === "https://www.minecraft.net/en-us/eula", "Existing explicit provisioning consent is unavailable; this evaluator cannot grant consent");
    const copied = Object.fromEntries(["minecraftVersion", "eulaAccepted", "eulaUrl", "acceptedAt", "source", "deployment", "desktopClientRequired"].filter(key => Object.hasOwn(consent, key)).map(key => [key, consent[key]]));
    await writeFile(path.join(this.root, "provisioning-consent.json"), JSON.stringify(copied, null, 2), { mode: 0o600, flag: "wx" });
    const jar = path.join(this.project, "native/minecraft/build/libs/gameharness-native-1.0.0.jar");
    const hash = createHash("sha256").update(await readFile(jar)).digest("hex");
    this.nativeArtifactHash = hash;
    this.report.native_artifact = { path: path.relative(this.project, jar), sha256: hash, pinned_expected_sha256: process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 ?? null };
    if (process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256) requireProof(hash === process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256, "Actual built native artifact does not match the declared SHA256");
    // Runtime-selected evaluator isolation must precede these config-consuming imports.
    const { MinecraftServer } = await import("../server/minecraft-server.ts");
    const { GameBridgeClient } = await import("../server/game-bridge.ts");
    const config = await import("../server/config.ts");
    requireProof(config.DATA_DIR === this.root && config.MINECRAFT_PORT === this.port,
      "Native evaluation needs a fresh command process; production config was imported before fixture isolation");
    this.assertPreparation();
    this.server = new MinecraftServer(() => {}, (type, summary, details) => { this.timeline.push({ at: new Date().toISOString(), type, summary, details }); },
      this.conditions ? { worldSeed: this.conditions.seed } : {});
    this.bridge = new GameBridgeClient(this.project, { dataDir: this.root, evaluation: this.evaluation ?? undefined });
    this.detach.push(this.bridge.subscribeFrames(() => { this.frames++; }));
    this.detach.push(this.bridge.subscribe(notice => {
      if (notice.type === "state") {
        const { status, session_id, epoch, life, error, video } = this.bridge.snapshot();
        this.timeline.push({ at: new Date().toISOString(), type: "state", status, session_id, epoch, life, error, frames: video.frames });
      } else if (notice.type === "game_event") this.timeline.push({ at: new Date().toISOString(), type: "game_event", data: notice.data });
    }));
    await this.startWorld(hash, jar);
  }
  private async startWorld(hash: string, jar: string) {
    await this.prepareWithin(() => this.server.initialize(), this.caps.startMs, "Server initialization timed out");
    await this.prepareWithin(() => this.server.prepare(false), this.caps.totalMs, "Pinned server preparation timed out");
    await this.prepareWithin(() => this.server.start(), this.caps.totalMs, "Owned server readiness timed out");
    this.assertPreparation();
    const world = this.server.snapshot().world_id;
    requireProof(world, "Owned server has no world ID");
    this.report.world_id = world;
    this.report.fixture_server_pid = this.ownedServer().child.pid;
    this.report.server_stdout_artifact = `minecraft/worlds/${world}/gameharness-private.log`;
    if (this.conditions) await this.verifyWorldConditions(world);
    await this.prepareWithin(() => this.bridge.connect({ host: "127.0.0.1", port: this.port, version: "1.21.4", world_id: world, epoch: this.initialEpoch }), this.caps.totalMs, "Owned native connection timed out");
    const client = this.ownedClient();
    this.clients.push(client);
    const actualEvaluation = normalizeNativeEvaluation(client.session.evaluation, true);
    this.evaluationSessions.push(actualEvaluation);
    requireProof(actualEvaluation === null ? this.evaluation === null : this.evaluation !== null &&
      actualEvaluation.version === this.evaluation.version &&
      actualEvaluation.allow_inventory_replacement === this.evaluation.allow_inventory_replacement &&
      actualEvaluation.control_send_buffer_bytes === this.evaluation.control_send_buffer_bytes,
      "Launched native evaluation differs from the trusted declaration");
    requireProof(!this.conditions || client.session.evaluation === null, "Natural fixtures require disabled native evaluation");
    this.assertOpen();
    const installedArtifacts = [];
    for (const installed of [jar, path.join(this.root, "native-client/mods/gameharness-native.jar"), path.join(this.root, "minecraft/worlds", world, "mods/gameharness-native.jar")]) {
      const actual = createHash("sha256").update(await readFile(installed)).digest("hex");
      installedArtifacts.push({ path: path.relative(this.root, installed), sha256: actual });
      requireProof(actual === hash, "A launched native artifact differs from the recorded build bytes");
    }
    this.report.launched_native_artifacts = installedArtifacts;
    const observation = await this.prepareWithin(() => this.observe(), this.caps.observationMs, "Initial authorized observation timed out");
    requireProof(observation.schema_version === 3 && observation.profile_id === "minecraft_assisted_rgb_fov_r8_control_v7", "Native observation is not the actual negotiated observation3/camera-bound-r8/control-feedback profile");
    requireProof(observation.epoch === this.initialEpoch && observation.life.status === "alive" && observation.data.player.health > 0, "Fresh world did not preserve the safe-long scope or admit an authoritative alive player");
    this.report.initial = this.identity(observation);
    const history = this.report.world_history as Array<Record<string, unknown>> | undefined;
    this.report.world_history = [...(history ?? []), { world_id: world, initial: this.identity(observation),
      world_conditions: this.report.world_conditions ?? null, native_sha256: hash }];
    await this.flush();
  }
  private async verifyWorldConditions(world: string) {
    const properties = await readFile(path.join(this.root, "minecraft/worlds", world, "server.properties"), "utf8");
    const actual = Object.fromEntries(properties.split(/\r?\n/).filter(line => /^(?:gamemode|force-gamemode|difficulty|hardcore|level-type|level-seed|generate-structures)=/.test(line)).map(line => {
      const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1).replaceAll("\\:", ":")];
    }));
    const expected = this.conditions!;
    requireProof(actual.gamemode === expected.gamemode && actual["force-gamemode"] === "true" && actual.difficulty === expected.difficulty && actual.hardcore === "false" &&
      actual["level-type"] === expected.levelType && actual["level-seed"] === expected.seed && actual["generate-structures"] === "true", "Actual world properties do not match predeclared ordinary comparison conditions");
    this.report.world_conditions = { declared: expected, actual_properties: actual, existing_world_comparison: "unsupported_fresh_world_only",
      seed_evidence: "Actual server.properties captured before native connection; seed is not inferred from visible terrain or supplied to the model" };
  }
  async nextWorld() {
    this.assertOpen();
    requireProof(this.conditions, "Ordinary world rotation requires predeclared natural conditions");
    await bounded(this.bridge.disconnect(), this.caps.cleanupMs, "Previous native client drain timed out");
    await bounded(this.server.newWorld(), this.caps.cleanupMs, "Previous server drain/world rotation timed out");
    const jar = path.join(this.project, "native/minecraft/build/libs/gameharness-native-1.0.0.jar");
    const hash = createHash("sha256").update(await readFile(jar)).digest("hex");
    requireProof(hash === this.nativeArtifactHash, "Native artifact changed during the declared finite sample");
    await this.startWorld(hash, jar);
  }
  ownedServer(): OwnedServer {
    const owner = Reflect.get(this.server, "process") as OwnedServer | null;
    requireProof(owner?.ready && owner.child.pid && owner.child.exitCode === null, "Evaluator no longer owns a ready live server");
    return owner;
  }
  ownedClient(): NativeProcess {
    const owner = Reflect.get(this.bridge, "owned") as NativeProcess | null;
    requireProof(owner?.child.pid && owner.child.exitCode === null, "Evaluator no longer owns a live native client");
    return owner;
  }
  async observe(): Promise<MinecraftObservation> { return minecraftObservationV3Schema.parse(await this.bridge.observe()); }
  identity(observation: ObservationV3): FixtureIdentity {
    const current = minecraftObservationV3Schema.parse(observation);
    return { world_id: current.world_id, session_id: current.session_id, epoch: current.epoch, native_boot_id: current.native_boot_id,
      space_epoch: current.space.space_epoch, life_id: current.life.life_id, life_status: current.life.status,
      health: current.data.player.health, pid: this.ownedClient().child.pid };
  }
  sameSession(previous: FixtureIdentity, observation: ObservationV3) {
    const now = this.identity(observation);
    requireProof(now.world_id === previous.world_id && now.session_id === previous.session_id && now.epoch === previous.epoch && now.native_boot_id === previous.native_boot_id && now.pid === previous.pid && this.bridge.snapshot().status === "connected" && this.bridge.snapshot().error === null, "Ordinary lifecycle replaced or damaged the owned native session");
    return now;
  }
  async diagnostics(): Promise<NativeDiagnostics> {
    return diagnosticsSchema.parse(await bounded(Reflect.get(this.bridge, "request").call(this.bridge, "diagnostics"), this.caps.diagnosticsMs, "Native diagnostics timed out"));
  }
  async console(commands: string[], options?: { acknowledgement_ms: number; phase: "arena_chunk_generation" }) {
    requireProof(!this.conditions, "Natural acceptance has no console command authority");
    const owner = this.ownedServer();
    const marker = `fixture_${randomUUID().replaceAll("-", "")}`;
    const acknowledgementMs = options?.acknowledgement_ms ?? this.caps.diagnosticsMs;
    const started = performance.now();
    requireProof(commands.every(command => command.length <= 2048 && !/[\r\n]/.test(command)), "Fixture console command exceeds a single bounded line");
    const receipt = Promise.withResolvers<void>();
    let output = "";
    const receive = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-65536); if (output.includes(marker)) receipt.resolve(); };
    owner.child.stdout.on("data", receive);
    const entry: Record<string, unknown> = { at: new Date().toISOString(), classification: "synthetic_evaluator_setup_only", phase: options?.phase ?? "evaluator_command", acknowledgement_timeout_ms: acknowledgementMs,
      acknowledged: false, commands, server_pid: owner.child.pid, stdout: null };
    this.commands.push(entry);
    try {
      const written = Promise.withResolvers<void>();
      owner.child.stdin.write(`${commands.join("\n")}\nsay ${marker}\n`, error => error ? written.reject(error) : written.resolve());
      await bounded(written.promise, this.caps.diagnosticsMs, "Fixture console write timed out");
      await bounded(receipt.promise, acknowledgementMs, "Fixture console did not acknowledge evaluator commands");
      entry.acknowledged = true; entry.acknowledgement_ms = performance.now() - started;
      requireProof(!/Unknown or incomplete command|Incorrect argument|Expected |Invalid (?:item|entity|block)|That position is not loaded/i.test(output), "Privileged fixture setup command was rejected");
    } finally { owner.child.stdout.off("data", receive); entry.stdout = output; entry.elapsed_ms = performance.now() - started; }
    await pause(150);
    return output;
  }
  async flat() {
    await this.console(["forceload add -16 -16 15 15"], { acknowledgement_ms: this.caps.authMs, phase: "arena_chunk_generation" });
    const chunks = `fixture_chunks_${randomUUID().replaceAll("-", "")}`;
    await until(() => this.console([`execute if loaded -12 239 -12 if loaded -12 239 12 if loaded 12 239 -12 if loaded 12 239 12 run say ${chunks}`]), output => output.includes(chunks), this.caps.authMs, "Evaluator arena chunks did not load");
    await this.console(["gamerule doMobSpawning false", "gamerule doDaylightCycle false", "time set noon", "weather clear", "kill @e[type=minecraft:item]", "fill -12 238 -12 12 250 12 minecraft:air", "fill -12 239 -12 12 239 12 minecraft:stone"]);
    const floor = `fixture_floor_${randomUUID().replaceAll("-", "")}`;
    const output = await this.console([`execute if block -12 239 -12 minecraft:stone if block -12 239 12 minecraft:stone if block 12 239 -12 minecraft:stone if block 12 239 12 minecraft:stone if block 0 239 0 minecraft:stone run say ${floor}`]);
    requireProof(output.includes(floor), "Evaluator platform did not confirm support blocks before teleport");
    const priorSpace = this.bridge.snapshot().space?.space_epoch;
    await this.console(["tp @a 0.5 240 0.5 0 0", "spawnpoint @a 0 240 0"]);
    // Console completion precedes client teleport/collision delivery. Do not start
    // an InventoryProof read while those authoritative corrections still fence it.
    let seenSpace = priorSpace, quietSince = performance.now();
    const readiness = await until(async () => {
      const space = this.bridge.snapshot().space?.space_epoch, now = performance.now();
      if (space !== seenSpace) { seenSpace = space; quietSince = now; }
      const packet = this.bridge.latestFrame(), header = packet ? decodeNativeVideoHeader(packet) : null;
      return { space, quiet_ms: now - quietSince, header };
    }, value => {
      const position = value.header?.capture.render?.position;
      return value.space !== undefined && value.space !== priorSpace && value.quiet_ms >= 250 &&
        value.header !== null && Date.now() - value.header.capturedAt < 500 && position !== undefined &&
        Math.abs(position.x - .5) < .1 && Math.abs(position.z - .5) < .1 && position.y > 241 && position.y < 242;
    }, this.caps.observationMs, "Evaluator teleport/render space did not settle before authoritative observation");
    this.commands.push({ at: new Date().toISOString(), classification: "synthetic_evaluator_setup_readiness",
      space_epoch: readiness.space, quiet_host_ms: readiness.quiet_ms, capture_sequence: readiness.header!.sequence,
      native_tick: readiness.header!.capture.client_tick });
    await until(() => this.observe(), observation => Math.abs(observation.data.player.position.y - 240) < .05 && observation.data.player.on_ground, this.caps.observationMs, "Fixture player did not settle on platform");
  }
  async action(action: GameAction, timeout = this.caps.observationMs, signal?: AbortSignal) {
    requireProof(!this.conditions, "Natural acceptance has no trusted diagnostic effect authority");
    this.assertOpen();
    this.diagnosticSource ??= createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
    this.commands.push({ at: new Date().toISOString(), classification: "synthetic_evaluator_host_diagnostic_not_model_gameplay",
      source_hash: this.diagnosticSource, action });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const invoke = (arbiter: ActionArbiter) => arbiter.diagnostic(action, this.diagnosticSource!, timeout, cancellation);
    try {
      return await this.withDiagnosticContext(invoke, timeout, this.diagnosticSource, true);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async withController<T>(sourceHash: string, timeout: number,
    applied: (ack: InputAppliedAck) => void, effect: (update: ControllerEffectUpdate) => void,
    work: (channel: ControllerInputChannel) => Promise<T>): Promise<T> {
    return await this.withControllerContext(sourceHash, performance.now() + timeout, async context => {
      const channel = await context.open(applied, effect);
      try { return await work(channel); }
      finally { await channel.revoke(); }
    });
  }
  async withControllerContext<T>(sourceHash: string, deadlineHostMs: number,
    work: (context: NativeControllerContext) => Promise<T>): Promise<T> {
    requireProof(!this.conditions, "Natural acceptance has no evaluator controller authority");
    this.assertOpen();
    const timeout = deadlineHostMs - performance.now();
    requireProof(Number.isFinite(timeout) && timeout > 0 && timeout <= 57_600_000, "Evaluator controller needs one original finite monotonic deadline");
    requireProof(Number.isSafeInteger(++this.controllerGeneration), "Diagnostic controller generation exhausted");
    this.commands.push({ at: new Date().toISOString(), classification: "synthetic_evaluator_controller_not_model_gameplay",
      source_hash: sourceHash, timeout_ms: timeout });
    return await this.withDiagnosticContext(async (arbiter, executionId) => {
      let opened = false;
      return await work({ execution_id: executionId, controller_generation: this.controllerGeneration, deadline_host_ms: deadlineHostMs,
        open: (applied, effect, lifecycle) => {
          requireProof(!opened, "A controller context grants native admission at most once");
          opened = true;
          return arbiter.reserveController(executionId, this.controllerGeneration, deadlineHostMs, applied, effect, lifecycle);
        } });
    }, timeout, sourceHash, false);
  }
  private async withDiagnosticContext<T>(invoke: (arbiter: ActionArbiter, executionId: string) => Promise<T>,
    timeout: number, sourceHash: string, allowCurrent: boolean): Promise<T> {
    const existing = ActionArbiter.current(this.bridge);
    if (existing?.runningContext) {
      requireProof(allowCurrent, "Evaluator controller cannot replace an active model run context");
      return await bounded(invoke(existing, ""), timeout + this.caps.cleanupMs, "Trusted native diagnostic did not drain");
    }
    this.diagnosticStore ??= new Store(path.join(this.root, "diagnostic-authority"));
    const store = this.diagnosticStore, state = this.bridge.snapshot(), adapter = this.bridge.adapter();
    requireProof(state.binding?.ready && state.space && state.life && state.session_id && state.world_id && adapter, "Diagnostic adapter/session has not negotiated");
    const run: StoredRun = { run_id: randomUUID(), world_id: state.world_id, session_id: state.session_id, epoch: state.epoch,
      native_boot_id: state.binding.native_boot_id, space_epoch: state.space.space_epoch, compatibility_hash: state.binding.compatibility_hash,
      life_id: state.life.life_id, task: "Trusted native infrastructure diagnostic; no model gameplay claim",
      goal: { adapter_id: adapter.descriptor.adapter.id, goal_id: "custom", parameters: {}, verifier: null },
      model_id: "zero-provider-host-diagnostic", status: "running", started_at: new Date().toISOString(), ended_at: null,
      turns: 0, model_status: "idle", error: null, usage: emptyRunUsage(), baseline: {} };
    store.saveRun(run);
    const executionId = `diagnostic_controller_${randomUUID()}`;
    const scope: EffectScope = { session_id: state.session_id, world_id: state.world_id, epoch: state.epoch,
      native_boot_id: state.binding.native_boot_id, run_id: run.run_id, run_generation: 1,
      life_id: state.life.life_id, space_epoch: state.space.space_epoch, execution_id: executionId, source_hash: sourceHash };
    const event = (type: string, details: Record<string, import("../shared/contracts.ts").Json> = {}) =>
      store.event(run.run_id, type, "Trusted diagnostic authority lifecycle", details);
    const host: ActionArbiterHost = {
      run: () => run, generation: () => 1, needsReconnect: () => this.bridge.snapshot().error !== null,
      adapter: () => this.bridge.adapter(),
      invocation: id => id === executionId ? { kind: "diagnostic", execution_id: executionId, source_hash: sourceHash } : null,
      effectScope: id => id === executionId ? { ...scope } : null,
      observe: () => this.observe(), changed: () => event("diagnostic.authority_changed"),
      admitted: () => event("diagnostic.effect_admitted"), wake: reason => event("diagnostic.wake", { reason }),
      pause: (message, reconnect) => { run.status = "paused"; run.error = message; store.saveRun(run); event("diagnostic.paused", { message, reconnect }); },
      uncertain: view => event("diagnostic.effect_uncertain", { action_id: view.action_id, status: view.status }),
      effect: () => { throw new Error("A trusted diagnostic context has no policy authority"); },
      settled: (_action, result, view) => event("diagnostic.effect_settled", { action_id: view.action_id, result: jsonSchema.parse(result) }),
    };
    const arbiter = existing ?? new ActionArbiter(store, this.bridge, host);
    try {
      return await bounded(arbiter.diagnosticContext(store, host, active => invoke(active, executionId)),
        timeout + this.caps.cleanupMs, "Trusted native diagnostic did not drain");
    } finally { run.status = "stopped"; run.ended_at = new Date().toISOString(); store.saveRun(run); }
  }
  async waitForNeutralRest(samples: NeutralPoseSample[], timeoutMs = this.caps.diagnosticsMs) {
    const started = performance.now();
    let previous: MinecraftObservation | null = null, stableSince: number | null = null;
    while (performance.now() - started < timeoutMs) {
      const observation = await this.observe(), diagnostics = await this.diagnostics(), elapsed = performance.now() - started;
      samples.push({ elapsed_ms: elapsed, position: observation.data.player.position, yaw: observation.data.player.yaw, diagnostics });
      requireProof(diagnostics.controls_neutral && !diagnostics.motor_active, "Native emitter remained active after neutralization");
      if (previous && distance(previous.data.player.position, observation.data.player.position) < .005 && Math.abs(wrap(previous.data.player.yaw - observation.data.player.yaw)) < .001) {
        stableSince ??= elapsed;
        if (elapsed - stableSince >= 200) return observation;
      } else stableSince = null;
      previous = observation;
      await pause(50);
    }
    throw new Error("Neutral player did not reach a sustained stable pose within the physical settling bound");
  }
  async drainEffects(reason: string): Promise<void> {
    const arbiter = ActionArbiter.current(this.bridge);
    requireProof(arbiter, "No real host diagnostic arbiter owns this fixture");
    await arbiter.close(reason);
  }
  private async framePixels(name: string) {
    requireProof(/^[a-zA-Z0-9_-]+$/.test(name), "Frame artifact must have a bounded filename");
    await until(async () => this.bridge.latestFrame(), value => Boolean(value), this.caps.observationMs, "No authentic framebuffer available");
    const raw = Buffer.from(this.bridge.latestFrame()!);
    const header = decodeNativeVideoHeader(raw);
    requireProof(header && raw.byteLength === header.headerBytes + header.width * header.height * 4, "Authentic framebuffer packet is malformed");
    const ghv2 = `${name}.ghv2`, png = `${name}.png`;
    await writeFile(path.join(this.root, ghv2), raw, { mode: 0o600, flag: "wx" });
    const converted = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${header.width}x${header.height}`, "-i", "pipe:0", "-vf", header.bottomUp ? "vflip,format=rgb24" : "format=rgb24", "-frames:v", "1", path.join(this.root, png)], { input: raw.subarray(header.headerBytes), stdio: ["pipe", "ignore", "pipe"], timeout: this.caps.authMs });
    requireProof(converted.status === 0, "Authentic framebuffer PNG conversion failed; raw private frame retained");
    return { ghv2, png, sha256: createHash("sha256").update(raw).digest("hex"), frame_count: this.frames, capture: header.capture,
      presentation: "Actual native RGBA frame presented as top-down opaque RGB according to its wire orientation; no synthetic overlay or OCR claim" };
  }
  async frame(name: string) { const before = await this.diagnostics(), pixels = await this.framePixels(name), after = await this.diagnostics(); return { ...pixels, native_before: before, native_after: after }; }
  async case(name: string, conditions: Record<string, unknown>, run: (entry: Record<string, unknown>) => Promise<void>) {
    const entry: Record<string, unknown> = { name, conditions, status: "running", started_at: new Date().toISOString() };
    this.cases.push(entry);
    const started = performance.now();
    try { await run(entry); entry.status = "passed"; }
    catch (error) {
      entry.status = "failed"; entry.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
      try { entry.failure_diagnostics = await this.diagnostics(); } catch { entry.failure_diagnostics_error = "capture_unavailable"; }
      try { entry.failure_frame = await this.framePixels(`failed-${name}-${randomUUID().slice(0, 8)}`); } catch { entry.failure_frame_error = "capture_unavailable"; }
    } finally { entry.elapsed_ms = performance.now() - started; await this.flush(); }
  }
  async suspendedServer<T>(work: () => Promise<T>): Promise<T> {
    const pid = this.ownedServer().child.pid!;
    this.stoppedServer = pid;
    process.kill(pid, "SIGSTOP");
    try { return await bounded(work(), this.caps.observationMs, "Suspended-server probe exceeded its finite hold"); }
    finally { process.kill(pid, "SIGCONT"); this.stoppedServer = null; }
  }
  async suspendedClient<T>(work: () => Promise<T>): Promise<T> {
    const owned = this.ownedClient();
    requireProof(this.stoppedClient === null && owned.child.pid !== undefined, "Owned client suspension is unavailable or nested");
    this.stoppedClient = owned;
    process.kill(owned.child.pid, "SIGSTOP");
    try { return await bounded(work(), this.caps.observationMs, "Suspended-client probe exceeded its finite hold"); }
    finally {
      if (owned.child.exitCode === null && owned.child.signalCode === null) {
        try { process.kill(owned.child.pid, "SIGCONT"); } catch {}
      }
      if (this.stoppedClient === owned) this.stoppedClient = null;
    }
  }
  close(): Promise<{ closed: boolean }> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeOwned();
    return this.closePromise;
  }
  private async closeOwned() {
    if (this.stoppedClient !== null) {
      const child = this.stoppedClient.child;
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { process.kill(child.pid, "SIGCONT"); } catch {}
      }
      this.stoppedClient = null;
    }
    if (this.stoppedServer !== null) { try { process.kill(this.stoppedServer, "SIGCONT"); } catch {} this.stoppedServer = null; }
    const cleanupDeadline = Math.min(this.deadlineHostMs, performance.now() + this.caps.cleanupMs);
    if (performance.now() >= cleanupDeadline) this.report.cleanup_deadline_reached = true;
    const join = async (work: Promise<unknown>, message: string) => {
      try { await bounded(work, Math.max(1, cleanupDeadline - performance.now()), message); }
      catch {
        if (performance.now() >= cleanupDeadline) this.report.cleanup_deadline_reached = true;
        // Revocation/timeout is not closure. Retain and join the original owner.
        await work;
      }
    };
    const cleanup = await Promise.allSettled([
      join(this.bridge ? ActionArbiter.current(this.bridge)?.close("Native fixture authority closed") ?? Promise.resolve() : Promise.resolve(), "Diagnostic arbiter cleanup deadline"),
      join(this.bridge ? this.bridge.close() : Promise.resolve(), "Native cleanup deadline"),
      join(this.server ? this.server.close() : Promise.resolve(), "Server cleanup deadline"),
      join(Promise.allSettled([...this.startupOperations]), "Native preparation drain deadline"),
    ]);
    this.diagnosticStore?.close(); this.diagnosticStore = null;
    for (const unsubscribe of this.detach) unsubscribe();
    const exits = await Promise.all(this.clients.map(client => join(client.closed, "Native process exit not confirmed").then(() => true, () => false)));
    this.report.native_stdout_diagnostics = this.clients.map(client => ({ pid: client.child.pid, classes_and_redacted_causes: client.diagnostics }));
    const closed = cleanup.every(value => value.status === "fulfilled") && exits.every(Boolean) && (!this.bridge || Reflect.get(this.bridge, "owned") === null) && (!this.server || Reflect.get(this.server, "process") === null);
    if (performance.now() >= cleanupDeadline) this.report.cleanup_deadline_reached = true;
    // Actual closure remains useful ownership evidence after a missed bound;
    // it is not evidence of a timely successful sample.
    this.report.cleanup = closed;
    this.report.cleanup_errors = cleanup.flatMap(value => value.status === "rejected" ? [String(value.reason)] : []);
    await this.flush();
    return { closed };
  }
  async finish(error?: unknown) {
    if (error) { this.report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
    await this.close();
    this.report.ended_at = new Date().toISOString();
    this.report.pass = !error && this.cases.length > 0 && this.cases.every(value => value.status === "passed") &&
      this.report.cleanup === true && this.report.cleanup_deadline_reached !== true;
    if (!this.report.pass) process.exitCode = 1;
    await this.flush();
    console.log(JSON.stringify({ pass: this.report.pass, cleanup: this.report.cleanup, private_report: path.basename(this.root) }, null, 2));
  }
  async writeJson(name: string, value: unknown) {
    requireProof(/^[a-zA-Z0-9_-]+\.json$/.test(name), "Evidence artifact must be a bounded JSON filename");
    const text = JSON.stringify(value, null, 2);
    requireProof(Buffer.byteLength(text) <= this.caps.reportJsonBytes, "Private evidence JSON exceeds declared byte bound");
    await writeFile(path.join(this.evidenceDirectory, name), text, { mode: 0o600, flag: "wx" });
  }
  async writeReport(value: unknown) {
    const text = JSON.stringify(value, null, 2);
    requireProof(Buffer.byteLength(text) <= this.caps.reportJsonBytes, "Private report exceeds declared byte bound");
    await writeFile(path.join(this.evidenceDirectory, "report.json"), text, { mode: 0o600 });
  }
  async flush() {
    if (!this.conditions) return await this.writeReport(this.report);
    const text = JSON.stringify(this.report, null, 2);
    requireProof(Buffer.byteLength(text) <= this.caps.reportJsonBytes, "Private native report exceeds declared byte bound");
    await writeFile(path.join(this.evidenceDirectory, "native-report.json"), text, { mode: 0o600 });
  }
}
