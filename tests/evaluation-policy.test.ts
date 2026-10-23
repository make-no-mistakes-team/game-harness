import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvaluationConfig } from "../src/evaluation/config.ts";
import { AttemptLedger } from "../src/evaluation/policy.ts";
import type { EvaluationOutcome } from "../src/evaluation/results.ts";

const roots: string[] = [];
const ledgers: AttemptLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const discoveredModels = [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }];
const base = { discoveredModels, purpose: "ordinary_acceptance" as const, hypothesisId: "wood-platform-contract", platformEvidenceRevision: "initial" };
const failed: EvaluationOutcome = { platform_status: "pass", agent_status: "goal_not_verified", provider_status: "ok", goal_verified: false, classification_reason: ["Agent did not achieve the declared natural goal; no platform defect observed"] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gameharness-governance-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/platform.ts"), "export const protocol = 1;\n");
  const governance = join(root, "governance");
  const ledger = new AttemptLedger(governance, { projectRoot: root });
  ledgers.push(ledger);
  return { root, governance, ledger, config: createEvaluationConfig(base) };
}
function failTwice(ledger: AttemptLedger, config = createEvaluationConfig(base)) {
  for (let index = 0; index < 2; index++) {
    const attempt = ledger.admitAttempt(config, { reportDirectory: `fresh-report-${index}`, promptRevision: `prompt-${index}` });
    ledger.settleAttempt(attempt.attemptId, { outcome: failed, usage: null, evidence: [`report-${index}.json`] });
  }
}

test("two failures remain binding across report directories, prompt swaps and an explicit Sol comparison", () => {
  const { ledger, config } = fixture();
  failTwice(ledger, config);
  expect(() => ledger.admitAttempt(config, { reportDirectory: "entirely-new-world", promptRevision: "rewritten-prompt" })).toThrow("Two unsuccessful");
  const sol = createEvaluationConfig({ ...base, modelId: "gpt-6.1-sol", purpose: "comparison", justification: "Compare the same declared hypothesis" });
  expect(() => ledger.admitAttempt(sol, { reportDirectory: "fresh-sol-report" })).toThrow("Two unsuccessful");
  expect(() => ledger.admitAttempt(createEvaluationConfig({ ...base, platformEvidenceRevision: "pretend-new-revision" }), { reportDirectory: "fresh-report" })).toThrow("authorize concrete");
  expect(ledger.listAttempts(config.hypothesisId).map(attempt => attempt.settlement?.outcome.agent_status)).toEqual(["goal_not_verified", "goal_not_verified"]);
});

test("a real changed source plus reason authorizes one new revision without erasing old failures", () => {
  const { root, ledger, config } = fixture();
  failTwice(ledger, config);
  const request = { revision: "changed-protocol", reason: "Corrected protocol admission after the preserved failures", references: [{ kind: "source" as const, path: "src/platform.ts" }] };
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, request)).toThrow("has not changed");
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, { ...request, reason: "" })).toThrow("reason");
  writeFileSync(join(root, "src/platform.ts"), "export const protocol = 2;\n");
  ledger.authorizePlatformEvidence(config.hypothesisId, request);
  const next = createEvaluationConfig({ ...base, platformEvidenceRevision: request.revision });
  const reserved = ledger.admitAttempt(next, { reportDirectory: "new-evidence-report" });
  expect(reserved.platformEvidenceRevision).toBe("changed-protocol");
  expect(ledger.listAttempts(config.hypothesisId)).toHaveLength(3);
  expect(ledger.listPlatformEvidence(config.hypothesisId)).toHaveLength(2);
  ledger.interruptAttempt(reserved.attemptId, "Operator cancelled before completion");
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, request)).toThrow("reused");
  expect(() => ledger.admitAttempt(config, { reportDirectory: "old-baseline" })).toThrow("not current");
  writeFileSync(join(root, "src/platform.ts"), "export const protocol = 1;\n");
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, { ...request, revision: "replayed-original-source" })).toThrow("has not changed");
});

test("prompt-only references and stale external artifacts do not authorize a reset", () => {
  const { root, ledger, config } = fixture();
  const oldArtifact = join(root, "old-repro.json");
  writeFileSync(oldArtifact, JSON.stringify({
    hypothesisId: config.hypothesisId, platform_status: "fail", classification_reason: ["Historical protocol reproduction"],
    reproductionCommand: "bun run check:integration game-bridge.test.ts",
    evidence: [{ path: "src/platform.ts", sha256: createHash("sha256").update("export const protocol = 1;\n").digest("hex") }],
  }));
  utimesSync(oldArtifact, 1, 1);
  failTwice(ledger, config);
  writeFileSync(join(root, "src/runtime-prompt.ts"), 'export const prompt = "Try harder";');
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, { revision: "prompt-only", reason: "Reworded request", references: [{ kind: "source", path: "src/runtime-prompt.ts" }] })).toThrow("prompt/model");
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, { revision: "stale-repro", reason: "Reuse historical report", references: [{ kind: "repro", path: oldArtifact }] })).toThrow("has not changed");
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, { revision: "no-reference", reason: "Changed model only", references: [] })).toThrow("concrete changed");
  const modelReport = join(root, "new-model-report.json");
  writeFileSync(modelReport, JSON.stringify({ outcome: failed }));
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, { revision: "new-model-report", reason: "Another model failed the goal", references: [{ kind: "repro", path: modelReport }] })).toThrow("model/goal failure alone");
});

