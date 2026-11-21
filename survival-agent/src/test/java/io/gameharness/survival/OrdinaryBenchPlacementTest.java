package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import java.util.Map;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ShapeContext;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.fluid.FluidState;
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

final class OrdinaryBenchPlacementTest {
    private static final BlockPos FEET = new BlockPos(0, 64, 0);
    private static final Box AVATAR = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
    private static final Vec3d EYE = new Vec3d(0.5, 65.62, 0.5);

    @BeforeAll
    static void bootstrap() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    @Test
    void aRealLowerShelfTopAllowsATableButNotAnIronWorkshopSite() {
        var shelf = new BlockPos(2, 62, 0);
        var flat = new BlockPos(0, 63, 2);
        var stone = Blocks.STONE.getDefaultState();
        var terrain = new Terrain(Map.of(FEET.down(), stone, shelf, stone, flat, stone));
        var lowerTop = terrain.hit(new Vec3d(2.5, 62.97, 0.5));
        var flatTop = terrain.hit(new Vec3d(0.5, 63.97, 2.5));
        assertFace(lowerTop, shelf, Direction.UP);
        assertFace(flatTop, flat, Direction.UP);

        BlockPos cell = AgentBody.placementCell(lowerTop);
        assertEquals(new BlockPos(2, 63, 0), cell);
        assertTrue(accepts(terrain, lowerTop));
        assertFalse(AgentMacroControl.levelStationSite(terrain, cell, FEET.getY()));
        assertTrue(AgentMacroControl.levelStationSite(terrain, flat.up(), FEET.getY()));
        assertTrue(AgentBody.benchFaceScore(Direction.UP, 0, 12, 4.25 * 4.25)
            < AgentBody.benchFaceScore(Direction.UP, -1, 8, 4.25 * 4.25),
            "prefer an eligible level top even when a lower top is nearer");
    }

    @Test
    void aSideMountIsAllowedOffTheWalkedReturnButNotInItsJumpHeadroom() {
        var wall = new BlockPos(2, 64, 0);
        var lowerFoot = FEET.east().down();
        var stone = Blocks.STONE.getDefaultState();
        var terrain = new Terrain(Map.of(FEET.down(), stone, lowerFoot.down(), stone, wall, stone));
        var side = terrain.hit(new Vec3d(2.03, 64.75, 0.5));
        assertFace(side, wall, Direction.WEST);
        BlockPos cell = AgentBody.placementCell(side);
        assertEquals(new BlockPos(1, 64, 0), cell);
        assertTrue(accepts(terrain, side));

        var walked = new AgentWalkedRoute();
        assertFalse(walked.blocksPlacement(cell), "a sighting alone is not a demonstrated return");
        walked.landed(FEET.asLong(), lowerFoot.asLong());
        assertTrue(walked.blocksPlacement(cell), "at standing height over the lower return footing");
        assertTrue(walked.blocksPlacement(cell.up(2)), "the reverse jump also needs the upper crown");
        assertTrue(walked.blocksPlacement(lowerFoot.down()), "preserve the exact return floor");
        assertFalse(walked.blocksPlacement(cell.south()), "preserve only the demonstrated lane");
    }

    @Test
    void aReachableSideCannotPlaceThroughTheBodyOrIntoFluid() {
        var wall = FEET.east().up();
        var stone = Blocks.STONE.getDefaultState();
        var terrain = new Terrain(Map.of(FEET.down(), stone, wall, stone));
        var side = terrain.hit(new Vec3d(1.03, 65.45, 0.5));
        assertFace(side, wall, Direction.WEST);
        assertFalse(accepts(terrain, side));

        var farWall = FEET.east(2);
        var dry = new Terrain(Map.of(FEET.down(), stone, farWall, stone));
        var contact = dry.hit(new Vec3d(2.03, 64.65, 0.5));
        assertFace(contact, farWall, Direction.WEST);
        assertTrue(accepts(dry, contact));
        for (var fluid : new BlockState[] {Blocks.WATER.getDefaultState(), Blocks.LAVA.getDefaultState()}) {
            var flooded = new Terrain(Map.of(FEET.down(), stone, farWall, stone, FEET.east(), fluid));
            assertFalse(accepts(flooded, contact));
        }
        for (var support : new BlockState[] {Blocks.SAND.getDefaultState(), Blocks.MAGMA_BLOCK.getDefaultState()}) {
            var unsafe = new Terrain(Map.of(FEET.down(), stone, farWall, support));
            assertFalse(accepts(unsafe, unsafe.hit(new Vec3d(2.03, 64.65, 0.5))));
        }
    }

    private static boolean accepts(Terrain terrain, BlockHitResult hit) {
        return AgentMacroControl.benchSpace(terrain, hit, AgentBody.placementCell(hit), AVATAR);
    }

    private static void assertFace(BlockHitResult hit, BlockPos support, Direction side) {
        assertEquals(HitResult.Type.BLOCK, hit.getType());
        assertEquals(support, hit.getBlockPos());
        assertEquals(side, hit.getSide());
        assertTrue(hit.getPos().squaredDistanceTo(EYE) < 4.25 * 4.25);
    }

    private record Terrain(Map<BlockPos, BlockState> blocks) implements BlockView {
        BlockHitResult hit(Vec3d insideFace) {
            return raycast(new RaycastContext(EYE, insideFace, RaycastContext.ShapeType.OUTLINE,
                RaycastContext.FluidHandling.NONE, ShapeContext.absent()));
        }

        @Override public BlockEntity getBlockEntity(BlockPos pos) { return null; }
        @Override public BlockState getBlockState(BlockPos pos) { return blocks.getOrDefault(pos, Blocks.AIR.getDefaultState()); }
        @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
        @Override public int getHeight() { return 384; }
        @Override public int getBottomY() { return -64; }
    }
}
