import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const LIFE_RECEIPTS = "lives.jsonl";
export const RESPAWN_MARKER = "allow-vanilla-respawn";
export const RESPAWN_TIMEOUT_MS = 15_000;
export const FAST_DEATH_WINDOW_MS = 300_000;
export const FAST_DEATH_LIMIT = 3;
const SUMMARY_LIMIT = 32;
const READ_BYTES = 16_384;
const RECOVERY_SUPPLIES = new Set(["logs", "planks", "sticks", "buildingStone", "coal", "torches", "prospectingBlocks"]);

type Phase = "playing" | "death_screen" | "respawn_requested";
type Sample = { tick: number; alive: boolean; wall_ms?: number; initial_death_screen?: boolean };
type Frame = Sample & { deaths: number; respawns: number; life: number; life_phase: Phase };
type Stamp = { tick: number; wall_ms: number | null; source: "lives.jsonl" | "progress.json" };
type Death = { life: number; death: Stamp | null; requested: Stamp | null; observed: Stamp | null };
type DeathTime = { observedAt: number; wall_ms?: number };
type ParentDeath = { parentRun: string; parentLife: number; parentTick: number; parentSavedDeaths: number };

const validCount = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) && value >= 0;
const phaseOrder = { playing: 0, death_screen: 1, respawn_requested: 2 } as const;
const order = (a: Frame, b: Frame) => a.respawns - b.respawns || phaseOrder[a.life_phase] - phaseOrder[b.life_phase];

function decode(sample: Sample): Frame | null {
  const { tick, wall_ms, alive, deaths, respawns, life, life_phase } = sample as Partial<Frame>;
  if (!validCount(tick) || !tick || typeof alive !== "boolean" ||
      (wall_ms !== undefined && !validCount(wall_ms))) throw new Error("Invalid agent lifecycle sample.");
  if ([deaths, respawns, life, life_phase].every(value => value === undefined)) return null;
  if (!validCount(deaths) || !validCount(respawns) || !validCount(life) || deaths > tick ||
      life !== respawns + 1 || deaths !== respawns + (life_phase === "playing" ? 0 : 1) ||
      !(life_phase === "playing" && alive || life_phase === "death_screen" ||
        life_phase === "respawn_requested")) {
    throw new Error("Invalid agent life phase or counters.");
  }
  return { tick, wall_ms, alive, deaths, respawns, life, life_phase };
}

/** Call only for a validated closed ordinary parent. A status label alone does not prove a saved death. */
export function closedParentDeath(parentRun: string, outcome: unknown): ParentDeath | null {
  const { progress, lifecycle } = (outcome ?? {}) as {
    progress?: Frame & { health?: number; gui?: boolean };
    lifecycle?: {
      evidenceReadable?: boolean;
      lastDeath?: Death | null;
      inheritedDeath?: { receipt?: Death | null };
      savedDeaths?: { after?: number; agreesWithObserved?: boolean };
    };
  };
  if (!progress || progress.alive !== false || progress.life_phase !== "death_screen" ||
      progress.gui !== true || progress.health !== 0 || lifecycle?.evidenceReadable !== true) return null;
  const last = lifecycle.lastDeath ?? lifecycle.inheritedDeath?.receipt;
  const death = last?.death;
  const saved = lifecycle.savedDeaths;
  if (!validCount(progress.life) || !progress.life || !validCount(progress.tick) ||
      progress.deaths !== progress.life || progress.respawns !== progress.life - 1 ||
      !last || last.life !== progress.life || last.requested !== null || last.observed !== null ||
      !death || death.source !== LIFE_RECEIPTS || !validCount(death.tick) || !death.tick || death.tick > progress.tick ||
      !validCount(progress.wall_ms) || !validCount(death.wall_ms) || death.wall_ms > progress.wall_ms ||
      !validCount(saved?.after) || !saved.after || saved.agreesWithObserved !== true) return null;
  return { parentRun, parentLife: progress.life, parentTick: death.tick, parentSavedDeaths: saved.after };
}

/** Dedicated transition receipts fill the gaps between independently sampled progress files. */
export class LifeLedger {
  private latest: Frame | null = null;
  private lastReceipt: Frame | null = null;
  private lastSnapshotTick = 0;
  private protocol: "counters" | "legacy-strict" | null = null;
  private pendingSince: number | null = null;
  private parentDeath: ParentDeath | null = null;
  private inherited = false;
  private readonly recentDeaths: DeathTime[] = [];
  private readonly details = new Map<number, Death>();

