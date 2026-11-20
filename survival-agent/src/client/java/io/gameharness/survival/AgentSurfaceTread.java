package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** One verified cardinal dry tread, shared by ground travel and reversal of that exact edge. */
final class AgentSurfaceTread {
    private static final int PROOF_TICKS = 65;
    private static final int DRIVE_TICKS = 54;
    static final int ORDINARY_GRADE_TICKS = DRIVE_TICKS + 2;
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
    private final boolean isolated, witnessedOutbound, ordinaryGrade;
    private final AgentDryCaveRoute.Probe levelProbe;
    private final AgentWalkedRoute.Motion motion = new AgentWalkedRoute.Motion();
    private final long started;
    private long drivingSince = -1;
    private boolean floorSeen, chestSeen, headSeen;
    private AgentSurfaceTread ahead;

    AgentSurfaceTread(Edge edge, boolean returning, long started) {
        this(edge, returning, started, false, false, false);
    }

    /** The ordinary prospect just re-witnessed this landing and both passage samples. */
    static AgentSurfaceTread witnessedOutbound(Edge edge, long tick) {
        return new AgentSurfaceTread(edge, false, tick, false, true, false);
    }

    static boolean ordinaryRiseSide(BlockPos from, Direction travel, BlockHitResult hit) {
        return hit != null && hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock()
            && travel.getAxis().isHorizontal() && hit.getSide() == travel.getOpposite()
            && hit.getBlockPos().equals(from.offset(travel));
    }

    /** The caller supplies a freshly lit, full stable top and a mechanically cleared sweep. */
    static Edge witnessedGradeEdge(BlockPos from, BlockState source, Direction travel, BlockHitResult hit,
                                   BlockState landing, boolean clearance) {
        if (!clearance || hit == null || hit.isInsideBlock() || source == null || landing == null
                || AgentBody.dryCaveDanger(source) || AgentBody.dryCaveDanger(landing)) return null;
        BlockPos floor = hit.getBlockPos(), to = floor.up();
        int grade = to.getY() - from.getY();
        if (Math.abs(grade) != 1 || !cardinalTread(from, to, travel) || !AgentBody.matchesDryRouteTop(hit, floor))
            return null;
        return grade > 0 ? new Edge(to, landing, from, source, travel.getOpposite())
            : new Edge(from, source, to, landing, travel);
    }

    static AgentSurfaceTread ordinaryGrade(Edge edge, BlockPos from, long tick) {
        return new AgentSurfaceTread(edge, edge.lower.equals(from), tick, false, true, true);
    }

    private AgentSurfaceTread(Edge edge, boolean returning, long started, boolean isolated,
                              boolean witnessedOutbound, boolean ordinaryGrade) {
        this.edge = edge;
        this.returning = returning;
        this.started = started;
        this.isolated = isolated;
        this.witnessedOutbound = witnessedOutbound;
        this.ordinaryGrade = ordinaryGrade;
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
        levelProbe = from.getY() == to.getY() && !witnessedOutbound
            ? new AgentDryCaveRoute.Probe(from, to, travel) : null;
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
        return new AgentSurfaceTread(edge, up, tick, true, false, false);
    }

    boolean inFlight() { return drivingSince >= 0; }

