package io.gameharness.nativeclient;

import java.util.UUID;

/** Game-thread handler/view instance identity; progress animation alone is not a transaction revision. */
public final class ScreenIncarnations {
  private Object instance;
  private EffectAuthority.Screen screen;
  private long incarnation;
  private long layoutRevision;
  private String layoutSignature;

  public EffectAuthority.Screen screen() { return screen; }
  public EffectAuthority.VisibleScreenRef visible() {
    return screen == null ? null : new EffectAuthority.VisibleScreenRef(screen.id(), screen.incarnation(), layoutRevision);
  }
  public void layoutChanged(Object expectedInstance, String signature) {
    if (instance != expectedInstance || screen == null) throw new IllegalStateException("Visible layout lost its view");
    if (!signature.equals(layoutSignature)) {
      layoutSignature = signature;
      layoutRevision = ContractIdentity.next(layoutRevision);
    }
  }

  public boolean viewChanged(Object next) {
    if (instance == next) return false;
    instance = next;
    layoutSignature = null;
    layoutRevision = 0;
    incarnation = ContractIdentity.next(incarnation);
    screen = next == null ? null : new EffectAuthority.Screen(UUID.randomUUID().toString(), incarnation, 0);
    return true;
  }

  /** Call only for a pinned relevant slot/cursor/selection change, not an arbitrary render or animation. */
  public boolean transactionChanged(Object expectedInstance) {
    if (expectedInstance == null || instance != expectedInstance || screen == null) return false;
    screen = new EffectAuthority.Screen(screen.id(), screen.incarnation(), ContractIdentity.next(screen.revision()));
    return true;
  }

  public void invalidate() {
    instance = null;
    screen = null;
    layoutSignature = null;
    layoutRevision = 0;
    incarnation = ContractIdentity.next(incarnation);
  }
}
