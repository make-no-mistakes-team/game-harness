import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SURVIVAL_AGENT_GOALS as GOALS } from "../src/shared/survival-agent-ui.ts";

export const PENDING_FURNACE_SCOPE = "pending-furnace-scope.json";
const RECORD = "pending-furnace.json";
const NATIVE_CLOSE = "pending-furnace-close.json";
const TEMP = "pending-furnace.tmp";
// 32 longest vanilla reserve IDs plus 36 signed coordinate pairs, with stamp/header room.
const BYTES = 8_192;
const run = z.string().regex(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-(?:${GOALS.join("|")})-[A-Za-z0-9]{6}$`));
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const stamp = z.strictObject({ run, life: z.int().min(1), tick: z.int().min(1), frame: z.int().min(0) });
const horizontal = z.int().min(-30_000_000).max(30_000_000);
const height = z.int().min(-64).max(320);
const cell = z.tuple([horizontal, height, horizontal]);
const breadcrumbs = z.strictObject({
  footing: cell,
  edges: z.array(z.tuple([horizontal, height, horizontal, horizontal, height, horizontal])).min(1).max(36),
});
const floors = z.array(z.strictObject({
  item: z.string().regex(/^minecraft:[a-z0-9_]{1,96}$/).refine(item => item !== "minecraft:air"),
  count: z.int().min(1).max(2_304),
})).max(32).refine(items => new Set(items.map(floor => floor.item)).size === items.length);
const snapshot = z.strictObject({
  v: z.literal(1), run, world: uuid, owner: uuid, id: uuid, originId: uuid, originWorld: uuid,
  dimension: z.enum(["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"]),
  pos: cell, footing: cell, facing: z.enum(["north", "south", "east", "west"]),
  raw: z.literal("minecraft:raw_iron"), units: z.int().min(1).max(64),
  fuel: z.string().regex(/^minecraft:(?:coal|charcoal|stick|[a-z0-9_]{1,40}_planks)$/),
  fuelCount: z.int().min(1).max(64), fuelTicks: z.int().min(1).max(1_600),
  output: z.literal("minecraft:iron_ingot"), syncId: z.int().min(1).max(255),
  minimumOutput: z.int().min(0).max(64), maximumFuel: z.int().min(0).max(64),
  basis: z.enum(["live", "resume", "clue"]),
  state: z.enum(["paid", "parked", "collected", "cancelled", "disappeared"]),
  paid: stamp, parked: stamp.optional(), lost: stamp.optional(), gone: stamp.optional(), ended: stamp.optional(),
  floors: floors.optional(), breadcrumbs: breadcrumbs.optional(),
});
const scope = z.strictObject({ v: z.literal(1), run, world: uuid, resume: hash.optional() });
const close = z.strictObject({ v: z.literal(1), stamp, id: uuid, record: hash, breadcrumbs: breadcrumbs.optional() });
const seal = z.strictObject({ record: hash, source: hash, copy: hash, route: hash.optional() });

type Snapshot = z.infer<typeof snapshot>;
type Stamp = z.infer<typeof stamp>;
type Scope = z.infer<typeof scope>;
type Seal = z.infer<typeof seal>;
type ReadArtifact = (name: string, maxBytes: number, privateMode: true) => Promise<string | undefined | null>;
type Save = { world: string; device: number; signal?: AbortSignal };
type Source = Save & { run: string; read: ReadArtifact; seal: unknown };

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const parse = <T>(schema: z.ZodType<T>, text: string | null | undefined): T | undefined => {
  if (!text) return;
  try { return schema.parse(JSON.parse(text)); } catch { return; }
};
const active = (row: Snapshot) => row.state === "paid" || row.state === "parked";
const atOrAfter = (a: Stamp, b: Stamp) => a.run !== b.run || a.life > b.life && a.tick >= b.tick ||
  a.life === b.life && a.tick >= b.tick && a.frame >= b.frame;

function validBreadcrumbs(route: z.infer<typeof breadcrumbs>, [sx, sy, sz]: z.infer<typeof cell>) {
  const [fx, fy, fz] = route.footing;
  if (Math.abs(fx - sx) > 6 || Math.abs(fy - sy) > 6 || Math.abs(fz - sz) > 6) return false;
  let previous: string | undefined;
  const visited = new Set<string>();
  for (const [ax, ay, az, bx, by, bz] of route.edges) {
    const from = `${ax},${ay},${az}`, to = `${bx},${by},${bz}`;
    if (previous !== undefined && previous !== from ||
        Math.abs(ax - bx) + Math.abs(az - bz) !== 1 || Math.abs(ay - by) > 1) return false;
    visited.add(from);
    if (visited.has(to)) return false;
    previous = to;
  }
  return previous === `${fx},${fy},${fz}`;
}

function readSnapshot(text: string | null | undefined, current: Scope) {
  const row = parse(snapshot, text);
  if (!row || !text || row.run !== current.run || row.world !== current.world ||
      row.fuelCount !== Math.ceil(row.units * 200 / row.fuelTicks) ||
      row.minimumOutput > row.units || row.maximumFuel > row.fuelCount || row.paid.frame < 1 ||
      Math.abs(row.pos[0] - row.footing[0]) > 6 || Math.abs(row.pos[1] - row.footing[1]) > 6 ||
      Math.abs(row.pos[2] - row.footing[2]) > 6 ||
      row.breadcrumbs && (row.basis !== "resume" || !validBreadcrumbs(row.breadcrumbs, row.pos))) return;
  const own = row.paid.run === row.run;
  if (own !== (row.originId === row.id && row.originWorld === row.world) ||
      (row.basis === "live" && (!own || row.lost || row.gone)) ||
      (row.basis === "resume" && (own || row.lost || row.gone ||
        active(row) && current.resume !== digest(text))) ||
      (row.parked && (row.parked.run !== row.paid.run || row.parked.life !== row.paid.life ||
        row.parked.frame < 1 || !atOrAfter(row.parked, row.paid))) ||
      (row.state === "paid" && row.parked) || (row.state === "parked" && !row.parked) ||
      ((row.state === "collected" || row.state === "cancelled") !== Boolean(row.ended)) ||
      (row.state === "collected" && row.basis === "clue") ||
      ((row.state === "disappeared") && (!row.gone || row.basis !== "clue")) ||
      (row.gone && row.state !== "disappeared" && row.state !== "cancelled")) return;
  let prior = row.parked ?? row.paid;
  for (const event of [row.lost, row.gone, row.ended]) {
    if (!event) continue;
    if (!atOrAfter(event, prior)) return;
    prior = event;
  }
  return row;
}

/** Compare only save-file identity/metadata. Neither region contents nor player NBT are read. */
async function saveStamp({ world, device, signal }: Save, { dimension, pos, owner }: Snapshot) {
  const files = ["level.dat", "session.lock", `playerdata/${owner}.dat`, `stats/${owner}.json`];
  const prefix = dimension === "minecraft:the_nether" ? "DIM-1/" : dimension === "minecraft:the_end" ? "DIM1/" : "";
  files.push(`${prefix}region/r.${Math.floor(pos[0] / 512)}.${Math.floor(pos[2] / 512)}.mca`);
  const source = createHash("sha256");
  const copy = createHash("sha256");
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const root = await lstat(world, { bigint: true });
    if (!root.isDirectory() || root.dev !== BigInt(device) || root.uid !== BigInt(uid)) return;
    for (const name of files) {
      let current = world;
      const segments = name.split("/");
      for (let i = 0; i < segments.length; ++i) {
        signal?.throwIfAborted();
        current = path.join(current, segments[i]!);
        const stat = await lstat(current, { bigint: true });
        if (stat.dev !== root.dev || stat.uid !== root.uid ||
            (i === segments.length - 1 ? !stat.isFile() || stat.nlink !== 1n || stat.size <= 0n : !stat.isDirectory())) return;
        if (i === segments.length - 1) {
          const portable = `${name}:${stat.size}:${stat.mode}:${stat.mtimeNs}\n`;
          copy.update(portable);
          source.update(`${portable.trimEnd()}:${stat.dev}:${stat.ino}:${stat.ctimeNs}\n`);
        }
      }
    }
    return { source: source.digest("hex"), copy: copy.digest("hex") };
  } catch {
    signal?.throwIfAborted();
    return;
  }
}

async function put(directory: string, name: string, text: string) {
  const file = await open(path.join(directory, name), "wx", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(text);
    await file.sync();
  } finally { await file.close(); }
}

/** Pin and sample before the runner copies; close the approved root only after finishing the copy. */
export async function readPendingFurnaceParent(source: Source) {
  const [scopeText, text, temporary] = await Promise.all([
    source.read(PENDING_FURNACE_SCOPE, BYTES, true), source.read(RECORD, BYTES, true), source.read(TEMP, BYTES, true),
  ]);
  const parent = parse(scope, scopeText);
  const row = parent && parent.run === source.run ? readSnapshot(text, parent) : undefined;
  if (!row || !text || (!active(row) && row.state !== "disappeared")) return;
  const parsed = seal.safeParse(source.seal);
  const authority = active(row) && row.basis !== "clue" && temporary === undefined && parsed.success &&
    parsed.data.record === digest(text) ? parsed.data : undefined;
  const saved = authority && await saveStamp(source, row);
  const proven = saved?.source === authority?.source && saved?.copy === authority?.copy ? authority : undefined;
  const closeText = proven?.route && await source.read(NATIVE_CLOSE, BYTES, true);
  const receipt = closeText && digest(closeText) === proven?.route ? parse(close, closeText) : undefined;
  const route = receipt && receipt.record === proven?.record && receipt.id === row.id &&
    receipt.breadcrumbs && validBreadcrumbs(receipt.breadcrumbs, row.pos) ? receipt.breadcrumbs : undefined;
  return { row, seal: proven, breadcrumbs: route };
}

/** A child receives only data plus a freshly scoped observation ID, never a parent command. */
export async function preparePendingFurnace(directory: string, run: string, child: Save,
    source?: Source, parent?: Awaited<ReturnType<typeof readPendingFurnaceParent>>) {
  const current: Scope = { v: 1, run, world: randomUUID() };
  if (parent && source) {
    const [latest, childStamp] = parent.seal ? await Promise.all([
      readPendingFurnaceParent(source), saveStamp(child, parent.row),
    ]) : [];
    // A real fork has its own identity. Exact source state must remain unchanged
    // across the copy, and the copied files must match its sealed save metadata.
    if (!parent.seal || latest?.row.id === parent.row.id) {
      const proven = parent.seal && latest?.seal?.source === parent.seal.source && childStamp?.copy === parent.seal.copy;
      const row: Snapshot = { ...parent.row, run, world: current.world, id: randomUUID(), basis: proven ? "resume" : "clue",
        floors: proven ? parent.row.floors : undefined, breadcrumbs: proven ? latest?.breadcrumbs : undefined };
      const text = JSON.stringify(row);
      current.resume = digest(text);
      await put(directory, RECORD, text);
    }
  }
  await put(directory, PENDING_FURNACE_SCOPE, JSON.stringify(current));
}

/** Called only for an orderly actor exit, evidenced current life and clean vanilla save. */
export async function sealPendingFurnace(source: Omit<Source, "seal">,
    evidence: { owner: string; life: number; progressTick: number }): Promise<Seal | undefined> {
  const [scopeText, text, closeText, temporary] = await Promise.all([
    source.read(PENDING_FURNACE_SCOPE, BYTES, true), source.read(RECORD, BYTES, true),
    source.read(NATIVE_CLOSE, BYTES, true), source.read(TEMP, BYTES, true),
  ]);
  const current = parse(scope, scopeText);
  const receipt = parse(close, closeText);
  const row = current?.run === source.run ? readSnapshot(text, current) : undefined;
  if (temporary !== undefined || !row || !text || !active(row) || row.basis === "clue" || !receipt ||
      row.owner !== evidence.owner || evidence.life !== 1 || receipt.stamp.life !== evidence.life ||
      receipt.stamp.run !== source.run || receipt.stamp.tick < evidence.progressTick || receipt.id !== row.id ||
      !atOrAfter(receipt.stamp, row.parked ?? row.paid) || receipt.record !== digest(text)) return;
  const saved = await saveStamp(source, row);
  return saved && { record: receipt.record, ...saved,
    ...(closeText && receipt.breadcrumbs && validBreadcrumbs(receipt.breadcrumbs, row.pos) ? { route: digest(closeText) } : {}) };
}
