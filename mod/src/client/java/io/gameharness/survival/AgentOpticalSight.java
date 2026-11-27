package io.gameharness.survival;

import io.gameharness.survival.mixin.AgentMultipartModelAccess;
import io.gameharness.survival.mixin.AgentSpriteContentsAccess;
import io.gameharness.survival.mixin.AgentTextureFilterAccess;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.LeavesBlock;
import net.minecraft.block.ShapeContext;
import net.minecraft.block.StainedGlassBlock;
import net.minecraft.block.StainedGlassPaneBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.render.RenderLayer;
import net.minecraft.client.render.RenderLayers;
import net.minecraft.client.render.model.BakedModel;
import net.minecraft.client.render.model.BakedQuad;
import net.minecraft.client.render.model.BasicBakedModel;
import net.minecraft.client.render.model.MultipartBakedModel;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.texture.Sprite;
import net.minecraft.client.texture.SpriteAtlasTexture;
import net.minecraft.client.texture.SpriteContents;
import net.minecraft.fluid.FluidState;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.Identifier;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.util.math.random.Random;
import net.minecraft.util.shape.VoxelShape;
import net.minecraft.util.shape.VoxelShapes;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;
import org.joml.Matrix4f;

/**
 * Optical first hits only. Never use these hits to authorize collision, mining or item use.
 * The caller still owns projection, light, range and the number of camera rays.
 */
final class AgentOpticalSight {
    static final int MAX_LAYERS = 8;
    static final double MIN_TRANSMISSION = 0.08;
    private static final int MAX_STATES = 4096;
    private static final int MAX_QUADS = 256;
    private static final int MAX_SPRITES = 128;
    private static final int MAX_MASK_PIXELS = 4 * 1024 * 1024;
    private static final Direction[] SIDES = Direction.values();
    private static final Identifier WATER_STILL = Identifier.ofVanilla("block/water_still");
    private static final Identifier WATER_FLOW = Identifier.ofVanilla("block/water_flow");

    /** Loaded render assets, not world/block discovery. Also the production regression seam. */
    interface Assets {
        Object generation();
        Iterable<BlockState> states();
        BakedModel model(BlockState state);
        Sprite waterStill();
        Sprite waterFlow();
        boolean nearestMagnification();
    }

    private final Assets assets;
    private final Map<BlockState, OpticalModel> models = new IdentityHashMap<>();
    private Object generation;
    private double waterTransmission;
    private final Matrix4f projection = new Matrix4f();
    private int viewportWidth, viewportHeight;
    private boolean nearestMagnification;

    AgentOpticalSight(MinecraftClient client) {
        this(new Assets() {
            @Override public Object generation() { return client.getBakedModelManager().getMissingBlockModel(); }
            @Override public Iterable<BlockState> states() {
                List<BlockState> states = new ArrayList<>();
                for (Block block : Registries.BLOCK) {
                    if (!supported(block)) continue;
                    for (BlockState state : block.getStateManager().getStates()) {
                        if (states.size() == MAX_STATES) return states;
                        states.add(state);
                    }
                }
                return states;
            }
            @Override public BakedModel model(BlockState state) {
                return client.getBlockRenderManager().getModel(state);
            }
            @Override public Sprite waterStill() {
                return client.getBakedModelManager().getAtlas(SpriteAtlasTexture.BLOCK_ATLAS_TEXTURE)
                    .getSprite(WATER_STILL);
            }
            @Override public Sprite waterFlow() {
                return client.getBakedModelManager().getAtlas(SpriteAtlasTexture.BLOCK_ATLAS_TEXTURE)
                    .getSprite(WATER_FLOW);
            }
            @Override public boolean nearestMagnification() {
                return ((AgentTextureFilterAccess) client.getBakedModelManager()
                    .getAtlas(SpriteAtlasTexture.BLOCK_ATLAS_TEXTURE)).gameharness$magnificationFilter() == 9728;
            }
        });
    }

    AgentOpticalSight(Assets assets) { this.assets = assets; }

    void prepare(Matrix4f viewProjection, int width, int height) {
        projection.set(viewProjection);
        viewportWidth = width;
        viewportHeight = height;
        prepare();
    }

