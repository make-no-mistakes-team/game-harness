import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  copyFile,
  access,
  rename,
  stat,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import { z } from "zod";
import type {
  AdapterSchemaCatalog,
  MotorProfile,
  RuntimeAdapter,
} from "../shared/contracts.ts";
import {
  readNativeArtifactContract,
  type NativeArtifactContract,
} from "./native-artifact.ts";
import { assertNativeContractFresh } from "./native-contract.ts";
import {
  normalizeNativeEvaluation,
  type NativeEvaluationOptions,
} from "./native-evaluation.ts";
import { javaProxyArguments } from "./java-network.ts";
import { OfficialSessionUnavailableError } from "./native-launch-fault.ts";
import { requireModelActorWire, ModelActorCompatibilityError } from "./survival-agent-artifact.ts";
import {
  hasCompletedFabricInstallation,
  recordCompletedFabricInstallation,
  stageFabricServerArtifact,
  type FabricServerArtifactSource,
} from "./minecraft-server-artifact.ts";
import {
  FABRIC_CLIENT_LIBRARIES,
  FABRIC_CLIENT_LOADER,
  FABRIC_CLIENT_MAVEN,
  FABRIC_CLIENT_MINECRAFT,
} from "./fabric-client-profile.ts";

export const JAVA = process.env.JAVA_HOME
  ? path.resolve(process.env.JAVA_HOME, "bin", "java")
  : (Bun.which("java") ?? "java");
export const LOADER = FABRIC_CLIENT_LOADER;
export const FABRIC_API = "0.119.4+1.21.4";
const CLIENT_OPTIONS =
  "version:4189\npauseOnLostFocus:false\nmaxFps:60\nenableVsync:false\nfullscreen:false\nrenderDistance:6\nsimulationDistance:6\nautoJump:false\nshowSubtitles:true\nchatVisibility:2\nonboardAccessibility:false\nskipMultiplayerWarning:true\ntutorialStep:none\n";

export interface NativeOptions {
  dataDir?: string;
  evaluation?: NativeEvaluationOptions;
  java?: string;
  sourceMinecraft?: string;
  descriptor?: unknown;
  schemas?: AdapterSchemaCatalog;
  adapter?: RuntimeAdapter;
  onTiming?: (
    name: "observation_read_ms" | "action_round_trip_ms",
    elapsedMs: number,
  ) => void;
}
export interface NativeSession {
  secret: string;
  world_id: string;
  epoch: number;
  session_id: string;
  host: string;
  port: number;
  control_port: number;
  video_port: number;
  evaluation: NativeEvaluationOptions | null;
  motor_profile?: MotorProfile;
}
export interface NativeProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  username: string;
  session: NativeSession;
  diagnostics: string[];
}

