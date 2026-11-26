package io.gameharness.survival;

import io.gameharness.survival.mixin.AgentKeyboardAccess;
import io.gameharness.survival.mixin.AgentMiningAccess;
import java.util.concurrent.ThreadLocalRandom;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.block.LeavesBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.Window;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.AxeItem;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.item.PickaxeItem;
import net.minecraft.item.ShovelItem;
import net.minecraft.item.SwordItem;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

import static org.lwjgl.glfw.GLFW.GLFW_KEY_F;
import static org.lwjgl.glfw.GLFW.GLFW_PRESS;
import static org.lwjgl.glfw.GLFW.GLFW_RELEASE;
import static org.lwjgl.glfw.GLFW.glfwGetKeyScancode;

/**
 * Human-like 60fps camera steering, continuous 360-degree locomotion,
 * off-center face aiming, early-strike mining overlap, and hotbar tool selection.
 */
final class Motor {
    static final double REACH = 4.35;
    static final double REACH_SQ = REACH * REACH;

    enum LookMode { NORMAL, FINE, COMBAT, SCAN }

    private final MinecraftClient client;
    private final long seed = ThreadLocalRandom.current().nextLong();

    // Smooth angular velocity state (deg/s) carried across frames and gestures
    private boolean hasAimTarget;
    private float targetYaw;
    private float targetPitch;
    private LookMode lookMode = LookMode.NORMAL;
    private double yawRate;
    private double pitchRate;
    private double gestureEffort = 1.0;
    private double gestureArcSign = 1.0;
    private double gestureArcMag = 0.0;
    private double gestureInitialDist = 0.0;
    private long gestureSeq;
    private long lastFrameNs;

    // Stable off-center aim cache per block so crosshair never jitters left-right
    private BlockPos cachedAimBlock;
    private Direction cachedAimFace;
    private Vec3d cachedAimPoint;

    // Desired per-tick controls
    private boolean wantForward;
    private boolean wantBack;
    private boolean wantLeft;
    private boolean wantRight;
    private boolean wantJump;
    private boolean wantSprint;
    private boolean wantSneak;
    private boolean wantAttack;
    private boolean wantUse;

    // Telemetry
    private boolean holdingMining;
    private int attackCooldownTicks;
    private int useCooldownTicks;
    private int jumpCooldownTicks;
    private int swapCooldownTicks;
    private double totalYawTravel;
    private double totalPitchTravel;

    Motor(MinecraftClient client) {
        this.client = client;
    }

    /** Called at the start of every client tick before setting new desires. */
    void beginTick() {
        wantForward = false;
        wantBack = false;
        wantLeft = false;
        wantRight = false;
        wantJump = false;
        wantSprint = false;
        wantSneak = false;
        wantAttack = false;
        wantUse = false;
        holdingMining = false;
        if (attackCooldownTicks > 0) attackCooldownTicks--;
        if (useCooldownTicks > 0) useCooldownTicks--;
        if (jumpCooldownTicks > 0) jumpCooldownTicks--;
        if (swapCooldownTicks > 0) swapCooldownTicks--;
    }

    /** Called at the end of every client tick to push controls to vanilla KeyBindings. */
    void applyKeys() {
        if (client.currentScreen != null) {
            releaseKeys();
            return;
        }
        var opts = client.options;
        opts.forwardKey.setPressed(wantForward);
        opts.backKey.setPressed(wantBack);
        opts.leftKey.setPressed(wantLeft);
        opts.rightKey.setPressed(wantRight);
        opts.jumpKey.setPressed(wantJump);
        opts.sprintKey.setPressed(wantSprint && wantForward);
        opts.sneakKey.setPressed(wantSneak);
        opts.attackKey.setPressed(wantAttack);
        opts.useKey.setPressed(wantUse);
    }

    void releaseKeys() {
        var opts = client.options;
        if (opts == null) return;
        opts.forwardKey.setPressed(false);
        opts.backKey.setPressed(false);
        opts.leftKey.setPressed(false);
        opts.rightKey.setPressed(false);
        opts.jumpKey.setPressed(false);
        opts.sprintKey.setPressed(false);
        opts.sneakKey.setPressed(false);
        opts.attackKey.setPressed(false);
        opts.useKey.setPressed(false);
        wantForward = wantBack = wantLeft = wantRight = wantJump = wantSprint = wantSneak = wantAttack = wantUse = false;
        holdingMining = false;
    }

    void clearAim() {
        hasAimTarget = false;
        yawRate *= 0.5;
        pitchRate *= 0.5;
    }

    /** Set a smooth camera goal in degrees. */
    void lookAtAngles(float yaw, float pitch, LookMode mode) {
        pitch = MathHelper.clamp(pitch, -89.5f, 89.5f);
        if (!hasAimTarget || mode != lookMode || angleDist(yaw, pitch, targetYaw, targetPitch) > 4.0) {
            var player = client.player;
            if (player != null) {
                double dist = angleDist(yaw, pitch, player.getYaw(), player.getPitch());
                if (!hasAimTarget || dist > 8.0) {
                    beginGesture(dist, mode);
                }
            }
        }
        targetYaw = yaw;
        targetPitch = pitch;
        lookMode = mode;
        hasAimTarget = true;
    }

