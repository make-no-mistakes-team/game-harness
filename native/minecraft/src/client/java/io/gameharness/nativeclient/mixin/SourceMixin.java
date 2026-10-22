package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.*;
import net.minecraft.client.sound.*;
import net.minecraft.util.math.Vec3d;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Source.class)
public abstract class SourceMixin implements AudibleSource {
  @Unique private volatile int gameharness$category = -1;
  @Unique private SoundListener gameharness$listener;
  @Unique private double gameharness$x, gameharness$y, gameharness$z;
  @Unique private float gameharness$gain, gameharness$cutoff;
  @Unique private boolean gameharness$relative, gameharness$linear;

  public void gameharness$tag(int category, SoundListener listener) {
    gameharness$listener = listener;
    gameharness$category = category;
  }

  @Inject(method = "setPosition", at = @At("TAIL"))
  private void position(Vec3d p, CallbackInfo ci) {
    gameharness$x = p.x;
    gameharness$y = p.y;
    gameharness$z = p.z;
  }

  @Inject(method = "setVolume", at = @At("TAIL"))
  private void gain(float value, CallbackInfo ci) {
    gameharness$gain = value;
  }

  @Inject(method = "setAttenuation", at = @At("TAIL"))
  private void attenuation(float value, CallbackInfo ci) {
    gameharness$cutoff = value;
    gameharness$linear = true;
  }

  @Inject(method = "disableAttenuation", at = @At("TAIL"))
  private void unattenuated(CallbackInfo ci) {
    gameharness$linear = false;
  }

  @Inject(method = "setRelative", at = @At("TAIL"))
  private void relative(boolean value, CallbackInfo ci) {
    gameharness$relative = value;
  }

  @Inject(method = "close", at = @At("HEAD"))
  private void release(CallbackInfo ci) {
    gameharness$category = -1;
    gameharness$listener = null;
  }

  @Inject(method = "play", at = @At("RETURN"))
  private void delivered(CallbackInfo ci) {
    int category = gameharness$category;
    gameharness$category = -1;
    SoundListener listener = gameharness$listener;
    if (category < 0
        || listener == null
        || gameharness$relative
        || gameharness$gain <= 0
        || listener.getVolume() <= 0
        || !((Source) (Object) this).isPlaying()
        || NativeClient.INSTANCE == null) return;
    Vec3d eye = listener.getTransform().position();
    double dx = gameharness$x - eye.x, dy = gameharness$y - eye.y, dz = gameharness$z - eye.z;
    if (gameharness$linear
        && (!(gameharness$cutoff > 0)
            || dx * dx + dy * dy + dz * dz >= gameharness$cutoff * gameharness$cutoff)) return;
    NativeClient.INSTANCE.soundDelivered(category, dx, dy, dz, System.currentTimeMillis());
  }
}
