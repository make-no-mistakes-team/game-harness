import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createNativeJudge } from "@oh-my-pi/pi-ai/judgment";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { z } from "zod";
import { policyDecisionSchema } from "../shared/validation.ts";
import type { FastJudgeBroker, FastJudgeSelection } from "./fast-provider.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const LIMITS = Object.freeze({
  max_concurrent: 2,
  requests_per_minute: 60,
  max_request_ms: 10_000,
  reactive_request_ms: 2_000,
  max_attempts: 1,
});
const MAX_BODY_BYTES = 262_144;
const MODEL_IDS = getBundledModels("typesafe")
  .filter(
    (model) =>
      model.api === "typesafe" &&
      model.kind === "judge" &&
      model.baseUrl === "https://api.typesafe.ai",
  )
  .map((model) => model.id);

type Request = Parameters<FastJudgeBroker["evaluate"]>[0];
type Usage = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};
type Accounting = {
  usage: Usage | null;
  known_cost: number | null;
  actual_calls: number;
  provider_request_id: string | null;
};
export type JevErrorCode =
  | "unavailable"
  | "closed"
  | "invalid_request"
  | "busy"
  | "rate_limited"
  | "deadline"
  | "aborted"
  | "credentials_changed"
  | "unauthorized"
  | "provider_error"
  | "invalid_response"
  | "storage_error";
const MESSAGES: Record<JevErrorCode, string> = {
  unavailable: "Jev is unavailable. Configure an app-owned TypeSafe API key.",
  closed: "The Jev broker is closed.",
  invalid_request:
    "The Jev request must contain a supported model and bounded, unique typed choices.",
  busy: "Jev has reached its concurrent request limit.",
  rate_limited: "Jev has reached its request rate limit.",
  deadline: "The Jev request deadline expired.",
  aborted: "The Jev request was cancelled.",
  credentials_changed:
    "The Jev request was cancelled because its credentials changed.",
  unauthorized:
    "TypeSafe did not authorize the configured key for this request.",
  provider_error:
    "The TypeSafe request failed. Check connectivity and provider availability.",
  invalid_response:
    "TypeSafe did not return a valid answer for the declared choices.",
  storage_error: "The private Jev credential store could not be accessed.",
};

/** Only fixed messages and non-secret accounting cross the trusted broker seam. */
export class JevBrokerError extends Error implements Accounting {
  readonly usage: Usage | null;
  readonly known_cost: number | null;
  readonly actual_calls: number;
  readonly provider_request_id: string | null;
  constructor(
    readonly code: JevErrorCode,
    accounting?: Accounting,
  ) {
    super(MESSAGES[code]);
    this.name = "JevBrokerError";
    this.usage = accounting?.usage ? { ...accounting.usage } : null;
    this.known_cost = accounting?.known_cost ?? null;
    this.actual_calls = accounting?.actual_calls ?? 0;
    this.provider_request_id = accounting?.provider_request_id ?? null;
  }
}

export interface JevStatus {
  backend: "jev";
  provider: "typesafe";
  state: "unavailable" | "configured" | "closed";
  configured: boolean;
  models: { id: string; name: string }[];
  selection: FastJudgeSelection | null;
  active_requests: number;
  limits: typeof LIMITS;
}
export interface JevBrokerOptions {
  onChange?: () => void;
  /** Optional trusted selection; only bundled TypeSafe judges are admitted. */
  model_id?: string;
  /** Trusted transport injection, not model- or browser-controlled configuration. */
  fetch?: FetchImpl;
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
function validKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}
const savedKeySchema = z
  .object({
    version: z.literal(1),
    api_key: z.string().refine(validKey),
  })
  .strict();
const usageEnvelopeSchema = z
  .object({
    usage: z
      .object({
        input_tokens: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
        output_tokens: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
        cost: z.number().nonnegative().optional(),
      })
      .loose(),
  })
  .loose();
const choiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
  })
  .strict();
