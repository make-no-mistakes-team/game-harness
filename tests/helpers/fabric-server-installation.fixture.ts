import { mock } from "bun:test";
import { createHash } from "node:crypto";
import * as childProcess from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Only public dependency bytes are optional inputs to the separate, private positive proof.
// Permanent tests use generated invalid artifacts and never need Minecraft, Java, or network access.
const mode = process.argv[2]!;
const publicArtifact = process.argv[3];
const root = await mkdtemp(path.join(tmpdir(), "gameharness-fabric-consumer-"));
const project = path.join(root, "project"), directory = path.join(root, "owned-world");
const cache = path.join(project, "local/runtime/minecraft");
const receipt = path.join(directory, ".gameharness-fabric-installation.json");
const serverSha1 = "4707d00eb834b446575d89a61a11b5d548d8c001";
const serverSize = 56880250;
const metadata = { version: "1.21.4", size: serverSize, sha1: serverSha1,
  url: `https://piston-data.mojang.com/v1/objects/${serverSha1}/server.jar` };
const nativeBytes = Buffer.from("isolated native build dependency"), installerBytes = Buffer.from("controlled installer download");
let spawnCount = 0, childClosed = false, childAlive = false;
let argumentsAtSpawn: string[] = [], preseedBytes: number | null = null, deadlineMs: number | null = null;
const fetches: string[] = [];
try {
  await mkdir(path.join(directory, "mods"), { recursive: true, mode: 0o700 });
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "mods/fabric-api.jar"), "controlled existing API dependency");
  if (mode === "launcher-only") await writeFile(path.join(directory, "fabric-server-launch.jar"), "incomplete launcher");
  if (mode === "wrong-version") metadata.version = "1.21.3";
  await writeFile(path.join(cache, "server-artifact.json"), JSON.stringify(metadata));
  // Match the real public receipt independently of the invoking shell's umask.
  await chmod(path.join(cache, "server-artifact.json"), 0o664);
  const source = path.join(cache, "server-1.21.4.jar");
  if (publicArtifact) await copyFile(publicArtifact, source);
  else if (mode === "corrupt") {
    const handle = await open(source, "wx", 0o600);
    try { await handle.truncate(serverSize); } finally { await handle.close(); }
  } else await writeFile(source, "not a verified server");
  if (mode === "wrong-version") await rm(source); // Version rejection must precede opening the absent binary.
  if (mode === "source-directory-public") await chmod(cache, 0o750);
  if (mode === "destination-directory-public") await chmod(directory, 0o750);
  if (mode === "source-symlink") {
    await rm(source);
    const target = path.join(root, "external.jar");
    await writeFile(target, "not a public artifact");
    await symlink(target, source);
  }
  if (mode === "source-directory-symlink") {
    const moved = path.join(root, "external-cache");
    await rename(cache, moved);
    await symlink(moved, cache);
  }
  if (mode === "destination-symlink") {
    await symlink(path.join(root, "untouched-user-file"), path.join(directory, "server.jar"));
    await writeFile(path.join(root, "untouched-user-file"), "must not be overwritten");
  }
  const realSpawn = childProcess.spawn;
  mock.module("node:child_process", () => ({ ...childProcess, spawn: (...args: Parameters<typeof realSpawn>) => {
    spawnCount++;
    argumentsAtSpawn = [...(args[1] ?? [])];
    const child = realSpawn(...args);
    child.once("close", () => { childClosed = true; });
    return child;
  } }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetches.push(url);
    const base = "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar";
    if (url === `${base}.sha1`) return new Response(createHash("sha1").update(installerBytes).digest("hex"));
    if (url === base) return new Response(installerBytes);
    throw new Error("Unexpected dependency request in isolated fixture");
  }) as typeof fetch;
  const actualSetTimeout = globalThis.setTimeout;
  if (mode === "timeout") {
    globalThis.setTimeout = ((...[handler, ms, ...args]: Parameters<typeof setTimeout>) => {
      if (ms === 240000) { deadlineMs = ms; return actualSetTimeout(handler, 40, ...args); }
      return actualSetTimeout(handler, ms, ...args);
    }) as typeof setTimeout;
  }
  const java = path.join(root, "fake-java");
  await writeFile(java, `#!${process.execPath}
import { chmod, stat, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = process.env.HOME;
const mode = ${JSON.stringify(mode)};
let preseed = null;
try { preseed = (await stat(path.join(directory,"server.jar"))).size; } catch {}
await writeFile(path.join(directory,"spawn-observation.json"),JSON.stringify({preseed,pid:process.pid}));
if(mode === "caller-abort" || mode === "timeout") await new Promise(()=>setInterval(()=>{},1000));
if(mode === "nonzero" || mode === "launcher-only") { console.error("PRIVATE THIRD PARTY OUTPUT MUST NOT ESCAPE"); process.exit(23); }
await writeFile(path.join(directory,"fabric-server-launch.jar"),"completed fake Fabric launcher");
await chmod(path.join(directory,"fabric-server-launch.jar"),0o664);
`, { mode: 0o700 });
  process.env.GAMEHARNESS_DATA_DIR = path.join(root, "runtime");
  // The real consumer must load AFTER this subprocess's config and external-dependency mocks.
  const { prepareFabricServer } = await import("../../src/minecraft/client.ts");
  const controller = new AbortController();
  const withCache = ["wrong-version", "corrupt", "truncated", "source-symlink", "source-directory-symlink", "source-directory-public", "destination-directory-public", "outside-source", "destination-symlink", "positive", "positive-tamper", "positive-abort"].includes(mode);
  if (mode === "positive-abort") controller.abort();
  let error: string | null = null;
  const work = prepareFabricServer(project, directory, mode === "spawn-failure" ? path.join(root, "missing-java") : java,
    controller.signal, withCache ? { directory: mode === "outside-source" ? root : cache } : undefined);
  if (mode === "caller-abort") {
    for (let i = 0; i < 100; i++) {
      try { await lstat(path.join(directory, "spawn-observation.json")); break; } catch {}
      await Bun.sleep(10);
    }
    controller.abort();
  }
  try { await work; } catch (failure) { error = failure instanceof Error ? failure.message : "unknown"; }
  let observation: { preseed: number | null; pid: number } | null = null;
  try { observation = JSON.parse(await readFile(path.join(directory, "spawn-observation.json"), "utf8")); } catch {}
  preseedBytes = observation?.preseed ?? null;
  if (observation) {
    try { process.kill(observation.pid, 0); childAlive = true; } catch {}
  }
  const exists = async (file: string) => await lstat(file).then(() => true, () => false);
  const hasReceipt = await exists(receipt);
  const completionFetches = fetches.length;
  if (mode === "positive" && !error) {
    await prepareFabricServer(project, directory, java, controller.signal, { directory: cache });
    if (spawnCount !== 1 || fetches.length !== completionFetches) throw new Error("Completed installation was needlessly reinstalled");
  }
  if (mode === "positive-tamper" && !error) {
    await writeFile(path.join(directory, "fabric-server-launch.jar"), "changed after successful installation");
    await prepareFabricServer(project, directory, java, controller.signal, { directory: cache });
    if (Number(spawnCount) !== 2) throw new Error("A changed launcher incorrectly retained completion authority");
    await rm(path.join(directory, "server.jar"));
    await prepareFabricServer(project, directory, java, controller.signal, { directory: cache });
    if (Number(spawnCount) !== 3) throw new Error("A receipt without the public server incorrectly retained completion authority");
  }
  const files = await readdir(directory);
  const metadataMode = (await lstat(path.join(cache, "server-artifact.json"))).mode & 0o777;
  const sourceDirectoryMode = (await lstat(cache)).mode & 0o777;
  const destinationDirectoryMode = (await lstat(directory)).mode & 0o777;
  let launcherMode: number | null = null;
  try { launcherMode = (await lstat(path.join(directory, "fabric-server-launch.jar"))).mode & 0o777; } catch {}
  console.log(JSON.stringify({ error, spawnCount, childClosed, childAlive, argumentsAtSpawn, preseedBytes,
    metadataMode, sourceDirectoryMode, destinationDirectoryMode, launcherMode,
    hasReceipt, fetches: fetches.length, deadlineMs, stagedTemporaryFiles: files.filter(name => /^server\.jar\..*\.tmp$/.test(name)),
    userFile: mode === "destination-symlink" ? await readFile(path.join(root, "untouched-user-file"), "utf8") : null }));
} finally { await rm(root, { recursive: true, force: true }); }
