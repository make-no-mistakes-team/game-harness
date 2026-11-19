import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeGapReview } from "../src/server/survival-macro/gap-review.ts";
import {
  MACRO_CAPABILITIES_VERSION, NATIVE_REVIEW_NEW_SOURCE, NATIVE_REVIEW_PUBLIC_PATHS, NATIVE_REVIEW_TEST_PATH, parseMacroProposal,
} from "../src/server/survival-macro/protocol.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const actorJarSha256 = "a".repeat(64);
const source = `package io.gameharness.survival;
final class AgentCapabilityProposal {
    static boolean inside(int x, int limit) { return x >= 0 && x < limit; }
}
`;
const testSource = `package io.gameharness.survival;
final class AgentCapabilityProposalTest {
    static void checkBoundary() {
        if (!AgentCapabilityProposal.inside(0, 4) || AgentCapabilityProposal.inside(4, 4))
            throw new AssertionError("Expected inclusive lower and exclusive upper bounds.");
    }
}
`;
const proposal = (fields: Record<string, unknown>) => ({
  subgoal: "Find an alternative.", reason: "The needed offer is unavailable.",
  successCondition: "A witnessed alternative appears.", contingency: "Stop if none appears.",
  alternative: "Survey safely.", expiresTick: 100,
  action: { kind: "gap", capability: "A missing observation", ...fields },
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "native-gap-review-"));
  const runDir = join(root, "run");
  const checkout = join(root, "base");
  const publicSource = join(checkout, NATIVE_REVIEW_PUBLIC_PATHS[0]);
  await mkdir(dirname(publicSource), { recursive: true });
  await mkdir(runDir, { mode: 0o700 });
  await copyFile(join(projectRoot, NATIVE_REVIEW_PUBLIC_PATHS[0]), publicSource);
  const options = { runDir, projectRoot: checkout, actorJarSha256, capabilityVersion: MACRO_CAPABILITIES_VERSION };
  const review = await createNativeGapReview(options);
  const context = review.context!;
  const patch = {
    baseVersion: context.baseVersion, baseSha256: context.baseSha256,
    scope: "Add a bounded Java helper and an independently reviewable test.",
    files: [{ path: NATIVE_REVIEW_NEW_SOURCE, content: source }, { path: NATIVE_REVIEW_TEST_PATH, content: testSource }],
  };
  return { root, runDir, review, patch, options, publicSource };
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