async function exists(file: string) {
  return access(file).then(
    () => true,
    () => false,
  );
}
export async function privateJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temp, file);
  await chmod(file, 0o600);
}
async function download(
  url: string,
  file: string,
  expected?: string,
  algorithm = "sha1",
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000),
    redirect: "follow",
  });
  if (!response.ok)
    throw new Error("Pinned Minecraft dependency download failed.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 160 * 1024 * 1024)
    throw new Error("Minecraft artifact exceeded its bound.");
  if (
    expected &&
    createHash(algorithm).update(bytes).digest("hex") !== expected.trim()
  )
    throw new Error("Minecraft artifact checksum mismatch.");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
}
export async function prepareNativeMod(
  projectRoot: string,
  directory: string,
  signal?: AbortSignal,
  prepared?: NativeArtifactContract,
) {
  const artifact = path.join(
    projectRoot,
    "native/minecraft/build/libs/gameharness-native-1.0.0.jar",
  );
  if (!(await exists(artifact)))
    throw new Error(
      "Build the pinned GameHarness Fabric mod before preparing Minecraft.",
    );
  const actual = prepared ?? (await readNativeArtifactContract(artifact));
  if (!prepared) await assertNativeContractFresh(projectRoot, actual.resource);
  await mkdir(path.join(directory, "mods"), { recursive: true, mode: 0o700 });
  await copyFile(artifact, path.join(directory, "mods/gameharness-native.jar"));
  const installedHash = createHash("sha256")
    .update(await readFile(path.join(directory, "mods/gameharness-native.jar")))
    .digest("hex");
  if (installedHash !== actual.artifact_sha256)
    throw new Error(
      "Installed native artifact bytes differ from the prepared contract artifact",
    );
  await prepareFabricApi(directory, signal);
  return artifact;
}
async function prepareFabricApi(directory: string, signal?: AbortSignal, cache?: string) {
  const api = path.join(directory, "mods/fabric-api.jar");
  if (!(await exists(api))) {
    if (cache && (await exists(cache))) {
      await copyFile(cache, api);
      return;
    }
    const url = `https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/${FABRIC_API}/fabric-api-${FABRIC_API}.jar`;
    const sum = await (
      await fetch(`${url}.sha1`, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      })
    ).text();
    await download(url, api, sum, "sha1", signal);
  }
}
export async function prepareFabricServer(
  projectRoot: string,
  directory: string,
  java = JAVA,
  signal?: AbortSignal,
  serverArtifact?: FabricServerArtifactSource,
) {
  signal?.throwIfAborted();
  const proxyArguments = javaProxyArguments(process.env);
  await prepareNativeMod(projectRoot, directory, signal);
  const launcher = path.join(directory, "fabric-server-launch.jar");
  if (!(await hasCompletedFabricInstallation(directory, LOADER))) {
    if (serverArtifact) await stageFabricServerArtifact(projectRoot, directory, serverArtifact, signal);
    const installer = path.join(directory, "fabric-installer-1.0.1.jar");
    const url =
      "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar";
    const sum = await (
      await fetch(`${url}.sha1`, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      })
    ).text();
    await download(url, installer, sum, "sha1", signal);
    signal?.throwIfAborted();
    const installation = Promise.withResolvers<void>();
    const child = spawn(
      java,
      [
        ...proxyArguments,
        "-jar",
        installer,
        "server",
        "-mcversion",
        "1.21.4",
        "-loader",
        LOADER,
        "-downloadMinecraft",
        "-dir",
        directory,
      ],
      {
        stdio: "ignore",
        cwd: directory,
        env: { PATH: "/usr/bin:/bin", HOME: directory, LANG: "C.UTF-8" },
      },
    );
    let reason: "caller_abort" | "timeout" | "spawn_failure" | null = null;
    const abort = () => { reason ??= "caller_abort"; child.kill("SIGKILL"); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { reason ??= "timeout"; child.kill("SIGKILL"); }, 240000);
    child.once("error", () => { reason = "spawn_failure"; });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      code === 0 && !signal?.aborted && reason === null
        ? installation.resolve()
        : installation.reject(
            new Error(`Fabric server installation failed (stage=installer; reason=${reason ?? (signal?.aborted ? "caller_abort" : "nonzero_exit")}; exit=${code}; signal=${exitSignal && /^SIG[A-Z0-9]+$/.test(exitSignal) ? exitSignal : "none"}).`),
          );
    });
    await installation.promise;
    signal?.throwIfAborted();
    await recordCompletedFabricInstallation(directory, LOADER, signal);
  }
  signal?.throwIfAborted();
  return launcher;
}

export async function prepareFabricClientClasspath(
  source: string,
  dataDir: string,
  signal: AbortSignal,
  cachedLibraries?: string,
) {
  const vanilla = path.join(source, "versions", FABRIC_CLIENT_MINECRAFT, FABRIC_CLIENT_MINECRAFT);
  const version = JSON.parse(await readFile(`${vanilla}.json`, "utf8"));
  signal.throwIfAborted();
  if (version.id !== FABRIC_CLIENT_MINECRAFT)
    throw new Error("Expected the official Minecraft 1.21.4 client profile.");
  const librariesByName = new Map<string, string>();
  for (const lib of version.libraries) {
    if (
      lib.rules &&
      !lib.rules.some(
        (r: { action: string; os?: { name?: string } }) =>
          r.action === "allow" && (!r.os || r.os.name === "linux"),
      )
    )
      continue;
    if (
      lib.rules?.some(
        (r: { action: string; os?: { name?: string } }) =>
          r.action === "disallow" && (!r.os || r.os.name === "linux"),
      )
    )
      continue;
    const artifact = lib.downloads?.artifact;
    if (!artifact) continue;
    const file = path.join(source, "libraries", artifact.path);
    if (!(await exists(file)))
      throw new Error(
        "The official installed Minecraft libraries are incomplete. Install Minecraft 1.21.4 using the official Launcher.",
      );
    const coordinate = String(lib.name).split(":");
    librariesByName.set(
      `${coordinate[0]}:${coordinate[1]}:${coordinate[3] ?? ""}`,
      file,
    );
  }
  for (const [group, name, revision, sha256] of FABRIC_CLIENT_LIBRARIES) {
    signal.throwIfAborted();
    const relative = `${group.replaceAll(".", "/")}/${name}/${revision}/${name}-${revision}.jar`;
    const installed = path.join(dataDir, "native-libraries", relative);
    let cached = cachedLibraries && path.join(cachedLibraries, relative);
    if (!cached || !(await exists(cached)))
      cached = (await exists(installed)) ? installed : undefined;
    if (cached) {
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(cached, { signal })) hash.update(bytes);
      if (hash.digest("hex") !== sha256)
        throw new Error(`Cached Fabric library checksum mismatch (${group}:${name}:${revision}).`);
    } else {
      await download(`${FABRIC_CLIENT_MAVEN}${relative}`, installed, sha256, "sha256", signal);
    }
    librariesByName.set(`${group}:${name}:`, cached ?? installed);
  }
  return {
    libraries: [...librariesByName.values(), `${vanilla}.jar`],
    assetIndex: String(version.assetIndex.id),
  };
}

