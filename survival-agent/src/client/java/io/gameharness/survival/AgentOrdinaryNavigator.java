package io.gameharness.survival;

import static io.gameharness.survival.AgentRouteGraph.NO_CELL;
import static io.gameharness.survival.AgentRouteGraph.neighbor;
import static io.gameharness.survival.AgentRouteGraph.x;
import static io.gameharness.survival.AgentRouteGraph.y;
import static io.gameharness.survival.AgentRouteGraph.z;

import java.util.Arrays;
import java.util.List;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** One ordinary route owner. The planner has no camera or motor; only executing a selected edge can turn or walk. */
final class AgentOrdinaryNavigator {
    enum Job { FOOD, STONE, TIMBER, EXPLORE, RETURN }
    enum Result { MOVING, OBSERVING, ARRIVED, BLOCKED }
    record Arrival(BlockPos from, BlockPos to) {}

    private static final int RANGE = 5, HEIGHT = 3, SIDE = 2 * RANGE + 1;
    private static final int VIEW_CELLS = SIDE * SIDE * (2 * HEIGHT + 1);
    private static final int SIGHT_RAYS = 48, SIGHT_NODES = 48, RAY_RESERVE = 12;
    // Up to two first-hit rays on each of twelve adjacent supports, plus outline proof.
    private static final int DIRECTED_RAYS = RAY_RESERVE + 24 + 8;
    private static final int LOOK_TICKS = 34, RETRY_TICKS = 24, EDGE_TICKS = 54, STANCE_TICKS = 52, GRADE_AGE = 12;
    private static final float TRAVEL_PITCH = 31;
    private static final int[] GRADES = {0, 1, -1};
    private static final Direction[] BEARINGS = {Direction.EAST, Direction.WEST, Direction.SOUTH, Direction.NORTH};
    private static final byte SEEN = 1, HIDDEN = 2, QUEUED = 3;

    private final MinecraftClient client;
    private final AgentBody body;
    private final AgentOrdinaryRoute route = new AgentOrdinaryRoute();
    private final AgentWalkedRoute.Motion motion = new AgentWalkedRoute.Motion();
    private final byte[] sight = new byte[VIEW_CELLS];
    private final short[] checked = new short[VIEW_CELLS];
    private final long[] sightQueue = new long[SIGHT_NODES];
    private final BlockPos.Mutable sightFrom = new BlockPos.Mutable(), sightTo = new BlockPos.Mutable();

    private ClientWorld world;
    private ClientPlayerEntity player;
    private Job job;
    private Vec3d target;
    private double radius, minY, maxY;
    private long goalCell = NO_CELL;
    private BlockPos from, to;
    private Direction bearing;
    private Vec3d gradeAim;
    private long rendered = -1, lookAt = NO_CELL, lookFrame, lookCue = NO_CELL, adjustAt = NO_CELL;
    private long recallAt = NO_CELL, recalled = NO_CELL, gradeFrame = -1;
    private int lastScan = -100, lookSince, lastEdgeAction = -100, edgeSince, adjustSince, gradeAt = -100;
    private int unavailableSince = -1, lastProgress;
    private float lookYaw, lookPitch;
    private double bestAlong;
    private boolean crossing, foodScoutHandoff;
    private AgentBody.EdgeStance edgeStance;
    private BlockPos stanceSupport;
    private int stanceSince;
    private boolean stanceRefused;
    private Arrival arrival;
    private String stage = "idle", lastVeto = "";

    AgentOrdinaryNavigator(MinecraftClient client, AgentBody body) {
        this.client = client;
        this.body = body;
    }

    void reset() {
        world = client.world;
        player = client.player;
        route.clear();
        job = null;
        target = null;
        goalCell = lookAt = lookCue = adjustAt = recallAt = recalled = NO_CELL;
        arrival = null;
        edgeStance = null;
        stanceSupport = null;
        stanceRefused = false;
        rendered = -1;
        lastEdgeAction = lastScan = -100;
        unavailableSince = -1;
        foodScoutHandoff = false;
        stage = "idle";
        lastVeto = "";
        releaseEdge();
    }

    boolean driving() {
        return crossing && player == client.player && world == client.world
            && body.actionTick() - lastEdgeAction <= 1;
    }

    boolean driving(Job owner) { return job == owner && driving(); }

