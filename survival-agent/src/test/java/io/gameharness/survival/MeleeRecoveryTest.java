package io.gameharness.survival;

import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentDefense.MeleeRecovery.Evidence.*;
import static org.junit.jupiter.api.Assertions.*;

final class MeleeRecoveryTest {
    @Test
    void freshDamageOwnsRecoveryDespiteRepeatedMissingCombatFrames() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(100, IMPACT, false, false));
        assertTrue(recovery.observe(115, NONE, false, false));
        assertTrue(recovery.observe(120, IMPACT, false, false));
        assertTrue(recovery.observe(155, NONE, false, false));
        assertFalse(recovery.observe(185, NONE, false, false));
    }

    @Test
    void underEquippedContactActsBeforeDamageAndSeparatingDoesNotEraseAFreshHit() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(200, CONTACT, false, false));
        assertTrue(recovery.observe(206, IMPACT, false, true));
        assertTrue(recovery.observe(228, NONE, false, true));
        assertFalse(recovery.observe(240, NONE, false, true));
    }

    @Test
    void noContactDoesNotClaimAnIdleTick() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertFalse(recovery.observe(10, NONE, true, false));
        assertFalse(recovery.observe(11, AMBIENT, true, false));
    }

    @Test
    void repeatedCriticalImpactsKeepOwnershipWithoutInventingSeparation() {
        // Ordinary campaign: 7.708 -> 5.708 HP, then 3.708 -> 1.708.
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(665, IMPACT, false, false));
        assertFalse(recovery.observe(729, AMBIENT, false, false));
        assertTrue(recovery.observe(1679, IMPACT, true, false));
        assertTrue(recovery.observe(1700, IMPACT, true, false));
        assertTrue(recovery.observe(1788, NONE, true, false));
        assertFalse(recovery.observe(1800, AMBIENT, true, false));
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
