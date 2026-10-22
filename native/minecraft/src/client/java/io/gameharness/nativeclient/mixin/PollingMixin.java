package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.util.InputUtil;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(InputUtil.class)
public abstract class PollingMixin {
  @Inject(method = "isKeyPressed", at = @At("HEAD"), cancellable = true)
  private static void block(long window, int key, CallbackInfoReturnable<Boolean> ci) {
    if (NativeClient.managed()) {
      NativeClient.suppressedPolls++;
      ci.setReturnValue(false);
    }
  }
}
