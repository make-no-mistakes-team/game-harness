package io.gameharness.survival;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.function.Supplier;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.LeavesBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.FallingBlockEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.TypeFilter;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** Measures actual progress; recovery is a bounded normal-input controller, not a new route planner. */
final class AgentStallGuard {
    private static final int IDLE_TICKS = 150;
    private static final int MINING_TICKS = 235;
    private static final int FURNACE_TICKS = 245;
    private static final int FURNACE_UPDATE_TICKS = 30;
    private static final int INCIDENT_TICKS = 650;
    private static final int DRY_FOOTING_TICKS = 110;
    private static final int PROBE_TICKS = 46;
    private static final int RETRY_TICKS = 145;
    private static final int HANDBACK_TICKS = 230;
    private static final int MINE_RETRY_GRACE_TICKS = 120;
    private static final int ORDINARY_SETUP_TICKS = 75;
    private static final int ANGLE_WINDOW = 64;
    private static final int SPIN_TICKS = 96;
    private static final float RECOVERY_TURN_LIMIT = 250;
    private static final int HISTORY = 64;
    private static final int FLAT_RETURN_AGE = 200;
    private static final int MAX_CUTS = 2;
    private static final int STEP_TICKS = 85;
    private static final int STEP_SETTLE_TICKS = 40;
    private static final int BLOCKED_RECHECK_TICKS = 43; // Stagger the rendered sampler's four interleaved phases.
    private static final int CHANGED_SUPPORT_TICKS = 3;
    private static final int ALTERNATIVE_TICKS = 210;
    private static final int DEPARTURE_LENGTH = 3;
    private static final int DEPARTURE_LOOK_TICKS = 40;
    private static final int DEPARTURE_DRIVE_TICKS = 62;
    private static final int DEPARTURE_VIEWS = 2;
    private static final float DEPARTURE_PITCH = 33;
    private static final int PASSAGE_TICKS = 145;
    private static final int PASSAGE_BREAK_SETTLE_TICKS = 8;
    private static final int MAX_PASSAGES = 2;
    private static final TypeFilter<Entity, FallingBlockEntity> FALLING_ENTITIES =
        TypeFilter.instanceOf(FallingBlockEntity.class);
    private static final Predicate<BlockState> DRY_DANGER = AgentBody::dryCaveDanger;
    private static final double STEP_CENTER = 0.14;
    private static final double STEP_CLEARANCE = 3.08; // 1.25-block jump plus 1.8-block standing height and margin.
    private static final Predicate<ItemStack> TORCH = s -> s.isOf(Items.TORCH);
    private static final Predicate<ItemStack> STEP = s -> s.isOf(Items.COBBLESTONE) || s.isOf(Items.COBBLED_DEEPSLATE)
        || s.isOf(Items.DIRT);

    private enum Phase { WATCH, PENDING, WATER, SCOUT, BACKTRACK, WALK, LIGHT, CUT, STEP, SETTLE, RETRY,
                         ASSESS, DEPART, PASSAGE, ALTERNATIVE, BLOCKED }
    private enum StepStage { CENTER, HEADROOM, SUPPORT, TORCH_BYPASS, JUMP, LAND }
    private enum PassageStage { HEAD, LEGS, LANDING }
    enum Alternative { WORKING, ADVANCED, ADVANCED_BUT_HELD, REPLAN, REFUSED }

    record Report(int incidents, int attempts, int recoveries, int failures, String phase, String detail,
                  long eventSequence, int incidentTick) {}

    // A vanilla-foot-contact receipt on the exact level segment, not a terrain lookup at a remembered coordinate.
    private record FlatCrossing(BlockPos previous, BlockPos next, Vec3d previousFoot, Vec3d crossing, int tick) {}

    /** Keep recently spent exits across handbacks; a changed camera angle is not a changed lane. */
    static final class Departures {
        private record Lane(BlockPos from, BlockPos to) {}
        private final Lane[] refused = new Lane[HISTORY];
        private final BlockPos[] stood = new BlockPos[HISTORY];
        private final BlockPos[] surveyed = new BlockPos[HISTORY];
        private int refusals, contacts, surveys;

        boolean canCross(BlockPos from, BlockPos to) {
            for (Lane lane : refused) if (lane != null && lane.from().equals(from) && lane.to().equals(to)) return false;
            return true;
        }

        void reject(BlockPos from, BlockPos to) {
            if ((neighbor(from, to) || from.up().equals(to)) && canCross(from, to))
                refused[refusals++ % refused.length] = new Lane(from.toImmutable(), to.toImmutable());
        }

        void changed(BlockPos block) {
            for (int i = 0; i < refused.length; i++) {
                Lane lane = refused[i];
                if (lane != null && (inClearanceColumn(block, lane.from()) || inClearanceColumn(block, lane.to())))
                    refused[i] = null;
            }
        }

        private static boolean inClearanceColumn(BlockPos block, BlockPos foot) {
            return block.getX() == foot.getX() && block.getZ() == foot.getZ()
                && block.getY() >= foot.getY() - 1 && block.getY() <= foot.getY() + 2;
        }

        boolean newLanding(BlockPos foot) { return !contains(stood, foot); }

        boolean canRise(BlockPos from, BlockPos to) {
            return to.getY() == from.getY() + 1 && neighbor(from, to)
                && newLanding(to) && canCross(from, to);
        }

        AgentSurfaceTread riseTread(AgentBody.OrdinaryGrade grade, long tick) {
            if (grade == null || grade.lookOnly() || !canRise(grade.from(), grade.to())) return null;
            return AgentSurfaceTread.ordinaryGrade(grade.edge(), grade.from(), tick);
        }

        void stoodOn(BlockPos foot) {
            if (newLanding(foot)) stood[contacts++ % stood.length] = foot.toImmutable();
        }

        boolean beginSurvey(BlockPos foot) {
            if (contains(surveyed, foot)) return false;
            surveyed[surveys++ % surveyed.length] = foot.toImmutable();
            return true;
        }

        void revisit(BlockPos foot) {
            for (int i = 0; i < surveyed.length; i++) if (foot.equals(surveyed[i])) surveyed[i] = null;
        }

        void resetSurveys() {
            Arrays.fill(surveyed, null);
            surveys = 0;
        }

        void clear() {
            Arrays.fill(refused, null);
            Arrays.fill(stood, null);
            refusals = contacts = 0;
            resetSurveys();
        }
    }

    private final MinecraftClient client;
    private final AgentBody body;
    private final AgentHands hands;
    private final AgentTools tools;
    private final AgentWaterEscape water;
    private final Predicate<BlockPos> protectedBlock;
    private final Predicate<BlockHitResult> safeSupport;
    private final Consumer<BlockPos> reached;
    private final Function<BlockPos, String> mineHandback;
    private final BlockPos[] walked = new BlockPos[HISTORY];
    private final FlatCrossing[] flatCrossings = new FlatCrossing[HISTORY];
    private final BlockPos[] footprints = new BlockPos[HISTORY];
    private final BlockPos[] navigationFootings = new BlockPos[HISTORY];
    private final BlockPos[] breakHistory = new BlockPos[24];
    private final BlockPos[] stairLights = new BlockPos[16];
    private final BlockPos[] route = new BlockPos[4];
    private final Departures departures = new Departures();
    private final BlockPos[] departurePath = new BlockPos[DEPARTURE_LENGTH];
    private final BlockState[] departureSupports = new BlockState[DEPARTURE_LENGTH];
    private final Vec3d[] travelCredits = new Vec3d[16];
    private final float[] yawWindow = new float[ANGLE_WINDOW];
    private final byte[] reversalsWindow = new byte[ANGLE_WINDOW];
    private final Set<BlockPos> triedStances = new HashSet<>();
    private final Set<BlockPos> rejectedStances = new HashSet<>();
    private final Set<BlockPos> triedCuts = new HashSet<>();
    private final Set<BlockPos> triedPassages = new HashSet<>();
    private final ArrayList<FallingBlockEntity> passageFalling = new ArrayList<>(1);
    private final Set<BlockPos> drivenStances = new HashSet<>();
    private final Set<BlockPos> assessedSupports = new HashSet<>();
    private final int[] inventory = new int[Registries.ITEM.size()];
    private final int[] inventorySample = new int[inventory.length];
    private final Item[] sampledItems = new Item[PlayerInventory.OFF_HAND_SLOT + 1];
    private int[] itemIds = new int[sampledItems.length];
    private int[] sampledIds = new int[sampledItems.length];
    private int itemKinds;
    private ClientWorld world;
    private Phase phase = Phase.WATCH;
    private Report report = new Report(0, 0, 0, 0, "watch", "", 0, 0);
    private int incidents, attempts, recoveries, failures, tick, incidentTick, entered, lastUseful;
    private int walkedCount, footprintCount, creditCount, brokenCount, novelCells, movedCells;
    private int stairLightCount, retryRouteCells;
    private int navigationFootCount;
    private int frameBlocks, meals, mineSince, lastCrackTick, crackStage, furnaceSince, furnaceSeen;
    private int cookInput, cookOutput;
    private long eventSequence, craftSequence, surveySequence, settledSurvey, retrySurvey;
    private long navigationSurvey, settledNavigationSurvey;
    private BlockPos lastGround, mining, incidentFrom;
    private BlockPos navigationLowCeiling;
    private BlockPos lowCeilingFoot;
    private FurnaceScreen cooking;
    private Vec3d anchor, confirmedFoot, priorGroundFeet;
    private int flatCrossingCount, priorGroundAge, confirmedFootAge;
    private FlatCrossing returningOnContact;
    private float cookProgress, previousYaw, yawTravel, yawNet, recoveryYaw, glanceYaw, driveYaw;
    private int sampledAngles, previousTurn, reversals, glanceSince;
    private boolean inventoryKnown, dark, lampTried, stepTried, backtrackTried, tookControl, priorityAim;
    private boolean cookBurning, cooked;
    private boolean glanceTried, glancing, explicitRefusal;
    private boolean waterBlockedReported, emergencyWater;
    private int waterAttempts;
    private boolean mineHandedBack;
    private boolean workBroke, resourceBroke, stairLit, surfaceStep;
    private boolean navigationTurn, navigationRetry, navigationArrival;
    private BlockPos from, to, cut;
    private Vec3d cutAim;
    private Direction bearing;
    private int proof, probeSince, driveSince, routeLength, routeIndex, cutCount, itemBefore;
    private boolean cutFinished;
    private StepStage stepStage;
    private int stepSince;
    private float stepHealth;
    private Block stepBlock;
    private BlockState stepBase;
    private Vec3d stepAim;
    private BlockPos settlingSupport;
    private int settlingAge;
    private boolean settledSupport;
    private int alternativeCheckAt;
    private String blockedReason;
    private BlockPos observedQuietSupport;
    private int observedQuietAge, quietTicks;
    private Vec3d lastAssessedFeet;
    private BlockPos departureFrom, surveyFoot;
    private Direction departureBearing, surveyBearing;
    private AgentBody.OrdinaryGrade surveyRise, departureRise;
    private AgentSurfaceTread departureTread;
    private int departureLength, surveySector, surveySince, surveyViews, ordinarySetupUntil;
    private int passageCues, passageSince, passageBreakAt;
    private Direction passageBearing;
    private BlockPos passageFrom, passageTo, passageCut;
    private Box passageOpening;
    private PassageStage passageStage;
    private boolean passageBroke;
    private long surveyFrame, passageBreakFrame;
    private boolean replanOnAssessment, safeIdle;

