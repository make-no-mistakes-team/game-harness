import { expect, test } from "bun:test";
import { minecraftActionSchema, minecraftProductionFactSchema } from "../src/shared/minecraft.ts";
import type { Json } from "../src/shared/contracts.ts";
import { RegisteredAdapterContract } from "../src/server/registered-adapter.ts";
import { effectScope, minecraftTestAdapter } from "./helpers/adapter-contract.ts";

const stage = (item = "oak_planks", executions = 1) => ({ item, executions });
const sequence = (stages = [stage("oak_planks", 2), stage("crafting_table"), stage("stick")]) => ({ kind: "craft" as const, sequence: stages });
const table = { target_id: "current-table", incarnation: 2, life_id: 3,
  space: { dimension_id: "minecraft:overworld", space_epoch: 4 } };

// Removing sequence admission or flattening quantities/order fails the real registered consumer.
test("registered craft preserves explicit ordered recipe executions and one selected table", () => {
  const adapter = minecraftTestAdapter();
  const registry = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas, adapter.capabilityValidators);
  const request = { ...sequence(), table };
  expect(registry.parseCapability("minecraft.action", 4, request)).toEqual(request);
  expect(minecraftActionSchema.parse({ kind: "craft", item: "oak_planks", executions: 2 })).toEqual({
    kind: "craft", item: "oak_planks", executions: 2 });
});

test("craft admits exact stage and total consumption bounds", () => {
  expect(minecraftActionSchema.parse(sequence([stage("oak_planks", 16)]))).toEqual(sequence([stage("oak_planks", 16)]));
  expect(minecraftActionSchema.parse(sequence(Array.from({ length: 8 }, () => stage("stick", 2))))).toEqual(
    sequence(Array.from({ length: 8 }, () => stage("stick", 2))));
});

test("craft rejects ambiguous forms, unbounded stages and hidden per-stage planning fields", () => {
  const adapter = minecraftTestAdapter();
  const registry = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas, adapter.capabilityValidators);
  for (const request of [
    sequence([]), sequence(Array.from({ length: 9 }, () => stage())),
    sequence([stage("oak_planks", 16), stage()]), sequence([stage("stick", 0)]), sequence([stage("stick", 17)]),
    sequence([stage("stick", 1.5)]), sequence([stage("minecraft:stick")]),
    { ...sequence(), item: "stick", executions: 1 }, { kind: "craft", item: "stick" },
    { kind: "craft", sequence: [{ ...stage(), table }] },
    { kind: "craft", sequence: [{ ...stage(), retry: true }] },
  ]) {
    expect(minecraftActionSchema.safeParse(request).success).toBe(false);
    expect(() => registry.parseCapability("minecraft.action", 4, request)).toThrow();
  }
});

const receipt = (stage_index: number, item: string, executions: number, output_per_execution: number,
  inventory_before: Record<string, number>, inventory_after: Record<string, number>, confirmed_executions = executions) => ({
  stage_index, item, executions, output_per_execution, completed_executions: confirmed_executions,
  confirmed_executions, status: confirmed_executions === executions ? "succeeded" : "partial",
  inventory_receipt_confirmed: true, inventory_custody_confirmed: true, cursor_count: 0, grid_count: 0,
  receipt_ref: `native-craft-receipt-${stage_index}`, inventory_before, inventory_after,
});
function facts(craft_stages: Json[], status: "succeeded" | "unknown" = "succeeded", request = sequence()) {
  const adapter = minecraftTestAdapter();
  return adapter.effectEvidence!(effectScope(), "craft-sequence-action", request, { status, summary: "Synthetic server receipt fixture",
    evidence: { craft_stages, effect_confirmed: status === "succeeded", inventory_receipt_confirmed: true } }, "2026-11-07T12:00:00Z");
}
const planks = receipt(0, "oak_planks", 2, 4, { oak_log: 2 }, { oak_planks: 8 });
const craftedTable = receipt(1, "crafting_table", 1, 1, { oak_planks: 8 }, { oak_planks: 4, crafting_table: 1 });
const sticks = receipt(2, "stick", 1, 4, { oak_planks: 4, crafting_table: 1 }, { oak_planks: 2, crafting_table: 1, stick: 4 });

