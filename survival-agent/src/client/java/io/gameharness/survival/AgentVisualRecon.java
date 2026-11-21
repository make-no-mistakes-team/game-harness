package io.gameharness.survival;

import com.google.gson.JsonObject;
import java.util.Locale;
import java.util.Set;
import net.minecraft.util.math.Vec3d;

/** The movement ledger for one explicit grant. A ray or planned key is never a movement receipt. */
final class AgentVisualRecon {
    static final int MAX_TICKS = 100;
    static final long MAX_NS = 5_000_000_000L;
    static final double MAX_LEG = 1.40;
    static final double MIN_PROGRESS = 0.36;
    static final double STANDOFF = 0.72;
    static final double SETTLED_SPEED = 0.0029;
    // Normal dry stance only. Movement input is limited to one standing forward/diagonal
    // tick; vanilla stores velocity after 0.91 * 0.6 drag. Include all future neutral coast.
    private static final double DRAG = 0.91 * 0.6;
    private static final double MAX_ACCELERATION = 0.102;
    private static final double MARGIN = 0.035;
    private static final double AIR_DRAG = 0.91;
    private static final Set<String> BOUND_FIELDS = Set.of("maxLegs", "maxBlocks");

    record Bounds(int maxLegs, int maxBlocks) {
        Bounds {
            if (maxLegs < 1 || maxLegs > 3 || maxBlocks < 1 || maxBlocks > 6)
                throw new IllegalArgumentException("Invalid visual reconnaissance bounds");
        }

        static Bounds read(JsonObject value) {
            if (!value.keySet().equals(BOUND_FIELDS)) throw new IllegalArgumentException("Unexpected recon fields");
            return new Bounds(Math.toIntExact(integer(value, "maxLegs")), Math.toIntExact(integer(value, "maxBlocks")));
        }

        private static long integer(JsonObject value, String key) {
            var field = value.getAsJsonPrimitive(key);
            if (!field.isNumber()) throw new IllegalArgumentException("Expected an integer");
            return field.getAsBigDecimal().longValueExact();
        }
    }

    record Leg(int side, float yaw, double dx, double dz, double limit, int height, double verticalReserve) {
        Leg(int side, float yaw, double dx, double dz, double limit) { this(side, yaw, dx, dz, limit, 0, 0); }
        boolean grade() { return height != 0; }
    }

    final Bounds bounds;
    final Vec3d origin, target;
    private final long endTick, endNanos;
    private Vec3d last, legFrom;
    private long lastTick, issuedAt = -1, brakeFrame = -1, settledFrame = -1;
    private Leg leg;
    private int legs;
    private double travel, legTravel, legVertical;
    private double measuredX, measuredY, measuredZ;
    private String interruption;
    private boolean incompleteMotion, drove;

    AgentVisualRecon(Bounds bounds, Vec3d feet, Vec3d target, long tick, long now, long expires) {
        this.bounds = bounds;
        origin = last = feet;
        this.target = target;
        lastTick = tick;
        endTick = Math.min(expires, tick + MAX_TICKS);
        endNanos = now + MAX_NS;
    }

    boolean live(long tick, long now) { return tick < endTick && now < endNanos; }
    boolean timeForKey(long tick, long now) {
        return tick + 10 < endTick && now + 500_000_000L < endNanos;
    }

    boolean timeForGrade(long tick, long now) {
        return tick + 32 < endTick && now + 1_600_000_000L < endNanos;
    }

    static boolean grants(Bounds bounds, String candidateId, String usedCandidate, boolean nativeDirect) {
        return bounds != null && candidateId != null && !candidateId.equals(usedCandidate) && nativeDirect;
    }
    boolean canStartLeg() { return interruption == null && leg == null && legs < bounds.maxLegs; }
    double remaining() { return bounds.maxBlocks - travel; }
    double travel() { return travel; }
    int legs() { return legs; }
    Leg leg() { return leg; }
    boolean drove() { return drove; }
    boolean droveLeg() { return issuedAt >= 0; }
    boolean braking() { return brakeFrame >= 0; }
    String interruption() { return interruption; }

    void start(Leg next) {
        if (!canStartLeg() || next.limit < MIN_PROGRESS
                || next.limit > (next.grade() ? remaining() : Math.min(MAX_LEG, remaining())))
            throw new IllegalStateException("Recon leg is outside its grant");
        leg = next;
        legFrom = last;
        legTravel = legVertical = 0;
        brakeFrame = -1;
        settledFrame = -1;
    }

    /** Called after ordinary vanilla input gates, never for a proposed or vetoed press. */
    void issued(long tick) {
        if (leg == null || braking() || interruption != null || tick != lastTick)
            throw new IllegalStateException("Recon input without a current leg");
        issuedAt = tick;
        drove = true;
    }

    boolean priorKey(long tick) { return issuedAt == tick - 1; }

