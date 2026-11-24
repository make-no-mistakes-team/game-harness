package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Collections;
import java.util.List;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

/** Production prediction math only; these tests do not establish a live vanilla water landing. */
final class AgentWaterJumpPredictionTest {
    private static final int NOW = 50;
    private static final AgentWaterJumpPrediction.Physics WALK = physics(0.098f, 0.02f * 0.98f);
    private static final AgentWaterJumpPrediction.Physics COAST = physics(0.098f, 0);

    @Test
    void arbitraryOffAxisBearingCanEnterObservedWaterWithoutCardinalSnapping() {
        var launch = launch(new Vec3d(0, 10, 0), new Vec3d(0.18, 0, 0.24), 3, 4, true, 0);
        var result = predict(launch, WALK, water(new Box(1, 5.8, 1, 8, 6, 10)));
        assertTrue(result.viable());
        assertNotNull(result.entryFeet());
        assertEquals(4.0 / 3, result.entryFeet().z / result.entryFeet().x, 1e-12);
        assertTrue(result.entryTick() > 0);
        assertTrue(result.earliestEntryTick() <= result.entryTick());
        assertTrue(result.latestEntryTick() >= result.entryTick());
        assertTrue(result.horizontalUncertainty() > 0);
    }

    @Test
    void boundedRunwayCanChangeAnUndershootIntoAnEntryButTooMuchRunwayOvershoots() {
        var water = water(new Box(3, 5.8, -1, 4, 6, 1));
        var feet = new Vec3d(0, 10, 0);
        var shortPlan = predict(launch(feet, Vec3d.ZERO, 1, 0, true, 0), COAST, water);
        var runupPlan = predict(launch(feet, Vec3d.ZERO, 1, 0, true, 12), COAST, water);
        var overshoot = predict(launch(feet, Vec3d.ZERO, 1, 0, true, 24), COAST, water);
        assertEquals(AgentWaterJumpPrediction.Verdict.SHORT, shortPlan.verdict());
        assertTrue(runupPlan.viable(), "runway acceleration is a projection, not credited actual speed");
        assertEquals(AgentWaterJumpPrediction.Verdict.OVERSHOOT, overshoot.verdict());
        assertTrue(runupPlan.projectedTakeoffFeet().x > feet.x);
        assertTrue(runupPlan.projectedTakeoffVelocity().x > 0);
    }

    @Test
    void exactMeasuredPreJumpStateReplacesRunupForecastAndMayDisproveIt() {
        var water = water(new Box(3, 5.8, -1, 4, 6, 1));
        var forecast = predict(launch(new Vec3d(0, 10, 0), Vec3d.ZERO, 1, 0, true, 12), COAST, water);
        assertTrue(forecast.viable());
        var observed = predict(launch(forecast.projectedTakeoffFeet(), forecast.projectedTakeoffVelocity(),
            1, 0, true, 0), COAST, water);
        assertEquals(forecast.verdict(), observed.verdict());
        assertEquals(forecast.entryFeet().x, observed.entryFeet().x, 1e-12);
        assertEquals(forecast.entryFeet().y, observed.entryFeet().y, 1e-12);
        assertEquals(forecast.entryTick() - 12, observed.entryTick(), 1e-12);
        var actuallyStopped = predict(launch(new Vec3d(0, 10, 0), Vec3d.ZERO, 1, 0, true, 0), COAST, water);
        assertFalse(actuallyStopped.viable(), "a forecast is not an observed takeoff receipt");
    }

    @Test
    void actualAirborneReplanPreservesMeasuredVelocityAndDoesNotJumpAgain() {
        var measured = launch(new Vec3d(7, 10, -2), new Vec3d(0.4, -1, 0.2), 3, 4, false, 0);
        var result = predict(measured, physics(0.098f, 0), water(new Box(6, 9.4, -3, 9, 9.5, 0)));
        assertEquals(AgentWaterJumpPrediction.Verdict.VIABLE, result.verdict());
        assertEquals(7.2, result.entryFeet().x, 1e-12);
        assertEquals(9.5, result.entryFeet().y, 1e-12);
        assertEquals(-1.9, result.entryFeet().z, 1e-12);
        assertEquals(0.4, result.entryVelocity().x, 0);
        assertEquals(-1, result.entryVelocity().y, 0);
        assertEquals(0.5, result.entryTick(), 1e-12);
    }

