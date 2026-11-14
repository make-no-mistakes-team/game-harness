import { z } from "zod";
import { MAX_NATIVE_VIDEO_FRAME_BYTES } from "../shared/video.ts";

// One request per inference process, no waiting frames and no per-frame ACKs.
export const ACTOR_FRAME_LIMITS = Object.freeze({ frameBytes: MAX_NATIVE_VIDEO_FRAME_BYTES,
  requestHeaderBytes: 256, pngBytes: 2 * 1024 * 1024, responseBytes: 2_797_000, jobMs: 1500 });
export const ACTOR_FRAME_PROTOCOL_VERSION = 1;
export const actorFrameRequestSchema = z.object({ v: z.literal(ACTOR_FRAME_PROTOCOL_VERSION),
  frame_bytes: z.number().int().min(1).max(ACTOR_FRAME_LIMITS.frameBytes),
  received_at: z.number().finite().nonnegative(), deadline_os_ns: z.string().regex(/^\d{1,24}$/),
}).strict();
export const actorFrameResponseSchema = z.object({ v: z.literal(ACTOR_FRAME_PROTOCOL_VERSION),
  worker_pid: z.number().int().positive(), encoded_bytes: z.number().int().min(1).max(ACTOR_FRAME_LIMITS.pngBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().min(4).max(4 * Math.ceil(ACTOR_FRAME_LIMITS.pngBytes / 3)),
}).strict();
export type ActorFrameResponse = z.infer<typeof actorFrameResponseSchema>;
