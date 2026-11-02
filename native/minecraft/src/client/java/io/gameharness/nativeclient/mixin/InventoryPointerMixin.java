package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.VisibleInventory;
import io.gameharness.nativeclient.VisibleScreen;
import io.gameharness.nativeclient.VisibleScreenView;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Screen.class)
public abstract class InventoryPointerMixin {
  @Inject(method = "renderWithTooltip", at = @At("HEAD"))
  private void begin(DrawContext context, int mouseX, int mouseY, float delta, CallbackInfo ci) {
    VisibleScreenView.begin((Screen) (Object) this);
  }
  @Inject(method = "renderWithTooltip", at = @At("TAIL"))
  private void pointer(DrawContext context, int mouseX, int mouseY, float delta, CallbackInfo ci) {
    VisibleScreenView.end((Screen) (Object) this);
    VisibleInventory.drawPointer((Screen) (Object) this, context);
    VisibleScreen.drawPointer((Screen) (Object) this, context);
  }
}
