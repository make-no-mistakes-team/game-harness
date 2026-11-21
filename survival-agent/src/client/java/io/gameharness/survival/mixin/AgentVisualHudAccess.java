package io.gameharness.survival.mixin;

import net.minecraft.client.gui.hud.InGameHud;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(InGameHud.class)
public interface AgentVisualHudAccess {
    @Accessor("titleRemainTicks") int agent$visualTitleTicks();
    @Accessor("overlayRemaining") int agent$visualOverlayTicks();
}
