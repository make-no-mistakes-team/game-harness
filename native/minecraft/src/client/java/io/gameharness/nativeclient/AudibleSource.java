package io.gameharness.nativeclient;

import net.minecraft.client.sound.SoundListener;

public interface AudibleSource {
  void gameharness$tag(String streamId, int kind, SoundListener listener);
}
