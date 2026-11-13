import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { Json, RunUsage } from "../shared/contracts.ts";
import { ProviderUsageCollector } from "./provider-usage.ts";
import { recordCall, recordUsage } from "./usage.ts";
import { randomUUID } from "node:crypto";
import { compileToolArgumentBudget } from "./tool-argument-budget.ts";
import { createToolArgumentKeyBudget } from "./tool-argument-key-budget.ts";
import { canonicalContractJson } from "./adapter-contract.ts";
import { PreparedSourceFault, preparationFailure } from "./prepared-source-error.ts";
import { Buffer } from "node:buffer";

type Attempt = { id: string; usage: ProviderUsageCollector; stream: boolean };
/** Captures an admitted request at the actual stream invocation, never a mutable latest-request SSE callback. */
export class PreparedInference {
  private attempt: Attempt | null = null;
  private readonly responseOwners = new Map<string, string>();
  private readonly streams = new Set<{ close(): Promise<unknown>; drained: Promise<void> }>();
  private readonly openings = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;
  private failed = false;
  private stop: string | null = null;
  private readonly toolOwners = new Map<string, { request: string; name: string; args: unknown }>();
  constructor(agent: Agent, private readonly usage: RunUsage,
    private readonly append: (type: string, data: Json) => void,
    private readonly admit: () => void, private readonly current: () => void,
    private readonly sealed: () => boolean, private readonly budget: () => Json) {
    agent.setBeforeModelCall((_context, signal) => {
      try {
        if (signal?.aborted) throw new PreparedSourceFault("Preparation inference cancelled");
        this.current();
        if (this.sealed()) { this.stop = "prepared_source_sealed"; return { stop: true, reason: this.stop }; }
        if (this.failed) throw new PreparedSourceFault("Previous provider request failed; no continuation is authorized");
        if (this.attempt) throw new PreparedSourceFault("Previous prepared model request has not settled");
        this.admit();
        const id = randomUUID();
        this.attempt = { id, usage: new ProviderUsageCollector(id, this.responseOwners), stream: false };
        recordCall(this.usage, "authoring");
        this.append("model.request", { request_id: id, model_id: agent.state.model.id,
          purpose: "authoring", provider_attempt_count: null, subscription_cost: null });
      } catch (error) {
        this.stop = preparationFailure(error).error;
        return { stop: true, reason: this.stop };
      }
    });
    const stream = agent.streamFn;
    agent.streamFn = async (model, context, options) => {
      const opening = Promise.withResolvers<void>();
      this.openings.add(opening.promise);
      try {
      const attempt = this.attempt;
      if (!attempt || attempt.stream) throw new PreparedSourceFault("No exact prepared request owns this stream");
      this.current(); attempt.stream = true;
      const budgets = new Map(context.tools?.map(tool => [tool.name, compileToolArgumentBudget(tool.parameters)]));
      const schemas = new Map(context.tools?.map(tool => [tool.name, tool.parameters]));
      const keyBudgets = new Map<number, { append(text: string): unknown } | null>();
      const reject = (reason: string) => {
        this.failed = true; this.stop = reason; agent.abort(reason);
        this.append("model.resource_rejected", { request_id: attempt.id, reason });
      };
      // Dispatch-local context leaves immutable tool receipts and Agent history
      // unchanged. The next request gets a fresh allowance, not an old snapshot.
      const budgetMessage = { role: "user" as const, timestamp: Date.now(),
        content: [{ type: "text" as const, text: JSON.stringify({ preparation_budget: this.budget() }) }] };
      this.append("model.budget_context", { request_id: attempt.id, message: budgetMessage });
      const events = await stream(model, { ...context, messages: [...context.messages, budgetMessage] }, { ...options, onSseEvent: (event, eventModel) => {
        attempt.usage.observe(event, eventModel ?? model); options?.onSseEvent?.(event, eventModel);
      } });
      const iterator = events[Symbol.asyncIterator]();
      const drained = Promise.withResolvers<void>(); void drained.promise.catch(() => {});
      let exhausted = false, closed = false, closing: Promise<IteratorResult<never>> | null = null;
      let responseBytes = 0;
      let pending: IteratorResult<AssistantMessageEvent> | undefined;
      const done = { done: true as const, value: undefined as never };
      const owned = { drained: drained.promise, close: () => close() };
      const finish = (natural: boolean) => {
        this.append("model.transport_closed", { request_id: attempt.id, naturally_exhausted: natural });
        closed = true;
        this.streams.delete(owned); drained.resolve();
      };
      const close = (): Promise<IteratorResult<never>> => {
        if (closing) return closing;
        closing = (async () => {
          try {
            if (!exhausted && !closed) {
              if (!iterator.return) throw new PreparedSourceFault("Prepared model stream has no confirmable iterator closure");
              const result = await iterator.return();
              if (!result.done) throw new PreparedSourceFault("Prepared model stream did not confirm iterator closure");
            }
            if (!closed) finish(false);
            return done;
          } catch (error) { drained.reject(error); throw error; }
        })();
        return closing;
      };
      const wrapped = {
        next: async () => {
          if (closed || closing) return done;
          try {
            const result = pending ?? await iterator.next(); pending = undefined;
            if (result.done) { exhausted = true; if (!closed) finish(true); return result; }
            if ("delta" in result.value && typeof result.value.delta === "string") {
              responseBytes += Buffer.byteLength(result.value.delta, "utf8");
              if (responseBytes > 1024 * 1024) {
                reject("Prepared response exceeds the finite one-MiB streamed text/argument budget");
                throw new PreparedSourceFault("Prepared response exceeds its finite byte budget");
              }
            }
            if (result.value.type === "toolcall_delta" || result.value.type === "toolcall_end") {
              const event = result.value;
              if (event.partial.content.filter(content => content.type === "toolCall").length > 48)
                reject("Prepared response exceeds the finite tool-call envelope");
              for (const content of event.partial.content) if (content.type === "toolCall" &&
                (budgets.get(content.name)?.(content.arguments) || JSON.stringify(content.arguments).length > 1048576))
                reject("Prepared tool arguments exceed their advertised generation budget");
              if (event.type === "toolcall_delta") {
                const call = event.partial.content[event.contentIndex];
                if (!keyBudgets.has(event.contentIndex)) keyBudgets.set(event.contentIndex,
                  call?.type === "toolCall" ? createToolArgumentKeyBudget(schemas.get(call.name)) : null);
                if (keyBudgets.get(event.contentIndex)?.append(event.delta))
                  reject("Prepared tool argument keys exceed their advertised generation budget");
              }
            }
            if (result.value.type === "done" || result.value.type === "error") {
              const tail = await iterator.next();
              if (tail.done) { exhausted = true; if (!closed) finish(true); }
              else pending = tail;
              // The SDK may dispatch a tool before its queued message_end
              // reaches Agent subscribers. Bind the terminal provider JSON
              // before yielding it to that dispatcher, not in the observer.
              if (result.value.type === "done") this.bindTools(attempt, result.value.message);
            }
            return result;
          } catch (error) { await close(); throw error; }
        },
        return: close,
      };
      this.streams.add(owned);
      events[Symbol.asyncIterator] = () => wrapped;
      return events;
      } finally { this.openings.delete(opening.promise); opening.resolve(); }
    };
    agent.beforeToolCall = (context, signal) => {
      try {
        this.current();
        if (this.sealed() || signal?.aborted || this.failed) throw new PreparedSourceFault("Prepared source tool authority ended");
        const owner = this.toolOwners.get(context.toolCall.id);
        if (!owner || owner.name !== context.tool.name) throw new PreparedSourceFault("Tool has no successful selected-model response owner");
        // Preserve original model JSON rather than SDK type healing.
        if (context.args !== owner.args && context.args && typeof context.args === "object") {
          for (const key of Object.keys(context.args)) delete context.args[key];
          if (owner.args && typeof owner.args === "object" && !Array.isArray(owner.args)) Object.assign(context.args, owner.args);
          else context.args.__invalid_prepared_arguments = true;
        }
      } catch (error) { return { block: true, reason: preparationFailure(error).error }; }
    };
    this.unsubscribe = agent.subscribe(event => this.event(event));
  }
  requestFor(callId: string, tool: string): string {
    const owner = this.toolOwners.get(callId);
    if (!owner || owner.name !== tool) throw new PreparedSourceFault("Tool call is not attributable to an admitted selected-model response");
    return owner.request;
  }
  private bindTools(attempt: Attempt, message: AssistantMessage): void {
    if (!["stop", "toolUse"].includes(message.stopReason) ||
      message.stopDetails?.type === "stream_interrupted_after_content") return;
    for (const content of message.content) if (content.type === "toolCall") {
      const previous = this.toolOwners.get(content.id);
      if (previous && (previous.request !== attempt.id || previous.name !== content.name ||
        canonicalContractJson(previous.args) !== canonicalContractJson(content.arguments))) {
        this.failed = true;
        this.append("model.tool_identity_conflict", { request_id: attempt.id, call_id: content.id });
      } else this.toolOwners.set(content.id, { request: attempt.id, name: content.name, args: structuredClone(content.arguments) });
    }
  }
  private event(event: AgentEvent): void {
    if (event.type === "message_end" && event.message.role === "toolResult") {
      this.append("model.tool_result", { request_id: this.toolOwners.get(event.message.toolCallId)?.request ?? null,
        message: event.message as unknown as Json });
      return;
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const message = event.message, attempt = this.attempt;
    if (!attempt) return; // Typed pre-model host stop did not dispatch a provider request.
    const good = ["stop", "toolUse"].includes(message.stopReason) && message.stopDetails?.type !== "stream_interrupted_after_content";
    if (!good) this.failed = true;
    if (good) this.bindTools(attempt, message);
    if (message.usage) recordUsage(this.usage, "authoring", message.usage);
    this.append("model.settled", { request_id: attempt.id, stop_reason: message.stopReason,
      provider_response_id: message.responseId ?? null, successful_response: good,
      usage_evidence: attempt.usage.finish(message.usage) as unknown as Json,
      content: message.content as unknown as Json, subscription_cost: null });
    this.attempt = null;
  }
  async drain(): Promise<void> {
    while (this.openings.size) await Promise.all([...this.openings]);
    const settled = await Promise.allSettled([...this.streams].flatMap(stream => [stream.close(), stream.drained]));
    const failure = settled.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (this.attempt) {
      this.append("model.unsettled", { request_id: this.attempt.id,
        usage_evidence: this.attempt.usage.finish(null) as unknown as Json, provider_attempt_count: null, subscription_cost: null });
      this.attempt = null;
    }
    this.unsubscribe();
  }
}
