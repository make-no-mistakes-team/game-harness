package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.GuiTransactionProof;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.slot.FurnaceOutputSlot;
import net.minecraft.screen.slot.Slot;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(FurnaceOutputSlot.class)
public abstract class FurnaceResultProductionMixin {
  @Shadow @Final private PlayerEntity player;
  @Shadow private int amount;

  @Inject(method = "onCrafted(Lnet/minecraft/item/ItemStack;)V", at = @At("HEAD"))
  private void taken(ItemStack stack, CallbackInfo ci) {
    GuiTransactionProof.resultTake(player, (Slot) (Object) this, stack, amount, "smelting");
  }
}
