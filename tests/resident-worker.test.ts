import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxService } from "../src/server/sandbox.ts";
import type { ResidentAnalysisWorker, ResidentWorker } from "../src/shared/resident.ts";
import { controllerStepResultSchema } from "../src/shared/resident.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { minecraftControllerFrameSchema } from "../src/shared/minecraft.ts";
import { validateProgramSource } from "../src/server/program-validation.ts";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";
import type { TemporalTurnOptions, TemporalTurnResult, TemporalTurnState } from "../src/shared/temporal-turn.ts";

// This exercises the shipped supervisor and untrusted module thread, not Docker
// isolation. The parent's Docker/profile proof remains a separate requirement.
const children = new Set<ChildProcessWithoutNullStreams>();
afterEach(async () => {
  await Promise.all([...children].map(async child => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = Promise.withResolvers<void>();
      child.once("close", () => exited.resolve());
      await exited.promise;
    }
    children.delete(child);
  }));
});

interface ProcessWorker {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
  read(): Promise<unknown>;
  send(frame: unknown): void;
}
function processWorker(budget = 80): ProcessWorker {
  const executable = Bun.which("node");
  if (!executable) throw new Error("The real Node worker executable is unavailable.");
  const child = spawn(executable, [new URL("../sandbox/worker.mjs", import.meta.url).pathname, "resident", String(budget)], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
  });
  children.add(child);
  const lines: unknown[] = [];
  let buffer = "", stderr = "", ended = false;
  const waiters: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line); else lines.push(line);
    }
  });
  const completion = Promise.withResolvers<number | null>();
  child.once("close", code => {
    ended = true;
    children.delete(child);
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`worker closed (${code}): ${stderr}`));
    completion.resolve(code);
  });
  child.on("error", error => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  child.stdin.on("error", () => {});
  return {
    child, closed: completion.promise,
    read(): Promise<unknown> {
      if (lines.length) return Promise.resolve(lines.shift());
      if (ended) return Promise.reject(new Error("worker closed"));
      const completion = Promise.withResolvers<unknown>();
      waiters.push(completion);
      return completion.promise;
    },
    send(frame: unknown) { child.stdin.write(JSON.stringify(frame) + "\n"); },
  };
}
async function compile(source: string, entry: "step" | "analyze" = "analyze", budget = 80) {
  const worker = processWorker(budget);
  expect(await worker.read()).toEqual({ v: 1, type: "resident_ready", id: 0 });
  worker.send({ v: 1, type: "resident_init", id: 0, entry, source });
  expect(await worker.read()).toEqual({ v: 1, type: "resident_compiled", id: 0 });
  return worker;
}
async function analyze(worker: ProcessWorker, id: number, input: unknown) {
  worker.send({ v: 1, type: "resident_analyze", id, input });
  return await worker.read();
}
const neutralInput = { kind: "world", held: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, attack: false, use: false }, edges: [], view: { kind: "unchanged" }, selected_hotbar: null };
const stepResult = `{ input: ${JSON.stringify(neutralInput)}, next_state: { count: state.count + 1, local: ++count, intent }, status: "running", events: [] }`;

test("ordinary step module compiles once and reuses module state with explicit state and intent", async () => {
  const worker = await compile(`let count = 0; const add = x => x + 1; export function step(frame, state, intent) { if (add(frame.frame_seq) !== 8) throw Error(); return ${stepResult}; }`, "step");
  worker.send({ v: 1, type: "resident_step", id: 1, frame: { frame_seq: 7 }, state: { count: 3 }, intent: "first" });
  expect(await worker.read()).toEqual({ v: 1, type: "resident_result", id: 1, value: { input: neutralInput, next_state: { count: 4, local: 1, intent: "first" }, status: "running", events: [] } });
  worker.send({ v: 1, type: "resident_step", id: 2, frame: { frame_seq: 7 }, state: { count: 4 }, intent: "second" });
  expect(await worker.read()).toMatchObject({ value: { next_state: { count: 5, local: 2, intent: "second" } } });
});

test("selected step infinite computation is still killed by its isolated 25ms watchdog", async () => {
  const worker = await compile("export function step(frame,state,intent) { for (;;) {} }", "step", 25);
  worker.send({ v: 1, type: "resident_step", id: 1, frame: {}, state: null, intent: null });
  expect(await worker.closed).not.toBe(0);
  expect(worker.child.exitCode).not.toBeNull();
});

