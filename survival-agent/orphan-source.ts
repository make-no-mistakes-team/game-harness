import { spawn } from "node:child_process";
import {
  constants, fstatSync, lstatSync, openSync, closeSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync,
  type BigIntStats,
} from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export const orphanScopeName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}\.scope$/;
const transientScopeName = /^run-(?:u\d+|r[0-9a-f]+)\.scope$/;
const privateAuthorityPath = /^\/tmp(?:\/[A-Za-z0-9._-]+){0,4}\/xvfb-run\.[A-Za-z0-9]{6,}\/Xauthority$/;
const isPrivateAuthority = (value: unknown): value is string =>
  typeof value === "string" && privateAuthorityPath.test(value) &&
  !value.split("/").some(segment => segment === "." || segment === "..");
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const tokenPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const bootPattern = /^[0-9a-f]{32}$/;
const startMessage = "39f53479d3a045ac8e11786248231fbf";
const stopMessage = "9d1aaa27d60140bd96365438aad20286";
const resourcesMessage = "ae8f7b866b0347b9af31fe1c80b127c0";
const startWindowMs = 30_000;
const maxTreeEntries = 100_000;
const takeOFDLock = `
import ctypes
import fcntl
import os

if ctypes.sizeof(ctypes.c_void_p) != 8:
    raise OSError("unsupported Linux fcntl ABI")

class Flock(ctypes.Structure):
    _fields_ = [("type", ctypes.c_short), ("whence", ctypes.c_short),
                ("start", ctypes.c_int64), ("length", ctypes.c_int64), ("pid", ctypes.c_int)]

fcntl.fcntl(3, fcntl.F_OFD_SETLK, bytes(Flock(fcntl.F_WRLCK, os.SEEK_SET, 0, 0, 0)))
`;

type SourceInput = {
  runs: string; historicRuns: string; live: string; run: string; sourceGoal: string; ordinaryRunBasename: RegExp;
  scope?: string; bootMs: number; signal: AbortSignal;
};
export type SystemdQuery = (command: "systemctl" | "journalctl", args: string[], signal: AbortSignal) => Promise<string>;
export type SystemdEvidenceSource = { query: SystemdQuery; cgroupRoot: string };

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const optional = <T>(get: () => T): T | undefined => {
  try { return get(); } catch (error) { if (!missing(error)) throw error; }
};
const info = (file: string) => lstatSync(file, { bigint: true });
const absent = (file: string) => optional(() => info(file)) === undefined;
const identity = (entry: BigIntStats) => `${entry.dev}:${entry.ino}`;
const stamp = (s: BigIntStats) => `${identity(s)}:${s.mode}:${s.uid}:${s.gid}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const createdMs = (s: BigIntStats) => Number(s.birthtimeNs / 1_000_000n);
const changedMs = (s: BigIntStats) => Number((s.ctimeNs > s.mtimeNs ? s.ctimeNs : s.mtimeNs) / 1_000_000n);
const inside = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("a source record is malformed");
  return value as Record<string, unknown>;
};
const json = (text: string) => record(JSON.parse(text));

function privateJson(file: string, uid: bigint, device: bigint) {
  const fd = openSync(file, readFlags);
  try {
    const entry = fstatSync(fd, { bigint: true });
    if (!entry.isFile() || entry.uid !== uid || entry.dev !== device || entry.nlink !== 1n ||
        (entry.mode & 0o077n) || entry.size < 1n || entry.size > 65_536n || stamp(info(file)) !== stamp(entry))
      throw new Error("a source identity record is not private");
    const result = json(readFileSync(fd, "utf8"));
    if (stamp(info(file)) !== stamp(entry)) throw new Error("a source identity record changed");
    return { entry, result };
  } finally { closeSync(fd); }
}

async function runSystemd(command: "systemctl" | "journalctl", args: string[], signal: AbortSignal) {
  const runtime = `/run/user/${process.getuid!()}`;
  const child = Bun.spawn([`/usr/bin/${command}`, "--user", "--no-pager", ...args], {
    signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
    stdout: "pipe", stderr: "ignore",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` },
  });
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exit !== 0 || stdout.length > 256_000) throw new Error("the user systemd scope could not be verified");
  return stdout;
}

function journalRows(text: string) {
  return text.trim() ? text.trimEnd().split("\n").map(json) : [];
}

function procStart(stat: string) {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = fields[0], started = fields[19]; // proc(5) field 22, after PID and command.
  return state !== "Z" && state !== "X" && started && /^\d+$/.test(started) ? started : null;
}

