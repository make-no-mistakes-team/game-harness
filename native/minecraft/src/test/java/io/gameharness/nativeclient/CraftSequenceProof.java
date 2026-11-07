package io.gameharness.nativeclient;

import java.util.List;

/** Exercises the actual sequence custody/quantity gate; rendered clicks need the live mechanics smoke. */
public final class CraftSequenceProof {
  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }
  public static void main(String[] args) {
    var plan = new CraftSequence(List.of(new CraftSequence.Stage("oak_planks", 2),
        new CraftSequence.Stage("crafting_table", 1), new CraftSequence.Stage("stick", 1)));
    plan.setOutputCount(4);
    plan.deposited(); plan.deposited();
    require(plan.confirm(8, true) && plan.index() == 1, "two logs were not two consumptions yielding eight planks");
    plan.setOutputCount(1); plan.deposited();
    require(plan.confirm(1, true) && plan.index() == 2, "ordered table stage not admitted after confirmed planks");
    plan.setOutputCount(4); plan.deposited();
    require(plan.confirm(4, true) && plan.complete(), "requested recipe sequence did not finish exactly");
    try { plan.deposited(); throw new AssertionError("completed sequence accepted overcraft"); }
    catch (IllegalStateException expected) {}

    var exhausted = new CraftSequence(List.of(new CraftSequence.Stage("oak_planks", 3), new CraftSequence.Stage("stick", 1)));
    exhausted.setOutputCount(4); exhausted.deposited(); exhausted.deposited();
    require(!exhausted.confirm(8, true) && exhausted.stopped() && exhausted.index() == 0,
        "ingredient exhaustion advanced to an unrequested replacement or later stage");
    require(exhausted.confirmed(0) == 2 && exhausted.confirmed(1) == 0, "partial production prefix was erased or invented");
    require(exhausted.completed(0) == 2, "requested total was substituted for actual deposits");

    for (boolean clean : new boolean[] {false, true}) {
      var unknown = new CraftSequence(List.of(new CraftSequence.Stage("stick", 1)));
      unknown.setOutputCount(4); unknown.deposited();
      require(!unknown.confirm(clean ? 8 : 4, clean) && unknown.stopped(), "excess output or dirty custody confirmed success");
      require(unknown.confirmed(0) == 0, "untrusted/excess custody invented confirmed production");
    }
    var stop = new CraftSequence(List.of(new CraftSequence.Stage("oak_planks", 2)));
    stop.setOutputCount(4); stop.deposited(); stop.stop();
    require(stop.stopped() && !stop.complete() && stop.confirmed(0) == 0, "Stop manufactured a receipt");
    try { stop.deposited(); throw new AssertionError("Stop allowed another output gesture"); }
    catch (IllegalStateException expected) {}
    try { stop.confirm(4, true); throw new AssertionError("Stop admitted late sequence advancement"); }
    catch (IllegalStateException expected) {}

    Object screen = new Object(), handler = new Object();
    var fence = new InventoryGestureFence(screen, handler, 7);
    fence.press(); fence.revoke();
    require(!fence.held() && !fence.allows(screen, handler, 7, true), "Stop retained press/release authority");
    require(fence.cleanupOwns(screen, handler, 7) && !fence.cleanupOwns(new Object(), handler, 7),
        "cleanup lost exact old handler identity");
    for (int count : new int[] {0, 17}) {
      try { new CraftSequence(List.of(new CraftSequence.Stage("stick", count))); throw new AssertionError("unbounded quantity"); }
      catch (IllegalArgumentException expected) {}
    }
    try { new CraftSequence(List.of(new CraftSequence.Stage("stick", 16), new CraftSequence.Stage("stick", 1)));
      throw new AssertionError("unbounded total"); } catch (IllegalArgumentException expected) {}
    try { new CraftSequence(java.util.Collections.nCopies(9, new CraftSequence.Stage("stick", 1)));
      throw new AssertionError("unbounded stages"); } catch (IllegalArgumentException expected) {}
    try { new CraftSequence(List.of()); throw new AssertionError("empty sequence"); }
    catch (IllegalArgumentException expected) {}
    require(new CraftSequence(java.util.Collections.nCopies(8, new CraftSequence.Stage("stick", 2))).stages().size() == 8,
        "exact stage/quantity bounds refused");
    System.out.println("Craft sequence proofs passed");
  }
}
