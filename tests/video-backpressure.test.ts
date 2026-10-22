import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { VideoStream, type VideoSocketData } from "../src/server/video.ts";

const WIDTH = 1280;
const HEIGHT = 720;
const FRAME_BYTES = 32 + WIDTH * HEIGHT * 4;
const WORKER_ARGUMENT = "--video-backpressure-worker";

async function exerciseSlowReader() {
  const video = new VideoStream();
  let transport: ServerWebSocket<VideoSocketData> | undefined;
  const server = Bun.serve<VideoSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { expires: Date.now() + 15_000, lastSequence: null },
        })
      )
        return;
      return new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      ...video.handlers,
      open(socket) {
        // Retain the real upgraded socket solely for teardown, not assertions.
        transport = socket;
        video.handlers.open?.(socket);
      },
    },
  });
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  const started = performance.now();
  const completion = Promise.withResolvers<void>();
  let socket: Socket | undefined;
  let resumeTimer: NodeJS.Timeout | undefined;
  let publishTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let failure: string | undefined;
  let upgraded = false;
  let handshake = Buffer.alloc(0);
  // Streaming RFC6455 parsing retains only the framing and native headers,
  // never an unbounded collection of multi-megabyte RGBA payloads.
  const framing = Buffer.alloc(10);
  const header = Buffer.alloc(32);
  let framingUsed = 0;
  let framingNeeded = 2;
  let remaining = 0;
  let payloadOffset = 0;
  let received = 0;
  let firstSequence = 0;
  let lastSequence = 0;
  let sequence = 0;
  let finalSequence = 0;
  let maxBuffered = 0;
  let slow = true;
  let snapshot = video.snapshot();

  function publish() {
    const frame = new Uint8Array(FRAME_BYTES);
    const view = new DataView(frame.buffer);
    view.setUint32(0, 0x47485631, true);
    view.setUint32(4, WIDTH, true);
    view.setUint32(8, HEIGHT, true);
    view.setUint32(12, WIDTH * HEIGHT * 4, true);
    view.setUint32(16, ++sequence, true);
    view.setFloat64(24, Date.now(), true);
    video.publish(frame);
  }

  function parse(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining === 0) {
        const count = Math.min(
          framingNeeded - framingUsed,
          chunk.length - offset,
        );
        chunk.copy(framing, framingUsed, offset, offset + count);
        framingUsed += count;
        offset += count;
        if (framingUsed < framingNeeded) continue;
        if (framingNeeded === 2) {
          if (framing[0] !== 0x82 || (framing[1]! & 0x80) !== 0)
            throw new Error(
              "Expected a complete, unmasked binary WebSocket frame",
            );
          const marker = framing[1]! & 0x7f;
          framingNeeded = marker === 127 ? 10 : marker === 126 ? 4 : 2;
          if (framingUsed < framingNeeded) continue;
        }
        const marker = framing[1]! & 0x7f;
        const length =
          marker === 127
            ? Number(framing.readBigUInt64BE(2))
            : marker === 126
              ? framing.readUInt16BE(2)
              : marker;
        if (length !== FRAME_BYTES)
          throw new Error(`Unexpected WebSocket payload length ${length}`);
        remaining = length;
        payloadOffset = 0;
        framingUsed = 0;
        framingNeeded = 2;
      }
      const count = Math.min(remaining, chunk.length - offset);
      if (payloadOffset < 32) {
        chunk.copy(
          header,
          payloadOffset,
          offset,
          offset + Math.min(count, 32 - payloadOffset),
        );
      }
      offset += count;
      payloadOffset += count;
      remaining -= count;
      if (remaining === 0) {
        if (
          header.readUInt32LE(0) !== 0x47485631 ||
          header.readUInt32LE(4) !== WIDTH ||
          header.readUInt32LE(8) !== HEIGHT ||
          header.readUInt32LE(12) !== WIDTH * HEIGHT * 4
        )
          throw new Error("Corrupted native video header");
        const next = header.readUInt32LE(16);
        if (next <= lastSequence)
          throw new Error(
            `Video sequence did not advance: ${next} <= ${lastSequence}`,
          );
        if (received === 0) firstSequence = next;
        received++;
        lastSequence = next;
      }
    }
  }

  function fail(error: Error) {
    completion.reject(error);
  }

  try {
    // Real TCP congestion cannot use fake timers. The isolated event loop also
    // ignores clock changes in other tests; no application server is involved.
    deadlineTimer = setTimeout(
      () => fail(new Error("Video delivery stalled")),
      8000,
    );
    socket = createConnection({ host: "127.0.0.1", port: server.port! });
    socket.setNoDelay(true);
    socket.on("error", fail);
    socket.on("end", () => fail(new Error("Unexpected video transport EOF")));
    socket.on("connect", () =>
      socket!.write(
        `GET /video HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      try {
        if (!upgraded) {
          if (handshake.length + chunk.length > 4096)
            throw new Error("Oversized WebSocket upgrade response");
          handshake = Buffer.concat([handshake, chunk]);
          const end = handshake.indexOf("\r\n\r\n");
          if (end < 0) return;
          const response = handshake.subarray(0, end).toString();
          if (
            !response.startsWith("HTTP/1.1 101 ") ||
            !response.includes(accept)
          )
            throw new Error("Invalid WebSocket upgrade response");
          upgraded = true;
          parse(handshake.subarray(end + 4));
          handshake = Buffer.alloc(0);
          socket!.pause();
          resumeTimer = setTimeout(() => socket!.resume(), 300);
          publish();
          publishTimer = setInterval(publish, 33);
          return;
        }
        parse(chunk);
        if (slow) {
          socket!.pause();
          resumeTimer = setTimeout(() => socket!.resume(), 15);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    pollTimer = setInterval(() => {
      const snapshot = video.snapshot();
      for (const client of snapshot.clients)
        maxBuffered = Math.max(maxBuffered, client.buffered_bytes);
      if (
        upgraded &&
        finalSequence === 0 &&
        performance.now() - started >= 2200
      ) {
        clearInterval(publishTimer);
        publish();
        finalSequence = sequence;
        slow = false;
        clearTimeout(resumeTimer);
        socket!.resume();
      }
      // A queued send alone is insufficient: consume the entire final payload
      // after repeated congestion and require the real server queue to empty.
      if (
        finalSequence > 0 &&
        lastSequence === finalSequence &&
        snapshot.clients.length === 1 &&
        snapshot.clients[0]!.buffered_bytes === 0
      )
        completion.resolve();
    }, 10);
    await completion.promise;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(resumeTimer);
    clearInterval(publishTimer);
    clearInterval(pollTimer);
    // Capture assertions before terminate()/close() remove the live client.
    snapshot = video.snapshot();
    socket?.destroy();
    transport?.terminate();
  }
  const report = {
    failure,
    elapsed_ms: Math.round(performance.now() - started),
    received_frames: received,
    first_sequence: firstSequence,
    last_sequence: lastSequence,
    final_sequence: finalSequence,
    incomplete_payload_bytes: remaining,
    max_buffered_bytes: maxBuffered,
    snapshot,
  };
  video.close();
  void server.stop(true);
  return report;
}

if (process.argv.includes(WORKER_ARGUMENT)) {
  const report = await exerciseSlowReader();
  console.log(JSON.stringify(report));
  // Bun can leave stop(true)'s promise pending after a WebSocket close callback.
  // The isolated process owns every socket, so exiting also guarantees teardown.
  process.exit(report.failure ? 1 : 0);
} else {
  test("large video frames recover across repeated real TCP backpressure", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(import.meta.url),
        WORKER_ARGUMENT,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), 9000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr, stdout }).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      const report = JSON.parse(stdout);
      expect(report.failure).toBeUndefined();
      expect(report.received_frames).toBeGreaterThanOrEqual(4);
      expect(report.last_sequence).toBeGreaterThan(report.first_sequence);
      expect(report.last_sequence).toBe(report.final_sequence);
      expect(report.incomplete_payload_bytes).toBe(0);
      expect(report.max_buffered_bytes).toBeGreaterThan(0);
      expect(report.max_buffered_bytes).toBeLessThanOrEqual(
        FRAME_BYTES + 65536,
      );
      expect(report.snapshot.queued_sends).toBeGreaterThanOrEqual(3);
      expect(report.snapshot.drain_events).toBeGreaterThanOrEqual(3);
      expect(report.snapshot.rejected_sends).toBe(0);
      expect(report.snapshot.backpressure_skips).toBeGreaterThan(0);
      expect(report.snapshot.clients).toEqual([
        {
          ready_state: WebSocket.OPEN,
          buffered_bytes: 0,
          last_sequence: report.final_sequence,
        },
      ]);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);
}
