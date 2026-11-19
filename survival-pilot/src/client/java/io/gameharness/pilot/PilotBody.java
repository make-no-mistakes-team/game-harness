package io.gameharness.pilot;

import java.util.Optional;
import java.util.function.Predicate;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderContext;
import net.minecraft.block.BlockState;
import net.minecraft.block.ShapeContext;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.effect.StatusEffects;
import net.minecraft.entity.mob.Monster;
import net.minecraft.fluid.FluidState;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.util.shape.VoxelShape;
import net.minecraft.util.shape.VoxelShapes;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;
import org.joml.Matrix4f;
import org.joml.Vector4f;

/** First-person observations and vanilla input, on the client thread only. */
final class PilotBody {
    private static final int COLUMNS = 13;
    private static final int ROWS = 9;
    private static final int RAY_BUDGET = 256;
    private static final double MAX_RANGE = 32;
    private static final double TURN_SPEED = 230;
    private static final double TURN_TIME = 0.085;

    private enum Ray {
        SIGHT(RaycastContext.ShapeType.OUTLINE, false),
        FLUIDS(RaycastContext.ShapeType.OUTLINE, true),
        TERRAIN(RaycastContext.ShapeType.COLLIDER, true);

        final RaycastContext.ShapeType shape;
        final boolean allFluids;

        Ray(RaycastContext.ShapeType shape, boolean allFluids) {
            this.shape = shape;
            this.allFluids = allFluids;
        }
    }

    private enum Ground { CLEAR, EDGE, LAVA }

    private final MinecraftClient client;
    private final Matrix4f viewProjection = new Matrix4f();
    private final Matrix4f inverseViewProjection = new Matrix4f();
    private final Vector4f clip = new Vector4f();
    private final BlockPos.Mutable lightPos = new BlockPos.Mutable();
    private final BlockHitResult[] samples = new BlockHitResult[COLUMNS * ROWS];

    private ClientWorld observedWorld;
    private ClientPlayerEntity observedPlayer;
    private int observedAtTick;
    private Vec3d eye;
    private HitResult renderedCrosshair;
    private HitResult tickCrosshair;
    private Vec3d aimPoint;
    private float aimYaw;
    private float aimPitch;
    private boolean steering;
    private long lastFrame;
    private int tick;
    private int raysLeft;
    private int sampleCount;
    private double sampleRange;
    private ShapeContext rayShapeContext;
    private boolean nightVision;

    private boolean forward;
    private boolean backward;
    private boolean fast;
    private boolean verifiedDescent;
    private boolean jumping;
    private boolean sneaking;
    private boolean eating;
    private boolean ownsKeys;
    private int lastStepJump = -10;
    private BlockPos mining;
    private BlockPos support;
    private Direction supportFace;
    private Entity striking;

    PilotBody(MinecraftClient client) {
        this.client = client;
    }

    void begin() {
        tick++;
        raysLeft = RAY_BUDGET;
        sampleCount = 0;
        sampleRange = 0;
        rayShapeContext = null;
        tickCrosshair = null;
        nightVision = client.player != null && client.player.hasStatusEffect(StatusEffects.NIGHT_VISION);
        resetIntentions();
    }

    private void resetIntentions() {
        forward = backward = fast = verifiedDescent = jumping = sneaking = eating = false;
        mining = support = null;
        supportFace = null;
        striking = null;
    }

    /** Called before GameRenderer computes this frame's camera and crosshair. */
    void frame() {
        long now = System.nanoTime();
        double dt = lastFrame == 0 ? 0 : Math.min((now - lastFrame) * 1e-9, 0.05);
        lastFrame = now;
        if (!steering || !ready() || dt <= 0) return;
        var player = client.player;
        Vec3d origin = player.getCameraPosVec(client.getRenderTickCounter().getTickDelta(true));
        double yaw = MathHelper.wrapDegrees(goalYaw(player, origin) - player.getYaw());
        double pitch = goalPitch(origin) - player.getPitch();
        double distance = Math.hypot(yaw, pitch);
        if (distance < 1e-4) return;
        double fraction = Math.min(-Math.expm1(-dt / TURN_TIME), TURN_SPEED * dt / distance);
        // This is the same pose update Mouse uses, including the previous render angles.
        player.changeLookDirection(yaw * fraction / 0.15, pitch * fraction / 0.15);
    }

