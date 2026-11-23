package io.gameharness.survival;

import io.gameharness.survival.AgentSupplyOutline.CutAdmission;
import io.gameharness.survival.AgentVisibleHorizon.Refusal;
import io.gameharness.survival.mixin.AgentMiningAccess;
import java.util.Arrays;
import java.util.Optional;
import java.util.function.BiFunction;
import java.util.function.BiPredicate;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.BooleanSupplier;
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
import net.minecraft.entity.EntityPose;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.ai.RangedAttackMob;
import net.minecraft.entity.attribute.EntityAttributes;
import net.minecraft.entity.effect.StatusEffects;
import net.minecraft.entity.mob.Angerable;
import net.minecraft.entity.mob.EndermanEntity;
import net.minecraft.entity.mob.Monster;
import net.minecraft.entity.mob.PiglinEntity;
import net.minecraft.entity.mob.SpiderEntity;
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
final class AgentBody implements AgentEmergencyFootwork.Terrain {
    private static final int COLUMNS = 13;
    private static final int ROWS = 9;
    private static final int RAY_BUDGET = 256;
    private static final int MOVEMENT_RAYS = 6;
    private static final int HORIZON_TERRAIN_RAYS = 24;
    private static final int HORIZON_GRADE_RAYS = 9;
    private static final float[] HORIZON_CUE_U = {0, -0.30f, 0.30f, 0, -0.58f, 0.58f, -0.30f, 0.30f, 0, -0.54f, 0.54f};
    private static final float[] HORIZON_CUE_V = {0.24f, 0, 0, -0.24f, 0, 0, 0.30f, 0.30f, 0.55f, -0.32f, -0.32f};
    private static final int HORIZON_CUE_RAYS = 1 + HORIZON_CUE_U.length;
    private static final int HORIZON_WITNESS_RAYS = 4;
    private static final int LEVEL_WALL_RAYS = 8; // Four bearings, at most one feet and one head cell each.
    private static final int LEVEL_WALL_WITNESS_TICKS = 10;
    private static final double HORIZON_CUE_RANGE = 16;
    private static final double MAX_RANGE = 32;
    private static final double TURN_SPEED = 230;
    private static final double TURN_TIME = 0.085;
    private static final double GAIT_PITCH_SPEED = 48;
    private static final double GAIT_PITCH_ACCELERATION = 200;
    private static final double GAIT_PITCH_TIME = 0.20;
    private static final int FOOTING_AGE = 100;
    private static final int ESCAPE_TICKS = 44;
    private static final double[] DEFENSIVE_ROWS = {0.42, 0.78, 1.25, 1.9, 2.55, 3.04};
    private static final Predicate<BlockState> DEFENSIVE_DANGER = AgentBody::dryCaveDanger;
    private static final String SUPPORTING_FOOTPRINT = "supporting_footprint";
    private static final double[] MACRO_FLOOR_OFFSETS = {0, -0.36, 0.36};
    private static final double SUPPLY_OUTLINE_REACH = 4.25;
    static final int SUPPLY_OPEN = 1, SUPPLY_ROOF = 2, SUPPLY_WALL = 4;

    enum Contact {
        PLACE("place", false, 0.012),
        INTERACT("interact", false, 0.012),
        MINE("mine", false, 0.012),
        LEAP_PLACE("leap_place", false, 0.012),
        PRECISE("precise_use", true, 0.022),
        BUCKET("pour", true, 0.022),
        RIM("rim_place", true, 0.022),
        SUPPLY_MINE("supply_outline_mine", false, 0.012),
        SUPPLY_CLEAR("supply_outline_clear", false, 0.012),
        SUPPLY_PLACE("supply_outline_place", true, 0.022),
        OUTLINE("outline_use", true, 0.022);

        final String action;
        final boolean precise;
        final double predictionSeconds;

        Contact(String action, boolean precise, double predictionSeconds) {
            this.action = action;
            this.precise = precise;
            this.predictionSeconds = predictionSeconds;
        }

        boolean supplyOutline() { return this == SUPPLY_MINE || this == SUPPLY_CLEAR || this == SUPPLY_PLACE; }
        boolean allowsOutline() { return this == RIM || this == BUCKET || this == OUTLINE; }
    }

    enum OutlineClearance { REQUESTED, WAIT, UNSAFE, TOO_SLOW, STALLED, EXPIRED }

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
        WET_TERRAIN(RaycastContext.ShapeType.COLLIDER, false),
        HORIZON_TOP(RaycastContext.ShapeType.OUTLINE, false);

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
    private final AgentDryCaveRoute.ProbeView caveProbeView = new AgentDryCaveRoute.ProbeView() {
        @Override public DryRouteTop top(Vec3d point, BlockPos support) { return dryCaveTop(point, support); }
        @Override public DryRouteSample space(Vec3d point) { return dryCaveSpace(point); }
        @Override public BlockState state(BlockPos pos) { return client.world.getBlockState(pos); }
    };
    private final BlockPos.Mutable overlandProbe = new BlockPos.Mutable();
    private final BlockHitResult[] samples = new BlockHitResult[COLUMNS * ROWS];
    private final BlockHitResult[] horizonCueSamples = new BlockHitResult[HORIZON_CUE_U.length];
    private final LevelWallSight levelWallSight = new LevelWallSight(this::inView,
        end -> raycast(end, Ray.FLUIDS), this::litFace, hit -> clientBlockState(hit.getBlockPos()));
    private final AgentHazards hazards = new AgentHazards();
    private final AgentHeadroom headroom;
    private final AgentVisibleHorizon visibleHorizon = new AgentVisibleHorizon(this);
    private final Consumer<ContactEvidence> contactEvidence;
    private final AgentLookMotor lookMotor;
    private final AgentThreatView<LivingEntity> threats = new AgentThreatView<>();

    private ClientWorld observedWorld;
    private ClientPlayerEntity observedPlayer;
    private ClientWorld hazardWorld;
    private ClientPlayerEntity hazardPlayer;
    private Vec3d dryFooting;
    private AgentWalkedRoute walkedRoutes;
    private final BlockPos.Mutable walkedProbe = new BlockPos.Mutable();
    private final BlockPos.Mutable ordinaryFloorProbe = new BlockPos.Mutable();
    private boolean ordinaryRiseKey;
    private final Predicate<Box> caveLandingSpace = this::caveLandingSpaceEmpty;
    private final Predicate<Box> caveLandingDry = this::caveLandingVolumeDry;
    private int dryFootingTick;
    private Vec3d previousDryFooting;
    private int previousDryFootingTick;
    private boolean lavaEmergency;
    private boolean checkedEmergencyWalk;
    private int emergencyDriveTick = -1;
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
    private boolean ordinaryOutlineExitEnabled;
    private final AgentSupplyOutline.CutCover supplyCutCover = new AgentSupplyOutline.CutCover();
    private final AgentSupplyOutline.EscapeWork supplyEscapeWork = new AgentSupplyOutline.EscapeWork();
    private BlockState renderedSupplyOutline;
    private BlockHitResult checkedSupplyOutline;
    private Vec3d checkedSupplyEye;
    private int supplyOutlineTick = -1;
    private long supplyOutlineFrame = -1;
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
    private int horizonTerrainRays, horizonGradeRays, horizonCueRays, horizonWitnessRays;
    private final OrdinaryGrade[] horizonGrades = new OrdinaryGrade[Direction.values().length];
    private final BlockHitResult[] horizonGradeSides = new BlockHitResult[horizonGrades.length];
    private final BlockHitResult[] horizonRiserTops = new BlockHitResult[horizonGrades.length];
    private int horizonGradeChecked;
    private long horizonSightlineFrame = -1, horizonCueFrame = -1;
    private BlockHitResult horizonSightlineHit;
    private int sampleCount;
    private double sampleRange;
    private long sampleFrame = -1;
    private ShapeContext rayShapeContext;
    private boolean nightVision;

    private boolean forward;
    private boolean backward;
    private boolean fast;
    private int lastForwardPress = -8;
    private boolean verifiedDescent;
    private boolean flatWalk, dryRouteWalk, emergencyWalk;
    private boolean wetEscapeWalk;
    private static final int HORIZON_WAIT_TICKS = 8;
    private HorizonTravel horizonIntent, horizonApplied;
    private BooleanSupplier reconInputGrant;
    private Vec3d horizonAppliedFrom;
    private boolean horizonAppliedDry, horizonAppliedPulse;
    private AgentShallowTransit horizonCrossing;
    private HorizonTravel horizonCrossingOwner;
    private AgentShallowTransit.Pose horizonCrossingPose;
    private HorizonView horizonCrossingView;
    private int horizonCrossingChecked = -1;
    private Refusal horizonWaterLoss;
    private int horizonWaterLostAt = -2;
    private BlockPos horizonPulseContact;
    private int horizonAppliedTick = -2;
    private int horizonSide;
    private boolean horizonForward, horizonSneak, horizonWade, horizonSprint;
    private float horizonHeading;
    private double horizonReach;
    private AgentVisibleHorizon.Window horizonKeyWindow;
    private Vec3d dryLanding;
    private BlockPos stepSupport;
    private boolean surfaceStep;
    private Vec3d stepWitness, stepLanding;
    private double stepOriginY;
    private Direction stepDirection;
    private float stepYaw, stepPitch;
    private int stepStarted, stepDriveTick;
    private Vec3d centerLanding;
    private AgentPickup.Input pickupInput = AgentPickup.Input.WAIT;
    private AgentVisibleHorizon.Track pickupLane;
    private ItemEntity pickupTarget;
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
    private Vec3d rangedThreatPoint;
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
        raysLeft = RAY_BUDGET - MOVEMENT_RAYS - HORIZON_TERRAIN_RAYS - HORIZON_GRADE_RAYS
            - HORIZON_CUE_RAYS - HORIZON_WITNESS_RAYS;
        levelWallSight.release();
        horizonTerrainRays = HORIZON_TERRAIN_RAYS;
        horizonGradeRays = HORIZON_GRADE_RAYS;
        horizonGradeChecked = 0;
        Arrays.fill(horizonGrades, null);
        Arrays.fill(horizonGradeSides, null);
        Arrays.fill(horizonRiserTops, null);
        horizonCueRays = HORIZON_CUE_RAYS;
        horizonWitnessRays = HORIZON_WITNESS_RAYS;
        sampleCount = 0;
        sampleRange = 0;
        rayShapeContext = null;
        tickCrosshair = null;
        threats.begin(0);
        nightVision = client.player != null && client.player.hasStatusEffect(StatusEffects.NIGHT_VISION);
        resetIntentions();
        if (hazardWorld != client.world || hazardPlayer != client.player) {
            levelWallSight.forget();
            visibleHorizon.forgetIdleAim();
            hazards.clear();
            headroom.reset();
            stepSupport = null;
            emergencyDriveTick = -1;
            dryFooting = previousDryFooting = null;
            lavaEmergency = false;
            horizonApplied = null;
            horizonPulseContact = null;
            interruptHorizonWade(Refusal.WORLD_OR_CAMERA_UNAVAILABLE);
            horizonWaterLoss = null;
            hazardWorld = client.world;
            hazardPlayer = client.player;
        }
        boolean available = ready();
        if (client.player != null && client.player.isAlive() && client.player.isInLava()) beginLavaEscape();
        headroom.observe(tick, available && !lavaEmergency && client.getOverlay() == null);
        if (!available) {
            visibleHorizon.forgetIdleAim();
            stableDryTicks = 0;
            return;
        }
        var player = client.player;
        visibleHorizon.observeIdleFeet(player.getPos(), player.getYaw(), player.getPitch());
        if (horizonApplied != null && horizonAppliedTick == tick - 1) observeHorizonTravel(player);
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
        pickupInput = AgentPickup.Input.WAIT;
        pickupLane = null;
        pickupTarget = null;
        forward = backward = fast = verifiedDescent = flatWalk = jumping = sneaking = swimmingDown = eating = false;
        emergencyWalk = false;
        checkedEmergencyWalk = false;
        dryRouteWalk = false;
        ordinaryRiseKey = false;
        wetEscapeWalk = false;
        horizonIntent = null;
        reconInputGrant = null;
        horizonKeyWindow = null;
        horizonForward = horizonSneak = horizonWade = horizonSprint = false;
        horizonSide = 0;
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
        boolean avoidEyes = threats.hasGazeRisk() && !fallSteering && !lavaEmergency && hasView();
        if ((!steering && !avoidEyes) || !ready()) {
            lookMotor.stop(now);
            return;
        }
        if (dt <= 0) return;
        var player = client.player;
        Vec3d origin = aimPoint == null && !avoidEyes ? null
            : player.getCameraPosVec(client.getRenderTickCounter().getTickDelta(true));
        float yawBefore = player.getYaw(), pitchBefore = player.getPitch();
        float targetYaw = steering ? goalYaw(player, origin) : yawBefore;
        float targetPitch = steering ? goalPitch(origin) : pitchBefore;
        if (avoidEyes) targetPitch = threats.lookPitch(origin, yawBefore, targetYaw, targetPitch);
        if (!steering && targetPitch == pitchBefore) {
            lookMotor.stop(now);
            return;
        }
        if (steering && !gaitSteering && !fallSteering && !fixedSteering && !lavaEmergency) {
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
        if (steering && gaitSteering) {
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
        AgentLookMotor.Context context = !steering ? AgentLookMotor.Context.NORMAL
            : fallSteering ? AgentLookMotor.Context.FALL : lavaEmergency ? AgentLookMotor.Context.URGENT : lookContext;
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
            if (!sameView) {
                forgetSupplyOutlineCut();
                levelWallSight.forget();
                clearContact();
            }
        }
        observedWorld = context.world();
        observedPlayer = client.player;
        observedAtTick = tick;
        eye = context.camera().getPos();
        visibleHorizon.observeIdleCamera(eye, yaw, pitch);
        levelWallSight.observePose(eye, yaw, pitch);
        observedYaw = yaw;
        observedPitch = pitch;
        observedAtNanos = now;
        ++frameSequence;
        renderedCrosshair = client.crosshairTarget;
        renderedSupplyOutline = null;
        if (contact != null && !contactMode.supplyOutline() && tick - contactTick <= 1) noteRenderedEntry();
        viewProjection.set(context.projectionMatrix()).mul(context.positionMatrix());
        inverseViewProjection.set(viewProjection).invert();
    }

    private void clearView() {
        observedWorld = null;
        observedPlayer = null;
        eye = null;
        renderedCrosshair = null;
        renderedSupplyOutline = null;
        forgetSupplyOutlineCut();
        checkedSupplyOutline = null;
        checkedSupplyEye = null;
        observedAtNanos = 0;
        visibleHorizon.forgetIdleAim();
        levelWallSight.forget();
        threats.begin(0);
        clearContact();
    }

