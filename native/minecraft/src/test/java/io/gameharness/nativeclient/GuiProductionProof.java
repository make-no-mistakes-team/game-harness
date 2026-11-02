package io.gameharness.nativeclient;

/** Pure server-ledger proofs; actual mixin/packet conformance requires a live server. */
public final class GuiProductionProof {
  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] ignored) {
    matchingAndRetirement();
    uncertaintyAndBounds();
    furnaceProvenance();
    furnaceOrdinaryTakeReceipts();
    furnaceConservedTopupReceipts();
  }

  private static void insertInput(GuiProductionLedger.Furnace furnace, Object owner, String item,
      int before, int after, int ownLoss, String output, int outputCount) {
    Object click = new Object();
    furnace.beginInput(click, owner, before == 0 ? null : item, before);
    furnace.setInput(click, item, after);
    furnace.endInput(click, item, after, ownLoss, output, outputCount);
  }

  private static void matchingAndRetirement() {
    Object player = new Object(), other = new Object(), handler = new Object();
    var ledger = new GuiProductionLedger.Session(player);
    require(ledger.arm(1, 7, handler, 3, true, 100).confirmed(), "matching arm refused");
    ledger.take(other, handler, true, "crafting", "stick", 4, true);
    ledger.take(player, new Object(), true, "crafting", "stick", 4, true);
    ledger.take(player, handler, false, "crafting", "stick", 4, true);
    ledger.take(player, handler, true, "crafting", "stick", 4, true);
    require(!ledger.finish(1, 8, handler, 3, true, 101).confirmed(), "wrong generation matched");
    var result = ledger.finish(1, 7, handler, 3, true, 102);
    require(result.confirmed() && result.productions().size() == 1
        && result.productions().getFirst().count() == 4, "unrelated owner/handler/slot contaminated output amount");
    require(!ledger.finish(1, 7, handler, 3, true, 103).confirmed(), "finish replay reused output");
    require(!ledger.arm(1, 7, handler, 3, true, 104).confirmed(), "nonce replay rearmed");
    require(ledger.arm(2, 7, handler, 3, true, 105).confirmed(), "next nonce rejected");
    require("handler_changed".equals(ledger.finish(2, 7, new Object(), 3, true, 106).reason()),
        "same sync id hid handler replacement");
    require(!ledger.finish(2, 7, handler, 3, true, 107).confirmed(), "failed matching finish did not retire");
    require("not_alive".equals(ledger.arm(3, 8, handler, 4, false, 108).reason()), "dead player armed");
    require(ledger.arm(4, 8, handler, 4, true, 109).confirmed(), "new generation could not arm");
    require("handler_changed".equals(ledger.finish(4, 8, handler, 5, true, 110).reason()),
        "wrong sync id confirmed despite identical handler object");
    require(ledger.arm(5, 8, handler, 4, true, 111).confirmed(), "one-shot sync mismatch failed to retire");
    require("not_alive".equals(ledger.finish(5, 8, handler, 4, false, 112).reason()), "dead player confirmed");
    require(!ledger.arm(6, 7, handler, 4, true, 113).confirmed(), "generation moved backwards");
  }

  private static void uncertaintyAndBounds() {
    Object player = new Object(), handler = new Object();
    var ledger = new GuiProductionLedger.Session(player);
    require("lost".equals(ledger.finish(1, 1, handler, 0, true, 0).reason()), "unarmed finish confirmed");
    ledger.arm(1, 1, handler, 0, true, 0);
    require("stale".equals(ledger.finish(1, 1, handler, 0, true, 75_000_000_001L).reason()), "expired lease confirmed");
    ledger.arm(2, 1, handler, 0, true, 80_000_000_000L);
    require("incomplete".equals(ledger.arm(3, 1, handler, 0, true, 80_000_000_001L).reason()), "outstanding arm silently replaced");
    require(!ledger.finish(2, 1, handler, 0, true, 80_000_000_002L).confirmed(), "lost arm still produced evidence");
    ledger.arm(4, 1, handler, 0, true, 80_000_000_003L);
    for (int i = 0; i < 65; i++) ledger.take(player, handler, true, "crafting", "stick", 4, true);
    var overflow = ledger.finish(4, 1, handler, 0, true, 80_000_000_004L);
    require("overflow".equals(overflow.reason()) && overflow.productions().isEmpty(), "overflow exposed a confirmed prefix");
    ledger.arm(5, 1, handler, 0, true, 80_000_000_005L);
    ledger.take(player, handler, true, "smelting", "iron_ingot", 1, false);
    require("incomplete".equals(ledger.finish(5, 1, handler, 0, true, 80_000_000_006L).reason()), "unattributed output invented production");
  }

  private static void furnaceProvenance() {
    Object player = new Object(), other = new Object();
    var furnace = new GuiProductionLedger.Furnace();
    require(furnace.take(player, "iron_ingot", 8, 8) == 0, "prepopulated furnace output was called smelting");
    insertInput(furnace, player, "raw_iron", 0, 2, 2, "iron_ingot", 3);
    furnace.recipe("raw_iron", 2, 1, "iron_ingot", 3, 4);
    furnace.recipe("raw_iron", 1, 0, "iron_ingot", 4, 5);
    require(furnace.take(player, "iron_ingot", 5, 4) == 1, "unknown baseline was credited or real output lost");
    require(furnace.take(player, "iron_ingot", 1, 1) == 1, "remaining proven output not conserved");
    require(furnace.take(player, "iron_ingot", 0, 1) == 0, "same production taken twice");
    insertInput(furnace, player, "raw_iron", 0, 1, 1, null, 0);
    furnace.recipe("raw_iron", 1, 0, "iron_ingot", 0, 1);
    require(furnace.take(other, "iron_ingot", 1, 1) == 0, "another player's load became own production");
    require(furnace.take(player, "iron_ingot", 0, 1) == 0, "other owner's take failed to retire provenance");
    insertInput(furnace, player, "raw_iron", 0, 2, 1, null, 0);
    furnace.recipe("raw_iron", 2, 1, "iron_ingot", 0, 1);
    require(furnace.take(player, "iron_ingot", 1, 1) == 0, "unconserved input ownership confirmed");
    insertInput(furnace, player, "raw_iron", 0, 1, 1, null, 0);
    furnace.recipe("raw_iron", 2, 1, "iron_ingot", 0, 1);
    require(furnace.take(player, "iron_ingot", 1, 1) == 0, "unobserved input replacement retained provenance");
    insertInput(furnace, player, "raw_iron", 0, 1, 1, null, 0);
    furnace.recipe("raw_iron", 1, 0, "iron_ingot", 0, 1);
    require(furnace.take(player, "iron_ingot", 2, 2) == 0, "unobserved output replacement retained provenance");
    var bounded = new GuiProductionLedger.Furnace();
    insertInput(bounded, player, "raw_iron", 0, 64, 64, null, 0);
    for (int i = 0; i < 64; i++) bounded.recipe("raw_iron", 64 - i, 63 - i, "iron_ingot", i, i + 1);
    require(bounded.take(player, "iron_ingot", 64, 64) == 64, "bounded recipe events lost exact amount");
    insertInput(bounded, player, "raw_iron", 0, 65, 65, null, 0);
    for (int i = 0; i < 65; i++) bounded.recipe("raw_iron", 65 - i, 64 - i, "iron_ingot", i, i + 1);
    require(bounded.overflowed() && bounded.take(player, "iron_ingot", 65, 65) == 0,
        "furnace event overflow silently confirmed");
  }

  private static void furnaceOrdinaryTakeReceipts() {
    Object player = new Object(), handler = new Object();
    var session = new GuiProductionLedger.Session(player);
    var authentic = new GuiProductionLedger.Furnace();
    insertInput(authentic, player, "iron_ore", 0, 2, 2, null, 0);
    authentic.recipe("iron_ore", 2, 1, "iron_ingot", 0, 1);
    authentic.recipe("iron_ore", 1, 0, "iron_ingot", 1, 2);
    session.arm(1, 1, handler, 3, true, 0);
    // Vanilla removes the stack, writes EMPTY into the already-empty slot, then calls onCrafted.
    authentic.setOutput(0, 0);
    int proven = authentic.take(player, "iron_ingot", 2, 2);
    session.take(player, handler, true, "smelting", "iron_ingot", 2, proven == 2);
    var fullTake = session.finish(1, 1, handler, 3, true, 1);
    require(fullTake.confirmed() && fullTake.productions().equals(
        java.util.List.of(new GuiProductionLedger.Production("smelting", "iron_ingot", 2))),
        "ordinary full-stack empty cleanup erased genuine smelting receipt");
    require(authentic.take(player, "iron_ingot", 0, 2) == 0, "full-stack receipt reused retired production");

    var partial = new GuiProductionLedger.Furnace();
    insertInput(partial, player, "iron_ore", 0, 2, 2, null, 0);
    partial.recipe("iron_ore", 2, 1, "iron_ingot", 0, 1);
    partial.recipe("iron_ore", 1, 0, "iron_ingot", 1, 2);
    session.arm(2, 1, handler, 3, true, 2);
    proven = partial.take(player, "iron_ingot", 2, 1);
    session.take(player, handler, true, "smelting", "iron_ingot", 1, proven == 1);
    var partialTake = session.finish(2, 1, handler, 3, true, 3);
    require(partialTake.confirmed() && partialTake.productions().equals(
        java.util.List.of(new GuiProductionLedger.Production("smelting", "iron_ingot", 1))),
        "partial ordinary take lost its exact proven amount");
    partial.setOutput(0, 0);
    session.arm(3, 1, handler, 3, true, 4);
    proven = partial.take(player, "iron_ingot", 1, 1);
    session.take(player, handler, true, "smelting", "iron_ingot", 1, proven == 1);
    require(session.finish(3, 1, handler, 3, true, 5).confirmed(),
        "final partial-stack empty cleanup lost remaining genuine smelting");

    var injected = new GuiProductionLedger.Furnace();
    injected.setOutput(0, 2);
    injected.setOutput(0, 0);
    session.arm(4, 1, handler, 3, true, 6);
    proven = injected.take(player, "iron_ingot", 2, 2);
    session.take(player, handler, true, "smelting", "iron_ingot", 2, proven == 2);
    var injectedTake = session.finish(4, 1, handler, 3, true, 7);
    require("incomplete".equals(injectedTake.reason()) && injectedTake.productions().isEmpty(),
        "ordinary injected output gained a confirmed smelting receipt");

    var mixed = new GuiProductionLedger.Furnace();
    mixed.setOutput(0, 1);
    insertInput(mixed, player, "iron_ore", 0, 1, 1, "iron_ingot", 1);
    mixed.recipe("iron_ore", 1, 0, "iron_ingot", 1, 2);
    mixed.setOutput(0, 0);
    session.arm(5, 1, handler, 3, true, 8);
    proven = mixed.take(player, "iron_ingot", 2, 2);
    session.take(player, handler, true, "smelting", "iron_ingot", 2, proven == 2);
    var mixedTake = session.finish(5, 1, handler, 3, true, 9);
    require(proven == 1 && "incomplete".equals(mixedTake.reason()) && mixedTake.productions().isEmpty(),
        "mixed genuine/injected output exposed a confirmed production prefix");

    var replaced = new GuiProductionLedger.Furnace();
    insertInput(replaced, player, "iron_ore", 0, 2, 2, null, 0);
    replaced.recipe("iron_ore", 2, 1, "iron_ingot", 0, 1);
    replaced.setOutput(1, 1);
    require(replaced.take(player, "iron_ingot", 1, 1) == 0,
        "same-count positive replacement inherited genuine provenance");
    replaced.recipe("iron_ore", 1, 0, "iron_ingot", 0, 1);
    replaced.setOutput(1, 0);
    require(replaced.take(player, "iron_ingot", 1, 1) == 0,
        "direct nonempty-to-empty replacement retained genuine provenance");
  }

  private static void furnaceConservedTopupReceipts() {
    Object player = new Object(), other = new Object(), handler = new Object();
    var furnace = new GuiProductionLedger.Furnace();
    insertInput(furnace, player, "iron_ore", 0, 2, 2, null, 0);
    furnace.recipe("iron_ore", 2, 1, "iron_ingot", 0, 1);
    // Both ordinary insertion writes invalidate live ownership before endClick checks conservation.
    Object click = new Object();
    furnace.beginInput(click, player, "iron_ore", 1);
    furnace.setInput(click, "iron_ore", 2);
    furnace.setInput(click, "iron_ore", 3);
    furnace.endInput(click, "iron_ore", 3, 2, "iron_ingot", 1);
    furnace.recipe("iron_ore", 3, 2, "iron_ingot", 1, 2);
    furnace.recipe("iron_ore", 2, 1, "iron_ingot", 2, 3);
    furnace.recipe("iron_ore", 1, 0, "iron_ingot", 3, 4);
    var session = new GuiProductionLedger.Session(player);
    session.arm(1, 1, handler, 3, true, 0);
    furnace.setOutput(0, 0);
    int proven = furnace.take(player, "iron_ingot", 4, 4);
    session.take(player, handler, true, "smelting", "iron_ingot", 4, proven == 4);
    var receipt = session.finish(1, 1, handler, 3, true, 1);
    require(receipt.confirmed() && receipt.productions().equals(
        java.util.List.of(new GuiProductionLedger.Production("smelting", "iron_ingot", 4))),
        "intervening input hooks erased conserved same-owner top-up production");

    // The candidate is private to the furnace and click, not an owner tag or possession claim.
    String[] scenarios = {"other owner", "unbracketed positive write", "different source",
        "same-count replacement", "removal/reinsertion", "item replacement", "handler replacement",
        "different furnace", "different finishing source", "insufficient own loss", "unowned baseline",
        "excess own loss"};
    for (int scenario = 0; scenario < scenarios.length; scenario++) {
      var rejected = new GuiProductionLedger.Furnace();
      insertInput(rejected, player, "iron_ore", 0, 1, 1, null, 0);
      if (scenario == 10) rejected.setInput(null, "iron_ore", 1);
      Object frame = new Object();
      rejected.beginInput(frame, scenario == 0 ? other : player, "iron_ore", 1);
      if (scenario == 1) rejected.setInput(null, "iron_ore", 2); // Unbracketed positive write.
      else if (scenario == 2) rejected.setInput(new Object(), "iron_ore", 2); // Different click/source.
      else if (scenario == 3) {
        rejected.setInput(frame, "iron_ore", 1); // Same-count replacement before insertion.
        rejected.setInput(frame, "iron_ore", 2);
      } else if (scenario == 4) {
        rejected.setInput(frame, null, 0); // Removal and reinsertion cannot resurrect attribution.
        rejected.setInput(frame, "iron_ore", 2);
      } else if (scenario == 5) {
        rejected.setInput(frame, "raw_iron", 2); // Item replacement before restoring the old kind.
        rejected.setInput(frame, "iron_ore", 2);
      } else if (scenario == 6) {
        rejected.setInput(frame, "iron_ore", 2);
        rejected.invalidateInput(); // Handler replacement or lost bracket.
      } else rejected.setInput(frame, "iron_ore", 2);
      if (scenario == 7) {
        // A token from this click must not grant another furnace ownership.
        var unrelated = new GuiProductionLedger.Furnace();
        unrelated.endInput(frame, "iron_ore", 2, 1, null, 0);
        unrelated.recipe("iron_ore", 2, 1, "iron_ingot", 0, 1);
        require(unrelated.take(player, "iron_ingot", 1, 1) == 0,
            "a click on another furnace manufactured production");
        rejected.invalidateInput();
      }
      rejected.endInput(scenario == 8 ? new Object() : frame, "iron_ore", 2,
          scenario == 9 ? 0 : scenario == 11 ? 2 : 1, null, 0);
      rejected.recipe("iron_ore", 2, 1, "iron_ingot", 0, 1);
      rejected.recipe("iron_ore", 1, 0, "iron_ingot", 1, 2);
      session.arm(scenario + 2, 1, handler, 3, true, scenario + 2);
      proven = rejected.take(player, "iron_ingot", 2, 2);
      session.take(player, handler, true, "smelting", "iron_ingot", 2, proven == 2);
      var unknown = session.finish(scenario + 2, 1, handler, 3, true, scenario + 3);
      require(proven == 0 && "incomplete".equals(unknown.reason()) && unknown.productions().isEmpty(),
          "unproven top-up manufactured source production: " + scenarios[scenario]);
    }

    var inPlace = new GuiProductionLedger.Furnace();
    insertInput(inPlace, player, "iron_ore", 0, 1, 1, null, 0);
    Object inPlaceClick = new Object();
    inPlace.beginInput(inPlaceClick, player, "iron_ore", 1);
    // Vanilla shift insertion may increment the existing stack and markDirty without setStack.
    inPlace.endInput(inPlaceClick, "iron_ore", 2, 1, null, 0);
    inPlace.recipe("iron_ore", 2, 1, "iron_ingot", 0, 1);
    require(inPlace.take(player, "iron_ingot", 1, 1) == 1,
        "conserved in-place vanilla insertion lost existing source ownership");
    inPlace.setInput(null, "iron_ore", 2);
    inPlace.recipe("iron_ore", 2, 1, "iron_ingot", 0, 1);
    require(inPlace.take(player, "iron_ingot", 1, 1) == 0,
        "direct positive write after settlement inherited the old click's ownership");
  }
}
