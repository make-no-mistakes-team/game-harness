package io.gameharness.survival;

import java.util.Locale;
import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** Local, rolling support in the actual rendered view. A target is a bearing, not a route. */
final class AgentVisibleHorizon {
    enum Medium { DRY, SHALLOW_WATER, UNKNOWN }

    // These are operator evidence, not action choices or observations sent to a model.
    enum Refusal {
        NO_GOAL_GRADE_OR_MATERIAL_FACE, ANCHOR_UNAVAILABLE,
        WORLD_OR_CAMERA_UNAVAILABLE, VIEW_STALE_OR_SHIFTED, TARGET_NOT_RENDERED, TARGET_RAY_BUDGET, TARGET_EXPIRED,
        OUTSIDE_RENDERED_BEARING, SOURCE_UNGROUNDED, SOURCE_CONTACT_MISSING, SOURCE_SUPPORT_HEIGHT, SOURCE_UNSUITABLE_SUPPORT,
        SURFACE_NOT_RENDERED, SURFACE_RAY_BUDGET, SURFACE_HEIGHT, LEAF_HEIGHT, UNSUITABLE_TOP,
        NO_NEW_SUPPORT, BRAKING_DISTANCE, DRY_BANK_NOT_RENDERED, WATER_NOT_ALLOWED,
        OBSTRUCTION, HAZARD, DEEP_WATER, WATER_FLOW, FLUID_IN_SWEEP,
        INPUT_UNAVAILABLE, STEERING_ALIGNMENT, INPUT_COASTING, COLLISION_CONTACT, MOTION_INTERRUPTED, PICKUP_VETO,
        CONTACT_PULSE_SPENT;

        final Patch unavailable = new Patch(Medium.UNKNOWN, 0, 0, this);
        final String key = name().toLowerCase(Locale.ROOT);
        final long bit = 1L << ordinal();
    }

    record Evidence(String phase, String stage, long frame, double known, double braking, long refusals, boolean terminal) {}

    private static final int MAX_TRANSITIONS = 32;
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
    private static final double CONTACT_MAX_DRAG = 0.91 * 0.6;
    private static final float TANGENT = 27;
    private static final float MAX_TANGENT = 39;

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

    record Patch(Medium medium, double y, double drag, Refusal refusal) {
        static Patch dry(double y, double slipperiness) {
            return new Patch(Medium.DRY, y, 0.91 * slipperiness, null);
        }

        static Patch water(double y, double depth, Vec3d flow) {
            return waterRefusal(depth, flow) == null ? new Patch(Medium.SHALLOW_WATER, y, WATER_DRAG, null) : null;
        }

        static Refusal waterRefusal(double depth, Vec3d flow) {
            if (!(depth > 0 && depth <= MAX_WATER_DEPTH)) return Refusal.DEEP_WATER;
            return Math.abs(flow.y) <= 0.04 && flow.horizontalLengthSquared() <= 0.16 ? null : Refusal.WATER_FLOW;
        }
    }

    @FunctionalInterface
    interface Support {
        /** Only a visible top, or the source's actual body contact; null is unknown or unsafe. */
        Patch at(int x, int z);

        /** A veto inside the already proved dry stopping prefix, before extending the optical runway. */
        default Refusal vetoDry(double dx, double dz, double drift, double braking) { return null; }
    }

    record Stance(double x, double y, double z, double radius, Vec3d velocity,
                  double acceleration, double drag, boolean wet, BlockPos contact) {}

    record Track(double known, double braking, Medium medium, double bank, double sideDrift,
                 Refusal refusal) {}

    @FunctionalInterface
    interface BearingCheck<C, W> {
        W check(C context, float yaw, boolean allowWade);
    }

    /** One walk tick; neither inspecting another frame nor checking an arc consumes it. */
    static final class ContactPulse {
        private long issuedFrame = -1;