    AgentStallGuard(MinecraftClient client, AgentBody body, AgentHands hands, AgentTools tools,
                    Predicate<BlockPos> protectedBlock, Predicate<BlockHitResult> safeSupport,
                    Consumer<BlockPos> reached, Function<BlockPos, String> mineHandback) {
        this.client = client;
        this.body = body;
        this.hands = hands;
        this.tools = tools;
        this.protectedBlock = protectedBlock;
        this.safeSupport = safeSupport;
        this.reached = reached;
        this.mineHandback = mineHandback;
        water = new AgentWaterEscape(client, body, hands, protectedBlock, safeSupport);
    }

    Report report() { return report; }
    String status() {
        return phase == Phase.BLOCKED || phase == Phase.WATER || report.detail().startsWith("water recovery:")
            ? report.detail() : "stall recovery: " + report.detail();
    }
    boolean ownsRecovery() { return phase != Phase.WATCH && phase != Phase.RETRY; }
    boolean exhaustedDryRecovery() { return phase == Phase.BLOCKED && safeIdle; }
    boolean retryingDistinctWork() { return phase == Phase.RETRY && blockedReason != null; }
    boolean waitingForEvidence() { return phase == Phase.BLOCKED || phase == Phase.ASSESS
        || phase == Phase.WATER && water.blocked(); }
    boolean triedStallRoute(BlockPos from, BlockPos cell) {
        return drivenStances.contains(cell) || !departures.newLanding(cell) || !departures.canCross(from, cell);
    }
    boolean refusedCrossing(BlockPos from, BlockPos to) { return !departures.canCross(from, to); }
    void refuseCrossing(BlockPos from, BlockPos to) {
        if (from.equals(client.player.getBlockPos()) && safeDryContact()) departures.reject(from, to);
    }

    /** A newly witnessed approach or real equipment selection gets effort, not a progress receipt. */
    void ordinarySetup() {
        if (phase == Phase.WATCH && ordinarySetupUntil == 0)
            ordinarySetupUntil = tick + ORDINARY_SETUP_TICKS;
    }

    boolean caveSurveyStalled(boolean mineRetryLease) {
        return phase == Phase.PENDING && !tookControl && !explicitRefusal
            || phase == Phase.RETRY && !retryWindowOpen(tick - entered, blockedReason != null, mineRetryLease);
    }

    /** The miner physically returned to an old shaft and witnessed a different mineable branch. */
    void mineBranchReady(BlockPos standing) {
        if (!dryGround() || !standing.equals(client.player.getBlockPos())) return;
        markUseful(client.player.getPos());
        if (phase == Phase.WATCH) return;
        recoveries++;
        transition(Phase.WATCH, "returned to witnessed shaft footing with a different descending branch");
    }

    /** Give the next mine start a regular work window, without crediting ore or a recovery result. */
    void mineResited() {
        markUseful(client.player.getPos());
        if (phase != Phase.WATCH) transition(Phase.WATCH, "left the exhausted mine area on checked footing");
    }

    void mineDepartureRefused(String reason) {
        if (phase == Phase.WATCH) skillBlocked(reason);
        else {
            blockedReason = reason;
            assessAgain(reason);
        }
    }

    /** A previously walked cell may offer a different approach, but charge each actual support only once per incident. */
    boolean takeChangedFooting() {
        if (quietTicks < CHANGED_SUPPORT_TICKS || observedQuietSupport == null
                || !observedQuietSupport.equals(quietSupport())) return false;
        Vec3d feet = client.player.getPos();
        if (lastAssessedFeet != null && feet.squaredDistanceTo(lastAssessedFeet) < 0.49
                || !assessedSupports.add(observedQuietSupport)) return false;
        lastAssessedFeet = feet;
        return true;
    }

    /** Caller owns deduplication: only newly camera-validated proof cells advance the sequence. */
    void surveyReceipt(long sequence) {
        if (sequence > surveySequence) surveySequence = sequence;
    }

    /** Dry route proofs can keep work live but do not establish that recovery succeeded. */
    void navigationSurveyReceipt(long sequence) {
        if (sequence > navigationSurvey) navigationSurvey = sequence;
    }

    void navigationWork() {
        navigationTurn = true;
        if (phase == Phase.RETRY) navigationRetry = true;
    }

    /** A physically reached new dry footing ends a stall; it records neither a return edge nor ore. */
    void navigationArrival(BlockPos from, BlockPos foot) {
        if (!dryGround() || !foot.equals(client.player.getBlockPos()) || contains(navigationFootings, foot)) return;
        if (!contains(navigationFootings, from))
            navigationFootings[navigationFootCount++ % navigationFootings.length] = from;
        navigationFootings[navigationFootCount++ % navigationFootings.length] = foot;
        navigationArrival = true;
    }

    /** Credit new ordinary stair lighting, not torch presses or recovery's own actions. */
    void stairLightReceipt(BlockPos position) {
        if (phase != Phase.WATCH && (phase != Phase.PENDING || tookControl)
                || contains(stairLights, position)) return;
        stairLights[stairLightCount++ % stairLights.length] = position;
        stairLit = true;
    }

    /** A settled waypoint on an ordinary return or resume, never recovery's driven steps. */
    void followedMineWaypoint() {
        if (phase == Phase.RETRY) retryRouteCells++;
    }

    /** A new surface landing, reached after its support and clearance were witnessed. */
    void reachedNewSurfaceFooting(BlockPos position) {
        if ((phase == Phase.WATCH || phase == Phase.PENDING && !tookControl)
                && dryGround() && position.equals(client.player.getBlockPos())) surfaceStep = true;
    }

    /** Existing vanilla client player break receipt, not an attack request or an air-block guess. */
    void broken(BlockPos position, BlockState state) {
        water.broken(position, state);
        departures.changed(position);
        if (lowCeilingFoot != null && (position.equals(lowCeilingFoot.up(2)) || position.equals(lowCeilingFoot.up(3))))
            lowCeilingFoot = null;
        if ((phase == Phase.ASSESS || phase == Phase.BLOCKED) && surveyFoot != null
                && position.getSquaredDistance(surveyFoot) <= 16) {
            departures.revisit(surveyFoot);
            surveyFoot = null;
            alternativeCheckAt = tick;
        }
        if (lastGround != null && inFootColumn(position, lastGround)) confirmedFoot = null;
        for (int i = 0; i < flatCrossings.length; i++) {
            FlatCrossing crossing = flatCrossings[i];
            if (crossing == null || !inFootColumn(position, crossing.previous())
                    && !inFootColumn(position, crossing.next())) continue;
            flatCrossings[i] = null;
            if (phase == Phase.WALK && returningOnContact == crossing) rejectWalk();
        }
        if (phase == Phase.CUT && position.equals(cut)) {
            cutFinished = true;
            return;
        }
        if (phase == Phase.PASSAGE && position.equals(passageCut)) {
            passageBroke = true;
            passageBreakAt = tick;
            passageBreakFrame = body.renderedFrame();
            return;
        }
        if (phase != Phase.WATCH && phase != Phase.RETRY && (phase != Phase.PENDING || tookControl)
                || contains(breakHistory, position)) return;
        breakHistory[brokenCount++ % breakHistory.length] = position.toImmutable();
        workBroke = true;
        resourceBroke |= state.isIn(BlockTags.LOGS) || state.isIn(BlockTags.IRON_ORES)
            || state.isIn(BlockTags.COAL_ORES) || state.isIn(BlockTags.DIAMOND_ORES) || state.isOf(Blocks.OBSIDIAN);
    }

    /** A bound vanilla screen supplies the burn and recipe evidence; opening it alone proves neither. */
    void furnaceState(int now, FurnaceScreen screen, boolean burning, float fraction, int input, int output) {
        if (cooking != screen) {
            cooking = screen;
            furnaceSince = now;
            furnaceSeen = burning && fraction > 0 ? now : 0;
            cookProgress = fraction;
            cookInput = input;
            cookOutput = output;
        } else if (input < cookInput && output > cookOutput) {
            // A new result and consumed input prove one genuine wrap; a falling bar alone does not.
            cooked = true;
            furnaceSince = now;
            furnaceSeen = burning ? now : 0;
            cookProgress = fraction;
            cookInput = input;
            cookOutput = output;
        } else {
            // Slot updates can arrive separately, so retain the previous pair until both agree.
            cookInput = Math.max(cookInput, input);
            cookOutput = Math.min(cookOutput, output);
            if (!burning || !cookBurning) {
                furnaceSince = now;
                furnaceSeen = burning && fraction > 0 ? now : 0;
                cookProgress = fraction;
            } else if (fraction > cookProgress) {
                furnaceSeen = now;
                cookProgress = fraction;
            }
        }
        cookBurning = burning;
    }

    void stopCooking() {
        cooking = null;
        cookBurning = false;
    }

    boolean furnaceAdvancing(int now) {
        return cookBurning && cooking != null && client.currentScreen == cooking
            && client.player.currentScreenHandler == cooking.getScreenHandler()
            && cooking.getScreenHandler().isBurning() && now - furnaceSince <= FURNACE_TICKS
            && now - (furnaceSeen == 0 ? furnaceSince : furnaceSeen) <= FURNACE_UPDATE_TICKS;
    }