    void finish() {
        if (!ready()) {
            interruptHorizonWade(Refusal.INPUT_UNAVAILABLE);
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
        boolean dive = swimmingDown && player.isTouchingWater() && (wetEscapeWalk || player.getAir() >= 70);
        boolean crouch = sneaking || dive;
        boolean jump = jumping || !dive && !wetEscapeWalk && (player.isSubmergedInWater()
            || (advance || retreat) && player.isTouchingWater());
        boolean stepJump = false;
        Ground ground = Ground.CLEAR;
        boolean rolling = horizonIntent != null;
        boolean pickupWalk = pickupInput != AgentPickup.Input.WAIT;
        int pickupSide = pickupInput.right;
        boolean horizonHazardVeto = false;
        if (horizonCrossing != null && horizonCrossingOwner != horizonIntent)
            interruptHorizonWade(Refusal.INPUT_UNAVAILABLE);

        if (rolling) {
            // One ordinary rolling owner; it never inherits the generic auto-jump,
            // sprint, or swim controls even if its current command is neutral.
            advance = horizonForward;
            retreat = jump = false;
            crouch = horizonSneak;
        } else if (pickupWalk) {
            advance = pickupInput.forward > 0;
            retreat = pickupInput.forward < 0;
            jump = crouch = false;
        } else if (flatWalk && advance) {
            // The caller has checked a dry lane and sweep. Never inherit the ordinary
            // auto-jump, crouching advance, sprint latch, or tolerance for a lost render.
            double distance = Math.hypot(dryLanding.x - player.getX(), dryLanding.z - player.getZ());
            advance = hasView() && player.isOnGround() && (emergencyWalk || !player.horizontalCollision)
                && distance > Math.max(0.12, 2.6 * Math.sqrt(player.getVelocity().horizontalLengthSquared()))
                && Math.abs(MathHelper.wrapDegrees(goalYaw(player, player.getEyePos()) - player.getYaw()))
                    <= (checkedEmergencyWalk ? AgentEmergencyFootwork.DRIVE_ALIGNMENT : 6);
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
                                    && mayContact(hit.getEntity())
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
                if (strikeContact(striking, actual)
                        && striking.isAlive() && !player.isUsingItem()
                        && canWearSafetyItem(player.getMainHandStack())
                        && player.getAttackCooldownProgress(0.5f) >= 0.9f) {
                    pressKey(options.attackKey);
                }
            } else if (mining != null && contact != null && actual instanceof BlockHitResult hit) {
                attack = mining.equals(contact.pos) && contact.admits(hit);
            }
        }
        boolean sprintRequested = advance && !crouch && (rolling ? horizonSprint
            : !pickupWalk && fast && ground == Ground.CLEAR);
        if (advance || retreat || rolling && horizonSide != 0 || pickupSide != 0) {
            float heading = rolling ? horizonHeading : player.getYaw() + (pickupWalk ? pickupInput.yawOffset : retreat ? 180 : 0);
            double reach = rolling ? horizonReach
                : pickupWalk ? pickupLane.braking() : jump ? 3.2 : sprintRequested || player.isSprinting() ? 2.35 : crouch ? 0.70 : 1.35;
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
                horizonHazardVeto = rolling;
                advance = retreat = sprintRequested = false;
                horizonSide = 0;
                pickupSide = 0;
                horizonWade = false;
                jump = !rolling && !pickupWalk && !dive && !wetEscapeWalk && player.isSubmergedInWater();
            }
        } else if (jump && !player.isTouchingWater()) {
            Vec3d motion = player.getVelocity();
            double drift = motion.horizontalLengthSquared();
            if (drift > 0.0016
                    && hazards.lavaRisk(player.getBoundingBox(), heading(motion.x, motion.z),
                        Math.sqrt(drift) * 9, 1.1, false, tick) > 0) jump = false;
        }
        // Vanilla latches sprint when Ctrl is released. Let up on W to brake, then walk again.
        if ((advance || rolling || pickupWalk) && !sprintRequested && player.isSprinting()) {
            advance = false;
            horizonSide = 0;
            if (pickupWalk) retreat = false;
            pickupSide = 0;
        }
        if (reconInputGrant != null && !reconInputGrant.getAsBoolean()) {
            advance = retreat = jump = sprintRequested = attack = use = false;
            horizonSide = 0;
        }
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
        } else if (rolling || pickupWalk || centerKeys) {
            options.leftKey.setPressed(rolling ? horizonSide < 0 : pickupWalk ? pickupSide < 0 : centerLeft);
            options.rightKey.setPressed(rolling ? horizonSide > 0 : pickupWalk ? pickupSide > 0 : centerRight);
            ownsRowKeys = true;
        } else {
            releaseRowKeys();
        }
        // A second forward press can start vanilla sprint even with the sprint key up.
        // A paced approach can coast at the lip; don't turn its next pulse into a double-tap.
        if (advance && !options.forwardKey.isPressed()) {
            if ((flatWalk || dryRouteWalk || pickupWalk || rolling && !crouch)
                    && !sprintRequested && tick - lastForwardPress < 8) {
                advance = false;
                if (rolling) {
                    horizonSide = 0;
                    releaseRowKeys();
                }
                if (pickupWalk) releaseRowKeys(); // Never issue half of the checked diagonal.
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
        // A staged ordinary rise must not become a walk into the riser when a
        // final safety or input gate rejected its takeoff.
        if (ordinaryRiseKey && (!advance || !jump)) advance = jump = false;
        if (jump && stepJump) lastStepJump = tick;
        ownsKeys = true;
        if (advance && (emergencyWalk || rolling && horizonIntent.ranged) && !options.forwardKey.isUnbound())
            emergencyDriveTick = tick;
        options.forwardKey.setPressed(advance);
        options.backKey.setPressed(retreat);
        if (pickupWalk) visibleHorizon.reportPickup(pickupTarget,
            advance || retreat || options.leftKey.isPressed() || options.rightKey.isPressed()
                ? pickupInput.name() : "keys_vetoed", pickupLane);
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
        if (rolling) {
            horizonApplied = horizonIntent;
            horizonAppliedFrom = player.getPos();
            horizonAppliedPulse = horizonKeyWindow != null && horizonKeyWindow.contactOnly();
            horizonAppliedDry = player.isOnGround() && !player.isTouchingWater() && !horizonWade && !horizonAppliedPulse;
            horizonAppliedTick = tick;
            horizonApplied.issued = advance || horizonSide != 0;
            horizonApplied.beenDriven |= horizonApplied.issued && !horizonAppliedPulse;
            if (horizonKeyWindow != null) {
                if (horizonApplied.issued) {
                    horizonApplied.issuedBearing = horizonHeading;
                    if (horizonAppliedPulse) {
                        horizonApplied.pulse.markIssued(horizonKeyWindow.frame());
                        horizonPulseContact = player.supportingBlockPos.orElse(null);
                    }
                }
                visibleHorizon.reportDrive(horizonApplied.issued ? null
                    : horizonHazardVeto ? Refusal.HAZARD : Refusal.INPUT_COASTING, horizonKeyWindow);
            }
            if (horizonHazardVeto) interruptHorizonWade(Refusal.HAZARD);
            if (horizonWade && horizonApplied.issued && !horizonApplied.wadeStarted && horizonKeyWindow != null
                    && !player.isTouchingWater()) {
                horizonApplied.wadeStarted = true;
                var view = horizonView();
                var pose = horizonWadePose(player, horizonApplied, view);
                horizonCrossing = visibleHorizon.issueWade(pose, horizonKeyWindow);
                if (horizonCrossing != null) {
                    horizonCrossingOwner = horizonApplied;
                    horizonWaterLoss = null;
                    visibleHorizon.reportWade("issued", null);
                } else {
                    // An issued key without a retained optical bank cannot receive planned-water priority.
                    horizonWaterLoss = pose.safety() != null ? pose.safety()
                        : view == null ? horizonViewRefusal() : Refusal.DRY_BANK_NOT_RENDERED;
                    horizonWaterLostAt = tick;
                    visibleHorizon.reportWade(null, horizonWaterLoss);
                }
            }
        }
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

    void bindOrdinaryOutlineExit(boolean enabled) {
        ordinaryOutlineExitEnabled = enabled;
        if (!enabled) forgetSupplyOutlineCut();
    }

    boolean ordinaryOutlineExitEnabled() { return ordinaryOutlineExitEnabled; }

    void watchSupplyOutlineCut(BlockPos cell) { supplyCutCover.watch(cell, tick); }

    void forgetSupplyOutlineCut() {
        supplyCutCover.forget();
        supplyEscapeWork.forget();
    }

    /** Receipt from the vanilla draw itself, not from merely aiming at an outline-shaped block. */
    void observeSupplyOutline(Entity camera, BlockPos pos, BlockState state) {
        if (ordinaryOutlineExitEnabled && hasView() && camera == observedPlayer
                && client.crosshairTarget == renderedCrosshair && renderedCrosshair instanceof BlockHitResult hit
                && hit.getType() == HitResult.Type.BLOCK && pos.equals(hit.getBlockPos())) {
            renderedSupplyOutline = state;
            if (supplyCutCover.watching(observedAtTick) && !client.options.hudHidden && inView(hit.getPos())) {
                double reach = Math.min(SUPPLY_OUTLINE_REACH, client.player.getBlockInteractionRange());
                supplyCutCover.observe(hit, state, eye, reach, observedAtTick, observedAtNanos);
            }
            if (contact != null && contactMode.supplyOutline() && tick - contactTick <= 1) noteRenderedEntry();
        }
    }

    /** Geometry only from the selected face actually drawn on the recent first-person frame. */
    BlockHitResult supplyOutlineFace() {
        if (!ordinaryOutlineExitEnabled || renderedSupplyOutline == null || !hasView() || client.options.hudHidden)
            return null;
        long nanos = System.nanoTime();
        long age = nanos - observedAtNanos;
        if (age > AgentSupplyOutline.MAX_FRAME_NANOS) return null;
        if (supplyOutlineTick == tick && supplyOutlineFrame == frameSequence) return checkedSupplyOutline;
        supplyOutlineTick = tick;
        supplyOutlineFrame = frameSequence;
        checkedSupplyOutline = null;
        checkedSupplyEye = null;
        var player = client.player;
        if (player.isTouchingWater() || player.isSubmergedInWater() || player.isInLava() || player.hasVehicle())
            return null;
        var shown = (BlockHitResult) renderedCrosshair;
        BlockHitResult now = selectedFace();
        Vec3d liveEye = player.getEyePos();
        double reach = Math.min(SUPPLY_OUTLINE_REACH, player.getBlockInteractionRange());
        if (!AgentSupplyOutline.admits(true, tick - observedAtTick, age, eye, liveEye,
                MathHelper.wrapDegrees(player.getYaw() - observedYaw), player.getPitch() - observedPitch,
                shown, now, reach) || !inView(shown.getPos()) || !inView(now.getPos())
                || dryCaveDanger(renderedSupplyOutline)
                || client.world.getBlockState(now.getBlockPos()) != renderedSupplyOutline
                || !supplyOutlineRay(eye, shown, null, reach)
                || !(eye.equals(liveEye) && shown.getPos().equals(now.getPos()))
                    && !supplyOutlineRay(liveEye, now, null, reach)) return null;
        Vec3d cap = supplyCutCover.capSample(shown, eye, reach, tick, nanos);
        if (cap != null && inView(cap) && supplyOutlineRay(eye, shown, cap, reach)
                && (eye.equals(liveEye) && shown.getPos().equals(now.getPos())
                    || supplyOutlineRay(liveEye, now, cap, reach))) {
            supplyCutCover.observeDryCapPrefix(observedAtTick, observedAtNanos);
        }
        checkedSupplyEye = liveEye;
        return checkedSupplyOutline = now;
    }

    private boolean supplyOutlineRay(Vec3d origin, BlockHitResult backstop, Vec3d sample, double reach) {
        if (raysLeft < 2) return false;
        raysLeft -= 2;
        if (rayShapeContext == null) rayShapeContext = ShapeContext.of(client.player);
        return sample == null
            ? AgentSupplyOutline.drySelectedFace(client.world, rayShapeContext, origin, backstop, reach)
            : AgentSupplyOutline.dryPrefix(client.world, rayShapeContext, origin, backstop, sample, reach);
    }

    /** Physical source contact is independent of the chosen top and must be true now. */
    private boolean supplyOutlineGrounded(BlockPos from) {
        var player = client.player;
        return !lavaEmergency && !player.isOnFire() && !player.isClimbing() && !player.isSpectator()
            && !player.getAbilities().flying && player.hurtTime == 0 && dryCaveContact(from) != null
            && !client.world.isSpaceEmpty(player, player.getBoundingBox().offset(0, -0.025, 0));
    }

    private static boolean supplyOutlineCell(BlockPos from, int x, int y, int z, int low, int high) {
        int dy = y - from.getY();
        return dy >= low && dy <= high && Math.abs(x - from.getX()) + Math.abs(z - from.getZ()) <= 1;
    }

    /** The selected top may be the actual bearing cell or one cardinal neighboring tread. */
    boolean supplyOutlineTop(BlockPos from, BlockPos floor) {
        BlockHitResult now = supplyOutlineFace();
        return supplyOutlineCell(from, floor.getX(), floor.getY(), floor.getZ(), -2, 0)
            && (from.getX() != floor.getX() || from.getZ() != floor.getZ() || floor.getY() == from.getY() - 1)
            && matchesDryRouteTop(now, floor) && matchesDryRouteTop((BlockHitResult) renderedCrosshair, floor)
            && stableDryRouteTop(floor, renderedSupplyOutline) && supplyOutlineGrounded(from);
    }

    /** A line prefix, not a whole cell, collision sweep, or a new terrain query. */
    boolean supplyOutlineClear(Vec3d sample) {
        BlockHitResult now = supplyOutlineFace();
        if (now == null) return false;
        BlockPos from = client.player.getBlockPos();
        if (!supplyOutlineCell(from, MathHelper.floor(sample.x), MathHelper.floor(sample.y), MathHelper.floor(sample.z), -2, 3)
                || !inView(sample) || !supplyOutlineGrounded(from)) return false;
        BlockHitResult shown = (BlockHitResult) renderedCrosshair;
        double reach = Math.min(SUPPLY_OUTLINE_REACH, client.player.getBlockInteractionRange());
        return supplyOutlineRay(eye, shown, sample, reach)
            && (eye.equals(checkedSupplyEye) && shown.getPos().equals(now.getPos())
                || supplyOutlineRay(checkedSupplyEye, now, sample, reach));
    }

    /** A negative-only guard for an exact cut chosen by the active supply owner. */
    boolean supplyOutlineCutSafe(BlockHitResult witness) {
        return supplyOutlineCutAdmission(witness) == CutAdmission.ALLOWED;
    }

    boolean supplyOutlineCutObstructedByUnknownOverhead(BlockHitResult witness) {
        return supplyOutlineCutAdmission(witness) == CutAdmission.UNKNOWN_OVERHEAD;
    }

    /** Only the exact selected face already authenticated against the vanilla draw. */
    BlockState supplyOutlineState(BlockHitResult witness) {
        BlockHitResult now = supplyOutlineFace();
        return AgentSupplyOutline.matchesFace(witness, now)
            && client.world.getBlockState(now.getBlockPos()) == renderedSupplyOutline ? renderedSupplyOutline : null;
    }

    private boolean supplyOutlineCutSpace(BlockPos cell, Box hull) {
        var player = client.player;
        BlockPos from = player.getBlockPos();
        int x = cell.getX(), y = cell.getY(), z = cell.getZ();
        return supplyOutlineCell(from, x, y, z, 0, 3) && supplyOutlineGrounded(from)
            && player.getVelocity().horizontalLengthSquared() <= 0.0025
            && !hull.intersects(x, y, z, x + 1.0, y + 1.0, z + 1.0);
    }

    private CutAdmission supplyOutlineCutAdmission(BlockHitResult witness) {
        BlockState state = supplyOutlineState(witness);
        if (state == null) return CutAdmission.BLOCKED;
        BlockPos cell = witness.getBlockPos();
        var player = client.player;
        Box hull = player.getBoundingBox();
        if (!supplyOutlineCutSpace(cell, hull) || state.hasBlockEntity() || state.getBlock() instanceof FallingBlock
                || !fullStepSupport(cell, state) || !AgentSupplyOutline.naturalCut(state)) return CutAdmission.BLOCKED;
        return supplyCutCover.admission(cell, hull, tick, System.nanoTime());
    }

    /** Negative physical placement checks, only across the attached and currently outlined face. */
    boolean supplyOutlinePlacementSafe(BlockHitResult witness, BlockPos destination, BlockState material) {
        BlockHitResult now = supplyOutlineFace();
        if (!AgentSupplyOutline.matchesFace(witness, now) || now.getSide() == Direction.DOWN
                || !placementCell(now).equals(destination)) return false;
        var player = client.player;
        BlockPos from = player.getBlockPos();
        BlockHitResult shown = (BlockHitResult) renderedCrosshair;
        return supplyOutlineCell(from, destination.getX(), destination.getY(), destination.getZ(), -2, 0)
            && (from.getX() != destination.getX() || from.getZ() != destination.getZ())
            && supplyOutlineGrounded(from)
            && AgentSupplyOutline.entersAttachment(eye, shown, destination)
            && AgentSupplyOutline.entersAttachment(checkedSupplyEye, now, destination)
            && stableFootholdAnchor(now.getBlockPos())
            && !dryCaveDanger(material) && !(material.getBlock() instanceof FallingBlock)
            && fullStepSupport(destination, material) && client.world.getBlockState(destination).isAir()
            && !player.getBoundingBox().intersects(new Box(destination))
            && canPlaceRangedCoverAcross(now, material);
    }

    /** A motor veto on the selected support only. Never probe or expose the destination's state. */
    boolean canPlaceStationAcross(BlockHitResult support) {
        BlockHitResult now = selectedFace();
        if (!sameBlockFace(support, now) || now.isInsideBlock()) return false;
        var player = client.player;
        var placement = new ItemPlacementContext(player, Hand.MAIN_HAND, player.getMainHandStack(), now);
        return placement.getBlockPos().equals(placementCell(now));
    }

    boolean canPlaceRangedCoverAcross(BlockHitResult support, BlockState material) {
        BlockHitResult now = selectedFace();
        if (!sameBlockFace(support, now) || now.isInsideBlock()) return false;
        var player = client.player;
        var placement = new ItemPlacementContext(player, Hand.MAIN_HAND, player.getMainHandStack(), now);
        BlockPos cell = placementCell(now);
        return placement.getBlockPos().equals(cell) && placement.canPlace()
            && client.world.canPlace(material, cell, ShapeContext.absent());
    }

    static BlockPos placementCell(BlockHitResult support) {
        return support.getBlockPos().offset(support.getSide());
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
        horizonApplied = null;
        interruptHorizonWade(Refusal.WORLD_OR_CAMERA_UNAVAILABLE);
        horizonWaterLoss = null;
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
        if (mode.supplyOutline()) {
            BlockHitResult selected = supplyOutlineFace();
            if (!AgentSupplyOutline.matchesFace(witness, selected)) return false;
            witness = selected;
        }
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
            BlockHitResult live = mode.supplyOutline() ? witness : contactRay(witness.getPos(), reach);
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
        if (mode.supplyOutline()) {
            // An inset is steering only. It never counts as a selected surface until actually rendered.
            Vec3d point = witness.getPos();
            aimRegion(contact, contact.admits(witness) ? point : contact.inset(point), mode.precise);
            return true;
        }
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
            if (firstValidNanos == 0 && (contactMode.supplyOutline() ? renderedSupplyOutline == contactState
                    : contactMode == Contact.OUTLINE || litFace(seen))) {
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
        if (contactMode.supplyOutline()) {
            return supplyOutlineFace() == now && renderedSupplyOutline == contactState
                && client.world.getBlockState(now.getBlockPos()) == contactState ? null : "vetoed";
        }
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
        return !mode.supplyOutline() && requestContactUse(witness, mode, preparation);
    }

    boolean placeSupplyOutline(BlockHitResult witness, BlockPos destination, BlockState material,
                               Preparation preparation) {
        if (!supplyOutlinePlacementSafe(witness, destination, material)) return false;
        if (preparation == Preparation.READY && (!(client.player.getMainHandStack().getItem() instanceof BlockItem item)
                || item.getBlock() != material.getBlock())) return false;
        return requestContactUse(witness, Contact.SUPPLY_PLACE, preparation);
    }

    private boolean requestContactUse(BlockHitResult witness, Contact mode, Preparation preparation) {
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
    boolean beginStepLeaf(BlockHitResult face, Predicate<BlockPos> protectedBlock) {
        return headroom.beginStepLeaf(tick, face, protectedBlock);
    }
    AgentHeadroom.Report headroomReport() { return headroom.report(); }
    void observeHeadroomBreak(BlockPos position) { headroom.broken(position); }

    AgentVisibleHorizon visibleHorizon() { return visibleHorizon; }

    boolean horizonPulseAvailable(BlockPos contact) {
        return contact != null && !contact.equals(horizonPulseContact);
    }

    /** The rendered sightline can name a distant landmark beyond vanilla's interaction reach. */
    BlockHitResult horizonSightline(double distance) {
        if (!hasView() || distance <= 0) return null;
        if (horizonSightlineFrame != frameSequence) {
            if (horizonCueRays <= 0) return null;
            --horizonCueRays;
            horizonSightlineFrame = frameSequence;
            horizonSightlineHit = litRay(eye.add(client.player.getRotationVector(observedPitch, observedYaw)
                .multiply(range(HORIZON_CUE_RANGE))), Ray.SIGHT);
        }
        double max = range(distance);
        return horizonSightlineHit != null && horizonSightlineHit.getPos().squaredDistanceTo(eye) <= max * max
            ? horizonSightlineHit : null;
    }

    /** Reuse ordinary actual hits before an independent, small pass inside this render. */
    BlockHitResult horizonCue(Predicate<BlockState> matches, double distance, Predicate<BlockHitResult> eligible) {
        if (!hasView() || distance <= 0) return null;
        double max = range(distance);
        if (sampleFrame == frameSequence) {
            var cached = nearestHorizonHit(samples, sampleCount, max, matches, eligible);
            if (cached != null) return cached;
        }
        if (horizonCueFrame != frameSequence) {
            if (horizonCueRays < horizonCueSamples.length) return null;
            horizonCueRays -= horizonCueSamples.length;
            horizonCueFrame = frameSequence;
            double reach = range(HORIZON_CUE_RANGE);
            for (int i = 0; i < horizonCueSamples.length; ++i) {
                inverseViewProjection.transform(clip.set(HORIZON_CUE_U[i], HORIZON_CUE_V[i], 0.9f, 1));
                double x = clip.x / (double) clip.w, y = clip.y / (double) clip.w, z = clip.z / (double) clip.w;
                double scale = reach / Math.sqrt(x * x + y * y + z * z);
                horizonCueSamples[i] = litRay(eye.add(x * scale, y * scale, z * scale), Ray.SIGHT);
            }
        }
        return nearestHorizonHit(horizonCueSamples, horizonCueSamples.length, max, matches, eligible);
    }

    private BlockHitResult nearestHorizonHit(BlockHitResult[] hits, int count, double max,
                                             Predicate<BlockState> matches, Predicate<BlockHitResult> eligible) {
        BlockHitResult best = null;
        double nearest = max * max;
        for (int i = 0; i < count; ++i) {
            var hit = hits[i];
            if (hit == null || hit.isInsideBlock()) continue;
            double squared = hit.getPos().squaredDistanceTo(eye);
            if (squared <= nearest && matches.test(client.world.getBlockState(hit.getBlockPos()))
                    && (eligible == null || eligible.test(hit))) {
                nearest = squared;
                best = hit;
            }
        }
        return best;
    }

    enum HorizonResult { MOVING, SETTLING, ARRIVED, BLOCKED }

    /** One short approach to an independently rendered cue; there is no queue of virtual waypoints. */
    static final class HorizonTravel {
        private static final float GAIT_PITCH = 28, FOOTING_GLANCE_PITCH = 38;
        final AgentVisibleHorizon.Target target;
        final Vec3d goal;
        final double arrival;
        final boolean allowWade;
        private final AgentVisibleHorizon.ContactPulse pulse;
        private final boolean groundScout;
        private final boolean ranged, rangedSprint;
        final float rangedAway;
        private int stoppedAt = -1, precisionTicks;
        private boolean issued, beenDriven, wet, wadeStarted;
        private boolean glanceUsed, glancing;
        private float bearing = Float.NaN, blockedBearing = Float.NaN, issuedBearing = Float.NaN;
        private HorizonMotion motion;
        private BlockPos dryFrom, dryTo;
        private int dryContacts;

        HorizonTravel(AgentVisibleHorizon.Target target, Vec3d goal, double arrival, boolean allowWade) {
            this(target, goal, arrival, allowWade, false);
        }

        HorizonTravel(AgentVisibleHorizon.Target target, Vec3d goal, double arrival, boolean allowWade, boolean allowPulse) {
            this(target, goal, arrival, allowWade, allowPulse, false);
        }

        private HorizonTravel(AgentVisibleHorizon.Target target, Vec3d goal, double arrival, boolean allowWade,
                              boolean allowPulse, boolean groundScout) {
            this(target, goal, arrival, allowWade, allowPulse, groundScout, false, false, Float.NaN);
        }

        private HorizonTravel(AgentVisibleHorizon.Target target, Vec3d goal, double arrival, boolean allowWade,
                              boolean allowPulse, boolean groundScout, boolean ranged, boolean rangedSprint,
                              float rangedAway) {
            this.target = target;
            this.goal = goal;
            this.arrival = arrival;
            this.allowWade = allowWade;
            pulse = allowPulse ? new AgentVisibleHorizon.ContactPulse() : null;
            this.groundScout = groundScout;
            this.ranged = ranged;
            this.rangedSprint = rangedSprint;
            this.rangedAway = rangedAway;
        }

        static HorizonTravel groundScout(AgentVisibleHorizon.Target target, Vec3d goal, double arrival) {
            return new HorizonTravel(target, goal, arrival, false, false, true);
        }

        /** The direction supplies intent only. Each actual forward key still needs a dry window. */
        static HorizonTravel rangedRetreat(Vec3d goal, float away, boolean allowSprint) {
            return new HorizonTravel(null, goal, 0.20, false, false, false, true, allowSprint, away);
        }

        boolean ranged() { return ranged; }

        boolean moved() { return motion != null && motion.moved(); }
        boolean progressed() { return motion != null && motion.progressed; }
        boolean waded() { return wet; }
        boolean pulseIssued() { return pulse != null && pulse.used(); }

        float gazePitch() { return glancing ? FOOTING_GLANCE_PITCH : GAIT_PITCH; }

        void maybeGlance(boolean surfaceMissing, boolean settledGaze) {
            if (!glanceUsed && surfaceMissing && settledGaze) glanceUsed = glancing = true;
        }

        void resumeGaze() { glancing = false; }
    }

    /** Forward input and camera rotation aren't receipts; sample displacement after vanilla consumed the keys. */
    static final class HorizonMotion {
        private final Vec3d origin, goal;
        private final boolean allowSameCell;
        private double nearest;
        private boolean valid = true, moved, progressed, recovered;
        private boolean contact;

        HorizonMotion(Vec3d origin, Vec3d goal) {
            this(origin, goal, false);
        }

        HorizonMotion(Vec3d origin, Vec3d goal, boolean allowSameCell) {
            this.origin = origin;
            this.goal = goal;
            this.allowSameCell = allowSameCell;
            nearest = horizontalDistanceSquared(origin, goal);
        }

        boolean observe(Vec3d from, Vec3d feet, boolean issued, boolean contact, boolean uninterrupted) {
            double displacement = horizontalDistanceSquared(from, feet);
            progressed = false;
            if (!uninterrupted || displacement > 0.31 || Math.abs(feet.y - from.y) > 0.65) valid = false;
            if (!valid) return false;
            double remaining = horizontalDistanceSquared(feet, goal);
            if (displacement > 0.0004 && (issued || moved) && remaining < nearest) {
                nearest = remaining;
                moved |= horizontalDistanceSquared(feet, origin) >= 0.16
                    && (allowSameCell || MathHelper.floor(feet.x) != MathHelper.floor(origin.x)
                        || MathHelper.floor(feet.z) != MathHelper.floor(origin.z));
                progressed = moved;
            }
            if (issued) this.contact = displacement < 0.0009 && contact;
            return true;
        }

        boolean moved() { return valid && moved; }
        boolean contact() { return contact; }

        boolean takeRecovery() {
            if (!contact() || recovered) return false;
            recovered = true;
            contact = false;
            return true;
        }
    }

    private void observeHorizonTravel(ClientPlayerEntity player) {
        HorizonTravel travel = horizonApplied;
        Vec3d feet = player.getPos();
        Vec3d from = horizonAppliedFrom;
        boolean continuous = travel.motion.observe(from, feet, travel.issued && !horizonAppliedPulse, player.horizontalCollision,
            (travel.ranged ? player.hurtTime < 8 : player.hurtTime == 0)
                && !player.hasVehicle() && !player.isOnFire() && !player.isInLava());
        travel.wet |= player.isTouchingWater();
        if (travel.groundScout || travel.ranged) return; // Neither is a retained reversible work route.
        if (!continuous || !travel.beenDriven || !horizonAppliedDry || !player.isOnGround() || player.isTouchingWater()) {
            travel.dryContacts = 0;
            travel.dryFrom = travel.dryTo = null;
        } else if (horizontalDistanceSquared(feet, from) > 0.0004) {
            ++travel.dryContacts;
            BlockPos previous = BlockPos.ofFloored(from);
            BlockPos current = player.getBlockPos();
            // Do not split a diagonal, synthesize a reverse, or connect either bank over a wet leg.
            if (!previous.equals(current)) {
                boolean adjacent = previous.getY() == current.getY()
                    && Math.abs(previous.getX() - current.getX()) + Math.abs(previous.getZ() - current.getZ()) == 1;
                travel.dryFrom = adjacent ? previous : null;
                travel.dryTo = adjacent ? current : null;
            }
            if (travel.dryFrom != null && current.equals(travel.dryTo) && travel.dryContacts >= 3) {
                int dx = current.getX() - travel.dryFrom.getX(), dz = current.getZ() - travel.dryFrom.getZ();
                double within = (feet.x - current.getX() - 0.5) * dx + (feet.z - current.getZ() - 0.5) * dz;
                if (within >= -0.29) {
                    recordWalkedLeg(travel.dryFrom, current);
                    travel.dryFrom = travel.dryTo = null;
                }
            }
        }
    }

    private static double horizontalDistanceSquared(Vec3d first, Vec3d second) {
        double x = first.x - second.x, z = first.z - second.z;
        return x * x + z * z;
    }

    /** The issued lane can own a brief neutral turn without permission to drive on an old frame. */
    boolean horizonControlsWater() {
        if (horizonCrossing != null) checkHorizonWade(horizonCrossingOwner);
        return horizonCrossing != null && ready() && client.player.isTouchingWater();
    }

    boolean horizonWaterInFlight() {
        return client.player != null && client.player.isTouchingWater()
            && (horizonCrossing != null || horizonWaterLoss != null && horizonWaterLostAt >= tick - 1);
    }

    boolean horizonWadeOwns(HorizonTravel travel) {
        return travel != null && horizonCrossing != null && horizonCrossingOwner == travel;
    }

    Refusal horizonWaterLoss() {
        return horizonWaterInFlight() ? horizonWaterLoss : null;
    }

    void interruptHorizonWade(Refusal reason) {
        if (horizonCrossing == null) return;
        horizonCrossing = null;
        horizonCrossingOwner = null;
        horizonCrossingPose = null;
        horizonCrossingView = null;
        horizonWaterLoss = reason;
        horizonWaterLostAt = tick;
        visibleHorizon.reportWade(null, reason);
    }

    private AgentShallowTransit.Pose horizonWadePose(ClientPlayerEntity player, HorizonTravel travel, HorizonView view) {
        BlockPos support = player.supportingBlockPos.orElse(null);
        Vec3d feet = player.getPos();
        Refusal unsafe = !ready() || !client.isWindowFocused() || client.getOverlay() != null
            || client.options.forwardKey.isUnbound() || player.hasVehicle() || player.isClimbing() || player.isUsingItem()
            ? Refusal.INPUT_UNAVAILABLE
            : player.isSubmergedInWater() || player.isSwimming() || player.getAir() < 230
                || player.getFluidHeight(FluidTags.WATER) > 0.56 ? Refusal.DEEP_WATER
            : player.isInLava() || player.isOnFire() || lavaEmergency || macroLavaNear() ? Refusal.HAZARD
            : player.hurtTime != 0 ? Refusal.WADE_HEALTH_CHANGED
            : player.isSprinting() || player.hasStatusEffect(StatusEffects.DOLPHINS_GRACE) ? Refusal.WADE_DRIFT
            : !player.isOnGround() || support == null ? Refusal.SOURCE_UNGROUNDED
            : travel.motion != null && !travel.motion.valid ? Refusal.MOTION_INTERRUPTED
            : travel.motion != null && travel.motion.contact() ? Refusal.COLLISION_CONTACT
            : visibleHorizon.wadeTargetRefusal(travel.target, tick, feet);
        double efficiency = player.isTouchingWater()
            ? player.getAttributeValue(EntityAttributes.WATER_MOVEMENT_EFFICIENCY) : 0;
        double dryAcceleration = player.getAttributeValue(EntityAttributes.MOVEMENT_SPEED);
        double acceleration = MathHelper.lerp(efficiency, 0.024, Math.max(0.024, dryAcceleration));
        double waterDrag = MathHelper.lerp(efficiency, 0.8, 0.546);
        return new AgentShallowTransit.Pose(client.world, player, travel, tick, view == null ? -1 : view.frame(),
            feet, player.getVelocity(), support, player.getWidth() * 0.5,
            player.isTouchingWater(), player.getHealth(), unsafe, dryAcceleration, acceleration, waterDrag);
    }

    private void checkHorizonWade(HorizonTravel travel) {
        if (horizonCrossingChecked == tick || horizonCrossing == null) return;
        horizonCrossingChecked = tick;
        if (client.player == null || horizonAppliedTick != tick - 1 || horizonApplied != travel) {
            interruptHorizonWade(Refusal.INPUT_UNAVAILABLE);
            return;
        }
        horizonCrossingView = horizonView();
        horizonCrossingPose = horizonWadePose(client.player, travel, horizonCrossingView);
        boolean firstWet = horizonCrossingPose.wet() && !horizonCrossing.touchedWater();
        var turn = horizonCrossing.check(horizonCrossingPose, wadeChecks);
        if (turn == AgentShallowTransit.Turn.RECOVER) interruptHorizonWade(horizonCrossing.reason());
        else if (firstWet) visibleHorizon.reportWade("body_contact", null);
    }

    private final AgentShallowTransit.Checks wadeChecks = new AgentShallowTransit.Checks() {
        @Override public AgentVisibleHorizon.Patch physical(int x, int z, AgentVisibleHorizon.Patch seen) {
            // Veto only: inspect the exact formerly witnessed support, at its proved height.
            return horizonSurface(seen.floor(), seen.y());
        }

        @Override public Refusal optical(int x, int z, AgentVisibleHorizon.Patch seen) {
            var view = horizonCrossingView;
            var patch = visibleHorizon.wadePatch(view, x, z);
            if (seen.sameSupport(patch)) return null;
            if (patch.refusal() != Refusal.SURFACE_NOT_RENDERED) return patch.refusal() == null
                ? seen.medium() == AgentVisibleHorizon.Medium.DRY ? Refusal.WADE_BANK_CHANGED : Refusal.WADE_BED_CHANGED
                : patch.refusal();
            // A near proved top can drop below the camera during overlap.
            // Only a projection clip permits using its just-checked physical
            // state. An in-frame occlusion/lost hit is a failed witness.
            double nearestX = MathHelper.clamp(view.feet().x, x, x + 1);
            double nearestZ = MathHelper.clamp(view.feet().z, z, z + 1);
            double near = Math.hypot(nearestX - view.feet().x, nearestZ - view.feet().z);
            double angle = Math.toRadians(observedYaw), level = seen.y() - 0.025;
            boolean clipped = !inView(x + 0.5, level, z + 0.5)
                && !inView(x + 0.5 - 0.39 * Math.sin(angle), level, z + 0.5 + 0.39 * Math.cos(angle));
            if (clipped && near <= horizonCrossingPose.radius() + 0.34) return null;
            return seen.medium() == AgentVisibleHorizon.Medium.DRY
                ? Refusal.DRY_BANK_NOT_RENDERED : Refusal.SURFACE_NOT_RENDERED;
        }

        @Override public Refusal sweep(double dx, double dz, double drift, double coastDistance, double reach) {
            return horizonSweep(dx, dz, drift, coastDistance, reach, AgentVisibleHorizon.Medium.SHALLOW_WATER);
        }
    };

    private static boolean horizonWaterSafe(ClientPlayerEntity player) {
        return !player.isSubmergedInWater() && player.getAir() >= 230 && !player.isOnFire()
            && !player.isInLava() && player.hurtTime == 0;
    }

    static boolean horizonWadeWindow(AgentVisibleHorizon.Window window) {
        return window != null && window.medium() == AgentVisibleHorizon.Medium.SHALLOW_WATER
            && window.dryBank() != null && window.knownDistance() >= window.brakingDistance();
    }

    boolean horizonSafetyAllows(HorizonTravel travel) {
        return ready() && (!client.player.isTouchingWater() || horizonWadeOwns(travel) && horizonControlsWater());
    }

    void stopHorizonTravel(HorizonTravel travel) {
        visibleHorizon.stopDryStride(travel);
        if (horizonWadeOwns(travel)) interruptHorizonWade(Refusal.INPUT_UNAVAILABLE);
        if (horizonIntent != travel) return;
        horizonIntent = null;
        horizonKeyWindow = null;
        horizonForward = horizonSneak = horizonWade = horizonSprint = false;
        horizonSide = 0;
        if (gaitSteering) {
            gaitSteering = steering = false;
            gaitPitchVelocity = 0;
        }
    }

    /** Retain ordinary rolling-key hazard gates without invoking its camera motor or special travel. */
    boolean driveVisualRecon(HorizonTravel travel, AgentVisibleHorizon.Window window, int side, double reach) {
        if (!visualReconStance() || !visualReconSideBound(side) || window.frame() != renderedFrame()
                || window.medium() != AgentVisibleHorizon.Medium.DRY || window.contactOnly()
                || Math.abs(MathHelper.wrapDegrees(window.yaw() - client.player.getYaw() - 45 * side)) > 0.01
                || window.knownDistance() <= reach) return false;
        if (travel.motion == null) travel.motion = new HorizonMotion(client.player.getPos(), travel.goal, true);
        prioritizeMovement();
        horizonIntent = travel;
        horizonHeading = window.yaw();
        horizonReach = reach;
        horizonSide = side;
        horizonForward = true;
        horizonKeyWindow = window;
        return true;
    }

    boolean visualReconStance() {
        return visualReconPosture() && client.player.isOnGround() && !client.player.horizontalCollision;
    }

    boolean visualReconPosture() {
        return dryLandingControls() && client.player.getVehicle() == null && client.player.getAir() >= 230
            && client.getCameraEntity() == client.player && client.options.getPerspective().isFirstPerson();
    }

    boolean visualReconSideBound(int side) {
        return !client.options.forwardKey.isUnbound()
            && (side >= 0 || !client.options.leftKey.isUnbound())
            && (side <= 0 || !client.options.rightKey.isUnbound());
    }

    boolean visualReconInput(boolean advance, int side, boolean jump) {
        var keys = client.options;
        return keys.forwardKey.isPressed() == advance && keys.leftKey.isPressed() == (advance && side < 0)
            && keys.rightKey.isPressed() == (advance && side > 0)
            && !keys.backKey.isPressed() && keys.jumpKey.isPressed() == jump && !keys.sprintKey.isPressed()
            && !keys.sneakKey.isPressed() && !keys.attackKey.isPressed() && !keys.useKey.isPressed();
    }

    boolean visualReconIssued(HorizonTravel travel) {
        return travel != null && horizonApplied == travel && horizonAppliedTick == tick && travel.issued;
    }

    void guardVisualReconKeys(BooleanSupplier grant) { reconInputGrant = grant; }

    private static int horizonSide(float turn) {
        return turn < -23 ? -1 : turn > 23 ? 1 : 0;
    }

    static float horizonGazeTurn(float yaw, float goal) {
        return MathHelper.clamp(MathHelper.wrapDegrees(goal - yaw), -8, 8);
    }

    enum HorizonPace { COAST, SLOW, WALK }

    static HorizonPace horizonPace(double known, double braking, double goal, boolean wet, boolean contactOnly) {
        if (known < braking || goal <= Math.max(0.055, braking - 0.14)) return HorizonPace.COAST;
        if (!wet && !contactOnly && known < braking + 0.20) return HorizonPace.SLOW;
        return HorizonPace.WALK;
    }

    HorizonResult driveHorizon(HorizonTravel travel, boolean keepPickupsClear, boolean targetReady) {
        if (!ready() || lavaEmergency || !client.isWindowFocused() || client.getOverlay() != null
                || client.currentScreen != null || client.options.forwardKey.isUnbound())
            return horizonBlocked(ready() ? lavaEmergency ? Refusal.HAZARD : Refusal.INPUT_UNAVAILABLE
                : horizonViewRefusal());
        var player = client.player;
        if (player.hasVehicle() || player.isClimbing() || player.isUsingItem())
            return horizonBlocked(Refusal.INPUT_UNAVAILABLE);
        if (!horizonWaterSafe(player))
            return horizonBlocked(player.isSubmergedInWater() || player.getAir() < 230 ? Refusal.DEEP_WATER : Refusal.HAZARD);
        if (horizonWadeOwns(travel)) {
            checkHorizonWade(travel);
            if (horizonWadeOwns(travel)) return driveHorizonWade(travel, keepPickupsClear);
        }
        if (travel.wadeStarted || player.isTouchingWater())
            return horizonBlocked(horizonWaterLoss == null ? Refusal.WATER_NOT_ALLOWED : horizonWaterLoss);
        Vec3d feet = player.getPos();
        double dx = travel.goal.x - feet.x, dz = travel.goal.z - feet.z;
        double distance = Math.hypot(dx, dz);
        if (travel.motion == null) travel.motion = new HorizonMotion(feet, travel.goal, travel.groundScout || travel.ranged);
        if (!travel.motion.valid) return horizonBlocked(Refusal.MOTION_INTERRUPTED);
        horizonIntent = travel;
        if (travel.moved() && player.isOnGround() && !player.isTouchingWater()
                && (targetReady || distance <= travel.arrival && Math.abs(feet.y - travel.goal.y) < 0.65)) {
            return player.getVelocity().horizontalLengthSquared() < 0.0025 ? HorizonResult.ARRIVED : HorizonResult.SETTLING;
        }

        if (travel.motion.contact()) {
            // A real contact invalidates that input heading. It is not required
            // to choose a visible shoulder, and never counts as displacement.
            if (player.isTouchingWater() || !travel.motion.takeRecovery())
                return horizonBlocked(Refusal.COLLISION_CONTACT);
            travel.blockedBearing = travel.issuedBearing;
        }
        float direct = heading(dx, dz);
        if (!player.isOnGround()) {
            // Do not correct in midair or press jump into a new or unseen lane.
            return horizonWait(travel, Refusal.SOURCE_UNGROUNDED, null);
        }
        if (travel.pulse != null && !travel.pulse.canJoin(frameSequence))
            return horizonWait(travel, Refusal.CONTACT_PULSE_SPENT, null);
        if (travel.issued) travel.resumeGaze();
        float yaw = player.getYaw();
        float steeringTurn = horizonGazeTurn(yaw, direct);
        boolean left = !client.options.leftKey.isUnbound(), right = !client.options.rightKey.isUnbound();
        var chosen = visibleHorizon.dryKeyWindow(travel, yaw, direct, steeringTurn, travel.blockedBearing,
            left, right);
        boolean dry = chosen != null;
        boolean surfaceMissing = !dry && visibleHorizon.rejectedSurface();
        boolean allowPulse = travel.pulse != null && !travel.pulse.used() && !travel.beenDriven
            && !targetReady && distance > travel.arrival;
        if (!dry && (travel.allowWade || allowPulse)) {
            var special = visibleHorizon.workWindow(travel.target, travel.allowWade, travel.bearing,
                travel.blockedBearing, direct, travel.pulse, allowPulse);
            if (horizonWadeWindow(special) || special != null && special.contactOnly()) chosen = special;
        }
        if (chosen == null) {
            // A lost support can earn one deliberate glance. Neither a lateral
            // correction nor coasting by itself is a reason to look down.
            travel.maybeGlance(surfaceMissing, travel.stoppedAt >= 0 && tick - travel.stoppedAt >= 3
                && player.getVelocity().horizontalLengthSquared() < 0.0025
                && renderedDirection(direct, HorizonTravel.GAIT_PITCH, 6));
            lookAlongGait(direct, travel.gazePitch());
            return horizonWait(travel, null, null);
        }
        boolean wade = !dry && horizonWadeWindow(chosen);
        float gaze = wade ? chosen.yaw() : direct;
        float pitch = wade ? 24 : travel.gazePitch();
        lookAlongGait(gaze, pitch);
        if (wade) travel.bearing = chosen.yaw();
        float turn = MathHelper.wrapDegrees(chosen.yaw() - yaw);
        int lateral = dry ? Math.round(turn / 45) : horizonSide(turn);
        if (lateral < 0 && !left || lateral > 0 && !right) lateral = 0;
        float actual = yaw + 45 * lateral;
        float difference = MathHelper.wrapDegrees(chosen.yaw() - actual);
        if (!dry && Math.abs(difference) > 24) return horizonWait(travel, Refusal.STEERING_ALIGNMENT, chosen);
        boolean local = chosen.contactOnly();
        var window = dry || Math.abs(difference) < 0.01 ? chosen : local ? visibleHorizon.contactWindow(travel.target, actual)
            : visibleHorizon.window(travel.target, actual);
        if (window == null) return horizonWait(travel, null, null);
        if (window.medium() != chosen.medium() || player.isTouchingWater() && !wade)
            return horizonWait(travel, Refusal.WATER_NOT_ALLOWED, window);
        if (player.isSprinting() && !travel.rangedSprint) return horizonWait(travel, Refusal.INPUT_COASTING, window);
        double known = window.knownDistance();
        double braking = window.brakingDistance();
        boolean contactOnly = window.contactOnly();
        // Dry key selection already proved both ends. The special contact and
        // bank paths keep their own equally bounded optical checks.
        if (wade) steeringTurn = horizonGazeTurn(yaw, gaze);
        if (!dry && Math.abs(steeringTurn) > (local ? 0.01 : 3)) {
            var steered = local ? visibleHorizon.contactWindow(travel.target, actual + steeringTurn)
                : visibleHorizon.window(travel.target, actual + steeringTurn);
            if (steered == null) return horizonWait(travel, null, null);
            if (steered.medium() != window.medium() || wade && !horizonWadeWindow(steered))
                return horizonWait(travel, Refusal.WATER_NOT_ALLOWED, steered);
            known = Math.min(known, steered.knownDistance());
            braking = Math.max(braking, steered.brakingDistance());
            contactOnly |= steered.contactOnly();
        }
        double goal = distance - travel.arrival + 0.06;
        if (wade) {
            // Never end an ordinary goal in wet footing; keep the witnessed bank
            // as a completion constraint, not as an unseen substitute destination.
            Vec3d bank = window.dryBank();
            goal = Math.max(goal, Math.hypot(bank.x - feet.x, bank.z - feet.z));
        }
        var pace = horizonPace(known, braking, goal, wade, contactOnly);
        if (pace == HorizonPace.SLOW && (travel.precisionTicks >= 3 || client.options.sneakKey.isUnbound()))
            pace = HorizonPace.COAST;
        if (travel.rangedSprint && pace == HorizonPace.WALK && lateral == 0 && goal > 2.5
                && player.getHungerManager().getFoodLevel() > 6 && !client.options.sprintKey.isUnbound()
                && Math.abs(steeringTurn) <= 3) {
            var sprint = visibleHorizon.rangedSprintWindow(travel, actual, steeringTurn, player.isSprinting());
            if (sprint != null) {
                known = sprint.knownDistance();
                braking = sprint.brakingDistance();
                window = sprint;
                horizonSprint = true;
            }
        }
        if (player.isSprinting() && !horizonSprint) return horizonWait(travel, Refusal.INPUT_COASTING, window);
        if (pace == HorizonPace.COAST) {
            horizonWade = wade;
            return horizonWait(travel, Refusal.INPUT_COASTING, window);
        }
        double reach = Math.min(known, Math.max(braking, 0.30));
        Vec3d end = feet.add(Vec3d.fromPolar(0, actual).multiply(reach));
        if (keepPickupsClear && !macroNoVisiblePickup(end, wade ? feet.y - 0.7 : feet.y, feet.y))
            return horizonWait(travel, Refusal.PICKUP_VETO, window);
        if (hazardAhead(actual, reach)) return horizonWait(travel, Refusal.HAZARD, window);
        // This is an intent for the actual on-foot keys, not a displacement receipt.
        prioritizeMovement();
        lookAlongGait(yaw + steeringTurn, pitch);
        horizonHeading = actual;
        horizonReach = reach;
        horizonSide = lateral;
        horizonForward = true;
        horizonKeyWindow = window;
        horizonSneak = pace == HorizonPace.SLOW;
        if (horizonSneak) ++travel.precisionTicks;
        horizonWade = wade;
        travel.stoppedAt = -1;
        return HorizonResult.MOVING;
    }

    private HorizonResult driveHorizonWade(HorizonTravel travel, boolean keepPickupsClear) {
        var crossing = horizonCrossing;
        if (crossing.turn() == AgentShallowTransit.Turn.LANDED) {
            horizonCrossing = null;
            horizonCrossingOwner = null;
            horizonCrossingPose = null;
            horizonCrossingView = null;
            visibleHorizon.reportWade("landed", null);
            return HorizonResult.ARRIVED;
        }
        horizonIntent = travel;
        horizonWade = true;
        Vec3d feet = horizonCrossingPose.feet(), bank = crossing.bank();
        float aim = heading(bank.x - feet.x, bank.z - feet.z);
        float yaw = client.player.getYaw();
        float turn = MathHelper.wrapDegrees(aim - yaw);
        // Gaze can follow the fixed bank through the transition; never steer
        // toward another bank or rely on a stale image for another keypress.
        lookAlongGait(aim, 32);
        if (crossing.turn() == AgentShallowTransit.Turn.COAST || Math.abs(turn) > 9) return HorizonResult.SETTLING;
        float steering = MathHelper.clamp(turn, -8, 8);
        Refusal veto = crossing.inputVeto(horizonCrossingPose, wadeChecks, yaw);
        if (veto == null && Math.abs(steering) > 0.01)
            veto = crossing.inputVeto(horizonCrossingPose, wadeChecks, yaw + steering);
        if (veto == Refusal.WADE_DRIFT) return HorizonResult.SETTLING; // neutral braking still fits
        double reach = crossing.inputReach();
        Vec3d end = feet.add(Vec3d.fromPolar(0, yaw).multiply(reach));
        if (veto == null && keepPickupsClear && !macroNoVisiblePickup(end, feet.y - 0.7, feet.y))
            veto = Refusal.PICKUP_VETO;
        if (veto != null) {
            interruptHorizonWade(veto);
            return horizonBlocked(veto);
        }
        prioritizeMovement();
        horizonHeading = yaw;
        horizonReach = reach;
        horizonForward = true;
        return HorizonResult.MOVING;
    }

    private HorizonResult horizonWait(HorizonTravel travel, Refusal stage, AgentVisibleHorizon.Window window) {
        if (travel.stoppedAt < 0) travel.stoppedAt = tick;
        boolean blocked = tick - travel.stoppedAt >= HORIZON_WAIT_TICKS;
        visibleHorizon.reportDrive(stage, window, blocked);
        return blocked ? HorizonResult.BLOCKED : HorizonResult.SETTLING;
    }

    private HorizonResult horizonBlocked(Refusal stage) {
        visibleHorizon.reportDrive(stage, null, true);
        return HorizonResult.BLOCKED;
    }

    String rangedFootingRefusal() {
        var reason = visibleHorizon.driveRefusal();
        return reason == null ? "no checked dry foothold" : reason.key;
    }

    void sneak() { sneaking = true; }
    void swimDown() { swimmingDown = true; }
    void holdUse() { eating = true; }

    boolean miningFootingRefused(BlockPos target) {
        return contactTick == tick && (contactMode == Contact.MINE || contactMode == Contact.SUPPLY_MINE
                || contactMode == Contact.SUPPLY_CLEAR) && contact != null
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
        return requestMine(witness, Contact.MINE);
    }

    boolean mineSupplyOutline(BlockHitResult witness) {
        if (!supplyOutlineCutSafe(witness)) return false;
        var held = client.player.getMainHandStack();
        if (renderedSupplyOutline.isToolRequired() && !held.isSuitableFor(renderedSupplyOutline)) return false;
        return requestMine(witness, Contact.SUPPLY_MINE);
    }

    /** Explicit ordinary egress clearance; only vanilla may break the block or yield a drop. */
    OutlineClearance clearSupplyOutline(BlockHitResult witness) {
        if (!supplyEscapeInputSafe()) return OutlineClearance.UNSAFE;
        BlockState state = supplyOutlineState(witness);
        if (state == null) return OutlineClearance.UNSAFE;
        BlockPos cell = witness.getBlockPos();
        var player = client.player;
        var held = player.getMainHandStack();
        long nanos = System.nanoTime();
        if (!supplyEscapeFaceSafe(cell, state, held, nanos)
                || supplyEscapeWork.active() && !supplyEscapeWork.matches(witness, state, held))
            return OutlineClearance.UNSAFE;
        float crack = supplyEscapeWork.active() ? supplyEscapeCrack(cell) : 0;
        OutlineClearance work = supplyEscapeWork.check(tick, state.calcBlockBreakingDelta(player, client.world, cell), crack);
        if (work != OutlineClearance.REQUESTED) return work;
        if (!requestMine(witness, Contact.SUPPLY_CLEAR))
            return miningFootingRefused(cell) ? OutlineClearance.UNSAFE : OutlineClearance.WAIT;
        if (!supplyEscapeWork.active()) supplyEscapeWork.start(witness, state, held, tick);
        supplyEscapeWork.drawn(observedAtTick, observedAtNanos);
        return OutlineClearance.REQUESTED;
    }

    /** A gap may preserve existing vanilla work; it cannot start or retarget an attack. */
    OutlineClearance continueSupplyOutlineClearance(BlockPos cell) {
        if (!supplyEscapeInputSafe()) return OutlineClearance.UNSAFE;
        if (!supplyEscapeWork.active() || observedWorld != client.world || observedPlayer != client.player
                || !(renderedCrosshair instanceof BlockHitResult seen)
                || !(currentCrosshair() instanceof BlockHitResult now)) return OutlineClearance.WAIT;
        long nanos = System.nanoTime();
        float crack = supplyEscapeCrack(cell);
        if (!supplyEscapeWork.bridges(seen, now, tick, nanos, crack) || !contact.admits(now))
            return OutlineClearance.WAIT;
        var player = client.player;
        var held = player.getMainHandStack();
        BlockState state = client.world.getBlockState(now.getBlockPos());
        if (renderedSupplyOutline != null && renderedSupplyOutline != state
                || !supplyEscapeWork.matches(now, state, held)
                || !supplyEscapeFaceSafe(cell, state, held, nanos)
                || !supplyOutlineRay(player.getEyePos(), now, null,
                    Math.min(SUPPLY_OUTLINE_REACH, player.getBlockInteractionRange()))) return OutlineClearance.UNSAFE;
        OutlineClearance work = supplyEscapeWork.check(tick, state.calcBlockBreakingDelta(player, client.world, cell), crack);
        if (work != OutlineClearance.REQUESTED) return work;
        contactTick = tick;
        if (refuseSupportingMine()) return OutlineClearance.UNSAFE;
        aimRegion(contact, now.getPos(), false);
        mining = cell;
        return OutlineClearance.REQUESTED;
    }

    private boolean supplyEscapeInputSafe() {
        if (!ordinaryOutlineExitEnabled || !ready() || client.options.hudHidden || client.interactionManager == null
                || !client.isWindowFocused() || client.getOverlay() != null || client.options.attackKey.isUnbound())
            return false;
        var player = client.player;
        return !player.getAbilities().creativeMode && !player.isUsingItem() && !player.isTouchingWater()
            && !player.isSubmergedInWater() && !player.isInLava() && !player.hasVehicle();
    }

    private boolean supplyEscapeFaceSafe(BlockPos cell, BlockState state, ItemStack held, long nanos) {
        if (!(held.isEmpty() || held.isOf(Items.WOODEN_PICKAXE)) || !AgentSupplyOutline.escapeMaterial(state)
                || dryCaveDanger(state) || !fullStepSupport(cell, state)) return false;
        Box hull = client.player.getBoundingBox();
        return !AgentSupplyOutline.CutCover.underColumn(cell, hull) && supplyOutlineCutSpace(cell, hull)
            && supplyCutCover.allows(cell, hull, tick, nanos) && !hazards.lavaNear(hull, 0.12, tick);
    }

    private float supplyEscapeCrack(BlockPos cell) {
        if (contact == null || contactMode != Contact.SUPPLY_CLEAR || !cell.equals(lastHeldMine)
                || lastHeldMineTick != tick - 1 || !client.interactionManager.isBreakingBlock()
                || !(client.interactionManager instanceof AgentMiningAccess nativeMining)) return 0;
        return AgentSupplyOutline.observedCrack(cell, nativeMining.agent$breakingPos(), nativeMining.agent$breakingProgress());
    }

    private boolean requestMine(BlockHitResult witness, Contact mode) {
        if (!prepareContact(witness, mode)) return false;
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
        return hasView() && strikeContact(target, currentCrosshair());
    }

    boolean renderedMeleeStrike(Entity target) {
        return hasView() && renderedCrosshair instanceof EntityHitResult seen && seen.getEntity() == target
            && strikeContact(target, currentCrosshair());
    }

    private boolean strikeContact(Entity target, HitResult actual) {
        return actual instanceof EntityHitResult hit && hit.getEntity() == target
            && (!(target instanceof EndermanEntity enderman) || hasView()
                && threats.canStrikeEnderman(enderman, hit.getPos().y, enderman.getEyeY(), enderman.getHeight()));
    }

    private boolean mayContact(Entity target) {
        return !(target instanceof EndermanEntity enderman) || hasView() && threats.canContactEnderman(enderman);
    }

    boolean hasRecentView() { return hasView(); }

    private AgentVisual visual;

    AgentVisual visual() { return visual; }
    void bindVisual(AgentVisual visual) { this.visual = visual; }

    // Read-only bridge from the actual START callback. Never recompute FOV from player settings.
    boolean copyVisualProjection(AgentVisualProjection view) {
        if (!hasView()) return false;
        view.eye = eye;
        view.yaw = observedYaw;
        view.pitch = observedPitch;
        view.matrix.set(viewProjection);
        view.inverse.set(inverseViewProjection);
        return true;
    }

    long renderedFrame() { return frameSequence; }

    int renderedViewAgeTicks() {
        return observedAtNanos != 0 && observedWorld == client.world && observedPlayer == client.player
            ? tick - observedAtTick : -1;
    }

    boolean renderedDirection(float yaw, float pitch, float tolerance) {
        return hasView() && Math.abs(MathHelper.wrapDegrees(observedYaw - yaw)) <= tolerance
            && Math.abs(observedPitch - pitch) <= tolerance;
    }

    boolean renderedAim(Vec3d point, float tolerance) {
        return hasView() && renderedDirection(heading(point.x - eye.x, point.z - eye.z),
            (float) Math.toDegrees(Math.atan2(eye.y - point.y, Math.hypot(point.x - eye.x, point.z - eye.z))),
            tolerance);
    }

    record HorizonView(ClientWorld world, ClientPlayerEntity player, Vec3d eye, Vec3d feet,
                       Vec3d velocity, long frame, int tick, int ageTicks, double displacement, float yaw, float pitch) {}

    HorizonView horizonView() {
        if (!hasView() || System.nanoTime() - observedAtNanos > 160_000_000L) return null;
        var player = client.player;
        double displacement = eye.distanceTo(player.getEyePos());
        return displacement <= 0.36
            ? new HorizonView(client.world, player, eye, player.getPos(), player.getVelocity(),
                frameSequence, tick, tick - observedAtTick, displacement, observedYaw, observedPitch) : null;
    }

    Refusal horizonViewRefusal() {
        return !ready() || observedWorld != client.world || observedPlayer != client.player || eye == null
            ? Refusal.WORLD_OR_CAMERA_UNAVAILABLE : Refusal.VIEW_STALE_OR_SHIFTED;
    }

    boolean horizonBearingInView(HorizonView view, float yaw) {
        double angle = Math.toRadians(yaw), pitch = Math.toRadians(observedPitch);
        double horizontal = Math.cos(pitch);
        return inView(view.eye.x - Math.sin(angle) * horizontal, view.eye.y - Math.sin(pitch),
            view.eye.z + Math.cos(angle) * horizontal);
    }

    /** A passed-in candidate is just a ray direction until its exact lit point and face are seen. */
    BlockHitResult horizonWitness(BlockHitResult witness) {
        return horizonWitness(witness, false, Ray.SIGHT);
    }

    BlockHitResult horizonRecheck(BlockHitResult witness) {
        return horizonWitness(witness, true, Ray.SIGHT);
    }

    private BlockHitResult horizonWitness(BlockHitResult witness, boolean recheck, Ray ray) {
        if (witness == null || witness.getType() != HitResult.Type.BLOCK || witness.isInsideBlock()) return null;
        Vec3d point = witness.getPos();
        double distance = eye.distanceTo(point);
        if (distance < 0.05 || distance > range(MAX_RANGE) || !inView(point)) return null;
        // All three caches contain actual lit Ray.SIGHT first hits from this exact
        // projection, never a vanilla outline or a sample with different fluid semantics.
        if (!recheck) {
            if (horizonSightlineFrame == frameSequence && horizonSightlineHit == witness) return witness;
            if (horizonCueFrame == frameSequence) for (var hit : horizonCueSamples) if (hit == witness) return witness;
            if (sampleFrame == frameSequence) for (int i = 0; i < sampleCount; ++i) if (samples[i] == witness) return witness;
        }
        if (horizonWitnessRays <= 0) {
            visibleHorizon.notePreview(Refusal.TARGET_RAY_BUDGET);
            return null;
        }
        --horizonWitnessRays;
        double inset = 0.022 / distance;
        var hit = litRay(point.add((point.x - eye.x) * inset, (point.y - eye.y) * inset,
            (point.z - eye.z) * inset), ray);
        return sameBlockFace(witness, hit) && !hit.isInsideBlock()
            && point.squaredDistanceTo(hit.getPos()) < 0.0064 ? hit : null;
    }

    AgentVisibleHorizon.Stance horizonStance(HorizonView view) {
        var player = view.player;
        if (lavaEmergency || player.isOnFire() || player.isInLava()) return visibleHorizon.refuseStance(Refusal.HAZARD);
        if (player.isSubmergedInWater() || player.isSwimming() || player.getAir() < 230)
            return visibleHorizon.refuseStance(Refusal.DEEP_WATER);
        if (!player.isOnGround() || player.hasVehicle()) return visibleHorizon.refuseStance(Refusal.SOURCE_UNGROUNDED);
        var support = player.supportingBlockPos.orElse(null);
        if (support == null) return visibleHorizon.refuseStance(Refusal.SOURCE_CONTACT_MISSING);
        boolean wet = player.isTouchingWater();
        if (wet && player.getFluidHeight(FluidTags.WATER) > 0.57) return visibleHorizon.refuseStance(Refusal.DEEP_WATER);
        var patch = horizonSurface(support, view.feet.y);
        if (patch.refusal() != null) return visibleHorizon.refuseStance(switch (patch.refusal()) {
            case SURFACE_HEIGHT -> Refusal.SOURCE_SUPPORT_HEIGHT;
            case UNSUITABLE_TOP -> Refusal.SOURCE_UNSUITABLE_SUPPORT;
            default -> patch.refusal();
        });
        double speed = player.getAttributeValue(EntityAttributes.MOVEMENT_SPEED);
        // Walking acceleration uses the block's slipperiness, then movement is damped.
        double ratio = 0.6 / (patch.drag() / 0.91);
        double acceleration = wet ? Math.max(0.022, speed) : speed * ratio * ratio * ratio;
        return new AgentVisibleHorizon.Stance(view.feet.x, view.feet.y, view.feet.z,
            player.getWidth() * 0.5 + 0.012, view.velocity, acceleration,
            wet ? Math.max(0.8, patch.drag()) : patch.drag(), wet, support);
    }

    /** Only the source's actual grounded contact bypasses an optical top hit. */
    AgentVisibleHorizon.Patch horizonPatch(HorizonView view, int x, int z) {
        BlockPos contact = view.player.supportingBlockPos.orElse(null);
        if (contact != null && contact.getX() == x && contact.getZ() == z)
            return horizonSurface(contact, view.feet.y);
        double yaw = Math.toRadians(observedYaw);
        double xFar = x + 0.5 - 0.39 * Math.sin(yaw), zFar = z + 0.5 + 0.39 * Math.cos(yaw);
        AgentVisibleHorizon.Patch patch = horizonTop(x, z, xFar, view.feet.y, zFar);
        // Once a genuine visible top was vetoed, a second point cannot make
        // that cell safe. It can only recover a clipped or occluded ray.
        if (patch.refusal() != Refusal.SURFACE_NOT_RENDERED) return patch;
        return horizonTop(x, z, x + 0.5, view.feet.y, z + 0.5);
    }

    /** Projection only: an in-frame missed or occluded top is not a clipped witness. */
    boolean horizonTopClipped(HorizonView view, int x, int z) {
        double level = view.feet.y - 0.025, yaw = Math.toRadians(observedYaw);
        return !inView(x + 0.5 - 0.39 * Math.sin(yaw), level, z + 0.5 + 0.39 * Math.cos(yaw))
            && !inView(x + 0.5, level, z + 0.5);
    }

    private AgentVisibleHorizon.Patch horizonTop(int x, int z, double scanX, double level, double scanZ) {
        if (!inView(scanX, level - 0.025, scanZ)) return Refusal.SURFACE_NOT_RENDERED.unavailable;
        if (horizonTerrainRays <= 0) return Refusal.SURFACE_RAY_BUDGET.unavailable;
        --horizonTerrainRays;
        var hit = litRay(new Vec3d(scanX, level - 0.025, scanZ), Ray.HORIZON_TOP);
        if (hit == null || hit.isInsideBlock()) return Refusal.SURFACE_NOT_RENDERED.unavailable;
        BlockPos support = hit.getBlockPos();
        if (support.getX() != x || support.getZ() != z) return Refusal.SURFACE_NOT_RENDERED.unavailable;
        if (hit.getSide() != Direction.UP) {
            if (hit.getSide().getAxis().isHorizontal()) {
                Direction bearing = hit.getSide().getOpposite();
                if (AgentSurfaceTread.ordinaryRiseSide(client.player.getBlockPos(), bearing, hit))
                    horizonGradeSides[bearing.ordinal()] = hit;
            }
            BlockState visible = client.world.getBlockState(support);
            return visible.isIn(BlockTags.LEAVES) && support.getY() + 1.0 > level + 0.055
                ? Refusal.LEAF_HEIGHT.unavailable : Refusal.SURFACE_NOT_RENDERED.unavailable;
        }
        // The optical ray already traversed the open side of this face. Sample only it,
        // not a column beyond the top (or blocks behind an opaque intercept).
        if (Math.abs(hit.getPos().y - level) > 0.055) {
            var from = client.player.getBlockPos();
            Direction bearing = AgentSurfaceTread.prospectLevelBearing(from, support);
            if (bearing != null && support.getY() == from.getY() && matchesDryRouteTop(hit, support))
                horizonRiserTops[bearing.ordinal()] = hit;
            return client.world.getBlockState(support).isIn(BlockTags.LEAVES)
                ? Refusal.LEAF_HEIGHT.unavailable : Refusal.SURFACE_HEIGHT.unavailable;
        }
        return horizonSurface(support, hit.getPos().y);
    }

    record OrdinaryGrade(BlockPos from, Direction bearing, BlockPos floor, BlockState source,
                         BlockState surface, long frame, AgentSurfaceTread.Edge edge) {
        BlockPos to() { return floor.up(); }
        boolean lookOnly() { return edge == null; }
        Vec3d topAim() {
            return Vec3d.ofBottomCenter(to()).add(0.42 * bearing.getOffsetX(), -0.025, 0.42 * bearing.getOffsetZ());
        }
    }

    /** One goalward adjacent column, not a search for hidden higher or lower supports. */
    OrdinaryGrade ordinaryGrade(Vec3d goal) {
        var view = horizonView();
        if (view == null) return null;
        var player = view.player;
        BlockPos from = player.getBlockPos();
        double dx = goal.x - view.feet.x, dz = goal.z - view.feet.z;
        Direction bearing = Math.abs(dx) >= Math.abs(dz) ? dx > 0 ? Direction.EAST : Direction.WEST
            : dz > 0 ? Direction.SOUTH : Direction.NORTH;
        BlockPos beside = from.offset(bearing);
        Vec3d next = Vec3d.ofBottomCenter(beside);
        double before = Math.hypot(dx, dz);
        if (before - Math.hypot(goal.x - next.x, goal.z - next.z) < 0.32) return null;
        BlockState source = ordinaryGradeSource(from, bearing);
        if (source == null) return null;
        int bit = 1 << bearing.ordinal();
        if ((horizonGradeChecked & bit) != 0) return horizonGrades[bearing.ordinal()];
        horizonGradeChecked |= bit;

        // Sample only the two exact +/- 1 landing heights. Missing support at
        // level is not evidence of a descent. A riser side is only a look cue.
        var upper = ordinaryGradeTopHit(beside, bearing);
        var grade = upper == null ? ordinaryGradeTop(from, bearing, source, ordinaryGradeTopHit(beside.down(2), bearing))
            : ordinaryGradeTop(from, bearing, source, upper);
        if (grade == null && upper == null) {
            var side = horizonGradeSides[bearing.ordinal()];
            if (side == null) side = ordinaryGradeRay(Vec3d.ofCenter(beside, 0.15));
            if (AgentSurfaceTread.ordinaryRiseSide(from, bearing, side)) {
                BlockState seen = client.world.getBlockState(beside);
                if (stableDryRouteTop(beside, seen) && !dryCaveDanger(seen))
                    grade = new OrdinaryGrade(from, bearing, beside, source, seen, view.frame, null);
            }
        }
        horizonGrades[bearing.ordinal()] = grade;
        return grade;
    }

    /** After the one look, only the exact same previously seen obstacle can become the landing. */
    OrdinaryGrade ordinaryGradeAfterLook(OrdinaryGrade cue) {
        var view = horizonView();
        if (view == null || view.frame <= cue.frame || ordinaryGradeSource(cue.from, cue.bearing) != cue.source)
            return null;
        var proved = ordinaryGradeTop(cue.from, cue.bearing, cue.source, ordinaryGradeTopHit(cue.floor, cue.bearing));
        return proved != null && proved.surface == cue.surface ? proved : null;
    }

    private BlockState ordinaryGradeSource(BlockPos from, Direction bearing) {
        var player = client.player;
        if (!from.down().equals(player.supportingBlockPos.orElse(null))
                || player.getPose() != EntityPose.STANDING || player.isSprinting() || player.isUsingItem()
                || player.isTouchingWater() || player.isClimbing() || player.getAbilities().flying
                || player.hasStatusEffect(StatusEffects.JUMP_BOOST) || player.hasStatusEffect(StatusEffects.SLOW_FALLING)
                || !drySurveyLaneCentered(from, player.getX(), player.getZ(), bearing)
                || player.getVelocity().horizontalLengthSquared() > 0.0025
                || client.options.forwardKey.isUnbound() || client.options.jumpKey.isUnbound()) return null;
        return dryCaveContact(from);
    }

    private BlockHitResult ordinaryGradeTopHit(BlockPos floor, Direction bearing) {
        var hit = horizonRiserTops[bearing.ordinal()];
        if (hit == null || !hit.getBlockPos().equals(floor))
            hit = ordinaryGradeRay(Vec3d.ofBottomCenter(floor.up()).add(0.42 * bearing.getOffsetX(), -0.025,
                0.42 * bearing.getOffsetZ()));
        return matchesDryRouteTop(hit, floor) && !hit.isInsideBlock() ? hit : null;
    }

    private OrdinaryGrade ordinaryGradeTop(BlockPos from, Direction bearing, BlockState source, BlockHitResult hit) {
        if (hit == null) return null;
        BlockPos floor = hit.getBlockPos(), to = floor.up();
        BlockState surface = client.world.getBlockState(floor);
        if (!stableDryRouteTop(floor, surface)) return null;
        var edge = AgentSurfaceTread.witnessedGradeEdge(from, source, bearing, hit, surface,
            walkedLaneDry(from, to, bearing) && AgentSurfaceTread.reverseClear(client, from, to, bearing)
                && ordinaryGradeSweep(from, to));
        return edge == null ? null : new OrdinaryGrade(from, bearing, floor, source, surface, frameSequence, edge);
    }

    private BlockHitResult ordinaryGradeRay(Vec3d point) {
        if (horizonGradeRays <= 0 || !inView(point)) return null;
        --horizonGradeRays;
        return litRay(point, Ray.TERRAIN);
    }

    enum ScoutRiseEvidence { RANGE, SECTOR, VISIBILITY, CONTROLS, ALIGNMENT, SUPPORT, CLEARANCE, PICKUP, OFFERED }
    record ScoutRise(BlockHitResult top, OrdinaryGrade grade, ScoutRiseEvidence evidence) {}

    static boolean adjacentScoutRise(BlockPos from, BlockPos floor) {
        return from.getY() == floor.getY()
            && Math.abs(from.getX() - floor.getX()) + Math.abs(from.getZ() - floor.getZ()) == 1;
    }

    boolean scoutRisePhysics() {
        var player = client.player;
        return dryLandingControls() && !player.isGliding() && !player.hasStatusEffect(StatusEffects.JUMP_BOOST)
            && player.getAttributeValue(EntityAttributes.JUMP_STRENGTH) >= 0.419
            && player.getAttributeValue(EntityAttributes.JUMP_STRENGTH) <= 0.421
            && player.getAttributeValue(EntityAttributes.SAFE_FALL_DISTANCE) >= 2.0
            && player.fallDistance <= 1.4;
    }

    ScoutRise scoutRise(BlockHitResult witness) {
        var player = client.player;
        BlockPos from = player.getBlockPos(), floor = witness.getBlockPos();
        if (!adjacentScoutRise(from, floor))
            return new ScoutRise(null, null, ScoutRiseEvidence.RANGE);
        Direction bearing = AgentSurfaceTread.prospectLevelBearing(from, floor);
        var view = horizonView();
        if (view == null) return new ScoutRise(null, null, ScoutRiseEvidence.VISIBILITY);
        if (!horizonBearingInView(view, bearing.getPositiveHorizontalDegrees()))
            return new ScoutRise(null, null, ScoutRiseEvidence.SECTOR);
        if (!matchesDryRouteTop(witness, floor) || witness.isInsideBlock())
            return new ScoutRise(null, null, ScoutRiseEvidence.VISIBILITY);
        if (!scoutRisePhysics() || client.options.jumpKey.isUnbound())
            return new ScoutRise(null, null, ScoutRiseEvidence.CONTROLS);
        if (!drySurveyLaneCentered(from, player.getX(), player.getZ(), bearing))
            return new ScoutRise(null, null, ScoutRiseEvidence.ALIGNMENT);
        BlockState source = ordinaryGradeSource(from, bearing), surface = client.world.getBlockState(floor);
        if (source == null || !normalDryTraction(source) || !normalDryTraction(surface) ||
                !stableDryRouteTop(floor, surface) || dryCaveDanger(surface))
            return new ScoutRise(null, null, ScoutRiseEvidence.SUPPORT);
        var proved = ordinaryGradeTop(from, bearing, source, witness);
        if (proved == null) return new ScoutRise(null, null, ScoutRiseEvidence.CLEARANCE);
        if (!macroNoVisiblePickup(Vec3d.ofBottomCenter(proved.to()), from.getY(), proved.to().getY() + 0.32))
            return new ScoutRise(null, null, ScoutRiseEvidence.PICKUP);
        return new ScoutRise(witness, proved, ScoutRiseEvidence.OFFERED);
    }

    ScoutRise scoutRise(BlockPos floor, Direction bearing) {
        var top = ordinaryGradeTopHit(floor, bearing);
        return top == null ? new ScoutRise(null, null, ScoutRiseEvidence.VISIBILITY) : scoutRise(top);
    }

    enum DryLandingEvidence { CONTROLS, SOURCE, NO_LIT_ADJACENT_TOP, FALL_BOUND, SWEEP, PICKUP, OFFERED }
    private DryLandingEvidence dryLandingEvidence;
    DryLandingEvidence dryLandingEvidence() { return dryLandingEvidence; }

    private static final float[] GROUND_U = {0, -0.32f, 0.32f, -0.63f, 0.63f};
    private static final float[] GROUND_V = {-0.72f, -0.38f, -0.05f};
    private static final int GROUND_FAN_RAYS = GROUND_U.length * GROUND_V.length;
    // Six bounded adjacent lip checks and room to veto pickups after the fan.
    private static final int GROUND_PROOF_RAYS = 8;
    private final BlockHitResult[] nearGroundTops = new BlockHitResult[GROUND_FAN_RAYS];
    private final int[] nearGroundSectors = new int[3];
    private long nearGroundFrame = -1;
    private int nearGroundExamined, nearGroundFromY;
    private int nearGroundCount, nearGroundClipped, nearGroundOccluded, nearGroundDark, nearGroundMissed, nearGroundUnsafe;
    private int landingProbeClipped, landingProbeOccluded;

    int reserveGroundScoutRays() {
        int examined = nearGroundFrame == frameSequence && nearGroundFromY == client.player.getBlockY() ? nearGroundExamined : 0;
        int reserved = groundScoutRayReserve(raysLeft, examined);
        raysLeft -= reserved;
        return reserved;
    }

    static int groundScoutRayReserve(int available, int examined) {
        return Math.min(available, GROUND_FAN_RAYS - examined + GROUND_PROOF_RAYS);
    }

    static int groundFanEnd(int available, int examined) {
        return examined + Math.min(available, GROUND_FAN_RAYS - examined);
    }

    void releaseGroundScoutRays(int reserved) { raysLeft += reserved; }

    /** Actual first hits through one bounded lower-frustum fan, never a scan behind a surface. */
    int sampleNearGround() {
        if (!hasView()) return 0;
        int fromY = client.player.getBlockY();
        if (nearGroundFrame != frameSequence || nearGroundFromY != fromY) {
            nearGroundFrame = frameSequence;
            nearGroundFromY = fromY;
            nearGroundExamined = nearGroundCount = nearGroundClipped = nearGroundOccluded = nearGroundDark = nearGroundMissed = nearGroundUnsafe = 0;
            landingProbeClipped = landingProbeOccluded = 0;
            Arrays.fill(nearGroundSectors, 0);
        }
        int endRay = groundFanEnd(raysLeft, nearGroundExamined);
        while (nearGroundExamined < endRay) {
            int iRay = nearGroundExamined++;
            float u = GROUND_U[iRay % GROUND_U.length], v = GROUND_V[iRay / GROUND_U.length];
            inverseViewProjection.transform(clip.set(u, v, 0.9f, 1));
            double x = clip.x / (double) clip.w, y = clip.y / (double) clip.w, z = clip.z / (double) clip.w;
            double scale = Math.min(5, range(5)) / Math.sqrt(x * x + y * y + z * z);
            --raysLeft;
            BlockHitResult hit = raycast(eye.add(x * scale, y * scale, z * scale), Ray.TERRAIN);
            if (hit.getType() != HitResult.Type.BLOCK) { ++nearGroundMissed; continue; }
            if (!inView(hit.getPos())) { ++nearGroundClipped; continue; }
            if (!litFace(hit)) { ++nearGroundDark; continue; }
            BlockPos floor = hit.getBlockPos();
            if (hit.isInsideBlock() || !matchesDryRouteTop(hit, floor)) { ++nearGroundOccluded; continue; }
            int sector = u < -0.10 ? 0 : u > 0.10 ? 2 : 1;
            nearGroundSectors[sector] |= 1 << AgentGroundVantage.clipHeight(floor.getY() + 1 - fromY);
            BlockState seen = client.world.getBlockState(floor);
            if (dryCaveDanger(seen) || !stableDryRouteTop(floor, seen)) { ++nearGroundUnsafe; continue; }
            boolean duplicate = false;
            for (int i = 0; i < nearGroundCount; ++i) if (nearGroundTops[i].getBlockPos().equals(floor)) {
                duplicate = true;
                break;
            }
            if (!duplicate) nearGroundTops[nearGroundCount++] = hit;
        }
        return nearGroundCount;
    }

    BlockHitResult nearGroundTop(int index) { return nearGroundTops[index]; }

    record GroundSight(int raysTaken, int unexamined, int dryTops, int clipped, int occluded, int dark, int missed, int unsafe,
                       int leftHeights, int centerHeights, int rightHeights, int lipClipped, int lipOccluded) {}

    GroundSight groundSight() {
        return new GroundSight(nearGroundExamined, GROUND_FAN_RAYS - nearGroundExamined,
            nearGroundCount, nearGroundClipped, nearGroundOccluded, nearGroundDark, nearGroundMissed,
            nearGroundUnsafe, nearGroundSectors[0], nearGroundSectors[1], nearGroundSectors[2],
            landingProbeClipped, landingProbeOccluded);
    }

    AgentDryLanding visibleDryLanding(Predicate<BlockPos> untried) {
        landingProbeClipped = landingProbeOccluded = 0;
        dryLandingEvidence = DryLandingEvidence.CONTROLS;
        if (!dryLandingControls() || !client.player.isOnGround()) return null;
        var player = client.player;
        Vec3d from = player.getPos();
        BlockPos source = player.getBlockPos(), support = source.down();
        dryLandingEvidence = DryLandingEvidence.SOURCE;
        if (!support.equals(player.supportingBlockPos.orElse(null))) return null;
        BlockState upper = dryCaveContact(source);
        if (upper == null || !normalDryTraction(upper)) return null;
        dryLandingEvidence = DryLandingEvidence.NO_LIT_ADJACENT_TOP;
        int tops = sampleNearGround();
        for (int i = 0; i < tops; ++i) {
            var direct = dryLandingFromTop(source, upper, from, nearGroundTop(i), untried);
            if (direct != null) return direct;
        }
        Direction facing = Direction.fromHorizontalDegrees(player.getYaw());
        for (int i = 0; i < 3; ++i) {
            Direction direction = i == 0 ? facing : i == 1 ? facing.rotateYClockwise() : facing.rotateYCounterclockwise();
            for (int height = 1; height <= AgentDryLanding.MAX_DROP; ++height) {
                BlockPos floor = source.offset(direction).down(height + 1);
                if (!untried.test(floor)) continue;
                BlockHitResult top = dryLandingTop(floor, direction);
                var landing = dryLandingFromTop(source, upper, from, top, untried);
                if (landing != null) return landing;
            }
        }
        return null;
    }

    private BlockHitResult dryLandingTop(BlockPos floor, Direction direction) {
        Vec3d point = Vec3d.ofBottomCenter(floor.up()).add(
            0.32 * direction.getOffsetX(), -0.025, 0.32 * direction.getOffsetZ());
        if (!inView(point)) {
            ++landingProbeClipped;
            return null;
        }
        if (raysLeft <= 0) return null;
        --raysLeft;
        BlockHitResult hit = raycast(point, Ray.TERRAIN);
        if (hit.getType() != HitResult.Type.BLOCK || !litFace(hit) || !inView(hit.getPos())) return null;
        if (!matchesDryRouteTop(hit, floor)) {
            ++landingProbeOccluded;
            return null;
        }
        return hit;
    }

    boolean groundsVantage(AgentGroundVantage vantage) {
        if (!hasView() || lavaEmergency || client.options.getAutoJump().getValue() || client.options.sneakKey.isUnbound()) return false;
        var player = client.player;
        BlockPos support = vantage.support();
        Vec3d feet = player.getPos(), goal = vantage.goal();
        if (!player.isOnGround() || !support.equals(player.supportingBlockPos.orElse(null))
                || player.isTouchingWater() || player.isInLava() || player.isOnFire() || player.isSprinting()
                || player.isUsingItem() || player.isClimbing() || player.hasVehicle() || player.getAbilities().flying
                || player.hurtTime != 0 || !normalDryTraction(vantage.state())
                || player.getAttributeValue(EntityAttributes.MOVEMENT_SPEED) > 0.101
                || client.world.getBlockState(support) != vantage.state() || dryCaveContact(support.up()) != vantage.state()
                || !AgentGroundVantage.keepsContact(support, vantage.from(), feet, goal, player.getVelocity(), player.getWidth() * 0.5))
            return false;
        double dx = goal.x - feet.x, dz = goal.z - feet.z;
        Box sweep = player.getBoundingBox().stretch(dx, 0, dz).expand(0.025, 0, 0.025);
        return !hazardAhead(heading(dx, dz), Math.hypot(dx, dz) + 0.13)
            && dryGradeVolume(sweep) && client.world.isSpaceEmpty(player, sweep) && macroNoVisiblePickup(goal);
    }

    void driveGroundVantage(AgentGroundVantage vantage) {
        var player = client.player;
        double dx = vantage.goal().x - player.getX(), dz = vantage.goal().z - player.getZ();
        float yaw = heading(dx, dz);
        sneak();
        turnFixed(yaw, player.getPitch());
        if (!player.isSneaking() || Math.abs(MathHelper.wrapDegrees(player.getYaw() - yaw)) > 2) return;
        double angle = Math.toRadians(player.getYaw());
        double acceleration = 0.102 * player.getAttributeValue(EntityAttributes.SNEAKING_SPEED) + 0.008;
        Vec3d velocity = player.getVelocity().add(-acceleration * Math.sin(angle), 0, acceleration * Math.cos(angle));
        if (!AgentGroundVantage.keepsContact(vantage.support(), vantage.from(), player.getPos(), vantage.goal(),
                velocity, player.getWidth() * 0.5)) return;
        macroFlatWalk(vantage.goal(), yaw, player.getPitch());
    }

    /** Retain actual stable vanilla contact throughout a short cave look, even while crouching. */
    BlockState caveLipFooting(BlockPos source) {
        var player = client.player;
        if (lavaEmergency || player == null || !source.down().equals(player.supportingBlockPos.orElse(null))
                || player.isTouchingWater() || player.isInLava() || player.isOnFire() || player.hurtTime != 0
                || player.hasVehicle() || player.isSprinting() || player.isUsingItem() || player.isClimbing()
                || player.getAbilities().flying || player.getAttributeValue(EntityAttributes.MOVEMENT_SPEED) > 0.101
                || client.options.forwardKey.isUnbound() || client.options.sneakKey.isUnbound()
                || client.options.getAutoJump().getValue()) return null;
        BlockState contact = dryCaveContact(source);
        return contact != null && normalDryTraction(contact) ? contact : null;
    }

    /** Vanilla sneak toward the front of this exact support, never onto a new support. */
    void driveCaveLip(BlockPos source, Direction bearing) {
        driveCaveLip(source, bearing, 0.29, 0.45);
    }

    /** The placement peek keeps the whole stopping hull on the independently grounded top. */
    void driveFootholdPeek(BlockPos source, Direction bearing) {
        double margin = 0.5 - client.player.getWidth() * 0.5 - 0.015;
        driveCaveLip(source, bearing, margin, margin);
    }

    private void driveCaveLip(BlockPos source, Direction bearing, double advance, double stop) {
        var player = client.player;
        double dx = bearing.getOffsetX(), dz = bearing.getOffsetZ();
        Vec3d feet = player.getPos(), velocity = player.getVelocity();
        double x = feet.x - source.getX() - 0.5, z = feet.z - source.getZ() - 0.5;
        double along = x * dx + z * dz, across = x * dz - z * dx;
        float yaw = heading(dx, dz);
        sneak();
        if (!hasView() || !player.isSneaking() || Math.abs(MathHelper.wrapDegrees(player.getYaw() - yaw)) > 2
                || Math.abs(across) > 0.14 || along >= advance
                || hazardAhead(yaw, 1.65)) return;
        // Bound the next slow input plus neutral ground coast before the center
        // could leave the already confirmed support, even with extra sneak speed.
        double speed = 0.102 * player.getAttributeValue(EntityAttributes.SNEAKING_SPEED);
        double coast = (Math.max(0, velocity.x * dx + velocity.z * dz) + speed) / (1 - 0.55);
        if (along + coast > stop || Math.abs(across + (velocity.x * dz - velocity.z * dx) / (1 - 0.55)) > Math.min(0.15, stop))
            return;
        Box sweep = player.getBoundingBox().offset(0, 0.005, 0).stretch(coast * dx, 0, coast * dz);
        if (dryGradeVolume(sweep) && client.world.isSpaceEmpty(player, sweep)) walk(false);
    }

    boolean centerOnCaveLip(BlockPos source, BlockState support) {
        var player = client.player;
        BlockPos floor = source.down();
        if (!hasView() || lavaEmergency || !player.isOnGround() || player.isTouchingWater()
                || player.isInLava() || player.isOnFire() || player.hurtTime != 0
                || !floor.equals(player.supportingBlockPos.orElse(null)) || client.world.getBlockState(floor) != support)
            return false;
        Vec3d center = Vec3d.ofBottomCenter(source);
        double dx = center.x - player.getX(), dz = center.z - player.getZ();
        double distance = Math.hypot(dx, dz);
        Box sweep = player.getBoundingBox().offset(0, 0.005, 0).stretch(dx, 0, dz);
        if (distance >= 0.82 || hazardAhead(heading(dx, dz), distance + 0.12)
                || !dryGradeVolume(sweep) || !client.world.isSpaceEmpty(player, sweep)) return false;
        centerLanding = center;
        return true;
    }

    enum CaveLandingRefusal {
        FLOOR_RENDER("no fresh rendered floor ray became available"),
        FLOOR_OUT_OF_VIEW("floor witness outside the current rendered view"),
        FLOOR_MISSING("no floor top on the nominated ray"),
        FLOOR_MASKED("another block or face masked the nominated floor top"),
        FLOOR_DARK("the floor ray supplied no lit witness"),
        FLOOR_FLUID("fluid intercepted the floor ray"),
        FLOOR_UNSAFE("the witnessed floor is not a stable dry full top with normal traction"),
        FLOOR_CHANGED("the witnessed floor changed before landing"),
        FLOOR_RECHECK("the exact lit floor witness is no longer visible"),
        CONTROLS("standing dry-walk controls or pose unavailable"),
        SOURCE("actual takeoff support does not match the proved lip"),
        UPPER_COLLISION("upper body path intersects a block or entity"),
        LOWER_COLLISION("lower receiving body path intersects a block or entity"),
        UPPER_HAZARD("fluid or hazard in the upper body path"),
        LOWER_HAZARD("fluid or hazard in the lower receiving path"),
        LAVA("visible lava in the descent lane"),
        RANGE("speed, fall distance or stopping range exceeds the proved shelf"),
        ALIGNMENT("forward bearing has not settled");

        private final String detail;
        CaveLandingRefusal(String detail) { this.detail = detail; }
        String detail() { return detail; }

        boolean mayTryAnotherPoint() {
            return this == FLOOR_OUT_OF_VIEW || this == FLOOR_MISSING || this == FLOOR_MASKED || this == FLOOR_DARK;
        }
    }

    record CaveLandingCheck(AgentDryLanding landing, CaveLandingRefusal refusal) {}

    CaveLandingCheck caveDryLanding(BlockPos source, Direction bearing, int drop, BlockState upper, Vec3d aim) {
        if (!hasView() || raysLeft <= 0) return new CaveLandingCheck(null, CaveLandingRefusal.FLOOR_RENDER);
        if (!inView(aim)) return new CaveLandingCheck(null, CaveLandingRefusal.FLOOR_OUT_OF_VIEW);
        --raysLeft;
        BlockHitResult top = raycast(aim, Ray.TERRAIN);
        if (top.getType() == HitResult.Type.MISS)
            return new CaveLandingCheck(null, lit(aim.x, aim.y + 0.05, aim.z)
                ? CaveLandingRefusal.FLOOR_MISSING : CaveLandingRefusal.FLOOR_DARK);
        if (!inView(top.getPos())) return new CaveLandingCheck(null, CaveLandingRefusal.FLOOR_OUT_OF_VIEW);
        if (!litFace(top)) return new CaveLandingCheck(null, CaveLandingRefusal.FLOOR_DARK);
        BlockPos floor = top.getBlockPos(), to = source.offset(bearing).down(drop);
        BlockState lower = client.world.getBlockState(floor);
        if (!lower.getFluidState().isEmpty()) {
            hazards.observe(top, AgentHazards.kind(lower), eye, eye.squaredDistanceTo(top.getPos()), tick);
            return new CaveLandingCheck(null, CaveLandingRefusal.FLOOR_FLUID);
        }
        if (!AgentDryLanding.shape(source, to, bearing)) return new CaveLandingCheck(null, CaveLandingRefusal.RANGE);
        if (!floor.equals(to.down()) || top.getSide() != Direction.UP || top.isInsideBlock())
            return new CaveLandingCheck(null, CaveLandingRefusal.FLOOR_MASKED);
        if (!AgentDryLanding.caveTop(source, bearing, drop, top, lower) || !stableDryRouteTop(floor, lower))
            return new CaveLandingCheck(null, CaveLandingRefusal.FLOOR_UNSAFE);
        var player = client.player;
        if (!ordinaryCaveLandingControls()) return new CaveLandingCheck(null, CaveLandingRefusal.CONTROLS);
        if (upper == null || caveLipFooting(source) != upper) return new CaveLandingCheck(null, CaveLandingRefusal.SOURCE);
        Vec3d center = Vec3d.ofBottomCenter(to), from = player.getPos();
        var landing = new AgentDryLanding(source, upper, top, to, lower, bearing, from, center,
            heading(center.x - from.x, center.z - from.z), true);
        CaveLandingRefusal veto = caveLandingPrerequisites(landing);
        if (veto != null) return new CaveLandingCheck(null, veto);
        // Use the first viable takeoff prefix, then test its real collision shapes.
        // This preview never commits its future key presses.
        for (int presses = 0; presses <= 8; ++presses) {
            if (caveLandingCoast(landing, presses, landing.yaw(), false) != AgentDryLanding.CaveMotion.LANDING) continue;
            veto = caveMotionRefusal(caveLandingCoast(landing, presses, landing.yaw(), true));
            return veto == null ? new CaveLandingCheck(landing, null) : new CaveLandingCheck(null, veto);
        }
        return new CaveLandingCheck(null, CaveLandingRefusal.RANGE);
    }

    private AgentDryLanding dryLandingFromTop(BlockPos source, BlockState upper, Vec3d from, BlockHitResult top,
                                              Predicate<BlockPos> untried) {
        if (top == null || top.isInsideBlock()) return null;
        BlockPos floor = top.getBlockPos(), to = floor.up();
        var travel = AgentDryLanding.bearing(source, to);
        if (travel == null || !matchesDryRouteTop(top, floor) || !untried.test(floor)) return null;
        if (!AgentDryLanding.shape(source, to, travel)) {
            if (source.getY() > to.getY()) dryLandingEvidence = DryLandingEvidence.FALL_BOUND;
            return null;
        }
        AgentDryLanding landing = dryLandingGeometry(source, upper, from, top, travel);
        if (landing == null) return null;
        dryLandingEvidence = DryLandingEvidence.PICKUP;
        if (!macroNoVisiblePickup(landing.center(), to.getY(), source.getY())) return null;
        dryLandingEvidence = DryLandingEvidence.OFFERED;
        return landing;
    }

    private AgentDryLanding dryLandingGeometry(BlockPos source, BlockState upper, Vec3d from, BlockHitResult top,
                                               Direction travel) {
        BlockPos floor = top.getBlockPos(), to = floor.up();
        BlockState lower = client.world.getBlockState(floor);
        if (!normalDryTraction(lower) || !stableDryRouteTop(floor, lower) || dryCaveDanger(lower)) return null;
        Vec3d center = Vec3d.ofBottomCenter(to);
        var landing = new AgentDryLanding(source, upper, top, to, lower, travel, from, center,
            heading(center.x - from.x, center.z - from.z), false);
        dryLandingEvidence = DryLandingEvidence.SWEEP;
        return dryLandingClear(landing) ? landing : null;
    }

    private boolean dryLandingControls() {
        return dryLandingControls(false);
    }

    private boolean dryLandingControls(boolean allowCrouching) {
        if (!hasView() || lavaEmergency || client.options.forwardKey.isUnbound() || client.options.getAutoJump().getValue())
            return false;
        var player = client.player;
        return (player.getPose() == EntityPose.STANDING || allowCrouching && player.getPose() == EntityPose.CROUCHING)
            && !player.isSprinting() && !player.isUsingItem()
            && !player.isTouchingWater() && !player.isClimbing() && !player.isOnFire() && !player.hasVehicle()
            && !player.getAbilities().flying && !player.hasNoDrag() && player.hurtTime == 0
            && !player.hasStatusEffect(StatusEffects.LEVITATION) && !player.hasStatusEffect(StatusEffects.SLOW_FALLING)
            && player.getAttributeValue(EntityAttributes.GRAVITY) >= 0.079
            && player.getAttributeValue(EntityAttributes.MOVEMENT_SPEED) <= 0.101;
    }

    /** Mechanical vetoes on the exact witnessed top, source contact and connecting body envelope. */
    boolean dryLandingClear(AgentDryLanding landing) {
        if (landing.ordinary()) return caveDryLandingRefusal(landing) == null;
        if (!dryLandingControls()) return false;
        var player = client.player;
        BlockPos from = landing.source(), to = landing.to(), floor = landing.top().getBlockPos();
        if (player.getAttributeValue(EntityAttributes.SAFE_FALL_DISTANCE) < landing.height() + 0.35
                || player.fallDistance > landing.height() + 0.05
                || client.world.getBlockState(from.down()) != landing.upper()
                || client.world.getBlockState(floor) != landing.lower() || !overlandLoadHolds(client.world, floor, landing.lower(), overlandProbe))
            return false;
        var feet = player.getPos();
        double y = from.getY(), x = landing.center().x, z = landing.center().z;
        if (feet.y < to.getY() - 0.055 || feet.y > y + 0.055
                || hazardAhead(landing.yaw(), Math.max(0.35, Math.hypot(x - feet.x, z - feet.z) + 0.25))) return false;
        // The upper part uses the actual offset source, not a fictitious centered stance.
        // The lower volume is entirely in the receiving column. Whether it is clear
        // can only veto the already-ray-witnessed full landing top.
        Box lower = AgentDryLanding.receivingSweep(to, y, landing.bearing(), player.getWidth(), player.getHeight());
        if (!dryGradeVolume(lower) || !client.world.isSpaceEmpty(player, lower)) return false;
        if (!player.isOnGround() || feet.y < y - 0.055) return true;
        Box upper = player.getBoundingBox().offset(0, 0.005, 0).stretch(x - feet.x, 0, z - feet.z)
            .expand(0.025, 0, 0.025);
        return from.down().equals(player.supportingBlockPos.orElse(null)) &&
            dryGradeVolume(upper) && client.world.isSpaceEmpty(player, upper);
    }

    private boolean ordinaryCaveLandingControls() {
        return dryLandingControls() && !client.player.isSneaking() && !client.player.hasNoGravity() && !client.player.isInLava();
    }

    private CaveLandingRefusal caveLandingPrerequisites(AgentDryLanding landing) {
        if (!ordinaryCaveLandingControls()) return CaveLandingRefusal.CONTROLS;
        var player = client.player;
        var feet = player.getPos();
        BlockPos source = landing.source().down(), floor = landing.top().getBlockPos();
        if (client.world.getBlockState(source) != landing.upper()) return CaveLandingRefusal.SOURCE;
        if (client.world.getBlockState(floor) != landing.lower()) return CaveLandingRefusal.FLOOR_CHANGED;
        if (player.isOnGround()) {
            BlockPos contact = player.supportingBlockPos.orElse(null);
            if (feet.y >= landing.source().getY() - 0.055) {
                // Vanilla can retain grounded contact for the tick whose horizontal move clears the lip.
                if (!source.equals(contact) && (contact != null || landing.overlapsLip(feet, player.getWidth() * 0.5)))
                    return CaveLandingRefusal.SOURCE;
            } else if (!floor.equals(contact)) return CaveLandingRefusal.FLOOR_CHANGED;
        }
        if (player.getAttributeValue(EntityAttributes.SAFE_FALL_DISTANCE) < landing.height() + 0.35
                || player.fallDistance > landing.height() + 0.05)
            return CaveLandingRefusal.RANGE;
        double distance = Math.hypot(landing.center().x - feet.x, landing.center().z - feet.z);
        return hazardAhead(landing.yaw(), Math.max(0.35, distance + 0.25)) ? CaveLandingRefusal.LAVA : null;
    }

    private boolean caveLandingSpaceEmpty(Box box) {
        return client.world.isSpaceEmpty(client.player, box);
    }

    private boolean caveLandingVolumeDry(Box box) {
        // An unloaded neighbor cannot establish clearance for part of the swept hull.
        int x0 = MathHelper.floor(box.minX) >> 4, x1 = MathHelper.floor(box.maxX - 1e-5) >> 4;
        int z0 = MathHelper.floor(box.minZ) >> 4, z1 = MathHelper.floor(box.maxZ - 1e-5) >> 4;
        var world = client.world;
        for (int x = x0; x <= x1; ++x)
            for (int z = z0; z <= z1; ++z)
                if (!world.isChunkLoaded(x, z)) return false;
        return dryGradeVolume(box);
    }

    private AgentDryLanding.CaveMotion caveLandingCoast(AgentDryLanding landing, int presses, float yaw, boolean geometry) {
        var player = client.player;
        float angle = yaw * MathHelper.RADIANS_PER_DEGREE;
        double step = presses == 0 ? 0 : player.getMovementSpeed() * 0.98f;
        return landing.caveCoast(player.getPos(), player.getVelocity(), player.getWidth() * 0.5, player.getHeight(),
            player.getFinalGravity(), player.isOnGround(), presses, -MathHelper.sin(angle) * step, MathHelper.cos(angle) * step,
            geometry ? caveLandingSpace : null, geometry ? caveLandingDry : null);
    }

    private static CaveLandingRefusal caveMotionRefusal(AgentDryLanding.CaveMotion motion) {
        return switch (motion) {
            case SOURCE, LANDING -> null;
            case RANGE -> CaveLandingRefusal.RANGE;
            case UPPER_COLLISION -> CaveLandingRefusal.UPPER_COLLISION;
            case LOWER_COLLISION -> CaveLandingRefusal.LOWER_COLLISION;
            case UPPER_HAZARD -> CaveLandingRefusal.UPPER_HAZARD;
            case LOWER_HAZARD -> CaveLandingRefusal.LOWER_HAZARD;
        };
    }

    CaveLandingRefusal caveDryLandingRefusal(AgentDryLanding landing) {
        CaveLandingRefusal prerequisites = caveLandingPrerequisites(landing);
        return prerequisites != null ? prerequisites : caveMotionRefusal(caveLandingCoast(landing, 0, landing.yaw(), true));
    }

    boolean dryLandingSeen(AgentDryLanding landing) {
        return horizonWitness(landing.top(), true, landing.ordinary() ? Ray.TERRAIN : Ray.SIGHT) != null;
    }

    /** Leave the proved lip on foot, then coast: never manufacture a mid-air step or reversal. */
    boolean driveDryLanding(AgentDryLanding landing) {
        return driveDryLanding(landing, false);
    }

    boolean driveDryLanding(AgentDryLanding landing, boolean keepView) {
        if (landing.ordinary()) return driveCaveDryLanding(landing) == null;
        var player = client.player;
        if (!player.isOnGround() || player.getY() < landing.source().getY() - 0.055) return false;
        double dx = landing.center().x - player.getX(), dz = landing.center().z - player.getZ();
        if (!keepView) {
            float pitch = (float) Math.toDegrees(Math.atan2(player.getEyeY() - landing.top().getPos().y,
                Math.hypot(landing.top().getPos().x - player.getX(), landing.top().getPos().z - player.getZ())));
            turnFixed(landing.yaw(), Math.min(77, pitch));
        }
        float yaw = player.getYaw();
        if (!dryLandingSeen(landing) || Math.abs(MathHelper.wrapDegrees(yaw - landing.yaw())) > (keepView ? 0.7 : 2.0))
            return false;
        var feet = player.getPos();
        var velocity = player.getVelocity();
        double angle = Math.toRadians(yaw), speed = 0.102, radius = player.getWidth() * 0.5;
        if (Math.hypot(dx, dz) < 0.12 || !AgentDryLanding.stoppingFits(landing.source(), landing.bearing(), feet, velocity,
                -Math.sin(angle) * speed, Math.cos(angle) * speed, radius)) return false;
        dryRouteWalk = true;
        walkDownTo(landing.center());
        return true;
    }

    /** A checked neutral coast owns the fall; only advance while it still ends on the source. */
    CaveLandingRefusal driveCaveDryLanding(AgentDryLanding landing) {
        CaveLandingRefusal veto = caveLandingPrerequisites(landing);
        if (veto != null) return veto;
        var player = client.player;
        var coast = caveLandingCoast(landing, 0, landing.yaw(), true);
        if (coast != AgentDryLanding.CaveMotion.SOURCE) return caveMotionRefusal(coast);
        if (!player.isOnGround()) return CaveLandingRefusal.SOURCE;
        float pitch = (float) Math.toDegrees(Math.atan2(player.getEyeY() - landing.top().getPos().y,
            Math.hypot(landing.top().getPos().x - player.getX(), landing.top().getPos().z - player.getZ())));
        turnFixed(landing.yaw(), Math.min(77, pitch));
        if (Math.abs(MathHelper.wrapDegrees(player.getYaw() - landing.yaw())) > 0.7)
            return CaveLandingRefusal.ALIGNMENT;
        if (!dryLandingSeen(landing)) return CaveLandingRefusal.FLOOR_RECHECK;
        veto = caveMotionRefusal(caveLandingCoast(landing, 1, player.getYaw(), true));
        if (veto != null) return veto;
        dryRouteWalk = true;
        walkDownTo(landing.center());
        return null;
    }

    private AgentVisibleHorizon.Patch horizonSurface(BlockPos floor, double contactY) {
        BlockState state = client.world.getBlockState(floor);
        if (AgentProgress.dangerous(state) || state.isOf(Blocks.COBWEB)) return Refusal.HAZARD.unavailable;
        double top = horizonSupportTop(client.world, floor, state);
        if (!Double.isFinite(top) || !overlandLoadHolds(client.world, floor, state, overlandProbe))
            return Refusal.UNSUITABLE_TOP.unavailable;
        if (Math.abs(top - contactY) > 0.055)
            return state.isIn(BlockTags.LEAVES) ? Refusal.LEAF_HEIGHT.unavailable : Refusal.SURFACE_HEIGHT.unavailable;
        BlockPos open = overlandProbe.set(floor.getX(), MathHelper.floor(top + 0.012), floor.getZ());
        BlockState cover = client.world.getBlockState(open);
        FluidState fluid = cover.getFluidState();
        if (fluid.isEmpty()) return AgentProgress.dangerous(cover) || cover.isOf(Blocks.COBWEB)
            ? Refusal.HAZARD.unavailable : AgentVisibleHorizon.Patch.dry(top, state.getBlock().getSlipperiness(), floor, state);
        if (!cover.isOf(Blocks.WATER) || !fluid.isIn(FluidTags.WATER))
            return fluid.isIn(FluidTags.LAVA) ? Refusal.HAZARD.unavailable : Refusal.FLUID_IN_SWEEP.unavailable;
        double depth = open.getY() + fluid.getHeight(client.world, open) - top;
        // Flow's mechanical force can veto an already seen water sample, not establish terrain.
        Vec3d flow = fluid.getVelocity(client.world, open);
        Refusal veto = AgentVisibleHorizon.Patch.waterRefusal(depth, flow);
        return veto == null ? AgentVisibleHorizon.Patch.water(top, floor, state) : veto.unavailable;
    }

    /** Negative-only live recheck of an already optically witnessed top. */
    boolean pickupSupportUnchanged(AgentVisibleHorizon.Patch prior, double level) {
        return prior.sameSupport(horizonSurface(prior.floor(), level));
    }

    /** Vanilla's thin ground-contact probe, restricted to the already occupied footprint. */
    AgentVisibleHorizon.Patch pickupFootContact(HorizonView view, int x, int z) {
        Box contact = AgentPickup.footContact(view.player.getBoundingBox(), x, z);
        if (contact == null) return null;
        BlockPos floor = view.world.findSupportingBlockPos(view.player, contact).orElse(null);
        if (floor == null || floor.getX() != x || floor.getZ() != z) return null;
        return horizonSurface(floor, view.feet.y);
    }

    static double horizonSupportTop(BlockView world, BlockPos floor, BlockState state) {
        if (AgentProgress.dangerous(state) || !state.getFluidState().isEmpty() || state.isOf(Blocks.COBWEB))
            return Double.NaN;
        VoxelShape shape = state.getCollisionShape(world, floor);
        if (shape.isEmpty()) return Double.NaN;
        if (Block.isShapeFullCube(shape)) return floor.getY() + 1;
        var boxes = shape.getBoundingBoxes();
        if (boxes.size() != 1) return Double.NaN;
        Box top = boxes.getFirst();
        return top.minX == 0 && top.minZ == 0 && top.maxX == 1 && top.maxZ == 1
            && top.maxY > 0 && top.maxY <= 1 ? floor.getY() + top.maxY : Double.NaN;
    }

    /** Veto only: body collision and hazards in the nominated sweep never supply optical support. */
    Refusal horizonSweep(double dx, double dz, double drift, double coastDistance, double distance,
                         AgentVisibleHorizon.Medium medium) {
        var player = client.player;
        if (hazards.lavaNear(player.getBoundingBox(), 0.20, tick)
                || hazardAhead(heading(dx, dz), distance + 0.25)) return Refusal.HAZARD;
        Box box = player.getBoundingBox().contract(1e-5, 0, 1e-5);
        double sideX = -dz * drift, sideZ = dx * drift;
        int slices = Math.max(1, (int) Math.ceil(distance / 0.16));
        double step = distance / slices;
        for (int i = 0; i < slices; ++i) {
            double from = step * i, fraction = Math.min(1, (from + step) / coastDistance);
            Box sweep = box.offset(dx * from, 0, dz * from).stretch(dx * step, 0, dz * step)
                .stretch(sideX * fraction, 0, sideZ * fraction);
            if (!client.world.isSpaceEmpty(player, sweep)) return Refusal.OBSTRUCTION;
            int feetY = MathHelper.floor(sweep.minY + 1e-5);
            for (int x = MathHelper.floor(sweep.minX); x <= MathHelper.floor(sweep.maxX - 1e-5); ++x) {
                for (int z = MathHelper.floor(sweep.minZ); z <= MathHelper.floor(sweep.maxZ - 1e-5); ++z) {
                    for (int y = feetY; y <= MathHelper.floor(sweep.maxY - 1e-5); ++y) {
                        BlockState state = client.world.getBlockState(overlandProbe.set(x, y, z));
                        if (AgentProgress.dangerous(state) || state.isOf(Blocks.COBWEB)) return Refusal.HAZARD;
                        if (!state.getFluidState().isEmpty() && (medium != AgentVisibleHorizon.Medium.SHALLOW_WATER
                                || y > feetY || !state.isOf(Blocks.WATER))) return Refusal.FLUID_IN_SWEEP;
                    }
                }
            }
        }
        return null;
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

    /** Admit the client sky's visible luminance only through open rays in this first-person render. */
    AgentNightWorksite.Sky renderedSurfaceSky() {
        if (!hasView() || client.player.isTouchingWater()
                || client.world.getDimensionEffects().getSkyType()
                    != net.minecraft.client.render.DimensionEffects.SkyType.NORMAL)
            return AgentNightWorksite.Sky.UNKNOWN;
        float pitch = MathHelper.clamp(observedPitch - 24, -65, -24);
        int clear = 0;
        for (int offset = -14; offset <= 14 && raysLeft > 0; offset += 14) {
            Vec3d end = eye.add(client.player.getRotationVector(pitch, observedYaw + offset).multiply(MAX_RANGE));
            if (!inView(end)) continue;
            raysLeft--;
            // An unlit roof still occludes the sky; unlike a lit first hit, a raw miss is required.
            if (raycast(end, Ray.FLUIDS).getType() == HitResult.Type.MISS && ++clear == 2) {
                float brightness = client.world.getSkyBrightness(client.getRenderTickCounter().getTickDelta(true));
                if (brightness <= 0.30f) return AgentNightWorksite.Sky.DARK;
                if (brightness >= 0.43f) return AgentNightWorksite.Sky.BRIGHT;
                break;
            }
        }
        return AgentNightWorksite.Sky.UNKNOWN;
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

    boolean temporaryStepFluidNear(Box sweep) {
        return lavaEmergency || hazards.fluidNear(sweep.expand(0, 0.35, 0), 0.36, tick);
    }

    /** Veto only the physical volume of an already rendered temporary jump, never discover a target. */
    boolean temporaryStepSweepClear(Box sweep) {
        return !temporaryStepFluidNear(sweep) && dryGradeVolume(sweep) && client.world.isSpaceEmpty(client.player, sweep);
    }

    boolean keysNeutral() {
        var keys = client.options;
        return !keys.forwardKey.isPressed() && !keys.backKey.isPressed() && !keys.leftKey.isPressed()
            && !keys.rightKey.isPressed() && !keys.jumpKey.isPressed() && !keys.sprintKey.isPressed()
            && !keys.sneakKey.isPressed() && !keys.attackKey.isPressed() && !keys.useKey.isPressed();
    }

    Vec3d continuityLanding() {
        if (emergencyWalk || !client.options.forwardKey.isPressed()) return null;
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

    static boolean matchesDryRouteTop(BlockHitResult hit, BlockPos floor) {
        return hit != null && hit.getType() == HitResult.Type.BLOCK
            && floor.equals(hit.getBlockPos()) && hit.getSide() == Direction.UP
            && Math.abs(hit.getPos().y - floor.getY() - 1) <= 0.035;
    }

    private boolean stableDryRouteTop(BlockPos floor, BlockState shown) {
        return !(shown.getBlock() instanceof FallingBlock) && fullStepSupport(floor, shown);
    }

    boolean dryRouteView() { return hasView(); }

    boolean dryRoutePointInView(Vec3d point) { return hasView() && inView(point); }

    /** Allow one new row (at most eight rays) without spending the near-edge reserve. */
    boolean dryRouteHorizonRoom() { return raysLeft >= 16; }

    boolean dryRouteRaysSpent() { return raysLeft <= 0; }

    AgentDryCaveRoute.ProbeView dryCaveProbeView() { return caveProbeView; }

    private DryRouteTop dryCaveTop(Vec3d point, BlockPos floor) {
        DryRouteTop top = dryRouteTop(point, floor);
        return top == DryRouteTop.WITNESSED && dryCaveDanger(client.world.getBlockState(floor))
            ? DryRouteTop.UNSUITABLE_TOP : top;
    }

    DryRouteSample dryCaveSpace(Vec3d point) {
        DryRouteSample sample = dryRouteClear(point);
        // Only a lit, unoccluded ray supplies an endpoint to classify.
        return sample == DryRouteSample.CLEAR && dryCaveDanger(client.world.getBlockState(BlockPos.ofFloored(point)))
            ? DryRouteSample.OBSTRUCTION : sample;
    }

    BlockState dryCaveContact(BlockPos foot) {
        var player = client.player;
        if (player == null || !player.isOnGround() || !player.getBlockPos().equals(foot)
                || Math.abs(player.getY() - foot.getY()) > 0.055) return null;
        BlockPos floor = foot.down();
        BlockState state = client.world.getBlockState(floor);
        return !dryCaveDanger(state) && stableDryRouteTop(floor, state) ? state : null;
    }

    static boolean dryCaveDanger(BlockState state) {
        return !state.getFluidState().isEmpty() || AgentProgress.dangerous(state) || state.isOf(Blocks.COBWEB);
    }

    boolean ordinaryRouteControls() {
        return dryLandingControls(true) && client.isWindowFocused() && client.getOverlay() == null
            && ordinaryGradePose(client.player) && !client.player.isGliding()
            && !client.player.hasNoGravity() && !client.player.isSpectator()
            && client.player.getAttributeValue(EntityAttributes.SAFE_FALL_DISTANCE) >= 1.35;
    }

    boolean ordinaryRouteContact(BlockPos foot) {
        return ordinaryRouteControls() && ordinaryRoutePhysicalContact(foot) && ordinaryRouteSupport(foot);
    }

    /** Contact can identify a restored stance before the first render, but cannot authorize motion. */
    boolean ordinaryRoutePhysicalContact(BlockPos foot) {
        var player = client.player;
        if (player == null || !player.isOnGround() || !player.getBlockPos().equals(foot)
                || Math.abs(player.getY() - foot.getY()) > 0.055) return false;
        BlockPos support = player.supportingBlockPos.orElse(null);
        return support != null && support.getX() == foot.getX() && support.getY() == foot.getY() - 1
            && support.getZ() == foot.getZ();
    }

    private boolean ordinaryRouteSupport(BlockPos foot) {
        return ordinaryRouteSupport(foot.getX(), foot.getY() - 1, foot.getZ());
    }

    private boolean ordinaryRouteSupport(int x, int y, int z) {
        BlockPos floor = ordinaryFloorProbe.set(x, y, z);
        BlockState state = client.world.getBlockState(floor);
        return !dryCaveDanger(state) && normalDryTraction(state) && fullStepSupport(floor, state)
            && overlandLoadHolds(client.world, floor, state, ordinaryFloorProbe);
    }

    /** Admit only the exact full top returned by a projected first-hit ray, not a nominated column. */
    boolean ordinaryRouteTop(BlockPos foot, int leaveRays) {
        if (!hasView() || raysLeft <= leaveRays) return false;
        double dx = foot.getX() + 0.5 - eye.x, dz = foot.getZ() + 0.5 - eye.z;
        double distance = Math.max(Math.abs(dx), Math.abs(dz));
        if (distance > 6.4) return false;
        // The farther half stays in frame next to the player and can clear a descending lip.
        double offset = distance > 0.20 ? 0.38 / distance : 0;
        if (ordinaryTopRay(foot, dx * offset, dz * offset)) return true;
        return raysLeft > leaveRays && ordinaryTopRay(foot, 0, 0);
    }

    /** In darkness only an exact vanilla-drawn top can substitute for a lit first hit. */
    private BlockHitResult ordinaryRouteOutlineTop(BlockPos floor) {
        if (renderedSupplyOutline == null || !(renderedCrosshair instanceof BlockHitResult shown)
                || !matchesDryRouteTop(shown, floor) || shown.isInsideBlock()) return null;
        BlockHitResult now = supplyOutlineFace();
        return matchesDryRouteTop(now, floor) && !now.isInsideBlock() ? now : null;
    }

    long ordinaryRouteOutlinedFoot(BlockPos from) {
        if (renderedSupplyOutline == null || !(renderedCrosshair instanceof BlockHitResult hit)
                || hit.getSide() != Direction.UP) return AgentRouteGraph.NO_CELL;
        BlockPos floor = hit.getBlockPos();
        long foot = AgentRouteGraph.cell(floor.getX(), floor.getY() + 1, floor.getZ());
        return AgentRouteGraph.cardinalStep(from.asLong(), foot) && ordinaryRouteOutlineTop(floor) != null
                && ordinaryRouteSupport(floor.getX(), floor.getY(), floor.getZ())
            ? foot : AgentRouteGraph.NO_CELL;
    }

    boolean ordinaryRouteFreshGrade(BlockPos from, BlockPos to, int leaveRays) {
        return ordinaryRouteContact(from) && (ordinaryRouteTop(to, leaveRays)
            || raysLeft >= leaveRays + 8
                && ordinaryRouteOutlineTop(ordinaryFloorProbe.set(to.getX(), to.getY() - 1, to.getZ())) != null
                && ordinaryRouteSupport(to));
    }

    /** A goalward riser face is a look cue only; the exact top and body lane must be proved separately. */
    boolean ordinaryRouteRiseCue(BlockPos from, Direction bearing, int leaveRays) {
        if (!hasView() || raysLeft <= leaveRays) return false;
        var side = selectedFace();
        if (AgentSurfaceTread.ordinaryRiseSide(from, bearing, side) && inView(side.getPos())
                && (litFace(side) || raysLeft >= leaveRays + 8 && supplyOutlineFace() == side))
            return ordinaryRouteSupport(side.getBlockPos().getX(), side.getBlockPos().getY(), side.getBlockPos().getZ());
        Vec3d point = Vec3d.ofCenter(from.offset(bearing), 0.55);
        if (!inView(point)) return false;
        side = litHit(point, Ray.TERRAIN);
        return AgentSurfaceTread.ordinaryRiseSide(from, bearing, side)
            && ordinaryRouteSupport(side.getBlockPos().getX(), side.getBlockPos().getY(), side.getBlockPos().getZ());
    }

    private boolean ordinaryTopRay(BlockPos foot, double offsetX, double offsetZ) {
        double x = foot.getX() + 0.5 + offsetX, y = foot.getY() - 0.025, z = foot.getZ() + 0.5 + offsetZ;
        if (!inView(x, y, z)) return false;
        BlockHitResult hit = litHit(new Vec3d(x, y, z), Ray.TERRAIN);
        if (hit == null || hit.isInsideBlock() || hit.getSide() != Direction.UP) return false;
        BlockPos floor = hit.getBlockPos();
        return floor.getX() == foot.getX() && floor.getY() == foot.getY() - 1 && floor.getZ() == foot.getZ()
            && Math.abs(hit.getPos().y - foot.getY()) <= 0.035 && ordinaryRouteSupport(foot);
    }

    /**
     * A veto on a lane whose two supports have already been seen or occupied, including a
     * remembered return. The sweep cannot supply a new floor or name an occluded obstacle.
     */
    DryRouteVeto ordinaryRouteLane(BlockPos from, BlockPos to) {
        int dx = to.getX() - from.getX(), dz = to.getZ() - from.getZ(), rise = to.getY() - from.getY();
        if (Math.abs(dx) + Math.abs(dz) != 1 || Math.abs(rise) > 1) return DryRouteVeto.DRIFT;
        if (!ordinaryRouteSupport(from) || !ordinaryRouteSupport(to)) return DryRouteVeto.SUPPORT;
        var player = client.player;
        double half = player.getWidth() * 0.5 + 0.045;
        double x = from.getX() + 0.5, z = from.getZ() + 0.5, y = Math.max(from.getY(), to.getY());
        Box high = new Box(x - half, y + 0.005, z - half, x + half,
            y + Math.max(1.8, player.getHeight()) + (rise > 0 ? 0.27 : 0.005), z + half);
        Box upper = high.stretch(dx, 0, dz);
        DryRouteVeto veto = ordinaryRouteVolume(upper);
        if (veto != DryRouteVeto.CLEAR || rise == 0) return veto;
        return ordinaryRouteVolume((rise < 0 ? high.offset(dx, 0, dz) : high).stretch(0, -1, 0));
    }

    private DryRouteVeto ordinaryRouteVolume(Box sweep) {
        if (!caveLandingVolumeDry(sweep)) return DryRouteVeto.HAZARD;
        return client.world.isSpaceEmpty(client.player, sweep) ? DryRouteVeto.CLEAR : DryRouteVeto.SWEEP;
    }

    enum OrdinaryMotor { KEY, COAST, ALIGN, CENTER, VIEW, VETO }

    /** Use ordinary keys and the existing final lava/headroom/input arbitration, never another look. */
    OrdinaryMotor driveOrdinaryRoute(BlockPos from, BlockPos to, Direction bearing, boolean carry, boolean crossing) {
        if (!ordinaryRouteControls()) return OrdinaryMotor.VIEW;
        var player = client.player;
        int dx = bearing.getOffsetX(), dz = bearing.getOffsetZ(), rise = to.getY() - from.getY();
        double fx = player.getX() - from.getX() - 0.5, fz = player.getZ() - from.getZ() - 0.5;
        Vec3d velocity = player.getVelocity();
        double along = fx * dx + fz * dz, across = fx * dz - fz * dx;
        double coast = player.isOnGround() ? 2.20 : 4.0;
        double sideDrift = (velocity.x * dz - velocity.z * dx) * coast;
        if (along < -0.51 || along > 1.27 || player.fallDistance > (rise > 0 ? 0.35 : -rise + 0.08)
                || player.getY() < Math.min(from.getY(), to.getY()) - 0.055
                || player.getY() > Math.max(from.getY(), to.getY()) + (rise > 0 ? 0.28 : 0.055)
                || rise == 0 && !player.isOnGround()
                || hazardAhead(bearing.getPositiveHorizontalDegrees(), Math.max(0.68, 1.42 - along)))
            return OrdinaryMotor.VETO;
        float yaw = bearing.getPositiveHorizontalDegrees();
        if (Math.abs(MathHelper.wrapDegrees(yaw - player.getYaw())) > 5) return OrdinaryMotor.ALIGN;
        double margin = rise == 0 ? 0.205 : 0.18;
        if (Math.abs(across) > margin || Math.abs(across + sideDrift) > margin
                || rise != 0 && !crossing && Math.abs(along) > 0.25) {
            if (!ordinaryRouteContact(from)) return OrdinaryMotor.VETO;
            return ordinaryRouteAdjust(from, from.getX() + 0.5, from.getZ() + 0.5)
                ? OrdinaryMotor.CENTER : OrdinaryMotor.VETO;
        }
        boolean takeoff = rise > 0 && player.isOnGround() && player.getY() < to.getY() - 0.055;
        if (takeoff) {
            double jump = player.getAttributeValue(EntityAttributes.JUMP_STRENGTH);
            if (client.options.jumpKey.isUnbound() || jump < 0.419 || jump > 0.421) return OrdinaryMotor.VETO;
            Box launch = player.getBoundingBox().offset(0, 0.005, 0).stretch(0, 0.43, 0);
            if (ordinaryRouteVolume(launch) != DryRouteVeto.CLEAR) return OrdinaryMotor.VETO;
        }
        if (player.getPose() != EntityPose.STANDING) return OrdinaryMotor.COAST;
        if (rise != 0 && dryRouteVeto(from, to, true, 0.51, true) != DryRouteVeto.CLEAR) return OrdinaryMotor.VETO;
        // Check the actual body's next displacement, not just the centered planning envelope.
        // Before a rise the riser itself is expected at knee height; the exact apron and
        // full climb envelope were independently checked by ordinaryRouteLane.
        double speed = Math.max(0, velocity.x * dx + velocity.z * dz);
        double advance = Math.min(Math.max(0, 1 - along), speed + 0.12);
        Box imminent = player.getBoundingBox().offset(0, 0.005, 0).stretch(velocity.x, 0, velocity.z);
        if (!takeoff && (rise <= 0 || player.getY() >= to.getY() - 0.055))
            imminent = imminent.stretch(dx * advance, 0, dz * advance);
        if (!caveLandingVolumeDry(imminent)) return OrdinaryMotor.VETO;
        if (rise == 0 && !client.world.isSpaceEmpty(player, imminent)) return OrdinaryMotor.VETO;
        driveDryRoute(from, to, bearing, carry, true, takeoff, 5);
        ordinaryRiseKey = forward && takeoff;
        return forward || backward ? OrdinaryMotor.KEY : OrdinaryMotor.COAST;
    }

    /** Move inward on the exact occupied top only, with ordinary slow directional input. */
    boolean ordinaryRouteAdjust(BlockPos foot, double x, double z) {
        if (!ordinaryRouteContact(foot) || client.options.sneakKey.isUnbound()
                || client.options.backKey.isUnbound() || client.options.leftKey.isUnbound()
                || client.options.rightKey.isUnbound()) return false;
        var player = client.player;
        double dx = x - player.getX(), dz = z - player.getZ();
        double distance = Math.hypot(dx, dz);
        if (distance > 0.81 || hazardAhead(heading(dx, dz), distance + 0.12)
                || ordinaryRouteVolume(player.getBoundingBox().offset(0, 0.005, 0).stretch(dx, 0, dz))
                    != DryRouteVeto.CLEAR) return false;
        centerLanding = new Vec3d(x, player.getY(), z);
        return true;
    }

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

    boolean ordinaryGradeSweep(BlockPos from, BlockPos to) {
        return dryRouteVeto(from, to, true, 0.27, true) == DryRouteVeto.CLEAR;
    }

    /** For an outlined grade already chosen by the exit owner; SWEEP means physical obstruction. */
    DryRouteVeto supplyOutlineGradeVeto(BlockPos from, BlockPos to) {
        if (!ordinaryOutlineExitEnabled || !hasView()) return DryRouteVeto.VIEW;
        if (Math.abs(from.getY() - to.getY()) != 1 || !ordinaryGradePose(client.player)) return DryRouteVeto.DRIFT;
        return dryRouteVeto(from, to, true, 0.27, true);
    }

    void trackWalkedRoutes(AgentWalkedRoute routes) { walkedRoutes = routes; }

    /** Called by an ordinary actuator on actual grounded arrival, never from idle position samples. */
    void recordWalkedLeg(BlockPos from, BlockPos to) {
        if (walkedRoutes == null || !hasView() || lavaEmergency || macroLavaNear()) return;
        var player = client.player;
        if (!player.isOnGround() || player.isTouchingWater() || player.isOnFire() || player.hasVehicle()
                || player.hurtTime != 0 || player.getAbilities().flying || player.isSpectator() || !player.getBlockPos().equals(to)
                || Math.abs(player.getY() - to.getY()) > 0.055) return;
        int dx = to.getX() - from.getX(), dz = to.getZ() - from.getZ();
        Direction travel = dx == 0 ? dz > 0 ? Direction.SOUTH : Direction.NORTH : dx > 0 ? Direction.EAST : Direction.WEST;
        if (walkedLaneDry(from, to, travel) && AgentSurfaceTread.retainedLaneClear(client, from, to, travel)) {
            if (walkedRoutes.recoveringWalk())
                walkedRoutes.landed(from, client.world.getBlockState(from.down()), to, client.world.getBlockState(to.down()), travel);
            else walkedRoutes.landed(from.asLong(), to.asLong());
        }
    }

    /** A veto on two already-attested columns, not a source of new navigation targets. */
    boolean walkedLaneDry(BlockPos from, BlockPos to, Direction travel) {
        return AgentSurfaceTread.cardinalTread(from, to, travel) && walkedColumnDry(from, from.getY() != to.getY())
            && walkedColumnDry(to, from.getY() != to.getY());
    }

    private boolean walkedColumnDry(BlockPos foot, boolean stair) {
        var probe = walkedProbe.set(foot.getX(), foot.getY() - 1, foot.getZ());
        BlockState support = client.world.getBlockState(probe);
        if (!stableDryRouteTop(probe, support) || dryCaveDanger(support)) return false;
        for (int y = 0; y <= (stair ? 2 : 1); y++) {
            if (dryCaveDanger(client.world.getBlockState(probe.move(Direction.UP)))) return false;
        }
        return true;
    }

    enum FootholdSpace { EMPTY, VIEW, DARK, OCCLUDED, OCCUPIED, FLUID }

    static Vec3d footholdInterior(BlockPos cell, Direction bearing, boolean high) {
        // Keep both rays beyond the retained lip on a one-block descent, including while sneaking.
        double along = 0.28;
        return Vec3d.ofCenter(cell).add(bearing.getOffsetX() * along, high ? 0.31 : -0.20, bearing.getOffsetZ() * along);
    }

    static Vec3d footholdAttachmentAim(BlockPos anchor, Direction offset, Direction bearing) {
        return offset == Direction.DOWN
            ? Vec3d.ofCenter(anchor, 0.96).add(bearing.getOffsetX() * 0.30, 0, bearing.getOffsetZ() * 0.30)
            : Vec3d.ofCenter(anchor, 0.77).add(-offset.getOffsetX() * 0.46, 0, -offset.getOffsetZ() * 0.46);
    }

    // Reserve both air samples, the four attachment rays, and the normal contact rechecks.
    boolean footholdRaysAvailable() { return raysLeft >= 14; }

    private static Direction footholdOffset(int index, Direction bearing) {
        return switch (index) {
            case 0 -> bearing;
            case 1 -> bearing.rotateYClockwise();
            case 2 -> bearing.rotateYCounterclockwise();
            default -> Direction.DOWN;
        };
    }

    static boolean footholdFaceInEnvelope(BlockHitResult hit, BlockPos cell, Direction bearing) {
        return hit != null && hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock()
            && hit.getSide() != Direction.DOWN && hit.getSide() != bearing
            && hit.getBlockPos().offset(hit.getSide()).equals(cell);
    }

    /** Read all four eligible contacts from this render; candidate ray points never become camera goals. */
    BlockHitResult visibleFootholdAttachment(BlockPos cell, Direction bearing, Vec3d low, Vec3d high, double reach) {
        if (!hasView() || client.player.getBoundingBox().intersects(new Box(cell))) return null;
        var selected = selectedFace();
        var player = client.player;
        var look = player.getRotationVector(observedPitch, observedYaw);
        BlockHitResult best = null;
        double bestAlignment = -1;
        if (footholdFaceInEnvelope(selected, cell, bearing)
                && selected.getPos().squaredDistanceTo(eye) <= reach * reach
                && footholdAttachment(selected, cell) && framesFoothold(selected.getPos(), low, high)) {
            best = selected;
            bestAlignment = look.dotProduct(selected.getPos().subtract(eye).normalize());
        }
        for (int i = 0; i < 4; i++) {
            Direction offset = footholdOffset(i, bearing);
            BlockPos anchor = cell.offset(offset);
            Vec3d point = footholdAttachmentAim(anchor, offset, bearing);
            if (!inView(point)) continue;
            BlockHitResult hit = visibleHit(point, Ray.FLUIDS);
            if (hit == null || !hit.getBlockPos().equals(anchor) || hit.getSide() != offset.getOpposite()
                    || hit.isInsideBlock() || hit.getPos().squaredDistanceTo(eye) > reach * reach
                    || !stableFootholdAnchor(anchor) || !framesFoothold(hit.getPos(), low, high)) continue;
            double alignment = look.dotProduct(hit.getPos().subtract(eye).normalize());
            if (alignment > bestAlignment) {
                best = hit;
                bestAlignment = alignment;
            }
        }
        return best;
    }

    private boolean framesFoothold(Vec3d contact, Vec3d low, Vec3d high) {
        // Projection only. The two fresh rays must still prove dry air after making this turn.
        Vec3d eye = client.player.getEyePos();
        double x = contact.x - eye.x, y = contact.y - eye.y, z = contact.z - eye.z;
        float yaw = heading(x, z);
        float pitch = (float) -Math.toDegrees(Math.atan2(y, Math.hypot(x, z)));
        Vec3d feet = client.player.getPos();
        return macroRetainsView(low, feet, yaw, pitch) && macroRetainsView(high, feet, yaw, pitch);
    }

    /** Verify this exact adjacent build cell through a lit, unobstructed first-person ray. */
    FootholdSpace footholdSpace(Vec3d point) {
        if (!hasView() || raysLeft <= 0 || !inView(point)) return FootholdSpace.VIEW;
        raysLeft--;
        BlockHitResult hit = raycast(point, Ray.FLUIDS);
        if (hit.getType() != HitResult.Type.MISS) {
            if (!inView(hit.getPos())) return FootholdSpace.VIEW;
            if (!litFace(hit)) return FootholdSpace.DARK;
        } else if (!lit(point.x, point.y, point.z)) return FootholdSpace.DARK;
        return classifyFootholdSpace(client.world, BlockPos.ofFloored(point), hit);
    }

    /** Interpret a ray after it passed the rendered-view and light checks. */
    static FootholdSpace classifyFootholdSpace(BlockView world, BlockPos cell, BlockHitResult hit) {
        if (hit.getType() != HitResult.Type.MISS) {
            if (!hit.getBlockPos().equals(cell)) return FootholdSpace.OCCLUDED;
            return world.getBlockState(cell).getFluidState().isEmpty()
                ? FootholdSpace.OCCUPIED : FootholdSpace.FLUID;
        }
        BlockState material = world.getBlockState(cell);
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
        return stableFootholdAnchor(anchor.getBlockPos());
    }

    private boolean stableFootholdAnchor(BlockPos anchor) {
        var material = client.world.getBlockState(anchor);
        return stableDryRouteTop(anchor, material) && !material.hasBlockEntity()
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
        return dryRouteVeto(from, to, requireLandingSupport, 0.27);
    }

    /** Negative-only preflight on the already witnessed level row after the current landing. */
    boolean dryRouteContinuationClear(BlockPos from, BlockPos to, Direction bearing,
                                      BlockState source, BlockState landing) {
        var player = client.player;
        return from.getY() == to.getY() && player.isOnGround() && player.getPose() == EntityPose.STANDING
            && !player.isSprinting() && !player.horizontalCollision
            && player.getAttributeValue(EntityAttributes.MOVEMENT_SPEED) <= 0.10f
            && player.getVelocity().horizontalLengthSquared() <= 0.018
            && normalDryTraction(source) && normalDryTraction(landing)
            && walkedLaneDry(from, to, bearing)
            && dryRouteVeto(from, to, true, 1.27) == DryRouteVeto.CLEAR;
    }

    private DryRouteVeto dryRouteVeto(BlockPos from, BlockPos to, boolean requireLandingSupport, double beforeSource) {
        return dryRouteVeto(from, to, requireLandingSupport, beforeSource, false);
    }

    private DryRouteVeto dryRouteVeto(BlockPos from, BlockPos to, boolean requireLandingSupport,
                                      double beforeSource, boolean ordinaryGrade) {
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
        if (along < -beforeSource || along > 1.27 || Math.abs(across) > 0.19
                || Math.abs(drift) > 0.19
                || player.getY() < Math.min(y, to.getY()) - 0.055
                || player.getY() > Math.max(y, to.getY()) + 0.32) return DryRouteVeto.DRIFT;
        if (hazardAhead(heading(dx, dz), Math.max(0.7, 1.4 - along))) return DryRouteVeto.HAZARD;
        double half = player.getWidth() * 0.5 + 0.055;
        double upper = Math.max(y, to.getY());
        Box high = new Box(x - half, upper + 0.015, z - half, x + half, upper + 1.80, z + half);
        double cross = Math.abs(drift) > Math.abs(across) ? drift : across;
        Box approach = high.stretch(cross * dz, 0, -cross * dx);
        if (ordinaryGrade && across * drift < 0) {
            double other = cross == drift ? across : drift;
            approach = approach.stretch(other * dz, 0, -other * dx);
        }
        Box sweep = approach.stretch(dx, 0, dz);
        Box lowerSweep = null;
        if (ordinaryGrade) {
            if (Math.abs(dy) != 1 || !ordinaryGradePose(player)) return DryRouteVeto.SWEEP;
            sweep = sweep.stretch(0, 0.30, 0); // include vanilla jump apex, even with lateral drift
            lowerSweep = lowerGradeColumn(approach, dx, dy, dz);
            if (!caveLandingVolumeDry(sweep) || !caveLandingVolumeDry(lowerSweep)) return DryRouteVeto.HAZARD;
        }
        if (!client.world.isSpaceEmpty(player, sweep)) return DryRouteVeto.SWEEP;
        if (dy != 0) {
            if (lowerSweep == null) lowerSweep = lowerGradeColumn(approach, dx, dy, dz);
            if (!client.world.isSpaceEmpty(player, lowerSweep)) return DryRouteVeto.SWEEP;
        }
        // The source's reverse support is positive grounded body contact, not an
        // imaginary camera looking back from the destination. A change to either
        // exact chosen contact footprint can still veto the pair.
        Box sourceContact = new Box(high.minX, y - 0.06, high.minZ, high.maxX, y - 0.015, high.maxZ);
        Box landingContact = sourceContact.offset(dx, dy, dz);
        return client.world.isSpaceEmpty(player, sourceContact) || requireLandingSupport && client.world.isSpaceEmpty(player, landingContact)
            ? DryRouteVeto.SUPPORT : DryRouteVeto.CLEAR;
    }

    private static boolean ordinaryGradePose(ClientPlayerEntity player) {
        return !player.isSprinting() && !player.isUsingItem() && !player.isClimbing() && !player.getAbilities().flying
            && !player.hasStatusEffect(StatusEffects.JUMP_BOOST) && !player.hasStatusEffect(StatusEffects.SLOW_FALLING);
    }

    private static Box lowerGradeColumn(Box approach, int dx, int dy, int dz) {
        return (dy > 0 ? approach : approach.offset(dx, 0, dz)).stretch(0, -1, 0);
    }

    /** Negative-only hazard check on the swept body volume of two already witnessed contacts. */
    private boolean dryGradeVolume(Box sweep) {
        for (int x = MathHelper.floor(sweep.minX); x <= MathHelper.floor(sweep.maxX - 1e-5); x++)
            for (int z = MathHelper.floor(sweep.minZ); z <= MathHelper.floor(sweep.maxZ - 1e-5); z++)
                for (int y = MathHelper.floor(sweep.minY); y <= MathHelper.floor(sweep.maxY - 1e-5); y++)
                    if (dryCaveDanger(client.world.getBlockState(walkedProbe.set(x, y, z)))) return false;
        return true;
    }

    // A level walking view includes both the far half of the next tread and its headroom.
    static final float LEVEL_ROUTE_PITCH = 20;

    /** One bounded traversal under the normal lava and final key vetoes, without an automatic jump. */
    void driveDryRoute(BlockPos from, BlockPos to, Direction bearing) {
        driveDryRoute(from, to, bearing, false);
    }

    /** Keep W through a level waypoint only when the straight successor has already passed its guards. */
    void driveDryRoute(BlockPos from, BlockPos to, Direction bearing, boolean carry) {
        driveDryRoute(from, to, bearing, carry, false, true);
    }

    boolean driveVisualRise(OrdinaryGrade grade, boolean allowJump) {
        driveDryRoute(grade.from(), grade.to(), grade.bearing(), false, true, allowJump);
        return forward;
    }

    private void driveDryRoute(BlockPos from, BlockPos to, Direction bearing, boolean carry, boolean keepView,
                               boolean allowJump) {
        driveDryRoute(from, to, bearing, carry, keepView, allowJump, keepView ? 0.7 : 6.0);
    }

    private void driveDryRoute(BlockPos from, BlockPos to, Direction bearing, boolean carry, boolean keepView,
                               boolean allowJump, double alignment) {
        var player = client.player;
        Vec3d landing = Vec3d.ofBottomCenter(to);
        double dx = landing.x - player.getX(), dz = landing.z - player.getZ();
        boolean jump = allowJump && to.getY() > from.getY() && player.isOnGround() && !player.isTouchingWater()
            && !player.isInLava() && player.getBlockPos().equals(from);
        float yaw = heading(bearing.getOffsetX(), bearing.getOffsetZ());
        boolean level = to.getY() == from.getY();
        if (!keepView) turnFixed(yaw, level ? LEVEL_ROUTE_PITCH : jump ? 4 : 39);
        if (!hasView() || Math.abs(MathHelper.wrapDegrees(yaw - player.getYaw())) > alignment) return;
        double remaining = dx * bearing.getOffsetX() + dz * bearing.getOffsetZ();
        Vec3d velocity = player.getVelocity();
        double forwardSpeed = Math.max(0, velocity.x * bearing.getOffsetX() + velocity.z * bearing.getOffsetZ());
        dryRouteWalk = true;
        if (level) {
            if (!player.isOnGround()) return;
            float sourceGrip = client.world.getBlockState(walkedProbe.set(from).move(Direction.DOWN)).getBlock().getSlipperiness();
            float landingGrip = client.world.getBlockState(walkedProbe.set(to).move(Direction.DOWN)).getBlock().getSlipperiness();
            switch (dryLevelInput(remaining, forwardSpeed, 0.91 * Math.max(sourceGrip, landingGrip), carry)) {
                case FORWARD -> walkDownTo(carry ? landing.add(bearing.getOffsetX(), 0, bearing.getOffsetZ()) : landing);
                case BRAKE -> back();
                case COAST -> { }
            }
            return;
        }
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
        if (remaining > Math.max(0.12, braking)) {
            walkDownTo(landing);
            if (jump) jump();
        }
    }

    enum DryLevelInput { FORWARD, COAST, BRAKE }

    static boolean normalDryTraction(BlockState support) { return support.getBlock().getSlipperiness() == 0.6f; }

    static DryLevelInput dryLevelInput(double remaining, double forwardSpeed, double drag, boolean carry) {
        if (carry) return DryLevelInput.FORWARD;
        // Stored vanilla velocity is post-friction. The geometric series bounds the
        // remaining neutral travel, including the upcoming movement tick.
        double coast = forwardSpeed / (1 - drag);
        if (forwardSpeed > 0.065 && coast > remaining + 0.16) return DryLevelInput.BRAKE;
        return remaining > Math.max(0.12, coast + 0.025) ? DryLevelInput.FORWARD : DryLevelInput.COAST;
    }

    static boolean dryStrideContact(double remaining) { return Math.abs(remaining) <= 0.22; }

    /** A visible drop can veto walking. An unseen item is not evidence either way. */
    boolean macroNoVisiblePickup(Vec3d landing) {
        return macroNoVisiblePickup(landing, landing.y, landing.y);
    }

    /** Apply the same visible-drop veto along the bounded vertical sweep as well. */
    boolean macroNoVisiblePickup(Vec3d landing, double minimumFeetY, double maximumFeetY) {
        return pickupSweepClear(landing, minimumFeetY, maximumFeetY, 0, 0, null, AgentPickup.Scope.EXACT_ENTITY, null);
    }

    /** Negative-only collision veto: no item witness or target is created even if a drop is visible. */
    boolean visualReconPickupClear(Vec3d landing, double minimumFeetY, double maximumFeetY) {
        if (!hasView()) return false;
        Box sweep = pickupSweep(landing, minimumFeetY, maximumFeetY, 0, 0);
        return client.world.getEntitiesByClass(ItemEntity.class, sweep, Entity::isAlive).isEmpty();
    }

    private boolean pickupSweepClear(Vec3d landing, double minimumFeetY, double maximumFeetY,
                                     double driftX, double driftZ, ItemEntity target, AgentPickup.Scope scope,
                                     Predicate<ItemEntity> stockFooting) {
        return pickupSweepClear(landing, minimumFeetY, maximumFeetY, driftX, driftZ, target,
            target == null ? ItemStack.EMPTY : target.getStack(), scope, stockFooting);
    }

    private boolean pickupSweepClear(Vec3d landing, double minimumFeetY, double maximumFeetY,
                                     double driftX, double driftZ, ItemEntity target, ItemStack selected,
                                     AgentPickup.Scope scope, Predicate<ItemEntity> stockFooting) {
        if (!hasView() || raysLeft <= 0) return false;
        var player = client.player;
        Box sweep = pickupSweep(landing, minimumFeetY, maximumFeetY, driftX, driftZ);
        for (ItemEntity item : client.world.getEntitiesByClass(ItemEntity.class, sweep,
                candidate -> candidate != target && candidate.isAlive() && !candidate.isInvisibleTo(player))) {
            if (raysLeft <= 0) return false;
            if (visibleEntityPoint(item, item.getBoundingBox().getCenter()) == null) continue;
            ItemStack neighbor = item.getStack();
            if (!neighbor.isEmpty() && (!scope.permitsNeighbor(selected, neighbor)
                    || stockFooting == null || !stockFooting.test(item))) return false;
        }
        return raysLeft > 0;
    }

    boolean pickupTreadClear(AgentSurfaceTread.Edge edge, ItemEntity target, ItemStack witnessed,
                             AgentPickup.Scope scope, Predicate<ItemEntity> stockFooting) {
        return pickupSweepClear(Vec3d.ofBottomCenter(edge.lower()), edge.lower().getY(), edge.upper().getY(),
            0, 0, target, witnessed, scope, stockFooting);
    }

    /** New ordinary movement needs a current top. Height differences use the general grade proof and sweep. */
    AgentSurfaceTread.Edge witnessedOrdinaryTread(BlockPos from, BlockPos to, Direction bearing) {
        if (!AgentSurfaceTread.cardinalTread(from, to, bearing)) return null;
        if (from.getY() == to.getY()) {
            return witnessedStockTread(from, to, bearing)
                ? new AgentSurfaceTread.Edge(from, client.world.getBlockState(from.down()),
                    to, client.world.getBlockState(to.down()), bearing) : null;
        }
        BlockState source = ordinaryGradeSource(from, bearing);
        if (source == null) return null;
        var grade = ordinaryGradeTop(from, bearing, source, ordinaryGradeTopHit(to.down(), bearing));
        return grade == null ? null : grade.edge();
    }

    /** Collision may veto this exact visible path, but cannot supply a top or passage ray. */
    boolean witnessedStockTread(BlockPos from, BlockPos to, Direction bearing) {
        int grade = to.getY() - from.getY();
        if (grade < -1 || grade > 0 || !AgentSurfaceTread.cardinalTread(from, to, bearing)
                || !client.player.isOnGround() || client.options.forwardKey.isUnbound()
                || grade < 0 && client.options.jumpKey.isUnbound() || dryCaveContact(from) == null) return false;
        Vec3d center = Vec3d.ofBottomCenter(to);
        int dx = bearing.getOffsetX(), dz = bearing.getOffsetZ();
        if (dryRouteFloor(center.add(0.28 * dx, -0.032, 0.28 * dz), to.down()) == null
                && dryRouteFloor(center.add(-0.22 * dx, -0.032, -0.22 * dz), to.down()) == null) return false;
        return dryRouteClear(center.add(0, 1.32, 0)) == DryRouteSample.CLEAR
            && dryRouteClear(center.add(0, 1.76, 0)) == DryRouteSample.CLEAR
            && walkedLaneDry(from, to, bearing) && AgentSurfaceTread.retainedLaneClear(client, from, to, bearing)
            && dryRouteSweep(from, to);
    }

    private Box pickupSweep(Vec3d landing, double minimumFeetY, double maximumFeetY, double driftX, double driftZ) {
        var player = client.player;
        // The vanilla on-foot pickup envelope is 1 / 0.5 / 1 around the body.
        // Reserve an extra quarter-block for braking or a drifting drop.
        return player.getBoundingBox().stretch(landing.x - player.getX(), 0, landing.z - player.getZ())
            .stretch(driftX, 0, driftZ)
            .stretch(0, Math.min(0, minimumFeetY - player.getY()), 0)
            .stretch(0, Math.max(0, maximumFeetY - player.getY()), 0)
            .expand(1.25, 0.5, 1.25);
    }

    enum PickupResult { WAITING, MOVING, BLOCKED }

    /** Called only for a drop admitted by the current rendered view, or null to wait without input. */
    PickupResult pickUpVisible(ItemEntity drop, Vec3d waypoint, boolean exclusive) {
        return pickUpVisible(drop, waypoint, exclusive ? AgentPickup.Scope.EXACT_ENTITY : AgentPickup.Scope.LOCAL, null);
    }

    PickupResult pickUpVisible(ItemEntity drop, Vec3d waypoint, AgentPickup.Scope scope,
                               Predicate<ItemEntity> stockFooting) {
        pauseWork(); // Stop carrying the last mining or travel look into passive pickup.
        if (drop == null) return PickupResult.WAITING;
        var player = client.player;
        if (!hasView() || !client.isWindowFocused() || client.getOverlay() != null
                || lavaEmergency || player.isOnFire() || player.isInLava() || player.hurtTime != 0
                || player.isTouchingWater() || !player.isOnGround() || player.hasVehicle() || player.getAbilities().flying) {
            visibleHorizon.reportPickup(drop, "unsafe_stance", null);
            return PickupResult.BLOCKED;
        }
        AgentPickup.Input input = AgentPickup.input(player.getBoundingBox(), drop.getBoundingBox(), drop.isOnGround(),
            waypoint, player.getYaw());
        if (input == AgentPickup.Input.WAIT || player.isSprinting()) {
            visibleHorizon.reportPickup(drop, player.isSprinting() ? "sprint_coast" : "passive_wait", null);
            return PickupResult.WAITING;
        }
        if (input == AgentPickup.Input.UNREACHABLE || player.horizontalCollision) {
            visibleHorizon.reportPickup(drop, player.horizontalCollision ? "body_collision" : "height_out_of_reach", null);
            return PickupResult.BLOCKED;
        }
        var keys = client.options;
        if (input.forward > 0 && keys.forwardKey.isUnbound() || input.forward < 0 && keys.backKey.isUnbound()
                || input.right > 0 && keys.rightKey.isUnbound() || input.right < 0 && keys.leftKey.isUnbound()) {
            visibleHorizon.reportPickup(drop, "unbound_key", null);
            return PickupResult.BLOCKED;
        }
        float yaw = player.getYaw() + input.yawOffset;
        boolean workStock = scope == AgentPickup.Scope.MATCHING_STOCK;
        AgentVisibleHorizon.Track track = visibleHorizon.pickupTrack(drop, yaw, workStock);
        if (track == null) {
            var blocked = visibleHorizon.blockedPickupTrack();
            if (workStock && blocked != null && blocked.refusal() == Refusal.SURFACE_NOT_RENDERED
                    && Double.isFinite(blocked.braking()) && blocked.braking() <= 1.6
                    && pickupSweepClear(drop, yaw, blocked, scope, stockFooting)
                    && visibleHorizon.glanceAtPickupGround(drop, yaw)) return PickupResult.WAITING;
            visibleHorizon.reportBlockedPickup(drop);
            return PickupResult.BLOCKED;
        }
        if (scope != AgentPickup.Scope.LOCAL) {
            if (!pickupSweepClear(drop, yaw, track, scope, stockFooting)) {
                visibleHorizon.reportPickup(drop, "incidental_pickup_veto", track);
                return PickupResult.BLOCKED;
            }
        }
        pickupLane = track;
        pickupTarget = drop;
        pickupInput = input;
        return PickupResult.MOVING;
    }

    private boolean pickupSweepClear(ItemEntity drop, float yaw, AgentVisibleHorizon.Track track,
                                     AgentPickup.Scope scope, Predicate<ItemEntity> stockFooting) {
        double angle = Math.toRadians(yaw), dx = -Math.sin(angle), dz = Math.cos(angle);
        Vec3d landing = client.player.getPos().add(dx * track.braking(), 0, dz * track.braking());
        return pickupSweepClear(landing, landing.y, landing.y, -dz * track.sideDrift(), dx * track.sideDrift(),
            drop, scope, stockFooting);
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

    boolean appliedEmergencyForward() {
        return emergencyDriveTick == tick - 1 && client.options.forwardKey.isPressed();
    }

    float defensiveViewYaw() { return hasView() ? observedYaw : Float.NaN; }
    float defensiveViewPitch() { return hasView() ? observedPitch : Float.NaN; }

    @Override public boolean obstructed(float bearing) {
        if (!hasView() || lavaEmergency || Math.abs(MathHelper.wrapDegrees(bearing - client.player.getYaw())) > 35)
            return false;
        var player = client.player;
        double angle = Math.toRadians(bearing);
        // Immediate body-space veto, never a source of a path behind the camera.
        return !client.world.isSpaceEmpty(player, player.getBoundingBox().offset(0, 0.01, 0)
            .stretch(-0.23 * Math.sin(angle), 0, 0.23 * Math.cos(angle)));
    }

    @Override public Vec3d dryLanding(float bearing) {
        var player = client.player;
        if (!hasView() || lavaEmergency || !player.isOnGround() || player.hasVehicle()
                || player.isTouchingWater() || client.options.forwardKey.isUnbound()) return null;
        int y = MathHelper.floor(player.getY() + 0.055);
        if (Math.abs(player.getY() - y) > 0.055) return null;

        float actual = player.getYaw();
        if (Math.abs(MathHelper.wrapDegrees(bearing - actual)) <= AgentEmergencyFootwork.DRIVE_ALIGNMENT) bearing = actual;
        double angle = Math.toRadians(bearing), dx = -Math.sin(angle), dz = Math.cos(angle);
        Vec3d velocity = player.getVelocity();
        double across = velocity.x * dz - velocity.z * dx;
        if (Math.abs(across) > 0.045) return null;
        double minimum = Math.max(DEFENSIVE_ROWS[0], 2.65 * Math.sqrt(velocity.horizontalLengthSquared()) + 0.14);
        Direction travel = Direction.fromHorizontalDegrees(bearing);
        double back = Math.min(0, velocity.x * dx + velocity.z * dz);
        Box box = player.getBoundingBox().offset(0, 0.01, 0)
            .stretch(2.65 * (back * dx + across * dz), 0, 2.65 * (back * dz - across * dx));
        double reach = DEFENSIVE_ROWS[DEFENSIVE_ROWS.length - 1];
        Box far = box.stretch(reach * dx, 0, reach * dz);
        int startX = MathHelper.floor(far.minX + 1e-5);
        int startZ = MathHelper.floor(far.minZ + 1e-5);
        int columnsZ = MathHelper.floor(far.maxZ - 1e-5) - startZ + 1;
        int columnsX = MathHelper.floor(far.maxX - 1e-5) - startX + 1;
        if (columnsX * columnsZ > Long.SIZE) return null;
        int sourceX = player.getBlockX(), sourceZ = player.getBlockZ();
        long witnessed = 0;
        double safeReach = 0;
        lanes: for (double distance : DEFENSIVE_ROWS) {
            Box sweep = box.stretch(dx * distance, 0, dz * distance);
            if (hazardAhead(bearing, distance + 0.16)) break;
            for (int x = MathHelper.floor(sweep.minX + 1e-5); x <= MathHelper.floor(sweep.maxX - 1e-5); ++x) {
                for (int z = MathHelper.floor(sweep.minZ + 1e-5); z <= MathHelper.floor(sweep.maxZ - 1e-5); ++z) {
                    long bit = 1L << ((x - startX) * columnsZ + z - startZ);
                    if ((witnessed & bit) != 0) continue;
                    if (!defensiveColumn(x, y, z, travel, x == sourceX && z == sourceZ)) break lanes;
                    witnessed |= bit;
                }
            }
            if (!client.world.isSpaceEmpty(player, sweep)) break;
            safeReach = distance;
        }
        return safeReach >= minimum ? player.getPos().add(dx * safeReach, 0, dz * safeReach) : null;
    }

    private boolean defensiveColumn(int x, int y, int z, Direction travel, boolean standing) {
        BlockPos floor = walkedProbe.set(x, y - 1, z);
        if (!standing && emergencyFloor(new Vec3d(x + 0.5, y - 0.032, z + 0.5), travel, DEFENSIVE_DANGER)
                != DryRouteTop.WITNESSED) return false;
        // Recheck just the witnessed support (or own contact) and its swept body column.
        BlockState state = client.world.getBlockState(floor);
        return !dryCaveDanger(state) && fullStepSupport(floor, state)
            && overlandLoadHolds(client.world, floor, state, overlandProbe)
            && !dryCaveDanger(client.world.getBlockState(walkedProbe.move(Direction.UP)))
            && !dryCaveDanger(client.world.getBlockState(walkedProbe.move(Direction.UP)));
    }

    float recentEmergencyBearing() {
        Vec3d walked = recentEmergencyFooting(), feet = client.player.getPos();
        double dx = walked == null ? 0 : walked.x - feet.x, dz = walked == null ? 0 : walked.z - feet.z;
        return walked != null && Math.abs(feet.y - walked.y) <= 0.055 && dx * dx + dz * dz >= 0.04
            ? heading(dx, dz) : Float.NaN;
    }

    void driveCheckedEmergencyLane(Vec3d landing, float bearing) {
        var player = client.player;
        Vec3d velocity = player.getVelocity();
        double shown = Math.sqrt(landing.squaredDistanceTo(player.getPos()));
        boolean sprint = AgentDefense.MeleeRecovery.canSprint(shown, Math.sqrt(velocity.horizontalLengthSquared()),
            player.getHungerManager().getFoodLevel(), player.isSprinting());
        driveEmergencyLane(landing, bearing, AgentEmergencyFootwork.PITCH, sprint);
        checkedEmergencyWalk = true;
    }

    /** Capture only a solid block face already returned by a lit first-person ray. */
    BlockHitResult visibleRangedCover(Predicate<BlockPos> offersShelter) {
        return horizonCue(state -> !dryCaveDanger(state) && !state.isIn(BlockTags.LEAVES), 4.5,
            hit -> hit.getSide().getAxis().isHorizontal() && rangedCoverState(hit.getBlockPos()) != null
                && offersShelter.test(hit.getBlockPos()));
    }

    /** Mechanical recheck at a witnessed or actually placed block, not a new observation. */
    BlockState rangedCoverState(BlockPos pos) {
        BlockState state = client.world.getBlockState(pos);
        return !dryCaveDanger(state) && !state.isIn(BlockTags.LEAVES)
            && Block.isShapeFullCube(state.getCollisionShape(client.world, pos)) ? state : null;
    }

    void braceForFuse(float toward) {
        steering = gaitSteering = fallSteering = fixedSteering = false;
        var player = client.player;
        if (lavaEmergency || player.hasVehicle() || player.isTouchingWater()) return;
        if (player.isOnGround()) sneak();
        ItemStack main = player.getMainHandStack();
        if (main.isOf(Items.SHIELD) || player.getOffHandStack().isOf(Items.SHIELD) && shieldSafeMainHand(main)) {
            turnUrgent(toward, 15);
            guardRangedBearing(toward);
        }
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

    void blockAgainst(LivingEntity threat) {
        if (mayContact(threat)) shielding = threat;
    }

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
        if (!hasView() || !client.player.isOnGround() || !sameSurveySupport(support, client.player.getPos()))
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

    /** The body already occupies this exact full top. Check only the short inward sweep, without changing its gaze. */
    boolean centerOnGroundedSupport(BlockPos foot, BlockState known) {
        var player = client.player;
        if (known == null || !hasView() || lavaEmergency || player.isInLava() || player.isOnFire()
                || player.isTouchingWater() || player.isSprinting()
                || player.hasVehicle() || player.getAbilities().flying || player.hurtTime != 0
                || !sameSurveySupport(foot.down(), player.getPos()) || dryCaveContact(foot) != known
                || !normalDryTraction(known)) return false;
        if (dryCaveDanger(client.world.getBlockState(foot)) || dryCaveDanger(client.world.getBlockState(foot.up())))
            return false;
        Vec3d center = Vec3d.ofBottomCenter(foot);
        double dx = center.x - player.getX(), dz = center.z - player.getZ();
        double length = Math.hypot(dx, dz);
        if (hazardAhead(heading(dx, dz), length + 0.12)
                || !client.world.isSpaceEmpty(player, player.getBoundingBox().stretch(dx, 0, dz))) return false;
        centerLanding = center;
        return true;
    }

    static boolean sameSurveySupport(BlockPos support, Vec3d feet) {
        double x = feet.x - support.getX(), z = feet.z - support.getZ();
        return x >= 0 && x < 1 && z >= 0 && z < 1 && Math.abs(feet.y - support.getY() - 1) <= 0.055;
    }

    enum EdgeStanceResult { WORKING, SETTLED, REFUSED }

    /** Same physical contact, even when the player's center initially lies in another column. */
    record EdgeStance(BlockPos support, Vec3d origin, Vec3d center) {
        private static final double LIMIT = 0.80;
        private static final double SETTLED = 0.125;
        private static final double COAST = 1 / (1 - 0.55); // Normal full-block ground drag is 0.6 * 0.91.

        static EdgeStance start(BlockPos support, Vec3d feet, Box body) {
            if (support == null || sameSurveySupport(support, feet) || !overlaps(support, feet, body)) return null;
            Vec3d center = Vec3d.ofBottomCenter(support.up());
            return feet.squaredDistanceTo(center) <= LIMIT * LIMIT ? new EdgeStance(support.toImmutable(), feet, center) : null;
        }

        private static boolean overlaps(BlockPos support, Vec3d feet, Box body) {
            return Math.abs(feet.y - support.getY() - 1) <= 0.035
                && Math.min(body.maxX, support.getX() + 1) - Math.max(body.minX, support.getX()) >= 0.05
                && Math.min(body.maxZ, support.getZ() + 1) - Math.max(body.minZ, support.getZ()) >= 0.05;
        }

        boolean holds(BlockPos contact, Vec3d feet, Box body) {
            return support.equals(contact) && overlaps(support, feet, body)
                && feet.squaredDistanceTo(origin) <= LIMIT * LIMIT && feet.squaredDistanceTo(center) <= LIMIT * LIMIT;
        }

        boolean settled(Vec3d feet) { return feet.squaredDistanceTo(center) <= SETTLED * SETTLED; }

        boolean dryTop(BlockHitResult hit, BlockState state, BlockView world) {
            return matchesDryRouteTop(hit, support) && !hit.isInsideBlock() && !dryCaveDanger(state)
                && !(state.getBlock() instanceof FallingBlock) && normalDryTraction(state)
                && Block.isShapeFullCube(state.getCollisionShape(world, support));
        }

        Box sweep(BlockPos contact, Vec3d feet, Box standing, Vec3d motion, double inputX, double inputZ) {
            if (!holds(contact, feet, standing)) return null;
            double dx = center.x - feet.x, dz = center.z - feet.z;
            double coastX = COAST * motion.x, coastZ = COAST * motion.z;
            double pressX = COAST * (motion.x + inputX), pressZ = COAST * (motion.z + inputZ);
            if (!inwardAxis(origin.x, feet.x, center.x, coastX, pressX)
                    || !inwardAxis(origin.z, feet.z, center.z, coastZ, pressZ)
                    || origin.squaredDistanceTo(feet.x + coastX, feet.y, feet.z + coastZ) > LIMIT * LIMIT
                    || origin.squaredDistanceTo(feet.x + pressX, feet.y, feet.z + pressZ) > LIMIT * LIMIT) return null;
            return new Box(
                standing.minX + Math.min(0, Math.min(dx, Math.min(coastX, pressX))), standing.minY + 0.005,
                standing.minZ + Math.min(0, Math.min(dz, Math.min(coastZ, pressZ))),
                standing.maxX + Math.max(0, Math.max(dx, Math.max(coastX, pressX))), standing.maxY,
                standing.maxZ + Math.max(0, Math.max(dz, Math.max(coastZ, pressZ))));
        }

        private static boolean inwardAxis(double origin, double feet, double center, double coast, double press) {
            // The body may approach the settled band from outside it, but never extend its overhang.
            double low = Math.min(Math.max(origin, feet), center - SETTLED) - 0.006;
            double high = Math.max(Math.min(origin, feet), center + SETTLED) + 0.006;
            return feet + Math.min(0, Math.min(coast, press)) >= low
                && feet + Math.max(0, Math.max(coast, press)) <= high;
        }
    }

    EdgeStance edgeStance() {
        if (!hasView() || !edgeStanceControls()) return null;
        var player = client.player;
        return EdgeStance.start(player.supportingBlockPos.orElse(null), player.getPos(), player.getBoundingBox());
    }

    EdgeStanceResult settleEdgeStance(EdgeStance stance) {
        if (!hasView()) return EdgeStanceResult.WORKING; // No ray or movement during a render gap.
        if (!edgeStanceControls()) return EdgeStanceResult.REFUSED;
        var player = client.player;
        Vec3d feet = player.getPos();
        BlockPos contact = player.supportingBlockPos.orElse(null);
        if (!stance.holds(contact, feet, player.getBoundingBox())) return EdgeStanceResult.REFUSED;
        Vec3d center = stance.center();
        Vec3d point = center.add(0, -0.025, 0);
        aimFixed(point);
        BlockHitResult hit = inView(point) ? visibleHit(point, Ray.TERRAIN) : null;
        if (!matchesDryRouteTop(hit, contact)) hit = ordinaryRouteOutlineTop(contact);
        if (!matchesDryRouteTop(hit, contact)) return EdgeStanceResult.WORKING;
        if (!stance.dryTop(hit, client.world.getBlockState(contact), client.world)) return EdgeStanceResult.REFUSED;

        double dx = center.x - feet.x, dz = center.z - feet.z;
        float yaw = heading(dx, dz);
        Vec3d motion = player.getVelocity();
        boolean centered = stance.settled(feet);
        boolean drive = !centered && player.isSneaking()
            && Math.abs(MathHelper.wrapDegrees(yaw - player.getYaw())) <= 6;
        double inputX = 0, inputZ = 0;
        if (drive) {
            double angle = Math.toRadians(player.getYaw());
            double acceleration = 0.102 * player.getAttributeValue(EntityAttributes.SNEAKING_SPEED) + 0.008;
            inputX = -acceleration * Math.sin(angle);
            inputZ = acceleration * Math.cos(angle);
        }
        Box standing = player.getDimensions(EntityPose.STANDING).getBoxAt(feet);
        Box sweep = stance.sweep(contact, feet, standing, motion, inputX, inputZ);
        if (drive && sweep == null) {
            drive = false;
            sweep = stance.sweep(contact, feet, standing, motion, 0, 0);
        }
        // These are negative-only vetoes over the standing hull of the witnessed inward shift.
        if (sweep == null || !caveLandingVolumeDry(sweep) || !client.world.isSpaceEmpty(player, sweep)
                || hazardAhead(yaw, Math.hypot(dx, dz) + 0.12)) return EdgeStanceResult.REFUSED;
        if (centered) return player.getPose() == EntityPose.STANDING && motion.horizontalLengthSquared() <= 0.000144
            ? EdgeStanceResult.SETTLED : EdgeStanceResult.WORKING;
        sneak();
        if (drive) {
            walkDownTo(center);
            flatWalk = true;
        }
        return EdgeStanceResult.WORKING;
    }

    private boolean edgeStanceControls() {
        if (lavaEmergency || !client.isWindowFocused() || client.getOverlay() != null
                || client.options.getAutoJump().getValue() || client.options.forwardKey.isUnbound()
                || client.options.sneakKey.isUnbound()) return false;
        var player = client.player;
        return player.isOnGround() && !player.isTouchingWater() && !player.isInLava() && !player.isOnFire()
            && !player.isSprinting() && !player.isClimbing() && !player.isUsingItem() && !player.hasVehicle()
            && !player.getAbilities().flying && !player.hasNoDrag() && player.hurtTime == 0
            && player.getVelocity().horizontalLengthSquared() <= 0.0025
            && player.getAttributeValue(EntityAttributes.MOVEMENT_SPEED) <= 0.101
            && player.getAttributeValue(EntityAttributes.SNEAKING_SPEED) <= 0.36;
    }

    static boolean drySurveyLaneCentered(BlockPos foot, double x, double z, Direction facing) {
        x -= foot.getX() + 0.5;
        z -= foot.getZ() + 0.5;
        double along = x * facing.getOffsetX() + z * facing.getOffsetZ();
        double across = x * facing.getOffsetZ() - z * facing.getOffsetX();
        // Leave margin inside the exact Body sweep.
        return Math.abs(along) <= 0.25 && Math.abs(across) <= 0.17;
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

    /** Read a natural top in the rendered frustum as a look landmark, not a landing or a path. */
    BlockHitResult caveFloorLandmark(BlockPos footing) {
        return find(AgentBody::naturalCaveFloor, 6, hit -> {
            BlockPos pos = hit.getBlockPos();
            Vec3d point = hit.getPos();
            double dx = point.x - footing.getX() - 0.5, dz = point.z - footing.getZ() - 0.5;
            return Math.abs(pos.getY() - footing.getY()) <= 1 && dx * dx + dz * dz >= 1.21
                && matchesDryRouteTop(hit, pos) && stableDryRouteTop(pos, client.world.getBlockState(pos));
        }).orElse(null);
    }

    /** A positively rendered cave feature for steering only, never a support or a clearance grant. */
    BlockHitResult dryProspectLandmark(BlockPos foot, Predicate<BlockState> ore, Predicate<BlockHitResult> eligible) {
        return find(state -> naturalCaveFloor(state) || ore.test(state), 6, hit -> {
            BlockPos pos = hit.getBlockPos();
            if (Math.abs(pos.getY() - foot.getY()) > 2 || pos.equals(foot.down()) || !eligible.test(hit)) return false;
            BlockState state = client.world.getBlockState(pos);
            if (!ore.test(state) && (!matchesDryRouteTop(hit, pos) || !stableDryRouteTop(pos, state))) return false;
            // General visible block samples look through water. A departure cue must not.
            return sameBlockFace(hit, perceive(hit.getPos(), 6).orElse(null));
        }).orElse(null);
    }

    private static boolean naturalCaveFloor(BlockState state) {
        return state.isIn(BlockTags.BASE_STONE_OVERWORLD) || state.isIn(BlockTags.BASE_STONE_NETHER)
            || state.isIn(BlockTags.DIRT) || state.isOf(Blocks.CALCITE) || state.isOf(Blocks.DRIPSTONE_BLOCK);
    }

    boolean caveFloorLandmarkCurrent(BlockHitResult witness) {
        var hit = perceive(witness.getPos(), 6).orElse(null);
        BlockPos pos = witness.getBlockPos();
        if (hit == null || !matchesDryRouteTop(hit, pos)) return false;
        BlockState state = client.world.getBlockState(pos);
        return naturalCaveFloor(state) && stableDryRouteTop(pos, state);
    }

    /** Reject positions among already admitted camera hits, before choosing the nearest match. */
    Optional<BlockHitResult> find(Predicate<BlockState> matches, double distance, Predicate<BlockHitResult> eligible) {
        return find(matches, distance, eligible, true);
    }

    /** Use the rendered crosshair and existing samples without starting a new view scan. */
    Optional<BlockHitResult> findSampled(Predicate<BlockState> matches, double distance, Predicate<BlockHitResult> eligible) {
        return find(matches, distance, eligible, false);
    }

    /** Recheck at most one witnessed point per adjacent wall cell, with fluids opaque. */
    <T> T sampledLevelWall(BlockPos foot, int stance, double reach, BiFunction<BlockHitResult, BlockState, T> usable) {
        if (!hasView()) {
            levelWallSight.noView();
            return null;
        }
        return levelWallSight.find(foot, stance, tick, reach, client.player.getEyePos(), renderedCrosshair, samples,
            sampleFrame == frameSequence ? sampleCount : 0, usable);
    }

    private BlockState clientBlockState(BlockPos pos) { return client.world.getBlockState(pos); }

    LevelWallSight levelWallSight() { return levelWallSight; }
    int generalRaysRemaining() { return raysLeft; }

    void reserveLevelWallRays() {
        if (hasView()) raysLeft -= levelWallSight.reserve(raysLeft);
    }

    void releaseLevelWallRays() { raysLeft += levelWallSight.release(); }

    enum WallVisual {
        NO_RENDER, NO_ADJACENT_FACE, OUT_OF_REACH, OUT_OF_VIEW, RAY_BUDGET, RECHECK_MISS,
        RECHECK_OCCLUDED_OR_CHANGED, RECHECK_DARK;

        static final WallVisual[] ALL = values();
        final int bit = 1 << ordinal();
    }

    static final class LevelWallSight {
        private final Predicate<Vec3d> inView;
        private final Function<Vec3d, BlockHitResult> raycast;
        private final Predicate<BlockHitResult> litFace;
        private final Function<BlockHitResult, BlockState> stateOfWitnessed;
        private int raysLeft, rechecks, visualRefusals;
        private boolean usedRetainedWitness;
        private Vec3d cameraEye;
        private float yaw, pitch;
        // An aim point, not a permission. Only a new fluid-opaque lit ray and the live consumer can return it.
        private BlockHitResult witness;
        private BlockState witnessState;
        private BlockPos witnessFoot;
        private Vec3d witnessPlayerEye;
        private int witnessStance, witnessTick;

        LevelWallSight(Predicate<Vec3d> inView, Function<Vec3d, BlockHitResult> raycast,
                       Predicate<BlockHitResult> litFace, Function<BlockHitResult, BlockState> stateOfWitnessed) {
            this.inView = inView;
            this.raycast = raycast;
            this.litFace = litFace;
            this.stateOfWitnessed = stateOfWitnessed;
        }

        void observePose(Vec3d eye, float yaw, float pitch) {
            if (witness != null && (!eye.equals(cameraEye) || yaw != this.yaw || pitch != this.pitch)) forget();
            cameraEye = eye;
            this.yaw = yaw;
            this.pitch = pitch;
        }

        void forget() {
            witness = null;
            witnessState = null;
            witnessFoot = null;
            witnessPlayerEye = null;
        }

        int reserve(int generalRays) {
            int reserved = Math.min(generalRays, LEVEL_WALL_RAYS - raysLeft);
            raysLeft += reserved;
            return reserved;
        }

        int release() {
            int unused = raysLeft;
            raysLeft = 0;
            return unused;
        }

        int raysLeft() { return raysLeft; }
        int rechecks() { return rechecks; }
        int visualRefusals() { return visualRefusals; }
        boolean usedRetainedWitness() { return usedRetainedWitness; }

        void noView() {
            forget();
            usedRetainedWitness = false;
            rechecks = 0;
            visualRefusals = WallVisual.NO_RENDER.bit;
        }

        <T> T find(BlockPos foot, int stance, int tick, double reach, Vec3d playerEye, HitResult crosshair,
                   BlockHitResult[] samples, int count, BiFunction<BlockHitResult, BlockState, T> usable) {
            rechecks = visualRefusals = 0;
            usedRetainedWitness = false;
            boolean hold = witness != null && stance == witnessStance && foot.equals(witnessFoot)
                && playerEye.equals(witnessPlayerEye) && tick - witnessTick <= LEVEL_WALL_WITNESS_TICKS;
            BlockHitResult retained = hold ? witness : null;
            BlockState retainedState = hold ? witnessState : null;
            forget();
            if (reach <= 0) {
                visualRefusals = WallVisual.OUT_OF_REACH.bit;
                return null;
            }
            double max = reach * reach;
            Vec3d eye = cameraEye;
            int checked = 0;
            for (int i = -2; i < count; ++i) {
                HitResult candidate = i == -2 ? crosshair : i == -1 ? retained : samples[i];
                if (!(candidate instanceof BlockHitResult hit) || hit.getType() != HitResult.Type.BLOCK
                        || hit.isInsideBlock()) continue;
                BlockPos cell = hit.getBlockPos();
                Direction bearing = AgentSurfaceTread.prospectLevelBearing(foot, cell);
                if (bearing == null || hit.getSide() != bearing.getOpposite()) continue;
                int bit = 1 << (2 * bearing.ordinal() + cell.getY() - foot.getY());
                if ((checked & bit) != 0) continue;
                Vec3d point = hit.getPos();
                double distance = point.squaredDistanceTo(eye);
                if (distance <= 0.0001 || distance > max || point.squaredDistanceTo(playerEye) > max) {
                    visualRefusals |= WallVisual.OUT_OF_REACH.bit;
                    continue;
                }
                if (!inView.test(point)) {
                    visualRefusals |= WallVisual.OUT_OF_VIEW.bit;
                    continue;
                }
                if (raysLeft <= 0) {
                    visualRefusals |= WallVisual.RAY_BUDGET.bit;
                    break;
                }
                checked |= bit;
                --raysLeft;
                ++rechecks;
                double inset = 0.02 / Math.sqrt(distance);
                var live = raycast.apply(point.add((point.x - eye.x) * inset, (point.y - eye.y) * inset,
                    (point.z - eye.z) * inset));
                if (live.getType() != HitResult.Type.BLOCK) visualRefusals |= WallVisual.RECHECK_MISS.bit;
                else if (!sameBlockFace(hit, live) || live.isInsideBlock())
                    visualRefusals |= WallVisual.RECHECK_OCCLUDED_OR_CHANGED.bit;
                else if (!inView.test(live.getPos())) visualRefusals |= WallVisual.OUT_OF_VIEW.bit;
                else if (!litFace.test(live)) visualRefusals |= WallVisual.RECHECK_DARK.bit;
                else {
                    BlockState state = stateOfWitnessed.apply(live);
                    if (i == -1 && state != retainedState) {
                        visualRefusals |= WallVisual.RECHECK_OCCLUDED_OR_CHANGED.bit;
                        continue;
                    }
                    T result = usable.apply(live, state);
                    if (result != null) {
                        witness = live;
                        witnessState = state;
                        witnessFoot = foot;
                        witnessPlayerEye = playerEye;
                        witnessStance = stance;
                        witnessTick = tick;
                        usedRetainedWitness = i == -1;
                        return result;
                    }
                }
            }
            if (rechecks == 0 && visualRefusals == 0) visualRefusals = WallVisual.NO_ADJACENT_FACE.bit;
            return null;
        }
    }

    private Optional<BlockHitResult> find(Predicate<BlockState> matches, double distance, Predicate<BlockHitResult> eligible,
                                          boolean sampleMore) {
        if (!hasView()) return Optional.empty();
        double max = range(distance);
        if (!(max > 0)) return Optional.empty();
        if (renderedCrosshair instanceof BlockHitResult target && target.getType() == HitResult.Type.BLOCK
                && matchesHit(target, target.getBlockPos(), max)) {
            if (matches.test(client.world.getBlockState(target.getBlockPos())) && (eligible == null || eligible.test(target)))
                return Optional.of(target);
        }
        if (sampleMore && max > sampleRange && raysLeft > 0) sampleView(Math.min(range(MAX_RANGE), Math.max(max, 12)));
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

    /** Ordinary tables may attach to any real contact in the rendered station samples. */
    BlockHitResult benchFace(double reach, BiPredicate<BlockHitResult, BlockPos> usable,
                            Predicate<BlockPos> preservesStationView) {
        if (!hasView() || reach <= 0) return null;
        if (sampleCount == 0) sampleView(reach);
        var player = client.player;
        Vec3d liveEye = player.getEyePos();
        int feetY = player.getBlockY();
        double reachSquared = reach * reach, cost = Double.POSITIVE_INFINITY;
        BlockHitResult best = null;
        boolean bestPreservesView = false;
        for (int i = -1; i < sampleCount; i++) {
            BlockHitResult hit = i < 0 ? selectedFace() : samples[i];
            if (hit == null || hit.isInsideBlock()) continue;
            double distance = hit.getPos().squaredDistanceTo(liveEye);
            if (distance > reachSquared) continue;
            if (i < 0) {
                // The crosshair outline alone may be dark; the grid samples are already lit rays.
                BlockHitResult lit = contactRay(hit.getPos(), reach);
                if (!sameBlockFace(hit, lit) || lit.isInsideBlock()) continue;
                hit = lit;
            }
            BlockPos dest = placementCell(hit);
            double score = benchFaceScore(hit.getSide(), dest.getY() - feetY, distance, reachSquared);
            boolean preservesView = preservesStationView == null || preservesStationView.test(dest);
            if (bestPreservesView && !preservesView || preservesView == bestPreservesView && score >= cost) continue;
            if (!usable.test(hit, dest)) continue;
            best = hit;
            cost = score;
            bestPreservesView = preservesView;
        }
        return best;
    }

    static double benchFaceScore(Direction side, int dy, double distanceSquared, double reachSquared) {
        if (side == Direction.UP && dy == 0) return distanceSquared;
        return distanceSquared + reachSquared + 1 + (side == Direction.UP ? 0 : 3) + Math.abs(dy) * 2;
    }

    private void sampleView(double distance) {
        if (sampleFrame != frameSequence) {
            sampleCount = 0;
            sampleFrame = frameSequence;
        }
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
        return wetEscapeRise(0, 0, rise);
    }

    /** Veto an already witnessed air target when there is no room to rise after reaching it. */
    boolean wetEscapeRiseAt(Vec3d landing, double rise) {
        var player = client.player;
        return wetEscapeRise(landing.x - player.getX(), landing.z - player.getZ(), rise);
    }

    private boolean wetEscapeRise(double dx, double dz, double rise) {
        var player = client.player;
        if (!hasView() || lavaEmergency || !player.isTouchingWater() || player.hasVehicle()
                || player.isInLava() || player.isOnFire()) return false;
        Box current = player.getBoundingBox();
        Box column = (dx == 0 && dz == 0 ? current : current.offset(dx, 0, dz))
            .stretch(0, Math.max(0.16, rise + 0.05), 0);
        return !hazards.lavaNear(column, 0.32, tick)
            && client.world.isSpaceEmpty(player, column.contract(1e-5, 0, 1e-5));
    }

    /** Prevent automatic buoyancy input even while turning to recheck an exit. */
    void holdWetEscape() { wetEscapeWalk = true; }

    /** Mechanical veto on one already witnessed step down, not a probe for new cave cells. */
    boolean wetEscapeDrop(double drop) {
        var player = client.player;
        return hasView() && !lavaEmergency && player.isTouchingWater()
            && !player.hasVehicle() && !player.isInLava() && !player.isOnFire()
            && !hazards.lavaNear(player.getBoundingBox(), 0.32, tick)
            && client.world.isSpaceEmpty(player, player.getBoundingBox().contract(1e-5, 0, 1e-5)
                .stretch(0, -drop, 0));
    }

    /** Stay level in a low passage. Jump only to breathe or climb a proved lip. */
    void driveWetEscape(boolean climb) {
        walkDown(false);
        holdWetEscape();
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

    Optional<LivingEntity> threat(double distance, LivingEntity lastAttacker, boolean impact, boolean watchArchers) {
        rangedThreatPoint = null;
        if (!hasView()) return Optional.empty();
        double max = range(distance);
        if (!(max > 0)) return Optional.empty();
        double closeSquared = max * max;
        threats.begin(closeSquared);
        double archerRange = watchArchers ? range(Math.max(distance, 14)) : max;
        double nearestArcher = archerRange * archerRange;
        for (LivingEntity candidate : client.world.getEntitiesByClass(LivingEntity.class, entityArea(archerRange),
                entity -> entity instanceof Monster && availableEntity(entity))) {
            if (raysLeft <= 0) break;
            Vec3d center = candidate.getBoundingBox().getCenter();
            double d = center.squaredDistanceTo(eye);
            if (candidate instanceof EndermanEntity enderman) {
                if (d <= closeSquared) observeEnderman(enderman, center, d);
            } else {
                boolean archer = watchArchers && d <= nearestArcher && candidate instanceof RangedAttackMob
                    && (d <= closeSquared || candidate.isUsingItem())
                    && (candidate.isHolding(Items.BOW) || candidate.isHolding(Items.CROSSBOW));
                if (!archer && !threats.couldSelect(d)) continue;
                Vec3d visible = visibleEntityPoint(candidate, center);
                if (visible == null) continue;
                if (archer) {
                    nearestArcher = d;
                    Vec3d launch = candidate.getEyePos().add(0, -0.10, 0);
                    rangedThreatPoint = clearPoint(launch, Ray.SIGHT) ? launch : visible;
                }
                if ((candidate instanceof SpiderEntity || candidate instanceof PiglinEntity || candidate instanceof Angerable)
                        && candidate != lastAttacker && !(impact && visiblyCorroboratesMeleeImpact(candidate))) continue;
                threats.observeHostile(candidate, visible, d);
            }
        }
        return Optional.ofNullable(threats.target());
    }

    /** Admit a potentially neutral mob only on visible close contact consistent with this hit. */
    boolean visiblyCorroboratesMeleeImpact(LivingEntity candidate) {
        var player = client.player;
        Vec3d velocity = player.getVelocity();
        if (player.hurtTime == 0 || velocity.y <= 0.06 || velocity.horizontalLengthSquared() < 0.0064) return false;
        double dx = player.getX() - candidate.getX(), dz = player.getZ() - candidate.getZ();
        double separation = dx * dx + dz * dz;
        double reach = (player.getWidth() + candidate.getWidth()) * 0.5 + 0.65;
        double away = dx * velocity.x + dz * velocity.z;
        return Math.abs(player.getY() - candidate.getY()) <= 1 && separation <= reach * reach
            && away > 0 && away * away >= 0.75 * separation * velocity.horizontalLengthSquared();
    }

    private void observeEnderman(EndermanEntity enderman, Vec3d center, double distanceSquared) {
        Vec3d body = clearPoint(center, Ray.SIGHT) ? center : null;
        if (body == null) {
            Vec3d legs = center.add(0, -enderman.getHeight() * 0.32, 0);
            if (clearPoint(legs, Ray.SIGHT)) body = legs;
        }
        Vec3d eyes = enderman.getEyePos();
        boolean clearEyes = clearSight(eyes, Ray.SIGHT);
        // The emissive eyes are visible in darkness when the face is turned our way.
        boolean shownEyes = clearEyes && (body != null || lit(eyes.x, eyes.y, eyes.z)
            || Math.abs(MathHelper.wrapDegrees(heading(eye.x - eyes.x, eye.z - eyes.z)
                - enderman.getHeadYaw())) < 75);
        if (body == null && !shownEyes) return;
        // Exactly the synced flag that drives the vanilla renderer's angry head and shake.
        threats.observeEnderman(enderman, body, shownEyes ? eyes : null, distanceSquared, enderman.isAngry());
    }

    Vec3d threatPoint() { return threats.aim(); }
    Vec3d rangedThreatPoint() { return rangedThreatPoint; }

    Optional<ItemEntity> dropped(Predicate<ItemStack> matches, double distance) {
        return visibleEntity(ItemEntity.class, entity -> matches.test(entity.getStack()), distance);
    }

    Optional<ItemEntity> dropped(Predicate<ItemStack> matches, double distance, Predicate<ItemEntity> eligible) {
        return visibleEntity(ItemEntity.class, entity -> eligible.test(entity) && matches.test(entity.getStack()), distance);
    }

    boolean seesDrop(ItemEntity drop, double distance) {
        if (!hasView() || drop.getWorld() != client.world || !availableEntity(drop)) return false;
        Vec3d center = drop.getBoundingBox().getCenter();
        double max = range(distance);
        return center.squaredDistanceTo(eye) <= max * max && visibleEntityPoint(drop, center) != null;
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
        for (T candidate : client.world.getEntitiesByClass(type, entityArea(max), this::availableEntity)) {
            if (raysLeft <= 0) break;
            Vec3d center = candidate.getBoundingBox().getCenter();
            double d = center.squaredDistanceTo(eye);
            if (d > bestDistance) continue;
            Vec3d visible = visibleEntityPoint(candidate, center);
            if (visible == null) continue;
            if (!matches.test(candidate)) continue;
            best = candidate;
            bestDistance = d;
        }
        return Optional.ofNullable(best);
    }

    private Box entityArea(double max) {
        return new Box(eye.x - max, eye.y - max, eye.z - max, eye.x + max, eye.y + max, eye.z + max);
    }

    private boolean availableEntity(Entity entity) {
        return entity != client.player && entity.isAlive() && !entity.isInvisibleTo(client.player);
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
        return clearSight(point, ray) && lit(point.x, point.y, point.z);
    }

    private boolean clearSight(Vec3d point, Ray ray) {
        if (raysLeft <= 0 || !inView(point)) return false;
        raysLeft--;
        return raycast(point, ray).getType() == HitResult.Type.MISS;
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
        return litRay(end, ray);
    }

    private BlockHitResult litRay(Vec3d end, Ray ray) {
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
            public VoxelShape getBlockShape(BlockState state, BlockView world, BlockPos pos) {
                // These sparse crossed plants do not hide the surface behind them.
                if (ray == Ray.HORIZON_TOP && (state.isOf(Blocks.SHORT_GRASS) || state.isOf(Blocks.TALL_GRASS)
                        || state.isOf(Blocks.FERN) || state.isOf(Blocks.LARGE_FERN))) return VoxelShapes.empty();
                return super.getBlockShape(state, world, pos);
            }

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