function activeProc(pid: number | string) {
  return optional(() => procStart(readFileSync(`/proc/${pid}/stat`, "utf8")));
}

function holdsSessionLock(fd: number, file: BigIntStats) {
  const record = /^lock:[ \t]+\d+:[ \t]+OFDLCK[ \t]+ADVISORY[ \t]+WRITE[ \t]+-1[ \t]+([0-9a-f]+):([0-9a-f]+):(\d+)[ \t]+0[ \t]+EOF$/m
    .exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
  if (!record) return false;
  const major = ((file.dev >> 8n) & 0xfffn) | ((file.dev >> 32n) & ~0xfffn);
  const minor = (file.dev & 0xffn) | ((file.dev >> 12n) & 0xffffff00n);
  return BigInt(`0x${record[1]}`) === major && BigInt(`0x${record[2]}`) === minor && BigInt(record[3]!) === file.ino;
}

type ScopeProof = {
  scope: string; uid: bigint; managerCgroup: string;
  invocationId: string; stoppedAt: number;
};

async function requireInactiveScope(proof: ScopeProof, { query, cgroupRoot }: SystemdEvidenceSource, signal: AbortSignal) {
  const { scope, managerCgroup } = proof;
  const values = Object.fromEntries((await query("systemctl", ["show", "-p", "Id", "-p", "LoadState",
    "-p", "ActiveState", "-p", "SubState", "-p", "Transient", "-p", "ControlGroup", "-p", "InvocationID", scope],
  signal)).trimEnd().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const stopped = (values.ActiveState === "inactive" && values.SubState === "dead") ||
    (values.ActiveState === "failed" && values.SubState === "failed");
  if (values.Id !== scope || !stopped ||
      (values.LoadState === "not-found" ? values.ControlGroup !== "" :
        values.LoadState !== "loaded" || values.Transient !== "yes" || values.InvocationID !== proof.invocationId))
    throw new Error("the exact source scope is not confirmed inactive");
  const managerPath = `${cgroupRoot}${managerCgroup}`;
  if (!info(managerPath).isDirectory()) throw new Error("the source cgroup is not visible");
  function inspect(dir: string) {
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const entry = path.join(dir, child.name);
      if (child.name === scope) {
        if (!/^populated 0$/m.test(readFileSync(path.join(entry, "cgroup.events"), "utf8")))
          throw new Error("the source scope has remaining processes");
      } else if (child.name.endsWith(".slice")) inspect(entry);
    }
  }
  inspect(managerPath);
  if (values.ControlGroup && (!inside(values.ControlGroup, managerCgroup) || !values.ControlGroup.endsWith(`/${scope}`) ||
      !/^populated 0$/m.test(readFileSync(`${cgroupRoot}${values.ControlGroup}/cgroup.events`, "utf8"))))
    throw new Error("the reported source cgroup is not isolated and empty");
}

