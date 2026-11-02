import { expect, test } from "bun:test";
import { minecraftActionSchema, minecraftVisibleScreenRequestSchema } from "../src/shared/minecraft.ts";
import { effectScreenPreconditionSchema, screenPreconditionMatches, visibleScreenSnapshotSchema } from "../src/shared/control.ts";
import { getGameAPIReference } from "../src/shared/validation.ts";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";
import { RegisteredAdapterContract } from "../src/server/registered-adapter.ts";

const screen = { screen_id: "visible-handler", incarnation: 3, layout_revision: 1 };
const cursor = { item: null, count: 0 };
const source = { slot_id: 0, value: { item: "iron_ore", count: 3 } };
const slot = { kind: "slot", slot_id: 0, button: "left", mode: "ordinary", hotbar_slot: null,
  expected_cursor: cursor, expected_slots: [source] };
const action = (operations: unknown[]) => ({ kind: "screen_input", screen, operations });

test("visible slot admission uses a local source/cursor fragment without whole content revision", () => {
  expect(minecraftActionSchema.safeParse(action([slot])).success).toBe(true);
});

test("a scoped empty screen frame is legal without closing the persistent view", () => {
  expect(minecraftActionSchema.safeParse(action([])).success).toBe(true);
});

test("visible scroll admission targets one selected rendered region without a hidden page selector", () => {
  expect(minecraftActionSchema.safeParse(action([
    { kind: "scroll", element_id: "rendered-scroll-region", horizontal: 0, vertical: -1 },
  ])).success).toBe(true);
  for (const operation of [
    { kind: "scroll", element_id: "rendered-scroll-region", horizontal: Infinity, vertical: -1 },
    { kind: "scroll", element_id: "rendered-scroll-region", horizontal: 0, vertical: 17 },
    { kind: "scroll", element_id: "", horizontal: 0, vertical: -1 },
    { kind: "scroll", element_id: "rendered-scroll-region", horizontal: 0, vertical: -1, recipe_index: 100 },
  ]) expect(minecraftActionSchema.safeParse(action([operation])).success).toBe(false);
});

test("selected-region wheel components admit fractional inclusive bounds and reject nonfinite or excess values", () => {
  for (const [horizontal, vertical] of [[-16, 16], [16, -16], [0.5, -0.25], [0, 0]]) {
    expect(minecraftActionSchema.safeParse(action([
      { kind: "scroll", element_id: "current-region", horizontal, vertical },
    ])).success).toBe(true);
  }
  for (const [horizontal, vertical] of [[-16.01, 0], [0, -16.01], [16.01, 0], [0, 16.01],
    [NaN, 0], [0, NaN], [-Infinity, 0], [0, Infinity]]) {
    expect(minecraftActionSchema.safeParse(action([
      { kind: "scroll", element_id: "current-region", horizontal, vertical },
    ])).success).toBe(false);
  }
  for (const operation of [
    { kind: "scroll", horizontal: 0, vertical: 1 },
    { kind: "scroll", element_id: "current-region", vertical: 1 },
    { kind: "scroll", element_id: "current-region", horizontal: 0 },
    { kind: "scroll", element_id: "current-region", horizontal: "0", vertical: 1 },
    { kind: "scroll", element_id: "current-region", horizontal: 0, vertical: 1, page: 2 },
  ]) expect(minecraftActionSchema.safeParse(action([operation])).success).toBe(false);
});

test("registered action4 admits selected scrolling while obsolete action3 grants no authority", () => {
  const adapter = minecraftTestAdapter();
  const registry = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas, adapter.capabilityValidators);
  const request = { kind: "screen_input", screen,
    operations: [{ kind: "scroll", element_id: "current-region", horizontal: 0, vertical: -1 }] };
  expect(registry.parseCapability("minecraft.action", 4, request)).toEqual(request);
  expect(() => registry.parseCapability("minecraft.action", 3, request)).toThrow();
  expect(() => registry.parseCapability("minecraft.action", 4, action([
    { kind: "scroll", element_id: "current-region", horizontal: 0, vertical: -17 },
  ]))).toThrow();
});

test("generated action help exposes targeted wheel bounds to schema-only consumers", () => {
  const reference = getGameAPIReference(minecraftTestAdapter());
  const schema = Reflect.get(reference, "schemas").capabilities["minecraft.action@4"];
  const request = action([{ kind: "scroll", element_id: "current-region", horizontal: 16, vertical: -16 }]);
  expect(validateJsonSchemaValue(schema, request).success).toBe(true);
  for (const operation of [
    { kind: "scroll", element_id: "current-region", horizontal: 16.01, vertical: 0 },
    { kind: "scroll", element_id: "current-region", horizontal: 0, vertical: -16.01 },
    { kind: "scroll", element_id: "current-region", horizontal: 0, vertical: 1, page: 3 },
  ]) expect(validateJsonSchemaValue(schema, action([operation])).success).toBe(false);
});

