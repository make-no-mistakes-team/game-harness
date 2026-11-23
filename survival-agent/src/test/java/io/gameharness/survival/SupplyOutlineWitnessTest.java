package io.gameharness.survival;

import java.util.Map;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ShapeContext;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.fluid.FluidState;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class SupplyOutlineWitnessTest {
    private static final Vec3d EYE = new Vec3d(0.5, 64.5, 0.5);
    private static final Vec3d NEAR = new Vec3d(1.5, 64.5, 0.5);
    private static final Vec3d FAR = new Vec3d(4.0, 64.5, 0.5);
    private static final BlockPos WALL = new BlockPos(3, 64, 0);
    private static final BlockPos FOREGROUND = new BlockPos(1, 64, 0);
    private static final double REACH = 4.0;

    @BeforeAll static void bootstrap() { VanillaTestResources.initialize(); }

    @Test void aMissCannotWitnessClearanceEvenWhenBothRaysMiss() {
        var empty = new Corridor(Map.of());
        BlockHitResult miss = empty.vanillaHit();
        assertFalse(AgentSupplyOutline.matchesFace(miss, miss));
        assertFalse(AgentSupplyOutline.dryPrefix(empty, ShapeContext.absent(), EYE, miss, NEAR, REACH));
    }

    @Test void darknessAloneDoesNotAdmitASelectionWithoutTheDrawReceipt() {
        BlockHitResult hit = wall().vanillaHit();
        assertFalse(AgentSupplyOutline.admits(false, 1, 45_000_000L, EYE, EYE, 0, 0, hit, hit, REACH));
        assertTrue(AgentSupplyOutline.admits(true, 1, 45_000_000L, EYE, EYE, 0, 0, hit, hit, REACH));
    }

    @Test void sameFaceDoesNotOverruleAnOldOrMovedView() {
        BlockHitResult hit = wall().vanillaHit();
        assertFalse(AgentSupplyOutline.admits(true, 2, 45_000_000L, EYE, EYE, 0, 0, hit, hit, REACH));
        assertFalse(AgentSupplyOutline.admits(true, 1, 250_000_000L, EYE, EYE, 0, 0, hit, hit, REACH));
        assertFalse(AgentSupplyOutline.admits(true, 1, 45_000_000L, EYE, EYE, 11, 0, hit, hit, REACH));
        assertFalse(AgentSupplyOutline.admits(true, 1, 45_000_000L, EYE, EYE, 0, 11, hit, hit, REACH));
        assertFalse(AgentSupplyOutline.admits(true, 1, 45_000_000L, EYE, EYE.add(0, 0.25, 0), 0, 0,
            hit, hit, REACH));
    }

    @Test void aDifferentBlockOrSideDoesNotAuthenticateTheRenderedFace() {
        BlockHitResult hit = wall().vanillaHit();
        var side = new BlockHitResult(hit.getPos(), Direction.UP, WALL, false);
        var block = new BlockHitResult(hit.getPos(), Direction.WEST, WALL.up(), false);
        assertFalse(AgentSupplyOutline.matchesFace(hit, side));
        assertFalse(AgentSupplyOutline.matchesFace(hit, block));
        assertFalse(AgentBody.matchesDryRouteTop(hit, WALL));
        assertFalse(AgentBody.matchesDryRouteTop(side, WALL)); // The declared UP was not at the full top.
    }

    @Test void foregroundWaterVetoesEvenThoughTheVanillaTargetIsTheSameWall() {
        var flooded = new Corridor(Map.of(WALL, Blocks.STONE.getDefaultState(),
            FOREGROUND, Blocks.WATER.getDefaultState()));
        BlockHitResult hit = flooded.vanillaHit();
        assertTrue(AgentSupplyOutline.matchesFace(wall().vanillaHit(), hit));
        assertFalse(AgentSupplyOutline.drySelectedFace(flooded, ShapeContext.absent(), EYE, hit, REACH));
        assertFalse(AgentSupplyOutline.dryPrefix(flooded, ShapeContext.absent(), EYE, hit, NEAR, REACH));
    }

    @Test void aPhysicalBackstopProvesOnlyItsPositiveAlignedNearPrefix() {
        var corridor = wall();
        BlockHitResult hit = corridor.vanillaHit();
        assertTrue(AgentSupplyOutline.provesPrefix(EYE, NEAR, hit, REACH));
        assertTrue(AgentSupplyOutline.dryPrefix(corridor, ShapeContext.absent(), EYE, hit, NEAR, REACH));
        assertFalse(AgentSupplyOutline.dryPrefix(corridor, ShapeContext.absent(), EYE, hit, hit.getPos(), REACH));
        assertFalse(AgentSupplyOutline.provesPrefix(EYE, EYE, hit, REACH));
        assertFalse(AgentSupplyOutline.provesPrefix(EYE, hit.getPos(), hit, REACH));
        assertFalse(AgentSupplyOutline.provesPrefix(EYE, FAR, hit, REACH));
        assertFalse(AgentSupplyOutline.provesPrefix(EYE, NEAR.add(0, 0.21, 0), hit, REACH));
        assertFalse(AgentSupplyOutline.provesPrefix(EYE, NEAR, hit, 2.0));
        assertFalse(AgentSupplyOutline.provesPrefix(EYE, new Vec3d(Double.NaN, 64, 0), hit, REACH));
        var blocked = new Corridor(Map.of(WALL, Blocks.STONE.getDefaultState(),
            FOREGROUND, Blocks.STONE.getDefaultState()));
        assertFalse(AgentSupplyOutline.dryPrefix(blocked, ShapeContext.absent(), EYE, hit, NEAR, REACH));
    }

    @Test void anAttachmentNeedsAnInteriorPrefixThroughItsExactNeighbor() {
        BlockHitResult hit = wall().vanillaHit();
        assertTrue(AgentSupplyOutline.entersAttachment(EYE, hit, WALL.west()));
        assertFalse(AgentSupplyOutline.entersAttachment(EYE, hit, WALL.up()));
    }

    private static Corridor wall() { return new Corridor(Map.of(WALL, Blocks.STONE.getDefaultState())); }

    private record Corridor(Map<BlockPos, BlockState> blocks) implements BlockView {
        BlockHitResult vanillaHit() {
            return raycast(new RaycastContext(EYE, FAR, RaycastContext.ShapeType.OUTLINE,
                RaycastContext.FluidHandling.NONE, ShapeContext.absent()));
        }

        @Override public BlockEntity getBlockEntity(BlockPos pos) { return null; }
        @Override public BlockState getBlockState(BlockPos pos) { return blocks.getOrDefault(pos, Blocks.AIR.getDefaultState()); }
        @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
        @Override public int getHeight() { return 384; }
        @Override public int getBottomY() { return -64; }
    }
}
