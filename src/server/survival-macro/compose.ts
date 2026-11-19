import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMacroTrials, MACRO_TRIAL_ADAPTER_VERSION, MACRO_TRIAL_VERBS } from "../../../survival-agent/macro-trial.ts";
import { TERRA_MODEL_ID } from "../../shared/survival-agent-ui.ts";
import { SurvivalMacroController } from "./controller.ts";
import { createNativeGapReview } from "./gap-review.ts";
import { MACRO_CAPABILITIES_VERSION, readMacroObservation, type MacroBasis, type MacroFrame, type MacroObservation } from "./protocol.ts";
import { MACRO_AUTOMATIC_SKILL_VERBS, SurvivalMacroSkills } from "./skills.ts";
import { openTerraStrategist, type TerraStrategist } from "./terra.ts";

const FRAME_BYTES = 2 * 1024 * 1024;
const FRAME_TIMEOUT_MS = 1_000;
const FRAME_DIRECTORY = "macro-frames";
const REQUEST_TIMEOUT_MS = 35_000;
const LOW_RISK_VERBS = Object.freeze(MACRO_TRIAL_VERBS.filter(verb =>
  MACRO_AUTOMATIC_SKILL_VERBS.some(allowed => allowed === verb)));

export interface TrustedSurvivalDisplay {
  readonly display: string;
  readonly authority: string;
  readonly stillOwned: () => boolean;
}

export function declareTerraStrategy(options: { maxRequests: number; task?: string }, wallMs: number) {
  return {
    strategy: "terra" as const, model: TERRA_MODEL_ID, task: options.task ?? null,
    limits: { maxRequests: options.maxRequests, maxRuntimeMs: wallMs, requestTimeoutMs: REQUEST_TIMEOUT_MS },
    frame: { source: "verified-game-display", format: "image/jpeg", maxBytes: FRAME_BYTES, timeoutMs: FRAME_TIMEOUT_MS },
    authoring: { adapterVersion: MACRO_TRIAL_ADAPTER_VERSION, lowRiskVerbs: LOW_RISK_VERBS },
  };
}

interface TerraAttemptOptions {
  readonly declaration: ReturnType<typeof declareTerraStrategy>;
  readonly dir: string;
  readonly projectRoot: string;
  readonly authDirectory: string;
  readonly actorJarSha256: string;
  readonly display: TrustedSurvivalDisplay;
  readonly width: number;
  readonly height: number;
  readonly ffmpeg: string;
  readonly signal: AbortSignal;
  readonly onDisplayLoss: () => void;
  readonly confirmNativeExit: () => Promise<boolean>;
}

function oneJpeg({ dir, display, width, height, ffmpeg }: TerraAttemptOptions, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(FRAME_TIMEOUT_MS)]);
  return new Promise<Buffer | undefined>((resolve, reject) => {
    if (deadline.aborted) { resolve(undefined); return; }
    const child = spawn(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "x11grab",
      "-probesize", "32", "-fpsprobesize", "0",
      "-draw_mouse", "0", "-framerate", "30", "-video_size", `${width}x${height}`,
      "-i", `${display.display}+0,0`, "-frames:v", "1", "-c:v", "mjpeg",
      "-threads", "1", "-q:v", "5", "-f", "image2pipe", "pipe:1",
    ], {
      cwd: dir, stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", DISPLAY: display.display, XAUTHORITY: display.authority },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let invalid = false;
    const kill = () => {
      invalid = true;
      child.kill("SIGKILL");
    };
    deadline.addEventListener("abort", kill, { once: true });
    child.on("error", () => { invalid = true; });
    child.stdout.on("error", kill);
    child.stdout.on("data", (chunk: Buffer) => {
      if (invalid) return;
      bytes += chunk.length;
      if (bytes > FRAME_BYTES) kill();
      else chunks.push(chunk);
    });
    child.once("close", code => {
      deadline.removeEventListener("abort", kill);
      if (signal.aborted) reject(signal.reason);
      else if (invalid || deadline.aborted || code !== 0 || bytes === 0) resolve(undefined);
      else resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bytes));
    });
    if (deadline.aborted) kill();
  });
}

