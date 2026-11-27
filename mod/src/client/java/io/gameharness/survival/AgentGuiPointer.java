package io.gameharness.survival;

import java.util.SplittableRandom;

/** One gesture in GUI-scaled coordinates with natural human speed, curve, and landing variability. */
final class AgentGuiPointer {
    private static final long BASE_BRAKE_NANOS = 135_000_000L;
    private static final long VELOCITY_SAMPLE_NANOS = 24_000_000L;
    private static final double LOG_2 = Math.log(2);

    private final SplittableRandom rng = new SplittableRandom(System.nanoTime() ^ 0x517cc1b727220a95L);

    private double left, top, width, height, insetX, insetY;
    private double scaleX, scaleY;
    private double fromX, fromY, startControlX, startControlY, endControlX, endControlY, entryX, entryY;
    private long start, approachEnd, stop, brakeNanos, sampleAt;
    private double sampleX, sampleY;
    boolean planned, braking, settled;
    double x, y, landingX, landingY, vx, vy;

    void reset() {
        planned = false;
    }

    boolean matches(double left, double top, double width, double height, double scaleX, double scaleY) {
        return planned && this.left == left && this.top == top && this.width == width && this.height == height
                && this.scaleX == scaleX && this.scaleY == scaleY;
    }

    void plan(long now, double fromX, double fromY, double left, double top, double width, double height,
              double scaleX, double scaleY, boolean precise, double incomingVx, double incomingVy,
              double nextX, double nextY) {
        this.left = left;
        this.top = top;
        this.width = width;
        this.height = height;
        this.scaleX = scaleX;
        this.scaleY = scaleY;
        insetX = Math.min(width * .23, Math.max(scaleX, width * .125));
        insetY = Math.min(height * .23, Math.max(scaleY, height * .125));
        this.fromX = x = sampleX = fromX;
        this.fromY = y = sampleY = fromY;
        sampleAt = start = now;
        vx = vy = 0;
        planned = true;
        braking = false;
        if (inside(fromX, fromY)) {
            landingX = fromX;
            landingY = fromY;
            approachEnd = stop = now;
            settled = true;
            return;
        }
        settled = false;

        double anchorX = left + width * .5, anchorY = top + height * .5;
        double halfX = width * .5 - insetX, halfY = height * .5 - insetY;
        if (!precise) {
            // Favor the incoming side, open a lane toward the next target, AND add organic human target jitter!
            double dx = fromX - anchorX, dy = fromY - anchorY;
            double nx = nextX - anchorX, ny = nextY - anchorY;
            double in = Math.max(Math.abs(dx), Math.abs(dy));
            double out = Math.max(Math.abs(nx), Math.abs(ny));
            double inBias = Math.min(3.3, Math.min(halfX, halfY) * .52) / in;
            double outBias = out > 0 ? Math.min(4.5, Math.min(halfX, halfY) * .70) / out : 0;
            double jitterX = (rng.nextDouble() - rng.nextDouble()) * halfX * 0.58;
            double jitterY = (rng.nextDouble() - rng.nextDouble()) * halfY * 0.58;
            anchorX += bounded(dx * inBias + nx * outBias + jitterX, halfX * .82);
            anchorY += bounded(dy * inBias + ny * outBias + jitterY, halfY * .82);
        }
        double dx = anchorX - fromX, dy = anchorY - fromY;
        double distance = Math.hypot(dx, dy), ux = dx / distance, uy = dy / distance;
        // The chord accounts for approach angle and rectangle aspect, unlike horizontal width.
        double backward = chord(anchorX, anchorY, -ux, -uy);
        double forward = chord(anchorX, anchorY, ux, uy);
        boolean glide = !precise && Math.min(width, height) >= 12 && backward + forward >= 8;
        double landingFrac = 0.52 + rng.nextDouble() * 0.34;
        double landing = glide ? Math.min(7, forward) * landingFrac : -Math.min(7, backward) * (0.28 + rng.nextDouble() * 0.28);
        double entry = glide ? -Math.min(7, backward) * (0.65 + rng.nextDouble() * 0.25) : landing;
        landingX = anchorX + ux * landing;
        landingY = anchorY + uy * landing;
        entryX = anchorX + ux * entry;
        entryY = anchorY + uy * entry;

        // Controlled human speed variability: triangular-ish effort spread from ~0.72x (deliberate) to ~1.44x (brisk flick)
        double speedFactor = 0.72 + 0.36 * (rng.nextDouble() + rng.nextDouble());
        // Occasional brisk flick (~15% chance) or slightly careful stroke (~12% chance)
        double moodRoll = rng.nextDouble();
        if (moodRoll < 0.15) speedFactor *= 1.16;
        else if (moodRoll > 0.88) speedFactor *= 0.84;

        double difficulty = Math.log1p(distance / (backward + forward)) / LOG_2;
        double baseApproachMs = Math.min(235, 56 + 30 * difficulty);
        long approach = (long) Math.max(42_000_000L, (baseApproachMs / speedFactor) * 1_000_000.0);
        brakeNanos = (long) Math.max(65_000_000L, (BASE_BRAKE_NANOS * (0.78 + rng.nextDouble() * 0.48)) / Math.sqrt(speedFactor));
        approachEnd = now + approach;
        stop = approachEnd + (glide ? brakeNanos : 0);

        // Match tangents at tail entry, carry release velocity, AND add subtle human wrist-arc curvature!
        double launchSpeed = Math.hypot(incomingVx, incomingVy);
        double launchFactor = launchSpeed == 0 ? 0 : Math.min(approach * (1e-9 / 3),
                Math.min(4, distance * .15) / launchSpeed);
        double perpX = -uy;
        double perpY = ux;
        double bowSign = rng.nextBoolean() ? 1.0 : -1.0;
        double bowMag = distance > 18.0 ? Math.min(26.0, distance * (0.045 + rng.nextDouble() * 0.105)) * bowSign : 0.0;
        double bowStartShare = 0.45 + rng.nextDouble() * 0.55;
        double bowEndShare = 0.35 + rng.nextDouble() * 0.65;

        startControlX = fromX + incomingVx * launchFactor + dx * (0.18 + rng.nextDouble() * 0.14) + perpX * bowMag * bowStartShare;
        startControlY = fromY + incomingVy * launchFactor + dy * (0.18 + rng.nextDouble() * 0.14) + perpY * bowMag * bowStartShare;

        double exitFactor = glide ? 2d * approach / (3 * brakeNanos) : 0;
        // Occasional subtle human overshoot & settle (~24% on longer strokes > 48px)
        double overshoot = (!precise && distance > 48.0 && rng.nextDouble() < 0.24)
            ? (2.5 + rng.nextDouble() * 4.2) : 0.0;
        endControlX = entryX - (landingX - entryX) * exitFactor + ux * overshoot + perpX * bowMag * bowEndShare;
        endControlY = entryY - (landingY - entryY) * exitFactor + uy * overshoot + perpY * bowMag * bowEndShare;
    }

