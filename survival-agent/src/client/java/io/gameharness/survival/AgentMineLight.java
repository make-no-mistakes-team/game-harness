package io.gameharness.survival;

/** Ordinary light and workshop materials for one useful mining trip. */
final class AgentMineLight {
    static final int PICK_HANDLES = 2;
    static final int MIN_PICK_USES = 4;
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

    static int stoneRefitSticks(int pickUses) {
        // Keep the handles for the next iron pick unless replacing the current tool is urgent.
        return pickUses < MIN_PICK_USES ? PICK_HANDLES : 2 * PICK_HANDLES;
    }

    static boolean fundsHandles(int wood, int sticks, int needed) {
        return wood >= 0 && convertibleSticks(wood, sticks) >= needed;
    }

    private static int convertibleSticks(int wood, int sticks) {
        return wood < 0 ? 0 : sticks + 4 * (wood / 2);
    }

    static int fundedTorches(int wanted, int held, int wood, int sticks, int benchWood,
                             int handleReserve, boolean emergency) {
        int localSticks = convertibleSticks(wood - benchWood, sticks);
        int reserve = localSticks >= handleReserve ? handleReserve : PICK_HANDLES;
        int batches = Math.min(wanted, Math.max(0, localSticks - reserve));
        if (batches > 0 || wanted == 0 || held > 3) return batches;
        // In immediate darkness, first give up funding the spare, then the bench.
        batches = Math.min(wanted, Math.max(0, localSticks - PICK_HANDLES));
        if (batches > 0 || !emergency) return batches;
        int carriedSticks = convertibleSticks(wood, sticks);
        return Math.min(wanted, Math.max(carriedSticks > 0 ? 1 : 0, carriedSticks - PICK_HANDLES));
    }

    record Wood(int logs, int burnableLogs, int rawStack, int planks, int plankHeat, int sticks) {
        /** Positive if payable now; negative if a spare burnable log must become planks first. */
        int charcoal(int wanted, int benchWood, int setupWood, int handleReserve) {
            int timber = planks + 4 * logs;
            // The furnace takes one raw stack; don't quote the sum of different species.
            // Fuel prep may draw from that stack, but with two one-log stacks either can be spared.
            int rawAfterFuel = Math.max(rawStack - 1, burnableLogs > 1 ? 1 : 0);
            for (int batch = Math.min(wanted, rawStack); batch > 0; batch--) {
                int fuelWood = Math.ceilDiv(batch * COOK_TICKS, PLANK_TICKS);
                if (!fundsHandles(timber - 4 * batch - benchWood - fuelWood, sticks, batch + handleReserve))
                    continue;
                if (plankHeat >= batch * COOK_TICKS + setupWood * PLANK_TICKS) return batch;
                if (rawAfterFuel >= batch) return -batch;
            }
            return 0;
        }
    }
}
