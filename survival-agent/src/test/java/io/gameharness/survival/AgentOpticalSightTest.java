package io.gameharness.survival;

import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ShapeContext;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.client.render.RenderLayers;
import net.minecraft.client.render.model.BakedModel;
import net.minecraft.client.render.model.BakedQuad;
import net.minecraft.client.render.model.BasicBakedModel;
import net.minecraft.client.render.model.MultipartBakedModel;
import net.minecraft.client.render.model.WeightedBakedModel;
import net.minecraft.client.render.model.json.ModelTransformation;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.texture.Sprite;
import net.minecraft.client.texture.SpriteContents;
import net.minecraft.client.texture.SpriteDimensions;
import net.minecraft.fluid.FluidState;
import net.minecraft.resource.metadata.ResourceMetadata;
import net.minecraft.util.Identifier;
import net.minecraft.util.collection.DataPool;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;
import org.joml.Matrix4f;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class AgentOpticalSightTest {
    private static final BlockPos FOREGROUND = new BlockPos(1, 64, 0);
    private static final BlockPos TARGET = new BlockPos(4, 64, 0);
    private static final ShapeContext SHAPE = ShapeContext.absent();
    private final List<SpriteContents> contents = new ArrayList<>();

    @BeforeAll static void bootstrap() {
        VanillaTestResources.initialize();
        RenderLayers.setFancyGraphicsOrBetter(true);
    }

    @AfterEach void release() {
        contents.forEach(SpriteContents::close);
        RenderLayers.setFancyGraphicsOrBetter(true);
    }

    @Test void opaqueWallsStopOpticalTraversalBeforeHiddenResources() {
        var assets = new Assets();
        assets.models.put(Blocks.GLASS.getDefaultState(), cube(solid(0)));
        var sight = sight(assets);
        var world = world(Blocks.STONE.getDefaultState());
        assertEquals(FOREGROUND, optical(sight, world, 0.5, 0.5).getBlockPos());
        assertFalse(world.queried.contains(TARGET), "opaque wall must stop actual world traversal");
        assertTrue(world.queried.stream().allMatch(pos -> pos.getY() == 64 && pos.getZ() == 0),
            "only the actual ray cells may be read, not neighboring hidden blocks");
    }

    @Test void glassPermitsOpticalSightButNeitherVanillaOutlineNorCollisionPasses() {
        var assets = new Assets();
        assets.models.put(Blocks.GLASS.getDefaultState(), cube(solid(0)));
        var sight = sight(assets);
        var world = world(Blocks.GLASS.getDefaultState());
        assertEquals(TARGET, optical(sight, world, 0.5, 0.5).getBlockPos());
        assertEquals(FOREGROUND, physical(world, RaycastContext.ShapeType.OUTLINE).getBlockPos(),
            "mining/item-use remains the vanilla first hit");
        assertEquals(FOREGROUND, physical(world, RaycastContext.ShapeType.COLLIDER).getBlockPos(),
            "a seen target does not imply a walkable crossing");
    }

    @Test void opaqueResourcePackGlassDoesNotBecomeAnXrayWindow() {
        var assets = new Assets();
        assets.models.put(Blocks.GLASS.getDefaultState(), cube(solid(255)));
        assertEquals(FOREGROUND, optical(sight(assets), world(Blocks.GLASS.getDefaultState()), 0.5, 0.5)
            .getBlockPos());
    }

    @Test void vanillaGlassAndStainedGlassTexturesSupplyTheOpticalEvidence() throws IOException {
        Sprite glass = vanilla("glass", 0), stained = vanilla("red_stained_glass", 0);
        int[] gap = pixel(glass.getContents(), true);
        var assets = new Assets();
        assets.models.put(Blocks.GLASS.getDefaultState(), cube(glass));
        assets.models.put(Blocks.RED_STAINED_GLASS.getDefaultState(), cube(stained));
        var sight = sight(assets);
        assertEquals(TARGET, optical(sight, world(Blocks.GLASS.getDefaultState()),
            uv(gap[1], glass.getContents().getHeight()), uv(gap[0], glass.getContents().getWidth())).getBlockPos());
        assertEquals(TARGET, optical(sight, world(Blocks.RED_STAINED_GLASS.getDefaultState()), 0.5, 0.5).getBlockPos());
    }

    @Test void stainedGlassUsesLoadedPartialAlphaAndAccumulatesFiniteTransmission() {
        BlockState glass = Blocks.RED_STAINED_GLASS.getDefaultState();
        var assets = new Assets();
        assets.models.put(glass, cube(solid(160)));
        var sight = sight(assets);
        assertEquals(TARGET, optical(sight, world(glass), 0.5, 0.5).getBlockPos());
        Map<BlockPos, BlockState> blocks = new LinkedHashMap<>();
        for (int x = 1; x <= 4; x++) blocks.put(new BlockPos(x, 64, 0), glass);
        blocks.put(new BlockPos(6, 64, 0), Blocks.STONE.getDefaultState());
        var world = new Corridor(blocks);
        assertEquals(new BlockPos(3, 64, 0), sight.raycast(world, eye(0.5, 0.5),
            new Vec3d(7, 64.5, 0.5), SHAPE).getBlockPos());
        assertFalse(world.queried.contains(new BlockPos(6, 64, 0)), "too many tinted layers are not observed");
    }

    @Test void multipartPaneGeometryUsesSpriteAlphaWithoutRemovingItsPhysicalShape() {
        BlockState pane = Blocks.GLASS_PANE.getDefaultState();
        Sprite sprite = solid(0);
        BakedModel center = model(sprite, List.of(plane(sprite, 0.4375), plane(sprite, 0.5625)));
        var assets = new Assets();
        assets.models.put(pane, new MultipartBakedModel(List.of(new MultipartBakedModel.Selector(s -> true, center))));
        var sight = sight(assets);
        var world = world(pane);
        assertEquals(TARGET, optical(sight, world, 0.5, 0.5).getBlockPos());
        assertEquals(FOREGROUND, physical(world, RaycastContext.ShapeType.OUTLINE).getBlockPos());
        assertEquals(FOREGROUND, physical(world, RaycastContext.ShapeType.COLLIDER).getBlockPos());
    }

    @Test void actualVanillaLeafCutoutWorksNearbyEvenWithItsOpaqueCoarsestMip() throws IOException {
        Sprite leaves = vanilla("oak_leaves", 4);
        SpriteContents texture = leaves.getContents();
        int[] hole = pixel(texture, true), opaque = pixel(texture, false);
        var assets = new Assets();
        assets.models.put(Blocks.OAK_LEAVES.getDefaultState(), cube(leaves));
        var sight = sight(assets);
        var world = world(Blocks.OAK_LEAVES.getDefaultState());
        RenderLayers.setFancyGraphicsOrBetter(true);
        assertEquals(TARGET, optical(sight, world, uv(hole[1], texture.getHeight()), uv(hole[0], texture.getWidth()))
            .getBlockPos(), "magnified vanilla mip-zero cutout must not be erased by the coarsest mip");
        assertEquals(FOREGROUND, optical(sight, world, uv(opaque[1], texture.getHeight()),
            uv(opaque[0], texture.getWidth())).getBlockPos(), "an opaque leaf texel is not a gap");
    }

    @Test void fastLeavesAndUnprovenMinifiedPixelsRemainOpaqueWithoutRebuildingAssets() throws IOException {
        Sprite leaves = vanilla("oak_leaves", 4);
        int[] hole = pixel(leaves.getContents(), true);
        double y = uv(hole[1], leaves.getContents().getHeight());
        double z = uv(hole[0], leaves.getContents().getWidth());
        var assets = new Assets();
        assets.models.put(Blocks.OAK_LEAVES.getDefaultState(), cube(leaves));
        var sight = sight(assets);
        var world = world(Blocks.OAK_LEAVES.getDefaultState());
        RenderLayers.setFancyGraphicsOrBetter(false);
        assertEquals(FOREGROUND, optical(sight, world, y, z).getBlockPos());
        RenderLayers.setFancyGraphicsOrBetter(true);
        assertEquals(TARGET, optical(sight, world, y, z).getBlockPos(), "active graphics mode, not cached block names");
        sight.prepare(projection(), 8, 8);
        assertEquals(FOREGROUND, optical(sight, world, y, z).getBlockPos(),
            "unproven mip-zero/LOD must not treat a tiny distant-looking gap as visible");
        sight.prepare(projection(), 1920, 1080);
        assets.nearest = false;
        sight.prepare();
        assertEquals(FOREGROUND, optical(sight, world, y, z).getBlockPos(),
            "unknown/non-native filtering disables the nearest-magnification proof");
    }

    @Test void everyLeafLayerMustHaveAGapOnTheSameRay() {
        Sprite clear = solid(0), opaque = solid(255);
        BlockState first = Blocks.OAK_LEAVES.getDefaultState(), second = Blocks.BIRCH_LEAVES.getDefaultState();
        var assets = new Assets();
        assets.models.put(first, cube(clear));
        assets.models.put(second, cube(opaque));
        var sight = sight(assets);
        var world = new Corridor(Map.of(FOREGROUND, first, FOREGROUND.east(), second,
            TARGET, Blocks.STONE.getDefaultState()));
        assertEquals(FOREGROUND.east(), optical(sight, world, 0.5, 0.5).getBlockPos());
        assets.models.put(second, cube(clear));
        assets.generation = new Object();
        sight.prepare();
        assertEquals(TARGET, optical(sight, world, 0.5, 0.5).getBlockPos());
    }

    @Test void animatedCutoutsNeedARealGapInEveryPossibleLoadedFrame() throws IOException {
        NativeImage image = new NativeImage(16, 32, false);
        image.fillRect(0, 0, 16, 32, 0x00ffffff);
        image.setColorArgb(8, 24, 0xffffffff); // Same pixel is open in frame zero but opaque in frame one.
        ResourceMetadata metadata = ResourceMetadata.create(new ByteArrayInputStream(
            "{\"animation\":{\"frametime\":1,\"frames\":[0,1],\"interpolate\":true}}"
                .getBytes(StandardCharsets.UTF_8)));
        SpriteContents value = new SpriteContents(Identifier.of("gameharness", "animated"),
            new SpriteDimensions(16, 16), image, metadata);
        contents.add(value);
        var assets = new Assets();
        assets.models.put(Blocks.OAK_LEAVES.getDefaultState(), cube(new TestSprite(value)));
        var sight = sight(assets);
        var world = world(Blocks.OAK_LEAVES.getDefaultState());
        assertEquals(FOREGROUND, optical(sight, world, uv(8, 16), uv(8, 16)).getBlockPos(),
            "unknown active animation phase cannot borrow a hole from just one frame");
        assertEquals(TARGET, optical(sight, world, uv(3, 16), uv(3, 16)).getBlockPos(),
            "phase-independent real holes remain usable");
    }

    @Test void reloadReplacesAlphaMasksButRaysNeverReadOrDecodeImages() {
        BlockState glass = Blocks.GLASS.getDefaultState();
        var assets = new Assets();
        assets.models.put(glass, cube(solid(0)));
        var sight = sight(assets);
        var world = world(glass);
        int reads = assets.modelReads;
        assets.models.put(glass, cube(solid(255)));
        sight.prepare();
        assertEquals(TARGET, optical(sight, world, 0.5, 0.5).getBlockPos(),
            "without an applied reload the previously loaded assets remain authoritative");
        assertEquals(reads, assets.modelReads);
        assets.generation = new Object();
        sight.prepare();
        assertEquals(FOREGROUND, optical(sight, world, 0.5, 0.5).getBlockPos());
        assertTrue(assets.modelReads > reads);
        reads = assets.modelReads;
        for (int i = 0; i < 12; i++) optical(sight, world, 0.5, 0.5);
        assertEquals(reads, assets.modelReads, "no model lookup/cache fill may occur per ray");
    }

    @Test void opticalRaysUsePreparedMasksEvenAfterTheirNativeSourceImagesAreClosed() {
        var assets = new Assets();
        assets.models.put(Blocks.GLASS.getDefaultState(), cube(solid(0)));
        var sight = sight(assets);
        contents.forEach(SpriteContents::close);
        contents.clear();
        assertEquals(TARGET, optical(sight, world(Blocks.GLASS.getDefaultState()), 0.5, 0.5).getBlockPos(),
            "ray traversal must never read NativeImages or decode textures");
    }

    @Test void zeroAlphaLayersStillHaveABoundedTraversalBudget() {
        BlockState glass = Blocks.GLASS.getDefaultState();
        var assets = new Assets();
        assets.models.put(glass, cube(solid(0)));
        var sight = sight(assets);
        Map<BlockPos, BlockState> blocks = new LinkedHashMap<>();
        for (int x = 1; x <= AgentOpticalSight.MAX_LAYERS + 2; x++) blocks.put(new BlockPos(x, 64, 0), glass);
        var world = new Corridor(blocks);
        assertEquals(new BlockPos(AgentOpticalSight.MAX_LAYERS + 1, 64, 0),
            sight.raycast(world, eye(0.5, 0.5), new Vec3d(20, 64.5, 0.5), SHAPE).getBlockPos());
    }

    @Test void waterUsesLoadedOpacityAndLavaAlwaysStopsSight() {
        var assets = new Assets();
        assets.water = solid(96);
        var sight = sight(assets);
        assertEquals(TARGET, optical(sight, world(Blocks.WATER.getDefaultState()), 0.5, 0.5).getBlockPos());
        assertEquals(FOREGROUND, optical(sight, world(Blocks.LAVA.getDefaultState()), 0.5, 0.5).getBlockPos());
        Map<BlockPos, BlockState> water = new LinkedHashMap<>();
        for (int x = 1; x <= 7; x++) water.put(new BlockPos(x, 64, 0), Blocks.WATER.getDefaultState());
        assertEquals(new BlockPos(6, 64, 0), sight.raycast(new Corridor(water), eye(0.5, 0.5),
            new Vec3d(10, 64.5, 0.5), SHAPE).getBlockPos(), "water opacity also accumulates along actual cells");
        assets.water = solid(255);
        assets.generation = new Object();
        sight.prepare();
        assertEquals(FOREGROUND, optical(sight, world(Blocks.WATER.getDefaultState()), 0.5, 0.5).getBlockPos());
    }

    @Test void unknownWeightedRenderGeometryDoesNotGrantTransparency() {
        var assets = new Assets();
        BakedModel cube = cube(solid(0));
        assets.models.put(Blocks.OAK_LEAVES.getDefaultState(),
            new WeightedBakedModel(DataPool.<BakedModel>builder().add(cube, 1).build()));
        assertEquals(FOREGROUND, optical(sight(assets), world(Blocks.OAK_LEAVES.getDefaultState()), 0.5, 0.5)
            .getBlockPos());
    }

    private AgentOpticalSight sight(Assets assets) {
        AgentOpticalSight sight = new AgentOpticalSight(assets);
        sight.prepare(projection(), 1920, 1080);
        return sight;
    }

    private static Matrix4f projection() {
        return new Matrix4f().perspective((float) Math.toRadians(70), 1920f / 1080, 0.05f, 128)
            .lookAt(0, 0, 0, 1, 0, 0, 0, 1, 0);
    }

    private static double uv(int pixel, int size) { return (pixel + 0.5) / size; }
    private static Vec3d eye(double y, double z) { return new Vec3d(0.5, 64 + y, z); }

    private static BlockHitResult optical(AgentOpticalSight sight, Corridor world, double y, double z) {
        return sight.raycast(world, eye(y, z), new Vec3d(5, 64 + y, z), SHAPE);
    }

    private static BlockHitResult physical(Corridor world, RaycastContext.ShapeType shape) {
        return world.raycast(new RaycastContext(eye(0.5, 0.5), new Vec3d(5, 64.5, 0.5),
            shape, RaycastContext.FluidHandling.NONE, SHAPE));
    }

    private static Corridor world(BlockState foreground) {
        return new Corridor(Map.of(FOREGROUND, foreground, TARGET, Blocks.STONE.getDefaultState()));
    }

    private Sprite solid(int alpha) {
        NativeImage image = new NativeImage(16, 16, false);
        image.fillRect(0, 0, 16, 16, alpha << 24 | 0x00ffffff);
        return sprite(image, 0, "test");
    }

    private Sprite vanilla(String name, int mips) throws IOException {
        try (InputStream input = getClass().getResourceAsStream("/assets/minecraft/textures/block/" + name + ".png")) {
            if (input == null) throw new IOException("Missing vanilla texture " + name);
            return sprite(NativeImage.read(input), mips, name);
        }
    }

    private Sprite sprite(NativeImage image, int mips, String name) {
        SpriteContents value = new SpriteContents(Identifier.of("gameharness", name),
            new SpriteDimensions(image.getWidth(), image.getHeight()), image, ResourceMetadata.NONE);
        value.generateMipmaps(mips);
        contents.add(value);
        return new TestSprite(value);
    }

    private static int[] pixel(SpriteContents contents, boolean transparent) {
        for (int y = 0; y < contents.getHeight(); y++) {
            for (int x = 0; x < contents.getWidth(); x++) {
                if (contents.isPixelTransparent(0, x, y) == transparent) return new int[]{x, y};
            }
        }
        throw new AssertionError("Vanilla leaf fixture has no " + (transparent ? "cutout" : "opaque") + " texel");
    }

    private static BakedModel cube(Sprite sprite) {
        return model(sprite, List.of(plane(sprite, 0), plane(sprite, 1, true)));
    }

    private static BakedModel model(Sprite sprite, List<BakedQuad> quads) {
        Map<Direction, List<BakedQuad>> faces = new EnumMap<>(Direction.class);
        for (Direction direction : Direction.values()) faces.put(direction, List.of());
        return new BasicBakedModel(quads, faces, false, false, false, sprite, ModelTransformation.NONE);
    }

    private static BakedQuad plane(Sprite sprite, double x) {
        return plane(sprite, x, false);
    }

    private static BakedQuad plane(Sprite sprite, double x, boolean east) {
        int[] data = new int[32];
        double[][] points = east
            ? new double[][]{{x, 0, 0, 0, 0}, {x, 1, 0, 0, 1}, {x, 1, 1, 1, 1}, {x, 0, 1, 1, 0}}
            : new double[][]{{x, 0, 0, 0, 0}, {x, 0, 1, 1, 0}, {x, 1, 1, 1, 1}, {x, 1, 0, 0, 1}};
        for (int i = 0; i < 4; i++) {
            for (int axis = 0; axis < 3; axis++) data[i * 8 + axis] = Float.floatToRawIntBits((float) points[i][axis]);
            data[i * 8 + 4] = Float.floatToRawIntBits(sprite.getFrameU((float) points[i][3]));
            data[i * 8 + 5] = Float.floatToRawIntBits(sprite.getFrameV((float) points[i][4]));
        }
        return new BakedQuad(data, -1, east ? Direction.EAST : Direction.WEST, sprite, false, 0);
    }

    private static final class TestSprite extends Sprite {
        TestSprite(SpriteContents contents) {
            super(Identifier.ofVanilla("textures/atlas/blocks.png"), contents,
                contents.getWidth(), contents.getHeight(), 0, 0);
        }
    }

    private static final class Assets implements AgentOpticalSight.Assets {
        Object generation = new Object();
        final Map<BlockState, BakedModel> models = new LinkedHashMap<>();
        Sprite water;
        int modelReads;
        boolean nearest = true;
        @Override public Object generation() { return generation; }
        @Override public Iterable<BlockState> states() { return models.keySet(); }
        @Override public BakedModel model(BlockState state) { modelReads++; return models.get(state); }
        @Override public Sprite waterStill() { return water; }
        @Override public Sprite waterFlow() { return water; }
        @Override public boolean nearestMagnification() { return nearest; }
    }

    private static final class Corridor implements BlockView {
        final Map<BlockPos, BlockState> blocks;
        final Set<BlockPos> queried = new HashSet<>();
        Corridor(Map<BlockPos, BlockState> blocks) { this.blocks = blocks; }
        @Override public BlockState getBlockState(BlockPos pos) {
            queried.add(pos.toImmutable());
            return blocks.getOrDefault(pos, Blocks.AIR.getDefaultState());
        }
        @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
        @Override public BlockEntity getBlockEntity(BlockPos pos) { return null; }
        @Override public int getHeight() { return 384; }
        @Override public int getBottomY() { return -64; }
    }
}
