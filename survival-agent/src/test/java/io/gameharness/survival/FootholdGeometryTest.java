package io.gameharness.survival;

import com.google.gson.JsonParser;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.block.Blocks;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.EmptyBlockView;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class FootholdGeometryTest {
    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
    }

    @Test
    void ordinarySourceBearingCanSelectLowerAndUpperPairedShelvesButNotAFalseApproach() {
        var from = new BlockPos(0, 30, 0);
        var lowerOre = new BlockHitResult(new Vec3d(3, 29.5, 0.5), Direction.WEST, new BlockPos(3, 29, 0), false);
        var upperOre = new BlockHitResult(new Vec3d(3, 31.5, 0.5), Direction.WEST, new BlockPos(3, 31, 0), false);
        assertTrue(AgentMacroControl.routeTowardSource(from, from.east().down(), lowerOre));
        assertTrue(AgentMacroControl.routeTowardSource(from, from.east().up(), upperOre));
        assertFalse(AgentMacroControl.routeTowardSource(from, from.east().up(), lowerOre),
            "a route above the lower source does not solve ordinary safe harvest geometry");
        assertFalse(AgentMacroControl.routeTowardSource(from, from.west().up(), upperOre),
            "a real route heading away is not a witnessed approach toward this source");
        assertFalse(AgentMacroControl.routeTowardSource(from, from, upperOre),
            "a same-block camera adjustment is not travel");
    }

    @Test
    void witnessedDryOpeningBeatsAnUpperWaterCueWithoutAuthorizingTravel() {
        var foot = new BlockPos(0, 32, 0);
        var opening = new BlockHitResult(new Vec3d(3.3, 32, 0.6), Direction.UP, new BlockPos(3, 31, 0), false);
        var upperWater = new BlockHitResult(new Vec3d(0.5, 33.6, -1.2), Direction.SOUTH, new BlockPos(0, 33, -2), false);
        var dry = new AgentMacroControl.FurnaceLook(AgentMacroControl.FurnaceCue.OPENING, opening);
        var water = new AgentMacroControl.FurnaceLook(AgentMacroControl.FurnaceCue.WATER, upperWater);
        assertEquals(dry, AgentMacroControl.FurnaceLook.prefer(water, dry));
        assertEquals(dry, AgentMacroControl.FurnaceLook.prefer(dry, water));
        assertEquals(38.0f, dry.lookPitch(new Vec3d(0.5, 33.62, 0.5)));
        assertFalse(AgentBody.drySurveyLaneCentered(foot, 0.88, 0.5, Direction.EAST),
            "the distant ground landmark supplies a bearing, not a departure or an adjacent landing");
    }

    @Test
    void offCenterStanceVetoesCrossingButAllowsSameSupportPositioning() {
        var foot = new BlockPos(-275, 32, -572);
        var actual = new Vec3d(-274.846, 32, -571.477); // 0.346 blocks off center in the workshop.
        var center = Vec3d.ofBottomCenter(foot);
        assertTrue(AgentBody.sameSurveySupport(foot.down(), actual));
        for (Direction bearing : Direction.Type.HORIZONTAL) {
            assertFalse(AgentBody.drySurveyLaneCentered(foot, actual.x, actual.z, bearing),
                "no cave edge may leave this stance before local setup");
            assertTrue(AgentBody.drySurveyLaneCentered(foot, center.x, center.z, bearing));
            assertFalse(AgentBody.sameSurveySupport(foot.down(), center.add(
                bearing.getOffsetX() * 0.51, 0, bearing.getOffsetZ() * 0.51)),
                "same-block positioning cannot follow the body onto the next tile");
        }
        assertFalse(AgentBody.sameSurveySupport(foot.down(), actual.add(0, -0.5, 0)));
    }

    @Test
    void canFinishSettlingOnTheTreadAlreadySupportingTheBodyAcrossTheCellLine() {
        var tread = new BlockPos(-15, 36, -22);
        var edge = new Vec3d(-14.519715871668827, 37, -20.977740632182073);
        assertEquals(tread.south(), BlockPos.ofFloored(edge).down());
        assertFalse(AgentBody.sameSurveySupport(tread, edge), "ordinary same-cell centering is not a crossing");
        var stance = AgentBody.EdgeStance.start(tread, edge, standingBox(edge));
        assertNotNull(stance);

        var justInside = edge.add(0, 0, -0.04);
        assertTrue(AgentBody.sameSurveySupport(tread, justInside));
        assertFalse(stance.settled(justInside), "crossing the grid line does not yet give full-width takeoff");
        assertNotNull(stance.sweep(tread, justInside, standingBox(justInside), Vec3d.ZERO, 0, -0.04));
        assertTrue(stance.settled(new Vec3d(-14.52, 37, -21.40)));
    }

    @Test
    void anOverlappingCornerDoesNotPermitAnOutwardInputOrNewSupport() {
        var tread = new BlockPos(-15, 36, -22);
        var edge = new Vec3d(-15.02, 37, -20.98);
        var body = standingBox(edge);
        var stance = AgentBody.EdgeStance.start(tread, edge, body);
        assertNotNull(stance, "both axes overlap the same actual tread");
        var sweep = stance.sweep(tread, edge, body, Vec3d.ZERO, 0.022, -0.022);
        assertNotNull(sweep);
        assertTrue(sweep.intersects(new Box(tread.up(2))), "a head obstruction can veto the entire inward sweep");
        assertNull(stance.sweep(tread, edge, body, Vec3d.ZERO, -0.022, -0.022));
        assertNull(stance.sweep(tread.south(), edge, body, Vec3d.ZERO, 0.022, -0.022));
        assertNull(AgentBody.EdgeStance.start(tread.north(), edge, body), "a remote tread is not current support");
        assertNull(AgentBody.EdgeStance.start(tread.down(), edge, body), "an unseen lower floor is not current support");
        assertNull(AgentBody.EdgeStance.start(tread, edge.add(-0.29, 0, 0), body.offset(-0.29, 0, 0)));
        assertNull(AgentBody.EdgeStance.start(tread, edge.add(-0.17, 0, 0.17), body.offset(-0.17, 0, 0.17)),
            "overlap alone does not permit a longer diagonal shift");
    }

    @Test
    void onlyTheExactVisibleStableDryTopCanAuthorizeEdgeCentering() {
        var tread = new BlockPos(-15, 36, -22);
        var edge = new Vec3d(-14.52, 37, -20.98);
        var stance = AgentBody.EdgeStance.start(tread, edge, standingBox(edge));
        assertNotNull(stance);
        var world = EmptyBlockView.INSTANCE;
        var top = Vec3d.ofBottomCenter(tread.up());
        var contact = new BlockHitResult(top, Direction.UP, tread, false);
        var stone = Blocks.STONE.getDefaultState();
        assertTrue(stance.dryTop(contact, stone, world));
        assertFalse(stance.dryTop(null, stone, world), "contact alone cannot authorize movement without a rendered top");
        assertFalse(stance.dryTop(new BlockHitResult(top, Direction.SOUTH, tread, false), stone, world));
        assertFalse(stance.dryTop(new BlockHitResult(top.add(0, 0, 1), Direction.UP, tread.south(), false), stone, world));
        for (var material : new net.minecraft.block.Block[] {
                Blocks.WATER, Blocks.LAVA, Blocks.MAGMA_BLOCK, Blocks.FIRE, Blocks.GRAVEL, Blocks.STONE_SLAB, Blocks.ICE
        }) {
            assertFalse(stance.dryTop(contact, material.getDefaultState(), world), material.toString());
        }
    }

    private static Box standingBox(Vec3d feet) {
        return new Box(feet.x - 0.3, feet.y, feet.z - 0.3, feet.x + 0.3, feet.y + 1.8, feet.z + 0.3);
    }

    @Test
    void canWitnessTwoSeparatedPointsBelowTheRetainedLedgeFromOrdinaryFooting() {
        var foot = new BlockPos(0, 30, 0);
        var feet = Vec3d.ofBottomCenter(foot).add(0.008, 0, -0.008);
        var ledge = new Box(foot.down());
        for (Direction bearing : Direction.Type.HORIZONTAL) {
            var cell = AgentSurfaceTread.nextFoot(foot, bearing).down();
            var low = AgentBody.footholdInterior(cell, bearing, false);
            var high = AgentBody.footholdInterior(cell, bearing, true);
            assertEquals(cell, BlockPos.ofFloored(low));
            assertEquals(cell, BlockPos.ofFloored(high));
            assertTrue(high.y - low.y >= 0.4, "independent low and high probes");

            for (double eyeHeight : new double[]{1.62, 1.27}) {
                // The action rechecks empty space after adopting its placement sneak.
                var eye = feet.add(0, eyeHeight, 0);
                assertTrue(ledge.raycast(eye, low).isEmpty(), "low ray clears the retained ledge " + bearing);
                assertTrue(ledge.raycast(eye, high).isEmpty(), "high ray clears the retained ledge " + bearing);
            }
        }
    }

    @Test
    void aFullObstructionStillInterceptsTheDescendingWitnesses() {
        var foot = new BlockPos(0, 30, 0);
        var eye = Vec3d.ofBottomCenter(foot).add(0, 1.62, 0);
        var cell = AgentSurfaceTread.nextFoot(foot, Direction.EAST).down();
        var occludingWall = new Box(cell.up());
        var occupiedCell = new Box(cell);
        for (boolean high : new boolean[]{false, true}) {
            var point = AgentBody.footholdInterior(cell, Direction.EAST, high);
            assertTrue(occludingWall.raycast(eye, point).isPresent(), "the intervening full block occludes the ray");
            assertTrue(occupiedCell.raycast(eye, point).isPresent(), "a full block in the sampled cell is hit");
        }
    }

    @Test
    void aSupportedPeekRevealsTheNaturalTopBelowTheMissingTread() {
        var from = new BlockPos(0, 30, 0);
        var bearing = Direction.EAST;
        var floor = from.east().down(3);
        var lip = new Box(from.down());
        var eye = Vec3d.ofBottomCenter(from).add(0, 1.27, 0);
        var target = AgentDryLanding.caveTopAim(from, bearing, 2);
        assertTrue(lip.raycast(eye, target).isPresent(), "the retained lip can hide the lower floor");

        var peek = eye.add(0.30, 0, 0);
        assertTrue(lip.raycast(peek, target).isEmpty());
        var point = new Box(floor).raycast(peek, target).orElseThrow();
        var hit = new BlockHitResult(point, Direction.UP, floor, false);
        assertTrue(AgentDryLanding.caveTop(from, bearing, 2, hit, Blocks.STONE.getDefaultState()));
        var sweep = AgentDryLanding.receivingSweep(floor.up(), from.getY(), bearing, 0.60, 1.80);
        assertFalse(sweep.intersects(new Box(floor)), "the support is below the fall volume");
        assertFalse(sweep.intersects(lip), "the lower sweep must not sweep back through the old lip");
        assertTrue(AgentBody.footholdFaceInEnvelope(hit, floor.up(), bearing),
            "the revealed lower top can attach a real one-down step");
    }

    @Test
    void aClippedWallFluidTopOrUnreachableShelfDoesNotBecomeADrop() {
        var from = new BlockPos(0, 30, 0);
        var bearing = Direction.EAST;
        var floor = from.east().down(3);
        var eye = Vec3d.ofBottomCenter(from).add(0.30, 1.27, 0);
        var target = AgentDryLanding.caveTopAim(from, bearing, 2);
        var point = new Box(floor).raycast(eye, target).orElseThrow();
        var hit = new BlockHitResult(point, Direction.UP, floor, false);
        var wall = floor.up(2);
        var obstruction = new Box(wall).raycast(eye, target).orElseThrow();
        assertFalse(AgentDryLanding.caveTop(from, bearing, 2,
            new BlockHitResult(obstruction, Direction.UP, wall, false), Blocks.STONE.getDefaultState()));
        assertFalse(AgentDryLanding.caveTop(from, bearing, 2, null, Blocks.STONE.getDefaultState()));
        assertFalse(AgentDryLanding.caveTop(from, bearing, 2, hit, Blocks.LAVA.getDefaultState()));
        assertFalse(AgentDryLanding.caveTop(from, bearing, 2, hit, Blocks.WATER.getDefaultState()));
        assertFalse(AgentDryLanding.caveTop(from, bearing, 2, hit, Blocks.GRAVEL.getDefaultState()));
        var sweep = AgentDryLanding.receivingSweep(floor.up(), from.getY(), bearing, 0.60, 1.80);
        assertTrue(sweep.intersects(new Box(floor.up().east())),
            "a lava or obstruction cell beyond the shelf lip still vetoes the overhanging body");
        var farther = floor.east();
        assertFalse(AgentDryLanding.caveTop(from, bearing, 2,
            new BlockHitResult(Vec3d.ofBottomCenter(farther.up()), Direction.UP, farther, false),
            Blocks.STONE.getDefaultState()));
        assertFalse(AgentDryLanding.stoppingFits(from, bearing, Vec3d.ofBottomCenter(from).add(0.78, 0, 0),
            new Vec3d(0.16, 0, 0), 0.102, 0, 0.30), "vanilla coast would overshoot the receiving shelf");
    }

    @Test
    void oneDownWalkFitsUnderACeilingThatBlocksTheReturnJump() {
        var from = new BlockPos(0, 30, 0);
        var bearing = Direction.EAST;
        var to = from.east().down();
        var stone = Blocks.STONE.getDefaultState();
        var feet = Vec3d.ofBottomCenter(from).add(0.30, 0, 0);
        var eye = feet.add(0, 1.62, 0);
        var ceiling = new Box(from.up(2));
        var target = AgentDryLanding.caveTopAim(from, bearing, 1);
        var hit = new BlockHitResult(new Box(to.down()).raycast(eye, target).orElseThrow(),
            Direction.UP, to.down(), false);
        assertTrue(AgentDryLanding.caveTop(from, bearing, 1, hit, stone));
        assertFalse(AgentDryLanding.receivingSweep(to, from.getY(), bearing, 0.60, 1.80).intersects(ceiling));
        assertTrue(AgentSurfaceTread.reverseJumpSweep(from, to, bearing, 0.60).intersects(ceiling));
        assertTrue(AgentDryLanding.stoppingFits(from, bearing, feet, Vec3d.ZERO, 0.102, 0, 0.30));
        assertTrue(AgentDryLanding.escapeKit(1, 1, 0), "a usable pick is sufficient, not proof of a return");
        assertTrue(AgentDryLanding.escapeKit(2, 0, 2));
        assertFalse(AgentDryLanding.escapeKit(2, 0, 1));
        assertFalse(AgentDryLanding.escapeKit(1, 0, 0));
        assertFalse(AgentDryLanding.escapeKit(3, 32, 64), "supplies never scale the permitted fall");
    }

    @Test
    void ordinaryOneDownUsesTheActualCoastInsideATightDeadEnd() {
        var from = new BlockPos(0, 30, 0);
        var to = from.east().down();
        var feet = Vec3d.ofBottomCenter(from).add(0.34, 0, 0);
        var velocity = new Vec3d(0, -0.0784, 0);
        var top = new BlockHitResult(Vec3d.ofBottomCenter(to), Direction.UP, to.down(), false);
        var stone = Blocks.STONE.getDefaultState();
        var landing = new AgentDryLanding(from, stone, top, to, stone, Direction.EAST,
            feet, Vec3d.ofBottomCenter(to), -90, true);
        var lip = new Box(from.down());
        var floor = new Box(to.down());
        var roof = new Box(0, 32, 0, 2, 33, 1);
        var farWall = new Box(2, 29, 0, 3, 32, 1);
        var obstruction = new Box(to.up(2));
        var lowerRidge = new Box(1.6, 29, 0, 1.7, 29.125, 1);
        var risingWater = new Box(to);
        var lowCeiling = new Box(0, 31, 0, 1, 32, 1);
        Predicate<Box> corridor = box ->
            !box.intersects(lip) && !box.intersects(floor) && !box.intersects(roof) && !box.intersects(farWall);

        assertTrue(AgentDryLanding.receivingSweep(to, from.getY(), Direction.EAST, 0.60, 1.80).intersects(farWall),
            "the old all-column sweep reached a wall that the player never touches");
        assertEquals(AgentDryLanding.CaveMotion.LANDING, landing.caveCoast(feet, velocity,
            0.30, 1.80, 0.08, true, 3, 0.098, 0, corridor, box -> true));
        assertEquals(AgentDryLanding.CaveMotion.UPPER_COLLISION, landing.caveCoast(feet, velocity,
            0.30, 1.80, 0.08, true, 3, 0.098, 0, box -> corridor.test(box) && !box.intersects(lowCeiling), box -> true));
        assertEquals(AgentDryLanding.CaveMotion.UPPER_COLLISION, landing.caveCoast(feet, velocity,
            0.30, 1.80, 0.08, true, 3, 0.098, 0, box -> corridor.test(box) && !box.intersects(obstruction), box -> true));
        assertEquals(AgentDryLanding.CaveMotion.LOWER_COLLISION, landing.caveCoast(feet, velocity,
            0.30, 1.80, 0.08, true, 3, 0.098, 0, box -> corridor.test(box) && !box.intersects(lowerRidge), box -> true));
        assertEquals(AgentDryLanding.CaveMotion.LOWER_HAZARD, landing.caveCoast(feet, velocity,
            0.30, 1.80, 0.08, true, 3, 0.098, 0, corridor, box -> !box.intersects(risingWater)));
        assertEquals(AgentDryLanding.CaveMotion.RANGE, landing.caveCoast(new Vec3d(1.42, 29.9, 0.5),
            new Vec3d(0.16, -0.16, 0), 0.30, 1.80, 0.08, false, 0, 0, 0, null, null));
        assertFalse(AgentDryLanding.caveTop(from, Direction.EAST, 1, null, stone),
            "a clear coast is not a substitute for a visible top");
    }

    @Test
    void oneWayDropReceiptNeedsSettledContactWithTheExactWitnessedTop() {
        var from = new BlockPos(0, 30, 0);
        var to = from.east().down(2);
        var center = Vec3d.ofBottomCenter(to);
        var stone = Blocks.STONE.getDefaultState();
        var top = new BlockHitResult(center, Direction.UP, to.down(), false);
        var landing = new AgentDryLanding(from, stone, top, to, stone, Direction.EAST,
            Vec3d.ofBottomCenter(from), center, -90, true);
        assertTrue(landing.settled(center, to.down(), stone, 0.001, true));
        assertFalse(landing.settled(center, to.down(), stone, 0.003, true), "still sliding");
        assertFalse(landing.settled(center, to.down(), stone, 0, false), "airborne or no longer safely dry");
        assertFalse(landing.settled(center, from.down(), stone, 0, true), "still on the starting support");
        assertFalse(landing.settled(center.add(0, 0.25, 0), to.down(), stone, 0, true), "above the shelf");
        assertFalse(landing.settled(center, to.down(), Blocks.DIRT.getDefaultState(), 0, true), "support changed");
    }

    @Test
    void oneWitnessedAttachmentCanPayForExactlyOneNewLitTop() {
        var from = new BlockPos(0, 30, 0);
        var build = new AgentMacroControl.ProspectSupport(from, from.east().down(), Direction.EAST);
        var anchor = build.cell.east();
        var face = new BlockHitResult(Vec3d.ofCenter(anchor).add(-0.5, 0, 0), Direction.WEST, anchor, false);
        var eye = Vec3d.ofBottomCenter(from).add(0, 1.62, 0);
        assertTrue(new Box(from.down()).raycast(eye, face.getPos()).isEmpty());
        assertTrue(face.getPos().squaredDistanceTo(eye) < 4 * 4);
        assertTrue(AgentBody.footholdFaceInEnvelope(face, build.cell, Direction.EAST));
        build.pin(face, Blocks.STONE.getDefaultState(), 30);
        assertEquals(AgentMacroControl.ProspectSupport.View.READY,
            build.view(AgentBody.FootholdSpace.EMPTY, AgentBody.FootholdSpace.EMPTY, true));

        var raw = JsonParser.parseString("""
            {"v":1,"id":"support-check","run":"run","life":1,"epoch":1,"basisTick":5,"expiresTick":120,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:diamond","count":1},
             "allowedEffects":["break:minecraft:diamond_ore","prospect:minecraft:diamond","place:minecraft:cobblestone"],
             "maxBreaks":1,"maxCrafts":0,"maxPlacements":1,"costCaps":[{"item":"minecraft:cobblestone","count":1}],
             "reserves":[{"item":"minecraft:cobblestone","count":1}]}
            """).getAsJsonObject();
        var budget = new AgentWorkOrder.Budget(AgentWorkOrder.parse(raw, "run", "constrained").policy());
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.COBBLESTONE, 2));
        assertTrue(budget.canPlaceProspectSupport(stock));
        var top = new BlockHitResult(Vec3d.ofBottomCenter(build.to), Direction.UP, build.cell, false);
        var cobble = Blocks.COBBLESTONE.getDefaultState();
        assertFalse(build.confirms(12, top, cobble, 1), "a visible floor is not an issued support");
        build.issued(32, 12, 2, budget);
        assertFalse(budget.canPlaceProspectSupport(stock), "issuing consumes the grant before vanilla acknowledges it");
        assertFalse(build.confirms(12, top, cobble, 1), "the old render cannot prove the new top");
        assertFalse(build.confirms(13, null, cobble, 1), "a debit alone proves no footing");
        assertFalse(build.confirms(13, top, cobble, 2), "a matching top alone proves no placement");
        var nearbyOrdinaryFloor = new BlockHitResult(Vec3d.ofBottomCenter(from.east()), Direction.UP, from.east().down(), false);
        assertFalse(build.confirms(13, nearbyOrdinaryFloor, cobble, 1), "the normal floor a full block higher is not the stair top");
        assertTrue(build.confirms(13, top, cobble, 1));
    }

    @Test
    void onlyAKnownContactMayResolveAClippedAirPairAndNeitherSampleMayBeGuessed() {
        var from = new BlockPos(0, 30, 0);
        var build = new AgentMacroControl.ProspectSupport(from, from.east(), Direction.EAST);
        var empty = AgentBody.FootholdSpace.EMPTY;
        var clipped = AgentBody.FootholdSpace.VIEW;
        var refused = AgentMacroControl.ProspectSupport.View.REFUSED;
        assertEquals(refused, build.view(empty, empty, false), "dry air without a witnessed face gives no aim");
        assertEquals(refused, build.view(empty, clipped, false), "a missing attachment cannot start a search sweep");
        var wrongFace = new BlockHitResult(Vec3d.ofBottomCenter(from.east()), Direction.UP, from.east().down(), false);
        assertFalse(AgentBody.footholdFaceInEnvelope(wrongFace, build.cell, Direction.EAST),
            "an ordinary level floor is not an anchor for replacing itself");
        var anchor = build.cell.south();
        var seen = new BlockHitResult(Vec3d.ofCenter(anchor).add(0, 0, -0.5), Direction.NORTH, anchor, false);
        var miss = BlockHitResult.createMissed(seen.getPos(), seen.getSide(), anchor);
        assertFalse(AgentBody.footholdFaceInEnvelope(miss, build.cell, Direction.EAST),
            "an inferred direction on a missed ray is not a witnessed face");
        build.pin(seen, Blocks.STONE.getDefaultState(), 30);
        assertEquals(AgentMacroControl.ProspectSupport.View.ALIGN, build.view(empty, clipped, false));
        assertEquals(refused, build.view(empty, clipped, true), "one alignment that still cannot see both probes ends the attempt");
        for (var veto : new AgentBody.FootholdSpace[]{AgentBody.FootholdSpace.OCCLUDED, AgentBody.FootholdSpace.DARK,
                AgentBody.FootholdSpace.OCCUPIED, AgentBody.FootholdSpace.FLUID}) {
            assertEquals(refused, build.view(empty, veto, false));
            assertEquals(refused, build.view(veto, empty, false));
        }
        build.seekingContact = true;
        assertEquals(refused, build.view(empty, clipped, false), "contact that clips either proof isn't re-aimed");
        assertFalse(build.confirms(40, wrongFace, Blocks.COBBLESTONE.getDefaultState(), 0));
    }

    @Test
    void firstSurfaceCutNeedsARealAdjacentTopOutsideFootprintAndRetainedTiles() {
        var foot = new BlockPos(0, 70, 0);
        var cap = foot.east().down();
        var hit = new BlockHitResult(Vec3d.ofBottomCenter(cap.up()), Direction.UP, cap, false);
        var stance = new Box(0.2, 70, 0.2, 0.8, 71.8, 0.8);
        assertTrue(AgentMacroControl.firstSurfaceCap(foot, hit, stance, Set.of(foot.down())));
        assertFalse(AgentMacroControl.firstSurfaceCap(foot, hit, stance, Set.of(cap)), "retained footing");
        assertFalse(AgentMacroControl.firstSurfaceCap(foot, hit, stance.offset(0.1, 0, 0), Set.of()),
            "the expanded player footprint reaches the cut column");
        assertFalse(AgentMacroControl.firstSurfaceCap(foot, null, stance, Set.of()), "no witness");
        assertFalse(AgentMacroControl.firstSurfaceCap(foot,
            BlockHitResult.createMissed(hit.getPos(), Direction.UP, cap), stance, Set.of()), "inferred top");
        assertFalse(AgentMacroControl.firstSurfaceCap(foot,
            new BlockHitResult(hit.getPos(), Direction.UP, cap, true), stance, Set.of()), "origin inside the outline");
        assertFalse(AgentMacroControl.firstSurfaceCap(foot,
            new BlockHitResult(hit.getPos(), Direction.WEST, cap, false), stance, Set.of()), "side");
        assertFalse(AgentMacroControl.firstSurfaceCap(foot,
            new BlockHitResult(hit.getPos().subtract(0, 0.5, 0), Direction.UP, cap, false), stance, Set.of()), "partial top");
        assertFalse(AgentMacroControl.firstSurfaceCap(foot,
            new BlockHitResult(Vec3d.ofBottomCenter(foot), Direction.UP, foot.down(), false), stance, Set.of()), "own support");
        var diagonal = cap.south();
        assertFalse(AgentMacroControl.firstSurfaceCap(foot,
            new BlockHitResult(Vec3d.ofBottomCenter(diagonal.up()), Direction.UP, diagonal, false), stance, Set.of()),
            "diagonal is not a cardinal tread");
    }

    @Test
    void exactSurfaceAnchorNeedsAnEarlyStockSourceAndAPricedSeparateCut() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"surface-entry","run":"run","life":1,"epoch":1,"basisTick":5,"expiresTick":650,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:cobblestone","count":3},
             "allowedEffects":["break:minecraft:stone","break:minecraft:grass_block"],
             "maxBreaks":4,"maxCrafts":0,"maxPlacements":0,"costCaps":[],"reserves":[],
             "surfaceAnchor":{"subject":"block:minecraft:grass_block","target":"m-8"}}
            """).getAsJsonObject();
        var opening = AgentWorkOrder.parse(raw, "run", "constrained");
        assertEquals(new AgentWorkOrder.SurfaceAnchor("block:minecraft:grass_block", "m-8"), opening.surfaceAnchor());
        var staged = raw.deepCopy();
        staged.addProperty("id", "program:1");
        staged.addProperty("nextWorkId", "program:2");
        assertEquals(opening.surfaceAnchor(), AgentWorkOrder.parse(staged, "run", "constrained").surfaceAnchor());
        staged.remove("nextWorkId");
        assertNull(AgentWorkOrder.parse(staged, "run", "constrained").policy(), "unpaired first-stage scope");
        staged.addProperty("id", "program:2");
        staged.addProperty("nextWorkId", "program:3");
        assertNull(AgentWorkOrder.parse(staged, "run", "constrained").policy(), "do not carry the opening into a later stage");
        raw.addProperty("maxBreaks", 1);
        assertNull(AgentWorkOrder.parse(raw, "run", "constrained").policy(), "reserve a break for the source");
        raw.addProperty("maxBreaks", 4);
        var anchor = raw.getAsJsonObject("surfaceAnchor");
        anchor.addProperty("target", "grass");
        assertNull(AgentWorkOrder.parse(raw, "run", "constrained").policy());
        anchor.addProperty("target", "m-8");
        anchor.addProperty("subject", "block:minecraft:stone");
        assertNull(AgentWorkOrder.parse(raw, "run", "constrained").policy(), "a source is not cover");
        anchor.addProperty("subject", "block:minecraft:dirt");
        assertNull(AgentWorkOrder.parse(raw, "run", "constrained").policy(), "unquoted cover effect");
        anchor.addProperty("subject", "block:minecraft:grass_block");
        raw.getAsJsonArray("allowedEffects").remove(0);
        assertNull(AgentWorkOrder.parse(raw, "run", "constrained").policy(), "no corresponding source effect");
        raw.getAsJsonArray("allowedEffects").add("break:minecraft:stone");
        raw.getAsJsonArray("allowedEffects").add("break:minecraft:sand");
        assertNull(AgentWorkOrder.parse(raw, "run", "constrained").policy(), "falling blocks are not safe cover");
    }

    @Test
    void shallowStairRebindsOnlyItsActualDrySoilContact() {
        var upper = new BlockPos(-21, 62, 17);
        var lower = upper.north().down();
        var grass = Blocks.GRASS_BLOCK.getDefaultState();
        var dirt = Blocks.DIRT.getDefaultState();
        var edge = new AgentSurfaceTread.Edge(upper, grass, lower, dirt, Direction.NORTH);

        assertEquals(new AgentSurfaceTread.Edge(upper, grass, lower, grass, Direction.NORTH),
            AgentSurfaceTread.rebindSoilContact(edge, lower, grass));
        assertEquals(edge, AgentSurfaceTread.rebindSoilContact(edge, lower, dirt), "no new material");
        assertEquals(edge, AgentSurfaceTread.rebindSoilContact(edge, lower, null), "no grounded proof");
        assertEquals(edge, AgentSurfaceTread.rebindSoilContact(edge, lower.north(), grass), "wrong column");
        assertEquals(edge, AgentSurfaceTread.rebindSoilContact(edge, upper, dirt), "not the occupied lower endpoint");
        for (var material : new net.minecraft.block.Block[] { Blocks.AIR, Blocks.WATER, Blocks.SAND, Blocks.STONE,
                Blocks.OAK_LEAVES, Blocks.CRAFTING_TABLE }) {
            assertEquals(edge, AgentSurfaceTread.rebindSoilContact(edge, lower, material.getDefaultState()),
                "a different floor is not a soil refresh");
        }
        var top = new BlockHitResult(Vec3d.ofBottomCenter(upper), Direction.UP, upper.down(), false);
        assertEquals(new AgentSurfaceTread.Edge(upper, dirt, lower, dirt, Direction.NORTH),
            AgentSurfaceTread.rebindSoilLanding(edge, top, dirt));
        assertEquals(edge, AgentSurfaceTread.rebindSoilLanding(edge,
            new BlockHitResult(top.getPos(), Direction.NORTH, upper.down(), false), dirt),
            "a faced riser is not an observed landing top");
        assertEquals(edge, AgentSurfaceTread.rebindSoilLanding(edge,
            new BlockHitResult(Vec3d.ofBottomCenter(lower), Direction.UP, lower.down(), false), dirt),
            "the near top cannot bind the far landing");
    }

    @Test
    void stoppedStonePickupDoesNotConsumeAShallowStairThatWasNeverTaken() {
        var rim = new BlockPos(-21, 61, 16);
        var landing = rim.north().down();
        var edge = new AgentSurfaceTread.Edge(rim, Blocks.GRASS_BLOCK.getDefaultState(), landing,
            Blocks.STONE.getDefaultState(), Direction.NORTH);
        var outbound = new AgentSurfaceTread(edge, false, 255);
        assertTrue(outbound.refusedOnTakeoff(rim, true), "the rim remains the actual working stance");
        assertFalse(outbound.refusedOnTakeoff(rim, false), "airborne interruption is not a safe reset");
        assertFalse(outbound.refusedOnTakeoff(landing, true), "a changed foot position is not a refusal on takeoff");
        assertFalse(new AgentSurfaceTread(edge, true, 255).refusedOnTakeoff(landing, true),
            "a refused reverse edge still preserves the outstanding return");

        var player = new Box(-20.78, 61, 16.17, -20.18, 62.8, 16.77);
        var inReach = new Box(-20.8, 60.4, 15.42, -20.55, 60.65, 15.67);
        assertTrue(AgentPickup.passiveOverlap(player, inReach), "vanilla may collect from the rim without walking");
        assertFalse(AgentPickup.passiveOverlap(player, inReach.offset(0, -0.3, 0)),
            "a drop outside passive overlap is not pickup authority or proof");
    }

    @Test
    void exposedRimWallDoesNotNominateEitherSupportAsAResource() {
        var rim = new BlockPos(-21, 61, 16);
        var opening = rim.north().down();
        var farWall = opening.north();
        var towardRim = new BlockHitResult(Vec3d.ofCenter(farWall).add(0, 0, 0.5), Direction.SOUTH, farWall, false);
        assertEquals(opening, AgentMacroControl.rimSourceOpening(rim, towardRim));
        assertNull(AgentMacroControl.rimSourceOpening(rim,
            new BlockHitResult(towardRim.getPos(), Direction.NORTH, farWall, false)), "the far face is not a local rim wall");
        assertNull(AgentMacroControl.rimSourceOpening(rim,
            new BlockHitResult(Vec3d.ofBottomCenter(opening), Direction.UP, opening.down(), false)), "protect the lower tread");
        assertNull(AgentMacroControl.rimSourceOpening(rim,
            new BlockHitResult(Vec3d.ofCenter(rim.down()).add(0, 0, -0.5), Direction.NORTH, rim.down(), false)),
            "protect the player's rim");
        assertNull(AgentMacroControl.rimSourceOpening(rim,
            BlockHitResult.createMissed(towardRim.getPos(), Direction.SOUTH, farWall)), "never infer stone from a miss");
    }

    @Test
    void aFlatDryShelfCanSpareOneAdjacentFloorForAStair() {
        var foot = new BlockPos(0, 30, 0);
        var east = foot.east();
        var west = foot.west();
        int eastFloor = 1 << Direction.EAST.ordinal();
        int westExit = 1 << Direction.WEST.ordinal();
        var fullTops = Set.of(foot.down(), east.down(), west.down());
        assertEquals(east.down(), AgentSurfaceTread.nextFoot(foot, Direction.EAST));
        assertTrue(fullTops.contains(foot.down()), "the player keeps their own footing");
        assertEquals(westExit, usableDryExits(foot, Set.of(foot.down(), west.down())),
            "removing the east floor leaves a genuinely walkable west exit");

        assertEquals(eastFloor, AgentSurfaceTread.spareLevelFloorChoices(eastFloor, usableDryExits(foot, fullTops), false));
        assertEquals(eastFloor, AgentSurfaceTread.spareLevelFloorChoices(eastFloor, eastFloor, true),
            "an intact walked reverse path also leaves a way out");
    }

    @Test
    void cannotCutTheOnlyDryEscapeWhenAnIntactLookingSideFloorHasABlockedSweep() {
        var foot = new BlockPos(0, 30, 0);
        var north = foot.north();
        var east = foot.east();
        var lowRoof = new Box(north.up());
        var fullTops = Set.of(foot.down(), east.down(), north.down());
        int eastFloor = 1 << Direction.EAST.ordinal();
        int usable = usableDryExits(foot, fullTops, lowRoof);
        assertEquals(eastFloor, usable, "west and south drop away; north has a top but no lane");
        assertEquals(0, usableDryExits(foot, Set.of(foot.down(), north.down()), lowRoof),
            "removing the east floor would leave no walkable exit");
        assertEquals(0, AgentSurfaceTread.spareLevelFloorChoices(eastFloor, usable, false),
            "there is also no walked way back");
    }

    private static int usableDryExits(BlockPos foot, Set<BlockPos> fullTops, Box... obstructions) {
        int exits = 0;
        for (Direction direction : Direction.Type.HORIZONTAL) {
            BlockPos to = foot.offset(direction);
            if (!fullTops.contains(to.down())) continue;
            Box sweep = AgentSurfaceTread.retainedTreadSweep(foot, to, 0.6);
            boolean blocked = false;
            for (Box obstruction : obstructions) blocked |= sweep.intersects(obstruction);
            if (!blocked) exits |= 1 << direction.ordinal();
        }
        return exits;
    }
}
