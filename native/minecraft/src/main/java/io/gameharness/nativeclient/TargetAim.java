package io.gameharness.nativeclient;

/** Reusable eye-to-target angles; both endpoints may move between mouse samples. */
public final class TargetAim {
  private boolean initialized;
  private double eyeX, eyeY, eyeZ, targetX, targetY, targetZ;
  public float yaw, pitch;

  public void update(double ex, double ey, double ez, double tx, double ty, double tz) {
    if (initialized && ex == eyeX && ey == eyeY && ez == eyeZ
        && tx == targetX && ty == targetY && tz == targetZ) return;
    initialized = true;
    eyeX = ex; eyeY = ey; eyeZ = ez;
    targetX = tx; targetY = ty; targetZ = tz;
    double dx = tx - ex, dy = ty - ey, dz = tz - ez;
    yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
    pitch = (float) -Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)));
  }
}
