import { expect, test } from "bun:test";
import { z } from "zod";
import { programRunSchema } from "../src/server/program-interface.ts";
import { createToolArgumentKeyBudget } from "../src/server/tool-argument-key-budget.ts";

const strict = (properties: Record<string, unknown>) => ({ type: "object", properties, additionalProperties: false });

test("unfinished raw argument key cannot hide behind a valid parsed attention reason", () => {
  const guard = createToolArgumentKeyBudget(z.toJSONSchema(programRunSchema))!;
  expect(guard.append('{"operation":"attention","after_ms":30000,"reason":"short","')).toBeNull();
  const rejected = guard.append("x".repeat(1024));
  expect(rejected).toMatchObject({ path: ["<argument_key>"] });
  expect(rejected!.observed).toBeLessThan(1024);
  expect(guard.append('\":null}')).toEqual(rejected);
});

test("decoded key budget survives split Unicode escapes without counting their wire spelling", () => {
  const guard = createToolArgumentKeyBudget(strict({ alpha: {} }))!;
  expect(guard.append('{"\\u0061\\u006c\\u0070\\u0068\\u0061')).toBeNull();
  expect(guard.append("\\u00")).toBeNull();
  expect(guard.append("7")).toBeNull();
  expect(guard.append("8")).toEqual({ path: ["<argument_key>"], limit: 5, observed: 6 });
});

test("arbitrary nested JSON keys and escaped value punctuation do not become root keys", () => {
  const guard = createToolArgumentKeyBudget(strict({ args: {}, code: {} }))!;
  const wire = JSON.stringify({ args: { ["nested".repeat(1000)]: '{"quoted":"value"},\\'.repeat(1000) }, code: "x".repeat(16384) });
  let rejected = null;
  for (let offset = 0; offset < wire.length; offset += 3) {
    rejected = guard.append(wire.slice(offset, offset + 3));
    if (rejected) break;
  }
  expect(rejected).toBeNull();
});

test("literal and escaped surrogate pairs consume the same property-name allowance", () => {
  const schema = strict({ "😀": {} });
  expect(createToolArgumentKeyBudget(schema)!.append('{"😀":1}')).toBeNull();
  const escaped = createToolArgumentKeyBudget(schema)!;
  expect(escaped.append('{"\\uD83D\\uDE00')).toBeNull();
  expect(escaped.append("x")).toEqual({ path: ["<argument_key>"], limit: 2, observed: 3 });
});

test("unbounded alternatives and unresolved recursive references never invent a key bound", () => {
  expect(createToolArgumentKeyBudget({ anyOf: [strict({ alpha: {} }), { type: "object" }] })).toBeNull();
  expect(createToolArgumentKeyBudget({ $ref: "#/missing" })).toBeNull();
  expect(createToolArgumentKeyBudget({ $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" })).toBeNull();
  expect(createToolArgumentKeyBudget({ ...strict({ alpha: {} }), patternProperties: { ".*": {} } })).toBeNull();
});

test("strict referenced alternatives preserve their longest legal key and isolate parser state", () => {
  const schema = { $defs: { first: strict({ one: {} }), second: strict({ longer: {} }) }, anyOf: [{ $ref: "#/$defs/first" }, { $ref: "#/$defs/second" }] };
  const first = createToolArgumentKeyBudget(schema)!, second = createToolArgumentKeyBudget(schema)!;
  expect(first.append('{"toolong')).toEqual({ path: ["<argument_key>"], limit: 6, observed: 7 });
  expect(second.append('{"longer":{')).toBeNull();
  expect(second.append('"arbitrary nested key":1}}')).toBeNull();
});
