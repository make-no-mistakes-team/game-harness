package io.gameharness.nativeclient;

/**
 * Consumes only actual vanilla damage returns within one owned attack stack, never prior hurt
 * state.
 */
public final class DamageAttribution {
  private final Object owner, target;
  private int outcome = 2;

  public DamageAttribution(Object owner, Object target) {
    this.owner = owner;
    this.target = target;
  }

  public void record(Object damaged, Object attacker, boolean accepted) {
    if (damaged == target && attacker == owner && outcome != 1) outcome = accepted ? 1 : 0;
  }

  public int outcome() {
    return outcome;
  }
}
