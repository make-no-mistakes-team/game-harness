package io.gameharness.survival.mixin;

import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(Mouse.class)
public interface AgentMouseAccess {
    @Invoker("onCursorPos")
    void agent$onCursorPos(long window, double x, double y);
}
