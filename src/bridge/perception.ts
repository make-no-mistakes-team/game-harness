import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import type { BotEvents } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import type { BridgeBot, GeometryBlock } from "./types.ts";
import type {
  Observation,
  ObservedBlock,
  ObservedEntity,
  SoundObservation,
  InventoryItem,
  Json,
  Vec3Data,
  BridgeConnection,
} from "../shared/contracts.ts";
import { OBSERVATION_PROFILE as PROFILE } from "./profile.ts";
const require = createRequire(import.meta.url);
const { Vec3: Vector } = require("vec3") as {
  Vec3: new (x: number, y: number, z: number) => Vec3;
};
export const vec = (p: Vec3Data) => new Vector(p.x, p.y, p.z);
export const point = (p: Vec3Data): Vec3Data => ({ x: p.x, y: p.y, z: p.z });
export const distance = (a: Vec3Data, b: Vec3Data) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const key = (p: Vec3Data) => `${p.x},${p.y},${p.z}`;
const chunkKey = (p: Vec3Data) =>
  `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`;
const air = (b: Block) => ["air", "cave_air", "void_air"].includes(b.name);
export function knownGeometry(
  bot: BridgeBot,
  b: GeometryBlock | null,
): b is GeometryBlock {
  return (
    !!b &&
    !!bot.registry.blocksByStateId[b.stateId] &&
    !b.missingStateShape &&
    Array.isArray(b.shapes) &&
    b.shapes.every((s: number[]) => s.length === 6 && s.every(Number.isFinite))
  );
}
function supportedPlayerPose(entity: Entity) {
  const pose: unknown = entity.metadata[6];
  return (
    entity.type !== "player" || pose === undefined || pose === 0 || pose === 5
  );
}
// Closed-cube supercover, ordered by entry time then lexicographic cell coordinates.
export function* supercover(a: Vec3Data, b: Vec3Data): Generator<Vec3Data> {
  const emitted = new Set<string>();
  const start = [a.x, a.y, a.z],
    end = [b.x, b.y, b.z],
    d = end.map((v, i) => v - start[i]!);
  const c = start.map(Math.floor),
    step = d.map(Math.sign);
  const boundaryAxes = start
    .map((v, i) => (d[i] === 0 && Number.isInteger(v) ? i : -1))
    .filter((i) => i >= 0);
  const expand = (base: number[]) => {
    let cells = [base];
    for (const axis of boundaryAxes)
      cells = cells.flatMap((v) => [
        v,
        v.map((n, i) => (i === axis ? n - 1 : n)),
      ]);
    return cells;
  };
  const order = (cells: number[][]) =>
    cells.sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!);
  const initial = [...c];
  let initialCells = [initial];
  for (let i = 0; i < 3; i++)
    if (Number.isInteger(start[i]) && d[i] !== 0)
      initialCells = initialCells.flatMap((v) => [
        v,
        v.map((n, j) => (j === i ? n - 1 : n)),
      ]);
  for (const v of order(initialCells.flatMap(expand))) {
    const id = v.join(",");
    if (emitted.has(id)) continue;
    emitted.add(id);
    yield { x: v[0]!, y: v[1]!, z: v[2]! };
  }
  const next = d.map((v, i) =>
    v === 0 ? Infinity : ((step[i]! > 0 ? c[i]! + 1 : c[i]!) - start[i]!) / v,
  );
  for (let guard = 0; guard < 256; guard++) {
    const t = Math.min(...next);
    if (t > 1 || !Number.isFinite(t)) return;
    const axes = [0, 1, 2].filter((i) => Math.abs(next[i]! - t) < 1e-12);
    const touches: number[][] = [];
    for (let mask = 1; mask < 1 << axes.length; mask++) {
      const v = [...c];
      axes.forEach((axis, i) => {
        if (mask & (1 << i)) v[axis]! += step[axis]!;
      });
      touches.push(...expand(v));
    }
    for (const v of order(touches)) {
      const id = v.join(",");
      if (emitted.has(id)) continue;
      emitted.add(id);
      yield { x: v[0]!, y: v[1]!, z: v[2]! };
    }
    for (const axis of axes) {
      c[axis]! += step[axis]!;
      next[axis]! += Math.abs(1 / d[axis]!);
    }
  }
}
const directions: Vec3Data[] = [];
for (let e = -75; e <= 75; e += 15)
  for (let a = 0; a < 360; a += 11.25) {
    const er = (e * Math.PI) / 180,
      ar = (a * Math.PI) / 180;
    directions.push({
      x: Math.sin(ar) * Math.cos(er),
      y: Math.sin(er),
      z: -Math.cos(ar) * Math.cos(er),
    });
  }
