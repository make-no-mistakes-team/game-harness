import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AuthManager } from "./auth.ts";
import { GameBridgeClient } from "./game-bridge.ts";
import { MinecraftServer } from "./minecraft-server.ts";
import { Runtime } from "./runtime.ts";
import { SandboxService } from "./sandbox.ts";
import { Store } from "./store.ts";
import { JevBroker } from "./jev.ts";
import { VideoStream, type VideoSocketData } from "./video.ts";
import { PerformanceMonitor } from "./performance.ts";
import {
  APP_PORT,
  APP_ORIGIN,
  DATA_DIR,
  MINECRAFT_VERSION,
  OPERATOR_ORIGINS,
  PROJECT_ROOT,
  setListeningPort,
} from "./config.ts";
import { goalSchema, motorProfileSchema, workingProgramModeSchema, skillRefSchema } from "../shared/validation.ts";
import { taskTextSchema } from "../shared/tasks.ts";
import type { AppSnapshot, RunView } from "../shared/contracts.ts";
import { promotionDeclarationSchema } from "./experience.ts";
import { improvementFeedbackCursorSchema, versionComparisonCursorSchema } from "./program-interface.ts";

if (process.env.GAMEHARNESS_LOCK_HELD !== "1")
  throw new Error(
    "Start GameHarness with bun run start or bun run dev so the local data lock is held",
  );
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const changes = new Set<() => void>();
const onChange = () => {
  for (const listener of changes) {
    try {
      listener();
    } catch {
      changes.delete(listener);
    }
  }
};
const store = new Store(DATA_DIR);
const auth = await AuthManager.create(DATA_DIR, onChange);
const performanceMonitor = new PerformanceMonitor();
const motorSettingsPath = path.join(DATA_DIR, "motor-profile.json");
let motorProfile = motorProfileSchema.parse("balanced");
try {
  motorProfile = motorProfileSchema.parse(JSON.parse(readFileSync(motorSettingsPath, "utf8")).motor_profile);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const game = new GameBridgeClient(PROJECT_ROOT, {
  onTiming: (name, milliseconds) =>
    performanceMonitor.record(name, milliseconds),
});
await game.setMotorProfile(motorProfile);
let profileUpdate: Promise<void> = Promise.resolve();
const sandbox = new SandboxService(PROJECT_ROOT, onChange);
const minecraft = new MinecraftServer(onChange, (type, summary, details) =>
  store.event(null, type, summary, details ?? null),
);
const jev = await JevBroker.create(DATA_DIR, { onChange });
const runtime = new Runtime(store, auth, game, sandbox, onChange, {
  experienceDirectory: DATA_DIR,
  judge: jev,
  adapter: () => game.adapter(),
  actorFrames: game,
});
const video = new VideoStream((milliseconds) =>
  performanceMonitor.record("video_forward_ms", milliseconds),
);
const offFrames = game.subscribeFrames((frame) => video.publish(frame));
const desktopNonce = process.env.GAMEHARNESS_READY_NONCE ?? null;
if (
  process.env.GAMEHARNESS_DESKTOP === "1" &&
  (!desktopNonce || !/^[a-f0-9]{32,64}$/.test(desktopNonce))
)
  throw new Error("The desktop backend requires its launcher instance nonce");
const sessions = new Map<string, { csrf: string; expires: number }>();
const controls = new Map<
  string,
  { fingerprint: string; result: Promise<RunView>; settled: boolean }
>();
let operationGeneration = 0;
let gameOperation: Promise<void> | null = null;
let closing = false;
let initialized = false;
let lastGameStatus = "disconnected";
let connectionAdmission: Promise<void> = Promise.resolve();

function admitConnection<T>(operation: () => Promise<T>): Promise<T> {
  const result = connectionAdmission.then(operation);
  connectionAdmission = result.then(
    () => {},
    () => {},
  );
  return result;
}

function assertGameOperation(generation: number): void {
  if (generation !== operationGeneration || closing)
    throw new Error("Game operation was cancelled");
}

game.subscribe((notice) => {
  if (notice.type === "state") {
    const state = game.snapshot();
    if (state.status !== lastGameStatus) {
      lastGameStatus = state.status;
      if (state.status === "disconnected" || state.status === "error")
        video.clear();
      store.event(null, "game.connection", `Minecraft player ${state.status}`, {
        status: state.status,
        epoch: state.epoch,
      });
    }
  }
  onChange();
});

const headers: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers });
}
function snapshot(): AppSnapshot {
  return {
    auth: auth.snapshot(),
    server: minecraft.snapshot(),
    game: game.snapshot(),
    sandbox: sandbox.snapshot(),
    run: runtime.snapshot(),
    goals: runtime.goals(),
    events: store.events(null, 0, 150),
  };
}
function cookie(request: Request, name: string): string | undefined {
  for (const entry of (request.headers.get("cookie") ?? "").split(";")) {
    const equal = entry.indexOf("=");
    if (equal > 0 && entry.slice(0, equal).trim() === name)
      return entry.slice(equal + 1).trim();
  }
  return undefined;
}
function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function requestSession(
  request: Request,
): { csrf: string; expires: number } | undefined {
  const key = cookie(request, "gh_session");
  if (!key || !/^[a-f0-9]{64}$/.test(key)) return undefined;
  const session = sessions.get(key);
  if (session && session.expires > Date.now()) return session;
  sessions.delete(key);
  return undefined;
}
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "invalid_request", "Request body must be JSON");
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      "invalid_request",
      "Request fields are invalid or exceed their allowed bounds",
    );
  return result.data;
}
function safeServiceMessage(error: unknown): string {
  if (!(error instanceof Error))
    return "The requested operation could not complete";
  const message = error.message
    .replace(/(?:Bearer\s+)[^\s]+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/https?:\/\/[^\s]+/g, "[connection address]")
    .replace(/[\r\n\x00-\x1f]/g, " ");
  return message.slice(0, 400) || "The requested operation could not complete";
}
async function stopRun(): Promise<void> {
  const current = runtime.snapshot();
  if (current && !["stopped", "completed", "failed"].includes(current.status))
    await runtime.control(current.run_id, "stop");
}
async function connectPlayer(generation: number): Promise<void> {
  const server = minecraft.snapshot();
  assertGameOperation(generation);
  if (server.status !== "running" || !server.world_id)
    throw new Error("Start the Minecraft server first");
  if (
    game.snapshot().status === "connected" &&
    game.snapshot().world_id === server.world_id
  )
    return;
  await game.connect({
    host: "127.0.0.1",
    port: server.port,
    version: MINECRAFT_VERSION,
    world_id: server.world_id,
    epoch: store.nextGameEpoch(),
    motor_profile: motorProfile,
  });
  const profileApplied = profileUpdate.then(() => game.setMotorProfile(motorProfile));
  profileUpdate = profileApplied.catch(() => {});
  await profileApplied;
  if (generation !== operationGeneration || closing) {
    await game.disconnect();
    throw new Error("Game operation was cancelled");
  }
}
function launchGameOperation(
  operation: (generation: number) => Promise<void>,
): void {
  if (gameOperation)
    throw new HttpError(
      409,
      "busy",
      "A Minecraft operation is already in progress",
    );
  const generation = ++operationGeneration;
  const pending = operation(generation)
    .catch((error) => {
      store.event(null, "game.operation_failed", safeServiceMessage(error));
    })
    .finally(() => {
      if (gameOperation === pending) gameOperation = null;
      onChange();
    });
  gameOperation = pending;
  onChange();
}