    boolean foodScoutHandoff() { return foodScoutHandoff; }

    Arrival takeArrival() {
        Arrival value = arrival;
        arrival = null;
        return value;
    }

    boolean walkedSupport(BlockPos floor) {
        return world == client.world && player == client.player && route.walked(
            AgentRouteGraph.cell(floor.getX(), floor.getY() + 1, floor.getZ()));
    }

    /** Bridge an independently receipted, exact dry tread without manufacturing an ordinary arrival. */
    void rememberWalked(BlockPos from, BlockPos to) {
        if (world != client.world || player != client.player) reset();
        if (!AgentRouteGraph.cardinalStep(from.asLong(), to.asLong()) || !body.ordinaryRouteContact(to)
                || body.ordinaryRouteLane(from, to) != AgentBody.DryRouteVeto.CLEAR) return;
        remember(from, to, body.actionTick());
    }

    /** Restore only a look cue; no saved trail entry becomes a graph edge or a landed receipt. */
    void recallTrail(List<BlockPos> observedTrail, BlockPos grounded) {
        if (world != client.world || player != client.player) reset();
        recallAt = recalled = NO_CELL;
        if (grounded == null || !body.ordinaryRoutePhysicalContact(grounded)) return;
        BlockPos predecessor = recalledPredecessor(observedTrail, grounded);
        if (predecessor != null) {
            recallAt = grounded.asLong();
            recalled = predecessor.asLong();
        }
    }

    static BlockPos recalledPredecessor(List<BlockPos> trail, BlockPos grounded) {
        int at = trail.lastIndexOf(grounded);
        if (at <= 0) return null;
        BlockPos before = trail.get(at - 1);
        return before != null && AgentRouteGraph.cardinalStep(grounded.asLong(), before.asLong()) ? before : null;
    }

    Result step(Job requested, Vec3d destination, double arrival, int tick) {
        return step(requested, destination, arrival, destination == null ? 0 : destination.y - 1.05,
            destination == null ? 0 : destination.y + 1.05, tick);
    }

