package io.gameharness.nativeclient;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import io.gameharness.nativeclient.mixin.HandledScreenAccess;
import io.gameharness.nativeclient.mixin.RecipeBookScreenAccess;
import java.util.function.BooleanSupplier;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.gui.screen.ingame.RecipeBookScreen;
import net.minecraft.item.ItemStack;
import net.minecraft.network.packet.c2s.play.UpdateSelectedSlotC2SPacket;
import net.minecraft.registry.Registries;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.screen.PlayerScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;

/** One semantic operation's actual vanilla screen, pointer and bounded pickup gestures. */
public final class VisibleInventory {
  public enum Gesture {
    ACQUIRE(InventoryPointerMotion.Category.ACQUISITION),
    DISTRIBUTE(InventoryPointerMotion.Category.DISTRIBUTION),
    RETURN(InventoryPointerMotion.Category.TRANSITION),
    RESULT(InventoryPointerMotion.Category.TRANSITION),
    TRANSFER(InventoryPointerMotion.Category.TRANSFER);

    private final InventoryPointerMotion.Category category;
    Gesture(InventoryPointerMotion.Category category) { this.category = category; }
  }

  public static final long EQUIP_MS = 12_000, PLACE_MS = 20_000;
  public static long craftMillis(int executions) { return 10_000L + 35_000L * executions; }
  private static VisibleInventory active;
  public static boolean owned() { return active != null; }
  private final MinecraftClient client;
  private final BooleanSupplier authorized;
  private final boolean table;
  private HandledScreen<?> screen;
  private ScreenHandler handler;
  private InventoryGestureFence fence;
  private ItemStack[] expected;
  private ItemStack cursor, targetBefore;
  private int[] layout;
  private Slot[] slots;
  private int phase, targetSlot = -1, button, gestures, frames, phaseFrame;
  private final long startedAt = System.nanoTime();
  private final InventoryPointerMotion motion = new InventoryPointerMotion(startedAt);
  private final JsonArray gestureEvents = new JsonArray();
  private final int[] gestureCounts = new int[Gesture.values().length];
  private final int[] gesturePressCounts = new int[Gesture.values().length];
  private long stageAt;
  private double x, y;
  private Gesture purpose;
  private JsonObject gestureEvent;
  private int gestureAttempts, ingredientGroup, groupSource = -1, resizeRetargets;
  private int originX, originY;
  private int screenBindings, screenCloses;
  private boolean failed, closed, emitted;
  private boolean releaseTransfers;
  private boolean quickMove, quickMovePressed, ownedShift, calling;
  private BooleanSupplier quickMoveEligible, allowedSettlement, settled;
  private long window, quickMovePressedAt;
  private int quickMovePresses, quickMoveGestures;
  private String reason;
  private int equipSource = -1, equipDestination = -1, equipPhase;
  private boolean equipment, direct;

  public VisibleInventory(MinecraftClient client, boolean table, BooleanSupplier authorized) {
    if (active != null || VisibleScreen.owned()) throw new IllegalStateException("Inventory session already owned");
    this.client = client;
    this.table = table;
    this.authorized = authorized;
    active = this;
    stageAt = System.nanoTime();
  }

  public void openInventory() {
    if (!authorized.getAsBoolean() || client.currentScreen != null
        || client.player.currentScreenHandler != client.player.playerScreenHandler || !emptyPlayerCustody()) {
      fail("inventory_open_scope_changed");
      return;
    }
    client.setScreen(new InventoryScreen(client.player));
    bind();
  }

