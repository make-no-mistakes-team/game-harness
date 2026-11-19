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
import { goalSchema, motorProfileSchema, workingProgramModeSchema } from "../shared/validation.ts";
import { taskTextSchema } from "../shared/tasks.ts";
import { promotionDeclarationSchema } from "./experience.ts";
import { PreparedStart, type PreparedWorldLaunch } from "./prepared-start.ts";
import { preparedStartRequestSchema } from "../shared/prepared-start.ts";
import { OperatorPublication } from "./operator-publication.ts";
import { PublicationUnavailable, isPublicationRoute } from "./operator-publication-protocol.ts";
import { SURVIVAL_PILOT_GOALS } from "../shared/survival-pilot-ui.ts";
import { PilotRequestFault, SurvivalPilot } from "./survival-pilot.ts";

export class OperatorChangeBus {
  readonly listeners = new Set<() => void>();
  readonly notify = () => {
    for (const listener of this.listeners) {
      try { listener(); } catch { this.listeners.delete(listener); }
    }
  };
}

export interface OperatorApplicationOwners {
  directory: string;
  projectRoot: string;
  port: number;
  changes: OperatorChangeBus;
  store: Store;
  auth: AuthManager;
  game: GameBridgeClient;
  minecraft: MinecraftServer;
  sandbox: SandboxService;
  jev: JevBroker;
  runtime: Runtime;
  performanceMonitor: PerformanceMonitor;
  desktopNonce?: string | null;
}

type ConstructionCleanup = () => void | Promise<void>;

async function rejectConstruction(error: unknown, cleanup: ConstructionCleanup[]): Promise<never> {
  const failures: unknown[] = [error];
  for (const close of cleanup.reverse()) {
    try { await close(); } catch (failure) { failures.push(failure); }
  }
  if (failures.length > 1)
    throw new AggregateError(failures, "Application construction failed and resource closure is unconfirmed");
  throw error;
}

/** Ownership transfers on fulfillment only. Rejection drains local owners;
 * injected services remain the caller's responsibility until transfer. */
