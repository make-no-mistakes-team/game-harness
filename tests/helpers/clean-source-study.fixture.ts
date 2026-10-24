import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [entry, checkout] = process.argv.slice(2);
if (!entry || !checkout) throw new Error("Missing owned source-only checkout selection");
const projectRoot = realpathSync(checkout);
if (basename(projectRoot) !== "checkout" || !/^(owned-study-checkout-|clean-source-study-)/.test(basename(dirname(projectRoot))))
  throw new Error("Clean-source driver only owns private copied test checkouts");
const nativeJar = join(projectRoot, "native/minecraft/build/libs/gameharness-native-1.0.0.jar");
if (existsSync(nativeJar)) throw new Error("Clean-source regression must begin without a generated native artifact");
const ownershipFile = join(projectRoot, ".study-fixture-owner.json");
if (!existsSync(ownershipFile))
  writeFileSync(ownershipFile, JSON.stringify({ purpose: "isolated_study_execution_test", projectRoot }), { mode: 0o600, flag: "wx" });
console.log(`CLEAN_SOURCE_STATE ${JSON.stringify({ generatedJarInitiallyAbsent: !existsSync(nativeJar), projectRoot })}`);

// Runtime-selected copied module: its own import.meta.url identifies the owned
// source tree. No executing source is symlinked to the user's checkout.
const fixtureModule = await import(resolve(projectRoot, "tests/helpers/study-execution-fixture.ts"));
const fixture = fixtureModule.studyExecutionFixture(true, "clean-source-entry-fixture", { isolatedCheckout: { projectRoot, ownershipFile } });
process.argv = [process.argv[0]!, process.argv[1]!, entry, projectRoot, projectRoot,
  fixture.manifestPath, fixture.caseRoot, "cwd"];
// Reuse the actual registration/entry/external-sentinel fixture. Nothing here
// supplies a fabricated reservation or substitutes executing-source validation.
await import(resolve(projectRoot, "tests/helpers/study-source-binding.fixture.ts"));
