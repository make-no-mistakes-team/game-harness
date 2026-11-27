#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { constants, lstatSync, readFileSync } from "node:fs";
import { access, appendFile, chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SURVIVAL_AGENT_GOALS as GOALS, type SurvivalAgentGoal as Goal } from "../shared/goals.ts";
import { JAVA, MinecraftClient, privateJson } from "../minecraft/client.ts";
import { nativeLaunchFailure } from "../minecraft/launch-fault.ts";
import { osMonotonicNs } from "./paths.ts";
import { ModelActorCompatibilityError } from "../minecraft/mod-artifact.ts";
import { composeMacroStrategist } from "../strategist/strategist.ts";
import { offlineUuid, poolDiagnosticServerProperties, poolDiagnosticWorld, provisionPoolDiagnostic } from "../diagnostics/pool.ts";
import { closedParentDeath, FAST_DEATH_LIMIT, FAST_DEATH_WINDOW_MS, LIFE_RECEIPTS, LifeLedger, lifeReceiptReader,
  RESPAWN_MARKER, RESPAWN_TIMEOUT_MS } from "./lives.ts";
import { currentKernelBootMs, openOrphanAutosave, ordinaryRunBasename as RUN_BASENAME,
  orphanAutosaveProvenance, readCrashAutosave } from "./crash-autosave.ts";
import { admitRun, diskBytes } from "./storage.ts";
import { finalPauseEvidence, PAUSE_DIAGNOSTICS } from "./pause-evidence.ts";
import { readStrategy, type StrategyOptions } from "./strategy-options.ts";
import { readSavedPlayerStats, savedDeathDelta, verifySurvival } from "./verify.ts";
import { openOperatorStop, serverSaveEvidence } from "./operator-stop.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const RUNTIME = path.join(ROOT, "local/runtime");
const AGENT_LOCAL = path.join(ROOT, "local/survival-agent");
const RUNS = path.join(AGENT_LOCAL, "runs");
const LIVE = path.join(AGENT_LOCAL, "live.json");
const PARALLEL_LIVE = path.join(AGENT_LOCAL, "parallel-live.json");
const DIAGNOSTIC_RUNS = path.join(AGENT_LOCAL, "diagnostic-runs");
const DIAGNOSTIC_LIVE = path.join(AGENT_LOCAL, "diagnostic-live.json");
const HISTORIC_RUNS = path.join(ROOT, "local/survival-pilot/runs");
const SERVER_JAR = path.join(RUNTIME, "minecraft/server-1.21.4.jar");
const AGENT_JAR = path.join(ROOT, "mod/build/libs/survival-agent-1.0.jar");
const DEFAULT_SECONDS = 900;
const MAX_SECONDS = Math.floor(2_147_483_647 / 1_000);
const SCREEN = { width: 1280, height: 720 } as const;
const SIZE = `${SCREEN.width}x${SCREEN.height}`;
const STARTUP_MS = 120_000;
const HEARTBEAT_MS = 20_000;
const RUNNER_STOP_GRACE_MS = 1_500;
const STALL_MS = 180_000;
const GOAL_STALL_MS = 300_000;
const DRAIN_HEADROOM = 128_000_000;
const SERVER_SHUTDOWN_LIMITS = {
  stopAcknowledgementMs: 12_000,
  savePhaseMs: 35_000,
  finalExitMs: 10_000,
  gracefulTotalMs: 60_000,
  termMs: 5_000,
} as const;
const DETERMINISTIC_STRATEGY = {
  strategy: "deterministic", model: null, task: null, limits: { maxRequests: 0, maxRuntimeMs: 0, requestTimeoutMs: 0 },
} as const;
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Owned = { child: ChildProcess; closed: Promise<Exit>; exit?: Exit };
type Progress = {
  failure?: string;
  stall_phase?: string;
  stall_detail?: string;
  dimension?: string;
  rock_broken?: number;
  frame_blocks?: number;
  ignited?: boolean;
  cast_frame_blocks?: number;
  tick: number;
  goal: string;
  status: string;
  won: boolean;
  wall_ms?: number;
  deaths?: number;
  respawns?: number;
  life?: number;
  life_phase?: "playing" | "death_screen" | "respawn_requested";
  macro_fallback_ticks?: number;
} & ({
  alive: true;
  inventory: Record<string, number>;
  x: number;
  y: number;
  z: number;
  health: number;
} | {
  alive: false;
  inventory?: Record<string, number>;
  x?: number;
  y?: number;
  z?: number;
  health?: number;
});
type PlayingProgress = Extract<Progress, { alive: true }>;
const STATUSES = ["won", "died", "respawn_timeout", "startup_limit", "wall_limit", "heartbeat_lost",
  "stalled", "goal_stalled", "storage_limit", "recording_limit", "interrupted",
  "server_exit", "client_exit", "recorder_exit", "unverified", "failed"] as const;
type Status = (typeof STATUSES)[number];

class Stop extends Error {
  constructor(readonly status: Status, message: string) { super(message); }
}

const usage = `GameHarness Survival

Usage: bun run play:agent [--parallel-world] [--diagnostic-reveal-ores] [--strategy model --model PROVIDER/MODEL [--macro-requests N]] GOAL [SECONDS [(--continue-from | --recover-crash-autosave | --recover-orphan-autosave | --replay-incident) RUN_BASENAME]]
       bun run diagnose:pool [SECONDS]

GOAL: ${GOALS.join(" | ")}
SECONDS: wall limit including startup, 1–${MAX_SECONDS} (default ${DEFAULT_SECONDS}).
--continue-from copies an eligible closed, recorded Survival world.
--recover-crash-autosave explicitly copies an ordinary autosave after a host reboot.
--recover-orphan-autosave requires SURVIVAL_AGENT_ORPHAN_SCOPE and confirmed source closure.
--replay-incident uses the diagnostic lane; it is not fresh gameplay.
--diagnostic-reveal-ores exposes loaded ore coordinates and cannot establish campaign proof or be continued.
--parallel-world uses the second lane for ordinary fresh or clean continuation runs.
Model advice is asynchronous; local play continues without a reply.
Build with bun run build:agent first; requires Java 21, FFmpeg, EULA consent and an official Launcher session.
Stop with bun run stop:agent RUN_BASENAME. Only a verified goal exits 0.`;

type Diagnostic = "pool" | "incident-replay";

const parallelWorldUsage = "--parallel-world is only available for ordinary fresh or clean continuation runs.";

function readParallelWorld(rawArgs: string[]) {
  let parallelWorld = false;
  let revealOres = false;
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--parallel-world") {
      if (parallelWorld) throw new Error("Repeated --parallel-world.");
      parallelWorld = true;
    } else if (arg === "--diagnostic-reveal-ores") {
      if (revealOres) throw new Error("Repeated --diagnostic-reveal-ores.");
      revealOres = true;
    } else {
      args.push(arg);
      // A free-form strategy task may literally be "--parallel-world".
      if (arg === "--task" && i + 1 < rawArgs.length) args.push(rawArgs[++i]!);
    }
  }
  if (parallelWorld && args[0]?.startsWith("--diagnostic-")) throw new Error(parallelWorldUsage);
  return { args, parallelWorld, revealOres };
}

function parseArgs(args: string[]) {
  const [rawGoal, rawSeconds = String(DEFAULT_SECONDS), flag, parentRun] = args;
  const pool = rawGoal === "--diagnostic-pool";
  const goal = pool ? "nether_portal" : GOALS.find((item) => item === rawGoal);
  const seconds = Number(rawSeconds);
  if (!goal || (args.length > 2 && (pool || args.length !== 4 ||
      (flag !== "--continue-from" && flag !== "--recover-crash-autosave" &&
        flag !== "--recover-orphan-autosave" && flag !== "--replay-incident") ||
      !parentRun || !RUN_BASENAME.test(parentRun))) || !/^\d+$/.test(rawSeconds) ||
      !Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
    throw new Error(usage);
  }
  const diagnostic: Diagnostic | undefined = pool ? "pool" : flag === "--replay-incident" ? "incident-replay" : undefined;
  const recoveryMode = flag === "--recover-crash-autosave" ? "previous-boot" as const :
    flag === "--recover-orphan-autosave" ? "same-boot" as const : undefined;
  return { goal, seconds, parentRun, diagnostic, recoveryMode };
}

