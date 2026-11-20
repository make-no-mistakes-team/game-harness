package io.gameharness.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.gameharness.survival.mixin.AgentMiningAccess;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import net.minecraft.block.AbstractFurnaceBlock;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.enchantment.EnchantmentHelper;
import net.minecraft.enchantment.Enchantments;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.GameMode;

/** Camera witnesses and short, cancellable vanilla actions. The host sends IDs, never input or source. */
final class AgentMacroControl {
    private static final int OBSERVATION_INTERVAL = 5;
    private static final long PLANNING_IDLE_LIMIT_NS = 3_000_000_000L;
    // Leave time for a bounded probe and rendered camera motion, not just a turn command.
    private static final long CAMERA_DISPATCH_LEAD_NS = 600_000_000L;
    private static final long PLAN_SETTLEMENT_GRACE_NS = 750_000_000L;
    private static final int MAX_AGE = 1_200;
    private static final int MAX_HANDOFF_AGE = 100;
    private static final int MAX_WORK_ADMISSION_AGE = 40;
    private static final int PERSONAL_HANDOFF_TICKS = 12;
    private static final long PERSONAL_HANDOFF_NS = 600_000_000L;
    private static final int FURNACE_CLICK_MARGIN = 120;
    private static final int FURNACE_SYNC_TICKS = 24;
    private static final int MAX_ROUTE_EDGES = 8;
    private static final int MAX_OFFERS = 16;
    private static final int MAX_MATERIAL_TARGETS = 4_096;
    private static final int APPROACH_SETTLE_TICKS = 3;
    private static final int MAX_SOURCE_FOOTHOLDS = 5;
    private static final String SURFACE_CAP = "surface_cap";
    private static final double INSPECT_REACH = 16;
    private static final double TIMBER_RECALL_RANGE = 9;
    private static final int TIMBER_RECALL_TICKS = 220;
    private static final int TIMBER_RECALL_LIMIT = 16;
    private static final int STATION_RECALL_TICKS = 900;
    private static final long STATION_RECALL_NS = 45_000_000_000L;
    private static final double STATION_RECALL_STANCE_SQUARED = 0.75 * 0.75;
    private static final double PICKUP_STANCE_SQUARED = 1.20 * 1.20;
    private static final double SETTLED_SPEED_SQUARED = 0.001225;
    private static final Direction[] CARDINAL = {Direction.SOUTH, Direction.WEST, Direction.NORTH, Direction.EAST};
    private static final int[] WALK_PITCH_OFFSETS = {0, -4, 4, -8, 8, -12, 12, -16, 16};
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final Pattern HASH = Pattern.compile("(?:sha256:)?[0-9a-f]{64}");
    private static final Predicate<ItemStack> LOG = stack -> stack.isIn(ItemTags.LOGS)
        || stack.isIn(ItemTags.BAMBOO_BLOCKS);
    private static final Predicate<ItemStack> PLANK = stack -> stack.isIn(ItemTags.PLANKS);
    private static final Predicate<ItemStack> STICK = stack -> stack.isOf(Items.STICK);
    private static final Predicate<ItemStack> STONE = stack -> stack.isIn(ItemTags.STONE_TOOL_MATERIALS);
    private static final Predicate<ItemStack> IRON = stack -> stack.isOf(Items.IRON_INGOT);
    private static final Predicate<ItemStack> DIAMOND = stack -> stack.isOf(Items.DIAMOND);
    private static final BlockState[] EARLY_SOURCES = {
        Blocks.STONE.getDefaultState(), Blocks.COBBLESTONE.getDefaultState(),
        Blocks.DEEPSLATE.getDefaultState(), Blocks.COBBLED_DEEPSLATE.getDefaultState(),
        Blocks.COAL_ORE.getDefaultState(), Blocks.DEEPSLATE_COAL_ORE.getDefaultState(),
        Blocks.IRON_ORE.getDefaultState(), Blocks.DEEPSLATE_IRON_ORE.getDefaultState()
    };

    private enum Verb {
        SURVEY("survey", "read", 30), DRY_SURVEY("survey", "guarded", 56),
        STATION_REACQUIRE("survey", "read", 40),
        INSPECT("inspect", "read", 30), APPROACH("approach", "low", 65),
        INTERACT("interact", "guarded", 40), COLLECT("collect", "guarded", 38), BREAK("break", "guarded", 120),
        CONTINUE("continue", "guarded", 320), FOLLOW("follow", "guarded", 640),
        WORK_WALK("work_walk", "guarded", 160), WORK_EQUIP("work_equip", "guarded", 120),
        WORK_PLACE("work_place", "guarded", 80), WORK_TREAD("work_tread", "guarded", AgentSurfaceTread.ACTION_TICKS),
        WORK_SMELT("work_smelt", "guarded", AgentWorkOrder.MAX_TICKS),
        WATER_CLUE("fill_water", "read", 0), WORK_FILL("work_fill", "guarded", 72);

        final String id, risk;
        final int maxTicks;
        Verb(String id, String risk, int maxTicks) {
            this.id = id; this.risk = risk; this.maxTicks = maxTicks;
        }
    }

    /** All world geometry and entity identities stay private to the native thread. */
    private record Floor(BlockPos pos, BlockState state, Vec3d landing) {}
    private record Face(BlockHitResult hit, BlockState state) {}
    private record StationPlacement(BlockPos pos, BlockState state, Vec3d stance, long framedAfter, long until) {}
    private static final class PersonalStation {
        final Face face;
        final Vec3d stance;
        final long tick, time;
        final int sequence;
        boolean attempted;

        PersonalStation(Face face, Vec3d stance, long tick, long time, int sequence) {
            this.face = face;
            this.stance = stance;
            this.tick = tick;
            this.time = time;
            this.sequence = sequence;
        }
    }
    private record TimberSight(Face face, long seen) {}
    private record TimberHarvest(BlockPos block, BlockState state, Vec3d stance, Item item, int stock, long tick) {}
    private record Key(Verb verb, BlockPos pos, int entity, String activity, Direction side, BlockState state) {
        Key(Verb verb, BlockPos pos, int entity, String activity) {
            this(verb, pos, entity, activity, null, null);
        }
    }
    private record Recipe(String id, Item result, Predicate<ItemStack> material, int amount, int sticks) {}
    private static final Recipe PLANKS = new Recipe("planks", null, LOG, 1, 0);
    private static final Recipe STICKS = new Recipe("stick", Items.STICK, PLANK, 2, 0);
    private static final Recipe BENCH = new Recipe("crafting_table", Items.CRAFTING_TABLE, PLANK, 4, 0);
    private static final Recipe[] BENCH_RECIPES = {
        new Recipe("wooden_pickaxe", Items.WOODEN_PICKAXE, PLANK, 3, 2),
        new Recipe("stone_pickaxe", Items.STONE_PICKAXE, STONE, 3, 2),
        new Recipe("iron_pickaxe", Items.IRON_PICKAXE, IRON, 3, 2),
        new Recipe("diamond_pickaxe", Items.DIAMOND_PICKAXE, DIAMOND, 3, 2)
    };

    private record Offer(String id, Key key, String summary, String evidence, float yaw, float pitch,
                         Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe,
                         AgentDryCaveRoute.Offer route, Floor farther, AgentDryCaveRoute.Survey drySurvey) {
        Offer(String id, Key key, String summary, String evidence, float yaw, float pitch,
              Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe) {
            this(id, key, summary, evidence, yaw, pitch, floor, face, drop, item, recipe, null, null, null);
        }
        Offer(String id, Key key, String summary, String evidence, float yaw, float pitch,
              Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe, AgentDryCaveRoute.Offer route) {
            this(id, key, summary, evidence, yaw, pitch, floor, face, drop, item, recipe, route, null, null);
        }
        Offer(String id, Key key, String summary, String evidence, float yaw, float pitch,
              Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe, AgentDryCaveRoute.Offer route, Floor farther) {
            this(id, key, summary, evidence, yaw, pitch, floor, face, drop, item, recipe, route, farther, null);
        }
    }
    private record Snapshot(long epoch, Map<String, Offer> offers) {}
    private record Intent(String id, int life, long epoch, long basis, long expires, String opportunity, String skillHash) {}
    private record Handoff(int life, long epoch, long basis, long expires) {}
    private record Planning(int life, long epoch, long basis, String id, long noticedAt) {}
    private record WorkMailbox(boolean present, AgentWorkOrder order) {}
    private record PersonalCraft(AgentWorkOrder order, long untilTick, long untilNanos, boolean tableInReach) {}
    private record Inbox(boolean active, Intent intent, Handoff handoff, Planning planning, WorkMailbox work) {}
    private record Camera(float yaw, float pitch) {}
    private record Output(String file, String value) {}

    private static final class InventoryWitness {
        private static final class Tally { int original, remaining; }
        private final Map<Item, Tally> counts = new IdentityHashMap<>();

        InventoryWitness(PlayerInventory inventory) {
            for (int i = 0; i < inventory.size(); ++i) {
                ItemStack stack = inventory.getStack(i);
                if (!stack.isEmpty()) counts.computeIfAbsent(stack.getItem(), item -> new Tally()).original += stack.getCount();
            }
        }

        Item gain(PlayerInventory inventory) {
            counts.forEach((item, tally) -> tally.remaining = tally.original);
            for (int i = 0; i < inventory.size(); ++i) {
                ItemStack stack = inventory.getStack(i);
                if (stack.isEmpty()) continue;
                Tally tally = counts.get(stack.getItem());
                if (tally == null || (tally.remaining -= stack.getCount()) < 0) return stack.getItem();
            }
            return null;
        }
    }

    private static final class Action {
        final Intent intent;
        final Offer offer;
        final long started, startedAt, startingFrame;
        final Vec3d position;
        final float yaw, pitch;
        final int itemCount;
        final InventoryWitness walkInventory;
        final Camera camera;
        final ItemStack harvestTool;
        final Offer[] keepVisible;
        final float pathYaw, pathPitch;
        boolean drove, fired, broken, purposefulMotion, durable, tableInReach, prospectCover;
        boolean diamondRoute, prospectLight;
        float lastCrack;
        long firedAt, placementFrame, pickupDisappeared, craftJob, priorCraftReceipt, settledAt, lastMissingFrame;
        int missingFaceFrames;
        String unexpectedPickup;
        Screen opened;
        Vec3d destination, walkFrom;
        boolean secondHop;
        boolean timberWalk;
        long timberDropSeen;
        AgentSurfaceTread tread;
        ProspectSupport prospectSupport;
        ItemEntity stairDrop;
        double distanceLeft;
        int workSlot, executions, handLoss, stairStock;
        Item tracked;
        FurnaceWork furnace;
        boolean waterUseEntered, waterUseReceipt;

        Action(Intent intent, Offer offer, MinecraftClient client, long tick, long now, long frame, int itemCount,
               Offer[] keepVisible, float chosenWalkPitch) {
            this.intent = intent;
            this.offer = offer;
            started = tick;
            startedAt = now;
            startingFrame = frame;
            position = client.player.getPos();
            walkFrom = position;
            yaw = client.player.getYaw();
            pitch = client.player.getPitch();
            this.itemCount = itemCount;
            this.keepVisible = keepVisible;
            pathYaw = offer.floor == null ? yaw : heading(offer.floor.landing.x - position.x, offer.floor.landing.z - position.z);
            pathPitch = Float.isNaN(chosenWalkPitch) ? MathHelper.clamp(pitch, 12, 42) : chosenWalkPitch;
            if (offer.floor != null) distanceLeft = horizontalSquared(position, offer.floor.landing);
            if (offer.route != null) distanceLeft = horizontalSquared(position, Vec3d.ofBottomCenter(offer.route.endpoint()));
            walkInventory = offer.key.verb == Verb.APPROACH || offer.key.verb == Verb.FOLLOW
                ? new InventoryWitness(client.player.getInventory()) : null;
            harvestTool = offer.key.verb == Verb.BREAK ? client.player.getMainHandStack().copy() : ItemStack.EMPTY;
            camera = switch (offer.key.verb) {
                case SURVEY -> new Camera(offer.yaw, offer.pitch);
                case INSPECT, STATION_REACQUIRE -> {
                    Vec3d point = offer.face.hit.getPos().subtract(client.player.getEyePos());
                    yield new Camera(heading(point.x, point.z), (float) Math.toDegrees(
                        Math.atan2(-point.y, Math.hypot(point.x, point.z))));
                }
                default -> null;
            };
        }
    }

    private enum FurnacePhase { LOADING, LOADED, BURNING, COLLECTING, RETURNING }

    private static final class FurnaceWork {
        final BlockPos footing;
        FurnacePhase phase;
        AgentHands.IronBatch batch;
        long openedTick, outputWitness, advancedTick, burnTick, storedTick;
        int rawBefore, fuelBefore, ingotsBefore, output, fuelRemaining, returnedStock;
        float progress;

        FurnaceWork(BlockPos footing) { this.footing = footing; }
    }

    private static final class WorkSession {
        AgentWorkOrder order;
        final AgentWorkOrder.Budget budget;
        final SourceSearch sourceSearch;
        final Set<BlockPos> rejected = new HashSet<>();
        final Set<Integer> rejectedDrops = new HashSet<>();
        final LongOpenHashSet timberApproaches = new LongOpenHashSet();
        long deadline;
        BlockPos lastHarvest;
        long lastHarvestTick;
        Item lastHarvestItem;
        TimberSight timberLook;
        long timberLookUntil, timberLookFrame;
        boolean timberLookUsed;
        long lastEffectTick, completedTick;
        String lastEffect;
        BlockPos placedFurnace;
        boolean collectedIron;
        Offer waterClue;
        long ironSiteLookUntil;
        float ironSiteYaw;
        String sourceBlock;
        boolean lowerHarvest;
        int confirmedBreaks, confirmedCrafts, confirmedPlacements, startingStock, startingDeepTreads;
        String enactedPhase = "hold", enactedStatus = "No physical step has started.";
        String phase = "working", detail = "Current local evidence admits this bounded work order.";

        WorkSession(AgentWorkOrder order, AgentWorkOrder.Budget budget, SourceSearch sourceSearch, long deadline) {
            this.order = order;
            this.budget = budget;
            this.sourceSearch = sourceSearch;
            this.deadline = deadline;
        }

        boolean active() { return phase.equals("working"); }
    }

    private static final class SourceSearch {
        final Set<BlockPos> footholds = new HashSet<>();
        final Set<BlockPos> attempted = new HashSet<>();
        final Set<BlockPos> looked = new HashSet<>();
        final ArrayDeque<AgentSurfaceTread.Edge> stairs = new ArrayDeque<>();
        BlockPos lookedFrom, cutFrom, firstCover, lastCover, blockedAt;
        BlockState cutSupport;
        Direction cutBearing;
        long viewUntil, freshAfter = -1;
        BlockPos stairAim, clearStairUpper, clearStairLower, clearStairLip;
        long stairAimUntil;
        float viewYaw;
        int steps;
        boolean stairUsed, returning, returnFailed;
        String returnReason;
    }

    private record DiamondSpine(AgentSurfaceTread.Edge edge, Direction preferred, int nextDescent, int levelFloors,
                                int levelWalls, int levelGaps, int triedLevel, String refusal) {}

    /** One positively observed build candidate. No input or stock is owned outside its work action. */
    private static final class ProspectSupport {
        final BlockPos from, to, cell;
        final Direction bearing;
        final Vec3d low, high, floor, alternateFloor;
        int anchorIndex, countBefore;
        long faceUntil;
        boolean spaceSeen;

        ProspectSupport(BlockPos from, BlockPos to, Direction bearing) {
            this.from = from;
            this.to = to;
            this.bearing = bearing;
            cell = to.down();
            low = AgentBody.footholdInterior(cell, bearing, false);
            high = AgentBody.footholdInterior(cell, bearing, true);
            floor = Vec3d.ofBottomCenter(to).add(bearing.getOffsetX() * 0.27, -0.032, bearing.getOffsetZ() * 0.27);
            alternateFloor = Vec3d.ofBottomCenter(to).add(bearing.getOffsetX() * 0.14, -0.032, bearing.getOffsetZ() * 0.14);
        }

        Direction anchorOffset() {
            return switch (anchorIndex) {
                case 0 -> bearing;
                case 1 -> bearing.rotateYClockwise();
                case 2 -> bearing.rotateYCounterclockwise();
                default -> Direction.DOWN;
            };
        }
    }

    private static final class DiamondRoute {
        final Set<BlockPos> supports = new HashSet<>();
        final Set<BlockPos> attemptedSupports = new HashSet<>();
        final Set<BlockPos> placedSupports = new HashSet<>();
        final ArrayDeque<DiamondSpine> spine = new ArrayDeque<>();
        BlockPos foot, aimCell, unjoined;
        Direction preferred, bearing;
        BlockState support;
        int bearingIndex, clearMask, levelFloors, levelWalls, levelGaps, triedLevel, shelves, rises, treads, levelLegs, supportedLandings, lowest;
        long aimUntil;
        boolean surveyed, cutting, level;
        String refusal, levelRefusal, supportRefusal;

        void arrive(BlockPos at, BlockState groundedSupport, Direction heading) {
            if (foot == null) lowest = at.getY();
            foot = at.toImmutable();
            support = groundedSupport;
            supports.add(foot.down());
            preferred = bearing = heading;
            bearingIndex = clearMask = levelFloors = levelWalls = levelGaps = triedLevel = 0;
            aimCell = null;
            surveyed = cutting = level = false;
            refusal = levelRefusal = supportRefusal = null;
        }

        void nextBearing(String detail) {
            if (level) {
                levelRefusal = detail;
            } else {
                if (refusal == null || detail.contains("minecraft:") && !refusal.contains("minecraft:")) refusal = detail;
                bearing = descentBearing(++bearingIndex);
            }
            aimCell = null;
            clearMask = 0;
            surveyed = cutting = level = false;
        }

        Direction descentBearing(int index) {
            return switch (index) {
                case 0 -> preferred;
                case 1 -> preferred.rotateYClockwise();
                case 2 -> preferred.getOpposite();
                default -> preferred.rotateYCounterclockwise();
            };
        }

        void advance(AgentSurfaceTread.Edge edge) {
            spine.addLast(new DiamondSpine(edge, preferred, level ? bearingIndex : bearingIndex + 1,
                levelFloors, levelWalls, levelGaps, triedLevel, refusal));
            arrive(edge.lower(), edge.lowerSupport(), edge.down());
        }

        void returnOne() {
            var branch = spine.removeLast();
            arrive(branch.edge.upper(), branch.edge.upperSupport(), branch.preferred);
            bearingIndex = branch.nextDescent;
            bearing = descentBearing(bearingIndex);
            levelFloors = branch.levelFloors;
            levelWalls = branch.levelWalls;
            levelGaps = branch.levelGaps;
            triedLevel = branch.triedLevel;
            refusal = branch.refusal;
        }
    }

    private final String run, goal;
    private final Ipc ipc;
    private final boolean activated, trial;
    private final LinkedHashMap<Long, Snapshot> snapshots = new LinkedHashMap<>();
    private final LinkedHashMap<Key, String> ids = new LinkedHashMap<>();
    private final Map<Key, String> materialTargets = new HashMap<>();
    private final LinkedHashMap<String, Boolean> consumed = new LinkedHashMap<>();
    private final Set<Key> retiredViews = new HashSet<>();
    private final Set<BlockPos> localSteps = new HashSet<>();
    private final LinkedHashMap<BlockPos, TimberSight> timberSights = new LinkedHashMap<>();
    private final ArrayDeque<String> recent = new ArrayDeque<>(8);
    private final Predicate<ItemStack> safetySpend = this::canSpendSafetyStock;
    private List<Offer> reservedOffers = List.of();
    private static final Offer[] NO_ANCHORS = {};
    private long reservationEpoch, reservationUntil;
    private MinecraftClient client;
    private AgentBody body;
    private AgentHands hands;
    private AgentProgress routeOwner;
    private Offer drySurveyOffer;
    private String dryOfferEvidence;
    private Offer routeOffer;
    private Screen shown;
    private ClientWorld world;
    private ClientPlayerEntity player;
    private ItemStack scopedMainHand = ItemStack.EMPTY;
    private Vec3d anchor;
    private float surveyYaw;
    private long tick, epoch, nextId, nextMaterialId, lastObservation, inventoryStamp, safetyRevision;
    private long fallbackTicks;
    private long fallbackActions, blockedCount, urgentCount, lastPurposefulTick;
    private long now, idleSince, waitElapsed, waitTotal, waitMaximum, waitOvershoot, nextLocalProbe;
    private long rawNoWorkSince, rawNoWorkMax, rawNoWorkTotal, planningNoticeTick, planningNoticeNanos;
    private int life, surveyOrigin;
    private Inbox input;
    private Action action;
    private WorkSession work;
    private TimberHarvest timberHarvest;
    private PersonalStation personalTable, personalFurnace;
    private StationPlacement stationPlacement;
    private int stationSequence;
    private long timberFrame = -1;
    private SourceSearch surfaceSearch = new SourceSearch();
    private DiamondRoute diamondRoute = new DiamondRoute();
    private PersonalCraft personalCraft;
    private AgentPauseEpisodes.Work continuityWork;
    private long lastHandsEvidence;
    private long waterReceiptUntil;
    private boolean suspended, visited, owned, hazardClear, lastHazard, quiescent, urgent, blocked, deadlineMeasured;
    private boolean urgentInput;
    private boolean rawPending, rawWorking;
    private String planningState = "awaiting_plan", planningEvidence = "No provider decision is pending.";
    private String activePlanningId, lastPurposefulAction, lastUrgency, blockedReason, localHoldReason;
    private boolean trialUsed, revocationSeen, revocationAcknowledged;
    private String owner = "deterministic";
    private String status = "waiting for a current local plan";

    static AgentMacroControl create(Path directory, String goal) {
        Path macro = directory.resolve("macro");
        String run = directory.getFileName().toString();
        // Startup-only admission. Inactive deterministic runs allocate no channel or thread.
        if (!TOKEN.matcher(run).matches()) return null;
        boolean trial = Ipc.marked(macro, run, "trial.json");
        String marker = Ipc.activeMode(macro, run);
        return trial || marker != null ? new AgentMacroControl(macro, run, goal, marker, trial) : null;
    }

    private AgentMacroControl(Path directory, String run, String goal, String mode, boolean trial) {
        this.run = run;
        this.goal = goal;
        this.activated = mode != null;
        this.trial = trial;
        ipc = new Ipc(directory, run, mode);
    }

    void begin(MinecraftClient client, AgentBody body, AgentHands hands, Screen shown, long tick, int life) {
        if (owned && this.body == body && ((action == null ? work == null || !work.active()
                : !action.durable && action.offer.key.verb != Verb.BREAK)
                || client.player != player || client.world != world)) body.pauseWork();
        suspended = owned = visited = hazardClear = false;
        this.client = client;
        this.body = body;
        this.hands = hands;
        this.shown = shown;
        this.tick = tick;
        continuityWork = null;
        sampleClock();
        input = ipc.inbox;
        owner = engaged() ? "safety" : "deterministic";
        if (this.life != life || world != client.world || player != client.player) {
            interrupt("The player life or dimension changed.", false);
            retireWork("needs_replan", "interrupted", "The player life or dimension changed.");
            work = null;
            waterReceiptUntil = 0;
            timberSights.clear();
            timberHarvest = null;
            personalTable = personalFurnace = null;
            stationPlacement = null;
            timberFrame = -1;
            surfaceSearch = new SourceSearch();
            diamondRoute = new DiamondRoute();
            this.life = life;
            world = client.world;
            player = client.player;
            ++epoch;
            ++safetyRevision;
            snapshots.clear();
            ids.clear();
            materialTargets.clear();
            recent.clear();
            anchor = null;
            inventoryStamp = 0;
            scopedMainHand = ItemStack.EMPTY;
            lastHazard = false;
            localSteps.clear();
            reservedOffers = List.of();
            routeOffer = drySurveyOffer = null;
            dryOfferEvidence = null;
            activePlanningId = null;
            idleSince = now;
            nextLocalProbe = 0;
            blocked = deadlineMeasured = false;
            waitElapsed = 0;
            rawPending = rawWorking = false;
            lastHandsEvidence = hands.workEvidence();
        }
        if (personalTable != null && !stationClueCurrent(personalTable)) personalTable = null;
        if (personalFurnace != null && !stationClueCurrent(personalFurnace)) personalFurnace = null;
        body.safetySpend(safetySpend());
        observePlanning();
    }

    boolean engaged() { return input != null && (trial || activated); }
    boolean hasAction() { return action != null; }
    boolean hasActiveWorkOrder() { return work != null && work.active(); }
    boolean invocationFinishAllowed() {
        return !"constrained".equals(ipc.workMode)
            && !hasActiveWorkOrder() && (work == null || missingWorkFloor() == null);
    }
    AgentPauseEpisodes.Work continuityWork() { return continuityWork; }
    Predicate<ItemStack> safetySpend() {
        return work == null || work.budget.policy.floors().isEmpty() ? null : safetySpend;
    }

    private boolean canSpendSafetyStock(ItemStack stack) {
        if (work == null || stack.isEmpty()) return true;
        Item item = stack.getItem();
        int floor = work.budget.floor(item);
        if (floor == 0) return true;
        return count(item) > floor;
    }
    String status() { return status; }
    String owner() { return owner; }
    boolean trial() { return trial; }
    String planningState() { return planningState; }
    String planningEvidence() { return planningEvidence; }
    long lastPurposefulTick() { return lastPurposefulTick; }
    long planningIdleDeadlineNanos() { return idleSince + PLANNING_IDLE_LIMIT_NS; }

    private static double millis(long nanos) { return nanos / 1_000_000.0; }

    void addPlanningTelemetry(JsonObject event) {
        event.addProperty("macro_planning_state", planningState);
        event.addProperty("macro_planning_evidence", planningEvidence);
        event.addProperty("macro_wait_elapsed_ms", millis(waitElapsed));
        event.addProperty("macro_wait_max_idle_ms", millis(waitMaximum));
        event.addProperty("macro_wait_max_overshoot_ms", millis(waitOvershoot));
        event.addProperty("macro_wait_total_ms", millis(waitTotal));
        event.addProperty("macro_wait_max_no_work_ms", millis(rawNoWorkMax));
        event.addProperty("macro_wait_total_no_work_ms", millis(rawNoWorkTotal));
        event.addProperty("macro_blocked_count", blockedCount);
        event.addProperty("macro_urgent_count", urgentCount);
        event.addProperty("macro_fallback_ticks", fallbackTicks);
        event.addProperty("macro_fallback_actions", fallbackActions);
        if (planningNoticeTick == 0) {
            event.add("macro_planning_marker_notice_tick", JsonNull.INSTANCE);
            event.add("macro_planning_marker_notice_monotonic_ns", JsonNull.INSTANCE);
        } else {
            event.addProperty("macro_planning_marker_notice_tick", planningNoticeTick);
            event.addProperty("macro_planning_marker_notice_monotonic_ns", Long.toString(planningNoticeNanos));
        }
        if (lastPurposefulTick == 0) {
            event.add("macro_last_purposeful_tick", JsonNull.INSTANCE);
            event.add("macro_last_purposeful_action", JsonNull.INSTANCE);
        } else {
            event.addProperty("macro_last_purposeful_tick", lastPurposefulTick);
            event.addProperty("macro_last_purposeful_action", lastPurposefulAction);
        }
    }

    private void state(String state, String evidence) {
        planningState = state;
        planningEvidence = evidence;
    }

    private void sampleClock() {
        long sample = System.nanoTime();
        if (planningState.equals("planning_wait")) {
            waitTotal += sample - now;
            measureIdle(sample);
        }
        if (rawPending) {
            if (rawWorking) rawNoWorkSince = sample;
            else {
                rawNoWorkTotal += sample - now;
                rawNoWorkMax = Math.max(rawNoWorkMax, sample - rawNoWorkSince);
            }
        }
        now = sample;
    }

    private void observePlanning() {
        Planning planning = input.planning;
        boolean pending = !trial && planning != null && planning.life == life && planning.basis <= tick
            && planning.epoch <= epoch && (planning.id.equals(activePlanningId) || tick - planning.basis <= MAX_AGE);
        if (pending) {
            if (!planning.id.equals(activePlanningId)) {
                planningNoticeTick = tick;
                planningNoticeNanos = planning.noticedAt;
                activePlanningId = planning.id;
                Snapshot basis = snapshots.get(planning.basis);
                reservedOffers = basis != null && basis.epoch == epoch ? basis.offers.values().stream()
                    .filter(AgentMacroControl::materialFace).toList() : List.of();
                reservationEpoch = epoch;
            }
            reservationUntil = now + PLAN_SETTLEMENT_GRACE_NS;
            if (!rawPending) rawNoWorkSince = Math.max(idleSince, planning.noticedAt);
        }
        rawPending = pending;
    }

    private void measureIdle(long sample) {
        if (deadlineMeasured) return;
        waitElapsed = sample - idleSince;
        waitMaximum = Math.max(waitMaximum, waitElapsed);
        if (waitElapsed >= PLANNING_IDLE_LIMIT_NS) {
            deadlineMeasured = true;
            waitOvershoot = Math.max(waitOvershoot, waitElapsed - PLANNING_IDLE_LIMIT_NS);
        }
    }

    private void purposeful(String detail) {
        lastPurposefulTick = tick;
        lastPurposefulAction = detail;
        idleSince = now;
        blocked = deadlineMeasured = false;
        waitElapsed = 0;
        if (rawPending) rawNoWorkSince = now;
    }

    void urgent(String detail) {
        if (!engaged()) return;
        boolean existing = urgent;
        urgent = true;
        interrupt("Immediate safety took control: " + detail, true);
        if (!existing) {
            ++urgentCount;
            remember("safety: " + detail);
        }
        lastUrgency = detail;
        state("urgent", detail);
    }

    void safetyEffect(String detail) {
        if (!engaged()) return;
        continuityWork = AgentPauseEpisodes.Work.SAFETY;
        remember("safety completed: " + detail);
        purposeful("safety: " + detail);
    }

