export const NATIVE_VIDEO_MAGIC = 0x47485632;
export const NATIVE_VIDEO_HEADER_BYTES = 328;
export const MAX_NATIVE_VIDEO_FRAME_BYTES = NATIVE_VIDEO_HEADER_BYTES + 1920 * 1080 * 4;

export interface NativeVideoRenderSnapshot {
  sampled_ns: string;
  position: { x: number; y: number; z: number };
  yaw_radians: number;
  pitch_radians: number;
  quaternion: number[];
  position_matrix: number[];
  projection_matrix: number[];
  tick_delta: number;
}
export interface NativeVideoScreenCapture {
  screen_id: string;
  incarnation: number;
  revision: number;
}
/** Capture diagnostics are not authority or RGB/structured-observation synchronization. */
export interface NativeVideoCapture {
  schema_version: 1;
  readback_started_ns: string;
  readback_finished_ns: string;
  client_tick: number;
  render_invocation: number;
  life_id: number;
  space_epoch: number;
  native_generation: number;
  screen: NativeVideoScreenCapture | null;
  render: NativeVideoRenderSnapshot | null;
}
export interface NativeVideoHeader {
  width: number;
  height: number;
  sequence: number;
  bottomUp: boolean;
  capturedAt: number;
  headerBytes: number;
  capture: NativeVideoCapture;
}
const MAX_SAFE_COUNTER = BigInt(Number.MAX_SAFE_INTEGER);

/** Pure structural admission. A complete header is sufficient; callers own payload completeness and freshness. */
export function decodeNativeVideoHeader(bytes: Uint8Array): NativeVideoHeader | null {
  if (bytes.byteLength < NATIVE_VIDEO_HEADER_BYTES || bytes.byteLength > MAX_NATIVE_VIDEO_FRAME_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, NATIVE_VIDEO_HEADER_BYTES);
  if (view.getUint32(0, true) !== NATIVE_VIDEO_MAGIC) return null;
  const width = view.getUint32(4, true), height = view.getUint32(8, true);
  const bottomUp = view.getUint32(20, true), capturedAt = view.getFloat64(24, true);
  const flags = view.getUint32(312, true);
  if (width < 1 || width > 1920 || height < 1 || height > 1080 ||
      view.getUint32(12, true) !== width * height * 4 || bottomUp > 1 ||
      !Number.isFinite(capturedAt) || capturedAt < 0 || flags > 3 || view.getUint32(316, true) !== 1) return null;
  const started = view.getBigInt64(32, true), finished = view.getBigInt64(40, true), sampled = view.getBigInt64(48, true);
  if (finished < started || ((flags & 1) !== 0 && sampled > started)) return null;
  for (const offset of [56, 64, 72, 80, 88, 296, 304])
    if (view.getBigUint64(offset, true) > MAX_SAFE_COUNTER) return null;
  // Check even unavailable snapshot slots: nonfinite wire data is never trusted.
  for (const offset of [96, 104, 112, 136, 144, 320])
    if (!Number.isFinite(view.getFloat64(offset, true))) return null;
  for (let offset = 120; offset < 136; offset += 4)
    if (!Number.isFinite(view.getFloat32(offset, true))) return null;
  for (let offset = 152; offset < 280; offset += 4)
    if (!Number.isFinite(view.getFloat32(offset, true))) return null;
  const scalars = (offset: number, length: number) => Array.from({ length }, (_, index) => view.getFloat32(offset + index * 4, true));
  let screen: NativeVideoScreenCapture | null = null;
  if ((flags & 2) !== 0) {
    const uuid = view.getBigUint64(280, true).toString(16).padStart(16, "0") + view.getBigUint64(288, true).toString(16).padStart(16, "0");
    screen = { screen_id: `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`,
      incarnation: Number(view.getBigUint64(296, true)), revision: Number(view.getBigUint64(304, true)) };
  }
  return {
    width, height, sequence: view.getUint32(16, true), bottomUp: bottomUp === 1, capturedAt, headerBytes: NATIVE_VIDEO_HEADER_BYTES,
    capture: {
      schema_version: 1, readback_started_ns: started.toString(), readback_finished_ns: finished.toString(),
      client_tick: Number(view.getBigUint64(56, true)), render_invocation: Number(view.getBigUint64(64, true)),
      life_id: Number(view.getBigUint64(72, true)), space_epoch: Number(view.getBigUint64(80, true)),
      native_generation: Number(view.getBigUint64(88, true)), screen,
      render: (flags & 1) === 0 ? null : {
        sampled_ns: sampled.toString(), position: { x: view.getFloat64(96, true), y: view.getFloat64(104, true), z: view.getFloat64(112, true) },
        yaw_radians: view.getFloat64(136, true), pitch_radians: view.getFloat64(144, true),
        quaternion: scalars(120, 4), position_matrix: scalars(152, 16), projection_matrix: scalars(216, 16), tick_delta: view.getFloat64(320, true),
      },
    },
  };
}
