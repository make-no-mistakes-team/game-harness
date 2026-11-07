import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmdirSync, statfsSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";

const GiB = 1024 ** 3;
const identifier = /^[a-f0-9-]{36}$/;
const unsafeNames: Record<string, true> = { auth: true, credentials: true, governance: true, ".minecraft": true, "official-minecraft": true, "user-worlds": true };

export interface ArtifactRetentionOptions {
  /** Generated evaluation runtime storage ONLY; never an application or Minecraft home. */
  runtimeRoot: string;
  /** Private durable inventory outside every payload/accounting root. Not expired by this owner. */
  metadataRoot: string;
  /** Auth, governance, official Minecraft and user-world roots, including nonexistent ones. */
  protectedPaths: readonly string[];
  /** Additional generated evaluation roots (e.g. compact reports): count, NEVER delete. */
  readOnlyRoots?: readonly string[];
  budgetBytes?: number;
  maxAgeMs?: number;
  maxUnpinnedRuns?: number;
  freeSpaceFloorBytes?: number;
  now?: () => number;
}

export interface ArtifactAttemptDeclaration {
  purpose: "development";
  declaration: string;
}
export interface ArtifactOutcome {
  status: "success" | "failure" | "cancelled";
  /** Complete attempt identity survives payload deletion; governance remains authoritative. */
  attemptIds: readonly string[];
  reasons: readonly string[];
  evidenceRefs: readonly string[];
}
export interface ArtifactRun {
  id: string;
  directory: string;
  state: "active" | "draining" | "closed";
  createdAt: number;
  closedAt: number | null;
  reservationBytes: number;
  headroomBytes: number;
  attempt: ArtifactAttemptDeclaration;
  attemptIds: string[];
  evidenceRefs: string[];
  pins: Record<string, string>;
  outcome: ArtifactOutcome | null;
  drainEvidence: string[];
  identity: { dev: number; ino: number };
  expiry: { id: string; reason: string; startedAt: number } | null;
  expiredAt: number | null;
}
export interface ArtifactTombstone {
  id: string;
  runId: string | null;
  expiryId: string | null;
  at: number;
  phase: "intent" | "complete" | "failure" | "cancelled" | "admission_refused" | "acquisition_failure";
  reason: string;
  bytes: number;
}
interface Inventory { version: 1; runtimeRoot: string; runs: ArtifactRun[]; tombstones: ArtifactTombstone[] }
export interface ArtifactInventory {
  runs: Array<ArtifactRun & { bytes: number }>;
  tombstones: ArtifactTombstone[];
  occupancyBytes: number;
  protectedBytes: number;
  reservedBytes: number;
}
export interface ArtifactRotation { expired: string[]; failed: string[] }

function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function finiteBytes(value: number, label: string, positive = false): number {
  requireValue(Number.isSafeInteger(value) && value >= (positive ? 1 : 0), `${label} must be a finite ${positive ? "positive" : "nonnegative"} safe integer`);
  return value;
}
function text(value: string, label: string): void { requireValue(typeof value === "string" && value.trim().length > 0, `${label} must not be empty`); }
function strings(value: readonly string[], label: string): void { requireValue(Array.isArray(value), `${label} must be an array`); for (const item of value) text(item, label); }
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function overlaps(a: string, b: string): boolean { return inside(a, b) || inside(b, a); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function stat(file: string): Stats | null { try { return lstatSync(file); } catch (error) { if (missing(error)) return null; throw error; } }

/** Refuse symlinks in *all* existing ancestors, not just the last component. */
function realDirectory(directory: string, create: boolean): void {
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let entry = stat(current);
    if (!entry && create) { try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } entry = stat(current); }
    if (!entry && !create) return;
    requireValue(entry?.isDirectory() && !entry.isSymbolicLink(), "Artifact ownership requires a real directory without symlink ancestors");
  }
  if (stat(resolved)) requireValue(realpathSync(resolved) === resolved, "Artifact ownership path escaped its real directory");
}

