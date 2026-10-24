import { mock } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as fsSync from "node:fs";
import * as childProcesses from "node:child_process";
import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { StudyLedger, type AttemptReservation } from "../../src/evaluation/studies.ts";
import type { ReferenceResult } from "../../src/evaluation/policy-reference.ts";
import { canonicalReferenceJson, controllerManifestHash, validateControllerManifest } from "../../src/shared/controllers.ts";
import { referenceStudyFixture } from "./reference-study.ts";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";

// Isolated child driver: only OS/process/cgroup/clock/persistence seams are substituted.
// All protocol workers/helpers below are real stdlib subprocesses; all ledger/files are real.
// No production function is replaced. Positive external protocol replies only reach the
// lifecycle boundary under test; they are never asserted as policy/gameplay competence.
const root = resolve(process.argv[2]!), mode = process.argv[3]!;
const actualFs = { ...fsPromises }, actualSync = { ...fsSync }, actualChild = { ...childProcesses };
const runtime = fileURLToPath(new URL("../fixtures/reference-review-process.ts", import.meta.url));
actualSync.mkdirSync(root, { recursive: true });
const project = join(root, "project"); actualSync.mkdirSync(project);
const fixture = referenceStudyFixture(project);
const prepared = join(project, "prepared"), output = join(root, "run"); actualSync.mkdirSync(prepared);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const write = (path: string, content: string) => { actualSync.mkdirSync(dirname(path), { recursive: true }); actualSync.writeFileSync(path, content); return { sha256: hash(content), bytes: Buffer.byteLength(content) }; };
const input = JSON.parse(JSON.stringify(fixture.controller));
for (const artifact of input.artifacts) {
  const path = artifact.id === "engine" ? "engine/build/libs/mcprec-6.13.jar" : `artifacts/${artifact.id}.json`;
  input.execution.artifact_paths[artifact.id] = path;
  Object.assign(artifact, write(join(prepared, path), `Synthetic external-seam ${artifact.id}; never a model/game artifact.\n`));
}
for (const name of ["steve1", "mineclip", "minerl"])
  write(join(prepared, "sources", name, "fixture-identity.txt"), "Synthetic upstream-dependency seam, not executed.\n");
actualSync.mkdirSync(join(prepared, "tokenizer-cache"));
input.execution.dependency_inventory_path = input.execution.artifact_paths.dependencies;
input.execution.configuration_path = input.execution.artifact_paths.configuration;
input.runtime.dependency_lock_sha256 = input.artifacts.find((value: { id: string }) => value.id === "dependencies").sha256;
const { configuration_sha256: ignored, ...runtimeConfiguration } = input.runtime;
const configuration = write(join(prepared, input.execution.configuration_path), JSON.stringify({ sources: input.sources, runtime: runtimeConfiguration,
  device: input.device, simulator: input.simulator, preprocessing: input.preprocessing, action_mapping: input.action_mapping }));
Object.assign(input.artifacts.find((value: { id: string }) => value.id === "configuration"), configuration);
input.runtime.configuration_sha256 = configuration.sha256;
function treeHash(directory: string) {
  const entries: { path: string; bytes: number; sha256: string }[] = [];
  const visit = (path: string): void => {
    const entry = actualSync.lstatSync(path);
    if (entry.isDirectory()) for (const name of actualSync.readdirSync(path).sort()) visit(join(path, name));
    else { const bytes = actualSync.readFileSync(path); entries.push({ path: relative(directory, path), bytes: bytes.length, sha256: hash(bytes) }); }
  };
  visit(directory); return hash(canonicalReferenceJson(entries));
}
input.execution.prepared_tree_sha256 = treeHash(prepared);
input.execution.runner_tree_sha256 = treeHash(join(project, "policies"));
const controller = validateControllerManifest(input);
const identity = (path: string) => ({ path: relative(project, path), sha256: hash(actualSync.readFileSync(path)) });
actualSync.writeFileSync(join(project, "private/controller.json"), JSON.stringify(controller));
fixture.manifest.identities.controller = identity(join(project, "private/controller.json"));
fixture.manifest.identities.dependencies = identity(join(prepared, input.execution.dependency_inventory_path));
fixture.manifest.identities.preprocessing = [identity(join(prepared, input.execution.configuration_path))];
actualSync.writeFileSync(join(project, "profile.json"), JSON.stringify({ schema_version: 1, controller_manifest_sha256: controllerManifestHash(controller),
  observation: { schema_version: 1, kind: "rgb", permitted_keys: ["pov"] }, preprocessing: controller.preprocessing, action_mapping: controller.action_mapping, clock: "synchronous" }));
