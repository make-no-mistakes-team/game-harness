package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import io.gameharness.nativeclient.VisibleInventory;
import io.gameharness.nativeclient.VisibleScreen;
import net.minecraft.client.render.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.invoke.arg.Args;

@Mixin(GameRenderer.class)
public abstract class RenderMixin {
  @Inject(method = "render", at = @At("HEAD"))
  private void beginCaptureInvocation(CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.renderStarted();
  }

  @ModifyArgs(method = "render", at = @At(value = "INVOKE",
      target = "Lnet/minecraft/client/gui/screen/Screen;renderWithTooltip(Lnet/minecraft/client/gui/DrawContext;IIF)V"))
  private void inventoryPointer(Args args) {
    if (VisibleInventory.preparePointer()) {
      args.set(1, VisibleInventory.pointerX());
      args.set(2, VisibleInventory.pointerY());
    } else if (VisibleScreen.preparePointer()) {
      args.set(1, VisibleScreen.pointerX());
      args.set(2, VisibleScreen.pointerY());
    }
  }
  // GameRenderer.render flushes Screen.renderWithTooltip (including vanilla DeathScreen)
  // before returning. Capture here, not renderWorld tail or an HTML replacement.
  @Inject(method = "render", at = @At("TAIL"))
  private void capture(CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.render();
  }
}
