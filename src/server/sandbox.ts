import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { types } from "node:util";
import type {
  Json,
  ObservationV3,
  PolicyContext,
  PolicyDecision,
  PolicySpec,
  SandboxState,
} from "../shared/contracts.ts";
import {
  gameActionSchema,
  policyDecisionSchema,
  policySpecSchema,
  namedProgramRefSchema,
  skillCapabilitySchema,
} from "../shared/validation.ts";
import { MAX_SKILL_LIMITS } from "../shared/programs.ts";
import type {
  SkillCapabilityRequest,
  SkillLimits,
  SkillResult,
} from "../shared/programs.ts";
import type {
  ProgramBranchTrace,
  ProgramInstrumentation,
  ProgramTraceLossReason,
} from "../shared/program-trace.ts";
import {
  instrumentProgram,
  ProgramTraceReceiver,
  type InstrumentedProgram,
} from "./program-instrumentation.ts";
import { validateProgramSource, type ExecutableValidationContext } from "./program-validation.ts";
import type { SkillAPIManifest } from "../shared/programs.ts";
import { capabilityFailure, GeneratedResultValidationError, parseGeneratedSkillResult, ProgramExecutionError, readProgramDiagnostic } from "./program-diagnostics.ts";
import { controllerStepResultSchema, residentIntentSchema, residentStateSchema,
  type ControllerStepResult, type ResidentWorker, type ResidentAnalysisWorker, 
  ResidentCleanupError, RESIDENT_STEP_RESPONSE_MS} from "../shared/resident.ts";
import type { MinecraftControllerFrame } from "../shared/minecraft.ts";

export interface SkillSandboxHooks {
  api?: SkillAPIManifest;
  onTiming?(event: {
    phase: "worker_start" | "worker_cleanup";
    started_monotonic_ms: number;
    ended_monotonic_ms: number;
    confirmed: boolean;
  }): void;
  onInstrumentation?(instrumentation: ProgramInstrumentation): void;
  onTrace?(trace: ProgramBranchTrace): void;
  onCapabilityRequest?(event: {
    sequence: number;
    request: SkillCapabilityRequest;
  }): void;
  /** Values originate in the authorized host broker, never container assertions. */
  onCapabilityResult?(event: {
    sequence: number;
    request: SkillCapabilityRequest;
    ok: boolean;
    value: Json;
    duration_ms: number;
  }): void;
}

export interface PolicyWorker {
  evaluate(
    context: PolicyContext,
    signal?: AbortSignal,
  ): Promise<PolicyDecision>;
  close(): Promise<void>;
}

export class SkillCleanupError extends Error {
  constructor() {
    super("Docker could not confirm skill container cleanup.");
    this.name = "SkillCleanupError";
  }
}

const IMAGE =
  "node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";
const DOCKER = "/usr/bin/docker";
const ENV = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  HOME: "/nonexistent",
  DOCKER_CONFIG: "/nonexistent/.docker",
};
const INPUT_BYTES = 256 * 1024;
const OUTPUT_BYTES = 64 * 1024;
const SKILL_INPUT_BYTES = INPUT_BYTES + 512 * 1024;
const SKILL_OUTPUT_BYTES = OUTPUT_BYTES + 20 * 1024;
const STATE_BYTES = 16 * 1024;
const MAX_DEPTH = 32;
const MAX_WORKERS = 8;
const STARTUP_MS = 15_000;
const EVALUATION_MS = 500;

// Check depth before JSON.parse: even a tiny hostile JSON document may be deeply nested.
function checkJsonDepth(text: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > MAX_DEPTH)
        throw new Error("Sandbox JSON nesting exceeds its limit.");
    } else if (character === "}" || character === "]") depth--;
  }
}

function encode(value: unknown, maxBytes: number): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error("Sandbox input must be bounded JSON.");
  }
  if (text === undefined || Buffer.byteLength(text, "utf8") + 1 > maxBytes)
    throw new Error("Sandbox JSON exceeds its size limit.");
  checkJsonDepth(text);
  return text;
}

// Host callers normally supply validated data. Reject accessors/proxies before
// any stringify/schema traversal nevertheless; authored hooks must never run here.
function assertResidentInput(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    if (++visited > INPUT_BYTES) throw new Error("Resident input exceeds its JSON bound.");
    const item = pending.pop()!;
    const current = item.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      if (Buffer.byteLength(current) > INPUT_BYTES) throw new Error("Resident input exceeds its JSON bound.");
      continue;
    }
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (!current || typeof current !== "object" || types.isProxy(current) || item.depth >= MAX_DEPTH)
      throw new Error("Resident input requires bounded plain JSON data.");
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array))
      throw new Error("Resident input requires plain JSON data.");
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Reflect.ownKeys(descriptors);
    const length = array ? descriptors.length?.value : keys.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > INPUT_BYTES ||
      (array && keys.length !== length + 1))
      throw new Error("Resident input exceeds its JSON bound.");
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key as string]!;
      if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
        (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))
        throw new Error("Resident input cannot contain JSON hooks or hidden fields.");
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Trusted Docker control commands never receive generated source or inherited credentials.
async function docker(
  args: string[],
  timeoutMs = STARTUP_MS,
): Promise<CommandResult> {
  const {
    promise,
    resolve: resolveResult,
    reject,
  } = Promise.withResolvers<CommandResult>();
  const child = spawn(DOCKER, args, {
    env: ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let failure: Error | null = null;
  const timer = setTimeout(() => {
    failure = new Error("Docker sandbox control timed out.");
    child.kill("SIGKILL");
  }, timeoutMs);
  const collect = (chunk: Buffer, errorStream: boolean) => {
    bytes += chunk.length;
    if (bytes > OUTPUT_BYTES) {
      failure = new Error("Docker sandbox control exceeded its output limit.");
      child.kill("SIGKILL");
    } else if (errorStream) stderr += chunk.toString("utf8");
    else stdout += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, false));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, true));
  child.on("error", () => {
    failure = new Error(
      "Docker is unavailable. Install Docker and start its daemon.",
    );
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (failure) reject(failure);
    else resolveResult({ code, stdout, stderr });
  });
  return await promise;
}