    /** Smoothly look at a 3D world point. */
    void lookAtPoint(Vec3d point, LookMode mode) {
        var player = client.player;
        if (player == null || point == null) return;
        Vec3d eye = player.getEyePos();
        double dx = point.x - eye.x;
        double dy = point.y - eye.y;
        double dz = point.z - eye.z;
        double horiz = Math.hypot(dx, dz);
        float yaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        float pitch = (float) -Math.toDegrees(Math.atan2(dy, Math.max(1e-6, horiz)));
        lookAtAngles(yaw, pitch, mode);
    }

    /**
     * Per-render-frame smooth human-like camera controller.
     * Uses velocity-carrying bounded acceleration/braking, natural effort variation,
     * and subtle perpendicular arc curvature so camera movement feels organic, never robotic.
     */
    void steerFrame() {
        long now = System.nanoTime();
        if (lastFrameNs == 0) {
            lastFrameNs = now;
            return;
        }
        double dt = Math.min(0.05, Math.max(0.001, (now - lastFrameNs) * 1e-9));
        lastFrameNs = now;

        var player = client.player;
        if (player == null || client.currentScreen != null || !hasAimTarget) {
            yawRate *= Math.max(0.0, 1.0 - dt * 14.0);
            pitchRate *= Math.max(0.0, 1.0 - dt * 14.0);
            return;
        }

        float curYaw = player.getYaw();
        float curPitch = player.getPitch();
        double dy = MathHelper.wrapDegrees(targetYaw - curYaw);
        double dp = targetPitch - curPitch;
        double dist = Math.hypot(dy, dp);

        if (dist < 0.08 && Math.hypot(yawRate, pitchRate) < 1.5) {
            yawRate = 0;
            pitchRate = 0;
            return;
        }

        double maxSpeed;
        double accel;
        double brake;
        double nearGain;
        switch (lookMode) {
            case COMBAT -> {
                maxSpeed = 540.0 * gestureEffort;
                accel = 4200.0 * gestureEffort;
                brake = 3600.0 * gestureEffort;
                nearGain = 20.0;
            }
            case FINE -> {
                maxSpeed = 280.0 * gestureEffort;
                accel = 2400.0 * gestureEffort;
                brake = 2200.0 * gestureEffort;
                nearGain = 14.0;
            }
            case SCAN -> {
                maxSpeed = 210.0 * gestureEffort;
                accel = 1600.0 * gestureEffort;
                brake = 1500.0 * gestureEffort;
                nearGain = 11.0;
            }
            default -> {
                maxSpeed = 380.0 * gestureEffort;
                accel = 3100.0 * gestureEffort;
                brake = 2700.0 * gestureEffort;
                nearGain = 16.0;
            }
        }

        // Subtle organic perpendicular arc mid-turn (fades smoothly to 0 near target)
        double dirY = dist > 1e-6 ? dy / dist : 0;
        double dirP = dist > 1e-6 ? dp / dist : 0;
        if (gestureInitialDist > 18.0 && dist > 6.0 && lookMode != LookMode.FINE) {
            double progress = MathHelper.clamp(1.0 - dist / gestureInitialDist, 0.0, 1.0);
            double bell = Math.sin(progress * Math.PI);
            double perp = gestureArcSign * gestureArcMag * bell;
            double nx = dirY - dirP * perp;
            double np = dirP + dirY * perp;
            double nLen = Math.hypot(nx, np);
            if (nLen > 1e-6) {
                dirY = nx / nLen;
                dirP = np / nLen;
            }
        }

        // Braking envelope prevents overshoot while keeping smooth human deceleration
        double react = brake * dt;
        double stopSpeed = Math.sqrt(react * react + 2.0 * brake * dist) - react;
        double desiredSpeed = Math.min(maxSpeed, Math.min(dist * nearGain, stopSpeed));

        double desiredYawRate = dirY * desiredSpeed;
        double desiredPitchRate = dirP * desiredSpeed;

        double dYawRate = desiredYawRate - yawRate;
        double dPitchRate = desiredPitchRate - pitchRate;
        double deltaMag = Math.hypot(dYawRate, dPitchRate);
        double along = (yawRate * dy + pitchRate * dp) / Math.max(1e-6, dist);
        double rateLimit = (along < 0 || desiredSpeed < Math.hypot(yawRate, pitchRate)) ? brake : accel;
        double stepFrac = deltaMag > 1e-6 ? Math.min(1.0, (rateLimit * dt) / deltaMag) : 1.0;

        double nextYawRate = yawRate + dYawRate * stepFrac;
        double nextPitchRate = pitchRate + dPitchRate * stepFrac;

        double dYaw = 0.5 * (yawRate + nextYawRate) * dt;
        double dPitch = 0.5 * (pitchRate + nextPitchRate) * dt;

        // Clamp final step so we don't overshoot on tiny remaining distances
        if (Math.abs(dYaw) > Math.abs(dy) && Math.signum(dYaw) == Math.signum(dy) && dist < 3.0) {
            dYaw = dy;
            nextYawRate = 0;
        }
        if (Math.abs(dPitch) > Math.abs(dp) && Math.signum(dPitch) == Math.signum(dp) && dist < 3.0) {
            dPitch = dp;
            nextPitchRate = 0;
        }

        // Apply through vanilla's exact sensitivity/cursor scale via changeLookDirection
        // changeLookDirection multiplies inputs by 0.15 deg per unit
        player.changeLookDirection(dYaw / 0.15, dPitch / 0.15);

        yawRate = nextYawRate;
        pitchRate = nextPitchRate;
        totalYawTravel += Math.abs(dYaw);
        totalPitchTravel += Math.abs(dPitch);
    }

