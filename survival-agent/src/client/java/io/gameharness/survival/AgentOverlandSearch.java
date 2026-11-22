package io.gameharness.survival;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayList;
import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** Ordinary supply prospecting. A horizon is a preference, never a route or permission to move. */
final class AgentOverlandSearch {
    private static final int MAX_LEG = 4, LOOK_TICKS = 38, DRIVE_TICKS = 65, RETRACE_LIMIT = 8;
    private static final int VIEW_INTERVAL = 12, TIMBER_REFUSALS = 24;
    private static final float FLOOR_PITCH = 33, HORIZON_PITCH = 5;

    private enum Phase { CENTER, HORIZON, FLOOR, CLEARANCE, DRIVE, STOPPED }
    record Arrival(BlockPos from, BlockPos foot) {}
    record CanopyLaneRefusal(BlockPos foot, Direction bearing, boolean lowerTop, BlockPos riser) {}

    static boolean resourceInputAllowed(boolean safe, boolean grounded, boolean driving, boolean previousTurn) {
        // An interrupted committed tread cannot resume, even if the player is now grounded.
        return safe && (driving ? previousTurn : grounded);
    }

    /** A resource gives a direction and a stopping band, never a supporting surface. */
    record ResourceGoal(Vec3d point, double arrival, double minFootY, double maxFootY) {
        static final double SETTLE_PAD = 0.09;

        boolean atHeight(double y) { return y >= minFootY && y <= maxFootY; }

        boolean reached(Vec3d feet) {
            // The real body can settle a fraction short of the nominal tile center.
            return atHeight(feet.y) && horizontal(feet.x, feet.z) <= arrival + SETTLE_PAD;
        }

        boolean reached(BlockPos foot) {
            return atHeight(foot.getY()) && horizontal(foot.getX() + 0.5, foot.getZ() + 0.5) <= arrival;
        }

        private double horizontal(double x, double z) {
            return Math.hypot(x - point.x, z - point.z);
        }

        private double remaining(BlockPos foot) {
            double height = Math.max(0, Math.max(minFootY - foot.getY(), foot.getY() - maxFootY));
            return Math.max(0, horizontal(foot.getX() + 0.5, foot.getZ() + 0.5) - arrival) + 1.3 * Math.ceil(height);
        }
    }

    /** Only actual landings are remembered. A camera turn, offered floor, or motor request is not travel. */
    static final class Course {
        private final LongOpenHashSet walked = new LongOpenHashSet();
        private final ArrayList<BlockPos> crumbs = new ArrayList<>(RETRACE_LIMIT + 1);
        private final ArrayList<BlockPos> timberRefusals = new ArrayList<>();
        private Direction horizon, side;
        private int newFootings;

        void start(BlockPos foot, Direction bearing) {
            if (horizon == null) {
                horizon = bearing;
                side = bearing.rotateYClockwise();
            }
            walked.add(foot.asLong());
            settle(foot, false);
        }

        void restart(Direction bearing) {
            horizon = bearing;
            side = bearing.rotateYClockwise();
            walked.clear();
            crumbs.clear();
            newFootings = 0;
        }

        Direction horizon() { return horizon; }
        int newFootings() { return newFootings; }

        Direction bearing(int option) {
            return switch (option) {
                case 0 -> horizon;
                case 1 -> side;
                case 2 -> side.getOpposite();
                case 3 -> horizon.getOpposite();
                default -> throw new IllegalArgumentException("No such surface bearing");
            };
        }

        boolean canExtend(BlockPos from, BlockPos to, Direction lane, int alreadyProved) {
            return connected(from, to, lane, alreadyProved) && !walked.contains(to.asLong());
        }

        private static boolean connected(BlockPos from, BlockPos to, Direction lane, int alreadyProved) {
            int rise = to.getY() - from.getY();
            return lane.getAxis().isHorizontal()
                && to.getX() - from.getX() == lane.getOffsetX()
                && to.getZ() - from.getZ() == lane.getOffsetZ()
                && (rise == 0 || alreadyProved == 0 && Math.abs(rise) == 1);
        }

        boolean walkedSupport(BlockPos support) {
            return walked.contains(support.up().asLong());
        }

