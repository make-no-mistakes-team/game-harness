import { expect, test } from "bun:test";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openOrphanAutosave } from "../src/agent/crash-autosave.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const prefix = (ms: number) => iso(ms).replaceAll(":", "-");
const profile = { name: "Steve", uuid: "5627dd98-e6be-3c21-b8a8-e92344183641" };
const pathToken = "d26b2994-ccf4-4c59-9936-39d9c01db703";
const invocationId = "7fe5ac43427040d59cbf73f1708a7095";
const startMessage = "39f53479d3a045ac8e11786248231fbf";
const stopMessage = "ae8f7b866b0347b9af31fe1c80b127c0";

async function bind(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("no local fixture port");
  return { port: bound.port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function fixture<T>(use: (proof: {
  root: string; world: string; live: string; port: number; startedAt: number;
  laterRun: (slot: "primary" | "parallel") => Promise<void>;
  open: (options?: { wrongScope?: boolean; active?: boolean; failed?: boolean }) => ReturnType<typeof openOrphanAutosave>;
}) => Promise<T>, config: {
  authority?: string;
  scope?: string;
  startupLagMs?: number;
  withOwner?: boolean;
  withLegacyMarker?: boolean;
} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "orphan-autosave-"));
  try {
    const uid = process.getuid!();
    const userGroup = `/user.slice/user-${uid}.slice/user@${uid}.service`;
    const cgroupRoot = join(temporary, "cgroups");
    await mkdir(cgroupRoot + userGroup, { recursive: true, mode: 0o700 });
    const runs = join(temporary, "ordinary/runs");
    const live = join(temporary, "ordinary/live.json");
    const runClock = Date.now();
    const run = `${prefix(runClock)}-diamond-Ab123Z`;
    const root = join(runs, run);
    const server = join(root, "server");
    const world = join(server, "world");
    for (const dir of [join(world, "region"), join(world, "playerdata"), join(world, "stats"), join(server, "logs")])
      await mkdir(dir, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root, { bigint: true });
    const rootCreated = Number(rootInfo.birthtimeNs / 1_000_000n);
    const startedAt = Math.max(runClock, rootCreated);
    const scopeStarted = rootCreated - (config.startupLagMs ?? 200);
    const scope = config.scope ?? `survival-pair-diamond-${Math.floor(scopeStarted / 1_000)}.scope`;
    const authority = config.authority ?? "/tmp/xvfb-run.TEST99/Xauthority";
    const free = await bind(0);
    await free.close();
    const { port } = free;
    const json = (file: string, value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
    const write = (file: string, value: string | Buffer) => writeFile(file, value, { mode: 0o600 });
    const declaration = {
      schemaVersion: 1, startedAt: iso(startedAt), goal: "diamond", minecraftVersion: "1.21.4",
      agentJarSha256: "a".repeat(64), claimScope: "fresh-attempt",
      benchmark: { goal: "diamond", verifier: "vanilla-survival", claimScope: "fresh-attempt" },
      connection: { host: "127.0.0.1", port, auth: "host-verified-official-launcher" },
      recording: { file: "screen.mp4" }, limits: { wallSeconds: 45, reserveBytes: 1_059_000_000 },
      world: { type: "vanilla", mode: "survival", difficulty: "normal", fresh: true, seed: "random" },
    };
    // Linux inode timestamps can trail the wall clock until the next tick.
    await Bun.sleep(12);
    await json(join(root, "declaration.json"), declaration);
    await json(live, {
      run, active: true, display: ":17341", authority,
      operatorStop: { directory: `${rootInfo.dev}:${rootInfo.ino}`, token: pathToken },
    });
    if (config.withOwner) {
      await json(join(root, "operator-stop-owner.json"), {
        run, slot: "primary", display: ":17341", authority,
        authorityId: `${rootInfo.dev}:123456:1795739380035212774`, token: pathToken,
        pid: 4_194_300, started: "999999999", parent: 1,
      });
    }
    if (config.withLegacyMarker ?? !config.withOwner) {
      await write(join(root, `runner-stop-${run}`), "");
    }
    const startup = ["declared", "server_started", "server_ready", "recorder_started", "client_started", "agent_ready"];
    await write(join(root, "history.jsonl"), startup.map((event, i) => JSON.stringify({
      event, at: iso(startedAt + i), elapsedMs: i, ...(event === "agent_ready" ? { tick: 1 } : {}),
    })).join("\n") + "\n");
    await json(join(root, "progress.json"), { goal: "diamond", tick: 191, won: false });
    await write(join(root, "screen.mp4"), Buffer.from([0, 0, 0, 8, ...Buffer.from("ftyp")]));
    await write(join(server, "server.properties"), [
      "server-ip=127.0.0.1", `server-port=${port}`, "online-mode=false", "gamemode=survival", "force-gamemode=false",
      "difficulty=normal", "hardcore=false", "level-name=world", "max-players=1", "enable-rcon=false", "enable-query=false",
    ].join("\n"));
    await json(join(server, "usercache.json"), [profile]);
    await write(join(server, "logs/latest.log"),
      "[00:00:03] [Server thread/INFO]: Starting minecraft server version 1.21.4\n" +
      "[00:00:05] [Server thread/INFO]: Default game type: SURVIVAL\n" +
      `[00:00:08] [Server thread/INFO]: ${profile.name} joined the game\n` +
      "[00:00:21] [Server thread/INFO]: Stopping server\n");
    const envelope = gzipSync(Buffer.from([10, 0, 0, 0]));
    await write(join(world, "level.dat"), envelope);
    await write(join(world, "session.lock"), "☃");
    await write(join(world, "playerdata", `${profile.uuid}.dat`), envelope);
    await json(join(world, "stats", `${profile.uuid}.json`), { stats: {} });
    const region = Buffer.alloc(12_288);
    region.writeUIntBE(2, 0, 3);
    region[3] = 1;
    await write(join(world, "region/r.0.0.mca"), region);
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().replaceAll("-", "");
    const open: Parameters<typeof use>[0]["open"] = ({ wrongScope = false, active = false, failed = false } = {}) => {
      const stop = Date.now();
      const manager = {
        _BOOT_ID: bootId, _UID: `${uid}`, _COMM: "systemd", _EXE: "/usr/lib/systemd/systemd", _PID: "1",
        _SYSTEMD_UNIT: `user@${uid}.service`, _SYSTEMD_USER_UNIT: "init.scope", _SYSTEMD_CGROUP: `${userGroup}/init.scope`,
        USER_UNIT: scope, USER_INVOCATION_ID: invocationId,
      };
      const start = {
        ...manager, MESSAGE_ID: startMessage, JOB_TYPE: "start", JOB_RESULT: "done",
        MESSAGE: `Started ${scope} - /usr/bin/env LP_NUM_THREADS=3 bun run play:agent diamond 45.`,
        __REALTIME_TIMESTAMP: `${scopeStarted * 1_000}`, __MONOTONIC_TIMESTAMP: "1000000",
      };
      const end = {
        ...manager, MESSAGE_ID: stopMessage, __REALTIME_TIMESTAMP: `${stop * 1_000}`, __MONOTONIC_TIMESTAMP: "11000000",
      };
      const requested = wrongScope ? "unrelated.scope" : scope;
      const stateLines = failed
        ? `Id=${requested}\nLoadState=loaded\nActiveState=failed\nSubState=failed\nTransient=yes\nControlGroup=\nInvocationID=${invocationId}\n`
        : `Id=${requested}\nLoadState=not-found\nActiveState=${active ? "active" : "inactive"}\nSubState=dead\nControlGroup=\n`;
      return openOrphanAutosave({
        runs, live, run, historicRuns: join(temporary, "historic/runs"), goal: "nether_portal",
        scope: requested, signal: AbortSignal.timeout(15_000),
      }, {
        cgroupRoot,
        query: async (command, args) => command === "systemctl"
          ? stateLines
          : (args.includes("--user-unit") ? [start, end] : [start]).map(row => JSON.stringify(row)).join("\n"),
      });
    };
    return await use({
      root, world, live, port, startedAt, open,
      async laterRun(slot) {
        const later = join(runs, `${prefix(runClock + 30_000)}-diamond-CD456E`);
        await mkdir(later, { mode: 0o700 });
        await json(join(later, "declaration.json"), { ...declaration, executionSlot: slot });
      },
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function attemptPosixLock(file: string) {
  return Bun.spawn(["/usr/bin/python3", "-I", "-S", "-c",
    "import fcntl, sys; f = open(sys.argv[1], 'r+'); fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)", file],
  { stdout: "ignore", stderr: "ignore" }).exited;
}

test("a same-boot inactive primary yields no claim, pins the actual Java lock, and ignores a separate later parallel run", async () => {
  await fixture(async ({ open, laterRun, root, world }) => {
    await laterRun("parallel");
    const lock = join(world, "session.lock");
    const saved = await lstat(lock, { bigint: true });
    const source = await open();
    try {
      expect(source.root).toBe(root);
      expect(source.profileName).toBe(profile.name);
      expect(source.normalParentRun).toBeUndefined();
      expect(source.reservation.priorReserveBytes).toBe(1_059_000_000);
      expect(source.provenance).toMatchObject({
        kind: "same-boot-orphan-autosave", possibleProgressLoss: true, carriedClaim: null, sourceLastObservedTick: 191,
      });
      expect((await lstat(`/proc/self/fd/${source.worldFd}`)).isSymbolicLink()).toBe(true);
      expect(await attemptPosixLock(lock)).not.toBe(0);
      await source.assertQuiescent();
    } finally { await source.close(); }
    expect(await attemptPosixLock(lock)).toBe(0);
    const after = await lstat(lock, { bigint: true });
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([saved.ino, saved.mtimeNs, saved.ctimeNs]);
    expect(await readFile(lock, "utf8")).toBe("☃");
  });
});

test("an unrelated inactive scope or an active source scope supplies no recovery authority", async () => {
  await fixture(async ({ open }) => {
    await expect(open({ wrongScope: true })).rejects.toThrow("no unique, authenticated current-boot scope start");
    await expect(open({ active: true })).rejects.toThrow("not confirmed inactive");
  });
});

test("the copy fence detects a source mutation after admission", async () => {
  await fixture(async ({ open, world }) => {
    const source = await open();
    try {
      await appendFile(join(world, "level.dat"), "changed");
      await expect(source.assertQuiescent()).rejects.toThrow(/source.*changed|post-scope change/i);
    } finally { await source.close(); }
  });
});

test("an external listener or writable source descriptor refuses recovery, but a reader does not", async () => {
  await fixture(async ({ open, port, world }) => {
    const listener = await bind(port);
    try { await expect(open()).rejects.toThrow("old server port still has a listener"); }
    finally { await listener.close(); }
    for (const mode of ["rb", "r+b"]) {
      const child = Bun.spawn(["/usr/bin/python3", "-I", "-S", "-c",
        "import os, sys; f = open(os.environ['FIXTURE_FILE'], sys.argv[1]); print('ready', flush=True); sys.stdin.buffer.read()", mode],
      { stdin: "pipe", stdout: "pipe", env: { FIXTURE_FILE: join(world, "level.dat") } });
      try {
        const stdout = child.stdout.getReader();
        try { expect(new TextDecoder().decode((await stdout.read()).value).trim()).toBe("ready"); }
        finally { stdout.releaseLock(); }
        if (mode === "rb") {
          const source = await open();
          await source.close();
        } else {
          await expect(open()).rejects.toThrow("writable source file open");
        }
      } finally {
        child.stdin.end();
        await child.exited;
      }
    }
  });
});

test("a newer primary, a displaced live descriptor, and a closing claim each fail closed", async () => {
  await fixture(async ({ open, laterRun }) => {
    await laterRun("primary");
    await expect(open()).rejects.toThrow("not the unique latest ordinary primary run");
  });
  await fixture(async ({ open, live }) => {
    const marker = JSON.parse(await readFile(live, "utf8"));
    marker.operatorStop.directory = "0:1";
    await writeFile(live, JSON.stringify(marker));
    await expect(open()).rejects.toThrow("does not identify this primary run");
  });
  await fixture(async ({ open, root, startedAt }) => {
    await appendFile(join(root, "history.jsonl"), JSON.stringify({
      event: "work_program_goal", at: iso(startedAt + 10), elapsedMs: 10, tick: 45,
    }) + "\n");
    await expect(open()).rejects.toThrow("contains a closing claim");
  });
});

test("transient systemd-run scopes with owner metadata, nested TMPDIR Xauthority, startup scan lag, and failed-stopped state verify cleanly", async () => {
  await fixture(async ({ open, root }) => {
    const indexesDir = join(root, "client/native-client/assets/indexes");
    await mkdir(indexesDir, { recursive: true, mode: 0o700 });
    const indexFile = join(indexesDir, "19.json");
    await writeFile(indexFile, "{}");
    await chmod(indexFile, 0o664);
    await symlink("/home/example/.minecraft/assets/objects", join(root, "client/native-client/assets/objects"), "dir");
    const source = await open({ failed: true });
    try {
      expect(source.root).toBe(root);
      expect(source.scope).toBe("run-u4310.scope");
      await source.assertQuiescent();
    } finally { await source.close(); }
  }, {
    scope: "run-u4310.scope",
    authority: "/tmp/oacp-1000/120f8eda/run-j1XgOv/xvfb-run.SXZluZ/Xauthority",
    startupLagMs: 13_200,
    withOwner: true,
    withLegacyMarker: false,
  });
});

test("arbitrary symlinks inside the run tree remain rejected", async () => {
  await fixture(async ({ open, root }) => {
    await symlink("/tmp/elsewhere", join(root, "server/world/rogue-link"));
    await expect(open()).rejects.toThrow("link, unowned file or post-scope change");
  });
});

test("transient scopes without an owner record and authority paths with traversal segments are rejected", async () => {
  await fixture(async ({ open }) => {
    await expect(open()).rejects.toThrow("exact private primary run identity");
  }, {
    scope: "run-u4310.scope",
    withOwner: false,
    withLegacyMarker: true,
  });
  await fixture(async ({ open }) => {
    await expect(open()).rejects.toThrow("does not identify this primary run and display");
  }, {
    authority: "/tmp/oacp-1000/../xvfb-run.TEST99/Xauthority",
  });
});
