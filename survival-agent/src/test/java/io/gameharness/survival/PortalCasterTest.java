package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.Test;

final class PortalCasterTest {

    @Test
    void shoreSiteMatchesVerifyTsFormulaAcrossAllFourOrientations() {
        Direction[] inwards = { Direction.SOUTH, Direction.NORTH, Direction.EAST, Direction.WEST };
        for (Direction inward : inwards) {
            Direction along = inward.rotateYCounterclockwise();
            PortalCaster.ShoreSite site = new PortalCaster.ShoreSite(new BlockPos(10, 63, -4), along, inward);

            List<BlockPos> passive = site.passiveCells();
            List<BlockPos> poured = site.pouredCells();
            assertEquals(2, passive.size());
            assertEquals(8, poured.size());
            assertEquals(9, site.allSupportCells().size(), "Must strictly use <= 10 supports (MAX_DIAGNOSTIC_SUPPORTS)");

            // Verify exact verify.ts hasCompleteShoreCast invariant!
            BlockPos p0 = passive.get(0);
            BlockPos p1 = passive.get(1);
            assertEquals(p0.getY(), p1.getY());
            int dx = (p1.getX() - p0.getX()) / 3;
            int dz = (p1.getZ() - p0.getZ()) / 3;
            assertEquals(1, Math.abs(dx) + Math.abs(dz));
            assertEquals(p1.getX(), p0.getX() + 3 * dx);
            assertEquals(p1.getZ(), p0.getZ() + 3 * dz);

            Set<BlockPos> pouredSet = new HashSet<>(poured);
            int[][] expectedOffsets = {
                {1, -1}, {2, -1},
                {0, 1}, {3, 1},
                {0, 2}, {3, 2},
                {1, 3}, {2, 3}
            };
            for (int[] off : expectedOffsets) {
                BlockPos exp = new BlockPos(p0.getX() + off[0] * dx, p0.getY() + off[1], p0.getZ() + off[0] * dz);
                assertTrue(pouredSet.contains(exp), "Missing poured cell offset (" + off[0] + "," + off[1] + ") for inward=" + inward);
            }
            // All 10 frame cells must be distinct
            assertEquals(10, new HashSet<>(site.allFrameCells()).size());
        }
    }

    @Test
    void findsValidShoreSiteOnDiagnosticPoolGeometry() {
        // Exact diagnostic-pool.ts geometry: stone apron [-5,62,-6]..[5,63,8], lava [-3,63,2]..[3,63,7]
        Set<BlockPos> lava = new HashSet<>();
        for (int x = -3; x <= 3; x++) {
            for (int z = 2; z <= 7; z++) {
                lava.add(new BlockPos(x, 63, z));
            }
        }
        PortalCaster.CellProbe probe = new PortalCaster.CellProbe() {
            @Override
            public boolean isStillLava(BlockPos pos) {
                return lava.contains(pos);
            }

            @Override
            public boolean isSolid(BlockPos pos) {
                if (lava.contains(pos)) return false;
                return pos.getY() <= 63 && pos.getX() >= -5 && pos.getX() <= 5 && pos.getZ() >= -6 && pos.getZ() <= 8;
            }

            @Override
            public boolean isPassableAir(BlockPos pos) {
                return pos.getY() >= 64;
            }
        };

        PortalCaster.ShoreSite site = PortalCaster.findBestShoreSite(probe, lava, new BlockPos(0, 64, 0));
        assertNotNull(site, "Should discover a clean shore-casting site on the diagnostic lava pool");
        assertEquals(Direction.SOUTH, site.inward(), "Should pick the north shore facing south into the pool");
        assertEquals(Direction.EAST, site.along());
        assertEquals(63, site.foot0().getY());
        assertEquals(2, site.foot0().getZ());
        assertTrue(site.foot0().getX() >= -2 && site.foot0().getX() <= 0, "Should stay centered along the pool rim");
    }

    @Test
    void rejectsTooSmallLavaPool() {
        Set<BlockPos> tinyLava = new HashSet<>();
        for (int x = 0; x < 4; x++) {
            for (int z = 0; z < 2; z++) {
                tinyLava.add(new BlockPos(x, 63, z));
            }
        } // only 8 lava blocks (< 10 required for 2 passive + 8 pours)
        PortalCaster.CellProbe probe = new PortalCaster.CellProbe() {
            @Override public boolean isStillLava(BlockPos pos) { return tinyLava.contains(pos); }
            @Override public boolean isSolid(BlockPos pos) { return !tinyLava.contains(pos) && pos.getY() <= 63; }
            @Override public boolean isPassableAir(BlockPos pos) { return pos.getY() >= 64; }
        };
        assertNull(PortalCaster.findBestShoreSite(probe, tinyLava, new BlockPos(1, 64, -1)));
    }

    @Test
    void acceptsNaturalRaisedRimLavaPoolWithClearableBank() {
        // Natural lake_lava_surface: lava at y=62, surrounding grass/stone rim rises 1 block to y=63!
        Set<BlockPos> lava = new HashSet<>();
        for (int x = 0; x <= 4; x++) {
            for (int z = 0; z <= 3; z++) {
                lava.add(new BlockPos(x, 62, z));
            }
        }
        PortalCaster.CellProbe probe = new PortalCaster.CellProbe() {
            @Override public boolean isStillLava(BlockPos pos) { return lava.contains(pos); }
            @Override public boolean isSolid(BlockPos pos) { return !lava.contains(pos) && pos.getY() <= 63; }
            @Override public boolean isPassableAir(BlockPos pos) {
                return pos.getY() >= 64 || (pos.getY() == 63 && lava.contains(pos.down()));
            }
            @Override public boolean isClearableDryBlock(BlockPos pos) {
                return pos.getY() == 63 && !lava.contains(pos) && !lava.contains(pos.down());
            }
        };

        PortalCaster.ShoreSite site = PortalCaster.findBestShoreSite(probe, lava, new BlockPos(2, 64, -2));
        assertNotNull(site, "Natural surface lava pool with 1-block raised rim should match via CLEAR_BANK");
        assertEquals(62, site.foot0().getY());
        assertEquals(Direction.SOUTH, site.inward());
    }
}
