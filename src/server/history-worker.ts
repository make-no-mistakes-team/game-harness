import { z } from "zod";
import { HISTORY_LIMITS } from "./history-limits.ts";
import { historyQuerySchema, type HistoryResponseFrame } from "./history-protocol.ts";

// Stdout is exclusively the bounded protocol, including during module initialization.
for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) console[method] = () => {};
const requestSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  query: historyQuerySchema,
}).strict();

function failure(id: number, error: unknown): HistoryResponseFrame {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
    /^[a-zA-Z0-9_]{1,80}$/.test(error.code) ? error.code : "query_failed";
  return { id, ok: false, error: { code, message: error instanceof Error ? error.message.slice(0, 512) : "History query failed" } };
}

async function send(frame: HistoryResponseFrame): Promise<void> {
  let line: string;
  try {
    line = JSON.stringify(frame) + "\n";
  } catch {
    line = JSON.stringify(failure(frame.id, new Error("History result could not be serialized"))) + "\n";
  }
  if (Buffer.byteLength(line, "utf8") > HISTORY_LIMITS.responseBytes)
    line = JSON.stringify({ id: frame.id, ok: false, error: { code: "response_too_large", message: "History result exceeds its wire budget" } }) + "\n";
  const written = Promise.withResolvers<void>();
  process.stdout.write(line, error => error ? written.reject(error) : written.resolve());
  await written.promise;
}

async function run(): Promise<void> {
  const database = process.argv[2], artifacts = process.argv[3];
  if (process.argv.length !== 4 || !database || !artifacts) throw new Error("History worker requires fixed store paths");
  const [{ ReadonlyStore }, { dispatchHistoryQuery }] = await Promise.all([
    import("./store-read.ts"), import("./history-dispatch.ts"),
  ]);
  const store = new ReadonlyStore({ database, artifacts });
  let bytes = 0;
  let parts: Buffer[] = [];
  let lastId = 0;
  try {
    for await (const input of process.stdin) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const through = end < 0 ? chunk.length : end + 1;
        const length = through - offset;
        if (bytes + length > HISTORY_LIMITS.requestBytes) throw new Error("History request exceeds its wire budget");
        parts.push(Buffer.from(chunk.subarray(offset, through)));
        bytes += length;
        offset = through;
        if (end < 0) break;
        const frameBytes = Buffer.concat(parts, bytes);
        parts = [];
        bytes = 0;
        const line = new TextDecoder("utf-8", { fatal: true }).decode(frameBytes.subarray(0, frameBytes.length - 1));
        const request = requestSchema.parse(JSON.parse(line));
        if (request.id <= lastId) throw new Error("History request identifier was reused or reordered");
        lastId = request.id;
        let frame: HistoryResponseFrame;
        try {
          // All reads and reducers share this short deferred snapshot. No transaction
          // remains pinned during serialization, pipe backpressure or idle stdin.
          const value = store.snapshot(() => dispatchHistoryQuery(store, request.query));
          frame = { id: request.id, ok: true, value } as HistoryResponseFrame;
        } catch (error) {
          frame = failure(request.id, error);
        }
        await send(frame);
      }
    }
    if (bytes) throw new Error("History request stream ended in an incomplete frame");
  } finally {
    store.close();
  }
}

// A broken response pipe rejects send(), rather than becoming an unhandled event.
process.stdout.on("error", () => {});
void run().catch(() => { process.exitCode = 1; process.stdin.destroy(); });
