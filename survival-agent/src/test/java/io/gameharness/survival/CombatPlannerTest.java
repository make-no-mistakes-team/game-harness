package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import java.util.List;
import org.junit.jupiter.api.Test;

final class CombatPlannerTest {

    private static CombatPlanner.ThreatInfo threat(
        int id, CombatPlanner.ThreatKind kind, double x, double z, double dist,
        float fuse, boolean swelling, boolean drawing, boolean occluded, int age
    ) {
        return new CombatPlanner.ThreatInfo(id, kind, x, 64, z, 0, 0, 0, dist, fuse, swelling, drawing, occluded, age);
    }

    @Test
    void threatScoringPrioritizesSwellingCreeperOverBabyZombieOverSkeletonAndZombie() {
        var creeper = threat(1, CombatPlanner.ThreatKind.CREEPER, 0, 3.2, 3.2, 0.45f, true, false, false, 0);
        var baby = threat(2, CombatPlanner.ThreatKind.BABY_ZOMBIE, 2, 2, 2.8, 0f, false, false, false, 0);
        var skel = threat(3, CombatPlanner.ThreatKind.SKELETON, 6, 0, 6.0, 0f, false, true, false, 0);
        var zombie = threat(4, CombatPlanner.ThreatKind.ZOMBIE, -4, 0, 4.0, 0f, false, false, false, 0);
        var occludedZombie = threat(5, CombatPlanner.ThreatKind.ZOMBIE, -4, 0, 4.0, 0f, false, false, true, 30);

        assertTrue(CombatPlanner.scoreThreat(creeper) > CombatPlanner.scoreThreat(baby));
        assertTrue(CombatPlanner.scoreThreat(baby) > CombatPlanner.scoreThreat(skel));
        assertTrue(CombatPlanner.scoreThreat(zombie) > CombatPlanner.scoreThreat(occludedZombie));
        assertEquals(creeper, CombatPlanner.pickPrimaryThreat(List.of(zombie, skel, baby, creeper)));
    }

    @Test
    void creeperCornersWithShieldTriggersBlockOtherwiseKiteOrFlee() {
        var swellingCreeper = threat(1, CombatPlanner.ThreatKind.CREEPER, 0, 3.2, 3.2, 0.55f, true, false, false, 0);
        var corneredCtx = new CombatPlanner.CombatContext(
            18f, 20f, 20, true, 9.0, true, true, 0, 16, true, true, -10.0,
            CombatPlanner.CombatStance.AUTO, List.of(swellingCreeper), false
        );
        assertEquals(CombatPlanner.TacticalAction.CREEPER_BLOCK, CombatPlanner.decideAction(corneredCtx));

        var calmCreeper = threat(1, CombatPlanner.ThreatKind.CREEPER, 0, 3.5, 3.5, 0.0f, false, false, false, 0);
        var openCtx = new CombatPlanner.CombatContext(
            18f, 20f, 20, true, 9.0, true, true, 0, 16, true, false, 15.0,
            CombatPlanner.CombatStance.AUTO, List.of(calmCreeper), false
        );
        assertEquals(CombatPlanner.TacticalAction.CREEPER_KITE, CombatPlanner.decideAction(openCtx));

        var unshieldedSwelling = new CombatPlanner.CombatContext(
            18f, 20f, 20, true, 9.0, false, false, 0, 16, true, false, 15.0,
            CombatPlanner.CombatStance.AUTO, List.of(swellingCreeper), false
        );
        assertEquals(CombatPlanner.TacticalAction.FLEE, CombatPlanner.decideAction(unshieldedSwelling));
    }

