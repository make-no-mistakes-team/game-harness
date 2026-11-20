package io.gameharness.survival;

import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

final class AgentThreatViewTest {
    private static final Vec3d VIEWER = new Vec3d(0, 1.62, 0);
    private static final Vec3d ENDERMAN_EYES = new Vec3d(0, 2.55, 3);
    private static final Vec3d ENDERMAN_BODY = new Vec3d(0, 1.4, 3);

    @Test
    void calmEndermanCannotClaimTheCombatCameraOrAttackAndOnlyEyeLevelLookDips() {
        var view = new AgentThreatView<String>();
        view.begin(64);
        view.observeEnderman("enderman", ENDERMAN_BODY, ENDERMAN_EYES, 9, false);

        assertNull(view.target(), "no combat owner to turn or approach the player");
        assertNull(view.aim(), "no face lock or other combat aim");
        assertFalse(view.canContactEnderman("enderman"));
        assertTrue(view.lookPitch(VIEWER, 0, 0, -17) > -8, "dip below the eyes");
        assertEquals(18, view.lookPitch(VIEWER, 0, 0, 18), "leave a safe walking gaze alone");
        assertEquals(-17, view.lookPitch(VIEWER, 65, 65, -17), "never seek an unrelated bearing");
    }

    @Test
    void visiblyAngryEndermanCanOwnDefenseButOnlyBelowTheFace() {
        var view = new AgentThreatView<String>();
        view.begin(64);
        view.observeEnderman("enderman", ENDERMAN_BODY, ENDERMAN_EYES, 9, true);

        assertEquals("enderman", view.target());
        assertEquals(ENDERMAN_BODY, view.aim());
        assertTrue(view.canContactEnderman("enderman"));
        assertFalse(view.canStrikeEnderman("enderman", 2.49, 2.55, 2.9));
        assertTrue(view.canStrikeEnderman("enderman", 1.4, 2.55, 2.9));

        view.begin(64);
        view.observeEnderman("enderman", null, ENDERMAN_EYES, 9, true);
        assertEquals("enderman", view.target(), "an exposed angry head still warrants retreat");
        assertNull(view.aim(), "no swing or face lock through an occluded body");
        assertFalse(view.canContactEnderman("enderman"));
    }

    @Test
    void closerCalmEndermanDoesNotMaskCreeperAndMissingViewGrantsNoContact() {
        var view = new AgentThreatView<String>();
        var creeperAim = new Vec3d(2, 0.85, 4);
        view.begin(64);
        view.observeHostile("creeper", creeperAim, 20);
        view.observeEnderman("enderman", ENDERMAN_BODY, ENDERMAN_EYES, 9, false);

        assertEquals("creeper", view.target());
        assertEquals(creeperAim, view.aim());
        view.begin(64);
        assertNull(view.target());
        assertFalse(view.canContactEnderman("enderman"));
        assertEquals(-17, view.lookPitch(VIEWER, 0, 0, -17), "no correction from an unwitnessed mob");
    }
}
