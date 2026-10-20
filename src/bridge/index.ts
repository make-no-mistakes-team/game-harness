import { z } from "zod";
import { format } from "node:util";
import { gameActionSchema } from "../shared/validation.ts";
const MAX_LINE = 131072;
// Reserve stdout for bounded protocol frames, including during third-party module initialization.
for (const name of ["log", "info", "warn", "error", "debug"] as const)
  console[name] = (...values: unknown[]) => {
    process.stderr.write(format(...values).slice(0, 4096) + "\n");
  };
const { TrustedGame } = await import("./game.ts");
const send = (value: unknown) => {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_LINE)
    throw new Error("Bridge response exceeded its bound.");
  process.stdout.write(line + "\n");
};
const connection = z
  .object({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65535),
    username: z.string().regex(/^[A-Za-z0-9_]{1,16}$/),
    version: z.literal("1.21.4"),
    world_id: z.string().min(1).max(160),
    epoch: z.number().int().nonnegative(),
    viewer_token: z.string().min(32).max(512),
    operator_origins: z
      .array(z.string().regex(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/))
      .min(1)
      .max(8),
  })
  .strict();
const request = z.discriminatedUnion("method", [
  z
    .object({
      id: z.number().int().positive(),
      method: z.literal("connect"),
      params: connection,
    })
    .strict(),
  z
    .object({
      id: z.number().int().positive(),
      method: z.literal("execute"),
      params: gameActionSchema,
    })
    .strict(),
  z
    .object({
      id: z.number().int().positive(),
      method: z.literal("recipes"),
      params: z
        .object({ item: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/) })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.number().int().positive(),
      method: z.literal("cancel"),
      params: z.object({ reason: z.string().max(200) }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.number().int().positive(),
      method: z.enum(["observe", "disconnect", "snapshot"]),
    })
    .strict(),
]);
const game = new TrustedGame((notice) => send({ notice }));
let connecting = false;
let admitted = 0;
async function handle(raw: string) {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    await shutdown();
    return;
  }
  const parsed = request.safeParse(input);
  if (!parsed.success) {
    await shutdown();
    return;
  }
  const message = parsed.data;
  if (++admitted > 32) {
    await shutdown();
    return;
  }
  try {
    let data: unknown;
    switch (message.method) {
      case "connect": {
        if (connecting)
          throw new Error("A connection is already being established.");
        connecting = true;
        try {
          await game.connect(message.params);
          data = game.snapshot();
        } finally {
          connecting = false;
        }
        break;
      }
      case "disconnect":
        await game.disconnect();
        data = game.snapshot();
        break;
      case "snapshot":
        data = game.snapshot();
        break;
      case "observe":
        data = game.observe();
        break;
      case "execute":
        data = await game.execute(message.params);
        break;
      case "cancel":
        await game.cancel(message.params.reason);
        data = { neutralized: true, state: game.snapshot() };
        break;
      case "recipes":
        data = game.recipes(message.params.item);
        break;
    }
    send({ id: message.id, ok: true, data });
  } catch {
    send({
      id: message.id,
      ok: false,
      error: "The trusted game bridge could not complete this request.",
    });
  } finally {
    admitted--;
  }
}
let buffer = Buffer.alloc(0),
  closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  process.stdin.pause();
  await game.disconnect().catch(() => {});
  process.exit(0);
}
process.stdin.on("data", (chunk: Buffer) => {
  if (closing) return;
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf(10);
    if (end < 0) break;
    if (end > MAX_LINE) {
      void shutdown();
      return;
    }
    const line = buffer.subarray(0, end).toString("utf8");
    buffer = buffer.subarray(end + 1);
    if (line) void handle(line);
  }
  if (buffer.length > MAX_LINE) void shutdown();
});
process.stdin.once("end", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
process.on("unhandledRejection", () => {
  void shutdown();
});
process.on("uncaughtException", () => {
  void shutdown();
});
