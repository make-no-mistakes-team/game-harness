package io.gameharness.survival;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ShapeContext;
import net.minecraft.fluid.FluidState;
import net.minecraft.state.property.Properties;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class ReturnableMineStartTest {
    private static final BlockPos RIM = new BlockPos(0, 64, 0);
    private static final Direction EAST = Direction.EAST;

    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
    }

    @Test
    void anAdjacentCapCanBeCutFromFirmFootingWithoutAuthorizingTheStepIntoIt() {
        BlockPos cap = RIM.east().down();
        Box settled = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        assertTrue(AgentReturnableMine.stationaryCap(RIM, cap, EAST, settled));
        assertFalse(AgentReturnableMine.stationaryCap(RIM, cap, EAST, settled.offset(0.3, 0, 0)),
            "part of the body is over the prospective hole");
        assertFalse(AgentReturnableMine.stationaryCap(RIM, RIM.down(), EAST, settled));
        assertNull(AgentReturnableMine.witnessedTransit(RIM, cap, EAST, null, Blocks.STONE.getDefaultState(),
            Blocks.STONE.getDefaultState(), true), "a stationary cut did not witness the landing below it");
    }

    @Test
    void aFlatNaturalTopIsTheCapAnExistingHoleDoesNotHave() {
        BlockPos cap = RIM.east().down();
        var terrain = new Terrain(new HashMap<>());
        terrain.blocks.put(RIM.down(), Blocks.GRASS_BLOCK.getDefaultState());
        terrain.blocks.put(cap, Blocks.GRASS_BLOCK.getDefaultState());
        terrain.blocks.put(cap.up(), Blocks.SHORT_GRASS.getDefaultState());
        var eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        var aim = AgentReturnableMine.capAim(cap, EAST, 1);
        assertTrue(AgentReturnableMine.witnessedCap(cap, EAST, terrain.ray(eye, aim)),
            "the collider ray sees the natural flat top through the grass outline");
        terrain.blocks.put(cap.up(), Blocks.TORCH.getDefaultState());
        assertTrue(AgentReturnableMine.witnessedCap(cap, EAST, terrain.ray(eye, aim)),
            "a torch outline is also not a wall; the separate attachment veto protects it");
        terrain.blocks.remove(cap);
        terrain.blocks.remove(cap.up());
        terrain.blocks.put(cap.down(), Blocks.DIRT.getDefaultState());
        assertFalse(AgentReturnableMine.witnessedCap(cap, EAST, terrain.ray(eye, aim)));
        assertFalse(AgentReturnableMine.witnessedCap(cap, EAST, top(cap.down())),
            "the already dug hole has a landing top, not a cap to cut");
        assertFalse(AgentReturnableMine.witnessedCap(cap, EAST, top(RIM.down())),
            "never substitute the near lip under the player");
        assertFalse(AgentReturnableMine.witnessedCap(cap, EAST,
            BlockHitResult.createMissed(top(cap).getPos(), Direction.UP, cap)));
        assertFalse(AgentReturnableMine.witnessedCap(cap, EAST,
            new BlockHitResult(top(cap).getPos(), Direction.DOWN, cap, false)));
    }

    @Test
    void aRealAdjacentGravelFaceCanBeCutButDoesNotProveTheEastTread() {
        var terrain = new Terrain(new HashMap<>());
        var mineable = AgentReturnableMine.Face.MINEABLE;
        var footprint = AgentReturnableMine.Face.FOOTPRINT;
        BlockPos side = RIM.east();
        BlockState stone = Blocks.STONE.getDefaultState();
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        Box hull = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        terrain.blocks.put(RIM.down(), stone);
        for (int height = -1; height <= 1; height++) {
            BlockPos gravel = side.up(height);
            terrain.blocks.put(gravel, Blocks.GRAVEL.getDefaultState());
            Vec3d aim = height == -1 ? AgentReturnableMine.capAim(gravel, EAST, 0) : Vec3d.ofCenter(gravel);
            BlockHitResult shown = terrain.ray(eye, aim);
            assertEquals(mineable, AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST, shown, hull, stone, eye, 4.5, false));
            assertEquals(height >= 0 ? mineable : footprint,
                AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST, shown, hull, stone, eye, 4.5, true),
                "a drift can clear foot and head but cannot remove its own intended tread");
            assertEquals(AgentReturnableMine.Face.OCCLUDED,
                AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST, shown, hull, stone, eye, 0.25, false));
            terrain.blocks.remove(gravel);
        }
        assertNull(AgentReturnableMine.witnessedTransit(RIM, side.down(), EAST, null, stone, stone, true),
            "opening the side does not establish a floor or a return");
        assertNull(AgentReturnableMine.witnessedTransit(RIM, side, EAST, top(side.down()), stone,
            Blocks.GRAVEL.getDefaultState(), true), "newly settled gravel is not a mine tread");
    }

    @Test
    void gravelDoesNotAuthorizeUndercuttingWorkingUnderTheColumnOrBreakingAnAttachment() {
        var terrain = new Terrain(new HashMap<>());
        var footprint = AgentReturnableMine.Face.FOOTPRINT;
        BlockPos side = RIM.east();
        BlockState stone = Blocks.STONE.getDefaultState(), gravel = Blocks.GRAVEL.getDefaultState();
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        Box hull = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        terrain.blocks.put(RIM.down(), gravel);
        terrain.blocks.put(side, gravel);
        terrain.blocks.put(side.up(2), gravel);
        var shown = terrain.ray(eye, Vec3d.ofCenter(side));
        assertEquals(footprint, AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST,
            top(RIM.down()), hull, stone, eye, 4.5, false));
        assertEquals(footprint, AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST,
            terrain.ray(eye, Vec3d.ofCenter(side.up(2))), hull, stone, eye, 4.5, false));
        assertEquals(footprint, AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST, shown, hull, null, eye, 4.5, false));
        assertEquals(footprint, AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST, shown, hull, gravel, eye, 4.5, false));
        assertEquals(footprint, AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST, shown,
            hull.offset(0.25, 0, 0), stone, eye, 4.5, false));
        terrain.blocks.put(side.up(), Blocks.TORCH.getDefaultState());
        assertEquals(AgentReturnableMine.Face.PROTECTED,
            AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST, shown, hull, stone, eye, 4.5, false));
        terrain.blocks.put(side.up(), Blocks.WATER.getDefaultState());
        var cover = terrain.ray(eye, Vec3d.ofCenter(side.up(), 0.20));
        assertEquals(AgentReturnableMine.Face.FLUID, AgentReturnableMine.gravelCover(terrain, side, cover));
        terrain.blocks.put(side.up(), gravel);
        cover = terrain.ray(eye, Vec3d.ofCenter(side.up(), 0.20));
        assertEquals(AgentReturnableMine.Face.FALLING_COVER, AgentReturnableMine.gravelCover(terrain, side, cover));
    }

    @Test
    void aGravelBreakAndAFallingEntityCannotStandInForFreshSettledClearance() {
        var work = new AgentReturnableMine.GravelWork();
        assertTrue(work.canCut());
        assertEquals(AgentReturnableMine.Fall.WAITING, work.settle(1, true), "an active fall vetoes the first cut as well");
        assertEquals(AgentReturnableMine.Fall.WAITING, work.settle(2, false));
        assertEquals(AgentReturnableMine.Fall.SETTLED, work.settle(8, false));
        work.broke(10);
        assertEquals(AgentReturnableMine.Fall.WAITING, work.settle(11, false), "air before gravity runs is not clear");
        assertEquals(AgentReturnableMine.Fall.WAITING, work.settle(14, true), "an active fall vetoes stepping");
        assertEquals(AgentReturnableMine.Fall.WAITING, work.settle(18, false),
            "disappearance could be a replacement block, not an open passage");
        assertEquals(AgentReturnableMine.Fall.SETTLED, work.settle(24, false));
        var terrain = new Terrain(new HashMap<>());
        BlockPos side = RIM.east();
        BlockState gravel = Blocks.GRAVEL.getDefaultState(), stone = Blocks.STONE.getDefaultState();
        terrain.blocks.put(side, gravel);
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        Box hull = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        Vec3d point = Vec3d.ofCenter(side);
        assertEquals(AgentReturnableMine.Face.MINEABLE,
            AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST, terrain.ray(eye, point),
                hull, stone, eye, 4.5, false), "the replacement needs a new witnessed cut");
        work.broke(25);
        assertEquals(AgentReturnableMine.Fall.WAITING, work.settle(26, false));
        assertEquals(AgentReturnableMine.Fall.SETTLED, work.settle(32, false));
        assertTrue(work.canCut());
        work.broke(40);
        assertFalse(work.canCut(), "same-cell replacement breaks count toward the finite budget");
        assertEquals(AgentReturnableMine.Fall.UNSAFE, work.settle(64, true), "a sustained fall must be declined");
        terrain.blocks.remove(side);
        assertEquals(AgentReturnableMine.Face.OCCLUDED,
            AgentReturnableMine.lateralGravelFace(terrain, RIM, EAST, terrain.ray(eye, point),
                hull, stone, eye, 4.5, false), "a miss supplies no gravel face to work");
    }

    @Test
    void shortGrassDoesNotProtectAVisibleCapButAWorkbenchOrAttachedTorchDoes() {
        var terrain = new Terrain(new HashMap<>());
        BlockPos cap = RIM.east().down();
        terrain.blocks.put(cap, Blocks.GRASS_BLOCK.getDefaultState());
        terrain.blocks.put(cap.up(), Blocks.SHORT_GRASS.getDefaultState());
        assertFalse(AgentReturnableMine.protectedCutAttachment(terrain, cap));
        terrain.blocks.put(cap.up(), Blocks.CRAFTING_TABLE.getDefaultState());
        assertTrue(AgentReturnableMine.protectedCutAttachment(terrain, cap));
        terrain.blocks.put(cap.up(), Blocks.TORCH.getDefaultState());
        assertTrue(AgentReturnableMine.protectedCutAttachment(terrain, cap));
        terrain.blocks.remove(cap.up());
        terrain.blocks.put(cap.east(), Blocks.WALL_TORCH.getDefaultState().with(Properties.HORIZONTAL_FACING, EAST));
        assertTrue(AgentReturnableMine.protectedCutAttachment(terrain, cap));
        terrain.blocks.put(cap.east(), Blocks.WALL_TORCH.getDefaultState().with(Properties.HORIZONTAL_FACING, Direction.WEST));
        assertFalse(AgentReturnableMine.protectedCutAttachment(terrain, cap), "a light attached to a different wall");
    }

    @Test
    void aLevelPassageNeedsRealSideFacesAndASeparateDryReturnableTread() {
        var terrain = new Terrain(new HashMap<>());
        BlockPos side = RIM.east();
        BlockState stone = Blocks.STONE.getDefaultState(), dirt = Blocks.DIRT.getDefaultState();
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        Box hull = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        terrain.blocks.put(RIM.down(), stone);
        terrain.blocks.put(side, stone);
        terrain.blocks.put(side.up(), dirt);
        Vec3d floorAim = AgentReturnableMine.proofFloorAim(side, EAST, 0);
        Vec3d footAim = AgentReturnableMine.driftCutAim(side, EAST, false);
        assertFalse(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side, EAST,
            terrain.ray(eye, Vec3d.ofCenter(side)), hull), "a standing ray to the center first hits the solid head");
        assertTrue(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side, EAST,
            terrain.ray(eye, footAim), hull));
        assertTrue(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side.up(), EAST,
            terrain.ray(eye, AgentReturnableMine.driftCutAim(side.up(), EAST, true)), hull));
        assertNull(AgentReturnableMine.witnessedTransit(RIM, side, EAST, terrain.ray(eye, floorAim),
            stone, dirt, true), "a rock wall does not witness its floor");

        terrain.blocks.remove(side.up());
        terrain.blocks.remove(side);
        terrain.blocks.put(side.down(2), dirt);
        assertFalse(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side, EAST,
            terrain.ray(eye, footAim), hull), "an open gap is not a cuttable side");
        assertNull(AgentReturnableMine.witnessedTransit(RIM, side, EAST, terrain.ray(eye, floorAim),
            stone, dirt, true), "a cut and clear passage still cannot authorize a step over a gap");

        terrain.blocks.put(side.down(), dirt);
        Box sweep = AgentSurfaceTread.retainedTreadSweep(RIM, side, 0.60);
        assertTrue(terrain.clear(sweep));
        assertNotNull(AgentReturnableMine.witnessedTransit(RIM, side, EAST, terrain.ray(eye, floorAim),
            stone, dirt, terrain.clear(sweep)));
        Vec3d newEye = Vec3d.ofBottomCenter(side).add(0, 1.62, 0);
        BlockHitResult returnTop = terrain.ray(newEye, AgentReturnableMine.proofFloorAim(RIM, Direction.WEST, 0));
        Box reverse = AgentSurfaceTread.retainedTreadSweep(side, RIM, 0.60);
        assertNotNull(AgentReturnableMine.witnessedTransit(side, RIM, Direction.WEST, returnTop, dirt, stone,
            terrain.clear(reverse)));
        terrain.blocks.put(RIM.up(), stone);
        assertNull(AgentReturnableMine.witnessedTransit(side, RIM, Direction.WEST, returnTop, dirt, stone,
            terrain.clear(reverse)), "a changed source ceiling blocks the exact return passage");
    }

    @Test
    void aLevelSideCannotCutItsFloorAnAttachedLightOrAnUnsafeFace() {
        var terrain = new Terrain(new HashMap<>());
        BlockPos side = RIM.east();
        BlockState stone = Blocks.STONE.getDefaultState();
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        Box hull = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        terrain.blocks.put(RIM.down(), stone);
        terrain.blocks.put(side, stone);
        terrain.blocks.put(side.down(), stone);
        Vec3d footAim = AgentReturnableMine.driftCutAim(side, EAST, false);
        terrain.blocks.put(side.east(), Blocks.WALL_TORCH.getDefaultState().with(Properties.HORIZONTAL_FACING, EAST));
        assertFalse(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side, EAST,
            terrain.ray(eye, footAim), hull));
        terrain.blocks.remove(side.east());
        terrain.blocks.put(side.up(), Blocks.FURNACE.getDefaultState());
        assertFalse(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side, EAST,
            terrain.ray(eye, footAim), hull));
        terrain.blocks.remove(side.up());
        assertFalse(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side.down(), EAST, top(side.down()), hull));
        assertFalse(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side, EAST,
            terrain.ray(eye, footAim), hull.offset(0.3, 0, 0)));
        terrain.blocks.put(side, Blocks.LAVA.getDefaultState());
        assertFalse(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side, EAST,
            terrain.ray(eye, footAim), hull));
        terrain.blocks.put(side, Blocks.GRAVEL.getDefaultState());
        assertFalse(AgentReturnableMine.stationaryDriftCut(terrain, RIM, side, EAST,
            terrain.ray(eye, footAim), hull));
    }

    @Test
    void aFloorResampleStillRequiresTheSameFullTopAndDoesNotReplaceTheSweep() {
        var terrain = new Terrain(new HashMap<>());
        BlockPos lower = RIM.east().down();
        BlockState stone = Blocks.STONE.getDefaultState();
        terrain.blocks.put(RIM.down(), stone);
        terrain.blocks.put(lower.down(), stone);
        // Select the vanilla trapdoor orientation occupying the far strip of
        // this column. It masks the first top sample, not the inner one.
        BlockState trapdoor = Blocks.OAK_TRAPDOOR.getDefaultState().with(Properties.OPEN, true);
        BlockState farStrip = java.util.stream.Stream.of(EAST, Direction.WEST)
            .map(direction -> trapdoor.with(Properties.HORIZONTAL_FACING, direction))
            .filter(state -> state.getCollisionShape(terrain, lower).getBoundingBox().minX > 0.8)
            .findFirst().orElseThrow();
        terrain.blocks.put(lower, farStrip);
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        assertTrue(terrain.ray(eye, AgentReturnableMine.proofFloorAim(lower, EAST, 0)).getBlockPos().equals(lower));
        BlockHitResult alternate = terrain.ray(eye, AgentReturnableMine.proofFloorAim(lower, EAST, 1));
        assertNotNull(AgentReturnableMine.witnessedTransit(RIM, lower, EAST, alternate, stone, stone, true));
        Box lowerBody = AgentSurfaceTread.retainedTreadSweep(lower, lower, 0.60);
        assertFalse(terrain.clear(lowerBody));
        assertNull(AgentReturnableMine.witnessedTransit(RIM, lower, EAST, alternate, stone, stone, terrain.clear(lowerBody)));
    }

    @Test
    void oneMissingStairSupportCanUseARealAdjacentFaceWithoutAuthorizingTheDescent() {
        var terrain = new Terrain(new HashMap<>());
        BlockState stone = Blocks.STONE.getDefaultState(), cobble = Blocks.COBBLESTONE.getDefaultState();
        BlockPos tread = new BlockPos(1, 63, 0), cell = new BlockPos(1, 62, 0);
        BlockPos anchor = new BlockPos(2, 62, 0);
        terrain.blocks.put(RIM.down(), stone);
        terrain.blocks.put(anchor, stone);
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        Box hull = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        var build = new AgentReturnableMine.Foothold(RIM, EAST, stone, 0);
        assertEquals(cell, build.cell);
        Vec3d floor = AgentReturnableMine.proofFloorAim(tread, EAST, 1);
        assertEquals(HitResult.Type.MISS, terrain.ray(eye, floor).getType());

        var hit = terrain.ray(eye, AgentBody.footholdAttachmentAim(anchor, EAST, EAST));
        assertEquals(Direction.WEST, hit.getSide());
        assertEquals(cell, hit.getBlockPos().offset(hit.getSide()));
        var low = terrain.footholdSpace(eye, build.low, cell);
        var high = terrain.footholdSpace(eye, build.high, cell);
        assertNull(build.placementRefusal(hull, 9, false, low, high, hit));
        assertFalse(build.confirms(20, top(cell), cobble, 8), "a proposal alone has no placement receipt");
        assertNull(AgentReturnableMine.witnessedTransit(RIM, tread, EAST, terrain.ray(eye, floor),
            stone, cobble, true), "an admitted use cannot act as floor evidence");

        build.issued(20, 9);
        terrain.blocks.put(cell, cobble);
        BlockHitResult actualTop = terrain.ray(eye, floor);
        assertFalse(build.confirms(20, actualTop, cobble, 8), "pre-use render is not evidence");
        assertFalse(build.confirms(21, actualTop, cobble, 9), "block appearance without the debit");
        assertFalse(build.confirms(21, actualTop, cobble, 7), "two fewer is not the exact debit");
        assertFalse(build.confirms(21, null, cobble, 8), "debit without a witnessed top");
        assertFalse(build.confirms(21, top(cell.down()), cobble, 8), "wrong support cell");
        assertFalse(build.confirms(21, actualTop, stone, 8), "wrong placed material");
        assertTrue(build.confirms(21, actualTop, cobble, 8));
        Box treadSweep = AgentSurfaceTread.retainedTreadSweep(RIM, tread, 0.60);
        Box reverseSweep = AgentSurfaceTread.reverseJumpSweep(RIM, tread, EAST, 0.60);
        assertNotNull(AgentReturnableMine.witnessedTransit(RIM, tread, EAST, actualTop, stone, cobble,
            terrain.clear(treadSweep) && terrain.clear(reverseSweep)));
        terrain.blocks.put(tread.up(3), stone);
        assertTrue(terrain.clear(treadSweep), "the walking envelope still fits under the obstructed jump");
        assertNull(AgentReturnableMine.witnessedTransit(RIM, tread, EAST, actualTop, stone, cobble,
            terrain.clear(treadSweep) && terrain.clear(reverseSweep)),
            "a placement receipt cannot waive the reverse clearance");
    }

    @Test
    void anExactFootholdRefusesOcclusionWaterOccupiedCellsAndTheWorkshopReserve() {
        var terrain = new Terrain(new HashMap<>());
        BlockState stone = Blocks.STONE.getDefaultState();
        var build = new AgentReturnableMine.Foothold(RIM, EAST, stone, 0);
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        Box hull = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        BlockPos cell = build.cell, anchor = cell.east();
        terrain.blocks.put(RIM.down(), stone);
        terrain.blocks.put(anchor, stone);
        BlockHitResult face = terrain.ray(eye, AgentBody.footholdAttachmentAim(anchor, EAST, EAST));
        var empty = AgentBody.FootholdSpace.EMPTY;
        assertNotNull(build.placementRefusal(hull, 8, false, empty, empty, face));
        assertNotNull(build.placementRefusal(hull, 9, true, empty, empty, face), "occupied by an entity");
        assertNotNull(build.placementRefusal(hull.offset(0.3, 0, 0), 9, false, empty, empty, face));
        assertNotNull(build.placementRefusal(hull, 9, false, empty, empty, top(anchor)), "wrong attaching side");
        assertNotNull(build.placementRefusal(hull, 9, false, AgentBody.FootholdSpace.DARK, empty, face));

        terrain.blocks.put(cell.up(), stone);
        var occluded = terrain.footholdSpace(eye, build.high, cell);
        assertEquals(AgentBody.FootholdSpace.OCCLUDED, occluded);
        assertNotNull(build.placementRefusal(hull, 9, false, empty, occluded, face));
        terrain.blocks.remove(cell.up());
        terrain.blocks.put(cell, Blocks.WATER.getDefaultState());
        var water = terrain.footholdSpace(eye, build.low, cell);
        assertEquals(AgentBody.FootholdSpace.FLUID, water);
        assertNotNull(build.placementRefusal(hull, 9, false, water, empty, face));
        terrain.blocks.put(cell, stone);
        var occupied = terrain.footholdSpace(eye, build.high, cell);
        assertEquals(AgentBody.FootholdSpace.OCCUPIED, occupied);
        assertNotNull(build.placementRefusal(hull, 9, false, empty, occupied, face));
    }

    @Test
    void aVisibleLevelShelfCanAttachTheConnectorWhenTheLowerCellCannot() {
        var terrain = new Terrain(new HashMap<>());
        BlockState stone = Blocks.STONE.getDefaultState(), cobble = Blocks.COBBLESTONE.getDefaultState();
        BlockPos bridge = RIM.east(), shelf = bridge.east();
        terrain.blocks.put(RIM.down(), stone);
        terrain.blocks.put(shelf.down(), stone);
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        Box hull = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        var lower = new AgentReturnableMine.Foothold(RIM, EAST, stone, 0);
        var level = new AgentReturnableMine.Foothold(RIM, EAST, stone, 0, true);
        assertEquals(bridge.down(), level.cell);
        assertEquals(HitResult.Type.MISS,
            terrain.ray(eye, AgentReturnableMine.proofFloorAim(lower.landing, EAST, 1)).getType());
        var anchor = terrain.ray(eye, AgentBody.footholdAttachmentAim(shelf.down(), EAST, EAST));
        assertEquals(Direction.WEST, anchor.getSide());
        var emptyLow = terrain.footholdSpace(eye, level.low, level.cell);
        var emptyHigh = terrain.footholdSpace(eye, level.high, level.cell);
        assertNotNull(lower.placementRefusal(hull, 9, false, emptyLow, emptyHigh, anchor),
            "this real attaching face is one block above the attempted stair support");
        assertNotNull(level.placementRefusal(hull, 9, false, emptyLow, emptyHigh, anchor),
            "an attachment alone is not a reason to build");

        var shelfAim = AgentReturnableMine.proofFloorAim(shelf, EAST, 0);
        var shelfTop = terrain.ray(eye, shelfAim);
        Box onwardSweep = AgentSurfaceTread.retainedTreadSweep(bridge, shelf, 0.60);
        level.outlet = AgentReturnableMine.witnessedLevelOutlet(RIM, bridge, shelfTop, stone, terrain.clear(onwardSweep));
        assertNotNull(level.outlet);
        assertNull(level.placementRefusal(hull, 9, false, emptyLow, emptyHigh, anchor));
        var bridgeAim = AgentReturnableMine.proofFloorAim(bridge, EAST, 0);
        level.issued(20, 9);
        assertFalse(level.confirms(21, terrain.ray(eye, bridgeAim), cobble, 8),
            "debit alone still does not witness the installed top");
        terrain.blocks.put(level.cell, cobble);
        var placedTop = terrain.ray(eye, bridgeAim);
        assertFalse(level.confirms(20, placedTop, cobble, 8));
        assertFalse(level.confirms(21, placedTop, cobble, 9));
        assertTrue(level.confirms(21, placedTop, cobble, 8));
        var outbound = AgentReturnableMine.witnessedTransit(RIM, bridge, EAST, placedTop, stone, cobble,
            terrain.clear(AgentSurfaceTread.retainedTreadSweep(RIM, bridge, 0.60)));
        assertNotNull(outbound);
        assertEquals(outbound.upper().getY(), outbound.lower().getY());
        assertNull(AgentReturnableMine.witnessedTransit(RIM, bridge, EAST, placedTop, null, cobble, true),
            "a new top is no substitute for the retained source support");
        var fromBridge = Vec3d.ofBottomCenter(bridge).add(0, 1.62, 0);
        assertNotNull(AgentReturnableMine.witnessedTransit(bridge, RIM, Direction.WEST,
            terrain.ray(fromBridge, AgentReturnableMine.proofFloorAim(RIM, Direction.WEST, 0)), cobble, stone,
            terrain.clear(AgentSurfaceTread.retainedTreadSweep(bridge, RIM, 0.60))),
            "the original support is still usable in reverse");
    }

    @Test
    void aLevelConnectorWillNotLeadToMissingSupportOrThroughBlockedHeadroom() {
        var terrain = new Terrain(new HashMap<>());
        BlockState stone = Blocks.STONE.getDefaultState();
        BlockPos bridge = RIM.east(), shelf = bridge.north();
        Vec3d eye = Vec3d.ofBottomCenter(RIM).add(0, 1.62, 0);
        Vec3d floor = AgentReturnableMine.proofFloorAim(shelf, Direction.NORTH, 0);
        assertNull(AgentReturnableMine.witnessedLevelOutlet(RIM, bridge, terrain.ray(eye, floor), stone, true));
        assertNull(AgentReturnableMine.witnessedLevelOutlet(RIM, bridge, top(RIM.down()), stone, true),
            "the original support is a return, not worthwhile onward terrain");

        terrain.blocks.put(shelf.down(), stone);
        var shown = terrain.ray(eye, floor);
        Box onwardSweep = AgentSurfaceTread.retainedTreadSweep(bridge, shelf, 0.60);
        assertNotNull(AgentReturnableMine.witnessedLevelOutlet(RIM, bridge, shown, stone, terrain.clear(onwardSweep)));
        terrain.blocks.put(shelf.up(), stone);
        assertNull(AgentReturnableMine.witnessedLevelOutlet(RIM, bridge, shown, stone, terrain.clear(onwardSweep)));
    }

    @Test
    void theHollowCanBeLeftByAWitnessedRiseButAirLavaAndHeadObstructionCannotAdmitIt() {
        BlockPos hollow = RIM.west().down(), riser = RIM.down();
        BlockState dirt = Blocks.DIRT.getDefaultState(), grass = Blocks.GRASS_BLOCK.getDefaultState();
        assertNotNull(AgentReturnableMine.witnessedTransit(hollow, RIM, EAST, top(riser), dirt, grass, true));
        assertNull(AgentReturnableMine.witnessedTransit(hollow, RIM, EAST, null, dirt, grass, true),
            "a clear collision sweep is not a positive observation of footing");
        assertNull(AgentReturnableMine.witnessedTransit(hollow, RIM, EAST, top(riser), dirt,
            Blocks.LAVA.getDefaultState(), true));
        assertNull(AgentReturnableMine.witnessedTransit(hollow, RIM, EAST, top(riser), dirt, grass, false),
            "the seen riser cannot authorize a jump with no usable headroom");
        assertNull(AgentReturnableMine.witnessedTransit(hollow, RIM, EAST, top(riser.down()), dirt, grass, true),
            "the top must be at the exact planned height");
    }

    @Test
    void relocatingThroughLevelTerrainDoesNotRecycleTheExhaustedMineLocus() {
        var loci = new AgentReturnableMine.Loci();
        loci.exhausted(RIM);
        BlockState grass = Blocks.GRASS_BLOCK.getDefaultState();
        assertNotNull(AgentReturnableMine.witnessedTransit(RIM, RIM.east(), EAST, top(RIM.east().down()),
            grass, grass, true), "a checked level edge is movement, not an excavation outcome");
        assertNull(AgentReturnableMine.witnessedTransit(RIM, RIM.east(2), EAST, top(RIM.east(2).down()),
            grass, grass, true), "a visible farther top cannot authorize skipping the intervening cell");
        assertFalse(loci.fresh(RIM));
        assertFalse(loci.fresh(RIM.east().down()), "moving into a neighboring hole is not a new mine start");
        assertFalse(loci.fresh(RIM.east(2)));
        assertTrue(loci.fresh(RIM.east(3)));
        loci.exhausted(RIM.east(3));
        assertFalse(loci.fresh(RIM.east(2)), "turning back through the old site is not another start");
        assertTrue(loci.fresh(RIM.north(3)));
    }

    private static BlockHitResult top(BlockPos block) {
        return new BlockHitResult(Vec3d.ofBottomCenter(block.up()), Direction.UP, block, false);
    }

    private record Terrain(Map<BlockPos, BlockState> blocks) implements BlockView {
        BlockHitResult ray(Vec3d eye, Vec3d point) {
            return raycast(new RaycastContext(eye, point, RaycastContext.ShapeType.COLLIDER,
                RaycastContext.FluidHandling.ANY, ShapeContext.absent()));
        }

        AgentBody.FootholdSpace footholdSpace(Vec3d eye, Vec3d point, BlockPos cell) {
            return AgentBody.classifyFootholdSpace(this, cell, raycast(new RaycastContext(eye, point,
                RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.ANY, ShapeContext.absent())));
        }

        boolean clear(Box sweep) {
            for (var entry : blocks.entrySet()) {
                BlockPos pos = entry.getKey();
                for (Box box : entry.getValue().getCollisionShape(this, pos).getBoundingBoxes()) {
                    if (box.offset(pos.getX(), pos.getY(), pos.getZ()).intersects(sweep)) return false;
                }
            }
            return true;
        }

        @Override public BlockState getBlockState(BlockPos pos) { return blocks.getOrDefault(pos, Blocks.AIR.getDefaultState()); }
        @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
        @Override public net.minecraft.block.entity.BlockEntity getBlockEntity(BlockPos pos) { return null; }
        @Override public int getHeight() { return 128; }
        @Override public int getBottomY() { return 0; }
    }
}