async function isolatedDisplay() {
  const display = process.env.DISPLAY;
  const authority = process.env.XAUTHORITY;
  const number = display?.match(/^:(\d+)$/)?.[1];
  const xServer = Bun.which("Xvfb");
  const rejected = () => new Error("Run this command under xvfb-run; refusing to use a desktop display.");
  if (!display || !number || !Number.isSafeInteger(Number(number)) || Number(number) < 90 || !authority || !xServer)
    throw rejected();
  try {
    const lockPath = `/tmp/.X${number}-lock`;
    const lock = (await readFile(lockPath, "utf8")).trim();
    if (!/^[1-9]\d*$/.test(lock)) throw rejected();
    const proc = `/proc/${lock}`;
    const [running, expected, cmdline, authFile, initialProc] = await Promise.all([
      realpath(`${proc}/exe`), realpath(xServer), readFile(`${proc}/cmdline`, "utf8"), realpath(authority),
      readFile(`${proc}/stat`, "utf8"),
    ]);
    const args = cmdline.split("\0");
    const authIndex = args.indexOf("-auth");
    const screen = args.indexOf("-screen");
    const offline = args.some((arg, index) => arg === "-nolisten" && args[index + 1] === "tcp");
    if (running !== expected || args[1] !== display || authIndex < 0 || screen < 0 ||
        args[screen + 1] !== "0" || args[screen + 2] !== `${SIZE}x24` || args.includes("-ac") ||
        args.some((arg, index) => arg === "-listen" && args[index + 1] === "tcp") ||
        !offline || await realpath(args[authIndex + 1]!) !== authFile) throw rejected();
    const procFields = (text: string) => text.slice(text.lastIndexOf(")") + 2).split(" ");
    const parent = process.ppid;
    const born = procFields(initialProc)[19];
    const authStat = await lstat(authFile, { bigint: true });
    const uid = BigInt(process.getuid!());
    const stillOwned = () => {
      try {
        const fields = procFields(readFileSync(`${proc}/stat`, "utf8"));
        const check = lstatSync(authFile, { bigint: true });
        return !!born && fields[0] !== "Z" && fields[0] !== "X" && fields[19] === born &&
          process.ppid === parent && Number(fields[1]) === parent &&
          readFileSync(lockPath, "utf8").trim() === lock && check.isFile() &&
          check.uid === uid && (check.mode & 0o077n) === 0n && check.size > 0n &&
          check.dev === authStat.dev && check.ino === authStat.ino && check.ctimeNs === authStat.ctimeNs;
      } catch { return false; }
    };
    if (!stillOwned()) throw rejected();
    return { display, authority: authFile, stillOwned };
  } catch {
    throw rejected();
  }
}

async function verifyInputs(actorJar: string, requiresModelWorkWire: boolean) {
  const hasConsent = async (directory: string) => {
    const consent = await readFile(path.join(directory, "provisioning-consent.json"), "utf8")
      .then((content) => JSON.parse(content)).catch(() => null);
    return consent?.eulaAccepted === true && consent.minecraftVersion === "1.21.4" &&
      consent.eulaUrl === "https://www.minecraft.net/en-us/eula";
  };
  if (!(await hasConsent(RUNTIME)) &&
      !(process.env.GAMEHARNESS_DATA_DIR && await hasConsent(process.env.GAMEHARNESS_DATA_DIR))) {
    throw new Error("Existing explicit Minecraft 1.21.4 EULA consent is required.");
  }
  await access(SERVER_JAR, constants.R_OK);
  await access(actorJar, constants.R_OK).catch(() => {
    if (requiresModelWorkWire) throw new ModelActorCompatibilityError();
    throw new Error(actorJar === AGENT_JAR ? "Run `bun run build:agent` to build survival-agent-1.0.jar first." :
      "The ordinary run's pinned actor artifact is unavailable.");
  });
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required for the run recording.");
  const java21 = "/usr/lib/jvm/java-21-openjdk-amd64/bin/java";
  const java = process.env.JAVA_HOME ? JAVA :
    await access(java21, constants.X_OK).then(() => java21, () => JAVA);
  return { java, ffmpeg };
}

// Let the kernel choose a temporary loopback port, then let only our new server
// claim it. A conflicting bind fails startup; clients wait for this server's log.
async function loopbackPort(): Promise<number> {
  const socket = createServer();
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = socket.address();
      socket.close((error) => {
        if (error) reject(error);
        else if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Could not allocate a loopback port."));
      });
    });
  });
}

function own(child: ChildProcess, closed?: Promise<Exit>): Owned {
  const owned: Owned = {
    child,
    closed: closed ?? new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  };
  child.on("error", () => {});
  child.stdin?.on("error", () => {});
  void owned.closed.then((exit) => { owned.exit = exit; });
  return owned;
}

