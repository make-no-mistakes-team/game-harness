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
    private static final int FLAT_RETRACE_AGE = 12;
    private static final float TRAVEL_PITCH = 31;
    private static final int[] GRADES = {0, 1, -1};
    private static final Direction[] BEARINGS = {Direction.EAST, Direction.WEST, Direction.SOUTH, Direction.NORTH};
    private static final byte SEEN = 1, HIDDEN = 2, QUEUED = 3;

    enum Sight {
        STALE_FRAME("stale or shifted frame"), BAD_FACING("not facing the requested view"),
        RAY_BUDGET("insufficient terrain rays"), READY(""),
        NO_PROJECTED_SUPPORT("no adjacent support in the projection"),
        NO_NEIGHBOR("no witnessed dry neighbor"), NEIGHBOR("witnessed a dry neighbor");

        final String detail;
        Sight(String detail) { this.detail = detail; }
    }

    /** One paid snapshot belongs to its owner even if subsequent work spends all remaining rays. */
    static final class FrontierView {
        private long baseline, paidFrame;
        private Sight paid;
        private boolean faced;

        void begin(long frame) {
            baseline = frame;
            paid = null;
        }

        Sight admit(long frame, boolean currentPose, boolean facing, int available) {
            if (paid != null && frame == paidFrame && currentPose) return paid;
            paid = null;
            if (!currentPose || frame <= baseline) return Sight.STALE_FRAME;
            if (!facing) return Sight.BAD_FACING;
            return available < DIRECTED_RAYS ? Sight.RAY_BUDGET : Sight.READY;
        }

        void pay(long frame, Sight outcome, boolean facing) {
            if (outcome != Sight.NEIGHBOR && outcome != Sight.NO_NEIGHBOR && outcome != Sight.NO_PROJECTED_SUPPORT)
                return;
            paidFrame = frame;
            paid = outcome;
            faced = facing;
        }

        boolean complete(AgentOrdinaryRoute route, long here, int tick) {
            if (paid == null) return false;
            route.consumeLook(here);
            route.plan(here, tick);
            return true;
        }

        String detail() { return faced ? paid.detail : "facing bound; current view: " + paid.detail; }
    }

    /** Body-turn ownership and observed motion are independent of render availability. */
    static final class EdgeTravel {
        private final AgentWalkedRoute.Motion motion = new AgentWalkedRoute.Motion();
        private int lastAction, since, lastProgress;
        private BlockPos landedFrom, landedTo;
        private int landedAction;
        private double bestAlong;
        private boolean crossing;

        void begin(int action, int tick) {
            lastAction = action;
            since = lastProgress = tick;
            bestAlong = Double.NEGATIVE_INFINITY;
        }

        private boolean ownsTurn(int action) { return action == lastAction || action == lastAction + 1; }

        boolean keepTurn(int action) {
            if (!ownsTurn(action)) return false;
            lastAction = action;
            return true;
        }

        void startMotion(Vec3d pos) {
            forgetLanding();
            motion.start(pos.x, pos.y, pos.z);
            crossing = true;
        }

        void noteLanding(BlockPos from, BlockPos to, int action) {
            landedFrom = from;
            landedTo = to;
            landedAction = action;
        }

        void forgetLanding() { landedFrom = landedTo = null; }

        private boolean recentLanding(int action) {
            return landedTo != null && action >= landedAction && action - landedAction <= FLAT_RETRACE_AGE;
        }

        boolean recentFlatReturn(BlockPos from, BlockPos to, int action) {
            return from.equals(landedTo) && to.equals(landedFrom) && from.getY() == to.getY() && recentLanding(action);
        }

        float flatRetraceYaw(BlockPos from, BlockPos to, long next, Direction bearing, float yaw, int action) {
            if (!recentFlatReturn(from, to, action)) return Float.NaN;
            // A longer return still needs to face the route, including a grade beyond this tread.
            if (next != NO_CELL && x(next) - to.getX() == bearing.getOffsetX()
                    && z(next) - to.getZ() == bearing.getOffsetZ()) return Float.NaN;
            var key = AgentBody.ordinaryFlatKey(yaw, bearing);
            return key == AgentBody.FlatKey.NONE ? Float.NaN
                : yaw + MathHelper.wrapDegrees(bearing.getPositiveHorizontalDegrees() - yaw - key.yawOffset);
        }

        boolean observe(Vec3d pos) { return motion.observe(pos.x, pos.y, pos.z); }

        boolean traversed() { return motion.traversed(); }

        boolean expired(int tick, double along) {
            if (along > bestAlong + 0.025) {
                bestAlong = along;
                lastProgress = tick;
            }
            return tick - since >= EDGE_TICKS || crossing && tick - lastProgress >= 16;
        }
    }

    private final MinecraftClient client;
    private final AgentBody body;
    private final AgentOrdinaryRoute route = new AgentOrdinaryRoute();
    private final EdgeTravel travel = new EdgeTravel();
    private final FrontierView frontierView = new FrontierView();
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
    private long rendered = -1, lookAt = NO_CELL, lookCue = NO_CELL, adjustAt = NO_CELL;
    private long recallAt = NO_CELL, recalled = NO_CELL, gradeFrame = -1;
    private int lastScan = -100, lookSince, adjustSince, gradeAt = -100;
    private int unavailableSince = -1;
    private float lookYaw, lookPitch;
    private float retraceYaw = Float.NaN;
    private boolean justWalkedReturn;
    private boolean foodScoutHandoff;
    private boolean exhaustedFoodView;
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
        lastScan = -100;
        unavailableSince = -1;
        foodScoutHandoff = false;
        exhaustedFoodView = false;
        stage = "idle";
        lastVeto = "";
        releaseEdge();
        travel.forgetLanding();
    }

    boolean driving() {
        return travel.crossing && player == client.player && world == client.world && travel.ownsTurn(body.actionTick());
    }

    boolean driving(Job owner) { return job == owner && driving(); }

    /** Pay only for an existing request. This observes terrain but never turns or drives. */
    void prepareObservation(Job owner, int tick) {
        if (lookAt == NO_CELL || job != owner || world != client.world || player != client.player) return;
        BlockPos foot = player.getBlockPos();
        if (foot.asLong() == lookAt && body.ordinaryRouteContact(foot)) readFrontierView(lookAt, tick);
    }

    boolean hasObservedPath(BlockPos from, BlockPos to, int tick) {
        return world == client.world && player == client.player && route.hasPath(from.asLong(), to.asLong(), tick);
    }

    boolean foodScoutHandoff() { return foodScoutHandoff; }
    boolean foodFrontierExhausted() { return exhaustedFoodView; }

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
        int action = body.actionTick();
        remember(from, to, action);
        travel.noteLanding(from, to, action);
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
        exhaustedFoodView = false;
        int action = body.actionTick();
        boolean inputs = body.ordinaryRouteInputs();
        if (!inputs) travel.forgetLanding();
        // A genuinely different owner, unsupported controls, or a skipped turn cannot
        // certify the same body path. A neutral turn due only to render loss can.
        if (from != null && (!inputs || job != requested || !travel.keepTurn(action))) releaseEdge();
        boolean changed = changed(requested, destination, arrivalRadius, minFootY, maxFootY);
        // The same job cannot change destinations midair or while still crossing a
        // descent: vanilla's grounded flag can stay set past the source cell line.
        if (changed && !(travel.crossing && (!player.isOnGround() || to.getY() < from.getY()))) {
            setIntent(requested, destination, arrivalRadius, minFootY, maxFootY);
            changed = false;
        }
        if (travel.crossing && !travel.observe(player.getPos())) reject("discontinuous motion", Integer.MAX_VALUE);
        if (!inputs || !body.hasRecentView()) {
            if (from != null && travel.expired(tick, along())) {
                progressBound(tick, body.ordinaryRoutePhysicalContact(from));
                stage = "waiting for render after edge bound";
                return Result.BLOCKED;
            }
            if (unavailableSince < 0) unavailableSince = tick;
            stage = !inputs ? "waiting for safe dry controls"
                : from == null ? "waiting for a fresh terrain frame" : "waiting for render on queued edge";
            if (tick - unavailableSince < LOOK_TICKS) return Result.OBSERVING;
            releaseEdge();
            stage = !inputs ? "dry controls bound" : "stale terrain frame bound";
            return Result.BLOCKED;
        }
        unavailableSince = -1;

        BlockPos foot = player.getBlockPos();
        boolean grounded = body.ordinaryRouteContact(foot);
        if (from != null && grounded && !foot.equals(from) && !foot.equals(to)) releaseEdge();
        if (from == null && (!grounded || !foot.equals(travel.landedTo))) travel.forgetLanding();

        if (travel.crossing && grounded && foot.equals(to) && settledAlong()) {
            boolean foodHandoff = requested == Job.FOOD && destination == null && !straightSuccessor();
            remember(from, to, tick);
            body.recordWalkedLeg(from, to);
            this.arrival = new Arrival(from, to);
            travel.noteLanding(from, to, action);
            releaseEdge();
            if (changed) {
                stage = "settled on queued edge";
                return Result.MOVING;
            }
            if (foodHandoff) {
                // Keep a continuous level lane, but give the food owner a
                // grounded frame before committing the next turn or grade.
                foodScoutHandoff = true;
                body.pauseWork();
                stage = "settled for a food-search handoff";
                return Result.OBSERVING;
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
            if (lookAt != here && (from == null || from.getY() == to.getY() || travel.crossing))
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
                travel.begin(action, tick);
                justWalkedReturn = travel.recentFlatReturn(from, to, action);
                retraceYaw = travel.flatRetraceYaw(from, to, route.hop(1), bearing, player.getYaw(), action);
                lookAt = lookCue = NO_CELL;
            }
            if (!travel.crossing && from.getY() != to.getY() && tick - gradeAt > GRADE_AGE) {
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
                    if (tick - travel.since >= LOOK_TICKS) {
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
            if (travel.expired(tick, along())) {
                progressBound(tick, grounded && foot.equals(from));
                continue;
            }
            if (!travel.crossing && !travel.recentLanding(action)) retraceYaw = Float.NaN;
            AgentBody.OrdinaryMotor turn = AgentBody.OrdinaryMotor.REORIENT;
            if (Float.isFinite(retraceYaw))
                turn = body.driveOrdinaryFlatRetrace(from, to, bearing, travel.crossing);
            if (turn == AgentBody.OrdinaryMotor.REORIENT) {
                retraceYaw = Float.NaN;
                turn = body.driveOrdinaryRoute(from, to, bearing, straightSuccessor(), travel.crossing);
            }
            if (turn == AgentBody.OrdinaryMotor.VETO) {
                reject("live body sweep or hazard", Float.isFinite(retraceYaw) ? tick + RETRY_TICKS : Integer.MAX_VALUE);
                continue;
            }
            if (!travel.crossing && turn == AgentBody.OrdinaryMotor.KEY) travel.startMotion(player.getPos());
            float pitch = to.getY() > from.getY() ? 19 : to.getY() < from.getY() ? 43 : TRAVEL_PITCH;
            // Look beyond the adjacent contact along a continuous level prefix. Reaching
            // one tile of that prefix does not create a new yaw or a separate observation.
            // A retrace keeps the previous view; the subsequent edge can steer for itself.
            boolean retracing = Float.isFinite(retraceYaw);
            body.turn(retracing ? retraceYaw : bearing.getPositiveHorizontalDegrees(), pitch);
            stage = switch (turn) {
                case ALIGN -> "aligning with path";
                case CENTER -> "centering on occupied tread";
                case COAST -> "coasting on proved edge";
                default -> retracing ? "retracing one dry tread" : pitch == 19 ? "jumping queued rise"
                    : pitch == 43 ? "walking queued descent" : "walking queued flat";
            };
            return travel.crossing || turn == AgentBody.OrdinaryMotor.CENTER ? Result.MOVING : Result.OBSERVING;
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
        if (!travel.traversed() || !AgentBody.dryStrideContact(1 - along())) return false;
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

    private void progressBound(int tick, boolean stoodAtSource) {
        if (!justWalkedReturn || !stoodAtSource || !route.deferWalked(from.asLong(), to.asLong(), tick + RETRY_TICKS)) {
            reject("edge progress bound", Integer.MAX_VALUE);
            return;
        }
        // A retry must still pass the live lane and motor checks, and cannot defer again.
        travel.forgetLanding();
        lastVeto = "walked return deferred after progress bound";
        releaseEdge();
    }

    private void releaseEdge() {
        from = to = null;
        bearing = null;
        retraceYaw = Float.NaN;
        justWalkedReturn = false;
        travel.crossing = false;
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
                exhaustedFoodView = job == Job.FOOD && target == null;
                return Result.BLOCKED;
            }
            lookAt = here;
            lookSince = tick;
            frontierView.begin(body.renderedFrame());
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
        Sight observation = readFrontierView(here, tick);
        if (frontierView.complete(route, here, tick)) {
            if (lookCue == recalled) recallAt = recalled = NO_CELL;
            lookAt = lookCue = NO_CELL;
            if (route.hop(0) == NO_CELL) {
                body.pauseWork();
                stage = "no connected dry route; " + frontierView.detail();
                exhaustedFoodView = job == Job.FOOD && target == null;
                return Result.BLOCKED;
            }
            stage = "found a reachable route after directed look; " + frontierView.detail();
            return Result.OBSERVING;
        }
        if (tick - lookSince >= LOOK_TICKS) {
            // A missing or starved render is not terrain evidence. Stop turning;
            // an affordable frame at this stance can still resolve the request.
            body.pauseWork();
            stage = "directed view deferred: " + observation.detail;
            return Result.BLOCKED;
        }
        body.turn(lookYaw, lookPitch);
        stage = (lookCue == NO_CELL ? "one directed terrain look" : "reconnecting to a witnessed terrain cue")
            + ": " + observation.detail;
        return Result.OBSERVING;
    }

    private Sight readFrontierView(long here, int tick) {
        long frame = body.renderedFrame();
        boolean facing = body.renderedDirection(lookYaw, lookPitch, 5);
        Sight admission = frontierView.admit(frame, body.ordinaryRouteViewCurrent(),
            facing || tick - lookSince >= LOOK_TICKS, body.generalRaysRemaining());
        if (admission != Sight.READY) return admission;
        Sight result = observe(here, tick, true);
        frontierView.pay(frame, result, facing);
        return result;
    }

    private Sight observe(long here, int tick, boolean directed) {
        long frame = body.renderedFrame();
        if (frame == rendered || !directed && tick - lastScan < 3) return Sight.STALE_FRAME;
        int available = body.generalRaysRemaining();
        if (available < (directed ? DIRECTED_RAYS : RAY_RESERVE + 2)) return Sight.RAY_BUDGET;
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
        boolean neighbor = false;
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
                    if (forward) {
                        route.observe(source, next, tick);
                        if (source == here) neighbor = true;
                    }
                    if (rise == 0 ? forward : body.ordinaryRouteLane(sightTo, sightFrom) == AgentBody.DryRouteVeto.CLEAR)
                        route.observe(next, source, tick);
                    if (forward && sight[n] == SEEN && tail < SIGHT_NODES) {
                        sight[n] = QUEUED;
                        sightQueue[tail++] = next;
                    }
                }
            }
        }
        if (neighbor) return Sight.NEIGHBOR;
        return outlined != NO_CELL || body.generalRaysRemaining() < available ? Sight.NO_NEIGHBOR : Sight.NO_PROJECTED_SUPPORT;
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
