import { types } from "node:util";
import type { ResidentSourceDiagnostic, ResidentSourceAdvisory } from "../shared/resident.ts";

export type ResidentWorkerFaultOrigin = "watchdog" | "source_throw" | "transport" | "opaque" | "cleanup";
const residentSourceDiagnostics = new WeakMap<object, ResidentSourceDiagnostic>();
const residentWorkerFailures = new WeakMap<object, { error: string; code: ResidentWorkerFaultOrigin }>();

export function readResidentSourceDiagnostic(value: unknown, sourceHash?: string | null): ResidentSourceDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value))
    throw new Error("Invalid resident source diagnostic.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== 4 ||
    !["type", "message", "source_hash", "location"].every(key => descriptors[key] && "value" in descriptors[key]))
    throw new Error("Invalid resident source diagnostic.");
  const type: unknown = descriptors.type!.value, message: unknown = descriptors.message!.value;
  const hash: unknown = descriptors.source_hash!.value, location: unknown = descriptors.location!.value;
  if (typeof type !== "string" ||
    !["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError", "ThrownValue"].includes(type) ||
    typeof message !== "string" || message.length > 1000 ||
    typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || sourceHash !== undefined && hash !== sourceHash ||
    !location || typeof location !== "object" || Array.isArray(location) || types.isProxy(location))
    throw new Error("Invalid resident source diagnostic.");
  const mapping = Object.getOwnPropertyDescriptors(location);
  if (Reflect.ownKeys(location).length !== 1 || !mapping.mapping || !("value" in mapping.mapping) ||
    mapping.mapping.value !== "unmapped" || Reflect.ownKeys(value).length !== 4)
    throw new Error("Invalid resident source diagnostic.");
  return Object.freeze({ type: type as ResidentSourceDiagnostic["type"], message, source_hash: hash,
    location: Object.freeze({ mapping: "unmapped" as const }) });
}

/** The category is selected at a worker-service boundary, never from authored exception text.
 * Only host/guardian faults have trustedOrigin; container diagnostics are advisory. */
export class ResidentWorkerFault extends Error {
  readonly sourceDiagnostic?: ResidentSourceDiagnostic;
  constructor(readonly origin: ResidentWorkerFaultOrigin, readonly trustedOrigin: boolean = true,
    sourceDiagnostic?: unknown) {
    super(`Resident worker failed (${origin}).`);
    this.name = "ResidentWorkerFault";
    residentWorkerFailures.set(this, { error: this.message, code: origin });
    if (sourceDiagnostic !== undefined) {
      if (origin !== "source_throw" || trustedOrigin !== false)
        throw new Error("Invalid resident source diagnostic origin.");
      this.sourceDiagnostic = readResidentSourceDiagnostic(sourceDiagnostic);
      residentSourceDiagnostics.set(this, this.sourceDiagnostic);
    }
  }
}

/** Explicit projection of validated, source-authored advice, never host authority. */
export function residentSourceAdvisory(error: unknown): ResidentSourceAdvisory | undefined {
  if (!error || typeof error !== "object") return undefined;
  const diagnostic = residentSourceDiagnostics.get(error);
  return diagnostic ? { advisory: true, trusted_origin: false, origin: "source_throw",
    diagnostic: { ...diagnostic, location: { mapping: "unmapped" } } } : undefined;
}

/** The branded category and advisory are separate from arbitrary exception properties. */
export function residentWorkerFailure(error: unknown): {
  error: string; code: string; source_diagnostic?: ResidentSourceAdvisory;
} | undefined {
  if (!error || typeof error !== "object") return undefined;
  const failure = residentWorkerFailures.get(error);
  if (!failure) return undefined;
  const source_diagnostic = residentSourceAdvisory(error);
  return { ...failure, ...(source_diagnostic ? { source_diagnostic } : {}) };
}