    /** Called only after the existing fall, danger and emergency food controllers declined ownership. */
    void control(AgentProgress progress) {
        visited = true;
        hazardClear = !body.lavaEmergency() && !body.macroLavaNear()
            && !client.player.isOnFire() && !client.player.isInLava() && client.player.hurtTime == 0;

        if (!input.active) {
            claim(trial ? "trial_idle" : "local_handoff");
            interrupt("The host revoked macro authority.", true);
            retireWork("needs_replan", "interrupted", "The host revoked macro authority.");
            if (hands.busy()) hands.cancel();
            status = "macro authority is inactive";
            state("inactive", status);
            return;
        }
        sampleClock();
        witnessStationPlacement();
        // An accepted direct intent owns the input path even when its tick is
        // neutral (e.g. one missing route render). No work-order branch may steal it.
        if (!trial && ipc.workMode != null && (action == null || action.intent == null || action.durable)) {
            reconcileWork();
            if (hasActiveWorkOrder()) {
                workTick(progress);
                return;
            }
            if (personalCraft != null) {
                claim("work_order");
                holdWork();
                return;
            }
        }
        boolean thinking = rawPending;
        if (thinking && action == null && !blocked) measureIdle(now);
        if (action != null) {
            observePurposefulMotion();
            boolean local = action.intent == null;
            claim(local ? "local_motion" : "terra");
            if (local) ++fallbackTicks;
            state(local ? "local_in_progress" : "terra_in_progress", action.offer.summary);
            if (!local && (input.intent == null || !input.intent.equals(action.intent))) {
                interrupt("The host withdrew or replaced this intent.", true);
            } else if ((local ? now - action.startedAt >= PLANNING_IDLE_LIMIT_NS : tick > action.intent.expires)
                    || tick - action.started > action.offer.key.verb.maxTicks) {
                interrupt(timeoutDetail(), true);
            } else if (action.offer.route != null && (action.intent.epoch != epoch || !cursorClear())) {
                interrupt("The dry route's dependency epoch or clean-cursor premise changed.", true);
            } else if ((!grounded() && !progress.dryRouteInFlight(action.offer.route))
                    || !hazardClear || !client.isWindowFocused() || client.getOverlay() != null) {
                interrupt("Grounding, window focus, or local safety changed.", true);
            } else {
                step(progress);
            }
            return;
        }

        Intent intent = input.intent;
        boolean pending = intent != null && !consumed.containsKey(intent.id);
        if (pending) {
            updateScope(true);
            String refusal = intentScope(intent);
            if (refusal != null) {
                refuseUnseen(refusal);
                pending = false;
            }
        }
        boolean barrier = handoffCurrent(input.handoff);
        claim(pending || barrier ? "local_handoff" : trial ? "trial_idle" : "terra_idle");
        // No ordinary Hands job is advanced outside its action/safety authority.
        if (hands.busy()) hands.cancel();
        if (barrier && !pending) {
            status = "holding neutral for the prepared handoff";
            if (thinking && now - idleSince >= PLANNING_IDLE_LIMIT_NS) block("A prepared handoff owns the controls.");
            else state("handoff", status);
            return;
        }
        if (!pending) {
            if (ipc.workMode == null || trial) idle(progress, thinking);
            else holdWork();
            return;
        }
        Offer offer = snapshots.get(intent.basis).offers.get(intent.opportunity);
        String refusal = !available() ? "No neutral, grounded, safe first-person view." :
            trial && (trialUsed || !diagnosticVerb(offer.key.verb)) ? "The diagnostic admits one isolated reader action."
            : SURFACE_CAP.equals(offer.key.activity) && intent.skillHash != null ? "A generated skill cannot cut cover."
            : (offer.route != null || offer.drySurvey != null) && intent.skillHash != null
                ? "Only a direct Terra intent may survey or follow this dry route."
            : !trial && intent.skillHash != null && offer.key.verb == Verb.APPROACH
                ? "Reusable skills cannot approach while incidental pickup remains possible."
            : validate(offer, progress);
        if (refusal != null) {
            refuseUnseen(refusal);
            if (ipc.workMode == null || trial) idle(progress, thinking);
            else holdWork();
            return;
        }
        markConsumed(intent.id);
        owner = "terra";
        if (offer.route != null || offer.drySurvey != null) routeOwner = progress;
        action = new Action(intent, offer, client, tick, now, body.renderedFrame(),
            offer.item == null ? 0 : count(offer.item), NO_ANCHORS, Float.NaN);
        if (offer.key.verb == Verb.STATION_REACQUIRE) personalStation(offer.face.state.getBlock()).attempted = true;
        action.prospectCover = SURFACE_CAP.equals(offer.key.activity);
        if (trial) {
            trialUsed = true;
            if (!ipc.evidence("trial-witness.json", trialWitness().toString())) {
                action = null;
                return;
            }
        }
        receipt(intent, "accepted", "Current local evidence and controls rechecked.");
        state("terra_in_progress", offer.summary);
        step(progress);
    }

    private void observePurposefulMotion() {
        if (action.purposefulMotion) return;
        boolean witnessed = false;
        if (action.camera != null && body.renderedFrame() > action.startingFrame && body.hasRecentView()) {
            double distanceBefore = angle(action.yaw, action.pitch, action.camera.yaw, action.camera.pitch);
            double left = angle(player.getYaw(), player.getPitch(), action.camera.yaw, action.camera.pitch);
            witnessed = distanceBefore - left >= 5;
        } else if (action.drove && action.offer.route != null) {
            witnessed = horizontalSquared(action.position, player.getPos()) >= 0.16;
        } else if (action.drove) {
            Vec3d destination = action.offer.floor.landing;
            witnessed = horizontalSquared(action.position, destination) - horizontalSquared(player.getPos(), destination) >= 0.16;
        }
        if (witnessed) {
            action.purposefulMotion = true;
            purposeful((action.intent == null ? "local_motion: " : "terra: ") + action.offer.summary);
        }
    }

    private static boolean diagnosticVerb(Verb verb) {
        return verb == Verb.APPROACH || verb == Verb.SURVEY || verb == Verb.INSPECT;
    }

    private JsonObject trialWitness() {
        JsonObject witness = header(run);
        witness.addProperty("life", action.intent.life);
        witness.addProperty("epoch", action.intent.epoch);
        witness.addProperty("basisTick", action.intent.basis);
        witness.addProperty("intentId", action.intent.id);
        witness.addProperty("opportunityId", action.intent.opportunity);
        witness.addProperty("verb", action.offer.key.verb.id);
        witness.addProperty("acceptedTick", tick);
        JsonObject target = new JsonObject();
        if (action.camera != null) {
            target.addProperty("kind", "camera");
            target.addProperty("yaw", action.camera.yaw);
            target.addProperty("pitch", action.camera.pitch);
        } else {
            Vec3d landing = action.offer.floor.landing;
            target.addProperty("kind", "position");
            target.addProperty("x", landing.x);
            target.addProperty("y", landing.y);
            target.addProperty("z", landing.z);
        }
        witness.add("target", target);
        return witness;
    }

    private String intentScope(Intent intent) {
        if (intent.life != life || intent.epoch != epoch) return "The opportunity's life or dependency epoch changed.";
        if (intent.basis > tick || tick - intent.basis > MAX_AGE || tick > intent.expires) return "The intent expired.";
        var snapshot = snapshots.get(intent.basis);
        return snapshot != null && snapshot.epoch == epoch && snapshot.offers.containsKey(intent.opportunity)
            ? null : "Opportunity not offered in that observation.";
    }

    private boolean handoffCurrent(Handoff request) {
        if (request == null || request.life != life || request.epoch != epoch || tick > request.expires
                || request.basis > tick || tick - request.basis > MAX_HANDOFF_AGE) return false;
        var snapshot = snapshots.get(request.basis);
        return snapshot != null && snapshot.epoch == epoch;
    }

    private void claim(String actualOwner) {
        owner = actualOwner;
        owned = true;
        if (!actualOwner.equals("work_order")
                && (action == null || action.offer.key.verb != Verb.BREAK || !actualOwner.equals("terra"))) body.pauseWork();
    }

