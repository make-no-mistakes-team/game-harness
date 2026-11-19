package io.gameharness.survival.mixin;

import net.minecraft.client.network.ClientPlayerInteractionManager;
import net.minecraft.util.math.BlockPos;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Read-only evidence from the vanilla interaction manager. */
@Mixin(ClientPlayerInteractionManager.class)
public interface AgentMiningAccess {
    @Accessor("currentBreakingPos") BlockPos agent$breakingPos();
    @Accessor("currentBreakingProgress") float agent$breakingProgress();
}
