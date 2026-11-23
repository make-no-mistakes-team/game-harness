package io.gameharness.survival.mixin;

import io.gameharness.survival.AgentClient;
import net.minecraft.block.BlockState;
import net.minecraft.client.render.VertexConsumer;
import net.minecraft.client.render.WorldRenderer;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.entity.Entity;
import net.minecraft.util.math.BlockPos;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(WorldRenderer.class)
abstract class AgentSupplyOutlineRenderMixin {
    @Inject(method = "drawBlockOutline", at = @At("TAIL"))
    private void observeOutline(MatrixStack matrices, VertexConsumer vertices, Entity camera,
                                double x, double y, double z, BlockPos pos, BlockState state, int color, CallbackInfo ci) {
        AgentClient.observeVanillaBlockOutline(camera, pos, state);
    }
}
