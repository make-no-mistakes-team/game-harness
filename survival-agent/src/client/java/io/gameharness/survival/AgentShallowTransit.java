package io.gameharness.survival;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

import static io.gameharness.survival.AgentVisibleHorizon.Medium.DRY;
import static io.gameharness.survival.AgentVisibleHorizon.Medium.SHALLOW_WATER;
import static io.gameharness.survival.AgentVisibleHorizon.Refusal.*;
import static io.gameharness.survival.AgentVisibleHorizon.*;

/** A bounded continuation of one physically issued input, not a new terrain or resource search. */
final class AgentShallowTransit {
    enum Turn { DRIVE, COAST, LANDED, RECOVER }

    record Pose(Object world, Object actor, Object owner, int tick, long frame, Vec3d feet, Vec3d velocity,
                BlockPos support, double radius, boolean wet, float health, Refusal safety,
                double dryAcceleration, double waterAcceleration, double waterDrag) {}

    interface Checks {
        Patch physical(int x, int z, Patch seen);
        Refusal optical(int x, int z, Patch seen);
        Refusal sweep(double dx, double dz, double drift, double coastDistance, double reach);
    }

    private static final int MAX_TICKS = 36;
    private static final double WIDTH = 0.26;
    private static final double SLICE = 0.16, MARGIN = 0.075;
    private static final int CELLS = 7;

    private final Pose start;
    private final Vec3d bank;
    private final BlockPos bankCell;
    private final double dx, dz, length;
    private final int lowX, lowZ;
    private final Patch[] known = new Patch[CELLS * CELLS];
    private long proofFrame;
    private int heldAt = -1;
    private boolean touched, shore;
    private Turn turn;
    private Refusal reason;
    private double coastDistance, inputReach, drift;

    private AgentShallowTransit(Pose start, Vec3d bank, double length, double initialDrift,
                               double initialCoast, Support support) {
        this.start = start;
        this.bank = bank;
        this.length = length;
        bankCell = BlockPos.ofFloored(bank);
        dx = (bank.x - start.feet.x) / length;
        dz = (bank.z - start.feet.z) / length;
        lowX = MathHelper.floor(start.feet.x) - 3;
        lowZ = MathHelper.floor(start.feet.z) - 3;
        proofFrame = start.frame;
        // Snapshot only the issued bearing's body-width corridor, not other
        // patches observed while testing bearings or prospective steering.
        int slices = (int) Math.ceil(length / SLICE);
        double step = length / slices;
        for (int i = 0; i < slices; ++i) {
            double from = i * step, to = from + step;
            double side = initialDrift * Math.min(1, to / initialCoast);
            int minX = minCell(start.feet.x, dx, from, to, -dz * side, start.radius);
            int maxX = maxCell(start.feet.x, dx, from, to, -dz * side, start.radius);
            int minZ = minCell(start.feet.z, dz, from, to, dx * side, start.radius);
            int maxZ = maxCell(start.feet.z, dz, from, to, dx * side, start.radius);
            for (int x = minX; x <= maxX; ++x) {
                for (int z = minZ; z <= maxZ; ++z) {
                    int index = index(x, z);
                    if (known[index] != null) continue;
                    Patch patch = support.at(x, z);
                    if (patch != null && patch.refusal() == null) known[index] = patch;
                }
            }
        }
    }

    static AgentShallowTransit issue(boolean issued, Pose pose, Vec3d bank, double sideDrift,
                                   double coast, Support support) {
        if (!issued || pose.wet || pose.safety != null || pose.frame < 0 || bank == null || pose.radius > 0.36) return null;
        double length = Math.hypot(bank.x - pose.feet.x, bank.z - pose.feet.z);
        if (length < 0.3 || length > 2.57) return null;
        var transit = new AgentShallowTransit(pose, bank, length, sideDrift, coast, support);
        Patch landing = transit.seen(transit.bankCell.getX(), transit.bankCell.getZ());
        Patch source = transit.seen(MathHelper.floor(pose.feet.x), MathHelper.floor(pose.feet.z));
        return source != null && source.medium() == DRY && landing != null && landing.medium() == DRY ? transit : null;
    }

