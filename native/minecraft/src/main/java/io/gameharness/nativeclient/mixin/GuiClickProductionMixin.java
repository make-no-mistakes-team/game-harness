package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.GuiTransactionProof;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ScreenHandler.class)
public abstract class GuiClickProductionMixin {
  @Inject(method = "onSlotClick", at = @At("HEAD"))
  private void before(int slot, int button, SlotActionType action, PlayerEntity player, CallbackInfo ci) {
    GuiTransactionProof.beginClick((ScreenHandler) (Object) this, player);
  }

  @Inject(method = "onSlotClick", at = @At("RETURN"))
  private void after(int slot, int button, SlotActionType action, PlayerEntity player, CallbackInfo ci) {
    GuiTransactionProof.endClick((ScreenHandler) (Object) this, player);
  }
}
