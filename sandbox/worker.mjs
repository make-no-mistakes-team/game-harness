import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import { createConnection } from "node:net";
import { types } from "node:util";
import * as vm from "node:vm";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

// Docker is the security boundary. The inner Worker keeps normal protocol
// handling responsive, but is NOT isolated from this process's main thread
// (including through inspector.connectToMainThread). The independent host
// guardian owns authoritative deadlines, backend EOF, and Docker removal.
const parse = JSON.parse;
const stringify = JSON.stringify;
const byteLength = Buffer.byteLength.bind(Buffer);
const MAX_INPUT = 256 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_SKILL_INPUT = MAX_INPUT + 512 * 1024;
const MAX_SKILL_OUTPUT = MAX_OUTPUT + 20 * 1024;
const MAX_STATE = 16 * 1024;
const MAX_DEPTH = 32;
const SOURCE_DIAGNOSTIC_TYPES = ["Error", "TypeError", "RangeError", "ReferenceError",
  "SyntaxError", "URIError", "EvalError", "AggregateError", "ThrownValue"];

function validSourceDiagnostic(value, sourceHash) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    exactKeys(value, ["type", "message", "source_hash", "location"]) &&
    SOURCE_DIAGNOSTIC_TYPES.includes(value.type) &&
    typeof value.message === "string" && value.message.length <= 1000 &&
    typeof sourceHash === "string" && /^[a-f0-9]{64}$/.test(sourceHash) &&
    value.source_hash === sourceHash && value.location !== null &&
    typeof value.location === "object" && !Array.isArray(value.location) &&
    exactKeys(value.location, ["mapping"]) && value.location.mapping === "unmapped";
}

// Keep this wire-boundary verifier aligned with shared/program-modules.ts.
function validateModuleBundle(bundle, entry) {
  const fail = () => { throw new Error("module_bundle"); };
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const digest = text => createHash("sha256").update(text, "utf8").digest("hex");
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const validId = id => {
    if (id === "root") return true;
    if (typeof id !== "string" || !id.startsWith("module:") || id.length > 512) return false;
    try {
      const ref = JSON.parse(id.slice(7));
      return Array.isArray(ref) && ref.length === 2 && typeof ref[0] === "string" && ref[0].length > 0 &&
        ref[0].length <= 80 && ref[0].trim().length > 0 && Number.isSafeInteger(ref[1]) && ref[1] > 0 &&
        id === "module:" + JSON.stringify(ref);
    } catch { return false; }
  };
  if (!exact(bundle, ["schema_version", "entry", "root", "source_hash", "modules"]) || bundle.schema_version !== 1 ||
    !["step", "analyze"].includes(bundle.entry) || bundle.entry !== entry || bundle.root !== "root" ||
    typeof bundle.source_hash !== "string" || !/^[a-f0-9]{64}$/.test(bundle.source_hash) ||
    !Array.isArray(bundle.modules) || bundle.modules.length < 1 || bundle.modules.length > 32 ||
    Buffer.byteLength(JSON.stringify(bundle)) > 262144) fail();
  const rows = new Map();
  let bytes = 0;
  for (const row of bundle.modules) {
    if (!exact(row, ["id", "source", "source_hash", "imports"]) || !validId(row.id) || rows.has(row.id) ||
      typeof row.source !== "string" || Buffer.byteLength(row.source) > 16384 || row.source_hash !== digest(row.source) ||
      !Array.isArray(row.imports) || row.imports.length > 32) fail();
    bytes += Buffer.byteLength(row.source);
    if (bytes > 65536) fail();
    const aliases = new Set();
    for (const binding of row.imports) {
      if (!exact(binding, ["specifier", "module_id"]) || typeof binding.specifier !== "string" ||
        binding.specifier.length > 512 || !/^\.\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|mjs)$/.test(binding.specifier) ||
        aliases.has(binding.specifier) || !validId(binding.module_id) || binding.module_id === "root") fail();
      aliases.add(binding.specifier);
    }
    rows.set(row.id, row);
  }
  const active = new Set(), heights = new Map();
  function visit(id) {
    if (heights.has(id)) return heights.get(id);
    const row = rows.get(id);
    if (!row || active.has(id)) fail();
    active.add(id);
    let height = 1;
    for (const binding of row.imports) height = Math.max(height, visit(binding.module_id) + 1);
    active.delete(id);
    if (height > 8) fail();
    heights.set(id, height);
    return height;
  }
  visit("root");
  const modules = [...bundle.modules].sort((a, b) => compare(a.id, b.id)).map(row => ({ id: row.id,
    source: row.source, source_hash: row.source_hash, imports: [...row.imports].sort((a, b) => compare(a.specifier, b.specifier))
      .map(binding => ({ specifier: binding.specifier, module_id: binding.module_id })) }));
  const hash = modules.length === 1 && modules[0].id === "root" && modules[0].imports.length === 0
    ? digest(modules[0].source) : digest(JSON.stringify({ schema_version: 1, entry, root: "root", modules }));
  if (heights.size !== rows.size || bundle.source_hash !== hash) fail();
  return rows;
}

function depthIsBounded(value, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (value && typeof value === "object") {
    for (const entry of Object.values(value))
      if (!depthIsBounded(entry, depth + 1)) return false;
  }
  return true;
}

function finiteJson(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(finiteJson);
}

