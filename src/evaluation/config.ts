import type { DiscoveredEvaluationModel, EvaluationCaps, EvaluationConfig, EvaluationPurpose } from "./contracts.ts";

export const DEFAULT_EVALUATION_CAPS: EvaluationCaps = Object.freeze({
  hostRequestAdmissions: 30,
  runMs: 300_000,
  totalMs: 24 * 60_000,
  cleanupMs: 25_000,
  authMs: 30_000,
  discoveryMs: 60_000,
  startMs: 90_000,
  observationMs: 10_000,
  diagnosticsMs: 6_000,
  pollMs: 100,
  reportJsonBytes: 33_554_432,
  reportEventPages: 128,
  reportTracePages: 128,
  eventPageRecords: 500,
  tracePageRecords: 100,
});

export interface EvaluationConfigInput {
  discoveredModels: readonly DiscoveredEvaluationModel[];
  modelId?: string;
  purpose: EvaluationPurpose;
  justification?: string;
  hypothesisId: string;
  platformEvidenceRevision: string;
  caps?: Partial<EvaluationCaps>;
}

export function evaluationIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value))
    throw new Error(`${field} must be a stable nonempty identifier (at most 200 characters)`);
  return value;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Shared finite resource validation, independent of diagnostic/study identity. */
export function createEvaluationCaps(input: Partial<EvaluationCaps> = {}): EvaluationCaps {
  const caps = { ...DEFAULT_EVALUATION_CAPS, ...input };
  for (const [key, value] of Object.entries(caps)) {
    if (!(key in DEFAULT_EVALUATION_CAPS) || !Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Evaluation cap ${key} must be a finite positive integer`);
  }
  // Store clamps both APIs to 500; accepting larger requests can falsely imply a complete event page.
  if (caps.eventPageRecords > 500) throw new Error("eventPageRecords cannot exceed the Store page limit of 500");
  if (caps.tracePageRecords > 500) throw new Error("tracePageRecords cannot exceed the Store page limit of 500");
  if (caps.runMs > caps.totalMs) throw new Error("Run deadline cannot exceed the entire evaluation deadline");
  if (caps.pollMs > caps.runMs) throw new Error("Observation polling cannot exceed the run deadline");
  return Object.freeze(caps);
}

export function createEvaluationConfig(input: EvaluationConfigInput): EvaluationConfig {
  const purposes: readonly string[] = ["ordinary_acceptance", "api_control", "comparison", "justified_acceptance"];
  if (!purposes.includes(input.purpose)) throw new Error("Choose an explicit evaluation purpose");
  const id = input.modelId ?? "gpt-6-luna";
  const discovered = input.discoveredModels.find(model => model.id === id);
  if (!discovered) throw new Error(`Model ${id} is not in actual discovery; no fallback is permitted`);
  const justification = input.justification?.trim() || null;
  if (id !== "gpt-6-luna" && (!input.modelId || input.purpose === "ordinary_acceptance" || !justification))
    throw new Error("A non-Luna model requires an explicit discovered ID, control/comparison/justified-acceptance purpose and justification");
  if (input.purpose !== "ordinary_acceptance" && !justification)
    throw new Error("Control, comparison and justified acceptance require a recorded justification");
  const caps = createEvaluationCaps(input.caps);
  return freezeDeep({
    model: structuredClone(discovered), purpose: input.purpose, justification,
    hypothesisId: evaluationIdentifier(input.hypothesisId, "hypothesisId"),
    platformEvidenceRevision: evaluationIdentifier(input.platformEvidenceRevision, "platformEvidenceRevision"),
    caps, subscriptionMonetaryCost: null,
  });
}
