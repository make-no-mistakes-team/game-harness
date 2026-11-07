import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { ArtifactRetention, type ArtifactRetentionOptions } from "../src/evaluation/artifact-retention.ts";

function fixture(overrides: Partial<ArtifactRetentionOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-retention-"));
  let now = 100_000;
  const options = { runtimeRoot: path.join(root, "runtime"), metadataRoot: path.join(root, "inventory"),
    protectedPaths: [path.join(root, "auth"), path.join(root, "governance"), path.join(root, "official"), path.join(root, "user-worlds")],
    budgetBytes: 1000, maxAgeMs: 1000, maxUnpinnedRuns: 10,
    freeSpaceFloorBytes: 0, now: () => now, ...overrides };
  const retention = new ArtifactRetention(options);
  const acquire = (bytes = 100) => retention.acquire({ reservationBytes: bytes, headroomBytes: 0,
    attempt: { purpose: "development", declaration: "finite development regression" } });
  const close = (id: string, outcome: "success" | "failure" | "cancelled" = "failure") => {
    retention.beginDrain(id);
    retention.closeRun(id, { drained: true, outcome: { status: outcome, attemptIds: ["attempt-1"], reasons: ["complete negative outcome"], evidenceRefs: ["governance:attempt-1"] },
      drainEvidence: ["runtime, native, recorder and provider joined"] });
  };
  return { root, retention, options, acquire, close, advance: (ms: number) => { now += ms; },
    dispose() { retention.close(); rmSync(root, { recursive: true, force: true }); } };
}

// Removing the active/drained/pin gates would delete these real payloads.
test("active, unconfirmed-drain and referenced runs survive age and quota pressure", () => {
  const f = fixture({ maxUnpinnedRuns: 0 });
  try {
    const active = f.acquire(), draining = f.acquire(), pinned = f.acquire();
    writeFileSync(path.join(active.directory, "frame"), "active");
    f.retention.beginDrain(draining.id);
    expect(() => f.retention.closeRun(draining.id, { drained: false, outcome: { status: "failure", attemptIds: [], reasons: ["drain timed out"], evidenceRefs: [] }, drainEvidence: [] })).toThrow();
    f.close(pinned.id, "success");
    f.retention.pin(pinned.id, "manual-review", "user review pending");
    f.advance(5000);
    expect(f.retention.rotate().expired).toEqual([]);
    for (const run of [active, draining, pinned]) expect(existsSync(run.directory)).toBe(true);
    f.retention.unpin(pinned.id, "manual-review");
    expect(f.retention.rotate().expired).toEqual([pinned.id]);
  } finally { f.dispose(); }
});

for (const status of ["success", "failure", "cancelled"] as const) {
  test(`aged ${status} payload expires while complete outcome and tombstones survive`, () => {
    const f = fixture();
    try {
      const run = f.acquire();
      mkdirSync(path.join(run.directory, "nested"));
      writeFileSync(path.join(run.directory, "nested", "video"), Buffer.alloc(41));
      writeFileSync(path.join(run.directory, "journal"), Buffer.alloc(19));
      expect(f.retention.inspect().runs.find(item => item.id === run.id)?.bytes).toBe(60);
      f.close(run.id, status); f.advance(1001);
      expect(f.retention.rotate().expired).toEqual([run.id]);
      expect(existsSync(run.directory)).toBe(false);
      const inventory = f.retention.inspect();
      expect(inventory.runs.find(item => item.id === run.id)?.outcome).toEqual({ status, attemptIds: ["attempt-1"], reasons: ["complete negative outcome"], evidenceRefs: ["governance:attempt-1"] });
      expect(inventory.tombstones.filter(item => item.runId === run.id).map(item => item.phase)).toEqual(["intent", "complete"]);
    } finally { f.dispose(); }
  });
}

test("count expiry is oldest-first and byte admission reclaims only eligible bundles", () => {
  const f = fixture({ maxUnpinnedRuns: 1, budgetBytes: 150 });
  try {
    const first = f.acquire(70); writeFileSync(path.join(first.directory, "video"), Buffer.alloc(70)); f.close(first.id, "success");
    f.advance(1);
    const second = f.acquire(70); writeFileSync(path.join(second.directory, "video"), Buffer.alloc(70)); f.close(second.id);
    expect(f.retention.rotate().expired).toEqual([first.id]);
    const third = f.acquire(100);
    expect(existsSync(second.directory)).toBe(false);
    expect(existsSync(third.directory)).toBe(true);
  } finally { f.dispose(); }
});

