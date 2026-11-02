package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.VisibleScreenView;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.ingame.StonecutterScreen;
import net.minecraft.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(StonecutterScreen.class)
public abstract class StonecutterChoiceMixin implements VisibleScreenView.PagedChoices {
  @Shadow private int scrollOffset;
  @Shadow private boolean canCraft;
  @Shadow protected abstract boolean shouldScroll();
  @Override public int gameharness$page() { return scrollOffset; }
  @Inject(method = "drawBackground", at = @At("TAIL"))
  private void region(DrawContext context, float delta, int mouseX, int mouseY, CallbackInfo ci) {
    var screen = (StonecutterScreen)(Object)this;
    var access = (HandledScreenAccess)screen;
    if (canCraft && shouldScroll()) VisibleScreenView.scrollRegion(screen, scrollOffset, "stonecutter recipes",
        access.gameharness$x() + 52, access.gameharness$y() + 14, 64, 54);
  }
  @Redirect(method = "renderRecipeIcons", at = @At(value = "INVOKE",
      target = "Lnet/minecraft/client/gui/DrawContext;drawItem(Lnet/minecraft/item/ItemStack;II)V"))
  private void icon(DrawContext context, ItemStack stack, int x, int y) {
    context.drawItem(stack, x, y);
    var screen = (StonecutterScreen)(Object)this;
    var access = (HandledScreenAccess)screen;
    int cell = (x - access.gameharness$x() - 52) / 16 + (y - access.gameharness$y() - 16) / 18 * 4;
    VisibleScreenView.stoneChoice(screen, scrollOffset + cell, scrollOffset, stack,
        screen.getScreenHandler().getSelectedRecipe() == scrollOffset + cell, x, y - 2);
  }
}