  public boolean bind() {
    if (screen != null) return valid();
    if (!authorized.getAsBoolean()) { fail("authority_revoked"); return false; }
    if (table) {
      if (!(client.currentScreen instanceof CraftingScreen)
          || !(client.player.currentScreenHandler instanceof CraftingScreenHandler)) return false;
    } else if (!(client.currentScreen instanceof InventoryScreen)
        || !(client.player.currentScreenHandler instanceof PlayerScreenHandler)) return false;
    screen = (HandledScreen<?>) client.currentScreen;
    window = client.getWindow().getHandle();
    screenBindings++;
    handler = client.player.currentScreenHandler;
    if (screen.getScreenHandler() != handler) { fail("screen_handler_mismatch"); return false; }
    fence = new InventoryGestureFence(screen, handler, handler.syncId);
    var access = (HandledScreenAccess) screen;
    originX = access.gameharness$x(); originY = access.gameharness$y();
    x = originX + 88; y = originY + 75;
    layout = new int[handler.slots.size() * 3];
    slots = new Slot[handler.slots.size()];
    for (int i = 0; i < handler.slots.size(); i++) {
      Slot slot = handler.slots.get(i);
      slots[i] = slot;
      layout[i * 3] = slot.id; layout[i * 3 + 1] = slot.x; layout[i * 3 + 2] = slot.y;
    }
    snapshot();
    stageAt = System.nanoTime();
    return true;
  }

  public ScreenHandler handler() { return handler; }
  public boolean failed() { return failed; }
  public boolean closed() { return closed; }
  public boolean emitted() { return emitted; }
  public String reason() { return reason; }
  public boolean ownsHandler() { return screen != null && !failed && !closed && valid(); }
  public boolean busy() { return phase != 0; }

  /** Modifier ownership exists only inside this owner's ordinary vanilla mouse callback. */
  public static boolean modifiersOwned() {
    VisibleInventory owner = active;
    return owner != null && owner.callbackOwned();
  }

  public static boolean shiftDown() {
    VisibleInventory owner = active;
    return owner != null && owner.callbackOwned() && owner.ownedShift;
  }

  public static boolean ownedKeyPoll(long window, int key) {
    VisibleInventory owner = active;
    return owner != null && window == owner.window
        && VisibleScreenContract.ownedModifierPoll(owner.callbackOwned(), window, owner.window,
            key, owner.ownedShift, false);
  }

  private boolean callbackOwned() {
    if (active != this || !calling || failed || closed || !client.isOnThread()
        || client.getWindow() == null || client.getWindow().getHandle() != window
        || client.player == null || client.player.isDead() || client.currentScreen != screen
        || client.player.currentScreenHandler != handler || screen.getScreenHandler() != handler)
      return false;
    try {
      // A legitimate result press consumes the grid before vanilla finishes polling modifiers.
      // Custody and recipe eligibility are checked BEFORE entry, never against that consumed grid.
      return authorized.getAsBoolean()
          && fence.allows(client.currentScreen, client.player.currentScreenHandler, handler.syncId, true);
    } catch (RuntimeException error) {
      return false;
    }
  }

  private void snapshot() {
    if (expected == null) expected = new ItemStack[handler.slots.size()];
    for (int i = 1; i < expected.length; i++) expected[i] = handler.slots.get(i).getStack().copy();
    cursor = handler.getCursorStack().copy();
  }

  private boolean custodyMatches() {
    if (handler.slots.size() != expected.length || !ItemStack.areEqual(cursor, handler.getCursorStack())) return false;
    boolean matches = true;
    for (int i = 0; i < handler.slots.size(); i++) {
      Slot slot = handler.slots.get(i);
      if (slot != slots[i] || slot.id != layout[i * 3] || slot.x != layout[i * 3 + 1] || slot.y != layout[i * 3 + 2])
        return false;
      if (i > 0 && !ItemStack.areEqual(expected[i], slot.getStack())) matches = false;
    }
    if (!quickMove || !quickMovePressed) return matches;
    try {
      // Only this batch's original-footprint guard may admit authoritative post-press changes.
      if (allowedSettlement == null || !allowedSettlement.getAsBoolean()) return false;
    } catch (RuntimeException error) {
      fail("quick_move_settlement_guard_exception"); return false;
    }
    if (!matches) snapshot();
    return true;
  }

