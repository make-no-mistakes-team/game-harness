import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxService } from "../src/server/sandbox.ts";
import type { ResidentAnalysisWorker, ResidentWorker } from "../src/shared/resident.ts";
import { controllerStepResultSchema } from "../src/shared/resident.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { minecraftControllerFrameSchema } from "../src/shared/minecraft.ts";
import { validateProgramSource } from "../src/server/program-validation.ts";
import { PreparedSourcebook } from "../src/server/prepared-sourcebook.ts";
import { adapterCompatibility } from "../src/server/adapter-contract.ts";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";
import type { TemporalTurnOptions, TemporalTurnResult, TemporalTurnState,
  TemporalTrackOptions, TemporalTrackResult, TemporalTrackState } from "../src/shared/temporal-turn.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import type { ExecutableModuleBundle, SkillCapabilityRequest } from "../src/shared/programs.ts";
import { assertExecutableModuleBundle, executableModuleBundleHash, singletonExecutableModuleBundle } from "../src/shared/program-modules.ts";
import { Json } from "../src/shared/contracts.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { GeneratedControllerResultValidationError, parseGeneratedResidentResult } from "../src/server/program-diagnostics.ts";

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
  return processTransport(child);
}
function processTransport(child: ChildProcessWithoutNullStreams): ProcessWorker {
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
  return await compileBundle(singletonExecutableModuleBundle(source, entry), budget);
}
async function compileBundle(bundle: ExecutableModuleBundle, budget = 80) {
  const worker = processWorker(budget);
  expect(await worker.read()).toEqual({ v: 1, type: "resident_ready", id: 0,
    runtime_features: ["pure_modules_v1", "motion_track_v1"] });
  worker.send({ v: 1, type: "resident_init", id: 0, entry: bundle.entry, bundle });
  expect(await worker.read()).toEqual({ v: 1, type: "resident_compiled", id: 0 });
  return worker;
}
async function analyze(worker: ProcessWorker, id: number, input: unknown) {
  worker.send({ v: 1, type: "resident_analyze", id, input });
  return await worker.read();
}

function sourceFault(bundle: ExecutableModuleBundle, type: string, message: string) {
  return { v: 1, type: "resident_fault", id: 1, origin: "source_throw",
    diagnostic: { type, message, source_hash: bundle.source_hash, location: { mapping: "unmapped" } } };
}

for (const [label, body, type, message] of [
  ["own assertion", `if (input !== 7) throw new Error("Expected seven; observed another input");`, "Error", "Expected seven; observed another input"],
  ["own TypeError", `throw new TypeError("Expected path array");`, "TypeError", "Expected path array"],
  ["engine TypeError", `null.missing();`, "TypeError", "Cannot read properties of null (reading 'missing')"],
  ["RangeError", `throw new RangeError("range");`, "RangeError", "range"],
  ["ReferenceError", `throw new ReferenceError("reference");`, "ReferenceError", "reference"],
  ["SyntaxError", `throw new SyntaxError("syntax");`, "SyntaxError", "syntax"],
  ["URIError", `throw new URIError("uri");`, "URIError", "uri"],
  ["EvalError", `throw new EvalError("eval");`, "EvalError", "eval"],
  ["AggregateError", `throw new AggregateError([], "aggregate");`, "AggregateError", "aggregate"],
] as const) test(`resident source diagnostic preserves bounded ${label} text`, async () => {
  const bundle = singletonExecutableModuleBundle(`export function analyze(input) { ${body} }`, "analyze");
  const worker = await compileBundle(bundle);
  expect(await analyze(worker, 1, null)).toEqual(sourceFault(bundle, type, message));
  expect(await worker.closed).not.toBe(0);
});

test("resident source diagnostic binds imported failures to the executable bundle, not root body", async () => {
  const bundle = moduleBundle([
    { name: "root", source: `export { analyze } from "./library.js";`, imports: [{ specifier: "./library.js", name: "library" }] },
    { name: "library", source: `export function analyze(input) { throw new TypeError("Library assertion"); }` },
  ]);
  expect(bundle.source_hash).not.toBe(bundle.modules[0]!.source_hash);
  const worker = await compileBundle(bundle);
  expect(await analyze(worker, 1, null)).toEqual(sourceFault(bundle, "TypeError", "Library assertion"));
  expect(await worker.closed).not.toBe(0);
});

for (const [label, body, type, message] of [
  ["native message getter", `const error=new TypeError(); Object.defineProperty(error,"message",{get(){for(;;){}}}); throw error;`, "TypeError", "Generated program failed"],
  ["native nonprimitive message", `const error=new Error(); error.message={toString(){for(;;){}}}; throw error;`, "Error", "Generated program failed"],
  ["native constructor/name/stack/serialization hooks", `const error=new Error("Own text"); for(const key of ["constructor","name","stack","code","toJSON"])Object.defineProperty(error,key,{get(){for(;;){}}}); Error.prepareStackTrace=()=>{for(;;){}}; throw error;`, "Error", "Own text"],
  ["inherited message getter", `const error=new Error(); Object.setPrototypeOf(error,{get message(){for(;;){}}}); throw error;`, "Error", "Generated program failed"],
  ["native proxy prototype", `const error=new Error("Own text"); Object.setPrototypeOf(error,new Proxy({},{get(){for(;;){}},getPrototypeOf(){for(;;){}}})); throw error;`, "Error", "Own text"],
  ["realm array inspection hooks", `Array.prototype.indexOf=()=>{for(;;){}}; throw new TypeError("Own text");`, "TypeError", "Own text"],
  ["non-error getter", `throw {get message(){for(;;){}},toJSON(){for(;;){}},toString(){for(;;){}}};`, "ThrownValue", "Generated program threw a non-error value (not serialized)"],
  ["proxy", `throw new Proxy(new Error("Must not read"),{get(){for(;;){}},getOwnPropertyDescriptor(){for(;;){}},getPrototypeOf(){for(;;){}},ownKeys(){for(;;){}}});`, "ThrownValue", "Generated program threw a non-error value (not serialized)"],
  ["revoked proxy", `const value=Proxy.revocable(new Error("Must not read"),{});value.revoke();throw value.proxy;`, "ThrownValue", "Generated program threw a non-error value (not serialized)"],
  ["primitive symbol", `throw Symbol("Must not coerce");`, "ThrownValue", "Generated program threw a non-error value (not serialized)"],
  ["primitive bigint", `throw 42n;`, "ThrownValue", "Generated program threw a non-error value (not serialized)"],
  ["null", `throw null;`, "ThrownValue", "Generated program threw a non-error value (not serialized)"],
] as const) test(`resident source diagnostic never invokes ${label}`, async () => {
  const bundle = singletonExecutableModuleBundle(`export function analyze(input) { ${body} }`, "analyze");
  const worker = await compileBundle(bundle, 200);
  expect(await analyze(worker, 1, null)).toEqual(sourceFault(bundle, type, message));
  expect(await worker.closed).not.toBe(0);
});

for (const text of ["a".repeat(1000), "a".repeat(1001), "😀".repeat(501), "\ud800".repeat(1001)])
test(`resident source diagnostic bounds ${text.length} code units without widening output limits`, async () => {
  const bundle = singletonExecutableModuleBundle(`export function analyze(input) { throw new Error(input); }`, "analyze");
  const worker = await compileBundle(bundle);
  expect(await analyze(worker, 1, text)).toEqual(sourceFault(bundle, "Error", text.slice(0, 1000)));
  expect(await worker.closed).not.toBe(0);
});

test("resident activation carries the same bounded source diagnostic as analysis", async () => {
  const bundle = singletonExecutableModuleBundle(`export function step(frame,state,intent) { return null; }
    export function activate(frame,state,intent) { throw new TypeError("Activation assertion"); }`, "step");
  const worker = await compileBundle(bundle);
  worker.send({ v: 1, type: "resident_activate", id: 1, frame: {}, state: null, intent: null });
  expect(await worker.read()).toEqual(sourceFault(bundle, "TypeError", "Activation assertion"));
  expect(await worker.closed).not.toBe(0);
});

