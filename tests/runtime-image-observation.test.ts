import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AuthState, BridgeNotice, GameBridge, GameState, ObservationV3 } from "../src/shared/contracts.ts";
import type { AuthManager } from "../src/server/auth.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { Runtime } from "../src/server/runtime.ts";
import { Store } from "../src/server/store.ts";
import { decodeRgbaPng, nativeFrame } from "./helpers/native-frame.ts";
import { minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gameharness-runtime-image-"));
  const store = new Store(root), world = crypto.randomUUID(), session = crypto.randomUUID(), adapter = minecraftTestAdapter();
  const notices = new Set<(notice: BridgeNotice) => void>();
  const frames = new Set<(frame: Uint8Array) => void>();
  const subscribed = Promise.withResolvers<void>();
  let packet: Uint8Array | null = null, sequence = 0;
  const observation = (): ObservationV3 => minecraftObservationFixture(adapter, { world_id: world, session_id: session, observation_seq: ++sequence });
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => {},
    snapshot: (): GameState => ({ status: "connected", username: "Image fixture", version: "1.21.4",
      world_id: world, epoch: 1, session_id: session, life: { life_id: 1, status: "alive", can_respawn: false, death: null },
      binding: minecraftTestBinding(adapter), space: { dimension_id: "minecraft:overworld", space_epoch: 1 }, screen: null,
      presentation: null, last_observation_at: null, error: null,
      video: { status: "streaming", width: 2, height: 2, fps: 30, frames: packet ? 1 : 0, last_frame_at: null, error: null } }),
    observe: async () => observation(), neutralize: async () => {}, cancel: async () => {},
    adapter: () => adapter, emergencyStop: async () => {},
    execute: async () => { throw new Error("No game effects belong in the image-wait fixture"); },
    subscribe: listener => { notices.add(listener); return () => { notices.delete(listener); }; },
  };
  const authState: AuthState = { status: "ready", authenticated: true, provider: "openai-codex", account_label: null,
    models: [{ id: "fixture-image-model", name: "No provider fixture", provider: "fixture", context_window: null,
      input_modalities: ["text", "image"], capability_provenance: "discovered_sdk_descriptor_not_live_vision" }], login: null, error: null };
  const agent = { setBeforeModelCall: () => {}, setTools: () => {}, subscribe: () => () => {},
    replaceMessages: () => {}, prompt: async () => {}, abort: () => {}, waitForIdle: async () => {} } as unknown as Agent;
  const auth = { snapshot: () => authState, createAgent: async () => agent, releaseAgent: async () => {} } as unknown as AuthManager;
  const sandbox = { snapshot: () => ({ status: "ready", error: null }) } as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter, actorFrames: {
    latestFrame: () => packet,
    subscribeFrames: listener => { frames.add(listener); subscribed.resolve(); return () => { frames.delete(listener); }; },
  } });
  cleanups.push(async () => { await runtime.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.initialize();
  const run = await runtime.createRun({ task: "Image selection fixture only", goal: adapter.goals.find(goal => goal.goal_id === "custom")!, model_id: "fixture-image-model", working_programs: "fresh" });
  await runtime.control(run.run_id, "start");
  return { runtime, store, run, subscribed: subscribed.promise, frameReaders: () => frames.size,
    deliver(value: Uint8Array) { packet = value; for (const listener of frames) listener(value); } };
}

test("a missing current image waits for an actual delivered frame without text fallback", async () => {
  const f = await fixture();
  const pending = f.runtime.modelObservation();
  await f.subscribed;
  f.deliver(nativeFrame({ sequence: 51 }));
  const selected = await pending;
  expect(selected.images).toHaveLength(1);
  expect(decodeRgbaPng(Buffer.from(selected.images[0]!.data, "base64")).width).toBe(2);
  expect(selected.image_metadata).toMatchObject({ sequence: 51, alignment: "unsynchronized", pixel_presentation: "opaque_rgb" });
  expect(f.frameReaders()).toBe(0);
});

test("absence of new frame delivery ends at the bounded preparation deadline", async () => {
  const f = await fixture();
  const pending = f.runtime.modelObservation();
  await f.subscribed;
  await expect(pending).rejects.toMatchObject({ code: "backend_unavailable" });
  await f.runtime.close();
  expect(f.frameReaders()).toBe(0);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "model.call")).toEqual([]);
}, 5000);

test("Stop cancels a delivery wait and late frames cannot restore its authority", async () => {
  const f = await fixture();
  const pending = f.runtime.modelObservation();
  void pending.catch(() => {});
  await f.subscribed;
  const stopped = f.runtime.control(f.run.run_id, "stop");
  await expect(pending).rejects.toMatchObject({ code: "stale_context" });
  await stopped;
  f.deliver(nativeFrame({ sequence: 52 }));
  expect(f.runtime.snapshot()?.status).toBe("stopped");
  expect(f.frameReaders()).toBe(0);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "model.call")).toEqual([]);
});
