import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core/types";
import type { Json } from "../shared/contracts.ts";
import type { ResidentAnalysisWorker, ResidentWorker } from "../shared/resident.ts";
import { ResidentCleanupError, residentActorLimitsSchema, residentAnalysisInputSchema, residentAnalysisOutputSchema,
  residentIntentSchema, residentStateSchema } from "../shared/resident.ts";
import { controlSessionConfigSchema } from "../shared/control-session.ts";
import { preparedStartActive, preparedStartRequestSchema, PREPARED_START_LIMITS,
  type PreparedStartRequest, type PreparedStartView } from "../shared/prepared-start.ts";
import type { AuthManager } from "./auth.ts";
import type { SandboxService } from "./sandbox.ts";
import type { PreparationContract, PreparedSourceCandidate } from "./prepared-source-contract.ts";
import { adapterCompatibility, canonicalContractJson } from "./adapter-contract.ts";
import { PreparedSourcebook, inactivePreparedWriteSchema } from "./prepared-sourcebook.ts";
import { PreparedInference } from "./prepared-inference.ts";
import { analysisValidateAsSchema, helpSchema, programSelectorSchema } from "./program-interface.ts";
import { programHelp } from "./program-help.ts";
import { emptyRunUsage } from "./usage.ts";
import { PreparedSourceFault, preparationFailure } from "./prepared-source-error.ts";
import { HOST_MONOTONIC_CLOCK_ID } from "./performance.ts";
import { GeneratedControllerResultValidationError, parseGeneratedResidentResult } from "./program-diagnostics.ts";

export interface PreparedSourceOptions {
  directory: string;
  auth: Pick<AuthManager, "snapshot" | "createAgent" | "releaseAgent">;
  sandbox: Pick<SandboxService, "createResidentWorker" | "createResidentAnalysisWorker">;
  getContract(): Promise<PreparationContract>;
  assertCanStart(): void;
  onReady(candidate: PreparedSourceCandidate): Promise<{ run_id: string }>;
  onCancel(): Promise<void>;
  changed(): void;
  record(type: string, summary: string, details: Json): void;
}
const finishSchema = programSelectorSchema.required({ version: true }).extend({ args: residentIntentSchema,
  initial_state: residentStateSchema, limits: residentActorLimitsSchema, session: controlSessionConfigSchema }).strict();
type Finish = z.infer<typeof finishSchema>;
const inspectSchema = z.discriminatedUnion("view", [z.object({ view: z.literal("catalog") }).strict(),
  programSelectorSchema.extend({ view: z.literal("source") }).strict()]);
const analyzeSchema = programSelectorSchema.required({ version: true }).extend({ input: residentAnalysisInputSchema,
  validate_as: analysisValidateAsSchema.optional() }).strict();