    /** Called at WorldRenderEvents.START, when the actual render projection is available. */
    void observeFrame(WorldRenderContext context) {
        if (!ready() || context.camera().getFocusedEntity() != client.player) {
            clearView();
            return;
        }
        observedWorld = context.world();
        observedPlayer = client.player;
        observedAtTick = tick;
        eye = context.camera().getPos();
        renderedCrosshair = client.crosshairTarget;
        viewProjection.set(context.projectionMatrix()).mul(context.positionMatrix());
        inverseViewProjection.set(viewProjection).invert();
    }

    private void clearView() {
        observedWorld = null;
        observedPlayer = null;
        eye = null;
        renderedCrosshair = null;
    }

    void finish() {
        if (!ready()) {
            releaseKeys();
            return;
        }
        var player = client.player;
        var options = client.options;
        boolean advance = forward && (!steering
            || Math.abs(MathHelper.wrapDegrees(goalYaw(player, player.getEyePos()) - player.getYaw())) <= 28);
        boolean retreat = backward;
        boolean crouch = sneaking;
        boolean jump = jumping || player.isSubmergedInWater()
            || (advance || retreat) && (player.isTouchingWater() || player.isInLava());

        if (advance && player.isOnGround() && !player.isTouchingWater()) {
            Ground ground = terrainAhead(player);
            if (ground == Ground.LAVA) {
                advance = false;
            } else if (ground == Ground.EDGE) {
                crouch |= !verifiedDescent;
            } else if (!crouch && player.horizontalCollision && tick - lastStepJump >= 9) {
                // A collision is own-body feedback; no off-screen/headroom block reads.
                jump = true;
                lastStepJump = tick;
            }
        }

        boolean attack = false;
        boolean use = false;
        if (mining != null || support != null || striking != null || eating) {
            HitResult actual = currentCrosshair();
            if (support != null) {
                use = actual instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK
                    && hit.getBlockPos().equals(support) && hit.getSide() == supportFace;
            } else if (eating && player.getMainHandStack().contains(DataComponentTypes.FOOD)) {
                // Crouching skips ordinary block interaction; block items can still place.
                use = player.isUsingItem() || actual != null && actual.getType() == HitResult.Type.MISS
                    || actual instanceof BlockHitResult && player.isSneaking()
                        && !(player.getMainHandStack().getItem() instanceof BlockItem);
                crouch |= actual != null && actual.getType() == HitResult.Type.BLOCK;
            } else if (striking != null) {
                if (actual instanceof EntityHitResult hit && hit.getEntity() == striking
                        && striking.isAlive() && player.getAttackCooldownProgress(0.5f) >= 0.9f) {
                    pressAttack(options.attackKey);
                }
            } else if (actual instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK) {
                attack = hit.getBlockPos().equals(mining);
            }
        }
        ownsKeys = true;
        options.forwardKey.setPressed(advance);
        options.backKey.setPressed(retreat);
        options.jumpKey.setPressed(jump);
        setSticky(options.sneakKey, crouch, options.getSneakToggled().getValue());
        setSticky(options.sprintKey, advance && fast && !crouch, options.getSprintToggled().getValue());
        options.attackKey.setPressed(attack);
        // Held for this tick only unless requested again; vanilla enforces its use delay.
        options.useKey.setPressed(use);
    }

