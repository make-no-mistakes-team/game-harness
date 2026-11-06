import { randomUUID } from "node:crypto";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AuthManager } from "../src/server/auth.ts";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import { requireProof } from "../src/evaluation/native-game.ts";

// Evaluator-authored smoke programs. Never acquired/model-authored gameplay,
// operator library content, experience, or a competence/improvement assertion.
const prelude = `
const neutral={forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false};
const world=(held=neutral,edges=[],selected_hotbar=null)=>({kind:"world",held,edges,view:{kind:"unchanged"},selected_hotbar});
const result=(input,next_state,status="running")=>({input,next_state,status,events:[]});
`;

export const residentBowSource = `${prelude}
export function step(frame,state,intent) {
  const s=state;
  if(frame.screen!==null) throw new Error("Bow fixture requires ordinary world input");
  const ack=frame.last_input;
  if(s.phase==="start") return result(world({...neutral,use:true},[{kind:"button",button:"use",phase:"press",count:1}],0),{phase:"holding",first_tick:frame.native_tick,last_use:null,samples:[],release_sequence:null});
  if(s.phase==="holding") {
    if(ack&&ack.held.use) {
      const use=frame.player.active_use;
      if(!use||use.item!=="bow") throw new Error("Applied use lost actual vanilla bow use");
      if(s.last_use!==null&&use.elapsed_ticks<s.last_use) throw new Error("Bow use restarted without an authored release");
      s.last_use=use.elapsed_ticks;
      if(s.samples.length===0||frame.native_tick-s.samples[s.samples.length-1].tick>=10) {
        if(s.samples.length>=48) throw new Error("Finite bow evidence capacity exhausted");
        s.samples.push({tick:frame.native_tick,frame:frame.frame_seq,elapsed:use.elapsed_ticks,sequence:ack.sequence,prefix:ack.ordered_edge_prefix});
      }
    }
    if(intent.release) {
      if(!ack||!ack.held.use||s.samples.length<2) throw new Error("Release needs actual prior applied held use");
      s.phase="releasing";s.release_sequence=ack.sequence;
      return result(world(neutral,[{kind:"button",button:"use",phase:"release",count:1}]),s);
    }
    return result(world({...neutral,use:true}),s);
  }
  if(s.phase==="releasing"&&ack&&ack.sequence>s.release_sequence&&!ack.held.use&&frame.player.active_use===null) {
    s.phase="released";return result(world(),s,"completed");
  }
  return result(world(),s);
}
`;

