package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.VisibleInventory;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Screen.class)
public abstract class InventoryPointerMixin {
  @Inject(method = "renderWithTooltip", at = @At("TAIL"))
  private void pointer(DrawContext context, int mouseX, int mouseY, float delta, CallbackInfo ci) {
    VisibleInventory.drawPointer((Screen) (Object) this, context);
  }
}
