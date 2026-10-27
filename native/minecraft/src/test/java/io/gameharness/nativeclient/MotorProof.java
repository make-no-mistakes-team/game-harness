package io.gameharness.nativeclient;

/** Executable pure behavior proofs; no Minecraft process, world or provider is required. */
public final class MotorProof {
  private static final long MILLISECOND = 1_000_000L;

  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static void near(double actual, double expected, double tolerance, String message) {
    require(Math.abs(actual - expected) <= tolerance,
        message + ": expected " + expected + ", got " + actual);
  }

  private static CameraMotion.State state(double yaw, double pitch) {
    CameraMotion.State state = new CameraMotion.State();
    CameraMotion.reset(state, yaw, pitch, 0);
    return state;
  }

  private static void boundedStep(
      CameraMotion.State state, double yaw, double pitch, CameraMotion.Profile profile,
      long now, double seconds) {
    double previousYaw = state.yaw, previousPitch = state.pitch;
    double previousYawSpeed = state.yawVelocity, previousPitchSpeed = state.pitchVelocity;
    CameraMotion.advance(state, yaw, pitch, profile, now);
    require(Math.abs(state.yawVelocity) <= profile.yawSpeed + 1e-7, "yaw speed exceeded profile");
    require(Math.abs(state.pitchVelocity) <= profile.pitchSpeed + 1e-7, "pitch speed exceeded profile");
    require(Math.abs(state.yawVelocity - previousYawSpeed)
        <= profile.yawAcceleration * seconds + 1e-7, "yaw acceleration exceeded profile");
    require(Math.abs(state.pitchVelocity - previousPitchSpeed)
        <= profile.pitchAcceleration * seconds + 1e-7, "pitch acceleration exceeded profile");
    require(Math.abs(CameraMotion.wrapYaw(state.yaw - previousYaw))
        <= Math.abs(previousYawSpeed) * seconds
            + .5 * profile.yawAcceleration * seconds * seconds + 1e-7,
        "yaw teleported between frames");
    require(Math.abs(state.pitch - previousPitch)
        <= Math.abs(previousPitchSpeed) * seconds
            + .5 * profile.pitchAcceleration * seconds * seconds + 1e-7,
        "pitch teleported between frames");
  }

  /** First settled frame must stay settled for a further 100 ms, not merely cross the target. */
  private static long balancedNinety(int stepMillis) {
    CameraMotion.State state = state(0, 0);
    long settledAt = -1;
    for (int millis = stepMillis; millis <= 1000; millis += stepMillis) {
      boundedStep(state, 90, 0, CameraMotion.Profile.BALANCED,
          millis * MILLISECOND, stepMillis / 1000.0);
      require(state.yaw >= -1e-8 && state.yaw <= 90 + 1e-8, "90 degree turn overshot");
      if (CameraMotion.isSettled(state, 90, 0, .5, 5)) {
        if (settledAt < 0) settledAt = millis;
        if (millis - settledAt >= 100) {
          require(settledAt <= 450, "balanced 90 degree settling exceeded 450 ms");
          return settledAt;
        }
      } else {
        require(settledAt < 0, "camera left its settled region");
      }
    }
    throw new AssertionError("balanced turn never settled");
  }

  private static void largeSmallAndWrap() {
    for (CameraMotion.Profile profile : CameraMotion.Profile.values()) {
      for (double target : new double[] {.2, 1, 5, 90, 179}) {
        CameraMotion.State state = state(0, 0);
        double previous = 0;
        for (int millis = 1; millis <= 1600; millis++) {
          boundedStep(state, target, -Math.min(target, 70), profile,
              millis * MILLISECOND, .001);
          require(state.yaw >= previous - 1e-8 && state.yaw <= target + 1e-8,
              "small/large rest-to-rest turn overshot or reversed");
          require(state.pitch <= 1e-8 && state.pitch >= -Math.min(target, 70) - 1e-8,
              "pitch overshot");
          previous = state.yaw;
        }
        require(CameraMotion.isSettled(state, target, -Math.min(target, 70), 1e-7, 1e-7),
            "profile failed to settle exactly");
      }
      CameraMotion.State wrap = state(179, 0);
      double travelled = 0, previous = wrap.yaw;
      for (int millis = 1; millis <= 200; millis++) {
        boundedStep(wrap, -179, 0, profile, millis * MILLISECOND, .001);
        double movement = CameraMotion.wrapYaw(wrap.yaw - previous);
        require(movement >= -1e-8, "wrap turn chose long direction");
        travelled += movement;
        previous = wrap.yaw;
      }
      near(travelled, 2, 1e-7, "wrap turn travelled more than shortest two degrees");
    }
  }