async function probe() {
  if (process.getuid() !== 65534 || process.getgid() !== 65534)
    throw new Error("identity");
  if (Object.keys(networkInterfaces()).some((name) => name !== "lo"))
    throw new Error("network");
  const environment = {
    PATH: true,
    NODE_VERSION: true,
    YARN_VERSION: true,
    NODE_ENV: true,
    HOME: true,
    LANG: true,
    HOSTNAME: true,
  };
  if (
    Object.keys(process.env).some((name) => !Object.hasOwn(environment, name))
  )
    throw new Error("environment");
  const mounts = readFileSync("/proc/mounts", "utf8")
    .split("\n")
    .map((line) => line.split(" "));
  if (
    !mounts.some(
      (parts) => parts[1] === "/" && parts[3].split(",").includes("ro"),
    )
  )
    throw new Error("root");
  if (
    !mounts.some(
      (parts) =>
        parts[1] === "/runner.mjs" && parts[3].split(",").includes("ro"),
    )
  )
    throw new Error("runner");
  try {
    writeFileSync("/sandbox-write-proof", "no");
    throw new Error("writable");
  } catch (error) {
    if (error.code !== "EROFS" && error.code !== "EACCES") throw error;
  }
  const status = readFileSync("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^CapEff:\s+0+$/m.test(status))
    throw new Error("privileges");
  const { promise, resolve, reject } = Promise.withResolvers();
  const socket = createConnection({ host: "198.51.100.1", port: 443 });
  socket.setTimeout(300, () => {
    socket.destroy();
    reject(new Error("network_timeout"));
  });
  socket.once("connect", () => {
    socket.destroy();
    reject(new Error("network_access"));
  });
  socket.once("error", (error) => {
    socket.destroy();
    error.code === "ENETUNREACH"
      ? resolve()
      : reject(new Error("network_profile"));
  });
  await promise;
  return {
    type: "proof",
    uid: 65534,
    network: "none",
    root: "read_only",
    environment: "explicit",
  };
}

function runPolicyThread() {
  const post = parentPort.postMessage.bind(parentPort);
  const exit = process.exit.bind(process);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const guard = workerData.binding === "guard";
  const evaluate = new AsyncFunction(
    guard ? "observation" : "context",
    guard ? "args" : "state",
    '"use strict";\n' + workerData.source,
  );
  let busy = false;
  parentPort.on("message", (message) => {
    if (busy) return exit(1);
    busy = true;
    Promise.resolve()
      .then(async () => {
        const state = message.state;
        const decision = guard
          ? await evaluate(message.context.observation, message.context.args)
          : await evaluate(message.context, state);
        // Serialization also runs off the supervisor thread: getters/toJSON can loop.
        const encodedState = stringify(state);
        if (encodedState === undefined || byteLength(encodedState) > MAX_STATE)
          throw new Error("state_limit");
        const cleanState = parse(encodedState);
        if (
          !cleanState ||
          Array.isArray(cleanState) ||
          typeof cleanState !== "object" ||
          !depthIsBounded(cleanState)
        )
          throw new Error("state");
        const encoded = stringify({
          type: "decision",
          decision,
          state: cleanState,
        });
        if (
          byteLength(encoded) + 1 > MAX_OUTPUT ||
          !depthIsBounded(parse(encoded))
        )
          throw new Error("output_limit");
        post(encoded);
        busy = false;
      })
      .catch(() => exit(1));
  });
  post('{"type":"compiled"}');
}

// This factory is evaluated as source inside the module's own realm. Never
// inject this outer-realm function (or its returned objects) into authored code.
function createMotionMath() {
  const pi = Math.PI, tau = 2 * pi, halfPi = pi / 2;
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const tick = value => Number.isSafeInteger(value) && value >= 0;
  const wrap = value => value >= -pi && value < pi ? value : ((value + pi) % tau + tau) % tau - pi;
  const clamp = (value, bound) => Math.max(-bound, Math.min(bound, value));
  const orientation = value => value && finite(value.yaw_radians) && finite(value.pitch_radians);
  const canonical = value => orientation(value) && value.yaw_radians >= -pi &&
    value.yaw_radians < pi && Math.abs(value.pitch_radians) <= halfPi;
  function turn(options, state = null) {
    if (!options || !tick(options.native_tick) || !orientation(options.pose) ||
      Math.abs(options.pose.pitch_radians) > halfPi || !orientation(options.target) ||
      !Number.isSafeInteger(options.duration_ticks) || options.duration_ticks < 1 ||
      !finite(options.max_rate) || options.max_rate <= 0 || options.max_rate > 20 * pi ||
      (options.tolerance !== undefined &&
        (!finite(options.tolerance) || options.tolerance < 0 || options.tolerance > pi)))
      throw new RangeError("motion.turn requires actual native_tick/pose, a finite target, positive duration_ticks and max_rate <= 20*pi");
    if (state !== null && (!state || !tick(state.start_tick) || !tick(state.last_tick) ||
      state.last_tick < state.start_tick || !canonical(state.origin) || !canonical(state.target) ||
      !Number.isSafeInteger(state.duration_ticks) || state.duration_ticks < 1))
      throw new RangeError("motion.turn state must be null or a previous explicit turn state");
    const yaw = wrap(options.target.yaw_radians);
    const pitch = clamp(options.target.pitch_radians, halfPi);
    if (state === null || options.native_tick < state.last_tick ||
      state.target.yaw_radians !== yaw || state.target.pitch_radians !== pitch ||
      state.duration_ticks !== options.duration_ticks) {
      state = {
        start_tick: options.native_tick, last_tick: options.native_tick,
        origin: { yaw_radians: wrap(options.pose.yaw_radians), pitch_radians: options.pose.pitch_radians },
        target: { yaw_radians: yaw, pitch_radians: pitch }, duration_ticks: options.duration_ticks,
      };
    } else if (state.last_tick !== options.native_tick) {
      state = { ...state, last_tick: options.native_tick };
    }
    const errorYaw = wrap(yaw - options.pose.yaw_radians);
    const errorPitch = pitch - options.pose.pitch_radians;
    const tolerance = options.tolerance ?? 0.01;
    const finished = options.native_tick - state.start_tick >= state.duration_ticks;
    let yawRate = 0, pitchRate = 0;
    if (!finished) {
      // Cubic reference has zero endpoint velocity. Feedback closes only the
      // next actual 50ms tick's error; a submitted rate is never assumed applied.
      const t = Math.min(1, (options.native_tick - state.start_tick + 1) / state.duration_ticks);
      const progress = t * t * (3 - 2 * t);
      const desiredYaw = state.origin.yaw_radians + wrap(yaw - state.origin.yaw_radians) * progress;
      const desiredPitch = state.origin.pitch_radians + (pitch - state.origin.pitch_radians) * progress;
      yawRate = clamp(wrap(desiredYaw - options.pose.yaw_radians) / 0.05, options.max_rate);
      pitchRate = clamp((desiredPitch - options.pose.pitch_radians) / 0.05, options.max_rate);
    }
    return {
      view: { kind: "rate", yaw_radians_per_second: yawRate, pitch_radians_per_second: pitchRate },
      state, finished, aligned: Math.abs(errorYaw) <= tolerance && Math.abs(errorPitch) <= tolerance,
      error: { yaw_radians: errorYaw, pitch_radians: errorPitch },
    };
  }
  function track(options, state = null) {
    if (!options || !tick(options.native_tick) || !orientation(options.pose) ||
      Math.abs(options.pose.pitch_radians) > halfPi || !orientation(options.target) ||
      !finite(options.max_rate) || options.max_rate <= 0 || options.max_rate > 20 * pi ||
      !finite(options.max_acceleration) || options.max_acceleration <= 0 ||
      !Number.isSafeInteger(options.response_ticks) || options.response_ticks < 1 ||
      (options.tolerance !== undefined &&
        (!finite(options.tolerance) || options.tolerance < 0 || options.tolerance > pi)))
      throw new RangeError("motion.track requires actual native_tick/pose, a finite target, positive response_ticks, max_acceleration and max_rate <= 20*pi");
    if (state !== null && (!state || !tick(state.last_tick) || !state.velocity ||
      !finite(state.velocity.yaw_radians_per_second) || !finite(state.velocity.pitch_radians_per_second) ||
      Math.abs(state.velocity.yaw_radians_per_second) > options.max_rate ||
      Math.abs(state.velocity.pitch_radians_per_second) > options.max_rate))
      throw new RangeError("motion.track state must carry a valid native tick and finite velocities within max_rate");
    // Wrap each operand first: even finite raw yaw inputs can overflow on subtraction.
    const errorYaw = wrap(wrap(options.target.yaw_radians) - wrap(options.pose.yaw_radians));
    const errorPitch = clamp(options.target.pitch_radians, halfPi) - options.pose.pitch_radians;
    if (state === null || options.native_tick < state.last_tick) {
      // No elapsed measurement exists at initialization/reset. Do not invent a
      // tick, assume actual movement, or inherit velocity across a clock reset.
      state = { last_tick: options.native_tick,
        velocity: { yaw_radians_per_second: 0, pitch_radians_per_second: 0 } };
    } else if (options.native_tick !== state.last_tick) {
      const elapsed = (options.native_tick - state.last_tick) * 0.05;
      const response = options.response_ticks * 0.05;
      const change = options.max_acceleration * elapsed;
      const prior = state.velocity;
      const desiredYaw = clamp(errorYaw / response, options.max_rate);
      const desiredPitch = clamp(errorPitch / response, options.max_rate);
      // Convex movement toward already-bounded desired rates preserves both
      // speed and acceleration bounds, including reversals and moving targets.
      state = { last_tick: options.native_tick, velocity: {
        yaw_radians_per_second: clamp(prior.yaw_radians_per_second +
          clamp(desiredYaw - prior.yaw_radians_per_second, change), options.max_rate),
        pitch_radians_per_second: clamp(prior.pitch_radians_per_second +
          clamp(desiredPitch - prior.pitch_radians_per_second, change), options.max_rate),
      } };
    }
    // Same-tick calls reuse immutable state, never integrating a second time.
    // Tolerance reports actual-pose alignment only; it cannot bypass braking.
    const tolerance = options.tolerance ?? 0.01;
    return {
      view: { kind: "rate", yaw_radians_per_second: state.velocity.yaw_radians_per_second,
        pitch_radians_per_second: state.velocity.pitch_radians_per_second },
      state, aligned: Math.abs(errorYaw) <= tolerance && Math.abs(errorPitch) <= tolerance,
      error: { yaw_radians: errorYaw, pitch_radians: errorPitch },
    };
  }
  return Object.freeze({ turn: Object.freeze(turn), track: Object.freeze(track) });
}

// Resident computation and all inspection/serialization of its return value
// stay in the watched untrusted thread. Docker, not vm, is the isolation proof.
async function runResidentThread() {
  const post = parentPort.postMessage.bind(parentPort);
  const exit = process.exit.bind(process);
  const entry = workerData.entry;
  const rows = validateModuleBundle(workerData.bundle, entry);
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(`const motion = (${createMotionMath.toString()})();`, context);
  const realm = vm.runInContext("({ parse: JSON.parse, object: Object.prototype, array: Array.prototype, error: Error })", context);
  const errorPrototypes = Array.from(vm.runInContext(
    "[Error,TypeError,RangeError,ReferenceError,SyntaxError,URIError,EvalError,AggregateError].map(value => value.prototype)", context));
  const descriptor = Object.getOwnPropertyDescriptor;
  const nativeError = types.isNativeError;
  const getPrototype = Object.getPrototypeOf;
  const slice = Function.prototype.call.bind(String.prototype.slice);
  function sourceDiagnostic(error) {
    let type = "ThrownValue", message = "Generated program threw a non-error value (not serialized)";
    // isNativeError rejects proxies without touching their traps. Never inspect
    // arbitrary thrown values, constructors, stacks, accessors or coercion hooks.
    if (nativeError(error)) {
      const index = errorPrototypes.indexOf(getPrototype(error));
      type = index < 0 ? "Error" : SOURCE_DIAGNOSTIC_TYPES[index];
      const ownMessage = descriptor(error, "message");
      message = ownMessage && Object.hasOwn(ownMessage, "value") && typeof ownMessage.value === "string"
        ? slice(ownMessage.value, 0, 1000) : "Generated program failed";
    }
    return { type, message, source_hash: workerData.bundle.source_hash, location: { mapping: "unmapped" } };
  }
  const modules = new Map(), moduleIds = new Map();
  for (const row of rows.values()) {
    const compiled = new vm.SourceTextModule(row.source, {
      context, identifier: row.id,
      // Rejections are catchable authored values: never expose an outer-realm
      // Error (and its host Function constructor) to a module.
      initializeImportMeta() { throw new realm.error("import_meta_unsupported"); },
      importModuleDynamically() { throw new realm.error("dynamic_import_unsupported"); },
    });
    const requested = new Set(compiled.dependencySpecifiers);
    if (requested.size !== row.imports.length || row.imports.some(binding => !requested.has(binding.specifier)))
      throw new Error("import_closure");
    modules.set(row.id, compiled);
    moduleIds.set(compiled, row.id);
  }
  const module = modules.get("root");
  await module.link((specifier, referencingModule, attributes = {}) => {
    if (Object.keys(attributes.attributes ?? attributes.assert ?? {}).length !== 0)
      throw new Error("import_attributes_unsupported");
    const row = rows.get(moduleIds.get(referencingModule));
    const binding = row?.imports.find(binding => binding.specifier === specifier);
    if (!binding || !modules.has(binding.module_id)) throw new Error("undeclared_import");
    return modules.get(binding.module_id);
  });
  if (typeof module.hasTopLevelAwait === "function" && [...modules.values()].some(compiled => compiled.hasTopLevelAwait()))
    throw new Error("top_level_await_unsupported");
  await module.evaluate();
  const names = Object.getOwnPropertyNames(module.namespace);
  const selected = module.namespace[entry];
  const activation = entry === "step" && Object.hasOwn(module.namespace, "activate") ? module.namespace.activate : selected;
  if (!names.includes(entry) || names.some(name => name !== entry && !(entry === "step" && name === "activate")) ||
    typeof activation !== "function" || types.isAsyncFunction(activation) || types.isGeneratorFunction(activation) ||
    activation.length !== (entry === "step" ? 3 : 1) || typeof selected !== "function" ||
    types.isAsyncFunction(selected) || types.isGeneratorFunction(selected) ||
    selected.length !== (entry === "step" ? 3 : 1))
    throw new Error("selected_export");

  function cleanJson(value, depth = 0, active = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || depth + 1 > MAX_DEPTH || active.has(value))
      throw new Error("json");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? realm.array : realm.object) && !(prototype === null && !array))
      throw new Error("json_prototype");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const length = array ? descriptors.length?.value : keys.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_OUTPUT ||
      (array && keys.length !== length + 1))
      throw new Error("json_size");
    const clean = array ? [] : Object.create(null);
    active.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (typeof key !== "string" || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))
        throw new Error("json_descriptor");
      Object.defineProperty(clean, key, { value: cleanJson(descriptor.value, depth + 1, active),
        enumerable: true, writable: true, configurable: true });
    }
    active.delete(value);
    return clean;
  }
  let busy = false;
  let activated = false;
  parentPort.on("message", message => {
    if (busy) return exit(1);
    busy = true;
    try {
      // Parse into the module's realm rather than exposing outer-realm object
      // constructors through frame/state/input.
      const input = realm.parse(stringify(message));
      if (message.type === "resident_activate" && activated) throw new Error("activation_replayed");
      if (message.type === "resident_activate") activated = true;
      let returned;
      try {
        if (message.type === "resident_activate" && input.frame?.executive && !Object.hasOwn(module.namespace, "activate"))
          throw new Error("session_requires_activate");
        returned = entry === "step"
          ? (message.type === "resident_activate" ? activation : selected)(input.frame, input.state, input.intent)
          : selected(input.input);
      } catch (error) {
        const diagnostic = sourceDiagnostic(error);
        if (!validSourceDiagnostic(diagnostic, workerData.bundle.source_hash)) throw new Error("diagnostic");
        post(stringify({ v: 1, type: "resident_fault", id: message.id, origin: "source_throw", diagnostic }));
        return exit(1);
      }
      const value = cleanJson(returned);
      // Return plain bounded data even when its gameplay result shape is wrong.
      // The trusted decoder reports invalid fields; killing this thread would
      // misclassify a repairable authored return as an opaque runtime failure.
      const encoded = stringify({ v: 1, type: "resident_result", id: message.id, value });
      if (byteLength(encoded) + 1 > MAX_OUTPUT || !depthIsBounded(parse(encoded)))
        throw new Error("output_limit");
      post(encoded);
      busy = false;
    } catch { exit(1); }
  });
  post('{"v":1,"type":"resident_compiled","id":0}');
}