for (const [name, operation] of [
  ["hotbar mode without a selected hotbar slot", { ...slot, mode: "hotbar" }],
  ["ordinary mode with a hotbar-only value", { ...slot, hotbar_slot: 0 }],
  ["missing clicked-source assumption", { ...slot, expected_slots: [] }],
  ["duplicate local assumptions", { ...slot, expected_slots: [source, source] }],
  ["null item with positive count", { ...slot, expected_cursor: { item: null, count: 1 } }],
  ["non-null item with zero count", { ...slot, expected_cursor: { item: "stone", count: 0 } }],
  ["unbounded source count", { ...slot, expected_slots: [{ ...source, value: { item: "iron_ore", count: 4097 } }] }],
  ["arbitrary injected key", { kind: "key", key: "F3", phase: "press" }],
  ["unknown operation", { kind: "trade_recipe", recipe: "developer-chosen" }],
] as const) {
  test(`visible screen admission rejects ${name}`, () => {
    expect(minecraftActionSchema.safeParse(action([operation])).success).toBe(false);
  });
}

test("layout admission ignores transaction revision but fences replacement handlers", () => {
  const precondition = { kind: "layout" as const, screen };
  expect(screenPreconditionMatches(precondition, { screen_id: screen.screen_id, incarnation: 3, revision: 999 })).toBe(true);
  expect(screenPreconditionMatches(precondition, { screen_id: screen.screen_id, incarnation: 4, revision: 1 })).toBe(false);
  expect(effectScreenPreconditionSchema.safeParse(null).success).toBe(false);
  expect(effectScreenPreconditionSchema.safeParse({ kind: "absent" }).success).toBe(true);
});

const bounds = { x: 0, y: 0, width: 16, height: 16 };
const snapshot = { identity: screen, content_revision: 1, screen_kind: "furnace",
  viewport: { width: 320, height: 240, scale_factor: 2 },
  slots: [{ slot_id: 0, value: source.value, bounds, enabled: true },
    { slot_id: 1, value: cursor, bounds, enabled: true }],
  cursor, elements: [], progress: [{ id: "cook", value: 1, maximum: 200 }] };

test("rendered custom choices and scroll regions retain bounded current identity and native geometry", () => {
  const region = { element_id: "current-region", kind: "scroll_region", text: "", enabled: true, bounds };
  const choice = { element_id: "current-choice", kind: "choice", text: "stone_bricks", enabled: true, bounds };
  const current = { ...snapshot, screen_kind: "stonecutter", elements: [region, choice] };
  expect(visibleScreenSnapshotSchema.parse(current).elements).toEqual([region, choice]);
  for (const invalid of [
    { ...current, elements: [region, region] },
    { ...current, elements: [{ ...region, bounds: { ...bounds, height: 0 } }] },
    { ...current, elements: [{ ...region, enabled: undefined }] },
    { ...current, elements: [{ ...choice, hidden_recipe_index: 80 }] },
  ]) expect(visibleScreenSnapshotSchema.safeParse(invalid).success).toBe(false);
});

test("visible projection preserves empty slots and cursor and rejects malformed geometry or duplicate ids", () => {
  expect(visibleScreenSnapshotSchema.parse(snapshot).slots[1]!.value).toEqual(cursor);
  for (const invalid of [
    { ...snapshot, cursor: undefined },
    { ...snapshot, slots: [...snapshot.slots, snapshot.slots[0]] },
    { ...snapshot, viewport: { ...snapshot.viewport, scale_factor: Infinity } },
    { ...snapshot, slots: [{ ...snapshot.slots[0], bounds: { ...bounds, width: -1 } }] },
    { ...snapshot, progress: [{ id: "cook", value: 201, maximum: 200 }] },
    { ...snapshot, elements: Array.from({ length: 33 }, (_, n) => ({ element_id: `${n}`, kind: "button", text: "x".repeat(256), enabled: true, bounds })) },
  ]) expect(visibleScreenSnapshotSchema.safeParse(invalid).success).toBe(false);
});

test("screen binding help publishes the actual response contract, not an unrestricted inspection route", () => {
  const reference = getGameAPIReference(minecraftTestAdapter());
  const method = Reflect.get(reference, "methods").screen;
  expect(method.parameters).toEqual([]);
  expect(validateJsonSchemaValue(method.result_schema, snapshot).success).toBe(true);
  expect(validateJsonSchemaValue(method.result_schema, { ...snapshot, cursor: undefined }).success).toBe(false);
  expect(minecraftVisibleScreenRequestSchema.safeParse({ hidden: true }).success).toBe(false);
});

test("screen action bounds and key/text vocabulary reject unsupported or unbounded input", () => {
  expect(minecraftActionSchema.safeParse(action(Array.from({ length: 16 }, () => ({ kind: "close" })))).success).toBe(true);
  for (const invalid of [
    action(Array.from({ length: 17 }, () => ({ kind: "close" }))),
    action([{ kind: "text", element_id: "anvil_text", text: "x".repeat(257) }]),
    action([{ kind: "key", key: "enter", phase: "repeat" }]),
    action([{ ...slot, expected_slots: Array.from({ length: 17 }, (_, slot_id) => ({ slot_id, value: cursor })) }]),
    { ...action([]), screen: { ...screen, layout_revision: Number.MAX_SAFE_INTEGER + 1 } },
  ]) expect(minecraftActionSchema.safeParse(invalid).success).toBe(false);
  for (const operation of [
    { ...slot, button: "right" }, { ...slot, mode: "shift" }, { ...slot, mode: "hotbar", hotbar_slot: 8 },
    { kind: "text", element_id: "anvil_text", text: "Ordinary name" },
    { kind: "key", key: "escape", phase: "press" }, { kind: "key", key: "shift", phase: "release" },
  ]) expect(minecraftActionSchema.safeParse(action([operation])).success).toBe(true);
});