test("resident source computation hang remains watchdog without a diagnostic", async () => {
  const worker = await compile(`export function analyze(input) { for (;;) {} }`, "analyze", 25);
  expect(await analyze(worker, 1, null)).toEqual({ v: 1, type: "resident_fault", id: 1, origin: "watchdog" });
  expect(await worker.closed).not.toBe(0);
});

// Link the unchanged shipped guardian against a fake Docker CLI only. Source
// decoding, hash validation, timers, ordering and cleanup run in real Node.
function guardianFaultProcess(fault: unknown): ProcessWorker {
  const executable = Bun.which("node");
  if (!executable) throw new Error("The real Node guardian executable is unavailable.");
  const bootstrap = `
    import { readFileSync } from "node:fs";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    import { SourceTextModule, SyntheticModule } from "node:vm";
    import { createHash } from "node:crypto";
    const name="gameharness-policy-"+ "a".repeat(73);
    process.argv=["node","guardian.mjs",name,"/runner.mjs","node:24-bookworm-slim@sha256:"+ "b".repeat(64),"resident","1000"];
    function spawn(_command,args) {
      const child=new EventEmitter();
      child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
      child.kill=()=>{setImmediate(()=>child.emit("close",0));return true;};
      if(args[0]==="start") {
        child.stdin.on("data",chunk=>{
          const request=JSON.parse(chunk.toString());
          const reply=request.type==="resident_init"?{v:1,type:"resident_compiled",id:0}:${JSON.stringify(fault)};
          child.stdout.write(JSON.stringify(reply)+"\\n");
        });
        setImmediate(()=>child.stdout.write(JSON.stringify({v:1,type:"resident_ready",id:0,runtime_features:["pure_modules_v1","motion_track_v1"]})+"\\n"));
      } else setImmediate(()=>{
        if(args[0]==="create")child.stdout.write("c".repeat(64)+"\\n");
        else if(args[0]==="inspect")child.stdout.write(JSON.stringify({"io.gameharness.role":"policy","io.gameharness.owner":name}));
        child.emit("close",0);
      });
      return child;
    }
    const module=new SourceTextModule(readFileSync(${JSON.stringify(new URL("../sandbox/guardian.mjs", import.meta.url).pathname)},"utf8"));
    await module.link(specifier=>{
      if(specifier==="node:child_process")return new SyntheticModule(["spawn"],function(){this.setExport("spawn",spawn);});
      if(specifier==="node:crypto")return new SyntheticModule(["createHash"],function(){this.setExport("createHash",createHash);});
      throw new Error("Unexpected guardian import");
    });
    await module.evaluate();
  `;
  return processTransport(spawn(executable, ["--experimental-vm-modules", "--input-type=module", "-e", bootstrap], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
  }));
}

// Substitute only the Worker transport, not the resident supervisor's decoder
// or watchdog. Authored source cannot legitimately send these forged frames.
function supervisorFaultProcess(fault: unknown): ProcessWorker {
  const executable = Bun.which("node");
  if (!executable) throw new Error("The real Node worker executable is unavailable.");
  const workerUrl = new URL("../sandbox/worker.mjs", import.meta.url);
  const bootstrap = `
    import { readFileSync } from "node:fs";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    import { SourceTextModule, SyntheticModule } from "node:vm";
    process.argv=["node",${JSON.stringify(workerUrl.pathname)},"resident","1000"];
    class Worker extends EventEmitter {
      constructor() {
        super();this.stdout=new PassThrough();this.stderr=new PassThrough();
        setImmediate(()=>this.emit("message",JSON.stringify({v:1,type:"resident_compiled",id:0})));
      }
      postMessage() {setImmediate(()=>this.emit("message",JSON.stringify(${JSON.stringify(fault)})));}
      async terminate() {return 1;}
    }
    const module=new SourceTextModule(readFileSync(${JSON.stringify(workerUrl.pathname)},"utf8"),{
      initializeImportMeta(meta){meta.url=${JSON.stringify(workerUrl.href)};}
    });
    await module.link(async specifier=>{
      if(specifier==="node:worker_threads")return new SyntheticModule(["Worker","isMainThread","parentPort","workerData"],
        function(){this.setExport("Worker",Worker);this.setExport("isMainThread",true);this.setExport("parentPort",null);this.setExport("workerData",null);});
      const namespace=await import(specifier),keys=Object.keys(namespace);
      return new SyntheticModule(keys,function(){for(const key of keys)this.setExport(key,namespace[key]);});
    });
    await module.evaluate();
  `;
  return processTransport(spawn(executable, ["--experimental-vm-modules", "--input-type=module", "-e", bootstrap], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
  }));
}

const guardianDiagnosticBundle = singletonExecutableModuleBundle("export function analyze(input) { return input; }", "analyze");
const guardianDiagnosticFault = sourceFault(guardianDiagnosticBundle, "TypeError", "Authored assertion, not host fact");
const diagnosticFaultCases = [
  ["valid source diagnostic", guardianDiagnosticFault, true],
  ["invalid JSON return", { v: 1, type: "resident_fault", id: 1, origin: "invalid_return_json" }, true],
  ["invalid JSON return diagnostic", { ...guardianDiagnosticFault, origin: "invalid_return_json" }, false],
  ["invalid JSON return extra text", { v: 1, type: "resident_fault", id: 1,
    origin: "invalid_return_json", message: "PRIVATE_RETURN" }, false],
  ["invalid JSON return forged trust", { v: 1, type: "resident_fault", id: 1,
    origin: "invalid_return_json", trusted_origin: true }, false],
  ["exact maximum code units", sourceFault(guardianDiagnosticBundle, "Error", "😀".repeat(500)), true],
  ["missing diagnostic", { v: 1, type: "resident_fault", id: 1, origin: "source_throw" }, false],
  ["wrong bundle hash", { ...guardianDiagnosticFault, diagnostic: { ...guardianDiagnosticFault.diagnostic, source_hash: "0".repeat(64) } }, false],
  ["uppercase bundle hash", { ...guardianDiagnosticFault, diagnostic: { ...guardianDiagnosticFault.diagnostic, source_hash: guardianDiagnosticBundle.source_hash.toUpperCase() } }, false],
  ["oversize message", sourceFault(guardianDiagnosticBundle, "Error", "a".repeat(1001)), false],
  ["nonstring message", { ...guardianDiagnosticFault, diagnostic: { ...guardianDiagnosticFault.diagnostic, message: {} } }, false],
  ["unknown error type", sourceFault(guardianDiagnosticBundle, "AssertionError", "not whitelisted"), false],
  ["stack field", { ...guardianDiagnosticFault, diagnostic: { ...guardianDiagnosticFault.diagnostic, stack: "must not escape" } }, false],
  ["mapped location", { ...guardianDiagnosticFault, diagnostic: { ...guardianDiagnosticFault.diagnostic, location: { mapping: "mapped" } } }, false],
  ["extra location data", { ...guardianDiagnosticFault, diagnostic: { ...guardianDiagnosticFault.diagnostic, location: { mapping: "unmapped", line: 1 } } }, false],
  ["null diagnostic", { ...guardianDiagnosticFault, diagnostic: null }, false],
  ["array diagnostic", { ...guardianDiagnosticFault, diagnostic: [] }, false],
  ["forged trust", { ...guardianDiagnosticFault, trusted_origin: true }, false],
  ["watchdog diagnostic", { ...guardianDiagnosticFault, origin: "watchdog" }, false],
  ["opaque diagnostic", { ...guardianDiagnosticFault, origin: "opaque" }, false],
] as const;
for (const [label, fault, accepted] of diagnosticFaultCases)
test(`guardian source diagnostic ${label} is ${accepted ? "advisory" : "quarantined"}`, async () => {
  const worker = guardianFaultProcess(fault);
  expect(await worker.read()).toMatchObject({ v: 1, type: "resident_ready", id: 0 });
  worker.send({ v: 1, type: "resident_init", id: 0, entry: "analyze", bundle: guardianDiagnosticBundle });
  expect(await worker.read()).toEqual({ v: 1, type: "resident_compiled", id: 0 });
  const reply = await analyze(worker, 1, null);
  expect(reply).toEqual(accepted
    ? { ...fault, v: 2, type: "guardian_resident_fault", trusted_origin: false }
    : { v: 2, type: "guardian_resident_fault", id: 1, origin: "opaque", trusted_origin: true });
  expect(await worker.read()).toMatchObject({ v: 2, type: "guardian_analysis_evaluated", id: 1, entry: "analyze", outcome: "terminated" });
  expect(await worker.closed).toBe(0);
});