  private boolean valid() {
    if (failed || closed || fence == null) return false;
    boolean permitted;
    try {
      permitted = authorized.getAsBoolean();
    } catch (RuntimeException error) {
      fail("authority_check_exception"); return false;
    }
    if (!permitted || client.player == null || client.player.isDead()
        || client.currentScreen != screen || client.player.currentScreenHandler != handler
        || screen.getScreenHandler() != handler
        || quickMove && (!client.isOnThread() || client.getWindow() == null || client.getWindow().getHandle() != window)
        || !fence.allows(client.currentScreen, client.player.currentScreenHandler, handler.syncId, true)) {
      fail("handler_layout_or_custody_changed");
      return false;
    }
    if (quickMovePressed && System.nanoTime() - quickMovePressedAt >= 1_500_000_000L) {
      fail("quick_move_settlement_timeout"); return false;
    }
    if (!custodyMatches()) {
      fail("handler_layout_or_custody_changed"); return false;
    }
    return true;
  }

  public boolean ready() {
    if (!valid() || busy() || frames == 0 || System.nanoTime() - stageAt < 250_000_000L) return false;
    if (screen instanceof RecipeBookScreen<?> && ((RecipeBookScreenAccess) screen).gameharness$book().isOpen()) {
      var position = ((RecipeBookScreenAccess) screen).gameharness$bookButton();
      move(-1, position.x() + 3, position.y() + 2, 14, 14, 0, Gesture.TRANSFER);
      return false;
    }
    return true;
  }

  public void beginIngredientGroup(int sourceSlot) {
    if (!valid() || busy()) return;
    ingredientGroup++;
    groupSource = sourceSlot;
    motion.beginGroup(sourceSlot);
  }

  public boolean click(int slotId, int button, Gesture purpose) {
    if (!valid() || busy() || slotId < 0 || slotId >= handler.slots.size()) return false;
    Slot slot = handler.getSlot(slotId);
    if (!slot.isEnabled()) { fail("slot_disabled"); return false; }
    var access = (HandledScreenAccess) screen;
    targetBefore = slot.getStack().copy();
    move(slotId, access.gameharness$x() + slot.x, access.gameharness$y() + slot.y,
        16, 16, button, purpose);
    return true;
  }

  /**
   * One visible vanilla Shift+left result click. The caller supplies exact pre-press eligibility,
   * an original-batch-footprint settlement guard, and the full-batch completion predicate.
   */
  public boolean quickMoveResult(BooleanSupplier eligible, BooleanSupplier allowedSettlement, BooleanSupplier settled) {
    if (!valid() || busy()) return false;
    if (!quickMoveAllowed(eligible)) return false;
    if (allowedSettlement == null || settled == null) {
      fail("quick_move_settlement_guard_missing"); return false;
    }
    if (!client.isOnThread() || client.getWindow() == null || client.getWindow().getHandle() != window) {
      fail("quick_move_window_or_thread_changed"); return false;
    }
    if (!handler.getCursorStack().isEmpty()) { fail("quick_move_cursor_not_empty"); return false; }
    if (!click(0, 0, Gesture.RESULT)) return false;
    quickMove = true;
    quickMoveEligible = eligible;
    this.allowedSettlement = allowedSettlement;
    this.settled = settled;
    if (gestureEvent != null) gestureEvent.addProperty("mode", "shift");
    return true;
  }

  private boolean quickMoveAllowed(BooleanSupplier eligible) {
    try {
      if (eligible != null && eligible.getAsBoolean()) return true;
      fail("quick_move_ineligible");
    } catch (RuntimeException error) {
      fail("quick_move_eligibility_exception");
    }
    return false;
  }

  private void clearQuickMove() {
    quickMove = false;
    quickMovePressed = false;
    quickMoveEligible = null;
    allowedSettlement = null;
    settled = null;
    quickMovePressedAt = 0;
    ownedShift = false;
    calling = false;
  }

  private void move(int slotId, double left, double top, double width, double height,
      int button, Gesture purpose) {
    clearQuickMove();
    targetSlot = slotId; this.button = button;
    this.purpose = purpose;
    motion.plan(x, y, left, top, width, height, purpose.category);
    gestureAttempts++;
    gestureEvent = null;
    if (gestureEvents.size() < 128) {
      gestureEvent = new JsonObject();
      gestureEvent.addProperty("role", purpose.name().toLowerCase(java.util.Locale.ROOT));
      gestureEvent.addProperty("mode", "normal");
      gestureEvent.addProperty("slot", slotId); gestureEvent.addProperty("button", button);
      gestureEvent.addProperty("group", ingredientGroup);
      gestureEvent.addProperty("group_source_slot", groupSource);
      gestureEvent.addProperty("group_tempo", motion.groupTempo);
      gestureEvent.addProperty("started_ms", elapsedMillis(System.nanoTime()));
      gestureEvent.addProperty("completed", false);
      gestureEvents.add(gestureEvent);
      recordPlan();
    }
    phase = 1; stageAt = System.nanoTime(); phaseFrame = frames;
  }