    @Test
    void skeletonWithShieldUsesShieldAdvanceAndIncomingArrowTriggersHold() {
        var skel = threat(1, CombatPlanner.ThreatKind.SKELETON, 0, 9.0, 9.0, 0f, false, true, false, 0);
        var advCtx = new CombatPlanner.CombatContext(
            20f, 20f, 20, true, 9.0, true, true, 0, 12, true, false, 12.0,
            CombatPlanner.CombatStance.AUTO, List.of(skel), false
        );
        assertEquals(CombatPlanner.TacticalAction.SHIELD_ADVANCE, CombatPlanner.decideAction(advCtx));

        var arrowCtx = new CombatPlanner.CombatContext(
            20f, 20f, 20, true, 9.0, true, true, 0, 12, true, false, 12.0,
            CombatPlanner.CombatStance.AUTO, List.of(skel), true
        );
        assertEquals(CombatPlanner.TacticalAction.SHIELD_HOLD, CombatPlanner.decideAction(arrowCtx));
    }

    @Test
    void lowHpTrappedUnderEquippedTriggersEmergencyShelterAndStrategistStanceOverrides() {
        var z1 = threat(1, CombatPlanner.ThreatKind.ZOMBIE, 0, 4.0, 4.0, 0f, false, false, false, 0);
        var z2 = threat(2, CombatPlanner.ThreatKind.SKELETON, 1, 6.0, 6.1, 0f, false, true, false, 0);
        var trappedLowHp = new CombatPlanner.CombatContext(
            8f, 20f, 14, true, 3.5, false, false, 0, 20, true, true, -5.0,
            CombatPlanner.CombatStance.AUTO, List.of(z1, z2), false
        );
        assertEquals(CombatPlanner.TacticalAction.EMERGENCY_SHELTER, CombatPlanner.decideAction(trappedLowHp));

        // Strategist explicitly issuing SHELTER overrides even healthy armed state!
        var strategistShelter = new CombatPlanner.CombatContext(
            18f, 20f, 18, true, 9.0, true, true, 0, 12, true, false, 15.0,
            CombatPlanner.CombatStance.SHELTER, List.of(z1), false
        );
        assertEquals(CombatPlanner.TacticalAction.EMERGENCY_SHELTER, CombatPlanner.decideAction(strategistShelter));
    }

    @Test
    void occludedOnlyThreatsTriggerCautiousPeekInsteadOfDroppingGuard() {
        var occ = threat(1, CombatPlanner.ThreatKind.ZOMBIE, 4, 2, 4.5, 0f, false, false, true, 20);
        var ctx = new CombatPlanner.CombatContext(
            20f, 20f, 20, true, 9.0, true, true, 0, 12, true, false, 12.0,
            CombatPlanner.CombatStance.AUTO, List.of(occ), false
        );
        assertEquals(CombatPlanner.TacticalAction.CAUTIOUS_PEEK, CombatPlanner.decideAction(ctx));
    }

    @Test
    void escapeEvaluationAvoidsCliffDropOffBehindPlayer() {
        // Threat is south (z=+5); directly north (z <= -1) is a steep cliff drop-off!
        // East and West are safe flat ground.
        CombatPlanner.CellProbe cliffNorth = (x, y, z) -> {
            if (z <= -1) return CombatPlanner.CellKind.PASSABLE; // cliff chasm!
            if (y <= 63) return CombatPlanner.CellKind.SOLID;
            return CombatPlanner.CellKind.PASSABLE;
        };
        var creeper = threat(1, CombatPlanner.ThreatKind.CREEPER, 0.5, 5.5, 5.0, 0.3f, true, false, false, 0);
        var esc = CombatPlanner.evaluateEscapeBearings(0.5, 64, 0.5, List.of(creeper), cliffNorth);

        // Must NOT retreat straight north into the cliff (dirZ should not strongly point negative)!
        assertTrue(esc.dirZ() > -0.45, "Retreat bearing should avoid northern cliff, got dir=(" + esc.dirX() + ", " + esc.dirZ() + ")");
        assertFalse(esc.trapped());
    }

