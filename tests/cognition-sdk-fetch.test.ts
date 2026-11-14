import { afterEach, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { InferenceSessionConsumer, SelectedAccountInferenceSession } from "../src/server/auth-session.ts";
import { CognitionClient } from "../src/server/cognition-client.ts";
import { InlineCognitionContext } from "../src/server/cognition-context.ts";
import { StrategicPlanner, type StrategicRequestAdmission } from "../src/server/strategic.ts";
import { deferred, eventLoopTurn, passiveHostFixture } from "./helpers/cognition-process.fixture.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = `local.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "offline-fetch-admission" },
})).toString("base64url")}.not-a-signature`;
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function success() {
  const item = { id: "offline-message", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Offline infrastructure response", annotations: [] }] };
  return new Response([
    frame({ type: "response.created", response: { id: "offline-response", status: "in_progress" } }),
    frame({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
    frame({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } }),
    frame({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Offline infrastructure response" }),
    frame({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Offline infrastructure response" }),
    frame({ type: "response.output_item.done", output_index: 0, item }),
    frame({ type: "response.completed", response: { id: "offline-response", status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

type Mode = "remote" | "embedded";
type Hook = NonNullable<StrategicRequestAdmission["beforeSdkFetch"]>;
async function fixture(mode: Mode, hook?: Hook, retry = false) {
  const f = passiveHostFixture();
  const received: Request[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    received.push(request);
    return retry && received.length === 1
      ? Response.json({ error: { code: "server_error", message: "Offline retryable response" } },
        { status: 503, headers: { "retry-after-ms": "1" } })
      : success();
  } });
  const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Installed SDK lacks the offline Codex descriptor");
  const model = { ...getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id),
    baseUrl: `http://127.0.0.1:${server.port}/codex/responses`, preferWebsockets: false };
  f.run.model_id = model.id; f.store.saveRun(f.run);
  const reservations: string[] = [], transports: string[] = [], drains: string[] = [];
  f.host.requestAdmission = {
    reserve: id => { reservations.push(id); }, transportEnded: id => { transports.push(id); },
    drained: ids => { drains.push(...ids); }, ...(hook ? { beforeSdkFetch: hook } : {}),
  };
  const finished = deferred();
  const paused = deferred();
  const pause = f.host.pause.bind(f.host);
  f.host.pause = (message, cause) => { pause(message, cause); paused.resolve(); };
  const unsubscribe = f.store.subscribe(event => {
    if (event.type === "scheduler.turn_finished") finished.resolve();
  });
  let owner: CognitionClient | StrategicPlanner;
  if (mode === "remote") {
    const controller = new AbortController();
    let consumer: InferenceSessionConsumer | undefined, closing: Promise<void> | undefined;
    const cancel = () => { controller.abort(); consumer?.revoke(); };
    const session: SelectedAccountInferenceSession = {
      sessionId: "offline-sdk-fetch", model, thinkingLevel: undefined,
      singleInferenceDispatch: false, streamFn: undefined, signal: controller.signal,
      getApiKey: requested => {
        if (requested.id !== model.id || requested.api !== model.api || requested.provider !== model.provider)
          throw new Error("Unexpected selected model");
        return async () => ({ apiKey: token, credentialId: 1 });
      },
      cancel,
      close: () => { cancel(); return closing ??= Promise.resolve().then(() => consumer?.drain()); },
    };
    // No worker override: this runs the actual default planner/SDK process.
    owner = new CognitionClient(f.store, { createInferenceSession(options) { consumer = options.consumer; return session; } }, f.host);
  } else {
    owner = new StrategicPlanner(f.store, {
      createAgent: async options => new Agent({ sessionId: "offline-sdk-fetch", initialState: {
        model, systemPrompt: options.systemPrompt, tools: options.tools,
      }, getApiKey: () => async () => ({ apiKey: token, credentialId: 1 }) }),
      releaseAgent: async agent => { agent.abort(); await agent.waitForIdle(); },
    }, f.host, { context: new InlineCognitionContext(f.store.readLocation()) });
  }
  cleanup.push(async () => {
    await owner.close(); unsubscribe(); await server.stop(true); f.close();
  });
  await owner.start(1);
  return { ...f, owner, model, received, reservations, transports, drains,
    finished: finished.promise, paused: paused.promise };
}

