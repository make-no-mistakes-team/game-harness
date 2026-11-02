package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.VisibleScreenView;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.screen.slot.Slot;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(HandledScreen.class)
public abstract class VisibleSlotMixin {
  @Inject(method = "drawSlot", at = @At("HEAD"))
  private void capture(DrawContext context, Slot slot, CallbackInfo ci) { VisibleScreenView.slot(slot); }
}
