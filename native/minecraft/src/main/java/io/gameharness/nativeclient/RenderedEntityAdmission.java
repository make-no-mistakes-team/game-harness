package io.gameharness.nativeclient;

import java.util.Arrays;
import java.util.Objects;
import java.util.function.BiConsumer;

/** Bounded render witnesses, never a query against the current entity world. */
public final class RenderedEntityAdmission<K, V> {
  public static final long MAX_AGE_NS = 250_000_000L;
  private Object[] keys, values, pendingKeys, pendingValues;
  private int size, pendingSize, candidates;
  private boolean collecting, worldEnded, captured;
  private long invocation, sampled, tick, life, captureSequence;
  private long pendingInvocation, pendingSampled, pendingTick, pendingLife;
  private EffectAuthority.Space space;
  private EffectAuthority.Space pendingSpace;
  private String wallTime, pendingWallTime;

  public RenderedEntityAdmission(int capacity) {
    keys = new Object[capacity]; values = new Object[capacity];
    pendingKeys = new Object[capacity]; pendingValues = new Object[capacity];
  }

  public void invalidate() {
    Arrays.fill(keys, 0, size, null); Arrays.fill(values, 0, size, null);
    Arrays.fill(pendingKeys, 0, pendingSize, null); Arrays.fill(pendingValues, 0, pendingSize, null);
    size = pendingSize = candidates = 0; collecting = worldEnded = captured = false;
  }

  public void begin(long render, long nanos, String wall, long nativeTick, long lifeId,
      EffectAuthority.Space currentSpace) {
    // Rendering can run faster than framebuffer delivery. An uncaptured render
    // cannot replace or refresh the last completed image's immutable evidence.
    Arrays.fill(pendingKeys, 0, pendingSize, null); Arrays.fill(pendingValues, 0, pendingSize, null);
    pendingSize = candidates = 0; worldEnded = false;
    pendingInvocation = render; pendingSampled = nanos; pendingWallTime = wall; pendingTick = nativeTick;
    pendingLife = lifeId; pendingSpace = currentSpace; collecting = currentSpace != null;
  }

  /** Denied candidates consume the same private quota; no candidate count is exported. */
  public boolean candidate() { return collecting && candidates++ < 128 && pendingSize < pendingKeys.length; }

  /** Only the actual world entity renderer may supply these already-admitted immutable values. */
  public void rendered(K key, V value) {
    if (!collecting || pendingSize == pendingKeys.length) return;
    for (int i = 0; i < pendingSize; i++) if (pendingKeys[i] == key) return;
    pendingKeys[pendingSize] = key; pendingValues[pendingSize++] = value;
  }

  public void endWorld() { worldEnded = collecting; collecting = false; }

  /** Called only after successful framebuffer readback of this same render invocation. */
  public void captured(long render, long sequence, long lifeId, EffectAuthority.Space currentSpace) {
    if (!worldEnded || pendingSpace == null || pendingInvocation != render || pendingLife != lifeId || !Objects.equals(pendingSpace, currentSpace)) {
      invalidate(); return;
    }
    Object[] previousKeys = keys, previousValues = values;
    int previousSize = size;
    keys = pendingKeys; values = pendingValues; size = pendingSize;
    pendingKeys = previousKeys; pendingValues = previousValues; pendingSize = previousSize;
    invocation = pendingInvocation; sampled = pendingSampled; wallTime = pendingWallTime; tick = pendingTick;
    life = pendingLife; space = pendingSpace;
    worldEnded = false; captureSequence = sequence; captured = true;
  }

  public boolean current(long render, long lifeId, EffectAuthority.Space currentSpace, long now) {
    long age = now - sampled;
    return captured && space != null && invocation == render && life == lifeId && Objects.equals(space, currentSpace)
        && now >= sampled && age >= 0 && age <= MAX_AGE_NS;
  }

  @SuppressWarnings("unchecked")
  public V get(K key, long render, long lifeId, EffectAuthority.Space currentSpace, long now) {
    if (!current(render, lifeId, currentSpace, now)) return null;
    for (int i = 0; i < size; i++) if (keys[i] == key) return (V) values[i];
    return null;
  }

  @SuppressWarnings("unchecked")
  public void forEach(long render, long lifeId, EffectAuthority.Space currentSpace, long now, BiConsumer<K, V> consumer) {
    if (!current(render, lifeId, currentSpace, now)) return;
    for (int i = 0; i < size; i++) consumer.accept((K) keys[i], (V) values[i]);
  }

  public long invocation() { return invocation; }
  public long sampled() { return sampled; }
  public long tick() { return tick; }
  public long captureSequence() { return captureSequence; }
  public String wallTime() { return wallTime; }
  public String collectingWallTime() { return pendingWallTime; }

  /** Column-major actual view/projection matrices; coordinates are relative to the rendered camera.
   * A center outside any clip plane is conservatively denied, even if a limb remains in view. */
  public static boolean inViewport(float[] view, float[] projection, double x, double y, double z) {
    return inViewport(view, projection, x, y, z, 1);
  }

  /** Vanilla's dispatcher model stack does not include the world camera rotation. */
  public static boolean inViewport(float[] view, float[] model, float[] projection, double x, double y, double z) {
    if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)) return false;
    return inViewport(view, projection,
        model[0] * x + model[4] * y + model[8] * z + model[12],
        model[1] * x + model[5] * y + model[9] * z + model[13],
        model[2] * x + model[6] * y + model[10] * z + model[14],
        model[3] * x + model[7] * y + model[11] * z + model[15]);
  }

  private static boolean inViewport(float[] view, float[] projection, double x, double y, double z, double w) {
    if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z) || !Double.isFinite(w)) return false;
    double vx = view[0] * x + view[4] * y + view[8] * z + view[12] * w;
    double vy = view[1] * x + view[5] * y + view[9] * z + view[13] * w;
    double vz = view[2] * x + view[6] * y + view[10] * z + view[14] * w;
    double vw = view[3] * x + view[7] * y + view[11] * z + view[15] * w;
    double cx = projection[0] * vx + projection[4] * vy + projection[8] * vz + projection[12] * vw;
    double cy = projection[1] * vx + projection[5] * vy + projection[9] * vz + projection[13] * vw;
    double cz = projection[2] * vx + projection[6] * vy + projection[10] * vz + projection[14] * vw;
    double cw = projection[3] * vx + projection[7] * vy + projection[11] * vz + projection[15] * vw;
    return Double.isFinite(cx) && Double.isFinite(cy) && Double.isFinite(cz) && Double.isFinite(cw)
        && cw > 0 && cx >= -cw && cx <= cw && cy >= -cw && cy <= cw && cz >= -cw && cz <= cw;
  }
}