for (const [label, fault, accepted] of diagnosticFaultCases)
test(`resident supervisor source diagnostic ${label} is ${accepted ? "advisory" : "quarantined"}`, async () => {
  const worker = supervisorFaultProcess(fault);
  expect(await worker.read()).toMatchObject({ v: 1, type: "resident_ready", id: 0 });
  worker.send({ v: 1, type: "resident_init", id: 0, entry: "analyze", bundle: guardianDiagnosticBundle });
  expect(await worker.read()).toEqual({ v: 1, type: "resident_compiled", id: 0 });
  expect(await analyze(worker, 1, null)).toEqual(accepted ? fault
    : { v: 1, type: "resident_fault", id: 1, origin: "opaque" });
  expect(await worker.closed).not.toBe(0);
});

function moduleBundle(rows: { name: string; source: string; imports?: { specifier: string; name: string }[] }[],
  entry: ExecutableModuleBundle["entry"] = "analyze"): ExecutableModuleBundle {
  const id = (name: string) => name === "root" ? "root" : `module:${JSON.stringify([name, 1])}`;
  const modules = rows.map(row => ({ ...singletonExecutableModuleBundle(row.source, entry).modules[0]!,
    id: id(row.name), imports: (row.imports ?? []).map(binding => ({ specifier: binding.specifier, module_id: id(binding.name) })) }));
  return { schema_version: 1, entry, root: "root", source_hash: executableModuleBundleHash(entry, modules), modules };
}
function sharedLibraryBundle(): ExecutableModuleBundle {
  return moduleBundle([
    { name: "root", source: `import {left} from "./left.js"; import right from "./right.mjs";
      export function analyze(input) { return [left(input), right(input)]; }`,
      imports: [{ specifier: "./left.js", name: "left" }, { specifier: "./right.mjs", name: "right" }] },
    { name: "left", source: `export { next as left } from "./counter.js";`, imports: [{ specifier: "./counter.js", name: "counter" }] },
    { name: "right", source: `import {next} from "./same.js"; export default function right(input) { return next(input); }`,
      imports: [{ specifier: "./same.js", name: "counter" }] },
    { name: "counter", source: `let count = 0; export function next(input) {
      return {count: ++count, realm: input instanceof Object, motion_frozen: Object.isFrozen(motion.turn),
        game: typeof game, process: typeof process, fetch: typeof fetch}; }` },
  ]);
}

test("pure nested named/default/reexports share one library singleton and fresh workers reset its state", async () => {
  const bundle = sharedLibraryBundle();
  const first = await compileBundle(bundle), second = await compileBundle(bundle);
  expect(await analyze(first, 1, {})).toMatchObject({ value: [
    { count: 1, realm: true, motion_frozen: true, game: "undefined", process: "undefined", fetch: "undefined" },
    { count: 2, realm: true, motion_frozen: true, game: "undefined", process: "undefined", fetch: "undefined" },
  ] });
  expect(await analyze(first, 2, {})).toMatchObject({ value: [{ count: 3 }, { count: 4 }] });
  expect(await analyze(second, 1, {})).toMatchObject({ value: [{ count: 1 }, { count: 2 }] });
});

test("validated analysis calls its exact step candidate as software without activating the separate step realm", async () => {
  const adapter = minecraftTestAdapter(), compatibility = adapterCompatibility(adapter.descriptor, adapter.schemas);
  const book = new PreparedSourcebook(compatibility.compatibility_hash, adapter, () => {}, () => {});
  const card = { purpose: "Exercise exact exported software", applicability: "Synthetic JSON only", method: "Call pinned exports",
    reason: "Return-shape regression", limitations: "No live activation or gameplay claim" };
  await book.write({ entry: "library", name: "arithmetic", card,
    source: "export function plus(a,b) { return a+b; }" }, "helper", "request");
  await book.write({ entry: "run", name: "semantic only", card,
    source: "throw new Error('A semantic child must never be compiled or executed here');" }, "semantic", "request");
  await book.write({ entry: "step", name: "candidate", card,
    source: `import {plus} from "./arithmetic.js";
      let activations = 0, steps = 0;
      function result(frame,state,intent) {
        return {choice:{kind:"observe"},next_state:{seed:state.seed,value:plus(frame.value,intent.offset),
          activations,steps},status:"running",events:[]};
      }
      export function activate(frame,state,intent) { activations++; return result(frame,state,intent); }
      export function step(frame,state,intent) { steps++; return result(frame,state,intent); }`,
    dependencies: [{ name: "arithmetic", version: 1, import_path: "./arithmetic.js" }, { name: "semantic only", version: 1 }],
  }, "candidate", "request");
  await book.write({ entry: "analyze", name: "exact check", card,
    source: `import {activate,step} from "./candidate.js";
      export function analyze(input) {
        const activation = activate(input.frame,input.state,input.intent);
        return {activation,decision:step(input.frame,activation.next_state,input.intent),game:typeof game};
      }`,
    dependencies: [{ name: "candidate", version: 1, import_path: "./candidate.js" }],
  }, "check", "request");
  const candidate = book.select({ name: "candidate", version: 1 }), root = book.select({ name: "exact check", version: 1 });
  const bundle = book.bundle(root), stepBundle = book.bundle(candidate, true);
  await book.write({ entry: "library", name: "arithmetic", based_on: 1, card,
    source: "export function plus(a,b) { return 999; }" }, "helper-v2", "request");
  await book.write({ entry: "step", name: "candidate", based_on: 1, card,
    source: "export function step(frame,state,intent) { return null; }" }, "candidate-v2", "request");
  const clean = await compileBundle(stepBundle), analysis = await compileBundle(book.bundle(root));
  expect(book.bundle(root)).toEqual(bundle);
  expect(bundle.entry).toBe("analyze");
  expect(bundle.modules).toHaveLength(3);
  const input = { frame: { value: 5 }, state: { seed: 7 }, intent: { offset: 3 } };
  expect(await analyze(analysis, 1, input)).toMatchObject({ type: "resident_result", value: {
    activation: { choice: { kind: "observe" }, next_state: { seed: 7, value: 8, activations: 1, steps: 0 } },
    decision: { next_state: { seed: 7, value: 8, activations: 1, steps: 1 } }, game: "undefined",
  } });
  expect(await analyze(analysis, 2, input)).toMatchObject({ value: {
    activation: { next_state: { activations: 2, steps: 1 } },
    decision: { next_state: { activations: 2, steps: 2 } },
  } });
  // Only an explicit synthetic software frame is sent to the separate realm;
  // no activation message or native/capability transport exists in this test.
  clean.send({ v: 1, type: "resident_step", id: 1, ...input });
  expect(await clean.read()).toMatchObject({ type: "resident_result", value: {
    next_state: { seed: 7, value: 8, activations: 0, steps: 1 },
  } });
});

test("root binding/reexports select synchronous library entry functions without leaking library exports", async () => {
  const bundle = moduleBundle([
    { name: "root", source: `export {default as analyze} from "./entry.js";`, imports: [{ specifier: "./entry.js", name: "entry" }] },
    { name: "entry", source: `export const unused = 4; export default function analyze(input) { return input.value + unused; }` },
  ]);
  const worker = await compileBundle(bundle);
  expect(await analyze(worker, 1, { value: 3 })).toMatchObject({ value: 7 });
});

