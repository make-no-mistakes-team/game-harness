package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.*;
import java.util.Map;
import net.minecraft.client.sound.*;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(SoundSystem.class)
public abstract class SoundMixin {
  @Shadow @Final private Map<SoundInstance, Channel.SourceManager> sources;
  @Shadow @Final private SoundListener listener;

  // Pinned1.21.4 bytecode: secondMap.put is accepted sources insertion, before queued
  // configure/play.
  @Inject(
      method = "play(Lnet/minecraft/client/sound/SoundInstance;)V",
      at =
          @At(
              value = "INVOKE",
              target = "Ljava/util/Map;put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",
              ordinal = 1,
              shift = At.Shift.AFTER))
  private void tag(SoundInstance sound, CallbackInfo ci) {
    int category = SoundProjection.category(sound.getId().toString());
    if (category < 0) return;
    Channel.SourceManager manager = sources.get(sound);
    if (manager == null) return;
    Source source = ((SourceManagerAccess) manager).gameharness$source();
    if (source != null) ((AudibleSource) source).gameharness$tag(category, listener);
  }
}
