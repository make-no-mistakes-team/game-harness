package io.gameharness.nativeclient;

/** A single simulation-clock cursor. Preparation is never evidence of vanilla consumption. */
public final class WorldInputState {
  private final WorldInputPlan plan;
  private final long receivedNanos, wallBound;
  private int step, tickInStep, appliedTicks, appliedSteps, edgePrefix;
  private long preparedTick = -1, consumedTick = -1, firstNanos, lastNanos, lastTick = -1;
  private boolean pending, consumed, stopped, entry;
  private double yaw, pitch;
  public WorldInputState(WorldInputPlan plan, long receivedNanos) {
    this.plan = plan; this.receivedNanos = receivedNanos;
    wallBound = (plan.totalTicks() * 50L + 2000L) * 1_000_000L;
  }
  public WorldInputPlan.Step step() { return plan.step(step); }
  public boolean held(int key) { return !stopped && !completed() && step().held(key); }
  public boolean expired(long now) { return now - receivedNanos >= wallBound; }
  public boolean prepare(long clientTick, long now) {
    if (stopped || completed() || pending || preparedTick == clientTick || expired(now)) return false;
    preparedTick = clientTick; pending = true; consumed = false; entry = tickInStep == 0;
    return true;
  }
  public boolean entry() { return entry; }
  public int entrySelection() {
    return pending && entry && !stopped && !completed() ? step().selected() : -1;
  }
  public double yawDelta() { return step().yawDelta(entry); }
  public double pitchDelta() { return step().pitchDelta(entry); }
  /** Called at handleInputEvents TAIL only after an admitted prepared tick actually entered vanilla. */
  public void consumed(long clientTick, long now) {
    if (!pending || consumed || stopped) return;
    consumed = true; consumedTick = clientTick;
    if (appliedTicks == 0) firstNanos = now;
    lastNanos = now; lastTick = clientTick; appliedTicks++;
  }
  public void injected(int count) { edgePrefix += count; }
  /** Client tick end follows movement/key sampling and records constrained actual player pose. */
  public boolean settle(long clientTick, double actualYaw, double actualPitch) {
    if (!pending || !consumed || consumedTick != clientTick) return false;
    yaw = actualYaw; pitch = actualPitch; pending = false;
    if (++tickInStep == step().ticks()) { appliedSteps++; step++; tickInStep = 0; }
    return true;
  }
  public boolean completed() { return step == plan.stepCount(); }
  /** A screen may end an already fully consumed clip, but never confirms its world consequences. */
  public boolean applicationConfirmed(String reason) {
    return completed() && (reason.equals("completed") || reason.equals("screen_opened"));
  }
  public String applicationStatus(String reason, boolean emitted) {
    if (applicationConfirmed(reason)) return "succeeded";
    if (emitted || reason.equals("screen_opened")) return "unknown";
    return reason.equals("cancelled") ? "cancelled" : "failed";
  }
  public void stop() { stopped = true; }
  public int appliedTicks() { return appliedTicks; }
  public int appliedSteps() { return appliedSteps; }
  public int edgePrefix() { return edgePrefix; }
  public long firstNanos() { return firstNanos; }
  public long lastNanos() { return lastNanos; }
  public long lastTick() { return lastTick; }
  public double yaw() { return yaw; }
  public double pitch() { return pitch; }
}
