package io.gameharness.survival;

import java.util.function.BiPredicate;
import net.minecraft.item.ItemStack;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** A loose item can request foot input, never a camera target. */
final class AgentPickup {
    private static final int PASSIVE_GRACE_TICKS = 12;
    private static final Direction[] CARDINAL = {Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST};

    record Access(BlockPos foot, Direction bearing) {}

    enum Scope {
        LOCAL, EXACT_ENTITY, MATCHING_STOCK;

        boolean permitsNeighbor(ItemStack selected, ItemStack neighbor) {
            return this == MATCHING_STOCK && ItemStack.areItemsAndComponentsEqual(selected, neighbor);
        }
    }

    enum Input {
        WAIT(0, 0, 0), UNREACHABLE(0, 0, 0),
        FORWARD(1, 0, 0), FORWARD_RIGHT(1, 1, 45), RIGHT(0, 1, 90), BACK_RIGHT(-1, 1, 135),
        BACK(-1, 0, 180), BACK_LEFT(-1, -1, -135), LEFT(0, -1, -90), FORWARD_LEFT(1, -1, -45);

        final int forward, right;
        final float yawOffset;

        Input(int forward, int right, float yawOffset) {
            this.forward = forward;
            this.right = right;
            this.yawOffset = yawOffset;
        }
    }

    private static final Input[] DIRECTIONS = {
        Input.FORWARD, Input.FORWARD_RIGHT, Input.RIGHT, Input.BACK_RIGHT,
        Input.BACK, Input.BACK_LEFT, Input.LEFT, Input.FORWARD_LEFT
    };

    private AgentPickup() {}

    /** No movement needed; inventory confirmation still belongs to vanilla. */
    static boolean passiveOverlap(Box player, Box drop) {
        return drop.maxY > player.minY - 0.5 && drop.minY < player.maxY + 0.5
            && drop.maxX > player.minX - 1 && drop.minX < player.maxX + 1
            && drop.maxZ > player.minZ - 1 && drop.minZ < player.maxZ + 1;
    }

    static boolean shouldCheckDryAccess(Box player, Box drop, boolean grounded, long quietTicks) {
        return grounded && (!passiveOverlap(player, drop) || quietTicks >= PASSIVE_GRACE_TICKS);
    }

    /** Choose a stance, not a path to the item's center. The caller must positively witness the tread. */
    static Access dryAccess(Box player, Box drop, BlockPos from, BiPredicate<BlockPos, Direction> witnessed) {
        double px = (player.minX + player.maxX) * 0.5, pz = (player.minZ + player.maxZ) * 0.5;
        double dx = (drop.minX + drop.maxX) * 0.5 - px, dz = (drop.minZ + drop.maxZ) * 0.5 - pz;
        double dy = drop.minY - player.minY;
        int grade = dy < -0.35 ? -1 : 0;
        Access best = null;
        double bestDistance = dx * dx + dy * dy + dz * dz - 0.04;
        for (Direction bearing : CARDINAL) {
            BlockPos foot = from.offset(bearing).up(grade);
            double x = foot.getX() + 0.5 - px, y = foot.getY() - player.minY, z = foot.getZ() + 0.5 - pz;
            double distance = (dx - x) * (dx - x) + (dy - y) * (dy - y) + (dz - z) * (dz - z);
            if (distance >= bestDistance || !passiveOverlap(player.offset(x, y, z), drop) || !witnessed.test(foot, bearing)) continue;
            best = new Access(foot, bearing);
            bestDistance = distance;
        }
        return best;
    }

    static Input input(Box player, Box drop, boolean onGround, Vec3d waypoint, float yaw) {
        // PlayerEntity checks intersecting item boxes, not distance to their centers or the crosshair.
        if (drop.maxY <= player.minY - 0.5 || drop.minY >= player.maxY + 0.5)
            return onGround ? Input.UNREACHABLE : Input.WAIT;
        double x = gap(player.minX - 1, player.maxX + 1, drop.minX, drop.maxX);
        double z = gap(player.minZ - 1, player.maxZ + 1, drop.minZ, drop.maxZ);
        if (x == 0 && z == 0) return Input.WAIT;
        // Stop as soon as the boxes overlap. Walk toward the nearest part of that region,
        // not toward the entity's center; a small inset keeps a corner approach from grazing it.
        if (waypoint != null) {
            x = waypoint.x - (player.minX + player.maxX) * 0.5;
            z = waypoint.z - (player.minZ + player.maxZ) * 0.5;
            if (x == 0 && z == 0) return Input.WAIT;
        }
        double bearing = Math.toDegrees(Math.atan2(-x, z));
        return DIRECTIONS[Math.floorMod((int) Math.round(MathHelper.wrapDegrees(bearing - yaw) / 45), 8)];
    }

    /** Clip a vanilla-sized ground contact probe to the footprint already under the player. */
    static Box footContact(Box player, int x, int z) {
        double minX = Math.max(x + 1e-6, player.minX), maxX = Math.min(x + 1 - 1e-6, player.maxX);
        double minZ = Math.max(z + 1e-6, player.minZ), maxZ = Math.min(z + 1 - 1e-6, player.maxZ);
        return maxX <= minX || maxZ <= minZ ? null
            : new Box(minX, player.minY - 1e-6, minZ, maxX, player.minY, maxZ);
    }

    private static double gap(double min, double max, double dropMin, double dropMax) {
        if (dropMin >= max) return dropMin - max + 0.12;
        return dropMax <= min ? dropMax - min - 0.12 : 0;
    }
}