    @Test
    void groundedJumpTickUsesGroundAccelerationThenGroundFrictionNotImmediateAirFriction() {
        var strongGravity = new AgentWaterJumpPrediction.Physics(1, (double) 0.42f, 0.098f,
            0.6f * 0.91f, 0.02f * 0.98f, 0.91f, 0.98f, true);
        var result = predict(launch(new Vec3d(0, 10, 0), new Vec3d(0.1, 0, 0), 1, 0, true, 0),
            strongGravity, water(new Box(-2, 9.8, -2, 4, 9.9, 2)));
        assertTrue(result.viable());
        double firstVx = 0.1 + (double) 0.098f;
        double secondVx = firstVx * (double) (0.6f * 0.91f) + (double) (0.02f * 0.98f);
        double secondVy = ((double) 0.42f - 1) * (double) 0.98f;
        double fraction = (10 + (double) 0.42f - 9.9) / -secondVy;
        assertEquals(secondVx, result.entryVelocity().x, 1e-15);
        assertEquals(secondVy, result.entryVelocity().y, 1e-15);
        assertEquals(firstVx + secondVx * fraction, result.entryFeet().x, 1e-14);
        assertEquals(1 + fraction, result.entryTick(), 1e-14);
    }

    @Test
    void jumpDropAndFactoredAttributesChangeArrivalInsteadOfUsingOneParabola() {
        var feet = new Vec3d(0, 10, 0);
        var velocity = new Vec3d(0.2, 0, 0);
        var shallow = water(new Box(-2, 5.8, -2, 12, 6, 2));
        var deep = water(new Box(-2, 1.8, -2, 12, 2, 2));
        var noJump = predict(launch(feet, velocity, 1, 0, false, 0), COAST, shallow);
        var jump = predict(launch(feet, velocity, 1, 0, true, 0), COAST, shallow);
        var moreDrop = predict(launch(feet, velocity, 1, 0, true, 0), COAST, deep);
        var boostedPhysics = new AgentWaterJumpPrediction.Physics(0.08, 0.62f, COAST.groundAcceleration(),
            COAST.groundDrag(), 0, COAST.airDrag(), COAST.verticalDrag(), true);
        var boosted = predict(launch(feet, velocity, 1, 0, true, 0), boostedPhysics, shallow);
        assertTrue(noJump.viable() && jump.viable() && moreDrop.viable() && boosted.viable());
        assertTrue(jump.entryTick() > noJump.entryTick());
        assertTrue(moreDrop.entryTick() > jump.entryTick());
        assertTrue(boosted.entryTick() > jump.entryTick());
    }

    @Test
    void sprintJumpImpulseFollowsActualArbitraryYawAndOnlyTheLaunchTick() {
        var sprint = new AgentWaterJumpPrediction.Launch(new Vec3d(0, 10, 0), Vec3d.ZERO,
            0.6, 1.8, 3, 4, true, true, 0, NOW);
        var strongGravity = new AgentWaterJumpPrediction.Physics(1, 0.42f, 0, 0.6f * 0.91f,
            0, 0.91f, 0.98f, true);
        var result = predict(sprint, strongGravity, water(new Box(-2, 9.8, -2, 4, 9.9, 4)));
        assertTrue(result.viable());
        assertEquals(0.12 * (double) (0.6f * 0.91f), result.entryVelocity().x, 1e-15);
        assertEquals(0.16 * (double) (0.6f * 0.91f), result.entryVelocity().z, 1e-15);
    }

    @Test
    void sweptFootprintOverlapIsRiskyWhileExactTangentAndLateralMissAreNotEntries() {
        var launch = launch(new Vec3d(0, 10, 0), new Vec3d(1, -1, 0), 1, 0, false, 0);
        var edge = predict(launch, COAST, water(new Box(1.1, 9.4, -1, 1.3, 9.5, 1)));
        assertEquals(AgentWaterJumpPrediction.Verdict.RISKY, edge.verdict());
        var tangent = predict(launch, COAST, water(new Box(0.5, 9.4, 0.3, 1.5, 9.5, 0.6)));
        assertFalse(tangent.viable());
        var side = predict(launch, COAST, water(new Box(-2, 9.4, 2, 4, 9.5, 3)));
        assertEquals(AgentWaterJumpPrediction.Verdict.MISS, side.verdict());
    }

