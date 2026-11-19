package io.gameharness.survival;

import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.util.shape.VoxelShape;
import net.minecraft.util.shape.VoxelShapes;

/** An inset on the outline surface actually struck by a sight ray, not a block's center. */
final class AgentFaceAim {
    private static final double SURFACE_EPSILON = 0.002;
    private static final double PARALLEL_EPSILON = 1e-6;

    final BlockPos pos;
    final Direction side;
    private final Direction.Axis axis;
    private final double plane;
    private final double uMin, uMax, vMin, vMax;
    private final double x, y, z;

    AgentFaceAim(BlockHitResult witness, VoxelShape outline, boolean precise) {
        this(witness, outline, precise, false);
    }

    AgentFaceAim(BlockHitResult witness, VoxelShape outline, boolean precise, boolean narrow) {
        pos = witness.getBlockPos().toImmutable();
        side = witness.getSide();
        axis = side.getAxis();
        x = pos.getX();
        y = pos.getY();
        z = pos.getZ();
        Vec3d point = witness.getPos();
        plane = axis.choose(point.x - x, point.y - y, point.z - z);
        double u = u(point), v = v(point);
        // Pick only a rectangle containing the actual ray hit on its actual outline plane.
        // Even one decomposed rectangle can be occluded; the body ray admission still applies.
        Box surface = outline == VoxelShapes.fullCube() ? null : surfaceBox(outline, u, v);
        double loU = 0, loV = 0, hiU = 1, hiV = 1;
        if (surface != null) {
            loU = minU(surface);
            loV = minV(surface);
            hiU = maxU(surface);
            hiV = maxV(surface);
        } else if (outline != VoxelShapes.fullCube()) {
            // The outline may report an override face not belonging to a box at this plane.
            // Never extrapolate such a hit across a block-sized rectangle.
            loU = u - 0.035;
            loV = v - 0.035;
            hiU = u + 0.035;
            hiV = v + 0.035;
        }
        double margin = narrow ? 0.018 : precise ? 0.09 : 0.10;
        double insetU = Math.min((hiU - loU) * 0.22, margin);
        double insetV = Math.min((hiV - loV) * 0.22, margin);
        if (precise) {
            // A fluid lip or a specified support patch does not inherit the whole face.
            u = MathHelper.clamp(u, loU + insetU, hiU - insetU);
            v = MathHelper.clamp(v, loV + insetV, hiV - insetV);
        }
        double radius = narrow ? 0.055 : 0.16;
        uMin = precise ? Math.max(loU + insetU, u - radius) : loU + insetU;
        uMax = precise ? Math.min(hiU - insetU, u + radius) : hiU - insetU;
        vMin = precise ? Math.max(loV + insetV, v - radius) : loV + insetV;
        vMax = precise ? Math.min(hiV - insetV, v + radius) : hiV - insetV;
    }

    boolean matches(BlockHitResult hit) {
        return hit.getType() == HitResult.Type.BLOCK && pos.equals(hit.getBlockPos()) && hit.getSide() == side;
    }

    boolean admits(BlockHitResult hit) {
        if (!sameSurface(hit)) return false;
        Vec3d point = hit.getPos();
        return contains(u(point), v(point));
    }

    boolean sameSurface(BlockHitResult hit) {
        if (!matches(hit) || hit.isInsideBlock()) return false;
        Vec3d point = hit.getPos();
        return Math.abs(axis.choose(point.x - x, point.y - y, point.z - z) - plane) <= SURFACE_EPSILON;
    }

    Vec3d continuation(Vec3d origin, Vec3d direction, Vec3d witness) {
        double length = intersection(origin, direction);
        return length > 0 && Double.isFinite(length)
            ? inset(origin.x + direction.x * length, origin.y + direction.y * length, origin.z + direction.z * length)
            : inset(witness);
    }

    Vec3d inset(Vec3d witness) {
        return inset(witness.x, witness.y, witness.z);
    }

