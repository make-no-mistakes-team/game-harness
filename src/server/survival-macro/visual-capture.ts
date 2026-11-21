import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SurvivalMacroConfig, UnavailableFrame } from "./controller.ts";
import { readMacroObservation, type MacroObservation } from "./protocol.ts";
import { frameDimensions } from "./terra.ts";

export const FRAME_BYTES = 2 * 1024 * 1024;
export const FRAME_TIMEOUT_MS = 1_000;
const FRAME_DIRECTORY = "macro-frames";
const NATIVE_TIMEOUT_MS = 500;
const MAX_BASIS_TICKS = 40;
const RECEIPT_BYTES = 2_048;
const REQUEST = "visual-capture.json";
const RESULT = "visual-capture-result.json";
const TEXT = new TextDecoder("utf-8", { fatal: true });
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const HOST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPTURE_ID = /^vc-[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const newFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

type Directory = { handle: FileHandle; stamp: BigIntStats; path: string };
type NativeOmission = "not_requested" | "timeout" | "unavailable" | "basis_changed" | "invalid_receipt" | "invalid_image" | "io_error";
type NativeJpeg = { bytes: Buffer; sha256: string; visualBinding: { captureId: string; renderFrame: number } };
type Basis = { v: 1; run: string; life: number; epoch: number; basisTick: number; requestId: string };
type CapturedJpeg = { bytes: Buffer; adapter?: UnavailableFrame["adapter"] };
interface CaptureOptions {
  dir: string;
  width: number;
  height: number;
  signal: AbortSignal;
  assertDisplay: () => void;
  native?: boolean;
  nativeTimeoutMs?: number;
  readJpeg: (signal: AbortSignal, temporary: string) => Promise<CapturedJpeg | UnavailableFrame>;
}

const entry = ({ handle }: Directory, name: string) => `/proc/self/fd/${handle.fd}/${name}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
const inode = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.dev === b.dev;
const owner = (s: BigIntStats, mode: bigint) => s.uid === BigInt(process.getuid!()) && (s.mode & 0o7777n) === mode;
const ownedFile = (s: BigIntStats) => s.isFile() && s.nlink === 1n && owner(s, 0o600n);
const unchanged = (a: BigIntStats, b: BigIntStats) => ownedFile(b) && inode(a, b) &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const stampAt = (file: string) => lstat(file, { bigint: true }).catch(error => {
  if (missing(error)) return undefined;
  throw error;
});

async function openDirectory(file: string): Promise<Directory> {
  if (process.platform !== "linux" || !path.isAbsolute(file))
    throw new Error("Capture directory must be an absolute Linux path.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const stamp = await handle.stat({ bigint: true });
    if (!stamp.isDirectory() || !owner(stamp, 0o700n)) throw new Error("Capture directory is not private.");
    return { handle, stamp, path: file };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function directoryCurrent(directory: Directory) {
  const current = await stampAt(directory.path);
  return !!current?.isDirectory() && owner(current, 0o700n) && inode(directory.stamp, current);
}

export async function initializeFrameArchive(dir: string) {
  const run = await openDirectory(dir);
  try { await mkdir(entry(run, FRAME_DIRECTORY), { mode: 0o700 }); }
  finally { await run.handle.close(); }
}

async function fileCurrent(file: string, stamp: BigIntStats) {
  const current = await stampAt(file);
  return !!current && unchanged(stamp, current);
}

async function removeOwned(file: string, owned?: BigIntStats) {
  const current = await stampAt(file);
  if (current && ownedFile(current) && (!owned || inode(owned, current)))
    await unlink(file).catch(error => { if (!missing(error)) throw error; });
}

async function readOwned(file: string, maximum: number, signal?: AbortSignal) {
  const handle = await open(file, readFlags).catch(error => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!handle) return;
  try {
    const stamp = await handle.stat({ bigint: true });
    if (!ownedFile(stamp) || stamp.size < 1n || stamp.size > BigInt(maximum))
      throw new Error("Capture payload is not a bounded private file.");
    const size = Number(stamp.size);
    const bytes = Buffer.allocUnsafe(size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== size || !unchanged(stamp, await handle.stat({ bigint: true })) || !await fileCurrent(file, stamp))
      throw new Error("Capture payload changed during read.");
    return { bytes: bytes.subarray(0, size), stamp };
  } finally {
    await handle.close();
  }
}

/** Publish complete bytes without replacing a receipt, request, or archive already at the destination. */
async function publish(directory: Directory, name: string, bytes: string | Buffer, signal: AbortSignal) {
  const final = entry(directory, name);
  const temporary = entry(directory, `.visual-${randomUUID()}.tmp`);
  const handle = await open(temporary, newFlags, 0o600);
  let pending = true;
  let linked: BigIntStats | undefined;
  let complete = false;
  try {
    await handle.writeFile(bytes, { signal });
    const written = await handle.stat({ bigint: true });
    if (!ownedFile(written) || !await fileCurrent(temporary, written)) throw new Error("Capture staging was replaced.");
    signal.throwIfAborted();
    await link(temporary, final);
    linked = written;
    await unlink(temporary);
    pending = false;
    const published = await handle.stat({ bigint: true });
    if (written.size !== published.size || written.mtimeNs !== published.mtimeNs || !await fileCurrent(final, published))
      throw new Error("Capture publication was replaced.");
    complete = true;
    return published;
  } finally {
    try {
      if (pending) await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
      if (linked && !complete) await removeOwned(final, linked);
    } finally {
      await handle.close();
    }
  }
}

function sameScope(source: MacroObservation, current: MacroObservation | null): current is MacroObservation {
  return !!current && current.run === source.run && current.life === source.life &&
    current.epoch === source.epoch && current.goal === source.goal && current.health > 0;
}

/** The native render itself must have matched the retained requested pose and projection. */
export function sameNativeFrameScope(source: MacroObservation, current: MacroObservation | null): boolean {
  return sameScope(source, current) && source.visualReady === true && current.visualReady === true &&
    source.safety?.clear === true && current.safety?.clear === true && current.safety.revision === source.safety.revision &&
    current.stance === source.stance && current.health === source.health &&
    current.tick >= source.tick && current.tick - source.tick <= MAX_BASIS_TICKS;
}

const receiptObject = (bytes: Buffer): Record<string, unknown> => {
  const value: unknown = JSON.parse(TEXT.decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capture receipt.");
  return value as Record<string, unknown>;
};

async function captureNative(
  macro: Directory, basis: Basis, width: number, height: number, parent: AbortSignal, timeoutMs: number,
): Promise<NativeJpeg | NativeOmission> {
  const deadline = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  const request = entry(macro, REQUEST);
  const result = entry(macro, RESULT);
  const stage = entry(macro, `visual-frame-${basis.requestId}.jpg`);
  let sent: BigIntStats | undefined;
  let received: BigIntStats | undefined;
  try {
    if (await stampAt(stage)) return "invalid_image";
    sent = await publish(macro, REQUEST, `${JSON.stringify(basis)}\n`, deadline);
    for (;;) {
      deadline.throwIfAborted();
      let receipt: Record<string, unknown> | undefined;
      try {
        const file = await readOwned(result, RECEIPT_BYTES, deadline);
        if (file) {
          const candidate = receiptObject(file.bytes);
          if (candidate.requestId === basis.requestId) {
            received = file.stamp;
            receipt = candidate;
          } else if (typeof candidate.requestId !== "string" || !HOST_UUID.test(candidate.requestId)) {
            return "invalid_receipt";
          }
        }
      } catch {
        return deadline.aborted ? "timeout" : "invalid_receipt";
      }
      if (!receipt) {
        await delay(10, undefined, { signal: deadline });
        continue;
      }
      if (Object.entries(basis).some(([key, value]) => receipt[key] !== value) || !await fileCurrent(request, sent))
        return "invalid_receipt";
      const { status, captureId, renderFrame, width: w, height: h, sha256 } = receipt;
      if (status === "basis_changed" || status === "unavailable")
        return Object.keys(receipt).length === 7 ? status : "invalid_receipt";
      if (status !== "captured" || Object.keys(receipt).length !== 12 ||
          typeof captureId !== "string" || !CAPTURE_ID.test(captureId) ||
          typeof renderFrame !== "number" || !Number.isSafeInteger(renderFrame) || renderFrame < 1 ||
          typeof sha256 !== "string" || !SHA256.test(sha256) ||
          typeof w !== "number" || !Number.isSafeInteger(w) || w < 1 || w > 1_920 ||
          typeof h !== "number" || !Number.isSafeInteger(h) || h < 1 || h > 1_080) return "invalid_receipt";
      let image: Awaited<ReturnType<typeof readOwned>>;
      try { image = await readOwned(stage, FRAME_BYTES, deadline); }
      catch { return deadline.aborted ? "timeout" : "invalid_image"; }
      const size = image && frameDimensions(image.bytes, "image/jpeg");
      if (!image || !size || size[0] !== w || size[1] !== h || w !== width || h !== height ||
          createHash("sha256").update(image.bytes).digest("hex") !== sha256) return "invalid_image";
      if (!received || !await fileCurrent(result, received) || !await fileCurrent(request, sent))
        return "invalid_receipt";
      if (!await fileCurrent(stage, image.stamp)) return "invalid_image";
      deadline.throwIfAborted();
      return { bytes: image.bytes, sha256, visualBinding: { captureId, renderFrame } };
    }
  } catch {
    return deadline.aborted ? "timeout" : "io_error";
  } finally {
    // Removing the exact request cancels native work. Native also checks it after committing
    // and removes its own payload if publication raced this cleanup.
    if (sent) {
      await removeOwned(request, sent);
      if (!received) {
        const late = await readOwned(result, RECEIPT_BYTES).catch(() => undefined);
        if (late) {
          try { if (receiptObject(late.bytes).requestId === basis.requestId) received = late.stamp; }
          catch { /* Not this request's receipt. */ }
        }
      }
      if (received) await removeOwned(result, received);
      await removeOwned(stage);
    }
    parent.throwIfAborted();
  }
}

/** Request-owned archive and native exchange; X11 never acquires a visual binding. */
export function createTrustedFrameCapture({
  dir, width, height, signal, assertDisplay, native, nativeTimeoutMs = NATIVE_TIMEOUT_MS, readJpeg,
}: CaptureOptions): NonNullable<SurvivalMacroConfig["frame"]> {
  if (process.platform !== "linux" || !path.isAbsolute(dir) ||
      !Number.isSafeInteger(nativeTimeoutMs) || nativeTimeoutMs < 1 || nativeTimeoutMs > FRAME_TIMEOUT_MS)
    throw new Error("Trusted capture requires an absolute Linux run directory and a bounded timeout.");
  return async (observation, workSignal, requestId) => {
    assertDisplay();
    const ownerSignal = AbortSignal.any([signal, workSignal]);
    ownerSignal.throwIfAborted();
    const budget = AbortSignal.timeout(FRAME_TIMEOUT_MS);
    const cancel = AbortSignal.any([ownerSignal, budget]);
    if (!SAFE_NAME.test(requestId) || observation.run !== path.basename(dir))
      return { cause: "unavailable", failure: "io_error" };
    const run = await openDirectory(dir);
    let macro: Directory | undefined, archive: Directory | undefined;
    let discard: BigIntStats | undefined;
    let captureSource: "native" | "x11" = "x11";
    let nativeOmission: NativeOmission | undefined = native === undefined ? undefined : "not_requested";
    let nativeCaptureMs: number | undefined;
    const telemetry = () => ({
      captureSource, ...(nativeOmission ? { nativeOmission } : {}),
      ...(nativeCaptureMs === undefined ? {} : { nativeCaptureMs }),
    });
    const filename = `${requestId}.jpg`;
    try {
      const source = macro = await openDirectory(entry(run, "macro"));
      const destination = archive = await openDirectory(entry(run, FRAME_DIRECTORY));
      const live = async () => {
        const current = await readMacroObservation(source.path);
        assertDisplay();
        cancel.throwIfAborted();
        return await directoryCurrent(run) && await directoryCurrent(source) && await directoryCurrent(destination) ? current : null;
      };
      const exact = (current: MacroObservation | null) => sameScope(observation, current) && current.tick === observation.tick;
      let current = await live();
      let bound: NativeJpeg | undefined;
      if (native && HOST_UUID.test(requestId) && sameNativeFrameScope(observation, current)) {
        captureSource = "native";
        nativeOmission = undefined;
        const { run, life, epoch, tick: basisTick } = observation;
        const startedAt = performance.now();
        let nativeJpeg: NativeJpeg | NativeOmission;
        try {
          nativeJpeg = await captureNative(source, { v: 1, run, life, epoch, basisTick, requestId },
            width, height, cancel, nativeTimeoutMs);
        } finally {
          nativeCaptureMs = Math.round(performance.now() - startedAt);
        }
        current = await live();
        if (!sameNativeFrameScope(observation, current) || nativeJpeg === "basis_changed") {
          nativeOmission = "basis_changed";
          return { cause: "basis_changed", ...telemetry() };
        }
        if (typeof nativeJpeg !== "string") {
          bound = nativeJpeg;
          nativeOmission = undefined;
        } else {
          nativeOmission = nativeJpeg;
          if (nativeJpeg !== "unavailable" && nativeJpeg !== "timeout")
            return { cause: "unavailable", failure: nativeJpeg === "invalid_image" ? "invalid_image" : "io_error",
              ...telemetry() };
        }
      }
      const stillCurrent = (value: MacroObservation | null) => bound ? sameNativeFrameScope(observation, value) : exact(value);
      if (!stillCurrent(current)) return { cause: "basis_changed", ...telemetry() };
      if (!bound) captureSource = "x11";
      const provenance = telemetry();
      const result = bound ?? await readJpeg(cancel, entry(destination, `.x11-${randomUUID()}.tmp`));
      if (!bound && !stillCurrent(await live())) return { cause: "basis_changed", ...provenance };
      if ("cause" in result) return native === undefined ? result : { ...result, ...provenance };
      const { bytes } = result;
      const adapter = "adapter" in result ? result.adapter : undefined;
      function unavailable(failure: UnavailableFrame["failure"]) {
        return { cause: "unavailable" as const, failure, ...(adapter ? { adapter } : {}),
          ...(native === undefined ? {} : provenance) };
      }
      let sha256 = bound?.sha256;
      if (!sha256) {
        if (bytes.length < 1) return unavailable("empty_output");
        if (bytes.length > FRAME_BYTES) return unavailable("output_too_large");
        const size = frameDimensions(bytes, "image/jpeg");
        if (!size) return unavailable("invalid_image");
        if (size[0] !== width || size[1] !== height || width < 1 || height < 1 || width > 1_920 || height > 1_080)
          return unavailable("unexpected_dimensions");
        sha256 = createHash("sha256").update(bytes).digest("hex");
      }
      try { discard = await publish(destination, filename, bytes, cancel); }
      catch {
        cancel.throwIfAborted();
        return unavailable("io_error");
      }
      if (!stillCurrent(await live())) return { cause: "basis_changed", ...provenance };
      if (!await fileCurrent(entry(destination, filename), discard)) return unavailable("io_error");
      assertDisplay();
      cancel.throwIfAborted();
      const archived = discard;
      async function withArchive<T>(use: (file: string) => Promise<T>): Promise<T | undefined> {
        const parent = await openDirectory(dir);
        try {
          if (!inode(parent.stamp, run.stamp)) return;
          const frames = await openDirectory(entry(parent, FRAME_DIRECTORY));
          try {
            if (inode(destination.stamp, frames.stamp) && await directoryCurrent(parent) && await directoryCurrent(frames)) {
              const value = await use(entry(frames, filename));
              if (await directoryCurrent(parent) && await directoryCurrent(frames)) return value;
            }
          } finally { await frames.handle.close(); }
        } finally { await parent.handle.close(); }
      }
      const { run: runId, life, epoch, tick } = observation;
      discard = undefined;
      return {
        source: "verified-game-display", ...provenance, run: runId, life, epoch, tick, mimeType: "image/jpeg", width, height, data: bytes,
        ...(bound ? { visualBinding: bound.visualBinding } : {}),
        artifact: {
          relativePath: `${FRAME_DIRECTORY}/${filename}`, sha256,
          verify: async () => (await withArchive(file => fileCurrent(file, archived)).catch(() => false)) === true,
          discard: async () => {
            try { await withArchive(file => removeOwned(file, archived)); }
            catch (error) { if (!missing(error)) throw error; }
          },
        },
      };
    } catch (error) {
      ownerSignal.throwIfAborted();
      if (!budget.aborted) throw error;
      assertDisplay();
      if (!nativeOmission && captureSource === "native") nativeOmission = "timeout";
      return { cause: "unavailable", failure: "timeout", ...telemetry() };
    } finally {
      try {
        if (archive && discard) await removeOwned(entry(archive, filename), discard);
      } finally {
        await Promise.all([archive?.handle.close(), macro?.handle.close(), run.handle.close()]);
      }
    }
  };
}