test("analysis module is pure JSON computation without game or process capability construction", async () => {
  const worker = await compile(`let jobs = 0; export function analyze(input) { return { total: input.values.reduce((a,b) => a+b, 0), jobs: ++jobs, api: typeof game, process: typeof process, fetch: typeof fetch }; }`);
  expect(await analyze(worker, 1, { values: [2, 5, 9] })).toEqual({ v: 1, type: "resident_result", id: 1, value: { total: 16, jobs: 1, api: "undefined", process: "undefined", fetch: "undefined" } });
  expect(await analyze(worker, 2, { values: [] })).toMatchObject({ value: { jobs: 2 } });
});

async function motionWorker() {
  const source = await validateProgramSource(
    "export function analyze(input) { return motion.turn(input.options, input.state); }",
    "analyze", minecraftTestAdapter(),
  );
  return await compile(source.source);
}
async function turn(worker: ProcessWorker, id: number, options: TemporalTurnOptions, state: TemporalTurnState | null = null) {
  const reply = await analyze(worker, id, { options, state }) as { value: TemporalTurnResult };
  return reply.value;
}
const turnOptions: TemporalTurnOptions = {
  native_tick: 100, pose: { yaw_radians: 0, pitch_radians: 0 },
  target: { yaw_radians: 1, pitch_radians: 0.4 },
  duration_ticks: 20, max_rate: 4,
};

test("admitted module math accelerates and brakes on native ticks and explicitly ends its rate", async () => {
  const worker = await motionWorker();
  let state: TemporalTurnState | null = null;
  let pose = { ...turnOptions.pose };
  const rates: number[] = [];
  for (let tick = 0; tick <= 20; tick++) {
    const result = await turn(worker, tick + 1, { ...turnOptions, native_tick: 100 + tick, pose }, state);
    rates.push(result.view.yaw_radians_per_second);
    expect(result.finished).toBe(tick === 20);
    if (tick === 20) {
      expect(result.view).toEqual({ kind: "rate", yaw_radians_per_second: 0, pitch_radians_per_second: 0 });
      expect(result.aligned).toBe(true);
      expect(pose.yaw_radians).toBeCloseTo(1, 10);
      expect(pose.pitch_radians).toBeCloseTo(0.4, 10);
    }
    state = result.state;
    pose = {
      yaw_radians: pose.yaw_radians + result.view.yaw_radians_per_second * 0.05,
      pitch_radians: pose.pitch_radians + result.view.pitch_radians_per_second * 0.05,
    };
  }
  expect(rates[0]).toBeGreaterThan(0);
  expect(rates[9]).toBeGreaterThan(rates[0]! * 5);
  expect(rates[19]).toBeLessThan(rates[9]! / 5);
});

test("native clock stalls do not advance turns and actual pose overrides requested progress", async () => {
  const worker = await motionWorker();
  const first = await turn(worker, 1, turnOptions);
  const repeated = await turn(worker, 2, turnOptions, first.state);
  expect(repeated).toEqual(first);
  const advanced = await turn(worker, 3, { ...turnOptions, native_tick: 110 }, first.state);
  expect(advanced.view.yaw_radians_per_second).toBe(4);
  // A request having been emitted does not establish alignment or applied motion.
  const ended = await turn(worker, 4, { ...turnOptions, native_tick: 120 }, advanced.state);
  expect(ended.finished).toBe(true);
  expect(ended.aligned).toBe(false);
  expect(ended.error.yaw_radians).toBe(1);
  expect(ended.view.yaw_radians_per_second).toBe(0);
  const stillEnded = await turn(worker, 5, { ...turnOptions, native_tick: 130 }, ended.state);
  expect(stillEnded.finished).toBe(true);
  expect(stillEnded.view.yaw_radians_per_second).toBe(0);
  const reset = await turn(worker, 6, { ...turnOptions, native_tick: 1 }, stillEnded.state);
  expect(reset.finished).toBe(false);
  expect(reset.state.start_tick).toBe(1);
});

