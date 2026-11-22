package io.gameharness.survival;

import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentDefense.MeleeRecovery.DryAction.*;
import static io.gameharness.survival.AgentDefense.MeleeRecovery.Evidence.*;
import static io.gameharness.survival.AgentDefense.MeleeRecovery.Footing.*;
import static org.junit.jupiter.api.Assertions.*;

final class MeleeRecoveryTest {
    @Test
    void freshDamageOwnsRecoveryDespiteRepeatedMissingCombatFrames() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(100, IMPACT, false, false, DRY));
        assertTrue(recovery.observe(115, NONE, false, false, DRY));
        assertTrue(recovery.observe(120, IMPACT, false, false, DRY));
        assertTrue(recovery.observe(155, NONE, false, false, DRY));
        assertFalse(recovery.observe(185, NONE, false, false, DRY));
    }

    @Test
    void underEquippedContactActsBeforeDamageAndSeparatingDoesNotEraseAFreshHit() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(200, CONTACT, false, false, DRY));
        assertTrue(recovery.observe(206, IMPACT, false, true, DRY));
        assertTrue(recovery.observe(228, NONE, false, true, DRY));
        assertFalse(recovery.observe(240, NONE, false, true, DRY));
    }

    @Test
    void noContactDoesNotClaimAnIdleTick() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertFalse(recovery.observe(10, NONE, true, false, DRY));
        assertFalse(recovery.observe(11, AMBIENT, true, false, WET));
        assertFalse(recovery.needsShore());
    }

    @Test
    void aSwimmerBelowDryFootingDoesNotKeepAContactOnlyRetreatAlive() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(4184, CONTACT, false, false, DRY));
        // As in the shoreline recording, the player can aim down at the drowned,
        // but the drowned's head is still below the player's dry footing.
        boolean separated = AgentDefense.MeleeRecovery.separatedShoreSwimmer(true, true, false, false, 0.9);
        assertTrue(separated);
        assertFalse(recovery.observe(4185, NONE, false, separated, DRY));
        assertFalse(recovery.observe(4186, AMBIENT, false, separated, DRY));
    }

    @Test
    void aSwimmerThatClosesTheGapIsNotExcludedFromImmediateDefense() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(AgentDefense.MeleeRecovery.separatedShoreSwimmer(true, true, false, false, 0.9));
        boolean separated = AgentDefense.MeleeRecovery.separatedShoreSwimmer(true, true, false, false, 0.25);
        assertFalse(separated);
        assertTrue(recovery.observe(4270, CONTACT, false, separated, DRY));
    }

    @Test
    void dryContactWetFootingAndHeldTridentsAreNotSeparatedShoreSightings() {
        assertFalse(AgentDefense.MeleeRecovery.separatedShoreSwimmer(true, false, false, false, 0.9),
            "a drowned already on land is not a swimmer");
        assertFalse(AgentDefense.MeleeRecovery.separatedShoreSwimmer(false, true, false, false, 0.9),
            "no exception during wading or a fall");
        assertFalse(AgentDefense.MeleeRecovery.separatedShoreSwimmer(true, true, true, false, 0.9),
            "the height gap does not prevent a trident throw");
    }

    @Test
    void aNewImpactIsNotDismissedByAnUnrelatedSwimmerBelowTheBank() {
        var recovery = new AgentDefense.MeleeRecovery();
        boolean separated = AgentDefense.MeleeRecovery.separatedShoreSwimmer(true, true, false, false, 0.9);
        assertTrue(recovery.observe(2968, IMPACT, false, separated, DRY));
        assertTrue(recovery.observe(2969, NONE, false, separated, DRY));
        assertFalse(AgentDefense.MeleeRecovery.separatedShoreSwimmer(true, true, false, true, 0.9),
            "a recent visually corroborated attacker is not treated as an unrelated sighting");
    }

    @Test
    void repeatedCriticalImpactsKeepOwnershipWithoutInventingSeparation() {
        // Ordinary campaign: 7.708 -> 5.708 HP, then 3.708 -> 1.708.
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(665, IMPACT, false, false, DRY));
        assertFalse(recovery.observe(729, AMBIENT, false, false, DRY));
        assertTrue(recovery.observe(1679, IMPACT, true, false, DRY));
        assertTrue(recovery.observe(1700, IMPACT, true, false, DRY));
        assertTrue(recovery.observe(1788, NONE, true, false, DRY));
        assertFalse(recovery.observe(1800, AMBIENT, true, false, DRY));
    }

    @Test
    void wetCaveHitRetainsEscapeAcrossKnockbackAboveWaterUntilTheDryBankSettles() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(20172, IMPACT, true, false, DRY));
        assertTrue(recovery.observe(20184, NONE, true, false, WET));
        assertTrue(recovery.needsShore());
        assertTrue(recovery.observe(20196, IMPACT, true, false, UNSETTLED));
        assertTrue(recovery.needsShore());
        assertTrue(recovery.observe(20208, NONE, true, false, WET));
        assertTrue(recovery.observe(20318, NONE, true, false, WET));
        assertTrue(recovery.observe(20319, NONE, true, false, DRY));
        assertTrue(recovery.needsShore());
        recovery.leaveShore(true);
        assertFalse(recovery.needsShore());
        assertFalse(recovery.observe(20324, NONE, true, false, DRY));
    }

    @Test
    void firstUnlocatedHitInWaterStartsEmergencyWithoutAmbientCueOrStall() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(100, IMPACT, true, false, WET));
        assertTrue(recovery.needsShore());
        assertTrue(recovery.observe(112, NONE, true, false, WET));
        assertTrue(recovery.needsShore());
        assertFalse(recovery.observe(113, NONE, true, false, VEHICLE));
        assertFalse(recovery.needsShore());
    }

    @Test
    void aSettledBankReturnsControlOnlyAfterQuietWithoutCloseContact() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(100, IMPACT, true, false, WET));
        recovery.leaveShore(true);
        assertTrue(recovery.observe(118, NONE, true, false, DRY));
        assertTrue(recovery.observe(132, CONTACT, true, false, DRY));
        assertFalse(recovery.observe(133, AMBIENT, true, false, DRY));
    }

    @Test
    void knockbackStopsRetreatButNotAVisibleCounter() {
        assertEquals(COUNTER, AgentDefense.MeleeRecovery.dryAction(true, true, true, true));
        assertEquals(COUNTER, AgentDefense.MeleeRecovery.dryAction(false, false, true, true));
        assertEquals(COUNTER, AgentDefense.MeleeRecovery.dryAction(true, false, false, true));
        assertEquals(RETREAT, AgentDefense.MeleeRecovery.dryAction(true, false, true, true));
    }

    @Test
    void noReachableVisualContactMeansSurveyOrWaitWithoutAttacking() {
        assertEquals(WAIT, AgentDefense.MeleeRecovery.dryAction(false, false, false, false));
        assertEquals(WAIT, AgentDefense.MeleeRecovery.dryAction(true, true, true, false));
        assertEquals(SURVEY, AgentDefense.MeleeRecovery.dryAction(true, false, false, false));
        assertEquals(RETREAT, AgentDefense.MeleeRecovery.dryAction(true, false, true, false));
    }

    @Test
    void aFreshGroanCanReorientAfterAnEarlierTurnWhileAnOldCueCannot() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(2968, IMPACT, false, false, DRY));
        var first = new AgentEars.MeleeCue(45, 1);
        assertEquals(45f, recovery.lookBearing(2968, first, -90));
        recovery.finishLook();
        assertTrue(Float.isNaN(recovery.lookBearing(2969, first, -90)));
        assertTrue(recovery.observe(2996, IMPACT, false, false, UNSETTLED));
        var second = new AgentEars.MeleeCue(-90, 2);
        assertEquals(-90f, recovery.lookBearing(2999, second, Float.NaN));
        assertEquals(-90f, recovery.lookBearing(3006, null, Float.NaN));
        assertTrue(Float.isNaN(recovery.lookBearing(3021, second, Float.NaN)));
    }

    @Test
    void aNewlyHeardGroanOverridesAnUnconfirmedKnockbackBearing() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(2968, IMPACT, false, false, UNSETTLED));
        assertEquals(90f, recovery.lookBearing(2969, null, 90));
        assertEquals(45f, recovery.lookBearing(2972, new AgentEars.MeleeCue(45, 1), Float.NaN));
        recovery.finishLook();
        assertTrue(recovery.observe(2996, IMPACT, false, false, UNSETTLED));
        assertEquals(-90f, recovery.lookBearing(2996, null, -90));
    }

    @Test
    void retreatReceiptRequiresGroundedVoluntaryHorizontalDrive() {
        assertFalse(AgentDefense.MeleeRecovery.checkedStride(false, true, false, 0.18, 0.0, 0.0));
        assertFalse(AgentDefense.MeleeRecovery.checkedStride(true, false, false, 0.18, 0.42, 0.0));
        assertFalse(AgentDefense.MeleeRecovery.checkedStride(true, true, true, 0.18, 0.0, 0.0));
        assertFalse(AgentDefense.MeleeRecovery.checkedStride(true, true, false, 0.04, 0.0, 0.04));
        assertTrue(AgentDefense.MeleeRecovery.checkedStride(true, true, false, 0.15, 0.0, 0.08));
    }

    @Test
    void firstWitnessedStrideDoesNotImplySprintReserve() {
        assertFalse(AgentDefense.MeleeRecovery.canSprint(0.78, 0, 20, false));
        assertTrue(AgentDefense.MeleeRecovery.canSprint(2.55, 0, 20, false));
        assertFalse(AgentDefense.MeleeRecovery.canSprint(2.55, 0.45, 20, true));
        assertFalse(AgentDefense.MeleeRecovery.canSprint(3.05, 0, 6, false));
    }
}
