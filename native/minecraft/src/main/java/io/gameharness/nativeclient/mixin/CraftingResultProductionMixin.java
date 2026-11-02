package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.GuiTransactionProof;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.slot.CraftingResultSlot;
import net.minecraft.screen.slot.Slot;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(CraftingResultSlot.class)
public abstract class CraftingResultProductionMixin {
  @Shadow @Final private PlayerEntity player;
  @Shadow private int amount;

  // Vanilla accumulates the exact normal/hotbar/quick-transfer quantity, then resets it here.
  @Inject(method = "onCrafted(Lnet/minecraft/item/ItemStack;)V", at = @At("HEAD"))
  private void taken(ItemStack stack, CallbackInfo ci) {
    GuiTransactionProof.resultTake(player, (Slot) (Object) this, stack, amount, "crafting");
  }
}
