import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as native from "../src/server/minecraft-client.ts";
import { NativeFixture, type NativeFixtureOptions } from "../src/evaluation/native-game.ts";
import type { WorldConditions } from "../src/evaluation/scenarios.ts";

const inventory = () => ({ version: 1 as const, allow_inventory_replacement: true, control_send_buffer_bytes: null });
const normalizer = async () => (await import("../src/server/native-evaluation.ts")).normalizeNativeEvaluation;
const natural: WorldConditions = { preset: "natural_normal_survival", seed: "20261022", gamemode: "survival",
  difficulty: "normal", levelType: "minecraft:normal", structures: true, hardcore: false,
  suppliedInventory: false, consoleCommands: false, freshWorldPerCase: true };

function restoreEnvironment(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

// Mutations caught: implicit enablement, coercion/unknown-field acceptance,
// widened buffer bounds, shared mutable declarations and admission after setup.
test("explicit null disables evaluation without proof authority", async () => {
  const normalize = await normalizer();
  expect(normalize(null, false)).toBeNull();
  expect(normalize(null, true)).toBeNull();
});

test("meaningful native evaluation requires explicit trusted proof authority", async () => {
  const normalize = await normalizer();
  for (const declaration of [inventory(), { version: 1, allow_inventory_replacement: false, control_send_buffer_bytes: 4096 }])
    expect(() => normalize(declaration, false)).toThrow();
});

for (const bytes of [4096, 8192, 16384, null]) test(`validated evaluation is detached and immutable at buffer=${bytes}`, async () => {
  const normalize = await normalizer();
  const declaration = { version: 1 as const, allow_inventory_replacement: bytes === null, control_send_buffer_bytes: bytes };
  const actual = normalize(declaration, true);
  expect(actual).toEqual({ version: 1, allow_inventory_replacement: bytes === null, control_send_buffer_bytes: bytes });
  expect(actual).not.toBe(declaration);
  expect(Object.isFrozen(actual)).toBe(true);
  declaration.allow_inventory_replacement = !declaration.allow_inventory_replacement;
  declaration.control_send_buffer_bytes = 5000;
  expect(actual!.allow_inventory_replacement).toBe(bytes === null);
  expect(actual!.control_send_buffer_bytes).toBe(bytes);
  expect(Reflect.set(actual!, "allow_inventory_replacement", false)).toBe(false);
});

const malformed: Array<[string, unknown]> = [
  ["missing declaration", undefined], ["boolean declaration", true], ["array declaration", []], ["string declaration", "null"],
  ["missing version", { allow_inventory_replacement: true, control_send_buffer_bytes: null }],
  ["wrong version", { ...inventory(), version: 2 }], ["coerced version", { ...inventory(), version: "1" }],
  ["missing inventory flag", { version: 1, control_send_buffer_bytes: 4096 }],
  ["coerced inventory flag", { ...inventory(), allow_inventory_replacement: "true" }],
  ["numeric inventory flag", { ...inventory(), allow_inventory_replacement: 1 }],
  ["missing buffer", { version: 1, allow_inventory_replacement: true }],
  ["coerced buffer", { ...inventory(), control_send_buffer_bytes: "4096" }],
  ["boolean buffer", { ...inventory(), control_send_buffer_bytes: true }],
  ["low buffer", { ...inventory(), control_send_buffer_bytes: 4095 }],
  ["high buffer", { ...inventory(), control_send_buffer_bytes: 16385 }],
  ["fractional buffer", { ...inventory(), control_send_buffer_bytes: 4096.5 }],
  ["NaN buffer", { ...inventory(), control_send_buffer_bytes: NaN }],
  ["infinite buffer", { ...inventory(), control_send_buffer_bytes: Infinity }],
  ["negative infinite buffer", { ...inventory(), control_send_buffer_bytes: -Infinity }],
  ["all facilities disabled", { version: 1, allow_inventory_replacement: false, control_send_buffer_bytes: null }],
  ["unknown field", { ...inventory(), untrusted: true }],
];
for (const [label, declaration] of malformed) test(`native evaluation rejects ${label}`, async () => {
  const normalize = await normalizer();
  expect(() => normalize(declaration, true)).toThrow();
});

test("launcher refuses evaluation in its constructor before launch or credential work", () => {
  const original = process.env.GAMEHARNESS_NATIVE_PROOF;
  try {
    for (const flag of [undefined, "0", "true", "01"]) {
      restoreEnvironment("GAMEHARNESS_NATIVE_PROOF", flag);
      expect(() => new native.MinecraftClient(process.cwd(), { evaluation: inventory() })).toThrow();
      expect(() => new native.MinecraftClient(process.cwd())).not.toThrow();
    }
    process.env.GAMEHARNESS_NATIVE_PROOF = "1";
    expect(() => new native.MinecraftClient(process.cwd(), { evaluation: inventory() })).not.toThrow();
    expect(() => new native.MinecraftClient(process.cwd(), {
      evaluation: { ...inventory(), control_send_buffer_bytes: 4095 },
    })).toThrow();
  } finally { restoreEnvironment("GAMEHARNESS_NATIVE_PROOF", original); }
});

test("natural fixtures refuse evaluation before directories or process configuration change", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "native-evaluation-eligibility-"));
  const original = Object.fromEntries(["GAMEHARNESS_NATIVE_PROOF", "GAMEHARNESS_DATA_DIR", "GAMEHARNESS_MINECRAFT_PORT"]
    .map(key => [key, process.env[key]]));
  let fixture: NativeFixture | undefined;
  try {
    process.env.GAMEHARNESS_NATIVE_PROOF = "1";
    const runtimeRoot = path.join(base, "runtime");
    const result = NativeFixture.create("natural-evaluation-rejected", { projectRoot: process.cwd(),
      paths: { runtimeRoot, reportsRoot: path.join(base, "reports"), governanceRoot: path.join(base, "governance") },
      conditions: natural, evaluation: inventory(),
    }).then(value => { fixture = value; return value; });
    await expect(result).rejects.toThrow();
    expect(await stat(runtimeRoot).then(() => true, error => {
      if (error.code !== "ENOENT") throw error;
      return false;
    })).toBe(false);
    expect(process.env.GAMEHARNESS_DATA_DIR).toBe(original.GAMEHARNESS_DATA_DIR);
    expect(process.env.GAMEHARNESS_MINECRAFT_PORT).toBe(original.GAMEHARNESS_MINECRAFT_PORT);
  } finally {
    if (fixture) await fixture.close();
    for (const [key, value] of Object.entries(original)) restoreEnvironment(key, value);
    await rm(base, { recursive: true, force: true });
  }
});

