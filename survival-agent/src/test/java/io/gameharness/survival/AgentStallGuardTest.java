package io.gameharness.survival;

import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class AgentStallGuardTest {
    @Test
    void firstSweepCanFinishWithoutInterruptingTheWitnessedWorkItJustFound() {
        assertFalse(AgentStallGuard.stalledByTurning(64, 0, 350, 341, 0));
        assertFalse(AgentStallGuard.stalledByTurning(110, 0, 275, 275, 0));
        assertTrue(AgentStallGuard.stalledByTurning(110, 0, 310, 35, 3));
        assertFalse(AgentStallGuard.stalledByTurning(110, 3, 310, 35, 3));
    }

    @Test
    void refusedRiseDoesNotVetoAnotherGroundedLaneOrItsReverse() {
        var exits = new AgentStallGuard.Departures();
        var foot = new BlockPos(0, 64, 0);
        var rise = foot.east().up();
        exits.reject(foot, rise);

        assertFalse(exits.canCross(foot, rise));
        assertTrue(exits.canCross(foot, foot.east()));
        assertTrue(exits.canCross(foot, foot.west()));
        assertTrue(exits.canCross(rise, foot));
        assertTrue(exits.canCross(foot.north(), rise.north()));
        assertTrue(exits.beginSurvey(foot));
        assertFalse(exits.beginSurvey(foot), "a later rendering is not different footing");
        assertTrue(exits.beginSurvey(foot.west()));
        assertFalse(exits.canCross(foot, rise), "assessing another support must not erase a proved refusal");
    }

    @Test
    void briefDepartureCannotBounceBackToTheSameFootingButMayContinuePastOldGround() {
        var exits = new AgentStallGuard.Departures();
        var foot = new BlockPos(0, 64, 0);
        exits.stoodOn(foot);
        exits.stoodOn(foot.east());
        exits.stoodOn(foot.east(2));

        assertFalse(exits.newLanding(foot));
        assertFalse(exits.newLanding(foot.east()));
        assertFalse(exits.newLanding(foot.east(2)));
        assertTrue(exits.newLanding(foot.east(3)));
        assertTrue(exits.canCross(foot.east(2), foot.east()),
            "an old support is not a hazard when it leads to a genuinely different landing");
    }

    @Test
    void onlyAChangeInTheRefusedLanesOwnClearanceCanReopenIt() {
        var exits = new AgentStallGuard.Departures();
        var foot = new BlockPos(0, 64, 0);
        var pillar = foot.up();
        var east = foot.east();
        exits.reject(foot, pillar);
        exits.reject(foot, east);

        exits.changed(foot.north().up(2));
        assertFalse(exits.canCross(foot, pillar));
        assertFalse(exits.canCross(foot, east));
        exits.changed(east.up());
        assertFalse(exits.canCross(foot, pillar));
        assertTrue(exits.canCross(foot, east));
        exits.changed(foot.up(2));
        assertTrue(exits.canCross(foot, pillar));
    }
}
