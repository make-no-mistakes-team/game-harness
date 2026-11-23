package io.gameharness.survival;

import net.minecraft.block.ShapeContext;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;

/** Geometry of one outlined supply-exit contact, without classifying hidden cells. */
final class AgentSupplyOutline {
    static final long MAX_FRAME_NANOS = 200_000_000L;
    private static final double MIN_PREFIX = 0.05, BEFORE_BACKSTOP = 0.06, LINE_ERROR = 0.065;

    private AgentSupplyOutline() {}

    static boolean admits(boolean drawn, int frameAge, long nanos, Vec3d renderedEye, Vec3d liveEye,
                          float yawError, float pitchError, BlockHitResult shown, BlockHitResult live, double reach) {
        return drawn && frameAge >= 0 && frameAge <= 1 && nanos >= 0 && nanos <= MAX_FRAME_NANOS
            && Math.abs(yawError) <= 3.5f && Math.abs(pitchError) <= 3.5f
            && renderedEye.squaredDistanceTo(liveEye) <= 0.20 * 0.20
            && matchesFace(shown, live) && withinReach(renderedEye, shown, reach) && withinReach(liveEye, live, reach);
    }

    static boolean matchesFace(BlockHitResult shown, BlockHitResult live) {
        return blockHit(shown) && blockHit(live) && shown.getSide() == live.getSide()
            && shown.getBlockPos().equals(live.getBlockPos());
    }

    private static boolean blockHit(BlockHitResult hit) {
        return hit != null && hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock();
    }

    private static boolean withinReach(Vec3d eye, BlockHitResult hit, double reach) {
        double distance = eye.squaredDistanceTo(hit.getPos());
        return Double.isFinite(reach) && reach > 0 && distance > MIN_PREFIX * MIN_PREFIX && distance <= reach * reach;
    }

    static boolean provesPrefix(Vec3d eye, Vec3d sample, BlockHitResult backstop, double reach) {
        if (!blockHit(backstop) || !withinReach(eye, backstop, reach)) return false;
        Vec3d end = backstop.getPos();
        double x = end.x - eye.x, y = end.y - eye.y, z = end.z - eye.z;
        double sx = sample.x - eye.x, sy = sample.y - eye.y, sz = sample.z - eye.z;
        double length = Math.sqrt(x * x + y * y + z * z);
        double along = (sx * x + sy * y + sz * z) / length;
        double offX = sx - x * along / length, offY = sy - y * along / length, offZ = sz - z * along / length;
        return along > MIN_PREFIX && along < length - BEFORE_BACKSTOP
            && offX * offX + offY * offY + offZ * offZ <= LINE_ERROR * LINE_ERROR;
    }

    /** Before reaching the anchor the actual line must cross the attachment cell's interior. */
    static boolean entersAttachment(Vec3d eye, BlockHitResult hit, BlockPos target) {
        if (!blockHit(hit)) return false;
        Vec3d surface = hit.getPos();
        double length = eye.distanceTo(surface);
        if (!(length > 0.26)) return false;
        double t = 0.20 / length;
        return inside(surface.x + (eye.x - surface.x) * t - target.getX())
            && inside(surface.y + (eye.y - surface.y) * t - target.getY())
            && inside(surface.z + (eye.z - surface.z) * t - target.getZ());
    }

    private static boolean inside(double coordinate) { return coordinate > 1e-5 && coordinate < 1 - 1e-5; }

    static boolean drySelectedFace(BlockView world, ShapeContext shape, Vec3d eye, BlockHitResult selected,
                                   double reach) {
        return blockHit(selected) && withinReach(eye, selected, reach)
            && dryCorridor(world, shape, eye, selected, selected.getPos(), reach, false);
    }

    static boolean dryPrefix(BlockView world, ShapeContext shape, Vec3d eye, BlockHitResult backstop,
                             Vec3d sample, double reach) {
        return provesPrefix(eye, sample, backstop, reach)
            && dryCorridor(world, shape, eye, backstop, sample, reach, true);
    }

    /**
     * Reproduce the first hit, now counting fluids and vetoing a closer collider.
     * A clearance point slightly off the actual pixel must still see the same backstop through that point.
     */
    private static boolean dryCorridor(BlockView world, ShapeContext shape, Vec3d eye, BlockHitResult selected,
                                       Vec3d through, double reach, boolean prefix) {
        Vec3d surface = selected.getPos();
        double distance = eye.distanceTo(surface);
        double dx = through.x - eye.x, dy = through.y - eye.y, dz = through.z - eye.z;
        double throughDistanceSq = dx * dx + dy * dy + dz * dz;
        double ratio = Math.min(reach, distance + 0.12) / Math.sqrt(throughDistanceSq);
        Vec3d end = eye.add(dx * ratio, dy * ratio, dz * ratio);
        BlockHitResult hit = world.raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.ANY, shape));
        if (!matchesFace(selected, hit) || surface.squaredDistanceTo(hit.getPos()) > 0.22 * 0.22
                || !world.getFluidState(hit.getBlockPos()).isEmpty()) return false;
        double hitDistanceSq = eye.squaredDistanceTo(hit.getPos());
        if (prefix && hitDistanceSq <= throughDistanceSq) return false;
        BlockHitResult solid = world.raycast(new RaycastContext(eye, hit.getPos(), RaycastContext.ShapeType.COLLIDER,
            RaycastContext.FluidHandling.ANY, shape));
        return solid.getType() == HitResult.Type.MISS || !solid.isInsideBlock()
            && eye.squaredDistanceTo(solid.getPos()) + 1e-5 >= hitDistanceSq;
    }
}