    void observe(int now, int confirmedFrameBlocks, int confirmedMeals, String activity, boolean navigationLease,
                 boolean bootstrapTimber) {
        tick = now;
        if (world != client.world) resetWorld();
        water.observe();
        var player = client.player;
        sampleAngles(player.getYaw());
        Vec3d feet = player.getPos();
        if (phase == Phase.STEP) {
            if (player.getHealth() < stepHealth) interruptStep("took damage during the temporary step");
            else {
                stepHealth = player.getHealth();
                checkStepPose(player.getBlockPos(), feet);
            }
        }
        if (phase == Phase.SETTLE) observeStepSettlement();
        boolean grounded = dryGround();
        if (grounded && phase != Phase.SETTLE) {
            BlockPos cell = player.getBlockPos();
            if (!cell.equals(lastGround)) {
                if (lastGround != null && priorGroundFeet != null && confirmedFoot != null
                        && player.age == priorGroundAge + 1
                        && player.age - confirmedFootAge <= 32
                        && cell.getY() == lastGround.getY() && neighbor(lastGround, cell)
                        && Math.abs(feet.y - cell.getY()) < 0.04
                        && feet.squaredDistanceTo(priorGroundFeet) < 0.20
                        && sidewaysDistance(confirmedFoot, feet, lastGround.getX() == cell.getX()) <= 0.22) {
                    flatCrossings[flatCrossingCount++ % HISTORY] = new FlatCrossing(lastGround, cell.toImmutable(),
                        confirmedFoot, feet, tick);
                }
                lastGround = cell.toImmutable();
                confirmedFoot = null;
                walked[walkedCount++ % HISTORY] = lastGround;
                movedCells++;
                if (!contains(footprints, cell)) {
                    footprints[footprintCount++ % HISTORY] = lastGround;
                    novelCells++;
                }
            }
            if ((phase == Phase.DEPART || phase == Phase.RETRY && blockedReason != null) && standingOn(cell))
                departures.stoodOn(cell);
            if (Math.abs(feet.y - cell.getY()) < 0.04 && centerMargin(feet, cell) >= 0.24 && standingOn(cell)) {
                confirmedFoot = feet;
                confirmedFootAge = player.age;
            }
            priorGroundFeet = feet;
            priorGroundAge = player.age;
        } else {
            priorGroundFeet = confirmedFoot = null;
        }
        if (blockedReason != null) {
            BlockPos support = quietSupport();
            if (support == null) quietTicks = 0;
            else if (support.equals(observedQuietSupport) && player.age == observedQuietAge + 1)
                quietTicks = Math.min(CHANGED_SUPPORT_TICKS, quietTicks + 1);
            else quietTicks = 1;
            observedQuietSupport = support;
            observedQuietAge = player.age;
        }
        // Blocked work has no task inputs to verify. Safety still updates the actual pose above.
        if (phase == Phase.BLOCKED) return;
        var receipt = hands.lastCraftReceipt();
        long sequence = receipt == null ? 0 : receipt.sequence();
        boolean crafted = sequence != craftSequence;
        craftSequence = sequence;
        boolean framed = confirmedFrameBlocks > frameBlocks;
        frameBlocks = confirmedFrameBlocks;
        boolean fed = confirmedMeals > meals;
        meals = confirmedMeals;
        boolean surveyed = surveySequence > settledSurvey || navigationSurvey > settledNavigationSurvey;
        settledSurvey = surveySequence;
        settledNavigationSurvey = navigationSurvey;
        boolean normal = phase == Phase.WATCH;
        boolean navigation = navigationTurn || phase == Phase.RETRY && navigationRetry;
        int gain = inventoryGain(navigation && !normal, bootstrapTimber);
        double distance = feet.squaredDistanceTo(anchor);
        boolean newTravel = grounded && novelCells >= 2 && distance >= 4.0;
        boolean knownTravel = grounded && movedCells >= 4 && distance >= 25.0 && awayFromCredits(feet);
        double wetDx = feet.x - anchor.x, wetDz = feet.z - anchor.z;
        boolean wetTravel = (player.isTouchingWater() || player.hasVehicle())
            && wetDx * wetDx + wetDz * wetDz >= 16.0 && awayFromCredits(feet);
        boolean effect = workBroke || crafted || framed || fed || surveyed || stairLit || surfaceStep || cooked || gain != 0;
        boolean settledWork = navigationArrival || crafted || framed || cooked || resourceBroke;
        if ((normal || phase == Phase.PENDING && !tookControl && !explicitRefusal)
                && (navigation && !normal ? settledWork || gain == 2
                    : settledWork || effect || newTravel || knownTravel || wetTravel)) {
            if (knownTravel || wetTravel) travelCredits[creditCount++ % travelCredits.length] = feet;
            markUseful(feet);
            if (!normal) transition(Phase.WATCH, "ordinary play advanced before recovery took control");
        } else if (phase == Phase.RETRY) {
            // Cuts can keep the miner working, but only settled work or a real departure recovers the incident.
            boolean sustained = tick - entered >= 45 && grounded && movedCells >= 3 && novelCells >= 2
                && distance >= 10.0 && feet.squaredDistanceTo(Vec3d.ofBottomCenter(incidentFrom)) >= 12.0;
            boolean continuedRoute = grounded && retryRouteCells >= 5 && movedCells >= 5 && distance >= 25.0
                && feet.squaredDistanceTo(Vec3d.ofBottomCenter(incidentFrom)) >= 25.0;
            if (settledWork || tick - entered >= 25 && gain == 2
                    || !navigation && tick - entered >= 45 && (sustained || continuedRoute
                        || surveySequence - retrySurvey >= 3)) {
                recoveries++;
                markUseful(feet);
                transition(Phase.WATCH, "ordinary play advanced after the recovery attempt");
            }
        }
        workBroke = resourceBroke = stairLit = surfaceStep = cooked = false;
        navigationTurn = navigationArrival = false;
        int idle = tick - lastUseful;
        if (phase != Phase.WATCH || navigationLease || tick < ordinarySetupUntil || hands.busy() && idle < 300) return;
        boolean spinning = stalledByTurning(idle, distance, yawTravel, yawNet, reversals);
        if (!spinning && idle < IDLE_TICKS) return;
        if (verifiedMining(lastUseful) || verifiedFurnace()) return;
        String cause = spinning
            ? "local turn budget: " + Math.round(yawTravel) + "deg travel, " + Math.round(yawNet)
                + "deg net, " + reversals + " reversals in " + Math.min(sampledAngles, ANGLE_WINDOW) + " ticks"
            : "no settled progress for " + idle + " ticks";
        detect(cause + " while " + activity);
    }

    static boolean stalledByTurning(int idle, double distanceSquared, float travel, float net, int reversals) {
        return idle >= SPIN_TICKS && distanceSquared <= 2.25 && travel >= 275
            && (reversals >= 2 || travel >= 360 && Math.abs(net) >= 325);
    }

    /** Incidental immersion is not a failed dry stance and must not enter the dry-only assessment. */
    boolean controlsWaterRecovery() { return phase == Phase.WATER; }

    AgentWaterEscape.Result takeEmergencyWaterTurn(Runnable replan, Runnable releaseAlternative) {
        if (client.player.hasVehicle() || !client.player.isTouchingWater() && phase != Phase.WATER)
            return AgentWaterEscape.Result.INTERRUPTED;
        if (phase != Phase.WATER || !emergencyWater) {
            if (phase == Phase.ALTERNATIVE) releaseAlternative.run();
            tookControl = true;
            blockedReason = null;
            replan.run();
            water.startEmergency();
            beginWaterRecovery(true);
        }
        return stepWaterRecovery();
    }

    boolean takeWaterTurn(boolean planned, AgentVisibleHorizon.Refusal lostShallows, Runnable replan,
                          Runnable releaseAlternative) {
        if (planned || client.player.hasVehicle()) {
            if (phase == Phase.WATER) {
                water.clearEpisode();
                transition(Phase.WATCH, "releasing recovery to controlled water transit");
            }
            return false;
        }
        if (phase != Phase.WATER) {
            if (lostShallows == null && !water.stalled()) return false;
            if (phase == Phase.WATCH) detect(lostShallows != null
                ? "the witnessed shallow crossing was preempted: " + lostShallows.key
                : "no useful horizontal movement in water");
            if (phase == Phase.ALTERNATIVE) releaseAlternative.run();
            tookControl = true;
            blockedReason = null;
            replan.run();
            water.start(lostShallows == null);
            beginWaterRecovery(false);
        }
        return stepWaterRecovery() != AgentWaterEscape.Result.INTERRUPTED;
    }

    private void beginWaterRecovery(boolean emergency) {
        emergencyWater = emergency;
        waterAttempts = 0;
        waterBlockedReported = false;
        transition(Phase.WATER, water.status());
    }

    private AgentWaterEscape.Result stepWaterRecovery() {
        AgentWaterEscape.Result result = water.step();
        if (!emergencyWater) attempts += water.attempts() - waterAttempts;
        waterAttempts = water.attempts();
        if (result == AgentWaterEscape.Result.LANDED) {
            if (!emergencyWater) recoveries++;
            markUseful(client.player.getPos());
            water.clearEpisode();
            // A wet crossing is not a walked dry edge. Ordinary work can record the new footing.
            transition(Phase.WATCH, emergencyWater ? water.status() : water.status() + "; returning control to ordinary play");
        } else if (result == AgentWaterEscape.Result.INTERRUPTED) {
            water.clearEpisode();
            transition(emergencyWater ? Phase.WATCH : Phase.PENDING, "water recovery released without a settled landing");
        } else {
            if (!emergencyWater && result == AgentWaterEscape.Result.BLOCKED && !waterBlockedReported) failures++;
            waterBlockedReported = result == AgentWaterEscape.Result.BLOCKED;
            if (!report.detail().equals(water.status()) || report.attempts() != attempts || report.failures() != failures)
                transition(Phase.WATER, water.status());
        }
        return result;
    }

    /** Actual danger, fall or feeding behavior retains the camera; it is not a search sweep. */
    void priorityAim() {
        priorityAim = true;
        clearAngles();
        if (phase == Phase.STEP && (stepStage == StepStage.JUMP || stepStage == StepStage.LAND))
            interruptStep("safety behavior interrupted the temporary jump or placement");
        else if (phase == Phase.DEPART && departureRise != null)
            transition(Phase.ASSESS, "safety behavior interrupted the witnessed rise; waiting for dry contact");
        else if (phase == Phase.PASSAGE)
            assessAgain("safety behavior interrupted the witnessed side passage");
    }

    /** Time spent on emergency inputs is not failed ordinary work or a recovery receipt. */
    void resumeAfterRangedDanger(Runnable releaseAlternative) {
        if (phase == Phase.WATER || blockedReason != null) return;
        if (phase == Phase.ALTERNATIVE) releaseAlternative.run();
        markUseful(client.player.getPos());
        if (phase != Phase.WATCH) transition(Phase.WATCH, "returning local control after ranged danger");
    }

    private void sampleAngles(float yaw) {
        float delta = MathHelper.wrapDegrees(yaw - previousYaw);
        previousYaw = yaw;
        if (priorityAim) {
            priorityAim = false;
            return;
        }
        if (phase != Phase.WATCH) {
            if (tookControl && phase != Phase.RETRY && phase != Phase.PENDING && blockedReason == null)
                recoveryYaw += Math.abs(delta);
            return;
        }
        int i = sampledAngles % ANGLE_WINDOW;
        if (sampledAngles++ >= ANGLE_WINDOW) {
            yawTravel -= Math.abs(yawWindow[i]);
            yawNet -= yawWindow[i];
            reversals -= reversalsWindow[i];
        }
        int sign = delta > 2 ? 1 : delta < -2 ? -1 : 0;
        boolean reversed = sign != 0 && previousTurn != 0 && sign != previousTurn;
        if (sign != 0) previousTurn = sign;
        yawWindow[i] = delta;
        reversalsWindow[i] = (byte) (reversed ? 1 : 0);
        yawTravel += Math.abs(delta);
        yawNet += delta;
        if (reversed) reversals++;
    }

    private void clearAngles() {
        sampledAngles = previousTurn = reversals = 0;
        yawTravel = yawNet = 0;
    }

    /** An ordinary skill refused its next action; this is not a run failure. */
    void skillBlocked(String reason) {
        body.pauseWork();
        if (phase == Phase.WATCH) {
            detect(reason);
            explicitRefusal = true;
        } else if (phase == Phase.PENDING) {
            explicitRefusal = true;
        } else if (phase == Phase.RETRY) {
            if (blockedReason != null) {
                replanOnAssessment = true;
                assessAgain("ordinary replan refused: " + reason);
            } else if (mineHandedBack) fail("ordinary miner handback failed: " + reason);
            else nextAttempt(reason);
        } else if (phase == Phase.ALTERNATIVE) assessAgain("alternative refused: " + reason);
    }

