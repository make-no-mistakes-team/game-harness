import { RuntimeFault } from "./runtime-fault.ts";
import type { Json } from "../shared/contracts.ts";
import type { SkillResult, ProgramOutputFailure } from "../shared/programs.ts";
import { jsonSchema, skillResultSchema } from "../shared/validation.ts";
import { controllerStepResultSchema, type ControllerStepResult } from "../shared/resident.ts";
import { residentDecisionSchema, residentActivationResultSchema, residentJsonConstraint, type ResidentJsonConstraint,
  type ResidentDecision, type ResidentActivationResult, type ResidentSourceAdvisory } from "../shared/resident.ts";
import type { ZodIssue } from "zod";
import { residentWorkerFailure } from "./resident-worker-fault.ts";

/** The same bounded public failure is sent to generated code and retained as evidence. */
export function capabilityFailure(error: unknown): { code: string; message: string } {
  return error instanceof RuntimeFault
    ? { code: error.code, message: error.message.slice(0, 1000) }
    : { code: "backend_unavailable", message: "Trusted capability could not complete safely" };
}

export interface ProgramDiagnostic {
  type: string; message: string; source_hash: string; location: { mapping: "unmapped" }; code?: string;
  issues?: { code: string; path: string; constraint?: ResidentJsonConstraint["constraint"]; maximum?: number; actual?: number }[];
  result_path?: "result.rejected_result";
  output?: ProgramOutputFailure;
  source_diagnostic?: ResidentSourceAdvisory;
  advisory?: true;
  trusted_origin?: false;
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
  constructor(readonly issues: NonNullable<ProgramDiagnostic["issues"]>, surface = "step") {
    super(`Generated ${surface} return does not match ${surface === "activation"
      ? "{choice,next_state,status,events} (legacy input also allowed), or {refused:true,reason}; refused:false is not acceptance"
      : "{input or choice,next_state,status,events}"}. Invalid fields: ${issues.map(issue =>
        `${issue.path || "<root>"} (${issue.code}${issue.constraint ? `; ${issue.constraint}${issue.maximum !== undefined ? ` maximum=${issue.maximum}` : ""}` : ""})`).join(", ")}. See help controller/programs for the exact result contract.`.slice(0, 1000));
    this.name = "GeneratedControllerResultValidationError";
  }
}

/** Only classify an actual generated return, never an arbitrary host Zod error.
 * Report the closest union branch without retaining values or validator messages. */
export function parseGeneratedControllerResult(value: unknown): ControllerStepResult {
  const parsed = controllerStepResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new GeneratedControllerResultValidationError(generatedReturnIssues(parsed.error.issues));
}

export function parseGeneratedResidentResult(value: unknown, activation: true): ResidentActivationResult;
export function parseGeneratedResidentResult(value: unknown, activation?: false): ResidentDecision;
export function parseGeneratedResidentResult(value: unknown, activation = false): ResidentActivationResult {
  const parsed = (activation ? residentActivationResultSchema : residentDecisionSchema).safeParse(value);
  if (parsed.success) return parsed.data;
  throw new GeneratedControllerResultValidationError(generatedReturnIssues(parsed.error.issues), activation ? "activation" : "executive");
}

function generatedReturnIssues(issues: readonly ZodIssue[]): NonNullable<ProgramDiagnostic["issues"]> {
  type Issues = NonNullable<ProgramDiagnostic["issues"]>;
  let visited = 0;
  const collect = (input: readonly ZodIssue[], prefix: string, depth: number): Issues => {
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
      for (const entry of branch ?? [{ code: issue.code, path, ...residentJsonConstraint(issue) }])
        if (result.length < 16 && !result.some(existing => existing.code === entry.code && existing.path === entry.path))
          result.push(entry);
    }
    return result;
  };
  return collect(issues, "", 0);
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
  if (error instanceof ProgramExecutionError) {
    // Finite-program wire diagnostics cannot establish resident fault custody.
    const { source_diagnostic: _advisory, advisory: _workerAdvice, trusted_origin: _workerOrigin, ...diagnostic } = error.diagnostic;
    return { ...diagnostic, source_hash: sourceHash };
  }
  if (error instanceof RuntimeFault) return { type: "RuntimeFault", code: error.code,
    message: error.message.slice(0, 1000), source_hash: sourceHash, location: { mapping: "unmapped" } };
  const workerFailure = residentWorkerFailure(error);
  if (workerFailure?.code === "watchdog" || workerFailure?.code === "source_throw" ||
    workerFailure?.code === "invalid_return_json") return {
    type: "ResidentWorkerFailure", code: `resident_${workerFailure.code}`,
    message: workerFailure.error, source_hash: sourceHash, location: { mapping: "unmapped" },
    ...(workerFailure.advisory ? { advisory: true, trusted_origin: false } : {}),
    ...(workerFailure.source_diagnostic?.diagnostic.source_hash === sourceHash
      ? { source_diagnostic: workerFailure.source_diagnostic } : {}),
  };
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
    ...(Array.isArray(data.issues) ? { issues: data.issues.slice(0, 16).flatMap(issue => {
      if (!issue || typeof issue !== "object" || typeof issue.code !== "string" || !/^[a-z_]{1,80}$/.test(issue.code) ||
        typeof issue.path !== "string" || issue.path.length > 160) return [];
      // Wire diagnostics have no object identity. Admit only the bounded public
      // vocabulary, never validator params/messages or additional properties.
      const constraint = issue.code === "custom" &&
        (issue.constraint === "plain_data" ||
          issue.constraint === "depth" && issue.maximum === 32 ||
          issue.constraint === "utf8_bytes" && [16384, 65536, 262144].includes(issue.maximum!))
        ? issue.constraint : undefined;
      return [{ code: issue.code, path: issue.path,
        ...(constraint ? { constraint } : {}),
        ...(constraint && constraint !== "plain_data" ? { maximum: issue.maximum }
          : constraint === undefined && issue.code === "too_big" && Number.isSafeInteger(issue.maximum) && issue.maximum! >= 0
            ? { maximum: issue.maximum } : {}),
        ...(issue.code === "too_big" && Number.isSafeInteger(issue.actual) && issue.actual! >= 0 ? { actual: issue.actual } : {}),
      }];
    }) } : {}),
    ...(output ? { output: { phase: output.phase, reason: output.reason, maximum_bytes: output.maximum_bytes,
      actual_bytes: output.actual_bytes, completed_capability_calls: output.completed_capability_calls } } : {}),
    ...(typeof data.code === "string" && /^[a-z_]{1,80}$/.test(data.code) ? { code: data.code } : {}) };
}
