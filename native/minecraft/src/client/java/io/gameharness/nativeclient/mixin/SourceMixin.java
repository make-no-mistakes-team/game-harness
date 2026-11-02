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
  @Unique private String gameharness$streamId;
  @Unique private SoundListener gameharness$listener;
  @Unique private double gameharness$x, gameharness$y, gameharness$z;
  @Unique private float gameharness$gain, gameharness$cutoff;
  @Unique private boolean gameharness$relative, gameharness$linear, gameharness$positioned;

  public void gameharness$tag(String streamId, int kind, SoundListener listener) {
    gameharness$streamId = streamId;
    gameharness$listener = listener;
    gameharness$positioned = false;
    gameharness$category = kind;
  }

  @Inject(method = "setPosition", at = @At("TAIL"))
  private void position(Vec3d p, CallbackInfo ci) {
    if (gameharness$category < 0) return;
    gameharness$x = p.x;
    gameharness$y = p.y;
    gameharness$z = p.z;
    gameharness$positioned = true;
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
    gameharness$streamId = null;
    gameharness$listener = null;
    gameharness$x = gameharness$y = gameharness$z = 0;
    gameharness$positioned = false;
  }

  @Inject(method = "play", at = @At("RETURN"))
  private void delivered(CallbackInfo ci) {
    int kind = gameharness$category;
    gameharness$category = -1;
    String streamId = gameharness$streamId;
    gameharness$streamId = null;
    SoundListener listener = gameharness$listener;
    gameharness$listener = null;
    double x = gameharness$x, y = gameharness$y, z = gameharness$z;
    gameharness$x = gameharness$y = gameharness$z = 0;
    boolean positioned = gameharness$positioned;
    gameharness$positioned = false;
    NativeClient client = NativeClient.INSTANCE;
    if (kind < 0 || streamId == null || listener == null || client == null || !positioned) return;
    Vec3d eye = listener.getTransform().position();
    double dx = x - eye.x, dy = y - eye.y, dz = z - eye.z;
    if (!SoundProjection.audible(
        ((Source) (Object) this).isPlaying(), gameharness$gain, listener.getVolume(),
        gameharness$relative, gameharness$linear, gameharness$cutoff, dx, dy, dz)) return;
    long nativeNanos = System.nanoTime();
    client.soundDelivered(streamId, kind, dx, dy, dz, System.currentTimeMillis(), nativeNanos);
  }
}
