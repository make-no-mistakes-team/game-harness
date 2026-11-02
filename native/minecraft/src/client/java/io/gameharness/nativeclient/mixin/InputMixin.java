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
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.keyboardInputStarted();
  }

  @Inject(method = "tick", at = @At("TAIL"))
  private void sampled(CallbackInfo ci) {
    if (NativeClient.INSTANCE == null) return;
    var input = ((KeyboardInput) (Object) this).playerInput;
    NativeClient.INSTANCE.keyboardInputSampled(input.forward() || input.backward()
        || input.left() || input.right() || input.jump() || input.sneak() || input.sprint());
  }
}
