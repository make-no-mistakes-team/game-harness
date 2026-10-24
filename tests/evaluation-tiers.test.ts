import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertNativeArtifactFresh, requireTierOptIn, tierTests } from "../src/evaluation/tiers.ts";
import { assertNativeContractFresh, buildNativeContract, NATIVE_CONTRACT_BUILD_INPUTS } from "../src/server/native-contract.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function writeInput(root: string, relative: string, contents: string, mtime = 100) {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  utimesSync(file, mtime, mtime);
  return file;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gameharness-tiers-"));
  roots.push(root);
  for (const input of NATIVE_CONTRACT_BUILD_INPUTS) writeInput(root, input, `fixture input: ${input}\n`);
  writeInput(root, "native/minecraft/build.gradle", `
minecraft 'com.mojang:minecraft:1.21.4'
mappings 'net.fabricmc:yarn:1.21.4+build.8:v2'
modImplementation 'net.fabricmc:fabric-loader:0.16.10'
modImplementation 'net.fabricmc.fabric-api:fabric-api:0.119.2+1.21.4'
options.release = 21
`);
  const source = writeInput(root, "native/minecraft/src/main/Bridge.java", "final class Bridge {}\n");
  const clientSource = writeInput(root, "native/minecraft/src/client/Client.java", "final class Client {}\n");
  const jar = join(root, "built.jar");
  writeFileSync(jar, "fixture artifact bytes: never launched as Java\n");
  utimesSync(jar, 200, 200);
  return { root, source, clientSource, jar };
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

test.each(["source", "clientSource"] as const)("a changed Java %s refuses a stale artifact rather than building or using it", (input) => {
  const native = fixture();
  const { root, jar } = native;
  expect(assertNativeArtifactFresh(root, jar).sha256).toMatch(/^[0-9a-f]{64}$/);
  utimesSync(native[input], 300, 300);
  expect(() => assertNativeArtifactFresh(root, jar)).toThrow("explicitly run bun run build:native");
});

test.each(NATIVE_CONTRACT_BUILD_INPUTS)("a newer generated-contract input %s refuses the old native artifact", (input) => {
  const { root, jar } = fixture();
  const before = assertNativeArtifactFresh(root, jar);
  utimesSync(join(root, input), 300, 300);
  expect(() => assertNativeArtifactFresh(root, jar)).toThrow(input);
  expect(() => assertNativeArtifactFresh(root, jar)).toThrow("explicitly run bun run build:native");
  utimesSync(jar, 400, 400);
  const after = assertNativeArtifactFresh(root, jar);
  expect(after.newestInput).toBe(join(root, input));
  expect(after.sha256).toBe(before.sha256);
});

test.each(NATIVE_CONTRACT_BUILD_INPUTS)("changed bytes in %s invalidate generated native identity even with preserved mtimes", async (input) => {
  const { root, jar } = fixture();
  const generated = await buildNativeContract(root);
  const artifact = assertNativeArtifactFresh(root, jar);
  const file = join(root, input);
  writeFileSync(file, `${readFileSync(file, "utf8")}\nchanged contract input bytes\n`);
  utimesSync(file, 100, 100);
  expect(assertNativeArtifactFresh(root, jar).sha256).toBe(artifact.sha256);
  await expect(assertNativeContractFresh(root, generated)).rejects.toThrow("rebuild from the current schema/profile/build inputs");
  const rebuilt = await buildNativeContract(root);
  expect(rebuilt.descriptor.adapter.build_hash).not.toBe(generated.descriptor.adapter.build_hash);
});

test.each(["web/src/main.ts", "src/server/runtime-prompt.ts"])("unrelated UI/prompt input %s does not stale native timestamps or source identity", async (input) => {
  const { root, jar } = fixture();
  const generated = await buildNativeContract(root);
  const artifact = assertNativeArtifactFresh(root, jar);
  writeInput(root, input, "changed unrelated presentation text\n", 300);
  expect(assertNativeArtifactFresh(root, jar)).toEqual(artifact);
  await expect(assertNativeContractFresh(root, generated)).resolves.toEqual(generated);
});

test("Gradle wrapper inputs participate in native artifact freshness", () => {
  const { root, jar } = fixture();
  writeInput(root, "native/minecraft/gradle/wrapper/gradle-wrapper.properties", "distributionUrl=fixture\n", 300);
  expect(() => assertNativeArtifactFresh(root, jar)).toThrow("gradle-wrapper.properties");
});

test("symlink artifacts are rejected even when the target is fresh", () => {
  const { root, jar } = fixture();
  expect(assertNativeArtifactFresh(root, jar).jarPath).toBe(jar);
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

test("study storage/CLI/lifecycle and existing interface/export/comparison suites have executable tier selections", () => {
  for (const file of ["evaluation-studies.test.ts", "evaluation-study-cli.test.ts", "evaluation-study-lifecycle.test.ts",
    "program-interface.test.ts", "event-export.test.ts"]) {
    expect(tierTests("integration", [file])).toEqual([`tests/${file}`]);
    expect(() => tierTests("unit", [file])).toThrow("not classified");
  }
  for (const file of ["evaluation-study-config.test.ts", "policy-comparison.test.ts"]) {
    expect(tierTests("unit", [file])).toEqual([`tests/${file}`]);
    expect(() => tierTests("integration", [file])).toThrow("not classified");
  }
});
