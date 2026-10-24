import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as results from "../src/evaluation/results.ts";
import * as evidence from "../src/evaluation/model-evidence.ts";
import { createEvaluationConfig } from "../src/evaluation/config.ts";
import { AttemptLedger } from "../src/evaluation/policy.ts";

const roots: string[] = [];
const ledgers: AttemptLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const outcome = results.classifyEvaluation({ inferenceAdmitted: true, goalVerified: false,
  platformChecksComplete: true, providerError: false, providerSettled: false });
const legacyUsage = {
  admissions: 22, reported_messages: 22, coverage: "complete",
  uncached_input: 69635, cache_read: 103552, cache_write: 0, output: 3586,
  reported_subtotal: { uncached_input: 69635, cache_read: 103552, cache_write: 0, output: 3586 },
  wire_attempts: null, subscription_cost: null,
};
function readUsage(value: unknown): results.UsageMetrics | null {
  const reader = Reflect.get(results, "readUsageMetrics");
  expect(reader, "The shared historical reader must replace acceptance's structural cast").toBeFunction();
  return reader(value);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gameharness-usage-qualification-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/platform.ts"), "export const protocol = 1;\n");
  const ledger = new AttemptLedger(join(root, "governance"), { projectRoot: root });
  ledgers.push(ledger);
  const config = createEvaluationConfig({ discoveredModels: [{ id: "gpt-6-luna" }], purpose: "ordinary_acceptance",
    hypothesisId: "accounting-history-fixture", platformEvidenceRevision: "unchanged-platform" });
  const attempt = ledger.admitAttempt(config, { reportDirectory: "original-report" });
  ledger.settleAttempt(attempt.attemptId, { outcome, usage: legacyUsage, evidence: ["original-report.json"] });
  const reportPath = join(root, "original-report.json");
  // Preserve spelling, whitespace and original legacy semantics, not just parsed equality.
  writeFileSync(reportPath, `  ${JSON.stringify({ attempt_id: attempt.attemptId, outcome, usage: legacyUsage }, null, 2)}\n`);
  return { root, ledger, config, attempt, reportPath };
}

test("legacy complete means event coverage only; qualification preserves historical counters, outcome and settled rows", () => {
  const f = fixture();
  const bytes = readFileSync(f.reportPath);
  const attempts = JSON.stringify(f.ledger.listAttempts(f.config.hypothesisId));
  const revisions = JSON.stringify(f.ledger.listPlatformEvidence(f.config.hypothesisId));
  const qualified = readUsage(f.ledger.listAttempts(f.config.hypothesisId)[0]!.settlement!.usage);
  expect(qualified).toMatchObject({ schema_version: 2, admissions: 22, reported_messages: 22,
    event_coverage: "complete", consumption_coverage: "unknown",
    consumption_scope: "observed_logical_admissions",
    uncached_input: null, cache_read: null, cache_write: null, output: null,
    reported_subtotal: { uncached_input: 69635, cache_read: 103552, cache_write: 0, output: 3586 },
    wire_attempts: null, subscription_cost: null });
  expect(qualified).not.toHaveProperty("coverage");
  expect(readFileSync(f.reportPath)).toEqual(bytes);
  expect(JSON.stringify(f.ledger.listAttempts(f.config.hypothesisId))).toBe(attempts);
  expect(JSON.stringify(f.ledger.listPlatformEvidence(f.config.hypothesisId))).toBe(revisions);
  expect(f.ledger.listAttempts(f.config.hypothesisId)[0]!.settlement!.outcome).toEqual(outcome);
  expect(legacyUsage.coverage).toBe("complete");
  expect(() => f.ledger.settleAttempt(f.attempt.attemptId, { outcome, usage: qualified, evidence: [] })).toThrow("history is immutable");
});

test("a qualified legacy failure stays in cost-to-first-result without turning its subtotal into a consumption total", () => {
  const usage = readUsage(legacyUsage);
  const success = results.classifyEvaluation({ inferenceAdmitted: true, goalVerified: true,
    platformChecksComplete: true, providerError: false, providerSettled: true });
  const zero = readUsage({ schema_version: 2, admissions: 1, reported_messages: 1,
    consumption_scope: "observed_logical_admissions",
    event_coverage: "complete", consumption_coverage: "known", uncached_input: 0, cache_read: 0, cache_write: 0, output: 0,
    reported_subtotal: { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0 }, wire_attempts: null, subscription_cost: null });
  expect(results.costToResult([{ outcome, usage }, { outcome: success, usage: zero }, { outcome, usage }])).toMatchObject({
    attempts_to_result: 2, attempts_included: 2, unsuccessful_attempts_included: 1, admissions: 23,
    uncached_input: null, cache_read: null, cache_write: null, output: null,
    reported_subtotal: { uncached_input: 69635, cache_read: 103552, cache_write: 0, output: 3586 },
    subscription_cost: null, wire_attempts: null,
  });
});

test("version-aware reader preserves nullable v2 categories and rejects unsupported versions without mutating input", () => {
  const value = { schema_version: 2, admissions: 1, reported_messages: 1,
    consumption_scope: "observed_logical_admissions",
    event_coverage: "complete", consumption_coverage: "partial", uncached_input: null, cache_read: null, cache_write: null, output: 4,
    reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 4 }, wire_attempts: null, subscription_cost: null };
  const bytes = JSON.stringify(value);
  expect<unknown>(readUsage(value)).toEqual(value);
  expect(JSON.stringify(value)).toBe(bytes);
  expect(readUsage({ ...legacyUsage, schema_version: 999 })).toBeNull();
  expect(readUsage({ admissions: 1, coverage: "complete", reported_subtotal: {} })).toBeNull();
});

test("exclusive qualification artifact references original hash without rewriting reports, ledger or governance revisions", async () => {
  const f = fixture();
  const bytes = readFileSync(f.reportPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const attempts = JSON.stringify(f.ledger.listAttempts(f.config.hypothesisId));
  const revisions = JSON.stringify(f.ledger.listPlatformEvidence(f.config.hypothesisId));
  const writer = Reflect.get(evidence, "writeUsageQualification");
  expect(writer, "Accounting qualification is an exclusive artifact, never platform reauthorization").toBeFunction();
  const usage = readUsage(legacyUsage);
  if (usage === null) throw new Error("Legacy fixture must qualify before writing its derived artifact");
  const input = { directory: f.root, original: { attempt_id: f.attempt.attemptId,
    report_path: "original-report.json", sha256 }, usage,
    reasons: ["legacy_event_coverage_is_not_provider_consumption_proof", "aborted_sdk_zero_has_unknown_provenance"] };
  const filename: string = await writer(input);
  const artifactPath = join(f.root, filename);
  const artifactBytes = readFileSync(artifactPath);
  expect(JSON.parse(artifactBytes.toString())).toMatchObject({ original: input.original, usage: {
    consumption_coverage: "unknown", uncached_input: null, output: null, reported_subtotal: legacyUsage.reported_subtotal }, reasons: input.reasons });
  expect(statSync(artifactPath).mode & 0o077).toBe(0);
  await expect(writer(input)).rejects.toThrow();
  await expect(writer({ ...input, original: { ...input.original, sha256: "0".repeat(64) } })).rejects.toThrow("hash");
  expect(readFileSync(artifactPath)).toEqual(artifactBytes);
  expect(readFileSync(f.reportPath)).toEqual(bytes);
  expect(JSON.stringify(f.ledger.listAttempts(f.config.hypothesisId))).toBe(attempts);
  expect(JSON.stringify(f.ledger.listPlatformEvidence(f.config.hypothesisId))).toBe(revisions);
});
