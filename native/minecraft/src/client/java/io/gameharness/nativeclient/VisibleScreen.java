package io.gameharness.nativeclient;

import com.google.gson.*;
import io.gameharness.nativeclient.mixin.HandledScreenAccess;
import java.util.*;
import java.util.function.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.gui.widget.ClickableWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;
import org.lwjgl.glfw.GLFW;

/** Single native writer over the incumbent vanilla GUI. Observation/settlement never closes its screen. */
public final class VisibleScreen {
  private static VisibleScreen active;
  private static final VisiblePointerPosition pointer = new VisiblePointerPosition();
  private static TextFieldWidget selectedField;
  private static Screen selectedFieldScreen;
  private final MinecraftClient client;
  private final ClientPlayNetworkHandler connection;
  private final VisibleScreenView view;
  private final HandledScreen<?> screen;
  private final ScreenHandler handler;
  private final InventoryGestureFence fence;
  private final BooleanSupplier authorized;
  private final IntSupplier nextNonce;
  private final Consumer<JsonObject> completion;
  private final BiConsumer<Integer, Long> application;
  private final long generation, deadline, window;
  private final String receiptPrefix;
  private final List<VisibleScreenContract.Operation> operations;
  private final InventoryPointerMotion motion;
  private final GuiReceiptFence receiptFence = new GuiReceiptFence();
  private final JsonArray transactions = new JsonArray(), gestures = new JsonArray();
  private final Set<Integer> heldKeys = new HashSet<>();
  private EffectAuthority.VisibleScreenRef layout;
  private VisibleScreenContract.Operation operation;
  private Map<Integer, VisibleScreenContract.Value> releaseSlots = Map.of();
  private VisibleScreenContract.Value releaseCursor;
  private JsonObject beforeInventory, gesture;
  private int index, phase, nonce, emitted, appliedPrefix, modifiers;
  private long stageAt, phaseFrame, receiptDeadline;
  private double x, y;
  private boolean done, calling;
  private String serverReceiptReason;
  private ClickableWidget targetWidget;
  private VisibleScreenView.Element targetElement;
  private NativeClient evaluation;

