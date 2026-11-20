package io.gameharness.survival;

import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;

/** The paid batch's continuity witness; it never reads a world, handler or inventory. */
final class AgentFurnaceWatch {
    record Stock(int raw, int fuel, int ingots) {
        boolean paidFrom(Stock before, AgentHands.IronBatch batch) {
            return raw == before.raw - batch.units() && fuel == before.fuel - batch.fuelCount()
                && ingots == before.ingots;
        }

        boolean collectedFrom(Stock paid, AgentHands.IronBatch batch) {
            return raw == paid.raw && fuel == paid.fuel && ingots == paid.ingots + batch.units();
        }
    }

    final BlockPos pos;
    final Direction facing;
    final int syncId;
    final Stock paid;
    private final AgentHands.IronBatch batch;
    private final int closedOutput, closedFuel, cookTicks;
    private final long closedTick, closedNanos;
    private boolean changed;

    AgentFurnaceWatch(BlockPos pos, Direction facing, int syncId, Stock paid, AgentHands.IronBatch batch,
                      int output, int fuel, float progress, long tick, long nanos) {
        this.pos = pos.toImmutable();
        this.facing = facing;
        this.syncId = syncId;
        this.paid = paid;
        this.batch = batch;
        closedOutput = output;
        closedFuel = fuel;
        cookTicks = (batch.units() - output) * AgentHands.SMELT_TICKS
            - Math.round(progress * AgentHands.SMELT_TICKS);
        closedTick = tick;
        closedNanos = nanos;
    }

    static boolean required(AgentHands.IronBatch batch) { return batch.units() > 1; }

    static boolean releasedForSide(AgentHands.IronBatch batch, long burnTick, long closedFrame, long witnessedFrame) {
        return required(batch) && burnTick > 0 && witnessedFrame > closedFrame;
    }

    void invalidate() { changed = true; }

    String accessProblem(BlockPos pos, Direction facing, boolean exclusive) {
        if (!exclusive) return "The owned single-player connection or actor-only roster no longer proves exclusive furnace access.";
        if (changed || !this.pos.equals(pos) || this.facing != facing)
            return "The exact furnace or its loaded chunk changed during the watch.";
        return null;
    }

    int remainingTicks(long tick) { return (int) Math.max(0, cookTicks - Math.max(0, tick - closedTick)); }

    boolean elapsed(long tick, long nanos) {
        return remainingTicks(tick) == 0 && nanos - closedNanos >= cookTicks * 50_000_000L;
    }

    String reopenProblem(int openedSyncId, boolean contentsSynced, long outputUpdates, int rawStock, int fuelStock,
                         int ingotStock, ItemStack raw, ItemStack fuel, ItemStack output) {
        if (changed) return "The furnace or loaded chunk changed before its fresh slot sync.";
        if (rawStock != paid.raw || fuelStock != paid.fuel || ingotStock != paid.ingots)
            return "The paid raw iron, fuel or carried ingot stock changed while the furnace was closed.";
        return pendingReopenProblem(syncId, openedSyncId, contentsSynced, outputUpdates,
            batch, closedOutput, closedFuel, raw, fuel, output);
    }

    static String pendingReopenProblem(int originalSyncId, int openedSyncId, boolean contentsSynced, long outputUpdates,
            AgentHands.IronBatch batch, int minimumOutput, int maximumFuel, ItemStack raw, ItemStack fuel, ItemStack output) {
        if (openedSyncId == originalSyncId || !contentsSynced || outputUpdates == 0)
            return "The reopened furnace has no independently synchronized new vanilla handler.";
        if (!matches(batch, minimumOutput, maximumFuel, raw, fuel, output))
            return "Fresh furnace slots do not conserve this batch's paid input, fuel and output.";
        return null;
    }

    /** The withdrawal edge is one-shot even if the subsequent inventory receipt is interrupted. */
    static final class Withdrawal {
        private Stock before;

        boolean issued() { return before != null; }
        Stock baseline() { return before; }

        boolean begin(Stock stock) {
            if (before != null) return false;
            before = stock;
            return true;
        }

        boolean confirms(Stock carried, AgentHands.IronBatch batch) {
            return before != null && carried.collectedFrom(before, batch);
        }
    }

    static boolean matches(AgentHands.IronBatch batch, int minimumOutput, int maximumFuel,
                           ItemStack raw, ItemStack fuel, ItemStack output) {
        return (raw.isEmpty() || raw.isOf(Items.RAW_IRON)) && (fuel.isEmpty() || fuel.isOf(batch.fuel()))
            && (output.isEmpty() || output.isOf(Items.IRON_INGOT))
            && raw.getCount() + output.getCount() == batch.units() && output.getCount() >= minimumOutput
            && fuel.getCount() <= maximumFuel;
    }

    static boolean exactResult(int units, long afterOutputUpdate, long outputUpdates,
                               ItemStack raw, ItemStack fuel, ItemStack result) {
        return raw.isEmpty() && fuel.isEmpty() && outputUpdates > afterOutputUpdate
            && result.isOf(Items.IRON_INGOT) && result.getCount() == units;
    }
}
