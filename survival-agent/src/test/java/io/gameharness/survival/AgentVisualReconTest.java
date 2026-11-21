package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

final class AgentVisualReconTest {
    private static final Vec3d FOCUS = new Vec3d(10, 1, 0);
    private static final AgentVisualRecon.Leg FORWARD = new AgentVisualRecon.Leg(0, -90, 1, 0, 1.35);

    @Test
    void aNominatedSurfaceOrTheOldOpportunityAloneCannotGrantMovement() {
        var bounds = new AgentVisualRecon.Bounds(3, 6);
        assertFalse(AgentVisualRecon.grants(null, "visible-face", null, true));
        assertFalse(AgentVisualRecon.grants(bounds, null, null, true));
        assertFalse(AgentVisualRecon.grants(bounds, "visible-face", null, false));
        assertFalse(AgentVisualRecon.grants(bounds, "visible-face", "visible-face", true));
        assertTrue(AgentVisualRecon.grants(bounds, "visible-face", "earlier-face", true));
    }

    @Test
    void boundsRequireExactlyTwoInRangeIntegers() {
        assertEquals(new AgentVisualRecon.Bounds(3, 6), bounds("{\"maxLegs\":3,\"maxBlocks\":6}"));
        assertThrows(RuntimeException.class, () -> bounds("{\"maxLegs\":1,\"maxBlocks\":7}"));
        assertThrows(RuntimeException.class, () -> bounds("{\"maxLegs\":0,\"maxBlocks\":1}"));
        assertThrows(RuntimeException.class, () -> bounds("{\"maxLegs\":4,\"maxBlocks\":6}"));
        assertThrows(RuntimeException.class, () -> bounds("{\"maxLegs\":1,\"maxBlocks\":0}"));
        assertThrows(RuntimeException.class, () -> bounds("{\"maxLegs\":1.5,\"maxBlocks\":2}"));
        assertThrows(RuntimeException.class, () -> bounds("{\"maxLegs\":\"1\",\"maxBlocks\":2}"));
        assertThrows(RuntimeException.class, () -> bounds("{\"maxLegs\":1,\"maxBlocks\":2,\"jump\":true}"));
    }

    @Test
    void threeSeparatelySettledLegsArePhysicalProgressAndAFourthCannotStart() {
        var walk = new OnFoot(3, 6);
        walk.leg(FORWARD);
        walk.leg(FORWARD);
        walk.leg(FORWARD);
        assertEquals(3, walk.grant.legs());
        assertTrue(walk.grant.travel() > 3.2 && walk.grant.travel() < 4.05);
        assertEquals(walk.feet.x, walk.grant.travel(), 1e-9);
        assertFalse(walk.grant.canStartLeg());
        assertThrows(IllegalStateException.class, () -> walk.grant.start(FORWARD));
        assertTrue(walk.grant.receipt("Stopped.").contains("Fresh settled render"));
    }

    @Test
    void cumulativeTravelIncludesCoastAndIsNotNetDisplacement() {
        var walk = new OnFoot(2, 3);
        double diagonal = Math.sqrt(0.5);
        walk.leg(new AgentVisualRecon.Leg(-1, -135, diagonal, -diagonal, 1.2));
        walk.leg(new AgentVisualRecon.Leg(1, -45, diagonal, diagonal, 1.2));
        assertEquals(2, walk.grant.legs());
        assertTrue(walk.grant.travel() > walk.feet.horizontalLength() + 0.55);
        assertTrue(walk.grant.travel() < 2.4);
    }

    @Test
    void aOneBlockGrantReservesEnoughRoomForVanillaToCoast() {
        var walk = new OnFoot(3, 1);
        var shortLeg = new AgentVisualRecon.Leg(0, -90, 1, 0, 1);
        walk.leg(shortLeg);
        assertEquals(1, walk.grant.legs());
        assertTrue(walk.grant.travel() > 0.65 && walk.grant.travel() < 1);
        assertTrue(walk.grant.remaining() < 0.35);
        assertThrows(IllegalStateException.class, () -> walk.grant.start(shortLeg));
    }

    @Test
    void aWitnessedRiseReservesTheAbortTrajectoryAndChargesRealVerticalMotion() {
        var tooShort = grant(1, 3, 100);
        var rise = new AgentVisualRecon.Leg(0, -90, 1, 0, 3.9, 1, 2.72);
        assertThrows(IllegalStateException.class, () -> tooShort.start(rise));

        var run = grant(2, 6, 100);
        run.start(rise);
        double envelope = AgentVisualRecon.gradeKeyEnvelope(Vec3d.ZERO, true);
        assertTrue(run.admitsGradeKey(envelope, 1.05));
        assertFalse(run.admitsGradeKey(envelope, 0.20));
        run.issued(10);
        run.sample(11, new Vec3d(0.10, 0.42, 0), true, false);
        run.issued(11);
        run.sample(12, new Vec3d(0.22, 0.75, 0), true, false);
        run.issued(12);
        run.sample(13, new Vec3d(0.34, 1.01, 0), true, false);
        run.sample(14, new Vec3d(0.48, 1.23, 0), true, false);
        run.sample(15, new Vec3d(0.61, 1.25, 0), true, false);
        run.sample(16, new Vec3d(0.71, 1.19, 0), true, false);
        run.brake(26);
        run.sample(17, new Vec3d(0.80, 1, 0), true, false);
        assertFalse(run.settle(26, true));
        assertTrue(run.settle(27, true));
        assertEquals(1, run.legs());
        assertTrue(run.travel() > 1.70 && run.travel() < 2.3);
        assertTrue(run.canStartLeg());
    }

