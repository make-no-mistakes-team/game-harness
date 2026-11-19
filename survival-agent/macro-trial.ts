import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, readFileSync, writeSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  MACRO_CAPABILITIES_VERSION, parseMacroReceipt, readMacroObservation, readMacroReceipt, writeMacroIntent,
  type MacroIntent, type MacroObservation, type MacroReceipt,
} from "../src/server/survival-macro/protocol.ts";
import type {
  MacroSkillTrialAttestation, MacroSkillTrialBinding, SurvivalMacroSkills,
} from "../src/server/survival-macro/skills.ts";
import {
  MACRO_TRIAL_SETTLE_TICKS as SETTLE_TICKS, macroTrialAtTarget, macroTrialDistance, macroTrialTurn, macroTrialWitnessDigest,
  verifyMacroTrialMotion, verifyMacroTrialWitness, type MacroTrialMotion, type MacroTrialWitness,
} from "../src/server/survival-macro/trial-witness.ts";
import { readSavedPlayerStats } from "./verify.ts";

export const MACRO_TRIAL_GOAL = "wooden_pickaxe";
export const MACRO_TRIAL_SECONDS = 140;
export const MACRO_TRIAL_ADAPTER_VERSION = "survival-agent-native-trial/v2";
export const MACRO_TRIAL_VERBS = ["inspect", "survey"] as const;
const MAX_ATTEMPTS = 2;
const ROOT = path.resolve(import.meta.dir, "..");
const LOCAL = path.join(ROOT, "local/survival-agent");
const ACTOR = "client/native-client/mods/survival-agent.jar";
const DIGEST = /^[0-9a-f]{64}$/;
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-wooden_pickaxe-[0-9a-f]{12}$/;
const ORDINARY_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-z_]+-[0-9A-Za-z]{6}$/;
const VERBS = new Set<string>(MACRO_TRIAL_VERBS);
const OTHER_EFFECT = /^(?:minecraft:)?(?:used|broken|mined|picked_up|dropped|crafted|killed|killed_by)$/;
const DISALLOWED_CUSTOM = /(?:^|:)(?:damage_.+|jumps?|deaths|fall_one_cm|sprint_one_cm|swim_one_cm|fly_one_cm|climb_one_cm|boat_one_cm|interact_with_.+|open_.+|trigger_trapped_chest|drop|eat_cake_slice|target_hit)$/;
const trialSpawn = [0.5, 64, 0.5] as const;
const MAX_ACTION_TICKS = 70;
const OBSERVATION_WINDOW_TICKS = 100;

type TrialResult = { status: "passed"; detail: string; verb: string } |
  { status: "failed" | "abstained"; detail: string };
type TrialSkills = Pick<SurvivalMacroSkills, "beginTrial" | "probeTrial" | "bindTrialIntent" | "bindTrialWitness" | "quarantine">;
export type MacroTrialRunner = {
  run(hash: string, skills: TrialSkills, signal: AbortSignal): Promise<TrialResult>;
  readTrial(binding: MacroSkillTrialBinding): MacroSkillTrialAttestation | null;
  assertDrained(): void;
};

export class MacroTrialCleanupError extends Error {
  override readonly name = "MacroTrialCleanupError";

  constructor(readonly run: string) {
    super(`Diagnostic trial ${run} could not confirm that its owned processes and reservation drained.`);
  }
}

export type MacroTrialLaunch = { run: string; ordinaryDir: string; actorJarSha256: string };

// The child is a trusted copy of the existing owner. No candidate source or
// model output enters the child, and only the parent can issue one intent.
export function parseMacroTrialLaunch(args: string[], ordinaryRuns: string): MacroTrialLaunch {
  const [run, from, actorJarSha256] = args;
  if (args.length !== 3 || !run || !RUN_ID.test(run) || !from || !ORDINARY_ID.test(from) ||
      !actorJarSha256 || !DIGEST.test(actorJarSha256)) {
    throw new Error("Invalid internal macro trial launch.");
  }
  return { run, ordinaryDir: path.join(ordinaryRuns, from), actorJarSha256 };
}

export function macroTrialActor(runDir: string) {
  return path.join(runDir, ACTOR);
}

const ownerFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner"), pid: z.int().positive(), run: z.string() }),
  z.object({ kind: z.literal("released"), run: z.string() }),
  z.object({ kind: z.literal("staged"), run: z.string(), actorJarSha256: z.string().regex(DIGEST) }),
  z.object({
    kind: z.literal("owned"), run: z.string(), pid: z.int().positive(),
    displayRole: z.enum(["client", "server", "recorder"]),
  }),
  z.object({
    kind: z.literal("closed"), run: z.string(), actorJarSha256: z.string().regex(DIGEST),
    serverSaved: z.boolean(), deaths: z.int().nonnegative(), drained: z.boolean(), recordingClosed: z.boolean(),
    lifeEvidenceReadable: z.boolean(), finalTick: z.int().nonnegative(), life: z.int().nonnegative(),
    status: z.string(),
  }),
]);
type OwnerFrame = z.infer<typeof ownerFrame>;

export function reportMacroTrial(frame: OwnerFrame) {
  // FD 3 is inherited only by the trusted diagnostic runner. Java, ffmpeg and
  // the sandbox do not inherit it. A same-path JSON file cannot issue frames.
  const data = `${JSON.stringify(frame)}\n`;
  if (writeSync(3, data) !== Buffer.byteLength(data)) throw new Error("Macro trial owner pipe write failed.");
}

export function watchMacroTrialOwner(run: string, stop: (sealed: boolean) => void) {
  reportMacroTrial({ kind: "owner", pid: process.pid, run });
  let command = "";
  let ended = false;
  const finish = (sealed: boolean) => {
    if (ended) return;
    ended = true;
    process.stdin.pause();
    stop(sealed);
  };
  const onData = (bytes: Buffer) => {
    command += bytes.toString("utf8");
    if (command.length > 5 || command.includes("\n")) finish(command === "seal\n");
  };
  const onEnd = () => finish(false);
  process.stdin.on("data", onData);
  process.stdin.once("end", onEnd);
  process.stdin.once("error", onEnd);
  return () => {
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    process.stdin.off("error", onEnd);
    process.stdin.pause();
  };
}

const poseSchema = z.object({
  alive: z.literal(true), tick: z.int().nonnegative(), life: z.int().nonnegative(),
  x: z.number(), y: z.number(), z: z.number(), yaw: z.number(), pitch: z.number(),
  health: z.number(), dimension: z.literal("minecraft:overworld"),
  inventory: z.record(z.string(), z.int().nonnegative()), gui: z.literal(false),
  macro_grounded: z.literal(true), macro_neutral: z.literal(true),
  macro_cursor_clear: z.literal(true), macro_hazard_clear: z.literal(true),
  macro_trial: z.literal(true), macro_fallback_ticks: z.literal(0),
});
type Pose = z.infer<typeof poseSchema>;

async function readBounded(file: string, limit: number): Promise<string | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const meta = await handle.stat();
    if (!meta.isFile() || meta.uid !== process.getuid?.() || meta.nlink !== 1 || meta.size > limit)
      throw new Error("Unexpected macro trial evidence file.");
    const buffer = Buffer.allocUnsafe(meta.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error("Macro trial evidence changed during the read.");
      offset += bytesRead;
    }
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readPose(dir: string) {
  const text = await readBounded(path.join(dir, "progress.json"), 64_000);
  if (!text) return null;
  const value = JSON.parse(text);
  if (value?.macro_trial !== true || value.macro_fallback_ticks !== 0)
    throw new Error("Native progress did not prove exclusive diagnostic ownership without deterministic fallback.");
  return poseSchema.safeParse(value).data ?? null;
}

async function verifyReceiptJournal(macro: string, intent: MacroIntent, completed: MacroReceipt) {
  const text = await readBounded(path.join(macro, "native-receipts.jsonl"), 16_384);
  if (!text?.endsWith("\n")) throw new Error("Missing complete native diagnostic receipt journal.");
  const receipts = text.slice(0, -1).split("\n").map(line => parseMacroReceipt(JSON.parse(line)));
  const [accepted, terminal] = receipts;
  if (receipts.length !== 2 || accepted?.status !== "accepted" || !terminal || terminal.status !== "completed" ||
      receipts.some(receipt => receipt.id !== intent.id || receipt.run !== intent.run || receipt.life !== intent.life) ||
      accepted.tick < intent.basisTick || accepted.tick > terminal.tick || terminal.tick !== completed.tick ||
      terminal.detail !== completed.detail)
    throw new Error("Native transition history did not record exactly one accepted and completed diagnostic intent.");
  return [accepted, terminal] as const;
}