  constructor(private readonly allowRespawn: boolean) {}

  expectInheritedDeath(proof: ParentDeath, copied: { savedDeaths: number; matchesProfile: boolean }) {
    if (this.allowRespawn && !this.protocol && copied.matchesProfile && copied.savedDeaths === proof.parentSavedDeaths)
      this.parentDeath = proof;
  }

  private useProtocol(protocol: NonNullable<LifeLedger["protocol"]>) {
    if (this.protocol && this.protocol !== protocol) throw new Error("Agent lifecycle protocol changed during an attempt.");
    this.protocol = protocol;
  }

  snapshot(sample: Sample, now: number) {
    const decoded = decode(sample);
    this.useProtocol(decoded ? "counters" : "legacy-strict");
    if (sample.tick < this.lastSnapshotTick) throw new Error("Agent progress tick decreased.");
    this.lastSnapshotTick = sample.tick;
    const frame: Frame = decoded ?? {
      ...sample, deaths: sample.alive ? 0 : 1, respawns: 0, life: 1,
      life_phase: sample.alive ? "playing" : "death_screen",
    };
    this.update(frame, now);
    this.store(frame, "progress.json");
  }

  receipt(sample: Sample, now: number) {
    const frame = decode(sample);
    if (!frame || frame.wall_ms === undefined || !frame.deaths || frame.life_phase === "death_screen" && frame.alive ||
        (this.lastReceipt && (frame.tick < this.lastReceipt.tick || order(frame, this.lastReceipt) <= 0))) {
      throw new Error("Invalid or out-of-order agent life receipt.");
    }
    this.useProtocol("counters");
    if (this.parentDeath && !this.lastReceipt && sample.initial_death_screen === true &&
        frame.tick === 1 && frame.deaths === 1 && frame.life_phase === "death_screen" &&
        (!this.latest || this.latest.tick === 1 && this.latest.deaths === 1 &&
          this.latest.life_phase === "death_screen")) {
      this.inherited = true;
      // An atomic progress read may have seen the same death before its receipt was read.
      this.recentDeaths.length = 0;
    }
    this.update(frame, now);
    this.store(frame, LIFE_RECEIPTS);
    this.lastReceipt = frame;
  }

  private update(frame: Frame, now: number) {
    const previous = this.latest;
    if (previous) {
      // The receipt stream and atomic snapshot can race in either direction.
      const sequence = order(frame, previous);
      if (frame.tick < previous.tick || frame.tick === previous.tick && sequence < 0) {
        if (sequence <= 0) return;
        throw new Error("Agent life counters disagree with the tick sequence.");
      }
      if (sequence < 0) throw new Error("Agent life counters decreased.");
    }
    const priorDeaths = Math.max(previous?.deaths ?? 0, Number(this.inherited));
    const newDeaths = Math.min(frame.deaths - priorDeaths, FAST_DEATH_LIMIT);
    for (let i = 0; i < newDeaths; i++) {
      this.recentDeaths.push({ observedAt: now, wall_ms: frame.life_phase === "death_screen" &&
        i === newDeaths - 1 ? frame.wall_ms : undefined });
    }
    if (this.recentDeaths.length > FAST_DEATH_LIMIT) {
      this.recentDeaths.splice(0, this.recentDeaths.length - FAST_DEATH_LIMIT);
    }
    if (frame.life_phase === "playing") this.pendingSince = null;
    else if (newDeaths || this.pendingSince === null) this.pendingSince = now;
    this.latest = frame;
  }

  private store(frame: Frame, source: Stamp["source"]) {
    if (!frame.deaths || frame.life_phase === "death_screen" && frame.alive) return;
    const life = frame.deaths;
    // Keep outcome receipts bounded. The actor's append-only file is the complete sequence.
    if (!this.details.has(life) && this.details.size >= SUMMARY_LIMIT) {
      let oldest = Infinity;
      const firstNewLife = this.inherited ? 2 : 1;
      for (const id of this.details.keys()) if (id > firstNewLife) oldest = Math.min(oldest, id);
      if (life > firstNewLife && life < oldest) return;
      this.details.delete(oldest);
    }
    const record = this.details.get(life) ?? { life, death: null, requested: null, observed: null };
    const key = frame.life_phase === "death_screen" ? "death" :
      frame.life_phase === "respawn_requested" ? "requested" : "observed";
    const prior = record[key];
    if (!prior || source === LIFE_RECEIPTS && prior.source !== LIFE_RECEIPTS) {
      record[key] = { tick: frame.tick, wall_ms: frame.wall_ms ?? null, source };
    }
    this.details.set(life, record);
  }

