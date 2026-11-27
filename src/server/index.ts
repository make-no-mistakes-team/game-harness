import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AuthManager } from "../auth/manager.ts";
import { APP_PORT, DATA_DIR, PROJECT_ROOT } from "../agent/paths.ts";
import { privateJson } from "../minecraft/client.ts";
import { prepareAgentServerArtifact } from "../minecraft/server-artifact.ts";
import { SURVIVAL_AGENT_GOALS, SURVIVAL_AGENT_STRATEGIES } from "../shared/goals.ts";
import { AgentRequestFault, SurvivalAgent } from "./survival-agent.ts";

const headers = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const empty = z.strictObject({});
const startBody = z.strictObject({ goal: z.enum(SURVIVAL_AGENT_GOALS), strategy: z.enum(SURVIVAL_AGENT_STRATEGIES),
  model: z.strictObject({ provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/) }).optional() });
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Request fields are invalid.");
  return parsed.data;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
function sameSecret(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createApplication({ projectRoot = PROJECT_ROOT, directory = DATA_DIR, port = APP_PORT,
    nonce = process.env.GAMEHARNESS_READY_NONCE ?? null } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const auth = await AuthManager.create(directory, () => {});
  const agent = new SurvivalAgent(projectRoot, directory);
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const controller = new AbortController();
  let closing = false, preparing: Promise<void> | undefined, preparationError: string | null = null;
  let closeTask: Promise<void> | undefined;
  if (process.env.GAMEHARNESS_DESKTOP === "1" && (!nonce || !/^[a-f0-9]{32,64}$/.test(nonce))) {
    await auth.close();
    throw new Error("The desktop backend requires its launcher instance nonce.");
  }
  async function consent() {
    const value = await readFile(path.join(directory, "provisioning-consent.json"), "utf8")
      .then(text => JSON.parse(text)).catch(() => null);
    return value?.eulaAccepted === true && value.minecraftVersion === "1.21.4" &&
      value.eulaUrl === "https://www.minecraft.net/en-us/eula";
  }
  function session(request: Request) {
    const key = /(?:^|;\s*)gh_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
    const value = key && sessions.get(key);
    if (value && value.expires > Date.now()) return value;
    if (key) sessions.delete(key);
  }
  function requireIdle() {
    if (agent.busy()) throw new HttpError(409, "busy", "Stop the current agent run before changing setup or authorization.");
  }
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: 64 * 1024, idleTimeout: 120,
      async fetch(request, httpServer) {
        try {
          const url = new URL(request.url), host = request.headers.get("host"), origin = request.headers.get("origin");
          if (![ `127.0.0.1:${httpServer.port}`, `localhost:${httpServer.port}` ].includes(host ?? "") ||
              origin && origin !== `http://${host}` || request.headers.get("sec-fetch-site") === "cross-site")
            throw new HttpError(403, "forbidden", "Only same-origin local requests are allowed.");
          if (request.method === "GET" && url.pathname === "/v1/ready") return json({ ready: !closing, instance: nonce });
          if (closing) throw new HttpError(503, "unavailable", "GameHarness is shutting down.");
          if (request.method === "GET" && url.pathname === "/v1/session") {
            let value = session(request), key: string | undefined;
            if (!value) {
              for (const [id, candidate] of sessions) if (candidate.expires <= Date.now()) sessions.delete(id);
              if (sessions.size >= 32) throw new HttpError(429, "busy", "Too many local browser sessions.");
              key = randomBytes(32).toString("hex");
              value = { csrf: randomBytes(32).toString("hex"), expires: Date.now() + 8 * 60 * 60_000 };
              sessions.set(key, value);
            }
            const response = json({ csrf_token: value.csrf });
            if (key) response.headers.set("Set-Cookie", `gh_session=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
            return response;
          }
          if (url.pathname.startsWith("/v1/")) {
            const owner = session(request);
            if (!owner) throw new HttpError(401, "unauthorized", "Open GameHarness to establish a local session.");
            if (!["GET", "HEAD"].includes(request.method) && !sameSecret(request.headers.get("x-csrf-token") ?? "", owner.csrf))
              throw new HttpError(403, "forbidden", "The local request token is missing or expired.");
            const route = `${request.method} ${url.pathname}`;
            switch (route) {
              case "GET /v1/state": return json({ auth: auth.snapshot(), eulaAccepted: await consent(),
                preparing: !!preparing, preparationError });
              case "GET /v1/survival-agent": return json(agent.snapshot());
              case "POST /v1/survival-agent/start": {
                if (preparing) throw new HttpError(409, "busy", "Wait for Minecraft server preparation to finish.");
                const input = await body(request, startBody);
                if (input.model) {
                  const catalog = auth.snapshot();
                  if (catalog.status !== "ready" || !catalog.authenticated ||
                      !catalog.models.some(model => model.provider === input.model!.provider && model.id === input.model!.modelId))
                    throw new HttpError(400, "model_unavailable", "Choose a model from the connected account's catalog.");
                }
                return json(agent.start(input), 202);
              }
              case "POST /v1/survival-agent/stop": await body(request, empty); return json(agent.stop(), 202);
              case "GET /v1/survival-agent/video": {
                if ([...url.searchParams.keys()].some(key => key !== "run") || url.searchParams.getAll("run").length > 1)
                  throw new HttpError(400, "invalid_request", "Video accepts one run identifier.");
                const response = agent.video(request, owner.expires, url.searchParams.get("run"), headers);
                httpServer.timeout(request, 0);
                return response;
              }
              case "POST /v1/server/prepare": {
                requireIdle();
                const input = await body(request, z.strictObject({ accept_eula: z.literal(true) }));
                if (preparing) throw new HttpError(409, "busy", "Minecraft server preparation is already running.");
                await privateJson(path.join(directory, "provisioning-consent.json"), {
                  eulaAccepted: input.accept_eula, minecraftVersion: "1.21.4", eulaUrl: "https://www.minecraft.net/en-us/eula",
                });
                preparationError = null;
                preparing = prepareAgentServerArtifact(projectRoot, controller.signal).then(() => {}, () => {
                  preparationError = "Could not prepare the Minecraft server. Check download access and retry.";
                }).finally(() => { preparing = undefined; });
                return json({ preparing: true }, 202);
              }
              case "POST /v1/auth/login": {
                requireIdle();
                const input = await body(request, z.strictObject({ mode: z.enum(["browser", "device"]) }));
                return json(await auth.startLogin(input.mode), 202);
              }
              case "POST /v1/auth/input": {
                const input = await body(request, z.strictObject({ login_id: z.string().min(1).max(100), value: z.string().max(8192) }));
                auth.submitInput(input.login_id, input.value); return json(auth.snapshot());
              }
              case "POST /v1/auth/cancel": {
                const input = await body(request, z.strictObject({ login_id: z.string().min(1).max(100) }));
                await auth.cancelLogin(input.login_id); return json(auth.snapshot());
              }
              case "POST /v1/auth/logout": requireIdle(); await body(request, empty); await auth.logout(); return json(auth.snapshot());
              case "POST /v1/auth/refresh": requireIdle(); await body(request, empty); await auth.refreshModels(); return json(auth.snapshot());
            }
            throw new HttpError(404, "not_found", "API route not found.");
          }
          // Never serve arbitrary checkout paths, source, credentials or evidence.
          if (request.method !== "GET" || !(/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname) ||
              /^\/licenses\/[A-Za-z0-9_.-]+$/.test(url.pathname) || url.pathname === "/"))
            throw new HttpError(404, "not_found", "File not found.");
          const file = Bun.file(path.join(projectRoot, "dist/web", url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
          if (!await file.exists()) throw new HttpError(404, "not_found", "Build the GameHarness UI first.");
          return new Response(file, { headers });
        } catch (error) {
          if (error instanceof HttpError || error instanceof AgentRequestFault)
            return json({ error: { code: error.code, message: error.message } }, error.status);
          return json({ error: { code: "service_failure", message: "The local operation failed. Check setup and try again." } }, 500);
        }
      },
    });
  } catch (error) { await auth.close(); throw error; }
  return { server, close() {
    if (closeTask) return closeTask;
    closing = true; controller.abort();
    closeTask = (async () => {
      await Promise.all([agent.close(), preparing]);
      await auth.close();
      await server.stop(true);
      sessions.clear();
    })().catch(error => { closeTask = undefined; throw error; });
    return closeTask;
  } };
}

if (import.meta.main) {
  if (process.env.GAMEHARNESS_LOCK_HELD !== "1") throw new Error("Start with bun run start or bun run dev so the data lock is held.");
  const app = await createApplication();
  const close = () => { void app.close().then(() => process.exit(0), () => console.error("GameHarness cleanup is unconfirmed; retry closing.")); };
  process.on("SIGINT", close); process.on("SIGTERM", close);
  if (process.env.GAMEHARNESS_DESKTOP === "1") { process.stdin.once("end", close); process.stdin.once("error", close); process.stdin.resume(); }
  const origin = `http://127.0.0.1:${app.server.port}`;
  console.log(`GameHarness listening at ${origin}`);
  if (process.env.GAMEHARNESS_READY_NONCE) console.log(`GAMEHARNESS_READY ${JSON.stringify({ nonce: process.env.GAMEHARNESS_READY_NONCE, origin })}`);
}
