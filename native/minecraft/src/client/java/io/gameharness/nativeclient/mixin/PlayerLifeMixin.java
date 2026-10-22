package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.network.ClientPlayerEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Managed clients retain vanilla death UI even when a world's immediate-respawn flag is set. */
@Mixin(ClientPlayerEntity.class)
public abstract class PlayerLifeMixin {
  @Inject(method = "showsDeathScreen", at = @At("HEAD"), cancellable = true)
  private void deathScreen(CallbackInfoReturnable<Boolean> result) {
    if (NativeClient.managed()) result.setReturnValue(true);
  }

  @Inject(method = "requestRespawn", at = @At("HEAD"), cancellable = true)
  private void explicitRespawn(CallbackInfo callback) {
    if (NativeClient.managed()
        && (NativeClient.INSTANCE == null || !NativeClient.INSTANCE.respawnAuthorized()))
      callback.cancel();
  }
}
