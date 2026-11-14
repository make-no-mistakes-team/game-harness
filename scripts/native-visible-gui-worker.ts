import { randomUUID } from "node:crypto";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AuthManager } from "../src/server/auth.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { ActionArbiter } from "../src/server/action-arbiter.ts";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import { bounded, requireProof, until } from "../src/evaluation/native-game.ts";
import { minecraftActionSchema } from "../src/shared/minecraft.ts";
import type { VisibleGuiHarness } from "./native-visible-gui.ts";

// This is an explicitly labeled isolated zero-model test program, not actor
// authorship, retrieved gameplay experience, or an autonomous competence claim.
const source = `
// Explicit evaluator-authored isolated zero-model API fixture. No autonomous
// gameplay competence, reusable actor policy, retrieval, or experience claim.
const reads = [], receipts = [];
const read = async () => {
  const view = await game.screen(); reads.push(view);
  if (!view || view.screen_kind !== "inventory") throw new Error("Current inventory GUI required");
  return view;
};
const act = async action => {
  const result = await game.action(action); receipts.push({action,result});
  if (result.status !== "succeeded") throw new Error("No retry after unsettled GUI effect: "+JSON.stringify(result));
  return result;
};
try {
if (await game.screen() !== null) throw new Error("Fixture must begin with absent GUI");
const initialFeedback = await game.frame(null);
if (initialFeedback.screen !== null || initialFeedback.inventory.source !== "client_prediction")
  throw new Error("Initial actual feedback must preserve absent GUI and prediction provenance");
await act({kind:"world_input",steps:[{ticks:1,
  held:{forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false},
  edges:[{kind:"button",button:"inventory",phase:"press",count:1}],view:{kind:"unchanged"},selected_hotbar:null}]});
const click = async (id,button) => {
  const view = await read(), slot = view.slots.find(s=>s.enabled&&s.slot_id===id);
  if (!slot) throw new Error("Chosen slot no longer visible");
  await act({kind:"screen_input",screen:view.identity,operations:[{kind:"slot",slot_id:id,button,mode:"ordinary",hotbar_slot:null,
    expected_cursor:view.cursor,expected_slots:[{slot_id:id,value:slot.value}]}]});
};
let view = await read();
const inventoryFeedback = await game.frame(initialFeedback.audible.next_cursor);
if (inventoryFeedback.frame_seq <= initialFeedback.frame_seq || inventoryFeedback.screen?.screen_kind !== "inventory")
  throw new Error("Real worker feedback did not capture the opened current inventory");
// This fixture deliberately chooses a closed recipe book before direct grid
// work; the harness itself never closes a persisted book implicitly.
if (view.elements.some(element=>element.kind==="recipe"||element.kind==="text")) {
  const toggle = view.elements.find(element=>element.enabled&&element.text==="recipe_book_toggle");
  if (!toggle) throw new Error("Open recipe book has no current visible toggle");
  await act({kind:"screen_input",screen:view.identity,operations:[{kind:"element",element_id:toggle.element_id,button:"left"}]});
  view = await read();
  if (view.elements.some(element=>element.kind==="recipe"||element.kind==="text")) throw new Error("Authored recipe-book close did not settle");
}
const supplied = view.slots.find(s=>s.enabled&&s.slot_id>=9&&s.slot_id<45&&s.value.item==="oak_planks"&&s.value.count===4);
if (!supplied || view.cursor.item!==null) throw new Error("Four supplied own planks and empty cursor required");
for (const id of [1,2,3,4]) {
  const slot = view.slots.find(s=>s.enabled&&s.slot_id===id);
  if (!slot || slot.value.item!==null) throw new Error("Prepared 2x2 cell not visibly empty");
}
await click(supplied.slot_id,"left");
for (const id of [1,2,3,4]) await click(id,"right");
view = await read();
if (!view.slots.some(s=>s.slot_id===0&&s.value.item==="crafting_table"&&s.value.count===1)) throw new Error("No real visible crafting result");
await click(0,"left"); view = await read();
if (view.cursor.item!=="crafting_table" || view.cursor.count!==1 || view.slots.some(s=>s.slot_id>=9&&s.slot_id<45&&s.value.item==="crafting_table"))
  throw new Error("Production must first enter actual cursor custody, not possession");
// Ordinary close returns the actual carried result to own inventory. A fresh
// observation, not this program's returned status, drives the builtin verifier.
await act({kind:"screen_input",screen:view.identity,operations:[{kind:"close"}]});
const final = await game.observe();
return {status:"completed",summary:"Synthetic isolated GUI fixture only; trusted Runtime verifies separately",result:{reads,receipts,final}};
} catch (error) {
  return {status:"blocked",summary:"Synthetic GUI fixture stopped without retry: "+String(error),result:{reads,receipts}};
}
`;

