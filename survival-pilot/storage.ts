import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync, statfsSync } from "node:fs";
import path from "node:path";
import { evaluationPaths } from "../src/evaluation/paths.ts";

const project = path.resolve(import.meta.dir, "..");
const local = path.join(project, "local");
const privateRoot = path.join(local, "survival-pilot");
export const artifactLimitBytes = 300_000_000_000;

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

/** One pilot at a time; the kernel releases the SQLite write lock if the owner dies. */
export async function admitRun(reserveBytes: number): Promise<() => void> {
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes <= 0) throw new Error("Invalid run disk reservation");
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const lock = new Database(path.join(privateRoot, "owner.sqlite"), { create: true });
    try {
        lock.exec("BEGIN IMMEDIATE");
        const roots = evaluationPaths(project);
        const used = await diskBytes([local, roots.runtimeRoot, roots.reportsRoot, roots.governanceRoot,
            ...(process.env.GAMEHARNESS_DATA_DIR ? [path.resolve(process.env.GAMEHARNESS_DATA_DIR)] : [])]);
        // The legacy development runner has its own admission lock. Leave its entire
        // 50 GiB budget headroom even if another process starts after this count.
        const parallelLegacyHeadroom = 50 * 1024 ** 3;
        const fs = statfsSync(privateRoot, { bigint: true });
        if (used + reserveBytes + parallelLegacyHeadroom > artifactLimitBytes ||
            fs.bavail * fs.bsize < BigInt(reserveBytes) + 1024n ** 3n)
            throw new Error(`Insufficient storage: ${used} bytes counted, ${reserveBytes} requested, ` +
                `${parallelLegacyHeadroom} reserved for concurrent legacy runs, limit ${artifactLimitBytes}`);
        return () => lock.close();
    } catch (error) { lock.close(); throw error; }
}
