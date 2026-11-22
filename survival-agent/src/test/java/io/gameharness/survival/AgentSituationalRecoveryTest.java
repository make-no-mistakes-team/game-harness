package io.gameharness.survival;

import static io.gameharness.survival.AgentSituationalRecovery.NEW_GROUND;
import static io.gameharness.survival.AgentSituationalRecovery.RETURN;
import static io.gameharness.survival.AgentSituationalRecovery.provesLanding;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

final class AgentSituationalRecoveryTest {
    @Test void oneConfirmedMethodCanOpenAnIncidentAfterRealRepeatedFailure() {
        var recovery = new AgentSituationalRecovery();
        recovery.incident(7, "The nearby timber could not be collected from dry ground.");
        recovery.failure("The nearby timber could not be collected from dry ground.");
        assertNull(recovery.open(40, List.of(NEW_GROUND)));
        for (int i = 0; i < 7; ++i) recovery.failure("Attempt " + i + ": " + "é".repeat(120));
        recovery.failure("The ordinary approach did not produce settled progress.");
        var offer = recovery.open(41, List.of(NEW_GROUND));
        assertEquals(7, offer.recovery.incident());
        assertEquals(List.of(NEW_GROUND), offer.options);
        assertEquals(5, offer.recovery.history().size());
        assertEquals("The nearby timber could not be collected from dry ground.", offer.recovery.history().getFirst());
        assertTrue(offer.recovery.history().stream().allMatch(s -> s.getBytes(StandardCharsets.UTF_8).length <= 240));
        recovery.failure("A later failed look from the same footing.");
        assertSame(offer, recovery.live(100));
        assertEquals("The ordinary approach did not produce settled progress.", offer.recovery.history().getLast());
        recovery.withdraw();
        assertNull(recovery.open(101, List.of(NEW_GROUND, RETURN)));
    }

    @Test void onlyVerifiedEffectsAdvanceTheAdvisedOrderAndTheRefusalIsDurable() {
        var recovery = ready();
        var offer = recovery.open(40, List.of(RETURN, NEW_GROUND));
        recovery.accept(advice(offer, 170, RETURN, NEW_GROUND), 50);
        assertSame(RETURN, recovery.method());
        assertEquals("accepted", recovery.takeReceipts().getFirst().outcome());

        recovery.start();
        recovery.result(90, true, "settled on a checked older dry crossing");
        assertSame(NEW_GROUND, recovery.method());
        assertFalse(recovery.started());
        assertEquals(1, recovery.takeReceipts().getFirst().completed());

        recovery.result(91, false, "the next method's prerequisites no longer held");
        assertFalse(recovery.active());
        assertTrue(recovery.activity(105).contains("after confirming 1/2"));
        var stop = recovery.takeReceipts().getFirst();
        assertEquals("plan-id", stop.advice());
        assertEquals(NEW_GROUND.id(), stop.method());
        assertEquals("stopped", stop.outcome());
        assertEquals(1, stop.completed());
        assertNull(recovery.live(100));
    }

    @Test void staleAdviceCannotActAndExpiredMovementCannotBeCredited() {
        var recovery = ready();
        var first = recovery.open(40, List.of(NEW_GROUND));
        var expired = advice(first, 51, NEW_GROUND);
        recovery.accept(expired, 52);
        assertFalse(recovery.active());
        recovery.incident(8, "No settled work after the observed attempt.");
        recovery.failure("A distinct retry also failed.");
        var next = recovery.open(52, List.of(NEW_GROUND));
        recovery.accept(advice(first, 90, NEW_GROUND), 55);
        assertFalse(recovery.active());

        recovery.accept(advice(next, 85, NEW_GROUND), 56);
        recovery.start();
        recovery.result(86, true, "a landing outside the advice's lifetime");
        assertFalse(recovery.active());
        var receipts = recovery.takeReceipts();
        assertEquals(List.of("accepted", "stopped"), receipts.stream().map(AgentSituationalRecovery.Receipt::outcome).toList());
        assertEquals("the advice expired", receipts.getLast().detail());
        assertEquals(0, receipts.getLast().completed());
    }

    @Test void handBackCoastingAndRevisitsCannotConfirmAnOpenGroundRelocation() {
        assertFalse(provesLanding(false, true, true, 2.5, true));
        assertFalse(provesLanding(true, true, false, 2.5, true));
        assertFalse(provesLanding(true, false, true, 2.5, true));
        assertFalse(provesLanding(true, true, true, 0.90, true));
        assertTrue(provesLanding(true, true, true, 1.80, true));
        assertTrue(provesLanding(true, true, true, 0.90, false)); // An exact checked return or rise.
    }

    @Test void aSuccessfulSequenceRetainsItsFinalEffectReceipt() {
        var recovery = ready();
        var offer = recovery.open(40, List.of(RETURN, NEW_GROUND));
        recovery.accept(advice(offer, 320, RETURN, NEW_GROUND), 60);
        recovery.start();
        recovery.result(85, true, "settled on the checked return lane");
        recovery.start();
        recovery.result(120, true, "settled 1.8 blocks from the start");
        assertFalse(recovery.active());
        assertTrue(recovery.activity(130).contains("relocate_visible (2/2)"));
        assertEquals(List.of("accepted", "confirmed", "confirmed"),
            recovery.takeReceipts().stream().map(AgentSituationalRecovery.Receipt::outcome).toList());
        assertNull(recovery.activity(245));
    }

    private static AgentSituationalRecovery ready() {
        var recovery = new AgentSituationalRecovery();
        recovery.incident(7, "No settled work after the observed attempt.");
        recovery.failure("The ordinary retry came back to the same stall.");
        return recovery;
    }

    private static AgentExpedition.Candidate advice(AgentExpedition.Offer offer, long expires,
                                                     AgentExpedition.Option... steps) {
        return new AgentExpedition.Candidate(1, 40, expires, "plan-id", offer, steps[0],
            new AgentExpedition.RecoveryPlan("Reach safer ground away from the original work", List.of(steps)));
    }
}
