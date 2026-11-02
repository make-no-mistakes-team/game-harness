import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorFrameSelector, encodeNativeFramePng } from "../src/server/actor-frames.ts";
import { NativeFrameDecoder } from "../src/server/game-bridge.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { decodeRgbaPng, frameScope, nativeFrame } from "./helpers/native-frame.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function selectionScope() {
  return { ...frameScope(),
    space: { dimension_id: "minecraft:overworld", space_epoch: 4 },
    screen: { screen_id: "view", incarnation: 2, revision: 3 } };
}

for (const identity of ["boot", "space", "screen", "descriptor"] as const) {
  test(`${identity} selection revocation preserves real PNG bytes but never relabels a buffered frame`, async () => {
    let scope = selectionScope(), packet = nativeFrame({ sequence: 11 });
    const encoded = await encodeNativeFramePng(packet);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const selector = new ActorFrameSelector({ latestFrame: () => packet, scope: () => scope,
      encode: async () => { entered.resolve(); await release.promise; return encoded; } });
    const old = selector.select();
    await entered.promise;
    switch (identity) {
      case "boot": scope = { ...scope, native_boot_id: "boot-B" }; break;
      case "space": scope = { ...scope, space: { ...scope.space, space_epoch: 5 } }; break;
      case "screen": scope = { ...scope, screen: { ...scope.screen, incarnation: 3 } }; break;
      case "descriptor": scope = { ...scope, compatibility_hash: "f".repeat(64) }; break;
    }
    release.resolve();
    await expect(old).rejects.toThrow();
    await expect(selector.select()).rejects.toThrow();
    packet = nativeFrame({ sequence: 12 });
    // Use the real encoder on the replacement packet, not a fixture PNG from A.
    const fresh = new ActorFrameSelector({ latestFrame: () => packet, scope: () => scope });
    const selected = await fresh.select();
    expect(selected.metadata).toMatchObject({ sequence: 12, alignment: "unsynchronized",
      pixel_presentation: "opaque_rgb", host_selection_scope: scope });
    for (const invented of ["capture_life_id", "capture_space", "capture_screen", "native_tick", "camera", "applied_input_sequence"])
      expect(selected.metadata).not.toHaveProperty(invented);
    expect(decodeRgbaPng(Buffer.from(selected.images[0]!.data, "base64")).width).toBe(2);
    expect(JSON.stringify(selected.metadata)).not.toContain(selected.images[0]!.data);
  });
}

test("descriptor cutover leaves split GHV2, opaque PNGs, ordered recording/gaps and final hold intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gameharness-adapter-media-")); directories.push(directory);
  const listeners = new Set<(frame: Uint8Array) => void>();
  const start = Date.now(); let now = start, latest: Uint8Array | null = null;
  const firstEncode = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const recorder = new EpisodeRecorder({ directory, identity: { episode_id: "contract", run_id: "run", world_id: "world", session_id: "session" },
    bridge: { subscribeFrames(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    now: () => now, monotonicNow: () => now - start, onIncomplete: () => {},
    encode: async (frame, receivedAt) => { firstEncode.resolve(); await release.promise; return await encodeNativeFramePng(frame, receivedAt); } });
  const decoder = new NativeFrameDecoder(frame => { latest = frame; for (const listener of listeners) listener(frame); });
  const rgb = [255, 0, 0, 0, 0, 255, 0, 127, 0, 0, 255, 1, 255, 255, 255, 255];
  const first = nativeFrame({ sequence: 10, capturedAt: start, pixels: new Uint8Array(rgb) });
  decoder.push(Buffer.from(first.subarray(0, 7))); decoder.push(Buffer.from(first.subarray(7)));
  await firstEncode.promise;
  now = start + 500;
  decoder.push(Buffer.from(nativeFrame({ sequence: 12, capturedAt: now, pixels: new Uint8Array(rgb) })));
  const actor = new ActorFrameSelector({ latestFrame: () => latest, scope: selectionScope });
  const selected = await actor.select();
  expect(selected.images[0]!.type).toBe("image");
  expect(selected.metadata).toMatchObject({ alignment: "unsynchronized", sequence: 12 });
  let closed = false;
  const finishing = recorder.finish({ endedAt: start + 1200, reason: "operator_stop" }).then(result => { closed = true; return result; });
  try {
    await Promise.resolve(); expect(closed).toBe(false);
  } finally { release.resolve(); }
  const manifest = await finishing;
  expect(listeners.size).toBe(0);
  expect(manifest).toMatchObject({ status: "complete", audio: "not_recorded", delivered_frames: 2, stored_frames: 2 });
  const rows = (await readFile(join(directory, manifest.index), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const frames = rows.filter(row => row.kind === "frame");
  expect(frames.map(row => row.sequence)).toEqual([10, 12]);
  expect(rows).toContainEqual(expect.objectContaining({ kind: "upstream_gap", missing_sequences: 1, capture_delta_ms: 500 }));
  for (const row of frames) {
    const png = decodeRgbaPng(await readFile(join(directory, row.file)));
    expect(png.pixels).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    expect(row).not.toHaveProperty("capture_space");
  }
  const timeline = await readFile(join(directory, manifest.concat), "utf8");
  expect(timeline.split("\n").filter(line => line.startsWith("duration ")).map(line => Number(line.slice(9)))).toEqual([0.5, 0.7]);
});
