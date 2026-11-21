package io.gameharness.survival;

/** Ordinary light and workshop materials for one useful mining trip. */
final class AgentMineLight {
    private static final int RETURN_TORCHES = 2;
    private static final int STEPS_PER_TORCH = 7;
    private static final int TORCHES_PER_CRAFT = 4;
    private static final int CHARCOAL_PER_BATCH = 3;
    private static final int COOK_TICKS = 200;
    private static final int PLANK_TICKS = 300;

    static int routeSteps(int y, int depth) {
        int drop = Math.max(0, y - depth);
        return drop + drop / 9 + 12; // Stair landings and a little prospecting at depth.
    }

    static int tripTorches(int routeSteps) {
        // Budget the next useful stretch, not an entire shaft in one supply order.
        return RETURN_TORCHES + Math.min(CHARCOAL_PER_BATCH * TORCHES_PER_CRAFT,
            Math.ceilDiv(routeSteps, STEPS_PER_TORCH));
    }

    static int charcoalNeeded(int target, int torches, int coalOrCharcoal) {
        return Math.min(CHARCOAL_PER_BATCH,
            Math.max(0, Math.ceilDiv(Math.max(0, target - torches), TORCHES_PER_CRAFT) - coalOrCharcoal));
    }

    record Wood(int logs, int burnableLogs, int rawStack, int planks, int plankHeat, int sticks) {
        /** Positive if payable now; negative if a spare burnable log must become planks first. */
        int charcoal(int wanted, int benchWood, int setupWood) {
            int timber = planks + 4 * logs;
            // The furnace takes one raw stack; don't quote the sum of different species.
            // Fuel prep may draw from that stack, but with two one-log stacks either can be spared.
            int rawAfterFuel = Math.max(rawStack - 1, burnableLogs > 1 ? 1 : 0);
            for (int batch = Math.min(wanted, rawStack); batch > 0; batch--) {
                int stickWood = 2 * Math.ceilDiv(Math.max(0, batch + 2 - sticks), 4);
                int fuelWood = Math.ceilDiv(batch * COOK_TICKS, PLANK_TICKS);
                if (timber - 4 * batch < benchWood + stickWood + fuelWood) continue;
                if (plankHeat >= batch * COOK_TICKS + setupWood * PLANK_TICKS) return batch;
                if (rawAfterFuel >= batch) return -batch;
            }
            return 0;
        }
    }
}
