package io.gameharness.survival;

/** Server packet witnesses on the exact vanilla furnace handler. */
public interface AgentFurnaceSync {
    boolean agent$furnaceContentsSynced();
    long agent$furnaceOutputUpdates();
}
