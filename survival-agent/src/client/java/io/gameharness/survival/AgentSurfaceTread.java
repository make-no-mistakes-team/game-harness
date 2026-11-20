package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** One verified cardinal dry tread, shared by ground travel and reversal of that exact edge. */
final class AgentSurfaceTread {
    private static final int PROOF_TICKS = 65;
    private static final int DRIVE_TICKS = 54;
    // Includes the successful boundary ticks and a fresh post-landing frame.
    static final int ACTION_TICKS = PROOF_TICKS + DRIVE_TICKS + 4;
    record Edge(BlockPos upper, BlockState upperSupport, BlockPos lower, BlockState lowerSupport, Direction down) {}
    enum Result { CHECKING, MOVING, LANDED, REFUSED }

    final Edge edge;
    final boolean returning;
    final BlockPos from, to;
    private final Direction travel;
    private final Vec3d floorAim, nearFloorAim, chestAim;
    private final long started;
    private long drivingSince = -1;
    private boolean floorSeen;

    AgentSurfaceTread(Edge edge, boolean returning, long started) {
        this.edge = edge;
        this.returning = returning;
        this.started = started;
        from = returning ? edge.lower : edge.upper;
        to = returning ? edge.upper : edge.lower;
        travel = returning ? edge.down.getOpposite() : edge.down;
        Vec3d center = Vec3d.ofBottomCenter(to);
        floorAim = center.add(0.28 * travel.getOffsetX(), -0.032, 0.28 * travel.getOffsetZ());
        nearFloorAim = center.add(-0.22 * travel.getOffsetX(), -0.032, -0.22 * travel.getOffsetZ());
        chestAim = center.add(0.07 * travel.getOffsetX(), 1.32, 0.07 * travel.getOffsetZ());
    }

    static BlockPos nextFoot(BlockPos foot, Direction down) {
        return foot.offset(down).down();
    }

    static long returnTicks(int edges) { return (long) edges * ACTION_TICKS; }

    static boolean canExtend(long ticksLeft, int retainedEdges) {
        return ticksLeft > ACTION_TICKS + returnTicks(retainedEdges + 1);
    }

    static boolean plannedCell(BlockPos foot, BlockPos cell, Direction down, Direction face) {
        if (down == null || !down.getAxis().isHorizontal()) return false;
        BlockPos next = nextFoot(foot, down);
        return cell.equals(next.up()) && face == down.getOpposite() || cell.equals(next) && face == Direction.UP;
    }

    static boolean returnLip(BlockPos foot, BlockPos cell, Direction down, Direction face) {
        return down != null && down.getAxis().isHorizontal() && face == down.getOpposite()
            && cell.equals(nextFoot(foot, down).up(2));
    }

    /** The exact two-column clearance envelope of a descending tread and its reverse jump. */
    static boolean prospectCell(BlockPos foot, BlockPos cell, Direction down) {
        if (down == null || !down.getAxis().isHorizontal()) return false;
        int dy = cell.getY() - foot.getY();
        return cell.equals(foot.up(2)) || dy >= -1 && dy <= 2 && cell.equals(foot.offset(down).up(dy));
    }

    /** A level leg can cut only its next foot and head cell, never a floor or ceiling. */
    static boolean prospectLevelCell(BlockPos foot, BlockPos cell, Direction travel) {
        return travel.getAxis().isHorizontal() && (cell.getY() == foot.getY() || cell.getY() == foot.getY() + 1)
            && cell.equals(foot.offset(travel).up(cell.getY() - foot.getY()));
    }

    static boolean cardinalTread(BlockPos from, BlockPos to, Direction travel) {
        return travel.getAxis().isHorizontal() && Math.abs(to.getY() - from.getY()) <= 1
            && to.getX() - from.getX() == travel.getOffsetX() && to.getZ() - from.getZ() == travel.getOffsetZ();
    }

