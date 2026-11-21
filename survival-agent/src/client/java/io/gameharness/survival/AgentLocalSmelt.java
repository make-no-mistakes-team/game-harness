package io.gameharness.survival;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.ItemTags;

/** Fingerprint of one native load; a synchronized slot is not an inventory receipt. */
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
