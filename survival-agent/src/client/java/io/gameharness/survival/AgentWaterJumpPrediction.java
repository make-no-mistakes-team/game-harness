package io.gameharness.survival;

import java.util.List;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;

/**
 * Bounded 1.21.4 dry-player motion hypothesis into an already observed water volume.
 * No world access, input execution, collision response, pool-depth claim or landing receipt.
 */
final class AgentWaterJumpPrediction {
    static final int MAX_RUNUP_TICKS = 24;
    static final int MAX_FLIGHT_TICKS = 80;
    static final int MAX_OBSERVATION_AGE = 20;
    private static final int MAX_OBSTACLES = 32;
    private static final double LIMIT = 30_000_000;
    private static final double VELOCITY_EPSILON = 0.003;

    enum Verdict {
        VIABLE, RISKY, SHORT, OVERSHOOT, MISS, VISIBLE_OBSTRUCTION,
        UNSUPPORTED, UNSUPPORTED_FLUID, KNOWN_HAZARD, MISSING_WATER, STALE, HORIZON
    }

    /**
     * Accelerations include the actual input magnitude (normally .98f).
     * Body supplies effective gravity, float-rounded jump strength/block multiplier/boost,
     * ground friction and actual sprint-sensitive air acceleration.
     * supported=false for unmodeled effects, fluids, gliding, climbing, flight, no-drag,
     * special-block motion, changing traction or unavailable own-physics observations.
     */
    record Physics(double gravity, double jumpVelocity, double groundAcceleration, double groundDrag,
                   double airAcceleration, double airDrag, double verticalDrag, boolean supported) {}

    /**
     * feet/velocity are measured at a tick boundary. jump=true models a grounded jump now,
     * or after runupTicks on a caller-checked constant-height/traction runway.
     * jump=false/runupTicks=0 continues an already airborne player, not a grounded walk.
     * The constant input bearing is arbitrary, normalized here, and is also sprint-jump yaw.
     */
    record Launch(Vec3d feet, Vec3d velocity, double width, double height, double directionX,
                  double directionZ, boolean jump, boolean sprintJump, int runupTicks, int observedTick) {}

    /** Bounds describe only witnessed water; maxY is its observed surface, not a full block assumption. */
    record WaterPatch(Box bounds, int observedTick, boolean stillWater, boolean knownHazard) {}

    /**
     * Entry is a swept-footprint hypothesis, with a whole-tick contact window and a geometric
     * tolerance, not a probability or guaranteed wet contact. Takeoff fields are the projected
     * pre-jump tick-boundary state after runup, NOT an observed velocity receipt.
     */
    record Result(Verdict verdict, Vec3d entryFeet, Vec3d entryVelocity, double entryTick,
                  double earliestEntryTick, double latestEntryTick, double horizontalUncertainty,
                  Vec3d projectedTakeoffFeet, Vec3d projectedTakeoffVelocity) {
        boolean viable() { return verdict == Verdict.VIABLE || verdict == Verdict.RISKY; }
    }

    private AgentWaterJumpPrediction() {}

