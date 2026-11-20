package io.gameharness.survival;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentShallowTransit.Turn.COAST;
import static io.gameharness.survival.AgentShallowTransit.Turn.DRIVE;
import static io.gameharness.survival.AgentShallowTransit.Turn.LANDED;
import static io.gameharness.survival.AgentShallowTransit.Turn.RECOVER;
import static io.gameharness.survival.AgentVisibleHorizon.Refusal.*;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

final class ShallowTransitTest {
    private static final AgentVisibleHorizon.Patch DRY = AgentVisibleHorizon.Patch.dry(64, 0.6);
    private static final AgentVisibleHorizon.Patch WATER = AgentVisibleHorizon.Patch.water(64, 0.34, Vec3d.ZERO);
    private static final double ISSUED_Z = 0.6, CONTACT_Z = 0.9518016656287817;
    private final Object world = new Object(), actor = new Object(), owner = new Object();

    @Test
    void actuallyIssuedWadeOwnsDryCenterContactCoastAndThePhysicalShoreExit() {
        assertNull(issue(false, false), "an intended but vetoed key does not earn a crossing");
        assertNull(issue(true, true), "an unexpected wet start cannot acquire the ordinary crossing");
        var transit = issue(true, false);
        var bed = new Bed();
        assertEquals(DRIVE, transit.check(pose(154, 425, 0.6980000033676624, 0.10, false), bed));
        assertEquals(DRIVE, transit.check(pose(155, 426, 0.82, 0.10, false), bed));
        // The frame was already consumed. The body touches water while the center and
        // supporting block are still on the source bank. It owns a neutral turn only.
        assertEquals(COAST, transit.check(pose(156, 426, CONTACT_Z, 0.10, true), bed));
        assertEquals(VIEW_STALE_OR_SHIFTED, transit.reason());
        assertEquals(VIEW_STALE_OR_SHIFTED, transit.inputVeto(pose(156, 426, CONTACT_Z, 0.10, true), bed, 0));
        assertEquals(DRIVE, transit.check(pose(157, 428, 1.05, 0.08, true), bed));
        assertNull(transit.inputVeto(pose(157, 428, 1.05, 0.08, true), bed, 0));
        assertEquals(DRIVE, transit.check(pose(165, 442, 1.31, 0.07, true), bed));
        assertEquals(COAST, transit.check(pose(177, 461, 2.19, 0.07, true), bed),
            "another stroke could extend past the original bank, but neutral momentum still fits");
        assertEquals(COAST, transit.check(pose(178, 462, 2.32, 0.10, true), bed),
            "center on the bank is not a landing while vanilla still reports water contact");
        assertEquals(COAST, transit.check(pose(179, 463, 2.39, 0.07, false), bed),
            "a dry bank with residual movement is not a settled travel receipt");
        assertEquals(LANDED, transit.check(pose(180, 464, 2.43, 0.03, false), bed));
    }

    @Test
    void freshOpticsAndPhysicalVetoesCanOnlyPreserveTheOriginalLane() {
        var transit = issue(true, false);
        var bed = new Bed();
        bed.bank = AgentVisibleHorizon.Patch.water(64, 0.34, Vec3d.ZERO);
        assertEquals(RECOVER, transit.check(pose(156, -1, 0.95, 0.10, true), bed));
        assertEquals(WADE_BANK_CHANGED, transit.reason());

        transit = issue(true, false);
        bed = new Bed();
        bed.unseen = true;
        assertEquals(RECOVER, transit.check(pose(156, 428, 0.95, 0.10, true), bed));
        assertEquals(DRY_BANK_NOT_RENDERED, transit.reason());

        transit = issue(true, false);
        bed = new Bed();
        bed.bed = DEEP_WATER.unavailable;
        assertEquals(RECOVER, transit.check(pose(156, 428, 0.95, 0.10, true), bed));
        assertEquals(DEEP_WATER, transit.reason());

        transit = issue(true, false);
        bed.bed = WATER_FLOW.unavailable;
        assertEquals(RECOVER, transit.check(pose(156, 428, 0.95, 0.10, true), bed));
        assertEquals(WATER_FLOW, transit.reason());

        transit = issue(true, false);
        bed = new Bed();
        bed.sweep = HAZARD;
        assertEquals(RECOVER, transit.check(pose(156, 428, 0.95, 0.10, true), bed));
        assertEquals(HAZARD, transit.reason());
    }

