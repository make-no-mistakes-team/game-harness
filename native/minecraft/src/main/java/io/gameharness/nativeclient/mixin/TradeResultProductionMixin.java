package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.GuiTransactionProof;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.slot.Slot;
import net.minecraft.screen.slot.TradeOutputSlot;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(TradeOutputSlot.class)
public abstract class TradeResultProductionMixin {
  @Shadow private int amount;
  @Unique private ItemStack gameharness$output;
  @Unique private int gameharness$count;

  @Inject(method = "onCrafted(Lnet/minecraft/item/ItemStack;)V", at = @At("HEAD"))
  private void quantity(ItemStack stack, CallbackInfo ci) {
    if (amount > 0) {
      gameharness$output = stack;
      gameharness$count = amount;
    }
  }

  // This invocation is reached ONLY after vanilla successfully depletes the buy items.
  // Reading hidden offers is neither needed nor permitted.
  @Inject(method = "onTakeItem", at = @At(value = "INVOKE",
      target = "Lnet/minecraft/village/Merchant;trade(Lnet/minecraft/village/TradeOffer;)V",
      shift = At.Shift.AFTER))
  private void traded(PlayerEntity player, ItemStack stack, CallbackInfo ci) {
    if (gameharness$output != null)
      GuiTransactionProof.resultTake(player, (Slot) (Object) this, gameharness$output, gameharness$count, "trading");
    gameharness$output = null;
    gameharness$count = 0;
  }

  @Inject(method = "onTakeItem", at = @At("RETURN"))
  private void retired(PlayerEntity player, ItemStack stack, CallbackInfo ci) {
    gameharness$output = null;
    gameharness$count = 0;
  }
}
