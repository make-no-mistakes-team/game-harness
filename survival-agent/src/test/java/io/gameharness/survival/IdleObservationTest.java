package io.gameharness.survival;

import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

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
}
