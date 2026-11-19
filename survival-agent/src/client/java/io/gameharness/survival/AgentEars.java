package io.gameharness.survival;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.sound.SoundInstance;
import net.minecraft.client.sound.SoundInstanceListener;
import net.minecraft.client.sound.WeightedSoundSet;
import net.minecraft.util.math.MathHelper;

/** The same cue stream as vanilla's subtitles, reduced to coarse bearings. */
final class AgentEars implements SoundInstanceListener {
    private static final long FRESH_ZOMBIE_NANOS = 900_000_000L;

    enum ZombieCue {
        GROAN("checking a nearby zombie groan"),
        HURT("checking a nearby zombie hurt sound");

        final String status;

        ZombieCue(String status) { this.status = status; }
    }

    private final MinecraftClient client;
    private int escapeTicks;
    private float away;
    private ZombieCue zombieCue;
    private long zombieHeardAt;
    private float towardZombie;

    AgentEars(MinecraftClient client) { this.client = client; }

    @Override public void onSoundPlayed(SoundInstance sound, WeightedSoundSet sounds, float range) {
        if (client.player == null || sounds.getSubtitle() == null || !client.options.getShowSubtitles().getValue())
            return;
        String id = sound.getId().getPath();
        boolean fuse = id.equals("entity.creeper.primed");
        ZombieCue cue = switch (id) {
            case "entity.zombie.ambient" -> ZombieCue.GROAN;
            case "entity.zombie.hurt" -> ZombieCue.HURT;
            default -> null; // In particular, zombie steps share the generic Footsteps subtitle.
        };
        if (!fuse && (cue == null || escapeTicks > 0 || sound.isRelative()
                || !sound.getId().getNamespace().equals("minecraft") || client.currentScreen != null
                || !AgentDefense.criticallyHurt(client.player))) return;
        var ear = client.getSoundManager().getListenerTransform().position();
        double dx = ear.x - sound.getX(), dy = ear.y - sound.getY(), dz = ear.z - sound.getZ();
        double audible = Math.min(fuse ? 12 : 6, range);
        if (dx * dx + dy * dy + dz * dz >= audible * audible) return;
        if (fuse) {
            away = coarseBearing(dx, dz);
            escapeTicks = 36;
            zombieCue = null;
        } else if (dx * dx + dz * dz >= 0.09) {
            towardZombie = coarseBearing(-dx, -dz);
            zombieHeardAt = System.nanoTime();
            zombieCue = cue;
        }
    }

    private static float coarseBearing(double dx, double dz) {
        return 45f * Math.round((float) Math.toDegrees(Math.atan2(-dx, dz)) / 45f);
    }

    ZombieCue takeFreshZombieCue() {
        ZombieCue cue = zombieCue;
        zombieCue = null;
        return cue != null && client.options.getShowSubtitles().getValue()
            && System.nanoTime() - zombieHeardAt <= FRESH_ZOMBIE_NANOS ? cue : null;
    }

    float zombieBearing() { return towardZombie; }

    boolean escape(AgentBody body, AgentHands hands) {
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
