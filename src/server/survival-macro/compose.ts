import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createMacroTrials, MACRO_TRIAL_ADAPTER_VERSION, MACRO_TRIAL_VERBS } from "../../../survival-agent/macro-trial.ts";
import type { ProviderPendingSpan } from "../../../survival-agent/pause-evidence.ts";
import { hasConfirmedTerraEffect, TERRA_MODEL_ID, type SurvivalAgentGoal } from "../../shared/survival-agent-ui.ts";
import { PRE_SPAWN_GOAL_ONLY } from "./bootstrap.ts";
import {
  SurvivalMacroController, type DisplayCaptureFailure, type UnavailableFrame,
} from "./controller.ts";
import { createNativeGapReview } from "./gap-review.ts";
import { preparedStockReady, samePreparedStockView } from "./prepared-stock.ts";
import {
  MACRO_CAPABILITIES_VERSION, MACRO_LOOKAHEAD_MAX_CRACK, MACRO_MAX_PLANNING_IDLE_MS, MACRO_SMELT_OVERLAP_MIN_COOK_TICKS,
  liveCorrectionEvidence, readMacroObservation, sameLiveCorrectionScope, sameTravelTarget,
  type MacroBasis, type MacroInference, type MacroObservation,
} from "./protocol.ts";
import { MACRO_AUTOMATIC_SKILL_VERBS, SurvivalMacroSkills } from "./skills.ts";
import { openTerraStrategist, type TerraStrategist } from "./terra.ts";
import { createTrustedFrameCapture, FRAME_BYTES, FRAME_TIMEOUT_MS, initializeFrameArchive } from "./visual-capture.ts";

export { createTrustedFrameCapture };

const FRAME_PATH = "/usr/bin:/bin";
const inspect = promisify(execFile);
const REQUEST_TIMEOUT_MS = 35_000;
const LOW_RISK_VERBS = Object.freeze(MACRO_TRIAL_VERBS.filter(verb =>
  MACRO_AUTOMATIC_SKILL_VERBS.some(allowed => allowed === verb)));

export interface TrustedSurvivalDisplay {
  readonly display: string;
  readonly authority: string;
  readonly stillOwned: () => boolean;
}

export function declareTerraStrategy(
  options: { maxRequests: number; task?: string; startup?: "allow" | "off"; skillTrials?: "allow" | "off" }, wallMs: number,
  lane?: { preparedDiagnostic: true; shallowWork?: true; brakeWork?: never } |
    { preparedDiagnostic: true; brakeWork: true; shallowWork?: never },
) {
  const preparedDiagnostic = lane?.preparedDiagnostic === true;
  const stockFooting = lane?.brakeWork ? "dry" : lane?.shallowWork ? "shallow_water_with_bank" : undefined;
  if (stockFooting && (!options.task || options.maxRequests !== 1))
    throw new Error("Prepared stock work requires a goal and one live Terra request.");
  return {
    strategy: "terra" as const, model: TERRA_MODEL_ID, task: options.task ?? null, preparedDiagnostic,
    startup: preparedDiagnostic ? "off" as const : options.startup ?? "allow",
    workMode: preparedDiagnostic && !stockFooting ? null : options.task ? "constrained" : "preset",
    ...(stockFooting === "dry" ? { brakeWork: true as const } : {}),
    limits: { maxRequests: options.maxRequests, maxRuntimeMs: wallMs, requestTimeoutMs: REQUEST_TIMEOUT_MS,
      planningIdleMs: MACRO_MAX_PLANNING_IDLE_MS },
    frame: { source: "verified-game-display", format: "image/jpeg", maxBytes: FRAME_BYTES, timeoutMs: FRAME_TIMEOUT_MS },
    authoring: preparedDiagnostic || options.skillTrials === "off" ? null
      : { adapterVersion: MACRO_TRIAL_ADAPTER_VERSION, lowRiskVerbs: LOW_RISK_VERBS },
  };
}

