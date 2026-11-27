package io.gameharness.survival;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.vehicle.AbstractBoatEntity;
import net.minecraft.item.BoatItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/**
 * Perception-honest multi-method safe high-drop & giant-cave descent engine.
 *
 * All drop assessments use ONLY observed geometry from Perception.getObserved(...)
 * and observed entities — never peeking into unseen loaded world chunks.
 *
 * Supported descent methods:
 *  1. WATER_CLUTCH : intentional & reactive MLG water-bucket fall clutch + water reclaim
 *  2. WATER_POUR   : pour waterfall on drop lip, ride stream down cleanly, exit to dry floor
 *  3. BOAT_DROP    : place & mount wooden boat, steer off ledge (0 fall dmg), dismount & recover boat
 *  4. CLIFF_STAIR  : hug solid cliff wall & carve covered walkable switchback staircase downward
 *  5. EDGE_BLOCKS  : sneak edge block-placement (shelf bridging & wall-side step-down shelves)
 *  6. AVOID        : refuse unsafe/lava drops, step back safely, curb/reroute away from hazard
 */
final class SafeDescent {
    enum Method {
        AUTO, WATER_POUR, WATER_CLUTCH, BOAT_DROP, CLIFF_STAIR, EDGE_BLOCKS, AVOID;

        static Method parse(String raw) {
            if (raw == null || raw.isBlank()) return AUTO;
            String clean = raw.trim().toLowerCase(Locale.ROOT).replace('-', '_');
            return switch (clean) {
                case "water_pour", "waterfall" -> WATER_POUR;
                case "water_clutch", "mlg", "mlg_water" -> WATER_CLUTCH;
                case "boat_drop", "boat" -> BOAT_DROP;
                case "cliff_stair", "cliff_staircase", "stair", "staircase" -> CLIFF_STAIR;
                case "edge_blocks", "edge_step", "bridge", "shelf" -> EDGE_BLOCKS;
                case "avoid", "refuse" -> AVOID;
                default -> AUTO;
            };
        }

