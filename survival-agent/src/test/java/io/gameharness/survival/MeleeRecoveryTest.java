package io.gameharness.survival;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentDefense.MeleeRecovery.DryAction.*;
import static io.gameharness.survival.AgentDefense.MeleeRecovery.Evidence.*;
import static io.gameharness.survival.AgentDefense.MeleeRecovery.Footing.*;
import static io.gameharness.survival.AgentDefense.MeleeRecovery.dryAction;
import static org.junit.jupiter.api.Assertions.*;

final class MeleeRecoveryTest {
    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
    }

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
    void aMissingSpiderFrameDoesNotProveSeparationAndHandBackTheReturnRoute() {
        var recovery = new AgentDefense.MeleeRecovery();
        // Physical ore-assisted run: a hit at 775, five metres of retreat, then
        // RETURN took back control at 807 and walked into another hit at 833.
        assertTrue(recovery.observeImpact(775, 2, false, false, DRY));
        boolean separated = AgentDefense.MeleeRecovery.separatedDryRetreat(
            true, 10 * 10, false, Double.POSITIVE_INFINITY, true, DRY);
        assertFalse(separated, "no rendered hostile is not an observed six-metre gap");
        assertTrue(recovery.observe(807, NONE, false, separated, DRY));
        assertTrue(recovery.observeImpact(833, 2, false, false, DRY));
        assertTrue(recovery.observe(865, NONE, false, separated, DRY));
        assertFalse(recovery.observe(897, NONE, false, separated, DRY),
            "unlocated damage still expires naturally; this is not permanent defense ownership");

        assertTrue(AgentDefense.MeleeRecovery.separatedDryRetreat(true, 25, true, 36, true, DRY));
        assertFalse(AgentDefense.MeleeRecovery.separatedDryRetreat(false, 25, true, 36, true, DRY));
        assertFalse(AgentDefense.MeleeRecovery.separatedDryRetreat(true, 24, true, 36, true, DRY));
        assertFalse(AgentDefense.MeleeRecovery.separatedDryRetreat(true, 25, true, 35, true, DRY));
        assertFalse(AgentDefense.MeleeRecovery.separatedDryRetreat(true, 25, true, 36, false, DRY));
        assertFalse(AgentDefense.MeleeRecovery.separatedDryRetreat(true, 25, true, 36, true, WET));
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
        assertEquals(COUNTER, dryAction(true, true, true, true, false, false));
        assertEquals(COUNTER, dryAction(false, false, true, true, false, false));
        assertEquals(COUNTER, dryAction(true, false, false, true, false, false));
        assertEquals(RETREAT, dryAction(true, false, true, true, false, false));
    }

    @Test
    void noReachableVisualContactMeansSurveyOrWaitWithoutAttacking() {
        assertEquals(WAIT, dryAction(false, false, false, false, false, false));
        assertEquals(WAIT, dryAction(true, true, true, false, false, false));
        assertEquals(SURVEY, dryAction(true, false, false, false, false, false));
        assertEquals(RETREAT, dryAction(true, false, true, false, false, false));
    }

    @Test
    void unarmedHuskDamageCadenceKeepsTheEscapeViewAndContinuesCheckedDrive() {
        var recovery = new AgentDefense.MeleeRecovery();
        // Observed desert encounter: 8.09 -> 5.09 -> 2.09 HP, with the last two hits 11 ticks apart.
        assertTrue(recovery.observe(275, CONTACT, false, false, DRY));
        assertTrue(recovery.escapeFirst(275, 8.09f, false, false));
        assertEquals(SURVEY, dryAction(true, false, false, true, recovery.escapeFirst(275, 8.09f, false, false), false),
            "a visible body in attack reach is not a reason to abandon an unverified retreat view");
        assertEquals(RETREAT, dryAction(true, false, true, true, true, false));
        assertTrue(AgentDefense.MeleeRecovery.canSprint(2.55, 0.12, 17, false));

        assertTrue(recovery.observeImpact(287, 3, false, false, UNSETTLED));
        assertEquals(SURVEY, dryAction(true, false, false, true, recovery.escapeFirst(287, 5.09f, false, false), false));
        assertTrue(recovery.observeImpact(298, 3, true, false, UNSETTLED));
        assertTrue(recovery.escapeFirst(298, 2.09f, false, false));
        assertEquals(EMERGENCY, dryAction(false, true, false, true, true, false),
            "airborne footing still allows immediate defense, not speculative movement");
        assertEquals(RETREAT, dryAction(true, false, true, false, true, false),
            "losing sight while turning away doesn't stop an already checked escape");
    }

    @Test
    void equippedDefenseAndActuallyBlockedEscapeHaveDifferentFallbacks() {
        var recovery = new AgentDefense.MeleeRecovery();
        recovery.observeImpact(287, 3, false, false, UNSETTLED);
        assertFalse(recovery.escapeFirst(287, 5.09f, true, false));
        recovery.observeImpact(298, 3, true, false, DRY);
        assertFalse(recovery.escapeFirst(298, 8.09f, true, false));
        assertFalse(recovery.escapeFirst(298, 2.09f, true, true));
        assertTrue(recovery.escapeFirst(298, 5.09f, true, false),
            "actual repeated damage can outrun a weapon without a usable shield");
        assertEquals(COUNTER, dryAction(true, false, false, true, false, true));
        assertEquals(EMERGENCY, dryAction(true, false, false, true, true, true));
        recovery.observeImpact(309, 1, true, false, UNSETTLED);
        assertEquals(EMERGENCY, dryAction(true, false, false, true, true, true),
            "a trapped visible hostile still permits charged defense after an earlier strike");
        assertEquals(WAIT, dryAction(false, true, false, false, true, true),
            "no sight-checked hostile means no strike even when trapped");
    }

    @Test
    void walkedFallbackOnlyAdmitsAFlatAdjacentTreadOutsideTheAttackersHalfPlane() {
        BlockPos feet = new BlockPos(3, 68, 5);
        BlockPos floor = feet.down();
        assertEquals(Direction.SOUTH, AgentBody.emergencyTreadBearing(feet, floor.south(), 0));
        assertEquals(Direction.EAST, AgentBody.emergencyTreadBearing(feet, floor.east(), 0));
        assertNull(AgentBody.emergencyTreadBearing(feet, floor.north(), 0));
        assertNull(AgentBody.emergencyTreadBearing(feet, floor.south().down(), 0));
        assertNull(AgentBody.emergencyTreadBearing(feet, floor.south().east(), 0));
        assertNull(AgentBody.emergencyTreadBearing(feet, floor.south(), Float.NaN));
    }

    @Test
    void r6RepeatedUnlocatedHitsKeepTheRollingExitInsteadOfRestartingAStationarySurvey() {
        var recovery = new AgentDefense.MeleeRecovery();
        var feet = new Vec3d(-17.30, 65, 12.48);
        recovery.observeImpact(2715, 3, false, false, UNSETTLED);
        recovery.orientRetreat(2715, 0, 0, 32, false);
        var walk = recovery.escapeWalk(feet);
        assertTrue(walk.ranged(), "the real melee consumer uses the continuous, sprint-capable dry-window motor");
        assertEquals(feet.add(Vec3d.fromPolar(0, 32).multiply(24)), walk.goal,
            "rechecked walked footing may nominate an exit even without starter gear");
        for (int tick : new int[] {2737, 2757, 2777, 2797, 2817, 2838}) {
            assertTrue(recovery.observeImpact(tick, 3, tick >= 2817, false, UNSETTLED));
            recovery.orientRetreat(tick, 170, 90, -70, false);
            assertSame(walk, recovery.escapeWalk(feet),
                "new recoil or a missing hostile frame must not replace the chosen retreat");
        }
        recovery.orientRetreat(2840, -150, 32, Float.NaN, true);
        assertNotSame(walk, recovery.escapeWalk(feet),
            "a newly seen hostile actually blocking that exit can change it");
    }

    @Test
    void firstUsefulImpulseCanOrientAnExitButLaterUnconfirmedImpulsesCannotThrashIt() {
        var recovery = new AgentDefense.MeleeRecovery();
        var feet = new Vec3d(3, 76, 47);
        recovery.observeImpact(5701, 3, false, false, UNSETTLED);
        recovery.orientRetreat(5701, Float.NaN, 12, Float.NaN, false);
        var initial = recovery.escapeWalk(feet);
        recovery.orientRetreat(5702, 80, 12, Float.NaN, false);
        var oriented = recovery.escapeWalk(feet);
        assertNotSame(initial, oriented);
        recovery.orientRetreat(5703, -90, 12, Float.NaN, false);
        assertSame(oriented, recovery.escapeWalk(feet));
    }

    @Test
    void lifeResetDropsOldHitPressureEscapeRouteAndConsumedSoundIdentity() {
        var recovery = new AgentDefense.MeleeRecovery();
        var feet = new Vec3d(2, 76, 47);
        var cue = new AgentEars.MeleeCue(45, 1);
        recovery.observeImpact(5805, 3, true, false, WET);
        recovery.orientRetreat(5805, 90, 90, Float.NaN, false);
        var oldLife = recovery.escapeWalk(feet);
        assertEquals(45, recovery.lookBearing(5805, cue, Float.NaN));
        recovery.reset();
        assertFalse(recovery.observe(5845, NONE, false, false, DRY));
        assertFalse(recovery.needsShore());
        recovery.observeImpact(5850, 1, false, false, DRY);
        recovery.orientRetreat(5850, -90, -90, Float.NaN, false);
        assertNotSame(oldLife, recovery.escapeWalk(feet));
        assertEquals(45, recovery.lookBearing(5850, cue, Float.NaN));
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
