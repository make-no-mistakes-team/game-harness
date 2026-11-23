import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SURVIVAL_AGENT_GOALS as GOALS, type SurvivalAgentGoal as Goal } from "../src/shared/survival-agent-ui.ts";
import { offlineUuid } from "./diagnostic-pool.ts";
import { openOrphanSource, orphanScopeName, type SystemdEvidenceSource } from "./orphan-source.ts";

export const ordinaryRunBasename = new RegExp(
  `^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-(?:${GOALS.join("|")})-[A-Za-z0-9]{6}$`,
);

const isoTime = z.iso.datetime();
const recoveryFields = {
  sourceRun: z.string().regex(ordinaryRunBasename),
  sourceLastObservedTick: z.int().positive(),
  sourceLastActivityAt: isoTime,
  sourceSaveLastWriteAt: isoTime,
  possibleProgressLoss: z.literal(true),
  carriedClaim: z.literal(null),
};
const crashProvenance = z.object({
  kind: z.literal("previous-boot-crash-autosave"), ...recoveryFields, recoveryKernelBootAt: isoTime,
});
export const orphanAutosaveProvenance = z.object({
  kind: z.literal("same-boot-orphan-autosave"), ...recoveryFields, sourceScope: z.string().regex(orphanScopeName),
});
const autosaveProvenance = z.union([crashProvenance, orphanAutosaveProvenance]);
const declarationSchema = z.object({
  schemaVersion: z.literal(1),
  startedAt: isoTime,
  goal: z.enum(GOALS),
  minecraftVersion: z.literal("1.21.4"),
  agentJarSha256: z.string().regex(/^[a-f0-9]{64}$/),
  claimScope: z.enum(["fresh-attempt", "continuation-chain"]),
  benchmark: z.object({
    goal: z.enum(GOALS), verifier: z.literal("vanilla-survival"),
    claimScope: z.enum(["fresh-attempt", "continuation-chain"]),
  }),
  connection: z.object({
    host: z.literal("127.0.0.1"), port: z.int().min(1).max(65535),
    auth: z.literal("host-verified-official-launcher"),
  }),
  recording: z.object({ file: z.literal("screen.mp4") }),
  limits: z.object({ reserveBytes: z.int().positive() }),
  world: z.object({
    type: z.literal("vanilla"), mode: z.literal("survival"), difficulty: z.literal("normal"),
    fresh: z.boolean(), seed: z.literal("random").optional(),
    parentRun: z.string().regex(ordinaryRunBasename).optional(), crashAutosave: crashProvenance.optional(),
  }),
});
const historySchema = z.object({
  at: isoTime, elapsedMs: z.int().nonnegative(), event: z.string(), tick: z.int().nonnegative().optional(),
  parentRun: z.string().optional(), crashAutosave: crashProvenance.optional(),
});
const orphanDeclaration = declarationSchema.extend({
  world: declarationSchema.shape.world.extend({ crashAutosave: autosaveProvenance.optional() }),
});
const orphanHistory = historySchema.extend({ crashAutosave: autosaveProvenance.optional() });
const requiredHistory = ["declared", "server_started", "server_ready", "recorder_started", "client_started", "agent_ready"];
const closingEvents = new Set(["closed", "server_drained", "operator_stop_accepted", "work_program_goal"]);
const regionFile = /^r\.-?\d+\.-?\d+\.mca$/;
const profileName = /^[A-Za-z0-9_]{1,16}$/;
const offlinePlayer = /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export async function currentKernelBootMs() {
  // Linux btime has one-second precision. Proof must be strictly older, not equal.
  const match = /^btime ([1-9]\d*)$/m.exec(await readFile("/proc/stat", "utf8"));
  const bootMs = Number(match?.[1]) * 1000;
  if (!Number.isSafeInteger(bootMs) || bootMs >= Date.now()) {
    throw new Error("Cannot prove crash autosave eligibility against this kernel's boot time.");
  }
  return bootMs;
}

type RecoveryInput = { runs: string; historicRuns: string; live: string; run: string; goal: Goal; signal: AbortSignal };

/** Admission evidence only. Never deserialize world, chunk or player state. */
export async function readCrashAutosave(input: RecoveryInput & { bootMs: number }) {
  const { source, evidence, startedAtMs, priorReserveBytes } = await readAutosaveEvidence(input, input.bootMs);
  return {
    ...source, reservation: { bootMs: input.bootMs, startedAtMs, priorReserveBytes },
    provenance: {
      kind: "previous-boot-crash-autosave", ...evidence, recoveryKernelBootAt: new Date(input.bootMs).toISOString(),
    } satisfies z.infer<typeof crashProvenance>,
  };
}