export const residentGuiSource = `${prelude}
const waitInput=frame=>frame.screen?{kind:"screen",screen:frame.screen.identity,operations:[]}:world();
export function step(frame,state,intent) {
  const s=state;
  if(frame.effect_updates_omitted!==0) throw new Error("No omitted GUI receipt may be guessed");
  if(s.pending!==null) {
    if(s.pending.sequence===null&&frame.last_input&&frame.last_input.sequence>s.pending.after)
      s.pending.sequence=frame.last_input.sequence;
    const receipt=frame.effect_updates.find(r=>r.sequence===s.pending.sequence);
    if(!receipt) return result(waitInput(frame),s);
    if(receipt.result.status!=="succeeded") throw new Error("Actual later GUI effect not confirmed: "+receipt.result.status);
    s.receipts.push({phase:s.phase,sequence:receipt.sequence,recorded_native_ns:receipt.recorded_native_ns});
    s.phase=s.pending.next;s.pending=null;
  }
  const screen=frame.screen;
  if(s.phase==="start") {
    if(screen!==null) throw new Error("GUI fixture must start with absent screen");
    s.phase="opening";
    return result(world(neutral,[{kind:"button",button:"inventory",phase:"press",count:1},{kind:"button",button:"inventory",phase:"release",count:1}]),s);
  }
  if(s.phase==="opening") {
    if(!screen||!frame.last_input||frame.last_input.input_application!=="confirmed"||frame.last_input.ordered_edge_prefix<2)
      return result(waitInput(frame),s);
    s.phase="book";
  }
  if(s.phase==="done") {
    if(screen!==null) throw new Error("Authored close did not actually settle");
    return result(world(),s,"completed");
  }
  if(!screen||screen.screen_kind!=="inventory") throw new Error("Current visible own inventory required");
  const send=(operation,next)=>{
    s.pending={sequence:null,after:frame.last_input?frame.last_input.sequence:0,next};
    return result({kind:"screen",screen:screen.identity,operations:[operation]},s);
  };
  const slot=id=>{
    const value=screen.slots.find(v=>v.enabled&&v.slot_id===id);
    if(!value) throw new Error("Expected current enabled visible slot absent");
    return value;
  };
  const click=(id,button,next)=>{
    const target=slot(id);
    return send({kind:"slot",slot_id:id,button,mode:"ordinary",hotbar_slot:null,expected_cursor:screen.cursor,expected_slots:[{slot_id:id,value:target.value}]},next);
  };
  if(s.phase==="book") {
    if(screen.elements.some(e=>e.kind==="recipe"||e.kind==="text")) {
      const toggle=screen.elements.find(e=>e.enabled&&e.text==="recipe_book_toggle");
      if(!toggle) throw new Error("Visible open recipe book lacks its toggle");
      return send({kind:"element",element_id:toggle.element_id,button:"left"},"pickup");
    }
    s.phase="pickup";
  }
  if(s.phase==="pickup") {
    if(screen.cursor.item!==null) throw new Error("Initial visible cursor is not empty");
    const supplied=screen.slots.find(v=>v.enabled&&v.slot_id>=9&&v.slot_id<45&&v.value.item==="oak_planks"&&v.value.count===4);
    if(!supplied) throw new Error("Exactly four supplied own planks required");
    for(const id of [1,2,3,4]) if(slot(id).value.item!==null) throw new Error("Prepared 2x2 cell not empty");
    return click(supplied.slot_id,"left","cell1");
  }
  if(s.phase==="cell1"||s.phase==="cell2"||s.phase==="cell3"||s.phase==="cell4") {
    const id=Number(s.phase.slice(4));
    if(screen.cursor.item!=="oak_planks"||screen.cursor.count!==5-id||slot(id).value.item!==null)
      throw new Error("Fresh cursor/grid predicate differs from authored table recipe");
    return click(id,"right",id===4?"take":"cell"+(id+1));
  }
  if(s.phase==="take") {
    if(screen.cursor.item!==null||slot(0).value.item!=="crafting_table"||slot(0).value.count!==1)
      throw new Error("No actual one-table 2x2 result");
    return click(0,"left","close");
  }
  if(s.phase==="close") {
    if(screen.cursor.item!=="crafting_table"||screen.cursor.count!==1||screen.slots.some(v=>v.slot_id>=9&&v.slot_id<45&&v.value.item==="crafting_table"))
      throw new Error("Actual result must first be carried, not possession-only completion");
    return send({kind:"close"},"done");
  }
  throw new Error("Unknown authored GUI phase");
}
`;

export const residentThrowSource = `${prelude}
export function step(frame,state,intent) {
  if(state.pressed&&frame.last_input&&frame.last_input.held.use) throw new Error("P06 authored worker throw after actual native ownership");
  if(!state.pressed) return result(world({...neutral,use:true},[{kind:"button",button:"use",phase:"press",count:1}],0),{pressed:true});
  return result(world({...neutral,use:true}),state);
}
`;
export const residentStopSource = `${prelude}
export function step(frame,state,intent) {
  if(intent.compute) { for(;;) {} }
  if(!state.pressed) return result(world({...neutral,use:true},[{kind:"button",button:"use",phase:"press",count:1}],0),{pressed:true});
  return result(world({...neutral,use:true}),state);
}
`;
export const residentColdFailureSource = `${prelude}
throw new Error("P06 authored cold module failure before native grant");
export function step(frame,state,intent) { return result(world(),state); }
`;
export const residentInactiveSource = `${prelude}
export function step(frame,state,intent) { return result(world(),state,"yielded"); }
`;

/** Synthetic SDK caller only. Runtime owns every offered tool, gate, publication,
 * selected immutable entry, sandbox and native effect. No provider is created. */