function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}

function runSkillThread() {
  const post = parentPort.postMessage.bind(parentPort);
  const exit = process.exit.bind(process);
  let sequence = 0;
  let pending = null;
  const traceScope = workerData.instrumentation.scope;
  const traceKinds = workerData.instrumentation.kinds;
  const descriptor = Object.getOwnPropertyDescriptor;
  const nativeError = types.isNativeError;
  const prototypes = [[TypeError.prototype, "TypeError"], [RangeError.prototype, "RangeError"], [ReferenceError.prototype, "ReferenceError"], [SyntaxError.prototype, "SyntaxError"], [Error.prototype, "Error"]];
  const getPrototype = Object.getPrototypeOf;
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const outputFailures = new WeakMap();
  const outputFailureGet = WeakMap.prototype.get.bind(outputFailures);
  const outputFailureSet = WeakMap.prototype.set.bind(outputFailures);
  function terminalOutputFailure(reason, actualBytes = null) {
    const error = new Error("Program terminal result serialization failed");
    outputFailureSet(error, { phase: "terminal_result", reason, maximum_bytes: MAX_OUTPUT,
      actual_bytes: actualBytes, completed_capability_calls: sequence });
    return error;
  }
  function boundedMessage(value) {
    let text = slice(value, 0, 1000);
    while (byteLength(text) > 1000) text = slice(text, 0, -1);
    return text;
  }
  function diagnostic(error) {
    const output = error && typeof error === "object" ? outputFailureGet(error) : null;
    if (output) return {
      type: "ProgramOutputError", code: "program_output_limit",
      message: `Terminal result rejected (${output.reason}); the complete JSON frame plus newline must fit ${MAX_OUTPUT} UTF-8 bytes and depth ${MAX_DEPTH}. Completed effects remain applied. Return compact task facts; inspect host-retained receipts instead of replaying effects.`,
      source_hash: workerData.source_hash, location: { mapping: "unmapped" }, output,
    };
    let type = "ThrownValue", message = "Generated program threw a non-error value (not serialized)", code;
    if (nativeError(error)) {
      const proto = getPrototype(error);
      type = prototypes.find(([value]) => value === proto)?.[1] ?? "Error";
      const ownMessage = descriptor(error, "message")?.value;
      message = typeof ownMessage === "string" ? boundedMessage(ownMessage) : "Generated program failed";
      const ownCode = descriptor(error, "code")?.value;
      if (typeof ownCode === "string") code = slice(ownCode, 0, 80);
    }
    return { type, message, ...(code ? { code } : {}), source_hash: workerData.source_hash, location: { mapping: "unmapped" } };
  }
  const setPrototype = Object.setPrototypeOf.bind(Object);
  let traceEvents = setPrototype([], null);
  let traceCount = 0;
  let traceBytes = 0;
  let traceOmitted = 0;
  const appendTrace = Function.prototype.call.bind(Array.prototype.push);
  function trace(point, value) {
    // Returning the exact value preserves &&/||/?? and does not inspect getters,
    // call coercion hooks, await promises, or otherwise evaluate an operand twice.
    if (traceCount < 256 && traceBytes < 16384) {
      const event = {
        __proto__: null,
        point_id: point,
        decision: traceKinds[point] === "logical_nullish"
          ? value !== null && value !== undefined
          : !!value,
      };
      // A fixed upper bound avoids calling user-installed toJSON/getters during
      // condition evaluation. Numeric point IDs and booleans fit in 48 bytes.
      const bytes = 48;
      if (traceBytes + bytes <= 16384) {
        appendTrace(traceEvents, event);
        traceCount++;
        traceBytes += bytes;
        return value;
      }
    }
    if (traceOmitted < 9007199254740991) traceOmitted++;
    return value;
  }
  function send(frame) {
    // Serialize the model payload exactly once, under its original limit.
    // Diagnostic overhead has a separate bounded transport allowance.
    let payload;
    try { payload = stringify(frame); }
    catch (error) {
      if (frame.type === "skill_result") throw terminalOutputFailure("json_serialization");
      throw error;
    }
    const payloadBytes = payload ? byteLength(payload) + 1 : null;
    if (!payload || payloadBytes > MAX_OUTPUT) {
      if (frame.type === "skill_result") throw terminalOutputFailure("utf8_bytes", payloadBytes);
      throw new Error("output_limit");
    }
    if (!depthIsBounded(parse(payload))) {
      if (frame.type === "skill_result") throw terminalOutputFailure("json_depth", payloadBytes);
      throw new Error("output_limit");
    }
    const diagnostic = stringify({
      __proto__: null, scope: traceScope, events: traceEvents, omitted: traceOmitted,
    });
    const encoded = payload.slice(0, -1) + ',"trace":' + diagnostic + "}";
    if (
      !encoded ||
      byteLength(encoded) + 1 > MAX_SKILL_OUTPUT ||
      !depthIsBounded(parse(encoded))
    )
      throw new Error("output_limit");
    post(encoded);
    traceEvents = setPrototype([], null);
    traceOmitted = 0;
  }
  function call(request) {
    if (pending)
      return Promise.reject(
        new Error("Concurrent capabilities are forbidden."),
      );
    const completion = Promise.withResolvers();
    const id = sequence + 1;
    pending = { id, ...completion };
    try {
      send({ v: 1, type: "skill_call", id, request });
      sequence = id;
    } catch {
      pending = null;
      completion.reject(new Error("Capability exceeds its JSON limits."));
    }
    return completion.promise;
  }
  const api = workerData.api;
  if (api?.api_version !== 5 || typeof api.action_enabled !== "boolean" || typeof api.supports_respawn !== "boolean" || !Array.isArray(api.bindings))
    throw new Error("Missing active game API manifest.");
  const methods = Object.assign(Object.create(null), {
    observe: () => call({ kind: "observe" }),
    call: (skill, args) => call({ kind: "call", skill, args }),
    progress: (summary, details) =>
      call({ kind: "progress", summary, details }),
    attention: async (attention) => {
      await call({ kind: "attention", attention });
    },
  });
  if (api.action_enabled) {
    methods.action = (action) => call({ kind: "action", action });
    methods.actionAndObserve = async (action) => {
      const result = await call({ kind: "action", action });
      const evidence = result?.evidence;
      const safe = !result?.requires_reconnect &&
        (result?.status === "succeeded" || result?.status === "failed" &&
          evidence?.neutralized === true && (evidence?.world_effect_emitted === false ||
            evidence?.failure_outcome_confirmed === true));
      // No retry or task verdict. Unknown/cancelled effects are fenced by the
      // host before reaching here; fail closed if a transport ever returns one.
      const observation = safe ? await call({ kind: "observe" }) : null;
      return { action: result, observation };
    };
  }
  if (api.action_enabled && api.supports_respawn) methods.respawn = () => call({ kind: "respawn" });
  for (const binding of api.bindings) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(binding.name) || Object.hasOwn(methods, binding.name) ||
      ["constructor", "prototype", "__proto__"].includes(binding.name) || typeof binding.capability_id !== "string" ||
      !Number.isSafeInteger(binding.version) || binding.version < 1 || !Array.isArray(binding.parameters) || binding.parameters.length > 16 ||
      binding.parameters.some(name => typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(name)))
      throw new Error("Invalid registered adapter API binding.");
    methods[binding.name] = (...values) => {
      const args = Object.create(null);
      for (let index = 0; index < binding.parameters.length; index++) args[binding.parameters[index]] = values[index];
      return call({ kind: "adapter", capability_id: binding.capability_id, version: binding.version, args });
    };
  }
  const game = Object.freeze(methods);
  parentPort.on("message", (frame) => {
    if (!pending || frame.id !== pending.id || frame.type !== "skill_reply")
      return exit(1);
    const completion = pending;
    pending = null;
    if (frame.ok) completion.resolve(frame.value);
    else {
      const error = new Error(typeof frame.error?.message === "string" ? frame.error.message.slice(0, 1000) : "Skill capability failed.");
      if (typeof frame.error?.code === "string") error.code = frame.error.code.slice(0, 80);
      completion.reject(error);
    }
  });
  Promise.resolve()
    .then(async () => {
      const AsyncFunction = Object.getPrototypeOf(
        async function () {},
      ).constructor;
      const execute = new AsyncFunction(
        "game",
        "args",
        workerData.instrumentation.hook_name,
        '"use strict";\n' + workerData.source,
      );
      const result = await execute(game, workerData.args, trace);
      if (pending) throw new Error("Unawaited capability.");
      send({ v: 1, type: "skill_result", id: sequence, result });
    })
    .catch(async (error) => {
      try {
        // A capability already sent remains single-flight and must settle
        // before a controlled failure can close this execution's trace.
        if (pending) await pending.promise.catch(() => {});
        send({ v: 1, type: "skill_failure", id: sequence, diagnostic: diagnostic(error) });
      } catch {
        // No invented omitted count: the host marks an unknown unsent tail.
        exit(1);
      }
    });
}

