import { expect, test } from "bun:test";
import { minecraftActionSchema } from "../src/shared/minecraft.ts";
import { RegisteredAdapterContract } from "../src/server/registered-adapter.ts";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";
import type { Json } from "../src/shared/contracts.ts";

const neutral = { forward: false, back: false, left: false, right: false, jump: false,
  sprint: false, sneak: false, attack: false, use: false };
const step = (overrides: Record<string, Json> = {}) => ({ ticks: 1, held: { ...neutral },
  edges: [], view: { kind: "unchanged" }, selected_hotbar: null, ...overrides });
const action = (steps: Json[]) => ({ kind: "world_input" as const, steps });

// Removing ordinary input admission, or treating held attack as a repeated click,
// prevents the author from expressing this draw/turn/release interval faithfully.
test("ordinary input admits held use with a later turn and explicit release", () => {
  const value = action([
    step({ ticks: 20, held: { ...neutral, use: true },
      edges: [{ kind: "button", button: "use", phase: "press", count: 1 }] }),
    step({ ticks: 5, held: { ...neutral, use: true },
      view: { kind: "rate", yaw_radians_per_second: 1, pitch_radians_per_second: -.25 } }),
    step({ edges: [{ kind: "button", button: "use", phase: "release", count: 1 }] }),
  ]);
  const parsed = minecraftActionSchema.safeParse(value);
  expect(parsed.success).toBe(true);
});

test("ordinary input keeps counted attack presses separate from held state", () => {
  const value = action([
    step({ ticks: 4, held: { ...neutral, attack: true },
      edges: [{ kind: "button", button: "attack", phase: "press", count: 3 }] }),
    step({ held: { ...neutral, attack: true }, edges: [] }),
    step({ edges: [{ kind: "button", button: "attack", phase: "release", count: 1 }] }),
  ]);
  expect(minecraftActionSchema.safeParse(value).success).toBe(true);
});

test("ordinary input admits ordered release and repress, inventory edges and vanilla item controls", () => {
  const value = action([
    step({ held: { ...neutral, forward: true, attack: true, use: true }, selected_hotbar: 8,
      edges: [
        { kind: "button", button: "forward", phase: "press", count: 1 },
        { kind: "button", button: "attack", phase: "press", count: 1 },
        { kind: "button", button: "use", phase: "press", count: 1 },
        { kind: "hotbar", slot: 8 }, { kind: "hand_swap" },
        { kind: "drop", all: true }, { kind: "drop", all: true },
      ], view: { kind: "delta", yaw_radians: 2 * Math.PI, pitch_radians: -2 * Math.PI } }),
    step({ held: { ...neutral, forward: true, attack: true, use: true }, edges: [
      { kind: "button", button: "attack", phase: "release", count: 1 },
      { kind: "button", button: "attack", phase: "press", count: 2 },
      { kind: "button", button: "inventory", phase: "press", count: 1 },
      { kind: "button", button: "inventory", phase: "release", count: 1 },
    ], view: { kind: "rate", yaw_radians_per_second: -20 * Math.PI, pitch_radians_per_second: 20 * Math.PI } }),
  ]);
  expect(minecraftActionSchema.safeParse(value).success).toBe(true);
});

test("ordinary input admits the whole-action tick and expanded-edge limits exactly", () => {
  const value = action([step({ ticks: 100, held: { ...neutral, attack: true },
    edges: [{ kind: "button", button: "attack", phase: "press", count: 256 }] })]);
  expect(minecraftActionSchema.safeParse(value).success).toBe(true);
  expect(minecraftActionSchema.safeParse(action(Array.from({ length: 64 }, () => step()))).success).toBe(true);
});

