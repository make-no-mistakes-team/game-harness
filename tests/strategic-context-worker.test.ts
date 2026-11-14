import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { AuthManager } from "../src/server/auth.ts";
import { StrategicContext } from "../src/server/strategic-context.ts";
import { StrategicContextClient } from "../src/server/strategic-context-client.ts";
import { strategicContextAdapter, strategicContextScope, type ContextAssemblyInput } from "../src/server/strategic-context-protocol.ts";
import { StrategicPlanner } from "../src/server/strategic.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { osMonotonicNs } from "../src/server/os-monotonic.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter } from "./helpers/adapter-contract.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "strategic-context-worker-"));
  const store = new Store(directory), adapter = minecraftTestAdapter();
  const run = minecraftRunFixture(adapter), observation = minecraftObservationFixture(adapter);
  store.saveRun(run);
  cleanup.push(async () => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const input: ContextAssemblyInput = { scope: strategicContextScope(run), model: { api: "fixture-api", provider: "fixture-provider" },
    observation: { profile_id: observation.profile_id, profile_configuration_hash: observation.profile_configuration_hash },
    adapter: strategicContextAdapter(adapter) };
  return { store, adapter, run, observation, input };
}
const deadline = () => ({ deadlineOsNs: osMonotonicNs() + 5_000_000_000n });

async function retainedSource(store: Store, run: StoredRun) {
  return await store.registerSkill(run.run_id, { entry: "run", name: "Neutral retained source",
    source: 'return {status:"completed",summary:"SOURCE_KNOWLEDGE_MARKER",result:null};', dependencies: [],
    card: { purpose: "Context infrastructure fixture", applicability: "Offline only", method: "No effects",
      reason: "Retained knowledge", limitations: "Not gameplay evidence" },
    validation: { runtime_version: 5, api_version: 5, validator_version: 5, compatibility_hash: run.compatibility_hash!,
      fingerprint: "fixture", formatted_lines: 1, complexity: 1, nesting: 0 } });
}

test("actual readonly reducer retains help, exact source and no-replay custody through joined reopen", async () => {
  const f = fixture(), source = await retainedSource(f.store, f.run);
  const unknown = f.store.event(f.run.run_id, "runtime.uncertainty", "UNKNOWN_EFFECT_MARKER", {
    action_id: "unconfirmed-fixture-operation", world_id: f.run.world_id, session_id: f.run.session_id,
    life_id: f.run.life_id, native_boot_id: f.run.native_boot_id, space_epoch: f.run.space_epoch,
  });
  const client = new StrategicContextClient(f.store.readLocation());
  cleanup.push(() => client.close());
  await client.assemble(f.input, deadline());
  client.rememberHelp("programs", { mechanics: { contract: "EXACT_RETAINED_HELP_MARKER" } });
  client.selectProgram(source.name, source.version);
  const result = JSON.parse(await client.assemble(f.input, deadline())).strategic_context;
  expect(client.snapshot().worker_pid).not.toBe(process.pid);
  expect(result.requested_help).toContainEqual(expect.objectContaining({ topic: "programs", content: { contract: "EXACT_RETAINED_HELP_MARKER" } }));
  expect(result.programs).toContainEqual(expect.objectContaining({ name: source.name, version: source.version, hash: source.hash, source: source.source }));
  expect(result.unresolved).toContainEqual(expect.objectContaining({ event_seq: unknown.event_seq, no_replay: true,
    historical: true, current_authority: false, original_scope: expect.objectContaining({ life_id: f.run.life_id }) }));
  expect(Buffer.byteLength(JSON.stringify({ strategic_context: result }))).toBeLessThanOrEqual(32768);
  await client.close();
  expect(client.snapshot().child_pid).toBeNull();
  client.open();
  const reopened = JSON.parse(await client.assemble(f.input, deadline())).strategic_context;
  expect(reopened.requested_help).toEqual(result.requested_help);
  expect(reopened.programs).toEqual(result.programs);
  expect(reopened.unresolved).toEqual(result.unresolved);
  const providerChanged = JSON.parse(await client.assemble({ ...f.input, model: { ...f.input.model, provider: "changed-provider" } }, deadline())).strategic_context;
  expect(providerChanged.programs).toEqual(result.programs);
  expect(providerChanged.unresolved).toEqual(result.unresolved);
  expect(providerChanged.requested_help).toEqual([]);
});

