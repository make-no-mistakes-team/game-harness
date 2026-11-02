package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(MinecraftClient.class)
public abstract class WorldInputMixin {
  @Inject(method = "tick", at = @At(value = "INVOKE",
      target = "Lnet/minecraft/client/render/GameRenderer;updateCrosshairTarget(F)V", shift = At.Shift.BEFORE))
  private void beforeCrosshair(CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.beforeCrosshair();
  }
  @Inject(method = "handleInputEvents", at = @At("HEAD"))
  private void consuming(CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.ordinaryConsumptionStarted();
  }
  @Inject(method = "handleInputEvents", at = @At("TAIL"))
  private void consumed(CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.ordinaryConsumptionEnded();
  }
  @Inject(method = "doAttack", at = @At("HEAD"), cancellable = true)
  private void attack(CallbackInfoReturnable<Boolean> ci) {
    if (NativeClient.INSTANCE != null && !NativeClient.INSTANCE.ordinaryAttackEntry()) ci.setReturnValue(false);
  }
  @Inject(method = "doItemUse", at = @At("HEAD"), cancellable = true)
  private void use(CallbackInfo ci) {
    if (NativeClient.INSTANCE != null && !NativeClient.INSTANCE.ordinaryUseEntry()) ci.cancel();
  }
  @Inject(method = "handleBlockBreaking", at = @At("HEAD"), cancellable = true)
  private void blockHold(boolean breaking, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null && !NativeClient.INSTANCE.ordinaryBlockEntry()) ci.cancel();
  }
}
