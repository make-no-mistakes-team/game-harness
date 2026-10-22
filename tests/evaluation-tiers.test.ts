import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNativeArtifactFresh, requireTierOptIn, tierTests } from "../src/evaluation/tiers.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gameharness-tiers-"));
  roots.push(root);
  mkdirSync(join(root, "native/minecraft/src/main"), { recursive: true });
  mkdirSync(join(root, "src/shared"), { recursive: true });
  const source = join(root, "native/minecraft/src/main/Bridge.java");
  const jar = join(root, "built.jar");
  writeFileSync(source, "final class Bridge {}\n");
  writeFileSync(jar, "fixture artifact bytes: never launched as Java\n");
  utimesSync(source, 100, 100);
  utimesSync(jar, 200, 200);
  return { root, source, jar };
}

test("native and actual-agent admission are separate explicit opt-ins", () => {
  requireTierOptIn("unit", {});
  requireTierOptIn("integration", {});
  expect(() => requireTierOptIn("native-game", {})).toThrow("--allow-native");
  requireTierOptIn("native-game", { allowNative: true });
  expect(() => requireTierOptIn("agent-acceptance", { allowNative: true })).toThrow("--allow-inference");
  expect(() => requireTierOptIn("agent-acceptance", { allowInference: true })).toThrow("--allow-native");
  requireTierOptIn("agent-acceptance", { allowNative: true, allowInference: true });
});

test("a changed Java input refuses a stale artifact rather than building or using it", () => {
  const { root, source, jar } = fixture();
  expect(assertNativeArtifactFresh(root, jar).sha256).toMatch(/^[0-9a-f]{64}$/);
  utimesSync(source, 300, 300);
  expect(() => assertNativeArtifactFresh(root, jar)).toThrow("explicitly run bun run build:native");
});

test("JavaScript schema/string changes do not make the unchanged Java artifact stale", () => {
  const { root, jar } = fixture();
  writeFileSync(join(root, "src/shared/schema.ts"), 'export const label = "New model tool description";\n');
  const fresh = assertNativeArtifactFresh(root, jar);
  expect(fresh.jarPath).toBe(jar);
  expect(fresh.newestInput?.endsWith("Bridge.java")).toBe(true);
});

test("native Gradle inputs participate in freshness and symlink artifacts are rejected", () => {
  const { root, jar } = fixture();
  const gradle = join(root, "native/minecraft/build.gradle");
  writeFileSync(gradle, "plugins {}\n");
  utimesSync(gradle, 300, 300);
  expect(() => assertNativeArtifactFresh(root, jar)).toThrow("build.gradle");
  symlinkSync(jar, join(root, "linked.jar"));
  expect(() => assertNativeArtifactFresh(root, "linked.jar")).toThrow("regular built JAR");
});

test("targeted selection respects concrete tiers rather than implying production Docker coverage", () => {
  expect(tierTests("unit", ["program-validation.test.ts"])).toEqual(["tests/program-validation.test.ts"]);
  expect(tierTests("integration", ["tests/game-bridge.test.ts"])).toEqual(["tests/game-bridge.test.ts"]);
  expect(() => tierTests("unit", ["game-bridge.test.ts"])).toThrow("not classified");
  expect(tierTests("unit")).not.toContain("tests/runtime-life-session.test.ts");
  expect(tierTests("integration")).toContain("tests/program-instrumentation.test.ts");
});
