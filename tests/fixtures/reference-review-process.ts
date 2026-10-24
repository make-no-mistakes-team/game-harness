import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

// External dependency fixture ONLY: no model, game, Docker daemon or GPU.
// The regressions assert production owner/ledger/resource behavior, not these replies.
const root = process.env.REFERENCE_REVIEW_ROOT!;
const mode = process.env.REFERENCE_REVIEW_MODE!;
const operation = process.argv[2]!;
const ownerPid = process.ppid;
const ownerWatch = setInterval(() => { if (process.ppid !== ownerPid) process.exit(97); }, 100);
ownerWatch.unref();
const mark = (name: string, value: unknown = true) => writeFileSync(join(root, `${name}.json`), JSON.stringify(value));
appendFileSync(join(root, "external-processes.jsonl"), JSON.stringify({ pid: process.pid, operation, args: process.argv.slice(3) }) + "\n");
if (operation === "exec") {
  const { command, args } = JSON.parse(process.argv[3]!);
  if (command === "docker" && args[0] === "image") {
    mark("image-inspected"); console.log(JSON.stringify([{ Id: `sha256:${"8".repeat(64)}` }]));
  } else if (command === "docker" && args[0] === "inspect") {
    const name = args[1], role = name.endsWith("-policy") ? "policy" : "environment";
    const argv: string[] = JSON.parse(readFileSync(join(root, `${role}-argv.json`), "utf8"));
    const arg = (key: string) => argv[argv.indexOf(key) + 1];
    const mounts = argv.flatMap((item, index) => item === "--mount" ? [{ Destination: argv[index + 1]!.match(/dst=([^,]+)/)![1], RW: !argv[index + 1]!.includes(",readonly") }] : []);
    console.log(JSON.stringify([{ Name: `/${name}`, State: { Running: true, Pid: Number(readFileSync(join(root, `${role}.pid`), "utf8")) },
      HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, SecurityOpt: ["no-new-privileges"], Privileged: false,
        Memory: Number(arg("--memory")), MemorySwap: Number(arg("--memory-swap")), PidsLimit: Number(arg("--pids-limit")), NanoCpus: Number(arg("--cpus")) * 1e9 },
      Config: { User: "1000:1000" }, Mounts: mounts }]));
  } else if (command === "docker" && args[0] === "stats") {
    if (mode === "responsive-final-sampler" && existsSync(join(root, "final-sampler-requested.json"))) {
      mark("responsive-sampler-started", { pid: process.pid, at_ms: Date.now() });
      process.on("SIGTERM", () => {
        mark("responsive-sampler-stopped-before-grace", { at_ms: Date.now() });
        process.stderr.write("R3 healthy final sampler killed before its bounded grace\n");
        process.exit(41);
      });
      while (!existsSync(join(root, "release-responsive-sampler.json"))) await delay(5);
      mark("responsive-sampler-completed", { pid: process.pid, at_ms: Date.now() });
    }
    if (mode === "sampler-failure" || mode === "sampler-ignore-term"
      || (mode === "held-final-sampler" && existsSync(join(root, "final-sampler-requested.json")))) {
      mark("blocked-helper-started", process.pid);
      process.on("SIGTERM", () => {
        mark("blocked-helper-sigterm");
        if (mode === "sampler-failure") process.exit(0);
        mark("blocked-helper-ignored-sigterm", { pid: process.pid, at_ms: Date.now() });
      });
      if (mode === "sampler-failure") await delay(15000);
      else while (true) await delay(1000); // Real SIGTERM ignorer; test owner must escalate.
    }
    for (const name of args.slice(4)) console.log(JSON.stringify({ Name: name, MemUsage: "1MiB / 8GiB", PIDs: "1" }));
  } else if (command === "docker" && args[0] === "top") {
    const role = args[1].endsWith("-policy") ? "policy" : "environment";
    console.log(`PID\n${readFileSync(join(root, `${role}.pid`), "utf8").trim()}`);
  } else if (command === "nvidia-smi") {
    if (mode === "sampler-failure" || mode === "sampler-ignore-term") {
      while (!existsSync(join(root, "blocked-helper-started.json"))) await delay(5);
      process.stderr.write("F6 immediate independent sampling failure\n"); process.exit(42);
    }
    console.log("64, 16384");
  } else if (command === "docker" && args[0] === "rm") {
    const role = args.at(-1).endsWith("-policy") ? "policy" : "environment";
    mark(`${role}-forced-removal`, { at_ms: Date.now(), name: args.at(-1) });
    try { process.kill(Number(readFileSync(join(root, `${role}.pid`), "utf8")), "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    console.log(args.at(-1));
  } else throw new Error(`Unexpected external command ${command} ${args.join(" ")}`);
} else if (operation === "worker") {
  const argv: string[] = JSON.parse(process.argv[3]!);
  const role = argv.at(-1) === "policy" ? "policy" : "environment";
  writeFileSync(join(root, `${role}.pid`), String(process.pid));
  writeFileSync(join(root, `${role}-argv.json`), JSON.stringify(argv));
  mark(`${role}-started`);
  const frame = { width: 640, height: 360, color: "RGB", dtype: "uint8", data_base64: Buffer.alloc(691200).toString("base64") };
  const buttons = ["attack", "back", "forward", "jump", "left", "right", "sneak", "sprint", "use", "drop", "inventory", ...Array.from({ length: 9 }, (_, i) => `hotbar.${i + 1}`)];
  let currentCase = "calibration";
  const send = async (value: unknown) => {
    const flushed = Promise.withResolvers<void>();
    process.stdout.write(JSON.stringify(value) + "\n", () => flushed.resolve());
    await flushed.promise;
  };
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const message = JSON.parse(line), base = { request_id: message.request_id };
    let response: Record<string, unknown>;
    if (message.kind === "initialize") response = { ...base, kind: "ready", evidence: role === "policy"
      ? { runtime: message.spec.runtime, text_encoder_calls: 2, prior_calls: 2, checkpoint_key_compatibility: "strict", torch_peak_allocated_bytes: 1024, torch_peak_reserved_bytes: 2048 }
      : { source: "synthetic external environment transport, not gameplay" } };
    else if (message.kind === "reset") {
      if (role === "environment") currentCase = message.case_id;
      response = role === "policy" ? { ...base, kind: "reset" } : { ...base, kind: "observation", pov: frame, done: false, verification: { verified: false } };
    } else if (message.kind === "action") response = { ...base, kind: "action", action: { ...Object.fromEntries(buttons.map(key => [key, 0])), camera: [0, 0] }, torch_peak_allocated_bytes: 1024, torch_peak_reserved_bytes: 2048 };
    else if (message.kind === "control_probe") response = { ...base, kind: "observation", steps: 2, control_verified: true, control_evidence: {}, pov: frame, done: false, verification: { verified: false } };
    else if (message.kind === "step") response = { ...base, kind: "observation", pov: frame, done: false, verification: { verified: true } };
    else if (message.kind === "finish_setup") response = { ...base, kind: "setup_finished" };
    else if (message.kind === "start_behavior") response = { ...base, kind: "behavior_started" };
    else if (message.kind === "reserve_inference") response = { ...base, kind: "inference_reserved", ticket: `synthetic-ticket-${message.request_id}` };
    else if (message.kind === "finish_case") {
      if (role === "environment" && currentCase === "wood" && ["held-final-sampler", "responsive-final-sampler"].includes(mode)) {
        if (mode === "responsive-final-sampler") {
          writeFileSync(join(root, "cgroup/policy/memory.current"), "16777216");
          writeFileSync(join(root, "cgroup/environment/memory.current"), "16777216");
        }
        mark("final-sampler-requested");
        const marker = mode === "responsive-final-sampler" ? "responsive-sampler-started.json" : "blocked-helper-started.json";
        while (!existsSync(join(root, marker))) await delay(5);
      }
      response = { ...base, kind: "case_finished", verification: { verified: true } };
    }
    else if (message.kind === "close") {
      mark(`${role}-close-requested`, { at_ms: Date.now() });
      if (role === "environment" && ["sigint", "sigterm", "deadline"].includes(mode))
        while (!existsSync(join(root, "release-close.json"))) await delay(5);
      if (role === "environment" && mode === "close-never-ack")
        while (true) await delay(1000); // Responsive daemon removal is a separate process.
      await send({ ...base, kind: "closed" });
      process.exit(0);
    } else throw new Error(`Unexpected synthetic external protocol phase ${message.kind}`);
    await send(response);
    if (message.kind === "finish_case" && role === "environment" && currentCase === "wood") {
      mark("final-behavior-response", { at_ms: Date.now() });
      if (mode === "late-error") await send({ kind: "error", error: "F5 idle error after final response" });
      if (mode === "late-duplicate") await send(response);
      if (mode === "late-exit") process.exit(19);
    }
  }
} else throw new Error("Unknown external fixture role");