        boolean offerResource(BlockPos from, BlockPos to, Direction lane, int alreadyProved,
                              ResourceGoal goal, Predicate<BlockPos> witnessed) {
            return canExtend(from, to, lane, alreadyProved) && goalward(from, to, goal) && witnessed.test(to);
        }

        boolean offerTimberResource(BlockPos from, BlockPos to, Direction lane, int alreadyProved,
                                    ResourceGoal goal, Predicate<BlockPos> witnessed) {
            // A new collection may need to cross familiar ground. Goalward steps forbid loops.
            return connected(from, to, lane, alreadyProved) && timberFooting(to)
                && goalward(from, to, goal) && witnessed.test(to);
        }

        private static boolean goalward(BlockPos from, BlockPos to, ResourceGoal goal) {
            return !goal.reached(from)
                && (goal.reached(to) || goal.remaining(to) + 0.09 < goal.remaining(from));
        }

        boolean timberFooting(BlockPos foot) { return !timberRefusals.contains(foot); }

        boolean timberRefusalNear(BlockPos foot) {
            for (int i = 0; i < timberRefusals.size(); i++) {
                if (foot.getSquaredDistance(timberRefusals.get(i)) <= 9) return true;
            }
            return false;
        }

        void rememberTimberRefusal(BlockPos foot, Direction bearing) {
            start(foot, bearing);
            if (!timberRefusals.remove(foot) && timberRefusals.size() == TIMBER_REFUSALS) timberRefusals.removeFirst();
            timberRefusals.add(foot.toImmutable());
        }

        void changedTimberFooting(BlockPos block) {
            for (int i = timberRefusals.size() - 1; i >= 0; i--) {
                var foot = timberRefusals.get(i);
                if (Math.abs(foot.getX() - block.getX()) + Math.abs(foot.getZ() - block.getZ()) <= 1
                        && Math.abs(foot.getY() - block.getY()) <= 2) timberRefusals.remove(i);
            }
        }

        void clearTimberRefusals() { timberRefusals.clear(); }

        private void settle(BlockPos foot, boolean checkedTread) {
            if (!crumbs.isEmpty() && foot.equals(crumbs.getLast())) return;
            int known = crumbs.lastIndexOf(foot);
            if (known >= 0) {
                while (crumbs.size() > known + 1) crumbs.removeLast();
                return;
            }
            // Recovery can return to a verified tread. An unknown footing cannot join that route.
            if (!checkedTread) crumbs.clear();
            else if (crumbs.size() == RETRACE_LIMIT + 1) crumbs.removeFirst();
            crumbs.add(foot.toImmutable());
        }

        boolean arrived(BlockPos foot) {
            settle(foot, true);
            if (!walked.add(foot.asLong())) return false;
            ++newFootings;
            return true;
        }

        BlockPos previous(BlockPos foot) {
            int n = crumbs.size();
            if (n < 2 || !crumbs.getLast().equals(foot)) return null;
            BlockPos prior = crumbs.get(n - 2);
            return Math.abs(prior.getY() - foot.getY()) <= 1
                && Math.abs(prior.getX() - foot.getX()) + Math.abs(prior.getZ() - foot.getZ()) == 1
                    ? prior : null;
        }

        void retraced() { crumbs.removeLast(); }

        void finishLeg(Direction lane) {
            if (lane == horizon.getOpposite()) {
                horizon = lane;
                side = lane.rotateYClockwise();
            } else if (lane != horizon) side = lane;
        }
    }

    private final MinecraftClient client;
    private final AgentBody body;
    private final Predicate<BlockState> dangerous;
    private final Course course = new Course();
    private final BlockPos[] path = new BlockPos[MAX_LEG];
    private final BlockState[] supports = new BlockState[MAX_LEG];
    private final Predicate<BlockPos> witnessFloor = this::witness;
    private Phase phase = Phase.CENTER;
    private Direction lane;
    private BlockPos stance, blockedStance, origin, landmark, returnFoot;
    private BlockPos canopyBranchFoot, shownRiser;
    private Direction canopyBranch;
    private CanopyLaneRefusal canopyRefusal;
    private Arrival arrival;
    private int option, length, since, skylineViews, lastSkyline, legs, landmarkUntil;
    private long skylineFrame;
    private double farthest;
    private boolean risingView, refused, triedLower, canopyLeg, timberResource;
    private ResourceGoal resource;
    private String status = "overland search: preparing to look for supplies";