test("registered ordinary input rejects inconsistent transitions before effect admission", () => {
  const adapter = minecraftTestAdapter(), registry = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas, adapter.capabilityValidators);
  const valid = action([step()]);
  expect(registry.parseCapability("minecraft.action", 4, valid)).toEqual(valid);
  expect(() => registry.parseCapability("minecraft.action", 1, valid)).toThrow();
  expect(() => registry.parseCapability("minecraft.action", 4,
    action([step({ held: { ...neutral, use: true } })]))).toThrow();
  expect(() => registry.parseCapability("minecraft.action", 4,
    action([step({ ticks: 100 }), step()]))).toThrow();
  expect(() => registry.parseCapability("minecraft.action", 4,
    action([step({ edges: [{ kind: "drop", all: true }, { kind: "drop", all: false }] })]))).toThrow();
});

test("ordinary input receives a finite action deadline independent of legacy helper sessions", () => {
  const adapter = minecraftTestAdapter();
  expect(adapter.effectDeadlineMs(action([step({ ticks: 20 }), step({ ticks: 5 })]))).toBe(3250);
  expect(adapter.effectDeadlineMs(action([step({ ticks: 100 })]))).toBe(7000);
});

for (const [name, steps] of [
  ["empty steps", []],
  ["step count overflow", Array.from({ length: 65 }, () => step())],
  ["missing held key", [step({ held: { forward: false } })]],
  ["inventory as held state", [step({ held: { ...neutral, inventory: false } })]],
  ["unexplained held press", [step({ held: { ...neutral, attack: true } })]],
  ["unexplained held release", [step({ held: { ...neutral, use: true }, edges: [{ kind: "button", button: "use", phase: "press", count: 1 }] }), step()]],
  ["arbitrary keyboard injection", [step({ edges: [{ kind: "button", button: "chat", phase: "press", count: 1 }] })]],
  ["unimplemented GUI operation", [step({ edges: [{ kind: "gui_text", text: "/op player" }] })]],
  ["ambiguous second camera command", [step({ edges: [{ kind: "camera_delta", x: 1, y: 0 }] })]],
  ["unsafe hotbar index", [step({ selected_hotbar: 9 })]],
  ["unsafe edge hotbar index", [step({ edges: [{ kind: "hotbar", slot: -1 }] })]],
  ["nonfinite view", [step({ view: { kind: "delta", yaw_radians: Infinity, pitch_radians: 0 } })]],
  ["expanded edge overflow", [step({ held: { ...neutral, attack: true }, edges: [{ kind: "button", button: "attack", phase: "press", count: 257 }] })]],
  ["tick overflow", [step({ ticks: 100 }), step()]],
  ["multiple release counts", [step({ edges: [{ kind: "button", button: "attack", phase: "release", count: 2 }] })]],
  ["unknown held key", [step({ held: { ...neutral, fly: true } })]],
  ["contradictory hotbar selection", [step({ selected_hotbar: 2, edges: [{ kind: "hotbar", slot: 3 }] })]],
  ["multiple hotbar edges", [step({ edges: [{ kind: "hotbar", slot: 2 }, { kind: "hotbar", slot: 2 }] })]],
  ["mixed drop modifiers", [step({ edges: [{ kind: "drop", all: false }, { kind: "drop", all: true }] })]],
  ["delta above bound", [step({ view: { kind: "delta", yaw_radians: 2 * Math.PI + .01, pitch_radians: 0 } })]],
  ["rate above bound", [step({ view: { kind: "rate", yaw_radians_per_second: 0, pitch_radians_per_second: -20 * Math.PI - .01 } })]],
  ["unknown view field", [step({ view: { kind: "unchanged", target: "hidden-aim" } })]],
  ["unknown step field", [step({ target: "hidden-aim" })]],
  ["expanded overflow across steps", [
    step({ edges: [{ kind: "button", button: "inventory", phase: "press", count: 256 }] }),
    step({ edges: [{ kind: "hand_swap" }] }),
  ]],
] as const) {
  test(`ordinary input rejects ${name} before native dispatch`, () => {
    expect(minecraftActionSchema.safeParse(action([...steps])).success).toBe(false);
  });
}
