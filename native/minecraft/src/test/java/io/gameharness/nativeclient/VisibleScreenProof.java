package io.gameharness.nativeclient;

import com.google.gson.*;
import java.util.List;
import java.util.Map;

/** Pure application fences; the parent separately exercises the actual vanilla widgets. */
public final class VisibleScreenProof {
  private static void require(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
  private static JsonObject object(String value) { return JsonParser.parseString(value).getAsJsonObject(); }
  private static void rejects(Runnable action, String reason) {
    boolean rejected = false;
    try { action.run(); } catch (IllegalArgumentException expected) { rejected = true; }
    require(rejected, reason);
  }
  private static void ownedModifierPolling() {
    // The native HandledScreen polls these GLFW modifiers directly, bypassing Screen.hasShiftDown.
    for (int key : new int[]{340, 344}) {
      require(VisibleScreenContract.ownedModifierPoll(true, 7, 7, key, true, false), "owned shift lost in direct vanilla poll");
      require(!VisibleScreenContract.ownedModifierPoll(true, 7, 7, key, false, true), "control fabricated shift");
      require(!VisibleScreenContract.ownedModifierPoll(false, 7, 7, key, true, true), "unowned/out-of-call poll inherited modifiers");
      require(!VisibleScreenContract.ownedModifierPoll(true, 8, 7, key, true, true), "other window inherited modifiers");
    }
    for (int key : new int[]{341, 345}) {
      require(VisibleScreenContract.ownedModifierPoll(true, 7, 7, key, false, true), "owned control lost in direct vanilla poll");
      require(!VisibleScreenContract.ownedModifierPoll(true, 7, 7, key, true, false), "shift fabricated control");
      require(!VisibleScreenContract.ownedModifierPoll(false, 7, 7, key, true, true), "revoked control remained polled");
      require(!VisibleScreenContract.ownedModifierPoll(true, 8, 7, key, true, true), "control leaked to another window");
    }
    for (int key = -1; key <= 400; key++) {
      if (key == 340 || key == 344 || key == 341 || key == 345) continue;
      require(!VisibleScreenContract.ownedModifierPoll(true, 7, 7, key, true, true), "modifier route enabled an unrelated physical key: " + key);
    }
  }
  private static void renderedChoices() {
    // Removing semantic/page/owner comparisons must fail these tests, not merely alter a DTO.
    var regions = new VisibleScreenContract.RenderedRegions();
    Object screen = new Object();
    var first = new VisibleScreenContract.Region("cell-0", "page0:stone:stairs", "choice", "1 stone_stairs", true, 52, 14, 16, 18);
    regions.publish(screen, List.of(first));
    String firstId = regions.elements().getFirst().id();
    require(regions.find(firstId).region().contains(52, 14), "top-left rendered choice excluded");
    require(!regions.find(firstId).region().contains(68, 14) && !regions.find(firstId).region().contains(52, 32), "exclusive choice bounds leaked");
    regions.publish(screen, List.of(new VisibleScreenContract.Region("cell-0", "page0:stone:stairs", "choice", "selected 1 stone_stairs", true, 52, 14, 16, 18)));
    require(regions.find(firstId) != null, "selection-only content change replaced semantic binding");
    require(regions.find(firstId).region().text().equals("selected 1 stone_stairs"), "same-binding content remained stale");
    regions.publish(screen, List.of(new VisibleScreenContract.Region("cell-0", "page4:stone:slab", "choice", "2 stone_slab", true, 52, 14, 16, 18)));
    require(regions.find(firstId) == null, "old page choice selected a different recipe");
    String pageId = regions.elements().getFirst().id();
    regions.publish(screen, List.of(new VisibleScreenContract.Region("cell-0", "page4:andesite:slab", "choice", "2 andesite_slab", true, 52, 14, 16, 18)));
    require(regions.find(pageId) == null, "input-local binding change retained old choice");
    String localId = regions.elements().getFirst().id();
    regions.publish(screen, List.of(new VisibleScreenContract.Region("cell-0", "page4:andesite:slab", "choice", "2 andesite_slab", true, 72, 14, 16, 18)));
    require(regions.find(localId) == null, "resized/moved region retained old target");
    String resizedId = regions.elements().getFirst().id();
    regions.publish(new Object(), regions.elements().stream().map(VisibleScreenContract.RenderedElement::region).toList());
    require(regions.find(resizedId) == null, "replacement screen inherited choice id");
    regions.publish(screen, List.of(new VisibleScreenContract.Region("grid", "page4", "scroll_region", "stonecutter recipes", true, 52, 14, 64, 54)));
    String scrollId = regions.elements().getFirst().id();
    require(regions.find(scrollId).region().accepts("scroll") && !regions.find(scrollId).region().accepts("element"), "scroll region admitted a fabricated click");
    require(first.accepts("element") && !first.accepts("scroll"), "choice admitted a global wheel operation");
    require(!new VisibleScreenContract.Region("disabled", "binding", "choice", "unavailable", false, 0, 0, 16, 16).accepts("element"), "disabled icon admitted input");
    regions.publish(screen, List.of(new VisibleScreenContract.Region("grid", "page8", "scroll_region", "stonecutter recipes", true, 52, 14, 64, 54)));
    require(regions.find(scrollId) == null, "old scroll target survived a page change");
    scrollId = regions.elements().getFirst().id();
    regions.publish(screen, List.of());
    require(regions.find(scrollId) == null, "undrawn region remained actionable");
    rejects(() -> new VisibleScreenContract.Region("bad", "binding", "choice", "bad", true, 0, 0, 0, 16), "zero-area choice admitted");
    rejects(() -> new VisibleScreenContract.Region("bad", "binding", "choice", "x".repeat(257), true, 0, 0, 16, 16), "overlong visible text admitted");
    rejects(() -> regions.publish(screen, java.util.Collections.nCopies(65, first)), "over-limit frame silently truncated");
    rejects(() -> regions.publish(screen, List.of(first, first)), "duplicate rendered binding admitted");
    for (String pair : new String[]{"-16,16", "0,0", "0.25,-0.5"}) {
      String[] values = pair.split(",");
      var scroll = VisibleScreenContract.decode(object("{\"kind\":\"scroll\",\"element_id\":\"grid\",\"horizontal\":" + values[0] + ",\"vertical\":" + values[1] + "}"));
      require(scroll.horizontal() == Double.parseDouble(values[0]) && scroll.vertical() == Double.parseDouble(values[1]), "wheel notches normalized or lost");
    }
    for (String invalid : new String[]{"16.0001", "-16.0001", "\"1\"", "null", "1e9999"}) {
      rejects(() -> VisibleScreenContract.decode(object("{\"kind\":\"scroll\",\"element_id\":\"grid\",\"horizontal\":0,\"vertical\":" + invalid + "}")), "nonfinite/out-of-range wheel admitted");
    }
    rejects(() -> VisibleScreenContract.decode(object("{\"kind\":\"scroll\",\"element_id\":\"grid\",\"horizontal\":0,\"vertical\":1,\"page\":2}")), "hidden page selector admitted");
    rejects(() -> VisibleScreenContract.decode(object("{\"kind\":\"scroll\",\"element_id\":\"\",\"horizontal\":0,\"vertical\":1}")), "untargeted wheel admitted");
  }
  private static void typedLayouts() {
    // Missing exact binding/geometry/owner comparisons would admit stale targets.
    var layout = new VisibleScreenContract.RenderedLayout();
    Object screen = new Object(), slot = new Object();
    require(publishLayout(layout, screen, slot, "Aa", true, 12, 320, 2), "first layout not published");
    require(!publishLayout(layout, screen, slot, "Aa", true, 12, 320, 2), "unchanged layout churned");
    require(publishLayout(layout, screen, slot, "BB", true, 12, 320, 2), "equal-hash binding admitted stale element");
    require(publishLayout(layout, screen, slot, "BB", false, 12, 320, 2), "disabled control retained grant");
    require(publishLayout(layout, screen, slot, "BB", false, 13, 320, 2), "moved target retained grant");
    require(publishLayout(layout, screen, slot, "BB", false, 13, 321, 2), "viewport resize retained grant");
    require(publishLayout(layout, screen, slot, "BB", false, 13, 321, 3), "GUI scale retained grant");
    require(publishLayout(layout, screen, new Object(), "BB", false, 13, 321, 3), "replaced slot retained binding");
    require(publishLayout(layout, new Object(), slot, "BB", false, 13, 321, 3), "replacement owner retained layout");
    layout.begin(screen, 321, 240, 3); layout.slot(slot, 4, 13, 20, true);
    require(layout.finish(), "disappeared control retained layout");
    layout.begin(screen, 321, 240, 3); layout.slot(slot, 4, 13, 20, true);
    require(!layout.finish(), "stable slot-only layout churned");
    layout.begin(screen, 400, 240, 3); layout.slot(slot, 4, 13, 20, true);
    // A later live-binding freshness check can throw before publication finishes.
    layout.begin(screen, 400, 240, 3); layout.slot(slot, 4, 13, 20, true);
    require(layout.finish(), "interrupted refresh swallowed resize invalidation");
    layout.begin(screen, 400, 240, 3); layout.slot(slot, 4, 13, 20, false);
    layout.element("button", true, 30, 40, 16, 18); require(layout.finish(), "slot enablement/control appearance lost");
    layout.begin(screen, 400, 240, 3); layout.slot(slot, 4, 13, 20, false);
    layout.element("button", true, 31, 40, 16, 18); require(layout.finish(), "moved element retained grant");
    layout.begin(screen, 400, 240, 3); layout.slot(slot, 4, 13, 20, true);
    layout.element("button", true, 31, 40, 16, 18); require(layout.finish(), "slot enablement retained stale grant");
  }
  private static boolean publishLayout(VisibleScreenContract.RenderedLayout layout, Object screen, Object slot,
      String element, boolean enabled, int x, int width, double scale) {
    layout.begin(screen, width, 240, scale); layout.slot(slot, 4, x, 20, true);
    layout.element(element, enabled, 30, 40, 16, 18); return layout.finish();
  }
  private static void terminalReceiptRetirement() {
    // Omitting retirement before the next ARM poisons that legitimate operation.
    for (boolean acknowledged : new boolean[]{false, true}) {
      for (int terminalContext : new int[]{0, 1, 2}) {
        boolean replaced = terminalContext == 1, alive = terminalContext != 2;
        Object player = new Object(), handler = new Object(), replacement = new Object();
        var server = new GuiProductionLedger.Session(player);
        var client = new GuiReceiptFence();
        require(client.arm(1, 7, 4) && server.arm(1, 7, handler, 4, true, 0).confirmed(), "old bracket did not arm");
        if (acknowledged) require(client.accept(1, 7, 4, "arm"), "old ARM acknowledgement refused");
        require(client.revoke(), "terminal owner failed to request outstanding diagnostic FINISH");
        require(!client.revoke(), "terminal retirement duplicated diagnostic FINISH");
        var retired = server.finish(1, 7, replaced ? replacement : handler, replaced ? 5 : 4, alive, 1);
        require(retired.confirmed() == (terminalContext == 0), "old handler/death retirement changed receipt certainty");
        if (terminalContext != 0) require(retired.reason().equals(replaced ? "handler_changed" : "not_alive"), "retirement lost its handler/death reason");
        require(!client.accept(1, 7, 4, "arm") && !client.accept(1, 7, 4, "finish"), "terminal ACK revived retired owner");
        require(client.arm(2, 8, 5) && server.arm(2, 8, replacement, 5, true, 2).confirmed(), "old bracket poisoned next legitimate ARM");
        require(!client.accept(1, 7, 4, "finish") && !client.accept(1, 7, 4, "arm"), "old ACK crossed fresh bracket");
        require(client.accept(2, 8, 5, "arm"), "fresh operation lost its matching ACK");
        require(client.finish(), "fresh FINISH not admitted");
        require(!client.revoke(), "already-sent FINISH duplicated on terminal path");
        require(!client.accept(2, 8, 5, "finish"), "lost FINISH ACK upgraded terminal owner");
      }
    }
    var receipts = new GuiReceiptFence();
    require(!receipts.revoke(), "unarmed owner emitted diagnostic FINISH");
    require(receipts.arm(1, 7, 4) && receipts.accept(1, 7, 4, "arm") && receipts.finish()
        && receipts.accept(1, 7, 4, "finish"), "ordinary bracket failed");
    require(!receipts.revoke(), "completed bracket emitted diagnostic FINISH");
  }
  private static void productionReceiptBounds() {
    // The real ledger's 33rd through 64th events must survive client validation.
    for (int count : new int[]{32, 33, 64, 65}) {
      Object player = new Object(), handler = new Object();
      var ledger = new GuiProductionLedger.Session(player);
      require(ledger.arm(1, 7, handler, 4, true, 0).confirmed(), "production bracket refused");
      JsonArray payload = new JsonArray();
      for (int i = 0; i < count; i++) {
        ledger.take(player, handler, true, "crafting", "stone_bricks", 4, true);
        payload.add(object("{\"producer\":\"crafting\",\"item\":\"stone_bricks\",\"count\":4,\"source\":\"server_result_slot_take\",\"production_confirmed\":true}"));
      }
      var outcome = ledger.finish(1, 7, handler, 4, true, 1);
      if (count == 65) {
        require(!outcome.confirmed() && outcome.reason().equals("overflow") && outcome.productions().isEmpty(), "65th server event escaped overflow/unknown");
        rejects(() -> VisibleScreenContract.validateProductions(payload), "65th client production silently accepted");
      } else {
        require(outcome.confirmed() && outcome.productions().size() == count, "bounded server production disappeared");
        VisibleScreenContract.validateProductions(payload);
      }
    }
    for (String patch : new String[]{
        "\"source\":\"possession\"", "\"producer\":\"stonecutting\"", "\"item\":\"minecraft:stone\"",
        "\"count\":0", "\"count\":4097", "\"count\":\"4\"", "\"production_confirmed\":\"true\""}) {
      JsonObject row = object("{\"producer\":\"crafting\",\"item\":\"stone_bricks\",\"count\":4,\"source\":\"server_result_slot_take\",\"production_confirmed\":true}");
      JsonObject changed = object("{" + patch + "}");
      for (var entry : changed.entrySet()) row.add(entry.getKey(), entry.getValue());
      JsonArray payload = new JsonArray(); payload.add(row);
      rejects(() -> VisibleScreenContract.validateProductions(payload), "invalid production accepted: " + patch);
    }
    JsonArray payload = new JsonArray();
    payload.add(object("{\"producer\":\"crafting\",\"item\":\"stone_bricks\",\"count\":4,\"source\":\"server_result_slot_take\",\"production_confirmed\":true,\"hidden\":1}"));
    rejects(() -> VisibleScreenContract.validateProductions(payload), "extra production payload accepted");
  }
  private static void pointerContinuityAcrossRequests() {
    // Real per-request handoff: a new gesture must not reset a still-open GUI pointer.
    var pointer = new VisiblePointerPosition();
    Object screen = new Object(), handler = new Object();
    pointer.begin(screen, handler, 7, 426, 240, 213, 112);
    double[][] landings = {{230.5, 63.5}, {249.5, 63.5}, {230.5, 81.5}, {249.5, 81.5}};
    for (double[] landing : landings) {
      pointer.update(screen, handler, 7, 426, 240, landing[0], landing[1]);
      require(pointer.matches(screen, handler, 7, 426, 240),
          "idle frames lost the last pointer while the same GUI remained open");
      pointer.begin(screen, handler, 7, 426, 240, 213, 112);
      var next = new InventoryPointerMotion(17);
      next.plan(pointer.x(), pointer.y(), 280, 70, 16, 16, InventoryPointerMotion.Category.TRANSFER);
      require(next.fromX == landing[0] && next.fromY == landing[1],
          "next ordinary request teleported from the previous crafting slot to the inventory seed");
    }
    Object replacement = new Object(), replacementHandler = new Object();
    pointer.begin(replacement, replacementHandler, 7, 426, 240, 30, 31);
    pointer.update(screen, handler, 7, 426, 240, 213, 112);
    require(pointer.x() == 30 && pointer.y() == 31 && !pointer.matches(screen, handler, 7, 426, 240),
        "an old GUI driver overwrote the replacement pointer context");
    for (int change = 0; change < 4; change++) {
      Object nextScreen = change == 0 ? new Object() : replacement;
      Object nextHandler = change == 1 ? new Object() : replacementHandler;
      long nextWindow = change == 2 ? 8 : 7;
      int nextWidth = change == 3 ? 640 : 426;
      pointer.begin(replacement, replacementHandler, 7, 426, 240, 30, 31);
      pointer.update(replacement, replacementHandler, 7, 426, 240, 249.5, 81.5);
      pointer.begin(nextScreen, nextHandler, nextWindow, nextWidth, 240, 40, 41);
      require(pointer.x() == 40 && pointer.y() == 41,
          "changed screen, handler, window or viewport reused an old GUI coordinate");
    }
    pointer.clear();
    pointer.begin(replacement, replacementHandler, 7, 426, 240, 50, 51);
    require(pointer.x() == 50 && pointer.y() == 51,
        "closing and reopening the same screen object revived an old cursor position");
  }
  public static void main(String[] ignored) {
    ownedModifierPolling();
    renderedChoices();
    typedLayouts();
    terminalReceiptRetirement();
    pointerContinuityAcrossRequests();
    productionReceiptBounds();
    var empty = new VisibleScreenContract.Value(null, 0);
    var ore = new VisibleScreenContract.Value("raw_iron", 3);
    var coal = new VisibleScreenContract.Value("coal", 2);
    var slots = Map.of(0, ore, 1, coal, 2, empty);
    var click = VisibleScreenContract.decode(object("{\"kind\":\"slot\",\"slot_id\":0,\"button\":\"right\",\"mode\":\"ordinary\",\"hotbar_slot\":null,\"expected_cursor\":{\"item\":null,\"count\":0},\"expected_slots\":[{\"slot_id\":0,\"value\":{\"item\":\"raw_iron\",\"count\":3}}]}"));
    require(VisibleScreenContract.matches(click, empty, slots), "fresh source/cursor refused");
    require(VisibleScreenContract.matches(click, empty, Map.of(0, ore, 1, coal, 2, new VisibleScreenContract.Value("iron_ingot", 1))), "unrelated furnace output invalidated local source");
    require(!VisibleScreenContract.matches(click, coal, slots), "conflicting cursor admitted");
    require(!VisibleScreenContract.matches(click, empty, Map.of(0, coal, 1, coal, 2, empty)), "conflicting source admitted");
    for (String mode : new String[]{"shift", "hotbar"}) {
      JsonObject input = object("{\"kind\":\"slot\",\"slot_id\":0,\"button\":\"left\",\"mode\":\"" + mode + "\",\"hotbar_slot\":" + (mode.equals("hotbar") ? "8" : "null") + ",\"expected_cursor\":{\"item\":null,\"count\":0},\"expected_slots\":[{\"slot_id\":0,\"value\":{\"item\":\"raw_iron\",\"count\":3}}]}");
      require(VisibleScreenContract.matches(VisibleScreenContract.decode(input), empty, slots), "ordinary vanilla mode unavailable: " + mode);
    }
    for (String key : new String[]{"escape", "shift", "control", "1", "9", "enter", "backspace", "delete", "left", "right", "home", "end"}) {
      require(VisibleScreenContract.decode(object("{\"kind\":\"key\",\"key\":\"" + key + "\",\"phase\":\"press\"}")).key().equals(key), "finite key lost");
    }
    boolean bad = false;
    try { VisibleScreenContract.decode(object("{\"kind\":\"key\",\"key\":\"f3\",\"phase\":\"press\"}")); } catch (IllegalArgumentException expected) { bad = true; }
    require(bad, "debug key admitted");
    var incarnations = new ScreenIncarnations(); Object first = new Object(), replacement = new Object();
    incarnations.viewChanged(first); var identity = incarnations.visible();
    incarnations.layoutChanged(first, "geometry-a"); identity = incarnations.visible();
    incarnations.transactionChanged(first);
    require(incarnations.visible().equals(identity), "content mutation changed layout identity");
    incarnations.layoutChanged(first, "geometry-b");
    require(!incarnations.visible().equals(identity), "resize retained old layout");
    var authority = new EffectAuthority("session", "world", 1);
    String hash = "a".repeat(64);
    var space = new EffectAuthority.Space("minecraft:overworld", 1);
    var screenRef = incarnations.screen();
    authority.bind(hash, 1, space, screenRef);
    var scope = new EffectAuthority.Scope("session", "world", 1, authority.nativeBootId(), "run", 1, 1, 1, "execution", hash);
    var owner = new EffectAuthority.Owner("operation", scope, authority.cancellationGeneration());
    var precondition = EffectAuthority.ScreenPrecondition.layout(incarnations.visible());
    require(authority.grant(owner, hash, precondition) == EffectAuthority.Rejection.NONE, "layout identity not admitted");
    incarnations.transactionChanged(first); authority.screenChanged(incarnations.screen());
    require(authority.validateApplication(owner, hash, precondition) == EffectAuthority.Rejection.NONE, "content transaction invalidated layout admission");
    require(NativeEffectContract.precondition(NativeEffectContract.precondition(precondition)).equals(precondition), "strict layout codec changed identity");
    var oldShape = NativeEffectContract.screen(screenRef).getAsJsonObject(); boolean legacyRejected = false;
    try { NativeEffectContract.precondition(oldShape); } catch (RuntimeException expected) { legacyRejected = true; }
    require(legacyRejected, "old transaction wire became a new authority grant");
    var fence = new InventoryGestureFence(first, first, 7); fence.press();
    incarnations.viewChanged(replacement);
    authority.screenChanged(incarnations.screen());
    require(authority.validateApplication(owner, hash, precondition) == EffectAuthority.Rejection.STALE_SCREEN, "replacement view inherited layout owner");
    require(!fence.allows(replacement, replacement, 7, true), "old held release redirected into replacement");
    fence.revoke(); require(!fence.held(), "Stop retained held drag");
    GuiReceiptFence receipts = new GuiReceiptFence();
    require(receipts.arm(1, 7, 4), "initial receipt did not arm");
    require(!receipts.accept(2, 7, 4, "arm"), "unmatched nonce accepted");
    require(!receipts.accept(1, 8, 4, "arm"), "old generation accepted");
    require(!receipts.accept(1, 7, 5, "arm"), "replacement sync accepted");
    require(receipts.accept(1, 7, 4, "arm"), "matching arm refused");
    require(!receipts.accept(1, 7, 4, "arm"), "duplicate arm accepted");
    require(receipts.finish(), "finish not ordered after arm");
    require(receipts.accept(1, 7, 4, "finish"), "matching finish refused");
    require(!receipts.accept(1, 7, 4, "finish"), "duplicate finish credited twice");
    require(receipts.arm(2, 7, 4), "next transaction did not arm"); receipts.revoke();
    require(!receipts.accept(2, 7, 4, "finish") && !receipts.arm(2, 7, 4), "lost receipt replayed nonce");
    require(VisibleScreenContract.total(slots, empty) == 5, "empty slots or cursor altered conservation");
    require(VisibleScreenContract.total(Map.of(0, new VisibleScreenContract.Value("raw_iron", 1), 1, coal, 2, empty), new VisibleScreenContract.Value("raw_iron", 2)) == 5, "right-click cursor custody disappeared");
    System.out.println("Visible screen local-custody/layout/release/receipt/conservation proof passed");
  }
}