    Result step(Job requested, Vec3d destination, double arrivalRadius, double minFootY, double maxFootY, int tick) {
        if (world != client.world || player != client.player) reset();
        foodScoutHandoff = false;
        int action = body.actionTick();
        boolean changed = changed(requested, destination, arrivalRadius, minFootY, maxFootY);
        // A higher-level goal cannot switch inputs halfway across a short dry jump/drop.
        if (changed && !(driving() && player != null && !player.isOnGround())) {
            setIntent(requested, destination, arrivalRadius, minFootY, maxFootY);
            changed = false;
        }
        if (player == null || !body.ordinaryRouteControls()) {
            if (unavailableSince < 0) unavailableSince = tick;
            stage = "waiting for safe rendered dry controls";
            if (tick - unavailableSince < LOOK_TICKS) return Result.OBSERVING;
            stage = "dry controls/render bound";
            return Result.BLOCKED;
        }
        unavailableSince = -1;

        // Another owner may have walked, been pushed, used a GUI, or taken a protected fall
        // during the gap. A route suffix still exists, but no new traversal can be inferred.
        if (from != null && action - lastEdgeAction > 1) releaseEdge();
        BlockPos foot = player.getBlockPos();
        boolean grounded = body.ordinaryRouteContact(foot);
        if (from != null && grounded && !foot.equals(from) && !foot.equals(to)) releaseEdge();

        if (from != null && crossing) {
            Vec3d pos = player.getPos();
            if (!motion.observe(pos.x, pos.y, pos.z)) reject("discontinuous motion", Integer.MAX_VALUE);
            else if (grounded && foot.equals(to) && settledAlong()) {
                boolean foodHandoff = requested == Job.FOOD && destination == null && !straightSuccessor();
                remember(from, to, tick);
                body.recordWalkedLeg(from, to);
                this.arrival = new Arrival(from, to);
                releaseEdge();
                if (changed) return Result.MOVING;
                if (foodHandoff) {
                    // Keep a continuous level lane, but give the food owner a
                    // grounded frame before committing the next turn or grade.
                    foodScoutHandoff = true;
                    body.pauseWork();
                    stage = "settled for a food-search handoff";
                    return Result.OBSERVING;
                }
            }
        }

        if (from == null && (!grounded || edgeStance != null)) {
            Result stance = reconnectFooting(foot, tick);
            if (stance != null) return stance;
            grounded = body.ordinaryRouteContact(foot);
        }
        if (grounded) {
            long here = foot.asLong();
            if (recallAt != here) recallAt = recalled = NO_CELL;
            if (lookAt != here) lookAt = lookCue = NO_CELL;
            if (edgeStance == null) stanceSupport = null;
            route.contact(here, tick);
            if (from == null && !changed && arrived(destination, arrivalRadius, minFootY, maxFootY)) {
                body.pauseWork();
                stage = "grounded arrival";
                return Result.ARRIVED;
            }
            // Reuse the current projection and render budget. This scan observes many
            // admissible lanes while the camera follows an already selected one.
            if (lookAt != here && (from == null || from.getY() == to.getY() || crossing))
                observe(here, tick, false);
        }

        // Retry a bounded number of invalidated outgoing edges before returning to
        // the scheduler; repairing the suffix does not change the destination.
        for (int attempt = 0; attempt < 3; attempt++) {
            if (from == null) {
                if (!grounded) {
                    stage = "dry footing unavailable";
                    return Result.BLOCKED;
                }
                long here = foot.asLong();
                route.plan(here, tick);
                long next = route.hop(0);
                if (next == NO_CELL) {
                    if (route.exact() && route.endpoint() == here) return fineArrival(foot, destination, tick);
                    return observeFrontier(here, tick);
                }
                from = foot;
                to = BlockPos.fromLong(next);
                bearing = BEARINGS[AgentRouteGraph.slot(here, next) / 3];
                edgeSince = lastProgress = tick;
                bestAlong = Double.NEGATIVE_INFINITY;
                lookAt = lookCue = NO_CELL;
            }
            lastEdgeAction = action;
            if (!crossing && from.getY() != to.getY() && tick - gradeAt > GRADE_AGE) {
                long frame = body.renderedFrame();
                if (grounded && foot.equals(from) && lastScan == tick && frame == rendered) {
                    byte seen = sight[gridIndex(foot.asLong(), to.asLong())];
                    if (seen == SEEN || seen == QUEUED) gradeAt = tick;
                }
                if (tick - gradeAt > GRADE_AGE && frame != gradeFrame
                        && body.generalRaysRemaining() >= RAY_RESERVE + 10) {
                    gradeFrame = frame;
                    if (body.ordinaryRouteFreshGrade(from, to, RAY_RESERVE)) gradeAt = tick;
                }
                if (tick - gradeAt > GRADE_AGE) {
                    if (tick - edgeSince >= LOOK_TICKS) {
                        reject("adjacent grade top not re-witnessed", tick + RETRY_TICKS);
                        continue;
                    }
                    aimGrade();
                    stage = "rechecking the exact queued grade top";
                    return Result.OBSERVING;
                }
            }
            AgentBody.DryRouteVeto veto = body.ordinaryRouteLane(from, to);
            if (veto != AgentBody.DryRouteVeto.CLEAR) {
                reject(veto.name(), tick + RETRY_TICKS);
                continue;
            }
            double along = along();
            if (along > bestAlong + 0.025) {
                bestAlong = along;
                lastProgress = tick;
            }
            if (tick - edgeSince >= EDGE_TICKS || crossing && tick - lastProgress >= 16) {
                reject("edge progress bound", Integer.MAX_VALUE);
                continue;
            }
            boolean carry = straightSuccessor();
            AgentBody.OrdinaryMotor turn = body.driveOrdinaryRoute(from, to, bearing, carry, crossing);
            if (turn == AgentBody.OrdinaryMotor.VETO) {
                reject("live body sweep or hazard", Integer.MAX_VALUE);
                continue;
            }
            if (turn == AgentBody.OrdinaryMotor.VIEW) {
                stage = "waiting for render on queued edge";
                return Result.OBSERVING;
            }
            if (!crossing && turn == AgentBody.OrdinaryMotor.KEY) {
                motion.start(player.getX(), player.getY(), player.getZ());
                crossing = true;
            }
            float pitch = to.getY() > from.getY() ? 19 : to.getY() < from.getY() ? 43 : TRAVEL_PITCH;
            // Look beyond the adjacent contact along a continuous level prefix. Reaching
            // one tile of that prefix does not create a new yaw or a separate observation.
            body.turn(bearing.getPositiveHorizontalDegrees(), pitch);
            stage = switch (turn) {
                case ALIGN -> "aligning with path";
                case CENTER -> "centering on occupied tread";
                case COAST -> "coasting on proved edge";
                default -> pitch == 19 ? "jumping queued rise" : pitch == 43 ? "walking queued descent" : "walking queued flat";
            };
            return crossing || turn == AgentBody.OrdinaryMotor.CENTER ? Result.MOVING : Result.OBSERVING;
        }
        stage = "local edge repair bound";
        return Result.OBSERVING;
    }