    private Vec3d inset(double px, double py, double pz) {
        // Pick a landing point beyond the entry boundary, so our deceleration does not
        // asymptotically stick outside the valid region. An action need not reach it.
        double guardU = (uMax - uMin) * 0.20, guardV = (vMax - vMin) * 0.20;
        double u = MathHelper.clamp((axis == Direction.Axis.X ? pz - z : px - x),
            uMin + guardU, uMax - guardU);
        double v = MathHelper.clamp((axis == Direction.Axis.Y ? pz - z : py - y),
            vMin + guardV, vMax - guardV);
        return switch (axis) {
            case X -> new Vec3d(x + plane, y + v, z + u);
            case Y -> new Vec3d(x + u, y + plane, z + v);
            case Z -> new Vec3d(x + u, y + v, z + plane);
        };
    }

    boolean willRemainInside(Vec3d origin, Vec3d direction, double reach) {
        double length = intersection(origin, direction);
        if (!(length > 0 && length <= reach)) return false;
        double u = u(origin) + (axis == Direction.Axis.X ? direction.z : direction.x) * length;
        double v = v(origin) + (axis == Direction.Axis.Y ? direction.z : direction.y) * length;
        return contains(u, v);
    }

    private double intersection(Vec3d origin, Vec3d direction) {
        double component = axis.choose(direction.x, direction.y, direction.z);
        if (Math.abs(component) <= PARALLEL_EPSILON) return -1;
        return (plane - axis.choose(origin.x - x, origin.y - y, origin.z - z)) / component;
    }

    private boolean contains(double u, double v) {
        return u >= uMin && u <= uMax && v >= vMin && v <= vMax;
    }

    double u(Vec3d point) { return axis == Direction.Axis.X ? point.z - z : point.x - x; }
    double v(Vec3d point) { return axis == Direction.Axis.Y ? point.z - z : point.y - y; }

    boolean broadFrom(Vec3d eye, Vec3d point) {
        double width = Math.min(uMax - uMin, vMax - vMin);
        if (width < 0.38) return false;
        double dx = eye.x - point.x, dy = eye.y - point.y, dz = eye.z - point.z;
        // The projected narrow dimension, in radians to first order, falls
        // below the broad-contact band at grazing or distant approaches.
        return width * Math.abs(axis.choose(dx, dy, dz)) >= (dx * dx + dy * dy + dz * dz) * 0.04;
    }

    boolean sameGoal(AgentFaceAim other) {
        return this == other || pos.equals(other.pos) && side == other.side
            && Math.abs(plane - other.plane) <= SURFACE_EPSILON;
    }

    private double minU(Box box) { return axis == Direction.Axis.X ? box.minZ : box.minX; }
    private double maxU(Box box) { return axis == Direction.Axis.X ? box.maxZ : box.maxX; }
    private double minV(Box box) { return axis == Direction.Axis.Y ? box.minZ : box.minY; }
    private double maxV(Box box) { return axis == Direction.Axis.Y ? box.maxZ : box.maxY; }

    private Box surfaceBox(VoxelShape outline, double u, double v) {
        Box best = null;
        double area = 0;
        for (Box box : outline.getBoundingBoxes()) {
            boolean positive = side.getDirection() == Direction.AxisDirection.POSITIVE;
            double boundary = positive ? axis.choose(box.maxX, box.maxY, box.maxZ)
                : axis.choose(box.minX, box.minY, box.minZ);
            if (Math.abs(plane - boundary) > SURFACE_EPSILON || u < minU(box) - SURFACE_EPSILON
                    || u > maxU(box) + SURFACE_EPSILON || v < minV(box) - SURFACE_EPSILON
                    || v > maxV(box) + SURFACE_EPSILON) continue;
            double size = (maxU(box) - minU(box)) * (maxV(box) - minV(box));
            if (size > area) {
                best = box;
                area = size;
            }
        }
        return best;
    }
}