    Vec3d bank() { return bank; }
    Refusal reason() { return reason; }
    Turn turn() { return turn; }
    boolean touchedWater() { return touched; }
    double inputReach() { return inputReach; }

    Turn check(Pose pose, Checks checks) {
        if (turn == Turn.RECOVER) return turn;
        if (pose.world != start.world || pose.actor != start.actor) return lose(WORLD_OR_CAMERA_UNAVAILABLE);
        if (pose.owner != start.owner) return lose(TARGET_EXPIRED);
        if (pose.health != start.health) return lose(WADE_HEALTH_CHANGED);
        if (pose.safety != null) return lose(pose.safety);
        if (pose.tick - start.tick > MAX_TICKS) return lose(WADE_BOUND_EXCEEDED);
        double x = pose.feet.x - start.feet.x, z = pose.feet.z - start.feet.z;
        double advance = x * dx + z * dz, offset = x * -dz + z * dx;
        double along = pose.velocity.x * dx + pose.velocity.z * dz;
        double side = pose.velocity.x * -dz + pose.velocity.z * dx;
        if (Math.abs(pose.feet.y - bank.y) > 0.055 || Math.abs(pose.velocity.y) > 0.14
                || Math.abs(pose.radius - start.radius) > 0.02
                || advance < -0.04 || advance > length + 0.18 || Math.abs(offset) > WIDTH
                || along < -0.035 || pose.velocity.horizontalLengthSquared() > 0.0625 || Math.abs(side) > 0.060)
            return lose(WADE_DRIFT);
        if (pose.support == null) return lose(SOURCE_CONTACT_MISSING);
        Patch contact = seen(pose.support.getX(), pose.support.getZ());
        if (contact == null || contact.floor() != null && !contact.floor().equals(pose.support))
            return lose(SOURCE_CONTACT_MISSING);

        boolean fresh = pose.frame > proofFrame;
        double remaining = Math.max(0, (bank.x - pose.feet.x) * dx + (bank.z - pose.feet.z) * dz);
        boolean bankCenter = MathHelper.floor(pose.feet.x) == bankCell.getX()
            && MathHelper.floor(pose.feet.z) == bankCell.getZ()
            && pose.support.getX() == bankCell.getX() && pose.support.getZ() == bankCell.getZ();
        // Dry center and actual wet body are independent. The last old-water
        // contact may lag vanilla's position update by one tick.
        boolean overlapsWater = knownWaterUnder(pose);
        touched |= pose.wet;
        if (touched && !pose.wet && !overlapsWater && !bankCenter) return lose(WADE_DRIFT);
        boolean dryHullOnBank = bankCenter && !overlapsWater;
        shore |= touched && !pose.wet && dryHullOnBank;
        if (shore && (pose.wet || overlapsWater || !bankCenter)) return lose(WADE_DRIFT);

        // At a physically dry hull the next vanilla travel uses bank drag,
        // even if isTouchingWater still describes the previous pre-move box.
        double drag = dryHullOnBank ? contact.drag() : Math.max(contact.drag(), pose.waterDrag);
        double coast = 1 / (1 - drag);
        coastDistance = Math.max(0, along) * coast + MARGIN;
        drift = side * coast;
        if (Math.abs(offset + drift) > WIDTH) return lose(WADE_DRIFT);
        double reach = Math.max(shore ? 0 : remaining, coastDistance);
        Refusal veto = validate(pose, checks, dx, dz, reach, fresh);
        if (veto != null) return lose(veto);
        if (!fresh) {
            if (heldAt >= 0 && heldAt != pose.tick) return lose(VIEW_STALE_OR_SHIFTED);
            heldAt = pose.tick;
            return select(Turn.COAST, VIEW_STALE_OR_SHIFTED);
        }
        proofFrame = pose.frame;
        heldAt = -1;
        if (shore && pose.velocity.horizontalLengthSquared() <= AgentMacroControl.SETTLED_SPEED_SQUARED)
            return select(Turn.LANDED, null);
        if (dryHullOnBank || remaining <= 0.07)
            return select(Turn.COAST, INPUT_COASTING);

        // A water stroke is ordinary forward input (0.02 base in vanilla),
        // not the much larger grounded walking impulse. Keep neutral coast
        // supported too; letting up must not require extending the bank.
        double ratio = 0.6 / (contact.drag() / 0.91);
        inputReach = coastDistance + (pose.wet ? pose.waterAcceleration : pose.dryAcceleration * ratio * ratio * ratio) * coast;
        if (inputReach > reach) {
            veto = validate(pose, checks, dx, dz, inputReach, true);
            if (veto == WADE_DRIFT) return select(Turn.COAST, INPUT_COASTING);
            if (veto != null) return lose(veto);
        }
        return select(Turn.DRIVE, null);
    }

