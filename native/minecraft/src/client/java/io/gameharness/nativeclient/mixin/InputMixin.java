package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.input.KeyboardInput;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(KeyboardInput.class)
public abstract class InputMixin {
  @Inject(method = "tick", at = @At("HEAD"))
  private void apply(CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.applyInput();
  }
}