test("turn math chooses shortest wrapped yaw, clamps pitch and rebases explicit retargets", async () => {
  const worker = await motionWorker();
  const options = {
    ...turnOptions, pose: { yaw_radians: Math.PI - 0.1, pitch_radians: 0 },
    target: { yaw_radians: -Math.PI + 0.1, pitch_radians: 2 },
  };
  const first = await turn(worker, 1, options);
  expect(first.error.yaw_radians).toBeCloseTo(0.2, 10);
  expect(first.state.target.pitch_radians).toBe(Math.PI / 2);
  expect(first.view.yaw_radians_per_second).toBeGreaterThan(0);
  expect(first.view.yaw_radians_per_second).toBeLessThan(0.1);
  const retargeted = await turn(worker, 2, {
    ...options, native_tick: 107, pose: { yaw_radians: -Math.PI + 0.05, pitch_radians: 0.2 },
    target: { yaw_radians: Math.PI - 0.2, pitch_radians: -0.3 },
  }, first.state);
  expect(retargeted.state.start_tick).toBe(107);
  expect(retargeted.state.origin).toEqual({ yaw_radians: -Math.PI + 0.05, pitch_radians: 0.2 });
  expect(retargeted.view.yaw_radians_per_second).toBeLessThan(0);
  expect(retargeted.view.pitch_radians_per_second).toBeLessThan(0);
});

test("normal validated step can retain turn state and submit schema-valid raw view input", async () => {
  const admitted = await validateProgramSource(`export function step(frame,state,intent) {
    const turn = motion.turn({native_tick:frame.native_tick,pose:frame.view.applied_pose,
      target:intent.target,duration_ticks:intent.duration_ticks,max_rate:intent.max_rate},state);
    return {input:{...${JSON.stringify(neutralInput)},view:turn.view},
      next_state:turn.state,status:"running",events:[]};
  }`, "step", minecraftTestAdapter());
  const worker = await compile(admitted.source, "step");
  const frame = minecraftControllerFrameSchema.parse(controllerFrameFixture());
  worker.send({ v: 1, type: "resident_step", id: 1, frame, state: null, intent: turnOptions });
  const reply = await worker.read() as { value: { input: { view: TemporalTurnResult["view"] }; next_state: TemporalTurnState } };
  expect(controllerStepResultSchema.safeParse(reply.value).success).toBe(true);
  expect(reply.value.input.view.kind).toBe("rate");
  expect(reply.value.input.view.yaw_radians_per_second).toBeGreaterThan(0);
  expect(reply.value.next_state.start_tick).toBe(frame.native_tick);
  worker.send({ v: 1, type: "resident_step", id: 2,
    frame: { ...frame, native_tick: frame.native_tick + 20 },
    state: reply.value.next_state, intent: turnOptions });
  const ended = await worker.read() as { value: unknown };
  const result = controllerStepResultSchema.parse(ended.value);
  expect(result.input).toMatchObject({
    kind: "world", view: { kind: "rate", yaw_radians_per_second: 0, pitch_radians_per_second: 0 },
  });
});

test("math preserves caller state and does not claim alignment under a rate cap", async () => {
  const admitted = await validateProgramSource(`export function analyze(input) {
    const before = JSON.stringify(input);
    const result = motion.turn(input.options,input.state);
    return {result,unchanged:before===JSON.stringify(input)};
  }`, "analyze", minecraftTestAdapter());
  const worker = await compile(admitted.source);
  const first = await analyze(worker, 1, {
    options: { ...turnOptions, max_rate: 0.01, duration_ticks: 1 }, state: null,
  }) as { value: { result: TemporalTurnResult; unchanged: boolean } };
  expect(first.value.unchanged).toBe(true);
  expect(first.value.result.view.yaw_radians_per_second).toBe(0.01);
  const ended = await analyze(worker, 2, {
    options: { ...turnOptions, native_tick: 101, max_rate: 0.01, duration_ticks: 1 },
    state: first.value.result.state,
  }) as { value: { result: TemporalTurnResult; unchanged: boolean } };
  expect(ended.value.unchanged).toBe(true);
  expect(ended.value.result.finished).toBe(true);
  expect(ended.value.result.aligned).toBe(false);
  expect(ended.value.result.view.yaw_radians_per_second).toBe(0);
});

for (const [label, options, state] of [
  ["negative native clock", { ...turnOptions, native_tick: -1 }, null],
  ["fractional duration", { ...turnOptions, duration_ticks: 0.5 }, null],
  ["zero rate limit", { ...turnOptions, max_rate: 0 }, null],
  ["out-of-contract rate limit", { ...turnOptions, max_rate: 100 }, null],
  ["impossible applied pitch", { ...turnOptions, pose: { yaw_radians: 0, pitch_radians: 2 } }, null],
  ["negative tolerance", { ...turnOptions, tolerance: -1 }, null],
  ["malformed carried state", turnOptions, { start_tick: 100 }],
] as const) test(`pure turn helper rejects ${label} without emitting a control result`, async () => {
  const worker = await motionWorker();
  worker.send({ v: 1, type: "resident_analyze", id: 1, input: { options, state } });
  expect(await worker.closed).not.toBe(0);
});