    private void beginGesture(double dist, LookMode mode) {
        gestureSeq++;
        gestureInitialDist = dist;
        long h = mix(seed + gestureSeq * 0x9e3779b97f4a7c15L);
        double u1 = ((h >>> 11) & ((1L << 53) - 1)) * 0x1.0p-53;
        long h2 = mix(h ^ 0xbf58476d1ce4e5b9L);
        double u2 = ((h2 >>> 11) & ((1L << 53) - 1)) * 0x1.0p-53;
        // Natural human effort variation: brisk or relaxed without ever crawling
        double requested = 0.78 + 0.36 * u1;
        gestureEffort = 0.4 * gestureEffort + 0.6 * requested;
        gestureArcSign = (h2 & 1L) == 0 ? 1.0 : -1.0;
        gestureArcMag = (mode == LookMode.COMBAT ? 0.04 : 0.11) * (0.3 + 0.7 * u2);
    }

    private static long mix(long v) {
        v = (v ^ (v >>> 30)) * 0xbf58476d1ce4e5b9L;
        v = (v ^ (v >>> 27)) * 0x94d049bb133111ebL;
        return v ^ (v >>> 31);
    }

    static double angleDist(float yaw1, float pitch1, float yaw2, float pitch2) {
        return Math.hypot(MathHelper.wrapDegrees(yaw1 - yaw2), pitch1 - pitch2);
    }

    double currentAimErrorDeg() {
        var player = client.player;
        if (player == null || !hasAimTarget) return 0;
        return angleDist(player.getYaw(), player.getPitch(), targetYaw, targetPitch);
    }

    /**
     * Continuous 360-degree movement toward a world XZ target.
     * Supports arbitrary bearings using smooth forward/back/strafe keys (never restricted to 90-deg turns).
     */
    void moveToward(Vec3d target, boolean sprint, boolean jump, boolean sneak, boolean steerLook) {
        var player = client.player;
        if (player == null || target == null) return;
        double dx = target.x - player.getX();
        double dz = target.z - player.getZ();
        double horiz = Math.hypot(dx, dz);
        if (horiz < 0.05) {
            wantJump = jump;
            wantSneak = sneak;
            return;
        }

        float desiredYaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        if (steerLook) {
            double dy = target.y - player.getY();
            float desiredPitch = (float) MathHelper.clamp(-Math.toDegrees(Math.atan2(dy, Math.max(1.5, horiz))) * 0.55 + 6.0, -35.0, 42.0);
            lookAtAngles(desiredYaw, desiredPitch, LookMode.NORMAL);
        }

        // Convert world bearing into player-relative forward/strafe input
        double relRad = Math.toRadians(MathHelper.wrapDegrees(desiredYaw - player.getYaw()));
        double fwd = Math.cos(relRad);
        double side = Math.sin(relRad); // positive = right in Minecraft yaw coords

        wantForward = fwd > 0.25;
        wantBack = fwd < -0.35;
        wantRight = side > 0.32;
        wantLeft = side < -0.32;
        // Never cancel forward+back or left+right
        if (wantForward && wantBack) { wantForward = false; wantBack = false; }
        if (wantLeft && wantRight) { wantLeft = false; wantRight = false; }

        wantSneak = sneak;
        wantSprint = sprint && wantForward && !sneak && !wantBack && player.getHungerManager().getFoodLevel() > 6 && !player.horizontalCollision;

        if (jump && canJumpNow(player)) {
            wantJump = true;
            if (player.isOnGround()) jumpCooldownTicks = 2;
        } else if (player.isTouchingWater() && (jump || player.getY() < target.y + 0.1)) {
            wantJump = true; // swim upward
        }
    }

    /** Strafe/retreat away from a point while keeping camera on a separate target (great for combat!). */
    void moveRelativeToYaw(double worldDx, double worldDz, boolean sprint, boolean jump) {
        var player = client.player;
        if (player == null) return;
        double len = Math.hypot(worldDx, worldDz);
        if (len < 1e-4) return;
        float desiredYaw = (float) (Math.toDegrees(Math.atan2(worldDz, worldDx)) - 90.0);
        double relRad = Math.toRadians(MathHelper.wrapDegrees(desiredYaw - player.getYaw()));
        double fwd = Math.cos(relRad);
        double side = Math.sin(relRad);
        wantForward = fwd > 0.25;
        wantBack = fwd < -0.25;
        wantRight = side > 0.28;
        wantLeft = side < -0.28;
        wantSprint = sprint && wantForward && !wantBack && player.getHungerManager().getFoodLevel() > 6;
        wantJump = jump && (canJumpNow(player) || player.isTouchingWater());
    }

    private boolean canJumpNow(ClientPlayerEntity player) {
        return player.isTouchingWater() || (player.isOnGround() && jumpCooldownTicks <= 0);
    }

    void requestJump() { wantJump = true; }
    void requestSneak() { wantSneak = true; }
    void requestHoldUse() { wantUse = true; }

    /** Direct boat steering controls (boats turn via left/right keys and row via forward/back). */
    void steerBoat(boolean forward, boolean back, boolean left, boolean right) {
        wantForward = forward;
        wantBack = back;
        wantLeft = left;
        wantRight = right;
        wantSprint = false;
        wantJump = false;
        wantSneak = false;
    }

