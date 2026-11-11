import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  ProgramValidationError,
  programFingerprint,
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
import { activeExecutableValidationSchema } from "../src/shared/adapter.ts";
import { PreparedSourcebook } from "../src/server/prepared-sourcebook.ts";
import { preparationFailure } from "../src/server/prepared-source-error.ts";

const fixtureContract = minecraftTestAdapter();
test("motion math requirements survive direct, aliased and computed binding access and alter immutable admission", async () => {
  for (const body of [
    "return motion.track(input.options,input.state);",
    "const math=motion; return math[input.method](input.options,input.state);",
    "const {track}=motion; return track(input.options,input.state);",
  ]) {
    const program = await validateProgramSource(`export function analyze(input) { ${body} }`, "analyze", fixtureContract);
    expect(program.validation.runtime_features).toEqual(["motion_track_v1"]);
    expect(program.validation.fingerprint).not.toBe(
      programFingerprint(program.hash, "analyze", program.validation.compatibility_hash!));
    expect(activeExecutableValidationSchema.safeParse(program.validation).success).toBe(true);
    expect(activeExecutableValidationSchema.safeParse({ ...program.validation,
      runtime_features: ["motion_track_v1", "motion_track_v1"] }).success).toBe(false);
    expect(activeExecutableValidationSchema.safeParse({ ...program.validation,
      runtime_features: ["motion_track_v2"] }).success).toBe(false);
  }
  const library = await validateProgramSource("export const tracking = motion.track;", "library", fixtureContract);
  expect(library.validation.runtime_features).toEqual(["pure_modules_v1", "motion_track_v1"]);
});

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

test("pure source writes reject nested shorthand typos before retaining any version", async () => {
  const source = [
    "export function step(f,s,intent) {",
    "  const t = f.native_tick;",
    "  function issue(action,ms,max,id) {",
    "    const key = 1, request = {action,ms};",
    "    s.pending = {key,request,tick,kind:action.kind,max,id};",
    "  }",
    "  return issue(intent.action,t,2,'pending');",
    "}",
  ].join("\n");
  const book = new PreparedSourcebook("a".repeat(64), fixtureContract, () => {}, () => {});
  const input = { ...specification(source), name: "scope admission", entry: "step", dependencies: [] };
  const error = await rejection(book.write(input, "scope-write", "request"), "unbound_identifier");
  expect(book.versions).toBe(0);
  expect(book.sourceBytes).toBe(0);
  const diagnostic = error.issues.find(entry => entry.code === "unbound_identifier")!;
  expect(diagnostic.message).toContain('"tick"');
  expect(diagnostic.location).toEqual({ line: 5, column: 30 });
  const feedback = preparationFailure(error);
  expect(feedback.code).toBe("invalid_source");
  expect(JSON.stringify(feedback.issues)).toBe(JSON.stringify(error.issues));
  for (const kind of ["step", "analyze", "library"] as const) {
    const selected = kind === "analyze" ? "export function analyze(input) { return {missing}; }" : source;
    await rejection(validateProgramSource(selected, kind, fixtureContract), "unbound_identifier");
  }
});

test("module free reads, calls, writes and computed expressions are admission errors", async () => {
  for (const body of [
    "return absent;",
    "return absent();",
    "absent = input; return null;",
    "absent++; return null;",
    "({value: absent} = input); return null;",
    "return {[absent]: input};",
    "return input[absent];",
    "return class { [absent]() {} };",
    "return class { field = absent; };",
    "return class { static { absent(); } };",
    "const {value = absent} = input; return value;",
    "const {[absent]: value} = input; return value;",
    "function nested(value = bodyOnly) { var bodyOnly = 1; return value; } return nested();",
    "{ let scoped = input; } return scoped;",
    "{ function scoped() {} } return scoped();",
    "try {} catch ({message}) {} return message;",
    "const value = function named() { return named; }; return named;",
    "const value = class Named { method() { return Named; } }; return Named;",
    "class Local { static { var hidden = 1; } } return hidden;",
  ]) {
    const error = await rejection(validateProgramSource(`export function analyze(input) { ${body} }`, "analyze", fixtureContract),
      "unbound_identifier");
    expect(error.issues.every(entry => entry.location !== null)).toBe(true);
  }
  await rejection(validateProgramSource("const unused = absent; export function analyze(input) { return input; }",
    "analyze", fixtureContract), "unbound_identifier");
});

