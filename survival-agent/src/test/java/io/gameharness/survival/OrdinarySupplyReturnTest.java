package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class OrdinarySupplyReturnTest {
    private static final BlockPos ENTRANCE = new BlockPos(-20, 57, 15);
    private static final BlockPos STAIR = ENTRANCE.east().down();
    private static final BlockPos MINE = STAIR.east().down();
    private static final List<BlockPos> TRAIL = List.of(ENTRANCE, STAIR, MINE);

    @Test
    void returnStartsAtTheActorNotTheOldTipAndRequiresAConnectedPrefix() {
        assertEquals(2, anchor(TRAIL, MINE));
        assertEquals(1, anchor(TRAIL, STAIR));
        assertEquals(0, anchor(TRAIL, ENTRANCE), "the return destination is already underfoot");
        assertEquals(-1, anchor(TRAIL, STAIR.north()), "proximity is not a walked edge");
        assertEquals(-1, anchor(TRAIL, new BlockPos(-21, 62, 19)), "timber egress is off the mine trail");
        assertEquals(-1, anchor(TRAIL, new BlockPos(-22, 64, 16)), "a recovery landing is not an old breadcrumb");
        assertEquals(-1, anchor(List.of(ENTRANCE, MINE), MINE), "an exact match beyond a gap is not a route");
        assertEquals(-1, anchor(List.of(ENTRANCE, ENTRANCE.up()), ENTRANCE.up()), "no inferred pillar descent");
        assertEquals(1, AgentProgress.connectedReturnAnchor(List.of(ENTRANCE, MINE), 1, 0, MINE,
            (from, to) -> from.equals(MINE) && to.equals(ENTRANCE)), "an explicitly walked water edge is different");
    }

    @Test
    void suppliedLocalReplacementCannotDisplaceProductiveFurnace() {
        int disconnected = anchor(TRAIL, new BlockPos(-21, 62, 19));
        assertEquals(AgentProgress.FurnaceSite.RETURN, AgentProgress.furnaceSite(false, false, 3, true));
        assertEquals(AgentProgress.FurnaceSite.LOCAL, AgentProgress.furnaceSite(false, true, disconnected, true));
        assertEquals(AgentProgress.FurnaceSite.ESTABLISH, AgentProgress.furnaceSite(false, false, disconnected, true));
        assertEquals(AgentProgress.FurnaceSite.ESTABLISH, AgentProgress.furnaceSite(false, false, 13, true));
        assertEquals(AgentProgress.FurnaceSite.RETURN, AgentProgress.furnaceSite(false, false, 13, false));
        assertEquals(AgentProgress.FurnaceSite.PAID, AgentProgress.furnaceSite(true, false, disconnected, true));
        assertEquals(AgentProgress.FurnaceSite.PAID, AgentProgress.furnaceSite(true, true, 3, true));
    }

    private static int anchor(List<BlockPos> trail, BlockPos actor) {
        return AgentProgress.connectedReturnAnchor(trail, trail.size() - 1, 0, actor, (from, to) -> false);
    }
}