    private boolean changed(Job requested, Vec3d destination, double r, double low, double high) {
        if (requested != job || (destination == null) != (target == null)) return true;
        if (destination == null) return false;
        return horizontalSquared(destination.x - target.x, destination.z - target.z) > 0.64
            || Math.abs(destination.y - target.y) > 0.65 || Math.abs(radius - r) > 0.10
            || Math.abs(minY - low) > 0.35 || Math.abs(maxY - high) > 0.35;
    }

    private void setIntent(Job requested, Vec3d destination, double r, double low, double high) {
        releaseEdge();
        job = requested;
        target = destination;
        radius = r;
        minY = low;
        maxY = high;
        goalCell = destination == null ? NO_CELL : BlockPos.ofFloored(destination).asLong();
        lookAt = lookCue = adjustAt = NO_CELL;
        lastVeto = "";
        unavailableSince = -1;
        if (destination != null) route.destination(destination.x, destination.z, r, low, high);
        else {
            double yaw = Math.toRadians(player == null ? 0 : player.getYaw());
            route.explore(-Math.sin(yaw), Math.cos(yaw));
        }
    }

    private boolean arrived(Vec3d destination, double radius, double low, double high) {
        return destination != null && player.getY() >= low && player.getY() <= high
            && horizontalSquared(player.getX() - destination.x, player.getZ() - destination.z) <= radius * radius;
    }

    private Result fineArrival(BlockPos foot, Vec3d destination, int tick) {
        if (adjustAt != foot.asLong()) {
            adjustAt = foot.asLong();
            adjustSince = tick;
        }
        double x = MathHelper.clamp(destination.x, foot.getX() + 0.29, foot.getX() + 0.71);
        double z = MathHelper.clamp(destination.z, foot.getZ() + 0.29, foot.getZ() + 0.71);
        if (tick - adjustSince < 20 && body.ordinaryRouteAdjust(foot, x, z)) {
            stage = "closing on destination within grounded tread";
            return Result.MOVING;
        }
        stage = "grounded destination tolerance bound";
        return Result.BLOCKED;
    }

    private boolean settledAlong() {
        if (!motion.traversed() || !AgentBody.dryStrideContact(1 - along())) return false;
        return straightSuccessor() || player.getVelocity().horizontalLengthSquared() <= 0.0036;
    }

    private double along() {
        return (player.getX() - from.getX() - 0.5) * bearing.getOffsetX()
            + (player.getZ() - from.getZ() - 0.5) * bearing.getOffsetZ();
    }

