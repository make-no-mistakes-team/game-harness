import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { ApiKeyResolveContext, ResolvedApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import { createAuthRetryKeyState, resolveNextAuthRetryKey } from "@oh-my-pi/pi-ai/auth-retry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { CodexApiError } from "@oh-my-pi/pi-ai/providers/openai-codex/response-handler";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
  API_KEY_RESOLVE_CONTEXT_MAX_BYTES,
  CognitionAgentFactory,
  decodeApiKeyResolveContext,
  encodeApiKeyResolveContext,
  type CognitionSessionGrant,
  type CognitionInferencePort,
} from "../src/server/cognition-inference.ts";
import { singleDispatchCodexStream } from "../src/server/evaluation-inference.ts";

function grant(singleInferenceDispatch = false): CognitionSessionGrant {
  const model = getBundledModels("openai-codex")[0];
  assert.ok(model, "The SDK must provide a Codex descriptor for offline Agent construction");
  return { sessionId: "offline-owned-session", model: structuredClone(model), thinkingLevel: Effort.Low, singleInferenceDispatch };
}

async function resolverFor(agent: Agent) {
  const resolver = await agent.getApiKey?.(agent.state.model);
  assert.equal(typeof resolver, "function");
  if (typeof resolver !== "function") throw new Error("Expected selected-account resolver");
  return resolver;
}

function privateRoundTrip(context: ApiKeyResolveContext): ApiKeyResolveContext {
  // Exercise the real JSON boundary, not an in-process Error reference.
  return decodeApiKeyResolveContext(JSON.parse(JSON.stringify(encodeApiKeyResolveContext(context))));
}

test("resolver context retains actual SDK HTTP/OAuth error classes, headers, codes and causes", () => {
  const cause = new AIError.OAuthError("offline explicit refresh", { kind: "token-refresh", status: 401, provider: "openai-codex" });
  const error = new CodexApiError({ message: "offline quota", status: 429, code: "usage_limit_reached", raw: "offline body" },
    new Headers({ "retry-after": "7", "x-offline-header": "retained" }));
  Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  AIError.attach(error, AIError.create(AIError.Flag.UsageLimit));
  const context = privateRoundTrip({ lastChance: true, previousKey: "offline-private-bearer", error });
  assert.ok(context.error instanceof CodexApiError);
  assert.ok(context.error instanceof AIError.ProviderHttpError);
  assert.ok(context.error.cause instanceof AIError.OAuthError);
  expect(context.lastChance).toBe(true);
  expect(context.previousKey).toBe("offline-private-bearer");
  expect(context.error.status).toBe(429);
  expect(context.error.code).toBe("usage_limit_reached");
  expect(context.error.headers?.get("retry-after")).toBe("7");
  expect(context.error.info.raw).toBe("offline body");
  expect(context.error.cause.kind).toBe("token-refresh");
  expect(AIError.status(context.error)).toBe(AIError.status(error));
  expect(AIError.classify(context.error)).toBe(AIError.classify(error));
  expect(AIError.isAuthRetryableError(context.error)).toBe(AIError.isAuthRetryableError(error));
  expect(Object.getOwnPropertyDescriptor(context.error, "errorId")?.enumerable).toBe(false);
});

test("resolver context preserves plain Error status, body classification, shared and cyclic cause data", () => {
  const error = Object.assign(new Error("offline forbidden"), { status: 403, type: "offline-policy", body: { code: "cyber_policy" } });
  Object.defineProperty(error, "cause", { value: error, enumerable: false });
  const decoded = privateRoundTrip({ lastChance: true, error }).error;
  assert.ok(decoded instanceof Error);
  expect(decoded.cause).toBe(decoded);
  expect(AIError.status(decoded)).toBe(403);
  expect(AIError.classify(decoded)).toBe(AIError.classify(error));
  expect(decoded).toHaveProperty("type", "offline-policy");
  expect(decoded).toHaveProperty("body.code", "cyber_policy");
});

test("resolver context excludes worker signals and installs the host wait signal", () => {
  const worker = new AbortController(), host = new AbortController();
  const encoded = encodeApiKeyResolveContext({ lastChance: false, error: undefined, signal: worker.signal });
  expect(JSON.stringify(encoded)).not.toContain("signal");
  const decoded = decodeApiKeyResolveContext(encoded, host.signal);
  expect(decoded.error).toBeUndefined();
  expect(decoded.signal).toBe(host.signal);
  worker.abort();
  expect(decoded.signal?.aborted).toBe(false);
  host.abort();
  expect(decoded.signal?.aborted).toBe(true);
});