    /**
     * Call once before this frame's rays, on the client thread. Model reload replaces the
     * missing-model sentinel after atlas/model apply; no closed NativeImages are retained.
     * No texture read, model decoding, or cache fill happens in raycast().
     */
    void prepare() {
        nearestMagnification = assets.nearestMagnification();
        Object current = assets.generation();
        if (current == generation) return;
        generation = current;
        models.clear();
        waterTransmission = 0;
        if (current == null) return;
        MaskCache masks = new MaskCache();
        Map<BakedModel, OpticalModel> basicModels = new IdentityHashMap<>();
        Random random = Random.create(0);
        int states = 0;
        for (BlockState state : assets.states()) {
            if (!supported(state.getBlock())) continue;
            if (++states > MAX_STATES) break;
            BakedModel baked = assets.model(state);
            OpticalModel optical = basicModels.get(baked);
            if (optical == null) {
                optical = bake(baked, state, masks, random);
                if (baked != null && baked.getClass() == BasicBakedModel.class) basicModels.put(baked, optical);
            }
            models.put(state, optical);
        }
        AlphaMask still = masks.get(assets.waterStill());
        AlphaMask flow = masks.get(assets.waterFlow());
        if (still != null && flow != null) {
            waterTransmission = 1 - Math.max(still.maximum, flow.maximum) / 255.0;
        }
    }

    BlockHitResult raycast(BlockView world, Vec3d eye, Vec3d end, ShapeContext shapeContext) {
        return world.raycast(new OpticalRay(eye, end, shapeContext));
    }

    private final class OpticalRay extends RaycastContext {
        private int layers;
        private double transmission = 1;

        OpticalRay(Vec3d eye, Vec3d end, ShapeContext shape) {
            super(eye, end, ShapeType.OUTLINE, FluidHandling.NONE, shape);
        }

        @Override public VoxelShape getBlockShape(BlockState state, BlockView world, BlockPos pos) {
            VoxelShape shape = super.getBlockShape(state, world, pos);
            OpticalModel model = models.get(state);
            if (model == null || model == OpticalModel.OPAQUE || shape.isEmpty()) return shape;
            RenderLayer layer = RenderLayers.getBlockLayer(state);
            // FAST leaves use SOLID: their alpha is not a rendered hole.
            boolean cutout = layer == RenderLayer.getCutout() || layer == RenderLayer.getCutoutMipped();
            boolean translucent = layer == RenderLayer.getTranslucent();
            if (!cutout && !translucent) return shape;
            double remaining = model.transmission(getStart(), getEnd(), pos, cutout, AgentOpticalSight.this);
            if (remaining < 0 || !transmit(remaining)) return shape;
            return VoxelShapes.empty();
        }

        @Override public VoxelShape getFluidShape(FluidState fluid, BlockView world, BlockPos pos) {
            if (fluid.isEmpty()) return VoxelShapes.empty();
            VoxelShape shape = fluid.getShape(world, pos);
            if (!fluid.isIn(FluidTags.WATER)) return shape; // Includes lava.
            if (shape.raycast(getStart(), getEnd(), pos) == null) return VoxelShapes.empty();
            // Conservative per-cell attenuation, including waterlogged transparent blocks.
            return transmit(waterTransmission) ? VoxelShapes.empty() : shape;
        }

        private boolean transmit(double factor) {
            if (factor <= 0 || layers >= MAX_LAYERS || transmission * factor < MIN_TRANSMISSION) return false;
            layers++;
            transmission *= factor;
            return true;
        }
    }

    private static boolean supported(Block block) {
        return block instanceof LeavesBlock || block == Blocks.GLASS || block == Blocks.GLASS_PANE
            || block instanceof StainedGlassBlock || block instanceof StainedGlassPaneBlock;
    }

    private static OpticalModel bake(BakedModel model, BlockState state, MaskCache masks, Random random) {
        if (!staticGeometry(model)) return OpticalModel.OPAQUE;
        List<Surface> surfaces = new ArrayList<>();
        for (int side = -1; side < SIDES.length; side++) {
            random.setSeed(0);
            List<BakedQuad> quads = model.getQuads(state, side < 0 ? null : SIDES[side], random);
            if (surfaces.size() + quads.size() > MAX_QUADS) return OpticalModel.OPAQUE;
            for (BakedQuad quad : quads) {
                AlphaMask alpha = masks.get(quad.getSprite());
                Surface surface = alpha == null ? null : Surface.decode(quad, alpha);
                if (surface == null) return OpticalModel.OPAQUE;
                surfaces.add(surface);
            }
        }
        // Missing/unsupported geometry is not permission to see through a full outline.
        return surfaces.isEmpty() ? OpticalModel.OPAQUE : new OpticalModel(surfaces.toArray(Surface[]::new));
    }

