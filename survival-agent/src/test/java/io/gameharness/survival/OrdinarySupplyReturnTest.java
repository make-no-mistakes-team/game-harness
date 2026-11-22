package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

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

    @Test
    void shallowRetriesExhaustThePatchButDepthAndOreReallyAdvanceTheMine() {
        var foot = MINE.withY(50);
        var mine = new AgentProgress.MineSetback();
        mine.begin(50, 0);
        mine.exhausted(foot);
        assertFalse(mine.ready(false), "one exhausted site still leaves ordinary recovery");
        assertTrue(mine.ready(true), "explicit refusal followed by exhausted recovery is enough");
        mine.depth(49);
        mine.exhausted(foot.north().up());
        assertTrue(mine.ready(false), "a shallow oscillation does not renew mining");
        assertFalse(mine.material(0), "kit or slot changes without ore do not renew mining");
        assertTrue(mine.ready(false));
        mine.depth(47);
        assertFalse(mine.ready(true), "genuinely deeper settled work clears the setback");
        mine.exhausted(foot.down(3));
        mine.material(1);
        assertFalse(mine.ready(true), "actual ore gain clears the setback");
    }

    @Test
    void mineResiteRetreatNeedsAnExactContactAndContinuousDryGrades() {
        var foot = new BlockPos(-20, 50, 33);
        var trail = List.of(foot.west().up(3).south(3), foot.up(2).south(3),
            foot.up().south(3), foot.south(2), foot.up().south(), foot);
        assertEquals(-1, AgentProgress.mineRetreatTarget(trail, 5, foot.east(), (from, to) -> true),
            "being next to a saved foot is not a join");
        assertEquals(2, AgentProgress.mineRetreatTarget(trail, 5, foot, (from, to) -> true),
            "a same-column vertical discontinuity cannot be used as a stair");
        assertEquals(0, AgentProgress.mineRetreatTarget(trail.subList(2, 6), 3, foot, (from, to) -> true),
            "the exact joined grades, including a downward return tread, remain retrace candidates");
        assertEquals(-1, AgentProgress.mineRetreatTarget(trail, 5, foot,
            (from, to) -> !to.equals(foot.south(2))), "a refused lane cannot be skipped");
    }

    @Test
    void nativeResiteNeedsPhysicalDistanceAndDoesNotCreditDepthOrOre() {
        var foot = MINE.withY(50);
        var newSite = foot.north(6).down(6);
        var mine = new AgentProgress.MineSetback();
        mine.begin(50, 2);
        mine.exhausted(foot);
        mine.exhausted(foot.north());
        assertTrue(mine.ready(false)); // No strategy mailbox or model.
        mine.retire();
        assertFalse(mine.resited(foot.north(2)));
        assertTrue(mine.ready(false), "a neighboring landing is not a different mine start");
        assertTrue(mine.resited(newSite));
        assertTrue(mine.retired(foot));
        assertFalse(mine.ready(false));
        mine.exhausted(newSite);
        mine.depth(47);
        assertFalse(mine.ready(true), "physical relocation did not advance the mining depth checkpoint");
    }

    private static int anchor(List<BlockPos> trail, BlockPos actor) {
        return AgentProgress.connectedReturnAnchor(trail, trail.size() - 1, 0, actor, (from, to) -> false);
    }
}
