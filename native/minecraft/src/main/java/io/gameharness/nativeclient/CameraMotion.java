package io.gameharness.nativeclient;

/** Allocation-free camera motion in native degrees (positive pitch looks down).
 *
 * <p>The caller owns one State per camera and calls advance from ONE monotonic frame source.
 * Ticks may replace targets, but must not independently advance the same camera. Large turns
 * accelerate/cruise/brake; small turns automatically use a triangular, rest-to-rest trajectory.
 * Each phase is integrated analytically, so ordinary frame partitioning does not change motion.
 */
public final class CameraMotion {
  private CameraMotion() {}

  public enum Profile {
    PRECISE(300, 210, 2400, 1800),
    BALANCED(480, 300, 4800, 3600),
    FAST(720, 480, 7200, 5400);

    public final double yawSpeed, pitchSpeed, yawAcceleration, pitchAcceleration;

    Profile(double yawSpeed, double pitchSpeed, double yawAcceleration, double pitchAcceleration) {
      this.yawSpeed = yawSpeed;
      this.pitchSpeed = pitchSpeed;
      this.yawAcceleration = yawAcceleration;
      this.pitchAcceleration = pitchAcceleration;
    }
  }

  /** Allocate once; public fields are output, not independent integration inputs. */
  public static final class State {
    public double yaw, pitch, yawVelocity, pitchVelocity;
    private long lastNanos;
    private boolean initialized;
    private double position, velocity;
  }

  public static void reset(State state, double yaw, double pitch, long nowNanos) {
    if (!Double.isFinite(yaw) || !Double.isFinite(pitch))
      throw new IllegalArgumentException("Camera angles must be finite");
    state.yaw = wrapYaw(yaw);
    state.pitch = Math.clamp(pitch, -90, 90);
    state.yawVelocity = state.pitchVelocity = 0;
    state.lastNanos = nowNanos;
    state.initialized = true;
  }

  /** Duplicate/backwards timestamps do nothing; a stalled frame advances at most 50 ms.
   * Target changes preserve velocity: an infeasible instantaneous reversal must first brake,
   * rather than teleporting or violating the acceleration limit. A stationary target is never
   * overshot from rest. Invalid targets leave both the output and clock unchanged.
   */
  public static void advance(
      State state, double targetYaw, double targetPitch, Profile profile, long nowNanos) {
    if (!state.initialized) throw new IllegalStateException("Reset camera state before advancing");
    if (!Double.isFinite(targetYaw) || !Double.isFinite(targetPitch) || profile == null) return;
    long elapsed = nowNanos - state.lastNanos;
    if (elapsed <= 0) return;
    state.lastNanos = nowNanos;
    double seconds = Math.min(elapsed * 1e-9, .05);
    state.position = state.yaw;
    state.velocity = state.yawVelocity;
    axis(state, state.yaw + wrapYaw(targetYaw - state.yaw),
        profile.yawSpeed, profile.yawAcceleration, seconds);
    state.yaw = wrapYaw(state.position);
    state.yawVelocity = state.velocity;
    state.position = state.pitch;
    state.velocity = state.pitchVelocity;
    axis(state, Math.clamp(targetPitch, -90, 90),
        profile.pitchSpeed, profile.pitchAcceleration, seconds);
    state.pitch = Math.clamp(state.position, -90, 90);
    state.pitchVelocity = state.velocity;
    // A changed pitch target can make the old stopping distance exceed the legal pitch range.
    if (state.pitch != state.position) state.pitchVelocity = 0;
  }

  public static boolean isSettled(
      State state, double targetYaw, double targetPitch, double angleTolerance,
      double speedTolerance) {
    return state.initialized && Double.isFinite(targetYaw) && Double.isFinite(targetPitch)
        && Math.abs(wrapYaw(targetYaw - state.yaw)) <= angleTolerance
        && Math.abs(Math.clamp(targetPitch, -90, 90) - state.pitch) <= angleTolerance
        && Math.abs(state.yawVelocity) <= speedTolerance
        && Math.abs(state.pitchVelocity) <= speedTolerance;
  }

  public static double wrapYaw(double degrees) {
    double wrapped = degrees % 360;
    if (wrapped >= 180) wrapped -= 360;
    if (wrapped < -180) wrapped += 360;
    return wrapped;
  }

  private static void integrate(State state, double acceleration, double seconds) {
    state.position += state.velocity * seconds + .5 * acceleration * seconds * seconds;
    state.velocity += acceleration * seconds;
  }

  private static void axis(
      State state, double target, double speed, double acceleration, double remaining) {
    // At most two correction phases: brake an old direction or an infeasible old stopping
    // distance, then plan a reachable rest-to-rest trajectory. Also handles live profile changes.
    for (int correction = 0; correction < 3; correction++) {
      double error = target - state.position;
      if (Math.abs(error) < 1e-10 && Math.abs(state.velocity) < 1e-8) {
        state.position = target;
        state.velocity = 0;
        return;
      }
      double direction = error < 0 ? -1 : error > 0 ? 1 : -Math.signum(state.velocity);
      double distance = Math.abs(error);
      double velocity = state.velocity * direction;
      double correctionTime = 0, correctionAcceleration = 0;
      if (velocity < 0) {
        correctionTime = -velocity / acceleration;
        correctionAcceleration = direction * acceleration;
      } else if (velocity > speed) {
        correctionTime = (velocity - speed) / acceleration;
        correctionAcceleration = -direction * acceleration;
      } else if (velocity * velocity / (2 * acceleration) > distance + 1e-10) {
        correctionTime = velocity / acceleration;
        correctionAcceleration = -direction * acceleration;
      }
      if (correctionTime > 0) {
        double used = Math.min(remaining, correctionTime);
        integrate(state, correctionAcceleration, used);
        remaining -= used;
        if (used < correctionTime || remaining <= 1e-12) return;
        if (Math.abs(state.velocity) < 1e-8) state.velocity = 0;
        continue;
      }

      double peak = Math.min(speed, Math.sqrt(acceleration * distance + velocity * velocity / 2));
      double accelerateTime = Math.max(0, (peak - velocity) / acceleration);
      double cruiseDistance = Math.max(0,
          distance - (peak * peak - velocity * velocity) / (2 * acceleration)
              - peak * peak / (2 * acceleration));
      double cruiseTime = peak > 0 ? cruiseDistance / peak : 0;
      double brakeTime = peak / acceleration;
      if (remaining >= accelerateTime + cruiseTime + brakeTime) {
        state.position = target;
        state.velocity = 0;
        return;
      }
      double used = Math.min(remaining, accelerateTime);
      integrate(state, direction * acceleration, used);
      remaining -= used;
      if (remaining <= 1e-12) return;
      used = Math.min(remaining, cruiseTime);
      integrate(state, 0, used);
      remaining -= used;
      if (remaining <= 1e-12) return;
      integrate(state, -direction * acceleration, remaining);
      return;
    }
  }
}
