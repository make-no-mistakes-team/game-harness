package io.gameharness.nativeclient.mixin;

import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(DeathScreen.class)
public interface DeathScreenAccess {
  @Accessor("ticksSinceDeath") int gameharness$deathTicks();
  @Accessor("isHardcore") boolean gameharness$hardcore();
  @Accessor("message") Text gameharness$deathMessage();
}
