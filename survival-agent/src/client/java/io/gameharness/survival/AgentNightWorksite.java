package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.block.FallingBlock;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.BlockView;

/** A local choice made from sky, terrain, and the player's actual footing; no world clock. */
final class AgentNightWorksite {
    static final int EXPOSURE_TICKS = 320;

    enum Sky { UNKNOWN, DARK, BRIGHT }
    enum Cover { NONE, SCREEN, CORNER, BANK, POCKET }
    enum Action { ORDINARY, SEARCH, SEEK, OPEN, WORK }

    /** The optional night-site search cannot become an unlimited owner of mineral work. */
    static Action mineralDiversion(boolean spent) { return spent ? Action.ORDINARY : Action.SEARCH; }

    private BlockPos exposed;
    private int seenAt;

    void observe(Sky sky, BlockPos foot, int now) {
        if (sky == Sky.DARK) {
            exposed = foot;
            seenAt = now;
        } else if (sky == Sky.BRIGHT) clear();
    }

    void clear() { exposed = null; }

    boolean darkAt(BlockPos foot, int now) {
        return exposed != null && now - seenAt <= EXPOSURE_TICKS
            && Math.abs(foot.getY() - exposed.getY()) <= 1 && exposed.getSquaredDistance(foot) <= 36;
    }

    Action action(BlockPos foot, int now, boolean safeVulnerable, boolean hasPick, Cover cover, boolean landed) {
        if (!safeVulnerable || !hasPick || !darkAt(foot, now)) return Action.ORDINARY;
        return switch (cover) {
            case NONE, SCREEN -> Action.SEARCH;
            case BANK -> Action.OPEN;
            case CORNER, POCKET -> landed ? Action.WORK : Action.SEEK;
        };
    }

    static Cover corner(boolean supported, boolean stableOverhead, boolean back, boolean flank) {
        if (!supported || !stableOverhead || !back) return Cover.NONE;
        return flank ? Cover.CORNER : Cover.SCREEN;
    }

    static Cover pocket(boolean supported, boolean twoCellsClear, boolean stableRoof, boolean back, boolean flank) {
        if (!supported || !stableRoof) return Cover.NONE;
        return twoCellsClear && back && flank ? Cover.POCKET : Cover.SCREEN;
    }

    /** Material and collision checks on a block already admitted by a rendered first hit. */
    static boolean stableCover(BlockView world, BlockPos pos, BlockState shown) {
        return shown.isOpaqueFullCube() && shown.isFullCube(world, pos) && !AgentBody.dryCaveDanger(shown)
            && !(shown.getBlock() instanceof FallingBlock) && !shown.isIn(BlockTags.LEAVES);
    }
}
