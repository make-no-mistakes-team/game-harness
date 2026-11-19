package io.gameharness.survival;

import java.util.function.Consumer;
import net.minecraft.util.math.MathHelper;

/** Ordinary first-person angular motion. The caller owns observation, input and safety arbitration. */
final class AgentLookMotor {
    enum Context {
        NORMAL, SCAN, FINE, PHYSICAL, GAIT, FALL, URGENT
    }

    private static final double SETTLED = 0.025;
    private static final double SIGNIFICANT_GOAL_ANGLE = 2.5;
    private static final double SIGNIFICANT_TRAVEL = 1.0;

    private final double speedCap;
    private final long seed;
    private final Consumer<AgentBody.LookEvidence> evidence;
    private long sequence;
    private int lastTick, endedTick = -100;
    private Context context;
    private AgentFaceAim target;
    private float goalYaw, goalPitch;
    private long startedAt, peakAt;
    private double distance, travel, peak, effort = 1;
    private double yawRate, pitchRate;
    private double nextYawRate, nextPitchRate;
    private double yawStep, pitchStep;
    private boolean brisk;

    AgentLookMotor(double speedCap, long seed, Consumer<AgentBody.LookEvidence> evidence) {
        this.speedCap = speedCap;
        this.seed = seed;
        this.evidence = evidence;
    }

    void step(Context requested, AgentFaceAim identity, float yaw, float pitch, float targetYaw, float targetPitch,
              double dt, long now, int tick) {
        lastTick = tick;
        double dy = MathHelper.wrapDegrees(targetYaw - yaw), dp = targetPitch - pitch;
        double remaining = Math.hypot(dy, dp);
        boolean newGoal = context == null || context != requested
            || identity != null && target != null && !identity.sameGoal(target)
            || (identity == null || target == null)
                && Math.hypot(MathHelper.wrapDegrees(targetYaw - goalYaw), targetPitch - goalPitch)
                    > SIGNIFICANT_GOAL_ANGLE;
        if (newGoal && (remaining > SETTLED || Math.hypot(yawRate, pitchRate) >= 0.4)) {
            end(now, "retargeted");
            begin(requested, identity, targetYaw, targetPitch, remaining, now);
        } else if (identity != null && target == null) {
            target = identity;
        }
        if (context == null) {
            yawStep = pitchStep = 0;
            return;
        }

        boolean fine = context == Context.FINE;
        double limit = speedCap * (fine ? 0.94 : Math.min(1, effort + (brisk ? 0.09 : 0.025)));
        double launch = fine ? 2600 : (brisk ? 3900 : 2350) * effort;
        double brake = fine ? 1020 : (brisk ? 1450 : 2600) * effort;
        double nearGain = fine ? 15 : (brisk ? 19 : 15);
        // In error space, the braking envelope ramps down before an overshoot;
        // linear capture at short distance keeps the endpoint quiet.
        double reaction = brake * dt;
        double stopSpeed = Math.sqrt(reaction * reaction + 2 * brake * remaining) - reaction;
        double desiredSpeed = Math.min(limit, Math.min(remaining * nearGain, stopSpeed));
        double scale = remaining > 1e-9 ? desiredSpeed / remaining : 0;
        double dyRate = dy * scale - yawRate, dpRate = dp * scale - pitchRate;
        double change = Math.hypot(dyRate, dpRate);
        double along = remaining > 1e-9 ? (yawRate * dy + pitchRate * dp) / remaining : 0;
        // A new goal does not zero velocity. Opposing or sideways velocity is
        // retired under the same vector acceleration bound as a normal brake.
        double accel = along < 0 || desiredSpeed < Math.hypot(yawRate, pitchRate) ? brake : launch;
        double fraction = change > 0 ? Math.min(1, accel * dt / change) : 0;
        nextYawRate = yawRate + dyRate * fraction;
        nextPitchRate = pitchRate + dpRate * fraction;
        yawStep = (yawRate + nextYawRate) * (0.5 * dt);
        pitchStep = (pitchRate + nextPitchRate) * (0.5 * dt);
        if (remaining <= SETTLED && Math.hypot(yawRate, pitchRate) < 0.4) {
            yawStep = pitchStep = 0;
            nextYawRate = nextPitchRate = 0;
        }
    }

