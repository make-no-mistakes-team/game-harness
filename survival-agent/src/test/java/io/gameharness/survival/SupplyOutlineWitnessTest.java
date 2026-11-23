package io.gameharness.survival;

import io.gameharness.survival.AgentBody.OutlineClearance;
import io.gameharness.survival.AgentSupplyOutline.CutAdmission;
import java.util.Map;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ShapeContext;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.fluid.FluidState;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class SupplyOutlineWitnessTest {
    private static final Vec3d EYE = new Vec3d(0.5, 64.5, 0.5);
    private static final Vec3d NEAR = new Vec3d(1.5, 64.5, 0.5);
    private static final Vec3d FAR = new Vec3d(4.0, 64.5, 0.5);
    private static final BlockPos WALL = new BlockPos(3, 64, 0);
    private static final BlockPos FOREGROUND = new BlockPos(1, 64, 0);
    private static final double REACH = 4.0;
    private static final Vec3d CAP_EYE = EYE.add(0, 0.8, 0);
    private static final BlockPos CAP = FOREGROUND.up();
    private static final BlockPos CAP_BACKSTOP = WALL.up();
    private static final Box BELOW_CUT = new Box(1.20, 62, 0.20, 1.80, 63.80, 0.80);
    private static final Box ABOVE_CUT = BELOW_CUT.offset(0, 3, 0);
    private static final Box BESIDE_CUT = BELOW_CUT.offset(-1, 0, 0);

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

    @Test void onlyOrdinaryEarthAndRockAreEligibleForEscapeWork() {
        assertTrue(AgentSupplyOutline.escapeMaterial(Blocks.STONE.getDefaultState()));
        assertTrue(AgentSupplyOutline.escapeMaterial(Blocks.DIRT.getDefaultState()));
        assertTrue(AgentSupplyOutline.escapeMaterial(Blocks.ANDESITE.getDefaultState()));
        for (Block denied : new Block[]{Blocks.COPPER_ORE, Blocks.IRON_ORE, Blocks.DEEPSLATE_DIAMOND_ORE, Blocks.BEDROCK, Blocks.GRAVEL,
                Blocks.MAGMA_BLOCK, Blocks.WATER, Blocks.CRAFTING_TABLE, Blocks.FURNACE, Blocks.TORCH}) {
            assertFalse(AgentSupplyOutline.escapeMaterial(denied.getDefaultState()), denied.toString());
        }
    }

    @Test void onlyAnExistingNativeCrackOnTheUnchangedDrawnFaceMayBridgeABriefGap() {
        BlockHitResult hit = wall().vanillaHit();
        var otherSide = new BlockHitResult(hit.getPos(), Direction.UP, WALL, false);
        var otherBlock = new BlockHitResult(hit.getPos(), Direction.WEST, WALL.east(), false);
        var work = new AgentSupplyOutline.EscapeWork();
        BlockState stone = Blocks.STONE.getDefaultState();
        work.start(hit, stone, ItemStack.EMPTY, 20);
        work.drawn(20, 1_000_000_000L);
        assertTrue(work.matches(hit, stone, ItemStack.EMPTY));
        assertFalse(work.matches(hit, Blocks.DIRT.getDefaultState(), ItemStack.EMPTY));
        assertFalse(work.matches(hit, stone, new ItemStack(Items.WOODEN_PICKAXE)));
        float crack = AgentSupplyOutline.observedCrack(WALL, WALL, 0.25f);
        assertTrue(work.bridges(hit, hit, 23, 1_150_000_000L, crack));
        assertFalse(work.bridges(hit, hit, 24, 1_150_000_000L, crack));
        assertFalse(work.bridges(hit, hit, 23, 1_201_000_000L, crack));
        assertFalse(work.bridges(otherSide, hit, 23, 1_150_000_000L, crack));
        assertFalse(work.bridges(hit, otherBlock, 23, 1_150_000_000L, crack));
        assertFalse(work.bridges(hit, hit, 23, 1_150_000_000L,
            AgentSupplyOutline.observedCrack(WALL, WALL.east(), 0.25f)));
        assertFalse(work.bridges(hit, hit, 23, 1_150_000_000L,
            AgentSupplyOutline.observedCrack(WALL, WALL, Float.NaN)));
        work.forget();
        assertFalse(work.bridges(hit, hit, 21, 1_050_000_000L, crack));
    }

    @Test void vanillaHandWorkMustFitAndActuallyAdvanceWithinTheDeadline() {
        var work = new AgentSupplyOutline.EscapeWork();
        var hit = wall().vanillaHit();
        // A dry grounded empty hand takes about 150 ticks on stone, and 300 on deepslate.
        float handStone = 1 / 150f;
        assertEquals(OutlineClearance.REQUESTED, work.check(100, handStone, 0));
        assertEquals(OutlineClearance.REQUESTED, work.check(100, 1 / 45f, 0));
        assertEquals(OutlineClearance.TOO_SLOW, work.check(100, 1 / 300f, 0));
        assertEquals(OutlineClearance.TOO_SLOW, work.check(100, 0, 0));
        assertEquals(OutlineClearance.TOO_SLOW, work.check(100, Float.POSITIVE_INFINITY, 0));
        work.start(hit, Blocks.STONE.getDefaultState(), ItemStack.EMPTY, 100);
        assertEquals(OutlineClearance.REQUESTED, work.check(105, handStone, handStone));
        assertEquals(OutlineClearance.REQUESTED, work.check(116, handStone, handStone));
        assertEquals(OutlineClearance.STALLED, work.check(117, handStone, handStone));
        assertEquals(OutlineClearance.EXPIRED, work.check(266, handStone, 0.99f));
    }

    @Test void onlyAStillAdvancingNativeCrackCanFinishPastThePassageDeadline() {
        var work = new AgentSupplyOutline.EscapeWork();
        var hit = wall().vanillaHit();
        float handStone = 1 / 150f;
        assertFalse(work.finishing(100, 0.5f), "never start a cut after the passage deadline");
        work.start(hit, Blocks.STONE.getDefaultState(), ItemStack.EMPTY, 100);
        assertFalse(work.finishing(101, 0), "a held attack without a native crack does not count");
        work.check(179, handStone, 0.50f);
        assertTrue(work.finishing(180, 0.51f), "the ordinary stone cut is still advancing");
        assertFalse(work.finishing(191, 0.50f), "a stuck crack cannot buy more time");
        assertFalse(work.finishing(192, 0.25f), "resetting to a smaller crack is not progress");
        assertEquals(OutlineClearance.STALLED, work.check(181, handStone, 0), "release cannot start a new swing");
        assertFalse(work.finishing(266, 0.99f), "even real progress cannot exceed the single-cut bound");
        assertFalse(work.broke(WALL.east(), Blocks.STONE.getDefaultState()));
        assertFalse(work.broke(WALL, Blocks.DIRT.getDefaultState()), "a block update does not complete the attack");
        assertTrue(work.broke(WALL, Blocks.STONE.getDefaultState()));
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

    @Test void unknownCoverAllowsOnlyAnOffColumnCut() {
        var cover = new AgentSupplyOutline.CutCover();
        cover.watch(FOREGROUND, 10);
        assertTrue(cover.allows(FOREGROUND, BESIDE_CUT, 10, 10));
        assertFalse(AgentSupplyOutline.CutCover.underColumn(FOREGROUND, BESIDE_CUT));
        assertTrue(AgentSupplyOutline.CutCover.underColumn(FOREGROUND, BELOW_CUT));
        assertEquals(CutAdmission.UNKNOWN_OVERHEAD, cover.admission(FOREGROUND, BELOW_CUT, 10, 10));
        assertEquals(CutAdmission.BLOCKED, cover.admission(FOREGROUND, ABOVE_CUT, 10, 10));
        assertFalse(cover.allows(FOREGROUND, BELOW_CUT, 10, 10));
        assertFalse(cover.allows(FOREGROUND, ABOVE_CUT, 10, 10));
        assertFalse(cover.allows(FOREGROUND, BESIDE_CUT.offset(0.21, 0, 0), 10, 10));
    }

    @Test void onlyTheDrawnCapCanAuthorizeOverheadOrVetoSideways() {
        var cover = new AgentSupplyOutline.CutCover();
        cover.watch(FOREGROUND, 10);
        BlockState stone = Blocks.STONE.getDefaultState();
        var stable = new Corridor(Map.of(CAP, stone));
        BlockHitResult cap = stable.vanillaHit(CAP_EYE, FAR.add(0, 0.8, 0));
        assertEquals(CAP, cap.getBlockPos());
        assertEquals(Direction.WEST, cap.getSide());
        cover.observe(cap, stone, CAP_EYE, 0.4, 10, 10);
        assertFalse(cover.allows(FOREGROUND, BELOW_CUT, 10, 10)); // A remote outline is not admitted.
        cover.observe(cap, stone, CAP_EYE, REACH, 10, 10);
        assertTrue(cover.allows(FOREGROUND, BELOW_CUT, 10, 10));
        assertFalse(cover.allows(FOREGROUND, ABOVE_CUT, 10, 10)); // Never the bearing column underfoot.

        BlockState gravel = Blocks.GRAVEL.getDefaultState();
        var falling = new Corridor(Map.of(CAP, gravel));
        cover.observe(falling.vanillaHit(CAP_EYE, FAR.add(0, 0.8, 0)), gravel, CAP_EYE, REACH, 10, 11);
        assertEquals(CutAdmission.BLOCKED, cover.admission(FOREGROUND, BELOW_CUT, 10, 11));
        assertFalse(cover.allows(FOREGROUND, BESIDE_CUT, 10, 11));
        cover.watch(FOREGROUND, 11);
        assertTrue(cover.allows(FOREGROUND, BESIDE_CUT, 11, 501_000_000L));
        assertFalse(cover.allows(FOREGROUND, BELOW_CUT, 11, 501_000_000L));

        cover.observe(cap, stone, CAP_EYE, REACH, 11, 501_000_001L);
        cover.forget(); // Exposure, new view/world, or release.
        cover.watch(FOREGROUND, 11);
        assertFalse(cover.allows(FOREGROUND, BELOW_CUT, 11, 501_000_001L));
    }

    @Test void aDrawnWallTorchVetoesOnlyIfAttachedToTheCut() {
        var cover = new AgentSupplyOutline.CutCover();
        cover.watch(FOREGROUND, 10);
        BlockPos neighbor = FOREGROUND.west();
        Vec3d outside = EYE.add(-1, -0.2, 0);
        BlockState wallTorch = Blocks.WALL_TORCH.getDefaultState().with(Properties.HORIZONTAL_FACING, Direction.WEST);
        var corridor = new Corridor(Map.of(neighbor, wallTorch));
        BlockHitResult torch = corridor.vanillaHit(outside, EYE.add(1, 0.3, 0));
        assertEquals(HitResult.Type.BLOCK, torch.getType());
        assertEquals(neighbor, torch.getBlockPos());
        cover.observe(torch, wallTorch, outside, REACH, 10, 10);
        assertFalse(cover.allows(FOREGROUND, BESIDE_CUT, 10, 10));
        BlockState unrelatedTorch = wallTorch.with(Properties.HORIZONTAL_FACING, Direction.EAST);
        var unrelated = new Corridor(Map.of(neighbor, unrelatedTorch));
        cover.observe(unrelated.vanillaHit(outside, EYE.add(1, 0.3, 0)), unrelatedTorch, outside, REACH, 10, 11);
        assertTrue(cover.allows(FOREGROUND, BESIDE_CUT, 10, 11));
    }

    @Test void onlyAPositiveDryLoadZonePrefixCanSupplyCoverEvidence() {
        var cover = new AgentSupplyOutline.CutCover();
        cover.watch(FOREGROUND, 10);
        Vec3d end = FAR.add(0, 0.8, 0);
        BlockState stone = Blocks.STONE.getDefaultState();
        assertNull(cover.capSample(new Corridor(Map.of()).vanillaHit(CAP_EYE, end), CAP_EYE, REACH, 10, 10));

        var wet = new Corridor(Map.of(CAP, Blocks.WATER.getDefaultState(), CAP_BACKSTOP, stone));
        BlockHitResult backstop = wet.vanillaHit(CAP_EYE, end);
        assertEquals(CAP_BACKSTOP, backstop.getBlockPos());
        Vec3d sample = cover.capSample(backstop, CAP_EYE, REACH, 10, 10);
        assertEquals(Vec3d.ofCenter(FOREGROUND, 1.30), sample);
        assertFalse(AgentSupplyOutline.dryPrefix(wet, ShapeContext.absent(), CAP_EYE, backstop, sample, REACH));
        assertFalse(cover.allows(FOREGROUND, BELOW_CUT, 10, 10));

        var dry = new Corridor(Map.of(CAP_BACKSTOP, stone));
        assertTrue(AgentSupplyOutline.dryPrefix(dry, ShapeContext.absent(), CAP_EYE, backstop, sample, REACH));
        cover.observeDryCapPrefix(10, 10);
        assertTrue(cover.allows(FOREGROUND, BELOW_CUT, 10, 10));
    }

    private static Corridor wall() { return new Corridor(Map.of(WALL, Blocks.STONE.getDefaultState())); }

    private record Corridor(Map<BlockPos, BlockState> blocks) implements BlockView {
        BlockHitResult vanillaHit() { return vanillaHit(EYE, FAR); }

        BlockHitResult vanillaHit(Vec3d eye, Vec3d end) {
            return raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE,
                RaycastContext.FluidHandling.NONE, ShapeContext.absent()));
        }

        @Override public BlockEntity getBlockEntity(BlockPos pos) { return null; }
        @Override public BlockState getBlockState(BlockPos pos) { return blocks.getOrDefault(pos, Blocks.AIR.getDefaultState()); }
        @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
        @Override public int getHeight() { return 384; }
        @Override public int getBottomY() { return -64; }
    }
}
