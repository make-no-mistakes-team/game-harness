import { encodeNativeFramePng, presentActorFrame } from "./actor-frame-codec.ts";
import { ACTOR_FRAME_LIMITS, ACTOR_FRAME_PROTOCOL_VERSION, actorFrameRequestSchema } from "./actor-frame-protocol.ts";
import { osMonotonicNs } from "./os-monotonic.ts";

for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) console[method] = () => {};
async function run() {
  // The parent closes stdin after exactly one bounded binary request. No ACK or
  // ongoing native-stream subscription is needed, and EOF never admits a prefix.
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const input of process.stdin) {
    const part = Buffer.isBuffer(input) ? input : Buffer.from(input);
    bytes += part.length;
    if (bytes > 4 + ACTOR_FRAME_LIMITS.requestHeaderBytes + ACTOR_FRAME_LIMITS.frameBytes)
      throw new Error("Actor request exceeds bound");
    parts.push(part);
  }
  const request = Buffer.concat(parts, bytes);
  parts.length = 0;
  if (request.length < 4) throw new Error("Incomplete actor request");
  const headerBytes = request.readUInt32BE(0);
  if (headerBytes < 1 || headerBytes > ACTOR_FRAME_LIMITS.requestHeaderBytes || request.length < 4 + headerBytes)
    throw new Error("Invalid actor request header");
  const header = actorFrameRequestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.subarray(4, 4 + headerBytes))));
  const deadline = BigInt(header.deadline_os_ns);
  if (request.length !== 4 + headerBytes + header.frame_bytes || osMonotonicNs() >= deadline)
    throw new Error("Actor request incomplete or expired");
  const encoded = await encodeNativeFramePng(request.subarray(4 + headerBytes), header.received_at);
  const presentation = presentActorFrame(encoded.png);
  if (osMonotonicNs() >= deadline) throw new Error("Actor encoding expired");
  const response = JSON.stringify({ v: ACTOR_FRAME_PROTOCOL_VERSION, worker_pid: process.pid, ...presentation });
  if (Buffer.byteLength(response) > ACTOR_FRAME_LIMITS.responseBytes) throw new Error("Actor response exceeds bound");
  const sent = Promise.withResolvers<void>();
  process.stdout.end(response, () => sent.resolve());
  await sent.promise;
}
process.stdout.on("error", () => { process.exitCode = 1; process.stdin.destroy(); });
void run().catch(() => { process.exitCode = 1; process.stdin.destroy(); });
