package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import io.gameharness.nativeclient.VisibleScreen;
import net.minecraft.client.gui.screen.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** No physical polling bypass: only this client's authorized vanilla world-consumption phase. */
@Mixin(Screen.class)
public abstract class WorldModifierMixin {
  @Inject(method = "hasControlDown", at = @At("HEAD"), cancellable = true)
  private static void ownedDrop(CallbackInfoReturnable<Boolean> ci) {
    if (VisibleScreen.modifiersOwned()) ci.setReturnValue(VisibleScreen.controlDown());
    else if (NativeClient.INSTANCE != null && NativeClient.INSTANCE.ownedWorldModifier())
      ci.setReturnValue(NativeClient.INSTANCE.ownedWorldDropAll());
  }
  @Inject(method = "hasShiftDown", at = @At("HEAD"), cancellable = true)
  private static void ownedShift(CallbackInfoReturnable<Boolean> ci) {
    if (VisibleScreen.modifiersOwned()) ci.setReturnValue(VisibleScreen.shiftDown());
  }
}
