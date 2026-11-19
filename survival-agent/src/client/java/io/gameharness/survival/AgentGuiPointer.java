package io.gameharness.survival;

/** One gesture in GUI-scaled coordinates. Readbacks, hit tests and input stay with AgentHands. */
final class AgentGuiPointer {
    private static final long BRAKE_NANOS = 140_000_000L;
    private static final long VELOCITY_SAMPLE_NANOS = 24_000_000L;
    private static final double LOG_2 = Math.log(2);

    private double left, top, width, height, insetX, insetY;
    private double scaleX, scaleY;
    private double fromX, fromY, startControlX, startControlY, endControlX, endControlY, entryX, entryY;
    private long start, approachEnd, stop, sampleAt;
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
              double scaleX, double scaleY, boolean precise, double incomingVx, double incomingVy) {
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

        double centerX = left + width * .5, centerY = top + height * .5;
        double dx = centerX - fromX, dy = centerY - fromY;
        double distance = Math.hypot(dx, dy);
        // Half-chord of the inset rectangle along the direction of approach, not just its width.
        double chordRatio = 1 / Math.max(Math.abs(dx) / (width * .5 - insetX),
                Math.abs(dy) / (height * .5 - insetY));
        double halfChord = chordRatio * distance;
        double stride = chordRatio * Math.min(1, 7 / halfChord);
        boolean glide = !precise && Math.min(width, height) >= 12 && halfChord >= 4;
        double landing = glide ? .47 : -.40;
        landingX = centerX + dx * stride * landing;
        landingY = centerY + dy * stride * landing;
        entryX = glide ? centerX - dx * stride * .76 : landingX;
        entryY = glide ? centerY - dy * stride * .76 : landingY;

        double difficulty = Math.log1p(distance / (2 * halfChord)) / LOG_2;
        long approach = (long) (Math.min(220, 58 + 29 * difficulty) * 1_000_000);
        approachEnd = now + approach;
        stop = approachEnd + (glide ? BRAKE_NANOS : 0);
        // Match tangents at tail entry and carry a small amount of recent release velocity into the next stroke.
        double launchSpeed = Math.hypot(incomingVx, incomingVy);
        double launchFactor = launchSpeed == 0 ? 0 : Math.min(approach * (1e-9 / 3),
                Math.min(4, distance * .15) / launchSpeed);
        startControlX = fromX + incomingVx * launchFactor;
        startControlY = fromY + incomingVy * launchFactor;
        double exitFactor = glide ? 2d * approach / (3 * BRAKE_NANOS) : 0;
        endControlX = entryX - (landingX - entryX) * exitFactor;
        endControlY = entryY - (landingY - entryY) * exitFactor;
    }

    void advance(long now) {
        if (now >= stop) {
            x = landingX;
            y = landingY;
            settled = true;
        } else if (now >= approachEnd) {
            braking = true;
            double remaining = (double) (stop - now) / BRAKE_NANOS;
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
