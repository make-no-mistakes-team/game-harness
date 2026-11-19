package io.gameharness.pilot.mixin;

import io.gameharness.pilot.PilotClient;
import net.minecraft.client.render.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
abstract class PilotRenderMixin {
    @Inject(method = "renderWorld", at = @At("HEAD"))
    private void steerBeforeCameraUpdate(CallbackInfo ci) { PilotClient.steerFrame(); }
}
