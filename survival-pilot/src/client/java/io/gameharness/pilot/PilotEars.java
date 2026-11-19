package io.gameharness.pilot;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.sound.SoundInstance;
import net.minecraft.client.sound.SoundInstanceListener;
import net.minecraft.client.sound.WeightedSoundSet;
import net.minecraft.util.math.MathHelper;

/** The same cue stream as vanilla's subtitles. Retain only a coarse escape bearing. */
final class PilotEars implements SoundInstanceListener {
    private final MinecraftClient client;
    private int escapeTicks;
    private float away;

    PilotEars(MinecraftClient client) { this.client = client; }

    @Override public void onSoundPlayed(SoundInstance sound, WeightedSoundSet sounds, float range) {
        if (client.player == null || !sound.getId().getPath().equals("entity.creeper.primed") ||
            sounds.getSubtitle() == null || !client.options.getShowSubtitles().getValue()) return;
        var ear = client.getSoundManager().getListenerTransform().position();
        double dx = ear.x - sound.getX(), dy = ear.y - sound.getY(), dz = ear.z - sound.getZ();
        double audible = Math.min(12, range);
        if (dx * dx + dy * dy + dz * dz >= audible * audible) return;
        away = 45f * Math.round((float) Math.toDegrees(Math.atan2(-dx, dz)) / 45f);
        escapeTicks = 36;
    }

    boolean escape(PilotBody body, PilotHands hands) {
        if (escapeTicks <= 0) return false;
        --escapeTicks;
        hands.cancel();
        if (client.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?> screen) screen.close();
        body.turn(away, 5f);
        if (Math.abs(MathHelper.wrapDegrees(away - client.player.getYaw())) < 68) body.walk(true);
        else body.back();
        return true;
    }
}
