/** Locations refer only to the immutable canonical model-authored function body. */
export interface ProgramSourcePoint {
  point_id: number;
  kind:
    | "if"
    | "conditional"
    | "while"
    | "do_while"
    | "for"
    | "logical_and"
    | "logical_or"
    | "logical_nullish";
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface ProgramInstrumentation {
  source_hash: string;
  points: ProgramSourcePoint[];
}

export type ProgramTraceLossReason =
  | "cancelled"
  | "duration_limit"
  | "worker_terminated"
  | "protocol_failure"
  | "cleanup_failure"
  | "host_failure";

/** Untrusted execution diagnostics, never proof of effects or goal completion. */
export interface ProgramBranchTrace {
  source_hash: string;
  events: { point_id: number; decision: boolean }[];
  omitted: number;
  diagnostic_only: true;
  /** Unknown unsent tail, separate from the exact known truncation count. */
  tail_incomplete: boolean;
  loss_reason: ProgramTraceLossReason | null;
}
