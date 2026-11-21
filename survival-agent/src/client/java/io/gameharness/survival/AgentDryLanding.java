package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** One adjacent downhill landing. Its swept volume and neutral coast confer no reverse edge. */
record AgentDryLanding(BlockPos source, BlockState upper, BlockHitResult top, BlockPos to, BlockState lower,
                       Direction bearing, Vec3d from, Vec3d center, float yaw) {
    static final int MAX_DROP = 2;
    private static final double EARLY_LIP_MARGIN = 0.035;
    private static final double STOP_MARGIN = 0.11;
    private static final double GROUND_DRAG = 0.55;
    private static final double AIR_DRAG = 0.91;
    private static final int AIR_TICKS = 10;

    int height() { return source.getY() - to().getY(); }

    static boolean shape(BlockPos from, BlockPos to, Direction bearing) {
        int drop = from.getY() - to.getY();
        return bearing.getAxis().isHorizontal() && drop >= 1 && drop <= MAX_DROP
            && to.getX() - from.getX() == bearing.getOffsetX() && to.getZ() - from.getZ() == bearing.getOffsetZ();
    }

    static Direction bearing(BlockPos from, BlockPos to) {
        return AgentSurfaceTread.prospectLevelBearing(from, to.withY(from.getY()));
    }

    /**
     * Check the next key plus neutral coast. Ground drag is the rounded-up
     * normal-support drag; assume air drag slightly before body contact can
     * end and for longer than a vanilla one- or two-block fall can last.
     */
    static boolean stoppingFits(BlockPos source, Direction bearing, Vec3d feet, Vec3d velocity,
                                double ax, double az, double radius) {
        int dx = bearing.getOffsetX(), dz = bearing.getOffsetZ();
        double x = feet.x - source.getX() - 0.5, z = feet.z - source.getZ() - 0.5;
        double vx = velocity.x + ax, vz = velocity.z + az;
        int air = 0;
        for (int i = 0; i < 22; ++i) {
            x += vx;
            z += vz;
            double along = dx * x + dz * z;
            double across = Math.abs(dz * x - dx * z);
            if (along < -0.42 || along > 1.5 - STOP_MARGIN || across > 0.46) return false;
            if (along >= 0.5 + radius - EARLY_LIP_MARGIN || air > 0) {
                if (across + radius > 0.49) return false;
                ++air;
            }
            // Vanilla samples grounded friction before moving off the lip.
            double drag = air > 1 && air <= AIR_TICKS + 1 ? AIR_DRAG : GROUND_DRAG;
            vx *= drag;
            vz *= drag;
            if (vx * vx + vz * vz < 0.000001) return true;
        }
        return true;
    }
}