    private static boolean staticGeometry(BakedModel model) {
        if (model == null) return false;
        if (model.getClass() == BasicBakedModel.class) return true;
        if (model.getClass() != MultipartBakedModel.class) return false;
        for (var selector : ((AgentMultipartModelAccess) model).gameharness$selectors()) {
            if (selector.model().getClass() != BasicBakedModel.class) return false;
        }
        // Weighted and custom Fabric models may depend on position/randomness/render context.
        return true;
    }

    private static final class OpticalModel {
        static final OpticalModel OPAQUE = new OpticalModel(new Surface[0]);
        final Surface[] surfaces;
        OpticalModel(Surface[] surfaces) { this.surfaces = surfaces; }

        double transmission(Vec3d start, Vec3d end, BlockPos pos, boolean cutout, AgentOpticalSight sight) {
            double transmission = 1;
            for (Surface surface : surfaces) {
                int alpha = surface.alpha(start, end, pos, sight);
                if (alpha < 0) continue;
                if (cutout && alpha != 0) return -1;
                transmission *= 1 - alpha / 255.0;
                if (transmission < MIN_TRANSMISSION) return -1;
            }
            return transmission;
        }
    }

    private static final class MaskCache {
        final Map<SpriteContents, AlphaMask> masks = new IdentityHashMap<>();
        int pixels;

        AlphaMask get(Sprite sprite) {
            if (sprite == null) return null;
            SpriteContents contents = sprite.getContents();
            if (masks.containsKey(contents)) return masks.get(contents);
            if (masks.size() >= MAX_SPRITES) return null;
            int width = contents.getWidth(), height = contents.getHeight();
            long count = (long) width * height;
            AlphaMask mask = null;
            if (width > 0 && height > 0 && count <= 65536 && pixels + count <= MAX_MASK_PIXELS) {
                mask = AlphaMask.read(contents);
                if (mask != null) pixels += (int) count;
            }
            masks.put(contents, mask);
            return mask;
        }
    }

    /**
     * A conservative alpha envelope of the *loaded* sprite: all animation frames,
     * loaded mip levels and neighboring filter taps. Native APIs do not expose the
     * current GPU animation interpolation/implicit LOD. A projected magnification
     * proof can select the mip-zero envelope instead. Unproven small holes may be
     * rejected, never fabricated. This is not a framebuffer/pixel-only claim.
     */
    private static final class AlphaMask {
        final int width, height, maximum;
        final byte[] alpha, magnifiedAlpha;
        AlphaMask(int width, int height, byte[] alpha, byte[] magnifiedAlpha, int maximum) {
            this.width = width;
            this.height = height;
            this.alpha = alpha;
            this.magnifiedAlpha = magnifiedAlpha;
            this.maximum = maximum;
        }

        static AlphaMask read(SpriteContents contents) {
            NativeImage[] images = ((AgentSpriteContentsAccess) contents).gameharness$images();
            if (images == null || images.length == 0 || images[0] == null) return null;
            int width = contents.getWidth(), height = contents.getHeight();
            // Vanilla's nonanimated getDistinctFrameCount() returns the count sentinel 1,
            // not a sheet index. Its one-frame image must be addressed at index zero.
            int[] frames = images[0].getWidth() == width && images[0].getHeight() == height
                ? new int[]{0} : contents.getDistinctFrameCount().toArray();
            if (frames.length == 0) return null;
            byte[] alpha = new byte[width * height];
            byte[] magnifiedAlpha = new byte[width * height];
            int maximum = 0;
            for (int level = 0; level < images.length; level++) {
                NativeImage image = images[level];
                if (image == null) return null;
                int frameWidth = Math.max(1, width >> level), frameHeight = Math.max(1, height >> level);
                int columns = image.getWidth() / frameWidth;
                if (columns == 0) return null;
                for (int frame : frames) {
                    int ox = frame % columns * frameWidth, oy = frame / columns * frameHeight;
                    if (frame < 0 || oy + frameHeight > image.getHeight()) return null;
                    for (int y = 0; y < height; y++) {
                        int py = Math.min(frameHeight - 1, y >> level);
                        for (int x = 0; x < width; x++) {
                            int px = Math.min(frameWidth - 1, x >> level);
                            if (level == 0) {
                                int index = y * width + x;
                                magnifiedAlpha[index] = (byte) Math.max(Byte.toUnsignedInt(magnifiedAlpha[index]),
                                    image.getColorArgb(ox + px, oy + py) >>> 24);
                            }
                            int value = 0;
                            // Include neighboring filter taps, clamped within this sprite/frame.
                            for (int dy = -1; dy <= 1; dy++) {
                                for (int dx = -1; dx <= 1; dx++) {
                                    int sx = ox + Math.max(0, Math.min(frameWidth - 1, px + dx));
                                    int sy = oy + Math.max(0, Math.min(frameHeight - 1, py + dy));
                                    value = Math.max(value, image.getColorArgb(sx, sy) >>> 24);
                                }
                            }
                            int index = y * width + x;
                            value = Math.max(value, Byte.toUnsignedInt(alpha[index]));
                            alpha[index] = (byte) value;
                            maximum = Math.max(maximum, value);
                        }
                    }
                }
            }
            return new AlphaMask(width, height, alpha, magnifiedAlpha, maximum);
        }