export async function openOrphanAutosave(input: RecoveryInput & { scope?: string }, systemd?: SystemdEvidenceSource) {
  const { run, signal } = input;
  let fence: Awaited<ReturnType<typeof openOrphanSource>> | undefined;
  try {
    if (!ordinaryRunBasename.test(run)) throw new Error("invalid ordinary run name");
    const bootMs = await currentKernelBootMs();
    fence = await openOrphanSource({
      ...input, bootMs, sourceGoal: run.slice(25, -7), ordinaryRunBasename,
      scope: input.scope ?? process.env.SURVIVAL_AGENT_ORPHAN_SCOPE,
    }, systemd);
    const { source, evidence, startedAtMs, priorReserveBytes } = await readAutosaveEvidence(input, bootMs, fence);
    await fence.assertQuiescent();
    fence.assertSource();
    fence.assertLatestPrimary();
    return {
      ...source, ...fence,
      reservation: { kind: "same-boot-orphan-autosave" as const, startedAtMs, priorReserveBytes },
      provenance: {
        kind: "same-boot-orphan-autosave", ...evidence, sourceScope: fence.scope,
      } satisfies z.infer<typeof orphanAutosaveProvenance>,
    };
  } catch (error) {
    await fence?.close();
    signal.throwIfAborted();
    throw new Error(`Cannot recover orphan autosave ${run}: ${recoveryReason(error)}.`);
  }
}

function recoveryReason(error: unknown) {
  return error instanceof Error && !(error instanceof z.ZodError) &&
    !(error instanceof SyntaxError) && !("code" in error) ? error.message : "source records are missing or malformed";
}