// Loopback HTTP and the installed provider SDK only; no model, gameplay source,
// native adapter or real account is invoked by these infrastructure regressions.
for (const mode of ["remote", "embedded"] as const) {
  test(`${mode}: each genuine SDK transport retry has private admission under the same original request`, async () => {
    const admissions: { request: Parameters<Hook>[0]; deadline: bigint; signal: AbortSignal }[] = [];
    const f = await fixture(mode, async (request, options) => {
      expect(Object.keys(request).sort()).toEqual(["identity", "model"]);
      expect(Object.keys(request.model).sort()).toEqual(["api", "id", "provider"]);
      expect(Object.keys(options).sort()).toEqual(["deadlineOsNs", "signal"]);
      admissions.push({ request, deadline: options.deadlineOsNs, signal: options.signal });
    }, true);
    f.owner.wake("preflight_ready"); await f.finished;
    expect(f.received).toHaveLength(2);
    expect(admissions).toHaveLength(2);
    expect(admissions[0]!.request).toEqual(admissions[1]!.request);
    expect(admissions[0]!.deadline).toBe(admissions[1]!.deadline);
    expect(admissions[0]!.deadline.toString()).toBe(admissions[0]!.request.identity.deadline_os_ns);
    expect(admissions.every(admission => !admission.signal.aborted)).toBe(true);
    expect(admissions[0]!.request.model).toEqual({ id: f.model.id, provider: f.model.provider, api: f.model.api });
    expect(f.reservations).toEqual([admissions[0]!.request.identity.request_id]);
    expect(f.transports).toEqual(f.reservations);
    expect(f.run.turns).toBe(1);
    await f.owner.close(); expect(f.drains).toEqual(f.reservations);
  }, 20_000);

  test(`${mode}: a finite one-fetch cap refuses the actual SDK-internal retry before transport`, async () => {
    let attempts = 0;
    const f = await fixture(mode, async () => {
      if (++attempts > 1) throw new DOMException("Offline finite SDK fetch cap", "AbortError");
    }, true);
    f.owner.wake("preflight_ready"); await f.paused;
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(f.received).toHaveLength(1);
    expect(f.reservations).toHaveLength(1);
    expect(f.run.turns).toBe(1);
    await f.owner.close(); expect(f.drains).toEqual(f.reservations);
  }, 30_000);

  test(`${mode}: a late admission cannot fetch after original cancellation and close joins the callback`, async () => {
    const entered = deferred(), release = deferred();
    let signal: AbortSignal | undefined;
    const f = await fixture(mode, async (_request, options) => {
      signal = options.signal; entered.resolve(); await release.promise;
    });
    cleanup.push(() => release.resolve());
    f.owner.wake("preflight_ready"); await entered.promise;
    f.owner.fence();
    // Remote cancellation propagates over the actual private RPC channel.
    if (!signal!.aborted) {
      const aborted = deferred();
      signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
    }
    let closed = false;
    const closing = f.owner.close().then(() => { closed = true; });
    await eventLoopTurn();
    expect(closed).toBe(false); expect(f.received).toHaveLength(0);
    release.resolve(); await closing;
    expect(f.received).toHaveLength(0);
    expect(f.reservations).toHaveLength(1); expect(f.drains).toEqual(f.reservations);
  }, 20_000);

  test(`${mode}: no fetch hook leaves ordinary genuine SDK completion unchanged`, async () => {
    const f = await fixture(mode);
    f.owner.wake("preflight_ready"); await f.finished;
    expect(f.received).toHaveLength(1); expect(f.reservations).toHaveLength(1);
    expect(f.pauses).toEqual([]);
  }, 20_000);
}
