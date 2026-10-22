package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import java.util.*;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.networking.v1.*;
import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.registry.Registries;
import net.minecraft.util.Identifier;

/**
 * Read-only receipt for the admitted player's OWN inventory after vanilla packet processing. No
 * target selector, world query, console command or gameplay mutation is accepted.
 */
public final class InventoryProof implements ModInitializer {
  public record Receipt(int nonce, long generation, String contents) implements CustomPayload {
    public static final Id<Receipt> ID =
        new Id<>(Identifier.of("gameharness", "own_inventory_receipt_v1"));
    public static final PacketCodec<RegistryByteBuf, Receipt> CODEC =
        PacketCodec.of(
            (value, buf) -> {
              buf.writeInt(value.nonce);
              buf.writeLong(value.generation);
              buf.writeString(value.contents, 16384);
            },
            buf -> new Receipt(buf.readInt(), buf.readLong(), buf.readString(16384)));

    public Id<? extends CustomPayload> getId() {
      return ID;
    }
  }

  private final Map<UUID, Integer> lastRequest = new HashMap<>();

  public void onInitialize() {
    PayloadTypeRegistry.playC2S().register(Receipt.ID, Receipt.CODEC);
    PayloadTypeRegistry.playS2C().register(Receipt.ID, Receipt.CODEC);
    ServerPlayNetworking.registerGlobalReceiver(
        Receipt.ID,
        (request, context) -> {
          if (request.nonce <= 0 || request.generation <= 0 || !request.contents.isEmpty()) {
            context
                .player()
                .networkHandler
                .disconnect(
                    net.minecraft.text.Text.literal("Invalid own-inventory receipt request."));
            return;
          }
          context
              .server()
              .execute(
                  () -> {
                    var player = context.player();
                    Integer previous = lastRequest.get(player.getUuid());
                    if (previous != null && request.nonce <= previous) {
                      player.networkHandler.disconnect(
                          net.minecraft.text.Text.literal("Stale own-inventory receipt request."));
                      return;
                    }
                    lastRequest.put(player.getUuid(), request.nonce);
                    JsonObject counts = new JsonObject(),
                        slots = new JsonObject(),
                        result = new JsonObject();
                    for (int i = 0; i < player.getInventory().size(); i++) {
                      var stack = player.getInventory().getStack(i);
                      if (stack.isEmpty()) continue;
                      String item = Registries.ITEM.getId(stack.getItem()).getPath();
                      JsonObject slot = new JsonObject();
                      slot.addProperty("name", item);
                      slot.addProperty("count", stack.getCount());
                      slots.add(Integer.toString(i), slot);
                      counts.addProperty(
                          item,
                          (counts.has(item) ? counts.get(item).getAsInt() : 0) + stack.getCount());
                    }
                    result.add("counts", counts);
                    result.add("slots", slots);
                    result.addProperty("alive", player.isAlive() && player.getHealth() > 0);
                    result.addProperty("health", player.getHealth());
                    ServerPlayNetworking.send(
                        player, new Receipt(request.nonce, request.generation, result.toString()));
                  });
        });
    ServerPlayConnectionEvents.DISCONNECT.register(
        (handler, server) -> lastRequest.remove(handler.player.getUuid()));
  }
}