type Reply = Record<string, unknown>;
interface Pending {
  type: string;
  id?: number;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class DockerPolicyWorker implements PolicyWorker, ResidentWorker, ResidentAnalysisWorker {
  readonly name: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private childExited: Promise<void> = Promise.resolve();
  private childExitCode: number | null = null;
  private closing = false;
  private cleanup: Promise<void> | null = null;
  private pending: Pending | null = null;
  private stdout: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private evaluating = false;
  private state: Record<string, Json> = {};
  private residentEntry: "step" | "analyze" | null = null;
  private residentBudget = 0;
  private sequence = 0;
  private releaseSignal: (() => void) | null = null;
  private analysisEvaluation: { id: number; started: number; reported: boolean; callback?: (elapsedMs: number) => void } | null = null;

  constructor(
    private runner: string,
    private guardian: string,
    owner: string,
    private onClosed: (worker: DockerPolicyWorker) => void,
  ) {
    this.name = `gameharness-policy-${owner}-${randomUUID()}`;
  }

  async start(source?: string, binding: "policy" | "guard" | "step" | "analyze" = "policy",
    budget = 0, signal?: AbortSignal): Promise<void> {
    try {
      if (this.closing) throw new Error("Sandbox worker is closed.");
      this.residentEntry = binding === "step" || binding === "analyze" ? binding : null;
      this.residentBudget = budget;
      if (signal?.aborted) throw new Error("Resident worker was cancelled.");
      const abort = () => this.fail(new Error("Resident worker was cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      this.releaseSignal = () => signal?.removeEventListener("abort", abort);
      const ready = this.waitFor(this.residentEntry ? "resident_ready" : "ready",
        STARTUP_MS, this.residentEntry ? 0 : undefined);
      // The detached host guardian owns Docker from before creation until rm
      // confirms termination. No policy-accessible process owns this EOF pipe.
      const child = spawn(
        process.execPath,
        ["--no-env-file", this.guardian, this.name, this.runner, IMAGE,
          ...(this.residentEntry ? ["resident", String(budget)] : [])],
        {
          env: ENV,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        },
      );
      this.child = child;
      const exited = Promise.withResolvers<void>();
      this.childExited = exited.promise;
      child.once("close", (code) => {
        this.childExitCode = code;
        exited.resolve();
      });
      child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        this.stderrBytes += chunk.length;
        this.stdoutBytes += chunk.length;
        if (this.stderrBytes > OUTPUT_BYTES || this.stdoutBytes > OUTPUT_BYTES)
          this.fail(new Error("Sandbox worker exceeded its output limit."));
      });
      child.stdin.on("error", () =>
        this.fail(new Error("Sandbox worker input closed unexpectedly.")),
      );
      child.on("error", () =>
        this.fail(new Error("Docker sandbox could not be started.")),
      );
      child.on("close", () => {
        if (!this.closing)
          this.fail(new Error("Sandbox worker exited unexpectedly."));
      });
      await ready;
      if (source !== undefined) {
        if (this.residentEntry)
          await this.request("resident_compiled", { v: 1, type: "resident_init", id: 0,
            source, entry: this.residentEntry }, STARTUP_MS, 0);
        else await this.request("compiled", { type: "init", source, binding }, STARTUP_MS);
      }
      if (this.closing || signal?.aborted) throw new Error("Sandbox worker was cancelled during startup.");
    } catch (error) {
      await this.terminate(
        error instanceof Error
          ? error
          : new Error("Sandbox worker could not start."),
      );
      throw error;
    }
  }

  async proveProfile(): Promise<void> {
    const inspected = await docker([
      "inspect",
      "--type",
      "container",
      this.name,
    ]);
    if (inspected.code !== 0)
      throw new Error("Docker sandbox profile could not be inspected.");
    let value: unknown;
    try {
      checkJsonDepth(inspected.stdout);
      value = JSON.parse(inspected.stdout);
    } catch {
      throw new Error("Docker sandbox profile proof was invalid.");
    }
    if (!Array.isArray(value) || value.length !== 1)
      throw new Error("Docker sandbox profile proof was invalid.");
    const entry = value[0];
    const config = entry?.HostConfig;
    const mounts = entry?.Mounts;
    if (
      !config ||
      config.NetworkMode !== "none" ||
      config.ReadonlyRootfs !== true ||
      config.Memory !== 128 * 1024 * 1024 ||
      config.MemorySwap !== 128 * 1024 * 1024 ||
      config.NanoCpus !== 500_000_000 ||
      config.PidsLimit !== 32 ||
      config.Privileged !== false ||
      config.IpcMode !== "none" ||
      !config.CapDrop?.includes("ALL") ||
      !config.SecurityOpt?.includes("no-new-privileges=true") ||
      entry.Config?.User !== "65534:65534" ||
      entry.Config?.Image !== IMAGE ||
      !entry.Config?.Cmd?.includes("--disable-sigusr1") ||
      !Array.isArray(mounts) ||
      mounts.length !== 1 ||
      mounts[0]?.Destination !== "/runner.mjs" ||
      mounts[0]?.Source !== this.runner ||
      mounts[0]?.RW !== false
    ) {
      throw new Error(
        "Docker did not enforce the required policy isolation profile.",
      );
    }
    const proof = await this.request("proof", { type: "probe" }, 2_000);
    if (
      proof.uid !== 65534 ||
      proof.network !== "none" ||
      proof.root !== "read_only" ||
      proof.environment !== "explicit"
    ) {
      throw new Error(
        "The isolated policy runtime did not prove its restrictions.",
      );
    }
  }

  private waitFor(type: string, timeout: number, id?: number): Promise<Reply> {
    if (this.pending || this.closing)
      return Promise.reject(new Error("Sandbox worker is busy or closed."));
    this.stdout = [];
    this.stdoutBytes = 0;
    const {
      promise,
      resolve: resolveReply,
      reject,
    } = Promise.withResolvers<Reply>();
    const timer = setTimeout(
      () =>
        this.fail(
          new Error(
            type === "resident_result"
              ? this.residentEntry === "step"
                ? "Resident step response deadline expired."
                : "Resident evaluation exceeded its guarded computation deadline."
              : type === "decision"
              ? "Policy evaluation exceeded its 500 ms deadline."
              : "Sandbox worker startup timed out.",
          ),
        ),
      timeout,
    );
    this.pending = { type, id, resolve: resolveReply, reject, timer };
    return promise;
  }

  private async request(
    type: string,
    message: unknown,
    timeout: number,
    id?: number,
    onEvaluation?: (elapsedMs: number) => void,
  ): Promise<Reply> {
    const line = encode(message, INPUT_BYTES) + "\n";
    const response = this.waitFor(type, timeout, id);
    if (!this.child || this.closing)
      this.fail(new Error("Sandbox worker is closed."));
    else {
      if (this.residentEntry === "analyze" && type === "resident_result")
        this.analysisEvaluation = { id: id!, started: performance.now(), reported: false, callback: onEvaluation };
      this.child.stdin.write(line);
    }
    return await response;
  }

  private receive(chunk: Buffer): void {
    if (this.closing) return;
    this.stdoutBytes += chunk.length;
    if (!this.pending || this.stdoutBytes > OUTPUT_BYTES + (this.residentEntry === "analyze" ? 512 : 0)) {
      this.fail(
        new Error("Sandbox worker violated its output protocol or size limit."),
      );
      return;
    }
    this.stdout.push(chunk);
    try {
      const buffer = Buffer.concat(this.stdout);
      let offset = 0;
      for (;;) {
        const end = buffer.indexOf(10, offset);
        if (end === -1) break;
        // Only analysis has a trusted extra notification; all other protocols
        // keep their original single-frame-per-flight framing.
        if (this.residentEntry !== "analyze" && end !== buffer.length - 1)
          throw new Error("Sandbox worker returned multiple protocol messages.");
        if (end - offset + 1 > OUTPUT_BYTES)
          throw new Error("Sandbox worker exceeded its frame limit.");
        this.receiveReply(buffer.subarray(offset, end).toString("utf8"));
        if (this.closing) return;
        if (!this.pending && end !== buffer.length - 1)
          throw new Error("Sandbox worker returned trailing protocol data.");
        offset = end + 1;
      }
      this.stdout = offset < buffer.length ? [buffer.subarray(offset)] : [];
    } catch {
      this.fail(
        new Error(
          "Policy compilation or evaluation failed, or exceeded its JSON limits.",
        ),
      );
    }
  }

  private receiveReply(text: string): void {
      if (!this.pending) throw new Error("Sandbox worker returned an unsolicited frame.");
      checkJsonDepth(text);
      const reply: unknown = JSON.parse(text);
      if (reply && typeof reply === "object" && !Array.isArray(reply) &&
        "type" in reply && reply.type === "guardian_analysis_evaluated") {
        const frame = reply as Reply, evaluation = this.analysisEvaluation;
        if (this.residentEntry !== "analyze" || this.pending.type !== "resident_result" ||
          !evaluation || evaluation.reported || frame.v !== 2 || frame.id !== evaluation.id ||
          frame.id !== this.pending.id || frame.entry !== "analyze" ||
          !exactKeys(frame, ["v", "type", "id", "entry", "elapsed_ms", "outcome"]) ||
          typeof frame.elapsed_ms !== "number" || !Number.isFinite(frame.elapsed_ms) ||
          frame.elapsed_ms < 0 || frame.elapsed_ms > Number.MAX_SAFE_INTEGER ||
          !["result", "terminated"].includes(frame.outcome as string))
          throw new Error("Invalid trusted analysis evaluation notification.");
        this.reportAnalysisEvaluation(frame.elapsed_ms);
        if (frame.outcome === "terminated") this.fail(new Error("Resident analysis evaluation failed or exceeded its guarded deadline."));
        return;
      }
      if (
        !reply ||
        typeof reply !== "object" ||
        Array.isArray(reply) ||
        !("type" in reply) ||
        reply.type !== this.pending.type
      ) {
        throw new Error(
          "Policy compilation or evaluation failed, or returned an invalid protocol response.",
        );
      }
      if (this.residentEntry) {
        const frame = reply as Reply;
        if (frame.v !== 1 || frame.id !== this.pending.id ||
          !exactKeys(frame, frame.type === "resident_result"
            ? ["v", "type", "id", "value"] : ["v", "type", "id"]) || !finiteJson(frame))
          throw new Error("Resident worker returned an invalid protocol response.");
        if (this.residentEntry === "analyze" && frame.type === "resident_result" &&
          !this.analysisEvaluation?.reported)
          throw new Error("Resident analysis result omitted trusted evaluation timing.");
      }
      const pending = this.pending;
      this.pending = null;
      this.stdout = [];
      clearTimeout(pending.timer);
      pending.resolve(reply as Reply);
  }

  private reportAnalysisEvaluation(elapsedMs: number): void {
    const evaluation = this.analysisEvaluation;
    if (!evaluation || evaluation.reported) throw new Error("Analysis evaluation boundary was repeated.");
    evaluation.reported = true;
    evaluation.callback?.(elapsedMs);
  }

  async evaluate(
    context: PolicyContext,
    signal?: AbortSignal,
  ): Promise<PolicyDecision> {
    return await this.evaluateValue(context, signal, (reply) => {
      const decision = policyDecisionSchema.safeParse(reply.decision);
      if (!decision.success)
        throw new Error("Policy returned an invalid decision.");
      return decision.data;
    });
  }

  async step(frame: MinecraftControllerFrame, state: Json, intent: Json,
    signal?: AbortSignal): Promise<ControllerStepResult> {
    return await this.residentValue("step", { frame, state, intent }, signal, value =>
      controllerStepResultSchema.parse(value));
  }

  async analyze(input: Json, signal?: AbortSignal, onEvaluation?: (elapsedMs: number) => void): Promise<Json> {
    return await this.residentValue("analyze", { input }, signal, value => value as Json, onEvaluation);
  }

  private async residentValue<T>(entry: "step" | "analyze", payload: Reply,
    signal: AbortSignal | undefined, decode: (value: unknown) => T, onEvaluation?: (elapsedMs: number) => void): Promise<T> {
    if (this.closing || this.residentEntry !== entry)
      throw new Error("Resident worker is closed or has the wrong selected entry.");
    if (this.evaluating) throw new Error("Concurrent resident computation is not allowed.");
    this.evaluating = true;
    const abort = () => this.fail(new Error("Resident computation was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new Error("Resident computation was cancelled.");
      assertResidentInput(payload);
      if (entry === "step") {
        residentStateSchema.parse(payload.state);
        residentIntentSchema.parse(payload.intent);
      }
      if (!Number.isSafeInteger(this.sequence + 1)) throw new Error("Resident sequence exhausted.");
      const id = ++this.sequence;
      const reply = await this.request("resident_result",
        { v: 1, type: `resident_${entry}`, id, ...payload },
        entry === "step" ? RESIDENT_STEP_RESPONSE_MS : this.residentBudget, id, onEvaluation);
      if (signal?.aborted || this.closing) throw new Error("Resident computation was cancelled.");
      return decode(reply.value);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Resident computation failed.");
      await this.terminate(failure);
      throw failure;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.evaluating = false;
      if (entry === "analyze") this.analysisEvaluation = null;
    }
  }

  async evaluateBoolean(context: Json, signal: AbortSignal): Promise<boolean> {
    return await this.evaluateValue(context, signal, (reply) => {
      if (typeof reply.decision !== "boolean")
        throw new Error("Precondition must return a boolean.");
      return reply.decision;
    });
  }

  private async evaluateValue<T>(
    context: PolicyContext | Json,
    signal: AbortSignal | undefined,
    decode: (reply: Reply) => T,
  ): Promise<T> {
    if (this.closing) throw new Error("Sandbox worker is closed.");
    if (this.evaluating)
      throw new Error(
        "Concurrent evaluation on the same policy worker is not allowed.",
      );
    if (signal?.aborted) {
      await this.terminate(new Error("Policy evaluation was cancelled."));
      throw new Error("Policy evaluation was cancelled.");
    }
    this.evaluating = true;
    const abort = () =>
      this.fail(new Error("Policy evaluation was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const reply = await this.request(
        "decision",
        { type: "evaluate", context, state: this.state },
        EVALUATION_MS,
      );
      if (signal?.aborted || this.closing)
        throw new Error("Policy evaluation was cancelled.");
      const state = reply.state;
      if (!state || typeof state !== "object" || Array.isArray(state))
        throw new Error("Policy state must remain a JSON object.");
      const stateText = encode(state, STATE_BYTES + 1);
      const decision = decode(reply);
      this.state = JSON.parse(stateText) as Record<string, Json>;
      return decision;
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Policy evaluation failed.");
      await this.terminate(failure);
      throw failure;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.evaluating = false;
    }
  }

  private fail(error: Error): void {
    // The pending request is rejected only after Docker removal and child reaping finish.
    void this.terminate(error).catch(() => {
      /* The original waiter receives the safe cleanup error. */
    });
  }

  private terminate(reason: Error): Promise<void> {
    if (this.cleanup) return this.cleanup;
    // Abort/deadline/transport failure can win the race with the guardian's
    // notification. Capture that trusted host boundary BEFORE joining cleanup.
    // This is guarded dispatch wall time, not pure CPU or cross-clock arithmetic.
    const evaluation = this.analysisEvaluation;
    if (evaluation && !evaluation.reported) {
      try { this.reportAnalysisEvaluation(Math.max(0, performance.now() - evaluation.started)); }
      catch { /* Instrumentation cannot release or bypass actual cleanup. */ }
    }
    this.closing = true;
    this.cleanup = (async () => {
      let failure: Error | null = null;
      try {
        if (this.child) {
          // EOF is a cleanup request, not proof of cleanup. Never kill the host
          // guardian: it exits successfully only after owned-container removal.
          this.child.stdin.end();
          await this.childExited;
          if (this.childExitCode !== 0)
            throw new Error(
              "Sandbox guardian exited without confirming policy container cleanup.",
            );
        }
      } catch {
        failure = this.residentEntry ? new ResidentCleanupError() : new Error(
          "Docker could not confirm policy container cleanup. Check the Docker daemon before continuing.",
        );
      } finally {
        this.releaseSignal?.();
        this.releaseSignal = null;
        this.state = {};
        this.stdout = [];
        const pending = this.pending;
        this.pending = null;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(failure ?? reason);
        }
        if (!failure) this.onClosed(this);
      }
      if (failure) throw failure;
    })();
    return this.cleanup;
  }

  close(): Promise<void> {
    return this.terminate(new Error("Sandbox worker was closed."));
  }
}

function exactKeys(value: Reply, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function finiteJson(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(finiteJson);
}

function skillCapability(value: unknown): SkillCapabilityRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Skill returned an invalid capability request.");
  const request = value as Reply;
  switch (request.kind) {
    case "observe":
      if (exactKeys(request, ["kind"])) return { kind: "observe" };
      break;
    case "respawn":
      if (exactKeys(request, ["kind"])) return { kind: "respawn" };
      break;
    case "action": {
      const action = gameActionSchema.safeParse(request.action);
      if (exactKeys(request, ["kind", "action"]) && action.success)
        return { kind: "action", action: action.data };
      break;
    }
    case "adapter": {
      const parsed = skillCapabilitySchema.safeParse(request);
      if (parsed.success && parsed.data.kind === "adapter") return parsed.data;
      break;
    }
    case "call": {
      const ref = namedProgramRefSchema.safeParse(request.skill);
      if (
        exactKeys(request, ["kind", "skill", "args"]) &&
        ref.success
      )
        return { kind: "call", skill: ref.data, args: request.args as Json };
      break;
    }
    case "progress":
      if (
        exactKeys(request, ["kind", "summary", "details"]) &&
        typeof request.summary === "string" &&
        request.summary.length > 0 &&
        request.summary.length <= 2000
      )
        return request as unknown as SkillCapabilityRequest;
      break;
  }
  throw new Error("Skill returned an invalid capability request.");
}

class DockerSkillWorker {
  readonly name: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private exitCode: number | null = null;
  private closing = false;
  private cleanup: Promise<void> | null = null;
  private output: Buffer[] = [];
  private outputBytes = 0;
  private phase: "ready" | "running" | "waiting" | "done" = "ready";
  private sequence = 0;
  private calls = 0;
  private actions = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly completion = Promise.withResolvers<SkillResult>();
  private traceReceiver: ProgramTraceReceiver | null = null;
  private traceHooks: SkillSandboxHooks = {};
  private startupStarted: number | null = null;
  private startupReported = false;

