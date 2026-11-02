package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.VisibleScreenView;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.ingame.MerchantScreen;
import net.minecraft.village.TradeOfferList;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MerchantScreen.class)
public abstract class MerchantScreenDrawMixin implements VisibleScreenView.PagedChoices {
  @Override public int gameharness$page() {
    return ((MerchantScreenAccess)this).gameharness$offset();
  }
  @Inject(method = "renderScrollbar", at = @At("TAIL"))
  private void scrollbar(DrawContext context, int x, int y, TradeOfferList offers, CallbackInfo ci) {
    // The pinned vanilla draw uses its active scroller only above seven offers.
    // Read only that drawn-state gate, never the off-page offer contents.
    if (offers.size() <= 7) return;
    var screen = (MerchantScreen)(Object)this;
    VisibleScreenView.scrollRegion(screen, ((MerchantScreenAccess)screen).gameharness$offset(),
        "merchant offers", x + 94, y + 18, 6, 139);
  }
}
