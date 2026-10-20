import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Json,
  PolicyContext,
  PolicyDecision,
  PolicySpec,
  SandboxState,
} from "../shared/contracts.ts";
import {
  policyDecisionSchema,
  policySpecSchema,
} from "../shared/validation.ts";

export interface PolicyWorker {
  evaluate(
    context: PolicyContext,
    signal?: AbortSignal,
  ): Promise<PolicyDecision>;
  close(): Promise<void>;
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
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class DockerPolicyWorker implements PolicyWorker {
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

  constructor(
    private runner: string,
    private guardian: string,
    owner: string,
    private onClosed: (worker: DockerPolicyWorker) => void,
  ) {
    this.name = `gameharness-policy-${owner}-${randomUUID()}`;
  }

  async start(source?: string): Promise<void> {
    try {
      if (this.closing) throw new Error("Sandbox worker is closed.");
      const ready = this.waitFor("ready", STARTUP_MS);
      // The detached host guardian owns Docker from before creation until rm
      // confirms termination. No policy-accessible process owns this EOF pipe.
      const child = spawn(
        process.execPath,
        ["--no-env-file", this.guardian, this.name, this.runner, IMAGE],
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
      if (source !== undefined)
        await this.request("compiled", { type: "init", source }, STARTUP_MS);
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

  private waitFor(type: string, timeout: number): Promise<Reply> {
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
            type === "decision"
              ? "Policy evaluation exceeded its 500 ms deadline."
              : "Sandbox worker startup timed out.",
          ),
        ),
      timeout,
    );
    this.pending = { type, resolve: resolveReply, reject, timer };
    return promise;
  }

  private async request(
    type: string,
    message: unknown,
    timeout: number,
  ): Promise<Reply> {
    const line = encode(message, INPUT_BYTES) + "\n";
    const response = this.waitFor(type, timeout);
    if (!this.child || this.closing)
      this.fail(new Error("Sandbox worker is closed."));
    else this.child.stdin.write(line);
    return await response;
  }

  private receive(chunk: Buffer): void {
    if (this.closing) return;
    this.stdoutBytes += chunk.length;
    if (!this.pending || this.stdoutBytes > OUTPUT_BYTES) {
      this.fail(
        new Error("Sandbox worker violated its output protocol or size limit."),
      );
      return;
    }
    this.stdout.push(chunk);
    const end = chunk.indexOf(10);
    if (end === -1) return;
    try {
      if (end !== chunk.length - 1)
        throw new Error("Sandbox worker returned multiple protocol messages.");
      const line = Buffer.concat(this.stdout);
      const text = line.subarray(0, line.length - 1).toString("utf8");
      checkJsonDepth(text);
      const reply: unknown = JSON.parse(text);
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
      const pending = this.pending;
      this.pending = null;
      this.stdout = [];
      clearTimeout(pending.timer);
      pending.resolve(reply as Reply);
    } catch {
      this.fail(
        new Error(
          "Policy compilation or evaluation failed, or exceeded its JSON limits.",
        ),
      );
    }
  }

  async evaluate(
    context: PolicyContext,
    signal?: AbortSignal,
  ): Promise<PolicyDecision> {
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
      const decision = policyDecisionSchema.safeParse(reply.decision);
      if (!decision.success)
        throw new Error("Policy returned an invalid decision.");
      this.state = JSON.parse(stateText) as Record<string, Json>;
      return decision.data;
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
        failure = new Error(
          "Docker could not confirm policy container cleanup. Check the Docker daemon before continuing.",
        );
      } finally {
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

export class SandboxService {
  private state: SandboxState = {
    status: "unavailable",
    image: IMAGE,
    error: "Policy sandbox has not been prepared.",
  };
  private readonly owner = randomUUID();
  private readonly workers = new Set<DockerPolicyWorker>();
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
      if (!(await stat(this.runner)).isFile() || this.runner.includes(","))
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
    const worker = this.allocate();
    await worker.start(parsed.data.source);
    return worker;
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
