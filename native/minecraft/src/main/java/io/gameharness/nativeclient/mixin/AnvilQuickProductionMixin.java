package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.GuiTransactionProof;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.slot.Slot;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Slot.class)
public abstract class AnvilQuickProductionMixin {
  @Inject(method = "onQuickTransfer", at = @At("HEAD"))
  private void quantity(ItemStack remaining, ItemStack original, CallbackInfo ci) {
    GuiTransactionProof.anvilQuickTransfer((Slot) (Object) this, remaining, original);
  }
}
