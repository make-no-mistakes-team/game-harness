import { expect, test } from "bun:test";
import { createEvaluationConfig, DEFAULT_EVALUATION_CAPS } from "../src/evaluation/config.ts";

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
