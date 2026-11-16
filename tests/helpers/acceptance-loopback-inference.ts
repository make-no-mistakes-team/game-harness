import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { ApiKeyResolveContext, ResolvedApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import type { InferenceSessionConsumer, SelectedAccountInferenceSession } from "../../src/server/auth-session.ts";
import { singleDispatchCodexStream } from "../../src/server/evaluation-inference.ts";
import { z } from "zod";
import type { Server } from "bun";

export interface LoopbackResponse {
  iterator: AsyncIterator<string>;
  /** Runs after iterator custody is registered, before its first read. */
  acquired?(owner: { signal: AbortSignal; cancel(): void }): void;
}
interface Scope {
  sessionId: string;
  bearer: string;
  controller: AbortController;
  consumer: InferenceSessionConsumer;
  operations: Set<Promise<unknown>>;
  streams: Set<{ close(): Promise<void>; closed: Promise<void> }>;
  active: boolean;
  closing: Promise<void> | null;
}
const unavailable = () => new Error("The finite loopback selected inference session is unavailable");

/** Test transport/authentication only. Cognition, SDK, admission and tools stay real. */
export class AcceptanceLoopbackInference {
  readonly model: Model;
  readonly #server: Server<undefined>;
  readonly #scopes = new Set<Scope>();
  readonly #bearers = new Map<string, Scope>();
  readonly #agents = new Map<Agent, SelectedAccountInferenceSession>();
  readonly #handlers = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | null = null;
  #requests = 0;

  constructor(model: Model, private readonly respond: (request: {
    ordinal: number; body: Record<string, unknown>; signal: AbortSignal;
  }) => LoopbackResponse | Promise<LoopbackResponse>) {
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4 * 1024 * 1024,
      fetch: request => {
        const operation = this.#handle(request);
        this.#handlers.add(operation);
        void operation.finally(() => this.#handlers.delete(operation)).catch(() => {});
        return operation;
      },
    });
    this.model = { ...model, baseUrl: `http://127.0.0.1:${this.#server.port}/codex/responses`, preferWebsockets: false };
  }

  createInferenceSession(options: { modelId: string; consumer: InferenceSessionConsumer }): SelectedAccountInferenceSession {
    if (this.#closed || options.modelId !== this.model.id) throw unavailable();
    const sessionId = crypto.randomUUID();
    // Routable but deliberately unsigned test JWT. Never an actual credential.
    const bearer = `local.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "loopback-account" }, session_id: sessionId,
    })).toString("base64url")}.not-a-real-signature`;
    const scope: Scope = { sessionId, bearer, controller: new AbortController(), consumer: options.consumer,
      operations: new Set(), streams: new Set(), active: true, closing: null };
    this.#scopes.add(scope); this.#bearers.set(bearer, scope);
    const assertModel = (requested: Model) => {
      if (!scope.active || this.#closed || requested.id !== this.model.id || requested.provider !== this.model.provider ||
        requested.api !== this.model.api || requested.baseUrl !== this.model.baseUrl) throw unavailable();
    };
    return Object.freeze({ sessionId, model: structuredClone(this.model), thinkingLevel: undefined,
      singleInferenceDispatch: true, streamFn: singleDispatchCodexStream, signal: scope.controller.signal,
      getApiKey: (requested: Model) => {
        assertModel(requested);
        return async (context: ApiKeyResolveContext): Promise<ResolvedApiKey> => {
          const operation = Promise.resolve().then(() => {
            assertModel(requested); context.signal?.throwIfAborted();
            return { apiKey: bearer, credentialId: 17 };
          });
          scope.operations.add(operation);
          try { return await operation; } finally { scope.operations.delete(operation); }
        };
      },
      cancel: () => this.#cancel(scope), close: () => this.#closeScope(scope),
    });
  }

  async createAgent(options: { modelId?: string; systemPrompt: string[]; tools: AgentTool[] }): Promise<Agent> {
    let agent: Agent | undefined;
    const session = this.createInferenceSession({ modelId: options.modelId ?? this.model.id,
      consumer: { revoke: () => agent?.abort("Loopback preparation session revoked"),
        drain: async () => { await agent?.waitForIdle(); } } });
    try {
      agent = new Agent({ sessionId: session.sessionId,
        initialState: { model: session.model, thinkingLevel: session.thinkingLevel, systemPrompt: options.systemPrompt, tools: options.tools },
        intentTracing: false, streamFn: session.streamFn, getApiKey: requested => session.getApiKey(requested) });
      this.#agents.set(agent, session); return agent;
    } catch { await session.close(); throw unavailable(); }
  }
  async releaseAgent(agent: Agent): Promise<void> {
    const session = this.#agents.get(agent);
    if (!session) throw unavailable();
    await session.close(); this.#agents.delete(agent);
  }
  #cancel(scope: Scope): void {
    if (!scope.active) return;
    scope.active = false; scope.controller.abort(); scope.consumer.revoke();
  }
  #closeScope(scope: Scope): Promise<void> {
    if (scope.closing) return scope.closing;
    const completion = Promise.withResolvers<void>(); scope.closing = completion.promise;
    this.#cancel(scope);
    void (async () => {
      const owner = scope.consumer.drain();
      // Cancellation closes active readers now, independently of a stalled child.
      await Promise.all([owner, ...[...scope.streams].map(stream => stream.close())]);
      // A canceled response factory may still allocate its iterator. Keep its
      // operation until that late iterator has been closed and joined as well.
      while (scope.operations.size || scope.streams.size) {
        await Promise.allSettled([...scope.operations, ...[...scope.streams].map(stream => stream.close())]);
      }
      this.#bearers.delete(scope.bearer); this.#scopes.delete(scope);
    })().then(completion.resolve, completion.reject);
    return completion.promise;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const completion = Promise.withResolvers<void>(); this.#closing = completion.promise;
    for (const scope of this.#scopes) this.#cancel(scope);
    void (async () => {
      await Promise.all([...this.#scopes].map(scope => this.#closeScope(scope)));
      await this.#server.stop(true);
      while (this.#handlers.size) await Promise.allSettled([...this.#handlers]);
      this.#agents.clear();
    })().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  async #handle(request: Request): Promise<Response> {
    if (this.#closed || request.method !== "POST" || new URL(request.url).pathname !== "/codex/responses")
      return new Response("Loopback inference endpoint unavailable", { status: 404 });
    const authorization = request.headers.get("authorization");
    const scope = authorization?.startsWith("Bearer ") ? this.#bearers.get(authorization.slice(7)) : undefined;
    if (!scope?.active) return new Response("Loopback selected session unavailable", { status: 401 });
    const completion = Promise.withResolvers<void>();
    scope.operations.add(completion.promise);
    try {
      if (++this.#requests > 256) throw unavailable();
      const bytes = new Uint8Array(await request.arrayBuffer());
      const decoded = request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
      if (decoded.byteLength > 4 * 1024 * 1024) throw unavailable();
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)));
      if (!scope.active) throw unavailable();
      const signal = AbortSignal.any([scope.controller.signal, request.signal]);
      const reply = await this.respond({ ordinal: this.#requests, body, signal });
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let exhausted = false, closing: Promise<void> | null = null;
      let reading: Promise<IteratorResult<string>> | null = null;
      const drained = Promise.withResolvers<void>();
      void drained.promise.catch(() => {});
      const close = (): Promise<void> => {
        if (closing) return closing;
        closing = (async () => {
          try {
            if (!exhausted) {
              if (!reply.iterator.return) throw unavailable();
              const ended = await reply.iterator.return();
              if (!ended.done) throw unavailable();
            }
            if (reading) await reading;
            exhausted = true;
            try { controller?.close(); } catch { /* HTTP cancellation may already have closed the body. */ }
          } catch (error) {
            drained.reject(error); throw error;
          }
          signal.removeEventListener("abort", abort);
          scope.streams.delete(owned); drained.resolve();
        })();
        return closing;
      };
      const owned = { close, closed: drained.promise };
      const abort = () => { void close().catch(() => {}); };
      scope.streams.add(owned);
      signal.addEventListener("abort", abort, { once: true });
      // Acquire after registering custody. Even synchronous revoke must join the
      // original unstarted iterator, rather than losing its explicit return().
      reply.acquired?.({ signal, cancel: () => this.#cancel(scope) });
      if (signal.aborted || !scope.active || this.#closed) {
        await close(); throw unavailable();
      }
      const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull(value) {
          if (closing || exhausted) return;
          try {
            const operation = Promise.resolve().then(() => closing || signal.aborted
              ? { done: true as const, value: undefined } : reply.iterator.next());
            reading = operation;
            const next = await operation;
            if (reading === operation) reading = null;
            if (closing || signal.aborted) return;
            if (next.done) { exhausted = true; await close(); }
            else value.enqueue(new TextEncoder().encode(next.value));
          } catch { await close(); try { value.error(unavailable()); } catch { /* already canceled */ } }
        },
        cancel: () => close(),
      }, { highWaterMark: 0 });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    } catch { return new Response("Loopback inference request canceled or unavailable", { status: 499 }); }
    finally { scope.operations.delete(completion.promise); completion.resolve(); }
  }
}

/** Actual Codex Responses SSE, not an SDK stream replacement. */
export function codexLifecycleFrames(request: number, output: {
  text?: string; call?: { id: string; name: string; arguments: unknown };
  calls?: { id: string; name: string; arguments: unknown }[];
}): string {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const responseId = `loopback-response-${request}`;
  const created = frame({ type: "response.created", response: { id: responseId, status: "in_progress" } });
  let frames: string, item: Record<string, unknown>;
  const items: Record<string, unknown>[] = [];
  const calls = output.calls ?? (output.call ? [output.call] : []);
  if (calls.length) {
    frames = calls.map((call, index) => {
      const args = JSON.stringify(call.arguments);
      const current = { id: `loopback-item-${request}${index ? `-${index}` : ""}`, type: "function_call",
        call_id: call.id, name: call.name, arguments: args, status: "completed" };
      items.push(current);
      return frame({ type: "response.output_item.added", output_index: index, item: { ...current, status: "in_progress", arguments: "" } }) +
        frame({ type: "response.function_call_arguments.delta", output_index: index, item_id: current.id, delta: args }) +
        frame({ type: "response.function_call_arguments.done", output_index: index, item_id: current.id, arguments: args }) +
        frame({ type: "response.output_item.done", output_index: index, item: current });
    }).join("");
  } else {
    const text = output.text ?? "";
    item = { id: `loopback-item-${request}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] };
    frames = frame({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }) +
      frame({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } }) +
      frame({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text }) +
      frame({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text }) +
      frame({ type: "response.output_item.done", output_index: 0, item });
    items.push(item);
  }
  return created + frames + frame({ type: "response.completed", response: { id: responseId, status: "completed", output: items,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } });
}
