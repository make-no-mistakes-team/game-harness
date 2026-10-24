import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { spawn, execFile, type ChildProcess, type ChildProcessWithoutNullStreams, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { canonicalReferenceJson, controllerManifestHash, validateControllerManifest, type ControllerManifest } from "../shared/controllers.ts";

const exec = promisify(execFile);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const measuredSchema = z.object({ manifest_hash: sha256,
  artifacts: z.array(z.object({ id: z.string(), downloaded_sha256: sha256, downloaded_bytes: z.number().int().positive(), measurement: z.literal("local-read") }).strict()),
  sources: z.unknown(), runtime: z.unknown(), device: z.unknown(), simulator: z.unknown(), preprocessing: z.unknown(), action_mapping: z.unknown(),
  isolation: z.record(z.string(), z.unknown()),
  runtime_probe: z.object({ id: z.string(), passed: z.literal(true), model_kernels_exercised: z.literal(true) }).strict(),
}).strict();

/** Behavioral admission after the separately reserved setup/load/calibration phase. */
export function admitReference(manifest: ControllerManifest, evidence: unknown) {
  const proof = measuredSchema.parse(evidence);
  if (proof.manifest_hash !== controllerManifestHash(manifest)) throw new Error("Reference immutable declaration mismatch");
  const artifacts = new Map(proof.artifacts.map(item => [item.id, item]));
  if (artifacts.size !== proof.artifacts.length || artifacts.size !== manifest.artifacts.length) throw new Error("Artifact identity set mismatch");
  for (const artifact of manifest.artifacts) {
    const measured = artifacts.get(artifact.id);
    if (!measured || measured.downloaded_sha256 !== artifact.sha256 || measured.downloaded_bytes !== artifact.bytes) throw new Error(`Unverified reference artifact ${artifact.id}`);
  }
  for (const key of ["sources", "runtime", "device", "simulator", "preprocessing", "action_mapping"] as const)
    if (canonicalReferenceJson(proof[key]) !== canonicalReferenceJson(manifest[key])) throw new Error(`Measured reference configuration mismatch: ${key}`);
  const { confirmed, ...isolation } = proof.isolation;
  if (confirmed !== true || canonicalReferenceJson(isolation) !== canonicalReferenceJson(manifest.isolation)) throw new Error("Unconfirmed reference isolation");
  if (proof.runtime_probe.id !== manifest.device.runtime_compatibility_evidence) throw new Error("Runtime probe identity mismatch");
  return Object.freeze({ manifest_hash: proof.manifest_hash, candidate: manifest.candidate, clock: manifest.simulator.clock });
}

const behaviorResult = z.object({ id: z.string(), attempted: z.boolean(), verifier: z.boolean().nullable() }).passthrough();
const recordSchema = z.object({ manifest_hash: sha256, terminal: z.enum(["completed", "setup_error", "policy_error", "boundary_error", "limit", "interrupted"]),
  setup: z.enum(["passed", "failed", "unknown"]), scheduled_behavior_ids: z.array(z.string()).min(1), behaviors: z.array(behaviorResult),
  cleanup: z.enum(["confirmed", "unconfirmed"]), failures: z.array(z.string()), actual: z.record(z.string(), z.unknown()),
}).strict();
export type ReferenceRecord = z.infer<typeof recordSchema>;
export interface ReferenceResult extends ReferenceRecord {
  setup_status: ReferenceRecord["setup"];
  reference_status: "passed" | "failed" | "blocked" | "inconclusive";
  live_clock_status: "not_run";
  port_status: "not_run";
}

export function classifyReferenceResult(input: unknown): ReferenceResult {
  const record = recordSchema.parse(input);
  const covered = new Set(record.behaviors.filter(caseResult => caseResult.attempted).map(caseResult => caseResult.id));
  const complete = new Set(record.scheduled_behavior_ids).size === record.scheduled_behavior_ids.length
    && record.behaviors.length === record.scheduled_behavior_ids.length && covered.size === record.behaviors.length
    && record.scheduled_behavior_ids.every(id => covered.has(id));
  let reference: "passed" | "failed" | "blocked" | "inconclusive" = "inconclusive";
  if (record.setup === "failed") reference = "blocked";
  else if (record.setup === "passed" && record.terminal === "completed" && record.cleanup === "confirmed" && complete
    && record.failures.length === 0 && record.behaviors.every(caseResult => caseResult.verifier !== null)) reference = record.behaviors.every(caseResult => caseResult.verifier) ? "passed" : "failed";
  return { ...record, setup_status: record.setup, reference_status: reference, live_clock_status: "not_run" as const, port_status: "not_run" as const };
}

export async function referenceFileIdentity(path: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  signal?.throwIfAborted();
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error("Reference input must be a real regular file without symlinks");
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const block of createReadStream(path, { signal })) { digest.update(block); bytes += block.length; }
  if (bytes !== entry.size) throw new Error("Reference input changed while hashing");
  return { sha256: digest.digest("hex"), bytes };
}

export async function referenceTreeIdentity(root: string, signal?: AbortSignal): Promise<string> {
  const entries: { path: string; bytes: number; sha256: string }[] = [];
  const visit = async (path: string): Promise<void> => {
    signal?.throwIfAborted();
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error("Reference tree contains a symlink");
    if (entry.isDirectory()) { for (const name of (await readdir(path)).sort()) await visit(join(path, name)); }
    else if (entry.isFile()) entries.push({ path: relative(root, path).split(sep).join("/"), ...await referenceFileIdentity(path, signal) });
    else throw new Error("Reference tree contains a nonregular input");
  };
  await visit(root);
  return createHash("sha256").update(canonicalReferenceJson(entries)).digest("hex");
}

type Wire = Record<string, unknown>;
const wireObject = z.record(z.string(), z.unknown());

/** Node child-process timeouts require integers; zero must never disable a deadline. */
export function referenceRemainingMs(deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Reference ownership deadline expired");
  return Math.min(remaining, 2147483647);
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number, reason: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(reason)), referenceRemainingMs(deadline));
  try { return await Promise.race([work, expired.promise]); } finally { clearTimeout(timer); }
}

