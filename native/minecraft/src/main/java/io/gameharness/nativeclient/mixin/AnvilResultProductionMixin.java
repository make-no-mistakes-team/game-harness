package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.GuiTransactionProof;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.AnvilScreenHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(AnvilScreenHandler.class)
public abstract class AnvilResultProductionMixin {
  @Inject(method = "onTakeOutput", at = @At("RETURN"))
  private void taken(PlayerEntity player, ItemStack stack, CallbackInfo ci) {
    GuiTransactionProof.anvilTake((AnvilScreenHandler) (Object) this, player, stack);
  }
}
