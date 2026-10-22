package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.Keyboard;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Keyboard.class)
public abstract class KeyboardMixin {
  @Inject(
      method = {"onKey", "onChar"},
      at = @At("HEAD"),
      cancellable = true)
  private void block(CallbackInfo ci) {
    if (NativeClient.managed()) {
      NativeClient.blockedKeyboardCallbacks++;
      ci.cancel();
    }
  }
}
