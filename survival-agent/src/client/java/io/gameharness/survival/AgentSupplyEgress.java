package io.gameharness.survival;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.function.BiPredicate;
import net.minecraft.block.Blocks;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** Owns the ordinary-work exclusion and the exact physical premises of refused exits. */
final class AgentSupplyEgress {
    private record Refusal(String detail, Set<BlockPos> cells) {}

    private final Map<BlockPos, Refusal> refusals = new HashMap<>();
    private final Set<BlockPos> checked = new HashSet<>();
    private BlockPos foot;
    private boolean airborneHold;

    BlockPos foot() { return foot; }
    boolean active() { return foot != null; }

    boolean holdOrdinary(boolean airborne) {
        if (!airborne) airborneHold = false;
        return airborneHold;
    }

    String refusal(BlockPos standing) {
        var refusal = refusals.get(standing);
        return refusal == null ? null : refusal.detail();
    }

    boolean begin(BlockPos standing, boolean grounded) {
        if (!grounded || active() || refusal(standing) != null) return false;
        landed(standing);
        return true;
    }

    void landed(BlockPos standing) {
        foot = standing;
        checked.clear();
        checked.add(standing.down());
    }

    void considered(BlockPos cell) { checked.add(cell); }

    void observeBreak(BlockPos cell) {
        if (!refusals.isEmpty()) refusals.values().removeIf(refusal -> refusal.cells().contains(cell));
    }

    String refuse(String why, boolean airborne) {
        String reason = "supply egress blocked at " + foot.toShortString() + ": " + why;
        refusals.put(foot, new Refusal(reason, Set.copyOf(checked)));
        finish();
        airborneHold = airborne;
        return reason;
    }

    void finish() {
        foot = null;
        airborneHold = false;
        checked.clear();
    }

    void reset() {
        finish();
        refusals.clear();
    }

    /** A lit adjacent soil tread and clear passage suffice; a leaf ceiling does not make it a cave. */
    boolean handoffWoodland(AgentDryCaveRoute.ProbeView view, Direction bearing,
                           BiPredicate<BlockPos, Direction> sweepClear) {
        if (!active()) return false;
        for (int i = 0; i < 3; i++) {
            Direction lane = i == 0 ? bearing : i == 1 ? bearing.rotateYClockwise() : bearing.rotateYCounterclockwise();
            BlockPos to = foot.offset(lane), support = to.down();
            Vec3d center = Vec3d.ofBottomCenter(to);
            // This is only a local, in-frame handoff cue. The next owner has
            // to witness and authorize all of its own inputs independently.
            Vec3d farTop = center.add(0.38 * lane.getOffsetX(), -0.03, 0.38 * lane.getOffsetZ());
            if (view.top(farTop, support) != AgentBody.DryRouteTop.WITNESSED) continue;
            var shown = view.state(support);
            if (!(shown.isOf(Blocks.GRASS_BLOCK) || shown.isOf(Blocks.PODZOL) || shown.isOf(Blocks.MYCELIUM))
                    || view.space(center.add(0, 0.82, 0)) != AgentBody.DryRouteSample.CLEAR
                    || !sweepClear.test(to, lane)) continue;
            finish();
            return true;
        }
        return false;
    }
}