test("gap schema keeps text-only reports and rejects traversal, scripts, and extra patch fields", async () => {
  expect(parseMacroProposal(proposal({ suggestion: "Describe the missing behavior." })).action).toEqual({
    kind: "gap", capability: "A missing observation", suggestion: "Describe the missing behavior.",
  });
  const { root, patch } = await fixture();
  try {
    for (const path of ["../settings.gradle", "/tmp/AgentCapabilityProposal.java", ".git/hooks/post-checkout",
      "../" + NATIVE_REVIEW_NEW_SOURCE, NATIVE_REVIEW_NEW_SOURCE.replaceAll("/", "\\"), "run.sh",
      NATIVE_REVIEW_NEW_SOURCE.replace("Proposal.java", "Other.java")]) {
      expect(() => parseMacroProposal(proposal({ reviewPatch: {
        ...patch, files: [{ path, content: source }, patch.files[1]],
      } }))).toThrow("review file path");
    }
    expect(() => parseMacroProposal(proposal({ reviewPatch: { ...patch, approved: true } }))).toThrow("review patch");
    expect(() => parseMacroProposal(proposal({ reviewPatch: { ...patch, files: patch.files.slice(0, 1) } }))).toThrow("review code and test files");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("review bundles are owner-only, contain plain data, and never follow a redirected destination", async () => {
  const { root, runDir, review, patch, options } = await fixture();
  try {
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    const reviewRoot = join(runDir, "native-review");
    await symlink(outside, reviewRoot);
    await expect(review.store({ requestId: "fixture-1", capability: "A gap", reviewPatch: patch })).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    await rm(reviewRoot);
    const alias = join(root, "alias");
    await symlink(root, alias);
    const aliased = await createNativeGapReview({ ...options, runDir: join(alias, "run") });
    await expect(aliased.store({ requestId: "alias", capability: "A gap", reviewPatch: patch })).rejects.toThrow();
    await chmod(runDir, 0o755);
    await expect(review.store({ requestId: "fixture-2", capability: "A gap", reviewPatch: patch })).rejects.toThrow("private");
    await chmod(runDir, 0o700);
    const result = await review.store({ requestId: "fixture-3", capability: "A gap", reviewPatch: patch });
    const bundle = join(runDir, result.relativePath);
    expect(result.status).toBe("candidate");
    expect((await stat(reviewRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(bundle)).mode & 0o777).toBe(0o700);
    expect((await readdir(bundle)).sort()).toEqual(["base.json", "candidate.diff.txt", "manifest.json"]);
    for (const name of await readdir(bundle)) expect((await stat(join(bundle, name))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("native review binds the exact source version and diff; missing or mismatched patches remain explicit gaps", async () => {
  const { root, runDir, review, patch } = await fixture();
  try {
    const candidate = async (requestId: string, reviewPatch?: typeof patch) => {
      const stored = await review.store({ requestId, capability: "A gap", reviewPatch });
      const bundle = join(runDir, stored.relativePath);
      const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
      return { stored, bundle, manifest };
    };
    const valid = await candidate("exact", patch);
    const diff = await readFile(join(valid.bundle, "candidate.diff.txt"), "utf8");
    expect(diff).toBe(`--- /dev/null
+++ b/${NATIVE_REVIEW_NEW_SOURCE}
@@ -0,0 +1,4 @@
+package io.gameharness.survival;
+final class AgentCapabilityProposal {
+    static boolean inside(int x, int limit) { return x >= 0 && x < limit; }
+}
--- /dev/null
+++ b/${NATIVE_REVIEW_TEST_PATH}
@@ -0,0 +1,7 @@
+package io.gameharness.survival;
+final class AgentCapabilityProposalTest {
+    static void checkBoundary() {
+        if (!AgentCapabilityProposal.inside(0, 4) || AgentCapabilityProposal.inside(4, 4))
+            throw new AssertionError("Expected inclusive lower and exclusive upper bounds.");
+    }
+}
`);
    expect(valid.manifest.candidate.diff.sha256).toBe(digest(diff));
    expect(valid.manifest.candidate.base).toMatchObject({
      version: MACRO_CAPABILITIES_VERSION, sha256: patch.baseSha256, actorJarSha256,
    });
    expect(valid.manifest.approval).toEqual({
      status: "required", sha256: digest(JSON.stringify(valid.manifest.candidate)),
    });
    const amended = await candidate("amended", {
      ...patch, files: [{ path: NATIVE_REVIEW_NEW_SOURCE, content: source.replace("x < limit", "x <= limit") }, patch.files[1]!],
    });
    expect(amended.manifest.approval.sha256).not.toBe(valid.manifest.approval.sha256);
    const original = review.context!.source[0]!;
    const replacement = original.content.replace("a visible crafting result", "a witnessed crafting result");
    const modified = await candidate("existing-interface", {
      ...patch, files: [{ path: original.path, content: replacement }, patch.files[1]!],
    });
    expect(await readFile(join(modified.bundle, "candidate.diff.txt"), "utf8")).toContain(
      "-/** One scoped vanilla Shift press on a visible crafting result. */\n" +
      "+/** One scoped vanilla Shift press on a witnessed crafting result. */\n",
    );
    expect(modified.manifest.candidate.files[0]).toEqual({
      path: original.path, beforeSha256: digest(original.content), afterSha256: digest(replacement),
    });
    for (const [id, bad] of [["wrong-version", { ...patch, baseVersion: "survival-macro/v999" }],
      ["wrong-base", { ...patch, baseSha256: "0".repeat(64) }], ["no-patch", undefined]] as const) {
      const gap = await candidate(id, bad);
      expect(gap.stored.status).toBe("no-patch");
      expect(gap.manifest.reason).toBe(bad ? "base-mismatch" : "not-proposed");
      expect(await readdir(gap.bundle)).toEqual(["manifest.json"]);
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("source context never follows links or exposes changed bytes at an allowlisted path", async () => {
  const { root, review, options, publicSource } = await fixture();
  try {
    expect(review.context?.source.map(({ path }) => path)).toEqual([NATIVE_REVIEW_PUBLIC_PATHS[0]]);
    const privateFile = join(root, "private");
    await copyFile(publicSource, privateFile);
    await rm(publicSource);
    await symlink(privateFile, publicSource);
    expect((await createNativeGapReview(options)).context).toBeUndefined();
    await rm(publicSource);
    await writeFile(publicSource, "unvetted file data\n");
    expect((await createNativeGapReview(options)).context).toBeUndefined();
  } finally {
    await rm(root, { recursive: true });
  }
});
