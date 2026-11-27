import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { campaignBytes, campaignInventory, campaignRoots, createCampaignTables,
  developmentArtifactLimitBytes, hasCampaign } from "../src/agent/storage-campaign.ts";

test("a durable per-inode baseline excludes history without letting its deletion mask new files or in-place growth", async () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-campaign-"));
  const database = join(root, "policy.sqlite");
  const managed = join(root, "managed");
  mkdirSync(managed);
  const old = join(managed, "old");
  const growing = join(managed, "growing");
  writeFileSync(old, Buffer.alloc(256 * 1024, 1));
  writeFileSync(growing, Buffer.alloc(16 * 1024, 1));
  let ledger = new Database(database);
  try {
    createCampaignTables(ledger);
    const roots = campaignRoots([managed, join(managed, "nested"), managed]);
    expect(roots).toEqual([managed]);
    const baseline = (await campaignInventory(roots))!;
    expect(ledger.transaction(() => campaignBytes(ledger, roots, baseline, true)).immediate()).toBe(0);
    ledger.close();
    ledger = new Database(database);
    expect(hasCampaign(ledger, roots)).toBe(true);
    const before = statSync(growing).blocks * 512;
    rmSync(old);
    appendFileSync(growing, Buffer.alloc(32 * 1024, 1));
    const fresh = join(managed, "fresh");
    writeFileSync(fresh, Buffer.alloc(64 * 1024, 1));
    linkSync(fresh, join(managed, "same-allocation"));
    const allocated = (await campaignInventory(roots))!;
    const charged = campaignBytes(ledger, roots, allocated, false);
    expect(charged).toBeGreaterThanOrEqual(
      statSync(fresh).blocks * 512 + statSync(growing).blocks * 512 - before,
    );
    expect(charged).toBeLessThan(statSync(fresh).blocks * 1024);
    expect(developmentArtifactLimitBytes).toBe(400_000_000_000);
    expect(() => hasCampaign(ledger, [root])).toThrow("managed roots changed");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("new inode identities cannot inherit a historical allocation exclusion", () => {
  const ledger = new Database(":memory:");
  try {
    createCampaignTables(ledger);
    const roots = ["/managed"];
    campaignBytes(ledger, roots, new Map([["1:2:old-birth", 900_000]]), true);
    expect(campaignBytes(ledger, roots, new Map([["1:2:new-birth", 123_456]]), false)).toBe(123_456);
    expect(campaignBytes(ledger, roots, new Map([["1:2:old-birth", 950_000]]), false)).toBe(50_000);
  } finally { ledger.close(); }
});

test("metadata created or grown by first admission is new allocation, not historical baseline", () => {
  const ledger = new Database(":memory:");
  try {
    createCampaignTables(ledger);
    const roots = ["/managed"];
    const inventory = new Map([["historical", 100_000], ["new-owner", 4_096], ["grown-ledger", 16_384]]);
    const initialMetadata = new Map([["new-owner", 0], ["grown-ledger", 4_096]]);
    expect(campaignBytes(ledger, roots, inventory, true, initialMetadata)).toBe(16_384);
    expect(campaignBytes(ledger, roots, inventory, false)).toBe(16_384);
  } finally { ledger.close(); }
});

test("managed root aliases are canonicalized, internal symlinks are not followed, and absent roots are retained", async () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-roots-"));
  try {
    const managed = join(root, "managed");
    const outside = join(root, "outside");
    mkdirSync(managed);
    mkdirSync(outside);
    writeFileSync(join(outside, "private-payload"), Buffer.alloc(256 * 1024, 1));
    symlinkSync(outside, join(managed, "link"));
    symlinkSync(managed, join(root, "alias"));
    const roots = campaignRoots([join(root, "alias"), managed, join(root, "future")]);
    expect(roots).toEqual([join(root, "future"), managed]);
    const inventory = (await campaignInventory(roots))!;
    expect([...inventory.values()].reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(256 * 1024);
    mkdirSync(join(root, "future"));
    writeFileSync(join(root, "future", "new"), Buffer.alloc(32 * 1024, 1));
    const ledger = new Database(":memory:");
    try {
      createCampaignTables(ledger);
      campaignBytes(ledger, roots, inventory, true);
      expect(campaignBytes(ledger, roots, (await campaignInventory(roots))!, false)).toBeGreaterThanOrEqual(32 * 1024);
    } finally { ledger.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