type Attempt = {
  request: PreparedStartRequest; identity: string; view: PreparedStartView; file: string;
  deadlineHostMs: number;
  journalBytes: number;
  work: Promise<void> | null; cancellation: Promise<void> | null; abort: AbortController;
  compileAbort: AbortController; agent: Agent | null; inference: PreparedInference | null;
  book: PreparedSourcebook | null; selection: Finish | null; worker: ResidentWorker | null;
  transferred: boolean; launch: boolean; transferDrainConfirmed: boolean; timer: NodeJS.Timeout | null;
  unknown: boolean; interrupted: boolean; unreachableUnknown: boolean;
  analysisWorker: ResidentAnalysisWorker | null; toolWork: Set<Promise<unknown>>;
};
const EVIDENCE_LIMITS = Object.freeze({ journal_bytes: 16 * 1024 ** 2, record_bytes: 2 * 1024 ** 2,
  terminal_reserve_bytes: 1024 ** 2 });
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Owns source-only inference through confirmed drain and a one-use clean-worker transfer. */
export class PreparedSource {
  private readonly attempts = new Map<string, Attempt>();
  private latest: Attempt | null = null;
  private initialized = false;
  private closed = false;
  private journalBlocked = false;
  private readonly unsettled = new Set<Attempt>();
  private readonly directory: string;
  constructor(private readonly options: PreparedSourceOptions) { this.directory = join(options.directory, "prepared-source"); }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    for (const name of readdirSync(this.directory).sort()) {
      if (!/^[a-f0-9-]{36}\.jsonl$/.test(name)) continue;
      const file = join(this.directory, name);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > EVIDENCE_LIMITS.journal_bytes + EVIDENCE_LIMITS.terminal_reserve_bytes)
        throw new PreparedSourceFault("Preparation journal is not a bounded regular file; prior evidence remains untouched");
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      let header: { request: PreparedStartRequest; view: PreparedStartView } | null = null;
      let view: PreparedStartView | null = null, damaged = false;
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (row.type === "attempt.created") { header = row.details; view = row.details.view; }
          if (row.type === "attempt.state") view = row.details;
          if (row.type === "worker.transferred") view = row.details.view;
        } catch { damaged = true; break; }
      }
      if (!header || !view) throw new PreparedSourceFault("Prepared source journal has no readable declaration; ownership cannot be reconstructed");
      const request = preparedStartRequestSchema.parse(header.request);
      const interrupted = damaged || preparedStartActive(view) || view.closure === "open" || view.closure === "draining";
      const attempt = this.makeAttempt(request, file, structuredClone(view), performance.now());
      attempt.journalBytes = stat.size;
      attempt.interrupted = interrupted;
      if (interrupted) {
        attempt.unknown = true; attempt.view.phase = "failed"; attempt.view.closure = "unknown";
        attempt.view.error = "Preparation interrupted by process exit; prior owners have no verified closure. No model call or candidate is replayed.";
        this.save(attempt);
      }
      if (this.attempts.has(request.request_id)) throw new PreparedSourceFault("Conflicting durable prepared request identities");
      this.attempts.set(request.request_id, attempt);
      if (!this.latest || this.latest.view.started_at <= attempt.view.started_at) this.latest = attempt;
    }
    // An older unknown owner must not be hidden by a newer terminal receipt.
    this.latest = [...this.attempts.values()].find(attempt => attempt.view.closure === "unknown") ?? this.latest;
    this.initialized = true;
  }
  snapshot(): PreparedStartView | null { return this.latest ? structuredClone(this.latest.view) : null; }
  async start(raw: PreparedStartRequest): Promise<PreparedStartView> {
    if (!this.initialized || this.closed) throw new PreparedSourceFault("Prepared source owner is not available");
    const request = preparedStartRequestSchema.parse(raw), identity = canonicalContractJson(request);
    const previous = this.attempts.get(request.request_id);
    if (previous) {
      if (previous.identity !== identity) throw new PreparedSourceFault("Prepared request_id conflicts with its original immutable body");
      return structuredClone(previous.view);
    }
    if (this.journalBlocked) throw new PreparedSourceFault("Preparation evidence persistence is unavailable; no new request is admitted");
    if (this.unsettled.size || [...this.attempts.values()].some(attempt => preparedStartActive(attempt.view)))
      throw new PreparedSourceFault("A prepared start still owns active or unconfirmed resources");
    this.options.assertCanStart();
    const auth = this.options.auth.snapshot();
    if (!auth.authenticated || auth.status !== "ready" || !auth.models.some(model =>
      model.id === request.model_id && model.input_modalities?.includes("image")))
      throw new PreparedSourceFault("Choose an exact currently discovered model from the authenticated account");
    const admittedHost = performance.now(), now = Date.now(), id = randomUUID();
    const view: PreparedStartView = { preparation_id: id, task: request.task, goal: structuredClone(request.goal),
      model_id: request.model_id, phase: "authoring", started_at: new Date(now).toISOString(),
      deadline_at: new Date(now + PREPARED_START_LIMITS.duration_ms).toISOString(), ready_at: null, run_id: null,
      requests_admitted: 0, tools_used: 0, source_versions: 0, analysis_jobs: 0, analysis_ms: 0,
      program: null, usage: emptyRunUsage(), limits: PREPARED_START_LIMITS, closure: "open", error: null };
    const attempt = this.makeAttempt(request, join(this.directory, `${id}.jsonl`), view,
      admittedHost + PREPARED_START_LIMITS.duration_ms);
    this.append(attempt, "attempt.created", { request: request as unknown as Json, view: view as unknown as Json,
      evidence_limits: EVIDENCE_LIMITS, deadline_host_ms: attempt.deadlineHostMs });
    this.attempts.set(request.request_id, attempt); this.latest = attempt;
    attempt.timer = setTimeout(() => { void this.cancel(id, "Original finite preparation deadline reached").catch(() => {}); },
      Math.max(0, attempt.deadlineHostMs - performance.now()));
    this.unsettled.add(attempt);
    attempt.work = Promise.resolve().then(() => this.run(attempt)).finally(() => {
      this.unsettled.delete(attempt);
    });
    this.options.changed(); return structuredClone(view);
  }
  async cancel(preparationId: string, reason = "Preparation cancelled by operator"): Promise<PreparedStartView> {
    const attempt = [...this.attempts.values()].find(value => value.view.preparation_id === preparationId);
    if (!attempt) throw new PreparedSourceFault("Unknown prepared start");
    if (attempt.interrupted) return structuredClone(attempt.view);
    if (attempt.transferred && attempt.view.phase === "started")
      throw new PreparedSourceFault("Prepared source has transferred to a real run; use ordinary run controls");
    if (["closed", "transferred"].includes(attempt.view.closure) && !preparedStartActive(attempt.view)) return structuredClone(attempt.view);
    // Fence synchronously before any await, including a late createAgent/compile readiness result.
    attempt.abort.abort(reason); if (!attempt.transferred) attempt.compileAbort.abort(reason);
    attempt.agent?.abort(reason);
    attempt.view.phase = "cancelling"; attempt.view.closure = "draining"; attempt.view.error = reason;
    try { this.save(attempt); }
    catch {
      this.journalBlocked = true;
      attempt.view.error = "Preparation fenced; state evidence could not be persisted";
    }
    if (!attempt.cancellation) {
      const cancellation = (async () => {
        let launchFailure: unknown = null;
        try { if (attempt.launch) await this.options.onCancel(); } catch (error) { launchFailure = error; }
        await attempt.work;
        await this.drain(attempt);
        if (launchFailure || attempt.transferred && !attempt.transferDrainConfirmed) {
          attempt.unknown = true;
          attempt.view.error = launchFailure ? preparationFailure(launchFailure).error : "Transferred runtime owner has not confirmed launch cleanup";
        }
        attempt.view.phase = attempt.unknown ? "failed" : "cancelled";
        attempt.view.closure = attempt.unknown ? "unknown" : "closed";
        this.clearTimer(attempt);
        try { this.save(attempt); }
        catch {
          this.journalBlocked = true;
          attempt.view.error = "Preparation cleanup settled, but final evidence could not be persisted";
          this.options.changed();
        }
      })();
      attempt.cancellation = cancellation;
      void cancellation.finally(() => { if (attempt.cancellation === cancellation) attempt.cancellation = null; }).catch(() => {});
    }
    await attempt.cancellation; return structuredClone(attempt.view);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const attempt of this.attempts.values()) if (preparedStartActive(attempt.view) && !attempt.interrupted)
      await this.cancel(attempt.view.preparation_id, "Preparation owner closed");
    await Promise.all([...this.attempts.values()].map(attempt => attempt.work));
    if ([...this.attempts.values()].some(attempt => attempt.view.closure === "unknown"))
      throw new PreparedSourceFault("Prepared source ownership closure remains unknown");
  }
  private makeAttempt(request: PreparedStartRequest, file: string, view: PreparedStartView, deadlineHostMs: number): Attempt {
    return { request: structuredClone(request), identity: canonicalContractJson(request), file, view,
      deadlineHostMs,
      journalBytes: 0,
      work: null, cancellation: null, abort: new AbortController(), compileAbort: new AbortController(),
      agent: null, inference: null, book: null, selection: null, worker: null, transferred: false, launch: false,
      transferDrainConfirmed: false, timer: null, unknown: view.closure === "unknown", interrupted: false,
      analysisWorker: null, toolWork: new Set(), unreachableUnknown: false };
  }
  private append(attempt: Attempt, type: string, details: Json): void {
    if (this.journalBlocked) throw new PreparedSourceFault("Preparation evidence persistence is unavailable");
    const line = `${JSON.stringify({ type, at: new Date().toISOString(),
      host_clock_id: HOST_MONOTONIC_CLOCK_ID, host_monotonic_ms: performance.now(), details })}\n`;
    const bytes = Buffer.byteLength(line);
    const terminal = type === "attempt.failure" || type === "attempt.state" &&
      ["cancelling", "cancelled", "failed", "started"].includes(attempt.view.phase);
    const maximum = EVIDENCE_LIMITS.journal_bytes + (terminal ? EVIDENCE_LIMITS.terminal_reserve_bytes : 0);
    if (bytes > EVIDENCE_LIMITS.record_bytes || attempt.journalBytes + bytes > maximum) {
      attempt.abort.abort("Finite preparation evidence budget exhausted");
      if (!attempt.transferred) attempt.compileAbort.abort(attempt.abort.signal.reason);
      attempt.agent?.abort("Finite preparation evidence budget exhausted");
      throw new PreparedSourceFault("Finite preparation evidence budget exhausted");
    }
    try {
      const fd = openSync(attempt.file, "a", 0o600);
      try { writeFileSync(fd, line); fsyncSync(fd); attempt.journalBytes += bytes; }
      finally { closeSync(fd); }
      if (type === "attempt.created") {
        const parent = openSync(this.directory, "r");
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
    } catch {
      this.journalBlocked = true;
      attempt.abort.abort("Preparation evidence persistence failed");
      if (!attempt.transferred) attempt.compileAbort.abort(attempt.abort.signal.reason);
      attempt.agent?.abort("Preparation evidence persistence failed");
      throw new PreparedSourceFault("Preparation evidence persistence failed");
    }
  }
  private save(attempt: Attempt): void {
    this.append(attempt, "attempt.state", attempt.view as unknown as Json); this.options.changed();
  }
  private current(attempt: Attempt): void {
    if (attempt.abort.signal.aborted && typeof attempt.abort.signal.reason === "string")
      throw new PreparedSourceFault(attempt.abort.signal.reason);
    if (this.closed || attempt.abort.signal.aborted || this.latest !== attempt || attempt.unknown ||
      performance.now() >= attempt.deadlineHostMs) throw new PreparedSourceFault("Prepared start authority expired or was revoked");
  }
  private clearTimer(attempt: Attempt): void {
    if (attempt.timer) { clearTimeout(attempt.timer); attempt.timer = null; }
  }
  private async releaseInference(attempt: Attempt): Promise<void> {
    let failure: unknown = null;
    if (attempt.agent) {
      try { await this.options.auth.releaseAgent(attempt.agent); attempt.agent = null; }
      catch (error) { failure = error; }
    }
    await Promise.allSettled([...attempt.toolWork]);
    if (attempt.inference) {
      try { await attempt.inference.drain(); attempt.inference = null; }
      catch (error) { failure ??= error; }
    }
    if (failure) { attempt.unknown = true; throw failure; }
  }
  private async drain(attempt: Attempt): Promise<void> {
    let unknown = false;
    try { await this.releaseInference(attempt); } catch { unknown = true; }
    if (attempt.worker && !attempt.transferred) {
      try { await attempt.worker.close(); attempt.worker = null; } catch { unknown = true; }
    }
    if (attempt.analysisWorker) {
      try { await attempt.analysisWorker.close(); attempt.analysisWorker = null; } catch { unknown = true; }
    }
    attempt.unknown = unknown || attempt.unreachableUnknown ||
      attempt.transferred && !attempt.transferDrainConfirmed;
  }
  private async run(attempt: Attempt): Promise<void> {
    try {
      this.current(attempt);
      const contract = await this.options.getContract(); this.current(attempt);
      const compatibility = adapterCompatibility(contract.adapter.descriptor, contract.adapter.schemas);
      if (attempt.request.goal.adapter_id !== contract.adapter.descriptor.adapter.id)
        throw new PreparedSourceFault("Prepared goal does not belong to the trusted artifact adapter");
      const goal = attempt.request.goal, declared = contract.adapter.goals.find(value => value.goal_id === goal.goal_id);
      const custom = goal.goal_id === "custom" && goal.verifier === null;
      if (!custom && (!declared || canonicalContractJson(declared) !== canonicalContractJson(goal)))
        throw new PreparedSourceFault("Preparation requires an actual registered goal and verifier version");
      if (!/^[a-f0-9]{64}$/.test(contract.artifact_sha256)) throw new PreparedSourceFault("Preparation requires a trusted artifact SHA-256");
      this.append(attempt, "artifact.bound", { artifact_sha256: contract.artifact_sha256,
        compatibility_hash: compatibility.compatibility_hash, descriptor: contract.adapter.descriptor as unknown as Json,
        schemas: contract.adapter.schemas as unknown as Json });
      const book = new PreparedSourcebook(compatibility.compatibility_hash, contract.adapter,
        (type, data) => this.append(attempt, type, data), () => this.current(attempt));
      attempt.book = book;
      const systemPrompt = [this.prompt()], tools = this.tools(attempt, contract);
      this.append(attempt, "model.context", { model_id: attempt.request.model_id, system_prompt: systemPrompt,
        tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters as Json })) });
      const agent = await this.options.auth.createAgent({ modelId: attempt.request.model_id, systemPrompt, tools });
      attempt.agent = agent; this.current(attempt);
      attempt.inference = new PreparedInference(agent, attempt.view.usage, (type, data) => {
        this.append(attempt, type, data); this.save(attempt);
      }, () => {
        this.current(attempt);
        if (attempt.view.requests_admitted >= PREPARED_START_LIMITS.max_requests) throw new PreparedSourceFault("Finite preparation request budget exhausted");
        if (attempt.view.tools_used >= PREPARED_START_LIMITS.max_tools) throw new PreparedSourceFault("Finite preparation tool budget exhausted");
        attempt.view.requests_admitted++;
      }, () => this.current(attempt), () => attempt.selection !== null);
      const prompt = { preparation_id: attempt.view.preparation_id, request: attempt.request,
        artifact_sha256: contract.artifact_sha256, compatibility_hash: compatibility.compatibility_hash,
        deadline_at: attempt.view.deadline_at, limits: PREPARED_START_LIMITS,
        world_state: null, observation: null, native_identity: null,
        controller_reference: this.help({ topic: "controller" }, contract, tools) };
      this.append(attempt, "model.prompt", prompt as unknown as Json);
      await agent.prompt(JSON.stringify(prompt));
      this.current(attempt);
      await this.releaseInference(attempt); this.current(attempt);
      if (!attempt.selection) throw new PreparedSourceFault("Selected model did not seal an exact executive root with prepare_finish");
      const selection = attempt.selection, root = book.select(selection);
      attempt.view.phase = "compiling"; this.save(attempt);
      const bundle = book.bundle(root, true);
      const worker = await this.options.sandbox.createResidentWorker(bundle, selection.limits.step_ms, attempt.compileAbort.signal);
      attempt.worker = worker; this.current(attempt);
      if (!worker.activate) throw new PreparedSourceFault("Compiled prepared worker does not expose executive activation");
      const header = freeze(structuredClone({ request: attempt.request, artifact_sha256: contract.artifact_sha256,
        contract_hash: compatibility.compatibility_hash, root: { skill_id: root.skill_id, version: root.version },
        sources: book.sources(root), bundle, initial_state: selection.initial_state, intent: selection.args,
        limits: selection.limits, session: selection.session, usage: attempt.view.usage }));
      const candidate: PreparedSourceCandidate = Object.freeze({ ...header, preparation_id: attempt.view.preparation_id,
        deadline_host_ms: attempt.deadlineHostMs,
        assertCurrent: () => { if (!attempt.transferred) this.current(attempt); },
        setPhase: (phase: "joining" | "activating") => {
          if (attempt.transferred) throw new PreparedSourceFault("Prepared phase authority already transferred");
          this.current(attempt); attempt.view.phase = phase; this.save(attempt);
        },
        takeWorker: (runId: string) => {
          this.current(attempt);
          if (attempt.transferred || !attempt.worker) throw new PreparedSourceFault("Prepared worker ownership can transfer exactly once");
          if (!runId.trim()) throw new PreparedSourceFault("Actual admitted Runtime run ID is required for worker transfer");
          const selected = attempt.worker;
          const transferredView: PreparedStartView = { ...attempt.view, closure: "transferred", phase: "started", run_id: runId };
          this.append(attempt, "worker.transferred", { run_id: runId, root: header.root, source_hash: header.bundle.source_hash,
            view: transferredView as unknown as Json, meaning: "runtime_owns_worker_not_closed" });
          // No fallible I/O or observer callback may occur after ownership moves
          // but before the actual admitted Runtime receives its worker.
          attempt.view = transferredView;
          attempt.transferred = true; attempt.worker = null; this.clearTimer(attempt);
          return selected;
        },
        transferClosed: (confirmed: boolean) => {
          if (!attempt.transferred) throw new PreparedSourceFault("Prepared worker was never transferred");
          attempt.transferDrainConfirmed = confirmed;
          if (!confirmed) attempt.unknown = true;
          this.append(attempt, "worker.transfer_cleanup", { confirmed });
        },
      });
      attempt.view.phase = "ready"; attempt.view.ready_at = new Date().toISOString();
      this.append(attempt, "source.sealed", header as unknown as Json); this.save(attempt);
      this.current(attempt); attempt.launch = true;
      const result = await this.options.onReady(candidate);
      if (!attempt.transferred) throw new PreparedSourceFault("Launch returned without taking actual prepared worker ownership");
      if (result.run_id !== attempt.view.run_id) throw new PreparedSourceFault("Launch substituted the actual admitted run ID");
      attempt.view.run_id = result.run_id; attempt.view.phase = "started"; attempt.view.closure = "transferred";
      this.clearTimer(attempt); this.save(attempt);
      this.options.record("preparation.started", "Source-only preparation transferred to actual runtime admission", {
        preparation_id: attempt.view.preparation_id, run_id: result.run_id, source_hash: header.bundle.source_hash,
        qualification: "source_compiled_not_gameplay_qualification" });
    } catch (error) {
      attempt.view.error = preparationFailure(error).error;
      if (error instanceof ResidentCleanupError && !attempt.worker && !attempt.analysisWorker)
        attempt.unreachableUnknown = true;
      await this.drain(attempt);
      if (attempt.transferred && !attempt.transferDrainConfirmed) attempt.unknown = true;
      this.clearTimer(attempt);
      if (!attempt.cancellation) {
        attempt.view.phase = "failed"; attempt.view.closure = attempt.unknown ? "unknown" : "closed";
        try {
          this.append(attempt, "attempt.failure", { ...preparationFailure(error),
            type: error instanceof Error ? error.name.slice(0, 80) : "UnknownFailure" });
          this.save(attempt);
        } catch {
          // Physical closure was already joined. Audit failure is not a false
          // claim that the worker remains open, and cannot authorize another job.
          this.journalBlocked = true; attempt.view.error = "Preparation owners drained, but final evidence could not be persisted";
          this.options.changed();
        }
      }
    }
  }
  private tools(attempt: Attempt, contract: PreparationContract): AgentTool[] {
    const tool = <T>(name: string, description: string, schema: z.ZodType<T>,
      handle: (input: T, callId: string, requestId: string) => Json | Promise<Json>): AgentTool => ({
      name, label: name, description, intent: "omit", concurrency: "exclusive", strict: false, lenientArgValidation: true,
      parameters: z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }),
      execute: (callId, raw, signal) => {
        const task: Promise<AgentToolResult<Json>> = (async (): Promise<AgentToolResult<Json>> => {
        let identity: string | null = null;
        try {
          const parsed = schema.safeParse(raw);
          identity = canonicalContractJson({ tool: name, input: parsed.success ? parsed.data : raw });
          const book = attempt.book!;
          const replay = book.receipt(callId, identity);
          if (replay !== undefined) return { content: [{ type: "text", text: JSON.stringify(replay) }], details: replay,
            ...(replay && typeof replay === "object" && "failed" in replay && replay.failed === true ? { isError: true } : {}) };
          this.current(attempt);
          if (signal?.aborted || attempt.selection) throw new PreparedSourceFault("Prepared source tools are fenced");
          const requestId = attempt.inference!.requestFor(callId, name);
          if (attempt.view.tools_used >= PREPARED_START_LIMITS.max_tools) throw new PreparedSourceFault("Finite preparation tool budget exhausted");
          attempt.view.tools_used++;
          this.append(attempt, "tool.admitted", { request_id: requestId, call_id: callId, tool: name,
            input: (parsed.success ? parsed.data : raw) as Json });
          if (!parsed.success) throw parsed.error;
          const input = parsed.data;
          const value = await handle(input, callId, requestId);
          this.current(attempt);
          if (name !== "program_write") book.complete(callId, identity, value);
          attempt.view.source_versions = book.versions; this.save(attempt);
          return { content: [{ type: "text", text: JSON.stringify(value) }], details: value,
            ...(value && typeof value === "object" && "failed" in value && value.failed === true ? { isError: true } : {}) };
        } catch (error) {
          const details: Json = { failed: true, ...preparationFailure(error) };
          this.append(attempt, "tool.failed", { call_id: callId, tool: name, details });
          if (identity && attempt.book) {
            try {
              if (attempt.book.receipt(callId, identity) === undefined) attempt.book.complete(callId, identity, details);
            } catch { /* An immutable conflicting call must never overwrite its original receipt. */ }
          }
          this.save(attempt);
          return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
        }
        })();
        attempt.toolWork.add(task);
        void task.finally(() => attempt.toolWork.delete(task)).catch(() => {});
        return task;
      },
    });
    const tools: AgentTool[] = [
      tool("help", "Inspect actual authored program, controller, game and action schema references. This does not observe a world.", helpSchema,
        input => this.help(input, contract, tools)),
      tool("program_write", "Save validated inactive immutable source. Entry defaults to step: the root module exports step(frame,state,intent) and activate(frame,state,intent). Explicit entry run is an async BODY for semantic children, without a function wrapper, imports or exports. Use a separate entry analyze wrapper for software tests or entry library for helpers. No outcome-linked reason or playing authority.", inactivePreparedWriteSchema,
        (input, callId, requestId) => attempt.book!.write(input, callId, requestId)),
      tool("program_inspect", "Inspect named prepared catalog or exact canonical source; contains no execution or native observations.", inspectSchema,
        input => input.view === "catalog" ? attempt.book!.catalog() : attempt.book!.publicSource(attempt.book!.select(input))),
      tool("program_analyze", "Execute a disposable pure analyze wrapper importing your exact step candidate on explicitly model-authored synthetic software-test JSON. Optional validate_as checks only the returned activation/decision shape, not gameplay or live acceptance. Cannot invoke the clean playing worker.", analyzeSchema,
        async input => {
          this.current(attempt);
          if (attempt.view.analysis_jobs >= PREPARED_START_LIMITS.max_analysis_jobs || attempt.view.analysis_ms >= PREPARED_START_LIMITS.max_analysis_ms)
            throw new PreparedSourceFault("Finite preparation analysis allowance exhausted");
          const root = attempt.book!.select(input);
          if (root.entry !== "analyze") throw new PreparedSourceFault("Software analysis must select an exact analyze entry");
          const bundle = attempt.book!.bundle(root);
          const budget = Math.floor(Math.min(PREPARED_START_LIMITS.analysis_job_ms,
            PREPARED_START_LIMITS.max_analysis_ms - attempt.view.analysis_ms,
            attempt.deadlineHostMs - performance.now()));
          if (budget <= 0) throw new PreparedSourceFault("Preparation deadline reached");
          attempt.view.analysis_jobs++; this.save(attempt);
          let worker: ResidentAnalysisWorker | null = null;
          let elapsed: number | null = null, accountingFailure = false, reportOpen = true;
          try {
            worker = await this.options.sandbox.createResidentAnalysisWorker(bundle, budget, attempt.abort.signal);
            attempt.analysisWorker = worker;
            this.current(attempt);
            const result = await worker.analyze(input.input, attempt.abort.signal, value => {
              if (!reportOpen || elapsed !== null || !Number.isFinite(value) || value < 0 ||
                value > Number.MAX_SAFE_INTEGER || attempt.view.analysis_ms + value > Number.MAX_SAFE_INTEGER) {
                accountingFailure = true; return;
              }
              elapsed = value; attempt.view.analysis_ms += value;
            });
            this.current(attempt);
            if (elapsed === null || accountingFailure || elapsed > budget) throw new PreparedSourceFault("Invalid or over-budget trusted analysis evaluation report");
            // Only bounded plain JSON can be retained as a raw failed result.
            // Do not serialize an invalid object while trying to explain it.
            residentAnalysisOutputSchema.parse(result);
            const response = { qualification: "synthetic_software_test_only",
              source: { name: root.name, version: root.version, hash: root.hash },
              input: input.input, output: result, evaluation_ms: elapsed };
            try {
              if (input.validate_as === "activation") parseGeneratedResidentResult(result, true);
              else if (input.validate_as === "decision") parseGeneratedResidentResult(result);
            } catch (error) {
              if (!(error instanceof GeneratedControllerResultValidationError)) throw error;
              const failed = { ...response, failed: true, ...preparationFailure(error) };
              this.append(attempt, "analysis.return_validation_failed", { ...failed, realm_hash: bundle.source_hash });
              return failed;
            }
            return { ...response,
              ...(input.validate_as ? { validation: { validate_as: input.validate_as, qualification: "software_return_shape_only" } } : {}) };
          } catch (error) {
            if (error instanceof ResidentCleanupError && !worker) attempt.unreachableUnknown = true;
            throw error;
          }
          finally {
            reportOpen = false;
            if (worker) try { await worker.close(); attempt.analysisWorker = null; }
            catch (error) { attempt.unknown = true; throw error; }
          }
        }),
      tool("prepare_finish", "Select and seal an exact complete step candidate for a bounded real-world development trial, not efficacy certification. Requires activate, initial args/state, finite limits and session. Ends inference before clean compile/launch; no task-success claim or exhaustive-test prerequisite.", finishSchema,
        input => {
          this.current(attempt);
          const root = attempt.book!.select(input);
          if (root.entry !== "step") throw new PreparedSourceFault("Preparation must select a step executive");
          attempt.book!.bundle(root, true);
          attempt.book!.seal(); attempt.selection = structuredClone(input);
          attempt.view.program = { name: root.name, version: root.version };
          this.append(attempt, "prepare.finish", { selection: input as unknown as Json,
            completion: { kind: "prepared_source_sealed", inference: "stop_before_next_request" } });
          return { kind: "prepared_source_sealed", program: attempt.view.program,
            qualification: "inactive_source_only_pending_clean_compile" };
        }),
    ];
    return tools;
  }
  private help(input: z.infer<typeof helpSchema>, contract: PreparationContract, tools: AgentTool[]): Json {
    const schemas = Object.fromEntries(tools.map(tool => [tool.name, tool.parameters]));
    const topics = ["overview", "programs", "controller", "actions", "game"];
    const authority = "Source-only preparation. No world observation or playing authority. Only these advertised tools are callable; game/action references describe authored children after actual launch.";
    if (input.topic === "overview") return { authority, tools: tools.map(tool => tool.name), topics, schemas } as Json;
    if (!topics.includes(input.topic)) return { available: false, topic: input.topic, topics, authority };
    const reference = programHelp(input.topic, contract.adapter, input.kind) as Record<string, unknown>;
    const softwareTests = "Use program_analyze with an exact analyze wrapper importing your pinned step candidate. validate_as checks only its returned activation/decision shape, not an aggregate case report. Validated source throws expose bounded source_diagnostic marked advisory/untrusted; its source_hash identifies the compiled pinned realm, not merely the root body. Use your assertion/error text to correct source or synthetic fixtures, never as a host fact or native authority. Synthetic inputs and passing shape validation are not gameplay or live admission evidence.";
    if (input.topic === "controller" && "launch" in reference)
      return { ...reference, authority, launch: { tool: "prepare_finish", schema: schemas.prepare_finish },
        operations: "Save inactive source with program_write; select the exact root and finite initial state/intent/session with prepare_finish. The clean playing worker activates only after genuine launch on the first actual frame.",
        software_tests: softwareTests } as unknown as Json;
    if (input.topic === "programs" && "resident" in reference) {
      const { operations: _operations, software_tests: _tests, ...resident } = reference.resident as Record<string, unknown>;
      return { authority, schemas, body: reference.body, identifiers: reference.identifiers,
        coverage: reference.coverage, hearing: reference.hearing, compass_bearings: reference.compass_bearings,
        composition: reference.composition, resident,
        software_tests: softwareTests, world_view: reference.world_view, temporal_turn: reference.temporal_turn,
        temporal_tracking: reference.temporal_tracking, target_transitions: reference.target_transitions,
        result: reference.result, execution_limits: reference.execution_limits,
        limits: reference.limits, default_execution_limits: reference.default_execution_limits,
        default_resident_limits: reference.default_resident_limits } as unknown as Json;
    }
    return { authority, ...reference } as unknown as Json;
  }
  private prompt(): string {
    return "You author source before any game world/client/avatar is entered. Follow the user's exact task and goal using the selected model. " +
      "There is no initial observation, player/native identity or world state. Do not invent them or claim gameplay success. " +
      "This is a fresh source-only codebook; no prior session or cross-model experience is hydrated. Only the advertised tools are authorized. " +
      "program_write saves inactive canonical immutable source and defaults to entry step. Author the root with entry:'step', exporting step(frame,state,intent) and activate(frame,state,intent); do not put these exports in entry:'run'. " +
      "Semantic children require explicit entry:'run' and an async BODY only: no function wrapper, imports or exports. Use explicit entry:'library' for ordinary libraries/reexports and a separate entry:'analyze' module exporting analyze(input) for software tests. Use named versions and CAS based_on for revisions. " +
      "program_analyze runs bounded pure software tests on your explicitly synthetic input, never actual observations or gameplay qualification. Optional validate_as checks only output return shape; a refusal has valid activation shape but is not accepted live activation. " +
      "Produce complete source for a finite real-world development trial, not proof of gameplay before a world exists. prepare_finish selects the exact candidate for host validation and that trial; it does not certify efficacy, complete the gameplay goal or require an exhaustive synthetic test suite. " +
      "Software checks are optional and risk-driven. Correct known implementation/contract defects while retaining complete source and required behavior; a correctable entry/format error is not a reason to replace the implementation with a helper-only or neutral stub. The host does not infer entry, repair source or retry automatically. Do not seal a stub or knowingly missing required behavior. If the complete implementation is internally consistent, select it within the original budget rather than ending with an unfinished test-plan report merely because every scenario is not yet exercised. " +
      "Useful test priorities include changed pending-child transitions and terminal success/failure/unknown bookkeeping. Partial-row loss/return is another risk: local absence is not global absence; retained evidence needs original scope/time separate from live authority. " +
      "You choose the synthetic inputs, assertions, memory representation and behavior; no host test supplies a route, target or response. " +
      "Every diagnostic/attention event consumes the cumulative allowance, including repeated completion callbacks; check changed reporting latches when uncertain. " +
      "When analyzing, import the exact step candidate and call activate/step on your own labelled synthetic initial_state/args. Return the exact candidate result with validate_as, not a helper assertion or result bundle. Inspect compact source diagnostics and repair actual mismatches. This is software checking, not successful gameplay. " +
      "Keep explicit state bounded: a complete frame can exceed16KiB, and the host never truncates oversized next_state into validity. Test larger projections when that risk is uncertain. " +
      "View quality matters: repeated timed360-degree scans and full-error delta re-aims are not human-like control. Sound directions are world compass, not screen-relative; compare genuine heard bearings with actual applied yaw. " +
      "Choose purposeful bounded camera changes yourself, retaining your temporal turn/tracking state across moving-target, resource and pickup transitions. A removed block's position is not automatically the next gaze target. " +
      "Changed view transitions are useful software-check targets; passing JSON shape alone never establishes useful smooth motion. See controller help for motion.turn/track, which supply pure math, not target selection or tactics. " +
      "Inspect your authored sources and actual API/schema help as needed. There is no tool for observing, playing, respawning, network or filesystem access. " +
      "Author an executive step(frame,state,intent) and explicit activate(frame,state,intent), selecting the exact root yourself with prepare_finish(args,initial_state,limits,session). " +
      "The clean playing worker is never invoked during preparation; its first activation receives the real initial frame after launch. Disposable analyze workers may test imported functions on labelled synthetic data. " +
      "API lifecycle invariants: retain a pending child's stable key/handle while it owns work; issuing a new task identity may retire the previous child. " +
      "Distinguish starting/running/retiring from succeeded/failed/interrupted/unknown before transitions; unknown is not success. " +
      "Local applicability and semantic children must be finite and checked from actual supplied frames/results. Source chooses all gameplay behavior; the host supplies no tactic or default fighter. " +
      "The original finite deadline and tool/request/analysis/source history budgets do not renew. prepare_finish seals all tools and stops further inference before compile/launch. " +
      "No fake test, supplied target, source rewrite, automatic connected-session restart or hidden world pause is permitted.";
  }
}