  constructor(
    private runner: string,
    private guardian: string,
    owner: string,
    private onClosed: (worker: DockerSkillWorker) => void,
  ) {
    this.name = `gameharness-policy-${owner}-${randomUUID()}`;
  }

  async run(
    initial: string,
    privateHandle: (request: SkillCapabilityRequest) => Promise<Json>,
    limits: SkillLimits,
    signal: AbortSignal,
    program: InstrumentedProgram,
    hooks: SkillSandboxHooks,
  ): Promise<SkillResult> {
    const traceReceiver = new ProgramTraceReceiver(program);
    this.traceReceiver = traceReceiver;
    this.traceHooks = hooks;
    this.startupStarted = performance.now();
    const abort = () => this.fail(new Error("Skill execution was cancelled."), "cancelled");
    signal.addEventListener("abort", abort, { once: true });
    const deadline = Date.now() + limits.duration_ms;
    this.timer = setTimeout(
      () =>
        this.fail(new Error("Skill execution exceeded its duration limit."), "duration_limit"),
      limits.duration_ms,
    );
    try {
      if (signal.aborted || this.closing) {
        abort();
        return await this.completion.promise;
      }
      const child = spawn(
        process.execPath,
        [
          "--no-env-file",
          this.guardian,
          this.name,
          this.runner,
          IMAGE,
          "skill",
          String(Math.max(1, deadline - Date.now())),
        ],
        { env: ENV, stdio: ["pipe", "pipe", "pipe"], detached: true },
      );
      this.child = child;
      const exited = Promise.withResolvers<void>();
      this.exited = exited.promise;
      child.once("close", (code) => {
        this.exitCode = code;
        exited.resolve();
        if (!this.closing)
          this.fail(
            new Error(
              "Skill worker exited or exceeded its computation deadline.",
            ),
            "worker_terminated",
          );
      });
      child.on("error", () =>
        this.fail(new Error("Docker skill sandbox could not be started."), "worker_terminated"),
      );
      child.stdin.on("error", () =>
        this.fail(new Error("Skill sandbox input closed unexpectedly."), "worker_terminated"),
      );
      child.stderr.on("data", () =>
        this.fail(new Error("Skill sandbox violated its output protocol."), "protocol_failure"),
      );
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.closing) return;
        this.outputBytes += chunk.length;
        if (this.outputBytes > SKILL_OUTPUT_BYTES)
          return this.fail(new Error("Skill exceeded its output size limit."), "protocol_failure");
        this.output.push(chunk);
        const end = chunk.indexOf(10);
        if (end === -1) return;
        try {
          if (end !== chunk.length - 1) throw new Error("protocol");
          const text = Buffer.concat(this.output).toString("utf8").slice(0, -1);
          this.output = [];
          checkJsonDepth(text);
          const parsed: unknown = JSON.parse(text);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !finiteJson(parsed)
          )
            throw new Error("protocol");
          const frame = parsed as Reply;
          if (frame.v !== 1) throw new Error("protocol");
          if (frame.type === "skill_call" || frame.type === "skill_result" ||
            frame.type === "skill_failure") {
            const { trace: _diagnostic, ...payload } = frame;
            encode(payload, OUTPUT_BYTES);
          }
          if (
            this.phase === "ready" &&
            frame.type === "ready" &&
            frame.id === 0 &&
            exactKeys(frame, ["v", "type", "id"])
          ) {
            this.reportStartup(true);
            this.phase = "running";
            this.outputBytes = 0;
            child.stdin.write(initial);
          } else if (
            this.phase === "running" &&
            frame.type === "skill_call" &&
            frame.id === this.sequence + 1 &&
            exactKeys(frame, ["v", "type", "id", "request", "trace"])
          ) {
            const trace = traceReceiver.accept(frame.trace);
            const request = skillCapability(frame.request);
            if (++this.calls > limits.max_calls)
              return this.fail(
                new Error("Skill exceeded its host-call budget."),
              );
            if (
              (request.kind === "action" || request.kind === "respawn") &&
              ++this.actions > limits.max_actions
            )
              return this.fail(new Error("Skill exceeded its action budget."));
            this.sequence++;
            this.phase = "waiting";
            // This frame comes ONLY through the trusted guardian AFTER Docker
            // confirms cgroup pause. Worker claims of "waiting" have no authority.
            // Fence synchronously before invoking any user-supplied host callback.
            if (this.closing || signal.aborted || Date.now() >= deadline) {
              abort();
              return;
            }
            if (trace.events.length || trace.omitted) hooks.onTrace?.(trace);
            hooks.onCapabilityRequest?.({ sequence: this.sequence, request });
            const callSequence = this.sequence;
            const started = performance.now();
            let call: Promise<Json>;
            try {
              call = Promise.resolve(privateHandle(request));
            } catch {
              call = Promise.reject(new Error("Skill capability failed."));
            }
            void call
              .then(
                (value) => {
                  // Validate and detach the broker value before any diagnostic
                  // callback can mutate it or any result reaches the container.
                  const clean = JSON.parse(encode(value, INPUT_BYTES)) as Json;
                  hooks.onCapabilityResult?.({ sequence: callSequence, request,
                    ok: true, value: clean, duration_ms: performance.now() - started });
                  this.reply(true, clean, signal, deadline);
                },
                (error: unknown) => {
                  const failure = capabilityFailure(error);
                  hooks.onCapabilityResult?.({ sequence: callSequence, request,
                    ok: false, value: failure, duration_ms: performance.now() - started });
                  this.reply(false, failure, signal, deadline);
                },
              )
              .catch(() =>
                this.fail(
                  new Error("Skill capability exceeded its JSON limits."),
                ),
              );
          } else if (
            this.phase === "running" &&
            frame.type === "skill_result" &&
            frame.id === this.sequence &&
            exactKeys(frame, ["v", "type", "id", "result", "trace"])
          ) {
            const trace = traceReceiver.accept(frame.trace);
            if (trace.events.length || trace.omitted) hooks.onTrace?.(trace);
            let value: SkillResult;
            try {
              value = parseGeneratedSkillResult(frame.result, program.source_hash);
            } catch (error) {
              if (!(error instanceof GeneratedResultValidationError)) throw error;
              traceReceiver.finish(null);
              this.phase = "done";
              void this.terminate(error).catch(() => {});
              return;
            }
            traceReceiver.finish(null);
            this.phase = "done";
            void this.terminate(null, value).catch(
              () => {},
            );
          } else if (
            this.phase === "running" &&
            frame.type === "skill_failure" &&
            frame.id === this.sequence &&
            exactKeys(frame, ["v", "type", "id", "trace", "diagnostic"])
          ) {
            const trace = traceReceiver.accept(frame.trace);
            hooks.onTrace?.(trace);
            traceReceiver.finish(null);
            this.phase = "done";
            void this.terminate(new ProgramExecutionError(readProgramDiagnostic(frame.diagnostic, program.source_hash))).catch(() => {});
          } else throw new Error("protocol");
        } catch {
          this.fail(
            new Error("Skill returned an invalid or oversized protocol frame."),
            "protocol_failure",
          );
        }
      });
      return await this.completion.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.timer) clearTimeout(this.timer);
    }
  }

  private reply(
    ok: boolean,
    value: Json,
    signal: AbortSignal,
    deadline: number,
  ): void {
    if (this.closing) return;
    if (signal.aborted || Date.now() >= deadline) {
      this.fail(
        new Error(
          "Skill execution was cancelled or exceeded its duration limit.",
        ),
        signal.aborted ? "cancelled" : "duration_limit",
      );
      return;
    }
    const line =
      encode(
        { v: 1, type: "skill_reply", id: this.sequence, ok, ...(ok ? { value } : { error: value }) },
        INPUT_BYTES,
      ) + "\n";
    this.outputBytes = 0;
    this.phase = "running";
    this.child?.stdin.write(line);
  }

  private fail(error: Error, lossReason: ProgramTraceLossReason = "host_failure"): void {
    void this.terminate(error, undefined, lossReason).catch(() => {});
  }

  private reportStartup(confirmed: boolean): void {
    if (this.startupReported || this.startupStarted === null) return;
    this.startupReported = true;
    this.traceHooks.onTiming?.({
      phase: "worker_start", started_monotonic_ms: this.startupStarted,
      ended_monotonic_ms: performance.now(), confirmed,
    });
  }

  private terminate(
    reason: Error | null,
    result?: SkillResult,
    lossReason: ProgramTraceLossReason = "host_failure",
  ): Promise<void> {
    if (this.cleanup) return this.cleanup;
    // First fence every future callback/resume, then ask the independent
    // guardian to remove the container. Never kill or time out the guardian.
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    const cleanupStarted = performance.now();
    this.cleanup = (async () => {
      let failure = reason;
      try { this.reportStartup(false); }
      catch { failure ??= new Error("Skill startup timing could not be recorded."); }
      if (this.child) {
        this.child.stdin.end();
        await this.exited;
        if (this.exitCode !== 0) failure = new SkillCleanupError();
      }
      this.output = [];
      const loss = this.traceReceiver?.finish(
        failure instanceof SkillCleanupError ? "cleanup_failure" : lossReason,
      );
      if (loss) {
        try {
          // Read-only old-life diagnostics settle before worker.done and hence
          // before root closure; this never admits or resumes a capability.
          this.traceHooks.onTrace?.(loss);
        } catch {
          failure ??= new Error("Skill trace loss could not be recorded.");
        }
      }
      try {
        this.traceHooks.onTiming?.({
          phase: "worker_cleanup", started_monotonic_ms: cleanupStarted,
          ended_monotonic_ms: performance.now(), confirmed: !this.child || this.exitCode === 0,
        });
      } catch { failure ??= new Error("Skill cleanup timing could not be recorded."); }
      if (!this.child || this.exitCode === 0) this.onClosed(this);
      if (failure) this.completion.reject(failure);
      else if (result) this.completion.resolve(result);
      else this.completion.reject(new Error("Skill execution was cancelled."));
      if (this.child && this.exitCode !== 0) throw failure;
    })();
    return this.cleanup;
  }

  close(): Promise<void> {
    return this.terminate(new Error("Skill execution was cancelled."), undefined, "cancelled");
  }
}