    /** Aim just inside the opening: farther top samples can hit the near roof before crossing the lip. */
    static Vec3d innerTop(BlockPos cell, Direction down) {
        return Vec3d.ofBottomCenter(cell.up()).add(0.12 * down.getOffsetX(), -0.035, 0.12 * down.getOffsetZ());
    }

    Result step(MinecraftClient client, AgentBody body, long tick) {
        var player = client.player;
        var world = client.world;
        if (player.isTouchingWater() || player.isInLava() || player.isOnFire() || player.hasVehicle()
                || player.hurtTime != 0 || !cardinalTread(edge.upper, edge.lower, edge.down)
                || world.getBlockState(edge.upper.down()) != edge.upperSupport
                || world.getBlockState(edge.lower.down()) != edge.lowerSupport) return Result.REFUSED;
        if (!body.hasRecentView()) return drivingSince < 0 ? Result.CHECKING : Result.MOVING;
        if (drivingSince < 0) {
            if (tick - started > PROOF_TICKS || !player.isOnGround() || !player.getBlockPos().equals(from)) return Result.REFUSED;
            if (!centered(player.getPos(), from, 0.17)) {
                body.centerOnSupport(from.down());
                return Result.CHECKING;
            }
            if (player.getVelocity().horizontalLengthSquared() > 0.0025) return Result.CHECKING;
            if (!floorSeen) {
                if (body.dryRouteFloor(floorAim, to.down()) == null && body.dryRouteFloor(nearFloorAim, to.down()) == null) {
                    body.aim(floorAim);
                    return Result.CHECKING;
                }
                floorSeen = true;
            }
            if (body.dryRouteClear(chestAim) != AgentBody.DryRouteSample.CLEAR) {
                body.aim(chestAim);
                return Result.CHECKING;
            }
            if (!reverseClear(client, edge.upper, edge.lower, edge.down) || !body.dryRouteSweep(from, to)) return Result.REFUSED;
            drivingSince = tick;
        }
        if (player.isOnGround() && player.getBlockPos().equals(to) && centered(player.getPos(), to, 0.23)
                && Math.abs(player.getY() - to.getY()) <= 0.055
                && player.getVelocity().horizontalLengthSquared() <= 0.0025) return Result.LANDED;
        if (tick - drivingSince > DRIVE_TICKS || player.getY() < Math.min(from.getY(), to.getY()) - 0.055) return Result.REFUSED;
        if (!reverseClear(client, edge.upper, edge.lower, edge.down) || !body.dryRouteSweep(from, to))
            return tick - drivingSince < 5 ? Result.CHECKING : Result.REFUSED;
        body.driveDryRoute(from, to, travel);
        return Result.MOVING;
    }

    /** Veto only on the two positively identified columns; never use collision to discover a tread. */
    static boolean reverseClear(MinecraftClient client, BlockPos upper, BlockPos lower, Direction travel) {
        boolean level = upper.getY() == lower.getY();
        for (int i = 0; i <= (level ? 1 : 2); ++i) {
            if (!client.world.getBlockState(lower.up(i)).getFluidState().isEmpty()
                    || !client.world.getBlockState(upper.up(i)).getFluidState().isEmpty()) return false;
        }
        if (level) return true; // The same two-block-high sweep serves both walking directions.
        double half = client.player.getWidth() * 0.5 + 0.055;
        double x = upper.getX() + 0.5, y = Math.max(upper.getY(), lower.getY()), z = upper.getZ() + 0.5;
        Box jumpHeadroom = new Box(x - half, y + 1.79, z - half, x + half, y + 2.08, z + half);
        return client.world.isSpaceEmpty(client.player, jumpHeadroom.stretch(travel.getOffsetX(), 0, travel.getOffsetZ()));
    }

    private static boolean centered(Vec3d position, BlockPos foot, double tolerance) {
        return Math.abs(position.x - foot.getX() - 0.5) <= tolerance && Math.abs(position.z - foot.getZ() - 0.5) <= tolerance;
    }
}
