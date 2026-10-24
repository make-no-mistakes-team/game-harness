import { readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createConnection } from "node:net";
import { types } from "node:util";
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

function depthIsBounded(value, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (value && typeof value === "object") {
    for (const entry of Object.values(value))
      if (!depthIsBounded(entry, depth + 1)) return false;
  }
  return true;
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
  function boundedMessage(value) {
    let text = slice(value, 0, 1000);
    while (byteLength(text) > 1000) text = slice(text, 0, -1);
    return text;
  }
  function diagnostic(error) {
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
    const payload = stringify(frame);
    if (!payload || byteLength(payload) + 1 > MAX_OUTPUT ||
      !depthIsBounded(parse(payload)))
      throw new Error("output_limit");
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
  if (api?.api_version !== 4 || typeof api.action_enabled !== "boolean" || typeof api.supports_respawn !== "boolean" || !Array.isArray(api.bindings))
    throw new Error("Missing active game API manifest.");
  const methods = Object.assign(Object.create(null), {
    observe: () => call({ kind: "observe" }),
    call: (skill, args) => call({ kind: "call", skill, args }),
    progress: (summary, details) =>
      call({ kind: "progress", summary, details }),
  });
  if (api.action_enabled) methods.action = (action) => call({ kind: "action", action });
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
        frame.api?.api_version !== 4 || typeof frame.api.action_enabled !== "boolean" ||
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

  function fail() {
    if (closing) return;
    try {
      send({ type: "error" });
    } catch {
      /* Never forward policy logs or raw errors. */
    }
    void shutdown(1);
  }

  async function receive(message) {
    if (!message || typeof message !== "object" || !depthIsBounded(message))
      throw new Error("input");
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
          if (!reply || !depthIsBounded(reply) || reply.type !== expected)
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
  send({ type: "ready" });
}

if (isMainThread) {
  if (process.argv[2] === "skill") runSkillSupervisor();
  else runSupervisor();
} else if (workerData.mode === "skill") runSkillThread();
else runPolicyThread();