/** Own the real helper process-close events, not just fail-fast result promises. */
class ReferenceCommands {
  readonly #active = new Set<{ child: ChildProcess; closed: Promise<void>; settled: Promise<void>; isClosed: boolean;
    cleanup: boolean; escalation: ReturnType<typeof setTimeout> | undefined }>();
  #accepting = true;
  async run(binary: string, args: string[], options: ExecFileOptions & { timeout: number; maxBuffer: number }, cleanup = false) {
    if (!this.#accepting && !cleanup) throw new Error("Reference helper admission is closed");
    const timeout = Math.ceil(options.timeout);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Reference helper deadline expired or unknown");
    const running = exec(binary, args, { ...options, encoding: "utf8", timeout });
    const executionDeadline = performance.now() + timeout;
    const closed = Promise.withResolvers<void>();
    const entry = { child: running.child, closed: closed.promise, settled: Promise.resolve(), isClosed: false, cleanup,
      escalation: undefined as ReturnType<typeof setTimeout> | undefined };
    this.#active.add(entry);
    // execFile's own timeout sends SIGTERM, which is not a finite guarantee.
    // The owner independently escalates at the cap and still requires close.
    const hardKill = setTimeout(() => { if (!entry.isClosed) entry.child.kill("SIGKILL"); }, timeout);
    entry.child.once("close", () => {
      entry.isClosed = true; clearTimeout(entry.escalation); clearTimeout(hardKill); closed.resolve();
    });
    entry.settled = Promise.allSettled([running, closed.promise]).then(() => { this.#active.delete(entry); });
    const [result] = await beforeDeadline(Promise.all([running, closed.promise]), executionDeadline, "Reference helper execution/close deadline");
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  }
  closeAdmissions(): void { this.#accepting = false; }
  stop(includeCleanup = false): void {
    this.closeAdmissions();
    for (const entry of this.#active) {
      if (entry.isClosed || (!includeCleanup && entry.cleanup)) continue;
      entry.child.kill("SIGTERM");
      entry.escalation ??= setTimeout(() => {
        if (!entry.isClosed) entry.child.kill("SIGKILL");
      }, 250);
    }
  }
  async drain(deadline: number): Promise<boolean> {
    this.stop(true);
    try {
      await beforeDeadline(Promise.allSettled([...this.#active].map(entry => entry.settled)), deadline, "Reference helper drain deadline");
      return this.#active.size === 0;
    } catch {
      for (const entry of this.#active) if (!entry.isClosed) entry.child.kill("SIGKILL");
      return false; // A kill request or PID disappearance is not a close receipt.
    }
  }
}

export class ReferenceProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly #pending = new Map<string, { kind: string; resolve(value: Wire): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  readonly #readline;
  #failed: Error | null = null;
  #stderrBytes = 0;
  #closeAcknowledged = false;
  #closed = false;
  #fenced = false;
  #faultReported = false;
  constructor(readonly name: string, args: string[], readonly onLog: (entry: Wire) => void, readonly onFailure?: (error: Error) => void) {
    if (args[0] !== "run" || args.includes("--tty") || args.includes("-t")) throw new Error("Reference protocol requires docker run without a TTY");
    const launch = args.includes("--interactive") || args.includes("-i") ? args : ["run", "--interactive", ...args.slice(1)];
    this.child = spawn("docker", launch, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST } });
    const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    this.closed = closed.promise;
    this.child.once("close", (code, signal) => {
      this.#closed = true;
      if (!this.#fenced && !(this.#closeAcknowledged && code === 0 && signal === null))
        this.fail(new Error(`${name} transport closed (${code}/${signal})`));
      closed.resolve({ code, signal });
    });
    this.child.on("error", error => this.fail(error));
    this.#readline = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.#readline.on("line", line => {
      if (this.#fenced) {
        this.fail(new Error(`${name}: late protocol output after scope fence`));
        return;
      }
      try {
        if (Buffer.byteLength(line) > 2_000_000) throw new Error("Reference protocol output exceeded byte limit");
        const value = wireObject.parse(JSON.parse(line));
        if (value.kind === "error") throw new Error(`${name}: ${value.error}`);
        const id = value.request_id;
        if (typeof id !== "string") throw new Error("Uncorrelated reference output");
        const pending = this.#pending.get(id);
        if (!pending) throw new Error("Late/duplicate reference output");
        if (pending.kind === "close") {
          if (value.kind !== "closed") throw new Error("Malformed reference shutdown acknowledgement");
          this.#closeAcknowledged = true;
        }
        this.#pending.delete(id); clearTimeout(pending.timer); pending.resolve(value);
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    this.child.stderr.on("data", (block: Buffer) => {
      this.#stderrBytes += block.length;
      if (this.#stderrBytes > 8 * 1024 * 1024) this.fail(new Error("Reference diagnostic log limit"));
      else {
        try { this.onLog({ kind: "process_stderr", process: name, text: block.toString("utf8") }); }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      }
    });
  }
  fail(error: Error): void {
    if (this.#faultReported) return;
    this.#faultReported = true;
    this.#failed = error;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(this.#failed); }
    this.#pending.clear();
    this.onFailure?.(error);
  }
  async request(kind: string, payload: Wire, timeoutMs: number): Promise<Wire> {
    if (this.#failed) throw this.#failed;
    if (this.#closed) throw new Error("Reference transport is already closed");
    if (this.#pending.size) throw new Error("Reference process has unresolved single-flight output");
    const id = randomUUID();
    const result = Promise.withResolvers<Wire>();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Reference request deadline expired");
    const timer = setTimeout(() => this.fail(new Error(`${this.name} ${kind} deadline`)), Math.ceil(timeoutMs));
    this.#pending.set(id, { kind, resolve: result.resolve, reject: result.reject, timer });
    const serialized = JSON.stringify({ request_id: id, kind, ...payload });
    if (Buffer.byteLength(serialized) > 2_000_000) { this.fail(new Error("Reference input byte limit")); return result.promise; }
    this.child.stdin.write(serialized + "\n", error => { if (error) this.fail(error); });
    return result.promise;
  }
  fence(reason: string): void {
    this.#fenced = true;
    this.#failed ??= new Error(reason);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(this.#failed); }
    this.#pending.clear();
  }
}

export interface ReferenceGovernance {
  /** Must atomically reserve the exact registered manifest/slot in the existing StudyLedger. */
  reserve(manifestHash: string): Promise<{ reservationId: string }>;
  settle(result: ReferenceResult, evidence: readonly string[]): Promise<void>;
  interrupt(reason: string): Promise<void>;
  confirmDrain(evidence: readonly string[]): Promise<void>;
}

export interface ReferenceScreenOptions {
  manifest: ControllerManifest;
  preparedRoot: string;
  fixturesRoot: string;
  runnerRoot: string;
  outputRoot: string;
  governance: ReferenceGovernance;
  signal?: AbortSignal;
}

/** Read kernel-enforced limits, not an operator's assertion about a scope. */
export async function readReferenceSupervision(root: string) {
  const [memory, tasks, cpu, currentMemory, currentTasks, processes] = await Promise.all(
    ["memory.max", "pids.max", "cpu.max", "memory.current", "pids.current", "cgroup.procs"].map(name => readFile(join(root, name), "utf8")),
  );
  const quota = cpu!.trim().split(/\s+/).map(Number);
  const memoryLimit = Number(memory!.trim()), taskLimit = Number(tasks!.trim());
  if (!Number.isSafeInteger(memoryLimit) || memoryLimit <= 0 || memoryLimit > 536870912
    || !Number.isSafeInteger(taskLimit) || taskLimit <= 0 || taskLimit > 32
    || quota.length !== 2 || quota.some(value => !Number.isFinite(value) || value <= 0) || quota[0]! / quota[1]! > 1)
    throw new Error("Trusted supervision requires an enforced 512MiB/32-task/1-CPU cgroup");
  const rss = Number(currentMemory!.trim()), taskCount = Number(currentTasks!.trim());
  if (!Number.isSafeInteger(rss) || rss < 0 || !Number.isSafeInteger(taskCount) || taskCount < 1)
    throw new Error("Unknown trusted-supervision resource usage");
  if (rss > memoryLimit || taskCount > taskLimit) throw new Error("Trusted supervision exceeded its enforced partition");
  return { root, memory_limit_bytes: memoryLimit, task_limit: taskLimit, cpu_limit: quota[0]! / quota[1]!,
    rss_bytes: rss, tasks: taskCount, processes: processes!.trim().split(/\s+/).filter(Boolean).length };
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(root)) {
    const path = join(root, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Unexpected symlink in owned reference output");
    if (info.isDirectory()) total += await directoryBytes(path);
    else if (info.isFile()) total += info.size;
    else throw new Error("Unknown owned reference output kind");
  }
  return total;
}

/** The CLI owns this once per durable slot; there is no persistent policy service. */
export async function runReferenceScreen(options: ReferenceScreenOptions): Promise<ReferenceResult> {
  const manifest = validateControllerManifest(options.manifest), execution = manifest.execution;
  if (!execution) throw new Error("Reference execution declaration is missing");
  if (!execution.resource_partition) throw new Error("Explicit aggregate container resource partitions are required");
  const limits = manifest.limits, started = performance.now();
  const identity = controllerManifestHash(manifest);
  const reservation = await options.governance.reserve(identity);
  await mkdir(options.outputRoot, { recursive: false, mode: 0o700 });
  const journalPath = join(options.outputRoot, "reference-events.jsonl");
  const journal = await open(journalPath, "wx", 0o600);
  let writes = Promise.resolve(), journalBytes = 0;
  let journalFailed = false;
  const log = (entry: Wire): void => {
    if (journalFailed) return;
    const line = JSON.stringify({ at_ms: performance.now() - started, reservation_id: reservation.reservationId, ...entry }) + "\n";
    journalBytes += Buffer.byteLength(line);
    if (journalBytes > Math.min(limits.max_recording_bytes, 32 * 1024 * 1024)) throw new Error("Reference event journal limit");
    writes = writes.then(async () => { await journal.write(line); }).catch(error => {
      journalFailed = true;
      fail(new Error(`Reference journal write failed: ${error}`));
    });
  };
  const syncJournal = async (): Promise<void> => {
    try { await journal.sync(); }
    catch (error) { journalFailed = true; throw new Error(`Reference journal sync failed: ${error}`); }
  };
  const record: ReferenceRecord = { manifest_hash: identity, terminal: "setup_error", setup: "unknown", scheduled_behavior_ids: manifest.behaviors.map(value => value.id),
    behaviors: manifest.behaviors.map(value => ({ id: value.id, attempted: false, verifier: null })), cleanup: "unconfirmed", failures: [],
    actual: { inferences: 0, policy_calls: 0, text_encoder_calls: 0, prior_calls: 0, steps: 0, wall_ms: 0, peak_rss_bytes: null, peak_gpu_bytes: null,
      gpu_measurement_scope: "maximum observed whole-device samples including renderer; exact device high-water and owned-only usage remain unknown",
      ram_measurement_scope: "sampled raw owned cgroup memory.current including file cache and kernel charges; not exact high-water or process-only RSS",
      exact_gpu_peak_bytes: null, provider_requests: 0 } };
  const processes: ReferenceProcess[] = [];
  const commands = new ReferenceCommands();
  const setupScope = new AbortController();
  const setupDeadline = started + limits.setup_wall_ms;
  const stagedSignal = options.signal ? AbortSignal.any([options.signal, setupScope.signal]) : setupScope.signal;
  let latestResources: Record<string, number> | null = null;
  let monitor: ReturnType<typeof setInterval> | undefined, interrupted = false, deadlineExpired = false;
  const fault: { error: Error | null } = { error: null };
  let signalCleanupDeadline = Infinity;
  const resourceMonitor: { pending: Promise<void> | null; operations: Promise<void> | null; lastCompletedMs: number } = {
    pending: null, operations: null, lastCompletedMs: -Infinity };
  const retain = (error: Error): void => {
    fault.error ??= error;
    if (!record.failures.includes(error.message)) record.failures.push(error.message);
    record.terminal = interrupted ? "interrupted" : deadlineExpired || /deadline|allocation|limit/i.test(error.message) ? "limit"
      : record.setup === "passed" ? "boundary_error" : "setup_error";
    if (record.setup !== "passed") record.setup = "failed";
  };
  const fail = (error: Error): void => {
    retain(error);
    commands.stop();
    for (const child of processes) child.fence(error.message);
  };
  const abort = (): void => {
    const reason = options.signal?.reason instanceof Error ? options.signal.reason.message : "Reference interrupted by operator";
    interrupted = !/deadline|allocation|timeout/i.test(reason);
    deadlineExpired ||= !interrupted;
    if (interrupted) signalCleanupDeadline = Math.min(signalCleanupDeadline, performance.now() + 9000);
    fail(new Error(reason));
    // A signal can shorten an already-running removal/helper's original cap.
    // Keep its actual close owned, but do not wait past the SDK exit window.
    if (interrupted) commands.stop(true);
  };
  const setupExpired = (): void => { deadlineExpired = true; fail(new Error("Reference setup wall deadline expired")); };
  setupScope.signal.addEventListener("abort", setupExpired, { once: true });
  const setupTimer = setTimeout(() => setupScope.abort(new Error("Reference setup wall deadline expired")), referenceRemainingMs(setupDeadline));
  const assertSetup = (): void => {
    if (performance.now() >= setupDeadline && !setupScope.signal.aborted) setupScope.abort(new Error("Reference setup wall deadline expired"));
    stagedSignal.throwIfAborted();
    if (fault.error) throw fault.error;
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    log({ kind: "reserved", manifest_hash: identity });
    if (options.signal?.aborted) abort();
    assertSetup();
    const cgroup = /^0::(.+)$/m.exec(await readFile("/proc/self/cgroup", "utf8"));
    if (!cgroup) throw new Error("Trusted supervision requires Linux cgroup v2");
    const supervisionRoot = resolve("/sys/fs/cgroup", `.${cgroup[1]}`);
    log({ kind: "supervision_scope", ...await readReferenceSupervision(supervisionRoot) });
    assertSetup();
    const files = [];
    for (const artifact of manifest.artifacts) {
      const path = resolve(options.preparedRoot, execution.artifact_paths[artifact.id]!);
      if (!path.startsWith(resolve(options.preparedRoot) + sep)) throw new Error("Prepared artifact escaped root");
      assertSetup();
      const measured = await referenceFileIdentity(path, stagedSignal);
      assertSetup();
      if (measured.sha256 !== artifact.sha256 || measured.bytes !== artifact.bytes) throw new Error(`Prepared artifact mismatch ${artifact.id}`);
      files.push({ id: artifact.id, downloaded_sha256: measured.sha256, downloaded_bytes: measured.bytes, measurement: "local-read" as const });
    }
    if (await referenceTreeIdentity(options.preparedRoot, stagedSignal) !== execution.prepared_tree_sha256
      || await referenceTreeIdentity(options.runnerRoot, stagedSignal) !== execution.runner_tree_sha256) throw new Error("Prepared source/runner tree identity mismatch");
    assertSetup();
    const fixtureFiles = [];
    const verifier = await referenceFileIdentity(join(options.runnerRoot, "gameharness_policy/minerl_environment.py"), stagedSignal);
    for (const behavior of manifest.behaviors) {
      const path = resolve(options.fixturesRoot, execution.fixture_paths[behavior.id]!);
      if (!path.startsWith(resolve(options.fixturesRoot) + sep)) throw new Error("Fixture escaped private root");
      const measured = await referenceFileIdentity(path, stagedSignal);
      assertSetup();
      if (measured.sha256 !== behavior.fixture_sha256 || verifier.sha256 !== behavior.verifier_sha256) throw new Error("Fixture/verifier identity mismatch");
      fixtureFiles.push({ id: behavior.id, path: execution.fixture_paths[behavior.id]!, ...measured });
    }
    const config = wireObject.parse(JSON.parse(await readFile(join(options.preparedRoot, execution.configuration_path), { encoding: "utf8", signal: stagedSignal })));
    for (const key of ["sources", "device", "simulator", "preprocessing", "action_mapping"] as const)
      if (canonicalReferenceJson(config[key]) !== canonicalReferenceJson(manifest[key])) throw new Error(`Prepared effective configuration mismatch ${key}`);
    // The configuration artifact cannot contain its own content hash.
    const { configuration_sha256: configurationIdentity, ...runtimeConfiguration } = manifest.runtime;
    if (canonicalReferenceJson(config.runtime) !== canonicalReferenceJson(runtimeConfiguration))
      throw new Error("Prepared effective runtime configuration mismatch");
    assertSetup();
    const image = JSON.parse((await commands.run("docker", ["image", "inspect", execution.image],
      { maxBuffer: 2_000_000, timeout: Math.min(10000, referenceRemainingMs(setupDeadline)), signal: stagedSignal })).stdout)[0];
    if (image?.Id !== execution.image) throw new Error("Actual container image identity mismatch");
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const available = /MemAvailable:\s+(\d+) kB/.exec(meminfo);
    if (!available || Number(available[1]) * 1024 < limits.max_rss_bytes + execution.resource_partition.host_headroom_bytes) throw new Error("Insufficient measured host RAM headroom");
    const partition = execution.resource_partition;
    assertSetup();
    const loadDeadline = performance.now() + limits.load_wall_ms!;
    const common = ["run", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000",
      "--ipc=private", "--device", execution.gpu_cdi_device, "--tmpfs", "/tmp:rw,nosuid,nodev,size=536870912,mode=1777",
      "--env", "HOME=/tmp/home", "--env", "PYTHONPATH=/runner", "--env", "PYTHONDONTWRITEBYTECODE=1",
      "--env", "PYTHONPYCACHEPREFIX=/tmp/pycache",
      "--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1", "--env", "TOKENIZERS_PARALLELISM=false"];
    const suffix = [execution.image, "python", "-m", "gameharness_policy.reference_runner", "--role"];
    const tag = `gh-reference-${reservation.reservationId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48)}`;
    const policyPaths = [...["steve1", "mineclip", "minerl"].map(name => `sources/${name}`), execution.tokenizer_directory,
      execution.dependency_inventory_path, ...["architecture", "policy", "prior", "mineclip"].map(id => execution.artifact_paths[id]!)];
    const policyMounts = policyPaths.flatMap(path => ["--mount", `type=bind,src=${resolve(options.preparedRoot, path)},dst=/reference/${path},readonly`]);
    const policyRunnerFiles = ["manifest.py", "reference_runner.py", "artifacts.py", "steve_policy.py"];
    const policyRunnerMounts = policyRunnerFiles.flatMap(name => ["--mount", `type=bind,src=${resolve(options.runnerRoot, "gameharness_policy", name)},dst=/runner/gameharness_policy/${name},readonly`]);
    assertSetup();
    const policy = new ReferenceProcess(`${tag}-policy`, [...common, "--name", `${tag}-policy`, "--memory", String(partition.policy_memory_bytes),
      "--memory-swap", String(partition.policy_memory_bytes), "--pids-limit", String(partition.policy_tasks), "--cpus", String(partition.policy_cpus),
      ...policyMounts, ...policyRunnerMounts, ...suffix, "policy"], log, fail);
    processes.push(policy);
    const scratch = join(options.outputRoot, "environment-scratch"), media = join(options.outputRoot, "media");
    await mkdir(scratch, { mode: 0o777 }); await mkdir(media, { mode: 0o777 });
    assertSetup();
    const environment = new ReferenceProcess(`${tag}-environment`, [...common, "--name", `${tag}-environment`, "--memory", String(partition.environment_memory_bytes),
      "--memory-swap", String(partition.environment_memory_bytes), "--pids-limit", String(partition.environment_tasks), "--cpus", String(partition.environment_cpus),
      "--mount", `type=bind,src=${resolve(options.runnerRoot)},dst=/runner,readonly`,
      "--mount", `type=bind,src=${resolve(options.preparedRoot)},dst=/reference,readonly`,
      "--mount", `type=bind,src=${resolve(options.fixturesRoot)},dst=/fixtures,readonly`, "--mount", `type=bind,src=${scratch},dst=/scratch`,
      "--mount", `type=bind,src=${media},dst=/evidence`, ...suffix, "environment"], log, fail);
    processes.push(environment);
    let isolationEvidence: Record<string, unknown>[] = [];
    while (performance.now() < loadDeadline) {
      assertSetup();
      try {
        const inspections = await Promise.allSettled(processes.map(async child => JSON.parse((await commands.run("docker", ["inspect", child.name], { timeout: 5000, maxBuffer: 2_000_000, signal: stagedSignal })).stdout)[0]));
        const rejected = inspections.find(entry => entry.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        isolationEvidence = inspections.map(entry => (entry as PromiseFulfilledResult<Record<string, unknown>>).value);
        if (isolationEvidence.every(value => wireObject.parse(value.State).Running === true)) break;
      } catch (error) {
        if (processes.some(child => child.child.exitCode !== null)) throw error;
      }
      await delay(100);
    }
    if (isolationEvidence.length !== processes.length || isolationEvidence.some(value => wireObject.parse(value.State).Running !== true))
      throw new Error("Owned container startup deadline");
    const containerMemory = async (inspected: Record<string, unknown>): Promise<number> => {
      const pid = wireObject.parse(inspected.State).Pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Unknown owned container init PID");
      const group = /^0::(\/[^\n]*)$/m.exec(await readFile(`/proc/${pid}/cgroup`, "utf8"));
      if (!group || group[1]!.split("/").includes("..")) throw new Error("Unknown owned container cgroup");
      const value = Number((await readFile(resolve("/sys/fs/cgroup", `.${group[1]}`, "memory.current"), "utf8")).trim());
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Unknown raw container memory.current");
      return value;
    };
    const sampleNow = async (): Promise<void> => {
        if (performance.now() - started >= limits.total_wall_ms || (record.setup !== "passed" && performance.now() - started >= limits.setup_wall_ms)) throw new Error("Reference total/setup wall allocation exhausted");
        const operations = [
          commands.run("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...processes.map(child => child.name)], { timeout: 8000, maxBuffer: 1_000_000 }),
          commands.run("nvidia-smi", ["--id", execution.gpu_uuid, "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 8000, maxBuffer: 100_000 }),
          readReferenceSupervision(supervisionRoot), directoryBytes(options.outputRoot), directoryBytes(media),
          Promise.all(processes.map(child => commands.run("docker", ["top", child.name, "-eo", "pid"], { timeout: 8000, maxBuffer: 100_000 }))),
          Promise.all(isolationEvidence.map(containerMemory)),
        ] as const;
        resourceMonitor.operations = Promise.allSettled(operations).then(() => {});
        const [stats, gpu, supervision, disk, mediaBytes, processLists, rawMemory] = await Promise.all(operations).catch(error => {
          fail(error instanceof Error ? error : new Error(String(error)));
          commands.stop();
          throw error;
        });
        const rows = stats.stdout.trim().split("\n").map(line => JSON.parse(line));
        if (rows.length !== processes.length) throw new Error("Unknown owned container resources");
        const rss = supervision.rss_bytes + rawMemory.reduce((total, bytes) => total + bytes, 0);
        const device = gpu.stdout.trim().split(",").map(value => Number(value.trim()) * 1048576);
        if (device.length !== 2 || device.some(value => !Number.isFinite(value)) || device[1] !== execution.gpu_total_bytes) throw new Error("Unknown selected-device memory measurement");
        record.actual.peak_rss_bytes = Math.max(Number(record.actual.peak_rss_bytes ?? 0), rss);
        record.actual.peak_gpu_bytes = Math.max(Number(record.actual.peak_gpu_bytes ?? 0), device[0]!);
        const ownedProcesses = supervision.processes + processLists.reduce((sum, value) => sum + Math.max(0, value.stdout.trim().split("\n").length - 1), 0);
        const tasks = supervision.tasks + rows.reduce((sum, row) => sum + Number(row.PIDs), 0);
        if (!Number.isSafeInteger(tasks) || tasks < 1) throw new Error("Unknown owned reference task count");
        record.actual.peak_processes = Math.max(Number(record.actual.peak_processes ?? 0), ownedProcesses);
        record.actual.peak_cgroup_tasks = Math.max(Number(record.actual.peak_cgroup_tasks ?? 0), tasks);
        record.actual.peak_disk_bytes = Math.max(Number(record.actual.peak_disk_bytes ?? 0), disk);
        record.actual.peak_recording_bytes = Math.max(Number(record.actual.peak_recording_bytes ?? 0), mediaBytes + journalBytes);
        if (rss > limits.max_rss_bytes || device[0]! > limits.max_gpu_bytes || ownedProcesses > limits.max_processes
          || tasks > (limits.cgroup_tasks ?? 0) || disk > limits.max_disk_bytes || mediaBytes + journalBytes > limits.max_recording_bytes)
          throw new Error("Reference RAM/GPU/process/task/disk/recording allocation exhausted");
        latestResources = { rss_bytes: rss, gpu_bytes: device[0]!, processes: ownedProcesses,
          disk_bytes: disk, recording_bytes: mediaBytes + journalBytes, download_bytes: 0 };
        log({ kind: "resource_sample", rss_upper_bound_bytes: rss, gpu_device_upper_bound_bytes: device[0], owned_gpu_bytes: null, owned_processes: ownedProcesses, tasks, disk_bytes: disk, recording_bytes: mediaBytes });
    };
    const sample = (): Promise<void> => {
      if (resourceMonitor.pending) return resourceMonitor.pending;
      if (latestResources && performance.now() - resourceMonitor.lastCompletedMs < 1000) return Promise.resolve();
      resourceMonitor.pending = sampleNow().then(() => { resourceMonitor.lastCompletedMs = performance.now(); })
        .finally(() => { resourceMonitor.pending = null; });
      return resourceMonitor.pending;
    };
    await sample();
    monitor = setInterval(() => { void sample().catch(error => fail(error instanceof Error ? error : new Error(String(error)))); }, 1000);
    for (const inspected of isolationEvidence) {
      const host = wireObject.parse(inspected.HostConfig), config = wireObject.parse(inspected.Config);
      if (host.NetworkMode !== "none" || !host.ReadonlyRootfs || config.User !== "1000:1000"
        || !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes("no-new-privileges") || host.Privileged) throw new Error("Actual Docker isolation mismatch");
      const policyRole = inspected.Name === `/${policy.name}`;
      const expectedMemory = policyRole ? partition.policy_memory_bytes : partition.environment_memory_bytes;
      const expectedTasks = policyRole ? partition.policy_tasks : partition.environment_tasks;
      const expectedCpu = policyRole ? partition.policy_cpus : partition.environment_cpus;
      if (host.Memory !== expectedMemory || host.MemorySwap !== expectedMemory || host.PidsLimit !== expectedTasks || host.NanoCpus !== expectedCpu * 1e9)
        throw new Error("Actual owned container resource partition mismatch");
      const mounts = z.array(z.object({ Destination: z.string(), RW: z.boolean() }).passthrough()).parse(inspected.Mounts);
      const allowed = policyRole ? [...policyRunnerFiles.map(name => `/runner/gameharness_policy/${name}`), ...policyPaths.map(path => `/reference/${path}`)]
        : ["/reference", "/runner", "/fixtures", "/scratch", "/evidence"];
      if (mounts.some(mount => !allowed.includes(mount.Destination) || (!["/scratch", "/evidence"].includes(mount.Destination) && mount.RW)))
        throw new Error("Actual reference mount authority mismatch");
    }
    log({ kind: "container_isolation", inspected: isolationEvidence });
    const requiredArtifact = (id: string) => {
      const artifact = manifest.artifacts.find(value => value.id === id)!;
      return { id, path: execution.artifact_paths[id]!, sha256: artifact.sha256, bytes: artifact.bytes };
    };
    record.actual.inferences = 4; record.actual.text_encoder_calls = null; record.actual.prior_calls = null;
    record.actual.inference_count_scope = "logical_compute_admissions_not_proof_of_completed_execution";
    if ((limits.setup_inferences ?? 0) < 4 || limits.max_inferences < 5) throw new Error("Goal preparation allocation is insufficient");
    log({ kind: "setup_compute_admitted", text_encoder_calls: 2, prior_calls: 2 });
    await writes; await syncJournal();
    const setupRequest = (child: ReferenceProcess, kind: string, payload: Wire, requestLimit: number): Promise<Wire> => {
      assertSetup();
      const remaining = Math.min(referenceRemainingMs(loadDeadline), referenceRemainingMs(setupDeadline));
      return child.request(kind, payload, Math.min(remaining, requestLimit));
    };
    const loaded = await setupRequest(policy, "initialize", { spec: { artifacts: ["architecture", "policy", "prior", "mineclip"].map(requiredArtifact),
      runtime: { python: manifest.runtime.python, torch: manifest.runtime.torch, cuda: manifest.runtime.cuda, gym: manifest.runtime.gym },
      goal: manifest.goal, goals: manifest.behaviors.map(value => ({ id: value.id, text: value.text })),
      tokenizer_directory: execution.tokenizer_directory, dependency_inventory_path: execution.dependency_inventory_path, gpu_uuid: execution.gpu_uuid } }, limits.load_wall_ms!);
    const loadEvidence = wireObject.parse(loaded.evidence);
    if (loadEvidence.text_encoder_calls !== 2 || loadEvidence.prior_calls !== 2 || loadEvidence.checkpoint_key_compatibility !== "strict")
      throw new Error("Unknown model setup execution/key compatibility");
    record.actual.text_encoder_calls = 2; record.actual.prior_calls = 2;
    record.actual.torch_peak_allocated_bytes = loadEvidence.torch_peak_allocated_bytes;
    record.actual.torch_peak_reserved_bytes = loadEvidence.torch_peak_reserved_bytes;
    const gameReady = await setupRequest(environment, "initialize", { spec: { engine: requiredArtifact("engine"), preprocessing: manifest.preprocessing,
      seed: manifest.simulator.reset_seed, fixtures: fixtureFiles, recording_bytes: limits.max_recording_bytes, shutdown_ms: limits.shutdown_wall_ms,
      renderer: execution.renderer, java_heap_bytes: partition.java_heap_bytes, limits } }, limits.load_wall_ms!);
    log({ kind: "loaded", policy: loaded.evidence, environment: gameReady.evidence });
    const resetPolicy = async (id: string) => policy.request("reset", { goal_id: id }, limits.inference_wall_ms);
    const infer = async (id: string, observation: Wire, phaseDeadline: number): Promise<Wire> => {
      if (fault.error) throw fault.error;
      if (!latestResources) throw new Error("Unknown reference resources before inference admission");
      if (Number(record.actual.inferences) >= limits.max_inferences || Number(record.actual.steps) >= limits.max_steps) throw new Error("Reference inference/step allocation exhausted");
      const ticket = record.setup === "passed"
        ? (await environment.request("reserve_inference", { resources: latestResources }, limits.inference_wall_ms)).ticket : null;
      if (record.setup === "passed" && typeof ticket !== "string") throw new Error("Environment inference reservation is unknown");
      record.actual.inferences = Number(record.actual.inferences) + 1;
      record.actual.policy_calls = Number(record.actual.policy_calls) + 1;
      log({ kind: "policy_compute_admitted", goal: id, ordinal: record.actual.policy_calls });
      await writes; await syncJournal();
      if (fault.error) throw fault.error;
      const timeoutMs = Math.min(limits.inference_wall_ms, phaseDeadline - performance.now());
      if (timeoutMs <= 0) throw new Error("Inference admission horizon deadline");
      const output = await policy.request("action", { pov: observation.pov, goal_id: id }, timeoutMs);
      record.actual.completed_policy_calls = Number(record.actual.completed_policy_calls ?? 0) + 1;
      if (fault.error || options.signal?.aborted) throw fault.error ?? new Error("Interrupted before action dispatch");
      for (const key of ["torch_peak_allocated_bytes", "torch_peak_reserved_bytes"] as const) {
        const measured = output[key];
        if (typeof measured !== "number" || !Number.isSafeInteger(measured) || measured < 0) throw new Error("Unknown model allocator high-water measurement");
        record.actual[key] = Math.max(Number(record.actual[key] ?? 0), measured);
        if (measured > limits.max_gpu_bytes) throw new Error("Model allocator GPU allocation exhausted");
      }
      log({ kind: "policy_action", goal: id, action: output.action, torch_peak_allocated_bytes: output.torch_peak_allocated_bytes,
        torch_peak_reserved_bytes: output.torch_peak_reserved_bytes });
      record.actual.step_dispatch_admissions = Number(record.actual.step_dispatch_admissions ?? 0) + 1;
      await writes; await syncJournal();
      if (fault.error || options.signal?.aborted) throw fault.error ?? new Error("Interrupted before action dispatch");
      const stepTime = Math.min(limits.inference_wall_ms, phaseDeadline - performance.now());
      if (stepTime <= 0) throw new Error("Action output arrived beyond the control horizon deadline");
      const payload = ticket === null ? { action: output.action } : { action: output.action, ticket, resources: latestResources };
      const next = await environment.request("step", payload, stepTime);
      record.actual.steps = Number(record.actual.steps) + 1;
      return next;
    };
    await resetPolicy("dirt");
    let observation = await setupRequest(environment, "reset", { case_id: "calibration", fixture_id: "dirt" }, limits.load_wall_ms!);
    log({ kind: "synthetic_camera_calibration_admitted", steps: 2, action_degrees: [2, 4] });
    record.actual.synthetic_control_step_admissions = 2;
    await writes; await syncJournal();
    const probe = await setupRequest(environment, "control_probe", {}, limits.inference_wall_ms);
    if (probe.steps !== 2 || probe.control_verified !== true) throw new Error("Native camera calibration remains unverified");
    record.actual.steps = Number(record.actual.steps) + 2;
    observation = probe;
    log({ kind: "synthetic_camera_calibration", evidence: probe.control_evidence });
    await sample();
    observation = await infer("dirt", observation, loadDeadline);
    log({ kind: "load_legal_action_calibration", observation: { ...observation, pov: undefined } });
    await environment.request("finish_case", {}, limits.shutdown_wall_ms);
    if (performance.now() >= loadDeadline) throw new Error("Combined reference load/legal-action deadline");
    await sample();
    const actualRuntime = { ...manifest.runtime, ...wireObject.parse(wireObject.parse(loaded.evidence).runtime) };
    admitReference(manifest, { manifest_hash: identity, artifacts: files, sources: config.sources, runtime: actualRuntime, device: config.device,
      simulator: config.simulator, preprocessing: config.preprocessing, action_mapping: config.action_mapping, isolation: { ...manifest.isolation, confirmed: true },
      runtime_probe: { id: manifest.device.runtime_compatibility_evidence, passed: true, model_kernels_exercised: true } });
    await environment.request("finish_setup", { resources: latestResources }, limits.inference_wall_ms);
    assertSetup();
    clearTimeout(setupTimer);
    record.setup = "passed";
    for (const behavior of manifest.behaviors) {
      if (fault.error) throw fault.error;
      const result = record.behaviors.find(value => value.id === behavior.id)!;
      result.attempted = true;
      const caseStart = performance.now();
      const caseDeadline = caseStart + limits.behavior_wall_ms;
      await resetPolicy(behavior.id);
      await sample();
      await environment.request("start_behavior", { case_id: behavior.id, resources: latestResources }, limits.inference_wall_ms);
      observation = await environment.request("reset", { case_id: behavior.id, fixture_id: behavior.id }, Math.min(limits.load_wall_ms!, limits.behavior_wall_ms));
      const steps = limits.steps_per_behavior;
      if (!steps) throw new Error("Per-behavior finite step count is required");
      result.termination = "step_limit";
      for (let index = 0; index < steps; index++) {
        await sample();
        if (performance.now() >= caseDeadline) { result.termination = "behavior_wall_limit"; break; }
        observation = await infer(behavior.id, observation, caseDeadline);
        const verification = wireObject.parse(observation.verification);
        if (verification.verified === true || observation.done === true) {
          result.termination = verification.verified === true ? "verified" : "environment_done";
          break;
        }
      }
      const finished = await environment.request("finish_case", { resources: latestResources }, limits.shutdown_wall_ms);
      const verification = wireObject.parse(finished.verification);
      if (typeof verification.verified !== "boolean") throw new Error("Reference verifier is unknown");
      result.verifier = verification.verified;
      log({ kind: "behavior_finished", id: behavior.id, ...finished });
    }
    if (fault.error) throw fault.error;
    record.terminal = "completed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(error instanceof Error ? error : new Error(message));
    try { log({ kind: "failure", message }); } catch { /* Original failure remains in the result. */ }
  } finally {
    clearInterval(monitor);
    clearTimeout(setupTimer);
    if (fault.error || options.signal?.aborted) commands.stop();
    else commands.closeAdmissions();
    const deadline = performance.now() + limits.shutdown_wall_ms;
    const cleanupDeadline = () => Math.min(deadline, signalCleanupDeadline);
    const cleanupStarted = performance.now();
    const gracefulDeadline = Math.min(cleanupDeadline(), cleanupStarted + Math.min(1000, Math.max(1, (cleanupDeadline() - cleanupStarted) / 6)));
    const shutdownEvidence: string[] = [];
    let drained = true;
    try {
      if (resourceMonitor.pending) await beforeDeadline(resourceMonitor.pending, Math.min(gracefulDeadline, performance.now() + 250),
        "Resource sampler graceful settlement deadline");
    } catch (error) { retain(error instanceof Error ? error : new Error(String(error))); }
    commands.stop();
    for (const child of processes.reverse()) {
      try {
        if (!fault.error) await child.request("close", {}, referenceRemainingMs(Math.min(gracefulDeadline, performance.now() + 500)));
      } catch (error) { retain(new Error(`Reference close failed: ${error}`)); }
      child.fence("Reference shutdown fences late output");
    }
    // Admit BOTH daemon removals before awaiting either. Graceful close/sampling
    // cannot spend their force-removal allocation, and transport/helper joins
    // retain a final reserve within the same total (or shorter SDK signal) cap.
    const forceStarted = performance.now();
    const forceDeadline = Math.min(cleanupDeadline(), forceStarted + Math.max(1, (cleanupDeadline() - forceStarted) * 0.65));
    const removals = processes.map(async child => {
      try {
        await commands.run("docker", ["rm", "--force", child.name], {
          timeout: referenceRemainingMs(Math.min(forceDeadline, cleanupDeadline())), maxBuffer: 1_000_000 }, true);
        await beforeDeadline(child.closed, Math.min(forceDeadline, cleanupDeadline()), "Process drain deadline");
        shutdownEvidence.push(`${child.name}:docker-remove-and-transport-close`);
      } catch (error) {
        drained = false; retain(new Error(`Unconfirmed shutdown: ${error}`)); child.child.kill("SIGKILL");
      }
    });
    await Promise.allSettled(removals);
    if (!await commands.drain(cleanupDeadline())) {
      drained = false;
      retain(new Error("Reference helper ownership remains unconfirmed at shutdown deadline"));
    }
    try {
      if (resourceMonitor.operations) await beforeDeadline(resourceMonitor.operations, cleanupDeadline(), "Reference sampling operations drain deadline");
    } catch (error) {
      drained = false; retain(error instanceof Error ? error : new Error(String(error)));
    }
    record.cleanup = drained ? "confirmed" : "unconfirmed";
    record.actual.wall_ms = performance.now() - started;
    record.actual.wall_scope = "through owned worker/helper cleanup; final evidence and ledger persistence are additionally bounded by the caller study deadline";
    record.actual.unresolved_step_admissions = Math.max(0, Number(record.actual.step_dispatch_admissions ?? 0)
      + Number(record.actual.synthetic_control_step_admissions ?? 0) - Number(record.actual.steps));
    record.actual.step_count_scope = "acknowledged environment round trips; unresolved dispatch admissions retain unknown effects";
    let journalClosed = false;
    try {
      await writes;
      try { await syncJournal(); }
      catch (error) { journalFailed = true; retain(new Error(`Reference journal sync failed: ${error}`)); }
    } finally {
      try { await journal.close(); journalClosed = true; }
      catch (error) { drained = false; record.cleanup = "unconfirmed"; retain(new Error(`Reference journal close remains unconfirmed: ${error}`)); }
    }
    record.actual.journal_complete = !journalFailed;
    record.actual.journal_closed = journalClosed;
    const refreshCancellation = () => {
      if (options.signal?.aborted) abort();
      if (fault.error) retain(fault.error);
    };
    const report = join(options.outputRoot, "reference-result.json");
    let reportComplete = false;
    try {
      refreshCancellation();
      let serialized = JSON.stringify(classifyReferenceResult(record), null, 2);
      try { await writeFile(report, serialized, { flag: "wx", mode: 0o600 }); reportComplete = true; }
      catch (error) { retain(new Error(`Reference report persistence failed: ${error}`)); }
      refreshCancellation();
      const current = JSON.stringify(classifyReferenceResult(record), null, 2);
      if (reportComplete && current !== serialized) {
        try { await writeFile(report, current, { flag: "w", mode: 0o600 }); serialized = current; }
        catch (error) { reportComplete = false; retain(new Error(`Reference final report persistence failed: ${error}`)); }
      }
      refreshCancellation();
      const result = classifyReferenceResult(record);
      if (reportComplete && JSON.stringify(result, null, 2) !== serialized) {
        // A signal landed during the rewrite itself. Do not present those stale
        // bytes as the terminal report; the durable settlement below owns truth.
        reportComplete = false;
        retain(new Error("Reference report became stale during final cancellation; durable settlement retains the terminal outcome"));
      }
      const evidence = [...(reportComplete ? [report] : []), journalPath];
      if (interrupted) await options.governance.interrupt(String(options.signal?.reason ?? "Reference interrupted"));
      else await options.governance.settle(classifyReferenceResult(record), evidence);
      if (drained && journalClosed) await options.governance.confirmDrain([...evidence, ...shutdownEvidence]);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      setupScope.signal.removeEventListener("abort", setupExpired);
    }
  }
  return classifyReferenceResult(record);
}
