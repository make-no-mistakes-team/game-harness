package io.gameharness.pilot;

import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.block.LeavesBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** Short ordinary jumps are evidence of a collision, not of a block's identity or location. */
final class PilotHeadroom {
    private static final double SHORT_RISE = 0.88;
    private static final double CLIPPED_RISE_MIN = 0.10;
    private static final double CLIPPED_RISE_MAX = 0.30;
    private static final double CLIPPED_DRIFT_SQUARED = 0.18 * 0.18;
    private static final double SAME_STANCE_SQUARED = 0.45 * 0.45;
    private static final int REPEAT_TICKS = 46;
    private static final int GLANCE_TICKS = 24;
    private static final int REPAIR_TICKS = 56;

    record Report(int shortJumps, int cleared, int bypasses, String reason) {}

    private final MinecraftClient client;
    private final PilotBody body;
    private Vec3d launch, lastShort, blockedAt, cutAim;
    private float launchYaw, lastShortYaw, blockedYaw;
    private int launchTick, lastShortTick, blockedTick, cutTick;
    private double peak, risingVelocity;
    private BlockPos cut;
    private boolean surveying, checkingFirstClip, attacked, broken;
    private Report report = new Report(0, 0, 0, "");

    PilotHeadroom(MinecraftClient client, PilotBody body) {
        this.client = client;
        this.body = body;
    }

    Report report() { return report; }

    void reset() {
        launch = lastShort = null;
        releaseStance();
    }

    void interruptAttempt() { launch = null; }

    private void releaseStance() {
        blockedAt = cutAim = null;
        cut = null;
        surveying = checkingFirstClip = attacked = broken = false;
    }

    void observe(int now, boolean ready) {
        var player = client.player;
        if (!ready || !dry(player) || player.isSprinting()) {
            launch = null;
            return;
        }
        Vec3d feet = player.getPos();
        if (player.isOnGround() && blockedAt != null && !sameStance(feet, blockedAt)) releaseStance();
        if (launch == null) return;
        int age = now - launchTick;
        double rise = feet.y - launch.y;
        peak = Math.max(peak, rise);
        double velocity = player.getVelocity().y;
        double drift = horizontalSquared(feet, launch);
        if (age > 5 || peak >= SHORT_RISE || rise < -0.05 || drift > 0.62 * 0.62) {
            launch = null;
        } else if (player.verticalCollision && !player.isOnGround() && velocity <= 0.04
                && (age == 1 || risingVelocity > 0.04)) {
            // An upward move can be clipped on its first tick, before we ever sample positive velocity.
            boolean repeated = lastShort != null && now - lastShortTick <= REPEAT_TICKS
                && sameStance(launch, lastShort) && bearingMatches(launchYaw, lastShortYaw);
            String height = Math.round(peak * 100) + " cm";
            report = new Report(report.shortJumps + 1, report.cleared, report.bypasses,
                "headroom: short upward collision at " + height);
            if (repeated) {
                start(now, launch, launchYaw, false, "checking the ceiling after repeated short jumps (" + height + ")");
            } else if (rise >= CLIPPED_RISE_MIN && peak <= CLIPPED_RISE_MAX && drift <= CLIPPED_DRIFT_SQUARED) {
                // Positive, sharply clipped upward travel at the launch stance warrants a look,
                // not an assumption about what stopped the jump.
                start(now, launch, launchYaw, true, "checking the ceiling after a clipped upward jump (" + height + ")");
            }
            lastShort = launch;
            lastShortYaw = launchYaw;
            lastShortTick = now;
            launch = null;
        } else if (player.isOnGround() || velocity <= 0) {
            // Ordinary descent, or a key press that vanilla did not turn into a jump.
            launch = null;
        } else {
            risingVelocity = velocity;
        }
    }

