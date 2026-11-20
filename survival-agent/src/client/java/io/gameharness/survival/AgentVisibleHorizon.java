package io.gameharness.survival;

import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** Local, rolling support in the actual rendered view. A target is a bearing, not a route. */
final class AgentVisibleHorizon {
    enum Medium { DRY, SHALLOW_WATER, UNKNOWN }

    private static final int TARGET_TICKS = 64;
    private static final double TARGET_TRAVEL = 8;
    private static final double HEIGHT_TOLERANCE = 0.055;
    private static final double MARGIN = 0.075;
    private static final double SLICE = 0.16;
    private static final double DRY_LIMIT = 1.60;
    private static final double WET_LIMIT = 2.56;
    private static final double MAX_WATER_DEPTH = 0.56;
    private static final double WATER_DRAG = 0.8;
    private static final double CONTACT_CORE = 0.18;
    private static final double CONTACT_LIMIT = 0.34;

    static final class Target {
        private final AgentBody.HorizonView view;
        private final BlockHitResult hit;
        private final double observedRange;

        private Target(AgentBody.HorizonView view, BlockHitResult hit) {
            this.view = view;
            this.hit = hit;
            observedRange = view.eye().distanceTo(hit.getPos());
        }

        BlockHitResult hit() { return hit; }
        Vec3d point() { return hit.getPos(); }
        long frame() { return view.frame(); }
        double observedRange() { return observedRange; }
    }

    record Window(Target target, float yaw, double knownDistance, double brakingDistance,
                  Medium medium, long frame, int ageTicks, double displacement, Vec3d dryBank, boolean contactOnly) {}

    record Patch(Medium medium, double y, double drag) {
        static Patch dry(double y, double slipperiness) {
            return new Patch(Medium.DRY, y, 0.91 * slipperiness);
        }

        static Patch water(double y, double depth, Vec3d flow) {
            return depth > 0 && depth <= MAX_WATER_DEPTH && Math.abs(flow.y) <= 0.04
                && flow.horizontalLengthSquared() <= 0.16
                ? new Patch(Medium.SHALLOW_WATER, y, WATER_DRAG) : null;
        }
    }

    @FunctionalInterface
    interface Support {
        /** Only a visible top, or the source's actual body contact; null is unknown or unsafe. */
        Patch at(int x, int z);
    }

    record Stance(double x, double y, double z, double radius, Vec3d velocity,
                  double acceleration, double drag, boolean wet, BlockPos contact) {}

    record Track(double known, double braking, Medium medium, double bank, double sideDrift) {}

    private final AgentBody body;
    private final PatchCache patches = new PatchCache();
    private final BlockHitResult[] witnesses = new BlockHitResult[8];
    private final Target[] targets = new Target[witnesses.length];
    private final float[] bearings = new float[8];
    private final Track[] tracks = new Track[bearings.length];
    private AgentBody.HorizonView memoView;
    private Stance memoStance;
    private int targetCount, trackCount;

    AgentVisibleHorizon(AgentBody body) {
        this.body = body;
    }

    Target target(BlockHitResult witness) {
        var view = body.horizonView();
        if (view == null || witness == null) return null;
        useView(view);
        for (int i = 0; i < targetCount; ++i) if (witnesses[i] == witness) return targets[i];
        BlockHitResult live = body.horizonWitness(witness);
        if (live == null) return null;
        Target target = new Target(view, live);
        if (targetCount < targets.length) {
            witnesses[targetCount] = witness;
            targets[targetCount++] = target;
        }
        return target;
    }

    Target find(Predicate<BlockState> matches, double distance, Predicate<BlockHitResult> eligible) {
        Target nearby = target(body.horizonCue(matches, distance, eligible));
        return nearby != null ? nearby : target(body.find(matches, distance, eligible).orElse(null));
    }

    Window window(Target target) {
        var view = body.horizonView();
        if (target == null || view == null) return null;
        Vec3d feet = view.feet(), point = target.point();
        return window(target, view, (float) Math.toDegrees(Math.atan2(feet.x - point.x, point.z - feet.z)));
    }

    Window window(Target target, float yaw) {
        var view = body.horizonView();
        return target == null || view == null ? null : window(target, view, yaw);
    }

