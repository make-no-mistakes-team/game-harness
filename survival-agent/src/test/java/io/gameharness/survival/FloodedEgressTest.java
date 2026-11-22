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

    @Test void aFloodedArrivalAdvancesToOlderWalkedStairsInsteadOfStartingAnAirScan() {
        BlockPos earlier = new BlockPos(-15, 54, -34);
        BlockPos next = earlier.south().up(), previouslyDry = next.south().up(), newest = previouslyDry.west().up();
        var walked = new ArrayList<>(List.of(earlier, next, previouslyDry, newest));
        var retreat = new AgentWaterEscape.ReturnCorridor(walked);
        walked.clear(); // The ordinary supply job can release its work after the transfer.
        assertEquals(newest, retreat.from());
        assertEquals(previouslyDry, retreat.to());
        Vec3d atFloodedTread = Vec3d.ofBottomCenter(previouslyDry).add(0.20, 0.113, 0.02);
        assertEquals(AgentWaterEscape.ReturnArrival.APPROACH, retreat.arrive(atFloodedTread.add(0, 1, 0), true, false),
            "floating above the old tread is not a completed descent");
        assertEquals(AgentWaterEscape.ReturnArrival.NEXT, retreat.arrive(atFloodedTread, true, false));
        assertEquals(previouslyDry, retreat.from());
        assertEquals(next, retreat.to(), "the next stair is around the corner, not straight past the first arrival");
        Vec3d lower = Vec3d.ofBottomCenter(next);
        Vec3d mouth = lower.add(0, 1.74, 0);
        assertFalse(AgentWaterEscape.returnOpening(mouth, 0.24, 0, p -> p.x > mouth.x ? UNSEEN : FLOW, true),
            "the just-walked leg supplies no optical proof for the next turn");
        assertTrue(AgentWaterEscape.returnOpening(mouth, 0.24, 0, p -> FLOW, true));
        Vec3d stroke = retreat.strokeEnd(atFloodedTread, lower, 0.03);
        assertEquals(0.48, Math.hypot(stroke.x - atFloodedTread.x, stroke.z - atFloodedTread.z), 1e-6);
        assertTrue(stroke.x < atFloodedTread.x && stroke.z < atFloodedTread.z && stroke.z > lower.z,
            "move around the corner without sweeping the current high pose into the bottom of the lower step");
        assertEquals(AgentWaterEscape.ReturnArrival.NEXT, retreat.arrive(Vec3d.ofBottomCenter(next), true, false));
        assertEquals(earlier, retreat.to());
        assertEquals(AgentWaterEscape.ReturnArrival.EXHAUSTED, retreat.arrive(Vec3d.ofBottomCenter(earlier), true, false),
            "only the last flooded tread can exhaust a successfully traversed corridor");
    }

    @Test void aDrySettledArrivalStillReturnsControlEvenWhenOlderStairsExist() {
        var retreat = new AgentWaterEscape.ReturnCorridor(List.of(SECOND_EXIT, FIRST_EXIT, CREST));
        Vec3d feet = Vec3d.ofBottomCenter(FIRST_EXIT);
        assertEquals(AgentWaterEscape.ReturnArrival.SETTLING, retreat.arrive(feet, false, false));
        assertEquals(AgentWaterEscape.ReturnArrival.LANDED, retreat.arrive(feet, false, true));
        assertEquals(FIRST_EXIT, retreat.to());
    }

    @Test void anAirStrokeNeedsWitnessedBreathingRoomNotJustOneAirSample() {
        Vec3d breath = Vec3d.ofCenter(FIRST_EXIT.up());
        assertTrue(AgentWaterEscape.breathingRoom(breath, point -> AIR));
        assertFalse(AgentWaterEscape.breathingRoom(breath, point -> point.y < breath.y ? FLOW : AIR));
        assertFalse(AgentWaterEscape.breathingRoom(breath, point -> point.y < breath.y ? UNSEEN : AIR));
        assertFalse(AgentWaterEscape.breathingRoom(breath, point -> point.y < breath.y ? AIR : SOLID));
    }

    @Test void aCutoffCannotFillAnyRememberedTreadOrItsHeadroom() {
        var retreat = new AgentWaterEscape.ReturnCorridor(List.of(SECOND_EXIT, FIRST_EXIT, CREST));
        assertEquals(AgentWaterEscape.ReturnArrival.NEXT, retreat.arrive(Vec3d.ofBottomCenter(FIRST_EXIT), true, false));
        assertTrue(retreat.protects(CREST.up()), "a cutoff must preserve the connected return even after passing a stair");
        assertTrue(retreat.protects(CREST.up(2)), "do not cap potential breathing space above a walked stair");
        assertTrue(retreat.protects(SECOND_EXIT.down()));
        assertFalse(retreat.protects(CREST.north().up()));
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

    @Test void airPriorityPreservesActiveMobilityAndAlreadyIssuedRelief() {
        assertFalse(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.RETURN));
        assertFalse(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.DRIVE));
        assertFalse(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.SURFACE));
        assertFalse(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.DRAIN));
        assertTrue(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.DRIFT));
        assertTrue(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.PLUG));
        assertTrue(AgentWaterEscape.interruptForAir(AgentWaterEscape.Phase.BLOCKED));
    }
}