function captureUsage(payload: unknown, accounting: Accounting): void {
  const parsed = usageEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return;
  const usage = parsed.data.usage;
  // The System One wire has aggregate uncached input/output, no cache counters.
  if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
    accounting.usage = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: 0,
      cacheWrite: 0,
    };
  }
  // NativeJudge's tokenUsage defaults missing cost to zero. Inspect the real
  // wire field instead so an absent bill never becomes a known free request.
  if (usage.cost !== undefined) accounting.known_cost = usage.cost;
}
function validAnswer(
  answer: unknown,
  choices: Set<string>,
): answer is { choice: string } {
  const parsed = choiceAnswerSchema.safeParse(answer);
  if (!parsed.success || !choices.has(parsed.data.choice)) return false;
  const entries = Object.entries(parsed.data.probabilities);
  return (
    entries.length === choices.size &&
    entries.every(
      ([id, probability]) =>
        choices.has(id) && probability >= 0 && probability <= 1,
    ) &&
    Math.abs(
      entries.reduce((sum, [, probability]) => sum + probability, 0) - 1,
    ) <= 0.01
  );
}

/** Real TypeSafe judgments, independently admitted from strategic model turns. */
export class JevBroker implements FastJudgeBroker {
  readonly #directory: string;
  readonly #fetch: FetchImpl;
  readonly #onChange: (() => void) | undefined;
  readonly #modelId: string;
  #key: string | null = null;
  #closed = false;
  #operations = new Map<AbortController, Promise<void>>();
  #recent: number[] = [];
  #mutation: Promise<void> = Promise.resolve();

  private constructor(directory: string, options: JevBrokerOptions) {
    const modelId = options.model_id ?? MODEL_IDS[0];
    if (!modelId || !MODEL_IDS.includes(modelId))
      throw new JevBrokerError("invalid_request");
    this.#modelId = modelId;
    this.#directory = directory;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onChange = options.onChange;
  }

