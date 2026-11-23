package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.block.Blocks;
import net.minecraft.block.LeavesBlock;
import net.minecraft.state.property.Properties;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class CanopyPassageTest {
    private static final BlockPos FOOT = new BlockPos(-25, 69, 4);

    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

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
    void anUnlandedCanopyTreadDoesNotReserveItsWholeDirectionOrCreateAFootprint() {
        var course = new AgentOverlandSearch.Course();
        course.start(FOOT, Direction.EAST);
        BlockPos lower = FOOT.east().down();
        assertTrue(course.walkedSupport(FOOT.down()));
        assertTrue(course.canExtend(FOOT, lower, Direction.EAST, 0));
        assertTrue(course.canExtend(FOOT, FOOT.east(), Direction.EAST, 0));
        assertFalse(course.walkedSupport(lower.down()));
        assertFalse(course.canExtend(FOOT, lower.down(), Direction.EAST, 0));
        assertTrue(course.arrived(lower));
        assertTrue(course.walkedSupport(lower.down()));
        assertEquals(FOOT, course.previous(lower));
        assertFalse(course.canExtend(FOOT, lower, Direction.EAST, 0));
        assertTrue(course.canExtend(FOOT, FOOT.east(), Direction.EAST, 0));
    }

    private static BlockHitResult face(BlockPos leaf) {
        return new BlockHitResult(Vec3d.ofCenter(leaf), Direction.WEST, leaf, false);
    }

    private static BlockHitResult top(BlockPos block) {
        return new BlockHitResult(Vec3d.ofBottomCenter(block.up()), Direction.UP, block, false);
    }
}