function clean(obs: MacroObservation) {
  return obs.health === 20 && obs.food === 20 && Object.keys(obs.inventory).length === 0 &&
    obs.goal === MACRO_TRIAL_GOAL;
}

function safePose(pose: Pose, observation: MacroObservation) {
  return pose.life === observation.life && pose.health === 20 && Object.keys(pose.inventory).length === 0 &&
    Math.abs(pose.y - trialSpawn[1]) <= 0.05 &&
    Math.hypot(pose.x - trialSpawn[0], pose.z - trialSpawn[2]) <= 2.25;
}

function initialPose(pose: Pose, observation: MacroObservation) {
  return safePose(pose, observation) &&
    Math.hypot(pose.x - trialSpawn[0], pose.z - trialSpawn[2]) <= 0.1;
}

async function verifyEffect(dir: string, witness: MacroTrialWitness, receiptTick: number, before: Pose, after: Pose) {
  const movement = await readBounded(path.join(dir, "movement.tsv"), 4_000_000);
  if (!movement) throw new Error("No native movement evidence was retained.");
  const [header, ...rows] = movement.slice(0, movement.lastIndexOf("\n")).split("\n");
  if (header !== "tick\twall_ms\tx\ty\tz\tyaw\tpitch\tgrounded\tsprinting\tfood\tgui\tactivity")
    throw new Error("Unexpected native movement evidence format.");
  const samples: MacroTrialMotion[] = [];
  for (const row of rows) {
    const fields = row.split("\t");
    if (fields.length !== 12) throw new Error("Incomplete native movement sample.");
    const tick = Number(fields[0]), x = Number(fields[2]), y = Number(fields[3]), z = Number(fields[4]);
    const yaw = Number(fields[5]), pitch = Number(fields[6]);
    if (!Number.isSafeInteger(tick) || ![x, y, z, yaw, pitch].every(Number.isFinite))
      throw new Error("Invalid native movement sample.");
    if (tick > after.tick) break;
    if (tick < before.tick) continue;
    const displacement = Math.hypot(x - before.x, z - before.z);
    if (fields[7] !== "true" || fields[8] !== "false" || fields[9] !== "20" || fields[10] !== "false" ||
        Math.abs(y - trialSpawn[1]) > 0.05 || displacement > (witness.verb === "approach" ? 2.25 : 0.12))
      throw new Error("The actor left the prepared action's safety envelope.");
    samples.push({ tick, x, y, z, yaw, pitch });
  }
  const { movement: distance, turn: angle } = verifyMacroTrialMotion(witness, receiptTick, before, after, samples);
  const saved = await readSavedPlayerStats(path.join(dir, "server/world/stats"));
  if (!saved) throw new Error("The diagnostic server produced no saved player statistics.");
  for (const [category, items] of Object.entries(saved.stats)) {
    for (const [counter, value] of Object.entries(items)) {
      if (value > 0 && (OTHER_EFFECT.test(category) ||
          (category === "minecraft:custom" && DISALLOWED_CUSTOM.test(counter)))) {
        throw new Error(`Unwanted vanilla survival effect: ${category}/${counter}.`);
      }
    }
  }
  const walkCm = saved.stats["minecraft:custom"]?.["minecraft:walk_one_cm"] ?? 0;
  if (witness.verb === "approach" ? walkCm < 45 || walkCm > 250 || walkCm / 100 + 0.18 < distance : walkCm > 12) {
    throw new Error("Saved vanilla walking did not match the witnessed effect.");
  }
  return { before, after, sampleCount: samples.length, distance, angle, walkCm, savedStatsFile: saved.file };
}

async function immutableRecord(dir: string, name: string, record: object) {
  const text = `${JSON.stringify(record)}\n`;
  const file = await open(path.join(dir, name), "wx", 0o400);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  return createHash("sha256").update(text).digest("hex");
}