export class SandboxService {
  private state: SandboxState = {
    status: "unavailable",
    image: IMAGE,
    error: "Policy sandbox has not been prepared.",
  };
  private readonly owner = randomUUID();
  private readonly workers = new Set<DockerPolicyWorker | DockerSkillWorker>();
  private preparing: Promise<SandboxState> | null = null;
  private closed = false;
  private runner: string | null = null;
  private guardian: string | null = null;

  constructor(
    private projectRoot: string,
    private onChange: () => void = () => {},
  ) {}

  snapshot(): SandboxState {
    return { ...this.state };
  }

  private change(status: SandboxState["status"], error: string | null): void {
    this.state = { status, image: IMAGE, error };
    this.onChange();
  }

  prepare(): Promise<SandboxState> {
    if (this.closed)
      return Promise.resolve({
        status: "unavailable",
        image: IMAGE,
        error: "Sandbox service is closed.",
      });
    if (this.preparing) return this.preparing;
    this.preparing = this.prepareOnce().finally(() => {
      this.preparing = null;
    });
    return this.preparing;
  }

  private async prepareOnce(): Promise<SandboxState> {
    this.change("checking", null);
    let probe: DockerPolicyWorker | null = null;
    try {
      this.runner = await realpath(
        resolve(this.projectRoot, "sandbox/worker.mjs"),
      );
      this.guardian = await realpath(
        resolve(this.projectRoot, "sandbox/guardian.mjs"),
      );
      if (
        !(await stat(this.runner)).isFile() ||
        this.runner.includes(",") ||
        this.runner.includes(":")
      )
        throw new Error("The trusted sandbox runner file is unavailable.");
      if (!(await stat(this.guardian)).isFile())
        throw new Error("The trusted sandbox guardian file is unavailable.");
      probe = this.allocate();
      await probe.start();
      await probe.proveProfile();
      await probe.close();
      if (!this.closed) this.change("ready", null);
    } catch {
      let cleanupFailed = false;
      if (probe)
        await probe.close().catch(() => {
          cleanupFailed = true;
        });
      if (!this.closed)
        this.change(
          "unavailable",
          cleanupFailed
            ? "Docker could not confirm sandbox cleanup. Restore Docker before preparing again."
            : "The isolated policy sandbox is unavailable. Start Docker, ensure the pinned Node image is installed, and check the trusted runner file and required isolation controls.",
        );
    }
    return this.snapshot();
  }