    /** Called only for a key press about to drive an ordinary grounded jump. */
    boolean veto(ClientPlayerEntity player, int now, float bearing, boolean inPlace) {
        if (blocked(player, inPlace ? Float.NaN : bearing)) return true;
        BlockHitResult visible = ceiling(player, bearing, false);
        if (visible != null) {
            start(now, player.getPos(), bearing, false, "checking a visible obstruction in the jump path");
            select(visible, now);
            return true;
        }
        launch = player.getPos();
        launchYaw = bearing;
        launchTick = now;
        peak = risingVelocity = 0;
        return false;
    }

    boolean blocked(ClientPlayerEntity player, float bearing) {
        return blockedAt != null && dry(player) && sameStance(player.getPos(), blockedAt)
            && (Float.isNaN(bearing) || bearingMatches(bearing, blockedYaw));
    }

    private void start(int now, Vec3d feet, float bearing, boolean firstClip, String why) {
        blockedAt = feet;
        blockedYaw = bearing;
        blockedTick = now;
        surveying = true;
        checkingFirstClip = firstClip;
        note(why);
    }

    boolean step(int now, PilotTools tools, Predicate<BlockPos> protectedBlock) {
        if (!surveying) return false;
        var player = client.player;
        if (!dry(player) || !blocked(player, Float.NaN)) {
            releaseStance();
            return false;
        }
        // Keep the interrupted route alive until the clipped jump settles. It would
        // otherwise interpret the still-blocked takeoff as a failed approach this tick.
        if (!player.isOnGround()) return true;
        if (body.hazardAhead(blockedYaw, 1.55)) return bypass("known lava near the blocked jump");
        if (cut == null) {
            int elapsed = now - blockedTick;
            if (elapsed > GLANCE_TICKS) {
                if (!checkingFirstClip) return bypass("no lit ceiling face in the jump path");
                releaseStance();
                note("headroom: no lit ceiling face after the first clipped jump");
                return false;
            }
            BlockHitResult visible = ceiling(player, blockedYaw, true);
            if (visible == null) {
                body.turn(blockedYaw, elapsed < 9 ? -28 : -64);
                return true;
            }
            select(visible, now);
        }
        if (now - cutTick > REPAIR_TICKS) return bypass("could not verify a cleared path");
        body.aim(cutAim);
        if (!body.aligned(cutAim)) return true;
        if (body.clearTerrain(cutAim)) {
            int cleared = report.cleared + (broken ? 1 : 0);
            report = new Report(report.shortJumps, cleared, report.bypasses, "headroom: verified the obstruction is gone");
            lastShort = null;
            releaseStance();
            return true;
        }
        BlockHitResult selected = body.selectedFace();
        if (selected == null || !selected.getBlockPos().equals(cut)) return true;
        Vec3d point = selected.getPos();
        BlockHitResult seen = body.perceive(point, player.getEyePos().distanceTo(point) + 0.09).orElse(null);
        if (seen == null || !seen.getBlockPos().equals(cut) || seen.getSide() != selected.getSide()) return true;
        BlockState state = client.world.getBlockState(seen.getBlockPos());
        if (!natural(state) || protectedBlock.test(cut) || !state.getFluidState().isEmpty()
                || state.getHardness(client.world, cut) < 0 || !tools.canHarvest(state))
            return bypass("visible obstruction is not safe to cut");
        if (fallingOrLavaAbove(player, seen)) return bypass("visible falling hazard or lava above the obstruction");
        if (!attacked) note("clearing visible " + cut.toShortString() + " with the best available tool");
        if (tools.readyFor(state)) {
            body.mine(cut);
            attacked = true;
        }
        return true;
    }

    void broken(BlockPos position) {
        if (attacked && position.equals(cut)) broken = true;
    }

    private void select(BlockHitResult visible, int now) {
        cut = visible.getBlockPos().toImmutable();
        cutAim = visible.getPos().lerp(Vec3d.ofCenter(cut), 0.12);
        cutTick = now;
    }

    private boolean bypass(String why) {
        surveying = attacked = broken = false;
        cut = null;
        cutAim = null;
        report = new Report(report.shortJumps, report.cleared, report.bypasses + 1, "headroom: " + why + "; choosing another stance");
        return false;
    }

