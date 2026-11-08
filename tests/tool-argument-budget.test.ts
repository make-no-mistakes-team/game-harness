import { expect, test } from "bun:test";
import { z } from "zod";
import { programRunSchema, programSubmitSchema, programWriteSchema } from "../src/server/program-interface.ts";
import { compileToolArgumentBudget } from "../src/server/tool-argument-budget.ts";

const advertised = (schema: z.ZodType) => z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });

// These tests exercise the public compiler with the same generated input schema
// as RuntimeTools, not a second handwritten attention contract.
test("advertised attention reason stops generation at the first overbound prefix", () => {
  const budget = compileToolArgumentBudget(advertised(programRunSchema));
  for (const length of [0, 1, 299, 300]) {
    expect(budget({ operation: "attention", after_ms: 1000, reason: "x".repeat(length) })).toBeNull();
  }
  expect(budget({ operation: "attention", after_ms: 1000, reason: "x".repeat(301) }))
    .toEqual({ path: ["reason"], limit: 300, observed: 301 });
  expect(budget({ operation: "attention", after_ms: 600000, reason: "x".repeat(32509) }))
    .toEqual({ path: ["reason"], limit: 300, observed: 32509 });
});

test("incomplete requests, partial discriminators and numeric prefixes are not validation failures", () => {
  const budget = compileToolArgumentBudget(advertised(programRunSchema));
  for (const value of [undefined, null, {}, { operation: "att", reason: "x".repeat(301) },
    { reason: "x".repeat(301) }, { operation: "unknown", reason: "x".repeat(301) },
    { operation: 12, reason: "x".repeat(301) }, { operation: "attention", reason: 12345 },
    { operation: "attention", after_ms: 6 }, { operation: "attention", after_ms: "6000000" }]) {
    expect(budget(value)).toBeNull();
  }
  // A numeric prefix does not disqualify an otherwise known string budget.
  expect(budget({ operation: "attention", after_ms: 6, reason: "x".repeat(301) }))
    .toEqual({ path: ["reason"], limit: 300, observed: 301 });
});

test("legal source, free JSON arguments and intentional waits keep their advertised budgets", () => {
  const source = "x".repeat(16384);
  expect(compileToolArgumentBudget(advertised(programWriteSchema))({ name: "neutral", source })).toBeNull();
  expect(compileToolArgumentBudget(advertised(programSubmitSchema))({ entry: "run", name: "neutral", source,
    args: { nested: { reason: "x".repeat(100000) }, list: ["x".repeat(100000)] } })).toBeNull();
  expect(compileToolArgumentBudget(advertised(programRunSchema))({ operation: "start", entry: "run", name: "neutral",
    args: { reason: "x".repeat(100000) } })).toBeNull();
  expect(compileToolArgumentBudget(advertised(programRunSchema))({ operation: "attention", after_ms: 600000,
    reason: "Waiting intentionally" })).toBeNull();
  expect(compileToolArgumentBudget(advertised(programWriteSchema))({ source: "x".repeat(16385) }))
    .toEqual({ path: ["source"], limit: 16384, observed: 16385 });
});

test("oneOf and anyOf retain every compatible unbounded alternative", () => {
  for (const keyword of ["oneOf", "anyOf"]) {
    const bounded = { type: "object", properties: { operation: { const: "attention" }, reason: { type: "string", maxLength: 3 } } };
    const free = { type: "object", properties: { operation: { const: "start" }, reason: {} } };
    const budget = compileToolArgumentBudget({ [keyword]: [bounded, free] });
    expect(budget({ operation: "attention", reason: "xxxx" })).toEqual({ path: ["reason"], limit: 3, observed: 4 });
    for (const operation of [undefined, "att", "start", "unknown", 12]) {
      expect(budget({ operation, reason: "xxxx" })).toBeNull();
    }
    expect(compileToolArgumentBudget({ [keyword]: [bounded, {}] })({ operation: "attention", reason: "xxxx" })).toBeNull();
    expect(compileToolArgumentBudget({ [keyword]: [{ maxLength: 3 }, { maxLength: 8 }] })("xxxxx")).toBeNull();
    expect(compileToolArgumentBudget({ [keyword]: [{ maxLength: 3 }, { maxLength: 8 }] })("x".repeat(9)))
      .toEqual({ path: [], limit: 8, observed: 9 });
  }
});

