import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ToolRole } from "../shared/tool-policy.ts";
import type { Json, RunPauseCause } from "../shared/contracts.ts";
import type { AuthManager } from "./auth.ts";
import type { SelectedAccountInferenceSession } from "./auth-session.ts";
import type { Store, StoredRun } from "./store.ts";
import type { StrategicHost } from "./strategic.ts";
import { CognitionWire, COGNITION_LIMITS } from "./cognition-wire.ts";
import { CognitionAuthority } from "./cognition-authority.ts";
import { CognitionMetadataOwner } from "./cognition-metadata.ts";
import { decodeApiKeyResolveContext } from "./cognition-inference.ts";
import { cognitionRequestSchema, cognitionSdkFetchSchema, cognitionToolCallSchema, type CognitionSnapshot, type CognitionStart } from "./cognition-protocol.ts";
import { strategicContextAdapter } from "./strategic-context-protocol.ts";
import { authWorkerEnvironment } from "./auth-network.ts";
import { HOST_MONOTONIC_CLOCK_ID } from "./performance.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { cognitionJsonSchema } from "./cognition-json.ts";
import { CognitionContextCustody } from "./cognition-context-custody.ts";
import { MainDecisionWindow, retainedFiniteExecutive } from "./main-decision-window.ts";

const workerPath = fileURLToPath(new URL("./cognition-worker.ts", import.meta.url));
const failure = () => new RuntimeFault("backend_unavailable", "The ordinary cognition process could not complete; no model retry or embedded fallback was started");
const idSchema = z.string().min(1).max(512);
const deadlineSchema = z.string().regex(/^\d{1,24}$/);
interface OwnedChild {
  process: ChildProcess;
  wire: CognitionWire;
  closed: Promise<void>;
  stopping: boolean;
  opening: Promise<void> | null;
  scope: AbortController;
  keyWaits: Map<string, AbortController>;
  sdkFetchWaits: Map<string, AbortController>;
  closeWork: Promise<void> | null;
  closeTimer?: ReturnType<typeof setTimeout>;
  turnTimer?: ReturnType<typeof setTimeout>;
  contextTimer?: ReturnType<typeof setTimeout>;
  requestTimer?: ReturnType<typeof setTimeout>;
  contextId: string | null;
  contextDeadlineOsNs: bigint | null;
  metadata: CognitionMetadataOwner;
  run: StoredRun;
  generation: number;
  session: SelectedAccountInferenceSession;
  deadlineHandled: boolean;
  turnId: string | null;
  requestId: string | null;
  registeredRequests: Set<string>;
  childDrainClaims: Set<string>;
  governanceDrained: boolean;
}
export interface CognitionClientOptions {
  /** Generic process-ownership test seam; ordinary Runtime never overrides it. */
  spawn?: typeof spawn;
  workerPath?: string;
}
export interface CognitionClientSnapshot {
  pid: number | null;
  fenced: boolean;
  closing: boolean;
  turn_id: string | null;
  request_id: string | null;
  context_id: string | null;
  context_deadline_os_ns: string | null;
}

