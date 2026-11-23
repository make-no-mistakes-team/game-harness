package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class OrdinaryResourceStanceTest {
    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

    @Test
    void returningToTheSameStanceDoesNotReopenTheRefusedStoneApproach() {
        var refused = new AgentResourceStance.Refusals();
        var stance = new BlockPos(2, 70, 3);
        var stone = stance.east(4).down();
        var detour = stance.south(2);

        assertFalse(refused.contains(stance, stone));
        refused.remember(stance, stone);
        assertFalse(refused.contains(detour, stone), "a different stance may have a genuine new route");
        assertFalse(refused.contains(stance, stone.south()), "a distinct visible rock is not the failed target");
        refused.changed(detour.south(8));
        assertTrue(refused.contains(stance, stone), "returning and seeing the same rock must not restart its lane");
        refused.changed(stance.east());
        assertFalse(refused.contains(stance, stone), "a witnessed nearby cut allows a fresh route check");
    }

    @Test
    void lowerBirchRequiresACollectionStanceAtTheHeightOfTheTrunk() {
        var feet = new Vec3d(-34.52, 65, 6.38);
        var trunk = new BlockPos(-31, 64, 4);
        var face = new Vec3d(-31, 64.8, 4.7);
        var goal = AgentProgress.timberCollectionGoal(feet, trunk, face, 0.6);
        var stance = BlockPos.ofFloored(feet).east(3).down().north(2);

        assertFalse(goal.reached(feet), "being in striking reach does not make the crop collectible");
        assertTrue(goal.reached(Vec3d.ofBottomCenter(stance)));
        assertFalse(goal.reached(Vec3d.ofBottomCenter(stance.up())), "the ground above the drop is not pickup access");

        var player = new Box(-34.82, 65, 6.08, -34.22, 66.8, 6.68);
        var drop = new Box(-30.98, 64, 4.25, -30.73, 64.25, 4.50);
        var stock = AgentPickup.logApproach(player, drop);
        assertNotNull(stock);
        assertTrue(stock.reached(Vec3d.ofBottomCenter(stance)));
        assertFalse(stock.reached(Vec3d.ofBottomCenter(stance.up())));
    }

    @Test
    void aGroundedDropNeedsActualInventoryGainAfterTravel() {
        var feet = new Vec3d(-34.52, 65, 6.38);
        var trunk = new BlockPos(-33, 65, 9);
        var first = BlockPos.ofFloored(feet).south();
        var stance = first.south().east();
        var goal = AgentProgress.timberCollectionGoal(feet, trunk, new Vec3d(-32.9, 65.5, 9), 0.6);
        assertFalse(goal.reached(feet));
        assertFalse(goal.reached(Vec3d.ofBottomCenter(first)));
        assertTrue(goal.reached(Vec3d.ofBottomCenter(stance)));

        var drop = new Box(-32.96, 65, 9.17, -32.71, 65.25, 9.42);
        var player = new Box(-34.82, 65, 6.08, -34.22, 66.8, 6.68);
        var pursuit = new AgentPickup.Pursuit(100, 0, feet, drop, true, true);
        var stock = AgentPickup.logApproach(player, pursuit.groundedBounds(100));
        assertNotNull(stock);
        assertFalse(stock.reached(Vec3d.ofBottomCenter(first)));
        assertTrue(stock.reached(Vec3d.ofBottomCenter(stance)));
        assertFalse(pursuit.stockGained(0), "neither arrival nor overlap is wood in inventory");
        assertTrue(pursuit.stockGained(1));
        assertNull(pursuit.groundedBounds(127), "a stale observed drop cannot start another leg");
    }

    @Test
    void onlyTheUninterruptedAuthorizedOwnerCanKeepDrivingTimberTravel() {
        assertFalse(AgentResourceStance.allowsTravel(false, true, false, false));
        assertFalse(AgentResourceStance.allowsTravel(false, false, true, true), "an emergency wins in flight");
        assertFalse(AgentResourceStance.allowsTravel(true, true, true, false), "no stale crossing after a safety turn");
        assertFalse(AgentResourceStance.allowsTravel(true, false, false, false), "no new crossing from the air");
        assertTrue(AgentResourceStance.allowsTravel(true, true, false, false));
        assertTrue(AgentResourceStance.allowsTravel(true, false, true, true));
    }
}
