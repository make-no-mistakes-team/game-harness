package io.gameharness.survival.mixin;

import io.gameharness.survival.AgentClient;
import net.minecraft.client.render.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
abstract class AgentRenderMixin {
    @Inject(method = "render", at = @At("HEAD"))
    private void beginVisualInvocation(CallbackInfo ci) { AgentClient.beginVisualRender(); }

    @Inject(method = "renderWorld", at = @At("HEAD"))
    private void steerBeforeCameraUpdate(CallbackInfo ci) { AgentClient.steerFrame(); }

    // As in NativeClient's RenderMixin, read the actual target after vanilla flushes the HUD.
    @Inject(method = "render", at = @At("TAIL"))
    private void finishVisualInvocation(CallbackInfo ci) { AgentClient.finishVisualRender(); }
}