test("resolver context fails closed on overflow, unsupported values and arbitrary error prototypes", () => {
  expect(() => encodeApiKeyResolveContext({ lastChance: true, error: new Error("x".repeat(API_KEY_RESOLVE_CONTEXT_MAX_BYTES)) })).toThrow("budget");
  expect(() => encodeApiKeyResolveContext({ lastChance: true, error: { unsupported: () => "private" } })).toThrow("unsupported");
  expect(() => decodeApiKeyResolveContext({
    version: 1, lastChance: false, error: { ref: 0 },
    nodes: [{ kind: "error", type: "RuntimeFault", properties: [] }],
  })).toThrow("unsupported");
  expect(() => decodeApiKeyResolveContext({ version: 1, lastChance: false, error: { ref: 0 }, nodes: [] })).toThrow("unsupported");
  expect(() => decodeApiKeyResolveContext({
    version: 1, lastChance: false, error: { ref: 0 },
    nodes: [{ kind: "object", properties: [
      { key: "status", value: 401, enumerable: true }, { key: "status", value: 403, enumerable: true },
    ] }],
  })).toThrow("unsupported");
});

test("SDK retry policy survives explicit token-refresh and afterSiblingWait context round trips", async () => {
  const refresh = new AIError.OAuthError("offline refresh", { kind: "token-refresh", status: 401 });
  const state = createAuthRetryKeyState("offline-a");
  const contexts: ApiKeyResolveContext[] = [];
  const resolver = async (context: ApiKeyResolveContext): Promise<ResolvedApiKey> => {
    const decoded = privateRoundTrip(context);
    contexts.push(decoded);
    return { apiKey: "offline-b", credentialId: 7 };
  };
  expect(await resolveNextAuthRetryKey(state, resolver, privateRoundTrip({ lastChance: false, error: refresh }).error)).toBe("offline-b");
  expect(await resolveNextAuthRetryKey(state, resolver, privateRoundTrip({ lastChance: false, error: refresh }).error)).toBeUndefined();
  expect(contexts.length).toBe(1);
  expect(contexts[0]?.lastChance).toBe(false);
  expect(contexts[0]?.previousKey).toBe("offline-a");
  assert.ok(contexts[0]?.error instanceof AIError.OAuthError);

  const repeated = createAuthRetryKeyState("offline-same");
  const policy = new AIError.ProviderHttpError("offline quota", 429, { code: "usage_limit_reached" });
  expect(await resolveNextAuthRetryKey(repeated, async context => {
    expect(privateRoundTrip(context).lastChance).toBe(true);
    return { apiKey: "offline-same", credentialId: 7, afterSiblingWait: true };
  }, privateRoundTrip({ lastChance: true, error: policy }).error)).toBe("offline-same");
});

test("factory creates the actual SDK Agent faithfully and preserves all resolved credential provenance", async () => {
  const selected = grant(true);
  const response: ResolvedApiKey = { apiKey: "offline-secret", credentialId: 9, afterSiblingWait: true,
    oauthIdentity: { orgId: "offline-org", region: "eu", inferenceRegion: "eu" } };
  const contexts: ApiKeyResolveContext[] = [];
  let releases = 0;
  const port: CognitionInferencePort = {
    async resolveKey(model, context) {
      expect(model).toEqual(selected.model);
      contexts.push(decodeApiKeyResolveContext(context));
      return response;
    },
    async release() { releases++; },
  };
  const factory = new CognitionAgentFactory(selected, port);
  const prompt = ["Offline system instruction"], tools: Parameters<typeof factory.createAgent>[0]["tools"] = [];
  const agent = await factory.createAgent({ modelId: selected.model.id, systemPrompt: prompt, tools });
  try {
    expect(agent.sessionId).toBe(selected.sessionId);
    expect(agent.state.model).toEqual(selected.model);
    expect(agent.state.thinkingLevel).toBe(selected.thinkingLevel);
    expect(agent.state.systemPrompt).toEqual(prompt);
    expect(agent.state.systemPrompt).not.toBe(prompt);
    expect(agent.state.tools).not.toBe(tools);
    expect(agent.state.messages).toEqual([]);
    expect(agent.intentTracing).toBe(false);
    expect(agent.streamFn).toBe(singleDispatchCodexStream);
    const resolver = await resolverFor(agent);
    const result = await resolver({ lastChance: false, error: undefined });
    expect(result).toBe(response);
    expect(contexts.length).toBe(1);
    expect(contexts[0]?.error).toBeUndefined();
    await expect(factory.createAgent({ modelId: selected.model.id, systemPrompt: [], tools: [] })).rejects.toThrow("unavailable");
    await expect(Promise.resolve().then(() => agent.getApiKey?.({ ...selected.model, baseUrl: "https://invalid.example" }))).rejects.toThrow("unavailable");
  } finally { await factory.releaseAgent(agent); }
  await factory.releaseAgent(agent);
  expect(releases).toBe(1);
  await expect(factory.createAgent({ modelId: selected.model.id, systemPrompt: [], tools: [] })).rejects.toThrow("unavailable");
});

