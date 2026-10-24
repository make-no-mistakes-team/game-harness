import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { liveStudyManifest, studyManifest } from "./study-manifest.ts";
import type { IsolatedStudyCheckout } from "./isolated-study-checkout.ts";

/** Executing checkout provenance; only declaration data and storage are disposable/private. */
export function studyExecutionFixture(live = false, studyId?: string, options: { isolatedCheckout?: Pick<IsolatedStudyCheckout, "projectRoot" | "ownershipFile"> } = {}) {
  const projectRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  if (live) {
    if (basename(projectRoot) !== "checkout" || !/^(owned-study-checkout-|clean-source-study-)/.test(basename(dirname(projectRoot))))
      throw new Error("Synthetic native artifacts are confined to owned private source-copy fixtures");
    const owned = options.isolatedCheckout;
    if (!owned || realpathSync(owned.projectRoot) !== projectRoot || resolve(owned.ownershipFile) !== join(projectRoot, ".study-fixture-owner.json"))
      throw new Error("Live execution fixtures require an explicitly owned copied checkout; user-generated artifacts are never inputs");
    const marker = lstatSync(owned.ownershipFile);
    if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("Owned fixture marker must be a regular private file");
    const proof = JSON.parse(readFileSync(owned.ownershipFile, "utf8"));
    if (proof.purpose !== "isolated_study_execution_test" || proof.projectRoot !== projectRoot)
      throw new Error("Owned fixture marker does not match this actual executing module tree");
  }
  const privateBase = join(projectRoot, ".superpowers/sdd/implementation-plan");
  mkdirSync(privateBase, { recursive: true, mode: 0o700 });
  const caseRoot = mkdtempSync(join(privateBase, "study-source-binding-"));
  const fixtureRoot = join(caseRoot, "declaration"); mkdirSync(fixtureRoot, { mode: 0o700 });
  const manifest = live ? liveStudyManifest(fixtureRoot, studyId ?? "executing-checkout-live") : studyManifest(fixtureRoot, studyId ?? "executing-checkout-admission");
  if (live) {
    const artifact = "native/minecraft/build/libs/gameharness-native-1.0.0.jar";
    const destination = join(projectRoot, artifact);
    if (existsSync(destination)) throw new Error("Owned live fixture artifact must not overwrite any existing artifact");
    mkdirSync(join(projectRoot, "native/minecraft/build/libs"), { recursive: true, mode: 0o700 });
    writeFileSync(destination, readFileSync(join(fixtureRoot, artifact)), { mode: 0o600, flag: "wx" });
  }
  const identity = (path: string) => ({ path: relative(projectRoot, resolve(path)), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  const remap = (value: { path: string; sha256: string }) => ({ path: relative(projectRoot, resolve(fixtureRoot, value.path)), sha256: value.sha256 });
  const inventory: { path: string; sha256: string }[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error("Actual study source fixture cannot admit a symlinked source inventory");
    if (entry.isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child));
    else if (entry.isFile()) inventory.push(identity(path));
  };
  for (const path of ["src", "scripts", "sandbox", "native/minecraft/src", "package.json", "tsconfig.json", "bunfig.toml",
    "native/minecraft/build.gradle", "native/minecraft/build.gradle.kts", "native/minecraft/settings.gradle",
    "native/minecraft/settings.gradle.kts", "native/minecraft/gradle.properties"]) visit(join(projectRoot, path));
  manifest.identities.source = inventory;
  manifest.identities.source.push(identity(join(fixtureRoot, "src/platform.ts")));
  manifest.identities.dependencies = identity(join(projectRoot, "bun.lock"));
  manifest.identities.build = live ? identity(join(projectRoot, "native/minecraft/build/libs/gameharness-native-1.0.0.jar")) : remap(manifest.identities.build);
  manifest.identities.profile = remap(manifest.identities.profile);
  manifest.permission.record = remap(manifest.permission.record);
  manifest.task.identity = remap(manifest.task.identity);
  manifest.task.verifier = live ? identity(join(projectRoot, "src/server/minecraft-adapter.ts")) : remap(manifest.task.verifier);
  for (const arm of manifest.arms) arm.profile = manifest.identities.profile;
  const manifestPath = join(fixtureRoot, "study.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  return { projectRoot, caseRoot, fixtureRoot, manifest, manifestPath, governanceRoot: join(caseRoot, "governance"),
    runtimeRoot: join(caseRoot, "runtime"), reportsRoot: join(caseRoot, "reports") };
}
