import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { StreamFn } from "@oh-my-pi/pi-agent-core/types";
import { streamSimple, type AssistantMessage, type RawSseEvent, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { AuthManager } from "../src/server/auth.ts";
import { ProviderUsageCollector } from "../src/server/provider-usage.ts";
import { singleDispatchCodexStream } from "../src/server/evaluation-inference.ts";

// The explicit baseline executes the same actual SDK/server/assertions before
// the host fence exists. It is not used by the application or the green run.
async function evaluationStream(): Promise<StreamFn> {
  if (process.env.GAMEHARNESS_SINGLE_DISPATCH_BASELINE === "1") return streamSimple;
  return singleDispatchCodexStream;
}
const fakeToken = (revision: number) => `local.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "loopback-account" }, revision,
})).toString("base64url")}.not-a-real-signature`;
const frame = (value: Record<string, unknown>) => `data: ${JSON.stringify(value)}\n\n`;
const item = { id: "local-message", type: "message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "Local streamed answer", annotations: [] }] };
function success() {
  return new Response([
    frame({ type: "response.created", response: { id: "local-response", status: "in_progress" } }),
    frame({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
    frame({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } }),
    frame({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Local streamed answer" }),
    frame({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Local streamed answer" }),
    frame({ type: "response.output_item.done", output_index: 0, item }),
    frame({ type: "response.completed", response: { id: "local-response", status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

for (const reasoning of [undefined, "low"] as const)
  test(`authenticated Sol serializes ${reasoning ?? "unchanged backend-default"} reasoning without network`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "gameharness-auth-reasoning-"));
    await mkdir(join(directory, "auth"), { mode: 0o700 });
    const storage = await AuthStorage.create(join(directory, "auth/gameharness.sqlite"));
    try {
      await storage.credentials.set("openai-codex", { type: "oauth", access: fakeToken(1),
        refresh: "local-unused-refresh", expires: Date.now() + 3_600_000, accountId: "loopback-account" });
    } finally { storage.close(); }
    const requests: Array<{ account: string | null; body: Record<string, unknown> }> = [];
    const mockedFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/models"))
        return Response.json({ models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol",
          context_window: 500_000, default_reasoning_level: "medium",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
          input_modalities: ["text", "image"], prefer_websockets: false }] });
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses"))
        throw new Error("Offline reasoning test refuses all other requests");
      const bytes = new Uint8Array(await request.arrayBuffer());
      const decoded = request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
      requests.push({ account: request.headers.get("chatgpt-account-id"),
        body: JSON.parse(new TextDecoder().decode(decoded)) });
      return success();
    }, { preconnect: globalThis.fetch.preconnect }));
    let auth: AuthManager | undefined;
    try {
      auth = await AuthManager.create(directory, () => {}, { singleInferenceDispatch: true, reasoning });
      await auth.refreshModels();
      expect(auth.snapshot().status).toBe("ready");
      const agent = await auth.createAgent({ modelId: "gpt-6.1-sol", systemPrompt: ["Offline serialization proof"], tools: [] });
      expect(agent.state.thinkingLevel).toBe(reasoning ? Effort.Low : undefined);
      await agent.prompt("Offline request only");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.account).toBe("loopback-account");
      expect(requests[0]?.body.model).toBe("gpt-6.1-sol");
      if (reasoning) expect(requests[0]?.body.reasoning).toMatchObject({ effort: "low" });
      else expect(requests[0]?.body).not.toHaveProperty("reasoning");
    } finally {
      await auth?.close();
      mockedFetch.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

function streamFailure(partial: boolean) {
  const frames = [frame({ type: "response.created", response: { id: "failed-response", status: "in_progress" } })];
  if (partial) frames.push(
    frame({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
    frame({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } }),
    frame({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Partial local output" }),
  );
  frames.push(frame({ type: "response.failed", response: { id: "failed-response", status: "failed",
    error: { code: "server_error", message: "Local retryable stream failure" } } }));
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
async function fixture(respond: (request: Request, ordinal: number) => Response | Promise<Response>,
  options: { bounded?: boolean; rotate?: boolean; streamOptions?: SimpleStreamOptions } = {}) {
  const requests: Array<{ account: string | null; body: Record<string, unknown>; marker: string | null }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    requests.push({ account: request.headers.get("chatgpt-account-id"), body, marker: request.headers.get("x-local-marker") });
    return respond(request, requests.length);
  } });
  const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Installed catalog lacks offline Codex descriptor");
  const model = { ...getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id),
    baseUrl: `http://127.0.0.1:${server.port}/codex/responses`, preferWebsockets: false };
  const stream = options.bounded === false ? streamSimple : await evaluationStream();
  const usage = new ProviderUsageCollector("loopback-admission");
  const wireEvents: RawSseEvent[] = [];
  let resolutions = 0, delegatedFetches = 0;
  const agent = new Agent({ initialState: { model }, getApiKey: () => async () => ({
    apiKey: fakeToken(options.rotate ? ++resolutions : (resolutions++, 1)), credentialId: 17,
  }), streamFn: (model, context, sdkOptions) => stream(model, context, {
    ...sdkOptions, ...options.streamOptions, headers: { "x-local-marker": "preserved" },
    fetch: async (input, init) => {
      delegatedFetches++;
      if (new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname !== "127.0.0.1")
        throw new Error("Test refuses non-loopback HTTP");
      return fetch(input, init);
    }, onSseEvent: (event, eventModel) => {
      wireEvents.push(event);
      usage.observe(event, eventModel ?? model);
    },
  }) });
  const messages: AssistantMessage[] = [];
  let streamedText = "";
  agent.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      streamedText += event.assistantMessageEvent.delta;
    if (event.type === "message_end" && event.message.role === "assistant") messages.push(event.message);
  });
  return { agent, requests, messages, usage, wireEvents, get resolutions() { return resolutions; },
    get delegatedFetches() { return delegatedFetches; }, get streamedText() { return streamedText; },
    async close() { agent.abort("Local test cleanup"); await agent.waitForIdle(); await server.stop(true); } };
}

for (const status of [503, 429]) test(`evaluation terminates HTTP ${status} without a second inference dispatch`, async () => {
  const f = await fixture((_request, ordinal) => ordinal === 1 ? Response.json({ error: {
    code: status === 429 ? "rate_limit_exceeded" : "server_error", message: "Local first failure",
  } }, { status, headers: { "retry-after-ms": "1" } }) : success());
  try {
    await f.agent.prompt("Loopback request only");
    expect(f.requests).toHaveLength(1);
    expect(f.delegatedFetches).toBe(1);
    expect(f.messages.at(-1)).toMatchObject({ stopReason: "error", errorStatus: status, credentialId: 17 });
    expect(f.messages.at(-1)?.errorMessage).toContain(status === 429 ? "rate limit" : "Local first failure");
    expect(f.messages.at(-1)?.errorMessage).toContain("retry-after-ms=1");
    expect(f.usage.finish(f.messages.at(-1) ?? null).provider_terminal).toBeNull();
    expect(f.requests[0]?.account).toBe("loopback-account");
  } finally { await f.close(); }
}, 15000);

for (const partial of [false, true]) test(`evaluation stream failure ends request (${partial ? "partial output" : "before output"})`, async () => {
  const f = await fixture((_request, ordinal) => ordinal === 1 ? streamFailure(partial) : success());
  try {
    await f.agent.prompt("Loopback request only");
    expect(f.requests).toHaveLength(1);
    expect(f.delegatedFetches).toBe(1);
    expect(f.messages.at(-1)).toMatchObject({ stopReason: "error", credentialId: 17 });
    expect(f.messages.at(-1)?.errorMessage).toContain("Local retryable stream failure");
    expect(f.messages.at(-1)?.errorClassificationMessage).toBe("server_error");
    expect(f.usage.finish(f.messages.at(-1) ?? null).provider_terminal).toBeNull();
    if (partial) expect(f.streamedText).toContain("Partial local output");
  } finally { await f.close(); }
}, 15000);

test("evaluation authenticates once and refuses resolver-driven HTTP replay", async () => {
  const f = await fixture((_request, ordinal) => ordinal === 1 ? Response.json({ error: {
    code: "invalid_api_key", message: "Local expired token",
  } }, { status: 401 }) : success(), { rotate: true });
  try {
    await f.agent.prompt("Loopback request only");
    expect(f.requests).toHaveLength(1);
    expect(f.resolutions).toBe(1);
    expect(f.messages.at(-1)).toMatchObject({ stopReason: "error", errorStatus: 401, credentialId: 17 });
    expect(f.messages.at(-1)?.errorMessage).toContain("Local expired token");
    expect(f.requests.every(request => request.account === "loopback-account")).toBe(true);
  } finally { await f.close(); }
}, 15000);

test("evaluation provider failure rejects completed tool calls without another logical admission", async () => {
  const call = { type: "function_call", id: "local-tool-item", call_id: "local-observe-call",
    name: "observe", arguments: "{}", status: "completed" };
  const f = await fixture((_request, ordinal) => ordinal !== 1 ? success() : new Response([
    frame({ type: "response.created", response: { id: "failed-tool-response", status: "in_progress" } }),
    frame({ type: "response.output_item.added", output_index: 0,
      item: { ...item, status: "in_progress", content: [] } }),
    frame({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } }),
    frame({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0,
      delta: "Partial before failed tool" }),
    frame({ type: "response.output_item.added", output_index: 1,
      item: { ...call, status: "in_progress", arguments: "" } }),
    frame({ type: "response.function_call_arguments.delta", item_id: call.id, output_index: 1, delta: "{}" }),
    frame({ type: "response.function_call_arguments.done", item_id: call.id, output_index: 1, arguments: "{}" }),
    frame({ type: "response.output_item.done", output_index: 1, item: call }),
    frame({ type: "response.failed", response: { id: "failed-tool-response", status: "failed",
      error: { code: "stream_read_error", message: "Local provider stream_read_error after completed tool" } } }),
  ].join(""), { headers: { "content-type": "text/event-stream" } }));
  let effects = 0, admissions = 0;
  f.agent.setTools([{ name: "observe", label: "observe", description: "Count a real local test tool effect",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    execute: async () => { effects++; return { content: [{ type: "text", text: "Local tool ran" }], details: {} }; } }]);
  f.agent.setBeforeModelCall(() => { admissions++; });
  try {
    await f.agent.prompt("Loopback request only");
    expect(effects).toBe(0);
    expect(admissions).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(f.delegatedFetches).toBe(1);
    expect(f.messages.at(-1)).toMatchObject({ stopReason: "error", credentialId: 17,
      errorClassificationMessage: "stream_read_error" });
    expect(f.messages.at(-1)?.errorMessage).toContain("Local provider stream_read_error after completed tool");
    expect(f.messages.at(-1)?.errorId).toBeGreaterThan(0);
    expect(f.messages.at(-1)?.errorStatus).toBeUndefined();
    expect(f.streamedText).toContain("Partial before failed tool");
    expect(f.messages.at(-1)?.content.some(block => block.type === "toolCall")).toBe(false);
    expect(f.messages.at(-1)?.stopDetails?.explanation).toContain("Evaluation rejected unexecuted tool calls");
    const raw = f.wireEvents.map(event => JSON.parse(event.data));
    expect(raw.find(event => event.type === "response.output_item.done")?.item).toMatchObject({
      type: "function_call", call_id: "local-observe-call", name: "observe", arguments: "{}",
    });
    expect(raw.find(event => event.type === "response.failed")?.response.error.code).toBe("stream_read_error");
    expect(f.usage.finish(f.messages.at(-1) ?? null).provider_terminal).toBeNull();
  } finally { await f.close(); }
}, 15000);

test("evaluation preserves successful streamed output, caller fetch and headers across independent admissions", async () => {
  const f = await fixture(() => success());
  try {
    await f.agent.prompt("First loopback request");
    await f.agent.prompt("Second independent loopback request");
    expect(f.requests).toHaveLength(2);
    expect(f.delegatedFetches).toBe(2);
    expect(f.messages.map(message => message.stopReason)).toEqual(["stop", "stop"]);
    expect(f.streamedText).toBe("Local streamed answerLocal streamed answer");
    expect(f.requests.every(request => request.marker === "preserved" && request.account === "loopback-account")).toBe(true);
  } finally { await f.close(); }
}, 15000);

test("ordinary SDK route retains its retry semantics", async () => {
  const f = await fixture((_request, ordinal) => ordinal === 1 ? Response.json({ error: {
    code: "server_error", message: "Local ordinary transient failure",
  } }, { status: 503, headers: { "retry-after-ms": "1" } }) : success(), { bounded: false });
  try {
    await f.agent.prompt("Loopback request only");
    expect(f.requests).toHaveLength(2);
    expect(f.messages.at(-1)?.stopReason).toBe("stop");
    expect(f.streamedText).toBe("Local streamed answer");
  } finally { await f.close(); }
}, 15000);

for (const status of [307, 308]) test(`evaluation refuses HTTP ${status} inference redirects`, async () => {
  const f = await fixture((request, ordinal) => ordinal === 1
    ? Response.json({ error: { code: "redirect_refused", message: "Local inference redirect" } },
      { status, headers: { location: new URL("/redirected-inference", request.url).href } })
    : success());
  try {
    await f.agent.prompt("Loopback request only");
    expect(f.requests).toHaveLength(1);
    expect(f.delegatedFetches).toBe(1);
    expect(f.messages.at(-1)).toMatchObject({ stopReason: "error", errorStatus: status, credentialId: 17 });
    expect(f.messages.at(-1)?.errorMessage).toContain("Local inference redirect");
  } finally { await f.close(); }
}, 15000);

test("evaluation fences post-stream recovery when a response ends without a terminal frame", async () => {
  const f = await fixture((_request, ordinal) => ordinal === 1
    ? new Response(frame({ type: "response.created", response: { id: "truncated-response", status: "in_progress" } }),
      { headers: { "content-type": "text/event-stream" } })
    : success());
  try {
    await f.agent.prompt("Loopback request only");
    expect(f.requests).toHaveLength(1);
    expect(f.delegatedFetches).toBe(1);
    expect(f.messages.at(-1)?.stopReason).toBe("error");
    // The SDK does not expose its initial EOF error through onSseEvent.
    // Retain an explicit rejected-recovery error, not invented provider status.
    expect(f.messages.at(-1)?.errorStatus).toBeUndefined();
    expect(f.messages.at(-1)?.errorMessage).toContain("recovery replay refused");
    expect(f.messages.at(-1)?.errorClassificationMessage).toBe("host_recovery_replay_refused");
    expect(f.usage.finish(f.messages.at(-1) ?? null).provider_terminal).toBeNull();
  } finally { await f.close(); }
}, 15000);

test("evaluation cancellation joins the active HTTP stream without replay", async () => {
  const opened = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>();
  const f = await fixture(request => {
    request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ type: "response.created", response: { id: "cancelled-response", status: "in_progress" } })));
      opened.resolve();
    }, cancel() { cancelled.resolve(); } }), { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const prompt = f.agent.prompt("Loopback request only");
    await opened.promise;
    f.agent.abort("Operator cancelled local request");
    await prompt;
    await f.agent.waitForIdle();
    await cancelled.promise;
    expect(f.requests).toHaveLength(1);
    expect(f.messages.at(-1)?.stopReason).toBe("aborted");
  } finally { await f.close(); }
}, 10000);

test("evaluation rejects conflicting websocket environment before inference", async () => {
  const f = await fixture(() => success());
  const previous = process.env.PI_CODEX_WEBSOCKET;
  process.env.PI_CODEX_WEBSOCKET = "1";
  try {
    await f.agent.prompt("Loopback request only");
    expect(f.requests).toHaveLength(0);
    expect(f.messages.at(-1)?.stopReason).toBe("error");
    expect(f.messages.at(-1)?.errorMessage).toContain("PI_CODEX_WEBSOCKET");
  } finally {
    if (previous === undefined) delete process.env.PI_CODEX_WEBSOCKET;
    else process.env.PI_CODEX_WEBSOCKET = previous;
    await f.close();
  }
}, 15000);
