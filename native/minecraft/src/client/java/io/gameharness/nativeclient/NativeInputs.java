package io.gameharness.nativeclient;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import io.gameharness.nativeclient.mixin.KeyBindingAccess;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.util.Hand;
import net.minecraft.util.math.MathHelper;

/** Ordinary owned input only. Vanilla chooses crosshair/range, hand order and gameplay precedence. */
public final class NativeInputs {
  public final long requestId;
  public final NativeEffectContract.Received received;
  private final MinecraftClient client;
  private final WorldInputState state;
  private final KeyBinding[] buttons, owned;
  private WorldInputPlan.Step current;
  private boolean active = true, consuming, screenOpened, emitted;
  private int attackEntries, useEntries;
  private long preparedTick = -1;
  private final NativeInputTiming timing = new NativeInputTiming("NativeInputs.prepare/preCrosshair/changeLookDirection");

  public NativeInputs(MinecraftClient client, long requestId, NativeEffectContract.Received received, long receivedNanos) {
    this.client = client; this.requestId = requestId; this.received = received;
    state = new WorldInputState(received.worldInput(), receivedNanos);
    buttons = owned = ownedKeys(client);
    clearKeys();
  }
  static KeyBinding[] ownedKeys(MinecraftClient client) {
    var keys = client.options;
    KeyBinding[] result = new KeyBinding[21];
    result[0] = keys.forwardKey; result[1] = keys.backKey; result[2] = keys.leftKey; result[3] = keys.rightKey;
    result[4] = keys.jumpKey; result[5] = keys.sprintKey; result[6] = keys.sneakKey;
    result[7] = keys.attackKey; result[8] = keys.useKey; result[9] = keys.inventoryKey;
    result[10] = keys.swapHandsKey; result[11] = keys.dropKey;
    System.arraycopy(keys.hotbarKeys, 0, result, 12, 9);
    return result;
  }
  static KeyBindingAccess access(KeyBinding key) { return (KeyBindingAccess) (Object) key; }
  static void queue(KeyBinding key, int count) {
    KeyBindingAccess access = access(key); access.gameharness$presses(access.gameharness$presses() + count);
  }
  private void clearKeys() {
    for (KeyBinding key : owned) { access(key).gameharness$held(false); access(key).gameharness$presses(0); }
  }
  public boolean expired(long now) { return state.expired(now); }
  public boolean screenOpened() { return screenOpened; }
  public boolean active() { return active; }
  public boolean consuming() { return consuming; }
  public boolean dropAll() { return consuming && current != null && current.dropAll(); }