  static async create(
    dataDir: string,
    options: JevBrokerOptions = {},
  ): Promise<JevBroker> {
    const directory = join(dataDir, "jev");
    const broker = new JevBroker(directory, options);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      await chmod(directory, 0o700);
      let file;
      try {
        file = await open(
          join(directory, "key.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (missing(error)) return broker;
        throw error;
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192)
          throw new Error();
        await file.chmod(0o600);
        const bytes = Buffer.alloc(8193);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 8192) throw new Error();
        const saved = savedKeySchema.parse(
          JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
        );
        broker.#key = saved.api_key;
      } finally {
        await file.close();
      }
      return broker;
    } catch {
      throw new JevBrokerError("storage_error");
    }
  }

  /** Configured describes local configuration, never connectivity or entitlement. */
  status(): JevStatus {
    return {
      backend: "jev",
      provider: "typesafe",
      state: this.#closed ? "closed" : this.#key ? "configured" : "unavailable",
      configured: !this.#closed && this.#key !== null,
      models: MODEL_IDS.map((id) => ({
        id,
        name: getBundledModel("typesafe", id).name,
      })),
      selection: this.#closed || !this.#key ? null : this.selection(),
      active_requests: this.#operations.size,
      limits: { ...LIMITS },
    };
  }

  selection(): FastJudgeSelection {
    this.#available();
    if (!this.#key) throw new JevBrokerError("unavailable");
    return {
      model_id: this.#modelId,
      request_timeout_ms: LIMITS.reactive_request_ms,
    };
  }

  setKey(key: string): Promise<JevStatus> {
    if (!validKey(key))
      return Promise.reject(new JevBrokerError("invalid_request"));
    return this.#serialize(async () => {
      this.#available();
      await this.#revoke("credentials_changed");
      const temporary = join(
        this.#directory,
        `.key-${crypto.randomUUID()}.tmp`,
      );
      try {
        const file = await open(
          temporary,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.chmod(0o600);
          await file.writeFile(JSON.stringify({ version: 1, api_key: key }));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, join(this.#directory, "key.json"));
        await this.#syncDirectory();
        if (this.#closed) throw new JevBrokerError("closed");
        this.#key = key;
        this.#changed();
        return this.status();
      } catch (error) {
        this.#changed();
        if (error instanceof JevBrokerError) throw error;
        throw new JevBrokerError("storage_error");
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
  }

  removeKey(): Promise<JevStatus> {
    return this.#serialize(async () => {
      this.#available();
      await this.#revoke("credentials_changed");
      try {
        await unlink(join(this.#directory, "key.json")).catch(
          (error: unknown) => {
            if (!missing(error)) throw error;
          },
        );
        await this.#syncDirectory();
        return this.status();
      } catch {
        throw new JevBrokerError("storage_error");
      } finally {
        this.#changed();
      }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#revoke("closed");
    await this.#mutation;
    this.#changed();
  }

  async evaluate(
    request: Request,
  ): Promise<Accounting & { choice_id: string }> {
    this.#available();
    const key = this.#key;
    if (!key) throw new JevBrokerError("unavailable");
    if (request.signal.aborted) throw new JevBrokerError("aborted");
    const remaining = request.deadline_at - Date.now();
    if (!Number.isFinite(remaining))
      throw new JevBrokerError("invalid_request");
    if (remaining <= 0) throw new JevBrokerError("deadline");
    const choices = new Set<string>();
    if (
      !MODEL_IDS.includes(request.model_id) ||
      typeof request.instruction !== "string" ||
      request.instruction.length === 0 ||
      Buffer.byteLength(request.instruction) > 32768 ||
      !Array.isArray(request.choices) ||
      request.choices.length < 2 ||
      request.choices.length > 16
    )
      throw new JevBrokerError("invalid_request");
    for (const choice of request.choices) {
      if (
        !choice ||
        typeof choice.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(choice.id) ||
        choices.has(choice.id) ||
        !policyDecisionSchema.safeParse(choice.decision).success
      )
        throw new JevBrokerError("invalid_request");
      choices.add(choice.id);
    }
    let state: string;
    try {
      state = JSON.stringify(request.context);
      if (!state || Buffer.byteLength(state) > MAX_BODY_BYTES)
        throw new Error();
    } catch {
      throw new JevBrokerError("invalid_request");
    }
    if (this.#operations.size >= LIMITS.max_concurrent)
      throw new JevBrokerError("busy");
    const now = Date.now();
    this.#recent = this.#recent.filter((time) => time > now - 60_000);
    if (this.#recent.length >= LIMITS.requests_per_minute)
      throw new JevBrokerError("rate_limited");
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const accounting: Accounting = {
      usage: null,
      known_cost: null,
      actual_calls: 0,
      provider_request_id: null,
    };
    const timeout = setTimeout(
      () => controller.abort(new JevBrokerError("deadline")),
      Math.min(
        LIMITS.max_request_ms,
        Math.max(1, request.deadline_at - Date.now()),
      ),
    );
    const completion = Promise.withResolvers<void>();
    this.#operations.set(controller, completion.promise);
    this.#changed();
    let rejectAbort: (() => void) | undefined;
    let work: Promise<unknown> | undefined;
    try {
      const transport: FetchImpl = async (input, init) => {
        try {
          signal.throwIfAborted();
          if (Date.now() >= request.deadline_at)
            throw new JevBrokerError("deadline");
          if (
            String(input) !== ENDPOINT ||
            init?.method !== "POST" ||
            accounting.actual_calls >= LIMITS.max_attempts
          )
            throw new JevBrokerError("invalid_request");
          // Two admitted judgments can reach the asynchronous transport after
          // the same rate preflight. Reserve the send here, without an await.
          this.#recent = this.#recent.filter(
            (time) => time > Date.now() - 60_000,
          );
          if (this.#recent.length >= LIMITS.requests_per_minute)
            throw new JevBrokerError("rate_limited");
          accounting.actual_calls++;
          this.#recent.push(Date.now());
          const response = await this.#fetch(input, {
            ...init,
            redirect: "error",
            signal,
          });
          const id =
            response.headers.get("x-request-id") ??
            response.headers.get("request-id");
          if (id && /^[a-zA-Z0-9._:-]{1,160}$/.test(id) && !id.includes(key))
            accounting.provider_request_id = id;
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            throw new JevBrokerError(
              response.status === 401 || response.status === 403
                ? "unauthorized"
                : response.status === 429
                  ? "rate_limited"
                  : "provider_error",
            );
          }
          const reader = response.body?.getReader();
          if (!reader) throw new JevBrokerError("invalid_response");
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              signal.throwIfAborted();
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > MAX_BODY_BYTES)
                throw new JevBrokerError("invalid_response");
              chunks.push(chunk.value);
            }
          } finally {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          let payload: unknown;
          const body = Buffer.concat(chunks, bytes);
          try {
            payload = JSON.parse(body.toString("utf8"));
          } catch {
            throw new JevBrokerError("invalid_response");
          }
          captureUsage(payload, accounting);
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          // NativeJudge has its own retries/backoff. Abort before rethrowing so
          // its catch exits immediately and cannot send an unaccounted retry.
          const safe =
            error instanceof JevBrokerError
              ? error
              : new JevBrokerError("provider_error");
          controller.abort(safe);
          throw safe;
        }
      };
      const judge = createNativeJudge(
        getBundledModel("typesafe", request.model_id),
        {
          apiKey: key,
          fetch: transport,
        },
      );
      const judgment = judge.judge(
        {
          state,
          questions: {
            decision: {
              type: "choice",
              instructions: request.instruction,
              criteria: Object.fromEntries(
                request.choices.map((choice) => [
                  choice.id,
                  JSON.stringify(choice.decision),
                ]),
              ),
            },
          },
        },
        { signal },
      );
      work = judgment;
      const interrupted = Promise.withResolvers<never>();
      rejectAbort = () => interrupted.reject(new JevBrokerError("aborted"));
      signal.addEventListener("abort", rejectAbort, { once: true });
      if (signal.aborted) rejectAbort();
      const result = await Promise.race([judgment, interrupted.promise]);
      if (signal.aborted) throw new JevBrokerError("aborted");
      if (Date.now() >= request.deadline_at)
        throw new JevBrokerError("deadline");
      const answer = result.answers.decision;
      if (!validAnswer(answer, choices))
        throw new JevBrokerError("invalid_response");
      return { choice_id: answer.choice, ...accounting };
    } catch (error) {
      const reason: unknown = controller.signal.reason;
      const code = request.signal.aborted
        ? "aborted"
        : reason instanceof JevBrokerError
          ? reason.code
          : error instanceof JevBrokerError
            ? error.code
            : "invalid_response";
      throw new JevBrokerError(code, accounting);
    } finally {
      clearTimeout(timeout);
      if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
      controller.abort(new JevBrokerError("aborted"));
      // A deadline returns promptly, but the concurrency slot remains occupied
      // until the aborted transport settles. A stalled transport cannot permit
      // an unbounded stream of replacement requests.
      const release = () => {
        this.#operations.delete(controller);
        completion.resolve();
        this.#changed();
      };
      if (work) void work.then(release, release);
      else release();
    }
  }

  #available(): void {
    if (this.#closed) throw new JevBrokerError("closed");
  }
  async #revoke(code: "credentials_changed" | "closed"): Promise<void> {
    this.#key = null;
    const operations = [...this.#operations.entries()];
    for (const [operation] of operations)
      operation.abort(new JevBrokerError(code));
    await Promise.all(operations.map(([, completion]) => completion));
  }
  #changed(): void {
    // Notification must never turn a committed credential change into failure.
    try {
      this.#onChange?.();
    } catch {
      /* The store remains authoritative. */
    }
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation);
    this.#mutation = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async #syncDirectory(): Promise<void> {
    const file = await open(
      this.#directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