test("shared library object mutation is local to each worker realm", async () => {
  const bundle = moduleBundle([
    { name: "root", source: `import value from "./value.js"; export function analyze(input) {
      value.total += input; return value; }`, imports: [{ specifier: "./value.js", name: "value" }] },
    { name: "value", source: `export default { total: 0 };` },
  ]);
  const first = await compileBundle(bundle), second = await compileBundle(bundle);
  expect(await analyze(first, 1, 3)).toMatchObject({ value: { total: 3 } });
  expect(await analyze(first, 2, 4)).toMatchObject({ value: { total: 7 } });
  expect(await analyze(second, 1, 2)).toMatchObject({ value: { total: 2 } });
});

test("library namespace bindings cannot be reassigned by an importing root", async () => {
  const bundle = moduleBundle([
    { name: "root", source: `import * as library from "./library.js"; export function analyze(input) {
      let blocked = false; try { library.value = input; } catch { blocked = true; }
      return { blocked, value: library.value }; }`, imports: [{ specifier: "./library.js", name: "library" }] },
    { name: "library", source: `export const value = 1;` },
  ]);
  const worker = await compileBundle(bundle);
  expect(await analyze(worker, 1, 9)).toMatchObject({ value: { blocked: true, value: 1 } });
});

test("step and activate library reexports preserve synchronous root arity and selected namespace", async () => {
  const bundle = moduleBundle([
    { name: "root", source: `export {step,activate} from "./entry.js";`, imports: [{ specifier: "./entry.js", name: "entry" }] },
    { name: "entry", source: `let count = 0;
      export function activate(frame,state,intent) { return {choice:{kind:"observe"},next_state:++count,status:"running",events:[]}; }
      export function step(frame,state,intent) { return {choice:{kind:"observe"},next_state:++count,status:"running",events:[]}; }` },
  ], "step");
  const worker = await compileBundle(bundle);
  worker.send({ v: 1, type: "resident_activate", id: 1, frame: { executive: {} }, state: null, intent: null });
  expect(await worker.read()).toMatchObject({ value: { next_state: 1 } });
  worker.send({ v: 1, type: "resident_step", id: 2, frame: { executive: {} }, state: null, intent: null });
  expect(await worker.read()).toMatchObject({ value: { next_state: 2 } });
});

const invalidBundles: { name: string; bundle(): ExecutableModuleBundle }[] = [
  { name: "changed source bytes", bundle() { const bundle = sharedLibraryBundle(); bundle.modules[1]!.source += " "; return bundle; } },
  { name: "changed realm hash", bundle() { const bundle = sharedLibraryBundle(); bundle.source_hash = "0".repeat(64); return bundle; } },
  { name: "unknown target", bundle() { const bundle = sharedLibraryBundle(); bundle.modules[0]!.imports[0]!.module_id = 'module:["missing",1]'; return bundle; } },
  { name: "duplicate alias", bundle() { const bundle = sharedLibraryBundle(); bundle.modules[0]!.imports.push(bundle.modules[0]!.imports[0]!); return bundle; } },
  { name: "traversal alias", bundle() { const bundle = sharedLibraryBundle(); bundle.modules[0]!.imports[0]!.specifier = "./../left.js"; return bundle; } },
  { name: "node alias", bundle() { const bundle = sharedLibraryBundle(); bundle.modules[0]!.imports[0]!.specifier = "node:fs"; return bundle; } },
  { name: "noncanonical module identity", bundle() { const bundle = sharedLibraryBundle(); bundle.modules[1]!.id = 'module:[ "left", 1 ]'; return bundle; } },
  { name: "unreachable module", bundle() { return moduleBundle([
    { name: "root", source: "export function analyze(input) { return input; }" }, { name: "extra", source: "export const x=1;" },
  ]); } },
  { name: "cyclic libraries", bundle() { return moduleBundle([
    { name: "root", source: 'export {analyze} from "./a.js";', imports: [{ specifier: "./a.js", name: "a" }] },
    { name: "a", source: 'export {analyze} from "./b.js";', imports: [{ specifier: "./b.js", name: "b" }] },
    { name: "b", source: 'export {analyze} from "./a.js";', imports: [{ specifier: "./a.js", name: "a" }] },
  ]); } },
  { name: "33 modules", bundle() { return moduleBundle([
    { name: "root", source: `${Array.from({ length: 32 }, (_, i) => `import "./m${i}.js";`).join("")} export function analyze(input){return input;}`,
      imports: Array.from({ length: 32 }, (_, i) => ({ specifier: `./m${i}.js`, name: `m${i}` })) },
    ...Array.from({ length: 32 }, (_, i) => ({ name: `m${i}`, source: "export const n=0;" })),
  ]); } },
  { name: "depth nine", bundle() { return moduleBundle(Array.from({ length: 9 }, (_, i) => ({
    name: i === 0 ? "root" : `d${i}`,
    source: i === 8 ? "export function analyze(input){return input;}" : `export {analyze} from "./next.js";`,
    imports: i === 8 ? [] : [{ specifier: "./next.js", name: `d${i + 1}` }],
  }))); } },
  { name: "aggregate source over 64KiB", bundle() { return moduleBundle([
    { name: "root", source: `import "./a.js"; import "./b.js"; import "./c.js"; import "./d.js"; export function analyze(input){return input;}`,
      imports: ["a", "b", "c", "d"].map(name => ({ specifier: `./${name}.js`, name })) },
    ...["a", "b", "c", "d"].map(name => ({ name, source: "export const x=1;".padEnd(16384, " ") })),
  ]); } },
  { name: "JSON envelope over 256KiB despite bounded raw source", bundle() { return moduleBundle([
    { name: "root", source: `import "./a.js"; import "./b.js"; import "./c.js"; export function analyze(input){return input;}`,
      imports: ["a", "b", "c"].map(name => ({ specifier: `./${name}.js`, name })) },
    ...["a", "b", "c"].map(name => ({ name, source: `/*${"\0".repeat(16380)}*/` })),
  ]); } },
];
for (const invalid of invalidBundles) test(`resident rejects bundle ${invalid.name} before authored execution`, async () => {
  const bundle = invalid.bundle();
  expect(() => assertExecutableModuleBundle(bundle)).toThrow();
  const worker = processWorker(); await worker.read();
  worker.send({ v: 1, type: "resident_init", id: 0, entry: bundle.entry, bundle });
  expect(await worker.closed).not.toBe(0);
});

for (const source of [
  `import {x} from "./undeclared.js"; export function analyze(input){return x;}`,
  `import fs from "node:fs"; export function analyze(input){return fs;}`,
  `import x from "a-package"; export function analyze(input){return x;}`,
]) test(`resident linker refuses imports absent from the exact captured alias graph: ${source}`, async () => {
  const worker = processWorker(); await worker.read();
  const bundle = singletonExecutableModuleBundle(source, "analyze");
  worker.send({ v: 1, type: "resident_init", id: 0, entry: "analyze", bundle });
  expect(await worker.closed).not.toBe(0);
});

test("pure imported library cannot use dynamic imports or import.meta to acquire host values", async () => {
  for (const expression of ["import('node:fs')", "import.meta"]) {
    const bundle = moduleBundle([
      { name: "root", source: `export {analyze} from "./entry.js";`, imports: [{ specifier: "./entry.js", name: "entry" }] },
      { name: "entry", source: `export function analyze(input) { return ${expression}; }` },
    ]);
    const worker = await compileBundle(bundle);
    worker.send({ v: 1, type: "resident_analyze", id: 1, input: null });
    expect(await worker.closed).not.toBe(0);
  }
});