async function proveScope(scope: string, uid: bigint, bootMs: number, root: string, goal: string, startedAt: number,
    rootCreated: number, markedAt: number, declaredSeconds: unknown, legacyStoppedAt: number | undefined,
    hasOwner: boolean, systemd: SystemdEvidenceSource, signal: AbortSignal): Promise<ScopeProof> {
  const { query } = systemd;
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replaceAll("-", "");
  const managerCgroup = `/user.slice/user-${uid}.slice/user@${uid}.service`;
  const managerRow = (row: Record<string, unknown>) => row._BOOT_ID === bootId && row._UID === `${uid}` &&
    row._SYSTEMD_USER_UNIT === "init.scope" && row._SYSTEMD_UNIT === `user@${uid}.service` &&
    row._SYSTEMD_CGROUP === `${managerCgroup}/init.scope` && row._COMM === "systemd" &&
    row._EXE === "/usr/lib/systemd/systemd" && typeof row._PID === "string" && /^[1-9]\d*$/.test(row._PID);
  const time = (r: Record<string, unknown>) => typeof r.__REALTIME_TIMESTAMP === "string" &&
    /^\d{15,16}$/.test(r.__REALTIME_TIMESTAMP) ? Number(r.__REALTIME_TIMESTAMP) / 1_000 : NaN;
  const rows = journalRows(await query("journalctl", ["-b", "-o", "json", "--lines=32", "--user-unit", scope], signal));
  const starts = rows.filter(row => managerRow(row) && row.USER_UNIT === scope && row.MESSAGE_ID === startMessage &&
    row.JOB_TYPE === "start" && row.JOB_RESULT === "done");
  const start = starts[0];
  if (starts.length !== 1 || !start || typeof start.USER_INVOCATION_ID !== "string" ||
      !bootPattern.test(start.USER_INVOCATION_ID) || !bootPattern.test(bootId))
    throw new Error("there is no unique, authenticated current-boot scope start");
  const started = time(start);
  const ends = rows.filter(row => managerRow(row) && row.USER_UNIT === scope && row._PID === start._PID &&
    row.USER_INVOCATION_ID === start.USER_INVOCATION_ID &&
    (row.MESSAGE_ID === resourcesMessage || row.MESSAGE_ID === stopMessage && row.JOB_TYPE === "stop" && row.JOB_RESULT === "done") &&
    time(row) > started &&
    Number(row.__MONOTONIC_TIMESTAMP) > Number(start.__MONOTONIC_TIMESTAMP));
  const stoppedAt = Math.max(...ends.map(time));
  if (!(started > bootMs && started <= rootCreated && rootCreated <= startedAt && startedAt <= markedAt &&
      markedAt <= stoppedAt && stoppedAt <= Date.now() && startedAt - started <= startWindowMs))
    throw new Error("the authenticated scope lifetime does not contain the source startup and exit");

  // A journal-connected run can bind its exact path directly via the runner's first stdout line.
  const sourceLine = rows.some(row => row._BOOT_ID === bootId && row._UID === `${uid}` &&
    row._SYSTEMD_USER_UNIT === scope && row._SYSTEMD_INVOCATION_ID === start.USER_INVOCATION_ID &&
    typeof row._SYSTEMD_CGROUP === "string" && inside(row._SYSTEMD_CGROUP, managerCgroup) &&
    row._SYSTEMD_CGROUP.endsWith(`/${scope}`) && row._COMM === "bun" && typeof row._EXE === "string" &&
    path.isAbsolute(row._EXE) && path.basename(row._EXE) === "bun" && row.MESSAGE === root &&
    time(row) >= started && time(row) <= markedAt);
  if (!sourceLine) {
    // Interactive/piped scopes emit no journal stdout. Bind the unique launch
    // to the private directory birth, declaration, live inode, and either the
    // verified operator-stop owner record (modern transient scopes) or the
    // legacy epoch-named scope + runner-stop marker.
    const expectedScope = `survival-pair-${goal}-${Math.floor(started / 1_000)}.scope`;
    const scopeMatches = scope === expectedScope || (hasOwner && transientScopeName.test(scope));
    const stopMarkerMatches = hasOwner ||
      (legacyStoppedAt !== undefined && legacyStoppedAt >= markedAt && legacyStoppedAt <= stoppedAt);
    const description = typeof start.MESSAGE === "string" && start.MESSAGE.startsWith(`Started ${scope} - `)
      ? start.MESSAGE.slice(`Started ${scope} - `.length) : "";
    const play = /^(?:\/usr\/bin\/env(?: [A-Z_][A-Z_0-9]*=[^\s]+)* )?(?:[^ ]*\/)?bun run play:agent /;
    const competing = journalRows(await query("journalctl", ["-b", "-o", "json", "--lines=128",
      `--since=@${Math.floor((startedAt - startWindowMs) / 1_000)}`,
      `--until=@${Math.ceil(startedAt / 1_000)}`,
      `MESSAGE_ID=${startMessage}`, "_SYSTEMD_USER_UNIT=init.scope", `_UID=${uid}`], signal));
    const launches = competing.filter(row => managerRow(row) && time(row) <= startedAt &&
      typeof row.MESSAGE === "string" && play.test(row.MESSAGE.replace(/^Started [^ ]+ - /, "")));
    if (!scopeMatches || !play.test(description) || !Number.isSafeInteger(declaredSeconds) ||
        !description.endsWith(` ${goal} ${declaredSeconds}.`) || /--(?:parallel-world|diagnostic|replay-incident)\b/.test(description) ||
        !stopMarkerMatches ||
        launches.length !== 1 || launches[0]!.USER_INVOCATION_ID !== start.USER_INVOCATION_ID)
      throw new Error("the scope does not establish the exact private primary run identity");
  }
  const proof = { scope, uid, managerCgroup, invocationId: start.USER_INVOCATION_ID, stoppedAt };
  await requireInactiveScope(proof, systemd, signal);
  return proof;
}