  milestone(newHighWater: readonly string[]) {
    if (newHighWater.some(name => !RECOVERY_SUPPLIES.has(name))) this.recentDeaths.length = 0;
  }

  get deaths() { return (this.latest?.deaths ?? 0) - Number(this.inherited); }
  get life() { return this.latest?.life ?? null; }

  currentPlaying(sample: Sample) {
    const frame = this.latest;
    const candidateLife = (sample as Partial<Frame>).life ?? 1;
    return frame?.life_phase === "playing" && sample.alive &&
      ((sample as Partial<Frame>).life_phase ?? "playing") === "playing" &&
      frame.life === candidateLife && sample.tick >= frame.tick;
  }

  stop(now: number) {
    if (this.deaths && (!this.allowRespawn || this.protocol === "legacy-strict")) {
      return { status: "died", reason: "The agent died in a no-death attempt." } as const;
    }
    if (this.recentDeaths.length === FAST_DEATH_LIMIT) {
      const first = this.recentDeaths[0]!, last = this.recentDeaths[FAST_DEATH_LIMIT - 1]!;
      const span = first.wall_ms !== undefined && last.wall_ms !== undefined && last.wall_ms >= first.wall_ms
        ? last.wall_ms - first.wall_ms : last.observedAt - first.observedAt;
      if (span <= FAST_DEATH_WINDOW_MS) {
        return { status: "died", reason: "The agent died three times within five minutes without a new goal milestone." } as const;
      }
    }
    if (this.pendingSince !== null && now - this.pendingSince >= RESPAWN_TIMEOUT_MS) {
      return { status: "respawn_timeout", reason: "Vanilla respawn did not return a live player within 15 seconds." } as const;
    }
    return null;
  }

  summary() {
    const rows = [...this.details.values()].sort((a, b) => a.life - b.life);
    const nativeDeaths = this.latest?.deaths ?? 0;
    const respawns = this.latest?.respawns ?? 0;
    const firstNewLife = this.inherited ? 2 : 1;
    const deathReceipts = rows.filter(row => row.life >= firstNewLife &&
      (row.death || row.requested || row.observed?.source === LIFE_RECEIPTS));
    const inheritedDeath = this.inherited ? this.details.get(1) : null;
    return {
      protocol: this.protocol,
      deaths: this.deaths,
      nativeDeaths,
      respawns,
      respawnsAfterNewDeaths: respawns - Number(this.inherited && respawns > 0),
      life: this.life,
      life_phase: this.latest?.life_phase ?? null,
      firstDeath: deathReceipts.find(row => row.life === firstNewLife && row.death) ?? null,
      lastDeath: deathReceipts.find(row => row.life === nativeDeaths && row.death) ?? null,
      inheritedDeath: inheritedDeath && this.parentDeath ? { ...this.parentDeath, receipt: inheritedDeath } : null,
      deathReceipts,
      deathsWithoutSummary: this.deaths - deathReceipts.length,
    };
  }
}

/** Read only new lines, allowing an append in flight until the owned writer has closed. */
export function lifeReceiptReader(file: string) {
  const buffer = Buffer.alloc(READ_BYTES);
  let offset = 0;
  let identity: string | undefined;
  return async (receive: (sample: Sample) => void, closed = false) => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (!identity && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!handle) return false;
    try {
      const entry = await handle.stat();
      const current = `${entry.dev}:${entry.ino}`;
      if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid?.() || entry.mode & 0o077 ||
          (identity && identity !== current) || entry.size < offset) throw new Error("Unsafe agent life receipt file.");
      identity = current;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (end >= 0) {
        for (const line of buffer.toString("utf8", 0, end).split("\n")) receive(JSON.parse(line));
        offset += end + 1;
      }
      if ((closed && bytesRead < buffer.length || end < 0 && bytesRead === buffer.length) && end !== bytesRead - 1) {
        throw new Error("Incomplete agent life receipt.");
      }
      return bytesRead === buffer.length || end !== bytesRead - 1;
    } finally {
      await handle.close();
    }
  };
}
