package io.gameharness.survival;

import static io.gameharness.survival.AgentWorkOrder.TravelKind.CAVE_FRONTIER;
import static io.gameharness.survival.AgentWorkOrder.TravelKind.RESOURCE;
import static io.gameharness.survival.AgentWorkOrder.TravelKind.WOODLAND_FRONTIER;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.gameharness.survival.AgentSurveyEvidence.Survey;
import io.gameharness.survival.mixin.AgentMiningAccess;
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
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.IntPredicate;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import net.minecraft.block.AbstractFurnaceBlock;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.block.LeavesBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.ChunkPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.GameMode;

/** Camera witnesses and short, cancellable vanilla actions. The host sends IDs, never input or source. */
final class AgentMacroControl {
    private static final int OBSERVATION_INTERVAL = 5;
    private static final long PLANNING_IDLE_LIMIT_NS = 3_000_000_000L;
    private static final long PLAN_SETTLEMENT_GRACE_NS = 750_000_000L;
    private static final int MAX_AGE = 1_200;
    private static final int MAX_HANDOFF_AGE = 100;
    private static final int MAX_WORK_ADMISSION_AGE = 40;
    private static final int PERSONAL_HANDOFF_TICKS = 12;
    private static final long PERSONAL_HANDOFF_NS = 600_000_000L;
    private static final int FURNACE_CLICK_MARGIN = 120;
    private static final int FURNACE_SYNC_TICKS = 24;
    private static final int FURNACE_CUE_TICKS = 36;
    private static final int FURNACE_REACQUIRE_LEAD_TICKS = 28;
    private static final int FURNACE_REACQUIRE_TICKS = 64;
    private static final int WORKSHOP_SCAN_TICKS = 36;
    private static final int WORKSHOP_AIM_TICKS = 16;
    private static final int WORKSHOP_SUPPORTS = 8;
    private static final String IRON_WORKSHOP_STEP = "iron_workshop";
    private static final int MAX_ROUTE_EDGES = 8;
    private static final int PENDING_RETURN_LEGS = 3;
    private static final String PENDING_RETURN_EVIDENCE =
        "Known legs must revalidate one at a time; only the exact vanilla face, handler and output authorize withdrawal.";
    private static final int MAX_OFFERS = 16;
    private static final int MAX_MATERIAL_TARGETS = 4_096;
    private static final int APPROACH_SETTLE_TICKS = 3;
    private static final int GROUND_SCOUT_TICKS = 40;
    private static final double GROUND_SCOUT_WINDOW = 0.75;
    private static final double GROUND_SCOUT_LIMIT = 1.60;
    private static final double GROUND_SCOUT_ARRIVAL = 0.18;
    private static final int MAX_SOURCE_FOOTHOLDS = 5;
    private static final int HORIZON_CANDIDATES = 4;
    private static final int MIN_ROLLING_LEASE_TICKS = 10;
    private static final int GRADE_GLANCE_TICKS = 12;
    private static final int MIN_GRADE_LEASE_TICKS = GRADE_GLANCE_TICKS + AgentSurfaceTread.ORDINARY_GRADE_TICKS;
    private static final double TIMBER_ARRIVAL = 0.96;
    private static final String SURFACE_CAP = "surface_cap";
    private static final String SURFACE_OUTLOOK = "surface_outlook";
    private static final float SURFACE_OUTLOOK_PITCH = 63;
    private static final String STARTUP_OUTLOOK = "startup_outlook";
    private static final float STARTUP_CEILING_PITCH = -78;
    static final float STARTUP_OUTLOOK_PITCH = 18;
    static final int STARTUP_OUTLOOK_TICKS = 45;
    private static final double INSPECT_REACH = 16;
    private static final double TIMBER_RECALL_RANGE = 9;
    private static final int TIMBER_RECALL_TICKS = 220;
    private static final int TIMBER_RECALL_LIMIT = 16;
    private static final int TIMBER_OBSTRUCTION_TICKS = 900;
    private static final int STATION_RECALL_TICKS = 900;
    private static final long STATION_RECALL_NS = 45_000_000_000L;
    private static final double STATION_RECALL_STANCE_SQUARED = 0.75 * 0.75;
    private static final double PICKUP_STANCE_SQUARED = 1.20 * 1.20;
    static final double SETTLED_SPEED_SQUARED = 0.001225;
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
    private enum Verb {
        SURVEY("survey", "read", 30), DRY_SURVEY("survey", "guarded", 56),
        STATION_REACQUIRE("survey", "read", 40),
        INSPECT("inspect", "read", 30), APPROACH("approach", "low", 65),
        INTERACT("interact", "guarded", 40), COLLECT("collect", "guarded", 38), BREAK("break", "guarded", 120),
        CONTINUE("continue", "guarded", 320), FOLLOW("follow", "guarded", 640),
        WORK_WALK("work_walk", "guarded", 160), WORK_EQUIP("work_equip", "guarded", 120),
        WORK_PLACE("work_place", "guarded", 80), WORK_TREAD("work_tread", "guarded", AgentSurfaceTread.ACTION_TICKS),
        WORK_SMELT("work_smelt", "guarded", AgentWorkOrder.MAX_TICKS),
        WATER_CLUE("fill_water", "read", 0), WORK_FILL("work_fill", "guarded", 72),
        FOOD_CLUE("forage", "read", 0), WORK_FORAGE("work_forage", "guarded", AgentFoodWork.MAX_TICKS),
        COLLECT_PENDING("collect_pending", "guarded",
            PENDING_RETURN_LEGS * AgentSurfaceTread.ACTION_TICKS + 100 + AgentFurnaceWatch.PENDING_WAIT_TICKS),
        DEFER_PENDING("defer_pending", "low", 0);

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
    private record TimberPursuit(Face source, AgentWorkOrder.TravelAnchor anchor, Item timber,
                                 AgentWorkOrder.TravelKind kind, BlockPos stance, long safetyRevision, long stopped) {}
    private record TimberObstruction(TimberPursuit pursuit, Face leaf, String target) {}
    private record Key(Verb verb, BlockPos pos, int entity, String activity, Direction side, BlockState state) {
        Key(Verb verb, BlockPos pos, int entity, String activity) {
            this(verb, pos, entity, activity, null, null);
        }
    }
    private record Recipe(String id, Item result, Predicate<ItemStack> material, int amount, int sticks) {}
    private static final Recipe PLANKS = new Recipe("planks", null, LOG, 1, 0);
    private static final Recipe STICKS = new Recipe("stick", Items.STICK, PLANK, 2, 0);
    private static final Recipe BENCH = new Recipe("crafting_table", Items.CRAFTING_TABLE, PLANK, 4, 0);
    private static final Recipe BUCKET = new Recipe("bucket", Items.BUCKET, IRON, 3, 0);
    private static final Recipe TORCH = new Recipe("torch", Items.TORCH,
        stack -> stack.isOf(Items.COAL) || stack.isOf(Items.CHARCOAL), 1, 1);
    private static final Recipe[] BENCH_RECIPES = {
        new Recipe("wooden_pickaxe", Items.WOODEN_PICKAXE, PLANK, 3, 2),
        new Recipe("stone_pickaxe", Items.STONE_PICKAXE, STONE, 3, 2),
        new Recipe("iron_pickaxe", Items.IRON_PICKAXE, IRON, 3, 2),
        new Recipe("diamond_pickaxe", Items.DIAMOND_PICKAXE, DIAMOND, 3, 2)
    };

    private static final String DRY_VANTAGE = "route:dry_vantage";
    private record GroundScout(AgentWorkOrder.TravelAnchor anchor, Face face, long stance, Vec3d from,
                               float bearing, Vec3d goal, AgentDryLanding landing, AgentGroundVantage vantage,
                               AgentBody.OrdinaryGrade rise) {
        GroundScout(AgentWorkOrder.TravelAnchor anchor, Face face, long stance, Vec3d from, float bearing, Vec3d goal,
                    AgentDryLanding landing, AgentGroundVantage vantage) {
            this(anchor, face, stance, from, bearing, goal, landing, vantage, null);
        }
    }
    private record FoodClue(AgentFoodWork.Source source, Entity animal, Vec3d origin, int slot, Item hand) {}

    private record Offer(String id, Key key, String summary, String evidence, float yaw, float pitch,
                         Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe,
                         AgentDryCaveRoute.Offer route, Floor farther, AgentDryCaveRoute.Survey drySurvey,
                         GroundScout scout, FoodClue food) {
        Offer(String id, Key key, String summary, String evidence, float yaw, float pitch,
              Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe,
              AgentDryCaveRoute.Offer route, Floor farther, AgentDryCaveRoute.Survey drySurvey, GroundScout scout) {
            this(id, key, summary, evidence, yaw, pitch, floor, face, drop, item, recipe, route, farther, drySurvey, scout, null);
        }
        Offer(String id, Key key, String summary, String evidence, float yaw, float pitch,
              Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe,
              AgentDryCaveRoute.Offer route, Floor farther, AgentDryCaveRoute.Survey drySurvey) {
            this(id, key, summary, evidence, yaw, pitch, floor, face, drop, item, recipe, route, farther, drySurvey, null);
        }
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
    private record Snapshot(long epoch, Map<String, Offer> offers, String pendingTicket, boolean releasedWait,
                            AgentWorkOrder activeWork, AgentWorkOrder.TravelAnchor travelAnchor,
                            TimberObstruction timberObstruction, SurfaceOpening surfaceOpening) {}
    private record SurfaceOpening(AgentWorkOrder.SurfaceAnchor anchor, BlockPos foot, BlockState support,
                                  Face face, Item tool, int loss) {}
    private record Intent(String id, int life, long epoch, long basis, long expires, String opportunity, String skillHash) {}
    private record Handoff(int life, long epoch, long basis, long expires) {}
    private record Planning(int life, long epoch, long basis, String id, long noticedAt) {}
    private record WorkMailbox(boolean present, AgentWorkOrder order) {}
    private record PersonalCraft(AgentWorkOrder order, long untilTick, long untilNanos, boolean tableInReach) {}
    private record Inbox(boolean active, Intent intent, Handoff handoff, Planning planning, WorkMailbox work) {}
    private record Camera(float yaw, float pitch) {}
    private record PickupDeferral(Vec3d feet, Vec3d drop, boolean grounded, float yaw, float pitch) {}
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
            return gain(inventory, null);
        }

        Item gain(PlayerInventory inventory, Item expected) {
            counts.forEach((item, tally) -> tally.remaining = tally.original);
            for (int i = 0; i < inventory.size(); ++i) {
                ItemStack stack = inventory.getStack(i);
                if (stack.isEmpty() || stack.getItem() == expected) continue;
                Tally tally = counts.get(stack.getItem());
                if (tally == null || (tally.remaining -= stack.getCount()) < 0) return stack.getItem();
            }
            return null;
        }

        boolean unchanged(PlayerInventory inventory) {
            if (gain(inventory) != null) return false;
            for (Tally tally : counts.values()) if (tally.remaining != 0) return false;
            return true;
        }
    }

    private static final class Action {
        final Intent intent;
        final Offer offer;
        final long started, startedAt, startingFrame;
        final Vec3d position;
        final float yaw, pitch;
        final int itemCount;
        InventoryWitness walkInventory;
        final AgentWalkedRoute.Motion walkMotion;
        final Camera camera;
        final ItemStack harvestTool;
        final Offer[] keepVisible;
        final float pathYaw, pathPitch;
        boolean drove, fired, broken, purposefulMotion, durable, tableInReach, prospectCover;
        boolean diamondRoute, prospectLight, retryDiamondInset, scopedSourceLane, horizonBraking;
        float lastCrack;
        long firedAt, placementFrame, pickupDisappeared, craftJob, priorCraftReceipt, settledAt, lastMissingFrame;
        long workshopFaceUntil;
        int missingFaceFrames;
        String unexpectedPickup;
        Screen opened;
        Vec3d destination, walkFrom;
        AgentBody.HorizonTravel horizonTravel;
        long scoutStoppedFrame = -1;
        AgentWorkOrder.TravelKind horizonKind;
        AgentBody.OrdinaryGrade ordinaryGrade;
        long gradeLookUntil;
        boolean secondHop;
        boolean timberApproached, timberWorkStance;
        long dropSeen, pickupProgress;
        Vec3d dropPosition, pickupFooting;
        boolean dropGrounded, retryDropWhenVisible;
        TimberObstruction timberOpening;
        int timberLogsNeeded;
        AgentSurfaceTread tread;
        ProspectSupport prospectSupport;
        ItemEntity stairDrop;
        double distanceLeft;
        int workSlot, executions, handLoss, stairStock;
        int foodSwings, foodPickup;
        final boolean ediblePickup;
        Vec3d foodLastSeen;
        Item tracked;
        FurnaceWork furnace;
        PendingCollection pendingCollection;
        boolean waterUseEntered, waterUseReceipt, workshopFaceLost;

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
            ediblePickup = offer.drop != null && AgentProgress.ordinaryFood(offer.drop.getStack());
            this.keepVisible = keepVisible;
            pathYaw = offer.floor == null ? yaw : heading(offer.floor.landing.x - position.x, offer.floor.landing.z - position.z);
            pathPitch = Float.isNaN(chosenWalkPitch) ? MathHelper.clamp(pitch, 12, 42) : chosenWalkPitch;
            if (offer.floor != null) distanceLeft = horizontalSquared(position, offer.floor.landing);
            if (offer.route != null) distanceLeft = horizontalSquared(position, Vec3d.ofBottomCenter(offer.route.endpoint()));
            walkInventory = offer.key.verb == Verb.APPROACH || offer.key.verb == Verb.FOLLOW || offer.drop != null
                ? new InventoryWitness(client.player.getInventory()) : null;
            walkMotion = offer.key.verb == Verb.APPROACH || offer.key.verb == Verb.COLLECT
                ? new AgentWalkedRoute.Motion() : null;
            if (walkMotion != null) walkMotion.start(position.x, position.y, position.z);
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

    private enum FurnacePhase { LOADING, LOADED, BURNING, WATCHING, REOPENING, COLLECTING, RETURNING }
    // Travel, useful ore, an unproved ground bearing, then a bucket source. A bench is not a cave lead.
    enum FurnaceCue { DRY_FOOTHOLD, MATERIAL, OPENING, WATER, WORKBENCH }
    record FurnaceLook(FurnaceCue kind, BlockHitResult hit) {
        static FurnaceLook prefer(FurnaceLook fresh, FurnaceLook earlier) {
            return fresh == null || earlier != null && earlier.kind.compareTo(fresh.kind) < 0 ? earlier : fresh;
        }

        float lookYaw(Vec3d eye) {
            return heading(hit.getPos().x - eye.x, hit.getPos().z - eye.z);
        }

        float lookPitch(Vec3d eye) {
            if (kind == FurnaceCue.DRY_FOOTHOLD || kind == FurnaceCue.OPENING) return 38;
            Vec3d point = hit.getPos();
            return (float) Math.toDegrees(Math.atan2(eye.y - point.y, Math.hypot(point.x - eye.x, point.z - eye.z)));
        }
    }
    private record FurnaceFact(FurnaceLook look, Vec3d stance, long tick, String detail, boolean rechecked) {}
    private record PendingRecheck(int output, int fuel, boolean lit) {}

    private static final class PendingCollection {
        final AgentPendingFurnaceMemory.Entry entry;
        final AgentFurnaceWatch.PendingResult result;
        final AgentFurnaceWatch.Withdrawal withdrawal = new AgentFurnaceWatch.Withdrawal();
        final InventoryWitness returnInventory;
        AgentSurfaceTread tread;
        BlockPos footing;
        BlockHitResult face;
        Vec3d stance;
        long storedAt;
        int walked;
        boolean stopAtTread;

        PendingCollection(AgentPendingFurnaceMemory.Entry entry, PlayerInventory inventory, PendingRecheck last) {
            this.entry = entry;
            // Vanilla sync ids are connection-local and may recur in a historical continuation.
            result = new AgentFurnaceWatch.PendingResult(entry.historical() ? -1 : entry.syncId(),
                last == null ? entry.minimumOutput() : last.output, last == null ? entry.maximumFuel() : last.fuel);
            returnInventory = new InventoryWitness(inventory);
        }
    }

    private static final class FurnaceWork {
        final BlockPos footing;
        FurnacePhase phase;
        AgentHands.IronBatch batch;
        long openedTick, outputWitness, advancedTick, burnTick, storedTick;
        long closedFrame, watchFrame, cueFromFrame, cueUntil, reacquireUntil, releaseTick;
        int output, fuelRemaining, returnedStock, syncId, binding;
        float progress;
        boolean contactEntered, contactObserved, turningBack;
        BlockHitResult contact;
        FurnaceLook cue, scene;
        Camera cueAim;
        AgentFurnaceWatch.Stock before, paid;
        AgentFurnaceWatch watch;

        FurnaceWork(BlockPos footing) { this.footing = footing; }
    }

    private static final class IronWorkshop {
        final List<Face> supports = new ArrayList<>(WORKSHOP_SUPPORTS);
        final Set<BlockPos> refusedHere = new HashSet<>();
        BlockPos foot, placedTable;
        Face table, tableSite, furnaceSite, recipeSupport, aiming, alternateGuide;
        Floor alternate;
        BlockHitResult alternateTop;
        long scanStarted, aimUntil, openingUntil, alternateUntil;
        float scanYaw;
        boolean walked, furnaceCrafted;

        IronWorkshop(BlockPos foot) { this.foot = foot; }

        void arrived(BlockPos landing) {
            foot = landing;
            supports.clear();
            refusedHere.clear();
            tableSite = furnaceSite = recipeSupport = aiming = null;
            scanStarted = 0;
        }
    }

    private static final class WorkSession {
        AgentWorkOrder order;
        final AgentWorkOrder.Budget budget;
        final SourceSearch sourceSearch;
        final Set<BlockPos> rejected = new HashSet<>();
        final Map<Integer, PickupDeferral> deferredDrops = new HashMap<>();
        final Set<BlockPos> horizonAttempts = new HashSet<>();
        final Set<BlockPos> caveSurveys = new HashSet<>();
        long deadline;
        BlockPos lastHarvest;
        long lastHarvestTick;
        Item lastHarvestItem;
        TimberSight timberLook;
        long timberLookUntil, timberLookFrame;
        boolean timberLookUsed;
        TimberObstruction admittedTimberOpening;
        TimberPursuit timberRecheck;
        Face timberClosing;
        Face sourceLook;
        long sourceLookUntil;
        long lastEffectTick, completedTick;
        long recoveryProof;
        String lastEffect;
        BlockPos placedFurnace;
        boolean collectedIron;
        boolean refusedPendingReplacement;
        boolean travelAnchorUsed;
        boolean horizonPulseSpent;
        Face harvestOpening;
        SurfaceOpening surfaceOpening;
        BlockPos ironSceneFooting;
        FurnaceLook ironScene;
        Offer waterClue;
        Offer foodClue;
        boolean foodStarted;
        IronWorkshop ironWorkshop;
        String sourceBlock;
        boolean lowerHarvest;
        int confirmedBreaks, confirmedCrafts, confirmedPlacements, startingStock, startingDeepTreads, horizonLegs;
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

    private record DiamondSpine(AgentSurfaceTread.Edge edge, Direction preferred, int refusedDown,
                                int refusedLevel, int refusedUp, boolean glanced, boolean triedSpareFloor,
                                String refusal, String levelRefusal, DiamondGrantRefusals grantRefusals) {}

    /** The exact effect that an otherwise witnessed option could not spend. Not a retained face or an actuator. */
    private static final class DiamondGrantRefusal {
        final BlockPos cell;
        final BlockState state;
        final Item placement; // null for a cover break
        String detail;

        DiamondGrantRefusal(BlockPos cell, BlockState state, Item placement, String detail) {
            this.cell = cell.toImmutable();
            this.state = state;
            this.placement = placement;
            this.detail = detail;
        }

        static String cover(AgentWorkOrder.Budget budget, BlockState state) {
            if (!budget.policy.prospectCoverAllowed(state))
                return "The selected passage exposes " + Registries.BLOCK.getId(state.getBlock())
                    + "; the current grant does not allow clearing it.";
            if (!budget.canBreak()) return "The authorized break grant is spent.";
            if (!budget.canCutCover())
                return "Keep the last break for diamond ore; cutting witnessed " + Registries.BLOCK.getId(state.getBlock())
                    + " needs a new grant.";
            return null;
        }

        static String placement(AgentWorkOrder.Budget budget, Item item, PlayerInventory inventory) {
            if (item == Items.TORCH)
                return budget.canPlaceProspectTorch(inventory) ? null
                    : "The tread is too dark. Lighting needs place:minecraft:torch, a placement and torch cost left, and carried light above its floor.";
            if (!budget.policy.placeProspectSupport())
                return "The rendered landing ray found no full supporting top. No attached support is authorized; that needs place:minecraft:cobblestone.";
            return budget.canPlaceProspectSupport(inventory) ? null
                : "The rendered landing ray found no full supporting top. An attached support needs a usable placement and carried cobblestone above its reserve and within its exact cost.";
        }
    }

    private static final class DiamondGrantRefusals {
        private static final int DIRECTIONS = Direction.values().length;
        final DiamondGrantRefusal[] lanes = new DiamondGrantRefusal[3 * DIRECTIONS];
        AgentWorkOrder.Budget pricedAgainst;

        static int lane(Direction bearing, int grade) {
            return (Integer.signum(grade) + 1) * DIRECTIONS + bearing.ordinal();
        }
    }

    /** One positively observed build candidate. No input or stock is owned outside its work action. */
    static final class ProspectSupport {
        enum View { REFUSED, ALIGN, READY }

        final BlockPos from, to, cell;
        final Direction bearing;
        final Vec3d low, high, floor, alternateFloor;
        Face anchor;
        long contactUntil, issuedAt, issuedFrame = -1;
        int countBefore;
        boolean steered, seekingContact;

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

        String sampleDetail(AgentBody.FootholdSpace low, AgentBody.FootholdSpace high) {
            return " Support cell " + bearing + " at Y offset " + (cell.getY() - from.getY())
                + " from feet: low=" + low + ", high=" + high + ".";
        }

        static boolean couldFrameAir(AgentBody.FootholdSpace sample) {
            return sample == AgentBody.FootholdSpace.EMPTY || sample == AgentBody.FootholdSpace.VIEW;
        }

        void pin(BlockHitResult hit, BlockState state, long tick) {
            anchor = new Face(hit, state);
            contactUntil = tick + 20;
        }

        View view(AgentBody.FootholdSpace low, AgentBody.FootholdSpace high, boolean centered) {
            if (anchor == null || !couldFrameAir(low) || !couldFrameAir(high)) return View.REFUSED;
            if (low == AgentBody.FootholdSpace.EMPTY && high == AgentBody.FootholdSpace.EMPTY) return View.READY;
            return centered || seekingContact ? View.REFUSED : View.ALIGN;
        }

        void issued(long tick, long frame, int stock, AgentWorkOrder.Budget budget) {
            issuedAt = tick;
            issuedFrame = frame;
            countBefore = stock;
            budget.placedProspectSupport();
        }

        boolean confirms(long frame, BlockHitResult top, BlockState material, int stock) {
            return issuedFrame >= 0 && frame > issuedFrame && AgentBody.matchesDryRouteTop(top, cell)
                && material.isOf(Blocks.COBBLESTONE) && stock == countBefore - 1;
        }
    }

    static final class DiamondRoute {
        private static final int DEPARTURE_TICKS = 24;
        private static final int CUT_INSET_TICKS = 8;
        private static final int DIAMOND_LAYER_TOP = 16;
        final Set<BlockPos> supports = new HashSet<>();
        final Set<BlockPos> attemptedSupports = new HashSet<>();
        final Set<BlockPos> placedSupports = new HashSet<>();
        final Set<BlockPos> attemptedSpareFloors = new HashSet<>();
        final ArrayDeque<DiamondSpine> spine = new ArrayDeque<>();
        BlockPos foot, unjoined;
        AgentSurfaceTread.Edge failedReturn, rootExit;
        Direction preferred, bearing, spareExit;
        BlockState support;
        BlockState[] levelFloorStates;
        Vec3d lookPoint;
        int grade, refusedDown, refusedLevel, refusedUp, levelFloors, levelGaps, shelves, rises, treads, levelLegs, supportedLandings, lowest;
        long lookUntil, departureUntil, departureShiftFrame, cutInsetUntil;
        float departureYaw;
        boolean glanced, cutting, tunnel, stairLip, triedSpareFloor, spareFloor, spareFloorBroken;
        boolean departing, departureTried, rayRetryUsed, freshRaysPending;
        String refusal, levelRefusal, supportRefusal;
        private DiamondGrantRefusals grantRefusals;

        void arrive(BlockPos at, BlockState groundedSupport, Direction heading) {
            if (at.equals(foot) && groundedSupport == support) {
                // A new policy is not new terrain. Preserve refusals and the used look at this stance.
                lookPoint = null;
                departing = false;
                return;
            }
            if (foot == null) lowest = at.getY();
            foot = at.toImmutable();
            support = groundedSupport;
            supports.add(foot.down());
            preferred = bearing = heading;
            grade = -1;
            refusedDown = refusedLevel = refusedUp = levelFloors = levelGaps = 0;
            levelFloorStates = null;
            lookPoint = null;
            departing = false;
            spareExit = null;
            departureShiftFrame = -1;
            cutInsetUntil = 0;
            departureTried = rayRetryUsed = freshRaysPending = false;
            glanced = cutting = tunnel = stairLip = triedSpareFloor = spareFloor = spareFloorBroken = false;
            refusal = levelRefusal = supportRefusal = null;
            grantRefusals = null;
        }

        boolean open(Direction direction, int grade) {
            int refused = grade < 0 ? refusedDown : grade > 0 ? refusedUp : refusedLevel;
            return (refused & directionBit(direction)) == 0
                && (grantRefusals == null || grantRefusals.lanes[DiamondGrantRefusals.lane(direction, grade)] == null);
        }

        boolean rollingDepartureAllowed() {
            return unjoined == null && !cutting && !tunnel && !spareFloor && !departing;
        }

        boolean arriveFromHorizon(BlockPos landing, BlockState confirmedSupport, Direction heading) {
            if (confirmedSupport == null || !rollingDepartureAllowed()) return false;
            // A rolling approach is a new local root, not an attested reverse edge.
            // In particular, neither a diagonal leg nor a wade can join the old spine.
            spine.clear();
            rootExit = null;
            arrive(landing, confirmedSupport, heading);
            lowest = Math.min(lowest, landing.getY());
            return true;
        }

        Direction naturalBearing(AgentDryCaveRoute.Offer offer, Predicate<BlockPos> unavailableSupport) {
            if (offer == null || !offer.from().equals(foot) || offer.edges() < 1) return null;
            var direction = Direction.fromHorizontalDegrees(heading(
                offer.next().getX() - foot.getX(), offer.next().getZ() - foot.getZ()));
            int height = offer.heightChange();
            if (!AgentSurfaceTread.cardinalTread(foot, offer.next(), direction)
                    || !offer.next().equals(foot.offset(direction).up(height)) || height != 0 && offer.edges() != 1
                    || !open(direction, height)
                    || cutting && (direction != bearing || height != grade) && !(tunnel && height < 0)
                    || !offer.endpoint().equals(foot.offset(direction, offer.edges()).up(height))) return null;
            for (int i = 1; i <= offer.edges(); ++i) {
                BlockPos floor = foot.offset(direction, i).up(height - 1);
                if (supports.contains(floor) || unavailableSupport.test(floor)) return null;
            }
            return direction;
        }

        void select(Direction direction, int grade, boolean excavation) {
            if (direction != bearing || grade != this.grade) tunnel = false;
            bearing = direction;
            this.grade = grade;
            cutting = excavation;
            stairLip = false;
            departing = false;
        }

        boolean wantsForwardStair(boolean visibleOre) {
            return cutting && tunnel && grade == 0 && foot.getY() > DIAMOND_LAYER_TOP
                && !visibleOre && open(bearing, -1) && (rootExit != null || !spine.isEmpty());
        }

        void selectSpareFloor(Direction direction, Direction exit) {
            select(direction, -1, true);
            spareExit = exit;
            triedSpareFloor = spareFloor = true;
        }

        boolean spareFloorCoverCurrent(Direction direction, BlockState current, AgentWorkOrder.Budget budget) {
            return levelFloorStates != null && levelFloorStates[direction.ordinal()] == current
                && budget.canCutCover() && budget.policy.prospectCoverAllowed(current);
        }

        boolean witnessedGradeTread(AgentBody.DryRouteTop top, boolean passage, boolean reverse) {
            return grade != 0 && (!spareFloor || spareFloorBroken) && top == AgentBody.DryRouteTop.WITNESSED
                && passage && reverse;
        }

        boolean cutCell(BlockPos cell) {
            if (!cutting || supports.contains(cell)) return false;
            if (spareFloor) return !spareFloorBroken && cell.equals(AgentSurfaceTread.nextFoot(foot, bearing));
            if (attemptedSpareFloors.contains(cell)) return false;
            if (stairLip && cell.equals(foot.offset(bearing).up(2))) return true;
            return grade == 0 ? AgentSurfaceTread.prospectLevelCell(foot, cell, bearing)
                : AgentSurfaceTread.prospectCell(foot, cell, bearing);
        }

        void coverOpened() {
            if (spareFloor) spareFloorBroken = true;
            else tunnel = true;
            // A real floor or lintel break exposes new evidence. One look at that
            // opening is not a new survey of the old stance.
            if (spareFloor || stairLip) {
                glanced = rayRetryUsed = false;
                stairLip = false;
            }
        }

        boolean cutInsetCurrent(long tick) {
            if (cutInsetUntil == 0) cutInsetUntil = tick + CUT_INSET_TICKS;
            return tick < cutInsetUntil;
        }

        boolean beginDeparture(BlockHitResult witness, long tick) {
            if (departureTried || glanced || !spine.isEmpty()) return false;
            departing = departureTried = glanced = true;
            preferred = departureBearing(foot, witness);
            Vec3d point = witness.getPos();
            departureYaw = heading(point.x - foot.getX() - 0.5, point.z - foot.getZ() - 0.5);
            departureUntil = tick + DEPARTURE_TICKS;
            return true;
        }

        void refuseCurrent(String detail) {
            if (spareFloor && spareFloorBroken) refuse(bearing, 0, detail);
            refuse(bearing, grade, detail);
            releaseRefusedSelection();
        }

        private void releaseRefusedSelection() {
            spareFloor = spareFloorBroken = false;
            spareExit = null;
            lookPoint = null;
            cutting = tunnel = stairLip = false;
        }

        void refuse(Direction direction, int grade, String detail) {
            if (grantRefusals != null) grantRefusals.lanes[DiamondGrantRefusals.lane(direction, grade)] = null;
            if (grade == 0) {
                refusedLevel |= directionBit(direction);
                levelRefusal = detail;
            } else {
                if (grade < 0) refusedDown |= directionBit(direction);
                else refusedUp |= directionBit(direction);
                if (refusal == null || detail.contains("minecraft:") && !refusal.contains("minecraft:")) refusal = detail;
            }
        }

        String cutGrantRefusal(AgentWorkOrder.Budget budget, BlockPos cell, BlockState state) {
            String detail = DiamondGrantRefusal.cover(budget, state);
            return detail == null ? null : refuseGrant(budget, cell, state, null, detail);
        }

        String placeGrantRefusal(AgentWorkOrder.Budget budget, BlockPos cell, BlockState state, Item item,
                                 PlayerInventory inventory) {
            String detail = DiamondGrantRefusal.placement(budget, item, inventory);
            return detail == null ? null : refuseGrant(budget, cell, state, item, detail);
        }

        private String refuseGrant(AgentWorkOrder.Budget budget, BlockPos cell, BlockState state, Item placement, String detail) {
            if (grantRefusals == null) grantRefusals = new DiamondGrantRefusals();
            grantRefusals.pricedAgainst = budget;
            grantRefusals.lanes[DiamondGrantRefusals.lane(bearing, grade)] = new DiamondGrantRefusal(cell, state, placement, detail);
            releaseRefusedSelection();
            return detail;
        }

        boolean needsGrantRecheck(AgentWorkOrder.Budget budget) {
            // Renewing time replaces the order ID, but the actuator still owns the same spent budget.
            return grantRefusals != null && grantRefusals.pricedAgainst != budget;
        }

        void recheckGrant(AgentWorkOrder.Budget budget, Function<BlockPos, BlockState> current, PlayerInventory inventory) {
            if (!needsGrantRecheck(budget)) return;
            grantRefusals.pricedAgainst = budget;
            boolean stillRefused = false;
            for (int height = -1; height <= 1; ++height) {
                for (Direction direction : CARDINAL) {
                    int lane = DiamondGrantRefusals.lane(direction, height);
                    var blocked = grantRefusals.lanes[lane];
                    if (blocked == null) continue;
                    String detail = blocked.placement == null ? DiamondGrantRefusal.cover(budget, blocked.state)
                        : DiamondGrantRefusal.placement(budget, blocked.placement, inventory);
                    if (detail != null) {
                        blocked.detail = detail;
                        stillRefused = true;
                    } else if (current.apply(blocked.cell) != blocked.state) {
                        refuse(direction, height, "The previously witnessed prospect cell changed; no cut or placement was admitted.");
                    } else {
                        // State equality only vetoes a changed cell. Normal route selection must witness
                        // a fresh face and prove dry stance, geometry, tooling and live costs again.
                        grantRefusals.lanes[lane] = null;
                    }
                }
            }
            if (!stillRefused) grantRefusals = null;
        }

        String grantRefusalDetail() {
            if (grantRefusals != null)
                for (var blocked : grantRefusals.lanes)
                    if (blocked != null) return " The current grant blocked a witnessed option: " + blocked.detail;
            return "";
        }

        Direction sector(int index) {
            return switch (index) {
                case 0 -> preferred;
                case 1 -> preferred.rotateYClockwise();
                case 2 -> preferred.rotateYCounterclockwise();
                default -> preferred.getOpposite();
            };
        }

        void advance(AgentSurfaceTread.Edge edge) {
            int height = edge.lower().getY() - edge.upper().getY();
            boolean floorTread = spareFloor && spareFloorBroken;
            boolean continueTunnel = (tunnel || floorTread) && edge.upper().equals(foot) && edge.upperSupport() == support
                && edge.down() == bearing && height == grade;
            spine.addLast(new DiamondSpine(edge, preferred, refusedDown, refusedLevel, refusedUp,
                glanced, triedSpareFloor, refusal, levelRefusal, grantRefusals));
            arrive(edge.lower(), edge.lowerSupport(), edge.down());
            if (continueTunnel) {
                // The next forward column starts with its two level wall/head cells,
                // not an unobserved lower floor. Switch grade only for its own tread.
                grade = floorTread ? 0 : height;
                cutting = tunnel = true;
            }
            departureTried = true;
        }

        void interruptedAt(BlockPos from, AgentSurfaceTread.Edge failedReturn) {
            unjoined = from;
            this.failedReturn = failedReturn;
            cutting = tunnel = false;
        }

        boolean reanchor(BlockPos at, BlockState exactSupport, Direction heading, List<AgentSurfaceTread.Edge> walked,
                         Predicate<AgentSurfaceTread.Edge> current, Predicate<AgentSurfaceTread.Edge> liveReverse) {
            if (unjoined == null || exactSupport == null || walked.isEmpty()) return false;
            var escape = walked.getLast();
            if (!escape.lower().equals(at) || escape.lowerSupport() != exactSupport
                    || !current.test(escape) || !liveReverse.test(escape)) return false;

            // Only a contiguous, still dry suffix of separately completed locomotion can join an old intersection.
            Map<BlockPos, Integer> reached = new HashMap<>();
            reached.put(at, walked.size());
            BlockPos cursor = at;
            BlockState floor = exactSupport;
            for (int i = walked.size() - 1; i >= 0; i--) {
                var leg = walked.get(i);
                if (!leg.lower().equals(cursor) || leg.lowerSupport() != floor
                        || i != walked.size() - 1 && !current.test(leg)) break;
                reached.putIfAbsent(leg.upper(), i);
                cursor = leg.upper();
                floor = leg.upperSupport();
            }
            int keep = -1, join = -1;
            if (rootExit == null || current.test(rootExit)) {
                var first = spine.peekFirst();
                join = currentIntersection(reached, walked, at, exactSupport,
                    first == null ? foot : first.edge.upper(), first == null ? support : first.edge.upperSupport());
                if (join >= 0 && (join != walked.size() || rootExit == null || liveReverse.test(rootExit))) keep = 0;
                else join = -1;
                int prefix = 0;
                for (var branch : spine) {
                    var edge = branch.edge;
                    if (edge == failedReturn || !current.test(edge)) break;
                    ++prefix;
                    int candidate = currentIntersection(reached, walked, at, exactSupport, edge.lower(), edge.lowerSupport());
                    if (candidate > join && (candidate != walked.size() || liveReverse.test(edge))) {
                        keep = prefix;
                        join = candidate;
                    }
                }
            }
            if (keep < 0) {
                spine.clear();
                rootExit = escape;
                supports.add(escape.upper().down());
                arrive(at, exactSupport, heading);
            } else {
                while (spine.size() > keep) returnOne();
                for (int i = join; i < walked.size(); i++) advance(walked.get(i));
                if (spine.isEmpty() && rootExit == null) {
                    rootExit = escape;
                    supports.add(escape.upper().down());
                }
            }
            lowest = Math.min(lowest, at.getY());
            unjoined = null;
            failedReturn = null;
            return true;
        }

        private static int currentIntersection(Map<BlockPos, Integer> reached, List<AgentSurfaceTread.Edge> walked,
                                               BlockPos at, BlockState exactSupport, BlockPos point, BlockState support) {
            Integer index = reached.get(point);
            if (index == null) return -1;
            BlockState witnessed = point.equals(at) ? exactSupport : walked.get(index).upperSupport();
            return witnessed == support ? index : -1;
        }

        void returnOne() {
            var branch = spine.removeLast();
            arrive(branch.edge.upper(), branch.edge.upperSupport(), branch.preferred);
            departureTried = true;
            refusedDown = branch.refusedDown;
            refusedLevel = branch.refusedLevel;
            refusedUp = branch.refusedUp;
            glanced = branch.glanced;
            triedSpareFloor = branch.triedSpareFloor;
            refusal = branch.refusal;
            levelRefusal = branch.levelRefusal;
            grantRefusals = branch.grantRefusals;
        }
    }

    private final String run, goal;
    private final AgentPendingFurnaceMemory pendingFurnaceMemory;
    private final AgentWalkedRoute walkedRoutes = new AgentWalkedRoute();
    private final Consumer<AgentSurfaceTread.Edge> diamondCrossing = this::recordNaturalDiamondCrossing;
    private final Ipc ipc;
    private final boolean activated, trial;
    private final LinkedHashMap<Long, Snapshot> snapshots = new LinkedHashMap<>();
    private final LinkedHashMap<Key, String> ids = new LinkedHashMap<>();
    private final Map<Key, String> materialTargets = new HashMap<>();
    private final LinkedHashMap<String, Boolean> consumed = new LinkedHashMap<>();
    private final Set<Key> retiredViews = new HashSet<>();
    private final Set<BlockPos> localSteps = new HashSet<>();
    private final LinkedHashMap<BlockPos, TimberSight> timberSights = new LinkedHashMap<>();
    private final Map<BlockPos, BlockPos> timberOpeningAttempts = new HashMap<>();
    private final long[] horizonCandidateCells = new long[HORIZON_CANDIDATES];
    private final ArrayDeque<String> recent = new ArrayDeque<>(8);
    private final AgentSurveyEvidence surveyEvidence = new AgentSurveyEvidence();
    private static final int MAX_PROSPECT_WALL_TRANSITIONS = 32;
    private String prospectWallRefusal;
    private boolean prospectWallSampled;
    private String lastWallStage, lastWallResult, lastWallRefusal;
    private int lastWallLife, lastWallStance, lastWallVisual, wallTransitions;
    private boolean lastWallPressure, lastWallApproach, lastWallRetained;
    private long wallTransitionTick;
    private JsonObject wallTransition;
    private record ProspectLandmark(BlockPos foot, BlockHitResult hit, long at, BlockState approachSupport) {
        boolean from(BlockPos source, long now) {
            return foot.equals(source) && now >= at && now - at <= STATION_RECALL_TICKS;
        }
    }
    private record ProspectWall(BlockHitResult hit, BlockState state, Direction bearing, int toolSlot) {}
    private ProspectLandmark prospectLandmark;
    private FurnaceFact furnaceFact;
    private final Predicate<ItemStack> safetySpend = this::canSpendSafetyStock;
    private final Predicate<ItemEntity> stockPickupFooting = drop -> !dropInProspectOpening(drop) && roomFor(drop.getStack());
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
    private final IntPredicate prospectEquip = slot -> hands.canEquipSlot(player.getInventory(), slot);
    private ItemStack scopedMainHand = ItemStack.EMPTY;
    private Vec3d anchor, idlePublishedPos;
    private float surveyYaw;
    private float idlePublishedYaw, idlePublishedPitch, idlePublishedHealth;
    private int idlePublishedFood;
    private long lastPublishedEpoch;
    private long tick, epoch, nextId, nextMaterialId, lastObservation, inventoryStamp, safetyRevision;
    private long fallbackTicks;
    private long fallbackActions, blockedCount, urgentCount, lastPurposefulTick;
    private long now, idleSince, waitElapsed, waitTotal, waitMaximum, waitOvershoot, nextLocalProbe;
    private long rawNoWorkSince, rawNoWorkMax, rawNoWorkTotal, planningNoticeTick, planningNoticeNanos;
    private int life, surveyOrigin;
    private Inbox input;
    private Action action;
    private WorkSession work;
    private WorkSession pendingOrigin;
    private Face pendingFace;
    private AgentFurnaceWatch pendingEstimate;
    private PendingRecheck pendingRecheck;
    private long pendingRecheckedUntil;
    private boolean pendingBurnEnded;
    private UUID pendingRouteTicket;
    private long parkedViewAfterFrame = -1;
    private boolean parkedViewPublished;
    private boolean pendingUncertain, pendingWorldRelease;
    private TimberHarvest timberHarvest;
    private TimberPursuit timberPursuit;
    private TimberObstruction timberReplan;
    private long timberReplanAt;
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
    private long surveyReleaseFrame = -1;
    private final Set<String> scoutedLandmarks = new HashSet<>();
    private final Set<BlockPos> scoutDepartures = new HashSet<>();
    private final Set<Key> attemptedDryLandings = new HashSet<>();
    private final Map<BlockPos, Integer> inspectedVantageSectors = new HashMap<>();
    private String lastDryLandingEvidence;
    private AgentBody.GroundSight lastGroundSight;
    private int lastDryLandingStance;
    private boolean firstOutlookPending, startupInputsClear;
    private boolean suspended, visited, owned, hazardClear, lastHazard, quiescent, urgent, blocked, deadlineMeasured;
    private boolean urgentInput;
    private boolean rawPending, rawWorking;
    private String planningState = "awaiting_plan", planningEvidence = "No provider decision is pending.";
    private String activePlanningId, lastPurposefulAction, lastUrgency, blockedReason, localHoldReason;
    private boolean trialUsed, revocationSeen, revocationAcknowledged;
    private String owner = "deterministic";
    private String status = "waiting for a current local plan";

    static AgentMacroControl create(Path directory, String goal, AgentPendingFurnaceMemory pendingFurnaceMemory) {
        Path macro = directory.resolve("macro");
        String run = directory.getFileName().toString();
        // Startup-only admission. Inactive deterministic runs allocate no channel or thread.
        if (!TOKEN.matcher(run).matches()) return null;
        boolean trial = Ipc.marked(macro, run, "trial.json");
        String marker = Ipc.activeMode(macro, run);
        return trial || marker != null ? new AgentMacroControl(macro, run, goal, marker, trial, pendingFurnaceMemory) : null;
    }

    private AgentMacroControl(Path directory, String run, String goal, String mode, boolean trial,
                              AgentPendingFurnaceMemory pendingFurnaceMemory) {
        this.run = run;
        this.goal = goal;
        this.pendingFurnaceMemory = pendingFurnaceMemory;
        this.activated = mode != null;
        this.trial = trial;
        firstOutlookPending = !trial && "constrained".equals(mode);
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
            if (this.life != 0) {
                firstOutlookPending = false;
                invalidatePending("The player life, connection or dimension changed.");
            }
            interrupt("The player life or dimension changed.", false);
            retireWork("needs_replan", "interrupted", "The player life or dimension changed.");
            work = null;
            waterReceiptUntil = 0;
            timberSights.clear();
            timberHarvest = null;
            timberPursuit = null;
            timberReplan = null;
            timberOpeningAttempts.clear();
            personalTable = personalFurnace = null;
            furnaceFact = null;
            prospectLandmark = null;
            stationPlacement = null;
            timberFrame = -1;
            surfaceSearch = new SourceSearch();
            diamondRoute = new DiamondRoute();
            this.life = life;
            world = client.world;
            player = client.player;
            walkedRoutes.clear();
            pendingRouteTicket = null;
            if (!trial && ipc.workMode != null) {
                body.trackWalkedRoutes(walkedRoutes);
                attachPendingRoute(pendingEntry());
            }
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
            surveyReleaseFrame = -1;
            scoutedLandmarks.clear();
            scoutDepartures.clear();
            attemptedDryLandings.clear();
            inspectedVantageSectors.clear();
            lastDryLandingEvidence = null;
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
        if (walkedRoutes.recovery().observing()) {
            BlockPos foot = player.getBlockPos();
            walkedRoutes.recovery().observe(foot, diamondRecoverySupport(foot), player.getPos());
        }
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
        return (work == null || work.budget.floors.isEmpty()) && pendingFloors().isEmpty() ? null : safetySpend;
    }

    private boolean canSpendSafetyStock(ItemStack stack) {
        if (stack.isEmpty()) return true;
        Item item = stack.getItem();
        int floor = Math.max(work == null ? 0 : work.budget.floor(item), pendingFloors().getOrDefault(item, 0));
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
    JsonObject takeSurveyTransition(long tick) { return surveyEvidence.take(tick); }
    JsonObject takeProspectWallTransition(long tick) {
        if (wallTransitionTick != tick) return null;
        JsonObject result = wallTransition;
        wallTransition = null;
        return result;
    }

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

    void observeFoodPickup(AgentProgress progress) {
        if (action == null || action.foodPickup != 0 || !engaged()) return;
        if (action.offer.key.verb == Verb.WORK_FORAGE && action.fired) {
            // Vanilla can collect an item at the player's feet before another
            // render. Record the carried delta, not a witnessed drop or yield.
            int carried = count(action.offer.item), gain = carried - action.itemCount;
            if (gain > 0 && action.walkInventory.gain(player.getInventory(), action.offer.item) == null) {
                action.foodPickup = gain;
                remember("Food stock: +" + gain + " " + Registries.ITEM.getId(action.offer.item)
                    + "; " + carried + " carried before any later eating. No exact drop pickup was witnessed.");
            }
            return;
        }
        if (!action.ediblePickup || unexpectedPickup() != null) return;
        int carried = count(action.offer.item);
        int gain = AgentFoodWork.pickupGain(action.itemCount, carried, action.offer.drop.isRemoved(),
            action.durable && fungibleStockPickup());
        if (gain == 0) return;
        action.foodPickup = gain;
        progress.confirmMacroFoodPickup(gain);
        remember("Food pickup: +" + gain + " " + Registries.ITEM.getId(action.offer.item)
            + "; " + carried + " carried at confirmation, before any later eating.");
    }

    /** Called only after the existing fall, danger and emergency food controllers declined ownership. */
    void control(AgentProgress progress) {
        visited = true;
        hazardClear = !body.lavaEmergency() && !body.macroLavaNear()
            && !client.player.isOnFire() && !client.player.isInLava() && client.player.hurtTime == 0;

        if (firstOutlookPending || lastObservation == 0 && "constrained".equals(ipc.workMode))
            startupInputsClear = body.keysNeutral() && !hands.busy() && !hands.holdsWorkInventory();
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
        if (pendingEntry() != null && !AgentClient.ownsSinglePlayerFurnaceWorld(client, player))
            invalidatePending("Actor-only furnace access no longer holds.");
        // An accepted direct intent owns the input path even when its tick is
        // neutral (e.g. one missing route render). No work-order branch may steal it.
        if (!trial && ipc.workMode != null && (action == null || action.intent == null || action.durable)) {
            if (!tryDeferPending()) reconcileWork(progress);
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
            int maxTicks = action.offer.scout != null ? action.offer.scout.rise != null
                ? AgentSurfaceTread.ORDINARY_GRADE_TICKS + 6 : GROUND_SCOUT_TICKS
                : STARTUP_OUTLOOK.equals(action.offer.key.activity) ? STARTUP_OUTLOOK_TICKS : action.offer.key.verb.maxTicks;
            if (!local && (input.intent == null || !input.intent.equals(action.intent))) {
                interrupt("The host withdrew or replaced this intent.", true);
            } else if ((local ? now - action.startedAt >= PLANNING_IDLE_LIMIT_NS : tick > action.intent.expires)
                    || tick - action.started > maxTicks) {
                interrupt(timeoutDetail(), true);
            } else if (action.offer.route != null && (action.intent.epoch != epoch || !cursorClear())) {
                interrupt("The dry route's dependency epoch or clean-cursor premise changed.", true);
            } else if ((!grounded() && !progress.dryRouteInFlight(action.offer.route) && !pendingReturnInFlight()
                    && !scoutGradeInFlight())
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
        String refusal = !available() || offer.key.verb == Verb.SURVEY && !stationaryWorldControls()
            ? "No neutral, grounded, safe first-person view." :
            trial && (trialUsed || !diagnosticVerb(offer.key.verb)) ? "The diagnostic admits one isolated reader action."
            : (STARTUP_OUTLOOK.equals(offer.key.activity) || SURFACE_OUTLOOK.equals(offer.key.activity)) && intent.skillHash != null
                ? "Only a direct model instruction may frame this outlook."
            : offer.key.verb == Verb.COLLECT_PENDING && (intent.skillHash != null || tick - intent.basis >= MAX_WORK_ADMISSION_AGE)
                ? "Collection requires a fresh, direct instruction for the exact pending ticket."
            : SURFACE_CAP.equals(offer.key.activity) && intent.skillHash != null ? "A generated skill cannot cut cover."
            : (offer.route != null || offer.drySurvey != null) && intent.skillHash != null
                ? "Only a direct Terra intent may survey or follow this dry route."
            : !trial && intent.skillHash != null && offer.key.verb == Verb.APPROACH
                ? "Reusable skills cannot approach while incidental pickup remains possible."
            : offer.scout == null ? validate(offer, progress) : null;
        AgentVisibleHorizon.Window scoutWindow = null;
        if (refusal == null && offer.scout != null) {
            var scout = offer.scout;
            if (scout.rise != null) {
                if (!groundScoutStance(scout) || !recheckScoutRise(scout))
                    refusal = "The exact upper top, dry source alignment, no-damage jump clearance, or protected stock changed.";
            } else if (scout.vantage != null) {
                if (!groundScoutStance(scout) || groundScoutFace(scout.face) == null || !body.groundsVantage(scout.vantage))
                    refusal = "The same dry supporting top, sightline, or shifted stopping point no longer revalidates.";
            } else if (scout.landing == null) {
                scoutWindow = currentGroundScout(scout);
                if (scoutWindow == null) refusal = "The exact landmark, neutral stance, protected stock, or dry stopping lane changed.";
            } else if (!groundScoutStance(scout) || !body.dryLandingSeen(scout.landing) || !body.dryLandingClear(scout.landing)
                    || !body.macroNoVisiblePickup(scout.goal, scout.landing.to().getY(), scout.landing.source().getY())) {
                refusal = "The exact lit landing, dry drop clearance, protected stock, or departure stance changed.";
            }
        }
        if (refusal != null) {
            refuseUnseen(refusal);
            if (ipc.workMode == null || trial) idle(progress, thinking);
            else holdWork();
            return;
        }
        markConsumed(intent.id);
        firstOutlookPending = false;
        owner = "terra";
        if (offer.route != null || offer.drySurvey != null) routeOwner = progress;
        action = new Action(intent, offer, client, tick, now, body.renderedFrame(),
            offer.item == null ? 0 : count(offer.item), NO_ANCHORS, Float.NaN);
        if (offer.scout != null) {
            var scout = offer.scout;
            scoutedLandmarks.add(scout.anchor.target());
            if (scout.rise != null) {
                scoutDepartures.add(scout.rise.from());
                action.tread = AgentSurfaceTread.ordinaryGrade(scout.rise.edge(), scout.rise.from(), tick);
            } else if (scout.landing != null)
                attemptedDryLandings.add(dryLandingKey(scout.landing.source(), scout.landing.top().getBlockPos()));
            else if (scout.vantage != null) {
                var vantage = scout.vantage;
                int visited = (1 << vantage.sector()) | (1 << AgentGroundVantage.sector(vantage.support(), vantage.from()));
                inspectedVantageSectors.merge(vantage.support(), visited, (left, right) -> left | right);
            }
            else {
                scoutDepartures.add(BlockPos.ofFloored(scout.from));
                action.horizonTravel = AgentBody.HorizonTravel.groundScout(scoutWindow.target(), scout.goal, GROUND_SCOUT_ARRIVAL);
            }
        }
        if (offer.key.verb == Verb.COLLECT_PENDING) {
            action.pendingCollection = new PendingCollection(pendingEntry(), player.getInventory(), pendingRecheck);
            if (offer.face != null) {
                action.pendingCollection.footing = player.getBlockPos().down();
                action.pendingCollection.stance = player.getPos();
            }
        }
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
        if (action.horizonTravel != null) {
            if (!action.purposefulMotion && action.horizonTravel.moved()) {
                action.purposefulMotion = true;
                purposeful("terra: " + action.offer.summary);
            }
            return;
        }
        if (action.purposefulMotion || !action.drove) return;
        boolean witnessed;
        if (action.offer.route != null) {
            witnessed = horizontalSquared(action.position, player.getPos()) >= 0.16;
        } else if (action.offer.floor != null) {
            Vec3d destination = action.offer.floor.landing;
            witnessed = horizontalSquared(action.position, destination) - horizontalSquared(player.getPos(), destination) >= 0.16;
        } else return;
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

    private static boolean sameWorkGrant(AgentWorkOrder previous, AgentWorkOrder next) {
        return previous.policy().equals(next.policy()) && Objects.equals(previous.duringWaitFor(), next.duringWaitFor())
            && next.basis() >= previous.basis();
    }

    static boolean canRenewWork(AgentWorkOrder witnessed, AgentWorkOrder active, AgentWorkOrder next) {
        return witnessed != null && witnessed == active && sameWorkGrant(witnessed, next)
            && Objects.equals(witnessed.travelAnchor(), next.travelAnchor())
            && Objects.equals(witnessed.harvestAnchor(), next.harvestAnchor())
            && Objects.equals(witnessed.surfaceAnchor(), next.surfaceAnchor())
            && next.expires() > witnessed.expires() && !witnessed.policy().smeltIron() && !witnessed.policy().waterFill()
            && witnessed.policy().foodSource() == null;
    }

    private void reconcileWork(AgentProgress progress) {
        WorkMailbox mailbox = input.work;
        AgentWorkOrder next = mailbox.order;
        var ticket = pendingEntry();
        boolean paidMotor = ticket != null && hasActiveWorkOrder() && work == pendingOrigin;
        boolean wantsPark = paidMotor && next != null && !work.order.id().equals(next.id())
            && !consumed.containsKey(next.id());
        if (hasActiveWorkOrder()) {
            if (next != null && work.order.id().equals(next.id())) work.refusedPendingReplacement = false;
            String invalid = !mailbox.present && !work.refusedPendingReplacement ? "The host withdrew the work order."
                : !paidMotor && (work.budget.policy.smeltIron() || work.budget.policy.waterFill() || work.foodClue != null)
                    && (mailbox.order == null || !work.order.id().equals(mailbox.order.id()))
                    ? "The host replaced the exact source work order."
                : tick >= work.order.expires() || now >= work.deadline ? "The finite work horizon expired."
                : !hazardClear || work.order.safetyRevision() != safetyRevision ? "The safety premise changed."
                : null;
            if (invalid != null) {
                interrupt(invalid, true);
                retireWork("needs_replan", "interrupted", invalid);
                paidMotor = wantsPark = false;
            } else if (paidMotor && (next == null || !work.order.id().equals(next.id()))) {
                // A rejected candidate is not a withdrawal of the paid incumbent, even if its mailbox is cleared next.
                work.refusedPendingReplacement = true;
            }
        }
        // A mutable echo cannot expand the already accepted, immutable permission.
        boolean sameMailbox = next != null && work != null && work.order.id().equals(next.id());
        boolean candidate = next != null && !sameMailbox && !consumed.containsKey(next.id());
        Snapshot basis = candidate ? snapshots.get(next.basis()) : null;
        AgentWorkOrder witnessed = basis == null ? null : basis.activeWork;
        boolean compatible = canRenewWork(witnessed, hasActiveWorkOrder() ? work.order : null, next);
        boolean continuePersonal = false;
        boolean renewPersonal = false;
        if (personalCraft != null) {
            boolean finished = work.phase.equals("complete");
            if (!personalCraftCurrent() || finished && !confirmsWorkStock()) {
                releasePersonalCraft(true);
            } else {
                renewPersonal = compatible;
                continuePersonal = finished && next != null && next.id().equals(work.order.nextWorkId())
                    && next.basis() >= work.completedTick && !consumed.containsKey(next.id());
                // The host normally removes the completed mailbox before publishing its successor.
                if (!continuePersonal && !renewPersonal && !sameMailbox && (mailbox.present || !finished)) releasePersonalCraft(true);
            }
        }
        if (candidate) {
            updateScope(true);
            Offer water = next.policy() != null && next.policy().waterFill() && basis != null
                ? basis.offers.values().stream().filter(offer -> offer.key.verb == Verb.WATER_CLUE && offer.face != null)
                    .findFirst().orElse(null) : null;
            AgentFoodWork.Source foodSource = next.policy() == null ? null : next.policy().foodSource();
            Offer food = foodSource != null && basis != null
                ? basis.offers.values().stream().filter(offer -> offer.food != null && offer.food.source == foodSource)
                    .findFirst().orElse(null) : null;
            Face harvest = !compatible && next.policy() != null && next.harvestAnchor() != null && basis != null
                ? currentHarvestAnchor(next, basis, progress) : null;
            boolean timberStart = !compatible && next.travelAnchor() != null && basis != null
                && !next.travelAnchor().equals(basis.travelAnchor) && basis.timberObstruction != null
                && next.travelAnchor().equals(basis.timberObstruction.pursuit.anchor);
            TimberObstruction timberOpening = timberStart && next.policy() != null ? currentTimberOpening(next, basis, progress) : null;
            boolean samePolicy = work != null && sameWorkGrant(work.order, next);
            boolean independent = next.duringWaitFor() != null;
            boolean inFlight = action != null && (action.tread != null && !grounded()
                || action.offer.route != null && progress.dryRouteInFlight(action.offer.route));
            if (next.policy() == null) {
                if (continuePersonal) releasePersonalCraft(true);
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The work order contains an unsupported target or effect.");
            } else if (witnessed != null && sameWorkGrant(witnessed, next) && !compatible) {
                // A lease refresh arriving after retirement cannot start a fresh motor or budget.
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The witnessed ordinary work order can no longer be renewed.");
            } else if (next.life() != life || !compatible && next.epoch() != epoch || next.basis() > tick
                    || tick - next.basis() >= MAX_WORK_ADMISSION_AGE || tick >= next.expires()
                    || next.safetyRevision() != safetyRevision || basis == null || basis.epoch != next.epoch()
                    || next.policy().target().goal() != null && !next.policy().target().goal().equals(goal)) {
                if (continuePersonal) releasePersonalCraft(true);
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The work basis, preset goal, or safety premise changed.");
            } else if (timberStart ? timberOpening == null
                    : !compatible && next.travelAnchor() != null && !currentTravelAnchor(next, basis, progress)) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", timberStart ? "The exact timber obstruction or its price changed."
                    : "The exact visible approach or its braking window changed.");
            } else if (!compatible && next.harvestAnchor() != null && harvest == null) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The exact in-reach harvest face or its price changed.");
            } else if (!independent && (paidMotor || basis.releasedWait)) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "A released paid furnace requires a new work order tied to the exact ticket.");
            } else if (next.policy().waterFill() && water == null) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The work basis has no exact witnessed source water in reach.");
            } else if (foodSource != null && (!neutralWorkView() || food == null
                    || !foodClueCurrent(food, progress) || count(foodSource.item) >= next.policy().target().count()
                    || new AgentWorkOrder.Budget(next.policy()).missingFloor(player.getInventory()) != null)) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The exact local food source, ready controls, or protected stock changed.");
            } else if (next.policy().waterFill() && tick <= waterReceiptUntil) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The previous source-water use is still inside its receipt window.");
            } else if (next.policy().smeltIron() && (pendingEntry() != null || pendingOrigin != null)) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "One paid furnace obligation is still outstanding; no second batch is admitted.");
            } else if (hazardClear && (wantsPark || action == null || action.durable
                    && (compatible || !inFlight && (!action.diamondRoute || action.offer.key.verb == Verb.DRY_SURVEY)))) {
                boolean newDiamondBatch = samePolicy && next.policy().diamondProspecting() && !work.active()
                    && deepTreads() > work.startingDeepTreads;
                AgentWorkOrder.Budget budget = samePolicy && !newDiamondBatch ? work.budget
                    : new AgentWorkOrder.Budget(next.policy(), pendingFloors());
                SurfaceOpening surface = !compatible && next.surfaceAnchor() != null ? basis.surfaceOpening : null;
                if (!compatible && next.surfaceAnchor() != null
                        && (surface == null || !next.surfaceAnchor().equals(surface.anchor) || !neutralWorkView()
                            || surfaceOpeningSlot(surface, progress, budget, next.expires() - tick) < 0)) {
                    markConsumed(next.id());
                    receipt(next.id(), next.life(), "refused",
                        "The exact witnessed surface cap, tool price, stock reserves or staircase lease changed.");
                    return;
                }
                if (independent) {
                    String refusal = pendingWorkRefusal(next, basis, ticket, budget, wantsPark, compatible);
                    if (refusal == null && water != null && (wantsPark || !hasActiveWorkOrder())
                            && (!waterFooting(water.floor) || !body.waterFillWitness(water.face.hit, reach())
                                || !player.getOffHandStack().isEmpty() || !budget.canFillWater(player.getInventory())))
                        refusal = "The exact source-water contact, stance, carried bucket or protected reserves changed.";
                    if (refusal == null && wantsPark && !parkPending())
                        refusal = "The paid furnace could not be stored as a parked obligation.";
                    if (refusal == null && !journalPendingWork(next))
                        refusal = "No ordinary work was started because the admission could not be journaled.";
                    if (refusal != null) {
                        markConsumed(next.id());
                        receipt(next.id(), next.life(), "refused", refusal);
                        return;
                    }
                }
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
                    work = new WorkSession(next, budget, surfaceSearch, deadline);
                    timberReplan = null;
                    // A compatible renewal does not get to adopt a newer return receipt.
                    work.recoveryProof = walkedRoutes.recovery().proof();
                    work.waterClue = water;
                    work.foodClue = food;
                    work.harvestOpening = harvest;
                    work.surfaceOpening = surface;
                    work.admittedTimberOpening = timberOpening;
                    work.startingDeepTreads = deepTreads();
                    if (!samePolicy && next.policy().diamondProspecting() && diamondRoute.foot != null)
                        diamondRoute.arrive(diamondRoute.foot, diamondRoute.support, diamondRoute.preferred);
                    Item goalStock = goalStock(next.policy().target());
                    work.startingStock = goalStock == null ? 0 : count(goalStock);
                }
                if (continuePersonal || renewPersonal) personalCraft = new PersonalCraft(next, personalCraft.untilTick,
                    personalCraft.untilNanos, personalCraft.tableInReach);
                markConsumed(next.id());
                receipt(next.id(), life, "accepted", independent
                    ? "Ordinary bounded work owns the controls; the paid original remains parked with no ingots credited."
                    : work.detail);
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

    private AgentPendingFurnaceMemory.Entry pendingEntry() {
        return trial || ipc.workMode == null ? null : pendingFurnaceMemory.current();
    }

    private Map<Item, Integer> pendingFloors() {
        if (pendingOrigin != null) return pendingOrigin.budget.floors;
        var ticket = pendingEntry();
        return ticket == null || !ticket.mayInvestigateCollection() ? Map.of() : ticket.floors();
    }

    private boolean pendingCanYield() {
        var iron = action == null ? null : action.furnace;
        var ticket = pendingEntry();
        return ticket != null && ticket.mayInvestigateCollection() && !pendingUncertain && pendingWorldRelease
            && pendingOrigin != null && work == pendingOrigin && work.active() && iron != null && iron.phase == FurnacePhase.WATCHING
            && AgentFurnaceWatch.releasedForSide(iron.batch, iron.burnTick, iron.closedFrame, iron.watchFrame)
            && !iron.turningBack && tick < work.order.expires() && now < work.deadline && hazardClear && !urgent
            && work.order.safetyRevision() == safetyRevision && ironFooting(iron.footing)
            && releasedPendingHands() && body.renderedDirection(player.getYaw(), player.getPitch(), 2);
    }

    private boolean releasedPendingHands() {
        return observableWorld() && cursorClear() && player.currentScreenHandler == player.playerScreenHandler
            && body.keysNeutral() && hands.releasedForPendingWork() && useAvailable()
            && !player.isSprinting() && !player.isSneaking();
    }

    private boolean tryDeferPending() {
        Intent intent = input.intent;
        if (intent == null || consumed.containsKey(intent.id)) return false;
        Snapshot basis = snapshots.get(intent.basis);
        Offer offer = basis == null ? null : basis.offers.get(intent.opportunity);
        if (offer == null || offer.key.verb != Verb.DEFER_PENDING) return false;
        updateScope(true);
        String refusal = intentScope(intent);
        if (refusal == null && (intent.skillHash != null || tick - intent.basis >= MAX_WORK_ADMISSION_AGE
                || !pendingCanYield() || !pendingEntry().ticket().toString().equals(offer.key.activity)))
            refusal = "Deferral requires a current, clean, released wait and the exact ticket.";
        if (refusal == null && !parkPending())
            refusal = "The paid furnace could not be stored as a parked obligation.";
        markConsumed(intent.id);
        if (refusal != null) {
            receipt(intent, "refused", refusal);
            return false;
        }
        receipt(intent, "accepted", "The fresh witnessed pending ticket and released controls match.");
        receipt(intent, "completed", "The paid batch was deferred without claiming ingots or advancing its target.");
        return true;
    }

    private boolean parkPending() {
        if (!pendingCanYield() || !pendingFurnaceMemory.park(pendingEntry().ticket(), tick, body.renderedFrame())) return false;
        String detail = "The paid iron batch is parked at its witnessed furnace; no ingot was credited to inventory.";
        boolean journaled = ironMilestone("parked", detail);
        body.pauseWork();
        action = null;
        requireFreshParkedView();
        retireWork("parked", "parked", detail);
        continuityWork = null;
        return journaled;
    }

    private String pendingWorkRefusal(AgentWorkOrder next, Snapshot basis, AgentPendingFurnaceMemory.Entry entry,
                                      AgentWorkOrder.Budget budget, boolean park, boolean compatible) {
        if (entry == null || !entry.mayInvestigateCollection() || entry.historical() || pendingUncertain
                || entry.batch().units() < 2 || !entry.ticket().toString().equals(next.duringWaitFor())
                || !next.duringWaitFor().equals(basis.pendingTicket))
            return "There is no exact live paid multi-unit ticket for this ordinary work.";
        if (park ? !basis.releasedWait || !pendingCanYield() : entry.state() != AgentPendingFurnaceMemory.State.PARKED)
            return "The exact paid wait has not released clean controls or been parked.";
        if (urgent || !compatible && (budget.missingFloor(player.getInventory()) != null
                || count(next.policy().target().item()) >= next.policy().target().count()))
            return "The ordinary target or reserve premise no longer calls for this independent job.";
        if (!park && !hasActiveWorkOrder() && !parkedViewReady())
            return "A fresh, neutral world view is required before starting ordinary work.";
        return null;
    }

    private boolean journalPendingWork(AgentWorkOrder next) {
        var evidence = header(run);
        evidence.addProperty("id", next.id());
        evidence.addProperty("pendingWorkId", next.duringWaitFor());
        evidence.addProperty("milestone", "side_admitted");
        evidence.addProperty("life", life);
        evidence.addProperty("tick", tick);
        return ipc.evidence("furnace-" + next.id() + "-side_admitted.json", evidence.toString());
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
        if (work.order.duringWaitFor() != null) requireFreshParkedView();
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
        if (fungibleStockPickup()) {
            if (grounded() && hazardClear && client.isWindowFocused() && client.getOverlay() == null)
                body.visibleHorizon().keepPickupGround(work);
            else body.visibleHorizon().clearPickupGround();
        }
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
        if (work.foodClue != null) {
            if (work.foodStarted || missingFloor != null || !foodClueCurrent(work.foodClue, progress)) {
                retireWork("blocked", "interrupted", work.foodStarted
                    ? "The one authorized source is finished; the requested stored food and reserves are not confirmed."
                    : "The exact local food source or protected reserves changed before any input.");
            } else {
                work.foodStarted = true;
                startWorkStep(Verb.WORK_FORAGE, "Gather from the one witnessed food source",
                    work.foodClue.face, null, work.foodClue.food.source.item, null);
                action.walkInventory = new InventoryWitness(player.getInventory());
                runWorkStep(progress);
            }
            return;
        }
        if (deepWork()) {
            if (diamondRoute.unjoined != null && !recoverDiamondRoute()) {
                if (work.sourceBlock == null)
                    work.sourceBlock = "A movement interruption left the prospect return unproved. A separate dry traversal must still have safe footing and a usable reverse lane.";
                searchWork(work.sourceBlock);
                return;
            }
            if (diamondRoute.rootExit != null && !diamondLaneCurrent(diamondRoute.rootExit)) {
                diamondRoute.interruptedAt(player.getBlockPos(), null);
                work.sourceBlock = "The exact dry exit from the re-established prospect root changed.";
                searchWork(work.sourceBlock);
                return;
            }
        }
        if (!sourceSearch.stairs.isEmpty() && workTicksLeft() <= AgentSurfaceTread.returnTicks(sourceSearch.stairs.size())
                + Verb.BREAK.maxTicks) {
            work.sourceBlock = "The remaining time is reserved for the verified climb back.";
            searchWork(work.sourceBlock);
            return;
        }
        if (work.harvestOpening != null) {
            Face opening = work.harvestOpening;
            Item item = AgentWorkOrder.harvest(opening.state);
            if (!personal && missingFloor == null && work.budget.canBreak() && visibleFace(opening)
                    && workResourceSafe(opening.hit, opening.state, progress) && roomFor(new ItemStack(item))
                    && startWorkBreak(opening, item, false)) {
                runWorkStep(progress);
            } else {
                searchWork("The inspected harvest is no longer in safe reach within the declared costs and reserves.");
            }
            return;
        }
        if (work.surfaceOpening != null) {
            var opening = work.surfaceOpening;
            int tool = personal || work.rejected.contains(opening.face.hit.getBlockPos()) ? -1
                : surfaceOpeningSlot(opening, progress, work.budget, workTicksLeft());
            if (startWorkBreak(opening.face, AgentWorkOrder.prospectCoverDrop(opening.face.state), true, tool)) {
                runWorkStep(progress);
            } else {
                searchWork("The original surface cap is no longer a safe, priced cut with enough time for a verified return.");
            }
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
            if (work.lowerHarvest || tick - work.lastHarvestTick <= 8) {
                body.pauseWork();
                enact("search", work.lowerHarvest
                    ? "Checking the confirmed harvest from the rim without entering the opening."
                    : "Checking beside the confirmed harvest for a visible drop; no pickup confirmed yet.");
                return;
            }
        }
        work.lastHarvest = null;
        BlockHitResult tableHit = personal || deepWork() && diamondRoute.cutting && !goalReached
            ? null : visibleStation(Blocks.CRAFTING_TABLE);
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
        } else if (workPickup(stage.pickup()) || workGather(progress, stage.gather(), 1)) {
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
        return personalCraft == null && workGather(progress, state -> AgentWorkOrder.harvest(state) == desired, quantity);
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
            }, need.count());
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
        if ((face != null && station(face.state))
                || (verb == Verb.WORK_PLACE && (item == Items.CRAFTING_TABLE || item == Items.FURNACE)))
            rememberProspectLandmark();
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
            case WORK_FORAGE -> "collect";
            default -> "hold";
        }, label);
        status = label;
        return action;
    }

    private boolean workPickup(Predicate<ItemStack> wanted) {
        if (!work.sourceSearch.stairs.isEmpty() || travelAnchorOutstanding()) return false;
        var seen = body.visibleEntity(entity -> entity instanceof ItemEntity drop && pickupEligible(drop)
            && (!deepWork() || drop.getBlockPos().getY() == player.getBlockY())
            && !dropInProspectOpening(drop) && wanted.test(drop.getStack()) && roomFor(drop.getStack()), 8.0).orElse(null);
        if (!(seen instanceof ItemEntity found)) return false;
        return startWorkPickup(found);
    }

    private boolean startWorkPickup(ItemEntity found) {
        Item item = found.getStack().getItem();
        startWorkStep(Verb.WORK_WALK, "Collect visible " + Registries.ITEM.getId(item), null, found, item, null);
        action.dropSeen = action.pickupProgress = tick;
        action.dropPosition = found.getPos();
        action.dropGrounded = found.isOnGround();
        action.pickupFooting = player.getPos();
        return true;
    }

    /** Reconsider a blocked drop only when the currently visible item or the player's pose actually changes. */
    private boolean pickupEligible(ItemEntity drop) {
        PickupDeferral prior = work.deferredDrops.get(drop.getId());
        return prior == null || drop.isOnGround() != prior.grounded
            || drop.getPos().squaredDistanceTo(prior.drop) >= 0.0225
            || player.getPos().squaredDistanceTo(prior.feet) >= 0.0625
            || angle(player.getYaw(), player.getPitch(), prior.yaw, prior.pitch) >= 10;
    }

    private boolean collectOwnTimber() {
        if (timberHarvest == null || travelAnchorOutstanding()) return false;
        TimberHarvest cut = timberHarvest;
        Item target = work.order.policy().target().item();
        if (tick - cut.tick > 48 || count(cut.item) > cut.stock || !work.sourceSearch.stairs.isEmpty()
                || !work.budget.policy.breakAllowed(cut.state) || horizontalSquared(player.getPos(), cut.stance) > 16
                || target != null && target != cut.item && work.budget.remainingCost(cut.item) == 0) {
            timberHarvest = null;
            return false;
        }
        Vec3d base = Vec3d.ofBottomCenter(cut.block);
        var seen = body.visibleEntity(entity -> entity instanceof ItemEntity drop && pickupEligible(drop)
            && drop.getStack().isOf(cut.item) && roomFor(drop.getStack())
            && horizontalSquared(drop.getPos(), base) <= 2.25 && !dropInProspectOpening(drop), 6).orElse(null);
        if (seen instanceof ItemEntity found) return startWorkPickup(found);
        if (tick - cut.tick <= 12) {
            body.pauseWork();
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

    private boolean fungibleStockPickup() {
        var policy = work.budget.policy;
        return policy.target().item() != null && !policy.preset() && !policy.smeltIron() && !policy.waterFill()
            && !policy.diamondProspecting() && work.sourceSearch.stairs.isEmpty();
    }

    private boolean workGather(AgentProgress progress, Predicate<BlockState> matches, int required) {
        if (!work.budget.canBreak()) {
            if (work.sourceSearch.firstCover != null || deepWork()) work.sourceBlock = "The authorized break grant is spent.";
            return false;
        }
        if (client.options.attackKey.isUnbound()) return false;
        Predicate<BlockState> wanted = state -> matches.test(state) && work.budget.policy.breakAllowed(state);
        boolean diamond = deepWork() && (wanted.test(Blocks.DIAMOND_ORE.getDefaultState())
            || wanted.test(Blocks.DEEPSLATE_DIAMOND_ORE.getDefaultState()));
        if (diamond && diamondRoute.freshRaysPending) {
            // Give the bounded recheck first use of the new view, before the wide ore search.
            diamondRoute.freshRaysPending = false;
            return prospectForDiamond(progress, wanted, null);
        }
        Predicate<BlockHitResult> eligible = hit -> {
            BlockPos pos = hit.getBlockPos();
            if (work.rejected.contains(pos)) return false;
            BlockState state = world.getBlockState(pos);
            return scopedSourceHit(hit) && workResourceSafe(hit, state, progress)
                && workToolSlot(pos, state) >= 0 && roomFor(new ItemStack(AgentWorkOrder.harvest(state)));
        };
        double reach = reach();
        if (diamond && diamondRoute.cutting) {
            // Keep the next paid action in the established heading. An already rendered
            // diamond can still take precedence, without paying for another sector scan.
            var source = body.findSampled(wanted, reach,
                hit -> eligible.test(hit) && body.macroMineWitness(hit, reach) != null).orElse(null);
            if (source != null) return startWorkBreak(face(source), Items.DIAMOND, false);
            return prospectForDiamond(progress, wanted, null);
        }
        if (work.sourceLook != null) {
            Face remembered = work.sourceLook;
            Vec3d point = remembered.hit.getPos();
            if (tick < work.sourceLookUntil && wanted.test(remembered.state) && !body.renderedAim(point, 8)) {
                body.aim(point);
                enact("search", "Rechecking the earlier witnessed source from the actual new stance.");
                return true;
            }
            work.sourceLook = null; // A dated bearing never authorizes attack; find the vanilla contact again below.
        }
        if (!diamond && work.sourceSearch.stairs.isEmpty()) {
            if (workGatherTimber(progress, wanted, eligible, required)) return true;
            if (work.sourceBlock != null) return false;
        }
        var found = body.find(wanted, reach, hit -> eligible.test(hit) && body.macroMineWitness(hit, reach) != null).orElse(null);
        if (found != null) {
            Face face = face(found);
            return startWorkBreak(face, AgentWorkOrder.harvest(face.state), false);
        }
        var search = work.sourceSearch;
        if (work.order.surfaceAnchor() != null && !search.stairUsed && search.lastCover != null
                && player.getBlockPos().equals(search.cutFrom))
            return prospectForSource(progress, wanted);
        found = work.sourceSearch.stairs.isEmpty()
            ? body.find(state -> wanted.test(state) && !timberBlock(state), INSPECT_REACH,
                hit -> {
                    BlockPos pos = hit.getBlockPos();
                    BlockState state = world.getBlockState(pos);
                    return scopedSourceHit(hit) && !work.rejected.contains(pos) && !work.sourceSearch.footholds.contains(pos)
                        && dryWorkBreakSafe(pos, state, AgentWorkOrder.harvest(state), progress)
                        && workToolSlot(pos, state) >= 0 && roomFor(new ItemStack(AgentWorkOrder.harvest(state)));
                }).orElse(null)
            : null;
        if (diamond) return prospectForDiamond(progress, wanted, found);
        if (found != null) {
            var grade = sourceCaveLane(progress, found, true);
            if (grade != null) return startSourceCaveLane(progress, found, grade);
        }
        var sourceTravel = selectHorizonTarget(state -> wanted.test(state) && !timberBlock(state),
            INSPECT_REACH, RESOURCE, true, HorizonSelection.WORK, found,
            hit -> ordinaryGoalHit(hit) && resourceApproachUseful(hit, progress));
        if (startOpticalHorizonSource(sourceTravel)) return true;
        if (!travelAnchorOutstanding() && found != null && found.getBlockPos().getY() < player.getBlockY()
                && startSourceCaveStep(progress, found)) return true;
        var caveTravel = earlySourceAvailable(wanted) ? selectCaveFrontier(HorizonSelection.WORK) : null;
        if (startOpticalHorizonSource(caveTravel)) return true;
        if (travelAnchorOutstanding()) return false;
        if (!deepWork() && work.sourceSearch.stairs.isEmpty() && startSourceCaveStep(progress, found)) return true;
        if (startContactHorizonSource(sourceTravel) || startContactHorizonSource(caveTravel)) return true;
        return prospectForSource(progress, wanted);
    }

    private boolean startSourceCaveStep(AgentProgress progress, BlockHitResult source) {
        var search = work.sourceSearch;
        var from = player.getBlockPos();
        if (!settled() || !dryProspectStance(from) || search.steps >= MAX_SOURCE_FOOTHOLDS) return false;
        var route = sourceCaveLane(progress, source, false);
        if (route != null) return startSourceCaveLane(progress, source, route);
        var survey = progress.drySurveyOffer();
        if (survey == null || source != null && source.getBlockPos().getY() >= from.getY()
                || !work.caveSurveys.add(from.toImmutable())) return false;
        startWorkCaveStep(Verb.DRY_SURVEY, "Verify the witnessed lower lane without movement or spending", progress, null, survey, false);
        return true;
    }

    private AgentDryCaveRoute.Offer sourceCaveLane(AgentProgress progress, BlockHitResult source, boolean oneGrade) {
        var search = work.sourceSearch;
        var from = player.getBlockPos();
        if (deepWork() || !search.stairs.isEmpty() || !settled() || !dryProspectStance(from)) return null;
        var route = currentDryRoute(progress);
        return route != null && (!oneGrade || route.edges() == 1 && Math.abs(route.heightChange()) == 1)
            && route.edges() <= MAX_SOURCE_FOOTHOLDS - search.steps
            && workTicksLeft() > AgentSurfaceTread.returnTicks(route.edges())
            && (source == null || routeTowardSource(from, route.endpoint(), source))
            && !search.footholds.contains(route.endpoint().down()) && !search.attempted.contains(route.endpoint().down())
            ? route : null;
    }

    private boolean startSourceCaveLane(AgentProgress progress, BlockHitResult source, AgentDryCaveRoute.Offer route) {
        var search = work.sourceSearch;
        search.steps += route.edges();
        search.attempted.add(route.endpoint().down());
        search.footholds.add(route.from().down());
        startWorkCaveStep(Verb.FOLLOW, "Follow the witnessed reversible dry lane for source work", progress, route, null, false);
        if (source != null) {
            action.scopedSourceLane = travelAnchorOutstanding();
            rememberSourceBearing(source);
        }
        return true;
    }

    /** Select only among ordinary proved routes; a visible source is a bearing, not movement or mining authority. */
    static boolean routeTowardSource(BlockPos from, BlockPos endpoint, BlockHitResult source) {
        return source.getBlockPos().getY() >= endpoint.getY()
            && horizontalSquared(Vec3d.ofBottomCenter(endpoint), source.getPos()) + 0.16
                < horizontalSquared(Vec3d.ofBottomCenter(from), source.getPos());
    }

    private void rememberSourceBearing(BlockHitResult source) {
        work.sourceLook = face(source);
        work.sourceLookUntil = tick + action.offer.key.verb.maxTicks + 20;
    }

    record OrdinaryTravelTarget(AgentVisibleHorizon.Target target, AgentWorkOrder.TravelKind kind,
                                AgentVisibleHorizon.Window window, AgentBody.OrdinaryGrade grade) {}

    private enum HorizonSelection { PREVIEW, ACTIVE_WORK_PREVIEW, WORK }

    /** Travel preview only: current tools/authorization are rechecked in workGather, not inferred by publishing this. */
    OrdinaryTravelTarget ordinaryTravelTarget(AgentProgress progress) {
        if (!body.hasRecentView()) {
            body.visibleHorizon().notePreview(body.horizonViewRefusal());
            return null;
        }
        if (!(grounded() || body.horizonWaterInFlight() && player.isOnGround())) {
            body.visibleHorizon().notePreview(AgentVisibleHorizon.Refusal.SOURCE_UNGROUNDED);
            return null;
        }
        if (hasActiveWorkOrder() && deepWork()) {
            if (!diamondRoute.rollingDepartureAllowed()) return noOrdinaryTravelTarget();
            var ore = selectDiamondSource(work.budget.policy::breakAllowed, null, HorizonSelection.ACTIVE_WORK_PREVIEW);
            if (ore != null) return ore;
            var frontier = selectCaveFrontier(HorizonSelection.ACTIVE_WORK_PREVIEW);
            return frontier == null ? noOrdinaryTravelTarget() : frontier;
        }
        var timber = selectHorizonTarget(AgentMacroControl::timberBlock, TIMBER_RECALL_RANGE, RESOURCE,
            false, HorizonSelection.PREVIEW, null, this::levelSourceTravelCue);
        if (timber != null) return timber;
        var ore = selectDiamondSource(state -> true, null, HorizonSelection.PREVIEW);
        if (ore != null) return ore;
        var early = selectHorizonTarget(state -> earlyTravelMaterial(state) && !naturalFrontier(state),
            INSPECT_REACH, RESOURCE, true, HorizonSelection.PREVIEW, null,
            hit -> ordinaryGoalHit(hit) && progress.macroCanBreak(hit.getBlockPos()));
        if (early != null) return early;
        var cave = selectCaveFrontier(HorizonSelection.PREVIEW);
        if (cave != null) return cave;
        var woodland = selectWoodland(HorizonSelection.PREVIEW);
        if (woodland != null) return woodland;
        var rock = selectHorizonTarget(AgentMacroControl::earlyTravelMaterial, INSPECT_REACH, RESOURCE, true,
            HorizonSelection.PREVIEW, null, hit -> ordinaryGoalHit(hit) && progress.macroCanBreak(hit.getBlockPos()));
        return rock == null ? noOrdinaryTravelTarget() : rock;
    }

    private OrdinaryTravelTarget noOrdinaryTravelTarget() {
        body.visibleHorizon().notePreview(AgentVisibleHorizon.Refusal.NO_GOAL_GRADE_OR_MATERIAL_FACE);
        return null;
    }

    private static boolean earlyTravelMaterial(BlockState state) {
        Item drop = AgentWorkOrder.harvest(state);
        return drop == Items.COAL || drop == Items.RAW_IRON || drop == Items.COBBLESTONE || drop == Items.COBBLED_DEEPSLATE;
    }

    private boolean ordinaryGoalHit(BlockHitResult hit) {
        BlockPos pos = hit.getBlockPos();
        int grade = pos.getY() - player.getBlockY();
        return hit.getSide().getAxis().isHorizontal() && grade >= 0 && grade <= 3
            && horizontalSquared(player.getPos(), hit.getPos()) > 0.85 * 0.85;
    }

    private boolean levelSourceTravelCue(BlockHitResult hit) {
        return timberTravelCue(hit, player.getPos(), player.getEyeY(), reach());
    }

    // A level approach can make a shallow-below, top or oblique face reachable.
    // The vertical difference cannot improve through level motion, so don't promise a tree high above the player.
    static boolean timberTravelCue(BlockHitResult hit, Vec3d feet, double eyeY, double reach) {
        double dy = hit.getPos().y - eyeY;
        return horizontalSquared(feet, hit.getPos()) > TIMBER_ARRIVAL * TIMBER_ARRIVAL
            && horizontalSquared(feet, Vec3d.ofBottomCenter(hit.getBlockPos())) >= 0.80 * 0.80
            && dy * dy + TIMBER_ARRIVAL * TIMBER_ARRIVAL < reach * reach;
    }

    static double timberWorkArrival(Vec3d feet, Vec3d point, BlockPos trunk, double bodyWidth) {
        // Back off from the footprint, not the selected pixel. An upper face
        // can be near the middle of the trunk instead of on its near edge.
        double dx = feet.x - point.x, dz = feet.z - point.z;
        double clearance = bodyWidth * 0.5 + 0.40;
        double x = dx > 0 ? (trunk.getX() + 1 + clearance - point.x) / dx
            : dx < 0 ? (trunk.getX() - clearance - point.x) / dx : Double.POSITIVE_INFINITY;
        double z = dz > 0 ? (trunk.getZ() + 1 + clearance - point.z) / dz
            : dz < 0 ? (trunk.getZ() - clearance - point.z) / dz : Double.POSITIVE_INFINITY;
        return dx == 0 && dz == 0 ? clearance : Math.min(x, z) * Math.hypot(dx, dz);
    }

    static boolean timberReadyToCut(boolean reachable, Vec3d feet, Vec3d goal, double arrival, boolean noCloserLane) {
        double comfortable = arrival + 0.11; // Neutral braking may settle slightly short of the nominal stance.
        return reachable && (noCloserLane || horizontalSquared(feet, goal) <= comfortable * comfortable);
    }

    static boolean woodlandTravelCue(BlockHitResult hit, Vec3d feet) {
        double grade = hit.getPos().y - feet.y;
        return grade >= -1.35 && grade <= 3.25
            && horizontalSquared(feet, hit.getPos()) >= 1.60 * 1.60
            && horizontalSquared(feet, Vec3d.ofBottomCenter(hit.getBlockPos())) >= 1.60 * 1.60;
    }

    private static boolean naturalFrontier(BlockState state) {
        return state.isOf(Blocks.STONE) || state.isOf(Blocks.DEEPSLATE) || state.isOf(Blocks.ANDESITE)
            || state.isOf(Blocks.DIORITE) || state.isOf(Blocks.GRANITE) || state.isOf(Blocks.TUFF);
    }

    private OrdinaryTravelTarget selectCaveFrontier(HorizonSelection selection) {
        boolean high = player.getBlockY() > 56;
        if (high && (selection == HorizonSelection.PREVIEW || !deepWork())) return null;
        return selectHorizonTarget(AgentMacroControl::naturalFrontier, INSPECT_REACH, CAVE_FRONTIER, true,
            selection, null, hit -> (!high || hit.getSide().getAxis().isHorizontal()) && frontierGrade(hit));
    }

    private OrdinaryTravelTarget selectWoodland(HorizonSelection selection) {
        Vec3d feet = player.getPos();
        return selectHorizonTarget(state -> state.isIn(BlockTags.LEAVES), TIMBER_RECALL_RANGE, WOODLAND_FRONTIER,
            false, selection, null, hit -> woodlandTravelCue(hit, feet));
    }

    private OrdinaryTravelTarget selectDiamondSource(Predicate<BlockState> wanted, BlockHitResult preferred,
                                                      HorizonSelection selection) {
        return selectHorizonTarget(state -> state.isIn(BlockTags.DIAMOND_ORES) && wanted.test(state),
            INSPECT_REACH, RESOURCE, true, selection, preferred, this::levelSourceTravelCue);
    }

    private boolean frontierGrade(BlockHitResult hit) {
        int grade = hit.getBlockPos().getY() - player.getBlockY();
        return (hit.getSide() == Direction.UP ? grade >= -1 && grade <= 2
                : hit.getSide().getAxis().isHorizontal() && grade >= 0 && grade <= 3)
            && horizontalSquared(player.getPos(), hit.getPos()) >= 2.25
            && Math.abs(MathHelper.wrapDegrees(heading(hit.getPos().x - player.getX(),
                hit.getPos().z - player.getZ()) - player.getYaw())) <= 55;
    }

    private OrdinaryTravelTarget selectHorizonTarget(Predicate<BlockState> matches, double distance,
                                                       AgentWorkOrder.TravelKind kind, boolean allowWade,
                                                       HorizonSelection selection, BlockHitResult preferred,
                                                       Predicate<BlockHitResult> goal) {
        boolean forWork = selection != HorizonSelection.PREVIEW;
        if (forWork && !horizonStartAvailable()) return null;
        var horizon = body.visibleHorizon();
        var scope = forWork && travelAnchorOutstanding() ? work.order.travelAnchor() : null;
        OrdinaryTravelTarget grade = null, glance = null, contact = null;
        for (int i = 0; i < horizonCandidateCells.length; ++i) {
            int tried = i;
            Predicate<BlockHitResult> eligible = hit -> {
                var cell = hit.getBlockPos();
                long key = cell.asLong();
                for (int j = 0; j < tried; ++j) if (horizonCandidateCells[j] == key) return false;
                // Only the one already issued target ID can match. Do not spend
                // optical rechecks (or mint IDs) on unrelated frustum samples.
                if (scope != null && !scope.target().equals(materialTargets.get(travelAnchorKey(cell, kind)))) return false;
                return goal.test(hit) && (!forWork || !work.rejected.contains(cell)
                    && !work.horizonAttempts.contains(cell));
            };
            AgentVisibleHorizon.Target target = null;
            BlockHitResult hit = null;
            if (i == 0) {
                var aim = horizon.idleAim(kind);
                if (aim != null && matches.test(aim.state()) && (scope == null || scope.target().equals(
                        materialTargets.get(travelAnchorKey(aim.hit().getBlockPos(), kind))))) {
                    var live = horizon.recheckIdleAim(distance);
                    if (live != null && eligible.test(live.hit())) {
                        target = live;
                        hit = live.hit();
                    }
                }
                if (hit == null) {
                    var first = preferred == null ? body.horizonSightline(distance) : preferred;
                    if (first != null && matches.test(world.getBlockState(first.getBlockPos())) && eligible.test(first))
                        hit = first;
                }
            }
            if (hit == null) {
                hit = body.horizonCue(matches, distance, eligible);
                if (hit == null) hit = body.find(matches, distance, eligible).orElse(null);
                if (hit == null) break;
            }
            horizonCandidateCells[i] = hit.getBlockPos().asLong();
            if (target == null) target = horizon.target(hit);
            if (target == null) continue;
            var window = horizon.window(target, allowWade);
            if (usableHorizonWindow(window, allowWade)) return new OrdinaryTravelTarget(target, kind, window, null);
            if (grade == null) {
                var step = body.ordinaryGrade(target.point());
                if (step != null && (!forWork || ordinaryGradeAvailable(step))) {
                    if (!step.lookOnly()) grade = new OrdinaryTravelTarget(target, kind, null, step);
                    else if (glance == null && selection == HorizonSelection.WORK)
                        glance = new OrdinaryTravelTarget(target, kind, null, step);
                }
            }
            if (contact == null && selection == HorizonSelection.WORK && horizonPulseAllowed()) {
                var local = horizon.contactWindow(target);
                if (local != null) contact = new OrdinaryTravelTarget(target, kind, local, null);
            }
        }
        return grade != null ? grade : glance != null ? glance : contact;
    }

    static boolean rollingWorkAdmits(AgentWorkOrder order, boolean scoped, AgentWorkOrder.TravelAnchor candidate,
                                     AgentWorkOrder.TravelKind kind, boolean allowWade, AgentVisibleHorizon.Window window) {
        return (usableHorizonWindow(window, allowWade) || !scoped && order.travelAnchor() == null
                && window != null && window.contactOnly() && window.medium() == AgentVisibleHorizon.Medium.DRY
                && window.knownDistance() > window.brakingDistance())
            && (!scoped || candidate != null && candidate.equals(order.travelAnchor())
                && order.policy().travelAnchorAllowed(candidate.subject(), kind))
            && (kind != WOODLAND_FRONTIER
                || order.policy().travelAnchorAllowed(AgentWorkOrder.WOODLAND_ANCHOR_SUBJECT, kind));
    }

    private static boolean usableHorizonWindow(AgentVisibleHorizon.Window window, boolean allowWade) {
        return window != null && !window.contactOnly() && window.knownDistance() > 0
            && window.knownDistance() >= window.brakingDistance()
            && (window.medium() == AgentVisibleHorizon.Medium.DRY
                || allowWade && window.medium() == AgentVisibleHorizon.Medium.SHALLOW_WATER && window.dryBank() != null);
    }

    private boolean travelAnchorOutstanding() {
        return work != null && work.active() && work.order.travelAnchor() != null && !work.travelAnchorUsed;
    }

    private static Key travelAnchorKey(BlockPos cell, AgentWorkOrder.TravelKind kind) {
        return new Key(Verb.BREAK, cell, 0, kind == WOODLAND_FRONTIER ? AgentWorkOrder.WOODLAND_ANCHOR_SUBJECT : null);
    }

    private boolean scopedSourceHit(BlockHitResult hit) {
        if (!travelAnchorOutstanding()) return true;
        if (work.timberRecheck != null && work.timberRecheck.kind == WOODLAND_FRONTIER
                && work.order.travelAnchor().equals(work.timberRecheck.anchor) && timberRecheckHit(work.timberRecheck, hit))
            return true;
        var target = body.visibleHorizon().target(hit);
        return target != null && work.order.travelAnchor().equals(renderedTravelAnchor(target, RESOURCE));
    }

    private boolean horizonStartAvailable() {
        return !client.options.forwardKey.isUnbound() && work.sourceSearch.stairs.isEmpty()
            && work.horizonLegs < MAX_SOURCE_FOOTHOLDS && workTicksLeft() > MIN_ROLLING_LEASE_TICKS
            && (!deepWork() || diamondRoute.rollingDepartureAllowed());
    }

    private boolean horizonPulseAllowed() {
        return work.order.travelAnchor() == null && !work.horizonPulseSpent;
    }

    private boolean startOpticalHorizonSource(OrdinaryTravelTarget target) {
        return target != null && (target.grade() != null ? startOrdinaryGrade(target)
            : !target.window().contactOnly() && startHorizonSource(target));
    }

    private boolean startContactHorizonSource(OrdinaryTravelTarget target) {
        return target != null && target.window() != null && target.window().contactOnly()
            && horizonPulseAllowed() && startHorizonSource(target);
    }

    private boolean ordinaryGradeAvailable(AgentBody.OrdinaryGrade grade) {
        var search = work.sourceSearch;
        return grounded() && settled() && workTicksLeft() > MIN_GRADE_LEASE_TICKS
            && !search.footholds.contains(grade.floor())
            && !search.attempted.contains(grade.floor());
    }

    private boolean startOrdinaryGrade(OrdinaryTravelTarget nominated) {
        var grade = nominated.grade();
        if (!horizonStartAvailable() || !ordinaryGradeAvailable(grade)
                || grade.frame() != body.renderedFrame()) return false;
        var target = nominated.target();
        var kind = nominated.kind();
        var cue = face(target.hit());
        if (!ordinaryGradeSubjectAllowed(cue, kind)) return false;
        if (travelAnchorOutstanding() && !work.order.travelAnchor().equals(renderedTravelAnchor(target, kind))) return false;
        startWorkStep(Verb.WORK_WALK, grade.lookOnly() ? "Check the top of the witnessed goalward step"
            : "Cross the witnessed single dry step toward the retained goal", cue, null, null, null);
        action.horizonKind = kind;
        action.walkInventory = new InventoryWitness(player.getInventory());
        attachOrdinaryGrade(grade);
        return true;
    }

    private boolean ordinaryGradeSubjectAllowed(Face cue, AgentWorkOrder.TravelKind kind) {
        if (kind == RESOURCE && !work.budget.policy.breakAllowed(cue.state)) return false;
        if (kind == WOODLAND_FRONTIER)
            return work.budget.policy.travelAnchorAllowed(AgentWorkOrder.WOODLAND_ANCHOR_SUBJECT, kind);
        return kind != CAVE_FRONTIER || earlySourceAvailable(work.budget.policy::breakAllowed) || deepWork();
    }

    private void attachOrdinaryGrade(AgentBody.OrdinaryGrade grade) {
        if (action.horizonTravel != null) body.stopHorizonTravel(action.horizonTravel);
        action.horizonTravel = null;
        action.ordinaryGrade = grade;
        action.gradeLookUntil = tick + GRADE_GLANCE_TICKS;
        if (!grade.lookOnly()) action.tread = AgentSurfaceTread.ordinaryGrade(grade.edge(), grade.from(), tick);
        work.sourceSearch.attempted.add(grade.floor());
        work.sourceSearch.footholds.add(grade.from().down());
        work.horizonAttempts.add(action.offer.face.hit.getBlockPos());
        ++work.horizonLegs;
    }

    private boolean startHorizonSource(OrdinaryTravelTarget nominated) {
        if (nominated == null || !horizonStartAvailable()) return false;
        var search = work.sourceSearch;
        var target = nominated.target();
        var kind = nominated.kind();
        var hit = target.hit();
        var cell = hit.getBlockPos();
        boolean scoped = travelAnchorOutstanding();
        var candidate = scoped ? renderedTravelAnchor(target, kind) : null;
        var cue = face(hit);
        boolean timber = kind == RESOURCE && timberBlock(cue.state);
        boolean allowWade = !timber && kind != WOODLAND_FRONTIER;
        if (!rollingWorkAdmits(work.order, scoped, candidate, kind, allowWade, nominated.window())) return false;
        String label = switch (kind) {
            case CAVE_FRONTIER -> "Walk toward the witnessed cave frontier";
            case WOODLAND_FRONTIER -> "Walk toward the witnessed woodland edge; no harvest authorized by this cue";
            case RESOURCE -> "Walk toward witnessed " + blockName(cue);
        };
        startWorkStep(Verb.WORK_WALK, label, cue, null, null, null);
        Vec3d point = target.point();
        double arrival = kind == CAVE_FRONTIER ? 0.77 : kind == WOODLAND_FRONTIER ? 1.1 : TIMBER_ARRIVAL;
        action.timberWorkStance = timber && wantsFirstTimberStance(cue) && !nominated.window().contactOnly();
        if (action.timberWorkStance)
            arrival = timberWorkArrival(player.getPos(), point, cell, player.getWidth());
        action.horizonTravel = new AgentBody.HorizonTravel(target, new Vec3d(point.x, player.getY(), point.z),
            arrival, allowWade, nominated.window().contactOnly());
        action.horizonKind = kind;
        action.walkInventory = new InventoryWitness(player.getInventory());
        if (!nominated.window().contactOnly()) search.footholds.add(player.getBlockPos().down());
        work.horizonAttempts.add(cell);
        ++work.horizonLegs;
        return true;
    }

    private boolean wantsFirstTimberStance(Face cue) {
        Item item = work.order.policy().target().item();
        return work.confirmedBreaks == 0 && AgentWorkOrder.woodlandLog(item) && AgentWorkOrder.harvest(cue.state) == item;
    }

    private boolean resumeTimberStance(Predicate<BlockState> wanted) {
        Face cue = work.timberClosing;
        work.timberClosing = null;
        if (cue == null || !wanted.test(cue.state) || !wantsFirstTimberStance(cue) || !horizonStartAvailable()
                || work.rejected.contains(cue.hit.getBlockPos()) || work.horizonAttempts.contains(cue.hit.getBlockPos())
                || !roomFor(new ItemStack(AgentWorkOrder.harvest(cue.state)))) return false;
        var horizon = body.visibleHorizon();
        var target = horizon.target(cue.hit);
        if (target == null || world.getBlockState(target.hit().getBlockPos()) != cue.state) return false;
        Vec3d feet = player.getPos(), point = target.point();
        double arrival = timberWorkArrival(feet, point, target.hit().getBlockPos(), player.getWidth());
        if (timberReadyToCut(true, feet, point, arrival, false)) return false;
        // A partial leg retains only its aim. A new dry window or no movement.
        var window = horizon.window(target, false);
        return usableHorizonWindow(window, false) && startHorizonSource(new OrdinaryTravelTarget(target, RESOURCE, window, null));
    }

    private boolean workGatherTimber(AgentProgress progress, Predicate<BlockState> wanted,
                                    Predicate<BlockHitResult> eligible, int required) {
        rememberTimberView();
        if (resumeTimberStance(wanted)) return true;
        Predicate<BlockState> timber = state -> timberBlock(state) && wanted.test(state);
        var recheck = work.timberRecheck;
        int floor = player.getBlockY();
        double reach = reach();
        for (int upper = floor; upper <= floor + 1; upper++) {
            final int height = upper;
            BlockHitResult low = body.find(timber, reach, hit -> hit.getBlockPos().getY() <= height
                && timberRecheckHit(recheck, hit) && eligible.test(hit) && body.macroMineWitness(hit, reach) != null).orElse(null);
            if (low != null) {
                work.timberLook = null;
                Face seen = face(low);
                return startWorkBreak(seen, AgentWorkOrder.harvest(seen.state), false);
            }
        }
        BlockHitResult reachable = body.find(timber, reach,
            hit -> timberRecheckHit(recheck, hit) && eligible.test(hit) && body.macroMineWitness(hit, reach) != null).orElse(null);
        if (reachable != null) {
            work.timberLook = null;
            Face seen = face(reachable);
            return startWorkBreak(seen, AgentWorkOrder.harvest(seen.state), false);
        }
        var seen = selectHorizonTarget(timber, TIMBER_RECALL_RANGE, RESOURCE, false, HorizonSelection.WORK, null,
            hit -> timberRecheckHit(recheck, hit) && levelSourceTravelCue(hit)
                && roomFor(new ItemStack(AgentWorkOrder.harvest(world.getBlockState(hit.getBlockPos())))));
        boolean approaching = startOpticalHorizonSource(seen);
        if (!approaching && recheck == null) {
            var grove = woodlandWorkAvailable(wanted) ? selectWoodland(HorizonSelection.WORK) : null;
            approaching = startOpticalHorizonSource(grove) || startContactHorizonSource(seen) || startContactHorizonSource(grove);
        } else if (!approaching && recheck.kind == WOODLAND_FRONTIER) {
            var grove = selectHorizonTarget(state -> state.isIn(BlockTags.LEAVES), TIMBER_RECALL_RANGE,
                WOODLAND_FRONTIER, false, HorizonSelection.WORK, null, hit -> hit.getBlockPos().equals(recheck.source.hit.getBlockPos())
                    && woodlandTravelCue(hit, player.getPos()));
            approaching = startOpticalHorizonSource(grove);
        }
        if (approaching) {
            work.timberLook = null;
            return true;
        }
        var pursuit = recheck != null ? recheck : timberPursuit;
        if (pursuit != null && wanted.test(pursuit.kind == RESOURCE ? pursuit.source.state
                : ((net.minecraft.item.BlockItem) pursuit.timber).getBlock().getDefaultState()) && timberPursuitCurrent(pursuit)) {
            var lane = body.horizonWitness(pursuit.source.hit) == null ? null : sourceCaveLane(progress, pursuit.source.hit, true);
            if (lane != null && startSourceCaveLane(progress, pursuit.source.hit, lane)) return true;
            if (recheck == null && startTimberOpening(progress, pursuit, required)) return true;
        }
        if (recheck != null) {
            work.sourceBlock = "After one confirmed preparatory leaf break, the fresh view showed no usable timber contact or safe continuation.";
            return false;
        }
        if (work.sourceBlock != null) return false;
        if (travelAnchorOutstanding()) return false;
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

    private boolean woodlandWorkAvailable(Predicate<BlockState> wanted) {
        var policy = work.budget.policy;
        Item item = policy.target().item();
        return item instanceof net.minecraft.item.BlockItem block && wanted.test(block.getBlock().getDefaultState())
            && policy.travelAnchorAllowed(AgentWorkOrder.WOODLAND_ANCHOR_SUBJECT, WOODLAND_FRONTIER)
            && roomFor(new ItemStack(item));
    }

    private boolean timberRecheckHit(TimberPursuit pursuit, BlockHitResult hit) {
        if (pursuit == null) return true;
        if (pursuit.kind == RESOURCE) return hit.getBlockPos().equals(pursuit.source.hit.getBlockPos());
        Vec3d origin = Vec3d.ofBottomCenter(pursuit.stance);
        Vec3d goal = pursuit.source.hit.getPos();
        Vec3d point = hit.getPos();
        return AgentWorkOrder.harvest(world.getBlockState(hit.getBlockPos())) == pursuit.timber
            && (goal.x - origin.x) * (point.x - origin.x) + (goal.z - origin.z) * (point.z - origin.z) > 0
            && horizontalSquared(goal, point) < 9;
    }

    private void retainTimberPursuit(Action finished, boolean completed) {
        var cue = finished.offer.face;
        var kind = finished.horizonKind;
        if (cue == null || kind != RESOURCE && kind != WOODLAND_FRONTIER || urgent || !hazardClear || !grounded() || !settled()
                || !finished.timberApproached && (finished.horizonTravel == null || !finished.horizonTravel.moved())
                    && (finished.ordinaryGrade == null || !completed)) return;
        Item timber = kind == RESOURCE ? AgentWorkOrder.harvest(cue.state) : work.order.policy().target().item();
        if (timber == null || !AgentWorkOrder.woodlandLog(timber)
                || kind == WOODLAND_FRONTIER && !cue.state.isIn(BlockTags.LEAVES)) return;
        String target = materialTarget(travelAnchorKey(cue.hit.getBlockPos(), kind));
        if (target == null) return;
        String subject = kind == RESOURCE ? "block:" + blockName(cue) : AgentWorkOrder.WOODLAND_ANCHOR_SUBJECT;
        timberPursuit = new TimberPursuit(cue, new AgentWorkOrder.TravelAnchor(subject, target),
            timber, kind, player.getBlockPos(), safetyRevision, tick);
        timberReplan = null;
        work.timberRecheck = null; // Actual renewed movement, not the preparation, permits the ordinary job to resume.
    }

    private boolean timberPursuitCurrent(TimberPursuit pursuit) {
        return pursuit == timberPursuit && tick - pursuit.stopped <= TIMBER_OBSTRUCTION_TICKS
            && pursuit.safetyRevision == safetyRevision && pursuit.stance.equals(player.getBlockPos());
    }

    static boolean timberObstructionGeometry(Vec3d feet, Vec3d goal, BlockHitResult hit, double eyeY, double reach) {
        if (hit.isInsideBlock() || hit.getSide() == Direction.UP) return false;
        BlockPos cell = hit.getBlockPos();
        int dx = Math.abs(cell.getX() - MathHelper.floor(feet.x));
        int dz = Math.abs(cell.getZ() - MathHelper.floor(feet.z));
        int dy = cell.getY() - MathHelper.floor(feet.y);
        if (dx + dz == 0 || dx > 1 || dz > 1 || dy < 0 || dy > 1) return false;
        double eyeHeight = hit.getPos().y - eyeY;
        if (horizontalSquared(feet, hit.getPos()) + eyeHeight * eyeHeight > reach * reach) return false;
        // The known goalward centerline must actually enter this adjacent slice,
        // not merely pass near decorative foliage on a different bearing.
        var inside = new Box(cell.getX() + 0.08, 0, cell.getZ() + 0.08, cell.getX() + 0.92, 1, cell.getZ() + 0.92);
        return inside.raycast(new Vec3d(feet.x, 0.5, feet.z), new Vec3d(goal.x, 0.5, goal.z)).isPresent();
    }

    static boolean timberSolidDryFloor(BlockView world, BlockPos pos, BlockState state) {
        return !state.isIn(BlockTags.LEAVES) && !station(state) && !AgentProgress.dangerous(state)
            && !(state.getBlock() instanceof FallingBlock) && state.getFluidState().isEmpty()
            && Block.isShapeFullCube(state.getCollisionShape(world, pos));
    }

    private boolean safeTimberOpening(TimberPursuit pursuit, Face leaf, AgentProgress progress) {
        BlockPos foot = player.getBlockPos(), cell = leaf.hit.getBlockPos();
        if (!hazardClear || urgent || !grounded() || !settled() || !body.hasRecentView() || !dryProspectStance(foot)
                || !timberPursuitCurrent(pursuit) || player.supportingBlockPos.isEmpty()
                || !player.supportingBlockPos.get().equals(foot.down())
                || !timberSolidDryFloor(world, foot.down(), world.getBlockState(foot.down()))
                || !timberObstructionGeometry(player.getPos(), pursuit.source.hit.getPos(), leaf.hit, player.getEyeY(), reach())
                || cell.equals(pursuit.source.hit.getBlockPos()) || surfaceSearch.footholds.contains(cell)
                || walkedRoutes.connected(cell.up().asLong())
                || !AgentWorkOrder.timberLeaf(leaf.state) || !leaf.state.contains(LeavesBlock.PERSISTENT)
                || leaf.state.get(LeavesBlock.PERSISTENT) || world.getBlockState(cell) != leaf.state
                || player.getBoundingBox().expand(0.025).intersects(new Box(cell))
                || dryWorkBreakRefusal(cell, leaf.state, null, progress) != null) return false;
        // Geometry beyond the witnessed leaf is a veto only; nothing here
        // establishes visibility or authorizes a step after the block is gone.
        BlockPos level = cell.getY() == foot.getY() ? cell : cell.down();
        BlockPos other = cell.getY() == foot.getY() ? cell.up() : level;
        var oppositeSlice = world.getBlockState(other);
        if (!timberSolidDryFloor(world, level.down(), world.getBlockState(level.down()))
                || AgentProgress.dangerous(oppositeSlice) || oppositeSlice.isOf(Blocks.COBWEB)
                || !oppositeSlice.getCollisionShape(world, other).isEmpty()) return false;
        if (body.horizonWitness(pursuit.source.hit) != null)
            return world.getBlockState(pursuit.source.hit.getBlockPos()) == pursuit.source.state;
        // A known bearing can be occluded only by this exact currently seen leaf.
        // A different foreground blocker or a missing/off-camera ray proves neither source nor opening.
        Vec3d goal = pursuit.source.hit.getPos();
        var occluder = body.terrain(goal, player.getEyePos().distanceTo(goal) + 0.03).orElse(null);
        return occluder != null && occluder.getBlockPos().equals(cell);
    }

    private TimberObstruction findTimberObstruction(TimberPursuit pursuit, TimberObstruction expected, AgentProgress progress) {
        if (progress == null || !timberPursuitCurrent(pursuit) || client.options.attackKey.isUnbound()
                || expected != null && expected.pursuit != pursuit
                || timberOpeningAttempts.containsKey(pursuit.source.hit.getBlockPos())
                || timberOpeningAttempts.size() >= TIMBER_RECALL_LIMIT) return null;
        // Do not spend a new opening on an adjacent anchor in the same patch.
        for (BlockPos here : timberOpeningAttempts.values())
            if (here.getSquaredDistance(pursuit.stance) < 4.0) return null;
        var hit = body.find(AgentWorkOrder::timberLeaf, reach(), candidate -> {
            if (expected != null && !candidate.getBlockPos().equals(expected.leaf.hit.getBlockPos())) return false;
            if (work != null && work.rejected.contains(candidate.getBlockPos())) return false;
            var leaf = face(candidate);
            return safeTimberOpening(pursuit, leaf, progress) && body.macroMineWitness(candidate, reach()) != null;
        }).orElse(null);
        if (hit == null) return null;
        var leaf = face(hit);
        String id = materialTarget(new Key(Verb.BREAK, hit.getBlockPos(), 0, "timber-obstruction:" + blockName(leaf)));
        return id != null && (expected == null || expected.target.equals(id)) ? new TimberObstruction(pursuit, leaf, id) : null;
    }

    /** Leaves have no expected stock; keep the current hand or select a non-consuming one. */
    private int timberOpeningHand(Face leaf) {
        var inventory = player.getInventory();
        int current = inventory.selectedSlot;
        BlockPos pos = leaf.hit.getBlockPos();
        var held = inventory.getStack(current);
        if (AgentMiningStock.maxLoss(held, leaf.state, world, pos) == 0 && AgentMiningStock.lootCompatible(held, leaf.state)) return current;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot)
            if (inventory.getStack(slot).isEmpty() && hands.canEquipSlot(inventory, slot)) return slot;
        return -1;
    }

    private boolean startTimberOpening(AgentProgress progress, TimberPursuit pursuit, int required) {
        if (travelAnchorOutstanding() && !work.order.travelAnchor().equals(pursuit.anchor)) return false;
        var opening = findTimberObstruction(pursuit, work.admittedTimberOpening, progress);
        if (opening == null) {
            if (work.admittedTimberOpening != null) work.sourceBlock = "The admitted timber obstruction is no longer the exact visible contact.";
            return false;
        }
        var leaf = opening.leaf;
        int hand = timberOpeningHand(leaf);
        if (hand < 0) return false;
        if (!work.budget.policy.timberClearAllowed(leaf.state) || !work.budget.canOpenTimber(required)
                || workTicksLeft() <= Verb.BREAK.maxTicks + MIN_ROLLING_LEASE_TICKS) {
            timberReplan = opening;
            timberReplanAt = tick;
            work.sourceBlock = "The currently visible " + blockName(leaf)
                + " blocks the retained timber direction. A cut needs its exact break effect and one spare break beyond the wood.";
            return false;
        }
        if (hand != player.getInventory().selectedSlot) {
            startWorkStep(Verb.WORK_EQUIP, "Select a non-consuming hand for the witnessed timber opening", leaf, null, null, null);
            action.workSlot = hand;
            return true;
        }
        startWorkStep(Verb.BREAK, "Clear one witnessed timber obstruction: " + blockName(leaf), leaf, null, null, null);
        action.timberOpening = opening;
        action.timberLogsNeeded = required;
        timberOpeningAttempts.put(pursuit.source.hit.getBlockPos(), pursuit.stance);
        timberReplan = null;
        return true;
    }

    private boolean resourceApproachUseful(BlockHitResult hit, AgentProgress progress) {
        var pos = hit.getBlockPos();
        var state = world.getBlockState(pos);
        var item = AgentWorkOrder.harvest(state);
        return dryWorkBreakSafe(pos, state, item, progress) && workToolSlot(pos, state) >= 0
            && roomFor(new ItemStack(item));
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

    private static boolean insideTimberClearance(BlockPos trunk, Vec3d stance) {
        return horizontalSquared(Vec3d.ofBottomCenter(trunk), stance) < 0.80 * 0.80;
    }

    private boolean startWorkBreak(Face face, Item item, boolean cover) {
        BlockPos cell = face.hit.getBlockPos();
        int tool = cover && deepWork() ? prospectCoverToolSlot(cell, face.state, work.budget) : workToolSlot(cell, face.state);
        return startWorkBreak(face, item, cover, tool);
    }

    private boolean startWorkBreak(Face face, Item item, boolean cover, int tool) {
        if (tool < 0) return false;
        boolean diamondCover = cover && deepWork();
        if (tool != player.getInventory().selectedSlot) {
            startWorkStep(Verb.WORK_EQUIP, "Equip a suitable tool for " + blockName(face), face, null, null, null);
            action.workSlot = tool;
            action.diamondRoute = diamondCover;
            return true;
        }
        boolean lip = cover && AgentSurfaceTread.returnLip(player.getBlockPos(), face.hit.getBlockPos(),
            work.sourceSearch.cutBearing, face.hit.getSide());
        String label = diamondCover && diamondRoute.spareFloor ? "Cut one spare level floor for a returnable stair through "
            : diamondCover ? "Clear one witnessed diamond prospecting cell of "
            : lip ? "Clear a witnessed return lip of " : cover ? "Open a shallow window through witnessed " : "Harvest witnessed ";
        startWorkStep(Verb.BREAK, label + blockName(face), face, null, null, null);
        if (travelAnchorOutstanding() && scopedSourceHit(face.hit)) work.travelAnchorUsed = true;
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
        return dryWorkBreakRefusal(pos, block, drop, progress) == null;
    }

    private String dryWorkBreakRefusal(BlockPos pos, BlockState block, Item drop, AgentProgress progress) {
        if (pendingRouteSupport(pos) || diamondRoute.supports.contains(pos) || diamondRoute.attemptedSupports.contains(pos)
                || !progress.macroCanBreak(pos)) return "The cut would disturb a protected footing or workstation.";
        if (!block.getFluidState().isEmpty()) return "The witnessed block contains fluid.";
        BlockState above = world.getBlockState(pos.up());
        if (above.getBlock() instanceof FallingBlock) return "Falling material rests above the witnessed block.";
        if (station(above)) return "A workstation rests above the witnessed block.";
        if (drop != null && !roomFor(new ItemStack(drop))) return "The inventory has no room for the expected drop.";
        for (Direction side : Direction.values())
            if (!world.getBlockState(pos.offset(side)).getFluidState().isEmpty())
                return "Adjacent fluid vetoes the break.";
        return null;
    }

    private boolean deepWork() { return work != null && work.budget.policy.diamondProspecting(); }

    private BlockState diamondRecoverySupport(BlockPos foot) {
        if (!grounded() || player.isOnFire() || player.isInLava() || player.hurtTime != 0
                || player.getAbilities().flying || !dryProspectStance(foot) || unverifiedProspectSupport(foot.down())) return null;
        BlockState support = world.getBlockState(foot.down());
        return AgentProgress.dangerous(support) ? null : support;
    }

    private boolean recoverDiamondRoute() {
        BlockPos foot = player.getBlockPos();
        BlockState support = diamondRecoverySupport(foot);
        var recovery = walkedRoutes.recovery();
        if (!settled() || !body.hasRecentView() || !hazardClear || !surfaceBodyAllowsExtension()
                || !diamondRoute.reanchor(foot, support, player.getHorizontalFacing(),
                    recovery.path(work.recoveryProof, foot, support, player.getPos()), this::diamondLaneCurrent,
                    edge -> body.dryRouteSweep(foot, edge.upper()))) return false;
        recovery.clear();
        return true;
    }

    private void trackDiamondRecoveryWalk() {
        if (diamondRoute.unjoined == null || action.diamondRoute
                || action.intent == null && (!action.durable || deepWork())
                || walkedRoutes.recoveringWalk()) return;
        BlockPos foot = BlockPos.ofFloored(action.position);
        walkedRoutes.recovery().begin(action, foot, diamondRecoverySupport(foot), action.position);
    }

    private int deepTreads() { return diamondRoute.treads + diamondRoute.shelves + diamondRoute.rises + diamondRoute.levelLegs; }

    private boolean footOfDiamondTread(BlockPos foot, BlockPos cell) {
        return foot.equals(diamondRoute.foot) && diamondRoute.cutting && diamondRoute.grade == -1
            && cell.equals(AgentSurfaceTread.nextFoot(foot, diamondRoute.bearing));
    }

    private boolean diamondCutGeometry(BlockPos foot, BlockPos cell) {
        return diamondCutRefusal(foot, cell) == null && !diamondCutOverlaps(player.getBoundingBox(), cell);
    }

    private String diamondCutRefusal(BlockPos foot, BlockPos cell) {
        var route = diamondRoute;
        if (!foot.equals(route.foot)) return "The player left the selected prospect footing.";
        String stance = diamondCutStanceRefusal(foot);
        if (stance != null) return stance;
        if (route.supports.contains(cell) || surfaceSearch.footholds.contains(cell))
            return "The cut would remove a protected prospect footing.";
        if (!route.cutCell(cell)) return "The target is outside the current prospect cut envelope.";
        return null;
    }

    private String diamondCutStanceRefusal(BlockPos foot) {
        var route = diamondRoute;
        if (!settled()) return "The player is no longer settled at the selected prospect footing.";
        if (!dryProspectStance(foot) || route.foot != null && world.getBlockState(foot.down()) != route.support)
            return "The exact dry support at the prospect footing changed.";
        if (!diamondExitCurrent(foot)) return "The retained prospect return edge changed.";
        return null;
    }

    private String diamondCoverSafetyRefusal(BlockPos cell, BlockState block, Item debris, Direction bearing,
                                              AgentProgress progress) {
        if (client.options.attackKey.isUnbound()) return "The attack control is no longer bound.";
        if (body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65))
            return "Visible lava makes the selected cut unsafe.";
        return dryWorkBreakRefusal(cell, block, debris, progress);
    }

    /** One sampled level cut, shared by idle evidence and the paid level fallback. */
    private ProspectWall sampledDiamondWall(BlockPos foot, AgentProgress progress, AgentWorkOrder.Budget budget) {
        var route = diamondRoute;
        prospectWallSampled = false;
        prospectWallRefusal = route.unjoined != null ? "retained_route_unjoined"
            : route.foot != null && !foot.equals(route.foot) ? "retained_footing_changed"
            : route.spareFloor ? "spare_floor_in_progress"
            : budget != null && !budget.canCutCover() ? "cover_budget_exhausted"
            : client.options.attackKey.isUnbound() ? "attack_unbound" : diamondCutStanceRefusal(foot);
        if (prospectWallRefusal != null) return null;
        var bounds = player.getBoundingBox();
        prospectWallSampled = true;
        return body.sampledLevelWall(foot, surveyOrigin, reach(), (hit, state) -> {
            var cell = hit.getBlockPos();
            Direction bearing = hit.getSide().getOpposite();
            if (!route.open(bearing, 0) || route.cutting && (route.grade != 0 || route.bearing != bearing))
                return refuseProspectWall("bearing_not_available");
            if (route.attemptedSpareFloors.contains(cell) || surfaceSearch.footholds.contains(cell)
                    || route.supports.contains(cell) || !diamondSupportsUnprotected(foot, bearing, 0))
                return refuseProspectWall("protected_or_unverified_support");
            if (budget != null && work.rejected.contains(cell)) return refuseProspectWall("already_refused");
            if (diamondCutOverlaps(bounds, cell)) return refuseProspectWall("body_overlap");
            Item debris = AgentWorkOrder.prospectCoverDrop(state);
            // The first clue covers common rock only; no soil, ore, station or falling material.
            if (debris == Items.AIR || debris == Items.DIRT) return refuseProspectWall("not_stable_common_rock");
            if (budget != null && !budget.policy.prospectCoverAllowed(state))
                return refuseProspectWall("cover_material_not_authorized");
            String refusal = diamondCoverSafetyRefusal(cell, state, debris, bearing, progress);
            if (refusal != null) return refuseProspectWall(refusal);
            int slot = prospectCoverToolSlot(cell, state, budget);
            return slot < 0 ? refuseProspectWall(prospectCoverToolRefusal(slot)) : new ProspectWall(hit, state, bearing, slot);
        });
    }

    private ProspectWall refuseProspectWall(String reason) {
        if (prospectWallRefusal == null) prospectWallRefusal = reason;
        return null;
    }

    static boolean diamondCutOverlaps(Box playerBox, BlockPos cell) {
        int x = cell.getX(), y = cell.getY(), z = cell.getZ();
        return playerBox.minX - 0.1 < x + 1 && playerBox.maxX + 0.1 > x
            && playerBox.minY < y + 1 && playerBox.maxY > y
            && playerBox.minZ - 0.1 < z + 1 && playerBox.maxZ + 0.1 > z;
    }

    private boolean diamondExitCurrent(BlockPos foot) {
        var route = diamondRoute;
        var last = route.spine.peekLast();
        return (route.rootExit == null || diamondLaneCurrent(route.rootExit))
            && (last == null || retainedDiamondEdge(foot, last.edge));
    }

    private boolean prospectForDiamond(AgentProgress progress, Predicate<BlockState> wanted, BlockHitResult source) {
        BlockPos foot = player.getBlockPos();
        var inventory = player.getInventory();
        if (!AgentProspectTools.roomForDiamond(inventory)) {
            work.sourceBlock = "The inventory has no room for a diamond drop.";
            return false;
        }
        int harvest = AgentProspectTools.harvestSlot(inventory, null, world, foot, work.budget, prospectEquip);
        if (harvest < 0) {
            work.sourceBlock = diamondHarvestToolRefusal(harvest);
            return false;
        }
        if (!settled()) {
            enact("hold", "Settling before checking the next diamond prospecting tread.");
            return true;
        }
        if (!dryProspectStance(foot)) {
            if (startDiamondHorizon(wanted, source)) return true;
            work.sourceBlock = "Diamond descent needs stable full dry footing.";
            return false;
        }
        if (!surfaceBodyAllowsExtension()) return startDiamondHorizon(wanted, source);
        if (workTicksLeft() <= AgentSurfaceTread.ACTION_TICKS) {
            if (startDiamondHorizon(wanted, source)) return true;
            // No new physical edge starts with too little time to reach its verified endpoint.
            enact("hold", "At the last stable foothold: renew the finite lease to start another diamond prospecting tread.");
            return true;
        }
        var route = diamondRoute;
        BlockState currentSupport = world.getBlockState(foot.down());
        if (!foot.equals(route.foot)) {
            route.spine.clear(); // An independent work order or manual movement did not attest a connecting edge.
            route.rootExit = null;
            route.arrive(foot, currentSupport, player.getHorizontalFacing());
        } else if (route.support != currentSupport) {
            walkedRoutes.recovery().clear();
            route.interruptedAt(foot, null);
            work.sourceBlock = "The exact support at the retained prospect footing changed.";
            return false;
        }
        if (route.tunnel && !diamondExitCurrent(foot)) {
            var last = route.spine.peekLast();
            walkedRoutes.recovery().clear();
            route.interruptedAt(foot, last == null ? null : last.edge);
            work.sourceBlock = "The retained prospect return edge changed; no further tunnel work was authorized.";
            return false;
        }
        boolean scoped = travelAnchorOutstanding();
        if (!scoped && route.unjoined == null && route.needsGrantRecheck(work.budget))
            route.recheckGrant(work.budget, world::getBlockState, inventory);
        boolean reserveWall = !scoped && !route.cutting && !route.spareFloor && route.unjoined == null
            && work.budget.canCutCover() && !client.options.attackKey.isUnbound();
        if (reserveWall) body.reserveLevelWallRays();
        try {
            return prospectDiamondTread(foot, progress, wanted, source, scoped);
        } finally {
            if (reserveWall) body.releaseLevelWallRays();
        }
    }

    private boolean prospectDiamondTread(BlockPos foot, AgentProgress progress, Predicate<BlockState> wanted,
                                         BlockHitResult source, boolean scoped) {
        var route = diamondRoute;
        if (!route.spareFloor && (!scoped || source != null) && followDiamondLane(progress, source, true)) {
            action.scopedSourceLane = scoped;
            return true;
        }
        if (!scoped && prepareDiamondDeparture(foot)) return true;
        if (route.cutting) {
            if (scoped) return false;
            if (!route.spareFloor && followDiamondLane(progress, source, false)) return true;
            return prepareDiamondTread(progress, null);
        }
        // A positively proved descent gets first use of the next tread. A hinted
        // lower lip, a heading survey or a potential cut is not a proved descent.
        if (!scoped && startProvedDiamondDrop(foot, source)) return true;
        var oreTravel = selectDiamondSource(wanted, source, HorizonSelection.WORK);
        if (startOpticalHorizonSource(oreTravel)) return true;
        var caveTravel = selectCaveFrontier(HorizonSelection.WORK);
        if (startOpticalHorizonSource(caveTravel)) return true;
        if (scoped) return false;

        // The current frustum can show several useful faces without steering to any of them.
        BlockHitResult departureFloor = null;
        for (Direction bearing : CARDINAL) {
            var seen = rememberDiamondLevelCue(foot, bearing);
            if (!route.departureTried && seen != null && !station(route.levelFloorStates[bearing.ordinal()])
                    && diamondLevelExitCurrent(foot, bearing)
                    && (departureFloor == null || horizontalSquared(player.getPos(), seen.getPos())
                        < horizontalSquared(player.getPos(), departureFloor.getPos()))) departureFloor = seen;
        }
        for (int i = 0; i < CARDINAL.length; i++) {
            Direction bearing = route.sector(i);
            if (!diamondLaneCandidate(foot, bearing, -1) || !visibleDiamondLanding(foot, bearing, false)
                    || !body.dryRouteSweep(foot, foot.offset(bearing).down())) continue;
            route.select(bearing, -1, true);
            return prepareDiamondTread(progress, null);
        }
        if (followDiamondLane(progress, source, false)) return true;
        for (int i = 0; i < CARDINAL.length; i++) {
            Direction bearing = route.sector(i);
            if (!route.open(bearing, 0) || !diamondLevelExitCurrent(foot, bearing)) continue;
            if (!body.dryRouteSweep(foot, foot.offset(bearing))) continue;
            Vec3d center = Vec3d.ofBottomCenter(foot.offset(bearing));
            if (body.dryRouteClear(center.add(0, 1.32, 0)) != AgentBody.DryRouteSample.CLEAR
                    || body.dryRouteClear(center.add(0, 1.55, 0)) != AgentBody.DryRouteSample.CLEAR) continue;
            route.select(bearing, 0, true);
            return prepareDiamondTread(progress, null);
        }
        if (deferDiamondRays()) return true;
        if (tryDiamondDeparture(foot, departureFloor)) return true;
        for (int i = 0; i < CARDINAL.length; i++) {
            Direction bearing = route.sector(i);
            if (!diamondLaneCandidate(foot, bearing, -1) || !visibleDiamondLanding(foot, bearing, true)) continue;
            if (!AgentBody.drySurveyLaneCentered(foot, player.getX(), player.getZ(), bearing)) continue;
            route.select(bearing, -1, true);
            return prepareDiamondTread(progress, null);
        }
        if (startContactHorizonSource(oreTravel) || startContactHorizonSource(caveTravel)) return true;
        for (int i = 0; i < CARDINAL.length; i++) {
            Direction bearing = route.sector(i);
            // A lower top may be visible even when a wall still blocks the passage.
            if (!diamondLaneCandidate(foot, bearing, -1) || !visibleDiamondLanding(foot, bearing, false)) continue;
            BlockHitResult cut = diamondCutFace(foot, bearing, false, false);
            if (cut == null) continue;
            route.select(bearing, -1, true);
            return prepareDiamondTread(progress, null);
        }
        if (!route.glanced) {
            var survey = progress.drySurveyOffer();
            if (survey != null && diamondLaneCandidate(foot, survey.bearing(), -1)) {
                route.glanced = true;
                route.select(survey.bearing(), -1, false);
                startWorkCaveStep(Verb.DRY_SURVEY, "Check the missing landing witness at the visible lower lip",
                    progress, null, survey, true);
                return true;
            }
        }
        if (tryDiamondSpareFloor(foot, progress)) return true;
        if (deferDiamondRays()) return true;
        return tryDiamondLevelOrReturn(foot, progress);
    }

    private boolean startDiamondHorizon(Predicate<BlockState> wanted, BlockHitResult source) {
        var ore = selectDiamondSource(wanted, source, HorizonSelection.WORK);
        if (startOpticalHorizonSource(ore)) return true;
        var cave = selectCaveFrontier(HorizonSelection.WORK);
        return startOpticalHorizonSource(cave) || startContactHorizonSource(ore) || startContactHorizonSource(cave);
    }

    private boolean startProvedDiamondDrop(BlockPos foot, BlockHitResult source) {
        var route = diamondRoute;
        for (int i = 0; i < CARDINAL.length; i++) {
            Direction bearing = route.sector(i);
            BlockPos landing = foot.offset(bearing).down();
            if (source != null && !routeTowardSource(foot, landing, source)
                    || !diamondLaneCandidate(foot, bearing, -1) || !visibleDiamondLanding(foot, bearing, false)
                    || AgentProgress.dangerous(world.getBlockState(landing.down()))
                    || !AgentSurfaceTread.retainedLaneClear(client, foot, landing, bearing)
                    || !diamondSweepClear(foot, landing, bearing)) continue;
            Vec3d center = Vec3d.ofBottomCenter(landing);
            double dx = bearing.getOffsetX(), dz = bearing.getOffsetZ();
            if (body.dryRouteClear(center.add(0.07 * dx, 1.32, 0.07 * dz)) != AgentBody.DryRouteSample.CLEAR
                    || body.dryRouteClear(center.add(-0.23 * dx, 2.55, -0.23 * dz)) != AgentBody.DryRouteSample.CLEAR)
                continue;
            route.select(bearing, -1, false);
            return walkDiamondTread(foot, landing, bearing, null);
        }
        return false;
    }

    private static Direction departureBearing(BlockPos foot, BlockHitResult witness) {
        Vec3d point = witness.getPos();
        return Direction.fromHorizontalDegrees(heading(point.x - foot.getX() - 0.5, point.z - foot.getZ() - 0.5));
    }

    private static boolean distinctProspectLandmark(BlockPos foot, BlockHitResult hit) {
        return horizontalSquared(Vec3d.ofBottomCenter(foot), hit.getPos()) >= 0.64;
    }

    private void rememberProspectLandmark() {
        BlockPos foot = player.getBlockPos();
        if (!dryProspectStance(foot) || prospectLandmark != null && prospectLandmark.from(foot, tick)) return;
        var landmark = body.dryProspectLandmark(foot, AgentMacroControl::caveCueOre,
            hit -> distinctProspectLandmark(foot, hit));
        if (landmark != null) prospectLandmark = new ProspectLandmark(foot, landmark, tick, null);
    }

    /** A previously offered dry step supplies a bearing, never a fresh crossing. */
    private BlockHitResult previouslyOfferedExit(BlockPos foot) {
        var lead = prospectLandmark;
        if (lead == null || lead.approachSupport == null || !lead.from(foot, tick)) return null;
        BlockPos floor = lead.hit.getBlockPos(), landing = floor.up();
        Direction bearing = Direction.fromHorizontalDegrees(heading(landing.getX() - foot.getX(), landing.getZ() - foot.getZ()));
        return diamondRoute.open(bearing, 0) && !diamondRoute.supports.contains(floor)
            && world.getBlockState(floor) == lead.approachSupport
            && AgentSurfaceTread.retainedLaneClear(client, foot, landing, bearing)
            && !body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65) ? lead.hit : null;
    }

    private boolean tryDiamondDeparture(BlockPos foot, BlockHitResult adjacent) {
        var route = diamondRoute;
        if (!route.departing) {
            if (route.departureTried || route.glanced || !route.spine.isEmpty()) return false;
            BlockHitResult witness = adjacent;
            if (witness == null) witness = previouslyOfferedExit(foot);
            if (witness == null) {
                int vetoed = 0;
                for (Direction bearing : CARDINAL) {
                    Vec3d next = Vec3d.ofBottomCenter(foot.offset(bearing));
                    var near = body.dryCaveSpace(next.add(0, 0.48, 0));
                    if (near == AgentBody.DryRouteSample.FLUID || near == AgentBody.DryRouteSample.OBSTRUCTION)
                        vetoed |= directionBit(bearing);
                }
                final int vetoMask = vetoed;
                Predicate<BlockHitResult> eligible = hit -> distinctProspectLandmark(foot, hit)
                    && (vetoMask & directionBit(departureBearing(foot, hit))) == 0;
                witness = body.dryProspectLandmark(foot, AgentMacroControl::caveCueOre, eligible);
                if (witness == null && deferDiamondRays()) return true;
                if (witness == null && prospectLandmark != null && prospectLandmark.approachSupport == null
                        && prospectLandmark.from(foot, tick) && eligible.test(prospectLandmark.hit))
                    witness = prospectLandmark.hit;
            }
            if (witness == null) {
                route.departureTried = true;
                return false;
            }
            if (!route.beginDeparture(witness, tick)) return false;
            remember("Framing the " + route.preferred + " cave lane using " +
                (witness == adjacent ? "the currently witnessed adjacent top" :
                    prospectLandmark != null && witness == prospectLandmark.hit && prospectLandmark.approachSupport != null
                        ? "a previously reachable dry step" : "a cave landmark") + "; no step taken yet.");
        }
        return prepareDiamondDeparture(foot);
    }

    /** One inward adjustment from actual contact, concurrent with gaze toward the exit, not toward the feet. */
    private boolean prepareDiamondDeparture(BlockPos foot) {
        var route = diamondRoute;
        if (!route.departing) return false;
        if (tick >= route.departureUntil) {
            route.departing = false;
            return false;
        }
        // The landmark provides a bearing, not a click target. Aiming at the
        // near floor itself hid the lintel and made an open passage seem unusable.
        float yaw = route.departureYaw;
        body.turnFine(yaw, AgentBody.LEVEL_ROUTE_PITCH);
        if (!AgentBody.drySurveyLaneCentered(foot, player.getX(), player.getZ(), route.preferred)) {
            if (!body.centerOnGroundedSupport(foot, route.support)) {
                route.departing = false;
                return false;
            }
            route.departureShiftFrame = body.renderedFrame();
            enact("search", "Shift inward on the same dry support while looking toward the opening.");
            return true;
        }
        if (body.renderedFrame() > route.departureShiftFrame && !player.isSneaking()
                && body.renderedDirection(yaw, AgentBody.LEVEL_ROUTE_PITCH, 7)) {
            route.departing = false;
            return false;
        }
        enact("search", "Frame the visible passage ahead of the first step.");
        return true;
    }

    private boolean deferDiamondRays() {
        var route = diamondRoute;
        if (route.rayRetryUsed || !body.dryRouteRaysSpent()) return false;
        route.rayRetryUsed = route.freshRaysPending = true;
        work.sourceSearch.freshAfter = body.renderedFrame();
        enact("search", "Recheck the current cave view after its ray allocation was used.");
        return true;
    }

    private boolean followDiamondLane(AgentProgress progress, BlockHitResult source, boolean downward) {
        var offer = currentDryRoute(progress);
        if (offer == null || (offer.heightChange() < 0) != downward
                || workTicksLeft() <= AgentSurfaceTread.returnTicks(offer.edges())) return false;
        Direction bearing = diamondRoute.naturalBearing(offer, this::unverifiedProspectSupport);
        if (bearing == null || !diamondLaneCandidate(offer.from(), bearing, offer.heightChange())
                || source != null && !routeTowardSource(offer.from(), offer.endpoint(), source)) return false;
        if (offer.heightChange() == 0 && offer.edges() == 1 && work.budget.canCutCover()
                && diamondRoute.wantsForwardStair(source != null || sampledDiamondOrIron())) return false;
        diamondRoute.select(bearing, offer.heightChange(), false);
        startWorkCaveStep(Verb.FOLLOW, "Follow " + dryRouteDescription(offer) + " along the dry prospect lane",
            progress, offer, null, true);
        return true;
    }

    private boolean sampledDiamondOrIron() {
        return body.findSampled(state -> state.isIn(BlockTags.DIAMOND_ORES) || state.isIn(BlockTags.IRON_ORES),
            INSPECT_REACH, null).isPresent();
    }

    private boolean diamondLaneCandidate(BlockPos foot, Direction bearing, int grade) {
        return diamondRoute.open(bearing, grade) && diamondLaneSafe(foot, bearing, grade);
    }

    private boolean diamondLaneSafe(BlockPos foot, Direction bearing, int grade) {
        var route = diamondRoute;
        if (!diamondSupportsUnprotected(foot, bearing, grade)) return false;
        if (!body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65)) return true;
        route.refuse(bearing, grade, "Visible lava makes the planned lane unsafe.");
        return false;
    }

    private boolean diamondSupportsUnprotected(BlockPos foot, Direction bearing, int grade) {
        BlockPos floor = foot.add(bearing.getOffsetX(), grade - 1, bearing.getOffsetZ());
        return !diamondRoute.supports.contains(floor) && !unverifiedProspectSupport(floor);
    }

    private boolean visibleDiamondLanding(BlockPos foot, Direction bearing, boolean placement) {
        var to = foot.offset(bearing).down();
        Vec3d floor = Vec3d.ofBottomCenter(to).add(0.28 * bearing.getOffsetX(), -0.032, 0.28 * bearing.getOffsetZ());
        var top = body.dryRouteTop(floor, to.down(), true);
        return placement ? top == AgentBody.DryRouteTop.NO_FULL_TOP && work.budget.canPlaceProspectSupport(player.getInventory())
                && body.footholdSpace(floor) == AgentBody.FootholdSpace.EMPTY
            : top == AgentBody.DryRouteTop.WITNESSED;
    }

    private static int directionBit(Direction direction) { return 1 << direction.ordinal(); }

    private BlockHitResult rememberDiamondLevelCue(BlockPos foot, Direction bearing) {
        var route = diamondRoute;
        int bit = directionBit(bearing);
        BlockPos next = foot.offset(bearing);
        if (!diamondLaneCandidate(foot, bearing, 0)) return null;
        if ((route.levelFloors & bit) != 0) {
            if (world.getBlockState(next.down()) == route.levelFloorStates[bearing.ordinal()]) return null;
            route.levelFloors &= ~bit;
        }
        var hit = body.macroFloor(next.down());
        if (hit != null) {
            route.levelFloors |= bit;
            route.levelGaps &= ~bit;
            if (route.levelFloorStates == null) route.levelFloorStates = new BlockState[Direction.values().length];
            route.levelFloorStates[bearing.ordinal()] = world.getBlockState(next.down());
            return hit;
        }
        if (work.budget.canPlaceProspectSupport(player.getInventory())) {
            Vec3d top = Vec3d.ofBottomCenter(next).add(0.24 * bearing.getOffsetX(), -0.032, 0.24 * bearing.getOffsetZ());
            if (body.footholdSpace(top) == AgentBody.FootholdSpace.EMPTY) route.levelGaps |= bit;
        }
        return null;
    }

    private boolean tryDiamondSpareFloor(BlockPos foot, AgentProgress progress) {
        var route = diamondRoute;
        if (route.triedSpareFloor || route.levelFloors == 0) return false;
        route.triedSpareFloor = true;
        int candidates = 0, exits = 0;
        for (Direction bearing : CARDINAL) {
            if (!diamondLevelExitCurrent(foot, bearing)) continue;
            int bit = directionBit(bearing);
            if (route.open(bearing, 0)) exits |= bit;
            BlockPos cell = AgentSurfaceTread.nextFoot(foot, bearing);
            BlockState state = route.levelFloorStates[bearing.ordinal()];
            if (route.spareFloorCoverCurrent(bearing, state, work.budget)
                    && !route.attemptedSpareFloors.contains(cell) && !surfaceSearch.footholds.contains(cell)
                    && !work.rejected.contains(cell)
                    && dryWorkBreakSafe(cell, state, AgentWorkOrder.prospectCoverDrop(state), progress)) candidates |= bit;
        }
        boolean walkedReturn = candidates != 0 && retainedDiamondReturn(foot);
        int choices = AgentSurfaceTread.spareLevelFloorChoices(candidates, exits, walkedReturn);
        if (choices == 0) {
            remember(candidates == 0 ? "Diamond spare floor refused: no usable uncommitted cover fits the current grant."
                : "Diamond spare floor refused: no separate usable dry exit or intact walked return would remain.");
            return false;
        }
        for (int i = 0; i < CARDINAL.length; ++i) {
            Direction bearing = route.sector(i);
            if ((choices & directionBit(bearing)) == 0) continue;
            Direction exit = null;
            if (!walkedReturn) {
                for (Direction side : CARDINAL) {
                    if (side != bearing && (exits & directionBit(side)) != 0) {
                        exit = side;
                        break;
                    }
                }
            }
            route.selectSpareFloor(bearing, exit);
            return prepareDiamondTread(progress, null);
        }
        return false;
    }

    /** Promote the opened level column, not an unknown block below it or a wider sector. */
    private boolean tryDiamondForwardStair(BlockPos foot, BlockPos floor, AgentProgress progress) {
        var route = diamondRoute;
        Direction bearing = route.bearing;
        if (!work.budget.canCutCover() || !route.wantsForwardStair(sampledDiamondOrIron())
                || route.attemptedSpareFloors.contains(floor) || surfaceSearch.footholds.contains(floor)
                || work.rejected.contains(floor) || !diamondLaneCandidate(foot, bearing, -1)
                || workTicksLeft() <= Verb.BREAK.maxTicks + AgentSurfaceTread.ACTION_TICKS) return false;
        rememberDiamondLevelCue(foot, bearing);
        if ((route.levelFloors & directionBit(bearing)) == 0) {
            Vec3d opening = Vec3d.ofBottomCenter(floor.up()).add(0.24 * bearing.getOffsetX(), 0.78,
                0.24 * bearing.getOffsetZ());
            return deferDiamondRays() || inspectDiamondLane(opening, "Frame the opened passage and its spare forward floor.");
        }
        BlockState state = world.getBlockState(floor);
        if (!route.spareFloorCoverCurrent(bearing, state, work.budget)
                || !dryWorkBreakSafe(floor, state, AgentWorkOrder.prospectCoverDrop(state), progress)
                || prospectCoverToolSlot(floor, state, work.budget) < 0 || !retainedDiamondReturn(foot)) return false;
        if (AgentSurfaceTread.reverseClear(client, foot, floor, bearing)) {
            route.selectSpareFloor(bearing, null);
            return prepareDiamondTread(progress, null);
        }
        // A two-high opening may still need its forward lintel for the jump
        // back. If our own roof is too low, the same cut prepares the next
        // level stance instead; never remove the roof above the retained foot.
        Box forwardCrown = AgentSurfaceTread.reverseJumpHeadroom(floor.up(), player.getWidth());
        if (work.budget.breaksLeft() <= 2 || workTicksLeft() <= 2L * Verb.BREAK.maxTicks + AgentSurfaceTread.ACTION_TICKS
                || client.world.isSpaceEmpty(player, forwardCrown))
            return false;
        BlockPos lip = floor.up(3);
        if (work.rejected.contains(lip) || route.attemptedSpareFloors.contains(lip)
                || surfaceSearch.footholds.contains(lip)) return false;
        Vec3d point = Vec3d.ofCenter(lip, 0.07);
        var hit = body.perceive(point, Math.min(reach(), player.getEyePos().distanceTo(point) + 0.045)).orElse(null);
        if (hit == null || !lip.equals(hit.getBlockPos())) {
            return deferDiamondRays() || inspectDiamondLane(point, "Check the forward lintel for the reverse jump.");
        }
        BlockState lintel = world.getBlockState(lip);
        if (!work.budget.policy.prospectCoverAllowed(lintel) || !dryWorkBreakSafe(lip, lintel,
                AgentWorkOrder.prospectCoverDrop(lintel), progress) || prospectCoverToolSlot(lip, lintel, work.budget) < 0) return false;
        route.stairLip = true;
        return cutDiamondLane(hit, floor, progress);
    }

    private boolean diamondLevelExitCurrent(BlockPos foot, Direction bearing) {
        var route = diamondRoute;
        if ((route.levelFloors & directionBit(bearing)) == 0) return false;
        BlockPos next = foot.offset(bearing);
        BlockPos floor = next.down();
        BlockState witnessed = route.levelFloorStates[bearing.ordinal()];
        return !(witnessed.getBlock() instanceof FallingBlock) && world.getBlockState(floor) == witnessed
            && !unverifiedProspectSupport(floor)
            && !body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65)
            && AgentSurfaceTread.retainedLaneClear(client, foot, next, bearing);
    }

    private boolean retainedDiamondReturn(BlockPos foot) {
        var spine = diamondRoute.spine;
        var exit = diamondRoute.rootExit;
        var last = spine.isEmpty() ? exit : spine.getLast().edge;
        if (last == null) return false;
        if (!body.dryRouteSweep(foot, last.upper())) return false;
        for (var i = spine.descendingIterator(); i.hasNext();) {
            var edge = i.next().edge;
            if (!retainedDiamondEdge(foot, edge)) return false;
            foot = edge.upper();
        }
        return exit == null || retainedDiamondEdge(foot, exit);
    }

    private boolean retainedDiamondEdge(BlockPos foot, AgentSurfaceTread.Edge edge) {
        return edge.lower().equals(foot) && diamondLaneCurrent(edge);
    }

    private boolean diamondLaneCurrent(AgentSurfaceTread.Edge edge) {
        return world.getBlockState(edge.lower().down()) == edge.lowerSupport()
            && world.getBlockState(edge.upper().down()) == edge.upperSupport()
            && !unverifiedProspectSupport(edge.lower().down()) && !unverifiedProspectSupport(edge.upper().down())
            && body.walkedLaneDry(edge.upper(), edge.lower(), edge.down())
            && AgentSurfaceTread.retainedLaneClear(client, edge.upper(), edge.lower(), edge.down());
    }

    private boolean spareFloorEscapeCurrent(BlockPos foot, boolean fullSpine) {
        var route = diamondRoute;
        if (route.spareExit != null) return diamondLevelExitCurrent(foot, route.spareExit);
        if (fullSpine) return retainedDiamondReturn(foot);
        var back = route.spine.isEmpty() ? route.rootExit : route.spine.getLast().edge;
        return back != null && !body.hazardAhead(back.down().getOpposite().getPositiveHorizontalDegrees(), 1.65)
            && retainedDiamondEdge(foot, back);
    }

    private boolean tryDiamondLevelOrReturn(BlockPos foot, AgentProgress progress) {
        var route = diamondRoute;
        for (int option = 0; option < 3; ++option) {
            if (option == 1) {
                var wall = sampledDiamondWall(foot, progress, work.budget);
                noteProspectWall("paid", wall != null ? "candidate" : "denied", false);
                body.releaseLevelWallRays();
                if (wall != null) {
                    route.select(wall.bearing, 0, true);
                    return prepareDiamondTread(progress, null, wall);
                }
            }
            for (int i = 0; i < CARDINAL.length; ++i) {
                Direction bearing = route.sector(i);
                if (!diamondLaneCandidate(foot, bearing, 0)) continue;
                int bit = directionBit(bearing);
                boolean useful = switch (option) {
                    case 0 -> (route.levelFloors & bit) != 0;
                    case 1 -> diamondCutFace(foot, bearing, true, false) != null;
                    default -> (route.levelGaps & bit) != 0
                        && work.budget.canPlaceProspectSupport(player.getInventory());
                };
                if (!useful) continue;
                route.select(bearing, 0, true);
                return prepareDiamondTread(progress, null);
            }
        }
        DiamondSpine back = route.spine.peekLast();
        if (back != null && back.edge.lower().equals(foot)) {
            if (!retainedDiamondEdge(foot, back.edge)
                    || body.hazardAhead(back.edge.down().getOpposite().getPositiveHorizontalDegrees(), 1.65)) {
                walkedRoutes.recovery().clear();
                route.interruptedAt(foot, back.edge);
                work.sourceBlock = "The retained return lane is no longer dry and passable; no movement was authorized.";
                return false;
            }
            startSurfaceTread(back.edge, true);
            action.diamondRoute = true;
            return true;
        }
        if (deferDiamondRays()) return true;
        work.sourceBlock = (route.refusal == null ? "No lit dry lower shelf or returnable cut was verified in the visible sector." : route.refusal)
            + " " + (route.levelRefusal == null ? "No unvisited same-level floor or permitted side wall was witnessed."
                : "Level alternative refused: " + route.levelRefusal)
            + route.grantRefusalDetail()
            + (route.supportRefusal == null ? "" : " Attached support refused: " + route.supportRefusal)
            + " No further retained intersection to try.";
        return false;
    }

    private void startWorkCaveStep(Verb verb, String label, AgentProgress progress,
                                   AgentDryCaveRoute.Offer route, AgentDryCaveRoute.Survey survey, boolean diamond) {
        var offer = new Offer(null, new Key(verb, null, 0, null), label, "", 0, 0,
            null, null, null, null, null, route, null, survey);
        action = new Action(null, offer, client, tick, now, body.renderedFrame(), 0, NO_ANCHORS, Float.NaN);
        action.durable = true;
        action.diamondRoute = diamond;
        routeOwner = progress;
        work.detail = status = label;
        enact(verb == Verb.FOLLOW ? "route" : "search", label);
    }

    private boolean startDiamondSpareFloor(BlockPos foot, BlockPos floor, AgentProgress progress) {
        var route = diamondRoute;
        if (!diamondCutGeometry(foot, floor) || route.attemptedSpareFloors.contains(floor))
            return refuseDiamondBearing("The chosen floor is protected or has already had its one break attempt.");
        Vec3d over = Vec3d.ofBottomCenter(floor).add(0, 1.32, 0);
        Vec3d view = over.add(0, 0.46, 0);
        var hit = body.macroFloor(floor);
        if (hit == null) {
            if (deferDiamondRays()) return true;
            if (inspectDiamondLane(view, "Recheck the chosen spare floor and its passage before cutting.")) return true;
            return refuseDiamondBearing("The exact lit floor face could not be reached from the retained stance.");
        }
        BlockState state = world.getBlockState(floor);
        Item debris = AgentWorkOrder.prospectCoverDrop(state);
        if (!route.spareFloorCoverCurrent(route.bearing, state, work.budget)
                || work.rejected.contains(floor)
                || !dryWorkBreakSafe(floor, state, debris, progress))
            return refuseDiamondBearing("The exact floor changed or no longer fits the dry cover and break grant.");
        if (!AgentSurfaceTread.reverseClear(client, foot, floor, route.bearing))
            return refuseDiamondBearing("The chosen stair no longer has dry reverse headroom.");
        Vec3d entry = over.add(-0.23 * route.bearing.getOffsetX(), 1.23, -0.23 * route.bearing.getOffsetZ());
        var passage = body.dryRouteClear(over);
        var head = body.dryRouteClear(entry);
        if (passage != AgentBody.DryRouteSample.CLEAR || head != AgentBody.DryRouteSample.CLEAR) {
            if (deferDiamondRays()) return true;
            if (passage != AgentBody.DryRouteSample.FLUID && head != AgentBody.DryRouteSample.FLUID
                    && inspectDiamondLane(view, "Check the passage over the chosen spare floor.")) return true;
            return refuseDiamondBearing("No lit dry passage was verified above the spare floor; no break was issued.");
        }
        if (workTicksLeft() <= Verb.BREAK.maxTicks + AgentSurfaceTread.ACTION_TICKS)
            return refuseDiamondBearing("The lease cannot fit the floor break and rechecked tread.");
        if (!spareFloorEscapeCurrent(foot, true))
            return refuseDiamondBearing("The independent dry exit no longer holds.");
        int tool = prospectCoverToolSlot(floor, state, work.budget);
        if (tool < 0) return refuseDiamondBearing(prospectCoverToolRefusal(tool));
        if (!startWorkBreak(face(hit), debris, true, tool)) return false;
        if (action.offer.key.verb == Verb.BREAK) {
            route.attemptedSpareFloors.add(floor);
            remember("Diamond spare floor: chose " + route.bearing + " at Y=" + foot.getY() + "; kept "
                + (route.spareExit == null ? "the walked return spine." : "the distinct " + route.spareExit + " dry exit."));
        }
        return true;
    }

    private boolean prepareDiamondTread(AgentProgress progress, ItemEntity drop) {
        return prepareDiamondTread(progress, drop, null);
    }

    private boolean prepareDiamondTread(AgentProgress progress, ItemEntity drop, ProspectWall sampledWall) {
        var route = diamondRoute;
        BlockPos foot = player.getBlockPos();
        if (!foot.equals(route.foot) || world.getBlockState(foot.down()) != route.support || !settled()) {
            work.sourceBlock = "The exact grounded starting support for the next diamond tread changed.";
            return false;
        }
        Direction bearing = route.bearing;
        BlockPos lower = foot.offset(bearing).up(route.grade);
        // A spare-floor cut is a different, expressly budgeted plan, not another look
        // into an already refused natural drop. It still cannot bypass live safety vetoes.
        if (!(route.spareFloor ? diamondLaneSafe(foot, bearing, route.grade) : diamondLaneCandidate(foot, bearing, route.grade)))
            return refuseDiamondBearing("The selected lane is refused, revisits retained support, has an unconfirmed placement, or has visible lava.");
        if (route.spareFloor && !route.spareFloorBroken) return startDiamondSpareFloor(foot, lower, progress);
        if (route.grade == 0) {
            if (route.tunnel && diamondLaneCandidate(foot, bearing, -1) && visibleDiamondLanding(foot, bearing, false)
                    && AgentSurfaceTread.retainedLaneClear(client, foot, lower.down(), bearing)
                    && diamondSweepClear(foot, lower.down(), bearing)) {
                route.select(bearing, -1, true);
                return prepareDiamondTread(progress, drop);
            }
            switch (progress.dryLevelPassage(foot, lower)) {
                case HAZARD -> { return refuseDiamondBearing("A visible hazard vetoed the selected level passage."); }
                case WITNESSED -> {
                    if (diamondSweepClear(foot, lower, bearing))
                        return tryDiamondForwardStair(foot, lower.down(), progress)
                            || walkDiamondTread(foot, lower, bearing, drop);
                }
                case UNPROVED -> { }
            }
        }

        // Cuts and placements still need their original exact visual geometry.
        double dx = bearing.getOffsetX(), dz = bearing.getOffsetZ();
        Vec3d center = Vec3d.ofBottomCenter(lower);
        Vec3d floorAim = center.add(0.28 * dx, -0.032, 0.28 * dz);
        Vec3d floorSample = floorAim;
        var floor = body.dryRouteTop(floorAim, lower.down(), true);
        if (floor != AgentBody.DryRouteTop.WITNESSED && floor != AgentBody.DryRouteTop.FLUID) {
            Vec3d alternate = center.add(-0.22 * dx, -0.032, -0.22 * dz);
            var other = body.dryRouteTop(alternate, lower.down(), true);
            if (other == AgentBody.DryRouteTop.WITNESSED || other == AgentBody.DryRouteTop.FLUID
                    || floor == AgentBody.DryRouteTop.OUT_OF_VIEW) {
                floor = other;
                floorSample = alternate;
            }
        }
        var chest = body.dryRouteClear(center.add(0.07 * dx, 1.32, 0.07 * dz));
        var head = body.dryRouteClear(center.add(-0.23 * dx, 1.55 - route.grade, -0.23 * dz));
        if (diamondPassageFluid(floor, chest, head))
            return refuseDiamondBearing("Visible fluid vetoed the selected landing or its passage.");
        if ((floor == AgentBody.DryRouteTop.WITNESSED || floor == AgentBody.DryRouteTop.UNSUITABLE_TOP)
                && AgentProgress.dangerous(world.getBlockState(lower.down())))
            return refuseDiamondBearing("The witnessed landing support is dangerous.");

        // Fresh positive rays identify the actual passage and landing. Collision only vetoes that
        // identified lane; it never tells us what to mine or what undiscovered terrain is clear.
        boolean passage = chest == AgentBody.DryRouteSample.CLEAR && head == AgentBody.DryRouteSample.CLEAR;
        boolean reverse = AgentSurfaceTread.retainedLaneClear(client, foot, lower, bearing);
        if (route.witnessedGradeTread(floor, passage, reverse)) {
            if (!diamondSweepClear(foot, lower, bearing))
                return refuseDiamondBearing("The witnessed tread has no safe crossing from the actual dry stance.");
            return walkDiamondTread(foot, lower, bearing, drop);
        }
        if (passage && reverse && floor == AgentBody.DryRouteTop.NO_FULL_TOP && !route.spareFloor)
            return startProspectSupport(foot, lower, bearing, floorSample, progress);
        // A wall can hide the eventual landing. This admits only the seen wall
        // from the current safe stance; the next frame must still prove a crossing.
        if (sampledWall != null)
            return cutDiamondLane(sampledWall.hit, lower, progress, sampledWall.toolSlot);
        var cut = route.spareFloor ? null : diamondCutFace(foot, bearing, route.grade == 0, !reverse);
        if (cut != null) return cutDiamondLane(cut, lower, progress);
        if (floor == AgentBody.DryRouteTop.UNSUITABLE_TOP)
            return refuseDiamondBearing("The planned support is visible, but it is not a stable full dry upper face.");
        if (deferDiamondRays()) return true;
        if (floor == AgentBody.DryRouteTop.DARK || chest == AgentBody.DryRouteSample.DARK
                || head == AgentBody.DryRouteSample.DARK) {
            if (!route.spareFloor) return lightDiamondTread();
            return refuseDiamondBearing("The spare-floor cut did not reveal a lit reversible tread; staying on the original support.");
        }
        if (!reverse && passage && floor == AgentBody.DryRouteTop.WITNESSED)
            return refuseDiamondBearing("The witnessed tread does not have a safe body-width crossing and return sweep.");
        Vec3d view = center.add(0.24 * dx, 0.78 - route.grade, 0.24 * dz);
        if (inspectDiamondLane(view, floor == AgentBody.DryRouteTop.WITNESSED
                ? route.grade == 0 ? "Check the visible lower passage of the chosen dry lane."
                    : "Check clearance over the chosen dry passage."
                : "Check for a landing under the chosen opening.")) return true;
        return refuseDiamondBearing("The selected opening did not give a lit, dry landing and a clear reversible passage.");
    }

    static boolean diamondPassageFluid(AgentBody.DryRouteTop floor, AgentBody.DryRouteSample chest,
                                       AgentBody.DryRouteSample head) {
        return floor == AgentBody.DryRouteTop.FLUID || chest == AgentBody.DryRouteSample.FLUID
            || head == AgentBody.DryRouteSample.FLUID;
    }

    /** Only visible faces in the selected cut envelope. Probe the useful opening first, not the roof overhead. */
    private BlockHitResult diamondCutFace(BlockPos foot, Direction bearing, boolean level, boolean reverseVeto) {
        BlockPos next = foot.offset(bearing);
        BlockHitResult cover = null, source = null;
        for (int i = 0; i < (level ? 2 : reverseVeto ? 5 : 3); ++i) {
            BlockPos cell = switch (i) {
                case 0 -> next.up();
                case 1 -> next;
                case 2 -> next.down();
                case 3 -> next.up(2);
                default -> foot.up(2);
            };
            Vec3d point = i == 2 ? Vec3d.ofCenter(cell, 0.88).add(0.18 * bearing.getOffsetX(), 0,
                0.18 * bearing.getOffsetZ()) : Vec3d.ofCenter(cell);
            var hit = body.perceive(point, Math.min(reach(), player.getEyePos().distanceTo(point) + 0.045)).orElse(null);
            if (hit == null || !cell.equals(hit.getBlockPos())) continue;
            BlockState state = world.getBlockState(cell);
            if (!state.getFluidState().isEmpty() || AgentProgress.dangerous(state) || station(state)) return hit;
            if (diamondRoute.supports.contains(cell) || surfaceSearch.footholds.contains(cell)
                    || work.rejected.contains(cell)) continue;
            if (AgentWorkOrder.harvest(state) == Items.DIAMOND && work.budget.policy.breakAllowed(state)) {
                if (source == null) source = hit;
            } else if (cover == null) cover = hit;
        }
        return source == null ? cover : source;
    }

    private boolean cutDiamondLane(BlockHitResult hit, BlockPos landing, AgentProgress progress) {
        return cutDiamondLane(hit, landing, progress, -1);
    }

    private boolean cutDiamondLane(BlockHitResult hit, BlockPos landing, AgentProgress progress, int sampledTool) {
        BlockPos target = hit.getBlockPos();
        BlockState block = world.getBlockState(target);
        if (!block.getFluidState().isEmpty() || AgentProgress.dangerous(block))
            return refuseDiamondBearing("A visible hazard occupies the planned cut envelope.");
        if (station(block)) return refuseDiamondBearing("A workstation occupies the planned cut envelope.");
        String geometry = diamondCutRefusal(player.getBlockPos(), target);
        if (geometry != null) return refuseDiamondBearing(geometry);
        if (AgentProspectTools.isOre(block) && work.budget.policy.breakAllowed(block)) {
            if (!workResourceSafe(hit, block, progress))
                return refuseDiamondBearing(AgentProspectTools.roomForDiamond(player.getInventory())
                    ? "The witnessed diamond face does not pass the safe harvest checks."
                    : "The inventory has no room for a diamond drop.");
            int tool = workToolSlot(target, block);
            return tool < 0 ? refuseDiamondBearing(diamondHarvestToolRefusal(tool))
                : startWorkBreak(face(hit), Items.DIAMOND, false, tool);
        }
        Item debris = AgentWorkOrder.prospectCoverDrop(block);
        if (diamondRoute.grade < 0 && target.equals(landing) && (hit.getSide() == Direction.UP
                || (diamondRoute.levelFloors & directionBit(diamondRoute.bearing)) != 0))
            return refuseDiamondBearing("Preserving the witnessed same-level floor instead of cutting "
                + Registries.BLOCK.getId(block.getBlock()) + ".");
        if (debris == Items.AIR)
            return refuseDiamondBearing("The selected passage exposes " + Registries.BLOCK.getId(block.getBlock())
                + "; it is not eligible diamond prospecting cover.");
        String unsafe = diamondCoverSafetyRefusal(target, block, debris, diamondRoute.bearing, progress);
        if (unsafe != null) return refuseDiamondBearing(unsafe);
        String grantRefusal = diamondRoute.cutGrantRefusal(work.budget, target, block);
        if (grantRefusal != null) {
            enact("search", grantRefusal);
            return true;
        }
        int tool = sampledTool < 0 ? prospectCoverToolSlot(target, block, work.budget) : sampledTool;
        if (tool < 0)
            return refuseDiamondBearing(prospectCoverToolRefusal(tool) + " Witnessed cover: "
                + Registries.BLOCK.getId(block.getBlock()) + ".");
        if (diamondCutOverlaps(player.getBoundingBox(), target)) {
            BlockPos foot = player.getBlockPos();
            if (!diamondRoute.cutInsetCurrent(tick) || !body.centerOnGroundedSupport(foot, diamondRoute.support))
                return refuseDiamondBearing("The target overlaps the protected margin of the current stance.");
            work.sourceSearch.freshAfter = body.renderedFrame();
            enact("search", "Shift inward on the same dry support to clear the selected wall.");
            return true;
        }
        return startWorkBreak(face(hit), debris, true, tool);
    }

    private boolean diamondSweepClear(BlockPos foot, BlockPos lower, Direction bearing) {
        return body.dryRouteSweep(foot, lower) && body.walkedLaneDry(foot, lower, bearing);
    }

    private boolean walkDiamondTread(BlockPos foot, BlockPos lower, Direction bearing, ItemEntity drop) {
        var route = diamondRoute;
        if (route.spareFloor && !spareFloorEscapeCurrent(foot, true))
            return refuseDiamondBearing("The independent exit no longer holds; staying on the original footing.");
        if (workTicksLeft() <= AgentSurfaceTread.ACTION_TICKS) return false;
        var edge = new AgentSurfaceTread.Edge(foot, route.support, lower, world.getBlockState(lower.down()), bearing);
        startSurfaceTread(edge, false, AgentSurfaceTread.witnessedOutbound(edge, tick));
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
        BlockPos cell = to.down();
        if (diamondRoute.attemptedSupports.contains(cell) || diamondRoute.supports.contains(cell)
                || surfaceSearch.footholds.contains(cell) || !progress.macroCanBreak(cell))
            return refuseDiamondBearing("The support cell is protected or already had its one placement attempt.");
        var space = body.footholdSpace(emptyTop);
        if (space == AgentBody.FootholdSpace.VIEW && deferDiamondRays()) return true;
        if (space != AgentBody.FootholdSpace.EMPTY)
            return refuseDiamondBearing(gap + " The exact fill cell was not witnessed empty and dry.");
        if (client.options.useKey.isUnbound() || !player.getOffHandStack().isEmpty())
            return refuseDiamondBearing("An attached support needs a bound use control and an empty off hand.");
        String grantRefusal = diamondRoute.placeGrantRefusal(work.budget, cell, world.getBlockState(cell),
            Items.COBBLESTONE, player.getInventory());
        if (grantRefusal != null) {
            enact("search", grantRefusal);
            return true;
        }
        if (workTicksLeft() <= Verb.WORK_PLACE.maxTicks + AgentSurfaceTread.ACTION_TICKS) {
            enact("hold", "Renew the lease before starting a support placement and its proved crossing.");
            return true;
        }
        startWorkStep(Verb.WORK_PLACE, "Check one attached cobblestone support from the current dry stance",
            null, null, Items.COBBLESTONE, null);
        action.diamondRoute = true;
        action.prospectSupport = new ProspectSupport(foot, to, bearing);
        body.pauseWork(); // Keep the useful corridor-end view; no speculative contact has been admitted.
        return true;
    }

    private boolean unverifiedProspectSupport(BlockPos cell) {
        return diamondRoute.attemptedSupports.contains(cell) && !diamondRoute.placedSupports.contains(cell);
    }

    private boolean inspectDiamondLane(Vec3d point, String reason) {
        var route = diamondRoute;
        if (route.lookPoint == null) {
            if (route.glanced || body.renderedAim(point, 8)) return false;
            route.glanced = true;
            route.lookPoint = point;
            route.lookUntil = tick + 15;
        }
        if (tick >= route.lookUntil || body.renderedAim(route.lookPoint, 8)) {
            route.lookPoint = null;
            return false;
        }
        body.aim(route.lookPoint);
        enact("search", reason);
        return true;
    }

    private boolean refuseDiamondBearing(String detail) {
        if (diamondRoute.spareFloor) {
            detail = "Diamond spare floor refused: " + detail;
            remember(detail);
        }
        diamondRoute.refuseCurrent(detail);
        enact("search", detail);
        return true;
    }

    private boolean lightDiamondTread() {
        BlockPos foot = player.getBlockPos();
        BlockState state = world.getBlockState(foot);
        if (state.isOf(Blocks.TORCH))
            return refuseDiamondBearing("The placed light does not reveal a usable dry tread on this bearing.");
        if (client.options.useKey.isUnbound())
            return refuseDiamondBearing("The tread is too dark and the use control is unbound.");
        String grantRefusal = diamondRoute.placeGrantRefusal(work.budget, foot, state, Items.TORCH, player.getInventory());
        if (grantRefusal != null) {
            enact("search", grantRefusal);
            return true;
        }
        startWorkStep(Verb.WORK_PLACE, "Light the current dry foothold with one explicitly budgeted torch", null,
            null, Items.TORCH, null);
        action.diamondRoute = action.prospectLight = true;
        return true;
    }

    private boolean earlySourceAvailable(Predicate<BlockState> wanted) {
        for (BlockState source : AgentWorkOrder.EARLY_SOURCES) {
            if (wanted.test(source) && workToolSlot(player.getBlockPos(), source) >= 0
                    && roomFor(new ItemStack(AgentWorkOrder.harvest(source)))) return true;
        }
        return false;
    }

    private boolean prospectForSource(AgentProgress progress, Predicate<BlockState> wanted) {
        BlockPos foot = player.getBlockPos();
        var search = work.sourceSearch;
        if (!earlySourceAvailable(wanted)) {
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
        if (search.firstCover != null) {
            work.sourceBlock = "The one shallow window is elsewhere, and no unvisited dry foothold is in view.";
            return false;
        }
        if ("constrained".equals(ipc.workMode) && AgentWorkOrder.earlySurfaceStock(work.budget.policy.target().item())) {
            work.sourceBlock = "The first shallow cut requires an exact, freshly witnessed surface opening in the work grant.";
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
        if (prospectBodyUsable()) return true;
        work.sourceBlock = "The player's health, food, or available climb controls do not support extending the staircase.";
        return false;
    }

    private boolean prospectBodyUsable() {
        return player.getHealth() > player.getMaxHealth() / 2 && player.getHungerManager().getFoodLevel() > 6
            && !client.options.forwardKey.isUnbound() && !client.options.jumpKey.isUnbound();
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
            ? search.firstCover == null && witnessedSurfaceTop(foot, hit)
            : search.stairs.getLast().lower().equals(foot)
                && (AgentSurfaceTread.plannedCell(foot, cell, search.cutBearing, hit.getSide())
                    || AgentSurfaceTread.returnLip(foot, cell, search.cutBearing, hit.getSide()));
    }

    private boolean retainedProspectStance(BlockPos foot, BlockPos cell, SourceSearch search) {
        BlockState support = search.stairs.isEmpty() ? search.cutSupport : search.stairs.getLast().lowerSupport();
        return dryProspectStance(foot) && settled()
            && (support == null || world.getBlockState(foot.down()) == support)
            && retainedCutSpace(foot, cell, player.getBoundingBox(), search.footholds);
    }

    static boolean firstSurfaceCap(BlockPos foot, BlockHitResult hit, Box avatar, Set<BlockPos> retained) {
        return witnessedSurfaceTop(foot, hit) && retainedCutSpace(foot, hit.getBlockPos(), avatar, retained);
    }

    private static boolean witnessedSurfaceTop(BlockPos foot, BlockHitResult hit) {
        return hit != null && !hit.isInsideBlock() && AgentBody.matchesDryRouteTop(hit, hit.getBlockPos())
            && prospectBearing(foot, hit.getBlockPos(), hit.getSide()) != null;
    }

    private static boolean retainedCutSpace(BlockPos foot, BlockPos cell, Box avatar, Set<BlockPos> retained) {
        return !retained.contains(cell) && !cell.equals(foot.down())
            && !avatar.expand(0.14, 0, 0.14).intersects(new Box(cell.getX(), foot.getY(), cell.getZ(),
                cell.getX() + 1, foot.getY() + 2, cell.getZ() + 1));
    }

    /** Only a positively witnessed neighboring cap can open the first tread. */
    static Direction prospectBearing(BlockPos foot, BlockPos cell, Direction side) {
        if (side == Direction.UP && cell.getY() == foot.getY() - 1) {
            for (Direction into : CARDINAL) if (cell.equals(foot.down().offset(into))) return into;
        }
        return null;
    }

    private int workToolSlot(BlockPos pos, BlockState block) {
        var inventory = player.getInventory();
        if (deepWork() && AgentProspectTools.isOre(block))
            return AgentProspectTools.harvestSlot(inventory, block, world, pos, work.budget, prospectEquip);
        int best = -1;
        float speed = 0;
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; i++) {
            ItemStack hand = inventory.getStack(i);
            if (block.isToolRequired() && !hand.isSuitableFor(block)) continue;
            if (!AgentMiningStock.lootCompatible(hand, block)) continue;
            int loss = AgentMiningStock.maxLoss(hand, block, world, pos);
            if (loss < 0 || loss > 0 && work.budget.limit(hand.getItem(), count(hand.getItem())) < loss) continue;
            float candidate = hand.getMiningSpeedMultiplier(block);
            if (candidate > speed || candidate == speed && i == inventory.selectedSlot) {
                best = i;
                speed = candidate;
            }
        }
        return best;
    }

    private int prospectCoverToolSlot(BlockPos pos, BlockState cover, AgentWorkOrder.Budget budget) {
        return AgentProspectTools.coverSlot(player.getInventory(), cover, world, pos, budget,
            budget == null && work != null ? work.budget : null, prospectEquip);
    }

    private static String diamondHarvestToolRefusal(int result) {
        return switch (result) {
            case AgentProspectTools.HARVEST_PROTECTED ->
                "The remaining suitable diamond harvest would break a tool protected by its reserve floor.";
            case AgentProspectTools.HARVEST_UNPRICED ->
                "The remaining suitable diamond harvest would break a tool without enough remaining cost allowance.";
            case AgentProspectTools.HARVEST_UNKNOWN_WEAR ->
                "The wear of the suitable diamond-harvesting tool cannot be bounded.";
            case AgentProspectTools.HARVEST_UNEQUIPPABLE ->
                "No suitable diamond-harvesting tool can be equipped with the current controls.";
            case AgentProspectTools.HARVEST_BREAKS_SPENT -> "The diamond ore break grant is spent.";
            default -> "No carried tool can harvest a diamond drop from the permitted ore.";
        };
    }

    private static String prospectCoverToolRefusal(int result) {
        return switch (result) {
            case AgentProspectTools.COVER_LOSES_HARVEST ->
                "No suitable cover tool can take this wear and leave a policy-admissible diamond harvest.";
            case AgentProspectTools.COVER_UNKNOWN_WEAR -> "The wear of the suitable cover tool cannot be bounded.";
            case AgentProspectTools.COVER_STOCK_PROTECTED -> "Cutting this cover would break a tool protected by its reserve floor.";
            case AgentProspectTools.COVER_UNPRICED -> "Cutting this cover would break a tool without enough remaining cost allowance.";
            default -> "No equippable tool can harvest the expected drop from this cover.";
        };
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
        startSurfaceTread(edge, returning, new AgentSurfaceTread(edge, returning, tick));
    }

    private void startSurfaceTread(AgentSurfaceTread.Edge edge, boolean returning, AgentSurfaceTread tread) {
        boolean level = edge.upper().getY() == edge.lower().getY();
        String label = deepWork() && returning ? "Return over the next retained dry edge toward an earlier sector"
            : returning ? "Climb the witnessed reverse surface stair edge"
            : level ? "Walk to a distinct witnessed same-level footing with a return edge"
            : "Check and descend one witnessed dry tread with a return edge";
        startWorkStep(Verb.WORK_TREAD, label, null, null, null, null);
        action.tread = tread;
        action.distanceLeft = player.getPos().squaredDistanceTo(Vec3d.ofBottomCenter(action.tread.to));
    }

    private void advanceSurfaceTread(AgentProgress progress) {
        trackDiamondRecoveryWalk();
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
                body.recordWalkedLeg(tread.from, tread.to);
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
        status = verb == Verb.WORK_SMELT && action.furnace.phase != null ? work.detail : action.offer.summary;
        if (tick - action.started > verb.maxTicks) {
            interrupt(timeoutDetail(), true);
        } else if (!hazardClear || !client.isWindowFocused() || client.getOverlay() != null
                || client.interactionManager == null || client.interactionManager.getCurrentGameMode() != GameMode.SURVIVAL
                || !(grounded() || action.horizonTravel != null && body.horizonSafetyAllows(action.horizonTravel)
                    || (verb == Verb.WORK_WALK || verb == Verb.WORK_TREAD
                        || verb == Verb.FOLLOW && progress.dryRouteInFlight(action.offer.route))
                    && !player.isTouchingWater() && !player.hasVehicle())) {
            interrupt("The work step lost its safe footing, focus or Survival controls.", true);
        } else if (work.foodClue != null && verb == Verb.WORK_WALK &&
                (!foodFooting(progress) || missingWorkFloor() != null || !localFoodPoint(work.foodClue.food.origin, player.getPos())
                    || !action.offer.drop.isRemoved() && !localFoodPoint(work.foodClue.food.origin, action.offer.drop.getPos()))) {
            interrupt("Food collection lost the dry leash or protected reserves.", true);
        } else if (verb == Verb.BREAK && !action.broken && !work.sourceSearch.stairs.isEmpty()
                && !surfaceLeaseAllowsBreak(work.sourceSearch, Math.max(1, verb.maxTicks - (tick - action.started)))) {
            interrupt("The remaining lease is reserved for the verified stair return.", true);
        } else {
            BlockPos pickupGround = null;
            if (fungibleStockPickup() && action.offer.face != null
                    && (verb == Verb.WORK_WALK && action.horizonKind == RESOURCE
                        || verb == Verb.BREAK && !action.prospectCover && action.tracked != null
                            && action.offer.face.hit.getBlockPos().getY() >= player.getBlockY()))
                pickupGround = action.offer.face.hit.getBlockPos();
            switch (verb) {
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
                case WORK_FORAGE -> advanceFoodWork(progress);
                default -> step(progress);
            }
            // Do not steal terrain rays from the active approach or alter its look or contact.
            if (pickupGround != null) body.visibleHorizon().witnessPickupGround(pickupGround);
        }
    }

    private boolean waterFooting(Floor floor) {
        return grounded() && hazardClear && !urgent && ironFooting(floor.pos) && body.keysNeutral()
            && !player.isSneaking() && !player.isSprinting()
            && horizontalSquared(player.getPos(), floor.landing) <= 0.0144
            && world.getBlockState(floor.pos) == floor.state;
    }

    private boolean foodFooting(AgentProgress progress) {
        return grounded() && hazardClear && !urgent && progress.macroFoodSafe() && cursorClear()
            && client.currentScreen == null && !player.isUsingItem() && !player.isSprinting() && !player.isSneaking()
            && !client.interactionManager.isBreakingBlock() && client.getCameraEntity() == player
            && client.options.getPerspective().isFirstPerson();
    }

    private boolean localFoodPoint(Vec3d origin, Vec3d point) {
        return Math.abs(point.y - origin.y) <= 0.75 && point.squaredDistanceTo(origin) <= AgentFoodWork.LEASH * AgentFoodWork.LEASH;
    }

    private Entity currentFoodAnimal(FoodClue clue) {
        return body.visibleEntity(entity -> entity == clue.animal && AgentFoodWork.adult(entity) == clue.source
            && localFoodPoint(clue.origin, entity.getPos()), AgentFoodWork.LEASH + 0.5).orElse(null);
    }

    private boolean foodHandCurrent(FoodClue clue) {
        var inventory = player.getInventory();
        ItemStack hand = inventory.getStack(clue.slot);
        return hands.canEquipSlot(inventory, clue.slot) && (clue.source.animal()
            ? hand.isOf(clue.hand) && AgentFoodWork.safeWeapon(hand) : hand.isEmpty() && player.getOffHandStack().isEmpty());
    }

    private boolean foodClueCurrent(Offer offer, AgentProgress progress) {
        var clue = offer.food;
        return foodFooting(progress) && progress.macroFoodRelevant() && ironFooting(player.getBlockPos().down())
            && player.getPos().squaredDistanceTo(clue.origin) <= 0.0144 && foodHandCurrent(clue)
            && roomFor(clue.source.stock) && (clue.source.animal()
                ? !client.options.attackKey.isUnbound() && currentFoodAnimal(clue) != null
                : useAvailable() && visible(offer.face));
    }

    private void advanceFoodWork(AgentProgress progress) {
        var offer = work.foodClue;
        var clue = offer.food;
        if (!foodFooting(progress) || missingWorkFloor() != null || !localFoodPoint(clue.origin, player.getPos())
                || !roomFor(clue.source.stock) || !action.walkInventory.unchanged(player.getInventory())) {
            interrupt("The local food footing, reserves, space, or carried stock changed before collection.", true);
            return;
        }
        if (!body.hasRecentView()) return;
        Entity animal = clue.source.animal() ? currentFoodAnimal(clue) : null;
        if (animal != null) action.foodLastSeen = animal.getPos();
        if (action.fired && (!clue.source.animal() || animal == null)) {
            Vec3d source = action.foodLastSeen;
            if (source != null && tick - action.firedAt <= AgentFoodWork.DROP_TICKS) {
                ItemEntity drop = (ItemEntity) body.visibleEntity(entity -> entity instanceof ItemEntity item
                    && item.getStack().isOf(clue.source.item) && horizontalSquared(item.getPos(), source) <= 2.25
                    && localFoodPoint(clue.origin, item.getPos()) && pickupEligible(item)
                    && roomFor(item.getStack()), 6).orElse(null);
                if (drop != null) {
                    startWorkPickup(drop);
                    return;
                }
                body.aim(source);
                return;
            }
            interrupt("No matching rendered food drop was available at the witnessed source.", true);
            return;
        }
        if (!foodHandCurrent(clue) || clue.source.animal() && (animal == null || client.options.attackKey.isUnbound())
                || !clue.source.animal() && (!useAvailable() || !visible(offer.face))) {
            interrupt("The one food contact, held tool, or vanilla input no longer qualifies.", true);
            return;
        }
        if (hands.busy()) {
            if (action.craftJob != hands.jobGeneration()) interrupt("The food action lost its hotbar selection.", true);
            else hands.tick();
            return;
        }
        if (player.getInventory().selectedSlot != clue.slot) {
            if (action.craftJob != 0 || hands.equipSlot(clue.slot) || !hands.busy()) {
                interrupt("The existing hotbar item could not be selected.", true);
            } else action.craftJob = hands.jobGeneration();
            return;
        }
        if (animal == null) {
            if (!ironFooting(player.getBlockPos().down()) || player.getPos().squaredDistanceTo(clue.origin) > 0.0144) {
                interrupt("Picking the exact ripe block requires the original dry stance.", true);
            } else if (body.aimContact(offer.face.hit, AgentBody.Contact.INTERACT)
                    && body.useContact(offer.face.hit, AgentBody.Contact.INTERACT)) {
                action.fired = true;
                action.firedAt = tick;
                action.foodLastSeen = Vec3d.ofCenter(offer.face.hit.getBlockPos());
            }
            return;
        }
        if (action.foodSwings >= AgentFoodWork.MAX_SWINGS) {
            if (tick - action.firedAt > AgentFoodWork.DROP_TICKS)
                interrupt("The bounded attacks on this exact adult food animal are exhausted.", true);
            return;
        }
        Vec3d point = animal.getBoundingBox().getCenter();
        double reach = Math.min(2.8, player.getEntityInteractionRange() - 0.1);
        if (player.getEyePos().squaredDistanceTo(point) > reach * reach) {
            if (!localFoodPoint(clue.origin, player.getPos().add(animal.getPos().subtract(player.getPos()).normalize().multiply(0.5)))
                    || !progress.approachMacroFood(animal.getPos()))
                interrupt("No witnessed dry level step remains toward the exact food animal.", true);
            return;
        }
        body.aim(point);
        if (settled() && body.strikeTarget(animal) && player.getAttackCooldownProgress(0.5f) >= 0.9f) {
            body.strike(animal);
            ++action.foodSwings;
            action.fired = true;
            action.firedAt = tick;
        }
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
        if (action.offer.drop != null) {
            advanceWorkPickup();
            return;
        }
        if (action.ordinaryGrade != null) {
            advanceOrdinaryGrade();
            return;
        }
        if (action.horizonTravel != null) {
            if ((action.horizonKind == WOODLAND_FRONTIER || action.horizonKind == RESOURCE && timberBlock(action.offer.face.state))
                    && action.horizonTravel.moved()) action.timberApproached = true;
            advanceHorizonWork(progress);
            return;
        }
        double distance = horizontalSquared(player.getPos(), action.destination);
        if (action.drove && distance + 0.008 < action.distanceLeft) {
            action.distanceLeft = distance;
            continuityWork = AgentPauseEpisodes.Work.ROUTE;
        }
        if (!body.hasRecentView()) return;
        if (horizontalSquared(action.position, player.getPos()) >= 0.16
                && (distance <= 1.35 * 1.35 || visibleFace(action.offer.face))) {
            if (settled()) complete("Reached a closer safe stance for the retained witnessed target.");
            return;
        }
        if (!progress.macroWorkWalk(action.destination, pendingEntry() != null)) {
            interrupt("No safe visible lane remains toward the retained target.", true);
        }
    }

    private void advanceWorkPickup() {
        Offer offer = action.offer;
        ItemEntity drop = offer.drop;
        String mismatch = unexpectedPickup();
        if (mismatch != null) {
            interrupt(mismatch, true);
            return;
        }
        boolean fungibleStock = fungibleStockPickup();
        int gain = count(offer.item) - action.itemCount;
        if (gain > 0 && (fungibleStock || drop.isRemoved())) {
            body.visibleHorizon().reportPickupUnseen(drop, "inventory_gain");
            body.pauseWork();
            continuityWork = AgentPauseEpisodes.Work.NOVELTY;
            complete("Vanilla confirmed a " + gain + " item gain of " + Registries.ITEM.getId(offer.item)
                + (fungibleStock ? " in authorized stock." : " after collecting its witnessed drop."));
            return;
        }
        if (drop.isRemoved()) {
            body.visibleHorizon().reportPickupUnseen(drop, "entity_removed");
            body.pauseWork();
            if (action.pickupDisappeared == 0) action.pickupDisappeared = tick;
            if (tick - action.pickupDisappeared > 6)
                interrupt("The authorized drop disappeared without an inventory gain.", true);
            return;
        }
        if (!body.seesDrop(drop, 8)) {
            body.visibleHorizon().reportPickupUnseen(drop, "not_rendered");
            body.pauseWork();
            if (tick - action.dropSeen > 23) {
                action.retryDropWhenVisible = true;
                interrupt("The witnessed drop left the rendered view.", true);
            }
            return;
        }
        action.dropSeen = tick;
        if (!drop.getStack().isOf(offer.item) || !roomFor(drop.getStack()) || dropInProspectOpening(drop)
                || deepWork() && drop.getBlockPos().getY() != player.getBlockY()) {
            body.pauseWork();
            interrupt("The witnessed item, available inventory space, or authorized footing changed.", true);
            return;
        }
        if (drop.isOnGround() != action.dropGrounded || drop.getPos().squaredDistanceTo(action.dropPosition) > 0.0064
                || player.getPos().squaredDistanceTo(action.pickupFooting) > 0.0064) {
            action.dropGrounded = drop.isOnGround();
            action.dropPosition = drop.getPos();
            action.pickupFooting = player.getPos();
            action.pickupProgress = tick;
        }
        if (tick - action.pickupProgress > 24) {
            body.visibleHorizon().reportPickup(drop, "no_collection_progress", null);
            body.pauseWork();
            interrupt("No safe collection step or vanilla pickup was confirmed for the witnessed drop.", true);
            return;
        }
        if (fungibleStock)
            body.pickUpVisible(drop, null, AgentPickup.Scope.MATCHING_STOCK, stockPickupFooting);
        else body.pickUpVisible(drop, null, true);
        if (timberItem(offer.item)) rememberTimberView();
        if (action.drove && player.getVelocity().horizontalLengthSquared() > SETTLED_SPEED_SQUARED)
            continuityWork = AgentPauseEpisodes.Work.ROUTE;
    }

    private void advanceHorizonWork(AgentProgress progress) {
        var travel = action.horizonTravel;
        if (travel.pulseIssued()) work.horizonPulseSpent = true;
        String pickup = unexpectedPickup();
        if (pickup != null) {
            interrupt(pickup, true);
            return;
        }
        var cue = action.offer.face;
        var kind = action.horizonKind;
        boolean timber = kind == RESOURCE && timberBlock(cue.state);
        boolean ready = kind == RESOURCE && travel.moved() && (!action.timberWorkStance
            || timberReadyToCut(true, player.getPos(), travel.goal, travel.arrival, false)) && harvestReachable(cue, progress);
        if (travel.moved()) work.travelAnchorUsed = true;
        if (travel.progressed()) continuityWork = AgentPauseEpisodes.Work.ROUTE;
        if (action.horizonBraking) {
            finishShortHorizon();
            return;
        }
        switch (body.driveHorizon(travel, true, ready)) {
            case MOVING, SETTLING -> { }
            case ARRIVED -> {
                if (!settled() || !grounded()) return;
                recordHorizonLanding();
                if (travel.waded()) work.horizonAttempts.remove(cue.hit.getBlockPos());
                if (kind == RESOURCE && !ready) rememberSourceBearing(cue.hit);
                complete(travel.waded() ? "Settled on the witnessed dry bank; rechecking the same work order without harvest credit."
                    : switch (kind) {
                        case CAVE_FRONTIER -> "Walked to a closer dry stance for the witnessed cave frontier.";
                        case WOODLAND_FRONTIER -> "Reached a closer dry stance at the witnessed woodland; no harvest yet.";
                        case RESOURCE -> action.timberWorkStance
                            ? "Settled at a comfortable dry stance for the witnessed timber; no harvest yet."
                            : "Walked to a closer dry stance for the witnessed resource; no harvest yet.";
                    });
            }
            case BLOCKED -> {
                var step = grounded() && settled() && horizonStartAvailable() && !ready
                        && tick - action.started < Verb.WORK_WALK.maxTicks - MIN_GRADE_LEASE_TICKS
                        && world.getBlockState(cue.hit.getBlockPos()) == cue.state && ordinaryGradeSubjectAllowed(cue, kind)
                    ? body.ordinaryGrade(travel.goal) : null;
                if (step != null && ordinaryGradeAvailable(step)) {
                    attachOrdinaryGrade(step);
                    return;
                }
                if (travel.moved() && improvedHorizonStance(action.position, player.getPos(), travel.goal)) {
                    // Finish the safe part of a real transit. A new rendered view
                    // must prove the next short stopping window or an exact harvest.
                    body.stopHorizonTravel(travel);
                    action.horizonBraking = true;
                    finishShortHorizon();
                    return;
                }
                if (action.timberWorkStance && settled()
                        && timberReadyToCut(harvestReachable(cue, progress), player.getPos(), travel.goal, travel.arrival, true)) {
                    complete("No closer dry lane remains; the timber is still safely reachable from this stance.");
                    return;
                }
                var grade = timber || kind == WOODLAND_FRONTIER ? null : sourceCaveLane(progress, cue.hit, true);
                if (grade != null) {
                    // Only an already offered, goalward one-block route may take over.
                    // Ending this rolling leg is not a receipt for traversing that grade.
                    interrupt("Rolling travel yielded to the existing witnessed one-block lane.", true);
                    work.rejected.remove(cue.hit.getBlockPos());
                    startSourceCaveLane(progress, cue.hit, grade);
                    return;
                }
                if (travel.moved() && settled() && grounded()) recordHorizonLanding();
                interrupt("Stopped short of the witnessed target; no supported braking window or safe correction remains.", true);
            }
        }
    }

    private boolean harvestReachable(Face cue, AgentProgress progress) {
        return grounded() && visibleFace(cue) && workResourceSafe(cue.hit, cue.state, progress)
            && workToolSlot(cue.hit.getBlockPos(), cue.state) >= 0;
    }

    private void advanceOrdinaryGrade() {
        String pickup = unexpectedPickup();
        if (pickup != null) {
            interrupt(pickup, true);
            return;
        }
        var grade = action.ordinaryGrade;
        var goal = action.offer.face;
        if (action.tread == null || !action.tread.inFlight()) {
            if (!grounded() || !settled() || !player.getBlockPos().equals(grade.from())
                    || world.getBlockState(goal.hit.getBlockPos()) != goal.state
                    || world.getBlockState(grade.floor()) != grade.surface()
                    || world.getBlockState(grade.from().down()) != grade.source()) {
                interrupt("The exact goal, takeoff or landing changed before the witnessed step.", true);
                return;
            }
        }
        if (action.tread == null) {
            Vec3d top = grade.topAim();
            if (body.renderedFrame() > grade.frame() && body.renderedAim(top, 8)) {
                var proved = body.ordinaryGradeAfterLook(grade);
                if (proved == null) {
                    interrupt("The one look did not show that exact full stable top with safe step clearance.", true);
                    return;
                }
                action.ordinaryGrade = proved;
                action.tread = AgentSurfaceTread.ordinaryGrade(proved.edge(), proved.from(), tick);
                enact("route", "Cross the freshly witnessed one-block dry step.");
            } else if (tick <= action.gradeLookUntil) {
                body.aim(top);
                enact("search", "Checking only the top of the witnessed goalward riser.");
                return;
            } else {
                interrupt("The one goalward look did not produce a fresh view of the step.", true);
                return;
            }
        }
        var tread = action.tread;
        switch (tread.step(client, body, tick)) {
            case CHECKING -> { }
            case MOVING -> {
                if (tread.inFlight() && tread.from.getY() != player.getY()) continuityWork = AgentPauseEpisodes.Work.ROUTE;
            }
            case REFUSED -> interrupt("The one-block step lost exact support, safe clearance or contiguous motion.", true);
            case LANDED -> {
                if (!settled()) return;
                body.recordWalkedLeg(tread.from, tread.to);
                work.travelAnchorUsed = true;
                recordHorizonLanding();
                work.horizonAttempts.remove(goal.hit.getBlockPos());
                if (action.horizonKind == RESOURCE) rememberSourceBearing(goal.hit);
                else body.aim(goal.hit.getPos());
                continuityWork = AgentPauseEpisodes.Work.ROUTE;
                complete("Settled on the witnessed one-block step; continuing the same work order without harvest credit.");
            }
        }
    }

    static boolean improvedHorizonStance(Vec3d from, Vec3d landing, Vec3d goal) {
        double before = Math.sqrt(horizontalSquared(from, goal));
        double after = Math.sqrt(horizontalSquared(landing, goal));
        return before - after >= 0.40;
    }

    private void finishShortHorizon() {
        if (!grounded() || !settled()) return;
        if (!improvedHorizonStance(action.position, player.getPos(), action.horizonTravel.goal)) {
            interrupt("Stopped without a meaningfully closer stance for the witnessed target.", true);
            return;
        }
        recordHorizonLanding();
        work.horizonAttempts.remove(action.offer.face.hit.getBlockPos());
        if (action.timberWorkStance && !timberReadyToCut(true, player.getPos(),
                action.horizonTravel.goal, action.horizonTravel.arrival, false))
            work.timberClosing = action.offer.face;
        complete("Walked closer and braked on dry footing; rechecking the witnessed target from a fresh view.");
    }

    private void recordHorizonLanding() {
        BlockPos foot = player.getBlockPos();
        work.sourceSearch.footholds.add(foot.down());
        work.sourceSearch.freshAfter = body.renderedFrame();
        if (deepWork() && !foot.equals(BlockPos.ofFloored(action.position))
                && diamondRoute.arriveFromHorizon(foot, diamondRecoverySupport(foot), player.getHorizontalFacing()))
            walkedRoutes.recovery().clear();
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
        if (build.issuedFrame >= 0) {
            BlockHitResult top = null;
            long frame = body.renderedFrame();
            int stock = count(Items.COBBLESTONE);
            boolean debited = stock == build.countBefore - 1;
            if (debited && frame > build.issuedFrame) {
                top = body.dryRouteFloor(build.floor, build.cell);
                if (top == null) top = body.dryRouteFloor(build.alternateFloor, build.cell);
            }
            if (top != null && build.confirms(frame, top, world.getBlockState(build.cell), stock)) {
                diamondRoute.placedSupports.add(build.cell);
                ++work.confirmedPlacements;
                work.sourceSearch.freshAfter = frame;
                diamondRoute.lookPoint = null;
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                complete("Vanilla confirmed one attached minecraft:cobblestone top and the matching debit; not yet crossed.");
            } else if (tick - build.issuedAt > 22) {
                String observed = !debited ? "The exact one-block inventory debit was not observed."
                    : top == null ? "No new lit top was visible." : "The visible top was not cobblestone.";
                interrupt("The one issued minecraft:cobblestone placement was not confirmed. " + observed, true);
            } else if (debited && top == null && frame > build.issuedFrame) {
                // This is the top of the block just placed, not another possible attachment.
                body.aimFine(build.floor);
            }
            return;
        }
        if (!work.budget.canPlaceProspectSupport(player.getInventory()) || client.options.useKey.isUnbound()
                || !player.getOffHandStack().isEmpty() || player.isUsingItem()
                || action.craftJob != 0 && action.craftJob != hands.jobGeneration()) {
            interrupt("The held cobblestone, shared placement budget or use controls no longer allow one support.", true);
            return;
        }
        if (build.anchor != null && tick > build.contactUntil) {
            interrupt("The one witnessed attachment was not ready for vanilla placement in its alignment window.", true);
            return;
        }
        if (hands.busy()) {
            hands.tick();
            return;
        }
        if (client.currentScreen != null || !cursorClear() || !body.hasRecentView() || !body.footholdRaysAvailable()) {
            if (build.anchor == null && tick - action.started > 3)
                interrupt("The rendered air and attachment rays were unavailable; no support was used.", true);
            return;
        }
        // Both rays use this same rendered eye and projection, including on the actual use tick.
        var low = body.footholdSpace(build.low);
        var high = body.footholdSpace(build.high);
        if (!ProspectSupport.couldFrameAir(low) || !ProspectSupport.couldFrameAir(high)) {
            interrupt("The exact support cell was not visibly dry, lit and unobstructed."
                + build.sampleDetail(low, high), true);
            return;
        }
        if (build.anchor == null) {
            BlockHitResult seen = body.visibleFootholdAttachment(build.cell, build.bearing, build.low, build.high, reach());
            if (seen == null) {
                interrupt("The current corridor view shows no usable lit attachment for the exact support cell.", true);
                return;
            }
            build.pin(seen, world.getBlockState(seen.getBlockPos()), tick);
        }
        BlockHitResult hit = build.anchor.hit;
        if (world.getBlockState(hit.getBlockPos()) != build.anchor.state) {
            interrupt("The one witnessed attachment changed before placement.", true);
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
        Vec3d point = hit.getPos();
        boolean centered = body.renderedAim(point, 5);
        var view = build.view(low, high, centered);
        if (view == ProspectSupport.View.REFUSED) {
            interrupt("One lit rendered view did not verify both dry air samples."
                + build.sampleDetail(low, high), true);
            return;
        }
        boolean framed = body.dryRoutePointInView(point);
        if (framed ? !body.footholdAttachment(hit, build.cell) : build.seekingContact) {
            interrupt("The one witnessed attachment is no longer a reachable lit face.", true);
            return;
        }
        if (!player.getMainHandStack().isOf(Items.COBBLESTONE)) {
            if (!hands.equipForUse(stack -> stack.isOf(Items.COBBLESTONE)) && hands.busy())
                action.craftJob = hands.jobGeneration();
            else if (!hands.busy() && !player.getMainHandStack().isOf(Items.COBBLESTONE))
                interrupt("Vanilla inventory could not equip the explicitly authorized cobblestone.", true);
            return;
        }
        build.steered = true;
        body.sneak();
        if (view == ProspectSupport.View.ALIGN || !framed) {
            // Only the actual first-hit face can be retained through one continuous turn.
            body.aimFine(point);
            return;
        }
        build.seekingContact = true;
        int before = count(Items.COBBLESTONE);
        if (body.useContact(hit, AgentBody.Contact.PRECISE,
                player.isSneaking() ? AgentBody.Preparation.READY : AgentBody.Preparation.STANCE)) {
            build.issued(tick, body.renderedFrame(), before, work.budget);
            diamondRoute.attemptedSupports.add(build.cell);
        }
    }

    private void advanceProspectLight() {
        BlockPos foot = BlockPos.ofFloored(action.position);
        if (action.fired) {
            if (world.getBlockState(foot).isOf(Blocks.TORCH) && count(Items.TORCH) == action.itemCount - 1) {
                ++work.confirmedPlacements;
                work.sourceSearch.freshAfter = body.renderedFrame();
                diamondRoute.lookPoint = null;
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
        IronWorkshop shop = work.ironWorkshop;
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
                    workshopMilestone("placement_confirmed", "Vanilla confirmed the furnace and its exact stock decrement.");
                }
                if (shop != null) {
                    if (!furnace) shop.placedTable = dest;
                    shop.openingUntil = tick + WORKSHOP_AIM_TICKS;
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
        if (!work.budget.canPlace() || (furnace ? !work.budget.canPlaceFurnace(player.getInventory())
                : work.budget.limit(item, count(item)) < 1) || !cursorClear()
                || shop != null && (!shop.foot.equals(player.getBlockPos()) || !ironFooting(shop.foot.down())
                    || client.options.useKey.isUnbound() || player.isUsingItem() || client.interactionManager.isBreakingBlock())) {
            interrupt("The placement footing, cursor, control or material permission changed.", true);
            return;
        }
        boolean space = shop == null
            ? world.getBlockState(dest).isAir() && !player.getBoundingBox().intersects(new Box(dest))
            : workshopSite(dest);
        if (!space || world.getBlockState(support.hit.getBlockPos()) != support.state || !visible(support)) {
            if (shop != null && space && world.getBlockState(support.hit.getBlockPos()) == support.state) {
                if (action.workshopFaceUntil == 0) action.workshopFaceUntil = tick + WORKSHOP_AIM_TICKS;
                if (tick < action.workshopFaceUntil) {
                    body.aim(support.hit.getPos());
                    return;
                }
            }
            if (shop != null) {
                action.workshopFaceLost = true;
                shop.refusedHere.add(dest);
            }
            interrupt("The placement face or clear site could not be re-witnessed before issuing any use.", true);
            return;
        }
        action.workshopFaceUntil = 0;
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
            if (furnace) workshopMilestone("placement_issued", "Issued one vanilla use on the re-witnessed dry furnace support.");
        }
    }

    private void workshopMilestone(String milestone, String detail) {
        var value = header(run);
        value.addProperty("id", work.order.id());
        value.addProperty("life", life);
        value.addProperty("tick", tick);
        value.addProperty("wall_ms", System.currentTimeMillis());
        value.addProperty("milestone", milestone);
        value.addProperty("detail", detail);
        ipc.evidence("furnace-" + work.order.id() + "-" + milestone + ".json", value.toString());
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

    /** These checks can veto a sighted site; they do not supply a new site. */
    private boolean workshopSite(BlockPos dest) {
        if (!furnaceSite(dest) || body.macroLavaNear()
                || !world.getBlockState(dest.up()).isAir()
                || player.getBoundingBox().intersects(new Box(dest))) return false;
        BlockState floor = world.getBlockState(dest.down());
        if (floor.isOf(Blocks.MAGMA_BLOCK) || floor.isOf(Blocks.CACTUS)) return false;
        for (Direction side : CARDINAL)
            if (!world.getBlockState(dest.offset(side)).getFluidState().isEmpty()) return false;
        return true;
    }

    private int ironTimeLimit() {
        long remaining = Math.min(work.order.expires() - tick, (work.deadline - now) / 50_000_000L);
        return (int) Math.max(0, (remaining - FURNACE_CLICK_MARGIN) / AgentHands.SMELT_TICKS);
    }

    private static BlockPos workshopCell(Face support) { return support.hit.getBlockPos().up(); }

    private boolean workshopSupportCurrent(IronWorkshop shop, Face support) {
        return support != null && !shop.refusedHere.contains(workshopCell(support))
            && world.getBlockState(support.hit.getBlockPos()) == support.state && workshopSite(workshopCell(support))
            && player.getEyePos().squaredDistanceTo(support.hit.getPos()) <= reach() * reach();
    }

    private static boolean workshopSightline(Vec3d eye, Face site, Face table) {
        return table == null || new Box(workshopCell(site)).raycast(eye, table.hit.getPos()).isEmpty();
    }

    private static boolean workshopPair(Vec3d eye, Face bench, Face furnace) {
        BlockPos a = workshopCell(bench), b = workshopCell(furnace);
        if (a.equals(b)) return false;
        Box tableBox = new Box(a);
        return tableBox.raycast(eye, furnace.hit.getPos()).isEmpty()
            && tableBox.raycast(eye, Vec3d.ofCenter(b)).isEmpty()
            && new Box(b).raycast(eye, Vec3d.ofCenter(a)).isEmpty();
    }

    private BlockHitResult liveWorkshopFace(Face seen) {
        return world.getBlockState(seen.hit.getBlockPos()) == seen.state
            ? body.macroMineWitness(seen.hit, reach()) : null;
    }

    private boolean aimWorkshopFace(IronWorkshop shop, Face seen) {
        if (shop.aiming != seen) {
            shop.aiming = seen;
            shop.aimUntil = tick + WORKSHOP_AIM_TICKS;
        }
        if (tick >= shop.aimUntil) return false;
        body.aim(seen.hit.getPos());
        ironStatus("Rechecking the exact previously witnessed workshop face before any vanilla use.");
        return true;
    }

    private void observeIronSupports(IronWorkshop shop) {
        if (shop.supports.size() >= WORKSHOP_SUPPORTS) return;
        BlockHitResult seen = stationSupport(pos -> {
            if (shop.refusedHere.contains(pos) || !workshopSite(pos)) return false;
            for (Face support : shop.supports) if (workshopCell(support).equals(pos)) return false;
            return true;
        });
        if (seen != null && player.getEyePos().squaredDistanceTo(seen.getPos()) <= reach() * reach())
            shop.supports.add(face(seen));
    }

    private boolean readyWorkshopPair(IronWorkshop shop, boolean benchNeeded) {
        Face bench = shop.tableSite, furnace = shop.furnaceSite;
        Vec3d eye = player.getEyePos();
        if (workshopSupportCurrent(shop, furnace)
                && (benchNeeded ? workshopSupportCurrent(shop, bench) && workshopPair(eye, bench, furnace)
                    : workshopSightline(eye, furnace, shop.table))) return true;
        shop.tableSite = shop.furnaceSite = null;
        for (Face candidate : shop.supports) {
            if (!workshopSupportCurrent(shop, candidate)) continue;
            if (!benchNeeded) {
                if (!workshopSightline(eye, candidate, shop.table)) continue;
                shop.furnaceSite = candidate;
                return true;
            }
            for (Face other : shop.supports) {
                if (!workshopSupportCurrent(shop, other) || !workshopPair(eye, other, candidate)) continue;
                shop.tableSite = other;
                shop.furnaceSite = candidate;
                return true;
            }
        }
        return false;
    }

    private void observeWorkshopAlternate(IronWorkshop shop) {
        if (shop.walked || client.options.forwardKey.isUnbound() || shop.supports.isEmpty()) return;
        if (shop.alternate != null) {
            if (world.getBlockState(shop.alternateGuide.hit.getBlockPos()) == shop.alternateGuide.state
                    && workshopSite(workshopCell(shop.alternateGuide))) return;
            shop.alternate = null;
            shop.alternateUntil = 0;
        }
        Vec3d eye = player.getEyePos();
        double reachSquared = reach() * reach();
        for (Direction direction : CARDINAL) {
            BlockPos floor = shop.foot.offset(direction).down();
            Vec3d landing = Vec3d.ofBottomCenter(floor.up());
            Vec3d fromThere = landing.add(0, eye.y - player.getY(), 0);
            if (shop.table != null && fromThere.squaredDistanceTo(shop.table.hit.getPos()) > reachSquared) continue;
            Face guide = null;
            for (Face support : shop.supports) {
                if (workshopCell(support).equals(floor.up())
                        || world.getBlockState(support.hit.getBlockPos()) != support.state
                        || !workshopSite(workshopCell(support)) || !workshopSightline(fromThere, support, shop.table)
                        || fromThere.squaredDistanceTo(support.hit.getPos()) >= Math.min(reachSquared,
                            eye.squaredDistanceTo(support.hit.getPos()))) continue;
                guide = support;
                break;
            }
            if (guide == null) continue;
            BlockHitResult top = body.macroFloor(floor);
            if (top == null) continue;
            BlockState state = world.getBlockState(floor);
            if (!dryWorkshopSupport(floor) || !world.getBlockState(floor.up()).isAir()
                    || !world.getBlockState(floor.up(2)).isAir() || !body.macroFlatLane(floor, state, landing)
                    || !body.macroNoVisiblePickup(landing)) continue;
            shop.alternate = new Floor(floor, state, landing);
            shop.alternateTop = top;
            shop.alternateGuide = guide;
            return;
        }
    }

    private boolean useWorkshopAlternate(IronWorkshop shop) {
        Floor floor = shop.alternate;
        if (floor == null || shop.walked || client.options.forwardKey.isUnbound()
                || !cardinallyAdjacent(shop.foot.down(), floor.pos)
                || world.getBlockState(shop.alternateGuide.hit.getBlockPos()) != shop.alternateGuide.state
                || !workshopSite(workshopCell(shop.alternateGuide))
                || workTicksLeft() <= FURNACE_CLICK_MARGIN + AgentHands.SMELT_TICKS + WORKSHOP_SCAN_TICKS)
            return false;
        if (!floorCurrent(floor) || !body.macroNoVisiblePickup(floor.landing)
                || !world.getBlockState(floor.pos.up()).isAir() || !world.getBlockState(floor.pos.up(2)).isAir()) {
            if (shop.alternateUntil == 0) shop.alternateUntil = tick + WORKSHOP_AIM_TICKS;
            if (tick >= shop.alternateUntil) return false;
            body.aim(shop.alternateTop.getPos());
            ironStatus("Rechecking the already witnessed adjacent dry workshop foothold.");
            return true;
        }
        String label = "Walk one witnessed dry level tile to bring the known workshop support closer";
        var offer = new Offer(null, new Key(Verb.APPROACH, floor.pos, 0, IRON_WORKSHOP_STEP),
            label, "", 0, 0, floor, null, null, null, null);
        action = new Action(null, offer, client, tick, now, body.renderedFrame(), 0, NO_ANCHORS, 42);
        action.durable = true;
        shop.walked = true;
        status = work.detail = label;
        enact("route", label);
        return true;
    }

    private boolean inspectIronSites(IronWorkshop shop) {
        if (shop.walked && shop.scanStarted == 0 && workshopSupportCurrent(shop, shop.alternateGuide)
                && liveWorkshopFace(shop.alternateGuide) == null && aimWorkshopFace(shop, shop.alternateGuide)) return true;
        observeWorkshopAlternate(shop);
        if (shop.scanStarted == 0) {
            shop.scanStarted = tick;
            shop.scanYaw = player.getYaw();
        }
        long elapsed = tick - shop.scanStarted;
        if (elapsed >= WORKSHOP_SCAN_TICKS) return useWorkshopAlternate(shop);
        // Only a bounded arc around this stance. All candidates come from rendered views.
        body.turnFine(shop.scanYaw + (elapsed < 7 ? 0 : elapsed < 18 ? -68 : 68), 60);
        ironStatus("Checking the nearby dry workshop supports from the current footing.");
        return true;
    }

    private boolean prepareIronRecipe(IronWorkshop shop, BlockHitResult table, AgentProgress progress) {
        if (table != null && (shop.placedTable == null || table.getBlockPos().equals(shop.placedTable)))
            shop.table = face(table);
        else table = null;
        if (shop.table != null && world.getBlockState(shop.table.hit.getBlockPos()) != shop.table.state)
            shop.table = null;
        boolean benchNeeded = shop.table == null;
        observeIronSupports(shop);
        if (!readyWorkshopPair(shop, benchNeeded)) {
            if (!inspectIronSites(shop))
                searchWork("No witnessed, reachable pair of dry workstation sites; the furnace recipe was left untouched.");
            return true;
        }
        if (!benchNeeded) {
            if (shop.recipeSupport != shop.furnaceSite) {
                if (liveWorkshopFace(shop.furnaceSite) == null) {
                    if (!aimWorkshopFace(shop, shop.furnaceSite))
                        shop.refusedHere.add(workshopCell(shop.furnaceSite));
                    return true;
                }
                shop.recipeSupport = shop.furnaceSite;
            }
            BlockHitResult current = table != null ? table : liveWorkshopFace(shop.table);
            if (current != null && startWorkRecipe("furnace", 1, current)) {
                observeWorkshopAlternate(shop);
                return true;
            }
            if (current == null && aimWorkshopFace(shop, shop.table)) return true;
            searchWork("The planned dry workshop lost its usable crafting table before the furnace recipe.");
            return true;
        }
        if (work.budget.limit(Items.CRAFTING_TABLE, count(Items.CRAFTING_TABLE)) == 0) {
            if (!startStockRecipe("crafting_table", 1, null, progress, new HashSet<>(4)))
                searchWork("The planned workshop still lacks a reserve-safe crafting table or its approved ingredients.");
            return true;
        }
        BlockHitResult support = liveWorkshopFace(shop.tableSite);
        if (support != null) {
            startWorkStep(Verb.WORK_PLACE, "Place the authorized table without blocking the witnessed furnace site",
                face(support), null, Items.CRAFTING_TABLE, null);
        } else if (!aimWorkshopFace(shop, shop.tableSite)) {
            shop.refusedHere.add(workshopCell(shop.tableSite));
        }
        return true;
    }

    private boolean placeIronFurnace(IronWorkshop shop) {
        Face planned = shop.furnaceSite;
        BlockHitResult support = workshopSupportCurrent(shop, planned) ? liveWorkshopFace(planned) : null;
        if (support == null) {
            var eye = player.getEyePos();
            support = stationSupport(pos -> !shop.refusedHere.contains(pos) && workshopSite(pos)
                && (shop.table == null || new Box(pos).raycast(eye, shop.table.hit.getPos()).isEmpty()));
        }
        if (support != null && player.getEyePos().squaredDistanceTo(support.getPos()) <= reach() * reach()) {
            startWorkStep(Verb.WORK_PLACE, "Place one authorized furnace on witnessed dry support",
                face(support), null, Items.FURNACE, null);
            return true;
        }
        observeIronSupports(shop);
        if (readyWorkshopPair(shop, false)) {
            if (aimWorkshopFace(shop, shop.furnaceSite)) return true;
            shop.refusedHere.add(workshopCell(shop.furnaceSite));
        }
        if (inspectIronSites(shop)) return true;
        searchWork("No reachable dry furnace support remained after the bounded local workshop check.");
        return false;
    }

    private boolean aimPlacedWorkshopStation(IronWorkshop shop, BlockPos pos, Block block) {
        Vec3d point = Vec3d.ofCenter(pos);
        if (tick >= shop.openingUntil || !world.getBlockState(pos).isOf(block)
                || player.getEyePos().squaredDistanceTo(point) > (reach() + 0.55) * (reach() + 0.55)) return false;
        body.aim(point);
        ironStatus("Reacquiring the freshly placed workshop station from a rendered view.");
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
        if (work.ironWorkshop != null && !work.ironWorkshop.foot.equals(player.getBlockPos())) {
            searchWork("The work order lost its verified workshop footing.");
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
        var quote = hands.quoteIron(work.budget, Math.min(needed, ironTimeLimit()));
        if (quote == null) {
            searchWork(ironSupplyShortfall());
            return false;
        }
        if (AgentFurnaceWatch.required(quote) && !footing.equals(work.ironSceneFooting)) {
            // Retain the actual approach view before placement or contact turns toward the workshop.
            work.ironSceneFooting = footing;
            work.ironScene = furnaceScene(footing);
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
        IronWorkshop shop = work.ironWorkshop != null ? work.ironWorkshop : new IronWorkshop(player.getBlockPos());
        if (work.placedFurnace != null) {
            if (aimPlacedWorkshopStation(shop, work.placedFurnace, Blocks.FURNACE)) return true;
            searchWork("The one placed furnace is not currently witnessed cold and reachable from the dry stance.");
        } else if (!work.budget.policy.placeFurnace()) {
            searchWork("No cold furnace is witnessed in reach; place:minecraft:furnace was not authorized.");
        } else if (!work.budget.canPlace() || work.budget.remainingCost(Items.FURNACE) == 0) {
            searchWork("No furnace placement or minecraft:furnace cost remains in the work budget.");
        } else if (work.budget.canPlaceFurnace(player.getInventory())) {
            work.ironWorkshop = shop;
            if (table != null && shop.table == null) shop.table = face(table);
            return placeIronFurnace(shop);
        } else if (shop.furnaceCrafted) {
            searchWork("The already crafted furnace is no longer placeable above its reserve; no second furnace was crafted.");
        } else if (count(Items.FURNACE) < work.budget.floor(Items.FURNACE)) {
            searchWork("The carried furnace stock is below its declared reserve; crafting one furnace would not leave one to place.");
        } else if (!work.budget.policy.craftAllowed("furnace")) {
            searchWork("No carried furnace is available above its reserve, and craft:furnace was not authorized.");
        } else if (work.budget.craftsLeft() < 2) {
            searchWork("Crafting a furnace and smelting its first iron need two shared recipe executions.");
        } else {
            if (table != null && table.getBlockPos().getY() < player.getBlockY()) table = null;
            if (table != null && shop.placedTable != null && !shop.placedTable.equals(table.getBlockPos()))
                table = visibleStation(Blocks.CRAFTING_TABLE, shop.placedTable);
            if (shop.table != null && !sameStation(shop.table)) shop.table = null;
            boolean benchNeeded = table == null && shop.table == null;
            if (benchNeeded && stationRecallReady(personalTable)
                    && personalTable.face.hit.getBlockPos().getY() >= player.getBlockY()
                    && hands.workCraftable("furnace", work.budget) && startStationRecall(personalTable)) return true;
            if (benchNeeded && shop.placedTable != null) {
                if (aimPlacedWorkshopStation(shop, shop.placedTable, Blocks.CRAFTING_TABLE)) return true;
                searchWork("The one placed crafting table is not witnessed in reach; no second table was spent.");
            } else if (benchNeeded && (!work.budget.policy.placeTable() || work.budget.placementsLeft() < 2
                    || work.budget.remainingCost(Items.CRAFTING_TABLE) == 0)) {
                searchWork("No crafting table is witnessed in reach; both the table and furnace need their own placement permissions and costs.");
            } else if (benchNeeded && count(Items.CRAFTING_TABLE) < work.budget.floor(Items.CRAFTING_TABLE)) {
                searchWork("The carried crafting-table stock is below its reserve; one new table would not leave one to place.");
            } else if (benchNeeded && count(Items.CRAFTING_TABLE) <= work.budget.floor(Items.CRAFTING_TABLE)
                    && (!work.budget.policy.craftAllowed("crafting_table") || work.budget.craftsLeft() < 3)) {
                searchWork("No crafting table is available above its reserve; an explicit table recipe and a third shared execution are needed.");
            } else if (hands.workCraftable("furnace", work.budget)) {
                work.ironWorkshop = shop;
                return prepareIronRecipe(shop, table, progress);
            } else if (startStockRecipe("furnace", 1, table, progress, new HashSet<>(4))) {
                return true;
            } else {
                searchWork("Crafting the furnace lacks reserve-safe stone ingredients, a suitable work screen or output room.");
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
                || client.getCameraEntity() != player || !client.options.getPerspective().isFirstPerson()) {
            interrupt("The furnace work lost its exact reach, first-person view or stationary dry footing.", true);
            return;
        }
        if (!state.isOf(Blocks.FURNACE)
                || state.get(AbstractFurnaceBlock.FACING) != target.state.get(AbstractFurnaceBlock.FACING)) {
            interrupt("The exact furnace block or facing changed.", true);
            return;
        }
        if (iron.phase != null && action.craftJob != hands.jobGeneration()) {
            interrupt("The authorized furnace hand job was replaced.", true);
            return;
        }
        if (iron.watch != null) {
            String lost = iron.watch.accessProblem(pos, state.get(AbstractFurnaceBlock.FACING),
                AgentClient.ownsSinglePlayerFurnaceWorld(client, player));
            if (lost != null) {
                interrupt(lost, true);
                return;
            }
        }
        if (iron.phase == FurnacePhase.WATCHING) {
            advanceFurnaceWatch(iron, target);
            return;
        }
        boolean reopening = iron.phase == FurnacePhase.REOPENING;
        Screen screen = client.currentScreen;
        if (action.opened == null) {
            if (screen == null) {
                if (action.fired) {
                    if (tick > action.firedAt && !iron.contactObserved)
                        interrupt("The queued vanilla use did not confirm contact with the exact furnace face.", true);
                    else if (tick - action.firedAt > FURNACE_SYNC_TICKS)
                        interrupt(reopening ? "Vanilla did not reopen the exact witnessed furnace."
                            : "Vanilla did not open the witnessed furnace.", true);
                } else if (reopening) {
                    if (tick >= iron.reacquireUntil) {
                        interrupt("No fresh first-person contact could reacquire the exact furnace in time.", true);
                    } else if (body.renderedFrame() > iron.closedFrame && body.hasRecentView()) {
                        if (!cursorClear() || player.currentScreenHandler != player.playerScreenHandler) {
                            interrupt("The clean personal cursor or handler changed before furnace reacquisition.", false);
                        } else {
                            BlockHitResult live = body.macroMineWitness(target.hit, reach());
                            if (live != null && useAvailable()) contactFurnace(iron, live);
                            else body.aim(target.hit.getPos());
                        }
                    }
                } else if (body.hasRecentView()) {
                    if (!cursorClear() || !visible(target) || state.get(AbstractFurnaceBlock.LIT))
                        interrupt("The witnessed furnace face or its cold clean entry premise changed.", true);
                    else if (useAvailable()) contactFurnace(iron, target.hit);
                }
                return;
            }
            if (!action.fired || !iron.contactObserved || !(screen instanceof FurnaceScreen)) {
                interrupt("The screen was not opened by the authorized vanilla contact with this furnace.", false);
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
        if (reopening) {
            String mismatch = iron.watch.reopenProblem(handler.syncId, sync.agent$furnaceContentsSynced(),
                sync.agent$furnaceOutputUpdates(), count(Items.RAW_IRON), count(iron.batch.fuel()), count(Items.IRON_INGOT),
                raw, fuel, output);
            if (mismatch != null || !cursorClear()) {
                interrupt(mismatch != null ? mismatch : "The newly synchronized furnace cursor was not clear.", true);
                return;
            }
            // The initial vanilla full sync here witnesses this handler's output, not a stale
            // per-handler update counter or the cook timer. The old handler is no longer read.
            iron.syncId = handler.syncId;
            iron.outputWitness = 0;
            iron.advancedTick = tick;
            iron.phase = FurnacePhase.BURNING;
            ironMilestone("reopened", "Reopened the exact watched furnace with a fresh vanilla slot sync: "
                + raw.getCount() + " raw iron, " + fuel.getCount() + " fuel and " + output.getCount() + " ingots.");
        }
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
            iron.before = ironStock(batch);
            iron.syncId = handler.syncId;
            iron.binding = stationSequence;
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
        if (hands.busy()) {
            hands.tick();
            return;
        }
        var batch = iron.batch;
        if (iron.phase == FurnacePhase.RETURNING) {
            boolean restored = hands.status().equals("smelt: done") && cursorClear() && raw.isEmpty()
                && count(Items.RAW_IRON) == iron.returnedStock;
            if (restored) {
                ironMilestone("returned", "The paid raw iron left in the cold input slot was returned to inventory.");
                var ticket = pendingEntry();
                if (pendingOrigin == work) {
                    if (output.isEmpty() && (ticket == null || pendingFurnaceMemory.end(ticket.ticket(),
                            AgentPendingFurnaceMemory.State.CANCELLED, tick, body.renderedFrame()))) clearPendingLocal();
                    else invalidatePending("The original paid recipe no longer has a conserved batch to withdraw.");
                }
            }
            interrupt(restored ? "The furnace stalled; the remaining raw iron was returned."
                : "The furnace stalled and the raw iron return did not settle.", true);
            return;
        }
        if (iron.phase == FurnacePhase.COLLECTING) {
            if (!hands.status().equals("smelt: done") || !cursorClear() || !raw.isEmpty() || !fuel.isEmpty()
                    || !output.isEmpty() || !ironStock(batch).collectedFrom(iron.paid, batch)) {
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
            var ticket = pendingEntry();
            if (pendingOrigin == work) {
                if (ticket != null) finishPendingMemory(ticket);
                else clearPendingLocal();
            }
            furnace.close();
            body.pauseWork();
            continuityWork = AgentPauseEpisodes.Work.GUI;
            complete(work.lastEffect);
            return;
        }
        if (!cursorClear() || !AgentFurnaceWatch.matches(batch, iron.output, iron.fuelRemaining, raw, fuel, output)) {
            interrupt("The current furnace slots no longer attest only this work's paid inputs and output.", true);
            return;
        }
        iron.fuelRemaining = fuel.getCount();
        if (iron.phase == FurnacePhase.LOADING) {
            var paid = ironStock(batch);
            if (!hands.status().equals("smelt: done") || !paid.paidFrom(iron.before, batch)) {
                interrupt("The raw iron and exact fuel did not settle after their bounded slot clicks.", true);
                return;
            }
            iron.paid = paid;
            iron.phase = FurnacePhase.LOADED;
            iron.advancedTick = tick;
            iron.progress = handler.getCookProgress();
            iron.output = output.getCount();
            rememberPending(iron, target);
            ironMilestone("loaded", "Loaded " + batch.units() + " raw iron and " + batch.fuelCount() + " "
                + Registries.ITEM.getId(batch.fuel()) + "; no ingot stock has been collected.");
            return;
        }
        float cooking = handler.getCookProgress();
        boolean advanced = handler.isBurning() && cooking > iron.progress;
        boolean produced = output.getCount() > iron.output && sync.agent$furnaceOutputUpdates() > iron.outputWitness;
        if (advanced || produced) {
            iron.advancedTick = tick;
        }
        if (iron.phase == FurnacePhase.LOADED && advanced && state.get(AbstractFurnaceBlock.LIT)) {
            iron.phase = FurnacePhase.BURNING;
            iron.burnTick = tick;
            ironMilestone("burning", AgentFurnaceWatch.required(batch)
                ? "Vanilla confirmed the paid multi-unit batch is burning; checking for a clean release to ordinary work."
                : "Vanilla confirmed the paid single-unit batch is burning; waiting on this screen for its exact result.");
        }
        iron.progress = cooking;
        iron.output = output.getCount();
        if (iron.phase == FurnacePhase.BURNING && iron.watch == null && AgentFurnaceWatch.required(batch)
                && handler.isBurning() && state.get(AbstractFurnaceBlock.LIT) && output.getCount() < batch.units()) {
            startFurnaceWatch(iron, furnace, target);
            return;
        }
        if (iron.phase == FurnacePhase.BURNING && output.getCount() == batch.units()
                && sync.agent$furnaceOutputUpdates() > iron.outputWitness) {
            if ((AgentFurnaceWatch.required(batch) && iron.watch == null) || !ironStock(batch).equals(iron.paid)) {
                interrupt("The paid furnace access or carried stock was not conserved before collection.", true);
                return;
            }
            if (!hands.collectWorkIron(furnace, batch.units(), iron.outputWitness)) {
                interrupt(hands.status(), true);
                return;
            }
            iron.phase = FurnacePhase.COLLECTING;
            action.craftJob = hands.jobGeneration();
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

    private void contactFurnace(FurnaceWork iron, BlockHitResult hit) {
        if (body.useContact(hit, AgentBody.Contact.INTERACT)) {
            iron.contact = hit;
            action.fired = true;
            action.firedAt = tick;
        }
    }

    boolean allowScopedFurnaceUse() {
        if (action != null && action.pendingCollection != null) {
            var collect = action.pendingCollection;
            if (!action.fired || action.opened != null) return true;
            var iron = action.furnace;
            if (iron == null || action.firedAt != tick || iron.contactEntered) return false;
            iron.contactEntered = true;
            return client.currentScreen == null && client.crosshairTarget instanceof BlockHitResult hit && sameFurnaceContact(iron, hit)
                && player.currentScreenHandler == player.playerScreenHandler && cursorClear() && useAvailable()
                && hands.releasedForPendingWork() && pendingContactCurrent(collect) && input.active
                && input.intent != null && input.intent.equals(action.intent);
        }
        var iron = action == null ? null : action.furnace;
        if (iron == null || !action.fired || action.opened != null) return true;
        if (action.firedAt != tick || iron.contactEntered) return false;
        iron.contactEntered = true;
        return client.player == player && client.world == world && client.currentScreen == null
            && client.crosshairTarget instanceof BlockHitResult hit && sameFurnaceContact(iron, hit)
            && sameStation(action.offer.face) && work != null && work.active() && input.active && !urgent
            && System.nanoTime() < work.deadline && ironFooting(iron.footing) && cursorClear() && useAvailable()
            && (iron.watch == null || iron.watch.accessProblem(hit.getBlockPos(),
                action.offer.face.state.get(AbstractFurnaceBlock.FACING),
                AgentClient.ownsSinglePlayerFurnaceWorld(client, player)) == null);
    }

    void confirmScopedFurnaceUse(ClientPlayerEntity actor, BlockHitResult hit) {
        var iron = action == null ? null : action.furnace;
        if (iron != null && actor == player && action.fired && action.firedAt == tick
                && iron.contactEntered && sameFurnaceContact(iron, hit))
            iron.contactObserved = true;
    }

    void clearUnconsumedFurnaceUse() {
        var iron = action == null ? null : action.furnace;
        if (iron != null && action.fired && action.firedAt == tick && !iron.contactEntered) {
            iron.contactEntered = true;
            client.options.useKey.wasPressed();
        }
    }

    private static boolean sameFurnaceContact(FurnaceWork iron, BlockHitResult hit) {
        return iron.contact != null && hit.getType() == HitResult.Type.BLOCK
            && iron.contact.getBlockPos().equals(hit.getBlockPos()) && iron.contact.getSide() == hit.getSide();
    }

    void observeFurnaceBlock(ClientWorld updatedWorld, BlockPos pos, BlockState state) {
        var watch = action == null || action.furnace == null ? null : action.furnace.watch;
        if (watch != null && world == updatedWorld && watch.pos.equals(pos)
                && (!state.isOf(Blocks.FURNACE) || state.get(AbstractFurnaceBlock.FACING) != watch.facing))
            watch.invalidate();
        var ticket = pendingEntry();
        if (ticket != null && ticket.mayInvestigateCollection() && world == updatedWorld && ticket.pos().equals(pos)
                && (!state.isOf(Blocks.FURNACE) || state.get(AbstractFurnaceBlock.FACING) != ticket.facing())) {
            pendingFurnaceMemory.end(ticket.ticket(), AgentPendingFurnaceMemory.State.DISAPPEARED, tick, body.renderedFrame());
            invalidatePending("The witnessed furnace was removed or changed facing.");
        }
    }

    void observeFurnaceChunk(ClientWorld updatedWorld, ChunkPos chunk) {
        var watch = action == null || action.furnace == null ? null : action.furnace.watch;
        if (watch != null && world == updatedWorld && chunk.x == (watch.pos.getX() >> 4) && chunk.z == (watch.pos.getZ() >> 4))
            watch.invalidate();
        var ticket = pendingEntry();
        if (ticket != null && world == updatedWorld && chunk.x == (ticket.pos().getX() >> 4) && chunk.z == (ticket.pos().getZ() >> 4)) {
            pendingEstimate = null;
            pendingRecheckedUntil = 0; // A chunk transition does not prove that the furnace kept ticking.
        }
    }

    private AgentFurnaceWatch.Stock ironStock(AgentHands.IronBatch batch) {
        return new AgentFurnaceWatch.Stock(count(Items.RAW_IRON), count(batch.fuel()), count(Items.IRON_INGOT));
    }

    private void rememberPending(FurnaceWork iron, Face target) {
        if (!AgentClient.ownsSinglePlayerFurnaceWorld(client, player)) return;
        pendingOrigin = work;
        UUID id;
        try {
            id = UUID.fromString(work.order.id());
        } catch (IllegalArgumentException invalid) {
            return; // Older readers did not require an order UUID and have no ticket handoff.
        }
        if (pendingFurnaceMemory.pay(id, world.getRegistryKey().getValue().toString(), target.hit.getBlockPos(),
                target.state.get(AbstractFurnaceBlock.FACING), iron.footing.up(), iron.batch, iron.syncId,
                iron.output, iron.fuelRemaining, work.budget.floors, tick, body.renderedFrame())) {
            pendingFace = target;
            attachPendingRoute(pendingEntry());
            pendingUncertain = pendingWorldRelease = false;
        }
    }

    private void finishPendingMemory(AgentPendingFurnaceMemory.Entry ticket) {
        if (!pendingFurnaceMemory.end(ticket.ticket(), AgentPendingFurnaceMemory.State.COLLECTED, tick, body.renderedFrame())) {
            pendingUncertain = true;
            remember("The proved collection could not retire its durable ticket; no second withdrawal is authorized.");
            return;
        }
        clearPendingLocal();
    }

    private void clearPendingLocal() {
        pendingOrigin = null;
        pendingFace = null;
        pendingEstimate = null;
        pendingRecheck = null;
        pendingRecheckedUntil = 0;
        pendingBurnEnded = false;
        pendingRouteTicket = null;
        walkedRoutes.anchor(AgentRouteGraph.NO_CELL);
        parkedViewAfterFrame = -1;
        parkedViewPublished = false;
        pendingUncertain = pendingWorldRelease = false;
    }

    private void invalidatePending(String reason) {
        var ticket = pendingEntry();
        if (ticket == null || pendingUncertain) return;
        pendingUncertain = true;
        if (ticket.mayInvestigateCollection())
            pendingFurnaceMemory.discontinuity(tick, body == null ? 0 : body.renderedFrame());
        if (pendingOrigin != null && pendingOrigin.phase.equals("parked")) {
            pendingOrigin.phase = "needs_replan";
            pendingOrigin.detail = reason;
            receipt(pendingOrigin.order.id(), pendingOrigin.order.life(), "interrupted", reason + " No ingots were credited.");
        }
    }

    private void attachPendingRoute(AgentPendingFurnaceMemory.Entry ticket) {
        if (ticket == null || !ticket.mayInvestigateCollection() || ticket.ticket().equals(pendingRouteTicket)
                || world == null || !world.getRegistryKey().getValue().toString().equals(ticket.dimension())) return;
        pendingRouteTicket = ticket.ticket();
        var saved = ticket.breadcrumbs();
        if (saved == null) walkedRoutes.anchor(ticket.footing().asLong());
        else walkedRoutes.restore(saved);
    }

    /** An exact local face is sufficient from any stable stance; an old gap is not a veto. */
    private void rememberPendingContact(BlockHitResult hit) {
        pendingFace = face(hit);
        long current = player.getBlockPos().asLong();
        if (!walkedRoutes.connected(current)) walkedRoutes.anchor(current);
    }

    private boolean pendingRouteSupport(BlockPos support) {
        var ticket = pendingEntry();
        if (ticket == null || !ticket.mayInvestigateCollection() || pendingUncertain
                || !ticket.ticket().equals(pendingRouteTicket)) return false;
        return walkedRoutes.connected(AgentRouteGraph.cell(support.getX(), support.getY() + 1, support.getZ()));
    }

    private boolean pendingParked() {
        return pendingOrigin == null || !pendingOrigin.active();
    }

    private void requireFreshParkedView() {
        parkedViewAfterFrame = body.renderedFrame();
        parkedViewPublished = false;
    }

    private boolean parkedViewReady() {
        return action == null && !hasActiveWorkOrder() && personalCraft == null && !urgent && settled()
            && body.renderedFrame() > parkedViewAfterFrame && releasedPendingHands()
            && body.renderedDirection(player.getYaw(), player.getPitch(), 2);
    }

    private boolean pendingCollectionPremise(AgentPendingFurnaceMemory.Entry ticket) {
        return ticket != null && pendingParked() && !hasActiveWorkOrder() && ticket.mayInvestigateCollection()
            && !pendingUncertain && hazardClear && !urgent && releasedPendingHands() && ironFooting(player.getBlockPos().down())
            && world.getRegistryKey().getValue().toString().equals(ticket.dimension())
            && AgentClient.ownsSinglePlayerFurnaceWorld(client, player);
    }

    private boolean pendingReturnKnown(AgentPendingFurnaceMemory.Entry ticket) {
        long from = player.getBlockPos().asLong();
        if (!ticket.ticket().equals(pendingRouteTicket) || !walkedRoutes.connected(from)) return false;
        if (from == walkedRoutes.anchor()) return true;
        if (client.options.forwardKey.isUnbound()) return false;
        int fromY = player.getBlockY();
        long next = walkedRoutes.next(from);
        return next != AgentRouteGraph.NO_CELL
            && (AgentRouteGraph.y(next) <= fromY || !client.options.jumpKey.isUnbound());
    }

    private boolean pendingReturnInFlight() {
        var collect = action.pendingCollection;
        return collect != null && collect.tread != null && collect.tread.inFlight() && !player.isTouchingWater()
            && !player.hasVehicle() && !player.getAbilities().flying && client.interactionManager != null
            && client.interactionManager.getCurrentGameMode() == GameMode.SURVIVAL;
    }

    private boolean pendingContactCurrent(PendingCollection collect) {
        var current = pendingEntry();
        return current != null && current.ticket().equals(collect.entry.ticket()) && current.mayInvestigateCollection()
            && !pendingUncertain && pendingParked() && world == client.world && player == client.player
            && world.getRegistryKey().getValue().toString().equals(current.dimension())
            && AgentClient.ownsSinglePlayerFurnaceWorld(client, player)
            && player.isAlive() && grounded() && hazardClear && !urgent && client.getCameraEntity() == player
            && client.options.getPerspective().isFirstPerson() && collect.footing != null && ironFooting(collect.footing)
            && collect.stance != null && horizontalSquared(player.getPos(), collect.stance) <= 0.04
            && (collect.face == null || player.getEyePos().squaredDistanceTo(collect.face.getPos()) <= reach() * reach()
                && matchingPendingStation(current));
    }

    private boolean matchingPendingStation(AgentPendingFurnaceMemory.Entry ticket) {
        var state = world.getBlockState(ticket.pos());
        return state.isOf(Blocks.FURNACE) && state.get(AbstractFurnaceBlock.FACING) == ticket.facing();
    }

    private BlockHitResult livePendingFace(AgentPendingFurnaceMemory.Entry ticket) {
        double range = reach();
        BlockPos pos = ticket.pos();
        Vec3d eye = player.getEyePos();
        if (eye.squaredDistanceTo(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5) > (range + 0.87) * (range + 0.87))
            return null;
        return body.find(state -> state.isOf(Blocks.FURNACE) && state.get(AbstractFurnaceBlock.FACING) == ticket.facing(),
            range, hit -> hit.getBlockPos().equals(pos) && body.macroMineWitness(hit, range) != null).orElse(null);
    }

    private void advancePendingCollection() {
        var collect = action.pendingCollection;
        var entry = collect.entry;
        var current = pendingEntry();
        if (pendingUncertain || current == null || !current.ticket().equals(entry.ticket()) || !current.mayInvestigateCollection()
                || !AgentClient.ownsSinglePlayerFurnaceWorld(client, player) || urgent) {
            interrupt("The original station continuity cannot authorize this withdrawal.", true);
            return;
        }
        if (!collect.withdrawal.issued() && !collect.returnInventory.unchanged(player.getInventory())) {
            interrupt("Carried stock changed during the station return; no output withdrawal was authorized.", true);
            return;
        }
        if (collect.footing == null && !advancePendingReturn(collect)) return;
        if (!pendingContactCurrent(collect)) {
            interrupt("The return stance, live connection or first-person reach no longer matches the paid furnace.", true);
            return;
        }
        if (action.opened == null) {
            if (action.fired) {
                if (action.furnace.contactObserved && client.currentScreen instanceof FurnaceScreen furnace) {
                    action.opened = furnace;
                    action.furnace.openedTick = tick;
                } else if (client.currentScreen != null || tick - action.firedAt > FURNACE_SYNC_TICKS) {
                    interrupt("No exact vanilla furnace screen followed the authorized contact.", false);
                }
                return;
            }
            if (client.currentScreen != null || !cursorClear() || !useAvailable() || !body.hasRecentView()
                    || body.renderedFrame() <= action.startingFrame || !hands.releasedForPendingWork()) return;
            BlockHitResult live = livePendingFace(entry);
            if (live == null) {
                Face witness = action.offer.face != null ? action.offer.face : pendingFace;
                Vec3d aim = witness == null ? Vec3d.ofCenter(entry.pos()) : witness.hit.getPos();
                body.aim(aim);
                return;
            }
            collect.face = live;
            rememberPendingContact(live);
            if (action.furnace == null) action.furnace = new FurnaceWork(collect.footing);
            contactFurnace(action.furnace, live);
            return;
        }
        var furnace = (FurnaceScreen) action.opened;
        var handler = furnace.getScreenHandler();
        if (client.currentScreen != furnace || player.currentScreenHandler != handler) {
            interrupt("The exact reopened handler changed before storing the paid result.", true);
            return;
        }
        var sync = (AgentFurnaceSync) handler;
        if (shown != furnace || !sync.agent$furnaceContentsSynced() || tick - action.furnace.openedTick < 2) {
            if (tick - action.furnace.openedTick > FURNACE_SYNC_TICKS)
                interrupt("Vanilla did not render and freshly synchronize the reopened station.", true);
            return;
        }
        var raw = handler.getSlot(0).getStack();
        var fuel = handler.getSlot(1).getStack();
        var output = handler.getOutputSlot().getStack();
        var batch = entry.batch();
        if (collect.withdrawal.issued()) {
            if (!raw.isEmpty() || !fuel.isEmpty()) {
                interrupt("The exact output withdrawal lost its empty paid input and fuel slots.", true);
            } else if (action.craftJob != hands.jobGeneration()) {
                interrupt("The exact output withdrawal hand job was replaced.", true);
            } else if (hands.busy()) {
                hands.tick();
            } else if (!hands.status().equals("smelt: done") || !cursorClear() || !output.isEmpty()
                    || !collect.withdrawal.confirms(ironStock(batch), batch)) {
                interrupt("No exact inventory gain relative to the fresh collection baseline was proved.", true);
            } else if (collect.storedAt == 0) {
                collect.storedAt = tick;
            } else if (tick - collect.storedAt >= 3) {
                completePendingCollection(collect, furnace);
            }
            return;
        }
        if (!cursorClear() || !body.keysNeutral() || !hands.releasedForPendingWork()) {
            interrupt("The exact furnace no longer has clean, neutral collection controls.", true);
            return;
        }
        boolean burning = handler.isBurning() && world.getBlockState(entry.pos()).get(AbstractFurnaceBlock.LIT);
        long limit = Math.min(action.intent.expires, action.started + action.offer.key.verb.maxTicks) - FURNACE_SYNC_TICKS;
        var result = collect.result;
        switch (result.observe(tick, limit, handler.syncId, sync.agent$furnaceContentsSynced(),
                sync.agent$furnaceOutputUpdates(), batch, raw, fuel, output,
                burning, handler.getCookProgress(), handler.getFuelProgress())) {
            case BINDING_CHANGED -> interrupt("The reopened furnace has no independently synchronized new vanilla handler.", true);
            case STOCK_CHANGED -> {
                String detail = "Fresh furnace slots do not conserve this batch's paid input, fuel and output.";
                invalidatePending(detail);
                interrupt(detail, true);
            }
            case PENDING -> {
                if (hands.closeWorkFurnaceWithEscape(furnace)) {
                    pendingRecheck = new PendingRecheck(result.minimumOutput(), result.maximumFuel(), burning);
                    pendingRecheckedUntil = tick + result.remainingTicks();
                    action.opened = null;
                    finish("interrupted", "The fresh furnace slots did not prove a complete result or a short active finish. The paid batch is still pending.");
                } else interrupt("Could not cleanly close the still-pending furnace after rechecking the result.", true);
            }
            case WAIT -> {
                status = "Waiting briefly on the exact reopened furnace for the rest of its paid output.";
                continuityWork = AgentPauseEpisodes.Work.MECHANICAL_WAIT;
            }
            case READY -> {
                var from = ironStock(batch);
                if (!hands.collectWorkIron(furnace, batch.units(), result.afterOutputUpdate()) || !collect.withdrawal.begin(from)) {
                    interrupt(hands.status(), true);
                    return;
                }
                action.craftJob = hands.jobGeneration();
            }
        }
    }

    /** Follow a bounded slice; carry momentum only through a second independently revalidated tread. */
    private boolean advancePendingReturn(PendingCollection collect) {
        if (client.currentScreen != null || !cursorClear() || client.getCameraEntity() != player
                || !client.options.getPerspective().isFirstPerson()) {
            interrupt("The known return lost clean first-person controls.", true);
            return false;
        }
        if (collect.tread != null) {
            var tread = collect.tread;
            var successor = pendingReturnSuccessor(collect, tread);
            switch (tread.step(client, body, tick, successor)) {
                case CHECKING -> status = "Checking the exact next walked return tread from this stance";
                case MOVING -> {
                    status = "Traversing the revalidated dry return lane";
                    if (player.getVelocity().horizontalLengthSquared() > 0.0025)
                        continuityWork = AgentPauseEpisodes.Work.ROUTE;
                }
                case LANDED -> {
                    body.recordWalkedLeg(tread.from, tread.to);
                    collect.tread = successor != null && successor.inFlight() ? successor : null;
                    collect.stopAtTread = false;
                    ++collect.walked;
                    continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                }
                case REFUSED -> {
                    if (tread.rememberedLaneChanged(client, body)) walkedRoutes.rejected(tread.from.asLong(), tread.to.asLong());
                    interrupt("The next walked return tread, landing or reverse support could not be revalidated.", true);
                }
            }
            return false;
        }
        BlockPos foot = player.getBlockPos();
        if (!body.hasRecentView() || !ironFooting(foot.down())) return false;
        var local = livePendingFace(collect.entry);
        if (local != null || foot.asLong() == walkedRoutes.anchor()) {
            if (local != null) rememberPendingContact(local);
            collect.footing = foot.down();
            collect.stance = player.getPos();
            return true;
        }
        long next = walkedRoutes.next(foot.asLong());
        if (next == AgentRouteGraph.NO_CELL) {
            interrupt("No connected walked dry return to the paid furnace is known from this stance.", true);
        } else if (collect.walked == PENDING_RETURN_LEGS || collect.walked > 0
                && action.intent.expires - tick <= AgentSurfaceTread.ACTION_TICKS) {
            finish("interrupted", "Settled after " + collect.walked
                + " revalidated return leg(s). The furnace is still pending; use a fresh recall to continue.");
        } else {
            collect.tread = AgentSurfaceTread.recall(client, foot, BlockPos.fromLong(next), tick);
            if (collect.tread == null) interrupt("The next retained dry edge or its ordinary movement controls changed.", true);
        }
        return false;
    }

    private AgentSurfaceTread pendingReturnSuccessor(PendingCollection collect, AgentSurfaceTread tread) {
        if (!tread.inFlight() || tread.from.getY() != tread.to.getY() || collect.walked + 1 >= PENDING_RETURN_LEGS
                || action.intent.expires - tick <= AgentSurfaceTread.ACTION_TICKS
                || tread.to.asLong() == walkedRoutes.anchor() || !body.hasRecentView()) return null;
        if (!collect.stopAtTread && player.isOnGround() && player.getBlockPos().equals(tread.to))
            collect.stopAtTread = livePendingFace(collect.entry) != null;
        if (collect.stopAtTread) return null;
        long next = walkedRoutes.next(tread.to.asLong());
        return next == AgentRouteGraph.NO_CELL ? null : tread.recallSuccessor(client, BlockPos.fromLong(next), tick);
    }

    private void completePendingCollection(PendingCollection collect, FurnaceScreen furnace) {
        var origin = pendingOrigin;
        var entry = collect.entry;
        int units = entry.batch().units();
        String detail = "Collected " + units + " furnace-produced iron ingot(s) into actual vanilla inventory.";
        var evidence = header(run);
        evidence.addProperty("id", entry.ticket().toString());
        evidence.addProperty("life", life);
        evidence.addProperty("tick", tick);
        evidence.addProperty("milestone", "collected");
        evidence.addProperty("cookMode", "pending_work");
        evidence.addProperty("chargedUnits", units);
        evidence.addProperty("chargedFuel", entry.batch().fuelCount());
        evidence.addProperty("fuelItem", Registries.ITEM.getId(entry.batch().fuel()).toString());
        evidence.addProperty("originalSyncId", entry.syncId());
        var handler = furnace.getScreenHandler();
        evidence.addProperty("syncId", handler.syncId);
        evidence.addProperty("slotOutputUpdates", ((AgentFurnaceSync) handler).agent$furnaceOutputUpdates());
        evidence.add("beforeStock", ironReceiptStock(collect.withdrawal.baseline()));
        evidence.add("carriedStock", ironReceiptStock(ironStock(entry.batch())));
        ipc.evidence("furnace-" + entry.ticket() + "-collected.json", evidence.toString());
        finishPendingMemory(entry);
        if (origin != null && origin.phase.equals("parked")) {
            origin.confirmedCrafts += units;
            origin.collectedIron = true;
            origin.lastEffect = detail;
            origin.lastEffectTick = origin.completedTick = tick;
            boolean targetMet = count(Items.IRON_INGOT) >= goalAmount(origin.order.policy().target())
                && origin.budget.missingFloor(player.getInventory()) == null;
            origin.phase = targetMet ? "complete" : "needs_replan";
            origin.detail = detail;
            origin.enactedPhase = targetMet ? "complete" : "hold";
            origin.enactedStatus = detail;
            receipt(origin.order.id(), origin.order.life(), targetMet ? "completed" : "interrupted",
                targetMet ? detail : detail + " The original stock target or reserve is still unmet.");
        }
        rememberStation(face(collect.face));
        furnace.close();
        continuityWork = AgentPauseEpisodes.Work.GUI;
        complete(detail);
    }

    private void startFurnaceWatch(FurnaceWork iron, FurnaceScreen furnace, Face target) {
        if (!AgentClient.ownsSinglePlayerFurnaceWorld(client, player)) {
            interrupt("Cannot leave the paid furnace: this connection and visible roster do not prove actor-only access.", true);
            return;
        }
        if (!ironStock(iron.batch).equals(iron.paid) || !hands.closeWorkFurnaceWithEscape(furnace)) {
            interrupt("The paid stock, clean hand releases or vanilla Escape close did not settle; no watch began.", true);
            return;
        }
        iron.watch = new AgentFurnaceWatch(target.hit.getBlockPos(), target.state.get(AbstractFurnaceBlock.FACING),
            iron.syncId, iron.paid, iron.batch, iron.output, iron.fuelRemaining, iron.progress, tick, now);
        iron.closedFrame = body.renderedFrame();
        iron.cueUntil = tick + FURNACE_CUE_TICKS;
        iron.phase = FurnacePhase.WATCHING;
        action.opened = null;
        action.fired = iron.contactEntered = iron.contactObserved = false;
        iron.contact = null;
        ironStatus("Closed the clean furnace with vanilla Escape; remaining on the exact dry stance.");
    }

    private void advanceFurnaceWatch(FurnaceWork iron, Face target) {
        if (client.currentScreen != null || player.currentScreenHandler != player.playerScreenHandler || !cursorClear()
                || !body.keysNeutral() || hands.busy()) {
            interrupt("A screen, cursor or other input owner interrupted the closed furnace watch.", false);
            return;
        }
        continuityWork = AgentPauseEpisodes.Work.MECHANICAL_WAIT;
        long frame = body.renderedFrame();
        if (frame <= iron.closedFrame || !body.hasRecentView()) {
            if (tick > iron.cueUntil && iron.watchFrame == 0)
                interrupt("No fresh rendered in-world view confirmed the vanilla Escape close.", true);
            return;
        }
        if (iron.watchFrame == 0) {
            iron.watchFrame = frame;
            ironMilestone("watch_closed", "Vanilla Escape closed the clean paid furnace; a fresh first-person view confirms the stationary dry stance.");
            if (pendingOrigin == work && pendingEntry() != null) {
                body.pauseWork();
                return;
            }
            startFurnaceSurvey(iron);
        }
        if (pendingOrigin == work && pendingEntry() != null && !pendingWorldRelease) {
            if (frame <= iron.watchFrame || !body.renderedDirection(player.getYaw(), player.getPitch(), 2)
                    || !releasedPendingHands()) return;
            pendingWorldRelease = true;
            pendingEstimate = iron.watch;
            iron.releaseTick = tick;
            return;
        }
        if (iron.watch.elapsed(tick, now)) {
            iron.phase = FurnacePhase.REOPENING;
            iron.reacquireUntil = tick + FURNACE_REACQUIRE_TICKS;
            ironStatus("The paid batch's vanilla cook time elapsed; re-witnessing the same furnace, not assuming output.");
        } else if (iron.watch.remainingTicks(tick) <= FURNACE_REACQUIRE_LEAD_TICKS) {
            if (!iron.turningBack) {
                iron.turningBack = true;
                ironStatus("Turning back toward the exact furnace while the paid cook time finishes.");
            }
            body.aim(target.hit.getPos());
        } else if (iron.cue != null) {
            if (tick <= iron.cueUntil) observeFurnaceCue(iron);
            else if (iron.cue.kind == FurnaceCue.WORKBENCH) aimFurnaceCue(iron, iron.scene);
            else {
                iron.cue = null;
                body.pauseWork();
                ironStatus("The earlier cave cue could not be confirmed; waiting without movement on the original dry stance.");
            }
        }
    }

    private void startFurnaceSurvey(FurnaceWork iron) {
        var earlier = iron.footing.equals(work.ironSceneFooting) ? work.ironScene : null;
        iron.scene = FurnaceLook.prefer(furnaceScene(iron.footing), earlier);
        if (iron.scene == null) {
            ironStatus("No distinct cave cue was witnessed; waiting on the original dry stance without turning to a known bench.");
            return;
        }
        var table = visibleStation(Blocks.CRAFTING_TABLE);
        if (table == null && personalTable != null && stationClueCurrent(personalTable)
                && player.getEyePos().squaredDistanceTo(personalTable.face.hit.getPos()) <= reach() * reach())
            table = personalTable.face.hit;
        aimFurnaceCue(iron, table == null ? iron.scene : new FurnaceLook(FurnaceCue.WORKBENCH, table));
    }

    /** Select from the current frustum only. Choosing a cue never turns the camera or finds a hidden destination. */
    private FurnaceLook furnaceScene(BlockPos footing) {
        BlockHitResult floor = watchedDryFoothold(footing);
        if (floor != null) return new FurnaceLook(FurnaceCue.DRY_FOOTHOLD, floor);
        double reach = reach();
        ItemStack tool = player.getMainHandStack();
        var ore = body.find(state -> caveCueOre(state) && (!state.isToolRequired() || tool.isSuitableFor(state)), reach,
            hit -> !hit.getBlockPos().equals(footing) && body.macroMineWitness(hit, reach) != null).orElse(null);
        if (ore != null) return new FurnaceLook(FurnaceCue.MATERIAL, ore);
        var opening = body.caveFloorLandmark(footing);
        if (opening != null && body.caveFloorLandmarkCurrent(opening)) return new FurnaceLook(FurnaceCue.OPENING, opening);
        var water = body.visibleFluid(false, true, reach);
        return water != null && body.waterFillWitness(water, reach) ? new FurnaceLook(FurnaceCue.WATER, water) : null;
    }

    private BlockHitResult watchedDryFoothold(BlockPos footing) {
        for (Direction direction : CARDINAL) {
            BlockPos next = footing.offset(direction);
            BlockHitResult floor = body.macroFloor(next);
            if (floor != null && watchedDryLane(next)) return floor;
        }
        return null;
    }

    private boolean watchedDryLane(BlockPos pos) {
        Vec3d landing = Vec3d.ofBottomCenter(pos.up());
        return body.macroFlatLane(pos, world.getBlockState(pos), landing) && body.macroNoVisiblePickup(landing);
    }

    private void aimFurnaceCue(FurnaceWork iron, FurnaceLook cue) {
        iron.cue = cue;
        Vec3d eye = player.getEyePos();
        iron.cueAim = new Camera(cue.lookYaw(eye), cue.lookPitch(eye));
        iron.cueFromFrame = body.renderedFrame();
        iron.cueUntil = tick + FURNACE_CUE_TICKS;
        ironStatus(switch (cue.kind) {
            case WORKBENCH -> "Rechecking the nearby table for a possible next recipe while the paid batch cooks.";
            case WATER -> "Checking the witnessed cave water for a bucket source and watching the dry boundary.";
            case DRY_FOOTHOLD -> "Checking a witnessed cave-side foothold and its dry approach.";
            case OPENING -> "Checking the ground on the bearing of a visible dry opening; no route assumed.";
            case MATERIAL -> "Checking a witnessed ore face in reach without using the pickaxe.";
        });
        body.turnFine(iron.cueAim.yaw, iron.cueAim.pitch);
    }

    private String furnaceCueFact(FurnaceLook cue) {
        BlockPos pos = cue.hit.getBlockPos();
        return switch (cue.kind) {
            case WORKBENCH -> {
                var table = body.macroMineWitness(cue.hit, reach());
                if (table == null || !world.getBlockState(pos).isOf(Blocks.CRAFTING_TABLE)) yield null;
                rememberStation(face(table));
                yield "Re-witnessed the crafting table in reach for a possible next recipe; no item or movement used.";
            }
            case WATER -> {
                var water = body.terrain(cue.hit.getPos(), AgentHazards.SIGHT_RANGE).orElse(null);
                if (water == null || !water.getBlockPos().equals(pos))
                    water = body.visibleFluid(false, false, AgentHazards.SIGHT_RANGE);
                if (water == null || !water.getBlockPos().equals(pos)
                        || !world.getBlockState(pos).getFluidState().isIn(FluidTags.WATER)) yield null;
                var shore = watchedDryFoothold(player.getBlockPos().down());
                String route = shore == null ? "" : " A lit dry adjacent approach is "
                    + bearing(shore.getPos(), player.getPos(), player.getYaw()) + " while facing the water.";
                var source = body.visibleFluid(false, true, reach());
                String fluid = source != null && body.waterFillWitness(source, reach())
                    ? "A plain water source is visible in bucket reach from the dry furnace stance; no water taken."
                    : AgentBody.exactWaterSource(world.getBlockState(pos))
                        ? "The cave water source is visible, but a valid bucket contact was not confirmed from this dry stance."
                        : "The nearby cave water is flowing; no fillable source was witnessed from the dry furnace stance.";
                yield fluid + route;
            }
            case DRY_FOOTHOLD -> body.macroFloor(pos) != null && watchedDryLane(pos)
                ? "The adjacent cave-side tile has a lit full top and a clear, dry approach without visible pickups; no move made." : null;
            case OPENING -> body.caveFloorLandmarkCurrent(cue.hit)
                ? "The lit dry opening is visible on this bearing; intervening footing and return are not yet proved." : null;
            case MATERIAL -> {
                var ore = body.macroMineWitness(cue.hit, reach());
                if (ore == null || !resource(world.getBlockState(pos))) yield null;
                yield blockName(face(ore)) + " is visible in reach from the original cave stance; it was not mined.";
            }
        };
    }

    private void observeFurnaceCue(FurnaceWork iron) {
        FurnaceLook cue = iron.cue;
        Camera aim = iron.cueAim;
        if (body.renderedFrame() <= iron.cueFromFrame || !body.renderedDirection(aim.yaw, aim.pitch, 9)) {
            body.turnFine(aim.yaw, aim.pitch);
            return;
        }
        String detail = furnaceCueFact(cue);
        if (detail == null) {
            body.turnFine(aim.yaw, aim.pitch);
            return;
        }
        body.pauseWork();
        if (cue.kind == FurnaceCue.WORKBENCH) {
            ironMilestone("watch_cue", detail);
            aimFurnaceCue(iron, iron.scene);
        } else {
            furnaceFact = new FurnaceFact(cue, player.getPos(), tick, detail, false);
            ironMilestone("watch_fact", detail);
            iron.cue = null;
            ironStatus("Keeping watch toward the witnessed cave cue from dry footing while the paid batch finishes.");
        }
    }

    /** Keep the read-only clue across the cook and recipe receipts; ordinary offers still require live sight. */
    private String retainedFurnaceFact() {
        var fact = furnaceFact;
        if (fact == null) return null;
        if (tick - fact.tick >= AgentWorkOrder.MAX_TICKS + STATION_RECALL_TICKS
                || horizontalSquared(fact.stance, player.getPos()) > 0.04
                || Math.abs(fact.stance.y - player.getY()) > 0.06) {
            furnaceFact = null;
            return null;
        }
        if (!fact.rechecked && action == null && observableWorld() && body.renderedAim(fact.look.hit.getPos(), 18)) {
            String current = furnaceCueFact(fact.look);
            if (current != null) furnaceFact = fact = new FurnaceFact(fact.look, fact.stance, fact.tick, current, true);
        }
        return (fact.rechecked ? "Rechecked furnace-watch clue" : "Furnace watch from this stance")
            + " (fresh view required before acting): " + fact.detail;
    }

    private void ironStatus(String detail) {
        work.detail = status = detail;
        enact("smelt", detail);
    }

    private boolean ironMilestone(String milestone, String detail) {
        ironStatus(detail);
        if (milestone.equals("collected")) {
            work.lastEffectTick = tick;
            work.lastEffect = detail;
        }
        FurnaceWork iron = action.furnace;
        var value = header(run);
        value.addProperty("id", work.order.id());
        value.addProperty("life", life);
        value.addProperty("tick", tick);
        value.addProperty("milestone", milestone);
        value.addProperty("furnaceBinding", iron.binding);
        value.addProperty("syncId", iron.syncId);
        value.addProperty("chargedUnits", iron.batch.units());
        value.addProperty("chargedFuel", iron.batch.fuelCount());
        value.addProperty("fuelItem", Registries.ITEM.getId(iron.batch.fuel()).toString());
        value.addProperty("cookMode", AgentFurnaceWatch.required(iron.batch) ? "world_watch" : "gui_single_unit");
        value.add("beforeStock", ironReceiptStock(iron.before));
        value.add("carriedStock", ironReceiptStock(ironStock(iron.batch)));
        if (iron.watch != null) {
            value.addProperty("originalSyncId", iron.watch.syncId);
            if (iron.watchFrame != 0) value.addProperty("worldFrame", iron.watchFrame);
        }
        if (milestone.equals("watch_cue") || milestone.equals("watch_fact")) {
            value.addProperty("cue", iron.cue.kind.name().toLowerCase(java.util.Locale.ROOT));
            value.addProperty("cueFrame", body.renderedFrame());
        }
        if (action.opened instanceof FurnaceScreen furnace) {
            var handler = furnace.getScreenHandler();
            value.addProperty("slotRevision", handler.getRevision());
            value.addProperty("slotOutputUpdates", ((AgentFurnaceSync) handler).agent$furnaceOutputUpdates());
            value.addProperty("slotRaw", handler.getSlot(0).getStack().getCount());
            value.addProperty("slotFuel", handler.getSlot(1).getStack().getCount());
            value.addProperty("slotOutput", handler.getOutputSlot().getStack().getCount());
        }
        value.addProperty("detail", detail);
        return ipc.evidence("furnace-" + work.order.id() + "-" + milestone + ".json", value.toString());
    }

    private static JsonObject ironReceiptStock(AgentFurnaceWatch.Stock stock) {
        var value = new JsonObject();
        value.addProperty("raw", stock.raw());
        value.addProperty("fuel", stock.fuel());
        value.addProperty("ingots", stock.ingots());
        return value;
    }

    private void idle(AgentProgress progress, boolean thinking) {
        if (trial) {
            status = "holding the isolated trial view";
            state("trial_idle", status);
            return;
        }
        long idleNanos = now - idleSince;
        boolean due = blocked || idleNanos >= PLANNING_IDLE_LIMIT_NS;
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
                LocalWork work = localOffer(progress);
                if (work == null) {
                    if (due) {
                        block(localHoldReason == null ? "No safe step toward a witnessed resource." : localHoldReason);
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
            block("No safe adjacent step toward a witnessed resource.");
        } else {
            status = "waiting for a current local plan";
            state(thinking ? "planning_wait" : "awaiting_plan", thinking
                ? "A trusted planning episode is pending." : "No provider decision is pending.");
        }
    }

    private record LocalWork(Offer offer, Offer[] anchors, float walkPitch) {
        LocalWork(Offer offer, Offer[] anchors) { this(offer, anchors, Float.NaN); }
    }

    private LocalWork localOffer(AgentProgress progress) {
        localHoldReason = null;
        Offer step = null;
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
            localHoldReason = "A useful material face is still visible; no new local action can preserve the view.";
            return null;
        }
        BlockHitResult feature = body.find(AgentMacroControl::resource, INSPECT_REACH).orElse(null);
        if (feature == null || feature.getPos().squaredDistanceTo(client.player.getEyePos()) <= reach() * reach()
                || localSteps.size() >= 32) return null;
        double improvement = 0.5;
        localSteps.add(client.player.getBlockPos().down());
        for (Offer offer : current) {
            if (offer.key.verb != Verb.APPROACH || localSteps.contains(offer.floor.pos)) continue;
            double benefit = horizontalSquared(from, feature.getPos()) - horizontalSquared(offer.floor.landing, feature.getPos());
            if (benefit > improvement && validate(offer, progress) == null) {
                improvement = benefit;
                step = offer;
            }
        }
        return step == null ? null : new LocalWork(step, NO_ANCHORS);
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

    private boolean retainsAnchors(Offer[] anchors, Vec3d feet, float yaw, float pitch) {
        Vec3d from = player.getEyePos().add(feet.subtract(player.getPos()));
        double max = reach();
        for (Offer anchor : anchors) {
            if (!body.macroRetainsView(anchor.face.hit.getPos(), feet, yaw, pitch)) return false;
            if (from.squaredDistanceTo(anchor.face.hit.getPos()) > max * max) return false;
        }
        return true;
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
            case SURVEY -> {
                if (STARTUP_OUTLOOK.equals(offer.key.activity)) {
                    var ceiling = firstOutlookPending && startupInputsClear && work == null && pendingEntry() == null
                        && offer.key.entity == surveyOrigin && stationaryWorldControls()
                        && Math.abs(MathHelper.wrapDegrees(player.getYaw() - offer.yaw)) <= 2 ? startupCeiling() : null;
                    yield ceiling == null || !offer.key.pos.equals(ceiling.getBlockPos())
                        || world.getBlockState(ceiling.getBlockPos()) != offer.key.state
                        ? "The inherited ceiling view or its neutral starting stance changed." : null;
                }
                yield repeatedSourceView() || retiredViews.contains(offer.key) || offer.key.entity != surveyOrigin || anchor == null
                    || horizontalSquared(anchor, player.getPos()) > 0.64
                    || angle(player.getYaw(), player.getPitch(), offer.yaw, offer.pitch) < 5
                    ? "The bounded survey is already done or its origin changed." : null;
            }
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
            case INTERACT -> !paidStation(offer.face) && visibleFace(offer.face) && useAvailable()
                ? null : "The workstation is reserved for exact recall or its live use premise changed.";
            case CONTINUE -> pendingRecipeSafe(offer.recipe) && ingredients(offer.recipe) && (offer.face == null
                ? !client.options.inventoryKey.isUnbound() : visibleFace(offer.face) && useAvailable())
                ? null : "The recipe ingredients, storage, or workstation changed.";
            case FOLLOW -> routeCurrent(offer, progress) ? null : "The exact witnessed dry segment or its source changed.";
            case COLLECT_PENDING -> {
                var ticket = pendingEntry();
                yield pendingCollectionPremise(ticket) && ticket.ticket().toString().equals(offer.key.activity)
                    && player.getBlockPos().equals(offer.key.pos)
                    && (offer.face == null ? pendingReturnKnown(ticket)
                        : body.macroMineWitness(offer.face.hit, reach()) != null && matchingPendingStation(ticket))
                    ? null : "The exact paid ticket, safe station return or clean controls changed.";
            }
            case DEFER_PENDING -> "Only the exact released furnace watch can be deferred.";
            case WATER_CLUE, FOOD_CLUE -> "A source clue grants no primitive action.";
            case WORK_WALK, WORK_EQUIP, WORK_PLACE, WORK_TREAD, WORK_SMELT, WORK_FILL, WORK_FORAGE ->
                "This operation requires a native work order.";
        };
    }

    private void step(AgentProgress progress) {
        Offer offer = action.offer;
        status = offer.summary;
        if (client.currentScreen != null && offer.key.verb != Verb.INTERACT && offer.key.verb != Verb.CONTINUE
                && offer.key.verb != Verb.COLLECT_PENDING) {
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
            case SURVEY -> fixedSurvey();
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
            case APPROACH, COLLECT -> {
                if (offer.scout != null) {
                    if (offer.scout.rise != null) walkScoutRise(offer.scout);
                    else if (offer.scout.vantage != null) walkGroundVantage(offer.scout);
                    else if (offer.scout.landing != null) walkDryLanding(offer.scout.landing);
                    else walkGroundScout(offer.scout);
                }
                else {
                    trackDiamondRecoveryWalk();
                    walk(offer);
                }
            }
            case BREAK -> breakWitnessedFace(offer.face, progress);
            case INTERACT, CONTINUE -> useOrCraft(offer);
            case COLLECT_PENDING -> {
                trackDiamondRecoveryWalk();
                advancePendingCollection();
            }
            case FOLLOW -> {
                trackDiamondRecoveryWalk();
                followRoute(offer, progress);
            }
            case WATER_CLUE, FOOD_CLUE, DEFER_PENDING, WORK_WALK, WORK_EQUIP, WORK_PLACE, WORK_TREAD, WORK_SMELT, WORK_FILL, WORK_FORAGE ->
                throw new IllegalStateException("Expected work step dispatch");
        }
    }

    enum FixedSurveyStep { TURN, FRAMED, INTERRUPT }

    static FixedSurveyStep fixedSurveyStep(boolean stationary, long frame, long admittedFrame, boolean targetRendered) {
        if (!stationary) return FixedSurveyStep.INTERRUPT;
        return frame > admittedFrame && targetRendered ? FixedSurveyStep.FRAMED : FixedSurveyStep.TURN;
    }

    private void fixedSurvey() {
        Camera target = action.camera;
        boolean stationary = stationaryWorldControls() && action.position.squaredDistanceTo(player.getPos()) <= 0.0144;
        boolean targetRendered = body.renderedDirection(target.yaw, target.pitch, 4)
            && Math.abs(MathHelper.wrapDegrees(player.getYaw() - target.yaw)) <= 4
            && Math.abs(player.getPitch() - target.pitch) <= 4
            && angle(action.yaw, action.pitch, player.getYaw(), player.getPitch()) >= 5;
        switch (fixedSurveyStep(stationary, body.renderedFrame(), action.startingFrame, targetRendered)) {
            case INTERRUPT -> interrupt("The survey lost its stationary neutral controls.", true);
            case FRAMED -> complete(STARTUP_OUTLOOK.equals(action.offer.key.activity)
                ? "The first-person camera rendered the outlook ahead."
                : "The first-person camera rendered the requested survey angle.");
            // Missing preceding renders cannot retarget or complete this action,
            // but need not cut the same already-authorized camera command.
            case TURN -> body.turnScan(target.yaw, target.pitch);
        }
    }

    private void surveyDryRoute(Offer offer, AgentProgress progress) {
        switch (progress.surveyDryRoute(offer.drySurvey)) {
            case RUNNING -> { }
            case PAIRED -> complete("A stationary rendered survey witnessed both directions of the dry edge. No movement was authorized.");
            case UNPROVED -> {
                String detail = "The glance did not prove a reversible lane: " + progress.drySurveyResult(offer.drySurvey) + ".";
                if (action.diamondRoute) diamondRoute.refuseCurrent(detail);
                complete(detail);
            }
            case REFUSED -> {
                String detail = "The exact survey source or rendered view was lost before it could be checked.";
                if (action.diamondRoute) diamondRoute.refuseCurrent(detail);
                interrupt(detail, true);
            }
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
            switch (progress.followDryRoute(offer.route, action.diamondRoute ? diamondCrossing : null)) {
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
                || Math.abs(player.getY() - destination.y) > 0.055
                || action.diamondRoute && !offer.route.endpoint().equals(diamondRoute.foot)) {
            interrupt("The player did not remain on the authorized dry endpoint.", true);
        } else if (settled() && tick - action.settledAt >= APPROACH_SETTLE_TICKS) {
            if (action.durable) {
                work.sourceSearch.footholds.add(offer.route.endpoint().down());
                work.sourceSearch.freshAfter = body.renderedFrame();
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
            }
            complete("Settled at the authorized dry endpoint after " + dryRouteDescription(offer.route) + ".");
        }
    }

    private void recordNaturalDiamondCrossing(AgentSurfaceTread.Edge edge) {
        recordDiamondTread(edge, true);
        work.sourceSearch.footholds.add(edge.lower().down());
        continuityWork = AgentPauseEpisodes.Work.NOVELTY;
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

    private String diamondCoverLiveRefusal(Face face, BlockPos target, ItemStack hand, AgentProgress progress) {
        if (world.getBlockState(target) != face.state)
            return "The witnessed cover state changed without an observed own break.";
        if (!ItemStack.areItemsAndComponentsEqual(action.harvestTool, hand))
            return "The selected harvest stack changed after the cover break was admitted.";
        if (!work.budget.canCutCover()) return "The remaining break grant is reserved for diamond ore.";
        if (!work.budget.policy.prospectCoverAllowed(face.state)) return "The current grant no longer permits this cover.";
        if (!surfaceBodyAllowsExtension()) return work.sourceBlock;
        String geometry = diamondCutRefusal(player.getBlockPos(), target);
        if (geometry != null) return geometry;
        if (diamondCutOverlaps(player.getBoundingBox(), target)) {
            action.retryDiamondInset = !diamondRoute.spareFloor && diamondRoute.cutInsetUntil == 0;
            return "The target overlaps the protected margin of the current stance.";
        }
        if (diamondRoute.spareFloor && !spareFloorEscapeCurrent(player.getBlockPos(), false))
            return "The independent dry exit for the selected spare floor changed.";
        String unsafe = diamondCoverSafetyRefusal(target, face.state, action.tracked, diamondRoute.bearing, progress);
        if (unsafe != null) return unsafe;
        var inventory = player.getInventory();
        if (!AgentProspectTools.roomForDiamond(inventory)) return "The inventory has no room for a diamond drop.";
        int loss = AgentProspectTools.coverLoss(inventory, inventory.selectedSlot, face.state, world, target, work.budget, prospectEquip);
        if (loss < 0) return prospectCoverToolRefusal(loss);
        action.handLoss = loss;
        return null;
    }

    private void breakWitnessedFace(Face face, AgentProgress progress) {
        BlockPos target = face.hit.getBlockPos();
        boolean diamondCover = action.prospectCover && action.diamondRoute;
        boolean mayBreak = action.broken;
        if (!mayBreak) {
            if (action.durable) {
                ItemStack hand = player.getMainHandStack();
                int loss = diamondCover ? 0 : deepWork() && AgentProspectTools.isOre(face.state)
                    ? AgentProspectTools.harvestLoss(hand, face.state, world, target)
                    : AgentMiningStock.maxLoss(hand, face.state, world, target);
                if (action.timberOpening != null) {
                    mayBreak = work.budget.policy.timberClearAllowed(face.state)
                        && work.budget.canOpenTimber(action.timberLogsNeeded) && loss == 0
                        && safeTimberOpening(action.timberOpening.pursuit, face, progress);
                } else if (diamondCover) {
                    String refusal = diamondCoverLiveRefusal(face, target, hand, progress);
                    if (refusal != null) {
                        interrupt(refusal + " Target: " + blockName(face) + " at " + target.toShortString() + ".", true);
                        return;
                    }
                    mayBreak = true;
                } else if (action.prospectCover) {
                    BlockPos foot = player.getBlockPos();
                    mayBreak = work.budget.canCutCover() && work.budget.policy.prospectCoverAllowed(face.state)
                        && surfaceBodyAllowsExtension()
                        && prospectCutGeometry(foot, face.hit, work.sourceSearch)
                        && dryWorkBreakSafe(target, face.state, action.tracked, progress);
                    var opening = work.surfaceOpening;
                    if (opening != null) {
                        mayBreak = mayBreak && face == opening.face && foot.equals(opening.foot)
                            && world.getBlockState(foot.down()) == opening.support
                            && surfaceToolMatches(hand, opening.tool) && loss == opening.loss;
                    }
                } else {
                    mayBreak = work.budget.canBreak() && work.budget.policy.breakAllowed(face.state)
                        && workResourceSafe(face.hit, face.state, progress);
                }
                if (!diamondCover) {
                    mayBreak = mayBreak && !client.options.attackKey.isUnbound()
                        && (!face.state.isToolRequired() || hand.isSuitableFor(face.state))
                        && loss >= 0 && AgentMiningStock.lootCompatible(hand, face.state)
                        && (loss == 0 || work.budget.limit(hand.getItem(), count(hand.getItem())) >= loss);
                    action.handLoss = loss;
                }
            } else {
                mayBreak = action.prospectCover ? directCapCurrent(face, progress) : canBreak(face, progress);
            }
        }
        if (action.broken) {
            continuityWork = AgentPauseEpisodes.Work.NOVELTY;
            if (action.durable && !action.prospectCover && action.timberOpening == null) {
                if (deepWork() || !work.sourceSearch.stairs.isEmpty()) work.sourceSearch.freshAfter = body.renderedFrame();
                if (timberBlock(face.state) && target.getY() >= player.getBlockY()) {
                    work.timberRecheck = null;
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
                + (action.timberOpening != null ? " obstruction. No timber, route or closer footing was confirmed by this break."
                    : action.diamondRoute && diamondRoute.spareFloor ? " spare floor. The lower tread is not yet proved."
                    : action.prospectCover ? " cover. No source or pickup is confirmed by this cut." : "."));
        } else if (!mayBreak || !diamondCover
                && !ItemStack.areItemsAndComponentsEqual(action.harvestTool, client.player.getMainHandStack())) {
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
        if (offer.key.verb == Verb.APPROACH && !action.durable && !trial && offer.farther == null
                && !walkedRoutes.recoveringWalk()) {
            walkHorizonApproach(offer.floor);
            return;
        }
        var player = client.player;
        Floor floor = action.secondHop ? offer.farther : offer.floor;
        Vec3d position = player.getPos();
        if (!action.walkMotion.observe(position.x, position.y, position.z)) {
            interrupt("The exact checked approach lost contiguous body motion.", true);
            return;
        }
        String pickup = unexpectedPickup();
        if (pickup != null) {
            interrupt(pickup, true);
            return;
        }
        if (offer.drop != null) {
            collectOnOfferedFloor(offer);
            return;
        }
        if (!body.hasRecentView()) return; // Do not issue another movement tick from a missing frame.
        if (IRON_WORKSHOP_STEP.equals(offer.key.activity) && (!world.getBlockState(floor.pos.up()).isAir()
                || !world.getBlockState(floor.pos.up(2)).isAir())) {
            interrupt("The witnessed dry workshop destination is no longer empty.", true);
            return;
        }
        if (tick != action.started && !body.macroNoVisiblePickup(floor.landing)) {
            interrupt("A visible pickup overlaps the walking lane, or the view cannot check it.", true);
            return;
        }
        if (!body.macroFlatLane(floor.pos, floor.state, floor.landing)) {
            interrupt("The witnessed flat walking lane is no longer safe.", true);
            return;
        }
        double remaining = horizontalSquared(position, floor.landing);
        if (action.drove && remaining + 0.008 < action.distanceLeft) {
            continuityWork = AgentPauseEpisodes.Work.ROUTE;
            action.distanceLeft = remaining;
        }
        if (remaining <= 0.1225 && action.drove && horizontalSquared(action.walkFrom, position) >= 0.16
                && player.getBlockPos().equals(floor.pos.up())) {
            if (!settled()) action.settledAt = 0;
            else if (action.settledAt == 0) action.settledAt = tick;
            else if (tick - action.settledAt >= APPROACH_SETTLE_TICKS) {
                recordApproachLeg(floor);
                if (!action.secondHop && offer.farther != null) {
                    if (!floorCurrent(offer.farther) || !body.macroNoVisiblePickup(offer.farther.landing)) {
                        interrupt("Stopped on the first verified tile; the farther lane did not revalidate.", true);
                        return;
                    }
                    surfaceSearch.footholds.add(floor.pos);
                    action.secondHop = true;
                    action.walkFrom = position;
                    action.walkMotion.start(position.x, position.y, position.z);
                    action.distanceLeft = horizontalSquared(position, offer.farther.landing);
                    action.drove = false;
                    action.settledAt = 0;
                } else complete(offer.farther == null ? "Reached the adjacent witnessed tile and stopped after actual displacement."
                    : "Reached the distinct witnessed foothold after two separately revalidated dry hops.");
            }
            return;
        }
        action.settledAt = 0;
        float yaw = action.keepVisible.length == 0 && !action.durable ? heading(floor.landing.x - position.x, floor.landing.z - position.z)
            : action.pathYaw;
        float pitch = action.pathPitch;
        body.macroFlatWalk(floor.landing, yaw, pitch);
    }

    private void collectOnOfferedFloor(Offer offer) {
        Floor floor = offer.floor;
        ItemEntity drop = offer.drop;
        if (drop.isRemoved()) {
            body.pauseWork();
            if (action.pickupDisappeared == 0) action.pickupDisappeared = tick;
            if (count(offer.item) > action.itemCount) {
                if (settled()) {
                    if (player.getBlockPos().equals(floor.pos.up())) recordApproachLeg(floor);
                    continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                    complete("The witnessed drop disappeared and the matching inventory count increased.");
                }
            } else if (tick - action.pickupDisappeared > 6) {
                interrupt("The drop disappeared without a matching inventory gain.", true);
            }
            return;
        }
        if (!body.hasRecentView()) return;
        if (!dropVisible(offer) || !dropNearLanding(drop, floor) || !roomFor(drop.getStack())
                || !body.macroFlatLane(floor.pos, floor.state, floor.landing)) {
            body.pauseWork();
            interrupt("The witnessed drop, available inventory space, or flat walking lane changed.", true);
            return;
        }
        if (body.pickUpVisible(drop, floor.landing, true) == AgentBody.PickupResult.BLOCKED)
            interrupt("No safe footstep remains on the offered pickup lane.", true);
    }

    private void walkHorizonApproach(Floor floor) {
        String pickup = unexpectedPickup();
        if (pickup != null) {
            interrupt(pickup, true);
            return;
        }
        if (!body.hasRecentView()) return;
        if (action.horizonTravel == null) {
            var target = body.visibleHorizon().target(body.macroFloor(floor.pos));
            if (target == null || world.getBlockState(floor.pos) != floor.state) {
                interrupt("The exact offered dry footing is no longer visible.", true);
                return;
            }
            action.horizonTravel = new AgentBody.HorizonTravel(target, floor.landing, 0.27, false);
        }
        if (action.horizonTravel.progressed()) continuityWork = AgentPauseEpisodes.Work.ROUTE;
        boolean within = player.getBlockPos().equals(floor.pos.up())
            && horizontalSquared(player.getPos(), floor.landing) <= 0.1225
            && world.getBlockState(floor.pos) == floor.state;
        switch (body.driveHorizon(action.horizonTravel, true, within)) {
            case MOVING, SETTLING -> { }
            case ARRIVED -> {
                if (settled() && grounded() && within)
                    complete("Reached the witnessed dry footing after actual continuous walking.");
                else if (!within) interrupt("Stopped without settling on the exact offered dry footing.", true);
            }
            case BLOCKED -> interrupt("The visible braking window did not support another step toward the offered footing.", true);
        }
    }

    private void walkGroundScout(GroundScout scout) {
        Vec3d feet = player.getPos();
        if (!cursorClear() || player.isUsingItem() || player.isTouchingWater() || player.isClimbing() || player.hurtTime != 0
                || Math.abs(feet.y - scout.from.y) > 0.055
                || horizontalSquared(feet, scout.from) > GROUND_SCOUT_LIMIT * GROUND_SCOUT_LIMIT
                || !action.walkInventory.unchanged(player.getInventory())) {
            interrupt("Ground reconnaissance lost its dry level stance, movement bound, or unchanged stock.", true);
            return;
        }
        if (action.scoutStoppedFrame >= 0) {
            if (!scoutReached(scout.from, scout.goal, feet)) {
                interrupt("Braking did not leave a settled stance inside the witnessed scout lane.", true);
                return;
            }
            completeGroundScout("Stopped after actual goalward movement on dry ground and rendered a new view. No harvest or collection authorized.");
            return;
        }
        if (!body.hasRecentView()) return;
        // Admission already rechecked the same face this tick.
        if (tick != action.started && groundScoutFace(scout.face) == null) {
            if (action.horizonTravel.moved() && scoutReached(scout.from, scout.goal, feet)) {
                // No more input. The endpoint may be valid even when the
                // approach landmark itself falls out of the landing view.
                body.stopHorizonTravel(action.horizonTravel);
                body.pauseWork();
                action.scoutStoppedFrame = body.renderedFrame();
            } else interrupt("The exact scout landmark is no longer visible on the checked approach.", true);
            return;
        }
        if (action.horizonTravel.progressed()) continuityWork = AgentPauseEpisodes.Work.ROUTE;
        boolean reached = scoutReached(scout.from, scout.goal, feet);
        switch (body.driveHorizon(action.horizonTravel, true, reached)) {
            case MOVING, SETTLING -> { }
            case ARRIVED -> {
                if (!reached) interrupt("The scout did not make enough goalward movement inside the checked lane.", true);
                else if (settled()) {
                    action.scoutStoppedFrame = body.renderedFrame();
                    body.pauseWork();
                }
            }
            case BLOCKED -> interrupt("Another step would exceed the visible dry stopping lane or cross a pickup.", true);
        }
    }

    private boolean scoutGradeInFlight() {
        var scout = action.offer.scout;
        return scout != null && (scout.landing != null && action.drove || scout.rise != null && action.fired)
            && !player.isOnGround() && !player.isTouchingWater() && !player.isOnFire() && player.hurtTime == 0;
    }

    private boolean recheckScoutRise(GroundScout scout) {
        var hit = groundScoutFace(scout.face);
        if (hit == null) return false;
        var proof = body.scoutRise(hit);
        return proof.grade() != null && proof.grade().edge().equals(scout.rise.edge());
    }

    private void walkScoutRise(GroundScout scout) {
        var tread = action.tread;
        if (!cursorClear() || !action.walkInventory.unchanged(player.getInventory()) || player.hurtTime != 0) {
            interrupt("The witnessed one-block rise lost safe controls or unchanged stock.", true);
            return;
        }
        if (!body.hasRecentView()) return;
        if (action.scoutStoppedFrame >= 0) {
            if (!scout.rise.floor().equals(player.supportingBlockPos.orElse(null))
                    || world.getBlockState(scout.rise.floor()) != scout.rise.surface()) {
                interrupt("The exact upper support changed before the relocated view.", true);
                return;
            }
            completeGroundScout("Climbed to the exact visible dry top and rendered a fresh view. No return or stock was proved.");
            return;
        }
        // The physical grade proof stays live on every motor tick. Before any
        // issued jump, also require the very same full top to still be visible.
        if (!body.scoutRisePhysics() || !action.fired && tick != action.started && !recheckScoutRise(scout)
                || action.fired && grounded() && !player.getBlockPos().equals(tread.to)) {
            interrupt("The one-block climb lost its witnessed or successfully joined jump envelope.", true);
            return;
        }
        switch (tread.step(client, body, tick)) {
            case CHECKING -> { }
            case MOVING -> {
                if (action.fired && (player.getY() > scout.from.y + 0.30 || horizontalSquared(player.getPos(), scout.from) > 0.16))
                    continuityWork = AgentPauseEpisodes.Work.ROUTE;
            }
            case REFUSED -> interrupt("The one-block climb lost its exact dry support, headroom or contiguous motion.", true);
            case LANDED -> {
                if (!action.fired || !scout.rise.floor().equals(player.supportingBlockPos.orElse(null))) {
                    interrupt("The authorised jump did not land on its exact dry upper top.", true);
                } else if (settled()) {
                    body.pauseWork();
                    action.scoutStoppedFrame = body.renderedFrame();
                    if (!action.purposefulMotion) {
                        action.purposefulMotion = true;
                        purposeful("terra: " + action.offer.summary);
                    }
                }
            }
        }
    }

    private void walkGroundVantage(GroundScout scout) {
        var vantage = scout.vantage;
        Vec3d feet = player.getPos();
        if (!cursorClear() || player.hurtTime != 0 || !action.walkInventory.unchanged(player.getInventory())
                || !action.walkMotion.observe(feet.x, feet.y, feet.z)) {
            interrupt("The same-top shift lost continuous motion, safety, or unchanged inventory.", true);
            return;
        }
        if (!body.hasRecentView()) return;
        if (!body.groundsVantage(vantage)) {
            interrupt("The exact supporting top, available clearance, or same-top stopping envelope changed.", true);
            return;
        }
        if (action.drove && action.walkMotion.traversed() && AgentGroundVantage.reached(scout.from, scout.goal, feet)) {
            if (action.scoutStoppedFrame < 0) {
                action.scoutStoppedFrame = body.renderedFrame();
                body.pauseWork();
                continuityWork = AgentPauseEpisodes.Work.ROUTE;
                action.purposefulMotion = true;
                purposeful("terra: " + action.offer.summary);
            } else if (!player.isSneaking()) {
                completeGroundScout("Shifted on the same dry support and rendered a fresh view from the new stance. No new route or stock was proved.");
            }
            return;
        }
        if (action.scoutStoppedFrame >= 0 || tick != action.started && groundScoutFace(scout.face) == null) {
            interrupt("The safe vantage or its visible direction changed before sufficient displacement.", true);
            return;
        }
        body.driveGroundVantage(vantage);
    }

    private void walkDryLanding(AgentDryLanding landing) {
        Vec3d feet = player.getPos();
        BlockPos to = landing.to();
        if (!cursorClear() || !action.walkInventory.unchanged(player.getInventory()) || player.hurtTime != 0
                || player.isTouchingWater() || feet.y > landing.source().getY() + 0.055 || feet.y < to.getY() - 0.055
                || !action.walkMotion.observe(feet.x, feet.y, feet.z)) {
            interrupt("The short dry descent lost contiguous motion, safety, or unchanged inventory.", true);
            return;
        }
        if (!body.hasRecentView()) return;
        if (!body.dryLandingClear(landing) || !body.macroNoVisiblePickup(landing.center(), to.getY(), landing.source().getY())) {
            interrupt("The witnessed landing or its dry body clearance changed. No further movement authorized.", true);
            return;
        }
        if (action.drove && horizontalSquared(landing.from(), feet) >= 0.16) {
            continuityWork = AgentPauseEpisodes.Work.ROUTE;
            if (!action.purposefulMotion) {
                action.purposefulMotion = true;
                purposeful("terra: " + action.offer.summary);
            }
        }
        if (player.isOnGround() && feet.y < landing.source().getY() - 0.055) {
            if (!player.getBlockPos().equals(to) || Math.abs(feet.y - to.getY()) > 0.055
                    || !to.down().equals(player.supportingBlockPos.orElse(null)) || !action.walkMotion.traversed()) {
                interrupt("Stopped outside the exact witnessed lower landing.", true);
            } else if (settled()) {
                if (action.scoutStoppedFrame < 0) action.scoutStoppedFrame = body.renderedFrame();
                else completeGroundScout("Stepped down to the exact witnessed dry landing and rendered a fresh view. No return, harvest or collection authorized.");
            }
            return; // Coast on the landing; do not try to center or reverse.
        }
        if (player.isOnGround()) body.driveDryLanding(landing);
    }

    private void completeGroundScout(String detail) {
        var rendered = body.horizonView();
        if (settled() && rendered != null && rendered.frame() > action.scoutStoppedFrame
                && rendered.displacement() <= 0.055 && body.horizonStance(rendered) != null) {
            // Even a short scout can change the eye position by less than the
            // normal camera-survey origin threshold.
            body.pauseWork();
            anchor = null;
            surveyReleaseFrame = rendered.frame();
            complete(detail);
        }
    }

    static boolean scoutReached(Vec3d from, Vec3d goal, Vec3d feet) {
        // Use progress along the fixed optical lane, not side drift or a look.
        double dx = goal.x - from.x, dz = goal.z - from.z;
        double advance = (dx * (feet.x - from.x) + dz * (feet.z - from.z)) / Math.hypot(dx, dz);
        return advance >= 0.40 && horizontalSquared(goal, feet) <= GROUND_SCOUT_ARRIVAL * GROUND_SCOUT_ARRIVAL;
    }

    private void recordApproachLeg(Floor floor) {
        if (action.drove && action.walkMotion.traversed())
            body.recordWalkedLeg(BlockPos.ofFloored(action.walkFrom), floor.pos.up());
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
                if (action.durable && work.ironWorkshop != null && offer.recipe.id.equals("furnace")) {
                    work.ironWorkshop.furnaceCrafted = true;
                    work.ironWorkshop.scanStarted = 0;
                    work.ironWorkshop.aiming = null;
                    work.sourceSearch.freshAfter = body.renderedFrame();
                    workshopMilestone("crafted", "Vanilla confirmed one furnace stored; placement is not yet issued.");
                }
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
        if (paidStation(offer.face) || !visible(offer.face) || !useAvailable()) {
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
                : pendingRecipeSafe(offer.recipe) && ingredients(offer.recipe) && hands.craft(offer.recipe.id))) {
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
                if (action.offer.face == work.harvestOpening) work.harvestOpening = null;
                if (work.surfaceOpening != null && action.offer.face == work.surfaceOpening.face) work.surfaceOpening = null;
                if (action.timberOpening != null) {
                    var pursuit = action.timberOpening.pursuit;
                    work.timberRecheck = pursuit;
                    work.admittedTimberOpening = null;
                    work.sourceSearch.freshAfter = body.renderedFrame();
                    work.rejected.remove(pursuit.source.hit.getBlockPos());
                    work.horizonAttempts.remove(pursuit.source.hit.getBlockPos());
                    work.sourceLook = null;
                    work.timberLook = null;
                }
            }
            if (action.prospectCover && action.diamondRoute) {
                work.sourceSearch.freshAfter = body.renderedFrame();
                diamondRoute.lookPoint = null;
                if (pos.equals(diamondRoute.foot.offset(diamondRoute.bearing).down()))
                    diamondRoute.levelFloors &= ~directionBit(diamondRoute.bearing);
                diamondRoute.coverOpened();
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
        if (!input.active || !ipc.inbox.active) {
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
                || action.offer.key.verb == Verb.FOLLOW || action.offer.key.verb == Verb.WORK_WALK)) {
            var keys = client.options;
            action.drove = keys.forwardKey.isPressed()
                || action.offer.drop != null && (keys.backKey.isPressed() || keys.leftKey.isPressed() || keys.rightKey.isPressed())
                || action.drove && (!action.durable || action.offer.key.verb == Verb.APPROACH);
        }
        if (action != null && action.offer.key.verb == Verb.BREAK && (action.durable || owner.equals("terra")))
            action.fired |= client.options.attackKey.isPressed();
        if (action != null && action.offer.scout != null && action.offer.scout.rise != null)
            action.fired |= client.options.jumpKey.isPressed() && client.options.forwardKey.isPressed();
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
        // The first constrained request is irrevocably paid even if the model can
        // only abstain. Don't publish an apparent handoff before a real render.
        if (lastObservation == 0 && "constrained".equals(ipc.workMode)
                && (!startupInputsClear || !available() || !stationaryWorldControls())) return;
        boolean releasedSurvey = false;
        if (surveyReleaseFrame >= 0) {
            boolean idle = idlePublicationPremise();
            releasedSurvey = idle && body.hasRecentView() && body.renderedFrame() > surveyReleaseFrame;
            // The camera receipt is not a new view. Keep waiting while the
            // same safe owner has only a stale image; publish lost safety/ownership normally.
            if (!releasedSurvey && (idle || "terra".equals(owner) && action == null
                    && visited && hazardClear && !urgent && grounded() && stationaryWorldControls())) return;
            surveyReleaseFrame = -1;
        }
        boolean forced = releasedSurvey || lastObservation == 0 || epoch != lastPublishedEpoch || hazardClear != lastHazard
            || personalCraft != null && work.completedTick == tick
            || timberReplan != null && timberReplanAt == tick
            || action != null && action.furnace != null && action.furnace.releaseTick == tick
            || !parkedViewPublished && pendingParked() && pendingEntry() != null && parkedViewReady();
        long observationAge = tick - lastObservation;
        boolean due = forced || observationAge >= OBSERVATION_INTERVAL;
        updateScope(due);
        boolean sameIdlePose = idlePublishedPos != null && epoch == lastPublishedEpoch && idlePublicationPremise()
            && idlePublishedPos.equals(player.getPos()) && player.getYaw() == idlePublishedYaw
            && player.getPitch() == idlePublishedPitch && player.getHealth() == idlePublishedHealth
            && player.getHungerManager().getFoodLevel() == idlePublishedFood;
        if (!sameIdlePose) idlePublishedPos = null;
        // Ordinary local work may continue on the very next tick. Only an observed
        // promotion barrier (or an isolated trial) advertises a held neutral window.
        quiescent = (trial || handoffCurrent(input.handoff)) && visited && owned && available();
        // Age two is a missed render, not negative world evidence. Skip the
        // write, not the witness checks; the latest snapshot keeps its old tick.
        if (due && !deferIdleObservation(observationAge, body.renderedViewAgeTicks(), !forced && sameIdlePose))
            publish(progress, crack, releasedSurvey);
    }

    static boolean deferIdleObservation(long observationAge, int renderAge, boolean sameIdlePose) {
        return sameIdlePose && renderAge == 2 && observationAge >= OBSERVATION_INTERVAL
            && observationAge < OBSERVATION_INTERVAL + 2;
    }

    private boolean idlePublicationPremise() {
        return owned && "terra_idle".equals(owner) && !rawWorking && neutralWorkView();
    }

    private boolean neutralWorkView() {
        return !trial && visited && !urgent && hazardClear && !hasActiveWorkOrder() && personalCraft == null && pendingEntry() == null
            && player != null && player == client.player && world != null && world == client.world && player.isAlive()
            && action == null && grounded() && stationaryWorldControls();
    }

    private boolean stationaryWorldControls() {
        return settled() && body != null && body.keysNeutral() && !hands.busy() && !hands.holdsWorkInventory() && cursorClear()
            && player.currentScreenHandler == player.playerScreenHandler && !player.isUsingItem()
            && !player.isSprinting() && !player.isSneaking() && !client.interactionManager.isBreakingBlock()
            && client.currentScreen == null && client.getOverlay() == null && client.isWindowFocused() && !client.isPaused()
            && client.getCameraEntity() == player && client.options.getPerspective().isFirstPerson();
    }

    static boolean startupCover(float pitch, BlockHitResult hit, Vec3d eye, BlockState state, int light) {
        return pitch <= STARTUP_CEILING_PITCH && hit.getSide() == Direction.DOWN && !hit.isInsideBlock()
            && hit.getPos().squaredDistanceTo(eye) <= 1.75 * 1.75 && light > 0
            && state.getFluidState().isEmpty() && AgentWorkOrder.prospectCoverDrop(state) != Items.AIR;
    }

    private BlockHitResult startupCeiling() {
        float pitch = player.getPitch(), yaw = player.getYaw();
        if (pitch > STARTUP_CEILING_PITCH || !body.renderedDirection(yaw, pitch, 2)) return null;
        // No overhead probe: the rendered and current vanilla outlines must
        // agree before checking the open side and state of this one face.
        var hit = body.selectedFace();
        return hit != null && body.renderedAim(hit.getPos(), 4)
            && startupCover(pitch, hit, player.getEyePos(), world.getBlockState(hit.getBlockPos()), body.observedFaceLight(hit))
            ? hit : null;
    }

    /** Death/transport shutdown leaves vanilla in charge of the old screen and cursor. */
    void suspend(long tick, String reason) {
        if (suspended) return;
        suspended = true;
        idlePublishedPos = null;
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
        invalidateUnprovedWithdrawal();
        closeOwnedWorkScreen(hands.holdsWorkInventory());
    }

    AgentWalkedRoute.Breadcrumbs pendingCloseBreadcrumbs() {
        var ticket = pendingEntry();
        if (ticket == null || !ticket.mayInvestigateCollection() || pendingUncertain
                || !ticket.ticket().equals(pendingRouteTicket) || client.player != player || client.world != world
                || !grounded() || !settled() || player.hurtTime != 0 || player.isOnFire() || body.macroLavaNear()
                || client.getCameraEntity() != player || !client.options.getPerspective().isFirstPerson()) return null;
        return walkedRoutes.breadcrumbs(player.getBlockPos().asLong());
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
        return worldViewBlocker() == null;
    }

    private String worldViewBlocker() {
        if (!visited) return "not_visited";
        if (!grounded()) return "not_grounded";
        if (!hazardClear) return "safety";
        if (!cursorClear()) return "cursor";
        if (client.currentScreen != null) return "screen";
        if (client.getOverlay() != null) return "overlay";
        if (!client.isWindowFocused()) return "focus";
        return body.hasRecentView() ? null : "render";
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
        return offer.drop != null && body.seesDrop(offer.drop, 3.25) && offer.drop.getStack().isOf(offer.item);
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

    private boolean surfaceOpeningStance(BlockPos foot) {
        return surfaceSearch.firstCover == null && !surfaceSearch.stairUsed && surfaceSearch.stairs.isEmpty()
            && grounded() && settled()
            && hazardClear && !urgent && prospectBodyUsable() && !client.options.attackKey.isUnbound()
            && dryProspectStance(foot);
    }

    private SurfaceOpening surfaceOpening(BlockPos foot, AgentProgress progress, PlayerInventory inventory) {
        // Reuse a rendered crosshair or terrain sample before checking only the
        // adjacent tops currently in the frustum. No new sector or camera motion.
        var seen = body.findSampled(state -> AgentWorkOrder.prospectCoverDrop(state) != Items.AIR, reach(),
            hit -> firstSurfaceCap(foot, hit, player.getBoundingBox(), surfaceSearch.footholds)).orElse(null);
        BlockPos preferred = seen == null ? null : seen.getBlockPos();
        if (preferred != null) {
            var opening = surfaceOpeningAt(foot, body.macroFloor(preferred), progress, inventory);
            if (opening != null) return opening;
        }
        for (Direction side : CARDINAL) {
            BlockPos cap = foot.down().offset(side);
            if (cap.equals(preferred) || surfaceSearch.footholds.contains(cap)) continue;
            var opening = surfaceOpeningAt(foot, body.macroFloor(cap), progress, inventory);
            if (opening != null) return opening;
        }
        return null;
    }

    private SurfaceOpening surfaceOpeningAt(BlockPos foot, BlockHitResult hit, AgentProgress progress, PlayerInventory inventory) {
        if (!firstSurfaceCap(foot, hit, player.getBoundingBox(), surfaceSearch.footholds)
                || body.macroMineWitness(hit, reach()) == null) return null;
        BlockPos cell = hit.getBlockPos();
        BlockState state = world.getBlockState(cell);
        Item drop = AgentWorkOrder.prospectCoverDrop(state);
        if (drop == Items.AIR || !dryWorkBreakSafe(cell, state, drop, progress)) return null;
        int slot = surfaceToolSlot(inventory, cell, state, drop, null, null, Long.MAX_VALUE);
        if (slot < 0) return null;
        String identity = materialTarget(new Key(Verb.BREAK, cell, 0, null));
        if (identity == null) return null;
        ItemStack tool = inventory.getStack(slot);
        var face = new Face(hit, state);
        return new SurfaceOpening(new AgentWorkOrder.SurfaceAnchor("block:" + blockName(face), identity),
            foot.toImmutable(), world.getBlockState(foot.down()), face, tool.isEmpty() ? Items.AIR : tool.getItem(),
            AgentMiningStock.maxLoss(tool, state, world, cell));
    }

    private int surfaceOpeningSlot(SurfaceOpening opening, AgentProgress progress, AgentWorkOrder.Budget budget, long ticksLeft) {
        BlockPos foot = player.getBlockPos();
        var inventory = player.getInventory();
        var face = opening.face;
        BlockPos cap = face.hit.getBlockPos();
        Item stock = budget.policy.target().item();
        int missing = Math.max(budget.policy.target().count(), budget.floor(stock)) - count(stock);
        if (!foot.equals(opening.foot) || !surfaceOpeningStance(foot) || world.getBlockState(foot.down()) != opening.support
                || budget.missingFloor(inventory) != null || missing <= 0 || budget.breaksLeft() <= missing
                || !budget.policy.surfaceAnchorAllowed(face.state)
                || !prospectCutGeometry(foot, face.hit, surfaceSearch) || !visibleFace(face)) return -1;
        Item drop = AgentWorkOrder.prospectCoverDrop(face.state);
        if (!dryWorkBreakSafe(cap, face.state, drop, progress)) return -1;
        return surfaceToolSlot(inventory, cap, face.state, drop, opening, budget, ticksLeft);
    }

    private int surfaceToolSlot(PlayerInventory inventory, BlockPos cap, BlockState state, Item drop, SurfaceOpening opening,
                                AgentWorkOrder.Budget budget, long ticksLeft) {
        int selected = inventory.selectedSlot;
        for (int offset = 0; offset < PlayerInventory.MAIN_SIZE; ++offset) {
            int slot = (selected + offset) % PlayerInventory.MAIN_SIZE;
            ItemStack hand = inventory.getStack(slot);
            if (ticksLeft <= Verb.BREAK.maxTicks + 2L * AgentSurfaceTread.ACTION_TICKS
                    + (slot == selected ? 0 : Verb.WORK_EQUIP.maxTicks) || !prospectEquip.test(slot)
                    || state.isToolRequired() && !hand.isSuitableFor(state)
                    || !AgentMiningStock.lootCompatible(hand, state)) continue;
            long wear = AgentMiningStock.maxWear(hand, state, world, cap);
            if (!AgentMiningStock.knownWear(wear)) continue;
            int loss = AgentMiningStock.lossForWear(hand, wear);
            if (opening != null && (!surfaceToolMatches(hand, opening.tool) || loss != opening.loss)
                    || budget != null && loss > 0 && budget.limit(hand.getItem(), count(hand.getItem())) < loss) continue;
            if (surfaceSourceUsable(inventory, cap, drop, slot, wear, loss, budget)) return slot;
        }
        return -1;
    }

    private static boolean surfaceToolMatches(ItemStack hand, Item tool) {
        return tool == Items.AIR ? hand.isEmpty() : hand.isOf(tool);
    }

    private boolean surfaceSourceUsable(PlayerInventory inventory, BlockPos cap, Item coverDrop, int coverSlot,
                                         long coverWear, int coverLoss, AgentWorkOrder.Budget budget) {
        // These are vanilla source types, not observations: only test tool
        // compatibility, expected drop room and cost. Do not query below the cap.
        Item capTool = coverSlot < 0 ? Items.AIR : inventory.getStack(coverSlot).getItem();
        for (BlockState source : AgentWorkOrder.EARLY_SOURCES) {
            Item stock = AgentWorkOrder.harvest(source);
            if (!AgentWorkOrder.earlySurfaceStock(stock) || stock == coverDrop
                    || budget != null && (stock != budget.policy.target().item() || !budget.policy.breakAllowed(source))
                    || !surfaceDropRoom(inventory, coverDrop, stock)) continue;
            for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot) {
                ItemStack tool = inventory.getStack(slot);
                if (slot == coverSlot && coverLoss > 0 || !tool.isSuitableFor(source)
                        || !AgentMiningStock.lootCompatible(tool, source) || !prospectEquip.test(slot)) continue;
                long wear = AgentMiningStock.maxWear(tool, source, world, cap);
                if (!AgentMiningStock.knownWear(wear)) continue;
                int loss = AgentMiningStock.lossForWear(tool, wear + (slot == coverSlot ? coverWear : 0))
                    + (tool.isOf(capTool) ? coverLoss : 0);
                if (budget == null || loss == 0 || budget.limit(tool.getItem(), count(tool.getItem())) >= loss) return true;
            }
        }
        return false;
    }

    private static boolean surfaceDropRoom(PlayerInventory inventory, Item cover, Item stock) {
        int unstacked = cover == Items.AIR ? 1 : 2;
        ItemStack coverStack = cover == Items.AIR ? ItemStack.EMPTY : new ItemStack(cover);
        ItemStack stockStack = new ItemStack(stock);
        boolean needsCover = cover != Items.AIR, needsStock = true;
        int empty = 0;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot) {
            ItemStack stack = inventory.getStack(slot);
            if (stack.isEmpty()) {
                ++empty;
            } else if (stack.getCount() < stack.getMaxCount()) {
                if (needsCover && ItemStack.areItemsAndComponentsEqual(stack, coverStack)) {
                    needsCover = false;
                    --unstacked;
                } else if (needsStock && ItemStack.areItemsAndComponentsEqual(stack, stockStack)) {
                    needsStock = false;
                    --unstacked;
                }
            }
            if (empty >= unstacked) return true;
        }
        return false;
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
        return resource(face.state) && pendingToolSafe(face) && canBreak(face.hit.getBlockPos(), face.state, progress);
    }

    private boolean canBreak(BlockPos pos, BlockState state, AgentProgress progress) {
        return pos.getY() >= client.player.getBlockY()
            && !pendingRouteSupport(pos) && progress.macroCanBreak(pos) && !client.options.attackKey.isUnbound()
            && (!state.isToolRequired() || client.player.getMainHandStack().isSuitableFor(state));
    }

    private boolean paidStation(Face face) {
        if (face == null || !face.state.isOf(Blocks.FURNACE)) return false;
        var ticket = pendingEntry();
        return ticket != null && ticket.pos().equals(face.hit.getBlockPos())
            && ticket.dimension().equals(world.getRegistryKey().getValue().toString());
    }

    private boolean pendingToolSafe(Face face) {
        ItemStack hand = player.getMainHandStack();
        int floor = pendingFloors().getOrDefault(hand.getItem(), 0);
        if (floor == 0) return true;
        int loss = AgentMiningStock.maxLoss(hand, face.state, world, face.hit.getBlockPos());
        return loss >= 0 && count(hand.getItem()) - loss >= floor;
    }

    private boolean pendingRecipeSafe(Recipe recipe) {
        var floors = pendingFloors();
        if (floors.isEmpty()) return true;
        var inventory = player.getInventory();
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot) {
            ItemStack stack = inventory.getStack(slot);
            if (stack.isEmpty()) continue;
            int floor = floors.getOrDefault(stack.getItem(), 0);
            if (floor == 0) continue;
            int cost = (recipe.material.test(stack) ? recipe.amount : 0) + (stack.isOf(Items.STICK) ? recipe.sticks : 0);
            if (cost > 0 && count(stack.getItem()) - cost < floor) return false;
        }
        return true;
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
        if (action == null && grounded() &&
                (anchor == null || horizontalSquared(anchor, pos) > 0.64 || Math.abs(pos.y - anchor.y) > 0.25)) {
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
        return offers(progress, null);
    }

    private List<Offer> offers(AgentProgress progress, TravelWitness travel) {
        var offers = new ArrayList<Offer>(MAX_OFFERS);
        addGroundScout(offers, travel);
        for (Offer reserved : reservation()) if (liveMaterialFace(reserved, progress)) offers.add(reserved);
        if (!trial) addDryRouteOffer(offers, progress);
        if (!trial && ipc.workMode != null) addWaterClue(offers);
        var player = client.player;
        float pitch = player.getPitch();
        if (!client.options.inventoryKey.isUnbound()) {
            craftOffer(offers, PLANKS, null);
            craftOffer(offers, STICKS, null);
            craftOffer(offers, TORCH, null);
        }
        addStationOffer(offers, Blocks.CRAFTING_TABLE);
        addStationOffer(offers, Blocks.FURNACE);
        if (!repeatedSourceView()) {
            survey(offers, Survey.FOOTING, "Survey the nearby ground", "A fixed downward camera angle from the current stance.");
            survey(offers, Survey.LEFT, "Survey left from this stance", "A bounded first-person turn over nearby terrain.");
            survey(offers, Survey.RIGHT, "Survey right from this stance", "A bounded first-person turn over nearby terrain.");
        }

        BlockPos standing = player.getBlockPos().down();
        for (Direction direction : CARDINAL) {
            BlockPos floor = standing.offset(direction);
            if (client.options.forwardKey.isUnbound()) continue;
            BlockHitResult top = body.macroFloor(floor);
            if (top == null) continue;
            var witness = new Floor(floor, client.world.getBlockState(floor), Vec3d.ofBottomCenter(floor.up()));
            if (!body.macroFlatLane(floor, witness.state, witness.landing)) continue;
            var key = new Key(Verb.APPROACH, floor, 0, null);
            if (!repeatedSourceFooting(floor) && body.macroNoVisiblePickup(witness.landing)) {
                if (!trial && !station(witness.state) && (prospectLandmark == null
                        || !prospectLandmark.from(player.getBlockPos(), tick) || prospectLandmark.approachSupport == null)) {
                    prospectLandmark = new ProspectLandmark(player.getBlockPos(), top, tick, witness.state);
                }
                offer(offers, key, "Walk to the adjacent flat tile", "Lit full top and clear dry sweep, " +
                    bearing(witness.landing, player.getPos(), player.getYaw()) + " from the current view.",
                    0, pitch, witness, null, null, null, null);
                if (!trial && "preset".equals(ipc.workMode)) addFarFoothold(offers, witness, direction, pitch);
            }
            addAdjacentDrop(offers, witness, pitch);
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
            craftOffer(offers, BENCH, null);
        }
        return offers;
    }

    private void addAdjacentDrop(List<Offer> offers, Floor floor, float pitch) {
        var seen = body.visibleEntity(entity -> entity instanceof ItemEntity item && dropNearLanding(item, floor)
            && !item.getStack().isEmpty() && roomFor(item.getStack()), 3.25).orElse(null);
        if (seen instanceof ItemEntity drop) {
            Item item = drop.getStack().getItem();
            offer(offers, new Key(Verb.COLLECT, floor.pos, drop.getId(), null), "Collect visible " + Registries.ITEM.getId(item),
                "A rendered drop is on this adjacent dry tile; the matching item fits in inventory.",
                0, pitch, floor, null, drop, item, null);
        }
    }

    private String addFoodClues(List<Offer> offers, AgentProgress progress) {
        if (trial || ipc.workMode == null || !neutralWorkView() || !progress.macroFoodRelevant()
                || !ironFooting(player.getBlockPos().down())) return null;
        var inventory = player.getInventory();
        int empty = -1, weapon = -1;
        for (int slot = 0; slot < PlayerInventory.HOTBAR_SIZE; ++slot) {
            if (!hands.canEquipSlot(inventory, slot)) continue;
            ItemStack stack = inventory.getStack(slot);
            boolean current = slot == inventory.selectedSlot;
            if (stack.isEmpty() && (empty < 0 || current)) empty = slot;
            if (AgentFoodWork.safeWeapon(stack) && (weapon < 0 || current)) weapon = slot;
        }
        Vec3d origin = player.getPos();
        String animalFact = null;
        if (!client.options.attackKey.isUnbound()) {
            Entity seen = body.visibleEntity(entity -> {
                var source = AgentFoodWork.adult(entity);
                return source != null && localFoodPoint(origin, entity.getPos()) && roomFor(source.stock);
            }, AgentFoodWork.LEASH + 0.5).orElse(null);
            if (seen != null && weapon >= 0) {
                var source = AgentFoodWork.adult(seen);
                addFoodClue(offers, new FoodClue(source, seen, origin, weapon, inventory.getStack(weapon).getItem()), null);
            } else if (seen != null) {
                animalFact = "An adult " + AgentFoodWork.adult(seen).subject.substring("entity:".length())
                    + " is visible now, but no suitable axe is ready in the hotbar. No hunt is authorized.";
            }
        }
        if (empty >= 0 && player.getOffHandStack().isEmpty() && useAvailable()) {
            BlockHitResult ripe = body.find(state -> AgentFoodWork.ripe(state) != null, reach() - 0.25,
                hit -> roomFor(AgentFoodWork.ripe(world.getBlockState(hit.getBlockPos())).stock)).orElse(null);
            if (ripe != null) {
                Face face = face(ripe);
                addFoodClue(offers, new FoodClue(AgentFoodWork.ripe(face.state), null, origin, empty, Items.AIR), face);
            }
        }
        return animalFact;
    }

    private void addFoodClue(List<Offer> offers, FoodClue clue, Face face) {
        if (offers.size() >= MAX_OFFERS) return;
        Key key = face == null ? new Key(Verb.FOOD_CLUE, null, clue.animal.getId(), clue.source.subject)
            : faceKey(Verb.FOOD_CLUE, face, clue.source.subject);
        if (materialTarget(new Key(Verb.FOOD_CLUE, key.pos, key.entity, key.activity)) == null) return;
        String summary = "Witnessed " + (clue.source.animal() ? "adult " : "ripe ") + clue.source.subject
            + " for " + Registries.ITEM.getId(clue.source.item);
        String evidence = clue.source.animal()
            ? "One rendered adult on the local level; a suitable hotbar tool is carried. No chase beyond the dry local leash."
            : "One currently visible ripe contact in use reach from dry footing; one bare-hand use only.";
        offers.add(new Offer(offerId(key), key, summary, evidence, 0, 0,
            null, face, null, clue.source.item, null, null, null, null, null, clue));
    }

    private static boolean caveCueOre(BlockState state) {
        return state.isIn(BlockTags.DIAMOND_ORES) || state.isIn(BlockTags.IRON_ORES) || state.isIn(BlockTags.COAL_ORES);
    }

    private String visibleCaveSource() {
        var seen = body.find(AgentMacroControl::caveCueOre, INSPECT_REACH).orElse(null);
        if (seen == null) return null;
        Face source = face(seen);
        Item stock = AgentWorkOrder.harvest(source.state);
        return blockName(source) + " is visible " + bearing(seen.getPos(), player.getPos(), player.getYaw())
            + " as a source of " + Registries.ITEM.getId(stock)
            + (body.macroMineWitness(seen, reach()) == null ? "; harvest contact is not confirmed from this stance."
                : "; in attack reach, but ordinary tool, route protection and policy checks still apply.");
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
            if (useAvailable() && visibleFace(face) && !paidStation(face)) {
                offer(offers, faceKey(Verb.INTERACT, face, null),
                    "Open visible " + blockName(face), "A lit workstation face is inside vanilla use reach.",
                    0, 0, null, face, null, null, null);
                if (block == Blocks.CRAFTING_TABLE) {
                    craftOffer(offers, BUCKET, face);
                    for (Recipe recipe : BENCH_RECIPES) craftOffer(offers, recipe, face);
                }
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

    private AgentDryCaveRoute.Offer currentDryRoute(AgentProgress progress) {
        AgentDryCaveRoute.Offer route = progress.dryRouteOffer();
        if (route == null || route.edges() < 1 || route.edges() > MAX_ROUTE_EDGES
                || !route.from().equals(player.getBlockPos()) || route.from().equals(route.endpoint())
                || route.from().equals(route.next()) || Math.abs(route.heightChange()) > 1
                || route.heightChange() != 0 && (route.edges() != 1 || !route.next().equals(route.endpoint()))
                || route.heightChange() == 0 && route.from().getY() != route.next().getY()) return null;
        return route;
    }

    private void addDryRouteOffer(List<Offer> offers, AgentProgress progress) {
        AgentDryCaveRoute.Offer route = currentDryRoute(progress);
        String evidence = progress.dryRouteOfferEvidence();
        if (!evidence.equals(dryOfferEvidence)) {
            dryOfferEvidence = evidence;
            remember("dry route: " + evidence);
        }
        if (route == null) {
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

    private Key surveyKey(Survey survey) {
        return new Key(Verb.SURVEY, null, surveyOrigin, survey.id);
    }

    private boolean surveyDifferentAngle(float yaw, float pitch) {
        return angle(client.player.getYaw(), client.player.getPitch(), yaw, pitch) >= 7;
    }

    private void survey(List<Offer> offers, Survey survey, String title, String evidence) {
        Key key = surveyKey(survey);
        float yaw = survey.yaw(surveyYaw);
        if (!retiredViews.contains(key) && surveyDifferentAngle(yaw, survey.pitch))
            offer(offers, key, title, evidence, yaw, survey.pitch, null, null, null, null, null);
    }

    private void addStartupOutlook(List<Offer> offers, boolean physicalClue) {
        if (!firstOutlookPending || work != null || !startupInputsClear
                || !prospectBodyUsable() || !body.renderedDirection(player.getYaw(), player.getPitch(), 2)) return;
        if (!physicalClue && offers.stream().noneMatch(offer -> offer.key.verb != Verb.SURVEY)) {
            var hit = startupCeiling();
            if (hit != null) {
                offers.clear();
                var key = new Key(Verb.SURVEY, hit.getBlockPos(), surveyOrigin, STARTUP_OUTLOOK,
                    hit.getSide(), world.getBlockState(hit.getBlockPos()));
                offer(offers, key, "Frame the outlook ahead", "The current first-person view points almost straight up at nearby lit cover. "
                    + "Look forward from the same stance; no movement or contact is authorized.",
                    player.getYaw(), STARTUP_OUTLOOK_PITCH, null, null, null, null, null);
                return;
            }
        }
        firstOutlookPending = false;
    }

    private void addSurfaceOutlook(List<Offer> offers) {
        if (repeatedSourceView()) return;
        var key = new Key(Verb.SURVEY, null, surveyOrigin, SURFACE_OUTLOOK);
        // One downward framing of the closest cardinal bearing to the current
        // view. The camera destination does not depend on unseen terrain.
        float yaw = Math.round(player.getYaw() / 90) * 90f;
        if (retiredViews.contains(key) || !surveyDifferentAngle(yaw, SURFACE_OUTLOOK_PITCH)) return;
        offer(offers, key, "Check the adjacent ground for a shallow opening",
            "Look down once from the current stance for a lit dry top beside the player. No cut, source, or descent is authorized.",
            yaw, SURFACE_OUTLOOK_PITCH, null, null, null, null, null);
    }

    private static JsonObject surfaceObservation(SurfaceOpening opening) {
        JsonObject clue = new JsonObject();
        clue.addProperty("block", blockName(opening.face));
        clue.addProperty("target", opening.anchor.target());
        clue.addProperty("tool", Registries.ITEM.getId(opening.tool).toString());
        clue.addProperty("maxToolLoss", opening.loss);
        return clue;
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

    /** Stable labels for already rendered faces and landings, not new offers or controls. */
    private JsonObject renderedAnchor(Offer offer) {
        String subject, target;
        switch (offer.key.verb) {
            case INSPECT -> {
                subject = "block:" + blockName(offer.face);
                target = materialTarget(new Key(Verb.BREAK, offer.key.pos, 0, null));
            }
            case STATION_REACQUIRE -> {
                subject = "block:" + blockName(offer.face);
                target = "station-" + offer.key.entity;
            }
            case APPROACH, FOLLOW, DRY_SURVEY -> {
                if (offer.scout != null) return anchorObservation(offer.scout.anchor);
                subject = "route:dry";
                BlockPos landing = switch (offer.key.verb) {
                    case APPROACH -> offer.floor.pos.up();
                    case FOLLOW -> offer.route.next();
                    default -> offer.drySurvey.target();
                };
                target = materialTarget(new Key(Verb.FOLLOW, landing, 0, null));
            }
            default -> { return null; }
        }
        if (target == null) return null;
        JsonObject anchor = new JsonObject();
        anchor.addProperty("subject", subject);
        anchor.addProperty("target", target);
        return anchor;
    }

    private static JsonObject anchorObservation(AgentWorkOrder.TravelAnchor anchor) {
        var value = new JsonObject();
        value.addProperty("subject", anchor.subject());
        value.addProperty("target", anchor.target());
        return value;
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
            case FOOD_CLUE -> {
                subject = offer.food.source.subject;
                target = materialTarget(new Key(Verb.FOOD_CLUE, offer.key.pos, offer.key.entity, subject));
                spends = new JsonObject();
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

    private String prospectOpeningRefusal(PlayerInventory inventory) {
        if (!prospectBodyUsable()) return "health_food_or_controls";
        if (work != null && work.budget.missingFloor(inventory) != null) return "inventory_floor_missing";
        if (!AgentProspectTools.roomForDiamond(inventory)) return "no_diamond_inventory_room";
        int harvest = AgentProspectTools.harvestSlot(inventory, null, world, player.getBlockPos(), null, prospectEquip);
        return switch (harvest) {
            case AgentProspectTools.HARVEST_UNPRICED -> "diamond_tool_last_use_unpriced";
            case AgentProspectTools.HARVEST_UNKNOWN_WEAR -> "diamond_tool_wear_unknown";
            case AgentProspectTools.HARVEST_UNEQUIPPABLE -> "diamond_tool_not_equippable";
            case AgentProspectTools.NO_HARVEST_TOOL -> "no_compatible_diamond_tool";
            default -> null;
        };
    }

    private JsonObject prospectOpening(AgentProgress progress, PlayerInventory inventory, String refusal) {
        if (refusal != null) {
            prospectWallSampled = false;
            prospectWallRefusal = refusal;
            return null;
        }
        var wall = sampledDiamondWall(player.getBlockPos(), progress, null);
        if (wall == null) return null;
        ItemStack tool = inventory.getStack(wall.toolSlot);
        BlockPos cell = wall.hit.getBlockPos();
        int loss = tool.isEmpty() ? AgentMiningStock.UNKNOWN : AgentMiningStock.maxLoss(tool, wall.state, world, cell);
        if (loss < 0) {
            prospectWallRefusal = "cover_tool_cost_unknown";
            return null;
        }
        String target = materialTarget(new Key(Verb.BREAK, cell, Block.getRawIdFromState(wall.state), "prospect-wall"));
        if (target == null) {
            prospectWallRefusal = "target_capacity";
            return null;
        }
        var clue = new JsonObject();
        clue.addProperty("block", Registries.BLOCK.getId(wall.state.getBlock()).toString());
        clue.addProperty("target", target);
        clue.addProperty("tool", Registries.ITEM.getId(tool.getItem()).toString());
        clue.addProperty("maxToolLoss", loss);
        return clue;
    }

    private TimberObstruction currentTimberObstruction(AgentProgress progress) {
        if (timberReplan == null || work == null || !work.phase.equals("blocked") || !neutralWorkView()) return null;
        var live = findTimberObstruction(timberReplan.pursuit, timberReplan, progress);
        return live != null && timberOpeningHand(live.leaf) >= 0 ? live : null;
    }

    private TimberObstruction currentTimberOpening(AgentWorkOrder next, Snapshot basis, AgentProgress progress) {
        var witnessed = basis.timberObstruction;
        var live = currentTimberObstruction(progress);
        var policy = next.policy();
        Item timber = witnessed.pursuit.timber;
        int missing = policy.target().count() - count(timber);
        return live != null && live.pursuit == witnessed.pursuit && live.target.equals(witnessed.target)
            && policy.target().item() == timber && policy.travelAnchorAllowed(next.travelAnchor().subject(), live.pursuit.kind)
            && policy.timberClearAllowed(live.leaf.state) && missing > 0 && policy.maxBreaks() > missing ? live : null;
    }

    private static JsonObject timberObstructionObservation(TimberObstruction opening) {
        var clue = new JsonObject();
        var toward = new JsonObject();
        toward.addProperty("subject", opening.pursuit.anchor.subject());
        toward.addProperty("target", opening.pursuit.anchor.target());
        clue.add("toward", toward);
        clue.addProperty("target", opening.target);
        clue.addProperty("block", blockName(opening.leaf));
        clue.addProperty("timber", Registries.ITEM.getId(opening.pursuit.timber).toString());
        return clue;
    }

    // Projection only. The ordinary work owner chooses the target and drives the body.
    private record TravelWitness(AgentWorkOrder.TravelAnchor anchor, AgentWorkOrder.TravelKind kind,
                                 AgentVisibleHorizon.Window window, AgentBody.OrdinaryGrade grade) {}

    static double scoutAdvance(AgentVisibleHorizon.Window window, double toward) {
        return scoutAdvance(window, toward, false);
    }

    private static double scoutAdvance(AgentVisibleHorizon.Window window, double toward, boolean footing) {
        if (!usableHorizonWindow(window, false) || window.knownDistance() < GROUND_SCOUT_WINDOW
                || window.knownDistance() <= window.brakingDistance()) return 0;
        double distance = Math.min(Math.min(window.knownDistance(), GROUND_SCOUT_LIMIT) - 0.16, toward - (footing ? 0 : 0.60));
        return distance >= 0.58 ? distance : 0;
    }

    private static Vec3d scoutDestination(AgentVisibleHorizon.Window window, Vec3d from) {
        return scoutDestination(window, from, false);
    }

    private static Vec3d scoutDestination(AgentVisibleHorizon.Window window, Vec3d from, boolean footing) {
        if (window == null) return null;
        double yaw = Math.toRadians(window.yaw()), dx = -Math.sin(yaw), dz = Math.cos(yaw);
        Vec3d cue = window.target().point();
        if (footing) cue = Vec3d.ofBottomCenter(window.target().hit().getBlockPos().up());
        double toward = (cue.x - from.x) * dx + (cue.z - from.z) * dz;
        double distance = scoutAdvance(window, toward, footing);
        return distance == 0 ? null : from.add(dx * distance, 0, dz * distance);
    }

    private boolean groundScoutReady() {
        return ipc.workMode != null && neutralWorkView() && !client.options.forwardKey.isUnbound()
            && (work == null || (!work.phase.equals("needs_replan") && !work.phase.equals("parked") && missingWorkFloor() == null));
    }

    private void addGroundScout(List<Offer> offers, TravelWitness travel) {
        if (!groundScoutReady()) return;
        if (addLandmarkScout(offers, travel)) return;
        int tops = body.sampleNearGround();
        if (addSeenLevelVantage(offers, tops)) {
            noteDryLandingEvidence("LEVEL_SUPPORT_OFFERED");
            return;
        }
        BlockPos source = player.getBlockPos();
        var landing = body.visibleDryLanding(floor -> !attemptedDryLandings.contains(dryLandingKey(source, floor)));
        if (landing == null) {
            var rise = addScoutRise(offers, travel, tops);
            if (rise == AgentBody.ScoutRiseEvidence.OFFERED) {
                noteDryLandingEvidence("ONE_BLOCK_CLIMB_OFFERED");
                return;
            }
            noteDryLandingEvidence(addSameTopVantage(offers, source, tops) ? "SAME_TOP_VANTAGE_OFFERED"
                : rise != null ? "ONE_BLOCK_CLIMB_" + rise.name() : body.dryLandingEvidence().name() + "_NO_SAFE_VANTAGE");
            return;
        }
        noteDryLandingEvidence(body.dryLandingEvidence().name());
        var floor = landing.top().getBlockPos();
        var key = new Key(Verb.APPROACH, floor, surveyOrigin, "ground_scout_landing");
        String identity = materialTarget(dryLandingKey(source, floor));
        if (identity == null) return;
        var anchor = new AgentWorkOrder.TravelAnchor("route:dry_landing", identity);
        var scout = new GroundScout(anchor, null, surveyOrigin, landing.from(), landing.yaw(), landing.center(), landing, null);
        offers.add(new Offer(offerId(key), key, "Step down to the visible dry landing",
            "One adjacent lit full top, " + landing.height() + " block" + (landing.height() == 1 ? "" : "s")
                + " lower, " + bearing(landing.center(), landing.from(), player.getYaw())
                + " from the current view. Walk off the checked lip, coast and stop for a new view. No return, jumping, pickup or spending.",
            0, 0, null, null, null, null, null, null, null, null, scout));
    }

    private static Key dryLandingKey(BlockPos source, BlockPos floor) {
        Direction direction = AgentDryLanding.bearing(source, floor.up());
        int drop = source.getY() - floor.getY();
        return new Key(Verb.APPROACH, floor, drop, "ground_scout_landing", direction, null);
    }

    private void noteDryLandingEvidence(String evidence) {
        var sight = body.groundSight();
        if (lastDryLandingStance == surveyOrigin && evidence.equals(lastDryLandingEvidence) && sight.equals(lastGroundSight)) return;
        lastDryLandingEvidence = evidence;
        lastGroundSight = sight;
        lastDryLandingStance = surveyOrigin;
        var value = header(run);
        value.addProperty("life", life);
        value.addProperty("tick", tick);
        value.addProperty("stance", surveyOrigin);
        value.addProperty("stage", evidence);
        value.addProperty("unique_lit_dry_tops", sight.dryTops());
        value.addProperty("clipped", sight.clipped());
        value.addProperty("occluded_or_side", sight.occluded());
        value.addProperty("dark", sight.dark());
        value.addProperty("miss", sight.missed());
        value.addProperty("unsafe_top", sight.unsafe());
        value.addProperty("lip_probe_clipped", sight.lipClipped());
        value.addProperty("lip_probe_occluded", sight.lipOccluded());
        var sectors = new JsonObject();
        sectors.add("left", groundHeightBands(sight.leftHeights()));
        sectors.add("center", groundHeightBands(sight.centerHeights()));
        sectors.add("right", groundHeightBands(sight.rightHeights()));
        value.add("visible_top_heights_relative_to_feet", sectors);
        ipc.landingSnapshot(value.toString());
    }

    private static JsonArray groundHeightBands(int mask) {
        var bands = new JsonArray(6);
        for (int height = -3; height <= 2; ++height) if ((mask & (1 << (height + 3))) != 0)
            bands.add(height == -3 ? "≤−3" : height == 2 ? "≥2" : Integer.toString(height));
        return bands;
    }

    private boolean addSeenLevelVantage(List<Offer> offers, int tops) {
        var horizon = body.visibleHorizon();
        Vec3d from = player.getPos();
        BlockPos support = player.getBlockPos().down();
        for (int i = 0; i < tops; ++i) {
            var top = body.nearGroundTop(i);
            BlockPos floor = top.getBlockPos(), to = floor.up();
            int dx = Math.abs(floor.getX() - support.getX()), dz = Math.abs(floor.getZ() - support.getZ());
            if (floor.getY() != support.getY() || dx + dz == 0 || Math.max(dx, dz) > 1 || scoutDepartures.contains(to))
                continue;
            String identity = materialTarget(new Key(Verb.APPROACH, floor, 0, DRY_VANTAGE));
            if (identity == null || scoutedLandmarks.contains(identity)) continue;
            var window = horizon.window(horizon.target(top), false);
            Vec3d goal = scoutDestination(window, from, true);
            if (goal == null || !BlockPos.ofFloored(goal).equals(to) || !groundScoutLane(from, goal)) continue;
            var anchor = new AgentWorkOrder.TravelAnchor(DRY_VANTAGE, identity);
            var scout = new GroundScout(anchor, face(top), surveyOrigin, from, window.yaw(), goal, null, null);
            var key = new Key(Verb.APPROACH, floor, surveyOrigin, DRY_VANTAGE);
            offers.add(new Offer(offerId(key), key, "Walk to a visible dry vantage",
                "The lit level top is " + bearing(goal, from, player.getYaw())
                    + ". One short walk along checked contiguous dry support, then stop and look. No new route or stock implied.",
                0, 0, null, null, null, null, null, null, null, null, scout));
            return true;
        }
        return false;
    }

    private AgentBody.ScoutRiseEvidence addScoutRise(List<Offer> offers, TravelWitness travel, int tops) {
        Vec3d from = player.getPos();
        BlockPos source = player.getBlockPos();
        AgentBody.ScoutRiseEvidence refusal = null;
        var hinted = travel == null ? null : travel.grade;
        for (int i = -1; i < tops; ++i) {
            AgentBody.ScoutRise proof;
            if (i < 0) {
                if (hinted == null || hinted.lookOnly() || !AgentBody.adjacentScoutRise(source, hinted.floor())) continue;
                proof = body.scoutRise(hinted.floor(), hinted.bearing());
            } else {
                var top = body.nearGroundTop(i);
                if (top.getBlockPos().getY() != source.getY()) continue;
                proof = body.scoutRise(top);
            }
            var grade = proof.grade();
            if (grade == null) {
                if (refusal == null || proof.evidence().ordinal() > refusal.ordinal()) refusal = proof.evidence();
                continue;
            }
            if (scoutDepartures.contains(grade.to())) continue;
            var anchorKey = new Key(Verb.APPROACH, grade.floor(), 0, "ground_vantage_rise");
            String identity = materialTarget(anchorKey);
            if (identity == null || scoutedLandmarks.contains(identity)) continue;
            var anchor = new AgentWorkOrder.TravelAnchor(DRY_VANTAGE, identity);
            Vec3d goal = Vec3d.ofBottomCenter(grade.to());
            var scout = new GroundScout(anchor, face(proof.top()), surveyOrigin, from, 0, goal, null, null, grade);
            var key = new Key(Verb.APPROACH, grade.floor(), surveyOrigin, "ground_vantage_rise");
            offers.add(new Offer(offerId(key), key, "Climb one block to a visible dry vantage",
                "One vanilla jump to the lit full adjacent top " + bearing(goal, from, player.getYaw())
                    + ". Dry takeoff, body-width headroom and landing checked. Stop for a new view; no return or stock implied.",
                0, 0, null, null, null, null, null, null, null, null, scout));
            return AgentBody.ScoutRiseEvidence.OFFERED;
        }
        return refusal;
    }

    private boolean addSameTopVantage(List<Offer> offers, BlockPos source, int tops) {
        BlockPos support = source.down();
        var state = body.dryCaveContact(source);
        if (state == null || !AgentBody.normalDryTraction(state)) return false;
        Vec3d from = player.getPos();
        int used = inspectedVantageSectors.getOrDefault(support, 0);
        double radius = player.getWidth() * 0.5;
        for (int i = 0; i < tops; ++i) {
            var cue = body.nearGroundTop(i);
            if (cue.getBlockPos().equals(support) || cue.getPos().y > from.y + 1.055) continue;
            int sector = AgentGroundVantage.sector(support, cue.getPos());
            if ((used & (1 << sector)) != 0) continue;
            Vec3d goal = AgentGroundVantage.goal(support, sector, radius);
            if (goal == null || !AgentGroundVantage.useful(from, goal, cue.getPos())) continue;
            var vantage = new AgentGroundVantage(support, state, from, goal, sector);
            if (!body.groundsVantage(vantage)) continue;
            String identity = materialTarget(new Key(Verb.APPROACH, support, sector + 1, DRY_VANTAGE));
            if (identity == null || scoutedLandmarks.contains(identity)) continue;
            var anchor = new AgentWorkOrder.TravelAnchor(DRY_VANTAGE, identity);
            var key = new Key(Verb.APPROACH, support, surveyOrigin, "ground_vantage:" + sector);
            var scout = new GroundScout(anchor, face(cue), surveyOrigin, from, 0, goal, null, vantage);
            offers.add(new Offer(offerId(key), key, "Shift for a better view from the same dry top",
                "Move the feet " + bearing(goal, from, player.getYaw())
                    + " toward witnessed terrain. Stay on the current support; no lower landing or onward path is authorized.",
                0, 0, null, null, null, null, null, null, null, null, scout));
            return true;
        }
        return false;
    }

    private boolean addLandmarkScout(List<Offer> offers, TravelWitness travel) {
        if (travel == null || travel.grade != null || scoutedLandmarks.contains(travel.anchor.target())) return false;
        Vec3d from = player.getPos();
        Vec3d goal = scoutDestination(travel.window, from);
        if (goal == null || !BlockPos.ofFloored(goal).equals(player.getBlockPos()) && scoutDepartures.contains(BlockPos.ofFloored(goal))
                || !groundScoutLane(from, goal)) return false;
        Face landmark = face(travel.window.target().hit());
        var scout = new GroundScout(travel.anchor, landmark, surveyOrigin, from, travel.window.yaw(), goal, null, null);
        var key = new Key(Verb.APPROACH, landmark.hit.getBlockPos(), surveyOrigin, "ground_scout:" + travel.anchor.target());
        String name = travel.kind == WOODLAND_FRONTIER ? "woodland edge" : blockName(landmark);
        offers.add(new Offer(offerId(key), key, "Scout toward the visible " + name,
            "One level dry advance of at most 1.6 blocks along the current braking window. Stop for a new first-person view; no harvest, pickup or spending.",
            0, 0, null, null, null, null, null, null, null, null, scout));
        return true;
    }

    private BlockHitResult groundScoutFace(Face face) {
        var live = body.horizonRecheck(face.hit);
        return live != null && world.getBlockState(live.getBlockPos()) == face.state ? live : null;
    }

    private boolean groundScoutLane(Vec3d from, Vec3d goal) {
        double dx = goal.x - from.x, dz = goal.z - from.z;
        double distance = Math.hypot(dx, dz);
        return body.horizonSweep(dx / distance, dz / distance, 0, distance, distance, AgentVisibleHorizon.Medium.DRY) == null
            && body.macroNoVisiblePickup(goal);
    }

    private boolean groundScoutStance(GroundScout scout) {
        return groundScoutReady() && scout.stance == surveyOrigin && scout.from.squaredDistanceTo(player.getPos()) <= 0.0001
            && !scoutedLandmarks.contains(scout.anchor.target());
    }

    private AgentVisibleHorizon.Window currentGroundScout(GroundScout scout) {
        Vec3d from = player.getPos();
        BlockPos to = BlockPos.ofFloored(scout.goal);
        if (!groundScoutStance(scout) || !to.equals(player.getBlockPos()) && scoutDepartures.contains(to)) return null;
        var horizon = body.visibleHorizon();
        var target = horizon.target(scout.face.hit);
        if (target == null || world.getBlockState(target.hit().getBlockPos()) != scout.face.state) return null;
        var window = horizon.dryWindow(target, scout.bearing);
        Vec3d liveGoal = scoutDestination(window, from, DRY_VANTAGE.equals(scout.anchor.subject()));
        return liveGoal != null && horizontalSquared(from, scout.goal) <= horizontalSquared(from, liveGoal) + 0.0001
            && groundScoutLane(from, scout.goal) ? window : null;
    }

    private AgentWorkOrder.TravelAnchor renderedTravelAnchor(AgentVisibleHorizon.Target target, AgentWorkOrder.TravelKind kind) {
        BlockPos pos = target.hit().getBlockPos();
        var state = world.getBlockState(pos);
        boolean woodland = kind == AgentWorkOrder.TravelKind.WOODLAND_FRONTIER;
        if (woodland && !state.isIn(BlockTags.LEAVES)) return null;
        String identity = materialTarget(travelAnchorKey(pos, kind));
        return identity == null ? null : new AgentWorkOrder.TravelAnchor(woodland ? AgentWorkOrder.WOODLAND_ANCHOR_SUBJECT
            : "block:" + Registries.BLOCK.getId(state.getBlock()), identity);
    }

    private TravelWitness travelWitness(AgentProgress progress) {
        if (progress == null || ipc.workMode == null || surveyOrigin <= 0) return null;
        var horizon = body.visibleHorizon();
        horizon.beginPreview();
        var nominated = ordinaryTravelTarget(progress);
        TravelWitness witness = null;
        if (nominated != null) {
            var window = nominated.window();
            var grade = nominated.grade();
            if (grade != null ? !grade.lookOnly() : usableHorizonWindow(window, true)) {
                var anchor = renderedTravelAnchor(nominated.target(), nominated.kind());
                if (anchor != null) witness = new TravelWitness(anchor, nominated.kind(), window, grade);
                else horizon.notePreview(AgentVisibleHorizon.Refusal.ANCHOR_UNAVAILABLE);
            }
        }
        if (witness == null) horizon.forgetIdleAim();
        else horizon.rememberIdleAim(nominated.target(), nominated.kind());
        horizon.reportPreview(witness != null && witness.grade != null, witness == null ? null : nominated.target());
        return witness;
    }

    private boolean currentTravelAnchor(AgentWorkOrder next, Snapshot basis, AgentProgress progress) {
        if (!next.travelAnchor().equals(basis.travelAnchor) || !neutralWorkView()) return false;
        var live = travelWitness(progress);
        return live != null && next.travelAnchor().equals(live.anchor)
            && next.policy().travelAnchorAllowed(live.anchor.subject(), live.kind);
    }

    private Face currentHarvestAnchor(AgentWorkOrder next, Snapshot basis, AgentProgress progress) {
        if (!neutralWorkView()) return null;
        var anchor = next.harvestAnchor();
        var policy = next.policy();
        var hand = player.getMainHandStack();
        for (var offer : basis.offers.values()) {
            if (offer.key.verb != Verb.BREAK || offer.face == null || !policy.breakAllowed(offer.face.state)
                    || !anchor.subject().equals("block:" + blockName(offer.face))
                    || !anchor.target().equals(materialTargets.get(travelAnchorKey(offer.key.pos, RESOURCE)))
                    || !liveMaterialFace(offer, progress)) continue;
            int loss = AgentMiningStock.maxLoss(hand, offer.face.state, world, offer.key.pos);
            if (loss >= 0 && (loss == 0 || loss <= policy.caps().getOrDefault(hand.getItem(), 0)
                    && count(hand.getItem()) - loss >= policy.floors().getOrDefault(hand.getItem(), 0))) return offer.face;
        }
        return null;
    }

    private JsonObject travelObservation(TravelWitness witness) {
        var value = new JsonObject();
        value.addProperty("kind", witness.kind.wireName);
        value.addProperty("subject", witness.anchor.subject());
        value.addProperty("target", witness.anchor.target());
        if (witness.grade != null) {
            value.addProperty("footing", "one_block_grade");
            value.addProperty("bearingDegrees", MathHelper.wrapDegrees(
                witness.grade.bearing().getPositiveHorizontalDegrees() - player.getYaw()));
            value.addProperty("heightChange", witness.grade.to().getY() - witness.grade.from().getY());
        } else {
            value.addProperty("footing", witness.window.medium() == AgentVisibleHorizon.Medium.DRY ? "dry" : "shallow_water_with_bank");
            value.addProperty("bearingDegrees", MathHelper.wrapDegrees(witness.window.yaw() - player.getYaw()));
            value.addProperty("windowBlocks", witness.window.knownDistance());
        }
        return value;
    }

    private void publish(AgentProgress progress) {
        publish(progress, 0, false);
    }

    private void publish(AgentProgress progress, float crack, boolean releasedSurvey) {
        lastObservation = tick;
        lastPublishedEpoch = epoch;
        JsonObject value = header(run);
        value.addProperty("life", life);
        value.addProperty("tick", tick);
        value.addProperty("epoch", epoch);
        if (surveyOrigin > 0) value.addProperty("stance", surveyOrigin);
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
        String caveSource = null;
        String animalFact = null;
        var ticket = pendingEntry();
        boolean idleView = idlePublicationPremise();
        String viewBlocker = progress == null ? null : worldViewBlocker();
        boolean trackProspect = progress != null && ipc.workMode != null && surveyOrigin > 0
            && action == null && !hasActiveWorkOrder();
        boolean checkProspect = trackProspect && idleView && viewBlocker == null;
        BlockPos surfaceFoot = player.getBlockPos();
        boolean checkSurface = checkProspect && "constrained".equals(ipc.workMode) && surfaceOpeningStance(surfaceFoot)
            && surfaceSourceUsable(inv, surfaceFoot, Items.AIR, -1, 0, 0, null);
        SurfaceOpening surface = checkSurface ? surfaceOpening(surfaceFoot, progress, inv) : null;
        if (surface != null) value.add("surfaceOpening", surfaceObservation(surface));
        String prospectStage = releasedSurvey ? "after_outlook" : "idle";
        String openingRefusal = checkProspect ? prospectOpeningRefusal(inv) : null;
        if (checkProspect && openingRefusal == null && !client.options.attackKey.isUnbound())
            body.reserveLevelWallRays();
        if (trackProspect && !checkProspect) {
            prospectWallSampled = false;
            prospectWallRefusal = viewBlocker == null ? "idle_premise_unavailable" : viewBlocker;
            noteProspectWall(prospectStage, "publication_blocked", false);
        }
        var travel = idleView ? travelWitness(progress) : null;
        if (travel != null) value.add("travelHint", travelObservation(travel));
        boolean yieldable = pendingCanYield();
        boolean parked = ticket != null && pendingParked();
        boolean parkedWorld = parked && progress != null && parkedViewReady();
        boolean safeReturn = parkedWorld && pendingCollectionPremise(ticket);
        TimberObstruction timberClue = null;
        boolean clueCurrent = ticket != null && ticket.mayInvestigateCollection() && !pendingUncertain
            && ticket.ticket().equals(pendingRouteTicket) && !urgent && observableWorld() && settled();
        BlockHitResult inReach = clueCurrent ? livePendingFace(ticket) : null;
        if (inReach != null) {
            rememberPendingContact(inReach);
            if (pendingRecheck != null && pendingRecheck.lit && !pendingFace.state.get(AbstractFurnaceBlock.LIT)) {
                pendingBurnEnded = true;
                pendingRecheckedUntil = 0;
            }
        }
        if (progress != null && viewBlocker == null) {
            if (action == null || yieldable) {
                visible = offers(progress, travel);
                if (idleView) animalFact = addFoodClues(visible, progress);
                if (parked || yieldable) caveSource = visibleCaveSource();
                if (checkProspect) {
                    JsonObject clue = prospectOpening(progress, inv, openingRefusal);
                    boolean approach = false;
                    for (Offer offer : visible) if (offer.key.verb == Verb.APPROACH) {
                        approach = true;
                        break;
                    }
                    noteProspectWall(prospectStage, clue != null ? "offered" : "denied", approach);
                    body.releaseLevelWallRays();
                    if (clue != null) value.add("prospectOpening", clue);
                    addStartupOutlook(visible, travel != null || clue != null || surface != null);
                    if (checkSurface && surface == null && !firstOutlookPending) addSurfaceOutlook(visible);
                }
                // Publish with the newly blocked work, not a heartbeat later:
                // the host can already see and act on the terminal receipt.
                if (ipc.workMode != null && surveyOrigin > 0 && !rawWorking) {
                    timberClue = currentTimberObstruction(progress);
                    if (timberClue != null) {
                        var pursuit = timberClue.pursuit;
                        if (travel != null && travel.anchor.equals(pursuit.anchor)
                                || visible.stream().anyMatch(offer -> offer.key.verb == Verb.BREAK && offer.face != null
                                    && AgentWorkOrder.harvest(offer.face.state) == pursuit.timber)) timberClue = null;
                    }
                }
            } else if (action.intent == null && action.keepVisible.length != 0) {
                var continuing = new ArrayList<Offer>(action.keepVisible.length);
                for (Offer anchor : action.keepVisible) if (liveMaterialFace(anchor, progress)) continuing.add(anchor);
                visible = continuing;
            }
        }
        if (timberClue != null) value.add("timberObstruction", timberObstructionObservation(timberClue));
        if (ticket != null && (pendingWorldRelease || pendingParked())) {
            long foot = player.getBlockPos().asLong();
            String returnClue = inReach != null ? "local_face"
                : clueCurrent && walkedRoutes.next(foot) != AgentRouteGraph.NO_CELL ? "walked_route" : null;
            boolean collectible = safeReturn && useAvailable() && (inReach != null || pendingReturnKnown(ticket));
            Offer pendingOffer = null;
            if (yieldable || collectible) {
                var list = new ArrayList<Offer>(Math.min(MAX_OFFERS, visible.size() + 1));
                Verb verb = yieldable ? Verb.DEFER_PENDING : Verb.COLLECT_PENDING;
                offer(list, new Key(verb, yieldable ? null : player.getBlockPos(), 0, ticket.ticket().toString()),
                    yieldable ? "Defer the paid furnace batch" : "Return to the paid furnace and recheck its result",
                    yieldable ? "The exact paid multi-unit batch released clean controls; leaving it does not grant any stock."
                        : pendingBurnEnded ? PENDING_RETURN_EVIDENCE
                            + " The exact furnace was since seen unlit after its last burning recheck; output is still unproved." : PENDING_RETURN_EVIDENCE,
                    0, 0, null, inReach == null ? null : face(inReach), null, null, null);
                pendingOffer = list.getFirst();
                for (Offer offer : visible) {
                    if (list.size() == MAX_OFFERS) break;
                    list.add(offer);
                }
                visible = list;
            }
            JsonObject pending = pendingObservation(ticket, yieldable, parked, safeReturn && !collectible, pendingOffer);
            if (returnClue != null) pending.addProperty("returnClue", returnClue);
            if (parkedWorld) {
                var worksite = new JsonObject();
                String route = progress.dryRouteOfferEvidence();
                worksite.addProperty("routes", recentSummary(route + (collectible
                    ? " The paid furnace has a separate fresh recall option."
                    : " No exact collection or connected return is offered from this stance.")));
                pending.add("worksite", worksite);
                parkedViewPublished = true;
            }
            value.add("pendingWork", pending);
        }
        // An unvisited idle publication can itself explain why a survey disappeared.
        boolean trackSurvey = progress != null && !trial && surveyEvidence.enabled()
            && action == null && !hasActiveWorkOrder() && !rawWorking && !hands.busy() && !hands.holdsWorkInventory()
            && (!visited || "terra_idle".equals(owner));
        int publishedSurveys = 0;
        for (Offer offer : visible) {
            JsonObject entry = new JsonObject();
            entry.addProperty("id", offer.id);
            entry.addProperty("verb", offer.key.verb.id);
            entry.addProperty("summary", offer.summary);
            entry.addProperty("evidence", offer.evidence);
            entry.addProperty("risk", offer.key.verb.risk);
            JsonObject material = material(offer, inv);
            if (material != null) entry.add("material", material);
            JsonObject anchor = renderedAnchor(offer);
            if (anchor != null) entry.add("anchor", anchor);
            if (trackSurvey) {
                if (offer.key.verb == Verb.SURVEY) publishedSurveys |= Survey.mask(offer.key.activity);
                else if (material != null || !"read".equals(offer.key.verb.risk)) trackSurvey = false;
            }
            opportunities.add(entry);
            // While the original owns the motor these are planning evidence, not direct commands.
            if (!yieldable || offer.key.verb == Verb.DEFER_PENDING || offer.key.verb == Verb.WATER_CLUE)
                witnessed.put(offer.id, offer);
        }
        if (trackSurvey) observeSurveyPublication(publishedSurveys);
        snapshots.put(tick, new Snapshot(epoch, witnessed.isEmpty() ? Map.of() : witnessed,
            ticket == null ? null : ticket.ticket().toString(), yieldable, hasActiveWorkOrder() ? work.order : null,
            travel == null ? null : travel.anchor, timberClue, surface));
        while (!snapshots.isEmpty() && snapshots.firstEntry().getKey() < tick - MAX_AGE) snapshots.pollFirstEntry();
        value.add("opportunities", opportunities);
        String watched = retainedFurnaceFact();
        int freshFacts = (watched == null ? 0 : 1) + (caveSource == null ? 0 : 1) + (animalFact == null ? 0 : 1);
        JsonArray history = new JsonArray(Math.min(8, recent.size() + freshFacts));
        int skip = Math.max(0, recent.size() + freshFacts - 8);
        for (String event : recent) if (skip-- <= 0) history.add(event);
        if (watched != null) history.add(watched);
        if (caveSource != null) history.add(caveSource);
        if (animalFact != null) history.add(animalFact);
        value.add("recent", history);
        value.addProperty("quiescent", quiescent);
        idlePublishedPos = null;
        if ((!visible.isEmpty() || travel != null || timberClue != null) && idleView && body.hasRecentView()) {
            idlePublishedPos = player.getPos();
            idlePublishedYaw = player.getYaw();
            idlePublishedPitch = player.getPitch();
            idlePublishedHealth = player.getHealth();
            idlePublishedFood = player.getHungerManager().getFoodLevel();
        }
        ipc.observation.set(value.toString());
    }

    private void observeSurveyPublication(int published) {
        JsonObject transition = surveyEvidence.observe(tick, life, surveyOrigin, published);
        if (transition == null) return;
        transition.addProperty("epoch", epoch);
        transition.addProperty("safety_revision", safetyRevision);
        int age = body.renderedViewAgeTicks();
        if (age >= 0) {
            transition.addProperty("render_frame", body.renderedFrame());
            transition.addProperty("render_age_ticks", age);
        }
        int lost = surveyEvidence.lost();
        if (lost == 0) return;

        String common = surveyEvidence.originChanged() ? "origin_changed" : worldViewBlocker();
        if ("render".equals(common)) {
            if (client.isPaused()) common = "paused";
            else if (client.getCameraEntity() != player || !client.options.getPerspective().isFirstPerson()) common = "camera";
            else if (age < 0) common = "no_render";
            else if (age > 1) common = "stale_render";
        }
        if (common == null && repeatedSourceView()) common = "repeated";
        JsonObject losses = new JsonObject();
        for (Survey survey : Survey.SLOTS) {
            if ((lost & survey.bit) == 0) continue;
            String reason = common != null ? common : retiredViews.contains(surveyKey(survey)) ? "retired"
                : !surveyDifferentAngle(survey.yaw(surveyYaw), survey.pitch) ? "camera_angle" : "offer_limit";
            losses.addProperty(survey.id, reason);
        }
        transition.add("lost", losses);
    }

    /** Private event journal only: publish on semantic changes, not on every camera sample. */
    private void noteProspectWall(String stage, String result, boolean approach) {
        // Alternating idle sample grids must not use up the outlook/paid trace.
        if (wallTransitions >= MAX_PROSPECT_WALL_TRANSITIONS
                || stage.equals("idle") && wallTransitions >= MAX_PROSPECT_WALL_TRANSITIONS - 4) return;
        var sight = body.levelWallSight();
        int visual = prospectWallSampled ? sight.visualRefusals() : 0;
        int rechecks = prospectWallSampled ? sight.rechecks() : 0;
        int general = body.generalRaysRemaining();
        boolean pressure = prospectWallSampled && (general == 0 || rechecks > general);
        boolean retained = prospectWallSampled && sight.usedRetainedWitness();
        String refusal = result.equals("offered") || result.equals("candidate") ? null : prospectWallRefusal;
        if (life == lastWallLife && surveyOrigin == lastWallStance && stage.equals(lastWallStage)
                && result.equals(lastWallResult) && Objects.equals(refusal, lastWallRefusal) && visual == lastWallVisual
                && approach == lastWallApproach && pressure == lastWallPressure && retained == lastWallRetained) return;
        lastWallLife = life;
        lastWallStance = surveyOrigin;
        lastWallStage = stage;
        lastWallResult = result;
        lastWallRefusal = refusal;
        lastWallVisual = visual;
        lastWallApproach = approach;
        lastWallPressure = pressure;
        lastWallRetained = retained;
        ++wallTransitions;
        wallTransitionTick = tick;
        var event = new JsonObject();
        event.addProperty("stage", stage);
        event.addProperty("result", result);
        event.addProperty("stance", surveyOrigin);
        event.addProperty("render_age_ticks", body.renderedViewAgeTicks());
        event.addProperty("approach_offered", approach);
        if (refusal != null) event.addProperty("refusal", refusal);
        if (prospectWallSampled) {
            event.addProperty("general_rays_remaining", general);
            event.addProperty("wall_rays_remaining", sight.raysLeft());
            event.addProperty("wall_rechecks", rechecks);
            event.addProperty("general_ray_pressure", pressure);
            event.addProperty("retained_witness_rechecked", retained);
            if (visual != 0) {
                var rejected = new JsonArray();
                for (var code : AgentBody.WallVisual.ALL) if ((visual & code.bit) != 0) rejected.add(code.name());
                event.add("visual_refusals", rejected);
            }
        }
        wallTransition = event;
    }

    private JsonObject pendingObservation(AgentPendingFurnaceMemory.Entry ticket, boolean yieldable, boolean parked,
                                          boolean unreachableHere, Offer offer) {
        var value = new JsonObject();
        value.addProperty("id", ticket.ticket().toString());
        value.addProperty("kind", "iron-smelting");
        value.addProperty("goal", goal);
        var invested = new JsonArray(2);
        invested.add(pendingStock(Items.RAW_IRON, ticket.batch().units()));
        invested.add(pendingStock(ticket.batch().fuel(), ticket.batch().fuelCount()));
        value.add("invested", invested);
        value.add("output", pendingStock(Items.IRON_INGOT, ticket.batch().units()));
        if (!ticket.floors().isEmpty()) {
            var floors = new JsonArray(ticket.floors().size());
            ticket.floors().forEach((item, count) -> floors.add(pendingStock(item, count)));
            value.add("protectedReserves", floors);
        }
        String location = "The witnessed furnace at the dry workshop";
        if (world.getRegistryKey().getValue().toString().equals(ticket.dimension())) {
            Vec3d station = Vec3d.ofCenter(ticket.pos());
            Vec3d relative = station.subtract(player.getPos());
            if (relative.horizontalLengthSquared() > 0.25) {
                float offset = MathHelper.wrapDegrees(heading(relative.x, relative.z) - player.getYaw());
                String direction = Math.abs(offset) > 145 ? "behind" : Math.abs(offset) < 25 ? "ahead" : offset < 0 ? "left" : "right";
                location += ", last seen " + direction + " of this facing";
            }
            if (ticket.footing().getY() != player.getBlockY())
                location += ticket.footing().getY() > player.getBlockY() ? " and above this level" : " and below this level";
        }
        if (unreachableHere) location += "; no connected safe local return is currently witnessed";
        value.addProperty("location", location);
        boolean blocked = unreachableHere || pendingUncertain || !ticket.mayInvestigateCollection();
        int remaining = pendingRecheck != null ? (int) Math.max(0, pendingRecheckedUntil - tick)
            : pendingEstimate == null ? 0 : pendingEstimate.remainingTicks(tick);
        value.addProperty("state", blocked ? "blocked" : remaining > 0 ? "estimated" : "unknown");
        if (!blocked && remaining > 0) value.addProperty("remainingTicks", remaining);
        value.addProperty("yieldable", yieldable);
        value.addProperty("parked", parked);
        if (ticket.historical() && parked) value.addProperty("historical", true);
        if (offer != null) value.addProperty(yieldable ? "deferOfferId" : "collectOfferId", offer.id);
        return value;
    }

    private static JsonObject pendingStock(Item item, int count) {
        var value = new JsonObject();
        value.addProperty("item", Registries.ITEM.getId(item).toString());
        value.addProperty("count", count);
        return value;
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
        if (work.active() && work.foodClue == null && !work.budget.policy.smeltIron() && !work.budget.policy.waterFill()) {
            if (desired != null && workNearTarget(desired, observed, required)) replan = "target_near";
            else if (work.timberRecheck == null && work.budget.nearLimit()) replan = "cap_near";
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
        if (work.active() && iron != null && iron.burnTick != 0 && (iron.phase == FurnacePhase.BURNING
                || iron.phase == FurnacePhase.WATCHING || iron.phase == FurnacePhase.REOPENING
                || iron.phase == FurnacePhase.COLLECTING)) {
            var burn = new JsonObject();
            burn.addProperty("burnTick", iron.burnTick);
            burn.addProperty("units", iron.batch.units());
            int remaining = switch (iron.phase) {
                case WATCHING, REOPENING -> iron.watch.remainingTicks(tick);
                case COLLECTING -> 0;
                default -> Math.max(0,
                    (iron.batch.units() - iron.output) * AgentHands.SMELT_TICKS - Math.round(iron.progress * AgentHands.SMELT_TICKS));
            };
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
        clearUnconsumedFurnaceUse();
        invalidateUnprovedWithdrawal();
        if (action.offer.key.verb == Verb.WORK_SMELT && action.furnace.phase != null) {
            if (!urgent && owner.equals("work_order")) body.pauseWork();
            detail += " The accepted batch is not reloaded; any uncollected contents stay in the furnace.";
        }
        if (closeOwned) closeOwnedWorkScreen(retained);
        finish("interrupted", detail);
    }

    private void invalidateUnprovedWithdrawal() {
        if (action.pendingCollection != null && action.pendingCollection.withdrawal.issued()
                || action.furnace != null && action.furnace.phase == FurnacePhase.COLLECTING)
            invalidatePending("Output withdrawal was interrupted before its exact proof; it cannot be repeated.");
    }

    private void closeOwnedWorkScreen(boolean retained) {
        if (action.craftJob != 0 && action.craftJob == hands.jobGeneration() && hands.busy()) hands.cancel();
        else if (!retained && action.opened != null && action.opened == client.currentScreen && cursorClear()) action.opened.close();
    }

    private void finish(String result, String detail) {
        if (action.horizonTravel != null) body.stopHorizonTravel(action.horizonTravel);
        if (action.offer.scout != null && !owner.equals("safety")) body.pauseWork();
        if (action.offer.drop != null && !owner.equals("safety")) body.pauseWork();
        if (action.offer.key.verb == Verb.WORK_FORAGE && !owner.equals("safety")) body.pauseWork();
        if (action.ordinaryGrade != null && !result.equals("completed") && !owner.equals("safety")) body.pauseWork();
        if (action.prospectSupport != null && action.prospectSupport.steered && owner.equals("work_order")) {
            body.pauseWork();
            if (hazardClear && !urgent && client.currentScreen == null && grounded()
                    && player.getBlockPos().equals(action.prospectSupport.from)) body.turn(action.yaw, action.pitch);
        }
        if (action.offer.key.verb == Verb.COLLECT_PENDING && !owner.equals("safety")) {
            body.pauseWork();
            if (pendingEntry() != null) requireFreshParkedView();
        }
        if (action.offer.key.verb == Verb.BREAK && (owner.equals("terra") || action.durable)
                && !owner.equals("safety")) body.pauseWork();
        if (action.offer.key.verb == Verb.SURVEY && !owner.equals("safety")) {
            body.pauseWork();
            if (!trial && ipc.workMode != null && result.equals("completed")) surveyReleaseFrame = body.renderedFrame();
        }
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
        if (walkedRoutes.recoveringWalk()) {
            BlockPos foot = player.getBlockPos();
            walkedRoutes.recovery().finish(action, result.equals("completed") && settled(), foot,
                diamondRecoverySupport(foot), player.getPos());
        }
        if (!result.equals("completed") && action.offer.face != null
                && (verb == Verb.STATION_REACQUIRE || verb == Verb.INTERACT || verb == Verb.CONTINUE || verb == Verb.WORK_SMELT)) {
            Face face = action.offer.face;
            forgetStationAt(personalStation(face.state.getBlock()), face.hit.getBlockPos());
        }
        if ((action.offer.key.verb == Verb.SURVEY || action.offer.key.verb == Verb.INSPECT)
                && retiredViews.size() < 256) retiredViews.add(action.offer.key);
        if (result.equals("completed") && action.offer.key.verb == Verb.APPROACH && action.offer.scout == null
                && (action.durable || repeatedSourceView())) {
            surfaceSearch.footholds.add(BlockPos.ofFloored(action.position).down());
            surfaceSearch.footholds.add((action.secondHop ? action.offer.farther : action.offer.floor).pos);
        }
        if (action.durable) {
            if (verb == Verb.WORK_WALK) retainTimberPursuit(action, result.equals("completed"));
            if (result.equals("completed") && verb == Verb.FOLLOW && work.timberRecheck != null
                    && !player.getBlockPos().equals(work.timberRecheck.stance)) work.timberRecheck = null;
            remember("work " + action.offer.key.verb.id + " " + result + ": " + detail);
            boolean workshopWalk = verb == Verb.APPROACH && IRON_WORKSHOP_STEP.equals(action.offer.key.activity);
            if (action.diamondRoute && diamondRoute.spareFloor && (verb == Verb.BREAK || verb == Verb.WORK_EQUIP)) {
                if (!result.equals("completed")) diamondRoute.refuseCurrent(detail);
                else if (verb == Verb.WORK_EQUIP) diamondRoute.lookPoint = null;
            }
            boolean deepTravel = action.diamondRoute && (action.offer.key.verb == Verb.WORK_TREAD || action.offer.key.verb == Verb.FOLLOW);
            if (deepTravel && !result.equals("completed")) {
                BlockPos from = diamondRoute.foot;
                boolean returning = action.tread != null && action.tread.returning;
                // A refused continuation does not erase any earlier grounded crossing. Only an
                // interruption away from its exact retained footing needs a new physical join.
                if (returning || action.tread != null && action.tread.inFlight()
                        || !player.getBlockPos().equals(from) || !settled()
                        || diamondRecoverySupport(from) != diamondRoute.support) {
                    walkedRoutes.recovery().clear();
                    diamondRoute.interruptedAt(from, returning ? action.tread.edge : null);
                }
            }
            if (!result.equals("completed") && !urgent) {
                enact("hold", detail);
                if (deepTravel) {
                    if (action.tread != null && action.tread.returning)
                        retireWork("blocked", "interrupted", detail + " Stopped rather than forcing the retained return.");
                    else if (diamondRoute.unjoined != null) retireWork("blocked", "interrupted", detail);
                    else {
                        if (verb == Verb.FOLLOW)
                            diamondRoute.select(diamondRoute.bearing, action.offer.route.heightChange(), false);
                        diamondRoute.refuseCurrent(detail);
                    }
                } else if (action.prospectSupport != null) {
                    diamondRoute.refuseCurrent(detail);
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
                if (action.offer.face != null && verb != Verb.STATION_REACQUIRE && !action.workshopFaceLost
                        && (!action.retryDiamondInset || pickup != null)) {
                    BlockPos refused = action.offer.face.hit.getBlockPos();
                    if (action.offer.key.verb == Verb.WORK_PLACE) refused = refused.up();
                    work.rejected.add(refused);
                } else if (action.offer.drop != null && action.dropPosition != null && !action.retryDropWhenVisible) {
                    work.deferredDrops.put(action.offer.drop.getId(), new PickupDeferral(player.getPos(),
                        action.dropPosition, action.dropGrounded, player.getYaw(), player.getPitch()));
                }
                if (workshopWalk || action.offer.key.verb == Verb.CONTINUE || action.offer.key.verb == Verb.WORK_SMELT
                        || action.offer.key.verb == Verb.WORK_FILL || action.offer.key.verb == Verb.WORK_FORAGE
                        || action.offer.key.verb == Verb.WORK_PLACE && action.offer.item == Items.FURNACE
                            && !action.workshopFaceLost)
                    retireWork("needs_replan", "interrupted", detail);
            } else if (result.equals("completed")) {
                if (action.scopedSourceLane) work.travelAnchorUsed = true;
                if (workshopWalk) work.ironWorkshop.arrived(action.offer.floor.pos.up());
                if (action.offer.key.verb == Verb.APPROACH || action.prospectCover)
                    work.sourceSearch.freshAfter = body.renderedFrame();
                if (action.offer.key.verb == Verb.BREAK && action.timberOpening == null || action.offer.key.verb == Verb.CONTINUE
                        || action.offer.key.verb == Verb.WORK_TREAD
                        || action.offer.key.verb == Verb.FOLLOW
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
        // A chosen look can answer a question. Its receipt is evidence of the
        // view, not a reason to reset the clock for physical gameplay.
        if (result.equals("completed") && !action.purposefulMotion && (!action.durable || continuityWork != null)
                && verb != Verb.SURVEY && verb != Verb.INSPECT && verb != Verb.DRY_SURVEY
                && verb != Verb.STATION_REACQUIRE && verb != Verb.DEFER_PENDING)
            purposeful(detail);
        action = null;
    }

    private String unexpectedPickup() {
        if (action == null || action.walkInventory == null || client.player != player || client.world != world) return null;
        if (action.unexpectedPickup != null) return action.unexpectedPickup;
        Item item = action.walkInventory.gain(player.getInventory(), action.offer.drop == null ? null : action.offer.item);
        if (item != null) action.unexpectedPickup = "Unexpected inventory gain during " + action.offer.key.verb.id
            + ": " + Registries.ITEM.getId(item) + ".";
        return action.unexpectedPickup;
    }

    private String timeoutDetail() {
        return switch (action.offer.key.verb) {
            case BREAK -> "The resource did not produce a matching vanilla break event before expiry.";
            case APPROACH -> action.offer.scout == null ? "The short walk did not settle on the witnessed tile before expiry."
                : "Ground reconnaissance expired before a settled, displaced stance could render a new view.";
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
            case WORK_FORAGE -> "The one authorized food source expired without a confirmed food pickup.";
            case COLLECT_PENDING -> "The bounded station return or fresh result proof did not settle; no output was credited.";
            case WATER_CLUE, FOOD_CLUE, DEFER_PENDING -> throw new IllegalStateException("A read-only clue cannot hold the controls.");
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
        recent.addLast(recentSummary(event));
    }

    // The observation allows 512 UTF-8 bytes; the receipt journal retains the full detail.
    static String recentSummary(String event) {
        if (event.length() <= 512 / 3) return event;
        int bytes = 0, prefix = 0;
        for (int i = 0; i < event.length();) {
            int cp = event.codePointAt(i);
            i += Character.charCount(cp);
            bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
            if (bytes <= 509) prefix = i;
            if (bytes > 512) return event.substring(0, prefix) + "...";
        }
        return event;
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
    static final class Ipc {
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
        private final AtomicReference<String> latestLanding = new AtomicReference<>();
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

        // This gauge describes the current view. It is not a write-once work receipt.
        void landingSnapshot(String value) { latestLanding.set(value); }

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
                String landing = latestLanding.getAndSet(null);
                if (landing != null) atomic("dry-landing-last.json", landing);
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
