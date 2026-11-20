package io.gameharness.survival;

import net.minecraft.block.Blocks;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.EmptyBlockView;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentVisibleHorizon.Medium.DRY;
import static io.gameharness.survival.AgentVisibleHorizon.Medium.SHALLOW_WATER;
import static io.gameharness.survival.AgentVisibleHorizon.Medium.UNKNOWN;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class VisibleHorizonTest {
    private static final AgentVisibleHorizon.Patch STONE = AgentVisibleHorizon.Patch.dry(0, 0.6);
    private static final AgentVisibleHorizon.Patch QUIET_SHALLOW =
        AgentVisibleHorizon.Patch.water(0, 0.34, Vec3d.ZERO);

    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

    @Test
    void canStartOnTheVisibleNextTopWithoutProvingTheFartherOrReverseRoute() {
        var initiallyClipped = track((x, z) -> x == 0 && z == 0 ? STONE : null, 0.50, 0.50, Vec3d.ZERO);
        assertEquals(UNKNOWN, initiallyClipped.medium());
        assertTrue(initiallyClipped.known() < initiallyClipped.braking());

        var oneMoreTop = track((x, z) -> x >= 0 && x <= 1 && z == 0 ? STONE : null, 0.50, 0.50, Vec3d.ZERO);
        assertEquals(DRY, oneMoreTop.medium());
        assertTrue(oneMoreTop.known() > oneMoreTop.braking());
        assertTrue(oneMoreTop.known() < 1.25, "do not claim clipped terrain or unsupported overhang");
    }

    @Test
    void exactDryContactCoversANormalWalkingPulseButNotTheUnobservedRim() {
        var pulse = AgentVisibleHorizon.contactTrace(dry(0.50, 0.50, Vec3d.ZERO), 1, 0);
        assertEquals(DRY, pulse.medium());
        assertTrue(pulse.known() >= pulse.braking());
        assertTrue(pulse.known() < 0.35);
        assertNull(AgentVisibleHorizon.contactTrace(dry(0.72, 0.50, Vec3d.ZERO), 1, 0));
        assertNull(AgentVisibleHorizon.contactTrace(dry(0.50, 0.50, new Vec3d(0.06, 0, 0)), 1, 0));

        double diagonal = Math.sqrt(0.5);
        var atTheTrailingCorner = dry(0.13, 0.13, Vec3d.ZERO);
        assertEquals(DRY, AgentVisibleHorizon.contactTrace(atTheTrailingCorner, diagonal, diagonal).medium());
        assertNull(AgentVisibleHorizon.contactTrace(atTheTrailingCorner, -diagonal, diagonal));
    }

    @Test
    void brakesEarlierAtALedgeWithMomentumOrLowGrip() {
        AgentVisibleHorizon.Support ledge = (x, z) -> x >= 0 && x <= 1 && z == 0 ? STONE : null;
        assertEquals(DRY, track(ledge, 1.10, 0.50, new Vec3d(0.08, 0, 0)).medium());
        var runningAtTheLip = track(ledge, 1.10, 0.50, new Vec3d(0.20, 0, 0));
        assertEquals(UNKNOWN, runningAtTheLip.medium());
        assertTrue(runningAtTheLip.braking() > runningAtTheLip.known());

        var ice = AgentVisibleHorizon.Patch.dry(0, 0.98);
        var icyLip = AgentVisibleHorizon.trace((x, z) -> x >= 0 && x <= 1 && z == 0 ? ice : null,
            new AgentVisibleHorizon.Stance(0.50, 0, 0.50, 0.31,
                new Vec3d(0.15, 0, 0), 0.024, ice.drag(), false, BlockPos.ORIGIN), 1, 0);
        assertEquals(UNKNOWN, icyLip.medium());
        assertTrue(icyLip.braking() > 1.6);
    }

    @Test
    void aDiagonalNeedsRealWidthOnBothSidesOfTheCorner() {
        double diagonal = Math.sqrt(0.5);
        var stance = dry(0.50, 0.50, new Vec3d(0.08, 0, 0.08));
        var connected = AgentVisibleHorizon.trace((x, z) -> x >= 0 && x <= 1 && z >= 0 && z <= 1 ? STONE : null,
            stance, diagonal, diagonal);
        assertEquals(DRY, connected.medium());
        var cornersOnly = AgentVisibleHorizon.trace((x, z) -> x == z && (x == 0 || x == 1) ? STONE : null,
            stance, diagonal, diagonal);
        assertEquals(UNKNOWN, cornersOnly.medium());
    }

    @Test
    void actualSideMomentumCanVetoAnOtherwiseClearForwardWindow() {
        AgentVisibleHorizon.Support oneWide = (x, z) -> x >= 0 && x <= 2 && z == 0 ? STONE : null;
        assertEquals(DRY, track(oneWide, 0.50, 0.50, new Vec3d(0.08, 0, 0)).medium());
        assertEquals(UNKNOWN, track(oneWide, 0.50, 0.50, new Vec3d(0.08, 0, 0.15)).medium());
    }

    @Test
    void shallowVisibleBedNeedsAnActuallyReachableDryBankAcrossTheWholeBody() {
        var crossing = track((x, z) -> z != 0 ? null : x == 1 ? QUIET_SHALLOW : x >= 0 && x <= 3 ? STONE : null,
            0.65, 0.50, Vec3d.ZERO);
        assertEquals(SHALLOW_WATER, crossing.medium());
        assertTrue(crossing.bank() > 1.65);
        assertTrue(crossing.known() >= crossing.braking());

        var noBank = track((x, z) -> z != 0 ? null : x == 0 ? STONE : x == 1 ? QUIET_SHALLOW : null,
            0.65, 0.50, Vec3d.ZERO);
        assertEquals(UNKNOWN, noBank.medium());
        var narrowBank = track((x, z) -> x >= 0 && x <= 3 && z >= 0 && z <= 1
            ? x == 1 ? QUIET_SHALLOW : x >= 2 && z == 1 ? null : STONE : null,
            0.65, 0.79, Vec3d.ZERO);
        assertEquals(UNKNOWN, narrowBank.medium());

        var wetSource = new AgentVisibleHorizon.Stance(1.35, 0, 0.50, 0.31, Vec3d.ZERO, 0.10, 0.80, true,
            new BlockPos(1, -1, 0));
        assertEquals(SHALLOW_WATER, AgentVisibleHorizon.trace((x, z) -> z != 0 ? null
            : x == 1 ? QUIET_SHALLOW : x == 2 || x == 3 ? STONE : null, wetSource, 1, 0).medium());
        assertEquals(UNKNOWN, AgentVisibleHorizon.trace((x, z) -> x == 1 && z == 0 ? QUIET_SHALLOW : null,
            wetSource, 1, 0).medium());
    }

    @Test
    void deepWaterOutflowCausticTopsAndUnprovedHeightChangesAreNotOrdinarySupport() {
        assertNull(AgentVisibleHorizon.Patch.water(0, 1.05, Vec3d.ZERO));
        assertNull(AgentVisibleHorizon.Patch.water(0, 0.32, new Vec3d(0.04, -0.96, 0)));
        assertNull(AgentVisibleHorizon.Patch.water(0, 0.32, new Vec3d(1, 0, 0)));
        assertFalse(Double.isFinite(height(Blocks.LAVA)));
        assertFalse(Double.isFinite(height(Blocks.MAGMA_BLOCK)));
        for (double changedY : new double[] {-1, 0.5}) {
            var changed = AgentVisibleHorizon.Patch.dry(changedY, 0.6);
            assertEquals(UNKNOWN, track((x, z) -> z != 0 ? null : x == 0 ? STONE : changed,
                0.65, 0.50, Vec3d.ZERO).medium());
        }
    }

    @Test
    void aWitnessedFullCanopyTopIsAsUsableAsOtherFirmGround() {
        assertEquals(1.0, height(Blocks.OAK_LEAVES));
        assertFalse(Double.isFinite(height(Blocks.OAK_FENCE)));
    }

    private static double height(net.minecraft.block.Block block) {
        return AgentBody.horizonSupportTop(EmptyBlockView.INSTANCE, BlockPos.ORIGIN, block.getDefaultState());
    }

    private static AgentVisibleHorizon.Track track(AgentVisibleHorizon.Support ground,
                                                   double x, double z, Vec3d velocity) {
        return AgentVisibleHorizon.trace(ground, dry(x, z, velocity), 1, 0);
    }

    private static AgentVisibleHorizon.Stance dry(double x, double z, Vec3d velocity) {
        return new AgentVisibleHorizon.Stance(x, 0, z, 0.31, velocity, 0.10, STONE.drag(), false,
            BlockPos.ofFloored(x, -1, z));
    }
}