export class ResidentSdkCaller {
  readonly modelId = "zero-provider-p06-resident-evaluator";
  readonly transcript: Array<Record<string, unknown>> = [];
  private tools: AgentTool[] = [];
  private agent: Agent | null = null;
  private ready = Promise.withResolvers<void>();
  private stopped = false;
  private active: Promise<void> = Promise.resolve();
  private waiters = new Set<() => void>();
  private permission = false;
  readonly auth: AuthManager;
  constructor() {
    const caller = this;
    this.auth = {
      snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: "Evaluator synthetic SDK only; zero provider",
        models: [{ id: caller.modelId, name: caller.modelId, provider: "private-diagnostic", context_window: null }], login: null, error: null }),
      createAgent: async (options: { tools: AgentTool[] }) => {
        let gate: Parameters<Agent["setBeforeModelCall"]>[0] | undefined;
        const hooks = new DiagnosticModelHooks();
        caller.tools = [...options.tools]; caller.stopped = false;
        const api = {
          beforeToolCall: undefined as Agent["beforeToolCall"],
          addBeforeModelCallHook: hooks.add,
          setBeforeModelCall: (hook: Parameters<Agent["setBeforeModelCall"]>[0]) => { gate = hook; },
          subscribe: () => () => {}, replaceMessages: () => {},
          setTools: (tools: AgentTool[]) => { caller.tools = [...tools]; },
          abort: () => { caller.stopped = true; caller.permission = false; for (const release of caller.waiters) release(); caller.waiters.clear(); },
          waitForIdle: async () => { await caller.active; },
          prompt: (text: string) => {
            caller.active = (async () => {
              const request = JSON.parse(text) as { role?: string; phase?: string };
              requireProof(gate, "Actual SDK before-model gate was not installed");
              await hooks.run(undefined, { systemPrompt: [], messages: [], tools: caller.tools });
              const permission = await gate({ systemPrompt: [], messages: [], tools: caller.tools });
              caller.transcript.push({ kind: "synthetic_request", prompt: text, permission, at_host_ms: performance.now(),
                offered_tools: caller.tools.map(tool => ({ name: tool.name, parameters: tool.parameters })) });
              if (permission?.stop || caller.stopped) return;
              if (request.role === "review" || request.phase === "reviewing") return;
              caller.permission = true; caller.ready.resolve();
              const waiting = Promise.withResolvers<void>(); caller.waiters.add(waiting.resolve);
              if (caller.stopped) waiting.resolve();
              try { await waiting.promise; } finally { caller.waiters.delete(waiting.resolve); caller.permission = false; }
            })();
            return caller.active;
          },
        };
        caller.agent = api as unknown as Agent;
        return caller.agent;
      },
      releaseAgent: async (agent: Agent) => { agent.abort(); await agent.waitForIdle(); },
    } as unknown as AuthManager;
  }
  async waitReady() { await this.ready.promise; }
  async finishTurn() {
    // A real Agent can end its tool-using request while the admitted resident
    // keeps running. The next outcome wake then obtains fresh ordinary evidence.
    for (const release of this.waiters) release();
    await this.active;
  }
  async call(name: string, args: Record<string, unknown>) {
    requireProof(this.agent && this.permission && !this.stopped, "No active real strategic request for synthetic SDK dispatch");
    const tool = this.tools.find(candidate => candidate.name === name);
    requireProof(tool, `Actual offered SDK tool unavailable: ${name}`);
    const toolCall = { type: "toolCall" as const, id: `p06-resident-${randomUUID()}`, name, arguments: args };
    const assistantMessage: AssistantMessage = { role: "assistant", content: [toolCall], api: "openai-codex-responses",
      provider: "private-diagnostic", model: this.modelId, stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    requireProof(this.agent.beforeToolCall, "Actual SDK beforeToolCall gate was not installed");
    const accepted = await this.agent.beforeToolCall({ tool, toolCall, args, assistantMessage,
      context: { systemPrompt: [], messages: [assistantMessage], tools: this.tools } });
    this.transcript.push({ kind: "before_tool_call", tool_call: toolCall, assistant_message: assistantMessage,
      accepted, at_host_ms: performance.now(), cancelled: this.stopped });
    requireProof(!this.stopped && !(accepted && "block" in accepted && accepted.block), "Actual SDK beforeToolCall fenced dispatch");
    const started = performance.now();
    const response = await tool.execute(toolCall.id, accepted?.args ?? args);
    this.transcript.push({ kind: "tool_result", tool_call_id: toolCall.id, name, args, started_host_ms: started,
      ended_host_ms: performance.now(), response, isError: response.isError === true });
    requireProof(!response.isError, `Actual SDK tool refused ${name}: ${JSON.stringify(response.details)}`);
    return response.details;
  }
}
