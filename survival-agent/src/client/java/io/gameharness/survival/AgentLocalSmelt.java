package io.gameharness.survival;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.ItemTags;

/** One native load, its optional field watch, and the separate inventory receipt. */
final class AgentLocalSmelt {
    enum View { SYNCING, CHANGED, COOKING, COLD, READY }

    static Item result(Item raw) {
        if (raw == Items.RAW_IRON) return Items.IRON_INGOT;
        return raw.getRegistryEntry().isIn(ItemTags.LOGS_THAT_BURN) ? Items.CHARCOAL : Items.AIR;
    }

    record Batch(Item raw, int units, int minimumOutput) {
        boolean mayDoSideWork() { return units > 1; }

        View view(boolean synced, boolean burning, ItemStack input, ItemStack output) {
            if (!synced) return View.SYNCING;
            if (!input.isEmpty() && !input.isOf(raw) || !output.isEmpty() && !output.isOf(result(raw))
                    || output.getCount() < minimumOutput || input.getCount() + output.getCount() != units)
                return View.CHANGED;
            return input.isEmpty() ? View.READY : burning ? View.COOKING : View.COLD;
        }
    }

    static final class Watch {
        private static final int MAX_WAIT = 3 * AgentHands.SMELT_TICKS;
        private static final int SIDE_WORK_TICKS = 90;
        private static final int WALK_RESERVE = 2 * AgentSurfaceTread.ORDINARY_GRADE_TICKS + 12;
        private static final int REOPEN_TICKS = 60;
        private int recheckAt, sideUntil, pickupStock = -1;
        private long closedAfterFrame;
        private boolean used, pickupTried;

        boolean canLeave(Batch batch, View view, boolean advancing) {
            return !used && batch.mayDoSideWork() && view == View.COOKING && advancing;
        }

        void leave(int tick, long frame, int remainingInput, float fraction) {
            // This estimates a recheck time only. The same paid slots still have to
            // synchronize and the actual result must be withdrawn into storage.
            int wait = Math.clamp(remainingInput * AgentHands.SMELT_TICKS
                - (int) (fraction * AgentHands.SMELT_TICKS), 1, MAX_WAIT);
            used = true;
            closedAfterFrame = frame;
            recheckAt = tick + wait;
            sideUntil = tick + Math.min(wait, SIDE_WORK_TICKS);
        }

        boolean active() { return recheckAt != 0; }
        boolean recheckDue(int tick) { return active() && tick >= recheckAt; }
        boolean recheckExpired(int tick) { return active() && tick - recheckAt >= REOPEN_TICKS; }
        boolean seesWorld(long frame) { return active() && frame > closedAfterFrame; }
        boolean sideTime(int tick) { return active() && tick < sideUntil; }
        boolean mayStepOut(int tick) { return sideTime(tick) && recheckAt - tick >= WALK_RESERVE; }

        void reopen() {
            used = true;
            recheckAt = 0;
            abandonPickup();
        }

        boolean canTargetPickup() { return active() && !pickupTried; }

        void targetPickup(int stock) {
            pickupTried = true;
            pickupStock = stock;
        }

        int observePickup(int stock) {
            if (pickupStock < 0 || stock <= pickupStock) return 0;
            int gained = stock - pickupStock;
            abandonPickup();
            return gained;
        }

        void abandonPickup() { pickupStock = -1; }
    }

    static final class Load {
        Item raw;
        int units;

        void placed(Item item, int count) {
            raw = item;
            units += count;
        }
    }

    static final class Withdrawal {
        private boolean taken, stored;

        void take() { taken = true; }
        void store() { stored = taken; }
        boolean wasTaken() { return taken; }
        boolean hasStoredResult() { return stored; }
    }
}
