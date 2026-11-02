package io.gameharness.nativeclient;

import com.google.gson.*;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.StringReader;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.TreeMap;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.networking.v1.*;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.inventory.Inventory;
import net.minecraft.item.ItemStack;
import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.registry.Registries;
import net.minecraft.screen.AbstractFurnaceScreenHandler;
import net.minecraft.screen.AnvilScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.Identifier;

/** Diagnostic brackets around ordinary vanilla packets. This class never performs a game action. */
public final class GuiTransactionProof implements ModInitializer {
  public record Message(int nonce, long generation, String contents) implements CustomPayload {
    public static final Id<Message> ID = new Id<>(Identifier.of("gameharness", "visible_gui_receipt_v1"));
    public static final PacketCodec<RegistryByteBuf, Message> CODEC = PacketCodec.of(
        (value, buf) -> { buf.writeInt(value.nonce); buf.writeLong(value.generation); buf.writeString(value.contents, 65536); },
        buf -> new Message(buf.readInt(), buf.readLong(), buf.readString(65536)));
    public Id<? extends CustomPayload> getId() { return ID; }
  }

  /** Implemented by the server furnace mixin; state lives and dies with that actual furnace. */
  public interface FurnaceAccess { GuiProductionLedger.Furnace guiProductionLedger(); }
  private record Request(String phase, int syncId) {}
  private static final Map<ServerPlayerEntity, GuiProductionLedger.Session> sessions = new IdentityHashMap<>();
  private static final ThreadLocal<Click> click = new ThreadLocal<>();

  private static final class Click {
    final ServerPlayerEntity player;
    final ScreenHandler handler;
    final Inventory furnace;
    final String input;
    final int inputCount;
    final Map<String, Integer> own;
    String anvilItem;
    int anvilAmount;
    Click(ServerPlayerEntity player, ScreenHandler handler, Inventory furnace) {
      this.player = player;
      this.handler = handler;
      this.furnace = furnace;
      this.input = furnace == null ? null : item(furnace.getStack(0));
      this.inputCount = furnace == null ? 0 : furnace.getStack(0).getCount();
      this.own = furnace == null ? null : ownCounts(player, true);
      if (furnace != null)
        ((FurnaceAccess) furnace).guiProductionLedger().beginInput(this, player, input, inputCount);
    }
  }

