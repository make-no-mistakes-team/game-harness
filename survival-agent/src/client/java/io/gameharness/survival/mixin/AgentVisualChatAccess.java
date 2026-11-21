package io.gameharness.survival.mixin;

import java.util.List;
import net.minecraft.client.gui.hud.ChatHud;
import net.minecraft.client.gui.hud.ChatHudLine;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(ChatHud.class)
public interface AgentVisualChatAccess {
    @Accessor("visibleMessages") List<ChatHudLine.Visible> agent$visualMessages();
}