test("pure modules resolve closures, hoisting, patterns, catch and class expression scopes", async () => {
  for (const body of [
    "const read = () => later + helper(); var later = 2; function helper() { return input.value; } return read();",
    "const read = () => later; let later = input.value; return read();",
    "if (input) { var shared = input.value; } return shared;",
    "let total = 0; outer: for (let index = 0; index < 2; index++) { if (index) continue outer; const read = () => index; total += read(); } return total;",
    "const seed = input.value; function nested({value = seed} = {}, [first = seed] = []) { return () => value + first; } return nested()();",
    "const fallback = 2; const {[input.key]: value = fallback, ...rest} = input; const [first = value, ...tail] = rest.values; return {value,first,tail};",
    "let result; try { throw input; } catch ({value: reason = 1, ...rest}) { result = (() => reason + rest.extra)(); } return result;",
    "const callable = function recurse(value) { return value ? recurse(value - 1) : input.value; }; return callable(1);",
    "const Type = class Named { field = input.value; #private = 1; method() { return Named; } static { const inner = Named; var local = inner; } }; return new Type().field;",
    "class Base {} class Child extends Base { [input.key]() { return Child; } static value = input.value; } return Child.value;",
    "const key = 'value'; return {absent: input.absent, [key]: input[key], method({value = 1}) { return value; }};",
    "switch (input.kind) { case 1: { const result = input.value; return result; } default: return null; }",
  ]) {
    await validateProgramSource(`export function analyze(input) { ${body} }`, "analyze", fixtureContract);
  }
  const admitted = await validateProgramSource(
    "export function analyze(input) { const closure = () => later + hoisted(); var later = 2; function hoisted() { return input; } return closure(); }",
    "analyze", fixtureContract);
  const module = await import(`data:text/javascript;base64,${Buffer.from(admitted.source).toString("base64")}`);
  expect(module.analyze(40)).toBe(42);
});

test("module scope admission distinguishes safe typeof probes from ordinary unknown references", async () => {
  for (const body of ["return typeof optionalFeature;", "return typeof (optionalFeature) === 'undefined';"])
    await validateProgramSource(`export function analyze(input) { ${body} }`, "analyze", fixtureContract);
  for (const body of [
    "return typeof optionalFeature.value;",
    "return typeof optionalFeature();",
    "return typeof (0, optionalFeature);",
    "return typeof optionalFeature === 'function' && optionalFeature();",
  ]) await rejection(validateProgramSource(`export function analyze(input) { ${body} }`, "analyze", fixtureContract), "unbound_identifier");
  await rejection(validateProgramSource("export function analyze(input) { return typeof process; }", "analyze", fixtureContract),
    "forbidden_api");
});

test("pure modules admit ECMAScript realm math and reject host-only globals", async () => {
  await validateProgramSource(`export function analyze(input) {
    return [Math, JSON, Object, Array, Number, Boolean, String, BigInt, Symbol, Date, RegExp, Intl,
      Map, Set, WeakMap, WeakSet, WeakRef, FinalizationRegistry, Promise, Proxy, Reflect,
      Iterator, Float16Array, DisposableStack, AsyncDisposableStack, SuppressedError,
      Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError,
      ArrayBuffer, DataView, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
      Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
      NaN, Infinity, undefined, parseInt, parseFloat, isFinite, isNaN, encodeURI, decodeURI,
      encodeURIComponent, decodeURIComponent, motion];
  }`, "analyze", fixtureContract);
  for (const name of ["URL", "TextEncoder", "performance", "structuredClone", "crypto", "game", "args"])
    await rejection(validateProgramSource(`export function analyze(input) { return ${name}; }`, "analyze", fixtureContract),
      "unbound_identifier");
  for (const body of ["return process;", "return fetch(input);", "return globalThis;", "return {console};",
    "const process = input; return process;", "return (() => arguments)();"])
    await rejection(validateProgramSource(`export function analyze(input) { ${body} }`, "analyze", fixtureContract), "forbidden_api");
});

