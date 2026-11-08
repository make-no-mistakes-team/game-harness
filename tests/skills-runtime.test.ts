import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import type { GameActionResult, GameBridge, Json, ObservationV3 } from "../src/shared/contracts.ts";
import type {
  SkillCapabilityRequest,
  SkillLimits,
  SkillRef,
  SkillResult,
} from "../src/shared/programs.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { SkillManager, type SkillHost } from "../src/server/skills.ts";
import {
  SkillCleanupError,
  type SandboxService,
} from "../src/server/sandbox.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { Runtime } from "../src/server/runtime.ts";
import type { AuthManager } from "../src/server/auth.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { instrumentProgram, ProgramTraceReceiver } from "../src/server/program-instrumentation.ts";
import { DEFAULT_EVALUATION_CAPS } from "../src/evaluation/config.ts";
import { ModelProgramEvidence } from "../src/evaluation/model-evidence.ts";
import { capabilityFailure } from "../src/server/program-diagnostics.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const adapter = minecraftTestAdapter();

const resources: { directory: string; store: Store; manager: SkillManager }[] =
  [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.manager.closeAll("Test complete").catch(() => {});
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});
function deferred<T>() {
  return Promise.withResolvers<T>();
}
const completed: SkillResult = {
  status: "completed",
  summary: "Measured fixture finished",
  result: null,
};
function abortableRunner(body: Runner): Runner {
  return async (source, args, handle, limits, signal, hooks) => {
    const aborted = deferred<never>();
    const abort = () => aborted.reject(new Error("Fixture worker authority revoked"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      return await Promise.race([body(source, args, handle, limits, signal, hooks), aborted.promise]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
}
const success: GameActionResult = {
  status: "succeeded",
  summary: "Confirmed bounded fixture action",
  evidence: { effect_confirmed: true },
};
type Runner = SandboxService["runSkill"];
// Real generated-worker protocol, without claiming Docker isolation or starting
// an external service. Only the transport below SkillManager is substituted.
const generatedWorker: Runner = async (source, args, handle, limits, signal, hooks) => {
  const program = instrumentProgram(source);
  const receiver = new ProgramTraceReceiver(program);
  hooks?.onInstrumentation?.(program);
  const worker = new Worker(new URL("../sandbox/worker.mjs", import.meta.url), {
    workerData: { mode: "skill", source: program.execution_source, source_hash: program.source_hash, args,
      api: hooks!.api,
      instrumentation: { hook_name: program.hook_name, scope: program.scope,
        kinds: program.points.map(point => point.kind) } },
    stdout: true, stderr: true,
  });
  const done = Promise.withResolvers<SkillResult>();
  const watchdog = AbortSignal.timeout(10000);
  const expired = () => done.reject(new Error("Generated worker did not complete its protocol"));
  watchdog.addEventListener("abort", expired, { once: true });
  signal?.addEventListener("abort", expired, { once: true });
  worker.on("error", done.reject);
  worker.on("exit", code => done.reject(new Error(`Generated worker exited before completion: ${code}`)));
  let calls = 0, actions = 0;
  worker.on("message", (encoded: string) => {
    void (async () => {
      const frame = JSON.parse(encoded);
      hooks?.onTrace?.(receiver.accept(frame.trace));
      if (frame.type === "skill_call") {
        try {
          const action = frame.request.kind === "action" || frame.request.kind === "respawn";
          // The real Docker transport can reject before the manager's broker:
          // its independent local limits are the remaining root budget at start.
          if (calls >= limits.max_calls || (action && actions >= limits.max_actions))
            throw hooks?.onCapabilityBudgetExceeded?.(frame.request) ??
              new Error("Worker transport capability budget exhausted");
          calls++;
          if (action) actions++;
          const value = await handle(frame.request);
          worker.postMessage({ v: 1, type: "skill_reply", id: frame.id, ok: true, value });
        } catch (error) {
          // Match the existing bounded public sandbox reply; never forward the
          // host exception or its stack to generated code.
          const failure = capabilityFailure(error);
          worker.postMessage({ v: 1, type: "skill_reply", id: frame.id, ok: false, error: failure });
        }
      } else if (frame.type === "skill_result") {
        receiver.finish(null);
        done.resolve(frame.result);
      } else done.reject(new Error("Generated worker failed instead of handling capability rejection"));
    })().catch(done.reject);
  });
  try {
    return await done.promise;
  } finally {
    watchdog.removeEventListener("abort", expired);
    signal?.removeEventListener("abort", expired);
    await worker.terminate();
  }
};
function authorizedObservation(): ObservationV3 {
  return minecraftObservationFixture(adapter, { session_id: "fixture-session", world_id: "fixture-world" });
}
function fixture(runner: Runner, overrides: Partial<SkillHost> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-skills-"));
  const store = new Store(directory);
  const run = minecraftRunFixture(adapter, { world_id: "fixture-world", session_id: "fixture-session", task: "Measure bounded neutral capabilities" });
  store.saveRun(run);
  let unsafe = 0;
  const host: SkillHost = {
    authorize: context => {
      if (
        context.run_id !== run.run_id || context.world_id !== run.world_id ||
        context.epoch !== run.epoch || context.session_id !== run.session_id ||
        context.native_boot_id !== run.native_boot_id || context.life_id !== run.life_id ||
        context.space_epoch !== run.space_epoch || context.run_generation !== 1 ||
        run.status !== "running"
      )
        throw new Error("Authority revoked");
    },
    adapter: () => adapter,
    binding: () => minecraftTestBinding(adapter),
    observe: async () => authorizedObservation(),
    action: async () => success,
    queryCapability: async () => [],
    recover: async () => { throw new Error("No respawn in this fixture"); },
    cancelActions: async () => {},
    changed: () => {},
    unsafe: () => {
      unsafe++;
    },
    ...overrides,
  };
  const manager = new SkillManager(store, { runSkill: runner }, host);
  resources.push({ directory, store, manager });
  return { directory, store, run, manager, unsafe: () => unsafe };
}
const card = {
  purpose: "Exercise the public program lifecycle",
  applicability: "Deterministic isolated test",
  method: "Use bounded neutral capabilities",
  reason: "Prove lifecycle contracts",
  limitations: "No gameplay effectiveness claim",
};
async function register(
  manager: SkillManager,
  runId: string,
  name = "fixture",
  dependencies: SkillRef[] = [],
) {
  const view = await manager.register(runId, { entry: "run",
    name,
    source:
      'return {status:"completed",summary:"Fixture complete",result:null};',
    card,
    dependencies,
  });
  return { skill_id: view.skill_id, version: view.version };
}

test("source registration rechecks authority after artifact preparation before publishing a receipt", async () => {
  const { store, run, manager } = fixture(async () => completed);
  let authorized = true;
  const registerSource = store.registerSkill.bind(store);
  store.registerSkill = (...args) => {
    const pending = registerSource(...args);
    authorized = false;
    return pending;
  };
  const registration = { call_id: "stopped-registration", input: { name: "stopped source" } };
  await expect(manager.register(run.run_id, { entry: "run", name: "stopped source", card, dependencies: [],
    source: 'return {status:"completed",summary:"Not published",result:null};' }, () => {
    if (!authorized) throw new Error("Authority revoked during persistence");
  }, registration)).rejects.toThrow("Authority revoked");
  expect(store.skills(run.run_id)).toEqual([]);
  expect(store.completedToolCall(run.run_id, registration.call_id, registration.input)).toBeNull();
});

test("snapshot import rechecks authority after artifact preparation before publishing into its destination", async () => {
  const { store, run, manager } = fixture(async () => completed);
  const ref = await register(manager, run.run_id), snapshot = store.skill(run.run_id, ref);
  const destination = { ...run, run_id: crypto.randomUUID() };
  store.saveRun(destination);
  let authorized = true;
  const importSource = store.importSkill.bind(store);
  store.importSkill = (...args) => {
    const pending = importSource(...args);
    authorized = false;
    return pending;
  };
  await expect(manager.importSnapshot(destination.run_id, snapshot, () => {
    if (!authorized) throw new Error("Import authority revoked during persistence");
  })).rejects.toThrow("Import authority revoked");
  expect(store.skills(destination.run_id)).toEqual([]);
  expect(store.events(destination.run_id).filter(event => event.type === "skill.revalidated_import")).toEqual([]);
});

function closed(
  store: Store,
  runId: string,
  executionId: string,
): Promise<void> {
  const isClosed = () =>
    ["succeeded", "blocked", "failed", "cancelled", "unknown"].includes(
      store.skillExecution(runId, { execution_id: executionId })!.status,
    );
  if (isClosed()) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = store.subscribe((event) => {
    if (event.run_id === runId && event.type === "skill.closed" && isClosed()) {
      unsubscribe();
      resolve();
    }
  });
  return promise;
}
function start(
  run: StoredRun,
  skill: SkillRef,
  start_key: string,
  args: Json = null,
  limits: SkillLimits = { ...DEFAULT_SKILL_LIMITS },
) {
  return { entry: "run" as const,
    skill_id: skill.skill_id,
    version: skill.version,
    start_key,
    ...executionScopeFixture(run),
    args,
    limits,
  };
}

test("generated attention preserves root attribution, child producer and shared call limits without effects", async () => {
  const wakes: { execution_id: string; source_hash: string | null; summary: string }[] = [];
  let effects = 0;
  const { store, run, manager } = fixture(generatedWorker, {
    programEvent: (execution, event) => { wakes.push({ execution_id: execution.execution_id,
      source_hash: execution.source_hash, summary: event.summary }); },
    action: async () => { effects++; return success; },
  });
  const child = await manager.register(run.run_id, { entry: "run", name: "Attention child", card, dependencies: [],
    source: `const returned = await game.attention({urgency:"ordinary",summary:"Child needs cognition",details:{producer:"child"}});
if(returned !== undefined) throw new Error("Attention must return void");
await game.attention({urgency:"urgent",summary:"Must not pass root budget",details:null});
return {status:"completed",summary:"Unreachable",result:null};` });
  const root = await manager.register(run.run_id, { entry: "run", name: "Attention root", card,
    dependencies: [{ skill_id: child.skill_id, version: child.version }],
    source: 'await game.call({name:"Attention child"},null);return {status:"completed",summary:"Unreachable",result:null};' });
  const execution = manager.start(run.run_id, start(run, root, "child-attention", null,
    { ...DEFAULT_SKILL_LIMITS, max_calls: 2 }));
  await closed(store, run.run_id, execution.execution_id);
  const event = store.eventsAfter(run.run_id, 0, 1000).filter(event => event.type === "controller.event");
  expect(event).toHaveLength(1);
  const producer = store.allSkillExecutions(run.run_id).find(view => view.parent_execution_id === execution.execution_id)!;
  expect(event[0]!.details).toEqual({ execution_id: execution.execution_id, source_hash: root.hash, entry: "run",
    producer_execution_id: producer.execution_id, producer_source_hash: child.hash, author: "model",
    event: { kind: "attention", urgency: "ordinary", summary: "Child needs cognition", details: { producer: "child" } },
    gameplay_success_proof: false });
  expect(wakes).toEqual([{ execution_id: execution.execution_id, source_hash: root.hash, summary: "Child needs cognition" }]);
  expect(effects).toBe(0);
  expect(manager.get(run.run_id, { execution_id: execution.execution_id })).toMatchObject({
    status: "failed", calls: 2, actions: 0, diagnostic: { code: "budget_exceeded" } });
  expect(producer.calls).toBe(1);
});

test("confirmed failed input cannot deliver a fresh observation after actual life authority changes", async () => {
  const generated = Promise.withResolvers<SkillResult>();
  void generated.promise.catch(() => {});
  let observations = 0, effects = 0;
  const f = fixture(async (...args) => {
    try {
      const output = await generatedWorker(...args);
      generated.resolve(output);
      return output;
    } catch (error) { generated.reject(error); throw error; }
  }, {
    action: async () => {
      effects++;
      return { status: "failed", summary: "Owned server confirmed rejected input",
        evidence: { world_effect_emitted: true, failure_outcome_confirmed: true, neutralized: true } };
    },
    observe: async () => {
      observations++;
      f.run.life_id = 2;
      f.store.saveRun(f.run);
      return authorizedObservation();
    },
  });
  const skill = await f.manager.register(f.run.run_id, { entry: "run", name: "Revoked failure feedback", card, dependencies: [],
    source: `let received=false;
try {
 const checked=await game.actionAndObserve({kind:"look",yaw:0,pitch:0});
 received=checked.observation!==null;
 if(received) await game.action({kind:"look",yaw:0.3,pitch:0});
} catch {}
return {status:"completed",summary:"Scoped failure feedback handled",result:{received_observation:received}};` });
  const execution = f.manager.start(f.run.run_id, start(f.run, skill, "revoked-failure-feedback"));
  const output = await generated.promise;
  await closed(f.store, f.run.run_id, execution.execution_id);
  expect(output.result).toEqual({ received_observation: false });
  expect(observations).toBe(1);
  expect(effects).toBe(1);
  expect(f.manager.get(f.run.run_id, { execution_id: execution.execution_id })).toMatchObject({
    status: "failed", actions: 1,
  });
});

test("generated attention rejects invalid events without wake, effects or admitted calls", async () => {
  let wakes = 0, effects = 0;
  const { store, run, manager } = fixture(generatedWorker, {
    programEvent: () => { wakes++; }, action: async () => { effects++; return success; },
  });
  const skill = await manager.register(run.run_id, { entry: "run", name: "Invalid attention", card, dependencies: [],
    source: `const invalid = [
{urgency:"immediate",summary:"Invalid urgency",details:null},
{urgency:"ordinary",summary:"",details:null},
{urgency:"ordinary",summary:"s".repeat(1001),details:null},
{kind:"progress",urgency:"ordinary",summary:"Cannot select another event kind",details:null},
{urgency:"urgent",summary:"Missing details"},
{urgency:"urgent",summary:"Unexpected fields",details:null,extra:true}
];
let rejected=0;
for(const request of invalid) {
  try { await game.attention(request); } catch { rejected++; }
}
return {status:"completed",summary:"Invalid attention handled",result:{rejected}};` });
  const execution = manager.start(run.run_id, start(run, skill, "invalid-attention"));
  await closed(store, run.run_id, execution.execution_id);
  expect(manager.get(run.run_id, { execution_id: execution.execution_id })).toMatchObject({
    status: "succeeded", calls: 0, actions: 0, result: { result: { rejected: 6 } } });
  expect(store.eventsAfter(run.run_id, 0, 1000).filter(event => event.type === "controller.event")).toEqual([]);
  expect({ wakes, effects }).toEqual({ wakes: 0, effects: 0 });
});

for (const fence of ["scope", "budget_observer", "unknown", "terminal"] as const)
test(`${fence} authority cannot publish late program attention or wake cognition`, async () => {
  let wakes = 0, late: Parameters<Runner>[2] | undefined;
  const { store, run, manager } = fixture(async (_source, _args, handle) => {
    late = handle;
    if (fence === "terminal") return completed;
    if (fence === "scope") run.status = "paused";
    if (fence === "unknown") {
      try { await handle({ kind: "action", action: { kind: "look", yaw: 0, pitch: 0 } }); } catch {}
    }
    await expect(handle({ kind: "attention", attention: { urgency: "urgent", summary: "No late wake", details: null } })).rejects.toThrow();
    return completed;
  }, {
    programEvent: () => { wakes++; },
    action: async () => ({ status: "unknown", summary: "Uncertain fixture effect", evidence: null, requires_reconnect: true }),
  });
  const skill = await register(manager, run.run_id, `Revoked attention ${fence}`);
  const off = store.subscribe(event => {
    if (fence === "budget_observer" && event.type === "skill.budget") manager.fence("Synchronous admission observer revoked root");
  });
  try {
    const execution = manager.start(run.run_id, start(run, skill, `revoked-attention-${fence}`));
    await closed(store, run.run_id, execution.execution_id);
    if (fence === "terminal")
      await expect(late!({ kind: "attention", attention: { urgency: "urgent", summary: "Terminal late wake", details: null } })).rejects.toThrow();
    expect(wakes).toBe(0);
    expect(store.eventsAfter(run.run_id, 0, 1000).filter(event => event.type === "controller.event")).toEqual([]);
  } finally { off(); }
});

for (const urgency of ["ordinary", "urgent"] as const)
test(`real Runtime and installed SDK consume ${urgency} async attention while the generated foreground keeps running`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-sdk-run-attention-"));
  const store = new Store(directory), observation = authorizedObservation();
  const authoringEntered = deferred<void>(), releaseAuthoring = deferred<void>(), releaseForeground = deferred<void>(),
    foregroundContinued = deferred<void>(), foregroundHeld = deferred<void>(), decisionFinished = deferred<void>(), attentionPublished = deferred<void>();
  let reads = 0, effects = 0, requests = 0, cancellations = 0, heldSignal: AbortSignal | undefined;
  const projections: Record<string, any>[] = [];
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => {}, neutralize: async () => {}, emergencyStop: async () => {},
    cancel: async () => {}, adapter: () => adapter, subscribe: () => () => {},
    snapshot: () => ({ status: "connected", username: "Fixture", version: "1.21.4",
      world_id: observation.world_id, epoch: observation.epoch, session_id: observation.session_id,
      life: observation.life, space: observation.space, screen: null, binding: minecraftTestBinding(adapter),
      presentation: adapter.projectObservation(observation), last_observation_at: null, error: null,
      video: { status: "streaming", width: 1, height: 1, fps: 30, frames: 1, last_frame_at: null, error: null } }),
    observe: async () => {
      reads++;
      // Runtime performs its own observations too; the program's explicit
      // adapter read below supplies the deterministic foreground barrier.
      return observation;
    },
    execute: async () => { effects++; foregroundContinued.resolve(); return success; },
    queryCapability: async () => {
      if (effects === 0) await authoringEntered.promise;
      else { foregroundHeld.resolve(); await releaseForeground.promise; }
      return [];
    },
  };
  const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Offline SDK fixture requires the installed Codex descriptor");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  const source = `await game.recipes("oak_planks");
const returned=await game.attention({urgency:"${urgency}",summary:"Async body requests a decision",details:{marker:"run-attention"}});
if(returned!==undefined) throw new Error("Attention must return void");
await game.action({kind:"look",yaw:0,pitch:0});
await game.recipes("oak_planks");
return {status:"completed",summary:"Foreground settled after attention",result:null};`;
  const streamFn: StreamFn = async (_model, context, options) => {
    const index = requests++;
    const user = context.messages.find(message => message.role === "user");
    if (user?.role === "user") {
      const text = typeof user.content === "string" ? user.content :
        user.content.filter(part => part.type === "text").map(part => part.text).join("");
      projections.push(JSON.parse(text));
    }
    const call: ToolCall | undefined = index === 0
      ? { type: "toolCall", id: "attention-submit", name: "program_submit",
        arguments: { name: "Async attention foreground", source, args: null,
          limits: { duration_ms: 10000, max_calls: 8, max_actions: 1 } } }
      : index === 1 ? { type: "toolCall", id: "obsolete-authoring-write", name: "program_write",
        arguments: { name: "Late inactive draft", source: 'return {status:"completed",summary:"Draft only",result:null};' } } : undefined;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: call ? "toolUse" : "stop", content: call ? [call] : [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      if (index === 1) {
        heldSignal = options?.signal;
        const cancelled = deferred<void>();
        const onAbort = () => { cancellations++; cancelled.resolve(); };
        heldSignal?.addEventListener("abort", onAbort, { once: true });
        authoringEntered.resolve();
        try { await Promise.race([releaseAuthoring.promise, cancelled.promise]); }
        finally { heldSignal?.removeEventListener("abort", onAbort); }
      }
      stream.end(message);
      yield { type: "done", reason: call ? "toolUse" : "stop", message };
    };
    return stream;
  };
  let agent: Agent | undefined;
  const auth = {
    snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: null,
      models: [{ id: model.id, name: "Offline fixture", provider: model.provider, context_window: null }], login: null, error: null }),
    createAgent: async (configuration: { tools: AgentTool[]; systemPrompt: string[] }) => {
      agent = new Agent({ initialState: { model, tools: configuration.tools, systemPrompt: configuration.systemPrompt },
        streamFn, getApiKey: () => "OFFLINE_FIXTURE_NO_PROVIDER" });
      return agent;
    },
    releaseAgent: async () => { agent?.abort(); await agent?.waitForIdle(); },
  } as unknown as AuthManager;
  const sandbox = { snapshot: () => ({ status: "ready", image: "fixture", error: null }), runSkill: generatedWorker } as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter });
  const failures = deferred<never>();
  void failures.promise.catch(() => {});
  const off = store.subscribe(event => {
    if (event.type === "controller.event") attentionPublished.resolve();
    if (event.type === "scheduler.turn_finished" && projections.some(projection =>
      projection.reason?.includes("resident_attention"))) decisionFinished.resolve();
    if (event.type === "scheduler.turn_failed" || event.type === "skill.closed")
      failures.reject(new Error(`Attention fixture ended early: ${event.type}: ${event.summary}`));
  });
  try {
    await runtime.initialize();
    const run = await runtime.createRun({ task: "Evaluator-authored zero-provider async attention fixture",
      goal: adapter.goals.find(goal => goal.goal_id === "custom")!, model_id: model.id, working_programs: "fresh" });
    await runtime.control(run.run_id, "start");
    await Promise.race([attentionPublished.promise, failures.promise]);
    await Promise.race([foregroundContinued.promise, failures.promise]);
    await Promise.race([foregroundHeld.promise, failures.promise]);
    expect(store.latestRootExecution(run.run_id)).toMatchObject({ entry: "run", status: "running", actions: 1, calls: 4 });
    if (urgency === "ordinary") {
      expect(heldSignal?.aborted).toBe(false);
      expect(cancellations).toBe(0);
      releaseAuthoring.resolve();
    }
    await Promise.race([decisionFinished.promise, failures.promise]);
    const decision = projections.find(projection => projection.reason?.includes("resident_attention"))!;
    expect(decision.pending_decision).toBe(true);
    expect(decision.feedback).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "controller.event", summary: "Async body requests a decision", details: expect.objectContaining({
        name: "Async attention foreground",
        event: { kind: "attention", urgency, summary: "Async body requests a decision", details: { marker: "run-attention" } },
      }),
    })]));
    expect(store.latestRootExecution(run.run_id)?.status).toBe("running");
    expect(effects).toBe(1);
    expect(reads).toBeGreaterThan(0);
    if (urgency === "urgent") {
      expect(cancellations).toBe(1);
      expect(heldSignal?.aborted).toBe(true);
      expect(store.namedSkill(run.run_id, "Late inactive draft")).toBeNull();
      expect(store.eventsAfter(run.run_id, 0, 1000).find(event => event.type === "model.request_settled" &&
        (event.details as Record<string, Json>).host_cancellation)?.details).toMatchObject({
        role: "authoring", obsolete: true, provider_failure: false,
        host_cancellation: { kind: "ordinary_authoring", reason: "resident_attention" },
      });
    }
  } finally {
    off(); releaseAuthoring.resolve(); releaseForeground.resolve(); authoringEntered.resolve();
    await runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

describe("durable program execution through host capabilities", () => {
  for (const toolName of ["program_submit", "program_run"] as const) {
    for (const [form, limits, expectedActions] of [
      ["omitted", undefined, 64], ["empty", {}, 64], ["partial", { max_actions: 2 }, 2],
    ] as const) {
      test(`real Runtime installed SDK ${toolName} ${form} limits enforce the effective worker root budget`, async () => {
        const directory = mkdtempSync(join(tmpdir(), "gameharness-sdk-runtime-limits-"));
        const store = new Store(directory), observation = authorizedObservation();
        const rootClosed = Promise.withResolvers<void>();
        const unsubscribe = store.subscribe(event => { if (event.type === "skill.closed") rootClosed.resolve(); });
        let effects = 0;
        const game: GameBridge = {
          connect: async () => {}, disconnect: async () => {}, neutralize: async () => {}, emergencyStop: async () => {},
          cancel: async () => {}, adapter: () => adapter, subscribe: () => () => {},
          snapshot: () => ({ status: "connected", username: "Fixture", version: "1.21.4",
            world_id: observation.world_id, epoch: observation.epoch, session_id: observation.session_id,
            life: observation.life, space: observation.space, screen: null, binding: minecraftTestBinding(adapter),
            presentation: adapter.projectObservation(observation), last_observation_at: null, error: null,
            video: { status: "streaming", width: 1, height: 1, fps: 30, frames: 1, last_frame_at: null, error: null } }),
          observe: async () => observation,
          execute: async () => { effects++; return success; },
        };
        const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses");
        if (!descriptor) throw new Error("Offline SDK fixture requires the installed Codex descriptor");
        const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
        const body = 'for(let n=0;n<65;n++)await game.action({kind:"look",yaw:0,pitch:0});return {status:"completed",summary:"Must exhaust the root budget",result:null};';
        const selectedLimits = limits === undefined ? {} : { limits };
        const calls: ToolCall[] = toolName === "program_submit"
          ? [{ type: "toolCall", id: "runtime-submit", name: toolName, arguments: { name: "runtime budget", source: body, args: null, ...selectedLimits } }]
          : [{ type: "toolCall", id: "runtime-write", name: "program_write", arguments: { name: "runtime budget", source: body } },
            { type: "toolCall", id: "runtime-start", name: toolName, arguments: { operation: "start", name: "runtime budget", args: null, ...selectedLimits } }];
        calls.unshift({ type: "toolCall", id: "runtime-invalid-limit", name: "program_submit",
          arguments: { name: "must not persist", source: body, args: null, limits: { max_actions: "2" } } });
        let index = 0;
        const streamFn: StreamFn = () => {
          const call = calls[index++];
          const message: AssistantMessage = { role: "assistant", content: call ? [call] : [{ type: "text", text: "Offline fixture complete." }],
            api: model.api, provider: model.provider, model: model.id, stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const events = new AssistantMessageEventStream();
          events.push({ type: "start", partial: message });
          if (call) {
            events.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            events.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
            events.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
          }
          events.push({ type: "done", reason: call ? "toolUse" : "stop", message }); events.end();
          return events;
        };
        let agent: Agent | null = null;
        const errors: unknown[] = [];
        const auth = {
          snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: null,
            models: [{ id: model.id, name: "Offline fixture", provider: model.provider, context_window: null }], login: null, error: null }),
          createAgent: async (configuration: { tools: AgentTool[]; systemPrompt: string[] }) => {
            agent = new Agent({ initialState: { model, tools: configuration.tools, systemPrompt: configuration.systemPrompt },
              streamFn, getApiKey: () => "OFFLINE_FIXTURE_NO_PROVIDER" });
            agent.subscribe(event => { if (event.type === "tool_execution_end" && event.isError) errors.push(event.result.details); });
            return agent;
          },
          releaseAgent: async () => { agent?.abort(); await agent?.waitForIdle(); },
        } as unknown as AuthManager;
        const sandbox = { snapshot: () => ({ status: "ready", image: "fixture", error: null }), runSkill: generatedWorker } as unknown as SandboxService;
        const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter });
        try {
          await runtime.initialize();
          const run = await runtime.createRun({ task: "Evaluator-authored zero-provider budget fixture",
            goal: adapter.goals.find(goal => goal.goal_id === "custom")!, model_id: model.id, working_programs: "fresh" });
          await runtime.control(run.run_id, "start");
          await rootClosed.promise;
          const root = store.latestRootExecution(run.run_id)!;
          expect(errors).toMatchObject([{ error: { code: "invalid_request", retryable: false } }]);
          expect(store.skills(run.run_id)).toHaveLength(1);
          expect(root).toMatchObject({ status: "failed", actions: expectedActions,
            diagnostic: { code: "budget_exceeded" },
            limits: { duration_ms: 120000, max_actions: expectedActions, max_calls: 256, max_depth: 8 } });
          expect(effects).toBe(expectedActions);
          expect(store.eventsAfter(run.run_id, 0, 1000).filter(event => event.type === "action.accepted")).toHaveLength(expectedActions);
          expect(store.allSkillExecutions(run.run_id)).toHaveLength(1);
        } finally {
          unsubscribe(); await runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true });
        }
      }, 15000);
    }
  }

  for (const summaryLength of [2000, 2001]) {
    test(`generated terminal summary length ${summaryLength} preserves receipts and rejects only the over-limit result`, async () => {
      const { directory, store, run, manager } = fixture(generatedWorker);
      const observer = new ModelProgramEvidence(store, directory, DEFAULT_EVALUATION_CAPS, "test-host-clock", () => {});
      try {
        const skill = await manager.register(run.run_id, { entry: "run", name: `terminal summary ${summaryLength}`, card, dependencies: [],
          source: `const receipt = await game.action({kind:"look",yaw:0,pitch:0});
return {status:"completed",summary:"s".repeat(${summaryLength}),result:{receipt,details:{selected:"actor-authored detail retained"}}};` });
        const accepted = manager.start(run.run_id, start(run, skill, `summary-${summaryLength}`));
        await closed(store, run.run_id, accepted.execution_id);
        const outcome = manager.get(run.run_id, { execution_id: accepted.execution_id })!;
        if (summaryLength === 2000) {
          expect(outcome.status).toBe("succeeded");
          expect(outcome.result!.summary).toHaveLength(2000);
          expect(outcome.result!.result as unknown).toMatchObject({ receipt: success });
        } else {
          expect(outcome.status).toBe("failed");
          expect(outcome.diagnostic).toMatchObject({ type: "GeneratedResultValidationError", code: "invalid_program_result",
            result_path: "result.rejected_result", issues: [{ code: "too_big", path: "summary", maximum: 2000, actual: 2001 }] });
          expect(outcome.error).toContain("summary");
          expect(outcome.error).toContain("2000");
          expect(outcome.error).toContain("result");
          expect(outcome.result!.summary.length).toBeLessThan(400);
          const retained = outcome.result!.result as { rejected_result: { summary: string; result: Json } };
          expect(retained.rejected_result.summary).toHaveLength(2001);
          expect(retained.rejected_result.result as unknown).toEqual({ receipt: success, details: { selected: "actor-authored detail retained" } });
          const saved = JSON.parse(readFileSync(join(directory, await observer.save(run.run_id)), "utf8"));
          expect(saved.executions[0].result.result.rejected_result).toEqual(retained.rejected_result);
          const finalized = await observer.finalize(run.run_id, { status: "failed", reason: "generated_result_validation" });
          const journal = readFileSync(join(directory, finalized.journal), "utf8");
          expect(journal).toContain("invalid_program_result");
        }
        expect(outcome.actions).toBe(1);
      } finally {
        await observer.close();
      }
    });
  }

  test("a brief generated summary keeps detailed raw receipts in structured result without increasing protocol limits", async () => {
    const { store, run, manager } = fixture(generatedWorker);
    const skill = await manager.register(run.run_id, { entry: "run", name: "brief result with details", card, dependencies: [],
      source: 'const receipt=await game.action({kind:"look",yaw:0,pitch:0});return {status:"completed",summary:"One bounded fixture action settled; details are in result.",result:{receipt,details:"d".repeat(4000)}};' });
    const execution = manager.start(run.run_id, start(run, skill, "brief-result"));
    await closed(store, run.run_id, execution.execution_id);
    const outcome = manager.get(run.run_id, { execution_id: execution.execution_id })!;
    expect(outcome.status).toBe("succeeded");
    expect(outcome.result!.result as unknown).toEqual({ receipt: success, details: "d".repeat(4000) });
  });

  test("real Runtime and generated worker reject wire and semantic invalid requests before admission then permit one fresh corrected action", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gameharness-registered-runtime-"));
    const store = new Store(directory), observation = authorizedObservation();
    const submitted = Promise.withResolvers<void>(), failed = Promise.withResolvers<never>();
    const effects: Json[] = [];
    const game: GameBridge = {
      connect: async () => {}, disconnect: async () => {}, neutralize: async () => {}, emergencyStop: async () => {},
      cancel: async () => {}, adapter: () => adapter, subscribe: () => () => {},
      snapshot: () => ({ status: "connected", username: "Fixture", version: "1.21.4",
        world_id: observation.world_id, epoch: observation.epoch, session_id: observation.session_id,
        life: observation.life, space: observation.space, screen: null, binding: minecraftTestBinding(adapter),
        presentation: adapter.projectObservation(observation), last_observation_at: null, error: null,
        video: { status: "streaming", width: 1, height: 1, fps: 30, frames: 1, last_frame_at: null, error: null } }),
      observe: async () => observation,
      execute: async envelope => { effects.push(envelope.action); return success; },
    };
    let tools: AgentTool[] = [], started = false;
    let before: Parameters<Agent["setBeforeModelCall"]>[0];
    const source = `
let diagnostic = null;
try {
  await game.action({kind:"navigate",target:{target_id:"INPUT_TARGET_SECRET",incarnation:1,life_id:1,
    space:{dimension_id:"minecraft:overworld",space_epoch:1}},range:0.4,duration_ms:1000});
} catch (error) {
  diagnostic = {code:error.code,message:error.message};
}
if (!diagnostic || diagnostic.code !== "invalid_request") {
  return {status:"blocked",summary:"Precise validation diagnostic was unavailable",result:{diagnostic}};
}
let ordinaryDiagnostic = null;
try {
  await game.action({kind:"world_input",steps:[{ticks:1,
    held:{forward:true,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false},
    edges:[],view:{kind:"unchanged"},selected_hotbar:null}]});
} catch (error) {
  ordinaryDiagnostic = {code:error.code,message:error.message};
}
if (!ordinaryDiagnostic || ordinaryDiagnostic.code !== "invalid_request") {
  return {status:"blocked",summary:"Ordered input validation was unavailable",result:{diagnostic,ordinaryDiagnostic}};
}
const fresh = await game.observe();
const corrected = await game.action({kind:"look",yaw:fresh.data.player.yaw,pitch:0});
return {status:"completed",summary:"Explicit fresh bounded decision after pre-admission rejection",result:{diagnostic,ordinaryDiagnostic,corrected}};
`;
    const auth = {
      snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: null,
        models: [{ id: "fixture-model", name: "Fixture", provider: "fixture", context_window: null }], login: null, error: null }),
      createAgent: async (configuration: { tools: AgentTool[] }) => {
        tools = configuration.tools;
        const hooks = new DiagnosticModelHooks();
        return {
          addBeforeModelCallHook: hooks.add,
          setTools: (value: AgentTool[]) => { tools = value; },
          setBeforeModelCall: (value: typeof before) => { before = value; },
          subscribe: () => () => {}, replaceMessages: () => {}, abort: () => {}, waitForIdle: async () => {},
          prompt: async () => {
            if (started) return;
            started = true;
            try {
              const signal = new AbortController().signal;
              await hooks.run(signal, { systemPrompt: [], messages: [], tools });
              const admission = await before?.({ systemPrompt: [], messages: [], tools }, signal);
              if (admission?.stop) throw new Error("Fixture admission unexpectedly stopped");
              const submit = tools.find(tool => tool.name === "program_submit")!;
              const result = await submit.execute("registered-range-submission", { name: "range recovery", source, args: null });
              if (result.isError) throw new Error("Fixture submission failed");
              submitted.resolve();
            } catch (error) { failed.reject(error); throw error; }
          },
        } as unknown as Agent;
      },
      releaseAgent: async () => {},
    } as unknown as AuthManager;
    const sandbox = { snapshot: () => ({ status: "ready", image: "fixture", error: null }), runSkill: generatedWorker } as unknown as SandboxService;
    const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter });
    try {
      await runtime.initialize();
      const run = await runtime.createRun({ task: "Exercise registered argument recovery without native services",
        goal: adapter.goals.find(goal => goal.goal_id === "custom")!, model_id: "fixture-model", working_programs: "fresh" });
      await runtime.control(run.run_id, "start");
      await Promise.race([submitted.promise, failed.promise]);
      const execution = store.latestRootExecution(run.run_id)!;
      await Promise.race([closed(store, run.run_id, execution.execution_id), failed.promise]);
      const outcome = store.skillExecution(run.run_id, { execution_id: execution.execution_id })!;
      expect(outcome).toMatchObject({ status: "succeeded", result: { result: { diagnostic: { code: "invalid_request" },
        ordinaryDiagnostic: { code: "invalid_request" },
        corrected: { status: "succeeded" } } } });
      const result = outcome.result!.result as { diagnostic: { message: string } };
      expect(result.diagnostic.message).toContain("range");
      expect(result.diagnostic.message).toContain(">= 0.5");
      expect(result.diagnostic.message).toContain("no action admitted");
      expect(result.diagnostic.message).not.toContain("INPUT_TARGET_SECRET");
      expect(effects).toEqual([{ kind: "look", yaw: 0, pitch: 0 }]);
      const events = store.eventsAfter(run.run_id, 0, 1000);
      expect(events.filter(event => event.type === "action.accepted")).toHaveLength(1);
      expect(events.some(event => event.type === "runtime.uncertainty")).toBe(false);
      expect(runtime.snapshot()?.status).toBe("running");
    } finally {
      await runtime.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("real worker named-call refusals remain safe preconditions without admitting native bindings or children", async () => {
    const queries: { id: string; version: number; args: Json }[] = [];
    let effects = 0;
    const { directory, store, run, manager } = fixture(generatedWorker, {
      action: async () => { effects++; return success; },
      queryCapability: async (id, version, args) => {
        queries.push({ id, version, args });
        return { direct_native_read: true };
      },
    });
    const observer = new ModelProgramEvidence(store, directory, DEFAULT_EVALUATION_CAPS, "test-host-clock", () => {});
    try {
      const childSource = 'await game.action({kind:"look",yaw:0,pitch:0});return {status:"completed",summary:"Child executed",result:null};';
      await manager.register(run.run_id, { entry: "run", name: "recipes", card, dependencies: [], source: childSource });
      const first = await manager.register(run.run_id, { entry: "run", name: "ambiguous child", card, dependencies: [], source: childSource });
      const second = await manager.register(run.run_id, { entry: "run", name: "ambiguous child", card, dependencies: [],
        source: 'await game.action({kind:"look",yaw:0,pitch:0});return {status:"completed",summary:"Revised child executed",result:null};' });
      const skill = await manager.register(run.run_id, { entry: "run", name: "invalid named calls", card,
        dependencies: [first, second].map(({ skill_id, version }) => ({ skill_id, version })),
        source: `
const failures = [];
for (const target of [{name:"missing child"}, {name:"recipes",version:1}, {name:"ambiguous child"}]) {
  try { await game.call(target, {item:"iron_pickaxe"}); }
  catch (error) { failures.push({code:error.code,message:error.message}); }
}
const direct = await game.recipes("iron_pickaxe");
return {status:"completed",summary:"Named calls refused; direct native read completed",result:{failures,direct}};
`,
      });
      const accepted = manager.start(run.run_id, start(run, skill, "named-call-refusals"));
      await closed(store, run.run_id, accepted.execution_id);
      const outcome = manager.get(run.run_id, { execution_id: accepted.execution_id })!;
      expect(outcome).toMatchObject({ status: "succeeded", result: { result: {
        failures: [{ code: "precondition_failed" }, { code: "precondition_failed" }, { code: "precondition_failed" }],
        direct: { direct_native_read: true },
      } } });
      expect(effects).toBe(0);
      expect(store.skillExecutions(run.run_id)).toHaveLength(1);
      expect(queries).toEqual([{ id: "minecraft.recipes", version: 1, args: { item: "iron_pickaxe" } }]);
      const finalized = await observer.finalize(run.run_id, { status: "completed", reason: "named_call_refusals" });
      expect(finalized.evidence_complete).toBe(true);
      const journal = readFileSync(join(directory, finalized.journal), "utf8");
      const traces = journal.trim().split("\n").map(line => JSON.parse(line))
        .filter(record => record.kind === "authorized_execution_evidence_before_trace_caps")
        .map(record => record.value);
      const requests = traces.filter(trace => trace.kind === "capability_request");
      const results = traces.filter(trace => trace.kind === "capability_result");
      expect(requests.map(trace => trace.capability)).toEqual(["call", "call", "call", "adapter"]);
      expect(results).toHaveLength(4);
      const returned = outcome.result!.result as { failures: { code: string; message: string }[] };
      for (const [index, failure] of returned.failures.entries()) {
        expect(failure.message.length).toBeGreaterThan(0);
        expect(failure.message.length).toBeLessThanOrEqual(1000);
        expect(results[index]).toMatchObject({
          execution_id: accepted.execution_id, call_id: requests[index].call_id,
          payload: { ok: false, result: failure },
        });
      }
      expect(results[3]).toMatchObject({ payload: { ok: true, result: { direct_native_read: true } } });
      for (const privateDetail of [directory, "node:internal", "skills.ts", "at SkillManager"])
        expect(journal).not.toContain(privateDetail);
    } finally {
      await observer.close();
    }
  });

  test("caught trusted capability failures survive successful real-worker execution in the finalized correlated private journal", async () => {
    const trusted = new RuntimeFault("precondition_failed", "Observation is not available in the current life");
    trusted.stack = "HOST_STACK_SECRET at /private/host/trusted-capability.ts:42";
    const arbitrary = new Error("HOST_MESSAGE_SECRET /private/host/credentials.json");
    arbitrary.stack = "HOST_STACK_SECRET at /private/host/backend.ts:99";
    const { directory, store, run, manager } = fixture(generatedWorker, {
      observe: async () => { throw trusted; },
      queryCapability: async () => { throw arbitrary; },
    });
    const stops: string[] = [];
    const observer = new ModelProgramEvidence(store, directory, DEFAULT_EVALUATION_CAPS,
      "test-host-clock", (_runId, reason) => { stops.push(reason); });
    try {
      const skill = await manager.register(run.run_id, { entry: "run",
        name: "caught capability failures", card, dependencies: [],
        source: `
let handled = 0;
try { await game.observe(); }
catch (error) {
  if (error.code !== "precondition_failed" || error.message !== "Observation is not available in the current life") throw error;
  handled++;
}
try { await game.recipes("crafting_table"); }
catch (error) {
  if (error.code !== "backend_unavailable" || error.message !== "Trusted capability could not complete safely") throw error;
  handled++;
}
return {status:"completed", summary:"Continued after two safely handled rejections", result:{handled}};
`,
      });
      const accepted = manager.start(run.run_id, start(run, skill, "caught-private-evidence"));
      await closed(store, run.run_id, accepted.execution_id);
      const outcome = manager.get(run.run_id, { execution_id: accepted.execution_id })!;
      expect(outcome).toMatchObject({ status: "succeeded", result: {
        status: "completed", result: { handled: 2 },
      } });
      expect(outcome).not.toHaveProperty("diagnostic");
      const finalized = await observer.finalize(run.run_id, { status: "completed", reason: "caught_rejections" });
      expect(finalized.evidence_complete).toBe(true);
      expect(stops).toEqual([]);
      const journal = readFileSync(join(directory, finalized.journal), "utf8");
      const traces = journal.trim().split("\n").map(line => JSON.parse(line))
        .filter(record => record.kind === "authorized_execution_evidence_before_trace_caps")
        .map(record => record.value);
      const requests = traces.filter(trace => trace.kind === "capability_request");
      const failures = traces.filter(trace => trace.kind === "capability_result" && trace.payload.ok === false);
      expect(requests).toHaveLength(2);
      expect(failures).toHaveLength(2);
      for (const [index, expected] of [
        { code: "precondition_failed", message: "Observation is not available in the current life" },
        { code: "backend_unavailable", message: "Trusted capability could not complete safely" },
      ].entries()) {
        expect(failures[index]).toMatchObject({
          run_id: run.run_id, execution_id: accepted.execution_id, root_execution_id: accepted.execution_id,
          hash: skill.hash, session_id: run.session_id, life_id: run.life_id,
          call_id: requests[index].call_id, capability: requests[index].capability,
          payload: { ok: false, result: expected },
        });
        expect(typeof failures[index].call_id).toBe("string");
        expect(failures[index].call_id.length).toBeGreaterThan(0);
      }
      expect(failures[0].call_id).not.toBe(failures[1].call_id);
      for (const secret of ["HOST_STACK_SECRET", "HOST_MESSAGE_SECRET", "/private/host/", "node:internal"])
        expect(journal).not.toContain(secret);
    } finally {
      await observer.close();
    }
  });

  test("trusted capability diagnostics survive failure cleanup, durable inspection and skill outcome evidence", async () => {
    const { store, run, manager } = fixture(async (_source, _args, handle) => {
      await handle({ kind: "observe" });
      return completed;
    }, { observe: async () => { throw new RuntimeFault("precondition_failed", "Observation is not available in the current life"); } });
    const skill = await register(manager, run.run_id, "diagnostic reader");
    const accepted = manager.start(run.run_id, start(run, skill, "diagnostic-reader"));
    await closed(store, run.run_id, accepted.execution_id);
    const outcome = manager.get(run.run_id, { execution_id: accepted.execution_id })!;
    expect(outcome.status).toBe("failed");
    const inspected = new ProgramWorkspace(store, run.run_id).executionView(outcome);
    expect(inspected).toMatchObject({ diagnostic: {
      code: "precondition_failed", message: "Observation is not available in the current life",
      source_hash: store.skill(run.run_id, skill).hash,
    } });
    const event = store.eventsAfter(run.run_id, 0, 500).find(event => event.type === "skill.closed");
    expect(JSON.stringify(event?.details)).toContain("Observation is not available in the current life");
    expect(JSON.stringify(inspected)).not.toContain("skills.ts");
    expect(JSON.stringify(inspected)).not.toContain("node:internal");
  });

  test("safely failed leaf actions and blocked children remain structured results the parent can handle", async () => {
    let child: SkillRef,
      actions = 0,
      observations = 0;
    const runner: Runner = async (
      _source,
      args,
      handle,
    ): Promise<SkillResult> => {
      if (args === "blocked-child")
        return {
          status: "blocked",
          summary: "A real precondition is absent",
          result: { missing: "fixture-condition" },
        };
      const failed = await handle({
        kind: "action",
        action: { kind: "look", yaw: 0, pitch: 0 },
      });
      await handle({ kind: "observe" });
      const corrected = await handle({
        kind: "action",
        action: { kind: "look", yaw: 0.1, pitch: 0 },
      });
      const blocked = await handle({
        kind: "call",
        skill: { name: "blocked-child", version: child.version },
        args: "blocked-child",
      });
      return {
        status: "completed",
        summary: "Handled actual outcomes in program",
        result: { failed, corrected, blocked },
      };
    };
    const { store, run, manager } = fixture(runner, {
      action: async () =>
        ++actions === 1
          ? {
              status: "failed",
              summary: "Safely settled fixture refusal",
              evidence: { effect_confirmed: false },
            }
          : success,
      observe: async () => {
        observations++;
        return authorizedObservation();
      },
    });
    child = await register(manager, run.run_id, "blocked-child");
    const root = await register(manager, run.run_id, "handles-results", [
      child,
    ]);
    const accepted = manager.start(run.run_id, start(run, root, "recoverable"));
    await closed(store, run.run_id, accepted.execution_id);
    const outcome = manager.get(run.run_id, {
      execution_id: accepted.execution_id,
    })!;
    expect(outcome.status).toBe("succeeded");
    expect(actions).toBe(2);
    expect(observations).toBe(1);
    expect(outcome.result?.result).toEqual({
      failed: {
        status: "failed",
        summary: "Safely settled fixture refusal",
        evidence: { effect_confirmed: false },
      },
      corrected: {
        status: "succeeded",
        summary: "Confirmed bounded fixture action",
        evidence: { effect_confirmed: true },
      },
      blocked: {
        status: "blocked",
        summary: "A real precondition is absent",
        result: { missing: "fixture-condition" },
      },
    });
  });

  test("unknown leaf effects fence the root before another action can be issued", async () => {
    let actions = 0;
    const { store, run, manager } = fixture(
      async (_source, _args, handle) => {
        try {
          await handle({
            kind: "action",
            action: { kind: "look", yaw: 0, pitch: 0 },
          });
        } catch {}
        await handle({
          kind: "action",
          action: { kind: "look", yaw: 0.1, pitch: 0 },
        });
        return completed;
      },
      {
        action: async () => {
          actions++;
          return {
            status: "unknown",
            summary: "Actual effect is uncertain",
            evidence: null,
            requires_reconnect: true,
          };
        },
      },
    );
    const skill = await register(manager, run.run_id);
    const accepted = manager.start(
      run.run_id,
      start(run, skill, "unknown-effect"),
    );
    await closed(store, run.run_id, accepted.execution_id);
    expect(actions).toBe(1);
    expect(
      manager.get(run.run_id, { execution_id: accepted.execution_id })?.status,
    ).toBe("unknown");
  });

  test("lost acknowledgement returns the original identity before renewed authority and never dispatches twice", async () => {
    let invocations = 0;
    const entered = deferred<void>(),
      release = deferred<void>();
    const { store, run, manager } = fixture(async () => {
      invocations++;
      entered.resolve();
      await release.promise;
      return completed;
    });
    const skill = await register(manager, run.run_id);
    const request = start(run, skill, "stable-start");
    const accepted = manager.start(run.run_id, request);
    await entered.promise;
    run.status = "paused";
    run.epoch = 2;
    store.saveRun(run);
    const retry = manager.start(run.run_id, request);
    expect(retry.execution_id).toBe(accepted.execution_id);
    expect(invocations).toBe(1);
    expect(() =>
      manager.start(run.run_id, { ...request, args: { changed: true } }),
    ).toThrow();
    manager.fence("Paused");
    release.resolve();
    await manager.closeAll("Paused");
    expect(
      store.skillExecution(run.run_id, { start_key: "stable-start" })?.status,
    ).toBe("cancelled");
  });

  test("composition shares root action and host-call budgets rather than resetting at each child", async () => {
    let child: SkillRef;
    let observed = 0,
      actions = 0;
    const runner: Runner = async (_source, args, handle) => {
      if (args === "child") {
        await handle({
          kind: "action",
          action: { kind: "look", yaw: 0, pitch: 0 },
        });
        await handle({ kind: "observe" });
      } else {
        await handle({ kind: "call", skill: { name: "child", version: child.version }, args: "child" });
        await handle({ kind: "call", skill: { name: "child", version: child.version }, args: "child" });
      }
      return completed;
    };
    const { store, run, manager } = fixture(runner, {
      observe: async () => {
        observed++;
        return authorizedObservation();
      },
      action: async () => {
        actions++;
        return success;
      },
    });
    child = await register(manager, run.run_id, "child");
    const root = await register(manager, run.run_id, "root", [child]);
    const accepted = manager.start(
      run.run_id,
      start(run, root, "aggregate", null, {
        duration_ms: 10000,
        max_actions: 10,
        max_calls: 5,
        max_depth: 3,
      }),
    );
    await closed(store, run.run_id, accepted.execution_id);
    const result = manager.get(run.run_id, {
      execution_id: accepted.execution_id,
    })!;
    expect(result.calls).toBe(5);
    expect(result.actions).toBe(2);
    expect(actions).toBe(2);
    expect(observed).toBe(1);
    expect(result.status).not.toBe("succeeded");
    for (const execution of store.skillExecutions(run.run_id)) {
      expect(execution.deadline_at).toBe(result.deadline_at);
      expect(execution.root_execution_id).toBe(result.execution_id);
    }
  });

  for (const counter of ["actions", "calls"] as const) {
    for (const composed of [false, true]) {
      test(`aggregate root ${counter} exhaustion survives real-worker closure${composed ? " in a child" : ""}`, async () => {
        let effects = 0, observations = 0, transportRejections = 0;
        const failures: { code: string; message: string }[] = [];
        const revoked: boolean[] = [];
        const cleanupEntered = deferred<void>(), cleanup = deferred<void>();
        const workerClosed = deferred<void>();
        let workers = 0;
        const runner: Runner = async (source, args, handle, limits, signal, hooks) => {
          workers++;
          try {
            return await generatedWorker(source, args, async request => {
              try { return await handle(request); }
              catch (error) {
                failures.push(capabilityFailure(error));
                revoked.push(signal.aborted);
                throw error;
              }
            }, limits, signal, {
              ...hooks,
              onCapabilityBudgetExceeded: request => {
                transportRejections++;
                const failure = hooks?.onCapabilityBudgetExceeded?.(request) ?? null;
                if (failure) {
                  failures.push(capabilityFailure(failure));
                  revoked.push(signal.aborted);
                }
                return failure;
              },
            });
          } finally {
            if (--workers === 0) workerClosed.resolve();
          }
        };
        const { store, run, manager } = fixture(runner, {
          action: async () => { effects++; return success; },
          observe: async () => { observations++; return authorizedObservation(); },
          cancelActions: async () => { cleanupEntered.resolve(); await cleanup.promise; },
        });
        const body = `
await game.action({kind:"look",yaw:0,pitch:0});
await game.observe();
try {
  ${counter === "actions" ? 'await game.action({kind:"look",yaw:0,pitch:0});' : "await game.observe();"}
} catch (error) {
  await game.action({kind:"look",yaw:1,pitch:0});
  await game.observe();
}
return {status:"completed",summary:"Must not override exhausted authority",result:null};
`;
        const child = composed ? await manager.register(run.run_id, {
          entry: "run", name: "budget child", card, dependencies: [], source: body,
        }) : null;
        const root = await manager.register(run.run_id, {
          entry: "run", name: "budget root", card,
          dependencies: child ? [{ skill_id: child.skill_id, version: child.version }] : [],
          source: child
            ? 'await game.call({name:"budget child"},null);return {status:"completed",summary:"Must not complete after child exhaustion",result:null};'
            : body,
        });
        const maxCalls = counter === "calls" ? (composed ? 3 : 2) : 10;
        const accepted = manager.start(run.run_id, start(run, root, "worker-budget", null, {
          duration_ms: 10000, max_actions: counter === "actions" ? 1 : 10,
          max_calls: maxCalls, max_depth: 3,
        }));
        try {
          await cleanupEntered.promise;
          await workerClosed.promise;
          expect(manager.pending).toBe(true);
          const closing = manager.get(run.run_id, { execution_id: accepted.execution_id })!;
          expect(closing.status).toBe("cancel_requested");
          expect(manager.effectScope(accepted.execution_id)).toBeNull();
          expect(failures[0]).toMatchObject({ code: "budget_exceeded" });
          expect(transportRejections).toBe(1);
          expect(revoked.every(Boolean)).toBe(true);
          expect(failures[0]!.message).toContain(`max_${counter}`);
          expect(failures[0]!.message).toContain(counter === "actions" ? "actions=1/1" : `calls=${maxCalls}/${maxCalls}`);
          expect(failures[0]!.message).toContain("Inspect");
          expect(effects).toBe(1);
          expect(observations).toBe(1);
        } finally {
          cleanup.resolve();
        }
        await manager.closeAll("Join budget exhaustion");
        const executions = store.skillExecutions(run.run_id);
        expect(executions).toHaveLength(composed ? 2 : 1);
        for (const execution of executions) {
          expect(execution).toMatchObject({
            status: "failed",
            diagnostic: { type: "RuntimeFault", code: "budget_exceeded",
              message: failures[0]!.message, source_hash: store.skill(run.run_id, execution).hash },
            error: failures[0]!.message,
            result: { status: "failed", summary: failures[0]!.message, result: null },
          });
          expect(manager.effectScope(execution.execution_id)).toBeNull();
          const inspected = new ProgramWorkspace(store, run.run_id).executionView(execution);
          expect(inspected!.diagnostic).toMatchObject({ code: "budget_exceeded", message: failures[0]!.message });
        }
        const outcome = manager.get(run.run_id, { execution_id: accepted.execution_id })!;
        expect(outcome.calls).toBe(composed ? 3 : 2);
        expect(outcome.actions).toBe(1);
        if (composed)
          expect(executions.find(execution => execution.parent_execution_id !== null)).toMatchObject({ calls: 2, actions: 1 });
        const closures = store.eventsAfter(run.run_id, 0, 1000).filter(event => event.type === "skill.closed");
        expect(closures).toHaveLength(executions.length);
        for (const event of closures)
          expect(event.details).toMatchObject({ details: {
            diagnostic: { code: "budget_exceeded", message: failures[0]!.message },
          } });
        expect(manager.pending).toBe(false);
        expect(effects).toBe(1);
        expect(observations).toBe(1);
        const publicEvidence = JSON.stringify({ executions, failures, closures });
        for (const privateDetail of ["/private/", "node:internal", "skills.ts", "at SkillManager"])
          expect(publicEvidence).not.toContain(privateDetail);
      });
    }
  }

  test("an undeclared named dependency cannot acquire a child execution", async () => {
    let dependency: SkillRef;
    const { store, run, manager } = fixture(async (_source, _args, handle) => {
      await handle({ kind: "call", skill: { name: "not-declared", version: dependency.version }, args: null });
      return completed;
    });
    dependency = await register(manager, run.run_id, "not-declared");
    const root = await register(manager, run.run_id, "root");
    const accepted = manager.start(run.run_id, start(run, root, "undeclared"));
    await closed(store, run.run_id, accepted.execution_id);
    expect(store.skillExecutions(run.run_id)).toHaveLength(1);
    expect(
      manager.get(run.run_id, { execution_id: accepted.execution_id })?.status,
    ).toBe("failed");
  });

  test("cancellation fences immediately but terminal acknowledgement waits for confirmed leaf shutdown", async () => {
    const entered = deferred<void>(),
      leaf = deferred<GameActionResult>(),
      cleanup = deferred<void>();
    let actions = 0;
    const runner: Runner = async (_source, _args, handle, _limits, signal) => {
      const abort = Promise.withResolvers<never>();
      signal.addEventListener(
        "abort",
        () => abort.reject(new Error("Confirmed fixture worker closed")),
        { once: true },
      );
      return await Promise.race([
        (async () => {
          await handle({
            kind: "action",
            action: { kind: "look", yaw: 0, pitch: 0 },
          });
          return completed;
        })(),
        abort.promise,
      ]);
    };
    const { store, run, manager } = fixture(runner, {
      action: async () => {
        actions++;
        entered.resolve();
        return await leaf.promise;
      },
      cancelActions: async () => {
        await cleanup.promise;
      },
    });
    const skill = await register(manager, run.run_id);
    const accepted = manager.start(
      run.run_id,
      start(run, skill, "cancel-tree"),
    );
    await entered.promise;
    const response = manager.cancel(run.run_id, {
      execution_id: accepted.execution_id,
    });
    expect(response.status).toBe("cancel_requested");
    await Promise.resolve();
    await Promise.resolve();
    expect(
      manager.get(run.run_id, { execution_id: accepted.execution_id })?.status,
    ).toBe("cancel_requested");
    leaf.resolve({
      status: "cancelled",
      summary: "Emitter closed",
      evidence: { neutralized_effect: true },
    });
    cleanup.resolve();
    await manager.closeAll("Cancel settled");
    expect(
      manager.get(run.run_id, { execution_id: accepted.execution_id })?.status,
    ).toBe("cancelled");
    expect(actions).toBe(1);
    expect(manager.pending).toBe(false);
  });

  test("unconfirmed isolated cleanup remains unknown rather than a false cancelled success", async () => {
    const entered = deferred<void>();
    const { store, run, manager, unsafe } = fixture(
      async (_source, _args, _handle, _limits, signal) => {
        const abort = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => abort.resolve(), { once: true });
        entered.resolve();
        await abort.promise;
        throw new SkillCleanupError();
      },
    );
    const skill = await register(manager, run.run_id);
    const accepted = manager.start(
      run.run_id,
      start(run, skill, "unknown-cleanup"),
    );
    await entered.promise;
    manager.cancel(run.run_id, { execution_id: accepted.execution_id });
    await expect(manager.closeAll("Stop")).rejects.toBeInstanceOf(
      SkillCleanupError,
    );
    expect(
      store.skillExecution(run.run_id, { execution_id: accepted.execution_id })
        ?.status,
    ).toBe("unknown");
    expect(unsafe()).toBeGreaterThan(0);
  });
});

describe("semantic handoff capability boundaries", () => {
  const action: SkillCapabilityRequest = { kind: "action", action: { kind: "look", yaw: 0.1, pitch: 0 } };
  const read: SkillCapabilityRequest = { kind: "adapter", capability_id: "minecraft.recipes", version: 1, args: { item: "crafting_table" } };

  for (const boundary of ["action", "observe", "adapter"] as const)
    for (const nested of [false, true])
      test(`${nested ? "descendant" : "root"} ${boundary} settles before retirement without admitting any continuation`, async () => {
        const entered = deferred<void>(), release = deferred<void>();
        let effects = 0, reads = 0, cancellations = 0, wakes = 0, rejected = 0;
        let leafId = "", leafSignal: AbortSignal | undefined;
        const request: SkillCapabilityRequest = boundary === "action" ? action : boundary === "adapter" ? read : { kind: "observe" };
        const { store, run, manager } = fixture(async (_source, args, handle, _limits, signal) => {
          if (nested && args !== "leaf") {
            await handle({ kind: "call", skill: { name: args === "middle" ? "boundary leaf" : "boundary middle" },
              args: args === "middle" ? "leaf" : "middle" });
            throw new Error("A retired parent must not resume");
          }
          leafSignal = signal;
          await handle(request);
          // A synthetic transport deliberately tries again even after abort.
          // All capability kinds must fail before budgets or publication.
          expect(signal.aborted).toBe(true);
          const late: SkillCapabilityRequest[] = [
            action, { kind: "observe" }, read,
            { kind: "progress", summary: "Forbidden late progress", details: null },
            { kind: "attention", attention: { urgency: "urgent", summary: "Forbidden late attention", details: null } },
            { kind: "call", skill: { name: "boundary leaf" }, args: "leaf" },
          ];
          for (const capability of late) {
            try { await handle(capability); } catch { rejected++; }
          }
          return completed;
        }, {
          action: async (execution, _action, signal) => {
            effects++; leafId = execution.execution_id;
            expect(signal.aborted).toBe(false);
            entered.resolve(); await release.promise;
            expect(signal.aborted).toBe(false);
            expect(manager.effectScope(leafId)).not.toBeNull();
            expect(manager.invocation(leafId)).toMatchObject({ execution_id: leafId });
            return success;
          },
          observe: async () => { reads++; entered.resolve(); await release.promise; return authorizedObservation(); },
          queryCapability: async () => { reads++; entered.resolve(); await release.promise; return []; },
          cancelActions: async () => { cancellations++; },
          programEvent: () => { wakes++; },
        });
        const leaf = await register(manager, run.run_id, "boundary leaf");
        const middle = await register(manager, run.run_id, "boundary middle", [leaf]);
        const root = nested ? await register(manager, run.run_id, "boundary root", [middle]) : leaf;
        const successor = await register(manager, run.run_id, "boundary successor");
        const accepted = manager.start(run.run_id, start(run, root, "boundary-predecessor", nested ? "root" : "leaf"));
        await entered.promise;
        const next = start(run, successor, "boundary-successor");
        const retiring = manager.retireForHandoff(run.run_id, next, accepted.execution_id, undefined);
        expect(leafSignal?.aborted).toBe(false);
        expect(cancellations).toBe(0);
        expect(manager.effectScope(accepted.execution_id)).not.toBeNull();
        expect(() => manager.start(run.run_id, next)).toThrow();
        await expect(manager.retireForHandoff(run.run_id, next, accepted.execution_id, undefined)).rejects.toMatchObject({ code: "busy" });
        release.resolve();
        const guard = await retiring;
        guard();
        expect(rejected).toBe(6);
        expect(effects).toBe(boundary === "action" ? 1 : 0);
        expect(reads).toBe(boundary === "action" ? 0 : 1);
        expect(wakes).toBe(0);
        expect(manager.get(run.run_id, { execution_id: accepted.execution_id })).toMatchObject({
          status: "cancelled", calls: nested ? 3 : 1, actions: boundary === "action" ? 1 : 0,
        });
        expect(store.skillExecutions(run.run_id)).toHaveLength(nested ? 3 : 1);
        expect(store.eventsAfter(run.run_id, 0, 1000).filter(event => event.type === "skill.progress")).toEqual([]);
      });

  for (const kind of ["action", "call"] as const)
    test(`synchronous budget publication sees ${kind} admission before handoff`, async () => {
      const release = deferred<void>(), entered = deferred<void>();
      let effects = 0, invocations = 0, retiring: Promise<() => void> | undefined;
      const { store, run, manager } = fixture(abortableRunner(async (_source, _args, handle) => {
        invocations++;
        await handle(kind === "action" ? action : { kind: "call", skill: { name: "publication child" }, args: null });
        return completed;
      }), {
        action: async (_execution, _action, signal) => {
          effects++; entered.resolve(); await release.promise;
          expect(signal.aborted).toBe(false);
          return success;
        },
      });
      const child = await register(manager, run.run_id, "publication child");
      const root = await register(manager, run.run_id, "publication root", [child]);
      const successor = await register(manager, run.run_id, "publication successor");
      const off = store.subscribe(event => {
        if (event.type !== "skill.budget" || retiring) return;
        const predecessor = store.latestRootExecution(run.run_id)!;
        retiring = manager.retireForHandoff(run.run_id, start(run, successor, "publication-successor"), predecessor.execution_id, undefined);
      });
      try {
        const accepted = manager.start(run.run_id, start(run, root, "publication-predecessor"));
        if (kind === "action") { await entered.promise; expect(effects).toBe(1); release.resolve(); }
        else await closed(store, run.run_id, accepted.execution_id);
        (await retiring!)();
        expect(invocations).toBe(1);
        expect(effects).toBe(kind === "action" ? 1 : 0);
        expect(store.skillExecutions(run.run_id)).toHaveLength(1);
        expect(manager.get(run.run_id, { execution_id: accepted.execution_id })).toMatchObject({ status: "cancelled", calls: 1 });
      } finally { off(); release.resolve(); }
    });

  for (const nested of [false, true])
    test(`handoff does not grant an idle ${nested ? "child" : "root"} its first capability`, async () => {
      const entered = deferred<void>(), never = deferred<SkillResult>();
      let effects = 0;
      const { store, run, manager } = fixture(abortableRunner(async (_source, args, handle) => {
        if (nested && args !== "child") {
          await handle({ kind: "call", skill: { name: "idle child" }, args: "child" });
          return completed;
        }
        entered.resolve();
        await never.promise;
        await handle(action);
        return completed;
      }), { action: async () => { effects++; return success; } });
      const child = await register(manager, run.run_id, "idle child");
      const root = nested ? await register(manager, run.run_id, "idle root", [child]) : child;
      const successor = await register(manager, run.run_id, "idle successor");
      const accepted = manager.start(run.run_id, start(run, root, "idle-predecessor"));
      await entered.promise;
      (await manager.retireForHandoff(run.run_id, start(run, successor, "idle-successor"), accepted.execution_id, undefined))();
      expect(effects).toBe(0);
      expect(manager.get(run.run_id, { execution_id: accepted.execution_id })).toMatchObject({ status: "cancelled", calls: nested ? 1 : 0 });
    });

  for (const interruption of ["stop", "death", "unknown", "tool_abort", "deadline"] as const)
    test(`${interruption} immediately preempts a handoff held at an action boundary`, async () => {
      const entered = deferred<void>(), release = deferred<GameActionResult>(), workerAborted = deferred<void>();
      const cancelled = deferred<void>();
      let signal: AbortSignal | undefined, effects = 0;
      const { store, run, manager } = fixture(abortableRunner(async (_source, _args, handle, _limits, workerSignal) => {
        signal = workerSignal;
        workerSignal.addEventListener("abort", () => workerAborted.resolve(), { once: true });
        await handle(action);
        await handle(action);
        return completed;
      }), {
        action: async () => { effects++; entered.resolve(); return release.promise; },
        cancelActions: async () => { cancelled.resolve(); },
      });
      const root = await register(manager, run.run_id, "preempted root");
      const successor = await register(manager, run.run_id, "preempted successor");
      const limits = { ...DEFAULT_SKILL_LIMITS, duration_ms: interruption === "deadline" ? 1000 : 10000 };
      const accepted = manager.start(run.run_id, start(run, root, "preempted-predecessor", null, limits));
      await entered.promise;
      const controller = new AbortController();
      const retiring = manager.retireForHandoff(run.run_id, start(run, successor, "preempted-successor"), accepted.execution_id, controller.signal);
      const refused = retiring.then(() => null, error => error);
      if (interruption === "stop") manager.cancel(run.run_id, { execution_id: accepted.execution_id });
      else if (interruption === "death") { run.life_id = run.life_id! + 1; manager.fence("Player died"); }
      else if (interruption === "unknown") manager.fence("Actual effect unknown", accepted.execution_id);
      else if (interruption === "tool_abort") controller.abort();
      await workerAborted.promise;
      expect(signal?.aborted).toBe(true);
      expect(manager.effectScope(accepted.execution_id)).toBeNull();
      await cancelled.promise;
      expect(await refused).toBeInstanceOf(Error);
      await closed(store, run.run_id, accepted.execution_id);
      expect(effects).toBe(1);
      expect(store.skillExecutions(run.run_id)).toHaveLength(1);
      expect(manager.get(run.run_id, { execution_id: accepted.execution_id })?.status).toBe(interruption === "unknown" ? "unknown" : "cancelled");
      release.resolve({ status: "cancelled", summary: "Real interruption receipt", evidence: null });
    });

  for (const status of ["completed", "blocked", "failed"] as const)
    test(`natural ${status} is retained rather than rewritten for handoff`, async () => {
      const { store, run, manager } = fixture(async () => ({ status, summary: "Natural source outcome", result: null }));
      const root = await register(manager, run.run_id, "natural predecessor");
      const successor = await register(manager, run.run_id, "natural successor");
      const accepted = manager.start(run.run_id, start(run, root, "natural-predecessor"));
      await closed(store, run.run_id, accepted.execution_id);
      const next = start(run, successor, "natural-successor");
      if (status === "completed") (await manager.retireForHandoff(run.run_id, next, accepted.execution_id, undefined))();
      else await expect(manager.retireForHandoff(run.run_id, next, accepted.execution_id, undefined)).rejects.toMatchObject({ code: "precondition_failed" });
      expect(manager.get(run.run_id, { execution_id: accepted.execution_id })?.status).toBe(status === "completed" ? "succeeded" : status);
    });

  test("a caught held read failure retires before any recovery capability or child", async () => {
    const entered = deferred<void>(), release = deferred<void>();
    let effects = 0, refused = 0;
    const { store, run, manager } = fixture(async (_source, _args, handle, _limits, signal) => {
      try { await handle(read); } catch {}
      expect(signal.aborted).toBe(true);
      for (const request of [action, { kind: "call", skill: { name: "read fallback" }, args: null }] satisfies SkillCapabilityRequest[]) {
        try { await handle(request); } catch { refused++; }
      }
      return completed;
    }, {
      queryCapability: async () => { entered.resolve(); await release.promise; throw new RuntimeFault("precondition_failed", "Read unavailable"); },
      action: async () => { effects++; return success; },
    });
    const child = await register(manager, run.run_id, "read fallback");
    const root = await register(manager, run.run_id, "read failure predecessor", [child]);
    const next = start(run, child, "read-failure-successor");
    const accepted = manager.start(run.run_id, start(run, root, "read-failure-predecessor"));
    await entered.promise;
    const retiring = manager.retireForHandoff(run.run_id, next, accepted.execution_id, undefined);
    release.resolve();
    (await retiring)();
    expect(refused).toBe(2);
    expect(effects).toBe(0);
    expect(store.skillExecutions(run.run_id)).toHaveLength(1);
    expect(manager.get(run.run_id, { execution_id: accepted.execution_id })).toMatchObject({ status: "cancelled", calls: 1 });
  });

  for (const status of ["failed", "unknown", "cancelled"] as const)
    test(`a held action's real ${status} receipt is not relabeled as successful retirement`, async () => {
      const entered = deferred<void>(), release = deferred<void>();
      const receipt: GameActionResult = { status, summary: "Truthful native receipt", evidence: { effect_confirmed: false } };
      let returned: Json | undefined, effects = 0, lateRefusals = 0;
      const { store, run, manager } = fixture(async (_source, _args, handle) => {
        try { returned = await handle(action); } catch {}
        try { await handle(action); } catch { lateRefusals++; }
        return completed;
      }, { action: async () => { effects++; entered.resolve(); await release.promise; return receipt; } });
      const root = await register(manager, run.run_id, "receipt predecessor");
      const successor = await register(manager, run.run_id, "receipt successor");
      const accepted = manager.start(run.run_id, start(run, root, "receipt-predecessor"));
      await entered.promise;
      const retiring = manager.retireForHandoff(run.run_id, start(run, successor, "receipt-successor"), accepted.execution_id, undefined);
      if (status === "failed") {
        release.resolve();
        (await retiring)();
        expect(returned).toEqual({ status, summary: receipt.summary, evidence: receipt.evidence });
      } else {
        const refused = retiring.then(() => null, error => error);
        release.resolve();
        expect(await refused).toBeInstanceOf(Error);
        expect(returned).toBeUndefined();
      }
      expect(effects).toBe(1);
      expect(lateRefusals).toBe(1);
      expect(manager.get(run.run_id, { execution_id: accepted.execution_id })?.status).toBe(status === "unknown" ? "unknown" : "cancelled");
      expect(store.skillExecutions(run.run_id)).toHaveLength(1);
    });

  test("scope mismatch refuses handoff without touching the admitted action", async () => {
    const entered = deferred<void>(), release = deferred<void>();
    let aborted = false;
    const { store, run, manager } = fixture(async (_source, _args, handle) => {
      await handle(action);
      return completed;
    }, { action: async (_execution, _action, signal) => {
      entered.resolve(); await release.promise; aborted = signal.aborted; return success;
    } });
    const root = await register(manager, run.run_id, "scope predecessor");
    const next = await register(manager, run.run_id, "scope successor");
    const accepted = manager.start(run.run_id, start(run, root, "scope-predecessor"));
    await entered.promise;
    await expect(manager.retireForHandoff(run.run_id, { ...start(run, next, "scope-successor"), life_id: run.life_id! + 1 },
      accepted.execution_id, undefined)).rejects.toThrow();
    expect(manager.effectScope(accepted.execution_id)).not.toBeNull();
    release.resolve();
    await closed(store, run.run_id, accepted.execution_id);
    expect(aborted).toBe(false);
    expect(manager.get(run.run_id, { execution_id: accepted.execution_id })?.status).toBe("succeeded");
  });

  test("retired guards retain current scope, latest root, signal and lost-ack barriers", async () => {
    let invocations = 0;
    const { store, run, manager } = fixture(async () => { invocations++; return completed; });
    const root = await register(manager, run.run_id, "guard predecessor");
    const successor = await register(manager, run.run_id, "guard successor");
    const accepted = manager.start(run.run_id, start(run, root, "guard-predecessor"));
    await closed(store, run.run_id, accepted.execution_id);
    const controller = new AbortController();
    const request = start(run, successor, "guard-successor");
    const guard = await manager.retireForHandoff(run.run_id, request, accepted.execution_id, controller.signal);
    run.life_id = run.life_id! + 1;
    expect(guard).toThrow();
    run.life_id = accepted.life_id;
    guard();
    const next = manager.start(run.run_id, request);
    expect(manager.start(run.run_id, request).execution_id).toBe(next.execution_id);
    expect(guard).toThrow();
    await closed(store, run.run_id, next.execution_id);
    expect(invocations).toBe(2);
    const nextGuard = await manager.retireForHandoff(run.run_id, start(run, root, "guard-third"), next.execution_id, controller.signal);
    controller.abort();
    expect(nextGuard).toThrow();
    expect(store.skillExecutions(run.run_id)).toHaveLength(2);
  });

  test("unconfirmed leaf cleanup cannot acknowledge semantic retirement or a successor", async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const { store, run, manager } = fixture(async (_source, _args, handle) => {
      await handle(action);
      throw new SkillCleanupError();
    }, { action: async () => { entered.resolve(); await release.promise; return success; } });
    const root = await register(manager, run.run_id, "unsafe predecessor");
    const next = await register(manager, run.run_id, "unsafe successor");
    const accepted = manager.start(run.run_id, start(run, root, "unsafe-predecessor"));
    await entered.promise;
    const retiring = manager.retireForHandoff(run.run_id, start(run, next, "unsafe-successor"), accepted.execution_id, undefined);
    const refused = retiring.then(() => null, error => error);
    release.resolve();
    expect(await refused).toBeInstanceOf(Error);
    expect(manager.get(run.run_id, { execution_id: accepted.execution_id })?.status).toBe("unknown");
    expect(store.skillExecutions(run.run_id)).toHaveLength(1);
  });
});