interface TerraAttemptOptions {
  readonly declaration: ReturnType<typeof declareTerraStrategy>;
  readonly firstPlanGoal?: SurvivalAgentGoal;
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
  readonly onProviderDispatch?: (event: { basis: MacroBasis; startedAtMs: number; wallMs: number }) => void;
  readonly onProviderSettled?: (event: {
    basis: MacroBasis; settledAtMs: number; wallMs: number; outcome: MacroInference["outcome"];
    providerTerminalAtMs?: number; providerTerminalWallMs?: number;
  }) => void;
}

type CaptureOptions = Pick<TerraAttemptOptions, "dir" | "display" | "width" | "height" | "ffmpeg" | "signal">;
type CaptureCommand = { readonly adapter: "scrot" | "ffmpeg"; readonly file: string; readonly args: string[] };
type CapturedJpeg = { readonly bytes: Buffer; readonly adapter?: CaptureCommand["adapter"] };

function unavailable(failure: DisplayCaptureFailure, adapter?: CaptureCommand["adapter"]): UnavailableFrame {
  return { cause: "unavailable", failure, ...(adapter ? { adapter } : {}) };
}

async function jpegCommand({ display, width, height, ffmpeg, signal }: CaptureOptions): Promise<CaptureCommand> {
  const scrot = Bun.which("scrot", { PATH: FRAME_PATH });
  if (scrot) {
    // Older scrot versions cannot reliably write a selected format to stdout.
    // Probe once without connecting to any display.
    const version = await inspect(scrot, ["--version"], {
      signal, timeout: 500, killSignal: "SIGKILL", maxBuffer: 1_024, env: { PATH: FRAME_PATH, LANG: "C.UTF-8" },
    }).then(({ stdout }) => /\bscrot version (\d+)\.(\d+)\b/i.exec(stdout), () => null);
    signal.throwIfAborted();
    if (version && (+version[1]! > 1 || (+version[1]! === 1 && +version[2]! >= 10))) {
      return { adapter: "scrot", file: scrot, args: ["-z", "-D", display.display, "--format", "jpg", "-q", "85", "-F", "-"] };
    }
  }
  return { adapter: "ffmpeg", file: ffmpeg, args: [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "x11grab",
    "-probesize", "32", "-fpsprobesize", "0",
    "-draw_mouse", "0", "-framerate", "30", "-video_size", `${width}x${height}`,
    "-i", `${display.display}+0,0`, "-frames:v", "1", "-c:v", "mjpeg",
    "-threads", "1", "-q:v", "5", "-f", "image2pipe", "pipe:1",
  ] };
}

function captureProcess(
  { dir, display }: CaptureOptions, command: CaptureCommand, signal: AbortSignal, outputFd?: number,
) {
  return new Promise<Buffer | DisplayCaptureFailure | undefined>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const child = spawn(command.file, command.args, {
      cwd: dir, stdio: ["ignore", outputFd ?? "pipe", "ignore"],
      env: { PATH: FRAME_PATH, HOME: dir, LANG: "C.UTF-8", DISPLAY: display.display, XAUTHORITY: display.authority },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: DisplayCaptureFailure | undefined;
    const kill = (reason: DisplayCaptureFailure) => {
      failure ??= reason;
      child.kill("SIGKILL");
    };
    const onAbort = () => kill("timeout");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => { failure ??= "spawn_failed"; });
    child.stdout?.on("error", () => kill("io_error"));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > FRAME_BYTES) kill("output_too_large");
      else chunks.push(chunk);
    });
    child.once("close", code => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else if (failure) resolve(failure);
      else if (code !== 0) resolve("process_failed");
      else if (outputFd !== undefined) resolve(undefined);
      else if (bytes === 0) resolve("empty_output");
      else resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bytes));
    });
    if (signal.aborted) onAbort();
  });
}