test("unbound identifier feedback bounds names and issue count without echoing source values", async () => {
  const name = "missing".repeat(100);
  const error = await rejection(validateProgramSource(
    `export function analyze(input) { const secret = "PRIVATE_SOURCE_VALUE"; return [${name},${Array.from({ length: 40 }, (_, index) => `missing${index}`).join(",")}]; }`,
    "analyze", fixtureContract), "unbound_identifier");
  expect(error.issues).toHaveLength(16);
  expect(error.issues[0]!.message.length).toBeLessThan(200);
  expect(error.issues[0]!.message).toContain(name.slice(0, 80));
  expect(JSON.stringify(preparationFailure(error))).not.toContain("PRIVATE_SOURCE_VALUE");
  expect(JSON.stringify(error.issues)).not.toContain(name);
});

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

test("selected run rejects executive exports with bounded async-body contract facts and no retained source", async () => {
  const book = new PreparedSourcebook("a".repeat(64), fixtureContract, () => {}, () => {});
  const source = "export function step(frame,state,intent) { return 'PRIVATE_SOURCE_VALUE'; } export function activate(frame,state,intent) { return null; }";
  const error = await rejection(book.write({ ...specification(source), dependencies: [] }, "wrong-format", "request"), "forbidden_syntax");
  const contract = { selected_entry: "run" as const, source_format: "async_body" as const, required_exports: [], optional_exports: [],
    parameter_count: null, detected_exports: ["step", "activate"], omitted_exports: 0,
    detected_signatures: ["step", "activate"].map(name => ({ name, parameter_count: 3, plain_parameters: true, async: false, generator: false })) };
  expect(preparationFailure(error)).toMatchObject({ code: "invalid_source", issues: expect.arrayContaining([
    expect.objectContaining({ code: "forbidden_syntax", entry_contract: contract }),
  ]) });
  expect(JSON.stringify(preparationFailure(error))).not.toContain("PRIVATE_SOURCE_VALUE");
  expect(book.versions).toBe(0);
  expect(book.sourceBytes).toBe(0);
  expect(await validateSkill(specification("await game.observe(); return args;"), fixtureContract)).toMatchObject({ entry: "run" });
});

test("invalid selected module entries expose exact synchronous contracts without relaxing export or parameter admission", async () => {
  for (const kind of ["step", "analyze"] as const) {
    const params = kind === "step" ? "frame,state,intent" : "input";
    const cases = [
      { source: "const local = 1;", names: [] },
      { source: `export function other(${params}) { return null; }`, names: ["other"] },
      { source: `export function ${kind}(${params}) { return null; } export const extra = 1;`, names: [kind, "extra"] },
      { source: `export async function ${kind}(${params}) { return null; }`, names: [kind] },
      { source: `export function* ${kind}(${params}) { yield null; }`, names: [kind] },
      { source: `export default function ${kind}(${params}) { return null; }`, names: ["default"] },
      ...["", `${params},extra`, kind === "step" ? "frame={},state,intent" : "input={}",
        kind === "step" ? "frame,state,...intent" : "...input",
        kind === "step" ? "{frame},state,intent" : "{input}",
        kind === "step" ? "[frame],state,intent" : "[input]"].map(parameters => ({
        source: `export function ${kind}(${parameters}) { return null; }`, names: [kind],
      })),
      { source: `const local = async (${params}) => null; export {local as ${kind}};`, names: [kind] },
      { source: `const local = (${params},extra) => null; const alias = local; export {alias as ${kind}};`, names: [kind] },
      { source: `export {${kind},extra} from './helper.js';`, names: [kind, "extra"] },
    ];
    for (const entry of cases) {
      const error = await rejection(validateProgramSource(entry.source, kind, fixtureContract), "invalid_entry");
      expect(error.issues[0]!.entry_contract).toMatchObject({
        selected_entry: kind, source_format: "module", required_exports: [kind],
        optional_exports: kind === "step" ? ["activate"] : [], parameter_count: kind === "step" ? 3 : 1,
        detected_exports: entry.names, omitted_exports: 0,
      });
    }
  }
  await rejection(validateProgramSource(
    "export function step(frame,state,intent) { return null; } export async function activate(frame,state,intent) { return null; }",
    "step", fixtureContract), "invalid_entry");
});