        <C, W> W choose(W optical, C context, float direct, float blocked, BearingCheck<C, W> contact) {
            return optical != null || used() ? optical : tryBearing(direct, blocked, context, false, contact);
        }

        void markIssued(long frame) { issuedFrame = frame; }
        boolean used() { return issuedFrame >= 0; }
        boolean canJoin(long frame) { return frame > issuedFrame; }
    }

    private final AgentBody body;
    private final BearingCheck<Target, Window> checkedWindow = this::checkedWindow;
    private final BearingCheck<Target, Window> checkedContact = (target, yaw, dry) -> checkedContactWindow(target, yaw);
    private final PatchCache patches = new PatchCache();
    private final BlockHitResult[] witnesses = new BlockHitResult[8];
    private final Target[] targets = new Target[witnesses.length];
    private final float[] bearings = new float[8];
    private final Track[] tracks = new Track[bearings.length];
    private AgentBody.HorizonView memoView;
    private Stance memoStance;
    private int targetCount, trackCount;
    private Refusal stanceRefusal;
    private double known, braking;
    private Refusal refusal;
    private long refusals;
    private boolean previewing;
    private Refusal previewRefusal;
    private long previewRefusals;
    private double previewKnown, previewBraking;
    private Window previewWindow;
    private boolean previewTangent;
    private final Transition preview = new Transition("preview"), drive = new Transition("drive");

    AgentVisibleHorizon(AgentBody body) {
        this.body = body;
    }

    private static final class Transition {
        private final String phase;
        private int count;
        private String previous;
        private boolean previousTerminal;
        private Evidence pending;

        Transition(String phase) { this.phase = phase; }

        void report(String stage, long frame, double known, double braking, long refusals, boolean terminal) {
            if (count >= MAX_TRANSITIONS || stage.equals(previous) && terminal == previousTerminal) return;
            previous = stage;
            previousTerminal = terminal;
            ++count;
            pending = new Evidence(phase, stage, frame, known, braking, refusals, terminal);
        }

        Evidence take() {
            var evidence = pending;
            pending = null;
            return evidence;
        }
    }

    void beginPreview() {
        previewing = true;
        previewRefusal = null;
        previewRefusals = 0;
        previewKnown = previewBraking = Double.NaN;
        previewWindow = null;
        previewTangent = false;
    }

    void notePreview(Refusal stage) { notePreview(stage, Double.NaN, Double.NaN); }

    private void notePreview(Refusal stage, double offered, double stopping) {
        if (!previewing || stage == null) return;
        previewRefusals |= stage.bit;
        if (previewRefusal == null || stage == Refusal.ANCHOR_UNAVAILABLE
                || stage != Refusal.NO_GOAL_GRADE_OR_MATERIAL_FACE && previewRefusal != Refusal.ANCHOR_UNAVAILABLE
                    && (stage.ordinal() > previewRefusal.ordinal()
                        || stage == previewRefusal && offered > previewKnown)) {
            previewRefusal = stage;
            previewKnown = offered;
            previewBraking = stopping;
        }
    }

    void reportPreview(boolean grade) {
        previewing = false;
        if (grade) {
            preview.report("offered_one_block_grade", body.renderedFrame(), Double.NaN, Double.NaN, previewRefusals, false);
        } else if (previewWindow != null && previewRefusal != Refusal.ANCHOR_UNAVAILABLE) {
            preview.report(previewTangent ? "offered_tangent" : "offered_direct",
                previewWindow.frame, previewWindow.knownDistance, previewWindow.brakingDistance, previewRefusals, false);
        } else {
            Refusal reason = previewRefusal == null ? Refusal.NO_GOAL_GRADE_OR_MATERIAL_FACE : previewRefusal;
            preview.report(reason.key, body.renderedFrame(), previewKnown, previewBraking, previewRefusals | reason.bit, false);
        }
    }

    void reportDrive(Refusal stage, Window window) {
        reportDrive(stage, window, false);
    }

