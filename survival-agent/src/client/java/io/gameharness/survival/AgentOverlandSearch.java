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
    private static final int VIEW_INTERVAL = 12;
    private static final float FLOOR_PITCH = 33, HORIZON_PITCH = 5;

    private enum Phase { CENTER, HORIZON, FLOOR, CLEARANCE, DRIVE, STOPPED }
    record Arrival(BlockPos from, BlockPos foot) {}

    /** Only actual landings are remembered. A camera turn, offered floor, or motor request is not travel. */
    static final class Course {
        private final LongOpenHashSet walked = new LongOpenHashSet();
        private final ArrayList<BlockPos> crumbs = new ArrayList<>(RETRACE_LIMIT + 1);
        private Direction horizon, side;
        private int newFootings;

        void start(BlockPos foot, Direction bearing) {
            if (horizon == null) {
                horizon = bearing;
                side = bearing.rotateYClockwise();
            }
            walked.add(foot.asLong());
            if (crumbs.isEmpty() || !foot.equals(crumbs.getLast())) {
                crumbs.clear(); // An interruption need not have followed our checked route.
                crumbs.add(foot);
            }
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
            int rise = to.getY() - from.getY();
            return lane.getAxis().isHorizontal()
                && to.getX() - from.getX() == lane.getOffsetX()
                && to.getZ() - from.getZ() == lane.getOffsetZ()
                && (rise == 0 || alreadyProved == 0 && Math.abs(rise) == 1)
                && !walked.contains(to.asLong());
        }

        boolean arrived(BlockPos foot) {
            if (!walked.add(foot.asLong())) return false;
            if (crumbs.size() == RETRACE_LIMIT + 1) crumbs.removeFirst();
            crumbs.add(foot);
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
    private Phase phase = Phase.CENTER;
    private Direction lane;
    private BlockPos stance, blockedStance, origin, landmark, returnFoot;
    private Arrival arrival;
    private int option, length, since, skylineViews, lastSkyline, legs, landmarkUntil;
    private long skylineFrame;
    private double farthest;
    private boolean risingView, refused;
    private String status = "overland search: preparing to look for supplies";

    AgentOverlandSearch(MinecraftClient client, AgentBody body, Predicate<BlockState> dangerous) {
        this.client = client;
        this.body = body;
        this.dangerous = dangerous;
    }

    boolean driving() { return phase == Phase.DRIVE; }
    boolean guiding(int tick) { return landmark != null && tick < landmarkUntil; }
    boolean owns(BlockPos foot) { return foot.equals(stance) && phase != Phase.STOPPED; }
    boolean leased(int tick) { return stance != null && phase != Phase.STOPPED && tick - since <= DRIVE_TICKS; }
    String status() { return status; }

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
    }

    void guide(BlockPos witness, int tick) {
        landmark = witness;
        landmarkUntil = tick + 150;
        phase = Phase.CENTER;
        since = tick;
        option = 0;
        returnFoot = null;
    }

    void changed(BlockPos position) {
        if (blockedStance != null && position.getSquaredDistance(blockedStance) <= 9) {
            blockedStance = null;
            if (phase == Phase.STOPPED) interrupt();
        }
    }

    void step(int tick) {
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
            else if (returnFoot == null) nextBearing(tick);
            else stop("could not re-witness the last walked connection");
            return;
        }
        if (!body.hasRecentView()) return;
        switch (phase) {
            case CENTER -> {
                if (!centered(stance, 0.14) || Math.abs(player.getY() - stance.getY()) > 0.055) {
                    body.centerOnSupport(stance.down());
                    status = "overland search: centering on the current foothold";
                } else if (settledMotion()) {
                    if (risingView || course.newFootings() - lastSkyline >= VIEW_INTERVAL) beginHorizon(tick);
                    else beginBearing(tick);
                }
            }
            case HORIZON -> horizon(tick);
            case FLOOR -> floors(tick);
            case CLEARANCE -> clearance(tick);
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
        lane = landmark == null ? course.bearing(option) : switch (option) {
            case 0 -> bearing;
            case 1 -> bearing.rotateYClockwise();
            case 2 -> bearing.rotateYCounterclockwise();
            default -> bearing.getOpposite();
        };
        length = 0;
        since = tick;
        status = "overland search: checking a continuous lane " + lane.asString()
            + (landmark == null ? "" : " toward a witnessed supply landmark");
    }

    private Direction preferredBearing() {
        if (landmark == null) return course.horizon();
        int x = landmark.getX() - stance.getX(), z = landmark.getZ() - stance.getZ();
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

    private void floors(int tick) {
        float yaw = lane.getPositiveHorizontalDegrees();
        body.turn(yaw, FLOOR_PITCH);
        if (!body.renderedDirection(yaw, FLOOR_PITCH, 5)) return;
        BlockPos next = stance.offset(lane);
        if (returnFoot != null) {
            if (!witness(returnFoot)) {
                nextBearing(tick);
                return;
            }
        } else if (offer(stance, next)) {
            for (int i = 1; i < MAX_LEG; i++) {
                BlockPos farther = next.offset(lane);
                if (!offer(next, farther)) break;
                next = farther;
            }
        } else if (!offer(stance, next.up()) && !offer(stance, next.down())) {
            nextBearing(tick);
            return;
        }
        phase = Phase.CLEARANCE;
        since = tick;
    }

    private boolean offer(BlockPos from, BlockPos next) {
        return course.canExtend(from, next, lane, length) && witness(next);
    }

    private boolean witness(BlockPos next) {
        BlockState support = body.overlandTop(next.down(), lane, dangerous);
        if (support == null) return false;
        path[length] = next;
        supports[length++] = support;
        return true;
    }

    private void clearance(int tick) {
        float yaw = lane.getPositiveHorizontalDegrees();
        int rise = path[0].getY() - stance.getY();
        float pitch = rise > 0 ? -6 : FLOOR_PITCH;
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
        if (length == 0) {
            nextBearing(tick);
            return;
        }
        phase = Phase.DRIVE;
        since = tick;
        status = returnFoot != null ? "overland search: returning one checked step to a different branch"
            : rise > 0 ? "overland search: jumping the witnessed rise"
            : rise < 0 ? "overland search: stepping down to the witnessed landing"
            : "overland search: walking " + length + " connected blocks " + lane.asString();
        drive(tick, stance);
    }

    private void drive(int tick, BlockPos foot) {
        var player = client.player;
        BlockPos to = path[length - 1];
        if (tick - since > DRIVE_TICKS) {
            abandonLeg(tick, foot, "the bounded walk did not reach its checked landing");
            return;
        }
        if (!body.hasRecentView()) return;
        if (!body.overlandLane(stance, path, supports, length, lane, dangerous)) {
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
        blockedStance = stance;
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