const emptyBody = z.object({}).strict();
const controlBody = z
  .object({
    command: z.enum(["start", "pause", "resume", "stop"]),
    request_id: z.string().min(1).max(128),
  })
  .strict();
const runBody = z
  .object({
    task: taskTextSchema,
    goal: goalSchema,
    model_id: z.string().min(1).max(160),
    experience_id: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    working_programs: workingProgramModeSchema.optional(),
  })
  .strict();
const comparisonVersion = skillRefSchema.extend({ run_id: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

const server = Bun.serve<VideoSocketData>({
  hostname: "127.0.0.1",
  port: APP_PORT,
  maxRequestBodySize: 64 * 1024,
  idleTimeout: 120,
  websocket: video.handlers,
  async fetch(request, httpServer) {
    try {
      const url = new URL(request.url);
      const expectedHosts = [
        `127.0.0.1:${httpServer.port}`,
        `localhost:${httpServer.port}`,
      ];
      if (!expectedHosts.includes(request.headers.get("host") ?? ""))
        throw new HttpError(
          403,
          "forbidden",
          "This service only accepts its configured local host",
        );
      const origin = request.headers.get("origin");
      if (origin && !OPERATOR_ORIGINS.includes(origin))
        throw new HttpError(
          403,
          "forbidden",
          "This request origin is not authorized",
        );
      const isApi = url.pathname.startsWith("/v1/");
      if (isApi && request.headers.get("sec-fetch-site") === "cross-site")
        throw new HttpError(
          403,
          "forbidden",
          "Cross-site API access is not allowed",
        );
      if (request.method === "GET" && url.pathname === "/v1/ready")
        return json({
          ready: initialized && !closing,
          instance: desktopNonce,
        });
      if (request.method === "GET" && url.pathname === "/v1/session") {
        let key = cookie(request, "gh_session");
        let session = requestSession(request);
        if (!key || !session) {
          if (sessions.size >= 32)
            for (const [id, candidate] of sessions)
              if (candidate.expires <= Date.now()) sessions.delete(id);
          if (sessions.size >= 32)
            throw new HttpError(429, "busy", "Too many local browser sessions");
          key = randomBytes(32).toString("hex");
          session = {
            csrf: randomBytes(32).toString("hex"),
            expires: Date.now() + 8 * 60 * 60_000,
          };
          sessions.set(key, session);
        }
        const response = json({ csrf_token: session.csrf });
        response.headers.append(
          "Set-Cookie",
          `gh_session=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        return response;
      }
      if (isApi) {
        const session = requestSession(request);
        if (!session)
          throw new HttpError(
            401,
            "unauthorized",
            "Open GameHarness in this browser to create a local session",
          );
        if (
          !["GET", "HEAD"].includes(request.method) &&
          !secureEqual(request.headers.get("x-csrf-token") ?? "", session.csrf)
        )
          throw new HttpError(
            403,
            "forbidden",
            "The local request token is missing or expired",
          );
        if (closing)
          throw new HttpError(
            503,
            "unavailable",
            "GameHarness is shutting down",
          );
        if (!initialized && request.method !== "GET")
          throw new HttpError(
            503,
            "unavailable",
            "Local services are still initializing",
          );
        if (request.method === "GET" && url.pathname === "/v1/state")
          return json(snapshot());
        if (request.method === "GET" && url.pathname === "/v1/config")
          return json({ motor_profile: motorProfile });
        if (request.method === "POST" && url.pathname === "/v1/config") {
          const input = await body(request, z.object({ motor_profile: motorProfileSchema }).strict());
          const update = profileUpdate.then(async () => {
            await game.setMotorProfile(input.motor_profile);
            try {
              const temporary = motorSettingsPath + ".tmp";
              writeFileSync(temporary, JSON.stringify(input), { mode: 0o600 });
              renameSync(temporary, motorSettingsPath);
            } catch (error) {
              await game.setMotorProfile(motorProfile);
              throw error;
            }
            motorProfile = input.motor_profile;
            onChange();
          });
          profileUpdate = update.catch(() => {});
          await update;
          return json({ motor_profile: motorProfile });
        }
        if (request.method === "POST" && url.pathname === "/v1/program-comparisons") {
          const input = await body(request, z.object({
            before: comparisonVersion, after: comparisonVersion,
            after_sample: versionComparisonCursorSchema.nullable().default(null),
            limit: z.int().min(1).max(100).default(25),
          }).strict());
          return json(await runtime.historyQueries.query({
            kind: "operator_comparison", run_id: input.before.run_id,
            before: input.before, after: input.after,
            after_sample: input.after_sample, limit: input.limit,
          }, { signal: request.signal, deadlineHostMs: performance.now() + 10_000 }));
        }
        if (request.method === "GET" && url.pathname === "/v1/performance")
          return json({
            backend: performanceMonitor.snapshot(),
            video: game.snapshot().video,
            native: game.performanceMetrics(),
            video_transport: video.snapshot(),
          });
        if (request.method === "GET" && url.pathname === "/v1/video") {
          if (
            httpServer.upgrade(request, {
              data: { expires: session.expires, lastSequence: null },
            })
          )
            return;
          throw new HttpError(
            426,
            "upgrade_required",
            "The game view requires a WebSocket connection",
          );
        }
        if (request.method === "GET" && url.pathname === "/v1/jev")
          return json(jev.status());
        if (
          (request.method === "POST" || request.method === "DELETE") &&
          url.pathname === "/v1/jev"
        ) {
          const current = runtime.snapshot();
          if (
            current &&
            !["created", "stopped", "completed", "failed"].includes(
              current.status,
            )
          )
            throw new HttpError(
              409,
              "busy",
              "Stop the current run before changing the fast-model connection",
            );
          if (request.method === "POST") {
            const input = await body(
              request,
              z.object({ key: z.string().min(1).max(8192) }).strict(),
            );
            return json(await jev.setKey(input.key));
          }
          await body(request, emptyBody);
          return json(await jev.removeKey());
        }
        if (request.method === "GET" && url.pathname === "/v1/runs")
          return json({
            runs: store.runs(50).flatMap((saved) => {
              const run = runtime.getRun(saved.run_id);
              return run ? [run] : [];
            }),
          });
        if (request.method === "GET" && url.pathname === "/v1/experience") {
          const modelId = url.searchParams.get("model_id");
          if (!modelId || modelId.length > 160)
            throw new HttpError(
              400,
              "invalid_request",
              "Choose a model before reading its compatible program library",
            );
          return json({ experience: runtime.listExperience(modelId) });
        }
        if (request.method === "GET" && url.pathname === "/v1/events") {
          const encoder = new TextEncoder();
          let dispose = () => {};
          let pump = () => {};
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              let ended = false;
              let dirty = true;
              const requested = Number(request.headers.get("last-event-id"));
              let cursor =
                request.headers.has("last-event-id") &&
                Number.isSafeInteger(requested) &&
                requested >= 0
                  ? requested
                  : store.lastEventSeq();
              pump = () => {
                if (ended || (controller.desiredSize ?? 0) <= 0) return;
                try {
                  const batch = store.eventsAfter(null, cursor, 10);
                  if (batch.length) {
                    const message = batch
                      .map(
                        (event) =>
                          `id: ${event.event_seq}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`,
                      )
                      .join("");
                    controller.enqueue(encoder.encode(message));
                    cursor = batch[batch.length - 1]!.event_seq;
                  } else if (dirty) {
                    dirty = false;
                    controller.enqueue(
                      encoder.encode("event: changed\ndata: {}\n\n"),
                    );
                  }
                } catch {
                  dispose();
                }
              };
              const off = store.subscribe(pump);
              const changed = () => {
                dirty = true;
                pump();
              };
              changes.add(changed);
              const timer = setInterval(() => {
                if (session.expires <= Date.now()) {
                  dispose();
                  return;
                }
                if (!ended && (controller.desiredSize ?? 0) > 0) {
                  try {
                    controller.enqueue(
                      encoder.encode("event: heartbeat\ndata: {}\n\n"),
                    );
                  } catch {
                    dispose();
                  }
                }
              }, 15_000);
              dispose = () => {
                if (ended) return;
                ended = true;
                clearInterval(timer);
                off();
                changes.delete(changed);
                request.signal.removeEventListener("abort", dispose);
                try {
                  controller.close();
                } catch {}
              };
              request.signal.addEventListener("abort", dispose, { once: true });
              if (request.signal.aborted) dispose();
              else pump();
            },
            pull() {
              pump();
            },
            cancel() {
              dispose();
            },
          });
          return new Response(stream, {
            headers: {
              ...headers,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
            },
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/auth/login") {
          const input = await body(
            request,
            z.object({ mode: z.enum(["browser", "device"]) }).strict(),
          );
          return json(
            await admitConnection(async () => {
              const current = runtime.snapshot();
              if (
                current &&
                !["stopped", "completed", "failed", "created"].includes(
                  current.status,
                )
              )
                throw new HttpError(
                  409,
                  "busy",
                  "Stop the current run before changing authorization",
                );
              return await auth.startLogin(input.mode);
            }),
            202,
          );
        }
        if (request.method === "POST" && url.pathname === "/v1/auth/input") {
          const input = await body(
            request,
            z
              .object({
                login_id: z.string().min(1).max(100),
                value: z.string().max(8192),
              })
              .strict(),
          );
          auth.submitInput(input.login_id, input.value);
          return json(auth.snapshot());
        }
        if (request.method === "POST" && url.pathname === "/v1/auth/cancel") {
          const input = await body(
            request,
            z.object({ login_id: z.string().min(1).max(100) }).strict(),
          );
          await auth.cancelLogin(input.login_id);
          return json(auth.snapshot());
        }
        if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
          await body(request, emptyBody);
          const stopping = stopRun();
          return json(
            await admitConnection(async () => {
              await stopping;
              await stopRun();
              await auth.logout();
              return auth.snapshot();
            }),
          );
        }
        if (request.method === "POST" && url.pathname === "/v1/auth/refresh") {
          await body(request, emptyBody);
          await auth.refreshModels();
          return json(auth.snapshot());
        }
        if (request.method === "POST" && url.pathname === "/v1/game/prepare") {
          const input = await body(
            request,
            z.object({ accept_eula: z.boolean() }).strict(),
          );
          launchGameOperation(async () => {
            await minecraft.prepare(input.accept_eula);
            if (sandbox.snapshot().status !== "ready") await sandbox.prepare();
          });
          return json({ accepted: true }, 202);
        }
        if (request.method === "POST" && url.pathname === "/v1/game/start") {
          await body(request, emptyBody);
          launchGameOperation(async (generation) => {
            await minecraft.start();
            await connectPlayer(generation);
          });
          return json({ accepted: true }, 202);
        }
        if (request.method === "POST" && url.pathname === "/v1/game/stop") {
          await body(request, emptyBody);
          ++operationGeneration;
          await stopRun();
          await game.disconnect();
          await minecraft.stop();
          return json(snapshot());
        }
        if (
          request.method === "POST" &&
          url.pathname === "/v1/game/new-world"
        ) {
          await body(request, z.object({ confirm: z.literal(true) }).strict());
          launchGameOperation(async (generation) => {
            await stopRun();
            assertGameOperation(generation);
            await game.disconnect();
            assertGameOperation(generation);
            await minecraft.newWorld();
            assertGameOperation(generation);
            await minecraft.start();
            await connectPlayer(generation);
          });
          return json({ accepted: true }, 202);
        }
        if (request.method === "POST" && url.pathname === "/v1/runs") {
          const input = await body(request, runBody);
          return json(await runtime.createRun(input), 201);
        }
        const runMatch = /^\/v1\/runs\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (request.method === "GET" && runMatch?.[1]) {
          const run = runtime.getRun(runMatch[1]);
          if (!run) throw new HttpError(404, "not_found", "Run not found");
          return json(run);
        }
        const skillEvidenceMatch =
          /^\/v1\/runs\/([a-f0-9-]{36})\/skill-evidence$/.exec(url.pathname);
        if (request.method === "GET" && skillEvidenceMatch?.[1]) {
          if (!runtime.getRun(skillEvidenceMatch[1]))
            throw new HttpError(404, "not_found", "Run not found");
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 25);
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new HttpError(400, "invalid_request", "Invalid evidence cursor or page size");
          return json(await runtime.skillEvidence(skillEvidenceMatch[1], after, limit,
            { signal: request.signal, deadlineHostMs: performance.now() + 10_000 }));
        }
        const traceMatch = /^\/v1\/runs\/([a-f0-9-]{36})\/trace$/.exec(url.pathname);
        if (request.method === "GET" && traceMatch?.[1]) {
          if (!runtime.getRun(traceMatch[1])) throw new HttpError(404, "not_found", "Run not found");
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 64);
          const executionId = url.searchParams.get("execution_id") ?? undefined;
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new HttpError(400, "invalid_request", "Invalid trace cursor or page size");
          if (executionId && !z.uuid().safeParse(executionId).success)
            throw new HttpError(400, "invalid_request", "Invalid execution identity");
          return json(await runtime.historyQueries.query({
            kind: "operator_trace", run_id: traceMatch[1], after, limit,
            ...(executionId ? { execution_id: executionId } : {}),
          }, { signal: request.signal, deadlineHostMs: performance.now() + 10_000 }));
        }
        const pinnedEvidenceMatch = /^\/v1\/runs\/([a-f0-9-]{36})\/(objective-metrics|skill-evidence)\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (request.method === "GET" && pinnedEvidenceMatch?.[1] && pinnedEvidenceMatch[3]) {
          const runId = pinnedEvidenceMatch[1], executionId = pinnedEvidenceMatch[3];
          const collection = pinnedEvidenceMatch[2] === "objective-metrics" ? "objective_metrics" : "program_evidence";
          if (!runtime.getRun(runId)) throw new HttpError(404, "not_found", "Run not found");
          if (!z.uuid().safeParse(executionId).success)
            throw new HttpError(400, "invalid_request", "Invalid execution identity");
          const keys = ["generation", "record_index", "chunk_index", "limit"];
          if ([...url.searchParams.keys()].some(key => !keys.includes(key)) ||
            keys.some(key => url.searchParams.getAll(key).length > 1))
            throw new HttpError(400, "invalid_request", "Invalid pinned evidence cursor or page size");
          const values = {
            generation: url.searchParams.get("generation"),
            record_index: url.searchParams.get("record_index") ?? "0",
            chunk_index: url.searchParams.get("chunk_index") ?? "0",
            limit: url.searchParams.get("limit") ?? "25",
          };
          if (Object.values(values).some(value => value === null || !/^(0|[1-9][0-9]*)$/.test(value)))
            throw new HttpError(400, "invalid_request", "Invalid pinned evidence cursor or page size");
          const generation = Number(values.generation), recordIndex = Number(values.record_index),
            chunkIndex = Number(values.chunk_index), limit = Number(values.limit);
          if (![generation, recordIndex, chunkIndex, limit].every(Number.isSafeInteger) || limit < 1 || limit > 100)
            throw new HttpError(400, "invalid_request", "Invalid pinned evidence cursor or page size");
          return json(await runtime.historyQueries.query({
            kind: "export_page", run_id: runId, collection, execution_id: executionId, generation,
            after: { record_index: recordIndex, chunk_index: chunkIndex }, limit,
          }, { signal: request.signal, deadlineHostMs: performance.now() + 10_000 }));
        }
        const improvementMatch = /^\/v1\/runs\/([a-f0-9-]{36})\/improvements$/.exec(url.pathname);
        if (request.method === "GET" && improvementMatch?.[1]) {
          if (!runtime.getRun(improvementMatch[1])) throw new HttpError(404, "not_found", "Run not found");
          if ([...url.searchParams.keys()].some(key => key !== "after" && key !== "limit") ||
            url.searchParams.getAll("after").length > 1 || url.searchParams.getAll("limit").length > 1)
            throw new HttpError(400, "invalid_request", "Invalid feedback cursor or page size");
          let after: z.infer<typeof improvementFeedbackCursorSchema>;
          try {
            after = improvementFeedbackCursorSchema.parse(url.searchParams.has("after")
              ? JSON.parse(url.searchParams.get("after")!)
              : { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null });
          } catch {
            throw new HttpError(400, "invalid_request", "Invalid feedback cursor or page size");
          }
          const limitValue = url.searchParams.get("limit");
          if (limitValue !== null && !/^[1-9][0-9]*$/.test(limitValue))
            throw new HttpError(400, "invalid_request", "Invalid feedback cursor or page size");
          const limit = Number(limitValue ?? 32);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw new HttpError(400, "invalid_request", "Invalid feedback cursor or page size");
          return json(await runtime.historyQueries.query({
            kind: "operator_feedback", run_id: improvementMatch[1],
            after, limit,
          }, { signal: request.signal, deadlineHostMs: performance.now() + 10_000 }));
        }
        const deathsMatch = /^\/v1\/runs\/([a-f0-9-]{36})\/deaths$/.exec(url.pathname);
        if (request.method === "GET" && deathsMatch?.[1]) {
          if (!runtime.getRun(deathsMatch[1])) throw new HttpError(404, "not_found", "Run not found");
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 32);
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new HttpError(400, "invalid_request", "Invalid death cursor or page size");
          return json(await runtime.historyQueries.query({
            kind: "operator_deaths", run_id: deathsMatch[1], after, limit,
          }, { signal: request.signal, deadlineHostMs: performance.now() + 10_000 }));
        }
        const planningMatch = /^\/v1\/runs\/([a-f0-9-]{36})\/planning$/.exec(url.pathname);
        if (request.method === "GET" && planningMatch?.[1])
          return json({ plan: runtime.planningView(planningMatch[1]) });
        const eventsMatch = /^\/v1\/runs\/([a-f0-9-]{36})\/events$/.exec(
          url.pathname,
        );
        if (request.method === "GET" && eventsMatch?.[1]) {
          const runId = eventsMatch[1];
          if (!runtime.getRun(runId))
            throw new HttpError(404, "not_found", "Run not found");
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 50);
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 50
          )
            throw new HttpError(
              400,
              "invalid_request",
              "Invalid event cursor or page size",
            );
          const candidates = store.eventsAfter(runId, after, limit + 1);
          const events = [];
          const omittedDetails: number[] = [];
          let bytes = 256;
          let cursor = after;
          for (const candidate of candidates.slice(0, limit)) {
            let event = candidate;
            let size = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
            if (bytes + size > 64 * 1024) {
              if (events.length) break;
              event = { ...candidate, details: null };
              size = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
              if (bytes + size > 64 * 1024)
                throw new HttpError(
                  413,
                  "record_too_large",
                  "The retained event summary exceeds the page limit",
                );
              omittedDetails.push(candidate.event_seq);
            }
            events.push(event);
            bytes += size;
            cursor = candidate.event_seq;
          }
          return json({
            events,
            next_cursor: cursor,
            has_more: candidates.some((event) => event.event_seq > cursor),
            omitted_details: omittedDetails,
          });
        }
        const experienceMatch =
          /^\/v1\/runs\/([a-f0-9-]{36})\/experience$/.exec(url.pathname);
        if (request.method === "POST" && experienceMatch?.[1]) {
          const input = await body(
            request,
            z
              .object({
                execution_id: z.uuid(),
                name: z.string().trim().min(1).max(100),
                declaration: promotionDeclarationSchema,
              })
              .strict(),
          );
          return json(
            runtime.promoteExperience(
              experienceMatch[1],
              input.execution_id,
              input.name,
              input.declaration,
            ),
            201,
          );
        }
        const controlMatch = /^\/v1\/runs\/([a-f0-9-]{36})\/controls$/.exec(
          url.pathname,
        );
        if (request.method === "POST" && controlMatch?.[1]) {
          const input = await body(request, controlBody),
            runId = controlMatch[1];
          const key = `${runId}:${input.request_id}`,
            fingerprint = input.command;
          const existing = controls.get(key);
          if (existing) {
            if (existing.fingerprint !== fingerprint)
              throw new HttpError(
                409,
                "conflict",
                "Control request ID has different content",
              );
            return json(await existing.result);
          }
          if (controls.size >= 1024) {
            for (const [id, entry] of controls) {
              if (entry.settled) {
                controls.delete(id);
                break;
              }
            }
            if (controls.size >= 1024)
              throw new HttpError(
                429,
                "busy",
                "Too many pending control requests",
              );
          }
          const operation = async () => {
            if (input.command === "resume") {
              const current = runtime.snapshot();
              if (current?.run_id !== runId || current.status !== "paused")
                throw new HttpError(
                  409,
                  "conflict",
                  "Only the current paused run can be resumed",
                );
              if (game.snapshot().status !== "connected")
                await connectPlayer(operationGeneration);
            }
            return await runtime.control(runId, input.command);
          };
          const result =
            input.command === "start" || input.command === "resume"
              ? admitConnection(operation)
              : operation();
          const entry = { fingerprint, result, settled: false };
          controls.set(key, entry);
          void result.then(
            () => {
              entry.settled = true;
            },
            () => {
              entry.settled = true;
            },
          );
          return json(await result);
        }
        throw new HttpError(404, "not_found", "API route not found");
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new HttpError(405, "method_not_allowed", "Method not allowed");
      const relative =
        decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const webRoot = path.join(PROJECT_ROOT, "dist/web");
      const target = path.resolve(webRoot, relative);
      if (!target.startsWith(webRoot + path.sep) || relative.includes("\0"))
        throw new HttpError(404, "not_found", "File not found");
      const file = Bun.file(target);
      if (!(await file.exists())) {
        if (relative === "index.html")
          return new Response(
            "Build the browser UI with bun run build, then reload.",
            { status: 503, headers },
          );
        throw new HttpError(404, "not_found", "File not found");
      }
      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          ...headers,
          "Content-Type": file.type,
          "Cache-Control": relative.startsWith("assets/")
            ? "private, max-age=86400"
            : "no-store",
        },
      });
    } catch (error) {
      if (error instanceof HttpError)
        return json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      return json(
        {
          error: {
            code: "operation_failed",
            message: safeServiceMessage(error),
          },
        },
        409,
      );
    }
  },
});
setListeningPort(server.port!);

let shutdown: Promise<void> | null = null;
async function closeApplication(): Promise<void> {
  if (shutdown) return shutdown;
  closing = true;
  ++operationGeneration;
  shutdown = (async () => {
    const cleanup = await Promise.allSettled([
      runtime.close(),
      auth.close(),
      jev.close(),
    ]);
    for (const close of [
      () => game.close(),
      () => minecraft.close(),
      () => sandbox.close(),
      async () => {
        if (gameOperation) await gameOperation;
      },
    ]) {
      try {
        await close();
      } catch (reason) {
        cleanup.push({ status: "rejected", reason });
      }
    }
    if (cleanup.some((result) => result.status === "rejected")) {
      store.event(
        null,
        "application.shutdown_pending",
        "Shutdown is not confirmed. Admission remains closed; retry closing after resolving the local service failure.",
      );
      onChange();
      throw new Error("Local process cleanup is not confirmed");
    }
    offFrames();
    video.close();
    performanceMonitor.close();
    server.stop(true);
    sessions.clear();
    controls.clear();
    changes.clear();
    store.close();
  })();
  void shutdown.catch(() => {
    shutdown = null;
  });
  return shutdown;
}
function requestApplicationClose(): void {
  void closeApplication().then(
    () => process.exit(0),
    () =>
      console.error(
        "GameHarness cleanup is unconfirmed; admission is closed. Resolve the local service failure and retry closing.",
      ),
  );
}
process.on("SIGINT", requestApplicationClose);
process.on("SIGTERM", requestApplicationClose);
if (process.env.GAMEHARNESS_DESKTOP === "1") {
  process.stdin.once("end", requestApplicationClose);
  process.stdin.once("error", requestApplicationClose);
  process.stdin.resume();
}

console.log(`GameHarness listening at ${APP_ORIGIN}`);
try {
  await minecraft.initialize();
  await runtime.initialize();
  await sandbox.prepare();
  initialized = true;
  store.event(null, "application.ready", "Local services initialized", {
    sandbox: sandbox.snapshot().status,
    server: minecraft.snapshot().status,
  });
  onChange();
} catch {
  store.event(
    null,
    "application.error",
    "Local service initialization failed. Restart after resolving Docker or storage readiness.",
  );
  initialized = true;
  onChange();
}
if (desktopNonce)
  console.log(
    `GAMEHARNESS_READY ${JSON.stringify({
      nonce: desktopNonce,
      origin: APP_ORIGIN,
    })}`,
  );