function signalGroup(owned: Owned, signal: NodeJS.Signals) {
  const pid = owned.child.pid;
  if (pid !== undefined && !owned.exit) {
    try { process.kill(-pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function waitClosed(owned: Owned, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      owned.closed.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function drain(owned: Owned | undefined, command?: string, graceMs = 3_000) {
  if (!owned || owned.exit) return;
  if (command) owned.child.stdin?.write(command);
  else signalGroup(owned, "SIGTERM");
  if (await waitClosed(owned, graceMs)) return;
  if (command) {
    signalGroup(owned, "SIGTERM");
    if (await waitClosed(owned, 2_000)) return;
  }
  signalGroup(owned, "SIGKILL");
  await owned.closed;
}

function vanillaSavePhase(line: string) {
  const message = line.replace(/^.*\[Server thread\/INFO\]: /, "").trimEnd();
  if (message === "Stopping server") return "stop_acknowledged";
  if (message === "Saving players") return "saving_players";
  if (message === "Saving worlds") return "saving_worlds";
  if (message === "ThreadedAnvilChunkStorage: All dimensions are saved") return "dimensions_saved";
  const dimension = /^Saving chunks for level '[^']+'\/minecraft:(overworld|the_nether|the_end)$/.exec(message)?.[1];
  if (dimension) return `saving_${dimension}`;
  const storage = /^ThreadedAnvilChunkStorage \((world|DIM-1|DIM1)\): All chunks are saved$/.exec(message)?.[1];
  if (storage) return `saved_${storage}`;
}

async function drainVanillaServer(owned: Owned | undefined) {
  if (!owned || owned.exit) return null;
  const start = performance.now();
  const elapsedMs = () => Math.round(performance.now() - start);
  const hardDeadline = start + SERVER_SHUTDOWN_LIMITS.gracefulTotalMs;
  const phases: { phase: string; elapsedMs: number }[] = [];
  const seen = new Set<string>();
  const stdout = owned.child.stdout;
  const graceful = await new Promise<boolean>((resolve) => {
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (closed: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stdout?.off("data", onOutput);
      resolve(closed);
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(false), Math.max(0, Math.min(ms, hardDeadline - performance.now())));
    };
    const onOutput = (chunk: Buffer) => {
      const lines = (pending + chunk.toString("utf8")).split("\n");
      pending = (lines.pop() ?? "").slice(-2048);
      for (const line of lines) {
        const phase = vanillaSavePhase(line);
        if (!phase || seen.has("dimensions_saved") || seen.has(phase)) continue;
        seen.add(phase);
        phases.push({ phase, elapsedMs: elapsedMs() });
        // Chunk writes can be silent for seconds. Only a new vanilla save phase
        // earns more time, and no phase can extend the absolute shutdown cap.
        arm(phase === "dimensions_saved" ? SERVER_SHUTDOWN_LIMITS.finalExitMs : SERVER_SHUTDOWN_LIMITS.savePhaseMs);
      }
    };
    stdout?.on("data", onOutput);
    void owned.closed.then(() => finish(true));
    arm(SERVER_SHUTDOWN_LIMITS.stopAcknowledgementMs);
    owned.child.stdin?.write("stop\n");
  });
  let escalation: "SIGTERM" | "SIGKILL" | null = null;
  if (!graceful && !owned.exit) {
    escalation = "SIGTERM";
    signalGroup(owned, escalation);
    if (!await waitClosed(owned, SERVER_SHUTDOWN_LIMITS.termMs)) {
      escalation = "SIGKILL";
      signalGroup(owned, escalation);
      await owned.closed;
    }
  }
  return { shutdownMs: elapsedMs(), escalation, phases, dimensionsSaved: seen.has("dimensions_saved") };
}

export async function savedWorld(parentRun: string, goal: Goal, signal: AbortSignal,
    roots: readonly string[] = [RUNS, HISTORIC_RUNS]) {
  const invalid = () => new Error(`Cannot continue from ${parentRun}: expected a unique closed, recorded Survival attempt with a clean save and an eligible goal.`);
  try {
    let runsRoot: string | undefined;
    for (const candidate of roots) {
      signal.throwIfAborted();
      const found = await lstat(path.join(candidate, parentRun)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (!found) continue;
      if (runsRoot) throw invalid();
      runsRoot = candidate;
    }
    if (!runsRoot) throw invalid();
    const historic = runsRoot === HISTORIC_RUNS;
    const root = path.join(runsRoot, parentRun);
    const server = path.join(root, "server");
    const world = path.join(server, "world");
    const uid = process.getuid?.();
    const [privateRoot, runs] = await Promise.all([lstat(path.dirname(runsRoot)), lstat(runsRoot)]);
    if (!privateRoot.isDirectory() || privateRoot.uid !== uid || !runs.isDirectory() || runs.uid !== uid)
      throw invalid();
    const device = runs.dev;
    let rootInode = 0;
    for (const dir of [root, server, world, path.join(world, "region")]) {
      signal.throwIfAborted();
      const entry = await lstat(dir);
      if (!entry.isDirectory() || entry.dev !== device || entry.uid !== uid ||
          (dir === root && (entry.mode & 0o077))) throw invalid();
      if (dir === root) rootInode = entry.ino;
    }
    const regular = async (file: string) => {
      signal.throwIfAborted();
      const entry = await lstat(file);
      if (!entry.isFile() || entry.nlink !== 1 || entry.dev !== device || entry.uid !== uid || !entry.size) throw invalid();
      return entry;
    };
    const readRecord = async (name: string) => {
      const file = path.join(root, name);
      const entry = await regular(file);
      if (entry.size > 64_000) throw invalid();
      return JSON.parse(await readFile(file, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW, signal }));
    };
    const declaration = await readRecord("declaration.json");
    const outcome = await readRecord("outcome.json");
    if (declaration.claimScope === "ore-assisted-diagnostic" || declaration.campaignProof === false)
      throw invalid();
    // Historical declarations keep their original field name; new runs never write it.
    const jarSha256 = historic ? declaration?.pilotJarSha256 : declaration?.agentJarSha256;
    const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
    const worldProof = declaration?.world;
    // Older fresh attempts recorded the world only in the declaration.
    const fresh = worldProof?.fresh === true && worldProof.seed === "random" &&
      (!outcome?.world || outcome.world.fresh === true);
    const continued = worldProof?.fresh === false && typeof worldProof.parentRun === "string" &&
      RUN_BASENAME.test(worldProof.parentRun) && outcome?.world?.fresh === false &&
      outcome.world.parentRun === worldProof.parentRun;
    const declaredRecovery = worldProof?.crashAutosave;
    const recordedRecovery = outcome?.world?.crashAutosave;
    let orphanProof: string | undefined;
    if (declaredRecovery?.kind === "same-boot-orphan-autosave" || recordedRecovery?.kind === "same-boot-orphan-autosave") {
      const declared = orphanAutosaveProvenance.parse(declaredRecovery);
      orphanProof = JSON.stringify(declared);
      if (!continued || historic || declaration.executionSlot !== "primary" || outcome.executionSlot !== "primary" ||
          declared.sourceRun !== worldProof.parentRun || declared.sourceRun.slice(0, 24) >= parentRun.slice(0, 24) ||
          Date.parse(declared.sourceLastActivityAt) > Date.parse(declaration.startedAt) ||
          Date.parse(declared.sourceSaveLastWriteAt) > Date.parse(declared.sourceLastActivityAt) ||
          JSON.stringify(orphanAutosaveProvenance.parse(recordedRecovery)) !== orphanProof) throw invalid();
    }
    const parentTier = GOALS.indexOf(declaration?.goal);
    if (declaration?.schemaVersion !== 1 || parentTier < 0 || parentTier > GOALS.indexOf(goal) ||
        declaration.minecraftVersion !== "1.21.4" ||
        typeof jarSha256 !== "string" || !/^[a-f0-9]{64}$/.test(jarSha256) ||
        declaration.connection?.host !== "127.0.0.1" ||
        declaration.connection?.auth !== "host-verified-official-launcher" || declaration.recording?.file !== "screen.mp4" ||
        worldProof?.type !== "vanilla" || worldProof.mode !== "survival" || worldProof.difficulty !== "normal" ||
        !(fresh || continued) ||
        outcome?.schemaVersion !== 1 || outcome.goal !== declaration.goal || !time(declaration.startedAt) ||
        outcome.startedAt !== declaration.startedAt || !time(outcome.finishedAt) ||
        !STATUSES.includes(outcome.status) || (outcome.status === "won" &&
          (goal === declaration.goal || outcome.verification?.verified !== true)) ||
        (outcome.operatorStop !== undefined && outcome.operatorStop?.serverSaved !== true) ||
        outcome.exits?.server?.code !== 0 || outcome.exits.server.signal !== null) throw invalid();
    // An attempt that joined must have the vanilla player save directories.
    if (outcome.progress !== null) {
      for (const child of ["playerdata", "stats"]) {
        const entry = await lstat(path.join(world, child));
        if (!entry.isDirectory() || entry.dev !== device || entry.uid !== uid) throw invalid();
      }
    }
    const history = path.join(root, "history.jsonl");
    const { size } = await regular(history);
    const file = await open(history, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (orphanProof) {
        const head = Buffer.alloc(Math.min(size, 4_096));
        const { bytesRead } = await file.read(head, 0, head.length, 0);
        const text = head.toString("utf8", 0, bytesRead);
        const rows = text.split("\n", 3);
        if (rows.length !== 3) throw invalid();
        const declared = JSON.parse(rows[0]!);
        const copied = JSON.parse(rows[1]!);
        if (declared?.event !== "declared" || copied?.event !== "world_copied" || copied.parentRun !== worldProof.parentRun ||
            !time(declared.at) || !time(copied.at) || Date.parse(copied.at) < Date.parse(declared.at) ||
            JSON.stringify(orphanAutosaveProvenance.parse(copied.crashAutosave)) !== orphanProof) throw invalid();
      }
      const tail = Buffer.alloc(Math.min(size, 4_096));
      const { bytesRead } = await file.read(tail, 0, tail.length, size - tail.length);
      const text = tail.toString("utf8", 0, bytesRead);
      if (bytesRead !== tail.length || !text.endsWith("\n")) throw invalid();
      const closed = JSON.parse(text.slice(text.lastIndexOf("\n", text.length - 2) + 1, -1));
      if (closed?.event !== "closed" || closed.status !== outcome.status || !time(closed.at)) throw invalid();
    } finally { await file.close(); }
    await regular(path.join(root, "screen.mp4"));
    await regular(path.join(world, "level.dat"));
    await regular(path.join(world, "session.lock"));
    const hadDeath = outcome.status === "died" || (outcome.lifecycle?.deaths ?? 0) > 0;
    return { root, rootInode, device, world, historic, progress: hadDeath ? null : outcome.progress as Progress | null,
      parentDeath: closedParentDeath(parentRun, outcome) };
  } catch {
    signal.throwIfAborted();
    throw invalid();
  }
}

type SavedWorld = Awaited<ReturnType<typeof savedWorld>>;
type ReadAgentArtifact = (name: string, maxBytes: number, privateMode?: boolean) => Promise<string | undefined | null>;

// undefined means absent; null means present but unsuitable. Only absence permits legacy recovery.
async function readAgentArtifact(parent: string, device: number, name: string, maxBytes: number, signal: AbortSignal,
    privateMode = false): Promise<string | undefined | null> {
  signal.throwIfAborted();
  try {
    const file = await open(path.join(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const entry = await file.stat();
      if (!entry.isFile() || entry.nlink !== 1 || entry.dev !== device || entry.uid !== process.getuid?.() ||
          entry.size < 1 || entry.size > maxBytes ||
          (privateMode ? (entry.mode & 0o7777) !== 0o600 : Boolean(entry.mode & 0o022))) return null;
      const buffer = Buffer.alloc(entry.size + 1);
      let read = 0;
      while (read < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, read, buffer.length - read, read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      return read === entry.size ? buffer.toString("utf8", 0, read) : null;
    } finally {
      await file.close();
    }
  } catch (error) {
    signal.throwIfAborted();
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

async function pinSavedRun(source: Pick<SavedWorld, "root" | "rootInode" | "device">, signal: AbortSignal) {
  const parent = await open(source.root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
    .catch(() => null);
  if (!parent) return;
  let keep = false;
  try {
    const entry = await parent.stat();
    if (!entry.isDirectory() || entry.ino !== source.rootInode || entry.dev !== source.device ||
        entry.uid !== process.getuid?.() || (entry.mode & 0o077)) return;
    const root = `/proc/self/fd/${parent.fd}`;
    const read: ReadAgentArtifact = (name, limit, privateMode) =>
      readAgentArtifact(root, source.device, name, limit, signal, privateMode);
    keep = true;
    return { read, fd: parent.fd, world: path.join(root, "server/world"), close: () => parent.close() };
  } finally {
    if (!keep) await parent.close();
  }
}

async function checkWorldTree(world: string, device: number, budget: number, signal: AbortSignal) {
  const uid = process.getuid?.();
  let bytes = 0;
  async function check(file: string) {
    signal.throwIfAborted();
    const entry = await lstat(file);
    if (entry.dev !== device || entry.uid !== uid ||
        !(entry.isDirectory() || file !== world && entry.isFile() && entry.nlink === 1)) {
      throw new Stop("failed", "Saved world must contain only owned directories and regular files with no hard links.");
    }
    bytes += Math.max(entry.blocks * 512, entry.size);
    if (bytes >= budget) throw new Stop("storage_limit", "Saved world would exceed the run storage stop threshold.");
    if (entry.isDirectory()) {
      for (const child of await readdir(file)) await check(path.join(file, child));
    }
  }
  await check(world);
}

async function copyWorldTree(source: string, destination: string, signal: AbortSignal, env: NodeJS.ProcessEnv,
    inheritedFd?: number) {
  signal.throwIfAborted();
  // Reflink when supported, otherwise copy. Never follow links or share writable inodes.
  const copier = own(spawn("cp", [
    "--recursive", "--no-dereference", "--reflink=auto", "--preserve=mode,timestamps", "--", source, destination,
  ], { env, signal, stdio: inheritedFd === undefined ? "ignore" : ["ignore", "ignore", "ignore", inheritedFd] }));
  const exit = await copier.closed;
  signal.throwIfAborted();
  if (exit.code !== 0) throw new Stop("failed", "Could not copy the saved Survival world.");
}

async function readProgress(file: string): Promise<Progress | null> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(text) as Progress;
  if (!Number.isSafeInteger(value?.tick) || typeof value.status !== "string" || typeof value.goal !== "string" ||
      typeof value.won !== "boolean" || typeof value.alive !== "boolean" || (!value.alive && value.won) ||
      (value.macro_fallback_ticks !== undefined &&
        (!Number.isSafeInteger(value.macro_fallback_ticks) || value.macro_fallback_ticks < 0)) ||
      ![value.x, value.y, value.z, value.health].every(v => !value.alive && v === undefined || Number.isFinite(v)) ||
      (value.alive || value.inventory !== undefined) &&
        (!value.inventory || typeof value.inventory !== "object" || Array.isArray(value.inventory) ||
        !Object.values(value.inventory).every((count) => Number.isSafeInteger(count) && count >= 0))) {
    throw new Error("The agent wrote an invalid progress snapshot.");
  }
  return value;
}

function materialChange(current: PlayingProgress, prior: PlayingProgress) {
  if (Math.hypot(current.x - prior.x, current.y - prior.y, current.z - prior.z) >= 1 ||
      current.health !== prior.health || current.life !== prior.life) return true;
  const items = Object.entries(current.inventory);
  return items.length !== Object.keys(prior.inventory).length ||
    items.some(([item, count]) => count !== prior.inventory[item]);
}

function retainsGoal(goal: Goal, progress: PlayingProgress) {
  return goal === "nether_portal" ? progress.dimension === "minecraft:the_nether" :
    (progress.inventory[`minecraft:${goal}`] ?? 0) > 0;
}

function goalMilestones(goal: Goal, progress: PlayingProgress, highWater: Map<string, number>) {
  const changes: Record<string, number> = {};
  const tier = GOALS.indexOf(goal);
  const count = (item: string) => progress.inventory[`minecraft:${item}`] ?? 0;
  const capped = (key: string, amount: number, target: number) => {
    const milestone = Math.min(amount, target);
    if (milestone > (highWater.get(key) ?? 0)) {
      highWater.set(key, milestone);
      changes[key] = milestone;
    }
  };
  let logs = 0;
  let planks = 0;
  for (const [item, qty] of Object.entries(progress.inventory)) {
    if (/_(?:log|wood|stem|hyphae)$/.test(item)) logs += qty;
    else if (item.endsWith("_planks")) planks += qty;
  }
  capped("logs", logs, 8);
  capped("planks", planks, 16);
  capped("sticks", count("stick"), 8);
  capped("table", count("crafting_table"), 1);
  capped("woodenPickaxe", count("wooden_pickaxe"), 1);
  if (tier >= 1) {
    capped("buildingStone", count("cobblestone") + count("cobbled_deepslate") + count("blackstone"), tier === 1 ? 3 : 16);
    capped("stonePickaxe", count("stone_pickaxe"), 1);
  }
  if (tier >= 2) {
    capped("furnace", count("furnace"), 1);
    capped("coal", count("coal") + count("charcoal"), 8);
    capped("torches", count("torch"), 16);
    capped("rawIron", count("raw_iron"), 3);
    capped("ironIngots", count("iron_ingot"), 3);
    capped("ironPickaxe", count("iron_pickaxe"), 1);
    if (tier >= 3) capped("diamond", count("diamond"), tier === 3 ? 1 : 3);
    if (goal === "diamond_pickaxe") {
      capped("diamondPickaxe", count("diamond_pickaxe"), 1);
    }
    if (progress.y <= 20 && progress.rock_broken && progress.status.startsWith("branch mining ")) {
      // A horizontal prospecting tunnel can legitimately run longer than the stall
      // window. Count rock actually broken, not requested digs or repeated rotations.
      capped("prospectingBlocks", 16 * Math.floor(progress.rock_broken / 16), Number.MAX_SAFE_INTEGER);
    }
    if (goal === "nether_portal") {
      capped("diamondPickaxe", count("diamond_pickaxe"), 1);
      capped("obsidian", count("obsidian"), 10);
      capped("bucket", count("bucket") + count("water_bucket"), 1);
      capped("igniter", count("flint_and_steel"), 1);
      capped("portalFrame", progress.frame_blocks ?? 0, 10);
      capped("castFrame", progress.cast_frame_blocks ?? 0, 10);
    }
    const depthBand = -Math.floor(Math.max(-64, progress.y) / 8);
    const best = highWater.get("minedDepthBand");
    if (best === undefined) highWater.set("minedDepthBand", depthBand);
    else if (depthBand > best && (progress.status === "descending a mined staircase" ||
      progress.status.startsWith("branch mining "))) {
      highWater.set("minedDepthBand", depthBand);
      changes.minedDepthY = -depthBand * 8;
    }
  }
  return changes;
}

export function serverProperties(port: number, provisioned = false) {
  return [
        "server-ip=127.0.0.1", `server-port=${port}`, "online-mode=false",
        "enforce-secure-profile=false", "gamemode=survival", "difficulty=normal",
        "hardcore=false", "level-name=world", "view-distance=6", "simulation-distance=6", "spawn-protection=0",
        "max-players=1", "log-ips=false", "enable-rcon=false", "enable-query=false",
        ...(provisioned ? poolDiagnosticServerProperties : []), "",
  ].join("\n");
}

async function run(goal: Goal, seconds: number, parentRun: string | undefined, diagnostic: Diagnostic | undefined,
    strategyOptions?: StrategyOptions,
    { recoveryMode, orphanScope, parallelWorld = false, revealOres = false }: {
      recoveryMode?: "previous-boot" | "same-boot"; orphanScope?: string; parallelWorld?: boolean; revealOres?: boolean;
    } = {}) {
  const display = await isolatedDisplay();
  const actorJar = AGENT_JAR;
  const localOptions = !diagnostic ? strategyOptions : undefined;
  const wallMs = seconds * 1_000;
  const requiresModelActor = localOptions !== undefined;
  const { java, ffmpeg } = await verifyInputs(actorJar, requiresModelActor);
  const executionSlot = diagnostic ? undefined : parallelWorld ? "parallel" : "primary";
  const runs = diagnostic ? DIAGNOSTIC_RUNS : RUNS;
  const liveFile = diagnostic ? DIAGNOSTIC_LIVE : parallelWorld ? PARALLEL_LIVE : LIVE;
  const provisioned = diagnostic === "pool";
  const artifactCampaign = process.env.SURVIVAL_AGENT_ARTIFACT_CAMPAIGN;
  if (artifactCampaign !== undefined && artifactCampaign !== "recovery-development")
    throw new Error("Unknown Survival artifact campaign.");
  if (artifactCampaign && diagnostic)
    throw new Error("The recovery-development artifact campaign is only available for ordinary Survival runs.");
  const claimScope = revealOres ? "ore-assisted-diagnostic" : diagnostic === "incident-replay" ? "incident-replay" :
    provisioned ? "prepared-diagnostic" : parentRun ? "continuation-chain" : "fresh-attempt";
  const oreAssistance = revealOres
    ? { kind: "diagnostic-loaded-ore-coordinates" as const, ores: ["coal", "iron", "diamond"] as const, campaignProof: false as const }
    : undefined;
  const videoBytes = 32_000_000 + seconds * 600_000;
  const reserveBytes = videoBytes + 1_000_000_000;
  const storageStopBytes = reserveBytes - DRAIN_HEADROOM;
  const copyStopBytes = storageStopBytes - videoBytes;
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = (status: Status, message: string) => controller.abort(new Stop(status, message));
  let receivedSignal: NodeJS.Signals | undefined;
  function interrupt(name: NodeJS.Signals) {
    receivedSignal ??= name;
    abort("interrupted", `Received ${name}.`);
  }
  const interrupts = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
    (name) => ({ name, listener: () => interrupt(name) }),
  );
  for (const { name, listener } of interrupts) process.on(name, listener);
  let release: (() => void) | undefined;
  let orphanFence: Awaited<ReturnType<typeof openOrphanAutosave>> | undefined;
  let canRelease = true;
  try {
    const bootMs = recoveryMode === "previous-boot" ? await currentKernelBootMs() : undefined;
    const readRecovery = bootMs !== undefined && parentRun ? () => readCrashAutosave({
      runs: RUNS, historicRuns: HISTORIC_RUNS, live: LIVE, run: parentRun, goal, bootMs, signal,
    }) : undefined;
    const initialRecovery = await readRecovery?.();
    const orphan = orphanFence = recoveryMode === "same-boot" && parentRun ? await openOrphanAutosave({
      runs: RUNS, historicRuns: HISTORIC_RUNS, live: LIVE, run: parentRun, goal, scope: orphanScope, signal,
    }) : undefined;
    const initialSource = orphan ?? initialRecovery;
    if (initialSource?.normalParentRun)
      await savedWorld(initialSource.normalParentRun, initialSource.goal, signal);
    // "diagnostic" is the existing second physical lock and reservation column;
    // its holder's run class, claim, and live descriptor remain independent.
    release = await admitRun(reserveBytes, diagnostic || parallelWorld ? "diagnostic" : "survival", orphan ? {
      ...orphan.reservation, sourceRun: orphan.provenance.sourceRun, signal,
      assertSource: () => { orphan.assertSource(); orphan.assertLatestPrimary(); },
      assertQuiescent: proofSignal => orphan.assertQuiescent(proofSignal),
    } : initialRecovery?.reservation, artifactCampaign ? { campaign: artifactCampaign } : undefined);
    signal.throwIfAborted();
    await mkdir(runs, { recursive: true, mode: 0o700 });
    // Reconfirm the source once this run owns the lane, before opening writers.
    const crash = await readRecovery?.();
    if (crash && initialRecovery && crash.rootInode !== initialRecovery.rootInode)
      throw new Error("Crash autosave source changed during exclusive admission.");
    const recovery = orphan ?? crash;
    const source = recovery ? {
      ...recovery, historic: false, progress: null, parentDeath: null,
    } : parentRun ? await savedWorld(parentRun, goal, signal) : null;
    const dir = await mkdtemp(path.join(runs, `${new Date().toISOString().replaceAll(":", "-")}-${goal}-`));
    const runDevice = (await lstat(dir)).dev;
    console.log(dir);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const runStartedNs = osMonotonicNs();
    const timer = setTimeout(() => abort("wall_limit", `Reached the ${seconds}s wall limit.`), wallMs);
    const record = (event: string, fields: Record<string, unknown> = {}) => appendFile(
      path.join(dir, "history.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), event, ...fields })}\n`,
      { mode: 0o600 },
    );
    const progressFile = path.join(dir, "progress.json");
    const ledger = new LifeLedger(!provisioned);
    const readLifeReceipts = lifeReceiptReader(path.join(dir, LIFE_RECEIPTS));
    const deathPolicy = {
      mode: provisioned ? "strict-no-death" : "vanilla-respawn",
      legacyJar: "strict-no-death",
      receipts: LIFE_RECEIPTS,
      ...(provisioned ? {} : {
        pendingTimeoutMs: RESPAWN_TIMEOUT_MS,
        fastDeathLimit: FAST_DEATH_LIMIT, fastDeathWindowMs: FAST_DEATH_WINDOW_MS,
        resetsOn: "new objective high-water milestone, not recovery supplies or generic digging",
      }),
      ...(source && !recovery ? { inheritedInitialScreen: "closed parent, matching saved player and first native DeathScreen required" } : {}),
    };
    const video = path.join(dir, "screen.mp4");
    const live = { run: path.basename(dir), display: display.display, authority: display.authority };
    const benchmark = diagnostic ? undefined : { goal, verifier: "vanilla-survival", claimScope,
      ...(oreAssistance ? { campaignProof: false, assistance: oreAssistance.kind } : {}) };
    const expeditionAdvisor = localOptions && composeMacroStrategist({
      model: localOptions.model,
      dir, goal, objective: localOptions.task ?? "", authDirectory: process.env.GAMEHARNESS_DATA_DIR ?? RUNTIME,
      signal, maxRequests: localOptions.maxRequests, maxRuntimeMs: wallMs,
      assertDisplay: () => {
        if (!display.stillOwned()) throw new Error("The run no longer owns its private Minecraft display.");
      },
    });
    const world = diagnostic === "pool" ? poolDiagnosticWorld : {
      type: diagnostic === "incident-replay" ? "vanilla-incident-replay" : "vanilla",
      mode: "survival", difficulty: "normal",
      ...(parentRun ? { fresh: false, parentRun, ...(recovery ? { crashAutosave: recovery.provenance } : {}) } :
        { fresh: true, seed: "random" }),
    };
    let mayUpdateLive = false;
    let stage = "declaration";
    let server: Owned | undefined;
    let client: Owned | undefined;
    let recorder: Owned | undefined;
    let recordingStartedNs: bigint | undefined;
    let clientClosedNs: bigint | undefined;
    let runnerStopRequestedNs: bigint | undefined;
    let diagnostics: Set<string> | undefined;
    let lastProgress: Progress | null = null;
    let claimProgress: PlayingProgress | null = null;
    let goalClaim: { life: number; tick: number; wall_ms: number | null; deaths: number } | null = null;
    const statsDirectory = path.join(dir, "server/world/stats");
    let beforeStats: Awaited<ReturnType<typeof readSavedPlayerStats>> = null;
    let measuredBytes: number | null = null;
    let meter: Promise<void> | undefined;
    let stopChannel: Awaited<ReturnType<typeof openOperatorStop>> | undefined;
    let stopWatch: Promise<void> | undefined;
    let operatorStop: Stop | undefined;
    let result = new Stop("failed", "Run ended without a recorded outcome.");
    const startupDeadline = AbortSignal.timeout(STARTUP_MS);
    const startup = AbortSignal.any([signal, startupDeadline]);
    const env = { PATH: "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" };
    const worldDir = path.join(dir, "server");
    const destination = path.join(worldDir, "world");
    const startMeter = () => (async () => {
      while (!signal.aborted) {
        measuredBytes = await diskBytes(dir, signal);
        if (measuredBytes >= (stage === "world_copy" ? copyStopBytes : storageStopBytes)) {
          abort("storage_limit", "Run reached its storage stop threshold.");
          return;
        }
        await delay(1_000, undefined, { signal });
      }
    })().catch((error: unknown) => {
      if (!signal.aborted) abort("failed", error instanceof Error ? error.message : "Could not measure run storage.");
    });
    const launcher = new MinecraftClient(ROOT, { dataDir: path.join(dir, "client"), java });
    const observeLife = async (progress: Progress | null, now: number, closed = false) => {
      let hasMore = await readLifeReceipts(sample => ledger.receipt(sample, now), closed);
      if (closed) {
        while (hasMore) hasMore = await readLifeReceipts(sample => ledger.receipt(sample, now), true);
      }
      if (progress) {
        if (progress.goal !== goal) throw new Error("The agent reported a different goal.");
        ledger.snapshot(progress, now);
      }
      return hasMore;
    };
    canRelease = false;
    try {
      const agentJarSha256 = await launcher.stageAgentArtifact(actorJar, requiresModelActor);
      const port = await loopbackPort();
      await privateJson(path.join(dir, "declaration.json"), {
        schemaVersion: 1, startedAt, goal, minecraftVersion: "1.21.4", agentJarSha256,
        world, claimScope, deathPolicy,
        ...(oreAssistance ? { assistance: oreAssistance, campaignProof: false } : {}),
        ...(executionSlot ? { executionSlot } : {}),
        pauseDiagnostics: PAUSE_DIAGNOSTICS,
        ...(benchmark ? { benchmark, strategy: expeditionAdvisor?.declaration ?? DETERMINISTIC_STRATEGY } : {}),
        inactivity: { unchangedMs: STALL_MS, noGoalMilestoneMs: GOAL_STALL_MS,
          action: provisioned ? "end_diagnostic" : "record_only" },
        connection: { host: "127.0.0.1", port, auth: "host-verified-official-launcher" },
        limits: {
          wallSeconds: seconds, startupMs: STARTUP_MS, heartbeatMs: HEARTBEAT_MS,
          ...(provisioned ? { stallMs: STALL_MS, goalStallMs: GOAL_STALL_MS } : {}),
          reserveBytes, videoBytes, drainHeadroomBytes: DRAIN_HEADROOM,
          ...(artifactCampaign ? { artifactCampaign } : {}),
          serverShutdown: SERVER_SHUTDOWN_LIMITS,
        },
        recording: { file: "screen.mp4", size: SIZE, fps: 30, codec: "h264", cursor: true, audio: false },
      });
      if (orphan) {
        // Do not publish a live run, start an advisor, or start Minecraft until
        // the fenced copy is complete. Nothing except the vanilla world is copied.
        stage = "world_copy";
        await record("declared");
        await mkdir(worldDir, { mode: 0o700 });
        meter = startMeter();
        const worldDevice = (await lstat(worldDir)).dev;
        const bytesBefore = await diskBytes(dir, startup);
        await checkWorldTree(`/proc/self/fd/${orphan.worldFd}/.`, orphan.device, copyStopBytes - bytesBefore, startup);
        await orphan.assertQuiescent(startup);
        orphan.assertSource();
        await copyWorldTree("/proc/self/fd/3/.", destination, startup, env, orphan.worldFd);
        await checkWorldTree(destination, worldDevice, copyStopBytes - bytesBefore, startup);
        beforeStats = await readSavedPlayerStats(statsDirectory);
        if (beforeStats?.file !== `${offlineUuid(orphan.profileName)}.json`)
          throw new Stop("failed", "The orphan autosave copy did not retain the original vanilla player baseline.");
        measuredBytes = await diskBytes(dir, startup);
        if (measuredBytes >= copyStopBytes)
          throw new Stop("storage_limit", "Saved world would exceed the run storage stop threshold.");
        await orphan.assertQuiescent(startup);
        orphan.assertSource();
        startup.throwIfAborted();
        await record("world_copied", { parentRun, crashAutosave: orphan.provenance });
        await orphan.close();
        orphanFence = undefined;
        startup.throwIfAborted();
        stage = "server_startup";
      }
      mayUpdateLive = !orphan;
      if (executionSlot) stopChannel = await openOperatorStop(dir, {
        slot: executionSlot, display: live.display, authority: live.authority,
      });
      mayUpdateLive = true;
      await privateJson(liveFile, { ...live, active: true, ...(stopChannel ? { operatorStop: stopChannel.scope } : {}) });
      if (stopChannel) {
        const channel = stopChannel;
        stopWatch = (async () => {
          while (!signal.aborted) {
            if (await channel.requested() && !signal.aborted) {
              operatorStop = new Stop("interrupted", "Stopped by operator.");
              controller.abort(operatorStop);
              return;
            }
            await delay(250, undefined, { signal }).catch(() => {});
          }
        })();
      }
      console.log(diagnostic
        ? "Diagnostic live view: http://127.0.0.1:4382/ (start with `bun run watch:agent --diagnostic` if needed)"
        : parallelWorld
          ? "Parallel live view: http://127.0.0.1:4383/ (start with `bun run watch:agent --parallel-world` if needed)"
          : "Live view: http://127.0.0.1:4379/ (start with `bun run watch:agent` if needed)");
      if (!orphan) await record("declared");
      if (!provisioned) await writeFile(path.join(dir, RESPAWN_MARKER), "", { mode: 0o600, flag: "wx" });
      meter ??= startMeter();
      if (expeditionAdvisor) {
        stage = "expedition_startup";
        startup.throwIfAborted();
        // Local control is selected before launch. Authorization opens in the background.
        await expeditionAdvisor.start();
        await record("expedition_ready");
      }
      stage = source && !orphan ? "world_copy" : "server_startup";
      if (!orphan) await mkdir(worldDir, { mode: 0o700 });
      const worldDevice = (await lstat(worldDir)).dev;
      if (source && !orphan) {
        const bytesBefore = await diskBytes(dir, startup);
        await checkWorldTree(source.world, source.device, copyStopBytes - bytesBefore, startup);
        const pinned = await pinSavedRun(source, startup);
        try {
          const copyFd = pinned?.fd;
          if (recovery && copyFd === undefined) throw new Stop("failed", "Could not pin the original crash autosave run.");
          startup.throwIfAborted();
          await copyWorldTree(copyFd === undefined ? source.world : "/proc/self/fd/3/server/world",
            destination, startup, env, copyFd);
          await checkWorldTree(destination, worldDevice, copyStopBytes - bytesBefore, startup);
        } finally { await pinned?.close(); }
        beforeStats = await readSavedPlayerStats(statsDirectory);
        startup.throwIfAborted();
        measuredBytes = await diskBytes(dir, startup);
        if (measuredBytes >= copyStopBytes)
          throw new Stop("storage_limit", "Saved world would exceed the run storage stop threshold.");
        await record("world_copied", { parentRun, ...(recovery ? { crashAutosave: recovery.provenance } : {}) });
        stage = "server_startup";
      }
      const serverTmp = path.join(worldDir, "tmp");
      await mkdir(serverTmp, { mode: 0o700 });
      await writeFile(path.join(worldDir, "eula.txt"), "eula=true\n");
      await writeFile(path.join(worldDir, "server.properties"), serverProperties(port, provisioned));
      const serverErr = await open(path.join(dir, "server.stderr.log"), "wx", 0o600);
      try {
        startup.throwIfAborted();
        server = own(spawn(java, [
          "-Xms512M", "-Xmx2048M", "-XX:-CreateCoredumpOnCrash",
          `-Duser.home=${worldDir}`, `-Djava.io.tmpdir=${serverTmp}`, "-jar", SERVER_JAR, "nogui",
        ], {
          cwd: worldDir, env: { ...env, HOME: worldDir, TMPDIR: serverTmp },
          detached: true, stdio: ["pipe", "pipe", serverErr.fd],
        }));
        let pending = "";
        let ready = false;
        server.child.stdout!.on("data", (chunk: Buffer) => {
          const text = pending + chunk.toString("utf8");
          ready ||= /Done \([^)]+\)! For help, type "help"/.test(text);
          pending = text.slice(-150);
        });
        await record("server_started");
        while (!ready) {
          if (server.exit) throw new Stop("server_exit", "Vanilla server exited before it was ready.");
          await delay(200, undefined, { signal: startup });
        }
      } finally {
        await serverErr.close();
      }
      await record("server_ready");

      stage = "recorder_startup";
      const ffmpegErr = await open(path.join(dir, "ffmpeg.log"), "wx", 0o600);
      try {
        startup.throwIfAborted();
        if (!display.stillOwned()) throw new Stop("failed", "The run no longer owns its private recording display.");
        recordingStartedNs = osMonotonicNs();
        recorder = own(spawn(ffmpeg, [
          "-hide_banner", "-loglevel", "warning", "-nostats",
          "-f", "x11grab", "-draw_mouse", "1", "-framerate", "30", "-video_size", SIZE,
          "-i", `${display.display}+0,0`, "-an",
          "-c:v", "libx264", "-threads", "4", "-preset", "veryfast", "-crf", "23",
          "-maxrate", "3500k", "-bufsize", "3500k", "-pix_fmt", "yuv420p", "-g", "60",
          "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
          "-fs", String(videoBytes), video,
        ], {
          cwd: dir, env: { ...env, DISPLAY: display.display, XAUTHORITY: display.authority },
          detached: true, stdio: ["pipe", "ignore", ffmpegErr.fd],
        }));
      } finally {
        await ffmpegErr.close();
      }
      await record("recorder_started");

      stage = "client_startup";
      // Abort in-flight authentication and downloads if any dependency exits before the client joins.
      const runningServer = server;
      void runningServer.closed.then(() => abort("server_exit", "Vanilla server exited unexpectedly."));
      void recorder.closed.then(async () => {
        if (signal.aborted) return;
        const size = await stat(video).then((entry) => entry.size, () => 0);
        if (size >= videoBytes - 64_000) abort("recording_limit", "Recording reached its byte limit.");
        else abort("recorder_exit", "The screen recorder exited unexpectedly.");
      });
      const parentDeath = source?.parentDeath;
      const launched = await launcher.launchAgent({
        runtimeCache: RUNTIME, port, goal, evidenceDir: dir, ...display,
        revealOresDiagnostic: revealOres,
        onSetup: (phase) => { stage = phase; },
        beforeConnect: provisioned ? async (profileName) => {
          stage = "diagnostic_provisioning";
          await provisionPoolDiagnostic(runningServer.child, worldDir, profileName, startup);
          await record("diagnostic_sealed");
          stage = "client_startup";
        } : recovery ? async (profileName) => {
          if (profileName !== recovery.profileName || beforeStats?.file !== `${offlineUuid(profileName)}.json`)
            throw new Stop("failed", "The verified official profile does not own the copied autosave player.");
        } : parentDeath ? async (profileName) => {
          const baseline = savedDeathDelta(null, beforeStats);
          if (baseline && /^[A-Za-z0-9_]{1,16}$/.test(profileName)) {
            ledger.expectInheritedDeath(parentDeath, {
              savedDeaths: baseline.after, matchesProfile: beforeStats?.file === `${offlineUuid(profileName)}.json`,
            });
          }
        } : undefined,
      }, startup);
      client = own(launched.child, launched.closed);
      void launched.closed.then(() => { clientClosedNs = osMonotonicNs(); });
      diagnostics = launched.diagnostics;
      await record("client_started");

      let tickAt = performance.now();
      let changedAt = tickAt;
      let goalChangedAt = tickAt;
      let materialWarning = false, goalWarning = false;
      const highWater = new Map<string, number>();
      let anchor: PlayingProgress | null = null;
      while (!signal.aborted) {
        const progress = await readProgress(progressFile);
        const now = performance.now();
        const hasMoreLifeReceipts = await observeLife(progress, now);
        if (progress) {
          if (!lastProgress) {
            startup.throwIfAborted();
            stage = "playing";
            goalChangedAt = now;
            await record("agent_ready", { tick: progress.tick });
          }
          if (!lastProgress || progress.tick !== lastProgress.tick) tickAt = now;
        }
        const previous: Progress | null = lastProgress;
        lastProgress = progress ?? previous;
        const lifeStop = ledger.stop(now);
        if (lifeStop) throw new Stop(lifeStop.status, lifeStop.reason);
        signal.throwIfAborted();
        if (progress?.alive && !hasMoreLifeReceipts && ledger.currentPlaying(progress)) {
          if (!previous || progress.tick !== previous.tick || progress.life !== previous.life || !previous.alive) {
            const milestones = goalMilestones(goal, progress, highWater);
            const names = Object.keys(milestones);
            if ((!source || anchor) && names.length) {
              goalChangedAt = now;
              goalWarning = false;
              ledger.milestone(names);
              await record("goal_progress", { tick: progress.tick, life: ledger.life, milestones });
            }
          }
          if (!anchor || materialChange(progress, anchor)) {
            anchor = progress;
            changedAt = now;
            materialWarning = false;
          }
          if (provisioned && progress.stall_phase === "blocked")
            throw new Stop("stalled", progress.stall_detail || "Local recovery could not complete the diagnostic.");
          if (progress.won && retainsGoal(goal, progress)) {
            claimProgress = progress;
            goalClaim = { life: ledger.life!, tick: progress.tick, wall_ms: progress.wall_ms ?? null, deaths: ledger.deaths };
            throw new Stop("won", diagnostic === "pool" ? "The agent cast and lit a portal and entered the Nether."
              : goal === "nether_portal" ? "The agent built a portal and entered the Nether." : `The agent obtained ${goal}.`);
          }
        }
        if (typeof progress?.failure === "string") {
          throw new Stop(provisioned ? "stalled" : "failed", progress.failure);
        }
        if (client.exit) throw new Stop("client_exit", "Minecraft client exited before reporting success.");
        if (!lastProgress && startup.aborted) {
          if (signal.aborted) signal.throwIfAborted();
          throw new Stop("startup_limit", "The agent did not report progress before the startup limit.");
        }
        if (lastProgress && now - tickAt >= HEARTBEAT_MS) {
          throw new Stop("heartbeat_lost", "Agent ticks stopped advancing.");
        }
        if (lastProgress?.alive && !materialWarning && now - changedAt >= STALL_MS) {
          if (provisioned) throw new Stop("stalled", "The agent stopped moving or changing inventory and health.");
          materialWarning = true;
          await record("no_material_change", { tick: lastProgress.tick, elapsedMs: Math.round(now - changedAt) });
        }
        if (lastProgress?.alive && !goalWarning && now - goalChangedAt >= GOAL_STALL_MS) {
          if (provisioned) throw new Stop("goal_stalled", "The agent reached no new goal milestone for five minutes.");
          goalWarning = true;
          await record("no_goal_milestone", { tick: lastProgress.tick, elapsedMs: Math.round(now - goalChangedAt) });
        }
        await delay(350, undefined, { signal });
      }
      signal.throwIfAborted();
    } catch (error) {
      if (operatorStop) result = operatorStop;
      else if (error instanceof Stop) result = error;
      else if (signal.reason instanceof Stop) result = signal.reason;
      else if (error instanceof ModelActorCompatibilityError) result = new Stop("failed", error.message);
      else if (startupDeadline.aborted && stage !== "playing") {
        result = new Stop("startup_limit", "Minecraft did not start before the startup limit.");
      } else if (orphan && stage === "world_copy" && error instanceof Error) {
        result = new Stop("failed", error.message);
      } else {
        const auth = nativeLaunchFailure(error);
        const clientTimeout = error instanceof Error && error.name === "TimeoutError"
          ? stage === "client_session_check" ? "Official Minecraft profile verification timed out before client launch."
          : stage === "client_dependencies" ? "Minecraft client dependency setup timed out before launch." : undefined
          : undefined;
        result = new Stop("failed", auth?.error ?? clientTimeout ?? `Run failed during ${stage}.`);
        if (!auth && error instanceof Error)
          await record("failure", { stage, category: error.name }).catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      // A stop can arrive while the launcher is still resolving. Only this owner
      // can attest that no Java client was spawned or join its exact close event.
      controller.abort();
      // Only the run owner may request gameplay shutdown. Macro revocation
      // alone is not a gameplay boundary. Keep the vanilla server and footage
      // running until the exact client process exits or is drained.
      const clientDrain = (async () => {
        try {
          if (client && !client.exit) {
            const deadline = performance.now() + RUNNER_STOP_GRACE_MS;
            const requestedAt = osMonotonicNs();
            const published = await writeFile(path.join(dir, `runner-stop-${path.basename(dir)}`), "", {
              mode: 0o600, flag: "wx", signal: AbortSignal.timeout(RUNNER_STOP_GRACE_MS),
            }).then(() => true, () => false);
            if (published) {
              runnerStopRequestedNs = requestedAt;
              await waitClosed(client, Math.max(0, deadline - performance.now()));
            }
          }
        } finally {
          await drain(client);
        }
      })();
      // The abort above fences publication; the advisor reads any last applied
      // advice receipt after the exact client has drained.
      const strategyDrain = expeditionAdvisor
        ? clientDrain.catch(() => {}).then(() => expeditionAdvisor.stop())
        : undefined;
      const serverDrainTask = (async () => {
        let cleanupError: unknown;
        try {
          await clientDrain;
        } catch (error) { cleanupError = error; }
        const result = await drainVanillaServer(server);
        if (cleanupError) throw cleanupError;
        return result;
      })();
      const settled = await Promise.allSettled([
        clientDrain, serverDrainTask, clientDrain.finally(() => drain(recorder, "q\n")), meter, strategyDrain,
        Promise.resolve(stopWatch).finally(() => stopChannel?.close()),
        operatorStop && record("operator_stop_accepted", { run: live.run }),
      ]);
      const drained = [client, server, recorder].every(owned => !owned || owned.exit !== undefined) &&
        settled.every(step => step.status === "fulfilled");
      let serverDrain = settled[1].status === "fulfilled" ? settled[1].value : null;
      if (settled[4].status === "rejected") {
        result = new Stop("failed", expeditionAdvisor ? "The Model expedition advisor did not drain cleanly." :
          "The Model strategist did not drain cleanly.");
      } else if (!drained) {
        result = new Stop("failed", "An owned process could not be drained cleanly.");
      }
      if (serverDrain) await record("server_drained", serverDrain).catch(() => {
        if (operatorStop) serverDrain = null;
        if (result === operatorStop) result = new Stop("failed", "Could not record the vanilla server drain.");
      });
      let liveClosed = !mayUpdateLive;
      if (mayUpdateLive) {
        try {
          await privateJson(liveFile, { ...live, active: false });
          liveClosed = true;
        } catch {
          result = new Stop("failed", "Could not mark the live view inactive.");
        }
      }
      try { measuredBytes = await diskBytes(dir); }
      catch (error) {
        const reason = error instanceof Error ? error.message : "Could not measure final run storage.";
        measuredBytes = null;
        if (result.status === "won")
          result = new Stop("failed", reason);
        await record("final_storage_unreadable", { reason }).catch(() => {});
      }
      let lifeEvidenceReadable = !client;
      if (client?.exit) {
        try {
          let progressError = false;
          const finalProgress = await readProgress(progressFile).catch(() => { progressError = true; return null; });
          await observeLife(finalProgress, performance.now(), true);
          if (progressError) throw new Error("Final progress was unreadable.");
          lastProgress = finalProgress ?? lastProgress;
          lifeEvidenceReadable = true;
        } catch {
          await record("life_evidence_unreadable").catch(() => {});
        }
      }
      const saveEvidence = serverSaveEvidence(server, serverDrain);
      const serverSaved = saveEvidence === true;
      if (operatorStop && result === operatorStop && saveEvidence === false)
        result = new Stop("server_exit", "Operator stop could not confirm a clean vanilla server save.");
      const finalStats = serverSaved ? await readSavedPlayerStats(statsDirectory).catch(() => null) : null;
      const recordedDeaths = savedDeathDelta(beforeStats, finalStats);
      const life = ledger.summary();
      if (provisioned && (ledger.deaths > 0 || (recordedDeaths?.attempt ?? 0) > 0)) {
        result = new Stop("died", `The agent died during the prepared ${diagnostic} proof.`);
      } else if (result.status === "won" && (!lifeEvidenceReadable || !lastProgress?.alive ||
          !retainsGoal(goal, lastProgress) ||
          !ledger.currentPlaying(lastProgress) || !goalClaim || ledger.life !== goalClaim.life ||
          goalClaim.deaths !== ledger.deaths || (recordedDeaths?.attempt ?? 0) > ledger.deaths)) {
        result = new Stop("unverified", "The run did not retain a live, current-life goal claim through shutdown.");
      }
      let verification: Awaited<ReturnType<typeof verifySurvival>> | null = null;
      if (result.status === "won" && !serverSaved) {
        result = new Stop("server_exit", "The vanilla server did not stop cleanly after the goal.");
      } else if (result.status === "won") {
        verification = await verifySurvival(statsDirectory, goal, claimProgress, diagnostic === "pool", beforeStats);
        const videoExists = await stat(video).then((entry) => entry.size > 0, () => false);
        if (!verification.verified) result = new Stop("unverified", verification.reason);
        else if (!videoExists || recorder?.exit?.code !== 0)
          result = new Stop("recorder_exit", "The verified goal has no completed screen recording.");
        else if (measuredBytes !== null && measuredBytes > reserveBytes)
          result = new Stop("storage_limit", "Final artifacts exceeded the run reservation.");
      }
      const strategy = expeditionAdvisor?.outcome() ?? DETERMINISTIC_STRATEGY;
      const pauseEvidence = await finalPauseEvidence(dir, {
        runStartedNs, cutoffNs: clientClosedNs ?? osMonotonicNs(), recordingStartedNs, runnerStopRequestedNs,
        providerSpans: expeditionAdvisor?.providerTimeline() ?? [],
      });
      const benchmarkConfirmed = result.status === "won";
      const outcome = {
        schemaVersion: 1, status: result.status, reason: result.message, goal, startedAt, world, claimScope, deathPolicy,
        ...(oreAssistance ? { assistance: oreAssistance, campaignProof: false } : {}),
        ...(executionSlot ? { executionSlot } : {}),
        finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start),
        finalStage: stage, reservedBytes: reserveBytes, measuredBytes, progress: lastProgress,
        ...(operatorStop ? { operatorStop: { serverSaved: saveEvidence } } : {}),
        ...(pauseEvidence ? { pauseEvidence } : {}),
        ...(benchmark ? { benchmark: { ...benchmark, confirmed: benchmarkConfirmed }, strategy } : {}),
        lifecycle: { ...life, receiptFile: LIFE_RECEIPTS, evidenceReadable: lifeEvidenceReadable,
          savedDeaths: recordedDeaths && { ...recordedDeaths, agreesWithObserved: recordedDeaths.attempt === ledger.deaths },
          goalClaim,
          goalBearingLives: benchmarkConfirmed && goalClaim ? [goalClaim.life] : [],
        },
        verification: verification && { ...verification, scope: claimScope },
        exits: { server: server?.exit ?? null, client: client?.exit ?? null, recorder: recorder?.exit ?? null },
        clientDiagnostics: [...(diagnostics ?? [])],
      };
      await privateJson(path.join(dir, "outcome.json"), outcome);
      await record("closed", { status: outcome.status });
      canRelease = drained && liveClosed;
      console.log(JSON.stringify(outcome));
    }
    return receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 :
      receivedSignal === "SIGHUP" ? 129 :
      result.status === "won" ? 0 : 1;
  } finally {
    try {
      try { await orphanFence?.close(); }
      finally {
        if (canRelease) {
          release?.();
        }
      }
    } finally {
      for (const { name, listener } of interrupts) process.off(name, listener);
    }
  }
}

if (import.meta.main) try {
  const { args, parallelWorld, revealOres } = readParallelWorld(process.argv.slice(2));
  if (args.length === 1 && args[0] === "--help") console.log(usage);
  else {
    const { game, model } = readStrategy(args);
    const { goal, seconds, parentRun, diagnostic, recoveryMode } = parseArgs(game);
    if (parallelWorld && (diagnostic || recoveryMode))
      throw new Error(parallelWorldUsage);
    const orphanScope = recoveryMode === "same-boot" ? process.env.SURVIVAL_AGENT_ORPHAN_SCOPE : undefined;
    if (recoveryMode === "same-boot" && !orphanAutosaveProvenance.shape.sourceScope.safeParse(orphanScope).success)
      throw new Error("Set SURVIVAL_AGENT_ORPHAN_SCOPE to the source systemd user .scope unit.");
    process.umask(0o077);
    process.exitCode = await run(goal, seconds, parentRun, diagnostic, model, { recoveryMode, orphanScope, parallelWorld, revealOres });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Run failed.");
  process.exitCode = 1;
}
