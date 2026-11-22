package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.item.Item;
import net.minecraft.item.Items;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class AgentStallGuardTest {
    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
    }

    @Test
    void firstSweepCanFinishWithoutInterruptingTheWitnessedWorkItJustFound() {
        assertFalse(AgentStallGuard.stalledByTurning(64, 0, 350, 341, 0));
        assertFalse(AgentStallGuard.stalledByTurning(110, 0, 275, 275, 0));
        assertTrue(AgentStallGuard.stalledByTurning(110, 0, 310, 35, 3));
        assertFalse(AgentStallGuard.stalledByTurning(110, 3, 310, 35, 3));
    }

    @Test
    void confirmedStairCutsKeepTheMinerThroughTheTorchEquipAndPlacement() {
        var work = new AgentReturnableMine.RouteWork();
        var retryStart = 3128;
        work.cut(new BlockPos(-22, 59, 15), 3236);
        work.cut(new BlockPos(-22, 58, 15), 3256);

        assertTrue(AgentStallGuard.retryWindowOpen(3277 - retryStart, false, work.recent(3277)),
            "a just-cleared stair can resume after equipment closes, without counting the equipment");
        assertTrue(AgentStallGuard.retryWindowOpen(3290 - retryStart, false, work.recent(3290)),
            "the second confirmed cell extends the working window beyond the first");

        work.light(3294);
        assertTrue(AgentStallGuard.retryWindowOpen(3305 - retryStart, false, work.recent(3305)));
        work.proved(3335);
        assertTrue(AgentStallGuard.retryWindowOpen(3345 - retryStart, false, work.recent(3345)),
            "fresh proof of the changed route can finish the tread");
        work.proved(3375);
        assertFalse(AgentStallGuard.retryWindowOpen(3393 - retryStart, false, work.recent(3393)),
            "verified work does not remove the retry ceiling");
    }

    @Test
    void stationaryPrepAndRepeatedReceiptsCannotRenewAnOrdinaryRetry() {
        var work = new AgentReturnableMine.RouteWork();
        var cell = new BlockPos(-22, 58, 15);
        work.proved(144);
        assertFalse(AgentStallGuard.retryWindowOpen(145, false, work.recent(145)),
            "looking, changing equipment, or proof without a route effect cannot buy another turn");

        work.cut(cell, 100);
        work.cut(cell, 144);
        work.proved(150);
        assertFalse(AgentStallGuard.retryWindowOpen(150, false, work.recent(150)),
            "the same cut and a proof loop cannot revive an expired window");

        work.light(205);
        work.light(252);
        assertTrue(AgentStallGuard.retryWindowOpen(230, true, work.recent(230)));
        assertFalse(AgentStallGuard.retryWindowOpen(254, true, work.recent(254)),
            "a repeated report of the same stair light cannot keep the handback alive");
    }

    @Test
    void refusedRiseDoesNotVetoAnotherGroundedLaneOrItsReverse() {
        var exits = new AgentStallGuard.Departures();
        var foot = new BlockPos(0, 64, 0);
        var rise = foot.east().up();
        exits.reject(foot, rise);

        assertFalse(exits.canCross(foot, rise));
        assertTrue(exits.canCross(foot, foot.east()));
        assertTrue(exits.canCross(foot, foot.west()));
        assertTrue(exits.canCross(rise, foot));
        assertTrue(exits.canCross(foot.north(), rise.north()));
        assertTrue(exits.beginSurvey(foot));
        assertFalse(exits.beginSurvey(foot), "a later rendering is not different footing");
        assertTrue(exits.beginSurvey(foot.west()));
        assertFalse(exits.canCross(foot, rise), "assessing another support must not erase a proved refusal");
    }

    @Test
    void briefDepartureCannotBounceBackToTheSameFootingButMayContinuePastOldGround() {
        var exits = new AgentStallGuard.Departures();
        var foot = new BlockPos(0, 64, 0);
        exits.stoodOn(foot);
        exits.stoodOn(foot.east());
        exits.stoodOn(foot.east(2));

        assertFalse(exits.newLanding(foot));
        assertFalse(exits.newLanding(foot.east()));
        assertFalse(exits.newLanding(foot.east(2)));
        assertTrue(exits.newLanding(foot.east(3)));
        assertTrue(exits.canCross(foot.east(2), foot.east()),
            "an old support is not a hazard when it leads to a genuinely different landing");
    }

    @Test
    void onlyAChangeInTheRefusedLanesOwnClearanceCanReopenIt() {
        var exits = new AgentStallGuard.Departures();
        var foot = new BlockPos(0, 64, 0);
        var pillar = foot.up();
        var east = foot.east();
        exits.reject(foot, pillar);
        exits.reject(foot, east);

        exits.changed(foot.north().up(2));
        assertFalse(exits.canCross(foot, pillar));
        assertFalse(exits.canCross(foot, east));
        exits.changed(east.up());
        assertFalse(exits.canCross(foot, pillar));
        assertTrue(exits.canCross(foot, east));
        exits.changed(foot.up(2));
        assertTrue(exits.canCross(foot, pillar));
    }

    @Test
    void aSidePassageCanOnlyClearItsExactHeadOrFootFaceFromTheTakeoff() {
        var from = new BlockPos(0, 60, 0);
        var foot = from.east();
        var head = foot.up();

        assertTrue(AgentStallGuard.passageFace(foot, Direction.EAST,
            new BlockHitResult(Vec3d.ofCenter(head), Direction.WEST, head, false), true));
        assertTrue(AgentStallGuard.passageFace(foot, Direction.EAST,
            new BlockHitResult(Vec3d.ofCenter(foot), Direction.WEST, foot, false), false));
        assertFalse(AgentStallGuard.passageFace(foot, Direction.EAST,
            new BlockHitResult(Vec3d.ofCenter(foot.down()), Direction.WEST, foot.down(), false), false));
        assertFalse(AgentStallGuard.passageFace(foot, Direction.EAST,
            new BlockHitResult(Vec3d.ofCenter(from.up(2)), Direction.DOWN, from.up(2), false), true));
        assertFalse(AgentStallGuard.passageFace(foot, Direction.EAST,
            new BlockHitResult(Vec3d.ofCenter(head), Direction.NORTH, head, false), true));
        assertFalse(AgentStallGuard.passageFace(foot, Direction.EAST,
            new BlockHitResult(Vec3d.ofCenter(head), Direction.WEST, head, true), true));
    }

    @Test
    void passageCoverCannotRestOnTheCutIfItFallsFlowsOrIsAttached() {
        assertFalse(AgentHeadroom.unsafeCutCover(Blocks.DIRT.getDefaultState()));
        assertFalse(AgentHeadroom.unsafeCutCover(Blocks.STONE.getDefaultState()));
        assertTrue(AgentHeadroom.unsafeCutCover(Blocks.GRAVEL.getDefaultState()));
        assertTrue(AgentHeadroom.unsafeCutCover(Blocks.SAND.getDefaultState()));
        assertTrue(AgentHeadroom.unsafeCutCover(Blocks.WATER.getDefaultState()));
        assertTrue(AgentHeadroom.unsafeCutCover(Blocks.LAVA.getDefaultState()));
        assertTrue(AgentHeadroom.unsafeCutCover(Blocks.TORCH.getDefaultState()));
        assertTrue(AgentHeadroom.unsafeCutCover(Blocks.POINTED_DRIPSTONE.getDefaultState()));
    }

    @Test
    void witnessedGrassLipStillAdmitsTheOrdinaryTreadAfterThePillarAndAnotherRiseFailed() {
        var exits = new AgentStallGuard.Departures();
        var hollow = new BlockPos(0, 64, 0);
        exits.stoodOn(hollow);
        exits.reject(hollow, hollow.up());
        exits.reject(hollow, hollow.west().up());

        var grade = riseFromTop(hollow, Direction.EAST, Blocks.GRASS_BLOCK.getDefaultState(), true);
        var tread = exits.riseTread(grade, 60);
        assertNotNull(tread);
        assertEquals(hollow, tread.from);
        assertEquals(hollow.east().up(), tread.to);
        assertTrue(tread.returning, "the rise uses the ordinary reverse-jump tread, not the pillar");
    }

    @Test
    void aSideOrAnObstructedOrWetTopCannotStartTheHollowExit() {
        var exits = new AgentStallGuard.Departures();
        var hollow = new BlockPos(0, 64, 0);
        var floor = hollow.east();
        var dirt = Blocks.DIRT.getDefaultState();
        var grass = Blocks.GRASS_BLOCK.getDefaultState();
        var side = new BlockHitResult(Vec3d.ofCenter(floor).add(-0.5, 0, 0), Direction.WEST, floor, false);
        assertTrue(AgentSurfaceTread.ordinaryRiseSide(hollow, Direction.EAST, side));
        var cue = new AgentBody.OrdinaryGrade(hollow, Direction.EAST, floor, dirt, grass, 40, null);
        assertNull(exits.riseTread(cue, 41), "the side is only a look cue");

        var crown = AgentSurfaceTread.reverseJumpSweep(floor.up(), hollow, Direction.WEST, 0.6);
        var roof = new Box(hollow.up(3));
        assertTrue(crown.intersects(roof), "the visible top alone would not clear this roof");
        assertNull(exits.riseTread(riseFromTop(hollow, Direction.EAST, grass, !crown.intersects(roof)), 60));
        assertNull(exits.riseTread(riseFromTop(hollow, Direction.EAST, Blocks.WATER.getDefaultState(), true), 60));
    }

    @Test
    void freshTopProofDoesNotRetryTheRefusedRiseOrReturnToRecentlyStoodOnFooting() {
        var exits = new AgentStallGuard.Departures();
        var hollow = new BlockPos(0, 64, 0);
        var grass = Blocks.GRASS_BLOCK.getDefaultState();
        exits.reject(hollow, hollow.east().up());
        exits.stoodOn(hollow.north().up());

        assertNull(exits.riseTread(riseFromTop(hollow, Direction.EAST, grass, true), 60));
        assertNull(exits.riseTread(riseFromTop(hollow, Direction.NORTH, grass, true), 60));
        assertNotNull(exits.riseTread(riseFromTop(hollow, Direction.SOUTH, grass, true), 60));
    }

    @Test
    void evenAProvedOrdinaryDescentIsNotAHollowExit() {
        var exits = new AgentStallGuard.Departures();
        var foot = new BlockPos(0, 64, 0);
        var floor = foot.east().down(2);
        var grade = gradeFromTop(foot, Direction.EAST, floor, Blocks.GRASS_BLOCK.getDefaultState(), true);

        assertFalse(grade.lookOnly());
        assertNull(exits.riseTread(grade, 60));
    }

    @Test
    void freshDryDescentCanLeaveTheRaisedFootingInsteadOfBuildingHigher() {
        var exits = new AgentStallGuard.Departures();
        var foot = new BlockPos(0, 64, 0);
        var floor = foot.east().down(2);
        var grade = gradeFromTop(foot, Direction.EAST, floor, Blocks.GRASS_BLOCK.getDefaultState(), true);

        var tread = exits.descentTread(grade, 61);
        assertNotNull(tread);
        assertEquals(foot, tread.from);
        assertEquals(foot.east().down(), tread.to);
        assertFalse(tread.returning, "use the normal checked descent motor instead of a pillar");
        exits.reject(foot, tread.to);
        assertNull(exits.descentTread(grade, 62), "do not repeat a refused descent");
    }

    @Test
    void onlyADebitedBlockUnderTheExactRaisedFootCanEarnAnotherStep() {
        var shaft = new AgentStallGuard.ShaftClimb();
        var base = new BlockPos(0, 55, 0);
        var raised = base.up();
        var dirt = Blocks.DIRT.getDefaultState();
        assertTrue(shaft.begin(base, null, false));

        assertFalse(shaft.landed(raised, base, Blocks.DIRT, dirt, 8, 8), "an inventory no-op is not a receipt");
        assertFalse(shaft.landed(raised, base.east(), Blocks.DIRT, dirt, 8, 7), "a neighboring top is not contact");
        assertFalse(shaft.landed(raised, base, Blocks.ANDESITE, dirt, 8, 7), "the placed material must match");
        assertFalse(shaft.landed(base, base, Blocks.DIRT, dirt, 8, 7), "a bob did not gain ground");
        assertFalse(shaft.ordinaryFailed(raised, dirt));
        assertFalse(shaft.begin(raised, dirt, false), "a new incident on the same column is not a fresh first step");

        assertTrue(shaft.landed(raised, base, Blocks.DIRT, dirt, 8, 7));
        assertFalse(shaft.begin(raised, dirt, true), "ordinary escape must get a turn first");
        assertFalse(shaft.ordinaryFailed(raised.east(), dirt));
        assertFalse(shaft.ordinaryFailed(raised, Blocks.STONE.getDefaultState()));
        assertTrue(shaft.ordinaryFailed(raised, dirt));
        assertTrue(shaft.begin(raised, dirt, true));
        assertFalse(shaft.ordinaryFailed(raised.up(), dirt), "starting another jump invalidates the previous receipt");
    }

    @Test
    void aShaftRunSpendsAtMostThreeBlocksAndBreakingItsTopCannotResetIt() {
        var shaft = new AgentStallGuard.ShaftClimb();
        var base = new BlockPos(0, 55, 0);
        var andesite = Blocks.ANDESITE.getDefaultState();
        var foot = base;
        for (int i = 0; i < 3; i++) {
            assertTrue(shaft.begin(foot, andesite, i != 0));
            var above = foot.up();
            assertTrue(shaft.landed(above, foot, Blocks.ANDESITE, andesite, 48 - i, 47 - i));
            foot = above;
            assertTrue(shaft.ordinaryFailed(foot, andesite));
        }
        assertFalse(shaft.begin(foot, andesite, true));
        assertFalse(shaft.begin(foot, andesite, false));
        shaft.broken(foot.down());
        assertFalse(shaft.ordinaryFailed(foot, andesite), "replacing the broken support does not restore the receipt");
        assertFalse(shaft.begin(foot, andesite, false));
    }

    @Test
    void temporaryStepsPreferDisposableFullBlocksOverPickOrFurnaceMaterial() {
        int reusable = AgentStallGuard.stepMaterialPriority(Items.COBBLESTONE);
        assertTrue(reusable > 0);
        assertEquals(reusable, AgentStallGuard.stepMaterialPriority(Items.COBBLED_DEEPSLATE));
        for (var fill : new Item[]{Items.ANDESITE, Items.DIORITE, Items.GRANITE, Items.TUFF, Items.DIRT})
            assertTrue(AgentStallGuard.stepMaterialPriority(fill) > reusable);
        for (var unsafe : new Item[]{Items.GRAVEL, Items.SAND, Items.TUFF_SLAB, Items.TORCH,
                Items.FURNACE, Items.WATER_BUCKET})
            assertEquals(0, AgentStallGuard.stepMaterialPriority(unsafe));
    }

    @Test
    void recentVisibleWaterOrLavaByTheJumpKeepsItOutOfDryRecovery() {
        var hazards = new AgentHazards();
        var jump = new Box(0.05, 55, 0.05, 0.95, 58.08, 0.95);
        var water = new BlockPos(1, 55, 0);
        var lava = new BlockPos(0, 57, 1);
        Vec3d eye = new Vec3d(0.5, 56.62, 0.5);
        hazards.observe(new BlockHitResult(Vec3d.ofCenter(water), Direction.WEST, water, false),
            AgentHazards.kind(Blocks.WATER.getDefaultState()), eye, 2, 10);
        assertTrue(hazards.fluidNear(jump, 0.36, 11));
        assertFalse(hazards.lavaNear(jump, 0.36, 11));
        assertFalse(hazards.fluidNear(jump, 0.36, 43), "a stale view is not a current edge");

        hazards.observe(new BlockHitResult(Vec3d.ofCenter(lava), Direction.NORTH, lava, false),
            AgentHazards.kind(Blocks.LAVA.getDefaultState()), eye, 2, 43);
        assertTrue(hazards.fluidNear(jump, 0.36, 44), "the safety query also covers upper lava");
        assertFalse(hazards.fluidNear(jump.offset(3, 0, 0), 0.36, 44));
    }

    private static AgentBody.OrdinaryGrade riseFromTop(BlockPos from, Direction direction, BlockState surface,
                                                       boolean clearance) {
        return gradeFromTop(from, direction, from.offset(direction), surface, clearance);
    }

    private static AgentBody.OrdinaryGrade gradeFromTop(BlockPos from, Direction direction, BlockPos floor,
                                                        BlockState surface, boolean clearance) {
        var source = Blocks.DIRT.getDefaultState();
        var top = new BlockHitResult(Vec3d.ofBottomCenter(floor.up()), Direction.UP, floor, false);
        var edge = AgentSurfaceTread.witnessedGradeEdge(from, source, direction, top, surface, clearance);
        return new AgentBody.OrdinaryGrade(from, direction, floor, source, surface, 55, edge);
    }
}