        int at(double u, double v, boolean magnified) {
            if (!Double.isFinite(u) || !Double.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return 255;
            int x = Math.min(width - 1, (int) (u * width));
            int y = Math.min(height - 1, (int) (v * height));
            return Byte.toUnsignedInt((magnified ? magnifiedAlpha : alpha)[y * width + x]);
        }
    }

    private static final class Surface {
        final Triangle first, second;
        Surface(Triangle first, Triangle second) { this.first = first; this.second = second; }

        static Surface decode(BakedQuad quad, AlphaMask mask) {
            int[] data = quad.getVertexData();
            if (data.length != 32) return null; // Vanilla POSITION_COLOR_TEXTURE_LIGHT_NORMAL layout.
            double[][] vertices = new double[4][5];
            Sprite sprite = quad.getSprite();
            for (int i = 0; i < 4; i++) {
                for (int axis = 0; axis < 3; axis++) {
                    double value = Float.intBitsToFloat(data[i * 8 + axis]);
                    if (!Double.isFinite(value) || value < 0 || value > 1) return null;
                    vertices[i][axis] = value;
                }
                vertices[i][3] = (Float.intBitsToFloat(data[i * 8 + 4]) - sprite.getMinU())
                    / (sprite.getMaxU() - sprite.getMinU());
                vertices[i][4] = (Float.intBitsToFloat(data[i * 8 + 5]) - sprite.getMinV())
                    / (sprite.getMaxV() - sprite.getMinV());
            }
            return new Surface(new Triangle(vertices[0], vertices[1], vertices[2], mask),
                new Triangle(vertices[0], vertices[2], vertices[3], mask));
        }

        int alpha(Vec3d start, Vec3d end, BlockPos pos, AgentOpticalSight sight) {
            int alpha = first.alpha(start, end, pos, sight);
            return alpha >= 0 ? alpha : second.alpha(start, end, pos, sight);
        }
    }

    private static final class Triangle {
        final double x, y, z, ax, ay, az, bx, by, bz, u, v, au, av, bu, bv;
        final AlphaMask mask;
        Triangle(double[] p, double[] a, double[] b, AlphaMask mask) {
            x = p[0]; y = p[1]; z = p[2]; u = p[3]; v = p[4];
            ax = a[0] - x; ay = a[1] - y; az = a[2] - z;
            bx = b[0] - x; by = b[1] - y; bz = b[2] - z;
            au = a[3] - u; av = a[4] - v; bu = b[3] - u; bv = b[4] - v;
            this.mask = mask;
        }

        int alpha(Vec3d start, Vec3d end, BlockPos pos, AgentOpticalSight sight) {
            double dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
            double px = dy * bz - dz * by, py = dz * bx - dx * bz, pz = dx * by - dy * bx;
            double det = ax * px + ay * py + az * pz;
            // These native block layers cull backfaces. Sampling a cube's unseen
            // rear-facing texture would incorrectly close a genuine front gap.
            if (det < 1e-10) return -1;
            double tx = start.x - pos.getX() - x, ty = start.y - pos.getY() - y;
            double tz = start.z - pos.getZ() - z;
            double a = (tx * px + ty * py + tz * pz) / det;
            if (a < -1e-7 || a > 1 + 1e-7) return -1;
            double qx = ty * az - tz * ay, qy = tz * ax - tx * az, qz = tx * ay - ty * ax;
            double b = (dx * qx + dy * qy + dz * qz) / det;
            if (b < -1e-7 || a + b > 1 + 1e-7) return -1;
            double t = (bx * qx + by * qy + bz * qz) / det;
            if (t < -1e-7 || t > 1 + 1e-7) return -1;
            double hitU = u + a * au + b * bu, hitV = v + a * av + b * bv;
            return mask.at(hitU, hitV, magnified(start, pos, a, b, hitU, hitV, sight));
        }