async function readAutosaveEvidence({
  runs, historicRuns, live, run, goal, signal,
}: RecoveryInput, bootMs: number, orphan?: Awaited<ReturnType<typeof openOrphanSource>>) {
  const reject = (reason: string): never => { throw new Error(reason); };
  try {
    const uid = process.getuid?.();
    const activityTime = (entry: { mtimeMs: number; ctimeMs: number }) => {
      const time = Math.max(entry.mtimeMs, entry.ctimeMs);
      if (!orphan && !(time < bootMs)) reject("a source artifact changed during this boot");
      return time;
    };
    if (!ordinaryRunBasename.test(run)) reject("invalid ordinary run name");
    const root = path.join(runs, run);
    const server = path.join(root, "server");
    const world = path.join(server, "world");
    const base = await lstat(runs);
    const device = base.dev;
    const local = await lstat(path.dirname(path.dirname(runs)));
    if (!local.isDirectory() || local.uid !== uid || local.dev !== device) reject("the local run root is not owned");
    const check = async (file: string) => {
      signal.throwIfAborted();
      const entry = await lstat(file);
      if (entry.uid !== uid || entry.dev !== device || (entry.mode & 0o022) ||
          !(entry.isDirectory() || entry.isFile() && entry.nlink === 1)) reject("source must be owned and contain no links");
      return entry;
    };
    for (const directory of [path.dirname(runs), runs, root, server, world,
        path.join(world, "region"), path.join(world, "playerdata"), path.join(world, "stats")]) {
      const entry = await check(directory);
      if (!entry.isDirectory() || (directory === root && (entry.mode & 0o077)))
        reject("the expected private ordinary run tree was not found");
    }
    if (!orphan) {
      const names = (await readdir(runs)).filter(name => ordinaryRunBasename.test(name));
      if (names.some(name => name !== run && name.slice(0, 24) >= run.slice(0, 24)) ||
          await lstat(path.join(historicRuns, run)).then(() => true, error => {
            if (error.code !== "ENOENT") throw error;
            return false;
          })) reject("the source is not the unique latest ordinary run");
    }

    const file = async <T>(name: string, inspect: (handle: Awaited<ReturnType<typeof open>>, size: number) => Promise<T>) => {
      const entry = await check(name);
      activityTime(entry);
      if (!entry.isFile() || !entry.size) reject("a required source artifact is not a nonempty regular file");
      const handle = await open(name, readFlags);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== device || opened.ino !== entry.ino || opened.ctimeMs !== entry.ctimeMs ||
            opened.nlink !== 1 || opened.size !== entry.size) reject("a source artifact changed during recovery");
        return await inspect(handle, entry.size);
      } finally { await handle.close(); }
    };
    const text = (name: string, max: number) => file(name, (handle, size) => {
      if (size > max) reject("a source evidence record exceeds its allowed size");
      return handle.readFile({ encoding: "utf8", signal });
    });
    const parse = async (name: string, max = 64_000): Promise<unknown> => JSON.parse(await text(name, max));
    const chunk = async (handle: Awaited<ReturnType<typeof open>>, size: number, offset: number) => {
      const bytes = Buffer.alloc(size);
      if ((await handle.read(bytes, 0, size, offset)).bytesRead !== size) reject("a vanilla file has an incomplete header");
      return bytes;
    };
    const markerEntry = await check(live);
    const marker = z.object({ run: z.literal(run), active: z.literal(true) }).safeParse(await parse(live));
    if (!marker.success || (markerEntry.mode & 0o077)) reject("the previous live marker does not identify this source");
    if ((await readdir(root)).includes("outcome.json")) reject("the source already has an outcome");
    const declaration = (orphan ? orphanDeclaration : declarationSchema).safeParse(await parse(path.join(root, "declaration.json")));
    if (!declaration.success) throw new Error("the original ordinary declaration is missing or invalid");
    const declared = declaration.data;
    const prior = declared.world.parentRun;
    const priorGoal = prior && GOALS.find(candidate => prior.slice(25, -7) === candidate);
    const startedAtMs = Date.parse(declared.startedAt);
    const runStartedAtMs = Date.parse(run.slice(0, 24).replace(/T(\d{2})-(\d{2})-/, "T$1:$2:"));
    if (declared.benchmark.goal !== declared.goal || declared.benchmark.claimScope !== declared.claimScope ||
        declared.goal !== run.slice(25, -7) || !Number.isFinite(runStartedAtMs) ||
        new Date(runStartedAtMs).toISOString().replaceAll(":", "-") !== run.slice(0, 24) ||
        startedAtMs < runStartedAtMs || (orphan ? startedAtMs <= bootMs : startedAtMs >= bootMs) ||
        activityTime(markerEntry) < startedAtMs ||
        GOALS.indexOf(declared.goal) > GOALS.indexOf(goal) ||
        (declared.world.fresh
          ? declared.claimScope !== "fresh-attempt" || declared.world.seed !== "random" || prior || declared.world.crashAutosave
          : declared.claimScope !== "continuation-chain" || declared.world.seed !== undefined ||
            !prior || !priorGoal || prior.slice(0, 24) >= run.slice(0, 24) ||
            GOALS.indexOf(priorGoal) > GOALS.indexOf(declared.goal) ||
            declared.world.crashAutosave && declared.world.crashAutosave.sourceRun !== prior))
      reject("the source is not in the requested ordinary Survival goal chain");

    const history = await text(path.join(root, "history.jsonl"), 4_000_000);
    if (!history.endsWith("\n")) reject("the native startup history has an incomplete record");
    let ordinal = 0, readyTick = 0, lastEvent = startedAtMs, lastElapsed = 0, copied = false;
    for (const line of history.slice(0, -1).split("\n")) {
      const row = (orphan ? orphanHistory : historySchema).parse(JSON.parse(line));
      const at = Date.parse(row.at);
      if (at < lastEvent || (!orphan && at >= bootMs) || row.elapsedMs < lastElapsed || closingEvents.has(row.event))
        reject("source history contains a closing claim or invalid activity time");
      lastEvent = at;
      lastElapsed = row.elapsedMs;
      const phase = requiredHistory.indexOf(row.event);
      if (phase !== -1) {
        if (phase !== ordinal++) reject("source does not show an ordered native startup");
        if (row.event === "agent_ready") readyTick = row.tick ?? 0;
      }
      if (row.event === "world_copied") {
        if (!prior || copied || ordinal !== 1 || row.parentRun !== prior ||
            JSON.stringify(row.crashAutosave) !== JSON.stringify(declared.world.crashAutosave))
          reject("source history does not establish its continuation edge");
        copied = true;
      }
    }
    const progress = z.object({ goal: z.literal(declared.goal), tick: z.int().positive(), won: z.literal(false) })
      .safeParse(await parse(path.join(root, "progress.json")));
    if (ordinal !== requiredHistory.length || readyTick < 1 || copied !== Boolean(prior) ||
        !progress.success || progress.data.tick < readyTick)
      throw new Error("there is no prior native client evidence with an unclaimed reported tick");
    await file(path.join(root, "screen.mp4"), async (handle) => {
      if ((await chunk(handle, 8, 0)).toString("ascii", 4) !== "ftyp") reject("the source has no native recording");
    });

    const properties = (await text(path.join(server, "server.properties"), 32_000)).split(/\r?\n/);
    for (const property of ["server-ip=127.0.0.1", `server-port=${declared.connection.port}`, "online-mode=false",
        "gamemode=survival", "force-gamemode=false", "difficulty=normal", "hardcore=false", "level-name=world",
        "max-players=1", "enable-rcon=false", "enable-query=false"]) {
      const key = property.slice(0, property.indexOf("=") + 1);
      const matches = properties.filter(line => line.startsWith(key));
      if (matches.length !== 1 || matches[0] !== property)
        reject("the source was not configured as an ordinary loopback Survival server");
    }
    const cached = z.tuple([z.object({ name: z.string().regex(profileName), uuid: z.string().regex(offlinePlayer) })])
      .parse(await parse(path.join(server, "usercache.json")));
    const { name, uuid } = cached[0];
    const log = await text(path.join(server, "logs/latest.log"), 4_000_000);
    if (uuid !== offlineUuid(name) || !log.includes("Starting minecraft server version 1.21.4") ||
        !log.includes("Default game type: SURVIVAL") || !log.includes(`] [Server thread/INFO]: ${name} joined the game`) ||
        (orphan ? /All dimensions are saved/.test(log) :
          /Stopping server|Saving players|Saving worlds|All dimensions are saved/.test(log)))
      reject("the prior server log lacks an ordinary joined profile or records shutdown");
    for (const [dir, ext] of [["playerdata", "dat"], ["stats", "json"]] as const) {
      const entries = (await readdir(path.join(world, dir))).filter(file => file.endsWith(`.${ext}`));
      if (entries.length !== 1 || entries[0] !== `${uuid}.${ext}`) reject("the vanilla save is not for the one joined profile");
    }
    const gzip = (name: string) => file(name, async (handle, size) => {
      const header = await chunk(handle, 10, 0);
      if (size < 20 || header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 8 || (header[3]! & 0xe0) ||
          (await chunk(handle, 4, size - 4)).readUInt32LE() < 4) reject("missing vanilla gzip file envelope");
    });
    await gzip(path.join(world, "level.dat"));
    await gzip(path.join(world, "playerdata", `${uuid}.dat`));
    await file(path.join(world, "stats", `${uuid}.json`), async () => {});
    await file(path.join(world, "session.lock"), async (handle, size) => {
      if (size !== 3 || !(await chunk(handle, 3, 0)).equals(Buffer.from("☃"))) reject("invalid vanilla session lock file");
    });
    const regions = (await readdir(path.join(world, "region"))).filter(name => regionFile.test(name));
    if (!regions.length) reject("the autosave has no vanilla overworld region file");
    for (const region of regions) {
      await file(path.join(world, "region", region), async (handle, size) => {
        if (size < 12_288 || size % 4096) reject("invalid vanilla region length");
        const locations = await chunk(handle, 4096, 0);
        const spans: Array<[number, number]> = [];
        for (let i = 0; i < locations.length; i += 4) {
          const start = locations.readUIntBE(i, 3), count = locations[i + 3]!;
          if (!start && !count) continue;
          if (start < 2 || !count || start + count > size / 4096) reject("invalid vanilla region sector table");
          spans.push([start, start + count]);
        }
        spans.sort((a, b) => a[0] - b[0]);
        if (!spans.length || spans.some(([start], i) => i > 0 && start < spans[i - 1]![1]))
          reject("empty or overlapping vanilla region sector table");
      });
    }

    let lastActivity = lastEvent, lastSaveWrite = 0;
    async function ownedTree(dir: string) {
      const entry = await check(dir);
      lastActivity = Math.max(lastActivity, activityTime(entry));
      if (entry.isDirectory()) {
        for (const child of await readdir(dir)) await ownedTree(path.join(dir, child));
      } else if (dir.startsWith(`${world}${path.sep}`)) lastSaveWrite = Math.max(lastSaveWrite, entry.mtimeMs);
    }
    await ownedTree(root);
    const rootEntry = await check(root);
    return {
      source: {
        root, rootInode: rootEntry.ino, device, world, profileName: name, goal: declared.goal,
        normalParentRun: declared.world.crashAutosave ? undefined : prior,
      },
      startedAtMs, priorReserveBytes: declared.limits.reserveBytes,
      evidence: {
        sourceRun: run, sourceLastObservedTick: progress.data.tick,
        sourceLastActivityAt: new Date(lastActivity).toISOString(),
        sourceSaveLastWriteAt: new Date(lastSaveWrite).toISOString(),
        possibleProgressLoss: true as const, carriedClaim: null,
      },
    };
  } catch (error) {
    signal.throwIfAborted();
    if (orphan) throw error;
    throw new Error(`Cannot recover crash autosave ${run}: ${recoveryReason(error)}.`);
  }
}