test("craft deadline counts every requested consumption, not output items or only final stage", () => {
  expect(minecraftTestAdapter().effectDeadlineMs(sequence())).toBe(153000);
  expect(minecraftTestAdapter().effectDeadlineMs(sequence([stage("oak_planks", 16)]))).toBe(573000);
});

test("independent production evidence retains each real stage even when later stages consume its output", () => {
  const values = facts([planks, craftedTable, sticks]);
  expect(values.map(value => minecraftProductionFactSchema.parse(value.data).item)).toEqual(["oak_planks", "crafting_table", "stick"]);
  expect(values.map(value => value.evidence_id)).toEqual([
    "craft-sequence-action:craft:0:production", "craft-sequence-action:craft:1:production", "craft-sequence-action:craft:2:production"]);
  expect(values[0]!.data).toMatchObject({ inventory_after: { oak_planks: 8 } });
});

test("partial exhaustion retains confirmed consumed-recipe count but never invents later success", () => {
  const request = sequence([stage("oak_planks", 3), stage("crafting_table")]);
  const values = facts([receipt(0, "oak_planks", 3, 4, { oak_log: 2 }, { oak_planks: 8 }, 2)], "unknown", request);
  expect(values).toHaveLength(2);
  expect(values[0]!.data).toMatchObject({ kind: "item_production", item: "oak_planks", inventory_after: { oak_planks: 8 } });
  expect(values[1]!.data).toMatchObject({ kind: "effect_uncertainty", operation_kind: "craft" });
  const laterFailure = facts([planks, receipt(1, "crafting_table", 3, 1, { oak_planks: 8 }, { crafting_table: 2 }, 2)],
    "unknown", sequence([stage("oak_planks", 2), stage("crafting_table", 3), stage("stick")]));
  expect(laterFailure.map(value => value.data)).toMatchObject([
    { item: "oak_planks", inventory_after: { oak_planks: 8 } },
    { item: "crafting_table", inventory_before: { oak_planks: 8 }, inventory_after: { crafting_table: 2 } },
    { kind: "effect_uncertainty" },
  ]);
});

test("sequence completion cannot manufacture production from a final aggregate inventory alone", () => {
  const adapter = minecraftTestAdapter();
  const values = adapter.effectEvidence!(effectScope(), "missing-stages", sequence(), {
    status: "succeeded", summary: "Aggregate receipt is insufficient for ordered production",
    evidence: { effect_confirmed: true, inventory_receipt_confirmed: true,
      inventory_before: { oak_log: 2 }, inventory_after: { oak_planks: 2, crafting_table: 1, stick: 4 } },
  }, "2026-11-07T12:00:00Z");
  expect(values).toHaveLength(1);
  expect(values[0]!.data).toMatchObject({ kind: "effect_uncertainty", reason: "inventory_receipt_unconfirmed" });
});

test("craft evidence rejects unknown custody, overcraft, reordered receipts and forged confirmation counts", () => {
  for (const bad of [
    { ...planks, inventory_custody_confirmed: false }, { ...planks, grid_count: 1 },
    { ...planks, cursor_count: 1 }, { ...planks, confirmed_executions: 3 },
    { ...planks, inventory_after: { oak_planks: 12 } }, { ...planks, completed_executions: 1 },
    { ...planks, inventory_receipt_confirmed: false }, { ...planks, item: "birch_planks" },
  ]) expect(facts([bad], "unknown").filter(value => minecraftProductionFactSchema.safeParse(value.data).success)).toEqual([]);
  expect(facts([craftedTable, planks], "unknown").filter(value => minecraftProductionFactSchema.safeParse(value.data).success)).toEqual([]);
  expect(facts([planks, { ...craftedTable, receipt_ref: planks.receipt_ref }], "unknown")
    .filter(value => minecraftProductionFactSchema.safeParse(value.data).success)).toHaveLength(1);
});
