import { readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createConnection } from "node:net";
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
  const evaluate = new AsyncFunction(
    "context",
    "state",
    '"use strict";\n' + workerData.source,
  );
  let busy = false;
  parentPort.on("message", (message) => {
    if (busy) return exit(1);
    busy = true;
    Promise.resolve()
      .then(async () => {
        const state = message.state;
        const decision = await evaluate(message.context, state);
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
        workerData: { source: message.source },
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

if (isMainThread) runSupervisor();
else runPolicyThread();
