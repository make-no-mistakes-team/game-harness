import { createHash } from "node:crypto";
import { deflate } from "node:zlib";
import { inspectVideoFrame } from "./video.ts";
import { RuntimeFault } from "./runtime-fault.ts";

export interface EncodedNativeFrame {
  png: Buffer; sequence: number; capturedAt: number; width: number; height: number;
}
export interface ActorFramePresentation { data: string; encoded_bytes: number; sha256: string }
// Standalone recording callers can share compression without retaining raw packets.
// The live actor uses this same codec only inside its owned subprocess.
const encodes = new WeakMap<Uint8Array, Promise<EncodedNativeFrame>>();
function chunk(type: string, bytes: Buffer): Buffer {
  const result = Buffer.allocUnsafe(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0); result.write(type, 4, 4, "ascii"); bytes.copy(result, 8);
  result.writeUInt32BE(Bun.hash.crc32(result.subarray(4, bytes.length + 8)) >>> 0, bytes.length + 8);
  return result;
}
export function encodeNativeFramePng(frame: Uint8Array, receivedAt = Date.now()): Promise<EncodedNativeFrame> {
  // Revalidate even cached bytes; encoding does not renew capture evidence.
  const header = inspectVideoFrame(frame, receivedAt);
  if (!header) return Promise.reject(new RuntimeFault("stale_context", "Native image is malformed, stale or future-dated"));
  const cached = encodes.get(frame); if (cached) return cached;
  const pending = (async () => {
    const stride = header.width * 4, rows = Buffer.allocUnsafe((stride + 1) * header.height);
    for (let y = 0; y < header.height; y++) {
      const offset = y * (stride + 1); rows[offset] = 0;
      const source = header.headerBytes + (header.bottomUp ? header.height - 1 - y : y) * stride;
      rows.set(frame.subarray(source, source + stride), offset + 1);
      // Match the game viewer without changing RGB or the source packet.
      for (let x = 0; x < stride; x += 4) rows[offset + x + 4] = 255;
    }
    const compression = Promise.withResolvers<Buffer>();
    deflate(rows, { level: 1, chunkSize: 256 * 1024 },
      (error, value) => error ? compression.reject(error) : compression.resolve(value));
    const compressed = await compression.promise;
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(header.width, 0); ihdr.writeUInt32BE(header.height, 4); ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
    if (png.length > 9 * 1024 * 1024) throw new RuntimeFault("backend_unavailable", "Encoded native PNG exceeds finite codec bound");
    return { png, sequence: header.sequence, capturedAt: header.capturedAt, width: header.width, height: header.height };
  })();
  encodes.set(frame, pending); return pending;
}
export function presentActorFrame(png: Buffer): ActorFramePresentation {
  if (png.length > 2 * 1024 * 1024) throw new RuntimeFault("backend_unavailable", "Actor PNG exceeds the two MiB image bound");
  return { data: png.toString("base64"), encoded_bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") };
}
