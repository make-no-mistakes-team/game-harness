import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, realpathSync, statfsSync } from "node:fs";
import path from "node:path";
import { evaluationPaths } from "../src/evaluation/paths.ts";

const project = path.resolve(import.meta.dir, "..");
const local = path.join(project, "local");
const artifactRoot = path.join(local, "survival-agent");
// Stable private storage ABI: both generations must take the same lane locks
// and use the same reservation ledger. No run artifacts are written here.
const admissionRoot = path.join(local, "survival-pilot");
export const artifactLimitBytes = 300_000_000_000;
type Lane = "survival" | "diagnostic";
type Reservations = { generation: number } & Record<Lane, number>;
type CrashReservation = { bootMs: number; startedAtMs: number; priorReserveBytes: number };
type OrphanReservation = {
    kind: "same-boot-orphan-autosave";
    sourceRun: string;
    priorReserveBytes: number;
    signal: AbortSignal;
    assertSource(): void;
    assertQuiescent(signal: AbortSignal): Promise<void>;
};
const lanes = ["survival", "diagnostic"] as const;
// The model-guided development runner can start independently of either agent lane.
const legacyHeadroom = 50 * 1024 ** 3;
const maxAccountingScans = 3;
const runScanTimeoutMs = 5_000;

function accountingFailure(category: string, exit?: number) {
    return new Error(`Cannot account for existing run storage (${category}${exit === undefined ? "" : `; du exit ${exit}`})`);
}

async function boundedText(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return bytes <= 64 * 1024 ? text + decoder.decode() : undefined;
            bytes += value.byteLength;
            // Keep draining both pipes even if we can no longer trust the result.
            if (bytes <= 64 * 1024) text += decoder.decode(value, { stream: true });
        }
    } finally { reader.releaseLock(); }
}

function completeTotal(output: string, roots: string[]) {
    const records = output.split("\0");
    if (records.pop() !== "" || records.length < 2) return;
    const [total, label, extra] = records.pop()!.split("\t");
    if (!total || /[^0-9]/.test(total) || label !== "total" || extra !== undefined) return;
    const bytes = Number(total);
    if (!Number.isSafeInteger(bytes)) return;
    const remaining = new Set(roots);
    let sum = 0;
    for (const record of records) {
        const entry = /^([0-9]+)\t([\s\S]+)$/.exec(record);
        if (!entry || !remaining.delete(entry[2]!)) return;
        sum += Number(entry[1]);
    }
    // GNU du can omit duplicate hard links. All emitted subtotals must still
    // agree with the grand total and refer to roots from this invocation.
    if (sum === bytes) return bytes;
}

/** GNU du counts allocated disk blocks, including files from failed and historical runs.
 * Unknown material is counted conservatively, never adopted or deleted.
 * null means the failed scan saw only vanished entries, never a usable count. */
async function scanDiskBytes(roots: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const resolved = new Set<string>();
    for (const root of roots) {
        try { resolved.add(realpathSync(root)); }
        catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") continue;
            throw accountingFailure(code === "EACCES" || code === "EPERM" ? "root permission denied" :
                code === "EIO" ? "root I/O error" : "root probe failed");
        }
    }
    const existing = [...resolved];
    const distinct = existing.filter(root => !existing.some(other => root.startsWith(other + "/")));
    if (!distinct.length) throw accountingFailure("no storage roots");
    let child;
    try {
        child = Bun.spawn(["du", "-0", "-s", "-c", "-B1", "--", ...distinct], {
            stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" },
            signal, killSignal: "SIGKILL",
        });
    } catch {
        signal?.throwIfAborted();
        throw accountingFailure("could not start du");
    }
    const [stdout, stderr, exit] = await Promise.allSettled([
        boundedText(child.stdout), boundedText(child.stderr), child.exited,
    ]);
    // Join the child and both pipes before reporting cancellation to the runner.
    signal?.throwIfAborted();
    if (exit.status !== "fulfilled") throw accountingFailure("could not wait for du");
    const rc = exit.value;
    if (stdout.status !== "fulfilled" || stderr.status !== "fulfilled")
        throw accountingFailure("could not read du output", rc);
    const output = stdout.value, diagnostics = stderr.value;
    if (output === undefined || diagnostics === undefined) throw accountingFailure("du output exceeded limit", rc);
    if (rc !== 0 || diagnostics !== "") {
        // GNU du quotes diagnostic paths, including embedded newlines. Only a
        // complete report of ENOENT traversal errors can justify a fresh scan.
        const vanished = /^du: (?:(?:cannot access|cannot read directory) .+|(?:['"]|\$').+): No such file or directory$/;
        if (rc === 1 && diagnostics.endsWith("\n") && diagnostics.slice(0, -1).split("\n").every(line => vanished.test(line)))
            return null;
        const category = /: (?:Permission denied|Operation not permitted)$/m.test(diagnostics) ? "permission denied" :
            /: Input\/output error$/m.test(diagnostics) ? "I/O error" : "du scan failed";
        throw accountingFailure(category, rc);
    }
    const total = completeTotal(output, distinct);
    if (total === undefined) throw accountingFailure("malformed du output", rc);
    return total;
}

