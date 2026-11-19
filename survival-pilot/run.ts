#!/usr/bin/env bun
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { SURVIVAL_PILOT_GOALS as GOALS, type SurvivalPilotGoal as Goal } from "../src/shared/survival-pilot-ui.ts";
import { JAVA, MinecraftClient, privateJson } from "../src/server/minecraft-client.ts";
import { nativeLaunchFailure } from "../src/server/native-launch-fault.ts";
import { descentFixtures, descentServerProperties, descentVariants, descentWorld,
  provisionDescent, type DescentVariant } from "./diagnostic-descent.ts";
import { poolDiagnosticServerProperties, poolDiagnosticWorld, provisionPoolDiagnostic } from "./diagnostic-pool.ts";
import { admitRun } from "./storage.ts";
import { monitorDescent, verifyDescent } from "./verify-descent.ts";
import { verifySurvival } from "./verify.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const RUNTIME = path.join(ROOT, "local/runtime");
const PILOT_LOCAL = path.join(ROOT, "local/survival-pilot");
const RUNS = path.join(PILOT_LOCAL, "runs");
const LIVE = path.join(PILOT_LOCAL, "live.json");
const DIAGNOSTIC_RUNS = path.join(PILOT_LOCAL, "diagnostic-runs");
const DIAGNOSTIC_LIVE = path.join(PILOT_LOCAL, "diagnostic-live.json");
const SERVER_JAR = path.join(RUNTIME, "minecraft/server-1.21.4.jar");
const PILOT_JAR = path.join(import.meta.dir, "build/libs/survival-pilot-1.0.jar");
const RUN_BASENAME = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-(?:${GOALS.join("|")})-[A-Za-z0-9]{6}$`);
const DEFAULT_SECONDS = 900;
const MAX_SECONDS = Math.floor(2_147_483_647 / 1_000);
const SIZE = "1280x720";
const STARTUP_MS = 120_000;
const HEARTBEAT_MS = 20_000;
const STALL_MS = 180_000;
const GOAL_STALL_MS = 300_000;
const DRAIN_HEADROOM = 128_000_000;
const MEMORY_FILE = "pilot-memory.json";
const MEMORY_BYTES = 32 * 1024;
const MEMORY_CELLS = 1024;
const OVERWORLD = "minecraft:overworld";
const exec = promisify(execFile);
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Owned = { child: ChildProcess; closed: Promise<Exit>; exit?: Exit };
type Progress = {
  failure?: string;
  dimension?: string;
  rock_broken?: number;
  frame_blocks?: number;
  cast_frame_blocks?: number;
  tick: number;
  goal: string;
  status: string;
  won: boolean;
  alive: boolean;
  inventory: Record<string, number>;
  x: number;
  y: number;
  z: number;
  health: number;
};
const STATUSES = ["won", "died", "startup_limit", "wall_limit", "heartbeat_lost",
  "stalled", "goal_stalled", "storage_limit", "recording_limit", "interrupted",
  "server_exit", "client_exit", "recorder_exit", "unverified", "failed"] as const;
type Status = (typeof STATUSES)[number];

class Stop extends Error {
  constructor(readonly status: Status, message: string) { super(message); }
}

const usage = `Usage: bun run play:pilot GOAL [SECONDS [--continue-from RUN_BASENAME]]
       bun run diagnose:pool [SECONDS]
       bun run play:pilot --diagnostic-descent (${descentVariants.join(" | ")}) [SECONDS]

GOAL: ${GOALS.join(" | ")}
SECONDS: wall limit including startup, 1–${MAX_SECONDS} (default ${DEFAULT_SECONDS}).
--continue-from: copy a closed, recorded pilot world. Retry its goal or pursue a later one.
diagnose:pool: test casting a Nether portal in a separate, pre-provisioned diagnostic world.
--diagnostic-descent: test a dry fall, a chosen boat descent, or connected cave shelves.
Both diagnostics share one lane and cannot be continued as survival runs.

