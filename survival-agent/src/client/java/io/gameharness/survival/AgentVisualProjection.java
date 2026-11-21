package io.gameharness.survival;

import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import org.joml.Matrix4f;
import org.joml.Vector4f;

/** Client-thread projection only. The image has top-left coordinates, unlike the GL framebuffer. */
final class AgentVisualProjection {
    record Region(double x, double y, double width, double height) {
        boolean valid() {
            return Double.isFinite(x) && Double.isFinite(y) && Double.isFinite(width) && Double.isFinite(height)
                && x >= 0 && y >= 0 && width > 0 && height > 0 && width <= .35 && height <= .35
                && x + width <= 1 && y + height <= 1;
        }

        boolean contains(double u, double v) {
            return u >= x && u <= x + width && v >= y && v <= y + height;
        }
    }

    record Pixel(double x, double y) {}
    record Ray(Vec3d origin, Vec3d direction) {}

    private static final int MAX_MASKS = 12;
    private final double[] masks = new double[4 * MAX_MASKS];
    final Matrix4f matrix = new Matrix4f(), inverse = new Matrix4f();
    private final Vector4f scratch = new Vector4f();
    Vec3d eye;
    float yaw, pitch;
    int width, height;
    private int maskEnd;

    void copyFrom(AgentVisualProjection source) {
        matrix.set(source.matrix);
        inverse.set(source.inverse);
        eye = source.eye;
        yaw = source.yaw;
        pitch = source.pitch;
        width = source.width;
        height = source.height;
        maskEnd = source.maskEnd;
        System.arraycopy(source.masks, 0, masks, 0, maskEnd);
    }

    boolean compatible(AgentVisualProjection other) {
        return eye != null && other.eye != null && width == other.width && height == other.height
            && eye.squaredDistanceTo(other.eye) <= .000225
            && Math.abs(MathHelper.wrapDegrees(yaw - other.yaw)) <= .12
            && Math.abs(pitch - other.pitch) <= .12 && matrix.equals(other.matrix, .004f);
    }

    boolean valid() {
        return eye != null && Double.isFinite(eye.x) && Double.isFinite(eye.y) && Double.isFinite(eye.z)
            && Float.isFinite(yaw) && Float.isFinite(pitch) && width > 0 && height > 0
            && matrix.isFinite() && inverse.isFinite();
    }

    void clearMasks() { maskEnd = 0; }

    void mask(double left, double top, double right, double bottom) {
        masks[maskEnd++] = left;
        masks[maskEnd++] = top;
        masks[maskEnd++] = right;
        masks[maskEnd++] = bottom;
    }

    boolean worldPixel(double x, double y) {
        if (!(x > 0 && x < 1 && y > 0 && y < 1)) return false;
        for (int i = 0; i < maskEnd; i += 4)
            if (x >= masks[i] && x <= masks[i + 2] && y >= masks[i + 1] && y <= masks[i + 3]) return false;
        return true;
    }

    Ray ray(double x, double y) {
        if (!worldPixel(x, y)) return null;
        // Unproject two distinct OpenGL clip depths. Vanilla's world projection includes
        // bob/tilt; normalizing one unprojected point would incorrectly drop its translation.
        float u = (float) (2 * x - 1), v = (float) (1 - 2 * y);
        inverse.transform(scratch.set(u, v, -1, 1));
        if (!scratch.isFinite() || !(scratch.w > 0)) return null;
        double nx = scratch.x / scratch.w, ny = scratch.y / scratch.w, nz = scratch.z / scratch.w;
        inverse.transform(scratch.set(u, v, 0, 1));
        if (!scratch.isFinite() || !(scratch.w > 0)) return null;
        var direction = new Vec3d(scratch.x / scratch.w - nx, scratch.y / scratch.w - ny, scratch.z / scratch.w - nz)
            .normalize();
        return direction.lengthSquared() > .99 ? new Ray(eye.add(nx, ny, nz), direction) : null;
    }

    Pixel project(Vec3d worldPoint) {
        matrix.transform(scratch.set((float) (worldPoint.x - eye.x), (float) (worldPoint.y - eye.y),
            (float) (worldPoint.z - eye.z), 1));
        if (!scratch.isFinite() || !(scratch.w > 0) || Math.abs(scratch.z) > scratch.w) return null;
        double x = .5 + .5 * scratch.x / scratch.w, y = .5 - .5 * scratch.y / scratch.w;
        return worldPixel(x, y) ? new Pixel(x, y) : null;
    }
}
