import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { Json } from "../src/shared/contracts.ts";
import type { ProgramBranchTrace, ProgramTraceLossReason } from "../src/shared/program-trace.ts";
import { instrumentProgram, ProgramTraceReceiver } from "../src/server/program-instrumentation.ts";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";

const adapter = minecraftTestAdapter();

/** Exercise the real inner worker protocol, not a production isolation fallback. */
async function execute(
  source: string,
  broker: (request: Record<string, unknown>) => Promise<Json> = async () => null,
  interruptAtCall?: ProgramTraceLossReason,
) {
  const program = instrumentProgram(source);
  const receiver = new ProgramTraceReceiver(program);
  const traces: ProgramBranchTrace[] = [];
  const requests: Record<string, unknown>[] = [];
  let failure = false;
  const state: { terminalFrame: Record<string, unknown> | null } = { terminalFrame: null };
  const worker = new Worker(new URL("../sandbox/worker.mjs", import.meta.url), {
    workerData: { mode: "skill", source: program.execution_source, source_hash: program.source_hash, args: null,
      api: { api_version: 4, action_enabled: true, supports_respawn: true, bindings: adapter.bindings },
      instrumentation: { hook_name: program.hook_name, scope: program.scope,
        kinds: program.points.map((point) => point.kind) } },
    stdout: true, stderr: true,
  });
  const done = Promise.withResolvers<Json>();
  let stopping = false;
  let termination: Promise<number> | null = null;
  function terminate(): Promise<number> {
    if (termination) return termination;
    stopping = true;
    // This guards real platform worker shutdown, not model timing. Fake timers
    // cannot make a native thread exit or acknowledge termination.
    const acknowledged = Promise.resolve(worker.terminate());
    termination = new Promise<number>((resolve, reject) => {
      const deadline = AbortSignal.timeout(1000);
      const expired = () => {
        worker.unref();
        reject(new Error("Worker termination acknowledgement did not arrive."));
      };
      deadline.addEventListener("abort", expired, { once: true });
      acknowledged.then(
        (code) => { deadline.removeEventListener("abort", expired); resolve(code); },
        (error) => { deadline.removeEventListener("abort", expired); reject(error); },
      );
    });
    return termination;
  }
  // An external fixture watchdog prevents an unresponsive worker from retaining
  // the test process after the runner abandons this promise. Native abort
  // deadlines do not depend on another test's mocked global setTimeout/clock.
  const watchdog = AbortSignal.timeout(3000);
  const expired = () => done.reject(new Error("Worker fixture did not reach its protocol boundary."));
  watchdog.addEventListener("abort", expired, { once: true });
  worker.on("error", done.reject);
  worker.on("exit", () => {
    if (stopping) return;
    const loss = receiver.finish(interruptAtCall ?? "worker_terminated");
    if (loss) {
      // Match the host contract: diagnostic loss is delivered before done.
      traces.push(loss);
      failure = true;
      done.resolve(null);
    }
  });
  worker.on("message", (encoded: string) => {
    void (async () => {
      const frame = JSON.parse(encoded);
      traces.push(receiver.accept(frame.trace));
      if (frame.type === "skill_call") {
        requests.push(frame.request);
        if (interruptAtCall) {
          await terminate();
          const loss = receiver.finish(interruptAtCall);
          if (loss) traces.push(loss);
          failure = true;
          done.resolve(null);
          return;
        }
        try {
          const value = await broker(frame.request);
          worker.postMessage({ v: 1, type: "skill_reply", id: frame.id, ok: true, value });
        } catch (error) {
          const safe = error as { code: string; message: string };
          worker.postMessage({ v: 1, type: "skill_reply", id: frame.id, ok: false,
            error: { code: safe.code, message: safe.message } });
        }
      } else if (frame.type === "skill_result" || frame.type === "skill_failure") {
        receiver.finish(null);
        state.terminalFrame = frame;
        failure = frame.type === "skill_failure";
        done.resolve(failure ? null : frame.result);
      }
      else throw new Error("Unexpected worker frame");
    })().catch(done.reject);
  });
  try {
    const result = await done.promise;
    return { result, traces, requests, program, failure, terminalFrame: state.terminalFrame };
  } finally {
    watchdog.removeEventListener("abort", expired);
    try {
      // Every path shares the same acknowledgement; never call terminate again
      // from finally while an interrupt callback is still awaiting that exit.
      await terminate();
    } finally {
      worker.unref();
      worker.stdout?.destroy();
      worker.stderr?.destroy();
    }
  }
}

