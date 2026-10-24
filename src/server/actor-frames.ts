import { createHash } from "node:crypto";
import { deflate } from "node:zlib";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ObservationV3 } from "../shared/contracts.ts";
import type { ScreenRef, SpaceRef } from "../shared/control.ts";
import { inspectVideoFrame } from "./video.ts";
import { RuntimeFault } from "./runtime-fault.ts";

export interface EncodedNativeFrame {
  png: Buffer; sequence: number; capturedAt: number; width: number; height: number;
}
export interface FrameScope {
  run_id: string; world_id: string; session_id: string; epoch: number; life_id: number; generation: number;
  native_boot_id: string; compatibility_hash: string; space: SpaceRef; screen: ScreenRef | null;
}
export interface ActorImageMetadata {
  sequence: number; capturedAt: number; width: number; height: number; encoded_bytes: number; sha256: string;
  host_selection_scope: FrameScope; alignment: "unsynchronized"; pixel_presentation: "opaque_rgb";
}
export interface ModelObservation {
  observation: ObservationV3; images: ImageContent[]; image_metadata: ActorImageMetadata | { mode: "disabled" };
}
// Owned transport packets are immutable. A WeakMap shares concurrent recorder/actor
// compression without retaining an episode's raw frames after their owners release them.
const encodes = new WeakMap<Uint8Array, Promise<EncodedNativeFrame>>();
function chunk(type: string, bytes: Buffer): Buffer {
  const result = Buffer.allocUnsafe(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0); result.write(type, 4, 4, "ascii"); bytes.copy(result, 8);
  result.writeUInt32BE(Bun.hash.crc32(result.subarray(4, bytes.length + 8)) >>> 0, bytes.length + 8);
  return result;
}
export function encodeNativeFramePng(frame: Uint8Array, receivedAt = Date.now()): Promise<EncodedNativeFrame> {
  // Revalidate even a cached result: cached pixels are not renewed capture evidence.
  const header = inspectVideoFrame(frame, receivedAt);
  if (!header) return Promise.reject(new RuntimeFault("stale_context", "Native image is malformed, stale or future-dated"));
  const cached = encodes.get(frame); if (cached) return cached;
  const pending = (async () => {
    const stride = header.width * 4, rows = Buffer.allocUnsafe((stride + 1) * header.height);
    for (let y = 0; y < header.height; y++) {
      const offset = y * (stride + 1); rows[offset] = 0;
      const source = 32 + (header.bottomUp ? header.height - 1 - y : y) * stride;
      rows.set(frame.subarray(source, source + stride), offset + 1);
      // Match the game viewer: framebuffer alpha is not display transparency.
      // Preserve every RGB byte while presenting each native pixel as opaque.
      for (let x = 0; x < stride; x += 4) rows[offset + x + 4] = 255;
    }
    const compression = Promise.withResolvers<Buffer>();
    deflate(rows, (error, value) => error ? compression.reject(error) : compression.resolve(value));
    const compressed = await compression.promise;
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(header.width, 0); ihdr.writeUInt32BE(header.height, 4); ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
    // Deflate overhead is bounded above raw RGBA size; this is not the actor's tighter cap.
    if (png.length > 9 * 1024 * 1024) throw new RuntimeFault("backend_unavailable", "Encoded native PNG exceeds finite codec bound");
    return { png, sequence: header.sequence, capturedAt: header.capturedAt, width: header.width, height: header.height };
  })();
  encodes.set(frame, pending); return pending;
}
export class ActorFrameSelector {
  private priorScope: string | null = null;
  private readonly invalidPackets = new WeakSet<Uint8Array>();
  constructor(private readonly options: { latestFrame(): Uint8Array | null; scope(): FrameScope | null;
    encode?: typeof encodeNativeFramePng }) {}
  async select(): Promise<{ images: ImageContent[]; metadata: ActorImageMetadata }> {
    const scope = this.options.scope(), frame = this.options.latestFrame();
    const key = JSON.stringify(scope);
    if (this.priorScope !== null && key !== this.priorScope && frame) this.invalidPackets.add(frame);
    this.priorScope = key;
    if (!scope || !frame || this.invalidPackets.has(frame)) throw new RuntimeFault("stale_context", "No current-scope native image is available");
    const encoded = await (this.options.encode ?? encodeNativeFramePng)(frame);
    const currentKey = JSON.stringify(this.options.scope());
    if (currentKey !== key) {
      this.invalidPackets.add(frame);
      const buffered = this.options.latestFrame();
      if (buffered) this.invalidPackets.add(buffered);
      // The change is now known. A later delivery may be selected, but neither
      // the in-flight packet nor the packet held at revocation may be relabeled.
      this.priorScope = currentKey;
      throw new RuntimeFault("stale_context", "Native image selection authority changed during encoding");
    }
    if (!inspectVideoFrame(frame)) throw new RuntimeFault("stale_context", "Native image expired during encoding");
    if (encoded.png.length > 2 * 1024 * 1024) throw new RuntimeFault("backend_unavailable", "Actor PNG exceeds the two MiB image bound");
    return { images: [{ type: "image", mimeType: "image/png", data: encoded.png.toString("base64") }], metadata: {
      sequence: encoded.sequence, capturedAt: encoded.capturedAt, width: encoded.width, height: encoded.height,
      encoded_bytes: encoded.png.length, sha256: createHash("sha256").update(encoded.png).digest("hex"),
      host_selection_scope: { ...scope }, alignment: "unsynchronized", pixel_presentation: "opaque_rgb",
    } };
  }
}
