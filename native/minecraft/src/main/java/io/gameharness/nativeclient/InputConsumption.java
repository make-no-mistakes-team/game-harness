package io.gameharness.nativeclient;

/** Bounded observation cursor shared by the live actuator and pure conformance proof. */
public final class InputConsumption {
  private final int[] remaining = new int[256];
  private final int[] countedMovement = new int[7];
  private int sampledMovement;
  private WorldInputPlan.Step step;
  public void reset(WorldInputPlan.Step step) {
    this.step = step;
    sampledMovement = 0;
    for (int key = 0; key < countedMovement.length; key++) countedMovement[key] = 0;
    for (int index = 0; index < step.edgeCount(); index++) remaining[index] = step.edge(index).count();
  }
  public void counted(int button) {
    if (step == null) return;
    // A level sample and the first counted read can describe the same press.
    if (button >= 0 && button < 7 && ++countedMovement[button] == 1 && (sampledMovement & (1 << button)) != 0) return;
    for (int index = 0; index < step.edgeCount(); index++) {
      if (remaining[index] == 0) continue;
      WorldInputPlan.Edge edge = step.edge(index);
      int key = switch (edge.kind()) {
        case BUTTON -> edge.press() ? edge.key() : -1;
        case HOTBAR -> 12 + edge.slot();
        case SWAP -> 10;
        case DROP -> 11;
      };
      if (key == button) { remaining[index]--; return; }
    }
  }
  public void releasesConsumed() {
    if (step == null) return;
    for (int index = 0; index < step.edgeCount(); index++) {
      WorldInputPlan.Edge edge = step.edge(index);
      if (edge.kind() == WorldInputPlan.EdgeKind.BUTTON && !edge.press()) remaining[index] = 0;
    }
  }
  public void sampled(int heldMask) {
    if (step == null) return;
    for (int index = 0; index < step.edgeCount(); index++) {
      WorldInputPlan.Edge edge = step.edge(index);
      if (edge.kind() == WorldInputPlan.EdgeKind.BUTTON && edge.key() < 7 && edge.press()
          && remaining[index] > 0 && (heldMask & (1 << edge.key())) != 0
          && (sampledMovement & (1 << edge.key())) == 0 && countedMovement[edge.key()] == 0) {
        remaining[index]--;
        sampledMovement |= 1 << edge.key();
      }
    }
  }
  public long prefix(long start) {
    if (step == null) return start;
    long prefix = start;
    for (int index = 0; index < step.edgeCount(); index++) {
      prefix += step.edge(index).count() - remaining[index];
      if (remaining[index] != 0) break;
    }
    return prefix;
  }
}