test("a newly captured concrete platform-failure reproduction is evidence, not a model-only allowance reset", () => {
  const { root, ledger, config } = fixture();
  failTwice(ledger, config);
  const repro = join(root, "new-protocol-repro.json");
  const receipt = join(root, "actual-protocol-receipt.json");
  const receiptBytes = JSON.stringify({ expected: "neutralization receipt", observed: "socket closed before acknowledgement", protocol_sequence: 17 });
  writeFileSync(receipt, receiptBytes);
  writeFileSync(repro, JSON.stringify({
    hypothesisId: config.hypothesisId, platform_status: "fail", classification_reason: ["Reproduced missing neutralization acknowledgement on real protocol admission"],
    reproductionCommand: "bun run check:integration game-bridge.test.ts",
    evidence: [{ path: receipt, sha256: createHash("sha256").update(receiptBytes).digest("hex") }],
  }));
  const baseline = Date.parse(ledger.listPlatformEvidence(config.hypothesisId)[0]!.authorizedAt);
  const stale = new Date(baseline - 1000), fresh = new Date(baseline + 1000);
  // Fixture chronology must not depend on filesystem timestamp resolution.
  utimesSync(repro, fresh, fresh);
  utimesSync(receipt, stale, stale);
  const authorization = { revision: "protocol-repro", reason: "New captured transport reproduction explains the earlier incomplete platform evidence", references: [{ kind: "repro" as const, path: repro }] };
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, authorization)).toThrow("has not changed");
  utimesSync(receipt, fresh, fresh);
  ledger.authorizePlatformEvidence(config.hypothesisId, authorization);
  expect(ledger.listPlatformEvidence(config.hypothesisId)[1]?.references[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(ledger.listAttempts(config.hypothesisId)).toHaveLength(2);
});

test("in-flight attempts count conservatively; interruptions and unknown pricing remain auditable and immutable", () => {
  const { ledger, config } = fixture();
  const first = ledger.admitAttempt(config, { reportDirectory: "first" });
  ledger.interruptAttempt(first.attemptId, "SIGTERM after provider admission; effects and usage uncertain");
  const second = ledger.admitAttempt(config, { reportDirectory: "second" });
  expect(() => ledger.admitAttempt(config, { reportDirectory: "third" })).toThrow("in-flight");
  const settled = ledger.settleAttempt(second.attemptId, { outcome: failed, usage: { actual_reported_usage: null, known_cost: null, subscription_monetary_cost: null }, evidence: [] });
  expect(settled.settlement?.usage).toEqual({ actual_reported_usage: null, known_cost: null, subscription_monetary_cost: null });
  expect(ledger.listAttempts(config.hypothesisId)[0]).toMatchObject({ state: "interrupted", interruption: "SIGTERM after provider admission; effects and usage uncertain" });
  expect(() => ledger.settleAttempt(first.attemptId, { outcome: failed, usage: null, evidence: [] })).toThrow("history is immutable");
  expect(() => ledger.interruptAttempt(second.attemptId, "Rewrite a settled result")).toThrow("history is immutable");
});

test("new evidence cannot hide or supersede another in-flight reservation", () => {
  const { root, ledger, config } = fixture();
  const first = ledger.admitAttempt(config, { reportDirectory: "running-attempt" });
  writeFileSync(join(root, "src/platform.ts"), "export const protocol = 3;\n");
  expect(() => ledger.authorizePlatformEvidence(config.hypothesisId, {
    revision: "changed-while-inflight", reason: "Real protocol source change still cannot erase active inference",
    references: [{ kind: "source", path: "src/platform.ts" }],
  })).toThrow("in-flight");
  expect(ledger.listAttempts(config.hypothesisId)[0]).toMatchObject({ attemptId: first.attemptId, state: "reserved" });
  expect(ledger.listPlatformEvidence(config.hypothesisId)).toHaveLength(1);
});

test("six independent processes atomically reserve only two attempts and restart never resets abandoned reservations", async () => {
  const { root, governance, ledger, config } = fixture();
  const modulePath = fileURLToPath(new URL("../src/evaluation/policy.ts", import.meta.url));
  const childSource = `
    import { AttemptLedger } from ${JSON.stringify(modulePath)};
    const ledger = new AttemptLedger(${JSON.stringify(governance)}, { projectRoot: ${JSON.stringify(root)} });
    try {
      const attempt = ledger.admitAttempt(${JSON.stringify(config)}, { reportDirectory: process.env.GAMEHARNESS_LEDGER_TEST_REPORT });
      console.log(JSON.stringify({ admitted: true, id: attempt.attemptId }));
    } catch (error) {
      if (!String(error).includes("Two unsuccessful")) throw error;
      console.log(JSON.stringify({ admitted: false }));
    } finally { ledger.close(); }
  `;
  const reserve = async (directory: string): Promise<{ admitted: boolean }> => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", childSource], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, GAMEHARNESS_LEDGER_TEST_REPORT: directory },
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return JSON.parse(stdout);
  };
  const outcomes = await Promise.all(Array.from({ length: 6 }, (_, index) => reserve(`fresh-directory-${index}`)));
  expect(outcomes.filter(outcome => outcome.admitted)).toHaveLength(2);
  expect(ledger.listAttempts(config.hypothesisId).map(attempt => attempt.state)).toEqual(["reserved", "reserved"]);
  expect(await reserve("restart-new-world-and-report")).toEqual({ admitted: false });
  expect(ledger.listAttempts(config.hypothesisId)).toHaveLength(2);
}, 30_000);