fixture.manifest.identities.profile = identity(join(project, "profile.json"));
fixture.manifest.arms[0]!.profile = fixture.manifest.identities.profile;
actualSync.writeFileSync(join(project, "fixture-build.txt"), JSON.stringify({ schema_version: 1, image: controller.execution!.image, runner_tree_sha256: controller.execution!.runner_tree_sha256 }));
fixture.manifest.identities.build = identity(join(project, "fixture-build.txt"));
const ledger = new StudyLedger(join(root, "governance"), { projectRoot: project });
const ref = ledger.registerStudy(fixture.manifest);
const tracked: { child: childProcesses.ChildProcess; kind: string; closed: boolean }[] = [];
const marks = (name: string, value: unknown = true) => actualSync.writeFileSync(join(root, `${name}.json`), JSON.stringify(value));
let clockOffset = 0;
const monotonic = performance.now.bind(performance);
Object.defineProperty(performance, "now", { configurable: true, value: () => monotonic() + clockOffset });
const procRoot = join(root, "cgroup");
for (const role of ["supervisor", "policy", "environment"]) {
  const fields = { "memory.max": role === "supervisor" ? "536870912" : role === "policy" ? "5368709120" : "2684354560",
    "memory.current": role === "supervisor" ? "4096" : "8388608", "memory.stat": "anon 1048576\ninactive_file 7340032\n",
    "pids.max": role === "supervisor" ? "32" : role === "policy" ? "128" : "96", "pids.current": "1", "cpu.max": "100000 100000", "cgroup.procs": "123\n" };
  for (const [name, value] of Object.entries(fields)) write(join(procRoot, role, name), value);
}
write(join(root, "meminfo"), "MemAvailable: 67108864 kB\n");
write(join(root, "self-cgroup"), "0::/reference-review-supervisor\n");
function track(child: childProcesses.ChildProcess, kind: string) {
  const entry = { child, kind, closed: false }; tracked.push(entry);
  child.once("close", () => { entry.closed = true; marks(`closed-${child.pid}`, kind); });
  return child;
}
const processEnv = () => ({ ...process.env, REFERENCE_REVIEW_ROOT: root, REFERENCE_REVIEW_MODE: mode });
function spawnShim(command: string, args: readonly string[], options: childProcesses.SpawnOptions = {}) {
  if (command === process.execPath && args[0] === runtime)
    return track(actualChild.spawn(command, args, options), "helper");
  if (command !== "docker" && command !== "nvidia-smi") throw new Error(`Unexpected owned binary ${command}`);
  if (command === "docker" && args[0] === "run") return track(actualChild.spawn(process.execPath, [runtime, "worker", JSON.stringify(args)],
    { ...options, env: { ...options.env, ...processEnv() } }), "worker");
  return track(actualChild.spawn(process.execPath, [runtime, "exec", JSON.stringify({ command, args })],
    { ...options, env: { ...options.env, ...processEnv() } }), "helper");
}
function execFileShim(command: string, args: readonly string[], options: childProcesses.ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void) {
  return track(actualChild.execFile(process.execPath, [runtime, "exec", JSON.stringify({ command, args })], { ...options, env: processEnv(), encoding: "utf8" },
    (error, stdout, stderr) => callback(error, String(stdout), String(stderr))), "helper");
}
Object.defineProperty(execFileShim, promisify.custom, { value: (command: string, args: readonly string[], options: childProcesses.ExecFileOptions) => {
  const deferred = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const child = execFileShim(command, args, options, (error, stdout, stderr) => error ? deferred.reject(error) : deferred.resolve({ stdout, stderr }));
  return Object.assign(deferred.promise, { child });
} });
function mappedResource(path: string) {
  if (path === "/proc/self/cgroup") return join(root, "self-cgroup");
  if (path === "/proc/meminfo") return join(root, "meminfo");
  const logical = /^\/sys\/fs\/cgroup\/reference-review-(supervisor|policy|environment)\/(.+)$/.exec(path);
  if (logical) return join(procRoot, logical[1]!, logical[2]!);
  const pid = /^\/proc\/(\d+)\/cgroup$/.exec(path);
  if (pid) {
    for (const role of ["policy", "environment"]) {
      const file = join(root, `${role}.pid`);
      if (actualSync.existsSync(file) && actualSync.readFileSync(file, "utf8") === pid[1]) {
        const destination = join(root, `${role}-cgroup`); write(destination, `0::/reference-review-${role}\n`); return destination;
      }
    }
  }
  return path;
}
let journalOpened = 0, journalClosed = 0, injected = false;
const persistenceError = (phase: string) => Object.assign(new Error(`F7 injected ${phase} ENOSPC/EIO`), { code: phase === "report" ? "ENOSPC" : "EIO" });
mock.module("node:child_process", () => ({ ...actualChild, spawn: spawnShim, execFile: execFileShim }));
mock.module("node:fs/promises", () => ({ ...actualFs,
  readFile: (path: string, ...args: unknown[]) => Reflect.apply(actualFs.readFile, null, [mappedResource(String(path)), ...args]),
  open: async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await actualFs.open(...args);
    if (basename(String(args[0])) !== "reference-events.jsonl") return handle;
    journalOpened++;
    return { fd: handle.fd,
      async write(...values: unknown[]) {
        if (mode === "journal-write" && !injected) { injected = true; await handle.write(String(values[0]).slice(0, 12)); throw persistenceError("write"); }
        return Reflect.apply(handle.write, handle, values);
      },
      async sync() {
        if (mode === "journal-sync" && !injected && tracked.filter(entry => entry.kind === "worker").every(entry => entry.closed)) {
          injected = true; throw persistenceError("sync");
        }
        return handle.sync();
      },
      async close() { await handle.close(); journalClosed++; marks("journal-closed"); },
    };
  },
  writeFile: async (...args: Parameters<typeof fsPromises.writeFile>) => {
    if (mode === "report-write" && basename(String(args[0])) === "reference-result.json" && !injected) { injected = true; throw persistenceError("report"); }
    return actualFs.writeFile(...args);
  },
}));
let held = false;
mock.module("node:fs", () => ({ ...actualSync,
  createReadStream: (...args: Parameters<typeof fsSync.createReadStream>) => {
    const stream = actualSync.createReadStream(...args);
    if (mode !== "setup-deadline" || held || String(args[0]) !== join(prepared, input.execution.artifact_paths.source)) return stream;
    held = true;
    const gate = new Transform({ transform(chunk, _encoding, callback) {
      marks("hash-read-held");
      void (async () => {
        while (!actualSync.existsSync(join(root, "release-hash.json"))) await delay(5);
        clockOffset = controller.limits.setup_wall_ms + 1;
        callback(null, chunk);
      })().catch(callback);
    } });
    stream.on("error", error => gate.destroy(error));
    return stream.pipe(gate);
  },
}));
const unhandled: string[] = [];
// Observe (and assert against) source-owned promise loss without letting it hide
// the journal/SQLite/child state by terminating this isolated diagnostic PID.
process.on("unhandledRejection", error => { unhandled.push(String(error)); });
const abort = new AbortController();
const signalHandler = (signal: string) => { marks("signal-received", signal); abort.abort(new Error(`Operator ${signal}`)); };
const driverCompleted = Promise.withResolvers<void>();
let sdkSignal: string | null = null;
const unregisterPostmortem = postmortem.register(`reference-review-driver-${mode}`, reason => {
  sdkSignal = reason === postmortem.Reason.SIGINT ? "SIGINT" : reason === postmortem.Reason.SIGTERM ? "SIGTERM" : String(reason);
  marks("sdk-postmortem-owner", sdkSignal);
  signalHandler(sdkSignal);
  return driverCompleted.promise;
}, { exitOnly: true });
let reservation: AttemptReservation | undefined;
let prematureDrain = false, stateAtDrain: unknown = null, result: unknown = null, thrown: string | null = null;
const governance = {
  async reserve(identity: string) { if (identity !== controllerManifestHash(controller)) throw new Error("Regression controller identity mismatch");
    reservation = ledger.reserveStudyAttempt(ref, fixture.manifest.schedule[0]!.slot); return { reservationId: reservation.reservationId }; },
  async settle(value: ReferenceResult, evidence: readonly string[]) {
    if (!reservation) throw new Error("Missing regression reservation");
    const pass = value.reference_status === "passed";
    ledger.settleStudyAttempt(reservation, { outcome: { platform_status: value.terminal === "completed" && value.failures.length === 0 ? "pass" : "fail",
      agent_status: pass ? "goal_verified" : "unknown", provider_status: "not_called", goal_verified: pass ? true : null,
      classification_reason: ["Synthetic external dependencies; actual production lifecycle only", ...value.failures] }, usage: null, evidence,
      stop_reason: value.terminal === "completed" && value.failures.length === 0 ? null : value.terminal === "limit" ? "allowance_exhausted" : "invalid_platform" });
  },
  async interrupt(reason: string) { if (!reservation) throw new Error("Missing regression reservation"); ledger.interruptStudyAttempt(reservation, reason); },
  async confirmDrain(evidence: readonly string[]) {
    if (!reservation) throw new Error("Missing regression reservation");
    prematureDrain ||= tracked.some(entry => !entry.closed);
    stateAtDrain = tracked.map(entry => ({ pid: entry.child.pid, kind: entry.kind, closed: entry.closed }));
    ledger.confirmStudyResourceDrain(reservation, { requests_drained: true, runtime_closed: true, native_closed: true, evidence });
  },
};
const coordination = setInterval(() => {
  if (mode === "responsive-final-sampler" && actualSync.existsSync(join(root, "final-behavior-response.json")))
    marks("release-responsive-sampler", { at_ms: Date.now() });
  if (mode === "setup-deadline" && actualSync.existsSync(join(root, "hash-read-held.json"))) marks("release-hash");
  if (mode === "deadline" && actualSync.existsSync(join(root, "environment-close-requested.json")) && !abort.signal.aborted) {
    abort.abort(new Error("Study wall allocation deadline")); marks("deadline-fired"); marks("release-close");
  }
}, 5);
try {
  const { runReferenceScreen } = await import("../../src/evaluation/policy-reference.ts");
  result = await runReferenceScreen({ manifest: controller, preparedRoot: prepared, fixturesRoot: join(project, "private"), runnerRoot: join(project, "policies"), outputRoot: output,
    governance, signal: abort.signal });
} catch (error) { thrown = error instanceof Error ? error.message : String(error); }
finally {
  clearInterval(coordination);
  const state = ledger.readStudy(ref);
  ledger.close();
  const activeAtReturn = tracked.filter(entry => !entry.closed).map(entry => ({ pid: entry.child.pid, kind: entry.kind }));
  const observation = { mode, result, thrown, state, prematureDrain, stateAtDrain, activeAtReturn, journalOpened, journalClosed,
    unhandled, sdkSignal, imageInspected: actualSync.existsSync(join(root, "image-inspected.json")), workerStarts: tracked.filter(entry => entry.kind === "worker").length };
  for (const entry of tracked) if (!entry.closed) entry.child.kill("SIGKILL");
  await Promise.all(tracked.map(async entry => {
    if (entry.closed) return;
    const closed = Promise.withResolvers<void>(); entry.child.once("close", () => closed.resolve()); await closed.promise;
  }));
  actualSync.writeFileSync(join(root, "driver-report.json"), JSON.stringify({ ...observation, test_teardown_joined: tracked.every(entry => entry.closed) }, null, 2));
  driverCompleted.resolve();
  unregisterPostmortem();
}
