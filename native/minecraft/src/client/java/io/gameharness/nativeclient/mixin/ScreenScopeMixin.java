package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MinecraftClient.class)
public abstract class ScreenScopeMixin {
  @Inject(method = "setScreen", at = @At("TAIL"))
  private void screen(Screen screen, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.screenReceived();
  }
}
