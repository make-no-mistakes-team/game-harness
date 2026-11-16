import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIR,
  MINECRAFT_VERSION,
  MINECRAFT_PORT,
  PROJECT_ROOT,
} from "./config.ts";
import {
  JAVA,
  LOADER,
  prepareFabricServer,
  prepareNativeMod,
  privateJson,
} from "./minecraft-client.ts";
import { hasCompletedFabricInstallation, type FabricServerArtifactSource } from "./minecraft-server-artifact.ts";
import type { GameServerState, Json } from "../shared/contracts.ts";

const EULA_URL = "https://www.minecraft.net/en-us/eula";
interface OwnedServer {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  log: WriteStream;
  ready: boolean;
  expectedStop: boolean;
}
export interface MinecraftServerOptions {
  /** Trusted host configuration for a new ordinary world, never a model capability. */
  worldSeed?: string;
  /** Trusted host-selected existing public dependency cache; no world or player state. */
  serverArtifact?: FabricServerArtifactSource;
}
/** Host-only owner of one local Fabric process. No console or credentials cross the program API. */
export class MinecraftServer {
  private state: GameServerState = {
    status: "not_installed",
    version: MINECRAFT_VERSION,
    host: "127.0.0.1",
    port: MINECRAFT_PORT,
    world_id: null,
    eula_accepted: false,
    error: null,
  };
  private readonly root = path.join(DATA_DIR, "minecraft");
  private readonly consent = path.join(DATA_DIR, "provisioning-consent.json");
  private initialization: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private process: OwnedServer | null = null;
  private generation = 0;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private active: AbortController | null = null;
  private readonly worldSeed: string | undefined;
  private readonly serverArtifact: FabricServerArtifactSource | undefined;
  constructor(
    private readonly onChange: () => void,
    private readonly onEvent: (
      type: string,
      summary: string,
      details?: Json,
    ) => void,
    options: MinecraftServerOptions = {},
  ) {
    const seed = options.worldSeed;
    if (seed !== undefined && (!seed || seed.length > 128 || seed.trim() !== seed || /[\x00-\x1f\x7f\\=:]/.test(seed)))
      throw new Error("World seed must be one bounded property value without control characters or property escapes");
    this.worldSeed = seed;
    this.serverArtifact = options.serverArtifact && { ...options.serverArtifact };
  }
  snapshot(): GameServerState {
    return { ...this.state };
  }
  private update(patch: Partial<GameServerState>) {
    Object.assign(this.state, patch);
    this.onChange();
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }
  private directory() {
    if (!this.state.world_id || !/^[0-9a-f-]{36}$/.test(this.state.world_id))
      throw new Error("Invalid owned world identity.");
    return path.join(this.root, "worlds", this.state.world_id);
  }
  private async hasConsent() {
    try {
      const c = JSON.parse(await readFile(this.consent, "utf8"));
      return (
        c.eulaAccepted === true &&
        c.minecraftVersion === MINECRAFT_VERSION &&
        c.eulaUrl === EULA_URL
      );
    } catch {
      return false;
    }
  }
  initialize(): Promise<void> {
    if (!this.initialization)
      this.initialization = this.enqueue(async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await chmod(this.root, 0o700);
        let id: string;
        try {
          const record = JSON.parse(
            await readFile(path.join(this.root, "current-world.json"), "utf8"),
          );
          if (
            typeof record.world_id !== "string" ||
            !/^[0-9a-f-]{36}$/.test(record.world_id)
          )
            throw new Error("Invalid owned world record.");
          id = record.world_id;
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw error;
          id = randomUUID();
          await privateJson(path.join(this.root, "current-world.json"), {
            world_id: id,
          });
        }
        this.state.world_id = id;
        await mkdir(this.directory(), { recursive: true, mode: 0o700 });
        this.state.eula_accepted = await this.hasConsent();
        this.update({
          status: this.state.eula_accepted ? "stopped" : "eula_required",
          error: null,
        });
      });
    return this.initialization;
  }
  async prepare(acceptEula = false): Promise<void> {
    await this.initialize();
    const ticket = this.generation;
    return this.enqueue(async () => {
      if (this.closing || ticket !== this.generation)
        throw new Error("Minecraft operation was cancelled.");
      if (acceptEula)
        await privateJson(this.consent, {
          eulaAccepted: true,
          minecraftVersion: MINECRAFT_VERSION,
          eulaUrl: EULA_URL,
          acceptedAt: new Date().toISOString(),
          deployment: "localhost-only dedicated Fabric server",
        });
      this.state.eula_accepted = await this.hasConsent();
      if (!this.state.eula_accepted) {
        this.update({ status: "eula_required" });
        throw new Error("Minecraft EULA acceptance is required.");
      }
      this.update({ status: "preparing", error: null });
      const controller = new AbortController();
      this.active = controller;
      try {
        await prepareFabricServer(
          PROJECT_ROOT,
          this.directory(),
          JAVA,
          controller.signal,
          this.serverArtifact,
        );
        if (ticket !== this.generation)
          throw new Error("Minecraft operation was cancelled.");
        await this.configuration();
        this.update({ status: "stopped", error: null });
      } catch (error) {
        this.update({
          status: "error",
          error:
            "Pinned Fabric server preparation failed. Check network, Java21 and the native mod build.",
        });
        throw error;
      } finally {
        if (this.active === controller) this.active = null;
      }
    });
  }
  private async configuration() {
    if (this.worldSeed !== undefined) {
      const existingWorld = await access(path.join(this.directory(), "world")).then(
        () => true,
        (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; },
      );
      if (existingWorld) {
        const properties = await readFile(path.join(this.directory(), "server.properties"), "utf8");
        const previousSeeds = properties.split(/\r?\n/).filter(line => line.startsWith("level-seed=")).map(line => line.slice("level-seed=".length));
        if (previousSeeds.length !== 1 || previousSeeds[0] !== this.worldSeed)
          throw new Error("An existing world cannot be silently reseeded; create a new world for the declared seed");
      }
    }
    await writeFile(path.join(this.directory(), "eula.txt"), "eula=true\n", {
      mode: 0o600,
    });
    await writeFile(
      path.join(this.directory(), "server.properties"),
      [
        "server-ip=127.0.0.1",
        `server-port=${MINECRAFT_PORT}`,
        "online-mode=false",
        "enforce-secure-profile=false",
        "gamemode=survival",
        "force-gamemode=true",
        "difficulty=normal",
        "hardcore=false",
        "level-name=world",
        "level-type=minecraft\\:normal",
        ...(this.worldSeed === undefined ? [] : [`level-seed=${this.worldSeed}`]),
        "generate-structures=true",
        "view-distance=6",
        "simulation-distance=6",
        "spawn-protection=0",
        "max-players=1",
        "enable-rcon=false",
        "enable-query=false",
        "enable-command-block=false",
        "white-list=false",
        "broadcast-console-to-ops=false",
        "log-ips=false",
        "motd=GameHarness private Survival",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(path.join(this.directory(), "ops.json"), "[]\n", {
      mode: 0o600,
    });
  }
  async start(): Promise<void> {
    await this.initialize();
    if (this.process?.ready) return;
    if (
      !(await hasCompletedFabricInstallation(this.directory(), LOADER))
    )
      await this.prepare(false);
    const ticket = this.generation;
    return this.enqueue(async () => {
      if (this.closing || ticket !== this.generation)
        throw new Error("Minecraft operation was cancelled.");
      if (!(await this.hasConsent()))
        throw new Error("Minecraft EULA acceptance is required.");
      const controller = new AbortController();
      this.active = controller;
      await prepareNativeMod(PROJECT_ROOT, this.directory(), controller.signal);
      if (this.closing || ticket !== this.generation)
        throw new Error("Minecraft operation was cancelled.");
      await this.configuration();
      this.update({ status: "starting", error: null });
      const readiness = Promise.withResolvers<void>(),
        closure = Promise.withResolvers<void>();
      const log = createWriteStream(
        path.join(this.directory(), "gameharness-private.log"),
        { flags: "a", mode: 0o600 },
      );
      const child = spawn(
        JAVA,
        [
          "-Xms512M",
          "-Xmx1536M",
          "-XX:MaxDirectMemorySize=256M",
          "-XX:MaxMetaspaceSize=384M",
          "-XX:ReservedCodeCacheSize=128M",
          "-XX:ActiveProcessorCount=2",
          "-jar",
          path.join(this.directory(), "fabric-server-launch.jar"),
          "nogui",
        ],
        {
          cwd: this.directory(),
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: "/usr/bin:/bin",
            HOME: this.directory(),
            LANG: "C.UTF-8",
            GAMEHARNESS_SESSION_FILE: path.join(
              DATA_DIR,
              "native-session.json",
            ),
            GAMEHARNESS_PARENT_PID: String(process.pid),
          },
        },
      );
      const current: OwnedServer = {
        child,
        closed: closure.promise,
        log,
        ready: false,
        expectedStop: false,
      };
      this.process = current;
      let pending = "";
      let logBytes = 0;
      const parse = (chunk: Buffer) => {
        logBytes += chunk.length;
        if (logBytes < 16 * 1024 * 1024) log.write(chunk);
        pending += chunk.toString("utf8");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (/Done \([0-9.,]+s\)! For help/.test(line)) {
            current.ready = true;
            readiness.resolve();
          }
        }
        if (pending.length > 16384) pending = pending.slice(-16384);
      };
      child.stdout.on("data", parse);
      child.stderr.on("data", parse);
      child.stdin.on("error", () => {});
      child.once("error", () =>
        readiness.reject(new Error("Local Java21 server could not launch.")),
      );
      child.once("close", () => {
        log.end();
        closure.resolve();
        readiness.reject(new Error("Fabric server exited before readiness."));
        if (this.process === current) {
          this.process = null;
          if (!current.expectedStop)
            this.update({
              status: "error",
              error:
                "Owned Fabric server stopped unexpectedly. Check private logs.",
            });
        }
      });
      const timer = setTimeout(
        () => readiness.reject(new Error("Fabric server readiness timed out.")),
        180000,
      );
      const abort = () =>
        readiness.reject(new Error("Minecraft operation was cancelled."));
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      try {
        await readiness.promise;
        if (this.closing || ticket !== this.generation)
          throw new Error("Minecraft operation was cancelled.");
        this.update({ status: "running", error: null });
        this.onEvent(
          "game.server.ready",
          "Private Fabric Survival server is ready.",
        );
      } catch (error) {
        await this.stopInternal();
        this.update({
          status: "error",
          error: "Fabric server failed to start. Check its private local log.",
        });
        throw error;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        if (this.active === controller) this.active = null;
      }
    });
  }
  private async stopInternal() {
    const current = this.process;
    if (!current) return;
    current.expectedStop = true;
    current.child.stdin.write("stop\n");
    const timeout = Promise.withResolvers<void>();
    const timer = setTimeout(timeout.resolve, 15000);
    await Promise.race([current.closed, timeout.promise]);
    clearTimeout(timer);
    if (this.process === current && current.child.pid) {
      try {
        process.kill(-current.child.pid, "SIGTERM");
      } catch {}
      const grace = Promise.withResolvers<void>();
      const t = setTimeout(grace.resolve, 3000);
      await Promise.race([current.closed, grace.promise]);
      clearTimeout(t);
      if (this.process === current) {
        try {
          process.kill(-current.child.pid, "SIGKILL");
        } catch {}
      }
    }
    await current.closed;
    if (this.process === current) this.process = null;
  }
  async stop() {
    this.generation++;
    this.active?.abort();
    await this.initialize();
    return this.enqueue(async () => {
      await this.stopInternal();
      this.update({
        status: this.state.eula_accepted ? "stopped" : "eula_required",
        error: null,
      });
    });
  }
  async newWorld() {
    this.generation++;
    this.active?.abort();
    await this.initialize();
    return this.enqueue(async () => {
      if (this.closing) throw new Error("Minecraft supervisor is closed.");
      await this.stopInternal();
      const id = randomUUID();
      await privateJson(path.join(this.root, "current-world.json"), {
        world_id: id,
      });
      this.state.world_id = id;
      await mkdir(this.directory(), { recursive: true, mode: 0o700 });
      this.update({
        status: this.state.eula_accepted ? "not_installed" : "eula_required",
        error: null,
      });
      this.onEvent(
        "game.world.created",
        "Selected a new ordinary Survival world. Previous worlds are preserved.",
      );
    });
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.generation++;
      this.active?.abort();
      this.closePromise = this.enqueue(async () => {
        await this.stopInternal();
        this.update({
          status: this.state.eula_accepted ? "stopped" : "eula_required",
          error: null,
        });
      });
    }
    return this.closePromise;
  }
}
