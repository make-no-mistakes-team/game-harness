package io.gameharness.survival;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

final class MeleeRecoveryTest {
    @Test
    void freshDamageOwnsRecoveryDespiteRepeatedMissingCombatFrames() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(100, true, false, false));
        assertTrue(recovery.observe(115, false, false, false));
        assertTrue(recovery.observe(120, true, false, false));
        assertTrue(recovery.observe(155, false, false, false));
        assertFalse(recovery.observe(185, false, false, false));
    }

    @Test
    void underEquippedContactActsBeforeDamageAndSeparatingDoesNotEraseAFreshHit() {
        var recovery = new AgentDefense.MeleeRecovery();
        assertTrue(recovery.observe(200, false, true, false));
        assertTrue(recovery.observe(206, true, false, true));
        assertTrue(recovery.observe(228, false, false, true));
        assertFalse(recovery.observe(240, false, false, true));
    }

    @Test
    void noContactDoesNotClaimAnIdleTick() {
        assertFalse(new AgentDefense.MeleeRecovery().observe(10, false, false, false));
    }

    @Test
    void firstWitnessedStrideDoesNotImplySprintReserve() {
        assertFalse(AgentDefense.MeleeRecovery.canSprint(0.78, 0, 20, false));
        assertTrue(AgentDefense.MeleeRecovery.canSprint(2.55, 0, 20, false));
        assertFalse(AgentDefense.MeleeRecovery.canSprint(2.55, 0.45, 20, true));
        assertFalse(AgentDefense.MeleeRecovery.canSprint(3.05, 0, 6, false));
    }
}
