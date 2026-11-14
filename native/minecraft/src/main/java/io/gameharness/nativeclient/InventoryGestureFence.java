package io.gameharness.nativeclient;

/** Narrow identity/authority fence for a single native inventory transaction. */
public final class InventoryGestureFence {
  private final Object screen, handler;
  private final int syncId;
  private boolean revoked, held, inventoryPlanSealed;

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

  /** Fresh contents may replace an empty startup baseline, never an input plan. */
  public boolean allowsUnplannedInventoryRefresh(Object screen, Object handler, int syncId,
      boolean idle, int cursorCount, int gridCount) {
    return !inventoryPlanSealed && !held && idle && cleanCustody(cursorCount, gridCount)
        && allows(screen, handler, syncId, true);
  }

  public void sealInventoryPlan() {
    if (revoked || held) throw new IllegalStateException("Inventory planning is no longer owned");
    inventoryPlanSealed = true;
  }

  public void press() {
    if (revoked || held) throw new IllegalStateException("Inventory gesture no longer owned");
    inventoryPlanSealed = true;
    held = true;
  }

  public void release() { held = false; }
  public boolean held() { return held; }
  public void revoke() { revoked = true; held = false; }
  public static boolean cleanCustody(int cursorCount, int gridCount) {
    return cursorCount == 0 && gridCount == 0;
  }
}
