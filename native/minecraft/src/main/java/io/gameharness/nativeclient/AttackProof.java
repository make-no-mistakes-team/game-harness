package io.gameharness.nativeclient;

import java.util.*;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.networking.v1.*;
import net.minecraft.entity.Entity;
import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.Identifier;

/**
 * Correlates ONLY the next vanilla attack from its admitted connection; no target/query payload.
 */
public final class AttackProof implements ModInitializer {
  public record Receipt(int nonce, long generation, int outcome) implements CustomPayload {
    public static final Id<Receipt> ID =
        new Id<>(Identifier.of("gameharness", "attack_receipt_v1"));
    public static final PacketCodec<RegistryByteBuf, Receipt> CODEC =
        PacketCodec.of(
            (v, b) -> {
              b.writeInt(v.nonce);
              b.writeLong(v.generation);
              b.writeByte(v.outcome);
            },
            b -> new Receipt(b.readInt(), b.readLong(), b.readByte()));

    public Id<? extends CustomPayload> getId() {
      return ID;
    }
  }

  private record Armed(Receipt receipt, long at) {}

  private static final Map<ServerPlayerEntity, Armed> pending = new IdentityHashMap<>();
  private static final Map<ServerPlayerEntity, Integer> lastNonce = new IdentityHashMap<>();
  private static final ThreadLocal<Frame> active = new ThreadLocal<>();

  private static final class Frame {
    final ServerPlayerEntity player;
    final Entity target;
    final Receipt receipt;
    final DamageAttribution damage;

    Frame(ServerPlayerEntity p, Entity t, Receipt r) {
      player = p;
      target = t;
      receipt = r;
      damage = new DamageAttribution(p, t);
    }
  }

  public void onInitialize() {
    PayloadTypeRegistry.playC2S().register(Receipt.ID, Receipt.CODEC);
    PayloadTypeRegistry.playS2C().register(Receipt.ID, Receipt.CODEC);
    ServerPlayNetworking.registerGlobalReceiver(
        Receipt.ID,
        (r, c) -> {
          if (r.nonce <= 0 || r.generation <= 0 || r.outcome != -1) {
            c.player()
                .networkHandler
                .disconnect(net.minecraft.text.Text.literal("Invalid attack receipt context."));
            return;
          }
          c.server()
              .execute(
                  () -> {
                    Integer previous = lastNonce.get(c.player());
                    if (previous != null && r.nonce <= previous) {
                      c.player()
                          .networkHandler
                          .disconnect(
                              net.minecraft.text.Text.literal("Stale attack receipt context."));
                      return;
                    }
                    lastNonce.put(c.player(), r.nonce);
                    pending.put(c.player(), new Armed(r, System.nanoTime()));
                  });
        });
    ServerPlayConnectionEvents.DISCONNECT.register(
        (h, s) -> {
          pending.remove(h.player);
          lastNonce.remove(h.player);
          Frame f = active.get();
          if (f != null && f.player == h.player) active.remove();
        });
  }

  public static void begin(ServerPlayerEntity player, Entity target) {
    active.remove();
    Armed armed = pending.remove(player);
    if (armed == null || System.nanoTime() - armed.at > 1000000000L) return;
    active.set(new Frame(player, target, armed.receipt));
  }

  public static void damage(Entity target, Entity attacker, boolean accepted) {
    Frame f = active.get();
    if (f != null) f.damage.record(target, attacker, accepted);
  }

  public static void end(ServerPlayerEntity player, Entity target) {
    Frame f = active.get();
    if (f == null || f.player != player || f.target != target) return;
    active.remove();
    ServerPlayNetworking.send(
        player, new Receipt(f.receipt.nonce, f.receipt.generation, f.damage.outcome()));
  }
}