function assertNoContact(proof: ScopeProof, root: string, authority: string, display: string, port: number, signal: AbortSignal) {
  const xSocket = `/tmp/.X11-unix/X${display.slice(1)}`;
  if (!absent(authority) || !absent(`/tmp/.X${display.slice(1)}-lock`) || !absent(xSocket) ||
      readFileSync("/proc/net/unix", "utf8").split("\n").some(line =>
        [` ${xSocket}`, ` @${xSocket}`].some(suffix => line.endsWith(suffix))))
    throw new Error("the old private display is still present or its identity is uncertain");
  // Reject any socket on the old port, not just one Java claims to own.
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (readFileSync(file, "utf8").split("\n").some(line => {
      const [, address, , state] = line.trim().split(/\s+/);
      return address && parseInt(address.split(":")[1]!, 16) === port && state === "0A";
    })) throw new Error("the old server port still has a listener");
  }

  const contact = (file: string) => inside(file.replace(/ \(deleted\)$/, ""), root) ||
    file.replace(/ \(deleted\)$/, "") === authority;
  for (const pid of readdirSync("/proc")) {
    if (!/^[1-9]\d*$/.test(pid) || pid === `${process.pid}`) continue;
    signal.throwIfAborted();
    const start = activeProc(pid);
    if (!start) continue;
    const proc = `/proc/${pid}`;
    try {
      const cgroup = /^0::(\/.*)$/m.exec(readFileSync(`${proc}/cgroup`, "utf8"))?.[1];
      if (!cgroup) throw new Error("a process cgroup is not visible");
      if (cgroup.split("/").includes(proof.scope)) throw new Error("the source scope still has a process");
      const status = readFileSync(`${proc}/status`, "utf8");
      const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
      if (!uids) throw new Error("a process owner is not visible");
      if (!uids.slice(1).includes(`${proof.uid}`)) continue;
      try {
        for (const target of [`${proc}/cwd`, `${proc}/root`]) {
          if (contact(readlinkSync(target))) throw new Error("a process is still in the source world");
        }
        for (const fd of readdirSync(`${proc}/fd`)) {
          const handle = `${proc}/fd/${fd}`;
          const file = optional(() => readlinkSync(handle));
          if (!file || !contact(file)) continue;
          try {
            const details = optional(() => readFileSync(`${proc}/fdinfo/${fd}`, "utf8"));
            if (!details) continue;
            const flags = /^flags:[ \t]+([0-7]+)$/m.exec(details)?.[1];
            if (!flags) throw new Error("a possible source writer's file mode could not be inspected");
            const accessMode = parseInt(flags, 8) & 0b11; // Linux O_ACCMODE.
            if ((accessMode === constants.O_WRONLY || accessMode === constants.O_RDWR) &&
                optional(() => statSync(handle))?.isFile() && optional(() => readlinkSync(handle)) === file)
              throw new Error("a process still has a writable source file open");
          } catch (error) {
            // Unlike invisible descriptors in other scopes, this one has
            // already been positively linked to the source.
            if ("code" in (error as Error)) throw new Error("a possible source writer's open descriptor could not be verified");
            throw error;
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // For unrelated scopes, descriptor access is only a check for positive
        // contact evidence. Linux may hide these links from this UID. No process
        // in the authenticated source scope is allowed, and any conforming
        // external JVM still has to acquire the exclusive vanilla lock we hold.
        if (code !== "EPERM" && code !== "EACCES") throw error;
      }
    } catch (error) {
      if (!activeProc(pid)) continue; // An exited process no longer has cwd or open descriptors.
      if ("code" in (error as Error)) throw new Error("a possible source writer could not be inspected");
      throw error;
    }
    const after = activeProc(pid);
    if (after && after !== start) throw new Error("a process identity changed during the writer scan");
  }
}

export async function openOrphanSource(input: SourceInput,
    systemd: SystemdEvidenceSource = { query: runSystemd, cgroupRoot: "/sys/fs/cgroup" }) {
  const { runs, historicRuns, live, run, scope, bootMs, sourceGoal, ordinaryRunBasename, signal } = input;
  signal.throwIfAborted();
  if (!scope || !orphanScopeName.test(scope)) throw new Error("an explicit isolated user systemd scope is required");
  if (process.platform !== "linux" || process.getuid === undefined) throw new Error("Linux process and world locks are required");
  const uid = BigInt(process.getuid());
  const home = path.dirname(runs);
  const root = path.join(runs, run);
  const world = path.join(root, "server/world");
  const sessionLock = path.join(world, "session.lock");
  if (path.basename(runs) !== "runs" || live !== path.join(home, "live.json") ||
      realpathSync(home) !== home || realpathSync(runs) !== runs)
    throw new Error("the source must be in the exact primary run store");
  const base = info(runs);
  const device = base.dev;
  const safeDirectory = (dir: string) => {
    const entry = info(dir);
    if (!entry.isDirectory() || entry.uid !== uid || entry.dev !== device || (entry.mode & 0o077n))
      throw new Error("the expected private primary run tree was not found");
    return entry;
  };
  for (const dir of [home, runs, root, path.dirname(world), world]) safeDirectory(dir);
  const identityPaths = [home, runs, root, path.dirname(world), world];
  const pathIds = identityPaths.map(dir => identity(safeDirectory(dir)));
  const rootEntry = info(root);
  const { result: marker, entry: markerEntry } = privateJson(live, uid, device);
  const markerScope = record(marker.operatorStop);
  const { authority, display } = marker;
  if (marker.run !== run || marker.active !== true || markerScope.directory !== identity(rootEntry) ||
      typeof markerScope.token !== "string" || !tokenPattern.test(markerScope.token) ||
      typeof display !== "string" || !/^:[1-9]\d{1,4}$/.test(display) || Number(display.slice(1)) < 90 ||
      !isPrivateAuthority(authority))
    throw new Error("the private live descriptor does not identify this primary run and display");
  const { result: declaration, entry: declarationEntry } = privateJson(path.join(root, "declaration.json"), uid, device);
  const startedAt = typeof declaration.startedAt === "string" ? Date.parse(declaration.startedAt) : NaN;
  const limits = record(declaration.limits);
  const port = record(declaration.connection).port;
  if ((declaration.executionSlot !== undefined && declaration.executionSlot !== "primary") ||
      declaration.goal !== sourceGoal || !(startedAt > bootMs) || changedMs(declarationEntry) > changedMs(markerEntry) ||
      !Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535)
    throw new Error("the source declaration is not the current-boot primary");

  function assertLatestPrimary() {
    if (!absent(path.join(historicRuns, run))) throw new Error("the source is aliased by the historic run store");
    const parallelLive = path.join(home, "parallel-live.json");
    if (!absent(parallelLive) && privateJson(parallelLive, uid, device).result.run === run)
      throw new Error("the same run is described as both primary and parallel");
    for (const name of readdirSync(runs)) {
      if (name === run || !ordinaryRunBasename.test(name) || name.slice(0, 24) < run.slice(0, 24)) continue;
      const other = path.join(runs, name);
      safeDirectory(other);
      const { result } = privateJson(path.join(other, "declaration.json"), uid, device);
      // Only a positively identified separate ordinary parallel run is skipped.
      const benchmark = record(result.benchmark);
      if (result.executionSlot !== "parallel" || result.schemaVersion !== 1 ||
          result.goal !== name.slice(25, -7) || benchmark.verifier !== "vanilla-survival" ||
          record(result.world).type !== "vanilla" || (result.claimScope !== "fresh-attempt" && result.claimScope !== "continuation-chain"))
        throw new Error("the source is not the unique latest ordinary primary run");
    }
  }
  assertLatestPrimary();
  if (!absent(path.join(root, "outcome.json"))) throw new Error("the source already has an outcome");
  const ownerPath = path.join(root, "operator-stop-owner.json");
  const hasOwner = !absent(ownerPath);
  if (hasOwner) {
    const { result: owner } = privateJson(ownerPath, uid, device);
    if (owner.run !== run || owner.slot !== "primary" || owner.display !== display || owner.authority !== authority ||
        owner.token !== markerScope.token || typeof owner.authorityId !== "string" ||
        !/^\d+:\d+:\d+$/.test(owner.authorityId) || typeof owner.pid !== "number" || owner.pid < 1 ||
        !Number.isSafeInteger(owner.pid) || typeof owner.started !== "string" || !/^\d+$/.test(owner.started) ||
        !Number.isSafeInteger(owner.parent) || activeProc(owner.pid) === owner.started)
      throw new Error("the exact private primary owner is still live or cannot be verified");
  }
  const legacy = optional(() => info(path.join(root, `runner-stop-${run}`)));
  if (legacy && (!legacy.isFile() || legacy.uid !== uid || legacy.dev !== device ||
      legacy.nlink !== 1n || (legacy.mode & 0o077n) || legacy.size !== 0n))
    throw new Error("the original runner stop marker is not private");
  if (!hasOwner && !legacy) throw new Error("there is no private primary owner or native runner stop marker");
  const proof = await proveScope(scope, uid, bootMs, root, sourceGoal, startedAt, createdMs(rootEntry),
    changedMs(markerEntry), limits.wallSeconds, legacy && changedMs(legacy), hasOwner, systemd, signal);

  function assertNoAlias() {
    const mountinfo = readFileSync("/proc/self/mountinfo", "utf8").trimEnd().split("\n");
    for (const line of mountinfo) {
      const fields = line.split(" ");
      const mount = fields[4]?.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if (!mount || inside(mount, home) ||
          mount === "/proc" && (/(?:^|[ ,])hidepid=(?!(?:0|off)(?:[ ,]|$))/.test(line) || !line.includes(" - proc ")))
        throw new Error("the source has a mount alias or process visibility is restricted");
    }
  }
  function getSnapshot(activeSignal: AbortSignal, before?: Map<string, string>) {
    let count = 0;
    const snapshot = before ?? new Map<string, string>();
    function walk(file: string) {
      activeSignal.throwIfAborted();
      if (++count > maxTreeEntries) throw new Error("the primary tree is too large to fence safely");
      const entry = info(file);
      if (entry.uid !== uid || entry.dev !== device || (entry.mode & 0o022n) ||
          !(entry.isDirectory() || entry.isFile() && entry.nlink === 1n) || changedMs(entry) > Math.ceil(proof.stoppedAt))
        throw new Error("the primary source contains a link, unowned file or post-scope change");
      const signature = stamp(entry);
      if (before && before.get(file) !== signature) throw new Error("the source metadata changed during recovery");
      if (!before) snapshot.set(file, signature);
      if (entry.isDirectory()) for (const child of readdirSync(file)) walk(path.join(file, child));
    }
    walk(root);
    if (snapshot.size !== count) throw new Error("the source contents changed during recovery");
    return snapshot;
  }

  assertNoAlias();
  const worldHandle = await open(world, readFlags | constants.O_DIRECTORY);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const lockEntry = info(sessionLock);
    if (!lockEntry.isFile() || lockEntry.uid !== uid || lockEntry.dev !== device || lockEntry.nlink !== 1n ||
        (lockEntry.mode & 0o022n) || lockEntry.size !== 3n)
      throw new Error("the vanilla session lock is not the owned regular file");
    lock = await open(sessionLock, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const lockHandle = lock;
    const stampLock = stamp(lockEntry);
    let closed = false;
    const assertPaths = () => {
      if (closed || realpathSync(home) !== home || identityPaths.some((dir, i) => identity(safeDirectory(dir)) !== pathIds[i]) ||
          identity(fstatSync(worldHandle.fd, { bigint: true })) !== pathIds.at(-1) ||
          stamp(info(sessionLock)) !== stampLock || stamp(fstatSync(lockHandle.fd, { bigint: true })) !== stampLock ||
          !holdsSessionLock(lockHandle.fd, lockEntry))
        throw new Error("the pinned primary world or kernel session lock changed");
    };
    // OFD locks and Java FileChannel.tryLock use the same kernel conflict
    // domain. The inherited descriptor shares our open file description.
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("/usr/bin/python3", ["-I", "-S", "-c", takeOFDLock], {
        stdio: ["ignore", "ignore", "ignore", lockHandle.fd], signal, env: { PATH: "/usr/bin:/bin" },
      });
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (exit !== 0) throw new Error("the vanilla session lock is held by another writer or cannot be proved");
    assertPaths();
    const snapshot = getSnapshot(signal);
    return {
      scope, worldFd: worldHandle.fd, assertLatestPrimary,
      assertSource() {
        assertPaths();
        if (stamp(info(live)) !== stamp(markerEntry)) throw new Error("the private primary descriptor changed");
      },
      async assertQuiescent(activeSignal: AbortSignal = signal) {
        activeSignal.throwIfAborted();
        assertPaths();
        await requireInactiveScope(proof, systemd, activeSignal);
        assertNoAlias();
        assertNoContact(proof, root, authority, display, port as number, activeSignal);
        getSnapshot(activeSignal, snapshot);
        assertPaths();
      },
      async close() {
        if (closed) return;
        closed = true;
        try { await lockHandle.close(); } finally { await worldHandle.close(); }
      },
    };
  } catch (error) {
    try { await lock?.close(); } finally { await worldHandle.close(); }
    throw error;
  }
}
