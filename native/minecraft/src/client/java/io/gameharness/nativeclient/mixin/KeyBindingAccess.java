package io.gameharness.nativeclient.mixin;

import net.minecraft.client.option.KeyBinding;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Counted presses are independent of held state; physical callbacks never inject them. */
@Mixin(KeyBinding.class)
public interface KeyBindingAccess {
  @Accessor("timesPressed") int gameharness$presses();
  @Accessor("timesPressed") void gameharness$presses(int count);
  @Accessor("pressed") void gameharness$held(boolean held);
}
