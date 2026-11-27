import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { ApiKeyResolution, ApiKeyResolveContext, ResolvedApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { AuthManager } from "../../src/auth/manager.ts";
import type { InferenceSessionConsumer } from "../../src/auth/session.ts";

const provider = "openai-codex";
const modelId = "gpt-6.1-sol";
const scenario = process.argv[2];
const root = await mkdtemp(join(tmpdir(), "gameharness-auth-session-"));
const database = join(root, "auth/gameharness.sqlite");
const token = (revision: number, accountId = "owned-account") =>
  `offline.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId }, revision,
  })).toString("base64url")}.not-a-signature`;
const initial: ApiKeyResolveContext = { lastChance: false, error: undefined };
const inertConsumer: InferenceSessionConsumer = { revoke() {}, async drain() {} };
const turns = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const tokenEntered = Promise.withResolvers<void>();
const tokenReleased = Promise.withResolvers<void>();
let refreshCalls = 0;
const originalFetch = globalThis.fetch;
const originalCreate = AuthStorage.create.bind(AuthStorage);
let storage: AuthStorage | undefined;
let manager: AuthManager | undefined;

try {
  await mkdir(join(root, "auth"), { mode: 0o700 });
  const seed = await originalCreate(database);
  try {
    await seed.credentials.upsert(provider, {
      type: "oauth", access: token(0, "sibling-account"), refresh: "offline-sibling-refresh",
      expires: Date.now() + 3_600_000, accountId: "sibling-account", authorizedAt: 1,
    });
    await seed.credentials.upsert(provider, {
      type: "oauth", access: token(1), refresh: "offline-owned-refresh",
      expires: Date.now() + 3_600_000, accountId: "owned-account", authorizedAt: 2,
    });
  } finally { seed.close(); }
  AuthStorage.create = async (...args) => {
    storage = await originalCreate(...args);
    return storage;
  };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "GET" && new URL(request.url).pathname.endsWith("/models"))
      return Response.json({ models: [{
        slug: modelId, display_name: "Offline auth descriptor", context_window: 500_000,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
        input_modalities: ["text", "image"], prefer_websockets: false,
      }] });
    if (scenario === "refresh" && request.method === "POST" &&
        request.url === "https://auth.openai.com/oauth/token") {
      refreshCalls++;
      tokenEntered.resolve();
      await tokenReleased.promise;
      return Response.json({
        access_token: token(2), refresh_token: "offline-owned-refresh-rotated",
        expires_in: 3600,
      });
    }
    throw new Error("Offline auth fixture refuses this network operation");
  }, { preconnect: originalFetch.preconnect });
  manager = await AuthManager.create(root, () => {}, {
    singleInferenceDispatch: true, reasoning: "low",
  });
  await manager.refreshModels();
  assert.equal(manager.snapshot().status, "ready");
  assert.ok(storage);
  const selected = storage.credentials.list(provider).find(row =>
    row.credential.type === "oauth" && row.credential.accountId === "owned-account");
  assert.ok(selected);
  const keys = storage.keys;
  // A configured runtime bearer must never escape the selected-account grant.
  keys.setRuntime(provider, "offline-ambient-sentinel");
  const actualResolver = keys.resolver.bind(keys);

  if (scenario === "provenance") {
    const session = manager.createInferenceSession({ modelId, consumer: inertConsumer });
    assert.equal(session.thinkingLevel, Effort.Low);
    assert.equal(session.singleInferenceDispatch, true);
    assert.equal(typeof session.streamFn, "function");
    const actual = await session.getApiKey(session.model)(initial);
    assert.equal(actual.credentialId, selected.id);
    assert.equal(actual.apiKey, token(1));
    const provenance: ResolvedApiKey = {
      ...actual, afterSiblingWait: true,
      oauthIdentity: { orgId: "offline-org", region: "eu", inferenceRegion: "eu" },
    };
    let observedContext: ApiKeyResolveContext | undefined;
    keys.resolver = () => context => { observedContext = context; return provenance; };
    const context: ApiKeyResolveContext = {
      lastChance: true, error: new Error("Offline retry"), previousKey: actual.apiKey,
    };
    assert.strictEqual(await session.getApiKey(session.model)(context), provenance);
    assert.equal(observedContext?.lastChance, true);
    assert.strictEqual(observedContext?.error, context.error);
    assert.equal(observedContext?.previousKey, actual.apiKey);
    assert.equal(observedContext?.signal, undefined);
    for (const field of ["provider", "id", "api", "baseUrl"] as const)
      assert.throws(() => session.getApiKey({ ...session.model, [field]: "wrong-scope" }));
    for (const invalid of [
      undefined, "offline-ambient-bearer",
      { apiKey: "offline-wrong-row", credentialId: selected.id + 100 },
      { apiKey: "", credentialId: selected.id },
    ] satisfies ApiKeyResolution[]) {
      keys.resolver = () => () => invalid;
      await assert.rejects(session.getApiKey(session.model)(initial));
    }
    const late = Promise.withResolvers<ResolvedApiKey>();
    keys.resolver = () => () => late.promise;
    const requested = { ...session.model };
    const pending = session.getApiKey(requested)(initial);
    requested.baseUrl = "https://invalid.example";
    late.resolve(provenance);
    await assert.rejects(pending);
    // A captured resolver must not revive a closed grant or consult the cascade.
    const retained = session.getApiKey(session.model);
    session.cancel();
    assert.equal(session.signal.aborted, true);
    assert.throws(() => session.getApiKey(session.model));
    await assert.rejects(retained(initial));
    await session.close();
    let consulted = false;
    keys.resolver = () => () => { consulted = true; return provenance; };
    await assert.rejects(retained(initial));
    assert.equal(consulted, false);
    assert.throws(() => session.getApiKey(session.model));
    await session.close();
  } else if (scenario === "close" || scenario === "logout" || scenario === "models") {
    const lateAllocation = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const resolving = Promise.withResolvers<ResolvedApiKey>();
    let revoked = false, drained = false, resolved = false, released = false;
    let drainCalls = 0;
    const consumer: InferenceSessionConsumer = {
      revoke() { revoked = true; },
      async drain() {
        drainCalls++;
        await lateAllocation.promise;
        // A remote child/transport can finish allocating after revocation.
        assert.equal(revoked, true);
        await cleanup.promise;
        drained = true;
      },
    };
    keys.resolver = () => async () => {
      const key = await resolving.promise;
      resolved = true;
      return key;
    };
    const session = manager.createInferenceSession({ modelId, consumer });
    const resolver = session.getApiKey(session.model);
    const caller = new AbortController();
    const pending = resolver({ ...initial, signal: caller.signal });
    caller.abort();
    await assert.rejects(pending);
    const unrestrict = storage.sessions.unrestrict.bind(storage.sessions);
    storage.sessions.unrestrict = (...args) => {
      assert.equal(resolved, true);
      assert.equal(drained, true);
      released = true;
      return unrestrict(...args);
    };
    let closed = false, reentrantClose: Promise<void> | undefined;
    if (scenario === "close")
      session.signal.addEventListener("abort", () => {
        reentrantClose = manager!.close();
      }, { once: true });
    // Direct OAuth discovery deliberately refuses any runtime bearer override.
    // Keep that separate from the session's selected-account fallback checks.
    if (scenario === "models") keys.removeRuntime(provider);
    const stopping = scenario === "close" ? manager.close() :
      scenario === "logout" ? manager.logout() : manager.refreshModels();
    const closing = stopping.then(() => { closed = true; });
    if (scenario === "close") assert.strictEqual(reentrantClose, stopping);
    assert.equal(session.signal.aborted, true);
    assert.equal(revoked, true);
    assert.throws(() => session.getApiKey(session.model));
    await assert.rejects(resolver(initial));
    await turns();
    assert.equal(closed, false);
    assert.equal(released, false);
    resolving.resolve({ apiKey: token(1), credentialId: selected.id });
    await turns();
    assert.equal(closed, false);
    lateAllocation.resolve();
    await turns();
    assert.equal(closed, false);
    cleanup.resolve();
    await closing;
    assert.equal(released, true);
    assert.equal(drainCalls, 1);
    await session.close();
    if (scenario === "logout") assert.equal(manager.snapshot().authenticated, false);
    if (scenario === "models") {
      assert.equal(manager.snapshot().status, "ready");
      const next = manager.createInferenceSession({ modelId, consumer: inertConsumer });
      await next.close();
    }
  } else if (scenario === "refresh") {
    const session = manager.createInferenceSession({ modelId, consumer: inertConsumer });
    const resolver = session.getApiKey(session.model);
    const first = await resolver(initial);
    const caller = new AbortController();
    const refreshing = resolver({
      lastChance: false, error: Object.assign(new Error("Offline 401"), { status: 401 }),
      previousKey: first.apiKey, signal: caller.signal,
    });
    await tokenEntered.promise;
    caller.abort();
    await assert.rejects(refreshing);
    let closed = false, unrestricted = false;
    const unrestrict = storage.sessions.unrestrict.bind(storage.sessions);
    storage.sessions.unrestrict = (...args) => {
      const row = storage!.credentials.list(provider).find(row => row.id === selected.id);
      assert.ok(row?.credential.type === "oauth");
      assert.equal(row.credential.refresh, "offline-owned-refresh-rotated");
      unrestricted = true;
      return unrestrict(...args);
    };
    const closing = manager.close().then(() => { closed = true; });
    await turns();
    assert.equal(closed, false);
    assert.equal(unrestricted, false);
    tokenReleased.resolve();
    await closing;
    assert.equal(refreshCalls, 1);
    assert.equal(unrestricted, true);
    await assert.rejects(resolver(initial));
    const persisted = await originalCreate(database);
    try {
      await persisted.credentials.reload();
      const rows = persisted.credentials.list(provider);
      const owned = rows.find(row => row.id === selected.id);
      assert.ok(owned?.credential.type === "oauth");
      assert.equal(owned.credential.refresh, "offline-owned-refresh-rotated");
      const sibling = rows.find(row => row.id !== selected.id);
      assert.ok(sibling?.credential.type === "oauth");
      assert.equal(sibling.credential.refresh, "offline-sibling-refresh");
    } finally { persisted.close(); }
  } else if (scenario === "row") {
    const session = manager.createInferenceSession({ modelId, consumer: inertConsumer });
    const resolver = session.getApiKey(session.model);
    const pendingKey = Promise.withResolvers<ResolvedApiKey>();
    keys.resolver = () => () => pendingKey.promise;
    const pending = session.getApiKey(session.model)(initial);
    assert.ok(selected.credential.type === "oauth");
    const replacement = {
      ...selected.credential,
      accountId: "replacement-account", access: token(9, "replacement-account"),
    };
    // Simulate a same-row identity replacement at the credential-store seam.
    // No private AuthManager state or guessed SQLite schema is involved.
    const list = storage.credentials.list.bind(storage.credentials);
    storage.credentials.list = requestedProvider => list(requestedProvider).map(row =>
      row.id === selected.id ? {
        ...row,
        credential: replacement,
      } : row);
    pendingKey.resolve({ apiKey: token(1), credentialId: selected.id });
    await assert.rejects(pending);
    await assert.rejects(resolver(initial));
    await session.close();
  } else if (scenario === "agent") {
    const creating = manager.createAgent({ modelId, systemPrompt: [], tools: [] });
    const closing = manager.close();
    const agent = await creating;
    assert.ok(agent instanceof Agent);
    await closing;
    assert.throws(() => agent.getApiKey?.(agent.state.model));
    await manager.releaseAgent(agent);
    await manager.releaseAgent(agent);
  } else throw new Error("Unknown auth fixture scenario");
  keys.resolver = actualResolver;
  await manager.close();
  console.log("ok");
} finally {
  tokenReleased.resolve();
  await manager?.close();
  AuthStorage.create = originalCreate;
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