function startOwner(launch: MacroTrialLaunch) {
  const child = spawn("xvfb-run", ["-a", "-n", "180", "-s", "-screen 0 1280x720x24 -nolisten tcp",
    process.execPath, path.join(import.meta.dir, "run.ts"), "--diagnostic-macro-trial",
    launch.run, path.basename(launch.ordinaryDir), launch.actorJarSha256,
  ], { cwd: ROOT, detached: true, stdio: ["pipe", "ignore", "ignore", "pipe"] });
  let error: string | undefined;
  const identify = (pid: number | undefined) => {
    if (!pid) return null;
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), started: fields[19] };
    } catch { return null; }
  };
  type Identity = NonNullable<ReturnType<typeof identify>>;
  let owner: Identity | undefined;
  const owned = new Map<string, Identity>();
  let staged = false;
  let released = false;
  let closed: Extract<OwnerFrame, { kind: "closed" }> | undefined;
  let exit: number | null | undefined;
  let pending = "";
  let signalFailed = false;
  child.stdin?.on("error", () => {});
  child.on("error", () => { error = "Could not launch the owned isolated diagnostic display."; });
  const finished = new Promise<void>((resolve) => {
    child.once("close", (code) => { exit = code; resolve(); });
  });
  child.stdio[3]?.on("data", (chunk: Buffer) => {
    if (error) return;
    pending += chunk.toString("utf8");
    if (pending.length > 4_096) {
      error = "Oversize diagnostic owner response.";
      return;
    }
    for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const frame = ownerFrame.parse(JSON.parse(line));
        if (frame.run !== launch.run || ("actorJarSha256" in frame && frame.actorJarSha256 !== launch.actorJarSha256))
          throw new Error("Mismatched diagnostic identity.");
        if (frame.kind === "owner" && !owner) {
          const process = identify(frame.pid);
          if (!process || process.parent !== child.pid || process.group !== child.pid)
            throw new Error("Unexpected diagnostic runner process identity.");
          owner = process;
        } else if (frame.kind === "released" && owner && !released) released = true;
        else if (frame.kind === "staged" && owner && !staged && !released) staged = true;
        else if (frame.kind === "owned" && staged && owner && !closed && !released && !owned.has(frame.displayRole)) {
          const process = identify(frame.pid);
          if (process && (process.parent !== owner.pid || process.group !== frame.pid))
            throw new Error("Unexpected diagnostic process group.");
          if (process) owned.set(frame.displayRole, process);
        } else if (frame.kind === "closed" && staged && !closed && !released) closed = frame;
        else throw new Error("Unexpected diagnostic owner frame order.");
      } catch {
        error = "Invalid diagnostic owner response.";
        return;
      }
    }
  });
  child.stdio[3]?.on("error", () => { error = "Diagnostic owner pipe failed."; });
  const signalPid = (pid: number | undefined, signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try { process.kill(pid, signal); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") signalFailed = true; }
  };
  const remains = (initial: Identity) => {
    const current = identify(initial.pid);
    return !!current && current.state !== "Z" && current.state !== "X" &&
      current.started === initial.started && current.group === initial.group;
  };
  const wait = async (ms: number) => {
    const timer = new AbortController();
    try { await Promise.race([finished, delay(ms, undefined, { signal: timer.signal })]); }
    finally { timer.abort(); }
  };
  return {
    get ready() { return staged; },
    running() {
      if (error) throw new Error(error);
      if (exit !== undefined) throw new Error("Diagnostic runner exited or the diagnostic lane was unavailable.");
    },
    async stop(seal: boolean) {
      child.stdin?.end(seal ? "seal\n" : undefined);
      // The ordinary server owner can spend 60s on a progressing vanilla save.
      await wait(owner ? 70_000 : 10_000);
      if (exit === undefined) {
        if (owner && remains(owner)) signalPid(owner.pid, "SIGTERM");
        else if (child.pid !== undefined) signalPid(-child.pid, "SIGTERM");
        await wait(5_000);
      }
      if (exit === undefined) {
        signalPid(child.pid === undefined ? undefined : -child.pid, "SIGKILL");
        await wait(2_000);
      }
      // A crashed owner cannot reap its detached writers. Only signal groups
      // it registered while they were its children and whose identity still matches.
      if (!closed?.drained) {
        const remaining = [...owned.values()].filter(remains);
        for (const process of remaining) signalPid(-process.group, "SIGTERM");
        if (remaining.length) await delay(2_000);
        let killed = false;
        for (const process of remaining) {
          if (remains(process)) {
            signalPid(-process.group, "SIGKILL");
            killed = true;
          }
        }
        if (killed) await delay(250);
      }
      const frame = error || pending ? null : closed ?? null;
      const remaining = [...owned].filter(([, process]) => remains(process)).map(([role]) => role);
      const exited = exit !== undefined;
      // Once the owner has started it acknowledges reservation release even if
      // it never admitted a world. Evicting all PIDs alone does not release it.
      const ownerClosed = owner ? released && (!staged || frame?.drained === true) :
        (child.pid === undefined || (!error && typeof exit === "number" && exit >= 0 && exit < 128));
      const cleanupConfirmed = exited && !signalFailed && !remaining.length &&
        !pending && (!owner || !remains(owner)) && ownerClosed;
      return { exitCode: exit ?? null, exited, frame, remaining, cleanupConfirmed };
    },
  };
}

