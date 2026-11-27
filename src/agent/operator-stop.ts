import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { SURVIVAL_AGENT_GOALS } from "../shared/goals.ts";

const RUN = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-(?:${SURVIVAL_AGENT_GOALS.join("|")})-[A-Za-z0-9]{6}$`);
const TOKEN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DESCRIPTORS = { primary: "live.json", parallel: "parallel-live.json" } as const;
const OWNER = "operator-stop-owner.json";
type OrdinarySlot = keyof typeof DESCRIPTORS;
type Display = { display: string; authority: string };
type Target = { run: string } | Display;
type Descriptor = Record<string, unknown> & { run: string };

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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function privateRecord(file: string) {
  const text = await privateText(file, 8_192);
  try { return text ? record(JSON.parse(text)) : null; }
  catch { return null; }
}

export async function readPrivateLiveDescriptor(file: string): Promise<Descriptor | null> {
  const live = await privateRecord(file);
  return live?.active === true && typeof live.run === "string" ? live as Descriptor : null;
}

export async function readLiveProcess(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const parent = Number(fields[1]);
    const started = fields[19]; // proc(5) field 22, excluding the PID and command.
    return fields[0] !== "Z" && fields[0] !== "X" && started && parent > 0 ? { started, parent } : null;
  } catch { return null; }
}

export async function readPrivateAuthority(file: string): Promise<string | null> {
  const auth = await lstat(file, { bigint: true }).catch(() => null);
  return auth?.isFile() && auth.uid === BigInt(process.getuid!()) && (auth.mode & 0o077n) === 0n && auth.size > 0n
    ? `${auth.dev}:${auth.ino}:${auth.ctimeNs}` : null;
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

export async function openOperatorStop(dir: string, { slot, display, authority }: Display & { slot: OrdinarySlot }) {
  const run = path.basename(dir);
  if (!RUN.test(run)) throw new Error("Invalid ordinary run identifier.");
  const [runner, authorityId] = await Promise.all([readLiveProcess(process.pid), readPrivateAuthority(authority)]);
  if (!runner || !authorityId) throw new Error("Could not identify the ordinary run owner and display.");
  const owner = await openPrivateRun(dir);
  const token = randomUUID();
  const marker = path.join(owner.path, OWNER);
  try {
    const handle = await open(marker, "wx", 0o600);
    try {
      // Keep the slot and display binding in the owner's inode, not just in
      // the replaceable live descriptor.
      try { await handle.writeFile(JSON.stringify({ run, slot, display, authority, authorityId, token, pid: process.pid, ...runner })); }
      finally { await handle.close(); }
    } catch (error) {
      await unlink(marker).catch(() => {});
      throw error;
    }
  } catch (error) {
    await owner.close();
    throw error;
  }
  const file = path.join(owner.path, `operator-stop-${token}`);
  return {
    scope: { token, directory: owner.id },
    requested: async () => (await privateText(file, run.length)) === run,
    close: async () => { try { await unlink(marker); } finally { await owner.close(); } },
  };
}

type LiveOrdinaryRun = Display & { run: string; wrapper: number; authorityId: string };

async function withOrdinaryRun<T>(root: string, slot: OrdinarySlot, live: Descriptor,
    use: (source: LiveOrdinaryRun, directory: string, token: string) => T | Promise<T>): Promise<T | null> {
  const { display, authority } = live;
  const scope = record(live.operatorStop);
  const token = scope?.token;
  if (!RUN.test(live.run) || typeof display !== "string" || !/^:[1-9]\d*$/.test(display) ||
      !Number.isSafeInteger(Number(display.slice(1))) || Number(display.slice(1)) < 90 ||
      typeof authority !== "string" || !path.isAbsolute(authority) || authority.includes("\0") ||
      typeof token !== "string" || !TOKEN.test(token) || typeof scope?.directory !== "string") return null;
  const run = await openPrivateRun(path.join(root, "runs", live.run)).catch(() => null);
  if (!run) return null;
  try {
    if (run.id !== scope.directory) return null;
    const [owner, unclosed, authorityId] = await Promise.all([
      privateRecord(path.join(run.path, OWNER)),
      lstat(path.join(run.path, "outcome.json")).then(() => false, (error) => error.code === "ENOENT"),
      readPrivateAuthority(authority),
    ]);
    if (!unclosed || owner?.run !== live.run || owner.slot !== slot || owner.display !== display ||
        owner.authority !== authority || !authorityId || owner.authorityId !== authorityId ||
        owner.token !== token || typeof owner.pid !== "number") return null;
    const runner = await readLiveProcess(owner.pid);
    if (!runner || runner.started !== owner.started || runner.parent !== owner.parent) return null;
    return await use({ run: live.run, display, authority, wrapper: runner.parent, authorityId }, run.path, token);
  } finally { await run.close(); }
}

export async function readOrdinaryLiveRun(root: string, slot: OrdinarySlot): Promise<LiveOrdinaryRun | null> {
  const live = await readPrivateLiveDescriptor(path.join(root, DESCRIPTORS[slot]));
  return live ? withOrdinaryRun(root, slot, live, source => source) : null;
}

/** Publish an ordinary run's private request; only its owner can acknowledge it. */
export async function requestOperatorStop(root: string, target: Target): Promise<string | null> {
  let slot: OrdinarySlot = "primary";
  let live: Descriptor | null;
  if ("run" in target) {
    if (!RUN.test(target.run)) return null;
    const [primary, parallel] = await Promise.all([
      readPrivateLiveDescriptor(path.join(root, DESCRIPTORS.primary)),
      readPrivateLiveDescriptor(path.join(root, DESCRIPTORS.parallel)),
    ]);
    if (primary?.run === target.run) {
      if (parallel?.run === target.run) return null;
      live = primary;
    } else if (parallel?.run === target.run) {
      slot = "parallel";
      live = parallel;
    } else return null;
  } else {
    // The desktop manager controls only its own primary display.
    live = await readPrivateLiveDescriptor(path.join(root, DESCRIPTORS.primary));
    if (!live || live.display !== target.display || live.authority !== target.authority) return null;
  }

  return withOrdinaryRun(root, slot, live, async ({ run }, directory, token) => {
    const file = path.join(directory, `operator-stop-${token}`);
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      try { await handle.writeFile(run); } finally { await handle.close(); }
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    return run;
  });
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
    console.error("Usage: bun src/agent/operator-stop.ts RUN_BASENAME");
    process.exitCode = 1;
  } else {
    const root = path.resolve(import.meta.dir, "../../local/survival-agent");
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
