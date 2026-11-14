import { expect, test } from "bun:test";
import { join } from "node:path";
import { OperatorPublication } from "../src/server/operator-publication.ts";
import { createPublicationServer } from "../src/server/operator-publication-worker.ts";
import { isPublicationRoute, PUBLICATION_LIMITS, PublicationUnavailable, type PublicationSeed } from "../src/server/operator-publication-protocol.ts";
import { ExperienceLibrary } from "../src/server/experience.ts";
import type { AppSnapshot, PolicyView, RunView } from "../src/shared/contracts.ts";
import { projectRunOperator } from "../src/server/operator-state.ts";
import { programFingerprint } from "../src/server/program-validation.ts";
import { historyFixture, historySpec, historyExecution } from "./helpers/history-fixture.ts";
import { createHash, randomBytes } from "node:crypto";

async function eventually(predicate: () => boolean, milliseconds = 5_000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Publication condition did not settle");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
function fixture() {
  const f = historyFixture();
  const library = new ExperienceLibrary(f.directory);
  library.close();
  const live: Omit<PublicationSeed, "sequence"> = {
    services: {
      auth: { status: "signed_out", authenticated: false, provider: "openai-codex", account_label: null, models: [], login: null, error: null },
      server: { status: "stopped", version: "1.21.4", host: "127.0.0.1", port: 25565, world_id: null, eula_accepted: false, error: null },
      game: { status: "disconnected", username: "publication fixture", version: "1.21.4", world_id: null, epoch: 0, session_id: null,
        life: null, binding: null, space: null, screen: null, video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
        last_observation_at: null, presentation: null, error: null },
      sandbox: { status: "unavailable", image: "storage-only", error: null }, prepared_start: null, goals: [],
    },
    runtime: { run_id: f.run.run_id, action: null, recovering: false, policy_order: [], planning: null },
  };
  let reads = 0;
  const owner = new OperatorPublication(f.store.readLocation(), join(f.directory, "experience.sqlite"), () => { reads++; return live; });
  const response = (pathname: string, options: { expires?: number; authorized?: () => boolean; signal?: AbortSignal; headers?: HeadersInit } = {}) =>
    owner.response(new Request(`http://127.0.0.1${pathname}`, { signal: options.signal, headers: options.headers }), options.expires ?? Date.now() + 60_000,
      options.authorized ?? (() => true), { "X-Test-Publication": "opaque-bytes" });
  return { ...f, live, owner, response, reads: () => reads, async close() { await owner.close(); f.close(); } };
}

test("default route classifier sends all heavy reads to readonly publication but never sends effect ingress", () => {
  const id = crypto.randomUUID();
  for (const route of ["/v1/state", "/v1/runs", "/v1/events", "/v1/experience", `/v1/runs/${id}`, `/v1/runs/${id}/events`,
    `/v1/runs/${id}/planning`, `/v1/runs/${id}/trace`, `/v1/runs/${id}/improvements`, `/v1/runs/${id}/deaths`,
    `/v1/runs/${id}/skill-evidence`, `/v1/runs/${id}/objective-metrics/${crypto.randomUUID()}`])
    expect(isPublicationRoute("GET", route)).toBe(true);
  for (const route of [`/v1/runs/${id}/controls`, "/v1/game/stop", "/v1/auth/logout", "/v1/prepared-start"])
    expect(isPublicationRoute("POST", route)).toBe(false);
  expect(isPublicationRoute("POST", "/v1/program-comparisons")).toBe(true);
});

test("current and historical source/execution/operator DTOs come from readonly storage without source truncation", async () => {
  const f = fixture();
  try {
    const source = "// immutable source evidence\n".repeat(4000);
    const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "publication source", source));
    const execution = historyExecution(f.store, f.run, skill);
    f.store.event(f.run.run_id, "skill.progress", "Retained progress", { execution_id: execution.execution_id });
    f.live.runtime.recovering = true;
    const response = await f.response("/v1/state");
    expect(response.headers.get("x-test-publication")).toBe("opaque-bytes");
    const snapshot: AppSnapshot = await response.json();
    expect(snapshot.run!.skills[0]!.source).toBe(source);
    expect(snapshot.run!.executions).toEqual(f.store.skillExecutions(f.run.run_id));
    expect(snapshot.run!.operator).toEqual(projectRunOperator(f.store, f.run, null, f.store.skillExecutions(f.run.run_id), true));
    f.live.runtime.run_id = null;
    const historical: RunView = await (await f.response(`/v1/runs/${f.run.run_id}`)).json();
    expect(historical.skills[0]!.source).toBe(source);
    expect(historical.action).toBeNull();
    expect(historical.operator.state).not.toBe("recovering");
    const runs: { runs: RunView[] } = await (await f.response("/v1/runs")).json();
    expect(runs.runs[0]).toEqual(historical);
  } finally { await f.close(); }
});