    /** Called only after the existing danger, hands, screen and food owners have declined this tick. */
    boolean takeTurn(Runnable replan, Supplier<String> chooseAlternative, Supplier<Alternative> workAlternative,
                     Runnable releaseAlternative, boolean mineRetryLease, BlockPos witnessedLowCeiling) {
        navigationLowCeiling = witnessedLowCeiling;
        if (phase == Phase.WATCH) return false;
        if (client.player.isTouchingWater() || client.player.hasVehicle()) {
            if (phase == Phase.DEPART && departureRise != null)
                transition(Phase.ASSESS, "left dry contact during the witnessed rise");
            else if (phase == Phase.PASSAGE)
                assessAgain("left dry contact while checking the witnessed side passage");
            return false;
        }
        if (phase == Phase.ASSESS || phase == Phase.DEPART || phase == Phase.PASSAGE
                || phase == Phase.ALTERNATIVE || phase == Phase.BLOCKED) {
            if (replanOnAssessment) {
                replanOnAssessment = false;
                replan.run();
            }
            return assessAlternative(chooseAlternative, workAlternative, releaseAlternative);
        }
        if (phase == Phase.RETRY && blockedReason != null) {
            if (retryWindowOpen(tick - entered, true, mineRetryLease)
                    || verifiedMining(entered) || verifiedFurnace()) return false;
            replan.run();
            assessAgain("ordinary replan did not produce settled progress");
            return true;
        }
        if (tick - incidentTick >= INCIDENT_TICKS) {
            fail("incident deadline reached in " + report.phase() + " (" + report.detail() + ")");
            return true;
        }
        if (phase == Phase.RETRY) {
            if (retryWindowOpen(tick - entered, false, mineRetryLease)
                    || verifiedMining(entered) || verifiedFurnace()) return false;
            if (mineHandedBack) {
                fail("ordinary miner handback made no settled progress (" + report.detail() + ")");
                return true;
            }
            nextAttempt("ordinary play returned to the same local stall");
        }
        if (phase == Phase.PENDING) {
            if (tick == entered) return true; // Preserve the trigger in ordinary tick telemetry.
            if (!dryGround()) {
                if (tick - entered < DRY_FOOTING_TICKS) return true;
                fail("no stable dry footing from which to attempt safe recovery");
                return true;
            }
            tookControl = true;
            replan.run();
            scanFromHere();
        }
        if (recoveryYaw >= RECOVERY_TURN_LIMIT
                && (phase == Phase.SCOUT || phase == Phase.BACKTRACK || phase == Phase.CUT)) {
            String reason = "bounded recovery turn budget exhausted (" + Math.round(recoveryYaw) + "deg)";
            if (stepTried || !dryGround() || hands.count(STEP) == 0) fail(reason + "; no safe step available");
            else startStep(reason + "; checking a temporary step without another sweep");
            return true;
        }
        switch (phase) {
            case SCOUT -> scout();
            case BACKTRACK -> backtrack();
            case WALK -> move();
            case LIGHT -> light();
            case CUT -> cut();
            case STEP -> step();
            case SETTLE -> settleStep();
            default -> { }
        }
        return true;
    }

    private boolean assessAlternative(Supplier<String> choose, Supplier<Alternative> work, Runnable release) {
        if (phase == Phase.DEPART) {
            depart();
            return true;
        }
        if (phase == Phase.PASSAGE) {
            clearPassage();
            return true;
        }
        if (phase == Phase.ALTERNATIVE) {
            Alternative result = !safeDryContact() || tick - entered >= ALTERNATIVE_TICKS
                ? Alternative.REFUSED : work.get();
            if (result != Alternative.WORKING) release.run();
            if (result == Alternative.ADVANCED) {
                recoveries++;
                markUseful(client.player.getPos());
                transition(Phase.WATCH, "distinct local alternative produced a confirmed result");
                return false;
            }
            if (result == Alternative.REPLAN) {
                retry("replanning ordinary work after " + report.detail() + "; requiring settled progress");
                return false;
            }
            if (result == Alternative.ADVANCED_BUT_HELD)
                assessAgain("distinct local alternative produced a confirmed result; original skill still blocked");
            else if (result == Alternative.REFUSED)
                assessAgain("alternative did not produce a usable result: " + report.detail());
            return true;
        }
        body.pauseWork();
        if (tick < alternativeCheckAt || tick == entered && phase == Phase.ASSESS) return true;
        BlockPos support = quietSupport();
        if (support == null || !body.hasRecentView()) {
            idleAtAssessment(false, support == null ? "waiting for safe, settled dry contact" : "waiting for a rendered view");
            return true;
        }
        BlockPos foot = client.player.getBlockPos();
        if (!foot.equals(surveyFoot)) {
            surveyFoot = foot.toImmutable();
            surveyRise = null;
            passageCues = 0;
            departures.stoodOn(foot);
            setSurveyBearing(client.player.getHorizontalFacing());
            surveySector = departures.beginSurvey(foot) ? 0 : 4;
            if (offerAlternative(choose)) return true;
        }
        if (surveySector >= 4) {
            Direction facing = client.player.getHorizontalFacing();
            rememberPassage(facing);
            if (offerAlternative(choose) || offerDeparture(facing) || offerRiseDeparture() || offerPassage()) return true;
            idleAtAssessment(true, "no distinct witnessed work or safe departure");
            return true;
        }
        if (phase != Phase.ASSESS) {
            surveySince = tick;
            transition(Phase.ASSESS, "reassessing alternatives from settled dry footing");
        }
        lookForDeparture(choose, support);
        return true;
    }

    private boolean offerAlternative(Supplier<String> choose) {
        String task = choose.get();
        if (task == null) return false;
        attempts++;
        transition(Phase.ALTERNATIVE, task);
        return true;
    }

    private void setSurveyBearing(Direction direction) {
        surveyBearing = direction;
        surveySince = tick;
        surveyViews = 0;
        surveyFrame = -1;
    }

    private void lookForDeparture(Supplier<String> choose, BlockPos support) {
        var player = client.player;
        Vec3d feet = player.getPos();
        float yaw = surveyBearing.getPositiveHorizontalDegrees();
        body.turn(yaw, DEPARTURE_PITCH);
        if (body.renderedDirection(yaw, DEPARTURE_PITCH, 6) && body.renderedFrame() != surveyFrame) {
            if (surveyViews == 0 && centerMargin(feet, surveyFoot) < 0.35 && support.equals(surveyFoot.down())
                    && tick - surveySince < DEPARTURE_LOOK_TICKS - 12
                    && body.centerOnGroundedSupport(surveyFoot, body.dryCaveContact(surveyFoot))) return;
            surveyFrame = body.renderedFrame();
            surveyViews++;
            // Inspect the short level route before the wider resource scans spend the frame's shared rays.
            int length = visibleDeparture(surveyBearing);
            if (length == 0) {
                rememberRise(surveyBearing);
                rememberPassage(surveyBearing);
            }
            if (offerAlternative(choose)) return;
            if (length != 0) {
                beginDeparture(surveyBearing, length);
                return;
            }
        }
        if (surveyViews >= DEPARTURE_VIEWS || tick - surveySince >= DEPARTURE_LOOK_TICKS) {
            surveySector++;
            setSurveyBearing(surveyBearing.rotateYClockwise());
        }
    }

    private boolean offerDeparture(Direction direction) {
        int length = visibleDeparture(direction);
        if (length == 0) return false;
        beginDeparture(direction, length);
        return true;
    }

    private int visibleDeparture(Direction direction) {
        BlockPos prior = surveyFoot;
        int length = 0;
        for (int i = 0; i < departurePath.length; i++) {
            BlockPos cell = prior.offset(direction);
            if (!departures.canCross(prior, cell)) break;
            BlockState top = body.overlandTop(cell.down(), direction, DRY_DANGER);
            if (top == null) break;
            Vec3d inside = Vec3d.ofBottomCenter(cell).add(direction.getOffsetX() * 0.24, 0, direction.getOffsetZ() * 0.24);
            if (!body.overlandClear(inside.add(0, 0.32, 0), DRY_DANGER)
                    || !body.overlandClear(inside.add(0, 1.34, 0), DRY_DANGER)) break;
            departurePath[i] = cell;
            departureSupports[i] = top;
            prior = cell;
            length++;
        }
        for (; length > 0; length--) {
            if (departures.newLanding(departurePath[length - 1])
                    && body.overlandLane(surveyFoot, departurePath, departureSupports, length, direction, DRY_DANGER))
                return length;
        }
        return 0;
    }

    private void rememberRise(Direction direction) {
        if (surveyRise != null && !surveyRise.lookOnly()) return;
        BlockPos floor = surveyFoot.offset(direction);
        if (!departures.canRise(surveyFoot, floor.up())) return;
        var grade = body.ordinaryGrade(Vec3d.ofBottomCenter(floor));
        if (grade != null && grade.from().equals(surveyFoot) && grade.bearing() == direction && grade.floor().equals(floor)
                && (surveyRise == null || !grade.lookOnly())) surveyRise = grade;
    }

    private boolean passageEligible(BlockPos foot, Direction direction) {
        if (!foot.equals(lowCeilingFoot) || triedPassages.size() >= MAX_PASSAGES) return false;
        BlockPos target = foot.offset(direction);
        return departures.newLanding(target) && departures.canCross(foot, target) && !triedPassages.contains(target);
    }

    private void rememberPassage(Direction direction) {
        int bit = 1 << direction.ordinal();
        if ((passageCues & bit) != 0 || !passageEligible(surveyFoot, direction)) return;
        BlockPos target = surveyFoot.offset(direction);
        for (int height = 1; height >= 0; height--) {
            BlockPos cell = height == 1 ? target.up() : target;
            Vec3d point = passagePoint(cell, height == 1);
            BlockHitResult hit = passageRay(point);
            if (passageFace(target, direction, hit, height == 1) && canCut(hit)) {
                passageCues |= bit;
                return;
            }
            if (height == 1 && !body.overlandClear(point, DRY_DANGER)) return;
        }
    }

    private boolean offerPassage() {
        // The sweep saw a near face, not a route. Spend it once, after open routes and normal work.
        for (Direction direction : Direction.Type.HORIZONTAL) {
            int bit = 1 << direction.ordinal();
            if ((passageCues & bit) == 0) continue;
            passageCues &= ~bit;
            if (!passageEligible(surveyFoot, direction)) continue;
            passageFrom = surveyFoot;
            passageTo = passageFrom.offset(direction);
            triedPassages.add(passageTo);
            passageBearing = direction;
            passageSince = tick;
            passageBreakAt = 0;
            passageStage = PassageStage.HEAD;
            passageOpening = new Box(passageTo).expand(0, 1.5, 0);
            passageCut = null;
            passageBroke = false;
            attempts++;
            transition(Phase.PASSAGE, "checking the witnessed side passage around the low ceiling toward "
                + passageTo.toShortString());
            return true;
        }
        return false;
    }

    private void clearPassage() {
        var player = client.player;
        if (tick - passageSince >= PASSAGE_TICKS || !passageFrom.equals(player.getBlockPos())
                || quietSupport() == null || body.dryCaveContact(passageFrom) == null
                || centerMargin(player.getPos(), passageFrom) < player.getWidth() * 0.5
                || body.hazardAhead(passageBearing.getPositiveHorizontalDegrees(), 1.65)) {
            assessAgain("side passage did not yield safe clearance and different footing within its bound");
            return;
        }
        if (passageBreakAt != 0 && (tick - passageBreakAt < PASSAGE_BREAK_SETTLE_TICKS
                || body.renderedFrame() <= passageBreakFrame)) return;
        if (passageBreakAt != 0 && fallingInPassage()) {
            assessAgain("falling material became visible after the side cut");
            return;
        }
        if (passageStage == PassageStage.LANDING) {
            body.turn(passageBearing.getPositiveHorizontalDegrees(), DEPARTURE_PITCH);
            if (body.renderedDirection(passageBearing.getPositiveHorizontalDegrees(), DEPARTURE_PITCH, 6)) {
                // A break does not prove a floor, a dry opening, or the width of a safe stopping lane.
                int length = visibleDeparture(passageBearing);
                if (length != 0) beginDeparture(passageBearing, length);
            }
            return;
        }
        boolean head = passageStage == PassageStage.HEAD;
        BlockPos cell = head ? passageTo.up() : passageTo;
        Vec3d point = passagePoint(cell, head);
        Vec3d cover = passageCoverPoint(cell, passageBearing);
        // Keep the face and the lower edge of its cover together in the real camera.
        body.aim(point.lerp(cover, 0.34));
        AgentBody.DryRouteSample sample = body.dryCaveSpace(point);
        if (sample == AgentBody.DryRouteSample.FLUID) {
            assessAgain("fluid became visible in the witnessed side passage");
            return;
        }
        if (sample == AgentBody.DryRouteSample.CLEAR) {
            if (passageCut != null && !passageBroke) {
                assessAgain("side clearance changed without a confirmed cut");
                return;
            }
            passageCut = null;
            passageBroke = false;
            passageStage = head ? PassageStage.LEGS : PassageStage.LANDING;
            return;
        }
        if (passageBroke) {
            if (sample == AgentBody.DryRouteSample.OBSTRUCTION)
                assessAgain("the cleared side face was obstructed again");
            return; // Wait for lit dry air through the edit; never attack a replacement.
        }
        BlockHitResult hit = passageRay(point);
        if (hit == null) return;
        if (!passageFace(passageTo, passageBearing, hit, head) || !canCut(hit)) {
            assessAgain("side passage is blocked by an unverified or protected face");
            return;
        }
        if (visibleCutCoverUnsafe(cell, cover)) {
            assessAgain("side passage has fluid, falling, or supported material above the cut");
            return;
        }
        BlockState state = client.world.getBlockState(hit.getBlockPos());
        body.aimContact(hit, AgentBody.Contact.MINE);
        if (tools.readyFor(state) && body.mine(hit)) {
            if (passageCut == null) {
                passageCut = cell;
                transition(Phase.PASSAGE, "clearing the witnessed side face at " + cell.toShortString());
            }
        } else if (body.miningFootingRefused(cell)) {
            assessAgain("vanilla mining contact would leave the safe takeoff");
        }
    }

