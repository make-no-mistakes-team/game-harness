package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.block.FallingBlock;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** One adjacent downhill landing. Its swept volume and neutral coast confer no reverse edge. */
record AgentDryLanding(BlockPos source, BlockState upper, BlockHitResult top, BlockPos to, BlockState lower,
                       Direction bearing, Vec3d from, Vec3d center, float yaw) {
    static final int MAX_DROP = 2;
    private static final double EARLY_LIP_MARGIN = 0.035;
    private static final double STOP_MARGIN = 0.11;
    static final double STOPPING_END = 1.5 - STOP_MARGIN;
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

    static Vec3d caveTopAim(BlockPos source, Direction bearing, int drop) {
        return Vec3d.ofBottomCenter(source.offset(bearing).down(drop))
            .add(0.18 * bearing.getOffsetX(), -0.032, 0.18 * bearing.getOffsetZ());
    }

    /** Only the exact lit top reached by the look; collisions may veto it but never nominate it. */
    static boolean caveTop(BlockPos source, Direction bearing, int drop, BlockHitResult hit, BlockState shown) {
        return drop >= 1 && drop <= MAX_DROP && bearing.getAxis().isHorizontal()
            && AgentBody.matchesDryRouteTop(hit, source.offset(bearing).down(drop + 1))
            && !hit.isInsideBlock() && !(shown.getBlock() instanceof FallingBlock)
            && AgentBody.normalDryTraction(shown) && !AgentBody.dryCaveDanger(shown);
    }

    /** Supplies allow trying the drop, but do not attest to any route back. */
    static boolean escapeKit(int drop, int usablePickUses, int solidBlocks) {
        return drop >= 1 && drop <= MAX_DROP && (usablePickUses > 0 || solidBlocks >= drop);
    }

    boolean settled(Vec3d feet, BlockPos support, BlockState shown, double speedSquared, boolean safeGrounded) {
        return safeGrounded && speedSquared <= 0.0025 && to.down().equals(support) && lower == shown
            && Math.abs(feet.y - to.getY()) <= 0.055
            && feet.x >= to.getX() && feet.x < to.getX() + 1 && feet.z >= to.getZ() && feet.z < to.getZ() + 1;
    }

    static Box receivingSweep(BlockPos to, double lipY, Direction bearing, double width, double height) {
        double overhang = Math.max(0, width * 0.5 - 0.10);
        return new Box(to.getX() + 0.001, to.getY() + 0.001, to.getZ() + 0.001,
            to.getX() + 0.999, lipY + height + 0.025, to.getZ() + 0.999)
            .stretch(bearing.getOffsetX() * overhang, 0, bearing.getOffsetZ() * overhang);
    }

    /**
     * Check the next key plus neutral coast. Ground drag is the rounded-up
     * normal-support drag; assume air drag slightly before body contact can
     * end and for longer than a vanilla one- or two-block fall can last.
     */
    static boolean stoppingFits(BlockPos source, Direction bearing, Vec3d feet, Vec3d velocity,
                                double ax, double az, double radius) {
        return stoppingFits(source, bearing, feet, velocity, ax, az, radius, false);
    }

    boolean neutralCoastFits(Vec3d feet, Vec3d velocity, double radius) {
        return stoppingFits(source, bearing, feet, velocity, 0, 0, radius, true);
    }

    private static boolean stoppingFits(BlockPos source, Direction bearing, Vec3d feet, Vec3d velocity,
                                        double ax, double az, double radius, boolean airborne) {
        int dx = bearing.getOffsetX(), dz = bearing.getOffsetZ();
        double x = feet.x - source.getX() - 0.5, z = feet.z - source.getZ() - 0.5;
        double vx = velocity.x + ax, vz = velocity.z + az;
        int air = airborne ? 1 : 0;
        for (int i = 0; i < 22; ++i) {
            x += vx;
            z += vz;
            double along = dx * x + dz * z;
            double across = Math.abs(dz * x - dx * z);
            if (along < -0.42 || along > STOPPING_END || across > 0.46) return false;
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
