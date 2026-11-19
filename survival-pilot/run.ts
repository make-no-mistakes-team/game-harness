#!/usr/bin/env bun
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { JAVA, MinecraftClient, privateJson } from "../src/server/minecraft-client.ts";
import { nativeLaunchFailure } from "../src/server/native-launch-fault.ts";
import { admitRun } from "./storage.ts";
import { verifySurvival } from "./verify.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const RUNTIME = path.join(ROOT, "local/runtime");
const PILOT_LOCAL = path.join(ROOT, "local/survival-pilot");
const RUNS = path.join(PILOT_LOCAL, "runs");
const LIVE = path.join(PILOT_LOCAL, "live.json");
const SERVER_JAR = path.join(RUNTIME, "minecraft/server-1.21.4.jar");
const PILOT_JAR = path.join(import.meta.dir, "build/libs/survival-pilot-1.0.jar");
const GOALS = ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond"] as const;
const RUN_BASENAME = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-(?:${GOALS.join("|")})-[A-Za-z0-9]{6}$`);
const DEFAULT_SECONDS = 900;
const MAX_SECONDS = Math.floor(2_147_483_647 / 1_000);
const SIZE = "1280x720";
const STARTUP_MS = 120_000;
const HEARTBEAT_MS = 20_000;
const STALL_MS = 180_000;
const GOAL_STALL_MS = 300_000;
const DRAIN_HEADROOM = 128_000_000;
const exec = promisify(execFile);
type Goal = (typeof GOALS)[number];
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Owned = { child: ChildProcess; closed: Promise<Exit>; exit?: Exit };
type Progress = {
  failure?: string;
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

const usage = `Usage: xvfb-run -a -s '-screen 0 ${SIZE}x24' bun survival-pilot/run.ts GOAL [SECONDS [--continue-from RUN_BASENAME]]

GOAL: ${GOALS.join(" | ")}
SECONDS: wall limit including startup, 1–${MAX_SECONDS} (default ${DEFAULT_SECONDS}).
--continue-from: copy a closed, recorded, non-winning pilot world for the same goal.

Build survival-pilot-1.0.jar first. Requires Java 21, ffmpeg, existing local EULA
consent, and a signed-in official Launcher with Minecraft 1.21.4 installed.
Without JAVA_HOME, the runner prefers the system OpenJDK 21 installation.
Only a confirmed goal exits 0. Artifacts and outcome JSON go in the printed run directory.`;

function parseArgs(args: string[]) {
  const [rawGoal, rawSeconds = String(DEFAULT_SECONDS), flag, parentRun] = args;
  const goal = GOALS.find((item) => item === rawGoal);
  const seconds = Number(rawSeconds);
  if (!goal || (args.length > 2 && (args.length !== 4 || flag !== "--continue-from" ||
      !parentRun || !RUN_BASENAME.test(parentRun))) || !/^\d+$/.test(rawSeconds) ||
      !Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
    throw new Error(usage);
  }
  return { goal, seconds, parentRun };
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
  const consent = await readFile(path.join(RUNTIME, "provisioning-consent.json"), "utf8")
    .then((content) => JSON.parse(content)).catch(() => null);
  if (consent?.eulaAccepted !== true || consent?.minecraftVersion !== "1.21.4" ||
      consent?.eulaUrl !== "https://www.minecraft.net/en-us/eula") {
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
  const invalid = () => new Error(`Cannot continue from ${parentRun}: expected a closed, recorded pilot attempt for ${goal} with a clean save and no win.`);
  try {
    const uid = process.getuid?.();
    const runs = await lstat(RUNS);
    if (!runs.isDirectory() || runs.uid !== uid) throw invalid();
    const device = runs.dev;
    for (const dir of [root, server, world, path.join(world, "region")]) {
      signal.throwIfAborted();
      const entry = await lstat(dir);
      if (!entry.isDirectory() || entry.dev !== device || entry.uid !== uid ||
          (dir === root && (entry.mode & 0o077))) throw invalid();
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
    if (declaration?.schemaVersion !== 1 || declaration.goal !== goal || declaration.minecraftVersion !== "1.21.4" ||
        typeof declaration.pilotJarSha256 !== "string" || !/^[a-f0-9]{64}$/.test(declaration.pilotJarSha256) ||
        declaration.connection?.host !== "127.0.0.1" ||
        declaration.connection?.auth !== "host-verified-official-launcher" || declaration.recording?.file !== "screen.mp4" ||
        worldProof?.type !== "vanilla" || worldProof.mode !== "survival" || worldProof.difficulty !== "normal" ||
        !(fresh || continued) ||
        outcome?.schemaVersion !== 1 || outcome.goal !== goal || !time(declaration.startedAt) ||
        outcome.startedAt !== declaration.startedAt || !time(outcome.finishedAt) ||
        !STATUSES.includes(outcome.status) || outcome.status === "won" ||
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
    return { world, device };
  } catch {
    signal.throwIfAborted();
    throw invalid();
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
    if (tier === 3) capped("diamond", count("diamond"), 1);
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

async function run(goal: Goal, seconds: number, parentRun?: string) {
  const display = await isolatedDisplay();
  const { java, ffmpeg } = await verifyInputs();
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
    release = await admitRun(reserveBytes);
    signal.throwIfAborted();
    await mkdir(RUNS, { recursive: true, mode: 0o700 });
    const source = parentRun ? await savedWorld(parentRun, goal, signal) : null;
    const dir = await mkdtemp(path.join(RUNS, `${new Date().toISOString().replaceAll(":", "-")}-${goal}-`));
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
    const world = {
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
      await privateJson(LIVE, { ...live, active: true });
      console.log("Live view: http://127.0.0.1:4379/ (start with `bun run watch:pilot` if needed)");
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
        "max-players=1", "log-ips=false", "enable-rcon=false", "enable-query=false", "",
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
      void server.closed.then(() => abort("server_exit", "Vanilla server exited unexpectedly."));
      void recorder.closed.then(async () => {
        if (signal.aborted) return;
        const size = await stat(video).then((entry) => entry.size, () => 0);
        if (size >= videoBytes - 64_000) abort("recording_limit", "Recording reached its byte limit.");
        else abort("recorder_exit", "The screen recorder exited unexpectedly.");
      });
      const launched = await launcher.launchPilot({
        runtimeCache: RUNTIME, port, goal, evidenceDir: dir, ...display,
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
          if (progress.won && (progress.inventory[`minecraft:${goal}`] ?? 0) > 0) {
            throw new Stop("won", `Pilot obtained ${goal}.`);
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
        result = new Stop("failed", auth?.error ?? `Run failed during ${stage}.`);
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
        await privateJson(LIVE, { ...live, active: false }).catch(() => {
          result = new Stop("failed", "Could not mark the live view inactive.");
        });
      }
      measuredBytes = await diskBytes(dir).catch(() => measuredBytes);
      let verification: Awaited<ReturnType<typeof verifySurvival>> | null = null;
      if (result.status === "won") {
        verification = await verifySurvival(path.join(dir, "server/world/stats"), goal, lastProgress);
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
  if (args.length === 1 && args[0] === "--help") console.log(usage);
  else {
    const { goal, seconds, parentRun } = parseArgs(args);
    process.umask(0o077);
    process.exitCode = await run(goal, seconds, parentRun);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Run failed.");
  process.exitCode = 1;
}
