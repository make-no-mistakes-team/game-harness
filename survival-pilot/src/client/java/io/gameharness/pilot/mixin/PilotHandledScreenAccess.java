package io.gameharness.pilot.mixin;

import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.screen.slot.Slot;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Geometry of the same slots that vanilla renders and hit-tests under the pointer. */
@Mixin(HandledScreen.class)
public interface PilotHandledScreenAccess {
    @Accessor("x") int pilot$x();
    @Accessor("y") int pilot$y();
    @Invoker("getSlotAt") Slot pilot$slotAt(double x, double y);
}