function runSkillSupervisor() {
  const output = process.stdout.write.bind(process.stdout);
  const exit = process.exit.bind(process);
  let thread = null;
  let closing = false;
  let input = Buffer.alloc(0);
  let pending = 0;
  let sequence = 0;
  let logs = 0;
  const fail = () => {
    if (closing) return;
    closing = true;
    // Local responsiveness is not authority: the host guardian still owns the
    // cgroup freeze, all deadlines, EOF, and confirmed removal.
    exit(1);
  };
  function send(frame) {
    const encoded = stringify(frame) + "\n";
    if (byteLength(encoded) > MAX_SKILL_OUTPUT) throw new Error("output_limit");
    output(encoded);
  }
  function receive(frame) {
    if (frame?.v !== 1 || !depthIsBounded(frame)) throw new Error("protocol");
    if (!thread && frame.type === "skill_init" && frame.id === 0) {
      if (typeof frame.source !== "string" || byteLength(frame.source) > MAX_SKILL_INPUT ||
        !frame.instrumentation ||
        frame.api?.api_version !== 5 || typeof frame.api.action_enabled !== "boolean" ||
        typeof frame.api.supports_respawn !== "boolean" || !Array.isArray(frame.api.bindings) || frame.api.bindings.length > 32 ||
        !/^__trace_[a-f0-9]{32}$/.test(frame.instrumentation.hook_name) ||
        typeof frame.instrumentation.scope !== "string" ||
        !Array.isArray(frame.instrumentation.kinds))
        throw new Error("source");
      thread = new Worker(new URL(import.meta.url), {
        workerData: { mode: "skill", source: frame.source, source_hash: frame.source_hash, args: frame.args, api: frame.api,
          instrumentation: frame.instrumentation },
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 48, stackSizeMb: 2 },
      });
      const consume = (chunk) => {
        logs += chunk.length;
        if (logs > MAX_OUTPUT) fail();
      };
      thread.stdout.on("data", consume);
      thread.stderr.on("data", consume);
      thread.on("error", fail);
      thread.on("exit", fail);
      thread.on("message", (encoded) => {
        try {
          if (
            closing ||
            pending ||
            typeof encoded !== "string" ||
            byteLength(encoded) + 1 > MAX_SKILL_OUTPUT
          )
            throw new Error("protocol");
          const reply = parse(encoded);
          if (reply?.v !== 1 || !depthIsBounded(reply))
            throw new Error("protocol");
          if (reply.type === "skill_call" && reply.id === sequence + 1) {
            sequence = reply.id;
            pending = reply.id;
          } else if (
            !["skill_result", "skill_failure"].includes(reply.type) ||
            reply.id !== sequence
          ) {
            throw new Error("protocol");
          }
          send(reply);
        } catch {
          fail();
        }
      });
      return;
    }
    if (
      !thread ||
      !pending ||
      frame.type !== "skill_reply" ||
      frame.id !== pending ||
      typeof frame.ok !== "boolean"
    )
      throw new Error("protocol");
    pending = 0;
    thread.postMessage(frame);
  }
  process.stdin.on("data", (chunk) => {
    if (closing) return;
    if (input.length + chunk.length > MAX_SKILL_INPUT) return fail();
    input = Buffer.concat([input, chunk]);
    const end = input.indexOf(10);
    if (end === -1) return;
    if (end !== input.length - 1) return fail();
    const line = input.subarray(0, end).toString("utf8");
    input = Buffer.alloc(0);
    try {
      receive(parse(line));
    } catch {
      fail();
    }
  });
  process.stdin.on("end", fail);
  process.stdin.on("error", fail);
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  send({ v: 1, type: "ready", id: 0 });
}

