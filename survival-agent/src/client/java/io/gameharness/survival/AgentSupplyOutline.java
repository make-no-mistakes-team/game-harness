package io.gameharness.survival;

import io.gameharness.survival.AgentBody.OutlineClearance;
import java.util.Arrays;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.block.ShapeContext;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.state.property.Properties;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;

/** Evidence for an outlined supply-exit contact, without classifying hidden cells. */
final class AgentSupplyOutline {
    static final long MAX_FRAME_NANOS = 200_000_000L;
    private static final double MIN_PREFIX = 0.05, BEFORE_BACKSTOP = 0.06, LINE_ERROR = 0.065;

    private AgentSupplyOutline() {}

    static boolean admits(boolean drawn, int frameAge, long nanos, Vec3d renderedEye, Vec3d liveEye,
                          float yawError, float pitchError, BlockHitResult shown, BlockHitResult live, double reach) {
        return drawn && frameAge >= 0 && frameAge <= 1 && nanos >= 0 && nanos <= MAX_FRAME_NANOS
            && Math.abs(yawError) <= 3.5f && Math.abs(pitchError) <= 3.5f
            && renderedEye.squaredDistanceTo(liveEye) <= 0.20 * 0.20
            && matchesFace(shown, live) && withinReach(renderedEye, shown, reach) && withinReach(liveEye, live, reach);
    }

    static boolean matchesFace(BlockHitResult shown, BlockHitResult live) {
        return blockHit(shown) && blockHit(live) && shown.getSide() == live.getSide()
            && shown.getBlockPos().equals(live.getBlockPos());
    }

    private static boolean blockHit(BlockHitResult hit) {
        return hit != null && hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock();
    }

    private static boolean withinReach(Vec3d eye, BlockHitResult hit, double reach) {
        double distance = eye.squaredDistanceTo(hit.getPos());
        return Double.isFinite(reach) && reach > 0 && distance > MIN_PREFIX * MIN_PREFIX && distance <= reach * reach;
    }

    static boolean naturalCut(BlockState state) {
        return state.isIn(BlockTags.BASE_STONE_OVERWORLD) || state.isIn(BlockTags.DIRT) || state.isOf(Blocks.GRASS_BLOCK)
            || state.isOf(Blocks.TUFF) || state.isOf(Blocks.CALCITE) || state.isOf(Blocks.CLAY)
            || state.isOf(Blocks.DRIPSTONE_BLOCK);
    }

    /** Only ordinary vanilla earth or rock, not a tag that can include ore or a protected block. */
    static boolean escapeMaterial(BlockState state) {
        return state.isOf(Blocks.DIRT) || state.isOf(Blocks.COARSE_DIRT) || state.isOf(Blocks.ROOTED_DIRT)
            || state.isOf(Blocks.GRASS_BLOCK) || state.isOf(Blocks.PODZOL) || state.isOf(Blocks.MYCELIUM)
            || state.isOf(Blocks.CLAY) || state.isOf(Blocks.STONE) || state.isOf(Blocks.GRANITE)
            || state.isOf(Blocks.DIORITE) || state.isOf(Blocks.ANDESITE) || state.isOf(Blocks.DEEPSLATE)
            || state.isOf(Blocks.TUFF) || state.isOf(Blocks.CALCITE) || state.isOf(Blocks.DRIPSTONE_BLOCK);
    }

    static float observedCrack(BlockPos target, BlockPos nativeTarget, float crack) {
        return target.equals(nativeTarget) && crack > 0 && crack < 1 ? crack : 0;
    }

    /** Bounds one attack on one drawn surface, not a source of break or drop receipts. */
    static final class EscapeWork {
        private static final int MAX_TICKS = 180, STALLED_TICKS = 12, MAX_GAP_TICKS = 3;
        private BlockHitResult face;
        private BlockState state;
        private ItemStack hand = ItemStack.EMPTY;
        private int startedAt, advancedAt, drawnAt;
        private long drawnNanos;
        private float peak;

        boolean active() { return face != null; }

        void start(BlockHitResult selected, BlockState material, ItemStack held, int tick) {
            face = selected;
            state = material;
            hand = held.isEmpty() ? ItemStack.EMPTY : held.copy();
            startedAt = advancedAt = tick;
            peak = 0;
        }

        void forget() {
            face = null;
            state = null;
            hand = ItemStack.EMPTY;
        }

        void drawn(int tick, long nanos) {
            drawnAt = tick;
            drawnNanos = nanos;
        }

        boolean matches(BlockHitResult hit, BlockState material, ItemStack held) {
            return matchesFace(face, hit) && state == material && ItemStack.areItemsAndComponentsEqual(hand, held);
        }

        boolean bridges(BlockHitResult seen, BlockHitResult live, int tick, long nanos, float crack) {
            return crack > 0 && tick - drawnAt >= 0 && tick - drawnAt <= MAX_GAP_TICKS
                && nanos - drawnNanos >= 0 && nanos - drawnNanos <= MAX_FRAME_NANOS
                && matchesFace(face, seen) && matchesFace(face, live);
        }

