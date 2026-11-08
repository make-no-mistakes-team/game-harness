import { expect, test } from "bun:test";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { programHelp } from "../src/server/program-help.ts";
import { helpSchema } from "../src/server/program-interface.ts";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";

test("selected craft help preserves both complete input families and rejects mixed or oversized batches", () => {
  const adapter = minecraftTestAdapter();
  const help = programHelp("actions", adapter, "craft");
  const schema = Reflect.get(help, "schema");
  for (const action of [
    { kind: "craft", item: "spruce_planks", executions: 16 },
    { kind: "craft", sequence: [{ item: "spruce_planks", executions: 2 }, { item: "stick", executions: 1 }] },
  ]) expect(validateJsonSchemaValue(schema, action).success).toBe(true);
  for (const action of [
    { kind: "craft", item: "spruce_planks", executions: 17 },
    { kind: "craft", sequence: Array.from({ length: 9 }, () => ({ item: "stick", executions: 1 })) },
    { kind: "craft", item: "stick", executions: 1, sequence: [{ item: "stick", executions: 1 }] },
    { kind: "attack", target: { target_id: "invented" } },
  ]) expect(validateJsonSchemaValue(schema, action).success).toBe(false);
});

test("selected action references are scoped to their exact kind and reject unknown selectors", () => {
  const adapter = minecraftTestAdapter();
  const move = Reflect.get(programHelp("actions", adapter, "move"), "schema");
  const look = Reflect.get(programHelp("actions", adapter, "look"), "schema");
  const movement = { kind: "move", controls: { forward: true }, duration_ms: 500 };
  const turning = { kind: "look", yaw: 0.5, pitch: 0 };
  expect(validateJsonSchemaValue(move, movement).success).toBe(true);
  expect(validateJsonSchemaValue(move, turning).success).toBe(false);
  expect(validateJsonSchemaValue(look, turning).success).toBe(true);
  expect(validateJsonSchemaValue(look, movement).success).toBe(false);
  expect(() => programHelp("actions", adapter, "invented_effect")).toThrow();
  expect(helpSchema.safeParse({ topic: "actions", kind: "attack" }).success).toBe(true);
  expect(helpSchema.safeParse({ topic: "reflex", kind: "attack" }).success).toBe(false);
});