    /**
     * LivingEntity.tickMovement/jump/travelMidAir and PlayerEntity.getOffGroundSpeed,
     * verified against the cached named 1.21.4 bytecode. Input acceleration precedes move;
     * gravity and sampled starting-ground friction follow move, including the jump tick.
     * Visible obstacles only veto; they never supply support or alter the trajectory.
     */
    static Result predict(Launch launch, Physics physics, WaterPatch water,
                          List<Box> visibleObstacles, int nowTick) {
        if (water == null || water.bounds() == null) return rejected(Verdict.MISSING_WATER);
        if (water.knownHazard()) return rejected(Verdict.KNOWN_HAZARD);
        if (!water.stillWater()) return rejected(Verdict.UNSUPPORTED_FLUID);
        if (launch == null || physics == null || !valid(launch, physics) || !valid(water.bounds())
                || visibleObstacles == null || visibleObstacles.size() > MAX_OBSTACLES)
            return rejected(Verdict.UNSUPPORTED);
        long launchAge = (long) nowTick - launch.observedTick();
        long waterAge = (long) nowTick - water.observedTick();
        // A runway forecast is never a substitute for this tick's own position/velocity.
        if (launchAge != 0 || waterAge < 0 || waterAge > MAX_OBSERVATION_AGE)
            return rejected(Verdict.STALE);
        for (int i = 0; i < visibleObstacles.size(); ++i) {
            if (!valid(visibleObstacles.get(i))) return rejected(Verdict.UNSUPPORTED);
        }
        double length = Math.hypot(launch.directionX(), launch.directionZ());
        double dx = launch.directionX() / length, dz = launch.directionZ() / length;
        double x = launch.feet().x, y = launch.feet().y, z = launch.feet().z;
        double vx = launch.velocity().x, vy = launch.velocity().y, vz = launch.velocity().z;
        double radius = launch.width() * 0.5;
        for (int i = 0; i < launch.runupTicks(); ++i) {
            vx = snap(vx) + dx * physics.groundAcceleration();
            vz = snap(vz) + dz * physics.groundAcceleration();
            if (obstructed(visibleObstacles, x, y, z, x + vx, y, z + vz, radius, launch.height()))
                return rejected(Verdict.VISIBLE_OBSTRUCTION);
            x += vx;
            z += vz;
            vx *= physics.groundDrag();
            vz *= physics.groundDrag();
            vy = -physics.gravity() * physics.verticalDrag();
        }
        Vec3d takeoffFeet = new Vec3d(x, y, z);
        Vec3d takeoffVelocity = new Vec3d(vx, vy, vz);
        Box patch = water.bounds();
        double uncertainty = 0.035 + Math.max(launchAge, waterAge) * 0.01;
        for (int tick = 0; tick < MAX_FLIGHT_TICKS; ++tick) {
            vx = snap(vx);
            vy = snap(vy);
            vz = snap(vz);
            boolean groundedJumpTick = tick == 0 && launch.jump();
            if (groundedJumpTick) {
                vy = Math.max(vy, physics.jumpVelocity());
                if (launch.sprintJump()) {
                    vx += dx * 0.2;
                    vz += dz * 0.2;
                }
            }
            double acceleration = groundedJumpTick ? physics.groundAcceleration() : physics.airAcceleration();
            vx += dx * acceleration;
            vz += dz * acceleration;
            double nextX = x + vx, nextY = y + vy, nextZ = z + vz;
            // Entity.move resolves vertical before horizontal. Both swept envelopes are
            // conservative for diagonal horizontal collision; no hidden geometry is queried.
            if (obstructed(visibleObstacles, x, y, z, x, nextY, z, radius, launch.height())
                    || obstructed(visibleObstacles, x, nextY, z, nextX, nextY, nextZ, radius, launch.height()))
                return rejected(Verdict.VISIBLE_OBSTRUCTION);

            if (vy < 0 && nextY < patch.maxY && y + launch.height() > patch.minY) {
                // The downward surface-crossing fraction is nominal; the actual axis-ordered
                // move/fluid-contact update can occur anywhere in this tick's swept window.
                double fraction = y >= patch.maxY ? Math.min(1, (y - patch.maxY) / -vy) : 0;
                double minX = patch.minX - radius, maxX = patch.maxX + radius;
                double minZ = patch.minZ - radius, maxZ = patch.maxZ + radius;
                double enter = 0, exit = 1;
                if (vx == 0) {
                    if (x <= minX || x >= maxX) enter = 2;
                } else {
                    double a = (minX - x) / vx, b = (maxX - x) / vx;
                    enter = Math.max(enter, Math.min(a, b));
                    exit = Math.min(exit, Math.max(a, b));
                }
                if (vz == 0) {
                    if (z <= minZ || z >= maxZ) enter = 2;
                } else {
                    double a = (minZ - z) / vz, b = (maxZ - z) / vz;
                    enter = Math.max(enter, Math.min(a, b));
                    exit = Math.min(exit, Math.max(a, b));
                }
                // Horizontal movement follows the vertical movement: a swept-only overlap
                // is admitted as risky even when it precedes the nominal linear fraction.
                if (enter < exit && exit > 0 && enter < 1 && nextY + launch.height() > patch.minY) {
                    double contact = Math.max(0, Math.min(exit, Math.max(enter, fraction)));
                    double entryX = x + vx * contact, entryZ = z + vz * contact;
                    double entryY = y + vy * Math.max(fraction, contact);
                    double margin = uncertainty + (tick + 1) * 0.003;
                    boolean interior = entryY >= patch.minY && Math.min(x, nextX) - radius - margin > patch.minX
                        && Math.max(x, nextX) + radius + margin < patch.maxX
                        && Math.min(z, nextZ) - radius - margin > patch.minZ
                        && Math.max(z, nextZ) + radius + margin < patch.maxZ;
                    return new Result(interior ? Verdict.VIABLE : Verdict.RISKY,
                        new Vec3d(entryX, entryY, entryZ), new Vec3d(vx, vy, vz),
                        launch.runupTicks() + tick + contact, launch.runupTicks() + tick,
                        launch.runupTicks() + tick + 2, margin, takeoffFeet, takeoffVelocity);
                }
            }
            x = nextX;
            y = nextY;
            z = nextZ;
            double drag = groundedJumpTick ? physics.groundDrag() : physics.airDrag();
            vx *= drag;
            vz *= drag;
            vy = (vy - physics.gravity()) * physics.verticalDrag();
            if (y + launch.height() < patch.minY && vy < 0) {
                double near = projectionMin(patch, dx, dz) - radius;
                double far = projectionMax(patch, dx, dz) + radius;
                double along = x * dx + z * dz;
                Verdict verdict = along < near ? Verdict.SHORT : along > far ? Verdict.OVERSHOOT : Verdict.MISS;
                return new Result(verdict, null, null, Double.NaN, Double.NaN, Double.NaN,
                    uncertainty + (tick + 1) * 0.003, takeoffFeet, takeoffVelocity);
            }
        }
        return new Result(Verdict.HORIZON, null, null, Double.NaN, Double.NaN, Double.NaN,
            uncertainty + MAX_FLIGHT_TICKS * 0.003, takeoffFeet, takeoffVelocity);
    }

