import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { SkillRef, SkillView } from "../shared/programs.ts";
import { ProgramValidationError } from "./program-validation.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import { SOURCE_VALIDATION_LIMITS, SourceValidationFrames, assertSourceValidationEnvelope, encodeSourceValidationSpec,
  sourceRefKey, sourceValidationLine, sourceValidationMessageSchema, sourceValidationReadSchema,
  sourceValidationWorkerRequestSchema, type SourceValidationRequest, type SourceValidationResult } from "./source-validation-protocol.ts";

const workerPath = fileURLToPath(new URL("./source-validation-worker.ts", import.meta.url));
let activeJobs = 0;
const backendFailure = () => new Error("Source validation backend failed; no source was published");
function knownError(code: string): Error {
  switch (code) {
    case "dependency_depth": return new Error("Dependency depth exceeds eight");
    case "dependency_state": return new Error("Dependency is not validated");
    case "dependency_api": return new RuntimeFault("precondition_failed", "Dependency uses an incompatible skill API; retained source is inspectable but cannot execute");
    case "dependency_hash": return new RuntimeFault("stale_context", "Dependency bytes do not match the immutable source hash");
    case "source_incompatible": return new RuntimeFault("precondition_failed", "Cached source validation is incompatible; retain history and create a fresh immutable revision");
    case "run_children": return new RuntimeFault("precondition_failed", "Async run dependencies can only name semantic run children");
    case "snapshot_bytes": return new Error("Exact snapshot bytes do not match current canonical validation");
    case "snapshot_fingerprint": return new Error("Snapshot validator configuration changed; fresh evidence requires a validated revision");
    default: return backendFailure();
  }
}
export interface SourceValidationAdmission {
  readonly validated: SourceValidationResult["validated"];
  readonly hash: string;
  /** Recheck immutable source and metadata on the canonical owner, inside its scoped commit. */
  assertCurrent(): void;
}
export interface SourceValidationOptions {
  signal?: AbortSignal;
  /** Original absolute caller deadline in the caller/coordinator's performance.now() clock. */
  deadlineHostMs?: number;
}

