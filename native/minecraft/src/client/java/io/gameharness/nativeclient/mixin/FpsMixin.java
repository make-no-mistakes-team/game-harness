package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.option.InactivityFpsLimiter;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(InactivityFpsLimiter.class)
public abstract class FpsMixin {
  @Inject(method = "update", at = @At("HEAD"), cancellable = true)
  private void managed(CallbackInfoReturnable<Integer> ci) {
    if (NativeClient.managed()) ci.setReturnValue(60);
  }
}
