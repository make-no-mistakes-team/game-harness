import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIR,
  OWNER_ID,
  MINECRAFT_VERSION,
  MINECRAFT_PORT,
  MINECRAFT_SERVER_URL,
  MINECRAFT_SERVER_SHA1,
  JAVA_IMAGE,
} from "./config";
import type { GameServerState, Json } from "../shared/contracts";

const EULA_URL = "https://www.minecraft.net/en-us/eula";
const OWNER_LABEL = "io.gameharness.owner";
const SERVICE_LABEL = "io.gameharness.service";
const CONTAINER_NAME = `gameharness-minecraft-${OWNER_ID}`;
const ROOT = path.join(DATA_DIR, "minecraft");
const JAR = path.join(ROOT, `server-${MINECRAFT_VERSION}.jar`);
const CONSENT = path.join(DATA_DIR, "provisioning-consent.json");
const WORLD_RECORD = path.join(ROOT, "current-world.json");
const CANCELLED = "Minecraft operation was cancelled.";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ContainerInfo {
  id: string;
  running: boolean;
}
interface DockerResult {
  code: number;
  stdout: string;
}
interface ServerProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  log: WriteStream;
  ready: boolean;
  expectedStop: boolean;
  rejectReady: (error: Error) => void;
}

/** Trusted host-only supervisor. Console access must never cross the UI/model boundary. */
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
  private tail: Promise<unknown> = Promise.resolve();
  private initialization: Promise<void> | null = null;
  private generation = 0;
  private active: AbortController | null = null;
  private process: ServerProcess | null = null;
  private prepared = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly onEvent: (
      type: string,
      summary: string,
      details?: Json,
    ) => void,
  ) {}

  snapshot(): GameServerState {
    return { ...this.state };
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.enqueue(async () => {
        try {
          await mkdir(ROOT, { recursive: true, mode: 0o700 });
          await chmod(ROOT, 0o700);
          // Only inspect this owner's deterministic name; never touch other containers.
          await this.removeOwnedContainer();
          await this.loadWorld();
          this.state.eula_accepted = await this.hasConsent();
          if (this.state.eula_accepted) await chmod(CONSENT, 0o600);
          this.prepared =
            (await this.validJar()) && (await this.imagePresent());
          this.idle();
        } catch {
          this.fail(
            "Minecraft initialization failed. Check Docker availability and local runtime permissions.",
          );
          throw new Error(this.state.error!);
        }
      });
    }
    return this.initialization;
  }

  async prepare(acceptEula = false): Promise<void> {
    const ticket = this.generation;
    await this.initialize();
    return this.enqueue(async () => {
      this.assertCurrent(ticket);
      const controller = this.begin();
      try {
        await this.prepareInternal(acceptEula, ticket, controller.signal);
      } catch (error) {
        this.operationError(
          error,
          "Minecraft preparation failed. Check network, Docker, and local runtime permissions.",
        );
      } finally {
        this.end(controller);
      }
    });
  }

  async start(): Promise<void> {
    const ticket = this.generation;
    await this.initialize();
    return this.enqueue(async () => {
      this.assertCurrent(ticket);
      if (this.state.status === "running" && this.process?.ready) return;
      const controller = this.begin();
      try {
        this.state.eula_accepted = await this.hasConsent();
        if (
          !this.prepared ||
          !this.state.eula_accepted ||
          !(await this.validJar(controller.signal)) ||
          !(await this.imagePresent(controller.signal))
        ) {
          await this.prepareInternal(false, ticket, controller.signal);
        }
        this.assertCurrent(ticket);
        if (!this.state.eula_accepted)
          throw new Error("Minecraft EULA acceptance is required.");
        await this.writeWorldConfiguration();
        this.assertCurrent(ticket);
        await this.removeOwnedContainer();
        this.assertCurrent(ticket);
        this.update({ status: "starting", error: null });
        this.onEvent(
          "game.server.starting",
          "Starting the local Minecraft Survival server.",
        );
        await this.launch(ticket, controller.signal);
        this.assertCurrent(ticket);
        if (!this.process?.ready)
          throw new Error("Minecraft stopped during startup.");
        this.update({ status: "running", error: null });
        this.onEvent(
          "game.server.ready",
          "Minecraft is ready for a local player connection.",
        );
      } catch (error) {
        let cleaned = true;
        try {
          await this.stopInternal();
        } catch {
          cleaned = false;
        }
        if (!cleaned) {
          this.fail(
            "Minecraft cleanup could not be confirmed. Check Docker before starting again.",
          );
          throw new Error(this.state.error!);
        }
        this.operationError(
          error,
          "Minecraft could not start. Check the configured local port and private server logs.",
        );
      } finally {
        this.end(controller);
      }
    });
  }

  async stop(): Promise<void> {
    this.invalidate();
    await this.initialize();
    return this.enqueue(async () => {
      try {
        await this.stopInternal();
        this.idle();
        this.onEvent(
          "game.server.stopped",
          "The local Minecraft server has stopped.",
        );
      } catch {
        this.fail(
          "Minecraft shutdown could not be confirmed. Check Docker before starting again.",
        );
        throw new Error(this.state.error!);
      }
    });
  }

  async newWorld(): Promise<void> {
    if (this.closing) throw new Error("Minecraft supervisor is closed.");
    this.invalidate();
    const ticket = this.generation;
    await this.initialize();
    return this.enqueue(async () => {
      this.assertCurrent(ticket);
      try {
        await this.stopInternal();
        this.assertCurrent(ticket);
        const id = randomUUID();
        await mkdir(this.worldDirectory(id), { recursive: true, mode: 0o700 });
        this.assertCurrent(ticket);
        await this.atomicJson(WORLD_RECORD, { world_id: id });
        this.state.world_id = id;
        this.idle();
        this.onEvent(
          "game.world.created",
          "A new ordinary Survival world was selected. Previous worlds are preserved.",
        );
      } catch (error) {
        this.operationError(
          error,
          "A new Minecraft world could not be selected. Previous worlds were preserved.",
        );
      }
    });
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.invalidate();
      this.closePromise = (async () => {
        // If initialization was never requested, there is no process this instance started.
        if (this.initialization) await this.initialization.catch(() => {});
        await this.enqueue(async () => {
          try {
            await this.stopInternal();
            this.idle();
          } catch {
            this.fail(
              "Minecraft shutdown could not be confirmed. Check Docker.",
            );
            throw new Error(this.state.error!);
          }
        });
      })();
    }
    return this.closePromise;
  }

  /** Privileged fixture/host use only. Not an agent or HTTP capability. */
  async sendConsole(command: string): Promise<void> {
    if (
      typeof command !== "string" ||
      !command ||
      command.length > 4096 ||
      /[\r\n\0]/.test(command)
    ) {
      throw new Error("Invalid trusted Minecraft console command.");
    }
    const current = this.process;
    if (
      this.closing ||
      this.state.status !== "running" ||
      !current?.ready ||
      current.expectedStop
    ) {
      throw new Error("Minecraft is not ready for a trusted console command.");
    }
    await this.writeConsole(current, command);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  private update(patch: Partial<GameServerState>): void {
    Object.assign(this.state, patch);
    this.onChange();
  }

  private idle(): void {
    this.update({
      status: !this.state.eula_accepted
        ? "eula_required"
        : this.prepared
          ? "stopped"
          : "not_installed",
      error: null,
    });
  }

  private fail(message: string): void {
    this.update({ status: "error", error: message });
    this.onEvent("game.server.error", message);
  }

  private operationError(error: unknown, fallback: string): never {
    if (error instanceof Error && error.message === CANCELLED) {
      if (!this.process) this.idle();
      throw new Error(CANCELLED);
    }
    const message =
      error instanceof Error &&
      error.message === "Minecraft EULA acceptance is required."
        ? error.message
        : fallback;
    if (message === "Minecraft EULA acceptance is required.") {
      this.update({
        status: "eula_required",
        error: message,
        eula_accepted: false,
      });
    } else this.fail(message);
    throw new Error(message);
  }

  private assertCurrent(ticket: number): void {
    if (this.closing || ticket !== this.generation) throw new Error(CANCELLED);
  }

  private invalidate(): void {
    this.generation++;
    this.active?.abort();
  }

  private begin(): AbortController {
    const controller = new AbortController();
    this.active = controller;
    return controller;
  }

  private end(controller: AbortController): void {
    if (this.active === controller) this.active = null;
  }

  private worldDirectory(id = this.state.world_id): string {
    if (!id || !UUID.test(id)) throw new Error("Invalid world record.");
    return path.join(ROOT, "worlds", id);
  }

  private async atomicJson(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private async loadWorld(): Promise<void> {
    let id: string;
    try {
      const value: unknown = JSON.parse(await readFile(WORLD_RECORD, "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        !("world_id" in value) ||
        typeof value.world_id !== "string" ||
        !UUID.test(value.world_id)
      )
        throw new Error("Invalid world record.");
      id = value.world_id;
    } catch (error) {
      if (!this.isMissing(error)) throw error;
      id = randomUUID();
      await mkdir(this.worldDirectory(id), { recursive: true, mode: 0o700 });
      await this.atomicJson(WORLD_RECORD, { world_id: id });
    }
    await mkdir(this.worldDirectory(id), { recursive: true, mode: 0o700 });
    await chmod(path.join(ROOT, "worlds"), 0o700);
    await chmod(this.worldDirectory(id), 0o700);
    this.state.world_id = id;
  }

  private isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }

  private async hasConsent(): Promise<boolean> {
    try {
      const value: unknown = JSON.parse(await readFile(CONSENT, "utf8"));
      if (!value || typeof value !== "object") return false;
      const record = value as Record<string, unknown>;
      return (
        record.eulaAccepted === true &&
        record.minecraftVersion === MINECRAFT_VERSION &&
        record.eulaUrl === EULA_URL &&
        typeof record.acceptedAt === "string" &&
        Number.isFinite(Date.parse(record.acceptedAt))
      );
    } catch (error) {
      if (this.isMissing(error) || error instanceof SyntaxError) return false;
      throw error;
    }
  }

  private async validJar(signal?: AbortSignal): Promise<boolean> {
    try {
      const hash = createHash("sha1");
      for await (const bytes of createReadStream(JAR, { signal }))
        hash.update(bytes);
      const valid = hash.digest("hex") === MINECRAFT_SERVER_SHA1;
      if (valid) await chmod(JAR, 0o600);
      return valid;
    } catch (error) {
      if (signal?.aborted) throw new Error(CANCELLED);
      if (this.isMissing(error)) return false;
      throw error;
    }
  }

  private async imagePresent(signal?: AbortSignal): Promise<boolean> {
    const result = await this.docker(
      ["image", "inspect", "--format", "{{.Id}}", JAVA_IMAGE],
      20_000,
      signal,
    );
    if (result.code === 0)
      return /^sha256:[0-9a-f]{64}$/.test(result.stdout.trim());
    const daemon = await this.docker(
      ["info", "--format", "{{.ServerVersion}}"],
      20_000,
      signal,
    );
    if (daemon.code !== 0) throw new Error("Docker is unavailable.");
    return false;
  }

  private async prepareInternal(
    accept: boolean,
    ticket: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertCurrent(ticket);
    if (accept === true) {
      await this.atomicJson(CONSENT, {
        eulaAccepted: true,
        minecraftVersion: MINECRAFT_VERSION,
        eulaUrl: EULA_URL,
        acceptedAt: new Date().toISOString(),
        deployment: "localhost-only dedicated server",
      });
    }
    this.assertCurrent(ticket);
    this.state.eula_accepted = await this.hasConsent();
    if (!this.state.eula_accepted)
      throw new Error("Minecraft EULA acceptance is required.");
    if (this.process?.ready) {
      this.update({ eula_accepted: true });
      return;
    }
    this.prepared = false;
    this.update({ status: "preparing", error: null });
    this.onEvent(
      "game.server.preparing",
      "Preparing the official Minecraft server and pinned Java runtime.",
    );
    if (!(await this.validJar(signal))) await this.downloadJar(ticket, signal);
    this.assertCurrent(ticket);
    if (!(await this.imagePresent(signal))) {
      const result = await this.docker(["pull", JAVA_IMAGE], 300_000, signal);
      if (result.code !== 0 || !(await this.imagePresent(signal)))
        throw new Error("Java image could not be prepared.");
    }
    this.assertCurrent(ticket);
    this.prepared = true;
    await this.writeWorldConfiguration();
    this.assertCurrent(ticket);
    this.idle();
    this.onEvent(
      "game.server.prepared",
      "Minecraft server files and the pinned Java runtime are ready.",
    );
  }

  private async downloadJar(
    ticket: number,
    signal: AbortSignal,
  ): Promise<void> {
    const temporary = `${JAR}.${randomUUID()}.download`;
    const timeout = AbortSignal.timeout(180_000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(MINECRAFT_SERVER_URL, {
        signal: combined,
        redirect: "error",
      });
      if (!response.ok || !response.body)
        throw new Error("Official server download failed.");
      const file = await open(temporary, "wx", 0o600);
      const hash = createHash("sha1");
      let size = 0;
      try {
        for await (const bytes of response.body) {
          size += bytes.byteLength;
          if (size > 128 * 1024 * 1024)
            throw new Error("Official server download exceeded its limit.");
          hash.update(bytes);
          let offset = 0;
          while (offset < bytes.byteLength) {
            const written = await file.write(
              bytes,
              offset,
              bytes.byteLength - offset,
            );
            if (written.bytesWritten === 0)
              throw new Error("Server file write failed.");
            offset += written.bytesWritten;
          }
        }
        await file.sync();
      } finally {
        await file.close();
      }
      if (hash.digest("hex") !== MINECRAFT_SERVER_SHA1)
        throw new Error("Official server checksum did not match.");
      this.assertCurrent(ticket);
      await rename(temporary, JAR);
      await this.atomicJson(path.join(ROOT, "server-artifact.json"), {
        version: MINECRAFT_VERSION,
        javaMajorVersion: 21,
        url: MINECRAFT_SERVER_URL,
        sha1: MINECRAFT_SERVER_SHA1,
        size,
      });
    } catch (error) {
      if (signal.aborted) throw new Error(CANCELLED);
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private async writeWorldConfiguration(): Promise<void> {
    const directory = this.worldDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, "eula.txt"), `eula=true\n`, {
      mode: 0o600,
    });
    await writeFile(
      path.join(directory, "server.properties"),
      [
        "server-ip=",
        "server-port=25565",
        "online-mode=false",
        "enforce-secure-profile=false",
        "gamemode=survival",
        "force-gamemode=true",
        "difficulty=normal",
        "hardcore=false",
        "level-name=world",
        "level-type=minecraft\\:normal",
        "level-seed=",
        "generate-structures=true",
        "view-distance=6",
        "simulation-distance=6",
        "spawn-protection=0",
        "max-players=4",
        "enable-rcon=false",
        "enable-query=false",
        "enable-command-block=false",
        "broadcast-console-to-ops=false",
        "broadcast-rcon-to-ops=false",
        "white-list=false",
        "motd=GameHarness local Survival",
        "log-ips=false",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    // No bot or other player receives operator privileges in ordinary runs.
    await writeFile(path.join(directory, "ops.json"), "[]\n", { mode: 0o600 });
  }

  private async inspectOwnedContainer(): Promise<ContainerInfo | null> {
    const result = await this.docker(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `name=^/${CONTAINER_NAME}$`,
        "--format",
        "{{.ID}}",
      ],
      20_000,
    );
    if (result.code !== 0)
      throw new Error("Docker container discovery failed.");
    const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length === 0) return null;
    if (ids.length !== 1 || !/^[0-9a-f]{64}$/.test(ids[0]!))
      throw new Error("Ambiguous container ownership.");
    const inspected = await this.docker(
      ["container", "inspect", ids[0]!],
      20_000,
    );
    if (inspected.code !== 0)
      throw new Error("Docker ownership inspection failed.");
    const parsed: unknown = JSON.parse(inspected.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1)
      throw new Error("Invalid container inspection.");
    const value = parsed[0];
    if (
      value?.Name !== `/${CONTAINER_NAME}` ||
      value?.Config?.Labels?.[OWNER_LABEL] !== OWNER_ID ||
      value?.Config?.Labels?.[SERVICE_LABEL] !== "minecraft" ||
      value?.Id !== ids[0]
    ) {
      throw new Error("The server container name belongs to another owner.");
    }
    return { id: ids[0]!, running: value.State?.Running === true };
  }

  private async removeOwnedContainer(): Promise<void> {
    const container = await this.inspectOwnedContainer();
    if (!container) return;
    if (container.running) {
      const result = await this.docker(
        ["container", "stop", "--time", "30", container.id],
        45_000,
      );
      if (result.code !== 0)
        throw new Error("Owned server container could not stop.");
    }
    const removed = await this.docker(
      ["container", "rm", container.id],
      20_000,
    );
    if (removed.code !== 0)
      throw new Error("Owned server container could not be removed.");
  }

  private async launch(ticket: number, signal: AbortSignal): Promise<void> {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined || uid === 0)
      throw new Error("An unprivileged host user is required.");
    const logDirectory = path.join(ROOT, "logs");
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const log = createWriteStream(
      path.join(logDirectory, `${Date.now()}-${randomUUID()}.log`),
      { flags: "wx", mode: 0o600 },
    );
    const opened = Promise.withResolvers<void>();
    log.once("open", () => opened.resolve());
    log.once("error", opened.reject);
    await opened.promise;
    try {
      this.assertCurrent(ticket);
    } catch (error) {
      log.end();
      throw error;
    }
    const child = spawn(
      "docker",
      [
        "run",
        "--interactive",
        "--name",
        CONTAINER_NAME,
        "--label",
        `${OWNER_LABEL}=${OWNER_ID}`,
        "--label",
        `${SERVICE_LABEL}=minecraft`,
        "--user",
        `${uid}:${gid}`,
        "--init",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--memory",
        "2304m",
        "--memory-swap",
        "2304m",
        "--cpus",
        "2",
        "--pids-limit",
        "256",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
        "--log-driver",
        "none",
        "--publish",
        `127.0.0.1:${MINECRAFT_PORT}:25565/tcp`,
        "--mount",
        `type=bind,source=${this.worldDirectory()},target=/data`,
        "--mount",
        `type=bind,source=${JAR},target=/server.jar,readonly`,
        "--workdir",
        "/data",
        "--env",
        "HOME=/data",
        JAVA_IMAGE,
        "java",
        "-Xms512M",
        "-Xmx1536M",
        "-jar",
        "/server.jar",
        "nogui",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const closure = Promise.withResolvers<void>();
    const readiness = Promise.withResolvers<void>();
    const current: ServerProcess = {
      child,
      closed: closure.promise,
      log,
      ready: false,
      expectedStop: false,
      rejectReady: readiness.reject,
    };
    this.process = current;
    let pending = "";
    const parse = (chunk: Buffer): void => {
      pending += chunk.toString("utf8");
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (
          !current.ready &&
          /\bDone \([0-9.,]+s\)! For help, type "help"/.test(line)
        ) {
          if (signal.aborted || ticket !== this.generation || this.closing)
            continue;
          current.ready = true;
          readiness.resolve();
        }
      }
      if (pending.length > 16_384) pending = pending.slice(-16_384);
    };
    // Pipe implements backpressure; full raw output remains private, never an API event.
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.stdout.on("data", parse);
    child.stderr.on("data", parse);
    child.stdin.on("error", () => {});
    log.on("error", () => {
      current.rejectReady(new Error("Private Minecraft logging failed."));
      // An unattached daemon is not left running after loss of its log sink.
      if (!current.expectedStop) {
        current.expectedStop = true;
        this.invalidate();
        void this.enqueue(async () => {
          try {
            await this.stopInternal();
            this.fail("Private Minecraft logging failed.");
          } catch {
            this.fail(
              "Minecraft logging failed and shutdown could not be confirmed.",
            );
          }
        });
      }
    });
    child.once("error", () =>
      readiness.reject(new Error("Docker could not launch Minecraft.")),
    );
    child.once("close", () => {
      readiness.reject(new Error("Minecraft exited before it became ready."));
      log.end();
      if (this.process === current) {
        this.process = null;
        if (!current.expectedStop && current.ready) {
          this.fail(
            "Minecraft stopped unexpectedly. Check the private server logs.",
          );
        }
      }
      closure.resolve();
    });
    const abort = (): void => readiness.reject(new Error(CANCELLED));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => readiness.reject(new Error("Minecraft startup timed out.")),
      180_000,
    );
    if (signal.aborted) abort();
    try {
      await readiness.promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  private async writeConsole(
    current: ServerProcess,
    command: string,
  ): Promise<void> {
    if (current.child.stdin.destroyed || !current.child.stdin.writable)
      throw new Error("Minecraft console is unavailable.");
    const written = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => deadline.reject(new Error("Minecraft console write timed out.")),
      2_000,
    );
    current.child.stdin.write(`${command}\n`, (error) => {
      if (error) written.reject(new Error("Minecraft console write failed."));
      else written.resolve();
    });
    try {
      await Promise.race([written.promise, deadline.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForClose(
    current: ServerProcess,
    milliseconds: number,
  ): Promise<boolean> {
    const deadline = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => deadline.resolve(false), milliseconds);
    try {
      return await Promise.race([
        current.closed.then(() => true),
        deadline.promise,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async stopInternal(): Promise<void> {
    const current = this.process;
    if (current) {
      current.expectedStop = true;
      current.rejectReady(new Error(CANCELLED));
      await this.writeConsole(current, "stop").catch(() => {});
      if (!(await this.waitForClose(current, 35_000))) {
        // The CLI may still be creating the container. Terminate and await it before
        // final discovery, so a late docker run cannot create an orphan afterward.
        current.child.kill("SIGTERM");
        if (!(await this.waitForClose(current, 3_000))) {
          current.child.kill("SIGKILL");
          if (!(await this.waitForClose(current, 3_000)))
            throw new Error("Docker client did not close.");
        }
      }
    }
    await this.removeOwnedContainer();
    if (this.process === current) this.process = null;
  }

  private docker(
    args: string[],
    timeout: number,
    signal?: AbortSignal,
  ): Promise<DockerResult> {
    if (signal?.aborted) return Promise.reject(new Error(CANCELLED));
    const completion = Promise.withResolvers<DockerResult>();
    {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let bytes = 0;
      let failed: Error | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = (error: Error): void => {
        if (failed) return;
        failed = error;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      };
      const abort = (): void => terminate(new Error(CANCELLED));
      const timer = setTimeout(
        () => terminate(new Error("Docker operation timed out.")),
        timeout,
      );
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024)
          terminate(new Error("Docker output limit exceeded."));
        else stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024)
          terminate(new Error("Docker output limit exceeded."));
      });
      child.once("error", () => {
        failed = new Error("Docker is unavailable.");
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (failed) completion.reject(failed);
        else completion.resolve({ code: code ?? -1, stdout });
      });
      if (signal?.aborted) abort();
    }
    return completion.promise;
  }
}
