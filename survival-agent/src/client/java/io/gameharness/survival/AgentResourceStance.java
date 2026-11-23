package io.gameharness.survival;

import java.util.ArrayList;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

/** A resource sighting gives a destination and a stopping band, never supporting terrain. */
record AgentResourceStance(Vec3d point, double arrival, double minFootY, double maxFootY) {
    static final double SETTLE_PAD = 0.09;

    static AgentResourceStance exact(BlockPos foot) {
        double y = foot.getY();
        return new AgentResourceStance(Vec3d.ofBottomCenter(foot), 0.28, y - 0.06, y + 0.06);
    }

    boolean reached(Vec3d feet) {
        if (feet.y < minFootY || feet.y > maxFootY) return false;
        double dx = feet.x - point.x, dz = feet.z - point.z;
        double radius = arrival + SETTLE_PAD;
        return dx * dx + dz * dz <= radius * radius;
    }

    static boolean allowsTravel(boolean safe, boolean grounded, boolean driving, boolean previousTurn) {
        // An interrupted committed crossing cannot resume, even if the player is now grounded.
        return safe && (driving ? previousTurn : grounded);
    }

    /** A return or a new view of the same rock does not invalidate a previous refusal. */
    static final class Refusals {
        private static final int LIMIT = 32;
        private record Approach(BlockPos foot, BlockPos target) {}
        private final ArrayList<Approach> approaches = new ArrayList<>(LIMIT);

        boolean contains(BlockPos foot, BlockPos target) {
            for (int i = 0; i < approaches.size(); i++) {
                var attempt = approaches.get(i);
                if (foot.equals(attempt.foot) && target.equals(attempt.target)) return true;
            }
            return false;
        }

        void remember(BlockPos foot, BlockPos target) {
            if (contains(foot, target)) return;
            if (approaches.size() == LIMIT) approaches.removeFirst();
            approaches.add(new Approach(foot.toImmutable(), target.toImmutable()));
        }

        void changed(BlockPos block) {
            for (int i = approaches.size() - 1; i >= 0; i--) {
                var attempt = approaches.get(i);
                if (block.getSquaredDistance(attempt.foot) <= 9 || block.getSquaredDistance(attempt.target) <= 9)
                    approaches.remove(i);
            }
        }

        void clear() { approaches.clear(); }
    }
}