    private HitResult currentCrosshair() {
        if (tickCrosshair == null) {
            // START_CLIENT_TICK precedes vanilla's own refresh and input consumption.
            client.gameRenderer.updateCrosshairTarget(1);
            tickCrosshair = client.crosshairTarget;
        }
        return tickCrosshair;
    }

    boolean outlined(BlockPos pos) {
        return ready() && currentCrosshair() instanceof BlockHitResult hit
            && hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(pos);
    }

    /** Geometry under the actual vanilla crosshair; exposes no block identity in darkness. */
    BlockHitResult selectedFace() {
        return hasView() && renderedCrosshair instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK
            && currentCrosshair() instanceof BlockHitResult now && now.getType() == HitResult.Type.BLOCK
            && now.getBlockPos().equals(hit.getBlockPos()) && now.getSide() == hit.getSide() ? now : null;
    }

    void release() {
        resetIntentions();
        steering = false;
        aimPoint = null;
        lastFrame = 0;
        clearView();
        releaseKeys();
    }

    private void releaseKeys() {
        if (!ownsKeys) return;
        var options = client.options;
        options.forwardKey.setPressed(false);
        options.backKey.setPressed(false);
        options.jumpKey.setPressed(false);
        setSticky(options.sneakKey, false, options.getSneakToggled().getValue());
        setSticky(options.sprintKey, false, options.getSprintToggled().getValue());
        options.attackKey.setPressed(false);
        options.useKey.setPressed(false);
        ownsKeys = false;
    }

    private static void setSticky(KeyBinding key, boolean pressed, boolean toggle) {
        if (key.isPressed() != pressed) key.setPressed(toggle || pressed);
    }

    private void pressAttack(KeyBinding attack) {
        if (attack.isUnbound()) return;
        String binding = attack.getBoundKeyTranslationKey();
        // The vanilla pulse routes by physical binding, so never pulse an ambiguous binding.
        for (KeyBinding key : client.options.allKeys) {
            if (key != attack && binding.equals(key.getBoundKeyTranslationKey())) return;
        }
        KeyBinding.onKeyPressed(InputUtil.fromTranslationKey(binding));
    }

    void aim(Vec3d point) {
        aimPoint = point;
        steering = true;
    }

    void turn(float yaw, float pitch) {
        aimPoint = null;
        aimYaw = yaw;
        aimPitch = MathHelper.clamp(pitch, -90, 90);
        steering = true;
    }

    private float goalYaw(ClientPlayerEntity player, Vec3d origin) {
        if (aimPoint == null) return aimYaw;
        double x = aimPoint.x - origin.x;
        double z = aimPoint.z - origin.z;
        return Math.abs(x) + Math.abs(z) < 1e-6
            ? player.getYaw() : (float) Math.toDegrees(Math.atan2(-x, z));
    }

    private float goalPitch(Vec3d origin) {
        if (aimPoint == null) return aimPitch;
        return (float) Math.toDegrees(Math.atan2(origin.y - aimPoint.y,
            Math.hypot(aimPoint.x - origin.x, aimPoint.z - origin.z)));
    }

    boolean aligned(Vec3d point) {
        if (!ready()) return false;
        Vec3d delta = point.subtract(client.player.getEyePos());
        double length = delta.length();
        return length > 0 && delta.dotProduct(client.player.getRotationVec(1))
            >= length * 0.99905; // approximately 2.5 degrees
    }

    void walk(boolean sprint) {
        forward = true;
        backward = false;
        fast = sprint;
        verifiedDescent = false;
    }

    /** Progress has just seen safe support below this edge. The lava veto still applies. */
    void walkDown(boolean sprint) {
        walk(sprint);
        verifiedDescent = true;
    }

    void back() {
        backward = true;
        forward = false;
    }

    void jump() { jumping = true; }
    void sneak() { sneaking = true; }
    void holdUse() { eating = true; }
    void mine(BlockPos target) { mining = target; }
    void strike(Entity target) { striking = target; }

    void use(BlockPos target, Direction face) {
        support = target;
        supportFace = face;
    }