    /**
     * Find a natural, reachable, off-center point on a visible face of `pos`.
     * Uses raycasting so we only aim at genuinely visible faces, never dead-center unless required.
     */
    Vec3d findAimPoint(BlockPos pos) {
        var player = client.player;
        var world = client.world;
        if (player == null || world == null || pos == null) return null;

        Vec3d eye = player.getEyePos();
        // Reuse cached point if still visible and within reach (prevents aim jitter!)
        if (pos.equals(cachedAimBlock) && cachedAimPoint != null && eye.squaredDistanceTo(cachedAimPoint) <= REACH_SQ) {
            if (rayHitsBlock(world, player, eye, cachedAimPoint, pos)) {
                return cachedAimPoint;
            }
        }

        // Deterministic slight off-center offset per block (0.28..0.72 range)
        long h = mix(pos.asLong() ^ seed);
        double uOff = 0.30 + 0.40 * (((h >>> 8) & 0xFF) / 255.0);
        double vOff = 0.30 + 0.40 * (((h >>> 16) & 0xFF) / 255.0);

        Vec3d center = Vec3d.ofCenter(pos);
        // Sort candidate faces by dot product toward player eye
        Direction[] faces = Direction.values();
        Vec3d bestPoint = null;
        Direction bestFace = null;
        double bestScore = Double.POSITIVE_INFINITY;

        for (Direction face : faces) {
            Vec3d normal = Vec3d.of(face.getVector());
            // Face should generally face the eye
            double facing = normal.dotProduct(eye.subtract(center));
            if (facing < -0.35) continue;

            // Try natural off-center point first, then slightly inset center
            double[][] candidates = {
                {uOff, vOff},
                {0.5, 0.5},
                {0.22, 0.5}, {0.78, 0.5}, {0.5, 0.22}, {0.5, 0.78}
            };
            for (double[] uv : candidates) {
                Vec3d pt = pointOnFace(pos, face, uv[0], uv[1]);
                double dSq = eye.squaredDistanceTo(pt);
                if (dSq > REACH_SQ) continue;
                if (rayHitsBlock(world, player, eye, pt, pos)) {
                    double score = dSq + (uv[0] == 0.5 && uv[1] == 0.5 ? 0.25 : 0.0);
                    if (score < bestScore) {
                        bestScore = score;
                        bestPoint = pt;
                        bestFace = face;
                    }
                    break; // found a good point on this face
                }
            }
        }

        if (bestPoint != null) {
            cachedAimBlock = pos.toImmutable();
            cachedAimFace = bestFace;
            cachedAimPoint = bestPoint;
        }
        return bestPoint;
    }

    /** Find a visible face point on a support block to place a new block at `placePos`. */
    record PlacementHit(BlockPos support, Direction face, Vec3d point) {}

    PlacementHit findPlacementHit(BlockPos placePos) {
        return findPlacementHit(placePos, false);
    }

    PlacementHit findPlacementHit(BlockPos placePos, boolean nonSolid) {
        var player = client.player;
        var world = client.world;
        if (player == null || world == null) return null;
        Vec3d eye = player.getEyePos();

        // Check if player body overlaps placePos (non-solid blocks like torches CAN be placed at player feet!)
        if (!nonSolid) {
            Box blockBox = new Box(placePos);
            if (player.getBoundingBox().intersects(blockBox)) return null;
        }

        // Prefer placing against bottom (top face of block below), then horizontal neighbors, then top
        Direction[] order = {Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP};
        for (Direction dir : order) {
            BlockPos support = placePos.offset(dir);
            BlockState st = world.getBlockState(support);
            if (st.isAir() || !st.getFluidState().isEmpty() || st.isReplaceable()) continue;
            Direction clickFace = dir.getOpposite();
            double[][] uvs = {
                {0.46, 0.54}, {0.5, 0.5}, {0.5, 0.80}, {0.32, 0.62}, {0.68, 0.38},
                {0.5, 0.22}, {0.2, 0.2}, {0.8, 0.8}, {0.5, 0.15}, {0.5, 0.85}
            };
            for (double[] uv : uvs) {
                Vec3d pt = pointOnFace(support, clickFace, uv[0], uv[1]);
                if (eye.squaredDistanceTo(pt) > REACH_SQ) continue;
                BlockHitResult hit = raycastBlock(world, player, eye, pt);
                if (hit.getType() == HitResult.Type.BLOCK
                        && hit.getBlockPos().equals(support)
                        && hit.getSide() == clickFace) {
                    return new PlacementHit(support, clickFace, pt);
                }
            }
        }
        return null;
    }

    private static Vec3d pointOnFace(BlockPos pos, Direction face, double u, double v) {
        double x = pos.getX();
        double y = pos.getY();
        double z = pos.getZ();
        double eps = 0.01;
        return switch (face) {
            case DOWN -> new Vec3d(x + u, y + eps, z + v);
            case UP -> new Vec3d(x + u, y + 1.0 - eps, z + v);
            case NORTH -> new Vec3d(x + u, y + v, z + eps);
            case SOUTH -> new Vec3d(x + u, y + v, z + 1.0 - eps);
            case WEST -> new Vec3d(x + eps, y + v, z + u);
            case EAST -> new Vec3d(x + 1.0 - eps, y + v, z + u);
        };
    }

    private static BlockHitResult raycastBlock(ClientWorld world, ClientPlayerEntity player, Vec3d eye, Vec3d point) {
        Vec3d dir = point.subtract(eye);
        Vec3d end = eye.add(dir.multiply(1.03));
        return world.raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
    }

