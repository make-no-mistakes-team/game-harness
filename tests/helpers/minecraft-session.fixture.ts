// Isolated auth-service doubles only: the launcher verifier and failure projection stay real.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import * as processes from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const scenario = process.argv[2];
let readers = 0, requests = 0;
const credentialChunks: Buffer[] = [];
mock.module("node:child_process", () => ({ ...processes,
  spawn(command: string, args: string[]) {
    assert.equal(command, "/usr/bin/python3");
    assert.ok(args[0]?.endsWith("/mod/bootstrap/launcher-auth.py"));
    readers++;
    const reader = new EventEmitter() as processes.ChildProcessWithoutNullStreams;
    reader.stdout = new PassThrough();
    reader.stderr = new PassThrough();
    reader.kill = () => { queueMicrotask(() => reader.emit("close", null)); return true; };
    queueMicrotask(() => {
      if (scenario === "reader") { reader.emit("close", 1); return; }
      const bytes = Buffer.from(JSON.stringify({ tokens: ["synthetic-first", "synthetic-second"],
        profile: { id: "synthetic-profile", name: "Synthetic" } }));
      credentialChunks.push(bytes);
      reader.stdout.emit("data", bytes);
      reader.emit("close", 0);
    });
    return reader;
  },
}));
globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
  requests++;
  assert.equal(url, "https://api.minecraftservices.com/minecraft/profile");
  assert.ok(["Bearer synthetic-first", "Bearer synthetic-second"].includes(
    (options?.headers as Record<string, string>).Authorization!));
  if (scenario === "provider") throw new Error("PRIVATE_PROVIDER_SECRET /private/provider");
  if (scenario === "http" || scenario === "bridge" || scenario === "recheck" && readers > 1 || requests % 2 === 1)
    return new Response(null, { status: 401 });
  return Response.json({ id: scenario === "mismatch-id" ? "another-profile" : "synthetic-profile",
    name: scenario === "mismatch-name" ? "Another" : "Synthetic" });
}) as typeof fetch;

const { MinecraftClient } = await import("../../src/minecraft/client.ts");
const { nativeLaunchFailure } = await import("../../src/minecraft/launch-fault.ts");
const preparationFailure = (error: unknown) => nativeLaunchFailure(error) ?? { code: "service_failure" };
const client = new MinecraftClient(process.cwd(), { sourceMinecraft: "/synthetic/never-read" });
const abort = new AbortController();
if (scenario === "aborted") abort.abort();
if (scenario === "ready" || scenario === "recheck") {
  assert.equal(await client.assertOfficialSessionReady(abort.signal), undefined);
  assert.equal(readers, 1);
  assert.equal(requests, 2);
  if (scenario === "recheck") {
    // The early pass grants nothing: actual launch must perform the same check again,
    // before any native artifact, filesystem preparation or child can start.
    await assert.rejects(client.launchAgent({ runtimeCache: "/synthetic", port: 25565, goal: "diamond", evidenceDir: "/synthetic",
      display: ":99", authority: "/synthetic", stillOwned: () => true }, abort.signal), error => {
      assert.deepEqual(preparationFailure(error), { stage: "native_launch", code: "official_session_unavailable",
        error: "The official Launcher Minecraft session is unavailable. Sign in and launch Minecraft 1.21.4 with the official Launcher." });
      return true;
    });
    assert.equal(readers, 2);
    assert.equal(requests, 4);
  }
} else {
  await assert.rejects(client.assertOfficialSessionReady(abort.signal), error => {
    const failure = preparationFailure(error);
    if (scenario === "aborted" || scenario === "provider") assert.equal(failure.code, "service_failure");
    else assert.deepEqual(failure, { stage: "native_launch", code: "official_session_unavailable",
      error: "The official Launcher Minecraft session is unavailable. Sign in and launch Minecraft 1.21.4 with the official Launcher." });
    assert.ok(!JSON.stringify(failure).includes("PRIVATE"));
    return true;
  });
  if (scenario === "aborted") { assert.equal(readers, 0); assert.equal(requests, 0); }
}
for (const bytes of credentialChunks) assert.ok(bytes.every(byte => byte === 0));
console.log("official-session fixture passed");
