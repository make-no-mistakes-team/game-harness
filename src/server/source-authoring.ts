import { z } from "zod";
import type { SkillSpec } from "../shared/programs.ts";
import { PROGRAM_LIMITS, ProgramValidationError } from "./program-validation.ts";

const utf8 = new TextEncoder();

/** Task material explicitly supplied by the operator, not a hydrated sourcebook. */
export type ApprovedSourceReference = Readonly<{
  hash: string;
  source: string;
  entry: "run" | "step" | "analyze" | "library";
  card: SkillSpec["card"];
  provenance: string;
}>;

export const sourceEditsSchema = z.array(z.object({
  old_text: z.string().min(1).max(PROGRAM_LIMITS.source_bytes),
  new_text: z.string().max(PROGRAM_LIMITS.source_bytes),
}).strict()).min(1).max(16)
  .describe("Sequential exact replacements in the selected canonical source. Every old_text must occur exactly once at that step. No fuzzy matching, inferred fixes or partial commits.");

/** All-or-nothing text computation; ordinary validation and CAS still own saving. */
export function applySourceEdits(source: string, rawEdits: unknown): string {
  const edits = sourceEditsSchema.parse(rawEdits);
  const maximum = PROGRAM_LIMITS.source_bytes;
  let result = source;
  const bytes = utf8.encode(source).byteLength;
  if (bytes > maximum) throw new ProgramValidationError([{
    code: "source_bytes_limit", message: "Selected source exceeds the UTF-8 byte limit.",
    location: null, limit: { maximum, actual: bytes },
  }]);
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;
    const start = result.indexOf(edit.old_text);
    if (start < 0 || result.indexOf(edit.old_text, start + 1) >= 0)
      throw new ProgramValidationError([{
        code: "invalid_source_edit", message: start < 0
          ? "Exact source edit has no match; inspect the selected canonical version."
          : "Exact source edit is ambiguous; include enough context to match exactly once.",
        path: `edits.${index}.old_text`, location: null, limit: null,
      }]);
    const next = result.slice(0, start) + edit.new_text + result.slice(start + edit.old_text.length);
    // Exact edits can split surrogate pairs. Count the bytes actually encoded,
    // including replacement characters for newly unpaired UTF-16 code units.
    const nextBytes = utf8.encode(next).byteLength;
    if (nextBytes > maximum) throw new ProgramValidationError([{
      code: "source_bytes_limit", message: "Edited source exceeds the UTF-8 byte limit.",
      path: `edits.${index}`, location: null, limit: { maximum, actual: nextBytes },
    }]);
    result = next;
  }
  return result;
}