        /**
         * Projected perspective-correct UV derivatives, bounded over a two-pixel
         * neighborhood. At <= 1/4 texel/pixel the native NEAREST magnification
         * sampler provably uses mip zero; coarse mips cannot close a nearby hole.
         * Otherwise the all-mip envelope remains conservative.
         */
        private boolean magnified(Vec3d eye, BlockPos pos, double a, double b, double hitU, double hitV,
                                  AgentOpticalSight sight) {
            if (!sight.nearestMagnification || sight.viewportWidth <= 0 || sight.viewportHeight <= 0) return false;
            Matrix4f m = sight.projection;
            double rx = pos.getX() + x - eye.x, ry = pos.getY() + y - eye.y, rz = pos.getZ() + z - eye.z;
            double w0 = m.m03() * rx + m.m13() * ry + m.m23() * rz + m.m33();
            double wa = m.m03() * ax + m.m13() * ay + m.m23() * az;
            double wb = m.m03() * bx + m.m13() * by + m.m23() * bz;
            double w1 = w0 + wa, w2 = w0 + wb;
            if (w0 <= 0 || w1 <= 0 || w2 <= 0) return false;
            double cx = m.m00() * rx + m.m10() * ry + m.m20() * rz + m.m30();
            double cy = m.m01() * rx + m.m11() * ry + m.m21() * rz + m.m31();
            double sx0 = cx / w0 * sight.viewportWidth * 0.5;
            double sy0 = cy / w0 * sight.viewportHeight * 0.5;
            double sx1 = (cx + m.m00() * ax + m.m10() * ay + m.m20() * az) / w1
                * sight.viewportWidth * 0.5 - sx0;
            double sy1 = (cy + m.m01() * ax + m.m11() * ay + m.m21() * az) / w1
                * sight.viewportHeight * 0.5 - sy0;
            double sx2 = (cx + m.m00() * bx + m.m10() * by + m.m20() * bz) / w2
                * sight.viewportWidth * 0.5 - sx0;
            double sy2 = (cy + m.m01() * bx + m.m11() * by + m.m21() * bz) / w2
                * sight.viewportHeight * 0.5 - sy0;
            double determinant = sx1 * sy2 - sx2 * sy1;
            if (!Double.isFinite(determinant) || Math.abs(determinant) < 1e-8) return false;
            double q0 = 1 / w0, q1 = 1 / w1, q2 = 1 / w2;
            double qx = ((q1 - q0) * sy2 - (q2 - q0) * sy1) / determinant;
            double qy = (sx1 * (q2 - q0) - sx2 * (q1 - q0)) / determinant;
            double ux = (((u + au) * q1 - u * q0) * sy2
                - ((u + bu) * q2 - u * q0) * sy1) / determinant;
            double uy = (sx1 * ((u + bu) * q2 - u * q0)
                - sx2 * ((u + au) * q1 - u * q0)) / determinant;
            double vx = (((v + av) * q1 - v * q0) * sy2
                - ((v + bv) * q2 - v * q0) * sy1) / determinant;
            double vy = (sx1 * ((v + bv) * q2 - v * q0)
                - sx2 * ((v + av) * q1 - v * q0)) / determinant;
            double q = 1 / (w0 + a * wa + b * wb);
            double minQ = q - 2 * (Math.abs(qx) + Math.abs(qy));
            if (minQ <= 0) return false;
            double uvCross = 2 * Math.abs(ux * qy - uy * qx);
            double vvCross = 2 * Math.abs(vx * qy - vy * qx);
            double dux = (Math.abs((ux - hitU * qx) * q) + uvCross) / (minQ * minQ) * mask.width;
            double duy = (Math.abs((uy - hitU * qy) * q) + uvCross) / (minQ * minQ) * mask.width;
            double dvx = (Math.abs((vx - hitV * qx) * q) + vvCross) / (minQ * minQ) * mask.height;
            double dvy = (Math.abs((vy - hitV * qy) * q) + vvCross) / (minQ * minQ) * mask.height;
            return Math.max(dux * dux + dvx * dvx, duy * duy + dvy * dvy) <= 0.0625;
        }
    }
}