  private double elapsedMillis(long now) { return (now - startedAt) / 1_000_000.0; }

  private void recordPlan() {
    if (gestureEvent == null) return;
    gestureEvent.addProperty("from_x", motion.fromX); gestureEvent.addProperty("from_y", motion.fromY);
    gestureEvent.addProperty("to_x", motion.toX); gestureEvent.addProperty("to_y", motion.toY);
    gestureEvent.addProperty("distance", motion.distance);
    gestureEvent.addProperty("travel_ms", motion.travelNanos / 1_000_000.0);
    gestureEvent.addProperty("press_ms", motion.pressNanos / 1_000_000.0);
    gestureEvent.addProperty("dwell_ms", motion.dwellNanos / 1_000_000.0);
    gestureEvent.addProperty("profile", motion.profile());
    gestureEvent.addProperty("curve", motion.curve());
  }

  private boolean gestureCapacity() {
    if (targetSlot < 0) return true;
    Slot slot = handler.getSlot(targetSlot);
    ItemStack moving = handler.getCursorStack(), existing = slot.getStack();
    if (moving.isEmpty()) return !existing.isEmpty() && slot.canTakeItems(client.player);
    if (!slot.canInsert(moving)) return false;
    if (existing.isEmpty() || ItemStack.areItemsAndComponentsEqual(existing, moving)) {
      int amount = button == 1 ? 1 : moving.getCount();
      return existing.getCount() + amount <= slot.getMaxItemCount(moving);
    }
    return button == 0 && slot.canTakeItems(client.player)
        && moving.getCount() <= slot.getMaxItemCount(moving);
  }