    Optional<BlockHitResult> find(Predicate<BlockState> matches, double distance) {
        if (!hasView()) return Optional.empty();
        double max = range(distance);
        if (!(max > 0)) return Optional.empty();
        if (renderedCrosshair instanceof BlockHitResult target && target.getType() == HitResult.Type.BLOCK
                && matchesHit(target, target.getBlockPos(), max)) {
            if (matches.test(client.world.getBlockState(target.getBlockPos()))) return Optional.of(target);
        }
        if (max > sampleRange && raysLeft > 0) sampleView(Math.min(range(MAX_RANGE), Math.max(max, 12)));
        BlockHitResult best = null;
        double bestDistance = max * max;
        for (int i = 0; i < sampleCount; i++) {
            BlockHitResult hit = samples[i];
            if (hit == null) continue;
            double d = hit.getPos().squaredDistanceTo(eye);
            if (d <= bestDistance && matches.test(client.world.getBlockState(hit.getBlockPos()))) {
                best = hit;
                bestDistance = d;
            }
        }
        return Optional.ofNullable(best);
    }

    /** Pick a face from the current view, not a square found by probing the surrounding world. */
    BlockHitResult stationFace(BlockPos rejected) {
        if (!hasView()) return null;
        if (sampleCount == 0) sampleView(4.25);
        BlockHitResult best = null;
        double cost = Double.POSITIVE_INFINITY;
        var player = client.player;
        for (int i = -1; i < sampleCount; i++) {
            var hit = i < 0 ? selectedFace() : samples[i];
            if (hit == null || hit.getSide() == Direction.DOWN) continue;
            var dest = hit.getBlockPos().offset(hit.getSide());
            int dy = dest.getY() - player.getBlockY();
            if (dy < -1 || dy > 1 || dest.equals(rejected) || player.getBoundingBox().intersects(new Box(dest))) continue;
            double d = eye.squaredDistanceTo(hit.getPos());
            if (d > 4.15 * 4.15) continue;
            if (i >= 0) {
                var state = client.world.getBlockState(hit.getBlockPos());
                if (state.isReplaceable() || !state.getFluidState().isEmpty()) continue;
            }
            double score = d + (hit.getSide() == Direction.UP ? 0 : 3) + Math.abs(dy) * 2;
            if (score < cost) { cost = score; best = hit; }
        }
        return best;
    }

    private void sampleView(double distance) {
        for (int y = 0; y < ROWS && raysLeft > 0; y++) {
            for (int x = 0; x < COLUMNS && raysLeft > 0; x++) {
                int i = y * COLUMNS + x;
                if (i < sampleCount && samples[i] != null) continue;
                // Four interleaved, deterministic grids improve coverage of thin targets.
                float u = 1.9f * ((x + ((tick & 1) == 0 ? 0.24f : 0.76f)) / COLUMNS - 0.5f);
                float v = 1.9f * ((y + ((tick & 2) == 0 ? 0.24f : 0.76f)) / ROWS - 0.5f);
                inverseViewProjection.transform(clip.set(u, v, 0.9f, 1));
                double xRay = clip.x / (double) clip.w;
                double yRay = clip.y / (double) clip.w;
                double zRay = clip.z / (double) clip.w;
                double scale = distance / Math.sqrt(xRay * xRay + yRay * yRay + zRay * zRay);
                Vec3d end = eye.add(xRay * scale, yRay * scale, zRay * scale);
                samples[i] = inView(end) ? visibleHit(end, Ray.SIGHT) : null;
                if (i == sampleCount) sampleCount++;
            }
        }
        sampleRange = distance;
    }

    Optional<BlockHitResult> perceive(Vec3d point, double distance) {
        return probe(point, distance, Ray.FLUIDS);
    }

    /** A lit floor or fluid surface; no result means unknown, not proven empty. */
    Optional<BlockHitResult> terrain(Vec3d point, double distance) {
        return probe(point, distance, Ray.TERRAIN);
    }

