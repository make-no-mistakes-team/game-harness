import { Database } from "bun:sqlite";
import { execFile, spawn } from "node:child_process";
import { constants, existsSync, readFileSync, readlinkSync } from "node:fs";
import { access, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { hasConfirmedTerraEffect, SURVIVAL_AGENT_STRATEGY_OUTCOMES, TERRA_MODEL_ID,
  type SurvivalAgentGoal, type SurvivalAgentSnapshot, type SurvivalAgentStart } from "../shared/survival-agent-ui.ts";
import { prepareAgentServerArtifact } from "./minecraft-server-artifact.ts";
import { TERRA_ACTOR_REBUILD } from "./survival-agent-artifact.ts";
import { AgentVideo, type AgentDisplay } from "./survival-agent-video.ts";

const SYSTEM_PATH = "/usr/bin:/bin";
const LIMIT_SECONDS: Record<SurvivalAgentGoal, number> = {
  wooden_pickaxe: 900, stone_pickaxe: 900, iron_pickaxe: 900, diamond: 1800, nether_portal: 3600,
};
const IDLE: SurvivalAgentSnapshot = {
  phase: "idle", goal: null, strategy: null, model: null, strategyOutcome: null,
  status: "Ready to start a new Survival world.",
  won: null, run: null, elapsedMs: 0, health: null, food: null, deaths: null,
};
const LAUNCHER_REQUIRED = "Sign in and launch Minecraft 1.21.4 in the official Launcher, then try again.";
const EULA_REQUIRED = "Accept the Minecraft EULA in GameHarness settings, then try again.";
const LANE_BUSY = "A Minecraft Survival Agent run is already active. Stop it before starting another run.";
const isReadable = (file: string) => access(file, constants.R_OK).then(() => true, () => false);
const inspect = promisify(execFile);

export class AgentRequestFault extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

class AgentLaunchFault extends Error {}

type Attempt = SurvivalAgentStart & {
  began: number;
  stop: AbortController;
  done: Promise<void>;
  view: SurvivalAgentSnapshot;
  display: AgentDisplay | null;
  video: AgentVideo;
};

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024 || info.uid !== process.getuid?.()) return null;
      const result = JSON.parse(await handle.readFile("utf8"));
      return result && typeof result === "object" && !Array.isArray(result) ? result : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

function readProcess(pid: number) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const [state, parent, group] = fields;
    const started = fields[19]; // proc(5): field 22, with fields 1 and 2 removed.
    if (state === "Z" || state === "X" || !started) return;
    return { pid, parent: Number(parent), group: Number(group), started };
  } catch { return; }
}

function children(parent: number) {
  try {
    return readFileSync(`/proc/${parent}/task/${parent}/children`, "utf8").trim().split(/\s+/)
      .map(Number).filter((pid) => pid > 0);
  } catch { return []; }
}

function argv(pid: number) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1); }
  catch { return []; }
}

function cleanSignal(pid: number, signal: NodeJS.Signals): boolean {
  try { return process.kill(pid, signal); }
  catch { return false; } // A child can exit between its identity check and delivery.
}

