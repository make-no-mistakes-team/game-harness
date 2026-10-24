import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalReferenceJson, controllerManifestHash, validateControllerManifest } from "../shared/controllers.ts";
import type { StudyManifest } from "./studies.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fixtureBundle = z.object({ schema_version: z.literal(1), kind: z.literal("declared_reference_fixture_bundle"),
  reset: z.literal("seed_before_each_effective_reset"), seed: z.number().int().nonnegative(),
  fixtures: z.array(z.object({ id: z.enum(["dirt", "wood"]), path: z.string().min(1), sha256: hash, bytes: z.number().int().positive() }).strict()).length(2),
}).strict();

function verifyPinnedFile(project: string, path: string, sha256: string) {
  const absolute = resolve(project, path), rel = relative(project, absolute), entry = lstatSync(absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || realpathSync(absolute) !== absolute || !entry.isFile() || entry.isSymbolicLink())
    throw new Error("Reference declaration input must be a project-local regular file without symlinks");
  const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  const file = openSync(absolute, "r");
  let bytes = 0;
  try {
    let count: number;
    while ((count = readSync(file, buffer)) > 0) { digest.update(buffer.subarray(0, count)); bytes += count; }
  } finally { closeSync(file); }
  if (bytes !== entry.size || digest.digest("hex") !== sha256) throw new Error(`Reference declaration file hash mismatch: ${path}`);
  return { path: absolute, bytes };
}

function pinnedFile(project: string, path: string, sha256: string): Buffer {
  const checked = verifyPinnedFile(project, path, sha256);
  if (checked.bytes > 4 * 1024 * 1024) throw new Error("Reference declaration metadata exceeds its finite byte limit");
  return readFileSync(checked.path);
}

/** Additional capability branch in the existing ledger, never a parallel authority. */
export function validateReferenceStudyDeclaration(manifest: StudyManifest, project: string): void {
  const { identities, execution, allowances } = manifest;
  if (manifest.admission_mode !== "live" || execution.controller_mode !== "released_policy_reference"
    || execution.start_mode !== "declared_reference_fixture" || execution.adaptation !== "frozen_released_policy"
    || execution.sidecars.length || execution.request_paths.length || identities.model !== null || identities.helpers.length
    || identities.adapter !== "minerl-original-reference" || identities.game?.id !== "minecraft" || identities.game.version !== "1.16.5"
    || identities.observation_schema !== 1 || manifest.arms.some(arm => arm.model !== null || arm.helpers.length)
    || allowances.per_attempt.host_requests !== 0 || allowances.cohort.host_requests !== 0
    || allowances.per_attempt.concurrent_requests !== 0 || allowances.cohort.concurrent_requests !== 0
    || allowances.per_attempt.workers !== 1 || allowances.cohort.workers !== 1
    || manifest.schedule.length !== 1 || manifest.repetitions !== 1 || manifest.optional_blocks.length || manifest.arms.length !== 1 || manifest.initial_states.length !== 1)
    throw new Error("Unsupported released_policy_reference declaration; exact null-provider/one-slot/frozen-fixture variant required");
  if (!identities.controller) throw new Error("Reference study requires its exact controller manifest identity");
  const controller = validateControllerManifest(JSON.parse(pinnedFile(project, identities.controller.path, identities.controller.sha256).toString("utf8")));
  if (!controller.execution) throw new Error("Reference controller must freeze the actual execution image and resource partitions");
  if (identities.dependencies.sha256 !== controller.runtime.dependency_lock_sha256
    || !identities.preprocessing.some(identity => identity.sha256 === controller.runtime.configuration_sha256))
    throw new Error("Reference study must pin the controller's exact dependency inventory and effective configuration");
  if (allowances.per_attempt.wall_ms !== controller.limits.total_wall_ms || allowances.cohort.attempt_wall_ms !== controller.limits.total_wall_ms
    || allowances.cohort.elapsed_ms < controller.limits.total_wall_ms || manifest.task.horizon_ms !== controller.limits.total_wall_ms)
    throw new Error("Reference study/controller finite allocation mismatch");
  const profile = JSON.parse(pinnedFile(project, identities.profile.path, identities.profile.sha256).toString("utf8"));
  const expectedProfile = { schema_version: 1, controller_manifest_sha256: controllerManifestHash(controller),
    observation: { schema_version: 1, kind: "rgb", permitted_keys: ["pov"] },
    preprocessing: controller.preprocessing, action_mapping: controller.action_mapping, clock: "synchronous" };
  if (canonicalReferenceJson(profile) !== canonicalReferenceJson(expectedProfile)) throw new Error("Reference profile must be the exact original RGB/preprocessing/action contract, not the native adapter descriptor");
  const state = manifest.initial_states[0]!;
  if (state.mode !== "declared_reference_fixture" || state.settings !== null || !state.save || state.seed !== String(controller.simulator.reset_seed))
    throw new Error("Reference initial state requires its declared fixture bundle and exact pre-reset seed; no prepared-save equivalence claim");
  const bundle = fixtureBundle.parse(JSON.parse(pinnedFile(project, state.save.path, state.save.sha256).toString("utf8")));
  if (bundle.seed !== controller.simulator.reset_seed || new Set(bundle.fixtures.map(value => value.id)).size !== 2) throw new Error("Reference fixture seed/identity mismatch");
  for (const behavior of controller.behaviors) {
    const fixture = bundle.fixtures.find(value => value.id === behavior.id);
    if (!fixture || fixture.sha256 !== behavior.fixture_sha256 || !fixture.path.endsWith(".zip")) throw new Error("Reference fixture/controller hash mismatch");
    const checked = verifyPinnedFile(project, fixture.path, fixture.sha256);
    if (checked.bytes !== fixture.bytes) throw new Error("Reference fixture byte length mismatch");
    if (behavior.verifier_sha256 !== manifest.task.verifier.sha256) throw new Error("Reference verifier/controller identity mismatch");
  }
  const build = JSON.parse(pinnedFile(project, identities.build.path, identities.build.sha256).toString("utf8"));
  if (canonicalReferenceJson(build) !== canonicalReferenceJson({ schema_version: 1, image: controller.execution.image,
    runner_tree_sha256: controller.execution.runner_tree_sha256 })) throw new Error("Reference image/runner build declaration mismatch");
  const sourcePaths = new Set(identities.source.map(value => resolve(project, value.path)));
  const visit = (path: string): void => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error("Reference Python source inventory cannot contain symlinks");
    if (entry.isDirectory()) for (const name of readdirSync(path)) { if (name !== "__pycache__") visit(join(path, name)); }
    else if (entry.isFile() && !sourcePaths.has(path)) throw new Error(`Reference source inventory is incomplete: ${relative(project, path)}`);
  };
  const policies = join(project, "policies", "gameharness_policy");
  if (!existsSync(policies)) throw new Error("Reference runner source is unavailable");
  visit(policies);
  const metadata = join(project, "policies", "pyproject.toml");
  if (!sourcePaths.has(metadata)) throw new Error("Reference package metadata is absent from the source inventory");
  const hostLock = join(project, "bun.lock");
  if (existsSync(hostLock) && !sourcePaths.has(hostLock)) throw new Error("Reference source inventory must separately retain the host dependency lock");
}
