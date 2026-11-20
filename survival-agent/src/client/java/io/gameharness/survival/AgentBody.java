package io.gameharness.survival;

import java.util.Optional;
import java.util.function.Consumer;
import java.util.function.Predicate;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderContext;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.block.ShapeContext;
import net.minecraft.block.SnowBlock;
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
import net.minecraft.item.ItemPlacementContext;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
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
import net.minecraft.util.shape.VoxelShape;
import net.minecraft.util.shape.VoxelShapes;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;
import net.minecraft.world.World;
import org.joml.Matrix4f;
import org.joml.Vector4f;

/** First-person observations and vanilla input, on the client thread only. */
final class AgentBody {
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
    private static final int FOOTING_AGE = 100;
    private static final int ESCAPE_TICKS = 44;
    private static final String SUPPORTING_FOOTPRINT = "supporting_footprint";
    private static final double[] MACRO_FLOOR_OFFSETS = {0, -0.36, 0.36};
    static final int SUPPLY_OPEN = 1, SUPPLY_ROOF = 2, SUPPLY_WALL = 4;

    enum Contact {
        PLACE("place", false, 0.012),
        INTERACT("interact", false, 0.012),
        MINE("mine", false, 0.012),
        LEAP_PLACE("leap_place", false, 0.012),
        PRECISE("precise_use", true, 0.022),
        BUCKET("pour", true, 0.022),
        RIM("rim_place", true, 0.022),
        OUTLINE("outline_use", true, 0.022);

        final String action;
        final boolean precise;
        final double predictionSeconds;

        Contact(String action, boolean precise, double predictionSeconds) {
            this.action = action;
            this.precise = precise;
            this.predictionSeconds = predictionSeconds;
        }

        boolean allowsOutline() { return this == RIM || this == BUCKET || this == OUTLINE; }
    }

    enum Preparation {
        READY(null), EQUIPMENT("awaiting_equipment"), RECEIPT("awaiting_receipt"), STANCE("awaiting_stance");

        final String waitReason;
        Preparation(String waitReason) { this.waitReason = waitReason; }
        static Preparation equipment(boolean ready) { return ready ? READY : EQUIPMENT; }
    }

    record ContactEvidence(int tick, long frame, long wallMs, String action, String status,
                           BlockPos pos, Direction side, double u, double v, double degreesPerSecond,
                           int dwellTicks, long dwellMs) {}
    record LookEvidence(long seed, long sequence, int tick, long wallMs, String context, String profile,
                        double effort, double distance, double appliedDegrees, double peakDegreesPerSecond,
                        long peakAtMs, long durationMs, String outcome) {}

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
    private final BlockPos.Mutable overlandProbe = new BlockPos.Mutable();
    private final BlockHitResult[] samples = new BlockHitResult[COLUMNS * ROWS];
    private final AgentHazards hazards = new AgentHazards();
    private final AgentHeadroom headroom;
    private final Consumer<ContactEvidence> contactEvidence;
    private final AgentLookMotor lookMotor;

    private ClientWorld observedWorld;
    private ClientPlayerEntity observedPlayer;
    private ClientWorld hazardWorld;
    private ClientPlayerEntity hazardPlayer;
    private Vec3d dryFooting;
    private int dryFootingTick;
    private Vec3d previousDryFooting;
    private int previousDryFootingTick;
    private boolean lavaEmergency;
    private Predicate<ItemStack> safetySpend;
    private int stableDryTicks;
    private Vec3d escapeLanding;
    private boolean escapePlanned;
    private boolean escapeBackward;
    private float escapeHeading;
    private int escapeSince;
    private BlockPos escapeWater;
    private int escapeWaterTick;
    private int escapeWaterAttempts;
    private int observedAtTick;
    private Vec3d eye;
    private float observedYaw, observedPitch;
    private long observedAtNanos;
    private double observedYawSpeed, observedPitchSpeed;
    private long frameSequence;
    private HitResult renderedCrosshair;
    private HitResult tickCrosshair;
    private Vec3d threatPoint;
    private Vec3d aimPoint;
    private float aimYaw;
    private float aimPitch;
    private boolean steering;
    private boolean gaitSteering;
    private boolean fallSteering;
    private boolean fixedSteering;
    private int fixedTick;
    private AgentLookMotor.Context lookContext = AgentLookMotor.Context.NORMAL;
    private AgentFaceAim lookTarget;
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
    private int lastForwardPress = -8;
    private boolean verifiedDescent;
    private boolean flatWalk, dryRouteWalk, emergencyWalk;
    private boolean wetEscapeWalk;
    private Vec3d dryLanding;
    private BlockPos stepSupport;
    private boolean surfaceStep;
    private Vec3d stepWitness, stepLanding;
    private double stepOriginY;
    private Direction stepDirection;
    private float stepYaw, stepPitch;
    private int stepStarted, stepDriveTick;
    private Vec3d centerLanding;
    private Vec3d lavaExitWaypoint;
    private boolean jumping;
    private boolean reachJump;
    private boolean routeJumps;
    private boolean sneaking;
    private boolean swimmingDown;
    private boolean eating;
    private boolean ownsKeys;
    private int lastStepJump = -10;
    private BlockPos mining;
    private Entity controlledBoat;
    private boolean rowForward;
    private boolean rowLeft;
    private boolean rowRight;
    private boolean boatDismount;
    private boolean ownsRowKeys;
    private Entity striking;
    private LivingEntity shielding;
    private Vec3d raisedShieldBearing;
    private float rangedShieldYaw = Float.NaN;
    private Item armor;
    private AgentFaceAim contact;
    private Contact contactMode;
    private BlockState contactState;
    private Vec3d contactPoint;
    private int contactTick, contactProbeTick, contactCheckTick = -1;
    private long contactProbeFrame;
    private int firstValidTick;
    private long firstValidNanos;
    private String contactStatus;
    private String contactBaseline;
    private BlockPos lastHeldMine;
    private int lastHeldMineTick;
    private int lastContactUse = -1;
    private AgentFaceAim sourceContact;
    private Vec3d sourcePoint;
    private int sourceTick;
    private int sourceValidTick;
    private long sourceValidNanos;
    private String sourceStatus;

    AgentBody(MinecraftClient client, Consumer<ContactEvidence> contactEvidence, Consumer<LookEvidence> lookEvidence,
              long lookSeed) {
        this.client = client;
        this.contactEvidence = contactEvidence;
        lookMotor = new AgentLookMotor(TURN_SPEED, lookSeed, lookEvidence);
        headroom = new AgentHeadroom(client, this);
    }