test("worker preserves source knowledge floor instead of resurrecting old task source on reopen", async () => {
  const f = fixture(), source = await retainedSource(f.store, f.run), client = new StrategicContextClient(f.store.readLocation());
  cleanup.push(() => client.close());
  const original = JSON.parse(await client.assemble(f.input, deadline())).strategic_context;
  expect(original.programs.some((entry: { hash: string }) => entry.hash === source.hash)).toBe(true);
  f.run.task = "Replacement infrastructure task"; f.store.saveRun(f.run);
  const changed = { ...f.input, scope: strategicContextScope(f.run) };
  expect(JSON.parse(await client.assemble(changed, deadline())).strategic_context.programs).toEqual([]);
  await client.close(); client.open();
  expect(JSON.parse(await client.assemble(changed, deadline())).strategic_context.programs).toEqual([]);
});

function plannerFixture() {
  const f = fixture();
  const descriptor = getBundledModels("openai-codex").find(value => value.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Installed offline model descriptor unavailable");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  f.run.model_id = model.id; f.store.saveRun(f.run);
  const requests: Context[] = [];
  const state = { pending: false };
  let helpRequested = true, root = "Neutral infrastructure root", generation = 1;
  const streamFn: StreamFn = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify(context)));
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: helpRequested ? [{ type: "toolCall", id: "fixture-help", name: "help", arguments: { topic: "programs" } }] : [],
      stopReason: helpRequested ? "toolUse" : "stop", timestamp: 0,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    helpRequested = false;
    const events = new AssistantMessageEventStream();
    events.push({ type: "start", partial: message });
    events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    events.end(); return events;
  };
  const help: AgentTool = { name: "help", label: "help", description: "Read a passive fixture contract",
    parameters: { type: "object", properties: { topic: { type: "string" } } },
    execute: async () => ({ content: [], details: { fixture_contract: "ORDINARY_CONSUMER_HELP_MARKER" } }) };
  const auth = { createAgent: async (options: Parameters<AuthManager["createAgent"]>[0]) => new Agent({
    initialState: { model, systemPrompt: options.systemPrompt, tools: options.tools }, streamFn, getApiKey: () => "OFFLINE_ONLY" }),
    releaseAgent: async (agent: Agent) => { agent.abort(); await agent.waitForIdle(); } } as unknown as AuthManager;
  const planner = new StrategicPlanner(f.store, auth, {
    run: () => f.run, generation: () => generation,
    assertCurrent: value => { if (generation !== value || f.run.status !== "running") throw new RuntimeFault("stale_context", "Fixture revoked"); return f.run; },
    tools: () => [help], rootPrompt: () => root, adapter: () => f.adapter,
    observe: async () => f.observation, projectObservation: observation => f.adapter.projectObservation(observation),
    policies: () => [], action: () => null, programPending: () => state.pending, busy: () => true,
    persist: () => f.store.saveRun(f.run), pause: () => { f.run.status = "paused"; planner.fence(); },
    terminal: () => { throw new Error("No terminal transition expected"); },
  });
  cleanup.push(() => planner.close());
  const turn = () => {
    const done = Promise.withResolvers<void>();
    const off = f.store.subscribe(event => {
      if (event.run_id !== f.run.run_id) return;
      if (["scheduler.turn_finished", "scheduler.turn_failed"].includes(event.type)) { off(); done.resolve(); }
    });
    planner.wake("policy_replan"); return done.promise;
  };
  return { ...f, state, planner, requests, turn, replaceRoot: () => { root = "Changed root prose"; generation++; },
    revokeGeneration: () => { generation++; } };
}
function retained(context: Context | undefined) {
  for (const text of context?.systemPrompt ?? []) {
    try { const value = JSON.parse(text); if (value.strategic_context) return value.strategic_context; } catch { /* Other root prose. */ }
  }
  throw new Error("Actual provider consumer did not receive strategic context");
}

