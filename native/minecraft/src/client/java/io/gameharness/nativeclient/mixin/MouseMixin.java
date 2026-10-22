package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Mouse.class)
public abstract class MouseMixin {
  @Inject(
      method = {"onMouseButton", "onMouseScroll", "onCursorPos", "onFilesDropped", "lockCursor"},
      at = @At("HEAD"),
      cancellable = true)
  private void block(CallbackInfo ci) {
    if (NativeClient.managed()) {
      NativeClient.blockedMouseCallbacks++;
      ci.cancel();
    }
  }
}
