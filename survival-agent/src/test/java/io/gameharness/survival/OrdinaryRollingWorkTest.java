package io.gameharness.survival;

import static io.gameharness.survival.AgentWorkOrder.TravelKind.CAVE_FRONTIER;
import static io.gameharness.survival.AgentWorkOrder.TravelKind.RESOURCE;
import static io.gameharness.survival.AgentWorkOrder.TravelKind.WOODLAND_FRONTIER;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import net.minecraft.block.Blocks;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.EmptyBlockView;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class OrdinaryRollingWorkTest {
    private static final Vec3d FEET = new Vec3d(0.5, 0, 0.5);
    private static final double EYE_Y = 1.62;
    private static final double REACH = 4.25;
    private static final AgentWorkOrder.TravelAnchor ORE =
        new AgentWorkOrder.TravelAnchor("block:minecraft:deepslate_diamond_ore", "ore-a");
    private static final AgentWorkOrder.TravelAnchor CAVE =
        new AgentWorkOrder.TravelAnchor("block:minecraft:deepslate", "cave-a");
    private static final AgentWorkOrder.TravelAnchor OAK =
        new AgentWorkOrder.TravelAnchor("block:minecraft:oak_log", "trunk-a");
    private static final AgentWorkOrder.TravelAnchor WOODLAND =
        new AgentWorkOrder.TravelAnchor("landmark:woodland", "grove-a");

    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

    @Test
    void paidDiamondCanStartAVisibleCaveLegOrAnApproachToActualOreWithoutASpine() {
        var paid = order("diamond", "\"prospect:minecraft:diamond\",\"break:minecraft:deepslate_diamond_ore\"",
            ",\"duringWaitFor\":\"9d0ad30c-b85c-4261-baff-f071c8e5ebc1\"");
        assertTrue(paid.policy().diamondProspecting());
        assertNotNull(paid.duringWaitFor());
        var floor = runway(0);
        assertTrue(AgentMacroControl.rollingWorkAdmits(paid, false, CAVE, CAVE_FRONTIER, true, floor));
        assertTrue(AgentMacroControl.rollingWorkAdmits(paid, false, ORE, RESOURCE, true, floor));
        assertFalse(AgentMacroControl.rollingWorkAdmits(paid, false, CAVE, CAVE_FRONTIER, true, runway(-1)));
        assertFalse(paid.policy().breakAllowed(Blocks.DEEPSLATE.getDefaultState()));
        assertFalse(paid.policy().placeProspectSupport());
        assertEquals(4, new AgentWorkOrder.Budget(paid.policy()).breaksLeft());
    }

    @Test
    void scopedRegularDiamondCannotBorrowAnotherFrontierOrSubstituteAnOre() {
        var ordinary = order("diamond", "\"prospect:minecraft:diamond\",\"break:minecraft:deepslate_diamond_ore\"",
            ",\"travelAnchor\":{\"subject\":\"block:minecraft:deepslate\",\"target\":\"cave-a\"}");
        assertTrue(AgentMacroControl.rollingWorkAdmits(ordinary, true, CAVE, CAVE_FRONTIER, true, runway(0)));
        assertFalse(AgentMacroControl.rollingWorkAdmits(ordinary, true,
            new AgentWorkOrder.TravelAnchor(CAVE.subject(), "cave-b"), CAVE_FRONTIER, true, runway(0)));
        assertFalse(AgentMacroControl.rollingWorkAdmits(ordinary, true, ORE, RESOURCE, true, runway(0)));
    }

    @Test
    void anOakJobCanApproachAVisibleLowerTopOrADistinctGroveWithoutAuthorizingALeafCut() {
        var exact = order("oak_log", "\"break:minecraft:oak_log\"",
            ",\"travelAnchor\":{\"subject\":\"block:minecraft:oak_log\",\"target\":\"trunk-a\"}");
        var grove = order("oak_log", "\"break:minecraft:oak_log\"",
            ",\"travelAnchor\":{\"subject\":\"landmark:woodland\",\"target\":\"grove-a\"}");
        var lowerTop = hit(4, -2, Direction.UP);
        assertTrue(AgentMacroControl.timberTravelCue(lowerTop, FEET, EYE_Y, REACH));
        assertFalse(AgentMacroControl.timberTravelCue(hit(4, 7, Direction.DOWN), FEET, EYE_Y, REACH));
        assertTrue(AgentMacroControl.woodlandTravelCue(hit(4, -1, Direction.UP), FEET));
        assertFalse(AgentMacroControl.woodlandTravelCue(hit(0, -1, Direction.UP), FEET));

        assertTrue(AgentMacroControl.rollingWorkAdmits(exact, true, OAK, RESOURCE, false, runway(0)));
        assertFalse(AgentMacroControl.rollingWorkAdmits(exact, true, OAK, RESOURCE, false, runway(-1)));
        assertFalse(AgentMacroControl.rollingWorkAdmits(exact, true,
            new AgentWorkOrder.TravelAnchor(OAK.subject(), "trunk-b"), RESOURCE, false, runway(0)));
        assertFalse(AgentMacroControl.rollingWorkAdmits(exact, true, WOODLAND, WOODLAND_FRONTIER, false, runway(0)));
        assertTrue(AgentMacroControl.rollingWorkAdmits(grove, true, WOODLAND, WOODLAND_FRONTIER, false, runway(0)));
        assertFalse(AgentMacroControl.rollingWorkAdmits(grove, true, WOODLAND, WOODLAND_FRONTIER, false, runway(1)));
        assertFalse(grove.policy().breakAllowed(Blocks.OAK_LEAVES.getDefaultState()));
    }

    @Test
    void firstLogUsesAComfortableStandoffRatherThanTheFirstReachablePose() {
        Vec3d face = new Vec3d(-48.6, 68.1, 29);
        BlockPos trunk = new BlockPos(-49, 68, 29);
        Vec3d firstReach = new Vec3d(-48.7, 67, 24.80); // TD9bn7 first harvest
        Vec3d workStance = new Vec3d(-48.6, 67, 28.24);
        double arrival = AgentMacroControl.timberWorkArrival(firstReach, face, trunk, 0.6);
        assertEquals(0.70, arrival, 0.001);
        assertFalse(AgentMacroControl.timberReadyToCut(true, firstReach, face, arrival, false));
        assertTrue(AgentMacroControl.timberReadyToCut(true, workStance, face, arrival, false));
        assertTrue(AgentMacroControl.timberReadyToCut(true, firstReach, face, arrival, true),
            "a lost dry continuation does not prohibit the otherwise safe distant cut");
        assertFalse(AgentMacroControl.timberReadyToCut(false, firstReach, face, arrival, true));
        assertEquals(0.80, AgentMacroControl.timberWorkArrival(firstReach, face, trunk, 0.8), 0.001);
        assertEquals(1.20, AgentMacroControl.timberWorkArrival(firstReach,
            new Vec3d(-48.7, 69, 29.5), trunk, 0.6), 0.001, "a top hit needs clearance from the near edge");
    }

    @Test
    void aPreparatoryLeafCostsOneBreakAndLeavesTheExactWoodGrantIntact() {
        var oak = Blocks.OAK_LEAVES.getDefaultState();
        var birch = Blocks.BIRCH_LEAVES.getDefaultState();
        var policy = order("oak_log", "\"break:minecraft:oak_log\",\"break:minecraft:oak_leaves\"", "").policy();
        assertNotNull(policy);
        assertTrue(policy.timberClearAllowed(oak));
        assertFalse(policy.timberClearAllowed(birch));
        assertFalse(policy.breakAllowed(oak), "leaves remain outside ordinary stock gathering");
        assertFalse(policy.travelAnchorAllowed("block:minecraft:oak_leaves", RESOURCE));
        assertFalse(AgentWorkOrder.resource(oak));
        assertFalse(order("oak_log", "\"break:minecraft:oak_log\"", "").policy().timberClearAllowed(oak));
        var budget = new AgentWorkOrder.Budget(policy);
        assertTrue(budget.canOpenTimber(1));
        assertFalse(budget.canOpenTimber(budget.breaksLeft()), "the missing log stock takes priority");
        budget.broken(net.minecraft.item.Items.AIR, 0);
        assertTrue(budget.canBreak());
        assertTrue(policy.breakAllowed(Blocks.OAK_LOG.getDefaultState()));
    }

    @Test
    void onlyAForwardReachableSideOrHeadLeafCanBeTheObstruction() {
        var tree = new Vec3d(4, 0.5, 0.5);
        assertTrue(AgentMacroControl.timberObstructionGeometry(FEET, tree, hit(1, 1, Direction.WEST), EYE_Y, REACH));
        assertTrue(AgentMacroControl.timberObstructionGeometry(FEET, tree, hit(1, 0, Direction.WEST), EYE_Y, REACH));
        assertFalse(AgentMacroControl.timberObstructionGeometry(FEET, tree, hit(0, 1, Direction.WEST), EYE_Y, REACH));
        assertFalse(AgentMacroControl.timberObstructionGeometry(FEET, tree, hit(1, -1, Direction.WEST), EYE_Y, REACH));
        assertFalse(AgentMacroControl.timberObstructionGeometry(FEET, tree, hit(-1, 1, Direction.EAST), EYE_Y, REACH));
        assertFalse(AgentMacroControl.timberObstructionGeometry(FEET, tree, hit(1, 1, Direction.WEST), EYE_Y, 0.4));
    }

    @Test
    void aLeafOpeningDoesNotTurnWaterACliffOrTheCanopyIntoDryFooting() {
        var world = EmptyBlockView.INSTANCE;
        var floor = new BlockPos(1, -1, 0);
        assertTrue(AgentMacroControl.timberSolidDryFloor(world, floor, Blocks.GRASS_BLOCK.getDefaultState()));
        assertFalse(AgentMacroControl.timberSolidDryFloor(world, floor, Blocks.WATER.getDefaultState()));
        assertFalse(AgentMacroControl.timberSolidDryFloor(world, floor, Blocks.AIR.getDefaultState()));
        assertFalse(AgentMacroControl.timberSolidDryFloor(world, floor, Blocks.OAK_LEAVES.getDefaultState()));
        assertFalse(AgentMacroControl.timberSolidDryFloor(world, floor, Blocks.CRAFTING_TABLE.getDefaultState()));
    }

    @Test
    void aRealBrakingAdvanceMayRecheckTheSameOakButSidewaysJitterCannot() {
        Vec3d goal = new Vec3d(6.5, 0, 0.5);
        assertTrue(AgentMacroControl.improvedHorizonStance(FEET, FEET.add(3.23, 0, 0), goal));
        assertFalse(AgentMacroControl.improvedHorizonStance(FEET, FEET.add(0.12, 0, 0), goal));
        assertFalse(AgentMacroControl.improvedHorizonStance(FEET, FEET.add(0.10, 0, 1.2), goal));
    }

    @Test
    void onlyTheUnanchoredPricedJobMayUseAContactPulse() {
        var ordinary = order("oak_log", "\"break:minecraft:oak_log\"", "");
        var anchored = order("oak_log", "\"break:minecraft:oak_log\"",
            ",\"travelAnchor\":{\"subject\":\"block:minecraft:oak_log\",\"target\":\"trunk-a\"}");
        var pulse = new AgentVisibleHorizon.Window(null, -90, 0.34, 0.295,
            AgentVisibleHorizon.Medium.DRY, 1, 0, 0, null, true);
        assertTrue(AgentMacroControl.rollingWorkAdmits(ordinary, false, null, RESOURCE, false, pulse));
        assertFalse(AgentMacroControl.rollingWorkAdmits(anchored, true, OAK, RESOURCE, false, pulse));
        assertFalse(AgentMacroControl.rollingWorkAdmits(anchored, false, null, RESOURCE, false, pulse),
            "using the exact anchor once does not retroactively authorize a contact pulse");
    }

    @Test
    void onlyAnUncommittedDiamondProspectCanStartANewRootAndTransitDoesNotJoinItsSpine() {
        var route = new AgentMacroControl.DiamondRoute();
        var stone = Blocks.STONE.getDefaultState();
        var old = new BlockPos(0, 20, 0);
        var landing = old.east(2).south();
        route.arrive(old, stone, Direction.EAST);
        route.advance(new AgentSurfaceTread.Edge(old, stone, old.east(), stone, Direction.EAST));
        assertTrue(route.rollingDepartureAllowed());
        assertFalse(route.arriveFromHorizon(landing, null, Direction.SOUTH));
        assertEquals(1, route.spine.size());
        assertTrue(route.arriveFromHorizon(landing, stone, Direction.SOUTH));
        assertEquals(landing, route.foot);
        assertSame(stone, route.support);
        assertTrue(route.spine.isEmpty());
        assertNull(route.rootExit);

        route.select(Direction.SOUTH, 0, true);
        route.coverOpened();
        assertFalse(route.rollingDepartureAllowed());
        assertFalse(route.arriveFromHorizon(landing.east(), stone, Direction.EAST));
        assertEquals(Direction.SOUTH, route.bearing);
        assertEquals(landing, route.foot);
    }

    private static AgentWorkOrder order(String item, String effects, String extra) {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"ordinary-leg","run":"run","life":1,"epoch":1,"basisTick":15,"expiresTick":400,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:%s","count":1},
             "allowedEffects":[%s],"costCaps":[],"reserves":[],
             "maxBreaks":4,"maxCrafts":0,"maxPlacements":0%s}
            """.formatted(item, effects, extra)).getAsJsonObject();
        var order = AgentWorkOrder.parse(raw, "run", "constrained");
        assertNotNull(order.policy());
        return order;
    }

    private static BlockHitResult hit(int x, int y, Direction side) {
        return new BlockHitResult(new Vec3d(x + 0.5, y + (side == Direction.UP ? 1 : 0), 0.5),
            side, new BlockPos(x, y, 0), false);
    }

    private static AgentVisibleHorizon.Window runway(double nextHeight) {
        var ground = AgentVisibleHorizon.Patch.dry(0, 0.6);
        var next = AgentVisibleHorizon.Patch.dry(nextHeight, 0.6);
        var stance = new AgentVisibleHorizon.Stance(FEET.x, FEET.y, FEET.z, 0.31,
            Vec3d.ZERO, 0.10, ground.drag(), false, new BlockPos(0, -1, 0));
        var trace = AgentVisibleHorizon.trace((x, z) -> z != 0 || x < 0 || x > 2 ? null : x == 0 ? ground : next,
            stance, 1, 0);
        return new AgentVisibleHorizon.Window(null, -90, trace.known(), trace.braking(), trace.medium(),
            1, 0, 0, null, false);
    }
}
