package io.gameharness.survival;

import java.util.Arrays;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;

/** Short-lived surface sightings, never a scan of the surrounding blocks. */
final class AgentHazards {
    static final double MAX_LANE = 3.4;
    static final double SIGHT_RANGE = 8;
    private static final int CAPACITY = 48;
    private static final int AGE = 32;
    private static final byte LAVA = 1;
    private static final byte WATER = 2;
    private static final byte SOURCE = 4;
    private final BlockHitResult[] hits = new BlockHitResult[CAPACITY];
    private final int[] seen = new int[CAPACITY];
    private final byte[] kinds = new byte[CAPACITY];
    private int size;

    static byte kind(BlockState state) {
        int fluid = state.isOf(Blocks.LAVA) ? LAVA : state.isOf(Blocks.WATER) ? WATER : 0;
        return fluid == 0 ? 0 : (byte) (fluid | (state.getFluidState().isStill() ? SOURCE : 0));
    }

    static boolean matches(byte kind, boolean lava, boolean sourceOnly) {
        int mask = (lava ? LAVA : WATER) | (sourceOnly ? SOURCE : 0);
        return (kind & mask) == mask;
    }

    void observe(BlockHitResult hit, byte kind, Vec3d eye, double distance, int tick) {
        if (distance > SIGHT_RANGE * SIGHT_RANGE) return;
        int replace = -1;
        double worst = distance;
        BlockPos pos = hit.getBlockPos();
        for (int i = 0; i < size; i++) {
            if (pos.equals(hits[i].getBlockPos())) {
                if (kind == 0) remove(i);
                else put(i, hit, kind, tick);
                return;
            }
            if (kind == 0 || size < CAPACITY) continue;
            double score = tick - seen[i] > AGE ? Double.POSITIVE_INFINITY
                : eye.squaredDistanceTo(hits[i].getPos()) + tick - seen[i];
            if (score > worst) {
                replace = i;
                worst = score;
            }
        }
        if (kind == 0) return;
        if (size < CAPACITY) put(size++, hit, kind, tick);
        else if (replace >= 0) put(replace, hit, kind, tick);
    }

    private void put(int i, BlockHitResult hit, byte kind, int tick) {
        hits[i] = hit;
        kinds[i] = kind;
        seen[i] = tick;
    }

    private void remove(int i) {
        int last = --size;
        put(i, hits[last], kinds[last], seen[last]);
        hits[last] = null;
    }

    void clear() {
        Arrays.fill(hits, 0, size, null);
        size = 0;
    }

    BlockHitResult currentFluid(boolean lava, boolean sourceOnly, Vec3d eye, double distance, int tick) {
        double nearest = distance * distance;
        BlockHitResult result = null;
        for (int i = 0; i < size; i++) {
            if (seen[i] != tick || !matches(kinds[i], lava, sourceOnly)) continue;
            double d = eye.squaredDistanceTo(hits[i].getPos());
            if (d <= nearest) {
                nearest = d;
                result = hits[i];
            }
        }
        return result;
    }

    /** Visible lava next to a cut can spill into it before it crosses the walking lane. */
    boolean breachesDig(BlockPos foot, BlockPos standing, int tick) {
        for (int i = 0; i < size; i++) {
            if ((kinds[i] & LAVA) == 0 || tick - seen[i] > AGE) continue;
            BlockPos pos = hits[i].getBlockPos();
            if (pos.getY() >= Math.min(foot.getY(), standing.getY())
                    && pos.getY() <= Math.max(foot.getY(), standing.getY()) + 2
                    && (beside(pos, foot) || (kinds[i] & SOURCE) == 0 && beside(pos, standing))) return true;
        }
        return false;
    }

    private static boolean beside(BlockPos a, BlockPos b) {
        return Math.abs(a.getX() - b.getX()) + Math.abs(a.getZ() - b.getZ()) <= 1;
    }

    boolean lavaNear(Box body, double margin, int tick) {
        for (int i = 0; i < size; i++) {
            if ((kinds[i] & LAVA) == 0 || tick - seen[i] > AGE) continue;
            BlockPos pos = hits[i].getBlockPos();
            if (pos.getY() + 1 > body.minY && pos.getY() < body.maxY
                    && pos.getX() + 1 + margin > body.minX && pos.getX() - margin < body.maxX
                    && pos.getZ() + 1 + margin > body.minZ && pos.getZ() - margin < body.maxZ) return true;
        }
        return false;
    }

    double lavaRisk(Box body, float yaw, double distance, double rise, boolean escaping, int tick) {
        if (!(distance > 0)) return 0;
        distance = Math.min(distance, MAX_LANE);
        double angle = Math.toRadians(yaw);
        double dx = -Math.sin(angle), dz = Math.cos(angle);
        double x = (body.minX + body.maxX) * 0.5, z = (body.minZ + body.maxZ) * 0.5;
        double halfX = (body.maxX - body.minX) * 0.5, halfZ = (body.maxZ - body.minZ) * 0.5;
        for (int i = 0; i < size; i++) {
            if (tick - seen[i] > AGE || (kinds[i] & LAVA) == 0) continue;
            BlockHitResult hit = hits[i];
            BlockPos pos = hit.getBlockPos();
            // The first few blocks below the feet matter too: a walk off a lip is a fall.
            if (hit.getPos().y < body.minY - (escaping ? 1.2 : MAX_LANE) || pos.getY() >= body.maxY + rise) continue;
            double minX = pos.getX() - halfX, maxX = pos.getX() + 1 + halfX;
            double minZ = pos.getZ() - halfZ, maxZ = pos.getZ() + 1 + halfZ;
            double overlap = penetration(x, z, minX, maxX, minZ, maxZ);
            // During egress a walked landing may lead along the edge of the current flow.
            // Permit leaving that cell, but not entering a second sighted lava cell.
            if (overlap > 0 && (escaping
                    ? penetration(x + dx * distance, z + dz * distance, minX, maxX, minZ, maxZ) <= 0
                    : penetration(x + dx * 0.01, z + dz * 0.01, minX, maxX, minZ, maxZ) < overlap - 1e-7)) continue;
            double crossing = crossing(x, z, dx, dz, distance, minX, maxX, minZ, maxZ);
            if (crossing > 0) return crossing;
        }
        return 0;
    }

    private static double penetration(double x, double z, double minX, double maxX, double minZ, double maxZ) {
        return Math.min(Math.min(x - minX, maxX - x), Math.min(z - minZ, maxZ - z));
    }

    /** Clip the center's segment against the fluid cell expanded by the player's half-width. */
    private static double crossing(double x, double z, double dx, double dz, double distance,
            double minX, double maxX, double minZ, double maxZ) {
        double enter = 0, leave = distance;
        if (Math.abs(dx) < 1e-8) {
            if (x <= minX || x >= maxX) return 0;
        } else {
            double a = (minX - x) / dx, b = (maxX - x) / dx;
            enter = Math.max(enter, Math.min(a, b));
            leave = Math.min(leave, Math.max(a, b));
        }
        if (Math.abs(dz) < 1e-8) {
            if (z <= minZ || z >= maxZ) return 0;
        } else {
            double a = (minZ - z) / dz, b = (maxZ - z) / dz;
            enter = Math.max(enter, Math.min(a, b));
            leave = Math.min(leave, Math.max(a, b));
        }
        return leave - enter;
    }
}