test("caught import.meta and dynamic-import denials cannot expose outer-realm Error constructors", async () => {
  const meta = moduleBundle([
    { name: "root", source: `export {analyze} from "./entry.js";`, imports: [{ specifier: "./entry.js", name: "entry" }] },
    { name: "entry", source: `export function analyze(input) { try { return import.meta; } catch (error) {
      try { return error.constructor.constructor("return process")().version; } catch { return "blocked"; }
    } }` },
  ]);
  expect(await analyze(await compileBundle(meta), 1, null)).toMatchObject({ value: "blocked" });
  const dynamic = moduleBundle([
    { name: "root", source: `export {analyze} from "./entry.js";`, imports: [{ specifier: "./entry.js", name: "entry" }] },
    { name: "entry", source: `let outcome = "idle"; export function analyze(input) {
      if (input) { import("node:fs").catch(error => {
        try { error.constructor.constructor("return process")(); outcome = "leaked"; } catch { outcome = "blocked"; }
      }); return "pending"; } return outcome;
    }` },
  ]);
  const worker = await compileBundle(dynamic);
  expect(await analyze(worker, 1, true)).toMatchObject({ value: "pending" });
  expect(await analyze(worker, 2, false)).toMatchObject({ value: "blocked" });
});

test("resident accepts exact 16KiB canonical root bytes without changing its legacy hash", async () => {
  const source = "export function analyze(input){return input;}".padEnd(16384, " ");
  const bundle = singletonExecutableModuleBundle(source, "analyze");
  assertExecutableModuleBundle(bundle);
  expect(bundle.source_hash).toBe(bundle.modules[0]!.source_hash);
  const worker = await compileBundle(bundle);
  expect(await analyze(worker, 1, 7)).toMatchObject({ value: 7 });
});

test("resident accepts a complete eight-module path and exact 64KiB aggregate source", async () => {
  const depthBundle = moduleBundle(Array.from({ length: 8 }, (_, i) => ({
    name: i === 0 ? "root" : `d${i}`,
    source: i === 7 ? "export function analyze(input){return input;}" : `export {analyze} from "./next.js";`,
    imports: i === 7 ? [] : [{ specifier: "./next.js", name: `d${i + 1}` }],
  })));
  const depthWorker = await compileBundle(depthBundle);
  expect(await analyze(depthWorker, 1, 7)).toMatchObject({ value: 7 });
  const aggregateBundle = moduleBundle([
    { name: "root", source: `import "./a.js"; import "./b.js"; import "./c.js"; export function analyze(input){return input;}`.padEnd(16384, " "),
      imports: ["a", "b", "c"].map(name => ({ specifier: `./${name}.js`, name })) },
    ...["a", "b", "c"].map(name => ({ name, source: "export const x=1;".padEnd(16384, " ") })),
  ]);
  assertExecutableModuleBundle(aggregateBundle);
  const aggregateWorker = await compileBundle(aggregateBundle);
  expect(await analyze(aggregateWorker, 1, 9)).toMatchObject({ value: 9 });
});

test("resident accepts 32 reachable module singletons", async () => {
  const bundle = moduleBundle([
    { name: "root", source: `${Array.from({ length: 31 }, (_, i) => `import "./m${i}.js";`).join("")} export function analyze(input){return input;}`,
      imports: Array.from({ length: 31 }, (_, i) => ({ specifier: `./m${i}.js`, name: `m${i}` })) },
    ...Array.from({ length: 31 }, (_, i) => ({ name: `m${i}`, source: "export const n=0;" })),
  ]);
  assertExecutableModuleBundle(bundle);
  const worker = await compileBundle(bundle);
  expect(await analyze(worker, 1, 7)).toMatchObject({ value: 7 });
});

const dockerModuleSmoke = process.env.GAMEHARNESS_DOCKER_MODULE_SMOKE === "1" ? test : test.skip;
dockerModuleSmoke("actual Docker guardian runs nested pure libraries in shared and fresh realms", async () => {
  const sandbox = new SandboxService(new URL("..", import.meta.url).pathname);
  try {
    await sandbox.prepare();
    expect(sandbox.snapshot().status).toBe("ready");
    const bundle = sharedLibraryBundle(), signal = new AbortController().signal;
    const first = await sandbox.createResidentAnalysisWorker(bundle, 1000, signal);
    const second = await sandbox.createResidentAnalysisWorker(bundle, 1000, signal);
    try {
      expect(await first.analyze({}, signal)).toMatchObject([{ count: 1 }, { count: 2 }]);
      expect(await first.analyze({}, signal)).toMatchObject([{ count: 3 }, { count: 4 }]);
      expect(await second.analyze({}, signal)).toMatchObject([{ count: 1 }, { count: 2 }]);
    } finally { await Promise.all([first.close(), second.close()]); }
    const stepBundle = moduleBundle([
      { name: "root", source: `import {next} from "./state.js"; export function step(frame,state,intent) {
        return {choice:{kind:"observe"},next_state:next(),status:"running",events:[]}; }`,
        imports: [{ specifier: "./state.js", name: "state" }] },
      { name: "state", source: `export {next} from "./counter.js";`, imports: [{ specifier: "./counter.js", name: "counter" }] },
      { name: "counter", source: `let count=0; export function next(){return ++count;}` },
    ], "step");
    const step = await sandbox.createResidentWorker(stepBundle, 500, signal);
    try {
      const frame = minecraftControllerFrameSchema.parse(controllerFrameFixture());
      expect(await step.step(frame, null, null, signal)).toMatchObject({ next_state: 1 });
      expect(await step.step(frame, null, null, signal)).toMatchObject({ next_state: 2 });
    } finally { await step.close(); }
  } finally { await sandbox.close(); }
}, 60000);
const neutralInput = { kind: "world", held: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, attack: false, use: false }, edges: [], view: { kind: "unchanged" }, selected_hotbar: null };
const stepResult = `{ input: ${JSON.stringify(neutralInput)}, next_state: { count: state.count + 1, local: ++count, intent }, status: "running", events: [] }`;

test("ordinary step module compiles once and reuses module state with explicit state and intent", async () => {
  const worker = await compile(`let count = 0; const add = x => x + 1; export function step(frame, state, intent) { if (add(frame.frame_seq) !== 8) throw Error(); return ${stepResult}; }`, "step");
  worker.send({ v: 1, type: "resident_step", id: 1, frame: { frame_seq: 7 }, state: { count: 3 }, intent: "first" });
  expect(await worker.read()).toEqual({ v: 1, type: "resident_result", id: 1, value: { input: neutralInput, next_state: { count: 4, local: 1, intent: "first" }, status: "running", events: [] } });
  worker.send({ v: 1, type: "resident_step", id: 2, frame: { frame_seq: 7 }, state: { count: 4 }, intent: "second" });
  expect(await worker.read()).toMatchObject({ value: { next_state: { count: 5, local: 2, intent: "second" } } });
});

test("malformed authored activation returns bounded data for a field diagnostic instead of an opaque worker exit", async () => {
  const worker = await compile(`export function activate(frame,state,intent) { return {refused:false}; }
export function step(frame,state,intent) { return {choice:{kind:"observe"},next_state:null,status:"running",events:[]}; }`, "step");
  worker.send({ v: 1, type: "resident_activate", id: 1, frame: { executive: {} }, state: null, intent: null });
  const reply = await worker.read();
  expect(reply).toMatchObject({ type: "resident_result", id: 1 });
  const value = reply !== null && typeof reply === "object" && "value" in reply ? reply.value : null;
  try { parseGeneratedResidentResult(value, true); throw new Error("Malformed activation was accepted"); }
  catch (error) {
    expect(error).toBeInstanceOf(GeneratedControllerResultValidationError);
    if (!(error instanceof GeneratedControllerResultValidationError)) throw error;
    expect(error.issues.some(issue => issue.path === "choice" || issue.path === "input" || issue.path === "refused")).toBe(true);
  }
});

