package io.gameharness.nativeclient.mixin;

import net.minecraft.client.sound.Channel;
import net.minecraft.client.sound.Source;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(Channel.SourceManager.class)
public interface SourceManagerAccess {
  @Accessor("source")
  Source gameharness$source();
}
