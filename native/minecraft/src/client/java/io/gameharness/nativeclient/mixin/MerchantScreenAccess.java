package io.gameharness.nativeclient.mixin;

import net.minecraft.client.gui.screen.ingame.MerchantScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(MerchantScreen.class)
public interface MerchantScreenAccess {
  @Accessor("indexStartOffset") int gameharness$offset();
  @Accessor("selectedIndex") int gameharness$selected();
}