/** Owned ordinary planner PROCESS. RuntimeTools and all physical authority remain here. */
export class CognitionClient {
  readonly #authority: CognitionAuthority;
  readonly #contextCustody = new CognitionContextCustody();
  #child: OwnedChild | null = null;
  #session: SelectedAccountInferenceSession | null = null;
  #opening: Promise<void> | null = null;
  #closing: Promise<void> | null = null;
  #revision = 0;
  #fenced = true;
  #attentionTimer?: ReturnType<typeof setTimeout>;
  #wakeReasons = new Set<string>();
  #notifying: Promise<void> | null = null;
  #evidenceNotifying: Promise<void> | null = null;
  #evidenceDirty = false;
  readonly #mainDecisionWindow: MainDecisionWindow | null;
  constructor(private readonly store: Store, private readonly auth: Pick<AuthManager, "createInferenceSession">,
    private readonly host: StrategicHost, private readonly options: CognitionClientOptions = {}) {
    this.#authority = new CognitionAuthority(store, host);
    this.#mainDecisionWindow = host.mainDecisionWindow ? new MainDecisionWindow(host.mainDecisionWindow) : null;
  }
  /** Bounded ownership diagnostics only; never model context or credentials. */
  snapshot(): CognitionClientSnapshot {
    const child = this.#child;
    return { pid: child?.process.pid ?? null, fenced: this.#fenced,
      closing: this.#closing !== null || child?.stopping === true,
      turn_id: child?.turnId ?? null, request_id: child?.requestId ?? null,
      context_id: child?.contextId ?? null,
      context_deadline_os_ns: child?.contextDeadlineOsNs?.toString() ?? null };
  }
  reset(): void {
    if (this.#child || this.#session || this.#opening || this.#closing)
      throw new RuntimeFault("conflict", "Drain the previous cognition process before resetting a run");
    this.fence();
    this.#contextCustody.reset();
  }
  async start(generation: number): Promise<void> {
    const closed = this.close(), revision = this.#revision;
    await closed;
    if (revision !== this.#revision) throw new RuntimeFault("stale_context", "Cognition startup was superseded");
    const run = this.host.assertCurrent(generation);
    if (this.#mainDecisionWindow?.state(run.run_id).outcome === "decision_window_closed") {
      const retained = retainedFiniteExecutive(this.store, run, generation, this.host.programPending());
      run.model_status = retained ? "idle" : "error";
      this.host.persist();
      if (!retained) this.host.pause("The closed Main decision window has no valid finite executive", "deadline");
      return;
    }
    this.#authority.start(run, generation); this.#fenced = false;
    const session = this.auth.createInferenceSession({ modelId: run.model_id,
      consumer: {
        revoke: () => {
          // Startup's own rejected result belongs to its caller. It must not
          // also publish a playing-state pause before start() has returned.
          const active = !this.#opening && !this.#fenced && this.host.run() === run;
          this.#revoke();
          if (active) this.host.pause("The selected strategic inference session was revoked; resume only after authorization is ready", "provider_aborted");
        },
        drain: async () => {
          const child = this.#child;
          if (child) await this.#drainChild(child);
          await this.#opening?.catch(() => {});
        },
      },
    });
    this.#session = session;
    const opening = this.#startChild(run, generation, session);
    this.#opening = opening;
    try {
      await opening;
      if (this.#fenced || this.#session !== session || session.signal.aborted) throw failure();
    } catch {
      this.#revoke();
      await session.close();
      if (this.#child?.session === session) {
        this.#completeOwnership(this.#child);
        this.#child = null;
      }
      if (this.#session === session) this.#session = null;
      throw failure();
    } finally { if (this.#opening === opening) this.#opening = null; }
  }
  admitted(): void {
    // The host root has already changed synchronously; every old tool closure
    // reads that actual identity before commit even if this pipe is stalled.
    this.#notify("admitted");
  }
  attentionAfter(ms: number, reason: string): void {
    if (!Number.isInteger(ms) || ms < 1000 || ms > 600_000 || !reason.trim() || reason.length > 300)
      throw new RuntimeFault("invalid_request", "Attention requires a finite 1000–600000ms delay and a reason of at most 300 characters");
    const child = this.#current();
    clearTimeout(this.#attentionTimer);
    // Child retains the existing pending-decision/selection semantics; the
    // independent host timer also owns the corresponding ordinary wake grant.
    void child.wire.call("attention", { ms, reason }).catch(() => this.#failed(child));
    this.#attentionTimer = setTimeout(() => {
      this.#attentionTimer = undefined;
      if (!this.#fenced && this.#child === child) this.#authority.wake("selected_attention");
    }, ms);
  }
  wake(reason: string): void {
    if (this.#fenced || !this.#child) return;
    this.#authority.wake(reason);
    if (this.#wakeReasons.size >= 32 && !this.#wakeReasons.has(reason)) { this.#failed(this.#child); return; }
    this.#wakeReasons.add(reason.slice(0, 160));
    this.#notify("wake");
  }
  toolRole(): ToolRole { return this.#authority.toolRole(); }
  speculativeToolAuthority(): () => void { return this.#authority.toolAuthority(); }
  evidenceChanged(): void {
    this.#evidenceDirty = true;
    const child = this.#child;
    if (!child || this.#fenced || child.stopping || this.#evidenceNotifying) return;
    const work = (async () => {
      while (this.#evidenceDirty && !this.#fenced && this.#child === child) {
        this.#evidenceDirty = false;
        const observed = !!(this.host.cognitionEvidence?.enabled() || this.host.requestAdmission?.evidence);
        await child.wire.call("evidence", { sdk: observed, dispatch: observed || !!this.host.requestAdmission?.beforeDispatch });
      }
    })();
    this.#evidenceNotifying = work;
    void work.catch(() => this.#failed(child)).finally(() => {
      if (this.#evidenceNotifying === work) this.#evidenceNotifying = null;
    }).catch(() => {});
  }
  fence(): void {
    this.#revoke();
    this.#session?.cancel();
  }
  #revoke(): void {
    this.#revision++; this.#fenced = true; this.#authority.fence();
    clearTimeout(this.#attentionTimer); this.#attentionTimer = undefined;
    this.#wakeReasons.clear();
    const child = this.#child;
    if (!child) return;
    child.scope.abort();
    for (const wait of child.keyWaits.values()) wait.abort();
    for (const wait of child.sdkFetchWaits.values()) wait.abort();
    void child.wire.call("fence", null).catch(() => {});
  }
  close(): Promise<void> {
    this.fence();
    if (this.#closing) return this.#closing;
    const session = this.#session, child = this.#child;
    const closure = (async () => {
      // Session close joins its real consumer (late startup/process/pipes) AND
      // leased credential refresh. Killing the child alone is not auth drain.
      if (session) await session.close();
      else if (child) await this.#drainChild(child);
      await this.#opening?.catch(() => {});
      if (child) this.#completeOwnership(child);
      if (this.#child === child) this.#child = null;
      if (this.#session === session) this.#session = null;
    })();
    this.#closing = closure;
    void closure.finally(() => { if (this.#closing === closure) this.#closing = null; }).catch(() => {});
    return closure;
  }
  #snapshot(child: Pick<OwnedChild, "run" | "generation">): CognitionSnapshot {
    const run = this.host.assertCurrent(child.generation);
    if (run !== child.run) throw failure();
    const adapter = strategicContextAdapter(this.host.adapter?.());
    if (!adapter) throw failure();
    const modules = this.host.disclosedModules?.();
    if (!modules || modules.length > 2) throw failure();
    const livePolicies = this.host.policies();
    if (livePolicies.length > 1024) throw failure();
    const policies = livePolicies.filter(policy => policy.state === "trial" || policy.state === "active")
      .map(({ version, backend, name, state, priority, effects, last_error }) =>
        ({ version, backend, name: name.slice(0, 160), state, priority, effects, last_error: last_error?.slice(0, 300) ?? null }));
    return { run, generation: child.generation, adapter, modules, policies, action: this.host.action(),
      programPending: this.host.programPending(), busy: this.host.busy(),
      planning: this.host.speculation?.().projection() ?? null,
      planning_remaining_ms: this.host.speculation?.().remainingMs() ?? 0 };
  }
  async #startChild(run: StoredRun, generation: number, session: SelectedAccountInferenceSession): Promise<void> {
    const spawnChild = this.options.spawn ?? spawn;
    const childProcess = spawnChild(process.execPath, ["--no-env-file", this.options.workerPath ?? workerPath], {
      cwd: path.dirname(workerPath), env: authWorkerEnvironment(process.env), stdio: ["pipe", "pipe", "ignore"],
    });
    const completion = Promise.withResolvers<void>();
    const child: OwnedChild = { process: childProcess, wire: null!, closed: completion.promise,
      stopping: false, opening: null, scope: new AbortController(), keyWaits: new Map(), sdkFetchWaits: new Map(), closeWork: null,
      contextId: null, contextDeadlineOsNs: null, turnId: null, requestId: null, run, generation, session, deadlineHandled: false,
      registeredRequests: new Set(), childDrainClaims: new Set(), governanceDrained: false,
      metadata: new CognitionMetadataOwner(this.store, run, {
        persist: summary => {
          // Save the exact retained host object; child lifecycle/usage clones
          // are never accepted as canonical replacements.
          if (this.host.run() === run) this.host.persist(summary); else this.store.saveRun(run);
        },
        current: () => !this.#fenced && this.host.run() === run && this.host.generation() === generation,
        response: response => {
          this.#authority.response(response);
          // A response is not SDK/metadata settlement. Authoring's watchdog
          // remains until the next admitted request or the serialized turn end.
        },
        speculation: this.host.speculation?.(), requestAdmission: {
          reserve: (id, model) => {
            const reserve = () => this.host.requestAdmission?.reserve(id, model);
            if (this.#mainDecisionWindow) this.#mainDecisionWindow.reserve(run.run_id, id, reserve);
            else reserve();
            child.registeredRequests.add(id);
          },
          transportEnded: (id, natural) => this.host.requestAdmission?.transportEnded(id, natural),
          drained: ids => { for (const id of ids) child.childDrainClaims.add(id); },
          evidence: event => {
            this.host.requestAdmission?.evidence?.(event);
            this.host.cognitionEvidence?.emit(event);
          },
        },
      }),
    };
    if (!childProcess.stdout || !childProcess.stdin) throw failure();
    child.wire = new CognitionWire(childProcess.stdout, childProcess.stdin,
      async (method, body) => {
        try { return await this.#handle(child, method, body); }
        catch (error) {
          // Fixed protocol stages/codes only: upstream errors and key-resolution
          // payloads can contain secrets and never belong in ordinary metadata.
          const reason = error instanceof z.ZodError ? "invalid_protocol"
            : error instanceof RuntimeFault ? error.code
              : error instanceof Error && error.message === "Invalid cognition metadata" ? "invalid_metadata"
                : "host_operation_failed";
          const validation = error instanceof z.ZodError ? error
            : error instanceof Error && error.cause instanceof z.ZodError ? error.cause : null;
          this.store.event(child.run.run_id, "cognition.rpc_rejected",
            "Owned cognition request was rejected; no error body or credentials retained", {
              method, reason, ...(validation
                ? { issue_codes: [...new Set(validation.issues.map(issue => issue.code))].slice(0, 8) } : {}),
            });
          throw error;
        }
      }, () => this.#failed(child));
    this.#child = child;
    // kill() before spawn has no pid to signal. Cancellation still owns a
    // child whose allocation becomes observable only after its watchdog ran.
    childProcess.once("spawn", () => {
      if (child.stopping || this.#fenced || session.signal.aborted)
        try { childProcess.kill("SIGKILL"); } catch { /* join actual close */ }
    });
    childProcess.once("error", () => this.#failed(child));
    childProcess.once("exit", () => { if (!child.stopping) this.#failed(child); });
    childProcess.once("close", () => {
      clearTimeout(child.closeTimer); clearTimeout(child.turnTimer); clearTimeout(child.contextTimer); clearTimeout(child.requestTimer);
      child.scope.abort(); child.wire.fail();
      const priorCustody = this.#contextCustody.status().uncommitted_custody;
      this.#contextCustody.release(child);
      if (priorCustody === "none" && this.#contextCustody.status().uncommitted_custody === "unknown")
        this.store.event(child.run.run_id, "cognition.context_custody_unknown",
          "Last host-committed passive context retained; uncommitted process knowledge custody is unknown", {
            uncommitted_custody: "unknown", last_host_commit_retained: true, restored_effect_authority: false,
          });
      completion.resolve();
    });
    const timer = setTimeout(() => this.#failed(child), COGNITION_LIMITS.startupMs);
    const goal = this.host.promptInput?.();
    if (!goal) { this.#failed(child); throw failure(); }
    const input: CognitionStart = { location: this.store.readLocation(), snapshot: this.#snapshot(child), goal,
      retained_context: this.#contextCustody.acquire(child, run.run_id),
      grant: { sessionId: session.sessionId, model: session.model, thinkingLevel: session.thinkingLevel,
        singleInferenceDispatch: session.singleInferenceDispatch },
      timing: { clock_id: HOST_MONOTONIC_CLOCK_ID, os_origin_ns: osMonotonicNs().toString(), host_origin_ms: performance.now() },
      observeSdk: !!(this.host.requestAdmission?.evidence || this.host.cognitionEvidence?.enabled()),
      observeDispatch: !!(this.host.requestAdmission?.evidence || this.host.requestAdmission?.beforeDispatch || this.host.cognitionEvidence?.enabled()),
      admitSdkFetch: !!this.host.requestAdmission?.beforeSdkFetch,
      ...(this.host.playingAuthorityCeilings ? { playingAuthorityCeilings: this.host.playingAuthorityCeilings } : {}),
      ...(this.#mainDecisionWindow ? { mainDecisionWindow: { maxRequests: this.#mainDecisionWindow.maxRequests } } : {}) };
    this.store.event(run.run_id, "cognition.started",
      "Ordinary planner and SDK are owned by an independent process; physical authority remains local", {
        worker_pid: childProcess.pid ?? null, host_clock_id: input.timing.clock_id,
        os_monotonic_ns: input.timing.os_origin_ns, host_monotonic_ms: input.timing.host_origin_ms,
        timing_source: "linux_clock_monotonic_mapped_to_host",
        correspondence: "sequential_host_clock_samples_not_child_performance_epoch",
        automatic_restart: false, embedded_fallback: false,
      });
    const opening = child.wire.call<{ pid: number }>("start", input).then(result => {
      if (result.pid !== childProcess.pid || childProcess.pid === process.pid || this.#fenced || session.signal.aborted) throw failure();
      if (this.#evidenceDirty) this.evidenceChanged();
    });
    child.opening = opening;
    try { await opening; } finally { clearTimeout(timer); child.opening = null; }
  }
  #current(): OwnedChild {
    const child = this.#child;
    if (!child || child.stopping || this.#fenced || child.session.signal.aborted || this.host.run() !== child.run)
      throw new RuntimeFault("stale_context", "Cognition process authority is fenced");
    this.host.assertCurrent(child.generation);
    return child;
  }
  #notify(kind: "wake" | "admitted"): void {
    const child = this.#child;
    if (!child || this.#fenced || child.stopping) return;
    if (kind === "admitted") this.#wakeReasons.add("__admitted");
    if (this.#notifying) return;
    const work = (async () => {
      while (this.#wakeReasons.size && !this.#fenced && this.#child === child) {
        const reason = this.#wakeReasons.values().next().value!;
        this.#wakeReasons.delete(reason);
        const snapshot = this.#snapshot(child);
        await child.wire.call(reason === "__admitted" ? "admitted" : "wake",
          reason === "__admitted" ? snapshot : { reason, snapshot });
      }
    })();
    this.#notifying = work;
    void work.catch(() => this.#failed(child)).finally(() => { if (this.#notifying === work) this.#notifying = null; }).catch(() => {});
  }
  #failed(child: OwnedChild): void {
    if (child.stopping) return;
    const active = !this.#fenced && this.#child === child && this.host.run() === child.run;
    this.#revoke(); child.stopping = true;
    try { child.process.kill("SIGKILL"); } catch { /* close is the only process/pipe receipt. */ }
    // The dead cognition owner must release real auth/refresh custody.
    void this.close().catch(() => {});
    if (active && !child.deadlineHandled)
      this.host.pause("The strategic model request could not complete. Check authorization and provider availability, then resume the paused run.", "provider_failure");
  }
  #contained(child: OwnedChild, reason: "turn_deadline" | "context_deadline" | "authoring_deadline"): void {
    if (this.#child !== child || child.stopping || this.#fenced) return;
    child.deadlineHandled = true;
    child.run.model_status = "error";
    this.store.event(child.run.run_id, "cognition.contained",
      "Cognition did not settle cancellation; the owned process is being closed and explicit recovery is required", {
        reason, turn_id: child.turnId, request_id: child.requestId, context_id: child.contextId,
        cancellation_only_ms: COGNITION_LIMITS.cancellationDrainMs, process_stall: true,
        available: false, automatic_restart: false, automatic_retry: false, embedded_fallback: false,
        closure_confirmed: false,
      });
    this.#failed(child);
    this.host.pause("Cognition did not settle its finite cancellation window. The run is safely paused; inspect retained evidence and explicitly resume after recovery.",
      reason === "context_deadline" ? "preparation_failed" : "deadline");
  }
  #drainChild(child: OwnedChild): Promise<void> {
    if (child.closeWork) return child.closeWork;
    child.stopping = true; child.scope.abort();
    for (const wait of child.keyWaits.values()) wait.abort();
    child.closeTimer = setTimeout(() => { try { child.process.kill("SIGKILL"); } catch { /* join close below */ } }, COGNITION_LIMITS.closeGraceMs);
    const request = child.wire.call("close", null).then(() => child.wire.end()).catch(() => {
      try { child.process.kill("SIGKILL"); } catch { /* join close below */ }
    });
    child.closeWork = (async () => {
      await child.closed;
      await request;
      await child.opening?.catch(() => {});
      await child.wire.drain();
      clearTimeout(child.closeTimer);
    })();
    return child.closeWork;
  }
  #completeOwnership(child: OwnedChild): void {
    if (child.governanceDrained) return;
    child.metadata.finalizeUnsettled();
    // A child's SDK-idle claim cannot release selected-account refresh custody.
    // This point is reached only after the host session's close actually joins.
    if (child.registeredRequests.size) this.host.requestAdmission?.drained([...child.registeredRequests]);
    child.governanceDrained = true;
  }
  async #handle(child: OwnedChild, method: string, body: unknown): Promise<unknown> {
    if (method === "context_custody") {
      // Journal/closed are passive settlement and remain accepted while
      // fencing/closing. Assembled only stages a candidate; it acknowledges
      // neither the checkpoint nor operations until successful context_end.
      if (this.#child !== child) throw failure();
      let allowCommit = false;
      try {
        allowCommit = this.#current() === child && child.contextDeadlineOsNs !== null &&
          osMonotonicNs() < child.contextDeadlineOsNs;
      } catch { /* Only passive journals/closure may settle a fenced child. */ }
      this.#contextCustody.accept(child, body, child.contextId, allowCommit);
      return null;
    }
    if (method === "metadata") { child.metadata.apply(body); return null; }
    if (method === "inference_release") { for (const wait of child.keyWaits.values()) wait.abort(); return null; }
    if (method === "key_cancel") {
      const input = z.object({ id: idSchema }).strict().parse(body); child.keyWaits.get(input.id)?.abort(); return null;
    }
    if (method === "sdk_fetch_cancel") {
      const input = z.object({ id: idSchema }).strict().parse(body); child.sdkFetchWaits.get(input.id)?.abort(); return null;
    }
    if (method === "context_end") {
      const input = z.object({ id: idSchema, successful: z.boolean() }).strict().parse(body);
      if (child.contextId !== input.id) throw failure();
      let allowCommit = false;
      if (input.successful) {
        try {
          allowCommit = this.#current() === child && child.contextDeadlineOsNs !== null &&
            osMonotonicNs() < child.contextDeadlineOsNs;
        } catch { /* An expired/revoked candidate never commits passive scope. */ }
      }
      this.#contextCustody.settle(child, input.id, input.successful, allowCommit);
      clearTimeout(child.contextTimer); child.contextId = null; child.contextDeadlineOsNs = null; return null;
    }
    if (method === "turn_end") {
      const input = z.object({ id: idSchema }).strict().parse(body);
      if (child.turnId === input.id) {
        clearTimeout(child.turnTimer); child.turnId = null; this.#authority.endTurn(input.id);
        clearTimeout(child.requestTimer); child.requestId = null;
        if (this.#mainDecisionWindow?.state(child.run.run_id).outcome === "decision_window_closed") {
          // Reply to this final turn barrier before closing the real process/auth owner.
          // This deferred close belongs only to this child/revision. A concurrent
          // explicit close/start already owns its drain; never fence that successor.
          const revision = this.#revision;
          setImmediate(() => {
            if (this.#child !== child || this.#revision !== revision || this.#fenced ||
              child.stopping || this.host.run() !== child.run || this.host.generation() !== child.generation) return;
            void this.close().catch(() => this.#failed(child));
          });
        }
      }
      return null;
    }
    if (this.#current() !== child) throw failure();
    if (method === "decision_window") {
      if (!this.#mainDecisionWindow || body !== null) throw failure();
      return this.#mainDecisionWindow.state(child.run.run_id);
    }
    if (method === "synchronize") return this.#snapshot(child);
    if (method === "sdk_fetch") {
      const input = cognitionSdkFetchSchema.parse(body);
      const hook = this.host.requestAdmission?.beforeSdkFetch;
      if (!hook || child.sdkFetchWaits.size >= 2 || child.sdkFetchWaits.has(input.id)) throw failure();
      const permit = this.#authority.sdkFetch(input.identity);
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, child.scope.signal, child.session.signal]);
      const deadlineOsNs = BigInt(input.identity.deadline_os_ns);
      const assert = () => {
        if (this.#current() !== child || signal.aborted || osMonotonicNs() >= deadlineOsNs ||
          input.model.id !== child.session.model.id || input.model.provider !== child.session.model.provider ||
          input.model.api !== child.session.model.api || !child.metadata.requestAdmitted(input.identity.request_id))
          throw failure();
        permit();
      };
      assert();
      child.sdkFetchWaits.set(input.id, controller);
      const timer = setTimeout(() => controller.abort(), Math.max(1, Number(deadlineOsNs - osMonotonicNs()) / 1e6));
      try {
        await hook.call(this.host.requestAdmission,
          { identity: { ...input.identity }, model: { ...input.model } }, { signal, deadlineOsNs });
        assert();
        return null;
      } finally { clearTimeout(timer); child.sdkFetchWaits.delete(input.id); }
    }
    if (method === "key") {
      const input = z.object({ id: idSchema, model: z.unknown(), context: z.unknown() }).strict().parse(body);
      if (child.keyWaits.size >= 2 || child.keyWaits.has(input.id)) throw failure();
      const controller = new AbortController(); child.keyWaits.set(input.id, controller);
      try {
        const context = decodeApiKeyResolveContext(input.context, AbortSignal.any([controller.signal, child.scope.signal]));
        return await child.session.getApiKey(input.model as Model)(context);
      } finally { child.keyWaits.delete(input.id); }
    }
    if (method === "turn") {
      const input = z.object({ id: idSchema, deadline_os_ns: deadlineSchema }).strict().parse(body);
      if (child.turnId) throw failure();
      const deadline = this.#authority.beginTurn(input.id, BigInt(input.deadline_os_ns));
      child.metadata.beginTurn();
      child.turnId = input.id;
      clearTimeout(child.turnTimer);
      child.turnTimer = setTimeout(() => this.#deadline(child, input.id, deadline), Math.max(1, Number(deadline - osMonotonicNs()) / 1e6));
      return null;
    }
    if (method === "dispatch") {
      const input = z.object({ identity: cognitionRequestSchema, model: z.unknown().optional(),
        context: cognitionJsonSchema.optional() }).strict().parse(body);
      if (!child.metadata.requestAdmitted(input.identity.request_id)) throw failure();
      const deadline = this.#authority.grant(input.identity);
      child.requestId = input.identity.request_id;
      clearTimeout(child.requestTimer);
      if (input.identity.role === "authoring") {
        // Exact admission already expires at deadline; allow only cancellation
        // drain grace before force-closing a cognition owner that cannot yield.
        child.requestTimer = setTimeout(() => {
          if (child.requestId !== input.identity.request_id || child.stopping || this.#fenced) return;
          this.#contained(child, "authoring_deadline");
        }, Math.max(1, Number(deadline - osMonotonicNs()) / 1e6) + COGNITION_LIMITS.cancellationDrainMs);
      }
      if (this.host.requestAdmission?.beforeDispatch && (!input.model || !input.context)) throw failure();
      if (input.model && input.context) {
        const context = input.context as unknown as Context, model = input.model as Model;
        const evidence = { run_id: child.run.run_id,
          kind: "final_sdk_visible_context_not_wire_payload" as const, body: input.context as Json };
        this.host.requestAdmission?.evidence?.(evidence);
        this.host.cognitionEvidence?.emit(evidence);
        await this.host.requestAdmission?.beforeDispatch?.({ identity: input.identity, model, context },
          { signal: child.scope.signal, deadlineOsNs: BigInt(input.identity.deadline_os_ns) });
      }
      this.#authority.assertRequest(input.identity.request_id);
      return null;
    }
    if (method === "context_begin") {
      const input = z.object({ id: idSchema, deadline_os_ns: deadlineSchema }).strict().parse(body);
      const deadline = BigInt(input.deadline_os_ns), now = osMonotonicNs();
      if (child.contextId || deadline <= now || deadline > now + 5_000_000_000n) throw failure();
      child.contextId = input.id;
      child.contextDeadlineOsNs = deadline;
      // The reducer's original deadline still rejects late results. This timer
      // only joins cooperative unwinding before containing a truly stuck owner.
      child.contextTimer = setTimeout(() => {
        if (child.contextId === input.id) this.#contained(child, "context_deadline");
      }, Math.max(1, Number(deadline - now) / 1e6) + COGNITION_LIMITS.cancellationDrainMs);
      return null;
    }
    if (method === "tool") {
      const call = cognitionToolCallSchema.parse(body);
      const permit = this.#authority.tool(call.request_id, call.call_id, call.name, call.arguments);
      try {
        const tool = this.host.tools(child.generation).find(tool => tool.name === call.name);
        if (!tool) throw failure();
        permit.assert();
        // Actual RuntimeTools validates ORIGINAL own properties. No SDK healing
        // and no deserialized native RuntimeFault can enter physical authority.
        return await tool.execute(call.call_id, call.arguments, child.scope.signal);
      } finally { permit.release(); }
    }
    if (method === "observe") return await this.host.observe();
    if (method === "model_observation") {
      const run = child.run, generation = this.host.generation(), phase = run.status;
      const root = this.store.latestRootExecution(run.run_id)?.execution_id ?? null;
      const scope = [run.world_id, run.session_id, run.epoch, run.life_id, run.native_boot_id,
        run.space_epoch, run.compatibility_hash];
      try {
        return this.host.modelObservation ? await this.host.modelObservation() :
          { observation: await this.host.observe(), images: [], image_metadata: { mode: "disabled" } };
      } catch (error) {
        // Root replacement is not part of Runtime's native image scope. Record
        // discriminating host facts without guessing which native guard failed,
        // transferring an exception brand, retrying capture or publishing data.
        const currentScope = [run.world_id, run.session_id, run.epoch, run.life_id, run.native_boot_id,
          run.space_epoch, run.compatibility_hash];
        const reason = error instanceof RuntimeFault
          ? error.code === "stale_context" ? "stale_context"
            : error.code === "stale_epoch" ? "stale_epoch"
              : error.code === "backend_unavailable" ? "backend_unavailable"
                : error.code === "precondition_failed" ? "precondition_failed" : "other_runtime_fault"
          : "host_operation_failed";
        this.store.event(run.run_id, "cognition.model_observation_rejected",
          "Model observation failed at the host capture boundary; native guard identity is not inferred", {
            reason, turn_id: child.turnId, request_id: child.requestId,
            run_replaced: this.host.run() !== run,
            generation_changed: this.host.generation() !== generation,
            phase_changed: run.status !== phase,
            run_scope_changed: scope.some((value, index) => value !== currentScope[index]),
            root_changed: (this.store.latestRootExecution(run.run_id)?.execution_id ?? null) !== root,
            native_guard: "not_reported", provider_request_made: false, capture_retried: false,
          });
        throw error;
      }
    }
    if (method === "planning_pending" || method === "planning_begin") {
      const planning = this.host.speculation?.();
      if (!planning) throw failure();
      const view = method === "planning_pending" ? await planning.pendingActivation() : await planning.begin();
      return { view, snapshot: this.#snapshot(child) };
    }
    if (method === "planning_call") return await this.host.speculation?.().requestCall() ?? false;
    if (method === "review_context") {
      const input = z.object({ deadline_os_ns: deadlineSchema }).strict().parse(body);
      const remaining = Number(BigInt(input.deadline_os_ns) - osMonotonicNs()) / 1e6;
      if (remaining <= 0 || remaining > 30_000 || !this.host.reviewContext) throw failure();
      return await this.host.reviewContext({ signal: child.scope.signal, deadlineHostMs: performance.now() + remaining });
    }
    if (method === "pause") {
      const input = z.object({ message: z.string().max(8192), cause: z.string().max(128) }).strict().parse(body);
      const causes: Record<string, true> = { safety: true, preparation_failed: true, observation_unavailable: true,
        deadline: true, provider_aborted: true, provider_failure: true };
      if (!Object.hasOwn(causes, input.cause)) throw failure();
      this.host.pause(input.message, input.cause as RunPauseCause); return null;
    }
    if (method === "terminal") {
      const input = z.object({ status: z.enum(["completed", "failed"]), message: z.string().max(8192) }).strict().parse(body);
      this.host.terminal(input.status, input.message); return null;
    }
    if (method === "review_complete") { this.host.reviewComplete?.(); return null; }
    throw failure();
  }
  #deadline(child: OwnedChild, id: string, deadline: bigint): void {
    if (this.#child !== child || child.turnId !== id || child.stopping || this.#fenced) return;
    const remaining = Number(deadline - osMonotonicNs()) / 1e6;
    if (remaining > 0) {
      child.turnTimer = setTimeout(() => this.#deadline(child, id, deadline), Math.max(1, remaining));
      return;
    }
    // No effect/request/tool authority survives the ORIGINAL deadline. The
    // additional window is only for SDK cancellation, metadata and turn_end.
    this.#authority.endTurn(id);
    child.turnTimer = setTimeout(() => {
      if (child.turnId === id) this.#contained(child, "turn_deadline");
    }, COGNITION_LIMITS.cancellationDrainMs);
    void child.wire.call("turn_cancel", { id }).catch(() => this.#failed(child));
    // StrategicPlanner alone classifies its settled provider/root state and
    // emits turn_deferred. A killed planner is never advertised as idle.
  }
}
