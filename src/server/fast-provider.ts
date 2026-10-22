import type { PolicyContext, PolicyDecision } from "../shared/contracts.ts";
export interface FastJudgeSelection {
  model_id: string;
  request_timeout_ms: number;
}
export interface FastJudgeBroker {
  /** App-owned judge selection, independent of the strategic model's identity. */
  selection(): FastJudgeSelection;
  evaluate(request: {
    model_id: string;
    instruction: string;
    choices: { id: string; decision: PolicyDecision }[];
    context: PolicyContext;
    request_id: string;
    deadline_at: number;
    signal: AbortSignal;
  }): Promise<{
    choice_id: string;
    known_cost: number | null;
    actual_calls: number;
    usage: {
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
    } | null;
    provider_request_id: string | null;
  }>;
}
