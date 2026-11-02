package io.gameharness.nativeclient;

/** Pure identity gate. The game-thread caller checks live authority/layout before every use. */
public final class NativeEvaluationGate {
  private final boolean enabled;
  private boolean spent, armed, consumed;
  private EffectAuthority.Owner owner;
  private long generation;
  private Object screen, handler;
  private EffectAuthority.VisibleScreenRef ref;

  public NativeEvaluationGate(NativeEvaluationConfig config) {
    enabled = config != null && config.allowInventoryReplacement();
  }

  public synchronized boolean arm(EffectAuthority.Owner owner, long generation, Object screen,
      Object handler, EffectAuthority.VisibleScreenRef ref) {
    if (!enabled || spent || owner == null || generation <= 0 || generation > ContractIdentity.MAX_SAFE
        || screen == null || handler == null || ref == null) return false;
    this.owner = owner; this.generation = generation; this.screen = screen; this.handler = handler; this.ref = ref;
    spent = armed = true;
    return true;
  }

  /** Commit before the caller installs a replacement; even a failed installation cannot retry. */
  public synchronized boolean consume(EffectAuthority.Owner owner, long generation, Object screen,
      Object handler, EffectAuthority.VisibleScreenRef ref, int operationIndex) {
    if (!enabled || !armed || operationIndex != 1 || !this.owner.equals(owner) || this.generation != generation
        || this.screen != screen || this.handler != handler || !this.ref.equals(ref)) return false;
    armed = false; consumed = true;
    clearPins();
    return true;
  }

  /** A late retirement for another owner must not alter the admitted arm. */
  public synchronized void cancel(EffectAuthority.Owner owner) {
    if (!armed || !this.owner.equals(owner)) return;
    armed = false;
    clearPins();
  }

  private void clearPins() { owner = null; screen = null; handler = null; ref = null; }
  public synchronized boolean armed() { return armed; }
  public synchronized boolean consumed() { return consumed; }
}