    private boolean fallingInPassage() {
        // Only this exposed passage; a candidate must also be inside the rendered view and unoccluded.
        client.world.collectEntitiesByType(FALLING_ENTITIES, passageOpening,
            entity -> entity.isAlive() && body.clearTerrain(entity.getBoundingBox().getCenter()), passageFalling, 1);
        if (passageFalling.isEmpty()) return false;
        passageFalling.clear();
        return true;
    }

    private boolean visibleCutCoverUnsafe(BlockPos cell, Vec3d cover) {
        BlockHitResult above = passageRay(cover);
        return above != null && above.getBlockPos().getY() > cell.getY()
            && AgentHeadroom.unsafeCutCover(client.world.getBlockState(above.getBlockPos()));
    }

    private BlockHitResult passageRay(Vec3d point) {
        return body.perceive(point, client.player.getEyePos().distanceTo(point) + 0.04).orElse(null);
    }

    private static Vec3d passagePoint(BlockPos cell, boolean head) {
        return Vec3d.ofCenter(cell, head ? 0.53 : 0.83);
    }

    private static Vec3d passageCoverPoint(BlockPos cell, Direction direction) {
        return Vec3d.ofCenter(cell.up(), 0.09).add(-0.36 * direction.getOffsetX(), 0,
            -0.36 * direction.getOffsetZ());
    }

    static boolean passageFace(BlockPos landing, Direction direction, BlockHitResult hit, boolean head) {
        return hit != null && hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock()
            && direction.getAxis().isHorizontal() && hit.getSide() == direction.getOpposite()
            && hit.getBlockPos().equals(head ? landing.up() : landing);
    }

    private boolean offerRiseDeparture() {
        // Spend at most one retained fallback, only after the usual survey has offered its level lanes.
        var cue = surveyRise;
        surveyRise = null;
        if (cue == null || !departures.canRise(cue.from(), cue.to())) return false;
        departureRise = cue;
        if (cue.frame() != body.renderedFrame() || !startRise(cue))
            transition(Phase.DEPART, "checking the top and jump clearance of the witnessed adjacent rise");
        return true;
    }

    private boolean startRise(AgentBody.OrdinaryGrade grade) {
        departureTread = departures.riseTread(grade, tick);
        if (departureTread == null) return false;
        attempts++;
        transition(Phase.DEPART, "leaving the refused maneuver along a witnessed one-block rise to "
            + departureTread.to.toShortString());
        return true;
    }

    private void beginDeparture(Direction direction, int length) {
        departureFrom = surveyFoot;
        departureBearing = direction;
        departureLength = length;
        attempts++;
        transition(Phase.DEPART, "leaving the refused maneuver along witnessed level ground to "
            + departurePath[length - 1].toShortString());
    }

    private void depart() {
        if (departureRise != null) {
            departRise();
            return;
        }
        var player = client.player;
        BlockPos foot = player.getBlockPos();
        BlockPos ending = departurePath[departureLength - 1];
        boolean safe = safeDryContact();
        if (safe && body.hasRecentView() && foot.equals(ending) && standingOn(ending)
                && player.getVelocity().horizontalLengthSquared() <= 0.0025
                && centerMargin(player.getPos(), ending) >= 0.27) {
            body.pauseWork();
            reached.accept(ending);
            retry("settled on different witnessed footing at " + ending.toShortString() + "; returning to ordinary play");
            return;
        }
        if (safe && tick - entered < DEPARTURE_DRIVE_TICKS
                && (!body.hasRecentView() || body.overlandLane(departureFrom, departurePath, departureSupports,
                    departureLength, departureBearing, DRY_DANGER))) {
            if (body.hasRecentView()) body.driveDryRoute(departureFrom, ending, departureBearing);
            return;
        }
        // Preserve the last exact attempted edge, not a blanket veto around the player.
        if (safe && body.hasRecentView()) {
            BlockPos prior = departureFrom;
            for (int i = 0; i < departureLength; i++) {
                BlockPos next = departurePath[i];
                if (prior.equals(foot)) {
                    departures.reject(prior, next);
                    break;
                }
                prior = next;
            }
        }
        assessAgain("level departure no longer has a safe stopping lane");
    }

    private void departRise() {
        var player = client.player;
        if (departureTread == null) {
            var cue = departureRise;
            if (!cue.from().equals(player.getBlockPos()) || quietSupport() == null) {
                assessAgain("lost settled takeoff contact before the witnessed rise");
                return;
            }
            Vec3d top = cue.topAim();
            if (body.renderedFrame() > cue.frame() && body.renderedAim(top, 8)) {
                if (!startRise(body.ordinaryGradeAfterLook(cue))) {
                    assessAgain("the retained rise did not show a full dry top with safe jump clearance");
                    return;
                }
            } else {
                if (tick - entered < DEPARTURE_LOOK_TICKS) body.aim(top);
                else assessAgain("the one look did not produce a fresh view of the witnessed rise");
                return;
            }
        }
        var tread = departureTread;
        switch (tread.step(client, body, tick)) {
            case CHECKING, MOVING -> { }
            case REFUSED -> assessAgain("witnessed rise stopped: " + tread.refusal());
            case LANDED -> {
                if (!safeDryContact() || !standingOn(tread.to)) {
                    assessAgain("witnessed rise did not settle onto its exact dry support");
                    return;
                }
                body.pauseWork();
                reached.accept(tread.to);
                retry("settled on different witnessed footing after a one-block rise; returning to ordinary play");
            }
        }
    }

    private void assessAgain(String reason) {
        body.pauseWork();
        alternativeCheckAt = tick;
        surveySince = tick;
        transition(Phase.ASSESS, reason);
    }

    private void idleAtAssessment(boolean safe, String reason) {
        alternativeCheckAt = tick + (safe ? BLOCKED_RECHECK_TICKS : CHANGED_SUPPORT_TICKS);
        String detail = (safe ? "safe idle: " : "recovery inputs held: ") + reason + "; " + blockedReason;
        if (phase != Phase.BLOCKED || safeIdle != safe || !report.detail().equals(detail))
            transition(Phase.BLOCKED, detail);
        safeIdle = safe;
    }

    private void resetWorld() {
        world = client.world;
        water.clearEpisode();
        departures.clear();
        surveyFoot = null;
        lowCeilingFoot = null;
        triedPassages.clear();
        surveyRise = departureRise = null;
        departureTread = null;
        replanOnAssessment = false;
        Arrays.fill(walked, null);
        Arrays.fill(flatCrossings, null);
        Arrays.fill(footprints, null);
        Arrays.fill(navigationFootings, null);
        Arrays.fill(travelCredits, null);
        Arrays.fill(breakHistory, null);
        Arrays.fill(stairLights, null);
        walkedCount = footprintCount = creditCount = brokenCount = stairLightCount = 0;
        navigationFootCount = 0;
        navigationTurn = navigationRetry = navigationArrival = false;
        lastGround = null;
        flatCrossingCount = 0;
        returningOnContact = null;
        priorGroundFeet = confirmedFoot = null;
        inventoryKnown = false;
        blockedReason = null;
        previousYaw = client.player.getYaw();
        stopCooking();
        markUseful(client.player.getPos());
        if (phase != Phase.WATCH) transition(Phase.WATCH, "client world changed");
    }

    private void markUseful(Vec3d feet) {
        lastUseful = tick;
        ordinarySetupUntil = 0;
        anchor = feet;
        novelCells = movedCells = 0;
        clearAngles();
        mineSince = 0;
        mining = null;
    }

    /** Compare total owned items, not slot order, selected hotbar, damage, or in-flight GUI transfers. */
    private int inventoryGain(boolean navigation, boolean bootstrapTimber) {
        if (hands.busy() || client.currentScreen != null) return 0;
        var owned = client.player.getInventory();
        int kinds = 0;
        for (int i = 0; i < owned.size(); i++) {
            ItemStack stack = owned.getStack(i);
            if (stack.isEmpty()) continue;
            Item item = stack.getItem();
            int id = Item.getRawId(item);
            if (inventorySample[id] == 0) {
                sampledItems[kinds] = item;
                sampledIds[kinds++] = id;
            }
            inventorySample[id] += stack.getCount();
        }
        int gain = 0;
        if (inventoryKnown) {
            for (int i = 0; i < kinds; i++) {
                int id = sampledIds[i];
                if (inventorySample[id] <= inventory[id]) continue;
                Item item = sampledItems[i];
                if (bootstrapTimber && item == Items.STICK) continue;
                if (navigation ? navigationSupply(item) : taskItem(item)) {
                    gain = 2;
                    break;
                }
                gain = 1;
            }
        }
        for (int i = 0; i < itemKinds; i++) inventory[itemIds[i]] = 0;
        for (int i = 0; i < kinds; i++) {
            int id = sampledIds[i];
            inventory[id] = inventorySample[id];
            inventorySample[id] = 0;
        }
        int[] prior = itemIds;
        itemIds = sampledIds;
        sampledIds = prior;
        itemKinds = kinds;
        inventoryKnown = true;
        return gain;
    }

    private static boolean navigationSupply(Item item) {
        return item == Items.DIAMOND || item == Items.RAW_IRON || item == Items.IRON_INGOT
            || item == Items.COAL || item == Items.CHARCOAL;
    }

    private static boolean taskItem(Item item) {
        return item != Items.DIRT && item != Items.COBBLESTONE && item != Items.COBBLED_DEEPSLATE
            && item != Items.TUFF && item != Items.STONE && item != Items.GRASS_BLOCK && item != Items.ROOTED_DIRT
            && item != Items.STICK && !item.getRegistryEntry().isIn(ItemTags.LEAVES);
    }

    private boolean verifiedMining(int since) {
        if (tick - since > IDLE_TICKS + MINING_TICKS || client.currentScreen != null
                || !client.options.attackKey.isPressed() || client.interactionManager == null
                || !client.interactionManager.isBreakingBlock()) return false;
        BlockHitResult selected = body.selectedFace();
        if (selected == null) return false;
        int crack = client.interactionManager.getBlockBreakingProgress();
        if (mineSince == 0) {
            mining = selected.getBlockPos();
            mineSince = lastCrackTick = tick;
            crackStage = crack;
        } else if (!mining.equals(selected.getBlockPos()) || crack < crackStage) {
            return false;
        } else if (crack > crackStage) {
            lastCrackTick = tick;
            crackStage = crack;
        }
        return tick - mineSince <= MINING_TICKS && tick - lastCrackTick <= 50;
    }

    private boolean verifiedFurnace() {
        return furnaceSeen != 0 && furnaceAdvancing(tick);
    }

