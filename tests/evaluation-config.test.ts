import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvaluationConfig, DEFAULT_EVALUATION_CAPS, loadEvidenceProfile } from "../src/evaluation/config.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const profile = () => ({ schema_version: 1, recording: { maxPendingRawBytes: 134217728,
  maxFrames: 60000, maxStoredFrameBytes: 34359738368, maxDurationMs: 2000000 },
  journal: { maxTextBytes: 2147483648, maxPendingBytes: 16777216, maxImageBytes: 34359738368, maxImages: 12000 },
  render_timeout_ms: 300000 });
function project() { const root = mkdtempSync(join(tmpdir(), "evidence-profile-")); roots.push(root); return root; }

test("evidence file loading preserves raw identity and freezes validated nested limits", () => {
  const root = project(), bytes = ` ${JSON.stringify(profile(), null, 2)}\n`;
  writeFileSync(join(root, "long.json"), bytes);
  const loaded = loadEvidenceProfile(root, "long.json");
  expect(loaded.source).toEqual({ path: "long.json", sha256: createHash("sha256").update(bytes).digest("hex") });
  expect(loaded.profile.recording.maxFrames).toBe(60000);
  expect(Object.isFrozen(loaded.profile.recording)).toBe(true);
  expect(Object.isFrozen(loaded.profile.journal)).toBe(true);
  expect(Object.isFrozen(loaded.profile)).toBe(true);
});

test("omitted evidence profile is local immutable identity and performs no file creation", () => {
  const root = project(), loaded = loadEvidenceProfile(root);
  expect(loaded.source.path).toBeNull();
  expect(loaded.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.isFrozen(loaded.profile)).toBe(true);
  expect(Object.isFrozen(loaded.profile.recording)).toBe(true);
  expect(loadEvidenceProfile(root).source.sha256).toBe(loaded.source.sha256);
});

test("evidence profiles reject incomplete, unknown, unsafe and oversized declarations without exposing contents", () => {
  const root = project();
  for (const bad of [{ ...profile(), journal: {} }, { ...profile(), unexpected: "PRIVATE_MARKER" },
    { ...profile(), recording: { ...profile().recording, maxFrames: 0.5 } },
    { ...profile(), journal: { ...profile().journal, maxPendingBytes: 67108865 } }]) {
    writeFileSync(join(root, "bad.json"), JSON.stringify(bad));
    expect(() => loadEvidenceProfile(root, "bad.json")).toThrow("Evidence profile");
    try { loadEvidenceProfile(root, "bad.json"); } catch (error) { expect(String(error)).not.toContain("PRIVATE_MARKER"); }
  }
  writeFileSync(join(root, "bad.json"), "PRIVATE_MARKER".repeat(2000));
  expect(() => loadEvidenceProfile(root, "bad.json")).toThrow("Evidence profile");
});

test("evidence profiles never inspect foreign, symlinked, directory or secret paths", () => {
  const root = project(), foreign = project();
  writeFileSync(join(foreign, "foreign.json"), JSON.stringify(profile()));
  writeFileSync(join(root, "valid.json"), JSON.stringify(profile()));
  symlinkSync(join(root, "valid.json"), join(root, "alias.json"));
  mkdirSync(join(root, "auth"));
  for (const name of [".env", ".env.local", "gameharness.sqlite", "credentials.json", "auth/config.json"])
    writeFileSync(join(root, name), JSON.stringify(profile()));
  for (const name of [join(foreign, "foreign.json"), "alias.json", "auth", ".env", ".env.local",
    "gameharness.sqlite", "credentials.json", "auth/config.json"])
    expect(() => loadEvidenceProfile(root, name)).toThrow("Evidence profile");
});

test("acceptance admits an explicit evidence profile flag but never in admission-only mode", async () => {
  const { parseAgentAcceptanceArguments } = await import("../scripts/agent-acceptance.ts");
  expect(parseAgentAcceptanceArguments(["--hypothesis", "bounded", "--evidence-revision", "r1",
    "--evidence-profile", "long.json"]).evidenceProfile).toBe("long.json");
  expect(() => parseAgentAcceptanceArguments(["--admission-only", "--study", "study", "--manifest", "study.json",
    "--slot", '{"arm":"a","initial_state_id":"b","repetition":1}', "--evidence-profile", "long.json"])).toThrow("Admission-only");
});