    /** Check the actual key bearing (and its steering arc) against the same, fixed witnessed cells. */
    Refusal inputVeto(Pose pose, Checks checks, float yaw) {
        if (turn != Turn.DRIVE || pose.frame != proofFrame)
            return reason == null ? VIEW_STALE_OR_SHIFTED : reason;
        double radians = Math.toRadians(yaw);
        return validate(pose, checks, -Math.sin(radians), Math.cos(radians), inputReach, true);
    }

    private Refusal validate(Pose pose, Checks checks, double xDir, double zDir, double reach, boolean fresh) {
        int slices = Math.max(1, (int) Math.ceil(reach / SLICE));
        double step = reach / slices;
        long checked = 0;
        for (int i = 0; i < slices; ++i) {
            double from = i * step, to = from + step;
            double side = drift * Math.min(1, to / coastDistance);
            int minX = minCell(pose.feet.x, xDir, from, to, -zDir * side, pose.radius);
            int maxX = maxCell(pose.feet.x, xDir, from, to, -zDir * side, pose.radius);
            int minZ = minCell(pose.feet.z, zDir, from, to, xDir * side, pose.radius);
            int maxZ = maxCell(pose.feet.z, zDir, from, to, xDir * side, pose.radius);
            for (int x = minX; x <= maxX; ++x) {
                for (int z = minZ; z <= maxZ; ++z) {
                    Patch expected = seen(x, z);
                    if (expected == null) return WADE_DRIFT;
                    long bit = 1L << index(x, z);
                    if ((checked & bit) != 0) continue;
                    checked |= bit;
                    Patch actual = checks.physical(x, z, expected);
                    if (actual != null && actual.refusal() != null && actual.refusal() != UNSUITABLE_TOP
                            && actual.refusal() != SURFACE_HEIGHT) return actual.refusal();
                    if (!expected.sameSupport(actual))
                        return expected.medium() == DRY ? WADE_BANK_CHANGED : WADE_BED_CHANGED;
                    if (fresh) {
                        Refusal optical = checks.optical(x, z, expected);
                        if (optical != null) return optical;
                    }
                }
            }
        }
        return checks.sweep(xDir, zDir, drift, coastDistance, reach);
    }

    private static int minCell(double position, double axis, double from, double to, double drift, double radius) {
        return MathHelper.floor(position + Math.min(axis * from, axis * to) + Math.min(0, drift) - radius);
    }

    private static int maxCell(double position, double axis, double from, double to, double drift, double radius) {
        return MathHelper.floor(position + Math.max(axis * from, axis * to) + Math.max(0, drift) + radius - 1e-6);
    }

    private boolean knownWaterUnder(Pose pose) {
        int minX = MathHelper.floor(pose.feet.x - pose.radius), maxX = MathHelper.floor(pose.feet.x + pose.radius - 1e-6);
        int minZ = MathHelper.floor(pose.feet.z - pose.radius), maxZ = MathHelper.floor(pose.feet.z + pose.radius - 1e-6);
        for (int x = minX; x <= maxX; ++x) for (int z = minZ; z <= maxZ; ++z) {
            Patch patch = seen(x, z);
            if (patch != null && patch.medium() == SHALLOW_WATER) return true;
        }
        return false;
    }

    private int index(int x, int z) { return (x - lowX) * CELLS + z - lowZ; }

    private Patch seen(int x, int z) {
        return x < lowX || x >= lowX + CELLS || z < lowZ || z >= lowZ + CELLS ? null : known[index(x, z)];
    }

    Turn lose(Refusal refusal) { return select(Turn.RECOVER, refusal); }

    private Turn select(Turn selected, Refusal refusal) {
        reason = refusal;
        return turn = selected;
    }
}