function runSupervisor() {
  const output = process.stdout.write.bind(process.stdout);
  const exit = process.exit.bind(process);
  let thread = null;
  let initialized = false;
  let pending = false;
  let expected = null;
  let watchdog = null;
  let buffer = Buffer.alloc(0);
  let outputBytes = 0;
  let logBytes = 0;
  let closing = false;
  const resident = process.argv[2] === "resident";
  const budget = resident ? Number(process.argv[3]) : 500;
  let residentEntry = null;
  let residentSourceHash = null;
  let sequence = 0;
  if (resident && (!Number.isSafeInteger(budget) || budget < 1 || budget > 5000))
    return exit(1);

  async function shutdown(code) {
    if (closing) return;
    closing = true;
    clearTimeout(watchdog);
    // Best-effort local shutdown only. The host guardian confirms Docker removal
    // and descendant termination even if policy code compromises this thread.
    const lastResort = setTimeout(() => exit(code), 100);
    try {
      if (thread) await thread.terminate();
    } finally {
      clearTimeout(lastResort);
      exit(code);
    }
  }

  function send(value) {
    const line = stringify(value) + "\n";
    outputBytes += byteLength(line);
    if (outputBytes > MAX_OUTPUT) throw new Error("output_limit");
    output(line);
  }

  function fail(origin = "opaque", diagnostic) {
    if (closing) return;
    try {
      const sourceThrow = origin === "source_throw" && validSourceDiagnostic(diagnostic, residentSourceHash);
      send(resident ? { v: 1, type: "resident_fault", id: sequence,
        origin: sourceThrow ? "source_throw" : origin === "watchdog" ? "watchdog" : "opaque",
        ...(sourceThrow ? { diagnostic } : {}) } : { type: "error" });
    } catch {
      /* Never forward policy logs or raw errors. */
    }
    void shutdown(1);
  }

  async function receive(message) {
    if (!message || typeof message !== "object" || !depthIsBounded(message))
      throw new Error("input");
    if (resident) {
      if (!finiteJson(message) || message.v !== 1 || !Number.isSafeInteger(message.id) || message.id < 0)
        throw new Error("protocol");
      if (!initialized) {
        if (message.type !== "resident_init" || message.id !== 0 ||
          !exactKeys(message, ["v", "type", "id", "entry", "bundle"]) ||
          !["step", "analyze"].includes(message.entry))
          throw new Error("resident_init");
        validateModuleBundle(message.bundle, message.entry);
        initialized = true;
        residentEntry = message.entry;
        residentSourceHash = message.bundle.source_hash;
        expected = "resident_compiled";
        watchdog = setTimeout(fail, 15_000);
        thread = new Worker(new URL(import.meta.url), {
          workerData: { mode: "resident", bundle: message.bundle, entry: residentEntry },
          execArgv: ["--experimental-vm-modules"],
          stdout: true, stderr: true,
          resourceLimits: { maxOldGenerationSizeMb: 48, stackSizeMb: 2 },
        });
        attachThread();
        return;
      }
      const step = residentEntry === "step";
      if (!thread || (message.type !== `resident_${residentEntry}` && !(step && message.type === "resident_activate")) ||
        message.id !== sequence + 1 ||
        !exactKeys(message, step ? ["v", "type", "id", "frame", "state", "intent"]
          : ["v", "type", "id", "input"]))
        throw new Error("protocol");
      if (step && (byteLength(stringify(message.state)) > MAX_STATE ||
        byteLength(stringify(message.intent)) > MAX_STATE))
        throw new Error("state_limit");
      sequence = message.id;
      expected = "resident_result";
      watchdog = setTimeout(() => fail("watchdog"), budget);
      thread.postMessage(message);
      return;
    }
    if (message.type === "probe" && !initialized) {
      initialized = true;
      watchdog = setTimeout(fail, 1000);
      send(await probe());
      clearTimeout(watchdog);
      pending = false;
      return;
    }
    if (message.type === "init" && !initialized) {
      if (
        typeof message.source !== "string" ||
        byteLength(message.source) > 32768
      )
        throw new Error("source");
      initialized = true;
      expected = "compiled";
      watchdog = setTimeout(fail, 1000);
      thread = new Worker(new URL(import.meta.url), {
        workerData: { source: message.source, binding: message.binding },
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 48, stackSizeMb: 2 },
      });
      attachThread();
      return;
    }
    if (
      message.type !== "evaluate" ||
      !thread ||
      !message.state ||
      Array.isArray(message.state) ||
      typeof message.state !== "object"
    )
      throw new Error("protocol");
    if (byteLength(stringify(message.state)) > MAX_STATE)
      throw new Error("state_limit");
    expected = "decision";
    // Independent of the host timer and of the policy's own blocked event loop.
    watchdog = setTimeout(fail, 500);
    thread.postMessage({ context: message.context, state: message.state });
  }

  function attachThread() {
      const consumeLog = (chunk) => {
        logBytes += chunk.length;
        outputBytes += chunk.length;
        if (logBytes > MAX_OUTPUT || outputBytes > MAX_OUTPUT) fail();
      };
      thread.stdout.on("data", consumeLog);
      thread.stderr.on("data", consumeLog);
      thread.on("error", fail);
      thread.on("exit", () => {
        if (!closing) fail();
      });
      thread.on("message", (encoded) => {
        try {
          if (
            closing ||
            !pending ||
            typeof encoded !== "string" ||
            byteLength(encoded) + 1 > MAX_OUTPUT
          )
            throw new Error("protocol");
          const reply = parse(encoded);
          if (resident && reply?.v === 1 && reply.type === "resident_fault" && reply.id === sequence &&
              expected === "resident_result" &&
              exactKeys(reply, ["v", "type", "id", "origin", "diagnostic"]) && reply.origin === "source_throw" &&
              validSourceDiagnostic(reply.diagnostic, residentSourceHash))
            return fail("source_throw", reply.diagnostic);
          if (!reply || !depthIsBounded(reply) || reply.type !== expected)
            throw new Error("protocol");
          if (resident && (reply.v !== 1 || reply.id !== sequence ||
            !exactKeys(reply, expected === "resident_compiled"
              ? ["v", "type", "id"] : ["v", "type", "id", "value"])))
            throw new Error("protocol");
          if (reply.type === "decision") {
            if (
              !reply.state ||
              Array.isArray(reply.state) ||
              typeof reply.state !== "object" ||
              byteLength(stringify(reply.state)) > MAX_STATE
            )
              throw new Error("state");
          }
          send(reply);
          clearTimeout(watchdog);
          pending = false;
          expected = null;
        } catch {
          fail();
        }
      });
  }

  process.stdin.on("data", (chunk) => {
    if (closing) return;
    if (pending || buffer.length + chunk.length > MAX_INPUT) return fail();
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf(10);
    if (end === -1) return;
    if (end !== buffer.length - 1) return fail();
    const line = buffer.subarray(0, end).toString("utf8");
    buffer = Buffer.alloc(0);
    pending = true;
    outputBytes = 0;
    Promise.resolve()
      .then(() => receive(parse(line)))
      .catch(fail);
  });
  process.stdin.on("end", () => {
    void shutdown(0);
  });
  process.stdin.on("error", fail);
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  send(resident ? { v: 1, type: "resident_ready", id: 0,
    runtime_features: ["pure_modules_v1", "motion_track_v1"] } : { type: "ready" });
}

if (isMainThread) {
  if (process.argv[2] === "skill") runSkillSupervisor();
  else runSupervisor();
} else if (workerData.mode === "skill") runSkillThread();
else if (workerData.mode === "resident") void runResidentThread().catch(() => process.exit(1));
else runPolicyThread();
