import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync, statfsSync } from "node:fs";
import path from "node:path";
import { evaluationPaths } from "../src/evaluation/paths.ts";

const project = path.resolve(import.meta.dir, "..");
const local = path.join(project, "local");
const privateRoot = path.join(local, "survival-pilot");
export const artifactLimitBytes = 300_000_000_000;
type Lane = "survival" | "diagnostic";
type Reservations = { generation: number } & Record<Lane, number>;
const lanes = ["survival", "diagnostic"] as const;
// The legacy development runner can start independently of either pilot lane.
const legacyHeadroom = 50 * 1024 ** 3;

/** GNU du counts allocated disk blocks, including files from failed and pre-pilot runs.
 * Unknown material is counted conservatively, never adopted or deleted. */
async function diskBytes(roots: string[]) {
    const existing = [...new Set(roots.filter(existsSync).map(p => realpathSync(p)))];
    const distinct = existing.filter(root => !existing.some(other => root.startsWith(other + "/")));
    if (!distinct.length) return 0;
    const child = Bun.spawn(["du", "-s", "-c", "-B1", "--", ...distinct], { stdout: "pipe", stderr: "ignore" });
    const [text, rc] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const total = Number(text.trimEnd().split("\n").at(-1)?.split("\t")[0]);
    if (rc !== 0 || !Number.isSafeInteger(total) || total < 0) throw new Error("Cannot account for existing run storage");
    return total;
}

function tryOwner(lane: Lane): Database | undefined {
    // Keep the original survival lock so we still exclude runners started before
    // the shared ledger existed. Neither lock database is unlinked or replaced.
    const owner = new Database(path.join(privateRoot, lane === "survival" ? "owner.sqlite" : "diagnostic-owner.sqlite"),
        { create: true });
    try {
        owner.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        return owner;
    } catch (error) {
        owner.close();
        if ((error as { code?: string }).code === "SQLITE_BUSY") return;
        throw error;
    }
}

function checkOwners(state: Reservations, requested: Lane, take: boolean) {
    let owner: Database | undefined;
    try {
        for (const lane of lanes) {
            const probe = tryOwner(lane);
            if (!probe) {
                if (!state[lane]) throw new Error(`The ${lane} lane is locked without a shared reservation; wait for its owner to stop.`);
                if (lane === requested) throw new Error(`The ${lane} lane already has an active run.`);
                continue;
            }
            if (!state[lane] && lane === requested && take) {
                owner = probe;
                continue;
            }
            probe.close();
            if (state[lane]) {
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

/** Reserve space before starting any writers; release only after all have drained. */
export async function admitRun(reserveBytes: number, lane: Lane = "survival"): Promise<() => void> {
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes <= 0) throw new Error("Invalid run disk reservation");
    if (lane !== "survival" && lane !== "diagnostic") throw new Error("Invalid pilot lane");
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const ledger = new Database(path.join(privateRoot, "admission.sqlite"), { create: true });
    let owner: Database | undefined;
    try {
        ledger.exec(`
            PRAGMA busy_timeout = 5000;
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
        const snapshot = ledger.transaction(() => {
            const state = read.get()!;
            checkOwners(state, lane, false);
            return state.generation;
        });
        const roots = evaluationPaths(project);
        const storage = [local, roots.runtimeRoot, roots.reportsRoot, roots.governanceRoot,
            ...(process.env.GAMEHARNESS_DATA_DIR ? [path.resolve(process.env.GAMEHARNESS_DATA_DIR)] : [])];
        const reserve = ledger.transaction((generation: number, used: number) => {
            const state = read.get()!;
            if (state.generation !== generation) return false;
            owner = checkOwners(state, lane, true);
            if (!owner) throw new Error(`Could not acquire the ${lane} lane.`);
            // Charge full reservations on top of the scan: active payloads can
            // grow while du walks them, so the scan gives no safe per-run credit.
            const reserved = state.survival + state.diagnostic;
            const fs = statfsSync(privateRoot, { bigint: true });
            if (used + reserved + reserveBytes + legacyHeadroom > artifactLimitBytes ||
                fs.bavail * fs.bsize < BigInt(reserved) + BigInt(reserveBytes) + 1024n ** 3n) {
                throw new Error(`Insufficient storage: ${used} bytes counted, ${reserved} reserved for pilot runs, ` +
                    `${reserveBytes} requested, ${legacyHeadroom} reserved for legacy runs, limit ${artifactLimitBytes}.`);
            }
            write.run(reserveBytes);
            return true;
        });
        for (;;) {
            const generation = snapshot.immediate();
            const used = await diskBytes(storage);
            // Scan outside the ledger transaction. A run could even start and
            // finish during the scan, so validate the generation, not just the
            // current reservation totals, before admitting another writer.
            if (reserve.immediate(generation, used)) break;
        }
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
