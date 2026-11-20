package io.gameharness.survival.mixin;

import io.gameharness.survival.AgentClient;
import net.minecraft.block.BlockState;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.util.math.BlockPos;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClientWorld.class)
abstract class AgentFurnaceBlockMixin {
    @Inject(method = "handleBlockUpdate", at = @At("RETURN"))
    private void agent$observeFurnaceBlock(BlockPos pos, BlockState state, int flags, CallbackInfo ci) {
        AgentClient.observeFurnaceBlock((ClientWorld) (Object) this, pos, state);
    }
}