    @Test
    void visibleHeadroomOrRunwayCollisionVetoesWithoutCallingAnyWorldSampler() {
        var launch = launch(new Vec3d(0, 10, 0), Vec3d.ZERO, 1, 0, true, 0);
        var water = water(new Box(-2, 5.8, -2, 8, 6, 2));
        var ceiling = AgentWaterJumpPrediction.predict(launch, WALK, water,
            List.of(new Box(-1, 11.9, -1, 1, 12.2, 1)), NOW);
        assertEquals(AgentWaterJumpPrediction.Verdict.VISIBLE_OBSTRUCTION, ceiling.verdict());
        var wall = AgentWaterJumpPrediction.predict(launch(new Vec3d(0, 10, 0), Vec3d.ZERO, 1, 0, true, 12),
            WALK, water, List.of(new Box(0.5, 10, -1, 0.6, 12, 1)), NOW);
        assertEquals(AgentWaterJumpPrediction.Verdict.VISIBLE_OBSTRUCTION, wall.verdict());
        assertTrue(predict(launch, WALK, water).viable(), "missing obstacle evidence does not prove clear terrain");
    }

    @Test
    void missingWaterFlowKnownHazardAndUnsupportedPhysicsRemainDistinctFiniteRefusals() {
        var launch = launch(new Vec3d(0, 10, 0), Vec3d.ZERO, 1, 0, true, 0);
        var box = new Box(-2, 5.8, -2, 8, 6, 2);
        assertEquals(AgentWaterJumpPrediction.Verdict.MISSING_WATER, predict(launch, WALK, null).verdict());
        assertEquals(AgentWaterJumpPrediction.Verdict.UNSUPPORTED_FLUID,
            predict(launch, WALK, new AgentWaterJumpPrediction.WaterPatch(box, NOW, false, false)).verdict());
        assertEquals(AgentWaterJumpPrediction.Verdict.KNOWN_HAZARD,
            predict(launch, WALK, new AgentWaterJumpPrediction.WaterPatch(box, NOW, true, true)).verdict());
        var unsupported = new AgentWaterJumpPrediction.Physics(0.08, 0.42f, 0.098f, 0.6f * 0.91f,
            0.02f * 0.98f, 0.91f, 0.98f, false);
        assertEquals(AgentWaterJumpPrediction.Verdict.UNSUPPORTED, predict(launch, unsupported, water(box)).verdict());
    }

    @Test
    void currentOwnMotionIsRequiredAndWaterAgeWidensToleranceBeforeFiniteExpiry() {
        var launch = launch(new Vec3d(0, 10, 0), new Vec3d(0.4, -1, 0), 1, 0, false, 0);
        var box = new Box(-2, 9.4, -2, 4, 9.5, 2);
        var fresh = predict(launch, COAST, water(box));
        var older = predict(launch, COAST, new AgentWaterJumpPrediction.WaterPatch(box, NOW - 10, true, false));
        assertTrue(older.horizontalUncertainty() > fresh.horizontalUncertainty());
        var oldWater = predict(launch, COAST, new AgentWaterJumpPrediction.WaterPatch(
            box, NOW - AgentWaterJumpPrediction.MAX_OBSERVATION_AGE - 1, true, false));
        assertEquals(AgentWaterJumpPrediction.Verdict.STALE, oldWater.verdict());
        var staleOwnMotion = AgentWaterJumpPrediction.predict(launch, COAST, water(box), List.of(), NOW + 1);
        assertEquals(AgentWaterJumpPrediction.Verdict.STALE, staleOwnMotion.verdict());
        assertNull(staleOwnMotion.entryFeet());
    }

    @Test
    void floatDragPrecisionAndLargeCoordinatesStayFiniteWithinTheHardHorizon() {
        var launch = launch(new Vec3d(10_000_000, 10, -8_000_000), new Vec3d(0.4, -1, 0.2),
            3, 4, false, 0);
        var result = predict(launch, COAST,
            water(new Box(9_999_999, 9.4, -8_000_001, 10_000_002, 9.5, -7_999_998)));
        assertTrue(result.viable());
        assertEquals(10_000_000.2, result.entryFeet().x, 2e-9);
        assertEquals(-7_999_999.9, result.entryFeet().z, 2e-9);
        assertTrue(Double.isFinite(result.latestEntryTick()));
        var slowGravity = new AgentWaterJumpPrediction.Physics(1e-6, 0.42f, 0, 0.6f * 0.91f,
            0, 0.91f, 0.98f, true);
        var horizon = predict(launch(new Vec3d(0, 1000, 0), Vec3d.ZERO, 1, 0, false, 0),
            slowGravity, water(new Box(-1, -0.2, -1, 1, 0, 1)));
        assertEquals(AgentWaterJumpPrediction.Verdict.HORIZON, horizon.verdict());
        assertFalse(horizon.viable());
    }

