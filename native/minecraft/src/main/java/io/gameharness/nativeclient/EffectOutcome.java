package io.gameharness.nativeclient;

/** An emitted mutation cannot become a safe retry merely because its receipt was lost. */
public final class EffectOutcome {
  public static final int CAMERA = 1;
  public static final int WORLD_EFFECT = 2;

  public static String deadline(int emissions) {
    return (emissions & WORLD_EFFECT) != 0 ? "unknown" : "failed";
  }

  public static String close(String requested, int emissions, boolean authoritativeResult) {
    return (requested.equals("failed") || requested.equals("cancelled"))
            && (emissions & WORLD_EFFECT) != 0 && !authoritativeResult
        ? "unknown" : requested;
  }
}
