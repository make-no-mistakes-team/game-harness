import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { SURVIVAL_AGENT_GOALS } from "../src/shared/survival-agent-ui.ts";

const RUN = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-(?:${SURVIVAL_AGENT_GOALS.join("|")})-[A-Za-z0-9]{6}$`);
const TOKEN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Display = { display: string; authority: string };
type Target = { run: string } | Display;

async function privateText(file: string, maxBytes: number): Promise<string | null> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() ||
          (info.mode & 0o077) || info.size > maxBytes) return null;
      const buffer = Buffer.allocUnsafe(info.size + 1);
      const { bytesRead } = await handle.read(buffer);
      return bytesRead === info.size ? buffer.toString("utf8", 0, bytesRead) : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

async function openPrivateRun(dir: string) {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isDirectory() || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n))
      throw new Error("The run directory is not private.");
    // Resolve every request relative to the opened inode, even if the
    // pathname under runs/ is displaced between validation and use.
    return { path: `/proc/self/fd/${handle.fd}`, id: `${info.dev}:${info.ino}`, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function openOperatorStop(dir: string) {
  const run = path.basename(dir);
  if (!RUN.test(run)) throw new Error("Invalid ordinary run identifier.");
  const owner = await openPrivateRun(dir);
  const token = randomUUID();
  const file = path.join(owner.path, `operator-stop-${token}`);
  return {
    scope: { token, directory: owner.id },
    requested: async () => (await privateText(file, run.length)) === run,
    close: owner.close,
  };
}

/** Publish an ordinary run's private request; only its owner can acknowledge it. */
export async function requestOperatorStop(root: string, target: Target): Promise<string | null> {
  if ("run" in target && !RUN.test(target.run)) return null;
  const data = await privateText(path.join(root, "live.json"), 8_192);
  if (!data) return null;
  let live;
  try { live = JSON.parse(data); } catch { return null; }
  if (live?.active !== true || typeof live.run !== "string" || !RUN.test(live.run)) return null;
  if ("run" in target ? live.run !== target.run :
      live.display !== target.display || live.authority !== target.authority) return null;
  const { token, directory } = live.operatorStop ?? {};
  if (typeof token !== "string" || !TOKEN.test(token) || typeof directory !== "string") return null;

  const run = await openPrivateRun(path.join(root, "runs", live.run)).catch(() => null);
  if (!run) return null;
  try {
    if (run.id !== directory) return null;
    const file = path.join(run.path, `operator-stop-${token}`);
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      try { await handle.writeFile(live.run); } finally { await handle.close(); }
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    return live.run;
  } finally { await run.close(); }
}

/** Null means there was no server to save, not a successful save. */
export function serverSaveEvidence(server: { exit?: { code: number | null; signal: string | null } } | undefined,
    drain: { dimensionsSaved: boolean; escalation: string | null } | null): boolean | null {
  return server ? server.exit?.code === 0 && server.exit.signal === null &&
    drain?.dimensionsSaved === true && drain.escalation === null : null;
}

if (import.meta.main) {
  const [run, ...extra] = process.argv.slice(2);
  if (!run || extra.length || !RUN.test(run)) {
    console.error("Usage: bun survival-agent/operator-stop.ts RUN_BASENAME");
    process.exitCode = 1;
  } else {
    const root = path.resolve(import.meta.dir, "../local/survival-agent");
    try {
      if (!await requestOperatorStop(root, { run }))
        throw new Error(`No matching active ordinary run: ${run}`);
      console.log(`Stop requested for ${run}; wait for the runner's closed outcome.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Could not publish the stop request.");
      process.exitCode = 1;
    }
  }
}