    private static double projectionMin(Box box, double dx, double dz) {
        return (dx >= 0 ? box.minX : box.maxX) * dx + (dz >= 0 ? box.minZ : box.maxZ) * dz;
    }

    private static double projectionMax(Box box, double dx, double dz) {
        return (dx >= 0 ? box.maxX : box.minX) * dx + (dz >= 0 ? box.maxZ : box.minZ) * dz;
    }

    private static boolean obstructed(List<Box> obstacles, double x, double y, double z,
                                      double nx, double ny, double nz, double radius, double height) {
        double minX = Math.min(x, nx) - radius, maxX = Math.max(x, nx) + radius;
        double minY = Math.min(y, ny), maxY = Math.max(y, ny) + height;
        double minZ = Math.min(z, nz) - radius, maxZ = Math.max(z, nz) + radius;
        for (int i = 0; i < obstacles.size(); ++i) {
            Box box = obstacles.get(i);
            if (maxX > box.minX && minX < box.maxX && maxY > box.minY
                    && minY < box.maxY && maxZ > box.minZ && minZ < box.maxZ) return true;
        }
        return false;
    }

    private static double snap(double value) { return Math.abs(value) < VELOCITY_EPSILON ? 0 : value; }

    private static boolean valid(Launch launch, Physics physics) {
        return physics.supported() && valid(launch.feet()) && valid(launch.velocity())
            && Math.abs(launch.velocity().x) <= 20 && Math.abs(launch.velocity().y) <= 20
            && Math.abs(launch.velocity().z) <= 20
            && bounded(launch.width(), 0.01, 4) && bounded(launch.height(), 0.01, 4)
            && Double.isFinite(launch.directionX()) && Double.isFinite(launch.directionZ())
            && bounded(Math.hypot(launch.directionX(), launch.directionZ()), 1e-8, LIMIT)
            && launch.runupTicks() >= 0 && launch.runupTicks() <= MAX_RUNUP_TICKS
            && (launch.jump() || launch.runupTicks() == 0)
            && (!launch.sprintJump() || launch.jump())
            && bounded(physics.gravity(), 1e-6, 1) && bounded(physics.jumpVelocity(), 1e-5, 4)
            && bounded(physics.groundAcceleration(), 0, 1) && bounded(physics.airAcceleration(), 0, 1)
            && bounded(physics.groundDrag(), 1e-6, 0.999999)
            && bounded(physics.airDrag(), 1e-6, 0.999999)
            && bounded(physics.verticalDrag(), 1e-6, 0.999999);
    }

    private static boolean valid(Vec3d value) {
        return value != null && bounded(value.x, -LIMIT, LIMIT)
            && bounded(value.y, -LIMIT, LIMIT) && bounded(value.z, -LIMIT, LIMIT);
    }

    private static boolean valid(Box box) {
        return box != null && bounded(box.minX, -LIMIT, LIMIT) && bounded(box.maxX, -LIMIT, LIMIT)
            && bounded(box.minY, -LIMIT, LIMIT) && bounded(box.maxY, -LIMIT, LIMIT)
            && bounded(box.minZ, -LIMIT, LIMIT) && bounded(box.maxZ, -LIMIT, LIMIT)
            && box.minX < box.maxX && box.minY < box.maxY && box.minZ < box.maxZ;
    }

    private static boolean bounded(double value, double min, double max) {
        return Double.isFinite(value) && value >= min && value <= max;
    }

    private static Result rejected(Verdict verdict) {
        return new Result(verdict, null, null, Double.NaN, Double.NaN, Double.NaN, Double.NaN, null, null);
    }
}
