import { expect, test } from "bun:test";
import { applySourceEdits, sourceEditsSchema } from "../src/server/source-authoring.ts";
import { PROGRAM_LIMITS, ProgramValidationError } from "../src/server/program-validation.ts";
import { preparationFailure } from "../src/server/prepared-source-error.ts";

function failure(source: string, edits: unknown): ProgramValidationError {
  try { applySourceEdits(source, edits); }
  catch (error) {
    if (error instanceof ProgramValidationError) return error;
    throw error;
  }
  throw new Error("Expected exact-edit rejection");
}

test("exact edits compose sequentially, preserve surrounding bytes and allow deletion", () => {
  const source = 'export const answer = 40;\nconst label = "😀 untouched";\n';
  const edited = applySourceEdits(source, [
    { old_text: "answer = 40", new_text: "answer = 41" },
    { old_text: "answer = 41", new_text: "answer = 42" },
    { old_text: '\nconst label = "😀 untouched";', new_text: "" },
  ]);
  expect(edited).toBe("export const answer = 42;\n");
  expect(applySourceEdits(source, [{ old_text: "40", new_text: "42" }]))
    .toBe('export const answer = 42;\nconst label = "😀 untouched";\n');
});

test("missing, repeated and overlapping matches reject without selecting an occurrence", () => {
  for (const [source, old_text] of [["abc", "missing"], ["same same", "same"], ["aaa", "aa"]]) {
    const error = failure(source!, [{ old_text: old_text!, new_text: "replacement" }]);
    expect(error.issues).toMatchObject([{ code: "invalid_source_edit", path: "edits.0.old_text" }]);
  }
  const error = failure("first second", [
    { old_text: "first", new_text: "second" },
    { old_text: "second", new_text: "replacement" },
  ]);
  expect(error.issues).toMatchObject([{ code: "invalid_source_edit", path: "edits.1.old_text" }]);
});

test("UTF-8 growth refuses at the real byte limit, not the JavaScript string length", () => {
  const source = "x".repeat(PROGRAM_LIMITS.source_bytes);
  expect(applySourceEdits(source, [{ old_text: source, new_text: "é".repeat(8192) }]))
    .toBe("é".repeat(8192));
  const error = failure(source, [{ old_text: source, new_text: "é".repeat(8193) }]);
  expect(error.issues).toMatchObject([{ code: "source_bytes_limit",
    limit: { maximum: 16384, actual: 16386 } }]);
  const oversized = failure(source + "x", [{ old_text: "not present", new_text: "" }]);
  expect(oversized.issues).toMatchObject([{ code: "source_bytes_limit",
    limit: { maximum: 16384, actual: 16385 } }]);
});

test("UTF-8 accounting recomputes surrogate boundaries changed by an edit", () => {
  const joined = applySourceEdits("a".repeat(16377) + "\ud83dX\ude00", [{ old_text: "X", new_text: "" }]);
  expect(joined).toBe("a".repeat(16377) + "😀");
  expect(Buffer.byteLength(joined, "utf8")).toBe(16381);
  const source = "a".repeat(16380) + "😀";
  const error = failure(source, [{ old_text: "\ud83d", new_text: "XX" }]);
  expect(error.issues).toMatchObject([{ code: "source_bytes_limit",
    limit: { maximum: 16384, actual: 16385 } }]);
});

test("edit failures do not echo source, search text or replacement literals", () => {
  const secret = "PRIVATE_SOURCE_LITERAL";
  const error = failure(`const value="${secret}";`, [{ old_text: secret + "_missing", new_text: secret }]);
  expect(JSON.stringify(preparationFailure(error))).not.toContain(secret);
  expect(error.issues[0]!.location).toBeNull();
});

test("exact edit envelopes reject empty needles, unknown operations and unbounded batches", () => {
  for (const edits of [[], [{ old_text: "", new_text: "x" }],
    [{ old_text: "x", new_text: "y", fuzzy: true }],
    Array.from({ length: 17 }, () => ({ old_text: "x", new_text: "y" })),
    [{ old_text: "x", new_text: "y".repeat(16385) }]])
    expect(sourceEditsSchema.safeParse(edits).success).toBe(false);
});