directions.push({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 });
type RecordEntry = {
  kind: "block" | "entity";
  value: ObservedBlock | ObservedEntity;
  raw_id?: number;
  state_id?: number;
  eye: Vec3Data;
  revision: number;
  seen: number;
  dependencies: Map<string, number>;
};
type Work = {
  generator: Generator<Vec3Data, void, Block | null>;
  eye: Vec3Data;
  revision: number;
  started: number;
  source_id?: number;
  pending?: IteratorResult<Vec3Data, void>;
  dependencies: Map<string, number>;
};
const sounds: Record<string, SoundObservation["category"]> =
  PROFILE.sound_whitelist;
export class Perception {
  private records = new Map<string, RecordEntry>();
  private identities = new Map<string, string>();
  private entityIds: number[] = [];
  private revision = 0;
  private direction = 0;
  private entityCursor = -Infinity;
  private batch = 0;
  private sequence = 0;
  private cellRevisions = new Map<string, number>();
  private chunkRevisions = new Map<string, number>();
  private proofRevision = 0;
  private reading: Work | null = null;
  private blockWork: Work | null = null;
  private entityWork: Work | null = null;
  private timer: NodeJS.Timeout | undefined;
  private soundGroups = new Map<string, number>();
  private currentSounds: SoundObservation[] = [];
  private rayAttempts = 0;
  private candidates = 0;
  private authorized = 0;
  private cycleCompletedAt: number | null = null;
  private cleanups: Array<() => void> = [];
  constructor(
    private bot: BridgeBot,
    private config: BridgeConnection,
    private inventory: () => InventoryItem[],
    private diagnostic: (entry: Json) => void,
    private publish: (o: Observation) => void,
  ) {
    const on = <Event extends keyof BotEvents>(
      name: Event,
      fn: BotEvents[Event],
    ) => {
      bot.on(name, fn);
      this.cleanups.push(() => bot.off(name, fn));
    };
    const add = (e: Entity) => {
      const id = e.id;
      let l = 0,
        r = this.entityIds.length;
      while (l < r) {
        const m = (l + r) >>> 1;
        if (this.entityIds[m]! < id) l = m + 1;
        else r = m;
      }
      if (this.entityIds[l] !== id) this.entityIds.splice(l, 0, id);
    };
    Object.values(bot.entities).forEach(add);
    on("entitySpawn", add);
    on("entityGone", (e: Entity) => {
      const i = this.entityIds.indexOf(e.id);
      if (i >= 0) this.entityIds.splice(i, 1);
      this.invalidateEntity(e.id);
      this.identities.delete(`e:${e.id}`);
    });
    on("entityMoved", (e: Entity) => this.invalidateEntity(e.id));
    on("entityUpdate", (e: Entity) => this.invalidateEntity(e.id));
    on("blockUpdate", (_old: Block | null, block: Block | null) => {
      if (!block) {
        this.revision++;
        this.proofRevision++;
        return;
      }
      const id = key(block.position);
      this.cellRevisions.set(id, (this.cellRevisions.get(id) ?? 0) + 1);
      if (this.cellRevisions.size > 65536) {
        this.revision++;
        this.proofRevision++;
        this.cellRevisions.clear();
      }
    });
    const invalidateChunk = (position: Vec3Data) => {
      this.revision++;
      const id = chunkKey(position);
      this.chunkRevisions.set(id, (this.chunkRevisions.get(id) ?? 0) + 1);
      if (this.chunkRevisions.size > 4096) {
        this.proofRevision++;
        this.chunkRevisions.clear();
      }
    };
    on("chunkColumnUnload", invalidateChunk);
    on("chunkColumnLoad", invalidateChunk);
    on("soundEffectHeard", (name: string, p: Vec3Data) => {
      const normalized = name.replace(/^minecraft:/, "");
      if (
        !Object.hasOwn(sounds, normalized) ||
        !bot.entity ||
        !supportedPlayerPose(bot.entity)
      )
        return;
      const category = sounds[normalized]!,
        from = this.eye(),
        dist = distance(from, p);
      if (dist > 32) return;
      const horizontal = Math.hypot(p.x - from.x, p.z - from.z);
      const headings = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
      const dir =
        horizontal < 1
          ? "here"
          : headings[
              Math.floor(
                (Math.atan2(p.x - from.x, -(p.z - from.z)) +
                  2 * Math.PI +
                  Math.PI / 8) /
                  (Math.PI / 4),
              ) % 8
            ];
      const band = dist < 8 ? "near" : dist < 16 ? "mid" : "far";
      this.soundGroups.set(`${category}|${dir}|${band}`, Date.now());
    });
  }
  private invalidateEntity(id: number) {
    for (const record of this.records.values())
      if (record.raw_id === id) record.revision = -1;
    if (this.entityWork?.source_id === id) this.entityWork = null;
  }
  eye(): Vec3Data {
    const e = this.bot.entity;
    const pose: unknown = e.metadata[6];
    return {
      x: e.position.x,
      y: e.position.y + (pose === 5 ? 1.27 : e.eyeHeight),
      z: e.position.z,
    };
  }
  start() {
    const run = () => {
      const started = performance.now();
      this.sample();
      this.publish(this.snapshot());
      this.timer = setTimeout(
        run,
        Math.max(
          0,
          PROFILE.refresh_interval_ms - (performance.now() - started),
        ),
      );
    };
    run();
  }
  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.cleanups.forEach((fn) => fn());
    this.records.clear();
    this.identities.clear();
  }
  private authorize(raw: Block | Entity, eye: Vec3Data) {
    if (!this.reading || !this.dependenciesValid(this.reading.dependencies))
      return;
    this.authorized++;
    const kind = "stateId" in raw ? "block" : "entity";
    const identity =
      "stateId" in raw ? `b:${key(raw.position)}` : `e:${raw.id}`;
    let id = this.identities.get(identity);
    if (!id) {
      id = randomUUID();
      this.identities.set(identity, id);
    }
    const now = Date.now();
    const value = {
      id,
      name: String(raw.name || raw.type || "entity").slice(0, 80),
      position: point(raw.position),
      observed_at: new Date(now).toISOString(),
      current: true,
    };
    this.records.set(id, {
      kind,
      value,
      raw_id: "stateId" in raw ? undefined : raw.id,
      state_id: "stateId" in raw ? raw.stateId : undefined,
      eye: point(eye),
      revision: this.revision,
      seen: now,
      dependencies: new Map(this.reading.dependencies),
    });
    if (this.records.size > PROFILE.authorized_index_records) {
      const victim = [...this.records.entries()].sort(
        (a, b) =>
          a[1].seen - b[1].seen ||
          (a[1].kind === b[1].kind ? 0 : a[1].kind === "block" ? -1 : 1) ||
          (a[1].kind === "block"
            ? a[1].value.position.x - b[1].value.position.x ||
              a[1].value.position.y - b[1].value.position.y ||
              a[1].value.position.z - b[1].value.position.z
            : a[1].value.id.localeCompare(b[1].value.id)),
      )[0]!;
      this.records.delete(victim[0]);
      for (const [k, v] of this.identities)
        if (v === victim[0]) this.identities.delete(k);
    }
  }
  private *ray(
    eye: Vec3Data,
    target: Vec3Data,
    except?: Vec3Data,
  ): Generator<Vec3Data, boolean, Block | null> {
    this.rayAttempts++;
    let visits = 0;
    for (const cell of supercover(eye, target)) {
      if (++visits > PROFILE.cell_visits_per_ray) return false;
      const block = yield cell;
      if (!block) return false;
      if (except && key(cell) === key(except)) continue;
      if (!air(block)) return false;
    }
    return true;
  }
  private *check(
    raw: Block | Entity,
    eye: Vec3Data,
  ): Generator<Vec3Data, void, Block | null> {
    this.candidates++;
    let low: Vec3Data, high: Vec3Data;
    if ("stateId" in raw) {
      if (
        !knownGeometry(this.bot, raw) ||
        distance(eye, raw.position.offset(0.5, 0.5, 0.5)) > 32
      )
        return;
      low = raw.position;
      high = raw.position.offset(1, 1, 1);
    } else {
      if (
        !(raw.width > 0 && raw.height > 0) ||
        !Number.isFinite(raw.width + raw.height) ||
        !supportedPlayerPose(raw)
      )
        return;
      if (raw === this.bot.entity) return;
      low = {
        x: raw.position.x - raw.width / 2,
        y: raw.position.y,
        z: raw.position.z - raw.width / 2,
      };
      high = {
        x: low.x + raw.width,
        y: low.y + raw.height,
        z: low.z + raw.width,
      };
      if (
        distance(eye, {
          x: (low.x + high.x) / 2,
          y: (low.y + high.y) / 2,
          z: (low.z + high.z) / 2,
        }) > 32
      )
        return;
    }
    const center = {
      x: (low.x + high.x) / 2,
      y: (low.y + high.y) / 2,
      z: (low.z + high.z) / 2,
    };
    let points: Vec3Data[] = [];
    for (const axis of ["x", "y", "z"] as const) {
      const inset = Math.min(1 / 1024, (high[axis] - low[axis]) / 4);
      points.push(
        { ...center, [axis]: low[axis] + inset },
        { ...center, [axis]: high[axis] - inset },
      );
    }
    if ("stateId" in raw && raw.shapes.length) {
      const inside = (p: Vec3Data, s: number[]) =>
        p.x - low.x >= s[0]! &&
        p.y - low.y >= s[1]! &&
        p.z - low.z >= s[2]! &&
        p.x - low.x <= s[3]! &&
        p.y - low.y <= s[4]! &&
        p.z - low.z <= s[5]!;
      points = points.filter((p) =>
        raw.shapes.some((s: number[]) => inside(p, s)),
      );
      if (!points.length) {
        const shapes = [...raw.shapes].sort((a: number[], b: number[]) => {
          for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
          return 0;
        });
        const seen = new Set<string>();
        for (const s of shapes) {
          const p = {
            x: low.x + (s[0] + s[3]) / 2,
            y: low.y + (s[1] + s[4]) / 2,
            z: low.z + (s[2] + s[5]) / 2,
          };
          if (!seen.has(key(p))) {
            seen.add(key(p));
            points.push(p);
          }
          if (points.length === 6) break;
        }
      }
    }
    for (const target of points)
      if (
        yield* this.ray(
          eye,
          target,
          "stateId" in raw ? raw.position : undefined,
        )
      ) {
        this.authorize(raw, eye);
        return;
      }
  }
  private *discover(eye: Vec3Data): Generator<Vec3Data, void, Block | null> {
    this.rayAttempts++;
    const d = directions[this.direction]!;
    const end = {
      x: eye.x + 32 * d.x,
      y: eye.y + 32 * d.y,
      z: eye.z + 32 * d.z,
    };
    let count = 0;
    for (const cell of supercover(eye, end)) {
      if (++count > 128) return;
      const block = yield cell;
      if (!block) return;
      if (!air(block)) {
        yield* this.check(block, eye);
        return;
      }
    }
  }
  private sample() {
    if (
      !this.bot.entity ||
      !Number.isFinite(this.bot.entity.eyeHeight) ||
      !supportedPlayerPose(this.bot.entity)
    )
      return;
    const start = performance.now(),
      eye = this.eye();
    this.rayAttempts = 0;
    this.candidates = 0;
    this.authorized = 0;
    const audits: Json[] = [];
    const run = (kind: "block" | "entity") => {
      let visits = 0,
        slots = 0,
        completed = 0;
      const cap =
        kind === "block"
          ? PROFILE.block_cell_visits_per_batch
          : PROFILE.entity_cell_visits_per_batch;
      const limit =
        kind === "block"
          ? PROFILE.block_direction_slots_per_batch
          : PROFILE.entity_registry_slots_per_batch;
      const examined = new Set<number>();
      while (
        slots < limit &&
        visits < cap &&
        performance.now() - start < PROFILE.sampling_elapsed_guard_ms
      ) {
        let work = kind === "block" ? this.blockWork : this.entityWork;
        if (
          work &&
          (distance(work.eye, eye) > 0 ||
            work.revision !== this.revision ||
            Date.now() - work.started > PROFILE.current_max_age_ms ||
            !this.dependenciesValid(work.dependencies))
        )
          work = null;
        if (!work) {
          let id: number | undefined;
          let generator: Generator<Vec3Data, void, Block | null>;
          if (kind === "block") generator = this.discover(eye);
          else {
            if (!this.entityIds.length) break;
            let low = 0,
              high = this.entityIds.length;
            while (low < high) {
              const middle = (low + high) >>> 1;
              if (this.entityIds[middle]! <= this.entityCursor)
                low = middle + 1;
              else high = middle;
            }
            id = this.entityIds[low] ?? this.entityIds[0]!;
            if (examined.has(id)) break;
            const entity = this.bot.entities[id];
            generator = entity ? this.check(entity, eye) : (function* () {})();
          }
          work = {
            generator,
            eye: point(eye),
            revision: this.revision,
            started: Date.now(),
            source_id: id,
            dependencies: new Map(),
          };
        }
        if (kind === "block") this.blockWork = work;
        else {
          this.entityWork = work;
          examined.add(work.source_id!);
        }
        slots++;
        this.reading = work;
        // Preserve the yielded cell without reading it until the next counted step.
        let pending = work.pending ?? work.generator.next();
        while (
          !pending.done &&
          visits < cap &&
          performance.now() - start < PROFILE.sampling_elapsed_guard_ms
        ) {
          visits++;
          const cell = key(pending.value);
          work.dependencies.set(cell, this.cellRevisions.get(cell) ?? 0);
          const raw = this.bot.blockAt(vec(pending.value), false);
          pending = work.generator.next(raw);
        }
        work.pending = pending;
        if (!pending.done) break;
        completed++;
        if (kind === "block") {
          this.blockWork = null;
          this.direction =
            (this.direction + 1) % PROFILE.block_discovery_directions;
          if (this.direction === 0) this.cycleCompletedAt = performance.now();
        } else {
          this.entityWork = null;
          this.entityCursor = work.source_id!;
        }
      }
      audits.push({
        source: kind,
        cell_visits: visits,
        slots,
        completed,
        partial:
          kind === "block" ? this.blockWork !== null : this.entityWork !== null,
        exhaustion:
          performance.now() - start >= PROFILE.sampling_elapsed_guard_ms
            ? "elapsed_guard"
            : visits >= cap
              ? "cell_budget"
              : slots >= limit
                ? "slot_budget"
                : "registry_cycle",
      });
    };
    if (this.batch++ % 2 === 0) {
      run("block");
      run("entity");
    } else {
      run("entity");
      run("block");
    }
    const now = Date.now(),
      categories = ["movement", "interaction", "combat", "creature", "weather"],
      dirs = ["here", "N", "NE", "E", "SE", "S", "SW", "W", "NW"],
      bands = ["near", "mid", "far"];
    this.currentSounds = [];
    for (const category of categories)
      for (const direction of dirs)
        for (const band of bands) {
          const stamp = this.soundGroups.get(
            `${category}|${direction}|${band}`,
          );
          if (stamp && now - stamp <= 1000 && this.currentSounds.length < 8)
            this.currentSounds.push({
              category,
              direction,
              distance: band,
              observed_at: new Date(now).toISOString(),
            } as SoundObservation);
        }
    this.soundGroups.clear();
    this.reading = null;
    this.diagnostic({
      type: "perception_batch",
      batch: this.batch - 1,
      eye,
      duration_ms: performance.now() - start,
      direction_cursor: this.direction,
      entity_cursor: Number.isFinite(this.entityCursor)
        ? this.entityCursor
        : null,
      direction_cycle_completion_age_ms:
        this.cycleCompletedAt === null
          ? null
          : performance.now() - this.cycleCompletedAt,
      ray_attempts: this.rayAttempts,
      considered_candidates: this.candidates,
      authorized_records: this.authorized,
      sources: audits,
    });
  }
  private dependenciesValid(dependencies: Map<string, number>) {
    for (const [cell, revision] of dependencies)
      if ((this.cellRevisions.get(cell) ?? 0) !== revision) return false;
    return true;
  }
  private current(record: RecordEntry) {
    return (
      this.bot.entity &&
      supportedPlayerPose(this.bot.entity) &&
      Date.now() - record.seen <= PROFILE.current_max_age_ms &&
      record.revision === this.revision &&
      distance(record.eye, this.eye()) === 0 &&
      this.dependenciesValid(record.dependencies)
    );
  }
  retainBlockProof(id: string): (() => boolean) | null {
    const record = this.target(id);
    if (!record || record.kind !== "block") return null;
    const revision = this.proofRevision;
    const chunks = new Map<string, number>();
    const retainChunk = (p: Vec3Data) => {
      const chunk = chunkKey(p);
      chunks.set(chunk, this.chunkRevisions.get(chunk) ?? 0);
    };
    retainChunk(record.eye);
    retainChunk(record.value.position);
    for (const cell of record.dependencies.keys()) {
      const [x, y, z] = cell.split(",");
      retainChunk({ x: Number(x), y: Number(y), z: Number(z) });
    }
    // An admitted long dig may outlast sampling freshness. Retain only its
    // unchanged ray and chunk dependencies, not unrelated chunk arrivals.
    // Observation age and its global revision remain unchanged.
    return () => {
      if (
        !this.records.has(id) ||
        !this.bot.entity ||
        !supportedPlayerPose(this.bot.entity) ||
        revision !== this.proofRevision ||
        distance(record.eye, this.eye()) !== 0 ||
        !this.dependenciesValid(record.dependencies)
      )
        return false;
      for (const [chunk, stamp] of chunks)
        if ((this.chunkRevisions.get(chunk) ?? 0) !== stamp) return false;
      return true;
    };
  }
  target(id: string, current = true): RecordEntry | null {
    const record = this.records.get(id);
    return record && (!current || this.current(record)) ? record : null;
  }
  snapshot(): Observation {
    if (!this.bot.entity) throw new Error("The player is not connected.");
    const e = this.bot.entity;
    const observation: Observation = {
      schema_version: 1,
      world_id: this.config.world_id,
      epoch: this.config.epoch,
      observation_seq: ++this.sequence,
      captured_at: new Date().toISOString(),
      profile_id: "player-observable-structured",
      preset_id: "minecraft-observable-initial-r1",
      player: {
        position: point(e.position),
        yaw: e.yaw,
        pitch: e.pitch,
        health: this.bot.health,
        food: this.bot.food,
        on_ground: !!e.onGround,
        in_water: !!e.isInWater,
        inventory: this.inventory(),
      },
      blocks: [],
      entities: [],
      sounds: [],
      coverage: { partial: true, max_age_ms: 1000 },
    };
    const entries = [...this.records.values()]
      .map((r) => ({ r, current: !!this.current(r) }))
      .sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          (a.r.kind === b.r.kind ? 0 : a.r.kind === "block" ? -1 : 1) ||
          (a.r.kind === "block"
            ? a.r.value.position.x - b.r.value.position.x ||
              a.r.value.position.y - b.r.value.position.y ||
              a.r.value.position.z - b.r.value.position.z
            : a.r.value.id.localeCompare(b.r.value.id)),
      );
    let bytes = Buffer.byteLength(JSON.stringify(observation)),
      count = observation.player.inventory.length;
    for (const { r, current } of entries) {
      const value = { ...r.value, current };
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > PROFILE.output_record_bytes) continue;
      if (
        count >= PROFILE.output_records - PROFILE.sound_records_per_batch ||
        bytes + size + 1 > PROFILE.output_bytes - PROFILE.output_envelope_bytes
      )
        break;
      bytes += size + 1;
      count++;
      if (r.kind === "block") observation.blocks.push(value);
      else observation.entities.push(value);
    }
    observation.sounds = this.currentSounds
      .filter(
        (s) =>
          Date.now() - Date.parse(s.observed_at) <= PROFILE.sound_expiry_ms,
      )
      .slice(0, PROFILE.output_records - count);
    return observation;
  }
}
