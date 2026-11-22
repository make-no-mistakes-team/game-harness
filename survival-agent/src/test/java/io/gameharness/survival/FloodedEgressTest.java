package io.gameharness.survival;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentBody.WetEscapeMedium.*;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class FloodedEgressTest {
    private static final BlockPos CREST = new BlockPos(2, 12, 4);
    private static final BlockPos FIRST_EXIT = CREST.west().down();
    private static final BlockPos SECOND_EXIT = FIRST_EXIT.south().down();

    @Test void aFreshFloodUsesTheLastWalkedDownhillLegThenFollowsItsTurn() {
        var walked = new ArrayList<>(List.of(SECOND_EXIT, FIRST_EXIT, CREST));
        var retreat = new AgentWaterEscape.ReturnCorridor(walked);
        walked.clear(); // The ordinary supply job can release its work after the transfer.
        assertEquals(CREST, retreat.from());
        assertEquals(FIRST_EXIT, retreat.to());
        assertFalse(retreat.arrived(Vec3d.ofBottomCenter(FIRST_EXIT).add(0, 1.05, 0)),
            "floating over the old tread is not descending to it");
        assertTrue(retreat.arrived(Vec3d.ofBottomCenter(FIRST_EXIT).add(0.1, 0.1, 0)));
        assertTrue(retreat.next());
        assertEquals(FIRST_EXIT, retreat.from());
        assertEquals(SECOND_EXIT, retreat.to(), "a wet old tread is not proof of air or a dry landing");
        assertFalse(retreat.next());
    }

    @Test void aSwimmerGoesDownOnlyAfterDriftRaisesItAboveTheExitOrItClearsTheLip() {
        var retreat = new AgentWaterEscape.ReturnCorridor(List.of(FIRST_EXIT, CREST));
        Vec3d crest = Vec3d.ofBottomCenter(CREST), lower = Vec3d.ofBottomCenter(FIRST_EXIT);
        assertFalse(retreat.needsDescent(crest, lower),
            "on first contact, move directly toward the lower opening");
        assertTrue(retreat.needsDescent(crest.add(0, 1.0, 0), lower),
            "don't try to cross the lower exit while floating above its headroom");
        assertTrue(retreat.needsDescent(lower.add(0, 0.6, 0), lower),
            "over the lower tread, descend rather than overshooting its turn");
    }

    @Test void aFormerlyDryTreadDoesNotAuthorizeAnOccludedOrLavaLane() {
        Vec3d center = Vec3d.ofCenter(FIRST_EXIT.up());
        assertTrue(AgentWaterEscape.returnOpening(center, 0, 0.24, point -> FLOW, true));
        assertFalse(AgentWaterEscape.returnOpening(center, 0, 0.24, point -> FLOW, false),
            "do not deliberately enter a flooded tread from dry ground");
        assertFalse(AgentWaterEscape.returnOpening(center, 0, 0.24,
            point -> point.z > center.z ? SOLID : AIR, true), "lava or wall in one shoulder");
        assertFalse(AgentWaterEscape.returnOpening(center, 0, 0.24,
            point -> point.z < center.z ? UNSEEN : AIR, true), "a remembered tread does not reveal hidden clearance");
    }

    @Test void airPriorityContinuesAnActiveRetreatOrBankDriveRatherThanJumping() {
        assertFalse(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.RETURN));
        assertFalse(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.DRIVE));
        assertTrue(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.DRIFT));
        assertTrue(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.PLUG));
        assertTrue(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.BLOCKED));
    }
}
