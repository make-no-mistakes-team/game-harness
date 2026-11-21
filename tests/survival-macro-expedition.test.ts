import { expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { composeExpeditionAdvisor } from "../src/server/survival-macro/expedition.ts";
import { codexLifecycleFrames } from "./helpers/acceptance-loopback-inference.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 3_000;
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error("Expedition condition was not met");
    await Bun.sleep(20);
  }
}

test("ordinary Terra marks its own lane and drains without an authorized account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "expedition-no-auth-"));
  const advisor = composeExpeditionAdvisor({
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

async function fixture(assertDisplay: () => void = () => {}) {
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
    input: { role: string; content: { type: string; text: string }[] }[];
  } }> = [];
  const discover = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<unknown>();
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("/models")) {
      await discover.promise;
      return Response.json({ models: [{ slug: "gpt-6.1-terra", display_name: "GPT-6.1 Terra", context_window: 500_000,
        default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }],
        input_modalities: ["text", "image"], prefer_websockets: false }] });
    }
    if (request.method !== "POST" || !path.endsWith("/responses"))
      throw new Error("The offline expedition fixture rejects other requests");
    const bytes = new Uint8Array(await request.arrayBuffer());
    const decoded = request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
    requests.push({ account: request.headers.get("chatgpt-account-id"), body: JSON.parse(new TextDecoder().decode(decoded)) });
    const aborted = Promise.withResolvers<never>();
    const cancel = () => aborted.reject(request.signal.reason);
    request.signal.addEventListener("abort", cancel, { once: true });
    try {
      request.signal.throwIfAborted();
      const args = await Promise.race([aborted.promise, reply.promise]);
      return new Response(codexLifecycleFrames(requests.length, { call: { id: "strategy-choice", name: "choose_strategy", arguments: args } }),
        { headers: { "content-type": "text/event-stream" } });
    } finally { request.signal.removeEventListener("abort", cancel); }
  }, { preconnect: globalThis.fetch.preconnect }));
  const run = basename(dir);
  const directory = join(dir, "expedition");
  const adviceFile = join(directory, "advice.json");
  const advisor = composeExpeditionAdvisor({
    dir, goal: visible.goal, objective: "Preserve the stone pickaxe.", authDirectory: dir,
    signal: new AbortController().signal, maxRequests: 1, maxRuntimeMs: 8_000, assertDisplay,
  });
  return {
    advisor, run, directory, adviceFile, requests,
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

test("ordinary Terra sends just its visible strategy choice and counts only an exact native application", async () => {
  const f = await fixture();
  try {
    await f.advisor.start(); // Must finish while discovery is still blocked.
    expect(f.advisor.outcome().admission).toBe("not_opened");
    await f.publish();
    f.openDiscovery();
    await f.received();
    expect(f.requests).toHaveLength(1);
    const { body, account: authenticatedAccount } = f.requests[0]!;
    expect(authenticatedAccount).toBe(account);
    expect(body.model).toBe("gpt-6.1-terra");
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

for (const [label, update, answer, disposition] of [
  ["player respawned", { life: 2 }, chosen, "stale"],
  ["need changed", { need: "wood_supply" }, chosen, "stale"],
  ["offer disappeared", { options: [{ id: "resupply", summary: "Replace supplies" }, { id: "wait", summary: "Wait locally" }] }, chosen, "stale"],
  ["tick expired", { tick: 1_001 }, chosen, "stale"],
  ["Terra abstained", {}, { option: "abstain", reason: "Both choices are premature." }, "abstained"],
  ["Terra invented an option", {}, { option: "not_offered", reason: "Not offered." }, "invalid"],
] as const) test(`ordinary Terra writes no advice when ${label}`, async () => {
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

test("ordinary Terra does not send observations when the display is no longer owned", async () => {
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

test("stopping ordinary Terra cancels and joins the active request without publishing advice", async () => {
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