    private boolean straightSuccessor() {
        if (from.getY() != to.getY() || route.hop(0) != to.asLong()) return false;
        long successor = route.hop(1);
        if (successor != neighbor(to.asLong(), bearingIndex(bearing), 0)) return false;
        set(sightTo, successor);
        return body.ordinaryRouteLane(to, sightTo) == AgentBody.DryRouteVeto.CLEAR
            && !body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 2.4 - along());
    }

    private void remember(BlockPos from, BlockPos to, int tick) {
        route.landed(from.asLong(), to.asLong(), tick);
        // A second, mechanically compatible direction joins the two physically occupied
        // supports. This is not a license to accept other unseen adjoining cells.
        if (body.ordinaryRouteLane(to, from) == AgentBody.DryRouteVeto.CLEAR)
            route.rememberReturn(to.asLong(), from.asLong(), tick);
    }

    private void reject(String why, int retry) {
        route.retire(from.asLong(), to.asLong(), retry);
        lastVeto = why;
        releaseEdge();
    }

    private void releaseEdge() {
        from = to = null;
        bearing = null;
        crossing = false;
        gradeAim = null;
        gradeFrame = -1;
        gradeAt = -100;
    }

    private Result reconnectFooting(BlockPos foot, int tick) {
        BlockPos support = player.supportingBlockPos.orElse(null);
        if (!player.isOnGround() || support == null || Math.abs(player.getY() - support.getY() - 1) > 0.035
                || edgeStance == null && AgentBody.sameSurveySupport(support, player.getPos())) {
            edgeStance = null;
            return null;
        }
        if (!support.equals(stanceSupport)) {
            edgeStance = null;
            stanceSupport = support;
            stanceSince = tick;
            stanceRefused = false;
        }
        body.pauseWork();
        if (!stanceRefused && tick - stanceSince < STANCE_TICKS) {
            if (edgeStance == null) edgeStance = body.edgeStance();
            if (edgeStance == null) {
                stage = "waiting to settle on actual dry support";
                return Result.OBSERVING;
            }
            switch (body.settleEdgeStance(edgeStance)) {
                case WORKING -> {
                    stage = "centering on actual edge support";
                    return Result.OBSERVING;
                }
                case SETTLED -> {
                    edgeStance = null;
                    return null;
                }
                case REFUSED -> stanceRefused = true;
            }
        }
        edgeStance = null;
        if (body.ordinaryRouteContact(foot)) return null;
        stage = "actual dry support centering bound";
        return Result.BLOCKED;
    }

    private void aimGrade() {
        if (gradeAim == null) gradeAim = new Vec3d(to.getX() + 0.5 + 0.38 * bearing.getOffsetX(),
            to.getY() - 0.025, to.getZ() + 0.5 + 0.38 * bearing.getOffsetZ());
        body.aim(gradeAim);
    }

    private Result observeFrontier(long here, int tick) {
        if (lookAt != here) {
            if (!route.canLook(here)) {
                body.pauseWork();
                stage = "no connected dry route; directed view spent";
                return Result.BLOCKED;
            }
            lookAt = here;
            lookSince = tick;
            lookFrame = body.renderedFrame();
            float current = player.getYaw();
            lookYaw = target == null ? current : heading(target.x - player.getX(), target.z - player.getZ(), current);
            lookPitch = 55;
            Direction toward = Direction.fromHorizontalDegrees(lookYaw);
            if (body.ordinaryRouteRiseCue(player.getBlockPos(), toward, RAY_RESERVE))
                lookCue = neighbor(here, bearingIndex(toward), 1);
            else if (recallAt == here) lookCue = recalled;
            if (lookCue != NO_CELL) {
                Direction cue = BEARINGS[AgentRouteGraph.slot(here, lookCue) / 3];
                Vec3d eye = player.getEyePos();
                double dx = x(lookCue) + 0.5 + 0.38 * cue.getOffsetX() - eye.x;
                double dz = z(lookCue) + 0.5 + 0.38 * cue.getOffsetZ() - eye.z;
                lookYaw = heading(dx, dz, lookYaw);
                lookPitch = (float) Math.toDegrees(Math.atan2(eye.y - y(lookCue) + 0.025, Math.hypot(dx, dz)));
            }
        }
        if (body.renderedFrame() > lookFrame && body.renderedDirection(lookYaw, lookPitch, 5)
                && observe(here, tick, true)) {
            route.consumeLook(here);
            if (lookCue == recalled) recallAt = recalled = NO_CELL;
            route.plan(here, tick);
            lookAt = lookCue = NO_CELL;
            if (route.hop(0) == NO_CELL) {
                body.pauseWork();
                stage = "no connected dry route; directed view exhausted";
                return Result.BLOCKED;
            }
            stage = "found a reachable route after directed look";
            return Result.OBSERVING;
        }
        if (tick - lookSince >= LOOK_TICKS) {
            // A missing or starved render is not observed terrain. Stop turning, but
            // let a later matching frame finish this pending view or take good footing
            // from the current projection after another owner has moved the camera.
            if (observe(here, tick, false)) {
                route.plan(here, tick);
                if (route.hop(0) != NO_CELL) {
                    lookAt = lookCue = NO_CELL;
                    stage = "found a reachable route in the current view";
                    return Result.OBSERVING;
                }
            }
            body.pauseWork();
            stage = "directed view awaiting usable render";
            return Result.BLOCKED;
        }
        body.turn(lookYaw, lookPitch);
        stage = lookCue == NO_CELL ? "one directed terrain look" : "reconnecting to a witnessed terrain cue";
        return Result.OBSERVING;
    }

    private boolean observe(long here, int tick, boolean directed) {
        long frame = body.renderedFrame();
        if (frame == rendered || !directed && tick - lastScan < 3) return false;
        int available = body.generalRaysRemaining();
        if (available < (directed ? DIRECTED_RAYS : RAY_RESERVE + 2)) return false;
        rendered = frame;
        lastScan = tick;
        int leaveRays = Math.max(RAY_RESERVE, available - SIGHT_RAYS);
        Arrays.fill(sight, (byte) 0);
        Arrays.fill(checked, (short) 0);
        long outlined = available >= leaveRays + 10 ? body.ordinaryRouteOutlinedFoot(player.getBlockPos()) : NO_CELL;
        if (outlined != NO_CELL) sight[gridIndex(here, outlined)] = SEEN;
        sightQueue[0] = here;
        sight[gridIndex(here, here)] = QUEUED;
        int tail = 1;
        for (int head = 0; head < tail && body.generalRaysRemaining() > leaveRays; head++) {
            long source = sightQueue[head];
            set(sightFrom, source);
            int at = gridIndex(here, source);
            for (int direction = 0; direction < 4; direction++) {
                for (int rise : GRADES) {
                    long next = neighbor(source, direction, rise);
                    int n = gridIndex(here, next);
                    int slot = direction * 3 + rise + 1;
                    if (n < 0 || (checked[at] & (1 << slot)) != 0) continue;
                    set(sightTo, next);
                    if (sight[n] == 0) sight[n] = body.ordinaryRouteTop(sightTo, leaveRays) ? SEEN : HIDDEN;
                    if (sight[n] == HIDDEN) continue;
                    checked[at] |= (short) (1 << slot);
                    checked[n] |= (short) (1 << ((direction ^ 1) * 3 - rise + 1));
                    boolean forward = body.ordinaryRouteLane(sightFrom, sightTo) == AgentBody.DryRouteVeto.CLEAR;
                    if (forward) route.observe(source, next, tick);
                    if (rise == 0 ? forward : body.ordinaryRouteLane(sightTo, sightFrom) == AgentBody.DryRouteVeto.CLEAR)
                        route.observe(next, source, tick);
                    if (forward && sight[n] == SEEN && tail < SIGHT_NODES) {
                        sight[n] = QUEUED;
                        sightQueue[tail++] = next;
                    }
                }
            }
        }
        return outlined != NO_CELL || body.generalRaysRemaining() < available;
    }

    private static int gridIndex(long origin, long foot) {
        int dx = x(foot) - x(origin) + RANGE, dy = y(foot) - y(origin) + HEIGHT, dz = z(foot) - z(origin) + RANGE;
        return dx < 0 || dx >= SIDE || dz < 0 || dz >= SIDE || dy < 0 || dy > 2 * HEIGHT
            ? -1 : (dy * SIDE + dz) * SIDE + dx;
    }

    private static void set(BlockPos.Mutable pos, long foot) { pos.set(x(foot), y(foot), z(foot)); }

    private static int bearingIndex(Direction bearing) {
        return switch (bearing) {
            case EAST -> 0;
            case WEST -> 1;
            case SOUTH -> 2;
            default -> 3;
        };
    }

    private static float heading(double dx, double dz, float fallback) {
        return horizontalSquared(dx, dz) > 0.0001 ? (float) Math.toDegrees(Math.atan2(-dx, dz)) : fallback;
    }

    private static double horizontalSquared(double x, double z) { return x * x + z * z; }

    String status() {
        return "ordinary " + job + " goal=" + (goalCell == NO_CELL ? "frontier" : display(goalCell))
            + (route.exact() ? " destination=" : " proxy=") + display(route.endpoint())
            + " next=" + display(route.hop(0)) + " suffix=" + route.remaining() + " plan=" + route.plans()
            + " " + stage + (lastVeto.isEmpty() ? "" : " replan=" + lastVeto);
    }

    private static String display(long cell) {
        return cell == NO_CELL ? "-" : x(cell) + "," + y(cell) + "," + z(cell);
    }
}