    void reportDrive(Refusal stage, Window window, boolean terminal) {
        boolean failedSelection = stage == null && window == null;
        if (failedSelection) stage = refusal == null ? Refusal.OUTSIDE_RENDERED_BEARING : refusal;
        long details = failedSelection ? refusals : 0;
        double offered = window == null ? failedSelection ? known : Double.NaN : window.knownDistance;
        double stopping = window == null ? failedSelection ? braking : Double.NaN : window.brakingDistance;
        drive.report(stage == null ? window.contactOnly ? "contact_pulse_issued" : "issued" : stage.key,
            body.renderedFrame(), offered, stopping,
            stage == null ? 0 : details | stage.bit, terminal);
    }

    Evidence takePreviewEvidence() { return preview.take(); }
    Evidence takeDriveEvidence() { return drive.take(); }

    Target target(BlockHitResult witness) {
        if (witness == null) return null;
        var view = body.horizonView();
        if (view == null) {
            notePreview(body.horizonViewRefusal());
            return null;
        }
        useView(view);
        for (int i = 0; i < targetCount; ++i) if (witnesses[i] == witness) return targets[i];
        BlockHitResult live = body.horizonWitness(witness);
        if (live == null) {
            notePreview(Refusal.TARGET_NOT_RENDERED);
            return null;
        }
        Target target = new Target(view, live);
        if (targetCount < targets.length) {
            witnesses[targetCount] = witness;
            targets[targetCount++] = target;
        }
        return target;
    }

    Target find(Predicate<BlockState> matches, double distance, Predicate<BlockHitResult> eligible) {
        if (!body.hasRecentView()) {
            notePreview(body.horizonViewRefusal());
            return null;
        }
        Target nearby = target(body.horizonCue(matches, distance, eligible));
        return nearby != null ? nearby : target(body.find(matches, distance, eligible).orElse(null));
    }

    Window window(Target target) { return window(target, true); }

    Window window(Target target, boolean allowWade) {
        if (!prepare(target)) return null;
        float direct = currentBearing(target);
        Window window = select(direct, Float.NaN, target, allowWade, Float.NaN, checkedWindow);
        if (window != null && previewing) {
            previewWindow = window;
            previewTangent = window.yaw != direct;
        }
        return window;
    }

    Window workWindow(Target target, boolean allowWade, float previous, float blocked, float direct,
                      ContactPulse pulse, boolean allowNewPulse) {
        if (!prepare(target)) return null;
        if (pulse != null && !pulse.canJoin(memoView.frame())) return reject(Refusal.CONTACT_PULSE_SPENT, null);
        Window optical = select(direct, previous, target, allowWade, blocked, checkedWindow);
        return pulse == null || !allowNewPulse ? optical : pulse.choose(optical, target, direct, blocked, checkedContact);
    }

    Window window(Target target, float yaw) {
        return prepare(target) ? checkedWindow(target, yaw, true) : null;
    }

    Window contactWindow(Target target) {
        return prepare(target) ? checkedContactWindow(target, currentBearing(target)) : null;
    }

    Window contactWindow(Target target, float yaw) {
        return prepare(target) ? checkedContactWindow(target, yaw) : null;
    }

    private float currentBearing(Target target) {
        Vec3d feet = memoView.feet(), point = target.point();
        return (float) Math.toDegrees(Math.atan2(feet.x - point.x, point.z - feet.z));
    }

    static <C, W> W select(float direct, float previous, C context, boolean allowWade, float blocked,
                           BearingCheck<C, W> check) {
        float delta = MathHelper.wrapDegrees(previous - direct);
        boolean tryPrevious = Math.abs(delta) <= MAX_TANGENT;
        if (tryPrevious) {
            W window = tryBearing(previous, blocked, context, allowWade, check);
            if (window != null) return window;
        }
        if (!tryPrevious || Math.abs(delta) > 4) {
            W window = tryBearing(direct, blocked, context, allowWade, check);
            if (window != null) return window;
        }
        float first = delta > 0 ? TANGENT : -TANGENT;
        if (!tryPrevious || Math.abs(first - delta) > 4) {
            W window = tryBearing(direct + first, blocked, context, allowWade, check);
            if (window != null) return window;
        }
        return tryBearing(direct - first, blocked, context, allowWade, check);
    }

