import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { parse, type Node } from "acorn";
import type {
  ProgramBranchTrace,
  ProgramInstrumentation,
  ProgramSourcePoint,
  ProgramTraceLossReason,
} from "../shared/program-trace.ts";

export const PROGRAM_TRACE_LIMITS = Object.freeze({ events: 256, bytes: 16384 });

interface SyntaxNode extends Node {
  [key: string]: unknown;
}
function isNode(value: unknown): value is SyntaxNode {
  return !!value && typeof value === "object" && "type" in value &&
    typeof (value as Node).type === "string";
}

export interface InstrumentedProgram extends ProgramInstrumentation {
  /** Private execution derivative: never persist this as model-authored source. */
  execution_source: string;
  hook_name: string;
  scope: string;
}

/** Wrap values, not control flow: native JS still owns truthiness, await and order. */
export function instrumentProgram(source: string): InstrumentedProgram {
  const prefix = 'async function __body(game,args){"use strict";\n';
  const tree = parse(prefix + source + "\n}", { ecmaVersion: "latest", locations: true });
  const identifiers = new Set<string>();
  const conditions: { node: SyntaxNode; kind: ProgramSourcePoint["kind"] }[] = [];
  const pending: SyntaxNode[] = [tree as unknown as SyntaxNode];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "Identifier") identifiers.add(node.name as string);
    let kind: ProgramSourcePoint["kind"] | undefined;
    let expression = node.test;
    switch (node.type) {
      case "IfStatement": kind = "if"; break;
      case "ConditionalExpression": kind = "conditional"; break;
      case "WhileStatement": kind = "while"; break;
      case "DoWhileStatement": kind = "do_while"; break;
      case "ForStatement": kind = "for"; break;
      case "LogicalExpression":
        expression = node.left;
        kind = node.operator === "&&" ? "logical_and" :
          node.operator === "||" ? "logical_or" : "logical_nullish";
        break;
    }
    if (kind && isNode(expression)) conditions.push({ node: expression, kind });
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (isNode(value)) pending.push(value);
      else if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) pending.push(child);
      }
    }
  }
  let hook_name: string;
  do hook_name = `__trace_${randomUUID().replaceAll("-", "")}`;
  while (identifiers.has(hook_name));
  conditions.sort((a, b) => a.node.start - b.node.start || b.node.end - a.node.end);
  const points: ProgramSourcePoint[] = conditions.map(({ node, kind }, point_id) => ({
    point_id,
    kind,
    start: node.start - prefix.length,
    end: node.end - prefix.length,
    line: node.loc!.start.line - 1,
    column: node.loc!.start.column,
  }));
  // Insertion ranges may share an edge (nested logical expressions). Open the
  // outer wrapper first and close the inner first; never replace source bytes.
  const edits: { offset: number; text: string; opening: boolean; other: number; id: number }[] = [];
  for (const point of points) {
    edits.push({ offset: point.start, text: `${hook_name}(${point.point_id},(`,
      opening: true, other: point.end, id: point.point_id });
    edits.push({ offset: point.end, text: "))", opening: false,
      other: point.start, id: point.point_id });
  }
  edits.sort((a, b) => a.offset - b.offset || Number(a.opening) - Number(b.opening) ||
    (a.opening ? b.other - a.other || a.id - b.id : b.other - a.other || b.id - a.id));
  let execution_source = "";
  let cursor = 0;
  for (const edit of edits) {
    execution_source += source.slice(cursor, edit.offset) + edit.text;
    cursor = edit.offset;
  }
  execution_source += source.slice(cursor);
  return {
    source_hash: createHash("sha256").update(source).digest("hex"),
    points, execution_source, hook_name, scope: randomUUID(),
  };
}

/** Host-side framing checks cannot make compromised-container diagnostics trusted. */
export class ProgramTraceReceiver {
  private events = 0;
  private bytes = 0;
  private finished = false;
  constructor(private readonly program: InstrumentedProgram) {}

  accept(value: unknown): ProgramBranchTrace {
    if (this.finished) throw new Error("Branch trace execution already ended.");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid branch trace.");
    const trace = value as Record<string, unknown>;
    if (Object.keys(trace).length !== 3 || trace.scope !== this.program.scope ||
      !Array.isArray(trace.events) || !Number.isSafeInteger(trace.omitted) ||
      (trace.omitted as number) < 0)
      throw new Error("Invalid branch trace scope or framing.");
    const events: ProgramBranchTrace["events"] = [];
    for (const candidate of trace.events) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
        throw new Error("Invalid branch trace event.");
      const event = candidate as Record<string, unknown>;
      if (Object.keys(event).length !== 2 || !Number.isSafeInteger(event.point_id) ||
        !this.program.points[event.point_id as number] || typeof event.decision !== "boolean")
        throw new Error("Unknown branch trace point.");
      events.push({ point_id: event.point_id as number, decision: event.decision });
    }
    const bytes = Buffer.byteLength(JSON.stringify(events));
    if (this.events + events.length > PROGRAM_TRACE_LIMITS.events ||
      this.bytes + bytes > PROGRAM_TRACE_LIMITS.bytes)
      throw new Error("Branch trace exceeded its execution budget.");
    this.events += events.length;
    this.bytes += bytes;
    return { source_hash: this.program.source_hash, events,
      omitted: trace.omitted as number, diagnostic_only: true,
      tail_incomplete: false, loss_reason: null };
  }

  /** A validated terminal frame closes the tail; all other endings are unknown. */
  finish(reason: ProgramTraceLossReason | null): ProgramBranchTrace | null {
    if (this.finished) return null;
    this.finished = true;
    if (reason === null) return null;
    return { source_hash: this.program.source_hash, events: [], omitted: 0,
      diagnostic_only: true, tail_incomplete: true, loss_reason: reason };
  }
}
