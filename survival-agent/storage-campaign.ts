import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const developmentArtifactLimitBytes = 400_000_000_000;
const campaignName = "recovery-development";
type Inventory = Map<string, number>;

export function createCampaignTables(ledger: Database) {
    ledger.exec(`
        CREATE TABLE IF NOT EXISTS development_campaign (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            name TEXT NOT NULL,
            limit_bytes INTEGER NOT NULL,
            roots TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS development_baseline (
            identity TEXT PRIMARY KEY,
            bytes INTEGER NOT NULL CHECK (bytes >= 0)
        ) STRICT;
    `);
}

export function campaignRoots(roots: string[]) {
    const resolved = [...new Set(roots.map(root => {
        try { return realpathSync(root); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(root);
            throw new Error("Cannot resolve development artifact storage roots");
        }
    }))].sort();
    return resolved.filter(root => !resolved.some(other => root.startsWith(other + path.sep)));
}

export function hasCampaign(ledger: Database, roots: string[]) {
    const table = ledger.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'development_campaign'").get();
    if (!table) return false;
    const policy = ledger.query<{ name: string; limit_bytes: number; roots: string }, []>(
        "SELECT name, limit_bytes, roots FROM development_campaign WHERE id = 1").get();
    if (!policy) return false;
    if (policy.name !== campaignName || policy.limit_bytes !== developmentArtifactLimitBytes ||
        policy.roots !== JSON.stringify(roots))
        throw new Error("Development artifact campaign policy or managed roots changed; preserve its existing baseline.");
    return true;
}

/** Allocated blocks, not apparent file length. Never follow a symlink or read
 * artifact contents. Identity includes birth time so an inode reused after a
 * historical file is deleted does not inherit that file's exclusion. */
export async function campaignInventory(roots: string[], signal?: AbortSignal): Promise<Inventory | null> {
    const inventory: Inventory = new Map();
    async function visit(file: string, root = false): Promise<void> {
        signal?.throwIfAborted();
        let entry;
        try { entry = await lstat(file, { bigint: true }); }
        catch (error) {
            if (root && (error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        const identity = `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
        if (inventory.has(identity)) return;
        const bytes = Number(entry.blocks * 512n);
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid allocated storage size");
        inventory.set(identity, bytes);
        if (entry.isDirectory()) {
            for (const child of await readdir(file)) await visit(path.join(file, child));
        }
    }
    try {
        for (const root of roots) await visit(root, true);
        return inventory;
    } catch (error) {
        signal?.throwIfAborted();
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        const category = code === "EACCES" || code === "EPERM" ? "permission denied" :
            code === "EIO" ? "I/O error" : "inventory failed";
        throw new Error(`Cannot account for development artifact storage (${category})`);
    }
}

/** Called only inside the shared admission transaction after validating its
 * generation and owners. Historical deletions never offset a different entry's
 * new allocation; even in-place growth is charged independently per inode. */
export function campaignBytes(ledger: Database, roots: string[], inventory: Inventory, initialize: boolean,
    initialMetadata?: Inventory) {
    if (initialize) {
        ledger.query("INSERT INTO development_campaign (id, name, limit_bytes, roots) VALUES (1, ?, ?, ?)")
            .run(campaignName, developmentArtifactLimitBytes, JSON.stringify(roots));
        const insert = ledger.query("INSERT INTO development_baseline (identity, bytes) VALUES (?, ?)");
        let used = 0;
        for (const [identity, bytes] of inventory) {
            const historical = initialMetadata?.get(identity) ?? bytes;
            insert.run(identity, historical);
            used += Math.max(0, bytes - historical);
        }
        return used;
    }
    const baseline = ledger.query<{ bytes: number }, [string]>(
        "SELECT bytes FROM development_baseline WHERE identity = ?");
    let bytes = 0;
    for (const [identity, allocated] of inventory) {
        bytes += Math.max(0, allocated - (baseline.get(identity)?.bytes ?? 0));
        if (!Number.isSafeInteger(bytes)) throw new Error("Development artifact accounting exceeded a safe integer");
    }
    return bytes;
}
