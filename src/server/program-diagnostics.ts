import { RuntimeFault } from "./runtime-fault.ts";
import type { Json } from "../shared/contracts.ts";
import type { SkillResult, ProgramOutputFailure } from "../shared/programs.ts";
import { jsonSchema, skillResultSchema } from "../shared/validation.ts";
import { controllerStepResultSchema, type ControllerStepResult } from "../shared/resident.ts";

/** The same bounded public failure is sent to generated code and retained as evidence. */
export function capabilityFailure(error: unknown): { code: string; message: string } {
  return error instanceof RuntimeFault
    ? { code: error.code, message: error.message.slice(0, 1000) }
    : { code: "backend_unavailable", message: "Trusted capability could not complete safely" };
}

export interface ProgramDiagnostic {
  type: string; message: string; source_hash: string; location: { mapping: "unmapped" }; code?: string;
  issues?: { code: string; path: string; maximum?: number; actual?: number }[];
  result_path?: "result.rejected_result";
  output?: ProgramOutputFailure;
}
export class ProgramExecutionError extends Error {
  constructor(readonly diagnostic: ProgramDiagnostic) { super(diagnostic.message); this.name = "ProgramExecutionError"; }
}
export class GeneratedResultValidationError extends ProgramExecutionError {
  constructor(diagnostic: ProgramDiagnostic, readonly rejectedResult: Json | null) {
    super(diagnostic); this.name = "GeneratedResultValidationError";
  }
}

export class GeneratedControllerResultValidationError extends Error {
  constructor(readonly issues: NonNullable<ProgramDiagnostic["issues"]>) {
    super(`Generated step return does not match {input,next_state,status,events}. Invalid fields: ${issues.map(issue => `${issue.path || "<root>"} (${issue.code})`).join(", ")}. See help controller/programs for the exact result contract.`.slice(0, 1000));
    this.name = "GeneratedControllerResultValidationError";
  }
}

/** Only classify an actual generated return, never an arbitrary host Zod error.
 * Report the closest union branch without retaining values or validator messages. */
export function parseGeneratedControllerResult(value: unknown): ControllerStepResult {
  const parsed = controllerStepResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  type Issue = (typeof parsed.error.issues)[number];
  type Issues = NonNullable<ProgramDiagnostic["issues"]>;
  let visited = 0;
  const collect = (input: readonly Issue[], prefix: string, depth: number): Issues => {
    const result: Issues = [];
    for (const issue of input) {
      if (++visited > 128 || result.length >= 16) break;
      const ownPath = issue.path.map(String).join(".");
      const path = `${prefix}${prefix && ownPath ? "." : ""}${ownPath}`.slice(0, 80);
      let branch: Issues | null = null;
      if (issue.code === "invalid_union" && depth < 8) {
        for (const candidate of issue.errors) {
          const next = collect(candidate, path, depth + 1);
          if (next.length && (!branch || next.length < branch.length)) branch = next;
        }
      }
      for (const entry of branch ?? [{ code: issue.code, path }])
        if (result.length < 16 && !result.some(existing => existing.code === entry.code && existing.path === entry.path))
          result.push(entry);
    }
    return result;
  };
  throw new GeneratedControllerResultValidationError(collect(parsed.error.issues, "", 0));
}

/** Only an actual returned generated value is classified here. Arbitrary host
 * Zod exceptions and malformed/oversized transport frames keep their old class. */
export function parseGeneratedSkillResult(value: unknown, sourceHash: string): SkillResult {
  const parsed = skillResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 16).map(issue => ({
    code: issue.code, path: issue.path.map(String).join(".").slice(0, 160),
    ...(issue.code === "too_big" && typeof issue.maximum === "number" ? { maximum: issue.maximum } : {}),
    ...(issue.path.length === 1 && issue.path[0] === "summary" && value !== null && typeof value === "object" &&
      "summary" in value && typeof value.summary === "string" ? { actual: value.summary.length } : {}),
  }));
  const json = jsonSchema.safeParse(value);
  const retained = json.success && Buffer.byteLength(JSON.stringify(json.data)) <= 64 * 1024 ? json.data : null;
  const overlong = issues.some(issue => issue.path === "summary" && issue.code === "too_big");
  throw new GeneratedResultValidationError({
    type: "GeneratedResultValidationError", code: "invalid_program_result",
    message: overlong
      ? `Generated SkillResult.summary exceeds 2000 characters. Return a brief summary and compact semantic facts in result; raw receipts remain in host execution evidence.${retained !== null ? " Rejected payload is retained at result.rejected_result." : ""}`
      : "Generated return does not match SkillResult {status,summary,result}. Return a brief summary (1–2000 characters) and compact semantic facts; the whole JSON frame plus newline must fit 65536 UTF-8 bytes.",
    source_hash: sourceHash, location: { mapping: "unmapped" }, issues,
    ...(retained !== null ? { result_path: "result.rejected_result" as const } : {}),
  }, retained);
}
export function programDiagnostic(error: unknown, sourceHash: string): ProgramDiagnostic {
  if (error instanceof GeneratedControllerResultValidationError) return {
    type: error.name, code: "invalid_program_result", message: error.message,
    issues: error.issues, source_hash: sourceHash, location: { mapping: "unmapped" },
  };
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
  const output = data.output;
  if (output !== undefined && (output === null || typeof output !== "object" ||
    data.type !== "ProgramOutputError" || data.code !== "program_output_limit" ||
    output.phase !== "terminal_result" || !["utf8_bytes", "json_depth", "json_serialization"].includes(output.reason) ||
    output.maximum_bytes !== 65536 || output.actual_bytes !== null && (!Number.isSafeInteger(output.actual_bytes) || output.actual_bytes < 0) ||
    !Number.isSafeInteger(output.completed_capability_calls) || output.completed_capability_calls < 0))
    throw new Error("Invalid terminal output diagnostic");
  return { type: data.type, message: data.message, source_hash: sourceHash, location: { mapping: "unmapped" },
    ...(output ? { output: { phase: output.phase, reason: output.reason, maximum_bytes: output.maximum_bytes,
      actual_bytes: output.actual_bytes, completed_capability_calls: output.completed_capability_calls } } : {}),
    ...(typeof data.code === "string" && /^[a-z_]{1,80}$/.test(data.code) ? { code: data.code } : {}) };
}