test("conditions evaluate getters and side effects once in native order", async () => {
  const { result, traces, program } = await execute(`
const order = [];
let reads = 0;
const object = { get value() { reads++; order.push("get"); return { marker: 7 }; } };
if (object.value) order.push("then");
const selected = object.value ? order.push("yes") : order.push("no");
return { reads, order, selected };
`);
  expect(result).toEqual({ reads: 2, order: ["get", "then", "get", "yes"], selected: 4 });
  expect(traces.flatMap((trace) => trace.events)).toEqual([
    { point_id: program.points.find((point) => point.kind === "if")!.point_id, decision: true },
    { point_id: program.points.find((point) => point.kind === "conditional")!.point_id, decision: true },
  ]);
});

test("short circuit and nullish branches retain values without evaluating skipped operands", async () => {
  const { result, traces } = await execute(`
const order = [];
const take = (value) => { order.push(value); return value; };
const a = take(0) && take("skip-and");
const b = take("kept") || take("skip-or");
const c = take(0) ?? take("skip-nullish");
const d = take(null) ?? take("fallback");
const nested = (take(false) || take("inner")) && take("outer");
return { a, b, c, d, nested, order };
`);
  expect(result).toEqual({ a: 0, b: "kept", c: 0, d: "fallback", nested: "outer",
    order: [0, "kept", 0, null, "fallback", false, "inner", "outer"] });
  expect(traces.flatMap((trace) => trace.events).map((event) => event.decision))
    .toEqual([false, true, true, false, false, true]);
});

test("loop tests include terminal false decisions and preserve continue and break", async () => {
  const { result, traces, program } = await execute(`
let checks = 0;
let total = 0;
for (let i = 0; ++checks <= 4; i++) { if (i === 1) continue; total += i; }
let j = 0;
while (j < 2) j++;
do { total++; } while (false);
return { checks, total, j };
`);
  expect(result).toEqual({ checks: 5, total: 6, j: 2 });
  const events = traces.flatMap((trace) => trace.events);
  const decisions = (kind: string) => events.filter((event) =>
    program.points[event.point_id]!.kind === kind).map((event) => event.decision);
  expect(decisions("for")).toEqual([true, true, true, true, false]);
  expect(decisions("while")).toEqual([true, true, false]);
  expect(decisions("do_while")).toEqual([false]);
});

test("await conditions suspend before tracing and retain capability and microtask order", async () => {
  const order: string[] = [];
  const { result, traces, requests, program } = await execute(`
const order = [];
if (await game.observe()) order.push("observed");
const selected = (await game.recipes("fixture")) && order.push("recipe");
await Promise.resolve().then(() => order.push("microtask"));
return { order, selected };
`, async (request) => {
    order.push(String(request.kind));
    await Promise.resolve();
    return request.kind === "observe" ? true : "recipe-value";
  });
  expect(order).toEqual(["observe", "adapter"]);
  expect(requests[1]).toEqual({ kind: "adapter", capability_id: "minecraft.recipes", version: 1, args: { item: "fixture" } });
  expect(requests).toHaveLength(2);
  expect(result).toEqual({ order: ["observed", "recipe", "microtask"], selected: 2 });
  expect(traces.map((trace) => trace.events.length)).toEqual([0, 1, 1]);
  expect(program.points.map((point) => [point.line, point.column])).toEqual([[3, 4], [4, 18]]);
});

test("throwing getters and rejected await conditions are not recorded as invented decisions", async () => {
  const { result, traces } = await execute(`
let reads = 0;
const order = [];
const object = { get value() { reads++; throw new Error("getter"); } };
try { if (object.value) order.push("unreachable"); } catch (error) { order.push(error.message); }
try { if (await Promise.reject(new Error("await"))) order.push("unreachable"); } catch (error) { order.push(error.message); }
const value = { get [Symbol.toPrimitive]() { throw new Error("must not coerce"); } };
if (value) order.push("truthy object");
return { reads, order };
`);
  expect(result).toEqual({ reads: 1, order: ["getter", "await", "truthy object"] });
  expect(traces.flatMap((trace) => trace.events).map((event) => event.decision)).toEqual([true]);
});

test("instrumentation does not invoke a model-installed serialization getter while testing values", async () => {
  const { result, traces } = await execute(`
let touched = 0;
Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get() { touched++; return undefined; } });
let count = 0;
while (count < 3) count++;
delete Object.prototype.toJSON;
return { count, touched };
`);
  expect(result).toEqual({ count: 3, touched: 0 });
  expect(traces.flatMap((trace) => trace.events)).toHaveLength(4);
});

