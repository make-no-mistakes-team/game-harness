package io.gameharness.nativeclient;

import java.util.UUID;

/** Game-thread handler/view instance identity; progress animation alone is not a transaction revision. */
public final class ScreenIncarnations {
  private Object instance;
  private EffectAuthority.Screen screen;
  private long incarnation;

  public EffectAuthority.Screen screen() { return screen; }

  public boolean viewChanged(Object next) {
    if (instance == next) return false;
    instance = next;
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
    incarnation = ContractIdentity.next(incarnation);
  }
}
