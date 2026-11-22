package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
    void aRealLowerTopWinsAndOnlyTheSelectedOwnBreakOpensItsBranch() {
        var passage = new AgentSupplyEgress.CanopyPassage();
        var east = face(FOOT.east().up());
        var west = face(FOOT.west().up());
        passage.offer(FOOT, Direction.EAST, east, false);
        passage.offer(FOOT, Direction.WEST, west, true);
        var selected = passage.begin(FOOT);
        assertEquals(west, selected.face());
        assertFalse(passage.broken(east.getBlockPos()));
        assertEquals(0, passage.cuts());
        assertTrue(passage.broken(west.getBlockPos()));
        assertFalse(passage.broken(west.getBlockPos()));
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
    void realCutsAreLimitedAtOneFootingAndAcrossTheBootstrap() {
        var passage = new AgentSupplyEgress.CanopyPassage();
        for (int tree = 0; tree < 3; tree++) {
            BlockPos foot = FOOT.east(4 * tree);
            for (BlockPos leaf : new BlockPos[]{foot.east().up(), foot.east()}) {
                passage.offer(foot, Direction.EAST, face(leaf), false);
                assertEquals(leaf, passage.begin(foot).face().getBlockPos());
                assertTrue(passage.broken(leaf));
                passage.finish();
            }
            passage.offer(foot, Direction.WEST, face(foot.west()), true);
            assertNull(passage.begin(foot));
        }
        assertEquals(6, passage.cuts());
        BlockPos other = FOOT.east(16);
        passage.offer(other, Direction.EAST, face(other.east()), true);
        assertNull(passage.begin(other));
    }

    @Test
    void repeatedNoEffectAttemptsAreBoundedAcrossDifferentTrees() {
        var passage = new AgentSupplyEgress.CanopyPassage();
        for (int i = 0; i < 12; i++) {
            BlockPos from = FOOT.east(4 * i);
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
        assertFalse(course.canExtend(FOOT, lower, Direction.EAST, 0));
        assertTrue(course.canExtend(FOOT, FOOT.east(), Direction.EAST, 0));
    }

    private static BlockHitResult face(BlockPos leaf) {
        return new BlockHitResult(Vec3d.ofCenter(leaf), Direction.WEST, leaf, false);
    }
}
