package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class TaskRunnerTest {
    @Test
    void replacementPickaxeNeedsATableOrEnoughWoodForBothTableAndHandles() {
        assertFalse(TaskRunner.canCraftStonePickaxe(3, 2, 0, 0, false));
        assertFalse(TaskRunner.canCraftStonePickaxe(3, 0, 0, 1, false));
        assertTrue(TaskRunner.canCraftStonePickaxe(3, 2, 0, 1, false));
        assertTrue(TaskRunner.canCraftStonePickaxe(3, 0, 2, 1, false));
        assertTrue(TaskRunner.canCraftStonePickaxe(3, 2, 0, 0, true));
        assertFalse(TaskRunner.canCraftStonePickaxe(2, 2, 4, 0, true));
    }

    @Test
    void pillarPlacementUsesTheStartingBlockEvenAfterFeetCrossTheNextBlockBoundary() {
        BlockPos base = new BlockPos(0, 62, 0);
        assertFalse(SurvivalReflexes.shouldPlaceBurrowPillarBlock(63.0, base));
        assertTrue(SurvivalReflexes.shouldPlaceBurrowPillarBlock(63.05, base));
    }
}