test("ordinary default planner consumes real offloop retained knowledge across agent replacement", async () => {
  const f = plannerFixture(), source = await retainedSource(f.store, f.run);
  // A parent-loop fallback would hit this trap; the child imports its own reducer.
  const original = StrategicContext.prototype.assemble;
  StrategicContext.prototype.assemble = () => { throw new Error("Parent reducer must not execute"); };
  try {
    await f.planner.start(1); await f.turn();
    expect(f.requests).toHaveLength(2);
    const before = retained(f.requests.at(-1));
    expect(JSON.stringify(before.requested_help)).toContain("ORDINARY_CONSUMER_HELP_MARKER");
    expect(before.programs).toContainEqual(expect.objectContaining({ hash: source.hash, source: source.source }));
    await f.planner.close(); f.replaceRoot();
    await f.planner.start(2); await f.turn();
    const after = retained(f.requests.at(-1));
    expect(after.requested_help).toEqual(before.requested_help);
    expect(after.programs).toEqual(before.programs);
  } finally { StrategicContext.prototype.assemble = original; }
});

for (const change of ["fence", "generation", "role"] as const) {
  test(`default planner never publishes a completed worker context after ${change} changes during await`, async () => {
    const f = plannerFixture(), ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const source = change === "role" ? await retainedSource(f.store, f.run) : null;
    const original = StrategicContextClient.prototype.assemble;
    StrategicContextClient.prototype.assemble = async function(input, options) {
      const context = await original.call(this, input, options);
      ready.resolve(); await release.promise; return context;
    };
    try {
      await f.planner.start(1); f.planner.wake("policy_replan"); await ready.promise;
      if (change === "fence") f.planner.fence();
      else if (change === "generation") f.revokeGeneration();
      else {
        f.store.admitSkill(f.run.run_id, { entry: "run", skill_id: source!.skill_id, version: source!.version,
          start_key: "foreground-during-context-await", ...executionScopeFixture(f.run), args: {},
          limits: { duration_ms: 10000, max_actions: 1, max_calls: 1, max_depth: 1 } });
        f.state.pending = true;
      }
      release.resolve();
      // Let the actual request owner resume before Stop can add another fence.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.requests).toEqual([]);
      await f.planner.close();
    } finally { release.resolve(); StrategicContextClient.prototype.assemble = original; }
  });
}

test("closing joins active startup and rejects queued context without a late result", async () => {
  const f = fixture(), client = new StrategicContextClient(f.store.readLocation());
  cleanup.push(() => client.close());
  const first = client.assemble(f.input, deadline()), second = client.assemble(f.input, deadline());
  const results = Promise.allSettled([first, second]);
  await client.close();
  expect((await results).map(value => value.status)).toEqual(["rejected", "rejected"]);
  expect(client.snapshot()).toMatchObject({ closed: true, active: false, queued: 0, child_pid: null });
});

test("cancelled reducer cannot acknowledge and lose already eligible retained help", async () => {
  const f = fixture(), client = new StrategicContextClient(f.store.readLocation());
  cleanup.push(() => client.close());
  await client.assemble(f.input, deadline());
  client.rememberHelp("programs", { retained_contract: "UNACKNOWLEDGED_HELP_MARKER" });
  const controller = new AbortController();
  const pending = client.assemble(f.input, { ...deadline(), signal: controller.signal });
  const settlement = Promise.allSettled([pending]);
  controller.abort();
  expect((await settlement)[0]?.status).toBe("rejected");
  expect(client.snapshot().child_pid).toBeNull();
  await client.close(); client.open();
  const result = JSON.parse(await client.assemble(f.input, deadline())).strategic_context;
  expect(JSON.stringify(result.requested_help)).toContain("UNACKNOWLEDGED_HELP_MARKER");
});

test("invalid readonly binding fails closed and joins before rejection, without local fallback", async () => {
  const f = fixture(), client = new StrategicContextClient({
    ...f.store.readLocation(), projection: join(tmpdir(), `absent-context-projection-${crypto.randomUUID()}.sqlite`),
  });
  cleanup.push(() => client.close());
  await expect(client.assemble(f.input, deadline())).rejects.toMatchObject({ code: "backend_unavailable" });
  expect(client.snapshot()).toMatchObject({ active: false, queued: 0, child_pid: null });
});

test("expired original monotonic deadline never opens a worker", async () => {
  const f = fixture(), client = new StrategicContextClient(f.store.readLocation());
  cleanup.push(() => client.close());
  await expect(client.assemble(f.input, { deadlineOsNs: osMonotonicNs() - 1n })).rejects.toMatchObject({ code: "backend_unavailable" });
  expect(client.snapshot().child_pid).toBeNull();
});
