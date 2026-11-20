package io.gameharness.survival;

import java.util.ArrayList;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** Combat target and pitch affordances from one first-person threat observation. */
final class AgentThreatView<T> {
    // Vanilla Enderman gaze tests dot > 1 - 0.025 / distance. Leave a small
    // margin for camera interpolation and normal look-motor continuation.
    private static final double GAZE_DISTANCE_FACTOR = 0.025;
    private static final double GAZE_MARGIN_DEGREES = 2.5;
    private final ArrayList<Vec3d> calmEyes = new ArrayList<>(0);
    private T target;
    private Vec3d aim;
    private double nearest;

    void begin(double rangeSquared) {
        target = null;
        aim = null;
        nearest = rangeSquared;
        calmEyes.clear();
    }

    boolean couldSelect(double distanceSquared) { return distanceSquared <= nearest; }

    void observeHostile(T entity, Vec3d point, double distanceSquared) {
        if (!couldSelect(distanceSquared)) return;
        target = entity;
        aim = point;
        nearest = distanceSquared;
    }

    void observeEnderman(T entity, Vec3d body, Vec3d eyes, double distanceSquared, boolean shownAngry) {
        if (shownAngry) observeHostile(entity, body, distanceSquared);
        else if (eyes != null) calmEyes.add(eyes);
    }

    T target() { return target; }
    Vec3d aim() { return aim; }
    boolean hasGazeRisk() { return !calmEyes.isEmpty(); }

    boolean canContactEnderman(T entity) { return entity == target && aim != null; }

    boolean canStrikeEnderman(T entity, double hitY, double eyeY, double height) {
        return canContactEnderman(entity) && hitY <= eyeY - 0.12 * height;
    }

    /** Never supplies a yaw or movement target: just keep a risky existing look below the eyes. */
    float lookPitch(Vec3d viewer, float yaw, float desiredYaw, float desiredPitch) {
        float pitch = desiredPitch;
        for (int i = 0; i < calmEyes.size(); i++) {
            Vec3d eyes = calmEyes.get(i);
            double x = eyes.x - viewer.x, y = eyes.y - viewer.y, z = eyes.z - viewer.z;
            double horizontal = Math.hypot(x, z);
            double distance = Math.hypot(horizontal, y);
            if (distance < GAZE_DISTANCE_FACTOR) continue;
            double eyePitch = Math.toDegrees(Math.atan2(-y, horizontal));
            double cone = Math.acos(1 - GAZE_DISTANCE_FACTOR / distance) + Math.toRadians(GAZE_MARGIN_DEGREES);
            double pitchDifference = Math.toRadians(pitch - eyePitch);
            if (Math.abs(pitchDifference) >= cone) continue;
            double eyeYaw = Math.toDegrees(Math.atan2(-x, z));
            double yawDifference = Math.toRadians(Math.min(Math.abs(MathHelper.wrapDegrees(eyeYaw - yaw)),
                Math.abs(MathHelper.wrapDegrees(eyeYaw - desiredYaw))));
            double horizontalShare = horizontal / distance * Math.cos(Math.toRadians(pitch));
            double dot = Math.cos(pitchDifference) - horizontalShare * (1 - Math.cos(yawDifference));
            if (dot > Math.cos(cone)) pitch = (float) Math.min(90, eyePitch + Math.toDegrees(cone));
        }
        return pitch;
    }
}
