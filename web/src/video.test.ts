import { expect, test } from "bun:test";
import { classifyVideoFrame, NativeVideo } from "./video.ts";

function frame(capturedAt: number): ArrayBuffer {
  const buffer = new ArrayBuffer(332);
  const header = new DataView(buffer);
  header.setUint32(0, 0x47485632, true);
  header.setUint32(4, 1, true);
  header.setUint32(8, 1, true);
  header.setUint32(12, 4, true);
  header.setUint32(16, 1, true);
  header.setUint32(20, 1, true);
  header.setFloat64(24, capturedAt, true);
  header.setUint32(316, 1, true);
  return buffer;
}

test("aged valid frames are stale, and the next fresh frame is still admitted", () => {
  expect(classifyVideoFrame(frame(980_000), 1_000_000)).toBe("stale");
  expect(classifyVideoFrame(frame(999_950), 1_000_000)).toBe("fresh");
});

test("clock-shifted valid frames are stale rather than malformed", () => {
  expect(classifyVideoFrame(frame(1_020_000), 1_000_000)).toBe("stale");
  expect(classifyVideoFrame(frame(990_000), 1_000_000)).toBe("stale");
});

test("a frame queued before suspension is no longer drawable after it ages", () => {
  const queued = frame(1_000_000);
  expect(classifyVideoFrame(queued, 1_000_050)).toBe("fresh");
  expect(classifyVideoFrame(queued, 1_011_000)).toBe("stale");
});

test("malformed structure and nonbinary messages are not classified as stale", () => {
  const malformed = frame(980_000);
  new DataView(malformed).setUint32(0, 0, true);
  expect(classifyVideoFrame(malformed, 1_000_000)).toBe("malformed");
  expect(classifyVideoFrame("not a binary frame", 1_000_000)).toBe("malformed");
  expect(classifyVideoFrame(frame(Number.NaN), 1_000_000)).toBe("malformed");
  expect(classifyVideoFrame(new ArrayBuffer(31), 1_000_000)).toBe("malformed");
});

test("browser rejects unsafe capture metadata and a missing or extra RGBA byte", () => {
  const unsafe = frame(1_000_000);
  new DataView(unsafe).setBigUint64(64, 9007199254740992n, true);
  expect(classifyVideoFrame(unsafe, 1_000_000)).toBe("malformed");
  expect(classifyVideoFrame(frame(1_000_000).slice(0, 331), 1_000_000)).toBe("malformed");
  const extra = new Uint8Array(333); extra.set(new Uint8Array(frame(1_000_000)));
  expect(classifyVideoFrame(extra.buffer, 1_000_000)).toBe("malformed");
});

test("renderer uploads only the latest original RGBA payload with its own orientation, not capture-header bytes", () => {
  // Bun has no browser GPU. Observe the real renderer's WebGL upload boundary,
  // while retaining real packet admission, pending-frame replacement and RAF.
  const uploads: number[][] = [], flips: number[] = [], callbacks: FrameRequestCallback[] = [];
  const gl = new Proxy({}, { get(_target, key) {
    if (key === "texImage2D" || key === "texSubImage2D") return (...args: unknown[]) => uploads.push([...args[8] as Uint8Array]);
    if (key === "uniform1f") return (_location: unknown, value: number) => flips.push(value);
    if (key === "getShaderParameter" || key === "getProgramParameter") return () => true;
    if (String(key).startsWith("create") || key === "getUniformLocation") return () => ({});
    if (/^[A-Z_]+$/.test(String(key))) return 1;
    return () => {};
  } });
  let socket: BrowserSocket | undefined;
  class BrowserSocket {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(_url: URL) { socket = this; }
    close() {}
  }
  const replacements = { window: { setInterval: () => 0 }, location: { href: "http://localhost/" },
    WebSocket: BrowserSocket, requestAnimationFrame: (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; },
    cancelAnimationFrame: () => {} };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let renderer: NativeVideo | undefined;
  try {
    for (const [key, value] of Object.entries(replacements)) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const canvas = { width: 0, height: 0, getContext: () => gl, addEventListener() {} };
    renderer = new NativeVideo(canvas as unknown as HTMLCanvasElement, () => {});
    renderer.connect();
    const first = frame(Date.now()), latest = frame(Date.now());
    new Uint8Array(first).set([7, 8, 9, 0], 328);
    new Uint8Array(latest).set([10, 11, 12, 127], 328);
    socket!.onmessage!({ data: first } as MessageEvent);
    socket!.onmessage!({ data: latest } as MessageEvent);
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!(0);
    expect(uploads).toEqual([[10, 11, 12, 127]]);
    expect(flips).toEqual([1]);
    const next = frame(Date.now());
    new DataView(next).setUint32(20, 0, true);
    new Uint8Array(next).set([21, 22, 23, 0], 328);
    socket!.onmessage!({ data: next } as MessageEvent);
    callbacks.shift()!(0);
    expect(uploads).toEqual([[10, 11, 12, 127], [21, 22, 23, 0]]);
    expect(flips).toEqual([1, 0]);
    socket!.onmessage!({ data: frame(Date.now() - 11000) } as MessageEvent);
    expect(callbacks).toHaveLength(0);
  } finally {
    renderer?.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