test("model bindings, comments, templates and source hash stay canonical artifacts", async () => {
  const source = `// Preserve this model-authored artifact.\nconst __body = 3;\nconst __trace_00000000000000000000000000000000 = 5;\nconst text = \`raw \\n // comment text\`;\nif (__body < __trace_00000000000000000000000000000000) return { text, value: __body };\nreturn null;\n`;
  const { result, program, traces } = await execute(source);
  expect(result).toEqual({ text: "raw \n // comment text", value: 3 });
  expect(program.source_hash).toBe(createHash("sha256").update(source).digest("hex"));
  expect(traces[0]!.source_hash).toBe(program.source_hash);
  expect(program.points[0]).toMatchObject({ line: 5, column: 4, kind: "if" });
});

test("trace budget truncates actual loop events and reports omissions across capability batches", async () => {
  const { result, traces } = await execute(`
let count = 0;
while (count < 400) count++;
await game.progress("Intent only", { count });
while (count < 410) count++;
return count;
`);
  expect(result).toBe(410);
  expect(traces.flatMap((trace) => trace.events)).toHaveLength(256);
  expect(traces.reduce((sum, trace) => sum + trace.omitted, 0)).toBe(156);
  expect(traces.every((trace) => trace.diagnostic_only)).toBe(true);
});

test("diagnostic overhead does not consume the original model result budget or serialize getters twice", async () => {
  const { result, traces } = await execute(`
let count = 0;
while (count < 260) count++;
let serialized = 0;
return { toJSON() { serialized++; return { text: "x".repeat(64000), serialized }; } };
`);
  expect((result as { text: string }).text).toHaveLength(64000);
  expect((result as { serialized: number }).serialized).toBe(1);
  expect(traces.flatMap((trace) => trace.events)).toHaveLength(256);
  expect(traces[0]!.omitted).toBe(5);
});

test("explicit respawn is one awaited controlled capability, never an ambient effect", async () => {
  const { result, requests } = await execute(`
const response = await game.respawn();
return { response, hasProcess: typeof game.process, hasFetch: typeof game.fetch };
`, async (request) => {
    expect(request).toEqual({ kind: "respawn" });
    return { status: "succeeded", summary: "Host-confirmed new incarnation", evidence: null };
  });
  expect(requests).toEqual([{ kind: "respawn" }]);
  expect(result).toEqual({ response: { status: "succeeded", summary: "Host-confirmed new incarnation", evidence: null },
    hasProcess: "undefined", hasFetch: "undefined" });
});

test("host rejects unknown points, wrong execution scope, injected authority and excess diagnostics", () => {
  const program = instrumentProgram("if (true) return 1; return 0;");
  const receiver = new ProgramTraceReceiver(program);
  const frame = { scope: program.scope, events: [{ point_id: 0, decision: true }], omitted: 0 };
  expect(() => receiver.accept({ ...frame, scope: "another-execution" })).toThrow();
  expect(() => receiver.accept({ ...frame, events: [{ point_id: 999, decision: true }] })).toThrow();
  expect(() => receiver.accept({ ...frame, goal_complete: true })).toThrow();
  expect(() => receiver.accept({ ...frame, events: [{ point_id: 0, decision: true, effect_confirmed: true }] })).toThrow();
  expect(() => receiver.accept({ ...frame, omitted: -1 })).toThrow();
  const accepted = receiver.accept(frame);
  expect(accepted).toEqual({ source_hash: program.source_hash, events: frame.events, omitted: 0,
    diagnostic_only: true, tail_incomplete: false, loss_reason: null });
  expect(() => receiver.accept({ ...frame, events: Array.from({ length: 256 }, () => frame.events[0]) })).toThrow();
});

test("real worker failure retains bounded generated exception and source identity without host stacks", async () => {
  const { failure, traces, terminalFrame, program } = await execute(`
if (true) throw new TypeError("Expected an observation object");
return null;
`);
  expect(failure).toBe(true);
  expect(traces.flatMap((trace) => trace.events).map((event) => event.decision)).toEqual([true]);
  expect(traces.every((trace) => !trace.tail_incomplete && trace.loss_reason === null)).toBe(true);
  expect(terminalFrame?.diagnostic).toMatchObject({ type: "TypeError", message: "Expected an observation object", source_hash: program.source_hash });
  const diagnostic = terminalFrame?.diagnostic as { location: { mapping: string; line?: number } };
  expect(["canonical", "unmapped"]).toContain(diagnostic.location.mapping);
  if (diagnostic.location.mapping === "canonical") expect(diagnostic.location.line).toBe(2);
  expect(JSON.stringify(terminalFrame)).not.toContain("worker.mjs");
  expect(JSON.stringify(terminalFrame)).not.toContain("node:internal");
  expect(diagnostic).not.toHaveProperty("stack");
});