    AgentOverlandSearch(MinecraftClient client, AgentBody body, Predicate<BlockState> dangerous) {
        this.client = client;
        this.body = body;
        this.dangerous = dangerous;
    }

    boolean driving() { return phase == Phase.DRIVE; }
    boolean stopped() { return phase == Phase.STOPPED; }
    boolean guidingResource(ResourceGoal goal) { return resource != null && resource == goal; }
    boolean guiding(int tick) { return landmark != null && tick < landmarkUntil; }
    boolean owns(BlockPos foot) { return foot.equals(stance) && phase != Phase.STOPPED; }
    boolean leased(int tick) { return stance != null && phase != Phase.STOPPED && tick - since <= DRIVE_TICKS; }
    String status() { return status; }
    boolean walkedSupport(BlockPos block) { return course.walkedSupport(block); }
    boolean untriedCanopyTread(BlockPos foot, BlockPos to, Direction bearing) {
        return course.timberFooting(to) && course.canExtend(foot, to, bearing, 0);
    }

    CanopyLaneRefusal takeCanopyLaneRefusal() {
        var result = canopyRefusal;
        canopyRefusal = null;
        return result;
    }

    boolean canopyLanesExhausted(BlockPos foot) {
        return foot.equals(stance) && (stopped() || returnFoot != null && !driving());
    }

    /** A newly opened or independently re-witnessed branch changes the heading, not the walked course. */
    void recheckCanopyBranch(BlockPos foot, Direction bearing) {
        if (foot.equals(blockedStance)) blockedStance = null;
        canopyBranchFoot = foot;
        canopyBranch = bearing;
        returnFoot = null;
        stance = null;
        phase = Phase.CENTER;
        refused = false;
    }

    /** Adopt the separately proved and settled reversible step without losing its return breadcrumb. */
    void landedCanopyTread(BlockPos from, BlockPos foot, Direction bearing) {
        course.start(from, bearing);
        course.arrived(foot);
        if (from.equals(blockedStance)) blockedStance = null;
        recheckCanopyBranch(foot, bearing);
    }

    Arrival takeArrival() {
        Arrival result = arrival;
        arrival = null;
        return result;
    }

    boolean takeRefusal() {
        boolean result = refused;
        refused = false;
        return result;
    }

    void interrupt() {
        phase = Phase.CENTER;
        stance = null;
        landmark = null;
        returnFoot = null;
        resource = null;
        timberResource = false;
        canopyBranchFoot = null;
        canopyBranch = null;
        canopyRefusal = null;
    }

    /** Start a new search with a real preferred bearing, not a fictitious witnessed landmark. */
    void restart(Direction bearing) {
        interrupt();
        course.restart(bearing);
        blockedStance = origin = null;
        refused = risingView = false;
        arrival = null;
        legs = lastSkyline = 0;
        farthest = 0;
    }

    void guide(BlockPos witness, int tick) {
        resource = null;
        timberResource = false;
        landmark = witness;
        landmarkUntil = tick + 150;
        phase = Phase.CENTER;
        since = tick;
        option = 0;
        returnFoot = null;
    }

    void guideResource(ResourceGoal goal) {
        restart(client.player.getHorizontalFacing());
        resource = goal;
    }

    void guideTimberCollection(ResourceGoal goal) {
        // A new trunk changes the preferred bearing, not where we have already looked for footing.
        interrupt();
        if (client.player.getBlockPos().equals(blockedStance)) blockedStance = null;
        resource = goal;
        timberResource = true;
    }

    void rememberTimberRefusal(BlockPos foot) {
        course.rememberTimberRefusal(foot, client.player.getHorizontalFacing());
    }

    boolean timberRefusalNear(BlockPos foot) { return course.timberRefusalNear(foot); }
    void changedTimberFooting(BlockPos block) { course.changedTimberFooting(block); }
    void clearTimberRefusals() { course.clearTimberRefusals(); }