async function oneJpeg(
  options: CaptureOptions, command: CaptureCommand, signal: AbortSignal, temporary: string,
): Promise<CapturedJpeg | UnavailableFrame> {
  const { adapter } = command;
  if (adapter === "ffmpeg") {
    const result = await captureProcess(options, command, signal);
    return Buffer.isBuffer(result) ? { bytes: result, adapter } : unavailable(result ?? "empty_output", adapter);
  }
  // scrot reopens /dev/stdout. Give it a private anonymous scratch fd, not a Bun
  // pipe (a socket) or the model frame archive.
  const file = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .catch(() => undefined);
  if (!file) return unavailable("io_error", adapter);
  let detached = false;
  try {
    await unlink(temporary);
    detached = true;
    const result = await captureProcess(options, command, signal, file.fd);
    if (typeof result === "string") return unavailable(result, adapter);
    const { size } = await file.stat();
    if (size === 0) return unavailable("empty_output", adapter);
    if (size > FRAME_BYTES) return unavailable("output_too_large", adapter);
    const bytes = Buffer.allocUnsafe(size);
    const { bytesRead } = await file.read(bytes, 0, size, 0);
    if (bytesRead !== size) return unavailable("io_error", adapter);
    return { bytes, adapter };
  } catch {
    signal.throwIfAborted();
    return unavailable("io_error", adapter);
  } finally {
    try { await file.close(); }
    finally { if (!detached) await unlink(temporary); }
  }
}

export async function openTrustedFrameCapture(options: CaptureOptions & { assertDisplay: () => void; native?: boolean }) {
  await initializeFrameArchive(options.dir);
  options.assertDisplay();
  let command: CaptureCommand | undefined;
  return createTrustedFrameCapture({
    ...options,
    // Startup goal-only inference and successful native capture never initialize X11 capture.
    readJpeg: async (signal, temporary) => {
      const selected = command ??= await jpegCommand({ ...options, signal });
      signal.throwIfAborted();
      return oneJpeg(options, selected, signal, temporary);
    },
  });
}

