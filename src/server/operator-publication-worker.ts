import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppSnapshot, RunView } from "../shared/contracts.ts";
import type { ExperienceView } from "./experience.ts";
import { sameProgramCompatibility } from "./adapter-contract.ts";
import { ReadonlyStore } from "./store-read.ts";
import { projectRunOperator } from "./operator-state.ts";
import { dispatchHistoryQuery } from "./history-dispatch.ts";
import { improvementFeedbackCursorSchema, versionComparisonCursorSchema } from "./program-interface.ts";
import { skillRefSchema } from "../shared/validation.ts";
import { PUBLICATION_LIMITS, isPublicationRoute, type PublicationBootstrap, type PublicationSeed } from "./operator-publication-protocol.ts";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const comparisonVersion = skillRefSchema.extend({ run_id: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const comparisonBody = z.object({ before: comparisonVersion, after: comparisonVersion,
  after_sample: versionComparisonCursorSchema.nullable().default(null), limit: z.int().min(1).max(100).default(25) }).strict();
const bootstrapSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), instance: z.string().regex(/^[a-f0-9]{64}$/),
  location: z.object({ database: z.string().min(1), artifacts: z.string().min(1), projection: z.string().min(1).optional() }).strict(), experience: z.string().min(1) }).strict();

/** This process has no writable canonical Store, AuthManager, Runtime or effect port. */
export function createPublicationServer(bootstrap: PublicationBootstrap) {
  const store = new ReadonlyStore(bootstrap.location);
  const experience = new Database(bootstrap.experience, { readonly: true, create: false, strict: true });
  let seed: PublicationSeed | null = null;
  let closed = false;
  const streams = new Set<{ changed(): void; pump(): void; close(): void }>();
  const encoder = new TextEncoder();
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  const runView = (id: string): RunView | null => {
    const run = store.getRun(id);
    if (!run) {
      if (seed?.runtime.run_id === id)
        throw new HttpError(503, "publication_pending", "Current run metadata is not yet visible");
      return null;
    }
    const { baseline: _baseline, control: _control, ...view } = run;
    const current = seed?.runtime.run_id === id ? seed.runtime : null;
    const action = current?.action ?? null;
    let policies = store.policies(id);
    if (current) {
      const retained = new Map(policies.map(policy => [`${policy.policy_id}:${policy.version}`, policy]));
      policies = current.policy_order.map(item => {
        const key = `${item.policy_id}:${item.version}`, policy = retained.get(key);
        if (!policy) throw new HttpError(503, "publication_pending", "Current policy metadata is not yet visible");
        retained.delete(key);
        return { ...policy, last_error: item.last_error };
      });
      // The durable database may advance after the last live cut. Do not truncate
      // records or present a mixed stale live overlay as current authority.
      if (retained.size) throw new HttpError(503, "publication_pending", "Current policy publication is pending");
    }
    const executions = store.skillExecutions(id);
    return { ...view, action, policies, skills: store.skills(id), executions,
      operator: projectRunOperator(store, run, action, executions, current?.recovering ?? false) };
  };
  const requireRun = (id: string) => {
    if (!store.getRun(id)) throw new HttpError(404, "not_found", "Run not found");
  };
  const page = (url: URL, maximum: number, defaultLimit: number) => {
    const after = Number(url.searchParams.get("after") ?? 0), limit = Number(url.searchParams.get("limit") ?? defaultLimit);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > maximum)
      throw new HttpError(400, "invalid_request", "Invalid cursor or page size");
    return { after, limit };
  };

  function events(request: Request, expires: number) {
    if (streams.size >= PUBLICATION_LIMITS.eventStreams) throw new HttpError(429, "busy", "Too many activity streams");
    const requested = Number(request.headers.get("last-event-id"));
    let cursor = request.headers.has("last-event-id") && Number.isSafeInteger(requested) && requested >= 0 ? requested : store.lastEventSeq();
    let dirty = true, ended = false, lastSent = Date.now();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const owner = {
      changed() { dirty = true; owner.pump(); },
      pump() {
        if (ended) return;
        if (Date.now() >= expires || closed) { owner.close(); return; }
        if ((controller.desiredSize ?? 0) <= 0) return;
        try {
          const batch = store.eventsAfter(null, cursor, 10);
          if (batch.length) {
            const message = batch.map(event => `id: ${event.event_seq}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`).join("");
            controller.enqueue(encoder.encode(message));
            cursor = batch.at(-1)!.event_seq;
            lastSent = Date.now();
          } else if (dirty) {
            dirty = false;
            controller.enqueue(encoder.encode("event: changed\ndata: {}\n\n"));
            lastSent = Date.now();
          } else if (Date.now() - lastSent >= PUBLICATION_LIMITS.heartbeatMs) {
            controller.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n"));
            lastSent = Date.now();
          }
        } catch { owner.close(); }
      },
      close() {
        if (ended) return;
        ended = true; streams.delete(owner);
        request.signal.removeEventListener("abort", owner.close);
        try { controller.close(); } catch {}
      },
    };
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value; streams.add(owner);
        request.signal.addEventListener("abort", owner.close, { once: true });
        if (request.signal.aborted) owner.close(); else owner.pump();
      },
      pull() { owner.pump(); },
      cancel() { owner.close(); },
    }, { highWaterMark: 1 });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: PUBLICATION_LIMITS.seedBytes, idleTimeout: 120,
    async fetch(request, http) {
      try {
        const url = new URL(request.url);
        const actual = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${bootstrap.token}`);
        if (request.headers.get("host") !== `127.0.0.1:${http.port}` || request.headers.has("origin") ||
          request.headers.get("x-publication-instance") !== bootstrap.instance || actual.length !== expected.length || !timingSafeEqual(actual, expected))
          throw new HttpError(403, "forbidden", "Private publication access denied");
        if (closed) throw new HttpError(503, "unavailable", "Operator publication is closing");
        if (request.method === "POST" && url.pathname === "/private/seed") {
          const value: PublicationSeed = await request.json();
          if (!value || !Number.isSafeInteger(value.sequence) || value.sequence <= (seed?.sequence ?? 0) ||
            !value.services || !value.runtime || !Array.isArray(value.runtime.policy_order))
            throw new HttpError(400, "invalid_request", "Invalid publication seed");
          seed = value;
          for (const stream of streams) stream.changed();
          return new Response(null, { status: 204 });
        }
        if (!isPublicationRoute(request.method, url.pathname)) throw new HttpError(404, "not_found", "Publication route not found");
        const expires = Number(request.headers.get("x-publication-expires"));
        if (!Number.isSafeInteger(expires) || expires <= Date.now()) throw new HttpError(401, "unauthorized", "The local session expired");
        if (!seed) throw new HttpError(503, "publication_pending", "Current operator state is not yet available");
        if (url.pathname === "/v1/events") return events(request, expires);
        if (url.pathname === "/v1/state") return store.snapshot(() => json({ ...seed!.services,
          run: seed!.runtime.run_id ? runView(seed!.runtime.run_id) : null, events: store.events(null, 0, 150) } satisfies AppSnapshot));
        if (url.pathname === "/v1/runs") return store.snapshot(() => json({ runs: store.runs(50).map(run => runView(run.run_id)!) }));
        if (url.pathname === "/v1/experience") {
          const modelId = url.searchParams.get("model_id");
          if (!modelId || modelId.length > 160) throw new HttpError(400, "invalid_request", "Choose a model before reading its compatible program library");
          const binding = seed.services.game.binding;
          const current = binding?.ready ? { descriptor: binding.descriptor, compatibility_hash: binding.compatibility_hash } : null;
          const views = experience.query<{ payload: string }, [string]>("SELECT payload FROM bundles WHERE model=? ORDER BY rowid DESC LIMIT 100").all(modelId)
            .map(row => { const { skills: _skills, ...view } = JSON.parse(row.payload) as ExperienceView & { skills: unknown[] }; return view; })
            .filter(view => current !== null && sameProgramCompatibility(view.compatibility, current) &&
              (view.portability === "portable" || view.source_world_id === seed!.services.game.world_id));
          return json({ experience: views });
        }
        if (url.pathname === "/v1/program-comparisons") {
          let value: unknown;
          try { value = await request.json(); }
          catch { throw new HttpError(400, "invalid_request", "Request body must be JSON"); }
          const input = comparisonBody.safeParse(value);
          if (!input.success) throw new HttpError(400, "invalid_request", "Request fields are invalid or exceed their allowed bounds");
          return store.snapshot(() => json(dispatchHistoryQuery(store, { kind: "operator_comparison", run_id: input.data.before.run_id, ...input.data })));
        }
        const match = /^\/v1\/runs\/([a-f0-9-]{36})(?:\/([^/]+)(?:\/([a-f0-9-]{36}))?)?$/.exec(url.pathname);
        if (!match?.[1]) throw new HttpError(404, "not_found", "Publication route not found");
        const runId = match[1], collection = match[2], execution = match[3];
        return store.snapshot(() => {
          requireRun(runId);
          if (!collection) return json(runView(runId));
          if (collection === "planning") return json({ plan: seed!.runtime.run_id === runId ? seed!.runtime.planning : null });
          if ((collection === "objective-metrics" || collection === "skill-evidence") && execution) {
            if (!z.uuid().safeParse(execution).success) throw new HttpError(400, "invalid_request", "Invalid execution identity");
            const keys = ["generation", "record_index", "chunk_index", "limit"];
            if ([...url.searchParams.keys()].some(key => !keys.includes(key)) || keys.some(key => url.searchParams.getAll(key).length > 1))
              throw new HttpError(400, "invalid_request", "Invalid pinned evidence cursor or page size");
            const values = { generation: url.searchParams.get("generation"), record_index: url.searchParams.get("record_index") ?? "0",
              chunk_index: url.searchParams.get("chunk_index") ?? "0", limit: url.searchParams.get("limit") ?? "25" };
            if (Object.values(values).some(value => value === null || !/^(0|[1-9][0-9]*)$/.test(value)))
              throw new HttpError(400, "invalid_request", "Invalid pinned evidence cursor or page size");
            const generation = Number(values.generation), record_index = Number(values.record_index), chunk_index = Number(values.chunk_index), limit = Number(values.limit);
            if (![generation, record_index, chunk_index, limit].every(Number.isSafeInteger) || limit < 1 || limit > 100)
              throw new HttpError(400, "invalid_request", "Invalid pinned evidence cursor or page size");
            return json(dispatchHistoryQuery(store, { kind: "export_page", run_id: runId, collection: collection === "objective-metrics" ? "objective_metrics" : "program_evidence",
              execution_id: execution, generation, after: { record_index, chunk_index }, limit }));
          }
          if (collection === "improvements") {
            if ([...url.searchParams.keys()].some(key => key !== "after" && key !== "limit") || url.searchParams.getAll("after").length > 1 || url.searchParams.getAll("limit").length > 1)
              throw new HttpError(400, "invalid_request", "Invalid feedback cursor or page size");
            let after: z.infer<typeof improvementFeedbackCursorSchema>;
            try { after = improvementFeedbackCursorSchema.parse(url.searchParams.has("after") ? JSON.parse(url.searchParams.get("after")!) :
              { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null }); }
            catch { throw new HttpError(400, "invalid_request", "Invalid feedback cursor or page size"); }
            const limitValue = url.searchParams.get("limit"), limit = Number(limitValue ?? 32);
            if ((limitValue !== null && !/^[1-9][0-9]*$/.test(limitValue)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
              throw new HttpError(400, "invalid_request", "Invalid feedback cursor or page size");
            return json(dispatchHistoryQuery(store, { kind: "operator_feedback", run_id: runId, after, limit }));
          }
          const { after, limit } = page(url, collection === "events" ? 50 : 100,
            collection === "trace" ? 64 : collection === "deaths" ? 32 : collection === "events" ? 50 : 25);
          if (collection === "trace") {
            const executionId = url.searchParams.get("execution_id") ?? undefined;
            if (executionId && !z.uuid().safeParse(executionId).success) throw new HttpError(400, "invalid_request", "Invalid execution identity");
            return json(dispatchHistoryQuery(store, { kind: "operator_trace", run_id: runId, after, limit, ...(executionId ? { execution_id: executionId } : {}) }));
          }
          if (collection === "deaths") return json(dispatchHistoryQuery(store, { kind: "operator_deaths", run_id: runId, after, limit }));
          if (collection === "skill-evidence") return json(dispatchHistoryQuery(store, { kind: "operator_evidence", run_id: runId, after, limit }));
          if (collection === "events") {
            const candidates = store.eventsAfter(runId, after, limit + 1), events = [], omittedDetails: number[] = [];
            let bytes = 256, cursor = after;
            for (const candidate of candidates.slice(0, limit)) {
              let event = candidate, size = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
              if (bytes + size > 64 * 1024) {
                if (events.length) break;
                event = { ...candidate, details: null }; size = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
                if (bytes + size > 64 * 1024) throw new HttpError(413, "record_too_large", "The retained event summary exceeds the page limit");
                omittedDetails.push(candidate.event_seq);
              }
              events.push(event); bytes += size; cursor = candidate.event_seq;
            }
            return json({ events, next_cursor: cursor, has_more: candidates.some(event => event.event_seq > cursor), omitted_details: omittedDetails });
          }
          throw new HttpError(404, "not_found", "Publication route not found");
        });
      } catch (error) {
        if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
        // Domain query errors are already bounded, credential-free public errors.
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
          ["not_found", "invalid_request", "conflict", "forbidden", "budget_exceeded"].includes(error.code))
          return json({ error: { code: "operation_failed", message: error instanceof Error ? error.message : "Publication query failed" } }, 409);
        return json({ error: { code: "publication_failed", message: "Operator publication could not complete" } }, 503);
      }
    },
  });
  const poll = setInterval(() => { for (const stream of streams) stream.pump(); }, PUBLICATION_LIMITS.pollMs);
  let closure: Promise<void> | null = null;
  return { server, close() {
    if (closure) return closure;
    closed = true; clearInterval(poll);
    for (const stream of streams) stream.close();
    closure = (async () => {
      await server.stop(true);
      experience.close(); store.close();
    })();
    return closure;
  } };
}

async function main() {
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) console[method] = () => {};
  let bytes = Buffer.alloc(0);
  let owner: { close(): Promise<void> } | null = null;
  let started = false;
  const close = () => {
    process.stdin.destroy();
    void owner?.close().catch(() => { process.exitCode = 1; });
  };
  process.stdin.on("data", (chunk: Buffer) => {
    if (started || bytes.length + chunk.length > 16 * 1024) { process.exitCode = 1; close(); return; }
    bytes = Buffer.concat([bytes, chunk]);
    const newline = bytes.indexOf(10);
    if (newline < 0) return;
    if (newline !== bytes.length - 1) { process.exitCode = 1; process.stdin.destroy(); return; }
    try {
      const bootstrap = bootstrapSchema.parse(JSON.parse(bytes.subarray(0, newline).toString("utf8")));
      const publication = createPublicationServer(bootstrap);
      owner = publication; started = true; bytes = Buffer.alloc(0);
      process.stdout.write(JSON.stringify({ port: publication.server.port }) + "\n");
    } catch { process.exitCode = 1; process.stdin.destroy(); }
  });
  process.stdin.once("end", close); process.stdin.once("error", close);
  process.on("SIGTERM", close); process.on("SIGINT", close);
  process.stdout.on("error", close);
}
if (import.meta.main) void main();