    private static boolean rayHitsBlock(ClientWorld world, ClientPlayerEntity player, Vec3d eye, Vec3d point, BlockPos target) {
        BlockHitResult hit = raycastBlock(world, player, eye, point);
        return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target);
    }

    /**
     * Smoothly aim at and mine a block with early-strike overlap:
     * begins holding attack as soon as the live crosshair touches the target block
     * (or an obstructing leaf/foliage directly in front of it), even before camera settles!
     * Returns true if the block is already air/broken.
     */
    boolean mineBlock(BlockPos pos, boolean allowClearMask) {
        return mineBlock(pos, allowClearMask, false);
    }

    boolean mineBlock(BlockPos pos, boolean allowClearMask, boolean allowDigObstructor) {
        var player = client.player;
        var world = client.world;
        if (player == null || world == null) return false;
        BlockState state = world.getBlockState(pos);
        if (state.isAir() || !state.getFluidState().isEmpty()) {
            cachedAimBlock = null;
            return true;
        }

        Vec3d aim = findAimPoint(pos);
        boolean occluded = (aim == null);
        if (aim == null) {
            aim = Vec3d.ofCenter(pos);
        }
        lookAtPoint(aim, LookMode.NORMAL);

        // Check live crosshair for early-strike overlap!
        HitResult ch = client.crosshairTarget;
        if (ch instanceof BlockHitResult bhr && bhr.getType() == HitResult.Type.BLOCK) {
            BlockPos hitPos = bhr.getBlockPos();
            BlockState hitState = world.getBlockState(hitPos);
            if (hitPos.equals(pos)) {
                selectBestToolFor(state);
                wantAttack = true;
                holdingMining = true;
            } else if (allowClearMask && isClearableMask(hitState)) {
                selectBestToolFor(hitState);
                wantAttack = true;
                holdingMining = true;
            } else if (allowDigObstructor && occluded && isSafeObstructorToDig(hitState)) {
                selectBestToolFor(hitState);
                wantAttack = true;
                holdingMining = true;
            } else {
                selectBestToolFor(state);
            }
        } else {
            selectBestToolFor(state);
        }
        return false;
    }

    private static boolean isSafeObstructorToDig(BlockState state) {
        if (state.isAir() || !state.getFluidState().isEmpty()) return false;
        if (Perception.isHazardBlock(state) || Perception.isUnbreakable(state)) return false;
        if (state.isOf(Blocks.CRAFTING_TABLE) || state.isOf(Blocks.FURNACE) || state.isOf(Blocks.OBSIDIAN)) return false;
        return state.getHardness(null, BlockPos.ORIGIN) <= 5.0f;
    }

    static boolean isClearableMask(BlockState state) {
        return state.getBlock() instanceof LeavesBlock
            || state.isReplaceable()
            || state.isOf(Blocks.SNOW)
            || state.isOf(Blocks.VINE)
            || state.isOf(Blocks.COBWEB);
    }

    /**
     * Place a block from the currently selected hotbar slot at `placePos`.
     * Returns true once the block is placed (or placePos is already solid).
     */
    boolean placeBlockAt(BlockPos placePos, int hotbarSlot) {
        var player = client.player;
        var world = client.world;
        if (player == null || world == null) return false;
        BlockState existing = world.getBlockState(placePos);
        if (!existing.isAir() && !existing.isReplaceable()) return true;
        if (hotbarSlot < 0 || hotbarSlot > 8) return false;

        player.getInventory().selectedSlot = hotbarSlot;
        boolean nonSolid = player.getInventory().getStack(hotbarSlot).isOf(Items.TORCH);
        PlacementHit hit = findPlacementHit(placePos, nonSolid);
        if (hit == null) return false;

        lookAtPoint(hit.point(), LookMode.FINE);
        HitResult ch = client.crosshairTarget;
        if (ch instanceof BlockHitResult bhr
                && bhr.getType() == HitResult.Type.BLOCK
                && bhr.getBlockPos().equals(hit.support())
                && bhr.getSide() == hit.face()
                && useCooldownTicks <= 0) {
            if (client.interactionManager != null) {
                var res = client.interactionManager.interactBlock(player, Hand.MAIN_HAND, bhr);
                if (res.isAccepted()) {
                    player.swingHand(Hand.MAIN_HAND);
                    useCooldownTicks = 3;
                    return true;
                }
            }
        }
        return false;
    }

    /** Place a block from `hotbarSlot` directly against an explicit visible support face point. */
    boolean placeBlockAgainst(BlockPos support, Direction face, Vec3d aimPoint, int hotbarSlot) {
        var player = client.player;
        var world = client.world;
        if (player == null || world == null || support == null || face == null || aimPoint == null) return false;
        if (hotbarSlot < 0 || hotbarSlot > 8) return false;

        player.getInventory().selectedSlot = hotbarSlot;
        lookAtPoint(aimPoint, LookMode.FINE);
        HitResult ch = client.crosshairTarget;
        if (ch instanceof BlockHitResult bhr
                && bhr.getType() == HitResult.Type.BLOCK
                && bhr.getBlockPos().equals(support)
                && bhr.getSide() == face
                && useCooldownTicks <= 0) {
            if (client.interactionManager != null) {
                var res = client.interactionManager.interactBlock(player, Hand.MAIN_HAND, bhr);
                if (res.isAccepted()) {
                    player.swingHand(Hand.MAIN_HAND);
                    useCooldownTicks = 3;
                    return true;
                }
            }
        }
        return false;
    }

    /** Right-click an interactive block (crafting table, furnace, door, etc.). */
    boolean interactBlock(BlockPos pos) {
        var player = client.player;
        var world = client.world;
        if (player == null || world == null) return false;
        Vec3d aim = findAimPoint(pos);
        if (aim == null) return false;
        lookAtPoint(aim, LookMode.FINE);
        HitResult ch = client.crosshairTarget;
        if (ch instanceof BlockHitResult bhr
                && bhr.getType() == HitResult.Type.BLOCK
                && bhr.getBlockPos().equals(pos)
                && useCooldownTicks <= 0) {
            if (client.interactionManager != null) {
                var res = client.interactionManager.interactBlock(player, Hand.MAIN_HAND, bhr);
                if (res.isAccepted()) {
                    player.swingHand(Hand.MAIN_HAND);
                    useCooldownTicks = 5;
                    return true;
                }
            }
        }
        return false;
    }

    /** Smoothly aim at and attack an entity when weapon cooldown is ready. */
    boolean attackEntity(Entity target) {
        return attackEntity(target, 0.90f);
    }

    /** Smoothly aim at and attack an entity using bounding-box-accurate aiming (tracks low hitboxes like baby zombies!). */
    boolean attackEntity(Entity target, float minCooldown) {
        var player = client.player;
        if (player == null || target == null || !target.isAlive()) return false;
        Vec3d aim = entityAimPoint(target);
        lookAtPoint(aim, LookMode.COMBAT);

        double boxDist = distanceToBox(player.getEyePos(), target.getBoundingBox());
        if (boxDist > 3.15) return false;

        // Attack when cooldown >= minCooldown (full damage!) and crosshair/angle is on target
        if (!wantUse && player.getAttackCooldownProgress(0.5f) >= minCooldown && attackCooldownTicks <= 0) {
            HitResult ch = client.crosshairTarget;
            boolean directHit = ch instanceof EntityHitResult ehr && ehr.getEntity() == target;
            if (directHit || (currentAimErrorDeg() < 16.0 && boxDist <= 2.98)) {
                if (client.interactionManager != null) {
                    client.interactionManager.attackEntity(player, target);
                    player.swingHand(Hand.MAIN_HAND);
                    attackCooldownTicks = 4;
                    return true;
                }
            }
        }
        return false;
    }

    /** Aim at exact bounding-box center for small/low mobs (baby zombies, spiders), upper center for tall mobs. */
    static Vec3d entityAimPoint(Entity target) {
        Box box = target.getBoundingBox();
        Vec3d center = box.getCenter();
        if (target.getHeight() < 1.15f) {
            return center;
        }
        return center.add(0, target.getHeight() * 0.10, 0);
    }

    /** Exact Euclidean distance from point `p` to the nearest point on axis-aligned box `b`. */
    static double distanceToBox(Vec3d p, Box b) {
        double dx = Math.max(b.minX - p.x, Math.max(0.0, p.x - b.maxX));
        double dy = Math.max(b.minY - p.y, Math.max(0.0, p.y - b.maxY));
        double dz = Math.max(b.minZ - p.z, Math.max(0.0, p.z - b.maxZ));
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /** Trigger vanilla swap-hands key (F) to move a hotbar shield cleanly into the offhand. */
    boolean swapHands() {
        if (client.currentScreen != null || swapCooldownTicks > 0) return false;
        Window win = client.getWindow();
        int scan = glfwGetKeyScancode(GLFW_KEY_F);
        ((AgentKeyboardAccess) client.keyboard).agent$onKey(win.getHandle(), GLFW_KEY_F, scan, GLFW_PRESS, 0);
        ((AgentKeyboardAccess) client.keyboard).agent$onKey(win.getHandle(), GLFW_KEY_F, scan, GLFW_RELEASE, 0);
        swapCooldownTicks = 12;
        return true;
    }

    int findHotbarShield() {
        return findHotbarItem(Items.SHIELD);
    }

    static boolean hasShieldEquipped(ClientPlayerEntity player) {
        return player != null && (player.getOffHandStack().isOf(Items.SHIELD) || player.getMainHandStack().isOf(Items.SHIELD));
    }

    static boolean isShieldReady(ClientPlayerEntity player) {
        if (player == null) return false;
        ItemStack shield = player.getOffHandStack().isOf(Items.SHIELD) ? player.getOffHandStack()
            : (player.getMainHandStack().isOf(Items.SHIELD) ? player.getMainHandStack() : ItemStack.EMPTY);
        if (shield.isEmpty()) return false;
        return !player.getItemCooldownManager().isCoolingDown(shield);
    }

    /**
     * Select a main-hand slot that will NOT consume/place on right-click, so holding useKey
     * unambiguously raises an offhand shield! Prefers best melee weapon.
     */
    boolean selectShieldFriendlyMainHand() {
        var player = client.player;
        if (player == null) return false;
        if (player.getMainHandStack().isOf(Items.SHIELD)) return true;
        selectBestWeapon();
        ItemStack cur = player.getMainHandStack();
        if (isShieldFriendlyMainHand(cur)) return true;
        for (int i = 0; i < 9; i++) {
            if (isShieldFriendlyMainHand(player.getInventory().getStack(i))) {
                player.getInventory().selectedSlot = i;
                return true;
            }
        }
        return false;
    }

    private static boolean isShieldFriendlyMainHand(ItemStack st) {
        if (st.isEmpty()) return true;
        Item item = st.getItem();
        if (item instanceof SwordItem || item instanceof AxeItem || item instanceof PickaxeItem || item instanceof ShovelItem) {
            return true;
        }
        if (item == Items.SHIELD) return true;
        if (st.get(DataComponentTypes.FOOD) != null) return false;
        if (item instanceof BlockItem) return false;
        return item != Items.WATER_BUCKET && item != Items.LAVA_BUCKET && item != Items.BUCKET
            && item != Items.FLINT_AND_STEEL && item != Items.BOW && item != Items.CROSSBOW;
    }

    /** Find best non-falling solid building block in hotbar for emergency shelter walls/roof. */
    int findHotbarShelterBlock() {
        int scaf = findHotbarScaffold();
        if (scaf >= 0) return scaf;
        var player = client.player;
        if (player == null) return -1;
        for (int i = 0; i < 9; i++) {
            if (isShelterBlock(player.getInventory().getStack(i))) return i;
        }
        return -1;
    }

    static boolean isShelterBlock(ItemStack st) {
        if (st.isEmpty() || !(st.getItem() instanceof BlockItem bi)) return false;
        Block b = bi.getBlock();
        if (b instanceof FallingBlock) return false; // never sand/gravel for overhead shelter caps!
        if (b == Blocks.CRAFTING_TABLE || b == Blocks.FURNACE || b == Blocks.CHEST || b == Blocks.TNT) return false;
        BlockState def = b.getDefaultState();
        return def.blocksMovement() && def.isFullCube(net.minecraft.world.EmptyBlockView.INSTANCE, BlockPos.ORIGIN);
    }

    static int countShelterBlocks(ClientPlayerEntity player) {
        if (player == null) return 0;
        int total = 0;
        var inv = player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            ItemStack st = inv.getStack(i);
            if (isShelterBlock(st)) total += st.getCount();
        }
        return total;
    }

    static boolean hasDigTool(ClientPlayerEntity player) {
        if (player == null) return false;
        var inv = player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            Item item = inv.getStack(i).getItem();
            if (item instanceof PickaxeItem || item instanceof ShovelItem) return true;
        }
        return false;
    }

    static double bestHotbarWeaponScore(ClientPlayerEntity player) {
        if (player == null) return 1.0;
        double best = 1.0;
        for (int i = 0; i < 9; i++) {
            best = Math.max(best, weaponScore(player.getInventory().getStack(i)));
        }
        return best;
    }

    static String bestHotbarWeaponName(ClientPlayerEntity player) {
        if (player == null) return "hand";
        int bestSlot = -1;
        double best = 1.0;
        for (int i = 0; i < 9; i++) {
            double s = weaponScore(player.getInventory().getStack(i));
            if (s > best) {
                best = s;
                bestSlot = i;
            }
        }
        if (bestSlot < 0) return "hand";
        return net.minecraft.registry.Registries.ITEM.getId(player.getInventory().getStack(bestSlot).getItem()).getPath();
    }

    /** Equip the fastest suitable tool in hotbar (0..8) for breaking `state`. */
    void selectBestToolFor(BlockState state) {
        var player = client.player;
        if (player == null) return;
        PlayerInventory inv = player.getInventory();
        int bestSlot = inv.selectedSlot;
        float bestScore = toolScore(inv.getStack(bestSlot), state);

        for (int i = 0; i < 9; i++) {
            float s = toolScore(inv.getStack(i), state);
            if (s > bestScore + 0.05f) {
                bestScore = s;
                bestSlot = i;
            }
        }
        inv.selectedSlot = bestSlot;
    }

    static float toolScore(ItemStack stack, BlockState state) {
        float speed = stack.getMiningSpeedMultiplier(state);
        boolean suitable = !state.isToolRequired() || stack.isSuitableFor(state);
        if (!suitable) return 0.1f;
        // Prefer empty hand / non-tool for trivial instant-break blocks to save tool durability
        if (state.getHardness(null, BlockPos.ORIGIN) == 0.0f) {
            return stack.isEmpty() ? 2.0f : (stack.isDamageable() ? 0.5f : 1.5f);
        }
        // Prefer the matching tool type; conserve iron/diamond pickaxes on stone-tier rock when carrying a stone pickaxe!
        if (state.isIn(BlockTags.PICKAXE_MINEABLE)) {
            if (stack.getItem() instanceof PickaxeItem) {
                boolean stoneTierRock = state.isOf(Blocks.STONE) || state.isOf(Blocks.COBBLESTONE)
                    || state.isOf(Blocks.DEEPSLATE) || state.isOf(Blocks.COBBLED_DEEPSLATE)
                    || state.isOf(Blocks.ANDESITE) || state.isOf(Blocks.DIORITE)
                    || state.isOf(Blocks.GRANITE) || state.isOf(Blocks.TUFF)
                    || state.isOf(Blocks.DRIPSTONE_BLOCK) || state.isOf(Blocks.CALCITE)
                    || state.isOf(Blocks.SMOOTH_BASALT) || state.isOf(Blocks.BASALT)
                    || state.isOf(Blocks.COAL_ORE) || state.isOf(Blocks.DEEPSLATE_COAL_ORE)
                    || state.isOf(Blocks.IRON_ORE) || state.isOf(Blocks.DEEPSLATE_IRON_ORE)
                    || state.isOf(Blocks.COPPER_ORE) || state.isOf(Blocks.DEEPSLATE_COPPER_ORE);
                if (stoneTierRock && stack.isOf(Items.STONE_PICKAXE)) return 25.0f;
                if (stoneTierRock && stack.isOf(Items.IRON_PICKAXE)) {
                    int remaining = stack.getMaxDamage() - stack.getDamage();
                    if (remaining <= 16) return 4.0f; // preserve nearly-broken iron pickaxe for diamonds!
                }
                return 10.0f + speed;
            }
        } else if (state.isIn(BlockTags.AXE_MINEABLE)) {
            if (stack.getItem() instanceof AxeItem) return 10.0f + speed;
            if (stack.isEmpty() || !stack.isDamageable()) return 2.0f;
            return 1.0f;
        } else if (state.isIn(BlockTags.SHOVEL_MINEABLE)) {
            if (stack.getItem() instanceof ShovelItem) return 10.0f + speed;
            if (stack.isEmpty() || !stack.isDamageable()) return 2.0f;
            return 1.0f;
        }
        return speed;
    }

    /** Equip best melee weapon in hotbar (sword > axe > pickaxe). */
    void selectBestWeapon() {
        var player = client.player;
        if (player == null) return;
        PlayerInventory inv = player.getInventory();
        int bestSlot = inv.selectedSlot;
        double bestScore = weaponScore(inv.getStack(bestSlot));
        for (int i = 0; i < 9; i++) {
            double s = weaponScore(inv.getStack(i));
            if (s > bestScore) {
                bestScore = s;
                bestSlot = i;
            }
        }
        inv.selectedSlot = bestSlot;
    }

    static double weaponScore(ItemStack stack) {
        if (stack.isEmpty()) return 1.0;
        Item item = stack.getItem();
        if (item == Items.DIAMOND_SWORD) return 10.0;
        if (item == Items.IRON_SWORD) return 9.0;
        if (item == Items.STONE_SWORD) return 8.0;
        if (item == Items.WOODEN_SWORD) return 7.0;
        if (item == Items.DIAMOND_AXE) return 9.2;
        if (item == Items.IRON_AXE) return 8.5;
        if (item == Items.STONE_AXE) return 7.8;
        if (item == Items.WOODEN_AXE) return 6.5;
        if (item == Items.DIAMOND_PICKAXE) return 5.5;
        if (item == Items.IRON_PICKAXE) return 5.0;
        if (item == Items.STONE_PICKAXE) return 4.5;
        if (item == Items.WOODEN_PICKAXE) return 3.5;
        return 1.0;
    }

    int findHotbarItem(Item item) {
        var player = client.player;
        if (player == null) return -1;
        for (int i = 0; i < 9; i++) {
            if (player.getInventory().getStack(i).isOf(item)) return i;
        }
        return -1;
    }

    int findHotbarBoat() {
        var player = client.player;
        if (player == null) return -1;
        for (int i = 0; i < 9; i++) {
            if (SafeDescent.isBoatStack(player.getInventory().getStack(i))) return i;
        }
        return -1;
    }

    int findHotbarScaffold() {
        var player = client.player;
        if (player == null) return -1;
        Item[] preferred = {
            Items.COBBLESTONE, Items.COBBLED_DEEPSLATE, Items.DIRT, Items.NETHERRACK,
            Items.GRANITE, Items.DIORITE, Items.ANDESITE, Items.TUFF, Items.OAK_PLANKS,
            Items.SPRUCE_PLANKS, Items.BIRCH_PLANKS, Items.JUNGLE_PLANKS, Items.ACACIA_PLANKS, Items.DARK_OAK_PLANKS
        };
        for (Item item : preferred) {
            int slot = findHotbarItem(item);
            if (slot >= 0) return slot;
        }
        return -1;
    }

    /** Find best edible food in hotbar (prefers cooked/safe food; avoids rotten flesh/spider eye/raw chicken unless emergency). */
    int findHotbarFood(boolean allowEmergencyRaw) {
        var player = client.player;
        if (player == null) return -1;
        int bestSlot = -1;
        int bestScore = -1;
        for (int i = 0; i < 9; i++) {
            int score = foodScore(player.getInventory().getStack(i), allowEmergencyRaw);
            if (score > bestScore) {
                bestScore = score;
                bestSlot = i;
            }
        }
        return bestSlot;
    }

    static int foodScore(ItemStack stack, boolean allowEmergencyRaw) {
        if (stack.isEmpty()) return -1;
        var food = stack.get(DataComponentTypes.FOOD);
        if (food == null) return -1;
        Item item = stack.getItem();
        if (item == Items.SPIDER_EYE || item == Items.PUFFERFISH || item == Items.POISONOUS_POTATO || item == Items.CHORUS_FRUIT) {
            return -1;
        }
        if (item == Items.ROTTEN_FLESH || item == Items.CHICKEN) {
            return allowEmergencyRaw ? 1 : -1;
        }
        if (item == Items.BEEF || item == Items.PORKCHOP || item == Items.MUTTON || item == Items.RABBIT || item == Items.COD || item == Items.SALMON) {
            return allowEmergencyRaw ? 3 : 2;
        }
        return 10 + food.nutrition() * 2;
    }

    boolean isMining() {
        if (client.interactionManager == null) return holdingMining;
        return holdingMining || ((AgentMiningAccess) client.interactionManager).agent$breakingProgress() > 0f;
    }

    float breakingProgress() {
        if (client.interactionManager == null) return 0f;
        return ((AgentMiningAccess) client.interactionManager).agent$breakingProgress();
    }

    boolean anyMovementKey() {
        return wantForward || wantBack || wantLeft || wantRight || wantJump || wantAttack || wantUse;
    }

    double totalYawTravel() { return totalYawTravel; }
    double totalPitchTravel() { return totalPitchTravel; }
}