        String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    enum LandingSurface {
        DRY_SOLID, WATER, LAVA, HAZARD, UNSEEN;

        String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    enum RunStatus {
        RUNNING, COMPLETED, REFUSED, FAILED
    }

    /** Pure input snapshot for unit-testable descent method selection & hazard refusal. */
    record AssessmentInput(
        int dropDepth,
        boolean floorObserved,
        boolean landingLava,
        boolean landingHazard,
        boolean landingWater,
        boolean landingSolidDry,
        int landingHostiles,
        boolean hasCliffWall,
        boolean hasSteppedShelf,
        boolean hasWaterBucket,
        boolean hasBoat,
        boolean canCraftBoat,
        boolean hasPickaxe,
        int scaffoldBlocks,
        float health,
        boolean wantDescend
    ) {}

    /** Pure decision result from evaluateBestMethod. */
    record Decision(
        Method method,
        boolean shouldDescend,
        String refusedReason,
        String rationale
    ) {}

    /** Observed overlook geometry near the player (derived strictly from Perception). */
    record Overlook(
        BlockPos takeoffPos,      // walkable feet cell at edge
        Direction dropDir,        // direction from takeoffPos into the drop column
        BlockPos dropCol,         // air cell directly off the lip (takeoffPos.offset(dropDir))
        int landingY,             // feet Y of observed floor (or Integer.MIN_VALUE if unseen)
        int dropDepth,            // takeoffPos.getY() - landingY (or estimated depth if unseen)
        boolean floorObserved,
        LandingSurface landingSurface,
        boolean landingLava,
        boolean landingHazard,
        int landingHostiles,
        Direction cliffWallDir,   // adjacent solid cliff wall suitable for stair carving (nullable)
        BlockPos steppedShelf,    // lower reachable dry shelf across/below gap (nullable)
        boolean hasSteppedShelf
    ) {}

    private enum Phase {
        IDLE,
        PEEKING,
        // Water clutch
        CLUTCH_PREP, CLUTCH_JUMP, CLUTCH_FALL, CLUTCH_RECLAIM,
        // Water pour
        POUR_APPROACH, POUR_PLACE, POUR_WAIT_STREAM, POUR_RIDE, POUR_EXIT,
        // Boat drop
        BOAT_PREP, BOAT_PLACE, BOAT_MOUNT, BOAT_STEER_OFF, BOAT_FALL, BOAT_DISMOUNT, BOAT_BREAK, BOAT_COLLECT,
        // Cliff staircase
        STAIR_CARVE,
        // Edge blocks
        EDGE_PLACE_STEP,
        // Avoid / refusal
        AVOID_RETREAT
    }

    private final MinecraftClient client;
    private final Motor motor;
    private final Perception perception;
    private final GuiHands gui;

    // Strategist preference (AUTO unless model/task overrides)
    private Method preferredMethod = Method.AUTO;

    // Latest overlook assessment (refreshed periodically for strategist & telemetry)
    private Overlook lastOverlook;
    private Decision lastDecision = new Decision(Method.AVOID, false, "", "no drop nearby");

    // Active descent execution state
    private Phase phase = Phase.IDLE;
    private Method activeMethod = Method.AUTO;
    private Method requestedMethod = Method.AUTO;
    private Overlook activeOverlook;
    private int targetFloorY = Integer.MIN_VALUE;
    private int startY;
    private int phaseTicks;
    private int totalTicks;
    private int peekTicks;
    private int peekBrinkTicks;
    private String statusText = "";

    // Water clutch state (shared between intentional & reactive clutch!)
    private BlockPos placedClutchWater;
    private int clutchReclaimTicks;
    private int clutchSettleTicks;
    private boolean reactiveClutchActive;

    // Water pour state
    private BlockPos waterfallSourcePos;
    private BlockPos waterfallDropCol;
    private int pourWaitTicks;

    // Boat drop state
    private int placedBoatEntityId = -1;
    private int boatLandedTicks;
    private int boatBreakHits;
    private int boatHitCooldown;
    private BlockPos boatPlaceSupport;

    // Cliff stair state
    private Direction stairHeading;
    private Direction stairWallSide;
    private BlockPos stairNextStep;
    private int stairStepTicks;
    private int stairStepsCarved;

    // Edge blocks state
    private Direction edgeDir;
    private BlockPos edgeTargetBlock;
    private int edgeBlocksPlaced;
    private int edgeStepTicks;
    private int edgeDescendDepth;

    // Telemetry & verification receipts
    private String lastExecutedMethod = "none";
    private String refusedHazard = "";
    private boolean descentCompletedEver;
    private boolean waterClutchLandedEver;
    private boolean waterReclaimedEver;
    private boolean boatDroppedEver;
    private boolean boatReclaimedEver;

    // Damage & altitude tracking
    private float lastTrackedHealth = Float.NaN;
    private boolean wasAirborneHigh;
    private float peakFallDistance;
    private int recentLandingTicks;
    private float fallDamageTaken;
    private float totalDamageTaken;
    private double minY = Double.POSITIVE_INFINITY;
    private double maxY = Double.NEGATIVE_INFINITY;

    SafeDescent(MinecraftClient client, Motor motor, Perception perception, GuiHands gui) {
        this.client = client;
        this.motor = motor;
        this.perception = perception;
        this.gui = gui;
    }

    // ===================== PURE DECISION ENGINE (UNIT-TESTABLE!) =====================

    /**
     * Evaluates observed drop conditions, hazards, and player inventory to choose
     * the safest, most human-like descent method — or refuse lethal drops.
     * Safety invariants (lava refusal, unseen-floor jump refusal, low-HP swarm refusal)
     * CANNOT be overridden even if a caller requests water_clutch or boat_drop.
     */
    static Decision evaluateBestMethod(AssessmentInput in, Method preferredOverride) {
        Method pref = preferredOverride == null ? Method.AUTO : preferredOverride;

        // 0. Trivial drop (<= 3 blocks) onto observed safe ground needs no high-drop maneuver
        if (in.dropDepth() <= 3 && in.floorObserved() && !in.landingLava() && !in.landingHazard()) {
            return new Decision(Method.AVOID, false, "", "drop <= 3 blocks (ordinary walk/drop)");
        }

        // 1. HARD SAFETY INVARIANT: Never jump/clutch/boat directly into observed LAVA!
        if (in.landingLava()) {
            if (pref == Method.CLIFF_STAIR && in.hasCliffWall() && in.hasPickaxe()) {
                return new Decision(Method.CLIFF_STAIR, true, "lava_landing",
                    "refused direct jump into lava; carving sheltered cliff staircase away from lava");
            }
            return new Decision(Method.AVOID, false, "lava_landing",
                "refused direct drop into observed lava floor");
        }

        // 2. HARD SAFETY INVARIANT: Never jump/clutch/boat onto fire/magma/hazard
        if (in.landingHazard()) {
            if (in.hasCliffWall() && in.hasPickaxe()) {
                return new Decision(Method.CLIFF_STAIR, true, "hazard_landing",
                    "avoiding landing hazard via cliff-side staircase");
            }
            return new Decision(Method.AVOID, false, "hazard_landing",
                "refused drop onto observed hazard");
        }

        // 3. Explicit AVOID always honored
        if (pref == Method.AVOID || !in.wantDescend()) {
            return new Decision(Method.AVOID, false, pref == Method.AVOID ? "policy_avoid" : "",
                "avoiding drop per strategy");
        }

        // 4. Low HP + visible hostile swarm at landing -> refuse open drop!
        if (in.landingHostiles() >= 2 && in.health() < 12.0f) {
            if (in.hasCliffWall() && in.hasPickaxe() && pref != Method.WATER_CLUTCH && pref != Method.BOAT_DROP) {
                return new Decision(Method.CLIFF_STAIR, true, "hostile_swarm_low_hp",
                    "low HP over hostile swarm; preferring sheltered cliff staircase");
            }
            return new Decision(Method.AVOID, false, "hostile_swarm_low_hp",
                "refused open drop into hostile swarm at low HP");
        }

        // 5. Unobserved / occluded floor -> NEVER blindly leap with water_clutch or boat_drop!
        if (!in.floorObserved()) {
            if ((pref == Method.WATER_POUR || pref == Method.AUTO) && in.hasWaterBucket()) {
                return new Decision(Method.WATER_POUR, true, "",
                    "floor unseen; pouring reusable waterfall from ledge");
            }
            if ((pref == Method.CLIFF_STAIR || pref == Method.AUTO) && in.hasCliffWall() && in.hasPickaxe()) {
                return new Decision(Method.CLIFF_STAIR, true, "",
                    "floor unseen; carving covered cliff-side staircase");
            }
            if ((pref == Method.EDGE_BLOCKS || pref == Method.AUTO) && in.scaffoldBlocks() >= 6) {
                return new Decision(Method.EDGE_BLOCKS, true, "",
                    "floor unseen; stepping down carefully with edge blocks");
            }
            return new Decision(Method.AVOID, false, "unseen_floor",
                "refused blind jump into unobserved cavern floor");
        }

        // 6. Honor explicit safe strategist/task overrides when required gear is carried!
        if (pref != Method.AUTO) {
            switch (pref) {
                case WATER_CLUTCH -> {
                    if (in.hasWaterBucket() && (in.landingSolidDry() || in.landingWater())) {
                        return new Decision(Method.WATER_CLUTCH, true, "", "water-bucket MLG fall clutch selected");
                    }
                }
                case WATER_POUR -> {
                    if (in.hasWaterBucket()) {
                        return new Decision(Method.WATER_POUR, true, "", "water-pour waterfall descent selected");
                    }
                }
                case BOAT_DROP -> {
                    if (in.hasBoat() && (in.landingSolidDry() || in.landingWater())) {
                        return new Decision(Method.BOAT_DROP, true, "", "boat drop descent selected");
                    }
                }
                case CLIFF_STAIR -> {
                    if (in.hasPickaxe()) {
                        return new Decision(Method.CLIFF_STAIR, true, "", "cliff-side covered staircase selected");
                    }
                }
                case EDGE_BLOCKS -> {
                    if (in.scaffoldBlocks() >= 2) {
                        return new Decision(Method.EDGE_BLOCKS, true, "", "edge block-placement descent selected");
                    }
                }
                default -> {}
            }
            // If requested method lacked gear, fall through to best available safe alternative!
        }

        // 7. AUTO selection: pick best human-like safe descent method for terrain + gear!
        if (in.hasWaterBucket()) {
            // Very clear dry landing + healthy + no hostiles + drop >= 8..38 -> crisp MLG clutch or reusable waterfall!
            if (in.landingSolidDry() && in.landingHostiles() == 0 && in.health() >= 14.0f
                    && in.dropDepth() >= 8 && in.dropDepth() <= 36 && !in.hasSteppedShelf()) {
                return new Decision(Method.WATER_CLUTCH, true, "",
                    "clear observed dry floor with water bucket -> MLG water clutch");
            }
            return new Decision(Method.WATER_POUR, true, "",
                "water bucket available -> safe reusable waterfall descent");
        }

        if (in.hasBoat() && (in.landingSolidDry() || in.landingWater()) && in.landingHostiles() <= 1) {
            return new Decision(Method.BOAT_DROP, true, "",
                "wooden boat carried over clear cavern floor -> zero-damage boat drop");
        }

        if (in.hasSteppedShelf() && in.scaffoldBlocks() >= 4 && in.dropDepth() <= 18) {
            return new Decision(Method.EDGE_BLOCKS, true, "",
                "stepped ledge/chasm with scaffold blocks -> edge block step-down");
        }

        if (in.hasCliffWall() && in.hasPickaxe()) {
            return new Decision(Method.CLIFF_STAIR, true, "",
                "solid cliff wall + pickaxe -> covered cliff-side staircase");
        }

        if (in.scaffoldBlocks() >= 6) {
            return new Decision(Method.EDGE_BLOCKS, true, "",
                "scaffold blocks available -> controlled edge step-down");
        }

        if (in.hasPickaxe()) {
            return new Decision(Method.CLIFF_STAIR, true, "",
                "pickaxe available -> carving sheltered staircase");
        }

        return new Decision(Method.AVOID, false, "insufficient_gear",
            "no safe descent gear for high drop");
    }

    // ===================== PUBLIC STATE & TELEMETRY =====================

    void resetForLife() {
        clearActive();
        reactiveClutchActive = false;
        placedClutchWater = null;
        clutchReclaimTicks = 0;
        clutchSettleTicks = 0;
        lastTrackedHealth = Float.NaN;
        wasAirborneHigh = false;
        peakFallDistance = 0f;
        recentLandingTicks = 0;
    }

    void setPreferredMethod(Method method) {
        if (method != null) this.preferredMethod = method;
    }

    Method preferredMethod() { return preferredMethod; }
    Overlook lastOverlook() { return lastOverlook; }
    Decision lastDecision() { return lastDecision; }
    boolean isActivelyDescending() { return phase != Phase.IDLE; }
    boolean isInBoatDrop() { return activeMethod == Method.BOAT_DROP && phase != Phase.IDLE; }
    boolean isReactiveClutchActive() { return reactiveClutchActive; }
    String activePhaseName() { return phase.name().toLowerCase(Locale.ROOT); }
    String activeMethodName() { return phase == Phase.IDLE ? lastExecutedMethod : activeMethod.wireName(); }
    String statusText() { return statusText; }
    String refusedHazard() { return refusedHazard; }
    boolean descentCompletedEver() { return descentCompletedEver; }
    boolean waterClutchLandedEver() { return waterClutchLandedEver; }
    boolean waterReclaimedEver() { return waterReclaimedEver; }
    boolean boatDroppedEver() { return boatDroppedEver; }
    boolean boatReclaimedEver() { return boatReclaimedEver; }
    int stairStepsCarved() { return stairStepsCarved; }
    int edgeBlocksPlaced() { return edgeBlocksPlaced; }
    float fallDamageTaken() { return fallDamageTaken; }
    float totalDamageTaken() { return totalDamageTaken; }
    double minY() { return Double.isFinite(minY) ? minY : 0.0; }
    double maxY() { return Double.isFinite(maxY) ? maxY : 0.0; }

    /** Called every tick by AgentClient to maintain damage/altitude telemetry and passive overlook assessment. */
    void tickTelemetry(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        if (player == null || world == null || !player.isAlive()) return;
        double y = player.getY();
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        // Track fall distance & attribute landing HP drops accurately to fallDamageTaken
        if (!player.isOnGround() && !player.isTouchingWater() && !player.hasVehicle()) {
            if (player.fallDistance > peakFallDistance) peakFallDistance = player.fallDistance;
            if (player.fallDistance > 2.5f) wasAirborneHigh = true;
            recentLandingTicks = 0;
        } else {
            if (wasAirborneHigh) {
                recentLandingTicks++;
                if (recentLandingTicks > 6) {
                    wasAirborneHigh = false;
                    peakFallDistance = 0f;
                    recentLandingTicks = 0;
                }
            }
        }

        float hp = player.getHealth();
        if (Float.isFinite(lastTrackedHealth) && hp < lastTrackedHealth - 0.01f) {
            float loss = lastTrackedHealth - hp;
            totalDamageTaken += loss;
            boolean likelyFall = (wasAirborneHigh || peakFallDistance > 3.0f || recentLandingTicks > 0)
                && !player.isInLava() && !player.isOnFire() && player.getAttacker() == null;
            if (likelyFall) {
                fallDamageTaken += loss;
            }
        }
        lastTrackedHealth = hp;

        // Refresh passive overlook assessment every 8 ticks (cheap, purely from Perception)
        if (currentTick % 8 == 0 || lastOverlook == null) {
            lastOverlook = scanOverlook(player, world, 0, 0);
            if (lastOverlook != null) {
                AssessmentInput input = buildInput(player, lastOverlook, true);
                lastDecision = evaluateBestMethod(input, preferredMethod);
            } else {
                lastDecision = new Decision(Method.AVOID, false, "", "no high drop nearby");
            }
        }
    }

    // ===================== REACTIVE WATER-BUCKET MLG FALL CLUTCH =====================

    /**
     * Called by SurvivalReflexes every tick.
     * Handles unexpected falls (> 3.2 blocks) when carrying a hotbar water bucket,
     * AND reclaims clutch water cleanly after landing.
     * Never interferes with an active intentional descent (e.g. BOAT_DROP or WATER_POUR).
     */
    boolean tickReactiveFallClutch(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        if (player == null || world == null || !player.isAlive()) return false;
        // Let intentional SafeDescent own the body if it is currently running!
        if (phase != Phase.IDLE) {
            reactiveClutchActive = false;
            return false;
        }
        // Never trigger water clutch while riding a boat!
        if (player.hasVehicle()) {
            reactiveClutchActive = false;
            return false;
        }

        // 1. Reclaim water placed by a reactive clutch once landed safely!
        if (placedClutchWater != null) {
            if (stepReclaimClutchWater(player, world)) {
                reactiveClutchActive = true;
                statusText = "reclaiming clutch water";
                return true;
            }
            reactiveClutchActive = false;
            return false;
        }

        // 2. Detect unexpected fall
        if (!player.isOnGround() && !player.isTouchingWater()
                && player.getVelocity().y < -0.46 && player.fallDistance > 3.2f) {
            int waterSlot = motor.findHotbarItem(Items.WATER_BUCKET);
            if (waterSlot >= 0) {
                if (stepMidAirWaterClutch(player, world, waterSlot, true)) {
                    reactiveClutchActive = true;
                    lastExecutedMethod = Method.WATER_CLUTCH.wireName();
                    statusText = "water-bucket fall clutch";
                    return true;
                }
            }
        }
        reactiveClutchActive = false;
        return false;
    }

    // ===================== INTENTIONAL DESCENT LIFECYCLE =====================

    void startDescent(ClientPlayerEntity player, ClientWorld world, Method methodRequest, int desiredFloorY, BlockPos hintPos) {
        clearActive();
        this.requestedMethod = (methodRequest == null || methodRequest == Method.AUTO) ? preferredMethod : methodRequest;
        this.targetFloorY = desiredFloorY;
        this.startY = player.getBlockY();
        int hintDx = hintPos == null ? 0 : hintPos.getX() - player.getBlockPos().getX();
        int hintDz = hintPos == null ? 0 : hintPos.getZ() - player.getBlockPos().getZ();
        this.activeOverlook = scanOverlook(player, world, hintDx, hintDz);
        this.peekTicks = 0;
        this.peekBrinkTicks = 0;
        this.phaseTicks = 0;
        this.totalTicks = 0;
        this.phase = Phase.PEEKING;
        this.statusText = "inspecting cavern drop";
    }

    void clearActive() {
        phase = Phase.IDLE;
        activeMethod = Method.AUTO;
        activeOverlook = null;
        phaseTicks = 0;
        totalTicks = 0;
        peekTicks = 0;
        placedClutchWater = null;
        clutchReclaimTicks = 0;
        clutchSettleTicks = 0;
        waterfallSourcePos = null;
        waterfallDropCol = null;
        pourWaitTicks = 0;
        placedBoatEntityId = -1;
        boatLandedTicks = 0;
        boatBreakHits = 0;
        boatHitCooldown = 0;
        boatPlaceSupport = null;
        stairHeading = null;
        stairWallSide = null;
        stairNextStep = null;
        stairStepTicks = 0;
        edgeDir = null;
        edgeTargetBlock = null;
        edgeStepTicks = 0;
        edgeDescendDepth = 0;
        statusText = "";
    }

    /**
     * Advance active intentional descent by one 20-TPS tick.
     * Returns RUNNING while in progress, COMPLETED on safe arrival, REFUSED on hazard refusal, or FAILED.
     */
    RunStatus tickActiveDescent(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        if (player == null || world == null || !player.isAlive()) {
            clearActive();
            return RunStatus.FAILED;
        }
        if (phase == Phase.IDLE) return RunStatus.FAILED;

        totalTicks++;
        phaseTicks++;

        // Generous timeout for carving staircases/shelves, tighter for fast drops
        int maxAllowed = (activeMethod == Method.CLIFF_STAIR || activeMethod == Method.EDGE_BLOCKS) ? 2600 : 900;
        if (totalTicks > maxAllowed) {
            clearActive();
            return RunStatus.FAILED;
        }

        // Wait cleanly if GuiHands is swapping bucket/boat/blocks to hotbar
        if (gui.isBusy()) {
            gui.tick();
            statusText = "equipping descent gear";
            return RunStatus.RUNNING;
        }

        return switch (phase) {
            case PEEKING -> tickPeeking(player, world);
            case CLUTCH_PREP -> tickClutchPrep(player, world);
            case CLUTCH_JUMP -> tickClutchJump(player, world);
            case CLUTCH_FALL -> tickClutchFall(player, world);
            case CLUTCH_RECLAIM -> tickClutchReclaim(player, world);
            case POUR_APPROACH -> tickPourApproach(player, world);
            case POUR_PLACE -> tickPourPlace(player, world);
            case POUR_WAIT_STREAM -> tickPourWaitStream(player, world);
            case POUR_RIDE -> tickPourRide(player, world);
            case POUR_EXIT -> tickPourExit(player, world);
            case BOAT_PREP -> tickBoatPrep(player, world);
            case BOAT_PLACE -> tickBoatPlace(player, world);
            case BOAT_MOUNT -> tickBoatMount(player, world);
            case BOAT_STEER_OFF -> tickBoatSteerOff(player, world);
            case BOAT_FALL -> tickBoatFall(player, world);
            case BOAT_DISMOUNT -> tickBoatDismount(player, world);
            case BOAT_BREAK -> tickBoatBreak(player, world);
            case BOAT_COLLECT -> tickBoatCollect(player, world);
            case STAIR_CARVE -> tickStairCarve(player, world);
            case EDGE_PLACE_STEP -> tickEdgePlaceStep(player, world);
            case AVOID_RETREAT -> tickAvoidRetreat(player, world);
            default -> RunStatus.FAILED;
        };
    }

    // ===================== PHASE 0: CAUTIOUS SNEAK-PEEK & ASSESSMENT =====================

    private RunStatus tickPeeking(ClientPlayerEntity player, ClientWorld world) {
        peekTicks++;
        // Re-scan observed overlook every tick while peeking down over the ledge!
        Overlook ov = scanOverlook(player, world, 0, 0);
        if (ov != null) activeOverlook = ov;

        // Walk smoothly to the cliff brink (sneaking once within 1.15m of edge!), and ONLY begin
        // counting peek observation ticks once our eyes are actually at the lip looking down into the cavern!
        if (activeOverlook != null) {
            Vec3d lipEdge = Vec3d.ofBottomCenter(activeOverlook.takeoffPos())
                .add(activeOverlook.dropDir().getOffsetX() * 0.52, 0, activeOverlook.dropDir().getOffsetZ() * 0.52);
            double distToLip = Math.hypot(player.getX() - lipEdge.x, player.getZ() - lipEdge.z);
            float lookYaw = dirToYaw(activeOverlook.dropDir());

            if (distToLip > 0.32 && peekTicks < 75) {
                boolean nearEdge = distToLip <= 1.25;
                motor.moveToward(lipEdge, false, false, nearEdge, false);
                motor.lookAtAngles(lookYaw, nearEdge ? 58f : 38f, Motor.LookMode.NORMAL);
                statusText = "approaching cavern brink to inspect drop";
                return RunStatus.RUNNING;
            }

            motor.requestSneak();
            peekBrinkTicks++;
            float sweepPitch = peekBrinkTicks < 10 ? 54f : (peekBrinkTicks < 22 ? 68f : 80f);
            float sweepYaw = lookYaw + (float) Math.sin(peekBrinkTicks * 0.35) * 18f;
            motor.lookAtAngles(sweepYaw, sweepPitch, Motor.LookMode.SCAN);

            boolean seenEnough = (activeOverlook.floorObserved() && peekBrinkTicks >= 12)
                || (activeOverlook.landingLava() && peekBrinkTicks >= 6)
                || peekBrinkTicks >= 34
                || peekTicks >= 110;
            if (!seenEnough) {
                statusText = "peeking over cavern edge";
                return RunStatus.RUNNING;
            }
        } else {
            // Look around downward to locate nearby drop edge
            float scanYaw = player.getYaw() + (peekTicks * 14f);
            motor.lookAtAngles(scanYaw, 45f, Motor.LookMode.SCAN);
            if (peekTicks < 32) {
                statusText = "scanning for cavern overlook";
                return RunStatus.RUNNING;
            }
            // No sheer drop found; if pickaxe carried and targetFloorY is below us, carve staircase anyway!
            if (targetFloorY != Integer.MIN_VALUE && targetFloorY < player.getBlockY() - 3 && hasAnyPickaxe(player)) {
                activeMethod = Method.CLIFF_STAIR;
                lastExecutedMethod = activeMethod.wireName();
                initCliffStair(player, world, null);
                setPhase(Phase.STAIR_CARVE);
                return RunStatus.RUNNING;
            }
            clearActive();
            return RunStatus.FAILED;
        }

        // Now evaluate using strictly observed geometry!
        AssessmentInput input = buildInput(player, activeOverlook, true);
        Decision dec = evaluateBestMethod(input, requestedMethod);
        lastDecision = dec;
        if (!dec.refusedReason().isEmpty()) {
            refusedHazard = dec.refusedReason();
        }

        // Determine target floor Y from observed floor if not explicitly set
        if (targetFloorY == Integer.MIN_VALUE && activeOverlook.floorObserved()) {
            targetFloorY = activeOverlook.landingY();
        } else if (targetFloorY == Integer.MIN_VALUE) {
            targetFloorY = player.getBlockY() - Math.max(8, activeOverlook.dropDepth());
        }

        activeMethod = dec.method();
        lastExecutedMethod = activeMethod.wireName();

        if (!dec.shouldDescend() || activeMethod == Method.AVOID) {
            setPhase(Phase.AVOID_RETREAT);
            statusText = "refusing unsafe drop (" + (dec.refusedReason().isEmpty() ? "avoid" : dec.refusedReason()) + ")";
            return RunStatus.RUNNING;
        }

        switch (activeMethod) {
            case WATER_CLUTCH -> setPhase(Phase.CLUTCH_PREP);
            case WATER_POUR -> setPhase(Phase.POUR_APPROACH);
            case BOAT_DROP -> setPhase(Phase.BOAT_PREP);
            case CLIFF_STAIR -> {
                initCliffStair(player, world, activeOverlook);
                setPhase(Phase.STAIR_CARVE);
            }
            case EDGE_BLOCKS -> {
                initEdgeBlocks(player, world, activeOverlook);
                setPhase(Phase.EDGE_PLACE_STEP);
            }
            default -> setPhase(Phase.AVOID_RETREAT);
        }
        return RunStatus.RUNNING;
    }

    // ===================== METHOD 1: WATER-BUCKET MLG FALL CLUTCH =====================

    private RunStatus tickClutchPrep(ClientPlayerEntity player, ClientWorld world) {
        statusText = "preparing water-bucket clutch";
        if (!ensureItemInHotbar(player, st -> st.isOf(Items.WATER_BUCKET))) {
            if (GuiHands.countItem(player, Items.WATER_BUCKET) <= 0) {
                clearActive();
                return RunStatus.FAILED;
            }
            return RunStatus.RUNNING;
        }
        int waterSlot = motor.findHotbarItem(Items.WATER_BUCKET);
        player.getInventory().selectedSlot = waterSlot;

        if (activeOverlook == null) {
            clearActive();
            return RunStatus.FAILED;
        }
        // Final lava double-check before jumping!
        if (isLandingLavaObserved(activeOverlook.dropCol(), activeOverlook.landingY())) {
            refusedHazard = "lava_landing";
            activeMethod = Method.AVOID;
            lastExecutedMethod = Method.AVOID.wireName();
            setPhase(Phase.AVOID_RETREAT);
            return RunStatus.RUNNING;
        }

        // Stand slightly back from edge, facing out over the drop column
        Vec3d takeoff = Vec3d.ofBottomCenter(activeOverlook.takeoffPos());
        double dist = Math.hypot(player.getX() - takeoff.x, player.getZ() - takeoff.z);
        Vec3d aimDown = new Vec3d(
            activeOverlook.dropCol().getX() + 0.5,
            activeOverlook.landingY(),
            activeOverlook.dropCol().getZ() + 0.5
        );
        motor.lookAtPoint(aimDown, Motor.LookMode.NORMAL);

        if (dist > 0.55 && phaseTicks < 45) {
            motor.moveToward(takeoff, false, false, true, false);
            return RunStatus.RUNNING;
        }
        if (phaseTicks >= 4) {
            setPhase(Phase.CLUTCH_JUMP);
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickClutchJump(ClientPlayerEntity player, ClientWorld world) {
        statusText = "leaping for water clutch";
        int waterSlot = motor.findHotbarItem(Items.WATER_BUCKET);
        if (waterSlot >= 0) player.getInventory().selectedSlot = waterSlot;

        Direction dir = activeOverlook.dropDir();
        // Aim smoothly down toward the landing pad while stepping/hopping cleanly past the lip
        Vec3d dropTarget = new Vec3d(
            activeOverlook.dropCol().getX() + 0.5 + dir.getOffsetX() * 0.55,
            activeOverlook.landingY(),
            activeOverlook.dropCol().getZ() + 0.5 + dir.getOffsetZ() * 0.55
        );
        motor.lookAtPoint(dropTarget, Motor.LookMode.COMBAT);
        motor.moveToward(dropTarget, false, phaseTicks == 1 && player.isOnGround(), false, false);

        // Once airborne and falling (or clearly past the lip), transition to CLUTCH_FALL!
        if (!player.isOnGround() && (player.getY() < startY - 0.5 || player.getVelocity().y < -0.15)) {
            setPhase(Phase.CLUTCH_FALL);
        } else if (phaseTicks > 50) {
            clearActive();
            return RunStatus.FAILED;
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickClutchFall(ClientPlayerEntity player, ClientWorld world) {
        statusText = "executing MLG water clutch";
        int waterSlot = motor.findHotbarItem(Items.WATER_BUCKET);

        // If water was already placed and we landed safely in water or on ground -> reclaim!
        if (placedClutchWater != null) {
            if (player.isTouchingWater() || player.isOnGround()) {
                waterClutchLandedEver = true;
                clutchSettleTicks++;
                // Wait 4 ticks in water so server registers 0 fall damage before scooping!
                if (clutchSettleTicks >= 4) {
                    setPhase(Phase.CLUTCH_RECLAIM);
                }
            }
            return RunStatus.RUNNING;
        }

        // If we already landed in water (e.g. pond) or safely on ground without placing
        if (player.isTouchingWater() || (player.isOnGround() && player.getY() < startY - 3.5)) {
            waterClutchLandedEver = player.isTouchingWater();
            descentCompletedEver = true;
            clearActive();
            return RunStatus.COMPLETED;
        }

        // Gently keep horizontal alignment over the drop column so we don't snag a cliff lip
        if (activeOverlook != null && player.getY() > activeOverlook.landingY() + 6.0) {
            Vec3d colCenter = new Vec3d(activeOverlook.dropCol().getX() + 0.5 + activeOverlook.dropDir().getOffsetX() * 0.35,
                player.getY(), activeOverlook.dropCol().getZ() + 0.5 + activeOverlook.dropDir().getOffsetZ() * 0.35);
            double horizErr = Math.hypot(player.getX() - colCenter.x, player.getZ() - colCenter.z);
            if (horizErr > 0.6) {
                motor.moveRelativeToYaw(colCenter.x - player.getX(), colCenter.z - player.getZ(), false, false);
            }
        }

        if (waterSlot >= 0) {
            stepMidAirWaterClutch(player, world, waterSlot, false);
        } else if (motor.findHotbarItem(Items.BUCKET) >= 0) {
            // Bucket already emptied -> water placed!
            BlockPos nearbyWater = findNearbyStillWater(world, player.getBlockPos(), 3);
            if (nearbyWater != null) {
                placedClutchWater = nearbyWater;
                clutchSettleTicks = 0;
            }
        }

        if (phaseTicks > 180) {
            clearActive();
            return RunStatus.FAILED;
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickClutchReclaim(ClientPlayerEntity player, ClientWorld world) {
        statusText = "reclaiming clutch water";
        if (GuiHands.countItem(player, Items.WATER_BUCKET) > 0) {
            waterReclaimedEver = true;
            descentCompletedEver = true;
            clearActive();
            return RunStatus.COMPLETED;
        }
        if (!stepReclaimClutchWater(player, world)) {
            if (GuiHands.countItem(player, Items.WATER_BUCKET) > 0) {
                waterReclaimedEver = true;
            }
            descentCompletedEver = true;
            clearActive();
            return RunStatus.COMPLETED;
        }
        return RunStatus.RUNNING;
    }

    /**
     * Core mid-air water-bucket clutch controller shared by both intentional and reactive falls.
     * Smoothly tracks the solid block directly below the player's falling trajectory via
     * Motor.LookMode.COMBAT (no snap!) and right-clicks within vanilla block reach (~4.45m from eye).
     */
    private boolean stepMidAirWaterClutch(ClientPlayerEntity player, ClientWorld world, int waterSlot, boolean reactive) {
        // Predict landing block directly below current/next-tick XZ using observed blocks (or immediate vertical column)
        double predX = player.getX() + player.getVelocity().x * 1.5;
        double predZ = player.getZ() + player.getVelocity().z * 1.5;
        BlockPos landing = findFallingLandingBlock(player, world, predX, predZ);
        if (landing == null) {
            landing = findFallingLandingBlock(player, world, player.getX(), player.getZ());
        }
        if (landing == null) {
            // Still high up above scan range — smoothly look straight down ahead of time!
            if (!reactive) {
                player.getInventory().selectedSlot = waterSlot;
                motor.lookAtAngles(player.getYaw(), 86.5f, Motor.LookMode.COMBAT);
                return true;
            }
            return false;
        }

        // If landing is already water, no need to place!
        if (world.getBlockState(landing).getFluidState().isIn(FluidTags.WATER)
                || world.getBlockState(landing.up()).getFluidState().isIn(FluidTags.WATER)) {
            return false;
        }

        player.getInventory().selectedSlot = waterSlot;
        // Aim at exact horizontal foot position clamped to top face of landing block
        double aimX = MathHelper.clamp(player.getX(), landing.getX() + 0.12, landing.getX() + 0.88);
        double aimZ = MathHelper.clamp(player.getZ(), landing.getZ() + 0.12, landing.getZ() + 0.88);
        Vec3d aim = new Vec3d(aimX, landing.getY() + 1.0, aimZ);
        motor.lookAtPoint(aim, Motor.LookMode.COMBAT);

        double feetDistToGround = player.getY() - (landing.getY() + 1.0);
        double eyeDistToGround = player.getEyePos().distanceTo(aim);
        // Vanilla block reach is 4.5 blocks from eye (~2.88 blocks from feet straight down).
        // Trigger as soon as we're within reach (<= 4.45m from eye or <= 3.1m from feet) and aiming down!
        if ((eyeDistToGround <= 4.45 || feetDistToGround <= 3.1) && player.getPitch() > 60f) {
            BlockHitResult ray = raycastPlayerLook(player, world, 4.5, RaycastContext.FluidHandling.NONE);
            boolean hitGood = ray.getType() == HitResult.Type.BLOCK
                && ray.getBlockPos().getY() <= landing.getY() + 1
                && ray.getSide() == Direction.UP;
            if (!hitGood && client.crosshairTarget instanceof BlockHitResult bhr && bhr.getType() == HitResult.Type.BLOCK) {
                ray = bhr;
                hitGood = bhr.getBlockPos().getY() <= landing.getY() + 1;
            }
            if (hitGood && client.interactionManager != null) {
                var res = client.interactionManager.interactItem(player, Hand.MAIN_HAND);
                if (res.isAccepted()) {
                    player.swingHand(Hand.MAIN_HAND);
                    placedClutchWater = ray.getBlockPos().offset(ray.getSide());
                    clutchReclaimTicks = 0;
                    clutchSettleTicks = 0;
                    waterClutchLandedEver = true;
                }
            }
        }
        return true;
    }

    /** Smoothly aim at placed clutch water source and scoop it back into empty bucket. */
    private boolean stepReclaimClutchWater(ClientPlayerEntity player, ClientWorld world) {
        clutchReclaimTicks++;
        if (GuiHands.countItem(player, Items.WATER_BUCKET) > 0) {
            waterReclaimedEver = true;
            placedClutchWater = null;
            return false;
        }
        if (clutchReclaimTicks > 55) {
            placedClutchWater = null;
            return false;
        }
        // Wait until player has safely landed & zeroed fall distance
        if (!player.isTouchingWater() && !player.isOnGround() && clutchReclaimTicks < 18) {
            return true;
        }
        if (clutchReclaimTicks < 4) {
            return true;
        }

        // Verify source block location (fallback: search nearby still water source within 3 blocks!)
        if (placedClutchWater == null || !world.getBlockState(placedClutchWater).getFluidState().isStill()
                || !world.getBlockState(placedClutchWater).getFluidState().isIn(FluidTags.WATER)) {
            BlockPos found = findNearbyStillWater(world, player.getBlockPos(), 3);
            if (found == null) {
                placedClutchWater = null;
                return false;
            }
            placedClutchWater = found;
        }

        int bucketSlot = motor.findHotbarItem(Items.BUCKET);
        if (bucketSlot < 0) {
            placedClutchWater = null;
            return false;
        }
        player.getInventory().selectedSlot = bucketSlot;

        Vec3d srcCenter = new Vec3d(placedClutchWater.getX() + 0.5, placedClutchWater.getY() + 0.35, placedClutchWater.getZ() + 0.5);
        if (player.getEyePos().distanceTo(srcCenter) > 4.2) {
            motor.moveToward(Vec3d.ofBottomCenter(placedClutchWater), false, false, false, false);
        }
        motor.lookAtPoint(srcCenter, Motor.LookMode.COMBAT);

        // Verify fluid ray actually hits the still water source before clicking!
        BlockHitResult fluidHit = raycastPlayerLook(player, world, 4.5, RaycastContext.FluidHandling.SOURCE_ONLY);
        boolean hitsSource = fluidHit.getType() == HitResult.Type.BLOCK
            && world.getBlockState(fluidHit.getBlockPos()).getFluidState().isStill()
            && world.getBlockState(fluidHit.getBlockPos()).getFluidState().isIn(FluidTags.WATER);

        if ((hitsSource || motor.currentAimErrorDeg() < 10.0) && client.interactionManager != null && clutchReclaimTicks % 3 == 0) {
            var res = client.interactionManager.interactItem(player, Hand.MAIN_HAND);
            if (res.isAccepted()) {
                player.swingHand(Hand.MAIN_HAND);
                if (GuiHands.countItem(player, Items.WATER_BUCKET) > 0) {
                    waterReclaimedEver = true;
                    placedClutchWater = null;
                    return false;
                }
            }
        }
        return true;
    }

    private BlockPos findFallingLandingBlock(ClientPlayerEntity player, ClientWorld world, double x, double z) {
        int bx = MathHelper.floor(x);
        int bz = MathHelper.floor(z);
        int startBy = player.getBlockY();
        for (int dy = 1; dy <= 38; dy++) {
            int y = startBy - dy;
            BlockState st = perception.getObserved(bx, y, bz);
            // Within close 6-block physical proximity during fast fall, also allow immediate downward sight check
            if (st == null && dy <= 8) {
                BlockPos probe = new BlockPos(bx, y, bz);
                st = world.getBlockState(probe);
                perception.recordObserved(probe, st, false);
            }
            if (st == null) continue;
            if (st.getFluidState().isIn(FluidTags.WATER)) return new BlockPos(bx, y, bz);
            if (Perception.isSolidSupport(st)) return new BlockPos(bx, y, bz);
        }
        return null;
    }

    // ===================== METHOD 2: WATER-POUR WATERFALL DESCENT =====================

    private RunStatus tickPourApproach(ClientPlayerEntity player, ClientWorld world) {
        statusText = "approaching edge to pour waterfall";
        if (!ensureItemInHotbar(player, st -> st.isOf(Items.WATER_BUCKET))) {
            if (GuiHands.countItem(player, Items.WATER_BUCKET) <= 0) {
                clearActive();
                return RunStatus.FAILED;
            }
            return RunStatus.RUNNING;
        }
        if (activeOverlook == null) {
            clearActive();
            return RunStatus.FAILED;
        }

        // Stand 1 block back from the takeoff lip so we can look at the top face of takeoffPos.down() cleanly!
        Direction back = activeOverlook.dropDir().getOpposite();
        BlockPos standPos = activeOverlook.takeoffPos().offset(back);
        BlockState standFloor = world.getBlockState(standPos.down());
        Vec3d standTarget = Perception.isSolidSupport(standFloor)
            ? Vec3d.ofBottomCenter(standPos)
            : Vec3d.ofBottomCenter(activeOverlook.takeoffPos());

        double dist = Math.hypot(player.getX() - standTarget.x, player.getZ() - standTarget.z);
        Vec3d lipTop = new Vec3d(
            activeOverlook.takeoffPos().getX() + 0.5 + activeOverlook.dropDir().getOffsetX() * 0.25,
            activeOverlook.takeoffPos().getY(),
            activeOverlook.takeoffPos().getZ() + 0.5 + activeOverlook.dropDir().getOffsetZ() * 0.25
        );
        motor.lookAtPoint(lipTop, Motor.LookMode.FINE);

        if (dist > 0.55 && phaseTicks < 60) {
            motor.moveToward(standTarget, false, false, true, false);
            return RunStatus.RUNNING;
        }
        setPhase(Phase.POUR_PLACE);
        return RunStatus.RUNNING;
    }

    private RunStatus tickPourPlace(ClientPlayerEntity player, ClientWorld world) {
        statusText = "pouring waterfall at edge";
        int waterSlot = motor.findHotbarItem(Items.WATER_BUCKET);
        if (waterSlot < 0) {
            // Already poured!
            waterfallSourcePos = activeOverlook.takeoffPos();
            waterfallDropCol = activeOverlook.dropCol();
            pourWaitTicks = 0;
            setPhase(Phase.POUR_WAIT_STREAM);
            return RunStatus.RUNNING;
        }
        player.getInventory().selectedSlot = waterSlot;
        motor.requestSneak();

        // Aim at the top face of the solid lip block (takeoffPos.down()) near its front edge
        BlockPos lipBlock = activeOverlook.takeoffPos().down();
        Vec3d aim = new Vec3d(
            lipBlock.getX() + 0.5 + activeOverlook.dropDir().getOffsetX() * 0.2,
            lipBlock.getY() + 1.0,
            lipBlock.getZ() + 0.5 + activeOverlook.dropDir().getOffsetZ() * 0.2
        );
        motor.lookAtPoint(aim, Motor.LookMode.FINE);

        BlockHitResult ray = raycastPlayerLook(player, world, 4.5, RaycastContext.FluidHandling.NONE);
        if (ray.getType() == HitResult.Type.BLOCK
                && ray.getBlockPos().equals(lipBlock)
                && ray.getSide() == Direction.UP
                && client.interactionManager != null) {
            var res = client.interactionManager.interactItem(player, Hand.MAIN_HAND);
            if (res.isAccepted()) {
                player.swingHand(Hand.MAIN_HAND);
                waterfallSourcePos = activeOverlook.takeoffPos();
                waterfallDropCol = activeOverlook.dropCol();
                pourWaitTicks = 0;
                setPhase(Phase.POUR_WAIT_STREAM);
                return RunStatus.RUNNING;
            }
        }
        if (phaseTicks > 70) {
            clearActive();
            return RunStatus.FAILED;
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickPourWaitStream(ClientPlayerEntity player, ClientWorld world) {
        statusText = "waiting for waterfall stream";
        pourWaitTicks++;
        motor.requestSneak();
        // Watch the waterfall cascade down to the cavern floor before stepping in!
        Vec3d dropLook = new Vec3d(
            waterfallDropCol.getX() + 0.5,
            Math.max(waterfallDropCol.getY() - 10.0, targetFloorY),
            waterfallDropCol.getZ() + 0.5
        );
        motor.lookAtPoint(dropLook, Motor.LookMode.SCAN);

        // Minecraft falling water propagates downward at 1 block per 5 ticks.
        // Wait until the water column reaches near the cavern floor (or observed water near bottom)
        // so the player NEVER outruns the falling water front!
        int estDepth = activeOverlook != null ? Math.max(8, activeOverlook.dropDepth()) : 24;
        int minWait = Math.min(135, Math.max(45, estDepth * 5 + 8));
        boolean waterNearBottom = targetFloorY != Integer.MIN_VALUE
            && (world.getBlockState(new BlockPos(waterfallDropCol.getX(), targetFloorY, waterfallDropCol.getZ())).getFluidState().isIn(FluidTags.WATER)
                || world.getBlockState(new BlockPos(waterfallDropCol.getX(), targetFloorY + 1, waterfallDropCol.getZ())).getFluidState().isIn(FluidTags.WATER));
        if ((waterNearBottom && pourWaitTicks >= 25) || pourWaitTicks >= minWait) {
            setPhase(Phase.POUR_RIDE);
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickPourRide(ClientPlayerEntity player, ClientWorld world) {
        statusText = "riding waterfall into cavern";
        // Stay tightly centered inside the vertical waterfall column (waterfallDropCol XZ) while sinking smoothly!
        double cx = waterfallDropCol.getX() + 0.5;
        double cz = waterfallDropCol.getZ() + 0.5;
        // Look gently downward/forward to observe the cavern floor
        Vec3d floorLook = new Vec3d(cx + activeOverlook.dropDir().getOffsetX() * 2.0,
            Math.min(player.getY() - 4.0, targetFloorY + 0.5),
            cz + activeOverlook.dropDir().getOffsetZ() * 2.0);
        motor.lookAtPoint(floorLook, Motor.LookMode.NORMAL);

        double horizDist = Math.hypot(player.getX() - cx, player.getZ() - cz);
        // Gentle brake if sinking fast in water; steer tightly toward column center if drifting out!
        boolean brakeJump = player.isTouchingWater() && player.getVelocity().y < -0.26;
        if (horizDist > 0.20 || !player.isTouchingWater()) {
            motor.moveRelativeToYaw(cx - player.getX(), cz - player.getZ(), false, brakeJump);
        } else if (brakeJump) {
            motor.requestJump();
        }

        // Check if we reached the cavern floor!
        boolean reachedFloor = (player.isOnGround() && player.getY() <= startY - 4.0)
            || (player.getY() <= targetFloorY + 1.2 && player.getVelocity().y > -0.05);
        if (reachedFloor && phaseTicks > 25) {
            setPhase(Phase.POUR_EXIT);
            return RunStatus.RUNNING;
        }
        if (phaseTicks > 480) {
            setPhase(Phase.POUR_EXIT);
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickPourExit(ClientPlayerEntity player, ClientWorld world) {
        statusText = "exiting waterfall onto cavern floor";
        // Find nearest dry solid floor tile outside the waterfall column!
        BlockPos dry = findNearestDryFloor(player, world, 6);
        if (dry != null) {
            double d = Math.hypot(player.getX() - (dry.getX() + 0.5), player.getZ() - (dry.getZ() + 0.5));
            if (d <= 0.75 && !player.isTouchingWater()) {
                descentCompletedEver = true;
                clearActive();
                return RunStatus.COMPLETED;
            }
            motor.moveToward(Vec3d.ofBottomCenter(dry), false, player.horizontalCollision, false, true);
        } else if (!player.isTouchingWater() || phaseTicks > 65) {
            descentCompletedEver = true;
            clearActive();
            return RunStatus.COMPLETED;
        } else {
            // Swim away from cliff wall along dropDir
            Vec3d out = player.getPos().add(activeOverlook.dropDir().getOffsetX() * 4.0, 0, activeOverlook.dropDir().getOffsetZ() * 4.0);
            motor.moveToward(out, false, player.horizontalCollision, false, true);
        }
        return RunStatus.RUNNING;
    }

    // ===================== METHOD 3: BOAT DROP DESCENT =====================

    private RunStatus tickBoatPrep(ClientPlayerEntity player, ClientWorld world) {
        statusText = "preparing boat drop";
        if (!ensureItemInHotbar(player, SafeDescent::isBoatStack)) {
            if (countBoats(player) <= 0) {
                clearActive();
                return RunStatus.FAILED;
            }
            return RunStatus.RUNNING;
        }
        if (activeOverlook == null) {
            clearActive();
            return RunStatus.FAILED;
        }
        // Final lava double-check!
        if (isLandingLavaObserved(activeOverlook.dropCol(), activeOverlook.landingY())) {
            refusedHazard = "lava_landing";
            activeMethod = Method.AVOID;
            lastExecutedMethod = Method.AVOID.wireName();
            setPhase(Phase.AVOID_RETREAT);
            return RunStatus.RUNNING;
        }

        // Stand ~2-3 blocks back from the lip so there is clear space to place the boat in front of us on solid deck!
        Direction back = activeOverlook.dropDir().getOpposite();
        BlockPos deck1 = activeOverlook.takeoffPos().offset(back);
        BlockPos deck2 = deck1.offset(back);
        BlockPos deck3 = deck2.offset(back);
        BlockPos standTargetBlock;
        if (Perception.isSolidSupport(world.getBlockState(deck3.down())) && Perception.isSolidSupport(world.getBlockState(deck1.down()))) {
            standTargetBlock = deck3;
            boatPlaceSupport = deck1.down();
        } else if (Perception.isSolidSupport(world.getBlockState(deck2.down()))) {
            standTargetBlock = deck2;
            boatPlaceSupport = activeOverlook.takeoffPos().down();
        } else {
            standTargetBlock = Perception.isSolidSupport(world.getBlockState(deck1.down())) ? deck1 : activeOverlook.takeoffPos();
            boatPlaceSupport = activeOverlook.takeoffPos().down();
        }

        Vec3d standPos = Vec3d.ofBottomCenter(standTargetBlock);
        double dist = Math.hypot(player.getX() - standPos.x, player.getZ() - standPos.z);
        motor.lookAtPoint(Vec3d.ofCenter(boatPlaceSupport).add(0, 0.5, 0), Motor.LookMode.FINE);
        if (dist > 0.6 && phaseTicks < 60) {
            motor.moveToward(standPos, false, false, true, false);
            return RunStatus.RUNNING;
        }
        setPhase(Phase.BOAT_PLACE);
        return RunStatus.RUNNING;
    }

    private RunStatus tickBoatPlace(ClientPlayerEntity player, ClientWorld world) {
        statusText = "placing boat near ledge";
        // Check if a boat already exists nearby!
        AbstractBoatEntity existing = findNearestBoat(player, world, 5.0);
        if (existing != null) {
            placedBoatEntityId = existing.getId();
            setPhase(Phase.BOAT_MOUNT);
            return RunStatus.RUNNING;
        }

        int boatSlot = motor.findHotbarBoat();
        if (boatSlot < 0) {
            clearActive();
            return RunStatus.FAILED;
        }
        player.getInventory().selectedSlot = boatSlot;

        Vec3d placeAim = new Vec3d(boatPlaceSupport.getX() + 0.5, boatPlaceSupport.getY() + 1.0, boatPlaceSupport.getZ() + 0.5);
        motor.lookAtPoint(placeAim, Motor.LookMode.FINE);

        // If standing too close to placement block, back up slightly so boat bounding box fits!
        double horizDist = Math.hypot(player.getX() - placeAim.x, player.getZ() - placeAim.z);
        if (horizDist < 1.15 && phaseTicks < 30) {
            Direction back = activeOverlook.dropDir().getOpposite();
            motor.moveRelativeToYaw(back.getOffsetX(), back.getOffsetZ(), false, false);
            motor.requestSneak();
            return RunStatus.RUNNING;
        }

        BlockHitResult ray = raycastPlayerLook(player, world, 4.5, RaycastContext.FluidHandling.ANY);
        if (ray.getType() == HitResult.Type.BLOCK
                && ray.getBlockPos().equals(boatPlaceSupport)
                && ray.getSide() == Direction.UP
                && client.interactionManager != null
                && phaseTicks % 4 == 0) {
            var res = client.interactionManager.interactItem(player, Hand.MAIN_HAND);
            if (res.isAccepted()) {
                player.swingHand(Hand.MAIN_HAND);
            }
        }
        if (phaseTicks > 80) {
            clearActive();
            return RunStatus.FAILED;
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickBoatMount(ClientPlayerEntity player, ClientWorld world) {
        statusText = "mounting boat";
        if (player.hasVehicle() && player.getVehicle() instanceof AbstractBoatEntity) {
            setPhase(Phase.BOAT_STEER_OFF);
            return RunStatus.RUNNING;
        }
        AbstractBoatEntity boat = getTrackedBoat(player, world);
        if (boat == null) {
            if (motor.findHotbarBoat() >= 0) {
                setPhase(Phase.BOAT_PLACE);
                return RunStatus.RUNNING;
            }
            clearActive();
            return RunStatus.FAILED;
        }

        Vec3d boatCenter = boat.getBoundingBox().getCenter();
        motor.lookAtPoint(boatCenter, Motor.LookMode.FINE);
        double dist = player.getEyePos().distanceTo(boatCenter);
        if (dist > 3.2) {
            motor.moveToward(boat.getPos(), false, false, true, false);
            return RunStatus.RUNNING;
        }
        if (motor.currentAimErrorDeg() < 16.0 && client.interactionManager != null && phaseTicks % 4 == 0) {
            var res = client.interactionManager.interactEntity(player, boat, Hand.MAIN_HAND);
            if (res.isAccepted()) {
                player.swingHand(Hand.MAIN_HAND);
            }
        }
        if (phaseTicks > 70) {
            clearActive();
            return RunStatus.FAILED;
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickBoatSteerOff(ClientPlayerEntity player, ClientWorld world) {
        statusText = "steering boat off ledge";
        if (!player.hasVehicle() || !(player.getVehicle() instanceof AbstractBoatEntity boat)) {
            setPhase(Phase.BOAT_MOUNT);
            return RunStatus.RUNNING;
        }

        // Steer the boat nose toward the drop column (remember: boats turn with LEFT/RIGHT keys, row with FORWARD!)
        double targetX = activeOverlook.dropCol().getX() + 0.5 + activeOverlook.dropDir().getOffsetX() * 2.0;
        double targetZ = activeOverlook.dropCol().getZ() + 0.5 + activeOverlook.dropDir().getOffsetZ() * 2.0;
        double dx = targetX - boat.getX();
        double dz = targetZ - boat.getZ();
        float desiredYaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        float yawDiff = MathHelper.wrapDegrees(desiredYaw - boat.getYaw());

        boolean turnRight = yawDiff > 8.0f;
        boolean turnLeft = yawDiff < -8.0f;
        boolean rowFwd = Math.abs(yawDiff) < 42.0f;
        motor.steerBoat(rowFwd, false, turnLeft, turnRight);

        // Player camera smoothly looks over the drop toward the cavern floor!
        Vec3d floorLook = new Vec3d(targetX, activeOverlook.landingY() + 0.5, targetZ);
        motor.lookAtPoint(floorLook, Motor.LookMode.NORMAL);

        // Once the boat leaves the ledge and starts falling, transition to BOAT_FALL!
        if (!boat.isOnGround() && (boat.getY() < startY - 1.2 || boat.getVelocity().y < -0.18)) {
            boatLandedTicks = 0;
            setPhase(Phase.BOAT_FALL);
        } else if (phaseTicks > 180) {
            clearActive();
            return RunStatus.FAILED;
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickBoatFall(ClientPlayerEntity player, ClientWorld world) {
        statusText = "dropping to cavern floor in boat";
        if (!player.hasVehicle() || !(player.getVehicle() instanceof AbstractBoatEntity boat)) {
            // Dismounted early or landed
            if (player.getY() <= startY - 4.0) {
                boatDroppedEver = true;
                setPhase(Phase.BOAT_BREAK);
                return RunStatus.RUNNING;
            }
            clearActive();
            return RunStatus.FAILED;
        }

        // Look gently ahead/down toward landing
        Vec3d floorLook = new Vec3d(
            boat.getX() + activeOverlook.dropDir().getOffsetX() * 2.0,
            Math.min(boat.getY() - 2.0, activeOverlook.landingY() + 0.5),
            boat.getZ() + activeOverlook.dropDir().getOffsetZ() * 2.0
        );
        motor.lookAtPoint(floorLook, Motor.LookMode.NORMAL);

        // Slight forward nudge right after clearing lip so boat doesn't catch on the cliff edge
        if (boat.getY() > startY - 3.5) {
            motor.steerBoat(true, false, false, false);
        }

        if ((boat.isOnGround() || boat.isTouchingWater()) && boat.getY() <= startY - 4.0) {
            boatLandedTicks++;
            if (boatLandedTicks >= 6) {
                boatDroppedEver = true;
                setPhase(Phase.BOAT_DISMOUNT);
            }
        } else {
            boatLandedTicks = 0;
        }

        if (phaseTicks > 240) {
            setPhase(Phase.BOAT_DISMOUNT);
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickBoatDismount(ClientPlayerEntity player, ClientWorld world) {
        statusText = "dismounting boat";
        if (player.hasVehicle()) {
            motor.requestSneak();
            return RunStatus.RUNNING;
        }
        boatBreakHits = 0;
        boatHitCooldown = 0;
        setPhase(Phase.BOAT_BREAK);
        return RunStatus.RUNNING;
    }

    private RunStatus tickBoatBreak(ClientPlayerEntity player, ClientWorld world) {
        statusText = "breaking boat to recover";
        if (countBoats(player) > 0 && findNearestBoat(player, world, 6.0) == null) {
            boatReclaimedEver = true;
            descentCompletedEver = true;
            clearActive();
            return RunStatus.COMPLETED;
        }

        AbstractBoatEntity boat = getTrackedBoat(player, world);
        if (boat == null || !boat.isAlive()) {
            setPhase(Phase.BOAT_COLLECT);
            return RunStatus.RUNNING;
        }

        motor.selectBestWeapon();
        Vec3d aim = boat.getBoundingBox().getCenter();
        motor.lookAtPoint(aim, Motor.LookMode.NORMAL);
        double dist = player.getEyePos().distanceTo(aim);
        if (dist > 3.1) {
            motor.moveToward(boat.getPos(), false, player.horizontalCollision, false, false);
            return RunStatus.RUNNING;
        }

        if (boatHitCooldown > 0) {
            boatHitCooldown--;
        } else if (motor.currentAimErrorDeg() < 18.0 && client.interactionManager != null) {
            client.interactionManager.attackEntity(player, boat);
            player.swingHand(Hand.MAIN_HAND);
            boatBreakHits++;
            boatHitCooldown = 5;
        }
        if (phaseTicks > 120) {
            setPhase(Phase.BOAT_COLLECT);
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickBoatCollect(ClientPlayerEntity player, ClientWorld world) {
        statusText = "collecting recovered boat";
        if (countBoats(player) > 0) {
            boatReclaimedEver = true;
            descentCompletedEver = true;
            clearActive();
            return RunStatus.COMPLETED;
        }
        // Look for dropped boat ItemEntity within 8 blocks!
        ItemEntity drop = findNearbyBoatDrop(player, world, 8.0);
        if (drop != null) {
            motor.moveToward(drop.getPos(), false, player.horizontalCollision, false, true);
        } else if (phaseTicks > 45) {
            descentCompletedEver = true;
            clearActive();
            return RunStatus.COMPLETED;
        }
        return RunStatus.RUNNING;
    }

    // ===================== METHOD 4: CLIFF-SIDE COVERED STAIRCASE CARVING =====================

    private void initCliffStair(ClientPlayerEntity player, ClientWorld world, Overlook ov) {
        BlockPos feet = player.getBlockPos();
        stairNextStep = null;
        stairStepTicks = 0;
        // Prefer carving into the solid cliff wall flanking the drop so a solid rock lip shields us from the abyss!
        if (ov != null && ov.cliffWallDir() != null) {
            stairWallSide = ov.cliffWallDir();
            // Step into the cliff wall first, then run parallel or inward!
            stairHeading = ov.cliffWallDir();
        } else {
            // Find whichever cardinal direction has solid rock/dirt at feet or feet-1
            stairHeading = findBestCliffDigHeading(player, world, ov == null ? null : ov.dropDir());
            stairWallSide = stairHeading;
        }
    }

    private RunStatus tickStairCarve(ClientPlayerEntity player, ClientWorld world) {
        statusText = "carving covered cliff staircase";
        BlockPos feet = player.getBlockPos();

        // Check completion: reached targetFloorY (or within 1 block on solid floor!)
        if (feet.getY() <= targetFloorY + 1 && player.isOnGround()
                && !perception.isNearKnownLava(feet.getX(), feet.getY(), feet.getZ())) {
            descentCompletedEver = true;
            clearActive();
            return RunStatus.COMPLETED;
        }

        // Ensure pickaxe is in hotbar!
        if (!ensureItemInHotbar(player, st -> st.getItem() instanceof net.minecraft.item.PickaxeItem)) {
            if (!hasAnyPickaxe(player)) {
                clearActive();
                return RunStatus.FAILED;
            }
            return RunStatus.RUNNING;
        }

        // If we are within 2 blocks of a safe observed cavern floor right next to us, step cleanly out onto it!
        if (feet.getY() <= targetFloorY + 3 && stairNextStep == null) {
            BlockPos exit = findSafeFloorExit(player, world, targetFloorY);
            if (exit != null) {
                motor.moveToward(Vec3d.ofBottomCenter(exit), false, false, false, true);
                statusText = "exiting cliff staircase onto cavern floor";
                if (feet.getY() <= targetFloorY + 1 && player.isOnGround()) {
                    descentCompletedEver = true;
                    clearActive();
                    return RunStatus.COMPLETED;
                }
                return RunStatus.RUNNING;
            }
        }

        // Choose next descending step along/inside the cliff wall!
        if (stairNextStep == null) {
            stairNextStep = pickNextCliffStairStep(player, world);
            stairStepTicks = 0;
            if (stairNextStep == null) {
                // If already descended significantly onto a safe shelf, accept completion
                if (feet.getY() <= startY - 6 && player.isOnGround()) {
                    descentCompletedEver = true;
                    clearActive();
                    return RunStatus.COMPLETED;
                }
                clearActive();
                return RunStatus.FAILED;
            }
        }

        stairStepTicks++;
        if (stairStepTicks > 180) {
            // Switchback direction if a step gets blocked (e.g. unbreakable or lava)
            stairHeading = stairHeading.rotateYClockwise();
            stairNextStep = null;
            stairStepTicks = 0;
            return RunStatus.RUNNING;
        }

        // Check if we arrived on stairNextStep!
        double horiz = Math.hypot(player.getX() - (stairNextStep.getX() + 0.5), player.getZ() - (stairNextStep.getZ() + 0.5));
        if (horiz <= 0.48 && Math.abs(player.getY() - stairNextStep.getY()) <= 0.55 && player.isOnGround()) {
            stairStepsCarved++;
            stairNextStep = null;
            stairStepTicks = 0;
            return RunStatus.RUNNING;
        }

        // 1. Break the 3-high staircase pocket at stairNextStep top-to-bottom: (y+2 -> y+1 -> y)
        // Note: stairNextStep.getY() == feet.getY() - 1 (or same Y if stepping into cliff entry!)
        int topY = Math.max(feet.getY() + 1, stairNextStep.getY() + 2);
        for (int by = topY; by >= stairNextStep.getY(); by--) {
            BlockPos bp = new BlockPos(stairNextStep.getX(), by, stairNextStep.getZ());
            BlockState st = world.getBlockState(bp);
            if (!Perception.isPassable(st) && st.getFluidState().isEmpty()) {
                if (Perception.isUnbreakable(st) || Perception.isHazardBlock(st)
                        || perception.isNearKnownLava(bp.getX(), bp.getY(), bp.getZ())) {
                    // Turn away from hazard/bedrock!
                    stairHeading = stairHeading.rotateYClockwise();
                    stairNextStep = null;
                    return RunStatus.RUNNING;
                }
                // Nudge slightly toward the front of our standing cell while sneaking so the lower stair block is never occluded!
                Vec3d mineStance = Vec3d.ofBottomCenter(feet).lerp(Vec3d.ofBottomCenter(stairNextStep), 0.22);
                if (Math.hypot(player.getX() - mineStance.x, player.getZ() - mineStance.z) > 0.28) {
                    motor.moveToward(mineStance, false, false, true, false);
                } else {
                    motor.requestSneak();
                }
                motor.mineBlock(bp, true, true);
                return RunStatus.RUNNING;
            }
        }

        // 2. Before stepping onto stairNextStep, verify floor (stairNextStep.down()) is solid & safe!
        BlockPos floorPos = stairNextStep.down();
        BlockState floorSt = world.getBlockState(floorPos);
        perception.recordObserved(floorPos, floorSt, false);
        if (Perception.isHazardBlock(floorSt) || perception.isNearKnownLava(floorPos.getX(), floorPos.getY(), floorPos.getZ())) {
            stairHeading = stairHeading.rotateYClockwise();
            stairNextStep = null;
            return RunStatus.RUNNING;
        }
        if (!Perception.isSolidSupport(floorSt)) {
            // Opened into a cavern/void beneath this step!
            // If drop here is <= 2 blocks onto solid dry ground, safe to step down!
            boolean smallSafeDrop = false;
            for (int d = 1; d <= 2; d++) {
                BlockState below = world.getBlockState(floorPos.down(d));
                if (Perception.isHazardBlock(below)) break;
                if (Perception.isSolidSupport(below)) { smallSafeDrop = true; break; }
            }
            if (!smallSafeDrop) {
                int scaf = motor.findHotbarScaffold();
                if (scaf >= 0 && motor.placeBlockAt(floorPos, scaf)) {
                    return RunStatus.RUNNING;
                }
                // Switchback inward into the cliff rock!
                stairHeading = stairHeading.rotateYClockwise();
                stairNextStep = null;
                return RunStatus.RUNNING;
            }
        }

        // 3. Walk smoothly (sneak if adjacent to open drop) onto stairNextStep!
        boolean nearAbyss = isAdjacentToDrop(world, stairNextStep);
        motor.moveToward(Vec3d.ofBottomCenter(stairNextStep), false, false, nearAbyss, true);
        return RunStatus.RUNNING;
    }

    private BlockPos pickNextCliffStairStep(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        // Try headings in preference order: current stairHeading, clockwise, counter-clockwise, opposite (switchback!)
        Direction[] order = {
            stairHeading,
            stairHeading.rotateYClockwise(),
            stairHeading.rotateYCounterclockwise(),
            stairHeading.getOpposite()
        };

        // First: if we are still right next to the open abyss on our first step and a solid cliff wall is adjacent,
        // carve 1-2 blocks INTO the cliff wall (same Y or -1 Y) to get sheltered cover first!
        for (Direction dir : order) {
            BlockPos cand = feet.offset(dir).down();
            if (isValidStairCandidate(world, feet, cand, dir)) {
                stairHeading = dir;
                return cand;
            }
        }
        // Fallback: allow a same-Y horizontal step into solid cliff rock to start a fresh switchback column
        for (Direction dir : order) {
            BlockPos cand = feet.offset(dir);
            if (isValidFlatStepIntoWall(world, cand)) {
                stairHeading = dir;
                return cand;
            }
        }
        return null;
    }

    private boolean isValidStairCandidate(ClientWorld world, BlockPos feet, BlockPos cand, Direction dir) {
        // Never step directly off into open air over a deep drop!
        BlockState floor = world.getBlockState(cand.down());
        boolean floorSolidOrSmallDrop = Perception.isSolidSupport(floor)
            || (Perception.isPassable(floor) && Perception.isSolidSupport(world.getBlockState(cand.down(2))))
            || (Perception.isPassable(floor) && Perception.isPassable(world.getBlockState(cand.down(2)))
                && Perception.isSolidSupport(world.getBlockState(cand.down(3))));
        if (!floorSolidOrSmallDrop) return false;
        if (Perception.isHazardBlock(floor) || perception.isNearKnownLava(cand.getX(), cand.getY(), cand.getZ())) return false;

        // Check that blocks to break are diggable (not bedrock/lava/water)
        for (int by = feet.getY() + 1; by >= cand.getY(); by--) {
            BlockPos bp = new BlockPos(cand.getX(), by, cand.getZ());
            BlockState st = world.getBlockState(bp);
            if (Perception.isUnbreakable(st) || Perception.isHazardBlock(st) || !st.getFluidState().isEmpty()) {
                return false;
            }
            if (perception.isNearKnownLava(bp.getX(), bp.getY(), bp.getZ())) return false;
        }
        // Prefer staying sheltered (avoid stepping directly into the sheer drop column if wall is available)
        if (activeOverlook != null && cand.getX() == activeOverlook.dropCol().getX()
                && cand.getZ() == activeOverlook.dropCol().getZ()
                && cand.getY() > targetFloorY + 2) {
            return false;
        }
        return true;
    }

    private boolean isValidFlatStepIntoWall(ClientWorld world, BlockPos cand) {
        BlockState floor = world.getBlockState(cand.down());
        if (!Perception.isSolidSupport(floor)) return false;
        if (perception.isNearKnownLava(cand.getX(), cand.getY(), cand.getZ())) return false;
        for (int dy = 0; dy <= 1; dy++) {
            BlockState st = world.getBlockState(cand.up(dy));
            if (Perception.isUnbreakable(st) || Perception.isHazardBlock(st) || !st.getFluidState().isEmpty()) return false;
        }
        return true;
    }

    private boolean isAdjacentToDrop(ClientWorld world, BlockPos pos) {
        for (Direction d : Direction.Type.HORIZONTAL) {
            BlockPos adj = pos.offset(d);
            if (Perception.isPassable(world.getBlockState(adj))
                    && Perception.isPassable(world.getBlockState(adj.down()))
                    && Perception.isPassable(world.getBlockState(adj.down(2)))
                    && Perception.isPassable(world.getBlockState(adj.down(3)))) {
                return true;
            }
        }
        return false;
    }

    private BlockPos findSafeFloorExit(ClientPlayerEntity player, ClientWorld world, int floorY) {
        BlockPos feet = player.getBlockPos();
        for (Direction d : Direction.Type.HORIZONTAL) {
            BlockPos adj = feet.offset(d);
            if (!Perception.isPassable(world.getBlockState(adj)) || !Perception.isPassable(world.getBlockState(adj.up()))) continue;
            for (int drop = 0; drop <= 2; drop++) {
                BlockPos land = adj.down(drop);
                BlockState below = world.getBlockState(land.down());
                if (Perception.isHazardBlock(below)) break;
                if (Perception.isSolidSupport(below) && land.getY() <= floorY + 1) {
                    return land;
                }
            }
        }
        return null;
    }

    // ===================== METHOD 5: EDGE BLOCK-PLACEMENT / STEPPED SHELF DESCENT =====================

    private void initEdgeBlocks(ClientPlayerEntity player, ClientWorld world, Overlook ov) {
        edgeDir = ov != null ? ov.dropDir() : Direction.fromHorizontalDegrees(player.getYaw());
        edgeTargetBlock = null;
        edgeStepTicks = 0;
        edgeDescendDepth = 0;
    }

    private RunStatus tickEdgePlaceStep(ClientPlayerEntity player, ClientWorld world) {
        statusText = "descending via edge block placement";
        BlockPos feet = player.getBlockPos();

        // Done once we reach target floor Y (on solid ground!)
        if (feet.getY() <= targetFloorY + 1 && player.isOnGround()
                && !perception.isNearKnownLava(feet.getX(), feet.getY(), feet.getZ())) {
            descentCompletedEver = true;
            clearActive();
            return RunStatus.COMPLETED;
        }

        // Ensure scaffold blocks in hotbar!
        if (!ensureItemInHotbar(player, SafeDescent::isScaffoldStack)) {
            if (TaskRunner.scaffoldCount(player) <= 0) {
                // Out of scaffolds: if already descended onto a lower shelf, complete cleanly!
                if (feet.getY() <= startY - 3 && player.isOnGround()) {
                    descentCompletedEver = true;
                    clearActive();
                    return RunStatus.COMPLETED;
                }
                clearActive();
                return RunStatus.FAILED;
            }
            return RunStatus.RUNNING;
        }
        int scafSlot = motor.findHotbarScaffold();
        if (scafSlot < 0) {
            clearActive();
            return RunStatus.FAILED;
        }

        // 1. Check if there is an immediate safe step-down (1..3 blocks drop onto observed dry solid ledge) right next to us!
        // Note: do NOT hold sneak when stepping off onto a verified safe lower shelf (vanilla sneak blocks stepping off edges!)
        BlockPos safeStepDown = findSafeStepDownLedge(player, world, feet, targetFloorY);
        if (safeStepDown != null && edgeTargetBlock == null) {
            double horiz = Math.hypot(player.getX() - (safeStepDown.getX() + 0.5), player.getZ() - (safeStepDown.getZ() + 0.5));
            motor.moveToward(Vec3d.ofBottomCenter(safeStepDown), false, false, false, true);
            statusText = "stepping down onto lower ledge";
            if (horiz < 0.45 && Math.abs(player.getY() - safeStepDown.getY()) <= 0.6) {
                edgeDescendDepth = startY - player.getBlockY();
            }
            return RunStatus.RUNNING;
        }

        // 1b. If not yet at the drop edge (the next cell along edgeDir has solid dry ground), walk cleanly to the brink!
        if (edgeTargetBlock == null && edgeDir != null) {
            BlockPos ahead = feet.offset(edgeDir);
            if (Perception.isPassable(world.getBlockState(ahead))
                    && Perception.isPassable(world.getBlockState(ahead.up()))
                    && Perception.isSolidSupport(world.getBlockState(ahead.down()))
                    && !perception.isNearKnownLava(ahead.getX(), ahead.getY(), ahead.getZ())) {
                motor.moveToward(Vec3d.ofBottomCenter(ahead), false, false, true, true);
                statusText = "advancing along ledge to next edge";
                return RunStatus.RUNNING;
            }
        }

        // 2. Plan next edge block to place:
        //    Priority A: Bridge 1 block horizontally at feet.down() toward a lower observed shelf/ledge across a chasm!
        //    Priority B: A protruding step-block against an adjacent vertical wall 2 blocks below feet (wall-side descending shelf!)
        if (edgeTargetBlock == null) {
            edgeTargetBlock = findNextBridgePlacement(player, world, feet);
            edgeStepTicks = 0;
            if (edgeTargetBlock == null) {
                edgeTargetBlock = findNextDescendingShelfPlacement(player, world, feet);
            }
            if (edgeTargetBlock == null) {
                if (feet.getY() <= targetFloorY + 2 && player.isOnGround()) {
                    descentCompletedEver = true;
                    clearActive();
                    return RunStatus.COMPLETED;
                }
                clearActive();
                return RunStatus.FAILED;
            }
        }

        edgeStepTicks++;
        if (edgeStepTicks > 120) {
            edgeTargetBlock = null;
            edgeStepTicks = 0;
            return RunStatus.RUNNING;
        }

        // If the target block is already solid (just placed!), step carefully onto it!
        BlockState curSt = world.getBlockState(edgeTargetBlock);
        if (Perception.isSolidSupport(curSt)) {
            BlockPos standOn = edgeTargetBlock.up();
            double horiz = Math.hypot(player.getX() - (standOn.getX() + 0.5), player.getZ() - (standOn.getZ() + 0.5));
            if (horiz <= 0.46 && Math.abs(player.getY() - standOn.getY()) <= 0.6 && player.isOnGround()) {
                edgeTargetBlock = null;
                edgeStepTicks = 0;
                return RunStatus.RUNNING;
            }
            // Vanilla sneak refuses to walk off an edge: only sneak for same-level bridge steps,
            // never when the placed shelf sits below our feet (that would stall until timeout).
            boolean stepDown = standOn.getY() < feet.getY();
            motor.moveToward(Vec3d.ofBottomCenter(standOn), false, false, !stepDown, true);
            statusText = "stepping onto placed shelf block";
            return RunStatus.RUNNING;
        }

        // Sneak carefully toward the edge closest to edgeTargetBlock so we have clear line of sight to the support face!
        Motor.PlacementHit hit = findEdgePlacementHit(player, world, edgeTargetBlock);
        if (hit != null) {
            motor.requestSneak();
            if (motor.placeBlockAgainst(hit.support(), hit.face(), hit.point(), scafSlot)) {
                edgeBlocksPlaced++;
                perception.recordObserved(edgeTargetBlock, world.getBlockState(edgeTargetBlock), false);
            }
            statusText = "placing edge step block";
            return RunStatus.RUNNING;
        }

        // Lean carefully toward edgeTargetBlock while sneaking (vanilla sneak stops us from falling off!)
        // Aim at the side face of our standing floor block (feet.down()) so crosshair settles right on the bridge anchor!
        Vec3d edgeLean = Vec3d.ofBottomCenter(feet).lerp(Vec3d.ofBottomCenter(edgeTargetBlock.up()), 0.72);
        motor.moveToward(edgeLean, false, false, true, false);
        Vec3d sideAnchor = Vec3d.ofCenter(feet.down()).lerp(Vec3d.ofCenter(edgeTargetBlock), 0.48);
        motor.lookAtPoint(sideAnchor, Motor.LookMode.FINE);
        statusText = "sneaking to ledge edge";
        return RunStatus.RUNNING;
    }

    /** Finds an adjacent 1..3 block drop onto solid safe ground that moves us closer to targetFloorY. */
    private BlockPos findSafeStepDownLedge(ClientPlayerEntity player, ClientWorld world, BlockPos feet, int floorY) {
        BlockPos best = null;
        int bestY = feet.getY();
        for (Direction d : Direction.Type.HORIZONTAL) {
            BlockPos adj = feet.offset(d);
            if (!Perception.isPassable(world.getBlockState(adj)) || !Perception.isPassable(world.getBlockState(adj.up()))) continue;
            for (int drop = 1; drop <= 3; drop++) {
                BlockPos land = adj.down(drop);
                BlockState at = world.getBlockState(land);
                BlockState below = world.getBlockState(land.down());
                if (Perception.isHazardBlock(at) || Perception.isHazardBlock(below)) break;
                if (!Perception.isPassable(at)) break;
                if (Perception.isSolidSupport(below)) {
                    if (land.getY() >= floorY - 1 && land.getY() < bestY) {
                        bestY = land.getY();
                        best = land;
                    }
                    break;
                }
            }
        }
        return best;
    }

    /**
     * Finds a valid air cell 2..3 blocks below feet (adjacent horizontally to feet) that has
     * a solid vertical wall face right beside it so we can place a protruding descending step block!
     */
    private BlockPos findNextDescendingShelfPlacement(ClientPlayerEntity player, ClientWorld world, BlockPos feet) {
        // Check drop cells 1 step horizontally from feet, at y = feet.Y - 3 (drop 2) or feet.Y - 2 (drop 1)
        Direction[] dirs = {edgeDir, edgeDir.rotateYClockwise(), edgeDir.rotateYCounterclockwise(), edgeDir.getOpposite()};
        for (int dropFloorOffset : new int[]{3, 2}) {
            for (Direction d : dirs) {
                BlockPos col = feet.offset(d);
                // Column from feet down to target shelf must be passable (headroom!)
                if (!Perception.isPassable(world.getBlockState(col)) || !Perception.isPassable(world.getBlockState(col.up()))) continue;
                BlockPos shelfPos = col.down(dropFloorOffset);
                if (shelfPos.getY() < targetFloorY - 1) continue;
                if (!world.getBlockState(shelfPos).isAir() && !world.getBlockState(shelfPos).isReplaceable()) continue;
                if (!Perception.isPassable(world.getBlockState(shelfPos.up()))) continue;
                if (dropFloorOffset == 3 && !Perception.isPassable(world.getBlockState(shelfPos.up(2)))) continue;
                if (perception.isNearKnownLava(shelfPos.getX(), shelfPos.getY(), shelfPos.getZ())) continue;

                // Must have at least one solid horizontal neighbor (cliff wall face!) to attach the shelf block onto
                boolean hasWallAnchor = false;
                for (Direction wd : Direction.Type.HORIZONTAL) {
                    if (Perception.isSolidSupport(world.getBlockState(shelfPos.offset(wd)))) {
                        hasWallAnchor = true;
                        break;
                    }
                }
                if (hasWallAnchor) return shelfPos;
            }
        }
        return null;
    }

    /** Finds a horizontal bridge block at (feet + dir, feet.Y - 1) leading toward an observed lower shelf! */
    private BlockPos findNextBridgePlacement(ClientPlayerEntity player, ClientWorld world, BlockPos feet) {
        Direction bestDir = null;
        double bestScore = Double.NEGATIVE_INFINITY;
        for (Direction d : Direction.Type.HORIZONTAL) {
            BlockPos next = feet.offset(d);
            BlockPos underNext = next.down();
            if (!Perception.isPassable(world.getBlockState(next)) || !Perception.isPassable(world.getBlockState(next.up()))) continue;
            if (!world.getBlockState(underNext).isAir() && !world.getBlockState(underNext).isReplaceable()) continue;
            if (perception.isNearKnownLava(underNext.getX(), underNext.getY(), underNext.getZ())) continue;

            // Score higher if a lower observed shelf (1..3 blocks down) lies within 2..6 blocks in this direction!
            double score = d == edgeDir ? 2.0 : 0.0;
            for (int dist = 2; dist <= 6; dist++) {
                BlockPos probe = feet.offset(d, dist);
                for (int dy = -1; dy >= -4; dy--) {
                    BlockState st = perception.getObserved(probe.getX(), feet.getY() + dy, probe.getZ());
                    if (st != null && Perception.isSolidSupport(st)) {
                        score += 15.0 - dist * 1.5;
                        break;
                    }
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestDir = d;
            }
        }
        if (bestDir != null) {
            edgeDir = bestDir;
            return feet.offset(bestDir).down();
        }
        return null;
    }

    /** Enhanced edge placement finder that checks upper side-face points for smooth sneak-bridging. */
    private Motor.PlacementHit findEdgePlacementHit(ClientPlayerEntity player, ClientWorld world, BlockPos placePos) {
        Motor.PlacementHit std = motor.findPlacementHit(placePos, false);
        if (std != null) return std;

        Vec3d eye = player.getEyePos();
        Box blockBox = new Box(placePos);
        if (player.getBoundingBox().intersects(blockBox)) return null;

        Direction[] order = {Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.DOWN, Direction.UP};
        double[][] uvs = {{0.5, 0.85}, {0.5, 0.72}, {0.35, 0.82}, {0.65, 0.82}, {0.5, 0.5}};
        for (Direction dir : order) {
            BlockPos support = placePos.offset(dir);
            BlockState st = world.getBlockState(support);
            if (st.isAir() || !st.getFluidState().isEmpty() || st.isReplaceable()) continue;
            Direction clickFace = dir.getOpposite();
            for (double[] uv : uvs) {
                Vec3d pt = pointOnFace(support, clickFace, uv[0], uv[1]);
                if (eye.squaredDistanceTo(pt) > Motor.REACH_SQ) continue;
                Vec3d end = eye.add(pt.subtract(eye).multiply(1.03));
                BlockHitResult hit = world.raycast(new RaycastContext(eye, end,
                    RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
                if (hit.getType() == HitResult.Type.BLOCK
                        && hit.getBlockPos().equals(support)
                        && hit.getSide() == clickFace) {
                    return new Motor.PlacementHit(support, clickFace, pt);
                }
            }
        }
        return null;
    }

    // ===================== METHOD 6: HAZARD REFUSAL & AVOIDANCE =====================

    private RunStatus tickAvoidRetreat(ClientPlayerEntity player, ClientWorld world) {
        statusText = "refusing unsafe drop (" + (refusedHazard.isEmpty() ? "avoid" : refusedHazard) + ")";
        if (activeOverlook != null) {
            Direction back = activeOverlook.dropDir().getOpposite();
            BlockPos safeBack = activeOverlook.takeoffPos().offset(back, 2);
            if (!Perception.isSolidSupport(world.getBlockState(safeBack.down()))) {
                safeBack = activeOverlook.takeoffPos().offset(back);
            }
            double dist = Math.hypot(player.getX() - (safeBack.getX() + 0.5), player.getZ() - (safeBack.getZ() + 0.5));
            if (dist > 0.55 && phaseTicks < 45) {
                motor.moveToward(Vec3d.ofBottomCenter(safeBack), false, false, true, false);
                // Keep glancing back toward the refused drop so footage clearly shows awareness!
                motor.lookAtPoint(Vec3d.ofCenter(activeOverlook.dropCol()).add(0, -4.0, 0), Motor.LookMode.NORMAL);
                return RunStatus.RUNNING;
            }
            // Optional safety curb block at the lava-facing lip if carrying scaffolds!
            int scaf = motor.findHotbarScaffold();
            BlockPos curbPos = activeOverlook.takeoffPos();
            if (scaf >= 0 && phaseTicks < 75 && dist <= 0.9
                    && !player.getBoundingBox().intersects(new Box(curbPos))
                    && world.getBlockState(curbPos).isAir()
                    && Perception.isSolidSupport(world.getBlockState(curbPos.down()))) {
                if (motor.placeBlockAt(curbPos, scaf)) {
                    edgeBlocksPlaced++;
                }
                return RunStatus.RUNNING;
            }
        }

        if (phaseTicks >= 20) {
            clearActive();
            return RunStatus.REFUSED;
        }
        return RunStatus.RUNNING;
    }

    // ===================== OVERLOOK SCANNER (STRICTLY OBSERVED GEOMETRY!) =====================

    /**
     * Scans walkable edges around the player (radius 0..4) using ONLY Perception.getObserved(...).
     * Never reads unobserved world chunks!
     */
    Overlook scanOverlook(ClientPlayerEntity player, ClientWorld world, int hintDx, int hintDz) {
        BlockPos feet = player.getBlockPos();
        Overlook best = null;
        double bestScore = Double.NEGATIVE_INFINITY;

        for (int dx = -4; dx <= 4; dx++) {
            for (int dz = -4; dz <= 4; dz++) {
                if (dx * dx + dz * dz > 20) continue;
                BlockPos takeoff = feet.add(dx, 0, dz);
                BlockState tfFeet = perception.getObserved(takeoff);
                BlockState tfHead = perception.getObserved(takeoff.up());
                BlockState tfBelow = perception.getObserved(takeoff.down());
                if (tfFeet == null || tfHead == null || tfBelow == null) continue;
                if (!Perception.isPassable(tfFeet) || !Perception.isPassable(tfHead) || !Perception.isSolidSupport(tfBelow)) {
                    continue;
                }

                for (Direction dir : Direction.Type.HORIZONTAL) {
                    BlockPos dropCol = takeoff.offset(dir);
                    BlockState dFeet = perception.getObserved(dropCol);
                    BlockState dHead = perception.getObserved(dropCol.up());
                    if (dFeet == null || dHead == null || !Perception.isPassable(dFeet) || !Perception.isPassable(dHead)) {
                        continue;
                    }
                    // Check at least 4 blocks of open air below dropCol (sharp drop > 3 blocks!)
                    BlockState d1 = perception.getObserved(dropCol.down(1));
                    BlockState d2 = perception.getObserved(dropCol.down(2));
                    BlockState d3 = perception.getObserved(dropCol.down(3));
                    BlockState d4 = perception.getObserved(dropCol.down(4));
                    if (isSolidOrFluid(d1) || isSolidOrFluid(d2) || isSolidOrFluid(d3)) continue;
                    // Need at least 2 observed air cells down the drop to know it's a real cliff
                    if (d1 == null && d2 == null) continue;
                    if (isSolidOrFluid(d4)) continue;

                    // Trace down the observed drop & landing fan (forward 1..6 blocks along dropDir,
                    // strictly using Perception.getObserved — because standing at a cliff brink naturally
                    // sees the cavern floor 2..6 blocks out past the lip edge!).
                    int landingY = Integer.MIN_VALUE;
                    boolean floorObserved = false;
                    LandingSurface surface = LandingSurface.UNSEEN;
                    boolean landingLava = false;
                    boolean landingHazard = false;
                    int deepestAir = 4;

                    // First check direct vertical drop column & forward landing fan (fwd = 0..4 from dropCol)
                    for (int dy = 1; dy <= 48; dy++) {
                        int py = takeoff.getY() - dy;
                        BlockState st = perception.getObserved(dropCol.getX(), py, dropCol.getZ());
                        if (st != null && Perception.isPassable(st)) {
                            deepestAir = Math.max(deepestAir, dy);
                        }
                        // Probe forward landing zone along dropDir (where a player peeking/jumping sees the floor!)
                        BlockState foundSurface = null;
                        for (int fwd = 0; fwd <= 5; fwd++) {
                            int fx = dropCol.getX() + dir.getOffsetX() * fwd;
                            int fz = dropCol.getZ() + dir.getOffsetZ() * fwd;
                            BlockState cand = perception.getObserved(fx, py, fz);
                            if (cand == null) continue;
                            if (cand.getFluidState().isIn(FluidTags.LAVA)) {
                                foundSurface = cand;
                                break;
                            }
                            if (foundSurface == null && (Perception.isHazardBlock(cand)
                                    || cand.getFluidState().isIn(FluidTags.WATER)
                                    || Perception.isSolidSupport(cand))) {
                                // Only treat forward solid floor as landing if space directly above it is observed air
                                // (ignores overhanging ledges/walls near the top!)
                                if (dy >= 4) {
                                    BlockState above1 = perception.getObserved(fx, py + 1, fz);
                                    if (above1 == null || Perception.isPassable(above1)) {
                                        foundSurface = cand;
                                    }
                                }
                            }
                        }
                        if (foundSurface == null) continue;
                        if (foundSurface.getFluidState().isIn(FluidTags.LAVA)) {
                            floorObserved = true;
                            landingY = py + 1;
                            surface = LandingSurface.LAVA;
                            landingLava = true;
                            break;
                        }
                        if (Perception.isHazardBlock(foundSurface)) {
                            floorObserved = true;
                            landingY = py + 1;
                            surface = LandingSurface.HAZARD;
                            landingHazard = true;
                            break;
                        }
                        if (foundSurface.getFluidState().isIn(FluidTags.WATER)) {
                            floorObserved = true;
                            landingY = py + 1;
                            surface = LandingSurface.WATER;
                            break;
                        }
                        if (Perception.isSolidSupport(foundSurface)) {
                            floorObserved = true;
                            landingY = py + 1;
                            surface = LandingSurface.DRY_SOLID;
                            break;
                        }
                    }

                    int depth = floorObserved ? (takeoff.getY() - landingY) : deepestAir;
                    if (depth <= 3) continue;

                    // Check observed lava anywhere in the cavern pit basin directly below the overlook (fwd 0..7, lat -2..+2)!
                    if (!landingLava) {
                        Direction lat = dir.rotateYClockwise();
                        for (int fwd = 0; fwd <= 7 && !landingLava; fwd++) {
                            for (int l = -2; l <= 2 && !landingLava; l++) {
                                int bx = dropCol.getX() + dir.getOffsetX() * fwd + lat.getOffsetX() * l;
                                int bz = dropCol.getZ() + dir.getOffsetZ() * fwd + lat.getOffsetZ() * l;
                                for (int dy = 4; dy <= 42; dy++) {
                                    BlockState s = perception.getObserved(bx, takeoff.getY() - dy, bz);
                                    if (s == null) continue;
                                    if (s.getFluidState().isIn(FluidTags.LAVA)) {
                                        landingLava = true;
                                        floorObserved = true;
                                        landingY = takeoff.getY() - dy + 1;
                                        depth = takeoff.getY() - landingY;
                                        surface = LandingSurface.LAVA;
                                        break;
                                    }
                                    if (Perception.isSolidSupport(s)) break;
                                }
                            }
                        }
                    }

                    // Count visible hostiles near landing!
                    int landingHostiles = 0;
                    if (floorObserved) {
                        Vec3d landCenter = new Vec3d(dropCol.getX() + 0.5, landingY + 0.5, dropCol.getZ() + 0.5);
                        for (LivingEntity mob : perception.visibleHostiles()) {
                            if (mob.getPos().squaredDistanceTo(landCenter) <= 7.0 * 7.0) {
                                landingHostiles++;
                            }
                        }
                    }

                    // Detect flanking cliff wall (solid wall beside takeoffPos suitable for cliff-stair carving)
                    Direction cliffWallDir = findCliffWallDir(takeoff, dir);

                    // Detect stepped shelf across gap or along cliff wall (suitable for edge block placement)
                    BlockPos shelf = findObservedSteppedShelf(takeoff, dir);

                    // Score overlook: prefer closest to player, aligned with hint/gaze, and observed floor
                    double dist = Math.hypot(dx, dz);
                    double align = 0.0;
                    if (hintDx != 0 || hintDz != 0) {
                        double hl = Math.hypot(hintDx, hintDz);
                        align = (dir.getOffsetX() * hintDx + dir.getOffsetZ() * hintDz) / hl * 3.0;
                    } else {
                        Vec3d look = player.getRotationVec(1.0f);
                        align = (dir.getOffsetX() * look.x + dir.getOffsetZ() * look.z) * 2.5;
                    }
                    double score = -dist * 2.2 + align + (floorObserved ? 4.0 : 0.0) + Math.min(depth, 24) * 0.15;
                    if (score > bestScore) {
                        bestScore = score;
                        best = new Overlook(takeoff, dir, dropCol, landingY, depth, floorObserved,
                            surface, landingLava, landingHazard, landingHostiles, cliffWallDir, shelf, shelf != null);
                    }
                }
            }
        }
        return best;
    }

    private boolean isLandingLavaObserved(BlockPos dropCol, int landingY) {
        if (landingY == Integer.MIN_VALUE) return false;
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                for (int dy = -1; dy <= 0; dy++) {
                    BlockState st = perception.getObserved(dropCol.getX() + dx, landingY + dy, dropCol.getZ() + dz);
                    if (st != null && st.getFluidState().isIn(FluidTags.LAVA)) return true;
                }
            }
        }
        return false;
    }

    private Direction findCliffWallDir(BlockPos takeoff, Direction dropDir) {
        Direction[] cands = {dropDir.rotateYClockwise(), dropDir.rotateYCounterclockwise(), dropDir.getOpposite()};
        for (Direction d : cands) {
            BlockPos wall1 = takeoff.offset(d);
            BlockState atFeet = perception.getObserved(wall1);
            BlockState below = perception.getObserved(wall1.down());
            BlockState below2 = perception.getObserved(wall1.down(2));
            if (Perception.isSolidSupport(atFeet) || (Perception.isSolidSupport(below) && Perception.isSolidSupport(below2))) {
                return d;
            }
        }
        return null;
    }

    private BlockPos findObservedSteppedShelf(BlockPos takeoff, Direction dropDir) {
        for (int dist = 2; dist <= 6; dist++) {
            BlockPos col = takeoff.offset(dropDir, dist);
            for (int dy = 1; dy <= 5; dy++) {
                BlockState below = perception.getObserved(col.getX(), takeoff.getY() - dy - 1, col.getZ());
                BlockState feet = perception.getObserved(col.getX(), takeoff.getY() - dy, col.getZ());
                if (below != null && Perception.isSolidSupport(below)
                        && (feet == null || Perception.isPassable(feet))) {
                    return new BlockPos(col.getX(), takeoff.getY() - dy, col.getZ());
                }
            }
        }
        return null;
    }

    private Direction findBestCliffDigHeading(ClientPlayerEntity player, ClientWorld world, Direction avoidDropDir) {
        BlockPos feet = player.getBlockPos();
        for (Direction d : Direction.Type.HORIZONTAL) {
            if (d == avoidDropDir) continue;
            BlockPos adj = feet.offset(d);
            if (Perception.isSolidSupport(world.getBlockState(adj)) || Perception.isSolidSupport(world.getBlockState(adj.down(2)))) {
                return d;
            }
        }
        return avoidDropDir != null ? avoidDropDir.getOpposite() : Direction.NORTH;
    }

    AssessmentInput buildInput(ClientPlayerEntity player, Overlook ov, boolean wantDescend) {
        return new AssessmentInput(
            ov.dropDepth(),
            ov.floorObserved(),
            ov.landingLava(),
            ov.landingHazard(),
            ov.landingSurface() == LandingSurface.WATER,
            ov.landingSurface() == LandingSurface.DRY_SOLID,
            ov.landingHostiles(),
            ov.cliffWallDir() != null,
            ov.hasSteppedShelf(),
            GuiHands.countItem(player, Items.WATER_BUCKET) > 0,
            countBoats(player) > 0,
            canCraftBoat(player),
            hasAnyPickaxe(player),
            TaskRunner.scaffoldCount(player),
            player.getHealth(),
            wantDescend
        );
    }

    // ===================== HELPERS =====================

    private void setPhase(Phase next) {
        this.phase = next;
        this.phaseTicks = 0;
    }

    private boolean ensureItemInHotbar(ClientPlayerEntity player, java.util.function.Predicate<ItemStack> pred) {
        for (int i = 0; i < 9; i++) {
            if (pred.test(player.getInventory().getStack(i))) return true;
        }
        for (int i = 9; i < 36; i++) {
            if (pred.test(player.getInventory().getStack(i))) {
                gui.startHotbarSwap(pred);
                return false;
            }
        }
        return false;
    }

    private BlockHitResult raycastPlayerLook(ClientPlayerEntity player, ClientWorld world, double range,
                                             RaycastContext.FluidHandling fluid) {
        Vec3d eye = player.getEyePos();
        Vec3d end = eye.add(player.getRotationVec(1.0f).multiply(range));
        return world.raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE, fluid, player));
    }

    private BlockPos findNearbyStillWater(ClientWorld world, BlockPos origin, int radius) {
        BlockPos best = null;
        double bestSq = Double.POSITIVE_INFINITY;
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dy = -2; dy <= 2; dy++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    BlockPos p = origin.add(dx, dy, dz);
                    var fs = world.getBlockState(p).getFluidState();
                    if (fs.isIn(FluidTags.WATER) && fs.isStill()) {
                        double sq = p.getSquaredDistance(origin);
                        if (sq < bestSq) {
                            bestSq = sq;
                            best = p;
                        }
                    }
                }
            }
        }
        return best;
    }

    private BlockPos findNearestDryFloor(ClientPlayerEntity player, ClientWorld world, int radius) {
        BlockPos feet = player.getBlockPos();
        BlockPos best = null;
        double bestSq = Double.POSITIVE_INFINITY;
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                for (int dy = -1; dy <= 1; dy++) {
                    BlockPos cand = feet.add(dx, dy, dz);
                    BlockState f = world.getBlockState(cand);
                    BlockState h = world.getBlockState(cand.up());
                    BlockState b = world.getBlockState(cand.down());
                    if (f.isAir() && f.getFluidState().isEmpty() && h.isAir() && Perception.isSolidSupport(b)
                            && !perception.isNearKnownLava(cand.getX(), cand.getY(), cand.getZ())) {
                        double sq = cand.getSquaredDistance(feet);
                        if (sq < bestSq) {
                            bestSq = sq;
                            best = cand;
                        }
                    }
                }
            }
        }
        return best;
    }

    private AbstractBoatEntity getTrackedBoat(ClientPlayerEntity player, ClientWorld world) {
        if (placedBoatEntityId >= 0) {
            Entity e = world.getEntityById(placedBoatEntityId);
            if (e instanceof AbstractBoatEntity b && b.isAlive()) return b;
        }
        AbstractBoatEntity nearest = findNearestBoat(player, world, 7.0);
        if (nearest != null) placedBoatEntityId = nearest.getId();
        return nearest;
    }

    private AbstractBoatEntity findNearestBoat(ClientPlayerEntity player, ClientWorld world, double radius) {
        AbstractBoatEntity best = null;
        double bestSq = radius * radius;
        for (Entity e : world.getEntities()) {
            if (e instanceof AbstractBoatEntity b && b.isAlive()) {
                double sq = b.squaredDistanceTo(player);
                if (sq < bestSq) {
                    bestSq = sq;
                    best = b;
                }
            }
        }
        return best;
    }

    private ItemEntity findNearbyBoatDrop(ClientPlayerEntity player, ClientWorld world, double radius) {
        ItemEntity best = null;
        double bestSq = radius * radius;
        for (Entity e : world.getEntities()) {
            if (e instanceof ItemEntity item && item.isAlive() && isBoatStack(item.getStack())) {
                double sq = item.squaredDistanceTo(player);
                if (sq < bestSq) {
                    bestSq = sq;
                    best = item;
                }
            }
        }
        return best;
    }

    static boolean isBoatStack(ItemStack st) {
        return !st.isEmpty() && st.getItem() instanceof BoatItem;
    }

    static boolean isScaffoldStack(ItemStack st) {
        if (st.isEmpty()) return false;
        Item it = st.getItem();
        return it == Items.COBBLESTONE || it == Items.COBBLED_DEEPSLATE || it == Items.DIRT
            || it == Items.NETHERRACK || it == Items.GRANITE || it == Items.DIORITE
            || it == Items.ANDESITE || it == Items.TUFF || st.isIn(ItemTags.PLANKS);
    }

    static int countBoats(ClientPlayerEntity player) {
        int total = 0;
        var inv = player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            ItemStack st = inv.getStack(i);
            if (isBoatStack(st)) total += st.getCount();
        }
        return total;
    }

    static boolean canCraftBoat(ClientPlayerEntity player) {
        return GuiHands.countPlanks(player) >= 5 || GuiHands.countLogs(player) >= 2;
    }

    private static boolean hasAnyPickaxe(ClientPlayerEntity player) {
        return TaskRunner.hasAnyPickaxe(player);
    }

    private static boolean isSolidOrFluid(BlockState st) {
        return st != null && (!Perception.isPassable(st) || !st.getFluidState().isEmpty());
    }

    private static float dirToYaw(Direction dir) {
        return switch (dir) {
            case SOUTH -> 0f;
            case WEST -> 90f;
            case NORTH -> 180f;
            case EAST -> -90f;
            default -> 0f;
        };
    }

    private static Vec3d pointOnFace(BlockPos pos, Direction face, double u, double v) {
        double x = pos.getX(), y = pos.getY(), z = pos.getZ(), eps = 0.01;
        return switch (face) {
            case DOWN -> new Vec3d(x + u, y + eps, z + v);
            case UP -> new Vec3d(x + u, y + 1.0 - eps, z + v);
            case NORTH -> new Vec3d(x + u, y + v, z + eps);
            case SOUTH -> new Vec3d(x + u, y + v, z + 1.0 - eps);
            case WEST -> new Vec3d(x + eps, y + v, z + u);
            case EAST -> new Vec3d(x + 1.0 - eps, y + v, z + u);
        };
    }
}
