package io.gameharness.survival;

import static io.gameharness.survival.AgentPickup.Input.FORWARD;
import static io.gameharness.survival.AgentPickup.Input.RIGHT;
import static io.gameharness.survival.AgentPickup.Input.UNREACHABLE;
import static io.gameharness.survival.AgentPickup.Input.WAIT;
import static io.gameharness.survival.AgentPickup.Scope.EXACT_ENTITY;
import static io.gameharness.survival.AgentPickup.Scope.MATCHING_STOCK;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class AgentPickupTest {
    private static final Box PLAYER = new Box(-0.3, 0, -0.3, 0.3, 1.8, 0.3);

    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

    @Test
    void nearbyDropNeedsNeitherAViewChangeNorFootInputAsItFalls() {
        for (double height : new double[] { 3.2, 2.45, 2.2, 1.4, 0.2, 0 }) {
            assertEquals(WAIT, AgentPickup.input(PLAYER, item(1.3, height, 1.3), height == 0, null, 147));
        }
        assertEquals(UNREACHABLE, AgentPickup.input(PLAYER, item(1.3, -1, 1.3), true, null, 147));
    }

    @Test
    void walkIntoPickupRangeWithoutTurningToTrackTheDrop() {
        // Looking north, a drop to the east calls for a sidestep, not a yaw command.
        assertEquals(RIGHT, AgentPickup.input(PLAYER, item(2, 0, 0.12), true, null, 180));
        assertEquals(RIGHT, AgentPickup.input(PLAYER, item(2, 0.35, 0.12), true, null, 180));
        assertEquals(RIGHT, AgentPickup.input(PLAYER, item(2, 0.35, 0.12), false, null, 180));
        assertEquals(WAIT, AgentPickup.input(PLAYER, item(2, 2.4, 0.12), false, null, 180));
        assertEquals(WAIT, AgentPickup.input(PLAYER.offset(0.6, 0, 0), item(2, 0, 0.12), true, null, 180));
        assertEquals(FORWARD, AgentPickup.input(PLAYER, item(-0.8, 0, 2), true, null, 7));
    }

    @Test
    void aFootprintStraddlingTheSeamProbesBothContactTilesButNotTheNextUnseenTile() {
        Box footprint = PLAYER.offset(-48.77, 67, 24.946);
        assertNotNull(AgentPickup.footContact(footprint, -49, 24));
        assertNotNull(AgentPickup.footContact(footprint, -49, 25));
        assertNull(AgentPickup.footContact(footprint, -49, 26));
    }

    @Test
    void stockCollectionAllowsTwoMatchingOakDropsButNotOakAndDirt() {
        ItemStack selected = new ItemStack(Items.OAK_LOG);
        ItemStack otherOak = new ItemStack(Items.OAK_LOG, 2);
        assertTrue(MATCHING_STOCK.permitsNeighbor(selected, otherOak));
        assertFalse(MATCHING_STOCK.permitsNeighbor(selected, new ItemStack(Items.DIRT)));
        assertFalse(EXACT_ENTITY.permitsNeighbor(selected, otherOak));
    }

    @Test
    void stoppingSweepCanUseAnExactDryTopWitnessedBeforeChoppingButNotAnUnknownOrStaleTop() {
        var stance = new AgentVisibleHorizon.Stance(0.5, 67, 0.83, 0.31, Vec3d.ZERO, 0.1, 0.546,
            false, new BlockPos(0, 66, 0));
        var dry = AgentVisibleHorizon.Patch.dry(67, 0.6);
        var open = AgentVisibleHorizon.trace((x, z) ->
            x == 0 && (z == 0 || z == 1 && AgentVisibleHorizon.pickupTopFresh(30, 108, 67, 67)) ? dry : null,
            stance, 0, 1);
        assertEquals(AgentVisibleHorizon.Medium.DRY, open.medium());
        assertTrue(open.known() > open.braking());
        assertEquals(AgentVisibleHorizon.Medium.UNKNOWN,
            AgentVisibleHorizon.trace((x, z) -> x == 0 && z == 0 ? dry : null, stance, 0, 1).medium());
        assertFalse(AgentVisibleHorizon.pickupTopFresh(30, 127, 67, 67));
        assertFalse(AgentVisibleHorizon.pickupTopFresh(30, 108, 67, 66));
    }

    private static Box item(double x, double y, double z) {
        return new Box(x - 0.125, y, z - 0.125, x + 0.125, y + 0.25, z + 0.125);
    }
}
