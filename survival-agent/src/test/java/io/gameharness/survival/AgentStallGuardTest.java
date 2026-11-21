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
    void confirmedStairCutsKeepTheMinerThroughTheTorchEquipAndPlacement() {
        var work = new AgentReturnableMine.RouteWork();
        var retryStart = 3128;
        work.cut(new BlockPos(-22, 59, 15), 3236);
        work.cut(new BlockPos(-22, 58, 15), 3256);

        assertTrue(AgentStallGuard.retryWindowOpen(3277 - retryStart, false, work.recent(3277)),
            "a just-cleared stair can resume after equipment closes, without counting the equipment");
        assertTrue(AgentStallGuard.retryWindowOpen(3290 - retryStart, false, work.recent(3290)),
            "the second confirmed cell extends the working window beyond the first");

        work.light(3294);
        assertTrue(AgentStallGuard.retryWindowOpen(3305 - retryStart, false, work.recent(3305)));
        work.proved(3335);
        assertTrue(AgentStallGuard.retryWindowOpen(3345 - retryStart, false, work.recent(3345)),
            "fresh proof of the changed route can finish the tread");
        work.proved(3375);
        assertFalse(AgentStallGuard.retryWindowOpen(3393 - retryStart, false, work.recent(3393)),
            "verified work does not remove the retry ceiling");
    }

    @Test
    void stationaryPrepAndRepeatedReceiptsCannotRenewAnOrdinaryRetry() {
        var work = new AgentReturnableMine.RouteWork();
        var cell = new BlockPos(-22, 58, 15);
        work.proved(144);
        assertFalse(AgentStallGuard.retryWindowOpen(145, false, work.recent(145)),
            "looking, changing equipment, or proof without a route effect cannot buy another turn");

        work.cut(cell, 100);
        work.cut(cell, 144);
        work.proved(150);
        assertFalse(AgentStallGuard.retryWindowOpen(150, false, work.recent(150)),
            "the same cut and a proof loop cannot revive an expired window");

        work.light(205);
        work.light(252);
        assertTrue(AgentStallGuard.retryWindowOpen(230, true, work.recent(230)));
        assertFalse(AgentStallGuard.retryWindowOpen(254, true, work.recent(254)),
            "a repeated report of the same stair light cannot keep the handback alive");
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
