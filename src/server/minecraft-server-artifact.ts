import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Trusted host provisioning input, never a model capability or a world directory. */
export interface FabricServerArtifactSource { directory: string }
const VERSION = "1.21.4";
const SIZE = 56880250;
const SHA1 = "4707d00eb834b446575d89a61a11b5d548d8c001";
const SOURCE = `https://piston-data.mojang.com/v1/objects/${SHA1}/server.jar`;
const RECEIPT = ".gameharness-fabric-installation.json";
const INVALID_ARTIFACT = "Pinned public server artifact is invalid or unsafe.";
const invalid = () => new Error(INVALID_ARTIFACT);

async function ownedDirectory(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== path.resolve(directory) ||
    (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw invalid();
}
// All callers first validate the containing private directory. Standard file modes such as
// 0664 are safe behind that owner-only traversal barrier; ownership and no-follow still apply.
async function openOwnedFile(file: string, maximum: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || (process.getuid && stat.uid !== process.getuid())) throw invalid();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function readOwnedJson(file: string): Promise<unknown> {
  const handle = await openOwnedFile(file, 4096);
  try {
    const buffer = Buffer.allocUnsafe(4097);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > 4096) throw invalid();
    return JSON.parse(buffer.subarray(0, total).toString("utf8"));
  } finally { await handle.close(); }
}
async function digest(file: string, algorithm: string, maximum: number, exactSize?: number) {
  const handle = await openOwnedFile(file, maximum);
  try {
    if (exactSize !== undefined && (await handle.stat()).size !== exactSize) throw invalid();
    const hash = createHash(algorithm), buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum) throw invalid();
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (exactSize !== undefined && total !== exactSize) throw invalid();
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/** Validate or provision the public vanilla dependency without touching an existing world or replacing an existing jar. */
export async function preparePilotServerArtifact(projectRoot: string, signal: AbortSignal): Promise<void> {
  const directory = path.join(projectRoot, "local/runtime/minecraft");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await ownedDirectory(directory);
  const file = path.join(directory, `server-${VERSION}.jar`);
  const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
  const check = async () => {
    if (await digest(file, "sha1", SIZE, SIZE) !== SHA1) throw invalid();
  };
  try { await check(); return; } catch (error) { if (!isMissing(error)) throw error; }
  const response = await fetch(SOURCE, {
    redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok || !response.body) throw invalid();
  const temporary = `${file}.${randomUUID()}.tmp`;
  const hash = createHash("sha1");
  let total = 0;
  try {
    const output = await open(temporary, "wx", 0o600);
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        total += chunk.length;
        if (total > SIZE) throw invalid();
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw invalid();
          offset += bytesWritten;
        }
      }
    } finally { await output.close(); }
    if (total !== SIZE || hash.digest("hex") !== SHA1) throw invalid();
    signal.throwIfAborted();
    try { await link(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await check();
    }
  } finally { await rm(temporary, { force: true }); }
}
async function installationIdentity(directory: string, loader: string) {
  await ownedDirectory(directory);
  if (await digest(path.join(directory, "server.jar"), "sha1", SIZE, SIZE) !== SHA1) throw invalid();
  return { version: VERSION, loader, server_sha1: SHA1,
    launcher_sha256: await digest(path.join(directory, "fabric-server-launch.jar"), "sha256", 4 * 1024 * 1024) };
}

/** A launcher can be written before Minecraft finishes downloading; only a successful installer gets a receipt. */
export async function hasCompletedFabricInstallation(directory: string, loader: string): Promise<boolean> {
  await ownedDirectory(directory);
  try {
    const receipt = await readOwnedJson(path.join(directory, RECEIPT));
    if (!receipt || typeof receipt !== "object" || !("version" in receipt) || !("loader" in receipt) ||
      !("server_sha1" in receipt) || !("launcher_sha256" in receipt)) return false;
    const actual = await installationIdentity(directory, loader);
    return receipt.version === actual.version && receipt.loader === actual.loader &&
      receipt.server_sha1 === actual.server_sha1 && receipt.launcher_sha256 === actual.launcher_sha256;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Error &&
      (error.message === INVALID_ARTIFACT || "code" in error && error.code === "ENOENT")) return false;
    throw error;
  }
}
export async function recordCompletedFabricInstallation(directory: string, loader: string, signal?: AbortSignal) {
  const identity = await installationIdentity(directory, loader);
  signal?.throwIfAborted();
  const temporary = path.join(directory, `${RECEIPT}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
    signal?.throwIfAborted();
    await rename(temporary, path.join(directory, RECEIPT));
  } finally { await rm(temporary, { force: true }); }
}

/** Copy only the existing project-owned public dependency, with bounded I/O and no cache writes. */
export async function stageFabricServerArtifact(projectRoot: string, directory: string,
  source: FabricServerArtifactSource, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const sourceDirectory = path.resolve(source.directory);
  if (sourceDirectory !== path.join(path.resolve(projectRoot), "local/runtime/minecraft") ||
    path.resolve(directory) === sourceDirectory || path.resolve(directory).startsWith(`${sourceDirectory}${path.sep}`) ||
    sourceDirectory.startsWith(`${path.resolve(directory)}${path.sep}`)) throw invalid();
  await ownedDirectory(sourceDirectory);
  await ownedDirectory(directory);
  const destination = path.join(directory, "server.jar");
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) throw invalid();
  } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const metadata = await readOwnedJson(path.join(sourceDirectory, "server-artifact.json"));
  if (!metadata || typeof metadata !== "object" || !("version" in metadata) || !("size" in metadata) ||
    !("sha1" in metadata) || !("url" in metadata) ||
    metadata.version !== VERSION || metadata.size !== SIZE || metadata.sha1 !== SHA1 ||
    metadata.url !== SOURCE) throw invalid();
  const input = await openOwnedFile(path.join(sourceDirectory, `server-${VERSION}.jar`), SIZE);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    if ((await input.stat()).size !== SIZE) throw invalid();
    const output = await open(temporary, "wx", 0o600);
    const hash = createHash("sha1"), buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > SIZE) throw invalid();
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, null);
          if (!result.bytesWritten) throw invalid();
          written += result.bytesWritten;
        }
      }
    } finally { await output.close(); }
    if (total !== SIZE || hash.digest("hex") !== SHA1) throw invalid();
    signal?.throwIfAborted();
    // A prior interrupted installer may already have the exact preseed. Never overwrite other files.
    try {
      await lstat(destination);
      if (await digest(destination, "sha1", SIZE, SIZE) !== SHA1) throw invalid();
      return;
    }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await link(temporary, destination);
  } finally { await input.close(); await rm(temporary, { force: true }); }
}
