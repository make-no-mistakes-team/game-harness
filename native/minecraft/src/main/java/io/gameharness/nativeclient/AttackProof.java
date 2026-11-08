package io.gameharness.nativeclient;

import java.util.*;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.networking.v1.*;
import net.minecraft.entity.Entity;
import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.network.packet.c2s.play.PlayerInteractEntityC2SPacket;
import net.minecraft.server.network.ServerPlayNetworkHandler;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.Hand;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.Vec3d;

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

  private record Armed(Receipt receipt, long at, ServerPlayerEntity player) {}

  private static final Map<ServerPlayNetworkHandler, Armed> pending = new IdentityHashMap<>();
  private static final Map<ServerPlayNetworkHandler, Integer> lastNonce = new IdentityHashMap<>();
  private static final ThreadLocal<Frame> active = new ThreadLocal<>();

  private static final class Frame implements PlayerInteractEntityC2SPacket.Handler {
    final ServerPlayNetworkHandler handler;
    final PlayerInteractEntityC2SPacket packet;
    final ServerPlayerEntity player;
    final Entity target;
    final Receipt receipt;
    final DamageAttribution damage;
    boolean attackPacket, ambiguous, returned;
    int attacks, depth;

    Frame(ServerPlayNetworkHandler h, PlayerInteractEntityC2SPacket p, Receipt r) {
      handler = h;
      packet = p;
      player = h.player;
      // Only the actual vanilla packet selects the target, never the arm payload.
      target = p.getEntity(player.getServerWorld());
      receipt = r;
      damage = new DamageAttribution(player, target);
    }

    public void interact(Hand hand) {}

    public void interactAt(Hand hand, Vec3d position) {}

    public void attack() {
      attackPacket = true;
    }
  }

  public void onInitialize() {
    PayloadTypeRegistry.playC2S().register(Receipt.ID, Receipt.CODEC);
    PayloadTypeRegistry.playS2C().register(Receipt.ID, Receipt.CODEC);
    ServerPlayNetworking.registerGlobalReceiver(
        Receipt.ID,
        (r, c) -> {
          // Fabric 4.4.0 PlayPayloadHandler runs on the server thread already.
          // ReentrantThreadExecutor.execute can enqueue even ON that thread while
          // a task is running, placing an arm behind its following vanilla packet.
          if (c.server().isOnThread()) arm(c.player(), r);
          else c.server().execute(() -> arm(c.player(), r));
        });
    ServerPlayConnectionEvents.DISCONNECT.register(
        (h, s) -> {
          if (s.isOnThread()) disconnected(h);
          else s.execute(() -> disconnected(h));
        });
  }

  private static void disconnected(ServerPlayNetworkHandler handler) {
    interrupted(handler);
    lastNonce.remove(handler);
  }

  private static void arm(ServerPlayerEntity player, Receipt receipt) {
    ServerPlayNetworkHandler handler = player.networkHandler;
    if (!handler.isConnectionOpen()) return;
    if (receipt.nonce <= 0 || receipt.generation <= 0 || receipt.outcome != -1) {
      handler.disconnect(net.minecraft.text.Text.literal("Invalid attack receipt context."));
      return;
    }
    Integer previous = lastNonce.get(handler);
    if (previous != null && receipt.nonce <= previous) {
      handler.disconnect(net.minecraft.text.Text.literal("Stale attack receipt context."));
      return;
    }
    lastNonce.put(handler, receipt.nonce);
    pending.put(handler, new Armed(receipt, System.nanoTime(), player));
  }

  /** Called only AFTER vanilla forceMainThread returns, before any handler gate. */
  public static void beginPacket(
      ServerPlayNetworkHandler handler, PlayerInteractEntityC2SPacket packet) {
    Frame previous = active.get();
    active.remove(); // An exceptional/incomplete prior packet never gets a terminal receipt.
    Armed armed = pending.get(handler);
    if (armed == null) return;
    if (armed.player != handler.player || System.nanoTime() - armed.at > 1000000000L) {
      pending.remove(handler);
      return;
    }
    Frame frame = new Frame(handler, packet, armed.receipt);
    // Dispatches only to this inert type probe, not to the vanilla gameplay visitor.
    packet.handle(frame);
    if (!frame.attackPacket) {
      if (previous != null) previous.ambiguous = true;
      return; // INTERACT/INTERACT_AT must not consume the arm.
    }
    pending.remove(handler);
    frame.ambiguous = previous != null;
    active.set(frame);
  }

  public static void begin(ServerPlayerEntity player, Entity target) {
    Frame f = active.get();
    if (f == null) return;
    if (f.player != player || f.target != target || f.attacks++ != 0 || f.depth != 0)
      f.ambiguous = true;
    f.depth++;
  }

  public static void damage(Entity target, Entity attacker, boolean accepted) {
    Frame f = active.get();
    if (f == null) return;
    if (f.depth != 1) f.ambiguous = true;
    f.damage.record(target, attacker, accepted);
  }

  public static void beginDamage(Entity target, Entity attacker) {
    Frame f = active.get();
    if (f == null) return;
    if (f.depth != 1) f.ambiguous = true;
    f.damage.begin(target, attacker);
  }

  public static void end(ServerPlayerEntity player, Entity target) {
    Frame f = active.get();
    if (f == null) return;
    if (f.player != player || f.target != target || f.depth != 1) f.ambiguous = true;
    f.depth--;
    f.returned = true;
  }

  /** Only normal RETURN of the same processed packet can close its owned receipt. */
  public static void endPacket(
      ServerPlayNetworkHandler handler, PlayerInteractEntityC2SPacket packet) {
    Frame f = active.get();
    if (f == null || f.handler != handler || f.packet != packet) return;
    active.remove();
    if (!handler.isConnectionOpen() || handler.player != f.player) return;
    int outcome =
        f.ambiguous || f.depth != 0 ? 2
            : f.attacks == 0 ? 0
            : f.attacks == 1 && f.returned ? f.damage.outcome() : 2;
    ServerPlayNetworking.send(
        f.player, new Receipt(f.receipt.nonce, f.receipt.generation, outcome));
  }

  /** A disconnect request can precede the asynchronous socket-close event. */
  public static void interrupted(ServerPlayNetworkHandler handler) {
    pending.remove(handler);
    Frame f = active.get();
    if (f != null && f.handler == handler) active.remove();
  }
}
