import type { ApiKeyResolveContext, ResolvedApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { CodexApiError } from "@oh-my-pi/pi-ai/providers/openai-codex/response-handler";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import { z } from "zod";
import { singleDispatchCodexStream } from "./evaluation-inference.ts";

// Provider errors and resolver contexts can contain credentials. In particular,
// do not allow the SDK's default file logger to persist this private channel.
setTransports({ console: false, file: false });

/** Non-secret, selected-account session grant created exclusively by the host. */
export interface CognitionSessionGrant {
  readonly sessionId: string;
  readonly model: Model;
  readonly thinkingLevel: Effort | undefined;
  readonly singleInferenceDispatch: boolean;
}

/**
 * Private request-scoped RPC only; never journal these arguments or responses.
 * signal cancels the resolver WAIT, not host-owned refresh/persistence work.
 * release must close/join this transport and settle outstanding RPCs. It must
 * NOT call session.close(): host session closure joins its consumer's drain.
 */
export interface CognitionInferencePort {
  resolveKey(
    model: Model,
    context: EncodedApiKeyResolveContext,
    signal?: AbortSignal,
  ): Promise<ResolvedApiKey>;
  release(): Promise<void>;
}

export const API_KEY_RESOLVE_CONTEXT_MAX_BYTES = 256 * 1024;
const MAX_NODES = 512;
const MAX_PROPERTIES = 512;
const MAX_DEPTH = 32;
const privateFailure = () => new Error("The selected cognition inference session is unavailable");
const contextFailure = () => new Error("The private inference resolver context is unsupported or exceeds its budget");

// JSON's Error handling loses non-enumerable cause/message/errorId; structured
// clone also loses SDK subclasses and Headers. Use a bounded graph instead.
// Only standard and actual SDK Error prototypes can be restored: never revive
// arbitrary constructors or a host/native authoritative fault brand.
const errorPrototypes = new Map<string, object>([
  ["Error", Error.prototype], ["TypeError", TypeError.prototype],
  ["RangeError", RangeError.prototype], ["ReferenceError", ReferenceError.prototype],
  ["SyntaxError", SyntaxError.prototype], ["URIError", URIError.prototype],
  ["EvalError", EvalError.prototype], ["AggregateError", AggregateError.prototype],
  ["CodexApiError", CodexApiError.prototype],
]);
for (const [name, value] of Object.entries(AIError)) {
  if (typeof value === "function" && value.prototype instanceof Error)
    errorPrototypes.set(name, value.prototype);
}

const valueSchema = z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(API_KEY_RESOLVE_CONTEXT_MAX_BYTES),
  z.object({ ref: z.number().int().min(0).max(MAX_NODES - 1) }).strict(),
  z.object({ undefined: z.literal(true) }).strict(),
]);
const propertySchema = z.object({
  key: z.string().max(1024), value: valueSchema, enumerable: z.boolean(),
}).strict();
const nodeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("error"), type: z.string().max(128), properties: z.array(propertySchema).max(MAX_PROPERTIES) }).strict(),
  z.object({ kind: z.literal("object"), properties: z.array(propertySchema).max(MAX_PROPERTIES) }).strict(),
  z.object({ kind: z.literal("array"), values: z.array(valueSchema).max(MAX_PROPERTIES) }).strict(),
  z.object({ kind: z.literal("headers"), entries: z.array(z.tuple([z.string(), z.string()])).max(MAX_PROPERTIES) }).strict(),
]);
const contextSchema = z.object({
  version: z.literal(1), lastChance: z.boolean(),
  previousKey: z.string().max(API_KEY_RESOLVE_CONTEXT_MAX_BYTES).optional(),
  error: valueSchema, nodes: z.array(nodeSchema).max(MAX_NODES),
}).strict();

type EncodedValue = z.infer<typeof valueSchema>;
type EncodedNode = z.infer<typeof nodeSchema>;
/** Contains previousKey and potentially sensitive provider bodies: private RPC only. */
export type EncodedApiKeyResolveContext = z.infer<typeof contextSchema>;