function agentVitals(view: SurvivalAgentSnapshot, progress: Record<string, unknown> | null) {
  if (progress?.goal !== view.goal || typeof progress.tick !== "number" || !Number.isSafeInteger(progress.tick) ||
      progress.tick < 1) return;
  const { health, food, deaths, status } = progress;
  if (typeof deaths === "number" && Number.isSafeInteger(deaths) && deaths >= 0)
    view.deaths = deaths;
  view.health = typeof health === "number" && Number.isFinite(health) && health >= 0 && health <= 20 ? health : null;
  view.food = typeof food === "number" && Number.isInteger(food) && food >= 0 && food <= 20 ? food : null;
  if (view.phase === "stopping") return;
  view.phase = "playing";
  const activity = typeof status === "string" ? status.replace(/\b(\d+)\/(\d+)\b/g, "$1 of $2") : "";
  // The native mod supplies its own activity label, not logs or arbitrary file/connection details.
  view.status = /^[a-zA-Z0-9_:()'.,;!? -]{1,180}$/.test(activity) ? activity : "Playing Survival.";
}

function terraOutcome(outcome: Record<string, unknown>): SurvivalAgentSnapshot["strategyOutcome"] {
  const strategy = outcome.strategy as Record<string, unknown> | null | undefined;
  if (strategy?.strategy !== "terra" || strategy.model !== TERRA_MODEL_ID) return null;
  const status = SURVIVAL_AGENT_STRATEGY_OUTCOMES.find(value => value === strategy.outcome);
  if (status === "native_effect_completed" && (strategy.admission !== "admitted" || !hasConfirmedTerraEffect(strategy.status)))
    return null;
  return status ?? null;
}

function outcomeStatus(outcome: Record<string, unknown>) {
  switch (outcome.status) {
    case "won": return "Goal reached and verified.";
    case "died": return "The agent died before reaching the goal.";
    case "interrupted": return "Agent stopped.";
    case "wall_limit": return "The run reached its time limit.";
    case "startup_limit": return "Minecraft did not start in time. Check the installation and try again.";
    case "heartbeat_lost": return "Minecraft stopped reporting progress.";
    case "stalled": return "The agent could not continue.";
    case "goal_stalled": return "The agent reached no new goal milestone for five minutes.";
    case "storage_limit":
    case "recording_limit": return "The run reached its recording or storage limit.";
    case "server_exit": return "The local Minecraft server exited unexpectedly. Check Java 21 and try again.";
    case "client_exit": return "The Minecraft client exited unexpectedly. Check Minecraft 1.21.4 and try again.";
    case "recorder_exit": return "The screen recorder exited unexpectedly. Check FFmpeg with x11grab and libx264.";
    case "unverified": return "The agent’s goal could not be verified.";
    default:
      if (outcome.reason === TERRA_ACTOR_REBUILD) return TERRA_ACTOR_REBUILD;
      if (outcome.reason === "The official Launcher Minecraft session is unavailable. Sign in and launch Minecraft 1.21.4 with the official Launcher.")
        return LAUNCHER_REQUIRED;
      return outcome.finalStage === "client_startup" ?
        "Minecraft could not launch. Check the official Launcher installation and Fabric download access." :
        "Minecraft Survival Agent could not finish the run.";
  }
}

function startupFailure(line: string) {
  if (/^The survival lane (?:already has an active run|is locked without a shared reservation)\b/.test(line)) return LANE_BUSY;
  if (/^The previous (?:survival|diagnostic) run left an unreleased reservation\b/.test(line))
    return "A previous agent run did not confirm cleanup. Resolve that local run before starting another.";
  if (line.startsWith("Insufficient storage:"))
    return "There is not enough disk space for a new agent run. Free space and try again.";
  if (line === TERRA_ACTOR_REBUILD) return TERRA_ACTOR_REBUILD;
  if (line === "Existing explicit Minecraft 1.21.4 EULA consent is required.") return EULA_REQUIRED;
  if (line.startsWith("xvfb-run: error:") || line.startsWith("Run this command under xvfb-run"))
    return "The isolated Minecraft display could not start. Check Xvfb and xauth.";
  return undefined;
}

/** Owns exactly one fresh desktop agent run; standalone CLI runs keep authority over their own processes. */
export class SurvivalAgent {
  private active: Attempt | null = null;
  private last = IDLE;
  private closed = false;
  private readonly runs: string;

  constructor(private readonly root: string, private readonly dataDir: string) {
    this.runs = path.join(root, "local/survival-agent/runs");
  }

  busy(): boolean { return this.active !== null; }

  snapshot(): SurvivalAgentSnapshot {
    const attempt = this.active;
    if (!attempt) return { ...this.last };
    return { ...attempt.view, elapsedMs: Math.round(performance.now() - attempt.began) };
  }

  start({ goal, strategy }: SurvivalAgentStart): SurvivalAgentSnapshot {
    if (this.closed) throw new AgentRequestFault(503, "unavailable", "Minecraft Survival Agent is shutting down.");
    if (this.active) throw new AgentRequestFault(409, "busy", "Stop the current agent run first.");
    this.assertOrdinaryLaneAvailable();
    const attempt: Attempt = {
      goal, strategy, began: performance.now(), stop: new AbortController(), done: Promise.resolve(),
      view: { ...IDLE, goal, strategy, model: strategy === "terra" ? TERRA_MODEL_ID : null,
        phase: "starting", status: "Checking Minecraft prerequisites." },
      display: null, video: new AgentVideo(),
    };
    this.active = attempt;
    attempt.done = this.execute(attempt);
    return this.snapshot();
  }

  stop(): SurvivalAgentSnapshot {
    if (this.active && !this.active.stop.signal.aborted) {
      this.active.view.phase = "stopping";
      this.active.view.status = "Stopping the agent and saving the world.";
      this.active.stop.abort();
    }
    return this.snapshot();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    await this.active?.done;
  }

  video(request: Request, sessionExpires: number, requestedRun: string | null, headers: Record<string, string>): Response {
    const attempt = this.active;
    if (!attempt?.display || !attempt.view.run || attempt.view.phase !== "playing" ||
        requestedRun !== null && requestedRun !== attempt.view.run)
      throw new AgentRequestFault(409, "video_unavailable", "The requested agent run is not currently streaming.");
    try {
      const response = attempt.video.open(attempt.display, request.signal, sessionExpires, headers);
      if (response) return response;
    } catch { /* Keep capture diagnostics private. */ }
    throw new AgentRequestFault(409, "video_unavailable", "The isolated agent display is unavailable or already has two viewers.");
  }

  private assertOrdinaryLaneAvailable() {
    // Probe the same SQLite write lock the CLI holds. The child still owns the
    // authoritative atomic admission, including races after this early check.
    const lock = path.join(path.dirname(this.runs), "owner.sqlite");
    if (!existsSync(lock)) return;
    let owner: Database | undefined;
    try {
      owner = new Database(lock, { readwrite: true });
      owner.run("PRAGMA busy_timeout = 0");
      owner.run("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "SQLITE_BUSY")
        throw new AgentRequestFault(409, "busy", LANE_BUSY);
      throw new AgentRequestFault(409, "unavailable", "Minecraft Survival Agent could not inspect the ordinary lane lock.");
    } finally { owner?.close(); }
  }

  private async prerequisites(attempt: Attempt) {
    const tools = Object.fromEntries(["xvfb-run", "Xvfb", "xauth", "ffmpeg"].map((name) =>
      [name, Bun.which(name, { PATH: SYSTEM_PATH })]));
    if (!tools["xvfb-run"] || !tools.Xvfb || !tools.xauth || !tools.ffmpeg)
      throw new AgentLaunchFault("Install Xvfb, xauth and FFmpeg with x11grab and libx264, then try again.");
    const consentPaths = new Set([this.dataDir, path.join(this.root, "local/runtime")]);
    const consents = await Promise.all([...consentPaths].map((directory) => readJson(path.join(directory, "provisioning-consent.json"))));
    if (!consents.some((consent) => consent?.eulaAccepted === true && consent.minecraftVersion === "1.21.4" &&
        consent.eulaUrl === "https://www.minecraft.net/en-us/eula")) throw new AgentLaunchFault(EULA_REQUIRED);
    if (!await isReadable(path.join(this.root, "survival-agent/build/libs/survival-agent-1.0.jar")))
      throw new AgentLaunchFault(attempt.strategy === "terra" ? TERRA_ACTOR_REBUILD :
        "Build GameHarness with bun run build to install the Minecraft Survival Agent mod, then try again.");
    const version = path.join(homedir(), ".minecraft/versions/1.21.4/1.21.4");
    if (!await isReadable(`${version}.jar`) || !await isReadable(`${version}.json`))
      throw new AgentLaunchFault(LAUNCHER_REQUIRED);
    const java21 = "/usr/lib/jvm/java-21-openjdk-amd64/bin/java";
    const java = process.env.JAVA_HOME ? path.resolve(process.env.JAVA_HOME, "bin/java") :
      (await isReadable(java21) ? java21 : Bun.which("java", { PATH: SYSTEM_PATH }) ?? "java");
    const installed = await inspect(java, ["-version"], { timeout: 5000, signal: attempt.stop.signal, maxBuffer: 8192 })
      .then(({ stdout, stderr }) => /\bversion "21(?:[."])/.test(`${stdout}\n${stderr}`), () => false);
    if (!installed) throw new AgentLaunchFault("Install Java 21 or set JAVA_HOME to its installation, then restart GameHarness.");
    attempt.stop.signal.throwIfAborted();
    attempt.view.status = "Preparing the vanilla Minecraft server.";
    await prepareAgentServerArtifact(this.root, attempt.stop.signal).catch(() => {
      throw new AgentLaunchFault("Could not prepare the verified Minecraft server file. Check download access and disk space.");
    });
    return { wrapper: tools["xvfb-run"], xvfb: await realpath(tools.Xvfb), ffmpeg: tools.ffmpeg };
  }

  private async execute(attempt: Attempt) {
    let temporary: string | undefined;
    let status: string;
    try {
      const tools = await this.prerequisites(attempt);
      attempt.stop.signal.throwIfAborted();
      temporary = await mkdtemp("/tmp/gameharness-survival-agent-");
      const authority = path.join(temporary, "Xauthority");
      await (await open(authority, "wx", 0o600)).close();
      attempt.stop.signal.throwIfAborted();
      attempt.view.status = attempt.strategy === "terra" ? "Checking Terra authorization before Minecraft starts." :
        "Starting Minecraft in a fresh Normal Survival world.";
      status = await this.run(attempt, tools, authority);
    } catch (error) {
      status = attempt.stop.signal.aborted ? "Agent stopped before Minecraft started." :
        error instanceof AgentLaunchFault ? error.message : "Minecraft Survival Agent could not start. Check the local setup and try again.";
    } finally {
      attempt.display = null;
      await attempt.video.close();
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
    this.last = { ...this.snapshot(), phase: "ended", status };
    this.active = null;
  }

  private async run(attempt: Attempt, tools: { wrapper: string; xvfb: string; ffmpeg: string }, authority: string) {
    const command = [process.execPath, path.join(this.root, "survival-agent/run.ts")];
    if (attempt.strategy === "terra") command.push("--strategy", "terra");
    command.push(attempt.goal, String(LIMIT_SECONDS[attempt.goal]));
    const env: NodeJS.ProcessEnv = { PATH: SYSTEM_PATH, GAMEHARNESS_DATA_DIR: this.dataDir };
    for (const key of ["HOME", "LANG", "JAVA_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    if (attempt.strategy === "terra") {
      for (const key of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"])
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    // Fedora's xvfb-run exports XAUTHORITY to clients but does not pass -auth
    // to the server. Supply the same private file explicitly on both sides.
    const child = spawn(tools.wrapper, ["-a", "-f", authority, "-s", `-screen 0 1280x720x24 -nolisten tcp -auth ${authority}`, ...command], {
      cwd: this.root, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const launched = performance.now();
    const wrapper = child.pid;
    const basename = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-${attempt.goal}-[A-Za-z0-9]{6}$`);
    let exit: { code: number | null } | undefined;
    let startupStatus: string | undefined;
    const consume = (line: string) => {
      if (!attempt.view.run && path.dirname(line) === this.runs && basename.test(path.basename(line)))
        attempt.view.run = path.basename(line);
      startupStatus ??= startupFailure(line);
    };
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (text: string) => {
        pending += text;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (pending.length > 64 * 1024) pending = "";
      });
    }
    child.on("error", () => { startupStatus ??= "Could not launch the local Xvfb display."; });
    child.once("close", (code) => { exit = { code }; });
    let supervisor: ReturnType<typeof readProcess>, termSent = false, wrapperCancelled = false;
    let xvfb: ReturnType<typeof readProcess>;
    while (!exit) {
      if (wrapper !== undefined && child.exitCode === null && child.signalCode === null) {
        if (!supervisor || !attempt.display) {
          for (const pid of children(wrapper)) {
            const proc = readProcess(pid);
            if (!proc || proc.parent !== wrapper || proc.group !== wrapper) continue;
            const args = argv(pid);
            if (args.length === command.length && command.every((arg, index) => args[index] === arg)) supervisor = proc;
            else if (!attempt.display) {
              const verified = await this.verifyDisplay(proc, args, tools, authority);
              if (verified) {
                xvfb = proc;
                attempt.display = verified;
              }
            }
          }
        }
        // Keep xvfb-run and its display alive until the supervisor joins its
        // detached Java and recorder children. Signal the supervisor itself.
        if (supervisor && attempt.stop.signal.aborted && !termSent &&
            readProcess(supervisor.pid)?.started === supervisor.started) termSent = cleanSignal(supervisor.pid, "SIGTERM");
        if (!supervisor && !attempt.view.run && !wrapperCancelled && performance.now() - launched >= 15_000) {
          startupStatus ??= "The isolated Minecraft display did not start in time. Check Xvfb and xauth.";
          wrapperCancelled = cleanSignal(-wrapper, "SIGTERM"); // No supervisor reported an owned run.
        }
      }
      if (attempt.view.run) agentVitals(attempt.view, await readJson(path.join(this.runs, attempt.view.run, "progress.json")));
      await delay(200);
    }
    attempt.display = null;
    await attempt.video.close();
    // xvfb-run sends TERM but does not wait for Xvfb. Await this exact display;
    // never signal a PID that no longer has the observed process identity.
    if (xvfb) {
      const isDisplay = () => readProcess(xvfb.pid)?.started === xvfb.started;
      for (let i = 0; i < 30 && isDisplay(); i++) await delay(50);
      if (isDisplay()) {
        cleanSignal(xvfb.pid, "SIGKILL");
        while (isDisplay()) await delay(50);
      }
    }
    if (attempt.view.run) {
      const run = path.join(this.runs, attempt.view.run);
      agentVitals(attempt.view, await readJson(path.join(run, "progress.json")));
      const outcome = await readJson(path.join(run, "outcome.json"));
      if (outcome?.schemaVersion === 1 && outcome.goal === attempt.goal && typeof outcome.status === "string") {
        const strategyOutcome = attempt.view.strategyOutcome = attempt.strategy === "terra" ? terraOutcome(outcome) : null;
        attempt.view.won = exit.code === 0 && outcome.status === "won" &&
          (outcome.verification as { verified?: unknown } | null)?.verified === true &&
          (attempt.strategy === "deterministic" || strategyOutcome === "native_effect_completed");
        if (outcome.finalStage === "macro_startup" && strategyOutcome === "provider_unavailable")
          return `Could not start Terra. Check OpenAI connection in Settings and make sure your account offers ${TERRA_MODEL_ID}.`;
        if (attempt.strategy === "terra" && strategyOutcome !== "native_effect_completed" &&
            (outcome.benchmark as { confirmed?: unknown } | null)?.confirmed === true)
          return "The vanilla goal was verified, but no Terra action was confirmed.";
        return outcome.status === "won" && !attempt.view.won ? "The agent’s goal could not be verified." : outcomeStatus(outcome);
      }
    }
    return startupStatus ?? (attempt.stop.signal.aborted ? "Agent stopped." :
      "Minecraft did not report a closed agent outcome. Check Xvfb and the local Minecraft installation.");
  }

  private async verifyDisplay(proc: NonNullable<ReturnType<typeof readProcess>>, args: string[],
    tools: { xvfb: string; ffmpeg: string }, authority: string): Promise<AgentDisplay | null> {
    const display = args[1];
    const number = display?.match(/^:([1-9]\d*)$/)?.[1];
    if (!number || !Number.isSafeInteger(Number(number)) || Number(number) < 90 ||
        !args.some((arg, index) => arg === "-auth" && args[index + 1] === authority) ||
        !args.some((arg, index) => arg === "-nolisten" && args[index + 1] === "tcp") ||
        args.some((arg, index) => arg === "-listen" && args[index + 1] === "tcp")) return null;
    try {
      if (readlinkSync(`/proc/${proc.pid}/exe`) !== tools.xvfb ||
          readFileSync(`/tmp/.X${number}-lock`, "utf8").trim() !== String(proc.pid) ||
          await realpath(authority) !== authority) return null;
      const auth = await stat(authority);
      if (!auth.isFile() || auth.uid !== process.getuid?.() || (auth.mode & 0o077) !== 0) return null;
      return { display: display!, authority, ffmpeg: tools.ffmpeg, live: () => readProcess(proc.pid)?.started === proc.started };
    } catch { return null; }
  }
}
