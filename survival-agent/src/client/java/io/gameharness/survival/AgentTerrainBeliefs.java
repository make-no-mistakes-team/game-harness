package io.gameharness.survival;

import net.minecraft.util.math.BlockPos;

/**
 * Local, expendable assumptions from admitted observations, never terrain observations themselves.
 * Callers supply only things already seen or physically contacted; this module cannot query terrain.
 */
final class AgentTerrainBeliefs {
    static final int MAX_AGE_TICKS = 160;
    static final int BLIND_HORIZON = 3;
    private static final int OBSERVATION_LIMIT = 128;
    private static final int SCOPE_LIMIT = 32;
    private static final int EXCAVATION_SCOPE_RADIUS = 6;

    enum Context { EXCAVATION, TRUNK }
    enum Material { BASE_ROCK, LOG, AIR, FLUID, OTHER }
    enum Outcome { SUPPORTED, FALL, COLLISION, CANCELLED }
    enum Confidence { CONTEXTUAL, CORROBORATED }
    enum Basis {
        OCCUPIED_LOG_CONTINUATION,
        EXPOSED_VERTICAL_LOG_PAIR,
        CONTIGUOUS_EXPOSED_ROCK,
        OCCUPIED_ROCK_AND_EXPOSED_CUT
    }

    /** Scope is a local column or excavation, not a route or a resource location. */
    record Scope(Context context, BlockPos anchor, int radius) {}

    static final class Observation {
        private final BlockPos pos;
        private final Material material;
        private int tick;

        private Observation(BlockPos pos, Material material, int tick) {
            this.pos = pos;
            this.material = material;
            this.tick = tick;
        }

        BlockPos pos() { return pos; }
        Material material() { return material; }
        int tick() { return tick; }
        int ageAt(int tick) { return age(this.tick, tick); }
    }

    /** expected is deliberately restricted to a generic base material, never a specific ore. */
    record Hypothesis(long id, Material expected, Basis basis, Confidence confidence,
                      BlockPos source, BlockPos target, Scope scope, int createdTick) {
        int ageAt(int tick) { return age(createdTick, tick); }
    }

    private static final class LocalScope {
        final Scope label;
        final Hypothesis[] attempts = new Hypothesis[BLIND_HORIZON];
        final boolean[] finished = new boolean[BLIND_HORIZON];
        int spent;
        boolean contradicted;

        LocalScope(Context context, BlockPos anchor) {
            label = new Scope(context, anchor.toImmutable(),
                context == Context.TRUNK ? 0 : EXCAVATION_SCOPE_RADIUS);
        }

        boolean contains(BlockPos pos) {
            return label.context == Context.TRUNK
                ? pos.getX() == label.anchor.getX() && pos.getZ() == label.anchor.getZ()
                : distance(pos, label.anchor) <= label.radius;
        }
    }

    private final Observation[] observations = new Observation[OBSERVATION_LIMIT];
    private final LocalScope[] scopes = new LocalScope[SCOPE_LIMIT];
    private int observationCursor;
    private int scopeCount;
    private long nextId;

    /** World/life changes discard both observations and negative premises. Old permits stay invalid. */
    void reset() {
        for (int i = 0; i < observations.length; i++) observations[i] = null;
        for (int i = 0; i < scopeCount; i++) scopes[i] = null;
        observationCursor = 0;
        scopeCount = 0;
    }

    /** Repeated views refresh age, but do not replenish an action budget. */
    void observe(BlockPos pos, Material material, int tick) {
        if (pos == null || material == null) return;
        int slot = observationSlot(pos);
        Observation previous = slot < 0 ? null : observations[slot];
        if (previous != null && previous.material == material && previous.tick == tick) return;
        boolean alreadyFresh = previous != null && previous.material == material
            && previous.ageAt(tick) <= MAX_AGE_TICKS;
        if (previous != null && previous.material == material) {
            previous.tick = tick;
        } else {
            if (slot < 0) {
                slot = observationCursor;
                observationCursor = (observationCursor + 1) % OBSERVATION_LIMIT;
            }
            observations[slot] = new Observation(pos.toImmutable(), material, tick);
        }
        if (alreadyFresh) return;
        for (int i = 0; i < scopeCount; i++) {
            LocalScope scope = scopes[i];
            if (scope.contradicted) continue;
            for (int j = 0; j < scope.attempts.length; j++) {
                Hypothesis hypothesis = scope.attempts[j];
                if (hypothesis == null || !hypothesis.target.equals(pos)) continue;
                if (material != hypothesis.expected) {
                    scope.contradicted = true;
                    break;
                }
                // An actually exposed predicted cell pays back one blind action, not a whole horizon.
                scope.attempts[j] = null;
                scope.finished[j] = false;
                scope.spent--;
            }
        }
    }

    /** Observations remain separate from assumptions; stale observations are not returned. */
    Observation observed(BlockPos pos, int tick) {
        int slot = observationSlot(pos);
        if (slot < 0) return null;
        Observation observation = observations[slot];
        return observation.ageAt(tick) <= MAX_AGE_TICKS ? observation : null;
    }

    /**
     * Spend one ordinary action under uncertainty. Null means use another course or actual observation.
     * A permit proves neither support, clearance, loot, nor an interaction ray; callers still own input.
     */
    Hypothesis permit(Context context, BlockPos source, BlockPos target, int tick) {
        return permit(context, source, target, tick, null);
    }