test("fixture proof denial precedes any evaluator setup", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "native-evaluation-default-deny-"));
  const original = process.env.GAMEHARNESS_NATIVE_PROOF;
  try {
    delete process.env.GAMEHARNESS_NATIVE_PROOF;
    const runtimeRoot = path.join(base, "runtime");
    await expect(NativeFixture.create("proof-required", { projectRoot: process.cwd(), evaluation: inventory(),
      paths: { runtimeRoot, reportsRoot: path.join(base, "reports"), governanceRoot: path.join(base, "governance") },
    })).rejects.toThrow();
    expect(await stat(runtimeRoot).then(() => true, error => {
      if (error.code !== "ENOENT") throw error;
      return false;
    })).toBe(false);
  } finally {
    restoreEnvironment("GAMEHARNESS_NATIVE_PROOF", original);
    await rm(base, { recursive: true, force: true });
  }
});

test("malformed synthetic evaluation is rejected before fixture setup", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "native-evaluation-malformed-"));
  const original = Object.fromEntries(["GAMEHARNESS_NATIVE_PROOF", "GAMEHARNESS_DATA_DIR", "GAMEHARNESS_MINECRAFT_PORT"]
    .map(key => [key, process.env[key]]));
  let fixture: NativeFixture | undefined;
  try {
    process.env.GAMEHARNESS_NATIVE_PROOF = "1";
    const runtimeRoot = path.join(base, "runtime");
    const options: NativeFixtureOptions = { projectRoot: process.cwd(),
      paths: { runtimeRoot, reportsRoot: path.join(base, "reports"), governanceRoot: path.join(base, "governance") } };
    Reflect.set(options, "evaluation", { ...inventory(), control_send_buffer_bytes: "4096" });
    const result = NativeFixture.create("malformed-evaluation-rejected", options)
      .then(value => { fixture = value; return value; });
    await expect(result).rejects.toThrow();
    expect(await stat(runtimeRoot).then(() => true, error => {
      if (error.code !== "ENOENT") throw error;
      return false;
    })).toBe(false);
    expect(process.env.GAMEHARNESS_DATA_DIR).toBe(original.GAMEHARNESS_DATA_DIR);
    expect(process.env.GAMEHARNESS_MINECRAFT_PORT).toBe(original.GAMEHARNESS_MINECRAFT_PORT);
  } finally {
    if (fixture) await fixture.close();
    for (const [key, value] of Object.entries(original)) restoreEnvironment(key, value);
    await rm(base, { recursive: true, force: true });
  }
});
