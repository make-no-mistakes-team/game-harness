package io.gameharness.nativeclient;

/**
 * Consumes only actual vanilla damage returns within one owned attack stack, never prior hurt
 * state.
 */
public final class DamageAttribution {
  private final Object owner, target;
  private int outcome = 2;
  private int depth;
  private boolean ambiguous;

  public DamageAttribution(Object owner, Object target) {
    this.owner = owner;
    this.target = target;
  }

  public void begin(Object damaged, Object attacker) {
    if (depth++ != 0 || damaged != target || attacker != owner) ambiguous = true;
  }

  public void record(Object damaged, Object attacker, boolean accepted) {
    if (depth != 1 || damaged != target || attacker != owner) ambiguous = true;
    depth--;
    if (damaged == target && attacker == owner && outcome != 1) outcome = accepted ? 1 : 0;
  }

  public int outcome() {
    return ambiguous || depth != 0 ? 2 : outcome;
  }
}
