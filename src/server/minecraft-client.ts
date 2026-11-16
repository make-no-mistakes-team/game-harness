import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  copyFile,
  access,
  rename,
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
import {
  hasCompletedFabricInstallation,
  recordCompletedFabricInstallation,
  stageFabricServerArtifact,
  type FabricServerArtifactSource,
} from "./minecraft-server-artifact.ts";

export const JAVA = process.env.JAVA_HOME
  ? path.resolve(process.env.JAVA_HOME, "bin", "java")
  : (Bun.which("java") ?? "java");
export const LOADER = "0.16.10";
export const FABRIC_API = "0.119.4+1.21.4";
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
  const api = path.join(directory, "mods/fabric-api.jar");
  if (!(await exists(api))) {
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
  return artifact;
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
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const mod = await prepareNativeMod(
      this.projectRoot,
      this.directory,
      signal,
      prepared,
    );
    const version = JSON.parse(
      await readFile(
        path.join(this.source, "versions/1.21.4/1.21.4.json"),
        "utf8",
      ),
    );
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
    reader.once("error", () =>
      credentials.reject(
        new Error("Official Launcher keyring reader unavailable."),
      ),
    );
    reader.once("close", (code) => {
      clearTimeout(credentialTimer);
      signal.removeEventListener("abort", abortReader);
      code === 0 && credentialBytes <= 65536
        ? credentials.resolve(Buffer.concat(chunks))
        : credentials.reject(
            new Error(
              "The official Launcher credential is unavailable. Sign in and launch Minecraft 1.21.4 with the official Launcher.",
            ),
          );
    });
    const credentialBuffer = await credentials.promise;
    const account = z
      .object({
        tokens: z.array(z.string().min(1).max(16384)).min(1).max(8),
        profile: z.object({ id: z.string().min(1), name: z.string().min(1) }),
      })
      .parse(JSON.parse(credentialBuffer.toString("utf8")));
    credentialBuffer.fill(0);
    for (const bytes of chunks) bytes.fill(0);
    let accessToken: string | null = null;
    const profile = account.profile;
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
      if (actual.id === profile.id && actual.name === profile.name) {
        accessToken = candidate;
        break;
      }
    }
    if (!accessToken)
      throw new Error(
        "The official Launcher Minecraft session is expired or unavailable. Sign in and launch Minecraft 1.21.4 with the official Launcher.",
      );
    signal.throwIfAborted();
    const session: NativeSession = {
      secret: randomBytes(32).toString("hex"),
      session_id: randomUUID(),
      ...config,
      control_port: controlPort,
      video_port: videoPort,
      evaluation: this.evaluation,
    };
    await privateJson(this.sessionFile, session);
    const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/1.21.4/${LOADER}/profile/json`;
    const loader = (await (
      await fetch(profileUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      })
    ).json()) as { libraries: Array<{ name: string; url: string }> };
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
      const file = path.join(this.source, "libraries", artifact.path);
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
    for (const lib of loader.libraries) {
      const [group, name, version] = lib.name.split(":");
      const relative = `${group!.replaceAll(".", "/")}/${name}/${version}/${name}-${version}.jar`;
      const file = path.join(this.dataDir, "native-libraries", relative);
      if (!(await exists(file))) {
        const url = `${lib.url}${relative}`;
        const sum = await (
          await fetch(`${url}.sha1`, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          })
        ).text();
        await download(url, file, sum, "sha1", signal);
      }
      librariesByName.set(`${group}:${name}:`, file);
    }
    const libraries = [
      ...librariesByName.values(),
      path.join(this.source, "versions/1.21.4/1.21.4.jar"),
      mod,
    ];
    await writeFile(
      path.join(this.directory, "options.txt"),
      "version:4189\npauseOnLostFocus:false\nmaxFps:60\nenableVsync:false\nfullscreen:false\nrenderDistance:6\nsimulationDistance:6\nautoJump:false\nshowSubtitles:true\nchatVisibility:2\nonboardAccessibility:false\nskipMultiplayerWarning:true\ntutorialStep:none\n",
      { mode: 0o600 },
    );
    const args = [
      "--username",
      profile.name,
      "--uuid",
      profile.id,
      "--accessToken",
      accessToken,
      "--userType",
      "msa",
      "--version",
      "1.21.4",
      "--versionType",
      "release",
      "--gameDir",
      this.directory,
      "--assetsDir",
      path.join(this.source, "assets"),
      "--assetIndex",
      version.assetIndex.id,
      "--width",
      "1280",
      "--height",
      "720",
      "--quickPlayMultiplayer",
      `${config.host}:${config.port}`,
    ];
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
