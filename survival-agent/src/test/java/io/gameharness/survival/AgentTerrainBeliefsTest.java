package io.gameharness.survival;

import static io.gameharness.survival.AgentTerrainBeliefs.Context.EXCAVATION;
import static io.gameharness.survival.AgentTerrainBeliefs.Context.TRUNK;
import static io.gameharness.survival.AgentTerrainBeliefs.Material.AIR;
import static io.gameharness.survival.AgentTerrainBeliefs.Material.BASE_ROCK;
import static io.gameharness.survival.AgentTerrainBeliefs.Material.FLUID;
import static io.gameharness.survival.AgentTerrainBeliefs.Material.LOG;
import static io.gameharness.survival.AgentTerrainBeliefs.Material.OTHER;
import static io.gameharness.survival.AgentTerrainBeliefs.Outcome.COLLISION;
import static io.gameharness.survival.AgentTerrainBeliefs.Outcome.FALL;
import static io.gameharness.survival.AgentTerrainBeliefs.Outcome.SUPPORTED;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class AgentTerrainBeliefsTest {
    private static final BlockPos ROCK = new BlockPos(0, 40, 0);
    private static final BlockPos LOG_TOP = new BlockPos(0, 75, 0);

    @Test
    void contiguousExposedRockPermitsContinuedExcavationWithoutObservingEachNextCell() {
        var beliefs = new AgentTerrainBeliefs();
        beliefs.observe(ROCK, BASE_ROCK, 10);
        assertNull(beliefs.permit(EXCAVATION, ROCK, ROCK.east(), 10));
        beliefs.observe(ROCK.up(), BASE_ROCK, 10);

        var first = beliefs.permit(EXCAVATION, ROCK, ROCK.east(), 11);
        assertNotNull(first);
        assertEquals(BASE_ROCK, first.expected());
        assertEquals(AgentTerrainBeliefs.Basis.CONTIGUOUS_EXPOSED_ROCK, first.basis());
        assertEquals(AgentTerrainBeliefs.Confidence.CORROBORATED, first.confidence());
        assertEquals(EXCAVATION, first.scope().context());
        assertEquals(ROCK, first.scope().anchor());
        assertEquals(1, first.ageAt(12));
        assertNull(beliefs.observed(first.target(), 11));
        assertTrue(beliefs.valid(first, 11));

        // Only after ordinary excavation actually exposes the next base-rock face is it observed.
        beliefs.observe(first.target(), BASE_ROCK, 12);
        assertFalse(beliefs.valid(first, 12));
        var continued = beliefs.permit(EXCAVATION, first.target(), first.target().east(), 13);
        assertNotNull(continued);
        assertEquals(BASE_ROCK, continued.expected());
        assertNull(beliefs.observed(continued.target(), 13));
    }

    @Test
    void occupiedTrunkPermitsOneCutAndVerticalObservationsStrengthenItsConcreteBasis() {
        var beliefs = new AgentTerrainBeliefs();
        beliefs.observe(LOG_TOP, LOG, 20);
        var first = beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 21);
        assertNotNull(first);
        assertEquals(LOG, first.expected());
        assertEquals(AgentTerrainBeliefs.Basis.OCCUPIED_LOG_CONTINUATION, first.basis());
        assertEquals(AgentTerrainBeliefs.Confidence.CONTEXTUAL, first.confidence());
        assertEquals(0, first.scope().radius());
        assertNull(beliefs.observed(LOG_TOP.down(), 21));
        assertNull(beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.east(), 21));
        assertNull(beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(2), 21));

        // Actual settling is not a log receipt.
        beliefs.feedback(first, SUPPORTED, 22);
        assertNull(beliefs.observed(first.target(), 22));
        assertFalse(beliefs.valid(first, 22));
        beliefs.observe(first.target(), LOG, 23);
        var second = beliefs.permit(TRUNK, first.target(), first.target().down(), 24);
        assertNotNull(second);
        assertEquals(AgentTerrainBeliefs.Basis.EXPOSED_VERTICAL_LOG_PAIR, second.basis());
        assertEquals(AgentTerrainBeliefs.Confidence.CORROBORATED, second.confidence());
        assertNull(beliefs.observed(second.target(), 24));
    }

    @Test
    void exposedAirFluidOrDifferentMaterialRefutesThePremiseAndRequiresChangedCourse() {
        for (var contradiction : new AgentTerrainBeliefs.Material[] {AIR, FLUID, OTHER, LOG}) {
            var beliefs = new AgentTerrainBeliefs();
            observeRockPair(beliefs, ROCK, 30);
            var cut = beliefs.permit(EXCAVATION, ROCK, ROCK.east(), 31);
            assertNotNull(cut);
            beliefs.observe(cut.target(), contradiction, 32);
            assertFalse(beliefs.valid(cut, 32));
            assertEquals(contradiction, beliefs.observed(cut.target(), 32).material());

            // Looking again or picking an adjacent cell cannot revive the disconfirmed local prior.
            observeRockPair(beliefs, ROCK, 33);
            assertNull(beliefs.permit(EXCAVATION, ROCK, ROCK.north(), 33));
            assertNull(beliefs.permit(EXCAVATION, ROCK, ROCK.east(), 33));

            BlockPos changedCourse = ROCK.east(20);
            observeRockPair(beliefs, changedCourse, 34);
            assertNotNull(beliefs.permit(EXCAVATION, changedCourse, changedCourse.east(), 35));
        }
    }

    @Test
    void actualFallOrCollisionAbandonsThatTrunkRatherThanRetryingTheSamePremise() {
        for (var outcome : new AgentTerrainBeliefs.Outcome[] {FALL, COLLISION}) {
            var beliefs = new AgentTerrainBeliefs();
            beliefs.observe(LOG_TOP, LOG, 40);
            var cut = beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 41);
            assertNotNull(cut);
            beliefs.feedback(cut, outcome, 42);
            assertFalse(beliefs.valid(cut, 42));
            beliefs.observe(LOG_TOP.down(), LOG, 43);
            assertNull(beliefs.permit(TRUNK, LOG_TOP.down(), LOG_TOP.down(2), 43));
            beliefs.observe(LOG_TOP, LOG, 44);
            assertNull(beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 44));

            BlockPos differentTrunk = LOG_TOP.east(3);
            beliefs.observe(differentTrunk, LOG, 44);
            assertNotNull(beliefs.permit(TRUNK, differentTrunk, differentTrunk.down(), 45));
        }
    }

    @Test
    void breakingTheObservedSourceDoesNotRefuteItsUnseenSupportBeforeActualFeedback() {
        var beliefs = new AgentTerrainBeliefs();
        beliefs.observe(LOG_TOP, LOG, 45);
        var cut = beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 46);
        assertNotNull(cut);
        beliefs.observe(LOG_TOP, AIR, 47);
        assertTrue(beliefs.valid(cut, 47));
        assertNull(beliefs.observed(cut.target(), 47));
        beliefs.observe(cut.target(), FLUID, 48);
        assertFalse(beliefs.valid(cut, 48));
    }

    @Test
    void finiteHorizonCannotBeRefilledByRepeatedViewsOrSupportWithoutMaterialEvidence() {
        var beliefs = new AgentTerrainBeliefs();
        observeRockPair(beliefs, ROCK, 50);
        BlockPos[] targets = {ROCK.east(), ROCK.west(), ROCK.north()};
        int now = 51;
        for (BlockPos target : targets) {
            var action = beliefs.permit(EXCAVATION, ROCK, target, now);
            assertNotNull(action);
            beliefs.feedback(action, SUPPORTED, now + 1);
            beliefs.observe(ROCK, BASE_ROCK, now + 2);
            assertNull(beliefs.observed(target, now + 2));
            now += 3;
        }
        assertNull(beliefs.permit(EXCAVATION, ROCK, ROCK.south(), now));
        assertNull(beliefs.permit(EXCAVATION, ROCK, ROCK.east(), now));
        beliefs.observe(ROCK, BASE_ROCK, now + 1);
        assertNull(beliefs.permit(EXCAVATION, ROCK, ROCK.south(), now + 1));
        // One newly exposed cell restores only the one spent action grounded in that observation.
        beliefs.observe(ROCK.east(), BASE_ROCK, now + 2);
        assertNotNull(beliefs.permit(EXCAVATION, ROCK, ROCK.south(), now + 3));
        assertNull(beliefs.permit(EXCAVATION, ROCK, ROCK.down(), now + 3));
    }

    @Test
    void staleEvidenceAndPermitsCannotSurviveAWorldOrLifeReset() {
        var beliefs = new AgentTerrainBeliefs();
        beliefs.observe(LOG_TOP, LOG, 60);
        var oldLife = beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 61);
        assertNotNull(oldLife);
        assertFalse(beliefs.valid(oldLife, 61 + AgentTerrainBeliefs.MAX_AGE_TICKS + 1));
        assertNull(beliefs.observed(LOG_TOP, 60 + AgentTerrainBeliefs.MAX_AGE_TICKS + 1));
        assertNull(beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 300));
        assertFalse(beliefs.valid(oldLife, 59));
        beliefs.feedback(oldLife, FALL, 301);

        beliefs.reset();
        assertNull(beliefs.observed(LOG_TOP, 1));
        assertFalse(beliefs.valid(oldLife, 1));
        assertNull(beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 1));
        beliefs.observe(LOG_TOP, LOG, 2);
        var newLife = beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 3);
        assertNotNull(newLife);
        assertTrue(beliefs.valid(newLife, 3));
        // A delayed outcome from the previous life cannot poison a new-life permit.
        beliefs.feedback(oldLife, COLLISION, 4);
        assertTrue(beliefs.valid(newLife, 4));
    }

    @Test
    void genericRockHypothesesNeverBecomeObservedOreResourcesOrVerifiedPaths() {
        var beliefs = new AgentTerrainBeliefs();
        observeRockPair(beliefs, ROCK, 70);
        var hypothesis = beliefs.permit(EXCAVATION, ROCK, ROCK.east(), 71);
        assertNotNull(hypothesis);
        assertEquals(BASE_ROCK, hypothesis.expected());
        assertNull(beliefs.observed(hypothesis.target(), 71));
        assertNull(beliefs.permit(EXCAVATION, hypothesis.target(), hypothesis.target().east(), 71));
        beliefs.feedback(hypothesis, SUPPORTED, 72);
        assertNull(beliefs.observed(hypothesis.target(), 72));

        // An actual exposed non-base block (including ore) is not generalized into hidden ore.
        beliefs.observe(hypothesis.target(), OTHER, 73);
        assertNull(beliefs.permit(EXCAVATION, hypothesis.target(), hypothesis.target().east(), 73));
        assertEquals(OTHER, beliefs.observed(hypothesis.target(), 73).material());
    }

    @Test
    void boundedScopeStorageDoesNotEvictAContradictionIntoFreshPermission() {
        var beliefs = new AgentTerrainBeliefs();
        beliefs.observe(LOG_TOP, LOG, 80);
        var failed = beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 80);
        assertNotNull(failed);
        beliefs.feedback(failed, FALL, 81);
        for (int i = 1; i < 32; i++) {
            BlockPos trunk = LOG_TOP.east(i * 3);
            beliefs.observe(trunk, LOG, 82);
            assertNotNull(beliefs.permit(TRUNK, trunk, trunk.down(), 82));
        }
        BlockPos beyondCapacity = LOG_TOP.east(100);
        beliefs.observe(beyondCapacity, LOG, 83);
        assertNull(beliefs.permit(TRUNK, beyondCapacity, beyondCapacity.down(), 83));
        for (int i = 0; i < 140; i++) beliefs.observe(ROCK.east(i), OTHER, 84);
        beliefs.observe(LOG_TOP, LOG, 85);
        assertNull(beliefs.permit(TRUNK, LOG_TOP, LOG_TOP.down(), 85));
    }

    private static void observeRockPair(AgentTerrainBeliefs beliefs, BlockPos source, int tick) {
        beliefs.observe(source, BASE_ROCK, tick);
        beliefs.observe(source.up(), BASE_ROCK, tick);
    }
}
