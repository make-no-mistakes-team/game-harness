import { spawn } from "node:child_process";

// This runs on the host, in a session separate from the backend. Generated code
// never runs here and cannot see its EOF pipe, PIDs, or Docker control socket.
const DOCKER = "/usr/bin/docker";
const ENV = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  HOME: "/nonexistent",
  DOCKER_CONFIG: "/nonexistent/.docker",
};
const INPUT_BYTES = 256 * 1024;
const OUTPUT_BYTES = 64 * 1024;
const STARTUP_MS = 15_000;
const [name, runner, image] = process.argv.slice(2);
if (
  !/^gameharness-policy-[a-f0-9-]{73}$/.test(name ?? "") ||
  !runner?.startsWith("/") ||
  runner.includes(",") ||
  !/^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/.test(image ?? "")
)
  process.exit(1);

let closing = false;
let cleanup = null;
let attached = null;
let attachedExited = Promise.resolve();
let expected = "ready";
let input = Buffer.alloc(0);
let output = Buffer.alloc(0);
let outputBytes = 0;
let timer = setTimeout(stop, STARTUP_MS);
let creation = Promise.resolve();

function boundedJson(text) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > 32) throw new Error("depth");
    } else if (character === "}" || character === "]") depth--;
  }
  return JSON.parse(text);
}

function command(args, timeout = 5_000) {
  const completion = Promise.withResolvers();
  const child = spawn(DOCKER, args, {
    env: ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let failed = false;
  // Do not kill an in-flight create: a daemon could commit it after a timed-out
  // client exits. Cleanup must wait for its definitive reply before inspecting.
  const deadline =
    timeout === null
      ? null
      : setTimeout(() => {
          failed = true;
          child.kill("SIGKILL");
        }, timeout);
  const collect = (chunk, errorStream) => {
    bytes += chunk.length;
    if (bytes > OUTPUT_BYTES) {
      failed = true;
      if (timeout !== null) child.kill("SIGKILL");
    } else if (errorStream) stderr += chunk.toString("utf8");
    else stdout += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk) => collect(chunk, false));
  child.stderr.on("data", (chunk) => collect(chunk, true));
  child.on("error", () => {
    failed = true;
  });
  child.on("close", (code) => {
    clearTimeout(deadline);
    completion.resolve({ code: failed ? null : code, stdout, stderr });
  });
  return completion.promise;
}

async function removeOwned() {
  const inspected = await command([
    "inspect",
    "--type",
    "container",
    "--format",
    "{{json .Config.Labels}}",
    name,
  ]);
  if (inspected.code !== 0)
    return /no such (?:container|object)/i.test(inspected.stderr);
  let labels;
  try {
    labels = boundedJson(inspected.stdout);
  } catch {
    return false;
  }
  // Never remove an unrelated container, even if creation failed with a conflict.
  if (
    labels?.["io.gameharness.role"] !== "policy" ||
    labels?.["io.gameharness.owner"] !== name
  )
    return false;
  const removed = await command(["rm", "--force", name]);
  return (
    removed.code === 0 || /no such (?:container|object)/i.test(removed.stderr)
  );
}

function stop() {
  if (cleanup) return cleanup;
  closing = true;
  clearTimeout(timer);
  process.stdin.pause();
  cleanup = (async () => {
    await creation.catch(() => {});
    // A missing/unresponsive daemon must not turn into a claim of successful
    // cleanup. Stay alive and retry until removal is actually confirmed.
    while (!(await removeOwned())) {
      const retry = Promise.withResolvers();
      setTimeout(retry.resolve, 1_000);
      await retry.promise;
    }
    if (attached) {
      attached.stdin.destroy();
      attached.kill("SIGKILL");
      await attachedExited;
    }
    process.exit(0);
  })();
  return cleanup;
}

process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdout.on("error", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", stop);
process.on("uncaughtException", stop);
process.on("unhandledRejection", stop);
process.stdin.on("data", (chunk) => {
  if (closing) return;
  if (expected || !attached || input.length + chunk.length > INPUT_BYTES)
    return void stop();
  input = Buffer.concat([input, chunk]);
  const end = input.indexOf(10);
  if (end === -1) return;
  if (end !== input.length - 1) return void stop();
  try {
    const request = boundedJson(input.subarray(0, end).toString("utf8"));
    if (request?.type === "init") expected = "compiled";
    else if (request?.type === "probe") expected = "proof";
    else if (request?.type === "evaluate") expected = "decision";
    else throw new Error("protocol");
    outputBytes = 0;
    timer = setTimeout(stop, expected === "decision" ? 500 : STARTUP_MS);
    attached.stdin.write(input);
    input = Buffer.alloc(0);
  } catch {
    void stop();
  }
});

async function start() {
  const result = await command(
    [
      "create",
      "--pull=never",
      "--name",
      name,
      "--label",
      "io.gameharness.role=policy",
      "--label",
      `io.gameharness.owner=${name}`,
      "--network",
      "none",
      "--user",
      "65534:65534",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--read-only",
      "--memory",
      "128m",
      "--memory-swap",
      "128m",
      "--cpus",
      "0.5",
      "--pids-limit",
      "32",
      "--ulimit",
      "nofile=64:64",
      "--ipc",
      "none",
      "--log-driver",
      "none",
      "--stop-timeout",
      "1",
      "--env",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "--env",
      "HOME=/nonexistent",
      "--env",
      "NODE_ENV=production",
      "--env",
      "LANG=C.UTF-8",
      "--mount",
      `type=bind,source=${runner},target=/runner.mjs,readonly`,
      "--interactive",
      "--workdir",
      "/",
      "--entrypoint",
      "/usr/local/bin/node",
      image,
      "--max-old-space-size=64",
      "--disable-proto=throw",
      "--disable-sigusr1",
      "/runner.mjs",
    ],
    null,
  );
  if (result.code !== 0 || !/^[a-f0-9]{64}\s*$/.test(result.stdout) || closing)
    return false;
  attached = spawn(DOCKER, ["start", "--attach", "--interactive", name], {
    env: ENV,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = Promise.withResolvers();
  attached.once("close", exit.resolve);
  attachedExited = exit.promise;
  attached.on("error", stop);
  attached.on("close", () => {
    if (!closing) void stop();
  });
  attached.stdin.on("error", stop);
  attached.stderr.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > OUTPUT_BYTES) void stop();
  });
  attached.stdout.on("data", (chunk) => {
    if (closing) return;
    outputBytes += chunk.length;
    if (!expected || outputBytes > OUTPUT_BYTES) return void stop();
    output = Buffer.concat([output, chunk]);
    const end = output.indexOf(10);
    if (end === -1) return;
    if (end !== output.length - 1) return void stop();
    try {
      const reply = boundedJson(output.subarray(0, end).toString("utf8"));
      if (reply?.type !== expected) throw new Error("protocol");
      clearTimeout(timer);
      expected = null;
      process.stdout.write(output);
      output = Buffer.alloc(0);
    } catch {
      void stop();
    }
  });
  return true;
}

creation = start();
void creation
  .then((started) => {
    if (!started) void stop();
  })
  .catch(stop);