test("pure math binding remains realm-local, immutable and cannot expose host constructors", async () => {
  const source = await validateProgramSource(`export function analyze(input) {
    let blocked = false;
    try { motion.turn.constructor("return process")(); } catch { blocked = true; }
    return {blocked,frozen:Object.isFrozen(motion),function_frozen:Object.isFrozen(motion.turn),
      host:typeof process,game:typeof game};
  }`, "analyze", minecraftTestAdapter()).catch(() => null);
  // The validator still fences ambient APIs; direct worker probing independently
  // exercises the runtime realm even if bypassing source admission.
  expect(source).toBeNull();
  const worker = await compile(`export function analyze(input) {
    let blocked = false;
    try { motion.turn.constructor("return process")(); } catch { blocked = true; }
    return {blocked,frozen:Object.isFrozen(motion),function_frozen:Object.isFrozen(motion.turn),
      host:typeof process,game:typeof game};
  }`);
  expect(await analyze(worker, 1, null)).toMatchObject({
    value: { blocked: true, frozen: true, function_frozen: true, host: "undefined", game: "undefined" },
  });
});

for (const [label, source] of [
  ["wrong selected export", "export function step(frame,state,intent) { return null; }"],
  ["async selected export", "export async function analyze(input) { return 1; }"],
  ["generator selected export", "export function* analyze(input) { yield 1; }"],
  ["wrong selected arity", "export function analyze() { return 1; }"],
  ["multiple exports", "export function analyze(input) { return input; } export const extra = 1;"],
  ["static import", "import fs from 'node:fs'; export function analyze(input) { return !!fs; }"],
  ["reexport import", "export { readFile as analyze } from 'node:fs';"],
  ["oversize UTF8 source", `export function analyze(input) { return 1; } /*${"é".repeat(8200)}*/`],
] as const) test(`resident compilation rejects ${label}`, async () => {
  const worker = processWorker(); await worker.read();
  worker.send({ v: 1, type: "resident_init", id: 0, entry: "analyze", source });
  expect(await worker.closed).not.toBe(0);
});

for (const [label, expression] of [
  ["promise", "Promise.resolve(1)"],
  ["thenable", "({ then() {} })"],
  ["nonfinite number", "NaN"],
  ["undefined field", "({ lost: undefined })"],
  ["bigint", "1n"],
  ["cycle", "(() => { const x = {}; x.x = x; return x; })()"],
  ["getter", "({ get value() { while (true) {} } })"],
  ["toJSON", "({ toJSON() { while (true) {} } })"],
  ["proxy serialization loop", "new Proxy({}, { ownKeys() { while (true) {} } })"],
  ["infinite computation", "(() => { while (true) {} })()"],
  ["oversize output", "'x'.repeat(65536)"],
  ["deep output", "(() => { let x = 0; for (let i=0;i<40;i++) x = [x]; return x; })()"],
  ["dynamic import", "import('node:fs')"],
] as const) test(`resident evaluation fails closed for ${label} and reaps real process`, async () => {
  const worker = await compile(`export function analyze(input) { return ${expression}; }`);
  worker.send({ v: 1, type: "resident_analyze", id: 1, input: null });
  expect(await worker.closed).not.toBe(0);
  expect(worker.child.exitCode).not.toBeNull();
});

for (const [label, frame] of [
  ["old ID", { v: 1, type: "resident_analyze", id: 0, input: null }],
  ["unsafe ID", { v: 1, type: "resident_analyze", id: 9007199254740992, input: null }],
  ["wrong version", { v: 2, type: "resident_analyze", id: 1, input: null }],
  ["wrong entry", { v: 1, type: "resident_step", id: 1, frame: {}, state: null, intent: null }],
  ["extra envelope field", { v: 1, type: "resident_analyze", id: 1, input: null, source: "ignored" }],
  ["deep input", { v: 1, type: "resident_analyze", id: 1, input: JSON.parse("[".repeat(40) + "0" + "]".repeat(40)) }],
  ["oversize input", { v: 1, type: "resident_analyze", id: 1, input: "x".repeat(262144) }],
] as const) test(`resident protocol rejects ${label}`, async () => {
  const worker = await compile("export function analyze(input) { return input; }");
  worker.send(frame);
  expect(await worker.closed).not.toBe(0);
});

