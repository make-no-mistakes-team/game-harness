package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.option.KeyBinding;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** A queued press is credited only after vanilla actually removes it. */
@Mixin(KeyBinding.class)
public abstract class ConsumedKeyMixin {
  @Inject(method = "wasPressed", at = @At("HEAD"))
  private void beforeConsumption(CallbackInfoReturnable<Boolean> result) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.beforeStreamKeyConsumption();
  }
  @Inject(method = "wasPressed", at = @At("RETURN"))
  private void consumed(CallbackInfoReturnable<Boolean> result) {
    if (result.getReturnValue() && NativeClient.INSTANCE != null)
      NativeClient.INSTANCE.streamKeyConsumed((KeyBinding) (Object) this);
  }
}