  private allocate(): DockerPolicyWorker {
    if (this.closed || !this.runner || !this.guardian)
      throw new Error("Sandbox service is not available.");
    if (this.workers.size >= MAX_WORKERS)
      throw new Error(
        "The sandbox worker limit has been reached. Close unused policies before creating another.",
      );
    const worker = new DockerPolicyWorker(
      this.runner,
      this.guardian,
      this.owner,
      (owned) => this.workers.delete(owned),
    );
    this.workers.add(worker);
    return worker;
  }

  async createWorker(spec: PolicySpec): Promise<PolicyWorker> {
    if (this.closed || this.state.status !== "ready")
      throw new Error(
        "Prepare the Docker policy sandbox before creating a worker.",
      );
    const parsed = policySpecSchema.safeParse(spec);
    if (!parsed.success)
      throw new Error(
        "Policy specification is invalid or exceeds its source limit.",
      );
    if (parsed.data.backend !== "javascript")
      throw new Error("Docker policy workers require the JavaScript backend.");
    const worker = this.allocate();
    await worker.start(parsed.data.source);
    return worker;
  }

  async createResidentWorker(source: string, stepMs: number, signal: AbortSignal): Promise<ResidentWorker> {
    return await this.createResident(source, "step", stepMs, signal);
  }

