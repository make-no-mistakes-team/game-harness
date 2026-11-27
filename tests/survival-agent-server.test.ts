import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server/index.ts";

test("minimal v2 host requires local session, CSRF and matching origin while refusing removed APIs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gameharness-server-"));
  const app = await createApplication({ directory, projectRoot: directory, port: 0, nonce: null });
  const origin = `http://127.0.0.1:${app.server.port}`;
  try {
    expect((await fetch(`${origin}/v1/state`)).status).toBe(401);
    const session = await fetch(`${origin}/v1/session`);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf_token } = await session.json() as { csrf_token: string };
    const headers = { cookie, "x-csrf-token": csrf_token, "content-type": "application/json" };
    const state = await (await fetch(`${origin}/v1/state`, { headers })).json();
    expect(state).toMatchObject({ auth: { authenticated: false }, eulaAccepted: false, preparing: false });
    expect((await fetch(`${origin}/v1/survival-agent`, { headers })).status).toBe(200);
    expect((await fetch(`${origin}/v1/survival-agent/start`, { method: "POST", headers: { cookie }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${origin}/v1/auth/logout`, { method: "POST", headers: { ...headers, origin: "https://example.test" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${origin}/v1/server/prepare`, { method: "POST", headers, body: '{"accept_eula":false}' })).status).toBe(400);
    expect((await fetch(`${origin}/v1/survival-agent/start`, { method: "POST", headers,
      body: JSON.stringify({ goal: "diamond_pickaxe", strategy: "model", model: { provider: "fixture", modelId: "unavailable" } }) })).status).toBe(400);
    for (const route of ["/v1/runs", "/v1/game/start", "/v1/programs", "/local/runtime/auth/gameharness.sqlite", "/src/agent/run.ts"])
      expect((await fetch(`${origin}${route}`, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/v1/survival-agent/stop`, { method: "POST", headers, body: "{}" })).status).toBe(202);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