    private double chord(double x, double y, double ux, double uy) {
        double horizontal = ux > 0 ? (left + width - insetX - x) / ux
                : ux < 0 ? (left + insetX - x) / ux : Double.POSITIVE_INFINITY;
        double vertical = uy > 0 ? (top + height - insetY - y) / uy
                : uy < 0 ? (top + insetY - y) / uy : Double.POSITIVE_INFINITY;
        return Math.min(horizontal, vertical);
    }

    private static double bounded(double value, double limit) {
        return Math.max(-limit, Math.min(limit, value));
    }

    void advance(long now) {
        if (now >= stop) {
            x = landingX;
            y = landingY;
            settled = true;
        } else if (now >= approachEnd) {
            braking = true;
            double remaining = (double) (stop - now) / Math.max(1L, brakeNanos);
            x = landingX - (landingX - entryX) * remaining * remaining;
            y = landingY - (landingY - entryY) * remaining * remaining;
        } else {
            double t = (double) (now - start) / (approachEnd - start), u = 1 - t;
            double a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
            x = a * fromX + b * startControlX + c * endControlX + d * entryX;
            y = a * fromY + b * startControlY + c * endControlY + d * entryY;
        }
    }

    boolean inside(double x, double y) {
        return x >= left + insetX && x < left + width - insetX
                && y >= top + insetY && y < top + height - insetY;
    }

    boolean visibleAt(double x, double y) {
        return x >= left && x < left + width && y >= top && y < top + height;
    }

    double offsetX(double x) { return x - (left + width * .5); }

    double offsetY(double y) { return y - (top + height * .5); }

    void observe(long now, double x, double y) {
        long elapsed = now - sampleAt;
        if (elapsed < VELOCITY_SAMPLE_NANOS) return;
        double perSecond = 1e9 / elapsed;
        vx = (x - sampleX) * perSecond;
        vy = (y - sampleY) * perSecond;
        sampleX = x;
        sampleY = y;
        sampleAt = now;
    }

    boolean ready() {
        // A sampled speed cap rejects fast arrivals after a hitch without insisting on rest.
        return planned && (braking || settled) && vx * vx + vy * vy <= 150 * 150;
    }
}
