import { streamSimple, type AssistantMessage, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { CodexApiError } from "@oh-my-pi/pi-ai/providers/openai-codex/response-handler";
import { createCodexProviderStreamError } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { StreamFn } from "@oh-my-pi/pi-agent-core/types";
import { $flag } from "@oh-my-pi/pi-utils";

/** Explicit evaluation condition; ordinary application agents never install it. */
export function assertSingleDispatchEnvironment(): void {
  if ($flag("PI_CODEX_WEBSOCKET"))
    throw new Error("Single-dispatch evaluation requires SSE; unset PI_CODEX_WEBSOCKET or set it to 0 before starting");
}

/** One invocation is one admitted model call, including every SDK recovery lane. */
export const singleDispatchCodexStream: StreamFn = (model, context, options) => {
  assertSingleDispatchEnvironment();
  if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses" || model.transport === "pi-native")
    throw new Error("Single-dispatch evaluation supports only direct openai-codex-responses SSE");
  const controller = new AbortController();
  const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const fetch = options?.fetch ?? globalThis.fetch;
  const resolver = options?.apiKey;
  let dispatched = false;
  let originalFailure: { error: unknown; category?: string } | undefined;
  let refusedRecovery: Error | undefined;
  const bounded: SimpleStreamOptions = {
    ...options,
    signal,
    preferWebsockets: false,
    codexSseMaxAttempts: 1,
    // Initial resolution still uses the selected-account resolver unchanged.
    // Refusing replay resolution preserves the SDK's first auth failure and
    // never refreshes/rotates an account merely to replay this admission.
    apiKey: typeof resolver === "function" ? async resolution => {
      if (dispatched) throw new Error("Evaluation inference already dispatched; authentication replay refused");
      return resolver(resolution);
    } : resolver,
    fetch: async (input, init) => {
      // Set synchronously before awaiting: concurrent SDK lanes share the fence.
      if (dispatched) {
        refusedRecovery ??= new Error("Evaluation inference already dispatched; recovery replay refused");
        controller.abort(originalFailure?.error ?? refusedRecovery);
        throw refusedRecovery;
      }
      dispatched = true;
      try {
        // A followed 307/308 would bypass the fence inside native fetch.
        // Manual redirects surface their original HTTP failure instead.
        const response = await fetch(input, { ...init, redirect: "manual" });
        if (!response.ok) {
          const error = await CodexApiError.fromResponse(response.clone());
          originalFailure ??= { error, category: error.info.code };
        }
        return response;
      } catch (error) {
        originalFailure ??= { error };
        throw error;
      }
    },
    onSseEvent: (event, eventModel) => {
      // Use the provider's parser/formatter, not a parallel provider schema.
      // Diagnostics can run ahead of published deltas: aborting here would
      // discard preceding partial output buffered by the SDK. The fetch fence
      // stops recovery before network and then cancels its request-owned signal.
      try {
        const raw: unknown = JSON.parse(event.data);
        if (raw && typeof raw === "object" && "type" in raw && (raw.type === "error" || raw.type === "response.failed")) {
          const error = createCodexProviderStreamError(raw as Record<string, unknown>);
          originalFailure ??= { error, category: error.code };
        }
      } catch {
        // Non-JSON diagnostics remain the SDK parser's responsibility.
      }
      options?.onSseEvent?.(event, eventModel);
    },
  };
  const inner = streamSimple(model, context, bounded);
  const outer = new AssistantMessageEventStream();
  outer.forwardLocalWorkFrom(inner);
  const terminal = async (message: AssistantMessage): Promise<AssistantMessage> => {
    let result = message;
    const retainedFailure = originalFailure ?? (refusedRecovery
      ? { error: refusedRecovery, category: "host_recovery_replay_refused" } : undefined);
    if (retainedFailure && !options?.signal?.aborted) {
      // Our private transport cancellation is not operator cancellation. Retain
      // the first provider error instead of reporting the rejected replay (or
      // the abort used to stop it) as a different provider outcome.
      // Without an exposed original provider error (e.g. EOF), report the
      // host's refusal with unknown provider status, not an operator abort.
      const failure = await AIError.finalize(retainedFailure.error, {
        api: model.api, provider: model.provider, model: model.id,
      });
      result = { ...message, stopReason: "error", errorMessage: failure.message,
        errorStatus: failure.status, errorId: failure.id,
        errorClassificationMessage: retainedFailure.category ?? message.errorClassificationMessage };
    }
    if (result.stopReason !== "error" || !result.content.some(block => block.type === "toolCall")) return result;
    // Agent otherwise promotes completed calls in transient failed turns to
    // toolUse and clears their errors. These calls were never authorized to
    // execute after provider failure. Keep their streamed/raw evidence intact;
    // remove only terminal dispatch eligibility, without mutating partials.
    const rejected = "Evaluation rejected unexecuted tool calls because their provider request failed.";
    return { ...result, content: result.content.filter(block => block.type !== "toolCall"),
      stopDetails: { ...result.stopDetails,
        type: result.stopDetails?.type ?? "evaluation_failed_tool_calls_rejected",
        explanation: result.stopDetails?.explanation ? `${result.stopDetails.explanation}\n${rejected}` : rejected } };
  };
  void (async () => {
    try {
      for await (const event of inner) {
        if (event.type === "error" || event.type === "done") {
          const message = await terminal(event.type === "error" ? event.error : event.message);
          if (message.stopReason === "error" || message.stopReason === "aborted")
            outer.push({ type: "error", reason: message.stopReason, error: message });
          else if (event.type === "done") outer.push({ ...event, message });
          else outer.push(event);
        } else outer.push(event);
      }
      outer.end(await terminal(await inner.result()));
    } catch (error) {
      outer.fail(error);
    } finally {
      outer.forwardLocalWorkFrom(undefined);
    }
  })();
  return outer;
};
