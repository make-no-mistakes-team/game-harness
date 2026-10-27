package io.gameharness.nativeclient;

import java.util.Random;

/** Boundary-sampled native pointer plan; advancing a rendered frame allocates nothing. */
public final class InventoryPointerMotion {
  public enum Category { ACQUISITION, DISTRIBUTION, TRANSITION, TRANSFER }

  public final long seed;
  public double x, y, fromX, fromY, toX, toY, distance, groupTempo = 1;
  public long travelNanos, pressNanos, dwellNanos;
  private final Random random;
  private Category category;
  private double landingX, landingY, variation, groupBend = 1, bend, curve;
  private int groupProfile, profile;
  private long elapsed;

  public InventoryPointerMotion(long seed) {
    this.seed = seed;
    random = new Random(seed);
  }

  public void beginGroup(int sourceSlot) {
    // Source identifies custody in the owner; randomness is sampled once for the whole group.
    groupTempo = .95 + random.nextDouble() * .10;
    groupProfile = random.nextInt(3);
    groupBend = random.nextBoolean() ? 1 : -1;
  }

  public void plan(double currentX, double currentY, double left, double top,
      double width, double height, Category category) {
    this.category = category;
    landingX = (random.nextDouble() - random.nextDouble()) * .15;
    landingY = (random.nextDouble() - random.nextDouble()) * .15;
    variation = .96 + random.nextDouble() * .08;
    profile = category == Category.DISTRIBUTION ? groupProfile : random.nextInt(3);
    bend = category == Category.DISTRIBUTION ? groupBend : random.nextBoolean() ? 1 : -1;
    retarget(currentX, currentY, left, top, width, height);
  }

  /** Resize changes geometry, never resamples the landing/style or rewinds to an old source. */
  public void retarget(double currentX, double currentY, double left, double top,
      double width, double height) {
    if (!Double.isFinite(currentX) || !Double.isFinite(currentY) || !Double.isFinite(left)
        || !Double.isFinite(top) || !Double.isFinite(width) || !Double.isFinite(height)
        || width <= 0 || height <= 0 || category == null) {
      throw new IllegalArgumentException("Pointer geometry must be finite with a usable target");
    }
    fromX = x = currentX; fromY = y = currentY;
    toX = left + width * (.5 + landingX);
    toY = top + height * (.5 + landingY);
    distance = Math.hypot(toX - fromX, toY - fromY);
    double difficulty = Math.log1p(distance / Math.min(width, height)) / Math.log(2);
    double tempo = groupTempo * variation;
    double travel, press, dwell;
    switch (category) {
      case DISTRIBUTION -> {
        travel = clamp((55 + 15 * difficulty) * tempo, 48, 155);
        press = clamp(43 * tempo, 34, 62);
        dwell = clamp(31 * tempo, 23, 48);
      }
      case ACQUISITION -> {
        travel = clamp((125 + 30 * difficulty) * tempo, 110, 300);
        press = clamp(67 * tempo, 52, 94);
        dwell = clamp(74 * tempo, 56, 110);
      }
      case TRANSITION -> {
        travel = clamp((145 + 32 * difficulty) * tempo, 130, 330);
        press = clamp(75 * tempo, 58, 105);
        dwell = clamp(88 * tempo, 66, 125);
      }
      default -> {
        travel = clamp((132 + 30 * difficulty) * tempo, 115, 310);
        press = clamp(69 * tempo, 54, 99);
        dwell = clamp(78 * tempo, 60, 115);
      }
    }
    travelNanos = (long) (travel * 1_000_000);
    pressNanos = (long) (press * 1_000_000);
    dwellNanos = (long) (dwell * 1_000_000);
    curve = distance <= 28 ? 0 : bend * Math.min(5.5, distance * .025);
    elapsed = 0;
  }

  public void advance(long elapsedNanos) {
    elapsed = Math.max(elapsed, Math.min(travelNanos, Math.max(0, elapsedNanos)));
    if (elapsed == travelNanos) { x = toX; y = toY; return; }
    double t = (double) elapsed / travelNanos;
    double skew = profile == 0 ? -.22 : profile == 1 ? .18 : 0;
    t += skew * t * (1 - t);
    double progress = t * t * (3 - 2 * t);
    double lateral = curve * Math.sin(Math.PI * progress);
    double dx = toX - fromX, dy = toY - fromY;
    double inverseDistance = distance == 0 ? 0 : 1 / distance;
    x = fromX + dx * progress - dy * inverseDistance * lateral;
    y = fromY + dy * progress + dx * inverseDistance * lateral;
  }

  public int profile() { return profile; }
  public double curve() { return curve; }

  private static double clamp(double value, double minimum, double maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
}