test("live policy order and transient last_error overlay survive readonly hydration without changing persisted historical views", async () => {
  const f = fixture();
  try {
    const source = "// inert storage-only publication identity; never compiled or invoked\n";
    const hash = createHash("sha256").update(source).digest("hex");
    const validation = { fingerprint: programFingerprint(hash, "policy", f.run.compatibility_hash!), runtime_version: 5 as const,
      api_version: 5 as const, validator_version: 5 as const, compatibility_hash: f.run.compatibility_hash!, formatted_lines: 1, complexity: 1, nesting: 0 };
    const policies: PolicyView[] = [];
    for (const name of ["Zulu", "Alpha"]) policies.push(await f.store.registerPolicy(f.run.run_id, {
      backend: "javascript", choices: null, source, name, card: historySpec(f.run).card, priority: 1, interval_ms: 100,
    }, 0, validation));
    f.live.runtime.policy_order = policies.map(policy => ({ policy_id: policy.policy_id, version: policy.version, last_error: "Live closure pending" }));
    const current: RunView = await (await f.response(`/v1/runs/${f.run.run_id}`)).json();
    expect(current.policies.map(policy => policy.name)).toEqual(["Zulu", "Alpha"]);
    expect(current.policies.map(policy => policy.last_error)).toEqual(["Live closure pending", "Live closure pending"]);
    expect(current.policies.every(policy => policy.source === source)).toBe(true);
    f.live.runtime.run_id = null;
    const historical: RunView = await (await f.response(`/v1/runs/${f.run.run_id}`)).json();
    expect(historical.policies.map(policy => policy.name)).toEqual(["Alpha", "Zulu"]);
    expect(historical.policies.every(policy => policy.last_error === null)).toBe(true);
  } finally { await f.close(); }
});

test("event pages preserve durable cursors and explicitly identify omitted oversized details", async () => {
  const f = fixture();
  try {
    const large = f.store.event(f.run.run_id, "fixture.large", "Large retained details", { payload: "x".repeat(100_000) });
    const next = f.store.event(f.run.run_id, "fixture.next", "Next durable event");
    const page = await (await f.response(`/v1/runs/${f.run.run_id}/events?after=${large.event_seq - 1}&limit=1`)).json();
    expect(page.events).toEqual([{ ...large, details: null }]);
    expect(page.omitted_details).toEqual([large.event_seq]);
    expect(page.next_cursor).toBe(large.event_seq);
    expect(page.has_more).toBe(true);
    const continuation = await (await f.response(`/v1/runs/${f.run.run_id}/events?after=${page.next_cursor}&limit=1`)).json();
    expect(continuation.events).toEqual([next]);
    expect(continuation.has_more).toBe(false);
  } finally { await f.close(); }
});

test("activity SSE replays ordered durable IDs across slow consumers and reconnects", async () => {
  const f = fixture();
  try {
    const before = f.store.lastEventSeq();
    const expected = Array.from({ length: 25 }, (_, index) => f.store.event(f.run.run_id, "fixture.activity", `Durable ${index}`));
    const stream = await f.response("/v1/events", { headers: { "last-event-id": String(before) } });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    await new Promise<void>(resolve => setImmediate(resolve));
    while ((text.match(/^id: /gm) ?? []).length < expected.length) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Activity stream closed before its durable cursor");
      text += decoder.decode(chunk.value, { stream: true });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    expect(ids).toEqual(expected.map(event => event.event_seq));
    await reader.cancel();
    const more = f.store.event(f.run.run_id, "fixture.activity", "After reconnect");
    const resumed = await f.response("/v1/events", { headers: { "last-event-id": String(ids.at(-1)) } });
    const resumedReader = resumed.body!.getReader();
    const first = await resumedReader.read();
    expect(decoder.decode(first.value)).toContain(`id: ${more.event_seq}\n`);
    await resumedReader.cancel();
  } finally { await f.close(); }
});

test("session expiry, abort and revoked current authorization terminate actual response streams", async () => {
  const f = fixture();
  try {
    await (await f.response("/v1/state")).arrayBuffer();
    // This is the actual host/child wall-clock expiry contract; a fake timer
    // cannot advance the independently scheduled process's Date.now().
    const expiring = await f.response("/v1/events", { expires: Date.now() + 1_000 });
    const expiryReader = expiring.body!.getReader();
    await expiryReader.read();
    await expect(expiryReader.read()).rejects.toBeInstanceOf(PublicationUnavailable);
    const abort = new AbortController();
    const aborted = await f.response("/v1/events", { signal: abort.signal });
    const abortReader = aborted.body!.getReader();
    await abortReader.read(); abort.abort();
    await expect(abortReader.read()).rejects.toBeInstanceOf(PublicationUnavailable);
    let authorized = true;
    const revoked = await f.response("/v1/events", { authorized: () => authorized });
    const revokedReader = revoked.body!.getReader();
    await revokedReader.read(); authorized = false;
    await expect(revokedReader.read()).rejects.toBeInstanceOf(PublicationUnavailable);
  } finally { await f.close(); }
});