test("real worker capability rejection preserves trusted code and useful message", async () => {
  const outcome = await execute(`
try { await game.observe(); }
catch (error) { return { code: error.code, message: error.message }; }
return null;
`, async () => { throw Object.assign(new Error("Observation authority belongs to an earlier life"), { code: "stale_context" }); });
  expect(outcome.result).toEqual({ code: "stale_context", message: "Observation authority belongs to an earlier life" });
});

test("failure diagnostics neither serialize arbitrary thrown values nor retain unbounded text", async () => {
  const object = await execute('throw { get message() { throw new Error("GETTER_MUST_NOT_RUN"); }, secret: "THROWN_OBJECT_SECRET", toJSON() { return "SERIALIZER_MUST_NOT_RUN"; } };');
  expect(object.failure).toBe(true);
  expect(object.terminalFrame?.diagnostic).toBeDefined();
  const serialized = JSON.stringify(object.terminalFrame);
  for (const privateValue of ["GETTER_MUST_NOT_RUN", "THROWN_OBJECT_SECRET", "SERIALIZER_MUST_NOT_RUN"]) expect(serialized).not.toContain(privateValue);
  const large = await execute('throw new Error("x".repeat(10000));');
  const diagnostic = large.terminalFrame?.diagnostic as { message: string };
  expect(diagnostic.message.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(diagnostic.message)).toBeLessThanOrEqual(1000);
});

test("unhandled rejected await retains prior conditions but never invents the rejected condition", async () => {
  const { failure, traces } = await execute(`
if (true) await Promise.resolve();
if (await Promise.reject(new Error("private rejection"))) return null;
return null;
`);
  expect(failure).toBe(true);
  expect(traces.flatMap((trace) => trace.events).map((event) => event.decision)).toEqual([true]);
  expect(traces[0]).toMatchObject({ omitted: 0, tail_incomplete: false, loss_reason: null });
});

test("controlled failure preserves exact budget omissions independently of unknown tails", async () => {
  const { failure, traces } = await execute(`
let count = 0;
while (count < 400) count++;
throw new Error("private fixture failure");
`);
  expect(failure).toBe(true);
  expect(traces.flatMap((trace) => trace.events)).toHaveLength(256);
  expect(traces[0]).toMatchObject({ omitted: 145, tail_incomplete: false, loss_reason: null });
});

test("unawaited capability settles once before controlled failure flushes its trace", async () => {
  let observations = 0;
  const { failure, requests, traces } = await execute(`
if (true) game.observe();
throw new Error("private fixture failure");
`, async () => {
    observations++;
    return null;
  });
  expect(failure).toBe(true);
  expect(observations).toBe(1);
  expect(requests).toEqual([{ kind: "observe" }]);
  expect(traces.flatMap((trace) => trace.events)).toHaveLength(1);
  expect(traces.every((trace) => !trace.tail_incomplete)).toBe(true);
});

test("forced worker termination publishes unknown tail before done without fabricating omitted count", async () => {
  for (const reason of ["cancelled", "duration_limit", "worker_terminated"] as const) {
    let brokerCalls = 0;
    const { failure, traces } = await execute(`
if (true) await game.observe();
if (false) return null;
return null;
`, async () => {
      brokerCalls++;
      return null;
    }, reason);
    expect(failure).toBe(true);
    expect(brokerCalls).toBe(0);
    expect(traces[0]!.events.map((event) => event.decision)).toEqual([true]);
    expect(traces.at(-1)).toEqual({
      source_hash: traces[0]!.source_hash, events: [], omitted: 0,
      diagnostic_only: true, tail_incomplete: true, loss_reason: reason,
    });
  }
});

test("execution closure emits at most one unknown tail and rejects stale batches", () => {
  const program = instrumentProgram("if (true) return null;");
  const receiver = new ProgramTraceReceiver(program);
  const loss = receiver.finish("protocol_failure");
  expect(loss).toMatchObject({ omitted: 0, tail_incomplete: true, loss_reason: "protocol_failure" });
  expect(receiver.finish("cancelled")).toBeNull();
  expect(() => receiver.accept({ scope: program.scope, events: [], omitted: 0 })).toThrow();
  const completed = new ProgramTraceReceiver(program);
  expect(completed.finish(null)).toBeNull();
  expect(completed.finish("cleanup_failure")).toBeNull();
});