    @Test
    void escapeEvaluationDetectsTrappedDeadEndRavine() {
        // Canyon walls at x <= -2, x >= 2, z <= -2 (solid up to y=68); hostiles blocking south at z=+3!
        CombatPlanner.CellProbe ravine = (x, y, z) -> {
            if (y <= 63) return CombatPlanner.CellKind.SOLID;
            if (x <= -2 || x >= 2 || z <= -2) return CombatPlanner.CellKind.SOLID;
            return CombatPlanner.CellKind.PASSABLE;
        };
        var z1 = threat(1, CombatPlanner.ThreatKind.ZOMBIE, 0.5, 3.0, 2.5, 0f, false, false, false, 0);
        var z2 = threat(2, CombatPlanner.ThreatKind.ZOMBIE, -0.5, 3.5, 3.2, 0f, false, false, false, 0);
        var esc = CombatPlanner.evaluateEscapeBearings(0.5, 64, 0.5, List.of(z1, z2), ravine);

        assertTrue(esc.trapped(), "Dead-end ravine with hostiles at mouth should be classified as trapped");
    }

    @Test
    void shelterModePrefersBoxInCornerOrAmpleBlocksAndBurrowWhenScarce() {
        CombatPlanner.CellProbe openFlat = (x, y, z) -> y <= 63 ? CombatPlanner.CellKind.SOLID : CombatPlanner.CellKind.PASSABLE;
        assertEquals(
            CombatPlanner.ShelterMode.BOX_OR_CORNER,
            CombatPlanner.chooseShelterMode(0, 64, 0, 16, true, true, openFlat)
        );
        assertEquals(
            CombatPlanner.ShelterMode.BURROW_DOWN,
            CombatPlanner.chooseShelterMode(0, 64, 0, 3, true, true, openFlat)
        );

        // Ravine corner (3 walls already solid up to y+2): only needs 3 blocks -> BOX_OR_CORNER!
        CombatPlanner.CellProbe corner = (x, y, z) -> {
            if (y <= 63) return CombatPlanner.CellKind.SOLID;
            if (x == -1 || x == 1 || z == -1) return CombatPlanner.CellKind.SOLID;
            return CombatPlanner.CellKind.PASSABLE;
        };
        assertEquals(
            CombatPlanner.ShelterMode.BOX_OR_CORNER,
            CombatPlanner.chooseShelterMode(0, 64, 0, 4, true, true, corner)
        );
    }

    @Test
    void escapeEvaluationFindsNarrowOneWideStaircaseUpward() {
        // 1-wide staircase ascending North (z = -1, -2, -3, -4 at x = 0, step up +1 Y per Z step);
        // solid rock walls on x != 0 and ahead south (z >= 1) blocked by an off-axis creeper!
        CombatPlanner.CellProbe stairNorth = (x, y, z) -> {
            if (x == 0 && z <= 0 && z >= -5) {
                int floorY = 54 + (-z) - 1;
                if (y <= floorY) return CombatPlanner.CellKind.SOLID;
                if (y <= floorY + 2) return CombatPlanner.CellKind.PASSABLE;
                return CombatPlanner.CellKind.SOLID;
            }
            return CombatPlanner.CellKind.SOLID;
        };
        // Creeper slightly off-axis south-east so relative rays miss exact North (-pi/2)
        var creeper = threat(1, CombatPlanner.ThreatKind.CREEPER, 0.9, 2.2, 2.3, 0.0f, false, false, false, 0);
        var esc = CombatPlanner.evaluateEscapeBearings(0.5, 54, 0.5, List.of(creeper), stairNorth);

        assertFalse(esc.trapped(), "1-wide cardinal staircase upward should be detected as an open escape route");
        assertTrue(esc.dirZ() < -0.8, "Escape direction should go straight North up the staircase, got dir=(" + esc.dirX() + ", " + esc.dirZ() + ")");
    }

    @Test
    void trappedUnshieldedCreeperTriggersEmergencyShelterWhenBlocksAvailable() {
        var calmCreeper = threat(1, CombatPlanner.ThreatKind.CREEPER, 0.5, 2.5, 2.1, 0.0f, false, false, false, 0);
        var trappedNoShield = new CombatPlanner.CombatContext(
            20f, 20f, 20, false, 4.0, false, false, 0, 27, true, true, -20.0,
            CombatPlanner.CombatStance.DEFENSIVE, List.of(calmCreeper), false
        );
        assertEquals(CombatPlanner.TacticalAction.EMERGENCY_SHELTER, CombatPlanner.decideAction(trappedNoShield));
    }
}
