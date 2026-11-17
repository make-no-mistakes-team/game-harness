package io.gameharness.nativeclient;

/** Narrow identity/authority fence for a single native inventory transaction. */
public final class InventoryGestureFence {
  public enum InventoryRefresh {
    REFRESHED, SCOPE_CHANGED, HANDLER_CHANGED, LAYOUT_CHANGED, NON_INVENTORY_CHANGED,
    NATIVE_EFFECT, IN_FLIGHT, CURSOR_OR_GRID_CHANGED, INPUT_ISSUED, EXHAUSTED
  }

  private final Object screen, handler;
  private final int syncId;
  private boolean revoked, held, inputIssued, inventoryRefreshed, inventoryReplanPending;

  public InventoryGestureFence(Object screen, Object handler, int syncId) {
    this.screen = screen;
    this.handler = handler;
    this.syncId = syncId;
  }

  public boolean cleanupOwns(Object screen, Object handler, int syncId) {
    return this.screen == screen && this.handler == handler && this.syncId == syncId;
  }

  public boolean allows(Object screen, Object handler, int syncId, boolean custodyMatches) {
    return !revoked && custodyMatches && cleanupOwns(screen, handler, syncId);
  }

  /**
   * Consume the one pre-input refresh, invalidating any unpressed recipe/pointer plan.
   * The consumer must discard that pointer before adopting contents, then rebuild and seal
   * its material/input plan. No press (including a failed/unknown callback) is ever replayable.
   */
  public InventoryRefresh refreshBeforeInput(Object screen, Object handler, int syncId,
      boolean scopeStable, boolean layoutStable, boolean ownInventoryOnly, boolean noNativeEffect,
      int phase, int cursorCount, int gridCount) {
    if (revoked || !scopeStable) return InventoryRefresh.SCOPE_CHANGED;
    if (!cleanupOwns(screen, handler, syncId)) return InventoryRefresh.HANDLER_CHANGED;
    if (!layoutStable) return InventoryRefresh.LAYOUT_CHANGED;
    if (!ownInventoryOnly) return InventoryRefresh.NON_INVENTORY_CHANGED;
    if (inputIssued || held) return InventoryRefresh.INPUT_ISSUED;
    if (!noNativeEffect) return InventoryRefresh.NATIVE_EFFECT;
    if (phase != 0 && phase != 1) return InventoryRefresh.IN_FLIGHT;
    if (!cleanCustody(cursorCount, gridCount)) return InventoryRefresh.CURSOR_OR_GRID_CHANGED;
    if (inventoryRefreshed) return InventoryRefresh.EXHAUSTED;
    inventoryRefreshed = true;
    inventoryReplanPending = true;
    return InventoryRefresh.REFRESHED;
  }

  public boolean inventoryReplanPending() { return inventoryReplanPending; }

  public void sealInventoryPlan() {
    if (revoked || held) throw new IllegalStateException("Inventory planning is no longer owned");
    inventoryReplanPending = false;
  }

  public void press() {
    if (revoked || held || inventoryReplanPending)
      throw new IllegalStateException("Inventory gesture no longer owned");
    inputIssued = true;
    held = true;
  }

  public void release() { held = false; }
  public boolean held() { return held; }
  public void revoke() { revoked = true; held = false; }
  public static boolean cleanCustody(int cursorCount, int gridCount) {
    return cursorCount == 0 && gridCount == 0;
  }
}
