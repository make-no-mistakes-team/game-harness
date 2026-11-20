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
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
        var ice = new AgentVisibleHorizon.Stance(0.50, 0, 0.50, 0.31, Vec3d.ZERO,
            0.024, 0.91 * 0.98, false, BlockPos.ORIGIN);
        assertNull(AgentVisibleHorizon.contactTrace(ice, 1, 0), "low momentum does not authorize an ice pulse");

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
    void aVetoInsideTheProvedStoppingPrefixDoesNotSpendRaysExtendingThatBearing() {
        var witnessed = new AgentVisibleHorizon.Support() {
            int furthest;

            @Override public AgentVisibleHorizon.Patch at(int x, int z) {
                furthest = Math.max(furthest, x);
                return STONE;
            }

            @Override public AgentVisibleHorizon.Refusal vetoDry(double dx, double dz, double drift, double braking) {
                return AgentVisibleHorizon.Refusal.OBSTRUCTION;
            }
        };
        var blocked = track(witnessed, 0.50, 0.50, Vec3d.ZERO);
        assertEquals(UNKNOWN, blocked.medium());
        assertEquals(AgentVisibleHorizon.Refusal.OBSTRUCTION, blocked.refusal());
        assertTrue(blocked.known() > blocked.braking(), "collision is a veto despite sufficient visible support");
        assertEquals(1, witnessed.furthest, "leave the unneeded farther terrain rays for other bearings");
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
        assertEquals(AgentVisibleHorizon.Refusal.DRY_BANK_NOT_RENDERED, noBank.refusal());
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
        assertEquals(AgentVisibleHorizon.Refusal.DEEP_WATER, AgentVisibleHorizon.Patch.waterRefusal(1.05, Vec3d.ZERO));
        assertNull(AgentVisibleHorizon.Patch.water(0, 0.32, new Vec3d(0.04, -0.96, 0)));
        assertNull(AgentVisibleHorizon.Patch.water(0, 0.32, new Vec3d(1, 0, 0)));
        assertEquals(AgentVisibleHorizon.Refusal.WATER_FLOW,
            AgentVisibleHorizon.Patch.waterRefusal(0.32, new Vec3d(1, 0, 0)));
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

    @Test
    void canopyShoulderAdvancesTowardTheSameGoalWithoutWalkingAtTheGap() {
        double top = height(Blocks.OAK_LEAVES);
        var leaf = AgentVisibleHorizon.Patch.dry(top, 0.6);
        AgentVisibleHorizon.Support seen = (x, z) -> x >= 0 && x <= 2 && z == 0 ? leaf : null;
        var stance = new AgentVisibleHorizon.Stance(0.40, top, 0.62, 0.31,
            Vec3d.ZERO, 0.10, leaf.drag(), false, BlockPos.ORIGIN);
        double goalX = 3.1, goalZ = 1.96;
        float direct = (float) Math.toDegrees(Math.atan2(stance.x() - goalX, goalZ - stance.z()));
        var blocked = along(seen, stance, direct);
        assertEquals(UNKNOWN, blocked.medium());
        assertTrue(blocked.known() < blocked.braking());
        assertEquals(AgentVisibleHorizon.Refusal.SURFACE_NOT_RENDERED, blocked.refusal());

        Float shoulder = AgentVisibleHorizon.select(direct, Float.NaN, stance, false, Float.NaN,
            (start, yaw, allowWade) -> {
                // Only the gap and its near shoulder are inside this rendered approach.
                if (yaw < -97 || yaw > -55) return null;
                var track = along(seen, start, yaw);
                double radians = Math.toRadians(yaw);
                return track.medium() == DRY && track.known() > track.braking()
                    && AgentVisibleHorizon.advancesBeyondContact(start, track, -Math.sin(radians), Math.cos(radians))
                    ? yaw : null;
            });
        assertNotNull(shoulder);
        assertTrue(shoulder < direct && shoulder > -97);
        assertTrue(along(seen, stance, shoulder).known() > 0.7,
            "a real supported advance, not another pulse on the starting canopy block");
        double yaw = Math.toRadians(shoulder);
        assertTrue(Math.hypot(goalX - stance.x() + 0.6 * Math.sin(yaw),
            goalZ - stance.z() - 0.6 * Math.cos(yaw)) < Math.hypot(goalX - stance.x(), goalZ - stance.z()));

        Float noVisibleShoulder = AgentVisibleHorizon.select(direct, Float.NaN, stance, false, Float.NaN,
            (start, bearing, allowWade) -> Math.abs(bearing - direct) <= 4
                && along(seen, start, bearing).medium() == DRY ? bearing : null);
        assertNull(noVisibleShoulder, "a diagnostic gap does not license a bearing outside the render");
    }

    @Test
    void aSafeBrakingPrefixOnTheCurrentCanopyBlockIsNotAVisibleApproach() {
        var leaf = AgentVisibleHorizon.Patch.dry(height(Blocks.OAK_LEAVES), 0.6);
        var stance = new AgentVisibleHorizon.Stance(0.32, leaf.y(), 0.5, 0.31,
            Vec3d.ZERO, 0.10, leaf.drag(), false, BlockPos.ORIGIN);
        var currentOnly = AgentVisibleHorizon.trace((x, z) -> x == 0 && z == 0 ? leaf : null, stance, 1, 0);
        assertEquals(DRY, currentOnly.medium());
        assertTrue(currentOnly.known() > currentOnly.braking());
        assertFalse(AgentVisibleHorizon.advancesBeyondContact(stance, currentOnly, 1, 0));
    }

    private static AgentVisibleHorizon.Track along(AgentVisibleHorizon.Support ground,
                                                   AgentVisibleHorizon.Stance stance, float yaw) {
        double radians = Math.toRadians(yaw);
        return AgentVisibleHorizon.trace(ground, stance, -Math.sin(radians), Math.cos(radians));
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
