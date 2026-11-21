package io.gameharness.survival;

import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** One audible fuse: a blocked bearing stays retired until another cue. */
final class AgentFuseEscape {
    static final float PITCH = 58;
    static final float DRIVE_ALIGNMENT = 3;
    private static final float[] SIDE_TURNS = {-38, 38, -65, 65, -95, 95};
    private static final int STALLED_INPUT_TICKS = 3;

    interface Terrain {
        boolean obstructed(float bearing);
        Vec3d dryLanding(float bearing);
    }

    enum Action {
        ALIGN("checking for a dry escape lane"),
        DRIVE("requesting movement on a witnessed dry lane"),
        BRACE("bracing; no dry escape lane proved");

        final String status;
        Action(String status) { this.status = status; }
    }

    private float away, bearing;
    private double dirX, dirZ;
    private Vec3d previousFeet, landing;
    private int stalled;
    private boolean previousGround, retired, alternate, braced, advanced, impact;
    private Action action = Action.ALIGN;

    void start(float away) {
        this.away = away;
        choose(away);
        previousFeet = landing = null;
        previousGround = retired = alternate = braced = advanced = impact = false;
        action = Action.ALIGN;
    }

    Action step(Vec3d feet, float yaw, float pitch, boolean grounded, boolean appliedForward,
                boolean impulse, Terrain terrain, float walkedBearing) {
        landing = null;
        advanced = false;
        impact |= impulse;
        if (impact || braced) return action = Action.BRACE;

        if (appliedForward && previousFeet != null) {
            double advance = (feet.x - previousFeet.x) * dirX + (feet.z - previousFeet.z) * dirZ;
            advanced = grounded && previousGround && Math.abs(feet.y - previousFeet.y) < 0.055 && advance >= 0.025;
            stalled = advance >= 0.025 ? 0 : stalled + 1;
        }
        previousFeet = feet;
        previousGround = grounded;
        boolean failed = stalled >= STALLED_INPUT_TICKS || grounded && terrain.obstructed(bearing);
        if (alternate && failed) return brace();
        retired |= failed;
        if (!grounded) return action = Action.ALIGN;

        boolean settled = difference(yaw, bearing) <= DRIVE_ALIGNMENT && Math.abs(pitch - PITCH) <= 8;
        if (alternate || !retired) {
            landing = terrain.dryLanding(bearing);
            if (landing != null) return action = Action.DRIVE;
            if (!settled) return action = Action.ALIGN;
            if (alternate) return brace();
            retired = true;
        }

        // The recent contact only nominates a heading. The living scene must still
        // show level, dry support and clear body space for any alternative.
        if (Float.isFinite(walkedBearing) && difference(walkedBearing, away) <= 95
                && difference(walkedBearing, away) >= 25 && alternate(terrain, walkedBearing))
            return action = Action.DRIVE;
        for (float turn : SIDE_TURNS) {
            if (alternate(terrain, away + turn)) return action = Action.DRIVE;
        }
        // One fixed look exposes the close ground on either side; never sweep
        // left/right speculatively or resume the failed bearing on landing.
        return settled ? brace() : (action = Action.ALIGN);
    }

    private boolean alternate(Terrain terrain, float candidate) {
        if (terrain.obstructed(candidate)) return false;
        Vec3d witnessed = terrain.dryLanding(candidate);
        if (witnessed == null) return false;
        alternate = true;
        choose(candidate);
        landing = witnessed;
        return true;
    }

    private void choose(float candidate) {
        bearing = candidate;
        double radians = Math.toRadians(candidate);
        dirX = -Math.sin(radians);
        dirZ = Math.cos(radians);
        stalled = 0;
    }

    private Action brace() {
        braced = true;
        return action = Action.BRACE;
    }

    private static float difference(float a, float b) { return Math.abs(MathHelper.wrapDegrees(a - b)); }

    float bearing() { return bearing; }
    Vec3d landing() { return landing; }
    boolean advanced() { return advanced; }
    String status() { return impact ? "holding after impact" : action.status; }
}
