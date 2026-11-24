import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { AuthManager } from "../src/server/auth.ts";
import { composeExpeditionAdvisor } from "../src/server/survival-macro/expedition.ts";
import { codexLifecycleFrames } from "./helpers/acceptance-loopback-inference.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 3_000;
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error("Expedition condition was not met");
    await Bun.sleep(20);
  }
}

test("unsupported provider adapters remain unavailable without opening credentials or dispatching", async () => {
  const dir = await mkdtemp(join(tmpdir(), "expedition-unsupported-provider-"));
  const auth = spyOn(AuthManager, "create");
  const fetch = spyOn(globalThis, "fetch");
  const advisor = composeExpeditionAdvisor({
    model: { provider: "unsupported-fixture-provider", modelId: "fixture-strategy-b" },
    dir, goal: "diamond", objective: "", authDirectory: dir, signal: new AbortController().signal,
    maxRequests: 1, maxRuntimeMs: 3_000, assertDisplay() { throw new Error("No dispatch is admitted"); },
  });
  try {
    await advisor.start();
    await until(() => advisor.outcome().admission === "unavailable");
    await advisor.stop();
    expect(advisor.outcome()).toMatchObject({
      model: "unsupported-fixture-provider/fixture-strategy-b", outcome: "provider_unavailable", drain: "closed",
      status: { providerDispatches: 0 },
    });
    expect(auth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    try { await advisor.stop(); }
    finally { auth.mockRestore(); fetch.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  }
});

test("ordinary Model marks its own lane and drains without an authorized account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "expedition-no-auth-"));
  const advisor = composeExpeditionAdvisor({
    model: { provider: "openai-codex", modelId: "fixture-strategy-a" },
    dir, goal: "iron_pickaxe", objective: "", authDirectory: join(dir, "absent"), signal: new AbortController().signal,
    maxRequests: 1, maxRuntimeMs: 3_000, assertDisplay() { throw new Error("No dispatch should reach the display"); },
  });
  try {
    await advisor.start();
    const lane = join(dir, "expedition");
    expect((await lstat(lane)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(lane, "active.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(lane, "active.json"), "utf8"))).toEqual({ v: 1, run: basename(dir) });
    expect(await Bun.file(join(dir, "macro", "active.json")).exists()).toBe(false);
    await until(() => advisor.outcome().admission === "unavailable");
    await advisor.stop();
    expect(advisor.outcome()).toMatchObject({
      control: "local", admission: "unavailable", drain: "closed", outcome: "provider_unavailable",
      status: { providerDispatches: 0, applied: 0 },
    });
  } finally {
    await advisor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

const visible = {
  goal: "iron_pickaxe", need: "iron_supply", activity: "Walking through caves",
  options: [{ id: "check_cave", summary: "Check an already visible dry cave" },
    { id: "resupply", summary: "Replace supplies before exploring" }],
  health: 20, food: 19, inventory: { "minecraft:stone_pickaxe": 1, "minecraft:torch": 4 },
};
const privateHint = "server-only-fixture-marker";
const chosen = { option: "check_cave", reason: "There is already a usable pickaxe." };
const account = "expedition-local-fixture";
const token = `local.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url")}.not-a-real-signature`;

async function fixture(assertDisplay: () => void = () => {}, maxRequests = 1,
    captureRecoveryFrame?: (signal: AbortSignal) => Promise<Buffer>, modelId = "fixture-strategy-a") {
  const dir = await mkdtemp(join(tmpdir(), "expedition-auth-"));
  const authDir = join(dir, "auth");
  const db = join(authDir, "gameharness.sqlite");
  await mkdir(authDir, { mode: 0o700 });
  const storage = await AuthStorage.create(db);
  try {
    await storage.credentials.set("openai-codex", { type: "oauth", access: token,
      refresh: "not-a-real-refresh-token", expires: Date.now() + 3_600_000, accountId: account });
  } finally { storage.close(); }
  await chmod(db, 0o600);
  const requests: Array<{ account: string | null; body: {
    model: string; tool_choice: string; tools: unknown[];
    input: { role: string; content: { type: string; text: string; image_url?: string }[] }[];
  } }> = [];
  const discover = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<unknown>();
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("/models")) {
      await discover.promise;
      return Response.json({ models: ["fixture-strategy-a", "fixture-strategy-b"].map(slug => ({
        slug, display_name: slug, context_window: 500_000,
        default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }],
        input_modalities: ["text", "image"], prefer_websockets: false })) });
    }
    if (request.method !== "POST" || !path.endsWith("/responses"))
      throw new Error("The offline expedition fixture rejects other requests");
    const bytes = new Uint8Array(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
    const body: (typeof requests)[number]["body"] = JSON.parse(new TextDecoder().decode(decoded));
    requests.push({ account: request.headers.get("chatgpt-account-id"), body });
    const aborted = Promise.withResolvers<never>();
    const cancel = () => aborted.reject(request.signal.reason);
    request.signal.addEventListener("abort", cancel, { once: true });
    try {
      request.signal.throwIfAborted();
      const args = await Promise.race([aborted.promise, reply.promise]);
      const name = (body.tools[0] as { name: string }).name;
      return new Response(codexLifecycleFrames(requests.length, { call: { id: "strategy-choice", name, arguments: args } }),
        { headers: { "content-type": "text/event-stream" } });
    } finally { request.signal.removeEventListener("abort", cancel); }
  }, { preconnect: globalThis.fetch.preconnect }));
  const run = basename(dir);
  const directory = join(dir, "expedition");
  const adviceFile = join(directory, "advice.json");
  const advisor = composeExpeditionAdvisor({
    model: { provider: "openai-codex", modelId },
    dir, goal: visible.goal, objective: "Preserve the stone pickaxe.", authDirectory: dir,
    signal: new AbortController().signal, maxRequests, maxRuntimeMs: maxRequests === 1 ? 8_000 : 20_000,
    assertDisplay, captureRecoveryFrame,
  });
  return {
    advisor, dir, run, directory, adviceFile, requests,
    openDiscovery: () => discover.resolve(),
    answer: (args: unknown) => reply.resolve(args),
    received: () => until(() => requests.length > 0),
    async publish(updates: Record<string, unknown> = {}) {
      const file = join(directory, "state.json");
      await writeFile(`${file}.next`, JSON.stringify({ ...visible, v: 1, run, life: 1, tick: 100, seed: privateHint,
        inventory: { ...visible.inventory, "internal:resource_hint": 10 }, ...updates }), { mode: 0o600 });
      await rename(`${file}.next`, file);
    },
    journal: () => readFile(join(directory, "decisions.jsonl"), "utf8"),
    async close() {
      discover.resolve();
      reply.resolve({ option: "abstain", reason: "Test cleanup." });
      try { await advisor.stop(); }
      finally {
        mock.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

for (const modelId of ["fixture-strategy-a", "fixture-strategy-b"]) {
  test(`an explicitly selected discovered model retains its identity: ${modelId}`, async () => {
    const f = await fixture(undefined, 1, undefined, modelId);
    try {
      expect(f.advisor.declaration.model).toBe(`openai-codex/${modelId}`);
      await f.advisor.start();
      await f.publish();
      f.openDiscovery();
      await f.received();
      expect(f.requests[0]!.body.model).toBe(modelId);
      f.answer(chosen);
      await until(async () => (await f.journal()).includes('"disposition":"published"'));
      await f.advisor.stop();
      expect(f.advisor.outcome().model).toBe(`openai-codex/${modelId}`);
      const journal = await f.journal();
      expect(journal).toContain(`openai-codex/${modelId}`);
      expect(journal).not.toContain(token);
      expect(journal).not.toContain("not-a-real-refresh-token");
      expect(journal).not.toContain(privateHint);
    } finally { await f.close(); }
  });
}

test("an undiscovered selected model is unavailable without dispatch or substitution", async () => {
  const f = await fixture(undefined, 1, undefined, "fixture-not-discovered");
  try {
    await f.advisor.start();
    await f.publish();
    f.openDiscovery();
    await until(() => f.advisor.outcome().admission === "unavailable");
    expect(f.requests).toHaveLength(0);
    await f.advisor.stop();
    expect(f.advisor.outcome()).toMatchObject({
      model: "openai-codex/fixture-not-discovered", outcome: "provider_unavailable", drain: "closed",
    });
  } finally { await f.close(); }
});

test("carrying more mined rock does not spend the request for a different strategic choice", async () => {
  const f = await fixture(undefined, 2);
  try {
    await f.advisor.start();
    await f.publish();
    f.openDiscovery();
    await f.received();
    f.answer({ option: "abstain", reason: "Continue the local route." });
    await until(async () => (await f.journal()).includes('"disposition":"abstained"'));
    await Bun.sleep(8_050); // Both a repeat request and a new need are now eligible for the normal cooldown.
    await f.publish({ tick: 300, inventory: { "minecraft:cobblestone": 32 } });
    await Bun.sleep(650);
    await f.publish({ tick: 320, need: "fuel_supply" });
    await until(() => f.requests.length === 2);
    expect(f.requests.map(r => JSON.parse(r.body.input.find(m => m.role === "user")!.content[0]!.text).need))
      .toEqual(["iron_supply", "fuel_supply"]);
  } finally { await f.close(); }
}, 18_000);

test("ordinary Model sends just its visible strategy choice and counts only an exact native application", async () => {
  const f = await fixture(undefined, 1, async () => { throw new Error("A text offer must not request a frame"); });
  try {
    await f.advisor.start(); // Must finish while discovery is still blocked.
    expect(f.advisor.outcome().admission).toBe("not_opened");
    await f.publish();
    f.openDiscovery();
    await f.received();
    expect(f.requests).toHaveLength(1);
    const { body, account: authenticatedAccount } = f.requests[0]!;
    expect(authenticatedAccount).toBe(account);
    expect(body.model).toBe("fixture-strategy-a");
    expect(body.tool_choice).toBe("required");
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ name: "choose_strategy", strict: true, parameters: {
      properties: { option: { enum: ["check_cave", "resupply", "abstain"] }, reason: { type: "string" } },
      required: ["option", "reason"], additionalProperties: false,
    } });
    const blocks = body.input.filter(({ role }) => role === "user").flatMap(({ content }) => content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("input_text");
    expect(JSON.parse(blocks[0]!.text)).toEqual({ ...visible, objective: "Preserve the stone pickaxe." });
    expect(JSON.stringify(body)).not.toContain(privateHint);
    expect(JSON.stringify(body)).not.toContain(f.run);

    await f.publish({ tick: 115 });
    f.answer(chosen);
    await until(() => f.advisor.outcome().status.published === 1);
    const advice = JSON.parse(await readFile(f.adviceFile, "utf8"));
    expect((await lstat(f.adviceFile)).mode & 0o777).toBe(0o600);
    expect(advice).toEqual({ v: 1, run: f.run, life: 1, goal: visible.goal, need: visible.need,
      option: chosen.option, basisTick: 100, expiresTick: 1_000, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(f.advisor.outcome().status.applied).toBe(0);
    await f.publish({ tick: 116, applied: { id: advice.id, option: "resupply", tick: 116 } });
    await Bun.sleep(300);
    expect(f.advisor.outcome().status.applied).toBe(0);
    await f.publish({ tick: 117, need: "none", options: [], applied: { id: advice.id, option: chosen.option, tick: 117 } });
    await until(() => f.advisor.outcome().status.applied === 1);
    await f.advisor.stop();
    expect(f.advisor.outcome()).toMatchObject({ admission: "admitted", drain: "closed", outcome: "strategy_applied",
      status: { requests: 1, providerDispatches: 1, providerSettlements: 1, published: 1, applied: 1 } });
    const journal = await f.journal();
    expect((await lstat(join(f.directory, "decisions.jsonl"))).mode & 0o777).toBe(0o600);
    const decisions = journal.trim().split("\n").map(line => JSON.parse(line));
    expect(decisions).toContainEqual(expect.objectContaining({ event: "disposition", disposition: "published", proposal: chosen,
      usage: expect.objectContaining({ input: 1, output: 1 }) }));
    expect(decisions).toContainEqual(expect.objectContaining({ event: "applied", advice,
      receipt: { id: advice.id, option: chosen.option, tick: 117 } }));
    expect(journal).not.toContain(token);
    const spans = f.advisor.providerTimeline();
    expect(spans).toHaveLength(1);
    expect(spans![0]).toMatchObject({ terminalObserved: true, stage: "live_observation" });
    expect(spans![0]!.endNs! >= spans![0]!.startNs).toBe(true);
  } finally { await f.close(); }
}, 10_000);

// A real, solid-color 1280x720 JPEG. Compress the fixture, not the wire image.
const recoveryJpeg = gunzipSync(Buffer.from("H4sIAAAAAAAAA/t/4/8DBgEvN083BkZGBgj4f5vBmUGUT0BIgFdUSFBIQkxUUt5ESV5WVt5Bz0DNxMc5wN/b2dMjJK4yLSSyKMrDM7M/q6imob2jPTB1yvzJzXMrW9qbQIYwiklIyMvI2ykp2TWFeYY1kQz+H2AQ5GC6wMrAzKjEwCTIyCzI+P8IgyjCqTDABhQWEUAXZQCKijEyoqtmZgGpFsRUfYuBh5kRaA+zIIM9w3zGhegKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgmIP6/zcBrwbRzDcWAAA=", "base64"));
const recovery = {
  need: "situational_recovery",
  activity: "Dry cave entrances repeatedly failed",
  recovery: { incident: 7, history: ["Stopped at a flooded tunnel; no iron obtained.", "Returned to dry footing."] },
  options: [{ id: "check_dry_shelf", summary: "Check an already visible dry shelf" },
    { id: "resupply", summary: "Replace supplies before exploring" }],
};
const authored = {
  option: "check_dry_shelf", subgoal: "Build a dry staging point above the flooded tunnel.",
  steps: ["check_dry_shelf", "resupply"], reason: "The previous route failed at water.",
};

test("ordinary Model grounds its own recovery subgoal in the exact owned JPEG and offered local methods", async () => {
  let captures = 0;
  const f = await fixture(undefined, 1, async () => { captures++; return recoveryJpeg; });
  try {
    await f.advisor.start();
    await f.publish(recovery);
    f.openDiscovery();
    await f.received();
    expect(captures).toBe(1);
    expect(f.advisor.declaration.input).toBe("visible_state_text_or_recovery_jpeg");
    const { body } = f.requests[0]!;
    expect(body.tools).toEqual([expect.objectContaining({ name: "propose_recovery", strict: true, parameters:
      expect.objectContaining({ required: ["option", "reason", "subgoal", "steps"], additionalProperties: false,
        properties: expect.objectContaining({ option: { type: "string", enum: ["check_dry_shelf", "resupply", "abstain"] } }) }),
    })]);
    const blocks = body.input.filter(({ role }) => role === "user").flatMap(({ content }) => content);
    expect(blocks.map(({ type }) => type)).toEqual(["input_text", "input_image"]);
    expect(JSON.parse(blocks[0]!.text)).toEqual({ ...visible, ...recovery, objective: "Preserve the stone pickaxe." });
    expect(blocks[1]!.image_url).toBe(`data:image/jpeg;base64,${recoveryJpeg.toString("base64")}`);
    expect(JSON.stringify(body)).not.toContain(privateHint);
    expect(JSON.stringify(body)).not.toContain(f.run);

    await f.publish({ ...recovery, tick: 108 });
    f.answer(authored);
    await until(() => f.advisor.outcome().status.published === 1);
    const advice = JSON.parse(await readFile(f.adviceFile, "utf8"));
    expect(advice).toEqual({ v: 1, run: f.run, goal: visible.goal, life: 1, basisTick: 100, expiresTick: 1_000,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), need: recovery.need, option: authored.option,
      subgoal: authored.subgoal, steps: authored.steps });
    expect(f.advisor.outcome().status.applied).toBe(0);
    const applied = { id: advice.id, option: authored.option, tick: 109 };
    const observation = { need: "none", options: [], applied };
    await f.publish({ ...observation, tick: 109, activity: `Situational recovery accepted subgoal: ${authored.subgoal}` });
    await until(() => f.advisor.outcome().status.applied === 1);
    expect(await f.journal()).not.toContain('"event":"recovery_activity"');
    const confirmed = `Situational recovery confirmed ${authored.option} (1/2): settled on different dry footing, 3 blocks from this method's start`;
    await f.publish({ ...observation, tick: 139, activity: confirmed });
    await until(async () => (await f.journal()).includes('"status":"confirmed"'));
    await f.publish({ ...observation, tick: 140, activity: confirmed });
    const stopped = "Situational recovery stopped during resupply after confirming 1/2 methods: terrain changed";
    await f.publish({ ...observation, tick: 151, activity: stopped });
    await until(async () => (await f.journal()).includes('"status":"stopped"'));
    const events = (await f.journal()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(entry => entry.event === "recovery_activity")).toEqual([
      expect.objectContaining({ adviceId: advice.id, observedTick: 139, status: "confirmed", method: authored.option, activity: confirmed }),
      expect.objectContaining({ adviceId: advice.id, observedTick: 151, status: "stopped", method: "resupply", activity: stopped }),
    ]);
    const dispatch = events.find(entry => entry.event === "dispatch");
    expect(dispatch.frame).toEqual({ relativePath: expect.stringMatching(/^expedition\/recovery-frames\/[0-9a-f-]{36}\.jpg$/),
      sha256: createHash("sha256").update(recoveryJpeg).digest("hex"), width: 1280, height: 720 });
    const archived = join(f.dir, dispatch.frame.relativePath);
    expect((await lstat(join(f.directory, "recovery-frames"))).mode & 0o777).toBe(0o700);
    expect((await lstat(archived)).mode & 0o777).toBe(0o600);
    expect(await readFile(archived)).toEqual(recoveryJpeg);
  } finally { await f.close(); }
}, 10_000);

test("a single offered recovery method still permits abstention", async () => {
  const f = await fixture(undefined, 1, async () => recoveryJpeg);
  try {
    await f.advisor.start();
    await f.publish({ ...recovery, options: [recovery.options[0]] });
    f.openDiscovery();
    await f.received();
    f.answer({ option: "abstain", reason: "The picture does not support a useful approach.", subgoal: null, steps: [] });
    await until(async () => (await f.journal()).includes('"disposition":"abstained"'));
    expect(await Bun.file(f.adviceFile).exists()).toBe(false);
    expect(f.advisor.outcome().status).toMatchObject({ providerDispatches: 1, published: 0, applied: 0 });
  } finally { await f.close(); }
}, 10_000);

for (const [label, answer] of [
  ["invented method", { ...authored, steps: [authored.option, "teleport"] }],
  ["duplicate method", { ...authored, steps: [authored.option, authored.option] }],
  ["first method differs from option", { ...authored, steps: ["resupply", authored.option] }],
  ["empty plan", { ...authored, steps: [] }],
  ["subgoal exceeds the UTF-8 limit", { ...authored, subgoal: "海".repeat(81) }],
  ["coordinate field", { ...authored, coordinates: [12, 60, 13] }],
  ["old text-only reply", chosen],
  ["abstention carries a plan", { ...authored, option: "abstain" }],
] as const) test(`recovery rejects a reply with ${label}`, async () => {
  const f = await fixture(undefined, 1, async () => recoveryJpeg);
  try {
    await f.advisor.start();
    await f.publish(recovery);
    f.openDiscovery();
    await f.received();
    f.answer(answer);
    await until(async () => (await f.journal()).includes('"disposition":"invalid"'));
    expect(await Bun.file(f.adviceFile).exists()).toBe(false);
    expect(f.advisor.outcome().status).toMatchObject({ providerDispatches: 1, published: 0, applied: 0 });
  } finally { await f.close(); }
}, 10_000);

test("malformed recovery offers never reach the capture adapter", async () => {
  let captures = 0;
  const f = await fixture(undefined, 1, async () => { captures++; return recoveryJpeg; });
  try {
    await f.advisor.start();
    await f.publish({ ...recovery, recovery: undefined });
    f.openDiscovery();
    await until(() => f.advisor.outcome().admission === "admitted");
    for (const changes of [
      { recovery: undefined }, { recovery: { ...recovery.recovery, incident: 0 } },
      { recovery: { ...recovery.recovery, incident: Number.MAX_SAFE_INTEGER + 1 } },
      { recovery: { ...recovery.recovery, history: ["🌲".repeat(61)] } },
      { recovery: { ...recovery.recovery, history: Array(6).fill("Failed") } },
      { recovery: { ...recovery.recovery, location: [3, 4, 5] } },
      { options: [] }, { options: [recovery.options[0], recovery.options[0]] },
      { need: "wood_supply" },
    ]) {
      await f.publish({ ...recovery, ...changes });
      await Bun.sleep(275);
      expect(f.advisor.outcome().status.requests).toBe(0);
    }
    expect(captures).toBe(0);
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 10_000);

for (const [label, frame] of [
  ["non-JPEG bytes", Buffer.from("not a picture")],
  ["a real JPEG of the wrong dimensions", Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AH//Z", "base64")],
  ["an oversized capture", Buffer.alloc(2 * 1024 * 1024 + 1)],
] as const) test(`recovery sends nothing for ${label}`, async () => {
  const f = await fixture(undefined, 1, async () => frame);
  try {
    await f.advisor.start();
    await f.publish(recovery);
    f.openDiscovery();
    await until(async () => (await f.journal()).includes('"disposition":"invalid_frame"'));
    expect(f.requests).toHaveLength(0);
    expect(await readdir(join(f.directory, "recovery-frames"))).toEqual([]);
    expect(f.advisor.outcome().status).toMatchObject({ requests: 1, providerDispatches: 0, published: 0 });
  } finally { await f.close(); }
}, 10_000);

test("a healthy text lane does not send recovery without a private capture adapter", async () => {
  const f = await fixture();
  try {
    await f.advisor.start();
    await f.publish(recovery);
    f.openDiscovery();
    await until(() => f.advisor.outcome().admission === "admitted");
    await Bun.sleep(275);
    expect(f.requests).toHaveLength(0);
    await f.publish({ tick: 101 });
    await f.received();
    expect(f.requests[0]!.body.tools[0]).toMatchObject({ name: "choose_strategy" });
  } finally { await f.close(); }
}, 10_000);

test("recovery does not send a captured frame after the native offer was withdrawn", async () => {
  const captureStarted = Promise.withResolvers<void>();
  const capture = Promise.withResolvers<Buffer>();
  const f = await fixture(undefined, 1, () => { captureStarted.resolve(); return capture.promise; });
  try {
    await f.advisor.start();
    await f.publish(recovery);
    f.openDiscovery();
    await captureStarted.promise;
    await f.publish({ tick: 109, need: "none", options: [] });
    capture.resolve(recoveryJpeg);
    await until(async () => (await f.journal()).includes('"disposition":"stale"'));
    expect(f.requests).toHaveLength(0);
    expect(await readdir(join(f.directory, "recovery-frames"))).toEqual([]);
  } finally { capture.resolve(recoveryJpeg); await f.close(); }
}, 10_000);

test("recovery drops a JPEG returned after the capture deadline", async () => {
  const f = await fixture(undefined, 1, async signal => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return recoveryJpeg;
  });
  try {
    await f.advisor.start();
    await f.publish(recovery);
    f.openDiscovery();
    await until(async () => (await f.journal()).includes('"disposition":"capture_timeout"'));
    expect(f.requests).toHaveLength(0);
    expect(await readdir(join(f.directory, "recovery-frames"))).toEqual([]);
  } finally { await f.close(); }
}, 10_000);

test("recovery sends no JPEG without its private archive", async () => {
  const f = await fixture(undefined, 1, async () => {
    await chmod(join(f.directory, "recovery-frames"), 0o755);
    return recoveryJpeg;
  });
  try {
    await f.advisor.start();
    await f.publish(recovery);
    f.openDiscovery();
    await until(async () => (await f.journal()).includes('"disposition":"archive_unavailable"'));
    expect(f.requests).toHaveLength(0);
    expect(await readdir(join(f.directory, "recovery-frames"))).toEqual([]);
  } finally { await f.close(); }
}, 10_000);

test("recovery refuses a proposal if even a later proposed method is withdrawn", async () => {
  const f = await fixture(undefined, 1, async () => recoveryJpeg);
  try {
    await f.advisor.start();
    await f.publish(recovery);
    f.openDiscovery();
    await f.received();
    await f.publish({ ...recovery, tick: 109, options: [recovery.options[0]] });
    f.answer(authored);
    await until(async () => (await f.journal()).includes('"disposition":"stale"'));
    expect(await Bun.file(f.adviceFile).exists()).toBe(false);
    expect(f.advisor.outcome().status).toMatchObject({ providerDispatches: 1, published: 0 });
  } finally { await f.close(); }
}, 10_000);

test("recovery never pays twice for an unchanged incident or exact view", async () => {
  let captures = 0;
  const f = await fixture(undefined, 3, async () => { captures++; return recoveryJpeg; });
  try {
    await f.advisor.start();
    await f.publish(recovery);
    f.openDiscovery();
    await f.received();
    f.answer({ option: "abstain", reason: "Neither method helps yet.", subgoal: null, steps: [] });
    await until(async () => (await f.journal()).includes('"disposition":"abstained"'));
    await Bun.sleep(8_050);
    await f.publish({ ...recovery, tick: 261, inventory: { "minecraft:cobblestone": 6 } });
    await Bun.sleep(525);
    expect(captures).toBe(1);
    await f.publish({ ...recovery, tick: 280, recovery: { ...recovery.recovery, incident: 8 } });
    await until(async () => (await f.journal()).includes('"disposition":"duplicate_frame"'));
    expect(captures).toBe(2);
    expect(f.requests).toHaveLength(1);
    expect(await readdir(join(f.directory, "recovery-frames"))).toHaveLength(1);
  } finally { await f.close(); }
}, 18_000);

for (const [label, update, answer, disposition] of [
  ["player respawned", { life: 2 }, chosen, "stale"],
  ["need changed", { need: "wood_supply" }, chosen, "stale"],
  ["offer disappeared", { options: [{ id: "resupply", summary: "Replace supplies" }, { id: "wait", summary: "Wait locally" }] }, chosen, "stale"],
  ["tick expired", { tick: 1_001 }, chosen, "stale"],
  ["Model abstained", {}, { option: "abstain", reason: "Both choices are premature." }, "abstained"],
  ["Model invented an option", {}, { option: "not_offered", reason: "Not offered." }, "invalid"],
] as const) test(`ordinary Model writes no advice when ${label}`, async () => {
  const f = await fixture();
  try {
    await f.advisor.start();
    await f.publish();
    f.openDiscovery();
    await f.received();
    await f.publish({ tick: 101, ...update });
    f.answer(answer);
    await until(async () => (await f.journal()).includes(`"disposition":"${disposition}"`));
    await f.advisor.stop();
    expect(await Bun.file(f.adviceFile).exists()).toBe(false);
    expect(f.advisor.outcome().status).toMatchObject({ providerDispatches: 1, published: 0, applied: 0 });
  } finally { await f.close(); }
}, 10_000);

test("ordinary Model does not send observations when the display is no longer owned", async () => {
  const f = await fixture(() => { throw new Error("Private display lost"); });
  try {
    await f.advisor.start();
    await f.publish();
    f.openDiscovery();
    await until(() => f.advisor.outcome().outcome === "display_lost");
    await f.advisor.stop();
    expect(f.requests).toHaveLength(0);
    expect(f.advisor.outcome()).toMatchObject({ admission: "admitted", drain: "closed",
      status: { providerDispatches: 0, published: 0, applied: 0 } });
  } finally { await f.close(); }
}, 10_000);

test("stopping ordinary Model cancels and joins the active request without publishing advice", async () => {
  const f = await fixture();
  try {
    await f.advisor.start();
    await f.publish();
    f.openDiscovery();
    await f.received();
    await f.advisor.stop();
    expect(await Bun.file(f.adviceFile).exists()).toBe(false);
    expect(f.advisor.outcome()).toMatchObject({ admission: "admitted", drain: "closed",
      status: { providerDispatches: 1, providerSettlements: 1, lastProviderOutcome: "cancelled", published: 0, applied: 0 } });
    expect(f.advisor.providerTimeline()?.[0]).toMatchObject({ terminalObserved: false });
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
}, 10_000);