    void changed(BlockPos position) {
        changedTimberFooting(position);
        if (blockedStance != null && position.getSquaredDistance(blockedStance) <= 9) {
            blockedStance = null;
            if (phase == Phase.STOPPED) interrupt();
        }
    }

    void step(int tick) {
        step(tick, false, false);
    }

    void step(int tick, boolean canopy, boolean scoutTimber) {
        var player = client.player;
        BlockPos foot = player.getBlockPos();
        if (driving()) {
            drive(tick, foot);
            return;
        }
        if (player.isTouchingWater() || player.isInLava() || player.hasVehicle() || player.isOnFire()
                || player.hurtTime > 0 || !player.isOnGround()) {
            interrupt();
            status = "overland search: waiting for settled dry footing";
            return;
        }
        if (foot.equals(blockedStance)) {
            phase = Phase.STOPPED;
            return;
        }
        if (!foot.equals(stance)) {
            if (!foot.equals(canopyBranchFoot)) canopyBranch = null;
            stance = foot.toImmutable();
            if (origin == null) origin = stance;
            course.start(stance, player.getHorizontalFacing());
            phase = Phase.CENTER;
            since = tick;
            option = 0;
            returnFoot = null;
        }
        if (landmark != null && (tick >= landmarkUntil || stance.getSquaredDistance(landmark) <= 6)) landmark = null;
        if (tick - since > LOOK_TICKS) {
            if (phase == Phase.CENTER) stop("could not settle at a full support center");
            else if (phase == Phase.HORIZON) beginBearing(tick);
            else if (returnFoot == null) refuseBearing(tick, canopy && body.hasRecentView());
            else stop("could not re-witness the last walked connection");
            return;
        }
        if (!body.hasRecentView()) return;
        switch (phase) {
            case CENTER -> {
                if (resource != null && resource.reached(player.getPos()) && settledMotion()) return;
                double tolerance = resource != null && resource.reached(stance) ? 0.09 : 0.14;
                if (!centered(stance, tolerance) || Math.abs(player.getY() - stance.getY()) > 0.055) {
                    if (resource == null || !body.centerOnGroundedSupport(stance, body.dryCaveContact(stance)))
                        body.centerOnSupport(stance.down());
                    status = "overland search: centering on the current foothold";
                } else if (settledMotion()) {
                    if (resource == null && (risingView || course.newFootings() - lastSkyline >= VIEW_INTERVAL)) beginHorizon(tick);
                    else beginBearing(tick);
                }
            }
            case HORIZON -> horizon(tick);
            case FLOOR -> floors(tick, canopy, scoutTimber);
            case CLEARANCE -> clearance(tick, canopy);
            default -> throw new IllegalStateException("Unexpected surface-search phase " + phase);
        }
    }

    private void beginHorizon(int tick) {
        phase = Phase.HORIZON;
        since = tick;
        skylineViews = 0;
        skylineFrame = body.renderedFrame();
        risingView = false;
        lastSkyline = course.newFootings();
        status = "overland search: checking the horizon from newly reached ground";
    }

    private void horizon(int tick) {
        float yaw = preferredBearing().getPositiveHorizontalDegrees();
        body.turn(yaw, HORIZON_PITCH);
        long frame = body.renderedFrame();
        if (frame != skylineFrame && body.renderedDirection(yaw, HORIZON_PITCH, 8)) {
            skylineFrame = frame;
            if (++skylineViews >= 3) beginBearing(tick);
        }
    }

    private void beginBearing(int tick) {
        phase = Phase.FLOOR;
        Direction bearing = preferredBearing();
        lane = landmark == null && resource == null && canopyBranch == null ? course.bearing(option) : switch (option) {
            case 0 -> bearing;
            case 1 -> bearing.rotateYClockwise();
            case 2 -> bearing.rotateYCounterclockwise();
            default -> bearing.getOpposite();
        };
        length = 0;
        triedLower = false;
        shownRiser = null;
        since = tick;
        status = "overland search: checking a continuous lane " + lane.asString()
            + (landmark == null && resource == null ? "" : " toward a witnessed supply site");
    }

