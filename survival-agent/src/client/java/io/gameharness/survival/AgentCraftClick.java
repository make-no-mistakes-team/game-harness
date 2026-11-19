package io.gameharness.survival;

import net.minecraft.screen.slot.Slot;

/** One scoped vanilla Shift press on a visible crafting result. */
public interface AgentCraftClick {
    boolean agent$shiftClickResult(Slot result, double x, double y);
}