  public void tick() {
    if (failed || closed || screen == null || !valid()) return;
    long now = System.nanoTime();
    var access = (HandledScreenAccess) screen;
    if (originX != access.gameharness$x() || originY != access.gameharness$y()) {
      originX = access.gameharness$x(); originY = access.gameharness$y();
      if (fence.held()) { fail("layout_resized_during_press"); return; }
      if (phase == 1) {
        if (targetSlot < 0) {
          fail("recipe_book_layout_changed_before_press");
          return;
        }
        Slot slot = handler.getSlot(targetSlot);
        if (!slot.isEnabled()) { fail("slot_disabled_after_resize"); return; }
        motion.retarget(x, y, originX + slot.x, originY + slot.y, 16, 16);
        resizeRetargets++;
        if (gestureEvent != null) {
          gestureEvent.addProperty("resize_retargets", resizeRetargets);
          gestureEvent.addProperty("retargeted_ms", elapsedMillis(now));
          recordPlan();
        }
        stageAt = now; phaseFrame = frames;
        return;
      }
    }
    if (phase == 1 && now - stageAt >= motion.travelNanos && frames > phaseFrame
        && Math.abs(x - motion.toX) < .1 && Math.abs(y - motion.toY) < .1) {
      if (!targetStillUnderPointer()) return;
      if (targetSlot >= 0 && !ItemStack.areEqual(targetBefore, handler.getSlot(targetSlot).getStack())) {
        fail("target_stack_changed_before_press"); return;
      }
      if (!gestureCapacity()) { fail("gesture_destination_capacity_changed"); return; }
      if (quickMove) {
        if (!quickMoveAllowed(quickMoveEligible)) return;
        if (!valid() || !targetStillUnderPointer()) return;
        if (!client.isOnThread() || client.getWindow() == null || client.getWindow().getHandle() != window
            || !handler.getCursorStack().isEmpty()
            || !ItemStack.areEqual(targetBefore, handler.getSlot(targetSlot).getStack())
            || !gestureCapacity()) {
          fail("quick_move_scope_or_target_changed_before_press"); return;
        }
      }
      releaseTransfers = targetSlot >= 0 && !handler.getCursorStack().isEmpty();
      try {
        fence.press();
        if (!mouseCallback(true)) return;
        if (targetSlot < 0) {
          // The owned recipe-book button legitimately repositions this same layout.
          originX = access.gameharness$x(); originY = access.gameharness$y();
        }
        if (quickMove) {
          if (!valid()) return;
        } else snapshot();
      } catch (RuntimeException error) {
        fail("vanilla_press_exception"); return;
      }
      phase = 2; stageAt = now; phaseFrame = frames;
    } else if (phase == 2 && now - stageAt >= motion.pressNanos && frames > phaseFrame) {
      // Every release rechecks custody/handler first. Revocation NEVER calls this path.
      if (targetSlot >= 0 && !targetStillUnderPointer()) return;
      if (releaseTransfers && !gestureCapacity()) { fail("release_destination_capacity_changed"); return; }
      try {
        if (!mouseCallback(false)) return;
        fence.release();
        if (quickMove) {
          if (!valid()) return;
        } else snapshot();
      } catch (RuntimeException error) {
        fail("vanilla_release_exception"); return;
      }
      gestures++;
      if (quickMove) quickMoveGestures++;
      gestureCounts[purpose.ordinal()]++;
      if (gestureEvent != null) gestureEvent.addProperty("completed", true);
      phase = 3; stageAt = now; phaseFrame = frames;
    } else if (phase == 3 && now - stageAt >= motion.dwellNanos && frames > phaseFrame) {
      if (quickMove) {
        try {
          if (!settled.getAsBoolean()) return;
        } catch (RuntimeException error) {
          fail("quick_move_settled_guard_exception"); return;
        }
        // The last batch-specific allowance ends before the caller accounts the completed batch.
        if (!valid()) return;
        if (gestureEvent != null) gestureEvent.addProperty("settled_ms", elapsedMillis(System.nanoTime()));
      }
      phase = 0;
      clearQuickMove();
      // The opening orientation dwell is not charged to every subsequent gesture.
      stageAt = now - 250_000_000L;
    }
  }

  private boolean mouseCallback(boolean press) {
    ownedShift = quickMove;
    calling = true;
    try {
      if (quickMove && !callbackOwned()) {
        fail("quick_move_callback_scope_changed"); return false;
      }
      if (press) {
        if (targetSlot >= 0) emitted = true;
        if (gestureEvent != null) gestureEvent.addProperty("pressed_ms", elapsedMillis(System.nanoTime()));
        gesturePressCounts[purpose.ordinal()]++;
        long pressedAt = System.nanoTime();
        if (quickMove) quickMovePresses++;
        boolean handled = screen.mouseClicked(Math.round(x), Math.round(y), button);
        if (quickMove && !handled) {
          fail("vanilla_quick_move_press_rejected"); return false;
        }
        if (quickMove) {
          quickMovePressed = true;
          quickMovePressedAt = pressedAt;
        }
      } else {
        if (gestureEvent != null) gestureEvent.addProperty("released_ms", elapsedMillis(System.nanoTime()));
        screen.mouseReleased(Math.round(x), Math.round(y), button);
      }
      return !failed && !closed;
    } finally {
      ownedShift = false;
      calling = false;
    }
  }

  private boolean targetStillUnderPointer() {
    if (targetSlot < 0) return true;
    Slot slot = handler.getSlot(targetSlot);
    double left = originX + slot.x, top = originY + slot.y;
    if (!slot.isEnabled() || x < left + 2 || x > left + 14 || y < top + 2 || y > top + 14) {
      fail("pointer_target_changed_before_effect");
      return false;
    }
    return true;
  }

  public int gridCount() {
    if (handler == null) return 0;
    int total = 0;
    for (int i = 1; i <= (table ? 9 : 4); i++) total += handler.getSlot(i).getStack().getCount();
    return total;
  }

  public boolean clean() {
    return handler != null && InventoryGestureFence.cleanCustody(handler.getCursorStack().getCount(), gridCount());
  }

