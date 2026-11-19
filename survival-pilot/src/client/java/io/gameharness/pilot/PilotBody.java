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
import net.minecraft.item.BoatItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.registry.tag.ItemTags;
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
    private static final int MOVEMENT_RAYS = 6;
    private static final double MAX_RANGE = 32;
    private static final double TURN_SPEED = 230;
    private static final double TURN_TIME = 0.085;
    private static final double GAIT_PITCH_SPEED = 48;
    private static final double GAIT_PITCH_ACCELERATION = 200;
    private static final double GAIT_PITCH_TIME = 0.20;
    private static final float[] ESCAPE_BEARINGS = {0, -45, 45, -90, 90, -135, 135, 180};

    private enum Ray {
        SIGHT(RaycastContext.ShapeType.OUTLINE, false),
        FLUIDS(RaycastContext.ShapeType.OUTLINE, true),
        TERRAIN(RaycastContext.ShapeType.COLLIDER, true),
        WET_TERRAIN(RaycastContext.ShapeType.COLLIDER, false);

        final RaycastContext.ShapeType shape;
        final boolean allFluids;

        Ray(RaycastContext.ShapeType shape, boolean allFluids) {
            this.shape = shape;
            this.allFluids = allFluids;
        }
    }

    private enum Ground { CLEAR, EDGE }

    private final MinecraftClient client;
    private final Matrix4f viewProjection = new Matrix4f();
    private final Matrix4f inverseViewProjection = new Matrix4f();
    private final Vector4f clip = new Vector4f();
    private final BlockPos.Mutable lightPos = new BlockPos.Mutable();
    private final BlockHitResult[] samples = new BlockHitResult[COLUMNS * ROWS];
    private final PilotHazards hazards = new PilotHazards();
    private final PilotHeadroom headroom;

    private ClientWorld observedWorld;
    private ClientPlayerEntity observedPlayer;
    private ClientWorld hazardWorld;
    private ClientPlayerEntity hazardPlayer;
    private Vec3d dryFooting;
    private int dryFootingTick;
    private int lavaContactTick;
    private Vec3d escapeFrom;
    private int escapeSince;
    private int escapeChoice = -1;
    private int escapeTried;
    private float escapeBase;
    private int observedAtTick;
    private Vec3d eye;
    private HitResult renderedCrosshair;
    private HitResult tickCrosshair;
    private Vec3d aimPoint;
    private float aimYaw;
    private float aimPitch;
    private boolean steering;
    private boolean gaitSteering;
    private boolean fallSteering;
    private double gaitPitchVelocity;
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
    private Vec3d dryLanding;
    private Vec3d centerLanding;
    private boolean jumping;
    private boolean reachJump;
    private boolean routeJumps;
    private boolean sneaking;
    private boolean swimmingDown;
    private boolean eating;
    private boolean ownsKeys;
    private int lastStepJump = -10;
    private BlockPos mining;
    private BlockPos bucketSource;
    private boolean scoopLava;
    private BlockPos support;
    private Direction supportFace;
    private Entity controlledBoat;
    private boolean rowForward;
    private boolean rowLeft;
    private boolean rowRight;
    private boolean boatDismount;
    private boolean ownsRowKeys;
    private Entity striking;
    private LivingEntity shielding;
    private Item armor;

    PilotBody(MinecraftClient client) {
        this.client = client;
        headroom = new PilotHeadroom(client, this);
    }

    void begin() {
        tick++;
        raysLeft = RAY_BUDGET - MOVEMENT_RAYS;
        sampleCount = 0;
        sampleRange = 0;
        rayShapeContext = null;
        tickCrosshair = null;
        nightVision = client.player != null && client.player.hasStatusEffect(StatusEffects.NIGHT_VISION);
        resetIntentions();
        if (hazardWorld != client.world || hazardPlayer != client.player) {
            hazards.clear();
            headroom.reset();
            dryFooting = null;
            escapeChoice = -1;
            hazardWorld = client.world;
            hazardPlayer = client.player;
        }
        boolean available = ready();
        headroom.observe(tick, available && client.getOverlay() == null);
        if (!available) return;
        var player = client.player;
        if (player.isInLava()) lavaContactTick = tick;
        if (!lavaEgress(player)) {
            escapeChoice = -1;
            if (player.isOnGround() && !player.isTouchingWater()) {
                Vec3d feet = player.getPos();
                if (dryFooting == null || feet.squaredDistanceTo(dryFooting) >= 0.36 || tick - dryFootingTick > 20) {
                    dryFooting = feet;
                    dryFootingTick = tick;
                }
            }
        }
        if (hasView()) scanFluids(PilotHazards.SIGHT_RANGE, true, false, false);
    }

    private void resetIntentions() {
        dryLanding = null;
        centerLanding = null;
        forward = backward = fast = verifiedDescent = jumping = sneaking = swimmingDown = eating = false;
        reachJump = false;
        routeJumps = true;
        rowForward = rowLeft = rowRight = boatDismount = false;
        mining = support = bucketSource = null;
        supportFace = null;
        striking = null;
        shielding = null;
        armor = null;
    }

    /** Called before GameRenderer computes this frame's camera and crosshair. */
    void frame() {
        long now = System.nanoTime();
        double dt = lastFrame == 0 ? 0 : Math.min((now - lastFrame) * 1e-9, 0.05);
        lastFrame = now;
        if (!steering || !ready() || dt <= 0) return;
        var player = client.player;
        Vec3d origin = aimPoint == null ? null
            : player.getCameraPosVec(client.getRenderTickCounter().getTickDelta(true));
        double yaw = MathHelper.wrapDegrees(goalYaw(player, origin) - player.getYaw());
        double pitch = goalPitch(origin) - player.getPitch();
        double response = -Math.expm1(-dt / TURN_TIME);
        if (gaitSteering) {
            double yawStep = MathHelper.clamp(yaw * response, -TURN_SPEED * dt, TURN_SPEED * dt);
            double brakingSpeed = Math.sqrt(2 * GAIT_PITCH_ACCELERATION * Math.abs(pitch));
            double speed = Math.min(GAIT_PITCH_SPEED, brakingSpeed);
            double desired = MathHelper.clamp(pitch / GAIT_PITCH_TIME, -speed, speed);
            double accelerationStep = GAIT_PITCH_ACCELERATION * dt;
            double nextVelocity = gaitPitchVelocity
                + MathHelper.clamp(desired - gaitPitchVelocity, -accelerationStep, accelerationStep);
            double pitchStep = (gaitPitchVelocity + nextVelocity) * 0.5 * dt;
            gaitPitchVelocity = nextVelocity;
            if (Math.abs(yawStep) + Math.abs(pitchStep) >= 1e-5) {
                player.changeLookDirection(yawStep / 0.15, pitchStep / 0.15);
            }
            return;
        }
        double distance = Math.hypot(yaw, pitch);
        if (distance < 1e-4) return;
        // A real fall can have only a few ticks of reach. Still move through the mouse path.
        double fraction = fallSteering
            ? Math.min(-Math.expm1(-dt / 0.025), 920 * dt / distance)
            : Math.min(response, TURN_SPEED * dt / distance);
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
            gaitPitchVelocity = 0;
            releaseKeys();
            return;
        }
        var player = client.player;
        var options = client.options;
        if (controlledBoat != null && player.getVehicle() != controlledBoat) controlledBoat = null;
        boolean advance = forward && (!steering
            || Math.abs(MathHelper.wrapDegrees(goalYaw(player, player.getEyePos()) - player.getYaw())) <= 28);
        boolean retreat = backward;
        boolean dive = swimmingDown && player.isTouchingWater() && player.getAir() >= 70;
        boolean crouch = sneaking || dive;
        boolean jump = jumping || !dive && (player.isSubmergedInWater()
            || (advance || retreat) && player.isTouchingWater());
        boolean stepJump = false;
        Ground ground = Ground.CLEAR;
        boolean escapingLava = lavaEgress(player);

        if (escapingLava) {
            float heading = lavaEscapeHeading(player);
            float difference = Math.abs(MathHelper.wrapDegrees(heading - player.getYaw()));
            advance = difference <= 36;
            retreat = difference >= 144;
            turn(retreat ? heading + 180 : heading, 24);
            jump = player.isInLava();
        } else if (controlledBoat == null && advance && player.isOnGround() && !player.isTouchingWater()) {
            ground = terrainAhead(player);
            if (ground == Ground.EDGE) {
                crouch |= !verifiedDescent;
            } else if (!crouch && player.horizontalCollision && tick - lastStepJump >= 9) {
                // A collision is own-body feedback; no off-screen/headroom block reads.
                jump = stepJump = true;
            }
        }

        boolean attack = false;
        boolean use = false;
        if (!escapingLava && shielding != null && !options.useKey.isUnbound()) {
            double dx = shielding.getX() - player.getX();
            double dz = shielding.getZ() - player.getZ();
            boolean facing = dx * dx + dz * dz > 1e-6
                && Math.abs(MathHelper.wrapDegrees(heading(dx, dz) - player.getYaw())) <= 38;
            if (facing && shielding.isAlive()) {
                if (player.isUsingItem()) {
                    use = player.getActiveItem().isOf(Items.SHIELD);
                } else {
                    ItemStack main = player.getMainHandStack();
                    ItemStack shield = main.isOf(Items.SHIELD) ? main : player.getOffHandStack();
                    if (shield.isOf(Items.SHIELD) && !player.getItemCooldownManager().isCoolingDown(shield)
                            && shieldSafeMainHand(main)) {
                        HitResult actual = currentCrosshair();
                        if (actual instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK) {
                            // Sneak past station use; do not right-click a block with an axe.
                            crouch |= !main.isIn(ItemTags.AXES);
                            use = crouch && player.isSneaking() && !main.isIn(ItemTags.AXES);
                        } else {
                            use = actual != null && (actual.getType() == HitResult.Type.MISS
                                || actual instanceof EntityHitResult hit && hit.getEntity() == shielding);
                        }
                    }
                }
            }
        } else if (!escapingLava && armor != null && !options.useKey.isUnbound()) {
            ItemStack main = player.getMainHandStack();
            var component = main.get(DataComponentTypes.EQUIPPABLE);
            if (main.isOf(armor) && component != null && !player.isUsingItem()) {
                ItemStack worn = player.getEquippedStack(component.slot());
                if ((worn.isEmpty() || component.swappable()) && !ItemStack.areItemsAndComponentsEqual(worn, main)) {
                    HitResult actual = currentCrosshair();
                    if (actual instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK) {
                        crouch = true;
                        use = player.isSneaking();
                    } else {
                        use = actual != null && actual.getType() == HitResult.Type.MISS;
                    }
                }
            }
        } else if (bucketSource != null && hasView() && player.getMainHandStack().isOf(Items.BUCKET)) {
            Vec3d from = player.getEyePos();
            Vec3d to = from.add(player.getRotationVec(1).multiply(player.getBlockInteractionRange()));
            BlockHitResult hit = client.world.raycast(new RaycastContext(from, to, RaycastContext.ShapeType.OUTLINE,
                RaycastContext.FluidHandling.SOURCE_ONLY, player));
            use = hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(bucketSource)
                && inView(hit.getPos()) && litFace(hit)
                && client.world.getFluidState(bucketSource).isIn(scoopLava ? FluidTags.LAVA : FluidTags.WATER);
        } else if (mining != null || support != null || striking != null || eating) {
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
                        && striking.isAlive() && !player.isUsingItem()
                        && player.getAttackCooldownProgress(0.5f) >= 0.9f) {
                    pressKey(options.attackKey);
                }
            } else if (actual instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK) {
                attack = hit.getBlockPos().equals(mining);
            }
        }
        if (escapingLava) crouch = false;
        boolean sprintRequested = !escapingLava && advance && fast && !crouch && ground == Ground.CLEAR;
        if (!escapingLava && (advance || retreat)) {
            float heading = player.getYaw() + (retreat ? 180 : 0);
            double reach = jump ? 3.2 : sprintRequested || player.isSprinting() ? 2.35 : crouch ? 0.70 : 1.35;
            if (dryLanding != null && advance && !jump && !sprintRequested && !player.isSprinting() && player.isOnGround()) {
                double dx = dryLanding.x - player.getX(), dz = dryLanding.z - player.getZ();
                double distance = Math.hypot(dx, dz);
                if (distance > 0.05 && distance <= 1.5 && Math.abs(dryLanding.y - player.getY()) <= 0.55
                    && Math.abs(MathHelper.wrapDegrees(heading(dx, dz) - heading)) < 15) {
                    double braking = 0.14 + 4 * Math.sqrt(player.getVelocity().horizontalLengthSquared());
                    reach = Math.min(reach, Math.max(distance + 0.14, braking));
                }
            }
            raysLeft += MOVEMENT_RAYS;
            sightMovementLane(player, heading, reach);
            if (hazards.lavaRisk(player.getBoundingBox(), heading, reach, jump ? 1.1 : 0, false, tick) > 0) {
                advance = retreat = sprintRequested = false;
                jump = !dive && player.isSubmergedInWater();
            }
        } else if (!escapingLava && jump && !player.isTouchingWater()) {
            Vec3d motion = player.getVelocity();
            double drift = motion.horizontalLengthSquared();
            if (drift > 0.0016
                    && hazards.lavaRisk(player.getBoundingBox(), heading(motion.x, motion.z),
                        Math.sqrt(drift) * 9, 1.1, false, tick) > 0) jump = false;
        }
        // Vanilla latches sprint when Ctrl is released. Let up on W to brake, then walk again.
        if (!escapingLava && advance && !sprintRequested && player.isSprinting()) advance = false;
        boolean centerKeys = centerLanding != null && !escapingLava && controlledBoat == null
            && player.isOnGround() && !player.isTouchingWater() && player.getVehicle() == null;
        boolean centerLeft = false, centerRight = false;
        if (centerKeys) {
            double dx = centerLanding.x - player.getX(), dz = centerLanding.z - player.getZ();
            double distance = Math.hypot(dx, dz);
            double yaw = Math.toRadians(player.getYaw());
            double ahead = -Math.sin(yaw) * dx + Math.cos(yaw) * dz;
            double right = -Math.cos(yaw) * dx - Math.sin(yaw) * dz;
            advance = retreat = jump = sprintRequested = false;
            crouch = true;
            if (distance > 0.08 && distance < 0.82 &&
                hazards.lavaRisk(player.getBoundingBox(), heading(dx, dz), distance + 0.12, 0, false, tick) == 0) {
                advance = ahead > 0.06;
                retreat = ahead < -0.06;
                centerLeft = right < -0.06;
                centerRight = right > 0.06;
            }
        }
        if (controlledBoat != null) {
            boolean dry = !escapingLava && !controlledBoat.isInLava() && !controlledBoat.isTouchingWater();
            advance = dry && rowForward
                && hazards.lavaRisk(controlledBoat.getBoundingBox(), controlledBoat.getYaw(), 1.6, 0, false, tick) == 0;
            retreat = jump = sprintRequested = attack = use = false;
            // Generic crouch/guard intentions must not eject the pilot from a falling boat.
            crouch = escapingLava || (dry && boatDismount && controlledBoat.isOnGround());
            options.leftKey.setPressed(dry && rowLeft);
            options.rightKey.setPressed(dry && rowRight);
            ownsRowKeys = true;
        } else if (centerKeys) {
            options.leftKey.setPressed(centerLeft);
            options.rightKey.setPressed(centerRight);
            ownsRowKeys = true;
        } else {
            releaseRowKeys();
        }
        // Sample only an input about to reach vanilla, after movement and lava vetoes.
        if (routeJumps && jump && (advance || reachJump) && !fast && !escapingLava && !crouch
                && !attack && !use && !player.isUsingItem() && !player.isSprinting() && !player.isSneaking()
                && player.isOnGround() && !player.isTouchingWater() && !player.hasVehicle()
                && !options.jumpKey.isUnbound() && client.getOverlay() == null) {
            if (headroom.veto(player, tick, player.getYaw(), !advance)) jump = false;
        }
        if (jump && stepJump) lastStepJump = tick;
        ownsKeys = true;
        options.forwardKey.setPressed(advance);
        options.backKey.setPressed(retreat);
        options.jumpKey.setPressed(jump);
        setSticky(options.sneakKey, crouch, options.getSneakToggled().getValue());
        setSticky(options.sprintKey, sprintRequested, options.getSprintToggled().getValue());
        options.attackKey.setPressed(attack);
        // Held for this tick only unless requested again; vanilla enforces its use delay.
        options.useKey.setPressed(use);
    }

    private void sightMovementLane(ClientPlayerEntity player, float yaw, double reach) {
        if (!hasView() || raysLeft <= 0) return;
        double angle = Math.toRadians(yaw);
        double dx = -Math.sin(angle), dz = Math.cos(angle);
        double distance = Math.min(PilotHazards.MAX_LANE, Math.max(2.25, reach + 0.20));
        double x = player.getX() + dx * distance, z = player.getZ() + dz * distance;
        double halfWidth = player.getWidth() * 0.5;
        for (int side = -1; side <= 1; side++) {
            double sx = x + side * halfWidth * dz, sz = z - side * halfWidth * dx;
            Vec3d shallow = new Vec3d(sx, player.getY() - 0.55, sz);
            Vec3d belowLip = new Vec3d(sx, player.getY() - 2.5, sz);
            if (inView(shallow)) visibleHit(shallow, Ray.FLUIDS);
            if (inView(belowLip)) visibleHit(belowLip, Ray.FLUIDS);
        }
    }

    private boolean lavaEgress(ClientPlayerEntity player) {
        // Keep the exit bearing through the first jump out, not through a fresh land movement.
        return player.isInLava() || escapeChoice >= 0 && tick - lavaContactTick <= 12
            && player.isOnFire() && !player.isOnGround() && !player.isTouchingWater();
    }

    private float lavaEscapeHeading(ClientPlayerEntity player) {
        Vec3d feet = player.getPos();
        if (escapeChoice < 0) {
            escapeTried = 0;
            escapeBase = player.getYaw();
            if (dryFooting != null && tick - dryFootingTick <= 80 && Math.abs(dryFooting.y - feet.y) <= 1.6) {
                double dx = dryFooting.x - feet.x, dz = dryFooting.z - feet.z;
                double distance = dx * dx + dz * dz;
                if (distance > 0.04 && distance <= 36) escapeBase = heading(dx, dz);
            }
        } else {
            double dx = feet.x - escapeFrom.x, dz = feet.z - escapeFrom.z;
            if (dx * dx + dz * dz >= 0.12) {
                escapeFrom = feet;
                escapeSince = tick;
            }
            if (tick - escapeSince < 18) return escapeBase + ESCAPE_BEARINGS[escapeChoice];
            escapeTried |= 1 << escapeChoice;
            if (escapeTried == (1 << ESCAPE_BEARINGS.length) - 1) escapeTried = 0;
        }
        double best = Double.POSITIVE_INFINITY;
        Box bounds = player.getBoundingBox();
        for (int i = 0; i < ESCAPE_BEARINGS.length; i++) {
            if ((escapeTried & 1 << i) != 0) continue;
            double risk = hazards.lavaRisk(bounds, escapeBase + ESCAPE_BEARINGS[i],
                2.65, 0.85, true, tick) + 0.0015 * Math.abs(ESCAPE_BEARINGS[i]);
            if (risk < best) {
                best = risk;
                escapeChoice = i;
            }
        }
        escapeFrom = feet;
        escapeSince = tick;
        return escapeBase + ESCAPE_BEARINGS[escapeChoice];
    }

    private static float heading(double dx, double dz) {
        return (float) Math.toDegrees(Math.atan2(-dx, dz));
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
        gaitSteering = false;
        fallSteering = false;
        controlledBoat = null;
        gaitPitchVelocity = 0;
        aimPoint = null;
        lastFrame = 0;
        clearView();
        hazards.clear();
        headroom.reset();
        hazardWorld = null;
        hazardPlayer = null;
        dryFooting = escapeFrom = null;
        escapeChoice = -1;
        releaseKeys();
    }

    private void releaseKeys() {
        releaseRowKeys();
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

    private void releaseRowKeys() {
        if (!ownsRowKeys) return;
        client.options.leftKey.setPressed(false);
        client.options.rightKey.setPressed(false);
        ownsRowKeys = false;
    }

    private static void setSticky(KeyBinding key, boolean pressed, boolean toggle) {
        if (key.isPressed() != pressed) key.setPressed(toggle || pressed);
    }

    private boolean pressKey(KeyBinding requested) {
        if (requested.isUnbound()) return false;
        String binding = requested.getBoundKeyTranslationKey();
        // The vanilla pulse routes by physical binding, so never pulse an ambiguous binding.
        for (KeyBinding key : client.options.allKeys) {
            if (key != requested && binding.equals(key.getBoundKeyTranslationKey())) return false;
        }
        KeyBinding.onKeyPressed(InputUtil.fromTranslationKey(binding));
        return true;
    }

    void aim(Vec3d point) {
        aimPoint = point;
        steering = true;
        gaitSteering = false;
        fallSteering = false;
        gaitPitchVelocity = 0;
    }

    void aimDuringFall(Vec3d point) {
        aim(point);
        fallSteering = true;
    }

    void stopFallAim() {
        if (fallSteering) steering = false;
        fallSteering = false;
    }

    void turn(float yaw, float pitch) {
        setTurn(yaw, pitch);
        gaitSteering = false;
        gaitPitchVelocity = 0;
    }

    void lookAlongGait(float yaw, float pitch) {
        setTurn(yaw, pitch);
        gaitSteering = true;
    }

    private void setTurn(float yaw, float pitch) {
        aimPoint = null;
        aimYaw = yaw;
        aimPitch = MathHelper.clamp(pitch, -90, 90);
        steering = true;
        fallSteering = false;
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
    void jumpForReach() { jumping = reachJump = true; }

    void prioritizeMovement() {
        routeJumps = false;
        headroom.interruptAttempt();
    }

    boolean jumpBlocked() { return jumpBlocked(Float.NaN); }
    boolean jumpBlocked(float bearing) { return routeJumps && headroom.blocked(client.player, bearing); }
    boolean repairHeadroom(PilotTools tools, Predicate<BlockPos> protectedBlock) {
        return headroom.step(tick, tools, protectedBlock);
    }
    PilotHeadroom.Report headroomReport() { return headroom.report(); }
    void observeHeadroomBreak(BlockPos position) { headroom.broken(position); }

    void sneak() { sneaking = true; }
    void swimDown() { swimmingDown = true; }
    void holdUse() { eating = true; }
    void mine(BlockPos target) { mining = target; }
    void strike(Entity target) { striking = target; }

    boolean strikeTarget(Entity target) {
        return hasView() && currentCrosshair() instanceof EntityHitResult hit && hit.getEntity() == target;
    }

    boolean hasRecentView() { return hasView(); }

    boolean shieldStartWouldUseBlock() {
        HitResult actual = currentCrosshair();
        return actual != null && actual.getType() == HitResult.Type.BLOCK;
    }

    static boolean shieldSafeMainHand(ItemStack stack) {
        return stack.isEmpty() || stack.isOf(Items.SHIELD) || stack.isIn(ItemTags.SWORDS)
            || stack.isIn(ItemTags.AXES) || stack.isIn(ItemTags.PICKAXES);
    }

    void blockAgainst(LivingEntity threat) { shielding = threat; }

    boolean swapShieldToOffhand() {
        return ready() && !client.player.isUsingItem() && client.player.getMainHandStack().isOf(Items.SHIELD)
            && !client.player.getOffHandStack().isOf(Items.SHIELD) && pressKey(client.options.swapHandsKey);
    }

    void wearArmor(Item item) { armor = item; }

    void use(BlockPos target, Direction face) {
        support = target;
        supportFace = face;
    }

    void useWaterSource(BlockPos target) { bucketSource = target; scoopLava = false; }
    void useLavaSource(BlockPos target) { bucketSource = target; scoopLava = true; }

    /** Close, already observed dry footing only: the lava sweep still covers the whole body and braking distance. */
    void walkDownTo(Vec3d landing) {
        walkDown(false);
        dryLanding = landing;
    }

    /** Shift laterally toward the center of this same, freshly sighted full top.
     * A fractional edge position need not force a jump or a 180-degree turn. */
    boolean centerOnSupport(BlockPos support) {
        if (!hasView() || !client.player.isOnGround() || !support.equals(client.player.getBlockPos().down()))
            return false;
        Vec3d center = Vec3d.ofBottomCenter(support.up());
        Vec3d point = center.add(0, -0.025, 0);
        BlockHitResult hit = terrain(point, 2.6).orElse(null);
        if (hit == null || !hit.getBlockPos().equals(support) || hit.getSide() != Direction.UP ||
            Math.abs(hit.getPos().y - center.y) > 0.055) {
            aim(point);
            return false;
        }
        centerLanding = center;
        return true;
    }

    int actionTick() { return tick; }

    boolean tapHotbar(int slot) {
        return ready() && client.getOverlay() == null && client.isWindowFocused()
            && pressKey(client.options.hotbarKeys[slot]);
    }

    boolean boatControlsAvailable() {
        var options = client.options;
        return ready() && !options.useKey.isUnbound() && !options.sneakKey.isUnbound()
            && !options.forwardKey.isUnbound() && !options.backKey.isUnbound()
            && !options.leftKey.isUnbound() && !options.rightKey.isUnbound();
    }

    private boolean fallUseReady() {
        return hasView() && client.getOverlay() == null && client.isWindowFocused()
            && client.interactionManager != null && !client.interactionManager.isBreakingBlock()
            && !client.player.isUsingItem() && !client.player.hasVehicle() && !lavaEgress(client.player);
    }

    /** Validate both the visible vanilla target and the item-specific reach/raycast. */
    boolean tapFallBlock(BlockPos target, Item item, Vec3d near, double radius) {
        if (!fallUseReady() || !client.player.getMainHandStack().isOf(item)
            || !(currentCrosshair() instanceof BlockHitResult actual)
            || actual.getType() != HitResult.Type.BLOCK || !actual.getBlockPos().equals(target)
            || actual.getSide() != Direction.UP || !inView(actual.getPos()) || !litFace(actual)) return false;
        BlockHitResult hit = itemRay(item instanceof BoatItem ? RaycastContext.FluidHandling.ANY
            : RaycastContext.FluidHandling.NONE);
        return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target)
            && hit.getSide() == Direction.UP && hit.getPos().squaredDistanceTo(near) <= radius * radius
            && pressKey(client.options.useKey);
    }

    /** Pulse a single ordinary use without changing eye height after the checked face. */
    boolean tapCastFace(BlockPos support, Direction side, boolean filledBucket) {
        if (!fallUseReady()) return false;
        BlockHitResult selected = selectedFace();
        if (selected == null || !selected.getBlockPos().equals(support) || selected.getSide() != side
                || !inView(selected.getPos()) || !litFace(selected)) return false;
        if (filledBucket) {
            // BucketItem uses a separate OUTLINE / NONE ray even if a block was outlined.
            BlockHitResult hit = itemRay(RaycastContext.FluidHandling.NONE);
            if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(support)
                    || hit.getSide() != side || !inView(hit.getPos()) || !litFace(hit)) return false;
        }
        return pressKey(client.options.useKey);
    }

    boolean tapFallSource(BlockPos target) {
        if (!fallUseReady() || !client.player.getMainHandStack().isOf(Items.BUCKET)
            || !(currentCrosshair() instanceof BlockHitResult actual)
            || (actual.getType() == HitResult.Type.BLOCK && !actual.getBlockPos().equals(target.down()))) return false;
        BlockHitResult hit = itemRay(RaycastContext.FluidHandling.SOURCE_ONLY);
        return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target)
            && inView(hit.getPos()) && litFace(hit) && client.world.getFluidState(target).isIn(FluidTags.WATER)
            && pressKey(client.options.useKey);
    }

    private BlockHitResult itemRay(RaycastContext.FluidHandling fluids) {
        var player = client.player;
        Vec3d from = player.getEyePos();
        Vec3d to = from.add(player.getRotationVec(1).multiply(player.getBlockInteractionRange()));
        return client.world.raycast(new RaycastContext(from, to, RaycastContext.ShapeType.OUTLINE, fluids, player));
    }

    boolean tapVisibleEntity(Entity target) {
        return fallUseReady() && !client.player.shouldCancelInteraction() && target.isAlive()
            && renderedCrosshair instanceof EntityHitResult seen && seen.getEntity() == target
            && currentCrosshair() instanceof EntityHitResult hit && hit.getEntity() == target
            && !target.isInvisibleTo(client.player) && inView(hit.getPos())
            && lit(hit.getPos().x, hit.getPos().y, hit.getPos().z) && pressKey(client.options.useKey);
    }

    /** Boat controls steer from the hull's yaw, not the passenger's head. */
    void rowBoat(Entity boat, float yaw, boolean advance) {
        if (!ready() || client.player.getVehicle() != boat) return;
        controlledBoat = boat;
        float difference = MathHelper.wrapDegrees(yaw - boat.getYaw());
        rowLeft = difference < -2;
        rowRight = difference > 2;
        rowForward = advance && Math.abs(difference) <= 7;
    }

    void holdBoat(Entity boat) {
        if (ready() && client.player.getVehicle() == boat) controlledBoat = boat;
    }

    void dismountBoat(Entity boat) {
        if (ready() && client.player.getVehicle() == boat && boat.isOnGround()) {
            controlledBoat = boat;
            boatDismount = true;
        }
    }

    Optional<BlockHitResult> find(Predicate<BlockState> matches, double distance) {
        return find(matches, distance, null);
    }

    /** Reject positions among already admitted camera hits, before choosing the nearest match. */
    Optional<BlockHitResult> find(Predicate<BlockState> matches, double distance, Predicate<BlockHitResult> eligible) {
        if (!hasView()) return Optional.empty();
        double max = range(distance);
        if (!(max > 0)) return Optional.empty();
        if (renderedCrosshair instanceof BlockHitResult target && target.getType() == HitResult.Type.BLOCK
                && matchesHit(target, target.getBlockPos(), max)) {
            if (matches.test(client.world.getBlockState(target.getBlockPos())) && (eligible == null || eligible.test(target)))
                return Optional.of(target);
        }
        if (max > sampleRange && raysLeft > 0) sampleView(Math.min(range(MAX_RANGE), Math.max(max, 12)));
        BlockHitResult best = null;
        double bestDistance = max * max;
        for (int i = 0; i < sampleCount; i++) {
            BlockHitResult hit = samples[i];
            if (hit == null) continue;
            double d = hit.getPos().squaredDistanceTo(eye);
            if (d <= bestDistance && matches.test(client.world.getBlockState(hit.getBlockPos()))
                && (eligible == null || eligible.test(hit))) {
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

    /** Preflight a proposed bearing against recently rendered lava, without sensing that direction blindly. */
    boolean hazardAhead(float yaw, double distance) {
        return ready() && hazards.lavaRisk(client.player.getBoundingBox(), yaw, distance, 0.65, false, tick) > 0;
    }

    /** A surface hit from the current rendered camera, optionally limited to a collectable source. */
    BlockHitResult visibleFluid(boolean lava, boolean sourceOnly, double distance) {
        if (!hasView()) return null;
        double max = range(distance);
        if (!(max > 0)) return null;
        BlockHitResult near = hazards.currentFluid(lava, sourceOnly, eye, max, tick);
        return near != null ? near : scanFluids(max, false, lava, sourceOnly);
    }

    private BlockHitResult scanFluids(double distance, boolean near, boolean lava, boolean sourceOnly) {
        int columns = near ? 7 : 9, rows = near ? 4 : 5;
        float uPhase = (tick & 1) == 0 ? 0.28f : 0.72f;
        float vPhase = (tick & 2) == 0 ? 0.30f : 0.70f;
        double nearest = distance * distance;
        BlockHitResult best = null;
        for (int y = 0; y < rows && raysLeft > 0; y++) {
            float v = -0.98f + (near ? 1.48f : 1.96f) * ((y + vPhase) / rows);
            for (int x = 0; x < columns && raysLeft > 0; x++) {
                float u = 1.96f * ((x + uPhase) / columns) - 0.98f;
                inverseViewProjection.transform(clip.set(u, v, 0.9f, 1));
                double dx = clip.x / (double) clip.w, dy = clip.y / (double) clip.w, dz = clip.z / (double) clip.w;
                double scale = distance / Math.sqrt(dx * dx + dy * dy + dz * dz);
                Vec3d end = eye.add(dx * scale, dy * scale, dz * scale);
                if (!inView(end)) continue;
                BlockHitResult hit = litHit(end, Ray.FLUIDS);
                if (hit == null) continue;
                byte kind = PilotHazards.kind(client.world.getBlockState(hit.getBlockPos()));
                double d = eye.squaredDistanceTo(hit.getPos());
                hazards.observe(hit, kind, eye, d, tick);
                if (!near && PilotHazards.matches(kind, lava, sourceOnly)) {
                    if (d > nearest) continue;
                    best = hit;
                    nearest = d;
                }
            }
        }
        return best;
    }

    /** A lit floor or fluid surface; no result means unknown, not proven empty. */
    Optional<BlockHitResult> terrain(Vec3d point, double distance) {
        return probe(point, distance, Ray.TERRAIN);
    }

    /** Look through transparent water at lit collision geometry; lava still occludes it. */
    Optional<BlockHitResult> terrainThroughWater(Vec3d point, double distance) {
        return probe(point, distance, Ray.WET_TERRAIN);
    }

    /** Require visible, lit clearance; an out-of-frame or unlit lane is not clear. */
    boolean clearTerrain(Vec3d point) {
        return hasView() && clearPoint(point, Ray.TERRAIN);
    }

    boolean clearTerrainThroughWater(Vec3d point) {
        return hasView() && clearPoint(point, Ray.WET_TERRAIN);
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
            if ((clearPoint(center, Ray.SIGHT) || clearPoint(center.add(0, margin, 0), Ray.SIGHT)
                    || clearPoint(center.add(0, -margin, 0), Ray.SIGHT)) && matches.test(candidate)) {
                best = candidate;
                bestDistance = d;
            }
        }
        return Optional.ofNullable(best);
    }

    private boolean clearPoint(Vec3d point, Ray ray) {
        if (raysLeft <= 0 || !inView(point)) return false;
        raysLeft--;
        return raycast(point, ray).getType() == HitResult.Type.MISS
            && lit(point.x, point.y, point.z);
    }

    private BlockHitResult visibleHit(Vec3d end, Ray ray) {
        BlockHitResult hit = litHit(end, ray);
        if (hit != null && ray != Ray.TERRAIN) {
            double d = eye.squaredDistanceTo(hit.getPos());
            if (d <= PilotHazards.SIGHT_RANGE * PilotHazards.SIGHT_RANGE) {
                hazards.observe(hit, PilotHazards.kind(client.world.getBlockState(hit.getBlockPos())), eye, d, tick);
            }
        }
        return hit;
    }

    private BlockHitResult litHit(Vec3d end, Ray ray) {
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
        return client.world.raycast(new RaycastContext(eye, end, ray.shape,
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
        if (inView(near)) {
            BlockHitResult hit = raycast(near, Ray.TERRAIN);
            if (hit.getType() == HitResult.Type.MISS || !inView(hit.getPos()) || !litFace(hit)) {
                return Ground.EDGE;
            }
        }
        return Ground.CLEAR;
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