  private static void clockAndPartition() {
    CameraMotion.State fixed = state(170, 10), irregular = state(170, 10);
    for (int millis = 5; millis <= 170; millis += 5)
      CameraMotion.advance(fixed, -90, -30, CameraMotion.Profile.BALANCED, millis * MILLISECOND);
    long now = 0;
    for (int millis : new int[] {17, 3, 29, 11, 7, 23, 31, 19, 30}) {
      now += millis * MILLISECOND;
      CameraMotion.advance(irregular, -90, -30, CameraMotion.Profile.BALANCED, now);
    }
    near(CameraMotion.wrapYaw(fixed.yaw - irregular.yaw), 0, 1e-7, "yaw frame partition drift");
    near(fixed.pitch, irregular.pitch, 1e-7, "pitch frame partition drift");
    near(fixed.yawVelocity, irregular.yawVelocity, 1e-6, "yaw velocity frame partition drift");
    near(fixed.pitchVelocity, irregular.pitchVelocity, 1e-6, "pitch velocity frame partition drift");
    double yaw = fixed.yaw, pitch = fixed.pitch, velocity = fixed.yawVelocity;
    CameraMotion.advance(fixed, 0, 0, CameraMotion.Profile.BALANCED, 170 * MILLISECOND);
    CameraMotion.advance(fixed, 0, 0, CameraMotion.Profile.BALANCED, 100 * MILLISECOND);
    near(fixed.yaw, yaw, 0, "duplicate/backwards clock rotated camera");
    near(fixed.pitch, pitch, 0, "duplicate/backwards clock changed pitch");
    near(fixed.yawVelocity, velocity, 0, "duplicate/backwards clock changed speed");
    CameraMotion.State stalled = state(0, 0), ordinary = state(0, 0);
    CameraMotion.advance(stalled, 90, 0, CameraMotion.Profile.BALANCED, 5000 * MILLISECOND);
    CameraMotion.advance(ordinary, 90, 0, CameraMotion.Profile.BALANCED, 50 * MILLISECOND);
    near(stalled.yaw, ordinary.yaw, 1e-9, "stalled frame caused rotational jump");
    CameraMotion.advance(stalled, 90, 0, CameraMotion.Profile.BALANCED, 5010 * MILLISECOND);
    CameraMotion.advance(ordinary, 90, 0, CameraMotion.Profile.BALANCED, 60 * MILLISECOND);
    near(stalled.yaw, ordinary.yaw, 1e-9, "stall left catch-up debt");
  }

  private static void targetReversal() {
    CameraMotion.State state = state(0, 0);
    for (int millis = 5; millis <= 500; millis += 5) {
      double yaw = millis <= 80 ? 90 : -20;
      boundedStep(state, yaw, 0, CameraMotion.Profile.BALANCED, millis * MILLISECOND, .005);
      require(state.yaw >= -20 - 1e-7, "reversal crossed its new destination");
    }
    require(CameraMotion.isSettled(state, -20, 0, 1e-7, 1e-7), "target reversal never settled");
  }

  private static void routeGeometry() {
    NavigationGaze.Output output = new NavigationGaze.Output();
    double[] flat = {0, 64, 0, 0, 64, 10};
    require(NavigationGaze.sample(flat, 2, 0, 64, 4, 1.62, 2, output), "flat route not sampled");
    near(output.z, 6, 1e-9, "lookahead did not start at nearest route position");
    near(output.y, 65.62, 1e-9, "route look point omitted eye height");
    near(output.pitch, 0, 1e-9, "flat route looked at ground");
    near(output.yaw, 0, 1e-9, "flat route heading changed");
    double[] uphill = {0, 0, 0, 0, 2, 2};
    require(NavigationGaze.sample(uphill, 2, 0, 0, 0, 1.62, Math.sqrt(2), output),
        "uphill route not sampled");
    near(output.z, 1, 1e-9, "uphill arc-length interpolation failed");
    near(output.pitch, -45, 1e-9, "uphill route pitch was not geometric");
    double[] downhill = {0, 0, 0, 0, -2, 2};
    require(NavigationGaze.sample(downhill, 2, 0, 0, 0, 1.62, Math.sqrt(2), output),
        "downhill route not sampled");
    near(output.pitch, 45, 1e-9, "downhill route pitch was not geometric");
    double[] bend = {0, 0, 0, 0, 0, 2, 2, 0, 2};
    require(NavigationGaze.sample(bend, 3, 0, 0, 0, 1.62, 3, output), "bent route not sampled");
    near(output.x, 1, 1e-9, "lookahead skipped bend geometry");
    near(output.z, 2, 1e-9, "lookahead aimed directly at final goal");
    require(NavigationGaze.sample(flat, 2, 0, 64, 0, 1.62, 100, output), "bounded route failed");
    near(output.z, 8, 1e-9, "lookahead exceeded geometric budget");
    require(NavigationGaze.sample(bend, 3, 0, 0, 0, 1.62, 8, output), "short route failed");
    near(output.x, 2, 1e-9, "lookahead extrapolated beyond endpoint");
    double x = output.x, yaw = output.yaw;
    require(!NavigationGaze.sample(new double[195], 65, 0, 0, 0, 1.62, 2, output),
        "route point budget was not enforced");
    require(!NavigationGaze.sample(new double[] {0, 0, 0, 0, 0, 0}, 2,
        0, 0, 0, 1.62, 2, output), "degenerate route manufactured heading");
    require(!NavigationGaze.sample(new double[] {0, 0, 0, 0, Double.NaN, 2}, 2,
        0, 0, 0, 1.62, 2, output), "nonfinite geometry was admitted");
    near(output.x, x, 0, "failed route mutated reusable output");
    near(output.yaw, yaw, 0, "failed route overwrote gaze");
  }

