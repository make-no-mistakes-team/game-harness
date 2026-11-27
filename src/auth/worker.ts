import { z } from "zod";
import { loginOpenAICodexDevice } from "@oh-my-pi/pi-ai/oauth/openai-codex";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import {
  AUTH_MESSAGE_LIMIT,
  oauthGrantSchema,
  safeAuthError,
  validatedAuthUrl,
  type AuthWorkerMessage,
} from "./protocol.ts";

// This trusted helper has no credential store. Its stdout is private parent IPC;
// upstream progress includes device codes and must never become generic logs.
for (const method of [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
] as const)
  console[method] = () => {};
setTransports({ console: false, file: false });
const controller = new AbortController();
let pendingInput: {
  resolve(value: string): void;
  reject(error: Error): void;
} | null = null;
let terminal = false;
function send(message: AuthWorkerMessage): void {
  const line = JSON.stringify(message) + "\n";
  if (Buffer.byteLength(line) > AUTH_MESSAGE_LIMIT)
    throw new Error("OAuth IPC message exceeds limit");
  process.stdout.write(line);
}
function stop(): never {
  controller.abort();
  pendingInput?.reject(new Error("Authorization cancelled"));
  pendingInput = null;
  process.exit(1);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function readInputs(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer) > 16384) stop();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const parsed = z
        .object({ type: z.literal("input"), value: z.string().max(8192) })
        .strict()
        .safeParse(JSON.parse(line));
      if (!parsed.success || !pendingInput) stop();
      const pending = pendingInput;
      pendingInput = null;
      pending.resolve(parsed.data.value);
    }
  }
  if (!terminal) stop();
}
void readInputs().catch(stop);

try {
  const mode = z.enum(["browser", "device"]).parse(process.argv[2]);
  const callbacks = {
    signal: controller.signal,
    onAuth(info: { url: string; launchUrl?: string; instructions?: string }) {
      send({
        type: "auth",
        url: validatedAuthUrl(info.url, mode),
        ...(info.launchUrl
          ? { launch_url: validatedAuthUrl(info.launchUrl, mode, true) }
          : {}),
        ...(info.instructions
          ? { instructions: info.instructions.slice(0, 4096) }
          : {}),
      });
    },
    onPrompt(prompt: {
      message: string;
      secret?: boolean;
      allowEmpty?: boolean;
    }): Promise<string> {
      if (pendingInput) throw new Error("Overlapping OAuth input request");
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      pendingInput = { resolve, reject };
      send({
        type: "prompt",
        label: prompt.message.slice(0, 2000),
        secret: prompt.secret === true,
        allow_empty: prompt.allowEmpty === true,
      });
      return promise;
    },
    // Intentionally no onProgress/onManualCodeInput: progress can contain codes,
    // and browser login must finish through the state-checked callback on 1455.
  };
  let result: unknown;
  if (mode === "device") {
    result = await loginOpenAICodexDevice(callbacks);
  } else {
    const provider = getProviderDefinition("openai-codex");
    if (!provider?.login)
      throw new Error("Browser OAuth provider is unavailable");
    result = await provider.login(callbacks);
  }
  controller.signal.throwIfAborted();
  send({ type: "grant", grant: oauthGrantSchema.parse(result) });
  terminal = true;
  // Flush the one private grant before exiting; no store ever exists here.
  const flushed = Promise.withResolvers<void>();
  process.stdout.write("", () => flushed.resolve());
  await flushed.promise;
  process.exit(0);
} catch (error) {
  terminal = true;
  send({ type: "error", message: safeAuthError(error) });
  const flushed = Promise.withResolvers<void>();
  process.stdout.write("", () => flushed.resolve());
  await flushed.promise;
  process.exit(1);
}