    @Test
    void scopeLifeHealthMotionAndFreshnessCannotBeBorrowed() {
        var bed = new Bed();
        var transit = issue(true, false);
        assertEquals(COAST, transit.check(pose(154, -1, 0.72, 0.10, false), bed));
        assertEquals(RECOVER, transit.check(pose(155, -1, 0.82, 0.10, true), bed));
        assertEquals(VIEW_STALE_OR_SHIFTED, transit.reason());

        for (var rejected : new Object[] { new Object(), actor, world }) {
            transit = issue(true, false);
            var p = new AgentShallowTransit.Pose(rejected == world ? new Object() : world,
                rejected == actor ? new Object() : actor, rejected == actor || rejected == world ? owner : rejected,
                156, 428, new Vec3d(0.5, 64, 0.95), new Vec3d(0, 0, 0.10),
                new BlockPos(0, 63, 0), 0.31, true, 20, null, 0.10, 0.024, 0.8);
            assertEquals(RECOVER, transit.check(p, bed));
            assertEquals(p.owner() != owner ? TARGET_EXPIRED : WORLD_OR_CAMERA_UNAVAILABLE, transit.reason());
        }
        transit = issue(true, false);
        var damaged = pose(156, 428, 0.95, 0.10, true);
        assertEquals(RECOVER, transit.check(new AgentShallowTransit.Pose(world, actor, owner, damaged.tick(),
            damaged.frame(), damaged.feet(), damaged.velocity(), damaged.support(), damaged.radius(),
            true, 19, null, 0.10, 0.024, 0.8), bed));
        assertEquals(WADE_HEALTH_CHANGED, transit.reason());

        transit = issue(true, false);
        assertEquals(RECOVER, transit.check(new AgentShallowTransit.Pose(world, actor, owner, damaged.tick(),
            damaged.frame(), damaged.feet(), damaged.velocity(), damaged.support(), damaged.radius(),
            true, 20, DEEP_WATER, 0.10, 0.024, 0.8), bed));
        assertEquals(DEEP_WATER, transit.reason());

        transit = issue(true, false);
        assertEquals(RECOVER, transit.check(pose(156, 428, 0.95, -0.09, true), bed));
        assertEquals(WADE_DRIFT, transit.reason());
        transit = issue(true, false);
        assertEquals(RECOVER, transit.check(pose(200, 480, 1.31, 0.07, true), bed));
        assertEquals(WADE_BOUND_EXCEEDED, transit.reason());
    }

    private AgentShallowTransit issue(boolean issued, boolean touchingWater) {
        var start = pose(153, 424, ISSUED_Z, 0, touchingWater);
        AgentVisibleHorizon.Support painted = new Bed()::original;
        // Recreate the real t153 optical window, not a bank guessed from
        // its block center. The 2.08-block window ended at z2.68: the
        // optical padding sees the next dry tile, but the actual hull stops
        // within the original bank tile and earns no continuation past it.
        var stance = new AgentVisibleHorizon.Stance(start.feet().x, start.feet().y, start.feet().z,
            0.312, start.velocity(), 0.10, 0.546, false, start.support());
        var track = AgentVisibleHorizon.trace(painted, stance, 0, 1);
        assertEquals(AgentVisibleHorizon.Medium.SHALLOW_WATER, track.medium());
        assertEquals(2.08, track.bank(), 1e-9);
        return AgentShallowTransit.issue(issued, start, start.feet().add(0, 0, track.bank()),
            track.sideDrift(), track.braking() - 0.075, painted);
    }

    private AgentShallowTransit.Pose pose(int tick, long frame, double z, double speed, boolean wet) {
        return new AgentShallowTransit.Pose(world, actor, owner, tick, frame, new Vec3d(0.5, 64, z),
            new Vec3d(0, 0, speed), new BlockPos(0, 63, (int) z), 0.31, wet, 20, null, 0.10, 0.024, 0.8);
    }

    private static final class Bed implements AgentShallowTransit.Checks {
        AgentVisibleHorizon.Patch bank = DRY, bed = WATER;
        AgentVisibleHorizon.Refusal sweep;
        boolean unseen;

        AgentVisibleHorizon.Patch original(int x, int z) {
            return x != 0 || z < 0 || z > 3 ? null : z == 1 ? WATER : DRY;
        }

        @Override public AgentVisibleHorizon.Patch physical(int x, int z, AgentVisibleHorizon.Patch seen) {
            return z == 1 ? bed : z == 2 ? bank : original(x, z);
        }

        @Override public AgentVisibleHorizon.Refusal optical(int x, int z, AgentVisibleHorizon.Patch seen) {
            return unseen && z == 2 ? DRY_BANK_NOT_RENDERED : null;
        }

        @Override public AgentVisibleHorizon.Refusal sweep(double dx, double dz, double drift,
                                                           double coast, double reach) {
            return sweep;
        }
    }
}
