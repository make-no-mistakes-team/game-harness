# Actor images, live view and recording

Native final-framebuffer capture follows world, hand and HUD. Authentic video remains separate from control and perception authorization. A stale/error view is never replaced by synthetic footage.

## Actor image

`Runtime.modelObservation()` provides initial strategic/observe structured state, one typed PNG and separate metadata. Worker observe stays JSON-only. Codec flips native bottom-up rows, preserves every RGB byte and sets alpha to 255 because display is opaque; metadata says opaque RGB. PNG cap is 2 MiB; stale/malformed/oversize fails explicitly.

Host rechecks run/session/life/generation and original capture freshness after encoding. Image scope is **host selection**, explicitly unsynchronized with structured state—not capture-time life/camera/space proof. Rich GHV2 diagnostics stay outside actor metadata.

Default selector owns one subprocess/image and one active encode/no frame queue. Buffer-view transport avoids base64 request copying. Pixel copy/reorientation/alpha/compression/assembly/hash/base64 plus actual process/pipe closure share original 1,500-ms CLOCK_MONOTONIC window. No local fallback. Runtime/cancel join it.

After old buffered frame rejection, subscription may await one fresh delivered frame within same window and recheck boot/profile/space/screen/scope; no stale/text substitution or new provider request. Fixed preparation-stage/scope-change diagnostics do not leak exception bodies or identify a nearby handoff as cause.

Model modality comes from actual discovered SDK descriptor. Non-image model rejects before actor inference; synthetic no-frame source explicitly disables image mode. Advertised image support is not live vision proof. Store tool events retain metadata, not binary.

## Packet and live transport

GHV2 is a fixed 328-byte little-endian header plus RGBA8. [`video.ts`](../../src/shared/video.ts) binds packet sequence to readback interval, tick, render invocation, capture-life/space/generation and capture-tail screen. Captured world-render camera/quaternion/position/projection are actual invocation facts, not later reconstructed player pose.

Missing/invalidated/different-invocation world sample is unavailable. Capture-tail screen does not prove exact screen-render transaction. GHV1 has no live alias; historical artifacts stay unchanged. Capture modules/codec/process/monotonic source participate in native build fingerprint.

Native uses three reusable framebuffers. Writer drains ordered packet plus at most two waiting successors; saturation replaces oldest waiting and counts replacement, never overwrites socket-owned packet or blocks render thread on network. This can add latency/explicit gaps.

Desktop same-origin authenticated WebSocket is latest-frame bounded with finite viewers/backpressure, no input/token-bearing query. Renderer is readonly with idle/starting/streaming/stale/error. Target 1280×720 at 30 FPS is not guaranteed measured performance. Human access grants no agent HTTP/raw buffers.

## Evaluation recording

Recorder subscribes directly to delivered frames independently of desktop latest-only backpressure. Ordinary live-compressed mode streams timestamped RGBA Matroska into H.264, no durable PNG spool. Five-second segments finalize at next capture boundary; ordered index preserves original capture/receive identity/orientation/pose provenance and upstream gaps.

Default finite short profile: 128 MiB pending raw including terminal frame, 12,000 frames, 600 seconds and 32 GiB segments plus canonical replay. Checked profiles can differ; insufficient total horizon rejects before external setup. Supplied files must be regular project-local files with checked size/identity and secret/database-path exclusions. Studies pin preprocessing identity. Effective renderer/journal bounds persist before inference. Invalid/misspelled overrides reject, not default/clamp.

Dimension/orientation change, invalid frame, exhaustion or encoding/persistence failure marks incomplete and requests Stop. Native may already omit renders. Finish joins encoder, syncs segments and closes index before sealing schema-2 manifest. Interrupted active segment does not count durable frames. Health reads counters without filesystem I/O.

Canonical MP4 assembly stream-copies sealed segments preserving native millisecond timestamps/gaps/final hold. Failure retains source segments/index. Live H.264 CRF 18/veryfast/no B-frames/bounded threads corrects bottom-up; odd sizes use yuv444p else yuv420p. Timing preservation does not preserve exact RGB. Audio is absent.

Explicit lossless PNG mode retains schema-1 PNG/index/concat pipeline. Frozen pixel-evidence studies explicitly select it; model-visible exact PNGs stay separate in either mode. Decoded compressed frames are not pixel-exact replacements.

Lossless offline derivative preserves millisecond presentation (not a forced 25-FPS grid/B-frame endpoint), verifies sealed concat hash and local-file-only protocols. It does not rewrite historical sources.

Trusted replay calls may declare positive safe-integer combined source+output byte ceiling; reject invalid bound before output and check each chunk. Source still fits unchanged manifest capture ceiling. Abort/failure joins process/output handle. Omitted ceiling retains compressed manifest-derived combined bound; explicit bound never amends sealed manifest/experiment allowance.

Fast lossless PNG deflate uses bounded 256-KiB chunks to avoid pinned Bun 16-KiB continuation overhead under raw-video I/O; compressed bytes/storage change, not pixels/permissions/caps. Component evidence is separate from complete native stall/Stop qualification.

Complete capture means declared **delivered-frame representation**, not every render, synchronized state/RGB, visual approval, trusted goal, audio, in-app replay or world rewind. Full private originals require publication review; explicit payload expiry records current availability beyond old manifests.

Sources: [`evidence-limits.ts`](../../src/shared/evidence-limits.ts), [`recording.ts`](../../src/server/recording.ts), [`actor-frames.ts`](../../src/server/actor-frames.ts). See [timing](timing.md), [runtime evidence](../evidence/runtime-processes.md), [evaluation policy](../evaluation/policy.md).