    private void detect(String reason) {
        incidents++;
        incidentTick = tick;
        incidentFrom = client.player.getBlockPos().toImmutable();
        triedStances.clear();
        rejectedStances.clear();
        triedCuts.clear();
        triedPassages.clear();
        lowCeilingFoot = null;
        drivenStances.clear();
        assessedSupports.clear();
        departures.resetSurveys();
        departures.stoodOn(incidentFrom);
        surveyFoot = null;
        replanOnAssessment = false;
        triedStances.add(incidentFrom);
        rejectedStances.add(incidentFrom);
        cutCount = 0;
        recoveryYaw = 0;
        dark = lampTried = stepTried = backtrackTried = tookControl = false;
        glanceTried = glancing = false;
        mineHandedBack = explicitRefusal = false;
        blockedReason = null;
        transition(Phase.PENDING, reason + " at " + incidentFrom.toShortString());
    }

    private void scanFromHere() {
        scanFromHere("");
    }

    private void scanFromHere(String observation) {
        from = client.player.getBlockPos().toImmutable();
        bearing = client.player.getHorizontalFacing();
        routeIndex = routeLength = proof = 0;
        glancing = false;
        returningOnContact = null;
        to = null;
        transition(Phase.SCOUT, observation + "checking alternate visible ground from " + from.toShortString());
    }

    private void scout() {
        if (!dryGround()) return;
        if (!from.equals(client.player.getBlockPos())) {
            scanFromHere();
            return;
        }
        if (to != null) {
            if (checkStance()) startWalk();
            else if (tick - probeSince >= PROBE_TICKS) {
                rejectedStances.add(to);
                to = null;
            }
            return;
        }
        if (lampTried && client.player.getPitch() > 65 && tick - entered < 18) {
            body.turn(client.player.getYaw(), 40);
            return;
        }
        if (visibleStance()) return;
        if (!backtrackTried && planBacktrack()) {
            transition(Phase.BACKTRACK, "checking recorded footing at " + to.toShortString());
            return;
        }
        if (!glanceTried || glancing) {
            if (!glancing) {
                glanceTried = glancing = true;
                glanceSince = tick;
                glanceYaw = client.player.getYaw() + ((incidents & 1) == 0 ? 55 : -55);
            }
            if (tick - glanceSince < 24 && Math.abs(MathHelper.wrapDegrees(client.player.getYaw() - glanceYaw)) > 8) {
                body.turn(glanceYaw, 40);
                return;
            }
            glancing = false;
            if (visibleStance()) return;
        }
        if (dark && !lampTried && hands.count(TORCH) > 0) {
            lampTried = true;
            itemBefore = hands.count(TORCH);
            attempts++;
            transition(Phase.LIGHT, "trying one light on the currently stood-on support");
        } else if (cutCount < MAX_CUTS) {
            cut = null;
            cutFinished = false;
            transition(Phase.CUT, "checking the current view for a non-supporting natural obstruction");
        } else startStep("checking clearance for one temporary step on current support");
    }

    private boolean visibleStance() {
        Vec3d eye = client.player.getEyePos();
        for (int i = 0; i < 12; i++) {
            BlockPos cell = from.offset(direction(i & 3)).up(switch (i / 4) {
                case 1 -> 1;
                case 2 -> -1;
                default -> 0;
            });
            if (triedStances.contains(cell) || !departures.canCross(from, cell)) continue;
            Vec3d point = Vec3d.ofBottomCenter(cell).add(0, -0.07, 0);
            BlockHitResult support = body.terrain(point, eye.distanceTo(point) + 0.05).orElse(null);
            if (support == null || support.getSide() != Direction.UP || !support.getBlockPos().equals(cell.down())
                    || !fullSupport(support)) continue;
            triedStances.add(cell);
            nominate(cell);
            proof = 1;
            glancing = false;
            return true;
        }
        BlockHitResult outlined = body.selectedFace();
        if (outlined != null && body.perceive(outlined.getPos(), eye.distanceTo(outlined.getPos()) + 0.08).isEmpty())
            dark = true;
        return false;
    }

    private Direction direction(int option) {
        boolean leftFirst = (incidents & 1) != 0;
        return switch (option) {
            case 0 -> leftFirst ? bearing.rotateYCounterclockwise() : bearing.rotateYClockwise();
            case 1 -> bearing;
            case 2 -> leftFirst ? bearing.rotateYClockwise() : bearing.rotateYCounterclockwise();
            default -> bearing.getOpposite();
        };
    }

    private void nominate(BlockPos cell) {
        to = cell;
        proof = 0;
        probeSince = tick;
        returningOnContact = null;
    }

    private boolean checkStance() {
        if (!departures.canCross(from, to)) {
            rejectedStances.add(to);
            probeSince = tick - PROBE_TICKS;
            return false;
        }
        Vec3d floor = Vec3d.ofBottomCenter(to);
        Vec3d eye = client.player.getEyePos();
        if (proof == 0) {
            Vec3d point = floor.add(0, -0.07, 0);
            body.aim(point);
            if (!body.aligned(point)) return false;
            BlockHitResult support = body.terrain(point, eye.distanceTo(point) + 0.05).orElse(null);
            if (support == null) {
                dark |= body.outlined(to.down());
                return false;
            }
            if (routeLength != 0 && to.getY() == from.getY() && support.getBlockPos().equals(from.down())) {
                // We can see the near lip, not the recorded target. This is incomplete, not contradictory.
                return false;
            }
            if (!support.getBlockPos().equals(to.down()) || support.getSide() != Direction.UP || !fullSupport(support)) {
                rejectedStances.add(to);
                probeSince = tick - PROBE_TICKS;
                return false;
            }
            proof++;
        }
        if (proof <= 2) {
            double height = proof == 1 ? 0.35 : 1.68;
            Vec3d clearance = floor.add(0, height, 0);
            body.aim(clearance);
            if (!body.aligned(clearance)) return false;
            double dx = (to.getX() - from.getX()) * 0.25;
            double dz = (to.getZ() - from.getZ()) * 0.25;
            if (!body.clearTerrain(clearance.add(dz, 0, -dx)) || !body.clearTerrain(clearance.add(-dz, 0, dx)))
                return false;
            proof++;
            if (proof == 2) return false;
        }
        if (to.getY() > from.getY()) {
            Vec3d head = eye.add((to.getX() - from.getX()) * 0.32, 0.58, (to.getZ() - from.getZ()) * 0.32);
            body.aim(head);
            if (!body.aligned(head) || !body.clearTerrain(head)) return false;
        }
        return !body.hazardAhead(yaw(floor.subtract(client.player.getPos())), 1.45);
    }

    private boolean planBacktrack() {
        backtrackTried = true;
        int oldest = Math.max(0, walkedCount - HISTORY);
        for (int i = walkedCount - 1; i > oldest; --i) {
            if (!from.equals(walked[i % HISTORY])) continue;
            int length = 0;
            BlockPos prior = from;
            for (int j = i - 1; j >= oldest && length < route.length; --j) {
                BlockPos cell = walked[j % HISTORY];
                if (!neighbor(prior, cell) || cell.equals(from) || triedStances.contains(cell)
                        || length > 1 && cell.equals(route[length - 2])) break;
                route[length++] = cell;
                prior = cell;
            }
            if (length > 0) {
                routeLength = length;
                routeIndex = 0;
                nominate(route[0]);
                return true;
            }
        }
        // A bend, jump or diagonal crossing can interrupt the recorded chain. One
        // remembered adjacent cell is enough to try, not enough to skip sight checks.
        for (int i = walkedCount - 1; i >= oldest; --i) {
            BlockPos cell = walked[i % HISTORY];
            if (!neighbor(from, cell) || triedStances.contains(cell)) continue;
            route[0] = cell;
            routeLength = 1;
            routeIndex = 0;
            nominate(cell);
            return true;
        }
        return false;
    }

    private void backtrack() {
        if (!dryGround()) return;
        boolean atStart = from.equals(client.player.getBlockPos());
        if (atStart && tick - probeSince < PROBE_TICKS) {
            if (checkStance()) startWalk();
            return;
        }
        if (atStart && !rejectedStances.contains(to) && beginContactReturn()) return;
        triedStances.add(to);
        rejectedStances.add(to);
        boolean moved = routeIndex != 0 && atStart;
        routeLength = routeIndex = 0;
        to = null;
        if (moved) retry("retreated to " + from.toShortString() + "; the next footing was not verified");
        else scanFromHere();
    }

    private boolean beginContactReturn() {
        if (from.getY() != to.getY() || !standingOn(from) || !body.hasRecentView()
                || client.options.sneakKey.isUnbound() || client.player.horizontalCollision) return false;
        Vec3d feet = client.player.getPos();
        for (int i = flatCrossingCount - 1; i >= Math.max(0, flatCrossingCount - HISTORY); i--) {
            FlatCrossing known = flatCrossings[i % HISTORY];
            if (known == null) continue;
            if (tick - known.tick() > FLAT_RETURN_AGE) break;
            if (!known.next().equals(from) || !known.previous().equals(to)
                    || sidewaysFromCrossing(feet, known) > 0.26
                    || feet.squaredDistanceTo(known.previousFoot()) > 2.56
                    || routeChanged(known.previousFoot())) continue;
            returningOnContact = known;
            startWalk();
            return true;
        }
        return false;
    }

    private void startWalk() {
        triedStances.add(to);
        drivenStances.add(to);
        attempts++;
        driveSince = 0;
        transition(Phase.WALK, (returningOnContact != null ? "crouching along a recently crossed level support to "
            : routeLength == 0 ? "committing to visible stance " : "backtracking to ")
            + to.toShortString());
    }

    private void move() {
        if (returningOnContact != null) {
            moveOnContact();
            return;
        }
        var player = client.player;
        Vec3d landing = Vec3d.ofBottomCenter(to);
        Vec3d delta = landing.subtract(player.getPos());
        if (dryGround() && to.equals(player.getBlockPos()) && delta.horizontalLengthSquared() < 0.46) {
            reachedStance();
            return;
        }
        if (!player.isOnGround() && !player.isTouchingWater() && to.getY() <= from.getY()
                && player.getY() >= to.getY() - 0.04 && delta.horizontalLengthSquared() < 0.15
                && tick - entered <= 48) {
            // Crossing the center while still dropping reverses the target bearing.
            // Let the already witnessed landing settle before treating it as a failed route.
            return;
        }
        float face = yaw(delta);
        if (tick - entered > 48 || driveSince != 0 && tick - driveSince > 22
                || driveSince != 0 && Math.abs(MathHelper.wrapDegrees(face - driveYaw)) > 30
                || delta.horizontalLengthSquared() > 3.2 || body.hazardAhead(face, 1.45)
                || player.isTouchingWater() || player.getY() < Math.min(from.getY(), to.getY()) - 0.25) {
            rejectWalk();
            return;
        }
        if (delta.horizontalLengthSquared() < 0.05) return;
        body.turnFixed(face, to.getY() > from.getY() ? 9 : 28);
        if (Math.abs(MathHelper.wrapDegrees(player.getYaw() - face)) > 11) return;
        if (driveSince == 0) {
            driveSince = tick;
            driveYaw = face;
        }
        if (to.getY() > from.getY() && player.getY() < to.getY() - 0.20 && player.isOnGround()) body.jump();
        body.walkDownTo(landing);
    }

