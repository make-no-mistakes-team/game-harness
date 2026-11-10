package io.gameharness.nativeclient;

/**
 * One admitted 50 ms simulation interval, partitioned by vanilla's render tick fraction.
 * No wall clock, extrapolation, queued intervals or allocations on the sampling path.
 * The next real tick must settle the old interval before admitting its replacement.
 */
public final class SimulationViewMotion {
  private long tick = -1;
  private double fraction, yawPerTick, pitchPerTick, yaw, pitch;
  private boolean pending;

  public void begin(long tick, double yawPerTick, double pitchPerTick) {
    if (pending) throw new IllegalStateException("Settle or discard the prior view interval first");
    if (tick <= this.tick) throw new IllegalArgumentException("View intervals require advancing simulation ticks");
    this.tick = tick;
    this.yawPerTick = yawPerTick; this.pitchPerTick = pitchPerTick;
    fraction = yaw = pitch = 0;
    pending = true;
  }

  /** Returns only the as-yet unapplied fraction; repeated/backwards samples never replay motion. */
  public void sample(double progress) {
    yaw = pitch = 0;
    if (!pending || !Double.isFinite(progress)) return;
    double next = Math.max(fraction, Math.clamp(progress, 0, 1));
    double elapsed = next - fraction;
    yaw = yawPerTick * elapsed; pitch = pitchPerTick * elapsed;
    fraction = next;
    if (fraction == 1) pending = false;
  }

  /** Only a subsequent actual simulation tick may consume the unsampled remainder. */
  public void boundary(long nextTick) {
    sample(nextTick > tick ? 1 : fraction);
  }

  /** Cancellation discards even a fractional remainder; it must never be flushed afterward. */
  public void clear() {
    pending = false; fraction = yaw = pitch = yawPerTick = pitchPerTick = 0;
  }

  public boolean pending() { return pending; }
  public double yaw() { return yaw; }
  public double pitch() { return pitch; }
}