test("byte rotation reclaims closed success and failure payloads without an age or count trigger", () => {
  const f = fixture({ budgetBytes: 150 });
  try {
    const first = f.acquire(70); writeFileSync(path.join(first.directory, "journal"), Buffer.alloc(70)); f.close(first.id, "success");
    f.advance(1);
    const second = f.acquire(70); writeFileSync(path.join(second.directory, "world"), Buffer.alloc(70)); f.close(second.id);
    writeFileSync(path.join(f.options.runtimeRoot, "unknown-previous-run"), Buffer.alloc(100));
    expect(f.retention.rotate().expired).toEqual([first.id, second.id]);
    expect(f.retention.inspect().protectedBytes).toBe(100);
    expect(existsSync(path.join(f.options.runtimeRoot, "unknown-previous-run"))).toBe(true);
  } finally { f.dispose(); }
});

test("pinned and protected unknown occupancy consume admission capacity without deletion", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.options.runtimeRoot, "legacy-evidence"), Buffer.alloc(600));
    const run = f.acquire(300); writeFileSync(path.join(run.directory, "world"), Buffer.alloc(300)); f.close(run.id);
    f.retention.pin(run.id, "study:fixed", "immutable study reference");
    expect(() => f.retention.acquire({ reservationBytes: 80, headroomBytes: 21, attempt: { purpose: "development", declaration: "bounded" } })).toThrow(/capacity/i);
    expect(existsSync(run.directory)).toBe(true);
    expect(f.retention.inspect().tombstones.at(-1)?.phase).toBe("admission_refused");
    expect(() => f.acquire(Infinity)).toThrow();
  } finally { f.dispose(); }
});

test("periodic capacity checks detect a run exceeding its finite reservation", () => {
  const f = fixture();
  try {
    const run = f.acquire(20); writeFileSync(path.join(run.directory, "video"), Buffer.alloc(21));
    expect(() => f.retention.checkCapacity(run.id)).toThrow(/reservation/i);
    expect(existsSync(run.directory)).toBe(true);
  } finally { f.dispose(); }
});