async function accountDisk(roots: string[], options: {
    signal?: AbortSignal;
    ledger?: { snapshot(): number; reserve(generation: number, used: number): boolean | Promise<boolean> };
} = {}) {
    const { signal, ledger } = options;
    for (let attempt = 1; ; attempt++) {
        const generation = ledger?.snapshot() ?? 0;
        const used = await scanDiskBytes(roots, signal);
        // Scan outside the ledger transaction. Even a run that started and
        // finished mid-scan invalidates that admission sample.
        if (used !== null && (!ledger || await ledger.reserve(generation, used))) return used;
        if (attempt === maxAccountingScans) {
            if (used === null) throw accountingFailure("entries vanished", 1);
            throw accountingFailure("reservations changed during scan");
        }
    }
}

/** Measure one run; retries share the original per-sample deadline. */
export async function diskBytes(dir: string, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(runScanTimeoutMs);
    try {
        return await accountDisk([dir], { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
        signal?.throwIfAborted();
        if (timeout.aborted) throw accountingFailure("du timed out");
        throw error;
    }
}

function tryOwner(lane: Lane, create = true): Database | undefined {
    // Keep the original survival lock so we still exclude runners started before
    // the shared ledger existed. Neither lock database is unlinked or replaced.
    const owner = new Database(path.join(admissionRoot, lane === "survival" ? "owner.sqlite" : "diagnostic-owner.sqlite"),
        create ? { create: true } : { readwrite: true });
    try {
        owner.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        return owner;
    } catch (error) {
        owner.close();
        if ((error as { code?: string }).code === "SQLITE_BUSY") return;
        throw error;
    }
}

function checkOwners(state: Reservations, requested: Lane, take: boolean, replacePrimaryReservation = false) {
    let owner: Database | undefined;
    try {
        for (const lane of lanes) {
            const probe = tryOwner(lane);
            if (!probe) {
                if (!state[lane]) throw new Error(`The ${lane} lane is locked without a shared reservation; wait for its owner to stop.`);
                if (lane === requested) throw new Error(`The ${lane} lane already has an active run.`);
                continue;
            }
            const replacing = replacePrimaryReservation && lane === "survival";
            if ((!state[lane] || replacing) && lane === requested && take) {
                owner = probe;
                continue;
            }
            probe.close();
            if (state[lane] && !replacing) {
                // A process exit releases its lock, not its detached children.
                // Only a drained runner can release a reservation automatically.
                throw new Error(`The previous ${lane} run left an unreleased reservation; owned writers may still be running.`);
            }
        }
        return owner;
    } catch (error) {
        owner?.close();
        throw error;
    }
}

function recoveryLedgerFiles(ledgerPath: string, kind: "crash" | "orphan") {
    const invalid = () => new Error(`Cannot tie storage admission to the prior ${kind} autosave.`);
    const root = lstatSync(admissionRoot);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077)) throw invalid();
    const regular = (file: string) => {
        const entry = lstatSync(file);
        if (!entry.isFile() || entry.uid !== root.uid || entry.dev !== root.dev || entry.nlink !== 1 ||
            (entry.mode & 0o022)) throw invalid();
        return entry;
    };
    function absent(file: string) {
        try { lstatSync(file); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        throw invalid();
    }
    // Recovery uses the durable main-file reservation and does not adopt
    // a database that needs a WAL or a hot rollback journal.
    for (const suffix of ["-journal", "-wal", "-shm"]) absent(ledgerPath + suffix);
    const ledger = regular(ledgerPath);
    const owner = regular(path.join(admissionRoot, "owner.sqlite"));
    let secondIno: number | undefined;
    if (kind === "orphan") {
        try { secondIno = regular(path.join(admissionRoot, "diagnostic-owner.sqlite")).ino; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return { dev: ledger.dev, ino: ledger.ino, ownerDev: owner.dev, ownerIno: owner.ino, secondIno,
        lastWrite: Math.max(ledger.mtimeMs, ledger.ctimeMs) };
}

/** Reserve space before starting any writers; release only after all have drained. */
export async function admitRun(reserveBytes: number, lane: Lane = "survival",
    recovery?: CrashReservation | OrphanReservation): Promise<() => void> {
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes <= 0) throw new Error("Invalid run disk reservation");
    if (lane !== "survival" && lane !== "diagnostic") throw new Error("Invalid agent lane");
    const crash = recovery && "bootMs" in recovery ? recovery : undefined;
    const orphan = recovery && "kind" in recovery ? recovery : undefined;
    if (crash && lane !== "survival") throw new Error("Crash autosave recovery uses only the ordinary Survival lane.");
    if (orphan && lane !== "survival") throw new Error("Orphan autosave recovery uses only the primary Survival lane.");
    const ledgerPath = path.join(admissionRoot, "admission.sqlite");
    if (!recovery) mkdirSync(admissionRoot, { recursive: true, mode: 0o700 });
    const kind = orphan ? "orphan" : "crash";
    const original = recovery && recoveryLedgerFiles(ledgerPath, kind);
    const ledger = new Database(ledgerPath, recovery ? { readwrite: true } : { create: true });
    let owner: Database | undefined;
    try {
        ledger.exec("PRAGMA busy_timeout = 5000");
        if (!recovery) ledger.exec(`
            CREATE TABLE IF NOT EXISTS reservations (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
                survival INTEGER NOT NULL DEFAULT 0 CHECK (survival BETWEEN 0 AND ${artifactLimitBytes}),
                diagnostic INTEGER NOT NULL DEFAULT 0 CHECK (diagnostic BETWEEN 0 AND ${artifactLimitBytes})
            ) STRICT;
            INSERT INTO reservations (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
        `);
        const read = ledger.query<Reservations, []>("SELECT generation, survival, diagnostic FROM reservations WHERE id = 1");
        const write = ledger.query(`UPDATE reservations SET ${lane} = ?, generation = generation + 1 WHERE id = 1`);
        const replaceCrash = (state: Reservations) => {
            if (!crash || !original || !state.survival) return false;
            const current = recoveryLedgerFiles(ledgerPath, "crash");
            // The runner writes its reservation before it creates and declares
            // the now-validated live run. An unknown newer owner is not ours.
            if (state.survival !== crash.priorReserveBytes || state.diagnostic ||
                current.dev !== original.dev || current.ino !== original.ino ||
                current.lastWrite !== original.lastWrite || !(current.lastWrite <= crash.startedAtMs) ||
                !(crash.startedAtMs < crash.bootMs)) {
                throw new Error("The existing reservation is not attributable to the prior crash autosave.");
            }
            return true;
        };
        let orphanGeneration: number | undefined;
        const orphanColumn = () => ledger.query<{ name: string }, []>("PRAGMA table_info(reservations)")
            .all().some(({ name }) => name === "last_orphan_source");
        const checkOrphan = (state: Reservations) => {
            if (!orphan || !original) throw new Error("Missing orphan autosave proof.");
            orphan.signal.throwIfAborted();
            const current = recoveryLedgerFiles(ledgerPath, "orphan");
            // The second owner can update the same ledger while the original primary is
            // gone, so its mtime cannot date the primary charge. Bind the exact amount
            // to the old private live marker instead, under the original primary lock.
            if (!state.survival || state.survival !== orphan.priorReserveBytes ||
                current.dev !== original.dev || current.ino !== original.ino ||
                current.ownerDev !== original.ownerDev || current.ownerIno !== original.ownerIno)
                throw new Error("The existing reservation is not attributable to the orphan autosave.");
            if (current.secondIno !== original.secondIno || orphanGeneration !== undefined && state.generation !== orphanGeneration)
                throw new Error("Lane reservations changed during orphan autosave admission.");
            if (state.diagnostic && current.secondIno === undefined)
                throw new Error("The diagnostic lane has a reservation without an owner lock.");
            const previous = orphanColumn() && ledger.query<{ last_orphan_source: string | null }, []>(
                "SELECT last_orphan_source FROM reservations WHERE id = 1").get()?.last_orphan_source;
            if (previous && previous >= orphan.sourceRun)
                throw new Error("The orphan autosave reservation was already reattributed.");
            orphan.assertSource();
            if (current.secondIno !== undefined) {
                const secondOwner = tryOwner("diagnostic", false);
                secondOwner?.close();
                if (secondOwner && state.diagnostic)
                    throw new Error("The previous diagnostic run left an unreleased reservation; owned writers may still be running.");
                if (!secondOwner && !state.diagnostic)
                    throw new Error("The diagnostic lane is locked without a shared reservation; wait for its owner to stop.");
            }
        };
        const snapshot = ledger.transaction(() => {
            const state = read.get()!;
            if (orphan) {
                // Keep this lock across accounting and the asynchronous OS fence.
                // Do not hold the aggregate transaction across either operation.
                owner ??= tryOwner("survival", false);
                if (!owner) throw new Error("The survival lane already has an active run.");
                checkOrphan(state);
                orphanGeneration = state.generation;
            } else {
                checkOwners(state, lane, false, replaceCrash(state));
            }
            return state.generation;
        });
        const roots = evaluationPaths(project);
        // Counting all of local includes both the historical and current run roots.
        const storage = [local, roots.runtimeRoot, roots.reportsRoot, roots.governanceRoot,
            ...(process.env.GAMEHARNESS_DATA_DIR ? [path.resolve(process.env.GAMEHARNESS_DATA_DIR)] : [])];
        const reserve = ledger.transaction((generation: number, used: number) => {
            const state = read.get()!;
            let replacing = true;
            if (orphan) {
                checkOrphan(state);
            } else {
                if (state.generation !== generation) return false;
                replacing = replaceCrash(state);
                owner = checkOwners(state, lane, true, replacing);
            }
            if (!owner) throw new Error(`Could not acquire the ${lane} lane.`);
            // Charge full reservations on top of the scan: active payloads can
            // grow while du walks them, so the scan gives no safe per-run credit.
            const reserved = (replacing ? 0 : state.survival) + state.diagnostic;
            const fs = statfsSync(existsSync(artifactRoot) ? artifactRoot : local, { bigint: true });
            if (used + reserved + reserveBytes + legacyHeadroom > artifactLimitBytes ||
                fs.bavail * fs.bsize < BigInt(reserved) + BigInt(reserveBytes) + 1024n ** 3n) {
                throw new Error(`Insufficient storage: ${used} bytes counted, ${reserved} reserved for agent runs, ` +
                    `${reserveBytes} requested, ${legacyHeadroom} reserved for legacy runs, limit ${artifactLimitBytes}.`);
            }
            if (orphan) {
                // A death before the new live marker is published must not make
                // the old marker eligible to consume an equal-byte charge again.
                if (!orphanColumn()) ledger.exec("ALTER TABLE reservations ADD COLUMN last_orphan_source TEXT");
                ledger.query("UPDATE reservations SET survival = ?, generation = generation + 1, " +
                    "last_orphan_source = ? WHERE id = 1").run(reserveBytes, orphan.sourceRun);
            } else {
                write.run(reserveBytes);
            }
            return true;
        });
        await accountDisk(storage, {
            signal: orphan?.signal,
            ledger: {
                snapshot: () => snapshot.immediate(),
                reserve: orphan ? async (generation, used) => {
                    await orphan.assertQuiescent(orphan.signal);
                    return reserve.immediate(generation, used);
                } : (generation, used) => reserve.immediate(generation, used),
            },
        });
        const release = ledger.transaction(() => {
            write.run(0);
            owner!.close();
            owner = undefined;
        });
        return () => {
            if (!owner) return;
            try { release.immediate(); }
            finally {
                owner?.close();
                owner = undefined;
                ledger.close();
            }
        };
    } catch (error) {
        owner?.close();
        ledger.close();
        throw error;
    }
}
