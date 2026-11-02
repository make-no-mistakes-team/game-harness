package io.gameharness.nativeclient.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(targets = "net.minecraft.client.gui.screen.ingame.BeaconScreen$BaseButtonWidget")
public interface BeaconButtonAccess {
  @Accessor("disabled") boolean gameharness$selected();
}
