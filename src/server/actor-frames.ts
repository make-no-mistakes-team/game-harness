import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ObservationV3 } from "../shared/contracts.ts";
import type { ScreenRef, SpaceRef } from "../shared/control.ts";
import { inspectVideoFrame } from "./video.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { encodeNativeFramePng, presentActorFrame } from "./actor-frame-codec.ts";
import { ActorFrameEncodingClient, type ActorFrameEncodingOptions } from "./actor-frame-client.ts";
import { ACTOR_FRAME_LIMITS } from "./actor-frame-protocol.ts";
import { osMonotonicNs } from "./os-monotonic.ts";

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
export class ActorFrameSelector {
  private priorScope: string | null = null;
  private readonly invalidPackets = new WeakSet<Uint8Array>();
  private readonly encoder: ActorFrameEncodingClient | null;
  private closed = false;
  constructor(private readonly options: { latestFrame(): Uint8Array | null; scope(): FrameScope | null;
    encode?: typeof encodeNativeFramePng }) {
    this.encoder = options.encode ? null : new ActorFrameEncodingClient();
  }
  close(): Promise<void> { this.closed = true; return this.encoder?.close() ?? Promise.resolve(); }
  async select(options?: ActorFrameEncodingOptions): Promise<{ images: ImageContent[]; metadata: ActorImageMetadata }> {
    const deadlineOsNs = options?.deadlineOsNs ?? osMonotonicNs() + BigInt(ACTOR_FRAME_LIMITS.jobMs) * 1_000_000n;
    if (this.closed || options?.signal?.aborted || osMonotonicNs() >= deadlineOsNs)
      throw new RuntimeFault("backend_unavailable", "Actor image selection is closed, cancelled or expired");
    const scope = this.options.scope(), frame = this.options.latestFrame();
    const key = JSON.stringify(scope);
    if (this.priorScope !== null && key !== this.priorScope && frame) this.invalidPackets.add(frame);
    this.priorScope = key;
    if (!scope || !frame || this.invalidPackets.has(frame)) throw new RuntimeFault("stale_context", "No current-scope native image is available");
    const header = inspectVideoFrame(frame);
    if (!header) throw new RuntimeFault("stale_context", "Native image is malformed, stale or future-dated");
    const presentation = this.options.encode
      ? presentActorFrame((await this.options.encode(frame)).png)
      : await this.encoder!.encode(frame, { deadlineOsNs, signal: options?.signal });
    const currentKey = JSON.stringify(this.options.scope());
    if (currentKey !== key) {
      this.invalidPackets.add(frame);
      const buffered = this.options.latestFrame();
      if (buffered) this.invalidPackets.add(buffered);
      // Neither the in-flight packet nor the buffer held at revocation can be
      // relabeled. A later real delivery may enter the replacement scope.
      this.priorScope = currentKey;
      throw new RuntimeFault("stale_context", "Native image selection authority changed during encoding");
    }
    if (this.closed || options?.signal?.aborted || osMonotonicNs() >= deadlineOsNs)
      throw new RuntimeFault("backend_unavailable", "Actor image selection was closed, cancelled or expired during encoding");
    if (!inspectVideoFrame(frame)) throw new RuntimeFault("stale_context", "Native image expired during encoding");
    return { images: [{ type: "image", mimeType: "image/png", data: presentation.data }], metadata: {
      // Identity comes exclusively from the admitted original native header.
      sequence: header.sequence, capturedAt: header.capturedAt, width: header.width, height: header.height,
      encoded_bytes: presentation.encoded_bytes, sha256: presentation.sha256,
      host_selection_scope: { ...scope }, alignment: "unsynchronized", pixel_presentation: "opaque_rgb",
    } };
  }
}
