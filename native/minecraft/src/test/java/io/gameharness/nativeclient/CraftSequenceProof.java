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
    plan.deposited(2);
    require(plan.confirm(8, true) && plan.index() == 1, "two logs were not two consumptions yielding eight planks");
    plan.setOutputCount(1); plan.deposited(1);
    require(plan.confirm(1, true) && plan.index() == 2, "ordered table stage not admitted after confirmed planks");
    plan.setOutputCount(4); plan.deposited(1);
    require(plan.confirm(4, true) && plan.complete(), "requested recipe sequence did not finish exactly");
    try { plan.deposited(1); throw new AssertionError("completed sequence accepted overcraft"); }
    catch (IllegalStateException expected) {}

    var exhausted = new CraftSequence(List.of(new CraftSequence.Stage("oak_planks", 3), new CraftSequence.Stage("stick", 1)));
    exhausted.setOutputCount(4); exhausted.deposited(1); exhausted.deposited(1);
    require(!exhausted.confirm(8, true) && exhausted.stopped() && exhausted.index() == 0,
        "ingredient exhaustion advanced to an unrequested replacement or later stage");
    require(exhausted.confirmed(0) == 2 && exhausted.confirmed(1) == 0, "partial production prefix was erased or invented");
    require(exhausted.completed(0) == 2, "requested total was substituted for actual deposits");

    for (boolean clean : new boolean[] {false, true}) {
      var unknown = new CraftSequence(List.of(new CraftSequence.Stage("stick", 1)));
      unknown.setOutputCount(4); unknown.deposited(1);
      require(!unknown.confirm(clean ? 8 : 4, clean) && unknown.stopped(), "excess output or dirty custody confirmed success");
      require(unknown.confirmed(0) == 0, "untrusted/excess custody invented confirmed production");
    }
    var stop = new CraftSequence(List.of(new CraftSequence.Stage("oak_planks", 2)));
    stop.setOutputCount(4); stop.deposited(1); stop.stop();
    require(stop.stopped() && !stop.complete() && stop.confirmed(0) == 0, "Stop manufactured a receipt");
    try { stop.deposited(1); throw new AssertionError("Stop allowed another output gesture"); }
    catch (IllegalStateException expected) {}
    try { stop.confirm(4, true); throw new AssertionError("Stop admitted late sequence advancement"); }
    catch (IllegalStateException expected) {}

    var sticks = new CraftSequence(List.of(new CraftSequence.Stage("stick", 2)));
    sticks.setOutputCount(4); sticks.deposited(2);
    require(sticks.completed(0) == 2 && sticks.confirmed(0) == 0 && !sticks.complete(),
        "one Shift gesture manufactured a receipt or counted only one recipe execution");
    try { sticks.deposited(1); throw new AssertionError("batch allowed overcraft"); }
    catch (IllegalStateException expected) {}
    require(sticks.confirm(8, true) && sticks.complete(), "two executions did not yield exactly eight sticks");

    for (int gain : new int[] {-4, 0, 4, 6, 12}) {
      var partialReceipt = new CraftSequence(List.of(new CraftSequence.Stage("stick", 2),
          new CraftSequence.Stage("crafting_table", 1)));
      partialReceipt.setOutputCount(4); partialReceipt.deposited(2);
      require(!partialReceipt.confirm(gain, true) && partialReceipt.stopped() && partialReceipt.index() == 0,
          "partial/nonintegral/excess batch receipt advanced a stage");
      require(partialReceipt.completed(0) == 2 && partialReceipt.confirmed(0) == 0,
          "mismatched batch receipt rewrote observed deposits or invented confirmation");
    }
    var partialShift = new CraftSequence(List.of(new CraftSequence.Stage("stick", 2)));
    partialShift.setOutputCount(4); partialShift.deposited(1);
    require(!partialShift.confirm(4, true) && partialShift.completed(0) == 1
        && partialShift.confirmed(0) == 1 && partialShift.stopped(),
        "coherent partial Shift effect was inflated to the whole planned batch");
    var dirtyBatch = new CraftSequence(List.of(new CraftSequence.Stage("stick", 2)));
    dirtyBatch.setOutputCount(4); dirtyBatch.deposited(2);
    require(!dirtyBatch.confirm(8, false) && dirtyBatch.stopped() && dirtyBatch.confirmed(0) == 0,
        "exact batch output bypassed cursor/grid custody");

    var stoppedBatch = new CraftSequence(List.of(new CraftSequence.Stage("stick", 2)));
    stoppedBatch.setOutputCount(4); stoppedBatch.deposited(2); stoppedBatch.stop();
    require(stoppedBatch.completed(0) == 2 && stoppedBatch.confirmed(0) == 0 && !stoppedBatch.complete(),
        "Stop discarded actual batch production or manufactured server confirmation");
    try { stoppedBatch.deposited(2); throw new AssertionError("Stop allowed batch replay"); }
    catch (IllegalStateException expected) {}
    try { stoppedBatch.confirm(8, true); throw new AssertionError("Stop admitted a late batch receipt"); }
    catch (IllegalStateException expected) {}

    var invalidBatch = new CraftSequence(List.of(new CraftSequence.Stage("stick", 2)));
    try { invalidBatch.deposited(2); throw new AssertionError("batch accepted an unknown output quantity"); }
    catch (IllegalStateException expected) {}
    invalidBatch.setOutputCount(4);
    for (int count : new int[] {Integer.MIN_VALUE, -1, 0, 3, 16, Integer.MAX_VALUE}) {
      try { invalidBatch.deposited(count); throw new AssertionError("invalid batch execution count accepted"); }
      catch (IllegalStateException expected) {}
      require(invalidBatch.completed(0) == 0, "invalid batch changed execution accounting");
    }
    invalidBatch.deposited(1);
    try { invalidBatch.deposited(2); throw new AssertionError("batch exceeded remaining requested executions"); }
    catch (IllegalStateException expected) {}
    require(invalidBatch.completed(0) == 1, "rejected batch changed earlier single-result accounting");

    var maximum = new CraftSequence(List.of(new CraftSequence.Stage("stick", 16)));
    maximum.setOutputCount(4); maximum.deposited(16);
    require(maximum.confirm(64, true) && maximum.complete(), "shared exact sixteen-execution bound refused");
    var sharedMaximum = new CraftSequence(List.of(new CraftSequence.Stage("oak_planks", 8),
        new CraftSequence.Stage("stick", 8)));
    sharedMaximum.setOutputCount(4); sharedMaximum.deposited(8);
    require(sharedMaximum.confirm(32, true), "first half of shared execution limit refused");
    sharedMaximum.setOutputCount(4); sharedMaximum.deposited(8);
    require(sharedMaximum.confirm(32, true) && sharedMaximum.complete(), "shared sixteen-execution plan did not finish");

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
