package io.gameharness.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/** Run-local diagnostics for the three fixed stance surveys, not an input or planning signal. */
final class AgentSurveyEvidence {
    enum Survey {
        FOOTING("footing", 0, 42), LEFT("left", -55, 31), RIGHT("right", 55, 31);

        static final Survey[] SLOTS = values();
        final String id;
        final int bit = 1 << ordinal();
        final float yawOffset, pitch;

        Survey(String id, float yawOffset, float pitch) {
            this.id = id;
            this.yawOffset = yawOffset;
            this.pitch = pitch;
        }

        float yaw(float base) { return yawOffset == 0 ? base : base + yawOffset; }

        static int mask(String id) {
            for (Survey survey : SLOTS) if (survey.id.equals(id)) return survey.bit;
            return 0;
        }
    }

    private static final int MAX_TRANSITIONS = 32;
    private int life, origin, present, seen, transitions, lost;
    private boolean originChanged;
    private long transitionTick;
    private JsonObject transition;

    boolean enabled() { return transitions < MAX_TRANSITIONS; }

    JsonObject observe(long tick, int life, int origin, int offered) {
        if (this.life != life) {
            this.life = life;
            present = seen = 0;
        }
        originChanged = this.origin != origin;
        this.origin = origin;
        lost = originChanged ? present : present & ~offered;
        int returned = originChanged ? 0 : seen & ~present & offered;
        present = offered;
        seen = originChanged ? offered : seen | offered;
        if ((lost | returned) == 0) return null;

        ++transitions;
        transitionTick = tick;
        transition = new JsonObject();
        if (returned != 0) {
            JsonArray names = new JsonArray(3);
            for (Survey survey : Survey.SLOTS) if ((returned & survey.bit) != 0) names.add(survey.id);
            transition.add("returned", names);
        }
        return transition;
    }

    int lost() { return lost; }
    boolean originChanged() { return originChanged; }

    JsonObject take(long tick) {
        if (transitionTick != tick) return null;
        JsonObject result = transition;
        transition = null;
        return result;
    }
}