    private Direction preferredBearing() {
        if (canopyBranch != null) return canopyBranch;
        if (landmark == null && resource == null) return course.horizon();
        double x = resource == null ? landmark.getX() - stance.getX() : resource.point.x - stance.getX() - 0.5;
        double z = resource == null ? landmark.getZ() - stance.getZ() : resource.point.z - stance.getZ() - 0.5;
        if (Math.abs(x) > Math.abs(z)) return x > 0 ? Direction.EAST : Direction.WEST;
        if (z != 0) return z > 0 ? Direction.SOUTH : Direction.NORTH;
        return course.horizon();
    }

    private void nextBearing(int tick) {
        if (returnFoot != null) {
            stop("could not re-witness the last walked connection");
        } else if (++option != 4) {
            beginBearing(tick);
        } else {
            if (resource != null) {
                stop("no goalward lane with visible dry footing and clearance");
                return;
            }
            returnFoot = course.previous(stance);
            if (returnFoot == null) {
                stop("no new lane with visible dry footing and clearance");
                return;
            }
            int dx = returnFoot.getX() - stance.getX(), dz = returnFoot.getZ() - stance.getZ();
            lane = dx > 0 ? Direction.EAST : dx < 0 ? Direction.WEST : dz > 0 ? Direction.SOUTH : Direction.NORTH;
            length = 0;
            phase = Phase.FLOOR;
            since = tick;
            status = "overland search: rechecking a walked connection to try a different branch";
        }
    }

    private void floors(int tick, boolean canopy, boolean scoutTimber) {
        float yaw = lane.getPositiveHorizontalDegrees();
        float pitch = resource != null && stance.getY() > resource.maxFootY ? 45 : FLOOR_PITCH;
        body.turn(yaw, pitch);
        if (!body.renderedDirection(yaw, pitch, 5)) return;
        BlockPos next = stance.offset(lane);
        if (returnFoot != null) {
            if (!witness(returnFoot)) {
                nextBearing(tick);
                return;
            }
        } else if (canopy && !triedLower && !client.options.jumpKey.isUnbound() && offer(stance, next.down(), scoutTimber)) {
            triedLower = true;
        } else if (offer(stance, next, scoutTimber)) {
            for (int i = 1; i < MAX_LEG; i++) {
                BlockPos farther = next.offset(lane);
                if (!offer(next, farther, scoutTimber)) break;
                next = farther;
            }
        } else if (offer(stance, next.up(), scoutTimber)) {
            shownRiser = next;
        } else if (triedLower || !offer(stance, next.down(), scoutTimber)) {
            refuseBearing(tick, canopy);
            return;
        }
        phase = Phase.CLEARANCE;
        since = tick;
    }

    private boolean offer(BlockPos from, BlockPos next, boolean scoutTimber) {
        if (resource == null)
            return (!scoutTimber || course.timberFooting(next)) && course.canExtend(from, next, lane, length) && witness(next);
        return timberResource ? course.offerTimberResource(from, next, lane, length, resource, witnessFloor)
            : course.offerResource(from, next, lane, length, resource, witnessFloor);
    }

    private boolean witness(BlockPos next) {
        BlockState support = body.overlandTop(next.down(), lane, dangerous);
        if (support == null) return false;
        path[length] = next;
        supports[length++] = support;
        return true;
    }

    private void clearance(int tick, boolean canopy) {
        float yaw = lane.getPositiveHorizontalDegrees();
        int rise = path[0].getY() - stance.getY();
        float pitch = rise > 0 ? -6 : rise < 0 && resource != null ? 45 : FLOOR_PITCH;
        body.turn(yaw, pitch);
        if (!body.renderedDirection(yaw, pitch, 5)) return;
        for (int i = 0; i < length; i++) {
            Vec3d sample = Vec3d.ofBottomCenter(path[i]).add(lane.getOffsetX() * 0.30, 0, lane.getOffsetZ() * 0.30);
            if (!body.overlandClear(sample.add(0, 0.32, 0), dangerous)
                    || !body.overlandClear(sample.add(0, 1.33, 0), dangerous)) {
                length = i;
                break;
            }
        }
        while (length > 0 && !body.overlandLane(stance, path, supports, length, lane, dangerous)) length--;
        if (length > 0 && canopy && !reversibleCanopyGrade(path[0])) length = 0;
        if (length == 0) {
            if (canopy && rise < 0 && triedLower && returnFoot == null) {
                // A blocked descent must not hide a usable level or rising tread on the same bearing.
                phase = Phase.FLOOR;
                since = tick;
            } else {
                refuseBearing(tick, canopy);
            }
            return;
        }
        canopyLeg = canopy;
        phase = Phase.DRIVE;
        since = tick;
        status = returnFoot != null ? "overland search: returning one checked step to a different branch"
            : rise > 0 ? "overland search: jumping the witnessed rise"
            : rise < 0 ? "overland search: stepping down to the witnessed landing"
            : "overland search: walking " + length + " connected blocks " + lane.asString();
        drive(tick, stance);
    }