test("duplicate completed request ID cannot run the module twice", async () => {
  const worker = await compile("let n = 0; export function analyze(input) { return ++n; }");
  expect(await analyze(worker, 1, null)).toMatchObject({ value: 1 });
  worker.send({ v: 1, type: "resident_analyze", id: 1, input: null });
  expect(await worker.closed).not.toBe(0);
});

test("nonfinite JSON wire number is rejected rather than normalized into null", async () => {
  const worker = await compile("export function analyze(input) { return input; }");
  worker.child.stdin.write('{"v":1,"type":"resident_analyze","id":1,"input":1e999}\n');
  expect(await worker.closed).not.toBe(0);
});

test("malformed JSON closes the real protocol stream", async () => {
  const worker = await compile("export function analyze(input) { return input; }");
  worker.child.stdin.write('{"v":1,"type":"resident_analyze","id":1,"input":}\n');
  expect(await worker.closed).not.toBe(0);
});

test("concurrent dispatch fails closed rather than queuing a second computation", async () => {
  const worker = await compile("export function analyze(input) { while (true) {} }", "analyze", 60);
  worker.child.stdin.write('{"v":1,"type":"resident_analyze","id":1,"input":null}\n{"v":1,"type":"resident_analyze","id":2,"input":null}\n');
  expect(await worker.closed).not.toBe(0);
});

test("step rejects oversize explicit state and intent before evaluating", async () => {
  for (const key of ["state", "intent"]) {
    const worker = await compile(`export function step(frame,state,intent) { return ${stepResult}; }`, "step");
    worker.send({ v: 1, type: "resident_step", id: 1, frame: {}, state: {}, intent: null, [key]: "x".repeat(16384) });
    expect(await worker.closed).not.toBe(0);
  }
});

test("step cannot return an oversize next_state even inside a bounded envelope", async () => {
  const worker = await compile(`export function step(frame,state,intent) { return { input: ${JSON.stringify(neutralInput)}, next_state: 'x'.repeat(16384), status: 'running', events: [] }; }`, "step");
  worker.send({ v: 1, type: "resident_step", id: 1, frame: {}, state: null, intent: null });
  expect(await worker.closed).not.toBe(0);
});

test("EOF aborts a hung job and close waits for the actual child exit", async () => {
  const worker = await compile("export function analyze(input) { while (true) {} }", "analyze", 500);
  worker.send({ v: 1, type: "resident_analyze", id: 1, input: null });
  worker.child.stdin.end();
  await worker.closed;
  expect(worker.child.exitCode).not.toBeNull();
});

test("unexpected worker death closes transport without a fabricated result", async () => {
  const worker = await compile("export function analyze(input) { while (true) {} }", "analyze", 500);
  worker.send({ v: 1, type: "resident_analyze", id: 1, input: null });
  const reply = worker.read();
  worker.child.kill("SIGKILL");
  await expect(reply).rejects.toThrow(/closed/);
  await worker.closed;
  expect(worker.child.signalCode).toBe("SIGKILL");
});

// Replace only the external guardian process, not DockerPolicyWorker's protocol,
// timers, selected-entry checks, accounting callback, allocation, or cleanup join.
interface HostProtocolFixture<T> { worker: T; release(): void; close(): Promise<void> }
function hostResidentProtocol(frames: unknown[], result: boolean): Promise<HostProtocolFixture<ResidentAnalysisWorker>>;
function hostResidentProtocol(frames: unknown[], result: boolean, stepDelayMs: number): Promise<HostProtocolFixture<ResidentWorker>>;
async function hostResidentProtocol(frames: unknown[], result: boolean, stepDelayMs?: number) {
  const directory = mkdtempSync(join(tmpdir(), "resident-guardian-protocol-"));
  const release = join(directory, "release");
  const guardian = join(directory, "guardian.mjs");
  writeFileSync(guardian, `
    import { createInterface } from "node:readline";
    import { existsSync } from "node:fs";
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    const lines = createInterface({ input: process.stdin });
    send({v:1,type:"resident_ready",id:0});
    lines.on("line", line => {
      const frame = JSON.parse(line);
      if (frame.type === "resident_init") send({v:1,type:"resident_compiled",id:0});
      else {
        const replies = ${JSON.stringify(frames)};
        if (${result}) replies.push({v:1,type:"resident_result",id:frame.id,value:${JSON.stringify(stepDelayMs === undefined
          ? { ok: true } : { input: neutralInput, next_state: { guarded: true }, status: "running", events: [] })}});
        const reply = () => process.stdout.write(replies.map(reply => JSON.stringify(reply) + "\\n").join(""));
        if (${stepDelayMs ?? 0}) setTimeout(reply, ${stepDelayMs ?? 0}); else reply();
      }
    });
    lines.on("close", () => {
      const drain = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(drain); process.exit(0); } }, 5);
    });
  `);
  const sandbox = new SandboxService(directory);
  // Test-only setup skips actual Docker profile preparation; actual Docker is a
  // separate parent acceptance gate. No production testing hook is introduced.
  Object.assign(sandbox, { state: { status: "ready", image: "controlled-guardian", error: null },
    runner: new URL("../sandbox/worker.mjs", import.meta.url).pathname, guardian });
  const worker = stepDelayMs === undefined
    ? await sandbox.createResidentAnalysisWorker("export function analyze(input) { return input; }", 1000, new AbortController().signal)
    : await sandbox.createResidentWorker("export function step(frame,state,intent) { return null; }", 25, new AbortController().signal);
  return { worker, release() { writeFileSync(release, "drained"); }, async close() {
    writeFileSync(release, "drained"); await sandbox.close(); rmSync(directory, { recursive: true, force: true });
  } };
}
const evaluationFrame = { v: 2, type: "guardian_analysis_evaluated", id: 1, entry: "analyze", elapsed_ms: 7, outcome: "result" };

