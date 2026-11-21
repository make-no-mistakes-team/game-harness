package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** A small shift on the top already supporting the body, not an edge crossing. */
record AgentGroundVantage(BlockPos support, BlockState state, Vec3d from, Vec3d goal, int sector) {
    static final double MIN_MOVE = 0.18;
    static final double ARRIVAL = 0.14;

    /** Eight physical endpoint sectors, unaffected by camera turns or opaque offer IDs. */
    static int sector(BlockPos support, Vec3d cue) {
        double dx = cue.x - support.getX() - 0.5, dz = cue.z - support.getZ() - 0.5;
        return Math.floorMod((int) Math.round(Math.atan2(dz, dx) * 4 / Math.PI), 8);
    }

    static Vec3d goal(BlockPos support, int sector, double radius) {
        double extent = 0.5 - radius - 0.064;
        if (extent <= 0) return null;
        double angle = sector * Math.PI / 4;
        double dx = Math.cos(angle), dz = Math.sin(angle);
        double scale = extent / Math.max(Math.abs(dx), Math.abs(dz));
        return new Vec3d(support.getX() + 0.5 + dx * scale, support.getY() + 1, support.getZ() + 0.5 + dz * scale);
    }

    static boolean useful(Vec3d from, Vec3d goal, Vec3d cue) {
        return squared(from, goal) >= (MIN_MOVE + 0.11) * (MIN_MOVE + 0.11)
            && squared(from, cue) - squared(goal, cue) >= 0.16;
    }

    static boolean reached(Vec3d from, Vec3d goal, Vec3d feet) {
        double dx = goal.x - from.x, dz = goal.z - from.z;
        double along = (dx * (feet.x - from.x) + dz * (feet.z - from.z)) / Math.hypot(dx, dz);
        return along >= MIN_MOVE && squared(feet, goal) <= ARRIVAL * ARRIVAL;
    }

    /** Entire stopping envelope within the known top, except pre-existing overhang while moving back inward. */
    static boolean keepsContact(BlockPos support, Vec3d from, Vec3d feet, Vec3d goal, Vec3d velocity, double radius) {
        double x = support.getX(), z = support.getZ();
        if (Math.abs(feet.y - support.getY() - 1) > 0.055 || feet.x < x || feet.x >= x + 1 || feet.z < z || feet.z >= z + 1)
            return false;
        double minX = x + radius, maxX = x + 1 - radius, minZ = z + radius, maxZ = z + 1 - radius;
        if (from.x < x || from.x >= x + 1 || from.z < z || from.z >= z + 1 || squared(from, goal) > 0.55 * 0.55)
            return false;
        // Neutral momentum is bounded by normal traction. An additional small
        // buffer covers the next slow input and tiny yaw corrections.
        double stopX = feet.x + velocity.x / (1 - 0.55), stopZ = feet.z + velocity.z / (1 - 0.55);
        return Math.min(feet.x, stopX) >= Math.min(from.x, minX) - 0.004
            && Math.max(feet.x, stopX) <= Math.max(from.x, maxX) + 0.004
            && Math.min(feet.z, stopZ) >= Math.min(from.z, minZ) - 0.004
            && Math.max(feet.z, stopZ) <= Math.max(from.z, maxZ) + 0.004
            && goal.x >= minX + 0.05 && goal.x <= maxX - 0.05
            && goal.z >= minZ + 0.05 && goal.z <= maxZ - 0.05;
    }

    static int clipHeight(int height) { return MathHelper.clamp(height, -3, 2) + 3; }

    private static double squared(Vec3d a, Vec3d b) {
        double dx = a.x - b.x, dz = a.z - b.z;
        return dx * dx + dz * dz;
    }
}
