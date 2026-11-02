package io.gameharness.nativeclient.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(targets = "net.minecraft.client.gui.screen.ingame.MerchantScreen$WidgetButtonPage")
public interface MerchantOfferAccess {
  @Accessor("index") int gameharness$index();
}