        OutlineClearance check(int tick, float delta, float crack) {
            int elapsed = active() ? tick - startedAt : 0;
            if (elapsed >= MAX_TICKS) return OutlineClearance.EXPIRED;
            if (active()) {
                if (crack > peak) {
                    peak = crack;
                    advancedAt = tick;
                }
                if (tick - advancedAt >= STALLED_TICKS) return OutlineClearance.STALLED;
            }
            // The first vanilla tick starts the crack. Also reserve the cooldown
            // that may remain from the preceding block.
            int ticksLeft = MAX_TICKS - elapsed - (active() ? 0 : 6);
            return Float.isFinite(delta) && delta > 0 && (1.0 - crack) <= (double) delta * ticksLeft
                ? OutlineClearance.REQUESTED : OutlineClearance.TOO_SLOW;
        }
    }

    enum CutAdmission { ALLOWED, UNKNOWN_OVERHEAD, BLOCKED }

    /** One pending cut and its drawn cap or attachments. There is no world lookup here. */
    static final class CutCover {
        private static final int MAX_TICKS = 8, CAP = 0;
        private static final long MAX_NANOS = 500_000_000L;
        private static final double COLUMN_MARGIN = 0.02;
        private enum Cover { UNKNOWN, CLEAR, HAZARD }

        private final Cover[] seen = new Cover[5];
        private final int[] seenTick = new int[seen.length];
        private final long[] seenNanos = new long[seen.length];
        private BlockPos target;
        private Vec3d capCenter;
        private int watchedTick;

        void watch(BlockPos cell, int tick) {
            if (!cell.equals(target) || tick - watchedTick > 1) {
                Arrays.fill(seen, Cover.UNKNOWN);
                target = cell.toImmutable();
                capCenter = Vec3d.ofCenter(cell, 1.30);
            }
            watchedTick = tick;
        }

        void forget() { target = null; }

        boolean watching(int tick) {
            return target != null && tick >= watchedTick && tick - watchedTick <= 1;
        }

        void observe(BlockHitResult hit, BlockState drawn, Vec3d eye, double reach, int tick, long nanos) {
            if (!watching(tick) || !blockHit(hit) || !withinReach(eye, hit, reach)) return;
            BlockPos cell = hit.getBlockPos();
            int dx = cell.getX() - target.getX(), dy = cell.getY() - target.getY(), dz = cell.getZ() - target.getZ();
            if (dx == 0 && dy == 1 && dz == 0) {
                boolean unsafe = AgentBody.dryCaveDanger(drawn) || drawn.getBlock() instanceof FallingBlock
                    || drawn.isOf(Blocks.TORCH) || drawn.isOf(Blocks.SOUL_TORCH) || drawn.isOf(Blocks.REDSTONE_TORCH)
                    || drawn.isOf(Blocks.CRAFTING_TABLE) || drawn.isOf(Blocks.FURNACE);
                receipt(CAP, unsafe ? Cover.HAZARD
                    : hit.getSide() != Direction.DOWN && naturalCut(drawn) ? Cover.CLEAR : Cover.UNKNOWN, tick, nanos);
            } else if (dy == 0 && Math.abs(dx) + Math.abs(dz) == 1) {
                boolean unsafe = !drawn.getFluidState().isEmpty();
                if (drawn.isOf(Blocks.WALL_TORCH) || drawn.isOf(Blocks.SOUL_WALL_TORCH)
                        || drawn.isOf(Blocks.REDSTONE_WALL_TORCH)) {
                    Direction facing = drawn.get(Properties.HORIZONTAL_FACING);
                    unsafe = facing.getOffsetX() == dx && facing.getOffsetZ() == dz;
                }
                int side = dx < 0 ? 1 : dx > 0 ? 2 : dz < 0 ? 3 : 4;
                receipt(side, unsafe ? Cover.HAZARD : Cover.UNKNOWN, tick, nanos);
            }
        }

        /** Only the center of the load zone may be supported by a dry, actually selected backstop. */
        Vec3d capSample(BlockHitResult backstop, Vec3d eye, double reach, int tick, long nanos) {
            if (!watching(tick) || current(CAP, tick, nanos) != Cover.UNKNOWN) return null;
            return provesPrefix(eye, capCenter, backstop, reach) ? capCenter : null;
        }

        void observeDryCapPrefix(int tick, long nanos) { receipt(CAP, Cover.CLEAR, tick, nanos); }

        private void receipt(int slot, Cover cover, int tick, long nanos) {
            seen[slot] = cover;
            seenTick[slot] = tick;
            seenNanos[slot] = nanos;
        }

        private Cover current(int slot, int tick, long nanos) {
            int age = tick - seenTick[slot];
            long elapsed = nanos - seenNanos[slot];
            return age >= 0 && age <= MAX_TICKS && elapsed >= 0 && elapsed <= MAX_NANOS ? seen[slot] : Cover.UNKNOWN;
        }

