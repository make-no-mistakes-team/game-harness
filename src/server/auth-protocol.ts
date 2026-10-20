import { z } from "zod";

export const oauthGrantSchema = z
  .object({
    access: z.string().min(1).max(65536),
    refresh: z.string().min(1).max(65536),
    expires: z.number().finite().positive(),
    email: z.string().min(1).max(320).optional(),
    accountId: z.string().min(1).max(512).optional(),
    orgId: z.string().min(1).max(512).optional(),
    orgName: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine(
    (grant) => Boolean(grant.email || grant.accountId),
    "Missing OAuth identity",
  );

export const authWorkerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("auth"),
      url: z.string().max(16384),
      launch_url: z.string().max(16384).optional(),
      instructions: z.string().max(4096).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("prompt"),
      label: z.string().min(1).max(2000),
      secret: z.boolean(),
      allow_empty: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("grant"), grant: oauthGrantSchema }).strict(),
  z.object({ type: z.literal("error"), message: z.string().max(500) }).strict(),
]);
export type AuthWorkerMessage = z.infer<typeof authWorkerMessageSchema>;
export const AUTH_MESSAGE_LIMIT = 192 * 1024;

/** Only the pinned public Codex flows may produce clickable links. */
export function validatedAuthUrl(
  value: string,
  mode: "browser" | "device",
  launch = false,
): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash)
    throw new Error("Invalid authorization URL");
  if (launch) {
    if (
      mode !== "browser" ||
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.port !== "1455" ||
      url.pathname !== "/launch"
    ) {
      throw new Error("Invalid authorization URL");
    }
  } else if (
    url.protocol !== "https:" ||
    url.hostname !== "auth.openai.com" ||
    url.port ||
    url.pathname !== (mode === "browser" ? "/oauth/authorize" : "/codex/device")
  ) {
    throw new Error("Invalid authorization URL");
  }
  return url.href;
}

/** Classify, never quote upstream errors: their messages may contain response bodies. */
export function safeAuthError(error: unknown): string {
  let value = error;
  for (
    let depth = 0;
    depth < 4 && value && typeof value === "object";
    depth++
  ) {
    const record = value as Record<string, unknown>;
    if (record.code === "EADDRINUSE")
      return "OAuth callback port 1455 is in use. Close the other login or choose device login.";
    // OMP's callback waiter wraps its five-minute TimeoutError in
    // LoginCancelledError. Classify the reason without publishing its message.
    if (
      record.name === "LoginCancelledError" &&
      typeof record.message === "string" &&
      /TimeoutError|timed out/i.test(record.message)
    )
      return "Authorization timed out. Start a new login.";
    if (record.name === "AbortError" || record.name === "LoginCancelledError")
      return "Authorization was cancelled.";
    if (record.name === "TimeoutError" || record.kind === "timeout")
      return "Authorization timed out. Start a new login.";
    if (record.status === 401)
      return "OpenAI rejected this login. Sign in again.";
    if (record.status === 403 && record.kind === "device-auth")
      return "OpenAI rejected device-code initiation (HTTP 403), before account sign-in. Check the backend network/proxy route; this response does not establish an account-settings problem.";
    if (record.status === 403)
      return "OpenAI rejected an OAuth request (HTTP 403). Check the backend network/proxy route and the account or workspace permissions.";
    // The callback wrapper may retain the OS code only in its message.
    if (
      typeof record.message === "string" &&
      /EADDRINUSE|port 1455.*(?:in use|occupied)/i.test(record.message)
    )
      return "OAuth callback port 1455 is in use. Close the other login or choose device login.";
    value = record.cause;
  }
  return "OpenAI authorization could not complete. Check connectivity and account permissions, then try again.";
}