    private Window window(Target target, AgentBody.HorizonView view, float yaw) {
        if (target.view.world() != view.world() || target.view.player() != view.player()
                || view.tick() - target.view.tick() > TARGET_TICKS
                || view.feet().squaredDistanceTo(target.view.feet()) > TARGET_TRAVEL * TARGET_TRAVEL
                || !Float.isFinite(yaw)) return null;
        var stance = body.horizonStance(view);
        if (stance == null) return null;
        double radians = Math.toRadians(yaw);
        double dx = -Math.sin(radians), dz = Math.cos(radians);
        double toX = target.point().x - stance.x, toZ = target.point().z - stance.z;
        double progress = dx * toX + dz * toZ;
        // A lateral adjustment can belong to this goal; a backward excursion cannot.
        if (progress <= 0.05) return null;
        useView(view);
        Track track = observedTrack(stance, yaw, dx, dz);
        boolean contactOnly = false;
        if (track.medium == Medium.UNKNOWN) {
            Track local = contactTrace(stance, dx, dz);
            if (local != null) {
                track = local;
                contactOnly = true;
            }
        }
        Medium medium = track.medium;
        // Don't begin a wade if the goal would leave the body between dry stances.
        if (medium == Medium.SHALLOW_WATER && !stance.wet && progress + stance.radius < track.bank)
            medium = Medium.UNKNOWN;
        if (medium != Medium.UNKNOWN && !body.horizonSweep(dx, dz, track.sideDrift, track.braking - MARGIN,
                medium == Medium.SHALLOW_WATER ? track.bank : track.braking, medium)) medium = Medium.UNKNOWN;
        Vec3d bank = medium == Medium.SHALLOW_WATER
            ? new Vec3d(stance.x + dx * track.bank, stance.y, stance.z + dz * track.bank) : null;
        return new Window(target, yaw, track.known, track.braking, medium, view.frame(),
            view.ageTicks(), view.displacement(), bank, contactOnly && medium == Medium.DRY);
    }

    private void useView(AgentBody.HorizonView view) {
        if (memoView != null && memoView.frame() == view.frame() && memoView.tick() == view.tick()
                && memoView.world() == view.world() && memoView.player() == view.player()
                && memoView.feet().equals(view.feet()) && memoView.velocity().equals(view.velocity())) return;
        memoView = view;
        memoStance = null;
        targetCount = trackCount = 0;
        patches.reset(view);
    }

    private Track observedTrack(Stance stance, float yaw, double dx, double dz) {
        if (!stance.equals(memoStance)) {
            memoStance = stance;
            trackCount = 0;
        }
        for (int i = 0; i < trackCount; ++i) if (bearings[i] == yaw) return tracks[i];
        Track track = trace(patches, stance, dx, dz);
        if (trackCount < tracks.length) {
            bearings[trackCount] = yaw;
            tracks[trackCount++] = track;
        }
        return track;
    }

    /**
     * Actual dry contact can cover one ordinary walking pulse even if the next top is clipped.
     * Keep the center and its support core on that exact tile throughout neutral coast. The
     * rest of the body still participates in the collision and fluid veto.
     */
    static Track contactTrace(Stance stance, double dx, double dz) {
        if (stance.wet || stance.contact == null) return null;
        double along = stance.velocity.x * dx + stance.velocity.z * dz;
        if (along < -0.01) return null;
        double coast = 1 / (1 - stance.drag);
        double braking = (Math.max(0, along) + stance.acceleration) * coast + MARGIN;
        if (braking > CONTACT_LIMIT) return null;
        double side = (stance.velocity.x * -dz + stance.velocity.z * dx) * coast;
        double radius = Math.min(stance.radius, CONTACT_CORE);
        double known = Math.min(CONTACT_LIMIT, Math.min(
            contactLimit(stance.x, dx, -dz * side, stance.contact.getX(), radius),
            contactLimit(stance.z, dz, dx * side, stance.contact.getZ(), radius)));
        return known >= braking ? new Track(known, braking, Medium.DRY, 0, side) : null;
    }

    private static double contactLimit(double origin, double axis, double drift, int tile, double radius) {
        if (origin < tile + 0.08 || origin > tile + 0.92) return 0;
        double low = tile + radius, high = tile + 1 - radius;
        // Pre-existing trailing overhang is contact, not a new supporting cell. Allow it only
        // when both the input and residual motion move inward; never extend the overhang.
        if (origin < low && axis > 0 && drift >= 0) low = origin;
        if (origin > high && axis < 0 && drift <= 0) high = origin;
        double min = origin + Math.min(0, drift), max = origin + Math.max(0, drift);
        if (min < low || max > high) return 0;
        if (axis > 1e-8) return (high - max) / axis;
        if (axis < -1e-8) return (low - min) / axis;
        return Double.POSITIVE_INFINITY;
    }

