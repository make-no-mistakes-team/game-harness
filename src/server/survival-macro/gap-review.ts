import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
  NATIVE_REVIEW_MAX_FILE_BYTES, NATIVE_REVIEW_NEW_SOURCE, NATIVE_REVIEW_PUBLIC_PATHS, NATIVE_REVIEW_TEST_PATH,
  parseMacroReviewPatch, validateMacroId, type MacroReviewContext, type MacroReviewPatch,
} from "./protocol.ts";

const REVIEW_DIR = "native-review";
const DIFF_FILE = "candidate.diff.txt";
const BASE_FILE = "base.json";
const MANIFEST_FILE = "manifest.json";
const FORMAT = "survival-native-gap-review/v1";
// Only these reviewed bytes may reach the model or a review snapshot. A dirty
// or newer checkout does not expand this disclosure, even at a known path.
const PUBLIC_DIGESTS = [
  "aef6d89c58c46655056460e8f36f70198bbe82c5338ddd98d214461762fc1f2d",
  "b502124d101262926acaf06b12ac2255c009d6a33f6b3216f8588e1ae928a4ea",
  "e57de73f412c5efd0abe2ffcba96def4680a23bd4994ad6ed34f21c0bd921838",
] as const;
const NEW_PATHS = [NATIVE_REVIEW_NEW_SOURCE, NATIVE_REVIEW_TEST_PATH] as const;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

interface NativeGapReviewOptions {
  readonly runDir: string;
  readonly projectRoot: string;
  readonly capabilityVersion: string;
  readonly actorJarSha256: string;
}

interface Gap {
  readonly requestId: string;
  readonly capability: string;
  readonly suggestion?: string;
  readonly reviewPatch?: MacroReviewPatch;
}

type NoPatch = "not-proposed" | "base-unavailable" | "base-mismatch" | "outside-snapshot" | "unchanged-code";
type StoredGap = { readonly relativePath: string } & (
  { readonly status: "candidate"; readonly approvalSha256: string } |
  { readonly status: "no-patch"; readonly reason: NoPatch }
);

