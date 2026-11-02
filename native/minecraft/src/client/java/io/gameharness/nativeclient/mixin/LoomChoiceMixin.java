package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.VisibleScreenView;
import net.minecraft.block.entity.BannerPattern;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.ingame.LoomScreen;
import net.minecraft.registry.entry.RegistryEntry;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(LoomScreen.class)
public abstract class LoomChoiceMixin implements VisibleScreenView.PagedChoices {
  @Shadow private int visibleTopRow;
  @Shadow private boolean canApplyDyePattern;
  @Shadow protected abstract int getRows();
  @Override public int gameharness$page() { return visibleTopRow; }
  @Inject(method = "drawBanner", at = @At("TAIL"))
  private void pattern(DrawContext context, RegistryEntry<BannerPattern> pattern, int x, int y, CallbackInfo ci) {
    var screen = (LoomScreen)(Object)this;
    var access = (HandledScreenAccess)screen;
    int cell = (x - access.gameharness$x() - 60) / 14 + (y - access.gameharness$y() - 13) / 14 * 4;
    int index = visibleTopRow * 4 + cell;
    VisibleScreenView.loomChoice(screen, index, visibleTopRow, pattern,
        screen.getScreenHandler().getSelectedPattern() == index, x, y);
  }
  @Inject(method = "drawBackground", at = @At("TAIL"))
  private void region(DrawContext context, float delta, int mouseX, int mouseY, CallbackInfo ci) {
    var screen = (LoomScreen)(Object)this;
    var access = (HandledScreenAccess)screen;
    if (canApplyDyePattern && getRows() > 4) VisibleScreenView.scrollRegion(screen, visibleTopRow, "loom patterns",
        access.gameharness$x() + 60, access.gameharness$y() + 13, 56, 56);
  }
}