  @Override public void onInitialize() {
    PayloadTypeRegistry.playC2S().register(Message.ID, Message.CODEC);
    PayloadTypeRegistry.playS2C().register(Message.ID, Message.CODEC);
    // Fabric 4.4.0 already dispatches this receiver on the server executor. An extra execute
    // would move the ARM/FINISH snapshots past vanilla click packets queued after them.
    ServerPlayNetworking.registerGlobalReceiver(Message.ID, (message, context) -> receive(context.player(), message));
    ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
      sessions.remove(handler.player);
      Click current = click.get();
      if (current != null && current.player == handler.player) {
        if (current.furnace != null)
          ((FurnaceAccess) current.furnace).guiProductionLedger().invalidateInput();
        click.remove();
      }
    });
  }

  private static void receive(ServerPlayerEntity player, Message message) {
    Request request;
    try { request = request(message.contents); }
    catch (Exception invalid) {
      // Malformed diagnostics cannot mutate, arm, retire or query a caller-selected handler.
      reply(player, message, "finish", player.currentScreenHandler.syncId, GuiProductionLedger.Outcome.unknown("invalid"));
      return;
    }
    ScreenHandler handler = player.currentScreenHandler;
    GuiProductionLedger.Session ledger = sessions.get(player);
    if (ledger == null) {
      if (sessions.size() >= 128) {
        reply(player, message, request.phase, request.syncId, GuiProductionLedger.Outcome.unknown("overflow"));
        return;
      }
      ledger = new GuiProductionLedger.Session(player);
      sessions.put(player, ledger);
    }
    boolean alive = player.isAlive() && !player.isSpectator();
    Object admitted = handler.syncId == request.syncId ? handler : null;
    GuiProductionLedger.Outcome outcome = request.phase.equals("arm")
        ? ledger.arm(message.nonce, message.generation, admitted, request.syncId, alive, System.nanoTime())
        : ledger.finish(message.nonce, message.generation, admitted, request.syncId, alive, System.nanoTime());
    reply(player, message, request.phase, request.syncId, outcome);
  }

  private static Request request(String contents) throws Exception {
    if (contents == null || contents.length() > 128) throw new IllegalArgumentException();
    try (JsonReader reader = new JsonReader(new StringReader(contents))) {
      reader.setLenient(false);
      reader.beginObject();
      String phase = null;
      Integer sync = null;
      while (reader.hasNext()) {
        String key = reader.nextName();
        if (key.equals("phase") && phase == null && reader.peek() == JsonToken.STRING) phase = reader.nextString();
        else if (key.equals("sync_id") && sync == null && reader.peek() == JsonToken.NUMBER) {
          String number = reader.nextString();
          if (!number.matches("0|[1-9][0-9]*")) throw new IllegalArgumentException();
          sync = Integer.valueOf(number);
        } else throw new IllegalArgumentException();
      }
      reader.endObject();
      if (reader.peek() != JsonToken.END_DOCUMENT || !("arm".equals(phase) || "finish".equals(phase)) || sync == null || sync < 0)
        throw new IllegalArgumentException();
      return new Request(phase, sync);
    }
  }

  private static void reply(ServerPlayerEntity player, Message message, String phase, int syncId, GuiProductionLedger.Outcome outcome) {
    JsonObject json = new JsonObject();
    json.addProperty("phase", phase);
    json.addProperty("schema", 1);
    json.addProperty("screen_sync_id", syncId);
    JsonArray slots = new JsonArray();
    JsonObject inventory = new JsonObject();
    JsonObject cursor = value(ItemStack.EMPTY);
    ScreenHandler handler = player.currentScreenHandler;
    try {
      for (var entry : ownCounts(player, false).entrySet()) inventory.addProperty(entry.getKey(), entry.getValue());
      if (handler.syncId == syncId && player.isAlive()) {
        if (handler.slots.size() > 128) throw new IllegalStateException("overflow");
        for (Slot slot : handler.slots) {
          JsonObject entry = value(slot.getStack());
          entry.addProperty("slot_id", slot.id);
          slots.add(entry);
        }
        cursor = value(handler.getCursorStack());
      }
    } catch (IllegalStateException incomplete) {
      outcome = GuiProductionLedger.Outcome.unknown("overflow".equals(incomplete.getMessage()) ? "overflow" : "incomplete");
      slots = new JsonArray();
      inventory = new JsonObject();
      cursor = value(ItemStack.EMPTY);
      GuiProductionLedger.Session ledger = sessions.get(player);
      if (ledger != null) ledger.uncertain(outcome.reason());
    }
    json.addProperty("status", outcome.confirmed() ? "confirmed" : "unknown");
    json.add("reason", outcome.reason() == null ? JsonNull.INSTANCE : new JsonPrimitive(outcome.reason()));
    json.add("inventory", inventory);
    json.add("slots", slots);
    json.add("cursor", cursor);
    JsonArray productions = new JsonArray();
    if (outcome.confirmed()) for (var production : outcome.productions()) {
      JsonObject entry = new JsonObject();
      entry.addProperty("producer", production.producer());
      entry.addProperty("item", production.item());
      entry.addProperty("count", production.count());
      entry.addProperty("source", "server_result_slot_take");
      entry.addProperty("production_confirmed", true);
      productions.add(entry);
    }
    json.add("productions", productions);
    String contents = json.toString();
    if (contents.length() > 65536) {
      json.addProperty("status", "unknown");
      json.addProperty("reason", "overflow");
      json.add("inventory", new JsonObject());
      json.add("slots", new JsonArray());
      json.add("cursor", value(ItemStack.EMPTY));
      json.add("productions", new JsonArray());
      GuiProductionLedger.Session ledger = sessions.get(player);
      if (ledger != null) ledger.uncertain("overflow");
      contents = json.toString();
    }
    ServerPlayNetworking.send(player, new Message(message.nonce, message.generation, contents));
  }

  private static JsonObject value(ItemStack stack) {
    JsonObject value = new JsonObject();
    String item = item(stack);
    int count = stack.isEmpty() ? 0 : stack.getCount();
    if (count < 0 || count > 4096) throw new IllegalStateException("incomplete");
    value.add("item", item == null ? JsonNull.INSTANCE : new JsonPrimitive(item));
    value.addProperty("count", count);
    return value;
  }

  private static String item(ItemStack stack) {
    if (stack.isEmpty()) return null;
    Identifier id = Registries.ITEM.getId(stack.getItem());
    // Bare registry paths are the frozen actor contract; never alias a mod namespace to vanilla.
    if (!id.getNamespace().equals("minecraft") || id.getPath().length() > 256) throw new IllegalStateException("incomplete");
    return id.getPath();
  }

  private static Map<String, Integer> ownCounts(ServerPlayerEntity player, boolean cursor) {
    Map<String, Integer> counts = new TreeMap<>();
    for (int i = 0; i < player.getInventory().size(); i++) add(counts, player.getInventory().getStack(i));
    if (cursor) add(counts, player.currentScreenHandler.getCursorStack());
    return counts;
  }
  private static void add(Map<String, Integer> counts, ItemStack stack) {
    String item = item(stack);
    if (item == null) return;
    if (stack.getCount() < 1 || stack.getCount() > 4096) throw new IllegalStateException("incomplete");
    counts.merge(item, stack.getCount(), Math::addExact);
  }

  public static void beginClick(ScreenHandler handler, PlayerEntity entity) {
    Click previous = click.get();
    if (previous != null && previous.furnace != null)
      ((FurnaceAccess) previous.furnace).guiProductionLedger().invalidateInput();
    click.remove();
    if (!(entity instanceof ServerPlayerEntity player) || player.currentScreenHandler != handler) return;
    Inventory furnace = handler instanceof AbstractFurnaceScreenHandler && handler.slots.size() > 2
        && handler.getSlot(2).inventory instanceof FurnaceAccess
        && handler.getSlot(0).inventory == handler.getSlot(2).inventory ? handler.getSlot(2).inventory : null;
    if (furnace == null && !(handler instanceof AnvilScreenHandler)) return;
    try { click.set(new Click(player, handler, furnace)); }
    catch (IllegalStateException incomplete) {
      GuiProductionLedger.Session ledger = sessions.get(player);
      if (ledger != null) ledger.uncertain("incomplete");
    }
  }

  public static void endClick(ScreenHandler handler, PlayerEntity entity) {
    Click frame = click.get();
    click.remove();
    if (frame == null || frame.furnace == null) return;
    var furnace = ((FurnaceAccess) frame.furnace).guiProductionLedger();
    if (frame.handler != handler || frame.player != entity || !currentFurnace(frame)) {
      furnace.invalidateInput();
      return;
    }
    try {
      ItemStack input = frame.furnace.getStack(0), output = frame.furnace.getStack(2);
      String inputItem = item(input);
      int ownLoss = 0;
      if (input.getCount() != frame.inputCount || !java.util.Objects.equals(inputItem, frame.input)) {
        ownLoss = inputItem == null ? 0 : frame.own.getOrDefault(inputItem, 0)
            - ownCounts(frame.player, true).getOrDefault(inputItem, 0);
      }
      furnace.endInput(frame, inputItem, input.getCount(), ownLoss, item(output), output.getCount());
    } catch (IllegalStateException incomplete) {
      furnace.invalidateInput();
      GuiProductionLedger.Session ledger = sessions.get(frame.player);
      if (ledger != null) ledger.uncertain("incomplete");
    }
  }

  private static boolean currentFurnace(Click frame) {
    return frame.player.currentScreenHandler == frame.handler && frame.handler.slots.size() > 2
        && frame.handler.getSlot(0).inventory == frame.furnace
        && frame.handler.getSlot(2).inventory == frame.furnace;
  }

  public static void furnaceInputWrite(FurnaceAccess access, ItemStack stack) {
    Click frame = click.get();
    Object source = frame != null && frame.furnace == access && currentFurnace(frame) ? frame : null;
    try { access.guiProductionLedger().setInput(source, item(stack), stack.getCount()); }
    catch (IllegalStateException incomplete) { access.guiProductionLedger().invalidateInput(); }
  }

  public static void resultTake(PlayerEntity entity, Slot slot, ItemStack output, int count, String producer) {
    if (!(entity instanceof ServerPlayerEntity player) || count <= 0) return;
    ScreenHandler handler = player.currentScreenHandler;
    boolean matches = slot.id >= 0 && slot.id < handler.slots.size() && handler.getSlot(slot.id) == slot;
    GuiProductionLedger.Session ledger = sessions.get(player);
    try {
      String item = item(output);
      boolean proven = item != null;
      if (producer.equals("smelting")) {
        if (slot.inventory instanceof FurnaceAccess access) {
          int actualBefore = slot.getStack().getCount() + count;
          var furnace = access.guiProductionLedger();
          proven = furnace.take(player, item, actualBefore, count) == count;
          if (ledger != null && matches && furnace.overflowed()) ledger.uncertain("overflow");
        } else proven = false;
      }
      if (ledger != null) ledger.take(player, handler, matches, producer, item, count, proven);
    } catch (IllegalStateException incomplete) {
      if (ledger != null && matches) ledger.uncertain("incomplete");
    }
  }

  public static void anvilQuickTransfer(Slot slot, ItemStack remaining, ItemStack original) {
    Click frame = click.get();
    if (frame == null || !(frame.handler instanceof AnvilScreenHandler anvil)
        || anvil.getSlot(anvil.getResultSlotIndex()) != slot) return;
    try {
      frame.anvilItem = item(original);
      frame.anvilAmount += original.getCount() - remaining.getCount();
    } catch (IllegalStateException incomplete) {
      GuiProductionLedger.Session ledger = sessions.get(frame.player);
      if (ledger != null) ledger.uncertain("incomplete");
    }
  }

  public static void anvilTake(AnvilScreenHandler handler, PlayerEntity entity, ItemStack stack) {
    if (!(entity instanceof ServerPlayerEntity player)) return;
    Click frame = click.get();
    GuiProductionLedger.Session ledger = sessions.get(player);
    if (ledger == null) return;
    try {
      boolean quick = frame != null && frame.player == player && frame.handler == handler && frame.anvilAmount > 0;
      int count = quick ? frame.anvilAmount : stack.getCount();
      String item = quick ? frame.anvilItem : item(stack);
      ledger.take(player, handler, player.currentScreenHandler == handler, "anvil", item, count, item != null && count > 0);
      if (quick) { frame.anvilAmount = 0; frame.anvilItem = null; }
    } catch (IllegalStateException incomplete) { ledger.uncertain("incomplete"); }
  }

  public static void furnaceRecipe(FurnaceAccess access, net.minecraft.item.Item inputBefore, int beforeInput,
      int afterInput, ItemStack output, int beforeOutput, int afterOutput) {
    try {
      Identifier inputId = Registries.ITEM.getId(inputBefore);
      if (!inputId.getNamespace().equals("minecraft")) throw new IllegalStateException("incomplete");
      access.guiProductionLedger().recipe(inputId.getPath(), beforeInput, afterInput, item(output), beforeOutput, afterOutput);
    }
    catch (IllegalStateException incomplete) {
      access.guiProductionLedger().invalidateInput();
      access.guiProductionLedger().invalidateOutput(null, afterOutput);
    }
  }
}
