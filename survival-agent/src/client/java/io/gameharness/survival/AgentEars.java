package io.gameharness.survival;

import java.util.function.Supplier;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.sound.SoundInstance;
import net.minecraft.client.sound.SoundInstanceListener;
import net.minecraft.client.sound.WeightedSoundSet;
import net.minecraft.sound.SoundCategory;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** The same cue stream as vanilla's subtitles, reduced to coarse bearings. */
final class AgentEars implements SoundInstanceListener {
    private static final long FRESH_ZOMBIE_NANOS = 900_000_000L;
    private static final long FRESH_SHOT_NANOS = 700_000_000L;

    record RangedCue(float yaw, float pitch, long heardAt) {}

    enum ZombieCue {
        GROAN("checking a nearby zombie groan"),
        HURT("checking a nearby zombie hurt sound");

        final String status;

        ZombieCue(String status) { this.status = status; }
    }

    private final MinecraftClient client;
    private final Supplier<Screen> renderedScreen;
    private int escapeTicks;
    private float away;
    record SoundCue(long wallMs, long monotonicNs, Vec3d origin, Vec3d player, float health,
                    Screen screen, boolean shown) {}
    private SoundCue fuseCue;
    private SoundCue explosionCue;
    private long lastFuseNs;
    private ZombieCue zombieCue;
    private long zombieHeardAt;
    private float towardZombie;
    private RangedCue rangedCue;

    AgentEars(MinecraftClient client, Supplier<Screen> renderedScreen) {
        this.client = client;
        this.renderedScreen = renderedScreen;
    }

    @Override public void onSoundPlayed(SoundInstance sound, WeightedSoundSet sounds, float range) {
        if (client.player == null || sound.isRelative() || !sound.getId().getNamespace().equals("minecraft")) return;
        String id = sound.getId().getPath();
        boolean fuse = id.equals("entity.creeper.primed");
        boolean explosion = id.equals("entity.generic.explode") && lastFuseNs != 0
            && System.nanoTime() - lastFuseNs < 4_000_000_000L;
        boolean subtitled = sounds.getSubtitle() != null && client.options.getShowSubtitles().getValue();
        if (!subtitled && (!(fuse || explosion) || sound.getVolume() <= 0
                || client.options.getSoundVolume(SoundCategory.MASTER) <= 0
                || client.options.getSoundVolume(sound.getCategory()) <= 0)) return;
        boolean shot = id.equals("entity.skeleton.shoot") && escapeTicks == 0;
        ZombieCue cue = switch (id) {
            case "entity.zombie.ambient" -> ZombieCue.GROAN;
            case "entity.zombie.hurt" -> ZombieCue.HURT;
            default -> null; // In particular, zombie steps share the generic Footsteps subtitle.
        };
        if (!fuse && !explosion && !shot && (cue == null || escapeTicks > 0 || client.currentScreen != null
                || !AgentDefense.criticallyHurt(client.player))) return;
        var ear = client.getSoundManager().getListenerTransform().position();
        double dx = ear.x - sound.getX(), dy = ear.y - sound.getY(), dz = ear.z - sound.getZ();
        double audible = Math.min(fuse ? 12 : explosion ? 32 : shot ? 14 : 6, range);
        if (dx * dx + dy * dy + dz * dz >= audible * audible) return;
        if (fuse) {
            if (fuseCue == null) {
                fuseCue = soundCue(sound);
                lastFuseNs = fuseCue.monotonicNs();
            }
            away = coarseBearing(dx, dz);
            escapeTicks = 36;
            zombieCue = null;
            rangedCue = null;
        } else if (explosion) {
            if (explosionCue == null) explosionCue = soundCue(sound);
        } else if (shot) {
            double horizontal = Math.hypot(dx, dz);
            float bearing = horizontal >= 0.30 ? coarseBearing(-dx, -dz) : client.player.getYaw();
            float pitch = 15f * Math.round((float) Math.toDegrees(Math.atan2(dy, horizontal)) / 15f);
            rangedCue = new RangedCue(bearing, MathHelper.clamp(pitch, -70, 70), System.nanoTime());
        } else if (dx * dx + dz * dz >= 0.09) {
            towardZombie = coarseBearing(-dx, -dz);
            zombieHeardAt = System.nanoTime();
            zombieCue = cue;
        }
    }

    private SoundCue soundCue(SoundInstance sound) {
        long wallMs = System.currentTimeMillis(), monotonicNs = System.nanoTime();
        Screen screen = client.currentScreen;
        return new SoundCue(wallMs, monotonicNs,
            new Vec3d(sound.getX(), sound.getY(), sound.getZ()), client.player.getPos(),
            client.player.getHealth(), screen, screen != null && screen == renderedScreen.get());
    }

    SoundCue takeFuseCue() {
        SoundCue cue = fuseCue;
        fuseCue = null;
        return cue;
    }

    SoundCue takeExplosionCue() {
        SoundCue cue = explosionCue;
        explosionCue = null;
        return cue;
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

    RangedCue takeFreshRangedCue() {
        RangedCue cue = rangedCue;
        rangedCue = null;
        return cue != null && client.options.getShowSubtitles().getValue()
            && System.nanoTime() - cue.heardAt() <= FRESH_SHOT_NANOS ? cue : null;
    }

    boolean escape(AgentBody body, AgentHands hands) {
        if (escapeTicks <= 0) return false;
        --escapeTicks;
        hands.cancel();
        if (client.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?> screen) screen.close();
        body.turnUrgent(away, 5f);
        if (Math.abs(MathHelper.wrapDegrees(away - client.player.getYaw())) < 68) body.walk(true);
        else body.back();
        return true;
    }
}
