import { CONTEXT_PROTOCOL_VERSION, CONTEXT_WORKER_LIMITS, contextRequestSchema, type ContextResponse } from "./strategic-context-protocol.ts";

// The pipe is a protocol, including while readonly modules initialize.
for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) console[method] = () => {};

async function send(frame: ContextResponse) {
  const line = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(line) > CONTEXT_WORKER_LIMITS.responseBytes) throw new Error("Context response wire budget exceeded");
  const completion = Promise.withResolvers<void>();
  process.stdout.write(line, error => error ? completion.reject(error) : completion.resolve());
  await completion.promise;
}

async function run() {
  const database = process.argv[2], artifacts = process.argv[3], projection = process.argv[4];
  if (process.argv.length !== 5 || !database || !artifacts || !projection) throw new Error("Context requires explicit source and projection stores");
  const [{ ReadonlyStore }, { StrategicContext }, { osMonotonicNs }] = await Promise.all([
    import("./store-read.ts"), import("./strategic-context.ts"), import("./os-monotonic.ts"),
  ]);
  const store = new ReadonlyStore({ database, artifacts, projection });
  let bytes = 0, lastId = 0;
  let parts: Buffer[] = [];
  try {
    for await (const input of process.stdin) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset), through = end < 0 ? chunk.length : end + 1;
        const length = through - offset;
        if (bytes + length > CONTEXT_WORKER_LIMITS.requestBytes) throw new Error("Context request wire budget exceeded");
        parts.push(Buffer.from(chunk.subarray(offset, through))); bytes += length; offset = through;
        if (end < 0) break;
        const frame = Buffer.concat(parts, bytes); parts = []; bytes = 0;
        const request = contextRequestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, frame.length - 1))));
        if (request.id <= lastId) throw new Error("Context request reordered");
        lastId = request.id;
        let response: ContextResponse;
        try {
          const deadline = BigInt(request.deadline_os_ns);
          if (osMonotonicNs() >= deadline) throw new Error("Context deadline expired");
          const retained = new StrategicContext(store);
          if (request.checkpoint !== null) {
            if (Buffer.byteLength(request.checkpoint) > CONTEXT_WORKER_LIMITS.checkpointBytes) throw new Error("Context checkpoint wire budget exceeded");
            retained.restore(JSON.parse(request.checkpoint));
          }
          // Both databases are pinned only for the reducer. No snapshot survives
          // serialization, IPC backpressure, an await or the idle worker loop.
          const context = store.snapshot(() => {
            const run = store.getRun(request.scope.run_id);
            if (!run) throw new Error("Context run unavailable");
            Object.assign(run, request.scope);
            for (const operation of request.operations) {
              if (operation.kind === "help") retained.rememberHelp(operation.topic, operation.value);
              else retained.selectProgram(operation.name, operation.version);
            }
            retained.synchronize(run, request.model,
              { messages: [] }, request.observation, request.adapter);
            return retained.assemble(run, request.adapter, request.pendingAuthoring);
          });
          const checkpoint = JSON.stringify(retained.checkpoint());
          if (osMonotonicNs() >= deadline || Buffer.byteLength(context) > CONTEXT_WORKER_LIMITS.contextBytes ||
              Buffer.byteLength(checkpoint) > CONTEXT_WORKER_LIMITS.checkpointBytes) throw new Error("Context deadline or result budget exceeded");
          response = { v: CONTEXT_PROTOCOL_VERSION, id: request.id, ok: true, context, checkpoint, worker_pid: process.pid };
        } catch {
          response = { v: CONTEXT_PROTOCOL_VERSION, id: request.id, ok: false, error: "context_worker_failed" };
        }
        await send(response);
      }
    }
    if (bytes) throw new Error("Incomplete context request");
  } finally { store.close(); }
}
process.stdout.on("error", () => {});
void run().catch(() => { process.exitCode = 1; process.stdin.destroy(); });
