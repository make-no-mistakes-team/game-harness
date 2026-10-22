export type VerificationTier = "unit" | "integration" | "native-game" | "agent-acceptance";
export type EvaluationPurpose = "ordinary_acceptance" | "api_control" | "comparison" | "justified_acceptance";

/** Every live observer and runner consumes this same immutable budget. */
export interface EvaluationCaps {
  readonly hostRequestAdmissions: number;
  readonly runMs: number;
  readonly totalMs: number;
  readonly cleanupMs: number;
  readonly authMs: number;
  readonly discoveryMs: number;
  readonly startMs: number;
  readonly observationMs: number;
  readonly diagnosticsMs: number;
  readonly pollMs: number;
  readonly reportJsonBytes: number;
  readonly reportEventPages: number;
  readonly reportTracePages: number;
  readonly eventPageRecords: number;
  readonly tracePageRecords: number;
}

export interface DiscoveredEvaluationModel {
  readonly id: string;
}

export interface EvaluationConfig {
  readonly model: DiscoveredEvaluationModel;
  readonly purpose: EvaluationPurpose;
  readonly justification: string | null;
  readonly hypothesisId: string;
  readonly platformEvidenceRevision: string;
  readonly caps: EvaluationCaps;
  /** Catalog descriptors are not an invoice for subscription access. */
  readonly subscriptionMonetaryCost: null;
}

export type PlatformEvidenceKind = "source" | "schema" | "native_artifact" | "repro";
export interface PlatformEvidenceReference {
  readonly kind: PlatformEvidenceKind;
  /** A real local source/schema/artifact/reproduction file, not prose or a model ID. */
  readonly path: string;
}
export interface PlatformEvidenceAuthorization {
  readonly revision: string;
  readonly reason: string;
  readonly references: readonly PlatformEvidenceReference[];
}

/** Operator-attributed finding, not an automatic proof of causality or an agent failure. */
export interface PlatformFinding {
  readonly hypothesisId: string;
  readonly platform_status: "fail";
  readonly classification_reason: readonly string[];
  readonly reproductionCommand: string;
  readonly evidence: readonly { readonly path: string; readonly sha256: string }[];
}