    private Optional<BlockHitResult> probe(Vec3d point, double distance, Ray ray) {
        if (!hasView()) return Optional.empty();
        double max = range(distance);
        if (!(max > 0)) return Optional.empty();
        double x = point.x - eye.x;
        double y = point.y - eye.y;
        double z = point.z - eye.z;
        double lengthSquared = x * x + y * y + z * z;
        if (lengthSquared < 1e-12) return Optional.empty();
        double scale = max / Math.sqrt(lengthSquared);
        Vec3d end = eye.add(x * scale, y * scale, z * scale);
        return inView(end) ? Optional.ofNullable(visibleHit(end, ray)) : Optional.empty();
    }

    boolean sees(BlockPos pos) {
        if (!hasView()) return false;
        Vec3d center = Vec3d.ofCenter(pos);
        double max = range(MAX_RANGE);
        return seesPoint(pos, center, max) || seesPoint(pos, center.add(0, 0.35, 0), max)
            || seesPoint(pos, center.add(0, -0.35, 0), max);
    }

    private boolean seesPoint(BlockPos pos, Vec3d point, double max) {
        if (!inView(point) || point.squaredDistanceTo(eye) > max * max) {
            return false;
        }
        BlockHitResult hit = visibleHit(point, Ray.FLUIDS);
        return hit != null && hit.getBlockPos().equals(pos);
    }

    private boolean matchesHit(BlockHitResult target, BlockPos pos, double range) {
        Vec3d delta = target.getPos().subtract(eye);
        if (delta.lengthSquared() > range * range || !inView(target.getPos())) return false;
        BlockHitResult hit = visibleHit(target.getPos().add(delta.normalize().multiply(0.025)), Ray.SIGHT);
        return hit != null && hit.getBlockPos().equals(pos);
    }

    Optional<LivingEntity> threat(double distance) {
        return visibleEntity(LivingEntity.class, entity -> entity instanceof Monster, distance);
    }

    Optional<ItemEntity> dropped(Predicate<ItemStack> matches, double distance) {
        return visibleEntity(ItemEntity.class, entity -> matches.test(entity.getStack()), distance);
    }

    Optional<Entity> visibleEntity(Predicate<Entity> matches, double distance) {
        return visibleEntity(Entity.class, matches, distance);
    }

    private <T extends Entity> Optional<T> visibleEntity(Class<T> type, Predicate<T> matches, double distance) {
        if (!hasView()) return Optional.empty();
        double max = range(distance);
        if (!(max > 0)) return Optional.empty();
        double bestDistance = max * max;
        T best = null;
        Box area = new Box(eye.x - max, eye.y - max, eye.z - max, eye.x + max, eye.y + max, eye.z + max);
        for (T candidate : client.world.getEntitiesByClass(type, area,
                entity -> entity != client.player && entity.isAlive() && !entity.isInvisibleTo(client.player))) {
            if (raysLeft <= 0) break;
            Vec3d center = candidate.getBoundingBox().getCenter();
            double d = center.squaredDistanceTo(eye);
            if (d > bestDistance) continue;
            double margin = candidate.getHeight() * 0.32;
            if ((clearPoint(center) || clearPoint(center.add(0, margin, 0))
                    || clearPoint(center.add(0, -margin, 0))) && matches.test(candidate)) {
                best = candidate;
                bestDistance = d;
            }
        }
        return Optional.ofNullable(best);
    }

    private boolean clearPoint(Vec3d point) {
        if (raysLeft <= 0 || !inView(point)) return false;
        raysLeft--;
        return raycast(point, Ray.SIGHT).getType() == HitResult.Type.MISS
            && lit(point.x, point.y, point.z);
    }

