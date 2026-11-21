package io.gameharness.survival;

import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.Blocks;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentMacroControl.FixedSurveyStep.FRAMED;
import static io.gameharness.survival.AgentMacroControl.FixedSurveyStep.INTERRUPT;
import static io.gameharness.survival.AgentMacroControl.FixedSurveyStep.TURN;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class IdleObservationTest {
    @BeforeAll
    static void initializeVanilla() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    @Test
    void oneMissingCanopyRenderWaitsWithoutExtendingWitnessFreshness() {
        // At tick 586 the last render was age 2, with the same safe stance.
        assertTrue(AgentMacroControl.deferIdleObservation(5, 2, true));
        assertFalse(AgentMacroControl.deferIdleObservation(6, 1, true),
            "publish from the recovered render as soon as it is fresh");
        assertFalse(AgentMacroControl.deferIdleObservation(6, 3, true),
            "continued staleness is a genuine loss");
        assertFalse(AgentMacroControl.deferIdleObservation(7, 2, true),
            "another near miss cannot continually delay the publication");
        assertFalse(AgentMacroControl.deferIdleObservation(5, -1, true),
            "an unknown actor's render is not a one-tick gap");
    }

    @Test
    void lostIdleAuthorityNeverWaitsForRender() {
        assertFalse(AgentMacroControl.deferIdleObservation(5, 2, false));
    }

    @Test
    void inheritedZenithNeedsARealLitNearCeilingAndDoesNotDisplaceVisibleResources() {
        var eye = new Vec3d(0.5, 1.62, 0.5);
        var ceiling = new BlockHitResult(new Vec3d(0.5, 2, 0.51), Direction.DOWN, new BlockPos(0, 2, 0), false);
        var stone = Blocks.STONE.getDefaultState();
        assertTrue(AgentMacroControl.startupCover(-88.99992f, ceiling, eye, stone, 7));
        assertFalse(AgentMacroControl.startupCover(-40, ceiling, eye, stone, 7));
        assertFalse(AgentMacroControl.startupCover(-88.99992f, ceiling, eye, stone, 0));
        assertFalse(AgentMacroControl.startupCover(-88.99992f, ceiling, eye, Blocks.OAK_LOG.getDefaultState(), 7));
        assertFalse(AgentMacroControl.startupCover(-88.99992f, ceiling, eye, Blocks.DIAMOND_ORE.getDefaultState(), 7));
        assertFalse(AgentMacroControl.startupCover(-88.99992f, ceiling, eye, Blocks.CRAFTING_TABLE.getDefaultState(), 7));
        assertFalse(AgentMacroControl.startupCover(-88.99992f, ceiling, eye.add(0, -3, 0), stone, 7));
        var side = new BlockHitResult(ceiling.getPos(), Direction.NORTH, ceiling.getBlockPos(), false);
        assertFalse(AgentMacroControl.startupCover(-88.99992f, side, eye, stone, 7));
    }

    @Test
    void inheritedZenithFramesOneShallowOutlookDespiteMissedRenders() {
        assertEquals(18, AgentMacroControl.STARTUP_OUTLOOK_PITCH, 0);
        framesThroughMissedRenders(-47, -88.99992f, -47, AgentMacroControl.STARTUP_OUTLOOK_PITCH,
            AgentMacroControl.STARTUP_OUTLOOK_TICKS);
    }

    @Test
    void paidLeftSurveyHoldsItsFixedDestinationDespiteMissedRenders() {
        framesThroughMissedRenders(0, 0, -55, 31, 30);
    }

    @Test
    void fixedSurveyCannotAcknowledgeTheAdmissionFrameOrOverrideLostControls() {
        assertEquals(TURN, AgentMacroControl.fixedSurveyStep(true, 1, 1, true));
        assertEquals(TURN, AgentMacroControl.fixedSurveyStep(true, 2, 1, false));
        assertEquals(INTERRUPT, AgentMacroControl.fixedSurveyStep(false, 2, 1, true));
        assertEquals(FRAMED, AgentMacroControl.fixedSurveyStep(true, 2, 1, true));
    }

    private static void framesThroughMissedRenders(float yaw, float pitch, float toYaw, float toPitch, int deadline) {
        var receipts = new java.util.ArrayList<AgentBody.LookEvidence>();
        var motor = new AgentLookMotor(230, 7_884_114_993_335_936_077L, receipts::add);
        long frame = 1;
        int lastRender = 0;
        boolean missed = false;
        boolean framed = false;
        for (int tick = 1; tick <= deadline; ++tick) {
            boolean recent = tick - lastRender <= 1;
            boolean aligned = Math.abs(MathHelper.wrapDegrees(toYaw - yaw)) <= 4 && Math.abs(toPitch - pitch) <= 4;
            var step = AgentMacroControl.fixedSurveyStep(true, frame, 1, recent && aligned);
            if (!recent) {
                missed = true;
                assertEquals(TURN, step, "a missed render neither releases the fixed command nor completes it");
            }
            if (step == FRAMED) {
                motor.stop(1_000_000_000L + 50_000_000L * tick);
                framed = true;
                break;
            }
            if (tick % 2 != 0) continue;
            long now = 1_000_000_000L + 50_000_000L * tick;
            double dt = 0.05; // AgentBody caps mouse integration even across a 100ms render interval.
            motor.step(AgentLookMotor.Context.SCAN, null, yaw, pitch, toYaw, toPitch, dt, now, tick);
            assertTrue(Math.hypot(motor.yawStep(), motor.pitchStep()) <= 11.5 + 1e-8);
            if (toYaw == -47) assertEquals(0, motor.yawStep(), 1e-9, "the startup outlook holds the inherited azimuth");
            float oldYaw = yaw, oldPitch = pitch;
            yaw += (float) motor.yawStep();
            pitch += (float) motor.pitchStep();
            motor.applied(MathHelper.wrapDegrees(yaw - oldYaw), pitch - oldPitch, dt, 0.10, now);
            ++frame;
            lastRender = tick;
        }
        assertTrue(missed, "the fixture must exercise an actual missed previous render");
        assertTrue(framed, "the app must observe the aligned view before the native survey deadline");
        assertEquals(1, receipts.size(), "the look motor records one continuous gesture, not a series of restarts");
    }
}