Build survival-pilot-1.0.jar first. Requires Java 21, ffmpeg, existing local EULA
consent, and a signed-in official Launcher with Minecraft 1.21.4 installed.
Without JAVA_HOME, the runner prefers the system OpenJDK 21 installation.
Only a confirmed goal exits 0. Artifacts and outcome JSON go in the printed run directory.`;

type Diagnostic = "pool" | DescentVariant;

function parseArgs(args: string[]) {
  if (args[0] === "--diagnostic-descent") {
    const diagnostic = descentVariants.find(item => item === args[1]);
    const rawSeconds = args[2] ?? String(DEFAULT_SECONDS);
    const seconds = Number(rawSeconds);
    if (!diagnostic || args.length > 3 || !/^\d+$/.test(rawSeconds) || !Number.isSafeInteger(seconds) ||
        seconds < 1 || seconds > MAX_SECONDS) throw new Error(usage);
    return { goal: descentFixtures[diagnostic].goal, seconds, parentRun: undefined, diagnostic };
  }
  const [rawGoal, rawSeconds = String(DEFAULT_SECONDS), flag, parentRun] = args;
  const diagnostic = rawGoal === "--diagnostic-pool" ? "pool" as const : undefined;
  const goal = diagnostic ? "nether_portal" : GOALS.find((item) => item === rawGoal);
  const seconds = Number(rawSeconds);
  if (!goal || (args.length > 2 && (diagnostic || args.length !== 4 || flag !== "--continue-from" ||
      !parentRun || !RUN_BASENAME.test(parentRun))) || !/^\d+$/.test(rawSeconds) ||
      !Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
    throw new Error(usage);
  }
  return { goal, seconds, parentRun, diagnostic };
}

async function isolatedDisplay() {
  const display = process.env.DISPLAY;
  const authority = process.env.XAUTHORITY;
  const number = display?.match(/^:(\d+)$/)?.[1];
  const xServer = Bun.which("Xvfb");
  const rejected = () => new Error("Run this command under xvfb-run; refusing to use a desktop display.");
  if (!display || !number || Number(number) < 90 || !authority || !xServer) throw rejected();
  try {
    const lock = (await readFile(`/tmp/.X${number}-lock`, "utf8")).trim();
    if (!/^[1-9]\d*$/.test(lock)) throw rejected();
    const proc = `/proc/${lock}`;
    const [running, expected, cmdline, authFile] = await Promise.all([
      realpath(`${proc}/exe`), realpath(xServer), readFile(`${proc}/cmdline`, "utf8"), realpath(authority),
    ]);
    const args = cmdline.split("\0");
    const authIndex = args.indexOf("-auth");
    const offline = args.some((arg, index) => arg === "-nolisten" && args[index + 1] === "tcp");
    if (running !== expected || args[1] !== display || authIndex < 0 ||
        !offline || await realpath(args[authIndex + 1]!) !== authFile) throw rejected();
    const authStat = await stat(authFile);
    if (!authStat.isFile() || authStat.uid !== process.getuid?.() || (authStat.mode & 0o077)) throw rejected();
    return { display, authority: authFile };
  } catch {
    throw rejected();
  }
}

async function verifyInputs() {
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
  await access(PILOT_JAR, constants.R_OK).catch(() => {
    throw new Error("Build survival-pilot/build/libs/survival-pilot-1.0.jar before running the pilot.");
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

async function diskBytes(dir: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await exec("du", ["-s", "-B1", "--", dir], {
    signal, timeout: 5_000, maxBuffer: 8_192,
  });
  const bytes = Number(stdout.split("\t", 1)[0]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Could not measure run storage.");
  return bytes;
}

async function savedWorld(parentRun: string, goal: Goal, signal: AbortSignal) {
  const root = path.join(RUNS, parentRun);
  const server = path.join(root, "server");
  const world = path.join(server, "world");
  const invalid = () => new Error(`Cannot continue from ${parentRun}: expected a closed, recorded pilot attempt with a clean save and an eligible goal.`);
  try {
    const uid = process.getuid?.();
    const runs = await lstat(RUNS);
    if (!runs.isDirectory() || runs.uid !== uid) throw invalid();
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
    const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
    const worldProof = declaration?.world;
    // Older fresh attempts recorded the world only in the declaration.
    const fresh = worldProof?.fresh === true && worldProof.seed === "random" &&
      (!outcome?.world || outcome.world.fresh === true);
    const continued = worldProof?.fresh === false && typeof worldProof.parentRun === "string" &&
      RUN_BASENAME.test(worldProof.parentRun) && outcome?.world?.fresh === false &&
      outcome.world.parentRun === worldProof.parentRun;
    const parentTier = GOALS.indexOf(declaration?.goal);
    if (declaration?.schemaVersion !== 1 || parentTier < 0 || parentTier > GOALS.indexOf(goal) ||
        declaration.minecraftVersion !== "1.21.4" ||
        typeof declaration.pilotJarSha256 !== "string" || !/^[a-f0-9]{64}$/.test(declaration.pilotJarSha256) ||
        declaration.connection?.host !== "127.0.0.1" ||
        declaration.connection?.auth !== "host-verified-official-launcher" || declaration.recording?.file !== "screen.mp4" ||
        worldProof?.type !== "vanilla" || worldProof.mode !== "survival" || worldProof.difficulty !== "normal" ||
        !(fresh || continued) ||
        outcome?.schemaVersion !== 1 || outcome.goal !== declaration.goal || !time(declaration.startedAt) ||
        outcome.startedAt !== declaration.startedAt || !time(outcome.finishedAt) ||
        !STATUSES.includes(outcome.status) || (outcome.status === "won" &&
          (goal === declaration.goal || outcome.verification?.verified !== true)) ||
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
    return { root, rootInode, device, world, progress: outcome.progress as Progress | null };
  } catch {
    signal.throwIfAborted();
    throw invalid();
  }
}

type Cell = [number, number, number];
type PilotMemory = { version: 1; dimension: typeof OVERWORLD; trail: Cell[]; workbench?: Cell; furnace?: Cell };

function isCell(value: unknown): value is Cell {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isInteger) &&
    Math.abs(value[0]) <= 30_000_000 && value[1] >= -64 && value[1] <= 320 &&
    Math.abs(value[2]) <= 30_000_000;
}

function adjacentCells(a: Cell, b: Cell) {
  return Math.abs(a[1] - b[1]) <= 1 && Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]) <= 1;
}

function decodePilotMemory(text: string): PilotMemory | null {
  try {
    const value = JSON.parse(text);
    if (value?.version !== 1 || value?.dimension !== OVERWORLD || !Array.isArray(value.trail) ||
        value.trail.length > MEMORY_CELLS ||
        Object.keys(value).some((key) => !["version", "dimension", "trail", "workbench", "furnace"].includes(key)) ||
        ("workbench" in value && !isCell(value.workbench)) || ("furnace" in value && !isCell(value.furnace))) return null;
    const seen = new Set<string>();
    let previous: Cell | undefined;
    for (const cell of value.trail) {
      if (!isCell(cell) || previous && !adjacentCells(previous, cell)) return null;
      const key = cell.join(",");
      if (seen.has(key)) return null;
      seen.add(key);
      previous = cell;
    }
    return value;
  } catch {
    return null;
  }
}

type SavedWorld = Awaited<ReturnType<typeof savedWorld>>;
type ReadPilotArtifact = (name: string, maxBytes: number, privateMode?: boolean) => Promise<string | undefined | null>;

// undefined means absent; null means present but unsuitable. Only absence permits legacy recovery.
async function readPilotArtifact(parent: string, device: number, name: string, maxBytes: number, signal: AbortSignal,
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

function passageActivity(status: string) {
  if (status === "descending a mined staircase" || /^branch mining at y=-?\d{1,3}$/.test(status)) return "outward";
  if (status === "returning along traveled steps" || status === "climbing a traveled step" ||
      status === "resuming a traveled mine") return "known";
  return null;
}

function sameCell(a: Cell | undefined, b: Cell) {
  return a?.[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

async function recoverPilotTrail(pose: Progress | null, read: ReadPilotArtifact): Promise<PilotMemory | null> {
  if (pose?.alive !== true || pose.dimension !== OVERWORLD || !Number.isSafeInteger(pose.tick) ||
      typeof pose.status !== "string" || !passageActivity(pose.status) ||
      ![pose.x, pose.y, pose.z].every(Number.isFinite)) return null;
  // Movement alone has no dimension. Refuse to join samples across any recorded dimension change.
  const events = await read("events.jsonl", 4_000_000);
  if (!events?.endsWith("\n")) return null;
  let eventTick = 0;
  try {
    for (const line of events.slice(0, -1).split("\n")) {
      const event = JSON.parse(line);
      if (event?.dimension !== OVERWORLD || !Number.isSafeInteger(event.tick) ||
          event.tick <= eventTick || (!eventTick && event.tick !== 1)) return null;
      eventTick = event.tick;
    }
  } catch {
    return null;
  }
  if (Math.abs(eventTick - pose.tick) > 100) return null;

  const text = await read("movement.tsv", 4_000_000);
  if (!text?.endsWith("\n")) return null;
  const rows = text.slice(0, -1).split("\n");
  if (rows[0] !== "tick\twall_ms\tx\ty\tz\tyaw\tpitch\tgrounded\tsprinting\tfood\tgui\tactivity") return null;
  const trail: Cell[] = [];
  let cursor = -1;
  let lastTick = 0;
  let stable = 0;
  let previous: Cell | undefined;
  let lastDistance = Infinity;
  for (let i = 1; i < rows.length; i++) {
    const fields = rows[i]?.split("\t");
    if (!fields || fields.length !== 12) return null;
    const tick = Number(fields[0]);
    if (!Number.isSafeInteger(tick) || tick <= lastTick) return null;
    if (lastTick && tick - lastTick > 4) { trail.length = 0; cursor = -1; stable = 0; }
    lastTick = tick;
    lastDistance = Infinity;
    if (fields[7] === "false") { stable = 0; continue; }
    if (fields[7] !== "true" || !fields[2] || !fields[3] || !fields[4]) return null;
    const x = Number(fields[2]), y = Number(fields[3]), z = Number(fields[4]);
    const cell = [Math.floor(x), Math.floor(y), Math.floor(z)];
    if (!isCell(cell)) return null;
    stable = sameCell(previous, cell) ? stable + 1 : 1;
    previous = cell;
    const activity = passageActivity(fields[11] ?? "");
    // At staircase lips grounded may briefly describe the old support under a neighboring column.
    if (stable < 3) continue;
    const current = trail[cursor];
    if (!sameCell(current, cell)) {
      const index = trail.findIndex((p) => sameCell(p, cell));
      if (!activity) {
        trail.length = 0;
        cursor = -1;
      } else if (index >= 0 && current && adjacentCells(current, cell)) {
        cursor = index;
      } else if (current && adjacentCells(current, cell) && cell[0] === current[0] && cell[2] === current[2]) {
        // Only actual walking/stair steps have legacy proof. Stop at the observed ledge.
        continue;
      } else if (activity === "outward") {
        if (current && !adjacentCells(current, cell)) cursor = -1;
        trail.length = cursor + 1;
        if (trail.length === MEMORY_CELLS) trail.shift();
        trail.push(cell);
        cursor = trail.length - 1;
      } else {
        trail.length = 0;
        cursor = -1;
      }
    }
    if (activity && sameCell(trail[cursor], cell) &&
        cell[0] === Math.floor(pose.x) && cell[1] === Math.floor(pose.y) && cell[2] === Math.floor(pose.z)) {
      lastDistance = Math.hypot(x - pose.x, y - pose.y, z - pose.z);
    }
  }
  if (trail.length < 2 || Math.abs(lastTick - pose.tick) > 30 || lastDistance > 0.7) return null;
  return { version: 1, dimension: OVERWORLD, trail };
}

async function copyPilotMemory(source: SavedWorld, destination: string, signal: AbortSignal) {
  const parent = await open(source.root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
    .catch(() => null);
  if (!parent) return;
  let memory: PilotMemory | null;
  try {
    const entry = await parent.stat();
    if (!entry.isDirectory() || entry.ino !== source.rootInode || entry.dev !== source.device ||
        entry.uid !== process.getuid?.() || (entry.mode & 0o077)) return;
    // Pin the approved directory while opening its exact artifacts.
    const root = `/proc/self/fd/${parent.fd}`;
    const read: ReadPilotArtifact = (name, limit, privateMode) =>
      readPilotArtifact(root, source.device, name, limit, signal, privateMode);
    const text = await read(MEMORY_FILE, MEMORY_BYTES, true);
    memory = text === undefined ? await recoverPilotTrail(source.progress, read) : text ? decodePilotMemory(text) : null;
  } finally {
    await parent.close();
  }
  if (!memory) return;
  signal.throwIfAborted();
  const file = await open(path.join(destination, MEMORY_FILE), "wx", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(memory), { signal });
  } finally {
    await file.close();
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

async function readProgress(file: string): Promise<Progress | null> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(text) as Progress;
  if (!Number.isSafeInteger(value?.tick) || typeof value.status !== "string" || typeof value.goal !== "string" ||
      typeof value.won !== "boolean" || typeof value.alive !== "boolean" ||
      ![value.x, value.y, value.z, value.health].every(Number.isFinite) ||
      !value.inventory || typeof value.inventory !== "object" || Array.isArray(value.inventory) ||
      !Object.values(value.inventory).every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error("Pilot wrote an invalid progress snapshot.");
  }
  return value;
}

function materialChange(current: Progress, prior: Progress) {
  if (Math.hypot(current.x - prior.x, current.y - prior.y, current.z - prior.z) >= 1 ||
      current.health !== prior.health || current.alive !== prior.alive) return true;
  const items = Object.entries(current.inventory);
  return items.length !== Object.keys(prior.inventory).length ||
    items.some(([item, count]) => count !== prior.inventory[item]);
}

function goalMilestones(goal: Goal, progress: Progress, highWater: Map<string, number>) {
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

async function run(goal: Goal, seconds: number, parentRun: string | undefined, diagnostic: Diagnostic | undefined) {
  const display = await isolatedDisplay();
  const { java, ffmpeg } = await verifyInputs();
  const runs = diagnostic ? DIAGNOSTIC_RUNS : RUNS;
  const liveFile = diagnostic ? DIAGNOSTIC_LIVE : LIVE;
  const descent = diagnostic === "pool" ? undefined : diagnostic;
  const descentMonitor = descent ? monitorDescent(descent) : null;
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
  try {
    release = diagnostic ? await admitRun(reserveBytes, "diagnostic") : await admitRun(reserveBytes);
    signal.throwIfAborted();
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const source = parentRun ? await savedWorld(parentRun, goal, signal) : null;
    const dir = await mkdtemp(path.join(runs, `${new Date().toISOString().replaceAll(":", "-")}-${goal}-`));
    console.log(dir);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const timer = setTimeout(() => abort("wall_limit", `Reached the ${seconds}s wall limit.`), seconds * 1_000);
    const record = (event: string, fields: Record<string, unknown> = {}) => appendFile(
      path.join(dir, "history.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), event, ...fields })}\n`,
      { mode: 0o600 },
    );
    const progressFile = path.join(dir, "progress.json");
    const video = path.join(dir, "screen.mp4");
    const live = { run: path.basename(dir), ...display };
    const world = descent ? descentWorld(descent) : diagnostic ? poolDiagnosticWorld : {
      type: "vanilla", mode: "survival", difficulty: "normal",
      ...(parentRun ? { fresh: false, parentRun } : { fresh: true, seed: "random" }),
    };
    let declared = false;
    let stage = "declaration";
    let server: Owned | undefined;
    let client: Owned | undefined;
    let recorder: Owned | undefined;
    let diagnostics: Set<string> | undefined;
    let lastProgress: Progress | null = null;
    let descentSettlement: { firstTick: number; settledTick: number } | null = null;
    let measuredBytes: number | null = null;
    let meter: Promise<void> | undefined;
    let result = new Stop("failed", "Run ended without a recorded outcome.");
    const startupDeadline = AbortSignal.timeout(STARTUP_MS);
    const startup = AbortSignal.any([signal, startupDeadline]);
    const env = { PATH: "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" };
    const launcher = new MinecraftClient(ROOT, { dataDir: path.join(dir, "client"), java });
    try {
      const pilotJarSha256 = await launcher.stagePilotArtifact(PILOT_JAR);
      const port = await loopbackPort();
      await privateJson(path.join(dir, "declaration.json"), {
        schemaVersion: 1, startedAt, goal, minecraftVersion: "1.21.4", pilotJarSha256,
        world,
        connection: { host: "127.0.0.1", port, auth: "host-verified-official-launcher" },
        limits: {
          wallSeconds: seconds, startupMs: STARTUP_MS, heartbeatMs: HEARTBEAT_MS,
          stallMs: STALL_MS, goalStallMs: GOAL_STALL_MS,
          reserveBytes, videoBytes, drainHeadroomBytes: DRAIN_HEADROOM,
        },
        recording: { file: "screen.mp4", size: SIZE, fps: 30, codec: "h264", cursor: true, audio: false },
      });
      declared = true;
      await privateJson(liveFile, { ...live, active: true });
      console.log(diagnostic
        ? "Diagnostic live view: http://127.0.0.1:4382/ (start with `bun survival-pilot/watch.ts --diagnostic` if needed)"
        : "Live view: http://127.0.0.1:4379/ (start with `bun run watch:pilot` if needed)");
      await record("declared");
      meter = (async () => {
        while (!signal.aborted) {
          measuredBytes = await diskBytes(dir, signal);
          if (measuredBytes >= (stage === "world_copy" ? copyStopBytes : storageStopBytes)) {
            abort("storage_limit", "Run reached its storage stop threshold.");
            return;
          }
          await delay(1_000, undefined, { signal });
        }
      })().catch(() => {
        if (!signal.aborted) abort("failed", "Could not measure run storage.");
      });
      stage = source ? "world_copy" : "server_startup";
      const worldDir = path.join(dir, "server");
      await mkdir(worldDir, { mode: 0o700 });
      if (source) {
        const destination = path.join(worldDir, "world");
        const bytesBefore = await diskBytes(dir, startup);
        await checkWorldTree(source.world, source.device, copyStopBytes - bytesBefore, startup);
        startup.throwIfAborted();
        // Reflink when supported, otherwise copy. Never follow links or share writable inodes.
        const copier = own(spawn("cp", [
          "--recursive", "--no-dereference", "--reflink=auto", "--preserve=mode,timestamps",
          "--", source.world, destination,
        ], { env, signal: startup, stdio: "ignore" }));
        const exit = await copier.closed;
        startup.throwIfAborted();
        if (exit.code !== 0) throw new Stop("failed", "Could not copy the saved pilot world.");
        await checkWorldTree(destination, source.device, copyStopBytes - bytesBefore, startup);
        await copyPilotMemory(source, dir, startup);
        measuredBytes = await diskBytes(dir, startup);
        if (measuredBytes >= copyStopBytes)
          throw new Stop("storage_limit", "Saved world would exceed the run storage stop threshold.");
        await record("world_copied", { parentRun });
        stage = "server_startup";
      }
      const serverTmp = path.join(worldDir, "tmp");
      await mkdir(serverTmp, { mode: 0o700 });
      await writeFile(path.join(worldDir, "eula.txt"), "eula=true\n");
      await writeFile(path.join(worldDir, "server.properties"), [
        "server-ip=127.0.0.1", `server-port=${port}`, "online-mode=false",
        "enforce-secure-profile=false", "gamemode=survival", "difficulty=normal",
        "hardcore=false", "level-name=world", "view-distance=6", "simulation-distance=6", "spawn-protection=0",
        "max-players=1", "log-ips=false", "enable-rcon=false", "enable-query=false",
        ...(descent ? descentServerProperties : diagnostic ? poolDiagnosticServerProperties : []), "",
      ].join("\n"));
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
      const launched = await launcher.launchPilot({
        runtimeCache: RUNTIME, port, goal, evidenceDir: dir, ...display,
        beforeConnect: diagnostic ? async (profileName) => {
          stage = "diagnostic_provisioning";
          if (descent) await provisionDescent(descent, runningServer.child, worldDir, profileName, startup);
          else await provisionPoolDiagnostic(runningServer.child, worldDir, profileName, startup);
          await record("diagnostic_sealed");
          stage = "client_startup";
        } : undefined,
      }, startup);
      client = own(launched.child, launched.closed);
      diagnostics = launched.diagnostics;
      await record("client_started");

      let tickAt = performance.now();
      let changedAt = tickAt;
      let goalChangedAt = tickAt;
      const highWater = new Map<string, number>();
      let anchor: Progress | null = null;
      while (!signal.aborted) {
        const progress = await readProgress(progressFile);
        const now = performance.now();
        if (progress) {
          if (progress.goal !== goal) throw new Error("Pilot reported a different goal.");
          if (!lastProgress) {
            startup.throwIfAborted();
            stage = "playing";
            goalChangedAt = now;
            await record("pilot_ready", { tick: progress.tick });
          }
          if (!lastProgress || progress.tick !== lastProgress.tick) {
            tickAt = now;
            const milestones = goalMilestones(goal, progress, highWater);
            if ((lastProgress || !source) && Object.keys(milestones).length) {
              goalChangedAt = now;
              await record("goal_progress", { tick: progress.tick, milestones });
            }
          }
          if (!anchor || materialChange(progress, anchor)) {
            anchor = progress;
            changedAt = now;
          }
          lastProgress = progress;
          signal.throwIfAborted();
          if (descentMonitor) {
            if (!progress.alive) throw new Stop("died", "The pilot died during the descent trial.");
            const observed = descentMonitor(progress);
            if (typeof observed === "string") throw new Stop("unverified", observed);
            if (observed) {
              descentSettlement = observed;
              await record("descent_settled", observed);
              throw new Stop("won", `Observed the ${descent} descent and subsequent survival.`);
            }
            if (progress.won) throw new Stop("unverified", "The ordinary goal ended before proving the descent.");
          } else if (progress.won && (goal === "nether_portal" ? progress.dimension === "minecraft:the_nether" :
              (progress.inventory[`minecraft:${goal}`] ?? 0) > 0)) {
            throw new Stop("won", diagnostic ? "Pilot cast and lit a portal and entered the Nether."
              : goal === "nether_portal" ? "Pilot built a portal and entered the Nether." : `Pilot obtained ${goal}.`);
          }
          if (!progress.alive) throw new Stop("died", "The pilot died before obtaining the goal.");
          if (typeof progress.failure === "string") throw new Stop("stalled", progress.failure);
        }
        if (client.exit) throw new Stop("client_exit", "Minecraft client exited before reporting success.");
        if (!lastProgress && startup.aborted) {
          if (signal.aborted) signal.throwIfAborted();
          throw new Stop("startup_limit", "The pilot did not report progress before the startup limit.");
        }
        if (lastProgress && now - tickAt >= HEARTBEAT_MS) {
          throw new Stop("heartbeat_lost", "Pilot ticks stopped advancing.");
        }
        if (lastProgress && now - changedAt >= STALL_MS) {
          throw new Stop("stalled", "The pilot stopped moving or changing inventory and health.");
        }
        if (lastProgress && now - goalChangedAt >= GOAL_STALL_MS) {
          throw new Stop("goal_stalled", "The pilot reached no new goal milestone for five minutes.");
        }
        await delay(350, undefined, { signal });
      }
      signal.throwIfAborted();
    } catch (error) {
      if (error instanceof Stop) result = error;
      else if (signal.reason instanceof Stop) result = signal.reason;
      else if (startupDeadline.aborted && stage !== "playing") {
        result = new Stop("startup_limit", "Minecraft did not start before the startup limit.");
      } else {
        const auth = nativeLaunchFailure(error);
        const setupFailure = descent && stage === "diagnostic_provisioning" && error instanceof Error
          ? error.message : undefined;
        result = new Stop("failed", auth?.error ?? setupFailure ?? `Run failed during ${stage}.`);
        if (!auth && error instanceof Error)
          await record("failure", { stage, category: error.name }).catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      const recorderDrained = await drain(recorder, "q\n").then(() => true, () => false);
      const settled = await Promise.allSettled([
        drain(client), drain(server, "stop\n", 12_000), meter,
      ]);
      if (!recorderDrained || settled.some((step) => step.status === "rejected")) {
        result = new Stop("failed", "An owned process could not be drained cleanly.");
      }
      if (declared) {
        await privateJson(liveFile, { ...live, active: false }).catch(() => {
          result = new Stop("failed", "Could not mark the live view inactive.");
        });
      }
      measuredBytes = await diskBytes(dir).catch(() => measuredBytes);
      let verification: Awaited<ReturnType<typeof verifySurvival> | ReturnType<typeof verifyDescent>> | null = null;
      if (result.status === "won") {
        verification = descent ? await verifyDescent(dir, descent, descentSettlement) :
          await verifySurvival(path.join(dir, "server/world/stats"), goal, lastProgress, diagnostic === "pool");
        const videoExists = await stat(video).then((entry) => entry.size > 0, () => false);
        if (!verification.verified) result = new Stop("unverified", verification.reason);
        else if (server?.exit?.code !== 0)
          result = new Stop("server_exit", "The vanilla server did not stop cleanly after the goal.");
        else if (!videoExists || recorder?.exit?.code !== 0)
          result = new Stop("recorder_exit", "The verified goal has no completed screen recording.");
        else if (measuredBytes !== null && measuredBytes > reserveBytes)
          result = new Stop("storage_limit", "Final artifacts exceeded the run reservation.");
      }
      const outcome = {
        schemaVersion: 1, status: result.status, reason: result.message, goal, startedAt, world,
        finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start),
        finalStage: stage, reservedBytes: reserveBytes, measuredBytes, progress: lastProgress,
        verification: verification && parentRun ? { ...verification, scope: "continuation-chain" } : verification,
        exits: { server: server?.exit ?? null, client: client?.exit ?? null, recorder: recorder?.exit ?? null },
        clientDiagnostics: [...(diagnostics ?? [])],
      };
      await privateJson(path.join(dir, "outcome.json"), outcome);
      await record("closed", { status: outcome.status });
      console.log(JSON.stringify(outcome));
    }
    return receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 :
      receivedSignal === "SIGHUP" ? 129 : result.status === "won" ? 0 : 1;
  } finally {
    release?.();
    for (const { name, listener } of interrupts) process.off(name, listener);
  }
}

try {
  const args = process.argv.slice(2);
  if ((args.length === 1 && args[0] === "--help") ||
      (args.length === 2 && (args[0] === "--diagnostic-pool" || args[0] === "--diagnostic-descent") &&
        args[1] === "--help")) console.log(usage);
  else {
    const { goal, seconds, parentRun, diagnostic } = parseArgs(args);
    process.umask(0o077);
    process.exitCode = await run(goal, seconds, parentRun, diagnostic);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Run failed.");
  process.exitCode = 1;
}