test("ordinary step worker preserves omitted edges for host normalization without injecting controls", async () => {
  const { edges: _edges, ...base } = neutralInput;
  const input = { ...base, held: { ...base.held, forward: true } };
  const worker = await compile(`export function step(frame,state,intent) {
    return { input: ${JSON.stringify(input)}, next_state: null, status: "running", events: [] };
  }`, "step");
  worker.send({ v: 1, type: "resident_step", id: 1, frame: {}, state: null, intent: null });
  const reply = await worker.read() as { value: unknown };
  const result = controllerStepResultSchema.parse(reply.value);
  expect<unknown>(result.input).toEqual(input);
  expect(Object.hasOwn(result.input, "edges")).toBe(false);
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

const trackOptions: TemporalTrackOptions = {
  native_tick: 100, pose: { yaw_radians: 0, pitch_radians: 0 },
  target: { yaw_radians: 1, pitch_radians: -0.4 },
  max_rate: 2, max_acceleration: 4, response_ticks: 4,
};
async function trackingWorker() {
  const source = await validateProgramSource(
    "export function analyze(input) { return motion.track(input.options, input.state); }",
    "analyze", minecraftTestAdapter(),
  );
  return await compile(source.source);
}
async function track(worker: ProcessWorker, id: number, options: TemporalTrackOptions, state: TemporalTrackState | null = null) {
  const reply = await analyze(worker, id, { options, state }) as { value: TemporalTrackResult };
  return reply.value;
}

test("tracking uses shortest wrapped yaw and valid target pitch without an initial snap", async () => {
  const worker = await trackingWorker();
  const options = { ...trackOptions, pose: { yaw_radians: Math.PI - 0.1, pitch_radians: 0 },
    target: { yaw_radians: -Math.PI + 0.1, pitch_radians: 20 } };
  const first = await track(worker, 1, options);
  expect(first.error.yaw_radians).toBeCloseTo(0.2, 10);
  expect(first.error.pitch_radians).toBe(Math.PI / 2);
  expect(first.view).toEqual({ kind: "rate", yaw_radians_per_second: 0, pitch_radians_per_second: 0 });
  const next = await track(worker, 2, { ...options, native_tick: 101 }, first.state);
  expect(next.view.yaw_radians_per_second).toBeCloseTo(0.2, 10);
  expect(next.view.pitch_radians_per_second).toBeCloseTo(0.2, 10);
  const huge = await track(worker, 3, { ...trackOptions,
    pose: { yaw_radians: -Number.MAX_VALUE, pitch_radians: 0 },
    target: { yaw_radians: Number.MAX_VALUE, pitch_radians: -20 } });
  expect(Number.isFinite(huge.error.yaw_radians)).toBe(true);
  expect(Math.abs(huge.error.yaw_radians)).toBeLessThanOrEqual(Math.PI);
  expect(huge.error.pitch_radians).toBe(-Math.PI / 2);
});

test("tracking bounds per-axis speed and acceleration by actual elapsed native ticks across moving targets", async () => {
  const worker = await trackingWorker();
  const options = { ...trackOptions, max_rate: 0.7, max_acceleration: 1.2, response_ticks: 2 };
  let state: TemporalTrackState | null = null;
  let prior = { yaw_radians_per_second: 0, pitch_radians_per_second: 0 };
  let lastTick = 100;
  for (const [index, native_tick] of [100, 101, 102, 105, 106, 110, 111, 112].entries()) {
    const result = await track(worker, index + 1, { ...options, native_tick,
      target: { yaw_radians: index < 5 ? 1 + index * 0.1 : -1,
        pitch_radians: index < 4 ? -1 : 1 } }, state);
    const elapsed = (native_tick - lastTick) * 0.05;
    for (const axis of ["yaw_radians_per_second", "pitch_radians_per_second"] as const) {
      expect(Math.abs(result.view[axis])).toBeLessThanOrEqual(options.max_rate);
      expect(Math.abs(result.view[axis] - prior[axis])).toBeLessThanOrEqual(options.max_acceleration * elapsed + 1e-12);
    }
    expect(result.state.last_tick).toBe(native_tick);
    expect(result.aligned).toBe(false);
    prior = result.state.velocity; state = result.state; lastTick = native_tick;
  }
  const still = await track(worker, 9, { ...options, native_tick: 113,
    target: { yaw_radians: 0.02, pitch_radians: -0.03 },
    response_ticks: 10, max_acceleration: 100 }, { last_tick: 112,
      velocity: { yaw_radians_per_second: 0, pitch_radians_per_second: 0 } });
  expect(still.view.yaw_radians_per_second).toBeCloseTo(0.04, 10);
  expect(still.view.pitch_radians_per_second).toBeCloseTo(-0.06, 10);
});

test("retargets preserve velocity, same-tick calls do not integrate twice and alignment does not snap braking", async () => {
  const worker = await trackingWorker();
  const initial = await track(worker, 1, trackOptions);
  const moving = await track(worker, 2, { ...trackOptions, native_tick: 103 }, initial.state);
  expect(moving.view.yaw_radians_per_second).toBeCloseTo(0.6, 10);
  const reversedOptions = { ...trackOptions, native_tick: 104,
    target: { yaw_radians: -1, pitch_radians: 1 } };
  const reversed = await track(worker, 3, reversedOptions, moving.state);
  expect(reversed.view.yaw_radians_per_second).toBeCloseTo(0.4, 10);
  expect(reversed.view.pitch_radians_per_second).toBeCloseTo(-0.4, 10);
  const sameTick = await track(worker, 4, { ...reversedOptions,
    pose: { yaw_radians: 0.3, pitch_radians: 0.1 }, target: { yaw_radians: 1, pitch_radians: -1 } }, reversed.state);
  expect(sameTick.state).toEqual(reversed.state);
  expect(sameTick.view).toEqual(reversed.view);
  expect(sameTick.error.yaw_radians).toBeCloseTo(0.7, 10);
  const aligned = await track(worker, 5, { ...trackOptions, native_tick: 105,
    target: { ...trackOptions.pose } }, reversed.state);
  expect(aligned.aligned).toBe(true);
  expect(aligned.view.yaw_radians_per_second).toBeCloseTo(0.2, 10);
  const reset = await track(worker, 6, { ...trackOptions, native_tick: 2 }, aligned.state);
  expect(reset.state).toEqual({ last_tick: 2, velocity: { yaw_radians_per_second: 0, pitch_radians_per_second: 0 } });
  expect(reset.view.yaw_radians_per_second).toBe(0);
  const explicitReset = await track(worker, 7, { ...trackOptions, native_tick: 106 });
  expect(explicitReset.state.velocity).toEqual(reset.state.velocity);
});

test("tracking preserves caller JSON and remains realm-local with no retained hidden state", async () => {
  const source = await validateProgramSource(`export function analyze(input) {
    const before = JSON.stringify(input);
    const result = motion.track(input.options,input.state);
    return {result,unchanged:before===JSON.stringify(input),
      local:result instanceof Object && result.state instanceof Object && result.state.velocity instanceof Object,
      frozen:Object.isFrozen(motion) && Object.isFrozen(motion.track)};
  }`, "analyze", minecraftTestAdapter());
  const first = await compile(source.source), second = await compile(source.source);
  const input = { options: { ...trackOptions, native_tick: 105 },
    state: { last_tick: 100, velocity: { yaw_radians_per_second: 0.3, pitch_radians_per_second: -0.2 } } };
  const a = await analyze(first, 1, input) as { value: unknown };
  await analyze(first, 2, { options: { ...trackOptions, native_tick: 500 }, state: null });
  const again = await analyze(first, 3, input) as { value: unknown };
  const b = await analyze(second, 1, input) as { value: unknown };
  expect(a.value).toEqual(b.value);
  expect(again.value).toEqual(a.value);
  expect(a).toMatchObject({ value: { unchanged: true, local: true, frozen: true } });
  const constructorProbe = await compile(`export function analyze(input) {
    let functionBlocked=false, errorBlocked=false;
    try { motion.track.constructor("return process")(); } catch { functionBlocked=true; }
    try { motion.track(null); } catch (error) {
      try { error.constructor.constructor("return process")(); } catch { errorBlocked=true; }
    }
    return {functionBlocked,errorBlocked};
  }`);
  expect(await analyze(constructorProbe, 1, null)).toMatchObject({ value: { functionBlocked: true, errorBlocked: true } });
});

test("tracking deterministically rejects invalid inputs and malformed or out-of-cap explicit state", async () => {
  const worker = await compile(`export function analyze(input) {
    return input.map(item => {
      try { motion.track(item.options,item.state); return "accepted"; }
      catch(error) { return {range:error instanceof RangeError,message:error.message}; }
    });
  }`);
  const cases = [
    { options: { ...trackOptions, native_tick: -1 }, state: null },
    { options: { ...trackOptions, native_tick: 1.5 }, state: null },
    { options: { ...trackOptions, response_ticks: 0 }, state: null },
    { options: { ...trackOptions, response_ticks: 0.5 }, state: null },
    { options: { ...trackOptions, response_ticks: undefined }, state: null },
    { options: { ...trackOptions, max_acceleration: 0 }, state: null },
    { options: { ...trackOptions, max_acceleration: -1 }, state: null },
    { options: { ...trackOptions, max_acceleration: undefined }, state: null },
    { options: { ...trackOptions, max_rate: 0 }, state: null },
    { options: { ...trackOptions, max_rate: undefined }, state: null },
    { options: { ...trackOptions, max_rate: 20 * Math.PI + 1 }, state: null },
    { options: { ...trackOptions, tolerance: -1 }, state: null },
    { options: { ...trackOptions, pose: { yaw_radians: 0, pitch_radians: 2 } }, state: null },
    { options: trackOptions, state: {} },
    { options: trackOptions, state: { last_tick: 100, velocity: null } },
    { options: trackOptions, state: { last_tick: -1, velocity: { yaw_radians_per_second: 0, pitch_radians_per_second: 0 } } },
    { options: trackOptions, state: { last_tick: 100, velocity: { yaw_radians_per_second: 3, pitch_radians_per_second: 0 } } },
  ];
  const first = await analyze(worker, 1, cases) as { value: { range: boolean; message: string }[] };
  const second = await analyze(worker, 2, cases) as { value: unknown };
  expect(first.value).toHaveLength(cases.length);
  expect(first.value.every(value => value.range && value.message.startsWith("motion.track"))).toBe(true);
  expect(second.value).toEqual(first.value);
  // Non-JSON numbers can be constructed by authored code, not serialized as input.
  const nonfinite = await compile(`export function analyze(input) {
    const options=input.options;
    const checks=[
      {...options,max_acceleration:Infinity},
      {...options,target:{yaw_radians:NaN,pitch_radians:0}}
    ].map(value=>{try{motion.track(value);return false;}catch(error){return error instanceof RangeError;}});
    try { motion.track(options,{last_tick:100,velocity:{yaw_radians_per_second:NaN,pitch_radians_per_second:0}}); checks.push(false); }
    catch(error) { checks.push(error instanceof RangeError); }
    return checks;
  }`);
  expect(await analyze(nonfinite, 1, { options: trackOptions })).toMatchObject({ value: [true, true, true] });
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
  worker.send({ v: 1, type: "resident_init", id: 0, entry: "analyze", bundle: singletonExecutableModuleBundle(source, "analyze") });
  expect(await worker.closed).not.toBe(0);
});

for (const [label, expression] of [
  ["promise", "Promise.resolve(1)"],
  ["thenable", "({ then() {} })"],
  ["nonfinite number", "NaN"],
  ["positive infinity state", "({next_state:{PRIVATE_KEY:Infinity},PRIVATE_VALUE:'must not escape'})"],
  ["negative infinity", "-Infinity"],
  ["undefined field", "({ lost: undefined })"],
  ["bigint", "1n"],
  ["symbol key", "({[Symbol('PRIVATE_KEY')]:1})"],
  ["sparse array", "Array(2)"],
  ["custom prototype", "Object.create({PRIVATE_KEY:1})"],
  ["cycle", "(() => { const x = {}; x.x = x; return x; })()"],
  ["getter", "({ get value() { while (true) {} } })"],
  ["throwing getter", "({ get PRIVATE_KEY() { throw new Error('PRIVATE_GETTER'); } })"],
  ["toJSON", "({ toJSON() { while (true) {} } })"],
  ["proxy inspection loops", "new Proxy({}, { getPrototypeOf() { while (true) {} }, ownKeys() { while (true) {} } })"],
  ["nested proxy", "({safe:new Proxy({}, {ownKeys(){throw new Error('PRIVATE_PROXY');}})})"],
  ["revoked proxy", "(() => { const value=Proxy.revocable({},{});value.revoke();return value.proxy; })()"],
  ["oversize output", "'x'.repeat(65536)"],
  ["oversize UTF8 output", "'😀'.repeat(16384)"],
  ["encoded frame depth", "(() => { let x = 0; for (let i=0;i<32;i++) x = [x]; return x; })()"],
  ["deep output", "(() => { let x = 0; for (let i=0;i<40;i++) x = [x]; return x; })()"],
  ["dynamic import promise", "import('node:fs')"],
] as const) test(`resident return cleanup rejects ${label} with only a fixed category and reaps real process`, async () => {
  const worker = await compile(`export function analyze(input) { return input ? ${expression} : {value:7}; }`, "analyze", 200);
  expect(await analyze(worker, 1, false)).toEqual({ v: 1, type: "resident_result", id: 1, value: { value: 7 } });
  expect(await analyze(worker, 2, true)).toEqual({ v: 1, type: "resident_fault", id: 2, origin: "invalid_return_json" });
  expect(await worker.closed).not.toBe(0);
  expect(worker.child.exitCode).not.toBeNull();
  await expect(worker.read()).rejects.toThrow("worker closed");
});

test.each(["resident_activate", "resident_step"] as const)(
  "resident return cleanup classifies nonfinite %s state without committing a decision", async type => {
    const worker = await compile(`export function step(frame,state,intent) {
      return {choice:{kind:"observe"},next_state:{PRIVATE_KEY:Infinity},status:"running",events:[]};
    }`, "step", 25);
    worker.send({ v: 1, type, id: 1, frame: {}, state: null, intent: null });
    expect(await worker.read()).toEqual({ v: 1, type: "resident_fault", id: 1, origin: "invalid_return_json" });
    expect(await worker.closed).not.toBe(0);
    await expect(worker.read()).rejects.toThrow("worker closed");
  });

test("resident return cleanup preserves valid JSON null rather than using it as a failure sentinel", async () => {
  const worker = await compile("export function analyze(input) { return null; }");
  expect(await analyze(worker, 1, null)).toEqual({ v: 1, type: "resident_result", id: 1, value: null });
  expect(await analyze(worker, 2, null)).toEqual({ v: 1, type: "resident_result", id: 2, value: null });
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

test("oversize next_state in a bounded worker result is rejected by the trusted state contract", async () => {
  const worker = await compile(`export function step(frame,state,intent) { return { input: ${JSON.stringify(neutralInput)}, next_state: 'x'.repeat(16384), status: 'running', events: [] }; }`, "step");
  worker.send({ v: 1, type: "resident_step", id: 1, frame: {}, state: null, intent: null });
  const reply = await worker.read();
  const value = reply !== null && typeof reply === "object" && "value" in reply ? reply.value : null;
  try { parseGeneratedResidentResult(value); throw new Error("Oversize state was accepted"); }
  catch (error) {
    expect(error).toBeInstanceOf(GeneratedControllerResultValidationError);
    if (!(error instanceof GeneratedControllerResultValidationError)) throw error;
    expect(error.issues).toContainEqual({ path: "next_state", code: "custom", constraint: "utf8_bytes", maximum: 16384 });
  }
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
test("host refuses tracking artifacts before source dispatch when the kernel lacks tracking math", async () => {
  const directory = mkdtempSync(join(tmpdir(), "resident-old-kernel-"));
  const guardian = join(directory, "guardian.mjs"), dispatched = join(directory, "source-dispatched");
  writeFileSync(guardian, `
    import { writeFileSync } from "node:fs";
    process.stdout.write(JSON.stringify({v:1,type:"resident_ready",id:0,runtime_features:["pure_modules_v1"]})+"\\n");
    process.stdin.on("data",()=>writeFileSync(${JSON.stringify(dispatched)},"unexpected dispatch"));
    process.stdin.on("end",()=>process.exit(0));
    process.stdin.resume();
  `);
  const sandbox = new SandboxService(directory);
  Object.assign(sandbox, { state: { status: "ready", image: "old-kernel-fixture", error: null },
    runner: new URL("../sandbox/worker.mjs", import.meta.url).pathname, guardian });
  try {
    const source = await validateProgramSource(
      "export function analyze(input) { return motion.track(input.options,input.state); }",
      "analyze", minecraftTestAdapter(),
    );
    await expect(sandbox.createResidentAnalysisWorker(singletonExecutableModuleBundle(source.source, "analyze"),
      1000, new AbortController().signal)).rejects.toThrow("required pure module motion features");
    expect(existsSync(dispatched)).toBe(false);
  } finally { await sandbox.close(); rmSync(directory, { recursive: true, force: true }); }
});

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
    send({v:1,type:"resident_ready",id:0,runtime_features:["pure_modules_v1","motion_track_v1"]});
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
    ? await sandbox.createResidentAnalysisWorker(singletonExecutableModuleBundle("export function analyze(input) { return input; }", "analyze"), 1000, new AbortController().signal)
    : await sandbox.createResidentWorker(singletonExecutableModuleBundle("export function step(frame,state,intent) { return null; }", "step"), 25, new AbortController().signal);
  return { worker, release() { writeFileSync(release, "drained"); }, async close() {
    writeFileSync(release, "drained"); await sandbox.close(); rmSync(directory, { recursive: true, force: true });
  } };
}
const evaluationFrame = { v: 2, type: "guardian_analysis_evaluated", id: 1, entry: "analyze", elapsed_ms: 7, outcome: "result" };

function hostSkillProtocol() {
  const directory = mkdtempSync(join(tmpdir(), "skill-guardian-protocol-"));
  const guardian = join(directory, "guardian.mjs");
  // Replace the Docker/cgroup guardian only. DockerSkillWorker still parses
  // real authored frames, enforces budgets, replies and joins actual cleanup.
  writeFileSync(guardian, `
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
const send=value=>process.stdout.write(value+"\\n");
let worker=null,closing=false;
const lines=createInterface({input:process.stdin});
send(JSON.stringify({v:1,type:"ready",id:0}));
lines.on("line",line=>{
  const frame=JSON.parse(line);
  if(frame.type==="skill_init") {
    worker=new Worker(${JSON.stringify(new URL("../sandbox/worker.mjs", import.meta.url).pathname)},{
      workerData:{mode:"skill",source:frame.source,source_hash:frame.source_hash,args:frame.args,
        api:frame.api,instrumentation:frame.instrumentation},stdout:true,stderr:true
    });
    worker.on("message",send);
    worker.on("error",()=>{if(!closing)process.exit(1)});
  } else worker.postMessage(frame);
});
lines.on("close",async()=>{closing=true;if(worker)await worker.terminate();process.exit(0)});
`);
  const sandbox = new SandboxService(directory);
  Object.assign(sandbox, { state: { status: "ready", image: "controlled-guardian", error: null },
    runner: new URL("../sandbox/worker.mjs", import.meta.url).pathname, guardian });
  return { sandbox, async close() {
    await sandbox.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

for (const mode of ["valid", "invalid", "budget"] as const)
test(`host skill transport ${mode} attention uses the shipped worker and existing capability admission`, async () => {
  const fixture = hostSkillProtocol(), { sandbox } = fixture;
  const admitted: SkillCapabilityRequest[] = [];
  let budgetFailures = 0;
  const source = `const value=await game.attention({urgency:${JSON.stringify(mode === "invalid" ? "immediate" : "ordinary")},
summary:"Explicit cognition request",details:{marker:"host-transport"}});
if(value!==undefined)throw new Error("Expected void");
await game.action({kind:"look",yaw:0,pitch:0});
return {status:"completed",summary:"Continued foreground after attention",result:null};`;
  try {
    const result = sandbox.runSkill(source, null, async request => {
      admitted.push(request);
      return request.kind === "action" ? { status: "succeeded", summary: "Neutral fixture action", evidence: null } : null;
    }, { ...DEFAULT_SKILL_LIMITS, max_calls: mode === "budget" ? 1 : 2 }, new AbortController().signal, {
      api: { api_version: 5, action_enabled: true, supports_respawn: false, bindings: [] },
      onCapabilityBudgetExceeded: () => { budgetFailures++; return new Error("Existing transport budget exhausted"); },
    });
    if (mode === "valid") {
      expect(await result).toMatchObject({ status: "completed", summary: "Continued foreground after attention" });
      expect(admitted.map(request => request.kind)).toEqual(["attention", "action"]);
    } else {
      await expect(result).rejects.toThrow(mode === "budget" ? "Existing transport budget exhausted" : "invalid or oversized protocol frame");
      expect(admitted.map(request => request.kind)).toEqual(mode === "budget" ? ["attention"] : []);
    }
    expect(budgetFailures).toBe(mode === "budget" ? 1 : 0);
  } finally { await fixture.close(); }
}, 10000);

for (const mode of ["valid", "calls", "actions", "revoked"] as const)
test(`confirmed emitted failure fresh feedback preserves ${mode} host admission`, async () => {
  const fixture = hostSkillProtocol();
  const requests: SkillCapabilityRequest[] = [];
  let effects = 0, budgetFailures = 0;
  const outcome = { status: "failed", summary: "Owned packet processed without target damage", evidence: {
    world_effect_emitted: true, neutralized: true, failure_outcome_confirmed: true,
  } };
  const source = `
try {
  const checked=await game.actionAndObserve({kind:"look",yaw:0,pitch:0});
  if(checked.action.status!=="failed" || checked.action.evidence.world_effect_emitted!==true)
    return {status:"failed",summary:"Original attempted input was misrepresented",result:null};
  if(!checked.observation || checked.observation.data.done)
    return {status:"blocked",summary:"No new action selected",result:null};
  const correction=checked.observation.data.offset>0?-0.4:0.4;
  await game.action({kind:"look",yaw:correction,pitch:0});
  return {status:"completed",summary:"Different authored action selected from fresh feedback",result:null};
} catch(error) {
  return {status:"blocked",summary:"Fresh authority revoked",result:{code:error.code}};
}`;
  try {
    const result = fixture.sandbox.runSkill(source, null, async (request): Promise<Json> => {
      requests.push(request);
      if (request.kind === "action") {
        effects++;
        return effects === 1 ? outcome : { status: "succeeded", summary: "Different look applied", evidence: null };
      }
      if (mode === "revoked")
        throw new RuntimeFault("stale_context", "Authority revoked after action");
      return { data: { done: false, offset: 2 } };
    }, { ...DEFAULT_SKILL_LIMITS, max_calls: mode === "calls" ? 1 : 3, max_actions: mode === "actions" ? 1 : 2 },
    new AbortController().signal, {
      api: { api_version: 5, action_enabled: true, supports_respawn: false, bindings: [] },
      onCapabilityBudgetExceeded: () => { budgetFailures++; return new Error("Existing shared budget exhausted"); },
    });
    if (mode === "calls" || mode === "actions") {
      await expect(result).rejects.toThrow("Existing shared budget exhausted");
      expect(requests.map(request => request.kind)).toEqual(mode === "calls" ? ["action"] : ["action", "observe"]);
      expect(effects).toBe(1);
      expect(budgetFailures).toBe(1);
    } else if (mode === "valid") {
      expect((await result).status).toBe("completed");
      expect(requests).toEqual([
        { kind: "action", action: { kind: "look", yaw: 0, pitch: 0 } },
        { kind: "observe" },
        { kind: "action", action: { kind: "look", yaw: -0.4, pitch: 0 } },
      ]);
      expect(effects).toBe(2);
      expect(budgetFailures).toBe(0);
    } else {
      expect(await result).toMatchObject({ status: "blocked", result: { code: "stale_context" } });
      expect(requests.map(request => request.kind)).toEqual(["action", "observe"]);
      expect(effects).toBe(1);
      expect(budgetFailures).toBe(0);
    }
  } finally { await fixture.close(); }
}, 10000);

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
