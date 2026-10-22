import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  PROGRAM_LIMITS,
  ProgramValidationError,
  validateProgramSource,
  validateSkill,
  validateSkillLimits,
} from "../src/server/program-validation.ts";
import {
  DEFAULT_SKILL_LIMITS,
  MAX_SKILL_LIMITS,
} from "../src/shared/programs.ts";
import type { SkillSpec } from "../src/shared/programs.ts";

function specification(
  source = 'return {status:"completed",summary:"Finished",result:null};',
): SkillSpec {
  return {
    name: "Composition fixture",
    source,
    card: {
      purpose: "Exercise program admission",
      applicability: "Unit test fixtures only",
      method: "Compose authorized capabilities",
      reason: "Check the public validation contract",
      limitations: "Does not establish gameplay effectiveness",
    },
    dependencies: [{ skill_id: "child-skill", version: 3 }],
  };
}

async function rejection(work: Promise<unknown>, code: string) {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ProgramValidationError);
    const validationError = error as ProgramValidationError;
    expect(validationError.issues.some((entry) => entry.code === code)).toBe(
      true,
    );
    return validationError;
  }
  throw new Error("Expected program admission to fail");
}

test("comment-looking strings, regexes, template text and metadata are not executable comments", async () => {
  const source = String.raw`
const text = "https://example.test/*literal*/";
const pattern = /\/\/|\/\*|\*\//;
const template = \`// plain text /* still plain text */\`;
return { status: "completed", summary: text, result: [pattern.source, template] };
`.replaceAll("\\`", "`");
  const spec = specification(source);
  spec.card.method = "Explain // and /* without changing executable source";
  const admitted = await validateSkill(spec);
  expect(admitted.source).toContain("https://example.test/*literal*/");
  expect(admitted.source).toContain("// plain text /* still plain text */");
  expect(admitted.card).toEqual(spec.card);
});

test("all executable line, block and template-expression comments are rejected with locations", async () => {
  for (const source of [
    "return null; // trailing note",
    "/* leading note */ return null;",
    "return `text ${1 /* hidden */}`;",
    "return /x/;\n// note",
    "return null;\n<!-- legacy line comment",
  ]) {
    const error = await rejection(
      validateProgramSource(source, "skill"),
      "comments_forbidden",
    );
    expect(error.issues[0]?.location?.line).toBeGreaterThanOrEqual(1);
    expect(error.issues[0]?.location?.column).toBeGreaterThanOrEqual(1);
  }
});

test("async bodies can observe, await local helpers, and compose exact skill references", async () => {
  const admitted = await validateSkill(
    specification(`
async function inspect() { return await game.observe(); }
const observation = await inspect();
await game.progress("Observed", {present: Boolean(observation)});
return await game.call({skill_id: "child-skill", version: 3}, args);
`),
  );
  expect(admitted.source).toContain("await game.observe()");
  expect(admitted.source).toContain("await game.call(");
  expect(admitted.dependencies).toEqual([
    { skill_id: "child-skill", version: 3 },
  ]);
  expect(admitted.validation.complexity).toBe(1);
});

test("imports, exports and dynamic imports are prohibited in every function", async () => {
  for (const source of [
    'import fs from "node:fs"; return null;',
    "export const value = 1;",
    'return await import("node:fs");',
    'async function nested() { return await import("node:fs"); } return nested();',
    "return import.meta;",
  ]) {
    await rejection(validateProgramSource(source, "skill"), "forbidden_syntax");
  }
});

test("ambient APIs are forbidden but ordinary property names and literal text are allowed", async () => {
  for (const source of [
    "return process.env;",
    'return await fetch("https://example.test");',
    'return require("node:fs");',
    "return globalThis;",
    "return window;",
    "return Function('return 1')();",
    "return eval('1');",
    "return this;",
    'return (() => import("node:fs"))();',
  ]) {
    const expected =
      source.includes("this") || source.includes("import(")
        ? "forbidden_syntax"
        : "forbidden_api";
    await rejection(validateProgramSource(source, "skill"), expected);
  }
  await validateProgramSource(
    'return {process:"fetch", require:"import", nested: args.process};',
    "skill",
  );
  await rejection(
    validateProgramSource("return {process};", "skill"),
    "forbidden_api",
  );
  await rejection(
    validateProgramSource('return args["x"] + globalThis;', "skill"),
    "forbidden_api",
  );
});

