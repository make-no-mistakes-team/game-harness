import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { VerificationTier } from "./contracts.ts";

/** File-level classification: some files also contain smaller tests. No Docker claim is implied. */
export const TEST_TIERS = Object.freeze({
  unit: Object.freeze([
    "tests/java-runtime.test.ts", // Java name resolution with local executable sentinels; no JVM or native startup.
    "tests/native-transport.test.ts", // Native frame parser only; no native process.
    "tests/video.test.ts", // Frame/header inspection only.
    "web/src/video.test.ts", // Actual renderer frame classification; synthetic packets/timestamps only.
    "tests/program-validation.test.ts", // Local schemas and JavaScript validation.
    "tests/speculative-planning.test.ts", // Planner state machine with substituted callbacks.
    "tests/evaluation-config.test.ts", // Pure model selection and cap contracts.
    "tests/evaluation-results.test.ts", // Outcome/usage accounting, no inference.
    "tests/evaluation-scenarios.test.ts", // Declared natural goals and semantic verifiers.
  ]),
  integration: Object.freeze([
    "tests/auth-network.test.ts", // Worker subprocess and local proxy; no account/provider inference.
    "tests/game-bridge.test.ts", // Real sockets and owned subprocesses; substituted native emitter.
    "tests/planning-admission.test.ts", // Real Store/SkillManager/planner; substituted sandbox seam.
    "tests/program-experience.test.ts", // SQLite, evidence and experience services.
    "tests/program-instrumentation.test.ts", // Real inner worker protocol, not production Docker isolation.
    "tests/reactive-life.test.ts", // Scheduler/arbiter/worker handoffs; substituted model/game seams.
    "tests/runtime-death-shutdown.test.ts", // Runtime with substituted game/auth/sandbox boundaries.
    "tests/runtime-life-session.test.ts",
    "tests/runtime-scheduler.test.ts",
    "tests/skill-store.test.ts", // Durable SQLite contracts.
    "tests/skills-runtime.test.ts", // Real skill lifecycle with substituted runner boundary.
    "tests/store.test.ts",
    "tests/strategic-overlap.test.ts", // Real planner coordination; synthetic provider boundary.
    "tests/strategic.test.ts",
    "tests/video-backpressure.test.ts", // Real TCP/WebSocket/subprocess backpressure.
    "tests/evaluation-policy.test.ts", // Durable SQLite, restart and cross-process reservations.
    "tests/evaluation-evidence.test.ts", // Real Store and observer; synthetic provider-event seam only.
    "tests/evaluation-tiers.test.ts", // Real artifact freshness boundary, zero native startup.
    "tests/minecraft-world-seed.test.ts", // Real filesystem configuration; no native process provisioning.
  ]),
});

export function tierTests(tier: "unit" | "integration", selected: readonly string[] = []): readonly string[] {
  const available: readonly string[] = TEST_TIERS[tier];
  if (!selected.length) return available;
  return selected.map(input => {
    const path = input.replace(/^\.\//, "");
    const match = available.find(candidate => candidate === path || basename(candidate) === path);
    if (!match) throw new Error(`${input} is not classified in the ${tier} tier`);
    return match;
  });
}

export function requireTierOptIn(tier: VerificationTier, options: { allowNative?: boolean; allowInference?: boolean }): void {
  if ((tier === "native-game" || tier === "agent-acceptance") && options.allowNative !== true)
    throw new Error("Real Minecraft/Docker requires explicit --allow-native opt-in");
  if (tier === "agent-acceptance" && options.allowInference !== true)
    throw new Error("Actual provider inference requires explicit --allow-inference opt-in");
}

/** Only native build inputs affect native freshness. JS schema/prompt/UI changes do not rebuild Java. */
export function assertNativeArtifactFresh(projectRoot: string, jarPath: string): { jarPath: string; sha256: string; newestInput: string | null } {
  const root = resolve(projectRoot);
  const artifact = resolve(root, jarPath);
  const jar = lstatSync(artifact);
  if (!jar.isFile() || jar.isSymbolicLink() || jar.size === 0 || !artifact.endsWith(".jar"))
    throw new Error("Native tier requires an existing nonempty regular built JAR, not a symlink");
  let newestInput: string | null = null;
  let newestTime = 0;
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("Native build inputs must not traverse symlinks");
    if (info.isDirectory()) { for (const child of readdirSync(path)) visit(join(path, child)); }
    else if (info.isFile() && info.mtimeMs > newestTime) { newestTime = info.mtimeMs; newestInput = path; }
  };
  visit(join(root, "native/minecraft/src"));
  for (const name of ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties", "gradlew"])
    visit(join(root, "native/minecraft", name));
  visit(join(root, "native/minecraft/gradle"));
  if (newestTime > jar.mtimeMs)
    throw new Error(`Native JAR is stale relative to ${relative(root, newestInput!)}; explicitly run bun run build:native before opting in again`);
  if (newestInput === null) throw new Error("Native source inputs are missing; artifact freshness cannot be established");
  return { jarPath: artifact, sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"), newestInput };
}