/** Owns one admitted Terra lane. The deterministic runner never calls this module. */
export function composeTerraSurvival(options: TerraAttemptOptions) {
  const { actorJarSha256, declaration, dir, display, firstPlanGoal, projectRoot, signal, onProviderDispatch, onProviderSettled } = options;
  if (!declaration.preparedDiagnostic && (onProviderDispatch || onProviderSettled))
    throw new Error("Only a prepared diagnostic can observe Terra provider timing.");
  if (declaration.preparedDiagnostic && path.dirname(dir) !== path.join(projectRoot, "local/survival-agent/diagnostic-runs"))
    throw new Error("Prepared Terra strategy requires a diagnostic run directory.");
  if (firstPlanGoal !== undefined && (declaration.preparedDiagnostic || declaration.startup !== "allow"))
    throw new Error("This Terra attempt did not admit goal-only startup inference.");
  const run = path.basename(dir);
  const macroDir = path.join(dir, "macro");
  const stockFooting = declaration.preparedDiagnostic && declaration.workMode === "constrained"
    ? declaration.brakeWork ? "dry" : "shallow_water_with_bank" : undefined;
  let controller: SurvivalMacroController | undefined;
  let skills: SurvivalMacroSkills | undefined;
  let terra: TerraStrategist | undefined;
  let trials: ReturnType<typeof createMacroTrials> | undefined;
  let admission: "not_opened" | "unavailable" | "admitted" = "not_opened";
  let authLost = false;
  let displayLost = false;
  let closing = false;
  let drain: "not_started" | "closed" | "failed" = "not_started";
  let stopped: Promise<void> | undefined;
  const providerSpans: ProviderPendingSpan[] = [];
  let incompleteProviderSpans = false;

  function rememberDispatch(osNs: bigint, stage: NonNullable<ProviderPendingSpan["stage"]>) {
    if (providerSpans.at(-1)?.endNs === null || providerSpans.length >= declaration.limits.maxRequests)
      incompleteProviderSpans = true;
    else providerSpans.push({ startNs: osNs, endNs: null, terminalObserved: false, stage });
  }

  function rememberSettlement(osNs: bigint, terminalOsNs?: bigint) {
    const pending = providerSpans.at(-1);
    if (!pending || pending.endNs !== null) incompleteProviderSpans = true;
    else providerSpans[providerSpans.length - 1] = {
      startNs: pending.startNs, endNs: terminalOsNs ?? osNs, terminalObserved: terminalOsNs !== undefined, stage: pending.stage,
    };
  }

  function assertDisplay() {
    signal.throwIfAborted();
    if (display.stillOwned()) return;
    displayLost = true;
    options.onDisplayLoss();
    throw new Error("The run no longer owns its private Minecraft display.");
  }

  async function assertDispatch(basis: MacroBasis, lookahead?: MacroObservation, work?: MacroObservation, correction?: MacroObservation) {
    const fresh = await readMacroObservation(macroDir, !!correction);
    assertDisplay();
    if (stockFooting && (!work || !fresh || !samePreparedStockView(work, fresh, stockFooting))) return false;
    const burn = work?.workOrder?.progress?.smeltBurn;
    const activeBurn = fresh?.workOrder?.progress?.smeltBurn;
    const ticket = work?.pendingWork;
    const activeTicket = fresh?.pendingWork;
    const travel = work?.travelHint;
    const independent = ticket?.parked && !ticket.worksite && (work?.workOrder?.state === "working" || work?.workOrder?.state === "needs_replan")
      ? work.workOrder : undefined;
    return fresh?.run === basis.run && fresh.life === basis.life && (work ? fresh.epoch >= basis.epoch : fresh.epoch === basis.epoch) &&
      fresh.tick >= basis.tick && fresh.health > 0 &&
      (!correction || (sameLiveCorrectionScope(correction, fresh) && liveCorrectionEvidence(correction) === liveCorrectionEvidence(fresh))) &&
      (!work || (fresh.goal === work.goal && fresh.health >= work.health && fresh.safety?.clear === true &&
        fresh.safety.revision === work.safety?.revision)) &&
      (!travel || (fresh.stance === work?.stance && fresh.epoch === basis.epoch &&
        fresh.travelHint?.kind === travel.kind && sameTravelTarget(travel, fresh.travelHint))) &&
      (!burn || (fresh.workOrder?.id === work?.workOrder?.id && fresh.workOrder?.state === "working" &&
        activeBurn?.burnTick === burn.burnTick && activeBurn.units === burn.units &&
        (ticket?.yieldable || activeBurn.remainingCookTicks >= MACRO_SMELT_OVERLAP_MIN_COOK_TICKS))) &&
      (!ticket || (activeTicket?.id === ticket.id && activeTicket.parked === ticket.parked &&
        (!ticket.yieldable || activeTicket.yieldable))) &&
      (!independent || (fresh.workOrder?.id === independent.id &&
        (fresh.workOrder.state === "working" || fresh.workOrder.state === "needs_replan"))) &&
      (!lookahead || (fresh.goal === lookahead.goal && fresh.health >= lookahead.health && fresh.safety?.clear === true &&
        fresh.safety.revision === lookahead.safety?.revision && !!fresh.working &&
        fresh.working.intentId === lookahead.working?.intentId && fresh.working.crack <= MACRO_LOOKAHEAD_MAX_CRACK));
  }

  async function assertFirstPlanDispatch() {
    // An existing native publication (even one not readable right now)
    // ends the no-observation stage. No bytes are read or sent on this path.
    const absent = await lstat(path.join(macroDir, "observation.json")).then(() => false, error => {
      if (error?.code === "ENOENT") return true;
      throw error;
    });
    assertDisplay();
    return absent && !closing;
  }

  async function start() {
    assertDisplay();
    try {
      if (!path.isAbsolute(options.authDirectory) || !(await stat(options.authDirectory)).isDirectory())
        throw new Error("The explicit GameHarness data root is not an existing absolute directory.");
      let observedDispatch = false, observedSettlement = false;
      terra = await openTerraStrategist({
        strategy: "terra", authDirectory: options.authDirectory, runId: run, signal,
        requestTimeoutMs: declaration.limits.requestTimeoutMs, assertDispatch,
        ...(stockFooting ? { preparedStock: stockFooting } : {}),
        ...(firstPlanGoal !== undefined ? {
          assertFirstPlanDispatch,
          onFirstPlanDispatch: ({ osNs }) => rememberDispatch(osNs, PRE_SPAWN_GOAL_ONLY),
          onFirstPlanSettled: ({ osNs, providerTerminalOsNs }) => rememberSettlement(osNs, providerTerminalOsNs),
        } : {}),
        onProviderDispatch: ({ basis, monotonicMs, wallMs, osNs }) => {
          rememberDispatch(osNs, "live_observation");
          if (!onProviderDispatch || observedDispatch) return;
          observedDispatch = true;
          onProviderDispatch({ basis, startedAtMs: monotonicMs, wallMs });
        },
        onProviderSettled: ({
          basis, monotonicMs, wallMs, osNs, outcome, providerTerminalMonotonicMs, providerTerminalWallMs, providerTerminalOsNs,
        }) => {
          rememberSettlement(osNs, providerTerminalOsNs);
          if (!onProviderSettled || observedSettlement) return;
          observedSettlement = true;
          onProviderSettled({
            basis, settledAtMs: monotonicMs, wallMs, outcome,
            ...(providerTerminalMonotonicMs !== undefined && providerTerminalWallMs !== undefined
              ? { providerTerminalAtMs: providerTerminalMonotonicMs, providerTerminalWallMs } : {}),
          });
        },
      });
      admission = "admitted";
      const observeRevocation = () => { if (!closing && !signal.aborted) authLost = true; };
      terra.authoritySignal.addEventListener("abort", observeRevocation, { once: true });
      if (terra.authoritySignal.aborted) observeRevocation();
    } catch {
      signal.throwIfAborted();
      admission = "unavailable";
      throw new Error(`The existing GameHarness authorization could not admit ${TERRA_MODEL_ID}.`);
    }
    assertDisplay();
    const capture = await openTrustedFrameCapture({ ...options, assertDisplay, native: !declaration.preparedDiagnostic });
    const authoring = declaration.preparedDiagnostic ? null : declaration.authoring;
    if (authoring) {
      const directory = path.join(dir, "macro-skills");
      await mkdir(directory, { mode: 0o700 });
      trials = createMacroTrials({ ordinaryDir: dir, actorJarSha256 });
      skills = new SurvivalMacroSkills({
        directory, projectRoot, worldId: run, actorJarSha256,
        capabilityVersion: MACRO_CAPABILITIES_VERSION, adapterVersion: authoring.adapterVersion,
        lowRiskVerbs: authoring.lowRiskVerbs, readTrial: trials.readTrial,
        isNeutralHandoff: observation => controller?.isNeutralHandoff(observation) ?? false,
      });
    }
    const nativeReview = declaration.preparedDiagnostic ? undefined :
      await createNativeGapReview({ runDir: dir, projectRoot, actorJarSha256, capabilityVersion: MACRO_CAPABILITIES_VERSION });
    controller = new SurvivalMacroController({
      runDir: dir, run, strategy: "terra", strategist: terra.infer, skills, trial: trials,
      nativeReview, durableWork: declaration.workMode !== null,
      ...(stockFooting ? { preparedStockReady: preparedStockReady(stockFooting) } : {}),
      objective: declaration.task ?? undefined, limits: declaration.limits,
      ...(firstPlanGoal !== undefined ? {
        firstPlan: { request: { goal: firstPlanGoal, objective: declaration.task?.trim() }, infer: terra.firstPlan },
      } : {}),
      signal: AbortSignal.any([signal, terra.authoritySignal]), frame: capture,
      confirmNativeExit: options.confirmNativeExit,
    });
    await controller.start();
  }

  async function close() {
    closing = true;
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
      admission === "unavailable" || authLost ? "provider_unavailable" : status?.state === "faulted" ? "protocol_fault" :
      hasConfirmedTerraEffect(status) ? "native_effect_completed" :
      providerOutcome === "refused" || providerOutcome === "provider_error" || providerOutcome === "provider_unavailable"
        ? providerOutcome : status?.budget ? "budget_limited" : "no_completed_effect";
    return { ...declaration, admission, authLost, drain, outcome: result, status };
  }

  const providerTimeline = () => admission === "admitted" && !incompleteProviderSpans ? providerSpans : undefined;
  return { start, stop, outcome, assertDisplay, providerTimeline,
    stockNotExercised: () => controller?.stockNotExercised() };
}
