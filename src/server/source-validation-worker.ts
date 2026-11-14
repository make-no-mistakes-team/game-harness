import { createHash } from "node:crypto";
import { resolveArtifactModuleClosure } from "./program-modules.ts";
import { ProgramValidationError, sourceValidationIssuesSchema, validateSkill } from "./program-validation.ts";
import { RegisteredAdapterContract } from "./registered-adapter.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import { assertSourceCompatible, assertSourceDependencies } from "./source-programs.ts";
import { SOURCE_VALIDATION_LIMITS, SourceValidationFrames, assertSourceValidationEnvelope, sourceRefKey, sourceValidationLine,
  sourceValidationMessageSchema, sourceValidationReadSchema, sourceValidationWorkerRequestSchema,
  type SourceValidationMessage, type SourceValidationWorkerRequest } from "./source-validation-protocol.ts";
import type { SkillRef, SkillView } from "../shared/programs.ts";

// The process has no writable store, adapter methods, inherited credentials or
// native/game authority. Stdout is exclusively its bounded source-only protocol.
for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) console[method] = () => {};
async function send(message: SourceValidationMessage): Promise<void> {
  const line = sourceValidationLine(sourceValidationMessageSchema.parse(message));
  const written = Promise.withResolvers<void>();
  process.stdout.write(line, error => error ? written.reject(error) : written.resolve());
  await written.promise;
}
function graphLimit(): never {
  throw new ProgramValidationError([{ code: "source_graph_limit", message: "Source dependency graph exceeds the finite validation envelope.",
    location: null, limit: null }]);
}
const knownErrors: Record<string, Extract<SourceValidationMessage, { kind: "known_error" }>["code"]> = {
  "Dependency depth exceeds eight": "dependency_depth",
  "Dependency is not validated": "dependency_state",
  "Dependency uses an incompatible skill API; retained source is inspectable but cannot execute": "dependency_api",
  "Dependency bytes do not match the immutable source hash": "dependency_hash",
  "Cached source validation is incompatible; retain history and create a fresh immutable revision": "source_incompatible",
  "Executable validation does not match the negotiated adapter contract; retained artifacts are read-only": "source_incompatible",
  "Async run dependencies can only name semantic run children": "run_children",
  "Exact snapshot bytes do not match current canonical validation": "snapshot_bytes",
  "Snapshot validator configuration changed; fresh evidence requires a validated revision": "snapshot_fingerprint",
};
async function validate(request: SourceValidationWorkerRequest, read: (ref: SkillRef) => Promise<SkillView>): Promise<void> {
  const deadlineNs = BigInt(request.deadlineMonotonicNs);
  try {
    if (osMonotonicNs() >= deadlineNs) throw new Error("Source validation expired");
    const registration = new RegisteredAdapterContract(request.context.descriptor, request.context.schemas);
    if (registration.compatibility.compatibility_hash !== request.binding.compatibility_hash)
      throw new RuntimeFault("precondition_failed", "Cached source validation is incompatible; retain history and create a fresh immutable revision");
    if (request.snapshot) assertSourceCompatible(request.snapshot, request.binding);
    const validated = await validateSkill(request.spec, request.context);
    const hash = createHash("sha256").update(validated.source).digest("hex");
    if (request.snapshot) {
      if (validated.source !== request.snapshot.source || hash !== request.snapshot.hash)
        throw new Error("Exact snapshot bytes do not match current canonical validation");
      if (validated.validation.fingerprint !== request.snapshot.validation.fingerprint)
        throw new Error("Snapshot validator configuration changed; fresh evidence requires a validated revision");
    }
    const artifacts = new Map<string, SkillView>(), depths = new Map<string, number>();
    let graphBytes = 0;
    const preload = async (ref: SkillRef, depth: number): Promise<void> => {
      if (depth > 8) throw new Error("Dependency depth exceeds eight");
      const key = sourceRefKey(ref);
      if ((depths.get(key) ?? 0) >= depth) return;
      depths.set(key, depth);
      let artifact = artifacts.get(key);
      if (!artifact) {
        if (artifacts.size >= SOURCE_VALIDATION_LIMITS.graph_nodes) graphLimit();
        artifact = await read(ref);
        if (artifact.skill_id !== ref.skill_id || artifact.version !== ref.version) throw new Error("Invalid immutable source reply");
        graphBytes += Buffer.byteLength(JSON.stringify(artifact), "utf8");
        if (graphBytes > SOURCE_VALIDATION_LIMITS.graph_bytes) graphLimit();
        artifacts.set(key, artifact);
      }
      for (const dependency of artifact.dependencies) await preload(dependency, depth + 1);
    };
    for (const dependency of validated.dependencies) await preload(dependency, 2);
    const skill = (_runId: string, ref: SkillRef): SkillView => {
      const artifact = artifacts.get(sourceRefKey(ref));
      if (!artifact) throw new Error("Missing immutable source reply");
      return artifact;
    };
    assertSourceDependencies({ skill }, "source-only", validated.dependencies, artifact => assertSourceCompatible(artifact, request.binding));
    if (validated.entry === "run" && validated.dependencies.some(ref => skill("source-only", ref).entry !== "run"))
      throw new RuntimeFault("precondition_failed", "Async run dependencies can only name semantic run children");
    if (validated.entry !== "run") resolveArtifactModuleClosure({ compatibility_hash: request.runCompatibilityHash ?? "",
      read: ref => skill("source-only", ref) }, { ...validated, hash });
    if (osMonotonicNs() >= deadlineNs) throw new Error("Source validation expired");
    await send(sourceValidationMessageSchema.parse({ kind: "validated", validated, hash,
      graph: [...artifacts.values()].map(({ skill_id, version }) => ({ skill_id, version })) }));
  } catch (error) {
    const issues = error instanceof ProgramValidationError ? sourceValidationIssuesSchema.safeParse(error.issues) : null;
    // Only the existing, precisely known domain errors carry domain branding.
    const known = error instanceof Error && Object.hasOwn(knownErrors, error.message) ? knownErrors[error.message] : undefined;
    if (issues?.success) await send({ kind: "source_error", issues: issues.data });
    else if (known) await send({ kind: "known_error", code: known });
    else await send({ kind: "backend_error" });
  }
}
async function run(): Promise<void> {
  const frames = new SourceValidationFrames();
  const state: {
    request: SourceValidationWorkerRequest | null;
    job: Promise<void> | null;
    pending: { id: number; ref: SkillRef; resolve: (value: SkillView) => void; reject: (error: Error) => void } | null;
  } = { request: null, job: null, pending: null };
  let completed = false, nextReadId = 1;
  const read = (ref: SkillRef): Promise<SkillView> => {
    if (!state.request || state.pending || completed || nextReadId > SOURCE_VALIDATION_LIMITS.graph_nodes ||
        osMonotonicNs() >= BigInt(state.request.deadlineMonotonicNs)) return Promise.reject(new Error("Invalid source read"));
    const completion = Promise.withResolvers<SkillView>();
    const id = nextReadId++;
    state.pending = { id, ref: { skill_id: ref.skill_id, version: ref.version }, resolve: completion.resolve, reject: completion.reject };
    void send({ kind: "read", id, ref: state.pending.ref }).catch(error => completion.reject(error));
    return completion.promise;
  };
  try {
    // Keep pumping replies while validation awaits a source read. Awaiting the
    // evaluator inside this input loop would deadlock its first dependency RPC.
    for await (const input of process.stdin) {
      frames.push(Buffer.isBuffer(input) ? input : Buffer.from(input), value => {
        if (!state.request) {
          state.request = sourceValidationWorkerRequestSchema.parse(value);
          assertSourceValidationEnvelope(state.request);
          state.job = validate(state.request, read).then(() => { completed = true; });
          // A write failure must stop stdin too, not leave the process awaiting EOF.
          void state.job.catch(() => { process.exitCode = 1; process.stdin.destroy(); });
        } else {
          const reply = sourceValidationReadSchema.parse(value), awaiting = state.pending;
          if (!awaiting || completed || reply.id !== awaiting.id ||
              reply.artifact.skill_id !== awaiting.ref.skill_id || reply.artifact.version !== awaiting.ref.version ||
              osMonotonicNs() >= BigInt(state.request.deadlineMonotonicNs)) throw new Error("Unexpected source reply");
          state.pending = null;
          awaiting.resolve(reply.artifact);
        }
      });
    }
    frames.finish();
    if (!state.request || state.pending) throw new Error("Incomplete source validation job");
    if (state.job) await state.job;
    if (!completed) throw new Error("Incomplete source validation job");
  } finally {
    if (state.pending) state.pending.reject(new Error("Source input closed"));
  }
}
process.stdout.on("error", () => {});
void run().catch(() => { process.exitCode = 1; process.stdin.destroy(); });