    void begin() {
        tick++;
        safetySpend = null;
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
            stepSupport = null;
            dryFooting = previousDryFooting = null;
            lavaEmergency = false;
            hazardWorld = client.world;
            hazardPlayer = client.player;
        }
        boolean available = ready();
        if (client.player != null && client.player.isAlive() && client.player.isInLava()) beginLavaEscape();
        headroom.observe(tick, available && !lavaEmergency && client.getOverlay() == null);
        if (!available) {
            stableDryTicks = 0;
            return;
        }
        var player = client.player;
        if (hasView()) scanFluids(AgentHazards.SIGHT_RANGE, true, false, false);
        boolean dry = player.isOnGround() && !player.isInLava() && !player.isTouchingWater()
            && !player.isOnFire() && !player.hasVehicle() && !hazards.lavaNear(player.getBoundingBox(), 0.12, tick);
        if (lavaEmergency) {
            if (dry && escapePlanned && escapeLanding == null && player.getVelocity().horizontalLengthSquared() < 0.0064) {
                if (++stableDryTicks >= 5) lavaEmergency = false;
            } else stableDryTicks = 0;
        }
        if (!lavaEmergency && dry) {
            Vec3d feet = player.getPos();
            if (dryFooting == null || feet.squaredDistanceTo(dryFooting) >= 0.49) {
                previousDryFooting = dryFooting;
                previousDryFootingTick = dryFootingTick;
                dryFooting = feet;
            }
            dryFootingTick = tick;
        }
    }

    void safetySpend(Predicate<ItemStack> spend) { safetySpend = spend; }

    private boolean canWearSafetyItem(ItemStack stack) {
        return safetySpend == null || !stack.isDamageable() || safetySpend.test(stack);
    }

    private void resetIntentions() {
        dryLanding = null;
        centerLanding = null;
        forward = backward = fast = verifiedDescent = flatWalk = jumping = sneaking = swimmingDown = eating = false;
        emergencyWalk = false;
        dryRouteWalk = false;
        wetEscapeWalk = false;
        reachJump = false;
        routeJumps = true;
        rowForward = rowLeft = rowRight = boatDismount = false;
        mining = null;
        striking = null;
        shielding = null;
        raisedShieldBearing = null;
        rangedShieldYaw = Float.NaN;
        armor = null;
    }

    /** Withdraw ordinary work without clearing the rendered view or emergency state. */
    void pauseWork() {
        resetIntentions();
        steering = gaitSteering = fallSteering = fixedSteering = false;
        gaitPitchVelocity = 0;
        aimPoint = null;
        clearContact();
    }

    /** Called before GameRenderer computes this frame's camera and crosshair. */
    void frame() {
        long now = System.nanoTime();
        double elapsed = lastFrame == 0 ? 0 : (now - lastFrame) * 1e-9;
        double dt = Math.min(elapsed, 0.05);
        if (lastFrame != 0 && now - lastFrame > 150_000_000L) lookMotor.stop(now);
        lastFrame = now;
        if (!steering || !ready()) {
            lookMotor.stop(now);
            return;
        }
        if (dt <= 0) return;
        var player = client.player;
        Vec3d origin = aimPoint == null ? null
            : player.getCameraPosVec(client.getRenderTickCounter().getTickDelta(true));
        float yawBefore = player.getYaw(), pitchBefore = player.getPitch();
        float targetYaw = goalYaw(player, origin), targetPitch = goalPitch(origin);
        if (!gaitSteering && !fallSteering && !fixedSteering && !lavaEmergency) {
            lookMotor.step(lookContext, lookTarget, yawBefore, pitchBefore, targetYaw, targetPitch, dt, now, tick);
            if (lookMotor.yawStep() != 0 || lookMotor.pitchStep() != 0) {
                player.changeLookDirection(lookMotor.yawStep() / 0.15, lookMotor.pitchStep() / 0.15);
            }
            lookMotor.applied(MathHelper.wrapDegrees(player.getYaw() - yawBefore), player.getPitch() - pitchBefore,
                dt, elapsed, now);
            return;
        }
        double yaw = MathHelper.wrapDegrees(targetYaw - yawBefore);
        double pitch = targetPitch - pitchBefore;
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
            recordProtectedLook(AgentLookMotor.Context.GAIT, targetYaw, targetPitch, yawBefore, pitchBefore,
                Math.hypot(yaw, pitch), elapsed, now);
            return;
        }
        double distance = Math.hypot(yaw, pitch);
        if (distance >= 1e-4) {
            // A real fall can have only a few ticks of reach. Still use the mouse path.
            double fraction = fallSteering
                ? Math.min(-Math.expm1(-dt / 0.025), 920 * dt / distance)
                : Math.min(response, TURN_SPEED * dt / distance);
            player.changeLookDirection(yaw * fraction / 0.15, pitch * fraction / 0.15);
        }
        AgentLookMotor.Context context = fallSteering ? AgentLookMotor.Context.FALL
            : lavaEmergency ? AgentLookMotor.Context.URGENT : lookContext;
        recordProtectedLook(context, targetYaw, targetPitch, yawBefore, pitchBefore, distance, elapsed, now);
    }

    private void recordProtectedLook(AgentLookMotor.Context context, float yaw, float pitch, float beforeYaw,
                                     float beforePitch, double remaining, double dt, long now) {
        lookMotor.legacy(context, yaw, pitch, remaining, MathHelper.wrapDegrees(client.player.getYaw() - beforeYaw),
            client.player.getPitch() - beforePitch, dt, now, tick);
    }

    /** Called at WorldRenderEvents.START, when the actual render projection is available. */
    void observeFrame(WorldRenderContext context) {
        if (!ready() || context.camera().getFocusedEntity() != client.player) {
            clearView();
            return;
        }
        long now = System.nanoTime();
        float yaw = context.camera().getYaw(), pitch = context.camera().getPitch();
        boolean sameView = observedWorld == context.world() && observedPlayer == client.player;
        if (sameView && observedAtNanos != 0 && now > observedAtNanos && now - observedAtNanos <= 100_000_000L) {
            double seconds = (now - observedAtNanos) * 1e-9;
            observedYawSpeed = MathHelper.wrapDegrees(yaw - observedYaw) / seconds;
            observedPitchSpeed = (pitch - observedPitch) / seconds;
        } else {
            observedYawSpeed = observedPitchSpeed = 0;
            if (!sameView) clearContact();
        }
        observedWorld = context.world();
        observedPlayer = client.player;
        observedAtTick = tick;
        eye = context.camera().getPos();
        observedYaw = yaw;
        observedPitch = pitch;
        observedAtNanos = now;
        ++frameSequence;
        renderedCrosshair = client.crosshairTarget;
        if (contact != null && tick - contactTick <= 1) noteRenderedEntry();
        viewProjection.set(context.projectionMatrix()).mul(context.positionMatrix());
        inverseViewProjection.set(viewProjection).invert();
    }

    private void clearView() {
        observedWorld = null;
        observedPlayer = null;
        eye = null;
        renderedCrosshair = null;
        observedAtNanos = 0;
        clearContact();
    }

    void finish() {
        if (!ready()) {
            gaitPitchVelocity = 0;
            stepSupport = null;
            releaseKeys();
            return;
        }
        var player = client.player;
        var options = client.options;
        if (controlledBoat != null && player.getVehicle() != controlledBoat) controlledBoat = null;
        if (lavaEmergency) {
            stepSupport = null;
            clearContact();
            finishLavaEscape(player);
            return;
        }
        boolean advance = forward && (!steering
            || Math.abs(MathHelper.wrapDegrees(goalYaw(player, player.getEyePos()) - player.getYaw())) <= 28);
        boolean retreat = backward;
        boolean dive = swimmingDown && player.isTouchingWater() && player.getAir() >= 70;
        boolean crouch = sneaking || dive;
        boolean jump = jumping || !dive && (player.isSubmergedInWater()
            || !wetEscapeWalk && (advance || retreat) && player.isTouchingWater());
        boolean stepJump = false;
        Ground ground = Ground.CLEAR;

        if (flatWalk && advance) {
            // The caller has checked a dry lane and sweep. Never inherit the ordinary
            // auto-jump, crouching advance, sprint latch, or tolerance for a lost render.
            double distance = Math.hypot(dryLanding.x - player.getX(), dryLanding.z - player.getZ());
            advance = hasView() && player.isOnGround() && (emergencyWalk || !player.horizontalCollision)
                && distance > Math.max(0.12, 2.6 * Math.sqrt(player.getVelocity().horizontalLengthSquared()))
                && Math.abs(MathHelper.wrapDegrees(goalYaw(player, player.getEyePos()) - player.getYaw())) <= 6;
        } else if (!dryRouteWalk && !wetEscapeWalk && controlledBoat == null && advance
                && player.isOnGround() && !player.isTouchingWater()) {
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
        if (raisedShieldBearing != null) {
            // With no new view, never start using an item or inspect the old target.
            use = !options.useKey.isUnbound() && player.isUsingItem() && player.getActiveItem().isOf(Items.SHIELD)
                && canWearSafetyItem(player.getActiveItem())
                && facesShieldBearing(player, raisedShieldBearing.x, raisedShieldBearing.z);
        } else if ((shielding != null || Float.isFinite(rangedShieldYaw)) && !options.useKey.isUnbound()) {
            boolean facing = shielding != null
                ? shielding.isAlive() && facesShieldBearing(player, shielding.getX(), shielding.getZ())
                : Math.abs(MathHelper.wrapDegrees(rangedShieldYaw - player.getYaw())) <= 32;
            if (facing) {
                if (player.isUsingItem()) {
                    use = player.getActiveItem().isOf(Items.SHIELD) && canWearSafetyItem(player.getActiveItem());
                } else {
                    ItemStack main = player.getMainHandStack();
                    ItemStack shield = main.isOf(Items.SHIELD) ? main : player.getOffHandStack();
                    if (shield.isOf(Items.SHIELD) && canWearSafetyItem(shield) && !player.getItemCooldownManager().isCoolingDown(shield)
                            && shieldSafeMainHand(main) && (shielding != null || hasView())) {
                        HitResult actual = currentCrosshair();
                        if (actual instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK) {
                            // Sneak past station use; do not right-click a block with an axe.
                            crouch |= !main.isIn(ItemTags.AXES);
                            use = crouch && player.isSneaking() && !main.isIn(ItemTags.AXES);
                        } else {
                            use = actual != null && (actual.getType() == HitResult.Type.MISS
                                || actual instanceof EntityHitResult hit && (hit.getEntity() == shielding
                                    || shielding == null && hit.getEntity() instanceof Monster
                                    && renderedCrosshair instanceof EntityHitResult shown
                                    && shown.getEntity() == hit.getEntity()));
                        }
                    }
                }
            }
        } else if (armor != null && !options.useKey.isUnbound()) {
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
        } else if (mining != null || striking != null || eating) {
            HitResult actual = currentCrosshair();
            if (eating && player.getMainHandStack().contains(DataComponentTypes.FOOD)) {
                // Crouching skips ordinary block interaction; block items can still place.
                use = player.isUsingItem() || actual != null && actual.getType() == HitResult.Type.MISS
                    || actual instanceof BlockHitResult && player.isSneaking()
                        && !(player.getMainHandStack().getItem() instanceof BlockItem);
                crouch |= actual != null && actual.getType() == HitResult.Type.BLOCK;
            } else if (striking != null) {
                if (actual instanceof EntityHitResult hit && hit.getEntity() == striking
                        && striking.isAlive() && !player.isUsingItem()
                        && canWearSafetyItem(player.getMainHandStack())
                        && player.getAttackCooldownProgress(0.5f) >= 0.9f) {
                    pressKey(options.attackKey);
                }
            } else if (mining != null && contact != null && actual instanceof BlockHitResult hit) {
                attack = mining.equals(contact.pos) && contact.admits(hit);
            }
        }
        boolean sprintRequested = advance && fast && !crouch && ground == Ground.CLEAR;
        if (advance || retreat) {
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
        } else if (jump && !player.isTouchingWater()) {
            Vec3d motion = player.getVelocity();
            double drift = motion.horizontalLengthSquared();
            if (drift > 0.0016
                    && hazards.lavaRisk(player.getBoundingBox(), heading(motion.x, motion.z),
                        Math.sqrt(drift) * 9, 1.1, false, tick) > 0) jump = false;
        }
        // Vanilla latches sprint when Ctrl is released. Let up on W to brake, then walk again.
        if (advance && !sprintRequested && player.isSprinting()) advance = false;
        boolean centerKeys = centerLanding != null && controlledBoat == null
            && player.isOnGround() && !player.isTouchingWater() && player.getVehicle() == null;
        boolean centerLeft = false, centerRight = false;
        if (centerKeys) {
            double dx = centerLanding.x - player.getX(), dz = centerLanding.z - player.getZ();
            double distance = Math.hypot(dx, dz);
            double yaw = Math.toRadians(player.getYaw());
            double ahead = -Math.sin(yaw) * dx + Math.cos(yaw) * dz;
            double right = -Math.cos(yaw) * dx - Math.sin(yaw) * dz;
            advance = retreat = jump = sprintRequested = false;
            boolean adjust = distance > 0.08 && distance < 0.82 && (Math.abs(ahead) > 0.06 || Math.abs(right) > 0.06);
            // Slow the adjustment, not the settled stance. Holding sneak after
            // reaching the center would prevent callers from confirming standing room.
            crouch |= adjust || player.getVelocity().horizontalLengthSquared() > 0.0016;
            if (adjust &&
                hazards.lavaRisk(player.getBoundingBox(), heading(dx, dz), distance + 0.12, 0, false, tick) == 0) {
                advance = ahead > 0.06;
                retreat = ahead < -0.06;
                centerLeft = right < -0.06;
                centerRight = right > 0.06;
            }
        }
        if (controlledBoat != null) {
            boolean dry = !controlledBoat.isInLava() && !controlledBoat.isTouchingWater();
            advance = dry && rowForward
                && hazards.lavaRisk(controlledBoat.getBoundingBox(), controlledBoat.getYaw(), 1.6, 0, false, tick) == 0;
            retreat = jump = sprintRequested = attack = use = false;
            // Generic crouch/guard intentions must not eject the agent from a falling boat.
            crouch = dry && boatDismount && controlledBoat.isOnGround();
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
        // A second forward press can start vanilla sprint even with the sprint key up.
        // A paced approach can coast at the lip; don't turn its next pulse into a double-tap.
        if (advance && !options.forwardKey.isPressed()) {
            if ((flatWalk || dryRouteWalk) && !sprintRequested && tick - lastForwardPress < 8) {
                advance = false;
                jump = false;
            } else lastForwardPress = tick;
        }
        // Sample only an input about to reach vanilla, after movement and lava vetoes.
        if (routeJumps && jump && (advance || reachJump) && !fast && !crouch
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
        if (attack && mining != null) {
            if (lastHeldMineTick != tick - 1 || !mining.equals(lastHeldMine)) reportContact("started");
            lastHeldMine = mining;
            lastHeldMineTick = tick;
        } else if (mining != null) reportContact("vetoed");
        // Held for this tick only unless requested again; vanilla enforces its use delay.
        options.useKey.setPressed(use);
    }

    private void sightMovementLane(ClientPlayerEntity player, float yaw, double reach) {
        if (!hasView() || raysLeft <= 0) return;
        double angle = Math.toRadians(yaw);
        double dx = -Math.sin(angle), dz = Math.cos(angle);
        double distance = Math.min(AgentHazards.MAX_LANE, Math.max(2.25, reach + 0.20));
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

    boolean lavaEmergency() { return lavaEmergency; }

    boolean lavaBreachesDig(BlockPos foot) {
        if (!ready()) return false;
        var player = client.player;
        double dx = foot.getX() + 0.5 - player.getX(), dz = foot.getZ() + 0.5 - player.getZ();
        return dx * dx + dz * dz < 9 && Math.abs(foot.getY() - player.getY()) < 2
            && hazards.breachesDig(foot, player.getBlockPos(), tick);
    }

    void beginLavaEscape() {
        if (lavaEmergency) return;
        lavaEmergency = true;
        stableDryTicks = 0;
        escapeLanding = null;
        escapePlanned = false;
        escapeWater = null;
        escapeWaterAttempts = 0;
        escapeWaterTick = tick - 8;
        steering = false;
    }

    private void finishLavaEscape(ClientPlayerEntity player) {
        var options = client.options;
        releaseRowKeys();
        ownsKeys = true;
        options.attackKey.setPressed(false);
        options.useKey.setPressed(false);
        setSticky(options.sprintKey, false, options.getSprintToggled().getValue());
        setSticky(options.sneakKey, player.hasVehicle(), options.getSneakToggled().getValue());
        boolean move = false;
        boolean jump = false;
        if (!player.hasVehicle()) {
            if (!escapePlanned) {
                if (tick - dryFootingTick <= FOOTING_AGE) preferLavaExit(dryFooting);
                if (!escapePlanned && tick - previousDryFootingTick <= FOOTING_AGE) preferLavaExit(previousDryFooting);
                escapePlanned = true;
            }
            if (escapeLanding != null) {
                double dx = escapeLanding.x - player.getX(), dz = escapeLanding.z - player.getZ();
                double distance = Math.hypot(dx, dz), rise = escapeLanding.y - player.getY();
                float yaw = heading(dx, dz);
                double bearing = Math.toRadians(escapeHeading);
                double remaining = -Math.sin(bearing) * dx + Math.cos(bearing) * dz;
                raysLeft += MOVEMENT_RAYS;
                sightMovementLane(player, escapeHeading, distance);
                if (remaining > 0.22 && tick - escapeSince < ESCAPE_TICKS
                        && hazards.lavaRisk(player.getBoundingBox(), yaw, distance, Math.max(0, rise), true, tick) == 0) {
                    float facing = escapeHeading + (escapeBackward ? 180 : 0);
                    float error = Math.abs(MathHelper.wrapDegrees(facing - player.getYaw()));
                    if (error > 8) turn(facing, player.getPitch());
                    else steering = false;
                    move = error <= 9;
                    // A level tunnel is a backward walk, not a jump into the flow overhead.
                    jump = move && rise > 0.20 && (player.isInLava() || player.horizontalCollision);
                } else {
                    escapeLanding = null;
                    steering = false;
                }
            }
            if (escapeLanding == null) {
                useEscapeWater(player);
                jump = player.isTouchingWater() && player.getAir() < 70;
            }
        }
        options.forwardKey.setPressed(move && !escapeBackward);
        options.backKey.setPressed(move && escapeBackward);
        options.jumpKey.setPressed(jump);
    }

    /** Aiming at a floor is not a use receipt. Require the rendered face and the bucket's own ray. */
    private void useEscapeWater(ClientPlayerEntity player) {
        steering = false;
        if (!hasView() || !client.isWindowFocused() || client.getOverlay() != null
                || !World.OVERWORLD.equals(client.world.getRegistryKey()) || client.world.getDimension().ultrawarm()
                || !player.isOnGround() || player.isInLava() || player.isUsingItem()
                || client.interactionManager == null || client.interactionManager.isBreakingBlock()) return;
        var stack = player.getMainHandStack();
        if (safetySpend != null && !safetySpend.test(stack)) return;
        if (escapeWater != null && stack.isOf(Items.BUCKET) && player.isTouchingWater() && !player.isOnFire()
                && escapeWaterAttempts < 3 && tick - escapeWaterTick >= 8) {
            turn(player.getYaw(), 89.5f);
            BlockHitResult hit = itemRay(RaycastContext.FluidHandling.SOURCE_ONLY);
            var actual = currentCrosshair();
            if (hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(escapeWater)
                    && inView(hit.getPos()) && litFace(hit)
                    && actual instanceof BlockHitResult floor && floor.getType() == HitResult.Type.BLOCK
                    && floor.getSide() == Direction.UP && floor.getBlockPos().equals(escapeWater.down())
                    && client.world.getFluidState(escapeWater).isIn(FluidTags.WATER)
                    && pressKey(client.options.useKey)) {
                escapeWaterAttempts++;
                escapeWaterTick = tick;
            }
            return;
        }
        if (!player.isOnFire() || player.isTouchingWater() || !stack.isOf(Items.WATER_BUCKET)
                || escapeWaterAttempts >= 2 || tick - escapeWaterTick < 8) return;
        BlockPos support = player.getBlockPos().down();
        turn(player.getYaw(), 89.5f);
        BlockHitResult face = selectedFace();
        if (face == null || face.getSide() != Direction.UP || !face.getBlockPos().equals(support)
                || !inView(face.getPos()) || !litFace(face)) return;
        var state = client.world.getBlockState(support);
        // Natural ground avoids opening a station or altering a protected block on right click.
        if (!state.getFluidState().isEmpty() || !(state.isIn(BlockTags.BASE_STONE_OVERWORLD)
                || state.isIn(BlockTags.DIRT) || state.isOf(Blocks.COBBLESTONE) || state.isOf(Blocks.GRAVEL))) return;
        BlockHitResult hit = itemRay(RaycastContext.FluidHandling.NONE);
        if (hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(support)
                && hit.getSide() == Direction.UP && inView(hit.getPos()) && litFace(hit)
                && pressKey(client.options.useKey)) {
            escapeWater = support.up();
            escapeWaterAttempts++;
            escapeWaterTick = tick;
        }
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

    /** A motor veto on the selected support only. Never probe or expose the destination's state. */
    boolean canPlaceStationAcross(BlockHitResult support) {
        BlockHitResult now = selectedFace();
        if (!sameBlockFace(support, now) || now.isInsideBlock()) return false;
        var player = client.player;
        var placement = new ItemPlacementContext(player, Hand.MAIN_HAND, player.getMainHandStack(), now);
        return placement.getBlockPos().equals(now.getBlockPos().offset(now.getSide()));
    }

    void release() {
        resetIntentions();
        steering = false;
        gaitSteering = false;
        fallSteering = false;
        fixedSteering = false;
        controlledBoat = null;
        gaitPitchVelocity = 0;
        aimPoint = null;
        lastFrame = 0;
        finishWorldLook();
        clearView();
        hazards.clear();
        headroom.reset();
        hazardWorld = null;
        hazardPlayer = null;
        dryFooting = previousDryFooting = escapeLanding = null;
        lavaEmergency = false;
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
        fixedSteering = false;
        lookContext = AgentLookMotor.Context.NORMAL;
        lookTarget = null;
        gaitPitchVelocity = 0;
    }

    void aimFixed(Vec3d point) {
        aim(point);
        protectLook(AgentLookMotor.Context.PHYSICAL);
    }

    void aimFine(Vec3d point) { aimContactPoint(point, true); }

    void aimUrgent(Vec3d point) {
        aim(point);
        protectLook(AgentLookMotor.Context.URGENT);
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

    void turnScan(float yaw, float pitch) {
        turn(yaw, pitch);
        lookContext = AgentLookMotor.Context.SCAN;
    }

    void turnFine(float yaw, float pitch) {
        turn(yaw, pitch);
        lookContext = AgentLookMotor.Context.FINE;
    }

    void turnFixed(float yaw, float pitch) {
        turn(yaw, pitch);
        protectLook(AgentLookMotor.Context.PHYSICAL);
    }

    void turnUrgent(float yaw, float pitch) {
        turn(yaw, pitch);
        protectLook(AgentLookMotor.Context.URGENT);
    }

    private void protectLook(AgentLookMotor.Context context) {
        fixedSteering = true;
        fixedTick = tick;
        lookContext = context;
    }

    void finishWorldLook() { lookMotor.stop(System.nanoTime()); }

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
        fixedSteering = false;
        lookContext = AgentLookMotor.Context.NORMAL;
        lookTarget = null;
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

    /** Steering only. Neither a witness nor a valid crossing is an input request. */
    boolean aimContact(BlockHitResult witness, Contact mode) {
        return prepareContact(witness, mode) && contactProblem(false) == null;
    }

    private boolean prepareContact(BlockHitResult witness, Contact mode) {
        if (!hasView() || witness.getType() != HitResult.Type.BLOCK || witness.isInsideBlock()
                || mode == Contact.LEAP_PLACE && witness.getSide() != Direction.UP) return false;
        if (!inView(witness.getPos())) {
            if (mode != Contact.LEAP_PLACE) aimContactFallback(witness.getPos(), mode);
            return false;
        }
        if (contactTick == tick && mode == contactMode && contact != null && contact.sameSurface(witness))
            return true;
        var player = client.player;
        double reach = player.getBlockInteractionRange();
        if (witness.getPos().squaredDistanceTo(eye) > reach * reach) return false;
        boolean freshContact = contact == null || mode != contactMode || tick - contactTick > 2
            || !contact.sameSurface(witness);
        if (freshContact) {
            // Re-admit a candidate from an earlier sighting before using its present outline
            // shape. A stale witness can guide the view but never exposes a hidden shape.
            BlockHitResult live = contactRay(witness.getPos(), reach);
            if (!sameBlockFace(witness, live) && mode.allowsOutline()) {
                live = selectedFace();
                if (live != null && mode != Contact.OUTLINE && !litFace(live)) live = null;
            }
            if (!sameBlockFace(witness, live)) {
                if (mode != Contact.LEAP_PLACE) aimContactFallback(witness.getPos(), mode);
                return false;
            }
            witness = live;
        }
        // A currently visible change of block state invalidates the acquired region.
        BlockHitResult outline = freshContact ? witness : selectedFace();
        BlockState state = sameBlockFace(witness, outline)
            ? client.world.getBlockState(outline.getBlockPos()) : contactState;
        if (freshContact || state != contactState) {
            witness = outline;
            contact = new AgentFaceAim(witness, state.getOutlineShape(client.world, witness.getBlockPos(),
                ShapeContext.of(player)), mode.precise);
            contactMode = mode;
            contactState = state;
            contactPoint = null;
            contactProbeTick = tick - 3;
            contactCheckTick = -1;
            firstValidNanos = 0;
            contactStatus = null;
            noteRenderedEntry();
        }
        contactTick = tick;
        // A jump has one geometrical bearing and a short window in which its top
        // becomes visible. Acquiring that top authorizes contact, not a new turn.
        if (mode == Contact.LEAP_PLACE) return true;
        boolean stalled = contactPoint != null && tick - contactProbeTick >= 5 && aligned(contactPoint)
            && (!(renderedCrosshair instanceof BlockHitResult seen) || !contact.admits(seen));
        if ((contactPoint == null || stalled) && contactProbeFrame != frameSequence && tick - contactProbeTick >= 2) {
            contactProbeFrame = frameSequence;
            contactProbeTick = tick;
            Vec3d hit = witness.getPos();
            float yaw = (float) (observedYaw + MathHelper.clamp(observedYawSpeed, -TURN_SPEED, TURN_SPEED) * 0.045);
            float pitch = (float) MathHelper.clamp(observedPitch
                + MathHelper.clamp(observedPitchSpeed, -TURN_SPEED, TURN_SPEED) * 0.045, -90, 90);
            Vec3d continuation = contact.continuation(eye, player.getRotationVector(pitch, yaw), hit);
            if (visibleContact(continuation, reach)) {
                contactPoint = continuation;
            } else {
                Vec3d local = contact.inset(hit);
                if (!local.equals(continuation) && visibleContact(local, reach)) {
                    contactPoint = local;
                } else {
                    // A visible sliver may not contain the wide face inset. Narrow the
                    // region around that witnessed sliver; don't admit the whole face.
                    BlockHitResult sliver = contactRay(hit, reach);
                    if (!sameBlockFace(witness, sliver) && mode.allowsOutline()) sliver = outline;
                    if (sameBlockFace(witness, sliver) && contact.sameSurface(sliver)) {
                        AgentFaceAim narrow = new AgentFaceAim(sliver,
                            state.getOutlineShape(client.world, witness.getBlockPos(), ShapeContext.of(player)), true, true);
                        Vec3d precise = narrow.inset(sliver.getPos());
                        BlockHitResult tested = contactRay(precise, reach);
                        if ((tested != null && narrow.admits(tested))
                                || mode.allowsOutline() && narrow.admits(sliver)) {
                            contact = narrow;
                            contactPoint = precise;
                            firstValidNanos = 0;
                            noteRenderedEntry();
                        } else if (stalled) contactPoint = null;
                    } else if (stalled) contactPoint = null;
                }
            }
        }
        aimRegion(contact, contactPoint == null ? witness.getPos() : contactPoint, mode.precise);
        return true;
    }

    private void aimRegion(AgentFaceAim region, Vec3d point, boolean precise) {
        aimContactPoint(point, precise || !region.broadFrom(eye, point));
        lookTarget = region;
    }

    private void aimContactFallback(Vec3d point, Contact mode) {
        aimContactPoint(point, mode.precise);
    }

    private void aimContactPoint(Vec3d point, boolean precise) {
        AgentLookMotor.Context protectedContext = fixedSteering && fixedTick == tick ? lookContext : null;
        aim(point);
        if (protectedContext != null) protectLook(protectedContext);
        else if (precise) lookContext = AgentLookMotor.Context.FINE;
    }

    private boolean visibleContact(Vec3d point, double reach) {
        BlockHitResult hit = contactRay(point, reach);
        return hit != null && contact.admits(hit);
    }

    private BlockHitResult contactRay(Vec3d point, double reach) {
        double dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z;
        double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance <= 0.01 || distance > reach || !inView(point)) return null;
        double inset = 0.02 / distance;
        return litHit(point.add(dx * inset, dy * inset, dz * inset), Ray.SIGHT);
    }

    private static boolean sameBlockFace(BlockHitResult expected, BlockHitResult actual) {
        return actual != null && expected.getBlockPos().equals(actual.getBlockPos())
            && expected.getSide() == actual.getSide();
    }

    private void noteRenderedEntry() {
        if (renderedCrosshair instanceof BlockHitResult seen && contact.admits(seen)) {
            if (firstValidNanos == 0 && (contactMode == Contact.OUTLINE || litFace(seen))) {
                firstValidNanos = observedAtNanos;
                firstValidTick = observedAtTick;
            }
        } else {
            firstValidNanos = 0;
        }
    }

    private void clearContact() {
        contact = null;
        contactState = null;
        contactPoint = null;
        contactMode = null;
        contactStatus = null;
        contactCheckTick = -1;
        firstValidNanos = 0;
        lastHeldMine = null;
        sourceContact = null;
        sourcePoint = null;
        sourceStatus = null;
        sourceValidNanos = 0;
    }

    private String checkContactRays() {
        if (!hasView() || contact == null
                || !(renderedCrosshair instanceof BlockHitResult seen) || !contact.matches(seen)
                || !(currentCrosshair() instanceof BlockHitResult now) || !contact.matches(now))
            return "ray_disagree";
        if (!contact.admits(seen) || !contact.admits(now)) return "outside_region";
        if (!inView(now.getPos()) || contactMode != Contact.OUTLINE && (!litFace(seen) || !litFace(now)))
            return "vetoed";
        if (!contactMode.allowsOutline() && !visibleContact(seen.getPos(), client.player.getBlockInteractionRange()))
            return "vetoed";
        return client.world.getBlockState(now.getBlockPos()) != contactState ? "vetoed" : null;
    }

    private String contactProblem(boolean predict) {
        if (contactCheckTick != tick) {
            contactCheckTick = tick;
            contactBaseline = checkContactRays();
        }
        if (contactBaseline != null || !predict) return contactBaseline;
        return predictedContact(contact, contactMode.predictionSeconds) ? null : "latency_veto";
    }

    private boolean predictedContact(AgentFaceAim region, double seconds) {
        var player = client.player;
        // This guard does not authorize future contact. The same-thread TICK ray above
        // is authoritative; a brief lead only avoids committing while exiting its region.
        float yaw = (float) (player.getYaw() + MathHelper.clamp(observedYawSpeed, -TURN_SPEED, TURN_SPEED) * seconds);
        float pitch = (float) MathHelper.clamp(player.getPitch()
            + MathHelper.clamp(observedPitchSpeed, -TURN_SPEED, TURN_SPEED) * seconds, -90, 90);
        Vec3d motion = player.getVelocity();
        // Vanilla clips downward movement at the floor, then adds gravity to the
        // stored velocity for its next tick. A grounded eye does not descend
        // through the floor during this short lead.
        double vertical = player.isOnGround() ? Math.max(0, motion.y) : motion.y;
        Vec3d futureEye = player.getEyePos().add(motion.x * 20 * seconds, vertical * 20 * seconds,
            motion.z * 20 * seconds);
        return region.willRemainInside(futureEye, player.getRotationVector(pitch, yaw),
            player.getBlockInteractionRange());
    }

    private void reportContact(String status) {
        if (contact == null) return;
        if (status.equals(contactStatus) && !"issued".equals(status) && !"started".equals(status)) return;
        contactStatus = status;
        BlockHitResult hit = currentCrosshair() instanceof BlockHitResult now && contact.matches(now) ? now : null;
        Vec3d point = hit == null ? null : hit.getPos();
        emitContact(contactMode.action, status, contact.pos, contact.side,
            point == null ? Double.NaN : contact.u(point), point == null ? Double.NaN : contact.v(point),
            firstValidNanos == 0 ? -1 : tick - firstValidTick,
            firstValidNanos == 0 ? -1 : (System.nanoTime() - firstValidNanos) / 1_000_000);
    }

    private void emitContact(String action, String status, BlockPos pos, Direction side, double u, double v,
                             int dwellTicks, long dwellMs) {
        contactEvidence.accept(new ContactEvidence(tick, frameSequence, System.currentTimeMillis(), action, status,
            pos, side, u, v, Math.hypot(observedYawSpeed, observedPitchSpeed), dwellTicks, dwellMs));
    }

    boolean useContact(BlockHitResult witness, Contact mode) {
        return useContact(witness, mode, Preparation.READY);
    }

    /** Observe the same contact during preparation, but only READY may emit a use edge. */
    boolean useContact(BlockHitResult witness, Contact mode, Preparation preparation) {
        if (!prepareContact(witness, mode)) return false;
        String problem = contactProblem(true);
        if (problem == null && mode == Contact.BUCKET) {
            // BucketItem has a separate OUTLINE/NONE ray: agree on its actual subregion too.
            BlockHitResult hit = itemRay(RaycastContext.FluidHandling.NONE);
            if (!contact.admits(hit) || !inView(hit.getPos()) || !litFace(hit)) problem = "ray_disagree";
        }
        if (problem == null) problem = useReadiness(preparation, mode != Contact.INTERACT);
        if (problem == null && !pulseContactUse()) problem = "input_refused";
        reportContact(problem == null ? "issued" : problem);
        return problem == null;
    }

    /** Report an intentionally withheld action only after a caller has aimed a witnessed face. */
    void vetoContact(String reason) {
        if (contactTick == tick && firstValidNanos != 0) reportContact(reason);
    }

    void awaitingContactEquipment() {
        if (contactTick == tick && contactProblem(false) == null)
            reportContact(Preparation.EQUIPMENT.waitReason);
    }

    private boolean pulseContactUse() {
        if (tick == lastContactUse || controlledBoat != null || !fallUseReady() || !pressKey(client.options.useKey))
            return false;
        lastContactUse = tick;
        return true;
    }

    private String useReadiness(Preparation preparation, boolean usesMainHandItem) {
        if (preparation.waitReason != null) return preparation.waitReason;
        var player = client.player;
        ItemStack main = player.getMainHandStack();
        // Fresh key edges do not inherit vanilla's held-use repeat interval.
        return usesMainHandItem && !main.isEmpty() && player.getItemCooldownManager().isCoolingDown(main)
            ? "item_cooldown" : null;
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
    boolean repairHeadroom(AgentTools tools, Predicate<BlockPos> protectedBlock) {
        return headroom.step(tick, tools, protectedBlock);
    }
    AgentHeadroom.Report headroomReport() { return headroom.report(); }
    void observeHeadroomBreak(BlockPos position) { headroom.broken(position); }

    void sneak() { sneaking = true; }
    void swimDown() { swimmingDown = true; }
    void holdUse() { eating = true; }

    boolean miningFootingRefused(BlockPos target) {
        return contactTick == tick && contactMode == Contact.MINE && contact != null
            && target.equals(contact.pos) && SUPPORTING_FOOTPRINT.equals(contactStatus);
    }

    /** Only for a presently admitted mine contact, with its current visible block state. */
    private boolean refuseSupportingMine() {
        var player = client.player;
        Box hull = player.getBoundingBox();
        BlockPos pos = contact.pos;
        double foot = hull.minY - pos.getY();
        if (foot <= 0.0) return false;

        if (rayShapeContext == null) rayShapeContext = ShapeContext.of(player);
        VoxelShape shape = contactState.getCollisionShape(client.world, pos, rayShapeContext);
        double allowance = 0.02;
        boolean supports;
        if (shape == VoxelShapes.fullCube()) {
            // The center may be over air while only one edge of the hull rests on this block.
            int x = pos.getX(), z = pos.getZ();
            supports = foot >= 1.0 - 1e-7 && foot < 1.0 + allowance
                && x + 1.0 > hull.minX + 1e-7 && x < hull.maxX - 1e-7
                && z + 1.0 > hull.minZ + 1e-7 && z < hull.maxZ - 1e-7;
        } else {
            // Test the real surface, not the enclosing box of a stair, slab, or fence.
            supports = !shape.isEmpty() && shape.getMax(Direction.Axis.Y) > foot - allowance
                && shape.calculateMaxDistance(Direction.Axis.Y,
                    hull.offset(-pos.getX(), -pos.getY(), -pos.getZ()), -allowance) > -allowance;
        }
        if (!supports) return false;
        mining = null;
        reportContact(SUPPORTING_FOOTPRINT);
        return true;
    }

    boolean mine(BlockHitResult witness) {
        if (!prepareContact(witness, Contact.MINE)) return false;
        boolean held = witness.getBlockPos().equals(lastHeldMine) && lastHeldMineTick == tick - 1;
        String problem = contactProblem(!held);
        if (problem == null && (client.options.attackKey.isUnbound() || !client.isWindowFocused()
                || client.getOverlay() != null || client.player.isUsingItem() || client.player.hasVehicle()
                || lavaEmergency)) problem = "input_refused";
        if (problem != null) {
            reportContact(problem);
            return false;
        }
        if (refuseSupportingMine()) return false;
        mining = contact.pos;
        return true;
    }

    /** Do not start an attack from an old view; only bridge a short gap in an existing crack. */
    boolean continueMine(BlockPos target) {
        if (contact == null || contactMode != Contact.MINE || !target.equals(lastHeldMine)
                || lastHeldMineTick != tick - 1 || !ready() || observedWorld != client.world
                || observedPlayer != client.player || tick - observedAtTick > 3
                || client.getOverlay() != null || !client.isWindowFocused() || client.player.isUsingItem()
                || client.player.hasVehicle() || lavaEmergency || client.options.attackKey.isUnbound()
                || client.interactionManager == null || !client.interactionManager.isBreakingBlock()
                || !(renderedCrosshair instanceof BlockHitResult seen) || !contact.admits(seen)
                || !(currentCrosshair() instanceof BlockHitResult now) || !contact.admits(now)
                || client.world.getBlockState(target) != contactState) return false;
        contactTick = tick;
        if (refuseSupportingMine()) return false;
        if (contactPoint != null) aimRegion(contact, contactPoint, false);
        mining = target;
        return true;
    }
    void strike(Entity target) { striking = target; }

    boolean strikeTarget(Entity target) {
        return hasView() && currentCrosshair() instanceof EntityHitResult hit && hit.getEntity() == target;
    }

    boolean hasRecentView() { return hasView(); }

    long renderedFrame() { return frameSequence; }

    boolean renderedDirection(float yaw, float pitch, float tolerance) {
        return hasView() && Math.abs(MathHelper.wrapDegrees(observedYaw - yaw)) <= tolerance
            && Math.abs(observedPitch - pitch) <= tolerance;
    }

    boolean renderedAim(Vec3d point, float tolerance) {
        return hasView() && renderedDirection(heading(point.x - eye.x, point.z - eye.z),
            (float) Math.toDegrees(Math.atan2(eye.y - point.y, Math.hypot(point.x - eye.x, point.z - eye.z))),
            tolerance);
    }

    /** One panoramic sector from the actually rendered view, not a skylight or terrain-column query. */
    int supplyPerspective(float yaw) {
        if (!hasView()) return 0;
        var player = client.player;
        Vec3d left = eye.add(player.getRotationVector(-26, yaw - 22).multiply(MAX_RANGE));
        Vec3d right = eye.add(player.getRotationVector(-26, yaw + 22).multiply(MAX_RANGE));
        Vec3d high = eye.add(player.getRotationVector(-71, yaw).multiply(MAX_RANGE));
        if (clearPoint(high, Ray.SIGHT) && clearPoint(left, Ray.SIGHT) && clearPoint(right, Ray.SIGHT))
            return SUPPLY_OPEN;
        Vec3d roof = eye.add(player.getRotationVector(-62, yaw).multiply(9));
        Vec3d wall = eye.add(player.getRotationVector(-12, yaw).multiply(7));
        BlockHitResult overhead = inView(roof) ? visibleHit(roof, Ray.TERRAIN) : null;
        BlockHitResult ahead = inView(wall) ? visibleHit(wall, Ray.TERRAIN) : null;
        // The selected outline still shows geometry in dim light. It supplies no material.
        BlockHitResult outlined = selectedFace();
        boolean roofSeen = overhead != null && overhead.getSide() == Direction.DOWN
            || outlined != null && outlined.getSide() == Direction.DOWN
                && outlined.getPos().squaredDistanceTo(eye) < 16;
        boolean wallSeen = ahead != null && ahead.getSide().getOffsetY() == 0
            || outlined != null && outlined.getSide().getOffsetY() == 0
                && outlined.getPos().squaredDistanceTo(eye) < 9;
        return (roofSeen ? SUPPLY_ROOF : 0) | (wallSeen ? SUPPLY_WALL : 0);
    }

    /** Frustum preview only; no outside-view raycast or new world observation. */
    boolean macroRetainsView(Vec3d point, Vec3d feet, float yaw, float pitch) {
        if (!hasView()) return false;
        var player = client.player;
        Vec3d proposedEye = player.getEyePos().add(feet.subtract(player.getPos()));
        Vec3d relative = point.subtract(proposedEye);
        Vec3d forward = player.getRotationVector(pitch, yaw);
        Vec3d horizontal = player.getRotationVector(0, yaw - 90);
        Vec3d vertical = forward.crossProduct(horizontal);
        Vec3d oldForward = player.getRotationVector(observedPitch, observedYaw);
        Vec3d oldHorizontal = player.getRotationVector(0, observedYaw - 90);
        Vec3d oldVertical = oldForward.crossProduct(oldHorizontal);
        // Keep a little margin for interpolation. Only the current lit ray can
        // confirm the face after the preview is actually rendered.
        Vec3d mapped = oldForward.multiply(relative.dotProduct(forward))
            .add(oldHorizontal.multiply(relative.dotProduct(horizontal) * 1.04))
            .add(oldVertical.multiply(relative.dotProduct(vertical) * 1.04));
        return inView(eye.add(mapped));
    }

    boolean macroVisible(BlockHitResult witness, double reach) {
        return hasView() && matchesHit(witness, witness.getBlockPos(), reach);
    }

    /** Re-witness the same admitted face, not another face of the same block. */
    BlockHitResult macroMineWitness(BlockHitResult witness, double reach) {
        if (!hasView()) return null;
        if (contact != null && contactMode == Contact.MINE && contact.sameSurface(witness)) {
            if (contactPoint != null) {
                BlockHitResult pinned = contactRay(contactPoint, reach);
                if (sameBlockFace(witness, pinned)) return pinned;
            }
            BlockHitResult selected = selectedFace();
            if (sameBlockFace(witness, selected)) {
                BlockHitResult live = contactRay(selected.getPos(), reach);
                if (sameBlockFace(witness, live)) return live;
            }
        }
        BlockHitResult live = contactRay(witness.getPos(), reach);
        return sameBlockFace(witness, live) ? live : null;
    }

    boolean macroLavaNear() {
        return hazards.lavaNear(client.player.getBoundingBox(), 0.65, tick);
    }

    boolean keysNeutral() {
        var keys = client.options;
        return !keys.forwardKey.isPressed() && !keys.backKey.isPressed() && !keys.leftKey.isPressed()
            && !keys.rightKey.isPressed() && !keys.jumpKey.isPressed() && !keys.sprintKey.isPressed()
            && !keys.sneakKey.isPressed() && !keys.attackKey.isPressed() && !keys.useKey.isPressed();
    }

    Vec3d continuityLanding() {
        if (!client.options.forwardKey.isPressed()) return null;
        return dryLanding != null ? dryLanding : stepDriveTick == tick && stepSupport != null ? stepLanding : null;
    }

    BlockPos continuityMiningTarget() {
        return lastHeldMineTick == tick && client.options.attackKey.isPressed() ? lastHeldMine : null;
    }

    /** Only an adjacent same-height destination whose full top is lit in this frame. */
    BlockHitResult macroFloor(BlockPos floor) {
        if (!hasView()) return null;
        double top = floor.getY() + 1;
        for (double xOffset : MACRO_FLOOR_OFFSETS) {
            for (double zOffset : MACRO_FLOOR_OFFSETS) {
                double x = floor.getX() + 0.5 + xOffset, z = floor.getZ() + 0.5 + zOffset;
                // At a shallow pitch, the camera can see the outer part of a tile but not its center.
                if (!inView(x, top, z)) continue;
                Vec3d end = new Vec3d(x, top - 0.032, z);
                BlockHitResult visible = visibleHit(end, Ray.FLUIDS);
                if (visible == null || visible.getSide() != Direction.UP) continue;
                BlockHitResult hit = visible;
                if (!visible.getBlockPos().equals(floor)) {
                    // A one-layer snow cover is drawn above the actual full supporting cube.
                    // Only confirm the collision floor behind that specific visible cover.
                    if (!visible.getBlockPos().equals(floor.up())) continue;
                    BlockState cover = client.world.getBlockState(visible.getBlockPos());
                    if (!cover.isOf(Blocks.SNOW) || cover.get(SnowBlock.LAYERS) != 1) continue;
                    hit = visibleHit(end, Ray.TERRAIN);
                }
                if (hit != null && hit.getBlockPos().equals(floor) && hit.getSide() == Direction.UP
                        && Math.abs(hit.getPos().y - top) <= 0.03 && fullStepSupport(hit)
                        && clearPoint(new Vec3d(x, top + 0.18, z), Ray.FLUIDS)) return hit;
            }
        }
        return null;
    }

    /** Mechanical collision veto over one already witnessed sweep; it supplies no new target. */
    boolean macroFlatLane(BlockPos floor, BlockState witnessed, Vec3d landing) {
        if (!hasView() || lavaEmergency) return false;
        var player = client.player;
        double dx = landing.x - player.getX(), dz = landing.z - player.getZ();
        if (Math.abs(player.getY() - landing.y) > 0.055 || dx * dx + dz * dz > 2.56
                || client.world.getBlockState(floor) != witnessed || !witnessed.getFluidState().isEmpty()
                || !player.isOnGround() || player.isTouchingWater() || player.horizontalCollision
                || hazardAhead(heading(dx, dz), Math.max(0.65, Math.hypot(dx, dz) + 0.25))) return false;
        return client.world.isSpaceEmpty(player, player.getBoundingBox().stretch(dx, 0, dz));
    }

    enum DryRouteSample { CLEAR, UNKNOWN, DARK, OBSTRUCTION, FLUID }

    /** A missing render or ray allocation is unknown; only a lit actual hit can close a lane. */
    DryRouteSample dryRouteClear(Vec3d point) {
        if (!hasView() || raysLeft <= 0 || !inView(point)) return DryRouteSample.UNKNOWN;
        raysLeft--;
        BlockHitResult hit = raycast(point, Ray.TERRAIN);
        if (hit.getType() == HitResult.Type.MISS)
            return lit(point.x, point.y, point.z) ? DryRouteSample.CLEAR : DryRouteSample.DARK;
        if (!inView(hit.getPos())) return DryRouteSample.UNKNOWN;
        if (!litFace(hit)) return DryRouteSample.DARK;
        BlockState shown = client.world.getBlockState(hit.getBlockPos());
        if (!shown.getFluidState().isEmpty()) {
            hazards.observe(hit, AgentHazards.kind(shown), eye, eye.squaredDistanceTo(hit.getPos()), tick);
            return DryRouteSample.FLUID;
        }
        return hit.getBlockPos().equals(BlockPos.ofFloored(point))
            ? DryRouteSample.OBSTRUCTION : DryRouteSample.UNKNOWN;
    }

    BlockHitResult dryRouteFloor(Vec3d belowTop, BlockPos floor) {
        if (!hasView() || !inView(belowTop)) return null;
        BlockHitResult hit = visibleHit(belowTop, Ray.TERRAIN);
        if (hit == null || !matchesDryRouteTop(hit, floor)) return null;
        return stableDryRouteTop(floor, client.world.getBlockState(hit.getBlockPos())) ? hit : null;
    }

    enum DryRouteTop { WITNESSED, OUT_OF_VIEW, OCCLUDED, DARK, FLUID, NO_FULL_TOP, UNSUITABLE_TOP }

    DryRouteTop dryRouteTop(Vec3d belowTop, BlockPos floor) {
        return dryRouteTop(belowTop, floor, false);
    }

    DryRouteTop dryRouteTop(Vec3d belowTop, BlockPos floor, boolean distinguishUnsuitable) {
        if (!hasView() || raysLeft <= 0 || !inView(belowTop)) return DryRouteTop.OUT_OF_VIEW;
        raysLeft--;
        BlockHitResult hit = raycast(belowTop, Ray.TERRAIN);
        if (hit.getType() == HitResult.Type.MISS)
            return lit(belowTop.x, belowTop.y, belowTop.z) ? DryRouteTop.NO_FULL_TOP : DryRouteTop.DARK;
        if (!inView(hit.getPos())) return DryRouteTop.OUT_OF_VIEW;
        if (!litFace(hit)) return DryRouteTop.DARK;
        BlockState shown = client.world.getBlockState(hit.getBlockPos());
        if (!shown.getFluidState().isEmpty()) {
            hazards.observe(hit, AgentHazards.kind(shown), eye, eye.squaredDistanceTo(hit.getPos()), tick);
            return DryRouteTop.FLUID;
        }
        if (!floor.equals(hit.getBlockPos())) return DryRouteTop.OCCLUDED;
        return matchesDryRouteTop(hit, floor) && stableDryRouteTop(floor, shown)
            ? DryRouteTop.WITNESSED : distinguishUnsuitable ? DryRouteTop.UNSUITABLE_TOP : DryRouteTop.NO_FULL_TOP;
    }

    private static boolean matchesDryRouteTop(BlockHitResult hit, BlockPos floor) {
        return floor.equals(hit.getBlockPos()) && hit.getSide() == Direction.UP
            && Math.abs(hit.getPos().y - floor.getY() - 1) <= 0.035;
    }

    private boolean stableDryRouteTop(BlockPos floor, BlockState shown) {
        return !(shown.getBlock() instanceof FallingBlock) && fullStepSupport(floor, shown);
    }

    boolean dryRouteView() { return hasView(); }

    /** A full, visible surface top. Falling material gets a separate under-load veto, not a cave proof. */
    BlockState overlandTop(BlockPos floor, Direction travel, Predicate<BlockState> dangerous) {
        if (!hasView()) return null;
        Vec3d center = Vec3d.ofBottomCenter(floor.up()).add(0, -0.03, 0);
        // The far part of a lower top can be seen just beyond the near lip.
        BlockHitResult hit = visibleOverlandTop(center.add(travel.getOffsetX() * 0.34, 0,
            travel.getOffsetZ() * 0.34), floor);
        if (hit == null) hit = visibleOverlandTop(center, floor);
        if (hit == null) return null;
        BlockState material = client.world.getBlockState(floor);
        return !dangerous.test(material) && fullStepSupport(floor, material)
            && overlandLoadHolds(client.world, floor, material, overlandProbe) ? material : null;
    }

    private BlockHitResult visibleOverlandTop(Vec3d point, BlockPos floor) {
        if (!inView(point)) return null;
        BlockHitResult hit = visibleHit(point, Ray.TERRAIN);
        return hit != null && matchesDryRouteTop(hit, floor) ? hit : null;
    }

    /** Mechanical veto on a witnessed top or actual contact only; no hidden support is offered as a foothold. */
    static boolean overlandLoadHolds(BlockView world, BlockPos floor, BlockState material, BlockPos.Mutable below) {
        if (!(material.getBlock() instanceof FallingBlock)) return true;
        below.set(floor);
        for (int depth = 0; depth < 12; depth++) {
            BlockState bearing = world.getBlockState(below.move(Direction.DOWN));
            if (FallingBlock.canFallThrough(bearing)) return false;
            if (!(bearing.getBlock() instanceof FallingBlock)) return true;
        }
        return false;
    }

    boolean overlandClear(Vec3d point, Predicate<BlockState> dangerous) {
        if (dryRouteClear(point) != DryRouteSample.CLEAR) return false;
        // Only a lit, unoccluded sample can classify a collisionless hazard at this point.
        return !dangerous.test(client.world.getBlockState(BlockPos.ofFloored(point)));
    }

    /** Recheck just the observed lane and actual source contact. Reuse the dry-route input driver below. */
    boolean overlandLane(BlockPos from, BlockPos[] path, BlockState[] supports, int length,
                         Direction travel, Predicate<BlockState> dangerous) {
        if (!hasView() || lavaEmergency) return false;
        var player = client.player;
        if (player.isTouchingWater() || player.isInLava() || player.isOnFire() || player.hasVehicle()
                || player.hurtTime > 0) return false;
        BlockPos source = overlandProbe.set(from).move(Direction.DOWN);
        BlockState takeoff = client.world.getBlockState(source);
        if (!fullStepSupport(source, takeoff) || dangerous.test(takeoff)
                || !overlandLoadHolds(client.world, source, takeoff, overlandProbe)) return false;
        for (int i = 0; i < length; i++) {
            BlockPos foot = path[i];
            BlockPos floor = overlandProbe.set(foot).move(Direction.DOWN);
            if (client.world.getBlockState(floor) != supports[i]
                    || !overlandLoadHolds(client.world, floor, supports[i], overlandProbe)) return false;
            BlockState legs = client.world.getBlockState(foot);
            BlockState head = client.world.getBlockState(overlandProbe.set(foot).move(Direction.UP));
            if (!legs.getFluidState().isEmpty() || !head.getFluidState().isEmpty()
                    || dangerous.test(legs) || dangerous.test(head)) return false;
        }

        BlockPos to = path[length - 1];
        int dx = travel.getOffsetX(), dz = travel.getOffsetZ();
        double x = from.getX() + 0.5, z = from.getZ() + 0.5;
        double along = (player.getX() - x) * dx + (player.getZ() - z) * dz;
        double across = (player.getX() - x) * dz - (player.getZ() - z) * dx;
        var velocity = player.getVelocity();
        double drift = across + 2.45 * (velocity.x * dz - velocity.z * dx);
        if (Math.abs(across) > 0.21 || Math.abs(drift) > 0.21 || along < -0.25 || along > length + 0.26
                || hazardAhead(travel.getPositiveHorizontalDegrees(), Math.max(0.7, length + 0.4 - along))) return false;
        double half = player.getWidth() * 0.5 + 0.055;
        double cross = Math.abs(drift) > Math.abs(across) ? drift : across;
        if (to.getY() != from.getY()) {
            if (length != 1 || !dryRouteSweep(from, to)) return false;
            // Clear the jump apex as well as the standing sweep, including the reverse of a descent.
            double top = Math.max(from.getY(), to.getY());
            Box crown = new Box(x - half, top + 1.79, z - half, x + half, top + 2.10, z + half)
                .stretch(cross * dz, 0, -cross * dx);
            return client.world.isSpaceEmpty(player, crown.stretch(dx, 0, dz));
        }
        double y = from.getY();
        if (!player.isOnGround() || Math.abs(player.getY() - y) > 0.055) return false;
        Box sweep = new Box(x - half, y + 0.015, z - half, x + half, y + 1.80, z + half)
            .stretch(cross * dz, 0, -cross * dx);
        return client.world.isSpaceEmpty(player, sweep.stretch(dx * length, 0, dz * length));
    }

    enum DryRouteVeto { CLEAR, VIEW, HAZARD, DRIFT, SWEEP, SUPPORT }

    boolean dryRouteSweep(BlockPos from, BlockPos to) {
        return dryRouteVeto(from, to) == DryRouteVeto.CLEAR;
    }

    enum FootholdSpace { EMPTY, VIEW, DARK, OCCLUDED, OCCUPIED, FLUID }

    static Vec3d footholdInterior(BlockPos cell, Direction bearing, boolean high) {
        double along = high ? -0.16 : 0.16;
        return Vec3d.ofCenter(cell).add(bearing.getOffsetX() * along, high ? 0.31 : -0.20, bearing.getOffsetZ() * along);
    }

    static Vec3d footholdAttachmentAim(BlockPos anchor, Direction offset, Direction bearing) {
        return offset == Direction.DOWN
            ? Vec3d.ofCenter(anchor, 0.96).add(bearing.getOffsetX() * 0.30, 0, bearing.getOffsetZ() * 0.30)
            : Vec3d.ofCenter(anchor, 0.77).add(-offset.getOffsetX() * 0.46, 0, -offset.getOffsetZ() * 0.46);
    }

    /** Verify this exact adjacent build cell through a lit, unobstructed first-person ray. */
    FootholdSpace footholdSpace(Vec3d point) {
        if (!hasView() || raysLeft <= 0 || !inView(point)) return FootholdSpace.VIEW;
        raysLeft--;
        BlockHitResult hit = raycast(point, Ray.FLUIDS);
        BlockPos cell = BlockPos.ofFloored(point);
        if (hit.getType() != HitResult.Type.MISS) {
            if (!inView(hit.getPos())) return FootholdSpace.VIEW;
            if (!litFace(hit)) return FootholdSpace.DARK;
            if (!hit.getBlockPos().equals(cell)) return FootholdSpace.OCCLUDED;
            return client.world.getBlockState(hit.getBlockPos()).getFluidState().isEmpty()
                ? FootholdSpace.OCCUPIED : FootholdSpace.FLUID;
        }
        if (!lit(point.x, point.y, point.z)) return FootholdSpace.DARK;
        BlockState material = client.world.getBlockState(cell);
        return !material.getFluidState().isEmpty() ? FootholdSpace.FLUID
            : material.isAir() ? FootholdSpace.EMPTY : FootholdSpace.OCCUPIED;
    }

    /** One already-witnessed neighbor: contact must stay on the attaching face as the view settles. */
    boolean placeFoothold(BlockHitResult anchor, BlockPos destination, Preparation preparation) {
        return footholdAttachment(anchor, destination)
            && useContact(anchor, Contact.PRECISE, preparation);
    }

    boolean footholdAttachment(BlockHitResult anchor, BlockPos destination) {
        if (!hasView() || anchor.getSide() == Direction.DOWN
                || !anchor.getBlockPos().offset(anchor.getSide()).equals(destination)
                || client.player.getBoundingBox().intersects(new Box(destination))
                || !sameBlockFace(anchor, contactRay(anchor.getPos(), client.player.getBlockInteractionRange()))) return false;
        var material = client.world.getBlockState(anchor.getBlockPos());
        return stableDryRouteTop(anchor.getBlockPos(), material) && !material.hasBlockEntity()
            && !material.isOf(Blocks.CRAFTING_TABLE) && !material.isOf(Blocks.FURNACE);
    }

    /** A collision veto for precisely one already admitted cardinal lane, never a source of map evidence. */
    DryRouteVeto dryRouteVeto(BlockPos from, BlockPos to) {
        return dryRouteVeto(from, to, true);
    }

    /** The landing has been witnessed empty. Only the full cube to be placed may supply its missing support. */
    boolean dryRouteBuildClear(BlockPos from, BlockPos to) {
        return dryRouteVeto(from, to, false) == DryRouteVeto.CLEAR;
    }

    private DryRouteVeto dryRouteVeto(BlockPos from, BlockPos to, boolean requireLandingSupport) {
        if (!hasView()) return DryRouteVeto.VIEW;
        var player = client.player;
        int dx = to.getX() - from.getX(), dz = to.getZ() - from.getZ(), dy = to.getY() - from.getY();
        if (Math.abs(dx) + Math.abs(dz) != 1 || Math.abs(dy) > 1) return DryRouteVeto.DRIFT;
        if (lavaEmergency || player.isTouchingWater() || player.isInLava()
                || player.hasVehicle() || player.isOnFire() || player.hurtTime > 0) return DryRouteVeto.HAZARD;
        double x = from.getX() + 0.5, y = from.getY(), z = from.getZ() + 0.5;
        double along = (player.getX() - x) * dx + (player.getZ() - z) * dz;
        double across = (player.getX() - x) * dz - (player.getZ() - z) * dx;
        Vec3d velocity = player.getVelocity();
        double drift = across + 2.45 * (velocity.x * dz - velocity.z * dx);
        if (along < -0.27 || along > 1.27 || Math.abs(across) > 0.19
                || Math.abs(drift) > 0.19
                || player.getY() < Math.min(y, to.getY()) - 0.055
                || player.getY() > Math.max(y, to.getY()) + 0.32) return DryRouteVeto.DRIFT;
        if (hazardAhead(heading(dx, dz), Math.max(0.7, 1.4 - along))) return DryRouteVeto.HAZARD;
        double half = player.getWidth() * 0.5 + 0.055;
        double upper = Math.max(y, to.getY());
        Box high = new Box(x - half, upper + 0.015, z - half, x + half, upper + 1.80, z + half);
        double cross = Math.abs(drift) > Math.abs(across) ? drift : across;
        Box approach = high.stretch(cross * dz, 0, -cross * dx);
        if (!client.world.isSpaceEmpty(player, approach.stretch(dx, 0, dz))) return DryRouteVeto.SWEEP;
        if (dy != 0) {
            Box lowerColumn = dy > 0 ? approach : approach.offset(dx, 0, dz);
            if (!client.world.isSpaceEmpty(player, lowerColumn.stretch(0, -1, 0))) return DryRouteVeto.SWEEP;
        }
        // The source's reverse support is positive grounded body contact, not an
        // imaginary camera looking back from the destination. A change to either
        // exact chosen contact footprint can still veto the pair.
        Box sourceContact = new Box(high.minX, y - 0.06, high.minZ, high.maxX, y - 0.015, high.maxZ);
        Box landingContact = sourceContact.offset(dx, dy, dz);
        return client.world.isSpaceEmpty(player, sourceContact) || requireLandingSupport && client.world.isSpaceEmpty(player, landingContact)
            ? DryRouteVeto.SUPPORT : DryRouteVeto.CLEAR;
    }

    /** One bounded traversal under the normal lava and final key vetoes, without an automatic jump. */
    void driveDryRoute(BlockPos from, BlockPos to, Direction bearing) {
        var player = client.player;
        Vec3d landing = Vec3d.ofBottomCenter(to);
        double dx = landing.x - player.getX(), dz = landing.z - player.getZ();
        boolean jump = to.getY() > from.getY() && player.isOnGround() && !player.isTouchingWater()
            && !player.isInLava() && player.getBlockPos().equals(from);
        float yaw = heading(bearing.getOffsetX(), bearing.getOffsetZ());
        turnFixed(yaw, jump ? 4 : 39);
        if (!hasView() || Math.abs(MathHelper.wrapDegrees(yaw - player.getYaw())) > 6) return;
        double remaining = dx * bearing.getOffsetX() + dz * bearing.getOffsetZ();
        Vec3d velocity = player.getVelocity();
        double forwardSpeed = Math.max(0, velocity.x * bearing.getOffsetX() + velocity.z * bearing.getOffsetZ());
        double coastTicks = 2.45;
        if (to.getY() < from.getY() && player.getY() > landing.y + 0.05) {
            // A one-block drop carries forward momentum through several airborne ticks.
            // Bleed speed on the lip, rather than already beyond the landing center.
            double toLip = remaining - (0.5 - player.getWidth() * 0.5);
            if (!player.isOnGround() || toLip < forwardSpeed * coastTicks) coastTicks = 6.0;
            if (!player.isOnGround() && forwardSpeed > 0.045 && remaining + 0.05 < forwardSpeed * 3) {
                // Counter existing momentum; release before S can drive us back off the tread.
                // The same final lava/ownership veto applies to this ordinary key press.
                back();
                return;
            }
        }
        double braking = forwardSpeed * coastTicks;
        dryRouteWalk = true;
        if (remaining > Math.max(0.12, braking)) {
            walkDownTo(landing);
            if (jump) jump();
        }
    }

    /** A visible drop can veto walking. An unseen item is not evidence either way. */
    boolean macroNoVisiblePickup(Vec3d landing) {
        return macroNoVisiblePickup(landing, landing.y, landing.y);
    }

    /** Apply the same visible-drop veto along the bounded vertical sweep as well. */
    boolean macroNoVisiblePickup(Vec3d landing, double minimumFeetY, double maximumFeetY) {
        if (!hasView() || raysLeft <= 0) return false;
        var player = client.player;
        // The vanilla on-foot pickup envelope is 1 / 0.5 / 1 around the body.
        // Reserve an extra quarter-block for braking or a drifting drop.
        Box sweep = player.getBoundingBox().stretch(landing.x - player.getX(), 0, landing.z - player.getZ())
            .stretch(0, Math.min(0, minimumFeetY - player.getY()), 0)
            .stretch(0, Math.max(0, maximumFeetY - player.getY()), 0)
            .expand(1.25, 0.5, 1.25);
        for (ItemEntity item : client.world.getEntitiesByClass(ItemEntity.class, sweep,
                candidate -> candidate.isAlive() && !candidate.isInvisibleTo(player))) {
            if (raysLeft <= 0) return false;
            if (visibleEntityPoint(item, item.getBoundingBox().getCenter()) != null && !item.getStack().isEmpty()) return false;
        }
        return raysLeft > 0;
    }

    void macroFlatWalk(Vec3d landing, float yaw, float pitch) {
        turnFixed(yaw, pitch);
        prioritizeMovement();
        walkDownTo(landing);
        flatWalk = true;
    }

    /** Own recent grounded contact selects a look direction, not permission to move. */
    Vec3d recentEmergencyFooting() {
        return tick - previousDryFootingTick <= 35 ? previousDryFooting : null;
    }

    /** Negative collision veto over an already camera-witnessed short corridor. */
    boolean emergencyLaneClear(Vec3d landing, double halfWidth) {
        var player = client.player;
        double dx = landing.x - player.getX(), dz = landing.z - player.getZ();
        if (!hasView() || !player.isOnGround() || Math.abs(landing.y - player.getY()) > 0.055
                || dx * dx + dz * dz > 9.4) return false;
        Box body = player.getBoundingBox().offset(0, 0.01, 0);
        if (!client.world.isSpaceEmpty(player, body.stretch(dx, 0, dz))) return false;
        // A first walking stride can slide off a wall; a sprint still needs room to brake.
        if (dx * dx + dz * dz < 2.1 * 2.1) return true;
        double margin = Math.max(0, halfWidth - player.getWidth() * 0.5);
        return client.world.isSpaceEmpty(player, body.offset(dx, 0, dz).expand(margin, 0, margin));
    }

    DryRouteTop emergencyFloor(Vec3d point, Direction travel, Predicate<BlockState> dangerous) {
        BlockPos floor = BlockPos.ofFloored(point);
        DryRouteTop result = dryRouteTop(point, floor);
        if (result == DryRouteTop.WITNESSED)
            return dangerous.test(client.world.getBlockState(floor)) ? DryRouteTop.NO_FULL_TOP : result;
        if (overlandTop(floor, travel, dangerous) != null) return DryRouteTop.WITNESSED;
        return result;
    }

    /** Preserve the flat movement vetoes. No jump or backwards drive on a combat cue. */
    void driveEmergencyLane(Vec3d landing, float yaw, float pitch, boolean sprint) {
        turnUrgent(yaw, pitch);
        walkDownTo(landing);
        fast = sprint;
        flatWalk = emergencyWalk = true;
    }

    boolean combatViewMissing() {
        // An old frame is not a fresh negative; an interrupted or replaced view is not reusable.
        return ready() && observedWorld == client.world && observedPlayer == client.player
            && tick - observedAtTick > 1;
    }

    boolean shieldStartWouldUseBlock() {
        HitResult actual = currentCrosshair();
        return actual != null && actual.getType() == HitResult.Type.BLOCK;
    }

    static boolean shieldSafeMainHand(ItemStack stack) {
        return stack.isEmpty() || stack.isOf(Items.SHIELD) || stack.isIn(ItemTags.SWORDS)
            || stack.isIn(ItemTags.AXES) || stack.isIn(ItemTags.PICKAXES);
    }

    void blockAgainst(LivingEntity threat) { shielding = threat; }

    /** Face an observed bearing; vanilla use still requires a safe hand and crosshair. */
    void guardRangedBearing(float yaw) { rangedShieldYaw = yaw; }

    void holdRaisedShieldToward(Vec3d lastSeen) {
        raisedShieldBearing = lastSeen;
    }

    private static boolean facesShieldBearing(ClientPlayerEntity player, double x, double z) {
        double dx = x - player.getX(), dz = z - player.getZ();
        return dx * dx + dz * dz > 1e-6
            && Math.abs(MathHelper.wrapDegrees(heading(dx, dz) - player.getYaw())) <= 38;
    }

    boolean swapShieldToOffhand() {
        return ready() && !client.player.isUsingItem() && client.player.getMainHandStack().isOf(Items.SHIELD)
            && !client.player.getOffHandStack().isOf(Items.SHIELD) && pressKey(client.options.swapHandsKey);
    }

    void wearArmor(Item item) { armor = item; }

    boolean useWaterSource(BlockPos target, Vec3d witness, Preparation preparation) {
        return useSource(target, witness, false, preparation);
    }

    static boolean exactWaterSource(BlockState state) {
        return state.isOf(Blocks.WATER) && state.getFluidState().isStill();
    }

    private static boolean sameSourceFace(BlockHitResult hit, BlockHitResult witness) {
        return hit != null && hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(witness.getBlockPos())
            && hit.getSide() == witness.getSide();
    }

    /** A fresh rendered hit must see exposed water and agree with the vanilla bucket ray. */
    boolean waterFillWitness(BlockHitResult witness, double reach) {
        if (!hasView() || eye.squaredDistanceTo(witness.getPos()) > reach * reach
                || !exactWaterSource(client.world.getBlockState(witness.getBlockPos()))) return false;
        Vec3d end = witness.getPos().add(witness.getPos().subtract(eye).normalize().multiply(0.025));
        return sameSourceFace(litHit(end, Ray.FLUIDS), witness)
            && sameSourceFace(visibleSourceRay(witness.getPos(), reach), witness);
    }

    /** The queued native edge is checked again after vanilla updates its crosshair. */
    boolean scopedWaterUseCurrent(BlockHitResult witness) {
        if (!fallUseReady() || !client.player.getMainHandStack().isOf(Items.BUCKET)
                || !client.player.getOffHandStack().isEmpty() || sourceContact == null
                || !exactWaterSource(client.world.getBlockState(witness.getBlockPos()))) return false;
        HitResult selected = client.crosshairTarget;
        if (selected == null || selected.getType() == HitResult.Type.ENTITY) return false;
        if (selected.getType() == HitResult.Type.BLOCK) {
            // The normal block use precedes item use. Only allow inert blocks behind the water.
            Block block = client.world.getBlockState(((BlockHitResult) selected).getBlockPos()).getBlock();
            if (block != Blocks.WATER && block.getClass() != Block.class
                    && block.getClass() != net.minecraft.block.PillarBlock.class) return false;
        }
        BlockHitResult exposed = itemRay(RaycastContext.FluidHandling.ANY);
        BlockHitResult source = itemRay(RaycastContext.FluidHandling.SOURCE_ONLY);
        return sameSourceFace(exposed, witness) && sameSourceFace(source, witness) && sourceContact.admits(source);
    }

    void confirmedWaterUse(BlockHitResult witness) {
        emitContact("scoop_water", "accepted", witness.getBlockPos(), witness.getSide(),
            Double.NaN, Double.NaN, -1, -1);
    }

    boolean useLavaSource(BlockPos target, Vec3d witness, Preparation preparation) {
        return useSource(target, witness, true, preparation);
    }

    private boolean useSource(BlockPos target, Vec3d witness, boolean lava, Preparation preparation) {
        if (!hasView()) return false;
        var player = client.player;
        double reach = player.getBlockInteractionRange();
        BlockHitResult reference = visibleSourceRay(witness, reach);
        if (reference == null || !reference.getBlockPos().equals(target)) return false;
        var fluid = client.world.getFluidState(target);
        if (!fluid.isStill() || !fluid.isIn(lava ? FluidTags.LAVA : FluidTags.WATER)) return false;
        boolean blockedAnchor = sourcePoint != null && aligned(sourcePoint) && !sourceContact.admits(reference)
            && ("ray_disagree".equals(sourceStatus) || "outside_region".equals(sourceStatus));
        if (sourceContact == null || tick - sourceTick > 2 || !sourceContact.sameSurface(reference) || blockedAnchor) {
            VoxelShape shape = fluid.getShape(client.world, target);
            sourceContact = new AgentFaceAim(reference, shape, true);
            Vec3d inset = sourceContact.continuation(eye, player.getRotationVector(observedPitch, observedYaw),
                reference.getPos());
            BlockHitResult inside = visibleSourceRay(inset, reach);
            if (inside != null && sourceContact.admits(inside)) {
                sourcePoint = inset;
            } else {
                // Reclaim through an aperture without assuming the source's center is exposed.
                sourceContact = new AgentFaceAim(reference, shape, true, true);
                Vec3d local = sourceContact.inset(reference.getPos());
                BlockHitResult sliver = visibleSourceRay(local, reach);
                sourcePoint = sliver != null && sourceContact.admits(sliver) ? local : witness;
            }
            sourceValidNanos = 0;
            sourceStatus = null;
        }
        sourceTick = tick;
        aimRegion(sourceContact, sourcePoint, true);
        if (renderedCrosshair instanceof EntityHitResult || currentCrosshair() instanceof EntityHitResult)
            return reportSource(lava, "vetoed", null);
        BlockHitResult seen = visibleSourceFromCamera(eye.add(player.getRotationVector(observedPitch, observedYaw)
            .multiply(reach)));
        BlockHitResult actual = itemRay(RaycastContext.FluidHandling.SOURCE_ONLY);
        if (seen == null || !sourceContact.matches(seen) || !sourceContact.matches(actual)) {
            sourceValidNanos = 0;
            return reportSource(lava, "ray_disagree", actual);
        }
        if (!sourceContact.admits(seen) || !sourceContact.admits(actual)) {
            sourceValidNanos = 0;
            return reportSource(lava, "outside_region", actual);
        }
        if (!inView(actual.getPos()) || !litFace(actual)) return reportSource(lava, "vetoed", actual);
        if (sourceValidNanos == 0) {
            sourceValidNanos = observedAtNanos;
            sourceValidTick = observedAtTick;
        }
        if (!predictedContact(sourceContact, Contact.BUCKET.predictionSeconds))
            return reportSource(lava, "latency_veto", actual);
        String problem = useReadiness(preparation, true);
        if (problem != null) return reportSource(lava, problem, actual);
        if (!player.getMainHandStack().isOf(Items.BUCKET))
            return reportSource(lava, "awaiting_equipment", actual);
        return reportSource(lava, pulseContactUse() ? "issued" : "input_refused", actual);
    }

    private BlockHitResult visibleSourceRay(Vec3d point, double reach) {
        double distance = point.distanceTo(eye);
        if (distance <= 0.01 || distance > reach + 0.02 || !inView(point)) return null;
        double scale = Math.min(reach, distance + 0.025) / distance;
        return visibleSourceFromCamera(eye.add((point.x - eye.x) * scale,
            (point.y - eye.y) * scale, (point.z - eye.z) * scale));
    }

    private BlockHitResult visibleSourceFromCamera(Vec3d end) {
        if (raysLeft <= 0) return null;
        raysLeft--;
        BlockHitResult seen = client.world.raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.SOURCE_ONLY, client.player));
        return seen.getType() == HitResult.Type.BLOCK && inView(seen.getPos()) && litFace(seen) ? seen : null;
    }

    private boolean reportSource(boolean lava, String status, BlockHitResult hit) {
        boolean issued = "issued".equals(status);
        if (!issued && status.equals(sourceStatus)) return false;
        sourceStatus = status;
        Vec3d point = hit != null && sourceContact.matches(hit) ? hit.getPos() : null;
        emitContact(lava ? "scoop_lava" : "scoop_water", status, sourceContact.pos, sourceContact.side,
            point == null ? Double.NaN : sourceContact.u(point), point == null ? Double.NaN : sourceContact.v(point),
            sourceValidNanos == 0 ? -1 : tick - sourceValidTick,
            sourceValidNanos == 0 ? -1 : (System.nanoTime() - sourceValidNanos) / 1_000_000);
        return issued;
    }

    /** Close, already observed dry footing only: the lava sweep still covers the whole body and braking distance. */
    void walkDownTo(Vec3d landing) {
        walkDown(false);
        dryLanding = landing;
    }

    /** Start from actual dry footing and one freshly seen, full destination top. */
    boolean beginObservedStep(BlockHitResult hit, Vec3d landing) {
        return rememberStep(hit, landing, false) && driveObservedStep(landing);
    }

    /** Remember a short flat segment while a fresh surface observation is already driving W. */
    void rememberSurfaceStep(BlockHitResult hit) {
        if (hit == null) return;
        var player = client.player;
        BlockPos floor = hit.getBlockPos();
        if (!player.isOnGround() || Math.abs(floor.getY() + 1 - player.getY()) > 0.04
            || Math.abs(floor.getX() - player.getBlockX()) + Math.abs(floor.getZ() - player.getBlockZ()) != 1) return;
        Vec3d landing = new Vec3d(floor.getX() + 0.5, floor.getY() + 1, floor.getZ() + 0.5);
        if (rememberStep(hit, landing, true)) stepDriveTick = tick;
    }

    boolean continueSurfaceStep(float bearing) {
        if (!surfaceStep || stepSupport == null || client.player.isSprinting()
            || Math.abs(MathHelper.wrapDegrees(bearing - stepYaw)) > 10) return false;
        // Continue translating on the proven tile, without picking a new gaze target.
        return driveStep(stepLanding);
    }

    private boolean rememberStep(BlockHitResult hit, Vec3d landing, boolean surface) {
        if (!hasView() || hit.getSide() != Direction.UP) return false;
        var player = client.player;
        BlockPos floor = hit.getBlockPos();
        if (!player.isOnGround() || Math.abs(hit.getPos().y - landing.y) > 0.03
            || !matchesStep(floor, landing) || !fullStepSupport(hit)) return false;
        int dx = floor.getX() - player.getBlockX(), dz = floor.getZ() - player.getBlockZ();
        double drop = player.getY() - landing.y;
        if (Math.abs(dx) + Math.abs(dz) != 1 || drop < -0.04 || drop > 1.05) return false;
        stepOriginY = player.getY();
        stepDirection = dx != 0 ? (dx > 0 ? Direction.EAST : Direction.WEST)
            : (dz > 0 ? Direction.SOUTH : Direction.NORTH);
        stepYaw = heading(landing.x - player.getX(), landing.z - player.getZ());
        stepPitch = player.getPitch();
        surfaceStep = surface;
        stepSupport = floor;
        stepLanding = landing;
        stepWitness = hit.getPos().add(0, -0.045, 0);
        stepStarted = tick;
        stepDriveTick = tick - 1;
        return true;
    }

    /** Use the original terrain witness only while the body remains on this one step's sweep. */
    boolean driveObservedStep(Vec3d landing) {
        return !surfaceStep && driveStep(landing);
    }

    private boolean driveStep(Vec3d landing) {
        if (stepSupport == null || !matchesStep(stepSupport, landing)) return false;
        var player = client.player;
        if (!hasView() || tick - stepStarted > 10 || tick - stepDriveTick > 1 || lavaEmergency
            || surfaceStep && !player.isOnGround()
            || player.isTouchingWater() || player.hasVehicle() || player.horizontalCollision || player.hurtTime > 0
            || Math.abs(MathHelper.wrapDegrees(stepYaw - player.getYaw())) > 10) {
            stepSupport = null;
            return false;
        }
        int dx = stepDirection.getOffsetX(), dz = stepDirection.getOffsetZ();
        double x = landing.x - player.getX(), z = landing.z - player.getZ();
        double ahead = x * dx + z * dz, across = x * dz - z * dx;
        Vec3d motion = player.getVelocity();
        double alongSpeed = motion.x * dx + motion.z * dz, sideSpeed = motion.x * dz - motion.z * dx;
        double braking = Math.max(0, alongSpeed) * 2.45;
        double margin = 0.49 - player.getWidth() * 0.5;
        if (ahead < -margin || ahead > 1.52 || Math.abs(across) > margin
            || Math.abs(across - sideSpeed * 2.45) > margin || alongSpeed < -0.06
            || player.getY() < landing.y - 0.055 || player.getY() > stepOriginY + 0.08
            || player.isOnGround() && Math.min(Math.abs(player.getY() - stepOriginY),
                Math.abs(player.getY() - landing.y)) > 0.055
            || hazardAhead(player.getYaw(), Math.max(1.05, ahead + 0.28))) {
            stepSupport = null;
            return false;
        }
        if (surfaceStep && ahead > Math.max(0.14, braking)) {
            Vec3d clearance = stepLanding.add(0, 0.43, 0);
            if (!clearTerrain(clearance)) {
                stepSupport = null;
                return false;
            }
        }
        // A visible mismatch (including air where the top was) ends the commitment.
        // An out-of-frame floor carries no negative evidence, and the sweep remains bounded.
        if (tick != stepStarted && inView(stepWitness)) {
            BlockHitResult hit = visibleHit(stepWitness, Ray.TERRAIN);
            if (hit == null || !hit.getBlockPos().equals(stepSupport) || hit.getSide() != Direction.UP
                || Math.abs(hit.getPos().y - landing.y) > 0.03 || !fullStepSupport(hit)) {
                stepSupport = null;
                return false;
            }
        }
        stepDriveTick = tick;
        if (!surfaceStep) lookAlongGait(stepYaw, stepPitch);
        if (ahead > Math.max(0.14, braking)) walkDownTo(landing);
        return true;
    }

    private static boolean matchesStep(BlockPos floor, Vec3d landing) {
        return landing.x == floor.getX() + 0.5 && landing.y == floor.getY() + 1 && landing.z == floor.getZ() + 0.5;
    }

    private boolean fullStepSupport(BlockHitResult hit) {
        BlockPos floor = hit.getBlockPos();
        return fullStepSupport(floor, client.world.getBlockState(floor));
    }

    private boolean fullStepSupport(BlockPos floor, BlockState state) {
        return state.getFluidState().isEmpty() && !state.isOf(Blocks.MAGMA_BLOCK) && !state.isOf(Blocks.CACTUS)
            && Block.isShapeFullCube(state.getCollisionShape(client.world, floor));
    }

    /** Retain the backing mode through the whole walked segment; never rotate through alternate bearings. */
    boolean preferLavaExit(Vec3d walked) {
        if (!lavaEmergency || escapePlanned || walked == null) return false;
        var player = client.player;
        double dx = walked.x - player.getX(), dz = walked.z - player.getZ();
        double distance = Math.hypot(dx, dz), rise = walked.y - player.getY();
        if (distance <= 0.25 || distance > 3.2 || rise < -1.1 || rise > 1.15) return false;
        float yaw = heading(dx, dz);
        if (hazards.lavaRisk(player.getBoundingBox(), yaw, distance, Math.max(0, rise), true, tick) > 0)
            return false;
        escapeLanding = walked;
        escapeBackward = Math.abs(MathHelper.wrapDegrees(yaw - player.getYaw())) > 90;
        escapeHeading = yaw;
        escapeSince = tick;
        return escapePlanned = true;
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
            && !client.player.isUsingItem() && !client.player.hasVehicle() && !lavaEmergency;
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
        return stationFace(rejected, null);
    }

    BlockHitResult stationFace(BlockPos rejected, Predicate<BlockPos> usableSite) {
        return stationFace(rejected, usableSite, false);
    }

    BlockHitResult stationFace(BlockPos rejected, Predicate<BlockPos> usableSite, boolean topOnly) {
        if (!hasView()) return null;
        if (sampleCount == 0) sampleView(4.25);
        BlockHitResult best = null;
        double cost = Double.POSITIVE_INFINITY;
        var player = client.player;
        for (int i = -1; i < sampleCount; i++) {
            var hit = i < 0 ? selectedFace() : samples[i];
            if (hit == null || (topOnly ? hit.getSide() != Direction.UP : hit.getSide() == Direction.DOWN)) continue;
            var dest = hit.getBlockPos().offset(hit.getSide());
            int dy = dest.getY() - player.getBlockY();
            if (dy < -1 || dy > 1 || dest.equals(rejected) || player.getBoundingBox().intersects(new Box(dest))) continue;
            double d = eye.squaredDistanceTo(hit.getPos());
            if (d > 4.15 * 4.15) continue;
            if (usableSite != null && !usableSite.test(dest)) continue;
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
        int columns = near ? 7 : 9, rows = 5;
        float uPhase = (tick & 1) == 0 ? 0.28f : 0.72f;
        float vPhase = (tick & 2) == 0 ? 0.30f : 0.70f;
        double nearest = distance * distance;
        BlockHitResult best = null;
        for (int y = 0; y < rows && raysLeft > 0; y++) {
            float v = -0.98f + 1.96f * ((y + vPhase) / rows);
            for (int x = 0; x < columns && raysLeft > 0; x++) {
                float u = 1.96f * ((x + uPhase) / columns) - 0.98f;
                inverseViewProjection.transform(clip.set(u, v, 0.9f, 1));
                double dx = clip.x / (double) clip.w, dy = clip.y / (double) clip.w, dz = clip.z / (double) clip.w;
                double scale = distance / Math.sqrt(dx * dx + dy * dy + dz * dz);
                Vec3d end = eye.add(dx * scale, dy * scale, dz * scale);
                if (!inView(end)) continue;
                BlockHitResult hit = litHit(end, Ray.FLUIDS);
                if (hit == null) continue;
                byte kind = AgentHazards.kind(client.world.getBlockState(hit.getBlockPos()));
                double d = eye.squaredDistanceTo(hit.getPos());
                hazards.observe(hit, kind, eye, d, tick);
                if (!near && AgentHazards.matches(kind, lava, sourceOnly)) {
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

    enum WetEscapeMedium { UNSEEN, SOLID, AIR, STILL_WATER, FLOW }

    /** Classify a specific point in the rendered corridor; never read an occluded candidate cell. */
    WetEscapeMedium wetEscapeMedium(Vec3d point) {
        if (!hasView() || raysLeft <= 0 || !inView(point) || point.squaredDistanceTo(eye) > 14.44)
            return WetEscapeMedium.UNSEEN;
        raysLeft--;
        BlockHitResult hit = raycast(point, Ray.WET_TERRAIN);
        BlockPos cell = BlockPos.ofFloored(point);
        if (hit.getType() != HitResult.Type.MISS) {
            return hit.getBlockPos().equals(cell) && inView(hit.getPos()) && litFace(hit)
                ? WetEscapeMedium.SOLID : WetEscapeMedium.UNSEEN;
        }
        if (!lit(point.x, point.y, point.z)) return WetEscapeMedium.UNSEEN;
        BlockState state = client.world.getBlockState(cell);
        if (state.isAir() || state.isOf(Blocks.TORCH) || state.isOf(Blocks.WALL_TORCH))
            return WetEscapeMedium.AIR;
        FluidState fluid = state.getFluidState();
        if (!state.isOf(Blocks.WATER) || !fluid.isIn(FluidTags.WATER)) return WetEscapeMedium.SOLID;
        if (point.y - cell.getY() >= fluid.getHeight(client.world, cell)) return WetEscapeMedium.AIR;
        return fluid.isStill() ? WetEscapeMedium.STILL_WATER : WetEscapeMedium.FLOW;
    }

    BlockHitResult wetEscapeFloor(Vec3d belowTop) {
        if (!hasView() || !inView(belowTop) || belowTop.squaredDistanceTo(eye) > 14.44) return null;
        BlockHitResult hit = visibleHit(belowTop, Ray.WET_TERRAIN);
        return hit != null && hit.getSide() == Direction.UP
            && Math.abs(hit.getPos().y - hit.getBlockPos().getY() - 1) <= 0.025
            && fullStepSupport(hit) && !(client.world.getBlockState(hit.getBlockPos()).getBlock() instanceof FallingBlock)
            ? hit : null;
    }

    /** Collision is a veto on an already seen lane, not a source of candidate terrain. */
    boolean wetEscapeSweep(Vec3d landing, double rise, double driftX, double driftZ) {
        if (!hasView() || lavaEmergency) return false;
        var player = client.player;
        Vec3d feet = player.getPos();
        double dx = landing.x - feet.x, dz = landing.z - feet.z;
        double distance = Math.hypot(dx, dz);
        if (distance > 2.65 || rise > 1.04 || player.hasVehicle() || player.isInLava()
                || player.isOnFire() || hazards.lavaNear(player.getBoundingBox(), 0.27, tick)
                || hazards.lavaRisk(player.getBoundingBox(), heading(dx, dz), distance + 0.35,
                    Math.max(0, rise), false, tick) > 0) return false;
        // Sample the diagonal sweep instead of accepting a centerline through a narrow corner.
        // Don't inflate the player's width into a wall already touching one shoulder.
        Box body = player.getBoundingBox().contract(1e-5, 0, 1e-5);
        if (rise > 0.045 && !client.world.isSpaceEmpty(player, body.stretch(0, rise, 0))) return false;
        Box raised = body.offset(0, Math.max(0, rise), 0);
        int samples = Math.max(1, (int) Math.ceil(distance / 0.20));
        for (int i = 1; i <= samples; i++) {
            double fraction = (double) i / samples;
            Box sweep = raised.offset(dx * fraction, 0, dz * fraction);
            if (!client.world.isSpaceEmpty(player, sweep)
                    || (driftX != 0 || driftZ != 0)
                        && !client.world.isSpaceEmpty(player, sweep.offset(driftX * fraction, 0, driftZ * fraction)))
                return false;
        }
        return true;
    }

    /** A vertical swim stroke beside a witnessed lip must also fit before any forward input. */
    boolean wetEscapeRise(double rise) {
        var player = client.player;
        return hasView() && !lavaEmergency && player.isTouchingWater() && !player.hasVehicle()
            && !hazards.lavaNear(player.getBoundingBox(), 0.32, tick)
            && client.world.isSpaceEmpty(player, player.getBoundingBox().contract(1e-5, 0, 1e-5)
                .stretch(0, Math.max(0.16, rise + 0.05), 0));
    }

    /** Stay level in a low passage. Jump only to breathe or climb a proved lip. */
    void driveWetEscape(boolean climb) {
        walkDown(false);
        wetEscapeWalk = true;
        if (climb) jump();
    }

    /** Tests a lit point seen through transparent water, never through opaque terrain or lava. */
    boolean visibleWaterAt(Vec3d point, double distance) {
        if (!hasView() || point.squaredDistanceTo(eye) > distance * distance
                || !clearPoint(point, Ray.WET_TERRAIN)) return false;
        BlockPos pos = BlockPos.ofFloored(point);
        FluidState water = client.world.getFluidState(pos);
        return water.isIn(FluidTags.WATER) && point.y - pos.getY() < water.getHeight();
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
        threatPoint = null;
        return visibleEntity(LivingEntity.class, entity -> entity instanceof Monster, distance, true);
    }

    Vec3d threatPoint() { return threatPoint; }

    Optional<ItemEntity> dropped(Predicate<ItemStack> matches, double distance) {
        return visibleEntity(ItemEntity.class, entity -> matches.test(entity.getStack()), distance, false);
    }

    Optional<Entity> visibleEntity(Predicate<Entity> matches, double distance) {
        return visibleEntity(Entity.class, matches, distance, false);
    }

    private <T extends Entity> Optional<T> visibleEntity(Class<T> type, Predicate<T> matches, double distance,
                                                       boolean rememberThreatPoint) {
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
            Vec3d visible = visibleEntityPoint(candidate, center);
            if (visible == null) continue;
            if (!matches.test(candidate)) continue;
            best = candidate;
            bestDistance = d;
            if (rememberThreatPoint) threatPoint = visible;
        }
        return Optional.ofNullable(best);
    }

    private Vec3d visibleEntityPoint(Entity candidate, Vec3d center) {
        if (clearPoint(center, Ray.SIGHT)) return center;
        double margin = candidate.getHeight() * 0.32;
        Vec3d upper = center.add(0, margin, 0);
        if (clearPoint(upper, Ray.SIGHT)) return upper;
        Vec3d lower = center.add(0, -margin, 0);
        return clearPoint(lower, Ray.SIGHT) ? lower : null;
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
            if (d <= AgentHazards.SIGHT_RANGE * AgentHazards.SIGHT_RANGE) {
                hazards.observe(hit, AgentHazards.kind(client.world.getBlockState(hit.getBlockPos())), eye, d, tick);
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
        return inView(point.x, point.y, point.z);
    }

    private boolean inView(double x, double y, double z) {
        viewProjection.transform(clip.set((float) (x - eye.x), (float) (y - eye.y), (float) (z - eye.z), 1));
        return clip.w > 0 && Math.abs(clip.x) <= clip.w && Math.abs(clip.y) <= clip.w
            && Math.abs(clip.z) <= clip.w;
    }

    private boolean litFace(BlockHitResult hit) {
        return observedFaceLight(hit) > 0;
    }

    /** The open side of a face just returned by a camera ray, never a probe into unseen rock. */
    int observedFaceLight(BlockHitResult hit) {
        if (nightVision) return 15;
        Vec3d point = hit.getPos();
        Direction side = hit.getSide();
        return client.world.getLightLevel(lightPos.set(point.x + 0.02 * side.getOffsetX(),
            point.y + 0.02 * side.getOffsetY(), point.z + 0.02 * side.getOffsetZ()));
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