  /** Before MinecraftClient.tick's first crosshair update, never at render TAIL. */
  public void prepare(long tick, long now) {
    if (!active || screenOpened || !state.prepare(tick, now)) return;
    preparedTick = tick; current = state.step();
    double yaw = state.yawDelta(), pitch = state.pitchDelta();
    if (yaw != 0 || pitch != 0) {
      float beforeYaw = client.player.getYaw(), beforePitch = client.player.getPitch();
      client.player.changeLookDirection(Math.toDegrees(yaw) / .15, -Math.toDegrees(pitch) / .15);
      if (client.player.getYaw() != beforeYaw || client.player.getPitch() != beforePitch)
        timing.cameraApply.record(System.nanoTime(), tick);
    }
    if (state.entry()) {
      // Declarative selection precedes vanilla interactionManager.tick's slot sync.
      // Authored hotbar edges below still follow vanilla handleInputEvents ordering.
      int selected = state.entrySelection();
      if (selected >= 0) client.player.getInventory().selectedSlot = selected;
      for (int i = 0; i < current.edgeCount(); i++) {
        WorldInputPlan.Edge edge = current.edge(i);
        switch (edge.kind()) {
          case BUTTON -> {
            access(buttons[edge.key()]).gameharness$held(edge.press());
            if (edge.press()) queue(buttons[edge.key()], edge.count());
          }
          case HOTBAR -> queue(client.options.hotbarKeys[edge.slot()], 1);
          case SWAP -> queue(client.options.swapHandsKey, 1);
          case DROP -> queue(client.options.dropKey, 1);
        }
        state.injected(edge.count());
      }
    }
    applyHeld();
  }
  public void applyHeld() {
    if (!active || screenOpened || current == null) return;
    for (int key = 0; key < 9; key++) access(buttons[key]).gameharness$held(state.held(key));
    access(buttons[9]).gameharness$held(false);
  }
  public void keySample(long tick, boolean pressed) {
    if (active && !screenOpened && current != null && pressed) timing.keySample.record(System.nanoTime(), tick);
  }
  public void beginConsumption(long tick) {
    if (active && !screenOpened && current != null && preparedTick <= tick) consuming = true;
  }
  public void endConsumption(long tick) {
    if (!consuming) return;
    state.consumed(tick, System.nanoTime()); consuming = false;
  }
  public void attackEntry() { if (consuming && !screenOpened) attackEntries++; }
  public void useEntry() { if (consuming && !screenOpened) useEntries++; }
  public void packetEmitted() { if (active) emitted = true; }
  public boolean settle(long tick) {
    if (client.player != null) state.settle(tick,
        Math.toRadians(MathHelper.wrapDegrees(client.player.getYaw())), -Math.toRadians(client.player.getPitch()));
    return state.completed();
  }
  /** A visible screen transition stops the clip synchronously, without closing the new screen. */
  public void screenChanged(long tick) {
    if (!active || client.currentScreen == null || screenOpened) return;
    screenOpened = true; release(tick);
  }
  private void release(long tick) {
    boolean held = false; for (KeyBinding key : owned) held |= key.isPressed();
    clearKeys();
    if (held) timing.keyRelease.record(System.nanoTime(), tick);
    if (client.interactionManager != null) {
      client.interactionManager.cancelBlockBreaking();
      if (client.player != null && client.player.isUsingItem()) client.interactionManager.stopUsingItem(client.player);
    }
  }
  public JsonObject finish(String reason, long tick, String clockId) {
    settle(tick);
    release(tick); active = false; consuming = false; state.stop();
    JsonObject result = new JsonObject(), evidence = new JsonObject();
    boolean completed = state.applicationConfirmed(reason);
    result.addProperty("status", state.applicationStatus(reason, emitted));
    result.addProperty("summary", "Ordinary vanilla input stopped: " + reason + "; world consequences are not confirmed");
    evidence.addProperty("effect_confirmed", false); evidence.addProperty("world_effect_emitted", emitted);
    evidence.addProperty("neutralized_effect", false); evidence.addProperty("neutralized", true);
    JsonObject receipt = new JsonObject();
    receipt.addProperty("schema_version", 1); receipt.addProperty("clock_id", clockId);
    receipt.addProperty("applied_ticks", state.appliedTicks()); receipt.addProperty("applied_steps", state.appliedSteps());
    receipt.addProperty("ordered_edge_prefix", state.edgePrefix());
    receipt.add("first_applied_native_ns", state.appliedTicks() == 0 ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(Long.toString(state.firstNanos())));
    receipt.add("last_applied_native_ns", state.appliedTicks() == 0 ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(Long.toString(state.lastNanos())));
    receipt.add("applied_client_tick", state.lastTick() < 0 ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(state.lastTick()));
    JsonObject pose = new JsonObject(); pose.addProperty("yaw_radians", state.yaw()); pose.addProperty("pitch_radians", state.pitch());
    receipt.add("applied_pose", state.appliedTicks() == 0 ? JsonNull.INSTANCE : pose);
    receipt.addProperty("input_application", completed ? "confirmed" : state.appliedTicks() > 0 ? "partial" : "unknown");
    receipt.addProperty("effect_status", !completed && emitted ? "unknown" : "not_observed"); receipt.addProperty("stop_reason", reason);
    receipt.addProperty("attack_presses_consumed", attackEntries);
    receipt.addProperty("use_presses_consumed", useEntries);
    evidence.add("ordinary_input", receipt);
    evidence.add("native_input_timing", timing.evidence(clockId, requestId, received.owner().operationId(), received.owner().cancellationGeneration()));
    result.add("evidence", evidence); return result;
  }
  public JsonObject diagnostics() {
    JsonObject value = new JsonObject(); value.addProperty("operation_id", received.owner().operationId());
    value.addProperty("active", active); boolean using = client.player != null && client.player.isUsingItem();
    value.addProperty("using_item", using); value.addProperty("blocking", using && client.player.isBlocking());
    value.addProperty("item_use_ticks", using ? client.player.getItemUseTime() : 0);
    value.addProperty("active_hand", using ? client.player.getActiveHand() == Hand.MAIN_HAND ? "main" : "off" : null);
    value.addProperty("selected_hotbar", client.player == null ? 0 : client.player.getInventory().selectedSlot);
    value.addProperty("consumed_ticks", state.appliedTicks());
    value.addProperty("attack_presses_consumed", attackEntries); value.addProperty("use_presses_consumed", useEntries);
    return value;
  }
}
