import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { referenceStudyFixture } from "./reference-study.ts";

/** Actual executing checkout inventory; all synthetic declaration data stay private. */
export function referenceExecutionFixture() {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const privateBase = join(projectRoot, ".superpowers/sdd/implementation-plan");
  mkdirSync(privateBase, { recursive: true, mode: 0o700 });
  const caseRoot = mkdtempSync(join(privateBase, "reference-root-regression-"));
  const fixtureRoot = join(caseRoot, "fixture"); mkdirSync(fixtureRoot, { mode: 0o700 });
  const fixture = referenceStudyFixture(fixtureRoot);
  const manifest = fixture.manifest;
  const identity = (path: string) => ({ path: relative(projectRoot, resolve(path)), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  const map = (value: { path: string; sha256: string }) => ({ path: relative(projectRoot, resolve(fixtureRoot, value.path)), sha256: value.sha256 });
  const inventory: { path: string; sha256: string }[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error("Executing-source fixture cannot admit symlinked source");
    if (entry.isDirectory()) for (const name of readdirSync(path).sort()) { if (name !== "__pycache__") visit(join(path, name)); }
    else if (entry.isFile()) inventory.push(identity(path));
  };
  for (const path of ["src", "scripts", "sandbox", "native/minecraft/src", "policies/gameharness_policy", "policies/pyproject.toml", "bun.lock",
    "package.json", "tsconfig.json", "bunfig.toml", "native/minecraft/build.gradle", "native/minecraft/build.gradle.kts",
    "native/minecraft/settings.gradle", "native/minecraft/settings.gradle.kts", "native/minecraft/gradle.properties"])
    visit(join(projectRoot, path));
  manifest.identities.source = inventory;
  manifest.identities.build = map(manifest.identities.build);
  manifest.identities.dependencies = map(manifest.identities.dependencies);
  manifest.identities.profile = map(manifest.identities.profile);
  manifest.identities.preprocessing = manifest.identities.preprocessing.map(map);
  manifest.identities.controller = map(manifest.identities.controller!);
  manifest.permission.record = map(manifest.permission.record);
  manifest.task.identity = map(manifest.task.identity);
  manifest.task.verifier = identity(join(projectRoot, "policies/gameharness_policy/minerl_environment.py"));
  manifest.arms = manifest.arms.map(arm => ({ ...arm, profile: manifest.identities.profile }));
  const state = manifest.initial_states[0]!;
  const bundlePath = resolve(fixtureRoot, state.save!.path);
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  bundle.fixtures = bundle.fixtures.map((entry: { path: string }) => ({ ...entry, path: relative(projectRoot, resolve(fixtureRoot, entry.path)) }));
  writeFileSync(bundlePath, JSON.stringify(bundle));
  state.save = identity(bundlePath);
  const manifestPath = join(fixtureRoot, "private/study.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  return { projectRoot, caseRoot, fixtureRoot, manifest, manifestPath, controllerPath: resolve(projectRoot, manifest.identities.controller.path),
    governanceRoot: join(caseRoot, "governance"), cli: join(projectRoot, "scripts/policy-reference.ts") };
}
