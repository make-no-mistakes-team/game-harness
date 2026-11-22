package io.gameharness.survival;

import net.minecraft.block.Blocks;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.EmptyBlockView;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static io.gameharness.survival.AgentNightWorksite.Action.*;
import static io.gameharness.survival.AgentNightWorksite.Cover.*;
import static io.gameharness.survival.AgentNightWorksite.Sky.*;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class NightWorksiteTest {
    private final BlockPos clearing = new BlockPos(12, 68, 22);
    private final AgentNightWorksite site = new AgentNightWorksite();

    @BeforeAll
    static void vanilla() { VanillaTestResources.initialize(); }

    @Test
    void darkExposedWoodlandPrefersWitnessedCornerThenWorksOnlyAfterLanding() {
        site.observe(DARK, clearing, 20);
        assertEquals(SEEK, site.action(clearing, 21, true, true, CORNER, false));
        assertEquals(WORK, site.action(clearing, 22, true, true, CORNER, true));
        assertEquals(OPEN, site.action(clearing, 23, true, true, BANK, false));
        assertEquals(WORK, site.action(clearing, 24, true, true, POCKET, true));
    }

    @Test
    void partialScreenAndFirstBreakAreNotAShelteredLanding() {
        site.observe(DARK, clearing, 20);
        assertEquals(SCREEN, AgentNightWorksite.corner(true, true, true, false));
        assertEquals(SCREEN, AgentNightWorksite.pocket(true, false, true, true, true));
        assertEquals(SEARCH, site.action(clearing, 21, true, true, SCREEN, true));
        assertEquals(SEEK, site.action(clearing, 22, true, true, POCKET, false));
    }

    @Test
    void aDarkPassageUnknownRoofOrUnsupportedFloorDoesNotQualify() {
        site.observe(UNKNOWN, clearing, 20);
        assertEquals(ORDINARY, site.action(clearing, 21, true, true, CORNER, false));
        assertEquals(NONE, AgentNightWorksite.corner(true, false, true, true));
        assertEquals(NONE, AgentNightWorksite.pocket(false, true, true, true, true));
        assertEquals(NONE, AgentNightWorksite.pocket(true, true, false, true, true));
    }

    @Test
    void onlyStableOpaqueTerrainCountsAsOverheadOrSideCover() {
        BlockPos sample = clearing.up(2);
        var view = EmptyBlockView.INSTANCE;
        assertTrue(AgentNightWorksite.stableCover(view, sample, Blocks.DIRT.getDefaultState()));
        assertTrue(AgentNightWorksite.stableCover(view, sample, Blocks.STONE.getDefaultState()));
        assertFalse(AgentNightWorksite.stableCover(view, sample, Blocks.GRAVEL.getDefaultState()));
        assertFalse(AgentNightWorksite.stableCover(view, sample, Blocks.TORCH.getDefaultState()));
        assertFalse(AgentNightWorksite.stableCover(view, sample, Blocks.OAK_LEAVES.getDefaultState()));
        assertFalse(AgentNightWorksite.stableCover(view, sample, Blocks.AIR.getDefaultState()));
    }

    @Test
    void emptyHandsKeepWoodBootstrapAndDangerAlwaysTakesOwnership() {
        site.observe(DARK, clearing, 20);
        assertEquals(ORDINARY, site.action(clearing, 21, true, false, BANK, false));
        assertEquals(ORDINARY, site.action(clearing, 22, false, true, BANK, false));
        assertEquals(OPEN, site.action(clearing, 23, true, true, BANK, false));
        assertEquals(ORDINARY, site.action(clearing, 24, false, true, POCKET, true));
    }

    @Test
    void dawnReleasesNightGuardAndLocalDarkEvidenceDoesNotFollowIntoAnotherArea() {
        site.observe(DARK, clearing, 20);
        assertEquals(ORDINARY, site.action(clearing.up(4), 21, true, true, BANK, false));
        assertEquals(ORDINARY, site.action(clearing, 21 + AgentNightWorksite.EXPOSURE_TICKS,
            true, true, BANK, false));
        site.observe(DARK, clearing, 400);
        site.observe(BRIGHT, clearing, 403);
        assertEquals(ORDINARY, site.action(clearing, 403, true, true, BANK, false));
    }
}