/** Protect aliases too, without reading any protected directory's contents. */
function protectedAliases(directory: string): string[] {
  const declared = path.resolve(directory);
  let ancestor = declared;
  while (!stat(ancestor)) {
    const parent = path.dirname(ancestor);
    requireValue(parent !== ancestor, "Protected artifact path has no existing ancestor");
    ancestor = parent;
  }
  return [declared, path.resolve(realpathSync(ancestor), path.relative(ancestor, declared))];
}

/** Synchronous fs work is deliberate: the cross-process SQLite write lock covers each mutation.
 * SQLite's OS lock releases on crash; no PID-age guessing or stale lock-file unlink races.
 * Only explicitly acquired NEW development bundles can ever become deletion candidates.
 */
export class ArtifactRetention {
  readonly #db: Database;
  readonly #runtime: string;
  readonly #managed: string;
  readonly #metadata: string;
  readonly #protected: string[];
  readonly #readOnly: string[];
  readonly #budget: number;
  readonly #age: number;
  readonly #count: number;
  readonly #floor: number;
  readonly #now: () => number;

  constructor(options: ArtifactRetentionOptions) {
    this.#runtime = path.resolve(options.runtimeRoot);
    this.#managed = path.join(this.#runtime, "development-runs");
    this.#metadata = path.resolve(options.metadataRoot);
    requireValue(Array.isArray(options.protectedPaths) && options.protectedPaths.length > 0, "Explicit protected storage roots are required");
    this.#protected = [...new Set(options.protectedPaths.flatMap(protectedAliases))];
    this.#readOnly = (options.readOnlyRoots ?? []).map(value => path.resolve(value));
    for (const root of [this.#runtime, ...this.#readOnly]) {
      requireValue(!overlaps(root, this.#metadata), "Artifact metadata must be outside payload/accounting roots");
      for (const protectedRoot of this.#protected) requireValue(!overlaps(root, protectedRoot), "Artifact accounting root overlaps protected storage");
    }
    const roots = [this.#runtime, ...this.#readOnly];
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++)
      requireValue(!overlaps(roots[i]!, roots[j]!), "Artifact accounting roots must not overlap");
    for (const protectedRoot of this.#protected) requireValue(!overlaps(this.#metadata, protectedRoot), "Artifact metadata overlaps protected storage");
    this.#budget = finiteBytes(options.budgetBytes ?? 20 * GiB, "budgetBytes", true);
    this.#age = finiteBytes(options.maxAgeMs ?? 14 * 24 * 60 * 60 * 1000, "maxAgeMs");
    this.#count = finiteBytes(options.maxUnpinnedRuns ?? 10, "maxUnpinnedRuns");
    this.#floor = finiteBytes(options.freeSpaceFloorBytes ?? GiB, "freeSpaceFloorBytes");
    this.#now = options.now ?? Date.now;
    realDirectory(this.#runtime, true); realDirectory(this.#metadata, true); realDirectory(this.#managed, true);
    for (const root of this.#readOnly) realDirectory(root, false);
    const databasePath = path.join(this.#metadata, "artifact-retention.sqlite");
    for (const filename of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      const entry = stat(filename);
      requireValue(!entry || (entry.isFile() && !entry.isSymbolicLink()), "Artifact inventory and SQLite sidecars must be regular files without symlinks");
    }
    const fd = openSync(databasePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    this.#db = new Database(databasePath, { create: true });
    try {
      this.#db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.#db.exec("CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
      this.#transaction(() => {
        const existing = this.#get();
        if (!existing) this.#put({ version: 1, runtimeRoot: this.#runtime, runs: [], tombstones: [] });
        else this.#validate(existing);
      });
    } catch (error) { this.#db.close(); throw error; }
  }

  close(): void { this.#db.close(true); }

  /** Admission plus NEW directory creation. Never adopts an existing runtime child.
   * The reservation includes the full recursive bundle, not only the recording.
   */
  acquire(input: { reservationBytes: number; headroomBytes: number; attempt: ArtifactAttemptDeclaration }): ArtifactRun {
    finiteBytes(input.reservationBytes, "reservationBytes", true); finiteBytes(input.headroomBytes, "headroomBytes");
    finiteBytes(input.reservationBytes + input.headroomBytes, "total run reservation", true);
    requireValue(input.attempt.purpose === "development", "Only new development runs may be acquired"); text(input.attempt.declaration, "attempt declaration");
    this.rotate();
    // Reclaim eligible closed bundles, oldest first, until this exact finite admission fits.
    const attempted = new Set<string>();
    for (;;) {
      const decision = this.#transaction(() => {
        const inventory = this.#inventory();
        const usage = this.#usage(inventory);
        const requested = input.reservationBytes + input.headroomBytes;
        if (this.#fits(usage, requested)) {
          const id = randomUUID(), directory = path.join(this.#managed, id);
          const run: ArtifactRun = { id, directory, state: "active", createdAt: this.#now(), closedAt: null,
            reservationBytes: input.reservationBytes, headroomBytes: input.headroomBytes, attempt: { ...input.attempt }, attemptIds: [], evidenceRefs: [], pins: {},
            outcome: null, drainEvidence: [], identity: { dev: 0, ino: 0 }, expiry: null, expiredAt: null };
          try {
            mkdirSync(directory, { mode: 0o700 }); const entry = lstatSync(directory); run.identity = { dev: entry.dev, ino: entry.ino };
            inventory.runs.push(run); this.#put(inventory); this.#syncDirectory(this.#managed);
            return { run };
          } catch (error) {
            // If the process dies between mkdir and commit, the orphan stays UNKNOWN and protected.
            this.#event(inventory, null, "acquisition_failure", String(error), 0); this.#put(inventory);
            return { refusal: error instanceof Error ? error.message : String(error) };
          }
        }
        const candidate = this.#eligible(inventory).find(run => !attempted.has(run.id));
        if (candidate) return { candidate: candidate.id };
        const refusal = "Artifact capacity insufficient: protected/active occupancy, finite reservations, headroom or free-space floor prevents admission";
        this.#event(inventory, null, "admission_refused", refusal, usage.occupancyBytes); this.#put(inventory);
        return { refusal };
      });
      if (decision.run) return decision.run;
      if (decision.refusal) throw new Error(decision.refusal);
      if (decision.candidate) { attempted.add(decision.candidate); this.#expire(decision.candidate, "admission_capacity"); }
    }
  }

  /** Attach attempt/report identities, NEVER filesystem ownership. References persist after expiry.
   * A live study/review/user-world consumer must additionally pin before using the bundle.
   */
  register(id: string, references: { attemptIds: readonly string[]; evidenceRefs: readonly string[] }): void {
    strings(references.attemptIds, "attemptIds"); strings(references.evidenceRefs, "evidenceRefs");
    this.#change(id, run => {
      requireValue(!run.expiry && run.expiredAt === null, "Cannot register references after expiry starts");
      run.attemptIds = [...new Set([...run.attemptIds, ...references.attemptIds])];
      run.evidenceRefs = [...new Set([...run.evidenceRefs, ...references.evidenceRefs])];
    });
  }
  beginDrain(id: string): void {
    this.#change(id, run => { requireValue(run.state !== "closed", "Closed artifact run cannot restart draining"); run.state = "draining"; });
  }
  closeRun(id: string, confirmation: { drained: boolean; outcome: ArtifactOutcome; drainEvidence: readonly string[] }): void {
    requireValue(confirmation.drained === true, "Artifact closure requires confirmed drain, not timeout/cancellation");
    strings(confirmation.drainEvidence, "drainEvidence"); requireValue(confirmation.drainEvidence.length > 0, "Drain evidence is required");
    requireValue(["success", "failure", "cancelled"].includes(confirmation.outcome.status), "Complete artifact outcome required");
    strings(confirmation.outcome.attemptIds, "attemptIds"); strings(confirmation.outcome.reasons, "outcome reasons"); strings(confirmation.outcome.evidenceRefs, "evidenceRefs");
    this.#change(id, run => {
      requireValue(run.state === "draining", "Artifact run must enter draining before closure");
      run.state = "closed"; run.closedAt = this.#now();
      run.outcome = structuredClone(confirmation.outcome); run.drainEvidence = [...confirmation.drainEvidence];
      run.attemptIds = [...new Set([...run.attemptIds, ...confirmation.outcome.attemptIds])];
      run.evidenceRefs = [...new Set([...run.evidenceRefs, ...confirmation.outcome.evidenceRefs])];
    });
  }
  pin(id: string, reference: string, reason: string): void {
    text(reference, "pin reference"); text(reason, "pin reason");
    this.#change(id, run => {
      requireValue(!run.expiry && run.expiredAt === null, "Cannot pin after expiry has started");
      Object.defineProperty(run.pins, reference, { value: reason, enumerable: true, configurable: true, writable: true });
    });
  }
  unpin(id: string, reference: string): void { text(reference, "pin reference"); this.#change(id, run => { delete run.pins[reference]; }); }

  /** Caller MUST periodically invoke this while writing and fence/abort its producers on refusal.
   * This is admission/accounting, not an OS disk quota; it never silently deletes an active run.
   */
  checkCapacity(id: string): ArtifactInventory {
    return this.#transaction(() => {
      const inventory = this.#inventory(), run = this.#find(inventory, id), usage = this.#usage(inventory);
      requireValue(run.expiredAt === null && !run.expiry, "Artifact run is expiring or expired");
      const bytes = usage.runs.find(entry => entry.id === id)!.bytes;
      requireValue(bytes <= run.reservationBytes, "Artifact run exceeded its declared finite reservation");
      requireValue(this.#fits(usage, 0), "Artifact capacity exhausted or free-space floor reached");
      return usage;
    });
  }

  inspect(): ArtifactInventory { return this.#transaction(() => this.#usage(this.#inventory())); }

  rotate(options: { signal?: AbortSignal } = {}): ArtifactRotation {
    const result: ArtifactRotation = { expired: [], failed: [] }, attempted = new Set<string>();
    for (;;) {
      const next = this.#transaction(() => {
        const inventory = this.#inventory(), eligible = this.#eligible(inventory);
        const pending = eligible.find(run => run.expiry && !attempted.has(run.id));
        if (pending) return { id: pending.id, reason: pending.expiry!.reason };
        const aged = eligible.find(run => !attempted.has(run.id) && this.#now() - run.closedAt! >= this.#age);
        if (aged) return { id: aged.id, reason: "age" };
        const unpinned = inventory.runs.filter(run => run.expiredAt === null && Object.keys(run.pins).length === 0).length;
        const usage = this.#usage(inventory);
        if (unpinned > this.#count || usage.occupancyBytes + usage.reservedBytes > this.#budget) {
          const candidate = eligible.find(run => !attempted.has(run.id));
          if (candidate) return { id: candidate.id, reason: unpinned > this.#count ? "count" : "bytes" };
        }
        return null;
      });
      if (!next) return result;
      attempted.add(next.id);
      (this.#expire(next.id, next.reason, options.signal) ? result.expired : result.failed).push(next.id);
      if (options.signal?.aborted) return result;
    }
  }

  #get(): Inventory | null {
    const statement = this.#db.prepare<{ value: string }, []>("SELECT value FROM inventory WHERE id=1");
    try { const row = statement.get(); return row ? JSON.parse(row.value) as Inventory : null; } finally { statement.finalize(); }
  }
  #put(inventory: Inventory): void {
    const statement = this.#db.prepare<unknown, [string]>("INSERT INTO inventory(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value");
    try { statement.run(JSON.stringify(inventory)); } finally { statement.finalize(); }
  }
  #transaction<T>(operation: () => T): T {
    realDirectory(this.#runtime, false); realDirectory(this.#metadata, false); realDirectory(this.#managed, false);
    return this.#db.transaction(operation).immediate();
  }
  #inventory(): Inventory { const inventory = this.#get(); requireValue(inventory, "Artifact inventory missing"); this.#validate(inventory); return inventory; }
  #validate(inventory: Inventory): void {
    requireValue(inventory.version === 1 && inventory.runtimeRoot === this.#runtime && Array.isArray(inventory.runs) && Array.isArray(inventory.tombstones), "Artifact ownership inventory scope/version invalid");
    const seen = new Set<string>();
    for (const run of inventory.runs) {
      requireValue(identifier.test(run.id) && !seen.has(run.id) && run.directory === path.join(this.#managed, run.id), "Artifact ownership path or identity invalid"); seen.add(run.id);
      requireValue(["active", "draining", "closed"].includes(run.state) && run.pins && typeof run.pins === "object" && !Array.isArray(run.pins), "Artifact ownership state invalid");
      finiteBytes(run.reservationBytes, "inventory reservation", true); finiteBytes(run.headroomBytes, "inventory headroom");
      requireValue(run.identity && Number.isSafeInteger(run.identity.ino) && Number.isSafeInteger(run.identity.dev), "Artifact ownership filesystem identity invalid");
      if (run.state === "closed") requireValue(run.closedAt !== null && run.outcome && run.drainEvidence.length > 0, "Artifact ownership closure lacks drain/outcome evidence");
      if (run.expiry) requireValue(run.state === "closed" && Object.keys(run.pins).length === 0, "Artifact expiry conflicts with protected ownership");
    }
  }
  #find(inventory: Inventory, id: string): ArtifactRun { const run = inventory.runs.find(entry => entry.id === id); requireValue(run, "Unknown artifact ownership registration"); return run; }
  #change(id: string, change: (run: ArtifactRun) => void): void { this.#transaction(() => { const inventory = this.#inventory(); change(this.#find(inventory, id)); this.#put(inventory); }); }
  #eligible(inventory: Inventory): ArtifactRun[] {
    return inventory.runs.filter(run => run.state === "closed" && run.outcome !== null && run.drainEvidence.length > 0 && run.expiredAt === null && Object.keys(run.pins).length === 0)
      .sort((a, b) => a.closedAt! - b.closedAt! || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  #event(inventory: Inventory, run: ArtifactRun | null, phase: ArtifactTombstone["phase"], reason: string, bytes: number): void {
    inventory.tombstones.push({ id: randomUUID(), runId: run?.id ?? null, expiryId: run?.expiry?.id ?? null, at: this.#now(), phase, reason, bytes });
  }
  #scan(root: string, strict: boolean, expectedDev?: number): number {
    const entry = stat(root); if (!entry) return 0;
    requireValue(!this.#protected.some(protectedRoot => overlaps(root, protectedRoot)), "Artifact accounting encountered protected storage");
    if (entry.isSymbolicLink()) { requireValue(!strict, "Artifact expiry refuses symlink payloads"); return entry.size; }
    if (!entry.isDirectory()) { requireValue(entry.isFile(), "Artifact accounting refuses special filesystem entries"); return entry.size; }
    requireValue(expectedDev === undefined || entry.dev === expectedDev, "Artifact accounting refuses mounted/escaped payloads");
    requireValue(unsafeNames[path.basename(root).toLowerCase()] !== true, "Artifact accounting refuses credential/official/user-world directories");
    let bytes = 0;
    for (const name of readdirSync(root)) bytes += this.#scan(path.join(root, name), strict, expectedDev ?? entry.dev);
    return finiteBytes(bytes, "recursive owned bytes");
  }
  #usage(inventory: Inventory): ArtifactInventory {
    const ownedBytes = new Map<string, number>();
    for (const run of inventory.runs) {
      if (run.expiredAt !== null) continue;
      const entry = stat(run.directory);
      if (entry) requireValue(!entry.isSymbolicLink() && entry.isDirectory() && entry.dev === run.identity.dev && entry.ino === run.identity.ino, "Artifact ownership directory replaced or escaped");
      else requireValue(run.expiry !== null, "Artifact ownership directory disappeared before expiry");
      ownedBytes.set(run.id, 0);
    }
    // Unknown siblings (including crash-orphan directories) are only counted, NEVER adopted.
    let occupancyBytes = 0;
    const runtimeDevice = lstatSync(this.#runtime).dev;
    for (const name of readdirSync(this.#runtime)) {
      if (name !== path.basename(this.#managed)) { occupancyBytes += this.#scan(path.join(this.#runtime, name), false, runtimeDevice); continue; }
      const managed = lstatSync(this.#managed);
      requireValue(managed.isDirectory() && !managed.isSymbolicLink() && managed.dev === runtimeDevice, "Artifact managed root replaced or escaped");
      for (const id of readdirSync(this.#managed)) {
        const bytes = this.#scan(path.join(this.#managed, id), false, runtimeDevice);
        occupancyBytes += bytes;
        if (ownedBytes.has(id)) ownedBytes.set(id, bytes);
      }
    }
    for (const root of this.#readOnly) { realDirectory(root, false); occupancyBytes += this.#scan(root, false); }
    const runs = inventory.runs.map(run => ({ ...run, bytes: ownedBytes.get(run.id) ?? 0 }));
    const liveBytes = runs.reduce((sum, run) => sum + run.bytes, 0);
    const reservedBytes = runs.reduce((sum, run) => sum + (run.state !== "closed" && run.expiredAt === null ? Math.max(0, run.reservationBytes - run.bytes) + run.headroomBytes : 0), 0);
    return { runs, tombstones: inventory.tombstones, occupancyBytes, protectedBytes: occupancyBytes - liveBytes + runs.reduce((sum, run) => sum + (Object.keys(run.pins).length > 0 || run.state !== "closed" ? run.bytes : 0), 0), reservedBytes };
  }
  #fits(usage: ArtifactInventory, requested: number): boolean {
    if (usage.occupancyBytes + usage.reservedBytes + requested > this.#budget) return false;
    const filesystem = statfsSync(this.#runtime, { bigint: true });
    return filesystem.bavail * filesystem.bsize >= BigInt(this.#floor) + BigInt(usage.reservedBytes) + BigInt(requested);
  }
  #syncDirectory(directory: string): void { const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
  #expire(id: string, reason: string, signal?: AbortSignal): boolean {
    // Commit intent *before* touching bytes. Another process can recover this on its next rotate.
    const selected = this.#transaction(() => {
      const inventory = this.#inventory(), run = this.#find(inventory, id);
      if (!this.#eligible(inventory).some(entry => entry.id === id)) return false;
      if (!run.expiry) {
        run.expiry = { id: randomUUID(), reason, startedAt: this.#now() };
        // Even an unreadable payload must leave durable intent/failure evidence.
        // Only the completion record claims bytes measured by deletion preflight.
        this.#event(inventory, run, "intent", reason, 0); this.#put(inventory);
      }
      return true;
    });
    if (!selected) return false;
    return this.#transaction(() => {
      const inventory = this.#inventory(), run = this.#find(inventory, id);
      if (run.expiredAt !== null) return true;
      let bytes = 0;
      try {
        requireValue(!signal?.aborted, `Artifact expiry cancelled: ${String(signal?.reason ?? "aborted")}`);
        const entry = stat(run.directory);
        if (entry) {
          requireValue(entry.isDirectory() && !entry.isSymbolicLink() && entry.dev === run.identity.dev && entry.ino === run.identity.ino, "Artifact ownership root replaced or escaped");
          bytes = this.#scan(run.directory, true, run.identity.dev); // Full preflight before deleting ANY entry.
          this.#remove(run.directory, run, signal);
          this.#syncDirectory(this.#managed);
        }
        run.expiredAt = this.#now(); this.#event(inventory, run, "complete", run.expiry!.reason, bytes); this.#put(inventory); return true;
      } catch (error) {
        this.#event(inventory, run, signal?.aborted ? "cancelled" : "failure", error instanceof Error ? error.message : String(error), bytes);
        // Keep the original durable intent: partially deleted payload is never reactivated or pinnable.
        this.#put(inventory); return false;
      }
    });
  }
  #remove(file: string, run: ArtifactRun, signal?: AbortSignal): void {
    requireValue(!signal?.aborted, "Artifact expiry cancelled during deletion");
    requireValue(inside(run.directory, file), "Artifact deletion path escaped ownership");
    realDirectory(path.dirname(file), false);
    const entry = lstatSync(file);
    requireValue(!entry.isSymbolicLink() && entry.dev === run.identity.dev, "Artifact deletion refuses symlink or mounted payload");
    if (entry.isDirectory()) {
      for (const name of readdirSync(file)) this.#remove(path.join(file, name), run, signal);
      rmdirSync(file);
    } else { requireValue(entry.isFile(), "Artifact deletion refuses special payload"); unlinkSync(file); }
  }
}