    private static <C, W> W tryBearing(float bearing, float blocked, C context, boolean allowWade,
                                       BearingCheck<C, W> check) {
        return Math.abs(MathHelper.wrapDegrees(bearing - blocked)) < 13 ? null : check.check(context, bearing, allowWade);
    }

    private boolean prepare(Target target) {
        refusal = null;
        refusals = 0;
        known = braking = Double.NaN;
        if (target == null) {
            reject(Refusal.TARGET_NOT_RENDERED, null);
            return false;
        }
        var view = body.horizonView();
        if (view == null) {
            reject(body.horizonViewRefusal(), null);
            return false;
        }
        if (target.view.world() != view.world() || target.view.player() != view.player()) {
            reject(Refusal.WORLD_OR_CAMERA_UNAVAILABLE, null);
            return false;
        }
        if (view.tick() - target.view.tick() > TARGET_TICKS
                || view.feet().squaredDistanceTo(target.view.feet()) > TARGET_TRAVEL * TARGET_TRAVEL) {
            reject(Refusal.TARGET_EXPIRED, null);
            return false;
        }
        useView(view);
        if (memoStance != null) return true;
        if (stanceRefusal == null) memoStance = body.horizonStance(view);
        if (memoStance != null) return true;
        reject(stanceRefusal, null);
        return false;
    }

    Stance refuseStance(Refusal stage) {
        stanceRefusal = stage;
        return null;
    }

    private Window reject(Refusal stage, Track track) {
        refusals |= stage.bit;
        double offered = track == null ? Double.NaN : track.known, stopping = track == null ? Double.NaN : track.braking;
        if (offered < stopping) {
            refusals |= Refusal.BRAKING_DISTANCE.bit;
            if (previewing) previewRefusals |= Refusal.BRAKING_DISTANCE.bit;
        }
        if (refusal == null || stage.ordinal() > refusal.ordinal() || stage == refusal && offered > known) {
            refusal = stage;
            known = offered;
            braking = stopping;
        }
        notePreview(stage, offered, stopping);
        return null;
    }

    private Window checkedWindow(Target target, float yaw, boolean allowWade) {
        var view = memoView;
        var stance = memoStance;
        if (!Float.isFinite(yaw) || !body.horizonBearingInView(view, yaw))
            return reject(Refusal.OUTSIDE_RENDERED_BEARING, null);
        double radians = Math.toRadians(yaw);
        double dx = -Math.sin(radians), dz = Math.cos(radians);
        double toX = target.point().x - stance.x, toZ = target.point().z - stance.z;
        double progress = dx * toX + dz * toZ;
        if (progress <= 0.05) return reject(Refusal.NO_GOAL_GRADE_OR_MATERIAL_FACE, null);
        Track track = observedTrack(stance, yaw, dx, dz);
        if (track.medium == Medium.UNKNOWN) return reject(track.refusal, track);
        if (track.known <= track.braking) return reject(Refusal.BRAKING_DISTANCE, track);
        // A short contact-only coast is not an approach or a promise of another pulse.
        if (!advancesBeyondContact(stance, track, dx, dz)) return reject(Refusal.NO_NEW_SUPPORT, track);
        Medium medium = track.medium;
        if (medium == Medium.SHALLOW_WATER) {
            if (!allowWade) return reject(Refusal.WATER_NOT_ALLOWED, track);
            // Don't begin a wade if the goal would leave the body between dry stances.
            if (!stance.wet && progress + stance.radius < track.bank) return reject(Refusal.DRY_BANK_NOT_RENDERED, track);
            Refusal veto = body.horizonSweep(dx, dz, track.sideDrift, track.braking - MARGIN, track.bank, medium);
            if (veto != null) return reject(veto, track);
        }
        Vec3d bank = medium == Medium.SHALLOW_WATER
            ? new Vec3d(stance.x + dx * track.bank, stance.y, stance.z + dz * track.bank) : null;
        return new Window(target, yaw, track.known, track.braking, medium, view.frame(),
            view.ageTicks(), view.displacement(), bank, false);
    }