    private void note(String why) {
        report = new Report(report.shortJumps, report.cleared, report.bypasses, "headroom: " + why);
    }

    private BlockHitResult ceiling(ClientPlayerEntity player, float bearing, boolean glancing) {
        if (!body.hasRecentView()) return null;
        Vec3d feet = player.getPos(), eye = player.getEyePos();
        double angle = Math.toRadians(bearing);
        double dx = -Math.sin(angle), dz = Math.cos(angle);
        double width = player.getWidth() * 0.5;
        double roof = feet.y + player.getHeight() + SHORT_RISE;
        for (int row = 0; row < (glancing ? 3 : 2); row++) {
            double distance = 0.30 + row * 0.29;
            for (int i = 0; i < 3; i++) {
                double side = (i == 0 ? 0 : i == 1 ? -width : width);
                Vec3d point = new Vec3d(feet.x + dx * distance + dz * side, roof, feet.z + dz * distance - dx * side);
                BlockHitResult hit = body.terrain(point, eye.distanceTo(point) + 0.10).orElse(null);
                if (hit == null || hit.getSide() == Direction.UP || hit.getBlockPos().getY() <= MathHelper.floor(feet.y) + 1
                        || hit.getPos().y < feet.y + player.getHeight() - 0.04 || hit.getPos().y > roof + 0.04) continue;
                double x = hit.getPos().x - feet.x, z = hit.getPos().z - feet.z;
                double ahead = x * dx + z * dz;
                if (ahead >= -width && ahead <= distance + 0.06 && Math.abs(x * dz - z * dx) <= width + 0.04) return hit;
            }
        }
        return null;
    }

    private boolean fallingOrLavaAbove(ClientPlayerEntity player, BlockHitResult face) {
        Direction side = face.getSide();
        Vec3d edge = face.getPos().add(side.getOffsetX() * 0.08, 0, side.getOffsetZ() * 0.08);
        Vec3d above = new Vec3d(edge.x, cut.getY() + 1.36, edge.z);
        BlockHitResult visible = body.perceive(above, player.getEyePos().distanceTo(above) + 0.06).orElse(null);
        if (visible == null || visible.getBlockPos().getY() <= cut.getY()) return false;
        BlockState state = client.world.getBlockState(visible.getBlockPos());
        return state.getBlock() instanceof FallingBlock || state.isOf(Blocks.POINTED_DRIPSTONE)
            || state.getFluidState().isIn(FluidTags.LAVA);
    }

    private static boolean natural(BlockState state) {
        return state.isIn(BlockTags.LEAVES) && state.contains(LeavesBlock.PERSISTENT) && !state.get(LeavesBlock.PERSISTENT)
            || state.isOf(Blocks.DIRT) || state.isOf(Blocks.GRASS_BLOCK) || state.isOf(Blocks.ROOTED_DIRT)
            || state.isOf(Blocks.COARSE_DIRT) || state.isOf(Blocks.STONE) || state.isOf(Blocks.DEEPSLATE)
            || state.isOf(Blocks.TUFF) || state.isOf(Blocks.GRANITE) || state.isOf(Blocks.DIORITE) || state.isOf(Blocks.ANDESITE);
    }

    private static boolean dry(ClientPlayerEntity player) {
        return player != null && !player.isTouchingWater() && !player.isInLava() && !player.hasVehicle();
    }

    private static boolean sameStance(Vec3d a, Vec3d b) {
        return Math.abs(a.y - b.y) <= 0.32 && horizontalSquared(a, b) <= SAME_STANCE_SQUARED;
    }

    private static double horizontalSquared(Vec3d a, Vec3d b) {
        double dx = a.x - b.x, dz = a.z - b.z;
        return dx * dx + dz * dz;
    }

    private static boolean bearingMatches(float a, float b) {
        return Math.abs(MathHelper.wrapDegrees(a - b)) <= 40;
    }
}