    /** Look ahead only along the next exact walked level edge, never around a corner or over a riser. */
    AgentSurfaceTread recallSuccessor(MinecraftClient client, BlockPos next, long tick) {
        if (!isolated || !straightLevelContinuation(from, to, next, travel)) return null;
        if (ahead == null || !ahead.to.equals(next)) ahead = recall(client, to, next, tick);
        return ahead;
    }

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
        return travel != null && travel == prospectLevelBearing(foot, cell);
    }

    static Direction prospectLevelBearing(BlockPos foot, BlockPos cell) {
        int dy = cell.getY() - foot.getY();
        if (dy != 0 && dy != 1) return null;
        int dx = cell.getX() - foot.getX(), dz = cell.getZ() - foot.getZ();
        if (dz == 0) return dx == 1 ? Direction.EAST : dx == -1 ? Direction.WEST : null;
        if (dx == 0) return dz == 1 ? Direction.SOUTH : dz == -1 ? Direction.NORTH : null;
        return null;
    }

    static boolean cardinalTread(BlockPos from, BlockPos to, Direction travel) {
        return travel.getAxis().isHorizontal() && Math.abs(to.getY() - from.getY()) <= 1
            && to.getX() - from.getX() == travel.getOffsetX() && to.getZ() - from.getZ() == travel.getOffsetZ();
    }

    static boolean straightLevelContinuation(BlockPos from, BlockPos to, BlockPos next, Direction travel) {
        return from.getY() == to.getY() && to.getY() == next.getY()
            && cardinalTread(from, to, travel) && cardinalTread(to, next, travel);
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
        return step(client, body, tick, null);
    }

    Result step(MinecraftClient client, AgentBody body, long tick, AgentSurfaceTread successor) {
        var player = client.player;
        if (!drySupport(client, body)) return Result.REFUSED;
        if (drivingSince >= 0 && !motion.observe(player.getX(), player.getY(), player.getZ())) return Result.REFUSED;
        if (drivingSince < 0 ? tick - started > PROOF_TICKS : tick - drivingSince > DRIVE_TICKS) return Result.REFUSED;
        if (!body.hasRecentView()) return drivingSince < 0 ? Result.CHECKING : Result.MOVING;
        if ((isolated || ordinaryGrade) && !body.macroNoVisiblePickup(center, Math.min(from.getY(), to.getY()),
                Math.max(from.getY(), to.getY()) + 0.32)) return Result.REFUSED;
        if (drivingSince < 0) {
            if (!player.isOnGround() || !player.getBlockPos().equals(from)) return Result.REFUSED;
            if (!witnessedOutbound && !centered(player.getPos(), from, 0.17)) {
                body.centerOnSupport(sourceSupport);
                return Result.CHECKING;
            }
            if (player.getVelocity().horizontalLengthSquared() > 0.0025) return Result.CHECKING;
            if (!witnessedOutbound && !sampleProof(body, null, 0)) {
                if (levelProbe != null && (levelProbe.visiblyRefused()
                        || body.renderedDirection(travel.getPositiveHorizontalDegrees(), AgentBody.LEVEL_ROUTE_PITCH, 5)
                            && !body.dryRouteRaysSpent())) return Result.REFUSED;
                lookThroughOpening(body, player.getEyePos(), tick);
                return Result.CHECKING;
            }
        }
        boolean level = from.getY() == to.getY();
        if (player.getY() < Math.min(from.getY(), to.getY()) - 0.055) return Result.REFUSED;
        if (!level && !reverseClear(client, edge.upper, edge.lower, edge.down)
                || !(ordinaryGrade ? body.ordinaryGradeSweep(from, to) : body.dryRouteSweep(from, to)))
            return drivingSince >= 0 && tick - drivingSince < 5 ? Result.CHECKING : Result.REFUSED;
        if (drivingSince < 0) beginDrive(player.getPos(), tick);
        boolean carry = successor != null && canCarry(client, body, successor, tick);
        boolean landed = player.isOnGround() && player.getBlockPos().equals(to)
            && centered(player.getPos(), to, 0.23) && Math.abs(player.getY() - to.getY()) <= 0.055;
        double remaining = (center.x - player.getX()) * travel.getOffsetX() + (center.z - player.getZ()) * travel.getOffsetZ();
        if (landed && (carry && AgentBody.dryStrideContact(remaining)
                || player.getVelocity().horizontalLengthSquared() <= 0.0025)) {
            if (!motion.traversed()) return Result.REFUSED;
            if (carry) {
                successor.beginDrive(player.getPos(), tick);
                body.driveDryRoute(successor.from, successor.to, successor.travel);
            }
            return Result.LANDED;
        }
        body.driveDryRoute(from, to, travel, carry);
        return Result.MOVING;
    }

    private BlockState sourceState() { return returning ? edge.lowerSupport : edge.upperSupport; }
    private BlockState landingState() { return returning ? edge.upperSupport : edge.lowerSupport; }

    private boolean drySupport(MinecraftClient client, AgentBody body) {
        var player = client.player;
        var world = client.world;
        return !player.isTouchingWater() && !player.isInLava() && !player.isOnFire() && !player.hasVehicle()
            && player.hurtTime == 0 && cardinalTread(edge.upper, edge.lower, edge.down)
            && world.getBlockState(sourceSupport) == sourceState() && world.getBlockState(landingSupport) == landingState()
            && (!(from.getY() == to.getY() || isolated || witnessedOutbound) || body.walkedLaneDry(from, to, travel));
    }

    private void beginDrive(Vec3d feet, long tick) {
        drivingSince = tick;
        motion.start(feet.x, feet.y, feet.z);
    }

    private boolean sampleProof(AgentBody body, BlockState arrival, int arrivalTick) {
        if (levelProbe != null) {
            int now = body.actionTick();
            var view = body.dryCaveProbeView();
            if (levelProbe.changedWitness(view) != null) levelProbe.reset();
            BlockState contact = body.dryCaveContact(from);
            levelProbe.sample(view, now, body.renderedFrame(), contact != null ? contact : arrival,
                contact != null ? now : arrivalTick);
            return levelProbe.complete(now);
        }
        if (!floorSeen) floorSeen = body.dryRouteFloor(floorAim, landingSupport) != null
            || body.dryRouteFloor(nearFloorAim, landingSupport) != null;
        if (!chestSeen) chestSeen = body.dryRouteClear(chestAim) == AgentBody.DryRouteSample.CLEAR;
        if (isolated && !headSeen) headSeen = body.dryRouteClear(headAim) == AgentBody.DryRouteSample.CLEAR;
        return floorSeen && chestSeen && (!isolated || headSeen);
    }

    private void lookThroughOpening(AgentBody body, Vec3d eye, long tick) {
        if (levelProbe != null) {
            body.turnFixed(travel.getPositiveHorizontalDegrees(), AgentBody.LEVEL_ROUTE_PITCH);
            return;
        }
        // Cover the landing and its opening in one rendered view. If a lip or
        // narrow FOV hides one end, favor that end once rather than aiming a checklist.
        double low = pitch(eye, floorAim);
        double high = pitch(eye, isolated ? headAim : chestAim);
        double blend = tick - started < 18 ? 0.5 : !floorSeen ? 0.8 : 0.22;
        body.turnFixed(travel.getPositiveHorizontalDegrees(), (float) (low * blend + high * (1 - blend)));
    }

    private static double pitch(Vec3d eye, Vec3d at) {
        return Math.toDegrees(Math.atan2(eye.y - at.y, Math.hypot(at.x - eye.x, at.z - eye.z)));
    }

    private boolean canCarry(MinecraftClient client, AgentBody body, AgentSurfaceTread next, long tick) {
        return to.equals(next.from) && straightLevelContinuation(from, to, next.to, travel) && next.drivingSince < 0
            && tick - next.started <= PROOF_TICKS && landingState() == next.sourceState()
            && AgentBody.normalDryTraction(sourceState()) && next.drySupport(client, body)
            && levelProbe != null && next.sampleProof(body, levelProbe.floorState(body.actionTick()), levelProbe.floorSeenAt())
            && body.dryRouteContinuationClear(next.from, next.to, travel,
                next.sourceState(), next.landingState())
            && (!next.isolated || body.macroNoVisiblePickup(next.center, next.from.getY(), next.to.getY() + 0.32));
    }

    /** Veto only on the two positively identified columns; never use collision to discover a tread. */
    static boolean reverseClear(MinecraftClient client, BlockPos upper, BlockPos lower, Direction travel) {
        boolean level = upper.getY() == lower.getY();
        for (int i = 0; i <= (level ? 1 : 2); ++i) {
            if (!client.world.getBlockState(lower.up(i)).getFluidState().isEmpty()
                    || !client.world.getBlockState(upper.up(i)).getFluidState().isEmpty()) return false;
        }
        if (level) return true; // The same two-block-high sweep serves both walking directions.
        Box jumpHeadroom = reverseJumpHeadroom(upper.up(Math.max(0, lower.getY() - upper.getY())), client.player.getWidth());
        return client.world.isSpaceEmpty(client.player, jumpHeadroom.stretch(travel.getOffsetX(), 0, travel.getOffsetZ()));
    }

    static Box reverseJumpHeadroom(BlockPos upper, double width) {
        double half = width * 0.5 + 0.055;
        double x = upper.getX() + 0.5, y = upper.getY(), z = upper.getZ() + 0.5;
        return new Box(x - half, y + 1.79, z - half, x + half, y + 2.08, z + half);
    }

    private static boolean centered(Vec3d position, BlockPos foot, double tolerance) {
        return Math.abs(position.x - foot.getX() - 0.5) <= tolerance && Math.abs(position.z - foot.getZ() - 0.5) <= tolerance;
    }
}
