package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.AttackProof;
import net.minecraft.network.DisconnectionInfo;
import net.minecraft.network.packet.Packet;
import net.minecraft.server.network.ServerCommonNetworkHandler;
import net.minecraft.server.network.ServerPlayNetworkHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ServerCommonNetworkHandler.class)
public abstract class AttackConnectionMixin {
  @Inject(
      method = "disconnect(Lnet/minecraft/network/DisconnectionInfo;)V",
      at = @At("HEAD"))
  private void disconnecting(DisconnectionInfo reason, CallbackInfo ci) {
    if ((Object) this instanceof ServerPlayNetworkHandler handler)
      interruptOnServer(handler);
  }

  @Inject(method = "onPacketException", at = @At("HEAD"))
  private void exception(Packet<?> packet, Exception error, CallbackInfo ci) {
    if ((Object) this instanceof ServerPlayNetworkHandler handler)
      interruptOnServer(handler);
  }

  @Unique
  private static void interruptOnServer(ServerPlayNetworkHandler handler) {
    var server = handler.player.getServer();
    if (server == null) return;
    // Disconnect/exception entry points can also be reached by network code.
    if (server.isOnThread()) AttackProof.interrupted(handler);
    else server.execute(() -> AttackProof.interrupted(handler));
  }
}