    void sample(long tick, Vec3d feet, boolean sameLife, boolean damaged) {
        if (tick == lastTick && sameLife && !damaged) return;
        Vec3d from = last;
        boolean consecutive = tick == lastTick + 1;
        last = feet;
        lastTick = tick;
        if (!sameLife || damaged || !consecutive) {
            incompleteMotion |= drove;
            cancel(!sameLife ? "The player or world changed."
                : damaged ? "Damage or knockback interrupted the scout."
                : "A gap interrupted continuous movement measurement.");
            return;
        }
        if (incompleteMotion) return;
        double dx = feet.x - from.x, dz = feet.z - from.z;
        double distance = Math.hypot(dx, dz);
        if (distance < 1e-7 && Math.abs(feet.y - from.y) < 1e-7) return;
        double dy = feet.y - from.y;
        boolean grade = leg != null && leg.grade();
        if (leg == null || issuedAt < 0 || distance > 0.28 || Math.abs(dy) > (grade ? 0.62 : 0.055)
                || dx * leg.dx + dz * leg.dz < -1e-6 || Math.abs(dx * leg.dz - dz * leg.dx) > 0.015
                || !grade && !priorKey(tick) && !braking()
                || grade && (feet.y < legFrom.y + Math.min(0, leg.height) - 0.055
                    || feet.y > legFrom.y + (leg.height > 0 ? 1.34 : 0.055)
                    || leg.height < 0 && dy > 0.055 || legVertical + Math.abs(dy) > leg.verticalReserve)) {
            incompleteMotion |= drove;
            cancel("The dry stance or contiguous goalward motion changed.");
            return;
        }
        // Count the actual path, not net displacement: release and coast still spend this grant.
        travel += feet.distanceTo(from);
        legTravel += feet.distanceTo(from);
        legVertical += Math.abs(dy);
        measuredX += dx;
        measuredY += feet.y - from.y;
        measuredZ += dz;
        if (travel > bounds.maxBlocks || legTravel > leg.limit) cancel("Observed movement exceeded the stopping bound.");
    }

    static double keyEnvelope(Vec3d velocity) {
        return (Math.hypot(velocity.x, velocity.z) + MAX_ACCELERATION) / (1 - DRAG) + MARGIN;
    }

    static double neutralSideDrift(Vec3d velocity, Leg leg) {
        return (-leg.dz * velocity.x + leg.dx * velocity.z) / (1 - DRAG);
    }

    /** Next key and up to fourteen air-drag ticks before even the interrupted jump returns to its source. */
    static double gradeKeyEnvelope(Vec3d velocity, boolean grounded) {
        double speed = Math.hypot(velocity.x, velocity.z) + (grounded ? MAX_ACCELERATION : 0.027);
        double coast = speed;
        speed *= grounded ? DRAG : AIR_DRAG;
        for (int i = 0; i < 14; ++i) {
            coast += speed;
            speed *= AIR_DRAG;
        }
        return coast + speed / (1 - DRAG) + MARGIN;
    }

    static double descentKeyEnvelope(Vec3d velocity, double dryToLip) {
        double speed = Math.hypot(velocity.x, velocity.z) + MAX_ACCELERATION;
        double coast = 0;
        int air = 0;
        for (int i = 0; i < 28; ++i) {
            coast += speed;
            if (coast >= dryToLip || air > 0) ++air;
            speed *= air > 1 && air <= 12 ? AIR_DRAG : DRAG;
        }
        return coast + speed / (1 - DRAG) + MARGIN;
    }

    boolean admitsGradeKey(double horizontalEnvelope, double landingRoom) {
        if (leg == null || !leg.grade()) return false;
        double worst = horizontalEnvelope + Math.max(0, leg.verticalReserve - legVertical);
        return !braking() && interruption == null && horizontalEnvelope <= landingRoom
            && worst <= remaining() && worst <= leg.limit - legTravel;
    }

    boolean admitsKey(Vec3d velocity, double known) {
        double worst = keyEnvelope(velocity);
        return leg != null && !leg.grade() && !braking() && interruption == null && worst < known
            && worst <= remaining() && worst <= leg.limit - legTravel
            && worst <= towardRoom(last, target, leg.dx, leg.dz);
    }

    static double towardRoom(Vec3d feet, Vec3d aim, double dx, double dz) {
        return (aim.x - feet.x) * dx + (aim.z - feet.z) * dz - STANDOFF;
    }

    void brake(long frame) {
        if (!braking()) brakeFrame = frame;
    }

    void cancel(String detail) {
        if (interruption == null) interruption = detail;
    }

    void observePremises(boolean sameGrant, boolean safeControls, boolean unchangedStock, boolean sameVisibleSurface) {
        if (!sameGrant) cancel("The host is no longer granting this exact reconnaissance.");
        else if (!safeControls) cancel("The exact dry stance, hands, viewport or input changed.");
        else if (!unchangedStock)
            cancel("Inventory, equipment or selected hand changed; reconnaissance authorizes no pickup or spending.");
        else if (!sameVisibleSurface)
            cancel("The exact nominated surface no longer has a current unobstructed first-person witness.");
    }

    /** No further leg joins until the previous one has stopped and a later real render witnesses it. */
    boolean settle(long renderFrame) { return settle(renderFrame, true); }

    boolean settle(long renderFrame, boolean endpointHeld) {
        if (!braking() || renderFrame <= brakeFrame || leg == null) return false;
        settledFrame = renderFrame;
        double advance = (last.x - legFrom.x) * leg.dx + (last.z - legFrom.z) * leg.dz;
        if (endpointHeld && !incompleteMotion && advance >= MIN_PROGRESS
                && distance(last, target) <= distance(legFrom, target) - MIN_PROGRESS)
            ++legs;
        else if (interruption == null) cancel("The leg did not make enough physical goalward progress.");
        leg = null;
        issuedAt = -1;
        return true;
    }

    private static double distance(Vec3d a, Vec3d b) { return Math.hypot(a.x - b.x, a.z - b.z); }

    String receipt(String detail) {
        return String.format(Locale.ROOT, "%s %d/%d legs verified; %.3f blocks of measured cumulative travel (limit %d); "
                + "%.3f blocks net displacement. %s%s",
            detail, legs, bounds.maxLegs, travel, bounds.maxBlocks,
            Math.sqrt(measuredX * measuredX + measuredY * measuredY + measuredZ * measuredZ),
            settledFrame < 0 ? "No fresh settled render confirmed." : "Fresh settled render " + settledFrame + " confirmed.",
            incompleteMotion ? " Interrupted motion/knockback was not credited to reconnaissance." : "");
    }
}
