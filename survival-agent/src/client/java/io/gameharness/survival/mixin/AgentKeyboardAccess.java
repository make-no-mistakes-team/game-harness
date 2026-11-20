package io.gameharness.survival.mixin;

import net.minecraft.client.Keyboard;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(Keyboard.class)
public interface AgentKeyboardAccess {
    @Invoker("onKey")
    void agent$onKey(long window, int key, int scancode, int action, int modifiers);
}