  private static void explicitGazeAndSteering() {
    NavigationGaze.Output route = new NavigationGaze.Output();
    require(NavigationGaze.sample(new double[] {0, 0, 0, 0, 0, 4}, 2,
        0, 0, 0, 1.62, 2, route), "navigation route unavailable");
    // Caller selects the explicit setpoint; the geometry helper never owns camera state.
    CameraMotion.State camera = state(0, 0);
    for (int millis = 10; millis <= 500; millis += 10)
      CameraMotion.advance(camera, 90, -30, CameraMotion.Profile.BALANCED, millis * MILLISECOND);
    near(camera.yaw, 90, 1e-7, "navigation geometry replaced explicit yaw");
    near(camera.pitch, -30, 1e-7, "navigation geometry replaced explicit pitch");
    NavigationGaze.Movement movement = new NavigationGaze.Movement();
    require(NavigationGaze.steer(route.yaw, camera.yaw, movement), "explicit gaze steering failed");
    require(movement.forward == 0 && movement.strafe == 1,
        "sideways free gaze incorrectly commanded forward");
    near(movement.worldYaw, 0, 1e-9, "free gaze changed desired world movement");
    require(NavigationGaze.steer(0, 180, movement)
        && movement.forward == -1 && movement.strafe == 0, "backward gaze steering failed");
    for (int cameraYaw = -180; cameraYaw <= 180; cameraYaw += 13)
      for (int desired = -180; desired <= 180; desired += 7) {
        require(NavigationGaze.steer(desired, cameraYaw, movement), "finite steering rejected");
        require(Math.abs(movement.forward) <= 1 && Math.abs(movement.strafe) <= 1
            && (movement.forward != 0 || movement.strafe != 0), "illegal keyboard axes");
        require(Math.abs(movement.yawError) <= 22.5 + 1e-9, "quantized steering error exceeded bound");
        double localYaw = Math.toDegrees(Math.atan2(-movement.strafe, movement.forward));
        near(CameraMotion.wrapYaw(cameraYaw + localYaw - movement.worldYaw), 0, 1e-9,
            "reported corridor disagreed with actual keyboard input");
      }
    require(!NavigationGaze.steer(Double.NaN, 0, movement)
        && movement.forward == 0 && movement.strafe == 0, "invalid steering retained keys");
  }

  private static void navigationEnvelope() {
    require(NavigationEnvelope.rejection(64, 100) == null,
        "inclusive start/current navigation limits were narrowed");
    require("start_distance_limit".equals(NavigationEnvelope.rejection(64.0001, 64)),
        "initial feet-to-centre overflow lacks its own refusal reason");
    require("current_distance_limit".equals(NavigationEnvelope.rejection(63, 100.0001)),
        "current feet-to-centre overflow lacks its own refusal reason");
    // A sampled block lattice offset (6,-1,5) is inside radius eight, but
    // fractional player feet and block centres need not be within eight metres.
    require("start_distance_limit".equals(
        NavigationEnvelope.rejection(6.5 * 6.5 + .5 * .5 + 5.5 * 5.5, 64)),
        "observation lattice membership incorrectly widened native navigation geometry");
  }

  public static void main(String[] ignored) {
    long five = balancedNinety(5), ten = balancedNinety(10), twenty = balancedNinety(20);
    largeSmallAndWrap();
    clockAndPartition();
    targetReversal();
    routeGeometry();
    explicitGazeAndSteering();
    navigationEnvelope();
    System.out.println("Native motor proof PASS: measured balanced 90-degree settling "
        + five + "/" + ten + "/" + twenty + " ms at 5/10/20-ms steps (100-ms hold); "
        + "speed/acceleration limits, shortest yaw, no overshoot, frame partition, monotonic "
        + "clock/stall bounds, route eye-height/slope/bend interpolation, explicit gaze, keyboard steering "
        + "and distinct observation-lattice/navigation-envelope boundaries.");
  }
}
