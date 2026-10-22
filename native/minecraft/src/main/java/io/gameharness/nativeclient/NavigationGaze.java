package io.gameharness.nativeclient;

/** Bounded geometry only: route construction, world queries and gaze priority belong to the caller. */
public final class NavigationGaze {
  public static final int MAX_POINTS = 64;
  public static final double MAX_LOOKAHEAD = 8;

  private NavigationGaze() {}

  /** Caller-owned output; xyz is the eye-height lookahead point, angles use native degrees. */
  public static final class Output {
    public double x, y, z, yaw, pitch;
  }

  /** Legal keyboard axes: forward +1/-1, strafe +1=left/-1=right, zero=not pressed.
   * worldYaw is the actual quantized movement bearing; validate THAT corridor, not the ideal
   * route bearing. Minecraft normalizes diagonal input. No pitch-based movement gate is used.
   */
  public static final class Movement {
    public int forward, strafe;
    public double worldYaw, yawError;
  }


  /** Samples a feet-position polyline from its nearest segment, then walks forward by bounded
   * 3D arc length. Routes must be in traversal order, collision-validated by the caller, and
   * contain 2..64 points in a reusable packed xyz array. A lookahead greater than eight blocks
   * is clamped, not extrapolated beyond the route. No world information is discovered here.
   *
   * <p>The same eye height is added to route feet and player feet: a flat route stays level,
   * while uphill/downhill geometry naturally changes pitch. False leaves output unchanged.
   * Explicit free/target gaze takes priority in the caller: do not replace it with this sample.
   */
  public static boolean sample(
      double[] xyz, int pointCount, double feetX, double feetY, double feetZ,
      double eyeHeight, double lookahead, Output output) {
    if (xyz == null || output == null || pointCount < 2 || pointCount > MAX_POINTS
        || xyz.length < pointCount * 3 || !Double.isFinite(feetX)
        || !Double.isFinite(feetY) || !Double.isFinite(feetZ)
        || !Double.isFinite(eyeHeight) || eyeHeight < 0
        || !Double.isFinite(lookahead) || lookahead < 0) return false;
    for (int i = 0; i < pointCount * 3; i++) if (!Double.isFinite(xyz[i])) return false;
    int nearest = -1;
    double nearestT = 0, nearestDistance = Double.POSITIVE_INFINITY;
    for (int i = 0; i < pointCount - 1; i++) {
      int base = i * 3;
      double dx = xyz[base + 3] - xyz[base];
      double dy = xyz[base + 4] - xyz[base + 1];
      double dz = xyz[base + 5] - xyz[base + 2];
      double lengthSquared = dx * dx + dy * dy + dz * dz;
      if (lengthSquared <= 1e-12 || !Double.isFinite(lengthSquared)) continue;
      double t = Math.clamp(((feetX - xyz[base]) * dx + (feetY - xyz[base + 1]) * dy
          + (feetZ - xyz[base + 2]) * dz) / lengthSquared, 0, 1);
      double ox = xyz[base] + dx * t - feetX;
      double oy = xyz[base + 1] + dy * t - feetY;
      double oz = xyz[base + 2] + dz * t - feetZ;
      double distance = ox * ox + oy * oy + oz * oz;
      if (distance < nearestDistance) {
        nearest = i;
        nearestT = t;
        nearestDistance = distance;
      }
    }
    if (nearest < 0) return false;
    double remaining = Math.min(lookahead, MAX_LOOKAHEAD);
    double x = 0, y = 0, z = 0;
    for (int i = nearest; i < pointCount - 1; i++) {
      int base = i * 3;
      double dx = xyz[base + 3] - xyz[base];
      double dy = xyz[base + 4] - xyz[base + 1];
      double dz = xyz[base + 5] - xyz[base + 2];
      double length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      double start = i == nearest ? nearestT : 0;
      double available = length * (1 - start);
      double t = length > 1e-12 ? start + Math.min(remaining, available) / length : 1;
      x = xyz[base] + dx * t;
      y = xyz[base + 1] + dy * t;
      z = xyz[base + 2] + dz * t;
      remaining -= Math.min(remaining, available);
      if (remaining <= 1e-12) break;
    }
    double dx = x - feetX, dy = y - feetY, dz = z - feetZ;
    double horizontal = Math.hypot(dx, dz);
    if (horizontal <= 1e-9 || !Double.isFinite(horizontal) || !Double.isFinite(dy)) return false;
    double aimY = y + eyeHeight;
    if (!Double.isFinite(aimY)) return false;
    output.x = x;
    output.y = aimY;
    output.z = z;
    output.yaw = CameraMotion.wrapYaw(Math.toDegrees(Math.atan2(-dx, dz)));
    output.pitch = -Math.toDegrees(Math.atan2(dy, horizontal));
    return true;
  }

  /** Selects the closest of eight vanilla keyboard headings independently of camera pitch.
   * Arbitrary explicit gaze therefore cannot reinterpret world-relative route steering as
   * forward-only movement. The angular quantization error is at most 22.5 degrees. Invalid
   * input neutralizes the output and returns false; it never manufactures route clearance.
   */
  public static boolean steer(double desiredWorldYaw, double cameraYaw, Movement output) {
    output.forward = output.strafe = 0;
    output.worldYaw = output.yawError = 0;
    if (!Double.isFinite(desiredWorldYaw) || !Double.isFinite(cameraYaw)) return false;
    int octant = (int) Math.floor(CameraMotion.wrapYaw(desiredWorldYaw - cameraYaw) / 45 + .5);
    switch (octant) {
      case 0 -> output.forward = 1;
      case 1 -> { output.forward = 1; output.strafe = -1; }
      case 2 -> output.strafe = -1;
      case 3 -> { output.forward = -1; output.strafe = -1; }
      case -4, 4 -> output.forward = -1;
      case -3 -> { output.forward = -1; output.strafe = 1; }
      case -2 -> output.strafe = 1;
      case -1 -> { output.forward = 1; output.strafe = 1; }
      default -> throw new AssertionError("Wrapped keyboard heading outside octants");
    }
    output.worldYaw = CameraMotion.wrapYaw(cameraYaw + octant * 45);
    output.yawError = CameraMotion.wrapYaw(desiredWorldYaw - output.worldYaw);
    return true;
  }
}
