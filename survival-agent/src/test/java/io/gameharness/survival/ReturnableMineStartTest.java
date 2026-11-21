package io.gameharness.survival;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ShapeContext;
import net.minecraft.fluid.FluidState;
import net.minecraft.state.property.Properties;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

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
