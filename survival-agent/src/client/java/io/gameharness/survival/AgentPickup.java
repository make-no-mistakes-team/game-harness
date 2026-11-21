package io.gameharness.survival;

import net.minecraft.item.ItemStack;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** A loose item can request foot input, never a camera target. */
final class AgentPickup {
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