function sameBinding(a: MacroSkillTrialBinding, b: MacroSkillTrialBinding) {
  return a.skillHash === b.skillHash && a.parentGeneration === b.parentGeneration && a.parentHash === b.parentHash &&
    a.capabilityVersion === b.capabilityVersion && a.adapterVersion === b.adapterVersion &&
    a.actorJarSha256 === b.actorJarSha256 && a.worldId === b.worldId &&
    a.verbs.length === b.verbs.length && a.verbs.every((verb, index) => verb === b.verbs[index]);
}

/** Audit records are never read as authority. Only this live parent can attest to the trial it owned. */
export function createMacroTrials({ ordinaryDir, actorJarSha256 }: {
  ordinaryDir: string; actorJarSha256: string;
}): MacroTrialRunner {
  if (path.dirname(ordinaryDir) !== path.join(LOCAL, "runs") ||
      !ORDINARY_ID.test(path.basename(ordinaryDir)) || !DIGEST.test(actorJarSha256))
    throw new Error("Macro trial requires the mounted ordinary actor run and immutable artifact identity.");
  const attempted = new Set<string>();
  const attestations = new Map<string, MacroSkillTrialAttestation>();
  let running = false;
  let cleanupFault: MacroTrialCleanupError | undefined;
  return {
    assertDrained() {
      if (cleanupFault) throw cleanupFault;
      if (running) throw new Error("A diagnostic macro trial is still running.");
    },
    readTrial(binding) {
      if (cleanupFault) return null;
      const proof = attestations.get(binding.skillHash);
      return proof && sameBinding(proof, binding) ? proof : null;
    },
    async run(hash, skills, callerSignal) {
      if (cleanupFault) throw cleanupFault;
      if (running || attempted.size >= MAX_ATTEMPTS || attempted.has(hash))
        return { status: "abstained", detail: "The bounded diagnostic attempt slot is unavailable." };
      callerSignal.throwIfAborted();
      running = true;
      attempted.add(hash);
      const run = `${new Date().toISOString().replaceAll(":", "-")}-${MACRO_TRIAL_GOAL}-${randomBytes(6).toString("hex")}`;
      const dir = path.join(LOCAL, "diagnostic-runs", run);
      const macro = path.join(dir, "macro");
      const journal = path.join(ordinaryDir, "macro-trials", run);
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(MACRO_TRIAL_SECONDS * 1_000)]);
      let owner: ReturnType<typeof startOwner> | undefined;
      let shutdown: Awaited<ReturnType<ReturnType<typeof startOwner>["stop"]>> | undefined;
      let binding: MacroSkillTrialBinding | undefined;
      let journalReady = false;
      let result: TrialResult = { status: "failed", detail: "Diagnostic did not close with an observed effect." };
      try {
        await mkdir(path.dirname(journal), { mode: 0o700, recursive: true });
        await mkdir(journal, { mode: 0o700 });
        journalReady = true;
        binding = skills.beginTrial(hash, run);
        await immutableRecord(journal, "01-admission.json", {
          at: new Date().toISOString(), binding, source: "prepared-flat-reader-walk-v1", ordinaryRun: path.basename(ordinaryDir),
          limits: { attemptsPerRun: MAX_ATTEMPTS, seconds: MACRO_TRIAL_SECONDS, maximumIntents: 1 },
        });
        if (binding.actorJarSha256 !== actorJarSha256 || binding.capabilityVersion !== MACRO_CAPABILITIES_VERSION ||
            binding.adapterVersion !== MACRO_TRIAL_ADAPTER_VERSION || !binding.verbs.length ||
            binding.verbs.some(verb => !VERBS.has(verb))) {
          result = { status: "abstained", detail: "No independent in-game evaluator for this primitive set or actor jar." };
          return result;
        }
        const scopedVerbs = new Set(binding.verbs);
        owner = startOwner({ run, ordinaryDir, actorJarSha256 });
        let intent: MacroIntent | undefined;
        let receipt: MacroReceipt | undefined;
        let before: Pose | undefined;
        let after: Pose | undefined;
        let chosen: MacroObservation["opportunities"][number] | undefined;
        let targetSnapshot: string | undefined;
        const witnessFile = path.join(macro, "trial-witness.json");
        let firstObservationTick: number | undefined;
        while (!signal.aborted) {
          owner.running();
          const observation = owner.ready ? await readMacroObservation(macro) : null;
          if (!observation) {
            await delay(175, undefined, { signal });
            continue;
          }
          if (observation.run !== run || !clean(observation))
            throw new Error("Diagnostic lost its authorized clean survival premise.");
          firstObservationTick ??= observation.tick;
          if (!intent && observation.tick - firstObservationTick > OBSERVATION_WINDOW_TICKS) {
            result = { status: "abstained", detail: "No compatible witnessed action became safely available in the prepared trial." };
            return result;
          }
          const pose = await readPose(dir);
          if (!intent && observation.quiescent && pose && initialPose(pose, observation) &&
              observation.opportunities.some(o => scopedVerbs.has(o.verb) && o.risk !== "guarded")) {
            const choice = await skills.probeTrial(hash, observation, signal);
            signal.throwIfAborted();
            const picked = observation.opportunities.find(o => o.id === choice?.opportunityId);
            if (!choice || choice.skillHash !== hash || !picked || !scopedVerbs.has(picked.verb) ||
                !VERBS.has(picked.verb) || picked.risk === "guarded") {
              result = { status: "abstained", detail: "Candidate did not select an independently testable witnessed action." };
              return result;
            }
            const latestPose = await readPose(dir);
            const fresh = await readMacroObservation(macro);
            if (!fresh?.quiescent || !latestPose || fresh.run !== run || !clean(fresh) ||
                fresh.life !== observation.life || fresh.epoch !== observation.epoch ||
                fresh.tick < latestPose.tick || fresh.tick - latestPose.tick > 25 ||
                !initialPose(latestPose, fresh) || !fresh.opportunities.some(o =>
                  o.id === picked.id && o.verb === picked.verb && o.risk === picked.risk && o.evidence === picked.evidence)) {
              result = { status: "abstained", detail: "The trial witness changed during isolated evaluation." };
              return result;
            }
            before = latestPose;
            chosen = picked;
            intent = { v: 1, id: randomUUID(), run, life: fresh.life, epoch: fresh.epoch, basisTick: fresh.tick,
              expiresTick: fresh.tick + MAX_ACTION_TICKS, opportunityId: picked.id, skillHash: hash };
            await immutableRecord(journal, "02-intent.json", { intent, witness: picked, before });
            signal.throwIfAborted();
            if (!skills.bindTrialIntent(hash, intent, fresh))
              throw new Error("The observed diagnostic offer no longer matches the candidate's reserved intent.");
            await writeMacroIntent(macro, intent);
          } else if (intent) {
            if (observation.life !== intent.life) throw new Error("The diagnostic lost its original life.");
            const observed = await readMacroReceipt(macro);
            if (observed && (observed.id !== intent.id || observed.run !== run || observed.life !== intent.life ||
                observed.tick < intent.basisTick || observed.tick > intent.expiresTick))
              throw new Error("Diagnostic received a stale or unrelated action receipt.");
            if (observed && (observed.status === "accepted" || observed.status === "completed") && !targetSnapshot) {
              targetSnapshot = await readBounded(witnessFile, 4_096) ?? undefined;
              if (!targetSnapshot) throw new Error("The native receipt had no immutable evaluator target witness.");
            }
            if (observed && observed.status !== "accepted" && !receipt) {
              receipt = observed;
              await immutableRecord(journal, "03-receipt.json", { receipt });
              if (receipt.status !== "completed")
                throw new Error(`Native diagnostic action ${receipt.status}: ${receipt.detail}`);
            }
            if (receipt && observation.quiescent && pose && safePose(pose, observation) &&
                pose.tick >= receipt.tick + SETTLE_TICKS && observation.tick >= pose.tick) {
              after = pose;
              break;
            }
            if (observation.tick > intent.expiresTick + SETTLE_TICKS * 3)
              throw new Error("The diagnostic action or its safe settlement expired.");
          }
          await delay(175, undefined, { signal });
        }
        signal.throwIfAborted();
        if (!intent || !receipt || !before || !after || !chosen || !targetSnapshot)
          throw new Error("Incomplete diagnostic evidence.");
        shutdown = await owner.stop(true);
        owner = undefined;
        const closure = shutdown.frame;
        if (!shutdown.cleanupConfirmed || shutdown.exitCode !== 0 || !closure || closure.status !== "trial_closed" ||
            !closure.drained || !closure.serverSaved || !closure.recordingClosed || !closure.lifeEvidenceReadable ||
            closure.deaths !== 0 || closure.life !== intent.life || closure.finalTick < after.tick)
          throw new Error("Diagnostic owner did not furnish a clean saved shutdown.");
        const finalPose = await readPose(dir);
        if (!finalPose || finalPose.tick !== closure.finalTick || finalPose.life !== intent.life ||
            finalPose.health !== after.health || Object.keys(finalPose.inventory).length !== 0 ||
            macroTrialDistance(finalPose, after) > 0.12 || macroTrialTurn(after, finalPose) > 3)
          throw new Error("The observed effect did not survive a safe diagnostic shutdown.");
        const receipts = await verifyReceiptJournal(macro, intent, receipt);
        if (targetSnapshot !== await readBounded(witnessFile, 4_096))
          throw new Error("The accepted target witness changed after issuance.");
        const witness = verifyMacroTrialWitness(JSON.parse(targetSnapshot), intent, chosen.verb, ...receipts);
        if (!macroTrialAtTarget(finalPose, witness.target))
          throw new Error("The actor did not retain the exact witnessed target through diagnostic shutdown.");
        const effect = await verifyEffect(dir, witness, receipt.tick, before, after);
        const targetDigest = macroTrialWitnessDigest(witness);
        const digest = await immutableRecord(journal, "04-closed.json", {
          closure, receipts, witness, targetDigest, effect, finalPose,
        });
        signal.throwIfAborted();
        if (!skills.bindTrialWitness(hash, witness, receipts[1]))
          throw new Error("The verified native target could not be bound to the reserved candidate intent.");
        attestations.set(hash, Object.freeze({
          ...binding, verbs: Object.freeze([...binding.verbs]), run, life: intent.life, intentId: intent.id,
          opportunityId: intent.opportunityId, verb: chosen.verb, risk: chosen.risk, evidence: chosen.evidence,
          epoch: intent.epoch, basisTick: intent.basisTick, acceptedTick: witness.acceptedTick,
          target: witness.target, targetDigest, receiptTick: receipt.tick, effectRef: `sha256:${digest}`,
        }));
        result = { status: "passed", verb: chosen.verb,
          detail: `Observed and verified the completed ${chosen.verb} effect on its exact target after diagnostic closure.` };
        return result;
      } catch (error) {
        result = { status: "failed", detail: signal.aborted ? "Diagnostic was cancelled or reached its wall limit." :
          error instanceof Error ? error.message : "Unknown diagnostic failure." };
        return result;
      } finally {
        let drainFault: MacroTrialCleanupError | undefined;
        try {
          let drainErrored = false;
          if (owner) {
            try { shutdown = await owner.stop(false); }
            catch { drainErrored = true; }
          }
          if (drainErrored || (shutdown && !shutdown.cleanupConfirmed)) {
            drainFault = cleanupFault ??= new MacroTrialCleanupError(run);
          }
          if (result.status !== "passed" && journalReady) {
            await immutableRecord(journal, "05-closed-without-proof.json", {
              result: drainFault ? { status: "cleanup_failed", detail: drainFault.message } : result,
              shutdown: shutdown ?? null,
            });
          }
        } finally {
          try {
            if (binding && result.status !== "passed") skills.quarantine(hash, drainFault?.message ?? result.detail);
          } finally {
            running = false;
            if (drainFault) throw drainFault;
          }
        }
      }
    },
  };
}