    private Window checkedContactWindow(Target target, float yaw) {
        var view = memoView;
        var stance = memoStance;
        if (!body.horizonPulseAvailable(stance.contact)) return reject(Refusal.CONTACT_PULSE_SPENT, null);
        if (!Float.isFinite(yaw) || !body.horizonBearingInView(view, yaw))
            return reject(Refusal.OUTSIDE_RENDERED_BEARING, null);
        double radians = Math.toRadians(yaw);
        double dx = -Math.sin(radians), dz = Math.cos(radians);
        if (dx * (target.point().x - stance.x) + dz * (target.point().z - stance.z) <= 0.05)
            return reject(Refusal.NO_GOAL_GRADE_OR_MATERIAL_FACE, null);
        Track local = contactTrace(stance, dx, dz);
        if (local == null) return reject(stance.wet ? Refusal.WATER_NOT_ALLOWED : Refusal.BRAKING_DISTANCE, null);
        if (target.frame() != view.frame() && target(target.hit()) == null)
            return reject(Refusal.TARGET_NOT_RENDERED, null);
        Refusal veto = body.horizonSweep(dx, dz, local.sideDrift, local.braking - MARGIN, local.braking, Medium.DRY);
        if (veto != null) return reject(veto, local);
        return new Window(target, yaw, local.known, local.braking, Medium.DRY, view.frame(),
            view.ageTicks(), view.displacement(), null, true);
    }

    static boolean advancesBeyondContact(Stance stance, Track track, double dx, double dz) {
        double distance = track.known - MARGIN;
        int x = MathHelper.floor(stance.x), z = MathHelper.floor(stance.z);
        // Side drift may subtract progress, never create the promised crossing.
        return MathHelper.floor(stance.x + unassistedAxis(dx * distance, -dz * track.sideDrift)) != x
            || MathHelper.floor(stance.z + unassistedAxis(dz * distance, dx * track.sideDrift)) != z;
    }

    private static double unassistedAxis(double along, double drift) {
        return along * drift >= 0 ? along
            : Math.copySign(Math.max(0, Math.abs(along) - Math.abs(drift)), along);
    }

    private void useView(AgentBody.HorizonView view) {
        if (memoView != null && memoView.frame() == view.frame() && memoView.tick() == view.tick()
                && memoView.world() == view.world() && memoView.player() == view.player()
                && memoView.feet().equals(view.feet()) && memoView.velocity().equals(view.velocity())) return;
        memoView = view;
        memoStance = null;
        stanceRefusal = null;
        targetCount = trackCount = 0;
        patches.reset(view);
    }

