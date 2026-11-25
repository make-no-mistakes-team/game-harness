package io.gameharness.survival;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import net.minecraft.block.Blocks;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import net.minecraft.util.shape.VoxelShape;
import net.minecraft.util.shape.VoxelShapes;
import net.minecraft.world.EmptyBlockView;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class AgentCombatGeometryTest {
    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
    }

    @Test
    void inactiveAndExpiredCallsNeverTouchWorldGeometry() {
        var field = new Field();
        var geometry = new AgentCombatGeometry();
        assertFalse(geometry.refresh(field, 0, 10));
        assertEquals(AgentCombatGeometry.Status.STALE, candidate(geometry, field, 0, 10, 0, -1, 0).status());
        assertEquals(0, field.loadedCalls);
        assertEquals(0, field.queries.size());
        assertTrue(geometry.refresh(field, 7, 10));
        assertEquals(0, field.loadedCalls, "activation alone must not scan a room");
        assertEquals(AgentCombatGeometry.Status.STALE, candidate(geometry, field, 7, 12, 0, -1, 0).status());
        assertEquals(0, field.loadedCalls);
        geometry.invalidate();
        assertEquals(AgentCombatGeometry.Status.STALE, candidate(geometry, field, 7, 12, 0, -1, 0).status());
        assertEquals(0, field.loadedCalls);
    }

    @Test
    void rearFloorAndRearCliffDifferWithoutAnyViewOrLightInput() {
        var floor = new Field();
        var cliff = new Field();
        cliff.floorMinimumZ = 0;
        var clear = new AgentCombatGeometry();
        var edge = new AgentCombatGeometry();
        clear.refresh(floor, 3, 10);
        edge.refresh(cliff, 3, 10);
        var receipt = candidate(clear, floor, 3, 10, 0, -1, 0);
        assertEquals(AgentCombatGeometry.Status.FLAT, receipt.status());
        assertTrue(receipt.admitted());
        assertEquals(new BlockPos(0, 1, -1), receipt.to());
        assertEquals(AgentCombatGeometry.Status.CLIFF, candidate(edge, cliff, 3, 10, 0, -1, 0).status());
        assertTrue(floor.queries.stream().anyMatch(p -> p.getZ() < 0));
    }

    @Test
    void nearerWallPreventsAnyProbeIntoTheClosedCavityBehindIt() {
        var field = new Field();
        field.shapes.put(new BlockPos(1, 1, 0), VoxelShapes.fullCube());
        field.shapes.put(new BlockPos(1, 2, 0), VoxelShapes.fullCube());
        // This distant shape must be irrelevant: neither it nor the intervening cavity may be read.
        field.shapes.put(new BlockPos(3, 1, 0), VoxelShapes.fullCube());
        var geometry = new AgentCombatGeometry();
        geometry.refresh(field, 4, 10);
        var result = geometry.candidate(field, 4, 10, 1, 0, 2.5, 0, 0.1);
        assertEquals(AgentCombatGeometry.Status.WALL, result.status());
        assertFalse(result.admitted());
        assertFalse(field.queries.stream().anyMatch(p -> p.getX() >= 2));
        assertFalse(result.clear(field.body));
    }

    @Test
    void collisionEquivalentStoneAndOreHaveIdenticalPublicGeometry() {
        VoxelShape stone = Blocks.STONE.getDefaultState().getCollisionShape(EmptyBlockView.INSTANCE, BlockPos.ORIGIN);
        VoxelShape ore = Blocks.DIAMOND_ORE.getDefaultState().getCollisionShape(EmptyBlockView.INSTANCE, BlockPos.ORIGIN);
        var first = new Field();
        var second = new Field();
        first.floor = stone;
        second.floor = ore;
        var a = new AgentCombatGeometry();
        var b = new AgentCombatGeometry();
        a.refresh(first, 9, 10);
        b.refresh(second, 9, 10);
        var stoneReceipt = candidate(a, first, 9, 10, 0, -1, 0);
        var oreReceipt = candidate(b, second, 9, 10, 0, -1, 0);
        assertEquals(stoneReceipt.status(), oreReceipt.status());
        assertEquals(stoneReceipt.from(), oreReceipt.from());
        assertEquals(stoneReceipt.to(), oreReceipt.to());
        assertEquals(stoneReceipt.corridor(), oreReceipt.corridor());
        assertEquals(stoneReceipt.distance(), oreReceipt.distance());
        assertEquals(stoneReceipt.brakingDistance(), oreReceipt.brakingDistance());
        assertEquals("GEOMETRY_NATIVE_COMBAT", oreReceipt.provenance());
        assertEquals(first.queries, second.queries);
    }

    @Test
    void everyFreshnessDimensionInvalidatesWithoutQueryingAgain() {
        for (int change = 0; change < 12; change++) {
            var field = new Field();
            var geometry = new AgentCombatGeometry();
            geometry.refresh(field, 2, 10);
            var receipt = candidate(geometry, field, 2, 10, 1, 0, 0);
            assertTrue(receipt.admitted());
            int queries = field.collisionCalls;
            int tick = 10;
            long token = 2;
            switch (change) {
                case 0 -> field.world = new Object();
                case 1 -> field.player = new Object();
                case 2 -> field.life++;
                case 3 -> field.pose = new Object();
                case 4 -> { field.feet = field.feet.add(0.001, 0, 0); field.body = field.body.offset(0.001, 0, 0); }
                case 5 -> field.body = new Box(field.body.minX, field.body.minY, field.body.minZ,
                    field.body.maxX, field.body.maxY - 0.3, field.body.maxZ);
                case 6 -> field.alive = false;
                case 7 -> tick += 2;
                case 8 -> token++;
                case 9 -> { field.feet = field.feet.add(1, 0, 0); field.body = field.body.offset(1, 0, 0); }
                case 10 -> field.age--;
                case 11 -> field.groundedSupport = null;
                default -> throw new AssertionError();
            }
            assertEquals(AgentCombatGeometry.Status.STALE, candidate(geometry, field, token, tick, 1, 0, 0).status());
            assertFalse(receipt.clear(receipt.corridor()));
            assertEquals(queries, field.collisionCalls);
        }
    }

    @Test
    void partialSupportUnionIsExactAndDoesNotLookBelowItsFirstShelf() {
        var field = new Field();
        field.floor = VoxelShapes.union(VoxelShapes.cuboid(0, 0, 0, 0.49, 1, 1),
            VoxelShapes.cuboid(0.51, 0, 0, 1, 1, 1));
        var geometry = new AgentCombatGeometry();
        geometry.refresh(field, 1, 10);
        assertEquals(AgentCombatGeometry.Status.CLIFF, candidate(geometry, field, 1, 10, 1, 0, 0).status());
        assertFalse(field.queries.stream().anyMatch(p -> p.getY() < 0));
        field.floor = VoxelShapes.union(VoxelShapes.cuboid(0, 0, 0, 0.5, 1, 1),
            VoxelShapes.cuboid(0.5, 0, 0, 1, 1, 1));
        geometry.invalidate();
        geometry.refresh(field, 1, 10);
        assertEquals(AgentCombatGeometry.Status.FLAT, candidate(geometry, field, 1, 10, 1, 0, 0).status());
    }

    @Test
    void partialBodyObstacleAndLowCeilingVetoTheWholeBody() {
        var obstruction = new Field();
        obstruction.shapes.put(new BlockPos(1, 1, 0), VoxelShapes.cuboid(0, 0, 0, 0.08, 0.25, 1));
        var geometry = new AgentCombatGeometry();
        geometry.refresh(obstruction, 1, 10);
        assertEquals(AgentCombatGeometry.Status.WALL, candidate(geometry, obstruction, 1, 10, 1, 0, 0).status());

        var ceiling = new Field();
        ceiling.shapes.put(new BlockPos(0, 3, 0), VoxelShapes.cuboid(0, 0, 0, 1, 0.3, 1));
        geometry.invalidate();
        geometry.refresh(ceiling, 1, 10);
        assertEquals(AgentCombatGeometry.Status.CEILING, candidate(geometry, ceiling, 1, 10, 1, 0, 1).status());
    }

    @Test
    void oneBlockUpAndDownRequireExactLandingAndBrakingSupport() {
        var up = new Field();
        up.shapes.put(new BlockPos(1, 1, 0), VoxelShapes.fullCube());
        up.shapes.put(new BlockPos(2, 1, 0), VoxelShapes.fullCube());
        var ascent = new AgentCombatGeometry();
        ascent.refresh(up, 1, 10);
        var higher = candidate(ascent, up, 1, 10, 1, 0, 1);
        assertEquals(AgentCombatGeometry.Status.STEP_UP, higher.status());
        assertEquals(new BlockPos(1, 2, 0), higher.to());
        assertTrue(higher.clear(up.body.offset(0, 1.26, 0)));
        assertTrue(higher.dry(up.body.offset(0, 1.26, 0)));
        assertFalse(higher.clear(up.body.offset(0, 2.1, 0)));

        var down = new Field();
        down.floorMinimumX = 0;
        for (int x = -3; x < 0; x++) down.shapes.put(new BlockPos(x, -1, 0), VoxelShapes.fullCube());
        var descent = new AgentCombatGeometry();
        descent.refresh(down, 1, 10);
        var lower = candidate(descent, down, 1, 10, -1, 0, -1);
        assertEquals(AgentCombatGeometry.Status.STEP_DOWN, lower.status());
        assertEquals(new BlockPos(-1, 0, 0), lower.to());
        assertTrue(lower.clear(down.body.offset(-1, -1, 0)));
        assertTrue(lower.dry(down.body.offset(-1, -1, 0)));
    }

    @Test
    void stoppingEnvelopeCannotBorrowSupportPastTheCheckedLanding() {
        var field = new Field();
        field.floorMaximumX = 1;
        var geometry = new AgentCombatGeometry();
        geometry.refresh(field, 1, 10);
        assertTrue(candidate(geometry, field, 1, 10, 1, 0, 0).admitted());
        var longCoast = geometry.candidate(field, 1, 10, 1, 0, 1, 0, 0.8);
        assertEquals(AgentCombatGeometry.Status.CLIFF, longCoast.status());
        assertFalse(longCoast.admitted());
    }

    @Test
    void downStepDepartureAllowsGroundedToeOverhangOnlyOntoConnectedLowerSupport() {
        var edge = new Field();
        edge.feet = new Vec3d(0.15, 1, 0.5);
        edge.body = edge.body.offset(-0.35, 0, 0);
        edge.floorMinimumX = 0;
        for (int x = -3; x < 0; x++) edge.shapes.put(new BlockPos(x, -1, 0), VoxelShapes.fullCube());
        var geometry = new AgentCombatGeometry();
        geometry.refresh(edge, 1, 10);
        assertEquals(AgentCombatGeometry.Status.STEP_DOWN, candidate(geometry, edge, 1, 10, -1, 0, -1).status());
        assertEquals(AgentCombatGeometry.Status.CLIFF, candidate(geometry, edge, 1, 10, -1, 0, 0).status(),
            "toe overhang must not become an ordinary flat-support receipt");

        edge.shapes.remove(new BlockPos(-1, -1, 0));
        geometry.invalidate();
        geometry.refresh(edge, 1, 10);
        assertEquals(AgentCombatGeometry.Status.CLIFF, candidate(geometry, edge, 1, 10, -1, 0, -1).status(),
            "no bridging a hole between source contact and the lower landing");

        edge.shapes.put(new BlockPos(-1, -1, 0), VoxelShapes.fullCube());
        edge.feet = edge.feet.add(-0.65, 0, 0);
        edge.body = edge.body.offset(-0.65, 0, 0);
        geometry.invalidate();
        geometry.refresh(edge, 1, 10);
        assertEquals(AgentCombatGeometry.Status.CLIFF, candidate(geometry, edge, 1, 10, -1, 0, -1).status(),
            "a body wholly above the lower floor has no source-height contact");
    }

    @Test
    void unloadedAndFluidAreUnknownNotDryAndNeverForceChunkReads() {
        var unloaded = new Field();
        unloaded.unloaded.add(new BlockPos(1, 1, 0));
        var geometry = new AgentCombatGeometry();
        geometry.refresh(unloaded, 1, 10);
        assertEquals(AgentCombatGeometry.Status.UNKNOWN, candidate(geometry, unloaded, 1, 10, 1, 0, 0).status());
        assertFalse(unloaded.queries.contains(new BlockPos(1, 1, 0)));
        int loadedCalls = unloaded.loadedCalls;
        assertEquals(AgentCombatGeometry.Status.UNKNOWN, candidate(geometry, unloaded, 1, 10, 1, 0, 0).status());
        assertEquals(loadedCalls, unloaded.loadedCalls);
        var fluid = new Field();
        fluid.fluids.add(new BlockPos(1, 0, 0));
        geometry.invalidate();
        geometry.refresh(fluid, 1, 10);
        assertEquals(AgentCombatGeometry.Status.UNKNOWN, candidate(geometry, fluid, 1, 10, 1, 0, 0).status());
    }

    @Test
    void downStepSourceUsesActualGroundedContactEvenAfterCentreCrossesCellBoundary() {
        var field = new Field();
        field.feet = new Vec3d(-0.1, 1, 0.5);
        field.body = field.body.offset(-0.6, 0, 0);
        field.floorMinimumX = 0;
        for (int x = -3; x < 0; x++) field.shapes.put(new BlockPos(x, -1, 0), VoxelShapes.fullCube());
        var geometry = new AgentCombatGeometry();
        geometry.refresh(field, 1, 10);
        var receipt = geometry.candidate(field, 1, 10, -1, 0, 0.4, -1, 0.1);
        assertEquals(AgentCombatGeometry.Status.STEP_DOWN, receipt.status());
        assertEquals(new BlockPos(0, 1, 0), receipt.from());
        assertEquals(new BlockPos(-1, 0, 0), receipt.to());
        assertFalse(receipt.from().equals(BlockPos.ofFloored(field.feet)));

        field.groundedSupport = null;
        assertFalse(receipt.admitted());
        geometry.refresh(field, 1, 10);
        assertEquals(AgentCombatGeometry.Status.UNKNOWN,
            geometry.candidate(field, 1, 10, -1, 0, 0.4, -1, 0.1).status());
    }

    @Test
    void receiptPredicatesAreScopedQueryFreeAndExpireOnNativeAge() {
        var field = new Field();
        var geometry = new AgentCombatGeometry();
        geometry.refresh(field, 5, 10);
        var receipt = candidate(geometry, field, 5, 10, 1, 0, 0);
        int queries = field.collisionCalls;
        assertTrue(receipt.clear(field.body.union(field.body.offset(1.1, 0, 0))));
        assertTrue(receipt.dry(field.body));
        assertFalse(receipt.clear(field.body.offset(-0.03, 0, 0)));
        assertFalse(receipt.dry(field.body.offset(0, 0, 1)));
        assertEquals(queries, field.collisionCalls);
        field.age += 2;
        assertFalse(receipt.clear(field.body));
        assertFalse(receipt.admitted());
        assertEquals(queries, field.collisionCalls);
    }

    @Test
    void sameStanceCanReuseOnlyOneNativeTickAndRefreshDropsOldReceipts() {
        var field = new Field();
        var geometry = new AgentCombatGeometry();
        geometry.refresh(field, 5, 10);
        var receipt = candidate(geometry, field, 5, 10, 1, 0, 0);
        int queries = field.collisionCalls;
        field.age++;
        assertTrue(geometry.refresh(field, 5, 11));
        assertTrue(candidate(geometry, field, 5, 11, 1, 0, 0).admitted());
        assertEquals(queries, field.collisionCalls);
        field.age++;
        assertTrue(geometry.refresh(field, 5, 12));
        assertFalse(receipt.admitted());
        assertTrue(candidate(geometry, field, 5, 12, 1, 0, 0).admitted());
        assertTrue(field.collisionCalls > queries);
    }

    @Test
    void radiusAndVerticalBoundsRejectBeforeAnyProbeAndCacheIsBounded() {
        var field = new Field();
        var geometry = new AgentCombatGeometry();
        geometry.refresh(field, 1, 10);
        assertEquals(AgentCombatGeometry.Status.UNKNOWN,
            geometry.candidate(field, 1, 10, 1, 0, 4, 0, 0).status());
        assertEquals(0, field.collisionCalls);
        for (int i = 0; i < 32; i++) {
            double angle = Math.PI * 2 * i / 32;
            geometry.candidate(field, 1, 10, Math.cos(angle), Math.sin(angle), 3, 0, 0.1);
        }
        assertTrue(field.collisionCalls <= 512);
        assertEquals(field.queries.size(), field.collisionCalls, "one collision probe per cached cell");
        assertTrue(field.queries.stream().allMatch(p -> p.getY() >= -3 && p.getY() <= 5));
    }

    private static AgentCombatGeometry.Receipt candidate(AgentCombatGeometry geometry, Field field,
            long token, int tick, double dx, double dz, int step) {
        return geometry.candidate(field, token, tick, dx, dz, 1, step, 0.1);
    }

    private static final class Field implements AgentCombatGeometry.Probe {
        Object world = new Object();
        Object player = new Object();
        Object pose = new Object();
        long life;
        int age = 100;
        boolean alive = true;
        Vec3d feet = new Vec3d(0.5, 1, 0.5);
        Box body = new Box(0.2, 1, 0.2, 0.8, 2.8, 0.8);
        BlockPos groundedSupport = BlockPos.ORIGIN;
        VoxelShape floor = VoxelShapes.fullCube();
        int floorMinimumZ = Integer.MIN_VALUE;
        int floorMinimumX = Integer.MIN_VALUE;
        int floorMaximumX = Integer.MAX_VALUE;
        int loadedCalls;
        int collisionCalls;
        final Map<BlockPos, VoxelShape> shapes = new HashMap<>();
        final Set<BlockPos> fluids = new HashSet<>();
        final Set<BlockPos> unloaded = new HashSet<>();
        final Set<BlockPos> queries = new HashSet<>();

        public Object world() { return world; }
        public Object player() { return player; }
        public Object pose() { return pose; }
        public long life() { return life; }
        public int age() { return age; }
        public boolean alive() { return alive; }
        public Vec3d feet() { return feet; }
        public Box body() { return body; }
        public BlockPos groundedSupport() { return groundedSupport; }
        public boolean loaded(int x, int y, int z) {
            loadedCalls++;
            return !unloaded.contains(new BlockPos(x, y, z));
        }
        public VoxelShape collision(int x, int y, int z) {
            var position = new BlockPos(x, y, z);
            assertFalse(unloaded.contains(position), "unloaded cells must never be collision-probed");
            queries.add(position);
            collisionCalls++;
            return shapes.getOrDefault(position, y == 0 && z >= floorMinimumZ
                && x >= floorMinimumX && x <= floorMaximumX ? floor : VoxelShapes.empty());
        }
        public boolean fluid(int x, int y, int z) {
            return fluids.contains(new BlockPos(x, y, z));
        }
    }
}
