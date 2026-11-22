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

import net.minecraft.block.Blocks;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
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
    void stockQuarryDistinguishesPickReachFromPickupRange() {
        var foot = new BlockPos(0, 61, 0);
        var stance = PLAYER.offset(0.5, 61, 0.5);
        assertTrue(AgentProgress.stoneWithinPickupStance(stance, foot.west()));
        assertTrue(AgentProgress.stoneWithinPickupStance(stance, foot.west().up()));
        assertFalse(AgentProgress.stoneWithinPickupStance(stance, foot.west().down()),
            "the near ledge block needs checked excavation, not a cut from the rim");
        assertFalse(AgentProgress.stoneWithinPickupStance(stance, foot.west(2)),
            "a level face across the opening is within pick reach but its cargo is not");
        assertFalse(AgentProgress.stoneWithinPickupStance(stance, foot.west(2).down(2)));

        var surveyedLowerFoot = foot.west().down();
        var lowerStance = PLAYER.offset(-0.5, 60, 0.5);
        assertTrue(AgentProgress.stoneWithinPickupStance(lowerStance, surveyedLowerFoot.west()),
            "a checked move turns a previously remote lower wall into collectible work");
    }

    @Test
    void stockQuarryUsesActualStanceRatherThanTheNominalTileCenter() {
        var foot = new BlockPos(0, 61, 0);
        var nearWestWall = PLAYER.offset(0.3, 61, 0.5);
        assertTrue(AgentProgress.stoneWithinPickupStance(nearWestWall, foot.west()));
        assertFalse(AgentProgress.stoneWithinPickupStance(nearWestWall, foot.east()),
            "the opposite wall is too far to allow for the drop's spawn offset");
    }

    @Test
    void firstPickStopsDeepeningAfterSixDecorativeCutsWithoutAStoneReceipt() {
        var work = new AgentProgress.StoneProbeBudget();
        work.begin(0, 0, 59);
        assertTrue(work.canDeepen(59, false));
        for (int i = 0; i < 5; i++) work.decorativeCut();
        assertTrue(work.canDeepen(54, false));
        work.decorativeCut();
        assertFalse(work.canDeepen(53, false));
        work.observeStock(1);
        assertTrue(work.canDeepen(52, false), "actual usable stock is progress, unlike loose variants");
        assertFalse(work.canDeepen(52, true), "a receipt does not erase a retired worksite");
    }

    @Test
    void resumingTheWornQuarryConservesEnoughUsesForActualStone() {
        var work = new AgentProgress.StoneProbeBudget();
        work.begin(0, 48, 8);
        assertFalse(work.canDeepen(8, false));
        assertTrue(work.canSpendOnCover(8), "a short distinct lateral probe is still payable");
        assertFalse(work.canSpendOnCover(3), "reserve one wooden-pick use per missing stone");
        work.begin(2, 48, 59);
        assertTrue(work.canDeepen(59, false), "decorative inventory alone proves neither failure nor hidden stone");
        assertTrue(work.canSpendOnCover(2), "two cobblestone already collected reduce the reserve to one use");
    }

    @Test
    void lowerQuarryDropThatFailsFlatInputCanBeCollectedFromAWitnessedTread() {
        var rim = new BlockPos(0, 61, 0);
        var lower = rim.north().down();
        var player = PLAYER.offset(0.53, 61, 0.48);
        var drop = item(0.28, 60, -1.32);

        assertEquals(UNREACHABLE, AgentPickup.input(player, drop, true, null, 180));
        assertTrue(AgentPickup.shouldCheckDryAccess(player, drop, true, 0));
        assertEquals(new AgentPickup.Access(lower, Direction.NORTH),
            AgentPickup.dryAccess(player, drop, rim, (step, bearing) -> step.equals(lower)));
        assertTrue(AgentPickup.passiveOverlap(PLAYER.offset(0.5, 60, -0.5), drop));
    }

    @Test
    void visibleDropBelowAnUnprovedOrDeepOpeningDoesNotAuthorizeAStep() {
        var rim = new BlockPos(0, 61, 0);
        var player = PLAYER.offset(0.53, 61, 0.48);
        var drop = item(0.28, 60, -1.32);
        assertNull(AgentPickup.dryAccess(player, drop, rim, (step, bearing) -> false),
            "a visible entity does not establish a dry route or return");
        assertNull(AgentPickup.dryAccess(player, drop.offset(0, -1, 0), rim, (step, bearing) -> {
            throw new AssertionError("a drop in a deeper hole cannot nominate any tread to probe");
        }));
    }

    @Test
    void apparentRimOverlapGetsABoundedWaitThenACloserWitnessedStance() {
        var rim = new BlockPos(0, 61, 0);
        var player = PLAYER.offset(0.53, 61, 0.48);
        var drop = item(0.31, 60.4, -0.52);
        assertEquals(WAIT, AgentPickup.input(player, drop, true, null, 180));
        assertFalse(AgentPickup.shouldCheckDryAccess(player, drop, true, 9), "give vanilla time to accept pickup");
        assertFalse(AgentPickup.shouldCheckDryAccess(player, drop, false, 24), "do not chase a falling item");
        assertTrue(AgentPickup.shouldCheckDryAccess(player, drop, true, 12), "overlap without stock is not a receipt");
        assertEquals(new AgentPickup.Access(rim.north().down(), Direction.NORTH),
            AgentPickup.dryAccess(player, drop, rim, (step, bearing) -> true));
    }

    @Test
    void aLogOnTheGrassShelfNeedsTheExactWitnessedOneBlockRise() {
        var from = new BlockPos(0, 62, 0);
        var shelf = from.east().up();
        var player = PLAYER.offset(0.5, 62, 0.5);
        var log = item(2.2, 63, 0.5);
        assertEquals(RIGHT, AgentPickup.input(player, log, true, null, 180));
        assertEquals(new AgentPickup.Access(shelf, Direction.EAST),
            AgentPickup.dryAccess(player, log, from, true, (step, bearing) -> step.equals(shelf)));
        assertNull(AgentPickup.dryAccess(player, log, from, true, (step, bearing) -> false),
            "seeing the log supplies neither top nor passage proof");
        assertNull(AgentPickup.dryAccess(player, log, from, (step, bearing) -> step.equals(shelf)),
            "a scoped level/down route cannot acquire a new rise");
    }

    @Test
    void aStockShelfUsesTheGeneralGradeProofInEitherDirection() {
        var from = new BlockPos(0, 62, 0);
        var to = from.east().up();
        var stone = Blocks.STONE.getDefaultState();
        var grass = Blocks.GRASS_BLOCK.getDefaultState();
        var top = new BlockHitResult(Vec3d.ofBottomCenter(to), Direction.UP, to.down(), false);
        assertNull(AgentSurfaceTread.witnessedGradeEdge(from, stone, Direction.EAST, top, grass, false),
            "the item and even the visible top cannot authorize a jump into an obstructed crown");
        var edge = AgentSurfaceTread.witnessedGradeEdge(from, stone, Direction.EAST, top, grass, true);
        assertNotNull(edge);
        var up = AgentSurfaceTread.ordinaryStock(edge, from, 22);
        assertEquals(from, up.from);
        assertEquals(to, up.to);
        assertTrue(up.returning);
        var down = AgentSurfaceTread.ordinaryStock(edge, to, 51);
        assertEquals(to, down.from);
        assertEquals(from, down.to);
        assertFalse(down.returning);
    }

    @Test
    void airborneStockKeepsItsOwnBoundedAttemptWithoutGivingPickupCredit() {
        var feet = new Vec3d(-19.504, 57, 15.300);
        var airborne = item(-20.9, 57.3, 16.7);
        var attempt = new AgentPickup.Pursuit(2372, 0, feet, airborne, false, false);
        attempt.observe(2374, feet, airborne.offset(0.1, 0, 0), false);
        attempt.observe(2380, feet.add(0, 0, 0.21), airborne.offset(0.2, -0.7, 0.15), false);
        assertTrue(attempt.settling(2380));
        assertNull(attempt.groundedBounds(2380), "a falling item cannot authorize tread movement");
        assertFalse(attempt.stockGained(0));
        assertFalse(attempt.settling(2404), "a stationary ungrounded item cannot hold work forever");
        var landed = airborne.offset(0.2, -1.3, 0.15);
        attempt.observe(2381, feet, landed, true);
        assertFalse(attempt.settling(2381), "a grounded lower item now needs a witnessed approach");
        assertEquals(landed, attempt.groundedBounds(2401), "the last sighting can outlive a brief terrain glance");
        assertFalse(attempt.stockGained(0), "retaining the grounded sighting does not establish pickup");
        assertNull(attempt.groundedBounds(2408), "a stale sighting cannot start a new tread");
        assertTrue(attempt.stockGained(1));
        assertTrue(attempt.expired(2553), "repeated movement cannot extend the absolute pursuit");
    }

    @Test
    void aLowerDropCanBeCollectedFromALevelAlternativeWithoutDescending() {
        var from = new BlockPos(0, 61, 0);
        var player = PLAYER.offset(0.5, 61, 0.5);
        var drop = item(1.75, 60.5, 0.5);
        assertEquals(new AgentPickup.Access(from.east(), Direction.EAST),
            AgentPickup.dryAccess(player, drop, from, (step, bearing) -> step.equals(from.east())));
    }

    @Test
    void aSameLevelDropCanUseAnAlternateWitnessedTreadRatherThanTheUnprovedDirectBearing() {
        var from = new BlockPos(0, 61, 0);
        var player = PLAYER.offset(0.5, 61, 0.5);
        var drop = item(1.4, 61, 1.3);
        assertEquals(new AgentPickup.Access(from.east(), Direction.EAST),
            AgentPickup.dryAccess(player, drop, from, (step, bearing) -> true));
        assertEquals(new AgentPickup.Access(from.south(), Direction.SOUTH),
            AgentPickup.dryAccess(player, drop, from, (step, bearing) -> step.equals(from.south())));
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
