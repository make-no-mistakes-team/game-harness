package io.gameharness.survival.mixin;

import java.util.Map;
import net.minecraft.client.gui.hud.BossBarHud;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(BossBarHud.class)
public interface AgentVisualBossAccess {
    @Accessor("bossBars") Map<?, ?> agent$visualBars();
}