test("a shorter complete discriminator does not erase a still-growing longer alternative", () => {
  const budget = compileToolArgumentBudget({ anyOf: [
    { properties: { operation: { const: "wait" }, reason: { maxLength: 3 } } },
    { properties: { operation: { const: "waiting" }, reason: {} } },
  ] });
  expect(budget({ operation: "wait", reason: "xxxx" })).toBeNull();
});

test("local refs, escaped definition names and nested explicit properties preserve bound paths", () => {
  const budget = compileToolArgumentBudget({
    $defs: {
      "bounded/reason": { type: "string", maxLength: 3 },
      item: { type: "object", properties: { note: { $ref: "#/$defs/bounded~1reason" } } },
    },
    type: "object", properties: { payload: { properties: { entries: { type: "array", items: { $ref: "#/$defs/item" } } } } },
  });
  expect(budget({ payload: { entries: [{ note: "ok" }, { note: "xxxx" }] } }))
    .toEqual({ path: ["payload", "entries", 1, "note"], limit: 3, observed: 4 });
  expect(budget({ payload: { entries: [{ note: 123456 }, null] } })).toBeNull();
  expect(budget({ payload: "malformed" })).toBeNull();
});

test("unknown, recursive and excessively deep refs or unions fail open", () => {
  for (const schema of [undefined, null, false, {}, { $ref: "missing.json", maxLength: 1 },
    { $ref: "#/$defs/missing", maxLength: 1 }, { $ref: "#", maxLength: 1 },
    { $defs: { unknown: { $ref: "missing.json" } }, $ref: "#/$defs/unknown", maxLength: 1 },
    { $dynamicRef: "#unknown", maxLength: 1 }, { $recursiveRef: "#", maxLength: 1 },
    { anyOf: [{ maxLength: 1 }, { $ref: "#/$defs/missing" }] },
    { anyOf: Array.from({ length: 1000 }, () => ({ maxLength: 1 })) }]) {
    expect(compileToolArgumentBudget(schema)("xxxx")).toBeNull();
  }
  let deep: unknown = { maxLength: 1 };
  for (let index = 0; index < 100; index++) deep = { allOf: [deep] };
  expect(compileToolArgumentBudget(deep)("xxxx")).toBeNull();
  const recursive = { $defs: { node: { properties: { next: { $ref: "#/$defs/node" } } } }, $ref: "#/$defs/node" };
  expect(compileToolArgumentBudget(recursive)({ next: { next: { reason: "x".repeat(10000) } } })).toBeNull();
});

test("allOf bounds and ref siblings intersect without losing nested constraints", () => {
  const budget = compileToolArgumentBudget({ $defs: { reason: { maxLength: 8 } }, properties: {
    reason: { $ref: "#/$defs/reason", maxLength: 3 },
    detail: { allOf: [{ properties: { note: { maxLength: 8 } } }, { properties: { note: { maxLength: 3 } } }] },
  } });
  expect(budget({ reason: "xxxx" })).toEqual({ path: ["reason"], limit: 3, observed: 4 });
  expect(budget({ detail: { note: "xxxx" } })).toEqual({ path: ["detail", "note"], limit: 3, observed: 4 });
});

test("Unicode code points and removable trim whitespace are counted conservatively", () => {
  const budget = compileToolArgumentBudget({ type: "string", maxLength: 3 });
  for (const value of ["😀😀😀", "\ud83d", "  abc  ", "\t\n\ufeffabc\u00a0", " ".repeat(10000)]) {
    expect(budget(value)).toBeNull();
  }
  expect(budget("😀😀😀😀")).toEqual({ path: [], limit: 3, observed: 4 });
  expect(budget("a b c")).toEqual({ path: [], limit: 3, observed: 5 });
  expect(budget("😀😀😀\ud83d")).toEqual({ path: [], limit: 3, observed: 4 });
  expect(budget("  abcd \n")).toEqual({ path: [], limit: 3, observed: 4 });
});

test("budget evaluation never mutates or truncates input, and rewrites do not renew generation budgets", () => {
  const budget = compileToolArgumentBudget({ properties: { reason: { maxLength: 3 } } });
  const input = Object.freeze({ reason: "xxxx" });
  expect(budget(input)).toEqual({ path: ["reason"], limit: 3, observed: 4 });
  expect(input.reason).toBe("xxxx");
  // The caller must stop at this prefix. A later duplicate-key overwrite is
  // not permission to keep generating after the admitted prefix was exceeded.
  expect(budget({ reason: "xx" })).toBeNull();
});
