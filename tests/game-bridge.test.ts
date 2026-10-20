import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameBridgeClient } from "../src/server/game-bridge.ts";

test("close succeeds after confirmed owned-child exit even when its disconnect reply is lost", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "gameharness-bridge-close-"),
  );
  mkdirSync(path.join(directory, "dist/bridge"), { recursive: true });
  // This transport fixture exits on disconnect without acknowledging it. It
  // supplies no game observations, action results, or neutralization claims.
  writeFileSync(
    path.join(directory, "dist/bridge/index.mjs"),
    `
    process.stdin.once("data", () => process.exit(0));
  `,
  );
  const bridge = new GameBridgeClient(directory);
  try {
    Reflect.get(bridge, "start").call(bridge);
    await bridge.close();
    expect(bridge.snapshot().status).toBe("disconnected");
    expect(bridge.snapshot().viewer_ready).toBe(false);
    expect(Reflect.get(bridge, "child")).toBeNull();
    await bridge.close();
  } finally {
    await bridge.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a lost action reply remains unknown even when cancellation also terminates the child", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "gameharness-bridge-action-"),
  );
  mkdirSync(path.join(directory, "dist/bridge"), { recursive: true });
  writeFileSync(
    path.join(directory, "dist/bridge/index.mjs"),
    `
    process.stdin.once("data", () => process.exit(0));
  `,
  );
  const bridge = new GameBridgeClient(directory);
  const controller = new AbortController();
  try {
    Reflect.get(bridge, "start").call(bridge);
    const pending = bridge.execute(
      { kind: "move", controls: { forward: true }, duration_ms: 200 },
      controller.signal,
    );
    controller.abort();
    const outcome = await pending;
    expect(outcome.status).toBe("unknown");
    expect(outcome.requires_reconnect).toBe(true);
    expect(outcome.evidence).toMatchObject({
      effect_confirmed: false,
      neutralized_effect: false,
    });
  } finally {
    await bridge.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