    private Track observedTrack(Stance stance, float yaw, double dx, double dz) {
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
        if (stance.wet || stance.contact == null || stance.drag > CONTACT_MAX_DRAG) return null;
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
        return known > braking ? new Track(known, braking, Medium.DRY, 0, side, null) : null;
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
                return new Track(0, braking, Medium.UNKNOWN, 0, side, Refusal.BRAKING_DISTANCE);

            double radius = stance.radius + (grip >= WATER_DRAG ? 0.04 : 0);
            double known = 0, dryPrefix = 0, dryAfterWater = 0;
            boolean water = stance.wet, dryVetoChecked = false;
            boolean retry = false;
            Refusal stopped = null;
            for (int slice = 1; slice <= (int) Math.round(WET_LIMIT / SLICE); ++slice) {
                double to = slice * SLICE, from = to - SLICE;
                double drift = side * Math.min(1, to / (braking - MARGIN));
                // Body width stays axis-aligned in vanilla; yaw only rotates the translation.
                double minX = stance.x + Math.min(dx * from, dx * to) + Math.min(0, -dz * drift) - radius;
                double maxX = stance.x + Math.max(dx * from, dx * to) + Math.max(0, -dz * drift) + radius;
                double minZ = stance.z + Math.min(dz * from, dz * to) + Math.min(0, dx * drift) - radius;
                double maxZ = stance.z + Math.max(dz * from, dz * to) + Math.max(0, dx * drift) + radius;
                if (stance.contact != null && !stance.wet) {
                    // The current stance can already overhang at a trailing edge. Exclude
                    // only the bit of that overhang that can never grow during this trace.
                    int contactX = stance.contact.getX(), contactZ = stance.contact.getZ();
                    if (dx > 0 && -dz * side >= 0 && stance.x >= contactX) minX = Math.max(minX, contactX);
                    if (dx < 0 && -dz * side <= 0 && stance.x <= contactX + 1) maxX = Math.min(maxX, contactX + 1);
                    if (dz > 0 && dx * side >= 0 && stance.z >= contactZ) minZ = Math.max(minZ, contactZ);
                    if (dz < 0 && dx * side <= 0 && stance.z <= contactZ + 1) maxZ = Math.min(maxZ, contactZ + 1);
                }
                boolean wetSlice = false;
                double segmentGrip = grip;
                for (int x = MathHelper.floor(minX); stopped == null && x <= MathHelper.floor(maxX - 1e-6); ++x) {
                    for (int z = MathHelper.floor(minZ); z <= MathHelper.floor(maxZ - 1e-6); ++z) {
                        Patch patch = support.at(x, z);
                        if (patch == null || patch.medium == Medium.UNKNOWN
                                || Math.abs(patch.y - stance.y) > HEIGHT_TOLERANCE) {
                            stopped = patch == null ? Refusal.SURFACE_NOT_RENDERED
                                : patch.medium == Medium.UNKNOWN ? patch.refusal : Refusal.SURFACE_HEIGHT;
                            break;
                        }
                        segmentGrip = Math.max(segmentGrip, patch.drag);
                        wetSlice |= patch.medium == Medium.SHALLOW_WATER;
                    }
                }
                if (stopped != null) break;
                if (wetSlice && !water && dryPrefix >= braking)
                    return new Track(dryPrefix, braking, Medium.DRY, 0, side, null);
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
                        return new Track(to, braking, Medium.SHALLOW_WATER, to, side, null);
                } else {
                    dryPrefix = to;
                    if (!dryVetoChecked && to > braking) {
                        dryVetoChecked = true;
                        Refusal veto = support.vetoDry(dx, dz, side, braking);
                        if (veto != null) return new Track(to, braking, Medium.UNKNOWN, 0, side, veto);
                    }
                    if (to >= DRY_LIMIT) break;
                }
            }
            if (retry) continue;
            if (!stance.wet && dryPrefix >= braking)
                return new Track(dryPrefix, braking, Medium.DRY, 0, side, null);
            if (water && (stopped == null || stopped == Refusal.SURFACE_NOT_RENDERED))
                stopped = Refusal.DRY_BANK_NOT_RENDERED;
            return new Track(known, braking, Medium.UNKNOWN, 0, side, stopped == null ? Refusal.BRAKING_DISTANCE : stopped);
        }
        return new Track(0, Double.POSITIVE_INFINITY, Medium.UNKNOWN, 0, 0, Refusal.BRAKING_DISTANCE);
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
            if (size >= keys.length) return Refusal.SURFACE_RAY_BUDGET.unavailable;
            Patch patch = body.horizonPatch(view, x, z);
            keys[size] = key;
            data[size++] = patch;
            return patch;
        }

        @Override public Refusal vetoDry(double dx, double dz, double drift, double braking) {
            return body.horizonSweep(dx, dz, drift, braking - MARGIN, braking, Medium.DRY);
        }
    }
}