    private BlockHitResult visibleHit(Vec3d end, Ray ray) {
        if (raysLeft <= 0) return null;
        raysLeft--;
        BlockHitResult hit = raycast(end, ray);
        return hit.getType() == HitResult.Type.BLOCK && inView(hit.getPos()) && litFace(hit) ? hit : null;
    }

    private BlockHitResult raycast(Vec3d end, Ray ray) {
        if (rayShapeContext == null) rayShapeContext = ShapeContext.of(client.player);
        if (ray.allFluids) {
            return client.world.raycast(new RaycastContext(eye, end, ray.shape,
                RaycastContext.FluidHandling.ANY, rayShapeContext));
        }
        // Water is transparent; lava is not. Stop within the same vanilla ray traversal.
        return client.world.raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE,
                RaycastContext.FluidHandling.NONE, rayShapeContext) {
            @Override
            public VoxelShape getFluidShape(FluidState state, BlockView world, BlockPos pos) {
                return state.isIn(FluidTags.LAVA) ? state.getShape(world, pos) : VoxelShapes.empty();
            }
        });
    }

    private boolean inView(Vec3d point) {
        viewProjection.transform(clip.set(
            (float) (point.x - eye.x), (float) (point.y - eye.y), (float) (point.z - eye.z), 1));
        return clip.w > 0 && Math.abs(clip.x) <= clip.w && Math.abs(clip.y) <= clip.w
            && Math.abs(clip.z) <= clip.w;
    }

    private boolean litFace(BlockHitResult hit) {
        Vec3d point = hit.getPos();
        Direction side = hit.getSide();
        // The open side is where the visible surface samples light, not the block behind it.
        return lit(point.x + 0.02 * side.getOffsetX(), point.y + 0.02 * side.getOffsetY(),
            point.z + 0.02 * side.getOffsetZ());
    }

    private boolean lit(double x, double y, double z) {
        return nightVision || client.world.getLightLevel(lightPos.set(x, y, z)) > 0;
    }

    private Ground terrainAhead(ClientPlayerEntity player) {
        if (!hasView()) return Ground.CLEAR;
        double yaw = Math.toRadians(player.getYaw());
        double x = -Math.sin(yaw);
        double z = Math.cos(yaw);
        double y = player.getY();
        // Restrict the ledge/shore probes to points actually inside the rendered field.
        Vec3d near = new Vec3d(player.getX() + 1.25 * x, y - 1.55, player.getZ() + 1.25 * z);
        Vec3d far = new Vec3d(player.getX() + 2.65 * x, y - 0.38, player.getZ() + 2.65 * z);
        if (inView(far)) {
            BlockHitResult hit = raycast(far, Ray.TERRAIN);
            if (visibleLava(hit, y)) return Ground.LAVA;
        }
        if (inView(near)) {
            BlockHitResult hit = raycast(near, Ray.TERRAIN);
            if (visibleLava(hit, y)) return Ground.LAVA;
            if (hit.getType() == HitResult.Type.MISS || !inView(hit.getPos()) || !litFace(hit)) {
                return Ground.EDGE;
            }
        }
        return Ground.CLEAR;
    }

    private boolean visibleLava(BlockHitResult hit, double feetY) {
        return hit.getType() == HitResult.Type.BLOCK && hit.getPos().y >= feetY - 0.85
            && inView(hit.getPos()) && litFace(hit)
            && client.world.getBlockState(hit.getBlockPos()).getFluidState().isIn(FluidTags.LAVA);
    }

    private double range(double requested) {
        double max = client.player.isSubmergedInWater() ? 8 : MAX_RANGE;
        return Math.min(requested, max);
    }

    private boolean hasView() {
        return ready() && observedWorld == client.world && observedPlayer == client.player
            && tick - observedAtTick <= 1;
    }

    private boolean ready() {
        return client.world != null && client.player != null && client.player.isAlive()
            && client.currentScreen == null && !client.isPaused() && client.getCameraEntity() == client.player
            && client.options.getPerspective().isFirstPerson();
    }
}