    @Test
    void malformedOrUnboundedCandidatesCannotProduceAnEntryOrAnUnboundedLoop() {
        var water = water(new Box(-2, 5.8, -2, 8, 6, 2));
        assertEquals(AgentWaterJumpPrediction.Verdict.UNSUPPORTED,
            predict(launch(new Vec3d(Double.NaN, 10, 0), Vec3d.ZERO, 1, 0, true, 0), WALK, water).verdict());
        assertEquals(AgentWaterJumpPrediction.Verdict.UNSUPPORTED,
            predict(launch(new Vec3d(0, 10, 0), Vec3d.ZERO, Double.POSITIVE_INFINITY, 0, true, 0), WALK, water).verdict());
        assertEquals(AgentWaterJumpPrediction.Verdict.UNSUPPORTED,
            predict(launch(new Vec3d(0, 10, 0), Vec3d.ZERO, 0, 0, true, 0), WALK, water).verdict());
        var invalidWidth = new AgentWaterJumpPrediction.Launch(new Vec3d(0, 10, 0), Vec3d.ZERO,
            -0.6, 1.8, 1, 0, true, false, 0, NOW);
        assertEquals(AgentWaterJumpPrediction.Verdict.UNSUPPORTED, predict(invalidWidth, WALK, water).verdict());
        var invalidGravity = new AgentWaterJumpPrediction.Physics(Double.NaN, 0.42f, 0.098f,
            0.6f * 0.91f, 0, 0.91f, 0.98f, true);
        assertEquals(AgentWaterJumpPrediction.Verdict.UNSUPPORTED,
            predict(launch(new Vec3d(0, 10, 0), Vec3d.ZERO, 1, 0, true, 0), invalidGravity, water).verdict());
        assertEquals(AgentWaterJumpPrediction.Verdict.UNSUPPORTED,
            predict(launch(new Vec3d(0, 10, 0), Vec3d.ZERO, 1, 0, true,
                AgentWaterJumpPrediction.MAX_RUNUP_TICKS + 1), WALK, water).verdict());
        var launch = launch(new Vec3d(0, 10, 0), Vec3d.ZERO, 1, 0, true, 0);
        assertEquals(AgentWaterJumpPrediction.Verdict.UNSUPPORTED,
            AgentWaterJumpPrediction.predict(launch, WALK, water,
                Collections.nCopies(33, new Box(20, 0, 20, 21, 1, 21)), NOW).verdict());
        var overflowAge = new AgentWaterJumpPrediction.WaterPatch(water.bounds(), Integer.MIN_VALUE, true, false);
        assertEquals(AgentWaterJumpPrediction.Verdict.STALE,
            AgentWaterJumpPrediction.predict(launch, WALK, overflowAge, List.of(), NOW).verdict());
    }

    private static AgentWaterJumpPrediction.Physics physics(double groundAcceleration, double airAcceleration) {
        return new AgentWaterJumpPrediction.Physics(0.08, 0.42f, groundAcceleration, 0.6f * 0.91f,
            airAcceleration, 0.91f, 0.98f, true);
    }

    private static AgentWaterJumpPrediction.Launch launch(Vec3d feet, Vec3d velocity, double dx, double dz,
                                                         boolean jump, int runup) {
        return new AgentWaterJumpPrediction.Launch(feet, velocity, 0.6, 1.8, dx, dz, jump, false, runup, NOW);
    }

    private static AgentWaterJumpPrediction.WaterPatch water(Box bounds) {
        return new AgentWaterJumpPrediction.WaterPatch(bounds, NOW, true, false);
    }

    private static AgentWaterJumpPrediction.Result predict(AgentWaterJumpPrediction.Launch launch,
                                                           AgentWaterJumpPrediction.Physics physics,
                                                           AgentWaterJumpPrediction.WaterPatch water) {
        return AgentWaterJumpPrediction.predict(launch, physics, water, List.of(), NOW);
    }
}