/** Encode before private JSON IPC; fail closed rather than truncate retry evidence. */
export function encodeApiKeyResolveContext(context: ApiKeyResolveContext): EncodedApiKeyResolveContext {
  const nodes: EncodedNode[] = [];
  const seen = new Map<object, number>();
  let bytes = 0;
  const charge = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > API_KEY_RESOLVE_CONTEXT_MAX_BYTES) throw contextFailure();
  };
  const encode = (value: unknown, depth: number): EncodedValue => {
    if (depth > MAX_DEPTH) throw contextFailure();
    if (value === undefined) return { undefined: true };
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") { charge(value); return value; }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw contextFailure();
    const existing = seen.get(value);
    if (existing !== undefined) return { ref: existing };
    if (nodes.length >= MAX_NODES) throw contextFailure();
    const ref = nodes.length;
    seen.set(value, ref);
    if (value instanceof Headers) {
      const entries = [...value.entries()];
      if (entries.length > MAX_PROPERTIES) throw contextFailure();
      for (const [key, entry] of entries) { charge(key); charge(entry); }
      nodes.push({ kind: "headers", entries });
    } else if (Array.isArray(value)) {
      if (value.length > MAX_PROPERTIES) throw contextFailure();
      const node: EncodedNode = { kind: "array", values: [] };
      nodes.push(node);
      for (const entry of value) node.values.push(encode(entry, depth + 1));
    } else {
      const isError = value instanceof Error;
      const prototype = Object.getPrototypeOf(value);
      if (!isError && prototype !== Object.prototype && prototype !== null) throw contextFailure();
      const properties: z.infer<typeof propertySchema>[] = [];
      let type = "Error";
      if (isError) {
        for (const [name, candidate] of errorPrototypes) {
          if (prototype === candidate) { type = name; break; }
        }
      }
      nodes.push(isError ? { kind: "error", type, properties } : { kind: "object", properties });
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).some(key => typeof key === "symbol")) throw contextFailure();
      if (Object.keys(descriptors).length > MAX_PROPERTIES) throw contextFailure();
      // Error.name may live on a subclass prototype, and stack may be a native
      // lazy accessor. Neither is allowed to disappear at the process boundary.
      if (isError) {
        properties.push({ key: "name", value: encode(value.name, depth + 1), enumerable: false });
        if (value.stack !== undefined)
          properties.push({ key: "stack", value: encode(value.stack, depth + 1), enumerable: false });
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (isError && (key === "name" || key === "stack")) continue;
        if (!("value" in descriptor)) throw contextFailure();
        charge(key);
        properties.push({ key, value: encode(descriptor.value, depth + 1), enumerable: descriptor.enumerable === true });
      }
      if (properties.length > MAX_PROPERTIES) throw contextFailure();
    }
    return { ref };
  };
  try {
    const encoded: EncodedApiKeyResolveContext = {
      version: 1, lastChance: context.lastChance, previousKey: context.previousKey,
      error: encode(context.error, 0), nodes,
    };
    if (Buffer.byteLength(JSON.stringify(encoded)) > API_KEY_RESOLVE_CONTEXT_MAX_BYTES) throw contextFailure();
    return contextSchema.parse(encoded);
  } catch { throw contextFailure(); }
}

/**
 * Restore actual SDK retry types/headers/causes. Supply the HOST request-wait
 * signal; never deserialize a worker AbortSignal or transfer refresh ownership.
 */
export function decodeApiKeyResolveContext(encoded: unknown, signal?: AbortSignal): ApiKeyResolveContext {
  try {
    const wire = contextSchema.parse(encoded);
    if (Buffer.byteLength(JSON.stringify(wire)) > API_KEY_RESOLVE_CONTEXT_MAX_BYTES) throw contextFailure();
    const objects: object[] = wire.nodes.map(node => {
      switch (node.kind) {
        case "headers": return new Headers(node.entries);
        case "array": return [];
        case "object": return Object.create(null);
        case "error": {
          const prototype = errorPrototypes.get(node.type);
          if (!prototype) throw contextFailure();
          return Object.create(prototype);
        }
      }
    });
    const decode = (value: EncodedValue): unknown => {
      if (value === null || typeof value !== "object") return value;
      if ("undefined" in value) return undefined;
      const result = objects[value.ref];
      if (result === undefined) throw contextFailure();
      return result;
    };
    for (const [index, node] of wire.nodes.entries()) {
      const target = objects[index];
      if (!target) throw contextFailure();
      if (node.kind === "array") {
        for (const [key, value] of node.values.entries())
          Object.defineProperty(target, key, { value: decode(value), enumerable: true, writable: true, configurable: true });
      } else if (node.kind === "object" || node.kind === "error") {
        const keys = new Set<string>();
        for (const { key, value, enumerable } of node.properties) {
          if (keys.has(key)) throw contextFailure();
          keys.add(key);
          Object.defineProperty(target, key, { value: decode(value), enumerable, writable: true, configurable: true });
        }
      }
    }
    return { lastChance: wire.lastChance, previousKey: wire.previousKey, error: decode(wire.error), signal };
  } catch { throw contextFailure(); }
}