    private void reconcileWork() {
        WorkMailbox mailbox = input.work;
        if (hasActiveWorkOrder()) {
            String invalid = !mailbox.present ? "The host withdrew the work order."
                : (work.budget.policy.smeltIron() || work.budget.policy.waterFill())
                    && (mailbox.order == null || !work.order.id().equals(mailbox.order.id()))
                    ? "The host replaced the exact furnace or bucket work order."
                : tick >= work.order.expires() || now >= work.deadline ? "The finite work horizon expired."
                : !hazardClear || work.order.safetyRevision() != safetyRevision ? "The safety premise changed."
                : null;
            if (invalid != null) {
                interrupt(invalid, true);
                retireWork("needs_replan", "interrupted", invalid);
            }
        }
        AgentWorkOrder next = mailbox.order;
        boolean continuePersonal = false;
        if (personalCraft != null) {
            boolean finished = work.phase.equals("complete");
            if (!personalCraftCurrent() || finished && !confirmsWorkStock()) {
                releasePersonalCraft(true);
            } else {
                boolean sameMailbox = next != null && work.order.id().equals(next.id());
                continuePersonal = finished && next != null && next.id().equals(work.order.nextWorkId())
                    && next.basis() >= work.completedTick && !consumed.containsKey(next.id());
                // The host normally removes the completed mailbox before publishing its successor.
                if (!continuePersonal && !sameMailbox && (mailbox.present || !finished)) releasePersonalCraft(true);
            }
        }
        // A mutable echo cannot expand or interrupt the already accepted, immutable permission.
        if (work != null && next != null && work.order.id().equals(next.id())) return;

        if (next != null && !consumed.containsKey(next.id())) {
            updateScope(true);
            Snapshot basis = snapshots.get(next.basis());
            Offer water = next.policy() != null && next.policy().waterFill() && basis != null
                ? basis.offers.values().stream().filter(offer -> offer.key.verb == Verb.WATER_CLUE && offer.face != null)
                    .findFirst().orElse(null) : null;
            boolean samePolicy = work != null && work.order.policy().equals(next.policy())
                && next.basis() >= work.order.basis();
            boolean compatible = hasActiveWorkOrder() && samePolicy;
            if (next.policy() == null) {
                if (continuePersonal) releasePersonalCraft(true);
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The work order contains an unsupported target or effect.");
            } else if (next.life() != life || !compatible && next.epoch() != epoch || next.basis() > tick
                    || tick - next.basis() >= MAX_WORK_ADMISSION_AGE || tick >= next.expires()
                    || next.safetyRevision() != safetyRevision || basis == null || basis.epoch != next.epoch()
                    || next.policy().target().goal() != null && !next.policy().target().goal().equals(goal)) {
                if (continuePersonal) releasePersonalCraft(true);
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The work basis, preset goal, or safety premise changed.");
            } else if (next.policy().waterFill() && water == null) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The work basis has no exact witnessed source water in reach.");
            } else if (next.policy().waterFill() && tick <= waterReceiptUntil) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The previous source-water use is still inside its receipt window.");
            } else if (hazardClear && (action == null || action.durable
                    && (compatible || !action.diamondRoute || action.offer.key.verb == Verb.DRY_SURVEY))) {
                long deadline = now + (next.expires() - tick) * 50_000_000L;
                if (compatible) {
                    // A refreshed permission never restores spent budget or resets the live actuator.
                    receipt(work.order.id(), work.order.life(), "interrupted", "Replaced by a compatible work order.");
                    work.order = next;
                    work.deadline = deadline;
                } else {
                    if (hasActiveWorkOrder()) {
                        interrupt("The host replaced the current work policy.", true);
                        retireWork("needs_replan", "interrupted", "The host replaced the current work policy.");
                    }
                    boolean newDiamondBatch = samePolicy && next.policy().diamondProspecting() && !work.active()
                        && deepTreads() > work.startingDeepTreads;
                    work = new WorkSession(next, samePolicy && !newDiamondBatch ? work.budget : new AgentWorkOrder.Budget(next.policy()),
                        surfaceSearch, deadline);
                    work.waterClue = water;
                    work.startingDeepTreads = deepTreads();
                    if (!samePolicy && next.policy().diamondProspecting() && diamondRoute.foot != null)
                        diamondRoute.arrive(diamondRoute.foot, diamondRoute.support, diamondRoute.preferred);
                    Item goalStock = goalStock(next.policy().target());
                    work.startingStock = goalStock == null ? 0 : count(goalStock);
                }
                if (continuePersonal) personalCraft = new PersonalCraft(next, personalCraft.untilTick,
                    personalCraft.untilNanos, personalCraft.tableInReach);
                markConsumed(next.id());
                receipt(next.id(), life, "accepted", work.detail);
                return;
            }
        }
    }

    private boolean personalCraftCurrent() {
        return personalCraft.order == work.order && work.order.life() == life && tick < work.order.expires()
            && now < work.deadline && tick < personalCraft.untilTick && now < personalCraft.untilNanos
            && hazardClear && work.order.safetyRevision() == safetyRevision && grounded()
            && body.keysNeutral() && shown == client.currentScreen && hands.workInventoryReady();
    }

    private boolean confirmsWorkStock() {
        var target = work.order.policy().target();
        Item desired = goalStock(target);
        return desired != null && count(desired) >= goalAmount(target) && missingWorkFloor() == null;
    }

    private void releasePersonalCraft(boolean close) {
        personalCraft = null;
        if (hands != null) hands.releaseWorkInventory(close);
    }

    private void retireWork(String phase, String result, String detail) {
        if (!hasActiveWorkOrder()) return;
        work.phase = phase;
        work.detail = detail;
        enact(phase.equals("complete") ? "complete" : "hold", detail);
        receipt(work.order.id(), work.order.life(), result, detail);
    }

    private void holdWork() {
        if (work == null) {
            status = "waiting for a current authorized work order";
            state(rawPending ? "planning_wait" : "awaiting_plan", status);
        } else {
            status = work.detail;
            state("work_" + work.phase, status);
        }
    }

    private void workTick(AgentProgress progress) {
        claim("work_order");
        state("work_order_in_progress", work.detail);
        status = work.detail;
        if (action != null) {
            runWorkStep(progress);
            return;
        }
        if (work.budget.policy.waterFill()) {
            startWaterWork();
            if (action != null) runWorkStep(progress);
            else holdWork();
            return;
        }
        boolean personal = personalCraft != null;
        if (!personal && (!hazardClear || !grounded() || !client.isWindowFocused() || client.getOverlay() != null
                || client.currentScreen != null || !cursorClear() || !body.hasRecentView() || hands.busy())) {
            enact("hold", "Waiting for safe footing, a rendered view, and neutral controls.");
            return;
        }
        var sourceSearch = work.sourceSearch;
        if (!personal && body.renderedFrame() <= sourceSearch.freshAfter) {
            enact("search", "Waiting for a fresh first-person view after the physical source probe.");
            return;
        }
        if (sourceSearch.returning && returnFromSurfaceStairs()) {
            runWorkStep(progress);
            return;
        }
        if (sourceSearch.returnReason != null) {
            String reason = "Returned to the original dry surface footing. " + sourceSearch.returnReason;
            sourceSearch.returnReason = null;
            retireWork("blocked", "interrupted", reason);
            holdWork();
            return;
        }
        work.sourceBlock = null;
        var target = work.order.policy().target();
        Item goalStock = goalStock(target);
        boolean goalReached = goalStock != null && count(goalStock) >= goalAmount(target);
        var missingFloor = missingWorkFloor();
        if (goalReached && missingFloor == null) {
            if (returnFromSurfaceStairs()) {
                runWorkStep(progress);
                return;
            }
            if (work.order.nextWorkId() == null) releasePersonalCraft(true);
            work.completedTick = tick;
            retireWork("complete", "completed", "The native inventory confirms the requested outcome and declared reserves.");
            holdWork();
            return;
        }
        if (!sourceSearch.stairs.isEmpty() && workTicksLeft() <= AgentSurfaceTread.returnTicks(sourceSearch.stairs.size())
                + Verb.BREAK.maxTicks) {
            work.sourceBlock = "The remaining time is reserved for the verified climb back.";
            searchWork(work.sourceBlock);
            return;
        }
        if (!personal && collectOwnTimber()) {
            if (action != null) runWorkStep(progress);
            return;
        }
        if (!personal && work.lastHarvest != null && tick - work.lastHarvestTick <= (deepWork() ? 70 : 15)) {
            Item expected = work.lastHarvestItem;
            if (work.lowerHarvest && expected == Items.DIAMOND && deepWork()
                    && footOfDiamondTread(player.getBlockPos(), work.lastHarvest)) {
                ItemEntity drop = (ItemEntity) body.visibleEntity(entity -> entity instanceof ItemEntity item
                    && item.getBlockPos().equals(work.lastHarvest) && item.getStack().isOf(expected)
                    && roomFor(item.getStack()), 3.25).orElse(null);
                if (drop != null && prepareDiamondTread(progress, drop)) {
                    runWorkStep(progress);
                    return;
                }
            }
            if (work.lowerHarvest && !sourceSearch.stairs.isEmpty()
                    && work.lastHarvest.equals(AgentSurfaceTread.nextFoot(player.getBlockPos(), sourceSearch.cutBearing))) {
                ItemEntity drop = (ItemEntity) body.visibleEntity(entity -> entity instanceof ItemEntity item
                    && item.getBlockPos().equals(work.lastHarvest) && item.getStack().isOf(expected)
                    && roomFor(item.getStack()), 3.25).orElse(null);
                if (drop != null && prepareNextTread(player.getBlockPos(), progress, state -> AgentWorkOrder.harvest(state) == expected
                        && work.budget.policy.breakAllowed(state), sourceSearch)) {
                    if (action != null && action.tread != null) {
                        action.stairDrop = drop;
                        action.tracked = expected;
                        action.stairStock = count(expected);
                        work.lastHarvest = null;
                    }
                    runWorkStep(progress);
                    return;
                }
            }
            if (!work.lowerHarvest && workPickup(stack -> stack.isOf(expected))) {
                work.lastHarvest = null;
                runWorkStep(progress);
                return;
            }
            Vec3d basin = Vec3d.ofBottomCenter(work.lastHarvest).subtract(player.getEyePos()).add(0, -0.65, 0);
            body.turnFine(heading(basin.x, basin.z),
                (float) Math.toDegrees(Math.atan2(-basin.y, Math.hypot(basin.x, basin.z))));
            if (work.lowerHarvest || tick - work.lastHarvestTick <= 8) {
                enact("search", work.lowerHarvest
                    ? "Checking the confirmed harvest from the rim without entering the opening."
                    : "Checking beside the confirmed harvest for a visible drop; no pickup confirmed yet.");
                return;
            }
        }
        work.lastHarvest = null;
        BlockHitResult tableHit = personal ? null : visibleStation(Blocks.CRAFTING_TABLE);
        if (target.item() != null) {
            Item desired = goalReached ? missingFloor.getKey() : target.item();
            int required = goalReached || missingFloor != null && missingFloor.getKey() == desired
                ? Math.max(goalReached ? 0 : target.count(), missingFloor.getValue()) : target.count();
            if (desired == Items.IRON_INGOT && work.budget.policy.smeltIron()) {
                if (personal) releasePersonalCraft(true);
                else if (startIronWork(required - count(desired), tableHit, progress)) runWorkStep(progress);
            } else if (workTowardStock(desired, required - count(desired), tableHit, progress)) runWorkStep(progress);
            else if (personal) releasePersonalCraft(true);
            else searchWork(goalReached ? "The target is present, but no permitted witnessed source can fill the outstanding "
                + Registries.ITEM.getId(desired) + " reserve."
                : "No witnessed drop, harvest face, or reserve-safe recipe can advance the requested stock.");
            return;
        }
        if (goalReached) {
            if (workTowardStock(missingFloor.getKey(), missingFloor.getValue() - count(missingFloor.getKey()), tableHit, progress))
                runWorkStep(progress);
            else if (personal) releasePersonalCraft(true);
            else searchWork("The preset result is present, but a declared reserve is not yet fulfilled.");
            return;
        }
        // A clue can select a bench recipe for consideration, never supply its live face.
        var stage = progress.macroPresetStage(work.budget, personal ? personalCraft.tableInReach
            : tableHit != null || stationRecallReady(personalTable));
        if (personal) {
            if (stage.recipe() != null && startWorkRecipe(stage.recipe(), stage.executions(), null)) runWorkStep(progress);
            else releasePersonalCraft(true);
        } else if (stage.blocked() != null) {
            searchWork(stage.blocked());
        } else if (stage.recipe() != null) {
            if (startWorkRecipe(stage.recipe(), stage.executions(), tableHit)) runWorkStep(progress);
            else searchWork("No safe visible workstation or placement can advance the next preset recipe.");
        } else if (workPickup(stage.pickup()) || workGather(progress, stage.gather())) {
            runWorkStep(progress);
        } else {
            searchWork("No live visible source, suitable tool, or permitted route advances the next preset step.");
        }
    }

    private boolean workTowardStock(Item desired, int quantity, BlockHitResult tableHit, AgentProgress progress) {
        if (personalCraft == null && workPickup(stack -> stack.isOf(desired))) return true;
        if (work.budget.policy.preset()) {
            String recipe = Registries.ITEM.getId(desired).getPath();
            if (AgentHands.workOutput(recipe) == desired
                    && startStockRecipe(recipe, quantity, tableHit, progress, new HashSet<>(4))) return true;
        }
        for (String effect : work.budget.policy.effects()) {
            if (!effect.startsWith("craft:")) continue;
            String recipe = effect.substring("craft:".length());
            if (recipe.equals("planks")) {
                String exact = Registries.ITEM.getId(desired).getPath();
                if (AgentHands.workSpecificPlanks(exact)) recipe = exact;
            }
            if (AgentHands.workOutput(recipe) == desired
                    && startStockRecipe(recipe, quantity, tableHit, progress, new HashSet<>(4))) return true;
        }
        return personalCraft == null && workGather(progress, state -> AgentWorkOrder.harvest(state) == desired);
    }

    private boolean startStockRecipe(String recipe, int quantity, BlockHitResult bench, AgentProgress progress,
                                     Set<String> visiting) {
        if (visiting.size() >= 4 || !visiting.add(recipe)) return false;
        try {
            if (!work.budget.policy.craftAllowed(recipe) || work.budget.craftsLeft() == 0) return false;
            int batch = AgentHands.workOutputCount(recipe);
            if (hands.workCraftable(recipe, work.budget))
                return startWorkRecipe(recipe, (quantity + batch - 1) / batch, bench);
            var need = hands.workNeed(recipe, work.budget);
            if (need == null) return false;
            Predicate<ItemStack> matches = stack -> work.budget.remainingCost(stack.getItem()) > 0 && need.matches(stack);
            if (personalCraft == null && workPickup(matches)) return true;
            for (String effect : work.budget.policy.effects()) {
                if (!effect.startsWith("craft:")) continue;
                String supply = effect.substring("craft:".length());
                if (supply.equals("planks")) {
                    // Bind an otherwise generic recipe to exact allowed stock, not a fallback species.
                    for (Item candidate : work.budget.policy.caps().keySet()) {
                        String exact = Registries.ITEM.getId(candidate).getPath();
                        if (AgentHands.workSpecificPlanks(exact) && matches.test(new ItemStack(candidate))
                                && startStockRecipe(exact, need.count(), bench, progress, visiting)) return true;
                    }
                } else {
                    Item output = AgentHands.workOutput(supply);
                    if (output != null && matches.test(new ItemStack(output))
                            && startStockRecipe(supply, need.count(), bench, progress, visiting)) return true;
                }
            }
            return personalCraft == null && workGather(progress, state -> {
                Item harvest = AgentWorkOrder.harvest(state);
                return harvest != Items.AIR && matches.test(new ItemStack(harvest));
            });
        } finally {
            visiting.remove(recipe);
        }
    }

    private static Item goalStock(AgentWorkOrder.Target target) {
        if (target.item() != null) return target.item();
        return switch (target.goal()) {
            case "wooden_pickaxe" -> Items.WOODEN_PICKAXE;
            case "stone_pickaxe" -> Items.STONE_PICKAXE;
            case "iron_pickaxe" -> Items.IRON_PICKAXE;
            case "diamond" -> Items.DIAMOND;
            default -> null;
        };
    }

    private static int goalAmount(AgentWorkOrder.Target target) { return target.item() == null ? 1 : target.count(); }

    private void enact(String phase, String detail) {
        work.enactedPhase = phase;
        work.enactedStatus = detail;
    }

    private Action startWorkStep(Verb verb, String label, Face face, ItemEntity drop, Item item, Recipe recipe) {
        var key = face == null ? new Key(verb, null, 0, null) : faceKey(verb, face, null);
        Offer offer = new Offer(null, key, label, "", 0, 0, null, face, drop, item, recipe);
        action = new Action(null, offer, client, tick, now, body.renderedFrame(), item == null ? 0 : count(item),
            NO_ANCHORS, Float.NaN);
        action.durable = true;
        work.detail = label;
        enact(switch (verb) {
            case BREAK -> "harvest";
            case WORK_TREAD -> "route";
            case WORK_WALK -> drop == null ? "route" : "collect";
            case CONTINUE -> "craft";
            case STATION_REACQUIRE -> "search";
            case WORK_EQUIP -> "equip";
            case WORK_PLACE -> "place";
            case WORK_SMELT -> "smelt";
            case WORK_FILL -> "fill";
            default -> "hold";
        }, label);
        status = label;
        return action;
    }

    private boolean workPickup(Predicate<ItemStack> wanted) {
        if (!work.sourceSearch.stairs.isEmpty()) return false; // No unproved drop chase from a lower tread.
        var seen = body.visibleEntity(entity -> entity instanceof ItemEntity drop && !work.rejectedDrops.contains(drop.getId())
            && (!deepWork() || drop.getBlockPos().getY() == player.getBlockY())
            && !dropInProspectOpening(drop) && wanted.test(drop.getStack()) && roomFor(drop.getStack()), 8.0).orElse(null);
        if (!(seen instanceof ItemEntity found)) return false;
        return startWorkPickup(found);
    }

    private boolean startWorkPickup(ItemEntity found) {
        Item item = found.getStack().getItem();
        boolean timber = timberItem(item);
        Vec3d destination = timber ? found.getPos() : Vec3d.ofBottomCenter(found.getBlockPos());
        startWorkStep(Verb.WORK_WALK, "Collect visible " + Registries.ITEM.getId(item), null, found, item, null);
        action.destination = destination;
        action.distanceLeft = horizontalSquared(player.getPos(), destination);
        action.timberWalk = timber;
        action.timberDropSeen = tick;
        return true;
    }

    private boolean collectOwnTimber() {
        if (timberHarvest == null) return false;
        TimberHarvest cut = timberHarvest;
        Item target = work.order.policy().target().item();
        if (tick - cut.tick > 48 || count(cut.item) > cut.stock || !work.sourceSearch.stairs.isEmpty()
                || !work.budget.policy.breakAllowed(cut.state) || horizontalSquared(player.getPos(), cut.stance) > 16
                || target != null && target != cut.item && work.budget.remainingCost(cut.item) == 0) {
            timberHarvest = null;
            return false;
        }
        Vec3d base = Vec3d.ofBottomCenter(cut.block);
        var seen = body.visibleEntity(entity -> entity instanceof ItemEntity drop && !work.rejectedDrops.contains(drop.getId())
            && drop.getStack().isOf(cut.item) && roomFor(drop.getStack())
            && horizontalSquared(drop.getPos(), base) <= 2.25 && !dropInProspectOpening(drop), 6).orElse(null);
        if (seen instanceof ItemEntity found) return startWorkPickup(found);
        if (tick - cut.tick <= 12) {
            body.aim(new Vec3d(base.x, Math.min(cut.stance.y + 0.2, base.y), base.z));
            enact("search", "Checking the last witnessed timber landing for its drop.");
            status = work.enactedStatus;
            return true;
        }
        return false;
    }

    private static boolean timberItem(Item item) {
        return item.getRegistryEntry().isIn(ItemTags.LOGS) || item.getRegistryEntry().isIn(ItemTags.BAMBOO_BLOCKS)
            || item == Items.BAMBOO;
    }

    private static boolean timberBlock(BlockState state) {
        return state.isIn(BlockTags.LOGS) || state.isOf(Blocks.BAMBOO) || state.isOf(Blocks.BAMBOO_BLOCK)
            || state.isOf(Blocks.STRIPPED_BAMBOO_BLOCK);
    }

    private boolean dropInProspectOpening(ItemEntity drop) {
        BlockPos cap = work.sourceSearch.firstCover;
        if (cap == null || cap.getY() >= work.sourceSearch.cutFrom.getY() || drop.getY() >= player.getBlockY()) return false;
        BlockPos cell = drop.getBlockPos();
        return cell.getX() == cap.getX() && cell.getZ() == cap.getZ();
    }

    private boolean workGather(AgentProgress progress, Predicate<BlockState> matches) {
        if (!work.budget.canBreak()) {
            if (work.sourceSearch.firstCover != null || deepWork()) work.sourceBlock = "The authorized break grant is spent.";
            return false;
        }
        if (client.options.attackKey.isUnbound()) return false;
        Predicate<BlockState> wanted = state -> matches.test(state) && work.budget.policy.breakAllowed(state);
        Predicate<BlockHitResult> eligible = hit -> {
            BlockPos pos = hit.getBlockPos();
            if (work.rejected.contains(pos)) return false;
            BlockState state = world.getBlockState(pos);
            return workResourceSafe(hit, state, progress) && workToolSlot(pos, state) >= 0;
        };
        double reach = reach();
        if (work.sourceSearch.stairs.isEmpty() && workGatherTimber(wanted, eligible)) return true;
        var found = body.find(wanted, reach, hit -> eligible.test(hit) && body.macroMineWitness(hit, reach) != null).orElse(null);
        if (found != null) {
            Face face = face(found);
            return startWorkBreak(face, AgentWorkOrder.harvest(face.state), false);
        }
        found = work.sourceSearch.stairs.isEmpty()
            ? body.find(state -> wanted.test(state) && !timberBlock(state), INSPECT_REACH,
                hit -> hit.getBlockPos().getY() >= player.getBlockY() && eligible.test(hit)).orElse(null)
            : null;
        if (found != null) {
            BlockPos pos = found.getBlockPos();
            if (horizontalSquared(player.getPos(), Vec3d.ofCenter(pos)) <= 1.35 * 1.35) {
                work.rejected.add(pos);
                return true; // Check a different admitted face on the next view.
            }
            Face face = face(found);
            startWorkStep(Verb.WORK_WALK, "Approach witnessed " + blockName(face), face, null, null, null);
            action.destination = Vec3d.ofBottomCenter(pos);
            action.distanceLeft = horizontalSquared(player.getPos(), action.destination);
            return true;
        }
        return deepWork() && (wanted.test(Blocks.DIAMOND_ORE.getDefaultState())
            || wanted.test(Blocks.DEEPSLATE_DIAMOND_ORE.getDefaultState()))
            ? prospectForDiamond(progress) : prospectForSource(progress, wanted);
    }

    private boolean workGatherTimber(Predicate<BlockState> wanted, Predicate<BlockHitResult> eligible) {
        rememberTimberView();
        Predicate<BlockState> timber = state -> timberBlock(state) && wanted.test(state);
        int floor = player.getBlockY();
        double reach = reach();
        for (int upper = floor; upper <= floor + 1; upper++) {
            final int height = upper;
            BlockHitResult low = body.find(timber, reach, hit -> hit.getBlockPos().getY() <= height
                && eligible.test(hit) && body.macroMineWitness(hit, reach) != null).orElse(null);
            if (low != null) {
                work.timberLook = null;
                Face seen = face(low);
                return startWorkBreak(seen, AgentWorkOrder.harvest(seen.state), false);
            }
        }
        BlockHitResult reachable = body.find(timber, reach,
            hit -> eligible.test(hit) && body.macroMineWitness(hit, reach) != null).orElse(null);
        if (reachable != null) {
            work.timberLook = null;
            Face seen = face(reachable);
            return startWorkBreak(seen, AgentWorkOrder.harvest(seen.state), false);
        }
        long withoutLanding = Long.MIN_VALUE;
        for (int route = 0; route < 2; route++) {
            long skip = withoutLanding;
            BlockHitResult seen = body.find(timber, TIMBER_RECALL_RANGE, hit -> hit.getSide().getAxis().isHorizontal()
                && hit.getBlockPos().getY() <= floor + 2 && !insideTimberClearance(hit.getBlockPos(), player.getPos())
                && timberColumn(hit.getBlockPos()) != skip && !work.timberApproaches.contains(timberColumn(hit.getBlockPos()))
                && eligible.test(hit)).orElse(null);
            if (seen == null) break;
            if (approachTimber(face(seen))) {
                work.timberApproaches.add(timberColumn(seen.getBlockPos()));
                work.timberLook = null;
                return true;
            }
            withoutLanding = timberColumn(seen.getBlockPos());
        }
        if (work.timberLook != null) {
            Face remembered = work.timberLook.face;
            Vec3d aim = remembered.hit.getPos();
            if (tick < work.timberLookUntil && !(body.renderedFrame() > work.timberLookFrame && body.renderedAim(aim, 8))) {
                body.aim(aim);
                enact("search", "Rechecking one previously witnessed lower timber face.");
                status = work.enactedStatus;
                return true;
            }
            timberSights.remove(remembered.hit.getBlockPos());
            work.rejected.add(remembered.hit.getBlockPos());
            work.timberLook = null;
        }
        if (work.timberLookUsed) return false;
        TimberSight candidate = null;
        double nearest = TIMBER_RECALL_RANGE * TIMBER_RECALL_RANGE;
        Vec3d eye = player.getEyePos();
        for (TimberSight sight : timberSights.values()) {
            Face remembered = sight.face;
            BlockPos cell = remembered.hit.getBlockPos();
            Vec3d point = remembered.hit.getPos();
            double distance = eye.squaredDistanceTo(point);
            if (cell.getY() < floor || cell.getY() > floor + 2 || work.rejected.contains(cell)
                    || distance >= nearest || !wanted.test(remembered.state)
                    || Math.abs(MathHelper.wrapDegrees(heading(point.x - eye.x, point.z - eye.z) - player.getYaw())) > 115
                    || body.renderedAim(point, 8)) continue;
            nearest = distance;
            candidate = sight;
        }
        if (candidate == null) return false;
        startTimberLook(candidate);
        return true;
    }

    private void startTimberLook(TimberSight candidate) {
        work.timberLook = candidate;
        work.timberLookUsed = true;
        work.timberLookUntil = tick + 26;
        work.timberLookFrame = body.renderedFrame();
        body.aim(candidate.face.hit.getPos());
        enact("search", "Rechecking one previously witnessed lower timber face.");
        status = work.enactedStatus;
    }

    private void rememberTimberView() {
        long frame = body.renderedFrame();
        if (frame == timberFrame || !body.hasRecentView()) return;
        timberFrame = frame;
        timberSights.values().removeIf(sight -> tick - sight.seen > TIMBER_RECALL_TICKS);
        int floor = player.getBlockY();
        body.find(AgentMacroControl::timberBlock, TIMBER_RECALL_RANGE, hit -> {
            BlockPos cell = hit.getBlockPos();
            if (hit.getSide().getAxis().isHorizontal() && cell.getY() >= floor && cell.getY() <= floor + 2) {
                TimberSight prior = timberSights.get(cell);
                if (prior == null || prior.seen != tick) {
                    if (prior != null) timberSights.remove(cell);
                    else if (timberSights.size() >= TIMBER_RECALL_LIMIT) timberSights.pollFirstEntry();
                    timberSights.put(cell, new TimberSight(face(hit), tick));
                }
            }
            return false; // Gather only camera-admitted candidates, not an action.
        });
    }

    private boolean approachTimber(Face tree) {
        BlockPos trunk = tree.hit.getBlockPos();
        Vec3d observed = tree.hit.getPos();
        Vec3d feet = player.getPos();
        double eyeHeight = player.getEyePos().y - feet.y;
        double range = reach();
        BlockHitResult support = body.find(state -> !timberBlock(state) && !station(state) && !state.isIn(BlockTags.LEAVES), 6,
            hit -> {
                BlockPos cell = hit.getBlockPos();
                Vec3d stand = Vec3d.ofBottomCenter(cell.up());
                double walk = horizontalSquared(feet, stand);
                return hit.getSide() == Direction.UP && cell.getY() == player.getBlockY() - 1
                    && walk >= 0.6 && walk <= 16 && horizontalSquared(stand, observed) <= 6.25
                    && !insideTimberClearance(trunk, stand)
                    && stand.add(0, eyeHeight, 0).squaredDistanceTo(observed) < range * range
                    && body.dryRouteFloor(hit.getPos().add(0, -0.035, 0), cell) != null;
            }).orElse(null);
        if (support == null) return false;
        Vec3d destination = Vec3d.ofBottomCenter(support.getBlockPos().up());
        startWorkStep(Verb.WORK_WALK, "Walk to visible footing beside witnessed " + blockName(tree), tree, null, null, null);
        action.destination = destination;
        action.distanceLeft = horizontalSquared(feet, destination);
        action.timberWalk = true;
        return true;
    }

    private static boolean insideTimberClearance(BlockPos trunk, Vec3d stance) {
        return horizontalSquared(Vec3d.ofBottomCenter(trunk), stance) < 0.80 * 0.80;
    }

    private static long timberColumn(BlockPos block) {
        return BlockPos.asLong(block.getX(), 0, block.getZ());
    }

    private boolean startWorkBreak(Face face, Item item, boolean cover) {
        boolean diamondCover = cover && deepWork();
        int tool = workToolSlot(face.hit.getBlockPos(), face.state, diamondCover);
        if (tool < 0) return false;
        if (tool != player.getInventory().selectedSlot) {
            startWorkStep(Verb.WORK_EQUIP, "Equip a suitable tool for " + blockName(face), face, null, null, null);
            action.workSlot = tool;
            action.diamondRoute = diamondCover;
            return true;
        }
        boolean lip = cover && AgentSurfaceTread.returnLip(player.getBlockPos(), face.hit.getBlockPos(),
            work.sourceSearch.cutBearing, face.hit.getSide());
        String label = diamondCover ? "Clear one witnessed diamond prospecting cell of "
            : lip ? "Clear a witnessed return lip of " : cover ? "Open a shallow window through witnessed " : "Harvest witnessed ";
        startWorkStep(Verb.BREAK, label + blockName(face), face, null, null, null);
        action.tracked = item;
        action.prospectCover = cover;
        action.diamondRoute = diamondCover;
        return true;
    }

    private boolean workResourceSafe(BlockHitResult hit, BlockState block, AgentProgress progress) {
        BlockPos cell = hit.getBlockPos();
        BlockPos foot = player.getBlockPos();
        var search = work.sourceSearch;
        boolean nextTreadSource = !search.stairs.isEmpty() && cell.getY() == foot.getY() - 1
            && AgentSurfaceTread.plannedCell(foot, cell, search.cutBearing, hit.getSide())
            && retainedProspectStance(foot, cell, search);
        boolean diamondTreadSource = deepWork() && footOfDiamondTread(foot, cell)
            && diamondCutGeometry(foot, cell) && AgentWorkOrder.harvest(block) == Items.DIAMOND;
        return (cell.getY() >= foot.getY() || nextTreadSource || diamondTreadSource) && !search.footholds.contains(cell)
            && dryWorkBreakSafe(cell, block, AgentWorkOrder.harvest(block), progress);
    }

    private boolean dryWorkBreakSafe(BlockPos pos, BlockState block, Item drop, AgentProgress progress) {
        BlockState above = world.getBlockState(pos.up());
        if (diamondRoute.supports.contains(pos) || diamondRoute.attemptedSupports.contains(pos)
                || !progress.macroCanBreak(pos) || !block.getFluidState().isEmpty()
                || above.getBlock() instanceof FallingBlock || station(above) || !roomFor(new ItemStack(drop))) return false;
        for (Direction side : Direction.values())
            if (!client.world.getBlockState(pos.offset(side)).getFluidState().isEmpty()) return false;
        return true;
    }

    private boolean deepWork() { return work != null && work.budget.policy.diamondProspecting(); }

    private int deepTreads() { return diamondRoute.treads + diamondRoute.shelves + diamondRoute.rises + diamondRoute.levelLegs; }

    private boolean footOfDiamondTread(BlockPos foot, BlockPos cell) {
        return foot.equals(diamondRoute.foot) && diamondRoute.cutting && !diamondRoute.level
            && cell.equals(AgentSurfaceTread.nextFoot(foot, diamondRoute.bearing));
    }

    private boolean diamondCutGeometry(BlockPos foot, BlockPos cell) {
        var route = diamondRoute;
        return foot.equals(route.foot) && route.cutting && settled() && dryProspectStance(foot)
            && world.getBlockState(foot.down()) == route.support
            && !route.supports.contains(cell) && !surfaceSearch.footholds.contains(cell)
            && (route.level ? AgentSurfaceTread.prospectLevelCell(foot, cell, route.bearing)
                : AgentSurfaceTread.prospectCell(foot, cell, route.bearing))
            && !player.getBoundingBox().expand(0.1, 0, 0.1).intersects(new Box(cell));
    }

    private boolean prospectForDiamond(AgentProgress progress) {
        BlockPos foot = player.getBlockPos();
        if (!work.budget.policy.breakAllowed(Blocks.DIAMOND_ORE.getDefaultState())
                && !work.budget.policy.breakAllowed(Blocks.DEEPSLATE_DIAMOND_ORE.getDefaultState())) return false;
        if (!roomFor(new ItemStack(Items.DIAMOND)) || !diamondToolAvailable(-1, false)) {
            work.sourceBlock = "Diamond search needs inventory room and a usable diamond-harvesting tool within the declared costs and reserves.";
            return false;
        }
        if (!dryProspectStance(foot)) {
            work.sourceBlock = "Diamond descent needs stable full dry footing.";
            return false;
        }
        if (!surfaceBodyAllowsExtension()) return false;
        if (workTicksLeft() <= AgentSurfaceTread.ACTION_TICKS) {
            // No new physical edge starts with too little time to reach its verified endpoint.
            enact("hold", "At the last stable foothold: renew the finite lease to start another diamond prospecting tread.");
            return true;
        }
        var route = diamondRoute;
        if (route.unjoined != null && !route.unjoined.equals(foot)) {
            work.sourceBlock = "A movement interruption displaced the player from the retained return route; re-establish a witnessed return first.";
            return false;
        }
        route.unjoined = null;
        if (!settled()) {
            enact("hold", "Settling before checking the next diamond prospecting tread.");
            return true;
        }
        if (Math.abs(player.getX() - foot.getX() - 0.5) > 0.15 || Math.abs(player.getZ() - foot.getZ() - 0.5) > 0.15) {
            body.centerOnSupport(foot.down());
            enact("search", "Centering on the current full dry support before prospecting.");
            return true;
        }
        if (!foot.equals(route.foot)) {
            route.spine.clear(); // An independent work order or manual movement did not attest a connecting edge.
            route.arrive(foot, world.getBlockState(foot.down()), player.getHorizontalFacing());
        }
        if (route.level) return prepareDiamondTread(progress, null);
        if (route.bearingIndex >= CARDINAL.length) {
            return tryDiamondLevelOrReturn(foot, progress);
        }
        BlockPos lower = AgentSurfaceTread.nextFoot(foot, route.bearing);
        if (unverifiedProspectSupport(lower.down()))
            return refuseDiamondBearing("This placement has no matched inventory debit and lit support receipt; no entry was authorized.");
        if (route.supports.contains(lower.down()) || body.hazardAhead(route.bearing.getPositiveHorizontalDegrees(), 1.65))
            return refuseDiamondBearing("The next lane revisits retained support or has a visible lava hazard.");
        if (!route.cutting) {
            float yaw = route.bearing.getPositiveHorizontalDegrees();
            var offered = progress.dryRouteOffer();
            if (offered != null && offered.edges() == 1 && offered.from().equals(foot) && offered.endpoint().equals(lower)) {
                startDiamondRouteStep(Verb.FOLLOW, "Follow one witnessed lower cave shelf with a proved return", progress, offered, null);
                return true;
            }
            if (!route.surveyed) {
                if (!body.renderedDirection(yaw, 49, 7)) {
                    body.turnFine(yaw, 49);
                    enact("search", "Checking the next bearing for a witnessed lower shelf before cutting.");
                    return true;
                }
                rememberDiamondLevelCue(foot, route.bearing);
                if (route.bearingIndex == CARDINAL.length - 1
                        && ((route.levelFloors | route.levelWalls) & directionBit(route.bearing)) != 0) {
                    return refuseDiamondBearing("Keeping the last witnessed side sector intact for a returnable level alternative.");
                }
                route.surveyed = true;
                var survey = progress.drySurveyOffer();
                if (survey != null) {
                    startDiamondRouteStep(Verb.DRY_SURVEY, "Verify the visible lower cave shelf without moving or spending", progress, null, survey);
                    return true;
                }
            }
            route.cutting = true;
        }
        return prepareDiamondTread(progress, null);
    }

    private static int directionBit(Direction direction) { return 1 << direction.ordinal(); }

    private void rememberDiamondLevelCue(BlockPos foot, Direction bearing) {
        BlockPos next = foot.offset(bearing);
        if (diamondRoute.supports.contains(next.down()) || body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65)) return;
        int bit = directionBit(bearing);
        if (body.macroFloor(next.down()) != null) {
            diamondRoute.levelFloors |= bit;
            return;
        }
        if (work.budget.canPlaceProspectSupport(player.getInventory())) {
            Vec3d top = Vec3d.ofBottomCenter(next).add(0.24 * bearing.getOffsetX(), -0.032, 0.24 * bearing.getOffsetZ());
            if (body.footholdSpace(top) == AgentBody.FootholdSpace.EMPTY) diamondRoute.levelGaps |= bit;
        }
        for (int height = 0; height <= 1; height++) {
            BlockPos cell = next.up(height);
            Vec3d point = Vec3d.ofCenter(cell);
            var face = body.perceive(point, player.getEyePos().distanceTo(point) + 0.045).orElse(null);
            if (face != null && cell.equals(face.getBlockPos()) && face.getSide() == bearing.getOpposite()) {
                BlockState block = world.getBlockState(cell);
                if (work.budget.policy.prospectCoverAllowed(block) && block.getFluidState().isEmpty())
                    diamondRoute.levelWalls |= bit;
            }
        }
    }

    private boolean tryDiamondLevelOrReturn(BlockPos foot, AgentProgress progress) {
        var route = diamondRoute;
        int usable = route.levelFloors & ~route.triedLevel;
        if (usable == 0) usable = route.levelWalls & ~route.triedLevel;
        if (usable == 0 && work.budget.canPlaceProspectSupport(player.getInventory())) usable = route.levelGaps & ~route.triedLevel;
        Direction facing = player.getHorizontalFacing();
        for (int i = 0; usable != 0 && i < CARDINAL.length; i++) {
            Direction bearing = switch (i) {
                case 0 -> facing;
                case 1 -> facing.rotateYClockwise();
                case 2 -> facing.rotateYCounterclockwise();
                default -> facing.getOpposite();
            };
            int bit = directionBit(bearing);
            if ((usable & bit) == 0) continue;
            route.triedLevel |= bit;
            if (route.supports.contains(foot.offset(bearing).down())
                    || body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65)) {
                enact("search", "The witnessed side sector now revisits retained footing or has visible lava.");
                return true;
            }
            route.bearing = bearing;
            route.level = route.cutting = true;
            return prepareDiamondTread(progress, null);
        }
        // Only reuse a real paired upward offer; a wall is not a ledge and cannot authorize a jump.
        var up = progress.dryRouteOffer();
        if (up != null && up.edges() == 1 && up.from().equals(foot) && up.endpoint().equals(foot.offset(facing).up())
                && !route.supports.contains(up.endpoint().down()) && !unverifiedProspectSupport(up.endpoint().down())) {
            route.bearing = facing;
            route.level = true; // Preserve the exhausted descent index when resuming this intersection.
            startDiamondRouteStep(Verb.FOLLOW, "Reposition one block up to a witnessed dry shelf with a proved return", progress, up, null);
            return true;
        }
        DiamondSpine back = route.spine.peekLast();
        if (back != null && back.edge.lower().equals(foot)) {
            startSurfaceTread(back.edge, true);
            action.diamondRoute = true;
            return true;
        }
        work.sourceBlock = (route.refusal == null ? "No lit dry lower shelf or returnable cut was verified." : route.refusal)
            + " " + (route.levelRefusal == null ? "No unvisited same-level floor or permitted side wall was witnessed."
                : "Level alternative refused: " + route.levelRefusal)
            + (route.supportRefusal == null ? "" : " Attached support refused: " + route.supportRefusal)
            + " No further retained intersection to try.";
        return false;
    }

    private void startDiamondRouteStep(Verb verb, String label, AgentProgress progress,
                                       AgentDryCaveRoute.Offer route, AgentDryCaveRoute.Survey survey) {
        var offer = new Offer(null, new Key(verb, null, 0, null), label, "", 0, 0,
            null, null, null, null, null, route, null, survey);
        action = new Action(null, offer, client, tick, now, body.renderedFrame(), 0, NO_ANCHORS, Float.NaN);
        action.durable = action.diamondRoute = true;
        routeOwner = progress;
        work.detail = status = label;
        enact(verb == Verb.FOLLOW ? "route" : "search", label);
    }

    private boolean prepareDiamondTread(AgentProgress progress, ItemEntity drop) {
        var route = diamondRoute;
        BlockPos foot = player.getBlockPos();
        if (!foot.equals(route.foot) || world.getBlockState(foot.down()) != route.support || !settled()) {
            work.sourceBlock = "The exact grounded starting support for the next diamond tread changed.";
            return false;
        }
        Direction bearing = route.bearing;
        BlockPos lower = route.level ? foot.offset(bearing) : AgentSurfaceTread.nextFoot(foot, bearing);
        if (unverifiedProspectSupport(lower.down()))
            return refuseDiamondBearing("This placement has no matched inventory debit and lit support receipt; no entry was authorized.");
        // Discover the lane from actual rendered samples. A hidden neighbor can veto a cut through
        // the ordinary safety checks, but can never become a target, floor, or clearance witness.
        for (int i = 0; i < (route.level ? 2 : 5); ++i) {
            BlockPos cell = route.level ? lower.up(1 - i) : i == 0 ? foot.up(2) : lower.up(4 - i);
            int sample = 1 << i;
            if ((route.clearMask & sample) != 0 && world.getBlockState(cell).isAir()) continue;
            Vec3d point = i == 4 ? Vec3d.ofCenter(cell, 0.88).add(
                0.18 * bearing.getOffsetX(), 0, 0.18 * bearing.getOffsetZ()) : Vec3d.ofCenter(cell);
            var space = body.footholdSpace(point);
            if (space == AgentBody.FootholdSpace.EMPTY) {
                route.clearMask |= sample;
                continue;
            }
            if (space == AgentBody.FootholdSpace.FLUID)
                return refuseDiamondBearing("A visible fluid hit vetoed clearance for the planned diamond tread.");
            if (space == AgentBody.FootholdSpace.DARK) return lightDiamondTread();
            var hit = body.perceive(point, player.getEyePos().distanceTo(point) + 0.045).orElse(null);
            if (hit != null && diamondCutGeometry(foot, hit.getBlockPos())) {
                BlockState block = world.getBlockState(hit.getBlockPos());
                if (AgentWorkOrder.harvest(block) == Items.DIAMOND && work.budget.policy.breakAllowed(block)
                        && work.budget.canBreak() && workResourceSafe(hit, block, progress)
                        && startWorkBreak(face(hit), Items.DIAMOND, false)) return true;
                Item debris = AgentWorkOrder.prospectCoverDrop(block);
                String name = Registries.BLOCK.getId(block.getBlock()).toString();
                if (!route.level && hit.getBlockPos().equals(lower)
                        && (route.levelFloors & directionBit(bearing)) != 0)
                    return refuseDiamondBearing("Preserving the witnessed same-level floor as a returnable alternative instead of cutting " + name + ".");
                if (debris == Items.AIR)
                    return refuseDiamondBearing("The exact tread contains " + name + ", not a supported dry cover material.");
                if (!work.budget.policy.prospectCoverAllowed(block))
                    return refuseDiamondBearing("The tread exposes " + name + "; cutting it requires explicit break:" + name + ".");
                if (!work.budget.canCutCover())
                    return refuseDiamondBearing("Keep the last break for diamond ore; cutting witnessed " + name + " needs a new grant.");
                if (work.rejected.contains(hit.getBlockPos()) || !dryWorkBreakSafe(hit.getBlockPos(), block, debris, progress))
                    return refuseDiamondBearing("The witnessed " + name + " cover is protected, wet, unstable, refused, or has no room for drops.");
                if (!startWorkBreak(face(hit), debris, true))
                    return refuseDiamondBearing("No tool can cut the witnessed " + name + " while preserving the diamond harvest tool and declared reserves.");
                return true;
            }
            if (aimDiamondCell(cell, point)) return true;
            return refuseDiamondBearing(hit == null ? "The planned stair cell never gave a lit exact face or dry clearance."
                : "Witnessed " + blockName(face(hit)) + " is outside the permitted clearance or on retained support; no cut authorized.");
        }
        Vec3d floorAim = Vec3d.ofBottomCenter(lower).add(0.28 * bearing.getOffsetX(), -0.032, 0.28 * bearing.getOffsetZ());
        Vec3d floorSample = floorAim;
        var floor = body.dryRouteTop(floorAim, lower.down(), true);
        if (floor != AgentBody.DryRouteTop.WITNESSED && floor != AgentBody.DryRouteTop.FLUID) {
            Vec3d alternate = Vec3d.ofBottomCenter(lower).add(-0.22 * bearing.getOffsetX(), -0.032, -0.22 * bearing.getOffsetZ());
            var other = body.dryRouteTop(alternate, lower.down(), true);
            if (other == AgentBody.DryRouteTop.WITNESSED || other == AgentBody.DryRouteTop.FLUID
                    || floor == AgentBody.DryRouteTop.OUT_OF_VIEW) {
                floor = other;
                floorSample = alternate;
            }
        }
        if (floor == AgentBody.DryRouteTop.DARK) return lightDiamondTread();
        if (floor == AgentBody.DryRouteTop.FLUID)
            return refuseDiamondBearing("A visible fluid hit vetoed the landing ray; no movement from the current dry footing.");
        if (floor == AgentBody.DryRouteTop.NO_FULL_TOP)
            return startProspectSupport(foot, lower, bearing, floorSample, progress);
        if (floor == AgentBody.DryRouteTop.UNSUITABLE_TOP) {
            var hit = body.terrain(floorSample, player.getEyePos().distanceTo(floorSample) + 0.045).orElse(null);
            String name = hit != null && hit.getBlockPos().equals(lower.down()) ? " of " + blockName(face(hit)) : "";
            return refuseDiamondBearing("The ray hit the planned support" + name + ", but not a stable, full dry upper face.");
        }
        if (floor != AgentBody.DryRouteTop.WITNESSED) {
            if (aimDiamondCell(lower.down(), floorAim)) return true;
            var hit = floor == AgentBody.DryRouteTop.OCCLUDED
                ? body.terrain(floorSample, player.getEyePos().distanceTo(floorSample) + 0.045).orElse(null) : null;
            return refuseDiamondBearing(hit != null && !hit.getBlockPos().equals(lower.down())
                ? "Witnessed " + blockName(face(hit)) + " occludes the landing support; the support was not identified."
                : "No direct rendered landing support witness was obtained.");
        }
        if (workTicksLeft() <= AgentSurfaceTread.ACTION_TICKS) return false;
        var edge = new AgentSurfaceTread.Edge(foot, route.support, lower, world.getBlockState(lower.down()), bearing);
        startSurfaceTread(edge, false);
        action.diamondRoute = true;
        if (drop != null) {
            action.stairDrop = drop;
            action.tracked = Items.DIAMOND;
            action.stairStock = count(Items.DIAMOND);
        }
        return true;
    }

    private boolean startProspectSupport(BlockPos foot, BlockPos to, Direction bearing, Vec3d emptyTop, AgentProgress progress) {
        String gap = "The rendered landing ray found no full supporting top.";
        if (!work.budget.policy.placeProspectSupport()) return refuseDiamondBearing(gap
            + " No attached support is authorized; that needs place:minecraft:cobblestone.");
        if (!work.budget.canPlaceProspectSupport(player.getInventory()))
            return refuseDiamondBearing(gap + " An attached support needs a usable placement and carried cobblestone above its reserve and within its exact cost.");
        BlockPos cell = to.down();
        if (diamondRoute.attemptedSupports.contains(cell) || diamondRoute.supports.contains(cell)
                || surfaceSearch.footholds.contains(cell) || !progress.macroCanBreak(cell))
            return refuseDiamondBearing("The support cell is protected or already had its one placement attempt.");
        var space = body.footholdSpace(emptyTop);
        if (space == AgentBody.FootholdSpace.VIEW && aimDiamondCell(cell, emptyTop)) return true;
        if (space != AgentBody.FootholdSpace.EMPTY)
            return refuseDiamondBearing(gap + " The exact fill cell was not witnessed empty and dry.");
        if (client.options.useKey.isUnbound() || !player.getOffHandStack().isEmpty())
            return refuseDiamondBearing("An attached support needs a bound use control and an empty off hand.");
        if (workTicksLeft() <= Verb.WORK_PLACE.maxTicks + AgentSurfaceTread.ACTION_TICKS) {
            enact("hold", "Renew the lease before starting a support placement and its proved crossing.");
            return true;
        }
        startWorkStep(Verb.WORK_PLACE, "Check one attached cobblestone support from the current dry stance",
            null, null, Items.COBBLESTONE, null);
        action.diamondRoute = true;
        action.prospectSupport = new ProspectSupport(foot, to, bearing);
        return true;
    }

    private boolean unverifiedProspectSupport(BlockPos cell) {
        return diamondRoute.attemptedSupports.contains(cell) && !diamondRoute.placedSupports.contains(cell);
    }

    private boolean aimDiamondCell(BlockPos cell, Vec3d point) {
        var route = diamondRoute;
        if (!cell.equals(route.aimCell)) {
            route.aimCell = cell;
            route.aimUntil = tick + 28;
        }
        if (tick >= route.aimUntil) return false;
        body.aim(point);
        enact("search", "Checking the exact next cut or landing in a freshly rendered view.");
        return true;
    }

    private boolean refuseDiamondBearing(String detail) {
        diamondRoute.nextBearing(detail);
        enact("search", detail);
        return true;
    }

    private boolean lightDiamondTread() {
        if (world.getBlockState(player.getBlockPos()).isOf(Blocks.TORCH))
            return refuseDiamondBearing("The placed light does not reveal a usable dry tread on this bearing.");
        if (!work.budget.canPlaceProspectTorch(player.getInventory()) || client.options.useKey.isUnbound())
            return refuseDiamondBearing("The tread is too dark. Lighting needs place:minecraft:torch, a placement and torch cost left, and carried light above its floor.");
        startWorkStep(Verb.WORK_PLACE, "Light the current dry foothold with one explicitly budgeted torch", null,
            null, Items.TORCH, null);
        action.diamondRoute = action.prospectLight = true;
        return true;
    }

    private boolean prospectForSource(AgentProgress progress, Predicate<BlockState> wanted) {
        BlockPos foot = player.getBlockPos();
        boolean availableSource = false;
        for (BlockState source : EARLY_SOURCES) {
            if (wanted.test(source) && workToolSlot(foot, source) >= 0
                    && roomFor(new ItemStack(AgentWorkOrder.harvest(source)))) {
                availableSource = true;
                break;
            }
        }
        var search = work.sourceSearch;
        if (!availableSource) {
            if (!search.stairs.isEmpty()) work.sourceBlock = "The job has no suitable allowed source tool or inventory space.";
            return false;
        }
        if (!dryProspectStance(foot)) {
            work.sourceBlock = "The current footing is not a stable full dry surface.";
            return false;
        }
        if (!settled()) {
            status = "Settling on dry footing before checking for a source";
            enact("search", status);
            return true;
        }
        if (search.stairUsed) {
            if (search.stairs.isEmpty()) {
                work.sourceBlock = "The prior staircase was already examined and exited. Use another witnessed route.";
                return false;
            }
            return prepareNextTread(foot, progress, wanted, search);
        }
        if (search.lastCover != null && foot.equals(search.cutFrom)) {
            return openSurfaceTread(foot, search.lastCover, search, tick);
        }
        if (search.steps < MAX_SOURCE_FOOTHOLDS && startSourceFoothold(foot, search)) return true;
        if (search.firstCover != null) {
            work.sourceBlock = "The one shallow window is elsewhere, and no unvisited dry foothold is in view.";
            return false;
        }
        // Try an independently witnessed UP contact even when the coarse view
        // missed the near tile. An unobserved tile can never be cut.
        if (startProspectCover(foot, progress, wanted, search)) return true;
        if (!foot.equals(search.lookedFrom) && search.looked.size() <= MAX_SOURCE_FOOTHOLDS && search.looked.add(foot)) {
            search.lookedFrom = foot;
            search.viewUntil = tick + 20;
            search.viewYaw = sourceFootingYaw(foot);
        }
        if (foot.equals(search.lookedFrom) && tick < search.viewUntil && !body.renderedDirection(search.viewYaw, 60, 5)) {
            body.turnFine(search.viewYaw, 60);
            status = "Aiming at witnessed near ground for a dry route or exact cover face";
            enact("search", status);
            return true;
        }
        if (work.sourceBlock == null)
            work.sourceBlock = "No unvisited dry foothold or lit adjacent cover outside the retained footing was verified.";
        return false;
    }

    private boolean startProspectCover(BlockPos foot, AgentProgress progress, Predicate<BlockState> wanted,
                                       SourceSearch search) {
        for (Direction direction : CARDINAL) {
            BlockPos cell = foot.down().offset(direction);
            if (search.footholds.contains(cell)) continue;
            BlockHitResult top = body.macroFloor(cell);
            if (top != null && admitProspectCover(foot, progress, wanted, search, top)) return true;
        }
        return false;
    }

    private boolean admitProspectCover(BlockPos foot, AgentProgress progress, Predicate<BlockState> wanted,
                                       SourceSearch search, BlockHitResult hit) {
        BlockPos cell = hit.getBlockPos();
        BlockState state = world.getBlockState(cell);
        Item drop = AgentWorkOrder.prospectCoverDrop(state);
        String name = Registries.BLOCK.getId(state.getBlock()).toString();
        if (drop == Items.AIR || wanted.test(state) || !prospectCutGeometry(foot, hit, search)) {
            if (search.stairUsed && work.sourceBlock == null)
                work.sourceBlock = drop == Items.AIR ? "Witnessed " + name + " is not an eligible dry cover material."
                    : wanted.test(state) ? "Witnessed " + name + " is a source, but it failed the source safety or tool check."
                    : "Witnessed " + name + " is outside the exact cut envelope or on retained footing.";
            return false;
        }
        if (!work.budget.policy.prospectCoverAllowed(state)) {
            work.sourceBlock = "Visible cover requires explicit break:" + name + ".";
        } else if (!work.budget.canCutCover()) {
            work.sourceBlock = "The work grant has " + work.budget.breaksLeft()
                + " breaks left; keep one for the source before cutting cover.";
        } else if (work.rejected.contains(cell) || !dryWorkBreakSafe(cell, state, drop, progress)) {
            work.sourceBlock = "The witnessed " + name + " cover is protected, wet, unstable, or already refused.";
        } else if (workToolSlot(cell, state) < 0) {
            work.sourceBlock = "No suitable tool for witnessed " + name + " fits the declared item costs and reserves.";
        } else if (!surfaceBodyAllowsExtension()) {
            return false;
        } else if (!surfaceLeaseAllowsBreak(search, Verb.BREAK.maxTicks)) {
            work.sourceBlock = "The work lease cannot allow another cover break and still leave time for the verified return.";
        } else {
            return startWorkBreak(face(hit), drop, true);
        }
        return false;
    }

    private boolean openSurfaceTread(BlockPos foot, BlockPos opening, SourceSearch search, long nowTick) {
        Direction bearing = search.cutBearing;
        if (bearing == null || !opening.equals(AgentSurfaceTread.nextFoot(foot, bearing))
                || !world.getBlockState(opening).isAir()) {
            work.sourceBlock = "The exact cut did not leave a clear adjacent one-block opening.";
            return false;
        }
        if (!surfaceLeaseAllowsExtension(search)) return false;
        // One retained edge per landed tread; reserving a full return in the
        // validated lease bounds storage even when a tread needs no cuts.
        Vec3d point = Vec3d.ofBottomCenter(opening).add(0.28 * bearing.getOffsetX(), -0.032, 0.28 * bearing.getOffsetZ());
        BlockHitResult floor = body.dryRouteFloor(point, opening.down());
        if (floor == null && aimAtStairCell(search, opening.down(), point, nowTick)) {
            return true;
        }
        if (floor == null) {
            work.sourceBlock = "The opening revealed no lit full dry floor for a one-block tread; staying on solid ground.";
            return false;
        }
        search.stairAim = null;
        var edge = new AgentSurfaceTread.Edge(foot, world.getBlockState(foot.down()), opening,
            world.getBlockState(floor.getBlockPos()), bearing);
        startSurfaceTread(edge, false);
        return true;
    }

    private boolean prepareNextTread(BlockPos foot, AgentProgress progress, Predicate<BlockState> wanted,
                                     SourceSearch search) {
        if (!foot.equals(search.stairs.getLast().lower())) {
            work.sourceBlock = "The player is no longer on the exact witnessed staircase.";
            return false;
        }
        if (!surfaceBodyAllowsExtension()) return false;
        Direction bearing = search.cutBearing;
        BlockPos next = AgentSurfaceTread.nextFoot(foot, bearing);
        for (int height = 1; height >= 0; --height) {
            BlockPos cell = next.up(height);
            if (cell.equals(height == 1 ? search.clearStairUpper : search.clearStairLower)
                    && world.getBlockState(cell).isAir()) continue;
            Vec3d point = height == 1
                ? Vec3d.ofCenter(cell).subtract(0.47 * bearing.getOffsetX(), 0, 0.47 * bearing.getOffsetZ())
                : AgentSurfaceTread.innerTop(cell, bearing);
            var hit = body.perceive(point, player.getEyePos().distanceTo(point) + 0.045).orElse(null);
            if (hit != null && AgentSurfaceTread.returnLip(foot, hit.getBlockPos(), bearing, hit.getSide()))
                return clearSurfaceLip(foot, progress, wanted, search, hit);
            if (hit != null && hit.getBlockPos().equals(cell) && AgentSurfaceTread.plannedCell(foot, cell, bearing, hit.getSide())) {
                BlockState state = world.getBlockState(cell);
                if (wanted.test(state) && !work.rejected.contains(cell) && workResourceSafe(hit, state, progress)
                        && startWorkBreak(face(hit), AgentWorkOrder.harvest(state), false)) return true;
                if (admitProspectCover(foot, progress, wanted, search, hit)) return true;
                if (work.sourceBlock == null)
                    work.sourceBlock = "The witnessed " + blockName(face(hit)) + " cannot be cut from this footing.";
                return false;
            }
            // A ray that hits another block is not proof of an empty cell.
            // Only its own lit air sample can authorize progressing to proof of the floor.
            if (body.dryRouteClear(point) == AgentBody.DryRouteSample.CLEAR && world.getBlockState(cell).isAir()) {
                if (height == 1) search.clearStairUpper = cell;
                else search.clearStairLower = cell;
                continue;
            }
            if (aimAtStairCell(search, cell, point, tick)) return true;
            work.sourceBlock = hit == null ? "No lit exact face or dry clearance is proven for the next stair cell."
                : "Witnessed " + blockName(face(hit)) + " blocks the next stair cell but is outside the authorized cut.";
            return false;
        }
        BlockPos lip = next.up(2);
        if (!lip.equals(search.clearStairLip) || !world.getBlockState(lip).isAir()) {
            Vec3d point = Vec3d.ofBottomCenter(lip).add(-0.38 * bearing.getOffsetX(), 0.15, -0.38 * bearing.getOffsetZ());
            var hit = body.perceive(point, player.getEyePos().distanceTo(point) + 0.035).orElse(null);
            if (hit != null && AgentSurfaceTread.returnLip(foot, hit.getBlockPos(), bearing, hit.getSide()))
                return clearSurfaceLip(foot, progress, wanted, search, hit);
            if (body.dryRouteClear(point) != AgentBody.DryRouteSample.CLEAR || !world.getBlockState(lip).isAir()) {
                if (aimAtStairCell(search, lip, point, tick)) return true;
                work.sourceBlock = hit == null ? "The next tread has no verified clear reverse-jump headroom."
                    : "Witnessed " + blockName(face(hit)) + " obstructs reverse-jump headroom outside the authorized lip.";
                return false;
            }
            search.clearStairLip = lip;
        }
        return openSurfaceTread(foot, next, search, tick);
    }

    private boolean clearSurfaceLip(BlockPos foot, AgentProgress progress, Predicate<BlockState> wanted,
                                    SourceSearch search, BlockHitResult hit) {
        BlockState state = world.getBlockState(hit.getBlockPos());
        if (wanted.test(state) && !work.rejected.contains(hit.getBlockPos()) && workResourceSafe(hit, state, progress)
                && startWorkBreak(face(hit), AgentWorkOrder.harvest(state), false)) return true;
        if (admitProspectCover(foot, progress, wanted, search, hit)) return true;
        if (work.sourceBlock == null)
            work.sourceBlock = "The witnessed " + blockName(face(hit)) + " lip obstructs the next tread and cannot be cut from here.";
        return false;
    }

    private boolean aimAtStairCell(SourceSearch search, BlockPos cell, Vec3d point, long nowTick) {
        if (!cell.equals(search.stairAim)) {
            search.stairAim = cell;
            search.stairAimUntil = nowTick + 28;
        }
        if (nowTick < search.stairAimUntil) {
            body.aim(point);
            status = "Checking the exact next stair face in a newly rendered view";
            enact("search", status);
            return true;
        }
        return false;
    }

    private long workTicksLeft() {
        return Math.min(work.order.expires() - tick, (work.deadline - now) / 50_000_000L);
    }

    private boolean surfaceLeaseAllowsBreak(SourceSearch search, long actionTicks) {
        return workTicksLeft() > actionTicks + AgentSurfaceTread.returnTicks(search.stairs.size());
    }

    private boolean surfaceLeaseAllowsExtension(SourceSearch search) {
        if (!surfaceBodyAllowsExtension()) return false;
        if (!AgentSurfaceTread.canExtend(workTicksLeft(), search.stairs.size())) {
            work.sourceBlock = "The work lease has " + Math.max(0, workTicksLeft())
                + " ticks left; keep time for a new tread and every verified reverse edge.";
            return false;
        }
        return true;
    }

    private boolean surfaceBodyAllowsExtension() {
        if (player.getHealth() > player.getMaxHealth() / 2 && player.getHungerManager().getFoodLevel() > 6
                && !client.options.forwardKey.isUnbound() && !client.options.jumpKey.isUnbound()) return true;
        work.sourceBlock = "The player's health, food, or available climb controls do not support extending the staircase.";
        return false;
    }

    private boolean startSourceFoothold(BlockPos foot, SourceSearch search) {
        if (client.options.forwardKey.isUnbound()) return false;
        search.footholds.add(foot.down());
        // An exposed bank takes precedence over unchanged flat ground on the current bearing.
        BlockHitResult bank = body.find(state -> AgentWorkOrder.prospectCoverDrop(state) != Items.AIR, 8,
            hit -> hit.getSide().getAxis().isHorizontal() && hit.getBlockPos().getY() >= foot.getY()).orElse(null);
        float yaw = player.getYaw();
        if (bank != null) {
            Vec3d delta = bank.getPos().subtract(player.getPos());
            yaw = heading(delta.x, delta.z);
        }
        Floor best = null;
        float bestTurn = Float.POSITIVE_INFINITY;
        for (Direction direction : CARDINAL) {
            BlockPos floor = foot.down().offset(direction);
            if (search.footholds.contains(floor) || search.attempted.contains(floor) || body.macroFloor(floor) == null) continue;
            Vec3d landing = Vec3d.ofBottomCenter(floor.up());
            BlockState support = world.getBlockState(floor);
            if (support.getBlock() instanceof FallingBlock || !body.macroFlatLane(floor, support, landing)
                    || !body.macroNoVisiblePickup(landing)) continue;
            float turn = Math.abs(MathHelper.wrapDegrees(direction.getPositiveHorizontalDegrees() - yaw));
            if (turn >= bestTurn) continue;
            best = new Floor(floor, support, landing);
            bestTurn = turn;
        }
        if (best == null) return false;
        search.attempted.add(best.pos);
        ++search.steps;
        String label = "Walk to a distinct witnessed dry foothold for source evidence";
        Offer approach = new Offer(null, new Key(Verb.APPROACH, best.pos, 0, null), label, "", 0, 0,
            best, null, null, null, null);
        action = new Action(null, approach, client, tick, now, body.renderedFrame(), 0, NO_ANCHORS, 42);
        action.durable = true;
        status = work.detail = label;
        enact("route", label);
        return true;
    }

    private float sourceFootingYaw(BlockPos foot) {
        Vec3d feet = player.getPos();
        float yaw = player.getYaw();
        BlockHitResult cue = body.find(state -> AgentWorkOrder.prospectCoverDrop(state) != Items.AIR, 4.5,
            hit -> {
                if (hit.getSide() != Direction.UP || hit.getBlockPos().getY() != foot.getY() - 1
                        || hit.getBlockPos().equals(foot.down())) return false;
                Vec3d point = hit.getPos();
                float change = Math.abs(MathHelper.wrapDegrees(heading(point.x - feet.x, point.z - feet.z) - yaw));
                return change >= 16 && change <= 55;
            }).orElse(null);
        return cue == null ? yaw : heading(cue.getPos().x - feet.x, cue.getPos().z - feet.z);
    }

    private boolean dryProspectStance(BlockPos foot) {
        BlockPos support = foot.down();
        BlockState state = world.getBlockState(support);
        return Math.abs(player.getY() - foot.getY()) <= 0.055 && !player.isTouchingWater()
            && !(state.getBlock() instanceof FallingBlock) && !state.isOf(Blocks.MAGMA_BLOCK)
            && state.getFluidState().isEmpty() && Block.isShapeFullCube(state.getCollisionShape(world, support));
    }

    private boolean prospectCutGeometry(BlockPos foot, BlockHitResult hit, SourceSearch search) {
        BlockPos cell = hit.getBlockPos();
        if (!retainedProspectStance(foot, cell, search)) return false;
        return search.stairs.isEmpty()
            ? search.firstCover == null && prospectBearing(foot, cell, hit.getSide()) != null
            : search.stairs.getLast().lower().equals(foot)
                && (AgentSurfaceTread.plannedCell(foot, cell, search.cutBearing, hit.getSide())
                    || AgentSurfaceTread.returnLip(foot, cell, search.cutBearing, hit.getSide()));
    }

    private boolean retainedProspectStance(BlockPos foot, BlockPos cell, SourceSearch search) {
        BlockState support = search.stairs.isEmpty() ? search.cutSupport : search.stairs.getLast().lowerSupport();
        return dryProspectStance(foot) && settled() && !search.footholds.contains(cell) && !cell.equals(foot.down())
            && (support == null || world.getBlockState(foot.down()) == support)
            && !player.getBoundingBox().expand(0.14, 0, 0.14).intersects(new Box(cell.getX(), foot.getY(),
                cell.getZ(), cell.getX() + 1, foot.getY() + 2, cell.getZ() + 1));
    }

    /** Only a positively witnessed neighboring cap can open the first tread. */
    static Direction prospectBearing(BlockPos foot, BlockPos cell, Direction side) {
        if (side == Direction.UP && cell.getY() == foot.getY() - 1) {
            for (Direction into : CARDINAL) if (cell.equals(foot.down().offset(into))) return into;
        }
        return null;
    }

    private int workToolSlot(BlockPos pos, BlockState block) {
        return workToolSlot(pos, block, false);
    }

    private int workToolSlot(BlockPos pos, BlockState block, boolean preserveDiamondTool) {
        var inventory = player.getInventory();
        int best = -1;
        float speed = 0;
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; i++) {
            ItemStack hand = inventory.getStack(i);
            if (block.isToolRequired() && !hand.isSuitableFor(block)) continue;
            if (!workLootCompatible(hand, block)) continue;
            int loss = AgentMiningStock.maxLoss(hand, block, world, pos);
            if (loss < 0 || loss > 0 && (work.budget.limit(hand.getItem(), count(hand.getItem())) < loss
                    || preserveDiamondTool && !diamondToolAvailable(i, true))) continue;
            float candidate = hand.getMiningSpeedMultiplier(block);
            if (candidate > speed || candidate == speed && i == inventory.selectedSlot) {
                best = i;
                speed = candidate;
            }
        }
        return best;
    }

    private boolean diamondToolAvailable(int excludedSlot, boolean lastUseDisallowed) {
        var inventory = player.getInventory();
        BlockState ore = (work.budget.policy.breakAllowed(Blocks.DEEPSLATE_DIAMOND_ORE.getDefaultState())
            ? Blocks.DEEPSLATE_DIAMOND_ORE : Blocks.DIAMOND_ORE).getDefaultState();
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; ++i) {
            if (i == excludedSlot) continue;
            ItemStack stack = inventory.getStack(i);
            if (!stack.isSuitableFor(ore) || !workLootCompatible(stack, ore)) continue;
            int loss = AgentMiningStock.maxLoss(stack, ore, world, player.getBlockPos());
            if (loss == 0 || loss > 0 && !lastUseDisallowed && work.budget.limit(stack.getItem(), count(stack.getItem())) >= loss)
                return true;
        }
        return false;
    }

    private boolean workLootCompatible(ItemStack hand, BlockState block) {
        return !hand.hasEnchantments() || AgentWorkOrder.harvest(block) == block.getBlock().asItem()
            || EnchantmentHelper.getLevel(world.getRegistryManager().getOrThrow(RegistryKeys.ENCHANTMENT)
                .getOrThrow(Enchantments.SILK_TOUCH), hand) == 0;
    }

    private Map.Entry<Item, Integer> missingWorkFloor() {
        return work.budget.missingFloor(player.getInventory());
    }

    private boolean startWorkRecipe(String key, int executions, BlockHitResult bench) {
        if (returnFromSurfaceStairs()) return true;
        Face face = null;
        if (AgentHands.workTableRecipe(key)) {
            if (personalCraft != null) return false;
            if (bench == null) return findWorkTable(key);
            if (work.budget.policy.smeltIron() && (!ironFooting(player.getBlockPos().down())
                    || bench.getBlockPos().getY() < player.getBlockY())) return false;
            face = face(bench);
        }
        if (!hands.workCraftable(key, work.budget)) return false;
        startWorkStep(Verb.CONTINUE, "Craft " + key + " within the work budget", face, null, null,
            new Recipe(key, null, null, 0, 0));
        action.executions = executions;
        action.tableInReach = personalCraft != null ? personalCraft.tableInReach : bench != null;
        return true;
    }

    private boolean findWorkTable(String recipe) {
        if (startStationRecall(personalTable)) return true;
        var known = work.budget.policy.smeltIron() ? null : body.find(state -> state.isOf(Blocks.CRAFTING_TABLE), INSPECT_REACH,
            hit -> !work.rejected.contains(hit.getBlockPos())).orElse(null);
        if (known != null && horizontalSquared(player.getPos(), Vec3d.ofCenter(known.getBlockPos())) > 1.0) {
            startWorkStep(Verb.WORK_WALK, "Approach the witnessed crafting table", face(known), null, null, null);
            action.destination = Vec3d.ofBottomCenter(known.getBlockPos());
            action.distanceLeft = horizontalSquared(player.getPos(), action.destination);
            return true;
        }
        if (!work.budget.canPlace() || !work.budget.policy.placeTable()) return false;
        int tables = count(Items.CRAFTING_TABLE);
        if (tables == 0 || work.budget.policy.smeltIron() && tables == work.budget.floor(Items.CRAFTING_TABLE)) {
            return !recipe.equals("crafting_table") && hands.workCraftable("crafting_table", work.budget)
                && startWorkRecipe("crafting_table", 1, null);
        }
        if (work.budget.limit(Items.CRAFTING_TABLE, tables) < 1) return false;
        var support = stationSupport(pos -> pos.getY() == player.getBlockY()
            && !work.rejected.contains(pos) && client.world.getBlockState(pos).isAir()
            && (!work.budget.policy.smeltIron() || furnaceSite(pos)));
        if (support == null) return false;
        startWorkStep(Verb.WORK_PLACE, "Place the authorized crafting table on visible footing",
            face(support), null, Items.CRAFTING_TABLE, null);
        return true;
    }

    private void searchWork(String reason) {
        if (deepWork() && work.sourceBlock != null) {
            retireWork("blocked", "interrupted", "Diamond prospecting stopped at " + diamondProgress() + " "
                + work.sourceBlock + " Remaining grant: " + work.budget.breaksLeft() + " breaks, "
                + work.budget.placementsLeft() + " placements, " + Math.max(0, workTicksLeft()) + " ticks.");
            holdWork();
            return;
        }
        if (work.sourceBlock != null) {
            work.sourceSearch.blockedAt = player.getBlockPos();
            reason = "Bounded surface search found no new actionable source. " + work.sourceBlock + " Remaining grant: "
                + work.budget.breaksLeft() + " breaks, " + Math.max(0, workTicksLeft()) + " ticks.";
        }
        if (returnFromSurfaceStairs()) {
            if (work.active()) work.sourceSearch.returnReason = reason;
            return;
        }
        retireWork("blocked", "interrupted", reason);
        holdWork();
    }

    private boolean returnFromSurfaceStairs() {
        var search = work.sourceSearch;
        if (search.stairs.isEmpty()) {
            search.returning = false;
            return false;
        }
        if (search.returnFailed || !search.stairs.getLast().lower().equals(player.getBlockPos())) {
            retireWork("blocked", "interrupted", "The exact reverse stair edge could not be revalidated; no movement was authorized.");
            holdWork();
            return true;
        }
        search.returning = true;
        startSurfaceTread(search.stairs.getLast(), true);
        return true;
    }

    private void startSurfaceTread(AgentSurfaceTread.Edge edge, boolean returning) {
        boolean level = edge.upper().getY() == edge.lower().getY();
        String label = deepWork() && returning ? "Return over the next retained dry edge toward an earlier sector"
            : returning ? "Climb the witnessed reverse surface stair edge"
            : level ? "Walk to a distinct witnessed same-level footing with a return edge"
            : "Check and descend one witnessed dry tread with a return edge";
        startWorkStep(Verb.WORK_TREAD, label, null, null, null, null);
        action.tread = new AgentSurfaceTread(edge, returning, tick);
        action.distanceLeft = player.getPos().squaredDistanceTo(Vec3d.ofBottomCenter(action.tread.to));
    }

    private void advanceSurfaceTread(AgentProgress progress) {
        var search = work.sourceSearch;
        var tread = action.tread;
        switch (tread.step(client, body, tick)) {
            case CHECKING -> {}
            case MOVING -> {
                double distance = player.getPos().squaredDistanceTo(Vec3d.ofBottomCenter(tread.to));
                if (distance + 0.005 < action.distanceLeft) {
                    action.distanceLeft = distance;
                    continuityWork = AgentPauseEpisodes.Work.ROUTE;
                }
            }
            case REFUSED -> interrupt("The exact dry tread, landing or reverse headroom could not be revalidated.", true);
            case LANDED -> {
                boolean supported = action.diamondRoute && !tread.returning && diamondRoute.placedSupports.contains(tread.to.down());
                if (action.diamondRoute) {
                    progress.recordMacroDryTread(tread.from, tread.to);
                    if (tread.returning) diamondRoute.returnOne();
                    else recordDiamondTread(tread.edge, false);
                } else {
                    if (tread.returning) search.stairs.removeLast();
                    else {
                        search.stairs.addLast(tread.edge);
                        search.stairUsed = true;
                    }
                    search.footholds.add(tread.from.down());
                    search.footholds.add(tread.to.down());
                }
                search.freshAfter = body.renderedFrame();
                search.stairAim = null;
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                boolean pickup = action.stairDrop != null && action.stairDrop.isRemoved()
                    && count(action.tracked) > action.stairStock;
                if (action.diamondRoute && pickup) work.lastHarvest = null;
                String depth = action.diamondRoute ? " at Y=" + tread.to.getY() : "";
                boolean level = tread.from.getY() == tread.to.getY();
                complete(action.diamondRoute && tread.returning ? "Grounded" + depth + " after traversing the retained reverse edge."
                    : tread.returning ? "Grounded on the exact upper support after a vanilla return climb."
                    : pickup ? "Grounded on the lower tread" + depth + "; the witnessed drop disappeared with matching inventory gain."
                    : supported ? "Grounded" + depth + " on the confirmed minecraft:cobblestone support with its intact return edge."
                    : level ? "Grounded on a distinct level foothold" + depth + " with its intact return edge."
                    : "Grounded on the verified lower tread" + depth + " with its intact reverse edge.");
            }
        }
    }

    private void runWorkStep(AgentProgress progress) {
        if (action == null) return; // The source search may instead be settling or preparing a rendered view.
        Verb verb = action.offer.key.verb;
        if (personalCraft != null) {
            // This is the only exit from a retained personal inventory into another action.
            if (verb != Verb.CONTINUE || action.offer.face != null) {
                interrupt("The retained personal crafting screen is no longer available.", true);
                return;
            }
            action.opened = client.currentScreen;
            personalCraft = null; // The new Hands job takes over this exact screen below.
        }
        status = action.offer.summary;
        if (tick - action.started > verb.maxTicks) {
            interrupt(timeoutDetail(), true);
        } else if (!hazardClear || !client.isWindowFocused() || client.getOverlay() != null
                || client.interactionManager == null || client.interactionManager.getCurrentGameMode() != GameMode.SURVIVAL
                || !(grounded() || (verb == Verb.WORK_WALK || verb == Verb.WORK_TREAD
                        || verb == Verb.FOLLOW && action.diamondRoute && progress.dryRouteInFlight(action.offer.route))
                    && !player.isTouchingWater() && !player.hasVehicle())) {
            interrupt("The work step lost its safe footing, focus or Survival controls.", true);
        } else if (verb == Verb.BREAK && !action.broken && !work.sourceSearch.stairs.isEmpty()
                && !surfaceLeaseAllowsBreak(work.sourceSearch, Math.max(1, verb.maxTicks - (tick - action.started)))) {
            interrupt("The remaining lease is reserved for the verified stair return.", true);
        } else switch (verb) {
            case WORK_WALK -> advanceWorkWalk(progress);
            case WORK_TREAD -> advanceSurfaceTread(progress);
            case WORK_EQUIP -> advanceWorkEquip();
            case WORK_PLACE -> {
                if (action.prospectSupport != null) advanceProspectSupport();
                else if (action.prospectLight) advanceProspectLight();
                else advanceWorkPlacement();
            }
            case WORK_SMELT -> advanceIronWork();
            case WORK_FILL -> advanceWaterWork();
            default -> step(progress);
        }
    }

    private boolean waterFooting(Floor floor) {
        return grounded() && hazardClear && !urgent && ironFooting(floor.pos) && body.keysNeutral()
            && !player.isSneaking() && !player.isSprinting()
            && horizontalSquared(player.getPos(), floor.landing) <= 0.0144
            && world.getBlockState(floor.pos) == floor.state;
    }

    private void startWaterWork() {
        Offer clue = work.waterClue;
        if (!work.budget.canFillWater(player.getInventory())) {
            retireWork("blocked", "interrupted", "No one-bucket fill fits the exact cost and current reserves.");
        } else if (!available() || !waterFooting(clue.floor) || !useAvailable()
                || !body.waterFillWitness(clue.face.hit, reach())) {
            retireWork("blocked", "interrupted", "The exact source is no longer witnessed from the same stable dry stance.");
        } else if (!player.getOffHandStack().isEmpty()) {
            retireWork("blocked", "interrupted", "The off hand must be empty for an isolated bucket use.");
        } else {
            startWorkStep(Verb.WORK_FILL, "Check the witnessed source and fill one empty bucket", clue.face, null, Items.BUCKET, null);
        }
    }

    private void advanceWaterWork() {
        var inventory = player.getInventory();
        if (action.fired) {
            if (work.budget.confirmsWaterFill(inventory, action.itemCount, action.waterUseReceipt)) {
                waterReceiptUntil = 0;
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                String detail = "Vanilla accepted the exact source-water use and swapped one empty bucket for one water bucket.";
                complete(detail);
                work.completedTick = tick;
                retireWork("complete", "completed", detail);
            } else if (tick > waterReceiptUntil) {
                interrupt("The one source-water use did not confirm both its receipt and the exact bucket swap.", true);
            } else {
                enact("fill", "Waiting for the exact source-use receipt and one vanilla bucket swap; no repeat is authorized.");
            }
            return;
        }
        BlockHitResult hit = work.waterClue.face.hit;
        if (!waterFooting(work.waterClue.floor) || !work.budget.canFillWater(inventory)
                || !player.getOffHandStack().isEmpty()
                || action.craftJob != 0 && action.craftJob != hands.jobGeneration()) {
            interrupt("The dry stance, reserves, or scoped bucket equipment changed.", true);
            return;
        }
        if (hands.busy()) {
            hands.tick();
            return;
        }
        if (client.currentScreen != null || !cursorClear() || !useAvailable()) {
            interrupt("The normal, neutral use controls are not available.", true);
            return;
        }
        if (!body.hasRecentView()) return;
        if (!body.waterFillWitness(hit, reach())) {
            interrupt("The exact reachable source is no longer exposed in the rendered view.", true);
            return;
        }
        if (!player.getMainHandStack().isOf(Items.BUCKET)) {
            if (action.craftJob != 0) {
                interrupt("Vanilla did not select the empty bucket.", true);
                return;
            }
            hands.equipForUse(stack -> stack.isOf(Items.BUCKET));
            if (hands.busy()) action.craftJob = hands.jobGeneration();
            else interrupt("The empty bucket cannot be selected through the current inventory.", true);
            return;
        }
        if (count(Items.BUCKET) != action.itemCount || !waterBucketFits(inventory)) {
            interrupt("The original empty bucket stock changed or the filled bucket would not fit.", true);
            return;
        }
        if (body.useWaterSource(hit.getBlockPos(), hit.getPos(), AgentBody.Preparation.READY)) {
            work.budget.issuedWaterFill(); // A predicted input still consumes this one-shot permission.
            action.fired = true;
            action.firedAt = tick;
            waterReceiptUntil = tick + 24;
        }
    }

    private static boolean waterBucketFits(PlayerInventory inventory) {
        if (inventory.getMainHandStack().getCount() == 1) return true;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++)
            if (inventory.getStack(slot).isEmpty()) return true;
        return false;
    }

    /** Scope the already queued vanilla edge, not a second actuator. */
    boolean allowScopedWaterUse() {
        if (action == null || action.offer.key.verb != Verb.WORK_FILL || !action.fired) return true;
        if (action.firedAt != tick || action.waterUseEntered || client.player != player || client.world != world) return false;
        action.waterUseEntered = true;
        var inventory = player.getInventory();
        return work.active() && System.nanoTime() < work.deadline && input.active && waterFooting(work.waterClue.floor)
            && cursorClear() && useAvailable() && count(Items.BUCKET) == action.itemCount
            && work.budget.waterFillStockSafe(inventory) && waterBucketFits(inventory)
            && body.scopedWaterUseCurrent(action.offer.face.hit);
    }

    void confirmScopedWaterUse() {
        if (action == null || action.offer.key.verb != Verb.WORK_FILL || action.firedAt != tick
                || !action.waterUseEntered || action.waterUseReceipt) return;
        action.waterUseReceipt = true;
        body.confirmedWaterUse(action.offer.face.hit);
    }

    void clearUnconsumedWaterUse() {
        if (action != null && action.offer.key.verb == Verb.WORK_FILL && action.fired
                && action.firedAt == tick && !action.waterUseEntered) {
            action.waterUseEntered = true;
            client.options.useKey.wasPressed();
        }
    }

    private void advanceWorkWalk(AgentProgress progress) {
        if (client.currentScreen != null || !cursorClear()) {
            interrupt("A different screen replaced the working view.", false);
            return;
        }
        ItemEntity drop = action.offer.drop;
        if (drop != null) {
            if (count(action.offer.item) > action.itemCount && drop.isRemoved()) {
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                complete("Vanilla confirmed a " + (count(action.offer.item) - action.itemCount) + " item gain of "
                    + Registries.ITEM.getId(action.offer.item) + " after collecting its witnessed drop.");
                return;
            }
            if (drop.isRemoved()) {
                if (action.pickupDisappeared == 0) action.pickupDisappeared = tick;
                if (tick - action.pickupDisappeared > 6)
                    interrupt("The authorized drop disappeared without an inventory gain.", true);
                return;
            }
            if (action.timberWalk && !updateTimberDrop(drop)) return;
        }
        if (action.timberWalk) rememberTimberView();
        double distance = horizontalSquared(player.getPos(), action.destination);
        if (action.drove && distance + 0.008 < action.distanceLeft) {
            action.distanceLeft = distance;
            continuityWork = AgentPauseEpisodes.Work.ROUTE;
        }
        if (!body.hasRecentView()) return;
        if (action.timberWalk && drop == null) {
            var target = work.order.policy().target();
            Item stock = goalStock(target);
            boolean stockReady = stock != null && count(stock) >= goalAmount(target) && missingWorkFloor() == null;
            boolean ready = horizontalSquared(action.position, player.getPos()) >= 0.36 && visibleFace(action.offer.face);
            if (stockReady || ready || distance <= 0.16 && Math.abs(player.getY() - action.destination.y) <= 0.12) {
                if (grounded() && settled()) {
                    if (!stockReady && !ready && !work.timberLookUsed)
                        startTimberLook(new TimberSight(action.offer.face, tick));
                    complete(stockReady ? "Vanilla inventory reached the authorized stock while walking."
                        : "Reached dry footing beside the witnessed trunk, outside its occupied cell.");
                }
                return;
            }
            if (!progress.macroWorkWalk(action.destination))
                interrupt("No safe visible lane remains to the retained timber stance.", true);
            return;
        }
        if (drop == null && (distance <= 1.35 * 1.35 || visibleFace(action.offer.face)
                && horizontalSquared(action.position, player.getPos()) >= 0.35)) {
            if (settled()) complete("Reached a closer safe stance for the retained witnessed target.");
            return;
        }
        if (drop != null && distance < (action.timberWalk ? 0.055 : 0.15) && action.settledAt == 0)
            action.settledAt = tick;
        if (action.timberWalk && drop != null && distance > 0.15) action.settledAt = 0;
        if (drop != null && action.settledAt != 0 && tick - action.settledAt > (action.timberWalk ? 20 : 12)) {
            interrupt("The witnessed drop did not enter inventory at its landing.", true);
        } else if (action.timberWalk && drop != null && distance < 0.055) {
            body.aim(action.destination.add(0, 0.10, 0));
        } else if (!progress.macroWorkWalk(action.destination)) {
            interrupt("No safe visible lane remains toward the retained target.", true);
        }
    }

    private boolean updateTimberDrop(ItemEntity drop) {
        if (body.visibleEntity(entity -> entity == drop && drop.getStack().isOf(action.offer.item), 8).isPresent()) {
            Vec3d location = drop.getPos();
            if (horizontalSquared(location, action.destination) > 0.04) {
                action.distanceLeft = horizontalSquared(player.getPos(), location);
                action.settledAt = 0;
            }
            action.destination = location;
            action.timberDropSeen = tick;
        }
        if (tick - action.timberDropSeen > 8) {
            if (tick - action.timberDropSeen > 23)
                interrupt("The witnessed timber drop could not be reacquired near its last visible landing.", true);
            else body.aim(action.destination.add(0, 0.10, 0));
            return false;
        }
        double height = action.destination.y - player.getY();
        if (height > 1 || height < -0.7) {
            if (tick - action.started > 26)
                interrupt("The witnessed timber drop did not settle at a reachable height.", true);
            else body.aim(action.destination.add(0, 0.10, 0));
            return false;
        }
        return true;
    }

    private void advanceWorkEquip() {
        if (action.craftJob != 0 && action.craftJob != hands.jobGeneration()) {
            interrupt("The work equipment job was replaced.", false);
        } else if (hands.busy()) {
            hands.tick();
        } else if (action.craftJob != 0) {
            if (action.tracked != null && player.getMainHandStack().isOf(action.tracked) || action.tracked == Items.AIR
                    && player.getMainHandStack().isEmpty()) complete("Vanilla selected the admitted tool.");
            else interrupt("Vanilla did not select the admitted tool.", true);
        } else {
            ItemStack stack = player.getInventory().getStack(action.workSlot);
            action.tracked = stack.getItem();
            if (hands.equipSlot(action.workSlot)) complete("The admitted tool is already selected.");
            else if (hands.busy()) action.craftJob = hands.jobGeneration();
            else interrupt("The intended tool cannot be selected through the current inventory.", true);
        }
    }

    private void advanceProspectSupport() {
        var build = action.prospectSupport;
        if (!build.from.equals(player.getBlockPos()) || !settled() || !dryProspectStance(build.from)
                || world.getBlockState(build.from.down()) != diamondRoute.support) {
            interrupt("Lost the retained dry stance during the attached support check.", true);
            return;
        }
        if (action.fired) {
            body.aim(build.floor);
            BlockHitResult top = null;
            if (body.renderedFrame() > action.placementFrame) {
                top = body.dryRouteFloor(build.floor, build.cell);
                if (top == null) top = body.dryRouteFloor(build.alternateFloor, build.cell);
            }
            if (top != null && world.getBlockState(top.getBlockPos()).isOf(Blocks.COBBLESTONE)
                    && count(Items.COBBLESTONE) == build.countBefore - 1) {
                diamondRoute.placedSupports.add(build.cell);
                ++work.confirmedPlacements;
                work.sourceSearch.freshAfter = body.renderedFrame();
                diamondRoute.aimCell = null;
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                complete("Vanilla confirmed one attached minecraft:cobblestone top and the matching debit; not yet crossed.");
            } else if (tick - action.firedAt > 22) {
                String observed = top == null ? "No new lit top was visible." : "The visible top or one-block inventory debit did not match.";
                interrupt("The one issued minecraft:cobblestone placement was not confirmed. " + observed, true);
            }
            return;
        }
        if (!work.budget.canPlaceProspectSupport(player.getInventory()) || client.options.useKey.isUnbound()
                || !player.getOffHandStack().isEmpty() || player.isUsingItem()
                || action.craftJob != 0 && action.craftJob != hands.jobGeneration()) {
            interrupt("The held cobblestone, shared placement budget or use controls no longer allow one support.", true);
            return;
        }
        if (hands.busy()) {
            hands.tick();
            return;
        }
        if (client.currentScreen != null || !cursorClear() || !body.hasRecentView()) return;
        if (!build.spaceSeen) {
            body.aim(build.low);
            var low = body.footholdSpace(build.low);
            var high = body.footholdSpace(build.high);
            if (low == AgentBody.FootholdSpace.FLUID || high == AgentBody.FootholdSpace.FLUID
                    || low == AgentBody.FootholdSpace.OCCUPIED || high == AgentBody.FootholdSpace.OCCUPIED) {
                interrupt("The exact support cell contains visible fluid or material; no replacement was attempted.", true);
            } else if (low == AgentBody.FootholdSpace.EMPTY && high == AgentBody.FootholdSpace.EMPTY) {
                build.spaceSeen = true;
            } else if (tick - action.started > 24) {
                interrupt("Two lit samples could not verify the same support cell as empty and dry.", true);
            }
            return;
        }
        if (build.anchorIndex >= 4) {
            interrupt("No reachable, lit stable side or floor face could attach the single support.", true);
            return;
        }
        Direction offset = build.anchorOffset();
        BlockPos anchor = build.cell.offset(offset);
        Vec3d point = AgentBody.footholdAttachmentAim(anchor, offset, build.bearing);
        body.aim(point);
        if (build.faceUntil == 0) build.faceUntil = tick + 13;
        BlockHitResult hit = body.perceive(point, reach()).orElse(null);
        if (hit == null || !hit.getBlockPos().equals(anchor) || hit.getSide() != offset.getOpposite()
                || !body.footholdAttachment(hit, build.cell)) {
            if (tick >= build.faceUntil) {
                ++build.anchorIndex;
                build.faceUntil = 0;
            }
            return;
        }
        var low = body.footholdSpace(build.low);
        var high = body.footholdSpace(build.high);
        if (low == AgentBody.FootholdSpace.FLUID || high == AgentBody.FootholdSpace.FLUID
                || low == AgentBody.FootholdSpace.OCCUPIED || high == AgentBody.FootholdSpace.OCCUPIED) {
            interrupt("The witnessed empty support cell changed before use.", true);
            return;
        }
        if (low != AgentBody.FootholdSpace.EMPTY || high != AgentBody.FootholdSpace.EMPTY) {
            if (tick >= build.faceUntil) {
                ++build.anchorIndex;
                build.faceUntil = 0;
            }
            return;
        }
        // Neighbor fluid can veto an already witnessed candidate. It never identifies a placeable cell.
        for (Direction side : Direction.values()) {
            if (!world.getBlockState(build.cell.offset(side)).getFluidState().isEmpty()) {
                interrupt("A fluid safety veto prevents placing into or beside a flow; no support was used.", true);
                return;
            }
        }
        if (!body.dryRouteBuildClear(build.from, build.to)
                || !AgentSurfaceTread.reverseClear(client, build.from, build.to, build.bearing)) {
            interrupt("The proposed support would not give clear dry body space and a usable reverse edge.", true);
            return;
        }
        if (!player.getMainHandStack().isOf(Items.COBBLESTONE)) {
            if (!hands.equipForUse(stack -> stack.isOf(Items.COBBLESTONE)) && hands.busy())
                action.craftJob = hands.jobGeneration();
            else if (!hands.busy() && !player.getMainHandStack().isOf(Items.COBBLESTONE))
                interrupt("Vanilla inventory could not equip the explicitly authorized cobblestone.", true);
            build.faceUntil = 0;
            return;
        }
        body.sneak();
        int before = count(Items.COBBLESTONE);
        if (body.placeFoothold(hit, build.cell, player.isSneaking() ? AgentBody.Preparation.READY : AgentBody.Preparation.STANCE)) {
            work.budget.placedProspectSupport();
            diamondRoute.attemptedSupports.add(build.cell);
            build.countBefore = before;
            action.fired = true;
            action.firedAt = tick;
            action.placementFrame = body.renderedFrame();
        } else if (tick >= build.faceUntil) {
            ++build.anchorIndex;
            build.faceUntil = 0;
        }
    }

    private void advanceProspectLight() {
        BlockPos foot = BlockPos.ofFloored(action.position);
        if (action.fired) {
            if (world.getBlockState(foot).isOf(Blocks.TORCH) && count(Items.TORCH) == action.itemCount - 1) {
                ++work.confirmedPlacements;
                work.sourceSearch.freshAfter = body.renderedFrame();
                diamondRoute.aimCell = null;
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                complete("Vanilla confirmed one explicitly budgeted torch on the current dry support.");
            } else if (tick - action.firedAt > 12) {
                interrupt("The authorized torch use did not confirm placement and matching stock loss.", true);
            }
            return;
        }
        if (!foot.equals(player.getBlockPos()) || !foot.equals(diamondRoute.foot) || !dryProspectStance(foot)
                || world.getBlockState(foot.down()) != diamondRoute.support || !world.getBlockState(foot).isAir()
                || !work.budget.canPlaceProspectTorch(player.getInventory()) || client.options.useKey.isUnbound()
                || player.isUsingItem() || client.interactionManager.isBreakingBlock()
                || (action.craftJob != 0 && action.craftJob != hands.jobGeneration())) {
            interrupt("The exact dry torch support, inventory, or placement permission changed.", true);
            return;
        }
        if (hands.busy()) {
            hands.tick();
            return;
        }
        if (!player.getMainHandStack().isOf(Items.TORCH)) {
            if (!hands.equipForUse(stack -> stack.isOf(Items.TORCH)) && hands.busy())
                action.craftJob = hands.jobGeneration();
            return;
        }
        Vec3d point = Vec3d.ofBottomCenter(foot).add(0.34 * diamondRoute.bearing.getOffsetX(), -0.045,
            0.34 * diamondRoute.bearing.getOffsetZ());
        body.aim(point);
        body.sneak();
        BlockHitResult hit = body.perceive(point, 3.5).orElse(null);
        var mode = AgentBody.Contact.PRECISE;
        if (hit == null && body.aligned(point)) {
            hit = body.selectedFace(); // Only the outline of the support already under the player.
            mode = AgentBody.Contact.OUTLINE;
        }
        if (hit != null && hit.getBlockPos().equals(foot.down()) && hit.getSide() == Direction.UP
                && body.useContact(hit, mode, player.isSneaking() ? AgentBody.Preparation.READY : AgentBody.Preparation.STANCE)) {
            work.budget.placedProspectTorch(); // No retry can escape the cap after a use edge was issued.
            action.fired = true;
            action.firedAt = tick;
        }
    }

    private void advanceWorkPlacement() {
        Face support = action.offer.face;
        BlockPos dest = support.hit.getBlockPos().up();
        Item item = action.offer.item;
        boolean furnace = item == Items.FURNACE;
        Block station = furnace ? Blocks.FURNACE : Blocks.CRAFTING_TABLE;
        if (action.fired) {
            if (client.world.getBlockState(dest).isOf(station) && count(item) == action.itemCount - 1) {
                stationPlacement = new StationPlacement(dest, world.getBlockState(dest), player.getPos(),
                    action.placementFrame, tick + 5);
                witnessStationPlacement();
                ++work.confirmedPlacements;
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                if (furnace) {
                    work.placedFurnace = dest;
                    work.sourceSearch.freshAfter = body.renderedFrame();
                }
                complete("Vanilla confirmed the authorized " + (furnace ? "furnace" : "table")
                    + " placement and matching inventory decrement.");
            } else if (tick - action.firedAt > 12) {
                interrupt("Vanilla did not confirm the authorized placement.", true);
            }
            return;
        }
        if (action.craftJob != 0 && action.craftJob != hands.jobGeneration()) {
            interrupt("The placement equipment job was replaced.", false);
            return;
        }
        if (hands.busy()) {
            hands.tick();
            return;
        }
        if (!body.hasRecentView()) return;
        if ((furnace ? !work.budget.canPlaceFurnace(player.getInventory()) || !furnaceSite(dest)
                    || !ironFooting(player.getBlockPos().down())
                : work.budget.limit(item, count(item)) < 1)
                || !work.budget.canPlace() || !client.world.getBlockState(dest).isAir()
                || !visible(support) || player.getBoundingBox().intersects(new Box(dest))) {
            interrupt("The placement face, free space or material permission changed.", true);
            return;
        }
        if (!player.getMainHandStack().isOf(item)) {
            hands.equipForUse(stack -> stack.isOf(item));
            if (hands.busy()) action.craftJob = hands.jobGeneration();
            else if (furnace) interrupt("The authorized furnace cannot be equipped through the current inventory.", true);
            return;
        }
        body.sneak();
        if (body.useContact(support.hit, AgentBody.Contact.PLACE,
                player.isSneaking() ? AgentBody.Preparation.READY : AgentBody.Preparation.STANCE)) {
            if (furnace) work.budget.placedFurnace();
            else work.budget.placedTable();
            action.fired = true;
            action.firedAt = tick;
            action.placementFrame = body.renderedFrame();
        }
    }

    private BlockHitResult stationSupport(Predicate<BlockPos> lawful) {
        Predicate<BlockPos> site = pos -> lawful.test(pos)
            && !(world.getBlockState(pos.down()).getBlock() instanceof FallingBlock);
        if (personalTable != null || personalFurnace != null) {
            Vec3d eye = player.getEyePos();
            var preferred = body.stationFace(null, pos -> {
                if (!site.test(pos)) return false;
                Box placement = new Box(pos);
                return !blocksStationFace(placement, eye, personalTable)
                    && !blocksStationFace(placement, eye, personalFurnace);
            }, true);
            if (preferred != null) return preferred;
        }
        return body.stationFace(null, site, true);
    }

    private static boolean blocksStationFace(Box placement, Vec3d eye, PersonalStation known) {
        // Test only the proposed full block against a previously witnessed sightline.
        return known != null && placement.raycast(eye, known.face.hit.getPos()).isPresent();
    }

    private boolean dryWorkshopSupport(BlockPos floor) {
        BlockState state = world.getBlockState(floor);
        return state.getFluidState().isEmpty() && !(state.getBlock() instanceof FallingBlock)
            && state.isSideSolidFullSquare(world, floor, Direction.UP);
    }

    private boolean ironFooting(BlockPos floor) {
        BlockPos foot = player.getBlockPos();
        return foot.getX() == floor.getX() && foot.getZ() == floor.getZ() && foot.getY() == floor.getY() + 1
            && hands.stableCraftFooting() && settled() && dryWorkshopSupport(floor)
            && Math.abs(player.getY() - floor.getY() - 1) <= 0.06;
    }

    private boolean furnaceSite(BlockPos dest) {
        return dest.getY() == player.getBlockY() && !work.rejected.contains(dest)
            && world.getBlockState(dest).isAir() && dryWorkshopSupport(dest.down());
    }

    private int ironTimeLimit() {
        long remaining = Math.min(work.order.expires() - tick, (work.deadline - now) / 50_000_000L);
        return (int) Math.max(0, (remaining - FURNACE_CLICK_MARGIN) / AgentHands.SMELT_TICKS);
    }

    private boolean inspectIronSites() {
        if (work.ironSiteLookUntil == 0) {
            work.ironSiteLookUntil = tick + 24;
            work.ironSiteYaw = player.getYaw();
        }
        if (tick >= work.ironSiteLookUntil) return false;
        body.turnFine(work.ironSiteYaw, 55);
        ironStatus("Checking the nearby dry support from the current footing; no movement was authorized.");
        return true;
    }

    private String ironSupplyShortfall() {
        if (work.budget.craftsLeft() <= 0) return "No shared recipe executions remain for smelting iron.";
        if (ironTimeLimit() == 0) return "The finite lease has no room for a full 200-tick iron smelt and vanilla clicks.";
        if (work.budget.limit(Items.RAW_IRON, count(Items.RAW_IRON)) == 0)
            return "No carried minecraft:raw_iron can be used within its exact cap and reserve.";
        return "No carried single type of allowed fuel supplies 200 vanilla burn ticks within its exact cap and reserve.";
    }

    private boolean startIronWork(int needed, BlockHitResult table, AgentProgress progress) {
        BlockPos footing = player.getBlockPos().down();
        if (returnFromSurfaceStairs()) return true;
        if (work.collectedIron) {
            searchWork("The witnessed furnace batch was collected, but actual iron stock still needs " + needed
                + "; this lease does not reload the furnace.");
            return false;
        }
        if (!settled() && dryWorkshopSupport(footing)) {
            enact("hold", "Waiting for the body to settle on the current dry workshop footing.");
            return false;
        }
        if (!ironFooting(footing)) {
            searchWork("No stable dry full-block stance for furnace work; no step off this footing was authorized.");
            return false;
        }
        if (client.options.useKey.isUnbound()) {
            searchWork("The vanilla use key is unbound; a furnace cannot be opened or placed.");
            return false;
        }
        if (hands.quoteIron(work.budget, Math.min(needed, ironTimeLimit())) == null) {
            searchWork(ironSupplyShortfall());
            return false;
        }
        var witnessed = body.find(state -> state.isOf(Blocks.FURNACE) && !state.get(AbstractFurnaceBlock.LIT), reach(),
            hit -> hit.getBlockPos().equals(work.placedFurnace) && hit.getBlockPos().getY() >= player.getBlockY()).orElse(null);
        if (witnessed == null && personalFurnace != null && personalFurnace.attempted) {
            var live = visibleStation(Blocks.FURNACE, personalFurnace.face.hit.getBlockPos());
            if (live != null && live.getBlockPos().getY() >= player.getBlockY()
                    && !work.rejected.contains(live.getBlockPos())
                    && !world.getBlockState(live.getBlockPos()).get(AbstractFurnaceBlock.LIT)) witnessed = live;
        }
        if (witnessed == null)
            witnessed = body.find(state -> state.isOf(Blocks.FURNACE) && !state.get(AbstractFurnaceBlock.LIT), reach(),
                hit -> !work.rejected.contains(hit.getBlockPos()) && hit.getBlockPos().getY() >= player.getBlockY()).orElse(null);
        if (witnessed != null) {
            startWorkStep(Verb.WORK_SMELT, "Open the witnessed furnace without leaving the dry stance",
                face(witnessed), null, null, null);
            action.furnace = new FurnaceWork(footing);
            return true;
        }
        if (stationRecallReady(personalFurnace)
                && personalFurnace.face.hit.getBlockPos().getY() >= player.getBlockY()
                && visibleStation(Blocks.FURNACE, personalFurnace.face.hit.getBlockPos()) == null
                && startStationRecall(personalFurnace)) return true;
        if (work.placedFurnace != null) {
            searchWork("The one placed furnace is not currently witnessed cold and reachable from the dry stance.");
        } else if (!work.budget.policy.placeFurnace()) {
            searchWork("No cold furnace is witnessed in reach; place:minecraft:furnace was not authorized.");
        } else if (!work.budget.canPlace() || work.budget.remainingCost(Items.FURNACE) == 0) {
            searchWork("No furnace placement or minecraft:furnace cost remains in the work budget.");
        } else if (work.budget.canPlaceFurnace(player.getInventory())) {
            var support = stationSupport(this::furnaceSite);
            if (support != null) {
                startWorkStep(Verb.WORK_PLACE, "Place one authorized furnace on witnessed dry support",
                    face(support), null, Items.FURNACE, null);
                return true;
            }
            if (!inspectIronSites())
                searchWork("No free, reachable same-level furnace site on witnessed full dry support.");
        } else if (count(Items.FURNACE) < work.budget.floor(Items.FURNACE)) {
            searchWork("The carried furnace stock is below its declared reserve; crafting one furnace would not leave one to place.");
        } else if (!work.budget.policy.craftAllowed("furnace")) {
            searchWork("No carried furnace is available above its reserve, and craft:furnace was not authorized.");
        } else if (work.budget.craftsLeft() < 2) {
            searchWork("Crafting a furnace and smelting its first iron need two shared recipe executions.");
        } else {
            if (table != null && table.getBlockPos().getY() < player.getBlockY()) table = null;
            if (table == null && stationRecallReady(personalTable)
                    && personalTable.face.hit.getBlockPos().getY() >= player.getBlockY()
                    && hands.workCraftable("furnace", work.budget) && startStationRecall(personalTable)) return true;
            if (table == null && (!work.budget.policy.placeTable() || work.budget.placementsLeft() < 2
                    || work.budget.remainingCost(Items.CRAFTING_TABLE) == 0)) {
                searchWork("No crafting table is witnessed in reach; both the table and furnace need their own placement permissions and costs.");
            } else if (table == null && count(Items.CRAFTING_TABLE) < work.budget.floor(Items.CRAFTING_TABLE)) {
                searchWork("The carried crafting-table stock is below its reserve; one new table would not leave one to place.");
            } else if (table == null && count(Items.CRAFTING_TABLE) <= work.budget.floor(Items.CRAFTING_TABLE)
                    && (!work.budget.policy.craftAllowed("crafting_table") || work.budget.craftsLeft() < 3)) {
                searchWork("No crafting table is available above its reserve; an explicit table recipe and a third shared execution are needed.");
            } else if (startStockRecipe("furnace", 1, table, progress, new HashSet<>(4))) {
                return true;
            } else if (hands.workNeed("furnace", work.budget) != null) {
                searchWork("Crafting the furnace lacks reserve-safe stone ingredients under the declared costs and visible procurement rights.");
            } else if (table != null || !inspectIronSites()) {
                searchWork("No reserve-safe crafting table and dry placement site or inventory room could support the furnace recipe.");
            }
        }
        return false;
    }

    private void advanceIronWork() {
        FurnaceWork iron = action.furnace;
        Face target = action.offer.face;
        BlockPos pos = target.hit.getBlockPos();
        BlockState state = world.getBlockState(pos);
        if (!ironFooting(iron.footing) || horizontalSquared(action.position, player.getPos()) > 0.04
                || player.getEyePos().squaredDistanceTo(target.hit.getPos()) > reach() * reach()
                || !state.isOf(Blocks.FURNACE)
                || state.get(AbstractFurnaceBlock.FACING) != target.state.get(AbstractFurnaceBlock.FACING)) {
            interrupt("The exact furnace reach or stable stationary dry footing was lost.", true);
            return;
        }
        Screen screen = client.currentScreen;
        if (action.opened == null) {
            if (screen == null) {
                if (action.fired) {
                    if (tick - action.firedAt > FURNACE_SYNC_TICKS)
                        interrupt("Vanilla did not open the witnessed furnace.", true);
                } else if (body.hasRecentView()) {
                    if (!cursorClear() || !visible(target) || state.get(AbstractFurnaceBlock.LIT))
                        interrupt("The witnessed furnace face or its cold clean entry premise changed.", true);
                    else if (useAvailable() && body.useContact(target.hit, AgentBody.Contact.INTERACT)) {
                        action.fired = true;
                        action.firedAt = tick;
                    }
                }
                return;
            }
            if (!action.fired || !(screen instanceof FurnaceScreen)) {
                interrupt("A furnace screen did not open from the authorized vanilla contact.", false);
                return;
            }
            action.opened = screen;
            iron.openedTick = tick;
        }
        var furnace = (FurnaceScreen) action.opened;
        var handler = furnace.getScreenHandler();
        if (screen != furnace || player.currentScreenHandler != handler) {
            interrupt("The exact furnace screen or its vanilla sync handler changed.", true);
            return;
        }
        var sync = (AgentFurnaceSync) handler;
        if (shown != furnace || !sync.agent$furnaceContentsSynced() || tick - iron.openedTick < 2) {
            if (tick - iron.openedTick > FURNACE_SYNC_TICKS)
                interrupt("The exact furnace screen never rendered and received its initial vanilla slot sync.", true);
            return;
        }
        ItemStack raw = handler.getSlot(0).getStack(), fuel = handler.getSlot(1).getStack();
        ItemStack output = handler.getOutputSlot().getStack();
        if (iron.phase == null) {
            if (!cursorClear() || !raw.isEmpty() || !fuel.isEmpty() || !output.isEmpty()
                    || handler.isBurning() || state.get(AbstractFurnaceBlock.LIT)) {
                interrupt("The witnessed furnace is not newly empty and cold; none of its contents were touched.", true);
                return;
            }
            rememberStation(target);
            int required = Math.max(work.budget.policy.target().count(), work.budget.floor(Items.IRON_INGOT));
            int shortfall = required - count(Items.IRON_INGOT);
            if (shortfall <= 0) {
                furnace.close();
                complete("Actual inventory already reached the iron target; the furnace was left unused.");
                return;
            }
            var batch = hands.quoteIron(work.budget, Math.min(shortfall, ironTimeLimit()));
            if (batch == null) {
                interrupt(ironSupplyShortfall(), true);
                return;
            }
            iron.rawBefore = count(Items.RAW_IRON);
            iron.fuelBefore = count(batch.fuel());
            iron.outputWitness = sync.agent$furnaceOutputUpdates();
            if (!hands.loadWorkIron(furnace, batch, work.budget)) {
                interrupt(hands.status(), true);
                return;
            }
            iron.batch = batch;
            iron.fuelRemaining = batch.fuelCount();
            action.craftJob = hands.jobGeneration();
            iron.phase = FurnacePhase.LOADING;
            ironStatus("Loading bounded raw iron and " + Registries.ITEM.getId(batch.fuel()) + " through vanilla slot clicks.");
            return;
        }
        if (action.craftJob != hands.jobGeneration()) {
            interrupt("The authorized furnace hand job was replaced.", true);
            return;
        }
        if (hands.busy()) {
            hands.tick();
            return;
        }
        var batch = iron.batch;
        if (iron.phase == FurnacePhase.RETURNING) {
            boolean restored = hands.status().equals("smelt: done") && cursorClear() && raw.isEmpty()
                && count(Items.RAW_IRON) == iron.returnedStock;
            if (restored) ironMilestone("returned", "The paid raw iron left in the cold input slot was returned to inventory.");
            interrupt(restored ? "The furnace stalled; the remaining raw iron was returned."
                : "The furnace stalled and the raw iron return did not settle.", true);
            return;
        }
        if (iron.phase == FurnacePhase.COLLECTING) {
            if (!hands.status().equals("smelt: done") || !cursorClear() || !raw.isEmpty() || !fuel.isEmpty()
                    || !output.isEmpty() || count(Items.IRON_INGOT) != iron.ingotsBefore + batch.units()) {
                interrupt("The authorized result was not observed stored as exact vanilla inventory stock.", true);
                return;
            }
            if (iron.storedTick == 0) iron.storedTick = tick;
            if (tick - iron.storedTick < 3) return;
            work.confirmedCrafts += batch.units();
            work.collectedIron = true;
            rememberStation(target);
            ironMilestone("collected", "Collected " + batch.units() + " furnace-produced iron ingot(s); actual inventory has "
                + count(Items.IRON_INGOT) + ".");
            furnace.close();
            continuityWork = AgentPauseEpisodes.Work.GUI;
            complete(work.lastEffect);
            return;
        }
        if (!cursorClear() || !raw.isEmpty() && !raw.isOf(Items.RAW_IRON)
                || !fuel.isEmpty() && !fuel.isOf(batch.fuel()) || !output.isEmpty() && !output.isOf(Items.IRON_INGOT)
                || raw.getCount() + output.getCount() != batch.units() || output.getCount() < iron.output
                || fuel.getCount() > iron.fuelRemaining) {
            interrupt("The current furnace slots no longer attest only this work's paid inputs and output.", true);
            return;
        }
        iron.fuelRemaining = fuel.getCount();
        if (iron.phase == FurnacePhase.LOADING) {
            if (!hands.status().equals("smelt: done")
                    || count(Items.RAW_IRON) != iron.rawBefore - batch.units()
                    || count(batch.fuel()) != iron.fuelBefore - batch.fuelCount()) {
                interrupt("The raw iron and exact fuel did not settle after their bounded slot clicks.", true);
                return;
            }
            iron.phase = FurnacePhase.LOADED;
            iron.advancedTick = tick;
            iron.progress = handler.getCookProgress();
            ironMilestone("loaded", "Loaded " + batch.units() + " raw iron and " + batch.fuelCount() + " "
                + Registries.ITEM.getId(batch.fuel()) + "; no ingot stock has been collected.");
            return;
        }
        float cooking = handler.getCookProgress();
        boolean advanced = handler.isBurning() && cooking > iron.progress;
        if (advanced && iron.burnTick == 0) iron.burnTick = tick;
        boolean produced = output.getCount() > iron.output && sync.agent$furnaceOutputUpdates() > iron.outputWitness;
        if (advanced || produced) {
            iron.advancedTick = tick;
            if (iron.phase == FurnacePhase.LOADED) {
                iron.phase = FurnacePhase.BURNING;
                ironMilestone("burning", "Vanilla furnace cooking advanced; waiting for the paid batch, not inventory credit.");
            }
        }
        iron.progress = cooking;
        iron.output = output.getCount();
        if (iron.phase == FurnacePhase.BURNING && output.getCount() == batch.units()
                && sync.agent$furnaceOutputUpdates() > iron.outputWitness) {
            if (!hands.collectWorkIron(furnace, batch.units(), iron.outputWitness)) {
                interrupt(hands.status(), true);
                return;
            }
            iron.phase = FurnacePhase.COLLECTING;
            action.craftJob = hands.jobGeneration();
            iron.ingotsBefore = count(Items.IRON_INGOT);
            ironMilestone("collecting", "Vanilla produced " + batch.units() + " iron ingot(s) in the owned furnace; collecting by slot clicks.");
        } else if (tick - iron.advancedTick > FURNACE_SYNC_TICKS) {
            if (!raw.isEmpty() && !handler.isBurning() && hands.returnWorkIron(furnace, raw.getCount())) {
                // This is still the same live work order and witnessed cold input, not a hazard cleanup.
                iron.returnedStock = count(Items.RAW_IRON) + raw.getCount();
                iron.phase = FurnacePhase.RETURNING;
                action.craftJob = hands.jobGeneration();
                ironStatus("The furnace stalled; returning only this work's untouched raw iron by vanilla clicks.");
            } else {
                interrupt("The furnace did not ignite or the witnessed cook progress stopped before the paid batch finished.", true);
            }
        } else if (iron.phase == FurnacePhase.BURNING) {
            continuityWork = AgentPauseEpisodes.Work.MECHANICAL_WAIT;
        }
    }

    private void ironStatus(String detail) {
        work.detail = status = detail;
        enact("smelt", detail);
    }

    private void ironMilestone(String milestone, String detail) {
        ironStatus(detail);
        if (milestone.equals("collected")) {
            work.lastEffectTick = tick;
            work.lastEffect = detail;
        }
        var value = header(run);
        value.addProperty("id", work.order.id());
        value.addProperty("life", life);
        value.addProperty("tick", tick);
        value.addProperty("milestone", milestone);
        value.addProperty("syncId", ((FurnaceScreen) action.opened).getScreenHandler().syncId);
        value.addProperty("detail", detail);
        ipc.evidence("furnace-" + work.order.id() + "-" + milestone + ".json", value.toString());
    }

    private void idle(AgentProgress progress, boolean thinking) {
        if (trial) {
            status = "holding the isolated trial view";
            state("trial_idle", status);
            return;
        }
        long idleNanos = now - idleSince;
        boolean due = blocked || idleNanos >= PLANNING_IDLE_LIMIT_NS;
        boolean cameraReady = due || idleNanos >= PLANNING_IDLE_LIMIT_NS - CAMERA_DISPATCH_LEAD_NS;
        if (blocked && tick < nextLocalProbe) {
            status = "blocked/no_safe_action";
            state(status, blockedReason);
            return;
        }
        if (due || thinking && tick >= nextLocalProbe) {
            if (!available()) {
                if (due) {
                    block("No neutral, grounded, safe first-person view for local work.");
                    return;
                }
            } else if (tick >= nextLocalProbe || due && !blocked) {
                nextLocalProbe = tick + OBSERVATION_INTERVAL;
                LocalWork work = localOffer(progress, cameraReady);
                if (work == null) {
                    if (due) {
                        block(localHoldReason == null ? "No compatible new camera view or safe adjacent step." : localHoldReason);
                        return;
                    }
                } else {
                    Offer next = work.offer;
                    if (next.floor != null) localSteps.add(next.floor.pos);
                    claim("local_motion");
                    ++fallbackTicks;
                    action = new Action(null, next, client, tick, now, body.renderedFrame(), 0, work.anchors, work.walkPitch);
                    state("local_in_progress", next.summary);
                    step(progress);
                    return;
                }
            }
        }
        if (due) {
            block("No new lit resource view or safe adjacent step toward a witnessed feature.");
        } else {
            status = "waiting for a current local plan";
            state(thinking ? "planning_wait" : "awaiting_plan", thinking
                ? "A trusted planning episode is pending." : "No provider decision is pending.");
        }
    }

    private record LocalWork(Offer offer, Offer[] anchors, float walkPitch) {
        LocalWork(Offer offer, Offer[] anchors) { this(offer, anchors, Float.NaN); }
    }

    private LocalWork localOffer(AgentProgress progress, boolean allowCamera) {
        localHoldReason = null;
        Offer inspect = null, survey = null, step = null;
        Vec3d from = client.player.getPos();
        var current = offers(progress);
        // A pinned route needs the same settled source and current view until
        // Terra chooses it. An unrelated local walk would discard that work.
        if (routeOffer != null && offeredOnPlanningBasis(routeOffer)
                || drySurveyOffer != null && offeredOnPlanningBasis(drySurveyOffer)) {
            localHoldReason = "A witnessed dry lane is awaiting Terra; no new local action can preserve its source and view.";
            return null;
        }
        Offer[] anchors = visibleAnchors(current);
        if (anchors.length != 0) {
            LocalWork advance = usefulMaterialApproach(current, anchors, progress);
            if (advance != null) return advance;
            if (allowCamera) {
                for (Offer offer : anchors) {
                    Offer perspective = prepareTerrainView(offer, anchors);
                    if (perspective != null) return new LocalWork(perspective, anchors);
                }
                for (Offer offer : anchors) {
                    Offer preparation = prepareView(offer, anchors);
                    if (preparation != null) return new LocalWork(preparation, anchors);
                }
            }
            localHoldReason = "A useful material face is still visible; no new local action can preserve the view.";
            return null;
        }
        BlockHitResult feature = body.find(AgentMacroControl::resource, INSPECT_REACH).orElse(null);
        double improvement = 0.5;
        if (localSteps.size() < 32) localSteps.add(client.player.getBlockPos().down());
        for (Offer offer : current) {
            switch (offer.key.verb) {
                case APPROACH -> {
                    if (feature == null || feature.getPos().squaredDistanceTo(client.player.getEyePos()) <= reach() * reach()
                            || localSteps.size() >= 32 || localSteps.contains(offer.floor.pos)) continue;
                    double benefit = horizontalSquared(from, feature.getPos()) -
                        horizontalSquared(offer.floor.landing, feature.getPos());
                    if (benefit > improvement && validate(offer, progress) == null) {
                        improvement = benefit;
                        step = offer;
                    }
                }
                case INSPECT -> { if (allowCamera && inspect == null && validate(offer, progress) == null) inspect = offer; }
                case SURVEY -> { if (allowCamera && survey == null && validate(offer, progress) == null) survey = offer; }
                default -> { } // Never select an attack, workstation, crafting, or pickup on local authority.
            }
        }
        Offer next = step != null ? step : inspect != null ? inspect : survey;
        return next == null ? null : new LocalWork(next, NO_ANCHORS);
    }

    private boolean offeredOnPlanningBasis(Offer candidate) {
        Planning planning = input.planning;
        if (!rawPending || planning == null || planning.epoch != epoch) return false;
        Snapshot basis = snapshots.get(planning.basis);
        return basis != null && basis.offers.get(candidate.id) == candidate;
    }

    private Offer[] visibleAnchors(List<Offer> current) {
        List<Offer> preferred = reservation();
        if (!preferred.isEmpty()) {
            Offer[] live = current.stream().filter(offer -> materialFace(offer) && preferred.contains(offer)).toArray(Offer[]::new);
            if (live.length != 0) return live;
        }
        return current.stream().filter(AgentMacroControl::materialFace).toArray(Offer[]::new);
    }

    private LocalWork usefulMaterialApproach(List<Offer> current, Offer[] anchors, AgentProgress progress) {
        if (localSteps.size() >= 32) return null;
        Vec3d from = player.getPos();
        localSteps.add(player.getBlockPos().down());
        LocalWork best = null;
        double improvement = 0.36;
        for (Offer target : anchors) {
            if (target.key.verb != Verb.BREAK) continue;
            Vec3d dropColumn = Vec3d.ofCenter(target.key.pos);
            double startingDistance = horizontalSquared(from, dropColumn);
            if (startingDistance <= PICKUP_STANCE_SQUARED) continue;
            for (Offer option : current) {
                if (option.key.verb != Verb.APPROACH || localSteps.contains(option.floor.pos)) continue;
                Vec3d landing = option.floor.landing;
                double gain = startingDistance - horizontalSquared(landing, dropColumn);
                if (gain <= improvement) continue;
                float yaw = heading(landing.x - from.x, landing.z - from.z);
                float pitch = compatibleWalkPitch(anchors, from, landing, yaw);
                if (Float.isNaN(pitch) || validate(option, progress) != null) continue;
                Offer approach = new Offer(option.id, option.key, "Approach a verified stance for resource retrieval",
                    "This witnessed dry step reduces the distance to the retained harvest face.",
                    0, 0, option.floor, null, null, null, null);
                best = new LocalWork(approach, anchors, pitch);
                improvement = gain;
            }
        }
        return best;
    }

    private float compatibleWalkPitch(Offer[] anchors, Vec3d from, Vec3d landing, float yaw) {
        float current = MathHelper.clamp(player.getPitch(), 12, 42);
        for (int offset : WALK_PITCH_OFFSETS) {
            float pitch = current + offset;
            if (pitch < 8 || pitch > 42) continue;
            if (retainsAnchors(anchors, from, yaw, pitch) && retainsAnchors(anchors, landing, yaw, pitch)) return pitch;
        }
        return Float.NaN;
    }

    private Offer prepareTerrainView(Offer material, Offer[] anchors) {
        if (material.key.verb != Verb.BREAK || localSteps.size() >= 32
                || horizontalSquared(player.getPos(), Vec3d.ofCenter(material.key.pos)) <= PICKUP_STANCE_SQUARED) return null;
        Face face = material.face;
        Key key = faceKey(Verb.SURVEY, face, "collection_footing");
        if (retiredViews.contains(key)) return null;
        float yaw = player.getYaw();
        float pitch = Math.min(42, player.getPitch() + 28);
        for (; pitch - player.getPitch() >= 9; pitch -= 3) {
            if (retainsAnchors(anchors, player.getPos(), yaw, pitch) && revealsFootingToward(material, yaw, pitch)) {
                return new Offer(material.id, key, "Survey footing below the witnessed resource",
                    "Expose nearer footing for a possible retrieval route while preserving the resource face.",
                    yaw, pitch, null, face, null, null, null);
            }
        }
        return null;
    }

    private boolean revealsFootingToward(Offer material, float yaw, float pitch) {
        Vec3d feet = player.getPos();
        Vec3d source = Vec3d.ofCenter(material.key.pos);
        double distance = horizontalSquared(feet, source);
        BlockPos standing = player.getBlockPos();
        for (Direction direction : CARDINAL) {
            BlockPos adjacent = standing.offset(direction);
            if (localSteps.contains(adjacent.down())) continue;
            Vec3d landing = Vec3d.ofBottomCenter(adjacent);
            if (distance - horizontalSquared(landing, source) <= 0.36) continue;
            // This is the bearing of a candidate floor patch, not a world query.
            // A subsequent real rendered ray still has to admit the floor.
            Vec3d patch = landing.add(0.32 * direction.getOffsetX(), 0, 0.32 * direction.getOffsetZ());
            if (!body.macroRetainsView(patch, feet, yaw, player.getPitch())
                    && body.macroRetainsView(patch, feet, yaw, pitch)) return true;
        }
        return false;
    }

    private boolean retainsAnchors(Offer[] anchors, Vec3d feet, float yaw, float pitch) {
        Vec3d from = player.getEyePos().add(feet.subtract(player.getPos()));
        double max = reach();
        for (Offer anchor : anchors) {
            if (!body.macroRetainsView(anchor.face.hit.getPos(), feet, yaw, pitch)) return false;
            if (from.squaredDistanceTo(anchor.face.hit.getPos()) > max * max) return false;
        }
        return true;
    }

    private Offer prepareView(Offer material, Offer[] anchors) {
        Face face = material.face;
        Key key = faceKey(Verb.INSPECT, face, "contact");
        if (retiredViews.contains(key) || body.renderedAim(face.hit.getPos(), 8)) return null;
        Vec3d eye = player.getEyePos();
        Vec3d bearing = face.hit.getPos().subtract(eye);
        float yaw = heading(bearing.x, bearing.z);
        float pitch = (float) Math.toDegrees(Math.atan2(-bearing.y, Math.hypot(bearing.x, bearing.z)));
        if (!retainsAnchors(anchors, player.getPos(), yaw, pitch)) return null;
        return new Offer(material.id, key, "Center the actionable " + blockName(face),
            "Prepare the same witnessed face without touching it.", 0, 0, null, face, null, null, null);
    }

    private List<Offer> reservation() {
        return epoch == reservationEpoch && now <= reservationUntil ? reservedOffers : List.of();
    }

    private static boolean materialFace(Offer offer) {
        return offer.face != null && (offer.key.verb == Verb.BREAK
            || offer.key.verb == Verb.INTERACT || offer.key.verb == Verb.CONTINUE);
    }

    private boolean liveMaterialFace(Offer offer, AgentProgress progress) {
        return materialFace(offer) && validate(offer, progress) == null;
    }

    private void block(String detail) {
        blockedReason = detail;
        nextLocalProbe = tick + OBSERVATION_INTERVAL;
        if (!blocked) {
            blocked = true;
            ++blockedCount;
            remember("blocked/no_safe_action: " + detail);
        }
        status = "blocked/no_safe_action";
        state(status, detail);
    }

    private String validate(Offer offer, AgentProgress progress) {
        var player = client.player;
        return switch (offer.key.verb) {
            case SURVEY -> repeatedSourceView() || retiredViews.contains(offer.key) || offer.key.entity != surveyOrigin || anchor == null
                || horizontalSquared(anchor, player.getPos()) > 0.64
                || angle(player.getYaw(), player.getPitch(), offer.yaw, offer.pitch) < 5
                ? "The bounded survey is already done or its origin changed." : null;
            case STATION_REACQUIRE -> {
                var clue = personalStation(offer.face.state.getBlock());
                yield !stationRecallReady(clue) || clue.sequence != offer.key.entity
                    || visibleStation(offer.face.state.getBlock()) != null
                    ? "The recent workstation clue is used, already visible, or no longer local." : null;
            }
            case DRY_SURVEY -> progress.drySurveyCurrent(offer.drySurvey)
                ? null : "The exact visible lower face or its standing source changed.";
            case INSPECT -> retiredViews.contains(offer.key) || !visible(offer.face, INSPECT_REACH)
                || player.getRotationVec(1).dotProduct(offer.face.hit.getPos().subtract(player.getEyePos()).normalize()) > 0.996
                ? "The feature is already centered, inspected, or no longer visible." : null;
            case APPROACH -> repeatedSourceFooting(offer.floor.pos) || offer.farther != null && repeatedSourceFooting(offer.farther.pos)
                ? "That footing was already checked without finding a new source."
                : !floorCurrent(offer.floor) ? "The adjacent footing is no longer visible and clear." :
                !body.macroNoVisiblePickup(offer.floor.landing) ? "A visible pickup overlaps the walking lane, or the view cannot check it." : null;
            case COLLECT -> dropVisible(offer) && floorCurrent(offer.floor)
                && dropNearLanding(offer.drop, offer.floor) && roomFor(offer.drop.getStack())
                ? null : "The drop, adjacent footing, or inventory room changed.";
            case BREAK -> (SURFACE_CAP.equals(offer.key.activity) ? directCapCurrent(offer.face, progress)
                : visibleFace(offer.face) && canBreak(offer.face, progress))
                ? null : "The resource, harvest tool, or safe reach changed.";
            case INTERACT -> visibleFace(offer.face) && useAvailable() ? null : "The workstation or use control changed.";
            case CONTINUE -> ingredients(offer.recipe) && (offer.face == null
                ? !client.options.inventoryKey.isUnbound() : visibleFace(offer.face) && useAvailable())
                ? null : "The recipe ingredients, storage, or workstation changed.";
            case FOLLOW -> routeCurrent(offer, progress) ? null : "The exact witnessed dry segment or its source changed.";
            case WATER_CLUE -> "The source-water clue grants no primitive action.";
            case WORK_WALK, WORK_EQUIP, WORK_PLACE, WORK_TREAD, WORK_SMELT, WORK_FILL -> "This operation requires a native work order.";
        };
    }

    private void step(AgentProgress progress) {
        Offer offer = action.offer;
        status = offer.summary;
        if (client.currentScreen != null && offer.key.verb != Verb.INTERACT && offer.key.verb != Verb.CONTINUE) {
            interrupt("A different screen replaced the camera view.", false);
            return;
        }
        if (action.keepVisible.length != 0) {
            if (!body.hasRecentView()) return;
            for (Offer anchor : action.keepVisible) if (!liveMaterialFace(anchor, progress)) {
                interrupt("A reserved material face no longer has a fresh legal camera witness.", true);
                return;
            }
        }
        switch (offer.key.verb) {
            case DRY_SURVEY -> surveyDryRoute(offer, progress);
            case STATION_REACQUIRE -> advanceStationRecall();
            case SURVEY -> {
                var player = client.player;
                if (horizontalSquared(action.position, player.getPos()) > 0.12) {
                    interrupt("The survey lost its stationary stance.", true);
                } else if (!body.hasRecentView()) {
                    // A missed frame is not motion or a negative witness. Hold until the
                    // next rendered view or the survey's existing bounded deadline.
                    return;
                } else if (body.renderedFrame() > action.startingFrame
                        && body.renderedDirection(action.camera.yaw, action.camera.pitch, 4)
                        && angle(action.yaw, action.pitch, player.getYaw(), player.getPitch()) >= 5) {
                    complete("The first-person camera rendered the requested survey angle.");
                } else body.turnScan(action.camera.yaw, action.camera.pitch);
            }
            case INSPECT -> {
                if (!body.hasRecentView()) return;
                boolean witnessed = "contact".equals(offer.key.activity) ? visibleFace(offer.face) : visible(offer.face, INSPECT_REACH);
                if (horizontalSquared(action.position, client.player.getPos()) > 0.0144 || !witnessed)
                    interrupt("The inspected face left the stationary lit camera view.", true);
                else if (body.renderedFrame() > action.startingFrame
                        && body.renderedDirection(action.camera.yaw, action.camera.pitch, 4)
                        && body.renderedAim(offer.face.hit.getPos(), 4)
                        && angle(action.yaw, action.pitch, client.player.getYaw(), client.player.getPitch()) >= 4)
                    complete("The first-person camera centered the witnessed face.");
                else body.turnFine(action.camera.yaw, action.camera.pitch);
            }
            case APPROACH, COLLECT -> walk(offer);
            case BREAK -> breakWitnessedFace(offer.face, progress);
            case INTERACT, CONTINUE -> useOrCraft(offer);
            case FOLLOW -> followRoute(offer, progress);
            case WATER_CLUE, WORK_WALK, WORK_EQUIP, WORK_PLACE, WORK_TREAD, WORK_SMELT, WORK_FILL ->
                throw new IllegalStateException("Expected work step dispatch");
        }
    }

    private void surveyDryRoute(Offer offer, AgentProgress progress) {
        switch (progress.surveyDryRoute(offer.drySurvey)) {
            case RUNNING -> { }
            case PAIRED -> complete("A stationary rendered survey witnessed both directions of the dry edge. No movement was authorized.");
            case UNPROVED -> complete("Stationary survey finished without proving a route: " + progress.drySurveyResult(offer.drySurvey) + ".");
            case REFUSED -> interrupt("The exact survey source or rendered view was lost before it could be checked.", true);
        }
    }

    private boolean routeCurrent(Offer offer, AgentProgress progress) {
        return offer.route != null && player.getBlockPos().equals(offer.route.from())
            && progress.dryRouteOffer() == offer.route;
    }

    private void followRoute(Offer offer, AgentProgress progress) {
        String pickup = unexpectedPickup();
        if (pickup != null) {
            interrupt(pickup, true);
            return;
        }
        Vec3d destination = Vec3d.ofBottomCenter(offer.route.endpoint());
        double remaining = horizontalSquared(player.getPos(), destination);
        if (action.drove && remaining + 0.008 < action.distanceLeft) {
            continuityWork = AgentPauseEpisodes.Work.ROUTE;
            action.distanceLeft = remaining;
        }
        if (action.settledAt == 0) {
            switch (progress.followDryRoute(offer.route)) {
                case RUNNING -> {
                    status = progress.dryRouteReason();
                    return;
                }
                case REFUSED -> {
                    interrupt("Dry route refused: " + progress.dryRouteReason() + ".", true);
                    return;
                }
                case ARRIVED -> action.settledAt = tick;
            }
        }
        // The route motor has stopped. Wait for actual neutral settlement and
        // late inventory observations without asking it to start another edge.
        if (!player.getBlockPos().equals(offer.route.endpoint()) || !grounded()
                || Math.abs(player.getX() - destination.x) > 0.22 || Math.abs(player.getZ() - destination.z) > 0.22
                || Math.abs(player.getY() - destination.y) > 0.055) {
            interrupt("The player did not remain on the authorized dry endpoint.", true);
        } else if (settled() && tick - action.settledAt >= APPROACH_SETTLE_TICKS) {
            if (action.diamondRoute) {
                var edge = new AgentSurfaceTread.Edge(offer.route.from(), diamondRoute.support,
                    offer.route.endpoint(), world.getBlockState(offer.route.endpoint().down()), diamondRoute.bearing);
                recordDiamondTread(edge, true);
                work.sourceSearch.freshAfter = body.renderedFrame();
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
            }
            complete("Settled at the authorized dry endpoint after " + dryRouteDescription(offer.route) + ".");
        }
    }

    private void recordDiamondTread(AgentSurfaceTread.Edge edge, boolean natural) {
        if (diamondRoute.placedSupports.contains(edge.lower().down())) ++diamondRoute.supportedLandings;
        if (edge.upper().getY() == edge.lower().getY()) ++diamondRoute.levelLegs;
        else if (edge.upper().getY() < edge.lower().getY()) ++diamondRoute.rises;
        else if (natural) ++diamondRoute.shelves;
        else ++diamondRoute.treads;
        diamondRoute.lowest = Math.min(diamondRoute.lowest, edge.lower().getY());
        diamondRoute.advance(edge);
    }

    private String diamondProgress() {
        return "Y=" + player.getBlockY() + " (lowest witnessed Y="
            + (diamondRoute.foot == null ? player.getBlockY() : diamondRoute.lowest) + ", "
            + diamondRoute.shelves + " lower cave shelves, " + diamondRoute.treads + " returnable treads, "
            + diamondRoute.levelLegs + " distinct level footholds, " + diamondRoute.rises + " upper shelf repositions, "
            + diamondRoute.spine.size() + " retained return edges)";
    }

    private void breakWitnessedFace(Face face, AgentProgress progress) {
        BlockPos target = face.hit.getBlockPos();
        boolean mayBreak = action.broken;
        if (!mayBreak) {
            if (action.durable) {
                ItemStack hand = player.getMainHandStack();
                int loss = AgentMiningStock.maxLoss(hand, face.state, world, target);
                if (action.prospectCover) {
                    BlockPos foot = player.getBlockPos();
                    mayBreak = work.budget.canCutCover() && work.budget.policy.prospectCoverAllowed(face.state)
                        && surfaceBodyAllowsExtension()
                        && (action.diamondRoute ? diamondCutGeometry(foot, target)
                                && (loss == 0 || diamondToolAvailable(player.getInventory().selectedSlot, true))
                            : prospectCutGeometry(foot, face.hit, work.sourceSearch))
                        && dryWorkBreakSafe(target, face.state, action.tracked, progress);
                } else {
                    mayBreak = work.budget.canBreak() && work.budget.policy.breakAllowed(face.state)
                        && workResourceSafe(face.hit, face.state, progress);
                }
                mayBreak = mayBreak && !client.options.attackKey.isUnbound()
                    && (!face.state.isToolRequired() || hand.isSuitableFor(face.state)) && loss >= 0 && workLootCompatible(hand, face.state)
                    && (loss == 0 || work.budget.limit(hand.getItem(), count(hand.getItem())) >= loss);
                action.handLoss = loss;
            } else {
                mayBreak = action.prospectCover ? directCapCurrent(face, progress) : canBreak(face, progress);
            }
        }
        if (action.broken) {
            continuityWork = AgentPauseEpisodes.Work.NOVELTY;
            if (action.durable && !action.prospectCover) {
                if (deepWork() || !work.sourceSearch.stairs.isEmpty()) work.sourceSearch.freshAfter = body.renderedFrame();
                if (timberBlock(face.state) && target.getY() >= player.getBlockY()) {
                    timberSights.remove(target);
                    timberHarvest = new TimberHarvest(target, face.state, player.getPos(), action.tracked, count(action.tracked), tick);
                    work.timberLookUsed = false;
                } else {
                    work.lastHarvest = target;
                    work.lastHarvestItem = action.tracked;
                    work.lastHarvestTick = tick;
                    work.lowerHarvest = target.getY() < player.getBlockY();
                }
            }
            complete("Vanilla reported this player's break of the witnessed " + blockName(face)
                + (action.prospectCover ? " cover. No source or pickup is confirmed by this cut." : "."));
        } else if (!mayBreak
                || !ItemStack.areItemsAndComponentsEqual(action.harvestTool, client.player.getMainHandStack())) {
            interrupt("The selected harvest tool or protected footing changed.", true);
        } else if (!body.hasRecentView()) {
            // Only an already held crack may bridge a brief render gap. The Body
            // still rechecks the actual exact crosshair, contact region and state.
            if (action.fired) body.continueMine(target);
        } else {
            BlockHitResult live = body.macroMineWitness(face.hit, reach());
            if (live == null) {
                if (action.durable && !action.fired && (action.prospectCover || target.getY() < player.getBlockY())
                        && tick - action.started <= 20 && !body.renderedAim(face.hit.getPos(), 5)) {
                    // A visible contact can guide aim but does not press attack.
                    // The usual exact lit face and vanilla crosshair still apply.
                    body.aim(face.hit.getPos());
                    return;
                }
                long frame = body.renderedFrame();
                if (frame != action.lastMissingFrame) {
                    action.lastMissingFrame = frame;
                    if (++action.missingFaceFrames >= 3)
                        interrupt("The admitted resource face is no longer lit, reachable, and visible.", true);
                }
            } else if (client.world.getBlockState(target) != face.state) {
                interrupt("The visible resource changed without an observed own break.", true);
            } else {
                action.missingFaceFrames = 0;
                body.mine(live);
            }
        }
    }

    private void walk(Offer offer) {
        var player = client.player;
        Floor floor = action.secondHop ? offer.farther : offer.floor;
        boolean collect = offer.drop != null;
        String pickup = unexpectedPickup();
        if (pickup != null) {
            interrupt(pickup, true);
            return;
        }
        if (collect && offer.drop.isRemoved()) {
            if (action.pickupDisappeared == 0) action.pickupDisappeared = tick;
            if (count(offer.item) > action.itemCount) {
                if (settled()) {
                    continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                    complete("The witnessed drop disappeared and the matching inventory count increased.");
                }
            } else if (tick - action.pickupDisappeared > 6) {
                interrupt("The drop disappeared without a matching inventory gain.", true);
            }
            return;
        }
        if (!body.hasRecentView()) return; // Do not issue another movement tick from a missing frame.
        if (!collect && tick != action.started && !body.macroNoVisiblePickup(floor.landing)) {
            interrupt("A visible pickup overlaps the walking lane, or the view cannot check it.", true);
            return;
        }
        if (!body.macroFlatLane(floor.pos, floor.state, floor.landing) || (collect && (!dropVisible(offer)
                || !dropNearLanding(offer.drop, floor)))) {
            interrupt("The witnessed drop or flat walking lane is no longer safe.", true);
            return;
        }
        Vec3d position = player.getPos();
        double remaining = horizontalSquared(position, floor.landing);
        if (action.drove && remaining + 0.008 < action.distanceLeft) {
            continuityWork = AgentPauseEpisodes.Work.ROUTE;
            action.distanceLeft = remaining;
        }
        if (remaining <= 0.1225 && action.drove && horizontalSquared(action.walkFrom, position) >= 0.16
                && player.getBlockPos().equals(floor.pos.up())) {
            if (!collect) {
                if (!settled()) action.settledAt = 0;
                else if (action.settledAt == 0) action.settledAt = tick;
                else if (tick - action.settledAt >= APPROACH_SETTLE_TICKS) {
                    if (!action.secondHop && offer.farther != null) {
                        if (!floorCurrent(offer.farther) || !body.macroNoVisiblePickup(offer.farther.landing)) {
                            interrupt("Stopped on the first verified tile; the farther lane did not revalidate.", true);
                            return;
                        }
                        surfaceSearch.footholds.add(floor.pos);
                        action.secondHop = true;
                        action.walkFrom = position;
                        action.distanceLeft = horizontalSquared(position, offer.farther.landing);
                        action.drove = false;
                        action.settledAt = 0;
                    } else complete(offer.farther == null ? "Reached the adjacent witnessed tile and stopped after actual displacement."
                        : "Reached the distinct witnessed foothold after two separately revalidated dry hops.");
                }
            }
            return;
        }
        action.settledAt = 0;
        float yaw = action.keepVisible.length == 0 && !action.durable ? heading(floor.landing.x - position.x, floor.landing.z - position.z)
            : action.pathYaw;
        float pitch = action.pathPitch;
        body.macroFlatWalk(floor.landing, yaw, pitch);
    }

    private void useOrCraft(Offer offer) {
        if (action.craftJob != 0) {
            if (hands.jobGeneration() != action.craftJob) {
                interrupt("The trusted hand job was replaced.", false);
                return;
            }
            if (action.opened == null && client.currentScreen instanceof InventoryScreen && shown == client.currentScreen) {
                action.opened = shown;
                continuityWork = AgentPauseEpisodes.Work.GUI;
            }
            if (hands.busy()) {
                hands.tick();
                return;
            }
            var result = hands.lastCraftReceipt();
            boolean personal = action.durable && hands.holdsWorkInventory();
            if (result != null && result.sequence() > action.priorCraftReceipt
                    && result.recipe().equals(offer.recipe.id) && result.items() > 0
                    && (client.currentScreen == null || personal)) {
                if (personal) {
                    if (shown == client.currentScreen && hands.workInventoryReady())
                        personalCraft = new PersonalCraft(work.order, tick + PERSONAL_HANDOFF_TICKS,
                            now + PERSONAL_HANDOFF_NS, action.tableInReach);
                    else releasePersonalCraft(true);
                }
                if (action.durable) work.confirmedCrafts += result.executions();
                if (offer.face != null) rememberStation(offer.face);
                continuityWork = AgentPauseEpisodes.Work.GUI;
                complete("Vanilla crafting confirmed " + result.items() + " output from " + offer.recipe.id + ".");
            } else interrupt("The hand job ended without a matching vanilla crafting receipt.", true);
            return;
        }
        if (offer.face == null) {
            startCraft(offer);
            return;
        }
        if (client.currentScreen != null) {
            Screen screen = client.currentScreen;
            if (!action.fired || !expectedScreen(offer.face, screen) || !cursorClear()) {
                interrupt("The expected clean workstation screen did not open.", false);
            } else if (shown == screen) {
                action.opened = screen;
                rememberStation(offer.face);
                continuityWork = AgentPauseEpisodes.Work.GUI;
                if (offer.recipe == null) {
                    screen.close();
                    complete("The witnessed " + blockName(offer.face) + " opened its rendered vanilla screen.");
                } else startCraft(offer);
            }
            return;
        }
        if (action.fired) {
            if (tick - action.firedAt > 12) interrupt("Vanilla did not open the expected workstation.", true);
            return;
        }
        if (!visible(offer.face) || !useAvailable()) {
            interrupt("The workstation face or use control is no longer available.", true);
            return;
        }
        if (body.useContact(offer.face.hit, AgentBody.Contact.INTERACT)) {
            action.fired = true;
            action.firedAt = tick;
        }
    }

    private void startCraft(Offer offer) {
        if (!cursorClear() || !(action.durable
                ? hands.craftWork(offer.recipe.id, action.executions, work.budget)
                : ingredients(offer.recipe) && hands.craft(offer.recipe.id))) {
            interrupt("The current ingredients, storage, or clean crafting screen did not admit the recipe.", true);
            return;
        }
        var prior = hands.lastCraftReceipt();
        action.priorCraftReceipt = prior == null ? 0 : prior.sequence();
        action.craftJob = hands.jobGeneration();
    }

    private static boolean expectedScreen(Face face, Screen screen) {
        return face.state.isOf(Blocks.CRAFTING_TABLE) && screen instanceof CraftingScreen
            || face.state.isOf(Blocks.FURNACE) && screen instanceof FurnaceScreen;
    }

    void ownBreak(BlockPos pos, BlockState state) {
        forgetStationAt(personalTable, pos);
        forgetStationAt(personalFurnace, pos);
        if (stationPlacement != null && stationPlacement.pos.equals(pos)) stationPlacement = null;
        if (action != null && action.offer.key.verb == Verb.BREAK && action.fired
                && action.offer.face.hit.getBlockPos().equals(pos) && action.offer.face.state == state && !action.broken) {
            action.broken = true;
            if (action.durable) {
                ++work.confirmedBreaks;
                work.budget.broken(action.harvestTool.getItem(), action.handLoss);
            }
            if (action.prospectCover && action.diamondRoute) {
                work.sourceSearch.freshAfter = body.renderedFrame();
                diamondRoute.aimCell = null;
                if (work.lowerHarvest && work.lastHarvestItem == Items.DIAMOND) work.lastHarvestTick = tick;
            } else if (action.prospectCover) {
                var search = surfaceSearch;
                if (action.durable && work.lowerHarvest && work.lastHarvest != null
                        && pos.equals(work.lastHarvest.up(2))
                        && AgentSurfaceTread.returnLip(player.getBlockPos(), pos, search.cutBearing, action.offer.face.hit.getSide())) {
                    // A proved clear lip may be needed to reach a witnessed drop.
                    // Keep the original harvest location; acquisition still needs
                    // a newly visible item and a revalidated landing.
                    work.lastHarvestTick = tick;
                }
                if (search.firstCover == null) {
                    search.cutFrom = player.getBlockPos();
                    search.cutBearing = prospectBearing(search.cutFrom, pos, action.offer.face.hit.getSide());
                    search.firstCover = pos.toImmutable();
                    search.cutSupport = world.getBlockState(search.cutFrom.down());
                }
                search.lastCover = pos.toImmutable();
                search.freshAfter = body.renderedFrame();
            }
        }
    }

    private float advancingCrack() {
        if (action == null || !(action.durable || "terra".equals(owner) && action.intent != null)
                || action.offer.key.verb != Verb.BREAK
                || !action.fired || action.broken || !client.options.attackKey.isPressed()
                || !client.interactionManager.isBreakingBlock() || !hazardClear || urgent) return 0;
        if (!(client.interactionManager instanceof AgentMiningAccess mining)
                || !action.offer.key.pos.equals(mining.agent$breakingPos())) return 0;
        float crack = mining.agent$breakingProgress();
        float before = action.lastCrack;
        action.lastCrack = crack;
        return crack > before && crack < 1 ? crack : 0;
    }

    void end(AgentProgress progress, String safety) {
        if (input == null) return;
        if (owner.equals("safety") && urgent) {
            boolean applied = !body.keysNeutral();
            if (applied && !urgentInput) purposeful("safety: " + lastUrgency);
            urgentInput = applied;
        } else {
            urgent = urgentInput = false;
        }
        if (!input.active) {
            rawWorking = false;
            if (activated && !revocationSeen) {
                revocationSeen = true;
                quiescent = false;
                ++epoch;
                ++safetyRevision;
                publish(null);
            }
            interrupt(safety, true);
            retireWork("needs_replan", "interrupted", "The host revoked macro authority.");
            if (activated && ipc.markerRevoked && !revocationAcknowledged && visited && owned && available()) {
                JsonObject revoked = header(run);
                revoked.addProperty("life", life);
                revoked.addProperty("epoch", epoch);
                revoked.addProperty("tick", tick);
                revocationAcknowledged = ipc.evidence("revoked.json", revoked.toString());
            }
            if (!activated || revocationAcknowledged) close("authority_revoked");
            return;
        }
        if (!visited) {
            String reason = urgent ? "Immediate safety took control: " + lastUrgency : safety;
            interrupt(reason, true);
            refuseUnseen(reason);
            if (urgent) retireWork("needs_replan", "interrupted", reason);
        }
        if (action != null && (action.offer.key.verb == Verb.APPROACH || action.offer.key.verb == Verb.COLLECT
                || action.offer.key.verb == Verb.FOLLOW || action.offer.key.verb == Verb.WORK_WALK))
            action.drove = client.options.forwardKey.isPressed()
                || action.drove && (!action.durable || action.offer.key.verb == Verb.APPROACH);
        if (action != null && action.offer.key.verb == Verb.BREAK && (action.durable || owner.equals("terra")))
            action.fired |= client.options.attackKey.isPressed();
        float crack = advancingCrack();
        if (crack > 0) continuityWork = AgentPauseEpisodes.Work.CRACK;
        long handsEvidence = hands.workEvidence();
        if (continuityWork == null && (action != null && action.craftJob != 0 || owner.equals("safety"))
                && handsEvidence != lastHandsEvidence) continuityWork = AgentPauseEpisodes.Work.GUI;
        lastHandsEvidence = handsEvidence;
        rawWorking = continuityWork != null;
        if (rawWorking && continuityWork != AgentPauseEpisodes.Work.MECHANICAL_WAIT
                && action != null && action.durable && tick - lastPurposefulTick >= 10)
            purposeful("work " + action.offer.key.verb.id + ": " + continuityWork.name());
        boolean due = tick - lastObservation >= OBSERVATION_INTERVAL || lastObservation == 0
            || personalCraft != null && work.completedTick == tick;
        updateScope(due);
        // Ordinary local work may continue on the very next tick. Only an observed
        // promotion barrier (or an isolated trial) advertises a held neutral window.
        quiescent = (trial || handoffCurrent(input.handoff)) && visited && owned && available();
        if (due) publish(progress, crack);
    }

    /** Death/transport shutdown leaves vanilla in charge of the old screen and cursor. */
    void suspend(long tick, String reason) {
        if (suspended) return;
        suspended = true;
        this.tick = tick;
        personalTable = personalFurnace = null;
        stationPlacement = null;
        sampleClock();
        rawPending = false;
        state("inactive", reason);
        quiescent = hazardClear = owned = false;
        owner = "safety";
        interrupt(reason, false);
        retireWork("needs_replan", "interrupted", reason);
        if (client != null && player != null && client.player == player && client.world == world
                && life != 0 && ipc.inbox.active) {
            ++epoch;
            ++safetyRevision;
            snapshots.clear();
            publish(null);
        }
    }

    void closeFurnaceForStop() {
        if (action == null || action.furnace == null || client.player != player || client.world != world) return;
        closeOwnedWorkScreen(hands.holdsWorkInventory());
    }

    void close(String reason) {
        if (ipc.worker.isShutdown()) return;
        if (!trial && life != 0) {
            sampleClock();
            JsonObject finalStats = header(run);
            finalStats.addProperty("life", life);
            finalStats.addProperty("epoch", epoch);
            finalStats.addProperty("tick", tick);
            finalStats.addProperty("reason", reason);
            addPlanningTelemetry(finalStats);
            ipc.evidence("native-planning-final.json", finalStats.toString());
        }
        ipc.close();
    }
    void drain() { ipc.drain(); }

    boolean grounded() {
        return client != null && client.player != null && client.player.isOnGround()
            && !client.player.isTouchingWater() && !client.player.hasVehicle()
            && client.interactionManager != null && client.interactionManager.getCurrentGameMode() == GameMode.SURVIVAL;
    }

    boolean cursorClear() {
        return client != null && client.player != null && client.player.currentScreenHandler != null
            && client.player.currentScreenHandler.getCursorStack().isEmpty();
    }

    boolean neutral() {
        return body != null && body.keysNeutral() && !hands.busy() && !hands.holdsWorkInventory() && action == null;
    }
    boolean hazardClear() { return hazardClear; }

    private boolean available() {
        return observable() && neutral() && settled() && !client.player.isUsingItem() && !client.player.isSprinting()
            && !client.player.isSneaking() && !client.interactionManager.isBreakingBlock();
    }

    private boolean observable() {
        return action == null && observableWorld();
    }

    private boolean observableWorld() {
        return visited && grounded() && hazardClear && cursorClear() && client.currentScreen == null
            && client.getOverlay() == null && client.isWindowFocused() && body.hasRecentView();
    }

    private boolean settled() {
        return client.player.getVelocity().horizontalLengthSquared() <= SETTLED_SPEED_SQUARED;
    }

    private boolean floorCurrent(Floor floor) {
        return floor != null && cardinallyAdjacent(client.player.getBlockPos().down(), floor.pos)
            && body.macroFloor(floor.pos) != null && body.macroFlatLane(floor.pos, floor.state, floor.landing);
    }

    private static boolean cardinallyAdjacent(BlockPos from, BlockPos to) {
        return from.getY() == to.getY() && Math.abs(from.getX() - to.getX()) + Math.abs(from.getZ() - to.getZ()) == 1;
    }

    private boolean dropVisible(Offer offer) {
        return offer.drop != null && !offer.drop.isRemoved() && body.visibleEntity(entity -> entity == offer.drop, 3.25)
            .filter(entity -> offer.drop.getStack().isOf(offer.item)).isPresent();
    }

    private static boolean dropNearLanding(ItemEntity drop, Floor floor) {
        return horizontalSquared(drop.getPos(), floor.landing) < 0.16
            && Math.abs(drop.getY() - floor.landing.y) < 0.38;
    }

    private boolean visible(Face face) {
        return visible(face, reach());
    }

    private boolean visible(Face face, double distance) {
        return body.macroVisible(face.hit, distance) && client.world.getBlockState(face.hit.getBlockPos()) == face.state;
    }

    private boolean visibleFace(Face face) {
        return body.macroMineWitness(face.hit, reach()) != null
            && client.world.getBlockState(face.hit.getBlockPos()) == face.state;
    }

    private boolean directCapCurrent(Face face, AgentProgress progress) {
        if (trial || !"preset".equals(ipc.workMode) || goal.equals("wooden_pickaxe")
                || client.options.attackKey.isUnbound() || hasActiveWorkOrder() || !visibleFace(face)) return false;
        BlockPos cell = face.hit.getBlockPos();
        ItemStack hand = player.getMainHandStack();
        Item drop = AgentWorkOrder.prospectCoverDrop(face.state);
        // Direct mode is one exact ordinary-soil contact, with no tool-count
        // spend and no implied authority for another cut or a stair segment.
        return drop == Items.DIRT && AgentMiningStock.maxLoss(hand, face.state, world, cell) == 0
            && prospectCutGeometry(player.getBlockPos(), face.hit, surfaceSearch)
            && dryWorkBreakSafe(cell, face.state, drop, progress) && hasEarlyPick();
    }

    private boolean hasEarlyPick() {
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot) {
            if (player.getInventory().getStack(slot).isSuitableFor(Blocks.STONE.getDefaultState())) return true;
        }
        return false;
    }

    private static Key faceKey(Verb verb, Face face, String activity) {
        return new Key(verb, face.hit.getBlockPos(), 0, activity, face.hit.getSide(), face.state);
    }

    private double reach() { return Math.min(4.25, client.player.getBlockInteractionRange() - 0.15); }

    private boolean useAvailable() {
        return !client.options.useKey.isUnbound() && !client.player.isUsingItem() && !client.player.isSneaking()
            && !client.interactionManager.isBreakingBlock();
    }

    private boolean canBreak(Face face, AgentProgress progress) {
        return resource(face.state) && canBreak(face.hit.getBlockPos(), face.state, progress);
    }

    private boolean canBreak(BlockPos pos, BlockState state, AgentProgress progress) {
        return pos.getY() >= client.player.getBlockY()
            && progress.macroCanBreak(pos) && !client.options.attackKey.isUnbound()
            && (!state.isToolRequired() || client.player.getMainHandStack().isSuitableFor(state));
    }

    private static boolean resource(BlockState state) {
        return state.isIn(BlockTags.LOGS) || state.isIn(BlockTags.COAL_ORES) || state.isIn(BlockTags.IRON_ORES)
            || state.isIn(BlockTags.DIAMOND_ORES) || state.isIn(BlockTags.COPPER_ORES) || state.isIn(BlockTags.GOLD_ORES)
            || state.isIn(BlockTags.REDSTONE_ORES) || state.isIn(BlockTags.LAPIS_ORES) || state.isIn(BlockTags.EMERALD_ORES);
    }

    private static boolean station(BlockState state) { return state.isOf(Blocks.CRAFTING_TABLE) || state.isOf(Blocks.FURNACE); }
    private static String blockName(Face face) { return Registries.BLOCK.getId(face.state.getBlock()).toString(); }

    private PersonalStation personalStation(Block block) {
        return block == Blocks.CRAFTING_TABLE ? personalTable : block == Blocks.FURNACE ? personalFurnace : null;
    }

    private void forgetStationAt(PersonalStation clue, BlockPos pos) {
        if (clue != null && clue.face.hit.getBlockPos().equals(pos)) {
            if (clue == personalTable) personalTable = null;
            else personalFurnace = null;
        }
    }

    private boolean sameStation(Face face) {
        var current = world.getBlockState(face.hit.getBlockPos());
        if (face.state.isOf(Blocks.FURNACE)) return current.isOf(Blocks.FURNACE)
            && current.get(AbstractFurnaceBlock.FACING) == face.state.get(AbstractFurnaceBlock.FACING);
        return face.state.isOf(Blocks.CRAFTING_TABLE) && current == face.state;
    }

    private void rememberStation(Face face) {
        if (trial || !sameStation(face)) return;
        if (stationPlacement != null && stationPlacement.pos.equals(face.hit.getBlockPos())) stationPlacement = null;
        var clue = new PersonalStation(face, player.getPos(), tick, now, ++stationSequence);
        if (face.state.isOf(Blocks.CRAFTING_TABLE)) personalTable = clue;
        else personalFurnace = clue;
    }

    private void witnessStationPlacement() {
        var placement = stationPlacement;
        if (placement == null) return;
        if (tick > placement.until || player.getPos().squaredDistanceTo(placement.stance) > 0.0144
                || world.getBlockState(placement.pos) != placement.state) {
            stationPlacement = null;
            return;
        }
        // A placement receipt does not establish a rendered face. This only checks
        // subsequent live views and does not hold the work order open.
        if (observableWorld() && body.renderedFrame() > placement.framedAfter) {
            var seen = visibleStation(placement.state.getBlock(), placement.pos);
            if (seen != null) rememberStation(face(seen));
        }
    }

    private boolean stationClueCurrent(PersonalStation clue) {
        return tick - clue.tick < STATION_RECALL_TICKS && now - clue.time < STATION_RECALL_NS
            && player.getPos().squaredDistanceTo(clue.stance) <= STATION_RECALL_STANCE_SQUARED
            && sameStation(clue.face);
    }

    private BlockHitResult visibleStation(Block block) {
        return visibleStation(block, null);
    }

    private BlockHitResult visibleStation(Block block, BlockPos exact) {
        var clue = personalStation(block);
        if (clue != null && clue.attempted && (exact == null || exact.equals(clue.face.hit.getBlockPos()))) {
            var live = body.macroMineWitness(clue.face.hit, reach());
            if (live != null) return live;
        }
        return body.find(state -> state.isOf(block), reach(),
            exact == null ? null : hit -> exact.equals(hit.getBlockPos())).orElse(null);
    }

    private boolean stationRecallReady(PersonalStation clue) {
        if (clue == null || clue.attempted || !stationClueCurrent(clue) || !settled() || !useAvailable()
                || !body.keysNeutral()) return false;
        double reach = reach();
        return player.getEyePos().squaredDistanceTo(clue.face.hit.getPos()) <= reach * reach;
    }

    private boolean startStationRecall(PersonalStation clue) {
        if (!stationRecallReady(clue)) return false;
        clue.attempted = true;
        startWorkStep(Verb.STATION_REACQUIRE, "Reacquire recent " + blockName(clue.face), clue.face, null, null, null);
        return true;
    }

    private void advanceStationRecall() {
        Face remembered = action.offer.face;
        if (!cursorClear() || !body.keysNeutral() || !settled() || !useAvailable()
                || action.position.squaredDistanceTo(player.getPos()) > 0.0144
                || personalStation(remembered.state.getBlock()) == null || !sameStation(remembered)) {
            interrupt("The recent workstation clue or stationary stance was lost; nothing was used.", true);
            return;
        }
        if (!body.hasRecentView()) return;
        long frame = body.renderedFrame();
        if (frame > action.startingFrame && body.renderedAim(remembered.hit.getPos(), 4)) {
            if (body.macroMineWitness(remembered.hit, reach()) != null) {
                complete("A fresh first-person view confirmed " + blockName(remembered)
                    + " in reach; no screen, item use or movement was authorized.");
                return;
            }
            if (action.lastMissingFrame != frame) {
                action.lastMissingFrame = frame;
                if (++action.missingFaceFrames >= 3) {
                    interrupt("The aimed first-person view could not re-witness the recent workstation face.", true);
                    return;
                }
            }
        }
        body.turnScan(action.camera.yaw, action.camera.pitch);
    }

    private boolean ingredients(Recipe recipe) {
        return hands.count(recipe.material) >= recipe.amount && (recipe.sticks == 0 || hands.count(STICK) >= recipe.sticks);
    }

    private int count(Item item) {
        var inventory = client.player.getInventory();
        int count = 0;
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; i++) {
            ItemStack stack = inventory.getStack(i);
            if (stack.isOf(item)) count += stack.getCount();
        }
        return count;
    }

    private boolean roomFor(ItemStack drop) {
        var inventory = client.player.getInventory();
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; i++) {
            ItemStack stack = inventory.getStack(i);
            if (stack.isEmpty() || ItemStack.areItemsAndComponentsEqual(stack, drop) && stack.getCount() < stack.getMaxCount())
                return true;
        }
        return false;
    }

    private void updateScope(boolean checkInventory) {
        if (client.player == null) return;
        Vec3d pos = client.player.getPos();
        // Ordinary movement changes the view, not the life/material epoch. Each absolute
        // face/drop/floor is rechecked as that same target; relative surveys need a new ID.
        if (action == null && (anchor == null || horizontalSquared(anchor, pos) > 0.64 || Math.abs(pos.y - anchor.y) > 0.25)) {
            anchor = pos;
            surveyYaw = client.player.getYaw();
            ++surveyOrigin;
            retiredViews.clear();
        }
        if (hazardClear != lastHazard) {
            lastHazard = hazardClear;
            ++epoch;
            ++safetyRevision;
        }
        // A currently owned recipe or pickup can change inventory as part of its effect.
        if (action == null && checkInventory) {
            var inventory = client.player.getInventory();
            long stamp = 1 + inventory.selectedSlot;
            for (int i = 0; i < inventory.size(); i++) {
                ItemStack stack = inventory.getStack(i);
                if (!stack.isEmpty()) stamp = stamp * 31 + System.identityHashCode(stack.getItem()) * 17L + stack.getCount() + i;
            }
            // A change in the selected item's durability or components can invalidate
            // a quoted stock-loss bound even when all inventory counts are unchanged.
            ItemStack hand = inventory.getMainHandStack();
            boolean toolChanged = !ItemStack.areItemsAndComponentsEqual(scopedMainHand, hand);
            if (toolChanged) scopedMainHand = hand.copy();
            if (stamp != inventoryStamp || toolChanged) {
                inventoryStamp = stamp;
                ++epoch;
            }
        }
    }

    private List<Offer> offers(AgentProgress progress) {
        var offers = new ArrayList<Offer>(MAX_OFFERS);
        for (Offer reserved : reservation()) if (liveMaterialFace(reserved, progress)) offers.add(reserved);
        if (!trial) addDryRouteOffer(offers, progress);
        if (!trial && ipc.workMode != null) addWaterClue(offers);
        var player = client.player;
        float pitch = player.getPitch();
        addStationOffer(offers, Blocks.CRAFTING_TABLE);
        addStationOffer(offers, Blocks.FURNACE);
        if (!repeatedSourceView()) {
            survey(offers, "footing", surveyYaw, 42, "Survey the nearby ground", "A fixed downward camera angle from the current stance.");
            survey(offers, "left", surveyYaw - 55, 31, "Survey left from this stance", "A bounded first-person turn over nearby terrain.");
            survey(offers, "right", surveyYaw + 55, 31, "Survey right from this stance", "A bounded first-person turn over nearby terrain.");
        }

        BlockPos standing = player.getBlockPos().down();
        for (Direction direction : CARDINAL) {
            BlockPos floor = standing.offset(direction);
            if (client.options.forwardKey.isUnbound() || body.macroFloor(floor) == null) continue;
            var witness = new Floor(floor, client.world.getBlockState(floor), Vec3d.ofBottomCenter(floor.up()));
            if (!body.macroFlatLane(floor, witness.state, witness.landing)) continue;
            var key = new Key(Verb.APPROACH, floor, 0, null);
            if (!repeatedSourceFooting(floor) && body.macroNoVisiblePickup(witness.landing)) {
                offer(offers, key, "Walk to the adjacent flat tile", "Lit full top and clear dry sweep, " +
                    bearing(witness.landing, player.getPos(), player.getYaw()) + " from the current view.",
                    0, pitch, witness, null, null, null, null);
                if (!trial && "preset".equals(ipc.workMode)) addFarFoothold(offers, witness, direction, pitch);
            }
            var seen = body.visibleEntity(entity -> entity instanceof ItemEntity item && dropNearLanding(item, witness)
                && !item.getStack().isEmpty() && roomFor(item.getStack()), 3.25).orElse(null);
            if (seen instanceof ItemEntity drop) {
                Item item = drop.getStack().getItem();
                offer(offers, new Key(Verb.COLLECT, floor, drop.getId(), null), "Collect visible " + Registries.ITEM.getId(item),
                    "A rendered drop is on this adjacent dry tile; the matching item fits in inventory.",
                    0, pitch, witness, null, drop, item, null);
            }
        }
        var resource = body.find(AgentMacroControl::resource, reach(),
            hit -> canBreak(hit.getBlockPos(), client.world.getBlockState(hit.getBlockPos()), progress)
                && body.macroMineWitness(hit, reach()) != null).orElse(null);
        if (resource != null) {
            Face face = face(resource);
            offer(offers, faceKey(Verb.BREAK, face, null),
                "Break visible " + blockName(face), "A lit resource face is in reach and the selected hand can harvest it.",
                0, pitch, null, face, null, null, null);
        }
        if (!trial && "preset".equals(ipc.workMode) && surfaceSearch.firstCover == null && hasEarlyPick()) {
            for (Direction direction : CARDINAL) {
                BlockHitResult top = body.macroFloor(standing.offset(direction));
                if (top == null) continue;
                Face cap = face(top);
                if (!directCapCurrent(cap, progress)) continue;
                offer(offers, faceKey(Verb.BREAK, cap, SURFACE_CAP), "Cut one witnessed adjacent " + blockName(cap) + " cap",
                    "The exact dry top is beside the player and is not retained footing; this authorizes one single break, not descent or a hidden source.",
                    0, 0, null, cap, null, null, null);
                break;
            }
        }
        var resourceView = body.find(AgentMacroControl::resource, INSPECT_REACH, hit ->
            !retiredViews.contains(faceKey(Verb.INSPECT, face(hit), null)) && !body.renderedAim(hit.getPos(), 7))
            .orElse(null);
        if (resourceView != null) inspect(offers, face(resourceView));
        if (!client.options.inventoryKey.isUnbound()) {
            craftOffer(offers, PLANKS, null);
            craftOffer(offers, STICKS, null);
            craftOffer(offers, BENCH, null);
        }
        return offers;
    }

    private void addWaterClue(List<Offer> offers) {
        BlockPos support = player.getBlockPos().down();
        if (!settled() || !ironFooting(support)) return;
        double reach = reach();
        BlockHitResult source = body.visibleFluid(false, true, reach);
        if (source != null && body.waterFillWitness(source, reach)) {
            Face face = face(source);
            Key key = faceKey(Verb.WATER_CLUE, face, null);
            if (materialTarget(new Key(Verb.WATER_CLUE, key.pos, 0, null)) == null) return;
            var floor = new Floor(support, world.getBlockState(support), player.getPos());
            offer(offers, key, "Witnessed source water in bucket reach",
                "A lit source-water surface is visible " + bearing(source.getPos(), player.getPos(), player.getYaw())
                    + " from this dry stance. This clue grants no input.", 0, 0, floor, face, null, null, null);
        } else {
            BlockHitResult water = body.visibleFluid(false, false, AgentHazards.SIGHT_RANGE);
            if (water == null || AgentBody.exactWaterSource(world.getBlockState(water.getBlockPos()))) return;
            offer(offers, new Key(Verb.WATER_CLUE, null, 0, "flowing"), "Flowing water without a reachable source",
                "A flowing water face is visible, but no fillable source is witnessed in bucket reach.",
                0, 0, null, null, null, null, null);
        }
    }

    private void addStationOffer(List<Offer> offers, Block block) {
        BlockHitResult seen = visibleStation(block);
        if (seen != null) {
            Face face = face(seen);
            inspect(offers, face);
            if (useAvailable() && visibleFace(face)) {
                offer(offers, faceKey(Verb.INTERACT, face, null),
                    "Open visible " + blockName(face), "A lit workstation face is inside vanilla use reach.",
                    0, 0, null, face, null, null, null);
                if (block == Blocks.CRAFTING_TABLE) for (Recipe recipe : BENCH_RECIPES) craftOffer(offers, recipe, face);
            }
        } else {
            var clue = personalStation(block);
            if (!stationRecallReady(clue)) return;
            var key = new Key(Verb.STATION_REACQUIRE, clue.face.hit.getBlockPos(), clue.sequence, null);
            offer(offers, key, "Reacquire recent " + blockName(clue.face),
                "Turn in place once toward a workstation face from a recent confirmed placement or use. "
                + "The camera must confirm the face again; no contact or spending is authorized.",
                0, 0, null, clue.face, null, null, null);
        }
    }

    private boolean repeatedSourceView() {
        return surfaceSearch.blockedAt != null && (surfaceSearch.blockedAt.equals(player.getBlockPos())
            || surfaceSearch.footholds.contains(player.getBlockPos().down()));
    }

    private void addFarFoothold(List<Offer> offers, Floor first, Direction direction, float pitch) {
        if (offers.size() >= MAX_OFFERS || offers.stream().anyMatch(offer -> offer.farther != null)) return;
        BlockPos pos = first.pos.offset(direction);
        if (repeatedSourceFooting(pos) || body.macroFloor(pos) == null) return;
        BlockState state = world.getBlockState(pos);
        if (state.getBlock() instanceof FallingBlock) return;
        Floor later = new Floor(pos, state, Vec3d.ofBottomCenter(pos.up()));
        if (!body.macroNoVisiblePickup(later.landing)) return;
        Key key = new Key(Verb.APPROACH, pos, 0, "two_surface_hops");
        offers.add(new Offer(offerId(key), key, "Walk to a farther witnessed dry foothold",
            "Two lit same-height treads on one bearing; stop at the first if the next does not revalidate, and avoid visible pickups.",
            0, pitch, first, null, null, null, null, null, later));
    }

    private boolean repeatedSourceFooting(BlockPos floor) {
        return surfaceSearch.blockedAt != null && (surfaceSearch.footholds.contains(floor)
            || surfaceSearch.blockedAt.down().equals(floor));
    }

    private void addDryRouteOffer(List<Offer> offers, AgentProgress progress) {
        AgentDryCaveRoute.Offer route = progress.dryRouteOffer();
        String evidence = progress.dryRouteOfferEvidence();
        if (!evidence.equals(dryOfferEvidence)) {
            dryOfferEvidence = evidence;
            remember("dry route: " + evidence);
        }
        if (route == null || route.edges() < 1 || route.edges() > MAX_ROUTE_EDGES
                || !route.from().equals(player.getBlockPos()) || route.from().equals(route.endpoint())
                || route.from().equals(route.next()) || Math.abs(route.heightChange()) > 1
                || route.heightChange() != 0 && (route.edges() != 1 || !route.next().equals(route.endpoint()))
                || route.heightChange() == 0 && route.from().getY() != route.next().getY()) {
            routeOffer = null;
            AgentDryCaveRoute.Survey survey = progress.drySurveyOffer();
            if (survey == null) {
                drySurveyOffer = null;
            } else {
                if (drySurveyOffer == null || drySurveyOffer.drySurvey != survey) {
                    String id = "o-" + ++nextId;
                    drySurveyOffer = new Offer(id, new Key(Verb.DRY_SURVEY, null, 0, id),
                        "Inspect the witnessed lower cave lane",
                        "A lit lower face is visible near this dry lip. Look from this stance for footing, body clearance, and the return; do not move or spend.",
                        0, 0, null, null, null, null, null, null, null, survey);
                }
                if (offers.size() < MAX_OFFERS) offers.add(drySurveyOffer);
            }
            return;
        }
        drySurveyOffer = null;
        if (routeOffer == null || routeOffer.route != route) {
            String id = "o-" + ++nextId;
            routeOffer = new Offer(id, new Key(Verb.FOLLOW, null, 0, id), "Follow a witnessed dry cave segment",
                dryRouteDescription(route) + " with a distinct endpoint and a witnessed return. Recheck each edge before moving.",
                0, 0, null, null, null, null, null, route);
        }
        if (offers.size() < MAX_OFFERS) offers.add(routeOffer);
    }

    private static String dryRouteDescription(AgentDryCaveRoute.Offer route) {
        return route.heightChange() > 0 ? "one witnessed block up" : route.heightChange() < 0
            ? "one witnessed block down" : route.edges() == 1 ? "one witnessed level edge"
            : route.edges() + " witnessed level edges";
    }

    private Face face(BlockHitResult hit) {
        return new Face(hit, client.world.getBlockState(hit.getBlockPos()));
    }

    private void survey(List<Offer> offers, String id, float yaw, float pitch, String title, String evidence) {
        Key key = new Key(Verb.SURVEY, null, surveyOrigin, id);
        if (!retiredViews.contains(key) && angle(client.player.getYaw(), client.player.getPitch(), yaw, pitch) >= 7)
            offer(offers, key, title, evidence, yaw, pitch, null, null, null, null, null);
    }

    private void inspect(List<Offer> offers, Face face) {
        Key key = faceKey(Verb.INSPECT, face, null);
        if (!retiredViews.contains(key) && !body.renderedAim(face.hit.getPos(), 7))
            offer(offers, key, "Center the visible " + blockName(face), "A lit face is visible away from the current crosshair.",
                0, 0, null, face, null, null, null);
    }

    private void craftOffer(List<Offer> offers, Recipe recipe, Face face) {
        if (ingredients(recipe) && (recipe.result == null || count(recipe.result) == 0 || recipe == STICKS)) {
            offer(offers, face == null ? new Key(Verb.CONTINUE, null, 0, recipe.id) : faceKey(Verb.CONTINUE, face, recipe.id),
                "Craft " + recipe.id + (face == null ? " in the inventory grid" : " at the visible crafting table"),
                "The visible inventory holds the ingredients for this vanilla recipe" + (face == null ? "." : "; the table is in reach."),
                0, 0, null, face, null, null, recipe);
        }
    }

    private void offer(List<Offer> offers, Key key, String summary, String evidence, float yaw, float pitch, Floor floor,
                       Face face, ItemEntity drop, Item item, Recipe recipe) {
        if (offers.size() >= MAX_OFFERS) return;
        for (Offer existing : offers) if (existing.key.equals(key)) return;
        offers.add(new Offer(offerId(key), key, summary, evidence, yaw, pitch, floor, face, drop, item, recipe));
    }

    private String offerId(Key key) {
        String id = ids.get(key);
        if (id == null) {
            if (ids.size() >= 256) ids.pollFirstEntry();
            id = "o-" + ++nextId;
            ids.put(key, id);
        }
        return id;
    }

    private String materialTarget(Key key) {
        String target = materialTargets.get(key);
        if (target != null || materialTargets.size() >= MAX_MATERIAL_TARGETS) return target;
        target = "m-" + ++nextMaterialId;
        materialTargets.put(key, target);
        return target;
    }

    /** Describes only this primitive's possible spend, never a hidden or expected drop. */
    private JsonObject material(Offer offer, PlayerInventory inventory) {
        String subject, target;
        JsonObject spends;
        switch (offer.key.verb) {
            case WATER_CLUE -> {
                if (offer.face == null) return null;
                subject = "fluid:minecraft:water_source";
                target = materialTarget(new Key(Verb.WATER_CLUE, offer.key.pos, 0, null));
                spends = new JsonObject();
                spends.addProperty("minecraft:bucket", 1);
            }
            case BREAK -> {
                ItemStack hand = inventory.getMainHandStack();
                int loss = AgentMiningStock.maxLoss(hand, offer.face.state, world, offer.key.pos);
                if (loss == AgentMiningStock.UNKNOWN) return null;
                subject = "block:" + blockName(offer.face);
                // Two faces of one block are not two material targets.
                target = materialTarget(new Key(Verb.BREAK, offer.key.pos, 0, null));
                if (target == null) return null;
                spends = new JsonObject();
                if (loss > 0) spends.addProperty(Registries.ITEM.getId(hand.getItem()).toString(), loss);
            }
            case COLLECT -> {
                subject = "item:" + Registries.ITEM.getId(offer.item);
                target = materialTarget(new Key(Verb.COLLECT, null, offer.key.entity, null));
                if (target == null) return null;
                spends = new JsonObject();
            }
            case CONTINUE -> {
                Recipe recipe = offer.recipe;
                subject = "recipe:" + recipe.id;
                target = "recipe-" + recipe.id;
                spends = new JsonObject();
                // AgentHands.craft(id) submits exactly one request. Bound each eligible
                // item even when vanilla's compatible ingredient choice is not unique.
                for (int i = 0; i < PlayerInventory.MAIN_SIZE; ++i) {
                    ItemStack stack = inventory.getStack(i);
                    if (stack.isEmpty()) continue;
                    int limit = (recipe.material.test(stack) ? recipe.amount : 0) +
                        (stack.isOf(Items.STICK) ? recipe.sticks : 0);
                    if (limit != 0) spends.addProperty(Registries.ITEM.getId(stack.getItem()).toString(), limit);
                }
            }
            default -> { return null; }
        }
        JsonObject material = new JsonObject();
        material.addProperty("subject", subject);
        material.addProperty("target", target);
        material.add("spends", spends);
        return material;
    }

    private void publish(AgentProgress progress) {
        publish(progress, 0);
    }

    private void publish(AgentProgress progress, float crack) {
        lastObservation = tick;
        JsonObject value = header(run);
        value.addProperty("life", life);
        value.addProperty("tick", tick);
        value.addProperty("epoch", epoch);
        value.addProperty("goal", goal);
        value.addProperty("health", client.player.getHealth());
        value.addProperty("food", client.player.getHungerManager().getFoodLevel());
        JsonObject safety = new JsonObject();
        safety.addProperty("clear", hazardClear && !urgent);
        safety.addProperty("revision", safetyRevision);
        value.add("safety", safety);
        if (crack > 0) {
            if (action.intent != null) {
                JsonObject working = new JsonObject();
                working.addProperty("intentId", action.intent.id);
                working.addProperty("crack", crack);
                value.add("working", working);
            }
        }
        if (work != null) {
            value.add("workOrder", workObservation());
        }
        JsonObject inventory = new JsonObject();
        var inv = client.player.getInventory();
        int slots = ipc.workMode == null ? inv.size() : PlayerInventory.MAIN_SIZE;
        for (int i = 0; i < slots; i++) {
            ItemStack stack = inv.getStack(i);
            if (stack.isEmpty()) continue;
            String id = Registries.ITEM.getId(stack.getItem()).toString();
            inventory.addProperty(id, stack.getCount() + (inventory.has(id) ? inventory.get(id).getAsInt() : 0));
        }
        value.add("inventory", inventory);
        JsonArray opportunities = new JsonArray();
        Map<String, Offer> witnessed = new LinkedHashMap<>();
        List<Offer> visible = List.of();
        if (progress != null && observableWorld()) {
            if (action == null) visible = offers(progress);
            else if (action.intent == null && action.keepVisible.length != 0) {
                var continuing = new ArrayList<Offer>(action.keepVisible.length);
                for (Offer anchor : action.keepVisible) if (liveMaterialFace(anchor, progress)) continuing.add(anchor);
                visible = continuing;
            }
        }
        for (Offer offer : visible) {
            JsonObject entry = new JsonObject();
            entry.addProperty("id", offer.id);
            entry.addProperty("verb", offer.key.verb.id);
            entry.addProperty("summary", offer.summary);
            entry.addProperty("evidence", offer.evidence);
            entry.addProperty("risk", offer.key.verb.risk);
            JsonObject material = material(offer, inv);
            if (material != null) entry.add("material", material);
            opportunities.add(entry);
            witnessed.put(offer.id, offer);
        }
        snapshots.put(tick, new Snapshot(epoch, witnessed.isEmpty() ? Map.of() : witnessed));
        while (!snapshots.isEmpty() && snapshots.firstEntry().getKey() < tick - MAX_AGE) snapshots.pollFirstEntry();
        value.add("opportunities", opportunities);
        JsonArray history = new JsonArray(recent.size());
        for (String event : recent) history.add(event);
        value.add("recent", history);
        value.addProperty("quiescent", quiescent);
        ipc.observation.set(value.toString());
    }

    private JsonObject workObservation() {
        JsonObject state = new JsonObject();
        JsonObject evidence = new JsonObject();
        state.addProperty("id", work.order.id());
        var target = work.order.policy().target();
        Item desired = goalStock(target);
        int required = goalAmount(target);
        int observed = desired == null ? 0 : count(desired);
        String replan = null;
        if (work.active() && !work.budget.policy.smeltIron() && !work.budget.policy.waterFill()) {
            if (desired != null && workNearTarget(desired, observed, required)) replan = "target_near";
            else if (work.budget.nearLimit()) replan = "cap_near";
            else if (work.deadline - now <= 7_500_000_000L) replan = "expiry_near";
        }
        String description = work.enactedStatus;
        if (deepWork()) description += " " + diamondProgress() + "; " + work.budget.breaksLeft() + " breaks left; "
            + (work.budget.policy.caps().getOrDefault(Items.TORCH, 0) - work.budget.remainingCost(Items.TORCH))
            + " torch uses charged, "
            + (work.budget.policy.caps().getOrDefault(Items.COBBLESTONE, 0) - work.budget.remainingCost(Items.COBBLESTONE))
            + " cobblestone placements charged, " + diamondRoute.placedSupports.size() + " support tops confirmed, "
            + diamondRoute.supportedLandings + " support landings, " + work.budget.placementsLeft() + " placements left.";
        if (work.active() && action != null && action.durable && action.craftJob != 0 && hands.busy())
            description += "; vanilla hands: " + hands.status();
        state.addProperty("state", replan == null ? work.phase : "needs_replan");
        state.addProperty("detail", description);
        evidence.addProperty("phase", work.enactedPhase);
        evidence.addProperty("status", description);
        evidence.addProperty("breaks", work.confirmedBreaks);
        evidence.addProperty("crafts", work.confirmedCrafts);
        evidence.addProperty("placements", work.confirmedPlacements);
        if (desired != null) {
            JsonObject stock = new JsonObject();
            stock.addProperty("item", Registries.ITEM.getId(desired).toString());
            stock.addProperty("count", observed);
            stock.addProperty("required", required);
            evidence.add("target", stock);
        }
        if (work.lastEffect != null) {
            JsonObject effect = new JsonObject();
            effect.addProperty("tick", work.lastEffectTick);
            effect.addProperty("detail", work.lastEffect);
            evidence.add("lastEffect", effect);
        }
        if (replan != null) evidence.addProperty("replan", replan);
        var iron = action == null ? null : action.furnace;
        if (work.active() && iron != null && iron.burnTick != 0
                && (iron.phase == FurnacePhase.BURNING || iron.phase == FurnacePhase.COLLECTING)) {
            var burn = new JsonObject();
            burn.addProperty("burnTick", iron.burnTick);
            burn.addProperty("units", iron.batch.units());
            int remaining = iron.phase == FurnacePhase.COLLECTING ? 0 : Math.max(0,
                (iron.batch.units() - iron.output) * AgentHands.SMELT_TICKS - Math.round(iron.progress * AgentHands.SMELT_TICKS));
            burn.addProperty("remainingCookTicks", remaining);
            evidence.add("smeltBurn", burn);
        }
        state.add("progress", evidence);
        return state;
    }

    private boolean workNearTarget(Item desired, int observed, int required) {
        if (observed >= required || (observed > work.startingStock
                && required - observed <= Math.max(2, (required - work.startingStock + 1) / 2))) return true;
        if (action == null || !action.durable || action.craftJob == 0 || !hands.busy()) return false;
        Recipe recipe = action.offer.recipe;
        // This is a request lead, not a receipt: the server has not produced the output yet.
        return recipe != null && AgentHands.workOutput(recipe.id) == desired
            && required - observed <= AgentHands.workOutputCount(recipe.id);
    }

    private void refuseUnseen(String detail) {
        if (input == null || !input.active || input.intent == null || consumed.containsKey(input.intent.id)) return;
        markConsumed(input.intent.id);
        receipt(input.intent, "refused", detail);
    }

    private void markConsumed(String id) {
        if (consumed.size() >= 1024) consumed.pollFirstEntry();
        consumed.put(id, Boolean.TRUE);
    }

    private void complete(String detail) { finish("completed", detail); }

    private void interrupt(String detail, boolean closeOwned) {
        boolean retained = hands != null && hands.holdsWorkInventory();
        releasePersonalCraft(closeOwned);
        if (action == null) return;
        clearUnconsumedWaterUse();
        if (action.offer.key.verb == Verb.WORK_SMELT && action.furnace.phase != null) {
            detail += " The accepted batch is not reloaded; any uncollected contents stay in the furnace.";
        }
        if (closeOwned) closeOwnedWorkScreen(retained);
        finish("interrupted", detail);
    }

    private void closeOwnedWorkScreen(boolean retained) {
        if (action.craftJob != 0 && action.craftJob == hands.jobGeneration() && hands.busy()) hands.cancel();
        else if (!retained && action.opened != null && action.opened == client.currentScreen && cursorClear()) action.opened.close();
    }

    private void finish(String result, String detail) {
        if (action.offer.key.verb == Verb.BREAK && (owner.equals("terra") || action.durable)
                && !owner.equals("safety")) body.pauseWork();
        if (action.offer.route != null) {
            if (routeOwner != null) routeOwner.cancelFollowDryRoute(action.offer.route);
            routeOwner = null;
            routeOffer = null;
            if (!owner.equals("safety")) body.pauseWork();
        }
        if (action.offer.drySurvey != null) {
            if (routeOwner != null) routeOwner.cancelDrySurvey(action.offer.drySurvey);
            routeOwner = null;
            drySurveyOffer = null;
            if (!owner.equals("safety")) body.pauseWork();
        }
        String pickup = unexpectedPickup();
        if (pickup != null) {
            result = "interrupted";
            detail = pickup;
        }
        Verb verb = action.offer.key.verb;
        if (!result.equals("completed") && action.offer.face != null
                && (verb == Verb.STATION_REACQUIRE || verb == Verb.INTERACT || verb == Verb.CONTINUE || verb == Verb.WORK_SMELT)) {
            Face face = action.offer.face;
            forgetStationAt(personalStation(face.state.getBlock()), face.hit.getBlockPos());
        }
        if ((action.offer.key.verb == Verb.SURVEY || action.offer.key.verb == Verb.INSPECT)
                && retiredViews.size() < 256) retiredViews.add(action.offer.key);
        if (result.equals("completed") && action.offer.key.verb == Verb.APPROACH && (action.durable || repeatedSourceView())) {
            surfaceSearch.footholds.add(BlockPos.ofFloored(action.position).down());
            surfaceSearch.footholds.add((action.secondHop ? action.offer.farther : action.offer.floor).pos);
        }
        if (action.durable) {
            remember("work " + action.offer.key.verb.id + " " + result + ": " + detail);
            boolean deepTravel = action.diamondRoute && (action.offer.key.verb == Verb.WORK_TREAD || action.offer.key.verb == Verb.FOLLOW);
            if (deepTravel && !result.equals("completed")) {
                BlockPos from = action.tread != null ? action.tread.from : action.offer.route.from();
                if (action.drove || !player.getBlockPos().equals(from)) diamondRoute.unjoined = from;
            }
            if (!result.equals("completed") && !urgent) {
                enact("hold", detail);
                if (deepTravel) {
                    if (action.tread != null && action.tread.returning)
                        retireWork("blocked", "interrupted", detail + " Stopped rather than forcing the retained return.");
                    else if (diamondRoute.unjoined != null) retireWork("blocked", "interrupted", detail);
                    else diamondRoute.nextBearing(detail);
                } else if (action.prospectSupport != null) {
                    diamondRoute.nextBearing(detail);
                    diamondRoute.supportRefusal = detail;
                } else if (action.prospectLight) {
                    retireWork("blocked", "interrupted", detail);
                } else if (action.offer.key.verb == Verb.WORK_TREAD) {
                    work.sourceSearch.returnFailed = action.tread.returning;
                    if (action.tread.returning) work.sourceSearch.returnReason = null;
                    work.sourceSearch.stairUsed = true;
                    if (action.tread.returning || !player.getBlockPos().equals(action.tread.from)) {
                        retireWork("blocked", "interrupted", detail);
                    }
                }
                if (action.offer.face != null && verb != Verb.STATION_REACQUIRE) {
                    BlockPos refused = action.offer.face.hit.getBlockPos();
                    if (action.offer.key.verb == Verb.WORK_PLACE) refused = refused.up();
                    work.rejected.add(refused);
                } else if (action.offer.drop != null) work.rejectedDrops.add(action.offer.drop.getId());
                if (action.offer.key.verb == Verb.CONTINUE || action.offer.key.verb == Verb.WORK_SMELT
                        || action.offer.key.verb == Verb.WORK_FILL
                        || action.offer.key.verb == Verb.WORK_PLACE && action.offer.item == Items.FURNACE)
                    retireWork("needs_replan", "interrupted", detail);
            } else if (result.equals("completed")) {
                if (action.offer.key.verb == Verb.APPROACH || action.prospectCover)
                    work.sourceSearch.freshAfter = body.renderedFrame();
                if (action.offer.key.verb == Verb.BREAK || action.offer.key.verb == Verb.CONTINUE
                        || action.offer.key.verb == Verb.WORK_TREAD
                        || action.diamondRoute && action.offer.key.verb == Verb.FOLLOW
                        || action.offer.key.verb == Verb.WORK_PLACE || action.offer.key.verb == Verb.WORK_FILL || action.offer.drop != null) {
                    work.lastEffect = detail;
                    work.lastEffectTick = tick;
                }
                enact("hold", detail);
            }
        } else if (action.intent == null) {
            remember("local_motion " + result + ": " + detail);
            if (result.equals("completed")) ++fallbackActions;
        } else receipt(action.intent, result, detail);
        if (result.equals("completed") && (!action.durable || continuityWork != null) && !action.purposefulMotion)
            purposeful(detail);
        action = null;
    }

    private String unexpectedPickup() {
        if (action == null || action.walkInventory == null || client.player != player || client.world != world) return null;
        if (action.unexpectedPickup != null) return action.unexpectedPickup;
        Item item = action.walkInventory.gain(player.getInventory());
        if (item != null) action.unexpectedPickup = "Unexpected inventory gain during " + action.offer.key.verb.id
            + ": " + Registries.ITEM.getId(item) + ".";
        return action.unexpectedPickup;
    }

    private String timeoutDetail() {
        return switch (action.offer.key.verb) {
            case BREAK -> "The resource did not produce a matching vanilla break event before expiry.";
            case APPROACH -> "The short walk did not settle on the witnessed tile before expiry.";
            case COLLECT -> "The drop did not produce a matching inventory gain before expiry.";
            case INTERACT -> "The workstation did not produce the expected rendered GUI before expiry.";
            case FOLLOW -> "The witnessed dry route did not settle at its authorized endpoint before expiry.";
            case DRY_SURVEY -> "The stationary dry-edge survey expired before it could report its rendered evidence.";
            case CONTINUE -> "The trusted recipe did not produce a matching vanilla crafting receipt before expiry.";
            case SURVEY, INSPECT -> "The camera did not render the intended pose before expiry.";
            case STATION_REACQUIRE -> "The camera did not re-witness the exact recent workstation face before expiry.";
            case WORK_WALK -> "The route did not reach its witnessed target before expiry.";
            case WORK_TREAD -> "The surface stair did not settle on its exact proved support before expiry.";
            case WORK_EQUIP -> "The work equipment did not settle before expiry.";
            case WORK_PLACE -> "The authorized placement did not settle before expiry.";
            case WORK_SMELT -> "The finite smelting action expired before it could store the authorized output.";
            case WORK_FILL -> "The finite bucket fill expired before the exact source and inventory swap could be confirmed.";
            case WATER_CLUE -> throw new IllegalStateException("A water clue cannot run.");
        };
    }

    private void receipt(Intent intent, String result, String detail) {
        receipt(intent.id, intent.life, result, detail);
    }

    private void receipt(String id, int requestedLife, String result, String detail) {
        JsonObject value = header(run);
        value.addProperty("id", id);
        value.addProperty("life", requestedLife);
        value.addProperty("tick", tick);
        value.addProperty("status", result);
        value.addProperty("detail", detail);
        ipc.receipt(value.toString());
        remember(result + ": " + detail);
    }

    private void remember(String event) {
        if (recent.size() == 8) recent.removeFirst();
        recent.addLast(event);
    }

    private static JsonObject header(String run) {
        JsonObject value = new JsonObject();
        value.addProperty("v", 1);
        value.addProperty("run", run);
        return value;
    }

    private static float heading(double dx, double dz) { return (float) Math.toDegrees(Math.atan2(-dx, dz)); }

    private static String bearing(Vec3d to, Vec3d from, float yaw) {
        float offset = MathHelper.wrapDegrees(heading(to.x - from.x, to.z - from.z) - yaw);
        return Math.abs(offset) < 13 ? "ahead" : offset < 0 ? "left of center" : "right of center";
    }

    private static double horizontalSquared(Vec3d a, Vec3d b) {
        double x = a.x - b.x, z = a.z - b.z;
        return x * x + z * z;
    }

    private static double angle(float yaw, float pitch, float targetYaw, float targetPitch) {
        return Math.hypot(MathHelper.wrapDegrees(yaw - targetYaw), pitch - targetPitch);
    }

    /** Single bounded worker: no filesystem access from gameplay ticks. */
    private static final class Ipc {
        private static final Set<String> MARKER_FIELDS = Set.of("v", "run");
        private static final Set<String> WORK_MARKER_FIELDS = Set.of("v", "run", "workMode");
        private static final String LEGACY = "";
        private static final Set<String> INTENT_FIELDS =
            Set.of("v", "id", "run", "life", "epoch", "basisTick", "expiresTick", "opportunityId", "skillHash");
        private static final Set<String> HANDOFF_FIELDS = Set.of("v", "run", "life", "epoch", "basisTick", "expiresTick");
        private static final Set<String> PLANNING_FIELDS = Set.of("v", "run", "life", "epoch", "basisTick", "id");
        private static final WorkMailbox NO_WORK = new WorkMailbox(false, null);
        private static final Inbox OFF = new Inbox(false, null, null, null, NO_WORK);
        private final Path directory;
        private final String run, activeMode, workMode;
        private final Path workFile;
        private String workPayload;
        private WorkMailbox workMailbox = NO_WORK;
        private final ScheduledExecutorService worker;
        private final ScheduledFuture<?> poll;
        private final AtomicReference<String> observation = new AtomicReference<>();
        private final ArrayBlockingQueue<Output> evidence = new ArrayBlockingQueue<>(32);
        private volatile Inbox inbox;
        private volatile boolean retired, markerRevoked;

        Ipc(Path directory, String run, String mode) {
            this.directory = directory;
            this.run = run;
            activeMode = mode;
            workMode = mode == null || mode.equals(LEGACY) ? null : mode;
            workFile = directory.resolve("work.json");
            retired = mode == null;
            inbox = !retired ? new Inbox(true, null, null, null, NO_WORK) : OFF;
            worker = Executors.newSingleThreadScheduledExecutor(task -> {
                Thread thread = new Thread(task, "survival-agent-macro-io");
                thread.setDaemon(true);
                return thread;
            });
            poll = worker.scheduleWithFixedDelay(this::transfer, 0, 100, TimeUnit.MILLISECONDS);
        }

        void receipt(String receipt) {
            evidence("receipt.json", receipt);
        }

        boolean evidence(String file, String value) {
            if (!worker.isShutdown() && evidence.offer(new Output(file, value))) return true;
            retired = true;
            inbox = OFF;
            return false;
        }

        void close() {
            if (worker.isShutdown()) return;
            poll.cancel(false);
            worker.execute(this::flush);
            worker.shutdown();
        }

        void drain() {
            try {
                worker.awaitTermination(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        private void transfer() {
            try {
                if (!markerRevoked && activeMode != null && !activeMode.equals(activeMode(directory, run))) {
                    markerRevoked = true;
                    retired = true;
                }
                Inbox next = retired ? OFF : new Inbox(true, readIntent(), readHandoff(), readPlanning(inbox.planning),
                    readWork());
                inbox = retired ? OFF : next;
                flush();
            } catch (RuntimeException e) {
                retired = true;
                inbox = OFF;
            }
        }

        private WorkMailbox readWork() {
            if (workMode == null) return NO_WORK;
            String payload = readText(workFile, 16 * 1024);
            boolean present = payload != null || Files.isRegularFile(workFile, LinkOption.NOFOLLOW_LINKS);
            if (present == workMailbox.present && Objects.equals(payload, workPayload)) return workMailbox;
            workPayload = payload;
            workMailbox = present ? new WorkMailbox(true, AgentWorkOrder.parse(parseJson(payload), run, workMode)) : NO_WORK;
            return workMailbox;
        }

        private void flush() {
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) return;
            try {
                for (Output next; (next = evidence.peek()) != null;) {
                    if (next.file.equals("receipt.json")) {
                        Files.writeString(directory.resolve("native-receipts.jsonl"), next.value + "\n",
                            StandardOpenOption.CREATE, StandardOpenOption.APPEND, LinkOption.NOFOLLOW_LINKS);
                        evidence.remove();
                        atomic(next.file, next.value);
                    } else {
                        immutable(next.file, next.value);
                        evidence.remove();
                    }
                }
                String latest = observation.getAndSet(null);
                if (latest != null) atomic("observation.json", latest);
            } catch (IOException e) {
                retired = true;
                inbox = OFF;
            }
        }

        private void atomic(String name, String value) throws IOException {
            Path temporary = Files.createTempFile(directory, ".native-", ".tmp");
            try {
                Files.writeString(temporary, value + "\n");
                Files.move(temporary, directory.resolve(name), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } finally {
                Files.deleteIfExists(temporary);
            }
        }

        private void immutable(String name, String value) throws IOException {
            Path temporary = Files.createTempFile(directory, ".native-", ".tmp");
            try {
                Files.writeString(temporary, value + "\n");
                // Publish the complete record once; unlike ATOMIC_MOVE this cannot replace
                // a previously published witness with a different target or retirement tick.
                Files.createLink(directory.resolve(name), temporary);
            } finally {
                Files.deleteIfExists(temporary);
            }
        }

        private static boolean marked(Path directory, String run, String marker) {
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) return false;
            JsonObject value = read(directory.resolve(marker), 512);
            try {
                return value != null && value.keySet().equals(MARKER_FIELDS) && number(value, "v") == 1
                    && run.equals(text(value, "run"));
            } catch (RuntimeException e) {
                return false;
            }
        }

        private static String activeMode(Path directory, String run) {
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) return null;
            JsonObject value = read(directory.resolve("active.json"), 512);
            try {
                if (value == null || number(value, "v") != 1 || !run.equals(text(value, "run"))) return null;
                if (value.keySet().equals(MARKER_FIELDS)) return LEGACY;
                if (!value.keySet().equals(WORK_MARKER_FIELDS)) return null;
                String mode = text(value, "workMode");
                return mode.equals("preset") || mode.equals("constrained") ? mode : null;
            } catch (RuntimeException e) {
                return null;
            }
        }

        private Intent readIntent() {
            JsonObject value = read(directory.resolve("intent.json"), 2048);
            if (value == null || !value.keySet().equals(INTENT_FIELDS)) return null;
            try {
                if (number(value, "v") != 1 || !run.equals(text(value, "run"))) return null;
                String id = text(value, "id"), opportunity = text(value, "opportunityId");
                String skillHash = value.get("skillHash").isJsonNull() ? null : text(value, "skillHash");
                if (!TOKEN.matcher(id).matches() || !TOKEN.matcher(opportunity).matches()
                        || skillHash != null && !HASH.matcher(skillHash).matches()) return null;
                long life = number(value, "life"), epoch = number(value, "epoch"), basis = number(value, "basisTick");
                long expires = number(value, "expiresTick");
                if (life < 1 || life > Integer.MAX_VALUE || epoch < 1 || basis < 1 || expires <= basis
                        || expires - basis > MAX_AGE) return null;
                return new Intent(id, (int) life, epoch, basis, expires, opportunity, skillHash);
            } catch (RuntimeException e) {
                return null;
            }
        }

        private Handoff readHandoff() {
            JsonObject value = read(directory.resolve("handoff.json"), 2048);
            if (value == null || !value.keySet().equals(HANDOFF_FIELDS)) return null;
            try {
                if (number(value, "v") != 1 || !run.equals(text(value, "run"))) return null;
                long life = number(value, "life"), epoch = number(value, "epoch"), basis = number(value, "basisTick");
                long expires = number(value, "expiresTick");
                return life >= 1 && life <= Integer.MAX_VALUE && epoch >= 1 && basis >= 1 && expires > basis
                    && expires - basis <= MAX_HANDOFF_AGE ? new Handoff((int) life, epoch, basis, expires) : null;
            } catch (RuntimeException e) {
                return null;
            }
        }

        private Planning readPlanning(Planning previous) {
            JsonObject value = read(directory.resolve("planning.json"), 2048);
            if (value == null || !value.keySet().equals(PLANNING_FIELDS)) return null;
            try {
                if (number(value, "v") != 1 || !run.equals(text(value, "run"))) return null;
                long life = number(value, "life"), epoch = number(value, "epoch"), basis = number(value, "basisTick");
                String id = text(value, "id");
                if (life < 1 || life > Integer.MAX_VALUE || epoch < 1 || basis < 1 || !TOKEN.matcher(id).matches())
                    return null;
                if (previous != null && previous.id.equals(id) && previous.life == life && previous.epoch == epoch
                        && previous.basis == basis) return previous;
                return new Planning((int) life, epoch, basis, id, System.nanoTime());
            } catch (RuntimeException e) {
                return null;
            }
        }

        private static JsonObject read(Path path, int limit) {
            return parseJson(readText(path, limit));
        }

        private static String readText(Path path, int limit) {
            if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null;
            try (var stream = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
                byte[] data = stream.readNBytes(limit + 1);
                if (data.length > limit) return null;
                return new String(data, StandardCharsets.UTF_8);
            } catch (IOException | RuntimeException e) {
                return null;
            }
        }

        private static JsonObject parseJson(String text) {
            if (text == null) return null;
            try {
                var parsed = JsonParser.parseString(text);
                return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
            } catch (RuntimeException invalid) {
                return null;
            }
        }

        private static long number(JsonObject object, String field) {
            var value = object.getAsJsonPrimitive(field);
            if (!value.isNumber()) throw new IllegalArgumentException("Expected an integer");
            return value.getAsBigDecimal().longValueExact();
        }

        private static String text(JsonObject object, String field) {
            var value = object.getAsJsonPrimitive(field);
            if (!value.isString()) throw new IllegalArgumentException("Expected a string");
            return value.getAsString();
        }
    }
}
