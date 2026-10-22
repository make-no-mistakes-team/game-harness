package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.render.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
public abstract class RenderMixin {
  // GameRenderer.render flushes Screen.renderWithTooltip (including vanilla DeathScreen)
  // before returning. Capture here, not renderWorld tail or an HTML replacement.
  @Inject(method = "render", at = @At("TAIL"))
  private void capture(CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.render();
  }
}
