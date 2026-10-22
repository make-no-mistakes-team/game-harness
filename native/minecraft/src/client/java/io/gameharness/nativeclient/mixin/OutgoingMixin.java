package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.network.ClientConnection;
import net.minecraft.network.packet.Packet;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClientConnection.class)
public abstract class OutgoingMixin {
  @Inject(method = "send(Lnet/minecraft/network/packet/Packet;)V", at = @At("HEAD"))
  private void sent(Packet<?> packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.sent(packet);
  }
}
