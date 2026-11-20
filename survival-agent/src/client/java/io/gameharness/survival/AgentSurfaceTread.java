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
    private final Vec3d center, floorAim, nearFloorAim, chestAim, headAim;
    private final BlockPos sourceSupport, landingSupport;
    private final boolean isolated;
    private final AgentWalkedRoute.Motion motion = new AgentWalkedRoute.Motion();
    private final long started;
    private long drivingSince = -1;
    private boolean floorSeen, chestSeen;

    AgentSurfaceTread(Edge edge, boolean returning, long started) {
        this(edge, returning, started, false);
    }

    private AgentSurfaceTread(Edge edge, boolean returning, long started, boolean isolated) {
        this.edge = edge;
        this.returning = returning;
        this.started = started;
        this.isolated = isolated;
        from = returning ? edge.lower : edge.upper;
        to = returning ? edge.upper : edge.lower;
        travel = returning ? edge.down.getOpposite() : edge.down;
        sourceSupport = from.down();
        landingSupport = to.down();
        center = Vec3d.ofBottomCenter(to);
        floorAim = center.add(0.28 * travel.getOffsetX(), -0.032, 0.28 * travel.getOffsetZ());
        nearFloorAim = center.add(-0.22 * travel.getOffsetX(), -0.032, -0.22 * travel.getOffsetZ());
        chestAim = center.add(0.07 * travel.getOffsetX(), 1.32, 0.07 * travel.getOffsetZ());
        headAim = isolated ? center.add(0.12 * travel.getOffsetX(), 1.76, 0.12 * travel.getOffsetZ()) : chestAim;
    }

    /** Build only from the next already walked edge; ordinary tread proof still precedes any input. */
    static AgentSurfaceTread recall(MinecraftClient client, BlockPos from, BlockPos to, long tick) {
        int dx = to.getX() - from.getX(), dz = to.getZ() - from.getZ();
        Direction travel = dx == 0 ? dz > 0 ? Direction.SOUTH : Direction.NORTH : dx > 0 ? Direction.EAST : Direction.WEST;
        if (client.options.forwardKey.isUnbound() || to.getY() > from.getY() && client.options.jumpKey.isUnbound()
                || !cardinalTread(from, to, travel)) return null;
        boolean up = to.getY() > from.getY();
        BlockPos upper = up ? to : from, lower = up ? from : to;
        var edge = new Edge(upper, client.world.getBlockState(upper.down()),
            lower, client.world.getBlockState(lower.down()), up ? travel.getOpposite() : travel);
        return new AgentSurfaceTread(edge, up, tick, true);
    }

    boolean inFlight() { return drivingSince >= 0; }

    boolean rememberedLaneChanged(MinecraftClient client, AgentBody body) {
        return !body.walkedLaneDry(from, to, travel) || !retainedLaneClear(client, from, to, travel)
            || client.world.getBlockState(sourceSupport) != (returning ? edge.lowerSupport : edge.upperSupport)
            || client.world.getBlockState(landingSupport) != (returning ? edge.upperSupport : edge.lowerSupport);
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

    /** A seen floor is expendable only while a different usable exit or a walked return survives. */
    static int spareLevelFloorChoices(int candidates, int usableExits, boolean walkedReturn) {
        if (walkedReturn || Integer.bitCount(usableExits) > 1) return candidates;
        return usableExits == 0 ? 0 : candidates & ~usableExits;
    }

    /** Recheck known terrain before cutting; this cannot supply a new route witness. */
    static boolean retainedLaneClear(MinecraftClient client, BlockPos from, BlockPos to, Direction travel) {
        if (!cardinalTread(from, to, travel) || !reverseClear(client, from, to, travel)) return false;
        if (from.getY() != to.getY()) {
            BlockPos lower = from.getY() < to.getY() ? from : to;
            if (!client.world.getBlockState(lower).getCollisionShape(client.world, lower).isEmpty()) return false;
        }
        return client.world.isSpaceEmpty(client.player, retainedTreadSweep(from, to, client.player.getWidth()));
    }

    static Box retainedTreadSweep(BlockPos from, BlockPos to, double width) {
        double half = width * 0.5 + 0.055;
        double y = Math.max(from.getY(), to.getY());
        return new Box(Math.min(from.getX(), to.getX()) + 0.5 - half, y + 0.015,
            Math.min(from.getZ(), to.getZ()) + 0.5 - half, Math.max(from.getX(), to.getX()) + 0.5 + half,
            y + 1.80, Math.max(from.getZ(), to.getZ()) + 0.5 + half);
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
                || world.getBlockState(sourceSupport) != (returning ? edge.lowerSupport : edge.upperSupport)
                || world.getBlockState(landingSupport) != (returning ? edge.upperSupport : edge.lowerSupport)
                || isolated && !body.walkedLaneDry(from, to, travel)) return Result.REFUSED;
        if (drivingSince >= 0 && !motion.observe(player.getX(), player.getY(), player.getZ())) return Result.REFUSED;
        if (drivingSince < 0 ? tick - started > PROOF_TICKS : tick - drivingSince > DRIVE_TICKS) return Result.REFUSED;
        if (!body.hasRecentView()) return drivingSince < 0 ? Result.CHECKING : Result.MOVING;
        if (isolated && !body.macroNoVisiblePickup(center, Math.min(from.getY(), to.getY()),
                Math.max(from.getY(), to.getY()) + 0.32)) return Result.REFUSED;
        if (drivingSince < 0) {
            if (!player.isOnGround() || !player.getBlockPos().equals(from)) return Result.REFUSED;
            if (!centered(player.getPos(), from, 0.17)) {
                body.centerOnSupport(sourceSupport);
                return Result.CHECKING;
            }
            if (player.getVelocity().horizontalLengthSquared() > 0.0025) return Result.CHECKING;
            if (!floorSeen) {
                if (body.dryRouteFloor(floorAim, landingSupport) == null && body.dryRouteFloor(nearFloorAim, landingSupport) == null) {
                    body.aim(floorAim);
                    return Result.CHECKING;
                }
                floorSeen = true;
            }
            if (!chestSeen && body.dryRouteClear(chestAim) != AgentBody.DryRouteSample.CLEAR) {
                body.aim(chestAim);
                return Result.CHECKING;
            }
            chestSeen = true;
            if (isolated && body.dryRouteClear(headAim) != AgentBody.DryRouteSample.CLEAR) {
                body.aim(headAim);
                return Result.CHECKING;
            }
            if (!reverseClear(client, edge.upper, edge.lower, edge.down) || !body.dryRouteSweep(from, to)) return Result.REFUSED;
            drivingSince = tick;
            motion.start(player.getX(), player.getY(), player.getZ());
        }
        if (player.isOnGround() && player.getBlockPos().equals(to) && centered(player.getPos(), to, 0.23)
                && Math.abs(player.getY() - to.getY()) <= 0.055
                && player.getVelocity().horizontalLengthSquared() <= 0.0025)
            return motion.traversed() ? Result.LANDED : Result.REFUSED;
        if (player.getY() < Math.min(from.getY(), to.getY()) - 0.055) return Result.REFUSED;
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
