package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.block.Blocks;
import net.minecraft.block.LeavesBlock;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.state.property.Properties;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class CanopyPassageTest {
    private static final BlockPos FOOT = new BlockPos(-25, 69, 4);

    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

    @Test
    void pickingUpTheFirstLogDoesNotDisableTheBareHandBootstrap() {
        assertTrue(AgentProgress.crownWorkHand(ItemStack.EMPTY));
        assertTrue(AgentProgress.crownWorkHand(new ItemStack(Items.DARK_OAK_LOG)));
        assertTrue(AgentProgress.crownWorkHand(new ItemStack(Items.OAK_PLANKS)));
        assertFalse(AgentProgress.crownWorkHand(new ItemStack(Items.WOODEN_PICKAXE)),
            "this local leaf opening must not spend tool durability");
        assertFalse(AgentProgress.crownWorkHand(new ItemStack(Items.BREAD)));
    }

    @Test
    void crownRiseStartsOnlyOnTheOrdinaryMotorAndSettlesOnActualUpperContact() {
        var leaves = Blocks.OAK_LEAVES.getDefaultState();
        BlockPos to = FOOT.north().up();
        var tread = new AgentSurfaceTread.CrownCrossing(FOOT, to, Direction.NORTH, leaves, leaves, 1, 1);
        Vec3d feet = Vec3d.ofBottomCenter(FOOT);

        assertEquals(AgentSurfaceTread.Result.CHECKING,
            tread.accept(AgentBody.OrdinaryMotor.CENTER, feet));
        assertFalse(tread.inFlight(), "inward centering cannot own a rise");
        assertEquals(AgentSurfaceTread.Result.CHECKING,
            tread.accept(AgentBody.OrdinaryMotor.ALIGN, feet));
        assertEquals(AgentSurfaceTread.Result.MOVING, tread.accept(AgentBody.OrdinaryMotor.KEY, feet));
        assertTrue(tread.inFlight());
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(2, 2, feet.add(0, 0.42, -0.09), false, false, false, 0.01));
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(3, 3, feet.add(0, 0.75, -0.21), false, false, false, 0.01));
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(4, 4, feet.add(0, 0.99, -0.34), false, false, false, 0.01));
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(5, 5, feet.add(0, 1.16, -0.48), false, false, false, 0.01));
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(6, 6, feet.add(0, 1.25, -0.62), false, false, false, 0.01));
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(7, 7, feet.add(0, 1.25, -0.76), false, false, false, 0.006));
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(8, 8, feet.add(0, 1.17, -0.84), false, false, false, 0.003));
        assertEquals(AgentSurfaceTread.Result.LANDED,
            tread.observe(9, 9, feet.add(0, 1, -0.91), true, false, true, 0.002));
    }

    @Test
    void aCrownHopBackOntoItsTakeoffRetiresInsteadOfJumpingInPlaceAgain() {
        var leaves = Blocks.OAK_LEAVES.getDefaultState();
        var tread = new AgentSurfaceTread.CrownCrossing(FOOT, FOOT.east().up(), Direction.EAST, leaves, leaves, 1, 1);
        Vec3d feet = Vec3d.ofBottomCenter(FOOT);

        tread.accept(AgentBody.OrdinaryMotor.KEY, feet);
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(2, 2, feet.add(0.04, 0.42, 0), false, false, false, 0));
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(3, 3, feet.add(0.04, 0.14, 0), false, false, false, 0));
        assertEquals(AgentSurfaceTread.Result.REFUSED,
            tread.observe(4, 4, feet.add(0.04, 0, 0), true, true, false, 0),
            "the next tick cannot issue another takeoff on the same failed tread");
    }

    @Test
    void aLevelCrownTreadNeedsTheExactSettledLandingRatherThanJustEnteringItsCell() {
        var leaves = Blocks.OAK_LEAVES.getDefaultState();
        var tread = new AgentSurfaceTread.CrownCrossing(FOOT, FOOT.south(), Direction.SOUTH, leaves, leaves, 1, 1);
        Vec3d feet = Vec3d.ofBottomCenter(FOOT);
        tread.accept(AgentBody.OrdinaryMotor.KEY, feet);
        for (int tick = 2; tick <= 5; tick++) {
            assertEquals(AgentSurfaceTread.Result.MOVING,
                tread.observe(tick, tick, feet.add(0, 0, (tick - 1) * 0.18), true, tick <= 3, false, 0.01));
        }
        Vec3d nearCenter = feet.add(0, 0, 0.90);
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(6, 6, nearCenter, true, false, false, 0.002), "not on the expected vanilla support");
        assertEquals(AgentSurfaceTread.Result.MOVING,
            tread.observe(7, 7, nearCenter, true, false, true, 0.008), "still has walking momentum");
        assertEquals(AgentSurfaceTread.Result.LANDED,
            tread.observe(8, 8, nearCenter, true, false, true, 0.002));
    }

    @Test
    void aSpentBareHandedTimberFrontierDefersToWoodAndStillNeedsACheckedOpening() {
        var leaves = Blocks.OAK_LEAVES.getDefaultState();
        BlockPos lower = FOOT.east().down(2);
        assertTrue(AgentSupplyEgress.firstLogCanopyHandoff(AgentOrdinaryNavigator.Job.TIMBER, true, false,
            () -> AgentFoodWork.canopyEdge(FOOT, leaves, Direction.EAST, lower,
                Blocks.GRASS_BLOCK.getDefaultState()) != null));
        assertFalse(AgentSupplyEgress.firstLogCanopyHandoff(AgentOrdinaryNavigator.Job.TIMBER, true, true,
            () -> { throw new AssertionError("reachable wood must win without inspecting the canopy"); }));
        assertFalse(AgentSupplyEgress.firstLogCanopyHandoff(null, true, false,
            () -> { throw new AssertionError("an unspent frontier has not earned a canopy action"); }));
        assertFalse(AgentSupplyEgress.firstLogCanopyHandoff(AgentOrdinaryNavigator.Job.FOOD, true, false,
            () -> { throw new AssertionError("FOOD has its own frontier owner"); }));
        assertFalse(AgentSupplyEgress.firstLogCanopyHandoff(AgentOrdinaryNavigator.Job.TIMBER, false, false,
            () -> { throw new AssertionError("an equipped hand is not first-log canopy work"); }));
        assertFalse(AgentSupplyEgress.firstLogCanopyHandoff(AgentOrdinaryNavigator.Job.TIMBER, true, false,
            () -> AgentFoodWork.canopyEdge(FOOT, leaves, Direction.EAST, lower, null) != null),
            "an unseen lower top is not a descent");
    }

    @Test
    void onlyTheNaturalLeafUndersideInTheJumpColumnCanOpenTheStep() {
        var leaf = Blocks.OAK_LEAVES.getDefaultState();
        BlockPos cap = FOOT.up(2);
        var hit = new BlockHitResult(Vec3d.ofBottomCenter(cap), Direction.DOWN, cap, false);
        assertTrue(AgentHeadroom.stepLeaf(FOOT, hit, leaf));
        BlockPos upper = FOOT.up(3);
        assertTrue(AgentHeadroom.stepLeaf(FOOT,
            new BlockHitResult(Vec3d.ofBottomCenter(upper), Direction.DOWN, upper, false), leaf));
        BlockPos beyondJump = FOOT.up(4);
        assertFalse(AgentHeadroom.stepLeaf(FOOT,
            new BlockHitResult(Vec3d.ofBottomCenter(beyondJump), Direction.DOWN, beyondJump, false), leaf));
        assertFalse(AgentHeadroom.stepLeaf(FOOT.east(), hit, leaf));
        assertFalse(AgentHeadroom.stepLeaf(FOOT, top(cap), leaf));
        assertFalse(AgentHeadroom.stepLeaf(FOOT, hit, leaf.with(Properties.WATERLOGGED, true)));
        assertFalse(AgentHeadroom.stepLeaf(FOOT, hit, leaf.with(LeavesBlock.PERSISTENT, true)));
        assertFalse(AgentHeadroom.stepLeaf(FOOT, hit, Blocks.STONE.getDefaultState()));
    }

    @Test
    void aWitnessedSideLeafNeedsNoLogButCannotBeAProtectedOrPersistentSupport() {
        var leaf = Blocks.OAK_LEAVES.getDefaultState();
        assertTrue(AgentSupplyEgress.canopyContact(leaf, true, false));
        assertFalse(AgentSupplyEgress.canopyContact(leaf, false, false));
        assertFalse(AgentSupplyEgress.canopyContact(leaf, true, true));
        assertFalse(AgentSupplyEgress.canopyContact(Blocks.STONE.getDefaultState(), true, false));
        assertTrue(AgentSupplyEgress.canopyLeaf(FOOT, Direction.EAST, face(FOOT.east().up()), leaf, false));
        assertTrue(AgentSupplyEgress.canopyLeaf(FOOT, Direction.EAST, face(FOOT.east()), leaf, false));
        assertFalse(AgentSupplyEgress.canopyLeaf(FOOT, Direction.EAST, face(FOOT.east().down()), leaf, false));
        assertFalse(AgentSupplyEgress.canopyLeaf(FOOT, Direction.EAST, face(FOOT.east().east()), leaf, false));
        assertFalse(AgentSupplyEgress.canopyLeaf(FOOT, Direction.EAST, face(FOOT.east()), leaf, true));
        assertFalse(AgentSupplyEgress.canopyLeaf(FOOT, Direction.EAST, face(FOOT.east()), leaf.with(LeavesBlock.PERSISTENT, true), false));
        assertFalse(AgentSupplyEgress.canopyLeaf(FOOT, Direction.EAST, face(FOOT.east()), leaf.with(Properties.WATERLOGGED, true), false));
    }

    @Test
    void firstStoneNeedsActualNaturalLeafContactRatherThanBeingInAForest() {
        var oak = Blocks.OAK_LEAVES.getDefaultState();
        assertTrue(AgentProgress.firstStoneCanopyContact(FOOT, oak, null, 100));
        assertFalse(AgentProgress.firstStoneCanopyContact(FOOT, null, null, 100));
        assertFalse(AgentProgress.firstStoneCanopyContact(FOOT, Blocks.GRASS_BLOCK.getDefaultState(), null, 100));
        assertFalse(AgentProgress.firstStoneCanopyContact(FOOT, Blocks.STONE.getDefaultState(), null, 100));
        assertFalse(AgentProgress.firstStoneCanopyContact(FOOT, oak.with(LeavesBlock.PERSISTENT, true), null, 100));
        assertFalse(AgentProgress.firstStoneCanopyContact(FOOT, oak.with(Properties.WATERLOGGED, true), null, 100));
    }

    @Test
    void equippedFirstStoneCanLeaveASpentForestOnlyAfterOrdinaryWorkDeclines() {
        var crown = Blocks.BIRCH_LEAVES.getDefaultState();
        var soil = Blocks.GRASS_BLOCK.getDefaultState();
        assertTrue(AgentProgress.firstStoneCanopyHandoff(AgentOrdinaryNavigator.Job.STONE, true, false,
            () -> AgentProgress.firstStoneCanopyContact(FOOT, crown, null, 100)
                && AgentProgress.stoneCanopyGround(soil)));
        assertFalse(AgentProgress.firstStoneCanopyHandoff(AgentOrdinaryNavigator.Job.STONE, true, true,
            () -> { throw new AssertionError("a collectible exposed stone face gets the turn"); }));
        assertFalse(AgentProgress.firstStoneCanopyHandoff(null, true, false,
            () -> { throw new AssertionError("the ordinary survey must actually spend its frontier"); }));
        assertFalse(AgentProgress.firstStoneCanopyHandoff(AgentOrdinaryNavigator.Job.TIMBER, true, false,
            () -> { throw new AssertionError("stone is not another timber search"); }));
        assertFalse(AgentProgress.firstStoneCanopyHandoff(AgentOrdinaryNavigator.Job.STONE, false, false,
            () -> { throw new AssertionError("the starter pick and missing stone are required"); }));
        assertFalse(AgentProgress.firstStoneCanopyHandoff(AgentOrdinaryNavigator.Job.STONE, true, false,
            () -> AgentProgress.firstStoneCanopyContact(FOOT, soil, null, 100)),
            "on real soil the local stone probe gets the turn instead");
    }

    @Test
    void onlyNaturalStableGroundCanEndTheStoneCrownRoute() {
        assertTrue(AgentProgress.stoneCanopyGround(Blocks.ROOTED_DIRT.getDefaultState()));
        assertTrue(AgentProgress.stoneCanopyGround(Blocks.STONE.getDefaultState()));
        assertFalse(AgentProgress.stoneCanopyGround(null), "no rendered support");
        assertFalse(AgentProgress.stoneCanopyGround(Blocks.OAK_LOG.getDefaultState()), "a hollow tree is not ground");
        assertFalse(AgentProgress.stoneCanopyGround(Blocks.OAK_LEAVES.getDefaultState()), "a crown shelf is not ground");
        assertFalse(AgentProgress.stoneCanopyGround(Blocks.SAND.getDefaultState()), "no falling cap");
        assertFalse(AgentProgress.stoneCanopyGround(Blocks.GRAVEL.getDefaultState()), "no falling cap");
        assertFalse(AgentProgress.stoneCanopyGround(Blocks.CRAFTING_TABLE.getDefaultState()), "no workstation roof");
        assertFalse(AgentProgress.stoneCanopyGround(Blocks.WATER.getDefaultState()));
    }

    @Test
    void stoneCrownOpensOnlyTheSafeShoulderOrAKnownLowerGroundSightline() {
        var leaf = Blocks.BIRCH_LEAVES.getDefaultState();
        var air = Blocks.AIR.getDefaultState();
        var shoulder = face(FOOT.east());
        var lip = top(FOOT.east().down());
        var body = new Box(FOOT.getX() + 0.2, FOOT.getY(), FOOT.getZ() + 0.2,
            FOOT.getX() + 0.8, FOOT.getY() + 1.8, FOOT.getZ() + 0.8);
        assertTrue(AgentProgress.stoneCanopyMask(FOOT, Direction.EAST, shoulder, leaf, body, air, false, false));
        assertFalse(AgentProgress.stoneCanopyMask(FOOT, Direction.EAST, shoulder, leaf, body, air, true, false),
            "keep a walked or attached support intact");
        assertFalse(AgentProgress.stoneCanopyMask(FOOT, Direction.EAST, shoulder, leaf, body,
            Blocks.GRAVEL.getDefaultState(), false, false), "a leaf cannot release a falling cap");
        assertFalse(AgentProgress.stoneCanopyMask(FOOT, Direction.EAST, shoulder, leaf, body.offset(0.24, 0, 0), air, false, false),
            "the body cannot be on or against the cut");
        assertFalse(AgentProgress.stoneCanopyMask(FOOT, Direction.EAST, face(FOOT.up(2)), leaf, body, air, false, false),
            "the roof above our footing is not a shoulder");
        assertFalse(AgentProgress.stoneCanopyMask(FOOT, Direction.EAST, shoulder, Blocks.BIRCH_LOG.getDefaultState(),
            body, air, false, false), "do not hollow out a trunk");
        assertFalse(AgentProgress.stoneCanopyMask(FOOT, Direction.EAST, lip, leaf, body, air, false, false),
            "do not cut the lip into an unseen hole");
        assertTrue(AgentProgress.stoneCanopyMask(FOOT, Direction.EAST, lip, leaf, body, air, false, true));
    }

    @Test
    void aConfirmedCanopyStepOnlyCarriesItsExactRecentSupportIntoFirstStone() {
        var oak = Blocks.OAK_LEAVES.getDefaultState();
        var andesite = Blocks.ANDESITE.getDefaultState();
        var grass = Blocks.GRASS_BLOCK.getDefaultState();
        BlockPos raised = FOOT.up();
        assertNull(AgentProgress.CanopyStep.confirmed(raised, null, andesite, 100), "no actor placement receipt");
        assertNull(AgentProgress.CanopyStep.confirmed(raised, grass, andesite, 100), "a general surface step is not canopy");
        assertNull(AgentProgress.CanopyStep.confirmed(raised, oak, null, 100), "no supporting contact");

        var step = AgentProgress.CanopyStep.confirmed(raised, oak, andesite, 100);
        assertNotNull(step);
        assertTrue(AgentProgress.firstStoneCanopyContact(raised, andesite, step, 101));
        assertFalse(AgentProgress.firstStoneCanopyContact(FOOT, andesite, step, 101));
        assertFalse(AgentProgress.firstStoneCanopyContact(raised.east(), andesite, step, 101));
        assertFalse(AgentProgress.firstStoneCanopyContact(raised, grass, step, 101));
        assertFalse(AgentProgress.firstStoneCanopyContact(raised, andesite, step, 341));
    }

    @Test
    void anAdjacentCanopyTopOpensOnlyOutsideTheFootprintTrailAndAttachments() {
        var leaves = Blocks.OAK_LEAVES.getDefaultState();
        BlockPos crown = FOOT.east().down();
        assertTrue(AgentSupplyEgress.canopyTopLeaf(FOOT, Direction.EAST, top(crown), leaves, false));
        assertFalse(AgentSupplyEgress.canopyTopLeaf(FOOT, Direction.EAST, face(crown), leaves, false));
        assertFalse(AgentSupplyEgress.canopyTopLeaf(FOOT, Direction.EAST, top(FOOT.down()), leaves, false));
        assertFalse(AgentSupplyEgress.canopyTopLeaf(FOOT, Direction.EAST, top(crown.east()), leaves, false));
        assertFalse(AgentSupplyEgress.canopyTopLeaf(FOOT, Direction.EAST, top(crown), leaves, true));
        assertFalse(AgentSupplyEgress.canopyTopLeaf(FOOT, Direction.EAST, top(crown), leaves.with(LeavesBlock.PERSISTENT, true), false));
        assertFalse(AgentSupplyEgress.canopyTopLeaf(FOOT, Direction.EAST, top(crown), leaves.with(Properties.WATERLOGGED, true), false));
    }

    @Test
    void aRealLowerTopWinsAndOnlyTheSelectedOwnBreakOpensItsBranch() {
        var passage = new AgentSupplyEgress.CanopyPassage();
        var east = face(FOOT.east().up());
        var west = face(FOOT.west().up());
        passage.offer(FOOT, Direction.EAST, east, false);
        passage.offer(FOOT, Direction.WEST, west, true);
        var selected = passage.begin(FOOT);
        assertEquals(west, selected.face());
        assertFalse(passage.broken(east.getBlockPos(), 12));
        assertEquals(0, passage.cuts());
        assertTrue(passage.broken(west.getBlockPos(), 12));
        assertFalse(passage.broken(west.getBlockPos(), 13));
        assertEquals(1, passage.cuts());
        passage.finish();
        assertEquals(east, passage.begin(FOOT).face());
    }

    @Test
    void aFailedApertureCannotRetryItsLeafAndCannotSpendTheBreakBudget() {
        var passage = new AgentSupplyEgress.CanopyPassage();
        var east = face(FOOT.east().up());
        var west = face(FOOT.west());
        passage.offer(FOOT, Direction.EAST, east, false);
        assertEquals(east, passage.begin(FOOT).face());
        passage.finish();
        passage.offer(FOOT, Direction.EAST, east, true);
        assertNull(passage.begin(FOOT));
        assertEquals(0, passage.cuts());
        passage.offer(FOOT, Direction.WEST, west, false);
        assertNull(passage.begin(FOOT.south()));
        assertEquals(west, passage.begin(FOOT).face());
    }

    @Test
    void realCutsRenewOnlyAtANewWalkedBranchWithAnObservedWorksite() {
        var passage = new AgentSupplyEgress.CanopyPassage();
        BlockPos originalStem = FOOT.north(2);
        passage.productive(FOOT, originalStem);
        for (int tree = 0; tree < 3; tree++) {
            BlockPos foot = FOOT.east(4 * tree);
            for (BlockPos leaf : new BlockPos[]{foot.east().up(), foot.east()}) {
                passage.offer(foot, Direction.EAST, face(leaf), false);
                assertEquals(leaf, passage.begin(foot).face().getBlockPos());
                assertTrue(passage.broken(leaf, 12));
                passage.finish();
            }
            passage.offer(foot, Direction.WEST, face(foot.west()), true);
            assertNull(passage.begin(foot));
        }
        assertEquals(6, passage.cuts());
        BlockPos other = FOOT.east(16);
        passage.productive(other, originalStem.up(2));
        passage.offer(other, Direction.EAST, face(other.east()), true);
        assertNull(passage.begin(other));
        passage.landed(other.west(), other);
        passage.productive(other, originalStem.up(3));
        passage.offer(other, Direction.EAST, face(other.east()), true);
        assertNull(passage.begin(other), "a fresh angle on the same stem is not a new branch");
        passage.productive(other, other.east(3));
        passage.offer(other, Direction.EAST, face(other.east()), true);
        assertEquals(other.east(), passage.begin(other).face().getBlockPos());
        passage.finish();
        assertEquals(0, passage.cuts());
        assertFalse(passage.available(FOOT, FOOT.south()), "the old footing stays spent");
    }

    @Test
    void repeatedNoEffectAttemptsAreBoundedAcrossDifferentTrees() {
        var passage = new AgentSupplyEgress.CanopyPassage();
        for (int i = 0; i < 12; i++) {
            BlockPos from = FOOT.east(4 * i);
            passage.landed(from.west(), from);
            var leaf = face(from.east().up());
            passage.offer(from, Direction.EAST, leaf, false);
            assertEquals(leaf, passage.begin(from).face());
            passage.finish();
        }
        BlockPos other = FOOT.south(4);
        passage.offer(other, Direction.EAST, face(other.east().up()), false);
        assertNull(passage.begin(other));
        assertEquals(0, passage.cuts());
    }

    @Test
    void failedCutsCannotGrindThroughEveryLeafFromOneFooting() {
        var passage = new AgentSupplyEgress.CanopyPassage();
        for (Direction direction : new Direction[]{Direction.NORTH, Direction.SOUTH, Direction.WEST}) {
            passage.offer(FOOT, direction, face(FOOT.offset(direction).up()), false);
            assertNotNull(passage.begin(FOOT));
            passage.finish();
        }
        passage.offer(FOOT, Direction.EAST, top(FOOT.east().down()), true);
        assertNull(passage.begin(FOOT));
        assertEquals(0, passage.cuts());
    }

    @Test
    void onlyAnActualCanopyLandingProtectsTheLowerSupport() {
        var passage = new AgentSupplyEgress.CanopyPassage();
        BlockPos lower = FOOT.east().down();
        passage.offer(FOOT, Direction.EAST, top(lower), true);
        assertFalse(passage.walkedSupport(lower.down()));
        passage.landed(FOOT, lower);
        assertTrue(passage.walkedSupport(FOOT.down()));
        assertTrue(passage.walkedSupport(lower.down()));
        assertFalse(passage.walkedSupport(lower));
    }

    private static BlockHitResult face(BlockPos leaf) {
        return new BlockHitResult(Vec3d.ofCenter(leaf), Direction.WEST, leaf, false);
    }

    private static BlockHitResult top(BlockPos block) {
        return new BlockHitResult(Vec3d.ofBottomCenter(block.up()), Direction.UP, block, false);
    }
}
