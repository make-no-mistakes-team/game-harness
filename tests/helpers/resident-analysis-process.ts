import { spawn } from "node:child_process";
import type { Json } from "../../src/shared/contracts.ts";
import type { ExecutableModuleBundle } from "../../src/shared/programs.ts";
import type { ResidentAnalysisWorker } from "../../src/shared/resident.ts";

/** Shipped supervisor/module thread, not Docker or native gameplay. Timing here
 * is local pipe roundtrip, not a claim about production guardian CPU accounting. */
export async function residentAnalysisProcess(bundle: ExecutableModuleBundle, budget: number,
  signal: AbortSignal): Promise<ResidentAnalysisWorker> {
  const executable = Bun.which("node");
  if (!executable) throw new Error("Node is required for the isolated software analysis fixture");
  const child = spawn(executable, [new URL("../../sandbox/worker.mjs", import.meta.url).pathname, "resident", String(budget)],
    { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" } });
  const exited = Promise.withResolvers<void>(), lines: unknown[] = [];
  const waiters: { resolve(value: unknown): void; reject(reason: unknown): void }[] = [];
  let buffer = "", ended = false, sequence = 0;
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const frame: unknown = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame); else lines.push(frame);
    }
  });
  child.stderr.resume(); child.stdin.on("error", () => {});
  child.on("error", error => { for (const waiter of waiters.splice(0)) waiter.reject(error); });
  child.once("close", () => {
    ended = true; exited.resolve();
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("Isolated analysis fixture closed"));
  });
  const read = () => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (ended) return Promise.reject(new Error("Isolated analysis fixture closed"));
    const waiter = Promise.withResolvers<unknown>(); waiters.push(waiter); return waiter.promise;
  };
  const abort = () => { child.stdin.end(); };
  const close = async () => { signal.removeEventListener("abort", abort); child.stdin.end(); await exited.promise; };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("Analysis fixture cancelled before compile");
    const ready = await read() as { type: string };
    if (ready.type !== "resident_ready") throw new Error("Analysis fixture was not ready");
    child.stdin.write(JSON.stringify({ v: 1, type: "resident_init", id: 0, entry: "analyze", bundle }) + "\n");
    const compiled = await read() as { type: string };
    if (compiled.type !== "resident_compiled") throw new Error("Analysis fixture did not compile");
    return { async analyze(input, _signal, onEvaluation) {
      const id = ++sequence, started = performance.now();
      child.stdin.write(JSON.stringify({ v: 1, type: "resident_analyze", id, input }) + "\n");
      const result = await read() as { type: string; value: Json };
      onEvaluation?.(performance.now() - started);
      if (result.type !== "resident_result") throw new Error("Isolated software analysis failed");
      return result.value;
    }, close };
  } catch (error) { await close(); throw error; }
}
