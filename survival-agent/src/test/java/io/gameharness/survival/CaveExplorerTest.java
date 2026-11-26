package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class CaveExplorerTest {

    @Test
    void ravineEntranceOutranksShallowSmallCaveMouth() {
        BlockPos player = new BlockPos(0, 68, 0);
        CaveExplorer.Entrance smallCave = new CaveExplorer.Entrance(new BlockPos(12, 66, 0), 62, false, 100);
        CaveExplorer.Entrance deepRavine = new CaveExplorer.Entrance(new BlockPos(24, 65, 0), 34, true, 100);
        double smallScore = CaveExplorer.scoreEntrance(player, smallCave);
        double ravineScore = CaveExplorer.scoreEntrance(player, deepRavine);
        assertTrue(ravineScore > smallScore + 30.0,
            "Deep ravine (" + ravineScore + ") should strongly outrank shallow cave mouth (" + smallScore + ")");
    }

    @Test
    void frontierScorerPrefersDeeperDarkPassageOverShallowSideShelf() {
        BlockPos player = new BlockPos(0, 50, 0);
        List<CaveExplorer.FrontierCandidate> cands = List.of(
            new CaveExplorer.FrontierCandidate(new BlockPos(6, 52, 0), 10, true, false, false),
            new CaveExplorer.FrontierCandidate(new BlockPos(10, 36, 2), 0, true, false, false),
            new CaveExplorer.FrontierCandidate(new BlockPos(8, 30, 0), 0, true, true, false) // lava hazard — must skip!
        );
        BlockPos best = CaveExplorer.scoreBestFrontier(cands, player, -90f, -54);
        assertEquals(new BlockPos(10, 36, 2), best);
    }

    @Test
    void shallowDeadEndCaveTriggersCleanExitToSurface() {
        CaveExplorer.CaveVerdict verdict = CaveExplorer.classifyCaveVerdict(
            52, 46, -54, false, 140, 240, false);
        assertEquals(CaveExplorer.CaveVerdict.EXIT_SHALLOW_CAVE, verdict);
    }

    @Test
    void shallowCaveContinuesWhileVisibleOreRemains() {
        CaveExplorer.CaveVerdict verdict = CaveExplorer.classifyCaveVerdict(
            52, 46, 16, false, 300, 300, true);
        assertEquals(CaveExplorer.CaveVerdict.CONTINUE_EXPLORING, verdict);
    }

    @Test
    void deepDeepslateDeadEndTransitionsToBranchMiningInsteadOfClimbingOut() {
        CaveExplorer.CaveVerdict verdict = CaveExplorer.classifyCaveVerdict(
            -34, -38, -54, false, 200, 260, false);
        assertEquals(CaveExplorer.CaveVerdict.TRANSITION_DEEP_MINE, verdict);
    }

    @Test
    void exhaustedEntranceIsSkippedWhenPickingNextSurfaceCave() {
        CaveExplorer explorer = new CaveExplorer();
        BlockPos player = new BlockPos(0, 68, 0);
        List<Perception.CaveSight> sights = List.of(
            new Perception.CaveSight(new BlockPos(10, 64, 0), 58, 6, false, 10),
            new Perception.CaveSight(new BlockPos(-18, 63, 4), 40, 12, true, 10)
        );
        explorer.ingestObservations(sights, player, 15, 10);
        CaveExplorer.Entrance first = explorer.pickBestSurfaceEntrance(player);
        assertNotNull(first);
        assertTrue(first.ravineLike, "Should pick ravine first");
        explorer.beginApproachEntrance(first, 15);
        explorer.markActiveEntranceExhausted(200);

        CaveExplorer.Entrance second = explorer.pickBestSurfaceEntrance(player);
        assertNotNull(second);
        assertFalse(second.ravineLike, "After exhausting ravine, should pick remaining unexhausted cave mouth");
        assertEquals(1, explorer.exhaustedCaveCount());
    }
}