    double yawStep() { return yawStep; }
    double pitchStep() { return pitchStep; }

    /** Sample player angles after the real vanilla mouse-pose update. */
    void applied(double yaw, double pitch, double dt, double elapsed, long now) {
        if (context == null) return;
        yawRate = Math.abs(yaw - yawStep) < 0.0002 ? nextYawRate : yaw / dt;
        pitchRate = Math.abs(pitch - pitchStep) < 0.0002 ? nextPitchRate : pitch / dt;
        double angle = Math.hypot(yaw, pitch);
        if (yawStep == 0 && pitchStep == 0 && yawRate == 0 && pitchRate == 0) {
            end(now, "settled");
        } else {
            measure(angle, elapsed, now);
        }
    }

    /** Record protected steering without imposing an ordinary gesture's profile on it. */
    void legacy(Context intent, float targetYaw, float targetPitch, double remaining,
                double yaw, double pitch, double dt, long now, int tick) {
        lastTick = tick;
        if (context != intent || now - startedAt >= 100_000_000L
                && Math.hypot(MathHelper.wrapDegrees(targetYaw - goalYaw), targetPitch - goalPitch)
                    > SIGNIFICANT_GOAL_ANGLE) {
            end(now, "retargeted");
            if (remaining > SETTLED) begin(intent, null, targetYaw, targetPitch, remaining, now);
        }
        double angle = Math.hypot(yaw, pitch);
        double scale = angle > 0 ? Math.min(1 / dt, speedCap / angle) : 0;
        yawRate = yaw * scale;
        pitchRate = pitch * scale;
        if (context == null) return;
        if (remaining < 0.08) end(now, "settled");
        else measure(angle, dt, now);
    }

    void stop(long now) {
        end(now, "stopped");
        yawRate = pitchRate = 0;
    }

    private void begin(Context intent, AgentFaceAim identity, float y, float p, double remaining, long now) {
        context = intent;
        target = identity;
        goalYaw = y;
        goalPitch = p;
        startedAt = peakAt = now;
        distance = remaining;
        travel = peak = 0;
        ++sequence;
        if (!safe(intent)) return;
        long sample = mix(seed + sequence * 0x9e3779b97f4a7c15L);
        double draw = (sample >>> 11) * 0x1.0p-53;
        // A short run of safe gestures shares some effort; a fresh burst does not.
        double requested = 0.72 + 0.28 * draw;
        effort = lastTick - endedTick <= 16
            ? 0.45 * effort + 0.55 * requested : requested;
        brisk = (intent == Context.SCAN
            ? draw >= 0.26 : draw + Math.min(0.18, remaining / 480) >= 0.52);
    }

    private static boolean safe(Context context) { return context == Context.NORMAL || context == Context.SCAN; }

    private void measure(double angle, double dt, long now) {
        travel += angle;
        double speed = angle / dt;
        if (speed > peak) {
            peak = speed;
            peakAt = now;
        }
    }

    private void end(long now, String outcome) {
        if (context == null) return;
        boolean safe = safe(context);
        if (travel >= SIGNIFICANT_TRAVEL) {
            String profile = safe ? brisk ? "brisk" : "gentle" : context == Context.FINE ? "deliberate" : "protected";
            evidence.accept(new AgentBody.LookEvidence(seed, sequence, lastTick, System.currentTimeMillis(),
                context.name(), profile, safe ? effort : 1,
                distance, travel, peak, (peakAt - startedAt) / 1_000_000, (now - startedAt) / 1_000_000, outcome));
        }
        if (safe) endedTick = lastTick;
        else endedTick = -100;
        context = null;
        target = null;
    }

    private static long mix(long value) {
        value = (value ^ value >>> 30) * 0xbf58476d1ce4e5b9L;
        value = (value ^ value >>> 27) * 0x94d049bb133111ebL;
        return value ^ value >>> 31;
    }
}
