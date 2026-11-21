package io.gameharness.survival;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.joml.Matrix4f;
import org.joml.Vector4f;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class DryCaveViewTest {
    private static final BlockPos SOURCE = new BlockPos(0, 32, 0);

    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
    }

    @Test
    void oneForwardViewWitnessesThreeReversibleEdgesWithoutAiming() {
        var view = new ForwardView();
        var graph = new AgentRouteGraph();
        long[] path = new long[3];
        graph.reset(SOURCE.asLong());
        BlockState source = Blocks.STONE.getDefaultState();
        for (int i = 0; i < path.length; i++) {
            var from = SOURCE.east(i);
            var to = from.east();
            var probe = new AgentDryCaveRoute.Probe(from, to, Direction.EAST);
            probe.sample(view, 20, 1, source, 20);
            assertTrue(probe.complete(20), probe::evidence);
            graph.observe(from.asLong(), to.asLong());
            graph.observe(to.asLong(), from.asLong());
            source = probe.floorState(20);
            path[i] = to.asLong();
        }
        assertTrue(graph.revalidateDirectSuffix(SOURCE.asLong(), path, 0, path.length));
        graph.walked(SOURCE.asLong(), path[0]);
        graph.walked(path[0], path[1]);
        graph.walked(path[1], path[2]);
        long[] returnedByTheSameSweeps = {path[1], path[0], SOURCE.asLong()};
        assertTrue(graph.revalidateDirectSuffix(path[2], returnedByTheSameSweeps, 0, returnedByTheSameSweeps.length));
    }

    @Test
    void aClearLookingCorridorDoesNotSupplyAnUnseenFloorOrAnOccludedLanding() {
        var view = new ForwardView();
        var landing = SOURCE.east();
        var noFloor = new AgentDryCaveRoute.Probe(SOURCE, landing, Direction.EAST);
        view.blocks.remove(landing.down());
        noFloor.sample(view, 20, 1, Blocks.STONE.getDefaultState(), 20);
        assertFalse(noFloor.complete(20));

        view.blocks.put(landing.down(), Blocks.STONE.getDefaultState());
        view.blocks.put(landing, Blocks.STONE.getDefaultState());
        var behindWall = new AgentDryCaveRoute.Probe(landing, landing.east(), Direction.EAST);
        behindWall.sample(view, 20, 1, Blocks.STONE.getDefaultState(), 20);
        assertFalse(behindWall.complete(20));

        view.blocks.put(SOURCE.west().down(), Blocks.STONE.getDefaultState());
        var behindCamera = new AgentDryCaveRoute.Probe(SOURCE, SOURCE.west(), Direction.WEST);
        behindCamera.sample(view, 20, 1, Blocks.STONE.getDefaultState(), 20);
        assertFalse(behindCamera.complete(20));
    }

    @Test
    void theOffscreenLintelDoesNotRequireASecondAimButStillHasToClearTheStandingSweep() {
        var to = SOURCE.east();
        var lane = new AgentDryCaveRoute.Probe(SOURCE, to, Direction.EAST);
        var stone = Blocks.STONE.getDefaultState();
        var downView = new ForwardView(52.6f);
        lane.sample(downView, 30, 1, stone, 30);
        assertTrue(lane.complete(30), lane::evidence);
        assertFalse(lane.hasHeadroom(30), "the forward floor view did not witness overhead air");
        var through = AgentSurfaceTread.retainedTreadSweep(SOURCE, to, 0.6);
        var back = AgentSurfaceTread.retainedTreadSweep(to, SOURCE, 0.6);
        assertEquals(through, back, "the nominal standing envelope is the same in both directions");
        assertTrue(downView.sweepClear(through));

        downView.blocks.put(to.up(), stone);
        assertNull(lane.changedWitness(downView), "the unseen head cell was not read as positive evidence");
        assertFalse(downView.sweepClear(through), "new overhead stone still collides with the standing sweep");
        downView.blocks.put(to.up(), Blocks.WATER.getDefaultState());
        assertFalse(downView.sweepClear(back), "new overhead water still fails the dry-column veto");

        var framed = new ForwardView(AgentBody.LEVEL_ROUTE_PITCH);
        lane.sample(framed, 31, 2, stone, 31);
        assertTrue(lane.hasHeadroom(31));
        framed.blocks.put(to.up(), stone);
        assertEquals(to.up(), lane.changedWitness(framed), "new overhead obstruction invalidates the lane");
    }

    @Test
    void aPhysicallyOpenLevelSweepCannotSubstituteForLitLowerPassageOrAVisibleFloor() {
        var to = SOURCE.east();
        var view = new ForwardView(52.6f);
        var lane = new AgentDryCaveRoute.Probe(SOURCE, to, Direction.EAST);
        var stone = Blocks.STONE.getDefaultState();
        var sweep = AgentSurfaceTread.retainedTreadSweep(SOURCE, to, 0.6);
        view.dark = to;
        lane.sample(view, 30, 1, stone, 30);
        assertTrue(view.sweepClear(sweep));
        assertFalse(lane.complete(30), "the lower clearance is not lit");

        view.dark = null;
        view.blocks.remove(to.down());
        lane.reset();
        lane.sample(view, 31, 2, stone, 31);
        assertTrue(view.sweepClear(sweep));
        assertFalse(lane.complete(31), "the standing sweep does not supply a floor");
    }

    @Test
    void aDropStillNeedsVisibleReverseTakeoffEvenWithTheLowerTreadInView() {
        var to = SOURCE.east().down();
        var step = new AgentDryCaveRoute.Probe(SOURCE, to, Direction.EAST);
        var stone = Blocks.STONE.getDefaultState();
        var floorView = new ForwardView(28f);
        floorView.blocks.remove(to);
        floorView.blocks.put(to.down(), stone);
        step.sample(floorView, 30, 1, stone, 30);
        assertEquals(stone, step.floorState(30), "the lower landing is genuinely visible");
        assertFalse(step.complete(30), "a level-walk sweep cannot substitute for a drop's reverse takeoff");

        var fullView = new ForwardView(20f);
        fullView.blocks.remove(to);
        fullView.blocks.put(to.down(), stone);
        step.sample(fullView, 31, 2, stone, 31);
        assertTrue(step.complete(31), step::evidence);
    }

    @Test
    void anOrdinaryLeafRiserNeedsItsActualFullTopAndTheExistingReverseJumpEnvelope() {
        var floor = SOURCE.east();
        var rise = floor.up();
        var stone = Blocks.STONE.getDefaultState();
        var leaves = Blocks.OAK_LEAVES.getDefaultState();
        var view = new ForwardView(35);
        view.blocks.put(floor, leaves);
        var side = view.firstTerrainHit(Vec3d.ofCenter(floor, 0.15));
        assertTrue(AgentSurfaceTread.ordinaryRiseSide(SOURCE, Direction.EAST, side));
        assertNull(AgentSurfaceTread.witnessedGradeEdge(SOURCE, stone, Direction.EAST, side, leaves, true));

        var top = view.firstTerrainHit(Vec3d.ofBottomCenter(rise).add(0.42, -0.025, 0));
        var crown = AgentSurfaceTread.reverseJumpHeadroom(rise, 0.6).stretch(-1, 0, 0);
        var edge = AgentSurfaceTread.witnessedGradeEdge(SOURCE, stone, Direction.EAST, top, leaves, view.sweepClear(crown));
        assertNotNull(edge);
        var tread = AgentSurfaceTread.ordinaryGrade(edge, SOURCE, 30);
        assertEquals(SOURCE, tread.from);
        assertEquals(rise, tread.to);
        assertTrue(tread.returning, "a rise uses the existing reverse-jump motor");
        view.blocks.put(rise.up(2), stone);
        assertNull(AgentSurfaceTread.witnessedGradeEdge(SOURCE, stone, Direction.EAST, top, leaves, view.sweepClear(crown)),
            "even a visible landing does not excuse a low ceiling");

        var downward = new ForwardView(43);
        downward.blocks.remove(floor.down());
        var oneLower = floor.down(2);
        downward.blocks.put(oneLower, stone);
        var lowerTop = downward.firstTerrainHit(Vec3d.ofBottomCenter(oneLower.up()).add(0.42, -0.025, 0));
        var descent = AgentSurfaceTread.witnessedGradeEdge(SOURCE, stone, Direction.EAST, lowerTop, stone, true);
        assertNotNull(descent);
        assertFalse(AgentSurfaceTread.ordinaryGrade(descent, SOURCE, 30).returning);

        downward.blocks.remove(oneLower);
        var floorTwoDown = floor.down(3);
        downward.blocks.put(floorTwoDown, stone);
        var deepTop = downward.firstTerrainHit(Vec3d.ofBottomCenter(floorTwoDown.up()).add(0.42, -0.025, 0));
        assertTrue(AgentBody.matchesDryRouteTop(deepTop, floorTwoDown));
        assertNull(AgentSurfaceTread.witnessedGradeEdge(SOURCE, stone, Direction.EAST, deepTop, stone, true));
        assertNull(AgentSurfaceTread.witnessedGradeEdge(SOURCE, stone, Direction.EAST, top,
            leaves.with(net.minecraft.state.property.Properties.WATERLOGGED, true), true));
    }

    @Test
    void offCenterProspectDepartureNeedsAFreshDryEdgeBeforeItCanBecomeAWalk() {
        var actual = Vec3d.ofBottomCenter(SOURCE).add(0, 0, -0.346);
        var centered = Vec3d.ofBottomCenter(SOURCE);
        var to = SOURCE.east();
        var view = new ForwardView();
        var route = new AgentMacroControl.DiamondRoute();
        var support = Blocks.STONE.getDefaultState();
        route.arrive(SOURCE, support, Direction.NORTH);
        assertFalse(AgentBody.drySurveyLaneCentered(SOURCE, actual.x, actual.z, Direction.EAST));
        assertTrue(AgentBody.sameSurveySupport(SOURCE.down(), actual));
        assertTrue(AgentBody.sameSurveySupport(SOURCE.down(), centered));
        assertTrue(AgentBody.drySurveyLaneCentered(SOURCE, centered.x, centered.z, Direction.EAST));

        var floor = new BlockHitResult(new Vec3d(2.4, 32, 0.5), Direction.UP, SOURCE.east(2).down(), false);
        assertTrue(route.beginDeparture(floor, 20));
        assertEquals(Direction.EAST, route.preferred);
        assertTrue(route.spine.isEmpty(), "a landmark or same-support adjustment is not a crossing");

        var probe = new AgentDryCaveRoute.Probe(SOURCE, to, Direction.EAST);
        view.blocks.put(to, Blocks.WATER.getDefaultState());
        probe.sample(view, 21, 1, support, 21);
        assertFalse(probe.complete(21), "a landmark beyond fluid does not make that lane walkable");
        route.arrive(SOURCE, support, Direction.NORTH);
        assertFalse(route.beginDeparture(floor, 22), "renewing an unproved departure cannot repeat its turn");
        view.blocks.put(to, Blocks.STONE.getDefaultState());
        probe.reset();
        probe.sample(view, 22, 2, support, 22);
        assertFalse(probe.complete(22), "the obstruction hides the intervening passage");
        view.blocks.remove(to);
        view.blocks.remove(to.down());
        probe.reset();
        probe.sample(view, 23, 3, support, 23);
        assertFalse(probe.complete(23), "clear space alone does not provide a landing");
        view.blocks.put(to.down(), support);
        probe.reset();
        probe.sample(view, 24, 4, support, 24);
        assertTrue(probe.complete(24), probe::evidence);
        var offer = new AgentDryCaveRoute.Offer(SOURCE, to, to, 1);
        assertEquals(Direction.EAST, route.naturalBearing(offer, cell -> false));

        var motion = new AgentWalkedRoute.Motion();
        motion.start(centered.x, centered.y, centered.z);
        for (double x : new double[]{0.75, 1.0, 1.25, 1.5})
            assertTrue(motion.observe(x, centered.y, centered.z));
        assertTrue(motion.traversed());
        route.advance(new AgentSurfaceTread.Edge(SOURCE, support, to, support, Direction.EAST));
        assertEquals(to, route.foot);
        assertEquals(1, route.spine.size());
        route.returnOne();
        route.arrive(SOURCE, support, Direction.NORTH);
        assertFalse(route.beginDeparture(floor, 25), "returning to the root does not replay the preparation");
    }

    @Test
    void adjacentRockHeadIsAVisibleCutCellEvenWhileTheLaneIsBlocked() {
        var stone = Blocks.STONE.getDefaultState();
        var next = SOURCE.east();
        var head = next.up();
        var point = Vec3d.ofCenter(head);
        assertFalse(new ForwardView(75).visible(point), "knowing the wall exists does not put it in the camera");

        var view = new ForwardView();
        view.blocks.put(next, stone);
        view.blocks.put(head, stone);
        assertTrue(view.visible(point));
        assertEquals(head, view.firstHit(point));
        assertEquals(Direction.EAST, AgentSurfaceTread.prospectLevelBearing(SOURCE, head));
        assertEquals(Direction.EAST, AgentSurfaceTread.prospectLevelBearing(SOURCE, next));
        assertNull(AgentSurfaceTread.prospectLevelBearing(SOURCE, next.down()), "never use the unseen floor as the clue");
        assertNull(AgentSurfaceTread.prospectLevelBearing(SOURCE, next.up(2)), "the ceiling is not a first cut");
        assertNull(AgentSurfaceTread.prospectLevelBearing(SOURCE, head.east()), "do not search behind the first hit");
        var probe = new AgentDryCaveRoute.Probe(SOURCE, next, Direction.EAST);
        probe.sample(view, 30, 1, stone, 30);
        assertFalse(probe.complete(30), "seeing a wall supplies no walkable lane");
    }

    @Test
    void aRenderedCornerHasItsOwnBoundedWallRechecksWithoutTreatingSamplesAsProof() {
        var eye = Vec3d.ofBottomCenter(SOURCE).add(0, 1.62, 0);
        var west = new BlockHitResult(eye.add(-0.5, -0.18, -0.47), Direction.EAST, SOURCE.west().up(), false);
        var north = new BlockHitResult(eye.add(-0.45, -0.18, -0.5), Direction.SOUTH, SOURCE.north().up(), false);
        var fluid = new BlockHitResult(eye.add(-0.20, -0.07, -0.19), Direction.EAST, SOURCE.up(), false);
        var sampled = new BlockHitResult[] {west, north};
        var offered = new AgentBody.LevelWallSight(point -> true,
            end -> end.x < SOURCE.getX() ? fluid : north, hit -> true, hit -> Blocks.DEEPSLATE.getDefaultState());
        offered.observePose(eye, 132, -89);
        int shared = 8;
        shared -= offered.reserve(shared);
        assertEquals(0, shared, "ordinary offers have no general rays left at the wall consumer");
        assertEquals(north, offered.find(SOURCE, 1, 25, 4.5, eye, west, sampled, sampled.length, (hit, state) -> hit),
            "a different first hit vetoes the dry crosshair ray; an exact wall from the same frame can still qualify");
        assertEquals(6, offered.raysLeft(), "duplicate hits on the crosshair cell do not spend another ray");

        assertNull(offered.find(SOURCE, 1, 25, 4.5, eye, north, sampled, sampled.length, (hit, state) -> null),
            "a rendered, fluid-opaque face still cannot override the work consumer's safety veto");
        assertEquals(4, offered.release(), "the remainder goes back to the general pool");
        var unlit = new AgentBody.LevelWallSight(point -> true, end -> north, hit -> false,
            hit -> Blocks.DEEPSLATE.getDefaultState());
        unlit.observePose(eye, 132, -89);
        unlit.reserve(8);
        assertNull(unlit.find(SOURCE, 1, 25, 4.5, eye, north, sampled, sampled.length, (hit, state) -> hit),
            "a vanilla outline alone does not make a dark face eligible");
    }

    @Test
    void alternatingCornerSamplesKeepOnlyOneCurrentOpticallyRecheckedWall() {
        var eye = Vec3d.ofBottomCenter(SOURCE).add(0, 1.62, 0);
        var cell = SOURCE.west().up();
        var hit = new BlockHitResult(eye.add(-0.5, 0.18, -0.47), Direction.EAST, cell, false);
        var live = new BlockHitResult(hit.getPos(), Direction.EAST, cell, false);
        var sampled = new BlockHitResult[] {hit};
        var currentHit = new BlockHitResult[] {live};
        var currentState = new BlockState[] {Blocks.DEEPSLATE.getDefaultState()};
        var sight = new AgentBody.LevelWallSight(point -> true, point -> currentHit[0], face -> true,
            face -> currentState[0]);

        sight.observePose(eye, 132, -89);
        sight.reserve(8);
        assertEquals(live, sight.find(SOURCE, 1, 25, 4.5, eye, null, sampled, 1, (face, state) -> face));
        sight.release();
        sight.observePose(eye, 132, -89);
        sight.reserve(8);
        assertEquals(live, sight.find(SOURCE, 1, 30, 4.5, eye, null, sampled, 0, (face, state) -> face),
            "the next grid phase contributes no candidate, but the same wall is still actually in view");
        assertTrue(sight.usedRetainedWitness());
        assertEquals(1, sight.rechecks());
        assertNull(sight.find(SOURCE, 1, 35, 4.5, eye, null, sampled, 0, (face, state) -> null),
            "the consumer's current refusal still vetoes an optically rechecked face");
        assertNull(sight.find(SOURCE, 1, 40, 4.5, eye, null, sampled, 0, (face, state) -> face));
        assertEquals(0, sight.rechecks(), "a refused witness is not retried from memory");

        assertEquals(live, sight.find(SOURCE, 1, 45, 4.5, eye, null, sampled, 1, (face, state) -> face));
        currentState[0] = Blocks.STONE.getDefaultState();
        assertNull(sight.find(SOURCE, 1, 50, 4.5, eye, null, sampled, 0, (face, state) -> face),
            "a different state on the same face is not admitted from memory");
        assertEquals(live, sight.find(SOURCE, 1, 65, 4.5, eye, null, sampled, 1, (face, state) -> face));
        sight.observePose(eye, 133, -89);
        sight.observePose(eye, 132, -89);
        assertNull(sight.find(SOURCE, 1, 70, 4.5, eye, null, sampled, 0, (face, state) -> face),
            "turning away and then back invalidates the retained aim point");

        assertEquals(live, sight.find(SOURCE, 1, 85, 4.5, eye, null, sampled, 1, (face, state) -> face));
        sight.release();
        sight.reserve(8);
        assertNull(sight.find(SOURCE, 2, 90, 4.5, eye, null, sampled, 0, (face, state) -> face),
            "a new stance does not inherit the witness");
        assertEquals(live, sight.find(SOURCE, 2, 95, 4.5, eye, null, sampled, 1, (face, state) -> face));
        currentHit[0] = new BlockHitResult(hit.getPos(), Direction.SOUTH, cell, false);
        assertNull(sight.find(SOURCE, 2, 100, 4.5, eye, null, sampled, 0, (face, state) -> face),
            "the first hit must still be on the exact remembered face");

        currentHit[0] = live;
        assertEquals(live, sight.find(SOURCE, 2, 105, 4.5, eye, null, sampled, 1, (face, state) -> face));
        assertNull(sight.find(SOURCE, 2, 125, 4.5, eye, null, sampled, 0, (face, state) -> face),
            "a long gap in current evidence expires even a stationary witness");
        assertEquals(0, sight.rechecks());
    }

    @Test
    void paidTunnelKeepsCuttingForwardThroughThreeOpenedTreadsThenStopsAtVisibleFluid() {
        var stone = Blocks.STONE.getDefaultState();
        var budget = new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false,
            new AgentWorkOrder.Target(Items.DIAMOND, 1, null),
            Set.of("prospect:minecraft:diamond", "break:minecraft:stone", "break:minecraft:diamond_ore"),
            Map.of(), Map.of(), 8, 0, 0));
        var route = new AgentMacroControl.DiamondRoute();
        var entry = new AgentSurfaceTread.Edge(SOURCE.west(), stone, SOURCE, stone, Direction.EAST);
        route.arrive(entry.upper(), stone, Direction.EAST);
        route.advance(entry);
        route.select(Direction.EAST, 0, true);

        for (int i = 0; i < 3; i++) {
            var from = SOURCE.east(i);
            var to = from.east();
            var view = new ForwardView(from, AgentBody.LEVEL_ROUTE_PITCH);
            view.blocks.put(to, stone);
            view.blocks.put(to.up(), stone);
            var probe = new AgentDryCaveRoute.Probe(from, to, Direction.EAST);
            probe.sample(view, 30, 1, stone, 30);
            assertFalse(probe.complete(30), "the wall is a cut candidate, not permission to walk");
            for (var cover : new BlockPos[]{to.up(), to}) {
                assertEquals(cover, view.firstHit(Vec3d.ofCenter(cover)));
                assertTrue(view.visible(Vec3d.ofCenter(cover)));
                assertTrue(route.cutCell(cover));
                assertFalse(route.cutCell(from.down()));
                assertFalse(route.cutCell(to.down()), "a level heading does not cut its prospective support");
                assertTrue(budget.policy.prospectCoverAllowed(view.state(cover)) && budget.canCutCover());
                view.blocks.remove(cover);
                budget.broken(Items.IRON_PICKAXE, 0);
                route.coverOpened();
                assertEquals(from, route.foot, "a break receipt is not a landing");
            }
            probe.reset();
            probe.sample(view, 31, 2, stone, 31);
            assertTrue(probe.complete(31), probe::evidence);
            var motion = new AgentWalkedRoute.Motion();
            Vec3d start = Vec3d.ofBottomCenter(from);
            motion.start(start.x, start.y, start.z);
            for (int quarter = 1; quarter <= 4; quarter++)
                assertTrue(motion.observe(start.x + quarter * 0.25, start.y, start.z));
            assertTrue(motion.traversed());
            route.advance(new AgentSurfaceTread.Edge(from, stone, to, probe.floorState(31), Direction.EAST));
            assertEquals(to, route.foot);
            assertEquals(Direction.EAST, route.bearing);
            assertEquals(0, route.grade);
            assertTrue(route.tunnel && route.cutting, "the next wall inherits the actual paid heading");
            assertFalse(route.glanced, "an aligned landing needs no new sector survey");
        }

        var last = SOURCE.east(3);
        var next = last.east();
        var view = new ForwardView(last, AgentBody.LEVEL_ROUTE_PITCH);
        view.blocks.put(next, stone);
        view.blocks.put(next.up(), Blocks.WATER.getDefaultState());
        var floor = view.top(Vec3d.ofBottomCenter(next).add(0.28, -0.032, 0), next.down());
        var chest = view.space(Vec3d.ofBottomCenter(next).add(0.07, 1.32, 0));
        var head = view.space(Vec3d.ofBottomCenter(next).add(-0.23, 1.55, 0));
        assertTrue(AgentMacroControl.diamondPassageFluid(floor, chest, head));
        route.refuseCurrent("Visible fluid vetoed the selected landing or its passage.");
        assertFalse(route.tunnel || route.cutting);
        assertFalse(route.cutCell(next), "the next visible stone cannot override the fluid veto");
        assertEquals(last, route.foot);
        assertEquals(2, budget.breaksLeft(), "the hazard spends no break or forward step");
        assertEquals(4, route.spine.size());
        for (int i = 3; i >= 0; --i) {
            route.returnOne();
            assertEquals(SOURCE.east(i).west(), route.foot, "retain every exact reverse edge back to the entry");
        }
    }

    @Test
    void aFreshDiamondLegCanResampleTheWallRetiredByTheOreBreakReserve() {
        var deepslate = Blocks.DEEPSLATE.getDefaultState();
        var original = diamondOrder("original", 2083, 3188, 7, 3);
        var renewed = diamondOrder("renewed", 2480, 3500, 7, 3);
        var replacement = diamondOrder("replacement", 2503, 3528, 6, 2);
        assertTrue(AgentMacroControl.canRenewWork(original, original, renewed));
        assertFalse(AgentMacroControl.canRenewWork(renewed, renewed, replacement));
        var spent = new AgentWorkOrder.Budget(original.policy());
        for (int i = 0; i < 47; i++) spent.broken(Items.IRON_PICKAXE, 0);
        spent.placedProspectTorch();

        var route = new AgentMacroControl.DiamondRoute();
        var entry = new AgentSurfaceTread.Edge(SOURCE.west(), deepslate, SOURCE, deepslate, Direction.EAST);
        route.arrive(entry.upper(), deepslate, Direction.EAST);
        route.advance(entry);
        route.refuse(Direction.NORTH, 0, "Visible fluid vetoed the selected level passage.");
        route.refuse(Direction.EAST, -1, "No dry reverse edge remains for the descent.");
        var wall = SOURCE.east().up();
        var view = new ForwardView();
        view.blocks.put(wall, deepslate);
        assertEquals(wall, view.firstTerrainHit(Vec3d.ofCenter(wall)).getBlockPos());
        route.select(Direction.EAST, 0, true);
        assertTrue(route.cutGrantRefusal(spent, wall, deepslate).contains("Keep the last break"));
        assertFalse(route.open(Direction.EAST, 0));
        var inventory = new PlayerInventory(null);
        assertFalse(route.needsGrantRecheck(spent), "a compatible renewal owns the same spent budget");
        route.recheckGrant(spent, view::state, inventory);
        assertEquals(1, spent.breaksLeft());
        assertEquals(6, spent.placementsLeft());
        assertFalse(route.open(Direction.EAST, 0));
        assertTrue(route.grantRefusalDetail().contains("Keep the last break"));

        var side = new AgentSurfaceTread.Edge(SOURCE, deepslate, SOURCE.south(), deepslate, Direction.SOUTH);
        route.advance(side);
        route.returnOne();
        assertFalse(route.open(Direction.EAST, 0), "the refusal belongs to the exact retained intersection");
        var oreOnly = new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false, replacement.policy().target(),
            Set.of("prospect:minecraft:diamond", "break:minecraft:deepslate_diamond_ore"), Map.of(), Map.of(), 48, 0, 0));
        route.recheckGrant(oreOnly, view::state, inventory);
        assertFalse(route.open(Direction.EAST, 0), "48 breaks do not authorize an unlisted block");
        assertTrue(route.grantRefusalDetail().contains("does not allow clearing"));
        assertFalse(route.grantRefusalDetail().contains("Keep the last break"));

        var fresh = new AgentWorkOrder.Budget(replacement.policy());
        route.arrive(SOURCE, deepslate, Direction.NORTH);
        route.recheckGrant(fresh, view::state, inventory);
        assertTrue(route.open(Direction.EAST, 0));
        assertFalse(route.open(Direction.NORTH, 0), "the new grant cannot cure visible fluid");
        assertFalse(route.open(Direction.EAST, -1), "a level recheck does not reopen the refused descent");
        assertEquals(1, route.spine.size());
        assertTrue(route.grantRefusalDetail().isEmpty(), "a terminal report cannot still cite the spent break reserve");
        assertFalse(route.cutCell(wall), "reopening an option is not permission to swing");
        var current = view.firstTerrainHit(Vec3d.ofCenter(wall));
        assertNotNull(current, "the next leg must witness the wall again");
        route.select(Direction.EAST, 0, true);
        assertTrue(route.cutCell(current.getBlockPos()));
        assertNull(route.cutGrantRefusal(fresh, current.getBlockPos(), view.state(current.getBlockPos())));
        assertEquals(48, fresh.breaksLeft(), "neither repricing nor selecting the face spends a break");
        route.returnOne();
        assertEquals(entry.upper(), route.foot, "the originally walked return remains available");
    }

    @Test
    void aNewGrantRechecksExactCoverAndPlacementPriceWithoutErasingChangedTerrain() {
        var deepslate = Blocks.DEEPSLATE.getDefaultState();
        var cover = SOURCE.east().up();
        var fill = SOURCE.south().down();
        var air = Blocks.AIR.getDefaultState();
        var route = new AgentMacroControl.DiamondRoute();
        var view = new ForwardView();
        view.blocks.put(cover, deepslate);
        var inventory = new PlayerInventory(null);
        inventory.setStack(0, new ItemStack(Items.COBBLESTONE, 2));
        var targets = new AgentWorkOrder.Target(Items.DIAMOND, 1, null);
        var effects = Set.of("prospect:minecraft:diamond", "break:minecraft:deepslate_diamond_ore", "place:minecraft:cobblestone");
        var noCover = new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false, targets, effects,
            Map.of(Items.COBBLESTONE, 1), Map.of(), 48, 0, 2));
        noCover.placedProspectSupport();
        route.arrive(SOURCE, deepslate, Direction.EAST);
        route.select(Direction.EAST, 0, true);
        assertTrue(route.cutGrantRefusal(noCover, cover, deepslate).contains("does not allow clearing"));
        route.select(Direction.SOUTH, 0, true);
        assertNotNull(route.placeGrantRefusal(noCover, fill, air, Items.COBBLESTONE, inventory));

        var materialButNotCost = new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false, targets,
            Set.of("prospect:minecraft:diamond", "break:minecraft:deepslate_diamond_ore", "break:minecraft:deepslate",
                "place:minecraft:cobblestone", "place:minecraft:torch"),
            Map.of(Items.TORCH, 1), Map.of(), 48, 0, 2));
        view.blocks.put(cover, Blocks.LAVA.getDefaultState());
        route.recheckGrant(materialButNotCost, view::state, inventory);
        assertFalse(route.open(Direction.EAST, 0), "the previously witnessed wall changed");
        assertFalse(route.open(Direction.SOUTH, 0), "a torch cost and spare placements do not pay for cobblestone");

        var priced = new AgentWorkOrder.Budget(diamondOrder("priced", 2503, 3528, 6, 2).policy());
        route.recheckGrant(priced, view::state, inventory);
        assertFalse(route.open(Direction.EAST, 0), "a changed wall is not reopened even by a grant for both effects");
        assertTrue(route.open(Direction.SOUTH, 0), "the exact cobblestone cost and count now fit");
        assertEquals(6, priced.placementsLeft(), "no placement was issued");
    }

    private static AgentWorkOrder diamondOrder(String id, long basis, long expires, int placements, int torchCost) {
        var policy = new AgentWorkOrder.Policy(false, new AgentWorkOrder.Target(Items.DIAMOND, 1, null),
            Set.of("prospect:minecraft:diamond", "break:minecraft:deepslate_diamond_ore", "break:minecraft:deepslate",
                "place:minecraft:cobblestone", "place:minecraft:torch"),
            Map.of(Items.COBBLESTONE, 4, Items.TORCH, torchCost), Map.of(Items.IRON_PICKAXE, 1), 48, 0, placements);
        return new AgentWorkOrder(id, 1, 20, basis, expires, 2, policy, null, null, null, null, null);
    }

    @Test
    void paidHighTunnelDescendsTwoSolidColumnsOnlyAfterEachFloorBreakThenStopsOverFluid() {
        var stone = Blocks.STONE.getDefaultState();
        var granite = Blocks.GRANITE.getDefaultState();
        var budget = new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false,
            new AgentWorkOrder.Target(Items.DIAMOND, 1, null),
            Set.of("prospect:minecraft:diamond", "break:minecraft:stone", "break:minecraft:granite", "break:minecraft:diamond_ore"),
            Map.of(), Map.of(), 13, 0, 0));
        var oreOnly = new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false,
            new AgentWorkOrder.Target(Items.DIAMOND, 1, null),
            Set.of("prospect:minecraft:diamond", "break:minecraft:diamond_ore"), Map.of(), Map.of(), 13, 0, 0));
        var route = new AgentMacroControl.DiamondRoute();
        var east = Direction.EAST;
        var entry = new AgentSurfaceTread.Edge(SOURCE.west(), stone, SOURCE, stone, east);
        route.arrive(entry.upper(), stone, east);
        route.advance(entry);
        route.select(east, 0, true);
        Map<BlockPos, BlockState> terrain = new HashMap<>();
        terrain.put(entry.upper().down(), stone);
        terrain.put(SOURCE.down(), stone);
        for (int i = 1; i <= 3; ++i) {
            var lower = SOURCE.east(i).down(i);
            for (int y = -1; y <= 3; ++y) terrain.put(lower.up(y), stone);
        }
        for (int i = 0; i < 3; ++i) {
            var from = SOURCE.east(i).down(i);
            var next = from.east();
            var lower = next.down();
            var view = new ForwardView(from, 34);
            view.blocks.clear();
            view.blocks.putAll(terrain);
            var upperTop = Vec3d.ofBottomCenter(next).add(0.28, -0.032, 0);
            var lowerTop = upperTop.add(0, -1, 0);
            assertEquals(from, route.foot);
            assertEquals(east, route.bearing);
            assertEquals(0, route.grade, "the next column starts by cutting only visible wall and head cells");
            assertEquals(AgentBody.DryRouteTop.OCCLUDED, view.top(lowerTop, lower.down()));
            assertFalse(route.cutCell(lower));
            for (var wall : new BlockPos[]{next.up(), next}) {
                assertTrue(view.visible(Vec3d.ofCenter(wall)));
                assertEquals(wall, view.firstHit(Vec3d.ofCenter(wall)));
                assertTrue(route.cutCell(wall) && budget.policy.prospectCoverAllowed(view.state(wall)));
                view.blocks.remove(wall);
                budget.broken(Items.IRON_PICKAXE, 0);
                route.coverOpened();
            }

            assertTrue(route.wantsForwardStair(false));
            assertFalse(route.wantsForwardStair(true), "a visible iron or diamond lead keeps the lateral passage");
            assertEquals(AgentBody.DryRouteTop.WITNESSED, view.top(upperTop, lower));
            assertEquals(AgentBody.DryRouteTop.OCCLUDED, view.top(lowerTop, lower.down()));
            route.levelFloorStates = new BlockState[Direction.values().length];
            route.levelFloorStates[east.ordinal()] = view.state(lower);
            assertFalse(route.spareFloorCoverCurrent(east, stone, oreOnly), "the prospect effect does not grant cover");
            view.blocks.put(lower, granite);
            assertFalse(route.spareFloorCoverCurrent(east, view.state(lower), budget),
                "even another permitted material cannot stand in for the exact witnessed floor");
            view.blocks.put(lower, stone);
            assertTrue(route.spareFloorCoverCurrent(east, view.state(lower), budget));

            var crown = AgentSurfaceTread.reverseJumpHeadroom(from, 0.6).stretch(1, 0, 0);
            assertFalse(view.sweepClear(crown), "the level opening alone is too short for the reverse jump");
            var lintel = next.up(2);
            var lintelView = new ForwardView(from, -20);
            lintelView.blocks.clear();
            lintelView.blocks.putAll(view.blocks);
            var lintelPoint = Vec3d.ofCenter(lintel, 0.07);
            assertTrue(lintelView.visible(lintelPoint));
            assertEquals(lintel, lintelView.firstHit(lintelPoint));
            route.stairLip = true;
            assertTrue(route.cutCell(lintel));
            assertFalse(route.cutCell(from.up(2)), "only the forward lintel is in scope");
            assertFalse(route.cutCell(from.down()));
            assertFalse(route.cutCell(entry.upper().down()));
            view.blocks.remove(lintel);
            budget.broken(Items.IRON_PICKAXE, 0);
            route.coverOpened();
            assertTrue(view.sweepClear(crown));
            route.selectSpareFloor(east, null);
            assertTrue(route.cutCell(lower));
            assertFalse(route.cutCell(lower.down()), "the undiscovered lower support is never a cover target");
            assertFalse(route.witnessedGradeTread(view.top(lowerTop, lower.down()), true, true));

            view.blocks.remove(lower);
            route.attemptedSpareFloors.add(lower);
            budget.broken(Items.IRON_PICKAXE, 0);
            route.coverOpened();
            assertFalse(route.cutCell(lower));
            assertEquals(from, route.foot, "the break receipt cannot attest movement");
            if (i == 2) view.blocks.put(lower, Blocks.WATER.getDefaultState()
                .with(net.minecraft.block.FluidBlock.LEVEL, 3));
            var floor = view.top(lowerTop, lower.down());
            var chest = view.space(Vec3d.ofBottomCenter(lower).add(0.07, 1.32, 0));
            var head = view.space(Vec3d.ofBottomCenter(lower).add(-0.23, 2.55, 0));
            boolean passage = chest == AgentBody.DryRouteSample.CLEAR && head == AgentBody.DryRouteSample.CLEAR;
            boolean reverse = view.sweepClear(crown)
                && view.sweepClear(AgentSurfaceTread.retainedTreadSweep(from, lower, 0.6));
            if (i == 2) {
                assertTrue(AgentMacroControl.diamondPassageFluid(floor, chest, head));
                assertFalse(route.witnessedGradeTread(floor, passage, reverse));
                route.refuseCurrent("Visible fluid");
                assertFalse(route.open(east, 0), "do not bridge or walk into the rejected cut");
                continue;
            }
            assertFalse(route.witnessedGradeTread(floor, passage, false), "visible feet do not replace the reverse guard");
            assertTrue(route.witnessedGradeTread(floor, passage, reverse));
            var motion = new AgentWalkedRoute.Motion();
            Vec3d start = Vec3d.ofBottomCenter(from);
            motion.start(start.x, start.y, start.z);
            for (int quarter = 1; quarter <= 4; ++quarter)
                assertTrue(motion.observe(start.x + quarter * 0.25, start.y - quarter * 0.25, start.z));
            assertTrue(motion.traversed());
            route.advance(new AgentSurfaceTread.Edge(from, stone, lower, view.state(lower.down()), east));
            assertEquals(lower, route.foot);
            assertEquals(31 - i, route.foot.getY());
            assertFalse(route.glanced, "the achieved heading does not survey a new sector");
            terrain = view.blocks;
        }
        assertEquals(SOURCE.east(2).down(2), route.foot);
        assertEquals(3, route.spine.size(), "entry and both actually grounded descents remain reversible");
        assertEquals(1, budget.breaksLeft(), "only observed cover receipts charged; the ore break remains");
    }

    @Test
    void aCutThatTouchesTheStandingMarginGetsOnlyOneSameFootingInset() {
        var stone = Blocks.STONE.getDefaultState();
        var route = new AgentMacroControl.DiamondRoute();
        route.arrive(SOURCE, stone, Direction.EAST);
        route.select(Direction.EAST, 0, true);
        BlockPos wall = SOURCE.east().up();
        // Relative positions from the failed run's first held head-block swing and
        // subsequent neutral coast. The body remains on the exact same support.
        var box = new Box(0.269074, 32, 0.223, 0.869074, 33.8, 0.823);
        assertFalse(AgentMacroControl.diamondCutOverlaps(box, wall));
        assertTrue(AgentMacroControl.diamondCutOverlaps(box.offset(0.033661, 0, 0), wall));
        assertTrue(route.cutInsetCurrent(2108));
        assertTrue(route.cutInsetCurrent(2109));
        route.arrive(SOURCE, stone, Direction.NORTH);
        assertFalse(route.cutInsetCurrent(2116), "same-footing policy renewal cannot restart the correction");
        assertFalse(AgentMacroControl.diamondCutOverlaps(box.offset(-0.07, 0, 0), wall));
        assertEquals(Direction.EAST, route.bearing);
    }

    @Test
    void aPaidDescentKeepsItsGradeButCanYieldToANewPairedDownwardLane() {
        var stone = Blocks.STONE.getDefaultState();
        var route = new AgentMacroControl.DiamondRoute();
        route.arrive(SOURCE, stone, Direction.EAST);
        route.select(Direction.EAST, -1, true);
        var lower = SOURCE.east().down();
        route.coverOpened();
        route.advance(new AgentSurfaceTread.Edge(SOURCE, stone, lower, stone, Direction.EAST));
        assertEquals(-1, route.grade);
        assertTrue(route.cutting);
        assertTrue(route.cutCell(lower.east()));
        assertFalse(route.cutCell(SOURCE.down()));
        var north = lower.north().down();
        assertEquals(Direction.NORTH,
            route.naturalBearing(new AgentDryCaveRoute.Offer(lower, north, north, 1), support -> false));
        var side = lower.north();
        assertNull(route.naturalBearing(new AgentDryCaveRoute.Offer(lower, side, side, 1), support -> false),
            "a level side branch does not replace actual paid forward work");
    }

    @Test
    void theSameFrameCannotRefreshExpiredRaysOrInventReverseFooting() {
        var view = new ForwardView();
        var probe = new AgentDryCaveRoute.Probe(SOURCE, SOURCE.east(), Direction.EAST);
        probe.sample(view, 20, 1, null, 0);
        assertFalse(probe.complete(20), "landing rays are not evidence for the source footing");
        var source = Blocks.STONE.getDefaultState();
        probe.sample(view, 20, 1, source, 20);
        assertTrue(probe.complete(20), "actual source contact is independent of the camera");
        probe.sample(view, 80, 1, source, 80);
        assertFalse(probe.complete(80), "the old render cannot refresh the strip");
    }

    @Test
    void aRecentlyWitnessedReturnBecomesInvalidWhenTheSweepChanges() {
        var view = new ForwardView();
        var to = SOURCE.east();
        var probe = new AgentDryCaveRoute.Probe(SOURCE, to, Direction.EAST);
        probe.sample(view, 20, 1, Blocks.STONE.getDefaultState(), 20);
        assertTrue(probe.complete(21));
        assertFalse(probe.complete(80), "remembered rays expire without new positive evidence");

        view.blocks.put(to, Blocks.LAVA.getDefaultState());
        assertEquals(to, probe.changedWitness(view));
        probe.reset();
        probe.sample(view, 21, 2, Blocks.STONE.getDefaultState(), 21);
        assertFalse(probe.complete(21), "new visible fluid never revives the previous pair");
    }

    /** A fixed 70° vertical render frustum and first-hit dry terrain geometry. */
    private static final class ForwardView implements AgentDryCaveRoute.ProbeView {
        private final Map<BlockPos, BlockState> blocks = new HashMap<>();
        private final Vec3d eye;
        private final Vector4f clip = new Vector4f();
        private final Matrix4f projection;
        private BlockPos dark;

        ForwardView() {
            this(AgentBody.LEVEL_ROUTE_PITCH);
        }

        ForwardView(float pitch) {
            this(SOURCE, pitch);
        }

        ForwardView(BlockPos foot, float pitch) {
            eye = Vec3d.ofBottomCenter(foot).add(0, 1.62, 0);
            projection = new Matrix4f().perspective((float) Math.toRadians(70), 16f / 9, 0.05f, 32)
                .lookAlong(1, (float) -Math.tan(Math.toRadians(pitch)), 0, 0, 1, 0);
            for (int i = 0; i <= 4; i++) blocks.put(SOURCE.east(i).down(), Blocks.STONE.getDefaultState());
        }

        @Override public AgentBody.DryRouteTop top(Vec3d point, BlockPos support) {
            if (!visible(point)) return AgentBody.DryRouteTop.OUT_OF_VIEW;
            BlockPos hit = firstHit(point);
            if (hit == null) return AgentBody.DryRouteTop.NO_FULL_TOP;
            if (!state(hit).getFluidState().isEmpty()) return AgentBody.DryRouteTop.FLUID;
            return hit.equals(support) && point.y > support.getY() + 0.95
                ? AgentBody.DryRouteTop.WITNESSED : AgentBody.DryRouteTop.OCCLUDED;
        }

        @Override public AgentBody.DryRouteSample space(Vec3d point) {
            if (!visible(point)) return AgentBody.DryRouteSample.UNKNOWN;
            BlockPos hit = firstHit(point);
            if (hit == null) return BlockPos.ofFloored(point).equals(dark)
                ? AgentBody.DryRouteSample.DARK : AgentBody.DryRouteSample.CLEAR;
            if (!state(hit).getFluidState().isEmpty()) return AgentBody.DryRouteSample.FLUID;
            return hit.equals(BlockPos.ofFloored(point)) ? AgentBody.DryRouteSample.OBSTRUCTION
                : AgentBody.DryRouteSample.UNKNOWN;
        }

        @Override public BlockState state(BlockPos pos) {
            return blocks.getOrDefault(pos, Blocks.AIR.getDefaultState());
        }

        private boolean sweepClear(Box sweep) {
            for (var entry : blocks.entrySet()) {
                if (!sweep.intersects(new Box(entry.getKey()))) continue;
                BlockState block = entry.getValue();
                if (AgentBody.dryCaveDanger(block) || block.isOf(Blocks.STONE)) return false;
            }
            return true;
        }

        private boolean visible(Vec3d point) {
            Vec3d offset = point.subtract(eye);
            projection.transform(clip.set((float) offset.x, (float) offset.y, (float) offset.z, 1));
            return clip.w > 0 && Math.abs(clip.x) <= clip.w && Math.abs(clip.y) <= clip.w && Math.abs(clip.z) <= clip.w;
        }

        private BlockPos firstHit(Vec3d point) {
            BlockPos nearest = null;
            double best = Double.POSITIVE_INFINITY;
            for (BlockPos pos : blocks.keySet()) {
                var hit = new Box(pos).raycast(eye, point);
                if (hit.isEmpty()) continue;
                double distance = hit.get().squaredDistanceTo(eye);
                if (distance < best) {
                    best = distance;
                    nearest = pos;
                }
            }
            return nearest;
        }

        private BlockHitResult firstTerrainHit(Vec3d point) {
            if (!visible(point)) return null;
            BlockPos cell = firstHit(point);
            if (cell == null) return null;
            Vec3d hit = new Box(cell).raycast(eye, point).orElseThrow();
            if (!visible(hit)) return null;
            Direction side = Math.abs(hit.y - cell.getY() - 1) < 1e-5 ? Direction.UP : Direction.WEST;
            return new BlockHitResult(hit, side, cell, false);
        }
    }
}
