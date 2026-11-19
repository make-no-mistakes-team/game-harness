package io.gameharness.survival.mixin;

import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.screen.slot.Slot;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Geometry of the same slots that vanilla renders and hit-tests under the pointer. */
@Mixin(HandledScreen.class)
public interface AgentHandledScreenAccess {
    @Accessor("x") int agent$x();
    @Accessor("y") int agent$y();
    @Invoker("getSlotAt") Slot agent$slotAt(double x, double y);
}
