package io.gameharness.pilot;

import net.minecraft.screen.slot.Slot;

/** One scoped vanilla Shift press on a visible crafting result. */
public interface PilotCraftClick {
    boolean pilot$shiftClickResult(Slot result, double x, double y);
}