    /** A flat 2x1 cut: occupied rock and the seen rock immediately above its next possible floor. */
    Hypothesis permitTunnel(BlockPos sourceSupport, BlockPos targetSupport, BlockPos exposedCut, int tick) {
        if (sourceSupport == null || targetSupport == null || exposedCut == null
                || sourceSupport.getY() != targetSupport.getY()
                || !exposedCut.equals(targetSupport.up())) return null;
        Observation wall = observed(exposedCut, tick);
        if (wall == null || wall.material != Material.BASE_ROCK) return null;
        return permit(Context.EXCAVATION, sourceSupport, targetSupport, tick,
            Basis.OCCUPIED_ROCK_AND_EXPOSED_CUT);
    }

    private Hypothesis permit(Context context, BlockPos source, BlockPos target, int tick, Basis grounds) {
        if (context == null || source == null || target == null || distance(source, target) != 1)
            return null;
        Material expected = context == Context.TRUNK ? Material.LOG : Material.BASE_ROCK;
        Observation sourceObservation = observed(source, tick);
        if (sourceObservation == null || sourceObservation.material != expected) return null;
        if (context == Context.TRUNK
            && (source.getX() != target.getX() || source.getZ() != target.getZ()
                || target.getY() != source.getY() - 1)) return null;
        // A known cell belongs to the observed-action seam, not an invented hypothesis.
        if (observed(target, tick) != null) return null;
        boolean pair = grounds != null || adjoiningObservation(source, expected, context == Context.TRUNK, tick);
        if (context == Context.EXCAVATION && !pair) return null;

        LocalScope scope = null;
        for (int i = 0; i < scopeCount; i++) {
            LocalScope candidate = scopes[i];
            if (candidate.label.context != context) continue;
            if (candidate.contains(source) || candidate.contains(target)) {
                if (candidate.contradicted) return null;
                if (scope == null) scope = candidate;
            }
        }
        if (scope == null) {
            // No eviction: forgotten failures must not turn into endlessly renewable permission.
            if (scopeCount == scopes.length) return null;
            scope = new LocalScope(context, source);
            scopes[scopeCount++] = scope;
        }
        if (scope.spent == BLIND_HORIZON) return null;
        for (int i = 0; i < scope.attempts.length; i++) {
            Hypothesis previous = scope.attempts[i];
            if (previous != null && previous.target.equals(target)) return null;
        }
        Basis basis = grounds != null ? grounds : context == Context.EXCAVATION ? Basis.CONTIGUOUS_EXPOSED_ROCK
            : pair ? Basis.EXPOSED_VERTICAL_LOG_PAIR : Basis.OCCUPIED_LOG_CONTINUATION;
        Hypothesis hypothesis = new Hypothesis(++nextId, expected, basis,
            pair ? Confidence.CORROBORATED : Confidence.CONTEXTUAL,
            source.toImmutable(), target.toImmutable(), scope.label, tick);
        for (int i = 0; i < scope.attempts.length; i++) {
            if (scope.attempts[i] != null) continue;
            scope.attempts[i] = hypothesis;
            scope.finished[i] = false;
            scope.spent++;
            return hypothesis;
        }
        return null;
    }

    boolean valid(Hypothesis hypothesis, int tick) {
        if (hypothesis == null || hypothesis.ageAt(tick) > MAX_AGE_TICKS) return false;
        for (int i = 0; i < scopeCount; i++) {
            LocalScope scope = scopes[i];
            if (scope.contradicted) continue;
            for (int j = 0; j < scope.attempts.length; j++)
                if (scope.attempts[j] == hypothesis && !scope.finished[j]) return true;
        }
        return false;
    }

    /** Physics can refute a premise. Merely standing somewhere does not observe its material. */
    void feedback(Hypothesis hypothesis, Outcome outcome, int tick) {
        if (hypothesis == null || outcome == null) return;
        for (int i = 0; i < scopeCount; i++) {
            LocalScope scope = scopes[i];
            for (int j = 0; j < scope.attempts.length; j++) {
                if (scope.attempts[j] != hypothesis || scope.finished[j]) continue;
                scope.finished[j] = true;
                if (outcome == Outcome.FALL || outcome == Outcome.COLLISION)
                    scope.contradicted = true;
                // Support/cancellation never invent material or replenish a blind budget.
                return;
            }
        }
    }

    private boolean adjoiningObservation(BlockPos source, Material material, boolean vertical, int tick) {
        for (int i = 0; i < observations.length; i++) {
            Observation observation = observations[i];
            if (observation == null || observation.material != material
                || observation.ageAt(tick) > MAX_AGE_TICKS || distance(source, observation.pos) != 1)
                continue;
            if (!vertical || source.getX() == observation.pos.getX()
                && source.getZ() == observation.pos.getZ()) return true;
        }
        return false;
    }

    private int observationSlot(BlockPos pos) {
        for (int i = 0; i < observations.length; i++)
            if (observations[i] != null && observations[i].pos.equals(pos)) return i;
        return -1;
    }

    private static long distance(BlockPos a, BlockPos b) {
        return Math.abs((long) a.getX() - b.getX()) + Math.abs((long) a.getY() - b.getY())
            + Math.abs((long) a.getZ() - b.getZ());
    }

    private static int age(int created, int now) {
        long elapsed = (long) now - created;
        return elapsed < 0 || elapsed > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) elapsed;
    }
}
