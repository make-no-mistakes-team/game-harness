package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.AttackProof;
import net.minecraft.network.packet.c2s.play.PlayerInteractEntityC2SPacket;
import net.minecraft.server.network.ServerPlayNetworkHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ServerPlayNetworkHandler.class)
public abstract class AttackPacketMixin {
  @Inject(
      method = "onPlayerInteractEntity",
      at = @At(
          value = "INVOKE",
          target = "Lnet/minecraft/network/NetworkThreadUtils;forceMainThread(Lnet/minecraft/network/packet/Packet;Lnet/minecraft/network/listener/PacketListener;Lnet/minecraft/server/world/ServerWorld;)V",
          shift = At.Shift.AFTER))
  private void before(PlayerInteractEntityC2SPacket packet, CallbackInfo ci) {
    // The Netty invocation throws during forceMainThread; only its server-thread
    // replay reaches this point. Never access receipt maps from a HEAD injection.
    AttackProof.beginPacket((ServerPlayNetworkHandler) (Object) this, packet);
  }

  @Inject(method = "onPlayerInteractEntity", at = @At("RETURN"))
  private void after(PlayerInteractEntityC2SPacket packet, CallbackInfo ci) {
    AttackProof.endPacket((ServerPlayNetworkHandler) (Object) this, packet);
  }
}
