package io.gameharness.nativeclient.mixin;

import java.util.Set;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.screen.slot.Slot;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(HandledScreen.class)
public interface HandledScreenAccess {
  @Accessor("x") int gameharness$x();
  @Accessor("y") int gameharness$y();
  @Accessor("cursorDragging") void gameharness$dragging(boolean value);
  @Accessor("cursorDragSlots") Set<Slot> gameharness$dragSlots();
  @Accessor("cancelNextRelease") void gameharness$cancelRelease(boolean value);
}