/** Give Minecraft its own mutable skin cache without duplicating installed content-addressed assets. */
export async function prepareAgentAssets(source: string, directory: string, assetIndex: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(assetIndex)) throw new Error("Invalid installed Minecraft asset index.");
  const installed = path.resolve(source, "assets");
  const objects = path.join(installed, "objects");
  if (!(await stat(objects)).isDirectory()) throw new Error("Installed Minecraft asset objects are unavailable.");
  const assets = path.join(directory, "assets");
  const indexes = path.join(assets, "indexes");
  await mkdir(assets, { mode: 0o700 });
  await mkdir(indexes, { mode: 0o700 });
  await copyFile(path.join(installed, "indexes", `${assetIndex}.json`), path.join(indexes, `${assetIndex}.json`));
  // Vanilla's ResourceIndex only reads these objects. PlayerSkinProvider writes under assets/skins instead.
  await symlink(objects, path.join(assets, "objects"), "dir");
  return assets;
}

/** Trusted local launcher. Credentials exist only in memory and a private child stdin pipe. */
export class MinecraftClient {
  readonly dataDir: string;
  readonly directory: string;
  readonly sessionFile: string;
  private readonly source: string;
  private readonly java: string;
  private readonly evaluation: Readonly<NativeEvaluationOptions> | null;
  constructor(
    private readonly projectRoot: string,
    options: NativeOptions = {},
  ) {
    this.evaluation = normalizeNativeEvaluation(
      options.evaluation ?? null,
      process.env.GAMEHARNESS_NATIVE_PROOF === "1",
    );
    this.dataDir = options.dataDir ?? DATA_DIR;
    this.directory = path.join(this.dataDir, "native-client");
    this.sessionFile = path.join(this.dataDir, "native-session.json");
    this.source = options.sourceMinecraft ?? path.join(homedir(), ".minecraft");
    this.java = options.java ?? JAVA;
  }
  /** Explicit playing-caller preflight before billable Source authoring.
   * Returns no identity or credentials and grants no cached launch authority.
   * Pure source authoring need not call it. launch() always verifies again. */
  async assertOfficialSessionReady(signal: AbortSignal): Promise<void> {
    await this.verifyOfficialSession(signal);
  }

