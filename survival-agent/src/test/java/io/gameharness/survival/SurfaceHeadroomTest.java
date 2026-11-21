package io.gameharness.survival;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.item.Items;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class SurfaceHeadroomTest {
    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
    }

    @Test
    void onlyAnUnstartedDryOverheadRefusalCanSpendOneLookFromThatUpperFooting() {
        var edge = edge();
        var used = new HashSet<BlockPos>();
        var priced = grant("dirt", 3);
        assertNull(AgentSurfaceHeadroom.begin(used, edge, AgentSurfaceTread.ReturnClearance.DAMP, true, priced, 10, 20));
        assertNull(AgentSurfaceHeadroom.begin(used, edge, AgentSurfaceTread.ReturnClearance.OBSTRUCTION, true, priced, 10, 20));
        assertNull(AgentSurfaceHeadroom.begin(used, edge, AgentSurfaceTread.ReturnClearance.OVERHEAD, false, priced, 10, 20));
        var diamond = new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false,
            new AgentWorkOrder.Target(Items.DIAMOND, 3, null),
            Set.of("break:minecraft:dirt", "break:minecraft:diamond_ore"), Map.of(), Map.of(), 3, 0, 0));
        assertNull(AgentSurfaceHeadroom.begin(used, edge, AgentSurfaceTread.ReturnClearance.OVERHEAD, true, diamond, 10, 20));
        var repair = AgentSurfaceHeadroom.begin(used, edge, AgentSurfaceTread.ReturnClearance.OVERHEAD, true, priced, 10, 20);
        assertNotNull(repair);
        assertFalse(repair.canLook(10, 20), "the refusal frame does not prove a new view");
        assertTrue(repair.canLook(11, 21));
        assertFalse(repair.canLook(11, 20 + AgentSurfaceHeadroom.LOOK_TICKS), "the reframe has a deadline");
        var changedSupport = new AgentSurfaceTread.Edge(edge.upper(), Blocks.STONE.getDefaultState(),
            edge.lower(), edge.lowerSupport(), edge.down());
        assertNull(AgentSurfaceHeadroom.begin(used, changedSupport, AgentSurfaceTread.ReturnClearance.OVERHEAD,
            true, priced, 11, 22), "changed topology details do not re-arm a spent look");
    }

    @Test
    void cutRequiresOneVisibleExactNaturalCrownWithItsOwnGrantAndSafetyProof() {
        var edge = edge();
        var repair = repair(edge);
        var dirt = Blocks.DIRT.getDefaultState();
        var sand = Blocks.SAND.getDefaultState();
        var water = Blocks.WATER.getDefaultState();
        var lintel = underside(edge.upper().east().up(2));
        assertFalse(repair.witness(null, dirt, 0.6, grant("dirt", 3), true), "no visible ray");
        assertFalse(repair.witness(underside(edge.upper().south().up(2)), dirt, 0.6, grant("dirt", 3), true),
            "roof outside the jump envelope");
        assertFalse(repair.witness(underside(edge.lower().down()), dirt, 0.6, grant("dirt", 3), true),
            "retained support is not roof");
        assertFalse(repair.witness(lintel, dirt, 0.6, grant("grass_block", 3), true), "dirt is not grass");
        assertFalse(repair.witness(lintel, dirt, 0.6, grant("dirt", 1), true), "leave a break for the source");
        assertFalse(repair.witness(lintel, sand, 0.6, grant("sand", 3), true), "gravity material");
        assertFalse(repair.witness(lintel, water, 0.6, grant("water", 3), true), "not dry roof");
        assertFalse(repair.witness(lintel, dirt, 0.6, grant("dirt", 3), false), "independent mining veto");
        assertTrue(repair.witness(lintel, dirt, 0.6, grant("dirt", 3), true));
        assertFalse(repair.matches(lintel, Blocks.STONE.getDefaultState()), "changed state");
        assertFalse(repair.matches(new BlockHitResult(lintel.getPos(), Direction.WEST, lintel.getBlockPos(), false), dirt),
            "changed face");
        assertFalse(repair.witness(underside(edge.upper().up(2)), dirt, 0.6, grant("dirt", 3), true),
            "never trade the admitted face for a second cut");
        assertTrue(repair.matches(lintel, dirt));
    }

    @Test
    void onlyAnExactOwnBreakAndFreshIntactReturnCanRestartTheOrdinaryDownhillProof() {
        var edge = edge();
        var repair = repair(edge);
        BlockState dirt = Blocks.DIRT.getDefaultState(), air = Blocks.AIR.getDefaultState();
        var roof = underside(edge.upper().up(2));
        assertTrue(repair.witness(roof, dirt, 0.6, grant("dirt", 3), true));
        assertTrue(repair.beginEquip());
        assertFalse(repair.beginEquip(), "the repair cannot loop equipping tools");
        assertFalse(repair.confirmBreak(roof.getBlockPos(), dirt, 31), "a receipt cannot predate cut admission");
        assertTrue(repair.beginCut());
        assertFalse(repair.beginCut(), "at most one attack action is admitted");
        assertFalse(repair.confirmBreak(roof.getBlockPos().east(), dirt, 31));
        assertFalse(repair.confirmBreak(roof.getBlockPos(), Blocks.STONE.getDefaultState(), 31));
        assertNull(repair.retry(31, 32, air, edge.upperSupport(), edge.lowerSupport(), true),
            "seeing air is not an own break");
        assertTrue(repair.confirmBreak(roof.getBlockPos(), dirt, 31));
        assertNull(repair.retry(31, 32, air, edge.upperSupport(), edge.lowerSupport(), true), "fresh frame required");
        assertNull(repair.retry(32, 33, dirt, edge.upperSupport(), edge.lowerSupport(), true), "roof changed back");
        assertNull(repair.retry(32, 33, air, edge.upperSupport(), dirt, true), "changed landing");
        assertNull(repair.retry(32, 33, air, dirt, edge.lowerSupport(), true), "changed takeoff");
        assertNull(repair.retry(32, 33, air, edge.upperSupport(), edge.lowerSupport(), false), "return still vetoed");
        var tread = repair.retry(32, 33, air, edge.upperSupport(), edge.lowerSupport(), true);
        assertNotNull(tread);
        assertFalse(tread.inFlight(), "confirmation only starts the usual stationary visual proof");
        assertFalse(tread.returning, "the repair never issues the uphill jump");
        assertTrue(tread.to.getY() < tread.from.getY());
        assertNull(repair.retry(33, 34, air, edge.upperSupport(), edge.lowerSupport(), true), "only one fresh proof");
    }

    private static AgentSurfaceTread.Edge edge() {
        var upper = new BlockPos(10, 60, 10);
        return new AgentSurfaceTread.Edge(upper, Blocks.GRASS_BLOCK.getDefaultState(), upper.east().down(),
            Blocks.STONE.getDefaultState(), Direction.EAST);
    }

    private static AgentSurfaceHeadroom repair(AgentSurfaceTread.Edge edge) {
        return AgentSurfaceHeadroom.begin(new HashSet<>(), edge, AgentSurfaceTread.ReturnClearance.OVERHEAD,
            true, grant("dirt", 3), 10, 20);
    }

    private static AgentWorkOrder.Budget grant(String cover, int breaks) {
        return new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false,
            new AgentWorkOrder.Target(Items.COBBLESTONE, 3, null),
            Set.of("break:minecraft:" + cover, "break:minecraft:stone"), Map.of(), Map.of(), breaks, 0, 0));
    }

    private static BlockHitResult underside(BlockPos cell) {
        return new BlockHitResult(Vec3d.ofBottomCenter(cell), Direction.DOWN, cell, false);
    }
}
