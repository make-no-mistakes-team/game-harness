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
    record MeleeCue(float yaw, long heardAt, boolean near) {}

    enum ZombieCue {
        GROAN("checking a nearby zombie groan"),
        HURT("checking a nearby zombie hurt sound");

        final String status;

        ZombieCue(String status) { this.status = status; }
    }

    private final MinecraftClient client;
    private final Supplier<Screen> renderedScreen;
    private final AgentFuseEscape fuseEscape = new AgentFuseEscape();
    private int escapeTicks;
    private boolean newFuse;
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
    private MeleeCue meleeCue;

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
        boolean melee = escapeTicks == 0 && (cue != null || id.equals("entity.husk.ambient")
            || id.equals("entity.husk.hurt") || id.equals("entity.spider.ambient"));
        if (!fuse && !explosion && !shot && !melee) return;
        var ear = client.getSoundManager().getListenerTransform().position();
        double dx = ear.x - sound.getX(), dy = ear.y - sound.getY(), dz = ear.z - sound.getZ();
        double audible = Math.min(fuse ? 12 : explosion ? 32 : shot ? 14 : 6, range);
        double distance = dx * dx + dy * dy + dz * dz;
        if (distance >= audible * audible) return;
        if (fuse) {
            if (fuseCue == null) {
                fuseCue = soundCue(sound);
                lastFuseNs = fuseCue.monotonicNs();
            }
            away = coarseBearing(dx, dz);
            escapeTicks = 36;
            newFuse = true;
            zombieCue = null;
            rangedCue = null;
            meleeCue = null;
        } else if (explosion) {
            if (explosionCue == null) explosionCue = soundCue(sound);
        } else if (shot) {
            double horizontal = Math.hypot(dx, dz);
            float bearing = horizontal >= 0.30 ? coarseBearing(-dx, -dz) : client.player.getYaw();
            float pitch = 15f * Math.round((float) Math.toDegrees(Math.atan2(dy, horizontal)) / 15f);
            rangedCue = new RangedCue(bearing, MathHelper.clamp(pitch, -70, 70), System.nanoTime());
        } else if (dx * dx + dz * dz >= 0.09) {
            float bearing = coarseBearing(-dx, -dz);
            long heard = System.nanoTime();
            meleeCue = new MeleeCue(bearing, heard, distance <= 4.5 * 4.5);
            if (cue != null && client.currentScreen == null && AgentDefense.criticallyHurt(client.player)) {
                towardZombie = bearing;
                zombieHeardAt = heard;
                zombieCue = cue;
            }
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

    MeleeCue recentMeleeCue() {
        MeleeCue cue = meleeCue;
        return cue != null && client.options.getShowSubtitles().getValue()
            && System.nanoTime() - cue.heardAt() <= 3_000_000_000L ? cue : null;
    }

    RangedCue takeFreshRangedCue() {
        RangedCue cue = rangedCue;
        rangedCue = null;
        return cue != null && client.options.getShowSubtitles().getValue()
            && System.nanoTime() - cue.heardAt() <= FRESH_SHOT_NANOS ? cue : null;
    }

    boolean interruptForFuse(AgentHands hands) {
        if (escapeTicks <= 0) return false;
        --escapeTicks;
        hands.cancel();
        if (client.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?> screen) screen.close();
        return true;
    }

    void escape(AgentBody body) {
        if (newFuse) {
            newFuse = false;
            fuseEscape.start(away);
            body.pauseWork();
        }
        body.prioritizeMovement();
        var player = client.player;
        Vec3d feet = player.getPos();
        Vec3d walked = body.recentEmergencyFooting();
        double dx = walked == null ? 0 : walked.x - feet.x, dz = walked == null ? 0 : walked.z - feet.z;
        float walkedBearing = walked != null && Math.abs(feet.y - walked.y) <= 0.055 && dx * dx + dz * dz >= 0.04
            ? (float) Math.toDegrees(Math.atan2(-dx, dz)) : Float.NaN;
        boolean lava = body.lavaEmergency();
        var action = fuseEscape.step(feet, body.fuseViewYaw(), body.fuseViewPitch(),
            player.isOnGround() && !lava, body.appliedEmergencyForward() && player.hurtTime == 0 && !lava,
            explosionCue != null && explosionCue.monotonicNs() >= lastFuseNs, body, walkedBearing);
        if (lava) return; // The separate lava egress remains the final motor owner.
        switch (action) {
            case ALIGN -> body.turnUrgent(fuseEscape.bearing(), AgentFuseEscape.PITCH);
            case DRIVE -> body.driveFuseLane(fuseEscape.landing(), fuseEscape.bearing());
            case BRACE -> body.braceForFuse(away + 180);
        }
    }

    boolean advancedOnFuse() { return fuseEscape.advanced(); }
    String fuseStatus() { return fuseEscape.status(); }
}