    private void moveOnContact() {
        var player = client.player;
        Vec3d feet = player.getPos();
        Vec3d landing = returningOnContact.previousFoot();
        Vec3d delta = landing.subtract(feet);
        if (!dryGround() || Math.abs(feet.y - landing.y) > 0.04 || player.horizontalCollision
                || !from.equals(player.getBlockPos()) && !to.equals(player.getBlockPos())
                || !standingOn(from) && !standingOn(to) || !body.hasRecentView()
                || sidewaysFromCrossing(feet, returningOnContact) > 0.30
                || tick - entered > 48 || driveSince != 0 && tick - driveSince > 22
                || routeChanged(landing)) {
            rejectWalk();
            return;
        }
        if (to.equals(player.getBlockPos()) && standingOn(to) && delta.horizontalLengthSquared() <= 0.075) {
            reachedStance();
            return;
        }
        float face = yaw(delta);
        if (driveSince != 0 && Math.abs(MathHelper.wrapDegrees(face - driveYaw)) > 35) {
            rejectWalk();
            return;
        }
        body.turnFixed(face, 40);
        body.sneak();
        if (Math.abs(MathHelper.wrapDegrees(player.getYaw() - face)) > 8 || !player.isSneaking()) return;
        if (driveSince == 0) {
            driveSince = tick;
            driveYaw = face;
        }
        body.walk(false); // Vanilla crouch keeps the ledge guard active; no verified descent and no jump.
    }

    private boolean routeChanged(Vec3d landing) {
        if (body.hazardAhead(yaw(landing.subtract(client.player.getPos())), 1.45)) return true;
        Vec3d eye = client.player.getEyePos();
        Vec3d floor = landing.add(0, -0.07, 0);
        BlockHitResult support = body.terrain(floor, eye.distanceTo(floor) + 0.04).orElse(null);
        if (support != null) {
            BlockPos cell = support.getBlockPos();
            if (!cell.equals(from.down()) && !cell.equals(to.down()) || !fullSupport(support)) return true;
        }
        for (double height = 0.46; height < 1.60; height += 0.88) {
            Vec3d clearance = landing.add(0, height, 0);
            double range = eye.distanceTo(clearance);
            BlockHitResult blocking = body.terrain(clearance, range).orElse(null);
            if (blocking != null && eye.squaredDistanceTo(blocking.getPos()) < range * range - 0.005) return true;
        }
        return false;
    }

    private boolean standingOn(BlockPos cell) {
        BlockPos support = client.player.supportingBlockPos.orElse(null);
        return support != null && support.getX() == cell.getX() && support.getY() == cell.getY() - 1
            && support.getZ() == cell.getZ();
    }

    private static boolean inFootColumn(BlockPos block, BlockPos cell) {
        return block.getX() == cell.getX() && block.getZ() == cell.getZ()
            && block.getY() >= cell.getY() - 1 && block.getY() <= cell.getY() + 1;
    }

    private static double centerMargin(Vec3d feet, BlockPos cell) {
        return 0.5 - Math.max(Math.abs(feet.x - cell.getX() - 0.5), Math.abs(feet.z - cell.getZ() - 0.5));
    }

    private static double sidewaysFromCrossing(Vec3d feet, FlatCrossing known) {
        return sidewaysDistance(feet, known.crossing(), known.previous().getX() == known.next().getX());
    }

    private static double sidewaysDistance(Vec3d first, Vec3d second, boolean traversedZ) {
        return traversedZ ? Math.abs(first.x - second.x) : Math.abs(first.z - second.z);
    }

    private void reachedStance() {
        returningOnContact = null;
        client.player.supportingBlockPos.ifPresent(assessedSupports::add);
        reached.accept(to);
        if (routeLength != 0 && ++routeIndex < routeLength) {
            from = to;
            nominate(route[routeIndex]);
            transition(Phase.BACKTRACK, "rechecking the next recorded footing");
        } else retry("reached " + to.toShortString() + "; requiring ordinary-play progress");
    }

    private void rejectWalk() {
        if (driveSince != 0 && quietSupport() != null) departures.reject(from, to);
        rejectedStances.add(to);
        scanFromHere();
    }

    private void light() {
        if (hands.count(TORCH) < itemBefore || tick - entered > 67 || !dryGround()) {
            if (hands.count(TORCH) < itemBefore) triedStances.retainAll(rejectedStances);
            scanFromHere();
            return;
        }
        if (!hands.equipForUse(TORCH)) return;
        BlockPos support = client.player.getBlockPos().down();
        body.turnFixed(client.player.getYaw(), 89);
        BlockHitResult selected = body.selectedFace();
        if (selected != null && selected.getBlockPos().equals(support) && selected.getSide() == Direction.UP) {
            body.sneak();
            if (client.player.isSneaking()) body.useContact(selected, AgentBody.Contact.OUTLINE);
        }
    }

    private void cut() {
        if (!dryGround()) return;
        if (!from.equals(client.player.getBlockPos())) {
            scanFromHere();
            return;
        }
        if (cutFinished) {
            BlockPos opened = cut.getY() == from.getY() ? cut : cut.down();
            triedStances.remove(opened);
            rejectedStances.remove(opened);
            cutFinished = false;
            scanFromHere();
            return;
        }
        if (tick - incidentTick > INCIDENT_TICKS - 92) {
            startStep("checking clearance for one temporary step on current support");
            return;
        }
        if (cut == null) {
            BlockHitResult witness = cutCount < MAX_CUTS ? visibleCut() : null;
            if (witness == null) {
                startStep("checking clearance for one temporary step on current support");
                return;
            }
            cut = witness.getBlockPos().toImmutable();
            triedCuts.add(cut);
            cutAim = witness.getPos().lerp(Vec3d.ofCenter(cut), 0.08);
            probeSince = tick;
            cutCount++;
            attempts++;
            transition(Phase.CUT, "clearing witnessed obstruction " + cut.toShortString() + " with best available tool");
        }
        if (tick - probeSince > 64 || body.hazardAhead(yaw(cutAim.subtract(client.player.getPos())), 1.5)) {
            cut = null;
            return;
        }
        body.aim(cutAim);
        double distance = client.player.getEyePos().distanceTo(cutAim);
        BlockHitResult seen = body.perceive(cutAim, distance + 0.06).orElse(null);
        if (seen == null || !seen.getBlockPos().equals(cut)) {
            if (body.aligned(cutAim)) cut = null;
            return;
        }
        if (!canCut(seen) || seen.getSide().getAxis().isHorizontal()
                && visibleCutCoverUnsafe(cut, passageCoverPoint(cut, seen.getSide().getOpposite()))) {
            cut = null;
            return;
        }
        BlockState state = client.world.getBlockState(seen.getBlockPos());
        body.aimContact(seen, AgentBody.Contact.MINE);
        if (tools.readyFor(state)) body.mine(seen);
    }

    private BlockHitResult visibleCut() {
        Vec3d eye = client.player.getEyePos();
        for (int i = 0; i < 8; ++i) {
            // Try head-level first. Only camera-admitted near faces can justify a cut.
            BlockPos cell = from.offset(direction(i & 3)).up(1 - i / 4);
            if (triedCuts.contains(cell)) continue;
            Vec3d point = Vec3d.ofCenter(cell);
            BlockHitResult seen = body.perceive(point, eye.distanceTo(point) + 0.06).orElse(null);
            if (seen == null || !seen.getBlockPos().equals(cell)
                    || body.hazardAhead(yaw(point.subtract(client.player.getPos())), 1.5)) continue;
            if (canCut(seen)) return seen;
        }
        return null;
    }

    private boolean canCut(BlockHitResult hit) {
        BlockPos cell = hit.getBlockPos();
        if (contains(footprints, cell.up()) || protectedBlock.test(cell)
                || cell.equals(client.player.supportingBlockPos.orElse(null))) return false;
        BlockState state = client.world.getBlockState(cell);
        return naturalObstruction(state) && state.getFluidState().isEmpty()
            && state.getHardness(client.world, cell) >= 0 && tools.canHarvest(state);
    }

    private static boolean naturalObstruction(BlockState state) {
        // Avoid stations, construction blocks, logs, gravel/sand and all special/valuable blocks.
        return state.isIn(BlockTags.LEAVES) && state.contains(LeavesBlock.PERSISTENT) && !state.get(LeavesBlock.PERSISTENT)
            || state.isOf(Blocks.DIRT) || state.isOf(Blocks.GRASS_BLOCK) || state.isOf(Blocks.ROOTED_DIRT)
            || state.isOf(Blocks.STONE) || state.isOf(Blocks.DEEPSLATE) || state.isOf(Blocks.TUFF);
    }

    private void startStep(String description) {
        BlockPos footing = client.player.getBlockPos();
        if (footing.equals(navigationLowCeiling)) {
            lowCeilingFoot = footing.toImmutable();
            departures.reject(footing, footing.up());
            fail("witnessed low mine ceiling rules out a temporary pillar on this footing");
            return;
        }
        if (!departures.canCross(footing, footing.up())) {
            fail("the temporary step on this footing was already refused");
            return;
        }
        if (stepTried || !dryGround() || hands.count(STEP) == 0) {
            fail("no verified alternate stance, safe obstruction or usable step material at " + from.toShortString());
            return;
        }
        stepTried = true;
        from = client.player.getBlockPos().toImmutable();
        stepStage = StepStage.CENTER;
        stepAim = null;
        stepSince = tick;
        stepHealth = client.player.getHealth();
        attempts++;
        transition(Phase.STEP, description);
    }

