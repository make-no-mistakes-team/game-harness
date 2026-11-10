import { z } from "zod";
import type { Json } from "../shared/contracts.ts";
import { ProgramValidationError } from "./program-validation.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { GeneratedControllerResultValidationError } from "./program-diagnostics.ts";
import { residentJsonConstraint } from "../shared/resident.ts";

/** Only explicit host-authored preparation preconditions may expose their text to a model. */
export class PreparedSourceFault extends Error {
  constructor(message: string) { super(message); this.name = "PreparedSourceFault"; }
}

export function preparationFailure(error: unknown): { error: string; code: string; issues?: Json; omitted_issues?: number } {
  if (error instanceof GeneratedControllerResultValidationError)
    return { error: error.message.slice(0, 1000), code: "invalid_program_result",
      issues: error.issues.slice(0, 16) as Json, omitted_issues: Math.max(0, error.issues.length - 16) };
  if (error instanceof PreparedSourceFault || error instanceof RuntimeFault)
    return { error: error.message.slice(0, 1000), code: error instanceof RuntimeFault ? error.code : "precondition_failed" };
  if (error instanceof z.ZodError || error instanceof ProgramValidationError) {
    const rows = error.issues.slice(0, 16).map(issue => ({ code: issue.code,
      message: error instanceof ProgramValidationError ? issue.message.slice(0, 500) : "Invalid preparation tool argument",
      ...("path" in issue && issue.path !== undefined &&
        (issue.code !== "custom" || residentJsonConstraint(issue) !== undefined) ? { path: Array.isArray(issue.path)
        ? issue.path.slice(0, 16).map(part => typeof part === "number" ? part : String(part).slice(0, 80))
        : String(issue.path).slice(0, 240) } : {}),
      ...("location" in issue ? { location: issue.location } : {}),
      ...("limit" in issue ? { limit: issue.limit } : {}),
      ...residentJsonConstraint(issue),
    }));
    return { error: error instanceof ProgramValidationError ? "Prepared source failed validation" : "Invalid preparation tool arguments",
      code: error instanceof ProgramValidationError ? "invalid_source" : "invalid_request",
      issues: rows as Json, omitted_issues: Math.max(0, error.issues.length - rows.length) };
  }
  return { error: "Preparation service failed; inspect its retained diagnostics",
    code: "service_failure" };
}