/** Real SDK dispatch, generated source, Store, Runtime and Docker/native effects. */
export async function runVisibleGuiWorkerCase(entry: Record<string, unknown>, ctx: VisibleGuiHarness) {
  entry.classification = "Explicit synthetic isolated worker API test; evaluator source, zero model/provider/Jev calls, no experience promotion or competence claim";
  entry.generated_source = source;
  entry.actual_provider_calls = 0; entry.actual_jev_calls = 0;
  const transcript: Array<Record<string, unknown>> = []; entry.sdk_transcript = transcript;
  entry.setup = await ctx.setup(["give @a minecraft:oak_planks 4"]);
  const before = await ctx.fixture.observe(); entry.before = before;
  requireProof(before.data.player.inventory.reduce((n, stack) => n + (stack.name === "oak_planks" ? stack.count : 0), 0) === 4 &&
    !before.data.player.inventory.some(stack => stack.name === "crafting_table"), "Worker fixture starts with four planks and no table");
  // Intentional module-loading boundary: Runtime/Sandbox config captures the
  // fixture's private root, which NativeFixture.create selects before this call.
  // Static imports would bind the operator's data directory before isolation.
  const { Store } = await import("../src/server/store.ts");
  const { Runtime } = await import("../src/server/runtime.ts");
  const { SandboxService } = await import("../src/server/sandbox.ts");
  const store = new Store(ctx.fixture.root);
  ctx.afterNativeClose(() => store.close());
  let runtime: Runtime | undefined, sandbox: SandboxService | undefined;
  let runId: string | undefined, admitted = false;
  let active: Promise<void> = Promise.resolve(), failure: unknown;
  const admission = Promise.withResolvers<void>(); void admission.promise.catch(() => {});
  const waiters = new Set<() => void>();
  const modelId = "zero-provider-visible-gui-fixture";
  const auth = {
    snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: "Synthetic isolated GUI fixture, no provider",
      models: [{ id: modelId, name: modelId, provider: "private-diagnostic", context_window: null }], login: null, error: null }),
    createAgent: async (options: { tools: AgentTool[] }) => {
      let gate: Parameters<Agent["setBeforeModelCall"]>[0] | undefined, cancelled = false;
      let tools = [...options.tools];
      const hooks = new DiagnosticModelHooks();
      const api = {
        beforeToolCall: undefined as Agent["beforeToolCall"],
        addBeforeModelCallHook: hooks.add,
        setBeforeModelCall: (hook: Parameters<Agent["setBeforeModelCall"]>[0]) => { gate = hook; },
        subscribe: () => () => {}, replaceMessages: () => {}, setTools: (next: AgentTool[]) => { tools = [...next]; },
        abort: () => { cancelled = true; for (const release of waiters) release(); waiters.clear(); },
        waitForIdle: async () => { await active.catch(() => {}); },
        prompt: (text: string) => {
          cancelled = false;
          active = (async () => {
            const request = JSON.parse(text) as { phase?: string; role?: string };
            if (cancelled) return;
            await hooks.run(ctx.signal, { systemPrompt: [], messages: [], tools });
            const permission = await gate?.({ systemPrompt: [], messages: [], tools });
            if (permission?.stop || cancelled) return;
            // Match the existing DiagnosticAgent: returning an effect-free
            // review turn lets the real Runtime finish its verified-goal drain.
            if (request.role === "review" || request.phase === "reviewing") return;
            if (admitted) {
              const waiting = Promise.withResolvers<void>(); waiters.add(waiting.resolve);
              if (cancelled) waiting.resolve();
              try { await waiting.promise; } finally { waiters.delete(waiting.resolve); }
              return;
            }
            admitted = true;
            const tool = tools.find(candidate => candidate.name === "program_submit"); requireProof(tool, "Real SDK program_submit unavailable");
            const args = { name: "Synthetic isolated visible GUI crafting", source, args: null,
              limits: { duration_ms: Math.min(ctx.caps.runMs, 60_000), max_actions: 9, max_calls: 32, max_depth: 1 } };
            const toolCall = { type: "toolCall" as const, id: `visible-gui-${randomUUID()}`, name: tool.name, arguments: args };
            const assistantMessage: AssistantMessage = { role: "assistant", content: [toolCall], api: "openai-codex-responses",
              provider: "private-diagnostic", model: modelId, stopReason: "toolUse", timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            const accepted = await api.beforeToolCall?.({ tool, toolCall, args, assistantMessage,
              context: { systemPrompt: [], messages: [assistantMessage], tools } });
            requireProof(!cancelled && !(accepted && "block" in accepted && accepted.block), "Real SDK gate fenced the synthetic GUI fixture");
            const result = await tool.execute(toolCall.id, accepted?.args ?? args);
            transcript.push({ name: tool.name, args, details: result.details, isError: result.isError === true });
            requireProof(!result.isError, `Real SDK source admission failed: ${JSON.stringify(result.details)}`);
            admission.resolve();
          })().catch(error => { failure ??= error; admission.reject(error); });
          return active;
        },
      };
      // Deliberately synthetic strategist only; all tools, validation, admission,
      // worker calls and native effects are the unchanged production owners.
      return api as unknown as Agent;
    },
    releaseAgent: async (agent: Agent) => { agent.abort(); await agent.waitForIdle(); },
  } as unknown as AuthManager;
  const arbiterBefore = ActionArbiter.current(ctx.fixture.bridge), effectStart = ctx.effects.length;
  try {
    sandbox = new SandboxService(ctx.fixture.project, () => {});
    await bounded(sandbox.prepare(), ctx.caps.startMs, "Real Docker worker preparation timed out");
    entry.sandbox = sandbox.snapshot(); requireProof(sandbox.snapshot().status === "ready", "Real isolated Docker runtime unavailable");
    runtime = new Runtime(store, auth, ctx.fixture.bridge, sandbox, () => {}, {
      adapter: () => ctx.fixture.bridge.adapter(), strategicAgentFactory: auth,
    });
    requireProof(!arbiterBefore || ActionArbiter.current(ctx.fixture.bridge) === arbiterBefore, "Runtime replaced the sole native bridge arbiter");
    await runtime.initialize();
    const goal = ctx.fixture.bridge.adapter()?.goals.find(goal => goal.goal_id === "craft_crafting_table");
    requireProof(goal?.verifier, "Registered builtin craft_crafting_table goal unavailable"); entry.declared_goal = goal;
    const run = await runtime.createRun({ task: "Synthetic isolated visible-GUI API crafting acceptance, not model competence", goal, model_id: modelId, working_programs: "fresh" });
    runId = run.run_id; entry.run_id = runId;
    const commandsBefore = ctx.fixture.commands.length;
    await runtime.control(runId, "start");
    await bounded(admission.promise, 20_000, "Synthetic real SDK dispatch did not admit a root");
    await until(async () => {
      if (failure) throw failure;
      requireProof(!ctx.signal.aborted, "Worker GUI fixture authority closed");
      const events = store.eventsAfter(runId!, 0, 500);
      if (!events.some(event => event.type === "goal.verified")) {
        const root = store.allSkillExecutions(runId!).find(execution =>
          execution.status === "failed" || execution.status === "blocked" || execution.status === "cancelled" || execution.status === "unknown");
        requireProof(!root, `Actual worker root ended without GUI verification: ${root?.result?.summary ?? root?.status}`);
      }
      return events;
    }, events => events.some(event => event.type === "goal.verified"), ctx.caps.runMs,
    "Actual builtin Runtime goal verifier never confirmed GUI production plus fresh retention");
    await until(async () => store.getRun(runId!), run => run?.status === "completed", ctx.caps.cleanupMs, "Verified GUI run did not reach completed and drain");
    entry.run = store.getRun(runId); entry.executions = store.allSkillExecutions(runId); entry.events = store.eventsAfter(runId, 0, 500);
    requireProof(store.allSkillExecutions(runId).length === 1, "Fixture must admit exactly one real root, without retries or replay");
    requireProof(ctx.fixture.commands.length === commandsBefore, "Privileged fixture intervention occurred during the worker run");
    const effects = ctx.effects.slice(effectStart); entry.worker_effects = effects;
    const actions = effects.map(effect => minecraftActionSchema.parse(effect.action));
    const screenActions = actions.filter(action => action.kind === "screen_input");
    requireProof((effects.length === 8 || effects.length === 9) &&
      effects.every(effect => effect.envelope.invocation.kind === "skill" && effect.result.status === "succeeded") &&
      actions.filter(action => action.kind === "world_input").length === 1 &&
      screenActions.filter(action => action.operations[0]?.kind === "slot").length === 6 &&
      screenActions.filter(action => action.operations[0]?.kind === "close").length === 1 &&
      screenActions.filter(action => action.operations[0]?.kind === "element").length === effects.length - 8,
      "Expected inventory open, optional authored book close, six real slot clicks and explicit close; no helper or diagnostic effect");
    ctx.production(effectStart, "crafting", "crafting_table", 1);
    const after = await ctx.fixture.observe(); entry.retention_observation = after;
    requireProof(after.life.status === "alive" && after.data.player.inventory.reduce((n, stack) => n + (stack.name === "crafting_table" ? stack.count : 0), 0) === 1 &&
      !after.data.player.inventory.some(stack => stack.name === "oak_planks") && await ctx.maybeRead() === null,
      "Worker GUI source lacks fresh retained table/input consumption/normal close");
    entry.independent_server_check = await ctx.server('if data entity @a[limit=1] Inventory[{id:"minecraft:crafting_table",count:1}] unless items entity @a[limit=1] inventory.* minecraft:oak_planks unless items entity @a[limit=1] hotbar.* minecraft:oak_planks', "Worker actual table retained after GUI crafting, four planks consumed");
  } catch (error) { failure ??= error; }
  finally {
    for (const release of waiters) release(); waiters.clear();
    try { if (runtime) await bounded(runtime.close(), ctx.caps.cleanupMs, "Worker Runtime close did not drain"); } catch (error) { failure ??= error; }
    try { await bounded(active, ctx.caps.cleanupMs, "Synthetic SDK caller did not close"); } catch (error) { failure ??= error; }
    if (runId) { entry.run = store.getRun(runId); entry.executions = store.allSkillExecutions(runId); entry.events = store.eventsAfter(runId, 0, 500); }
    entry.worker_effects = ctx.effects.slice(effectStart);
    try { if (sandbox) await bounded(sandbox.close(), ctx.caps.cleanupMs, "Docker worker cleanup did not drain"); } catch (error) { failure ??= error; }
    entry.store_lifecycle = "Store remains open solely for native diagnostic-context restoration; afterNativeClose owns its final close";
  }
  if (failure) throw failure;
}