    private void step() {
        var player = client.player;
        BlockPos feetCell = player.getBlockPos();
        Vec3d feet = player.getPos();
        if (tick - stepSince > STEP_TICKS) {
            failStep(switch (stepStage) {
                case CENTER -> "could not center on the current support";
                case HEADROOM -> "could not verify jump and standing clearance";
                case SUPPORT -> "could not verify the current top face or equip a step block";
                case TORCH_BYPASS -> "the floor torch occupies the step cell and no adjacent footing was proved";
                case JUMP -> "did not reach a valid placement window";
                case LAND -> "placement or grounded landing was not confirmed";
            });
            return;
        }
        BlockPos support = from.down();
        if (stepStage == StepStage.CENTER) {
            if (!stepCentered(feet)) {
                body.centerOnSupport(support);
            } else if (!player.isSneaking() && player.getVelocity().horizontalLengthSquared() <= 0.000144) {
                stepStage = StepStage.HEADROOM;
            }
            return;
        }
        if (stepStage == StepStage.HEADROOM) {
            // At this pose the whole tested column, not just the crosshair, must be in view.
            Vec3d overhead = Vec3d.ofBottomCenter(from).add(0, STEP_CLEARANCE, 0);
            double edge = player.getWidth() * 0.5 + STEP_CENTER + 0.01;
            body.turnFixed(player.getYaw(), -89);
            if (player.getPitch() > -86) return;
            Vec3d eye = player.getEyePos();
            BlockHitResult lowCeiling = body.terrain(overhead, eye.distanceTo(overhead)).orElse(null);
            if (lowCeiling != null && lowCeiling.getSide() == Direction.DOWN
                    && lowCeiling.getBlockPos().getX() == from.getX() && lowCeiling.getBlockPos().getZ() == from.getZ()
                    && lowCeiling.getPos().y < overhead.y - 0.05
                    && client.world.getBlockState(lowCeiling.getBlockPos()).getFluidState().isEmpty()) {
                lowCeilingFoot = from;
                String handback = mineHandback.apply(from);
                if (handback == null) failStep("visible ceiling blocks the temporary step");
                else {
                    departures.reject(from, from.up());
                    attempts++;
                    mineHandedBack = true;
                    retry("visible ceiling blocks the temporary step; " + handback);
                }
                return;
            }
            if (!body.clearTerrain(overhead) || !body.clearTerrain(overhead.add(-edge, 0, -edge))
                    || !body.clearTerrain(overhead.add(-edge, 0, edge))
                    || !body.clearTerrain(overhead.add(edge, 0, -edge))
                    || !body.clearTerrain(overhead.add(edge, 0, edge)))
                return;
            stepStage = StepStage.SUPPORT;
            transition(Phase.STEP, "jump clearance verified; lining up the current support");
        }
        if (stepStage == StepStage.TORCH_BYPASS) {
            avoidFloorTorch();
            return;
        }
        if (stepAim == null) body.turnFixed(player.getYaw(), 89);
        else body.aimFixed(stepAim);
        if (stepStage == StepStage.SUPPORT) {
            if (player.getPitch() < 86) return;
            BlockHitResult selected = body.selectedFace();
            if (floorTorch(selected)) {
                startTorchBypass();
                return;
            }
            if (!hands.equipForUse(STEP) || !(player.getMainHandStack().getItem() instanceof BlockItem item)) return;
            BlockHitResult seen = stepTop(support, selected);
            if (seen == null) return;
            BlockState state = client.world.getBlockState(seen.getBlockPos());
            if (!fullSupport(seen, state) || state.hasBlockEntity() || state.isOf(Blocks.CRAFTING_TABLE)) {
                failStep("current top is not a safe placement support");
                return;
            }
            if (player.isSneaking() || player.getVelocity().horizontalLengthSquared() > 0.000144) return;
            stepBase = state;
            stepBlock = item.getBlock();
            stepAim = seen.getPos();
            itemBefore = hands.count(STEP);
            stepStage = StepStage.JUMP;
            transition(Phase.STEP, "jumping once above the verified support");
            body.jump();
            return;
        }
        if (stepStage == StepStage.LAND && dryGround()
                && from.up().equals(feetCell) && Math.abs(feet.y - from.getY() - 1) < 0.01) {
            BlockHitResult seen = stepTop(from, body.selectedFace());
            if (seen != null && client.world.getBlockState(seen.getBlockPos()).isOf(stepBlock)
                    && hands.count(STEP) < itemBefore) {
                reached.accept(feetCell);
                retry("stood on confirmed temporary step; requiring ordinary-play progress");
            }
            return;
        }
        if (player.isOnGround()) {
            if (tick - entered > 2) failStep(stepStage == StepStage.JUMP
                ? "jump did not clear one block with a visible top face" : "jump landed without a confirmed placement");
        } else if (feet.y >= from.getY() + 1.001
                && player.getMainHandStack().getItem() instanceof BlockItem item && item.getBlock() == stepBlock) {
            BlockHitResult seen = stepTop(support, body.selectedFace());
            if (stepStage == StepStage.JUMP && seen != null && client.world.getBlockState(support) == stepBase
                    && body.useContact(seen, AgentBody.Contact.LEAP_PLACE)) {
                stepStage = StepStage.LAND;
                transition(Phase.STEP, "placing one block beneath the airborne feet");
            }
        }
    }

    private boolean floorTorch(BlockHitResult selected) {
        if (selected == null || !selected.getBlockPos().equals(from)) return false;
        Vec3d point = selected.getPos().lerp(Vec3d.ofCenter(from), 0.016);
        BlockHitResult seen = body.perceive(point, client.player.getEyePos().distanceTo(point) + 0.05).orElse(null);
        if (seen == null || !seen.getBlockPos().equals(from)) return false;
        BlockState state = client.world.getBlockState(seen.getBlockPos());
        return state.isOf(Blocks.TORCH) || state.isOf(Blocks.SOUL_TORCH) || state.isOf(Blocks.REDSTONE_TORCH);
    }

    private void startTorchBypass() {
        String handback = mineHandback.apply(from);
        if (handback != null) {
            attempts++;
            mineHandedBack = true;
            retry("a witnessed floor torch occupies the temporary step cell; " + handback);
            return;
        }
        // The occupied cell is not a placement target, even if part of its base is visible.
        // Take one bounded look back at known footing; ordinary stance proofs still apply.
        routeIndex = routeLength = 0;
        to = null;
        for (int i = walkedCount - 1; i >= Math.max(0, walkedCount - HISTORY); i--) {
            BlockPos prior = walked[i % HISTORY];
            if (prior == null || triedStances.contains(prior) || !neighbor(from, prior)) continue;
            nominate(prior);
            break;
        }
        bearing = bearing.getOpposite();
        stepStage = StepStage.TORCH_BYPASS;
        transition(Phase.STEP, "a witnessed floor torch occupies the step cell; checking nearby footing instead");
    }

    private void avoidFloorTorch() {
        if (to != null) {
            if (checkStance()) startWalk();
            else if (tick - probeSince >= PROBE_TICKS)
                failStep("the floor torch occupies the step cell and the adjacent footing was not verified");
            return;
        }
        float yaw = bearing.getPositiveHorizontalDegrees();
        body.turn(yaw, 48);
        if (Math.abs(MathHelper.wrapDegrees(yaw - client.player.getYaw())) <= 8
                && Math.abs(client.player.getPitch() - 48) <= 6 && body.hasRecentView() && !visibleStance()) {
            failStep("the floor torch occupies the step cell and no adjacent footing was proved");
        }
    }

    private void checkStepPose(BlockPos cell, Vec3d feet) {
        var player = client.player;
        boolean launched = stepStage == StepStage.JUMP || stepStage == StepStage.LAND;
        if (player.isTouchingWater() || player.isInLava() || player.hasVehicle() || feet.y < from.getY() - 0.04
                || !from.equals(cell) && !(launched && from.up().equals(cell))
                || !launched && !dryGround()
                || stepStage != StepStage.CENTER && (!stepCentered(feet)
                    || player.getVelocity().horizontalLengthSquared() > 0.0025)) {
            interruptStep("left the temporary step's verified pose");
        }
    }

    private boolean stepCentered(Vec3d feet) {
        return Math.abs(feet.x - from.getX() - 0.5) <= STEP_CENTER
            && Math.abs(feet.z - from.getZ() - 0.5) <= STEP_CENTER;
    }

    private void interruptStep(String reason) {
        // Body.begin releases old jump/use intentions each tick; never issue another one for this column.
        stepStage = null;
        stepBlock = null;
        stepBase = null;
        stepAim = null;
        settlingSupport = null;
        settledSupport = false;
        transition(Phase.SETTLE, reason + " at " + from.toShortString() + "; waiting for observed support");
    }

    private void observeStepSettlement() {
        BlockPos support = quietSupport();
        int age = client.player.age;
        settledSupport = support != null && support.equals(settlingSupport) && age == settlingAge + 1;
        settlingSupport = support;
        settlingAge = age;
    }

    private void settleStep() {
        var player = client.player;
        body.turn(player.getYaw(), player.getPitch());
        if (settledSupport && tick - entered >= 2) {
            // This is only a new position to inspect. It is not a planned arrival or recovery receipt.
            scanFromHere("interrupted step settled on observed support; ");
            return;
        }
        if (tick - entered >= STEP_SETTLE_TICKS)
            fail("interrupted temporary step did not settle onto dry support (" + report.detail() + ")");
    }

    private BlockPos quietSupport() {
        return safeDryContact() && client.player.getVelocity().horizontalLengthSquared() <= 0.0025
            ? client.player.supportingBlockPos.orElse(null) : null;
    }

    private boolean safeDryContact() {
        if (!dryGround() || body.lavaEmergency() || client.player.isOnFire() || client.player.hurtTime > 0) return false;
        BlockPos support = client.player.supportingBlockPos.orElse(null);
        return support != null && !DRY_DANGER.test(client.world.getBlockState(support));
    }

    private BlockHitResult stepTop(BlockPos support, BlockHitResult selected) {
        if (selected == null || !selected.getBlockPos().equals(support) || selected.getSide() != Direction.UP) return null;
        BlockHitResult seen = body.terrain(selected.getPos().add(0, -0.04, 0), 4.15).orElse(null);
        return seen != null && seen.getBlockPos().equals(support) && seen.getSide() == Direction.UP
            && Math.abs(seen.getPos().y - support.getY() - 1) < 0.01 ? seen : null;
    }

    private void failStep(String reason) {
        departures.reject(from, from.up());
        fail("temporary step at " + from.toShortString() + ": " + reason);
    }

    static boolean retryWindowOpen(int elapsed, boolean replanning, boolean mineRetryLease) {
        int baseline = replanning ? HANDBACK_TICKS : RETRY_TICKS;
        return elapsed < baseline || mineRetryLease && elapsed < baseline + MINE_RETRY_GRACE_TICKS;
    }

    private void retry(String reason) {
        anchor = client.player.getPos();
        if (blockedReason != null) {
            BlockPos support = quietSupport();
            if (support != null) {
                assessedSupports.add(support);
                departures.stoodOn(client.player.getBlockPos());
                lastAssessedFeet = anchor;
            }
        }
        novelCells = movedCells = retryRouteCells = 0;
        navigationRetry = false;
        retrySurvey = surveySequence;
        mineSince = 0;
        mining = null;
        transition(Phase.RETRY, reason);
    }

    private void nextAttempt(String reason) {
        transition(Phase.PENDING, reason);
    }

    private void fail(String reason) {
        failures++;
        replanOnAssessment = phase == Phase.RETRY || !tookControl;
        if ((phase == Phase.STEP || phase == Phase.SETTLE) && quietSupport() == null)
            reason += "; last observed pose unstable (no settled dry support)";
        body.pauseWork();
        observedQuietSupport = quietSupport();
        observedQuietAge = client.player.age;
        quietTicks = observedQuietSupport == null ? 0 : 1;
        lastAssessedFeet = observedQuietSupport == null ? null : client.player.getPos();
        if (observedQuietSupport != null) assessedSupports.add(observedQuietSupport);
        blockedReason = reason;
        alternativeCheckAt = tick;
        transition(Phase.ASSESS, reason);
    }

    private void transition(Phase next, String detail) {
        if (phase == Phase.DEPART && next != Phase.DEPART) {
            // Even if the player is still airborne, retire only the exact driven rise.
            if (next != Phase.RETRY && departureTread != null && departureTread.inFlight())
                departures.reject(departureTread.from, departureTread.to);
            departureRise = null;
            departureTread = null;
        }
        phase = next;
        if (next == Phase.WATCH) blockedReason = null;
        entered = tick;
        report = new Report(incidents, attempts, recoveries, failures, next.name().toLowerCase(java.util.Locale.ROOT),
            detail, ++eventSequence, incidentTick);
    }

    private boolean dryGround() {
        var player = client.player;
        return player.isOnGround() && !player.isTouchingWater() && !player.isInLava() && !player.hasVehicle();
    }

    private boolean fullSupport(BlockHitResult seen) {
        return fullSupport(seen, client.world.getBlockState(seen.getBlockPos()));
    }

    private boolean fullSupport(BlockHitResult seen, BlockState state) {
        // Side solidity is an attachment rule; vanilla leaves have no solid sides
        // but their collision is a full cube that can carry the player and a block item.
        return safeSupport.test(seen)
            && Block.isShapeFullCube(state.getCollisionShape(client.world, seen.getBlockPos()));
    }

    private boolean awayFromCredits(Vec3d feet) {
        for (Vec3d previous : travelCredits) if (previous != null && previous.squaredDistanceTo(feet) <= 6.25) return false;
        return true;
    }

    private static boolean contains(BlockPos[] cells, BlockPos p) {
        for (BlockPos cell : cells) if (p.equals(cell)) return true;
        return false;
    }

    private static boolean neighbor(BlockPos a, BlockPos b) {
        return Math.abs(a.getY() - b.getY()) <= 1
            && Math.abs(a.getX() - b.getX()) + Math.abs(a.getZ() - b.getZ()) == 1;
    }

    private static float yaw(Vec3d delta) {
        return (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
    }
}