export interface NativeGapReview {
  readonly context?: MacroReviewContext;
  store(gap: Gap): Promise<StoredGap>;
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const entry = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`;
const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function privateDirectory(dir: FileHandle): Promise<void> {
  const info = await dir.stat();
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("Native review directory is not private.");
}

async function openCanonicalDirectory(directory: string): Promise<FileHandle> {
  if (process.platform !== "linux" || !isAbsolute(directory) || resolve(directory) !== directory)
    throw new Error("Native review requires a canonical absolute Linux directory.");
  const root = await open("/", DIRECTORY);
  if (directory === "/") return root;
  try {
    return await descend(root, directory.slice(1).split("/"));
  } finally {
    await root.close();
  }
}

async function descend(root: FileHandle, segments: readonly string[]): Promise<FileHandle> {
  let dir = root;
  try {
    for (const segment of segments) {
      const child = await open(entry(dir, segment), DIRECTORY);
      if (dir !== root) await dir.close();
      dir = child;
    }
    return dir;
  } catch (error) {
    if (dir !== root) await dir.close();
    throw error;
  }
}

/** Used only with fixed, host-allowlisted project paths; never with a proposed path. */
async function publicEntry<T>(root: FileHandle, path: string, use: (file: string) => Promise<T>): Promise<T | undefined> {
  const segments = path.split("/");
  const name = segments.pop()!;
  let dir = root;
  try {
    dir = await descend(root, segments);
    return await use(entry(dir, name));
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  } finally {
    if (dir !== root) await dir.close();
  }
}

async function readPublicSource(file: string, expected: string): Promise<string | undefined> {
  const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > NATIVE_REVIEW_MAX_FILE_BYTES) return;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) return;
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== before.size || hash(bytes.subarray(0, length)) !== expected) return;
    return bytes.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
}

async function baseSnapshot(options: NativeGapReviewOptions) {
  const { actorJarSha256, capabilityVersion, projectRoot } = options;
  if (!/^[a-f0-9]{64}$/.test(actorJarSha256) || !/^[A-Za-z0-9._:/-]{1,128}$/.test(capabilityVersion))
    throw new Error("Invalid native review base identity.");
  const root = await openCanonicalDirectory(projectRoot);
  try {
    for (const path of NEW_PATHS) if (await publicEntry(root, path, lstat)) return;
    const source: MacroReviewContext["source"][number][] = [];
    for (const [index, path] of NATIVE_REVIEW_PUBLIC_PATHS.entries()) {
      const sha256 = PUBLIC_DIGESTS[index]!;
      const content = await publicEntry(root, path, file => readPublicSource(file, sha256));
      if (content !== undefined) source.push(Object.freeze({ path, sha256, content }));
    }
    if (!source.length) return;
    const identity = {
      format: FORMAT, version: capabilityVersion, actorJarSha256, absentPaths: NEW_PATHS,
      files: Object.freeze(source.map(({ path, sha256 }) => Object.freeze({ path, sha256 }))),
    };
    const sha256 = hash(JSON.stringify(identity));
    const context: MacroReviewContext = Object.freeze({
      baseVersion: capabilityVersion, baseSha256: sha256, source: Object.freeze(source),
      newSourcePath: NATIVE_REVIEW_NEW_SOURCE, testPath: NATIVE_REVIEW_TEST_PATH,
    });
    return { identity: Object.freeze({ ...identity, sha256 }), context };
  } finally {
    await root.close();
  }
}

function fileDiff(path: string, before: string | undefined, after: string): string {
  const oldLines = before?.split("\n").slice(0, -1) ?? [];
  const newLines = after.split("\n").slice(0, -1);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const start = Math.max(0, prefix - 3);
  const tail = Math.min(3, oldLines.length - oldEnd);
  const oldLength = oldEnd + tail - start, newLength = newEnd + tail - start;
  const from = before === undefined ? "/dev/null" : `a/${path}`;
  const mark = (lines: string[], marker: string) => lines.map(line => marker + line + "\n").join("");
  return `--- ${from}\n+++ b/${path}\n@@ -${oldLength ? start + 1 : start},${oldLength} +${newLength ? start + 1 : start},${newLength} @@\n` +
    mark(oldLines.slice(start, prefix), " ") + mark(oldLines.slice(prefix, oldEnd), "-") +
    mark(newLines.slice(prefix, newEnd), "+") + mark(oldLines.slice(oldEnd, oldEnd + tail), " ");
}

function candidateFor(gap: Gap, base: Awaited<ReturnType<typeof baseSnapshot>>) {
  if (!gap.reviewPatch) return "not-proposed" as const;
  if (!base) return "base-unavailable" as const;
  const patch = parseMacroReviewPatch(gap.reviewPatch);
  if (patch.baseVersion !== base.context.baseVersion || patch.baseSha256 !== base.context.baseSha256) return "base-mismatch" as const;
  const diffParts: string[] = [];
  const files = [];
  let codeChanged = false;
  for (const file of [...patch.files].sort((a, b) => a.path < b.path ? -1 : a.path === b.path ? 0 : 1)) {
    const previous = base.context.source.find(({ path }) => path === file.path);
    if (!previous && file.path !== base.context.newSourcePath && file.path !== base.context.testPath) return "outside-snapshot" as const;
    if (file.content === previous?.content) continue;
    codeChanged ||= file.path !== base.context.testPath;
    diffParts.push(fileDiff(file.path, previous?.content, file.content));
    files.push({ path: file.path, beforeSha256: previous?.sha256 ?? null, afterSha256: hash(file.content) });
  }
  if (!codeChanged) return "unchanged-code" as const;
  const diff = diffParts.join("");
  const candidate = {
    scope: patch.scope, base: base.identity, files,
    diff: { file: DIFF_FILE, sha256: hash(diff), bytes: Buffer.byteLength(diff) },
  };
  return { diff, candidate, approvalSha256: hash(JSON.stringify(candidate)) };
}

async function writePlain(dir: FileHandle, name: string, text: string): Promise<void> {
  const file = await open(entry(dir, name), constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(text, "utf8");
  } finally {
    await file.close();
  }
}

/** Draft storage only. There is intentionally no approval or application operation. */
export async function createNativeGapReview(options: NativeGapReviewOptions): Promise<NativeGapReview> {
  const base = await baseSnapshot(options).catch(() => undefined);
  return {
    context: base?.context,
    async store(gap) {
      const requestId = validateMacroId(gap.requestId, "review request");
      const draft = candidateFor(gap, base);
      const run = await openCanonicalDirectory(options.runDir);
      try {
        await privateDirectory(run);
        const directory = entry(run, REVIEW_DIR);
        try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
        const review = await open(directory, DIRECTORY);
        try {
          await privateDirectory(review);
          const folder = basename(await mkdtemp(entry(review, "proposal-")));
          const relativePath = `${REVIEW_DIR}/${folder}`;
          const bundle = await open(entry(review, folder), DIRECTORY);
          const metadata = { format: FORMAT, requestId, capability: gap.capability, suggestion: gap.suggestion ?? null };
          try {
            await privateDirectory(bundle);
            if (typeof draft === "string") {
              await writePlain(bundle, MANIFEST_FILE, json({ ...metadata, status: "no-patch", reason: draft }));
              return { relativePath, status: "no-patch", reason: draft };
            }
            await writePlain(bundle, BASE_FILE, json({ identity: base!.identity, source: base!.context.source }));
            await writePlain(bundle, DIFF_FILE, draft.diff);
            await writePlain(bundle, MANIFEST_FILE, json({
              ...metadata, status: "candidate", candidate: draft.candidate,
              approval: { status: "required", sha256: draft.approvalSha256 },
              instructions: "Untrusted proposal. Neither the code nor tests were run. A separate development process must verify the base and diff, and obtain explicit human approval of this exact approval SHA-256 before applying changes.",
            }));
            return { relativePath, status: "candidate", approvalSha256: draft.approvalSha256 };
          } catch (error) {
            for (const name of [MANIFEST_FILE, DIFF_FILE, BASE_FILE]) await unlink(entry(bundle, name)).catch(() => {});
            await rmdir(entry(review, folder)).catch(() => {});
            throw error;
          } finally {
            await bundle.close();
          }
        } finally {
          await review.close();
        }
      } finally {
        await run.close();
      }
    },
  };
}