        static boolean underColumn(BlockPos cell, Box hull) {
            int x = cell.getX(), z = cell.getZ();
            return x + 1.0 + COLUMN_MARGIN > hull.minX && x - COLUMN_MARGIN < hull.maxX
                && z + 1.0 + COLUMN_MARGIN > hull.minZ && z - COLUMN_MARGIN < hull.maxZ;
        }

        CutAdmission admission(BlockPos cell, Box hull, int tick, long nanos) {
            if (!watching(tick) || !cell.equals(target)) return CutAdmission.BLOCKED;
            boolean underColumn = underColumn(cell, hull);
            Cover cap = current(CAP, tick, nanos);
            if (cap == Cover.HAZARD || underColumn && cell.getY() < hull.maxY) return CutAdmission.BLOCKED;
            for (int side = 1; side < seen.length; side++) {
                if (current(side, tick, nanos) == Cover.HAZARD) return CutAdmission.BLOCKED;
            }
            // Unknown cover permits a lateral cut only, never one above or below the stance.
            return underColumn && cap != Cover.CLEAR ? CutAdmission.UNKNOWN_OVERHEAD : CutAdmission.ALLOWED;
        }

        boolean allows(BlockPos cell, Box hull, int tick, long nanos) {
            return admission(cell, hull, tick, nanos) == CutAdmission.ALLOWED;
        }
    }

    static boolean provesPrefix(Vec3d eye, Vec3d sample, BlockHitResult backstop, double reach) {
        if (!blockHit(backstop) || !withinReach(eye, backstop, reach)) return false;
        Vec3d end = backstop.getPos();
        double x = end.x - eye.x, y = end.y - eye.y, z = end.z - eye.z;
        double sx = sample.x - eye.x, sy = sample.y - eye.y, sz = sample.z - eye.z;
        double length = Math.sqrt(x * x + y * y + z * z);
        double along = (sx * x + sy * y + sz * z) / length;
        double offX = sx - x * along / length, offY = sy - y * along / length, offZ = sz - z * along / length;
        return along > MIN_PREFIX && along < length - BEFORE_BACKSTOP
            && offX * offX + offY * offY + offZ * offZ <= LINE_ERROR * LINE_ERROR;
    }

    /** Before reaching the anchor the actual line must cross the attachment cell's interior. */
    static boolean entersAttachment(Vec3d eye, BlockHitResult hit, BlockPos target) {
        if (!blockHit(hit)) return false;
        Vec3d surface = hit.getPos();
        double length = eye.distanceTo(surface);
        if (!(length > 0.26)) return false;
        double t = 0.20 / length;
        return inside(surface.x + (eye.x - surface.x) * t - target.getX())
            && inside(surface.y + (eye.y - surface.y) * t - target.getY())
            && inside(surface.z + (eye.z - surface.z) * t - target.getZ());
    }

    private static boolean inside(double coordinate) { return coordinate > 1e-5 && coordinate < 1 - 1e-5; }

    static boolean drySelectedFace(BlockView world, ShapeContext shape, Vec3d eye, BlockHitResult selected,
                                   double reach) {
        return blockHit(selected) && withinReach(eye, selected, reach)
            && dryCorridor(world, shape, eye, selected, selected.getPos(), reach, false);
    }

    static boolean dryPrefix(BlockView world, ShapeContext shape, Vec3d eye, BlockHitResult backstop,
                             Vec3d sample, double reach) {
        return provesPrefix(eye, sample, backstop, reach)
            && dryCorridor(world, shape, eye, backstop, sample, reach, true);
    }

    /**
     * Reproduce the first hit, now counting fluids and vetoing a closer collider.
     * A clearance point slightly off the actual pixel must still see the same backstop through that point.
     */
    private static boolean dryCorridor(BlockView world, ShapeContext shape, Vec3d eye, BlockHitResult selected,
                                       Vec3d through, double reach, boolean prefix) {
        Vec3d surface = selected.getPos();
        double distance = eye.distanceTo(surface);
        double dx = through.x - eye.x, dy = through.y - eye.y, dz = through.z - eye.z;
        double throughDistanceSq = dx * dx + dy * dy + dz * dz;
        double ratio = Math.min(reach, distance + 0.12) / Math.sqrt(throughDistanceSq);
        Vec3d end = eye.add(dx * ratio, dy * ratio, dz * ratio);
        BlockHitResult hit = world.raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.ANY, shape));
        if (!matchesFace(selected, hit) || surface.squaredDistanceTo(hit.getPos()) > 0.22 * 0.22
                || !world.getFluidState(hit.getBlockPos()).isEmpty()) return false;
        double hitDistanceSq = eye.squaredDistanceTo(hit.getPos());
        if (prefix && hitDistanceSq <= throughDistanceSq) return false;
        BlockHitResult solid = world.raycast(new RaycastContext(eye, hit.getPos(), RaycastContext.ShapeType.COLLIDER,
            RaycastContext.FluidHandling.ANY, shape));
        return solid.getType() == HitResult.Type.MISS || !solid.isInsideBlock()
            && eye.squaredDistanceTo(solid.getPos()) + 1e-5 >= hitDistanceSq;
    }
}