/** Owns one admitted Terra lane. The deterministic runner never calls this module. */
export function composeTerraSurvival(options: TerraAttemptOptions) {
  const { actorJarSha256, declaration, dir, display, projectRoot, signal } = options;
  const run = path.basename(dir);
  const macroDir = path.join(dir, "macro");
  let controller: SurvivalMacroController | undefined;
  let skills: SurvivalMacroSkills | undefined;
  let terra: TerraStrategist | undefined;
  let trials: ReturnType<typeof createMacroTrials> | undefined;
  let admission: "not_opened" | "unavailable" | "admitted" = "not_opened";
  let displayLost = false;
  let drain: "not_started" | "closed" | "failed" = "not_started";
  let stopped: Promise<void> | undefined;

  function assertDisplay() {
    signal.throwIfAborted();
    if (display.stillOwned()) return;
    displayLost = true;
    options.onDisplayLoss();
    throw new Error("The run no longer owns its private Minecraft display.");
  }

  async function assertDispatch(basis: MacroBasis) {
    const fresh = await readMacroObservation(macroDir);
    assertDisplay();
    return fresh?.run === basis.run && fresh.life === basis.life && fresh.epoch === basis.epoch &&
      fresh.tick >= basis.tick && fresh.health > 0;
  }

  async function samePublishedBasis(observation: MacroObservation) {
    const fresh = await readMacroObservation(macroDir);
    return fresh?.run === observation.run && fresh.life === observation.life &&
      fresh.epoch === observation.epoch && fresh.tick === observation.tick && fresh.goal === observation.goal;
  }

  async function capture(observation: MacroObservation, workSignal: AbortSignal, requestId: string): Promise<MacroFrame | undefined> {
    assertDisplay();
    const captureSignal = AbortSignal.any([signal, workSignal]);
    if (!await samePublishedBasis(observation)) return;
    captureSignal.throwIfAborted();
    const bytes = await oneJpeg(options, captureSignal);
    assertDisplay();
    if (!bytes || !await samePublishedBasis(observation)) return;
    captureSignal.throwIfAborted();
    const relativePath = `${FRAME_DIRECTORY}/${requestId}.jpg`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = path.join(dir, relativePath);
    const temporary = `${file}.pending`;
    let archived = false;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx", signal: captureSignal });
      captureSignal.throwIfAborted();
      await rename(temporary, file);
      archived = true;
      captureSignal.throwIfAborted();
    } catch (error) {
      await unlink(archived ? file : temporary).catch(() => {});
      throw error;
    }
    const { life, epoch, tick } = observation;
    return {
      source: "verified-game-display", run, life, epoch, tick, mimeType: "image/jpeg",
      width: options.width, height: options.height, data: bytes,
      artifact: { relativePath, sha256, discard: () => unlink(file) },
    };
  }

  async function start() {
    assertDisplay();
    try {
      if (!path.isAbsolute(options.authDirectory) || !(await stat(options.authDirectory)).isDirectory())
        throw new Error("The explicit GameHarness data root is not an existing absolute directory.");
      terra = await openTerraStrategist({
        strategy: "terra", authDirectory: options.authDirectory, runId: run, signal,
        requestTimeoutMs: declaration.limits.requestTimeoutMs, assertDispatch,
      });
      admission = "admitted";
    } catch {
      signal.throwIfAborted();
      admission = "unavailable";
      throw new Error(`The existing GameHarness authorization could not admit ${TERRA_MODEL_ID}.`);
    }
    assertDisplay();
    await mkdir(path.join(dir, FRAME_DIRECTORY), { mode: 0o700 });
    const directory = path.join(dir, "macro-skills");
    await mkdir(directory, { mode: 0o700 });
    trials = createMacroTrials({ ordinaryDir: dir, actorJarSha256 });
    skills = new SurvivalMacroSkills({
      directory, projectRoot, worldId: run, actorJarSha256,
      capabilityVersion: MACRO_CAPABILITIES_VERSION, adapterVersion: MACRO_TRIAL_ADAPTER_VERSION,
      lowRiskVerbs: declaration.authoring.lowRiskVerbs, readTrial: trials.readTrial,
      isNeutralHandoff: observation => controller?.isNeutralHandoff(observation) ?? false,
    });
    const nativeReview = await createNativeGapReview({ runDir: dir, projectRoot, actorJarSha256, capabilityVersion: MACRO_CAPABILITIES_VERSION });
    controller = new SurvivalMacroController({
      runDir: dir, run, strategy: "terra", strategist: terra.infer, skills, trial: trials,
      nativeReview,
      objective: declaration.task ?? undefined, limits: declaration.limits, signal, frame: capture,
      confirmNativeExit: options.confirmNativeExit,
    });
    await controller.start();
  }

  async function close() {
    try {
      const settled = await Promise.allSettled([controller?.stop(), terra?.close()]);
      trials?.assertDrained();
      if (settled.some(step => step.status === "rejected") || controller?.status().unreportedDispatches)
        throw new Error("The Terra controller or inference could not be drained.");
    } finally {
      await skills?.close();
    }
  }

  function stop() {
    return stopped ??= close().then(() => { drain = "closed"; }, error => { drain = "failed"; throw error; });
  }

  function outcome() {
    const status = controller?.status() ?? null;
    const providerOutcome = status?.lastProviderOutcome;
    const result = drain === "failed" ? "cleanup_failed" : displayLost ? "display_lost" :
      admission === "unavailable" ? "provider_unavailable" : status?.state === "faulted" ? "protocol_fault" :
      status?.completedReceipts ? "native_effect_completed" :
      providerOutcome === "refused" || providerOutcome === "provider_error" || providerOutcome === "provider_unavailable"
        ? providerOutcome : status?.budget ? "budget_limited" : "no_completed_effect";
    return { ...declaration, admission, drain, outcome: result, status };
  }

  return { start, stop, outcome, assertDisplay };
}
