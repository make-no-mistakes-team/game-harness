package io.gameharness.nativeclient;

/** Pure production pointer geometry/timing proof; no Minecraft, renderer or provider. */
public final class InventoryMotionProof {
  private static final long MS = 1_000_000L;

  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static void near(double actual, double expected, String message) {
    require(Math.abs(actual - expected) < 1e-8, message + ": " + actual + " != " + expected);
  }

  // Removing the inset, resampling the endpoint per frame, or ignoring the seed breaks this proof.
  private static void safeStableAndReproducibleLandings() {
    InventoryPointerMotion a = new InventoryPointerMotion(81273L);
    InventoryPointerMotion b = new InventoryPointerMotion(81273L);
    a.beginGroup(12); b.beginGroup(12);
    double previousX = Double.NaN, previousY = Double.NaN;
    boolean varied = false;
    for (int gesture = 0; gesture < 64; gesture++) {
      a.plan(0, 0, 100, 70, 16, 16, InventoryPointerMotion.Category.DISTRIBUTION);
      b.plan(0, 0, 100, 70, 16, 16, InventoryPointerMotion.Category.DISTRIBUTION);
      require(a.toX >= 103 && a.toX <= 113 && a.toY >= 73 && a.toY <= 83,
          "slot landing escaped usable inset");
      require(Math.hypot(a.toX - 108, a.toY - 78) <= 3.6, "landing lost center bias");
      near(a.toX, b.toX, "seed did not reproduce x");
      near(a.toY, b.toY, "seed did not reproduce y");
      require(a.travelNanos == b.travelNanos && a.pressNanos == b.pressNanos
          && a.dwellNanos == b.dwellNanos, "seed did not reproduce timings");
      if (gesture > 0 && (a.toX != previousX || a.toY != previousY)) varied = true;
      previousX = a.toX; previousY = a.toY;
      a.advance(a.travelNanos / 2);
      near(a.toX, previousX, "frame changed landing x");
      near(a.toY, previousY, "frame changed landing y");
      a.advance(a.travelNanos);
      near(a.x, a.toX, "final x did not equal landing");
      near(a.y, a.toY, "final y did not equal landing");
    }
    require(varied, "different gestures all landed at identical coordinates");
  }

  // Overshooting/nonmonotonic easing, nonfinite geometry and restarting at an old source fail here.
  private static void monotonicPathsAndRetargeting() {
    for (InventoryPointerMotion.Category category : InventoryPointerMotion.Category.values()) {
      for (double distance : new double[] {0, 1, 18, 150, 600}) {
        InventoryPointerMotion motion = new InventoryPointerMotion(1928L);
        motion.beginGroup(7);
        motion.plan(20, 30, 12 + distance, 22, 16, 16, category);
        near(motion.x, 20, "motion did not start at current x");
        near(motion.y, 30, "motion did not start at current y");
        double dx = motion.toX - motion.fromX, dy = motion.toY - motion.fromY;
        double previousProgress = -1;
        for (int frame = 0; frame <= 100; frame++) {
          motion.advance(motion.travelNanos * frame / 100);
          require(Double.isFinite(motion.x) && Double.isFinite(motion.y), "nonfinite frame");
          double squaredDistance = dx * dx + dy * dy;
          double progress = squaredDistance == 0 ? 1
              : ((motion.x - motion.fromX) * dx + (motion.y - motion.fromY) * dy) / squaredDistance;
          require(progress >= previousProgress - 1e-8 && progress <= 1 + 1e-8,
              "path reversed or overshot target");
          previousProgress = progress;
          double deviation = squaredDistance == 0 ? 0
              : Math.abs((motion.x - motion.fromX) * dy - (motion.y - motion.fromY) * dx)
                  / Math.sqrt(squaredDistance);
          require(deviation <= (distance <= 18 ? .01 : 7), "path became decorative rather than mild");
        }
        near(motion.x, motion.toX, "path did not finish x");
        near(motion.y, motion.toY, "path did not finish y");
      }
    }
    InventoryPointerMotion resized = new InventoryPointerMotion(6);
    resized.plan(4, 8, 200, 100, 16, 16, InventoryPointerMotion.Category.TRANSFER);
    resized.advance(resized.travelNanos / 3);
    double x = resized.x, y = resized.y;
    resized.retarget(x, y, 300, 200, 16, 16);
    near(resized.x, x, "resize jumped x instead of retargeting from current pointer");
    near(resized.y, y, "resize jumped y instead of retargeting from current pointer");
    resized.advance(resized.travelNanos / 2);
    x = resized.x; y = resized.y;
    resized.advance(0);
    near(resized.x, x, "backwards clock rewound x");
    near(resized.y, y, "backwards clock rewound y");
    resized.advance(Long.MAX_VALUE);
    require(resized.x >= 303 && resized.x <= 313 && resized.y >= 203 && resized.y <= 213,
        "resize retained stale landing");
  }

  // A single uniform tempo, per-frame randomization or unbounded Fitts timing fails these ranges.
  private static void categoryTimingAndCoherentGroups() {
    InventoryPointerMotion motion = new InventoryPointerMotion(55L);
    motion.beginGroup(18);
    double tempo = motion.groupTempo;
    long minimum = Long.MAX_VALUE, maximum = 0;
    for (int gesture = 0; gesture < 32; gesture++) {
      motion.plan(50, 50, 60, 42, 16, 16, InventoryPointerMotion.Category.DISTRIBUTION);
      near(motion.groupTempo, tempo, "distribution resampled group tempo");
      require(motion.travelNanos >= 45 * MS && motion.travelNanos <= 165 * MS,
          "short distribution travel outside fast bounded range");
      require(motion.pressNanos >= 30 * MS && motion.pressNanos <= 80 * MS,
          "distribution press outside bounded range");
      require(motion.dwellNanos >= 20 * MS && motion.dwellNanos <= 65 * MS,
          "distribution dwell outside bounded range");
      minimum = Math.min(minimum, motion.travelNanos);
      maximum = Math.max(maximum, motion.travelNanos);
    }
    require(maximum <= minimum * 1.25, "within-group timing variation was not modest");
    require(maximum > minimum, "distribution gesture timing was completely uniform");
    long distribution = maximum;
    for (InventoryPointerMotion.Category category : InventoryPointerMotion.Category.values()) {
      if (category == InventoryPointerMotion.Category.DISTRIBUTION) continue;
      motion.plan(50, 50, 60, 42, 16, 16, category);
      require(motion.travelNanos > distribution, "material/transfer transition lost category distinction");
      require(motion.travelNanos <= 350 * MS && motion.pressNanos <= 115 * MS
          && motion.dwellNanos <= 135 * MS, "transition timing exceeded bounds");
      motion.plan(50, 50, 3000, -2000, 16, 16, category);
      require(motion.travelNanos <= 350 * MS, "long travel timing was unbounded");
    }
  }

  public static void main(String[] args) {
    safeStableAndReproducibleLandings();
    monotonicPathsAndRetargeting();
    categoryTimingAndCoherentGroups();
    System.out.println("Inventory motion proofs passed");
  }
}