    /**
     * Each slice covers the entire swept foot rectangle, not just a center ray. Grip seen in
     * the stopping envelope can lengthen that envelope; the same bounded optical patches are reused.
     */
    static Track trace(Support support, Stance stance, double dx, double dz) {
        double grip = stance.drag;
        for (int attempt = 0; attempt < 3; ++attempt) {
            double along = stance.velocity.x * dx + stance.velocity.z * dz;
            double across = stance.velocity.x * -dz + stance.velocity.z * dx;
            double coast = 1 / (1 - grip);
            double braking = (Math.max(0, along) + stance.acceleration) * coast + MARGIN;
            double side = across * coast;
            if (along < -0.01 || braking > WET_LIMIT || Math.abs(side) > 0.65)
                return new Track(0, braking, Medium.UNKNOWN, 0, side);

            double radius = stance.radius + (grip >= WATER_DRAG ? 0.04 : 0);
            double known = 0, dryPrefix = 0, dryAfterWater = 0;
            boolean water = stance.wet;
            boolean retry = false;
            for (int slice = 1; slice <= (int) Math.round(WET_LIMIT / SLICE); ++slice) {
                double to = slice * SLICE, from = to - SLICE;
                double drift = side * Math.min(1, to / (braking - MARGIN));
                // Body width stays axis-aligned in vanilla; yaw only rotates the translation.
                double minX = stance.x + Math.min(dx * from, dx * to) + Math.min(0, -dz * drift) - radius;
                double maxX = stance.x + Math.max(dx * from, dx * to) + Math.max(0, -dz * drift) + radius;
                double minZ = stance.z + Math.min(dz * from, dz * to) + Math.min(0, dx * drift) - radius;
                double maxZ = stance.z + Math.max(dz * from, dz * to) + Math.max(0, dx * drift) + radius;
                boolean wetSlice = false, supported = true;
                double segmentGrip = grip;
                for (int x = MathHelper.floor(minX); supported && x <= MathHelper.floor(maxX - 1e-6); ++x) {
                    for (int z = MathHelper.floor(minZ); z <= MathHelper.floor(maxZ - 1e-6); ++z) {
                        Patch patch = support.at(x, z);
                        if (patch == null || patch.medium == Medium.UNKNOWN
                                || Math.abs(patch.y - stance.y) > HEIGHT_TOLERANCE) {
                            supported = false;
                            break;
                        }
                        segmentGrip = Math.max(segmentGrip, patch.drag);
                        wetSlice |= patch.medium == Medium.SHALLOW_WATER;
                    }
                }
                if (!supported) break;
                if (wetSlice && !water && dryPrefix >= braking)
                    return new Track(dryPrefix, braking, Medium.DRY, 0, side);
                // A slipperier patch farther away does not retroactively erase short dry travel.
                // Check it only if it lies under this tick's potential movement and neutral coast.
                if (segmentGrip > grip && from < braking) {
                    grip = segmentGrip;
                    retry = true;
                    break;
                }
                known = to;
                if (wetSlice) {
                    water = true;
                    dryAfterWater = 0;
                } else if (water) {
                    dryAfterWater += SLICE;
                    if (dryAfterWater >= 2 * SLICE && to >= braking)
                        return new Track(to, braking, Medium.SHALLOW_WATER, to, side);
                } else {
                    dryPrefix = to;
                    if (to >= DRY_LIMIT) break;
                }
            }
            if (retry) continue;
            if (!stance.wet && dryPrefix >= braking)
                return new Track(dryPrefix, braking, Medium.DRY, 0, side);
            return new Track(stance.wet ? known : dryPrefix, braking, Medium.UNKNOWN, 0, side);
        }
        return new Track(0, Double.POSITIVE_INFINITY, Medium.UNKNOWN, 0, 0);
    }

    /** Footprint-only memoization. Never carry optical support to a new render or physical pose. */
    private final class PatchCache implements Support {
        private final long[] keys = new long[48];
        private final Patch[] data = new Patch[keys.length];
        private AgentBody.HorizonView view;
        private int size;

        void reset(AgentBody.HorizonView view) {
            this.view = view;
            size = 0;
        }

        @Override public Patch at(int x, int z) {
            long key = BlockPos.asLong(x, 0, z);
            for (int i = 0; i < size; ++i) if (keys[i] == key) return data[i];
            if (size >= keys.length) return null;
            Patch patch = body.horizonPatch(view, x, z);
            keys[size] = key;
            data[size++] = patch;
            return patch;
        }
    }
}
