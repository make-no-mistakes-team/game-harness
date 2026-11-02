package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.util.math.MathHelper;

/** Persistent ordinary key owner. New snapshots never release/repress an already-held use key. */
public final class StreamInputs {
  private static final String[] HELD = {"forward", "back", "left", "right", "jump", "sprint", "sneak", "attack", "use"};
  private final MinecraftClient client;
  private final KeyBinding[] keys;
  private final InputConsumption consumption = new InputConsumption();
  private WorldInputPlan.Step step;
  private ControllerInputQueue.Entry entry;
  private long preparedTick = -1;
  private boolean entering, consuming, consumed, sampled, screenOpened;

  public StreamInputs(MinecraftClient client) {
    this.client = client; keys = NativeInputs.ownedKeys(client);
    clearKeys();
  }
  private void clearKeys() {
    for (KeyBinding key : keys) { NativeInputs.access(key).gameharness$held(false); NativeInputs.access(key).gameharness$presses(0); }
  }
  public void begin(ControllerInputQueue.Entry entry) {
    if (this.entry != null || entry.world() == null) throw new IllegalStateException("Stream input application already pending");
    this.entry = entry; step = entry.world(); entering = true; consumed = sampled = screenOpened = false;
    consumption.reset(step);
  }
  public boolean prepare(long tick) {
    if (step == null || screenOpened || preparedTick == tick) return false;
    preparedTick = tick;
    double yaw = step.yawDelta(entering), pitch = step.pitchDelta(entering);
    if (yaw != 0 || pitch != 0)
      client.player.changeLookDirection(Math.toDegrees(yaw) / .15, -Math.toDegrees(pitch) / .15);
    if (entering) {
      if (step.selected() >= 0) client.player.getInventory().selectedSlot = step.selected();
      for (int index = 0; index < step.edgeCount(); index++) {
        WorldInputPlan.Edge edge = step.edge(index);
        switch (edge.kind()) {
          case BUTTON -> {
            NativeInputs.access(keys[edge.key()]).gameharness$held(edge.press());
            if (edge.press()) NativeInputs.queue(keys[edge.key()], edge.count());
          }
          case HOTBAR -> NativeInputs.queue(keys[12 + edge.slot()], 1);
          case SWAP -> NativeInputs.queue(keys[10], 1);
          case DROP -> NativeInputs.queue(keys[11], 1);
        }
      }
      entering = false;
    }
    applyHeld();
    return true;
  }
  public void applyHeld() {
    if (step == null || screenOpened) return;
    for (int key = 0; key < 9; key++) NativeInputs.access(keys[key]).gameharness$held(step.held(key));
    NativeInputs.access(keys[9]).gameharness$held(false);
  }
  public void beginConsumption() { consuming = step != null && preparedTick >= 0; }
  public boolean endConsumption() {
    if (!consuming) return false;
    consuming = false; consumed = true;
    if (entry == null) return false;
    consumption.releasesConsumed();
    return true;
  }
  /** Hooked only after a real vanilla wasPressed() returned true. Injection is not consumption. */
  public void keyConsumed(KeyBinding key) {
    if (!consuming || entry == null) return;
    for (int button = 0; button < keys.length; button++)
      if (keys[button] == key) { consumption.counted(button); return; }
  }
  /** Movement uses levels, not vanilla counted presses; multiple queued movement clicks remain unconfirmed. */
  public boolean sampled() {
    sampled = true;
    if (entry == null || step == null) return false;
    int held = 0;
    for (int key = 0; key < 7; key++) if (keys[key].isPressed()) held |= 1 << key;
    consumption.sampled(held);
    return true;
  }
  public boolean consuming() { return consuming; }
  public boolean dropAll() { return consuming && step != null && step.dropAll(); }
  public ControllerInputQueue.Entry pending() { return entry; }
  public JsonObject settle(long generation, long tick, long now) {
    if (entry == null || preparedTick != tick || !consumed) return null;
    long prefix = consumption.prefix(entry.edgeStart());
    boolean movement = (step.heldMask() & 127) != 0;
    boolean confirmed = prefix == entry.edgeEnd() && (!movement || sampled);
    JsonObject ack = ack(generation, entry.sequence(), prefix, tick, now,
        confirmed ? "confirmed" : "partial", confirmed ? null : "ordinary_input_not_fully_consumed");
    entry = null; consumed = sampled = false;
    if (screenOpened) step = null;
    return ack;
  }
  public JsonObject ack(long generation, long sequence, long prefix, long tick, long now, String status, String reason) {
    JsonObject ack = new JsonObject(), held = new JsonObject(), pose = new JsonObject();
    ack.addProperty("controller_generation", generation); ack.addProperty("sequence", sequence);
    ack.addProperty("ordered_edge_prefix", prefix); ack.addProperty("applied_native_tick", tick);
    ack.addProperty("applied_native_ns", Long.toString(now));
    for (int key = 0; key < HELD.length; key++) held.addProperty(HELD[key], keys[key].isPressed());
    ack.add("held", held);
    pose.addProperty("yaw_radians", Math.toRadians(MathHelper.wrapDegrees(client.player.getYaw())));
    pose.addProperty("pitch_radians", -Math.toRadians(client.player.getPitch())); ack.add("applied_pose", pose);
    ack.addProperty("input_application", status); ack.addProperty("reason", reason);
    return ack;
  }
  public void release() {
    clearKeys(); step = null; entry = null; consuming = false;
    if (client.interactionManager != null) {
      client.interactionManager.cancelBlockBreaking();
      if (client.player != null && client.player.isUsingItem()) client.interactionManager.stopUsingItem(client.player);
    }
  }
  public void screenChanged() {
    screenOpened = true;
    clearKeys();
    if (client.interactionManager != null) {
      client.interactionManager.cancelBlockBreaking();
      if (client.player != null && client.player.isUsingItem()) client.interactionManager.stopUsingItem(client.player);
    }
    if (entry == null) step = null;
  }
}
