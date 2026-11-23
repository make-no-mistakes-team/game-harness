package io.gameharness.survival;

import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.block.FallingBlock;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** One adjacent downhill landing. Its swept volume and neutral coast confer no reverse edge. */
record AgentDryLanding(BlockPos source, BlockState upper, BlockHitResult top, BlockPos to, BlockState lower,
                       Direction bearing, Vec3d from, Vec3d center, float yaw, boolean ordinary) {
    static final int MAX_DROP = 2;
    private static final double EARLY_LIP_MARGIN = 0.035;
    private static final double STOP_MARGIN = 0.11;
    static final double STOPPING_END = 1.5 - STOP_MARGIN;
    private static final double GROUND_DRAG = 0.55;
    private static final double AIR_DRAG = 0.91;
    private static final int AIR_TICKS = 10;
    private static final double CAVE_SIDE_PAD = 0.015, CAVE_ALONG_PAD = 0.003, BOUNDARY = 1e-5;

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
        return caveTopAim(source, bearing, drop, false);
    }

    static Vec3d caveTopAim(BlockPos source, Direction bearing, int drop, boolean farther) {
        double inset = farther ? 0.37 : 0.18;
        return Vec3d.ofBottomCenter(source.offset(bearing).down(drop))
            .add(inset * bearing.getOffsetX(), -0.032, inset * bearing.getOffsetZ());
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

    enum CaveMotion { SOURCE, LANDING, RANGE, UPPER_COLLISION, LOWER_COLLISION, UPPER_HAZARD, LOWER_HAZARD }

    boolean overlapsLip(Vec3d feet, double radius) {
        return along(source, bearing, feet.x, feet.z) < 0.5 + radius;
    }

    private static double along(BlockPos source, Direction bearing, double x, double z) {
        return (x - source.getX() - 0.5) * bearing.getOffsetX() + (z - source.getZ() - 0.5) * bearing.getOffsetZ();
    }

    private static boolean inCaveLane(BlockPos source, Direction bearing, double x, double z, double radius,
                                      double stoppingEnd) {
        double distance = along(source, bearing, x, z);
        double across = (x - source.getX() - 0.5) * bearing.getOffsetZ() - (z - source.getZ() - 0.5) * bearing.getOffsetX();
        return distance >= -0.42 && distance <= stoppingEnd && Math.abs(across) + radius + CAVE_SIDE_PAD < 0.5;
    }

    /**
     * Follow normal vanilla ground/air drag and the two already proved flat tops. Extra
     * collisions and fluids may veto the trace, never change its prediction into a new route.
     * Only the first checked forward tick is issued; the rest is either a preview or neutral.
     */
    CaveMotion caveCoast(Vec3d feet, Vec3d velocity, double radius, double height, double gravity, boolean grounded,
                        int presses, double ax, double az, Predicate<Box> clear, Predicate<Box> dry) {
        return coast(source, to, bearing, feet, velocity, radius, height, gravity, grounded, presses,
            STOPPING_END, ax, az, clear, dry);
    }

    /** Ordinary traversal stops within its landing receipt band, without a blind follow-up key. */
    static CaveMotion ordinaryDescentCoast(BlockPos source, BlockPos to, Direction bearing, Vec3d feet, Vec3d velocity,
                                          double radius, double height, double gravity, boolean grounded,
                                          double ax, double az, Predicate<Box> clear, Predicate<Box> dry) {
        return coast(source, to, bearing, feet, velocity, radius, height, gravity, grounded, ax == 0 && az == 0 ? 0 : 1,
            1 + AgentBody.DRY_STRIDE_ARRIVAL, ax, az, clear, dry);
    }

    private static CaveMotion coast(BlockPos source, BlockPos to, Direction bearing, Vec3d feet, Vec3d velocity,
                                   double radius, double height, double gravity, boolean grounded, int presses,
                                   double stoppingEnd, double ax, double az, Predicate<Box> clear, Predicate<Box> dry) {
        double x = feet.x, y = feet.y, z = feet.z, lip = source.getY(), lower = to.getY();
        if (!inCaveLane(source, bearing, x, z, radius, stoppingEnd) || y < lower - BOUNDARY || y > lip + BOUNDARY
                || velocity.y > 0.003 || velocity.y < -0.65) return CaveMotion.RANGE;
        double vx = velocity.x, vy = velocity.y, vz = velocity.z;
        double rx = radius + (bearing.getAxis() == Direction.Axis.X ? CAVE_ALONG_PAD : CAVE_SIDE_PAD);
        double rz = radius + (bearing.getAxis() == Direction.Axis.Z ? CAVE_ALONG_PAD : CAVE_SIDE_PAD);
        for (int i = 0; i < 32; ++i) {
            vx = Math.abs(vx) < 0.003 ? 0 : vx;
            vz = Math.abs(vz) < 0.003 ? 0 : vz;
            double along = along(source, bearing, x, z);
            if (i < presses && grounded && y >= lip - BOUNDARY && along < 0.5 + radius) {
                vx += ax;
                vz += az;
            }
            double topY = y >= lip - BOUNDARY && along < 0.5 + radius ? lip : lower;
            // Vanilla moves vertically before horizontally, and samples drag before moving.
            double freeY = y + Math.min(0, vy), nextY = Math.max(topY, freeY);
            double nextX = x + vx, nextZ = z + vz;
            if (!inCaveLane(source, bearing, nextX, nextZ, radius, stoppingEnd)) return CaveMotion.RANGE;
            if (clear != null) {
                Box body = new Box(x - rx, nextY, z - rz, x + rx, nextY + height + CAVE_ALONG_PAD, z + rz);
                if (nextY != y) {
                    CaveMotion veto = caveVolume(body.stretch(0, y - nextY, 0), nextY >= lip - BOUNDARY, clear, dry);
                    if (veto != null) return veto;
                }
                CaveMotion veto = caveVolume(body.stretch(vx, 0, vz), nextY >= lip - BOUNDARY, clear, dry);
                if (veto != null) return veto;
            }
            boolean floorContact = freeY < topY;
            if (i + 1 >= presses && vx == 0 && vz == 0) {
                if (nextY == lower && along >= 0.5) return CaveMotion.LANDING;
                if (nextY == lip && along < 0.5 + radius) return CaveMotion.SOURCE;
            }
            double drag = grounded ? 0.6f * 0.91f : 0.91f;
            x = nextX;
            y = nextY;
            z = nextZ;
            vx *= drag;
            vz *= drag;
            vy = ((floorContact ? 0 : vy) - gravity) * 0.98f;
            grounded = floorContact;
        }
        return CaveMotion.RANGE;
    }

    private static CaveMotion caveVolume(Box box, boolean upper, Predicate<Box> clear, Predicate<Box> dry) {
        if (!dry.test(box)) return upper ? CaveMotion.UPPER_HAZARD : CaveMotion.LOWER_HAZARD;
        if (!clear.test(box)) return upper ? CaveMotion.UPPER_COLLISION : CaveMotion.LOWER_COLLISION;
        return null;
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