test("entry hints report bounded locally resolved signatures and leave imported signatures unknown", async () => {
  const cases = [
    { source: "export function step(frame,state) {} export function activate() {}", expected: [
      { name: "step", parameter_count: 2, plain_parameters: true, async: false, generator: false },
      { name: "activate", parameter_count: 0, plain_parameters: true, async: false, generator: false },
    ] },
    { source: "const local = async (frame,state,intent) => null; const alias = local; export {alias as step};", expected: [
      { name: "step", parameter_count: 3, plain_parameters: true, async: true, generator: false },
    ] },
    { source: "export function* step(frame,state,intent) {}", expected: [
      { name: "step", parameter_count: 3, plain_parameters: true, async: false, generator: true },
    ] },
    ...["frame={},state,intent", "frame,state,...intent", "{frame},state,intent", "[frame],state,intent"].map(params => ({
      source: `export function step(${params}) {}`, expected: [
        { name: "step", parameter_count: 3, plain_parameters: false, async: false, generator: false },
      ],
    })),
    { source: "import {step} from './helper.js'; export {step}; export const extra = 1;", expected: [] },
    { source: "import {step} from './helper.js'; const alias = step; export {alias as step}; export const extra = 1;", expected: [] },
    { source: "export {step,extra} from './helper.js';", expected: [] },
    { source: "let local = (frame,state) => null; local = () => null; export {local as step};", expected: [] },
    { source: "var local = (frame,state) => null; var local = () => null; export {local as step};", expected: [] },
    { source: "const first = second; const second = first; export {first as step};", expected: [] },
  ];
  for (const entry of cases) {
    const error = await rejection(validateProgramSource(entry.source, "step", fixtureContract), "invalid_entry");
    expect(error.issues[0]!.entry_contract!.detected_signatures).toEqual(entry.expected);
    expect(preparationFailure(error)).toMatchObject({ issues: [{ entry_contract: { detected_signatures: entry.expected } }] });
  }
  const long = "helper".repeat(20);
  const source = Array.from({ length: 12 }, (_, index) => `export function ${long}${index}(frame) {}`).join("\n");
  const error = await rejection(validateProgramSource(source, "step", fixtureContract), "invalid_entry");
  const signatures = error.issues[0]!.entry_contract!.detected_signatures!;
  expect(signatures).toHaveLength(8);
  expect(signatures.every(signature => signature.name.length === 80 && signature.parameter_count === 1)).toBe(true);
});

test("entry export hints use AST export names and bound count and length before both projections", async () => {
  const long = "exported".repeat(20);
  const extra = Array.from({ length: 10 }, (_, index) => `extra${index}`);
  const source = `export const {value: ${long}, nested: [${extra.join(",")}]} = {}; export default 'PRIVATE_SOURCE_VALUE';`;
  for (const kind of ["skill", "step"] as const) {
    const error = await rejection(validateProgramSource(source, kind, fixtureContract), kind === "skill" ? "forbidden_syntax" : "invalid_entry");
    const contract = error.issues[0]!.entry_contract!;
    expect(contract.detected_exports).toEqual([long.slice(0, 80), ...extra.slice(0, 7)]);
    expect(contract.omitted_exports).toBe(4);
    const decorated = new ProgramValidationError(error.issues.map(issue => ({
      ...issue, host_secret: "PRIVATE_METADATA", entry_contract: Object.assign({}, issue.entry_contract, { host_secret: "PRIVATE_METADATA" }),
    })));
    expect(JSON.stringify(preparationFailure(decorated).issues)).toBe(JSON.stringify(error.issues));
    expect(JSON.stringify(preparationFailure(decorated))).not.toContain("PRIVATE_");
  }
});

test("valid selected imported reexported and aliased entry paths keep their existing admission", async () => {
  for (const kind of ["step", "analyze"] as const) {
    const params = kind === "step" ? "frame,state,intent" : "input";
    for (const source of [
      `const local = (${params}) => null; const alias = local; export {alias as ${kind}};`,
      `import {entry} from './helper.js'; export {entry as ${kind}};`,
      `import {entry} from './helper.js'; const alias = entry; export {alias as ${kind}};`,
      `export {entry as ${kind}} from './helper.js';`,
      "export * from './helper.js';",
    ]) expect((await validateProgramSource(source, kind, fixtureContract)).source.length).toBeGreaterThan(0);
  }
  await validateProgramSource(
    "export function step(frame,state,intent) { return null; } export function activate(frame,state,intent) { return null; }",
    "step", fixtureContract);
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
