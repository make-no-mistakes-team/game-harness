package io.gameharness.pilot.mixin;

import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(Mouse.class)
public interface PilotMouseAccess {
    @Invoker("onCursorPos")
    void pilot$onCursorPos(long window, double x, double y);
}