test("cancellation revokes the SDK wait without pretending host refresh or private transport drained", async () => {
  const selected = grant();
  const started = Promise.withResolvers<void>(), refresh = Promise.withResolvers<ResolvedApiKey>();
  const transport = Promise.withResolvers<void>(), releaseStarted = Promise.withResolvers<void>();
  let waitSignal: AbortSignal | undefined;
  const factory = new CognitionAgentFactory(selected, {
    resolveKey(_model, _context, signal) { waitSignal = signal; started.resolve(); return refresh.promise; },
    release() { releaseStarted.resolve(); return transport.promise; },
  });
  const agent = await factory.createAgent({ modelId: selected.model.id, systemPrompt: [], tools: [] });
  const caller = new AbortController();
  const resolution = Promise.resolve((await resolverFor(agent))({ lastChance: false, error: undefined, signal: caller.signal }));
  void resolution.catch(() => {});
  await started.promise;
  caller.abort(new Error("offline sensitive cancel payload"));
  await expect(resolution).rejects.toThrow("unavailable");
  expect(waitSignal?.aborted).toBe(true);
  let drained = false;
  const closing = factory.releaseAgent(agent).then(() => { drained = true; });
  await releaseStarted.promise;
  transport.resolve();
  await Promise.resolve();
  expect(drained).toBe(false);
  refresh.resolve({ apiKey: "offline-late-secret", credentialId: 9 });
  await closing;
  expect(drained).toBe(true);
});

test("close joins the real SDK idle promise and transport acknowledgment and closes owned provider sessions", async () => {
  const selected = grant();
  const entered = Promise.withResolvers<void>(), modelGate = Promise.withResolvers<void>();
  const releaseStarted = Promise.withResolvers<void>(), releaseGate = Promise.withResolvers<void>();
  let streamCalls = 0, providerCloses = 0;
  const factory = new CognitionAgentFactory(selected, {
    async resolveKey() { return { apiKey: "offline-private-bearer", credentialId: 9 }; },
    release() { releaseStarted.resolve(); return releaseGate.promise; },
  });
  const agent = await factory.createAgent({ modelId: selected.model.id, systemPrompt: [], tools: [] });
  agent.streamFn = () => { streamCalls++; throw new Error("Offline fixture forbids provider dispatch"); };
  agent.providerSessionState?.set("offline-owned-state", { close() { providerCloses++; } });
  agent.setBeforeModelCall(async () => {
    entered.resolve();
    await modelGate.promise;
    throw new Error("Offline gate ended after revocation");
  });
  const prompt = agent.prompt("Offline lifecycle fixture");
  await entered.promise;
  let drained = false;
  const closing = factory.close().then(() => { drained = true; });
  await releaseStarted.promise;
  expect(agent.isAborting).toBe(true);
  expect(providerCloses).toBe(1);
  releaseGate.resolve();
  await Promise.resolve();
  expect(drained).toBe(false);
  modelGate.resolve();
  await Promise.all([prompt, closing]);
  expect(drained).toBe(true);
  expect(streamCalls).toBe(0);
  expect(providerCloses).toBe(1);
  expect(agent.providerSessionState?.size).toBe(0);
});

test("invalid private key responses never become an ambient-key fallback", async () => {
  const selected = grant();
  const factory = new CognitionAgentFactory(selected, {
    async resolveKey() { return { apiKey: "" }; }, async release() {},
  });
  const agent = await factory.createAgent({ modelId: selected.model.id, systemPrompt: [], tools: [] });
  try {
    await expect((await resolverFor(agent))({ lastChance: false, error: undefined })).rejects.toThrow("unavailable");
  } finally { await factory.close(); }
});