  public void close() {
    if (!valid() || busy() || !clean()) { fail("unclean_inventory_close"); return; }
    try {
      fence.revoke();
      revokeGesture();
      client.player.closeHandledScreen();
      screenCloses++;
      closed = true;
    } finally {
      clearQuickMove();
      if (active == this) active = null;
    }
  }

  public void fail(String reason) {
    if (failed) return;
    this.reason = reason; failed = true;
    revoke();
  }

  private void revoke() {
    try {
      if (gestureEvent != null && (phase == 1 || phase == 2 || quickMove && phase == 3)) {
        gestureEvent.addProperty("revoked_ms", elapsedMillis(System.nanoTime()));
        gestureEvent.addProperty("revoked_phase", phase);
      }
      if (fence != null) fence.revoke();
      if (screen != null) revokeGesture();
    } finally {
      clearQuickMove();
      phase = 0;
      if (active == this) active = null;
    }
  }

  private void revokeGesture() {
    var access = (HandledScreenAccess) screen;
    access.gameharness$dragging(false);
    access.gameharness$dragSlots().clear();
    access.gameharness$cancelRelease(true);
  }

  /** Host lifecycle cleanup may close the exact old handler, never release its pending drag. */
  public void cancel(boolean trustedCleanup) {
    revoke();
    if (!closed && trustedCleanup && client.player != null && !client.player.isDead()
        && fence != null && fence.cleanupOwns(client.currentScreen, client.player.currentScreenHandler,
            client.player.currentScreenHandler.syncId)) {
      client.player.closeHandledScreen();
      screenCloses++;
      closed = true;
    }
  }

  public JsonObject diagnostics() {
    JsonObject value = new JsonObject();
    value.addProperty("gestures", gestures); value.addProperty("phase", phase);
    value.addProperty("screen_bindings", screenBindings); value.addProperty("screen_closes", screenCloses);
    value.addProperty("cursor_count", handler == null ? 0 : handler.getCursorStack().getCount());
    value.addProperty("grid_count", gridCount()); value.addProperty("closed", closed);
    value.addProperty("failed", failed); value.addProperty("held", fence != null && fence.held());
    value.addProperty("direct_hotbar", direct); value.addProperty("frames", frames);
    JsonObject counts = new JsonObject(), pressCounts = new JsonObject();
    for (Gesture role : Gesture.values()) {
      counts.addProperty(role.name().toLowerCase(java.util.Locale.ROOT), gestureCounts[role.ordinal()]);
      pressCounts.addProperty(role.name().toLowerCase(java.util.Locale.ROOT), gesturePressCounts[role.ordinal()]);
    }
    value.add("gesture_counts", counts); value.add("gesture_events", gestureEvents.deepCopy());
    value.add("gesture_press_counts", pressCounts);
    value.addProperty("gesture_attempts", gestureAttempts);
    value.addProperty("quick_move_presses", quickMovePresses);
    value.addProperty("quick_move_gestures", quickMoveGestures);
    value.addProperty("gesture_events_omitted", gestureAttempts - gestureEvents.size());
    // Preserve all 64 seed bits through the host's JavaScript JSON reader.
    value.addProperty("motion_seed", Long.toString(motion.seed));
    value.addProperty("ingredient_groups", ingredientGroup);
    value.addProperty("resize_retargets", resizeRetargets);
    if (reason != null) value.addProperty("reason", reason);
    return value;
  }

  private static boolean named(ItemStack stack, String name) {
    return !stack.isEmpty() && Registries.ITEM.getId(stack.getItem()).getPath().equals(name);
  }

