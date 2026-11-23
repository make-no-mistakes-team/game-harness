package io.gameharness.survival;

import java.util.List;
import net.minecraft.block.Blocks;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.EmptyBlockView;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentReturnableMine.Face.FLUID;
import static io.gameharness.survival.AgentReturnableMine.Face.FOOTPRINT;
import static io.gameharness.survival.AgentReturnableMine.Face.MATERIAL;
import static io.gameharness.survival.AgentReturnableMine.Face.MINEABLE;
import static io.gameharness.survival.AgentReturnableMine.Face.PROTECTED;
import static io.gameharness.survival.AgentReturnableMine.Face.TOOL;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class AgentSupplyEgressTest {
    private static final BlockPos REFUGE = new BlockPos(-15, 54, -34);
    private static final BlockPos LOWER = REFUGE.south().up();
    private static final BlockPos FIRST_DRY = LOWER.south().up();
    private static final BlockPos LIP = FIRST_DRY.south().up();
    private static final BlockPos APPROACH = LIP.south().up();
    private static final BlockPos OPENING = APPROACH.up();
    private static final BlockPos WATER = OPENING.up();

    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
    }

    @Test
    void eachWitnessedRiseCanHandItsSupportAndBearingToTheNextTurn() {
        var egress = new AgentSupplyEgress();
        var stone = Blocks.STONE.getDefaultState();
        assertTrue(egress.begin(REFUGE, true, 1));
        BlockPos from = REFUGE;
        assertNull(egress.carriedSupport(), "a new order cannot borrow a takeoff receipt");
        for (int tick = 10; tick <= 70; tick += 10) {
            var to = from.south().up();
            assertFalse(egress.landWitnessed(to, stone, tick, true), "contact alone is not a landing proof");
            egress.witnessLanding(to, stone);
            assertFalse(egress.landWitnessed(to, null, tick, true), "an airborne feet cell is not a landing");
            assertFalse(egress.landWitnessed(to.east(), stone, tick, true), "no receipt for the wrong contact");
            assertTrue(egress.landWitnessed(to, stone, tick, true));
            assertEquals(to, egress.foot());
            assertEquals(Direction.SOUTH, egress.ascentBearing(tick + 1));
            egress.observeSupport(stone);
            assertTrue(egress.retainSupport());
            assertEquals(stone, egress.carriedSupport());
            egress.endAscentHandoff();
            assertNull(egress.ascentBearing(tick + 2), "the receipt only starts one immediate continuation");
            assertTrue(egress.retainSupport(), "the same support remains known while proving the next crossing");
            from = to;
        }
        egress.finish();
        assertTrue(egress.begin(from, true, 82));
        assertNull(egress.carriedSupport(), "returning later must establish a new takeoff witness");
    }

    @Test
    void anExpiredImmediateAscentDoesNotRevokeStillGroundedSupport() {
        var egress = new AgentSupplyEgress();
        var stone = Blocks.STONE.getDefaultState();
        var rise = REFUGE.south().up();
        assertTrue(egress.begin(REFUGE, true, 1));
        egress.witnessLanding(rise, stone);
        assertTrue(egress.landWitnessed(rise, stone, 10, true));
        assertEquals(Direction.SOUTH, egress.ascentBearing(11));
        egress.observeSupport(stone);
        assertNull(egress.ascentBearing(50), "an interrupted turn must not resume the immediate continuation");
        assertTrue(egress.retainSupport());
    }

    @Test
    void walksCarryTheSupportButNotAnAscentAndMutationOrLostContactRevokesIt() {
        var egress = new AgentSupplyEgress();
        var stone = Blocks.STONE.getDefaultState();
        var dirt = Blocks.DIRT.getDefaultState();
        var walked = REFUGE.south();
        assertTrue(egress.begin(REFUGE, true, 1));
        egress.witnessLanding(walked, stone);
        assertFalse(egress.landWitnessed(walked, dirt, 8, true), "a replacement cube is not the witnessed top");
        egress.observeBreak(walked.down());
        assertFalse(egress.landWitnessed(walked, stone, 9, true), "a broken witness cannot be used after replacement");
        egress.witnessLanding(walked, stone);
        assertTrue(egress.landWitnessed(walked, stone, 10, true));
        assertEquals(stone, egress.carriedSupport());
        assertNull(egress.ascentBearing(11));
        var rise = walked.south().up();
        egress.witnessLanding(rise, dirt);
        assertTrue(egress.landWitnessed(rise, dirt, 20, false));
        assertNull(egress.ascentBearing(21), "a return or a different intent does not inherit the ascent");
        egress.observeSupport(null);
        egress.observeSupport(dirt);
        assertFalse(egress.retainSupport(), "stepping back after a slip cannot revive the old receipt");
        assertNull(egress.carriedSupport());

        var later = rise.south().up();
        egress.witnessLanding(later, stone);
        assertTrue(egress.landWitnessed(later, stone, 30, true));
        egress.observeBreak(later.down());
        egress.observeSupport(stone);
        assertFalse(egress.retainSupport(), "even the same state does not restore a broken receipt");
        assertNull(egress.ascentBearing(31));
    }

    @Test
    void crossingLightChoosesAVisibleFrontOrSideMountBeforeTurningBack() {
        BlockPos from = BlockPos.ORIGIN, to = from.west().up();
        Vec3d eye = new Vec3d(0.39, 1.62, 0.50), dark = new Vec3d(-0.5, 2.6, 0.5);
        var rear = new BlockHitResult(new Vec3d(1.4, 0, 0.5), Direction.UP, from.east().down(), false);
        var side = new BlockHitResult(new Vec3d(0.10, 1.55, 0), Direction.SOUTH, from.north().up(), false);
        var front = new BlockHitResult(new Vec3d(-1, 1.6, 0.20), Direction.EAST, to.west(), false);
        var safeFront = new BlockHitResult(new Vec3d(-1.40, 2, 1.20), Direction.UP, to.west().south(), false);
        var exposed = new BlockHitResult[]{rear, front, side, safeFront};
        var pick = AgentSupplyEgress.closestLightFace(null, exposed, exposed.length,
            hit -> AgentSupplyEgress.lightFaceScore(hit, eye, 90, from, to, Direction.WEST, dark));
        assertEquals(safeFront, pick, "the smaller turn wins, but the face that would place in the landing does not");

        var shaft = new BlockHitResult[]{rear, front, side};
        assertEquals(side, AgentSupplyEgress.closestLightFace(null, shaft, shaft.length,
            hit -> AgentSupplyEgress.lightFaceScore(hit, eye, 450, from, to, Direction.WEST, dark)),
            "a flush wall torch does not need the default about-face in a one-wide shaft");
        assertTrue(Blocks.WALL_TORCH.getDefaultState().getCollisionShape(EmptyBlockView.INSTANCE, from.up()).isEmpty());
    }

    @Test
    void crossingLightRejectsTheFootingAndOnlyKeepsAUsefulRearFallback() {
        BlockPos from = BlockPos.ORIGIN, to = from.west().up();
        Vec3d eye = new Vec3d(0.39, 1.62, 0.50), dark = new Vec3d(-0.5, 1.02, 0.5);
        var takeoff = new BlockHitResult(new Vec3d(0.1, 0, 0.5), Direction.UP, from.down(), false);
        var crown = new BlockHitResult(new Vec3d(0.10, 2.55, 0), Direction.SOUTH, from.north().up(2), false);
        var rear = new BlockHitResult(new Vec3d(1.3, 0, 0.5), Direction.UP, from.east().down(), false);
        var rearOnly = new BlockHitResult[]{takeoff, crown, rear};
        assertEquals(rear, AgentSupplyEgress.closestLightFace(null, rearOnly, rearOnly.length,
            hit -> AgentSupplyEgress.lightFaceScore(hit, eye, 90, from, to, Direction.WEST, dark)));
        assertNull(AgentSupplyEgress.closestLightFace(null, rearOnly, rearOnly.length,
            hit -> AgentSupplyEgress.lightFaceScore(hit, eye, 90, from, to, Direction.WEST, dark.add(-4, 0, 0))),
            "reach to the player is not proof that the torch is near the intended crossing");
    }

    @Test
    void payableOreCanBeClearedFromTheSideFaceAndCrownOfAnAscendingStair() {
        var stonePick = new ItemStack(Items.STONE_PICKAXE);
        assertEquals(MINEABLE, AgentProgress.supplyEgressCutAdmission(
            APPROACH, APPROACH.down(), Blocks.COPPER_ORE.getDefaultState(), false, false,
            stonePick::isSuitableFor));
        assertEquals(MINEABLE, AgentProgress.supplyEgressCutAdmission(
            LIP.up(2), APPROACH.down(), Blocks.DEEPSLATE_COPPER_ORE.getDefaultState(), false, false,
            stonePick::isSuitableFor));

        var woodenPick = new ItemStack(Items.WOODEN_PICKAXE);
        assertEquals(TOOL, AgentProgress.supplyEgressCutAdmission(
            APPROACH, APPROACH.down(), Blocks.COPPER_ORE.getDefaultState(), false, false,
            woodenPick::isSuitableFor));
    }

    @Test
    void ordinaryOreClearanceDoesNotRemoveTheTakeoffLandingOrProtectedTread() {
        var copper = Blocks.COPPER_ORE.getDefaultState();
        var stonePick = new ItemStack(Items.STONE_PICKAXE);
        assertEquals(FOOTPRINT, AgentProgress.supplyEgressCutAdmission(
            LIP.down(), APPROACH.down(), copper, true, false, stonePick::isSuitableFor));
        assertEquals(PROTECTED, AgentProgress.supplyEgressCutAdmission(
            APPROACH.down(), APPROACH.down(), copper, false, false, stonePick::isSuitableFor));
        assertEquals(PROTECTED, AgentProgress.supplyEgressCutAdmission(
            FIRST_DRY.down(), APPROACH.down(), copper, false, true, stonePick::isSuitableFor));
    }

    @Test
    void gainInHeadroomDoesNotPermitFluidFallingMaterialOrWorkshopCuts() {
        var stonePick = new ItemStack(Items.STONE_PICKAXE);
        assertEquals(FLUID, AgentProgress.supplyEgressCutAdmission(
            APPROACH, APPROACH.down(), Blocks.WATER.getDefaultState(), false, false, stonePick::isSuitableFor));
        for (var block : List.of(Blocks.GRAVEL, Blocks.MAGMA_BLOCK, Blocks.FURNACE)) {
            assertEquals(MATERIAL, AgentProgress.supplyEgressCutAdmission(
                APPROACH, APPROACH.down(), block.getDefaultState(), false, false, stonePick::isSuitableFor));
        }
    }

    @Test
    void aNewOrderAtAWalkedTreadKeepsTheOlderTurnedExit() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(REFUGE, true, 5592));
        egress.landed(LOWER);
        egress.landed(FIRST_DRY);
        egress.finish();
        assertTrue(egress.begin(REFUGE.east(20), true, 5930));
        egress.landed(REFUGE.east(21));
        egress.finish();
        assertTrue(egress.begin(FIRST_DRY, true, 6000));
        BlockPos newLip = FIRST_DRY.west().up();
        egress.landed(newLip);
        var retreat = egress.flood(newLip.west().up(), newLip.west().up(2), newLip.west().up(3), false, 6100);

        assertNotNull(retreat);
        assertEquals(List.of(REFUGE, LOWER, FIRST_DRY, newLip), retreat.walked());
        assertFalse(egress.active());
    }

    @Test
    void aDryLandingAtTheFirstTreadContinuesTowardTheOlderRefuge() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(REFUGE, true, 5592));
        egress.landed(LOWER);
        egress.landed(FIRST_DRY);
        egress.landed(LIP);
        // An earlier crossing toward this pocket may still be in memory.
        egress.landed(APPROACH);
        for (int i = 1; i <= 4; i++) egress.landed(APPROACH.south(i));
        egress.finish();
        assertTrue(egress.begin(LIP, true, 6099));
        var retreat = egress.flood(APPROACH, OPENING, WATER, true, 6100);
        assertNotNull(retreat);
        assertEquals(List.of(REFUGE, LOWER, FIRST_DRY, LIP), retreat.walked());

        var lower = retreat.afterDryLanding(FIRST_DRY);
        assertNotNull(lower);
        assertFalse(lower.outsideFlood(FIRST_DRY));
        assertEquals(List.of(REFUGE, LOWER, FIRST_DRY), lower.walked());
        assertNull(lower.afterDryLanding(FIRST_DRY), "a dry result must advance, not retry the same leg");
        var refuge = lower.afterDryLanding(LOWER);
        assertNotNull(refuge);
        assertEquals(List.of(REFUGE, LOWER), refuge.walked());
        assertTrue(refuge.outsideFlood(REFUGE));
        assertNull(refuge.afterDryLanding(REFUGE));

        assertFalse(egress.begin(FIRST_DRY, true, 6165), "foot contact is not a safe worksite");
        assertFalse(egress.begin(LOWER, true, 6165), "don't dig another shaft beside the same intrusion");
        assertTrue(egress.begin(REFUGE, true, 6200));
        assertTrue(egress.blocksFloodWork(LOWER, 6200), "a known wetward lane is not a fresh continuation");
        assertFalse(egress.blocksFloodWork(REFUGE.east().up(), 6200), "allow the sheltered alternative away from the lip");
    }

    @Test
    void aNewAdjacentStanceDoesNotInventAWalkedEdge() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(REFUGE, true, 1));
        egress.landed(LOWER);
        egress.landed(FIRST_DRY);
        egress.finish();

        BlockPos other = FIRST_DRY.east();
        assertTrue(egress.begin(other, true, 4));
        egress.landed(other.south().up());
        var retreat = egress.flood(null, null, null, false, 6);
        assertNotNull(retreat);
        assertEquals(List.of(other, other.south().up()), retreat.walked());
        assertFalse(retreat.outsideFlood(other), "a last remembered tread is not necessarily a refuge");
        assertNull(retreat.afterDryLanding(other), "don't drive toward unwalked neighbors");
    }

    @Test
    void floodQuarantineNeedsSpecificFreshDryEvidenceOrExpires() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(LIP, true, 6080));
        assertNull(egress.flood(APPROACH, OPENING, WATER, true, 6100), "unwalked adjacent tiles are not retreat legs");
        egress.observeBreak(OPENING);
        egress.recheckFloods(FIRST_DRY, 6165, WATER::equals);
        assertFalse(egress.begin(FIRST_DRY, true, 6165), "dry source alone does not prove the breach opening");
        egress.recheckFloods(FIRST_DRY, 6190, cell -> cell.equals(WATER) || cell.equals(OPENING));
        assertTrue(egress.begin(FIRST_DRY, true, 6190));
        assertNull(egress.flood(APPROACH, OPENING, WATER, false, 6200));
        egress.recheckFloods(FIRST_DRY, 6210, cell -> true);
        assertFalse(egress.begin(FIRST_DRY, true, 6210), "a vanished flow front may still have a live source");
        assertTrue(egress.begin(FIRST_DRY, true, 10000));
    }

    @Test
    void aNearbyExhaustedOrderCanRetryWhenTheFloodPremiseChanges() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(LIP, true, 6080));
        egress.flood(APPROACH, OPENING, WATER, true, 6100);
        assertTrue(egress.begin(REFUGE, true, 6180));
        assertTrue(egress.avoidFlood(LOWER, 6180));
        egress.refuse("no other exit", false);
        assertFalse(egress.begin(REFUGE, true, 6190));
        egress.recheckFloods(REFUGE, 6200, cell -> cell.equals(WATER) || cell.equals(OPENING));
        assertTrue(egress.begin(REFUGE, true, 6210), "temporary flood veto must not become a permanent exact refusal");
    }

    @Test
    void theReturnContainsOnlyBoundedActuallyWalkedLegsAndDropsBrokenSupports() {
        var egress = new AgentSupplyEgress();
        assertTrue(egress.begin(REFUGE, true, 1));
        for (int i = 1; i <= 120; i++) egress.landed(REFUGE.east(i));
        var retreat = egress.flood(null, null, null, false, 300);
        assertNotNull(retreat);
        assertEquals(List.of(REFUGE.east(112), REFUGE.east(113), REFUGE.east(114), REFUGE.east(115),
            REFUGE.east(116), REFUGE.east(117), REFUGE.east(118), REFUGE.east(119), REFUGE.east(120)), retreat.walked());
        assertTrue(egress.begin(REFUGE, true, 301));
        assertNull(egress.flood(null, null, null, false, 302), "unrelated old legs are evicted, not kept forever");

        egress.reset();
        assertTrue(egress.begin(REFUGE, true, 303));
        egress.landed(LOWER);
        egress.landed(FIRST_DRY);
        egress.observeBreak(LOWER.down());
        assertNull(egress.flood(APPROACH, OPENING, WATER, false, 304), "don't offer a leg through a known broken support");
    }

    @Test
    void anOutlineAndAnAttemptDoNotCreateAWalkedLandingOrPermitHandoff() {
        var passage = new AgentSupplyEgress.OutlinePassage();
        passage.begin(REFUGE, 10);
        assertFalse(passage.landed(LOWER, true), "no admitted crossing");
        passage.attemptedCut(LOWER.up());
        assertFalse(passage.canHandoff());
        assertTrue(passage.admitLanding(REFUGE, LOWER));
        assertFalse(passage.landed(FIRST_DRY, true), "not the selected tread");
        assertFalse(passage.landed(LOWER, false), "not settled on actual dry support");
        assertEquals(0, passage.steps());
        assertFalse(passage.canHandoff());
        passage.abandonLanding();
        assertFalse(passage.landed(LOWER, true), "a vetoed leg cannot be booked on a late arrival");

        assertTrue(passage.admitLanding(REFUGE, LOWER));
        assertTrue(passage.landed(LOWER, true));
        assertEquals(1, passage.steps());
        assertTrue(passage.canHandoff(), "physical arrival permits checking the ordinary handoff, not declaring one");
        assertFalse(passage.landed(LOWER, true), "one landing cannot count twice");
    }

    @Test
    void aShortOutlinePassageNeverDropsRevisitsOrRenewsItsLimits() {
        var passage = new AgentSupplyEgress.OutlinePassage();
        passage.begin(REFUGE, 10);
        assertFalse(passage.admitLanding(REFUGE, REFUGE.south().down()));
        assertFalse(passage.admitLanding(REFUGE, REFUGE.south().east()));
        BlockPos current = REFUGE;
        for (int i = 0; i < 6; i++) {
            BlockPos next = current.south();
            assertTrue(passage.admitLanding(current, next));
            assertTrue(passage.landed(next, true));
            assertFalse(passage.admitLanding(next, current), "a revisited stance cannot buy another dark step");
            current = next;
        }
        assertFalse(passage.admitLanding(current, current.south().up()));

        for (int i = 0; i < 15; i++) {
            BlockPos cut = REFUGE.east(i).up(2);
            assertTrue(passage.allowsCut(cut));
            passage.attemptedCut(cut);
            assertFalse(passage.allowsCut(cut), "a refused cut cannot be chosen again on a different bearing");
        }
        assertFalse(passage.allowsCut(REFUGE.up(3)));
        passage.begin(current, 800);
        assertTrue(passage.withinTime(909));
        assertFalse(passage.withinTime(910));
    }

    @Test
    void aPreferredSideFootNeedsARealSameGradeArrivalAndDoesNotSurviveABrokenSupport() {
        var order = new AgentSupplyEgress();
        assertTrue(order.begin(REFUGE, true, 100));
        order.landed(LOWER);
        assertNull(order.previousLevelFoot(LOWER));
        BlockPos side = LOWER.west();
        order.landed(side);
        order.landed(LOWER);
        assertEquals(side, order.previousLevelFoot(LOWER));
        order.observeBreak(side.down());
        assertNull(order.previousLevelFoot(LOWER));
    }

    @Test
    void offColumnClearanceRequiresAnActualRoundTripAndDoesNotEarnAnotherLanding() {
        var passage = new AgentSupplyEgress.OutlinePassage();
        var stone = Blocks.STONE.getDefaultState();
        var dirt = Blocks.DIRT.getDefaultState();
        var apex = apexFace(LOWER, Direction.DOWN);
        BlockPos side = LOWER.west(), rise = LOWER.south().up();
        passage.begin(REFUGE, 10);
        assertTrue(passage.admitLanding(REFUGE, LOWER));
        assertTrue(passage.landed(LOWER, true));

        var access = passage.beginApexAccess(LOWER, rise, apex, stone, dirt, stone);
        assertNotNull(access);
        assertFalse(passage.canHandoff());
        assertFalse(passage.admitLanding(LOWER, rise));
        assertFalse(access.matchesCut(apex, stone), "cannot cut from underneath");
        assertFalse(access.admitOut(side.down(), stone), "no drop to get clear of the column");
        assertFalse(access.admitOut(rise.down(), stone), "the solid rise lip is not a side tread");
        assertTrue(access.admitOut(side, stone), "a newly verified side tread needs no prior trip");
        assertFalse(access.landed(side, false));
        assertFalse(access.landed(LOWER.east(), true));
        assertTrue(access.landed(side, true));
        assertFalse(access.matchesCut(apex, dirt), "replacement material is not the same contact");
        assertFalse(access.matchesCut(apexFace(LOWER, Direction.NORTH), stone), "exact exposed face changed");
        assertTrue(access.matchesCut(apex, stone));
        assertFalse(access.broken(apex.getBlockPos(), stone), "a break without an accepted cut is not a receipt");
        access.requestedCut();
        assertFalse(access.broken(apex.getBlockPos(), dirt));
        assertTrue(access.broken(apex.getBlockPos(), stone));
        assertFalse(access.broken(apex.getBlockPos(), stone), "the exact cut is spent once");
        assertFalse(passage.finishApexAccess(side));
        assertTrue(access.admitBack());
        assertFalse(access.landed(LOWER, false));
        assertTrue(access.landed(LOWER, true));
        assertTrue(passage.finishApexAccess(LOWER));
        assertEquals(1, passage.steps(), "neither repositioning leg earns fresh coverage");
        assertTrue(passage.admitLanding(LOWER, rise), "the original rise can be reverified and actually crossed");
    }

    @Test
    void failedOrFinishedApexAccessCannotBeRenewedOnAnotherBearing() {
        var passage = new AgentSupplyEgress.OutlinePassage();
        var stone = Blocks.STONE.getDefaultState();
        passage.begin(REFUGE, 10);
        assertNull(passage.beginApexAccess(REFUGE, REFUGE.south(), apexFace(REFUGE, Direction.DOWN),
            stone, stone, stone), "an eligible uphill tread is required");
        assertNotNull(passage.beginApexAccess(REFUGE, LOWER, apexFace(REFUGE, Direction.DOWN), stone, stone, stone));
        assertTrue(passage.finishApexAccess(REFUGE));
        assertNull(passage.beginApexAccess(REFUGE, REFUGE.east().up(), apexFace(REFUGE, Direction.DOWN),
            stone, stone, stone));
        assertTrue(passage.admitLanding(REFUGE, LOWER));
        assertTrue(passage.landed(LOWER, true));
        assertNotNull(passage.beginApexAccess(LOWER, FIRST_DRY, apexFace(LOWER, Direction.DOWN), stone, stone, stone));
        assertTrue(passage.finishApexAccess(LOWER));
        assertTrue(passage.admitLanding(LOWER, FIRST_DRY));
        assertTrue(passage.landed(FIRST_DRY, true));
        assertNull(passage.beginApexAccess(FIRST_DRY, LIP, apexFace(FIRST_DRY, Direction.DOWN), stone, stone, stone));
    }

    @Test
    void handClearanceIsFiniteAndCannotBeSpentTwiceOnTheSameCell() {
        var passage = new AgentSupplyEgress.OutlinePassage();
        passage.begin(REFUGE, 10);
        assertTrue(passage.attemptHandClearance(LOWER));
        assertFalse(passage.attemptHandClearance(LOWER));
        assertTrue(passage.attemptHandClearance(OPENING));
        assertFalse(passage.attemptHandClearance(WATER));
    }

    private static BlockHitResult apexFace(BlockPos foot, Direction side) {
        BlockPos apex = foot.up(3);
        return new BlockHitResult(Vec3d.ofCenter(apex), side, apex, false);
    }
}
