package io.gameharness.nativeclient;

/** Feet-to-authorized-goal bounds, distinct from the observation sampler's block lattice. */
final class NavigationEnvelope {
  static final double START_LIMIT = 8;
  static final double CURRENT_LIMIT = 10;

  static String rejection(double startDistanceSquared, double currentDistanceSquared) {
    if (startDistanceSquared > START_LIMIT * START_LIMIT) return "start_distance_limit";
    if (currentDistanceSquared > CURRENT_LIMIT * CURRENT_LIMIT) return "current_distance_limit";
    return null;
  }
}
