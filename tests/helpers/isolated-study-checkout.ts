import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface IsolatedStudyCheckout {
  projectRoot: string;
  ownershipFile: string;
  caseRoot: string;
}

/** A real executing source copy, never symlinked source or a user build tree. */
export function isolatedStudyCheckout(): IsolatedStudyCheckout {
  const sourceRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const privateBase = join(sourceRoot, ".superpowers/sdd/implementation-plan");
  mkdirSync(privateBase, { recursive: true, mode: 0o700 });
  const caseRoot = mkdtempSync(join(privateBase, "owned-study-checkout-"));
  const projectRoot = join(caseRoot, "checkout"); mkdirSync(projectRoot, { mode: 0o700 });
  for (const path of ["src", "scripts", "sandbox", "native/minecraft/src", "tests/helpers", "package.json", "bun.lock", "tsconfig.json", "bunfig.toml",
    "native/minecraft/build.gradle", "native/minecraft/build.gradle.kts", "native/minecraft/settings.gradle",
    "native/minecraft/settings.gradle.kts", "native/minecraft/gradle.properties"]) {
    const source = join(sourceRoot, path);
    if (!existsSync(source)) continue;
    cpSync(source, join(projectRoot, path), { recursive: true, filter: candidate => {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error("Owned executing fixture sources must be copies, not symlinked checkout paths");
      return true;
    } });
  }
  const ownershipFile = join(projectRoot, ".study-fixture-owner.json");
  writeFileSync(ownershipFile, JSON.stringify({ purpose: "isolated_study_execution_test", projectRoot }), { mode: 0o600, flag: "wx" });
  return { projectRoot, ownershipFile, caseRoot };
}