test("a stalled child retains only one in-flight cut and one dirty latest seed, then publishes the actual newest services", async () => {
  const f = fixture();
  try {
    await (await f.response("/v1/state")).arrayBuffer();
    const pid = f.owner.snapshot().pid!;
    process.kill(pid, "SIGSTOP");
    f.owner.notify();
    await eventually(() => f.owner.snapshot().seed_in_flight);
    const reads = f.reads();
    for (let index = 0; index < 10_000; index++) {
      f.live.services.game.error = `Newest service state ${index}`;
      f.owner.notify();
    }
    expect(f.owner.snapshot().latest_pending).toBe(true);
    expect(f.reads()).toBe(reads);
    expect(f.owner.snapshot().coalesced_changes).toBeGreaterThanOrEqual(9999);
    process.kill(pid, "SIGCONT");
    const state: AppSnapshot = await (await f.response("/v1/state")).json();
    expect(state.game.error).toBe("Newest service state 9999");
    expect(f.reads() - reads).toBeLessThanOrEqual(3);
  } finally { await f.close(); }
});

test("stalled publication cannot hold an expired request and close kills and truly joins the stopped child", async () => {
  const f = fixture();
  try {
    await (await f.response("/v1/state")).arrayBuffer();
    process.kill(f.owner.snapshot().pid!, "SIGSTOP");
    // Exercise real expiry while the independent child cannot run any timers.
    await expect(f.response("/v1/state", { expires: Date.now() + 100 })).rejects.toMatchObject({ status: 401 });
    await f.owner.close();
    expect(f.owner.snapshot().closed).toBe(true);
    expect(f.owner.snapshot().active_requests).toBe(0);
  } finally { await f.close(); }
});

test("publication death errors active streams and never falls back to host hydration or silently restarts", async () => {
  const f = fixture();
  try {
    const stream = await f.response("/v1/events");
    const reader = stream.body!.getReader(); await reader.read();
    const pid = f.owner.snapshot().pid!;
    process.kill(pid, "SIGKILL");
    await eventually(() => f.owner.snapshot().failed);
    await expect(reader.read()).rejects.toBeInstanceOf(PublicationUnavailable);
    await expect(f.response("/v1/state")).rejects.toBeInstanceOf(PublicationUnavailable);
    expect(f.owner.snapshot().pid).toBe(pid);
  } finally { await f.close(); }
});

test("oversized live metadata fails explicitly instead of dropping fields or hydrating locally", async () => {
  const f = fixture();
  try {
    await (await f.response("/v1/state")).arrayBuffer();
    f.live.services.game.error = "x".repeat(PUBLICATION_LIMITS.seedBytes);
    f.owner.notify();
    await expect(f.response("/v1/state")).rejects.toBeInstanceOf(PublicationUnavailable);
    expect(f.owner.snapshot().failed).toBe(true);
  } finally { await f.close(); }
});

test("activity stream admission is finite and a rejected extra viewer does not terminate existing viewers", async () => {
  const f = fixture();
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (let index = 0; index < PUBLICATION_LIMITS.eventStreams; index++) {
      const response = await f.response("/v1/events");
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      readers.push(reader);
    }
    const rejected = await f.response("/v1/events");
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ error: { code: "busy" } });
    const event = f.store.event(f.run.run_id, "fixture.still_open", "Existing activity ownership retained");
    for (const reader of readers) {
      let text = "";
      while (!text.includes(`id: ${event.event_seq}\n`)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Admitted activity stream ended early");
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain(`id: ${event.event_seq}\n`);
    }
  } finally {
    await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
    await f.close();
  }
});

test("private readonly endpoint requires both host-only token and current application nonce, including seed writes", async () => {
  const f = historyFixture();
  const library = new ExperienceLibrary(f.directory); library.close();
  const bootstrap = { location: f.store.readLocation(), experience: join(f.directory, "experience.sqlite"),
    token: randomBytes(32).toString("hex"), instance: randomBytes(32).toString("hex") };
  const owner = createPublicationServer(bootstrap);
  const url = `http://127.0.0.1:${owner.server.port}`;
  try {
    const invalidHeaders: Record<string, string>[] = [{}, { authorization: `Bearer ${bootstrap.token}` },
      { authorization: `Bearer ${bootstrap.token}`, "x-publication-instance": randomBytes(32).toString("hex") },
      { authorization: `Bearer ${bootstrap.token}`, "x-publication-instance": bootstrap.instance, origin: "http://localhost" }];
    for (const headers of invalidHeaders) {
      expect((await fetch(url + "/v1/state", { headers })).status).toBe(403);
      expect((await fetch(url + "/private/seed", { method: "POST", headers, body: "{}" })).status).toBe(403);
    }
    const authenticated = { authorization: `Bearer ${bootstrap.token}`, "x-publication-instance": bootstrap.instance,
      "x-publication-expires": String(Date.now() - 1) };
    expect((await fetch(url + "/v1/state", { headers: authenticated })).status).toBe(401);
    expect((await fetch(url + "/v1/game/stop", { method: "POST", headers: authenticated })).status).toBe(404);
    expect(PUBLICATION_LIMITS.eventStreams).toBeLessThan(PUBLICATION_LIMITS.requests);
  } finally { await owner.close(); f.close(); }
});