  private async verifyOfficialSession(signal: AbortSignal) {
    signal.throwIfAborted();
    const credentials = Promise.withResolvers<Buffer>();
    const reader = spawn(
      "/usr/bin/python3",
      [
        path.join(this.projectRoot, "native/minecraft/launcher-auth.py"),
        this.source,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", HOME: homedir() },
      },
    );
    const abortReader = () => reader.kill("SIGKILL");
    signal.addEventListener("abort", abortReader, { once: true });
    if (signal.aborted) abortReader();
    const chunks: Buffer[] = [];
    let credentialBytes = 0;
    reader.stdout.on("data", (bytes: Buffer) => {
      credentialBytes += bytes.length;
      if (credentialBytes > 65536) reader.kill("SIGKILL");
      else chunks.push(bytes);
    });
    reader.stderr.on("data", () => {});
    const credentialTimer = setTimeout(() => reader.kill("SIGKILL"), 10000);
    let readerFailed = false;
    reader.once("error", () => { readerFailed = true; });
    reader.once("close", (code) => {
      clearTimeout(credentialTimer);
      signal.removeEventListener("abort", abortReader);
      if (signal.aborted) credentials.reject(signal.reason);
      else if (!readerFailed && code === 0 && credentialBytes <= 65536)
        credentials.resolve(Buffer.concat(chunks));
      else credentials.reject(new OfficialSessionUnavailableError());
    });
    let credentialBuffer: Buffer | undefined;
    try {
      credentialBuffer = await credentials.promise;
      const account = z
        .object({
          tokens: z.array(z.string().min(1).max(16384)).min(1).max(8),
          profile: z.object({ id: z.string().min(1), name: z.string().min(1) }),
        })
        .parse(JSON.parse(credentialBuffer.toString("utf8")));
      credentialBuffer.fill(0);
      for (const bytes of chunks) bytes.fill(0);
      // Verify cached candidates against the official service; never substitute an offline profile.
      for (const candidate of account.tokens) {
        const auth = await fetch(
          "https://api.minecraftservices.com/minecraft/profile",
          {
            headers: { Authorization: `Bearer ${candidate}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          },
        );
        if (!auth.ok) continue;
        const actual = z
          .object({ id: z.string(), name: z.string() })
          .parse(await auth.json());
        if (actual.id === account.profile.id && actual.name === account.profile.name) {
          signal.throwIfAborted();
          return { accessToken: candidate, profile: account.profile };
        }
      }
      signal.throwIfAborted();
      throw new OfficialSessionUnavailableError();
    } finally {
      credentialBuffer?.fill(0);
      for (const bytes of chunks) bytes.fill(0);
    }
  }

  private gameArguments(
    profile: { name: string; id: string },
    accessToken: string,
    assetIndex: string,
    address: string,
    assetsDir = path.join(this.source, "assets"),
  ) {
    return [
      "--username", profile.name,
      "--uuid", profile.id,
      "--accessToken", accessToken,
      "--userType", "msa",
      "--version", "1.21.4",
      "--versionType", "release",
      "--gameDir", this.directory,
      "--assetsDir", assetsDir,
      "--assetIndex", assetIndex,
      "--width", "1280",
      "--height", "720",
      "--quickPlayMultiplayer", address,
    ];
  }

  /** Stage and hash the exact Minecraft Survival Agent JAR the fresh client will load. */
  async stageAgentArtifact(artifact: string, requireModelWorkWire = false) {
    const mods = path.join(this.directory, "mods");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(mods, { mode: 0o700 });
    const installed = path.join(mods, "survival-agent.jar");
    await copyFile(artifact, installed).catch((error: NodeJS.ErrnoException) => {
      if (requireModelWorkWire && (error.code === "ENOENT" || error.code === "EISDIR"))
        throw new ModelActorCompatibilityError();
      throw error;
    });
    if (requireModelWorkWire) {
      await chmod(installed, 0o400);
      return requireModelActorWire(installed);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(installed)) hash.update(chunk);
    return hash.digest("hex");
  }

  /** Launch the standalone agent without the native bridge or its session file. */
  async launchAgent(
    config: {
      runtimeCache: string;
      port: number;
      goal: string;
      evidenceDir: string;
      display: string;
      authority: string;
      stillOwned: () => boolean;
      onSetup?: (phase: "client_session_check" | "client_dependencies" | "client_startup") => void;
      beforeConnect?: (profileName: string) => Promise<void>;
    },
    signal: AbortSignal,
  ) {
    config.onSetup?.("client_session_check");
    const { accessToken, profile } = await this.verifyOfficialSession(signal);
    config.onSetup?.("client_dependencies");
    const tmp = path.join(this.directory, "tmp");
    await mkdir(tmp, { mode: 0o700 });
    await prepareFabricApi(this.directory, signal,
      path.join(config.runtimeCache, "native-client/mods/fabric-api.jar"));
    const { libraries, assetIndex } = await prepareFabricClientClasspath(
      this.source, this.dataDir, signal, path.join(config.runtimeCache, "native-libraries"),
    );
    const assetsDir = await prepareAgentAssets(this.source, this.directory, assetIndex);
    await writeFile(
      path.join(this.directory, "options.txt"),
      CLIENT_OPTIONS,
      { mode: 0o600 },
    );
    config.onSetup?.("client_startup");
    if (config.beforeConnect) {
      signal.throwIfAborted();
      await config.beforeConnect(profile.name);
    }
    signal.throwIfAborted();
    if (!config.stillOwned()) throw new Error("The run no longer owns its private Minecraft display.");
    const child = spawn(this.java, [
      ...javaProxyArguments(process.env),
      "-Xms512M",
      "-Xmx2048M",
      "-XX:-CreateCoredumpOnCrash",
      "-Djava.awt.headless=true",
      `-Duser.home=${this.directory}`,
      `-Djava.io.tmpdir=${tmp}`,
      `-Dgh.agent.dir=${config.evidenceDir}`,
      `-Dgh.agent.goal=${config.goal}`,
      // launchAgent's sole caller starts this exact loopback server with max-players=1.
      `-Dgh.agent.ownedSinglePlayerPort=${config.port}`,
      "-cp",
      libraries.join(path.delimiter),
      path.join(this.projectRoot,
        "native/minecraft/src/main/java/io/gameharness/nativeclient/Bootstrap.java"),
    ], {
      cwd: this.directory,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin", HOME: this.directory, TMPDIR: tmp, LANG: "C.UTF-8",
        ALSOFT_DRIVERS: "null",
        DISPLAY: config.display, XAUTHORITY: config.authority,
      },
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
    );
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    // Drain output without persisting third-party messages that could include launch arguments.
    const diagnostics = new Set<string>();
    const diagnose = (bytes: Buffer) => {
      for (const match of bytes.toString("utf8").matchAll(
        /(?:^|\n)(?:GameHarness launch category: ([A-Za-z0-9_.$]+)|GHFRAME ([A-Za-z0-9_.$]+:\d+))(?=\r?\n|$)/g,
      )) {
        const entry = match[1] ?? match[2]!;
        if (diagnostics.size < 24) diagnostics.add(entry);
      }
    };
    child.stdout.on("data", diagnose);
    child.stderr.on("data", diagnose);
    const args = this.gameArguments(profile, accessToken, assetIndex, `127.0.0.1:${config.port}`, assetsDir);
    child.stdin.end(JSON.stringify({ args }));
    return { child, closed, diagnostics };
  }

  async launch(
    config: {
      host: string;
      port: number;
      world_id: string;
      epoch: number;
      motor_profile?: MotorProfile;
    },
    controlPort: number,
    videoPort: number,
    signal: AbortSignal,
    prepared?: NativeArtifactContract,
  ): Promise<NativeProcess> {
    // A Source phase may outlive an earlier readiness pass. Never reuse its result.
    const { accessToken, profile } = await this.verifyOfficialSession(signal);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const mod = await prepareNativeMod(this.projectRoot, this.directory, signal, prepared);
    const session: NativeSession = {
      secret: randomBytes(32).toString("hex"),
      session_id: randomUUID(),
      ...config,
      control_port: controlPort,
      video_port: videoPort,
      evaluation: this.evaluation,
    };
    await privateJson(this.sessionFile, session);
    const { libraries, assetIndex } = await prepareFabricClientClasspath(
      this.source, this.dataDir, signal,
    );
    libraries.push(mod);
    await writeFile(path.join(this.directory, "options.txt"), CLIENT_OPTIONS, { mode: 0o600 });
    const args = this.gameArguments(profile, accessToken, assetIndex, `${config.host}:${config.port}`);
    signal.throwIfAborted();
    const silentAudio =
      process.env.GAMEHARNESS_NATIVE_AUDIO === "silent" ||
      (process.env.GAMEHARNESS_NATIVE_PROOF === "1" &&
        process.env.GAMEHARNESS_NATIVE_AUDIO !== "audible");
    const child = spawn(
      this.java,
      [
        "-Xms512M",
        "-Xmx2048M",
        "-Djava.awt.headless=true",
        "-cp",
        libraries.join(path.delimiter),
        "io.gameharness.nativeclient.Bootstrap",
      ],
      {
        cwd: this.directory,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: this.directory,
          LANG: "C.UTF-8",
          // Keep source playback and sensing active without a physical output device.
          ALSOFT_DRIVERS: silentAudio ? "null" : undefined,
          DISPLAY: process.env.DISPLAY ?? ":1",
          XAUTHORITY: process.env.XAUTHORITY ?? "/run/user/1000/gdm/Xauthority",
          XDG_RUNTIME_DIR:
            process.env.XDG_RUNTIME_DIR ??
            `/run/user/${process.getuid?.() ?? 1000}`,
        },
      },
    );
    const abortClient = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abortClient, { once: true });
    if (signal.aborted) abortClient();
    const closure = Promise.withResolvers<void>();
    child.once("close", () => {
      signal.removeEventListener("abort", abortClient);
      closure.resolve();
    });
    const closed = closure.promise;
    // Discard third-party lines; retain classes and private-value-redacted bootstrap causes only.
    const diagnostics: string[] = [];
    const diagnose = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const categories = [
        ...(text.match(
          /\b(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error)\b/g,
        ) ?? []),
        ...Array.from(
          text.matchAll(/GHFRAME ([A-Za-z0-9_.$]+:\d+)/g),
          (m) => m[1]!,
        ),
        ...Array.from(text.matchAll(/GHCAUSE ([^\r\n]{1,300})/g), (m) => m[1]!),
      ];
      for (const category of categories)
        if (!diagnostics.includes(category) && diagnostics.length < 20)
          diagnostics.push(category);
    };
    child.stdout.on("data", diagnose);
    child.stderr.on("data", diagnose);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ session_file: this.sessionFile, args }));
    return { child, closed, username: profile.name!, session, diagnostics };
  }
}
