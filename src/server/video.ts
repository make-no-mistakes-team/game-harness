import type { ServerWebSocket, WebSocketHandler } from "bun";
import { decodeNativeVideoHeader, MAX_NATIVE_VIDEO_FRAME_BYTES, type NativeVideoHeader } from "../shared/video.ts";

export interface VideoSocketData {
  expires: number;
  lastSequence: number | null;
}

export function inspectVideoFrame(
  frame: Uint8Array,
  now = Date.now(),
): NativeVideoHeader | null {
  const header = decodeNativeVideoHeader(frame);
  if (
    !header ||
    frame.byteLength !== header.headerBytes + header.width * header.height * 4 ||
    header.capturedAt > now + 2000 ||
    now - header.capturedAt > 5000
  )
    return null;
  return header;
}

export class VideoStream {
  private readonly clients = new Set<ServerWebSocket<VideoSocketData>>();
  private readonly pendingDrains = new Set<ServerWebSocket<VideoSocketData>>();
  private frame: Uint8Array | null = null;
  private header: NativeVideoHeader | null = null;
  private published = 0;
  private sends = 0;
  private queuedSends = 0;
  private rejectedSends = 0;
  private backpressureSkips = 0;
  private drains = 0;

  constructor(private readonly onTiming?: (milliseconds: number) => void) {}

  readonly handlers: WebSocketHandler<VideoSocketData> = {
    maxPayloadLength: 1024,
    backpressureLimit: MAX_NATIVE_VIDEO_FRAME_BYTES + 65536,
    closeOnBackpressureLimit: true,
    idleTimeout: 60,
    sendPings: true,
    open: (socket) => {
      if (this.clients.size >= 4) {
        socket.close(1013, "The local viewer limit has been reached");
        return;
      }
      this.clients.add(socket);
      this.send(socket);
    },
    message: (socket) => {
      socket.close(1008, "The game view is read-only");
    },
    drain: (socket) => {
      this.drains++;
      if (this.pendingDrains.has(socket)) return;
      this.pendingDrains.add(socket);
      // Inline sends here strand queued large frames on Bun 1.3.14.
      setImmediate(() => {
        this.pendingDrains.delete(socket);
        if (this.clients.has(socket) && socket.readyState === WebSocket.OPEN)
          this.send(socket);
      });
    },
    close: (socket) => {
      this.clients.delete(socket);
      this.pendingDrains.delete(socket);
    },
  };

  publish(frame: Uint8Array): void {
    const start = performance.now();
    const header = inspectVideoFrame(frame);
    if (!header) return;
    this.published++;
    this.frame = frame;
    this.header = header;
    for (const client of this.clients) this.send(client);
    this.onTiming?.(performance.now() - start);
  }

  clear(): void {
    this.frame = null;
    this.header = null;
    for (const client of this.clients) client.data.lastSequence = null;
  }

  snapshot() {
    return {
      published_frames: this.published,
      send_attempts: this.sends,
      queued_sends: this.queuedSends,
      rejected_sends: this.rejectedSends,
      backpressure_skips: this.backpressureSkips,
      drain_events: this.drains,
      clients: [...this.clients].map((client) => ({
        ready_state: client.readyState,
        buffered_bytes: client.getBufferedAmount(),
        last_sequence: client.data.lastSequence,
      })),
    };
  }

  close(): void {
    this.clear();
    for (const client of this.clients)
      client.close(1001, "GameHarness is closing");
    this.clients.clear();
    this.pendingDrains.clear();
  }

  private send(socket: ServerWebSocket<VideoSocketData>): void {
    if (socket.data.expires <= Date.now()) {
      socket.close(1008, "The local session expired");
      return;
    }
    if (
      !this.frame ||
      !this.header ||
      Date.now() - this.header.capturedAt > 5000 ||
      socket.data.lastSequence === this.header.sequence
    )
      return;
    if (socket.getBufferedAmount() > 0) {
      this.backpressureSkips++;
      return;
    }
    this.sends++;
    const result = socket.send(this.frame, false);
    if (result === -1) this.queuedSends++;
    else if (result === 0) this.rejectedSends++;
    if (result !== 0) socket.data.lastSequence = this.header.sequence;
  }
}