test("acceptance rejects a profile below the requested capture horizon before opening auth or native resources", async () => {
  const { runAgentAcceptance } = await import("../scripts/agent-acceptance.ts");
  const root = project();
  writeFileSync(join(root, "small.json"), JSON.stringify({ ...profile(),
    recording: { ...profile().recording, maxFrames: 30, maxDurationMs: 1000 } }));
  await expect(runAgentAcceptance({ allowNative: true, allowInference: true,
    authDirectory: join(root, "auth-does-not-exist"), projectRoot: root, evidenceProfile: "small.json",
    hypothesisId: "bounded", platformEvidenceRevision: "r1" })).rejects.toThrow("Evidence profile");
});

const discoveredModels = [{ id: "gpt-6-luna", cost: null }, { id: "gpt-6.1-sol", cost: { input: 0, output: 0 } }];
const base = { discoveredModels, purpose: "ordinary_acceptance" as const, hypothesisId: "natural-wood-r1", platformEvidenceRevision: "platform-r1" };

test("ordinary acceptance selects the exact discovered Luna and shares immutable finite caps", () => {
  const config = createEvaluationConfig(base);
  expect(config.model.id).toBe("gpt-6-luna");
  expect(config.caps.hostRequestAdmissions).toBe(30);
  expect(config.caps).toEqual(DEFAULT_EVALUATION_CAPS);
  expect(Object.isFrozen(config)).toBe(true);
  expect(Object.isFrozen(config.caps)).toBe(true);
  expect(Object.isFrozen(config.model)).toBe(true);
  expect(config.subscriptionMonetaryCost).toBeNull();
});

test("an unavailable default or explicit ID never falls back to another model", () => {
  expect(() => createEvaluationConfig({ ...base, discoveredModels: [{ id: "gpt-6.1-sol" }] })).toThrow("no fallback");
  expect(() => createEvaluationConfig({ ...base, modelId: "gpt-6.1-sol-latest" })).toThrow("no fallback");
});

test("Sol is an explicit justified finite control/comparison, never an ordinary default", () => {
  expect(() => createEvaluationConfig({ ...base, modelId: "gpt-6.1-sol" })).toThrow("non-Luna");
  expect(() => createEvaluationConfig({ ...base, modelId: "gpt-6.1-sol", purpose: "comparison" })).toThrow("justification");
  const config = createEvaluationConfig({ ...base, modelId: "gpt-6.1-sol", purpose: "api_control", justification: "One bounded production-tool control", caps: { hostRequestAdmissions: 7, runMs: 50_000 } });
  expect(config.model.id).toBe("gpt-6.1-sol");
  expect(config.caps.hostRequestAdmissions).toBe(7);
  expect(config.subscriptionMonetaryCost).toBeNull();
});

test("unknown catalog pricing and zero catalog descriptors cannot become a paid invoice", () => {
  const unknown = createEvaluationConfig(base);
  const catalogZero = createEvaluationConfig({ ...base, modelId: "gpt-6.1-sol", purpose: "justified_acceptance", justification: "A declared bounded higher-capability sample" });
  expect(unknown.subscriptionMonetaryCost).toBeNull();
  expect(catalogZero.subscriptionMonetaryCost).toBeNull();
});

test("all caps reject nonfinite, fractional and disabled limits", () => {
  for (const cap of Object.keys(DEFAULT_EVALUATION_CAPS)) {
    for (const invalid of [0, -1, Infinity, NaN, 0.5])
      expect(() => createEvaluationConfig({ ...base, caps: { [cap]: invalid } })).toThrow("finite positive integer");
  }
  expect(() => createEvaluationConfig({ ...base, caps: { runMs: 200, totalMs: 100 } })).toThrow("entire evaluation");
});

test("page budgets respect real Store limits so truncated requests cannot appear complete", () => {
  const maximum = createEvaluationConfig({ ...base, caps: { eventPageRecords: 500, tracePageRecords: 500 } });
  expect(maximum.caps.eventPageRecords).toBe(500);
  expect(maximum.caps.tracePageRecords).toBe(500);
  expect(() => createEvaluationConfig({ ...base, caps: { eventPageRecords: 501 } })).toThrow("eventPageRecords cannot exceed");
  expect(() => createEvaluationConfig({ ...base, caps: { tracePageRecords: 501 } })).toThrow("tracePageRecords cannot exceed");
});