    private void refuseBearing(int tick, boolean canopy) {
        if (canopy && returnFoot == null) canopyRefusal = new CanopyLaneRefusal(stance, lane, triedLower, shownRiser);
        nextBearing(tick);
    }

    private boolean reversibleCanopyGrade(BlockPos to) {
        boolean descending = stance.getY() > to.getY();
        if (stance.getY() == to.getY()) return true;
        return !client.options.jumpKey.isUnbound() && (descending
            ? AgentSurfaceTread.reverseClear(client, stance, to, lane)
            : AgentSurfaceTread.reverseClear(client, to, stance, lane.getOpposite()));
    }

    private void drive(int tick, BlockPos foot) {
        var player = client.player;
        BlockPos to = path[length - 1];
        if (tick - since > DRIVE_TICKS) {
            abandonLeg(tick, foot, "the bounded walk did not reach its checked landing");
            return;
        }
        if (!body.hasRecentView()) return;
        if (!body.overlandLane(stance, path, supports, length, lane, dangerous)
                || canopyLeg && !reversibleCanopyGrade(path[0])) {
            abandonLeg(tick, foot, "the observed lane changed or the player left its sweep");
            return;
        }
        if (returnFoot == null && player.isOnGround()
                && Math.abs(player.getY() - foot.getY()) <= 0.055 && centered(foot, 0.25)) {
            for (int i = 0; i < length; i++) {
                if (foot.equals(path[i])) {
                    course.arrived(foot);
                    break;
                }
            }
        }
        if (player.isOnGround() && to.equals(foot) && Math.abs(player.getY() - to.getY()) <= 0.055) {
            if (!centered(to, 0.20)) {
                body.centerOnSupport(to.down());
                return;
            }
            if (!settledMotion()) return;
            BlockPos from = stance;
            stance = to;
            if (!to.equals(canopyBranchFoot)) canopyBranch = null;
            phase = Phase.CENTER;
            since = tick;
            option = 0;
            if (returnFoot != null) {
                course.retraced();
                returnFoot = null;
                status = "overland search: returned to " + to.toShortString() + " to try a different branch";
                return;
            }
            if (landmark == null) course.finishLeg(lane);
            farthest = Math.max(farthest, Math.hypot(to.getX() - origin.getX(), to.getZ() - origin.getZ()));
            arrival = new Arrival(from, to);
            risingView |= to.getY() > from.getY();
            status = "overland leg " + ++legs + ": settled " + from.toShortString() + " -> " + to.toShortString()
                + "; " + course.newFootings() + " new footholds, " + Math.round(farthest) + " blocks from search start";
            return;
        }
        body.driveDryRoute(stance, to, lane);
    }

    private void abandonLeg(int tick, BlockPos foot, String why) {
        if (foot.equals(stance) && client.player.isOnGround()) nextBearing(tick);
        else {
            interrupt();
            status = "overland search: rechecking footing after " + why;
        }
    }

    private void stop(String why) {
        phase = Phase.STOPPED;
        if (resource == null) blockedStance = stance;
        refused = true;
        status = "overland search stopped at " + stance.toShortString() + ": " + why;
    }

    private boolean settledMotion() {
        return client.player.getVelocity().horizontalLengthSquared() <= 0.0025;
    }

    private boolean centered(BlockPos cell, double tolerance) {
        var p = client.player;
        return Math.abs(p.getX() - cell.getX() - 0.5) <= tolerance
            && Math.abs(p.getZ() - cell.getZ() - 0.5) <= tolerance;
    }
}