test("host step response delay is not charged to the independent isolated computation budget", async () => {
  const f = await hostResidentProtocol([], true, 60);
  f.release();
  try {
    expect(await f.worker.step(minecraftControllerFrameSchema.parse(controllerFrameFixture()), null, null)).toMatchObject({ next_state: { guarded: true } });
  } finally { await f.close(); }
});

test("host step response remains finitely bounded when the external guardian never replies", async () => {
  const f = await hostResidentProtocol([], false, 0);
  f.release();
  let settled = false;
  const outcome = f.worker.step(minecraftControllerFrameSchema.parse(controllerFrameFixture()), null, null).then(
    () => { settled = true; return null; },
    error => { settled = true; return error; },
  );
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    expect(await outcome).toBeInstanceOf(Error);
  } finally { await f.close(); }
});

test("trusted guardian timing and result may share transport chunk without duplicate evaluation reports", async () => {
  const f = await hostResidentProtocol([evaluationFrame], true);
  try {
    f.release();
    const reports: number[] = [];
    expect(await f.worker.analyze(null, undefined, ms => reports.push(ms))).toEqual({ ok: true });
    expect(reports).toEqual([7]);
  } finally { await f.close(); }
});

test("trusted failed evaluation notification precedes actual rejection and guardian drain", async () => {
  const f = await hostResidentProtocol([{ ...evaluationFrame, outcome: "terminated" }], false);
  try {
    const evaluated = Promise.withResolvers<number>();
    let settled = false;
    const job = f.worker.analyze(null, undefined, evaluated.resolve);
    const outcome = job.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    expect(await Promise.race([evaluated.promise, Bun.sleep(200).then(() => null)])).toBe(7);
    await Bun.sleep(25); expect(settled).toBe(false);
    await expect(f.worker.analyze(null)).rejects.toThrow(/busy|closed|Concurrent/);
    f.release(); expect(await outcome).toBeInstanceOf(Error);
  } finally { await f.close(); }
});

for (const [label, frames] of [
  ["wrong request ID", [{ ...evaluationFrame, id: 2 }]],
  ["wrong selected entry", [{ ...evaluationFrame, entry: "step" }]],
  ["duplicate boundary", [evaluationFrame, evaluationFrame]],
  ["result before boundary", [{ v: 1, type: "resident_result", id: 1, value: null }, evaluationFrame]],
  ["wrong notification version", [{ ...evaluationFrame, v: 1 }]],
  ["extra timing field", [{ ...evaluationFrame, reset: true }]],
  ["unsafe elapsed", [{ ...evaluationFrame, elapsed_ms: Number.MAX_SAFE_INTEGER + 1 }]],
  ["negative elapsed", [{ ...evaluationFrame, elapsed_ms: -1 }]],
  ["missing boundary", []],
] as const) test(`host fails closed for ${label} before accepting analysis output`, async () => {
  const f = await hostResidentProtocol([...frames], true);
  try {
    f.release();
    await expect(f.worker.analyze(null)).rejects.toThrow();
  } finally { await f.close(); }
});

test("container protocol cannot request a trusted guardian evaluation notification", async () => {
  const worker = await compile("export function analyze(input) { return input; }");
  worker.send(evaluationFrame);
  expect(await worker.closed).not.toBe(0);
});
