package io.gameharness.nativeclient;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.nio.ByteBuffer;
import java.util.UUID;

/** Fixed scalar storage for the actual world-render inputs, scoped to one render invocation. */
public final class NativeRenderSnapshot {
  public static final int HEADER_BYTES = 328;
  public final float[] positionMatrix = new float[16];
  public final float[] projectionMatrix = new float[16];
  private long invocation, sampled, life, space;
  private boolean open;
  private volatile boolean valid;
  private double x, y, z, yaw, pitch, tickDelta;
  private float qx, qy, qz, qw;
  private String screenId;
  private long screenMost, screenLeast;
  private static final long MAX_CAPTURE_AGE_NS = 5_000_000_000L;
  private boolean capturedWorld;
  private long captureSequence, captureTick, captureInvocation, captureSampled, captureNanos;
  private long captureLife, captureSpace;
  private double captureX, captureY, captureZ, captureYaw, capturePitch;

  public void begin() {
    valid = false;
    open = true;
    invocation = ContractIdentity.next(invocation);
  }

  public void invalidate() { valid = false; capturedWorld = false; }
  public void end() { open = false; valid = false; }
  public long invocation() { return invocation; }

  /** Matrices must already have been copied into the owned arrays by the same START callback. */
  public void sample(long nanos, long lifeId, long spaceEpoch, double px, double py, double pz,
      float rx, float ry, float rz, float rw, double yawRadians, double pitchRadians, double delta) {
    valid = false;
    if (!open || !Double.isFinite(px) || !Double.isFinite(py) || !Double.isFinite(pz)
        || !Float.isFinite(rx) || !Float.isFinite(ry) || !Float.isFinite(rz) || !Float.isFinite(rw)
        || !Double.isFinite(yawRadians) || !Double.isFinite(pitchRadians) || !Double.isFinite(delta)) return;
    for (int i = 0; i < 16; i++)
      if (!Float.isFinite(positionMatrix[i]) || !Float.isFinite(projectionMatrix[i])) return;
    sampled = nanos; life = lifeId; space = spaceEpoch;
    x = px; y = py; z = pz; qx = rx; qy = ry; qz = rz; qw = rw;
    yaw = yawRadians; pitch = pitchRadians; tickDelta = delta;
    valid = true;
  }

  public void header(ByteBuffer frame, int width, int height, int sequence, double wallMillis,
      long readbackStarted, long tick, long lifeId, long spaceEpoch, long generation,
      EffectAuthority.Screen tailScreen) {
    boolean world = open && valid && life == lifeId && space == spaceEpoch && sampled <= readbackStarted;
    if (tailScreen != null && !tailScreen.id().equals(screenId)) {
      UUID id = UUID.fromString(tailScreen.id());
      screenMost = id.getMostSignificantBits();
      screenLeast = id.getLeastSignificantBits();
      screenId = tailScreen.id();
    }
    frame.putInt(0x47485632).putInt(width).putInt(height).putInt(width * height * 4)
        .putInt(sequence).putInt(1).putDouble(wallMillis)
        .putLong(readbackStarted).putLong(0).putLong(world ? sampled : 0)
        .putLong(ContractIdentity.checked(tick)).putLong(invocation)
        .putLong(ContractIdentity.checked(lifeId)).putLong(ContractIdentity.checked(spaceEpoch))
        .putLong(ContractIdentity.checked(generation));
    frame.putDouble(world ? x : 0).putDouble(world ? y : 0).putDouble(world ? z : 0);
    frame.putFloat(world ? qx : 0).putFloat(world ? qy : 0)
        .putFloat(world ? qz : 0).putFloat(world ? qw : 0);
    frame.putDouble(world ? yaw : 0).putDouble(world ? pitch : 0);
    for (int i = 0; i < 16; i++) frame.putFloat(world ? positionMatrix[i] : 0);
    for (int i = 0; i < 16; i++) frame.putFloat(world ? projectionMatrix[i] : 0);
    frame.putLong(tailScreen == null ? 0 : screenMost)
        .putLong(tailScreen == null ? 0 : screenLeast)
        .putLong(tailScreen == null ? 0 : ContractIdentity.checked(tailScreen.incarnation()))
        .putLong(tailScreen == null ? 0 : ContractIdentity.checked(tailScreen.revision()))
        .putInt((world ? 1 : 0) | (tailScreen == null ? 0 : 2)).putInt(1)
        .putDouble(world ? tickDelta : 0);
    capturedWorld = world;
    if (world) {
      captureSequence = Integer.toUnsignedLong(sequence);
      captureTick = tick; captureInvocation = invocation;
      captureSampled = sampled; captureNanos = readbackStarted;
      captureLife = lifeId; captureSpace = spaceEpoch;
      captureX = x; captureY = y; captureZ = z;
      captureYaw = yaw; capturePitch = pitch;
    }
  }

  /** Actor-safe scalars for the named produced header, never the latest uncaptured render. */
  public JsonElement actorCapture(long lifeId, long spaceEpoch, long now) {
    long age = now - captureNanos;
    if (!capturedWorld || captureLife != lifeId || captureSpace != spaceEpoch
        || now < captureNanos || age < 0 || age > MAX_CAPTURE_AGE_NS) return JsonNull.INSTANCE;
    JsonObject value = new JsonObject(), position = new JsonObject();
    value.addProperty("capture_sequence", captureSequence);
    value.addProperty("client_tick", captureTick);
    value.addProperty("render_invocation", captureInvocation);
    value.addProperty("sampled_native_ns", Long.toString(captureSampled));
    value.addProperty("capture_native_ns", Long.toString(captureNanos));
    position.addProperty("x", captureX); position.addProperty("y", captureY); position.addProperty("z", captureZ);
    value.add("position", position);
    value.addProperty("yaw_radians", captureYaw);
    value.addProperty("pitch_radians", -capturePitch);
    return value;
  }

  public void finished(ByteBuffer frame, long nanos) { frame.putLong(40, nanos); }
}