  public VisibleScreen(MinecraftClient client, VisibleScreenView view, JsonObject action,
      long generation, long receivedNanos, String receiptPrefix, BooleanSupplier authorized,
      IntSupplier nextNonce, BiConsumer<Integer, Long> application, Consumer<JsonObject> completion) {
    if (active != null || VisibleInventory.owned()) throw new IllegalStateException("GUI already has an owner");
    if (!(client.currentScreen instanceof HandledScreen<?> current) || client.player == null
        || current.getScreenHandler() != client.player.currentScreenHandler) throw new IllegalArgumentException("No supported current vanilla handler");
    this.client = client; connection = client.getNetworkHandler(); this.view = view; screen = current; handler = current.getScreenHandler();
    window = client.getWindow().getHandle();
    this.generation = generation; this.receiptPrefix = receiptPrefix; this.authorized = authorized;
    this.nextNonce = nextNonce; this.application = application; this.completion = completion;
    operations = VisibleScreenContract.operations(action);
    layout = NativeEffectContract.visibleScreen(action.getAsJsonObject("screen"));
    deadline = receivedNanos + (3000L + 4000L * operations.size()) * 1_000_000L;
    fence = new InventoryGestureFence(screen, handler, handler.syncId);
    motion = new InventoryPointerMotion(System.nanoTime());
    if (!layout.equals(currentLayout())) throw new IllegalArgumentException("Actual GUI layout changed before admission");
    var viewport = client.getWindow();
    pointer.begin(screen, handler, window, viewport.getScaledWidth(), viewport.getScaledHeight(),
        client.mouse.getX() * viewport.getScaledWidth() / viewport.getWidth(),
        client.mouse.getY() * viewport.getScaledHeight() / viewport.getHeight());
    x = pointer.x(); y = pointer.y();
    active = this;
  }
  /** Installed only for an explicitly enabled resident evaluation; ordinary GUI writers keep null. */
  void evaluation(NativeClient evaluation) { this.evaluation = evaluation; }
  boolean evaluationPressed() { return !done && phase == 3 && fence.held(); }
  public static boolean owned() { return active != null; }
  public static boolean modifiersOwned() { return active != null && active.calling; }
  public static boolean shiftDown() { return active != null && (active.modifiers & GLFW.GLFW_MOD_SHIFT) != 0; }
  public static boolean controlDown() { return active != null && (active.modifiers & GLFW.GLFW_MOD_CONTROL) != 0; }
  /** Only synchronous, authorized GUI calls may answer vanilla's direct modifier-key polls. */
  public static boolean ownedKeyPoll(long window, int key) {
    VisibleScreen owner = active;
    if (owner == null || !owner.client.isOnThread() || !owner.calling || owner.done
        || window != owner.window || owner.client.getWindow() == null
        || owner.client.getWindow().getHandle() != owner.window || System.nanoTime() >= owner.deadline
        || owner.client.player == null || owner.client.player.isDead()
        || owner.client.currentScreen != owner.screen || owner.client.player.currentScreenHandler != owner.handler)
      return false;
    boolean authorized = owner.authorized.getAsBoolean()
        && owner.fence.allows(owner.client.currentScreen, owner.client.player.currentScreenHandler, owner.handler.syncId, true);
    return VisibleScreenContract.ownedModifierPoll(authorized, window, owner.window, key,
        (owner.modifiers & GLFW.GLFW_MOD_SHIFT) != 0, (owner.modifiers & GLFW.GLFW_MOD_CONTROL) != 0);
  }
  /** Trusted diagnostics only; never included in visible_screen or the actor observation. */
  public static JsonElement diagnostics() {
    VisibleScreen owner = active;
    if (owner == null || owner.done) return JsonNull.INSTANCE;
    JsonObject out = new JsonObject(), pointer = new JsonObject();
    out.addProperty("active", true); out.addProperty("operation_index", owner.index);
    out.addProperty("phase", switch (owner.phase) {
      case 1 -> "awaiting_arm"; case 2 -> "travel"; case 3 -> "pressed";
      case 4 -> "awaiting_finish"; case 5 -> "dwell"; default -> "ready";
    });
    out.addProperty("held", owner.fence.held()); out.addProperty("applied_prefix", owner.appliedPrefix);
    out.addProperty("mutation_count", owner.emitted); out.addProperty("generation", owner.generation);
    out.addProperty("receipt_nonce", owner.nonce);
    pointer.addProperty("x", owner.x); pointer.addProperty("y", owner.y); out.add("pointer", pointer);
    return out;
  }
  private EffectAuthority.VisibleScreenRef currentLayout() {
    return view.currentLayout();
  }
  private boolean valid(boolean checkLayout) {
    if (done) return false;
    if (!authorized.getAsBoolean() || client.player == null || client.player.isDead()
        || client.currentScreen != screen || client.player.currentScreenHandler != handler
        || !fence.allows(client.currentScreen, client.player.currentScreenHandler, handler.syncId, true)) {
      finish("authority_or_handler_changed", false); return false;
    }
    if (checkLayout) {
      try { if (!layout.equals(currentLayout())) { finish("layout_changed", false); return false; } }
      catch (RuntimeException error) { finish("visible_layout_unavailable", false); return false; }
    }
    return true;
  }
  public void tick() {
    if (done) return;
    if (System.nanoTime() >= deadline) { finish("deadline", false); return; }
    if (!valid(false)) return;
    if (phase == 0 && index == operations.size()) { finish("completed", true); return; }
    if (phase == 3 && (operation.kind().equals("element")
        || operation.kind().equals("slot") && VisibleScreenView.customView(screen))) {
      try {
        if (!layout.equals(currentLayout())) {
          // Custom input/result clicks can change the choice layout on press. Vanilla may
          // replenish a result slot from its remaining inputs before the server reply.
          // Preserve carried custody/geometry, omit the old release and settle the receipt;
          // requiring the predicted source again would reject that ordinary replenishment.
          if (operation.kind().equals("slot")
              && (!releaseCursor.equals(VisibleScreenView.value(handler.getCursorStack())) || !targetMatches())) {
            finish("source_cursor_or_slot_geometry_changed_before_release", false); return;
          }
          clearDrag();
          fence.release();
          appliedPrefix = index + 1;
          application.accept(appliedPrefix, System.nanoTime());
          sendFinish();
          return;
        }
      } catch (RuntimeException error) { finish("visible_layout_unavailable", false); return; }
    }
    // After release/wheel application, dwell and receipt settlement emit no more input.
    // A server-driven page/layout update here must not discard an already-applied take.
    // Authority and exact handler custody remain checked above throughout settlement.
    if (phase != 4 && phase != 5 && !valid(true)) return;
    long now = System.nanoTime();
    if ((phase == 1 || phase == 4) && now >= receiptDeadline) { finish("server_receipt_timeout_no_retry", false); return; }
    if (phase == 0) {
      operation = operations.get(index);
      if (!localMatches(false)) { finish("source_or_cursor_changed", false); return; }
      if (!prepare()) return;
      if (operation.kind().equals("close") || operation.kind().equals("key") && operation.key().equals("escape")) {
        applyImmediate(); return;
      }
      nonce = nextNonce.getAsInt();
      if (!receiptFence.arm(nonce, generation, handler.syncId)) { finish("receipt_arm_rejected", false); return; }
      phase = 1; receiptDeadline = now + 1_500_000_000L;
      if (!GuiTransactionProofClient.request(connection, nonce, generation, "arm", handler.syncId)) finish("server_receipt_send_failed_no_retry", false);
      return;
    }
    if (phase == 2 && now - stageAt >= motion.travelNanos && VisibleScreenView.frame() > phaseFrame
        && Math.abs(x - motion.toX) < .1 && Math.abs(y - motion.toY) < .1) {
      if (!valid(true) || !localMatches(false) || !targetMatches()) { if (!done) finish("source_cursor_or_target_changed_before_press", false); return; }
      calling = true;
      int saved = modifiers;
      try {
        if (operation.kind().equals("scroll")) {
          emitted++;
          if (!screen.mouseScrolled(Math.round(x), Math.round(y), operation.horizontal(), operation.vertical())) {
            finish("vanilla_region_rejected_scroll", false); return;
          }
          appliedPrefix = index + 1; phase = 5; stageAt = now; phaseFrame = VisibleScreenView.frame();
          application.accept(appliedPrefix, System.nanoTime());
          if (gesture != null) gesture.addProperty("scrolled", true);
          return;
        }
        if (operation.kind().equals("slot") && operation.mode().equals("shift")) modifiers |= GLFW.GLFW_MOD_SHIFT;
        fence.press(); emitted++;
        boolean handled;
        if (operation.kind().equals("slot") && operation.mode().equals("hotbar")) {
          handled = screen.keyPressed(GLFW.GLFW_KEY_1 + operation.hotbar(), 0, modifiers);
          screen.keyReleased(GLFW.GLFW_KEY_1 + operation.hotbar(), 0, modifiers);
        } else handled = screen.mouseClicked(Math.round(x), Math.round(y), operation.button());
        if (!handled) { finish("vanilla_control_rejected_press", false); return; }
        if (targetWidget instanceof TextFieldWidget field && field.isFocused()) { selectedField = field; selectedFieldScreen = screen; }
        captureReleaseValues();
        if (gesture != null) gesture.addProperty("pressed", true);
      } catch (RuntimeException error) { finish("vanilla_press_exception", false); return; }
      finally { modifiers = saved; calling = false; }
      phase = 3; stageAt = now; phaseFrame = VisibleScreenView.frame();
      if (evaluation != null && (!operation.kind().equals("slot") || !operation.mode().equals("hotbar")))
        evaluation.evaluationInventoryPressed(this, screen, handler, layout, index);
      return;
    }
    if (phase == 3 && now - stageAt >= motion.pressNanos && VisibleScreenView.frame() > phaseFrame) {
      if (!valid(true) || !localMatches(true) || !targetMatches()) { if (!done) finish("source_cursor_or_target_changed_before_release", false); return; }
      calling = true; int saved = modifiers;
      try {
        if (operation.kind().equals("slot") && operation.mode().equals("shift")) modifiers |= GLFW.GLFW_MOD_SHIFT;
        // Hotbar is already an ordinary key event; there is no synthetic mouse release for it.
        if (!operation.kind().equals("slot") || !operation.mode().equals("hotbar")) screen.mouseReleased(Math.round(x), Math.round(y), operation.button());
        fence.release();
        if (gesture != null) gesture.addProperty("released", true);
      } catch (RuntimeException error) { finish("vanilla_release_exception", false); return; }
      finally { modifiers = saved; calling = false; }
      appliedPrefix = index + 1; phase = 5; stageAt = now; phaseFrame = VisibleScreenView.frame();
      application.accept(appliedPrefix, System.nanoTime()); return;
    }
    if (phase == 5 && now - stageAt >= motion.dwellNanos && VisibleScreenView.frame() > phaseFrame) sendFinish();
  }
  private boolean localMatches(boolean release) {
    if (!operation.kind().equals("slot")) return true;
    if (release) {
      if (!releaseCursor.equals(VisibleScreenView.value(handler.getCursorStack()))) return false;
      for (var entry : releaseSlots.entrySet()) { Slot slot = view.slot(entry.getKey()); if (slot == null || !entry.getValue().equals(VisibleScreenView.value(slot.getStack()))) return false; }
      return true;
    }
    return VisibleScreenContract.matches(operation, VisibleScreenView.value(handler.getCursorStack()), view.values());
  }
  private void captureReleaseValues() {
    if (!operation.kind().equals("slot")) return;
    releaseCursor = VisibleScreenView.value(handler.getCursorStack());
    Map<Integer, VisibleScreenContract.Value> values = new HashMap<>();
    for (int id : operation.expected().keySet()) values.put(id, VisibleScreenView.value(handler.getSlot(id).getStack())); releaseSlots = Map.copyOf(values);
  }
  private boolean prepare() {
    targetWidget = null; targetElement = null;
    if (operation.kind().equals("slot")) {
      Slot slot = view.slot(operation.slot());
      if (slot == null || !slot.isEnabled()) { finish("slot_not_current_visible_enabled", false); return false; }
      var access = (HandledScreenAccess) screen;
      motion.plan(x, y, access.gameharness$x() + slot.x, access.gameharness$y() + slot.y, 16, 16, InventoryPointerMotion.Category.TRANSFER);
    } else if (operation.kind().equals("element") || operation.kind().equals("text") || operation.kind().equals("scroll")) {
      targetElement = view.element(operation.element());
      if (targetElement == null || !targetElement.accepts(operation.kind())) { finish("element_not_current_visible_enabled_for_operation", false); return false; }
      targetWidget = targetElement.widget();
      if (targetWidget != null && (!targetWidget.visible || !targetWidget.active)) { finish("widget_not_current_visible_enabled", false); return false; }
      if (operation.kind().equals("text")) {
        if (!(targetWidget instanceof TextFieldWidget field) || !field.isFocused() || selectedField != field || selectedFieldScreen != screen) {
          finish("text_requires_ordinary_selected_focused_field", false); return false;
        }
      } else motion.plan(x, y, targetElement.x(), targetElement.y(), targetElement.width(), targetElement.height(), InventoryPointerMotion.Category.TRANSFER);
    }
    return true;
  }
  private boolean targetMatches() {
    if (operation.kind().equals("slot")) {
      Slot slot = view.slot(operation.slot()); var access = (HandledScreenAccess) screen;
      return slot != null && slot.isEnabled() && x >= access.gameharness$x() + slot.x && x < access.gameharness$x() + slot.x + 16
          && y >= access.gameharness$y() + slot.y && y < access.gameharness$y() + slot.y + 16;
    }
    var current = view.element(operation.element());
    return targetElement != null && current != null && current.accepts(operation.kind())
        && current.x() == targetElement.x() && current.y() == targetElement.y()
        && current.width() == targetElement.width() && current.height() == targetElement.height()
        && current.contains(x, y) && current.widget() == targetWidget
        && (targetWidget == null || targetWidget.active && targetWidget.visible && targetWidget.isMouseOver(x, y));
  }
  private void applyImmediate() {
    if (!valid(true) || !localMatches(false)) { if (!done) finish("local_precondition_changed", false); return; }
    calling = true;
    try {
      boolean handled = true;
      if (operation.kind().equals("close")) { emitted++; screen.close(); }
      else if (operation.kind().equals("key")) {
        int key = key(operation.key()); boolean press = operation.phase().equals("press");
        if (operation.key().equals("escape") && !press) { finish("escape_release_requires_same_owned_press", false); return; }
        if (press) {
          if (!heldKeys.add(key)) { finish("duplicate_key_press", false); return; }
          if (key == GLFW.GLFW_KEY_LEFT_SHIFT) modifiers |= GLFW.GLFW_MOD_SHIFT;
          else if (key == GLFW.GLFW_KEY_LEFT_CONTROL) modifiers |= GLFW.GLFW_MOD_CONTROL;
          emitted++; handled = screen.keyPressed(key, 0, modifiers);
          if (key == GLFW.GLFW_KEY_LEFT_SHIFT || key == GLFW.GLFW_KEY_LEFT_CONTROL) handled = true;
        } else {
          if (!heldKeys.remove(key)) { finish("key_release_without_owned_press", false); return; }
          emitted++; screen.keyReleased(key, 0, modifiers);
          if (key == GLFW.GLFW_KEY_LEFT_SHIFT) modifiers &= ~GLFW.GLFW_MOD_SHIFT;
          else if (key == GLFW.GLFW_KEY_LEFT_CONTROL) modifiers &= ~GLFW.GLFW_MOD_CONTROL;
        }
      } else if (operation.kind().equals("text")) {
        TextFieldWidget field = (TextFieldWidget) targetWidget;
        if (!field.isFocused() || selectedField != field || selectedFieldScreen != screen) { finish("text_focus_changed", false); return; }
        for (int i = 0; i < operation.text().length(); i++) {
          if (!valid(true) || !field.isFocused()) return;
          emitted++; if (!screen.charTyped(operation.text().charAt(i), modifiers)) { finish("vanilla_text_rejected_character", false); return; }
        }
      } else throw new IllegalStateException("Not an immediate GUI operation");
      if (!handled) { finish("vanilla_key_not_handled", false); return; }
      appliedPrefix = index + 1;
      application.accept(appliedPrefix, System.nanoTime());
      if (client.currentScreen != screen || client.player.currentScreenHandler != handler) {
        index++; if (index != operations.size()) finish("screen_closed_before_remaining_operations", false); else finish("completed", true);
      } else sendFinish();
    } catch (RuntimeException error) { finish("vanilla_key_or_text_exception", false); }
    finally { calling = false; }
  }
  private void sendFinish() {
    if (!receiptFence.finish()) { finish("receipt_finish_without_arm", false); return; }
    phase = 4; receiptDeadline = System.nanoTime() + 1_500_000_000L;
    if (!GuiTransactionProofClient.request(connection, nonce, generation, "finish", handler.syncId)) finish("server_receipt_send_failed_no_retry", false);
  }
  public static void receipt(int nonce, long generation, String contents) {
    VisibleScreen owner = active;
    if (owner == null || owner.done || nonce != owner.nonce || generation != owner.generation
        || (owner.phase != 1 && owner.phase != 4) || System.nanoTime() >= owner.receiptDeadline
        || contents.length() > 65536 || !owner.authorized.getAsBoolean()) return;
    try { owner.receive(nonce, generation, JsonParser.parseString(contents).getAsJsonObject()); }
    catch (RuntimeException invalid) { owner.finish("invalid_server_receipt", false); }
  }
  private void receive(int nonce, long generation, JsonObject data) {
    if (nonce != this.nonce || generation != this.generation || (phase != 1 && phase != 4) || System.nanoTime() >= receiptDeadline) return;
    if (!data.keySet().equals(Set.of("phase", "schema", "status", "reason", "screen_sync_id", "inventory", "slots", "cursor", "productions"))
        || NativeEffectContract.counter(data, "schema") != 1) throw new IllegalArgumentException("Receipt schema mismatch");
    int sync = VisibleScreenContract.integer(data, "screen_sync_id", Integer.MAX_VALUE);
    String phase = NativeEffectContract.id(data, "phase");
    if (!receiptFence.accept(nonce, generation, sync, phase)) return;
    String status = NativeEffectContract.id(data, "status");
    if (!status.equals("confirmed")) {
      if (!status.equals("unknown")) throw new IllegalArgumentException("Invalid receipt status");
      String reason = NativeEffectContract.id(data, "reason");
      if (!Set.of("invalid", "overflow", "incomplete", "stale", "not_alive", "handler_changed", "lost").contains(reason))
        throw new IllegalArgumentException("Invalid receipt reason");
      serverReceiptReason = reason;
      finish("server_receipt_unknown_no_retry", false); return;
    }
    JsonObject inventory = data.getAsJsonObject("inventory");
    if (inventory.size() > 128) throw new IllegalArgumentException("Inventory receipt overflow");
    for (var entry : inventory.entrySet()) {
      if (!entry.getKey().matches("[a-z0-9_./-]+") || !entry.getValue().isJsonPrimitive() || !entry.getValue().getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException("Invalid receipt inventory");
      ContractIdentity.counter(entry.getValue().toString());
    }
    JsonArray slots = data.getAsJsonArray("slots"), productions = data.getAsJsonArray("productions");
    if (slots.size() > 128) throw new IllegalArgumentException("Receipt projection overflow");
    Set<Integer> seen = new HashSet<>();
    for (JsonElement element : slots) {
      JsonObject row = element.getAsJsonObject();
      if (!row.keySet().equals(Set.of("slot_id", "item", "count")) || !seen.add(VisibleScreenContract.integer(row, "slot_id", 127))) throw new IllegalArgumentException("Invalid receipt slot");
      JsonObject value = row.deepCopy(); value.remove("slot_id"); VisibleScreenContract.value(value);
    }
    VisibleScreenContract.value(data.getAsJsonObject("cursor"));
    VisibleScreenContract.validateProductions(productions);
    if (phase.equals("arm")) {
      if (!productions.isEmpty()) throw new IllegalArgumentException("Arm cannot prove production");
      beforeInventory = inventory.deepCopy();
      if (!valid(true) || !localMatches(false)) { if (!done) finish("source_changed_during_arm", false); return; }
      if (operation.kind().equals("slot") || operation.kind().equals("element") || operation.kind().equals("scroll")) {
        this.phase = 2; stageAt = System.nanoTime(); phaseFrame = VisibleScreenView.frame();
        gesture = new JsonObject(); gesture.addProperty("operation_index", index); gesture.addProperty("from_x", motion.fromX); gesture.addProperty("from_y", motion.fromY);
        gesture.addProperty("to_x", motion.toX); gesture.addProperty("to_y", motion.toY); gesture.addProperty("travel_ms", motion.travelNanos / 1_000_000.0);
        gesture.addProperty("press_ms", motion.pressNanos / 1_000_000.0); gesture.addProperty("dwell_ms", motion.dwellNanos / 1_000_000.0);
        gesture.addProperty("profile", motion.profile()); gesture.addProperty("curve", motion.curve()); gestures.add(gesture);
      } else applyImmediate();
    } else {
      JsonObject fact = new JsonObject(); fact.addProperty("kind", "gui_transaction"); fact.addProperty("mechanism", "visible_gui");
      fact.addProperty("operation_index", index); fact.addProperty("receipt_ref", receiptPrefix + ":" + generation + ":" + nonce);
      fact.addProperty("input_application", "confirmed"); fact.addProperty("effect_status", "confirmed");
      fact.add("inventory_before", beforeInventory); fact.add("inventory_after", inventory.deepCopy()); fact.add("productions", productions.deepCopy()); transactions.add(fact);
      index++; this.phase = 0; beforeInventory = null;
    }
  }
  public void cancel() { finish("cancelled", false); }
  private void finish(String reason, boolean success) {
    if (done) return;
    retainPosition();
    done = true; calling = false; modifiers = 0; heldKeys.clear();
    boolean retireArm = receiptFence.revoke(); fence.revoke();
    // Neutralize private vanilla drag state on the exact original object; never emit a release or close another handler.
    clearDrag();
    // Ordered on the original connection before completion can admit a new ARM. This
    // diagnostic uses only the old bracket identity, never GUI input or a replacement handler.
    // Its ACK is ignored: an uncertain operation cannot become confirmed during cleanup.
    if (retireArm) GuiTransactionProofClient.request(connection, nonce, generation, "finish", handler.syncId);
    if (active == this) active = null;
    JsonObject out = new JsonObject(), evidence = new JsonObject();
    out.addProperty("status", success ? "succeeded" : emitted > 0 ? "unknown" : reason.equals("cancelled") ? "cancelled" : "failed");
    out.addProperty("summary", success ? "Bounded ordinary visible GUI input completed; screen remains under vanilla custody" : "Visible GUI input stopped: " + reason);
    evidence.addProperty("effect_confirmed", success && emitted > 0); evidence.addProperty("world_effect_emitted", emitted > 0);
    evidence.addProperty("neutralized_effect", false); evidence.addProperty("neutralized", true); evidence.addProperty("operation_count", operations.size());
    evidence.addProperty("applied_prefix", appliedPrefix); evidence.addProperty("mutation_count", emitted); evidence.addProperty("stop_reason", reason);
    if (serverReceiptReason != null) evidence.addProperty("server_receipt_reason", serverReceiptReason);
    evidence.add("gui_transactions", transactions); evidence.add("pointer_gestures", gestures); out.add("evidence", evidence); completion.accept(out);
  }
  private void clearDrag() {
    var access = (HandledScreenAccess) screen;
    access.gameharness$dragging(false); access.gameharness$dragSlots().clear();
    access.gameharness$cancelRelease(true); screen.setDragging(false);
  }
  private void retainPosition() {
    var viewport = client.getWindow();
    pointer.update(screen, handler, window, viewport.getScaledWidth(), viewport.getScaledHeight(), x, y);
  }
  private static boolean currentPointer(MinecraftClient client) {
    if (VisibleInventory.owned() || client.player == null || client.getWindow() == null
        || !(client.currentScreen instanceof HandledScreen<?> screen)
        || screen.getScreenHandler() != client.player.currentScreenHandler) {
      pointer.clear(); return false;
    }
    var viewport = client.getWindow();
    if (!pointer.matches(screen, screen.getScreenHandler(), viewport.getHandle(),
        viewport.getScaledWidth(), viewport.getScaledHeight())) {
      pointer.clear(); return false;
    }
    return true;
  }
  /** Screen closure invalidates retention even if the same vanilla object is reopened later. */
  public static void screenChanged() { currentPointer(MinecraftClient.getInstance()); }
  public static boolean preparePointer() {
    VisibleScreen owner = active;
    if (!currentPointer(MinecraftClient.getInstance())) return false;
    if (owner != null && !owner.done && owner.client.currentScreen == owner.screen && owner.phase == 2) {
      owner.motion.advance(System.nanoTime() - owner.stageAt); owner.x = owner.motion.x; owner.y = owner.motion.y;
      owner.retainPosition();
    }
    return true;
  }
  public static int pointerX() { return (int)Math.round(pointer.x()); }
  public static int pointerY() { return (int)Math.round(pointer.y()); }
  public static void drawPointer(Screen screen, DrawContext context) {
    var client = MinecraftClient.getInstance();
    if (client.currentScreen != screen || !currentPointer(client)) return;
    int px = pointerX(), py = pointerY();
    context.fill(px - 1, py - 1, px + 2, py + 10, 500, 0xFF111111);
    for (int i = 0; i < 7; i++) context.fill(px + i, py + i, px + i + 2, py + 8, 500, 0xFF111111);
    for (int i = 0; i < 5; i++) context.fill(px + i, py + i + 1, px + i + 1, py + 7, 501, 0xFFFFFFFF);
  }
  private static int key(String key) {
    return switch (key) {
      case "escape" -> GLFW.GLFW_KEY_ESCAPE; case "enter" -> GLFW.GLFW_KEY_ENTER;
      case "backspace" -> GLFW.GLFW_KEY_BACKSPACE; case "delete" -> GLFW.GLFW_KEY_DELETE;
      case "left" -> GLFW.GLFW_KEY_LEFT; case "right" -> GLFW.GLFW_KEY_RIGHT;
      case "home" -> GLFW.GLFW_KEY_HOME; case "end" -> GLFW.GLFW_KEY_END;
      case "shift" -> GLFW.GLFW_KEY_LEFT_SHIFT; case "control" -> GLFW.GLFW_KEY_LEFT_CONTROL;
      default -> GLFW.GLFW_KEY_1 + Integer.parseInt(key) - 1;
    };
  }
}
