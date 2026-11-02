import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
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
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";
import { policySpecSchema } from "../src/shared/validation.ts";

const fixtureContract = minecraftTestAdapter();
test("browser-safe policy source validation retains exact UTF-8 byte bounds", () => {
  const spec = { backend: "javascript", choices: null, name: "UTF-8 schema boundary", priority: 0, interval_ms: 200,
    card: { purpose: "Byte contract", applicability: "Schema-only", method: "Count actual UTF-8", reason: "No Node browser dependency", limitations: "No execution claim" } };
  expect(policySpecSchema.safeParse({ ...spec, source: "😀".repeat(8192) }).success).toBe(true);
  expect(policySpecSchema.safeParse({ ...spec, source: "😀".repeat(8192) + "x" }).success).toBe(false);
  expect(policySpecSchema.safeParse({ ...spec, source: "é".repeat(16384) }).success).toBe(true);
  expect(policySpecSchema.safeParse({ ...spec, source: "é".repeat(16384) + "x" }).success).toBe(false);
});

function specification(
  source = 'return {status:"completed",summary:"Finished",result:null};',
): SkillSpec {
  return {
    entry: "run",
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

test("selected resident modules preserve helpers and literal semantics without source-format guessing", async () => {
  for (const kind of ["step", "analyze"] as const) {
    const parameters = kind === "step" ? "frame, state, intent" : "input";
    const source = `const label = \`first\n  literal indent\`;
function helper(value) { return value + 1; }
export function ${kind}(${parameters}) { return {label, count: helper(41)}; }`;
    const admitted = await validateProgramSource(source, kind, fixtureContract);
    const module = await import(`data:text/javascript;base64,${Buffer.from(admitted.source).toString("base64")}`);
    expect(module[kind](null, null, null)).toEqual({ label: "first\n  literal indent", count: 42 });
    expect(await validateProgramSource(admitted.source, kind, fixtureContract)).toEqual(admitted);
    await rejection(validateProgramSource("return null;", kind, fixtureContract), "invalid_syntax");
    await rejection(validateProgramSource(`export function ${kind === "step" ? "analyze" : "step"}() { return null; }`,
      kind, fixtureContract), "invalid_entry");
  }
});

test("resident module admission checks every helper and initializer and only one synchronous selected export", async () => {
  for (const source of [
    "export async function step(frame,state,intent) { return null; }",
    "export function* step(frame,state,intent) { yield null; }",
    "export default function step(frame,state,intent) { return null; }",
    "export function step(frame,state,intent) { return null; } export const extra = 1;",
    "const step = () => null; export {step};",
  ]) await rejection(validateProgramSource(source, "step", fixtureContract), "invalid_entry");
  for (const source of [
    'import x from "node:fs"; export function step(frame,state,intent) { return x; }',
    'function unused() { return import("node:fs"); } export function step(frame,state,intent) { return null; }',
    "const x = import.meta; export function step(frame,state,intent) { return null; }",
    "await Promise.resolve(); export function step(frame,state,intent) { return null; }",
  ]) await rejection(validateProgramSource(source, "step", fixtureContract), "forbidden_syntax");
  for (const source of [
    "const x = process.env; export function step(frame,state,intent) { return null; }",
    "function unused() { return fetch('https://example.test'); } export function step(frame,state,intent) { return null; }",
  ]) await rejection(validateProgramSource(source, "step", fixtureContract), "forbidden_api");
});

test("comment-looking strings, regexes, template text and metadata are not executable comments", async () => {
  const source = String.raw`
const text = "https://example.test/*literal*/";
const pattern = /\/\/|\/\*|\*\//;
const template = \`// plain text /* still plain text */\`;
return { status: "completed", summary: text, result: [pattern.source, template] };
`.replaceAll("\\`", "`");
  const spec = specification(source);
  spec.card.method = "Explain // and /* without changing executable source";
  const admitted = await validateSkill(spec, fixtureContract);
  expect(new Function(admitted.source)()).toMatchObject({
    summary: "https://example.test/*literal*/",
    result: [String.raw`\/\/|\/\*|\*\/`, "// plain text /* still plain text */"],
  });
  expect(admitted.card).toEqual(spec.card);
});

test("documented bodies admit executable comments without weakening body isolation", async () => {
  for (const source of [
    "return null; // trailing note",
    "/* leading note */ return null;",
    "return `text ${1 /* hidden */}`;",
    "return /x/;\n// note",
    "return null;\n<!-- legacy line comment",
    "<!-- leading legacy comment\nreturn null;\n--> closing legacy comment",
    'return "<!-- literal -->"; // keep literal markers',
  ]) {
    const admitted = await validateProgramSource(source, "skill", fixtureContract);
    expect(admitted.hash).toBe(createHash("sha256").update(admitted.source).digest("hex"));
    expect(await validateProgramSource(admitted.source, "skill", fixtureContract)).toEqual(admitted);
    expect(new Function(admitted.source)()).toEqual(new Function(source)());
  }
});

test("async bodies can observe, await local helpers, and compose named dependencies", async () => {
  const admitted = await validateSkill(specification(`
  async function inspect() { return await game.observe(); }
  const observation = await inspect();
  await game.progress("Observed", {present: Boolean(observation)});
  return await game.call({name: "child", version: 3}, args);
  `), fixtureContract);
  expect(admitted.dependencies).toEqual([
    { skill_id: "child-skill", version: 3 },
  ]);
});

test("imports, exports and dynamic imports are prohibited in every function", async () => {
  for (const source of [
    'import fs from "node:fs"; return null;',
    "export const value = 1;",
    'return await import("node:fs");',
    'async function nested() { return await import("node:fs"); } return nested();',
    "return import.meta;",
  ]) {
    await rejection(validateProgramSource(source, "skill", fixtureContract), "forbidden_syntax");
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
    await rejection(validateProgramSource(source, "skill", fixtureContract), expected);
  }
  await validateProgramSource('return {process:"fetch", require:"import", nested: args.process};', "skill", fixtureContract);
  await rejection(
    validateProgramSource("return {process};", "skill", fixtureContract),
    "forbidden_api",
  );
  await rejection(
    validateProgramSource('return args["x"] + globalThis;', "skill", fixtureContract),
    "forbidden_api",
  );
});

test("syntax errors and wrapper escapes return safe structured errors without source echoes", async () => {
  const secret = "PRIVATE_FIXTURE_VALUE";
  for (const source of [`const ${secret} = ;`, `} ${secret}(); {`]) {
    const error = await rejection(
      validateProgramSource(source, "skill", fixtureContract),
      "invalid_syntax",
    );
    expect(JSON.stringify(error.issues)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
    expect(error.issues[0]).toHaveProperty("location");
    expect(error.issues[0]).toHaveProperty("limit");
  }
});

test("ordinary coherent bodies may exceed eighty canonical lines within the byte cap", async () => {
  const body = `let total = 0;\n${"total += 1;\n".repeat(100)}return total;`;
  const admitted = await validateProgramSource(body, "skill", fixtureContract);
  expect(new Function(admitted.source)()).toBe(100);
});

test("source bounds count UTF-8 bytes and apply to exact canonical bytes as well", async () => {
  const sourceBytes = 16 * 1024;
  const prefix = 'return "';
  const suffix = '";\n';
  const source =
    prefix +
    "x".repeat(
      sourceBytes - Buffer.byteLength(prefix + suffix),
    ) +
    suffix;
  const admitted = await validateProgramSource(source, "skill", fixtureContract);
  expect(Buffer.byteLength(admitted.source)).toBe(sourceBytes);
  await rejection(
    validateProgramSource(source + " ", "skill", fixtureContract),
    "source_bytes_limit",
  );
  await rejection(
    validateProgramSource(`return "${"😀".repeat(5000)}";`, "skill", fixtureContract),
    "source_bytes_limit",
  );
  const canonicalExpansion = `return "${"x".repeat(sourceBytes - 10)}";`;
  expect(Buffer.byteLength(canonicalExpansion)).toBe(
    sourceBytes,
  );
  await rejection(
    validateProgramSource(canonicalExpansion, "skill", fixtureContract),
    "source_bytes_limit",
  );
});

test("ordinary nested control flow is admitted beyond four levels", async () => {
  const nested = (depth: number) =>
    "if (args) {".repeat(depth) + "return null;" + "}".repeat(depth);
  const admitted = await validateProgramSource(nested(7), "skill", fixtureContract);
  expect(new Function("args", admitted.source)(true)).toBeNull();
});

test("helper bodies with more than twelve branches preserve ordinary results", async () => {
  const source = `function count(value) {
    let result = 0;
    ${Array.from({ length: 20 }, (_, index) => `if (value > ${index}) result++;`).join("\n")}
    return result;
  }
  return count(args);`;
  const admitted = await validateProgramSource(source, "skill", fixtureContract);
  expect(new Function("args", admitted.source)(17)).toBe(17);
});

test("canonical source, byte hash and source/config fingerprint are deterministic and idempotent", async () => {
  const one = await validateProgramSource("const value=await game.observe();return value;", "skill", fixtureContract);
  const two = await validateProgramSource("const value = await game.observe();\nreturn value;", "skill", fixtureContract);
  const three = await validateProgramSource(one.source, "skill", fixtureContract);
  expect(one).toEqual(two);
  expect(one).toEqual(three);
  expect(one.hash).toBe(createHash("sha256").update(one.source).digest("hex"));
  expect(one.validation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const skill = await validateProgramSource("return null;", "skill", fixtureContract);
  const policy = await validateProgramSource("return null;", "policy", fixtureContract);
  expect(skill.source).toBe(policy.source);
  expect(skill.validation.fingerprint).not.toBe(policy.validation.fingerprint);
  await validateProgramSource('const next = await Promise.resolve(state); return {kind:"continue", reason: context.reason};', "policy", fixtureContract);
});

test("canonicalization preserves multiline template literal contents including leading spaces", async () => {
  const source = "return `first\n  indented\nplain\n    four spaces`;";
  const admitted = await validateProgramSource(source, "skill", fixtureContract);
  expect(new Function(admitted.source)()).toBe(
    "first\n  indented\nplain\n    four spaces",
  );
  expect(await validateProgramSource(admitted.source, "skill", fixtureContract)).toEqual(
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
  const admitted = await validateProgramSource(source, "skill", fixtureContract);
  expect(new Function(admitted.source)()).toEqual([
    "a{color:red; margin:0}",
    '<div   class="fixture"><span> value </span></div>',
    "query Fixture{viewer{id name}}",
  ]);
});

test("skill metadata requires a full strict StrategyCard and nonblank bounded name", async () => {
  const valid = specification();
  await validateSkill(valid, fixtureContract);
  for (const spec of [
    { ...valid, name: " " },
    { ...valid, name: "x".repeat(81) },
    { ...valid, unexpected: true },
    { ...valid, card: { purpose: "Only one field" } },
    { ...valid, card: { ...valid.card, limitations: " " } },
    { ...valid, card: { ...valid.card, method: "x".repeat(2001) } },
    { ...valid, card: { ...valid.card, source: "Not a card field" } },
  ]) {
    await rejection(validateSkill(spec, fixtureContract), "invalid_metadata");
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
      validateSkill({ ...valid, dependencies }, fixtureContract),
      "invalid_metadata",
    );
  }
  await rejection(
    validateSkill({
      ...valid,
      dependencies: [valid.dependencies[0], valid.dependencies[0]],
    }, fixtureContract),
    "invalid_dependencies",
  );
  const admitted = await validateSkill(valid, fixtureContract);
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