export async function createOperatorApplication(owners: OperatorApplicationOwners) {
  const construction: ConstructionCleanup[] = [];
  try {
    const { directory, projectRoot, store, auth, game, minecraft, sandbox, jev, runtime, performanceMonitor } = owners;
    const changes = owners.changes.listeners;
    const onChange = owners.changes.notify;
    const developmentOrigins = new Set(OPERATOR_ORIGINS.slice(2));
    const motorSettingsPath = path.join(directory, "motor-profile.json");
    let motorProfile = motorProfileSchema.parse("balanced");
    try {
      motorProfile = motorProfileSchema.parse(JSON.parse(readFileSync(motorSettingsPath, "utf8")).motor_profile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let profileUpdate: Promise<void> = Promise.resolve();
    const preparedStart = new PreparedStart({
      directory, auth, sandbox, runtime, changed: onChange,
      state: () => ({ game: game.snapshot(), server: minecraft.snapshot(), sandbox: sandbox.snapshot(), run: runtime.snapshot() }),
      getContract: () => game.prepareExecutableContract(),
      launch: () => beginPreparedWorld(),
      record: (type, summary, details) => { store.event(null, type, summary, details); },
    });
    construction.push(() => preparedStart.close());
    const survivalPilot = new SurvivalPilot(projectRoot, directory);
    construction.push(() => survivalPilot.close());
    const video = new VideoStream((milliseconds) =>
      performanceMonitor.record("video_forward_ms", milliseconds),
    );
    construction.push(() => video.close());
    // Retain only immutable presentation transport here: VideoStream holds the
    // latest packet, skips buffered sockets, and admits at most four viewers.
    const offFrames = game.subscribeFrames((frame) => video.publish(frame));
    construction.push(offFrames);
    const desktopNonce = owners.desktopNonce === undefined ? process.env.GAMEHARNESS_READY_NONCE ?? null : owners.desktopNonce;
    if (
      process.env.GAMEHARNESS_DESKTOP === "1" &&
      (!desktopNonce || !/^[a-f0-9]{32,64}$/.test(desktopNonce))
    )
      throw new Error("The desktop backend requires its launcher instance nonce");
    const sessions = new Map<string, { csrf: string; expires: number }>();
    const controls = new Map<
      string,
      { fingerprint: string; result: Promise<void>; settled: boolean }
    >();
    let operationGeneration = 0;
    let gameOperation: Promise<void> | null = null;
    let closing = false;
    let initialized = false;
    let initialization: Promise<void> | null = null;
    let lastGameStatus = "disconnected";
    let connectionAdmission: Promise<void> = Promise.resolve();
    let pendingModelAdmissions = 0;
    let pendingWorldStops = 0;

    function admitConnection<T>(operation: () => Promise<T>): Promise<T> {
      const result = connectionAdmission.then(operation);
      connectionAdmission = result.then(
        () => {},
        () => {},
      );
      return result;
    }

    function assertNoSurvivalPilot(): void {
      if (closing) throw new HttpError(503, "unavailable", "GameHarness is shutting down");
      if (survivalPilot.busy())
        throw new HttpError(409, "busy", "Stop Survival Pilot before starting a model-guided world or run");
    }

    function admitModelConnection<T>(operation: () => Promise<T>): Promise<T> {
      assertNoSurvivalPilot();
      pendingModelAdmissions++;
      const admitted = async () => {
        try { return await operation(); } finally { pendingModelAdmissions--; }
      };
      return admitted();
    }

    function assertLegacyWorldIdle(): void {
      const model = runtime.snapshot();
      if (gameOperation || pendingModelAdmissions || pendingWorldStops || preparedStart.active() ||
          ["preparing", "starting", "running"].includes(minecraft.snapshot().status) ||
          ["connecting", "connected"].includes(game.snapshot().status) ||
          model && (!["created", "stopped", "completed", "failed"].includes(model.status) || model.operator.cleanup_error))
        throw new HttpError(409, "busy", "Stop the model run and its Minecraft world before starting Survival Pilot");
    }

    function assertGameOperation(generation: number): void {
      if (generation !== operationGeneration || closing)
        throw new Error("Game operation was cancelled");
    }

    const offGame = game.subscribe((notice) => {
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
    construction.push(offGame);

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
    const publication = new OperatorPublication(store.readLocation(), path.join(directory, "experience.sqlite"), () => {
      const goals = runtime.goals();
      return {
        services: {
          auth: auth.snapshot(), server: minecraft.snapshot(), game: game.snapshot(),
          sandbox: sandbox.snapshot(), prepared_start: preparedStart.snapshot(),
          goals: goals.length ? goals : preparedStart.goals(),
        },
        runtime: runtime.publicationSeed(),
      };
    });
    construction.push(() => publication.close());
    const notifyPublication = () => publication.notify();
    changes.add(notifyPublication);
    construction.push(() => { changes.delete(notifyPublication); });
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
      const runId = runtime.currentRunId();
      if (runId) await runtime.control(runId, "stop");
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
      assertNoSurvivalPilot();
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
    function assertNoPreparationMutation(): void {
      if (preparedStart.active())
        throw new HttpError(409, "busy", "Cancel prepared startup before changing its model, task or native configuration");
    }
    /** Reserve before scheduling: cancellation owns this exact startup, never a previously connected world. */
    function beginPreparedWorld(): PreparedWorldLaunch {
      assertNoSurvivalPilot();
      if (gameOperation || game.snapshot().status !== "disconnected" || minecraft.snapshot().status !== "stopped")
        throw new HttpError(409, "busy", "A new prepared startup requires an idle disconnected world");
      const generation = ++operationGeneration;
      const ready = Promise.resolve().then(async () => {
        assertGameOperation(generation);
        await minecraft.start();
        assertGameOperation(generation);
        await connectPlayer(generation);
      }).finally(() => {
        if (gameOperation === ready) gameOperation = null;
        onChange();
      });
      void ready.catch(() => {});
      gameOperation = ready;
      let closingLaunch: Promise<void> | null = null;
      return { ready, close() {
        if (closingLaunch) return closingLaunch;
        if (generation === operationGeneration) ++operationGeneration;
        // Before transfer there is no effectful root. Abort pending native startup
        // without waiting for its joined-readiness promise, then join every owner.
        closingLaunch = (async () => {
          const settled = await Promise.allSettled([stopRun(), game.disconnect(), minecraft.stop(), ready.catch(() => {})]);
          const failed = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Prepared native startup cleanup is unconfirmed");
        })();
        return closingLaunch;
      } };
    }

    const emptyBody = z.object({}).strict();
    const survivalPilotBody = z.object({ goal: z.enum(SURVIVAL_PILOT_GOALS) }).strict();
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
        control_mode: z.enum(["executive", "legacy"]).default("executive"),
      })
      .strict();
    const server = Bun.serve<VideoSocketData>({
      hostname: "127.0.0.1",
      port: owners.port,
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
          if (origin && !expectedHosts.some(host => origin === `http://${host}`) && !developmentOrigins.has(origin))
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
            const publish = (target?: string) => publication.response(
              request, session.expires,
              () => !closing && requestSession(request) === session,
              headers, target,
            );
            if (isPublicationRoute(request.method, url.pathname))
              return await publish();
            if (url.pathname === "/v1/survival-pilot" || url.pathname.startsWith("/v1/survival-pilot/")) {
              const site = request.headers.get("sec-fetch-site");
              if (origin && origin !== `http://${request.headers.get("host")}` ||
                  site && !["same-origin", "none"].includes(site))
                throw new HttpError(403, "forbidden", "Survival Pilot requires a same-origin request");
              if (request.method === "GET" && url.pathname === "/v1/survival-pilot")
                return json(survivalPilot.snapshot());
              if (request.method === "POST" && url.pathname === "/v1/survival-pilot/start") {
                const { goal } = await body(request, survivalPilotBody);
                assertLegacyWorldIdle();
                return json(survivalPilot.start(goal), 202);
              }
              if (request.method === "POST" && url.pathname === "/v1/survival-pilot/stop") {
                await body(request, emptyBody);
                const state = survivalPilot.stop();
                return json(state, state.phase === "stopping" ? 202 : 200);
              }
              if (request.method === "GET" && url.pathname === "/v1/survival-pilot/video") {
                const query = url.searchParams;
                if ([...query.keys()].some((key) => key !== "run") || query.getAll("run").length > 1)
                  throw new HttpError(400, "invalid_request", "The video request accepts one run identifier");
                const response = survivalPilot.video(request, session.expires, query.get("run"), headers);
                httpServer.timeout(request, 0);
                return response;
              }
              throw new HttpError(404, "not_found", "API route not found");
            }
            if (request.method === "GET" && url.pathname === "/v1/config")
              return json({ motor_profile: motorProfile });
            if (request.method === "POST" && url.pathname === "/v1/config") {
              assertNoPreparationMutation();
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
              if (game.snapshot().status === "disconnected") await preparedStart.refreshContract();
              return json({ motor_profile: motorProfile });
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
            if (request.method === "POST" && url.pathname === "/v1/auth/login") {
              assertNoPreparationMutation();
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
              const cancelling = preparedStart.cancelCurrent();
              const stopping = stopRun();
              return json(
                await admitConnection(async () => {
                  const drained = await Promise.allSettled([cancelling, stopping]);
                  await stopRun();
                  await auth.logout();
                  if (drained.some(result => result.status === "rejected"))
                    throw new Error("Model account disconnected, but prepared startup cleanup remains unconfirmed");
                  return auth.snapshot();
                }),
              );
            }
            if (request.method === "POST" && url.pathname === "/v1/auth/refresh") {
              assertNoPreparationMutation();
              await body(request, emptyBody);
              await auth.refreshModels();
              return json(auth.snapshot());
            }
            if (request.method === "POST" && url.pathname === "/v1/game/prepare") {
              assertNoPreparationMutation();
              const input = await body(
                request,
                z.object({ accept_eula: z.boolean() }).strict(),
              );
              launchGameOperation(async () => {
                await minecraft.prepare(input.accept_eula);
                if (sandbox.snapshot().status !== "ready") await sandbox.prepare();
                await preparedStart.refreshContract();
              });
              return json({ accepted: true }, 202);
            }
            if (request.method === "POST" && url.pathname === "/v1/game/start") {
              assertNoPreparationMutation();
              await body(request, emptyBody);
              launchGameOperation(async (generation) => {
                await minecraft.start();
                await connectPlayer(generation);
              });
              return json({ accepted: true }, 202);
            }
            if (request.method === "POST" && url.pathname === "/v1/game/stop") {
              await body(request, emptyBody);
              pendingWorldStops++;
              try {
                ++operationGeneration;
                const cleanup = await Promise.allSettled([preparedStart.cancelCurrent(), stopRun()]);
                for (const close of [() => game.disconnect(), () => minecraft.stop()])
                  try { await close(); } catch (reason) { cleanup.push({ status: "rejected", reason }); }
                if (cleanup.some(result => result.status === "rejected"))
                  throw new Error("World closure is not confirmed; inspect retained startup and run cleanup");
              } finally { pendingWorldStops--; }
              return await publication.response(
                new Request(new URL("/v1/state", request.url), { signal: request.signal }),
                session.expires, () => !closing && requestSession(request) === session, headers,
              );
            }
            if (
              request.method === "POST" &&
              url.pathname === "/v1/game/new-world"
            ) {
              assertNoPreparationMutation();
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
              assertNoPreparationMutation();
              const input = await body(request, runBody);
              return json(await admitModelConnection(() => runtime.createRun(input)), 201);
            }
            if (request.method === "POST" && url.pathname === "/v1/prepared-start") {
              const input = await body(request, preparedStartRequestSchema);
              return json(await admitModelConnection(() => preparedStart.start(input)), 202);
            }
            const preparedCancel = /^\/v1\/prepared-start\/([a-f0-9-]{36})\/cancel$/.exec(url.pathname);
            if (request.method === "POST" && preparedCancel?.[1]) {
              await body(request, emptyBody);
              return json(await preparedStart.cancel(preparedCancel[1]));
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
              if (input.command === "start" || input.command === "resume") assertNoPreparationMutation();
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
                await existing.result;
                return await publication.response(
                  new Request(new URL(`/v1/runs/${runId}`, request.url), { signal: request.signal }),
                  session.expires, () => !closing && requestSession(request) === session, headers,
                );
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
                  ? admitModelConnection(() => admitConnection(operation))
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
              await result;
              return await publication.response(
                new Request(new URL(`/v1/runs/${runId}`, request.url), { signal: request.signal }),
                session.expires, () => !closing && requestSession(request) === session, headers,
              );
            }
            throw new HttpError(404, "not_found", "API route not found");
          }
          if (request.method !== "GET" && request.method !== "HEAD")
            throw new HttpError(405, "method_not_allowed", "Method not allowed");
          const relative =
            decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
          const webRoot = path.join(projectRoot, "dist/web");
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
          if (error instanceof PublicationUnavailable)
            return json({ error: { code: "publication_unavailable", message: error.message } }, error.status);
          if (error instanceof HttpError || error instanceof PilotRequestFault)
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
    construction.push(() => server.stop(true));
    let shutdown: Promise<void> | null = null;
    async function closeApplication(): Promise<void> {
      if (shutdown) return shutdown;
      closing = true;
      ++operationGeneration;
      changes.delete(notifyPublication);
      offGame();
      offFrames();
      shutdown = (async () => {
        const cleanup = await Promise.allSettled([
          survivalPilot.close(),
          preparedStart.close(),
          runtime.close(),
          auth.close(),
          jev.close(),
          publication.close(),
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
        if (initialization) {
          try { await initialization; } catch (reason) { cleanup.push({ status: "rejected", reason }); }
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
        video.close();
        performanceMonitor.close();
        await server.stop(true);
        sessions.clear();
        controls.clear();
        store.close();
      })();
      void shutdown.catch(() => {
        shutdown = null;
      });
      return shutdown;
    }
    function initialize(): Promise<void> {
      if (initialization) return initialization;
      if (closing) return Promise.reject(new Error("Application initialization was cancelled"));
      initialization = (async () => {
        try {
          await game.setMotorProfile(motorProfile);
          if (closing) return;
          await minecraft.initialize();
          if (closing) return;
          await runtime.initialize();
          if (closing) return;
          await sandbox.prepare();
          if (closing) return;
          await preparedStart.initialize();
          if (closing) return;
          initialized = true;
          store.event(null, "application.ready", "Local services initialized", {
            sandbox: sandbox.snapshot().status,
            server: minecraft.snapshot().status,
          });
          onChange();
        } catch {
          if (closing) return;
          store.event(
            null,
            "application.error",
            "Local service initialization failed. Restart after resolving Docker or storage readiness.",
          );
          initialized = true;
          onChange();
        }
      })();
      return initialization;
    }
    return { server, publication, initialize, close: closeApplication };
  } catch (error) {
    return await rejectConstruction(error, construction);
  }
}

export interface OperatorApplicationLocation {
  directory: string;
  projectRoot: string;
  port: number;
  desktopNonce?: string | null;
}

/** Constructs the concrete default owners without starting a native world. */
export async function createDefaultOperatorApplication(location: OperatorApplicationLocation) {
  const construction: ConstructionCleanup[] = [];
  try {
    const { directory, projectRoot, port, desktopNonce } = location;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const changes = new OperatorChangeBus();
    const onChange = changes.notify;
    const store = new Store(directory);
    construction.push(() => store.close());
    const auth = await AuthManager.create(directory, onChange);
    construction.push(() => auth.close());
    const performanceMonitor = new PerformanceMonitor();
    construction.push(() => performanceMonitor.close());
    const game = new GameBridgeClient(projectRoot, {
      onTiming: (name, milliseconds) => performanceMonitor.record(name, milliseconds),
    });
    construction.push(() => game.close());
    const sandbox = new SandboxService(projectRoot, onChange);
    construction.push(() => sandbox.close());
    const minecraft = new MinecraftServer(onChange, (type, summary, details) => store.event(null, type, summary, details ?? null));
    construction.push(() => minecraft.close());
    const jev = await JevBroker.create(directory, { onChange });
    construction.push(() => jev.close());
    const runtime = new Runtime(store, auth, game, sandbox, onChange, {
      experienceDirectory: directory, judge: jev, adapter: () => game.adapter(), actorFrames: game,
    });
    construction.push(() => runtime.close());
    return await createOperatorApplication({ directory, projectRoot, port, desktopNonce,
      changes, store, auth, game, minecraft, sandbox, jev, runtime, performanceMonitor });
  } catch (error) {
    return await rejectConstruction(error, construction);
  }
}

async function startApplication(): Promise<void> {
  if (process.env.GAMEHARNESS_LOCK_HELD !== "1")
    throw new Error("Start GameHarness with bun run start or bun run dev so the local data lock is held");
  const application = await createDefaultOperatorApplication({ directory: DATA_DIR, projectRoot: PROJECT_ROOT, port: APP_PORT });
  const construction: ConstructionCleanup[] = [() => application.close()];
  try {
    setListeningPort(application.server.port!);
    const requestApplicationClose = () => {
      void application.close().then(() => process.exit(0), () =>
        console.error("GameHarness cleanup is unconfirmed; admission is closed. Resolve the local service failure and retry closing."));
    };
    process.on("SIGINT", requestApplicationClose);
    construction.push(() => { process.off("SIGINT", requestApplicationClose); });
    process.on("SIGTERM", requestApplicationClose);
    construction.push(() => { process.off("SIGTERM", requestApplicationClose); });
    if (process.env.GAMEHARNESS_DESKTOP === "1") {
      process.stdin.once("end", requestApplicationClose);
      construction.push(() => { process.stdin.off("end", requestApplicationClose); });
      process.stdin.once("error", requestApplicationClose);
      construction.push(() => { process.stdin.off("error", requestApplicationClose); });
      process.stdin.resume();
    }
    console.log(`GameHarness listening at ${APP_ORIGIN}`);
    await application.initialize();
    const desktopNonce = process.env.GAMEHARNESS_READY_NONCE ?? null;
    if (desktopNonce) console.log(`GAMEHARNESS_READY ${JSON.stringify({ nonce: desktopNonce, origin: APP_ORIGIN })}`);
  } catch (error) {
    await rejectConstruction(error, construction);
  }
}
if (import.meta.main) await startApplication();