/** One host-selected grant and its real SDK Agent, owned by a cognition worker. */
export class CognitionAgentFactory {
  readonly #grant: CognitionSessionGrant;
  readonly #port: CognitionInferencePort;
  readonly #controller = new AbortController();
  readonly #resolutions = new Set<Promise<ResolvedApiKey>>();
  #agent: Agent | undefined;
  #allocated = false;
  #closing: Promise<void> | undefined;

  constructor(grant: CognitionSessionGrant, port: CognitionInferencePort) {
    this.#grant = { ...grant, model: structuredClone(grant.model) };
    this.#port = port;
  }

  async createAgent(options: { modelId: string; systemPrompt: string[]; tools: AgentTool[] }): Promise<Agent> {
    this.#assertCurrent(this.#grant.model);
    if (this.#allocated || options.modelId !== this.#grant.model.id) throw privateFailure();
    this.#allocated = true;
    try {
      // No await before assigning the real Agent: revocation cannot race a late
      // allocation. Match the selected local Agent's transport configuration:
      // adding providerSessionState would silently enable persistent WebSockets.
      const agent = new Agent({
        sessionId: this.#grant.sessionId,
        initialState: {
          model: structuredClone(this.#grant.model), thinkingLevel: this.#grant.thinkingLevel,
          systemPrompt: [...options.systemPrompt], tools: [...options.tools], messages: [],
        },
        intentTracing: false,
        streamFn: this.#grant.singleInferenceDispatch ? singleDispatchCodexStream : undefined,
        getApiKey: requested => {
          this.#assertCurrent(requested);
          return context => this.#resolveKey(requested, context);
        },
      });
      this.#agent = agent;
      return agent;
    } catch {
      await this.close();
      throw privateFailure();
    }
  }

  releaseAgent(agent: Agent): Promise<void> {
    if (agent !== this.#agent) return Promise.reject(privateFailure());
    return this.close();
  }

  /** Synchronous fence used by the host's session consumer revocation. */
  revoke(): void {
    this.#controller.abort();
    this.#agent?.abort("Cognition inference session released");
  }

  /** Idempotent real drain, including private RPC and actual SDK idle. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    // Install the join before abort listeners or port.release can reenter.
    const completion = Promise.withResolvers<void>();
    this.#closing = completion.promise;
    this.revoke();
    void this.#drain().then(completion.resolve, completion.reject);
    return this.#closing;
  }

  async #drain(): Promise<void> {
    // Release starts before idle/resolve joins: closing the private channel must
    // settle a resolver that was still waiting when the SDK was aborted.
    const release = Promise.resolve().then(() => this.#port.release());
    const results = await Promise.allSettled([
      release,
      this.#agent?.waitForIdle() ?? Promise.resolve(),
      Promise.allSettled([...this.#resolutions]),
    ]);
    if (results.some(result => result.status === "rejected")) throw privateFailure();
  }

  #assertCurrent(model: Model): void {
    const selected = this.#grant.model;
    if (this.#controller.signal.aborted || model.id !== selected.id ||
        model.provider !== selected.provider || model.api !== selected.api || model.baseUrl !== selected.baseUrl)
      throw privateFailure();
  }

  async #resolveKey(model: Model, context: ApiKeyResolveContext): Promise<ResolvedApiKey> {
    try {
      this.#assertCurrent(model);
      const signal = context.signal
        ? AbortSignal.any([this.#controller.signal, context.signal]) : this.#controller.signal;
      signal.throwIfAborted();
      const encoded = encodeApiKeyResolveContext(context);
      const resolution = Promise.resolve().then(() => {
        // Recheck after scheduling as close/revoke may have won this microtask.
        this.#assertCurrent(model);
        signal.throwIfAborted();
        return this.#port.resolveKey(model, encoded, signal);
      });
      this.#resolutions.add(resolution);
      void resolution.then(
        () => this.#resolutions.delete(resolution),
        () => this.#resolutions.delete(resolution),
      );
      const key = await untilAborted(signal, () => resolution);
      this.#assertCurrent(model);
      signal.throwIfAborted();
      if (!key || typeof key !== "object" || typeof key.apiKey !== "string" || !key.apiKey) throw privateFailure();
      // Preserve credentialId, oauthIdentity AND afterSiblingWait unchanged.
      // Returning undefined/string would enable SDK ambient-key fallback.
      return key;
    } catch { throw privateFailure(); }
  }
}