test("syntax errors and wrapper escapes return safe structured errors without source echoes", async () => {
  const secret = "PRIVATE_FIXTURE_VALUE";
  for (const source of [`const ${secret} = ;`, `} ${secret}(); {`]) {
    const error = await rejection(
      validateProgramSource(source, "skill"),
      "invalid_syntax",
    );
    expect(JSON.stringify(error.issues)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
    expect(error.issues[0]).toHaveProperty("location");
    expect(error.issues[0]).toHaveProperty("limit");
  }
});

test("canonical nonblank line limits cannot be bypassed with minification", async () => {
  const accepted = await validateProgramSource(
    "args;".repeat(PROGRAM_LIMITS.formatted_lines),
    "skill",
  );
  expect(accepted.validation.formatted_lines).toBe(
    PROGRAM_LIMITS.formatted_lines,
  );
  const error = await rejection(
    validateProgramSource(
      "args;".repeat(PROGRAM_LIMITS.formatted_lines + 1),
      "skill",
    ),
    "formatted_lines_limit",
  );
  expect(error.issues[0]?.limit).toEqual({ maximum: 80, actual: 81 });
  const whitespace = await validateProgramSource(
    "\n\nargs;\n\nreturn null;\n\n",
    "skill",
  );
  expect(whitespace.validation.formatted_lines).toBe(2);
});

test("source bounds count UTF-8 bytes and apply to exact canonical bytes as well", async () => {
  const prefix = 'return "';
  const suffix = '";\n';
  const source =
    prefix +
    "x".repeat(
      PROGRAM_LIMITS.source_bytes - Buffer.byteLength(prefix + suffix),
    ) +
    suffix;
  const admitted = await validateProgramSource(source, "skill");
  expect(Buffer.byteLength(admitted.source)).toBe(PROGRAM_LIMITS.source_bytes);
  await rejection(
    validateProgramSource(source + " ", "skill"),
    "source_bytes_limit",
  );
  await rejection(
    validateProgramSource(`return "${"😀".repeat(5000)}";`, "skill"),
    "source_bytes_limit",
  );
  const canonicalExpansion = `return "${"x".repeat(PROGRAM_LIMITS.source_bytes - 10)}";`;
  expect(Buffer.byteLength(canonicalExpansion)).toBe(
    PROGRAM_LIMITS.source_bytes,
  );
  await rejection(
    validateProgramSource(canonicalExpansion, "skill"),
    "source_bytes_limit",
  );
});

test("statement nesting accepts four levels and rejects five even on one line", async () => {
  const nested = (depth: number) =>
    "if (args) {".repeat(depth) + "return null;" + "}".repeat(depth);
  const admitted = await validateProgramSource(nested(4), "skill");
  expect(admitted.validation.nesting).toBe(4);
  await rejection(validateProgramSource(nested(5), "skill"), "nesting_limit");
  await rejection(
    validateProgramSource("{".repeat(5) + "args;" + "}".repeat(5), "skill"),
    "nesting_limit",
  );
});

test("cyclomatic complexity is bounded per function rather than aggregated across helpers", async () => {
  const branches = (count: number) => "if (args) args;".repeat(count);
  const admitted = await validateProgramSource(
    branches(11) + "return null;",
    "skill",
  );
  expect(admitted.validation.complexity).toBe(12);
  await rejection(
    validateProgramSource(branches(12), "skill"),
    "complexity_limit",
  );
  const helpers = await validateProgramSource(
    `function first() {${branches(7)}} function second() {${branches(7)}} return null;`,
    "skill",
  );
  expect(helpers.validation.complexity).toBe(8);
  await rejection(
    validateProgramSource(
      `function helper() {${branches(12)}} return null;`,
      "skill",
    ),
    "complexity_limit",
  );
  await rejection(
    validateProgramSource(
      "return " + Array(13).fill("args").join(" && ") + ";",
      "skill",
    ),
    "complexity_limit",
  );
});

test("canonical source, byte hash and source/config fingerprint are deterministic and idempotent", async () => {
  const one = await validateProgramSource(
    "const value=await game.observe();return value;",
    "skill",
  );
  const two = await validateProgramSource(
    "const value = await game.observe();\nreturn value;",
    "skill",
  );
  const three = await validateProgramSource(one.source, "skill");
  expect(one).toEqual(two);
  expect(one).toEqual(three);
  expect(one.hash).toBe(createHash("sha256").update(one.source).digest("hex"));
  expect(one.validation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const skill = await validateProgramSource("return null;", "skill");
  const policy = await validateProgramSource("return null;", "policy");
  expect(skill.source).toBe(policy.source);
  expect(skill.validation.fingerprint).not.toBe(policy.validation.fingerprint);
  await validateProgramSource(
    'const next = await Promise.resolve(state); return {kind:"continue", reason: context.reason};',
    "policy",
  );
});

test("canonicalization preserves multiline template literal contents including leading spaces", async () => {
  const source = "return `first\n  indented\nplain\n    four spaces`;";
  const admitted = await validateProgramSource(source, "skill");
  expect(new Function(admitted.source)()).toBe(
    "first\n  indented\nplain\n    four spaces",
  );
  expect(await validateProgramSource(admitted.source, "skill")).toEqual(
    admitted,
  );
});

test("canonicalization preserves ordinary locally tagged css, html and gql template values", async () => {
  const source = [
    "const css = (strings) => strings[0];",
    "const html = (strings) => strings[0];",
    "const gql = (strings) => strings[0];",
    "return [",
    "css`a{color:red; margin:0}` ,",
    'html`<div   class="fixture"><span> value </span></div>`,',
    "gql`query Fixture{viewer{id name}}`",
    "];",
  ].join("\n");
  const admitted = await validateProgramSource(source, "skill");
  expect(new Function(admitted.source)()).toEqual([
    "a{color:red; margin:0}",
    '<div   class="fixture"><span> value </span></div>',
    "query Fixture{viewer{id name}}",
  ]);
});

test("skill metadata requires a full strict StrategyCard and nonblank bounded name", async () => {
  const valid = specification();
  await validateSkill(valid);
  for (const spec of [
    { ...valid, name: " " },
    { ...valid, name: "x".repeat(81) },
    { ...valid, unexpected: true },
    { ...valid, card: { purpose: "Only one field" } },
    { ...valid, card: { ...valid.card, limitations: " " } },
    { ...valid, card: { ...valid.card, method: "x".repeat(2001) } },
    { ...valid, card: { ...valid.card, source: "Not a card field" } },
  ]) {
    await rejection(validateSkill(spec), "invalid_metadata");
  }
});

test("dependencies require unique exact immutable positive safe integer versions", async () => {
  const valid = specification();
  for (const dependencies of [
    [{ skill_id: "child-skill", version: "latest" }],
    [{ skill_id: "child-skill", version: 0 }],
    [{ skill_id: "child-skill", version: -1 }],
    [{ skill_id: "child-skill", version: 1.5 }],
    [{ skill_id: "child-skill", version: Infinity }],
    [{ skill_id: "child-skill", version: Number.MAX_SAFE_INTEGER + 1 }],
    [{ skill_id: " ", version: 1 }],
    [{ skill_id: "child-skill", version: 1, range: "*" }],
  ]) {
    await rejection(
      validateSkill({ ...valid, dependencies }),
      "invalid_metadata",
    );
  }
  await rejection(
    validateSkill({
      ...valid,
      dependencies: [valid.dependencies[0], valid.dependencies[0]],
    }),
    "invalid_dependencies",
  );
  const admitted = await validateSkill(valid);
  valid.dependencies[0]!.version = 99;
  expect(admitted.dependencies).toEqual([
    { skill_id: "child-skill", version: 3 },
  ]);
  expect(admitted.validation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

test("configurable execution limits accept exact finite bounds and reject host maximum escapes", () => {
  expect(validateSkillLimits(DEFAULT_SKILL_LIMITS)).toEqual(
    DEFAULT_SKILL_LIMITS,
  );
  expect(validateSkillLimits(MAX_SKILL_LIMITS)).toEqual(MAX_SKILL_LIMITS);
  expect(
    validateSkillLimits({
      duration_ms: 1,
      max_actions: 1,
      max_calls: 1,
      max_depth: 1,
    }),
  ).toEqual({
    duration_ms: 1,
    max_actions: 1,
    max_calls: 1,
    max_depth: 1,
  });
  for (const field of [
    "duration_ms",
    "max_actions",
    "max_calls",
    "max_depth",
  ] as const) {
    for (const value of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      MAX_SKILL_LIMITS[field] + 1,
    ]) {
      expect(() =>
        validateSkillLimits({ ...DEFAULT_SKILL_LIMITS, [field]: value }),
      ).toThrow(ProgramValidationError);
    }
  }
  expect(() =>
    validateSkillLimits({ ...DEFAULT_SKILL_LIMITS, extra: 1 }),
  ).toThrow(ProgramValidationError);
});
