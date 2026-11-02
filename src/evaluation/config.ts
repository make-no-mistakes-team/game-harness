import type { DiscoveredEvaluationModel, EvaluationCaps, EvaluationConfig, EvaluationPurpose } from "./contracts.ts";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { DEFAULT_EVIDENCE_PROFILE, evidenceProfileSchema, type EvidenceProfile } from "../shared/evidence-limits.ts";

export interface LoadedEvidenceProfile {
  profile: EvidenceProfile;
  source: { path: string | null; sha256: string };
}

function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Complete external declarations are checked locally before any resource owner opens. */
export function loadEvidenceProfile(projectRoot: string, filename?: string): LoadedEvidenceProfile {
  if (filename === undefined) return freezeDeep({ profile: DEFAULT_EVIDENCE_PROFILE,
    source: { path: null, sha256: createHash("sha256").update(canonicalJson(DEFAULT_EVIDENCE_PROFILE)).digest("hex") } });
  let descriptor: number | undefined;
  try {
    const project = realpathSync(projectRoot), absolute = path.resolve(project, filename);
    const relative = path.relative(project, absolute);
    if (!filename || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) ||
      /(?:^|[/\\])(?:auth|credentials?)(?:[./\\]|$)|(?:auth|gameharness)\.sqlite$|(?:^|[/\\])\.env(?:\.|$)|\.(?:sqlite|sqlite3|db)$/i.test(relative))
      throw new Error();
    const entry = lstatSync(absolute);
    if (!entry.isFile() || entry.isSymbolicLink() || realpathSync(absolute) !== absolute || entry.size > 16384) throw new Error();
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size > 16384) throw new Error();
    const readBounded = () => {
      const buffer = Buffer.allocUnsafe(16385);
      let count = 0;
      while (count < buffer.byteLength) {
        const received = readSync(descriptor!, buffer, count, buffer.byteLength - count, count);
        if (received === 0) break;
        count += received;
      }
      if (count > 16384) throw new Error();
      return buffer.subarray(0, count);
    };
    const bytes = readBounded();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = evidenceProfileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error();
    // Detect replacement/mutation between declaration validation and identity capture.
    const after = lstatSync(absolute), digest = createHash("sha256").update(bytes).digest("hex");
    if (!after.isFile() || after.isSymbolicLink() || realpathSync(absolute) !== absolute ||
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.byteLength ||
      createHash("sha256").update(readBounded()).digest("hex") !== digest) throw new Error();
    const finalEntry = lstatSync(absolute);
    if (!finalEntry.isFile() || finalEntry.isSymbolicLink() || finalEntry.dev !== opened.dev ||
      finalEntry.ino !== opened.ino || finalEntry.size !== bytes.byteLength || realpathSync(absolute) !== absolute) throw new Error();
    return freezeDeep({ profile: parsed.data, source: { path: relative.split(path.sep).join("/"), sha256: digest } });
  } catch { throw new Error("Evidence profile must be a complete valid bounded project-local regular JSON file, without symlinks or secret paths"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

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