  public boolean beginEquip(String name, String destination) {
    equipment = true;
    if (!authorized.getAsBoolean() || client.currentScreen != null
        || client.player.currentScreenHandler != client.player.playerScreenHandler || !emptyPlayerCustody()) {
      fail("equipment_open_custody_changed"); return false;
    }
    var inventory = client.player.getInventory();
    int destinationIndex = switch (destination) {
      case "hand" -> inventory.selectedSlot;
      case "off-hand" -> 40;
      case "head" -> 39;
      case "torso" -> 38;
      case "legs" -> 37;
      case "feet" -> 36;
      default -> -1;
    };
    if (destinationIndex < 0) { fail("invalid_equipment_destination"); return false; }
    if (named(inventory.getStack(destinationIndex), name)) return directComplete();
    int source = -1;
    for (int i = 0; i < inventory.size(); i++) if (named(inventory.getStack(i), name)) { source = i; break; }
    if (source < 0) { fail("equipment_item_unavailable"); return false; }
    if (destination.equals("hand") && source < 9) {
      inventory.selectedSlot = source;
      client.getNetworkHandler().sendPacket(new UpdateSelectedSlotC2SPacket(source));
      emitted = true;
      return directComplete();
    }
    if (destination.equals("hand")) {
      for (int i = 0; i < 9; i++) if (inventory.getStack(i).isEmpty()) { destinationIndex = i; break; }
    }
    openInventory();
    if (failed) return false;
    for (Slot slot : handler.slots) if (slot.inventory == inventory) {
      if (slot.getIndex() == source) equipSource = slot.id;
      if (slot.getIndex() == destinationIndex) equipDestination = slot.id;
    }
    if (equipSource < 0 || equipDestination < 0 || !clean()) { fail("equipment_custody_unavailable"); return false; }
    Slot src = handler.getSlot(equipSource), dst = handler.getSlot(equipDestination);
    ItemStack moving = src.getStack(), replaced = dst.getStack();
    if (!src.canTakeItems(client.player) || !dst.canTakeItems(client.player)
        || !dst.canInsert(moving) || moving.getCount() > dst.getMaxItemCount(moving)
        || !replaced.isEmpty() && (!src.canInsert(replaced) || replaced.getCount() > src.getMaxItemCount(replaced))) {
      fail("equipment_destination_capacity"); return false;
    }
    if (destination.equals("hand") && inventory.selectedSlot != destinationIndex) {
      inventory.selectedSlot = destinationIndex;
      client.getNetworkHandler().sendPacket(new UpdateSelectedSlotC2SPacket(destinationIndex));
      emitted = true;
    }
    return true;
  }

  private boolean directComplete() {
    direct = true; closed = true;
    if (active == this) active = null;
    return true;
  }

  private boolean emptyPlayerCustody() {
    ScreenHandler playerHandler = client.player.playerScreenHandler;
    if (!playerHandler.getCursorStack().isEmpty()) return false;
    for (int i = 1; i <= 4; i++) if (!playerHandler.getSlot(i).getStack().isEmpty()) return false;
    return true;
  }

  public void tickEquip() {
    if (!equipment || closed || failed) return;
    tick();
    if (!ready()) return;
    switch (equipPhase++) {
      case 0 -> click(equipSource, 0, Gesture.TRANSFER);
      case 1 -> click(equipDestination, 0, Gesture.TRANSFER);
      case 2 -> { if (!handler.getCursorStack().isEmpty()) click(equipSource, 0, Gesture.TRANSFER); }
      default -> { if (clean()) close(); else fail("equipment_cursor_not_returned"); }
    }
  }

  public static boolean preparePointer() {
    VisibleInventory session = active;
    if (session == null || !session.valid()) return false;
    if (session.phase == 1) {
      session.motion.advance(System.nanoTime() - session.stageAt);
      session.x = session.motion.x;
      session.y = session.motion.y;
    }
    return true;
  }
  public static int pointerX() { return (int) Math.round(active.x); }
  public static int pointerY() { return (int) Math.round(active.y); }

  public static void drawPointer(Screen screen, DrawContext context) {
    VisibleInventory session = active;
    if (session == null || session.screen != screen || !session.valid()) return;
    int px = (int) Math.round(session.x), py = (int) Math.round(session.y);
    // This is the SAME coordinate source used by vanilla hover/carried-stack and click dispatch.
    context.fill(px - 1, py - 1, px + 2, py + 10, 500, 0xFF111111);
    for (int i = 0; i < 7; i++) context.fill(px + i, py + i, px + i + 2, py + 8, 500, 0xFF111111);
    for (int i = 0; i < 5; i++) context.fill(px + i, py + i + 1, px + i + 1, py + 7, 501, 0xFFFFFFFF);
    session.frames++;
  }
}
