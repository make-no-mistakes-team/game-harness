import { mock } from "bun:test";
import * as filesystem from "node:fs/promises";
import { mkdir, readFile, writeFile, utimes, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import type { GameBridge, ObservationV3, PlayerLife } from "../../src/shared/contracts.ts";
import * as native from "../../src/evaluation/native-game.ts";
import { DEFAULT_EVALUATION_CAPS as nativeCaps } from "../../src/evaluation/config.ts";
import { nativeFrame } from "./native-frame.ts";
import { minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding } from "./adapter-contract.ts";
import type { EffectOwnerRef, ScreenRef } from "../../src/shared/control.ts";
import { sameEffectScope } from "../../src/shared/control.ts";
import { minecraftActionSchema } from "../../src/shared/minecraft.ts";

// Dedicated subprocess: real proof/selector/codec/recorder/finish/postmortem,
// with only native game ownership synthetic. Actual FFmpeg/FFprobe exercise
// live capture and canonical remux under the real proof's ownership.
// The real NativeFixture.finish must retain its own close await and pass logic.
const [signalArg, rootArg, phaseArg = "close"] = process.argv.slice(2);
if (signalArg !== "SIGINT" && signalArg !== "SIGTERM") throw new Error("Expected a real shutdown signal");
if (!rootArg) throw new Error("Missing isolated proof directory");
if (phaseArg !== "close" && phaseArg !== "persistence" && phaseArg !== "preflight" && phaseArg !== "capture") throw new Error("Unknown proof interruption phase");
const signal = signalArg, root = rootArg, phase = phaseArg;
const project = join(root, "project");
await mkdir(join(project, "native/minecraft/src"), { recursive: true });
const source = join(project, "native/minecraft/src/Synthetic.java"), jar = join(project, "synthetic-native.jar");
await writeFile(source, "Synthetic freshness fixture only; never compiled or launched.\n");
await writeFile(jar, "Synthetic local artifact; never supplied to a JVM.\n");
if (process.env.PROOF_PROFILE_CONTENT !== undefined)
  await writeFile(join(project, "evidence-profile.json"), process.env.PROOF_PROFILE_CONTENT);
await utimes(source, new Date(1000), new Date(1000));
await utimes(jar, new Date(2000), new Date(2000));
delete process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256;

const closeEntered = Promise.withResolvers<void>(), releaseClose = Promise.withResolvers<void>();
const captureEntered = Promise.withResolvers<void>();
const finalWriteEntered = Promise.withResolvers<void>(), releaseFinalWrite = Promise.withResolvers<void>();
const interruptionWriteEntered = Promise.withResolvers<void>(), releaseInterruptionWrite = Promise.withResolvers<void>();
const interruptionWriteFinished = Promise.withResolvers<void>(), gatesObserved = Promise.withResolvers<void>();
const publicReturnObserved = Promise.withResolvers<void>();
const signalDelivered = Promise.withResolvers<postmortem.Reason>();
let reportPath: string | undefined, heldFinalWrite = false, heldInterruptionWrite = false;
let serializedPassingSnapshot: unknown;
let proofSettled = false, proofSettledWhileInterruptionWriteHeld: boolean | null = null;
let nativeClosedBeforeSignal = false;
if (phase === "persistence") {
  const actualWriteFile = filesystem.writeFile;
  mock.module("node:fs/promises", () => ({ ...filesystem, writeFile: async (...args: Parameters<typeof filesystem.writeFile>) => {
    let interruptionWrite = false;
    if (reportPath && String(args[0]) === reportPath && typeof args[1] === "string") {
      // Observe the real NativeFixture.writeReport's already-serialized bytes.
      // Holding this actual filesystem boundary keeps finish/report code real.
      const snapshot = JSON.parse(args[1]) as { pass?: boolean; recorder_cleanup?: { confirmed?: boolean }; recorder_failure?: unknown };
      if (!heldFinalWrite && snapshot.pass === true && snapshot.recorder_cleanup?.confirmed === true) {
        heldFinalWrite = true;
        serializedPassingSnapshot = snapshot;
        finalWriteEntered.resolve();
        await releaseFinalWrite.promise;
      } else if (heldFinalWrite && !heldInterruptionWrite && snapshot.recorder_failure) {
        heldInterruptionWrite = true; interruptionWrite = true;
        interruptionWriteEntered.resolve();
        await releaseInterruptionWrite.promise;
      }
    }
    try { await actualWriteFile(...args); }
    finally { if (interruptionWrite) interruptionWriteFinished.resolve(); }
  } }));
}
const session = crypto.randomUUID(), world = crypto.randomUUID();
let life: PlayerLife = { life_id: 1, status: "alive", can_respawn: false, death: null };
let motorActive = false, sequence = 0, frameSequence = 0;
let spaceEpoch = 1, screen: ScreenRef | null = null, owner: EffectOwnerRef | null = null;
const adapter = minecraftTestAdapter(), binding = minecraftTestBinding(adapter);
const frames = new Set<(frame: Uint8Array) => void>();
function frame() {
  const packet = nativeFrame({ sequence: ++frameSequence, capturedAt: Date.now() });
  for (const listener of frames) listener(packet);
  if (frames.size) captureEntered.resolve();
  return packet;
}
const bridge: Pick<GameBridge, "observe" | "execute" | "neutralize" | "cancel" | "emergencyStop" | "adapter" | "snapshot"> & {
  latestFrame(): Uint8Array;
  subscribeFrames(callback: (frame: Uint8Array) => void): () => void;
  owned: null;
  close(): Promise<void>;
} = {
  owned: null,
  adapter: () => adapter,
  snapshot: () => ({ status: "connected", username: "Synthetic boundary", version: "1.21.4", world_id: world,
    epoch: 1, session_id: session, life: structuredClone(life), binding, space: { dimension_id: "minecraft:overworld", space_epoch: spaceEpoch },
    screen, presentation: null, last_observation_at: null, error: null,
    video: { status: "streaming", width: 2, height: 2, fps: 30, frames: frameSequence, last_frame_at: null, error: null } }),
  async observe(): Promise<ObservationV3> {
    frame();
    return minecraftObservationFixture(adapter, { world_id: world, session_id: session, epoch: 1,
      life: structuredClone(life), observation_seq: ++sequence, screen, space: { dimension_id: "minecraft:overworld", space_epoch: spaceEpoch },
      data: { player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: life.status === "alive" ? 20 : 0,
        food: 20, on_ground: true, in_water: false, inventory: [] },
      blocks: [], entities: [], sounds: [] } });
  },
  async execute(envelope, abort) {
    if (envelope.invocation.kind !== "diagnostic" || envelope.scope.native_boot_id !== binding.native_boot_id ||
      envelope.scope.space_epoch !== spaceEpoch || envelope.scope.life_id !== life.life_id)
      throw new Error("Synthetic native boundary requires real host diagnostic authority");
    owner = { operation_id: envelope.operation_id, scope: envelope.scope };
    const action = minecraftActionSchema.parse(envelope.action);
    if (action.kind === "move") {
      motorActive = true;
      const stopped = Promise.withResolvers<void>();
      if (abort.aborted) stopped.resolve();
      else abort.addEventListener("abort", () => stopped.resolve(), { once: true });
      await stopped.promise;
      motorActive = false; owner = null;
      return { status: "cancelled", summary: "Synthetic native motor cancellation", evidence: { effect_confirmed: false } };
    }
    if (action.kind !== "respawn") throw new Error("Unexpected proof effect at synthetic native boundary");
    life = { life_id: 2, status: "alive", can_respawn: false, death: null };
    spaceEpoch++; screen = null; owner = null;
    return { status: "succeeded", summary: "Synthetic native respawn", evidence: { effect_confirmed: true } };
  },
  async neutralize(expected) {
    if (owner && owner.operation_id === expected.operation_id && sameEffectScope(owner.scope, expected.scope)) motorActive = false;
  },
  async cancel(_reason, expected) { await bridge.neutralize(expected); },
  async emergencyStop() { motorActive = false; },
  async close() {
    if (!fixture) throw new Error("Missing synthetic native owner");
    caseBeforeClose = structuredClone(fixture.cases[0]);
    if (phase !== "capture" && caseBeforeClose?.status !== "passed") throw new Error("Proof did not succeed before its native close gate");
    await fixture.flush();
    closeEntered.resolve();
    if (phase === "close") await releaseClose.promise;
  },
  latestFrame: frame,
  subscribeFrames(callback) { frames.add(callback); return () => { frames.delete(callback); }; },
};
let fixture: native.NativeFixture | undefined;
let caseBeforeClose: Record<string, unknown> | undefined;
let nativeCreations = 0;
const create = native.NativeFixture.create.bind(native.NativeFixture);
mock.module(resolve(import.meta.dir, "../../src/evaluation/native-game.ts"), () => ({ ...native, NativeFixture: {
  create: async (name: string, options: native.NativeFixtureOptions = {}) => {
    nativeCreations++;
    if (phase === "preflight") throw new Error("External native preparation must not be reached");
    // Preserve the actual fixture instance and its finish/report implementation.
    // Only its native owner methods are replaced; no real server/client starts.
    const current = await create(name, { ...options, projectRoot: project,
      paths: { runtimeRoot: join(root, "runtime"), governanceRoot: join(root, "governance"), reportsRoot: join(root, "reports") },
      caps: { ...nativeCaps, totalMs: 15000, cleanupMs: 2000, observationMs: 1000, diagnosticsMs: 1000 } });
    fixture = current;
    reportPath = join(current.evidenceDirectory, "report.json");
    current.report.synthetic_native_boundary = true;
    current.start = async () => {};
    current.flat = async () => {};
    Reflect.set(current, "bridge", bridge);
    current.console = async commands => {
      if (JSON.stringify(commands) !== JSON.stringify(["kill @a"])) throw new Error("Unexpected synthetic setup command");
      life = { life_id: 1, status: "dead", can_respawn: true,
        death: { death_id: crypto.randomUUID(), at: new Date().toISOString(), message: "Synthetic death menu" } };
      screen = { screen_id: "synthetic-death-screen", incarnation: 1, revision: 0 };
      return "Synthetic native setup acknowledged";
    };
    current.diagnostics = async () => ({ screen_type: life.status === "dead" ? "DeathScreen" : null,
      death_screen: life.status === "dead", controls_neutral: !motorActive, motor_active: motorActive,
      motor_tick_count: motorActive ? 1 : 0, motor_profile: "balanced", max_yaw_degrees_per_second: 90,
      max_pitch_degrees_per_second: 90, yaw_acceleration_degrees_per_second_squared: 180,
      pitch_acceleration_degrees_per_second_squared: 180, camera_integration_clock: "synthetic-local" });
    return current;
  },
} }));
// Intentional loading boundary: import the proof after installing the isolated
// native factory. Its real fixture.finish and SDK shutdown remain untouched.
const { runNativeRecordingProof } = await import("../../scripts/native-recording-proof.ts");
const extraArgs: string[] = JSON.parse(process.env.PROOF_EXTRA_ARGS ?? "[]");
if (phase === "preflight") {
  let error: string | null = null;
  try { await runNativeRecordingProof(["--allow-native", "--jar", jar, ...extraArgs], project); }
  catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  console.log(`PROOF_PREFLIGHT_RESULT ${JSON.stringify({ error, nativeCreations })}`);
  process.exit(0);
}
const proof = runNativeRecordingProof(["--allow-native", "--jar", jar, ...extraArgs], project);
void proof.then(() => { proofSettled = true; }, () => { proofSettled = true; });
const observed = (async () => {
  const result = await proof;
  if (!fixture) throw new Error("Missing actual native fixture instance");
  const file = join(fixture.evidenceDirectory, "report.json");
  const atReturn = { bytes: await readFile(file, "utf8"), mtime: (await stat(file, { bigint: true })).mtimeNs.toString() };
  publicReturnObserved.resolve();
  await gatesObserved.promise;
  await Bun.sleep(25);
  const afterGates = { bytes: await readFile(file, "utf8"), mtime: (await stat(file, { bigint: true })).mtimeNs.toString() };
  const report = JSON.parse(afterGates.bytes);
  await Bun.write(Bun.stdout, `PROOF_LIFECYCLE_RESULT ${JSON.stringify({ result, report, caseBeforeClose,
    serializedPassingSnapshot, nativeClosedBeforeSignal, proofSettledWhileInterruptionWriteHeld,
    unchangedAfterReturn: atReturn.bytes === afterGates.bytes && atReturn.mtime === afterGates.mtime })}\n`);
})();
// Keep the actual SDK handlers and their 130/143 exit semantics. The supported
// observer waits for the real proof result and durable report before SDK exit.
const unregister = postmortem.register("synthetic-native-proof-result-observer", why => {
  signalDelivered.resolve(why);
  return observed;
}, { exitOnly: true });
const trigger = (async () => {
  if (phase === "capture") { await captureEntered.promise; await Bun.sleep(100); }
  else if (phase === "close") await closeEntered.promise;
  else await finalWriteEntered.promise;
  nativeClosedBeforeSignal = fixture?.report.cleanup === true;
  process.kill(process.pid, signal);
  const why = await signalDelivered.promise;
  if (why !== (signal === "SIGINT" ? postmortem.Reason.SIGINT : postmortem.Reason.SIGTERM))
    throw new Error("SDK did not observe the requested real signal");
  // Release only after both production and observer callbacks see the signal,
  // well inside the declared cleanup budget: this is not a timeout failure.
  if (phase === "capture" || phase === "close") releaseClose.resolve();
  else {
    releaseFinalWrite.resolve();
    await interruptionWriteEntered.promise;
    // Observe the real public promise while the later interruption write is
    // independently held. Correct ownership cannot return at the first write.
    await Bun.sleep(25);
    proofSettledWhileInterruptionWriteHeld = proofSettled;
    if (proofSettled) await publicReturnObserved.promise;
    releaseInterruptionWrite.resolve();
    await interruptionWriteFinished.promise;
  }
  gatesObserved.resolve();
})();
try { await Promise.all([observed, trigger]); }
finally {
  releaseClose.resolve(); releaseFinalWrite.resolve(); releaseInterruptionWrite.resolve(); gatesObserved.resolve();
  unregister();
}