  async createResidentAnalysisWorker(source: string, jobMs: number, signal: AbortSignal): Promise<ResidentAnalysisWorker> {
    return await this.createResident(source, "analyze", jobMs, signal);
  }

  private async createResident(source: string, entry: "step" | "analyze", budget: number,
    signal: AbortSignal): Promise<DockerPolicyWorker> {
    if (this.closed || this.state.status !== "ready")
      throw new Error("Prepare the Docker sandbox before creating a resident worker.");
    if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 16384)
      throw new Error("Resident source exceeds its size limit.");
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > (entry === "step" ? 500 : 5000))
      throw new Error("Resident computation budget must be finite and within its maximum.");
    if (signal.aborted) throw new Error("Resident worker was cancelled.");
    const worker = this.allocate();
    await worker.start(source, entry, budget, signal);
    return worker;
  }

  /** Effect-free, one-shot predicate in the same externally watched Docker profile. */
  async evaluateGameGuard(
    source: string,
    observation: ObservationV3,
    args: Json,
    signal: AbortSignal,
    contract: ExecutableValidationContext,
  ): Promise<boolean> {
    if (this.closed || this.state.status !== "ready")
      throw new Error("Prepare the Docker sandbox before evaluating a precondition.");
    await validateProgramSource(source, "guard", contract);
    const context = { observation, args } as unknown as Json;
    encode(context, INPUT_BYTES);
    if (signal.aborted) throw new Error("Precondition evaluation was cancelled.");
    const worker = this.allocate();
    try {
      await worker.start(source, "guard");
      return await worker.evaluateBoolean(context, signal);
    } finally {
      await worker.close();
    }
  }

  async runSkill(
    source: string,
    args: Json,
    handle: (request: SkillCapabilityRequest) => Promise<Json>,
    limits: SkillLimits,
    signal: AbortSignal,
    hooks: SkillSandboxHooks = {},
  ): Promise<SkillResult> {
    if (
      this.closed ||
      this.state.status !== "ready" ||
      !this.runner ||
      !this.guardian
    )
      throw new Error("Prepare the Docker sandbox before running a skill.");
    if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 16384)
      throw new Error("Skill source exceeds its size limit.");
    for (const key of Object.keys(MAX_SKILL_LIMITS) as (keyof SkillLimits)[]) {
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > MAX_SKILL_LIMITS[key]
      )
        throw new Error("Skill limits must be finite and within host maxima.");
    }
    if (signal.aborted) throw new Error("Skill execution was cancelled.");
    if (this.workers.size >= MAX_WORKERS)
      throw new Error("The sandbox worker limit has been reached.");
    // Validate input before reserving a slot; no unsandboxed execution fallback.
    if (!hooks.api || hooks.api.api_version !== 5) throw new Error("Skill execution requires the current host-bound API manifest.");
    encode({ v: 1, type: "skill_init", id: 0, source, args, api: hooks.api }, INPUT_BYTES);
    const program = instrumentProgram(source);
    hooks.onInstrumentation?.({
      source_hash: program.source_hash,
      points: program.points.map((point) => ({ ...point })),
    });
    const initial =
      encode({ v: 1, type: "skill_init", id: 0,
        source: program.execution_source, source_hash: program.source_hash, args, api: hooks.api,
        instrumentation: { hook_name: program.hook_name, scope: program.scope,
          kinds: program.points.map((point) => point.kind) },
      }, SKILL_INPUT_BYTES) +
      "\n";
    const worker = new DockerSkillWorker(
      this.runner,
      this.guardian,
      this.owner,
      (owned) => this.workers.delete(owned),
    );
    this.workers.add(worker);
    return await worker.run(initial, handle, { ...limits }, signal, program, hooks);
  }

  async validate(spec: PolicySpec, context: PolicyContext): Promise<void> {
    const worker = await this.createWorker(spec);
    try {
      await worker.evaluate(context);
    } finally {
      await worker.close();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.change("unavailable", "Sandbox service is closed.");
    const results = await Promise.allSettled(
      [...this.workers].map((worker) => worker.close()),
    );
    if (this.preparing) await this.preparing;
    if (results.some((result) => result.status === "rejected"))
      throw new Error(
        "Docker could not confirm cleanup of every owned sandbox container.",
      );
  }
}