/** One finite child process, no queue or local fallback. Settlement joins exit and all pipes. */
export async function validateSourceInWorker(request: SourceValidationRequest,
  read: (ref: SkillRef) => SkillView, assertScope: () => void,
  options: SourceValidationOptions = {}): Promise<SourceValidationAdmission> {
  const startedNs = osMonotonicNs(), startedHostMs = performance.now();
  if (options.deadlineHostMs !== undefined && !Number.isFinite(options.deadlineHostMs)) throw backendFailure();
  const allowanceMs = Math.min(SOURCE_VALIDATION_LIMITS.job_ms,
    options.deadlineHostMs === undefined ? SOURCE_VALIDATION_LIMITS.job_ms : options.deadlineHostMs - startedHostMs);
  const deadlineNs = startedNs + BigInt(Math.floor(Math.max(0, allowanceMs) * 1_000_000));
  const assertActive = () => {
    if (options.signal?.aborted) throw new Error("Source validation cancelled; no source was published");
    if (osMonotonicNs() >= deadlineNs) throw new Error("Source validation deadline exceeded; no source was published");
    assertScope();
  };
  assertActive();
  let line: string;
  let wire: unknown;
  try {
    // A RuntimeAdapter structurally satisfies ExecutableValidationContext, but
    // contains methods. Admit only the declared source-only descriptor/catalog.
    const metadata: SourceValidationRequest = { spec: request.spec, ...(request.snapshot ? { snapshot: request.snapshot } : {}),
      context: { descriptor: request.context.descriptor, schemas: request.context.schemas },
      binding: request.binding, runCompatibilityHash: request.runCompatibilityHash };
    assertSourceValidationEnvelope(metadata);
    wire = { ...metadata, kind: "validate", spec: encodeSourceValidationSpec(metadata.spec), deadlineMonotonicNs: deadlineNs.toString() };
    line = sourceValidationLine(wire);
  } catch {
    throw new ProgramValidationError([{ code: "source_validation_envelope_limit",
      message: "Source validation input exceeds the finite plain metadata envelope.", location: null, limit: null }]);
  }
  // A malformed trusted contract is infrastructure failure, not a source issue.
  // Detachment and schema validation both finish before the first await.
  try { sourceValidationWorkerRequestSchema.parse(wire); }
  catch { throw backendFailure(); }
  assertActive();
  if (activeJobs >= SOURCE_VALIDATION_LIMITS.concurrent_jobs) throw backendFailure();
  activeJobs++;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | undefined;
  const completion = Promise.withResolvers<void>();
  const closure = Promise.withResolvers<void>();
  const pins = new Map<string, { ref: SkillRef; identity: string }>();
  const frames = new SourceValidationFrames();
  let terminal = false, closed = false, graphBytes = 0, nextReadId = 1;
  let failure: Error | null = null, result: SourceValidationResult | null = null;
  const fail = (error: Error): void => {
    failure ??= error;
    terminal = true;
    completion.resolve();
    // No graceful IPC cancellation can interrupt synchronous validation. The
    // independently owned process is killed; close still owns the drain barrier.
    if (!closed) { try { child?.kill("SIGKILL"); } catch { /* close owns the join. */ } }
  };
  const abort = () => fail(new Error("Source validation cancelled; no source was published"));
  const armDeadline = () => {
    const remaining = deadlineNs - osMonotonicNs();
    if (remaining <= 0n) fail(new Error("Source validation deadline exceeded; no source was published"));
    else timer = setTimeout(armDeadline, Math.max(1, Number(remaining / 1_000_000n)));
  };
  try {
    assertActive();
    try {
      child = spawn(process.execPath, ["--no-env-file", workerPath], { cwd: path.dirname(workerPath),
        // Never inherit credential, proxy, preload, NODE_OPTIONS or BUN_OPTIONS configuration.
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" }, stdio: ["pipe", "pipe", "pipe"] });
    } catch { throw backendFailure(); }
    const owned = child;
    owned.on("error", () => fail(backendFailure()));
    owned.stdin!.on("error", () => fail(backendFailure()));
    owned.stdout!.on("error", () => fail(backendFailure()));
    owned.stderr!.on("error", () => fail(backendFailure()));
    // Consume but never expose child diagnostics, including native crash text.
    owned.stderr!.on("data", () => {});
    owned.on("exit", (code, signal) => {
      if (code !== 0 || signal !== null || !result) fail(backendFailure());
    });
    owned.once("close", () => {
      closed = true;
      queueMicrotask(() => { closure.resolve(); completion.resolve(); });
    });
    owned.stdout!.on("data", (chunk: Buffer) => {
      if (failure) return;
      try {
        frames.push(chunk, value => {
          if (terminal) throw backendFailure();
          try { assertActive(); }
          catch (error) { fail(error instanceof Error ? error : backendFailure()); return; }
          const message = sourceValidationMessageSchema.parse(value);
          if (message.kind === "read") {
            if (message.id !== nextReadId++) throw backendFailure();
            const key = sourceRefKey(message.ref);
            if (pins.has(key) || pins.size >= SOURCE_VALIDATION_LIMITS.graph_nodes) throw backendFailure();
            let artifact: SkillView;
            try { artifact = read(message.ref); }
            catch (error) { fail(error instanceof Error ? error : backendFailure()); return; }
            try { assertActive(); }
            catch (error) { fail(error instanceof Error ? error : backendFailure()); return; }
            assertSourceValidationEnvelope(artifact);
            const reply = sourceValidationReadSchema.parse({ kind: "artifact", id: message.id, artifact });
            if (reply.artifact.skill_id !== message.ref.skill_id || reply.artifact.version !== message.ref.version) throw backendFailure();
            const identity = JSON.stringify(reply.artifact);
            graphBytes += Buffer.byteLength(identity, "utf8");
            if (graphBytes > SOURCE_VALIDATION_LIMITS.graph_bytes)
              throw new ProgramValidationError([{ code: "source_graph_limit",
                message: "Source dependency graph exceeds the finite validation envelope.", location: null, limit: null }]);
            pins.set(key, { ref: { ...message.ref }, identity: JSON.stringify(artifact) });
            owned.stdin!.write(sourceValidationLine(reply), error => { if (error) fail(backendFailure()); });
          } else if (message.kind === "source_error") fail(new ProgramValidationError(message.issues));
          else if (message.kind === "known_error") fail(knownError(message.code));
          else if (message.kind === "backend_error") fail(backendFailure());
          else {
            if (message.graph.length !== pins.size || new Set(message.graph.map(sourceRefKey)).size !== pins.size ||
                message.graph.some(ref => !pins.has(sourceRefKey(ref))) ||
                createHash("sha256").update(message.validated.source).digest("hex") !== message.hash) throw backendFailure();
            result = message; terminal = true;
            // EOF is the child's explicit input fence; it exits only after the
            // terminal write has completed. Extra output remains a protocol fault.
            owned.stdin!.end();
          }
        });
      } catch (error) {
        fail(error instanceof ProgramValidationError ? error : backendFailure());
      }
    });
    owned.stdout!.on("end", () => {
      try { frames.finish(); if (!terminal) throw backendFailure(); }
      catch { fail(backendFailure()); }
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    armDeadline();
    if (!terminal) owned.stdin!.write(line, error => { if (error) fail(backendFailure()); });
    await completion.promise;
  } finally {
    if (child) {
      if (!closed) { try { child.kill("SIGKILL"); } catch { /* close owns the join. */ } }
      await closure.promise;
    }
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    activeJobs--;
  }
  if (failure) throw failure;
  assertActive();
  if (!result) throw backendFailure();
  const admitted: SourceValidationResult = result;
  return { validated: admitted.validated, hash: admitted.hash, assertCurrent() {
    assertActive();
    for (const pin of pins.values()) {
      if (JSON.stringify(read(pin.ref)) !== pin.identity)
        throw new RuntimeFault("stale_context", "Validated immutable source dependency changed before publication");
    }
  } };
}