    @Test
    void anUnjoinedReceivingSupportNeverCompletesAGrade() {
        var run = grant(2, 6, 100);
        run.start(new AgentVisualRecon.Leg(0, -90, 1, 0, 2.7, -1, 1.12));
        run.issued(10);
        run.sample(11, new Vec3d(0.19, -0.36, 0), true, false);
        run.brake(15);
        run.sample(12, new Vec3d(0.38, -0.71, 0), true, false);
        run.sample(13, new Vec3d(0.55, -1.0, 0), true, false);
        assertTrue(run.settle(16, false));
        assertEquals(0, run.legs());
        assertTrue(run.travel() > 1.12);
        assertFalse(run.canStartLeg());
    }

    @Test
    void expiryInClientTicksOrWallTimePreventsNewKeys() {
        var shortGrant = grant(1, 1, 24);
        assertTrue(shortGrant.timeForKey(12, 0));
        assertFalse(shortGrant.timeForKey(14, 0));
        assertFalse(shortGrant.live(24, 0));
        var wallBound = grant(3, 6, 500);
        assertTrue(wallBound.timeForKey(12, 4_000_000_000L));
        assertFalse(wallBound.timeForKey(12, 4_900_000_000L));
        assertFalse(wallBound.live(12, 5_000_000_000L));
        assertFalse(wallBound.live(110, 0));
    }

    @Test
    void aMissingTickCannotBeReconstructedFromLaterMotion() {
        var run = partial();
        run.sample(13, point(0.32), true, false);
        run.brake(30);
        run.sample(14, point(0.40), true, false);
        assertTrue(run.settle(31));
        assertEquals(0.10, run.travel(), 1e-9);
        assertEquals(0, run.legs());
        assertTrue(run.interruption().contains("gap"));
    }

    @Test
    void aReversalStopsAndNeverSubtractsFromOrInflatesTheKnownPath() {
        var run = partial();
        run.issued(11);
        run.sample(12, point(0.06), true, false);
        assertEquals(0.10, run.travel(), 1e-9);
        assertFalse(run.admitsKey(Vec3d.ZERO, 1.6));
        assertNotNull(run.interruption());
    }

    @Test
    void knockbackAndFollowingDriftCannotBeCreditedAsScoutProgress() {
        var run = partial();
        run.issued(11);
        run.sample(12, point(0.62), true, true);
        run.brake(20);
        run.sample(13, point(0.66), true, false);
        assertTrue(run.settle(21));
        assertEquals(0.10, run.travel(), 1e-9);
        assertEquals(0, run.legs());
        assertTrue(run.receipt("Aborted.").contains("knockback was not credited"));
    }

    @Test
    void lostSightOrAnInventoryChangeBrakesWithoutNewKeysAndKeepsRealPartialEffects() {
        for (boolean stockChanged : new boolean[] {false, true}) {
            var run = partial();
            run.observePremises(true, true, !stockChanged, stockChanged);
            assertFalse(run.admitsKey(Vec3d.ZERO, 1.6));
            run.brake(31);
            run.sample(12, point(0.15), true, false);
            assertFalse(run.settle(31));
            assertTrue(run.settle(32));
            assertFalse(run.canStartLeg());
            assertEquals(0.15, run.travel(), 1e-9);
            assertEquals(0, run.legs());
            assertTrue(run.interruption().contains(stockChanged ? "no pickup or spending" : "unobstructed"));
        }
    }

    @Test
    void replacingTheActiveGrantStopsEvenIfTheExactSurfaceRemainsVisible() {
        var run = partial();
        run.observePremises(false, true, true, true);
        assertFalse(run.admitsKey(Vec3d.ZERO, 1.6));
        assertTrue(run.interruption().contains("no longer granting"));
    }

    private static AgentVisualRecon.Bounds bounds(String json) {
        return AgentVisualRecon.Bounds.read(JsonParser.parseString(json).getAsJsonObject());
    }

    private static AgentVisualRecon grant(int legs, int blocks, long expires) {
        return new AgentVisualRecon(new AgentVisualRecon.Bounds(legs, blocks), Vec3d.ZERO, FOCUS, 10, 0, expires);
    }

    private static AgentVisualRecon partial() {
        var run = grant(2, 3, 100);
        run.start(FORWARD);
        run.issued(10);
        run.sample(11, point(0.10), true, false);
        return run;
    }

    private static Vec3d point(double x) { return new Vec3d(x, 0, 0); }

    /** Normal-traction vanilla walking and neutral drag; the ledger receives only realized positions. */
    private static final class OnFoot {
        final AgentVisualRecon grant;
        Vec3d feet = Vec3d.ZERO, velocity = Vec3d.ZERO;
        long tick = 10, rendered = 15;

        OnFoot(int legs, int blocks) { grant = grant(legs, blocks, 120); }

        void leg(AgentVisualRecon.Leg leg) {
            grant.start(leg);
            for (int i = 0; i < 18 && grant.admitsKey(velocity, 1.60); ++i) {
                grant.issued(tick);
                advance(velocity.add(leg.dx() * 0.098, 0, leg.dz() * 0.098));
            }
            grant.brake(rendered);
            assertFalse(grant.settle(rendered));
            assertFalse(grant.canStartLeg());
            double beforeCoast = grant.travel();
            for (int i = 0; i < 8 && velocity.horizontalLength() >= 0.003; ++i) advance(velocity);
            velocity = Vec3d.ZERO;
            assertTrue(grant.travel() > beforeCoast);
            assertTrue(grant.settle(++rendered));
        }

        void advance(Vec3d step) {
            feet = feet.add(step);
            velocity = step.multiply(0.546);
            grant.sample(++tick, feet, true, false);
        }
    }
}
