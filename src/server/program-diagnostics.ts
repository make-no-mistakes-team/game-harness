import { RuntimeFault } from "./runtime-fault.ts";

/** The same bounded public failure is sent to generated code and retained as evidence. */
export function capabilityFailure(error: unknown): { code: string; message: string } {
  return error instanceof RuntimeFault
    ? { code: error.code, message: error.message.slice(0, 1000) }
    : { code: "backend_unavailable", message: "Trusted capability could not complete safely" };
}

export interface ProgramDiagnostic {
  type: string; message: string; source_hash: string; location: { mapping: "unmapped" }; code?: string;
}
export class ProgramExecutionError extends Error {
  constructor(readonly diagnostic: ProgramDiagnostic) { super(diagnostic.message); this.name = "ProgramExecutionError"; }
}
export function programDiagnostic(error: unknown, sourceHash: string): ProgramDiagnostic {
  if (error instanceof ProgramExecutionError) return { ...error.diagnostic, source_hash: sourceHash };
  if (error instanceof RuntimeFault) return { type: "RuntimeFault", code: error.code,
    message: error.message.slice(0, 1000), source_hash: sourceHash, location: { mapping: "unmapped" } };
  // Only the worker's validated diagnostic and explicitly safe host faults carry
  // messages. Arbitrary host errors can contain paths, environment or secrets.
  return { type: "ExecutionFailure", message: "Generated program or trusted capability failed; host exception details are not exposed",
    source_hash: sourceHash, location: { mapping: "unmapped" } };
}
export function readProgramDiagnostic(value: unknown, sourceHash: string): ProgramDiagnostic {
  const data = value as Partial<ProgramDiagnostic> | null;
  if (!data || typeof data !== "object" || typeof data.type !== "string" || data.type.length > 80 ||
    typeof data.message !== "string" || data.message.length > 1000 || data.source_hash !== sourceHash || data.location?.mapping !== "unmapped")
    throw new Error("Invalid generated failure diagnostic");
  return { type: data.type, message: data.message, source_hash: sourceHash, location: { mapping: "unmapped" },
    ...(typeof data.code === "string" && /^[a-z_]{1,80}$/.test(data.code) ? { code: data.code } : {}) };
}
