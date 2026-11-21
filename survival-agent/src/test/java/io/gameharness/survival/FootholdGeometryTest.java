package io.gameharness.survival;

import com.google.gson.JsonParser;
import java.util.Set;
import net.minecraft.block.Blocks;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