test("compact report roots count toward admission without becoming deletion candidates", () => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-reports-"));
  const reports = path.join(root, "reports"); mkdirSync(reports); writeFileSync(path.join(reports, "failed-attempt.json"), Buffer.alloc(950));
  const f = fixture({ readOnlyRoots: [reports] });
  try {
    expect(() => f.acquire(100)).toThrow(/capacity/i);
    expect(readFileSync(path.join(reports, "failed-attempt.json")).length).toBe(950);
    expect(f.retention.inspect().runs).toHaveLength(0);
  } finally { f.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("unknown existing children and protected roots are never adopted or deleted", () => {
  const f = fixture({ maxUnpinnedRuns: 0 });
  try {
    const unknown = path.join(f.options.runtimeRoot, "candidate-14GB-recording"); mkdirSync(unknown, { recursive: true });
    writeFileSync(path.join(unknown, "keep"), "legacy candidate");
    const outside = f.options.protectedPaths[0]!; mkdirSync(outside); writeFileSync(path.join(outside, "keep"), "auth");
    symlinkSync(outside, path.join(f.options.runtimeRoot, "unknown-symlink"));
    expect(() => f.retention.register("../candidate-14GB-recording", { attemptIds: [], evidenceRefs: [] })).toThrow();
    f.advance(5000); f.retention.rotate();
    expect(readFileSync(path.join(unknown, "keep"), "utf8")).toBe("legacy candidate");
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("auth");
    expect(existsSync(path.join(f.options.runtimeRoot, "unknown-symlink"))).toBe(true);
    expect(() => new ArtifactRetention({ ...f.options, metadataRoot: path.join(outside, "metadata"), runtimeRoot: outside })).toThrow();
  } finally { f.dispose(); }
});

test("symlink payloads refuse expiry, preserve external files and leave durable failure tombstones", () => {
  const f = fixture();
  try {
    const run = f.acquire(), outside = path.join(f.root, "outside"); mkdirSync(outside); writeFileSync(path.join(outside, "keep"), "world");
    symlinkSync(outside, path.join(run.directory, "escape")); f.close(run.id); f.advance(1001);
    expect(f.retention.rotate().failed).toEqual([run.id]);
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("world");
    expect(f.retention.inspect().tombstones.at(-1)).toMatchObject({ runId: run.id, phase: "failure" });
  } finally { f.dispose(); }
});

test("cancelled expiry records its intent and cancellation without dropping the bundle", () => {
  const f = fixture();
  try {
    const run = f.acquire(); f.close(run.id); f.advance(1001);
    const signal = AbortSignal.abort("operator cancelled retention");
    expect(f.retention.rotate({ signal }).failed).toEqual([run.id]);
    expect(existsSync(run.directory)).toBe(true);
    expect(f.retention.inspect().tombstones.slice(-2).map(item => item.phase)).toEqual(["intent", "cancelled"]);
    expect(() => f.retention.pin(run.id, "late-review", "must not resurrect partial payload")).toThrow();
    expect(f.retention.rotate().expired).toEqual([run.id]);
    expect(existsSync(run.directory)).toBe(false);
  } finally { f.dispose(); }
});

test("special JavaScript property names are real durable pin references", () => {
  const f = fixture({ maxUnpinnedRuns: 0 });
  try {
    const run = f.acquire(); f.close(run.id); f.retention.pin(run.id, "__proto__", "review reference"); f.advance(1001);
    expect(f.retention.rotate().expired).toEqual([]);
    expect(existsSync(run.directory)).toBe(true);
    f.retention.unpin(run.id, "__proto__");
    expect(f.retention.rotate().expired).toEqual([run.id]);
  } finally { f.dispose(); }
});

test("symlink runtime ancestors and forged inventory paths are refused", () => {
  const f = fixture();
  try {
    const run = f.acquire(); f.close(run.id); f.advance(1001);
    const db = new Database(path.join(f.options.metadataRoot, "artifact-retention.sqlite"));
    const row = db.query<{ value: string }, []>("SELECT value FROM inventory WHERE id=1").get()!;
    const inventory = JSON.parse(row.value); inventory.runs[0].directory = path.join(f.root, "escape");
    db.query("UPDATE inventory SET value=? WHERE id=1").run(JSON.stringify(inventory)); db.close();
    expect(() => f.retention.rotate()).toThrow(/ownership|path/i);
    const linked = path.join(f.root, "linked"); symlinkSync(f.options.runtimeRoot, linked);
    expect(() => new ArtifactRetention({ ...f.options, runtimeRoot: linked })).toThrow(/symlink|real directory/i);
  } finally { f.dispose(); }
});

test("protected directory aliases cannot be admitted as generated evaluation storage", () => {
  const f = fixture();
  try {
    const alias = path.join(f.root, "protected-alias"); symlinkSync(f.options.runtimeRoot, alias);
    expect(() => new ArtifactRetention({ ...f.options, protectedPaths: [alias] })).toThrow(/protected/i);
  } finally { f.dispose(); }
});

test("a persisted expiry intent recovers after partial payload deletion", () => {
  const f = fixture();
  try {
    const run = f.acquire(); writeFileSync(path.join(run.directory, "remaining"), "surviving segment"); f.close(run.id);
    const db = new Database(path.join(f.options.metadataRoot, "artifact-retention.sqlite"));
    const row = db.query<{ value: string }, []>("SELECT value FROM inventory WHERE id=1").get()!;
    const inventory = JSON.parse(row.value); inventory.runs[0].expiry = { id: "interrupted-expiry", reason: "age", startedAt: 100_000 };
    db.query("UPDATE inventory SET value=? WHERE id=1").run(JSON.stringify(inventory)); db.close();
    expect(f.retention.rotate().expired).toEqual([run.id]);
    expect(existsSync(run.directory)).toBe(false);
    expect(f.retention.inspect().tombstones.at(-1)).toMatchObject({ runId: run.id, phase: "complete", expiryId: "interrupted-expiry" });
  } finally { f.dispose(); }
});

test("free-space floor is a hard admission gate even with project quota available", () => {
  const f = fixture({ freeSpaceFloorBytes: Number.MAX_SAFE_INTEGER });
  try { expect(() => f.acquire(1)).toThrow(/free.space|capacity/i); }
  finally { f.dispose(); }
});

test("independent processes cannot both spend the last admission reservation", async () => {
  const f = fixture({ budgetBytes: 100 });
  try {
    const module = new URL("../src/evaluation/artifact-retention.ts", import.meta.url).href;
    const options = { ...f.options, now: undefined };
    const script = `import {ArtifactRetention} from ${JSON.stringify(module)}; const r=new ArtifactRetention(${JSON.stringify(options)}); try { r.acquire({reservationBytes:80,headroomBytes:0,attempt:{purpose:"development",declaration:"concurrent"}}); process.exitCode=0; } catch { process.exitCode=2; } finally {r.close();}`;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" }));
    expect((await Promise.all(children.map(child => child.exited))).sort()).toEqual([0, 2]);
    expect(f.retention.inspect().runs.filter(run => run.state === "active")).toHaveLength(1);
  } finally { f.dispose(); }
});
