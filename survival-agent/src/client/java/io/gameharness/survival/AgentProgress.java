package io.gameharness.survival;

import static io.gameharness.survival.AgentMineLight.MIN_PICK_USES;
import static io.gameharness.survival.AgentMineLight.PICK_HANDLES;

import io.gameharness.survival.AgentOrdinaryNavigator.Job;
import io.gameharness.survival.AgentOrdinaryNavigator.Result;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.function.Supplier;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityPose;
import net.minecraft.entity.EquipmentSlot;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.attribute.EntityAttributes;
import net.minecraft.entity.mob.CreeperEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.Identifier;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.GameMode;
import net.minecraft.world.World;

/** Inventory-driven decisions; coordinates are observations, traveled waypoints or dig intentions. */
final class AgentProgress {
    private static final double REACH = 4.25;
    private static final double SEARCH = 14;
    private static final float[] SIDE_LANES = {-18, 18, -34, 34, -51, 51};
    private static final float[] SCOUT_HEADINGS = {35, 65, 100, 145, 180, 235, 280, 320};
    private static final double[] FLOOR_FORWARD = {1.55, 2.2, 2.0};
    private static final double[] FLOOR_BELOW = {0.65, 1.55, 2.9};
    private static final float CRUISE_PITCH = 27;
    private static final float INSPECT_PITCH = 40;
    // Work above the deep lava seas, leaving more than a block of margin below the floor.
    private static final int DIAMOND_LEVEL = -52;
    private static final int IRON_LIGHT = 24;
    private static final int DEEP_LIGHT = 32;
    private static final int LOCAL_LIGHT = 12;
    private static final int DARK_STAIR_MAX_LIGHT = 3;
    private static final int DARK_STAIR_TICKS = 72;
    private static final int STAIR_LIGHT_RECEIPT_TICKS = 8;
    private static final int KIT_WOOD_PICK = 1, KIT_STONE_PICK = 1 << 1, KIT_DEEP_PICK = 1 << 2;
    private static final int KIT_LIGHT = 1 << 3, KIT_IRON = 1 << 4, KIT_STONE = 1 << 5, KIT_WOOD = 1 << 6;
    private static final int KIT_WORKBENCH = 1 << 7, KIT_FURNACE = 1 << 8, KIT_IRON_PICK_READY = 1 << 9;
    // Planning for ordinary burnable planks in Java 1.21.4; furnace loading checks the actual stack's fuel value.
    private static final int PLANK_BURN_TICKS = 300;
    private static final int ORE_MEMORY_LIMIT = 18;
    private static final int TIMBER_WORK_TICKS = 190;
    private static final int TIMBER_RECENT = 24;
    private static final AgentExpedition.Option WOODLAND = new AgentExpedition.Option("search_woodland",
        "Continue looking for natural timber rather than detouring to visible planks.");
    private static final AgentExpedition.Option SALVAGE = new AgentExpedition.Option("salvage_visible_planks",
        "Take a checked route to the visible planks for immediate wood supplies.");
    private static final Predicate<ItemStack> LOG = stack -> stack.isIn(ItemTags.LOGS);
    private static final Predicate<ItemStack> BURNABLE_LOG = stack -> stack.isIn(ItemTags.LOGS_THAT_BURN);
    private static final Predicate<ItemStack> PLANK = stack -> stack.isIn(ItemTags.PLANKS);
    private static final Predicate<ItemStack> STONE = stack -> stack.isIn(ItemTags.STONE_TOOL_MATERIALS);
    private static final Predicate<ItemStack> DECORATIVE_ROCK = stack -> stack.isOf(Items.ANDESITE)
        || stack.isOf(Items.DIORITE) || stack.isOf(Items.GRANITE) || stack.isOf(Items.TUFF)
        || stack.isOf(Items.CALCITE) || stack.isOf(Items.DRIPSTONE_BLOCK);
    private static final Predicate<ItemStack> FUEL = stack -> stack.isIn(ItemTags.COALS);
    private static final Predicate<ItemStack> STICK = item(Items.STICK);
    private static final Predicate<ItemStack> WOOD_PICK = item(Items.WOODEN_PICKAXE);
    private static final Predicate<ItemStack> STONE_PICK = item(Items.STONE_PICKAXE);
    private static final Predicate<ItemStack> GOLD_PICK = item(Items.GOLDEN_PICKAXE);
    private static final Predicate<ItemStack> IRON_PICK = item(Items.IRON_PICKAXE);
    private static final Predicate<ItemStack> DIAMOND_PICK = item(Items.DIAMOND_PICKAXE);
    private static final Predicate<ItemStack> WATER_BUCKET = item(Items.WATER_BUCKET);
    private static final Predicate<ItemStack> PORTAL_BUCKET = s -> s.isOf(Items.BUCKET) || WATER_BUCKET.test(s);
    private static final Predicate<ItemStack> COBBLE_FOOTHOLD = item(Items.COBBLESTONE);
    private static final Predicate<ItemStack> IGNITER = item(Items.FLINT_AND_STEEL);
    private static final Predicate<ItemStack> FLINT = item(Items.FLINT);
    private static final Predicate<ItemStack> GRAVEL = item(Items.GRAVEL);
    private static final Predicate<ItemStack> GRAVEL_DROPS = s -> GRAVEL.test(s) || FLINT.test(s);
    private static final Predicate<BlockState> GRAVEL_BLOCK = s -> s.isOf(Blocks.GRAVEL);
    private static final Predicate<BlockState> RETURNABLE_ORE = state -> state.isIn(BlockTags.DIAMOND_ORES)
        || state.isIn(BlockTags.IRON_ORES) || state.isIn(BlockTags.COAL_ORES);
    private static final Predicate<BlockState> TABLE_BLOCK = s -> s.isOf(Blocks.CRAFTING_TABLE);
    private static final Predicate<BlockState> SUPPLY_WOOD = s -> s.isIn(BlockTags.PLANKS);
    private static final Predicate<BlockState> FURNACE_BLOCK = s -> s.isOf(Blocks.FURNACE);
    private static final Predicate<ItemStack> BOAT = stack -> stack.isIn(ItemTags.BOATS) && !stack.isIn(ItemTags.CHEST_BOATS);
    private static final Predicate<ItemStack> EMPTY_BUCKET = item(Items.BUCKET);
    private static final Predicate<ItemStack> DEEP_PICK = stack -> stack.isOf(Items.IRON_PICKAXE)
        || stack.isOf(Items.DIAMOND_PICKAXE) || stack.isOf(Items.NETHERITE_PICKAXE);
    private static final Predicate<ItemStack> RETURNABLE_PICKS = stack -> DEEP_PICK.test(stack) || STONE_PICK.test(stack);
    private static final Predicate<ItemStack> SHOVEL = stack -> stack.isOf(Items.WOODEN_SHOVEL)
        || stack.isOf(Items.STONE_SHOVEL) || stack.isOf(Items.IRON_SHOVEL) || stack.isOf(Items.DIAMOND_SHOVEL)
        || stack.isOf(Items.NETHERITE_SHOVEL) || stack.isOf(Items.GOLDEN_SHOVEL);
    private static final Predicate<ItemStack> AXE = stack -> stack.isIn(ItemTags.AXES);
    private static final Predicate<ItemStack> RAW_IRON = item(Items.RAW_IRON);
    private static final Predicate<ItemStack> INGOT = item(Items.IRON_INGOT);
    private static final Predicate<ItemStack> DIAMOND = item(Items.DIAMOND);
    private static final Predicate<ItemStack> TORCH = item(Items.TORCH);
    private static final Predicate<ItemStack> SHIELD = item(Items.SHIELD);
    private static final Predicate<ItemStack> BUILDING = stack -> STONE.test(stack) || stack.isOf(Items.DIRT)
        || stack.isOf(Items.COBBLESTONE) || stack.isOf(Items.COBBLED_DEEPSLATE) || PLANK.test(stack);
    private static final Predicate<ItemStack> FOOD = AgentFoodWork::safeMeal;
    private static final Predicate<ItemStack> FLESH_MEAL = AgentFoodWork::fleshMeal;
    private static final Predicate<BlockState> RIPE_BERRIES = state -> AgentFoodWork.ripe(state) != null;
    private static final int FOOD_RESERVE = 12; // nutrition points, not stack size
    private static final double FOOD_SIGHT = 12;
    private static final double FOOD_LEASH_SQUARED = 16 * 16;
    private static final double WOUNDED_CHASE_SQUARED = 3 * 3;
    private static final int CRITICAL_HUNT_SWINGS = 6;

    private enum Resource {
        STONE(state -> state.isOf(Blocks.STONE) || state.isOf(Blocks.DEEPSLATE) || state.isOf(Blocks.COBBLESTONE)
            || state.isOf(Blocks.COBBLED_DEEPSLATE) || state.isOf(Blocks.BLACKSTONE), AgentProgress.STONE, "stone"),
        IRON(state -> state.isOf(Blocks.IRON_ORE) || state.isOf(Blocks.DEEPSLATE_IRON_ORE), RAW_IRON, "iron"),
        DIAMOND(state -> state.isOf(Blocks.DIAMOND_ORE) || state.isOf(Blocks.DEEPSLATE_DIAMOND_ORE),
            AgentProgress.DIAMOND, "diamond"),
        COAL(state -> state.isOf(Blocks.COAL_ORE) || state.isOf(Blocks.DEEPSLATE_COAL_ORE), FUEL, "coal");

        final Predicate<BlockState> block;
        final Predicate<ItemStack> drop;
        final String label;

        Resource(Predicate<BlockState> block, Predicate<ItemStack> drop, String label) {
            this.block = block;
            this.drop = drop;
            this.label = label;
        }
    }

    private enum Walk { LOOKING, MOVING, BLOCKED }
    private enum Footing { LEVEL, DOWN, STEEP, JUMP, WATER, EDGE, UNKNOWN, BLOCKED }
    enum Dig { LOOKING, CLEAR, BLOCKED, DARK, LIP, RESOURCE, FALLING_COVER, GRAVEL_LIMIT }
    private enum Firing { NONE, IRON, CHARCOAL }
    enum FurnaceSite { PAID, LOCAL, RETURN, ESTABLISH }
    private enum FurnaceSide { TORCHES, LIGHT, STICKS, PICK }
    private enum Forage { ANIMAL, BERRIES, DROP, GROUND, APPLE_LEAVES }
    private enum WorkshopView {
        CURRENT, GROUND, FIRST_WALL, FIRST_FLOOR, SECOND_WALL, SECOND_FLOOR, EXHAUSTED;

        private static final WorkshopView[] ORDER = values();
        private WorkshopView next() { return ORDER[ordinal() + 1]; }
    }
    private static final Predicate<ItemStack> STATION_OPENING_HAND = stack -> stack.isEmpty()
        || WOOD_PICK.test(stack) || STONE_PICK.test(stack) || DEEP_PICK.test(stack);

    private record OreSight(Resource resource, BlockPos block, Vec3d point, BlockPos stance, Vec3d feet,
                            double rangeSquared) {}

    private final class Station {
        final Block block;
        final Predicate<ItemStack> item;
        final String recipe;
        BlockPos position;
        int placed;
        int placementCount;
        int approachUntil;
        int opened;
        int openAttempts;
        int memoryProbe;
        BlockPos lastUse;
        final Set<BlockPos> rejected = new HashSet<>();
        final Predicate<BlockPos> availableSite = this::availableSite;
        BlockHitResult face;
        BlockPos stance, cut, provedPlacement;
        Direction lane;
        boolean packablePlacement, outlinePlacement, outlineTried;
        WorkshopView view;
        int siteSince, viewSince, faceSince;
        String siteRefusal;

        Station(Block block, Item item, String recipe) {
            this.block = block;
            this.item = AgentProgress.item(item);
            this.recipe = recipe;
        }

        private boolean availableSite(BlockPos dest) {
            return !rejected.contains(dest) && workshopPlacementSite(dest);
        }

        private void resetSite() {
            stance = cut = null;
            face = null;
            siteRefusal = null;
            rejected.clear();
            view = WorkshopView.CURRENT;
            siteSince = viewSince = faceSince = 0;
            outlineTried = false;
        }
    }

    private final MinecraftClient c;
    private final AgentBody body;
    private final AgentHands hands;
    private final AgentExpedition expedition;
    private AgentExpedition.Prospecting prospecting;
    private Resource prospectingOre;
    private int prospected;
    private final MineResite mineResite = new MineResite();
    private float prospectingYaw;
    private AgentExpedition.Offer woodOffer;
    private AgentExpedition.Option woodPreference;
    private int woodOfferedUntil, woodPreferenceUntil, woodCheckAfter, woodSearchTouched;
    private boolean woodOffered;
    private final AgentTools tools;
    private final AgentStallGuard stallGuard;
    private final AgentOrdinaryNavigator navigator;
    private final FirstStone firstStone;
    private Job ordinaryRouteJob;
    private Vec3d ordinaryRouteTarget;
    private AgentResourceStance ordinaryRouteBand;
    private double ordinaryRouteArrival;
    private int ordinaryRouteTick = -2;
    private AgentOrdinaryNavigator.Arrival ordinaryArrival;
    private final Runnable stallReplan = this::replanStalledLocalWork;
    private final Supplier<String> stallChoose = this::chooseStallAlternative;
    private final Supplier<AgentStallGuard.Alternative> stallStep = this::workStallAlternative;
    private final Runnable stallRelease = this::releaseStallAlternative;
    private final Set<BlockPos> stallOreTried = new HashSet<>();
    private final Set<BlockPos> stallRouteTried = new HashSet<>();
    private final Set<Integer> stallDropsTried = new HashSet<>();
    private Supplier<AgentStallGuard.Alternative> stallWork;
    private int stallWorkIncident, stallKit, stallIronTried;
    private boolean stallTorchTried;
    private final Predicate<BlockPos> protectedHeadroom = this::protectRecoveryBlock;
    private final Predicate<BlockHitResult> returnableOreFace = this::returnableOreReachable;
    private final Predicate<BlockHitResult> ordinaryOreFace = face -> reachableResourceFace(face.getBlockPos());
    private final Predicate<BlockHitResult> ordinaryStoneFace = face -> stoneStockFace(face.getBlockPos());
    private final AgentCaves caves;
    private final AgentReturnableMine returnableMine;
    private final SurfaceApproach surfaceApproach = new SurfaceApproach();
    private final AgentFall fall;
    private BlockHitResult fieldWater;
    private Vec3d fieldWaterPoint;
    private int fieldWaterUntil, fieldWaterUsed, waterRetry;
    private Resource caveGoal;
    private Resource returnableOre;
    private boolean lavaProspecting, caveLava;
    private BlockPos cavePeek;
    private final CaveRetreat caveRetreat = new CaveRetreat();
    private int caveLookUntil, caveOpenings, caveFootsteps;
    private final AgentDefense defense;
    private boolean rangedOwnsLocalWork;
    private final AgentPortal portal;
    private final FieldIgnition fieldIgnition;
    private final PortalSupplies portalSupplies;
    private final AgentMemory memory;
    private boolean memoryAttached;
    private BlockPos memoryFoot;
    private int memoryTrailSize;
    private boolean memoryRouting;
    private final SupplyExcursion supplyExcursion = new SupplyExcursion();
    private boolean portalStarted;
    private final String goal;
    private final Predicate<ItemStack> goalItem;
    private final Station table = new Station(Blocks.CRAFTING_TABLE, Items.CRAFTING_TABLE, "crafting_table");
    private final Station furnace = new Station(Blocks.FURNACE, Items.FURNACE, "furnace");
    private final Predicate<BlockHitResult> currentTableFace = hit -> hit.getBlockPos().equals(table.position);
    private final Predicate<BlockHitResult> unreservedFurnaceFace = hit -> !reservedFurnace(hit.getBlockPos());
    private final Predicate<BlockHitResult> currentFurnaceFace = hit -> hit.getBlockPos().equals(furnace.position);
    private final FieldBench fieldBench = new FieldBench();
    private final FieldWood fieldWood = new FieldWood();
    private DropReclaim dropReclaim;
    // Only points the player has reached. Retreat never consults terrain behind the camera.
    private final List<BlockPos> trail = new ArrayList<>();
    private final BitSet dugSteps = new BitSet();
    private final List<BlockPos> closedDig = new ArrayList<>();
    private final List<BlockPos> recoveryVisited = new ArrayList<>();
    private int tick;
    private boolean win;
    private String status = "starting";
    private String tableRecipe;
    private String tableExtra;
    private String tableAxe;
    private int tablePlanks;
    private int tableSticks;
    private EarlyAxe earlyAxe;
    private BlockPos earlyAxeFoot;
    private int earlyAxeStarted;
    private BlockPos tableReturn;
    private BlockPos failedTableReturn;
    private Firing firing = Firing.NONE;
    private int charcoalHandleReserve = PICK_HANDLES;
    private BlockPos furnaceWitness;
    private BlockPos refusedFurnace, refusedFurnaceFoot;
    private FurnaceScreen furnaceScreen;
    private ClientWorld furnaceScreenWorld;
    private int furnaceWarmUntil;
    private int furnaceDemand;
    private boolean furnaceLoaded;
    private boolean furnaceNeedsFuel;
    private boolean furnaceForFirstPick;
    private ItemStack furnaceBlockedFuel = ItemStack.EMPTY;
    private int furnaceIronPlanks, furnaceIronHandlePlanks, furnaceIronSticks;
    private Direction furnaceContactFacing;
    private BlockPos furnaceContactFooting;
    private final AgentPendingFurnaceMemory pendingFurnaceMemory;
    private LocalFurnace localFurnace;
    private boolean checkedSavedFurnace;

    private static final class LocalFurnace {
        final BlockPos pos, footing;
        final Direction facing;
        final ClientWorld world;
        final AgentLocalSmelt.Load loading;
        final int syncId;
        final AgentLocalSmelt.Watch watch = new AgentLocalSmelt.Watch();
        AgentLocalSmelt.Batch batch;
        AgentLocalSmelt.Withdrawal withdrawal;
        AgentWalkedRoute restoredRoute;
        java.util.UUID ticket;
        FurnaceSide side;
        ItemEntity sideDrop;
        Item sideDropItem;
        AgentSurfaceTread sideTread;
        AgentSurfaceTread.Edge sideReturn;
        BlockPos routeFrom, routeTo;
        int sideLookAt, sidePickupUntil, triedSide, retryAt, mismatchSince;
        boolean lost, sideDropFood, sideReturnStarted;

        LocalFurnace(BlockPos pos, BlockPos footing, Direction facing, ClientWorld world, int syncId,
                     AgentLocalSmelt.Load loading) {
            this.pos = pos;
            this.footing = footing;
            this.facing = facing;
            this.world = world;
            this.syncId = syncId;
            this.loading = loading;
        }
    }
    private Resource sought;
    private int soughtSince;
    private Resource miningResource;
    private BlockPos target;
    private Vec3d targetPoint;
    private int targetDeadline;
    private double targetNearest;
    private int lastMining;
    private final List<OreSight> oreSights = new ArrayList<>(ORE_MEMORY_LIMIT);
    private final List<OreSight> rejectedOreSights = new ArrayList<>(ORE_MEMORY_LIMIT);
    private ClientWorld oreWorld;
    private OreSight oreProbe;
    private int oreProbeSince;
    private boolean oreProbeReturning, oreProbeMining;
    private final BlockPos[] ignored = new BlockPos[6];
    private final int[] ignoredUntil = new int[ignored.length];
    private int ignoreCursor;
    private int seekAfter;
    private int pickupUntil;
    private boolean quarryingStoneStock;
    private BlockPos stoneCutFoot;
    private int stoneCutStock;
    private int pickupBlockedUntil;
    private Predicate<ItemStack> pickupBlockedItem;
    private ItemEntity pickupEntity;
    private Predicate<ItemStack> pickupItem;
    private AgentPickup.Pursuit pickupPursuit;
    private final ItemEntity[] deferredDrops = new ItemEntity[4];
    private final int[] deferredDropUntil = new int[deferredDrops.length];
    private int deferredDropCursor;
    private AgentSurfaceTread pickupTread;
    private AgentPickup.Access pickupAccessLook;
    private int pickupLookUntil, pickupTreadTick, pickupLandedTick = -1;
    private AgentResourceStance pickupLogGoal;
    private Predicate<ItemStack> pickupLightItem;
    private int pickupLightUntil;
    private int pickupLightStock;
    private BlockPos pickupLightFoot;
    private boolean timberReady;
    private boolean departureKit;
    private boolean ordinarySurfaceWork, bootstrapTimber, bootstrapStone;
    private int nextLoadoutCheck;
    private boolean ordinaryCaveDrops;
    private final NightWorksite nightSite = new NightWorksite();
    private BlockHitResult timberWitness;
    private final Predicate<BlockHitResult> reachableTrunk = hit -> timberCandidate(hit) && timberInReach(hit);
    private final Predicate<BlockHitResult> settledTrunk = hit -> reachableTrunk.test(hit) && closeTimberStance(hit);
    private final Predicate<BlockHitResult> treadTrunk = this::timberFromTread;
    private BlockHitResult timberCollectionFace;
    private AgentResourceStance timberCollectionGoal;
    private int timberResourceTick;
    private BlockPos timberLastCut;
    private final List<BlockPos> exhaustedStems = new ArrayList<>();
    private final List<BlockPos> unreachableTimber = new ArrayList<>();
    private final List<BlockPos> triedTimberFooting = new ArrayList<>();
    private final List<BlockPos> checkedSupplyLandmarks = new ArrayList<>();
    private BlockPos supplyLandmark;
    private final List<BlockPos> triedSupplyCuts = new ArrayList<>();
    private BlockPos timberExitFrom;
    private BlockPos timberExitTo;
    private boolean timberHigherShelf;
    private BlockPos timberShelfCheckedFrom;
    private BlockHitResult timberChop;
    private Vec3d timberChopPoint;
    private boolean timberCuttingLeaves, timberCuttingPlanks;
    private Predicate<ItemStack> timberDropItem = LOG;
    private int timberAttack;
    private int timberAttackWitnessTick;
    private int timberAlignUntil;
    private int timberChopUntil;
    private int timberWorkUntil;
    private int timberSeekTick;
    private int timberDropUntil;
    private int timberDropCount;
    private boolean timberNear;
    private int timberScan;
    private int timberLeafCuts;
    private final List<BlockPos> triedTimberLeaves = new ArrayList<>(4);
    private final SupplyEgress supplyEgress = new SupplyEgress();
    private Vec3d timberBank;
    private Vec3d timberCanopy;
    private double timberCanopyFootY;
    private int timberCanopyUntil;
    private boolean timberCanopyPeeking;
    private final List<BlockPos> exhaustedCanopies = new ArrayList<>();
    private int timberLookAt;
    private float timberLookYaw;
    private boolean timberSwimming;
    private int timberBankTurns;
    private float heading = Float.NaN;
    private int headingUntil;
    private int turns;
    private Vec3d sweepOrigin;
    private float sweepHeading;
    private int sweepIndex;
    private String localBlock;
    private Station localBlockStation, stallStation, workshopReturn;
    private BlockPos stallStationPosition;
    private BlockPos exitStart;
    private BlockPos exitFrom;
    private BlockPos exitTo;
    private Direction exitHeading;
    private int exitSide;
    private int exitDeadline;
    private int exitClear;
    private boolean exitLevel;
    private BlockPos climbTo;
    private int climbCheck;
    private int climbDrive;
    private int climbDeadline;
    private BlockPos gaitStep;
    private int gaitStepSince;
    private boolean gaitStepProof;
    private boolean gaitStepBlocked;
    private int pillarStage;
    private int pillarStarted;
    private int pillarCount;
    private Vec3d motionPosition;
    private int motionTick;
    private int stuck;
    private float routeRequest = Float.NaN;
    private float routeYaw;
    private int routeTick;
    private ClientWorld routeWorld;
    private Vec3d routeLegStart;
    private float rejectedRouteYaw;
    private int rejectedRouteUntil;
    private int directClearTicks;
    private int descentTick = -10;
    private BlockHitResult observedLanding;
    private Vec3d routeLanding;
    private int routeLandingTick;
    private Vec3d lookAhead;
    private int lookAheadTick;
    private float cruisePitch = CRUISE_PITCH;
    private boolean inspectingFooting;
    private int inspectUntil;
    private int poorFootTicks;
    private int clearFootTicks;
    private int sprintClearFrom;
    private int sprintClearTick = -10;
    private Vec3d approachGoal;
    private AgentBody.HorizonTravel ordinaryApproach;
    private int ordinaryApproachTick;
    private int approachDeadline;
    private double approachNearest;
    private int retreatUntil;
    private float retreatYaw;
    private float previousHealth = Float.NaN;
    private Direction digDirection;
    private Direction digPrimary;
    private BlockPos nextFoot;
    private boolean nextStepProved;
    private int clearIndex;
    private int digAge;
    private Vec3d digGoal;
    private int legLength;
    private int branchTurns;
    private int failedDirections;
    private int stairLength;
    private int refitPickCount = -1, refitPickUntil, refitPickRetry;
    private int deadEnds;
    private int returnTo;
    private BlockPos returnFrom;
    private boolean returnForSupplies;
    private boolean returnForFurnace;
    private final BiPredicate<BlockPos, BlockPos> walkedWaterReturn = this::walkedWaterReturn;
    private int returnIndex = -1;
    private int resumeIndex = -1;
    private boolean keepTrail;
    private int mealsEaten;
    private int foodPickedUp;
    private Item mealItem;
    private int mealSlot, mealCount, mealStartHunger;
    private int mealUntil, mealRetry, mealQuietUntil;
    private long emergencyMealJob;
    private float mealHealth = Float.NaN;
    private final AgentFoodWork.HealingGoal healing = new AgentFoodWork.HealingGoal();
    private ClientWorld foodWorld;
    private boolean healingOwnsWork;
    private int foodTravelTick = -2;
    private Vec3d foodTravelTarget;
    private double foodTravelArrival;
    private AgentResourceStance foodTravelBand;
    private Result foodTravelResult;
    private String lastMealReceipt, lastFoodPickup;
    private BlockPos lastFoodVantage;
    private Forage forage;
    private Entity forageEntity;
    private BlockPos forageBush;
    private Vec3d foragePoint, forageOrigin, animalSighting;
    private AgentFoodWork.Source forageSource;
    private ItemStack forageDropStock;
    private AgentResourceStance forageStance;
    private boolean forageDropGrounded;
    private int forageUntil, forageSeen, forageAction, forageStock, forageScan, forageSwings;
    private Entity refusedFoodEntity;
    private BlockPos refusedFoodBlock;
    private int refusedFoodEntityUntil, refusedFoodBlockUntil;
    private final AgentFoodWork.AppleStand appleStand = new AgentFoodWork.AppleStand();
    private final BlockPos.Mutable appleCatchProbe = new BlockPos.Mutable();
    private int returnAge;
    private int returnClear;
    private int returnLitIndex = -1;
    private int resumeStep = -1;
    private int nextDigStart;
    private int litIndex;
    private int torchAttempt;
    private int torchFace;
    private int torchBefore;
    private int torchUsed;
    private int torchPlacedTick;
    private BlockPos lightSurveyFoot;
    private int lightSurveyTurn;
    private float lightSurveyYaw;
    private BlockPos refusedCharcoalFoot;
    private boolean forcedLight;
    private BlockPos darkAttemptFoot;
    private BlockPos darkStairFoot;
    private int darkStairSince, darkStairUse;
    private BlockPos pendingStairLight;
    private int pendingStairLightSince, pendingStairTorchCount, observedStairLightUse;
    private BlockPos witnessedStairCut;
    private int witnessedStairCutTick;
    private boolean witnessedGravelCut;

    AgentProgress(MinecraftClient c, AgentBody body, AgentHands hands, String goal, AgentMemory memory,
                  AgentExpedition expedition, AgentPendingFurnaceMemory pendingFurnaceMemory) {
        this.c = c;
        this.body = body;
        this.hands = hands;
        this.expedition = expedition;
        this.memory = memory;
        this.pendingFurnaceMemory = pendingFurnaceMemory;
        tools = new AgentTools(c, hands);
        stallGuard = new AgentStallGuard(c, body, hands, tools, this::protectRecoveryBlock, this::safeSupport,
            this::recordStallFooting, this::tryStallMineHandback, expedition);
        navigator = new AgentOrdinaryNavigator(c, body);
        firstStone = new FirstStone();
        caves = new AgentCaves(c, body, hands, tools, this::recordCaveFooting, this::recordDryCaveFooting,
            this::detachMine, this::recordOneWayCaveLanding, this::knownCaveReturn,
            this::permitsOneWayCaveDrop, this::returnableFootholdProtected);
        returnableMine = new AgentReturnableMine(c, body);
        fall = new AgentFall(c, body, hands);
        defense = new AgentDefense(c, body, hands);
        this.goal = goal;
        portal = goal.equals("nether_portal") ? new AgentPortal(c, body, hands, tools) : null;
        fieldIgnition = portal != null ? new FieldIgnition() : null;
        portalSupplies = portal != null ? new PortalSupplies() : null;
        goalItem = switch (goal) {
            case "wooden_pickaxe" -> WOOD_PICK;
            case "stone_pickaxe" -> STONE_PICK;
            case "iron_pickaxe" -> IRON_PICK;
            case "diamond" -> item(Items.DIAMOND);
            case "nether_portal" -> null;
            default -> throw new IllegalArgumentException("Unsupported survival goal: " + goal);
        };
    }

    boolean restoreMemory() {
        if (memoryAttached) return true;
        boolean grounded = c.player.isOnGround();
        if (!memory.attach(c.world, grounded)) return false;
        memoryAttached = true;
        BlockPos standing = grounded ? c.player.getBlockPos() : null;
        List<BlockPos> known = memory.restore(c.world, standing, c.player.getEyePos());
        if (known.isEmpty()) return true;
        navigator.recallTrail(known, standing);
        trail.addAll(known);
        int index = trail.lastIndexOf(standing);
        litIndex = index + 1; // Periodic light counts new steps; darkness can still demand a light immediately.
        if (index + 1 < trail.size()) resumeIndex = index + 1;
        digDirection = c.player.getHorizontalFacing();
        useTraveledBearing(index);
        return true;
    }

    void observeMemoryFooting(long observedTick) {
        if (surfaceApproach.separateCanopyDrop()) return;
        if (mineResite.oneWayInFlight()) {
            mineResite.discardCrossedDropSuffix();
            return;
        }
        caves.observeDryContact(observedTick);
        if (caves.unverifiedDropInFlight()) return;
        boolean grounded = c.player.isOnGround() && !c.player.isTouchingWater();
        BlockPos standing = c.player.getBlockPos();
        boolean centered = Math.abs(c.player.getX() - standing.getX() - 0.5) <= 0.3
            && Math.abs(c.player.getZ() - standing.getZ() - 0.5) <= 0.3;
        memory.observeLanding(c.world, trail, standing, grounded && centered, observedTick);
        if (!grounded) return;
        supplyExcursion.observe(standing, observedTick);
        boolean routing = nextFoot != null || returnIndex >= 0 || resumeIndex >= 0 || exitStart != null
            || supplyEgress.active()
            || caves.active() || caves.routingDry() || mineResite.active();
        if (standing.equals(memoryFoot) && trail.size() == memoryTrailSize && routing == memoryRouting) return;
        memoryFoot = standing;
        memoryTrailSize = trail.size();
        memoryRouting = routing;
        var join = memory.rejoin(c.world, standing, trail, routing);
        if (join == null) return;
        if (join.resumeAt() >= 0) {
            trail.clear();
            dugSteps.clear();
            litIndex = join.resumeAt();
            if (mineResite.noResumeAt(standing)) {
                // Rejoining older breadcrumbs does not reopen the abandoned suffix.
                trail.addAll(join.prefix().subList(0, litIndex));
                resumeIndex = resumeStep = -1;
                return;
            }
            trail.addAll(join.prefix());
            resumeIndex = litIndex < trail.size() ? litIndex : -1;
            resumeStep = -1;
            useTraveledBearing(litIndex - 1);
            if (digDirection == null) digDirection = c.player.getHorizontalFacing();
            return;
        }
        int oldIndex = join.activeIndex();
        int prefix = join.prefix().size();
        if (oldIndex < 0) {
            trail.clear();
            dugSteps.clear();
            litIndex = prefix;
        } else {
            int shift = prefix - oldIndex - 1;
            for (int i = trail.size() - 1; i > oldIndex; i--) dugSteps.set(i + shift, dugSteps.get(i));
            dugSteps.clear(0, prefix);
            trail.subList(0, oldIndex + 1).clear();
            litIndex = Math.max(prefix, litIndex + shift);
            if (returnIndex >= 0) {
                returnIndex += shift;
                returnTo += shift;
                if (returnLitIndex >= 0) returnLitIndex += shift;
            }
            if (resumeIndex >= 0) {
                resumeIndex += shift;
                if (resumeStep >= 0) resumeStep += shift;
            }
        }
        trail.addAll(0, join.prefix());
        if (digDirection == null) digDirection = c.player.getHorizontalFacing();
    }

    private void useTraveledBearing(int index) {
        // A saved camera can be looking at a wall, torch face, or workbench. Recover the
        // heading of the actual last horizontal leg rather than mining along that camera angle.
        for (int i = index; i > 0; i--) {
            BlockPos last = trail.get(i), prior = trail.get(i - 1);
            int dx = last.getX() - prior.getX();
            int dz = last.getZ() - prior.getZ();
            if (dx != 0 || dz != 0) {
                digDirection = Math.abs(dx) > Math.abs(dz)
                    ? dx < 0 ? Direction.WEST : Direction.EAST : dz < 0 ? Direction.NORTH : Direction.SOUTH;
                return;
            }
        }
    }

    void saveMemory(boolean force) {
        memory.save(c.world, trail, force);
    }

    boolean won() {
        return win;
    }

    AgentStallGuard.Report stallReport() { return stallGuard.report(); }
    void observeOwnBreak(BlockPos position, BlockState state) {
        // A dark pocket may hide the falling item even though its ore face was visible.
        // The break buys one local light check, not inventory credit or a path into the pocket.
        if (position.equals(target) && (miningResource == Resource.IRON || miningResource == Resource.DIAMOND)
                && miningResource.block.test(state)) rememberPickupLight(miningResource.drop);
        if (quarryingStoneStock && position.equals(target) && Resource.STONE.block.test(state)) {
            stoneCutFoot = c.player.getBlockPos();
            stoneCutStock = hands.count(STONE);
            pickupUntil = tick + 19;
            quarryingStoneStock = false;
            target = null;
        }
        firstStone.broken(position, state);
        body.observeHeadroomBreak(position);
        caves.changedDry(position);
        stallGuard.broken(position, state);
        surfaceApproach.broken(position, state);
        boolean aperture = false;
        if (timberCuttingLeaves && timberChop != null && position.equals(timberChop.getBlockPos())
                && AgentSupplyEgress.naturalDryLeaf(state)) {
            aperture = surfaceApproach.bootstrapBroken(position);
            if (!aperture && surfaceApproach.canopy.active() == null) timberLeafCuts++;
        }
        returnableMine.observeBreak(position, state);
        supplyEgress.observeBreak(position, state);
        mineResite.changed(position);
        memory.forgetOwnedWorkbench(c.world, position);
        if (c.world == oreWorld) forgetOre(position);
    }

    int confirmedFrameBlocks() { return portal == null ? 0 : portal.confirmedFrameBlocks(); }
    int castFrameBlocks() { return portal == null ? 0 : portal.confirmedCastFrameBlocks(); }
    int castPassiveBlocks() { return portal == null ? 0 : portal.passiveFrameBlocks(); }
    int castLavaDeposits() { return portal == null ? 0 : portal.depositedLavaSources(); }
    AgentShoreCast.Report shoreCastReport() { return portal == null ? null : portal.shoreCastReport(); }
    long castSurveyEvidence() { return portal == null ? 0 : portal.castSurveyEvidence(); }
    String castPhase() { return portal == null ? "IDLE" : portal.castPhase(); }
    int witnessedLavaSources() { return portal == null ? 0 : portal.witnessedSources(); }
    boolean ignited() { return portal != null && portal.ignited(); }

    void portalWorkshop(String recipe, int sticks) { requestTable(recipe, null, 0, sticks); }
    void portalIron(int count) { acquireIron(count); }
    boolean portalCollect(Predicate<ItemStack> predicate, double range) { return collect(predicate, range); }
    boolean portalApproach(Vec3d point) { return approach(point, false, false) != Walk.BLOCKED; }
    void portalSearch() {
        if (activeTrail() > 1 && beginReturn()) retreatTunnel();
        else explore();
    }
    void portalProspectLava() {
        lavaProspecting = true;
        try { if (!prepareMining(DIAMOND_LEVEL)) excavate(DIAMOND_LEVEL, null); }
        finally { lavaProspecting = false; }
    }

    int caveOpenings() { return caveOpenings; }
    int caveFootsteps() { return caveFootsteps; }
    record ReturnableDrop(int sequence, BlockPos upper, BlockPos lower, int renderedTick) {}
    private ReturnableDrop returnableDrop;
    ReturnableDrop returnableDrop() { return returnableDrop; }
    AgentFall fall() { return fall; }
    AgentDryCaveRoute.Offer dryRouteOffer() { return caves.dryRouteOffer(); }
    AgentDryCaveRoute.LevelPassage dryLevelPassage(BlockPos from, BlockPos to) { return caves.dryLevelPassage(from, to); }
    AgentDryCaveRoute.Survey drySurveyOffer() { return caves.drySurveyOffer(); }
    boolean drySurveyCurrent(AgentDryCaveRoute.Survey offer) { return caves.drySurveyCurrent(offer); }
    AgentDryCaveRoute.SurveyResult surveyDryRoute(AgentDryCaveRoute.Survey offer) { return caves.surveyDryRoute(offer); }
    String drySurveyResult(AgentDryCaveRoute.Survey offer) { return caves.drySurveyResult(offer); }
    void cancelDrySurvey(AgentDryCaveRoute.Survey offer) { caves.cancelDrySurvey(offer); }
    String dryRouteOfferEvidence() { return caves.dryRouteOfferEvidence(); }
    AgentDryCaveRoute.DirectResult followDryRoute(AgentDryCaveRoute.Offer offer, Consumer<AgentSurfaceTread.Edge> landed) {
        return caves.followDryRoute(offer, tick, landed);
    }
    String dryRouteReason() { return caves.dryRouteReason(); }
    void cancelFollowDryRoute(AgentDryCaveRoute.Offer offer) { caves.cancelFollowDryRoute(offer); }
    boolean dryRouteInFlight(AgentDryCaveRoute.Offer offer) { return caves.dryRouteInFlight(offer); }

    /** A scoped tread landed after the native body proved its exact reverse clearance; no autonomous mining credit. */
    void recordMacroDryTread(BlockPos from, BlockPos to) {
        caves.walkedDry(from, to);
        caves.witnessedDry(to, from);
    }

    private void recordDryCaveFooting(BlockPos from, BlockPos to) {
        body.recordWalkedLeg(from, to);
        int prior = trail.lastIndexOf(from);
        if (prior < 0) {
            // Do not join a new real edge onto a historical neighbor. Keep that
            // other trail dormant until the player actually touches it again.
            memory.detach(c.world, trail, from);
            trimCaveTrail(0);
            appendGrounded(from, false);
        } else trimCaveTrail(prior + 1);
        recordCaveFooting(to);
        stallGuard.navigationArrival(from, to);
        if (to.getY() < from.getY()) mineResite.depth(to);
    }

    private void trimCaveTrail(int keep) {
        if (keep >= trail.size()) return;
        dugSteps.clear(keep, trail.size());
        trail.subList(keep, trail.size()).clear();
        litIndex = Math.min(litIndex, keep);
        if (resumeIndex >= keep) resumeIndex = resumeStep = -1;
        if (returnIndex >= keep) clearReturn();
    }

    private void recordCaveFooting(BlockPos reached) {
        if (c.player == null || !c.player.isOnGround() || !reached.equals(c.player.getBlockPos())) return;
        caveFootsteps++;
        int revisit = trail.lastIndexOf(reached);
        if (revisit >= 0) {
            trimCaveTrail(revisit + 1);
            return;
        }
        // Water crossings retain their real endpoints in-session. AgentMemory saves
        // only the connected grounded suffix, never imaginary steps through the air.
        appendGrounded(reached, false);
    }

    private void recordOneWayCaveLanding(AgentDryLanding landing) {
        // The old trail was detached at takeoff. The new dry footing is real
        // navigation progress, not a returnable stair or an ore receipt.
        recordCaveFooting(landing.to());
        stallGuard.navigationArrival(landing.source(), landing.to());
        mineResite.depth(landing.to());
        digDirection = landing.bearing();
        branchTurns = failedDirections = legLength = stairLength = deadEnds = litIndex = 0;
        nextFoot = cavePeek = null;
        closedDig.clear();
    }

    private boolean permitsOneWayCaveDrop(int height) {
        if (!ordinaryCaveDrops || returnIndex >= 0 || resumeIndex >= 0 || exitStart != null || oreProbeReturning
                || supplyEgress.active() || firing != Firing.NONE || pendingFurnaceMemory.current() != null)
            return false;
        return hasCaveEscapeKit(height);
    }

    private boolean hasCaveEscapeKit(int height) {
        if (!c.options.attackKey.isUnbound()
                && AgentDryLanding.escapeKit(height, pickUses(stack -> stack.isIn(ItemTags.PICKAXES)), 0)) return true;
        return !c.options.useKey.isUnbound() && !c.options.jumpKey.isUnbound()
            && AgentDryLanding.escapeKit(height, 0, hands.count(BUILDING));
    }

    private boolean knownCaveReturn(BlockPos from, BlockPos lower) {
        int end = activeTrail() - 1;
        if (end < 2 || !from.equals(trail.get(end)) || returnIndex >= 0) return false;
        // Require a local chain of independently walked treads, not an inverse
        // inferred from this drop, a route through water, or a nearby position.
        BlockPos upper = from;
        for (int i = end - 1; i >= Math.max(0, end - 8); --i) {
            BlockPos prior = trail.get(i);
            Direction back = AgentDryLanding.bearing(upper, prior);
            if (back == null || !body.walkedLaneDry(upper, prior, back)
                    || !AgentSurfaceTread.retainedLaneClear(c, upper, prior, back)) return false;
            if (prior.equals(lower)) return true;
            upper = prior;
        }
        return false;
    }

    private void selectCaveGoal() {
        caveLava = lavaProspecting;
        caveGoal = sought == Resource.DIAMOND || sought == Resource.IRON || sought == Resource.COAL ? sought
            : has(DEEP_PICK, 1) ? Resource.DIAMOND : Resource.IRON;
    }

    private boolean surveyDryForMine(BlockPos current, Direction direction) {
        selectCaveGoal();
        if (!caves.stepDryMine(tick, current, direction, caveLava ? null : caveGoal.block)) return followCaveResult();
        if (caves.active()) caveOpenings++; // A standalone dry survey just witnessed the normal cave aperture.
        nextFoot = null;
        cavePeek = null;
        status = caves.status();
        return true;
    }

    private boolean surveyCave(BlockPos planned) {
        return surveyCave(planned, digDirection);
    }

    private boolean surveyCave(BlockPos planned, Direction bearing) {
        boolean continuing = caves.active();
        if (!continuing) {
            if (planned == null || bearing == null) return false;
            if (caveRetreat.retired(planned)) return false;
            selectCaveGoal();
        }
        if (caves.step(tick, planned, bearing, caveLava ? null : caveGoal.block)) {
            if (!continuing) { caveOpenings++; nextFoot = null; cavePeek = null; }
            status = caves.status();
            return true;
        }
        return followCaveResult();
    }

    private boolean followCaveResult() {
        BlockHitResult exposed = caves.ore();
        if (exposed != null && caveGoal != null && caveGoal.block.test(state(exposed)) && tools.canHarvest(state(exposed))) {
            setTarget(exposed, caveGoal);
            mineTarget(caveGoal);
            return true;
        }
        if (caves.lava() != null && portal != null) {
            portal.rememberCaveLava(caves.lava());
            return true;
        }
        if (caves.boatFloor() != null && fall.offerBoat(caves.boatFloor(), caves.boatYaw())) {
            status = fall.status();
            return true;
        }
        return caves.deferredOpening() != null && caveRetreat.begin(caves.deferredOpening());
    }

    String status() {
        return status;
    }

    void resetExpedition() {
        stallGuard.resetSituational();
        prospecting = null;
        prospectingOre = null;
        prospected = 0;
        woodOffer = null;
        woodPreference = null;
        woodPreferenceUntil = woodCheckAfter = 0;
        woodOffered = false;
    }

    AgentExpedition.Offer expeditionOffer() {
        if (ordinarySurfaceWork && healing.active()) return null;
        var recovery = stallGuard.situationalOffer();
        if (recovery != null || stallGuard.situationalActive()) return recovery;
        var ore = prospecting == null ? null : prospecting.live();
        if (ore != null && (prospectingOre == Resource.IRON
                ? !has(DEEP_PICK, 1) && hands.count(INGOT) + hands.count(RAW_IRON) < 3
                : !has(DIAMOND, portal == null ? 1 : 3) && (portal == null || !portalStarted))) return ore;
        return tick < woodOfferedUntil && tick - woodSearchTouched <= 32 ? woodOffer : null;
    }

    String expeditionActivity(boolean fleeing) {
        if (fleeing || body.lavaEmergency() || defense.meleeActive() || defense.rangedActive())
            return "Responding to an immediate threat.";
        if (ordinarySurfaceWork && healing.active()) return status;
        String recovery = stallGuard.situationalActivity();
        if (recovery != null) return recovery;
        if (firing != Firing.NONE) return "Preparing or using a furnace.";
        if (hands.busy() || c.currentScreen != null) return "Using the inventory or a workstation.";
        if (mealUntil != 0 || forage != null) return "Eating or gathering food.";
        if (mineResite.active()) return "Leaving an exhausted mine area for different footing.";
        if (returnIndex >= 0 || supplyEgress.active()) return "Finding supplies along a checked route.";
        if (caves.active() || caves.routingDry()) return "Checking a witnessed cave route.";
        if (target != null) return "Working toward exposed ore or rock.";
        if (prospecting != null && sought == prospectingOre && prospecting.scouting(tick))
            return "Looking for exposed " + prospectingOre.label + " and usable cave openings.";
        if (nextFoot != null || returnableMine.active()) return "Working on a locally checked mine route.";
        if (timberWitness != null || timberChop != null || navigator.driving(Job.TIMBER)
                || (woodOffer != null && tick < woodOfferedUntil && tick - woodSearchTouched <= 32))
            return "Looking for or gathering wood and supplies.";
        return "Working toward the Survival goal.";
    }

    void afterRespawn() {
        navigator.reset();
        mineResite.reset();
        firstStone.afterRespawn();
        defense.resetOrdinaryRanged();
        nightSite.reset();
        surfaceApproach.abandonBootstrapPassage();
        surfaceApproach.canopy.reset();
        surfaceApproach.resetStoneCanopy();
        supplyLandmark = null;
        rangedOwnsLocalWork = false;
        resetOrdinaryHealing();
        dropReclaim = new DropReclaim();
        status = "looking for nearby drops after respawn";
    }

    void interruptSituationalRecovery() {
        cancelEarlyAxe();
        stallGuard.interruptSituational("a primed creeper took priority");
    }

    List<AgentSituationalRecovery.Receipt> takeSituationalReceipts() {
        return stallGuard.takeSituationalReceipts();
    }

    void tick(AgentEars ears, AgentMacroControl macro) {
        if (win || c.player == null || c.world == null) return;
        tick++;
        if (foodWorld != c.world) resetOrdinaryHealing();
        // Observe cargo before a recipe can spend it.
        if (stoneCutFoot != null && (!stoneCutFoot.equals(c.player.getBlockPos()) || has(STONE, stoneCutStock + 1)))
            stoneCutFoot = null;
        ordinarySurfaceWork = macro == null || !macro.engaged();
        boolean starterTools = ordinarySurfaceWork && !has(DEEP_PICK, 1) && !has(STONE_PICK, 1);
        boolean wooden = starterTools && has(WOOD_PICK, 1);
        bootstrapTimber = starterTools && !wooden;
        bootstrapStone = wooden && !has(STONE, 3) && !has(GOLD_PICK, 1);
        ordinaryCaveDrops = macro == null;
        hands.allowOrdinaryLoadout(ordinaryCaveDrops);
        observeStairLight();
        if (ordinarySurfaceWork) {
            restoreLocalFurnace();
            observeLocalFurnaceTransfers();
            observeLocalFurnacePickup();
            if (c.player.isAlive()) observeForagePickup();
        } else {
            healingOwnsWork = false;
            foodTravelTick = -2;
            if (forage != null) finishForage(12);
        }
        observeFurnaceCook();
        mineResite.observe();
        if (portal != null) stallGuard.surveyReceipt(portal.castSurveyEvidence());
        stallGuard.navigationSurveyReceipt(caves.drySurveyEvidence());
        stallGuard.observe(tick, confirmedFrameBlocks(), mealsEaten, status,
            returnableMine.hasProgressLease() || supplyEgress.active() || ordinaryRouteOwnsRecovery() || mineResite.leased()
                || firstStone.traveling()
                || surfaceApproach.canopy.active() != null || surfaceApproach.stoneCanopyWorking()
                || defense.ordinaryRangedActive()
                || ordinarySurfaceWork && healing.active()
                || ordinarySurfaceWork && localFurnace != null && !localFurnace.lost
                    && localFurnace.watch.active() && !localFurnace.watch.recheckDue(tick), bootstrapTimber);
        advance(ears, macro);
        stallGuard.endSituationalTurn();
        BlockPos newCaveLight = caves.takeLightReceipt();
        if (newCaveLight != null) stallGuard.stairLightReceipt(newCaveLight);
        returnableMine.interruptIfSkipped();
        if (returnableMine.active() || caves.routingDry() || mineResite.active()) stallGuard.navigationWork();
        String portalBlock = portal == null ? null : portal.takeLocalStop();
        if (portalBlock != null) localBlock = portalBlock;
        if (localBlock != null) {
            releaseStallAlternative();
            stallGuard.skillBlocked(localBlock);
            rememberStallWork();
            if (localBlockStation != null) {
                stallStation = localBlockStation;
                stallStationPosition = stallStation.position;
            }
            localBlock = null;
            localBlockStation = null;
            if (!ordinarySurfaceWork || !healing.active()) status = stallGuard.status();
        }
    }

    private void advance(AgentEars ears, AgentMacroControl macro) {
        if (!c.player.isAlive() || c.currentScreen instanceof DeathScreen) {
            status = "died before " + goal;
            return;
        }
        boolean macroEngaged = macro != null && macro.engaged();
        Predicate<ItemStack> safetySpend = macroEngaged ? macro.safetySpend() : null;
        if (!macroEngaged && confirmGoal()) return;
        trackMotion();
        float health = c.player.getHealth();
        boolean hurt = health < previousHealth;
        previousHealth = health;
        if (hurt) body.interruptHorizonWade(AgentVisibleHorizon.Refusal.WADE_HEALTH_CHANGED);
        boolean escaping = escapeDanger(ears, hurt, macro == null, macroEngaged, safetySpend);
        if (hurt || escaping) nightSite.interrupt();
        if ((hurt || escaping) && dropReclaim != null) dropReclaim.cancel();
        if (escaping) {
            body.interruptHorizonWade(c.player.isTouchingWater() && c.player.getAir() < 70 ? AgentVisibleHorizon.Refusal.DEEP_WATER
                : AgentVisibleHorizon.Refusal.HAZARD);
            if (macroEngaged) macro.urgent(status);
            caves.interruptLight();
            stallGuard.priorityAim();
            return;
        }
        boolean freeFallHands = (macroEngaged || defense.rangedActive() || defense.meleeActive())
            && !c.player.isOnGround() && !c.player.isTouchingWater()
            && !c.player.hasVehicle() && c.player.getVelocity().y < -0.27
            && (hands.busy() || c.currentScreen instanceof HandledScreen<?>);
        if (freeFallHands) {
            if (macroEngaged) macro.urgent("releasing the screen and hands during a fall");
            interruptHands();
        }
        int priorLandings = fall.waterSuccesses() + fall.boatSuccesses();
        if ((defense.meleeActive() || defense.ordinaryRangedActive()
                || !caves.controlsShortFall(tick) && !mineResite.controlsShortFall() && !surfaceApproach.controlsCanopyFall())
                && fall.step(safetySpend)) {
            nightSite.interrupt();
            body.interruptHorizonWade(AgentVisibleHorizon.Refusal.SOURCE_UNGROUNDED);
            if (dropReclaim != null) dropReclaim.cancel();
            caves.interruptLight();
            defense.stopZombieLook();
            body.prioritizeMovement();
            stallGuard.priorityAim();
            status = fall.status();
            if (macroEngaged) {
                macro.urgent(status);
                if (priorLandings < fall.waterSuccesses() + fall.boatSuccesses()) macro.safetyEffect(status);
            }
            return;
        }
        if (freeFallHands) {
            status = "releasing the screen and hands during a fall";
            return;
        }
        if (rangedOwnsLocalWork && !defense.ordinaryRangedActive()) {
            rangedOwnsLocalWork = false;
            stallGuard.resumeAfterRangedDanger(stallRelease);
        }
        if (defense.rangedActive() && !defense.meleeNeedsShore()) {
            nightSite.interrupt();
            // Macro cancellation can release body commands, so settle ownership before bracing.
            body.interruptHorizonWade(AgentVisibleHorizon.Refusal.HAZARD);
            if (macroEngaged) macro.urgent("responding to a nearby ranged threat");
            interruptHands();
            if (dropReclaim != null) dropReclaim.cancel();
            caves.interruptLight();
            if (defense.ordinaryRangedActive()) {
                if (!rangedOwnsLocalWork) {
                    rangedOwnsLocalWork = true;
                    body.pauseWork();
                    if (ordinaryApproach != null) body.stopHorizonTravel(ordinaryApproach);
                    ordinaryApproach = null;
                    surfaceApproach.abandon();
                    defense.stopZombieLook();
                }
                if (c.player.isTouchingWater() || stallGuard.controlsWaterRecovery()) {
                    var shore = stallGuard.takeEmergencyWaterTurn(stallReplan, stallRelease);
                    if (shore != AgentWaterEscape.Result.INTERRUPTED) {
                        body.prioritizeMovement();
                        stallGuard.priorityAim();
                        status = stallGuard.status();
                        return;
                    }
                }
            }
            defense.rangedStep(tick, protectedHeadroom, safetySpend);
            if (macroEngaged && defense.confirmedCover()) macro.safetyEffect(defense.status());
            if (macroEngaged && defense.confirmedRangedRetreat())
                macro.safetyEffect("confirmed voluntary dodge on a witnessed dry lane");
            stallGuard.priorityAim();
            status = defense.status();
            return;
        }
        if (defense.meleeActive()) {
            nightSite.interrupt();
            body.interruptHorizonWade(AgentVisibleHorizon.Refusal.HAZARD);
            interruptHands();
            if (macroEngaged) macro.urgent("responding to nearby melee danger");
            if (dropReclaim != null) dropReclaim.cancel();
            caves.interruptLight();
            AgentWaterEscape.Result shore = AgentWaterEscape.Result.INTERRUPTED;
            if (defense.meleeNeedsShore()) {
                shore = stallGuard.takeEmergencyWaterTurn(stallReplan, stallRelease);
                defense.meleeWaterStep(shore, stallGuard.status(), tick, safetySpend);
            }
            if (shore == AgentWaterEscape.Result.INTERRUPTED)
                defense.meleeStep(tick, AgentBody::dryCaveDanger, safetySpend);
            if (macroEngaged && defense.confirmedMeleeRetreat())
                macro.safetyEffect("confirmed voluntary retreat on a witnessed dry lane");
            stallGuard.priorityAim();
            status = defense.status();
            return;
        }
        // Higher danger/fall/defense owners have already declined. Merely
        // touching water does not cancel an actual, still-witnessed shallow
        // crossing. Losing that exact envelope transfers to water safety now.
        if (!macroEngaged && supplyEgress.retreatFlood()) {
            nightSite.interrupt();
            body.prioritizeMovement();
            return;
        }
        boolean plannedShallows = body.horizonControlsWater();
        var lostShallows = body.horizonWaterLoss();
        if ((plannedShallows || lostShallows != null || stallGuard.controlsWaterRecovery())
                && stallGuard.takeWaterTurn(plannedShallows || lostShallows == null && !macroEngaged && caves.controlsWater(tick),
                    lostShallows, stallReplan, stallRelease)) {
            nightSite.interrupt();
            body.prioritizeMovement();
            status = stallGuard.status();
            if (macroEngaged) macro.urgent(status);
            return;
        }
        if (macroEngaged) {
            if (!hands.busy() && c.currentScreen == null && defense.checkZombieCue(ears, tick,
                    nextFoot != null || c.options.attackKey.isPressed() && c.interactionManager.isBreakingBlock())) {
                body.interruptHorizonWade(AgentVisibleHorizon.Refusal.HAZARD);
                body.prioritizeMovement();
                stallGuard.priorityAim();
                status = defense.status();
                macro.urgent(status);
                return;
            }
            if (macroEmergencyMeal(macro)) return;
            if (!macro.hasAction() && macro.invocationFinishAllowed() && confirmGoal()) return;
            macro.control(this);
            if (!macro.hasAction() && macro.invocationFinishAllowed() && confirmGoal()) return;
            status = macro.status();
            return;
        }
        if (ordinaryCaveDrops) nightSite.observe();
        if (!hands.busy() && c.currentScreen == null && defense.checkZombieCue(ears, tick,
                nextFoot != null || returnableMine.active()
                || c.options.attackKey.isPressed() && c.interactionManager.isBreakingBlock())) {
            nightSite.interrupt();
            body.interruptHorizonWade(AgentVisibleHorizon.Refusal.HAZARD);
            body.prioritizeMovement();
            stallGuard.priorityAim();
            status = defense.status();
            return;
        }
        if (body.horizonWadeOwns(ordinaryApproach) && ordinaryApproachTick == tick - 1) {
            ordinaryApproachTick = tick;
            var transit = body.driveHorizon(ordinaryApproach, false, false);
            if (transit == AgentBody.HorizonResult.MOVING || transit == AgentBody.HorizonResult.SETTLING) {
                status = "wading toward the witnessed dry bank";
                return;
            }
            ordinaryApproach = null;
            lostShallows = body.horizonWaterLoss();
        }
        if (stallGuard.takeWaterTurn(lostShallows == null && (caves.controlsWater(tick) || plannedShallows),
                lostShallows, stallReplan, stallRelease)) {
            nightSite.interrupt();
            body.prioritizeMovement();
            status = stallGuard.status();
            return;
        }
        int hunger = c.player.getHungerManager().getFoodLevel();
        confirmMeal(hunger);
        if (healing.update(hunger, health, c.player.getMaxHealth())) {
            if (c.player.isTouchingWater()
                    && stallGuard.takeEmergencyWaterTurn(stallReplan, stallRelease) != AgentWaterEscape.Result.INTERRUPTED) {
                body.prioritizeMovement();
                stallGuard.priorityAim();
                status = stallGuard.status();
                return;
            }
            if (!healingOwnsWork) beginOrdinaryHealing();
            if (hands.busy()) {
                holdHealing("equipping food or a hunting tool");
            } else if (c.currentScreen != null) {
                holdHealing("waiting for the screen to close");
            } else {
                eatOrHunt(hunger, true);
            }
            caves.interruptLight();
            stallGuard.priorityAim();
            return;
        }
        if (healingOwnsWork) {
            healingOwnsWork = false;
            finishForage(12);
            holdHealing("recovered on safe footing");
            return;
        }
        if (hands.busy()) {
            returnableMine.waitForEquipment(hands.jobGeneration());
            return;
        }
        if (handleScreen()) return;
        if (dropReclaim != null) {
            dropReclaim.step();
            return;
        }
        if (eatOrHunt(hunger, false)) {
            caves.interruptLight();
            stallGuard.priorityAim();
            return;
        }
        if (nightSite.recoiling()) {
            body.pauseWork();
            status = "releasing night work while recovering from damage";
            return;
        }
        if (caves.drivingShallowDrop()) {
            if (returnableMine.surveyingCave()) workReturnableMine(c.player.getBlockPos(), returnableMine.depth());
            else surveyCave(null);
            return;
        }
        if (stepLocalFurnaceWatch()) return;
        if (stepFundedIronWorkshop()) return;
        if (surfaceApproach.workBootstrapPassage()) return;
        // Keep a declared ordinary leg through vanilla momentum. The inventory/craft stage
        // itself correctly refuses moving footing; it cannot own the continuation here.
        if (ordinaryRouteTick == tick - 1 && !mineResite.active()) {
            if (ordinarySurfaceWork && ordinaryRouteJob == Job.TIMBER && navigator.driving(Job.TIMBER)
                    && safePickupStance() && nextFoot == null && !oreProbeReturning) {
                if (timberResourceTick == tick - 1) timberResourceTick = tick;
                if (ordinaryRouteBand != null) navigate(Job.TIMBER, ordinaryRouteBand);
                else navigate(Job.TIMBER, ordinaryRouteTarget, ordinaryRouteArrival);
                return;
            }
            if (ordinarySurfaceWork && ordinaryRouteJob == Job.EXPLORE && navigator.driving(Job.EXPLORE)
                    && safePickupStance()) {
                navigate(Job.EXPLORE, null, 0);
                return;
            }
        }
        if (ordinarySurfaceWork && firstStone.continueTravel()) return;
        if (!mineResite.ascending() && supplyEgress.step()) return;
        // A planned retreat owns its advancing waypoints, not the local stall
        // incident it is trying to leave. Danger, hands and paid work ran first.
        if (ordinaryCaveDrops && mineResite.step()) return;
        if (workshopReturn == null && !returnableMine.settling() && !caves.shallowEntry() && !stallGuard.ownsRecovery()
                && body.repairHeadroom(tools, protectedHeadroom)) {
            status = body.headroomReport().reason();
            return;
        }
        if (caveRetreat.step()) return;
        if (surfaceApproach.seekStoneCanopy()) return;
        boolean mineRetryLease = returnableMine.hasRetryProgressLease() || firstStone.witnessedProbeWork();
        if (!returnableMine.surveyingCave() && stallGuard.caveSurveyStalled(mineRetryLease)) {
            AgentCaves.Opening opening = caves.drySurveyOpening();
            if (opening != null && caveRetreat.begin(opening)) {
                caves.leaveDrySurvey(tick);
                return;
            }
        }
        if (!ordinaryRouteOwnsRecovery() && !firstStone.witnessedProbeWork() && stallGuard.situationalTurn(stallReplan)) {
            body.prioritizeMovement();
            status = stallGuard.status();
            return;
        }
        if (!ordinaryRouteOwnsRecovery() && stallGuard.takeTurn(stallReplan, stallChoose, stallStep, stallRelease,
                mineRetryLease, returnableMine.witnessedLowCeiling())) {
            body.prioritizeMovement();
            status = stallGuard.status();
            return;
        }
        if (portal != null && portal.locallyStopped()) {
            status = portal.status();
            return;
        }
        if (surfaceApproach.to != null && surfaceApproach.step(c.player.getBlockPos())) return;
        if ((exitStart != null || returnIndex >= 0) && !has(TORCH, 1) && has(FUEL, 1)
            && craftTorches(12)) return;
        if (needsTimberKit() && (sought != null || activeTrail() > 0) && tick % 6 == 0) {
            findOre(Resource.DIAMOND, SEARCH);
            findOre(Resource.IRON, SEARCH);
            findOre(Resource.COAL, SEARCH);
        }
        if (exitStart != null) {
            recoverExit();
            return;
        }
        if (returnIndex >= 0) {
            retreatTunnel();
            if (portalSupplies != null && portalSupplies.returning)
                status += " for portal workshop supplies";
            return;
        }
        if (returnableMine.settling() || returnableMine.surveyingCave()) {
            workReturnableMine(c.player.getBlockPos(), returnableMine.depth());
            return;
        }
        if (continuingTimberTread()) {
            if (timberExitTo != null) repositionForTimber();
            else if (pickupTread != null) advancePickupTread();
            else seekTimber("timber", true);
            return;
        }
        if (prioritizeOrePickup()) return;
        if (refitMinedPick()) return;
        if (caves.active() && surveyCave(null)) return;
        if (caves.routingDry() && surveyDryForMine(c.player.getBlockPos(),
                digDirection == null ? c.player.getHorizontalFacing() : digDirection)) return;
        if (fieldBench.packUntil != 0 && fieldBench.pack()) return;
        if (prepareDefense()) return;
        if (oreProbeReturning && probeReturnedOre()) return;

        if (fieldIgnition != null && fieldIgnition.active() && fieldIgnition.step()) return;
        if (portal != null && portal.castEligible()) {
            portalSupplies.leaveStoneShore();
            portal.stepCast(this);
            status = portal.status();
            return;
        }
        if (fieldIgnition != null && !portalStarted && !has(DIAMOND, 3) && !has(DIAMOND_PICK, 1)
            && (fieldIgnition.start() || portalSupplies.stepAtStoneShore())) return;
        if (needsTimberKit() && has(DEEP_PICK, 1)
            && (portal == null ? prepareFieldBucket() : has(PORTAL_BUCKET, 1) && fillFieldBucket())) return;
        if (portal != null && (portalStarted || has(DIAMOND, 3) || has(DIAMOND_PICK, 1))) {
            portalStarted = true;
            status = "preparing the Nether portal";
            portal.step(this);
            if (status.equals("preparing the Nether portal")) status = portal.status();
            return;
        }

        boolean ironPick = has(DEEP_PICK, 1);
        boolean stonePick = has(STONE_PICK, 1);
        boolean woodPick = has(WOOD_PICK, 1);
        if (ordinaryCaveDrops && (stonePick || woodPick) && !ironPick && nightSite.step()) return;
        if (needsTimberKit()) fieldWood.observeSurfaceWood();
        if (!timberReady) {
            if ((stonePick || ironPick) && surfaceDeparture() && has(TORCH, 4) && has(STONE, 32)
                    && surfaceApproach.checkEquippedMine()) return;
            boolean longGoal = needsTimberKit();
            int torchRecipes = torchBatches(launchLight(), hands.count(TORCH));
            int fuelLogs = Math.max(0, torchRecipes - hands.count(FUEL));
            // Equip the next leg, not the whole expedition before leaving the first tree.
            // Hold back bench and replacement-pick wood as well as the actual fuel logs.
            int fieldReserve = ironPick ? 24 : 12;
            int kitPlanks = fieldReserve + localTableWood() + 2 * stickBatches(torchRecipes + 2 * PICK_HANDLES)
                + furnacePlanks(fuelLogs) + 4 * fuelLogs;
            boolean shortTimber = hands.count(PLANK) + 4 * hands.count(LOG) < kitPlanks
                || hands.count(BURNABLE_LOG) < fuelLogs;
            // A continuation without a local trail is not necessarily outdoors.
            // Only top up a launch kit at an actual open stance. Underground,
            // the mining and workshop orders request their own missing inputs.
            if (longGoal && surfaceDeparture() && !nightSite.guarding() && (stonePick || woodPick || ironPick)
                && (woodPickupPending() || timberDropUntil != 0 || timberExitFrom != null || shortTimber)) {
                if (woodPickupPending() || timberDropUntil != 0 || timberExitFrom != null) seekTimber();
                else if (!ordinaryCaveDrops && !has(AXE, 1) && affordsWood(localTableWood(), 2)) {
                    if (has(STONE, stonePick ? 3 : 6)) requestTable("stone_axe", null, 0, 2);
                    else if (affordsWood(localTableWood() + 3, 2)) requestTable("wooden_axe", null, 3, 2);
                    else seekTimber();
                } else seekTimber();
                return;
            }
            timberReady = !longGoal || woodPick || stonePick || ironPick;
        }
        if (!woodPick && !stonePick && !ironPick && needsTimberKit() && firing == Firing.NONE
            && has(INGOT, 3) && (affordsWood(4, 2) || affordsWood(0, 2)
                && (has(table.item, 1) || localStation(table, null) || body.find(TABLE_BLOCK, REACH).isPresent()))) {
            makePick("iron_pickaxe", INGOT, 3);
            return;
        }
        if (!woodPick && !stonePick && !ironPick) {
            boolean ready = hands.stableCraftFooting() && affordsWood(localTableWood() + (has(STONE, 3) ? 0 : 3), 2);
            if (!ready && (woodPickupPending() || timberDropUntil != 0 || timberExitFrom != null)) seekTimber();
            else if (has(STONE, 3)) makePick("stone_pickaxe", STONE, 3);
            else makePick("wooden_pickaxe", PLANK, 3);
            return;
        }
        if (!stonePick && !ironPick) {
            if (has(STONE, 3)) makePick("stone_pickaxe", STONE, 3);
            else if (nextFoot == null && !firstStone.working() && ordinarySurfaceWork && needsTimberKit()
                    && fieldWood.step(LOCAL_LIGHT, false)) return;
            else if (ordinarySurfaceWork) firstStone.step();
            else if (!nightSite.guarding() && !has(SHOVEL, 1)
                    && affordsWood(table.position != null || has(table.item, 1) ? 1 : 5, 2)) {
                requestTable("wooden_shovel", null, 1, 2);
            } else gatherStone();
            return;
        }
        if (firing != Firing.NONE) {
            fire(firing, furnaceDemand);
            return;
        }
        if (!ironPick && has(INGOT, 3)) {
            makePick("iron_pickaxe", INGOT, 3);
            return;
        }
        if (!ironPick) {
            acquireIron(3, 2);
            return;
        }
        if (portalSupplies != null && portalSupplies.step(false)) return;
        if (fieldWood.prepareDeepDeparture()) return;
        mineDiamonds(goal.equals("nether_portal") ? 3 : 1);
    }

    private boolean confirmGoal() {
        if (portal != null && portal.updateArrival()) {
            win = true;
            status = "entered the Nether through constructed portal";
        } else if (goalItem != null && !hands.busy() && c.currentScreen == null && has(goalItem, 1)) {
            win = true;
            status = "obtained " + goal;
        }
        return win;
    }

    private void replanStalledLocalWork() {
        rememberStallWork();
        firstStone.interrupt();
        surfaceApproach.abandon();
        if (refitPickCount >= 0) {
            refitPickCount = -1;
            refitPickRetry = tick + 150;
        }
        if (fieldWood.deepFoot != null) fieldWood.endDeepDeparture();
        if (fieldWood.anchor != null) fieldWood.finish();
        if (fieldIgnition != null && fieldIgnition.active()) fieldIgnition.finish();
        if (portalSupplies != null) portalSupplies.interrupt();
        rejectOreProbe();
        if (target != null) {
            forgetOreTarget();
            abandonTarget();
        }
        if (pickupItem != null) abandonPickup(pickupItem, 110);
        if (timberWitness != null) finishTimber(null);
        timberChop = null;
        if (timberCanopy != null) rememberTimberSite(exhaustedCanopies, BlockPos.ofFloored(timberCanopy));
        timberCanopy = null;
        timberExitFrom = timberExitTo = null;
        timberHigherShelf = false;
        supplyLandmark = null;
        if (nextFoot != null) closeDig(nextFoot);
        nextFoot = cavePeek = null;
        endExitRecovery();
        approachGoal = routeLegStart = sweepOrigin = null;
        routeTick = -10;
        heading = Float.NaN;
        headingUntil = 0;
    }

    private boolean ordinaryRouteOwnsRecovery() {
        // A blocked edge belongs to the current route just as much as a successful
        // step. Generic recovery must not reprospect it from the same footing.
        return ordinarySurfaceWork && (bootstrapStone || bootstrapTimber
            || ordinaryRouteTick == tick - 1 && ordinaryRouteJob != Job.FOOD
                && (returnIndex < 0 || ordinaryRouteJob == Job.RETURN))
            && (portal == null || !portal.locallyStopped());
    }

    private Result navigate(Job job, Vec3d target, double arrival) {
        ordinaryRouteJob = job;
        ordinaryRouteTick = tick;
        ordinaryRouteTarget = target;
        ordinaryRouteArrival = arrival;
        ordinaryRouteBand = null;
        return navigationResult(job, navigator.step(job, target, arrival, tick));
    }

    private Result navigate(Job job, AgentResourceStance goal) {
        ordinaryRouteJob = job;
        ordinaryRouteTick = tick;
        ordinaryRouteBand = goal;
        return navigationResult(job, navigator.step(job, goal.point(), goal.arrival(),
            goal.minFootY(), goal.maxFootY(), tick));
    }

    private Result navigationResult(Job job, Result result) {
        status = navigator.status();
        ordinaryArrival = navigator.takeArrival();
        if (ordinaryArrival != null) {
            BlockPos from = ordinaryArrival.from(), to = ordinaryArrival.to();
            if (job == Job.STONE && adjacent(from, to)) recordDryCaveFooting(from, to);
            else stallGuard.navigationArrival(from, to);
            if (job == Job.TIMBER) {
                surfaceApproach.bootstrapLanded(from, to);
            }
        }
        if (result == Result.MOVING) rememberMotion();
        return result;
    }

    private void rememberStallWork() {
        int incident = stallGuard.report().incidents();
        if (incident != stallWorkIncident) {
            stallWorkIncident = incident;
            stallOreTried.clear();
            stallRouteTried.clear();
            stallDropsTried.clear();
            stallTorchTried = false;
            stallIronTried = 0;
            stallStation = null;
            stallStationPosition = null;
            stallKit = availableStallKit();
        }
        if (target != null) stallOreTried.add(target);
        if (timberWitness != null) stallOreTried.add(timberWitness.getBlockPos());
        if (timberChop != null) stallOreTried.add(timberChop.getBlockPos());
        if (pickupEntity != null) stallDropsTried.add(pickupEntity.getId());
        if (exitTo != null) stallRouteTried.add(exitTo);
        if (nextFoot != null) stallRouteTried.add(nextFoot);
        if (returnIndex >= 0 && returnIndex < trail.size()) stallRouteTried.add(trail.get(returnIndex));
        if (resumeIndex >= 0 && resumeIndex < trail.size()) stallRouteTried.add(trail.get(resumeIndex));
    }

    private int availableStallKit() {
        boolean wooden = has(WOOD_PICK, 1), stone = has(STONE_PICK, 1), iron = has(DEEP_PICK, 1);
        int kit = 0;
        if (wooden) kit |= KIT_WOOD_PICK;
        if (stone) kit |= KIT_STONE_PICK;
        if (iron) kit |= KIT_DEEP_PICK;
        if (has(TORCH, 2)) kit |= KIT_LIGHT;
        if (!iron && has(INGOT, 3)) {
            kit |= KIT_IRON;
            if (affordsWood(ironTableWood(), 2)) kit |= KIT_IRON_PICK_READY;
        }
        if (!iron && !stone && has(STONE, 3)) kit |= KIT_STONE;
        if (!iron && !stone && !wooden && affordsWood(3, 2)) kit |= KIT_WOOD;
        // Count an actual owned station when it can advance this leg, separately from wood
        // that was already convertible in theory. Do not credit spare copies or slot changes.
        if (!iron && has(table.item, 1) && stallWorkbenchNeeded(kit)) kit |= KIT_WORKBENCH;
        if (!iron && stone && needsTimberKit() && fundedFirstIron(3 - hands.count(INGOT)) != null) kit |= KIT_FURNACE;
        return kit;
    }

    private boolean stallWorkbenchNeeded(int kit) {
        return (kit & KIT_WOOD) != 0 || (kit & (KIT_STONE | KIT_IRON)) != 0 && affordsWood(0, 2);
    }

    /** Inspect only the existing camera, owned items and actually traveled routes; do not perform another sweep. */
    private String chooseStallAlternative() {
        rememberStallWork();
        if (portal != null && portal.locallyStopped()) {
            String route = portal.resumeLocalWork();
            if (route != null) {
                stallWork = () -> AgentStallGuard.Alternative.REPLAN;
                return route;
            }
        } else if (stallGuard.takeChangedFooting()) {
            replanStalledLocalWork();
            stallWork = () -> AgentStallGuard.Alternative.REPLAN;
            return "replanning from changed settled footing at " + c.player.getBlockPos().toShortString();
        }
        if (goalItem != null) {
            String pickup = stallPickup(goalItem, goal);
            if (pickup != null) return pickup;
        }
        int kit = availableStallKit(), gained = kit & ~stallKit;
        if (portal == null || !portal.locallyStopped()) {
            String station = stallStation == null ? null : stallVisibleStation(stallStation);
            if (station == null && stallStation != table && stallWorkbenchNeeded(kit)) station = stallVisibleStation(table);
            if (station == null && stallStation != furnace && (kit & KIT_FURNACE) != 0)
                station = stallVisibleStation(furnace);
            if (station != null) return station;
            int workshop = kit & (KIT_FURNACE | KIT_IRON_PICK_READY);
            int distinctWorkshop = stallStation == null ? workshop & ~stallIronTried : 0;
            if ((gained | distinctWorkshop) != 0) {
                stallKit |= kit;
                stallIronTried |= workshop;
                replanStalledLocalWork();
                stallWork = () -> AgentStallGuard.Alternative.REPLAN;
                if ((gained & KIT_WORKBENCH) != 0) return "replanning with an owned crafting table and pickaxe ingredients";
                if (((gained | distinctWorkshop) & KIT_IRON_PICK_READY) != 0)
                    return "replanning with owned iron pick materials and a payable bench";
                if (((gained | distinctWorkshop) & KIT_FURNACE) != 0)
                    return "replanning with raw iron, fuel and a payable furnace";
                return "replanning with newly available owned tools, light or materials";
            }
        }
        String resource;
        if (has(DEEP_PICK, 1) && (goal.equals("diamond") || portal != null && !has(DIAMOND, 3) && !has(DIAMOND_PICK, 1))) {
            resource = stallOre(Resource.DIAMOND);
            if (resource != null) return resource;
        }
        if ((has(STONE_PICK, 1) || has(DEEP_PICK, 1)) && hands.count(RAW_IRON) + hands.count(INGOT) < 3
                && (goal.equals("iron_pickaxe") || goal.equals("diamond") || portal != null)) {
            resource = stallOre(Resource.IRON);
            if (resource != null) return resource;
        }
        if (needsTimberKit() && !has(TORCH, 4)) {
            if (!stallTorchTried && has(FUEL, 1) && affordsWood(0, 1)) {
                int before = hands.count(TORCH);
                if (craftTorches(LOCAL_LIGHT)) {
                    stallTorchTried = true;
                    stallWork = () -> has(TORCH, before + 1) ? stallAcquired()
                        : AgentStallGuard.Alternative.REFUSED;
                    return "crafting available light from owned fuel and wood";
                }
            }
            if (!has(FUEL, 1) && affordsWood(0, 1)) {
                resource = stallOre(Resource.COAL);
                if (resource != null) return resource;
            }
        }
        if (!has(STONE_PICK, 1) && !has(DEEP_PICK, 1) && !has(STONE, 3)) {
            resource = stallOre(Resource.STONE);
            if (resource != null) return resource;
        }
        if (!timberReady && needsTimberKit() && surfaceDeparture()
                || !affordsWood(0, 3) || !has(WOOD_PICK, 1) && !has(STONE_PICK, 1) && !has(DEEP_PICK, 1)) {
            resource = stallTimber();
            if (resource != null) return resource;
        }
        return stallKnownRoute();
    }

    private String stallVisibleStation(Station station) {
        if (station == furnace && (furnaceLoaded || localFurnace != null || furnace.placed != 0)) return null;
        BlockHitResult other = body.find(state -> state.isOf(station.block), REACH - 0.5,
            hit -> !hit.getBlockPos().equals(station == stallStation ? stallStationPosition : station.position)
                && (station != furnace || !reservedFurnace(hit.getBlockPos()))
                && !stallOreTried.contains(hit.getBlockPos())).orElse(null);
        if (other == null) return null;
        station.position = confirmStation(station, other);
        if (station == furnace) furnaceWitness = station.position;
        station.resetSite();
        station.lastUse = null;
        station.placed = station.approachUntil = station.openAttempts = 0;
        stallOreTried.add(station.position);
        stallWork = () -> AgentStallGuard.Alternative.REPLAN;
        return "using a different witnessed " + station.recipe + " at " + station.position.toShortString();
    }

    private String stallTimber() {
        String pickup = stallPickup(LOG, "log");
        if (pickup != null) return pickup;
        BlockHitResult log = body.find(state -> state.isIn(BlockTags.LOGS), c.player.getBlockInteractionRange(), seen -> {
            BlockPos block = seen.getBlockPos();
            return settledTrunk.test(seen)
                && !stallOreTried.contains(block) && !supportsTrail(block)
                && !body.hazardAhead(yaw(seen.getPos().subtract(c.player.getPos())), 1.5);
        }).orElse(null);
        if (log == null) return null;
        stallOreTried.add(log.getBlockPos());
        int before = hands.count(LOG);
        beginTimberChop(log, false);
        stallWork = () -> {
            if (has(LOG, before + 1)) return stallAcquired();
            if (timberChop != null) {
                chopTimber();
                return AgentStallGuard.Alternative.WORKING;
            }
            return collect(LOG, 2) || tick < timberDropUntil ? AgentStallGuard.Alternative.WORKING
                : AgentStallGuard.Alternative.REFUSED;
        };
        return "cutting a different reachable log at " + log.getBlockPos().toShortString();
    }

    private String stallPickup(Predicate<ItemStack> drop, String name) {
        Vec3d feet = c.player.getPos();
        ItemEntity sighting = (ItemEntity) body.visibleEntity(entity -> entity instanceof ItemEntity item && drop.test(item.getStack())
            && !stallDropsTried.contains(entity.getId()) && Math.abs(entity.getY() - feet.y) < 0.55, 1.85).orElse(null);
        if (sighting == null) return null;
        stallDropsTried.add(sighting.getId());
        int before = hands.count(drop);
        stallWork = () -> has(drop, before + 1) ? stallAcquired()
            : collectObserved(drop, body.seesDrop(sighting, 1.85) ? sighting : null)
                ? AgentStallGuard.Alternative.WORKING : AgentStallGuard.Alternative.REFUSED;
        return "collecting a newly available visible " + name + " drop";
    }

    private String stallOre(Resource resource) {
        String pickup = stallPickup(resource.drop, resource.label);
        if (pickup != null) return pickup;
        BlockHitResult hit = body.find(resource.block, REACH - 0.4, seen -> {
            BlockPos block = seen.getBlockPos();
            return !stallOreTried.contains(block) && reachableResourceFace(block) && !supportsTrail(block)
                && (resource != Resource.STONE || stoneStockFace(block))
                && !body.hazardAhead(yaw(seen.getPos().subtract(c.player.getPos())), 1.5)
                && tools.canHarvest(state(seen));
        }).orElse(null);
        if (hit == null) return null;
        stallOreTried.add(hit.getBlockPos());
        int before = hands.count(resource.drop);
        setTarget(hit, resource);
        quarryingStoneStock = resource == Resource.STONE;
        stallWork = () -> {
            if (has(resource.drop, before + 1)) return stallAcquired();
            if (target != null) {
                mineTarget(resource);
                return AgentStallGuard.Alternative.WORKING;
            }
            return collect(resource.drop, 2) || tick < pickupUntil ? AgentStallGuard.Alternative.WORKING
                : AgentStallGuard.Alternative.REFUSED;
        };
        return "mining distinct visible " + resource.label + " at " + hit.getBlockPos().toShortString();
    }

    private String stallKnownRoute() {
        BlockPos current = c.player.getBlockPos();
        int index = trail.lastIndexOf(current);
        if (index < 0) return null;
        for (int direction = -1; direction <= 1; direction += 2) {
            int next = index + direction;
            if (next < 0 || next >= trail.size()) continue;
            BlockPos step = trail.get(next);
            if (!adjacent(current, step) || current.getY() != step.getY()
                    || stallRouteTried.contains(step) || stallGuard.triedStallRoute(current, step)) continue;
            Vec3d landing = Vec3d.ofBottomCenter(step);
            BlockHitResult support = terrain(landing.add(0, -0.07, 0), 3.2);
            if (support == null || !support.getBlockPos().equals(step.down()) || support.getSide() != Direction.UP
                    || !safeSupport(support) || !body.clearTerrain(landing.add(0, 0.45, 0))
                    || !body.clearTerrain(landing.add(0, 1.55, 0))
                    || body.hazardAhead(yaw(landing.subtract(c.player.getPos())), 1.45)) continue;
            stallRouteTried.add(step);
            approachGoal = null;
            stallWork = () -> {
                if (arrived(step)) {
                    recordStallFooting(step);
                    return portal != null && portal.locallyStopped()
                        ? AgentStallGuard.Alternative.ADVANCED_BUT_HELD : AgentStallGuard.Alternative.REPLAN;
                }
                return walkMinedStep(step) == Walk.BLOCKED ? AgentStallGuard.Alternative.REFUSED
                    : AgentStallGuard.Alternative.WORKING;
            };
            return "following a different reverified traveled step to " + step.toShortString();
        }
        return null;
    }

    private AgentStallGuard.Alternative workStallAlternative() { return stallWork.get(); }

    private AgentStallGuard.Alternative stallAcquired() {
        return portal != null && portal.locallyStopped() ? AgentStallGuard.Alternative.ADVANCED_BUT_HELD
            : AgentStallGuard.Alternative.ADVANCED;
    }

    private void releaseStallAlternative() {
        if (stallWork == null) return;
        stallWork = null;
        target = null;
        timberChop = null;
        clearPickup();
        pickupUntil = 0;
        approachGoal = null;
    }

    private boolean protectRecoveryBlock(BlockPos block) {
        return supportsTrail(block) || timberUnderfoot(block) || block.equals(table.position)
            || block.equals(furnace.position) || block.equals(furnaceWitness) || block.up().equals(table.position)
            || block.up().equals(furnace.position) || block.up().equals(furnaceWitness);
    }

    boolean macroCanBreak(BlockPos block) { return !protectRecoveryBlock(block); }

    /** The normal tool ladder, cut at effect types the current work order can audit. */
    record WorkStage(String recipe, int executions, Predicate<ItemStack> pickup,
                     Predicate<BlockState> gather, String blocked) {
        WorkStage(String recipe, int executions) { this(recipe, executions, null, null, null); }
        WorkStage(Predicate<ItemStack> pickup, Predicate<BlockState> gather) { this(null, 0, pickup, gather, null); }
        WorkStage(String blocked) { this(null, 0, null, null, blocked); }
    }

    WorkStage macroPresetStage(AgentWorkOrder.Budget budget, boolean tableInReach) {
        final boolean woodenGoal = goal.equals("wooden_pickaxe");
        boolean wood = has(WOOD_PICK, 1), stone = has(STONE_PICK, 1), iron = has(DEEP_PICK, 1);
        if (woodenGoal || !wood && !stone && !iron) {
            if (!woodenGoal && has(STONE, 3)) return macroPickStage(budget, "stone_pickaxe", 0, tableInReach);
            return macroPickStage(budget, "wooden_pickaxe", 3, tableInReach);
        }
        if (!stone && !iron || goal.equals("stone_pickaxe")) {
            if (has(STONE, 3)) return macroPickStage(budget, "stone_pickaxe", 0, tableInReach);
            return new WorkStage(STONE, state -> state.isOf(Blocks.STONE) || state.isOf(Blocks.DEEPSLATE)
                || state.isOf(Blocks.COBBLESTONE) || state.isOf(Blocks.COBBLED_DEEPSLATE));
        }
        if (!iron || goal.equals("iron_pickaxe")) {
            if (has(INGOT, 3)) return macroPickStage(budget, "iron_pickaxe", 0, tableInReach);
            if (!has(RAW_IRON, 3 - hands.count(INGOT))) return new WorkStage(RAW_IRON, Resource.IRON.block);
            return new WorkStage("The next tool needs smelting; this work order does not authorize furnace transfers.");
        }
        if (goal.equals("nether_portal") && has(DIAMOND, 3))
            return new WorkStage("The portal job needs a separately authorized construction and ignition plan.");
        return new WorkStage(DIAMOND, Resource.DIAMOND.block);
    }

    private WorkStage macroPickStage(AgentWorkOrder.Budget budget, String recipe, int planks, boolean tableInReach) {
        if (!budget.policy.craftAllowed(recipe) || budget.craftsLeft() == 0)
            return new WorkStage("The next tool recipe is outside the remaining permission.");
        if (hands.workCraftable(recipe, budget)) {
            if (tableInReach || has(table.item, 1) && budget.canPlace() && budget.policy.placeTable())
                return new WorkStage(recipe, 1);
            if (hands.workCraftable("crafting_table", budget) && budget.canPlace() && budget.policy.placeTable())
                return new WorkStage("crafting_table", 1);
        }
        if (!has(STICK, 2) && hands.workCraftable("stick", budget)) return new WorkStage("stick", 1);
        int needed = planks + (has(STICK, 2) ? 0 : 2) + (tableInReach || has(table.item, 1) ? 0 : 4);
        if (needed == 0) return new WorkStage("The existing tool ingredients, reserve floors or output storage do not admit a recipe.");
        if (hands.workCraftable("planks", budget)) return new WorkStage("planks", Math.max(1, (needed - hands.count(PLANK) + 3) / 4));
        return new WorkStage(stack -> LOG.test(stack) || PLANK.test(stack) || STICK.test(stack)
            || stack.isOf(Items.CRAFTING_TABLE),
            state -> state.isIn(BlockTags.LOGS) || state.isOf(Blocks.BAMBOO_BLOCK) || state.isOf(Blocks.STRIPPED_BAMBOO_BLOCK));
    }

    /** Existing visible-lane navigation, with water entries and recovery edits disabled. */
    boolean macroWorkWalk(Vec3d point, boolean levelOnly) { return approach(point, false, false, levelOnly) != Walk.BLOCKED; }

    private void recordStallFooting(BlockPos reached) {
        BlockState base = stallGuard.confirmedStepBase(reached);
        if (base != null) surfaceApproach.raisedFromCanopy(reached, base);
        // This callback identifies a landing, not the crossing that reached it.
        if (!mineResite.retreating() && returnIndex >= 0 && dryFieldFooting() && !rejoinReturn(reached))
            abandonReturn(reached);
    }

    /** Only ordinary trail work may continue under a witnessed low ceiling; never widen the pillar. */
    private String tryStallMineHandback(BlockPos standing) {
        if (!arrived(standing) || c.player.isTouchingWater() || returnableMine.unjoined()
                || caves.active() || trail.size() < 3
                || portal != null && portal.castEligible()) return null;
        int last = activeTrail() - 1;
        int index = last;
        while (index >= 2 && !standing.equals(trail.get(index))) index--;
        if (index < 2) return null;

        boolean connectedMine = false;
        for (int step = index; step > Math.max(0, index - 4); --step) {
            BlockPos current = trail.get(step);
            BlockPos previous = trail.get(step - 1);
            if (!adjacent(current, previous) || current.getX() == previous.getX() && current.getZ() == previous.getZ())
                return null;
            connectedMine |= dugSteps.get(step);
        }
        if (returnIndex >= 0 && keepTrail) {
            if (!rejoinReturn(standing)) {
                abandonReturn(standing);
                return null;
            }
            return "resuming the existing supply return on the connected mine trail";
        }
        if (!connectedMine || index != last || resumeIndex >= 0 || returnIndex >= 0 || nextFoot != null) return null;
        if (hands.count(TORCH) <= 2 || pickUses(DEEP_PICK) + pickUses(STONE_PICK) < 4) {
            if (supplyReturnReady() || !startReturn(0, true)) return null;
            returnForSupplies = true;
            return "returning on the connected mine trail for essential supplies";
        }
        int branch = Math.max(1, index - 3);
        return startReturn(branch, false)
            ? "backtracking to " + trail.get(branch).toShortString() + " to open a different ordinary mine branch"
            : null;
    }

    void acquireIron(int desired) {
        acquireIron(desired, 0);
    }

    private boolean stepFundedIronWorkshop() {
        if (!ordinaryCaveDrops || !needsTimberKit() || has(DEEP_PICK, 1)) return false;
        boolean supplyReturn = returnIndex >= 0 && returnForSupplies;
        boolean oldTravel = supplyEgress.active() || mineResite.active() || navigator.driving() || supplyReturn;
        if (portal != null && (portalStarted || portal.locallyStopped() || portal.castEligible()
                || portalSupplies.stoneBank != null || !oldTravel && !furnaceForFirstPick)) return false;
        if (!hands.stableCraftFooting() || !body.hasRecentView() || body.lavaEmergency()
                || nextFoot != null || localFurnace != null || returnableMine.settling()
                || returnIndex >= 0 && !supplyReturn && !mineResite.retreating()
                || supplyEgress.active() && !supplyEgress.canYieldToWorkshop()
                || mineResite.tread != null && mineResite.tread.inFlight()) return false;
        if (stallGuard.ownsRecovery() && !oldTravel) return false;
        if (firing != Firing.NONE) {
            if (!furnaceForFirstPick || oldTravel || stallGuard.ownsRecovery()) return false;
            fire(firing, furnaceDemand);
            return true;
        }

        int missing = 3 - hands.count(INGOT);
        var smelt = missing > 0 && has(STONE_PICK, 1) ? fundedFirstIron(missing) : null;
        // With ingots in hand, seek handles only if needed. A genuine handle
        // search keeps its travel turn until the missing wood is actually owned.
        if (missing > 0 ? smelt == null : oldTravel && !affordsWood(ironTableWood(), 2)) return false;
        if (oldTravel) {
            // Release obsolete search at settled footing, not an in-flight crossing
            // or the return to a real workshop. Keep the proven mine trail.
            if (mineResite.active()) mineResite.release();
            if (supplyEgress.active()) supplyEgress.yieldToWorkshop();
            if (supplyReturn) {
                int anchor = groundedTrailIndex();
                clearReturn();
                resumeAfterReturn(c.player.getBlockPos(), anchor);
            }
            supplyLandmark = null;
            body.pauseWork();
        }
        if (stallGuard.ownsRecovery()) return false; // The distinct-work chooser can now see the workshop.
        if (smelt != null) workFirstIron(3, smelt);
        else makePick("iron_pickaxe", INGOT, 3);
        return true;
    }

    private AgentHands.FirstIronPlan fundedFirstIron(int wanted) {
        if (wanted <= 0 || !has(RAW_IRON, wanted)) return null;
        boolean installed = ironFurnaceAvailable(), stone = has(STONE, 8);
        return installed || stone ? hands.firstIronPlan(wanted, ironTableWood(), installed, stone) : null;
    }

    private boolean ironFurnaceAvailable() {
        return furnace.placed != 0 || has(furnace.item, 1)
            || localStation(furnace, furnaceWitness)
                && !reservedFurnace(furnace.position != null ? furnace.position : furnaceWitness)
            || visibleLocalFurnace() != null;
    }

    private void acquireIron(int desired, int sticks) {
        if (firing != Firing.NONE) {
            fire(firing, furnaceDemand);
            return;
        }
        int ingots = hands.count(INGOT);
        if (ingots >= desired) return;
        if (nextFoot != null) {
            excavate(nextFoot.getY(), digGoal);
            return;
        }
        if (has(DEEP_PICK, 1) && !has(DIAMOND, portal == null ? 1 : 3)
            && workOre(Resource.DIAMOND, REACH - 0.35, false)) return;
        int raw = hands.count(RAW_IRON);
        int batch = Math.min(3, desired - ingots);
        if (raw >= batch) {
            boolean hasFurnace = ironFurnaceAvailable();
            int benchWood = sticks > 0 || !hasFurnace ? ironTableWood() : 0;
            if (sticks > 0) {
                var plan = hands.firstIronPlan(batch, benchWood, hasFurnace, has(STONE, 8));
                if (plan != null) {
                    workFirstIron(desired, plan);
                    return;
                }
                if (!has(TORCH, 2) && craftTorches(LOCAL_LIGHT)) return;
                if (!hasFurnace && !affordsWood(benchWood, 0)) seekExpeditionSupplies("furnace workbench wood");
                else if (!hasFurnace && !has(STONE, 8)) gatherStone();
                else if (!workOre(Resource.COAL, has(TORCH, 2) ? SEARCH : REACH - 0.35, true))
                    seekExpeditionSupplies("furnace fuel");
                return;
            }
            var plan = ownedIronPlan(batch, benchWood, sticks);
            if (plan == null) {
                if (!has(TORCH, 2) && craftTorches(LOCAL_LIGHT)) return;
                if (!affordsWood(benchWood, sticks)) seekExpeditionSupplies("workshop wood");
                else if (!workOre(Resource.COAL, has(TORCH, 2) ? SEARCH : REACH - 0.35, true))
                    seekExpeditionSupplies("furnace fuel");
                return;
            }
            if (!prepareIronStock(plan)) startIron(desired, benchWood, sticks);
        } else {
            gather(Resource.IRON, surfaceDeparture() ? 115 : 0, 16);
        }
    }

    private AgentHands.OrdinaryIronPlan ownedIronPlan(int wanted, int planks, int sticks) {
        return hands.ordinaryIronPlan(wanted, planks, sticks, ItemStack.EMPTY, false);
    }

    private boolean prepareIronStock(AgentHands.OrdinaryIronPlan plan) {
        if (plan.preparation() == null) return false;
        status = plan.preparation().equals("stick") ? "crafting the reserved iron pick handles"
            : "turning owned wood into workshop planks";
        hands.craft(plan.preparation());
        return true;
    }

    private int ironTableWood() {
        return localTableWood() == 0 || body.find(TABLE_BLOCK, REACH).isPresent() ? 0 : 4;
    }

    private int ironBenchReserve() {
        return furnaceIronHandlePlanks + (furnaceIronPlanks == 0 ? 0 : Math.min(furnaceIronPlanks, localTableWood()));
    }

    private void workFirstIron(int desired, AgentHands.FirstIronPlan plan) {
        if (prepareIronStock(plan.heat())) return;
        furnaceForFirstPick = true;
        furnaceIronHandlePlanks = plan.handlePlanks();
        startIron(desired, plan.benchPlanks(), plan.sticks());
    }

    private void startIron(int demand, int planks, int sticks) {
        furnaceIronPlanks = planks;
        furnaceIronSticks = sticks;
        fire(Firing.IRON, demand);
    }

    boolean mineDiamonds(int count) {
        if (has(DIAMOND, count)) return true;
        if (firing != Firing.NONE) {
            fire(firing, furnaceDemand);
        } else {
            gather(Resource.DIAMOND, 0, DIAMOND_LEVEL);
        }
        return false;
    }

    private boolean surfaceDeparture() {
        return !departureKit && resumeIndex < 0 && supplyEgress.outdoors();
    }

    /** One bounded local search; the ordinary workshop and mine take over on real footing. */
    private final class NightWorksite {
        private record Wall(BlockPos feet, BlockState low, BlockState high) {}

        private final AgentNightWorksite cue = new AgentNightWorksite();
        private final Predicate<BlockHitResult> localOre = this::sideOre;
        private BlockPos origin, source, foot, settled, rejected;
        private Direction back, settledBearing;
        private Wall backWall, sideWall, settledBack, settledSide;
        private BlockState roof, settledRoof;
        private ClientWorld world;
        private int lastBodyTurn, skyCheck, glanceAt, surveyAt, siteCheck, views, attempts, deadline;
        private int moveSince, inspectAt, fallbackUntil;
        private float surveyYaw;
        private boolean glanced, bank, headOpened, opened, fallbackUsed;

        void reset() {
            interrupt();
            cue.clear();
            world = c.world;
            settled = rejected = null;
            settledBack = settledSide = null;
            settledRoof = null;
            glanced = fallbackUsed = false;
            lastBodyTurn = skyCheck = glanceAt = surveyAt = siteCheck = views = attempts = 0;
        }

        void interrupt() {
            if (foot != null && bank) rejected = foot;
            origin = source = foot = null;
            sideWall = backWall = null;
            roof = null;
            moveSince = inspectAt = 0;
            headOpened = opened = false;
            fallbackUntil = 0;
        }

        private boolean early() {
            return ordinaryCaveDrops && c.interactionManager != null
                && c.interactionManager.getCurrentGameMode() == GameMode.SURVIVAL
                && !departureKit && activeTrail() <= 1 && nextFoot == null
                && resumeIndex < 0 && !returnableMine.active() && !caves.active() && !caves.routingDry();
        }

        private boolean vulnerable() {
            return c.player.getArmor() == 0 && !has(SHIELD, 1)
                && !c.player.getOffHandStack().isOf(Items.SHIELD);
        }

        void observe() {
            if (world != c.world) reset();
            int turn = body.actionTick();
            // Creeper safety can own the entire client turn before Progress runs.
            if (lastBodyTurn != 0 && lastBodyTurn != turn - 1) interrupt();
            lastBodyTurn = turn;
            if (!early() || tick < skyCheck || !dryFieldFooting() || !vulnerable()) return;
            skyCheck = tick + 6;
            BlockPos standing = c.player.getBlockPos();
            BlockState contact = body.dryCaveContact(standing);
            if (contact == null) return;
            var sky = body.renderedSurfaceSky();
            if (sky == AgentNightWorksite.Sky.DARK && !surfaceContact(contact)
                    && (body.supplyPerspective(c.player.getYaw()) & AgentBody.SUPPLY_OPEN) == 0) return;
            cue.observe(sky, standing, tick);
            if (sky == AgentNightWorksite.Sky.BRIGHT) {
                interrupt();
                settled = rejected = null;
                settledBack = settledSide = null;
                settledRoof = null;
                surveyAt = views = attempts = 0;
                fallbackUsed = false;
                glanced = true;
            }
        }

        boolean guarding() {
            return early() && cue.darkAt(c.player.getBlockPos(), tick) && vulnerable()
                && !has(DEEP_PICK, 1) && (has(WOOD_PICK, 1) || has(STONE_PICK, 1));
        }

        private boolean settledAt(BlockPos standing) {
            return standing.equals(settled) && centered(standing) && dryFieldFooting() && body.dryCaveContact(standing) != null
                && retains(settledBack) && retains(settledSide)
                && (settledRoof == null || c.world.getBlockState(standing.up(2)) == settledRoof);
        }

        private boolean surfaceContact(BlockState contact) {
            return supplyEgress.outdoors() || contact.isOf(Blocks.GRASS_BLOCK)
                || contact.isOf(Blocks.PODZOL) || contact.isOf(Blocks.MYCELIUM);
        }

        Direction mineBearing(BlockPos standing) {
            return guarding() && settledAt(standing) ? settledBearing : null;
        }

        boolean recoiling() { return c.player.hurtTime > 0 && guarding(); }

        boolean step() {
            if (!early() || !vulnerable()) {
                interrupt();
                return false;
            }
            BlockPos standing = c.player.getBlockPos();
            if (!dryFieldFooting() || c.player.hurtTime > 0 || c.player.hasVehicle()
                    || firing != Firing.NONE || tableRecipe != null) return false;
            if (!guarding()) {
                interrupt();
                BlockState contact = body.dryCaveContact(standing);
                // A single sky check at a known forest/surface stance, never a tour of a dark passage.
                if (!glanced && contact != null && surfaceContact(contact)) {
                    if (glanceAt == 0) {
                        glanceAt = tick;
                        surveyYaw = c.player.getYaw();
                    }
                    if (tick - glanceAt <= 18) {
                        body.turn(surveyYaw, -38);
                        status = "checking the visible sky before opening the first mine";
                        return true;
                    }
                    glanced = true;
                }
                return false;
            }
            glanced = true;
            if (settledAt(standing)) {
                return has(FUEL, 1) && craftTorches(4);
            }
            if (settled != null) return false; // An ordinary departure is not another worksite relocation.
            if (foot != null) return work(standing);
            if (fallbackUntil != 0) {
                if (tick < fallbackUntil && origin != null && standing.getSquaredDistance(origin) < 9) {
                    if (navigate(Job.EXPLORE, null, 0) == Result.BLOCKED) interrupt();
                    return true;
                }
                interrupt();
                views = 0; // One observation at the new actual footing, not another panorama.
            }
            if (attempts < 2 && tick >= siteCheck) {
                siteCheck = tick + 4;
                if (find(standing)) return true;
            }
            if (fallbackUsed || views >= 2 || attempts >= 2) return false;
            if (surveyAt == 0) {
                surveyAt = tick;
                surveyYaw = c.player.getYaw();
            }
            float bearing = surveyYaw + (views == 0 ? 0 : 42);
            body.turn(bearing, 9);
            if (body.renderedDirection(bearing, 9, 7) || tick - surveyAt >= 22) {
                views++;
                surveyAt = tick;
            }
            status = "looking briefly for a stable corner or bank for night work";
            return true;
        }

        private boolean find(BlockPos standing) {
            if (!body.hasRecentView() || body.dryCaveContact(standing) == null) return false;
            if (centered(standing) && corner(standing, standing)) return true;
            for (Direction lane : Direction.Type.HORIZONTAL) {
                BlockPos nearby = standing.offset(lane);
                if (floor(nearby) != null && clearBody(nearby) && corner(standing, nearby)) return true;
            }
            if (bank(standing, standing)) return true;
            for (Direction lane : Direction.Type.HORIZONTAL) {
                BlockPos nearby = standing.offset(lane);
                if (floor(nearby) != null && clearBody(nearby) && bank(standing, nearby)) return true;
            }
            return false;
        }

        private boolean bank(BlockPos standing, BlockPos approach) {
            for (Direction lane : Direction.Type.HORIZONTAL) {
                BlockPos cell = approach.offset(lane);
                if (cell.equals(standing)) continue;
                if (cell.equals(rejected)) continue;
                BlockState cap = wallCell(cell.up(2), 0.12);
                if (cap == null || !cuttable(cell.up(), 0.52, lane) || !cuttable(cell, 0.86, lane)) continue;
                select(standing, approach, cell, lane, null, null, cap, true);
                return true;
            }
            return false;
        }

        private boolean corner(BlockPos standing, BlockPos candidate) {
            if (candidate.equals(rejected)) return false;
            for (Direction dir : Direction.Type.HORIZONTAL) {
                Wall rear = wall(candidate, dir);
                if (rear == null) continue;
                if (returnableFace(rear.feet, rear.low) != AgentReturnableMine.Face.MINEABLE
                        && returnableFace(rear.feet.up(), rear.high) != AgentReturnableMine.Face.MINEABLE) continue;
                Wall side = flank(candidate, dir);
                if (side == null) continue;
                BlockState cap = wallCell(candidate.up(2), 0.10);
                boolean overhead = cap != null
                    || body.dryCaveSpace(Vec3d.ofCenter(candidate.up(2), 0.50)) == AgentBody.DryRouteSample.CLEAR;
                if (AgentNightWorksite.corner(true, overhead, true, true) != AgentNightWorksite.Cover.CORNER)
                    continue;
                select(standing, standing, candidate, dir, rear, side, cap, false);
                return true;
            }
            return false;
        }

        private void select(BlockPos from, BlockPos approach, BlockPos where, Direction dir,
                            Wall rear, Wall side, BlockState cap, boolean dig) {
            origin = from;
            source = approach;
            foot = where;
            back = dir;
            backWall = rear;
            sideWall = side;
            roof = cap;
            bank = dig;
            attempts++;
            deadline = tick + 128;
            body.pauseWork();
            stallGuard.ordinarySetup();
            var cover = dig ? AgentNightWorksite.Cover.BANK : AgentNightWorksite.Cover.CORNER;
            status = cue.action(from, tick, true, true, cover, false) == AgentNightWorksite.Action.OPEN
                ? "choosing a witnessed solid bank for a night work pocket"
                : "choosing a witnessed natural corner for night work";
        }

        private boolean work(BlockPos standing) {
            if (tick > deadline || !standing.equals(origin) && !standing.equals(source) && !standing.equals(foot)
                    || backWall != null && !retains(backWall) || sideWall != null && !retains(sideWall)
                    || roof != null && c.world.getBlockState(foot.up(2)) != roof) return refuse();
            if (!standing.equals(source) && !standing.equals(foot)) {
                status = "approaching a witnessed side face on a checked dry step";
                return walkTo(standing, source);
            }
            if (bank && !opened) {
                if (!standing.equals(source)) return refuse();
                if (!hands.stableCraftFooting()) return true;
                if (!headOpened) {
                    if (!open(foot.up(), 0.52)) return true;
                    headOpened = true;
                }
                if (!open(foot, 0.81)) return true;
                opened = true; // Two fresh empty-cell views, not a landing or a cover receipt.
                moveSince = 0;
            }
            if (standing.equals(foot) && centered(foot) && hands.stableCraftFooting()
                    && body.dryCaveContact(standing) != null) {
                if (bank) {
                    if (backWall == null) backWall = wall(foot, back);
                    if (sideWall == null) sideWall = flank(foot, back);
                    if (AgentNightWorksite.pocket(true, opened, roof != null, backWall != null, sideWall != null)
                            != AgentNightWorksite.Cover.POCKET) {
                        if (inspectAt == 0) inspectAt = tick;
                        int age = tick - inspectAt;
                        if (age >= 42) return refuse();
                        Direction check = backWall == null ? back : age < 17 ? back.rotateYClockwise()
                            : back.rotateYCounterclockwise();
                        body.turn(check.getPositiveHorizontalDegrees(), 16);
                        status = "checking the entered pocket's back and flank, not claiming cover";
                        return true;
                    }
                }
                var cover = bank ? AgentNightWorksite.Cover.POCKET : AgentNightWorksite.Cover.CORNER;
                if (cue.action(standing, tick, vulnerable(), true, cover, true) != AgentNightWorksite.Action.WORK)
                    return refuse();
                settled = foot;
                settledBearing = back;
                settledBack = backWall;
                settledSide = sideWall;
                settledRoof = roof;
                origin = source = foot = null;
                backWall = sideWall = null;
                roof = null;
                headOpened = opened = false;
                moveSince = inspectAt = 0;
                surfaceApproach.abandon();
                body.turn(settledBearing.getPositiveHorizontalDegrees(), 10);
                status = "settled in the witnessed night work pocket; preparing ordinary workshop supplies";
                return true;
            }
            status = bank ? "checking the dry step into the opened night pocket"
                : "moving to the checked corner for night work";
            return walkTo(standing, foot);
        }

        private boolean centered(BlockPos cell) {
            return c.player.getPos().squaredDistanceTo(cell.getX() + 0.5, cell.getY(), cell.getZ() + 0.5)
                <= 0.27 * 0.27;
        }

        private boolean walkTo(BlockPos standing, BlockPos goal) {
            if (moveSince == 0) moveSince = tick;
            if (tick - moveSince > 33) return refuse();
            Vec3d center = Vec3d.ofBottomCenter(goal);
            if (body.driveObservedStep(center)) {
                rememberMotion();
                return true;
            }
            if (standing.equals(goal)) return true; // Braking from the same proved step.
            Vec3d aim = center.add(0, 0.74, 0);
            BlockHitResult landing = floor(goal);
            body.aim(aim);
            if (landing != null && clearBody(goal)
                    && body.emergencyLaneClear(center, c.player.getWidth() * 0.5)
                    && body.beginObservedStep(landing, center)) rememberMotion();
            return true;
        }

        private boolean open(BlockPos cell, double height) {
            Vec3d point = Vec3d.ofCenter(cell, height);
            if (body.dryCaveSpace(point) == AgentBody.DryRouteSample.CLEAR) return true;
            BlockHitResult hit = face(cell, height);
            status = "cutting a stationary side recess below a witnessed stable roof";
            body.aim(point);
            if (hit != null && hit.getSide() == back.getOpposite()
                    && returnableFace(cell, state(hit)) == AgentReturnableMine.Face.MINEABLE) {
                body.aimContact(hit, AgentBody.Contact.MINE);
                if (readyForMine(state(hit))) body.mine(hit);
            }
            return false;
        }

        private BlockHitResult floor(BlockPos cell) {
            BlockHitResult hit = body.dryRouteFloor(Vec3d.ofCenter(cell.down(), 0.95), cell.down());
            return hit != null && safeSupport(hit) ? hit : null;
        }

        private boolean clearBody(BlockPos cell) {
            return body.dryCaveSpace(Vec3d.ofCenter(cell, 0.60)) == AgentBody.DryRouteSample.CLEAR
                && body.dryCaveSpace(Vec3d.ofCenter(cell.up(), 0.62)) == AgentBody.DryRouteSample.CLEAR;
        }

        private BlockHitResult face(BlockPos cell, double height) {
            Vec3d point = Vec3d.ofCenter(cell, height);
            BlockHitResult hit = terrain(point, c.player.getBlockInteractionRange());
            return hit != null && cell.equals(hit.getBlockPos()) ? hit : null;
        }

        private BlockState wallCell(BlockPos cell, double height) {
            BlockHitResult hit = face(cell, height);
            if (hit == null) return null;
            BlockState shown = state(hit);
            return AgentNightWorksite.stableCover(c.world, cell, shown) ? shown : null;
        }

        private Wall wall(BlockPos stand, Direction side) {
            BlockPos cell = stand.offset(side);
            BlockState high = wallCell(cell.up(), 0.55);
            if (high == null) return null;
            BlockState low = wallCell(cell, 0.84);
            return low == null ? null : new Wall(cell, low, high);
        }

        private Wall flank(BlockPos stand, Direction dir) {
            Direction right = dir.rotateYClockwise(), left = dir.rotateYCounterclockwise();
            Wall witness = wall(stand, right);
            return witness != null ? witness : wall(stand, left);
        }

        /** Only rechecks already witnessed blocks; they never supply a new candidate. */
        private boolean retains(Wall wall) {
            return wall != null && c.world.getBlockState(wall.feet) == wall.low
                && c.world.getBlockState(wall.feet.up()) == wall.high;
        }

        private boolean cuttable(BlockPos cell, double height, Direction into) {
            BlockHitResult hit = face(cell, height);
            return hit != null && hit.getSide() == into.getOpposite()
                && returnableFace(cell, state(hit)) == AgentReturnableMine.Face.MINEABLE;
        }

        private boolean refuse() {
            if (foot != null) rejected = foot;
            interrupt();
            return false;
        }

        private boolean sideOre(BlockHitResult hit) {
            BlockPos block = hit.getBlockPos();
            return hit.getSide().getAxis().isHorizontal() && reachableResourceFace(block)
                && block.getY() >= c.player.getBlockY() && tools.canHarvest(state(hit))
                && !protectRecoveryBlock(block) && !supportsTrail(block)
                // Only a physics veto above a nominated visible cut, never a candidate search.
                && !(c.world.getBlockState(block.up()).getBlock() instanceof FallingBlock);
        }

        boolean guardExcavation(Resource resource) {
            BlockPos standing = c.player.getBlockPos();
            if (!guarding() || settledAt(standing)) return false;
            double reach = Math.min(REACH - 0.5, c.player.getBlockInteractionRange());
            BlockHitResult side = target != null && miningResource == resource ? perceive(targetPoint, reach) : null;
            if (side != null && side.getBlockPos().equals(target) && sideOre(side)) {
                mineTarget(resource);
                return true;
            }
            if (collectOre(resource, 2.65)) return true;
            side = body.find(resource.block, reach, localOre).orElse(null);
            if (side != null) {
                if (!side.getBlockPos().equals(target)) setTarget(side, resource);
                mineTarget(resource);
                return true;
            }
            if (!fallbackUsed) {
                fallbackUsed = true;
                fallbackUntil = tick + 100;
                origin = standing;
                navigate(Job.EXPLORE, null, 0);
                return true;
            }
            // The bounded worksite diversion is spent. Keep normal terrain exploration
            // looking for useful ground rather than repeatedly relocating a workshop.
            status = "seeking useful rock rather than opening an exposed night staircase";
            explore();
            return true;
        }
    }

    private int launchLight() {
        return goal.equals("iron_pickaxe") ? IRON_LIGHT : has(DEEP_PICK, 1) ? DEEP_LIGHT : LOCAL_LIGHT;
    }

    private static int torchBatches(int target, int held) {
        return (Math.max(0, target - held) + 3) / 4;
    }

    private boolean prepareMining(int depth) {
        if (nextFoot != null) {
            excavate(nextFoot.getY(), digGoal);
            return true;
        }
        if (continueLocalLightTimber()) return true;

        boolean departure = surfaceDeparture();
        int torches = hands.count(TORCH);
        int nextLeg = AgentMineLight.routeSteps(c.player.getBlockY(), depth);
        int needed = AgentMineLight.tripTorches(nextLeg);
        if (torches < needed && (craftTorches(needed)
            || prepareLight(needed, departure || activeTrail() <= 1))) return true;

        int deepUses = pickUses(DEEP_PICK);
        int stoneUses = pickUses(STONE_PICK);
        int remaining = deepUses + stoneUses;
        if (depth == DIAMOND_LEVEL && deepUses <= 4) {
            if (has(INGOT, 3) && affordsWood(localTableWood(), 2)) {
                requestTable("iron_pickaxe", null, 0, 2);
                return true;
            }
            if (has(RAW_IRON, 3) && (canSetLocalFurnace() || localStation(furnace, furnaceWitness))) {
                acquireIron(3, 2);
                return true;
            }
            if (workOre(Resource.IRON, torches > 1 ? SEARCH : REACH - 0.35, true)) return true;
        }

        // Break up to three blocks per stair step. Budget the next lit leg and
        // leave uses for exposed ore, but don't require an entire second kit.
        int litLeg = Math.min(nextLeg, 7 * Math.max(1, torches - 1));
        if (remaining < MIN_PICK_USES
                || depth == DIAMOND_LEVEL && deepUses <= 1 && stoneUses < MIN_PICK_USES) {
            if (has(STONE, 3)) requestTable("stone_pickaxe", null, 0, PICK_HANDLES);
            else if (depth == DIAMOND_LEVEL && deepUses <= 1
                || !workOre(Resource.STONE, REACH - 0.35, false)) seekExpeditionSupplies("a replacement pickaxe");
            return true;
        }
        if (remaining < 3 * litLeg + MIN_PICK_USES && tick >= refitPickRetry
                && has(STONE, 3) && affordsWood(localTableWood(), AgentMineLight.stoneRefitSticks(remaining))) {
            refitPickCount = hands.count(STONE_PICK);
            refitPickUntil = tick + 230;
            return refitMinedPick();
        }
        if (departure) departureKit = true;
        return false;
    }

    private boolean refitMinedPick() {
        if (refitPickCount < 0) return false;
        int sticks = AgentMineLight.stoneRefitSticks(pickUses(RETURNABLE_PICKS));
        if (hands.count(STONE_PICK) > refitPickCount || tick >= refitPickUntil || !has(STONE, 3)
                || !affordsWood(localTableWood(), sticks)) {
            refitPickCount = -1;
            refitPickRetry = tick + 150;
            return false;
        }
        requestTable("stone_pickaxe", null, 0, sticks);
        return true;
    }

    private boolean handleScreen() {
        if (c.currentScreen == null) {
            fieldBench.confirmCraft();
            return false;
        }
        if (c.currentScreen instanceof CraftingScreen screen && tableRecipe != null) {
            BlockPos used = c.player.currentScreenHandler == screen.getScreenHandler()
                ? confirmStationUse(table) : null;
            if (used == null) {
                c.currentScreen.close();
                return true;
            }
            table.openAttempts = 0;
            String recipe = tableRecipe;
            String extra = tableExtra;
            String axe = tableAxe;
            boolean fieldAxe = earlyAxe != null && earlyAxe.recipe.equals(recipe);
            boolean affordableAxe = !fieldAxe || huntingWeapon(false) < 0 && earlyAxeStock(used) == earlyAxe;
            if (fieldAxe) cancelEarlyAxe();
            tableRecipe = null;
            tableExtra = null;
            tableAxe = null;
            status = "crafting " + recipe;
            if (!affordableAxe || !affordsWood(tablePlanks, tableSticks)) {
                c.currentScreen.close();
                return true;
            }
            boolean addBoat = !fieldAxe && canAddBoat(recipe);
            List<String> recipes = woodBatch(tablePlanks + (addBoat ? 5 : 0), tableSticks);
            recipes.add(recipe);
            if (extra != null) recipes.add(extra);
            if (axe != null) recipes.add(axe);
            if (addBoat) recipes.add("boat");
            if (hands.craftBatch(recipes)) fieldBench.awaitCraft(used, recipe);
            else c.currentScreen.close();
        } else if (c.currentScreen instanceof FurnaceScreen screen && firing != Firing.NONE) {
            handleFurnace(screen);
        } else if (c.currentScreen instanceof HandledScreen<?>) {
            c.currentScreen.close();
        } else {
            status = "waiting for game view";
        }
        return true;
    }

    private boolean ownsFurnaceScreen(FurnaceScreen screen) {
        return screen != null && c.player != null && c.currentScreen == screen && furnaceScreenWorld == c.world
            && c.player.currentScreenHandler == screen.getScreenHandler() && furnaceWitness != null
            && furnaceWitness.equals(furnace.position)
            && c.player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(furnaceWitness)) <= 4.75 * 4.75;
    }

    boolean continuityMechanicalWait() {
        if (firing == Firing.NONE || !ownsFurnaceScreen(furnaceScreen) || !stallGuard.furnaceAdvancing(tick))
            return false;
        var handler = furnaceScreen.getScreenHandler();
        return handler.isBurning() && furnaceInput(handler.getSlot(0).getStack());
    }

    private void observeFurnaceCook() {
        if (!ownsFurnaceScreen(furnaceScreen)) {
            furnaceScreen = null;
            furnaceScreenWorld = null;
        } else {
            var handler = furnaceScreen.getScreenHandler();
            var input = handler.getSlot(0).getStack();
            var output = handler.getOutputSlot().getStack();
            if (firing != Firing.NONE && (input.isEmpty() || furnaceInput(input))
                    && (output.isEmpty() || output.isOf(furnaceOutput()))) {
                furnaceLoaded |= !input.isEmpty() || !output.isEmpty();
                stallGuard.furnaceState(tick, furnaceScreen, !input.isEmpty() && handler.isBurning(),
                    handler.getCookProgress(), input.getCount(), output.getCount());
                return;
            }
        }
        stallGuard.stopCooking();
    }

    private boolean furnaceInput(ItemStack stack) {
        return (firing == Firing.IRON ? RAW_IRON : BURNABLE_LOG).test(stack);
    }

    private Item furnaceOutput() { return firing == Firing.IRON ? Items.IRON_INGOT : Items.CHARCOAL; }

    private boolean needsFurnaceLight() {
        if (firing != Firing.CHARCOAL || surfaceDeparture()) return false;
        int torches = hands.count(TORCH);
        return torches < 2 && (affordsWood(localTableWood(), PICK_HANDLES + 1) || canSpareEmergencyStick(torches));
    }

    private void handleFurnace(FurnaceScreen screen) {
        if (screen != furnaceScreen) {
            BlockPos used = confirmStationUse(furnace);
            var job = localFurnace;
            var saved = pendingFurnaceMemory.current();
            if (used == null || furnaceContactFacing == null || furnaceContactFooting == null
                    || job != null && (!used.equals(job.pos) || furnaceContactFacing != job.facing || job.lost)
                    || saved != null && saved.pos().equals(used) && saved.dimension().equals(furnaceDimension())
                        && (job == null || !saved.ticket().equals(job.ticket))) {
                screen.close();
                return;
            }
            furnaceScreen = screen;
            furnaceScreenWorld = c.world;
            furnace.openAttempts = 0;
            furnaceWitness = used;
            furnaceWarmUntil = tick + 24;
            if (job != null && job.watch.active()) finishFurnaceWatch(job);
        }
        if (!ownsFurnaceScreen(screen)) {
            screen.close();
            return;
        }
        status = firing == Firing.IRON ? "smelting iron" : "making charcoal";
        var handler = screen.getScreenHandler();
        var sync = (AgentFurnaceSync) handler;
        if (!sync.agent$furnaceContentsSynced() || sync.agent$furnaceOutputUpdates() == 0) {
            if (tick >= furnaceWarmUntil) screen.close();
            return;
        }
        if (localFurnace != null && localFurnace.batch != null) {
            handlePaidFurnace(screen, localFurnace);
            return;
        }
        ItemStack input = handler.getSlot(0).getStack();
        ItemStack output = handler.getOutputSlot().getStack();
        if (!input.isEmpty() && !furnaceInput(input) || !output.isEmpty() && !output.isOf(furnaceOutput())) {
            screen.close();
            if (!declineOptionalCharcoal("the furnace contains another recipe")) {
                finishFire();
                blockStation(furnace, "the furnace contains another recipe");
            }
            return;
        }
        boolean ready = !output.isEmpty();
        furnaceLoaded |= !input.isEmpty() || ready;
        if (input.isEmpty() && !ready && (has(firing == Firing.IRON ? INGOT : FUEL, furnaceDemand)
                || firing == Firing.CHARCOAL && furnaceLoaded)) {
            finishFire();
            screen.close();
            return;
        }
        boolean urgentLight = needsFurnaceLight();
        if (!ready && (leaveFurnaceForFood() || urgentLight && has(FUEL, 1))) {
            screen.close();
            return;
        }
        boolean cooking = !input.isEmpty() && handler.isBurning();
        if (cooking && !ready) {
            if (stallGuard.furnaceAdvancing(tick) || tick < furnaceWarmUntil) {
                status = firing == Firing.IRON ? "watching iron smelt" : "watching charcoal smelt";
                return;
            }
            if (!ready) {
                finishFire();
                screen.close();
                blockStation(furnace, "the furnace cook bar stopped advancing");
                return;
            }
        }
        ItemStack fuel = handler.getSlot(1).getStack();
        if (!ready && !input.isEmpty() && !cooking && !fuel.isEmpty()
                && c.world.getFuelRegistry().getFuelTicks(fuel) > 0) {
            if (tick < furnaceWarmUntil) return;
            finishFire();
            screen.close();
            blockStation(furnace, "the supplied furnace did not ignite");
            return;
        }
        int limit = firing == Firing.CHARCOAL ? furnaceDemand
            : Math.max(1, Math.min(3, furnaceDemand - hands.count(INGOT)));
        var loading = input.isEmpty() && output.isEmpty() ? new AgentLocalSmelt.Load() : null;
        if (firing == Firing.CHARCOAL && !furnaceLoaded && loading != null) {
            // Building or reaching the workshop may have spent stock since the quote.
            // Don't let the native loader fall back to the reserved tool handles.
            int bench = fieldWood.deepFoot == null ? localTableWood() : fieldWood.portableBenchWood();
            int payable = charcoalBatch(limit, true, bench, charcoalHandleReserve);
            if (payable <= 0) {
                furnaceNeedsFuel = true;
                screen.close();
                return;
            }
            limit = payable;
        }
        if (hands.smelt(firing == Firing.CHARCOAL, limit, loading, false, ironBenchReserve(), furnaceIronSticks)) {
            if (loading != null)
                localFurnace = new LocalFurnace(furnaceWitness, furnaceContactFooting, furnaceContactFacing,
                    c.world, handler.syncId, loading);
            furnaceNeedsFuel = false;
            furnaceBlockedFuel = ItemStack.EMPTY;
            return;
        }
        String result = hands.status();
        furnaceNeedsFuel = result.equals("smelt: no fuel");
        if (furnaceNeedsFuel && firing == Firing.IRON) furnaceBlockedFuel = fuel.copy();
        if (!furnaceNeedsFuel) {
            finishFire();
            if (!result.equals("smelt: no input")) blockStation(furnace, result);
        }
        screen.close();
    }

    private int furnaceFoodRetry;

    private boolean leaveFurnaceForFood() {
        int hunger = c.player.getHungerManager().getFoodLevel();
        if (!dryFieldFooting() || tick < mealQuietUntil) return false;
        if (tick >= mealRetry && (hunger <= 14 || canRefuelHealing(hunger)) && bestMeal(hunger) >= 0) return true;
        if (tick < furnaceFoodRetry || hunger > 10 && !needsEmergencyFood(hunger)) return false;
        furnaceFoodRetry = tick + 80; // Let the ordinary forage owner try without an open/close loop.
        return true;
    }

    private void handlePaidFurnace(FurnaceScreen screen, LocalFurnace job) {
        if (job.lost) {
            screen.close();
            return;
        }
        var handler = screen.getScreenHandler();
        var input = handler.getSlot(0).getStack();
        var output = handler.getOutputSlot().getStack();
        var view = job.batch.view(true, handler.isBurning(), input, output);
        if (view == AgentLocalSmelt.View.CHANGED) {
            // The input/output packets can cross for a vanilla cooking tick.
            if (job.mismatchSince == 0) job.mismatchSince = tick;
            if (tick - job.mismatchSince < 12 || tick < furnaceWarmUntil) return;
            job.lost = true;
            if (job.ticket != null) pendingFurnaceMemory.discontinuity(tick, body.renderedFrame());
            screen.close();
            blockStation(furnace, "the paid furnace slots no longer match the original batch");
            return;
        }
        job.mismatchSince = 0;
        if (view == AgentLocalSmelt.View.READY) {
            if (leaveFurnaceForFood()) {
                screen.close();
                return;
            }
            if (job.withdrawal == null) {
                var receipt = new AgentLocalSmelt.Withdrawal();
                if (hands.collectLocalSmelt(screen, job.batch, receipt)) {
                    job.withdrawal = receipt;
                    return;
                }
            }
            if (hands.status().equals("smelt: inventory full")) {
                screen.close();
                retryLocalFurnace(job, hands.status());
            }
            return;
        }
        if (leaveFurnaceForFood()) {
            screen.close();
            return;
        }
        boolean cooking = view == AgentLocalSmelt.View.COOKING;
        boolean advancing = cooking && stallGuard.furnaceAdvancing(tick);
        float fraction = handler.getCookProgress();
        if (job.watch.canLeave(job.batch, view, advancing && fraction > 0)
                && job.footing.equals(c.player.getBlockPos()) && dryFieldFooting() && safePickupStance()
                && body.keysNeutral() && hands.closeWorkFurnaceWithEscape(screen)) {
            job.watch.leave(tick, body.renderedFrame(), input.getCount(), fraction);
            body.pauseWork();
            status = "leaving the paid furnace to watch the workshop";
            if (job.ticket != null) pendingFurnaceMemory.park(job.ticket, tick, body.renderedFrame());
            return;
        }
        if (needsFurnaceLight() && torchCraftBatches(LOCAL_LIGHT) > 0) {
            screen.close();
            return;
        }
        if (cooking) {
            if (advancing || tick < furnaceWarmUntil) {
                status = firing == Firing.IRON ? "watching iron smelt" : "watching charcoal smelt";
            } else {
                screen.close();
                retryLocalFurnace(job, "the paid furnace cook bar stopped advancing");
            }
            return;
        }
        if (tick < furnaceWarmUntil) return;
        // A paid batch can be refueled, never topped up with fresh input while outstanding.
        int refuelLimit = firing == Firing.CHARCOAL ? input.getCount() : Math.min(3, input.getCount());
        if (hands.smelt(firing == Firing.CHARCOAL, refuelLimit, null, true,
                ironBenchReserve(), furnaceIronSticks)) {
            furnaceWarmUntil = tick + 40;
            furnaceNeedsFuel = false;
            furnaceBlockedFuel = ItemStack.EMPTY;
            return;
        }
        furnaceNeedsFuel = hands.status().equals("smelt: no fuel");
        if (furnaceNeedsFuel && firing == Firing.IRON) furnaceBlockedFuel = handler.getSlot(1).getStack().copy();
        screen.close();
        if (!furnaceNeedsFuel) retryLocalFurnace(job, hands.status());
    }

    private String furnaceDimension() { return c.world.getRegistryKey().getValue().toString(); }

    /** Only a vanilla accepted use edge can tie a new handler to this furnace. */
    void confirmLocalFurnaceUse(net.minecraft.client.network.ClientPlayerEntity actor, BlockHitResult hit) {
        if (actor != c.player || firing == Firing.NONE || furnace.lastUse == null
                || !furnace.lastUse.equals(hit.getBlockPos()) || tick - furnace.opened > 2) return;
        BlockState block = state(hit);
        if (!block.isOf(Blocks.FURNACE)) return;
        furnaceContactFacing = block.get(net.minecraft.block.AbstractFurnaceBlock.FACING);
        furnaceContactFooting = actor.getBlockPos();
    }

    void observeLocalFurnaceBlock(ClientWorld world, BlockPos pos, BlockState state) {
        var job = localFurnace;
        if (job == null || job.lost || job.world != world || !job.pos.equals(pos)
                || state.isOf(Blocks.FURNACE)
                    && state.get(net.minecraft.block.AbstractFurnaceBlock.FACING) == job.facing) return;
        job.lost = true;
    }

    private void restoreLocalFurnace() {
        if (checkedSavedFurnace) return;
        checkedSavedFurnace = true;
        var saved = pendingFurnaceMemory.current();
        if (saved == null || !saved.mayInvestigateCollection() || saved.ordinaryBatch() == null
                || !saved.dimension().equals(furnaceDimension())
                || !AgentClient.ownsSinglePlayerFurnaceWorld(c, c.player)) return;
        var job = new LocalFurnace(saved.pos(), saved.footing(), saved.facing(), c.world, saved.syncId(), null);
        job.batch = saved.ordinaryBatch();
        job.ticket = saved.ticket();
        if (saved.state() == AgentPendingFurnaceMemory.State.PARKED) job.watch.reopen();
        if (saved.breadcrumbs() != null) {
            job.restoredRoute = new AgentWalkedRoute();
            job.restoredRoute.restore(saved.breadcrumbs());
        }
        localFurnace = job;
        firing = job.batch.raw() == Items.RAW_IRON ? Firing.IRON : Firing.CHARCOAL;
        if (firing == Firing.IRON && !has(DEEP_PICK, 1)) {
            furnaceIronSticks = 2;
            furnaceIronPlanks = ironTableWood();
        }
        furnace.position = furnaceWitness = job.pos;
        furnaceLoaded = true;
        furnaceDemand = (firing == Firing.IRON ? hands.count(INGOT) : 0) + job.batch.units();
    }

    private void observeLocalFurnaceTransfers() {
        if (localFurnace != null && !hands.busy())
            settleLocalFurnace(localFurnace.batch == null && AgentClient.ownsSinglePlayerFurnaceWorld(c, c.player));
    }

    private void settleLocalFurnace(boolean persist) {
        var job = localFurnace;
        if (job == null) return;
        if (job.batch == null) {
            if (job.loading.units == 0) {
                localFurnace = null;
                return;
            }
            int minimumOutput = 0;
            if (ownsFurnaceScreen(furnaceScreen)) {
                ItemStack output = furnaceScreen.getScreenHandler().getOutputSlot().getStack();
                if (output.isOf(AgentLocalSmelt.result(job.loading.raw)) && output.getCount() <= job.loading.units)
                    minimumOutput = output.getCount();
            }
            job.batch = new AgentLocalSmelt.Batch(job.loading.raw, job.loading.units, minimumOutput);
            furnaceLoaded = true;
            furnaceWarmUntil = tick + 24;
            if (persist && !job.lost && job.world == c.world) {
                var ticket = java.util.UUID.randomUUID();
                if (pendingFurnaceMemory.payOrdinary(ticket, furnaceDimension(), job.pos, job.facing, job.footing,
                        job.batch, job.syncId, tick, body.renderedFrame())) job.ticket = ticket;
            }
        }
        var receipt = job.withdrawal;
        if (receipt != null && receipt.hasStoredResult()) {
            if (job.ticket != null)
                pendingFurnaceMemory.end(job.ticket, AgentPendingFurnaceMemory.State.COLLECTED, tick, body.renderedFrame());
            if (ownsFurnaceScreen(furnaceScreen)) furnaceScreen.close();
            localFurnace = null;
            finishFire();
            return;
        }
        if (receipt != null && receipt.wasTaken()) {
            job.lost = true;
            if (job.ticket != null) pendingFurnaceMemory.discontinuity(tick, body.renderedFrame());
        }
        job.withdrawal = null;
        if (job.ticket != null) {
            var saved = pendingFurnaceMemory.current();
            if (job.lost) pendingFurnaceMemory.discontinuity(tick, body.renderedFrame());
            else if (saved == null || !saved.mayInvestigateCollection()) job.lost = true;
        }
    }

    AgentWalkedRoute.Breadcrumbs closeLocalFurnaceForStop(boolean persist) {
        settleLocalFurnace(persist);
        var job = localFurnace;
        if (ownsFurnaceScreen(furnaceScreen)) interruptHands();
        if (!persist || job == null || job.ticket == null || job.lost
                || !dryFieldFooting() || !hands.stableCraftFooting()) return null;
        BlockPos foot = c.player.getBlockPos();
        if (job.sideReturn != null && foot.equals(job.sideReturn.lower())) {
            BlockPos anchor = job.footing;
            return new AgentWalkedRoute.Breadcrumbs(new int[] {anchor.getX(), anchor.getY(), anchor.getZ()},
                new int[][] {{foot.getX(), foot.getY(), foot.getZ(), anchor.getX(), anchor.getY(), anchor.getZ()}});
        }
        if (job.restoredRoute != null) {
            var restored = job.restoredRoute.breadcrumbs(foot.asLong());
            if (restored != null) return restored;
        }
        int from = trail.lastIndexOf(foot), to = trail.lastIndexOf(job.footing);
        if (from < 0 || to < 0 || from == to || Math.abs(from - to) > AgentWalkedRoute.SAVED_EDGES) return null;
        int direction = Integer.signum(to - from);
        var route = new AgentWalkedRoute();
        route.anchor(job.footing.asLong());
        for (int i = from; i != to; i += direction)
            route.landed(trail.get(i).asLong(), trail.get(i + direction).asLong());
        return route.breadcrumbs(foot.asLong());
    }

    private FurnaceSide furnaceOpportunity(LocalFurnace job) {
        if (!hands.stableCraftFooting() || !job.footing.equals(c.player.getBlockPos())) return null;
        if (untried(job, FurnaceSide.TORCHES) && torchCraftBatches(LOCAL_LIGHT) > 0) return FurnaceSide.TORCHES;
        if (untried(job, FurnaceSide.LIGHT) && trail.size() - litIndex >= 7 && has(TORCH, 3)
                && c.world.getLightLevel(c.player.getBlockPos()) <= 8) return FurnaceSide.LIGHT;
        if (untried(job, FurnaceSide.STICKS) && firing == Firing.IRON && furnaceIronSticks > 0
                && !has(STICK, 2) && has(PLANK, 2)) return FurnaceSide.STICKS;
        if (untried(job, FurnaceSide.PICK) && firing == Firing.CHARCOAL && !has(DEEP_PICK, 1)
                && localStation(table, null) && has(STONE, 3)) {
            int stoneUses = pickUses(STONE_PICK);
            if (stoneUses > 0 && stoneUses < 12 && affordsWood(0, AgentMineLight.stoneRefitSticks(stoneUses)))
                return FurnaceSide.PICK;
        }
        return null;
    }

    private static boolean untried(LocalFurnace job, FurnaceSide side) {
        return (job.triedSide & (1 << side.ordinal())) == 0;
    }

    private boolean stepLocalFurnaceWatch() {
        var job = localFurnace;
        if (job == null || !job.watch.active()) return false;
        if (job.lost || job.world != c.world || job.watch.recheckExpired(tick)) {
            finishFurnaceWatch(job);
            return false;
        }
        if (!safePickupStance() || !body.hasRecentView() || !job.watch.seesWorld(body.renderedFrame())) return true;

        if (job.sideTread != null) return stepFurnacePickupTread(job);
        if (job.sideDrop != null) {
            if (tick < job.sidePickupUntil && !job.watch.recheckDue(tick)) {
                body.pauseWork();
                status = "checking for the workshop drop in inventory";
                return true;
            }
            clearFurnacePickup(job);
        }
        BlockPos foot = c.player.getBlockPos();
        if (!job.sideReturnStarted && job.sideReturn != null && foot.equals(job.sideReturn.lower())) {
            job.sideReturnStarted = true;
            job.sideTread = AgentSurfaceTread.ordinaryStock(job.sideReturn, foot, tick);
            return stepFurnacePickupTread(job);
        }
        if (job.watch.recheckDue(tick) || !job.footing.equals(foot)) {
            clearFurnaceChore(job);
            status = "checking the paid furnace";
            if (!returnToLocalFurnace(job)) finishFurnaceWatch(job);
            return true;
        }
        if (job.watch.sideTime(tick) && dryFieldFooting()) {
            if (job.side == null && job.watch.canTargetPickup() && tick >= job.sideLookAt
                    && hands.stableCraftFooting() && selectFurnacePickup(job)) return true;
            if (stepLocalFurnaceChore(job)) return true;
        }
        clearFurnaceChore(job);
        body.pauseWork();
        status = "watching the workshop before checking the paid furnace";
        return true;
    }

    private boolean selectFurnacePickup(LocalFurnace job) {
        job.sideLookAt = tick + 6;
        boolean wood = needsTimberKit() && hands.count(PLANK) + 4 * hands.count(LOG) < localTableWood() + 12;
        boolean fuel = hands.count(FUEL) < torchBatches(launchLight(), hands.count(TORCH));
        boolean food = macroFoodRelevant();
        if (!wood && !fuel && !food) return false;
        var drop = body.dropped(stack -> wood && (LOG.test(stack) || PLANK.test(stack))
            || fuel && FUEL.test(stack) || food && FOOD.test(stack), 3.5).orElse(null);
        if (drop == null) return false;

        var bounds = drop.getBoundingBox();
        var player = c.player.getBoundingBox();
        var stock = drop.getStack();
        if (!hasFurnacePickupRoom(stock)) return false;
        if (!AgentPickup.passiveOverlap(player, bounds)) {
            if (!job.watch.mayStepOut(tick) || !drop.isOnGround()) return false;
            var edge = AgentPickup.selectDryAccess(player, bounds, job.footing, false, (to, bearing) -> {
                if (to.getY() != job.footing.getY()) return null;
                var tread = body.witnessedOrdinaryTread(job.footing, to, bearing);
                return tread != null && body.pickupTreadClear(tread, drop, stock, AgentPickup.Scope.EXACT_ENTITY, null)
                    ? tread : null;
            });
            if (edge == null) return false;
            job.sideTread = AgentSurfaceTread.ordinaryStock(edge, job.footing, tick);
        }
        job.sideDrop = drop;
        job.sideDropItem = stock.getItem();
        job.sideDropFood = FOOD.test(stock);
        job.sidePickupUntil = tick + 24;
        job.watch.targetPickup(AgentWorkOrder.count(c.player.getInventory(), job.sideDropItem));
        body.pauseWork();
        status = "checking a visible workshop drop";
        return true;
    }

    private boolean hasFurnacePickupRoom(ItemStack stock) {
        var inventory = c.player.getInventory();
        int empty = 0, remaining = stock.getCount();
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot) {
            ItemStack stack = inventory.getStack(slot);
            if (stack.isEmpty()) empty++;
            else if (ItemStack.areItemsAndComponentsEqual(stack, stock))
                remaining -= stack.getMaxCount() - stack.getCount();
            // Leave an empty slot for the paid output even after picking up the whole drop.
            if (empty >= 2 || empty == 1 && remaining <= 0) return true;
        }
        return false;
    }

    private boolean seenFurnaceDrop(LocalFurnace job) {
        return job.sideDrop != null && body.seesDrop(job.sideDrop, 3.5)
            && job.sideDrop.getStack().isOf(job.sideDropItem);
    }

    private boolean stepFurnacePickupTread(LocalFurnace job) {
        var tread = job.sideTread;
        body.pauseWork();
        if (!tread.returning && !tread.inFlight()
                && (tick >= job.sidePickupUntil || !job.watch.mayStepOut(tick) || !seenFurnaceDrop(job)
                    || !overlapsFrom(tread.to, job.sideDrop.getBoundingBox()))) {
            job.sideTread = null;
            return true;
        }
        status = tread.returning ? "returning along the dry workshop tread" : "approaching a visible workshop drop";
        switch (tread.step(c, body, tick)) {
            case CHECKING -> { }
            case MOVING -> rememberMotion();
            case LANDED -> {
                body.recordWalkedLeg(tread.from, tread.to);
                job.sideTread = null;
                if (!tread.returning) {
                    job.sideReturn = tread.edge;
                    job.sidePickupUntil = tick + 8;
                }
            }
            case REFUSED -> {
                job.sideTread = null;
                job.sidePickupUntil = Math.min(job.sidePickupUntil, tick + 4);
            }
        }
        return true;
    }

    private void observeLocalFurnacePickup() {
        var job = localFurnace;
        if (job == null || job.sideDrop == null) return;
        if (job.lost || job.world != c.world) {
            clearFurnacePickup(job);
            return;
        }
        int gained = job.watch.observePickup(AgentWorkOrder.count(c.player.getInventory(), job.sideDropItem));
        if (gained == 0) return;
        body.visibleHorizon().reportPickupUnseen(job.sideDrop, "inventory_gain");
        if (job.sideDropFood && forage == null) foodPickedUp += gained;
        clearFurnacePickup(job);
    }

    private static void clearFurnacePickup(LocalFurnace job) {
        job.watch.abandonPickup();
        job.sideDrop = null;
        job.sideDropItem = null;
    }

    private boolean stepLocalFurnaceChore(LocalFurnace job) {
        if (job.side == null) {
            job.side = furnaceOpportunity(job);
            if (job.side == null) return false;
            job.triedSide |= 1 << job.side.ordinal();
        }
        if (job.footing.equals(c.player.getBlockPos())) {
            switch (job.side) {
                case TORCHES -> {
                    if (craftTorches(LOCAL_LIGHT)) { job.side = null; return true; }
                }
                case LIGHT -> {
                    if (shouldLight(false)) { status = "lighting the workshop passage"; return true; }
                }
                case STICKS -> {
                    if (!has(STICK, 2) && hands.craft("stick")) {
                        status = "making sticks for the next iron tool";
                        job.side = null;
                        return true;
                    }
                }
                case PICK -> {
                    int stoneUses = pickUses(STONE_PICK);
                    int sticks = AgentMineLight.stoneRefitSticks(stoneUses);
                    if (stoneUses < 12 && affordsWood(0, sticks) && hands.stableCraftFooting()) {
                        BlockHitResult bench = body.find(TABLE_BLOCK, 3.75, hit -> hit.getBlockPos().equals(table.position)).orElse(null);
                        if (bench != null) {
                            if (fieldBench.packUntil != 0) fieldBench.leave();
                            tableRecipe = "stone_pickaxe";
                            tableExtra = tableAxe = null;
                            tablePlanks = 0;
                            tableSticks = sticks;
                            openStation(table, bench, AgentBody.Contact.INTERACT);
                            return true;
                        }
                    }
                }
            }
        }
        clearFurnaceChore(job);
        return false;
    }

    private void clearFurnaceChore(LocalFurnace job) {
        if (job.side == FurnaceSide.PICK && "stone_pickaxe".equals(tableRecipe)) tableRecipe = null;
        job.side = null;
    }

    private void finishFurnaceWatch(LocalFurnace job) {
        job.watch.reopen();
        clearFurnaceChore(job);
        clearFurnacePickup(job);
        job.sideTread = null;
    }

    private void retryLocalFurnace(LocalFurnace job, String reason) {
        job.retryAt = tick + 30;
        status = reason;
    }

    private boolean returnToLocalFurnace(LocalFurnace job) {
        if (job.lost || job.world != c.world) {
            status = "the paid furnace can no longer be verified";
            return false;
        }
        if (tick < job.retryAt || c.player.isTouchingWater() || c.player.isInLava()
                || job.routeTo == null && !dryFieldFooting()) return true;
        if (furnaceNeedsFuel) {
            status = "preparing fuel for the paid furnace";
            if (firing == Firing.IRON) {
                var plan = hands.ordinaryIronPlan(1, ironBenchReserve(), furnaceIronSticks, furnaceBlockedFuel, true);
                if (plan == null) {
                    retryLocalFurnace(job, "the paid furnace needs usable fuel");
                    return true;
                }
                if (prepareIronStock(plan)) return true;
                furnaceNeedsFuel = false;
            } else {
                if (hands.stableCraftFooting() && hands.prepareSmeltFuel(false)) furnaceNeedsFuel = false;
                else retryLocalFurnace(job, "the paid furnace needs usable fuel");
                return true;
            }
        }
        furnace.position = furnaceWitness = job.pos;
        Vec3d center = Vec3d.ofCenter(job.pos);
        if (c.player.getEyePos().squaredDistanceTo(center) <= REACH * REACH) {
            BlockHitResult face = body.find(FURNACE_BLOCK, REACH, hit -> job.pos.equals(hit.getBlockPos())
                && state(hit).get(net.minecraft.block.AbstractFurnaceBlock.FACING) == job.facing).orElse(null);
            if (face != null && hands.stableCraftFooting()) {
                status = "opening the paid furnace";
                job.routeFrom = job.routeTo = null;
                openStation(furnace, face, AgentBody.Contact.INTERACT);
                return localBlockStation != furnace;
            }
            if (job.footing.equals(c.player.getBlockPos())
                    && openOutlinedStation(furnace, center)) return localBlockStation != furnace;
        }
        if (job.routeTo != null && arrived(job.routeTo)) job.routeFrom = job.routeTo = null;
        if (job.routeTo != null && dryFieldFooting() && !job.routeFrom.equals(c.player.getBlockPos())) {
            job.routeFrom = job.routeTo = null;
            gaitStep = null;
        }
        if (job.routeTo == null && hands.stableCraftFooting()) {
            BlockPos foot = c.player.getBlockPos();
            // Do not replace the exact stock tread's refused reversal with a weaker generic gait.
            if (job.sideReturn == null || !foot.equals(job.sideReturn.lower())) {
                int from = trail.lastIndexOf(foot), to = trail.lastIndexOf(job.footing);
                if (from >= 0 && to >= 0 && from != to) {
                    for (int i = from, step = Integer.signum(to - from); i != to; i += step)
                        if (!adjacent(trail.get(i), trail.get(i + step))) { to = -1; break; }
                    if (to >= 0) job.routeTo = trail.get(from + Integer.signum(to - from));
                }
                if (job.routeTo == null && job.restoredRoute != null) {
                    long next = job.restoredRoute.next(foot.asLong());
                    if (next != AgentRouteGraph.NO_CELL) job.routeTo = BlockPos.fromLong(next);
                }
            }
            job.routeFrom = foot;
        }
        if (job.routeTo != null) {
            status = "returning to the paid furnace on walked footing";
            if (driveKnownStep(job.routeFrom, job.routeTo) != Walk.BLOCKED) return true;
            job.routeFrom = job.routeTo = null;
            gaitStep = null;
            retryLocalFurnace(job, "the walked step back to the paid furnace is blocked");
            return false;
        } else if (hands.stableCraftFooting()) {
            if (c.player.getEyePos().squaredDistanceTo(center) <= REACH * REACH) {
                if (!body.aligned(center)) body.aim(center);
                status = "looking at the witnessed paid furnace";
            } else {
                status = "no witnessed return route to the paid furnace";
                return false;
            }
        }
        return true;
    }

    private boolean canAddBoat(String recipe) {
        if (firing != Firing.NONE || recipe.equals("boat") || !needsTimberKit() || has(BOAT, 1)) return false;
        int torches = hands.count(TORCH);
        if (torches < LOCAL_LIGHT) return false;

        // Carry real light first. Keep a reload, a field table and a pick handle
        // after the workshop's requested crafts and the optional five planks.
        int reserve = surfaceDeparture() ? Math.max(launchLight(), 2 * LOCAL_LIGHT) : 2 * LOCAL_LIGHT;
        int torchRecipes = torchBatches(reserve, torches);
        int charcoal = Math.max(0, torchRecipes - hands.count(FUEL));
        int tableWood = has(table.item, 1) ? 0 : 4;
        int plankCost = tablePlanks + 5 + tableWood + furnacePlanks(charcoal);
        int logsForPlanks = logBatches(plankCost, stickBatches(tableSticks + torchRecipes + PICK_HANDLES));
        return (charcoal == 0 || has(BURNABLE_LOG, charcoal))
            && has(LOG, logsForPlanks + charcoal) && hands.singleBoatWoodStock();
    }

    enum PickExtras {
        NONE(false, false), SHOVEL(true, false), AXE(false, true), BOTH(true, true);
        final boolean shovel, axe;
        PickExtras(boolean shovel, boolean axe) { this.shovel = shovel; this.axe = axe; }

        // Remaining wood excludes the pick head and any bench that still has to be made.
        static PickExtras choose(boolean wooden, int headMaterial, int remainingWood, int sticks,
                                boolean wantShovel, boolean wantAxe) {
            boolean shovel = wantShovel && headMaterial >= 1
                && remainingWood >= (wooden ? 1 : 0) + 2 * Math.ceilDiv(Math.max(0, 4 - sticks), 4);
            int heads = 3 + (shovel ? 1 : 0);
            int handles = 4 + (shovel ? 2 : 0);
            boolean axe = wantAxe && headMaterial >= heads
                && remainingWood >= (wooden ? heads : 0) + 2 * Math.ceilDiv(Math.max(0, handles - sticks), 4);
            return shovel ? (axe ? BOTH : SHOVEL) : (axe ? AXE : NONE);
        }
    }

    private void makePick(String recipe, Predicate<ItemStack> ingredient, int quantity) {
        int plankCost = ingredient == PLANK ? quantity : 0;
        if (ingredient != PLANK && !has(ingredient, quantity)) return;
        String extra = null;
        String axe = null;
        int sticks = 2;
        boolean wooden = ingredient == PLANK;
        if (wooden || ingredient == STONE) {
            int wood = hands.count(PLANK) + 4 * hands.count(LOG) - plankCost - localTableWood();
            var extras = PickExtras.choose(wooden, wooden ? wood : hands.count(STONE) - quantity, wood, hands.count(STICK),
                !goal.equals("wooden_pickaxe") && (wooden || !goal.equals("stone_pickaxe")) && !has(SHOVEL, 1),
                !ordinaryCaveDrops && needsTimberKit() && !timberReady && !has(AXE, 1));
            if (extras.shovel) { extra = wooden ? "wooden_shovel" : "stone_shovel"; if (wooden) plankCost++; sticks += 2; }
            if (extras.axe) { axe = wooden ? "wooden_axe" : "stone_axe"; if (wooden) plankCost += 3; sticks += 2; }
        }
        requestTable(recipe, extra, axe, plankCost, sticks);
    }

    private boolean needsTimberKit() {
        return !goal.equals("wooden_pickaxe") && !goal.equals("stone_pickaxe");
    }

    /** Prefer work the current kit can finish; make at most one short workshop detour. */
    private final class PortalSupplies {
        private static final int RETURN_STEPS = 12;
        private final BlockPos[] triedStoneBanks = new BlockPos[3];
        private boolean returning, tripUsed, smelting;
        private int retryAt, resupplyUntil, stoneBanks, stoneProbe, stoneUntil, shoreLookUntil;
        private BlockPos stoneBank;
        private Vec3d stoneLavaPoint;
        private BlockHitResult stoneWater;

        /** Choose casting before committing the same iron to a mining pick, only at a witnessed bank. */
        private boolean stepAtStoneShore() {
            if (stoneBank != null) {
                if (tick >= stoneUntil || !dryFieldFooting() || !has(STONE_PICK, 1)
                    || c.player.getBlockY() != stoneBank.getY()
                    || c.player.getBlockPos().getSquaredDistance(stoneBank) > 9) {
                    leaveStoneShore();
                    return false;
                }
                if (firing != Firing.NONE) {
                    fire(firing, furnaceDemand);
                    return true;
                }
                if (step(true)) return true;
                if (!has(PORTAL_BUCKET, 1)) {
                    leaveStoneShore();
                    return false;
                }
                if (has(EMPTY_BUCKET, 1)) {
                    if (stoneWater != null && fieldWater == null && tick >= waterRetry)
                        rememberFieldWater(stoneWater);
                    stoneWater = null;
                    if (fillFieldBucket()) return true;
                }
                if (shoreLookUntil == 0) shoreLookUntil = tick + 32;
                if (tick < shoreLookUntil) {
                    status = "looking back to the witnessed lava bank with casting supplies";
                    body.aim(stoneLavaPoint);
                    return true;
                }
                leaveStoneShore();
                return false;
            }
            if (tick < retryAt || tick < stoneProbe || stoneBanks >= triedStoneBanks.length
                || firing != Firing.NONE || nextFoot != null || !hands.stableCraftFooting()
                || !has(STONE_PICK, 1) || has(DEEP_PICK, 1)) return false;
            stoneProbe = tick + 8;
            boolean bucket = has(PORTAL_BUCKET, 1);
            boolean ignition = has(IGNITER, 1);
            int reserve = (bucket ? 0 : 3) + (ignition ? 0 : 1);
            int ingots = hands.count(INGOT);
            if (reserve == 0 || ingots + hands.count(RAW_IRON) < reserve) return false;
            BlockPos feet = c.player.getBlockPos();
            for (int i = 0; i < stoneBanks; i++) {
                if (feet.getSquaredDistance(triedStoneBanks[i]) <= 6 * 6) return false;
            }
            BlockHitResult lava = visibleCastLava();
            if (lava == null) return false;
            boolean looseFlint = has(FLINT, 1);
            boolean carriedWater = has(WATER_BUCKET, 1);
            BlockHitResult water = carriedWater ? null : body.visibleFluid(false, true, REACH - 0.25);
            if (water != null && !isWaterSource(water)) water = null;
            boolean knownWater = carriedWater || water != null;
            if (!knownWater && (!(ignition || looseFlint) || !visibleLavaNeighbor(lava))) return false;
            if (!ignition && !looseFlint && !has(GRAVEL, 1) && body.find(GRAVEL_BLOCK, REACH - 0.25).isEmpty())
                return false;
            stoneBank = feet;
            if (!step(true)) {
                leaveStoneShore();
                return false;
            }
            triedStoneBanks[stoneBanks++] = feet;
            stoneLavaPoint = inward(lava);
            stoneWater = water;
            stoneUntil = tick + 1_400;
            shoreLookUntil = 0;
            return true;
        }

        private boolean visibleLavaNeighbor(BlockHitResult lava) {
            for (Direction direction : Direction.Type.HORIZONTAL) {
                Vec3d point = lava.getPos().add(direction.getOffsetX(), -0.025, direction.getOffsetZ());
                BlockHitResult hit = perceive(point, REACH);
                if (hit != null && hit.getSide() == Direction.UP
                    && hit.getBlockPos().equals(lava.getBlockPos().offset(direction)) && isStillLava(hit)) return true;
            }
            return false;
        }

        private boolean step(boolean shoreOnly) {
            if (tick < retryAt || nextFoot != null || !hands.stableCraftFooting() || !dryFieldFooting()) return false;
            int ingots = hands.count(INGOT);
            int raw = hands.count(RAW_IRON);
            int bucketCost = has(PORTAL_BUCKET, 1) ? 0 : 3;
            int reserve = bucketCost + (has(IGNITER, 1) ? 0 : 1);
            if (reserve == 0) {
                returning = false;
                return false;
            }
            boolean makeBucket = bucketCost != 0 && ingots >= bucketCost;
            boolean smeltIron = ingots < reserve && raw > 0 && ingots + raw >= Math.max(1, bucketCost);
            if (makeBucket || smeltIron) {
                int batch = Math.min(raw, reserve - ingots);
                boolean carriedBench = has(table.item, 1);
                boolean canMakeBench = affordsWood(4, 0);
                boolean localBench = !carriedBench && visibleOrRemembered(table);
                boolean benchReady = carriedBench || canMakeBench || localBench;
                if (makeBucket && benchReady) {
                    returning = false;
                    requestTable("bucket", null, 0, 0);
                    return true;
                }
                if (smeltIron && (!shoreOnly || bucketCost == 0 || benchReady)) {
                    boolean usableFurnace = has(furnace.item, 1) || visibleOrRemembered(furnace);
                    int benchWood = (bucketCost == 0 && usableFurnace) || carriedBench || localBench ? 0 : 4;
                    var plan = ownedIronPlan(batch, benchWood, 0);
                    if (plan != null && (usableFurnace || has(STONE, 8) && benchReady)) {
                        returning = false;
                        if (prepareIronStock(plan)) return true;
                        smelting = true;
                        startIron(ingots + batch, benchWood, 0);
                        return true;
                    }
                }
                if (shoreOnly) return false;
                if (returning && resumeIndex > 0) {
                    if (resupplyUntil == 0) resupplyUntil = tick + 120;
                    if (tick < resupplyUntil && fieldWood.step(0, true)) return true;
                    returning = false;
                }
                if (!tripUsed && returnForWorkshop(makeBucket, smeltIron && ownedIronPlan(batch, 0, 0) != null))
                    return true;
            }
            returning = false;
            if (ingots > bucketCost && reserve > bucketCost && has(FLINT, 1)) {
                status = "crafting flint and steel with the spare portal ingot";
                return hands.craft("flint_and_steel");
            }
            // Take a genuinely exposed piece on the way, but don't start a spare-iron branch mine.
            return !shoreOnly && ingots + raw < reserve && workOre(Resource.IRON, REACH, false);
        }

        private boolean visibleOrRemembered(Station station) {
            if (localStation(station, null)) return true;
            BlockHitResult sight = body.find(station == table ? TABLE_BLOCK : FURNACE_BLOCK, 3.75).orElse(null);
            if (sight != null) {
                station.position = confirmStation(station, sight);
                station.approachUntil = station.openAttempts = 0;
                if (station == furnace) furnaceWitness = station.position;
                return true;
            }
            // The interaction path still has to sight the remembered block before using it.
            return localHint(station);
        }

        private boolean localHint(Station station) {
            BlockPos hint = memory.station(c.world, station == furnace);
            return hint != null && c.player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(hint)) <= 3.75 * 3.75;
        }

        private boolean returnForWorkshop(boolean makeBucket, boolean fuel) {
            int last = trail.size() - 1;
            if (resumeIndex >= 0 || last <= 0 || !arrived(trail.getLast()) || !has(TORCH, 2))
                return false;
            BlockPos workshop = makeBucket || fuel && has(STONE, 8) ? memory.station(c.world, false) : null;
            int waypoint = workshop == null ? -1 : stationWaypoint(workshop);
            if (!makeBucket && fuel) {
                BlockPos stove = memory.station(c.world, true);
                if (stove != null) waypoint = Math.max(waypoint, stationWaypoint(stove));
            }
            if (waypoint < 0 && last <= RETURN_STEPS && (makeBucket || fuel && has(STONE, 8))
                && !has(table.item, 1) && !affordsWood(4, 0)
                && has(AXE, 1) && fieldWood.harvestFoot != null
                && fieldWood.harvestFoot.getSquaredDistance(trail.getFirst()) <= 36) {
                waypoint = 0;
            }
            if (waypoint < 0 || last - waypoint > RETURN_STEPS) return false;
            for (int i = waypoint + 1; i <= last; ++i) {
                if (!adjacent(trail.get(i - 1), trail.get(i))) return false;
            }
            if (!startReturn(waypoint, true)) return false;
            tripUsed = returning = true;
            status = "returning along walked steps to look for portal workshop supplies";
            return true;
        }

        private boolean needsPortableBench() {
            return !has(PORTAL_BUCKET, 1) && !has(table.item, 1)
                && hands.count(INGOT) + hands.count(RAW_IRON) >= 2;
        }

        private void leaveStoneShore() {
            stoneBank = null;
            stoneWater = null;
        }

        private void interrupt() {
            returning = false;
            leaveStoneShore();
            retryAt = tick + 150;
            if (smelting && !furnaceLoaded) finishFire();
        }
    }

    private boolean prepareFieldBucket() {
        if (!has(PORTAL_BUCKET, 1)) {
            if (!has(INGOT, 3) || nextFoot != null || firing != Firing.NONE) return false;
            requestTable("bucket", null, 0, 0);
            return true;
        }
        return fillFieldBucket();
    }

    private boolean fillFieldBucket() {
        if (has(WATER_BUCKET, 1) || !has(EMPTY_BUCKET, 1)) {
            fieldWater = null;
            return false;
        }
        if (tick < waterRetry || !dryFieldFooting()) return false;
        if (fieldWater == null) {
            BlockHitResult hit = body.visibleFluid(false, true, REACH - 0.25);
            if (hit == null || !isWaterSource(hit)) return false;
            rememberFieldWater(hit);
        }
        if (tick > fieldWaterUntil
            || c.player.getEyePos().squaredDistanceTo(fieldWater.getPos()) > REACH * REACH) {
            fieldWater = null;
            waterRetry = tick + 100;
            return false;
        }
        status = "filling the field bucket from visible water";
        BlockPos source = fieldWater.getBlockPos();
        body.aimFine(fieldWaterPoint);
        AgentBody.Preparation readiness = fieldWaterUsed != 0 && tick - fieldWaterUsed < 7
            ? AgentBody.Preparation.RECEIPT : AgentBody.Preparation.equipment(hands.equipForUse(EMPTY_BUCKET));
        BlockHitResult current = perceive(fieldWaterPoint, REACH);
        if (current != null) {
            if (source.equals(current.getBlockPos()) && isWaterSource(current)) {
                if (body.useWaterSource(source, fieldWaterPoint, readiness)) fieldWaterUsed = tick;
            } else if (readiness != AgentBody.Preparation.RECEIPT && body.aligned(fieldWaterPoint)) {
                fieldWater = null;
                waterRetry = tick + 100;
                return false;
            }
        }
        return true;
    }

    private void rememberFieldWater(BlockHitResult hit) {
        fieldWater = hit;
        fieldWaterPoint = inward(hit);
        fieldWaterUntil = tick + 48;
        fieldWaterUsed = 0;
    }

    private BlockHitResult visibleCastLava() {
        BlockPos feet = c.player.getBlockPos();
        if (!World.OVERWORLD.equals(c.world.getRegistryKey()) || !dryFieldFooting()
            || Math.abs(c.player.getY() - feet.getY()) > 0.06) return null;
        BlockHitResult hit = body.visibleFluid(true, true, REACH);
        return hit != null && hit.getSide() == Direction.UP && hit.getBlockPos().getY() == feet.getY() - 1
            && isStillLava(hit) ? hit : null;
    }

    private boolean isStillLava(BlockHitResult hit) {
        var fluid = state(hit).getFluidState();
        return fluid.isStill() && fluid.isIn(FluidTags.LAVA);
    }

    private boolean isWaterSource(BlockHitResult hit) {
        BlockState block = state(hit);
        return block.isOf(Blocks.WATER) && block.getFluidState().isStill();
    }

    private boolean dryFieldFooting() {
        return c.player.isOnGround() && !c.player.isTouchingWater() && !c.player.isInLava();
    }

    private static Vec3d inward(BlockHitResult hit) {
        return hit.getPos().lerp(Vec3d.ofCenter(hit.getBlockPos()), 0.03);
    }

    /** A short supply diversion at a currently seen lava bank, not a separate gravel expedition. */
    private final class FieldIgnition {
        private static final int GRAVEL_LIMIT = 12;
        private static final int BANK_LIMIT = 3;
        private final BlockPos[] checkedBanks = new BlockPos[BANK_LIMIT];
        private final Predicate<BlockHitResult> gravelCandidate = this::safeGravel;
        private BlockPos bank, gravelBlock, rejectedGravel;
        private Vec3d poolPoint, gravelPoint;
        private AgentPortal.Place placement;
        private int bankCount, gravelAttempts, nextProbe, until, gravelUntil, dropUntil;
        private int scanTurn, scanFrames;
        private float bankBearing;
        private boolean waterReady, attacked;

        boolean active() { return bank != null; }

        boolean start() {
            if (bankCount >= BANK_LIMIT || gravelAttempts >= GRAVEL_LIMIT || tick < nextProbe
                || nextFoot != null || firing != Firing.NONE
                || !dryFieldFooting() || !has(PORTAL_BUCKET, 1) || !has(INGOT, 1)
                || has(IGNITER, 1) || has(FLINT, 1) || !has(IRON_PICK, 1) && !has(STONE_PICK, 1)) return false;
            BlockPos feet = c.player.getBlockPos();
            for (int i = 0; i < bankCount; i++) {
                if (feet.getSquaredDistance(checkedBanks[i]) <= 6 * 6) return false;
            }
            nextProbe = tick + 8;
            BlockHitResult lava = visibleCastLava();
            if (lava == null) return false;
            checkedBanks[bankCount++] = bank = feet;
            poolPoint = inward(lava);
            bankBearing = c.player.getYaw();
            waterReady = has(WATER_BUCKET, 1);
            until = tick + 450;
            return step();
        }

        boolean step() {
            if (tick > until || !dryFieldFooting() || c.player.getBlockY() != bank.getY()
                || c.player.getBlockPos().getSquaredDistance(bank) > 3 * 3) return finish();
            if (has(IGNITER, 1)) {
                status = "looking back toward the visible lava pool with field supplies ready";
                body.aim(poolPoint);
                if (!body.aligned(poolPoint)) return true;
                return finish();
            }
            if (!has(INGOT, 1)) return finish();
            if (!has(WATER_BUCKET, 1)) {
                return fillFieldBucket() || scan("checking the nearby bank for reachable source water");
            }
            fieldWater = null;
            if (!waterReady) {
                waterReady = true;
                scanTurn = scanFrames = 0;
            }
            if (has(FLINT, 1)) {
                status = "crafting flint and steel for the nearby lava pool";
                hands.craft("flint_and_steel");
                return true;
            }
            if (gravelBlock != null) return mineGravel();
            if (placement != null) {
                status = "placing carried gravel on the dry bank";
                switch (portal.place(placement, false, tick)) {
                    case DONE -> {
                        startMining(placement.dest, Vec3d.ofCenter(placement.dest));
                        placement = null;
                    }
                    case BLOCKED -> { return finish(); }
                    case WAIT -> { }
                }
                return true;
            }
            if (collect(GRAVEL_DROPS, 3.5)) return true;
            if (tick < dropUntil) {
                status = "watching for the gravel or flint drop";
                body.pauseWork();
                return true;
            }
            if (gravelAttempts >= GRAVEL_LIMIT) return finish();
            if (has(GRAVEL, 1)) {
                BlockHitResult floor = body.stationFace(null);
                if (floor != null && floor.getSide() == Direction.UP && safeSupport(floor)
                    && floor.getBlockPos().getY() + 1 == c.player.getBlockY()
                    && floor.getPos().y >= c.player.getY() - 0.02
                    && body.clearTerrain(Vec3d.ofCenter(floor.getBlockPos().up()))) {
                    placement = new AgentPortal.Place(floor.getBlockPos(), Direction.UP, inward(floor), Items.GRAVEL, tick);
                    return true;
                }
            }
            BlockHitResult visible = body.find(GRAVEL_BLOCK, REACH - 0.25, gravelCandidate).orElse(null);
            if (visible != null) {
                startMining(visible.getBlockPos(), inward(visible));
                return true;
            }
            return scan("checking the nearby bank for exposed gravel");
        }

        private boolean safeGravel(BlockHitResult hit) {
            BlockPos pos = hit.getBlockPos();
            // Don't remove a return step or loosen a gravel column over our footprint.
            return !pos.equals(rejectedGravel)
                && pos.getY() >= bank.getY() - 1 && pos.getY() <= bank.getY() + 1
                && (Math.abs(c.player.getX() - (pos.getX() + 0.5)) > 0.85
                    || Math.abs(c.player.getZ() - (pos.getZ() + 0.5)) > 0.85)
                && !protectRecoveryBlock(pos);
        }

        private void startMining(BlockPos block, Vec3d point) {
            gravelBlock = block;
            gravelPoint = point;
            gravelUntil = tick + 48;
            attacked = false;
            ++gravelAttempts;
        }

        private boolean mineGravel() {
            status = "breaking confirmed gravel for flint at the lava bank";
            body.aim(gravelPoint);
            if (tick > gravelUntil) {
                rejectedGravel = gravelBlock;
                gravelBlock = null;
            } else {
                BlockHitResult seen = perceive(gravelPoint, REACH);
                BlockState block = seen != null && gravelBlock.equals(seen.getBlockPos()) ? state(seen) : null;
                if (block != null && block.isOf(Blocks.GRAVEL)) {
                    body.aimContact(seen, AgentBody.Contact.MINE);
                    if (tools.readyFor(block) && body.mine(seen)) attacked = true;
                } else if (body.aligned(gravelPoint) && (seen != null || body.clearTerrain(gravelPoint))) {
                    if (attacked) dropUntil = tick + 26;
                    else rejectedGravel = gravelBlock;
                    gravelBlock = null;
                }
            }
            return true;
        }

        private boolean scan(String activity) {
            if (scanTurn == 4) return finish();
            float yaw = bankBearing + 90 * scanTurn;
            body.turn(yaw, 36);
            if (Math.abs(MathHelper.wrapDegrees(yaw - c.player.getYaw())) < 8
                && Math.abs(c.player.getPitch() - 36) < 7 && ++scanFrames >= 6) {
                ++scanTurn;
                scanFrames = 0;
            }
            status = activity;
            return true;
        }

        private boolean finish() {
            if (pickupItem == GRAVEL_DROPS) clearPickup();
            bank = gravelBlock = rejectedGravel = null;
            placement = null;
            fieldWater = null;
            dropUntil = scanTurn = scanFrames = 0;
            return false;
        }
    }

    void requestTable(String recipe, String extra, int planks, int sticks) {
        requestTable(recipe, extra, null, planks, sticks);
    }

    /** Optional kit work can use a local bench, but cannot interrupt the mine to create one. */
    boolean defenseBenchAvailable() {
        BlockHitResult bench = body.find(state -> state.isOf(table.block), REACH - 0.5).orElse(null);
        if (bench == null) return false;
        if (!bench.getBlockPos().equals(table.position)) {
            table.position = confirmStation(table, bench);
            table.approachUntil = table.openAttempts = 0;
        }
        return true;
    }

    private void requestTable(String recipe, String extra, String axe, int planks, int sticks) {
        if (!hands.stableCraftFooting()) return;
        cancelEarlyAxe();
        boolean shore = portalSupplies != null && portalSupplies.stoneBank != null;
        if (fieldBench.packUntil != 0) fieldBench.leave();
        BlockHitResult localBench = null;
        if (table.placed == 0 && (table.position == null || !localStation(table, null)
                || tick < table.approachUntil)) {
            localBench = body.find(TABLE_BLOCK, REACH).orElse(null);
            if (localBench != null) {
                boolean changed = !localBench.getBlockPos().equals(table.position);
                table.position = confirmStation(table, localBench);
                table.approachUntil = 0;
                if (changed) {
                    table.openAttempts = 0;
                    approachGoal = null;
                }
            } else if (table.position != null && !localStation(table, null)) {
                // Leave the witnessed workshop in memory; a different local bench may be cheaper.
                releaseTablePosition();
            }
        }
        if (!ensureTable(planks, sticks, shore)) return;
        tableRecipe = recipe;
        tableExtra = extra;
        tableAxe = axe;
        tablePlanks = planks;
        tableSticks = sticks;
        useStation(table, localBench);
    }

    private boolean ensureTable(int planks, int sticks, boolean shore) {
        if (table.position == null) {
            if (!shore && !has(table.item, 1) && collect(table.item, 6)) return false;
            BlockPos hint = memory.station(c.world, false);
            if (hint != null && !hint.equals(failedTableReturn)) {
                double distance = c.player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(hint));
                if (distance <= REACH * REACH && recoverStation(table)) return false;
                if (!shore && !has(table.item, 1) && distance > REACH * REACH
                    && tryTableReturn(hint)) return false;
            }
        }
        if (table.position != null || has(table.item, 1)) return ensureWood(planks, sticks);
        if (shore ? affordsWood(planks + 4, sticks) : ensureWood(planks + 4, sticks)) {
            status = "preparing a crafting table";
            List<String> recipes = woodBatch(planks + 4, sticks);
            recipes.add("crafting_table");
            hands.craftBatch(recipes);
        }
        return false;
    }

    private boolean tryTableReturn(BlockPos workshop) {
        int last = activeTrail() - 1;
        if (last <= 0 || !arrived(trail.get(last))) return false;
        int waypoint = stationWaypoint(workshop);
        if (waypoint < 0 || last - waypoint > 4) return false;
        for (int i = waypoint + 1; i <= last; i++) {
            if (!adjacent(trail.get(i - 1), trail.get(i))) return false;
        }
        if (!startReturn(waypoint, true)) return false;
        tableReturn = workshop;
        return true;
    }

    private void releaseTablePosition() {
        fieldBench.leave();
        table.position = table.lastUse = null;
        table.resetSite();
        table.approachUntil = 0;
        table.openAttempts = 0;
    }

    private boolean ensureWood(int planks, int sticks) {
        if (affordsWood(planks, sticks)) return true;
        seekTimber();
        return false;
    }

    private boolean affordsWood(int planks, int sticks) {
        return has(LOG, logBatches(planks, stickBatches(sticks)));
    }

    private int stickBatches(int sticks) {
        return (Math.max(0, sticks - hands.count(STICK)) + 3) / 4;
    }

    private int logBatches(int planks, int sticks) {
        return (Math.max(0, planks + 2 * sticks - hands.count(PLANK)) + 3) / 4;
    }

    private List<String> woodBatch(int planks, int sticks) {
        int stickRecipes = stickBatches(sticks);
        int plankRecipes = logBatches(planks, stickRecipes);
        List<String> recipes = new ArrayList<>(plankRecipes + stickRecipes + 1);
        for (int i = 0; i < plankRecipes; i++) recipes.add("planks");
        for (int i = 0; i < stickRecipes; i++) recipes.add("stick");
        return recipes;
    }

    private boolean craftTorches(int reserve) {
        return craftTorchBatches(torchCraftBatches(reserve));
    }

    private boolean craftTorchBatches(int batches) {
        if (batches <= 0) return false;
        List<String> recipes = woodBatch(0, batches);
        for (int i = 0; i < batches; i++) recipes.add("torch");
        status = "crafting torches";
        return hands.craftBatch(recipes);
    }

    private int torchCraftBatches(int reserve) {
        int held = hands.count(TORCH);
        int batches = availableTorchBatches(reserve, held);
        return batches == 0 ? 0 : fundedTorchBatches(batches, held, localTableWood(), fieldWood.handleSticks(reserve), true);
    }

    private int availableTorchBatches(int target, int held) {
        int wanted = Math.min(3, torchBatches(target, held));
        return wanted == 0 ? 0 : Math.min(wanted, hands.count(FUEL));
    }

    private int fundedTorchBatches(int wanted, int held, int bench, int handles, boolean emergencyLight) {
        var inventory = c.player.getInventory();
        int wood = 0, sticks = 0;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inventory.getStack(slot);
            if (stack.isEmpty()) continue;
            if (STICK.test(stack)) sticks += stack.getCount();
            else if (PLANK.test(stack)) wood += stack.getCount();
            else if (LOG.test(stack)) wood += 4 * stack.getCount();
        }
        boolean emergency = emergencyLight && held <= 3 && (sticks > 0 || wood >= 2)
            && (firing != Firing.IRON || furnaceIronSticks == 0) && pickUses(RETURNABLE_PICKS) > 6;
        return AgentMineLight.fundedTorches(wanted, held, wood, sticks, bench, handles, emergency);
    }

    private boolean prepareLight(int needed, boolean localTopUp) {
        int torches = hands.count(TORCH);
        if (!localTopUp && !affordsWood(0, 1) && activeTrail() > 1) {
            if (torches > 2) return false;
            // Coal alone cannot make light. Keep the last two torches for the walked way out.
            seekExpeditionSupplies("wood and light");
            return true;
        }
        int bench = localTableWood();
        int fuel = hands.count(FUEL);
        boolean canMakeTorch = affordsWood(bench, 1 + PICK_HANDLES) || canSpareEmergencyStick(torches);
        double range = torches > 1 ? SEARCH : REACH - 0.35;
        if (fuel == 0 && canMakeTorch && workOre(Resource.COAL, range, false)) return true;
        if (torches > 2 && c.player.getBlockPos().equals(refusedCharcoalFoot)) return false;
        // Once inside a lit mine, skip the optional top-up rather than burn the last
        // workshop wood in a furnace while there is still light for another short leg.
        if (!localTopUp && torches >= 4) return false;

        boolean nearbyFurnace = localStation(furnace, furnaceWitness);
        if (!nearbyFurnace) {
            BlockHitResult seen = visibleLocalFurnace();
            if (seen != null) {
                selectVisibleFurnace(seen);
                nearbyFurnace = true;
            }
        }
        int wanted = AgentMineLight.charcoalNeeded(needed, torches, fuel);
        // If owned coal couldn't be crafted above, the missing input is wood, not more fuel.
        if (fuel == 0) {
            boolean replacement = !nearbyFurnace && canSetLocalFurnace();
            boolean knownFurnace = !nearbyFurnace && charcoalFurnaceOnTrail(replacement);
            boolean canFire = nearbyFurnace || replacement || knownFurnace;
            int handles = fieldWood.handleSticks(Math.min(needed, torches + 4 * wanted));
            int batch = charcoalBatch(wanted, nearbyFurnace || knownFurnace, bench, handles);
            if (batch == 0 && torches <= 3 && handles > PICK_HANDLES) {
                // A low-light leg may need one batch before there is enough wood for a spare pick.
                handles = PICK_HANDLES;
                batch = charcoalBatch(1, nearbyFurnace || knownFurnace, bench, handles);
            }
            // Before paying for a short batch, use an actual local supply if it can
            // support a longer trip. An unseen tree isn't a reason to hold departure.
            if (localTopUp && (canFire || has(STONE, 8)) && Math.abs(batch) < wanted
                && takeLocalLightTimber()) return true;
            if (canFire && prepareCharcoal(batch, handles)) return true;
            if (!canFire && batch != 0 && workOre(Resource.STONE, REACH - 0.35, false)) {
                status = "gathering local furnace stone";
                return true;
            }

            if (torches <= 2) {
                if (canMakeTorch && recallOre(Resource.COAL, range, activeTrail())) return true;
                // An emergency can justify establishing a stove when the missing
                // material is ordinary stone and the rest of the job is payable.
                int missingStone = 8 - hands.count(STONE);
                if (!canFire && batch != 0 && missingStone > 0
                    && pickUses(STONE_PICK) + pickUses(WOOD_PICK) >= missingStone
                    && prepareCharcoal(batch, handles)) return true;
            }
        } else if (localTopUp && takeLocalLightTimber()) {
            return true;
        }
        if (torches > 2) return false;
        if (activeTrail() <= 1 && surveyLocalLight()) return true;
        seekExpeditionSupplies(canMakeTorch ? "light" : "wood and light");
        return true;
    }

    private boolean takeLocalLightTimber() {
        if (!dryFieldFooting() || !body.hasRecentView()) return false;
        if (timberWitness == null && timberChop == null && timberExitFrom == null && !woodPickupPending()
            && timberDropUntil == 0) return collect(LOG, 7) || startReachableTimber(true);
        seekTimber("light", true);
        return true;
    }

    private boolean continueLocalLightTimber() {
        if (!continuingTimberTread()) return false;
        seekTimber("light", true);
        return true;
    }

    private boolean supplyReturnReady() {
        if (pickUses(DEEP_PICK) + pickUses(STONE_PICK) < 4
                && !(has(STONE, 3) && affordsWood(localTableWood(), 2))) return false;
        return has(TORCH, 3) || torchCraftBatches(LOCAL_LIGHT) > 0
            || !has(FUEL, 1) && (returnFurnaceInReach() || visibleLocalFurnace() != null
                ? charcoalBatch(1, true) != 0 : canSetLocalFurnace() && charcoalBatch(1, false) != 0);
    }

    private boolean canSpareEmergencyStick(int torches) {
        // Convert the available fuel before starting a low-light survey for supplies.
        // A workable pick and the next four torches are worth more than one spare stick.
        return torches <= 3 && affordsWood(0, 1) && pickUses(RETURNABLE_PICKS) > 6;
    }

    private boolean surveyLocalLight() {
        BlockPos feet = c.player.getBlockPos();
        // Crossing an adjacent tile while approaching a trunk isn't a new workshop search.
        // Exposed coal in the current view is still checked on every ordinary gathering pass.
        if (lightSurveyFoot == null || feet.getSquaredDistance(lightSurveyFoot) > 36
                || Math.abs(feet.getY() - lightSurveyFoot.getY()) > 2) {
            lightSurveyFoot = feet;
            lightSurveyTurn = 0;
            lightSurveyYaw = c.player.getYaw();
        }
        if (lightSurveyTurn >= 4) return false;
        float yaw = lightSurveyYaw + 90 * lightSurveyTurn;
        body.turn(yaw, -3);
        if (Math.abs(MathHelper.wrapDegrees(yaw - c.player.getYaw())) < 8
            && Math.abs(c.player.getPitch() + 3) < 7) lightSurveyTurn++;
        status = "looking for local coal or a furnace";
        return true;
    }

    private int localTableWood() {
        return has(table.item, 1) || localStation(table, null) ? 0 : 4;
    }

    private boolean localStation(Station station, BlockPos alternate) {
        BlockPos pos = station.position != null ? station.position : alternate;
        return pos != null && c.player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(pos)) <= 3.75 * 3.75;
    }

    private boolean charcoalFurnaceOnTrail(boolean replacement) {
        BlockPos known = furnace.position != null ? furnace.position
            : furnaceWitness != null ? furnaceWitness : memory.station(c.world, true);
        if (known == null || reservedFurnace(known)
            || known.equals(refusedFurnace) && c.player.getBlockPos().equals(refusedFurnaceFoot)) return false;
        int waypoint = stationWaypoint(known);
        return waypoint >= 0 && (!replacement || groundedTrailIndex() - waypoint <= 12);
    }

    private boolean prepareCharcoal(int batch, int handles) {
        if (batch == 0 || has(TORCH, 3) && c.player.getBlockPos().equals(refusedCharcoalFoot)) return false;
        if (batch < 0) {
            status = "reserving workshop wood and preparing charcoal fuel";
            return hands.prepareSmeltFuel(true);
        }
        charcoalHandleReserve = handles;
        fire(Firing.CHARCOAL, batch);
        return true;
    }

    private int charcoalBatch(int wanted, boolean existingFurnace) {
        return charcoalBatch(wanted, existingFurnace, localTableWood(), PICK_HANDLES);
    }

    private int charcoalBatch(int wanted, boolean existingFurnace, int bench, int handles) {
        if (wanted == 0) return 0;
        var inventory = c.player.getInventory();
        var fuels = c.world.getFuelRegistry();
        int logs = 0, burnable = 0, rawStack = 0, planks = 0, plankHeat = 0, sticks = 0;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inventory.getStack(slot);
            if (stack.isEmpty()) continue;
            int count = stack.getCount();
            if (LOG.test(stack)) logs += count;
            if (BURNABLE_LOG.test(stack)) {
                burnable += count;
                rawStack = Math.max(rawStack, count);
            } else if (PLANK.test(stack)) {
                planks += count;
                plankHeat = Math.max(plankHeat, fuels.getFuelTicks(stack) * count);
            } else if (STICK.test(stack)) {
                sticks += count;
            }
        }
        if (burnable == 0) return 0;
        int upfront = existingFurnace || has(furnace.item, 1) ? 0 : bench;
        return new AgentMineLight.Wood(logs, burnable, rawStack, planks, plankHeat, sticks)
            .charcoal(wanted, bench, upfront, handles);
    }

    private static int furnacePlanks(int batch) {
        return (200 * batch + PLANK_BURN_TICKS - 1) / PLANK_BURN_TICKS;
    }

    private void seekExpeditionSupplies(String supplies) {
        seekTimber(supplies);
    }

    static FurnaceSite furnaceSite(boolean paid, boolean local, int walkedDistance, boolean replacement) {
        if (paid) return FurnaceSite.PAID;
        if (local) return FurnaceSite.LOCAL;
        if (walkedDistance >= 0 && (!replacement || walkedDistance <= 12)) return FurnaceSite.RETURN;
        return FurnaceSite.ESTABLISH;
    }

    private boolean reservedFurnace(BlockPos pos) {
        var saved = pendingFurnaceMemory.current();
        return saved != null && saved.pos().equals(pos) && saved.dimension().equals(furnaceDimension());
    }

    private BlockHitResult visibleLocalFurnace() {
        return body.find(FURNACE_BLOCK, REACH, unreservedFurnaceFace).orElse(null);
    }

    private void selectVisibleFurnace(BlockHitResult seen) {
        if (furnaceLoaded || localFurnace != null || furnace.placed != 0) return;
        releaseUnpaidFurnace(null);
        furnace.position = confirmStation(furnace, seen);
    }

    private boolean startFurnaceReturn(int waypoint) {
        if (waypoint < 0 || !startReturn(waypoint, true)) return false;
        returnForFurnace = true;
        return true;
    }

    private boolean returnFurnaceInReach() {
        return localStation(furnace, null) && (furnaceLoaded || !reservedFurnace(furnace.position))
            && body.find(FURNACE_BLOCK, 3.75, currentFurnaceFace).isPresent();
    }

    private void releaseUnpaidFurnace(BlockPos refused) {
        if (furnaceLoaded || localFurnace != null) return;
        refusedFurnace = refused;
        refusedFurnaceFoot = c.player.getBlockPos();
        furnace.position = furnaceWitness = furnace.lastUse = null;
        furnace.approachUntil = furnace.openAttempts = furnace.memoryProbe = 0;
        furnace.resetSite();
        approachGoal = null;
    }

    private void fire(Firing batch, int demand) {
        if (localFurnace != null && localFurnace.batch != null) {
            if (needsFurnaceLight() && has(FUEL, 1) && craftTorches(LOCAL_LIGHT)) return;
            returnToLocalFurnace(localFurnace);
            return;
        }
        if (firing == Firing.NONE) {
            firing = batch;
            furnaceDemand = demand;
            furnaceLoaded = false;
        }
        if (nextFoot != null) {
            excavate(nextFoot.getY(), digGoal);
            return;
        }
        boolean portalRefit = portalSupplies != null && portalSupplies.smelting;
        if (furnace.position == null && furnaceWitness != null) furnace.position = furnaceWitness;
        BlockHitResult seen = null;
        if (furnace.placed == 0) {
            boolean near = localStation(furnace, null) && (furnaceLoaded || !reservedFurnace(furnace.position));
            if (!furnaceLoaded && !near) {
                seen = visibleLocalFurnace();
                if (seen != null) {
                    selectVisibleFurnace(seen);
                    near = true;
                } else if (furnace.position == null && (!portalRefit || portalSupplies.localHint(furnace))
                        && recoverStation(furnace)) return;
                else near = localStation(furnace, null) && !reservedFurnace(furnace.position);
            }
            BlockPos known = furnace.position != null ? furnace.position : memory.station(c.world, true);
            boolean eligible = !near && known != null && (furnaceLoaded || !portalRefit && !reservedFurnace(known))
                && !(known.equals(refusedFurnace) && c.player.getBlockPos().equals(refusedFurnaceFoot));
            int waypoint = eligible ? stationWaypoint(known) : -1;
            int distance = waypoint < 0 ? -1 : groundedTrailIndex() - waypoint;
            switch (furnaceSite(furnaceLoaded, near, distance, distance > 12 && canSetLocalFurnace())) {
                case PAID -> {
                    if (!near) {
                        if (!startFurnaceReturn(waypoint)) status = "no witnessed return route to the loaded furnace";
                        return;
                    }
                }
                case LOCAL -> { }
                case RETURN -> {
                    if (startFurnaceReturn(waypoint)) {
                        furnace.position = known;
                        return;
                    }
                    releaseUnpaidFurnace(known);
                }
                case ESTABLISH -> {
                    // Keep the observation, not a work order for a distant empty stove.
                    if (furnace.position != null) releaseUnpaidFurnace(known);
                }
            }
        }
        if (furnace.position == null && !has(furnace.item, 1)) {
            if (collect(furnace.item, 6)) return;
            if (!has(STONE, 8)) gatherStone();
            else requestTable("furnace", null, 0, 0);
            return;
        }
        if (needsFurnaceLight() && has(FUEL, 1) && craftTorches(LOCAL_LIGHT)) return;
        if (furnaceNeedsFuel) {
            if (firing == Firing.IRON) {
                int wanted = furnaceLoaded ? 1 : Math.min(3, furnaceDemand - hands.count(INGOT));
                var plan = hands.ordinaryIronPlan(wanted, ironBenchReserve(), furnaceIronSticks,
                    furnaceBlockedFuel, furnaceLoaded);
                if (plan == null) {
                    boolean unpaidFirstPick = furnaceForFirstPick && !furnaceLoaded;
                    finishFire();
                    if (unpaidFirstPick) blockStation(furnace, "the furnace cannot take the quoted iron fuel");
                    else if (portalSupplies == null || portalSupplies.stoneBank == null)
                        seekExpeditionSupplies("furnace fuel");
                    return;
                }
                if (prepareIronStock(plan)) return;
                furnaceNeedsFuel = false;
            } else if (!furnaceLoaded) {
                furnaceNeedsFuel = false;
                if (!declineOptionalCharcoal("the furnace can't take the quoted charcoal fuel")) {
                    finishFire();
                    releaseUnpaidFurnace(furnace.position);
                    seekExpeditionSupplies("furnace fuel");
                }
                return;
            } else {
                furnaceNeedsFuel = false;
                status = "preparing usable furnace fuel";
                if (!hands.prepareSmeltFuel(false)) {
                    finishFire();
                    if (portalSupplies == null || portalSupplies.stoneBank == null) seekExpeditionSupplies("furnace fuel");
                }
                return;
            }
        }
        useStation(furnace, seen);
    }

    private boolean canSetLocalFurnace() {
        return has(furnace.item, 1) || has(STONE, 8) && (has(table.item, 1)
            || affordsWood(4, 0) || body.find(TABLE_BLOCK, REACH).isPresent());
    }

    private void finishFire() {
        if (portalSupplies != null) portalSupplies.smelting = false;
        firing = Firing.NONE;
        charcoalHandleReserve = PICK_HANDLES;
        furnaceLoaded = false;
        furnaceNeedsFuel = false;
        furnaceForFirstPick = false;
        furnaceBlockedFuel = ItemStack.EMPTY;
        furnaceIronPlanks = furnaceIronHandlePlanks = furnaceIronSticks = 0;
    }

    private boolean declineOptionalCharcoal(String reason) {
        if (firing != Firing.CHARCOAL || furnaceLoaded || localFurnace != null || !has(TORCH, 3)) return false;
        refusedCharcoalFoot = c.player.getBlockPos();
        if ("furnace".equals(tableRecipe)) tableRecipe = null;
        finishFire();
        status = reason;
        return true;
    }

    private BlockPos confirmStation(Station station, BlockHitResult visible) {
        BlockPos position = visible.getBlockPos();
        if (station == table) {
            fieldBench.observe(visible);
            if (position.equals(failedTableReturn)) failedTableReturn = null;
        }
        memory.confirm(c.world, station == furnace, position);
        station.memoryProbe = 0;
        return position;
    }

    private BlockPos confirmStationUse(Station station) {
        BlockPos position = station.lastUse;
        station.lastUse = null;
        if (position == null || !position.equals(station.position) || tick - station.opened > 10) return null;
        if (station.placed != 0) {
            // An unlit native outline identifies a surface, not its block type. Only
            // the stock debit and this fresh matching screen complete that receipt.
            if (!station.outlinePlacement || has(station.item, station.placementCount)) return null;
            confirmStationPlacement(station, null);
        }
        memory.confirm(c.world, station == furnace, position);
        return position;
    }

    private boolean recoverStation(Station station) {
        BlockPos hint = memory.station(c.world, station == furnace);
        if (hint == null || station == furnace && (reservedFurnace(hint)
            || hint.equals(refusedFurnace) && c.player.getBlockPos().equals(refusedFurnaceFoot))) return false;
        Vec3d center = Vec3d.ofCenter(hint);
        if (c.player.getEyePos().squaredDistanceTo(center) > REACH * REACH) {
            station.memoryProbe = 0;
            return false;
        }
        if (station.memoryProbe == 0) station.memoryProbe = tick;
        body.aim(center);
        BlockHitResult hit = perceive(center, REACH);
        if (hit != null && hit.getBlockPos().equals(hint)) {
            if (state(hit).isOf(station.block)) {
                station.position = confirmStation(station, hit);
                station.approachUntil = 0;
                return false;
            }
        } else if (tick - station.memoryProbe < 28) {
            status = "checking remembered " + station.recipe;
            return true;
        }
        memory.forget(c.world, station == furnace, hint);
        station.memoryProbe = 0;
        return false;
    }

    private void useStation(Station station, BlockHitResult seen) {
        status = "using " + station.recipe;
        if (station.position != null) {
            Vec3d center = Vec3d.ofCenter(station.position);
            double distance = c.player.getEyePos().distanceTo(center);
            if (station.placed != 0) {
                if (!observeStationPlacement(station, center)) return;
            }
            if (seen == null && station == table)
                seen = body.find(TABLE_BLOCK, REACH, currentTableFace).orElse(null);
            if (seen == null && station == furnace) {
                seen = body.find(FURNACE_BLOCK, REACH, currentFurnaceFace).orElse(null);
                if (seen == null && !station.position.equals(station.provedPlacement)
                        && !furnaceLoaded && localFurnace == null) {
                    if (station.memoryProbe == 0) station.memoryProbe = tick;
                    else if (tick - station.memoryProbe >= 28) {
                        releaseUnpaidFurnace(station.position);
                        return;
                    }
                }
            }
            if (seen == null && (distance > 3.75 || tick < station.approachUntil)) {
                if (approach(center, false, false) == Walk.BLOCKED) {
                    if (station == furnace) {
                        if (furnaceLoaded || localFurnace != null)
                            blockStation(station, "cannot reach the productive furnace");
                        else releaseUnpaidFurnace(station.position);
                    } else if (station == table) {
                        failedTableReturn = station.position;
                        releaseTablePosition();
                    } else station.position = null;
                }
                return;
            }
            if (seen != null) {
                confirmStation(station, seen);
                openStation(station, seen, AgentBody.Contact.INTERACT);
            } else if (station.position.equals(station.provedPlacement) && openOutlinedStation(station, center)) {
                return;
            } else {
                body.aim(center);
                if (!body.aligned(center)) return;
                BlockHitResult hit = perceive(center, REACH);
                if (hit != null && hit.getBlockPos().equals(station.position)) {
                    if (state(hit).isOf(station.block)) confirmStation(station, hit);
                    else forgetStation(station);
                } else station.approachUntil = tick + 15;
            }
            return;
        }
        // The requesting work order has already searched from this stance.
        placeStation(station);
    }

    private boolean observeStationPlacement(Station station, Vec3d center) {
        status = "checking placement of " + station.recipe;
        if (has(station.item, station.placementCount)) {
            if (tick - station.placed > 14) {
                station.rejected.add(station.position);
                station.position = null;
                station.siteRefusal = "vanilla did not debit the item at the selected face";
                station.placed = 0;
            }
            return false;
        }
        BlockHitResult placed = perceive(center, REACH);
        if (stationHit(station, placed) && state(placed).isOf(station.block)) {
            confirmStationPlacement(station, placed);
            return true;
        }
        if (tick - station.placed > 52) {
            blockStation(station, "stock debited but no block and fresh opening receipt for " + station.recipe
                + " at " + station.position.toShortString());
        } else if (!station.outlinePlacement || !openOutlinedStation(station, center)) {
            body.aim(center);
        }
        return false;
    }

    private void confirmStationPlacement(Station station, BlockHitResult visible) {
        station.provedPlacement = station.position;
        station.placed = 0;
        station.resetSite();
        if (station == table) fieldBench.placementConsumed(station.position, station.packablePlacement);
        if (visible != null) confirmStation(station, visible);
    }

    private boolean openOutlinedStation(Station station, Vec3d center) {
        if (!hands.stableCraftFooting() || !STATION_OPENING_HAND.test(c.player.getOffHandStack())
                && !c.player.getOffHandStack().isOf(Items.SHIELD)) return false;
        BlockHitResult outline = body.selectedFace();
        if (!stationHit(station, outline) || !nearOutline(outline)) return false;
        body.aim(center);
        if (!hands.equipForUse(STATION_OPENING_HAND)) return true;
        openStation(station, outline, AgentBody.Contact.OUTLINE);
        return true;
    }

    private static boolean stationHit(Station station, BlockHitResult hit) {
        return hit != null && station.position.equals(hit.getBlockPos());
    }

    private void openStation(Station station, BlockHitResult hit, AgentBody.Contact mode) {
        AgentBody.Preparation readiness = station.opened != 0 && tick - station.opened <= 7
            ? AgentBody.Preparation.RECEIPT : c.player.isSneaking()
                ? AgentBody.Preparation.STANCE : AgentBody.Preparation.READY;
        if (body.useContact(hit, mode, readiness)) {
            if (station == furnace) {
                furnaceContactFacing = null;
                furnaceContactFooting = null;
            }
            station.opened = tick;
            station.lastUse = hit.getBlockPos();
            station.openAttempts++;
        }
        if (station.openAttempts > 8)
            blockStation(station, "vanilla " + station.recipe + " interaction did not open its screen");
    }

    private void forgetStation(Station station) {
        memory.forget(c.world, station == furnace, station.position);
        if (station == furnace && station.position.equals(furnaceWitness)) furnaceWitness = null;
        if (station == table && !fieldBench.removed) fieldBench.leave();
        if (station.position.equals(station.provedPlacement)) station.provedPlacement = null;
        station.position = null;
        station.lastUse = null;
    }

    private void blockStation(Station station, String reason) {
        if ((station == furnace || station == table) && declineOptionalCharcoal(reason)) return;
        localBlockStation = station;
        localBlock = reason;
    }

    private void placeStation(Station station) {
        if (!hands.stableCraftFooting() || !has(station.item, 1)) return;
        BlockPos standing = c.player.getBlockPos();
        if (!standing.equals(station.stance)) {
            station.resetSite();
            station.stance = standing;
            station.siteSince = station.viewSince = tick;
            station.lane = c.player.getHorizontalFacing();
            int index = trail.lastIndexOf(standing);
            if (index > 0) {
                BlockPos prior = trail.get(index - 1);
                if (adjacent(prior, standing) && !sameStem(prior, standing))
                    station.lane = directional(Vec3d.ofBottomCenter(standing).subtract(Vec3d.ofBottomCenter(prior)));
            }
        }
        if (station.face != null) {
            useWorkshopFace(station);
            return;
        }
        if (station.view == WorkshopView.EXHAUSTED || tick - station.siteSince >= 122) {
            retraceWorkshop(station);
            return;
        }
        if (station.view == WorkshopView.CURRENT) {
            if (!body.hasRecentView()) return;
            if (!selectWorkshopFace(station, body.stationFace(null, station.availableSite), null))
                nextWorkshopView(station);
            return;
        }
        boolean ground = station.view == WorkshopView.GROUND;
        boolean wall = station.view == WorkshopView.FIRST_WALL || station.view == WorkshopView.SECOND_WALL;
        Direction side = station.view == WorkshopView.SECOND_WALL || station.view == WorkshopView.SECOND_FLOOR
            ? station.lane.rotateYCounterclockwise() : station.lane.rotateYClockwise();
        BlockPos niche = ground ? null : standing.offset(side).up();
        Vec3d aim = ground ? c.player.getPos().add(station.lane.getOffsetX(), -0.15, station.lane.getOffsetZ())
            : Vec3d.ofCenter(niche, wall ? 0.50 : -0.045);
        status = "checking " + (ground ? "ground" : wall ? "a side recess" : "a recess floor") + " for " + station.recipe;
        body.aim(aim);
        int age = tick - station.viewSince;
        if (body.renderedAim(aim, 8) && body.aligned(aim)) {
            BlockHitResult outline = body.selectedFace();
            if (selectWorkshopFace(station, outline, niche)
                    || ground && selectWorkshopFace(station, body.stationFace(null, station.availableSite), null)) return;
            if (wall && age < 46 && cutWorkshopNiche(station, outline, niche)) return;
            if (station.siteRefusal == null)
                station.siteRefusal = "no lit support or close outline into an off-route recess";
            if (age >= 8) nextWorkshopView(station);
        } else if (age >= 36) {
            nextWorkshopView(station);
        }
    }

    private void nextWorkshopView(Station station) {
        station.view = station.view.next();
        station.viewSince = tick;
    }

    private boolean selectWorkshopFace(Station station, BlockHitResult hit, BlockPos recess) {
        if (hit == null || hit.isInsideBlock() || hit.getSide() == Direction.DOWN) return false;
        BlockPos dest = hit.getBlockPos().offset(hit.getSide());
        if (recess != null && !dest.equals(recess)) {
            if (station.siteRefusal == null && hit.getBlockPos().equals(recess))
                station.siteRefusal = "the view stopped at the recess wall, not on a support across it";
            return false;
        }
        if (!station.availableSite(dest) || c.player.getBoundingBox().intersects(new Box(dest))) {
            if (station.siteRefusal == null)
                station.siteRefusal = "the selected destination was protected, occupied or on the walked lane";
            return false;
        }
        boolean lit = body.observedFaceLight(hit) > 0;
        if (lit ? !safeSupport(hit) : recess == null || station.outlineTried || !nearOutline(hit)) return false;
        station.face = hit;
        station.faceSince = tick;
        station.outlinePlacement = !lit;
        return true;
    }

    private boolean nearOutline(BlockHitResult hit) {
        if (hit.isInsideBlock() || hit.getPos().squaredDistanceTo(c.player.getEyePos()) > 2.35 * 2.35) return false;
        Direction side = hit.getSide();
        Vec3d pos = hit.getPos();
        BlockPos support = hit.getBlockPos(), dest = support.offset(side);
        // This fixes only the cell across the selected outer face. It proves no
        // empty volume, clearance, or block behind that vanilla ray.
        boolean outerFace = switch (side.getAxis()) {
            case X -> Math.abs(pos.x - Math.max(support.getX(), dest.getX())) < 0.015;
            case Y -> Math.abs(pos.y - Math.max(support.getY(), dest.getY())) < 0.015;
            case Z -> Math.abs(pos.z - Math.max(support.getZ(), dest.getZ())) < 0.015;
        };
        return outerFace && BlockPos.ofFloored(pos.lerp(c.player.getEyePos(), 0.04)).equals(dest);
    }

    private void useWorkshopFace(Station station) {
        BlockHitResult face = station.face;
        BlockPos dest = face.getBlockPos().offset(face.getSide());
        if (!station.availableSite(dest) || c.player.getBoundingBox().intersects(new Box(dest))) {
            rejectWorkshopFace(station, dest, "the candidate would obstruct the player or walked lane");
            return;
        }
        BlockHitResult current = body.selectedFace();
        if (station.outlinePlacement && (current == null || !current.getBlockPos().equals(face.getBlockPos())
                || current.getSide() != face.getSide() || !nearOutline(current))) {
            body.aim(face.getPos());
            if (tick - station.faceSince >= 35)
                rejectWorkshopFace(station, dest, "the close native outline no longer selected the support");
            return;
        }
        status = "placing " + station.recipe + (station.outlinePlacement ? " on a close outlined face" : " on a visible face");
        body.sneak();
        AgentBody.Preparation ready = AgentBody.Preparation.equipment(hands.equipForUse(station.item));
        if (ready == AgentBody.Preparation.READY && !c.player.isSneaking()) ready = AgentBody.Preparation.STANCE;
        if (ready == AgentBody.Preparation.READY && !body.canPlaceStationAcross(face)) {
            if (current != null && current.getBlockPos().equals(face.getBlockPos())
                    && current.getSide() == face.getSide()) {
                rejectWorkshopFace(station, dest, "vanilla would replace the selected block rather than place beside it");
                return;
            }
            ready = AgentBody.Preparation.STANCE;
        }
        AgentBody.Contact mode = station.outlinePlacement ? AgentBody.Contact.OUTLINE : AgentBody.Contact.PLACE;
        if (pressPlace(station, face, mode, ready)) return;
        if (tick - station.faceSince >= 35)
            rejectWorkshopFace(station, dest, "could not settle native contact on the selected face");
    }

    private void rejectWorkshopFace(Station station, BlockPos dest, String reason) {
        station.rejected.add(dest);
        station.face = null;
        station.siteRefusal = reason;
    }

    private boolean cutWorkshopNiche(Station station, BlockHitResult hit, BlockPos niche) {
        if (hit == null || !hit.getBlockPos().equals(niche) || body.observedFaceLight(hit) == 0
                || !station.availableSite(niche)
                || station.cut != null && !station.cut.equals(niche)) return false;
        BlockState shown = state(hit);
        if (!(shown.isIn(BlockTags.BASE_STONE_OVERWORLD) || shown.isIn(BlockTags.DIRT))
                || !safeSupport(hit) || shown.getBlock() instanceof net.minecraft.block.FallingBlock
                || !tools.canHarvest(shown)) return false;
        status = "cutting one visible recess for " + station.recipe;
        body.aimContact(hit, AgentBody.Contact.MINE);
        if (readyForMine(shown) && body.mine(hit)) station.cut = niche;
        return !body.miningFootingRefused(niche);
    }

    private void retraceWorkshop(Station station) {
        String reason = station.siteRefusal != null ? station.siteRefusal : "no grounded placement face was witnessed";
        int index = activeTrail() - 1;
        if (index <= 0 || !station.stance.equals(trail.get(index))) {
            blockStation(station, "cannot place " + station.recipe + ": " + reason + "; no earlier connected footing");
            return;
        }
        BlockPos prior = trail.get(index - 1);
        if (!adjacent(station.stance, prior) || sameStem(station.stance, prior)) {
            blockStation(station, "cannot place " + station.recipe + ": " + reason + "; previous footing is not a dry step");
            return;
        }
        if (!startReturn(index - 1, true)) {
            blockStation(station, "cannot place " + station.recipe + ": no earlier connected footing");
            return;
        }
        workshopReturn = station;
        status = "repositioning " + station.recipe + " to walked footing " + prior.toShortString() + ": " + reason;
    }

    private boolean workshopPlacementSite(BlockPos destination) {
        if (occupiesStep(destination, c.player.getBlockPos()) || occupiesStep(destination, nextFoot)
                || protectRecoveryBlock(destination)) return false;
        for (int i = trail.size() - 1; i >= 0; i--) {
            BlockPos foot = trail.get(i);
            if (occupiesStep(destination, foot)) return false;
            if (destination.getY() == foot.getY() + 2 && sameStem(destination, foot)
                    && (i > 0 && trail.get(i - 1).getY() > foot.getY()
                        || i + 1 < trail.size() && trail.get(i + 1).getY() > foot.getY())) return false;
        }
        return true;
    }

    private boolean offWorkshopPassage(BlockPos destination) {
        if (occupiesStep(destination, nextFoot)) return false;
        for (int i = trail.size() - 1; i >= 0; i--) {
            if (occupiesStep(destination, trail.get(i))) return false;
        }
        return true;
    }

    private static boolean occupiesStep(BlockPos block, BlockPos foot) {
        return block != null && sameStem(block, foot)
            && block.getY() >= foot.getY() && block.getY() <= foot.getY() + 1;
    }

    private boolean pressPlace(Station station, BlockHitResult support, AgentBody.Contact mode,
                               AgentBody.Preparation readiness) {
        BlockPos dest = support.getBlockPos().offset(support.getSide());
        int before = readiness == AgentBody.Preparation.READY ? hands.count(station.item) : 0;
        if (readiness == AgentBody.Preparation.READY && before <= 0) return false;
        if (c.player.getBoundingBox().intersects(new Box(dest)) || !body.useContact(support, mode, readiness))
            return false;
        if (station == table) {
            // A bench can hang from a wall. Record a real catch floor while the
            // destination is still empty, not after its dropped item falls away.
            Vec3d catchPoint = Vec3d.ofBottomCenter(dest).add(0, -0.04, 0);
            BlockHitResult floor = terrain(catchPoint, c.player.getEyePos().distanceTo(catchPoint) + 0.06);
            station.packablePlacement = floor != null && floor.getBlockPos().equals(dest.down())
                && floor.getSide() == Direction.UP && Math.abs(floor.getPos().y - dest.getY()) <= 0.06
                && safeSupport(floor);
        }
        station.face = null;
        station.outlineTried |= station.outlinePlacement;
        station.position = dest;
        station.placed = tick;
        station.placementCount = before;
        station.approachUntil = station.openAttempts = 0;
        station.opened = 0;
        station.lastUse = null;
        approachGoal = null;
        return true;
    }

    /** Ownership is local to this agent: remembering or using a pre-existing table never claims it. */
    private final class FieldBench {
        private ClientWorld world;
        private BlockPos position;
        private Vec3d center, face;
        private Predicate<ItemStack> output;
        private int placedAt, outputBefore, packUntil, before;
        private boolean packable, crafted, triedAxe, attacked, removed;
        private final Predicate<Entity> nearbyDrop = entity -> entity instanceof ItemEntity item
            && table.item.test(item.getStack()) && item.getPos().squaredDistanceTo(center) <= 2.25;

        private void placementConsumed(BlockPos placed, boolean catchFloor) {
            leave();
            world = c.world;
            position = placed;
            center = Vec3d.ofCenter(placed);
            placedAt = tick;
            packable = catchFloor;
        }

        private void observe(BlockHitResult hit) {
            if (world != c.world || !hit.getBlockPos().equals(position)) return;
            if (face == null && tick - placedAt > 30) {
                leave();
                return;
            }
            if (face == null) memory.placedWorkbench(world, position);
            face = hit.getPos().lerp(center, 0.055);
        }

        private void awaitCraft(BlockPos used, String recipe) {
            if (world != c.world || face == null || !position.equals(used)) return;
            output = item(Registries.ITEM.get(Identifier.ofVanilla(recipe)));
            outputBefore = hands.count(output);
        }

        private void confirmCraft() {
            if (output == null) return;
            crafted |= world == c.world && hands.count(output) > outputBefore;
            output = null;
        }

        private boolean pack() {
            if (!crafted) return false;
            if (!packable) return leave();
            if (world != c.world || c.player.isTouchingWater() || firing != Firing.NONE) return leave();
            // A jump-placed table can be the floor: do not mine it from on top.
            if (!removed) {
                int height = position.getY() - c.player.getBlockY();
                if (!position.equals(table.position) || height < 0 || height > 1
                        || c.player.getEyePos().squaredDistanceTo(face) > REACH * REACH) return leave();
            }
            if (packUntil == 0) {
                if (horizontalDistance(c.player.getPos(), center) > 3 || !roomForTable()) return leave();
                packUntil = tick + 120;
                before = hands.count(table.item);
                approachGoal = null;
            }
            if (tick >= packUntil) return leave();
            if (!removed) {
                body.aim(face);
                status = "packing the crafting table";
                BlockHitResult hit = perceive(face, REACH);
                if (hit != null && hit.getBlockPos().equals(position)) {
                    if (!state(hit).isOf(table.block)) {
                        forgetStation(table);
                        return false;
                    }
                    if (!triedAxe) {
                        triedAxe = true;
                        var inv = c.player.getInventory();
                        if (!AXE.test(inv.getMainHandStack())) {
                            for (int slot = 0; slot < PlayerInventory.HOTBAR_SIZE; slot++) {
                                if (AXE.test(inv.getStack(slot)) && !c.options.hotbarKeys[slot].isUnbound()) {
                                    hands.equipSlot(slot);
                                    return true;
                                }
                            }
                        }
                    }
                    body.aimContact(hit, AgentBody.Contact.MINE);
                    if (c.player.isOnGround() && body.mine(hit)) attacked = true;
                    return true;
                }
                if (!body.aligned(face)) return true;
                if (!attacked || !body.clearTerrain(center) && !has(table.item, before + 1)) return true;
                removed = true;
                forgetStation(table);
                packUntil = Math.min(packUntil, tick + 32);
            }
            if (has(table.item, before + 1)) {
                leave();
                status = "packed the crafting table";
                return true;
            }
            status = "collecting the packed crafting table";
            ItemEntity seen = (ItemEntity) body.visibleEntity(nearbyDrop, 4).orElse(null);
            if (!roomForTable()) {
                body.pauseWork();
                return leave();
            }
            if (body.pickUpVisible(seen, null, false) == AgentBody.PickupResult.BLOCKED) return leave();
            return true;
        }

        private boolean roomForTable() {
            var inventory = c.player.getInventory();
            for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
                ItemStack stack = inventory.getStack(slot);
                if (stack.isEmpty() || table.item.test(stack) && stack.getCount() < stack.getMaxCount()) return true;
            }
            return false;
        }

        private boolean leave() {
            if (packUntil != 0) approachGoal = null;
            world = null;
            position = null;
            center = face = null;
            output = null;
            packUntil = 0;
            packable = crafted = triedAxe = attacked = removed = false;
            return false;
        }
    }

    /** Take a few exposed low logs without turning a worked mine into another forestry search. */
    private final class FieldWood {
        private final BlockPos[] attempts = new BlockPos[4];
        private final Predicate<BlockHitResult> candidate = this::nearbyTrunk;
        private final Predicate<Entity> nearbyDrop = this::droppedTrunk;
        private BlockPos anchor;
        private int attemptCount, stems, logsBefore, until, checkAfter;
        private BlockPos harvestFoot, ironBench, deepFoot;
        private int ownedLogs = -1, harvestTick, servedHarvest, ironUntil, deepUntil, bearings, restoreUntil;
        private float leaveYaw, leavePitch, supplyYaw;
        private boolean sawDeepPick, portalBenchSurveyed, portalBenchCraft;

        private boolean step() {
            int light = activeTrail() == 0 && !goal.equals("iron_pickaxe") ? 2 * LOCAL_LIGHT : LOCAL_LIGHT;
            return step(light, false);
        }

        private boolean step(int light, boolean secondDeparture) {
            if (anchor != null) return finishCut();
            if (attemptCount == attempts.length || tick < checkAfter || !timberReady || !dryFieldFooting()
                || (!secondDeparture && resumeIndex >= 0)
                || target != null || pickupItem != null || timberChop != null
                || !has(AXE, 1) && !(ordinarySurfaceWork && needsTimberKit() && hands.stableCraftFooting())) return false;
            checkAfter = tick + 12;
            int recipes = torchBatches(light, hands.count(TORCH));
            int logs = Math.max(0, recipes - hands.count(FUEL));
            int planks = portableBenchWood() + furnacePlanks(logs) + 4 * logs;
            if (affordsWood(planks, recipes + handleSticks())) return false;

            BlockHitResult low = body.find(state -> state.isIn(BlockTags.LOGS), REACH, candidate).orElse(null);
            if (low == null) return false;
            BlockPos block = low.getBlockPos();
            boolean seenStem = false;
            for (int i = 0; i < attemptCount; i++) seenStem |= sameStem(block, attempts[i]);
            if (!seenStem) stems++;
            attempts[attemptCount++] = block;
            anchor = c.player.getBlockPos();
            until = tick + 92;
            logsBefore = hands.count(LOG);
            timberWitness = low;
            timberLastCut = null;
            timberDropUntil = 0;
            beginTimberChop(low, false);
            status = "taking a nearby low log for field supplies";
            return true;
        }

        private void observeSurfaceWood() {
            if (deepFoot != null || anchor != null || tick - timberSeekTick > 24 || timberWitness == null) {
                ownedLogs = -1;
                return;
            }
            int logs = hands.count(LOG);
            if (ownedLogs >= 0 && logs > ownedLogs) {
                harvestFoot = c.player.getBlockPos();
                harvestTick = tick;
            }
            ownedLogs = logs;
        }

        private boolean prepareDeepDeparture() {
            var receipt = hands.lastCraftReceipt();
            if (!sawDeepPick && receipt != null && receipt.recipe().equals("iron_pickaxe") && localStation(table, null)) {
                ironBench = table.position;
                ironUntil = tick + 85;
            }
            sawDeepPick = true;
            BlockPos feet = c.player.getBlockPos();
            if (deepFoot == null) {
                if (nextFoot != null || resumeIndex > 1 || activeTrail() >= 4
                    || !dryFieldFooting() || target != null) return false;
                boolean freshHarvest = harvestTick > servedHarvest && tick - harvestTick <= 360
                    && feet.getSquaredDistance(harvestFoot) <= 36;
                boolean firstIron = tick < ironUntil && feet.getSquaredDistance(ironBench) <= 16;
                if (pickupItem == LOG && freshHarvest && !pickupPursuit.canReacquire(tick)) clearPickup();
                if (pickupItem != null) return false;
                boolean portalBench = portalSupplies != null && !portalBenchSurveyed && portalSupplies.needsPortableBench();
                if (!freshHarvest && !((firstIron || portalBench) && supplyEgress.outdoors())) return false;
                portalBenchSurveyed |= portalBench;
                portalBenchCraft = false;
                servedHarvest = harvestTick;
                ironUntil = 0;
                deepFoot = feet;
                deepUntil = tick + 180;
                bearings = restoreUntil = attemptCount = stems = checkAfter = 0;
                leaveYaw = c.player.getYaw();
                leavePitch = c.player.getPitch();
                supplyYaw = freshHarvest && !sameStem(feet, harvestFoot)
                    ? yaw(Vec3d.ofBottomCenter(harvestFoot).subtract(c.player.getPos())) : leaveYaw;
            }
            if (!dryFieldFooting() || feet.getSquaredDistance(deepFoot) > 4 || nextFoot != null)
                return endDeepDeparture();
            if (anchor != null && finishCut()) return true;

            int light = AgentMineLight.tripTorches(AgentMineLight.routeSteps(deepFoot.getY(), DIAMOND_LEVEL));
            int torches = hands.count(TORCH);
            int handles = handleSticks(light);
            int bench = portableBenchWood();
            int batches = availableTorchBatches(light, torches);
            if (batches > 0 && craftTorchBatches(fundedTorchBatches(batches, torches, bench, handles, false))) return true;
            if (bench == 0 && !has(table.item, 1) && fieldBench.pack()) return true;

            if ((torches < light || !affordsWood(bench, handles)) && tick < deepUntil) {
                if (step(light, true)) return true;
                if (target != null && miningResource == Resource.COAL) {
                    mineTarget(Resource.COAL);
                    return true;
                }
                ItemEntity fuel = torches < light ? body.dropped(FUEL, 2.2).orElse(null) : null;
                if (fuel != null && collectOnFooting(deepFoot, fuel)) {
                    status = "collecting visible coal beside the surface workshop";
                    return true;
                }
                if (miningResource == Resource.COAL && tick < pickupUntil) {
                    body.pauseWork();
                    return true;
                }
                BlockHitResult coal = torches < light ? findOre(Resource.COAL, 2.5) : null;
                if (coal != null && reachableResourceFace(coal.getBlockPos())
                    && coal.getBlockPos().getY() >= feet.getY() && affordsWood(bench, 1 + handles)) {
                    setTarget(coal, Resource.COAL);
                    mineTarget(Resource.COAL);
                    return true;
                }
                if (torches < light && !has(FUEL, 1)) {
                    int wanted = AgentMineLight.charcoalNeeded(light, torches, 0);
                    int batch = charcoalBatch(wanted, true, bench, handles);
                    // A partial batch belongs to ordinary preparation, where reachable
                    // timber can turn it into a useful trip before the furnace is paid.
                    if (Math.abs(batch) == wanted) {
                        BlockHitResult stove = body.find(FURNACE_BLOCK, 3.5, unreservedFurnaceFace).orElse(null);
                        if (stove != null) {
                            selectVisibleFurnace(stove);
                            if (prepareCharcoal(batch, handles)) return true;
                        }
                    }
                }
                if (bearings < 3 && attemptCount < attempts.length) {
                    float looking = supplyYaw + (bearings == 1 ? 52 : bearings == 2 ? -52 : 0);
                    body.turn(looking, 12);
                    if (bearingDistance(c.player.getYaw(), looking) < 7
                        && Math.abs(c.player.getPitch() - 12) < 7) {
                        bearings++;
                        checkAfter = 0;
                    }
                    status = "checking the nearby surface workshop for deep-mine supplies";
                    return true;
                }
            }
            if (!feet.equals(deepFoot) && tick < deepUntil + 26) {
                status = "rejoining the surface workshop footing";
                if (walkMinedStep(deepFoot) != Walk.BLOCKED) return true;
            }
            if (!has(table.item, 1) || !has(STICK, handles)) {
                int planks = has(table.item, 1) ? 0 : 4;
                if (affordsWood(planks, handles)) {
                    List<String> recipes = woodBatch(planks, handles);
                    if (planks != 0) recipes.add("crafting_table");
                    status = "packing a bench and handles for the deep mine";
                    if (hands.craftBatch(recipes)) return true;
                } else if (planks != 0 && !portalBenchCraft && portalSupplies != null
                    && portalSupplies.needsPortableBench() && affordsWood(planks, 0)) {
                    portalBenchCraft = true;
                    List<String> recipes = woodBatch(planks, 0);
                    recipes.add("crafting_table");
                    status = "packing a portable bench for the portal bucket";
                    if (hands.craftBatch(recipes)) return true;
                }
            }
            if (restoreUntil == 0) restoreUntil = tick + 26;
            if (tick < restoreUntil && (bearingDistance(c.player.getYaw(), leaveYaw) >= 7
                || Math.abs(c.player.getPitch() - leavePitch) >= 7)) {
                body.turn(leaveYaw, leavePitch);
                status = "returning the view to the intended mine";
                return true;
            }
            return endDeepDeparture();
        }

        private boolean endDeepDeparture() {
            deepFoot = null;
            if (anchor != null) finish();
            if (target != null && miningResource == Resource.COAL) target = null;
            if (pickupItem == FUEL) clearPickup();
            // The local top-up is optional. Let the already verified mine route
            // continue if this landing cannot supply the entire diamond leg.
            departureKit = true;
            return false;
        }

        private boolean collectOnFooting(BlockPos from, ItemEntity item) {
            Vec3d drop = item.getPos();
            double distance = drop.subtract(c.player.getPos()).horizontalLengthSquared();
            if (distance > 2.15 || !adjacent(from, BlockPos.ofFloored(drop)) || drop.y < c.player.getY()) return false;
            return body.pickUpVisible(item, null, false) != AgentBody.PickupResult.BLOCKED;
        }

        private boolean nearbyTrunk(BlockHitResult hit) {
            BlockPos block = hit.getBlockPos();
            int height = block.getY() - c.player.getBlockY();
            if (height < 0 || height > 1 || !adjacent(c.player.getBlockPos(), block)
                || !timberInReach(hit) || !timberCandidate(hit) || supportsTrail(block)) return false;
            boolean matchingStem = false;
            for (int i = 0; i < attemptCount; i++) {
                if (block.equals(attempts[i])) return false;
                matchingStem |= sameStem(block, attempts[i]);
            }
            return matchingStem || stems < 2;
        }

        private boolean droppedTrunk(Entity entity) {
            if (!(entity instanceof ItemEntity item) || !LOG.test(item.getStack())) return false;
            double x = item.getX() - timberLastCut.getX() - 0.5;
            double z = item.getZ() - timberLastCut.getZ() - 0.5;
            return x * x + z * z <= 1.25 * 1.25;
        }

        private boolean finishCut() {
            BlockPos standing = c.player.getBlockPos();
            if (!dryFieldFooting() || !adjacent(anchor, standing) || anchor.getY() != standing.getY()) return finish();
            if (timberChop != null && tick < until) {
                if (body.hasRecentView()) chopTimber();
                else if (!continueTimberAttack()) status = "waiting for a rendered view of the low log";
                return true;
            }
            boolean collected = has(LOG, logsBefore + 1);
            if (!collected && timberLastCut != null && tick < Math.min(until, timberDropUntil + 14)) {
                ItemEntity drop = (ItemEntity) body.visibleEntity(nearbyDrop, 3).orElse(null);
                status = "collecting a low log beside the mine route";
                if (drop == null) {
                    body.pauseWork();
                    return true;
                }
                if (collectOnFooting(anchor, drop)) return true;
            }
            if (!anchor.equals(standing) && tick < until + 26) {
                status = "rejoining the witnessed mine footing";
                if (walkMinedStep(anchor) != Walk.BLOCKED) return true;
            }
            boolean rejoined = anchor.equals(standing);
            finish();
            if (!collected || !rejoined) return false;
            int bench = portableBenchWood();
            int sticks = handleSticks() + Math.min(hands.count(FUEL), torchBatches(LOCAL_LIGHT, hands.count(TORCH)));
            if (!affordsWood(bench, sticks) || bench == 0 && has(STICK, sticks)) return false;
            List<String> recipes = woodBatch(bench, sticks);
            if (bench != 0) recipes.add("crafting_table");
            status = "packing a portable workshop from locally collected wood";
            return hands.craftBatch(recipes);
        }

        private int portableBenchWood() {
            return has(table.item, 1) || fieldBench.crafted && fieldBench.packable && localStation(table, null) ? 0 : 4;
        }

        private int handleSticks() {
            return handleSticks(hands.count(TORCH) + 4 * hands.count(FUEL));
        }

        private int handleSticks(int light) {
            int litSteps = 7 * Math.max(1, Math.min(LOCAL_LIGHT, light) - 2);
            return has(STONE, 3) && pickUses(RETURNABLE_PICKS) < 3 * litSteps ? 2 * PICK_HANDLES : PICK_HANDLES;
        }

        private boolean finish() {
            anchor = null;
            timberChop = null;
            clearTimberWitness();
            return false;
        }
    }

    private void gather(Resource resource, int onSurfaceTicks, int depth) {
        if (sought != resource) {
            sought = resource;
            soughtSince = tick;
        }
        status = "seeking " + resource.label;
        if (returnableOre != null) {
            if (!finishingOreCut(returnableOre) && collectOre(returnableOre, 3.1)) return;
            if (target != null && miningResource == returnableOre) {
                mineTarget(returnableOre);
                return;
            }
            returnableOre = null;
        }
        if (nextFoot != null) {
            excavate(nextFoot.getY(), digGoal);
            return;
        }
        if (resource != Resource.STONE && continueLocalLightTimber()) return;
        if (resumeIndex >= 0) {
            boolean atSupplyStop = resumeStep < 0 && dryFieldFooting();
            int torches = hands.count(TORCH);
            if (resource != Resource.STONE && (atSupplyStop || torches <= 2)) {
                // Rejoining an already walked and lit trail isn't new excavation.
                int unlit = Math.max(0, trail.size() - Math.max(resumeIndex, litIndex));
                int needed = AgentMineLight.tripTorches(unlit + AgentMineLight.routeSteps(trail.getLast().getY(), depth));
                if (torches < needed && (atSupplyStop && workOre(resource, REACH - 0.35, false)
                    || craftTorches(needed) || prepareLight(needed, atSupplyStop))) return;
            }
            resumeTunnel();
            return;
        }
        if (surfaceApproach.step(c.player.getBlockPos())) return;
        if (resource != Resource.STONE && fieldWood.step()) return;
        if (returnableMine.active() && (resource == Resource.DIAMOND || resource == Resource.IRON)) {
            workReturnableMine(c.player.getBlockPos(), depth);
            return;
        }
        if (resource == Resource.STONE && nightSite.mineBearing(c.player.getBlockPos()) != null) {
            // Open the first stone leg inward rather than leaving the proved corner
            // to chase a more distant surface face.
            if (!collectOre(resource, 2.2)) excavate(depth, null);
            return;
        }
        double range = resource != Resource.STONE && (surfaceDeparture() || !has(TORCH, 2))
            ? REACH - 0.35 : SEARCH;
        if (nightSite.guardExcavation(resource)) return;
        if (workOre(resource, range, resource != Resource.STONE)) return;
        if (resource != Resource.STONE && prepareMining(depth)) return;
        if (resource != Resource.STONE && hands.count(TORCH) + 4 * hands.count(FUEL) < LOCAL_LIGHT
            && affordsWood(localTableWood(), 3) && workOre(Resource.COAL, range, false)) return;
        target = null;
        if (ordinaryCaveDrops && mineResite.holds(resource, c.player.getBlockPos())) {
            localBlock = "no different safe mine start was reached; holding the exhausted mine area";
            return;
        }
        watchExpeditionOreRoute(resource, depth);
        if (workExpeditionOreRoute(resource, depth)) return;
        if ((activeTrail() > 1 || resumeIndex >= 0 || tick - soughtSince > onSurfaceTicks)
            && tick >= nextDigStart && (c.player.isOnGround() || activeTrail() > 0) && !c.player.isTouchingWater()) {
            excavate(depth, null);
        } else {
            explore();
        }
    }

    private void watchExpeditionOreRoute(Resource resource, int depth) {
        if (expedition == null || prospectingOre == resource || resource != Resource.IRON && resource != Resource.DIAMOND)
            return;
        int bit = 1 << resource.ordinal();
        if ((prospected & bit) != 0) return;
        // Stocking a dark mine can take longer than a strategy's lifetime.
        // Offer the actual route choice, not the eventual ore objective at spawn.
        BlockPos standing = c.player.getBlockPos();
        if (returnableMine.unjoined() || standing.getY() > depth && !returnableMine.stockedForNewLeg(this)) return;
        prospected |= bit;
        prospectingOre = resource;
        // An offer is passive: no view, movement, supplies or timing changes
        // until a current answer is accepted at the next ordinary decision.
        prospecting = new AgentExpedition.Prospecting(resource == Resource.IRON ? "iron_route" : "diamond_route");
    }

    private boolean workExpeditionOreRoute(Resource resource, int depth) {
        if (prospectingOre != resource) return false;
        var offer = prospecting.live();
        if (offer != null && expedition.hasAdvice(offer) && expeditionOffer() == offer
                && tick >= nextDigStart && expeditionTurnReady()) {
            BlockPos standing = c.player.getBlockPos();
            if (!returnableMine.unjoined() && (standing.getY() <= depth || returnableMine.stockedForNewLeg(this))) {
                var selected = expedition.take(offer, true);
                if (selected != null) {
                    prospectingYaw = c.player.getYaw();
                    boolean open = selected == AgentExpedition.Prospecting.VISIBLE && activeTrail() <= 1
                        && (supplyEgress.outdoors() || (body.supplyPerspective(prospectingYaw) & AgentBody.SUPPLY_OPEN) != 0);
                    prospecting.choose(selected, tick, open);
                }
            }
        }
        return switch (prospecting.turn(tick)) {
            case LOCAL -> false;
            case EXCAVATE -> {
                excavate(depth, null, true);
                yield true;
            }
            case SCOUT -> prospectVisibleOre(resource);
        };
    }

    private boolean prospectVisibleOre(Resource resource) {
        if (!dryFieldFooting() || !body.hasRecentView() || c.player.hurtTime > 0 || c.player.isOnFire()
                || localFurnace != null || c.player.isUsingItem()) return false;
        BlockPos standing = c.player.getBlockPos();
        Direction facing = c.player.getHorizontalFacing();
        if (prospecting.overland()) {
            if (surveyCave(standing.offset(facing), facing)) return true;
            explore();
        } else {
            // WorkOre already checked this frame. Take each distinct view at
            // most once; any found route still needs the regular cave proofs.
            float bearing, pitch;
            switch (prospecting.view()) {
                case 0 -> { bearing = prospectingYaw - 42; pitch = 8; }
                case 1 -> { bearing = prospectingYaw + 43; pitch = 14; }
                default -> { bearing = prospectingYaw; pitch = 43; }
            }
            if (body.renderedDirection(bearing, pitch, 9)) {
                prospecting.sawView();
                if (surveyCave(standing.offset(facing), facing)) return true;
                if (!prospecting.scouting(tick)) return false;
            } else {
                body.turn(bearing, pitch);
            }
        }
        status = "prospecting visible terrain for " + resource.label;
        return true;
    }

    private boolean expeditionTurnReady() {
        return c.interactionManager.getCurrentGameMode() == GameMode.SURVIVAL && c.currentScreen == null
            && c.getOverlay() == null && c.player.currentScreenHandler == c.player.playerScreenHandler
            && c.player.currentScreenHandler.getCursorStack().isEmpty() && hands.releasedForPendingWork()
            && hands.stableCraftFooting() && body.hasRecentView() && !c.player.isUsingItem()
            && !c.player.isOnFire() && c.player.hurtTime == 0 && !body.lavaEmergency()
            && !body.horizonWaterInFlight() && !c.options.attackKey.isPressed() && !c.options.useKey.isPressed()
            && !c.interactionManager.isBreakingBlock() && pendingStairLight == null
            && localFurnace == null && firing == Firing.NONE && !(table.lastUse != null && tick - table.opened <= 10)
            && pickupItem == null && tick >= pickupUntil && tick >= timberDropUntil
            && oreProbe == null && nextFoot == null && returnIndex < 0 && resumeIndex < 0
            && exitStart == null && !caves.active() && !caves.routingDry() && !returnableMine.active()
            && !navigator.driving() && !supplyEgress.active() && !stallGuard.ownsRecovery()
            && (ordinaryApproach == null || ordinaryApproachTick < tick - 1);
    }

    private boolean workOre(Resource resource, double range, boolean remember) {
        if (!finishingOreCut(resource) && collectOre(resource, Math.min(7, range))) return true;
        if (resource == Resource.STONE) {
            if (!c.player.isOnGround() || !safePickupStance()) return false;
            // A close cut can still drop cargo into an unseen opening. Give the normal
            // pickup attempt its turn, then move or use a checked stair instead of
            // hollowing more of the same front with no inventory gain.
            if (stoneCutFoot != null) return false;
            if (target != null && miningResource == resource && !stoneStockFace(target)) target = null;
        }
        if (target != null && miningResource == resource
            && (range > REACH || targetPoint.squaredDistanceTo(c.player.getEyePos()) <= range * range)) {
            mineTarget(resource);
            return true;
        }
        BlockHitResult hit = findOre(resource, range);
        if (hit != null && (tick >= seekAfter || activeTrail() > 1) && reachableResourceFace(hit.getBlockPos())
            && tools.canHarvest(state(hit))) {
            setTarget(hit, resource);
            quarryingStoneStock = resource == Resource.STONE;
            mineTarget(resource);
            return true;
        }
        return remember && recallOre(resource, range, 24);
    }

    private boolean finishingOreCut(Resource resource) {
        return resource != null && resource == miningResource && target != null && lastMining != 0 && tick - lastMining < 5;
    }

    private boolean prioritizeOrePickup() {
        if (nextFoot != null || resumeIndex >= 0 || oreProbeReturning || firing != Firing.NONE
                || caves.active() || caves.routingDry() || finishingOreCut(miningResource) || !safePickupStance()
                || woodPickupPending() && pickupPursuit.canReacquire(tick) && !pickupPursuit.expired(tick)
                || timberExitTo != null && ordinaryRouteTick == tick - 1 && ordinaryRouteJob == Job.TIMBER)
            return false;
        Resource pending = pickupResource(pickupItem);
        if (pending == null && tick < pickupUntil) pending = miningResource;
        if (pending == null && tick < pickupLightUntil) pending = pickupResource(pickupLightItem);
        if (pending == null && needsTimberKit() && (has(STONE_PICK, 1) || has(DEEP_PICK, 1))) {
            if (!has(DEEP_PICK, 1) && hands.count(INGOT) + hands.count(RAW_IRON) < 3) pending = Resource.IRON;
            else if (has(DEEP_PICK, 1) && !has(DIAMOND, portal == null ? 1 : 3)) pending = Resource.DIAMOND;
        }
        return pending != null && collectOre(pending, pickupItem == pending.drop ? 7 : REACH - 0.35);
    }

    private boolean collectOre(Resource resource, double range) {
        if (collect(resource.drop, range)) return true;
        if (resource == miningResource && tick < pickupUntil) {
            body.pauseWork();
            status = "waiting for the broken " + resource.label + " to drop";
            return true;
        }
        return lightForPickup(resource.drop);
    }

    private static Resource pickupResource(Predicate<ItemStack> drop) {
        return drop == RAW_IRON ? Resource.IRON : drop == DIAMOND ? Resource.DIAMOND
            : drop == FUEL ? Resource.COAL : drop == STONE ? Resource.STONE : null;
    }

    private BlockHitResult findOre(Resource resource, double range) {
        if (oreWorld != c.world) {
            oreSights.clear();
            rejectedOreSights.clear();
            clearOreProbe();
            oreWorld = c.world;
        }
        BlockHitResult hit = body.find(resource.block, range,
            resource == Resource.STONE ? ordinaryStoneFace : ordinaryOreFace).orElse(null);
        if (hit == null || resource == Resource.STONE || !c.player.isOnGround()
            || c.player.isTouchingWater()) return hit;
        BlockPos block = hit.getBlockPos();
        BlockPos stance = c.player.getBlockPos();
        // A failed memory detour does not veto a live ore face. It only stops the
        // periodic scanner from queuing the same remote trip from the same viewpoint.
        for (OreSight rejected : rejectedOreSights) {
            if (rejected.resource == resource && rejected.block.equals(block) && rejected.stance.equals(stance))
                return hit;
        }
        double rangeSquared = hit.getPos().squaredDistanceTo(c.player.getEyePos());
        for (int i = 0; i < oreSights.size(); i++) {
            OreSight old = oreSights.get(i);
            if (!old.block.equals(block) || !old.stance.equals(stance)) continue;
            if (old.resource == resource && rangeSquared >= old.rangeSquared - 0.25) {
                if (i != 0) oreSights.addFirst(oreSights.remove(i));
                return hit;
            }
            oreSights.remove(i);
            break;
        }
        if (oreSights.size() == ORE_MEMORY_LIMIT) oreSights.removeLast();
        oreSights.addFirst(new OreSight(resource, block, orePoint(hit), stance, c.player.getPos(), rangeSquared));
        return hit;
    }

    private boolean recallOre(Resource resource, double range, int steps) {
        int last = activeTrail() - 1;
        BlockPos standing = c.player.getBlockPos();
        OreSight best = null;
        int waypoint = -1;
        double score = Double.POSITIVE_INFINITY;
        for (OreSight sight : oreSights) {
            if (sight.resource != resource || !reachableResourceFace(sight.block)
                || supportsTrail(sight.block)) continue;
            if (range <= REACH && sight.rangeSquared > range * range) continue;
            int route = -1;
            double cost;
            if (standing.equals(sight.stance)) {
                cost = 0;
            } else if (Vec3d.ofBottomCenter(sight.stance).squaredDistanceTo(c.player.getPos()) <= 4
                && Math.abs(standing.getY() - sight.stance.getY()) <= 1) {
                cost = 2;
            } else {
                if (sight.rangeSquared > (REACH - 0.35) * (REACH - 0.35)) continue;
                for (int i = last; i >= 0 && last - i <= steps; i--) {
                    if (trail.get(i).equals(sight.stance)) {
                        route = i;
                        break;
                    }
                }
                if (route < 0 || route == last) continue;
                cost = 3 + last - route;
            }
            if (sight == oreProbe) cost -= 0.5;
            if (cost < score) {
                best = sight;
                waypoint = route;
                score = cost;
            }
        }
        if (best == null) return false;
        if (oreProbe != best) {
            oreProbe = best;
            oreProbeSince = tick;
            oreProbeMining = false;
        }
        status = "rechecking witnessed " + resource.label;
        if (waypoint >= 0) {
            if (!startReturn(waypoint, true)) {
                rejectOreProbe();
                return false;
            }
            // Travel has its own deadline; the viewpoint probe begins on arrival.
            oreProbeSince = 0;
            oreProbeReturning = true;
            return true;
        }
        if (oreProbeSince == 0) oreProbeSince = tick;
        if (!arrived(best.stance)) {
            if (tick - oreProbeSince < 60 && approach(best.feet, false, false) != Walk.BLOCKED)
                return true;
        } else {
            body.aim(best.point);
            BlockHitResult hit = perceive(best.point, range);
            if (hit != null && best.block.equals(hit.getBlockPos()) && resource.block.test(state(hit))
                && tools.canHarvest(state(hit))) {
                clearOreProbe();
                setTarget(hit, resource);
                mineTarget(resource);
                return true;
            }
            if (tick - oreProbeSince < 32) return true;
        }
        rejectOreProbe();
        return false;
    }

    private boolean probeReturnedOre() {
        OreSight sight = oreProbe;
        if (sight == null) return false;
        if (resumeIndex < 0 || !dryFieldFooting() || c.world != oreWorld) {
            rejectOreProbe();
            return false;
        }
        if (oreProbeMining) {
            if (target != null && target.equals(sight.block)) {
                if (!arrived(sight.stance)
                    || c.player.getEyePos().squaredDistanceTo(targetPoint) > (REACH - 0.35) * (REACH - 0.35)) {
                    rejectOreProbe();
                    return false;
                }
                mineTarget(sight.resource);
                return true;
            }
            if (collect(sight.resource.drop, 3.5)) return true;
            if (miningResource == sight.resource && tick < pickupUntil) {
                body.pauseWork();
                return true;
            }
            clearOreProbe();
            return false;
        }
        if (!arrived(sight.stance) || !reachableResourceFace(sight.block) || supportsTrail(sight.block)) {
            rejectOreProbe();
            return false;
        }
        if (oreProbeSince == 0) oreProbeSince = tick;
        status = "rechecking witnessed " + sight.resource.label + " from the returned footing";
        body.aim(sight.point);
        BlockHitResult hit = perceive(sight.point, REACH - 0.35);
        if (hit != null && sight.block.equals(hit.getBlockPos())) {
            BlockState material = state(hit);
            if (!sight.resource.block.test(material)) {
                forgetOre(sight.block);
                rejectOreProbe();
                return false;
            }
            if (tools.canHarvest(material)) {
                oreProbeMining = true;
                setTarget(hit, sight.resource);
                mineTarget(sight.resource);
                return true;
            }
        }
        if (tick - oreProbeSince < 32) return true;
        rejectOreProbe();
        return false;
    }

    private void rejectOreProbe() {
        OreSight rejected = oreProbe;
        if (rejected != null) {
            if (oreProbeMining && rejected.block.equals(target)) target = null;
            for (int i = oreSights.size() - 1; i >= 0; i--) {
                OreSight sight = oreSights.get(i);
                if (sight.block.equals(rejected.block) && sight.stance.equals(rejected.stance)) oreSights.remove(i);
            }
            if (rejectedOreSights.size() == ORE_MEMORY_LIMIT) rejectedOreSights.removeFirst();
            rejectedOreSights.add(rejected);
        }
        clearOreProbe();
    }

    private void clearOreProbe() {
        oreProbe = null;
        oreProbeSince = 0;
        oreProbeReturning = oreProbeMining = false;
    }

    private boolean returnToTimberBank() {
        timberSwimming = true;
        Vec3d feet = c.player.getPos();
        if (timberBank == null || horizontalDistance(timberBank, feet) < 0.38) {
            BlockHitResult shore = body.find(state -> state.isOf(Blocks.GRASS_BLOCK) || state.isIn(BlockTags.LOGS), 20).orElse(null);
            if (shore == null || shore.getPos().y < feet.y - 0.6) return false;
            Vec3d direction = shore.getPos().subtract(feet).multiply(1, 0, 1).normalize();
            status = "swimming toward visible shore for timber";
            return step(direction, false, true) != Walk.BLOCKED;
        }
        Vec3d back = timberBank.subtract(feet).multiply(1, 0, 1).normalize();
        status = "returning to the last dry bank for timber";
        return step(back, false, true) != Walk.BLOCKED;
    }

    private boolean surveyTimber() {
        Vec3d feet = c.player.getPos();
        if (timberCanopy != null) {
            if (tick < timberCanopyUntil) {
                if (!timberCanopyPeeking && horizontalDistance(feet, timberCanopy) > 1.8) {
                    var goal = new Vec3d(timberCanopy.x, timberCanopyFootY, timberCanopy.z);
                    Result result = navigate(Job.TIMBER, goal, 1.65);
                    if (result == Result.BLOCKED || result == Result.ARRIVED) timberCanopyPeeking = true;
                    return true;
                }
                timberCanopyPeeking = true;
                if (!bootstrapTimber && triedTimberLeaves.isEmpty() && horizontalDistance(feet, timberCanopy) <= 3.5
                    && timberCanopy.y >= feet.y + 1) {
                    body.aim(timberCanopy);
                    if (!body.aligned(timberCanopy)) return true;
                    BlockHitResult leaf = perceive(timberCanopy, REACH);
                    if (leaf != null && isTimberPassage(leaf)) {
                        beginTimberChop(leaf, true);
                        return true;
                    }
                }
            }
            rememberTimberSite(exhaustedCanopies, BlockPos.ofFloored(timberCanopy));
            timberCanopy = null;
            timberLookAt = tick + 75;
        }
        if (tick < timberLookAt) return false;
        BlockHitResult leaf = body.find(state -> state.isIn(BlockTags.LEAVES), 22,
            hit -> hit.getPos().y >= feet.y + 1 && horizontalDistance(feet, hit.getPos()) > 1.3
                && newTimberCanopy(hit.getBlockPos())).orElse(null);
        if (leaf != null) {
            timberCanopy = timberAim(leaf);
            timberCanopyFootY = feet.y;
            timberCanopyUntil = tick + 145;
            timberCanopyPeeking = false;
            timberLeafCuts = 0;
            triedTimberLeaves.clear();
            approachGoal = null;
            return true;
        }
        return false;
    }

    private boolean newTimberCanopy(BlockPos leaf) {
        for (int i = 0; i < exhaustedCanopies.size(); i++) {
            BlockPos prior = exhaustedCanopies.get(i);
            int dx = leaf.getX() - prior.getX(), dz = leaf.getZ() - prior.getZ();
            if (dx * dx + dz * dz <= 9) return false;
        }
        return true;
    }

    private void seekTimber() {
        seekTimber("timber");
    }

    private void seekTimber(String supplies) {
        seekTimber(supplies, false);
    }

    private boolean bootstrapCanopy(BlockPos from) {
        return bootstrapCanopy(from, false);
    }

    private boolean bootstrapCanopy(BlockPos from, boolean connectedReturn) {
        return AgentSupplyEgress.canopyContact(bootstrapSupport(from), bootstrapTimber, connectedReturn);
    }

    private BlockState bootstrapSupport(BlockPos from) {
        return bootstrapTimber ? exactCanopyContact(from) : null;
    }

    private BlockState exactCanopyContact(BlockPos from) {
        if (!safePickupStance() || c.player.getHealth() < 10 || resumeIndex >= 0
                || !from.down().equals(c.player.supportingBlockPos.orElse(null))) return null;
        return body.dryCaveContact(from);
    }

    record CanopyStep(BlockPos foot, BlockState top, int landedTick) {
        private static final int MAX_AGE = 240;

        static CanopyStep confirmed(BlockPos foot, BlockState base, BlockState top, int tick) {
            return base != null && top != null && AgentSupplyEgress.naturalDryLeaf(base)
                ? new CanopyStep(foot.toImmutable(), top, tick) : null;
        }

        private boolean supports(BlockPos foot, BlockState contact, int tick) {
            return this.foot.equals(foot) && top == contact && tick - landedTick <= MAX_AGE;
        }
    }

    static boolean firstStoneCanopyContact(BlockPos foot, BlockState support, CanopyStep step, int tick) {
        return support != null && (AgentSupplyEgress.naturalDryLeaf(support)
            || step != null && step.supports(foot, support, tick));
    }

    private void seekTimber(String supplies, boolean localOnly) {
        var player = c.player;
        if (!body.hasRecentView()) {
            if (timberExitTo != null && repositionForTimber()) return;
            if (woodPickupPending() && collect(pickupItem, 7)) return;
            if (timberCollectionGoal != null && advanceCollectionStance()) return;
            if (!continueTimberAttack()) status = "waiting for a rendered view of the timber route";
            return;
        }
        if (timberWitness != null && timberSeekTick != 0 && tick - timberSeekTick > 1) {
            // Real inventory work and hunger can interrupt the current tree; retain its witness.
            int paused = tick - timberSeekTick - 1;
            timberWorkUntil += paused;
            if (timberChop != null) {
                timberAlignUntil += paused;
                timberChopUntil += paused;
            }
        }
        timberSeekTick = tick;
        if (player.isTouchingWater()) {
            clearCollectionStance();
            if (pickupLogGoal != null) deferPickup(false);
            supplyLandmark = null;
            if (!timberSwimming) timberLookAt = tick;
            if (!returnToTimberBank()) {
                if (tick >= timberLookAt) {
                    timberLookYaw = player.getYaw() + 60;
                    timberLookAt = tick + 20;
                }
                body.turn(timberLookYaw, 1);
                status = "looking for a dry timber bank";
            }
            return;
        }
        if (player.isOnGround()) {
            timberBank = player.getPos();
            if (timberSwimming) {
                timberSwimming = false;
                timberLookAt = tick;
                heading = player.getYaw() + (++timberBankTurns % 2 == 0 ? 75 : -75);
                headingUntil = tick + 180;
            }
        }
        if (timberExitFrom != null && repositionForTimber()) return;
        if (timberCollectionGoal != null && advanceCollectionStance()) return;
        if (timberChop != null) {
            chopTimber();
            return;
        }
        if (tendTimberDrop()) return;
        if (collect(LOG, 7) || collect(PLANK, 7)) return;
        if (timberWitness != null && tendTimber()) return;
        if (startReachableTimber(true)) return;
        if (localOnly) return;
        BlockPos foot = player.getBlockPos();
        boolean canopy = bootstrapCanopy(foot);
        if (!canopy && ordinaryRouteTick != tick - 1 && supplyEgress.seek(supplies)) return;
        if (expedition != null && bootstrapTimber && applyWoodPreference()) return;
        BlockHitResult log = body.find(state -> state.isIn(BlockTags.LOGS), 22, this::timberCandidate).orElse(null);
        if (log != null) {
            witnessTimber(log);
            tendTimber();
            return;
        }
        if (canopy && timberCanopy != null) {
            rememberTimberSite(exhaustedCanopies, BlockPos.ofFloored(timberCanopy));
            timberCanopy = null;
        }
        if (!canopy && surveyTimber()) return;
        if (!ordinarySurfaceWork) return;
        if (bootstrapTimber && (woodPreference != WOODLAND || tick >= woodPreferenceUntil) && seekSurfaceSupply()) return;
        seekTimberGround();
    }

    private boolean woodPickupPending() {
        return pickupItem == LOG || pickupItem == PLANK;
    }

    private boolean continuingTimberTread() {
        return timberExitTo != null && ordinaryRouteTick == tick - 1 && ordinaryRouteJob == Job.TIMBER
            || woodPickupPending() && pickupTread != null && pickupTreadTick == tick - 1
            || (timberCollectionGoal != null || pickupLogGoal != null) && timberResourceTick == tick - 1;
    }

    private boolean tendTimberDrop() {
        if (timberDropUntil == 0) return woodPickupPending() && collect(pickupItem, 7);
        if (collect(timberDropItem, 7)) return true;
        if (hands.count(timberDropItem) > timberDropCount) {
            timberDropUntil = 0;
            return false;
        }
        body.pauseWork();
        if (tick < timberDropUntil) {
            lookAtTimberDropSite();
            status = timberDropItem == LOG ? "checking the trunk base for dropped logs"
                : "checking the witnessed cut for dropped planks";
            return true;
        }
        // A broken block did not supply wood. Don't keep cutting this stem from below.
        timberDropUntil = 0;
        return timberDropItem == LOG && timberWitness != null
            && finishTimber("no logs collected from the witnessed trunk base");
    }

    private void lookAtTimberDropSite() {
        if (timberLastCut == null) return;
        BlockPos site = timberLastCut;
        if (timberDropItem == LOG && timberWitness != null && timberWitness.getBlockPos().getY() < site.getY())
            site = timberWitness.getBlockPos();
        // Retain the known trunk/worksite rather than looking at an item bouncing through the canopy.
        body.aim(Vec3d.ofBottomCenter(site).add(0, -0.08, 0));
    }

    private boolean applyWoodPreference() {
        if (c.interactionManager.getCurrentGameMode() != GameMode.SURVIVAL) return false;
        if (woodOffer != null && tick - woodSearchTouched > 32) woodOffer = null;
        woodSearchTouched = tick;
        if (woodPreference == SALVAGE && tick < woodPreferenceUntil && supplyLandmark != null) {
            // Finish the chosen visible detour on ordinary overland proofs, not
            // by holding a model-specified bearing or cutting an unknown route.
            if (!seekSurfaceSupply()) seekTimberGround();
            return true;
        }
        if (woodOffer == null || tick < woodCheckAfter || !expedition.hasAdvice(woodOffer)
                || expeditionOffer() != woodOffer || !expeditionTurnReady())
            return false;
        woodCheckAfter = tick + 5;
        var plank = body.find(SUPPLY_WOOD, 16, hit -> !timberUnderfoot(hit.getBlockPos())
            && !supportsTrail(hit.getBlockPos()) && !triedSupplyCuts.contains(hit.getBlockPos())).orElse(null);
        if (plank == null) return false;
        var selected = expedition.take(woodOffer, true);
        if (selected == null) return false;
        woodOffer = null;
        woodPreferenceUntil = tick + 170;
        woodPreference = selected;
        supplyLandmark = null;
        if (selected == WOODLAND) return false;
        if (timberInReach(plank)) {
            rememberTimberSite(triedSupplyCuts, plank.getBlockPos());
            beginTimberChop(plank, false);
        } else {
            supplyLandmark = plank.getBlockPos();
            seekTimberGround();
        }
        return true;
    }

    private boolean seekSurfaceSupply() {
        if (collect(PLANK, 7)) {
            supplyLandmark = null;
            return true;
        }
        BlockHitResult plank = body.find(SUPPLY_WOOD, c.player.getBlockInteractionRange(),
            hit -> timberInReach(hit) && !timberUnderfoot(hit.getBlockPos()) && !supportsTrail(hit.getBlockPos())
                && !triedSupplyCuts.contains(hit.getBlockPos())).orElse(null);
        if (plank != null) {
            supplyLandmark = null;
            rememberTimberSite(triedSupplyCuts, plank.getBlockPos());
            beginTimberChop(plank, false);
            return true;
        }
        if (supplyLandmark != null) return false;
        var landmark = body.find(SUPPLY_WOOD, 16,
            hit -> !timberInReach(hit) && newSupplyLandmark(hit.getBlockPos())).orElse(null);
        if (landmark != null && expedition != null && !woodOffered) {
            woodOffered = true;
            woodOffer = new AgentExpedition.Offer("timber_source", WOODLAND, SALVAGE);
            woodOfferedUntil = tick + 200;
        }
        if (landmark == null && !has(table.item, 1))
            landmark = body.find(TABLE_BLOCK, 16, hit -> newSupplyLandmark(hit.getBlockPos())).orElse(null);
        if (landmark == null) return false;
        BlockPos block = landmark.getBlockPos();
        rememberTimberSite(checkedSupplyLandmarks, block);
        if (timberInReach(landmark) && TABLE_BLOCK.test(state(landmark))) {
            table.position = confirmStation(table, landmark);
            status = "witnessed a workspace; checking the surroundings for wood";
            return true;
        }
        supplyLandmark = block;
        return false;
    }

    private boolean newSupplyLandmark(BlockPos block) {
        for (BlockPos prior : checkedSupplyLandmarks)
            if (prior.getSquaredDistance(block) <= 16) return false;
        return true;
    }

    private void seekTimberGround() {
        if (supplyLandmark != null) {
            Result result = navigate(Job.TIMBER, Vec3d.ofBottomCenter(supplyLandmark), 2.4);
            if (result == Result.BLOCKED || result == Result.ARRIVED) supplyLandmark = null;
            return;
        }
        BlockPos foot = c.player.getBlockPos();
        if (bootstrapCanopy(foot) && surfaceApproach.visibleCanopyWork(foot, false)) return;
        navigate(Job.TIMBER, null, 0);
    }

    private void witnessTimber(BlockHitResult log) {
        if (bootstrapTimber && hands.stableCraftFooting())
            surfaceApproach.canopy.productive(c.player.getBlockPos(), log.getBlockPos());
        clearCollectionStance();
        supplyLandmark = null;
        timberWitness = log;
        timberCanopy = null;
        timberLastCut = null;
        timberShelfCheckedFrom = null;
        timberNear = false;
        timberLeafCuts = timberScan = 0;
        triedTimberLeaves.clear();
        timberSeekTick = tick;
        timberWorkUntil = tick + TIMBER_WORK_TICKS;
        approachGoal = null;
    }

    private boolean startReachableTimber(boolean searchView) {
        var wood = findTimber(searchView, reachableTrunk);
        if (wood == null) return false;
        witnessTimber(wood);
        chopFromTimberStance(wood);
        return true;
    }

    private boolean cutTimberFromTread(boolean searchView) {
        if (!hands.stableCraftFooting()) return false;
        var wood = findTimber(searchView, treadTrunk);
        if (wood == null) return false;
        witnessTimber(wood);
        beginTimberChop(wood, false);
        return true;
    }

    private boolean timberFromTread(BlockHitResult hit) {
        return settledTrunk.test(hit) && AgentSupplyEgress.timberAtTread(c.player.getBlockY(), hit.getBlockPos().getY());
    }

    private BlockHitResult findTimber(boolean searchView, Predicate<BlockHitResult> candidate) {
        if (!dryFieldFooting() || !safePickupStance()) return null;
        double reach = c.player.getBlockInteractionRange();
        BlockHitResult wood = null;
        if (c.crosshairTarget instanceof BlockHitResult pointed && pointed.getType() == HitResult.Type.BLOCK
                && state(pointed).isIn(BlockTags.LOGS) && candidate.test(pointed))
            wood = body.macroMineWitness(pointed, reach);
        if (wood == null && searchView)
            wood = body.find(state -> state.isIn(BlockTags.LOGS), reach, candidate).orElse(null);
        return wood;
    }

    private void chopFromTimberStance(BlockHitResult wood) {
        if (!dryFieldFooting() || !safePickupStance()) {
            status = "waiting for dry footing at the witnessed trunk";
            return;
        }
        if (!closeTimberStance(wood)) {
            approachTimberWorksite(wood);
            return;
        }
        cutFromSettledTimberStance(wood);
    }

    private void cutFromSettledTimberStance(BlockHitResult wood) {
        if (wood.getBlockPos().getY() > c.player.getBlockY() && tryHigherTimberShelf(wood)) return;
        beginTimberChop(wood, false);
        status = "preparing to cut the reachable log from this footing";
    }

    private boolean closeTimberStance(BlockHitResult log) {
        var player = c.player;
        Vec3d feet = player.getPos(), face = log.getPos();
        BlockPos trunk = log.getBlockPos();
        return feet.y <= trunk.getY() + 0.45 && AgentMacroControl.timberReadyToCut(true, feet, face,
            AgentMacroControl.timberWorkArrival(feet, face, trunk, player.getWidth())
                + AgentResourceStance.SETTLE_PAD, false);
    }

    static AgentResourceStance timberCollectionGoal(Vec3d feet, BlockPos trunk, Vec3d face, double width) {
        double arrival = AgentMacroControl.timberWorkArrival(feet, face, trunk, width) + 0.11;
        return new AgentResourceStance(face, arrival, Math.min(feet.y, trunk.getY()) - 0.45,
            trunk.getY() + 0.45);
    }

    private void approachTimberWorksite(BlockHitResult wood) {
        timberCollectionFace = wood;
        timberCollectionGoal = timberCollectionGoal(c.player.getPos(), wood.getBlockPos(), wood.getPos(), c.player.getWidth());
        advanceCollectionStance();
    }

    private boolean advanceCollectionStance() {
        var goal = timberCollectionGoal;
        var player = c.player;
        boolean driving = drivingTimberResource();
        if (!timberResourceAllowed(driving) || tick >= timberWorkUntil && !ordinarySurfaceWork) {
            return finishTimber("timber approach interrupted before safe footing");
        }
        if (tick >= timberWorkUntil)
            return finishTimber("timber approach expired before reaching a collection stance");
        timberResourceTick = tick;
        Vec3d feet = player.getPos();
        if (!driving && goal.reached(feet) && hands.stableCraftFooting()) {
            status = "rechecking the same trunk from the settled collection stance";
            if (!body.hasRecentView()) return true;
            BlockHitResult face = timberCollectionFace;
            Vec3d point = timberAim(face);
            body.aim(point);
            BlockHitResult live = perceive(point, player.getBlockInteractionRange());
            if (live != null && live.getBlockPos().equals(face.getBlockPos()) && state(live).isIn(BlockTags.LOGS)
                    && timberInReach(live) && !timberUnderfoot(live.getBlockPos())) {
                clearCollectionStance();
                cutFromSettledTimberStance(live);
                return true;
            }
            if (!body.aligned(point)) return true;
            if (ordinarySurfaceWork)
                return finishTimber("the settled collection stance did not reveal the witnessed log face");
            clearCollectionStance();
            return false;
        }
        if (navigate(Job.TIMBER, goal) == Result.BLOCKED)
            return finishTimber("no witnessed dry collection stance for this trunk");
        return true;
    }

    private boolean timberResourceAllowed(boolean driving) {
        return AgentResourceStance.allowsTravel(safePickupStance() && nextFoot == null && !oreProbeReturning,
            c.player.isOnGround(), driving, timberResourceTick == tick - 1);
    }

    private boolean drivingTimberResource() {
        return timberResourceTick == tick - 1 && ordinaryRouteTick == tick - 1 && navigator.driving(Job.TIMBER);
    }

    private void clearCollectionStance() {
        timberCollectionGoal = null;
        timberCollectionFace = null;
    }

    /** The supply caller retains its job only until an ordinary alternative or a physical refusal. */
    private final class SupplyEgress {
        private enum Proof {
            OPENING, LIP, CROWN, HEAD, FOOT, HIGH_CROWN, HIGH_HEAD, REVERSE_CROWN, LANDING,
            FOOTHOLD_SPACE, FOOTHOLD_ANCHOR, FOOTHOLD_RECEIPT
        }

        private static final int JOB_TICKS = 4800, LOOK_TICKS = 35, CUT_TICKS = 70;
        private static final int MAX_RISE = 48, MAX_LEVEL = 2, MAX_CUTS = 96, MAX_LANE_CUTS = 3;
        private static final int MAX_CONNECTORS = 2, MAX_FOOTHOLDS = 2, FOOTHOLD_RESERVE = 8, ANCHOR_TICKS = 24;
        private static final int OUTLINE_LOOK_TICKS = 46, OUTLINE_REAIM_TICKS = 23;
        private static final int OUTLINE_HAND_TICKS = 190;
        private static final Predicate<ItemStack> ANDESITE_FOOTHOLD = item(Items.ANDESITE), DIRT_FOOTHOLD = item(Items.DIRT);
        private static final Predicate<ItemStack> EMPTY_HAND = ItemStack::isEmpty;
        private static final float SURVEY_PITCH = -42;
        private final List<BlockPos> walked = new ArrayList<>();
        private final AgentSupplyEgress order = new AgentSupplyEgress();
        private final AgentSupplyEgress.OutlinePassage outline = new AgentSupplyEgress.OutlinePassage();
        private AgentSupplyEgress.ApexAccess restoredApex;
        private final BiPredicate<BlockPos, Direction> woodlandLane = this::woodlandLaneClear;
        private final Predicate<BlockPos> witnessedDryFlood = this::witnessedDryFloodCell;
        private boolean firstStoneExit;
        private ClientWorld world;
        private BlockPos openFoot, unknownFoot, to, armedCut, packedBench;
        private BlockPos floodOpening, floodWater;
        private Vec3d floor, alternateFloor, aim, buildLow, buildHigh, reverseLeft, reverseRight, outlineCutPoint;
        private Direction bearing, lane, apexSide;
        private Proof proof;
        private BlockState buildMaterial, apexSourceSupport, apexRiseSupport;
        private Predicate<ItemStack> buildStock;
        private String surveyActivity, crossingActivity, firstRefusal, lastRefusal, apexRefusal;
        private int deadline, since, view, views, openViews, roofViews, wallViews, handoffAfter;
        private int choice, flatBearings, driving, back, backEnd, rises, levels, cuts, laneCuts;
        private int benchBefore, benchCollectUntil, connectors, builds, buildBefore, buildReserve, anchorChoice;
        private int apexSearched, handClearSince = -1;
        private long revealedFrame;
        private boolean returning, walkedReturn, enclosed, surveying, sourceProved, lighting, triedLight, triedCraftLight;
        private boolean triedLower, built, mineDeparture, floodSource, checkingExit, buildLowProved;
        private boolean outlineReaimed, outlineApexChecked;

        boolean active() { return world == c.world && order.active(); }

        void observeBreak(BlockPos position, BlockState material) {
            if (world != c.world) return;
            order.observeBreak(position);
            if (!position.equals(armedCut)) return;
            var apex = outline.apexAccess();
            if (apex != null) {
                if (!apex.broken(position, material)) return;
                aim = null;
            }
            body.forgetSupplyOutlineCut();
            armedCut = null;
            handClearSince = -1;
            outlineCutPoint = null;
            outlineReaimed = false;
            revealedFrame = body.renderedFrame();
            since = tick;
            cuts++;
            laneCuts++;
            if (outline.active()) status = "supply egress: confirmed outlined cut at " + position.toShortString();
            if (material.isOf(table.block) && memory.ownsWorkbench(c.world, position)) {
                packedBench = position.toImmutable();
                benchCollectUntil = tick + 16;
                memory.forget(c.world, false, position);
                if (position.equals(table.position)) releaseTablePosition();
            }
        }

        boolean outdoors() {
            return world == c.world && dryFieldFooting() && c.player.getBlockPos().equals(openFoot)
                && !order.blocksFloodWork(openFoot, tick);
        }

        void observeOpenFoot(BlockPos foot) {
            if (world != c.world) {
                world = c.world;
                order.reset();
                unknownFoot = null;
            }
            if (!order.blocksFloodWork(foot, tick)) openFoot = foot;
        }

        boolean seek(String need) {
            if (c.player.hasVehicle()) return false;
            boolean grounded = dryFieldFooting();
            if (world != c.world) {
                world = c.world;
                order.reset();
                openFoot = unknownFoot = null;
            }
            BlockPos standing = c.player.getBlockPos();
            // Continue the ordinary timber traversal across a few recently walked tiles.
            // Only the stance itself, not this short excursion, counts as an outdoor departure.
            if (outdoors() || standing.equals(unknownFoot)) return false;
            if (grounded && openFoot != null && Math.abs(standing.getY() - openFoot.getY()) <= 1
                    && standing.getSquaredDistance(openFoot) <= 16) {
                int view = body.supplyPerspective(c.player.getYaw());
                if ((view & (AgentBody.SUPPLY_ROOF | AgentBody.SUPPLY_WALL))
                        != (AgentBody.SUPPLY_ROOF | AgentBody.SUPPLY_WALL)) return false;
            }
            if (grounded) order.recheckFloods(standing, tick, witnessedDryFlood);
            if (!order.begin(standing, grounded, tick)) return false;
            start(c.player.getHorizontalFacing(), tick + JOB_TICKS, false);
            surveyActivity = "supply egress: surveying the rendered roof and opening for " + need;
            return step();
        }

        boolean beginMineDeparture(BlockPos standing, Direction direction, int end) {
            if (world != c.world) {
                world = c.world;
                order.reset();
                openFoot = unknownFoot = null;
            }
            boolean grounded = dryFieldFooting();
            if (grounded) order.recheckFloods(standing, tick, witnessedDryFlood);
            if (!order.begin(standing, grounded, tick)) return false;
            start(direction, end, true);
            surveyActivity = "mine departure: checking for a supported ascent out of the enclosed area";
            return true;
        }

        void cancelMineDeparture() {
            if (!mineDeparture) return;
            mineDeparture = false;
            order.finish();
            resetOutline();
            to = armedCut = null;
            driving = 0;
        }

        boolean leaveDepletedQuarry() {
            boolean handled = seek("a different stone worksite and replacement timber");
            firstStoneExit = handled && active();
            return handled;
        }

        boolean canYieldToWorkshop() {
            return !outline.active() && driving == 0 && proof != Proof.FOOTHOLD_RECEIPT
                && (packedBench == null || has(table.item, benchBefore + 1) || tick >= benchCollectUntil);
        }

        void yieldToWorkshop() {
            order.finish();
            resetOutline();
            to = armedCut = packedBench = null;
        }

        private void start(Direction direction, int end, boolean resite) {
            mineDeparture = resite;
            firstStoneExit = false;
            deadline = end;
            bearing = direction;
            walked.clear();
            walked.add(order.foot());
            floodOpening = floodWater = null;
            floodSource = false;
            firstRefusal = lastRefusal = null;
            to = armedCut = packedBench = null;
            driving = 0;
            handoffAfter = tick;
            revealedFrame = -1;
            rises = levels = cuts = laneCuts = connectors = builds = 0;
            resetOutline();
            sourceProved = walkedReturn = lighting = triedLight = triedCraftLight = false;
            returning = !mineDeparture && findReturn();
            enclosed = returning && trail.get(backEnd).getY() >= order.foot().getY() + 2;
            survey(4);
        }

        boolean step() {
            if (!active()) {
                if (world != c.world || !order.holdOrdinary(airborne())) return false;
                body.pauseWork();
                return true;
            }
            boolean consumed = workStep();
            if (active()) stallGuard.navigationWork();
            return consumed;
        }

        boolean retreatFlood() {
            if (!active() || c.player.isInLava() || c.player.hasVehicle()) return false;
            boolean wet = c.player.isTouchingWater();
            if (!wet && floodWater == null) return false;
            BlockPos lip = order.foot();
            var retreat = order.flood(to, floodOpening, floodWater, floodSource, tick);
            resetOutline();
            if (openFoot != null && order.blocksFloodWork(openFoot, tick)) openFoot = null;
            if (unknownFoot != null && order.blocksFloodWork(unknownFoot, tick)) unknownFoot = null;
            to = armedCut = packedBench = floodOpening = floodWater = null;
            floodSource = false;
            driving = 0;
            status = "supply egress: " + (wet ? "flood reached the last walked footing at "
                : "water opened over the crossing from ") + lip.toShortString();
            body.pauseWork();
            interruptHands();
            boolean handedOff = retreat != null
                ? stallGuard.takeWalkedWaterReturn(retreat, stallReplan, stallRelease)
                : wet && stallGuard.takeAirTurn(stallReplan, stallRelease);
            if (handedOff) status = stallGuard.status();
            return true;
        }

        private boolean witnessedDryFloodCell(BlockPos cell) {
            var low = body.dryRouteClear(Vec3d.ofCenter(cell, 0.04));
            if (low != AgentBody.DryRouteSample.CLEAR && low != AgentBody.DryRouteSample.OBSTRUCTION) return false;
            var high = body.dryRouteClear(Vec3d.ofCenter(cell, 0.86));
            return high == AgentBody.DryRouteSample.CLEAR || high == AgentBody.DryRouteSample.OBSTRUCTION;
        }

        private boolean airborne() {
            return !c.player.isOnGround() && !c.player.isTouchingWater() && !c.player.isInLava()
                && !c.player.hasVehicle();
        }

        private boolean workStep() {
            BlockPos from = order.foot();
            if (tick >= deadline) return stop("finite exit search exhausted");
            if (outline.active() && (!ordinaryCaveDrops || !body.ordinaryOutlineExitEnabled()))
                return stop("ordinary outline exit no longer allowed");
            if (c.player.isTouchingWater() || c.player.isInLava() || c.player.hasVehicle())
                return stop("lost dry on-foot contact");
            if (driving == 0) {
                // Only a still-witnessed crossing may keep an airborne movement turn.
                if (!dryFieldFooting()) return stop("lost ground contact outside a witnessed crossing");
                if (!from.equals(c.player.getBlockPos()))
                    return stop("left the connected footing before the next crossing");
                if (outline.active() && !outline.withinTime(tick)) return stop("short outline exit time limit reached");
            }
            if (!body.hasRecentView()) {
                body.pauseWork();
                if (driving != 0 && tick - driving >= 45)
                    return stop("lost the rendered crossing before a settled landing");
                if (!surveying && to == null) status = "supply egress: waiting for a rendered view";
                return true;
            }
            var apex = outline.apexAccess();
            if (restoredApex != null && (!retainsApexSupports(restoredApex) || apexFloodBlocked(restoredApex)))
                return refuse("the reverified rise changed after returning from the side tread");
            if (driving != 0) return apex == null ? drive() : driveApexAccess(apex);
            if (packedBench != null && has(table.item, benchBefore + 1)) {
                packedBench = null;
                status = "supply egress: recovered the obstructing portable crafting table";
                return true;
            }
            if (!settled(from)) {
                status = "supply egress: centering on the witnessed support";
                if (tick - since >= LOOK_TICKS) return stop("no settled full-width takeoff stance");
                centerSupplyFoot(from);
                return true;
            }
            if (outline.active() && !actualOutlineFoot(from))
                return stop("lost actual full, dry outline takeoff support");
            if (apex != null) return workApexAccess(apex);
            if (!mineDeparture && packedBench == null && ordinaryHandoff(from)) return true;
            if (surveying) return look();
            if (packedBench != null && tick < benchCollectUntil) {
                body.aim(Vec3d.ofBottomCenter(packedBench));
                status = "supply egress: waiting for the portable crafting table drop from safe footing";
                return true;
            }
            if (lighting) {
                status = "supply egress: lighting the selected crossing from settled footing";
                if (shouldLight(true)) return true;
                lighting = false;
                since = tick;
            }
            if (!sourceProved) {
                if (outline.active()) return proveOutlineSource(from);
                if (aim == null) aim = Vec3d.ofBottomCenter(from).add(0, -0.035, 0);
                body.aim(aim);
                switch (body.dryRouteTop(aim, from.down())) {
                    case WITNESSED -> { sourceProved = true; aim = null; }
                    case DARK -> {
                        if (tryLight()) return true;
                        if (!beginOutline(from)) return stop("takeoff top is too dark to verify");
                    }
                    case FLUID -> { return refuseFluid(from.down(), aim, "takeoff has no stable, dry full top"); }
                    case NO_FULL_TOP -> { return stop("takeoff has no stable, dry full top"); }
                    default -> { }
                }
                if (!sourceProved && outline.active()) return true;
                if (!sourceProved && !lighting && tick - since >= LOOK_TICKS)
                    return stop("could not witness a stable, dry takeoff top");
                status = "supply egress: verifying the takeoff support";
                return true;
            }
            if (to == null && !choose()) return true;
            if (order.avoidFlood(to, tick)) return refuse("crossing leads into the recent flood");
            if (mineDeparture && !mineResite.eligibleReturn(from, to)) return refuse("the directed tread was already refused");
            if (body.hazardAhead(lane.getPositiveHorizontalDegrees(), 1.5))
                return refuse("visible lava near the selected crossing");
            if (outline.active() && revealedFrame == body.renderedFrame()) return true;
            status = crossingActivity;
            if (revealedFrame == body.renderedFrame()) return true;
            return switch (proof) {
                case LIP, LANDING -> proveTop();
                case REVERSE_CROWN -> proveReverseCrown();
                case FOOTHOLD_SPACE -> proveBuildSpace();
                case FOOTHOLD_ANCHOR -> attachFoothold();
                case FOOTHOLD_RECEIPT -> confirmFoothold();
                default -> clearance();
            };
        }

        private boolean ordinaryHandoff(BlockPos from) {
            if (body.lavaEmergency() || body.macroLavaNear()) return false;
            if (outline.active()) {
                // A cut, a light glimpse, or a settled subterranean tread isn't an exit.
                if (!outline.canHandoff() || !surveying || tick < handoffAfter) return false;
                handoffAfter = tick + 5;
                float yaw = body.defensiveViewYaw();
                if (order.handoffWoodland(body.dryCaveProbeView(), Direction.fromHorizontalDegrees(yaw), woodlandLane))
                    return surfaceReady(from, yaw, "confirmed walkable woodland after short outline passage");
                return false;
            }
            if (tick < handoffAfter) return handoffTimber(false);
            handoffAfter = tick + 5;
            if (firstStoneExit) {
                if (has(STONE, 3)) {
                    if (affordsWood(localTableWood(), 2)) return ready("stone pick materials collected on the way out");
                } else {
                    var stone = findOre(Resource.STONE, REACH - 0.35);
                    if (stone != null && stoneStockFace(stone.getBlockPos()) && tools.canHarvest(state(stone))) {
                        setTarget(stone, Resource.STONE);
                        quarryingStoneStock = true;
                        return ready("collectible stone exposed on the supply stair");
                    }
                }
            }
            float yaw = body.defensiveViewYaw();
            if (body.dryCaveContact(from) != null && order.handoffWoodland(body.dryCaveProbeView(),
                    Direction.fromHorizontalDegrees(yaw), woodlandLane))
                return surfaceReady(from, yaw, "confirmed walkable woodland");
            if (collectLocalDrop(LOG) || collectLocalDrop(PLANK))
                return ready("ordinary pickup from connected footing");
            if (handoffTimber(true)) return true;
            if (bootstrapCanopy(from, returning || walkedReturn)) {
                unknownFoot = from;
                return ready("handing the canopy footing to ordinary timber travel");
            }
            return false;
        }

        private boolean handoffTimber(boolean searchView) {
            if (!cutTimberFromTread(searchView)) return false;
            body.pauseWork();
            return ready("reachable timber from connected footing");
        }

        private boolean woodlandLaneClear(BlockPos next, Direction bearing) {
            BlockPos from = order.foot();
            return !order.blocksFloodWork(next, tick) && body.walkedLaneDry(from, next, bearing)
                && body.dryRouteVeto(from, next) == AgentBody.DryRouteVeto.CLEAR;
        }

        private boolean collectLocalDrop(Predicate<ItemStack> drop) {
            if (tick < pickupBlockedUntil && pickupBlockedItem == drop) return false;
            ItemEntity entity = body.dropped(drop, 3.25).orElse(null);
            return entity != null && Math.abs(entity.getY() - c.player.getY()) <= 0.55
                && collectObserved(drop, entity, true);
        }

        private boolean tryLight() {
            if (triedLight) return false;
            if (!has(TORCH, 1)) {
                if (triedCraftLight) return false;
                triedCraftLight = true;
                if (!craftTorches(4)) return false;
                since = tick;
                return true;
            }
            triedLight = lighting = true;
            startReturnableLight();
            return true;
        }

        private boolean actualOutlineFoot(BlockPos from) {
            return from.down().equals(c.player.supportingBlockPos.orElse(null)) && body.dryCaveContact(from) != null;
        }

        private boolean beginOutline(BlockPos from) {
            if (outline.active()) return true;
            if (!ordinaryCaveDrops || !body.ordinaryOutlineExitEnabled() || !actualOutlineFoot(from)
                    || body.lavaEmergency() || body.macroLavaNear()) return false;
            outline.begin(from, tick);
            since = tick;
            aim = null;
            return true;
        }

        private boolean restartCrossingUnderOutline() {
            BlockPos from = order.foot();
            if (!beginOutline(from)) return false;
            sourceProved = false;
            if (outline.allowsLeg(from, to)) phase(Proof.OPENING);
            else {
                to = null;
                returning = false;
                armedCut = null;
            }
            return true;
        }

        private boolean proveOutlineSource(BlockPos from) {
            if (aim == null) aim = Vec3d.ofBottomCenter(from)
                .add(bearing.getOffsetX() * 0.24, -0.025, bearing.getOffsetZ() * 0.24);
            body.aim(aim);
            BlockPos support = from.down();
            var lit = body.dryRouteTop(aim, support);
            if (lit == AgentBody.DryRouteTop.WITNESSED) {
                sourceProved = true;
                aim = null;
                return true;
            }
            if (lit == AgentBody.DryRouteTop.FLUID || lit == AgentBody.DryRouteTop.NO_FULL_TOP)
                return stop("takeoff has no stable, dry full top");
            if (lit == AgentBody.DryRouteTop.DARK && tryLight()) return true;
            if (body.supplyOutlineTop(from, support)) {
                sourceProved = true;
                aim = null;
                status = "supply egress: authentic dark takeoff verified at " + from.toShortString();
                return true;
            }
            status = "supply egress: looking for the current support's close outline";
            return tick - since < OUTLINE_LOOK_TICKS || stop("no matching close outline of the actual dry takeoff top");
        }

        private boolean findReturn() {
            BlockPos from = order.foot();
            back = trail.lastIndexOf(from);
            if (back < 1 || back >= activeTrail()) return false;
            backEnd = back;
            int rise = 0;
            while (backEnd > 0) {
                BlockPos a = trail.get(backEnd), b = trail.get(backEnd - 1);
                if (!cardinal(a, b) || back - backEnd >= 72) break;
                rise += b.getY() - a.getY();
                backEnd--;
                if (b.equals(openFoot) || b.equals(fieldWood.harvestFoot)) return true;
            }
            return backEnd < back && rise >= 2;
        }

        private void survey(int count) {
            surveying = true;
            checkingExit = false;
            views = count;
            view = openViews = roofViews = wallViews = 0;
            since = tick;
            aim = null;
        }

        private boolean look() {
            if ((!outline.active() || outline.canHandoff()) && outdoors())
                return ready(outline.active() ? "returned to confirmed open ground after short outline passage" : "confirmed open ground");
            BlockPos from = order.foot();
            if (checkingExit) {
                float outward = bearing.getPositiveHorizontalDegrees();
                body.turn(outward, 47);
                status = "supply egress: checking for walkable ground beyond the opening";
                boolean aligned = body.renderedDirection(outward, 47, 9);
                if (!aligned && tick - since < LOOK_TICKS) return true;
                if ((!outline.active() || aligned && outline.canHandoff())
                        && order.handoffSurface(body.dryCaveProbeView(), bearing, woodlandLane))
                    return surfaceReady(from, outward, outline.active()
                        ? "confirmed open ground with a connected lane after short outline passage"
                        : "confirmed open ground with a connected lane");
                // Seeing daylight through a hole doesn't put the player's feet on its rim.
                // Keep ownership for the ordinary checked rise in that direction.
                checkingExit = surveying = false;
                enclosed = true;
                choice = flatBearings = 0;
                since = tick;
                return true;
            }
            Direction direction = option(view);
            float yaw = direction.getPositiveHorizontalDegrees();
            int age = tick - since;
            if (outline.active()) {
                body.turn(yaw, SURVEY_PITCH);
                status = "supply egress: looking along the outline passage for a visible opening";
                boolean aligned = body.renderedDirection(yaw, SURVEY_PITCH, 8);
                if (!aligned && age < LOOK_TICKS) return true;
                since = tick;
                if (aligned && (body.supplyPerspective(yaw) & AgentBody.SUPPLY_OPEN) != 0) {
                    checkingExit = true;
                    return true;
                }
                surveying = false;
                choice = flatBearings = 0;
                return true;
            }
            float pitch = age < LOOK_TICKS ? SURVEY_PITCH : age < 2 * LOOK_TICKS ? -13 : -73;
            body.turn(yaw, pitch);
            status = surveyActivity;
            boolean aligned = body.renderedDirection(yaw, pitch, 8);
            if (!aligned && age < 3 * LOOK_TICKS) return true;
            int scene = body.supplyPerspective(yaw);
            int bit = 1 << view;
            if ((scene & AgentBody.SUPPLY_OPEN) != 0) openViews |= bit;
            if ((scene & AgentBody.SUPPLY_ROOF) != 0) roofViews |= bit;
            if ((scene & AgentBody.SUPPLY_WALL) != 0) wallViews |= bit;
            if (Integer.bitCount(openViews) >= 2) {
                bearing = option(Integer.numberOfTrailingZeros(openViews));
                checkingExit = true;
                since = tick;
                return true;
            }
            // A single open sector may be the mouth of a shaft. Corroborate it across bearings.
            if (views == 1 && openViews != 0) views = 4;
            if ((openViews & bit) == 0 && age < 3 * LOOK_TICKS
                    && ((roofViews & wallViews & bit) == 0) && (views > 1 || roofViews == 0)) return true;
            boolean wallsAndRoof = roofViews != 0 && Integer.bitCount(wallViews) >= 2;
            if (++view < views && (!wallsAndRoof || openViews != 0)) {
                since = tick;
                return true;
            }
            surveying = false;
            choice = flatBearings = 0;
            since = tick;
            enclosed |= wallsAndRoof;
            if (openViews != 0) bearing = option(Integer.numberOfTrailingZeros(openViews));
            else if (!returning) {
                BlockPos bench = memory.ownedWorkbench(c.world);
                if (bench != null && bench.getY() == from.getY() + 1 && cardinal(from, bench))
                    bearing = directional(Vec3d.ofBottomCenter(bench).subtract(Vec3d.ofBottomCenter(from)));
            }
            if (!enclosed && !returning && walked.size() == 1) {
                // An inconclusive roofless view isn't a cave, including in treeless terrain.
                if (mineDeparture) return ready("no enclosure witnessed for a supported ascent");
                unknownFoot = from;
                return ready("no enclosure observed; continuing ordinary timber traversal");
            }
            return true;
        }

        private Direction option(int index) {
            return switch (index & 3) {
                case 0 -> bearing;
                case 1 -> bearing.rotateYClockwise();
                case 2 -> bearing.rotateYCounterclockwise();
                default -> bearing.getOpposite();
            };
        }

        private boolean choose() {
            BlockPos from = order.foot();
            laneCuts = 0;
            triedLower = built = false;
            if (outline.active() && returning && !outline.allowsLeg(from, trail.get(back - 1))) returning = false;
            if (returning) {
                to = trail.get(back - 1);
                lane = directional(Vec3d.ofBottomCenter(to).subtract(Vec3d.ofBottomCenter(from)));
            } else {
                if (rises >= MAX_RISE) {
                    stop("inclined exit reached its rise limit without an observed opening");
                    return false;
                }
                int limit = levels < MAX_LEVEL ? 8 : 4;
                while (choice < limit) {
                    lane = option(choice);
                    boolean flat = choice++ >= 4;
                    if (flat && (flatBearings & 1 << lane.ordinal()) != 0) continue;
                    BlockPos candidate = from.offset(lane).up(flat ? 0 : 1);
                    if (!walked.contains(candidate) && (!outline.active() || outline.allowsLeg(from, candidate))
                            && !order.avoidFlood(candidate, tick)) {
                        if (flat) flatBearings |= 1 << lane.ordinal();
                        to = candidate;
                        break;
                    }
                }
                if (to == null) {
                    stop((outline.active() ? "no distinct, witnessable same-grade or rising outline continuation"
                            : "no safe inclined continuation from this stance")
                        + (firstRefusal == null ? "" : " (" + firstRefusal
                            + (firstRefusal.equals(lastRefusal) ? "" : "; last: " + lastRefusal) + ")"));
                    return false;
                }
            }
            setCrossing();
            phase(Proof.OPENING);
            return true;
        }

        private void setCrossing() {
            BlockPos from = order.foot();
            outlineApexChecked = false;
            apexSourceSupport = apexRiseSupport = null;
            restoredApex = null;
            order.considered(from.up(2));
            order.considered(from.offset(lane).up());
            order.considered(to.down());
            order.considered(to);
            order.considered(to.up());
            order.considered(to.up(2));
            Vec3d center = Vec3d.ofBottomCenter(to).add(0, -0.025, 0);
            floor = center.add(lane.getOffsetX() * 0.35, 0, lane.getOffsetZ() * 0.35);
            alternateFloor = center.add(lane.getOffsetX() * 0.14, 0, lane.getOffsetZ() * 0.14);
            crossingActivity = "supply egress: " + (returning ? "retracing walked footing" : "proving an inclined exit")
                + " toward " + to.toShortString();
        }

        private void phase(Proof next) {
            since = tick;
            proof = next;
            armedCut = null;
            handClearSince = -1;
            body.forgetSupplyOutlineCut();
            outlineCutPoint = null;
            outlineReaimed = false;
            aim = null;
        }

        private boolean proveTop() {
            if (outline.active()) return proveOutlineTop();
            BlockPos from = order.foot();
            boolean risingLip = proof == Proof.LIP;
            // This is sampled after the visible side face has opened. A previous
            // obstruction or an opaque face is not evidence of what's behind it.
            body.aim(floor);
            BlockPos support = to.down();
            Vec3d sample = floor;
            AgentBody.DryRouteTop top = body.dryRouteTop(floor, support);
            if (top != AgentBody.DryRouteTop.WITNESSED && top != AgentBody.DryRouteTop.FLUID) {
                AgentBody.DryRouteTop other = body.dryRouteTop(alternateFloor, support);
                if (other == AgentBody.DryRouteTop.WITNESSED || other == AgentBody.DryRouteTop.FLUID
                        || top == AgentBody.DryRouteTop.OUT_OF_VIEW) {
                    top = other;
                    sample = alternateFloor;
                }
            }
            switch (top) {
                case WITNESSED -> {
                    if (risingLip) {
                        phase(Proof.CROWN);
                        return true;
                    }
                    var veto = body.dryRouteVeto(from, to);
                    if (veto != AgentBody.DryRouteVeto.CLEAR) {
                        if ((veto == AgentBody.DryRouteVeto.SWEEP || veto == AgentBody.DryRouteVeto.SUPPORT)
                                && tryFootholdAfterLower()) return true;
                        return refuse(vetoReason(veto));
                    }
                    driving = tick;
                    return drive();
                }
                case FLUID -> {
                    return refuseFluid(support, sample, "fluid covers the observed supporting top at " + support.toShortString());
                }
                case NO_FULL_TOP -> {
                    if (!body.renderedAim(floor, 10) && tick - since < LOOK_TICKS) return true;
                    // The missed lip can be an ordinary flat stretch. Do not cut
                    // whichever block might have been underneath that empty lip.
                    BlockPos flat = to.down();
                    if (risingLip && !returning && levels < MAX_LEVEL && !walked.contains(flat)
                            && body.renderedAim(floor, 10) && body.clearTerrain(floor)) {
                        flatBearings |= 1 << lane.ordinal();
                        to = flat;
                        setCrossing();
                        phase(Proof.FOOT);
                        return true;
                    }
                    if (!risingLip && !returning && !built && to.getY() == from.getY()
                            && body.renderedAim(floor, 10) && body.clearTerrain(floor)) {
                        if (!triedLower && connectors < MAX_CONNECTORS) {
                            BlockPos lower = to.down();
                            if (!walked.contains(lower)) {
                                triedLower = true;
                                to = lower;
                                setCrossing();
                                phase(Proof.HEAD);
                                return true;
                            }
                        }
                        return beginFoothold();
                    }
                    if (tryFootholdAfterLower()) return true;
                    return refuse("no confirmed stable full top at " + support.toShortString());
                }
                case DARK -> {
                    if (body.renderedAim(floor, 8)) {
                        if (tryLight()) return true;
                        if (restartCrossingUnderOutline()) return true;
                        if (tryFootholdAfterLower()) return true;
                        return refuse("not enough visible light to identify the supporting top at " + support.toShortString());
                    }
                }
                default -> { }
            }
            return tick - since < LOOK_TICKS || tryFootholdAfterLower()
                || refuse("supporting top still occluded after opening the side face at " + support.toShortString());
        }

        private boolean proveOutlineTop() {
            BlockPos from = order.foot(), support = to.down();
            boolean lip = proof == Proof.LIP;
            Vec3d sample = tick - since < OUTLINE_REAIM_TICKS ? floor : alternateFloor;
            body.aim(sample);
            status = "supply egress: looking for the close " + (lip ? "rise lip" : "landing top")
                + " outline at " + support.toShortString();
            if (body.supplyOutlineTop(from, support)) {
                if (lip) {
                    phase(Proof.CROWN);
                    return true;
                }
                var veto = body.dryRouteVeto(from, to);
                if (veto != AgentBody.DryRouteVeto.CLEAR) return refuse(vetoReason(veto));
                if (!body.walkedLaneDry(from, to, lane))
                    return refuse("outline landing or its exact crossing no longer holds dry");
                if (to.getY() > from.getY()) {
                    var grade = body.supplyOutlineGradeVeto(from, to);
                    if (grade == AgentBody.DryRouteVeto.SWEEP && !outlineApexChecked) {
                        // Only the upper band failed: look at the two exact crown cells;
                        // a physical veto alone does not give us a cut target or material.
                        apexSourceSupport = body.dryCaveContact(from);
                        apexRiseSupport = body.supplyOutlineState(body.supplyOutlineFace());
                        outlineApexChecked = true;
                        order.considered(from.up(3));
                        phase(Proof.HIGH_CROWN);
                        return true;
                    }
                    if (grade != AgentBody.DryRouteVeto.CLEAR) return refuse(vetoReason(grade));
                }
                if (!outline.admitLanding(from, to)) return refuse("short outline crossing is no longer eligible");
                driving = tick;
                return drive();
            }
            var lit = body.dryRouteTop(sample, support);
            if (lit == AgentBody.DryRouteTop.FLUID)
                return refuseFluid(support, sample, "fluid covers the selected landing");
            if (body.supplyOutlineClear(sample)) {
                // A backstop through the expected lip can justify checking a level alternative,
                // but it neither supplies its support nor proves the full placement cell is empty.
                BlockPos flat = to.down();
                if (lip && !returning && levels < MAX_LEVEL && !walked.contains(flat)
                        && outline.allowsLeg(from, flat) && !order.avoidFlood(flat, tick)) {
                    flatBearings |= 1 << lane.ordinal();
                    to = flat;
                    setCrossing();
                    phase(Proof.FOOT);
                    return true;
                }
                if (!lip && !returning && !built && to.getY() == from.getY()) return beginFoothold();
            }
            return tick - since < OUTLINE_LOOK_TICKS
                || refuse("no matching, stable " + (lip ? "rise lip" : "landing top") + " outline at " + support.toShortString());
        }

        private boolean beginApexAccess(BlockHitResult hit) {
            BlockPos from = order.foot();
            if (proof != Proof.HIGH_CROWN || armedCut != null || !outline.allowsCut(hit.getBlockPos())
                    || apexSourceSupport == null || apexSourceSupport != body.dryCaveContact(from)
                    || apexRiseSupport == null || c.world.getBlockState(to.down()) != apexRiseSupport
                    || body.dryRouteVeto(from, to) != AgentBody.DryRouteVeto.CLEAR
                    || body.supplyOutlineGradeVeto(from, to) != AgentBody.DryRouteVeto.SWEEP
                    || !body.walkedLaneDry(from, to, lane)
                    || !body.supplyOutlineCutObstructedByUnknownOverhead(hit))
                return false;
            var apex = outline.beginApexAccess(from, to, hit, body.supplyOutlineState(hit),
                apexSourceSupport, apexRiseSupport);
            if (apex == null) return false;
            body.pauseWork();
            phase(Proof.HIGH_CROWN);
            apexSide = null;
            apexSearched = 1 << lane.ordinal(); // The rise lip is not a spare same-level tread.
            apexRefusal = null;
            status = "supply egress: finding a dry side tread outside the outlined apex column";
            return true;
        }

        private boolean retainsApexSupports(AgentSupplyEgress.ApexAccess apex) {
            // Only compare the exact support states already admitted by rendered top witnesses.
            return c.world.getBlockState(apex.source.down()) == apex.sourceSupport
                && c.world.getBlockState(apex.rise.down()) == apex.riseSupport;
        }

        private boolean apexFloodBlocked(AgentSupplyEgress.ApexAccess apex) {
            return order.avoidFlood(apex.source, tick) || order.avoidFlood(apex.rise, tick)
                || order.avoidFlood(apex.cell, tick) || apex.side() != null && order.avoidFlood(apex.side(), tick);
        }

        private boolean apexAccessSafe(AgentSupplyEgress.ApexAccess apex) {
            return !body.lavaEmergency() && !body.macroLavaNear() && !apexFloodBlocked(apex)
                && retainsApexSupports(apex)
                && (apex.side() == null || c.world.getBlockState(apex.side().down()) == apex.sideSupport());
        }

        private boolean workApexAccess(AgentSupplyEgress.ApexAccess apex) {
            if (!apexAccessSafe(apex)) return stop("apex approach support or danger changed");
            if (body.renderedFrame() == revealedFrame) return true;
            return switch (apex.stage()) {
                case LOOK_SIDE -> findApexSide(apex);
                case CUT -> cutApexFromSide(apex);
                case LOOK_BACK -> checkApexReturn(apex);
                default -> throw new IllegalStateException("No apex access work in " + apex.stage());
            };
        }

        private Direction nextApexSide(BlockPos from) {
            BlockPos previous = order.previousLevelFoot(from);
            if (previous != null) {
                Direction prior = directional(Vec3d.ofBottomCenter(previous).subtract(Vec3d.ofBottomCenter(from)));
                if ((apexSearched & 1 << prior.ordinal()) == 0) return prior;
            }
            Direction opposite = lane.getOpposite();
            if ((apexSearched & 1 << opposite.ordinal()) == 0) return opposite;
            Direction right = lane.rotateYClockwise();
            if ((apexSearched & 1 << right.ordinal()) == 0) return right;
            Direction left = lane.rotateYCounterclockwise();
            return (apexSearched & 1 << left.ordinal()) == 0 ? left : null;
        }

        private Vec3d apexTreadAim(BlockPos foot, Direction outward) {
            boolean alternate = tick - since >= OUTLINE_REAIM_TICKS;
            if (aim == null || alternate && !outlineReaimed) {
                outlineReaimed = alternate;
                double offset = alternate ? 0.14 : 0.34;
                aim = Vec3d.ofBottomCenter(foot).add(outward.getOffsetX() * offset, -0.025, outward.getOffsetZ() * offset);
            }
            return aim;
        }

        private boolean findApexSide(AgentSupplyEgress.ApexAccess apex) {
            if (apexSide == null) {
                apexSide = nextApexSide(apex.source);
                if (apexSide == null)
                    return abandonApexAtSource(apex, "no separately witnessed level support beside the apex");
                apexSearched |= 1 << apexSide.ordinal();
                aim = null;
                since = tick;
            }
            BlockPos side = apex.source.offset(apexSide);
            if (order.avoidFlood(side, tick)) {
                apexSide = null;
                return true;
            }
            Vec3d sample = apexTreadAim(side, apexSide);
            body.aim(sample);
            status = "supply egress: checking the nearby drawn top at " + side.down().toShortString();
            if (body.supplyOutlineTop(apex.source, side.down())) {
                BlockState support = body.supplyOutlineState(body.supplyOutlineFace());
                if (body.walkedLaneDry(apex.source, side, apexSide)
                        && body.dryRouteVeto(apex.source, side) == AgentBody.DryRouteVeto.CLEAR
                        && apex.admitOut(side, support)) {
                    driving = tick;
                    return driveApexAccess(apex);
                }
                apexSide = null;
            } else if (tick - since >= OUTLINE_LOOK_TICKS) apexSide = null;
            return true;
        }

        private boolean cutApexFromSide(AgentSupplyEgress.ApexAccess apex) {
            if (c.player.getVelocity().horizontalLengthSquared() > 0.0025) return true;
            body.watchSupplyOutlineCut(apex.cell);
            if (aim == null) aim = inward(apex.face);
            body.aim(outlineCutPoint == null ? aim : outlineCutPoint);
            status = "supply egress: re-witnessing the exact outlined apex from adjacent dry support";
            BlockHitResult hit = body.supplyOutlineFace();
            if (hit != null && apex.cell.equals(hit.getBlockPos()) && body.renderedAim(aim, 10)) {
                if (!apex.matchesCut(hit, body.supplyOutlineState(hit)))
                    return leaveApexCut(apex, "the exposed apex contact changed");
                return cutOutline(apex.cell, hit);
            }
            if (handClearSince >= 0) {
                if (hit == null) return continueHandClearance(apex.cell);
                return leaveApexCut(apex, "the outlined hand-clearance contact changed");
            }
            return tick - since < (outlineCutPoint == null ? OUTLINE_LOOK_TICKS : CUT_TICKS)
                || leaveApexCut(apex, "no fresh match for the exposed apex face from the side tread");
        }

        private boolean leaveApexCut(AgentSupplyEgress.ApexAccess apex, String why) {
            apex.abandonCut();
            apexRefusal = why;
            body.pauseWork();
            phase(Proof.HIGH_CROWN);
            return true;
        }

        private boolean checkApexReturn(AgentSupplyEgress.ApexAccess apex) {
            Direction back = apexSide.getOpposite();
            body.aim(apexTreadAim(apex.source, back));
            status = "supply egress: rechecking the original takeoff top before walking back";
            if (body.supplyOutlineTop(apex.side(), apex.source.down())) {
                if (!body.walkedLaneDry(apex.side(), apex.source, back)
                        || body.dryRouteVeto(apex.side(), apex.source) != AgentBody.DryRouteVeto.CLEAR
                        || !apex.admitBack()) return stop("the re-witnessed return sweep no longer holds dry");
                driving = tick;
                return driveApexAccess(apex);
            }
            return tick - since < OUTLINE_LOOK_TICKS || stop("no freshly drawn return top beneath the original rise");
        }

        private boolean driveApexAccess(AgentSupplyEgress.ApexAccess apex) {
            boolean outward = apex.stage() == AgentSupplyEgress.ApexAccess.Stage.WALK_OUT;
            BlockPos from = outward ? apex.source : apex.side(), target = outward ? apex.side() : apex.source;
            Direction move = outward ? apexSide : apexSide.getOpposite();
            if (!apexAccessSafe(apex) || !body.walkedLaneDry(from, target, move)
                    || body.dryRouteVeto(from, target) != AgentBody.DryRouteVeto.CLEAR)
                return outward ? abandonApexAtSource(apex, "repositioning did not reach the re-witnessed side top")
                    : stop("could not settle back onto the original apex takeoff");
            if (settled(target)) {
                if (!apex.landed(target, actualOutlineFoot(target)))
                    return stop("no actual dry support contact on the repositioning tread");
                // Keep this real leg only for connected-footing and flood safety; it grants no fresh coverage.
                order.landed(target);
                body.pauseWork();
                driving = 0;
                revealedFrame = body.renderedFrame();
                phase(Proof.HIGH_CROWN);
                if (outward) {
                    status = "supply egress: settled off the apex column at " + target.toShortString();
                    return true;
                }
                if (!outline.finishApexAccess(target)) return stop("no exact apex return receipt");
                if (!apex.opened()) return refuse(apexRefusal);
                setCrossing();
                restoredApex = apex;
                sourceProved = false;
                // The earlier dry opening receipts still nominate this exact lane; both tops and
                // the full-width physical, fluid and apex sweeps must pass again from the takeoff.
                phase(Proof.LANDING);
                status = "supply egress: returned to the original rise; rechecking the crossing after the apex cut";
                return true;
            }
            if (tick - driving >= 45)
                return outward ? abandonApexAtSource(apex, "repositioning did not reach the re-witnessed side top")
                    : stop("could not settle back onto the original apex takeoff");
            if (dryFieldFooting() && target.equals(c.player.getBlockPos())) centerSupplyFoot(target);
            else body.driveDryRoute(from, target, move);
            status = "supply egress: walking " + (outward ? "off the apex column" : "back toward the original rise");
            return true;
        }

        private boolean abandonApexAtSource(AgentSupplyEgress.ApexAccess apex, String why) {
            if (!settled(apex.source) || !actualOutlineFoot(apex.source) || !outline.finishApexAccess(apex.source))
                return stop(why);
            return refuse(why);
        }

        private boolean tryFootholdAfterLower() {
            if (!triedLower || returning || to.getY() >= order.foot().getY()) return false;
            to = to.up();
            setCrossing();
            return beginFoothold();
        }

        private boolean beginFoothold() {
            if (order.avoidFlood(to.down(), tick)) return refuse("foothold would occupy the recent flood neighborhood");
            buildStock = COBBLE_FOOTHOLD;
            buildMaterial = Blocks.COBBLESTONE.getDefaultState();
            buildReserve = FOOTHOLD_RESERVE;
            if (outline.active() && hands.count(ANDESITE_FOOTHOLD) > FOOTHOLD_RESERVE) {
                buildStock = ANDESITE_FOOTHOLD;
                buildMaterial = Blocks.ANDESITE.getDefaultState();
            } else if (outline.active() && hands.count(COBBLE_FOOTHOLD) <= FOOTHOLD_RESERVE) {
                buildStock = DIRT_FOOTHOLD;
                buildMaterial = Blocks.DIRT.getDefaultState();
                buildReserve = 2;
            }
            if (builds >= (outline.active() ? 1 : MAX_FOOTHOLDS) || hands.count(buildStock) <= buildReserve)
                return refuse("no stable landing and no spare foothold block within the placement limit");
            if (walked.contains(to) || protectRecoveryBlock(to.down()) || !offWorkshopPassage(to.down()))
                return refuse("no stable landing and the proposed foothold would occupy protected footing");
            buildLow = AgentBody.footholdInterior(to.down(), lane, false);
            buildHigh = AgentBody.footholdInterior(to.down(), lane, true);
            buildLowProved = false;
            phase(Proof.FOOTHOLD_SPACE);
            return true;
        }

        private boolean proveBuildSpace() {
            if (outline.active()) return proveOutlineBuildSpace();
            body.aim(buildLow);
            status = "supply egress: checking the empty cell for one attached foothold";
            var low = body.footholdSpace(buildLow);
            var high = body.footholdSpace(buildHigh);
            if (low == AgentBody.FootholdSpace.EMPTY && high == AgentBody.FootholdSpace.EMPTY) {
                anchorChoice = 0;
                phase(Proof.FOOTHOLD_ANCHOR);
                return true;
            }
            if (low == AgentBody.FootholdSpace.OCCUPIED || high == AgentBody.FootholdSpace.OCCUPIED
                    || low == AgentBody.FootholdSpace.FLUID || high == AgentBody.FootholdSpace.FLUID)
                return refuse("the foothold cell is occupied by material or fluid; will not replace it");
            if (tick - since >= LOOK_TICKS)
                return refuse("no lit unobstructed view of the empty foothold cell");
            return true;
        }

        private boolean proveOutlineBuildSpace() {
            Vec3d sample = buildLowProved ? buildHigh : buildLow;
            body.aim(sample);
            status = "supply egress: seeking a close backstop through the foothold cell";
            if (body.supplyOutlineClear(sample)) {
                if (!buildLowProved) {
                    buildLowProved = true;
                    since = tick;
                } else {
                    anchorChoice = 0;
                    phase(Proof.FOOTHOLD_ANCHOR);
                }
                return true;
            }
            return tick - since < OUTLINE_LOOK_TICKS || refuse("no close backstop through the exact foothold cell");
        }

        private boolean attachFoothold() {
            if (anchorChoice >= 4) return refuse("no visible stable side or top face can attach the foothold");
            if (c.player.getVelocity().horizontalLengthSquared() > 0.0025) return true;
            BlockPos destination = to.down();
            Direction offset = switch (anchorChoice) {
                case 0 -> lane;
                case 1 -> lane.rotateYClockwise();
                case 2 -> lane.rotateYCounterclockwise();
                default -> Direction.DOWN;
            };
            BlockPos anchor = destination.offset(offset);
            if (aim == null) aim = AgentBody.footholdAttachmentAim(anchor, offset, lane);
            body.aim(aim);
            status = "supply egress: looking for a reachable attaching face beside the empty cell";
            if (outline.active()) return attachOutlineFoothold(destination, anchor, offset);
            BlockHitResult hit = perceive(aim, c.player.getEyePos().distanceTo(aim) + 0.10);
            if (hit != null && hit.getBlockPos().equals(anchor) && hit.getSide() == offset.getOpposite()) {
                // Recheck the cell while aiming at the actual support; a past air sample cannot
                // authorize a replacement if a fluid or block has since appeared.
                var near = body.footholdSpace(buildHigh);
                var far = body.footholdSpace(buildLow);
                if (near == AgentBody.FootholdSpace.OCCUPIED || far == AgentBody.FootholdSpace.OCCUPIED
                        || near == AgentBody.FootholdSpace.FLUID || far == AgentBody.FootholdSpace.FLUID)
                    return refuse("the empty foothold cell changed before placement");
                if (near == AgentBody.FootholdSpace.EMPTY && far == AgentBody.FootholdSpace.EMPTY
                        && safeSupport(hit) && !protectRecoveryBlock(destination)) {
                    int count = hands.count(COBBLE_FOOTHOLD);
                    if (count <= FOOTHOLD_RESERVE) return refuse("not spending the remaining foothold reserve");
                    if (body.placeFoothold(hit, destination,
                            AgentBody.Preparation.equipment(hands.equipForUse(COBBLE_FOOTHOLD)))) {
                        builds++; // At most two issued use edges; a refused placement is not retried.
                        buildBefore = count;
                        revealedFrame = body.renderedFrame();
                        phase(Proof.FOOTHOLD_RECEIPT);
                        return true;
                    }
                }
            }
            if (tick - since >= ANCHOR_TICKS) {
                anchorChoice++;
                aim = null;
                since = tick;
            }
            return true;
        }

        private boolean attachOutlineFoothold(BlockPos destination, BlockPos anchor, Direction offset) {
            BlockHitResult hit = body.supplyOutlineFace();
            if (hit != null && hit.getBlockPos().equals(anchor) && hit.getSide() == offset.getOpposite()) {
                Vec3d sample = hit.getPos().add(c.player.getEyePos().subtract(hit.getPos()).normalize().multiply(0.20));
                if (BlockPos.ofFloored(sample).equals(destination) && body.supplyOutlineClear(sample)
                        && !protectRecoveryBlock(destination) && body.dryRouteBuildClear(order.foot(), to)
                        && body.supplyOutlinePlacementSafe(hit, destination, buildMaterial)) {
                    int count = hands.count(buildStock);
                    if (count <= buildReserve) return refuse("not spending the remaining foothold reserve");
                    if (body.placeSupplyOutline(hit, destination, buildMaterial,
                            AgentBody.Preparation.equipment(hands.equipForUse(buildStock)))) {
                        builds++;
                        buildBefore = count;
                        revealedFrame = body.renderedFrame();
                        phase(Proof.FOOTHOLD_RECEIPT);
                        status = "supply egress: attempted one outlined foothold at " + destination.toShortString();
                        return true;
                    }
                }
            }
            if (tick - since >= OUTLINE_LOOK_TICKS) {
                anchorChoice++;
                aim = null;
                since = tick;
            }
            return true;
        }

        private boolean confirmFoothold() {
            if (outline.active()) return confirmOutlineFoothold();
            body.aim(floor);
            status = "supply egress: verifying the attached foothold and inventory debit";
            BlockPos destination = to.down();
            BlockHitResult top = body.dryRouteFloor(floor, destination);
            if (top == null) top = body.dryRouteFloor(alternateFloor, destination);
            if (top != null && state(top).isOf(Blocks.COBBLESTONE) && hands.count(COBBLE_FOOTHOLD) == buildBefore - 1) {
                built = true;
                phase(Proof.HEAD);
                status = "supply egress: confirmed one attached cobblestone foothold at " + destination.toShortString();
                return true;
            }
            return tick - since < LOOK_TICKS || refuse("no witnessed cobblestone top and one-block debit after placement");
        }

        private boolean confirmOutlineFoothold() {
            BlockPos destination = to.down();
            body.aim(tick - since < OUTLINE_REAIM_TICKS ? floor : alternateFloor);
            status = "supply egress: checking the outlined foothold top and the one-block debit";
            if (body.supplyOutlineTop(order.foot(), destination) && hands.count(buildStock) == buildBefore - 1
                    && c.world.getBlockState(destination).isOf(buildMaterial.getBlock())) {
                built = true;
                // The same-grade approach head and foot were both proven before the use edge.
                phase(Proof.LANDING);
                status = "supply egress: confirmed one attached outline foothold at " + destination.toShortString();
                return true;
            }
            return tick - since < OUTLINE_LOOK_TICKS || refuse("no outlined top and one-block debit after placement");
        }

        private boolean proveReverseCrown() {
            if (aim == null) {
                aim = Vec3d.ofBottomCenter(to).add(-lane.getOffsetX() * 0.26, 2.86, -lane.getOffsetZ() * 0.26);
                reverseLeft = aim.add(lane.getOffsetZ() * 0.33, 0, -lane.getOffsetX() * 0.33);
                reverseRight = aim.add(-lane.getOffsetZ() * 0.33, 0, lane.getOffsetX() * 0.33);
            }
            body.aim(aim);
            status = "supply egress: checking the lower step's reverse jump clearance";
            if (body.dryRouteClear(reverseLeft) == AgentBody.DryRouteSample.CLEAR
                    && body.dryRouteClear(reverseRight) == AgentBody.DryRouteSample.CLEAR) {
                phase(Proof.LANDING);
                return true;
            }
            return tick - since < ANCHOR_TICKS || tryFootholdAfterLower()
                || refuse("no witnessed full-width reverse jump from the lower step");
        }

        private boolean clearance() {
            BlockPos from = order.foot();
            int rise = to.getY() - from.getY();
            BlockPos cell;
            switch (proof) {
                case OPENING -> {
                    cell = from.offset(lane).up();
                    if (aim == null) aim = Vec3d.ofCenter(cell, 0.56);
                }
                case CROWN -> {
                    cell = from.up(2);
                    if (aim == null) aim = Vec3d.ofCenter(cell, 0.67)
                        .add(lane.getOffsetX() * 0.32, 0, lane.getOffsetZ() * 0.32);
                }
                case HEAD -> {
                    cell = to.up();
                    if (aim == null) aim = Vec3d.ofCenter(cell, 0.65);
                }
                case FOOT -> {
                    cell = to;
                    if (aim == null) aim = Vec3d.ofCenter(cell, 0.48);
                }
                case HIGH_CROWN -> {
                    cell = from.up(3);
                    if (aim == null) aim = Vec3d.ofCenter(cell, 0.08)
                        .add(lane.getOffsetX() * 0.25, 0, lane.getOffsetZ() * 0.25);
                }
                case HIGH_HEAD -> {
                    cell = to.up(2);
                    if (aim == null) aim = Vec3d.ofCenter(cell, 0.08)
                        .add(-lane.getOffsetX() * 0.18, 0, -lane.getOffsetZ() * 0.18);
                }
                default -> { throw new IllegalStateException("Not a clearance proof: " + proof); }
            }
            if (outline.active()) return outlineClearance(cell, rise);
            body.aim(aim);
            switch (body.dryRouteClear(aim)) {
                case CLEAR -> {
                    memory.forgetOwnedWorkbench(c.world, cell);
                    phase(switch (proof) {
                        case OPENING -> rise > 0 ? Proof.LIP : rise < 0 ? Proof.HEAD : Proof.FOOT;
                        case CROWN -> Proof.HEAD;
                        case HEAD -> rise <= 0 ? Proof.FOOT : Proof.LANDING;
                        case FOOT -> rise < 0 ? Proof.REVERSE_CROWN : Proof.LANDING;
                        default -> throw new IllegalStateException("Not a clearance proof: " + proof);
                    });
                    return true;
                }
                case FLUID -> { return refuseFluid(cell, aim, "fluid in " + area() + " at " + cell.toShortString()); }
                case DARK -> {
                    if (body.renderedAim(aim, 8) && !tryLight()) {
                        if (restartCrossingUnderOutline()) return true;
                        if (tryFootholdAfterLower()) return true;
                        return refuse("not enough visible light to identify " + area() + " at " + cell.toShortString());
                    }
                    return true;
                }
                default -> { }
            }
            BlockHitResult hit = perceive(aim, c.player.getEyePos().distanceTo(aim) + 0.035);
            if (hit == null || !hit.getBlockPos().equals(cell)) {
                if (armedCut != null && body.continueMine(armedCut)) return true;
                if (tick - since < LOOK_TICKS) return true;
                if (tryFootholdAfterLower()) return true;
                if (hit != null) order.considered(hit.getBlockPos());
                return refuse(hit == null ? "could not witness " + area() + " at " + cell.toShortString()
                    : "occluded " + area() + " behind " + hit.getBlockPos().toShortString());
            }
            if (triedLower && !returning && rise < 0) return tryFootholdAfterLower();
            if (built) return refuse("freshly placed foothold still lacks visible standing clearance");
            if (tick - since >= CUT_TICKS) return refuse("no confirmed break in " + area() + " at " + cell.toShortString());
            return cutFace(cell, hit);
        }

        private boolean outlineClearance(BlockPos cell, int rise) {
            body.watchSupplyOutlineCut(cell);
            if (outlineCutPoint == null && !outlineReaimed && tick - since >= OUTLINE_REAIM_TICKS) {
                outlineReaimed = true;
                aim = switch (proof) {
                    case CROWN -> Vec3d.ofCenter(cell, 0.48).add(lane.getOffsetX() * 0.16, 0, lane.getOffsetZ() * 0.16);
                    case OPENING, HEAD -> Vec3d.ofCenter(cell, 0.37);
                    case FOOT -> Vec3d.ofCenter(cell, 0.73);
                    case HIGH_CROWN, HIGH_HEAD -> Vec3d.ofCenter(cell, 0.08);
                    default -> throw new IllegalStateException("Not an outline clearance proof: " + proof);
                };
            }
            body.aim(outlineCutPoint == null ? aim : outlineCutPoint);
            status = "supply egress: seeking a close outline through " + area() + " at " + cell.toShortString();
            if (armedCut == null && body.supplyOutlineClear(aim)) {
                phase(switch (proof) {
                    case OPENING -> rise > 0 ? Proof.LIP : Proof.FOOT;
                    case CROWN -> Proof.HEAD;
                    case HEAD -> rise > 0 ? Proof.LANDING : Proof.FOOT;
                    case FOOT -> Proof.LANDING;
                    case HIGH_CROWN -> Proof.HIGH_HEAD;
                    case HIGH_HEAD -> Proof.LANDING;
                    default -> throw new IllegalStateException("Not an outline clearance proof: " + proof);
                });
                return true;
            }
            if (body.dryRouteClear(aim) == AgentBody.DryRouteSample.FLUID)
                return refuseFluid(cell, aim, "fluid in " + area() + " at " + cell.toShortString());
            BlockHitResult hit = body.supplyOutlineFace();
            if (hit != null && cell.equals(hit.getBlockPos())
                    && (outlineCutPoint != null || body.renderedAim(aim, 10)))
                return cutOutline(cell, hit);
            if (handClearSince >= 0) {
                if (hit == null) return continueHandClearance(cell);
                return rejectOutlineCut("the outlined hand-clearance contact changed");
            }
            return tick - since < (outlineCutPoint == null ? OUTLINE_LOOK_TICKS : CUT_TICKS)
                || refuse("no matching close cut face or positive backstop for " + area() + " at " + cell.toShortString());
        }

        private boolean cutOutline(BlockPos cell, BlockHitResult hit) {
            if (order.avoidFlood(cell, tick)) return rejectOutlineCut("will not cut into the recent flood neighborhood");
            if (built || cell.equals(to.down()) || underMineFootprint(cell) || protectRecoveryBlock(cell))
                return rejectOutlineCut("outlined " + area() + " would disturb supporting or protected footing");
            if (laneCuts >= (outlineApexChecked ? 5 : MAX_LANE_CUTS)
                    || cuts >= MAX_CUTS || armedCut == null && !outline.allowsCut(cell))
                return rejectOutlineCut("short outline cut limit or repeated cut target at " + cell.toShortString());
            if (!body.supplyOutlineCutSafe(hit)) {
                if (outline.apexAccess() == null && beginApexAccess(hit)) return true;
                return rejectOutlineCut("unsafe outlined cut face or overhead cap at " + cell.toShortString());
            }
            if (handClearSince >= 0) {
                if (tick - handClearSince >= OUTLINE_HAND_TICKS)
                    return rejectOutlineCut("no confirmed hand clearance at " + cell.toShortString());
                return handleHandClearance(cell, body.clearSupplyOutline(hit));
            }
            if (tick - since >= CUT_TICKS)
                return rejectOutlineCut("no confirmed outlined break at " + cell.toShortString());
            if (outlineCutPoint == null) outlineCutPoint = hit.getPos();
            status = "supply egress: targeting an outlined " + area() + " cut at " + cell.toShortString();
            // Consult only the currently authenticated natural face, never an unseen stock or cover cell.
            BlockState material = body.supplyOutlineState(hit);
            if (material == null) return true;
            var inventory = c.player.getInventory();
            if (material.isToolRequired() && !inventory.getMainHandStack().isSuitableFor(material)) {
                for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
                    ItemStack pick = inventory.getStack(slot);
                    if (pick.isIn(ItemTags.PICKAXES) && pick.isSuitableFor(material)) {
                        hands.equipSlot(slot);
                        return true;
                    }
                }
                if (!outline.allowsHandClearance(cell))
                    return rejectOutlineCut("short outlined hand-clearance limit at " + cell.toShortString());
                if (!hands.equipForUse(EMPTY_HAND)) return true;
                return handleHandClearance(cell, body.clearSupplyOutline(hit));
            }
            if (body.mineSupplyOutline(hit)) armOutlineCut(cell);
            if (armedCut != null) status = "supply egress: attempted outlined cut at " + cell.toShortString();
            if (body.miningFootingRefused(cell)) return rejectOutlineCut("cut would remove actual supporting footprint");
            return true;
        }

        private void armOutlineCut(BlockPos cell) {
            if (armedCut != null) return;
            outline.attemptedCut(cell);
            armedCut = cell;
            var apex = outline.apexAccess();
            if (apex != null) apex.requestedCut();
        }

        private boolean continueHandClearance(BlockPos cell) {
            if (tick - handClearSince >= OUTLINE_HAND_TICKS)
                return rejectOutlineCut("no confirmed hand clearance at " + cell.toShortString());
            return handleHandClearance(cell, body.continueSupplyOutlineClearance(cell));
        }

        private boolean handleHandClearance(BlockPos cell, AgentBody.OutlineClearance result) {
            return switch (result) {
                case REQUESTED -> {
                    if (handClearSince < 0) {
                        handClearSince = tick;
                        outline.attemptHandClearance(cell);
                    }
                    armOutlineCut(cell);
                    status = "supply egress: attempting bounded hand clearance at " + cell.toShortString();
                    yield true;
                }
                case WAIT -> true;
                case UNSAFE -> rejectOutlineCut("outlined hand clearance lost its safe contact");
                case TOO_SLOW -> rejectOutlineCut("the outlined hand cut cannot finish inside its bound");
                case STALLED -> rejectOutlineCut("no observed crack progress from the outlined hand cut");
                case EXPIRED -> rejectOutlineCut("the outlined hand clearance expired without a break");
            };
        }

        private boolean rejectOutlineCut(String why) {
            var apex = outline.apexAccess();
            return apex == null ? refuse(why) : leaveApexCut(apex, why);
        }

        private String area() {
            return switch (proof) {
                case OPENING -> "side face";
                case CROWN -> "takeoff crown";
                case HEAD -> "landing headroom";
                case FOOT -> "landing foot space";
                case HIGH_CROWN -> "jump apex over the takeoff";
                case HIGH_HEAD -> "jump apex over the landing";
                default -> "support";
            };
        }

        private boolean cutFace(BlockPos cell, BlockHitResult hit) {
            if (order.avoidFlood(cell, tick)) return refuse("will not cut into the recent flood neighborhood");
            BlockState material = state(hit);
            boolean ownBench = material.isOf(table.block) && memory.ownsWorkbench(c.world, cell);
            if (ownBench && mineDeparture) return refuse("the ascent would disturb the existing portable workshop");
            if (!material.isOf(table.block)) memory.forgetOwnedWorkbench(c.world, cell);
            var admission = returnableFace(cell, material);
            if (ownBench) {
                if (packedBench != null || proof == Proof.CROWN || cell.equals(to.down())
                        || underMineFootprint(cell) || supportsTrail(cell)
                        || cell.up().equals(furnace.position) || cell.up().equals(furnaceWitness)
                        || c.currentScreen != null || c.player.currentScreenHandler != c.player.playerScreenHandler
                        || table.placed != 0 || !fieldBench.roomForTable() || !has(AXE, 1))
                    return refuse("cannot safely pack the owned portable crafting table at " + cell.toShortString());
            } else if (admission != AgentReturnableMine.Face.MINEABLE || cell.equals(to.down())) {
                String reason = switch (admission) {
                    case FOOTPRINT -> "supports the current footprint";
                    case PROTECTED -> "protects a walked step or workshop";
                    case FLUID, LAVA -> "contains fluid";
                    case MATERIAL -> "is not stable natural cut material";
                    case TOOL -> "needs a usable tool";
                    case MINEABLE -> "is the intended landing support";
                    default -> "could not be admitted for a safe cut";
                };
                return refuse(area() + " " + cell.toShortString() + " (" + Registries.BLOCK.getId(material.getBlock())
                    + ") " + reason);
            }
            if (cuts >= MAX_CUTS || laneCuts >= MAX_LANE_CUTS)
                return refuse("cut limit reached without a supported crossing");
            // Sample above the near edge from the real camera. Don't inspect a
            // column behind the face, and never cut an observed falling cap.
            Vec3d edge = hit.getPos().add(hit.getSide().getOffsetX() * 0.08, 0, hit.getSide().getOffsetZ() * 0.08);
            Vec3d above = new Vec3d(edge.x, cell.getY() + 1.20, edge.z);
            BlockHitResult cover = perceive(above, c.player.getEyePos().distanceTo(above) + 0.035);
            if (cover != null && cover.getBlockPos().getY() > cell.getY()) {
                BlockState shown = state(cover);
                var fluid = shown.getFluidState();
                if (fluid.isIn(FluidTags.WATER)) return warnFlood(cell, cover.getBlockPos(), fluid.isStill());
                if (shown.getBlock() instanceof FallingBlock || dangerous(shown) || !fluid.isEmpty()) {
                    order.considered(cover.getBlockPos());
                    return refuse("visible falling material or fluid over " + cell.toShortString());
                }
            }
            body.aimContact(hit, AgentBody.Contact.MINE);
            if (ownBench) {
                status = "supply egress: packing our own obstructing crafting table";
                if (!hands.equipForUse(AXE)) return true;
                if (armedCut == null) benchBefore = hands.count(table.item);
            }
            if ((ownBench || readyForMine(material)) && body.mine(hit)) armedCut = cell;
            if (body.miningFootingRefused(cell)) return refuse("cut would remove actual supporting footprint");
            return true;
        }

        private boolean refuseFluid(BlockPos cell, Vec3d sample, String why) {
            if (laneCuts > 0) {
                BlockHitResult hit = perceive(sample, c.player.getEyePos().distanceTo(sample) + 0.035);
                if (hit != null) {
                    var fluid = state(hit).getFluidState();
                    if (fluid.isIn(FluidTags.WATER)) return warnFlood(cell, hit.getBlockPos(), fluid.isStill());
                }
            }
            return to == null ? stop(why) : refuse(why);
        }

        private boolean warnFlood(BlockPos opening, BlockPos water, boolean source) {
            floodOpening = opening;
            floodWater = water;
            floodSource = source;
            body.pauseWork();
            status = "supply egress: witnessed water over the crossing at " + water.toShortString();
            return true;
        }

        private boolean drive() {
            BlockPos from = order.foot();
            var veto = body.dryRouteVeto(from, to);
            if (veto != AgentBody.DryRouteVeto.CLEAR) return refuse(vetoReason(veto));
            boolean outlined = outline.active();
            if (outlined && (!body.walkedLaneDry(from, to, lane)
                    || body.lavaEmergency() || body.macroLavaNear()))
                return refuse("dry outline crossing changed before landing");
            if (outlined && to.getY() > from.getY()) {
                var grade = body.supplyOutlineGradeVeto(from, to);
                if (grade != AgentBody.DryRouteVeto.CLEAR) return refuse(vetoReason(grade));
            }
            if (settled(to) && (!mineDeparture || mineResite.exactContact(to))) {
                if (outlined && !outline.landed(to, actualOutlineFoot(to)))
                    return stop("no exact settled dry outline landing receipt");
                BlockPos old = from;
                from = to;
                order.landed(from);
                walked.add(from);
                caves.walkedDry(old, from);
                caves.witnessedDry(from, old);
                body.recordWalkedLeg(old, from);
                if (from.getY() > old.getY()) {
                    rises++;
                    if (!mineDeparture) stallGuard.navigationArrival(old, from);
                    status = (mineDeparture ? "mine departure rise " : "supply egress rise ") + rises + ": " + old.toShortString()
                        + " -> " + from.toShortString() + " (settled; return connected)";
                } else {
                    if (!returning && from.getY() < old.getY()) connectors++;
                    else if (!returning) levels++;
                    status = "supply egress: settled connected footing at " + from.toShortString();
                }
                if (outlined) status = "supply egress: confirmed settled outline landing " + outline.steps()
                    + ": " + old.toShortString() + " -> " + from.toShortString();
                walkedReturn |= returning;
                boolean reachedReturnEnd = returning && --back <= backEnd;
                if (reachedReturnEnd) returning = false;
                to = null;
                restoredApex = null;
                driving = 0;
                firstRefusal = lastRefusal = null;
                sourceProved = !outlined;
                triedLight = false;
                bearing = lane;
                handoffAfter = tick;
                survey(reachedReturnEnd ? 4 : 1);
                if (mineDeparture) mineResite.ascended(from, lane);
                return true;
            }
            if (tick - driving >= 45) return refuse("ordinary jump or walk did not settle on the witnessed top");
            if (outlined && dryFieldFooting() && from.equals(c.player.getBlockPos()) && !actualOutlineFoot(from))
                return refuse("actual dry takeoff support changed before movement");
            if (outlined) status = "supply egress: crossing toward the outlined top at " + to.toShortString();
            if (dryFieldFooting() && to.equals(c.player.getBlockPos())) {
                centerSupplyFoot(to);
                return true;
            }
            boolean jump = to.getY() > from.getY() && dryFieldFooting() && from.equals(c.player.getBlockPos());
            if (jump && body.jumpBlocked(lane.getPositiveHorizontalDegrees()))
                return refuse("the ordinary jump was blocked by headroom");
            body.driveDryRoute(from, to, lane);
            return true;
        }

        private void centerSupplyFoot(BlockPos foot) {
            if (body.centerOnSupport(foot.down()) || !ordinaryCaveDrops || !body.ordinaryOutlineExitEnabled()) return;
            // The lit helper has looked at the top from this new pose. Only the actual
            // vanilla outline and the same physical support may authorize the inward shift.
            if (actualOutlineFoot(foot) && body.supplyOutlineTop(foot, foot.down()))
                body.centerOnGroundedSupport(foot, body.dryCaveContact(foot));
        }

        private boolean settled(BlockPos foot) {
            var player = c.player;
            return dryFieldFooting() && foot.equals(player.getBlockPos())
                && player.getPose() == EntityPose.STANDING && player.hurtTime == 0 && !player.isOnFire()
                && Math.abs(player.getY() - foot.getY()) <= 0.04
                && Math.abs(player.getX() - foot.getX() - 0.5) <= 0.18
                && Math.abs(player.getZ() - foot.getZ() - 0.5) <= 0.18
                && player.getVelocity().horizontalLengthSquared() <= 0.0144;
        }

        private boolean cardinal(BlockPos a, BlockPos b) {
            return adjacent(a, b) && Math.abs(a.getX() - b.getX()) + Math.abs(a.getZ() - b.getZ()) == 1;
        }

        private String vetoReason(AgentBody.DryRouteVeto veto) {
            return switch (veto) {
                case DRIFT -> "the body left the selected dry crossing";
                case SWEEP -> "the full-width body or headroom sweep is blocked";
                case SUPPORT -> "one of the two supporting footprints no longer holds";
                case HAZARD -> "danger on the selected crossing";
                case VIEW -> "lost the rendered crossing";
                case CLEAR -> throw new IllegalArgumentException("No crossing veto");
            };
        }

        private boolean refuse(String why) {
            lastRefusal = lane + ": " + why;
            if (firstRefusal == null) firstRefusal = lastRefusal;
            if (driving != 0 && !settled(order.foot())) return stop(lastRefusal);
            body.pauseWork();
            if (outline.active() && to != null && to.getY() > order.foot().getY() && proof == Proof.OPENING)
                flatBearings |= 1 << lane.ordinal(); // No reason to repeat the same exact failed opening for a level leg.
            outline.abandonLanding();
            body.forgetSupplyOutlineCut();
            outlineCutPoint = null;
            handClearSince = -1;
            restoredApex = null;
            to = null;
            armedCut = null;
            driving = 0;
            returning = false;
            status = (outline.active() ? "supply egress: rejected outline crossing " : "supply egress: rejected ") + lastRefusal;
            return true;
        }

        private boolean surfaceReady(BlockPos from, float yaw, String why) {
            body.pauseWork();
            openFoot = from;
            heading = yaw;
            headingUntil = tick + 125;
            approachGoal = null;
            return ready(from, why);
        }

        private boolean ready(String why) {
            return ready(order.foot(), why);
        }

        private void resetOutline() {
            outline.reset();
            body.forgetSupplyOutlineCut();
            outlineCutPoint = null;
            handClearSince = -1;
            restoredApex = null;
        }

        private boolean ready(BlockPos from, String why) {
            int index = trail.lastIndexOf(from);
            if (walkedReturn && index >= 0 && index + 1 < trail.size()) {
                resumeIndex = index + 1;
                resumeStep = -1;
                supplyExcursion.reset();
            }
            status = (mineDeparture ? "mine departure: " : "supply egress: ") + why + " at " + from.toShortString();
            if (order.active()) order.finish();
            resetOutline();
            to = armedCut = null;
            driving = 0;
            return true;
        }

        private boolean stop(String why) {
            body.pauseWork();
            if (outline.active()) why = "short outline passage refused: " + why;
            resetOutline();
            to = armedCut = null;
            driving = 0;
            if (mineDeparture) {
                status = "mine departure ascent blocked at " + order.foot().toShortString() + ": " + why;
                order.finish(); // A strategic departure refusal is not a supply order refusal.
                return true;
            }
            status = order.refuse(why
                + (packedBench == null ? "" : "; no safe pickup reached for the portable crafting table"), airborne());
            return true;
        }
    }

    private boolean tendTimber() {
        BlockPos stem = timberWitness.getBlockPos();
        Vec3d feet = c.player.getPos();
        double reach = c.player.getBlockInteractionRange();
        Vec3d base = new Vec3d(stem.getX() + 0.5, Math.min(stem.getY() + 0.35, feet.y + 1.2), stem.getZ() + 0.5);
        if (tick >= timberWorkUntil) return finishTimber("timber target exhausted: work deadline");
        // A current exposed, reachable lower face beats an approach to an estimated base.
        if (timberLastCut == null && horizontalDistance(feet, base) <= reach + 0.3) {
            BlockHitResult hit = body.find(state -> state.isIn(BlockTags.LOGS), reach,
                face -> sameStem(stem, face.getBlockPos()) && face.getBlockPos().getY() <= c.player.getBlockY()
                    && !timberUnderfoot(face.getBlockPos()) && timberInReach(face)).orElse(null);
            if (hit == null) hit = body.find(state -> state.isIn(BlockTags.LOGS), reach,
                face -> sameStem(stem, face.getBlockPos()) && face.getBlockPos().getY() <= c.player.getBlockY() + 1
                    && !timberUnderfoot(face.getBlockPos()) && timberInReach(face)).orElse(null);
            if (hit != null) {
                chopFromTimberStance(hit);
                return true;
            }
        }
        double distance = horizontalDistance(feet, base);
        if (!timberNear && distance > 2.8) {
            if (surfaceApproach.cutTimberMask(timberAim(timberWitness))) return true;
            // Use the same checked route before and after the log enters striking reach.
            approachTimberWorksite(timberWitness);
            return true;
        }
        timberNear = true;
        return scanTimberStem(base, distance);
    }

    private boolean scanTimberStem(Vec3d base, double distance) {
        Vec3d feet = c.player.getPos();
        BlockPos stem = timberWitness.getBlockPos();
        if (timberScan >= 3)
            return startTimberReposition() || finishTimber("timber target exhausted: no safe stand");
        Vec3d probe = switch (timberScan) {
            case 0 -> base;
            case 1 -> base.add(0, 1.65, 0);
            default -> base.add(0, 3.25, 0);
        };
        body.aim(probe);
        status = "checking the witnessed trunk from the base upward";
        if (!body.aligned(probe)) return true;
        Vec3d eye = c.player.getEyePos();
        double reach = c.player.getBlockInteractionRange();
        int low = c.player.getBlockY() - 2;
        int high = MathHelper.floor(eye.y + reach + 0.6);
        if (timberScan == 0 && timberLastCut == null) high = Math.min(high, c.player.getBlockY() + 2);
        BlockPos next = timberLastCut == null ? stem : timberLastCut.up();
        BlockHitResult mask = null;
        for (int y = low; y <= high; y++) {
            Vec3d center = new Vec3d(base.x, y + 0.5, base.z);
            BlockHitResult hit = perceive(center, Math.min(reach + 0.85, eye.distanceTo(center) + 0.03));
            if (hit == null) continue;
            if (sameStem(hit.getBlockPos(), stem) && timberInReach(hit) && state(hit).isIn(BlockTags.LOGS)
                && !timberUnderfoot(hit.getBlockPos())) {
                chopFromTimberStance(hit);
                return true;
            }
            if (timberLeafCuts < 2 && triedTimberLeaves.size() < 4 && (y == next.getY() || y == next.getY() + 1)
                    && !triedTimberLeaves.contains(hit.getBlockPos()) && isTimberPassage(hit)
                    && hit.getBlockPos().getSquaredDistance(next) <= 4) mask = hit;
        }
        if (timberLastCut == null) {
            Vec3d point = timberAim(timberWitness);
            BlockHitResult hit = perceive(point, eye.distanceTo(point) + 0.06);
            if (hit != null && hit.getBlockPos().equals(stem) && timberInReach(hit) && state(hit).isIn(BlockTags.LOGS)
                && !timberUnderfoot(stem)) {
                chopFromTimberStance(hit);
                return true;
            }
        }
        Vec3d above = Vec3d.ofCenter(next);
        if (timberLastCut != null && eye.squaredDistanceTo(above) < reach * reach
            && body.clearTerrain(above)) return finishTimber(null);
        if (mask != null) {
            BlockPos foot = c.player.getBlockPos();
            if (bootstrapTimber) {
                if (surfaceApproach.cutTimberMask(foot, mask)) return true;
            } else {
                beginTimberChop(mask, true);
                return true;
            }
        }
        // A high, visibly out-of-reach face is not a chopping target. Try the lower views first.
        if (timberScan >= 1 && distance <= reach + 0.45) {
            BlockHitResult highFace = body.find(state -> state.isIn(BlockTags.LOGS), 12,
                hit -> sameStem(hit.getBlockPos(), stem) && hit.getPos().y > eye.y + 0.8
                    && !timberInReach(hit) && (distance <= 2.8 || hit.getPos().y - eye.y > reach)).orElse(null);
            if (highFace != null) return unavailableTimber(highFace, "upper log outside standing reach", true);
        }
        timberScan++;
        return true;
    }

    private boolean timberCandidate(BlockHitResult hit) {
        BlockPos block = hit.getBlockPos();
        if (timberUnderfoot(block)) return false;
        if (!timberInReach(hit) && rejectedTimberHeight(block)) return false;
        for (int i = 0; i < exhaustedStems.size(); i++) {
            if (sameStem(block, exhaustedStems.get(i))) return false;
        }
        return true;
    }

    private boolean rejectedTimberHeight(BlockPos block) {
        for (int i = 0; i < unreachableTimber.size(); i++) {
            BlockPos prior = unreachableTimber.get(i);
            if (sameStem(block, prior) && block.getY() >= prior.getY()) return true;
        }
        return false;
    }

    private boolean timberInReach(BlockHitResult hit) {
        double range = c.player.getBlockInteractionRange();
        return hit.getPos().squaredDistanceTo(c.player.getEyePos()) <= range * range;
    }

    private boolean unavailableTimber(BlockHitResult hit, String reason, boolean tryShelf) {
        BlockPos block = hit.getBlockPos();
        boolean tried = rejectedTimberHeight(block);
        if (!tried) rememberTimberSite(unreachableTimber, block);
        timberChop = null;
        if (tryShelf && !tried && tryHigherTimberShelf(hit)) return true;
        clearTimberWitness();
        status = "timber unavailable: " + reason;
        return true;
    }

    private boolean tryHigherTimberShelf(BlockHitResult log) {
        var player = c.player;
        BlockPos from = player.getBlockPos();
        if (!player.isOnGround() || !safePickupStance() || from.equals(timberShelfCheckedFrom)
                || log.getBlockPos().getY() <= from.getY() || nextFoot != null) return false;
        double eyeHeight = player.getEyePos().y - player.getY();
        double reach = player.getBlockInteractionRange();
        var floor = body.find(this::timberShelfSurface, 3.25, hit -> hit.getSide() == Direction.UP && safeSupport(hit)
            && timberShelfCandidate(from, hit.getBlockPos().up(), log, eyeHeight, reach)).orElse(null);
        if (floor == null) return false;
        timberShelfCheckedFrom = from;
        timberExitFrom = from;
        timberExitTo = floor.getBlockPos().up();
        timberHigherShelf = true;
        return repositionForTimber();
    }

    private boolean timberShelfCandidate(BlockPos from, BlockPos to, BlockHitResult log, double eyeHeight, double reach) {
        return to.getY() == from.getY() + 1 && adjacent(from, to) && !sameStem(to, log.getBlockPos())
            && !triedTimberFooting.contains(to)
            && Vec3d.ofBottomCenter(to).add(0, eyeHeight, 0).squaredDistanceTo(log.getPos()) <= reach * reach;
    }

    private boolean timberShelfSurface(BlockState state) {
        return !state.isOf(Blocks.CRAFTING_TABLE) && !state.isOf(Blocks.FURNACE)
            && !state.isIn(BlockTags.LOGS) && !state.isIn(BlockTags.LEAVES);
    }

    private boolean finishTimber(String reason) {
        rememberTimberSite(exhaustedStems, timberWitness.getBlockPos());
        clearTimberWitness();
        if (reason != null) {
            status = reason;
            return true;
        }
        return false;
    }

    private void clearTimberWitness() {
        clearCollectionStance();
        timberWitness = null;
        timberLastCut = null;
        timberDropUntil = 0;
        timberShelfCheckedFrom = null;
    }

    private static void rememberTimberSite(List<BlockPos> sites, BlockPos block) {
        if (sites.size() == TIMBER_RECENT) sites.removeFirst();
        sites.add(block);
    }

    private boolean startTimberReposition() {
        if (!c.player.isOnGround()) return false;
        BlockPos from = c.player.getBlockPos();
        if (triedTimberFooting.contains(from)) return false;
        rememberTimberSite(triedTimberFooting, from);
        timberExitFrom = from;
        var floor = body.find(this::timberShelfSurface, 4.2, this::timberLanding).orElse(null);
        if (floor == null) {
            timberExitFrom = null;
            return false;
        }
        timberExitTo = floor.getBlockPos().up();
        rememberTimberSite(triedTimberFooting, timberExitTo);
        timberHigherShelf = false;
        return repositionForTimber();
    }

    /** The visible shelf is an exact goal; the same dry navigator proves how to reach it. */
    private boolean repositionForTimber() {
        if (!safePickupStance()) return rejectTimberExit("shelf work interrupted");
        switch (navigate(Job.TIMBER, AgentResourceStance.exact(timberExitTo))) {
            case ARRIVED -> {
                rememberTimberSite(triedTimberFooting, timberExitTo);
                if (timberDropUntil != 0) timberDropUntil = tick + 25;
                return landTimberReposition();
            }
            case BLOCKED -> { return rejectTimberExit("no witnessed route to the timber stance"); }
            case MOVING, OBSERVING -> { }
        }
        return true;
    }

    private boolean landTimberReposition() {
        timberExitFrom = timberExitTo = null;
        timberHigherShelf = false;
        timberCanopy = null;
        timberNear = false;
        timberScan = 0;
        timberWorkUntil = tick + TIMBER_WORK_TICKS;
        approachGoal = null;
        status = "timber reposition: reached verified footing";
        return true;
    }

    private boolean timberLanding(BlockHitResult floor) {
        BlockPos to = floor.getBlockPos().up();
        int rise = to.getY() - timberExitFrom.getY();
        double distance = horizontalDistance(c.player.getPos(), Vec3d.ofBottomCenter(to));
        return floor.getSide() == Direction.UP && rise >= 0 && rise <= 1
            && (rise == 0 || adjacent(timberExitFrom, to))
            && distance >= (rise == 0 ? 1.25 : 0.45) && distance <= 3.1
            && !triedTimberFooting.contains(to) && safeSupport(floor);
    }

    private boolean rejectTimberExit(String reason) {
        timberExitFrom = timberExitTo = null;
        if (!timberHigherShelf && timberWitness != null) finishTimber(null);
        timberHigherShelf = false;
        status = "timber reposition: " + reason;
        return true;
    }

    private boolean isTimberPassage(BlockHitResult hit) {
        return timberInReach(hit) && AgentSupplyEgress.naturalDryLeaf(state(hit))
            && !surfaceApproach.protectedCanopyLeaf(hit.getBlockPos());
    }

    private boolean timberUnderfoot(BlockPos block) {
        Box player = c.player.getBoundingBox();
        return block.getY() < player.minY + 0.05
            && block.getX() + 1 > player.minX && block.getX() < player.maxX
            && block.getZ() + 1 > player.minZ && block.getZ() < player.maxZ;
    }

    private static boolean sameStem(BlockPos a, BlockPos b) {
        return b != null && a.getX() == b.getX() && a.getZ() == b.getZ();
    }

    private static Vec3d timberAim(BlockHitResult face) {
        return face.getPos().lerp(Vec3d.ofCenter(face.getBlockPos()), 0.08);
    }

    private void beginTimberChop(BlockHitResult hit, boolean leaves) {
        timberChop = hit;
        timberChopPoint = timberAim(hit);
        timberCuttingLeaves = leaves;
        timberCuttingPlanks = !leaves && SUPPLY_WOOD.test(state(hit));
        if (!leaves && !timberCuttingPlanks && timberWitness != null
                && sameStem(timberWitness.getBlockPos(), hit.getBlockPos())
                && hit.getBlockPos().getY() < timberWitness.getBlockPos().getY()) timberWitness = hit;
        timberAttack = 0;
        timberAlignUntil = tick + 34;
        timberChopUntil = tick + 110;
        if (leaves && surfaceApproach.canopy.active() == null) triedTimberLeaves.add(hit.getBlockPos());
    }

    private boolean continueTimberAttack() {
        if (timberChop == null || timberAttack == 0 || timberAttack != tick - 1
                || tick - timberAttackWitnessTick > 3 || tick >= timberChopUntil) return false;
        BlockPos block = timberChop.getBlockPos();
        if (timberUnderfoot(block)
                || timberCuttingLeaves && (!hands.stableCraftFooting() || surfaceApproach.protectedCanopyLeaf(block))
                || !body.continueMine(block)) return false;
        // Bridge a short render gap only for the exact target already being mined.
        timberSeekTick = tick;
        attackTimber(true);
        return true;
    }

    private void attackTimber(boolean retainedOutline) {
        timberAttack = tick;
        timberAlignUntil = tick + 8;
        if (retainedOutline) status = timberCuttingLeaves
            ? "opening a visible passage through leaves (same outline during render gap)"
            : timberCuttingPlanks ? "chopping witnessed planks (same outline during render gap)"
                : "chopping the witnessed trunk (same outline during render gap)";
        else status = timberCuttingLeaves ? "opening a visible passage through leaves"
            : timberCuttingPlanks ? "chopping witnessed planks" : "chopping the witnessed trunk";
    }

    private void chopTimber() {
        status = timberCuttingLeaves ? "aligning on visible leaves"
            : timberCuttingPlanks ? "aligning on reachable planks" : "aligning on a reachable log";
        BlockPos block = timberChop.getBlockPos();
        if (tick >= timberChopUntil || timberUnderfoot(block)) {
            timberChop = null;
            timberScan = 0;
            return;
        }
        if (timberCuttingLeaves && !hands.stableCraftFooting()) return;
        body.aim(timberChopPoint);
        BlockHitResult hit = perceive(timberChopPoint, c.player.getEyePos().distanceTo(timberChopPoint) + 0.08);
        if (hit != null && hit.getBlockPos().equals(block)) {
            BlockState material = state(hit);
            if (timberCuttingLeaves && !isTimberPassage(hit)) {
                timberChop = null;
                return;
            }
            if (material.isIn(timberCuttingLeaves ? BlockTags.LEAVES
                    : timberCuttingPlanks ? BlockTags.PLANKS : BlockTags.LOGS)) {
                if (!timberInReach(hit)) {
                    if (!timberCuttingLeaves && !timberCuttingPlanks)
                        unavailableTimber(hit, "log face outside vanilla reach", hit.getPos().y > c.player.getEyePos().y);
                    else timberChop = null;
                    return;
                }
                boolean ready = body.aimContact(hit, AgentBody.Contact.MINE);
                boolean toolReady = readyForMine(material);
                if (toolReady && body.mine(hit)) {
                    timberAttackWitnessTick = tick;
                    attackTimber(false);
                } else if (!ready) stopUnalignedTimber();
                else if (!toolReady) {
                    stallGuard.ordinarySetup();
                    body.awaitingContactEquipment();
                }
                return;
            }
        }
        if (!body.aligned(timberChopPoint)) {
            stopUnalignedTimber();
            return;
        }
        boolean cleared = hit != null && hit.getBlockPos().equals(block) || body.clearTerrain(timberChopPoint);
        if (cleared && timberAttack != 0 && tick - timberAttack <= 10) {
            if (!timberCuttingLeaves) {
                timberLastCut = block;
                timberDropUntil = tick + 26;
                timberDropItem = timberCuttingPlanks ? PLANK : LOG;
                timberDropCount = hands.count(timberDropItem);
            }
            timberWorkUntil = tick + TIMBER_WORK_TICKS;
            timberScan = 0;
            timberChop = null;
        } else if (hit != null || cleared || timberAttack != 0 && tick - timberAttack > 10) {
            timberChop = null;
            // Re-observe the column before changing position or choosing another leaf.
            timberScan = 0;
        } else {
            stopUnalignedTimber();
        }
    }

    private void stopUnalignedTimber() {
        if (tick < timberAlignUntil) return;
        if (!timberCuttingLeaves && timberWitness != null) {
            finishTimber("timber unavailable: vanilla crosshair did not confirm log face");
        }
        timberChop = null;
        timberScan = 0;
    }

    private void gatherStone() {
        if (nextFoot != null) {
            excavate(nextFoot.getY(), digGoal);
            return;
        }
        gather(Resource.STONE, 0, Math.min(42, c.player.getBlockY() - 1));
    }

    /** Spend wood-pick durability on a short search, not on an unproductive rock seam. */
    static final class StoneProbeBudget {
        private static final int DECORATIVE_LIMIT = 6;
        private int stock, decorative;
        private boolean wornQuarry;

        void begin(int stock, int carriedVariants, int uses) {
            this.stock = stock;
            decorative = 0;
            // On reload there may be no sequence of break receipts. A large haul AND
            // a worn pick are evidence to change approach, not evidence of hidden stone.
            wornQuarry = carriedVariants >= DECORATIVE_LIMIT && uses <= 12 + (3 - stock);
        }

        void observeStock(int stock) {
            if (stock > this.stock) decorative = 0;
            this.stock = stock;
        }

        void decorativeCut() { decorative++; }

        boolean canSpendOnCover(int uses) { return uses > 3 - stock; }

        boolean canDeepen(int uses, boolean retired) {
            return !retired && !depleted() && canSpendOnCover(uses);
        }

        boolean depleted() { return wornQuarry || decorative >= DECORATIVE_LIMIT; }
    }

    /** Bootstrap needs stone items, not depth. All new routes are lit, dry and at most one block of grade per tread. */
    private final class FirstStone {
        private static final int VIEW_TICKS = 22, PROBE_TICKS = 190;
        private static final int STARTER_STEPS = 5, SIDE_PROBES = 3, REMEMBERED_WORK = 20;
        private static final double STONE_VIEW = 8;
        private final StoneProbeBudget budget = new StoneProbeBudget();
        private final ArrayList<BlockPos> retired = new ArrayList<>(REMEMBERED_WORK);
        private final ArrayList<BlockPos> triedProbes = new ArrayList<>(REMEMBERED_WORK);
        private final AgentResourceStance.Refusals refusedFaces = new AgentResourceStance.Refusals();
        private final Predicate<BlockHitResult> distantFace = this::canApproach;
        private ClientWorld world;
        private BlockPos probeFrom, probeTo, sightBlock;
        private Direction forward, bearing;
        private Vec3d sightPoint;
        private AgentResourceStance goal;
        private AgentSurfaceTread tread;
        private int probeUntil, probeCheckAt, probeHeight, starterSteps, sideProbes, travelTick;
        private BlockPos cutting;
        private int lastProbeContact;
        private boolean started, exhausted, triedSupplyExit, directedProbe;

        boolean working() {
            return probeTo != null || tread != null || sightBlock != null || target != null && quarryingStoneStock;
        }

        boolean witnessedProbeWork() {
            return probeTo != null && lastProbeContact != 0 && tick <= probeUntil
                && tick - lastProbeContact <= VIEW_TICKS && probeFrom.equals(c.player.getBlockPos());
        }

        boolean traveling() {
            return travelTick == tick - 1 && tread != null;
        }

        void interrupt() {
            probeFrom = probeTo = cutting = null;
            tread = null;
            stopWalk();
        }

        void afterRespawn() {
            interrupt();
            retired.clear();
            triedProbes.clear();
            refusedFaces.clear();
            started = false;
        }

        void broken(BlockPos block, BlockState state) {
            refusedFaces.changed(block);
            if (!block.equals(cutting)) return;
            cutting = null;
            lastProbeContact = tick;
            if (decorative(state)) budget.decorativeCut();
        }

        private boolean decorative(BlockState state) {
            return state.isOf(Blocks.ANDESITE) || state.isOf(Blocks.DIORITE) || state.isOf(Blocks.GRANITE)
                || state.isOf(Blocks.TUFF) || state.isOf(Blocks.CALCITE) || state.isOf(Blocks.DRIPSTONE_BLOCK);
        }

        private void beginPatch(BlockPos standing, Direction direction, int stock, int uses, boolean continuingInventory) {
            started = true;
            exhausted = false;
            triedSupplyExit = false;
            forward = direction;
            budget.begin(stock, continuingInventory ? hands.count(DECORATIVE_ROCK) : 0, uses);
            starterSteps = sideProbes = 0;
        }

        private void observeWorld() {
            if (world != c.world) {
                interrupt();
                world = c.world;
                retired.clear();
                triedProbes.clear();
                refusedFaces.clear();
                started = false;
            }
        }

        void step() {
            observeWorld();
            if (continueTravel()) return;
            if (sought != Resource.STONE) {
                sought = Resource.STONE;
                soughtSince = tick;
            }
            status = "seeking collectible stone for the first stone pickaxe";
            if (!safePickupStance() || !dryFieldFooting()) return;
            if (witnessedProbeWork() && cutting != null) {
                status = "finishing the witnessed first-stone probe cut";
                if (tick - lastProbeContact <= 3 && body.continueMine(cutting)) return;
                if (body.hasRecentView()) workProbe(c.player.getBlockPos(), pickUses(WOOD_PICK));
                return;
            }
            if (!body.hasRecentView()) return;
            BlockPos standing = c.player.getBlockPos();
            if (nextFoot != null) {
                closeDig(nextFoot);
                nextFoot = cavePeek = null;
            }
            int stock = hands.count(STONE);
            budget.observeStock(stock);
            // An actual new contact or a real pickup always beats a route, wear estimate or failed patch.
            if (workOre(Resource.STONE, REACH - 0.35, false)) {
                if (sightBlock != null) stopWalk();
                return;
            }
            if (body.dryCaveContact(standing) == null) {
                walk(standing);
                return;
            }
            if (c.player.getVelocity().horizontalLengthSquared() > 0.0025) return;
            int uses = pickUses(WOOD_PICK);
            Direction guarded = nightSite.mineBearing(standing);
            if (!started) beginPatch(standing, guarded == null ? c.player.getHorizontalFacing() : guarded, stock, uses, true);
            boolean fresh = !exhausted && budget.canDeepen(uses, retiredAt(standing)) && starterSteps < STARTER_STEPS;
            // A different distant face is not a pickup. Finish the already
            // chosen opening and verify its tread before resurveying the seam.
            if (probeTo != null) {
                if (directedProbe || probeTo.getY() == standing.getY() || fresh) {
                    workProbe(standing, uses);
                    return;
                }
                forgetProbe();
            }
            if (sightBlock != null) {
                walk(standing);
                return;
            }
            if (tick >= seekAfter) {
                var shown = body.find(Resource.STONE.block, STONE_VIEW, distantFace).orElse(null);
                if (shown != null) {
                    sightBlock = shown.getBlockPos();
                    sightPoint = orePoint(shown);
                    goal = new AgentResourceStance(Vec3d.ofBottomCenter(sightBlock), 1.02,
                        sightBlock.getY() - 2, sightBlock.getY());
                    walk(standing);
                    return;
                }
            }
            if (fresh && beginProbe(standing, true)) return;
            if (!exhausted) {
                exhausted = true;
                remember(retired, standing);
            }
            // A worn first pick in an enclosed, depleted pocket may need to open
            // a checked supply stair, rather than defer the missing-pick work.
            if (!triedSupplyExit && budget.depleted() && !supplyEgress.outdoors()) {
                triedSupplyExit = true;
                if (supplyEgress.leaveDepletedQuarry()) return;
            }
            if (sideProbes < SIDE_PROBES && beginProbe(standing, false)) return;
            if (uses < 3 - stock) {
                makePick("wooden_pickaxe", PLANK, 3);
                return;
            }
            if (lightDarkStair(standing)) return;
            walk(standing);
        }

        private boolean canApproach(BlockHitResult face) {
            BlockPos block = face.getBlockPos();
            return !refusedFaces.contains(c.player.getBlockPos(), block)
                && reachableResourceFace(block) && !protectRecoveryBlock(block)
                && !underMineFootprint(block) && !stoneStockFace(block)
                && c.player.getBlockY() - block.getY() <= 2 && block.getY() - c.player.getBlockY() <= 4
                && tools.canHarvest(state(face));
        }

        boolean continueTravel() {
            if (world != c.world || !safePickupStance()) return false;
            if (tread != null) {
                if (travelTick != tick - 1) {
                    finishTread();
                    return false;
                }
                stepTread();
                return true;
            }
            if (ordinaryRouteTick != tick - 1 || !navigator.driving(Job.STONE))
                return false;
            walk(c.player.getBlockPos());
            return true;
        }

        private void walk(BlockPos standing) {
            if (sightBlock != null && goal.reached(c.player.getPos()) && dryFieldFooting()
                    && !navigator.driving(Job.STONE)) {
                var hit = perceive(sightPoint, REACH - 0.35);
                if (hit != null && sightBlock.equals(hit.getBlockPos()) && stoneStockFace(sightBlock)
                        && Resource.STONE.block.test(state(hit)) && tools.canHarvest(state(hit))) {
                    stopWalk();
                    setTarget(hit, Resource.STONE);
                    quarryingStoneStock = true;
                    mineTarget(Resource.STONE);
                    return;
                }
                if (body.hasRecentView() && body.aligned(sightPoint)) refuseWalk(standing);
                else body.aim(sightPoint);
                status = "rechecking the exposed stone from its pickup stance";
                return;
            }
            Result result = goal == null ? navigate(Job.STONE, null, 0) : navigate(Job.STONE, goal);
            status = (sightBlock == null ? "seeking different stone-bearing ground; " : "approaching exposed stone; ") + status;
            var arrival = ordinaryArrival;
            if (goal == null && arrival != null && exhausted && !retiredAt(arrival.to())) {
                Direction outward = AgentDryLanding.bearing(arrival.from(), arrival.to());
                beginPatch(arrival.to(), outward, hands.count(STONE), pickUses(WOOD_PICK), false);
                status = "reached different witnessed ground to prospect for stone";
            }
            if (result == Result.BLOCKED && sightBlock != null) refuseWalk(standing);
        }

        private void refuseWalk(BlockPos standing) {
            BlockPos rock = sightBlock;
            if (rock != null) refusedFaces.remember(standing, rock);
            stopWalk();
            if (rock == null || probeTo != null || !dryFieldFooting() || !body.hasRecentView()) return;
            int dx = rock.getX() - standing.getX(), dz = rock.getZ() - standing.getZ();
            if (dx == 0 && dz == 0 || rock.getY() > standing.getY() + 2) return;
            Direction toward = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? Direction.EAST : Direction.WEST)
                : (dz > 0 ? Direction.SOUTH : Direction.NORTH);
            boolean down = rock.getY() < standing.getY();
            if (approachProbe(standing, rock, toward, down)) return;
            // Don't dig the seam out from above before the drop has a
            // collectible stance. Try beside it at the correct height.
            if (down && !approachProbe(standing, rock, toward.rotateYClockwise(), true))
                approachProbe(standing, rock, toward.rotateYCounterclockwise(), true);
        }

        private boolean approachProbe(BlockPos from, BlockPos rock, Direction direction, boolean down) {
            BlockPos to = from.offset(direction).down(down ? 1 : 0);
            if (!stoneApproachTread(from, rock, to) || !visibleProbe(from, to, direction)
                    || !startProbe(from, to, direction)) return false;
            directedProbe = true;
            status = "opening a short checked approach to the exposed stone";
            return true;
        }

        private void stopWalk() {
            sightBlock = null;
            sightPoint = null;
            goal = null;
        }

        private void landedBelowCanopy(AgentSurfaceTread crossing) {
            observeWorld();
            interrupt();
            if (crossing.ordinaryDescent()) {
                recordCaveFooting(crossing.to);
                stallGuard.navigationArrival(crossing.from, crossing.to);
            } else {
                navigator.rememberWalked(crossing.from, crossing.to);
                recordDryCaveFooting(crossing.from, crossing.to);
            }
        }

        private Direction directionAt(int step) {
            return switch (step) {
                case 0 -> forward;
                case 1 -> forward.rotateYClockwise();
                case 2 -> forward.rotateYCounterclockwise();
                default -> forward.getOpposite();
            };
        }

        private boolean beginProbe(BlockPos from, boolean down) {
            for (int index = 0; index < 4; index++) {
                Direction direction = directionAt(index);
                BlockPos to = from.offset(direction).down(down ? 1 : 0);
                if (triedProbes.contains(to) || !visibleProbe(from, to, direction) || !startProbe(from, to, direction))
                    continue;
                status = down ? "checking a one-step stone exposure" : "checking a different level stone probe";
                return true;
            }
            return false;
        }

        private boolean visibleProbe(BlockPos from, BlockPos to, Direction direction) {
            if (bearingDistance(body.defensiveViewYaw(), direction.getPositiveHorizontalDegrees()) > 48) return false;
            // This is excavation, not a route survey: commit only to a cut actually
            // visible in the current frame, never to another compass inspection.
            for (int height = to.getY() < from.getY() ? 2 : 1; height >= 0; height--) {
                BlockPos cell = to.up(height);
                var hit = perceive(Vec3d.ofCenter(cell, height == 0 ? 0.91 : 0.55), REACH - 0.35);
                if (hit == null || !cell.equals(hit.getBlockPos())) continue;
                return returnableCutAllowed(hit) && !supportsTrail(cell) && !body.lavaBreachesDig(cell);
            }
            return false;
        }

        private boolean startProbe(BlockPos from, BlockPos to, Direction direction) {
            if (triedProbes.contains(to) || trail.contains(to) || stallGuard.refusedCrossing(from, to)) return false;
            bearing = direction;
            probeFrom = from;
            probeTo = to;
            probeUntil = tick + PROBE_TICKS;
            probeCheckAt = tick + VIEW_TICKS;
            lastProbeContact = 0;
            directedProbe = false;
            probeHeight = to.getY() < from.getY() ? 2 : 1;
            remember(triedProbes, to);
            if (to.getY() == from.getY()) sideProbes++;
            return true;
        }

        private void workProbe(BlockPos standing, int uses) {
            boolean down = probeTo.getY() < probeFrom.getY();
            status = down ? "opening one shallow stone prospect step" : "opening a bounded level stone prospect";
            if (tick >= probeUntil || !probeFrom.equals(standing) || body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65)) {
                forgetProbe();
                return;
            }
            if (Math.abs(c.player.getX() - standing.getX() - 0.5) > 0.17
                    || Math.abs(c.player.getZ() - standing.getZ() - 0.5) > 0.17) {
                body.centerOnGroundedSupport(standing, body.dryCaveContact(standing));
                if (tick >= probeCheckAt) forgetProbe();
                return;
            }
            if (probeHeight < 0) {
                body.turn(bearing.getPositiveHorizontalDegrees(), down ? 55 : 30);
                var edge = body.witnessedOrdinaryTread(probeFrom, probeTo, bearing);
                if (edge == null) {
                    if (tick >= probeCheckAt) forgetProbe();
                    return; // No fresh full top, no motion and no deeper probe into this opening.
                }
                tread = AgentSurfaceTread.ordinaryStock(edge, probeFrom, tick);
                stepTread();
                return;
            }
            BlockPos cell = probeTo.up(probeHeight);
            Vec3d point = Vec3d.ofCenter(cell, down && probeHeight == 0 ? 0.91 : 0.55);
            body.aim(point);
            var hit = perceive(point, REACH - 0.35);
            if (hit == null || !cell.equals(hit.getBlockPos())) {
                var space = body.dryCaveSpace(point);
                if (space == AgentBody.DryRouteSample.CLEAR) nextProbeCell();
                else if (space == AgentBody.DryRouteSample.FLUID || tick >= probeCheckAt) forgetProbe();
                return;
            }
            BlockState material = state(hit);
            if (material.getCollisionShape(c.world, cell).isEmpty() && !AgentBody.dryCaveDanger(material)) {
                nextProbeCell();
                return;
            }
            Vec3d cap = Vec3d.ofCenter(cell.up(), 0.23);
            var cover = perceive(cap, REACH - 0.35);
            if (!returnableCutAllowed(hit) || supportsTrail(cell) || body.lavaBreachesDig(cell)
                    || cover != null && cover.getBlockPos().equals(cell.up()) && AgentHeadroom.unsafeCutCover(state(cover))) {
                forgetProbe();
                return;
            }
            if (cell.getY() >= standing.getY() && Resource.STONE.block.test(material)) {
                // The clearance ray can see a face the wider survey missed. At
                // this height it is stock work, never an excuse to cut past the pickup gate.
                if (stoneCutFoot != null || !stoneStockFace(cell)) {
                    forgetProbe();
                    return;
                }
                setTarget(hit, Resource.STONE);
                quarryingStoneStock = true;
                mineTarget(Resource.STONE);
                return;
            }
            if (material.isIn(BlockTags.PICKAXE_MINEABLE) && !budget.canSpendOnCover(uses)) {
                forgetProbe();
                return;
            }
            body.aimContact(hit, AgentBody.Contact.MINE);
            if (readyForMine(material)) {
                if (body.mine(hit)) {
                    cutting = cell;
                    lastProbeContact = tick;
                }
                else if (body.miningFootingRefused(cell)) forgetProbe();
            }
        }

        private void nextProbeCell() {
            probeHeight--;
            probeCheckAt = tick + VIEW_TICKS;
        }

        private void stepTread() {
            travelTick = tick;
            var current = tread;
            status = "testing the freshly witnessed footing opened by the stone probe";
            switch (current.step(c, body, tick)) {
                case CHECKING -> { }
                case MOVING -> rememberMotion();
                case LANDED -> {
                    navigator.rememberWalked(current.from, current.to);
                    recordDryCaveFooting(current.from, current.to);
                    if (current.to.getY() < current.from.getY()) {
                        starterSteps++;
                    } else if (!retiredAt(current.to)) {
                        beginPatch(current.to, bearing, hands.count(STONE), pickUses(WOOD_PICK), false);
                    }
                    finishTread();
                }
                case REFUSED -> finishTread();
            }
        }

        private void finishTread() {
            tread = null;
            forgetProbe();
        }

        private void forgetProbe() {
            probeFrom = probeTo = cutting = null;
        }

        private boolean retiredAt(BlockPos foot) {
            for (BlockPos site : retired) if (!differentStoneGround(site, foot)) return true;
            return false;
        }

        private void remember(ArrayList<BlockPos> sites, BlockPos foot) {
            if (sites.contains(foot)) return;
            if (sites.size() == REMEMBERED_WORK) sites.removeFirst();
            sites.add(foot);
        }
    }

    static boolean stoneApproachTread(BlockPos from, BlockPos rock, BlockPos to) {
        int dy = to.getY() - from.getY();
        if (dy < -1 || dy > 0 || Math.abs(from.getX() - to.getX()) + Math.abs(from.getZ() - to.getZ()) != 1
                || dy < 0 && (rock.getY() >= from.getY() || to.equals(rock))) return false;
        double before = from.getSquaredDistance(rock), after = to.getSquaredDistance(rock);
        return after < before || dy == -1 && to.getY() == rock.getY() && after == before && after <= 2;
    }

    private static boolean differentStoneGround(BlockPos first, BlockPos second) {
        return Math.abs(first.getX() - second.getX()) + Math.abs(first.getZ() - second.getZ()) >= 3;
    }

    private void setTarget(BlockHitResult hit, Resource resource) {
        target = hit.getBlockPos();
        miningResource = resource;
        quarryingStoneStock = false;
        targetPoint = orePoint(hit);
        targetDeadline = tick + 200;
        targetNearest = c.player.getEyePos().distanceTo(targetPoint);
        lastMining = 0;
        approachGoal = null;
    }

    private static Vec3d orePoint(BlockHitResult hit) {
        // A tiny inset retains the known face direction even after a small perspective change.
        return hit.getPos().lerp(Vec3d.ofCenter(hit.getBlockPos()), 0.045);
    }

    private boolean reachableResourceFace(BlockPos position) {
        return !ignored(position) && !position.equals(c.player.getBlockPos().down())
            && (!stallGuard.retryingDistinctWork() || !stallOreTried.contains(position));
    }

    private boolean stoneStockFace(BlockPos position) {
        return stoneWithinPickupStance(c.player.getBoundingBox(), position)
            && reachableResourceFace(position) && !supportsTrail(position);
    }

    static boolean stoneWithinPickupStance(Box hull, BlockPos block) {
        // Don't plan loose cargo below our feet. Leave a quarter-block margin inside
        // vanilla's lateral pickup envelope for spawn offset instead of relying on a
        // drop at the exact center. This is not proof of the drop's landing or a route.
        double x = block.getX() + 0.5, z = block.getZ() + 0.5;
        return block.getY() >= hull.minY && block.getY() <= hull.maxY + 0.5
            && x > hull.minX - 0.75 && x < hull.maxX + 0.75
            && z > hull.minZ - 0.75 && z < hull.maxZ + 0.75;
    }

    private void mineTarget(Resource resource) {
        status = "mining " + resource.label;
        if (!reachableResourceFace(target)) {
            abandonTarget();
            return;
        }
        double distance = c.player.getEyePos().distanceTo(targetPoint);
        if (quarryingStoneStock && (!stoneStockFace(target) || distance > REACH - 0.35)) {
            abandonTarget();
            return;
        }
        if (distance < targetNearest - 0.55) {
            targetNearest = distance;
            targetDeadline = tick + 200;
        }
        if (tick >= targetDeadline) {
            abandonTarget();
            return;
        }
        // Reachable with a pick is not necessarily collectible. For a valuable
        // seam two levels down, use the normal checked stair before opening it.
        boolean lowSeam = (resource == Resource.IRON || resource == Resource.DIAMOND)
            && c.player.getBlockY() - target.getY() >= 2;
        if ((distance > REACH - 0.35 || lowSeam) && c.player.getY() - target.getY() > 1.25
            && (resource == Resource.STONE || has(TORCH, 2))
            && c.player.isOnGround() && tick >= nextDigStart) {
            status = "cutting a staircase toward exposed " + resource.label;
            excavate(target.getY() + 1, targetPoint);
            return;
        }
        if (distance > REACH - 0.35) {
            status = "approaching " + resource.label;
            if (approachOrdinary(perceive(targetPoint, SEARCH), targetPoint, 0.92, true) == Walk.BLOCKED) abandonTarget();
            return;
        }
        body.aim(targetPoint);
        BlockHitResult hit = perceive(targetPoint, REACH);
        BlockState material = hit != null && hit.getBlockPos().equals(target) ? state(hit) : null;
        if (material == null || !resource.block.test(material)) {
            if (!body.aligned(targetPoint)) return;
            if (lastMining != 0 && tick - lastMining < 5) {
                pickupUntil = tick + 19;
                body.pauseWork();
                forgetOreTarget();
                target = null;
            } else if (!quarryingStoneStock && horizontalDistance(c.player.getPos(), targetPoint) > 0.72) {
                // A ramp changes the viewing angle; walk around the masking near face before giving up.
                if (approachOrdinary(perceive(targetPoint, SEARCH), targetPoint, 0.62, true) == Walk.BLOCKED) abandonTarget();
            } else {
                abandonTarget();
            }
            return;
        }
        if (!tools.canHarvest(material)) {
            abandonTarget();
            return;
        }
        body.aimContact(hit, AgentBody.Contact.MINE);
        if (!readyForMine(material)) {
            stallGuard.ordinarySetup();
            body.awaitingContactEquipment();
            return;
        }
        // An exposed block can also support a step of the escape route.
        if (lastMining == 0 && supportsTrail(target)) {
            abandonTarget();
            return;
        }
        if (body.mine(hit)) lastMining = tick;
        else if (body.miningFootingRefused(target)) abandonTarget();
    }

    private boolean supportsTrail(BlockPos block) {
        for (int i = trail.size() - 1; i >= 0; i--) {
            BlockPos step = trail.get(i);
            if (step.getY() == block.getY() + 1 && step.getX() == block.getX() && step.getZ() == block.getZ()) return true;
        }
        return false;
    }

    private void forgetOreTarget() {
        forgetOre(target);
    }

    private void forgetOre(BlockPos block) {
        for (int i = oreSights.size() - 1; i >= 0; i--) {
            if (oreSights.get(i).block.equals(block)) oreSights.remove(i);
        }
    }

    private void abandonTarget() {
        ignored[ignoreCursor] = target;
        if (oreProbeMining && oreProbe.block.equals(target)) rejectOreProbe();
        ignoredUntil[ignoreCursor] = tick + 220;
        ignoreCursor = (ignoreCursor + 1) % ignored.length;
        target = null;
        seekAfter = tick + 25;
        heading = c.player.getYaw() + 50;
        headingUntil = tick + 180;
    }

    private boolean ignored(BlockPos position) {
        for (int i = 0; i < ignored.length; ++i) {
            if (tick < ignoredUntil[i] && position.equals(ignored[i])) return true;
        }
        return false;
    }

    private boolean collect(Predicate<ItemStack> drop, double range) {
        if (tick < pickupBlockedUntil && pickupBlockedItem == drop) return false;
        if (pickupItem == drop) {
            if (pickupTread != null) return advancePickupTread();
            ItemEntity seen = body.seesDrop(pickupEntity, range) && drop.test(pickupEntity.getStack()) ? pickupEntity : null;
            if (collectObserved(drop, seen)) return true;
        }
        if (!safePickupStance()) return false;
        ItemEntity entity = visibleStock(drop, range);
        if (collectObserved(drop, entity)) return true;
        // An obstructed instance must not hide a second, independently visible stack.
        return entity != null && safePickupStance() && !canRetryDrop(entity)
            && collectObserved(drop, visibleStock(drop, range));
    }

    private ItemEntity visibleStock(Predicate<ItemStack> drop, double range) {
        BlockPos worksite = drop == LOG && timberWitness != null ? timberWitness.getBlockPos()
            : drop == timberDropItem && tick < timberDropUntil ? timberLastCut : null;
        return worksite == null ? body.dropped(drop, range, this::canRetryDrop).orElse(null)
            : body.dropped(drop, range, item -> canRetryDrop(item)
                && Math.abs(item.getX() - worksite.getX() - 0.5) <= 2.5
                && Math.abs(item.getZ() - worksite.getZ() - 0.5) <= 2.5).orElse(null);
    }

    private boolean collectObserved(Predicate<ItemStack> drop, ItemEntity entity) {
        return collectObserved(drop, entity, false);
    }

    private boolean collectObserved(Predicate<ItemStack> drop, ItemEntity entity, boolean requireSupportedApproach) {
        var player = c.player;
        if (!requireSupportedApproach && pickupItem == drop && pickupTread != null) return advancePickupTread();
        boolean logDriving = pickupLogGoal != null && drivingTimberResource();
        if (pickupItem == drop && !logDriving && pickupPursuit.stockGained(hands.count(drop))) {
            confirmPickupStock();
            return false;
        }
        if (entity != null && (!canRetryDrop(entity) || !drop.test(entity.getStack()))) entity = null;
        if (entity != null) {
            if (pickupEntity != entity || pickupItem != drop) {
                clearPickup();
                pickupEntity = entity;
                pickupItem = drop;
                pickupPursuit = new AgentPickup.Pursuit(tick, hands.count(drop), player.getPos(),
                    entity.getBoundingBox(), entity.isOnGround(), drop == LOG || drop == PLANK);
            } else pickupPursuit.observe(tick, player.getPos(), entity.getBoundingBox(), entity.isOnGround());
        }
        if (pickupItem != drop) return false;
        if (!safePickupStance()) return deferPickup(false);
        if (!logDriving && (pickupPursuit.expired(tick) || !pickupPursuit.canReacquire(tick)))
            return deferPickup(entity == null);
        if (pickupLogGoal != null) {
            if (advanceLogApproach()) return true;
            if (pickupItem != drop) return false;
        }
        if (entity == null) {
            if (requireSupportedApproach) return deferPickup(false);
            body.pauseWork();
            // The terrain glance can occlude the just-seen stack. Keep only that grounded
            // footprint and require a fresh tread proof; do not follow its unrendered position.
            if (pickupAccess()) return true;
            if (drop == LOG && startLogApproach()) return true;
            if (pickupItem != drop) return false;
            if (timberDropUntil != 0 && drop == timberDropItem) lookAtTimberDropSite();
            status = "waiting to see the witnessed drop again";
            return true;
        }
        if (!entity.isOnGround()) {
            // Its moving box is not evidence of a drop in the route surface. Coast
            // on the witnessed stance and reassess the same drop once it settles.
            if (!pickupPursuit.settling(tick)) return deferPickup(false);
            body.pauseWork();
            body.visibleHorizon().reportPickup(entity, "waiting_for_drop_to_settle", null);
            status = "letting the visible drop settle";
            return true;
        }
        if (!player.isOnGround()) {
            body.pauseWork();
            if (pickupPursuit.quietExpired(tick)) return deferPickup(false);
            status = "settling on the current footing before pickup";
            return true;
        }
        if (!requireSupportedApproach && drop == LOG && horizontalDistance(player.getPos(), entity.getPos()) > 2.45) {
            if (startLogApproach()) return true;
            if (pickupItem != drop) return false;
        }
        // Once a particular terrain check has begun, don't restart flat foot input
        // into its riser/edge every tick while the camera is trying to verify the top.
        if (!requireSupportedApproach && pickupAccessLook != null && pickupAccess()) return true;
        var result = body.pickUpVisible(entity, null, requireSupportedApproach);
        if (result == AgentBody.PickupResult.MOVING) {
            if (!pickupPursuit.quietExpired(tick)) {
                rememberMotion();
                status = "collecting visible drops on supported ground";
                return true;
            }
            body.pauseWork();
        }
        if (result == AgentBody.PickupResult.BLOCKED && !hands.stableCraftFooting()
                && !pickupPursuit.quietExpired(tick)) {
            status = "settling on the current footing before pickup";
            return true;
        }
        if (!requireSupportedApproach && pickupAccessLook == null && pickupAccess()) return true;
        if (!requireSupportedApproach && drop == LOG && startLogApproach()) return true;
        if (pickupItem != drop) return false;
        boolean passive = AgentPickup.passiveOverlap(player.getBoundingBox(), entity.getBoundingBox());
        if (result != AgentBody.PickupResult.WAITING || pickupPursuit.quietExpired(tick)
                || requireSupportedApproach && !passive) return deferPickup(pickupAccessLook != null);
        status = "waiting for vanilla to collect a nearby drop";
        return true;
    }

    private boolean startLogApproach() {
        if (timberCollectionGoal != null || !timberResourceAllowed(false) || pickupEntity.isRemoved()) return false;
        var goal = AgentPickup.logApproach(c.player.getBoundingBox(), pickupPursuit.groundedBounds(tick));
        if (goal == null) return false;
        pickupAccessLook = null;
        pickupLogGoal = goal;
        return advanceLogApproach();
    }

    private boolean advanceLogApproach() {
        boolean driving = drivingTimberResource();
        if (!timberResourceAllowed(driving)) return deferPickup(false);
        if (!driving) {
            Box drop = pickupPursuit.groundedBounds(tick);
            if (drop == null || pickupEntity.isRemoved()) return deferPickup(false);
            if (AgentPickup.passiveOverlap(c.player.getBoundingBox(), drop)
                    || pickupLogGoal.reached(c.player.getPos())) {
                clearLogApproach();
                return false;
            }
        }
        timberResourceTick = tick;
        if (navigate(Job.TIMBER, pickupLogGoal) == Result.BLOCKED) return deferPickup(false);
        return true;
    }

    private boolean pickupAccess() {
        Box drop = pickupPursuit.groundedBounds(tick);
        var player = c.player;
        if (drop == null || nextFoot != null || oreProbeReturning || !player.isOnGround()
                || !AgentPickup.shouldCheckDryAccess(player.getBoundingBox(), drop, true, pickupPursuit.quiet(tick))) return false;
        BlockPos from = player.getBlockPos();
        boolean stable = hands.stableCraftFooting();
        AgentSurfaceTread.Edge edge = null;
        boolean first = pickupAccessLook == null;
        if (!first && tick >= pickupLookUntil) return false;
        if (first) {
            if (stable) {
                edge = AgentPickup.selectDryAccess(player.getBoundingBox(), drop, from, true, (foot, bearing) ->
                    AgentBody.drySurveyLaneCentered(from, player.getX(), player.getZ(), bearing)
                        ? body.witnessedOrdinaryTread(from, foot, bearing) : null);
            }
            if (edge == null) {
                pickupAccessLook = AgentPickup.dryAccess(player.getBoundingBox(), drop, from, true, (foot, bearing) -> true);
                if (pickupAccessLook == null) return false;
                pickupLookUntil = tick + 20;
            }
        }
        body.pauseWork();
        status = "checking the ground beside the witnessed drop";
        if (edge == null) {
            var access = pickupAccessLook;
            if (!AgentSurfaceTread.cardinalTread(from, access.foot(), access.bearing())
                    || !overlapsFrom(access.foot(), drop)) return false;
            if (!stable) return true;
            if (!AgentBody.drySurveyLaneCentered(from, player.getX(), player.getZ(), access.bearing())) {
                return body.centerOnGroundedSupport(from, body.dryCaveContact(from));
            }
            if (!first) edge = body.witnessedOrdinaryTread(from, access.foot(), access.bearing());
            if (edge == null) {
                lookAtStockTread(from, access.foot(), access.bearing());
                return true;
            }
        }
        pickupTread = AgentSurfaceTread.ordinaryStock(edge, from, tick);
        pickupTreadTick = tick;
        body.visibleHorizon().reportPickupUnseen(pickupEntity, "witnessed_dry_tread");
        return true;
    }

    private boolean overlapsFrom(BlockPos foot, Box drop) {
        var player = c.player;
        return AgentPickup.passiveOverlap(player.getBoundingBox(), drop,
            foot.getX() + 0.5 - player.getX(), foot.getY() - player.getY(), foot.getZ() + 0.5 - player.getZ());
    }

    private void lookAtStockTread(BlockPos from, BlockPos to, Direction bearing) {
        // Follow the fixed terrain opening, not the item's camera-space motion.
        float pitch = to.getY() < from.getY() ? 51 : to.getY() > from.getY() ? 13 : AgentBody.LEVEL_ROUTE_PITCH;
        body.turnFine(bearing.getPositiveHorizontalDegrees(), pitch);
    }

    private boolean advancePickupTread() {
        if (pickupTreadTick != tick - 1 || !safePickupStance()) return deferPickup(false);
        pickupTreadTick = tick;
        body.pauseWork();
        var player = c.player;
        boolean underway = pickupTread.inFlight() && (!player.isOnGround()
            || !player.getBlockPos().equals(pickupTread.from) || !hands.stableCraftFooting());
        boolean gained = pickupPursuit.stockGained(hands.count(pickupItem));
        if (pickupLandedTick >= 0 || !underway && gained) {
            if (gained) {
                confirmPickupStock();
                return false;
            }
            if (tick - pickupLandedTick >= 8) return deferPickup(false);
            status = "waiting for vanilla to collect from the dry tread";
            return true;
        }
        if (!underway) {
            if (body.seesDrop(pickupEntity, REACH) && pickupItem.test(pickupEntity.getStack())) {
                pickupPursuit.observe(tick, player.getPos(), pickupEntity.getBoundingBox(), pickupEntity.isOnGround());
            }
            Box grounded = pickupPursuit.groundedBounds(tick);
            if (pickupEntity.isRemoved() || grounded == null || !overlapsFrom(pickupTread.to, grounded))
                return deferPickup(false);
        }
        switch (pickupTread.step(c, body, tick)) {
            case CHECKING -> status = "checking the witnessed pickup tread";
            case MOVING -> {
                rememberMotion();
                status = "approaching the drop along the witnessed dry tread";
            }
            case REFUSED -> { return deferPickup(false); }
            case LANDED -> {
                body.recordWalkedLeg(pickupTread.from, pickupTread.to);
                body.visibleHorizon().reportPickupUnseen(pickupEntity, "dry_tread_landed");
                pickupLandedTick = tick;
                status = "waiting for vanilla to collect from the dry tread";
            }
        }
        return true;
    }

    private boolean safePickupStance() {
        var player = c.player;
        return c.isWindowFocused() && c.getOverlay() == null
            && !player.isTouchingWater() && !player.isInLava() && !player.isOnFire() && player.hurtTime == 0
            && !player.hasVehicle() && !player.getAbilities().flying
            && !body.lavaEmergency() && !body.macroLavaNear();
    }

    private void confirmPickupStock() {
        body.visibleHorizon().reportPickupUnseen(pickupEntity, "inventory_gain");
        if (miningResource != null && miningResource.drop == pickupItem) pickupUntil = 0;
        if (pickupLightItem == pickupItem) pickupLightItem = null;
        clearPickup();
    }

    private boolean canRetryDrop(ItemEntity entity) {
        for (int i = 0; i < deferredDrops.length; i++)
            if (deferredDrops[i] == entity && tick < deferredDropUntil[i]) return false;
        return true;
    }

    private void rememberPickupLight(Predicate<ItemStack> item) {
        if (safePickupStance() && c.player.isOnGround()
                && c.world.getLightLevel(c.player.getBlockPos()) <= 3
                && (has(TORCH, 1) || torchCraftBatches(4) > 0)) {
            pickupLightItem = item;
            pickupLightStock = hands.count(item);
            pickupLightFoot = c.player.getBlockPos();
            pickupLightUntil = tick + 100;
        }
    }

    private boolean deferPickup(boolean groundUnproved) {
        if (groundUnproved && pickupResource(pickupItem) != null) rememberPickupLight(pickupItem);
        deferredDrops[deferredDropCursor] = pickupEntity;
        deferredDropUntil[deferredDropCursor] = tick + 45;
        deferredDropCursor = (deferredDropCursor + 1) % deferredDrops.length;
        clearPickup();
        return false;
    }

    private boolean lightForPickup(Predicate<ItemStack> drop) {
        if (pickupLightItem != drop) return false;
        if (tick >= pickupLightUntil || !c.player.getBlockPos().equals(pickupLightFoot) || hands.count(drop) > pickupLightStock) {
            pickupLightItem = null;
            return false;
        }
        if (!safePickupStance() || !hands.stableCraftFooting()) return false;
        body.pauseWork();
        if (!has(TORCH, 1)) {
            if (craftTorches(4)) return true;
        } else if (shouldLight(true)) {
            status = "lighting the harvested pocket to check for a drop";
            return true;
        }
        pickupLightItem = null;
        return false;
    }

    private void clearPickup() {
        clearLogApproach();
        pickupEntity = null;
        pickupItem = null;
        pickupPursuit = null;
        pickupTread = null;
        pickupAccessLook = null;
        pickupLandedTick = -1;
    }

    private void clearLogApproach() {
        pickupLogGoal = null;
    }

    private void abandonPickup(Predicate<ItemStack> drop, int duration) {
        if (drop == LOG || drop == PLANK) {
            deferPickup(false);
            return;
        }
        clearPickup();
        pickupBlockedItem = drop;
        pickupBlockedUntil = tick + duration;
    }

    /** An optional local pickup, not a route to the place of death. */
    private final class DropReclaim {
        private static final double RANGE = 3.25;
        private static final int TICKS = 52;
        private static final float LOOK_DOWN = 48;
        private final ClientWorld world = c.world;
        private final Vec3d origin = c.player.getPos();
        private final long deadline = System.nanoTime() + 4_000_000_000L;
        private final int startTick = body.actionTick();
        private final float startYaw = c.player.getYaw();
        private final Predicate<Entity> candidate = this::isLocalDrop;
        private int lastTick = startTick;
        private int sweep, settled, unseen, before;
        private boolean cancelled, triedWalkedTurn;
        private ItemEntity target;
        private Item item;
        private Predicate<ItemStack> collected;
        private Vec3d waypoint;

        void cancel() { cancelled = true; }

        void step() {
            int now = body.actionTick();
            // The subtitle-driven escape can take over without calling Progress.
            if (cancelled || now > lastTick + 1 || c.player.isOnFire() || c.player.isTouchingWater()
                    || c.player.hasVehicle()) {
                finish("unsafe to stop for drops");
                return;
            }
            lastTick = now;
            if (c.world != world || now - startTick >= TICKS || System.nanoTime() - deadline >= 0
                    || origin.squaredDistanceTo(c.player.getPos()) > RANGE * RANGE) {
                finish("local drop check ended");
                return;
            }
            if (target != null && hands.count(collected) > before) {
                status = "picked up " + Registries.ITEM.getId(item) + " while checking visible drops after respawn";
                target = null;
                waypoint = null;
                return;
            }
            if (!c.player.isOnGround() || !body.hasRecentView()) {
                if (target != null || now - startTick > 10) finish("no safe rendered footing");
                return;
            }
            ItemEntity seen = (ItemEntity) body.visibleEntity(candidate, RANGE).orElse(null);
            if (seen == null) {
                if (target != null) {
                    if (++unseen > 3) finish("drop no longer in sight");
                    else {
                        status = "rechecking the last visible drop after respawn";
                        body.pauseWork();
                    }
                } else {
                    lookAround();
                }
                return;
            }
            if (target == null) {
                target = seen;
                item = seen.getStack().getItem();
                collected = AgentProgress.item(item);
                before = hands.count(collected);
            }
            unseen = 0;
            status = "collecting nearby visible drops after respawn";
            if (waypoint != null && horizontalDistance(c.player.getPos(), waypoint) <= 0.27) waypoint = null;
            if (body.pickUpVisible(seen, waypoint, false) != AgentBody.PickupResult.BLOCKED) return;
            if (waypoint == null && !triedWalkedTurn) {
                triedWalkedTurn = true;
                waypoint = walkedTurn(seen.getPos());
                if (waypoint != null) return;
            }
            finish("no safe grounded approach");
        }

        private boolean isLocalDrop(Entity entity) {
            if (!(entity instanceof ItemEntity drop) || target != null && target != drop) return false;
            Vec3d point = drop.getPos();
            if (Math.abs(point.y - c.player.getY()) > 0.32
                    || origin.squaredDistanceTo(point) > RANGE * RANGE) return false;
            ItemStack stack = drop.getStack();
            return stack.isIn(ItemTags.PICKAXES) || AXE.test(stack) || LOG.test(stack)
                || PLANK.test(stack) || FOOD.test(stack) || STONE.test(stack)
                || TORCH.test(stack) || RAW_IRON.test(stack) || INGOT.test(stack)
                || DIAMOND.test(stack) || PORTAL_BUCKET.test(stack) || IGNITER.test(stack);
        }

        private void lookAround() {
            if (sweep == 4) {
                finish("no more nearby drops in sight");
                return;
            }
            status = "looking for nearby drops after respawn";
            float bearing = startYaw + 100 * sweep;
            body.turn(bearing, LOOK_DOWN);
            if (bearingDistance(bearing, c.player.getYaw()) <= 9 && Math.abs(c.player.getPitch() - LOOK_DOWN) <= 7) {
                if (++settled >= 2) {
                    sweep++;
                    settled = 0;
                }
            } else settled = 0;
        }

        private Vec3d walkedTurn(Vec3d drop) {
            BlockPos standing = c.player.getBlockPos();
            int index = trail.lastIndexOf(standing);
            if (index < 0) return null;
            Vec3d next = null;
            double best = drop.squaredDistanceTo(c.player.getPos()) - 0.5;
            for (int offset = -1; offset <= 1; offset += 2) {
                int candidate = index + offset;
                if (candidate < 0 || candidate >= trail.size()) continue;
                BlockPos step = trail.get(candidate);
                if (step.getY() != standing.getY() || step.equals(standing) || !adjacent(step, standing)) continue;
                Vec3d center = Vec3d.ofBottomCenter(step);
                double remaining = center.squaredDistanceTo(drop);
                if (remaining < best && origin.squaredDistanceTo(center) <= RANGE * RANGE) {
                    next = center;
                    best = remaining;
                }
            }
            return next;
        }

        private void finish(String reason) {
            dropReclaim = null;
            body.pauseWork();
            status = "re-gearing after respawn: " + reason;
        }
    }

    private int pickUses(Predicate<ItemStack> kind) {
        int total = 0;
        var inventory = c.player.getInventory();
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inventory.getStack(slot);
            if (kind.test(stack)) total += stack.getMaxDamage() - stack.getDamage();
        }
        return total;
    }

    private boolean readyForMine(BlockState state) {
        if (state.isIn(BlockTags.PICKAXE_MINEABLE) && !Resource.DIAMOND.block.test(state)) {
            var inventory = c.player.getInventory();
            if (STONE_PICK.test(c.player.getMainHandStack()) && c.player.getMainHandStack().isSuitableFor(state)) return true;
            for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
                ItemStack stack = inventory.getStack(slot);
                if (STONE_PICK.test(stack) && stack.isSuitableFor(state)) return hands.equipSlot(slot);
            }
        }
        return tools.readyFor(state);
    }

    private int activeTrail() {
        return resumeIndex < 0 ? trail.size() : resumeIndex;
    }

    /** A new surface mine starts from walked ground, not from the top of a tree or scaffold. */
    private final class SurfaceApproach {
        private static final int APERTURE_TICKS = 50, OPEN_LOOK_TICKS = 24;

        private final BlockPos[] visited = new BlockPos[24];
        private final List<BlockPos> route = new ArrayList<>(24);
        private final List<BlockPos> rejected = new ArrayList<>(16);
        private final List<BlockPos> triedLeaves = new ArrayList<>(6);
        private final AgentSupplyEgress.CanopyPassage canopy = new AgentSupplyEgress.CanopyPassage();
        private BlockPos entrance, from, to;
        private BlockPos cut, routeCut;
        private Vec3d cutAim;
        private AgentSurfaceTread canopyTread;
        private ClientWorld stoneCanopyWorld;
        private CanopyStep raisedCanopy;
        private boolean natural, canopyStone, canopyDropSeparated;
        private int canopySince, canopyTreadTick;
        private int view, since, proof, cuts, cutSince, visitedCursor, backtracks, equippedCheck;
        private float surveyYaw;

        private boolean findingGround() {
            return from != null && entrance == null && activeTrail() < 4;
        }

        private void abandon() {
            from = to = cut = routeCut = null;
            abandonBootstrapPassage();
        }

        private boolean protectedCanopyLeaf(BlockPos leaf) {
            return protectRecoveryBlock(leaf) || navigator.walkedSupport(leaf) || canopy.walkedSupport(leaf);
        }

        private void resetStoneCanopy() {
            stoneCanopyWorld = c.world;
            raisedCanopy = null;
        }

        private void raisedFromCanopy(BlockPos foot, BlockState base) {
            if (stoneCanopyWorld != c.world) resetStoneCanopy();
            raisedCanopy = CanopyStep.confirmed(foot, base, exactCanopyContact(foot), tick);
        }

        private BlockState stoneCanopySupport(BlockPos foot) {
            if (!bootstrapStone) return null;
            BlockState contact = exactCanopyContact(foot);
            return firstStoneCanopyContact(foot, contact, stoneCanopyWorld == c.world ? raisedCanopy : null, tick)
                ? contact : null;
        }

        private boolean stoneCanopyWorking() {
            return bootstrapStone && canopyStone && canopyTread != null && canopyTreadTick == tick - 1;
        }

        private boolean seekStoneCanopy() {
            if (!bootstrapStone || returnIndex >= 0 || exitStart != null || oreProbeReturning || workshopReturn != null
                    || returnableMine.active() || supplyEgress.active() || mineResite.active()
                    || caves.active() || caves.routingDry() || to != null || continuingTimberTread()
                    || portal != null && portal.locallyStopped()
                    || stallGuard.ownsRecovery() && !stallGuard.waitingForEvidence()
                    || firstStone.witnessedProbeWork() || finishingOreCut(Resource.STONE)) return false;
            if (stoneCanopyWorld != c.world) resetStoneCanopy();
            return visibleCanopyWork(c.player.getBlockPos(), true);
        }

        /** Only a witnessed aperture cut or an exceptional descent takes over the normal route. */
        private boolean visibleCanopyWork(BlockPos foot, boolean stone) {
            BlockState source = stone ? stoneCanopySupport(foot) : bootstrapSupport(foot);
            if (source == null || !hands.stableCraftFooting() || !body.hasRecentView()) return false;
            float yaw = body.defensiveViewYaw();
            for (Direction bearing : Direction.Type.HORIZONTAL) {
                float direction = bearing.getPositiveHorizontalDegrees();
                if (bearingDistance(yaw, direction) > 37 || body.hazardAhead(direction, 1.65)) continue;
                BlockPos side = foot.offset(bearing);
                if (stone && takeStoneCanopyTread(foot, source, side, bearing)) return true;
                if (noteBootstrapLane(foot, bearing) && beginBootstrapPassage(foot, bearing, stone))
                    return true;
            }
            return false;
        }

        private boolean takeStoneCanopyTread(BlockPos foot, BlockState source, BlockPos side, Direction bearing) {
            if (body.caveLipFooting(foot) != source) return false;
            for (int height = 2; height <= AgentDryLanding.MAX_DROP; height++) {
                if (!permitsOneWayCaveDrop(height)) continue;
                BlockPos landing = side.down(height);
                if (stallGuard.refusedCrossing(foot, landing)) continue;
                BlockState floor = body.overlandTop(landing.down(), bearing, AgentBody::dryCaveDanger);
                if (floor == null || !naturalGround(floor) || floor.getBlock() instanceof FallingBlock) continue;
                // Both supports are witnessed. The ordinary descent motor still
                // proves the exact lit top, low-impact coast and stable landing.
                var edge = new AgentSurfaceTread.Edge(foot, source, landing, floor, bearing);
                beginCanopyTread(AgentSurfaceTread.recall(edge, false, tick, AgentSurfaceTread.RecallPolicy.ORDINARY));
                return true;
            }
            return false;
        }

        private void beginCanopyTread(AgentSurfaceTread tread) {
            canopyStone = true;
            canopyTread = tread;
            canopyTreadTick = tick;
            status = "preparing the checked descent toward visibly solid ground below the canopy";
        }

        private boolean controlsCanopyFall() {
            return bootstrapStone && canopyStone && canopyTread != null && canopyTread.ordinaryDescent()
                && canopyTread.controlsShortFall(c, body, tick);
        }

        private boolean separateCanopyDrop() {
            var tread = canopyTread;
            if (tread == null || !tread.ordinaryDescent() || !tread.leftTakeoff(c)) return false;
            if (!canopyDropSeparated) {
                detachMine(tread.from);
                canopyDropSeparated = true;
            }
            return true;
        }

        private boolean noteBootstrapLane(BlockPos foot, Direction bearing) {
            BlockPos side = foot.offset(bearing);
            BlockPos worksite = side.offset(bearing).down(2);
            BlockState floor = body.overlandTop(worksite, bearing, AgentProgress::dangerous);
            boolean seenWorksite = floor != null && (naturalGround(floor) || floor.isIn(BlockTags.LOGS));
            if (seenWorksite) {
                canopy.productive(foot, worksite);
                BlockPos leaf = side.down();
                if (canopy.available(foot, leaf) && !protectedCanopyLeaf(leaf)
                        && !stallGuard.refusedCrossing(foot, leaf)) {
                    // Admit the top only when it actually masks the adjacent lower sightline.
                    Vec3d point = Vec3d.ofBottomCenter(leaf)
                        .add(0.42 * bearing.getOffsetX(), -0.025, 0.42 * bearing.getOffsetZ());
                    var hit = terrain(point, 3.5);
                    if (hit != null && timberInReach(hit) && AgentSupplyEgress.canopyTopLeaf(foot, bearing, hit, state(hit), false)) {
                        canopy.offer(foot, bearing, hit, seenWorksite);
                        return seenWorksite;
                    }
                }
            }
            for (int height = 1; height >= 0; height--) {
                BlockPos leaf = side.up(height);
                if (protectedCanopyLeaf(leaf) || !canopy.available(foot, leaf)) continue;
                var hit = perceive(Vec3d.ofCenter(leaf), 2.5);
                if (hit != null && hit.getBlockPos().equals(leaf) && timberInReach(hit)
                        && AgentSupplyEgress.canopyLeaf(foot, bearing, hit, state(hit), false)
                        && (height == 1 || body.overlandTop(leaf, bearing, AgentProgress::dangerous) == null)) {
                    canopy.offer(foot, bearing, hit, seenWorksite);
                    return seenWorksite;
                }
            }
            return false;
        }

        private boolean cutTimberMask(Vec3d trunk) {
            BlockPos foot = c.player.getBlockPos();
            if (bootstrapSupport(foot) == null || !hands.stableCraftFooting()) return false;
            var hit = perceive(trunk, SEARCH);
            if (hit != null && trunk.y < foot.getY() && timberInReach(hit)
                    && hit.getPos().squaredDistanceTo(c.player.getEyePos()) < trunk.squaredDistanceTo(c.player.getEyePos())) {
                BlockPos leaf = hit.getBlockPos();
                Direction bearing = AgentSurfaceTread.prospectLevelBearing(foot, leaf.up());
                if (bearing != null && AgentSupplyEgress.canopyTopLeaf(foot, bearing, hit, state(hit), protectedCanopyLeaf(leaf))) {
                    canopy.offer(foot, bearing, hit, true);
                    return beginBootstrapPassage(foot, bearing, false);
                }
            }
            return cutTimberMask(foot, hit);
        }

        private boolean cutTimberMask(BlockPos foot, BlockHitResult hit) {
            if (hit == null || !timberInReach(hit)) return false;
            BlockPos leaf = hit.getBlockPos();
            Direction bearing = AgentSurfaceTread.prospectLevelBearing(foot, leaf);
            if (bearing == null || !AgentSupplyEgress.canopyLeaf(foot, bearing, hit, state(hit), protectedCanopyLeaf(leaf))
                    || leaf.getY() == foot.getY() && body.overlandTop(leaf, bearing, AgentProgress::dangerous) != null)
                return false;
            canopy.offer(foot, bearing, hit, false);
            return beginBootstrapPassage(foot, bearing, false);
        }

        private boolean beginBootstrapPassage(BlockPos foot, Direction bearing, boolean stone) {
            if (timberChop != null || (stone ? stoneCanopySupport(foot) : bootstrapSupport(foot)) == null
                    || !hands.stableCraftFooting() || !body.hasRecentView()) return false;
            var plan = bearing == null ? canopy.begin(foot) : canopy.begin(foot, bearing);
            if (plan == null) return false;
            if (protectedCanopyLeaf(plan.face().getBlockPos())
                    || body.hazardAhead(plan.bearing().getPositiveHorizontalDegrees(), 1.5)) {
                canopy.finish();
                return false;
            }
            if (ordinaryApproach != null) {
                body.stopHorizonTravel(ordinaryApproach);
                ordinaryApproach = null;
            }
            body.pauseWork();
            canopyStone = stone;
            canopySince = tick;
            beginTimberChop(plan.face(), true);
            status = plan.top() ? "lining up a witnessed leaf top from settled footing"
                : "lining up a witnessed leaf passage from settled footing";
            return true;
        }

        private boolean workBootstrapPassage() {
            if (canopyTread != null) return stepBootstrapDescent();
            var plan = canopy.active();
            if (plan == null) return false;
            BlockPos leaf = plan.face().getBlockPos();
            BlockState source = canopyStone ? stoneCanopySupport(plan.foot()) : bootstrapSupport(plan.foot());
            if (source == null || protectedCanopyLeaf(leaf)
                    || body.hazardAhead(plan.bearing().getPositiveHorizontalDegrees(), 1.5)) {
                abandonBootstrapPassage();
                return false;
            }
            if (canopy.opened()) {
                body.pauseWork();
                if (tick - canopySince >= OPEN_LOOK_TICKS) {
                    abandonBootstrapPassage();
                    return false;
                }
                long frame = body.renderedFrame();
                if (!hands.stableCraftFooting() || !body.hasRecentView() || !canopy.freshOpening(frame)) return true;
                if (canopyStone) {
                    Direction bearing = plan.bearing();
                    if (takeStoneCanopyTread(plan.foot(), source, plan.foot().offset(bearing), bearing)) return true;
                    if (plan.top()) {
                        lookAtStockTread(plan.foot(), leaf, bearing);
                        status = "checking the opened canopy for dry solid ground below";
                        return true;
                    }
                    abandonBootstrapPassage();
                    return true;
                }
                if (plan.top()) {
                    if (cutTimberFromTread(false)) {
                        abandonBootstrapPassage();
                        return true;
                    }
                    Direction bearing = plan.bearing();
                    if (stallGuard.refusedCrossing(plan.foot(), leaf)) {
                        abandonBootstrapPassage();
                        return false;
                    }
                    var player = c.player;
                    if (!AgentBody.drySurveyLaneCentered(plan.foot(), player.getX(), player.getZ(), bearing)
                            && body.centerOnGroundedSupport(plan.foot(), source)) return true;
                    var edge = canopy.revealedDescent(frame, body.witnessedOrdinaryTread(plan.foot(), leaf, bearing));
                    if (edge == null) {
                        lookAtStockTread(plan.foot(), leaf, bearing);
                        status = "checking the opened canopy for a dry lower tread and a return jump";
                        return true;
                    }
                    canopyTread = AgentSurfaceTread.ordinaryStock(edge, plan.foot(), tick);
                    canopyTreadTick = tick - 1;
                    return stepBootstrapDescent();
                }
                if (timberWitness != null) {
                    timberNear = false;
                    timberScan = 0;
                    timberWorkUntil = tick + TIMBER_WORK_TICKS;
                }
                abandonBootstrapPassage();
                return false;
            }
            if (timberChop == null || tick - canopySince >= APERTURE_TICKS) {
                abandonBootstrapPassage();
                return false;
            }
            stallGuard.navigationWork();
            if (hands.stableCraftFooting()) {
                if (body.hasRecentView()) chopTimber();
                else continueTimberAttack();
            }
            return true;
        }

        private boolean stepBootstrapDescent() {
            var tread = canopyTread;
            body.pauseWork();
            if (canopyTreadTick != tick - 1 || !(canopyStone ? bootstrapStone : bootstrapTimber)
                    || !safePickupStance() || c.player.getHealth() < 10
                    || tread.ordinaryDescent() && !tread.leftTakeoff(c)
                        && !permitsOneWayCaveDrop(tread.from.getY() - tread.to.getY())) {
                abandonBootstrapPassage();
                return false;
            }
            canopyTreadTick = tick;
            switch (tread.step(c, body, tick)) {
                case CHECKING -> status = tread.ordinaryDescent() ? "checking the bounded one-way descent off the canopy"
                    : "verifying the reversible step off the canopy";
                case MOVING -> {
                    rememberMotion();
                    status = "stepping down from the canopy to a witnessed dry shelf";
                }
                case LANDED -> {
                    if (exactCanopyContact(tread.to) != tread.edge.lowerSupport()) {
                        abandonBootstrapPassage();
                        return false;
                    }
                    if (canopyStone) {
                        separateCanopyDrop();
                        firstStone.landedBelowCanopy(tread);
                        bootstrapLanded(tread.from, tread.to, true);
                        abandonBootstrapPassage();
                        status = "reached witnessed solid ground below the canopy to seek stone";
                        return true;
                    }
                    body.recordWalkedLeg(tread.from, tread.to);
                    navigator.rememberWalked(tread.from, tread.to);
                    stallGuard.navigationArrival(tread.from, tread.to);
                    timberNear = false;
                    timberScan = 0;
                    timberWorkUntil = tick + TIMBER_WORK_TICKS;
                    abandonBootstrapPassage();
                    bootstrapLanded(tread.from, tread.to);
                    status = "reached the dry shelf below the canopy";
                    return true;
                }
                case REFUSED -> {
                    stallGuard.refuseCrossing(tread.from, tread.to);
                    abandonBootstrapPassage();
                    return false;
                }
            }
            stallGuard.navigationWork();
            return true;
        }

        private void bootstrapLanded(BlockPos source, BlockPos landing) {
            bootstrapLanded(source, landing, false);
        }

        private void bootstrapLanded(BlockPos source, BlockPos landing, boolean stone) {
            var floor = stone ? exactCanopyContact(landing) : bootstrapSupport(landing);
            if (floor == null) return;
            canopy.landed(source, landing);
            if (naturalGround(floor) || floor.isIn(BlockTags.LOGS))
                canopy.productive(landing, landing.down());
        }

        private boolean bootstrapBroken(BlockPos leaf) {
            if (timberAttack == 0 || !canopy.broken(leaf, body.renderedFrame())) return false;
            canopySince = tick;
            return true;
        }

        private void abandonBootstrapPassage() {
            var plan = canopy.active();
            if (plan != null && timberCuttingLeaves && timberChop != null
                    && timberChop.getBlockPos().equals(plan.face().getBlockPos())) timberChop = null;
            canopy.finish();
            canopyTread = null;
            canopyStone = false;
            canopyDropSeparated = false;
        }

        private boolean checkEquippedMine() {
            if (equippedCheck == 0) equippedCheck = tick;
            if (tick - equippedCheck > 32) return false;
            if (!c.player.isOnGround() || c.player.isTouchingWater()) return false;
            BlockPos standing = c.player.getBlockPos();
            Vec3d point = c.player.getPos().add(0, -0.06, 0);
            body.turnFixed(c.player.getYaw(), 86);
            status = "checking the rock footing of the equipped expedition";
            BlockHitResult floor = terrain(point, c.player.getEyePos().distanceTo(point) + 0.09);
            if (!visibleTop(floor, standing)) return true;
            if (!state(floor).isIn(BlockTags.BASE_STONE_OVERWORLD)) {
                equippedCheck = tick - 33;
                return false;
            }
            // We are already standing on witnessed rock with working picks and light.
            // Do not hunt a surface forest from this local mining stance.
            entrance = standing;
            departureKit = timberReady = true;
            status = "confirmed rock footing for the equipped expedition";
            return true;
        }

        private boolean step(BlockPos standing) {
            if (resumeIndex >= 0) {
                abandon();
                return false;
            }
            if (to == null && (activeTrail() >= 4 || entrance != null
                    && (entrance.equals(standing) || !trail.isEmpty() && entrance.equals(trail.getFirst())))) return false;
            // This ground search is for an observed open approach. An unclassified
            // high mine landing must reach mining/light preparation instead.
            if (from == null && !c.player.isTouchingWater() && !supplyEgress.outdoors()
                    && (body.supplyPerspective(c.player.getYaw()) & AgentBody.SUPPLY_OPEN) == 0) return false;
            status = "checking for walkable ground before starting a surface mine";
            if (c.player.isTouchingWater()) {
                to = cut = routeCut = null;
                explore();
                return true;
            }
            if (ordinarySurfaceWork) {
                to = routeCut = null;
                if (!dryFieldFooting() || !safePickupStance()) return true;
                BlockState support = body.dryCaveContact(standing);
                if (support != null && naturalGround(support)) {
                    markMineEntrance(standing);
                    return true;
                }
                from = standing;
                if (body.hasRecentView() && cutSightline()) return true;
                navigate(Job.EXPLORE, null, 0);
                return true;
            }
            if (to != null && proof == 4) return traverse();
            if (!c.player.isOnGround()) return true;
            if (!standing.equals(from)) {
                recordStance(standing);
                rejected.clear();
                from = standing;
                to = cut = routeCut = null;
                view = 0;
                since = tick;
                surveyYaw = c.player.getYaw();
            }
            if (to == null) {
                chooseLanding();
                if (to == null) {
                    if (cutSightline()) return true;
                    if (view < 4) {
                        float bearing = surveyYaw + 90 * view;
                        body.turn(bearing, tick - since < 12 ? 23 : 60);
                        if (bearingDistance(bearing, c.player.getYaw()) < 7 && c.player.getPitch() >= 53
                                && tick - since >= 24 && !peekFromSupport(bearing)) {
                            view++;
                            since = tick;
                        }
                    } else if (backtracks < 4 && route.size() > 1) {
                        BlockPos prior = route.get(route.size() - 2);
                        if (adjacent(from, prior) && prior.getY() <= from.getY() && !rejected.contains(prior)) {
                            Vec3d point = supportPoint(prior);
                            body.aim(point);
                            BlockHitResult floor = terrain(point, 5.1);
                            if (visibleTop(floor, prior)) {
                                nominate(prior, naturalGround(state(floor)));
                                backtracks++;
                            } else if (tick - since >= 28) rejected.add(prior);
                        }
                    }
                    return true;
                }
                cut = null;
            }
            proveLanding();
            return true;
        }

        private boolean peekFromSupport(float bearing) {
            if (tick - since >= 34) return false;
            Vec3d lane = forward(bearing);
            Vec3d point = Vec3d.ofBottomCenter(from).add(lane.x * 0.38, -0.035, lane.z * 0.38);
            Vec3d feet = c.player.getPos();
            double advance = (point.x - feet.x) * lane.x + (point.z - feet.z) * lane.z;
            if (advance <= 0.13 || !visibleTop(terrain(point, c.player.getEyePos().distanceTo(point) + 0.05), from)
                    || body.hazardAhead(bearing, 1.1)) return false;
            body.sneak();
            walk(false);
            status = "crouching on the witnessed canopy edge to look down";
            return true;
        }

        private void recordStance(BlockPos standing) {
            visited[visitedCursor++ % visited.length] = standing;
            if (route.size() > 1 && standing.equals(route.get(route.size() - 2))) {
                route.removeLast();
            } else if (route.isEmpty() || !standing.equals(route.getLast())) {
                if (route.size() == visited.length || !route.isEmpty() && !adjacent(route.getLast(), standing))
                    route.clear();
                route.add(standing);
            }
        }

        private Vec3d supportPoint(BlockPos foot) {
            return new Vec3d(foot.getX() + 0.50 + 0.32 * (foot.getX() - from.getX()), foot.getY() - 0.045,
                foot.getZ() + 0.50 + 0.32 * (foot.getZ() - from.getZ()));
        }

        private boolean visibleTop(BlockHitResult hit, BlockPos foot) {
            return hit != null && hit.getSide() == Direction.UP && hit.getBlockPos().equals(foot.down())
                && Math.abs(hit.getPos().y - foot.getY()) <= 0.055 && safeSupport(hit);
        }

        private void nominate(BlockPos foot, boolean ground) {
            to = foot;
            natural = ground;
            proof = 0;
            since = tick;
        }

        private void chooseLanding() {
            double best = Double.POSITIVE_INFINITY;
            for (Direction direction : Direction.Type.HORIZONTAL) {
                for (int drop = 0; drop <= 3; drop++) {
                    BlockPos foot = new BlockPos(from.getX() + direction.getOffsetX(), from.getY() - drop,
                        from.getZ() + direction.getOffsetZ());
                    if (visited(foot) || rejected.contains(foot)) continue;
                    BlockHitResult floor = terrain(supportPoint(foot), 5.1);
                    if (!visibleTop(floor, foot)) continue;
                    BlockState support = state(floor);
                    boolean ground = naturalGround(support);
                    if (!ground && !support.isIn(BlockTags.LEAVES)) continue;
                    double score = (ground ? 0 : 12) - 3 * drop
                        + 0.025 * bearingDistance(c.player.getYaw(), direction.getPositiveHorizontalDegrees());
                    if (score >= best) continue;
                    best = score;
                    nominate(foot, ground);
                }
            }
        }

        private boolean visited(BlockPos foot) {
            for (BlockPos prior : visited) if (foot.equals(prior)) return true;
            return false;
        }

        private boolean naturalGround(BlockState state) {
            return state.isIn(BlockTags.DIRT) || state.isIn(BlockTags.BASE_STONE_OVERWORLD)
                || state.isIn(BlockTags.SAND) || state.isOf(Blocks.GRAVEL) || state.isOf(Blocks.MOSS_BLOCK)
                || state.isOf(Blocks.SNOW_BLOCK) || state.isOf(Blocks.CLAY);
        }

        private void proveLanding() {
            Vec3d base = Vec3d.ofBottomCenter(to);
            Vec3d forward = base.subtract(Vec3d.ofBottomCenter(from));
            double height = switch (proof) {
                case 0 -> 0.30;
                case 1, 2 -> 1.40;
                default -> Math.max(1.69, 1.42 + from.getY() - to.getY());
            };
            double flank = proof == 1 ? 0.24 : proof == 2 ? -0.24 : 0;
            Vec3d point = base.add(0.14 * forward.x + flank * forward.z, height,
                0.14 * forward.z - flank * forward.x);
            status = "verifying clearance to the visible surface landing";
            if (tick - since >= 72 || body.hazardAhead(yaw(forward), 1.55)) {
                reject();
                return;
            }
            body.aim(point);
            if (body.aligned(point) && body.clearTerrain(point)) {
                if (++proof == 4) since = tick;
                return;
            }
            BlockHitResult obstruction = perceive(point, c.player.getEyePos().distanceTo(point) + 0.04);
            if (obstruction == null) return;
            BlockPos leaf = obstruction.getBlockPos();
            BlockState state = state(obstruction);
            if (!sameStem(leaf, to) || leaf.getY() < to.getY() || leaf.getY() > from.getY() + 1
                    || !eligibleLeaf(leaf, state)) {
                reject();
                return;
            }
            status = "clearing a witnessed leaf from the route to ground";
            body.aimContact(obstruction, AgentBody.Contact.MINE);
            if (hands.stableCraftFooting() && tools.readyFor(state) && body.mine(obstruction)) routeCut = leaf;
        }

        private boolean cutSightline() {
            // If no floor is visible, open at most one eye-level leaf per direction.
            // Do not cut the near floor for a speculative landing below it.
            if (cuts >= 6) return false;
            if (cut == null) {
                for (Direction direction : Direction.Type.HORIZONTAL) {
                    if (bearingDistance(c.player.getYaw(), direction.getPositiveHorizontalDegrees()) > 32) continue;
                    BlockPos leaf = from.offset(direction).up();
                    if (triedLeaves.contains(leaf)) continue;
                    Vec3d point = Vec3d.ofCenter(leaf);
                    BlockHitResult hit = perceive(point, 2.5);
                    if (hit == null || !hit.getBlockPos().equals(leaf) || !eligibleLeaf(leaf, state(hit))) continue;
                    if (triedLeaves.size() == 6) return false;
                    triedLeaves.add(leaf);
                    cut = leaf;
                    cutAim = point;
                    cutSince = tick;
                    break;
                }
            }
            if (cut == null) return false;
            if (tick - cutSince >= 36) {
                cut = null;
                return false;
            }
            body.aim(cutAim);
            status = "clearing a witnessed eye-level leaf to reveal the ground route";
            BlockHitResult seen = perceive(cutAim, c.player.getEyePos().distanceTo(cutAim) + 0.04);
            if (seen != null && seen.getBlockPos().equals(cut)) {
                BlockState observed = state(seen);
                if (eligibleLeaf(cut, observed)) {
                    body.aimContact(seen, AgentBody.Contact.MINE);
                    if (hands.stableCraftFooting() && tools.readyFor(observed)) body.mine(seen);
                }
            }
            return true;
        }

        private boolean eligibleLeaf(BlockPos leaf, BlockState state) {
            return cuts < 6 && !protectedCanopyLeaf(leaf) && AgentSupplyEgress.naturalDryLeaf(state);
        }

        private boolean traverse() {
            Vec3d landing = Vec3d.ofBottomCenter(to);
            Vec3d delta = landing.subtract(c.player.getPos());
            if (arrived(to)) {
                if (!visited(to)) stallGuard.reachedNewSurfaceFooting(to);
                if (natural) markMineEntrance(to);
                to = null;
                return true;
            }
            status = "walking to a witnessed surface landing";
            if (tick - since >= 38 || c.player.getY() < to.getY() - 0.12 || c.player.getY() > from.getY() + 0.10
                    || delta.horizontalLengthSquared() > 2.56) {
                reject();
                return true;
            }
            if (delta.horizontalLengthSquared() <= 0.045) return true;
            float bearing = yaw(delta);
            body.turn(bearing, 45);
            if (!c.player.horizontalCollision && bearingDistance(bearing, c.player.getYaw()) <= 9
                    && !body.hazardAhead(bearing, 1.55)) body.walkDownTo(landing);
            return true;
        }

        private void markMineEntrance(BlockPos foot) {
            entrance = foot;
            from = null;
            // Old unverified surface waypoints are not a connected mine entrance.
            memory.detach(c.world, trail, foot);
            trimCaveTrail(0);
            status = "reached natural footing for the mine entrance";
        }

        private void reject() {
            rejected.add(to);
            to = routeCut = null;
            since = tick;
        }

        private void broken(BlockPos position, BlockState state) {
            if (raisedCanopy != null && position.equals(raisedCanopy.foot().down())) raisedCanopy = null;
            if (!state.isIn(BlockTags.LEAVES)) return;
            if (position.equals(cut)) {
                cuts++;
                cut = null;
            } else if (position.equals(routeCut)) {
                cuts++;
                routeCut = null;
            }
        }
    }

    private int stationWaypoint(BlockPos position) {
        Vec3d station = Vec3d.ofCenter(position);
        double nearest = 3.55 * 3.55;
        int bench = -1;
        // The station's proximity to a breadcrumb says nothing about the
        // player's connection to that breadcrumb.
        int standing = groundedTrailIndex();
        for (int i = standing - 1; i >= 0; i--) {
            BlockPos waypoint = trail.get(i);
            if (!returnEdge(trail.get(i + 1), waypoint, walkedWaterReturn)) break;
            double dx = waypoint.getX() + 0.5 - station.x;
            double dy = waypoint.getY() + 1.62 - station.y;
            double dz = waypoint.getZ() + 0.5 - station.z;
            double distance = dx * dx + dy * dy + dz * dz;
            if (distance < nearest) {
                nearest = distance;
                bench = i;
            }
        }
        return bench;
    }

    private void excavate(int depth, Vec3d toward) {
        excavate(depth, toward, false);
    }

    private void excavate(int depth, Vec3d toward, boolean preferExcavation) {
        if (nextFoot == null && c.player.isOnGround() && fieldBench.pack()) return;
        BlockPos standing = c.player.getBlockPos();
        if (resumeIndex >= 0) {
            resumeTunnel();
            return;
        }
        if (nextFoot != null && arrived(nextFoot)) {
            BlockPos previous = trail.getLast();
            appendGrounded(nextFoot, nextStepProved);
            if (nextFoot.getY() < previous.getY()) stairLength++;
            else if (nextFoot.getY() == previous.getY() && stairLength >= 9) stairLength = 0;
            nextFoot = null;
            failedDirections = 0;
            legLength++;
            return;
        }
        Direction guardedBearing = nextFoot == null ? nightSite.mineBearing(standing) : null;
        if (nextFoot == null && (guardedBearing == null && surfaceApproach.step(standing) || !c.player.isOnGround())) return;
        boolean returnableDescent = nextFoot == null && toward == null && !lavaProspecting
            && (standing.getY() > depth || returnableMine.unjoined())
            && (sought == Resource.DIAMOND || sought == Resource.IRON) && (has(DEEP_PICK, 1) || has(STONE_PICK, 1));
        if (returnableDescent && returnableMine.unjoined()) {
            workReturnableMine(standing, depth, preferExcavation);
            return;
        }
        if (nextFoot == null && !trail.isEmpty() && !standing.equals(trail.getLast())) {
            int revisit = trail.lastIndexOf(standing);
            if (revisit >= 0) {
                trail.subList(revisit + 1, trail.size()).clear();
                litIndex = Math.min(litIndex, trail.size());
            } else if (adjacent(trail.getLast(), standing)) appendGrounded(standing, false);
            else trail.clear();
        }
        if (trail.isEmpty()) {
            dugSteps.clear();
            appendGrounded(standing, false);
            digDirection = guardedBearing == null ? c.player.getHorizontalFacing() : guardedBearing;
            branchTurns = failedDirections = legLength = stairLength = deadEnds = litIndex = 0;
            torchAttempt = torchFace = torchUsed = 0;
            closedDig.clear();
        }
        BlockPos current = trail.getLast();
        if (guardedBearing != null) digDirection = guardedBearing;
        if (returnableDescent) {
            workReturnableMine(current, depth, preferExcavation);
            return;
        }
        if (current.getY() > depth) status = "descending a mined staircase";
        else status = "branch mining at y=" + current.getY();
        if (ordinaryCaveDrops && !forcedLight && !caves.active() && lightDarkStair(current)) return;
        if (nextFoot == null) {
            if (!current.equals(darkStairFoot) && shouldLight(false)) return;
            if (!planStep(current, depth, toward)) return;
            clearIndex = nextFoot.getY() < current.getY() ? 2 : 1;
            nextStepProved = false;
            digAge = tick;
            digGoal = toward;
        }
        if (forcedLight) {
            if (lightStair(current)) return;
            forcedLight = false;
            if (torchPlacedTick != tick) blockedTunnel();
            else digAge = tick;
            return;
        }
        if (surveyCave(nextFoot)) return;
        if (nextFoot.equals(cavePeek) && tick <= caveLookUntil) {
            status = "looking through the opened cave lip";
            body.turn(yaw(new Vec3d(digDirection.getOffsetX(), 0, digDirection.getOffsetZ())), 12);
            return;
        }
        if (tick - digAge > 205 || horizontalDistance(Vec3d.ofBottomCenter(current), c.player.getPos()) > 2.1) {
            blockedTunnel();
            return;
        }
        if (clearIndex >= 0) {
            BlockPos cell = nextFoot.up(clearIndex);
            boolean low = clearIndex == 0 && nextFoot.getY() < current.getY();
            Vec3d point = low ? Vec3d.ofCenter(cell, 0.82).add(
                digDirection.getOffsetX() * 0.22, 0, digDirection.getOffsetZ() * 0.22) : Vec3d.ofCenter(cell);
            Dig result = clear(cell, point, low ? current.down() : null);
            if (result == Dig.CLEAR) clearIndex--;
            else if (result == Dig.LIP) creepToLip();
            else if (result == Dig.DARK) {
                if (!lightDigOnce(current)) blockedTunnel();
            } else if (result == Dig.BLOCKED) blockedTunnel();
            return;
        }
        if (standing.getX() == nextFoot.getX() && standing.getZ() == nextFoot.getZ()
            && nextFoot.getY() < current.getY() && !c.player.isOnGround()) {
            // Momentum has carried us over the lip. Do not aim into our own column while falling.
            return;
        }
        Vec3d floor = Vec3d.ofBottomCenter(nextFoot);
        if (body.driveObservedStep(floor)) {
            rememberMotion();
            return;
        }
        Vec3d direction = new Vec3d(digDirection.getOffsetX(), 0, digDirection.getOffsetZ());
        // The farther half of the same step stays visible from behind the near lip.
        Vec3d support = floor.add(direction.multiply(0.31)).add(0, -0.025, 0);
        body.aim(support);
        if (!body.aligned(support)) return;
        BlockHitResult hit = terrain(support, REACH);
        if (hit != null && hit.getBlockPos().equals(nextFoot.down()) && hit.getSide() == Direction.UP
            && safeSupport(hit)) {
            if (body.hazardAhead(yaw(direction), 1.65)) {
                blockedTunnel();
                return;
            }
            if (ordinaryCaveDrops && nextFoot.getY() < current.getY()
                    && !AgentSurfaceTread.retainedLaneClear(c, current, nextFoot, digDirection)) {
                if (!startMineCaveShelf(current, digDirection, current.getY() - nextFoot.getY())) blockedTunnel();
                return;
            }
            nextStepProved = true;
            if (body.beginObservedStep(hit, floor)) rememberMotion();
            else walkDown(false);
        } else if (followObservedShelf(current, direction)) {
            if (!caves.shallowEntry()) status = "following a witnessed shelf in the mine";
        } else if (hit != null && hit.getBlockPos().equals(current.down()) && hit.getSide() == Direction.UP) {
            // Crouch toward the lip on the proven current support to reveal the next one.
            creepToLip();
        } else if (!lightDigOnce(current)) {
            if (!nextFoot.equals(cavePeek)) {
                cavePeek = nextFoot;
                caveLookUntil = tick + 16;
            } else {
                if (current.getY() > depth) {
                    // This open column had no reachable top at the planned or nearby heights.
                    if (caveRetreat.begin(new AgentCaves.Opening(current, digDirection))) return;
                    // Let the next attempt face a different column instead of the same void one block up.
                    failedDirections |= 1;
                }
                blockedTunnel();
            }
        }
    }

    private void workReturnableMine(BlockPos current, int depth) {
        workReturnableMine(current, depth, false);
    }

    private void workReturnableMine(BlockPos current, int depth, boolean preferExcavation) {
        if (ordinaryCaveDrops) mineResite.begin(sought, current);
        Direction preferred = digDirection == null ? c.player.getHorizontalFacing() : digDirection;
        AgentReturnableMine.Outcome outcome = returnableMine.step(this, current, depth, preferred, preferExcavation);
        if (!returnableMine.surveyingCave()) status = returnableMine.status();
        if (outcome == AgentReturnableMine.Outcome.SUPPLIES) {
            if (hands.count(TORCH) <= 2 && pickUses(DEEP_PICK) + pickUses(STONE_PICK) >= 7
                && craftTorches(AgentMineLight.tripTorches(AgentMineLight.routeSteps(current.getY(), depth)))) return;
            seekExpeditionSupplies("returnable mine supplies");
        } else if (outcome == AgentReturnableMine.Outcome.EXHAUSTED) {
            if (ordinaryCaveDrops) mineResite.exhausted(sought, current);
            localBlock = status;
        }
    }

    boolean returnableCaveOpening(BlockPos current, BlockPos planned, Direction bearing) {
        return caves.witnessedMineOpening(current, bearing) && considerMineCave(current, planned, bearing);
    }

    private boolean considerMineCave(BlockPos current, BlockPos planned, Direction bearing) {
        return surveyCave(planned, bearing) || surveyDryForMine(current, bearing);
    }

    boolean startMineCaveSurvey(BlockPos current, Direction bearing) {
        return considerMineCave(current, current.offset(bearing), bearing);
    }

    boolean startMineCaveShelf(BlockPos source, Direction bearing, int height) {
        if (!ordinaryCaveDrops || height == 1 && !permitsOneWayCaveDrop(height)) return false;
        if (!caves.beginShallowEntry(source, bearing, height, tick)) return false;
        selectCaveGoal();
        nextFoot = cavePeek = null;
        status = caves.status();
        return true;
    }

    boolean continueMineCaveSurvey(Direction bearing) {
        if (caves.active()) return surveyCave(null);
        return surveyDryForMine(c.player.getBlockPos(), bearing);
    }

    boolean endMineCaveSurvey() { return caves.cancelStationaryDrySurvey(tick); }

    boolean mineCaveHandedOff() { return caveRetreat.shaft != null || target != null; }

    BlockPos returnableRetainedStep(BlockPos current) {
        int index = trail.lastIndexOf(current);
        if (index < 1 || index != activeTrail() - 1 || returnIndex >= 0 || resumeIndex >= 0) return null;
        BlockPos previous = trail.get(index - 1);
        int horizontal = Math.abs(previous.getX() - current.getX()) + Math.abs(previous.getZ() - current.getZ());
        // Do not infer a route across a fall, fluid link, or recovery's vertical pillar.
        return horizontal == 1 && dugSteps.get(index) ? previous : null;
    }

    int returnableTorches() { return hands.count(TORCH); }

    int returnableToolUses() { return pickUses(RETURNABLE_PICKS); }

    int returnableFootholdStock() { return hands.count(COBBLE_FOOTHOLD); }

    boolean returnableFootholdProtected(BlockPos cell) { return !workshopPlacementSite(cell); }

    boolean equipReturnableFoothold() {
        boolean equipped = hands.equipForUse(COBBLE_FOOTHOLD);
        if (!equipped && hands.busy()) returnableMine.awaitEquipment(hands.jobGeneration());
        return equipped;
    }

    void rememberReturnableMotion() { rememberMotion(); }

    void recordReturnableDrop(BlockPos from, BlockPos to, Direction bearing) {
        recordReturnableRelocation(from, to, bearing);
        mineResite.depth(to);
        returnableDrop = new ReturnableDrop(returnableDrop == null ? 1 : returnableDrop.sequence() + 1,
            from, to, body.actionTick());
        stairLength++;
    }

    void recordReturnableRelocation(BlockPos from, BlockPos to, Direction bearing) {
        if (!trail.isEmpty() && from.equals(trail.getLast())) {
            int revisit = trail.lastIndexOf(to);
            if (revisit < 0) appendGrounded(to, true);
            else {
                trail.subList(revisit + 1, trail.size()).clear();
                if (dugSteps.length() > revisit + 1) dugSteps.clear(revisit + 1, dugSteps.length());
                litIndex = Math.min(litIndex, trail.size());
            }
        }
        caves.walkedDry(from, to);
        caves.witnessedDry(to, from);
        body.recordWalkedLeg(from, to);
        stallGuard.navigationArrival(from, to);
        digDirection = bearing;
    }

    boolean handoffReturnableResource(BlockHitResult hit) {
        BlockState observed = state(hit);
        Resource exposed = Resource.DIAMOND.block.test(observed) ? Resource.DIAMOND
            : Resource.IRON.block.test(observed) ? Resource.IRON : Resource.COAL.block.test(observed) ? Resource.COAL : null;
        if (exposed == null || !returnableOreReachable(hit) || !tools.canHarvest(observed)) return false;
        returnableOre = exposed;
        setTarget(hit, exposed);
        mineTarget(exposed);
        return true;
    }

    boolean handoffVisibleReturnableOre() {
        BlockHitResult hit = body.find(RETURNABLE_ORE, REACH - 0.40, returnableOreFace).orElse(null);
        return hit != null && handoffReturnableResource(hit);
    }

    private boolean returnableOreReachable(BlockHitResult hit) {
        BlockPos position = hit.getBlockPos();
        return !underMineFootprint(position) && reachableResourceFace(position) && !protectRecoveryBlock(position)
            && !AgentReturnableMine.protectedCutAttachment(c.world, position)
            && c.player.getEyePos().squaredDistanceTo(hit.getPos()) <= (REACH - 0.40) * (REACH - 0.40);
    }

    boolean returnableCutAllowed(BlockHitResult hit) {
        return returnableFace(hit) == AgentReturnableMine.Face.MINEABLE;
    }

    AgentReturnableMine.Face returnableFace(BlockHitResult hit) {
        BlockPos cell = hit.getBlockPos();
        var face = returnableFace(cell, state(hit));
        return face == AgentReturnableMine.Face.MINEABLE && AgentReturnableMine.protectedCutAttachment(c.world, cell)
            ? AgentReturnableMine.Face.PROTECTED : face;
    }

    /** Admission shared by ordinary stair selection and mining, not by the exact-effect lanes. */
    AgentReturnableMine.Face returnableLaneFace(BlockPos foot, Direction bearing, BlockHitResult hit, boolean drift) {
        BlockPos cell = hit.getBlockPos();
        BlockState shown = state(hit);
        if (!shown.isOf(Blocks.GRAVEL)) {
            var fact = returnableFace(hit);
            return drift && fact == AgentReturnableMine.Face.MINEABLE
                    && !AgentReturnableMine.stationaryDriftCut(c.world, foot, cell, bearing, hit, c.player.getBoundingBox())
                ? AgentReturnableMine.Face.MATERIAL : fact;
        }
        if (underMineFootprint(cell)) return AgentReturnableMine.Face.FOOTPRINT;
        if (protectedGravelColumn(cell)) return AgentReturnableMine.Face.PROTECTED;
        var player = c.player;
        if (player.isTouchingWater() || player.isInLava()) return AgentReturnableMine.Face.FLUID;
        if (body.lavaEmergency() || body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65)
                || body.lavaBreachesDig(cell)) return AgentReturnableMine.Face.LAVA;
        if (player.hurtTime != 0 || player.isOnFire() || player.hasVehicle() || player.getAbilities().flying
                || player.getVelocity().horizontalLengthSquared() > 0.0025) return AgentReturnableMine.Face.FOOTPRINT;
        var contact = AgentReturnableMine.lateralGravelFace(c.world, foot, bearing, hit, player.getBoundingBox(),
            body.dryCaveContact(foot), player.getEyePos(), player.getBlockInteractionRange(), drift);
        if (contact != AgentReturnableMine.Face.MINEABLE) return contact;
        Vec3d above = Vec3d.ofCenter(cell.up(), 0.20);
        var cover = AgentReturnableMine.gravelCover(c.world, cell,
            perceive(above, player.getEyePos().distanceTo(above) + 0.04));
        if (cover != null) return cover;
        if (!returnableMine.gravelCutAvailable()) return AgentReturnableMine.Face.GRAVEL_LIMIT;
        return tools.canHarvest(shown) ? AgentReturnableMine.Face.MINEABLE : AgentReturnableMine.Face.TOOL;
    }

    private boolean protectedGravelColumn(BlockPos cell) {
        // Gravity must not have a path into a retained route, takeoff, or remembered workshop.
        if (sameStem(cell, table.position) || sameStem(cell, furnace.position) || sameStem(cell, furnaceWitness)
                || sameStem(cell, pendingStairLight) || sameStem(cell, nextFoot)) return true;
        for (int i = trail.size() - 1; i >= 0; i--) if (sameStem(cell, trail.get(i))) return true;
        return false;
    }

    private AgentReturnableMine.Face returnableFace(BlockPos position, BlockState observed) {
        if (underMineFootprint(position)) return AgentReturnableMine.Face.FOOTPRINT;
        if (protectRecoveryBlock(position)) return AgentReturnableMine.Face.PROTECTED;
        if (!observed.getFluidState().isEmpty()) return AgentReturnableMine.Face.FLUID;
        if (observed.getBlock() instanceof net.minecraft.block.FallingBlock || dangerous(observed)
                || !(observed.isIn(BlockTags.BASE_STONE_OVERWORLD) || observed.isIn(BlockTags.DIRT) || observed.isOf(Blocks.GRASS_BLOCK)
                || observed.isOf(Blocks.TUFF) || observed.isOf(Blocks.CALCITE) || observed.isOf(Blocks.CLAY)
                || observed.isOf(Blocks.DRIPSTONE_BLOCK))) return AgentReturnableMine.Face.MATERIAL;
        return tools.canHarvest(observed) ? AgentReturnableMine.Face.MINEABLE : AgentReturnableMine.Face.TOOL;
    }

    private boolean underMineFootprint(BlockPos position) {
        Box hull = c.player.getBoundingBox();
        int x = position.getX(), z = position.getZ();
        return position.getY() <= hull.minY + 0.02
            && x + 1.0 > hull.minX && x < hull.maxX && z + 1.0 > hull.minZ && z < hull.maxZ;
    }

    private boolean followObservedShelf(BlockPos current, Vec3d direction) {
        // An older stair can have a level landing or one taller drop. Use its real
        // exposed top and lower body clearance instead of digging the expected shape.
        BlockPos planned = nextFoot;
        for (int drop = 0; drop <= 2; drop++) {
            int height = current.getY() - drop;
            if (height == planned.getY()) continue;
            BlockPos foot = new BlockPos(planned.getX(), height, planned.getZ());
            Vec3d landing = Vec3d.ofBottomCenter(foot);
            Vec3d far = landing.add(direction.x * 0.39, -0.045, direction.z * 0.39);
            BlockHitResult floor = terrain(far, REACH);
            if (floor == null || floor.getSide() != Direction.UP || !floor.getBlockPos().equals(foot.down())
                    || Math.abs(floor.getPos().y - height) > 0.055 || !safeSupport(floor)) continue;
            Vec3d shin = landing.add(direction.x * 0.26, 0.40, direction.z * 0.26);
            if (!body.clearTerrain(shin.add(0.22 * direction.z, 0, -0.22 * direction.x))
                    || !body.clearTerrain(shin.add(-0.22 * direction.z, 0, 0.22 * direction.x))
                    || body.hazardAhead(yaw(direction), 1.65)) continue;
            if (drop != 0 && ordinaryCaveDrops) return startMineCaveShelf(current, digDirection, drop);
            nextFoot = foot;
            nextStepProved = true;
            return true;
        }
        return false;
    }

    private void appendGrounded(BlockPos position, boolean dug) {
        if (trail.size() == AgentMemory.MAX_CELLS) {
            trail.removeFirst();
            for (int i = 0; i < trail.size(); i++) dugSteps.set(i, dugSteps.get(i + 1));
            dugSteps.clear(0);
            litIndex = Math.max(0, litIndex - 1);
        }
        dugSteps.set(trail.size(), dug);
        trail.add(position);
    }

    private boolean lightDarkStair(BlockPos current) {
        boolean sameFoot = current.equals(darkStairFoot);
        var player = c.player;
        boolean atFoot = current.equals(player.getBlockPos());
        if (darkStairSince == 0 && (sameFoot || current.equals(darkAttemptFoot) || torchAttempt != 0
                || !atFoot || !body.hasRecentView() || c.world.getLightLevel(current) > DARK_STAIR_MAX_LIGHT
                || c.options.useKey.isUnbound() || c.options.sneakKey.isUnbound())) return false;
        Direction bearing = digDirection == null ? player.getHorizontalFacing() : digDirection;
        boolean settled = atFoot && hands.stableCraftFooting() && safePickupStance() && c.currentScreen == null
            && current.down().equals(player.supportingBlockPos.orElse(null))
            && !player.isUsingItem() && !c.options.attackKey.isPressed() && !c.interactionManager.isBreakingBlock()
            && motionTick != tick - 1 && (nextFoot == null || !nextStepProved)
            && !body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65);
        if (darkStairSince != 0) {
            boolean issued = darkStairUse != 0;
            boolean placed = issued && observedStairLightUse == darkStairUse;
            boolean expired = issued ? tick - darkStairUse > STAIR_LIGHT_RECEIPT_TICKS
                : tick - darkStairSince >= DARK_STAIR_TICKS;
            if (placed || !sameFoot || !settled || expired || !issued
                    && (c.world.getLightLevel(current) > DARK_STAIR_MAX_LIGHT || !has(TORCH, 1))) {
                finishDarkStair(sameFoot, placed);
                return false;
            }
            if (issued) status = "checking for an actual stair torch";
            else aimDarkStair(current, bearing);
            return true;
        }
        if (!settled) return false;
        BlockHitResult shown = body.selectedFace();
        if (shown != null && shown.getPos().squaredDistanceTo(player.getEyePos()) <= 3.2 * 3.2
                && body.observedFaceLight(shown) >= 11) return false;

        boolean hasTorch = has(TORCH, 1);
        if (!hasTorch && (!has(FUEL, 1) || !has(STICK, 1))) return false;
        darkStairFoot = darkAttemptFoot = current;
        if (!hasTorch) {
            if (!hands.craftBatch(List.of("torch"))) return false;
            body.pauseWork();
            status = "crafting one batch of torches on a dark stair";
        } else aimDarkStair(current, bearing);
        darkStairSince = tick;
        return true;
    }

    private void aimDarkStair(BlockPos current, Direction bearing) {
        status = "lighting the current dark stair before cutting further";
        if (issueStairLight(current, bearing, true)) darkStairUse = tick;
    }

    private void finishDarkStair(boolean sameFoot, boolean placed) {
        if (sameFoot) {
            if (nextFoot != null && digAge <= darkStairSince) {
                int paused = Math.min(tick - darkStairSince, DARK_STAIR_TICKS + STAIR_LIGHT_RECEIPT_TICKS);
                digAge += paused;
                if (nextFoot.equals(cavePeek) && caveLookUntil >= darkStairSince) caveLookUntil += paused;
            }
            if (placed) {
                litIndex = trail.size();
                torchPlacedTick = tick;
            }
        }
        darkStairSince = darkStairUse = 0;
    }

    private boolean lightDigOnce(BlockPos current) {
        if (current.equals(darkAttemptFoot) || !has(TORCH, 1)) return false;
        darkAttemptFoot = current;
        forcedLight = true;
        torchAttempt = tick;
        torchUsed = 0;
        return true;
    }

    private void observeStairLight() {
        if (pendingStairLight == null) return;
        if (tick - pendingStairLightSince > STAIR_LIGHT_RECEIPT_TICKS) {
            pendingStairLight = null;
        } else if (hands.count(TORCH) < pendingStairTorchCount) {
            Vec3d point = Vec3d.ofCenter(pendingStairLight, 0.31);
            BlockHitResult hit = perceive(point, c.player.getEyePos().distanceTo(point) + 0.05);
            if (hit != null && hit.getBlockPos().equals(pendingStairLight) && state(hit).isOf(Blocks.TORCH)) {
                observedStairLightUse = pendingStairLightSince;
                stallGuard.stairLightReceipt(pendingStairLight);
                returnableMine.observeLight(pendingStairLight);
                pendingStairLight = null;
            }
        }
    }

    private boolean lightStair(BlockPos current) {
        return lightStair(current, digDirection, false);
    }

    void startReturnableLight() {
        torchAttempt = tick;
        torchFace = torchUsed = 0;
    }

    Dig lightReturnableStair(BlockPos foot, Direction bearing) {
        if (lightStair(foot, bearing, true)) {
            if (hands.busy()) returnableMine.awaitEquipment(hands.jobGeneration());
            if (torchUsed == tick) returnableMine.issuedLight(foot);
            return Dig.LOOKING;
        }
        return torchPlacedTick == tick ? Dig.CLEAR : Dig.BLOCKED;
    }

    private boolean lightStair(BlockPos current, Direction bearing, boolean returnable) {
        status = "lighting the current stair before cutting further";
        if (torchUsed != 0) {
            if (hands.count(TORCH) < torchBefore) {
                if (returnable && observedStairLightUse != torchUsed) {
                    if (tick - torchUsed <= STAIR_LIGHT_RECEIPT_TICKS) return true; // Wait for the rendered placement, not just the debit.
                    torchAttempt = torchFace = torchUsed = 0;
                    return false;
                }
                torchAttempt = torchFace = torchUsed = 0;
                litIndex = trail.size();
                torchPlacedTick = tick;
                return false;
            }
            if (tick - torchUsed < STAIR_LIGHT_RECEIPT_TICKS) return true;
            torchUsed = 0;
        }
        if (tick - torchAttempt >= 50 || !has(TORCH, 1)) {
            torchAttempt = torchFace = 0;
            return false;
        }
        if (issueStairLight(current, bearing, false)) {
            torchBefore = pendingStairTorchCount;
            torchUsed = tick;
        }
        return true;
    }

    private boolean issueStairLight(BlockPos current, Direction bearing, boolean checkedSupport) {
        if (!c.player.isOnGround() || !hands.equipForUse(TORCH)) return false;
        Vec3d point = Vec3d.ofBottomCenter(current).add(
            0.36 * bearing.getOffsetX(), -0.06, 0.36 * bearing.getOffsetZ());
        body.aim(point);
        body.sneak();
        BlockHitResult hit = perceive(point, 3.5);
        AgentBody.Contact mode = AgentBody.Contact.PRECISE;
        if (hit == null && body.aligned(point)) {
            hit = body.selectedFace();
            mode = AgentBody.Contact.OUTLINE;
        }
        if (hit == null || hit.getSide() != Direction.UP || !hit.getBlockPos().equals(current.down())) return false;
        // In complete darkness, the actual supporting foot and its rendered top prove contact;
        // an outline alone never reveals the identity of a block.
        if (checkedSupport && (mode == AgentBody.Contact.PRECISE && !safeSupport(hit)
                || !torchSiteOutsideStep(hit))) return false;
        body.aimContact(hit, mode);
        if (!c.player.isSneaking() || !body.useContact(hit, mode)) return false;
        pendingStairLight = current;
        pendingStairLightSince = tick;
        pendingStairTorchCount = hands.count(TORCH);
        return true;
    }

    private boolean planStep(BlockPos current, int depth, Vec3d toward) {
        if (failedDirections == 0) {
            if (toward != null) {
                Vec3d delta = toward.subtract(Vec3d.ofBottomCenter(current));
                if (delta.horizontalLengthSquared() > 0.36) digDirection = directional(delta);
            } else if (current.getY() <= depth && legLength >= 24) {
                // Alternating turns make a connected open-ended sweep, not a loop of old tunnels.
                digDirection = (branchTurns++ & 1) == 0
                    ? digDirection.rotateYClockwise() : digDirection.rotateYCounterclockwise();
                legLength = 0;
            }
            digPrimary = digDirection;
        }
        boolean descending = current.getY() > depth;
        boolean landing = descending && stairLength >= 9;
        int choices = descending ? 8 : 4;
        if (!descending && toward == null && failedDirections >= 2 && trail.size() > 4
                && trail.get(trail.size() - 4).getY() >= current.getY()) {
            // A failed forward leg and its first alternative are enough in a mine.
            // Rejoin a real earlier junction before trying another direction; do not
            // sweep all walls from the same unusable footing.
            failedDirections = choices;
        }
        for (; failedDirections < choices; failedDirections++) {
            int side = descending ? failedDirections / 2 : failedDirections;
            digDirection = switch (side) {
                case 0 -> digPrimary;
                case 1 -> digPrimary.rotateYClockwise();
                case 2 -> digPrimary.rotateYCounterclockwise();
                default -> digPrimary.getOpposite();
            };
            BlockPos candidate = current.offset(digDirection);
            if (descending && ((failedDirections & 1) == (landing ? 1 : 0))) candidate = candidate.down();
            if (trail.contains(candidate) || closedDig.contains(candidate) || caveRetreat.retired(candidate)) continue;
            nextFoot = candidate;
            return true;
        }
        deadEnds++;
        if (trail.size() > 3 && deadEnds < 6) {
            // Back up to a traveled bench and open a different connected leg there.
            startReturn(Math.max(0, trail.size() - 5), false);
        } else if (trail.size() > 1) {
            beginReturn();
        } else {
            trail.clear();
            nextDigStart = tick + 95;
            heading = c.player.getYaw() + 105;
            headingUntil = tick + 150;
        }
        return false;
    }

    private void creepToLip() {
        body.sneak();
        walk(false);
        if (stuck >= 10) blockedTunnel();
    }

    private Dig clear(BlockPos position) {
        return clear(position, Vec3d.ofCenter(position), null);
    }

    private Dig clear(BlockPos position, Vec3d point) {
        return clear(position, point, null);
    }

    private Dig clear(BlockPos position, Vec3d point, BlockPos lip) {
        return clear(position, point, lip, false, null, null, false, null);
    }

    Dig clearReturnableLane(BlockPos foot, BlockPos position, Direction bearing, Vec3d point, boolean drift,
                           BlockHitResult capContact) {
        return clear(position, point, null, true, foot, bearing, drift, capContact);
    }

    Dig clearReturnableHeadroom(BlockPos position, Vec3d point) {
        return clear(position, point, null, true, null, null, false, null);
    }

    private Dig clear(BlockPos position, Vec3d point, BlockPos lip, boolean returnable,
                      BlockPos foot, Direction bearing, boolean drift, BlockHitResult capContact) {
        if (returnable && underMineFootprint(position)) return Dig.BLOCKED;
        if (foot != null && !foot.equals(c.player.getBlockPos())) return Dig.BLOCKED;
        double length = 0;
        // The cap probe already admitted this exact face. Let mine contact own the look.
        BlockHitResult hit = capContact;
        if (hit == null) {
            body.aim(point);
            length = c.player.getEyePos().distanceTo(point);
            hit = perceive(point, length + 0.18);
        }
        boolean stair = returnable || nextFoot != null;
        if (hit == null) {
            if (stair && position.equals(witnessedStairCut) && tick - witnessedStairCutTick <= 3
                    && (foot == null || !witnessedGravelCut)) {
                // Missing one render does not make the same vanilla outlined crack go dark.
                if (body.continueMine(position)) return Dig.LOOKING;
                if (body.miningFootingRefused(position)) return Dig.BLOCKED;
            }
            if (returnable) return returnableClearance(point);
            if (!body.aligned(point)) return Dig.LOOKING;
            if (climbTo != null && body.dryRouteClear(point) == AgentBody.DryRouteSample.DARK)
                return Dig.DARK;
            if (body.clearTerrain(point)) return Dig.CLEAR;
            BlockHitResult outline = body.selectedFace();
            if (outline != null && (outline.getBlockPos().equals(position)
                    || c.player.getEyePos().distanceTo(outline.getPos()) < length)) return Dig.DARK;
            // A camera-aligned miss without lit clearance can be an unlit opening.
            // Light it from the current support; a missing render alone never warrants a cut.
            return nextFoot != null && tick - digAge >= 12 && body.hasRecentView() ? Dig.DARK : Dig.LOOKING;
        }
        if (!hit.getBlockPos().equals(position)) {
            if (returnable) return returnableClearance(point);
            if (hit.getBlockPos().equals(lip) && hit.getSide() == Direction.UP && safeSupport(hit)) return Dig.LIP;
            if (c.player.getEyePos().distanceTo(hit.getPos()) >= length - 0.17) return Dig.CLEAR;
            BlockPos obstruction = hit.getBlockPos();
            if ((returnIndex < 0 && exitStart == null) || obstruction.getY() < c.player.getBlockY()
                || (climbTo != null && obstruction.equals(climbTo.down()))
                || obstruction.equals(c.player.getBlockPos().down())) return Dig.BLOCKED;
            // The near ceiling can mask a previously walked stair. Only dig the actually
            // selected intervening face; the destination behind it supplies no block data.
            if (state(hit).getBlock() instanceof net.minecraft.block.FallingBlock) return Dig.BLOCKED;
            position = obstruction;
        }
        BlockState state = state(hit);
        if (returnable) {
            if (foot != null && handoffReturnableResource(hit)) return Dig.RESOURCE;
            // An outline (grass, a torch) is not a wall and should not be dug.
            if (state.getFluidState().isEmpty() && !AgentBody.dryCaveDanger(state)
                    && state.getCollisionShape(c.world, position).isEmpty())
                return returnableClearance(point);
            var fact = foot == null ? returnableFace(hit) : returnableLaneFace(foot, bearing, hit, drift);
            if (fact == AgentReturnableMine.Face.FALLING_COVER) return Dig.FALLING_COVER;
            if (fact == AgentReturnableMine.Face.GRAVEL_LIMIT) return Dig.GRAVEL_LIMIT;
            if (fact != AgentReturnableMine.Face.MINEABLE) return Dig.BLOCKED;
            if (!state.isOf(Blocks.GRAVEL)) {
                Vec3d above = Vec3d.ofCenter(position.up(), 0.20);
                BlockHitResult cover = perceive(above, c.player.getEyePos().distanceTo(above) + 0.04);
                if (cover != null && cover.getBlockPos().equals(position.up())
                        && state(cover).getBlock() instanceof net.minecraft.block.FallingBlock) return Dig.BLOCKED;
            }
        }
        if (state.isReplaceable() && state.getFluidState().isEmpty() && !state.isOf(Blocks.SNOW)) return Dig.CLEAR;
        if (dangerous(state) || !state.getFluidState().isEmpty()
            || state.getHardness(c.world, position) < 0 || state.isOf(Blocks.OBSIDIAN)
            || state.isOf(Blocks.CRYING_OBSIDIAN) || state.isOf(Blocks.CRAFTING_TABLE)
            || state.isOf(Blocks.FURNACE)) return Dig.BLOCKED;
        if (!tools.canHarvest(state)) return Dig.BLOCKED;
        body.aimContact(hit, AgentBody.Contact.MINE);
        if (!readyForMine(state)) {
            if (returnable && hands.busy()) returnableMine.awaitEquipment(hands.jobGeneration());
            return Dig.LOOKING;
        }
        if (body.mine(hit) && stair) {
            witnessedStairCut = position;
            witnessedStairCutTick = tick;
            witnessedGravelCut = state.isOf(Blocks.GRAVEL);
        } else if (body.miningFootingRefused(position)) return Dig.BLOCKED;
        return Dig.LOOKING;
    }

    private Dig returnableClearance(Vec3d point) {
        return switch (body.dryRouteClear(point)) {
            case CLEAR -> Dig.CLEAR;
            case DARK -> body.renderedAim(point, 14) ? Dig.DARK : Dig.LOOKING;
            case FLUID -> Dig.BLOCKED;
            case UNKNOWN, OBSTRUCTION -> Dig.LOOKING;
        };
    }

    private boolean shouldLight(boolean forced) {
        if (!forced && trail.size() - litIndex < 7) return false;
        int remaining = hands.count(TORCH);
        if (torchUsed != 0) {
            if (remaining < torchBefore) {
                torchFace = torchAttempt = torchUsed = 0;
                litIndex = trail.size();
                torchPlacedTick = tick;
                return false;
            }
            if (tick - torchUsed < 7) return true;
            torchUsed = 0;
            torchFace++;
            torchAttempt = tick;
        }
        if (remaining == 0) return false;
        if (!forced) {
            BlockHitResult lit = body.selectedFace();
            if (lit != null && lit.getPos().squaredDistanceTo(c.player.getEyePos()) <= 3.2 * 3.2
                    && body.observedFaceLight(lit) >= 11) {
                // A close sunlit wall or an existing lamp already lights this stretch.
                // Check again after two traveled cells; this is not a placement receipt.
                torchFace = torchAttempt = 0;
                litIndex = trail.size() - 5;
                status = "keeping the torch on an already lit stretch";
                return false;
            }
        }
        if (torchAttempt == 0) torchAttempt = tick;
        if (tick - torchAttempt > 22) {
            torchAttempt = tick;
            torchFace++;
        }
        if (torchFace >= 4) {
            torchFace = torchAttempt = 0;
            // Recheck after reaching another spot, not for several dark staircase steps.
            litIndex = trail.size() - 6;
            return false;
        }
        Direction forward = digDirection == null ? c.player.getHorizontalFacing() : digDirection;
        Direction wall = torchFace == 1 ? forward.rotateYClockwise()
            : torchFace == 2 ? forward.rotateYCounterclockwise() : forward.getOpposite();
        BlockPos feet = c.player.getBlockPos();
        Vec3d point = torchFace == 0 ? Vec3d.ofCenter(feet.offset(wall).down(), 0.80)
            : torchFace == 3 ? Vec3d.ofCenter(feet.down(), 0.83) : Vec3d.ofCenter(feet.offset(wall), 0.58);
        body.aim(point);
        BlockHitResult shown = body.selectedFace();
        BlockHitResult hit = perceive(point, 2.6);
        boolean visibleSupport = hit != null && safeSupport(hit);
        // In darkness the rendered outline still proves a real face; let vanilla decide if it accepts a torch.
        if (hit == null && forced && body.aligned(point)) hit = shown;
        if (hit != null && hit.getSide() != Direction.DOWN && (visibleSupport || forced && shown == hit)
            && torchSiteOutsideStep(hit)) {
            AgentBody.Contact mode = visibleSupport ? AgentBody.Contact.PRECISE : AgentBody.Contact.OUTLINE;
            body.aimContact(hit, mode);
            if (!hands.equipForUse(TORCH)) return true;
            if (!body.useContact(hit, mode)) return true;
            torchBefore = remaining;
            torchUsed = tick;
        } else if (body.aligned(point)) {
            torchFace++;
            torchAttempt = tick;
        }
        return true;
    }

    private boolean torchSiteOutsideStep(BlockHitResult hit) {
        BlockPos placed = hit.getBlockPos().offset(hit.getSide());
        if (placed.equals(nextFoot)) return false;
        return returnIndex < 0 || !placed.equals(trail.get(returnIndex));
    }

    private void blockedTunnel() {
        if (nextFoot != null) closeDig(nextFoot);
        nextFoot = null;
        forcedLight = false;
        failedDirections++;
        legLength = 0;
    }

    /** Retreat on walked cells, then witness a different cut at the older shaft. */
    private final class CaveRetreat {
        private final List<BlockPos> mouths = new ArrayList<>(8);
        private final List<BlockPos> newLegs = new ArrayList<>(8);
        private ClientWorld world;
        private BlockPos shaft;
        private Direction oldLeg, away, probe;
        private int deadline, probeSince, choice;
        private boolean supported;

        private boolean retired(BlockPos planned) {
            if (c.world != world) return false;
            return mouths.contains(planned) || mouths.contains(planned.up());
        }

        private boolean begin(AgentCaves.Opening opening) {
            if (shaft != null || returnIndex >= 0 || resumeIndex >= 0 || exitStart != null
                    || !dryFieldFooting() || !has(DEEP_PICK, 1) && !has(STONE_PICK, 1) || !has(TORCH, 2)
                    || c.player.getBlockY() <= (has(DEEP_PICK, 1) ? DIAMOND_LEVEL : 16)) return false;
            BlockPos standing = c.player.getBlockPos();
            int end = trail.size() - 1;
            int lip = trail.lastIndexOf(opening.origin());
            if (end < 2 || lip < 1 || !trail.getLast().equals(standing) || end - lip > 8) return false;
            int preferred = Math.max(1, lip - 3), back = end;
            while (back > preferred) {
                BlockPos here = trail.get(back), prior = trail.get(back - 1);
                if (!adjacent(here, prior) || sameStem(here, prior)) break;
                back--;
            }
            if (back >= lip) return false;
            BlockPos earlier = trail.get(back);
            // A walked route may dip before a cave ledge rises. It is the
            // re-observed dry rock at the older stance, not its altitude, that matters.
            if (earlier.equals(standing)) return false;
            if (c.world != world) {
                world = c.world;
                mouths.clear();
                newLegs.clear();
            }
            BlockPos mouth = opening.mouth();
            if (mouths.contains(mouth) || !startReturn(back, false)) return false;
            if (mouths.size() == 8) mouths.removeFirst();
            mouths.add(mouth);
            shaft = earlier;
            oldLeg = directional(Vec3d.ofBottomCenter(trail.get(back + 1)).subtract(Vec3d.ofBottomCenter(shaft)));
            away = opening.bearing().getOpposite();
            deadline = tick + 440;
            supported = false;
            probe = null;
            choice = 0;
            probeSince = tick;
            body.pauseWork();
            status = "leaving an unproved cave descent along the walked mine";
            return true;
        }

        private boolean step() {
            if (shaft == null) return false;
            if (world != c.world) return reset();
            if (tick >= deadline || exitStart != null) return refuse("could not retrace the walked mine from the cave");
            if (returnIndex >= 0) {
                if (!shaft.equals(trail.get(returnTo))) return reset();
                retreatTunnel();
                if (returnIndex < 0) probeSince = tick;
                return true;
            }
            if (!arrived(shaft) || !dryFieldFooting()) return refuse("lost the dry mine branch footing");
            if (!supported) {
                // Ground contact alone is not evidence of a suitable mine base.
                Vec3d foot = c.player.getPos().add(0, -0.035, 0);
                body.aim(foot);
                BlockHitResult hit = terrain(foot, 2.4);
                if (hit != null && hit.getBlockPos().equals(shaft.down()) && hit.getSide() == Direction.UP
                        && safeSupport(hit) && state(hit).isIn(BlockTags.BASE_STONE_OVERWORLD)) {
                    supported = true;
                    probeSince = tick;
                } else if (tick - probeSince >= 34) return refuse("no visible rock top on the old shaft footing");
                status = "checking the dry rock footing of the walked shaft";
                return true;
            }
            if (probe == null) {
                while (probe == null && choice < 3) {
                    Direction direction = switch (choice++) {
                        case 0 -> away;
                        case 1 -> away.rotateYClockwise();
                        default -> away.rotateYCounterclockwise();
                    };
                    BlockPos start = shaft.offset(direction);
                    if (direction != oldLeg && !trail.contains(start) && !trail.contains(start.down())
                            && !closedDig.contains(start) && !closedDig.contains(start.down())
                            && !retired(start) && !newLegs.contains(start)) probe = direction;
                }
                if (probe == null) return refuse("no different solid descending branch was visible from the walked shaft");
                probeSince = tick;
            }
            BlockPos face = shaft.offset(probe).up();
            Vec3d point = Vec3d.ofCenter(face);
            body.aim(point);
            status = "checking a different rock face away from the cave";
            BlockHitResult seen = perceive(point, 3.35);
            if (seen != null && seen.getBlockPos().equals(face) && seen.getSide() == probe.getOpposite()
                    && state(seen).isIn(BlockTags.BASE_STONE_OVERWORLD) && tools.canHarvest(state(seen))
                    && !protectRecoveryBlock(face) && !body.hazardAhead(probe.getPositiveHorizontalDegrees(), 1.65)) {
                if (newLegs.size() == 8) newLegs.removeFirst();
                newLegs.add(shaft.offset(probe));
                digDirection = probe;
                failedDirections = stairLength = legLength = deadEnds = 0;
                nextDigStart = tick;
                stallGuard.mineBranchReady(shaft);
                status = "returned to the walked shaft; starting a different supported descending branch";
                reset();
            } else if (tick - probeSince >= 30) probe = null;
            return true;
        }

        private boolean refuse(String reason) {
            clearReturn();
            endExitRecovery();
            body.pauseWork();
            localBlock = reason;
            reset();
            return true;
        }

        private boolean reset() {
            shaft = null;
            return false;
        }
    }

    private void closeDig(BlockPos position) {
        if (closedDig.size() >= 24) closedDig.removeFirst();
        closedDig.add(position);
    }

    private boolean beginReturn() {
        return startReturn(0, false);
    }

    /** Bounded ore-work history. Neither walking nor kit churn counts as ore or depth progress. */
    static final class MineSetback {
        private final BlockPos[] retired = new BlockPos[8];
        private BlockPos site;
        private int nextRetired, refusals, depth, material, lastExhaustedIncident;

        void begin(int y, int stock) {
            Arrays.fill(retired, null);
            nextRetired = 0;
            lastExhaustedIncident = -1;
            depth = y;
            material = stock;
            progressing();
        }

        void depth(int y) {
            if (depth - y < 3) return;
            depth = y;
            progressing();
        }

        boolean material(int stock) {
            // A later collection must exceed the high water mark, not just a prior loss.
            if (stock <= material) return false;
            material = stock;
            progressing();
            return true;
        }

        private void progressing() {
            site = null;
            refusals = 0;
        }

        void exhausted(BlockPos foot) {
            if (site == null || different(site, foot)) {
                retire();
                site = foot.toImmutable();
            }
            if (refusals < 2) refusals++;
        }

        boolean ready(boolean recoveryExhausted) {
            return refusals >= 2 || refusals > 0 && recoveryExhausted;
        }

        void recoveryEnded(BlockPos foot, int incidentTick) {
            // Recovery may have interrupted the miner before its own EXHAUSTED result.
            // A single terminal incident is evidence once, not a new reason on every idle tick.
            if (incidentTick == lastExhaustedIncident) return;
            lastExhaustedIncident = incidentTick;
            if (site == null && !retired(foot)) exhausted(foot);
        }

        boolean retired(BlockPos foot) {
            for (BlockPos old : retired)
                if (old != null && !different(old, foot)) return true;
            return false;
        }

        void retire() {
            if (site != null && !retired(site)) retired[nextRetired++ % retired.length] = site;
        }

        boolean resited(BlockPos foot) {
            if (site == null || !different(site, foot) || retired(foot)) return false;
            progressing();
            return true;
        }

        private static boolean different(BlockPos a, BlockPos b) {
            int dx = a.getX() - b.getX(), dz = a.getZ() - b.getZ();
            return Math.abs(a.getY() - b.getY()) >= 5 || (long) dx * dx + (long) dz * dz >= 36;
        }
    }

    /** Select only a prefix joined at an exact contact. The return motor must still re-prove every tread. */
    static int mineRetreatTarget(List<BlockPos> trail, int last, BlockPos foot,
                                 BiPredicate<BlockPos, BlockPos> eligible) {
        int join = last;
        while (join >= 0 && !foot.equals(trail.get(join))) join--;
        if (join < 0) return -1;
        int target = join;
        while (target > Math.max(0, join - 16)) {
            BlockPos from = trail.get(target), to = trail.get(target - 1);
            if (!AgentSurfaceTread.ordinaryRecallGeometry(from, to) || !eligible.test(from, to)) break;
            target--;
        }
        // A single neighboring foothold is local recovery, not a retreat plan.
        return join - target >= 3 ? target : -1;
    }

    static int mineRetreatRejoin(List<BlockPos> trail, int limit, int failedSource, BlockPos foot,
                                BiPredicate<BlockPos, BlockPos> eligible) {
        for (int join = failedSource - 1; join > limit; --join) {
            if (!foot.equals(trail.get(join))) continue;
            BlockPos next = trail.get(join - 1);
            if (AgentSurfaceTread.ordinaryRecallGeometry(foot, next) && eligible.test(foot, next)) return join;
        }
        return -1;
    }

    private final class MineResite {
        private static final int RETURN_TICKS = 860, WALK_TICKS = 240, ASCENT_TICKS = 1200;
        private record RefusedEdge(BlockPos from, BlockPos to) {}
        private final MineSetback setback = new MineSetback();
        private Resource ore;
        private ClientWorld world;
        private BlockPos attemptedAt, lastJoined, stopFoot;
        private AgentSurfaceTread tread;
        private int until;
        private Direction outward;
        private List<RefusedEdge> refusedEdges;
        private String returnFailure, walkFailure, ascentStatus;
        private final BiPredicate<BlockPos, BlockPos> eligibleReturn = this::eligibleReturn;
        private boolean returning, ascending;

        boolean active() { return until != 0; }
        boolean leased() { return active() && tick < until; }
        boolean retreating() { return active() && returning; }
        boolean ascending() { return active() && ascending; }
        boolean oneWayInFlight() { return retreating() && tread != null && tread.ordinaryDescent() && tread.inFlight(); }
        boolean controlsShortFall() { return oneWayInFlight() && tread.controlsShortFall(c, body, tick); }

        void reset() {
            release();
            attemptedAt = stopFoot = null;
            ore = null;
            world = c.world;
        }

        void observe() {
            if (world != c.world) reset();
            if (!ordinaryCaveDrops && active()) release();
            if (ore != null && setback.site != null && setback.material(stock(ore))) attemptedAt = null;
        }

        boolean noResumeAt(BlockPos standing) { return standing.equals(stopFoot); }

        void changed(BlockPos block) {
            if (!active() && attemptedAt != null && attemptedAt.getSquaredDistance(block) <= 9) attemptedAt = null;
        }

        void begin(Resource resource, BlockPos foot) {
            if (resource != ore && (resource == Resource.IRON || resource == Resource.DIAMOND)) {
                ore = resource;
                attemptedAt = null;
                setback.begin(foot.getY(), stock(resource));
            }
        }

        private int stock(Resource resource) {
            return resource == Resource.IRON ? hands.count(RAW_IRON) + hands.count(INGOT) : hands.count(DIAMOND);
        }

        void depth(BlockPos foot) {
            if (ore != null && !active()) setback.depth(foot.getY());
        }

        void exhausted(Resource resource, BlockPos foot) {
            if (ore != null && ore == resource && arrived(foot) && dryFieldFooting()) {
                setback.material(stock(ore));
                setback.exhausted(foot);
            }
        }

        boolean holds(Resource resource, BlockPos foot) {
            return resource == ore && (setback.site != null && setback.retired(foot)
                || attemptedAt != null && !MineSetback.different(attemptedAt, foot));
        }

        private boolean safe() {
            return !c.player.isTouchingWater() && !c.player.isInLava() && !c.player.isOnFire()
                && !c.player.hasVehicle() && c.player.hurtTime == 0 && !body.lavaEmergency();
        }

        boolean step() {
            BlockPos standing = c.player.getBlockPos();
            var rememberedBatch = pendingFurnaceMemory.current();
            boolean firstPickIngots = ore == Resource.IRON && !has(DEEP_PICK, 1) && has(INGOT, 3)
                && (!active() || hands.stableCraftFooting() && (tread == null || !tread.inFlight())
                    && (!ascending || supplyEgress.canYieldToWorkshop()));
            if (ore == null || sought != ore || firing != Firing.NONE || furnaceLoaded || localFurnace != null
                    || firstPickIngots
                    || rememberedBatch != null && rememberedBatch.mayInvestigateCollection() || portal != null && portal.castEligible()) {
                if (active()) release();
                return false;
            }
            if (!active()) {
                boolean stalled = stallGuard.exhaustedDryRecovery();
                if (!stalled && !setback.ready(false) || returnIndex >= 0 || exitStart != null
                        || supplyEgress.active() || returnableMine.active() || nextFoot != null || caveRetreat.shaft != null
                        || caves.active() || caves.routingDry() || stallWork != null || !safe()
                        || !exactContact(standing) || !body.hasRecentView()
                        || c.player.getVelocity().horizontalLengthSquared() > 0.0025
                        || attemptedAt != null && !MineSetback.different(attemptedAt, standing)) return false;
                if (stalled) setback.recoveryEnded(standing, stallGuard.report().incidentTick());
                if (!setback.ready(stalled)) return false;
                if (ore == Resource.IRON && !has(DEEP_PICK, 1) && fundedFirstIron(3 - hands.count(INGOT)) != null)
                    return false;
                int waypoint = mineRetreatTarget(trail, activeTrail() - 1, standing, eligibleReturn);
                setback.retire();
                // Invalidate advice for the failed opportunity. Its dedup bit stays spent.
                prospected |= 1 << ore.ordinal();
                if (prospectingOre == ore) {
                    prospecting = null;
                    prospectingOre = null;
                }
                outward = c.player.getHorizontalFacing();
                if (setback.resited(standing)) return settled(standing);
                attemptedAt = standing.toImmutable();
                returnFailure = walkFailure = null;
                if (waypoint >= 0) {
                    startReturnAt(groundedTrailIndex(), waypoint, false);
                    returning = true;
                    lastJoined = attemptedAt;
                    until = tick + RETURN_TICKS;
                } else {
                    walkFrom(standing);
                }
            }
            if (setback.site == null) {
                stopAt(standing); // An ore receipt superseded the relocation, not the other way round.
                return false;
            }
            if (!safe()) return refuse(standing, departureStatus("unsafe conditions interrupted the mine departure"));
            if (ascending) {
                status = ascentStatus;
                if (supplyEgress.active()) supplyEgress.step();
                if (ascending) {
                    ascentStatus = status;
                    status = departureStatus(ascentStatus);
                    if (!supplyEgress.active()) return refuse(standing, status);
                }
                return true;
            }
            if (returning && (tick >= until || returnIndex < 0)) {
                returnRefused(returnFrom, returnIndex < 0 ? null : trail.get(returnIndex),
                    returnIndex < 0 ? "the exact trail join was lost" : "the bounded return window expired");
                return true;
            }
            if (returning) {
                retreatTunnel();
                return true;
            }
            if (tick >= until) return tryAscent(standing, "no different safe mine start in the surface walking window");
            Result result = navigate(Job.RETURN, null, 0);
            status = departureStatus(status);
            var arrival = ordinaryArrival;
            if (arrival != null && setback.resited(arrival.to())) {
                outward = AgentDryLanding.bearing(arrival.from(), arrival.to());
                return settled(arrival.to());
            }
            if (result == Result.BLOCKED) return tryAscent(standing, navigator.status());
            return true;
        }

        private boolean exactContact(BlockPos standing) {
            return dryFieldFooting() && body.dryCaveContact(standing) != null
                && standing.down().equals(c.player.supportingBlockPos.orElse(null));
        }

        private boolean eligibleReturn(BlockPos from, BlockPos to) {
            if (stallGuard.refusedCrossing(from, to)) return false;
            if (refusedEdges != null) for (var edge : refusedEdges)
                if (edge.from.equals(from) && edge.to.equals(to)) return false;
            return true;
        }

        private String departureStatus(String detail) {
            if (walkFailure != null) detail = walkFailure + "; " + detail;
            return returnFailure == null ? detail : returnFailure + "; " + detail;
        }

        private boolean tryAscent(BlockPos standing, String reason) {
            if (exactContact(standing) && body.hasRecentView() && !supplyEgress.outdoors() && has(TORCH, 2)
                    && pickUses(RETURNABLE_PICKS) >= 6 && !c.options.forwardKey.isUnbound()
                    && !c.options.jumpKey.isUnbound() && !c.options.attackKey.isUnbound()) {
                if (supplyEgress.beginMineDeparture(standing, outward, tick + ASCENT_TICKS)) {
                    keepStandingPrefix(standing);
                    ascending = true;
                    until = tick + ASCENT_TICKS;
                    walkFailure = reason;
                    ascentStatus = "checking for a different mine start along a supported ascent";
                    status = departureStatus(ascentStatus);
                    return true;
                }
            }
            return refuse(standing, departureStatus(reason));
        }

        void ascended(BlockPos to, Direction bearing) {
            recordCaveFooting(to);
            outward = bearing;
            if (setback.resited(to)) {
                settled(to);
                status = departureStatus(status);
            }
        }

        private void walkFrom(BlockPos standing) {
            returning = false;
            tread = null;
            lastJoined = null;
            resumeIndex = resumeStep = -1;
            until = tick + WALK_TICKS;
            if (attemptedAt != null && !standing.equals(attemptedAt)) {
                int dx = standing.getX() - attemptedAt.getX(), dz = standing.getZ() - attemptedAt.getZ();
                if (dx != 0 || dz != 0) outward = Math.abs(dx) >= Math.abs(dz)
                    ? dx > 0 ? Direction.EAST : Direction.WEST : dz > 0 ? Direction.SOUTH : Direction.NORTH;
            }
        }

        boolean arrivedAt(BlockPos foot) { return foot.equals(lastJoined) && exactContact(foot); }

        void follow(BlockPos from, BlockPos to) {
            status = departureStatus("rechecking walked return " + from.toShortString() + " -> " + to.toShortString());
            if (!eligibleReturn(from, to)) {
                returnRefused(from, to, "the directed edge was already refused");
                return;
            }
            if (tread == null || !tread.from.equals(from) || !tread.to.equals(to))
                tread = AgentSurfaceTread.ordinaryRecall(c, from, to, tick);
            if (tread == null) {
                returnRefused(from, to, "the grade or its movement controls are unavailable");
                return;
            }
            if (tread.ordinaryDescent() && !tread.leftTakeoff(c) && !hasCaveEscapeKit(from.getY() - to.getY())) {
                returnRefused(from, to, "no usable pick or enough solid blocks for the one-way landing");
                return;
            }
            switch (tread.step(c, body, tick)) {
                case CHECKING -> { }
                case MOVING -> rememberMotion();
                case LANDED -> {
                    boolean oneWay = tread.ordinaryDescent();
                    if (oneWay) {
                        // Retain only the historical prefix underfoot. No breadcrumb crosses
                        // this drop upward, and no navigation receipt implies a reverse jump.
                        trimCaveTrail(returnIndex + 1);
                    }
                    tread = null;
                    lastJoined = to;
                    outward = AgentDryLanding.bearing(from, to);
                    if (setback.resited(to)) settled(to);
                    if (oneWay) status += "; landed one-way " + from.toShortString() + " -> " + to.toShortString()
                        + " (no reverse tread proved)";
                }
                case REFUSED -> returnRefused(from, to, tread.refusal());
            }
        }

        void returnRefused(BlockPos from, BlockPos to, String reason) {
            // Do not call abandonReturn: it would schedule a resume into the failed mine.
            BlockPos standing = c.player.getBlockPos();
            returnFailure = "walked return refused" + (from == null || to == null ? ""
                : " " + from.toShortString() + " -> " + to.toShortString()) + ": " + reason;
            if (from != null && to != null && eligibleReturn(from, to)) {
                if (refusedEdges == null) refusedEdges = new ArrayList<>(4);
                refusedEdges.add(new RefusedEdge(from, to));
                stallGuard.refuseCrossing(from, to);
            }
            discardCrossedDropSuffix();
            tread = null;
            body.pauseWork();
            boolean joined = standing.equals(lastJoined) && exactContact(standing);
            if (joined && setback.resited(standing)) {
                settled(standing);
                status = departureStatus(status);
                return;
            }
            if (joined && from != null && returnIndex >= 0 && tick < until) {
                int alternative = mineRetreatRejoin(trail, returnTo, returnIndex + 1, standing, eligibleReturn);
                if (alternative >= 0) {
                    returnIndex = alternative;
                    returnFrom = null;
                    status = departureStatus("checking the next physically joined waypoint");
                    return;
                }
            }
            clearReturn();
            if (!exactContact(standing)) {
                refuse(standing, returnFailure);
                return;
            }
            keepStandingPrefix(standing);
            walkFrom(standing);
            status = departureStatus("checking different dry footing from here");
        }

        void discardCrossedDropSuffix() {
            if (oneWayInFlight() && returnIndex >= 0 && tread.leftTakeoff(c)) trimCaveTrail(returnIndex + 1);
        }

        private void keepStandingPrefix(BlockPos standing) {
            int join = trail.lastIndexOf(standing);
            if (join >= 0) trimCaveTrail(join + 1);
            else {
                detachMine(standing);
                appendGrounded(standing, false);
            }
        }

        void returned(int index) {
            BlockPos foot = trail.get(index);
            if (setback.resited(foot)) {
                settled(foot);
                return;
            }
            clearReturn();
            trimCaveTrail(index + 1);
            walkFrom(foot);
        }

        private boolean settled(BlockPos foot) {
            stopAt(foot);
            attemptedAt = null;
            returnableMine.resited(foot);
            digDirection = outward;
            nextDigStart = tick;
            failedDirections = stairLength = legLength = deadEnds = 0;
            stallGuard.mineResited();
            status = "reached a different dry mine start; the ore objective is unchanged";
            return true;
        }

        private boolean refuse(BlockPos foot, String reason) {
            stopAt(foot);
            if (exactContact(foot)) attemptedAt = foot.toImmutable();
            stallGuard.mineDepartureRefused(reason);
            status = stallGuard.status();
            return true;
        }

        private void stopAt(BlockPos foot) {
            release();
            if (exactContact(foot)) {
                stopFoot = foot.toImmutable();
                int index = trail.lastIndexOf(foot);
                trimCaveTrail(index + 1);
                if (index < 0) appendGrounded(foot, false);
            }
            resumeIndex = resumeStep = -1;
            body.pauseWork();
        }

        private void release() {
            if (returning) {
                discardCrossedDropSuffix();
                clearReturn();
            } else if (ascending) supplyEgress.cancelMineDeparture();
            returning = ascending = false;
            until = 0;
            tread = null;
            lastJoined = null;
            if (refusedEdges != null) refusedEdges.clear();
        }
    }

    private boolean walkedWaterReturn(BlockPos from, BlockPos to) { return caves.walkedWaterEdge(from, to); }

    private static boolean returnEdge(BlockPos from, BlockPos to, BiPredicate<BlockPos, BlockPos> water) {
        return from.equals(to) || adjacent(from, to) && !sameStem(from, to) || water.test(from, to);
    }

    static int connectedReturnAnchor(List<BlockPos> trail, int last, int to, BlockPos standing,
                                     BiPredicate<BlockPos, BlockPos> water) {
        if (to < 0 || to > last || last >= trail.size()) return -1;
        int anchor = -1;
        for (int i = to; i <= last; i++) {
            BlockPos cell = trail.get(i);
            if (i > to && !returnEdge(cell, trail.get(i - 1), water)) break;
            if (cell.equals(standing)) anchor = i;
        }
        return anchor;
    }

    private int groundedTrailIndex() {
        if (!dryFieldFooting()) return -1;
        BlockPos standing = c.player.getBlockPos();
        for (int i = activeTrail() - 1; i >= 0; i--) if (standing.equals(trail.get(i))) return i;
        return -1;
    }

    private boolean startReturn(int index, boolean preserve) {
        if (!dryFieldFooting()) return false;
        int anchor = connectedReturnAnchor(trail, activeTrail() - 1, index, c.player.getBlockPos(), walkedWaterReturn);
        if (anchor < 0) return false;
        startReturnAt(anchor, index, preserve);
        return true;
    }

    private void startReturnAt(int anchor, int index, boolean preserve) {
        clearReturn();
        returnIndex = anchor;
        returnTo = index;
        keepTrail = preserve;
        resumeIndex = -1;
        returnAge = tick;
        returnClear = -1;
        returnLitIndex = -1;
        climbTo = null;
        gaitStep = null;
        nextFoot = null;
        forcedLight = false;
        target = null;
        clearPickup();
    }

    private boolean rejoinReturn(BlockPos standing) {
        int last = Math.min(trail.size() - 1, returnIndex + 1);
        int index = connectedReturnAnchor(trail, last, returnTo, standing, walkedWaterReturn);
        if (index < 0) return false;
        returnIndex = index;
        returnFrom = climbTo = gaitStep = null;
        returnAge = tick;
        returnClear = -1;
        forcedLight = false;
        return true;
    }

    private void retreatTunnel() {
        status = "returning along traveled steps";
        if (returnIndex < 0) return;
        BlockPos standing = c.player.getBlockPos();
        BlockPos next = trail.get(returnIndex);
        if (dryFieldFooting()) {
            if (returnForSupplies && (supplyReturnReady() || recoveryOnOpenGround())
                    || returnForFurnace && returnFurnaceInReach()) {
                int underfoot = groundedTrailIndex();
                clearReturn();
                resumeAfterReturn(standing, underfoot);
                return;
            }
            if (!standing.equals(next) && !standing.equals(returnFrom)) {
                if (mineResite.retreating()) {
                    mineResite.returnRefused(returnFrom, next,
                        "grounded outside the exact joining tread at " + standing.toShortString());
                    return;
                }
                if (!rejoinReturn(standing)) {
                    abandonReturn(standing);
                    return;
                }
                next = trail.get(returnIndex);
            }
        }
        while (mineResite.retreating() ? mineResite.arrivedAt(next) : arrived(next)) {
            if (!mineResite.retreating()) stallGuard.followedMineWaypoint();
            returnAge = tick;
            returnClear = -1;
            climbTo = null;
            if (returnIndex > returnTo) {
                returnFrom = next;
                next = trail.get(--returnIndex);
            } else {
                finishReturn();
                return;
            }
        }
        if (returnFrom == null) return; // The actor has not settled on its anchor yet.
        if (mineResite.retreating()) {
            mineResite.follow(returnFrom, next);
            return;
        }
        if (workshopReturn == null && tick - returnAge > 165) {
            returnBlocked(standing, next);
            return;
        }
        BlockPos current = returnFrom;
        if (workshopReturn != null) {
            Station station = workshopReturn;
            status = "retracing walked footing for " + station.recipe;
            boolean wet = c.player.isTouchingWater();
            boolean expired = tick - returnAge > 55;
            if (!wet && !expired && driveKnownStep(current, next) != Walk.BLOCKED) return;
            String reason = wet ? "the retreat became wet" : expired ? "the retrace did not settle in time"
                : gaitStepProof ? "the witnessed landing could not be reached safely"
                    : "the recorded tread had no visible safe support";
            abandonReturn(standing);
            blockStation(station, "cannot reposition " + station.recipe + " toward " + next.toShortString()
                + ": " + reason);
            return;
        }
        if (caves.followWater(current, next, tick)) {
            status = caves.status();
            return;
        }
        if (!adjacent(current, next) || sameStem(current, next)) {
            returnBlocked(standing, next);
            return;
        }
        if (forcedLight) {
            if (!recoveryOnOpenGround() && shouldLight(true)) return;
            forcedLight = false;
        }
        if (returnIndex + 1 < trail.size() && dugSteps.get(returnIndex + 1)
            && driveKnownStep(current, next) != Walk.BLOCKED) return;
        if (next.getY() == current.getY() + 1
            && Math.abs(next.getX() - current.getX()) + Math.abs(next.getZ() - current.getZ()) == 1) {
            status = "climbing a traveled step";
            if (climb(current, next) == Walk.BLOCKED) {
                if (!recoveryOnOpenGround() && has(TORCH, 1) && returnLitIndex != returnIndex && tick - returnAge < 90) {
                    returnLitIndex = returnIndex;
                    forcedLight = true;
                    climbTo = null;
                    return;
                }
                forcedLight = false;
                returnBlocked(standing, next);
            }
            return;
        }
        if (returnClear >= 0) {
            Dig result = clear(next.up(returnClear));
            if (result == Dig.DARK && !recoveryOnOpenGround() && has(TORCH, 1) && returnLitIndex != returnIndex) {
                returnLitIndex = returnIndex;
                forcedLight = true;
            } else if (result != Dig.LOOKING) returnClear--;
            return;
        }
        if (walkMinedStep(next) == Walk.BLOCKED) returnClear = 1;
    }

    private void finishReturn() {
        int index = returnIndex;
        if (mineResite.retreating()) {
            mineResite.returned(index);
            return;
        }
        clearReturn();
        if (keepTrail) {
            resumeAfterReturn(trail.get(index), index);
            if (refitPickCount >= 0) refitPickUntil = tick + 180;
        } else if (index > 0 && index + 1 < trail.size()) {
            closeDig(trail.get(index + 1));
            trail.subList(index + 1, trail.size()).clear();
            litIndex = Math.min(litIndex, trail.size());
            failedDirections = stairLength = 0;
            digDirection = c.player.getHorizontalFacing().rotateYClockwise();
        } else if (index == 0) {
            trail.clear();
            nextDigStart = tick + 95;
            heading = c.player.getYaw() + 75;
            headingUntil = tick + 150;
        }
    }

    private void clearReturn() {
        returnIndex = -1;
        tableReturn = null;
        workshopReturn = null;
        returnForFurnace = returnForSupplies = false;
        returnFrom = climbTo = gaitStep = null;
        forcedLight = false;
    }

    private void abandonReturn(BlockPos standing) {
        if (tableReturn != null) failedTableReturn = tableReturn;
        if (returnForFurnace) {
            if (furnaceLoaded) {
                refusedFurnace = furnace.position;
                refusedFurnaceFoot = standing;
            } else releaseUnpaidFurnace(furnace.position);
        }
        if (oreProbeReturning) rejectOreProbe();
        if (portalSupplies != null) portalSupplies.returning = false;
        clearReturn();
        endExitRecovery();
        resumeAfterReturn(standing, groundedTrailIndex());
        body.prioritizeMovement();
    }

    private void resumeAfterReturn(BlockPos standing, int index) {
        if (index < 0) detachMine(standing);
        else resumeIndex = index + 1 < trail.size()
                && returnEdge(trail.get(index + 1), trail.get(index), walkedWaterReturn) ? index + 1 : -1;
        resumeStep = -1;
        supplyExcursion.reset();
    }

    private void returnBlocked(BlockPos standing, BlockPos next) {
        if (tableReturn != null || returnForFurnace || returnForSupplies || oreProbeReturning
                || portalSupplies != null && portalSupplies.returning || recoveryOnOpenGround()) {
            abandonReturn(standing);
        } else {
            startExitRecovery(directional(Vec3d.ofBottomCenter(next).subtract(c.player.getPos())));
        }
    }

    private void resumeTunnel() {
        status = "resuming a traveled mine";
        BlockPos current = c.player.getBlockPos();
        if (resumeIndex < trail.size() && arrived(trail.get(resumeIndex))) {
            resumeIndex++;
            supplyExcursion.reset();
            stallGuard.followedMineWaypoint();
        }
        if (resumeIndex >= trail.size()) {
            resumeIndex = -1;
            supplyExcursion.reset();
            useTraveledBearing(trail.size() - 1);
            return;
        }
        if (resumeStep != resumeIndex) {
            resumeStep = resumeIndex;
            returnAge = tick;
            climbTo = null;
        }
        BlockPos next = trail.get(resumeIndex);
        BlockPos entry = trail.get(resumeIndex - 1);
        if (!returnEdge(next, entry, walkedWaterReturn)) {
            detachMine(current);
            return;
        }
        if (supplyExcursion.returningFrom(current, entry)) {
            status = "returning to the mine along witnessed supply footing";
            Walk back = supplyExcursion.back(current, entry);
            if (back != Walk.BLOCKED) {
                returnAge = tick;
                return;
            }
            detachMine(current);
            return;
        }
        supplyExcursion.mineStep = tick;
        if (branchPastWorkshop(current, entry, next)) return;
        if (caves.followWater(entry, next, tick)) {
            status = caves.status();
            return;
        }
        if (!adjacent(entry, next) || sameStem(entry, next)) {
            detachMine(current);
            return;
        }
        if (resumeIndex > 0 && dugSteps.get(resumeIndex)
            && driveKnownStep(entry, next) != Walk.BLOCKED) return;
        if (tick - returnAge > 155 || !adjacent(current, next)) {
            detachMine(current);
            return;
        }
        Walk result = next.getY() > current.getY() ? climb(current, next) : walkMinedStep(next);
        if (result == Walk.BLOCKED) detachMine(current);
    }

    /** A verified station can invalidate one resume step, not the already walked mine behind us. */
    private boolean branchPastWorkshop(BlockPos current, BlockPos entry, BlockPos next) {
        if (resumeIndex < 4 || !current.equals(entry) || !arrived(entry) || c.player.isTouchingWater()
                || !adjacent(current, next) || sameStem(next, current) || firing != Firing.NONE) return false;
        BlockPos obstacle = furnace.position != null ? furnace.position : memory.station(c.world, true);
        if (!occupiesStep(obstacle, next))
            obstacle = table.position != null ? table.position : memory.station(c.world, false);
        if (!occupiesStep(obstacle, next) || tick - returnAge >= 34) return false;

        Vec3d aim = Vec3d.ofCenter(obstacle);
        body.aim(aim);
        status = "checking the workshop in the traveled passage";
        BlockHitResult visible = perceive(aim, REACH);
        if (visible == null || !visible.getBlockPos().equals(obstacle)) return true;
        BlockState station = state(visible);
        if (!station.isOf(Blocks.FURNACE) && !station.isOf(Blocks.CRAFTING_TABLE)) return false;
        if (!has(TORCH, 2) || pickUses(DEEP_PICK) + pickUses(STONE_PICK) < 6) return false;

        Direction lane = directional(Vec3d.ofBottomCenter(next).subtract(Vec3d.ofBottomCenter(current)));
        Vec3d lip = Vec3d.ofBottomCenter(current).add(lane.getOffsetX() * 0.38, -0.04, lane.getOffsetZ() * 0.38);
        BlockHitResult floor = terrain(lip, REACH);
        if (floor == null || !floor.getBlockPos().equals(current.down()) || floor.getSide() != Direction.UP
                || !safeSupport(floor) || !state(floor).isIn(BlockTags.BASE_STONE_OVERWORLD)) return true;

        // The ordinary miner chooses and proves the next landing; no station or support is cut.
        closeDig(next);
        closeDig(next.down());
        trail.subList(resumeIndex, trail.size()).clear();
        if (dugSteps.length() > resumeIndex) dugSteps.clear(resumeIndex, dugSteps.length());
        litIndex = Math.min(litIndex, trail.size());
        resumeIndex = resumeStep = -1;
        supplyExcursion.reset();
        surfaceApproach.abandon();
        departureKit = timberReady = true;
        digDirection = lane.rotateYClockwise();
        failedDirections = legLength = stairLength = deadEnds = 0;
        climbTo = gaitStep = null;
        status = "branching from witnessed mine footing around the workshop";
        return true;
    }

    private void detachMine(BlockPos standing) {
        memory.detach(c.world, trail, standing);
        trail.clear();
        dugSteps.clear();
        resumeIndex = -1;
        supplyExcursion.reset();
    }

    private final class SupplyExcursion {
        private final AgentMemory.Excursion walked = new AgentMemory.Excursion();
        private ClientWorld world;
        private BlockPos from, target;
        private int targetSince, mineStep = -100;
        private boolean visible;

        void reset() {
            walked.clear();
            from = target = null;
            visible = false;
            mineStep = -100;
        }

        void observe(BlockPos standing, long observedTick) {
            if (world != c.world) {
                world = c.world;
                reset();
            }
            if (resumeIndex <= 0 || resumeIndex > trail.size()) {
                if (walked.started() || target != null) reset();
                return;
            }
            BlockPos entry = trail.get(resumeIndex - 1);
            if (standing.equals(target)) from = target = null;
            walked.observe(entry, standing, observedTick, target == null && tick - mineStep > 14);
        }

        boolean returningFrom(BlockPos standing, BlockPos entry) {
            return !standing.equals(entry) && tick - mineStep > 14
                && (target != null || c.player.isOnGround());
        }

        Walk back(BlockPos standing, BlockPos entry) {
            if (target == null) {
                if (!c.player.isOnGround()) return Walk.LOOKING;
                BlockPos prior = walked.previous(standing);
                from = prior != null ? standing : null;
                target = prior != null ? prior : entry;
                targetSince = tick;
                visible = false;
            }
            Walk result = tick - targetSince >= 85 ? Walk.BLOCKED : stepBack();
            if (result != Walk.BLOCKED || from == null) return result;
            // An old crumb can be obstructed. The entrance may still be visibly reachable.
            from = null;
            target = entry;
            visible = false;
            targetSince = tick;
            return Walk.LOOKING;
        }

        private Walk stepBack() {
            if (from != null) {
                double dx = c.player.getX() - from.getX() - 0.5;
                double dz = c.player.getZ() - from.getZ() - 0.5;
                if (dx * dx + dz * dz > 1.55 * 1.55
                    || Math.abs(c.player.getY() - from.getY()) > 1.25) return Walk.BLOCKED;
                if (adjacent(from, target)) {
                    return target.getY() > from.getY() ? driveKnownStep(from, target) : walkMinedStep(target);
                }
            }
            Vec3d floor = Vec3d.ofBottomCenter(target);
            if (c.player.getPos().squaredDistanceTo(floor) > 81) return Walk.BLOCKED;
            if (!visible) {
                Vec3d point = floor.add(0, -0.05, 0);
                body.aim(point);
                BlockHitResult hit = terrain(point, c.player.getEyePos().distanceTo(point) + 0.1);
                if (hit == null || !hit.getBlockPos().equals(target.down()) || hit.getSide() != Direction.UP
                    || !safeSupport(hit)) return Walk.LOOKING;
                visible = true;
            }
            return approach(floor, false, false);
        }
    }

    private Walk driveKnownStep(BlockPos from, BlockPos to) {
        if (!adjacent(from, to) || from.getX() == to.getX() && from.getZ() == to.getZ()
                || stallGuard.refusedCrossing(from, to)) return Walk.BLOCKED;
        Vec3d feet = c.player.getPos();
        Vec3d start = Vec3d.ofBottomCenter(from);
        Vec3d landing = Vec3d.ofBottomCenter(to);
        if (horizontalDistance(feet, start) > 1.5 || feet.y < Math.min(start.y, landing.y) - 0.25)
            return Walk.BLOCKED;
        if (!to.equals(gaitStep)) {
            gaitStep = to;
            gaitStepSince = tick;
            gaitStepProof = gaitStepBlocked = false;
        }
        if (gaitStepBlocked) return Walk.BLOCKED;
        Vec3d delta = landing.subtract(feet);
        if (delta.horizontalLengthSquared() < 0.05 && !c.player.isOnGround()) return Walk.MOVING;
        boolean ascending = to.getY() > from.getY();
        float heading = yaw(delta);
        body.lookAlongGait(heading, ascending ? 13 : 30);
        if (tick - gaitStepSince > 37 || stuck >= 7) {
            gaitStepBlocked = true;
            return Walk.BLOCKED;
        }
        if (Math.abs(MathHelper.wrapDegrees(heading - c.player.getYaw())) > 13) return Walk.LOOKING;
        if (!gaitStepProof) {
            Vec3d inward = landing.subtract(start);
            Vec3d point = landing.add(inward.x * 0.30, -0.08, inward.z * 0.30);
            BlockHitResult support = workshopReturn == null ? terrain(point, 3.4)
                : body.dryRouteFloor(point, to.down());
            if (support == null || !support.getBlockPos().equals(to.down()) || !safeSupport(support)) {
                if (tick - gaitStepSince < 16) return Walk.LOOKING;
                gaitStepBlocked = true;
                return Walk.BLOCKED;
            }
            gaitStepProof = true;
        }
        if (ascending && body.jumpBlocked(heading)) {
            stallGuard.refuseCrossing(from, to);
            return Walk.BLOCKED;
        }
        if (ascending) body.jump();
        walkDown(false);
        return Walk.MOVING;
    }

    private Walk walkMinedStep(BlockPos next) {
        if (stallGuard.refusedCrossing(c.player.getBlockPos(), next)) return Walk.BLOCKED;
        Vec3d floor = Vec3d.ofBottomCenter(next);
        if (body.driveObservedStep(floor)) {
            rememberMotion();
            return Walk.MOVING;
        }
        Vec3d delta = floor.subtract(c.player.getPos());
        if (delta.horizontalLengthSquared() < 0.06 && !c.player.isOnGround()) return Walk.MOVING;
        Direction travel = directional(delta);
        Vec3d point = floor.add(travel.getOffsetX() * 0.23, -0.03, travel.getOffsetZ() * 0.23);
        body.aim(point);
        if (!body.aligned(point)) return Walk.LOOKING;
        BlockHitResult hit = terrain(point, 3.2);
        if (hit != null && hit.getSide() == Direction.UP && safeSupport(hit)) {
            if (hit.getBlockPos().equals(next.down())) {
                if (stuck >= 12) return Walk.BLOCKED;
                if (body.beginObservedStep(hit, floor)) rememberMotion();
                else walkDown(false);
                return Walk.MOVING;
            }
            if (hit.getBlockPos().equals(c.player.getBlockPos().down()) && stuck < 10) {
                body.sneak();
                walk(false);
                return Walk.MOVING;
            }
        }
        return Walk.BLOCKED;
    }

    private static boolean adjacent(BlockPos from, BlockPos to) {
        return Math.abs(from.getY() - to.getY()) <= 1
            && Math.abs(from.getX() - to.getX()) + Math.abs(from.getZ() - to.getZ()) <= 1;
    }

    /** Check the jump envelope, then hold forward and jump through the rise without re-aiming at the floor. */
    private Walk climb(BlockPos from, BlockPos to) {
        if (stallGuard.refusedCrossing(from, to)) return Walk.BLOCKED;
        if (!to.equals(climbTo)) {
            climbTo = to;
            climbCheck = 0;
            climbDrive = 0;
            climbDeadline = tick + 145;
        }
        if (tick >= climbDeadline) return Walk.BLOCKED;
        if (climbCheck < 3) {
            BlockPos inspected = climbCheck == 0 ? from.up(2) : climbCheck == 1 ? to.up() : to;
            Vec3d point = Vec3d.ofCenter(inspected);
            if (climbCheck == 0) point = point.add((to.getX() - from.getX()) * 0.33, 0,
                (to.getZ() - from.getZ()) * 0.33);
            Dig result = clear(inspected, point);
            if (result == Dig.BLOCKED || result == Dig.DARK) return Walk.BLOCKED;
            if (result == Dig.CLEAR) climbCheck++;
            return Walk.LOOKING;
        }
        if (climbCheck <= 4) {
            int dx = to.getX() - from.getX(), dz = to.getZ() - from.getZ();
            // A near, upper edge of the known support may be visible when the
            // lower center is hidden by the current ledge.
            boolean upper = climbCheck == 3;
            Vec3d lip = Vec3d.ofCenter(to.down(), upper ? 0.90 : 0.29);
            if (upper) lip = lip.add(-0.37 * dx, 0, -0.37 * dz);
            body.aim(lip);
            if (!body.aligned(lip)) return Walk.LOOKING;
            BlockHitResult hit = terrain(lip, 2.75);
            if (hit == null || !hit.getBlockPos().equals(to.down()) || !safeSupport(hit)
                    || !Block.isShapeFullCube(state(hit).getCollisionShape(c.world, hit.getBlockPos()))) {
                if (!upper) return Walk.BLOCKED;
                climbCheck++;
                return Walk.LOOKING;
            }
            climbCheck = 5;
        }
        Vec3d feet = c.player.getPos();
        Vec3d delta = Vec3d.ofBottomCenter(to).subtract(feet);
        float heading = yaw(delta);
        if (delta.horizontalLengthSquared() < 0.075 && feet.y > to.getY() - 0.20) return Walk.MOVING;
        body.turn(heading, -9);
        if (Math.abs(MathHelper.wrapDegrees(heading - c.player.getYaw())) > 10) return Walk.LOOKING;
        if (body.jumpBlocked(heading) || ++climbDrive > 27) {
            stallGuard.refuseCrossing(from, to);
            return Walk.BLOCKED;
        }
        body.jump();
        walk(false);
        return Walk.MOVING;
    }

    private void startExitRecovery(Direction heading) {
        if (exitStart != null) return;
        if (!dryFieldFooting()) return;
        if (recoveryOnOpenGround()) {
            finishExitRecovery(c.player.getBlockPos(), true);
            return;
        }
        exitStart = exitFrom = c.player.getBlockPos();
        exitTo = null;
        exitHeading = heading;
        exitSide = 0;
        exitClear = 1;
        exitLevel = false;
        exitDeadline = tick + 620;
        pillarStage = pillarStarted = 0;
        climbTo = null;
        gaitStep = null;
        recoveryVisited.clear();
        recoveryVisited.add(exitFrom);
    }

    private boolean recoveryOnOpenGround() {
        if (!dryFieldFooting() || c.player.hasVehicle()) return false;
        if (supplyEgress.outdoors()) return true;
        // Under leaves the skyline can be occluded, but the actual dry grass
        // contact is already a worksite. A missing uphill target is not a cave.
        BlockState floor = body.dryCaveContact(c.player.getBlockPos());
        return floor != null && (floor.isOf(Blocks.GRASS_BLOCK) || floor.isOf(Blocks.PODZOL)
                || floor.isOf(Blocks.MYCELIUM))
            || (body.supplyPerspective(body.defensiveViewYaw()) & AgentBody.SUPPLY_OPEN) != 0;
    }

    private void endExitRecovery() {
        exitStart = exitFrom = exitTo = climbTo = gaitStep = null;
        forcedLight = false;
    }

    private void finishExitRecovery(BlockPos standing, boolean open) {
        if (open) supplyEgress.observeOpenFoot(standing);
        if (returnIndex >= 0) abandonReturn(standing);
        else endExitRecovery();
        sweepOrigin = Vec3d.ofBottomCenter(standing);
        sweepHeading = heading = c.player.getYaw();
        headingUntil = tick + 125;
        sweepIndex = 0;
        status = open ? "resuming ordinary work from settled open ground" : "resuming from witnessed footing";
    }

    private void recoverExit() {
        status = "searching for a visible upward exit";
        if (pillarStage == 3 && arrived(exitFrom.up()) && !has(BUILDING, pillarCount)) {
            reachedRecoveryStep(exitFrom.up());
            return;
        }
        if (dryFieldFooting()) {
            BlockPos standing = c.player.getBlockPos();
            if (recoveryOnOpenGround()) {
                finishExitRecovery(standing, true);
                return;
            }
            if (!standing.equals(exitFrom) && !standing.equals(exitTo)) {
                if (returnIndex >= 0 && rejoinReturn(standing)) endExitRecovery();
                else finishExitRecovery(standing, false);
                return;
            }
        }
        if (tick >= exitDeadline) {
            finishExitRecovery(c.player.getBlockPos(), false);
            localBlock = "no reachable visible exit";
            status = localBlock;
            return;
        }
        if (forcedLight) {
            if (shouldLight(true)) return;
            forcedLight = false;
        }
        if (exitTo != null) {
            if (arrived(exitTo)) {
                reachedRecoveryStep(exitTo);
            } else if ((exitTo.getY() > exitFrom.getY() ? climb(exitFrom, exitTo) : walkMinedStep(exitTo)) == Walk.BLOCKED) {
                if (lightDigOnce(exitFrom)) {
                    climbTo = null;
                    return;
                }
                exitTo = null;
                climbTo = null;
                nextExitOption();
            }
            return;
        }
        if (exitSide >= 8) {
            if (!recoverPillar()) {
                finishExitRecovery(c.player.getBlockPos(), false);
                localBlock = "no reachable visible exit";
                status = localBlock;
            }
            return;
        }
        if (!c.player.isOnGround()) return;
        Direction direction = switch (exitSide & 3) {
            case 0 -> exitHeading;
            case 1 -> exitHeading.rotateYClockwise();
            case 2 -> exitHeading.rotateYCounterclockwise();
            default -> exitHeading.getOpposite();
        };
        BlockPos support = exitFrom.offset(direction);
        BlockPos landing = exitLevel ? support : support.up();
        if (recoveryVisited.contains(landing) || stallGuard.refusedCrossing(exitFrom, landing)) {
            nextExitOption();
            return;
        }
        if (exitLevel) {
            if (exitClear >= 0) {
                Dig result = clear(support.up(exitClear));
                if (result == Dig.CLEAR) exitClear--;
                else if (result == Dig.DARK && lightDigOnce(exitFrom)) return;
                else if (result != Dig.LOOKING) nextExitOption();
                return;
            }
            exitTo = support;
            return;
        }
        Vec3d point = Vec3d.ofCenter(support, 0.33);
        body.aim(point);
        if (!body.aligned(point)) return;
        BlockHitResult hit = terrain(point, 2.7);
        if (hit == null || !hit.getBlockPos().equals(support) || !safeSupport(hit)) {
            if (hit == null && body.outlined(support) && lightDigOnce(exitFrom)) return;
            nextExitOption();
            return;
        }
        exitTo = support.up();
    }

    private void nextExitOption() {
        exitLevel = ++exitSide >= 4;
        exitClear = 1;
    }

    private void reachedRecoveryStep(BlockPos reached) {
        boolean rose = reached.getY() > exitFrom.getY();
        if (rose) exitDeadline = tick + 620;
        if (recoveryVisited.size() >= 48) recoveryVisited.removeFirst();
        recoveryVisited.add(reached);
        exitFrom = reached;
        exitTo = null;
        exitSide = pillarStage = pillarStarted = 0;
        exitLevel = false;
        exitClear = 1;
        if (recoveryOnOpenGround()) finishExitRecovery(reached, true);
        else if (returnIndex >= 0 && rejoinReturn(reached)) endExitRecovery();
        else if (returnIndex < 0) finishExitRecovery(reached, false);
    }

    private boolean recoverPillar() {
        if (stallGuard.refusedCrossing(exitFrom, exitFrom.up())) return false;
        status = "raising a step on visible support";
        if (pillarStarted == 0) {
            pillarStarted = tick;
            pillarCount = hands.count(BUILDING);
        }
        if (pillarCount == 0 || tick - pillarStarted > 100) return false;
        if (pillarStage < 2) {
            Dig result = clear(exitFrom.up(pillarStage + 2));
            if (result == Dig.CLEAR) pillarStage++;
            return result == Dig.LOOKING || result == Dig.CLEAR;
        }
        if (!hands.equipForUse(BUILDING)) return true;
        BlockPos support = exitFrom.down();
        body.turnFixed(c.player.getYaw(), 90);
        BlockHitResult hit = body.selectedFace();
        if (hit == null || hit.getSide() != Direction.UP || !hit.getBlockPos().equals(support)) return true;
        BlockHitResult floor = terrain(hit.getPos().add(0, -0.04, 0), 3.5);
        if (floor == null || !floor.getBlockPos().equals(support) || !safeSupport(floor)) return false;
        if (c.player.getBoundingBox().intersects(new Box(exitFrom))) body.jump();
        else if (body.useContact(hit, AgentBody.Contact.PRECISE)) {
            pillarStage = 3;
        }
        return true;
    }

    private boolean escapeDanger(AgentEars ears, boolean hurt, boolean ordinary, boolean macroEngaged,
                                 Predicate<ItemStack> safetySpend) {
        if (hurt) defense.markDanger(tick);
        BlockPos workFoot = supplyEgress.to != null ? supplyEgress.to : nextFoot;
        if (workFoot != null && body.lavaBreachesDig(workFoot)) body.beginLavaEscape();
        if (body.lavaEmergency()) {
            defense.forgetContact();
            if (nextFoot != null) {
                int last = activeTrail() - 1;
                if (last > 0) {
                    int exit = last - 1;
                    BlockPos lip = trail.get(last), prior = trail.get(exit);
                    if (exit > 0) {
                        BlockPos older = trail.get(exit - 1);
                        // Retreat across two already walked blocks only if they form a level, straight run.
                        if (lip.getY() == prior.getY() && prior.getY() == older.getY()
                                && adjacent(lip, prior) && adjacent(prior, older)
                                && lip.getX() - prior.getX() == prior.getX() - older.getX()
                                && lip.getZ() - prior.getZ() == prior.getZ() - older.getZ()) exit--;
                    }
                    closeDig(nextFoot);
                    boolean returning = startReturn(Math.max(0, last - 6), false);
                    for (int i = exit; i <= last; i++) {
                        BlockPos walked = trail.get(i);
                        if (i < last && !adjacent(trail.get(i + 1), walked)) continue;
                        if (body.preferLavaExit(Vec3d.ofBottomCenter(walked))) {
                            // Backtrack from the escape point, not toward the abandoned lip.
                            if (returning) returnIndex = i;
                            break;
                        }
                    }
                } else blockedTunnel();
            }
            defense.markDanger(tick);
            interruptHands();
            body.prioritizeMovement();
            status = c.player.isInLava() ? "escaping lava" : "retreating from lava";
            return true;
        }
        if (c.player.isTouchingWater() && c.player.getAir() < 70) {
            defense.forgetContact();
            defense.markDanger(tick);
            interruptHands();
            if (!macroEngaged) {
                if (!supplyEgress.retreatFlood()) {
                    stallGuard.takeAirTurn(stallReplan, stallRelease);
                    status = stallGuard.status();
                }
                body.prioritizeMovement();
                return true;
            }
            status = "surfacing for air";
            body.jump();
            body.walk(true);
            return true;
        }
        LivingEntity threat = body.threat(8, defense.meleeAttacker(tick),
            !c.player.isOnFire() && (hurt || defense.recentMeleeImpact(tick)), ordinary).orElse(null);
        boolean creeper = threat instanceof CreeperEntity;
        // Defer to the actual fall controller before issuing a ranged brace. Avoid the
        // generic damage turn/backtrack when a ranged shot is the corroborating cue.
        boolean ranged = !creeper && (ordinary ? defense.observeOrdinaryRanged(ears, threat, hurt, tick)
            : defense.observeRanged(ears, threat, hurt, tick));
        boolean shoreSeparated = defense.separatedShoreSwimmer(threat, tick);
        boolean melee = defense.observeMelee(ears, creeper ? null : threat, shoreSeparated,
            hurt && !creeper && (!ranged || c.player.isTouchingWater()),
            c.player.getHealth() <= 10 && wantsHealingMeal(), tick, safetySpend);
        if (!creeper && (ranged || melee)) return false;
        if (shoreSeparated) {
            // The same observation must not fall through into pursuit or a stale combat aim.
            defense.forgetContact();
            threat = null;
        }
        if (hurt && c.currentScreen instanceof HandledScreen<?>) {
            defense.forgetContact();
            interruptHands();
            retreatYaw = c.player.getYaw() + 130;
            retreatUntil = tick + 12;
            status = "closing the screen after damage";
            step(forward(retreatYaw), true, true);
            return true;
        }

        boolean selecting = defense.combatSelecting();
        boolean exposedSurface = !macroEngaged && surfaceApproach.findingGround();
        if (exposedSurface && threat != null && !creeper
                && c.player.squaredDistanceTo(threat) > 3.2 * 3.2) {
            defense.forgetContact();
            return false;
        }
        float health = c.player.getHealth();
        boolean avoidEndermanDuel = defense.retreatFromEnderman(threat, safetySpend);
        boolean flee = threat != null && (creeper || health <= 7 || health <= 10 && wantsHealingMeal()
            || avoidEndermanDuel || defense.reserveRequiresRetreat(safetySpend));
        if (flee && tick >= retreatUntil - 10) {
            retreatYaw = yaw(c.player.getPos().subtract(threat.getPos()));
            retreatUntil = tick + 15;
        }
        if (tick < retreatUntil) {
            body.prioritizeMovement();
            defense.forgetContact();
            defense.markDanger(tick);
            interruptHands();
            status = creeper ? "backing off a creeper" : avoidEndermanDuel ? "backing off an angry Enderman"
                : flee ? "retreating while hurt" : "clearing room after danger";
            if (step(forward(retreatYaw), true, true) == Walk.BLOCKED) retreatYaw += 65;
            return true;
        }
        if (threat != null) {
            body.prioritizeMovement();
            // The only Hands job combat may retain is a checked hotbar key selection.
            if (!selecting) interruptHands();
            else if (macroEngaged) hands.tick();
            if (defense.fight(threat, tick, safetySpend) && !exposedSurface) {
                Vec3d target = threat.getPos();
                if (walkToward(target, false, false) == Walk.MOVING
                        && bearingDistance(routeYaw, yaw(target.subtract(c.player.getPos()))) <= 12) {
                    defense.face();
                }
            }
            status = defense.status();
            return true;
        }
        if (defense.holdCombatView()) {
            body.prioritizeMovement();
            status = defense.status();
            return true;
        }
        return false;
    }

    private boolean prepareDefense() {
        if (nextFoot != null || firing != Firing.NONE || !c.player.isOnGround()
                || c.player.isTouchingWater() || !defense.canPrepare(tick)) return cancelEarlyAxe();
        boolean deepPick = has(DEEP_PICK, 1);
        if (!deepPick && ordinaryCaveDrops && needsTimberKit() && prepareEarlyAxe()) return true;
        if (!(goal.equals("diamond") || portal != null)) return false;
        if (ordinaryCaveDrops && tick >= nextLoadoutCheck && target == null && timberChop == null
                && !returnableMine.active() && !c.interactionManager.isBreakingBlock()) {
            nextLoadoutCheck = tick + 160;
            if (hands.readyUtilityBlocks()) {
                status = "moving building blocks to a free hotbar slot";
                return true;
            }
        }
        if (!deepPick) return false;
        cancelEarlyAxe();
        int reserve = (has(PORTAL_BUCKET, 1) ? 0 : 3) + (has(IGNITER, 1) ? 0 : 1);
        int sparePlanks = hands.count(PLANK) + 4 * hands.count(LOG) - localTableWood();
        boolean beforePortal = !portalStarted && (portal == null || !has(DIAMOND, 3) && !has(DIAMOND_PICK, 1));
        if (!defense.prepare(this, tick, reserve, sparePlanks, hands.count(STICK), beforePortal)) return false;
        if (defense.status() != null) status = defense.status();
        return true;
    }

    enum EarlyAxe {
        STONE("stone_axe", 0), WOODEN("wooden_axe", 3);

        final String recipe;
        final int planks;

        EarlyAxe(String recipe, int planks) {
            this.recipe = recipe;
            this.planks = planks;
        }

        static EarlyAxe choose(PlayerInventory inventory, boolean stonePick, boolean localBench, boolean recoverableBench) {
            int wood = 0, stone = 0, sticks = 0;
            boolean carriedBench = false, carriedFurnace = false;
            for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
                ItemStack stack = inventory.getStack(slot);
                if (stack.isEmpty()) continue;
                if (PLANK.test(stack)) wood += stack.getCount();
                else if (LOG.test(stack)) wood += 4 * stack.getCount();
                else if (AgentProgress.STONE.test(stack)) stone += stack.getCount();
                else if (stack.isOf(Items.STICK)) sticks += stack.getCount();
                else if (stack.isOf(Items.CRAFTING_TABLE)) carriedBench = true;
                else if (stack.isOf(Items.FURNACE)) carriedFurnace = true;
            }
            if (!carriedBench && !localBench) return null;
            // A borrowed table should not consume the wood for a portable bench.
            int benchWood = carriedBench || recoverableBench ? 0 : 4;
            int handleWood = 2 * Math.ceilDiv(Math.max(0, 2 * PICK_HANDLES - sticks), 4);
            int spareWood = wood - benchWood - handleWood;
            if (spareWood < 0) return null;
            // Keep a head for the first stone pick, or for a replacement if there isn't spare wood.
            int stoneReserve = (stonePick && spareWood >= 3 ? 0 : 3) + (carriedFurnace ? 0 : 8);
            if (stone >= 3 + stoneReserve) return STONE;
            return spareWood >= WOODEN.planks + 3 ? WOODEN : null;
        }
    }

    private EarlyAxe earlyAxeStock(BlockPos usableBench) {
        int missingIron = 3 - hands.count(INGOT);
        // Once smelting has feedstock, don't spend its wood fuel or take a funded workshop's turn.
        if (missingIron <= 0 || has(RAW_IRON, 1) && (!has(FUEL, 1) || fundedFirstIron(missingIron) != null))
            return null;
        boolean recoverableBench = usableBench != null && fieldBench.world == c.world
            && fieldBench.packable && usableBench.equals(fieldBench.position);
        return EarlyAxe.choose(c.player.getInventory(), pickUses(STONE_PICK) >= MIN_PICK_USES,
            usableBench != null, recoverableBench);
    }

    private boolean prepareEarlyAxe() {
        var player = c.player;
        if (!hands.stableCraftFooting() || !safePickupStance() || c.options.useKey.isUnbound()
                || timberChop != null || returnableMine.active() || c.interactionManager.isBreakingBlock())
            return cancelEarlyAxe();
        BlockPos foot = player.getBlockPos();
        if (earlyAxe == null) {
            if (tableRecipe != null || table.placed != 0 || foot.equals(earlyAxeFoot)
                    || earlyAxeStarted != 0 && tick - earlyAxeStarted < 150
                    || pickUses(WOOD_PICK) + pickUses(STONE_PICK) < MIN_PICK_USES || huntingWeapon(false) >= 0)
                return false;
            if (!defense.recentlyThreatened(tick) && player.getHealth() >= player.getMaxHealth()
                    && body.find(state -> state.isIn(BlockTags.LOGS), Math.min(REACH, player.getBlockInteractionRange()),
                        this::timberCandidate).isEmpty()
                    && (foodNutrition() >= FOOD_RESERVE || body.visibleEntity(entity -> AgentFoodWork.adult(entity) != null
                        && foodEntityEligible(entity) && dryPrey(entity)
                        && Math.abs(entity.getY() - player.getY()) <= 1.2, 6).isEmpty())) return false;
            var bench = body.find(TABLE_BLOCK, REACH).orElse(null);
            if (bench == null && (c.options.sneakKey.isUnbound() || !has(table.item, 1))) return false;
            earlyAxe = earlyAxeStock(bench == null ? null : bench.getBlockPos());
            if (earlyAxe == null) return false;
            earlyAxeFoot = foot;
            earlyAxeStarted = tick;
            if (bench == null) releaseTablePosition();
            else {
                table.position = confirmStation(table, bench);
                table.lastUse = null;
                table.opened = table.openAttempts = 0;
            }
        } else if (!foot.equals(earlyAxeFoot) || tick - earlyAxeStarted >= 48) return cancelEarlyAxe();

        if (table.position == null) {
            if (!has(table.item, 1) || !table.rejected.isEmpty()) return cancelEarlyAxe();
            if (table.face == null) {
                BlockHitResult support = body.benchFace(REACH, this::earlyAxeBenchSite, null);
                if (!selectWorkshopFace(table, support, null)) {
                    if (tick - earlyAxeStarted >= 14) return cancelEarlyAxe();
                    body.turn(player.getYaw(), 52);
                    status = "looking for nearby support for the carried table";
                    return true;
                }
            } else if (!earlyAxeBenchSite(table.face, AgentBody.placementCell(table.face))) {
                return cancelEarlyAxe();
            }
            useWorkshopFace(table);
            return true;
        }

        Vec3d center = Vec3d.ofCenter(table.position);
        if (table.placed != 0 && !observeStationPlacement(table, center)) {
            if (table.position == null) return cancelEarlyAxe();
            return true;
        }
        if (table.openAttempts >= 2 && tick - table.opened > 7) return cancelEarlyAxe();
        var bench = body.find(TABLE_BLOCK, REACH, currentTableFace).orElse(null);
        status = "opening the local table for a field axe";
        if (bench == null) body.aim(center);
        else {
            confirmStation(table, bench);
            tableRecipe = earlyAxe.recipe;
            tableExtra = tableAxe = null;
            tablePlanks = earlyAxe.planks;
            tableSticks = 2 * PICK_HANDLES;
            openStation(table, bench, AgentBody.Contact.INTERACT);
        }
        return true;
    }

    private boolean earlyAxeBenchSite(BlockHitResult support, BlockPos dest) {
        int height = dest.getY() - c.player.getBlockY();
        return support.getSide() == Direction.UP && height >= 0 && height <= 1
            && Math.abs(support.getPos().y - dest.getY()) <= 0.06
            && c.world.getWorldBorder().contains(dest) && table.availableSite(dest)
            && AgentMacroControl.benchSpace(c.world, support, dest, c.player.getBoundingBox());
    }

    private boolean cancelEarlyAxe() {
        if (earlyAxe != null) {
            if (earlyAxe.recipe.equals(tableRecipe)) tableRecipe = null;
            if (table.position == null) table.resetSite();
            earlyAxe = null;
        }
        return false;
    }

    private void interruptHands() {
        cancelEarlyAxe();
        defense.cancelSelection();
        if (hands.busy()) hands.cancel();
        if (c.currentScreen instanceof HandledScreen<?>) c.currentScreen.close();
    }

    int mealsEaten() { return mealsEaten; }
    int foodPickedUp() { return foodPickedUp; }
    void confirmMacroFoodPickup(int count) { foodPickedUp += count; }
    static boolean ordinaryFood(ItemStack stack) { return FOOD.test(stack); }

    boolean macroFoodSafe() {
        return tick >= mealQuietUntil && (retreatUntil == 0 || tick >= retreatUntil + 10)
            && !c.player.isOnFire() && c.player.hurtTime == 0;
    }

    boolean macroFoodRelevant() {
        return macroFoodSafe() && (c.player.getHungerManager().getFoodLevel() < 18
            || c.player.getHealth() <= c.player.getMaxHealth() / 2) && foodNutrition() < FOOD_RESERVE;
    }

    boolean approachMacroFood(Vec3d target) {
        if (stuck >= 12 || !macroFoodSafe()) return false;
        Vec3d feet = c.player.getPos();
        float bearing = yaw(target.subtract(feet));
        body.lookAlongGait(bearing, 32);
        float facing = c.player.getYaw();
        if (bearingDistance(bearing, facing) > 7 || c.player.getPitch() < 25) return true;
        Vec3d lane = forward(facing);
        if (dangerInForageLane(feet.add(lane.multiply(1.15)).add(0, 0.35, 0))) return false;
        Footing ground = footing(feet, lane, facing, false);
        if (ground == Footing.LEVEL) {
            if (!body.macroNoVisiblePickup(feet.add(lane.multiply(0.85)))) return false;
            walk(false);
        }
        return ground == Footing.LEVEL || ground == Footing.UNKNOWN;
    }

    private boolean wantsHealingMeal() {
        int hunger = c.player.getHungerManager().getFoodLevel();
        return canRefuelHealing(hunger) && bestMeal(hunger) >= 0;
    }

    private boolean canRefuelHealing(int hunger) {
        float health = c.player.getHealth();
        float max = c.player.getMaxHealth();
        return hunger < 20 && health < max && (hunger < 18 || health <= max / 2);
    }

    private boolean needsEmergencyFood(int hunger) {
        // Finding ground may take precedence over responding to a distant hostile.
        return !surfaceApproach.findingGround()
            && (hunger == 0 || hunger < 18 && c.player.getHealth() <= c.player.getMaxHealth() / 2);
    }

    private boolean macroEmergencyMeal(AgentMacroControl macro) {
        // The item may already be in inventory on the tick emergency use takes
        // input back. Record the acquisition before making any meal decision.
        macro.observeFoodPickup(this);
        int hunger = c.player.getHungerManager().getFoodLevel();
        int before = mealsEaten;
        Item eaten = mealItem;
        int priorHunger = mealStartHunger;
        confirmMeal(hunger);
        if (mealsEaten > before)
            macro.safetyEffect("emergency meal consumed: " + Registries.ITEM.getId(eaten) + "; hunger " + priorHunger + " -> " + hunger);
        if (emergencyMealJob != 0) {
            if (hands.busy() && hands.jobGeneration() == emergencyMealJob) {
                macro.urgent("equipping emergency food");
                hands.tick();
                status = "equipping emergency food";
                return true;
            }
            emergencyMealJob = 0;
        }
        if (!c.player.isOnGround() || c.player.isTouchingWater()
                || tick < mealQuietUntil || tick < mealRetry || hunger == 20
                || (mealUntil == 0 && !needsEmergencyFood(hunger))) return false;
        if (mealUntil == 0 && bestMeal(hunger, macro.safetySpend()) < 0) return false;
        if (macro.hasAction() || hands.busy() || c.currentScreen instanceof HandledScreen<?>) {
            macro.urgent("releasing the current action for emergency food");
            interruptHands();
            status = "making room to eat emergency food";
            return true;
        }
        if (c.currentScreen != null || !eatMeal(hunger, macro.safetySpend())) return false;
        if (hands.busy()) emergencyMealJob = hands.jobGeneration();
        macro.urgent("eating emergency food");
        return true;
    }

    private void resetOrdinaryHealing() {
        foodWorld = c.world;
        healing.reset();
        healingOwnsWork = false;
        foodTravelTick = -2;
        foodTravelTarget = null;
        foodTravelBand = null;
        foodTravelResult = null;
        finishForage(0);
        refusedFoodEntity = null;
        refusedFoodBlock = null;
        appleStand.reset();
        mealUntil = mealRetry = mealQuietUntil = 0;
        emergencyMealJob = 0;
        mealItem = null;
        mealHealth = Float.NaN;
        lastMealReceipt = lastFoodPickup = null;
        lastFoodVantage = null;
    }

    private void beginOrdinaryHealing() {
        healingOwnsWork = true;
        if (ordinaryApproach != null) body.stopHorizonTravel(ordinaryApproach);
        ordinaryApproach = null;
        body.pauseWork();
        interruptHands();
        if (dropReclaim != null) dropReclaim.cancel();
        nightSite.interrupt();
        stallGuard.interruptSituational("yielding to health recovery");
        releaseStallAlternative();
        replanStalledLocalWork();
        finishForage(0);
    }

    private void healingStatus(String detail) {
        status = "healing: " + detail + "; hunger " + c.player.getHungerManager().getFoodLevel()
            + "; HP " + c.player.getHealth() + "/" + c.player.getMaxHealth()
            + (lastFoodVantage == null ? "" : "; last scout landing " + lastFoodVantage.toShortString())
            + (lastFoodPickup == null ? "" : "; last pickup " + lastFoodPickup)
            + (lastMealReceipt == null ? "" : "; last meal " + lastMealReceipt);
    }

    private void holdHealing(String detail) {
        body.pauseWork();
        healingStatus(detail);
    }

    private boolean eatOrHunt(int hunger, boolean recovering) {
        var player = c.player;
        float health = player.getHealth();
        // The danger handler runs first. A retreat or newly lost health means the
        // lack of a hostile in the current view is not yet a good time to stop.
        if (health < mealHealth) mealQuietUntil = tick + 10;
        if (retreatUntil > 0) mealQuietUntil = Math.max(mealQuietUntil, retreatUntil + 10);
        mealHealth = health;
        if (!macroFoodSafe() || !safePickupStance()) {
            if (forage != null) finishForage(12);
            mealUntil = 0;
            mealItem = null;
            if (recovering) holdHealing("holding clear of danger before resuming food work");
            return recovering;
        }
        boolean traveling = foodTravelTick == tick - 1 && navigator.driving(AgentOrdinaryNavigator.Job.FOOD);
        // Finish a real airborne crossing without changing targets. Grounded
        // walking still observes food, including along a continuous scout lane.
        if (traveling && (!player.isOnGround() || !body.hasRecentView())) {
            navigateFood(foodTravelTarget, foodTravelArrival, foodTravelBand);
            return true;
        }
        if (!player.isOnGround()) {
            if (recovering) holdHealing("waiting for dry ground contact");
            return recovering;
        }
        if (!recovering && (returnIndex >= 0 || exitStart != null || nextFoot != null || localBlock != null
                || firstStone.witnessedProbeWork() || pickupItem != null || c.interactionManager.isBreakingBlock())) {
            if (forage != null) finishForage(12);
            return false;
        }
        boolean mealWanted = hunger < 20 && (mealUntil != 0 || hunger <= 14 || canRefuelHealing(hunger) || recovering);
        if (mealWanted) {
            if (tick >= mealRetry && eatMeal(hunger)) {
                if (recovering) healingStatus(status);
                return true;
            }
            if (recovering && tick < mealRetry && bestMeal(hunger) >= 0) {
                holdHealing("waiting to retry an owned meal");
                return true;
            }
        }
        if (healing.canRest(hunger)) {
            if (forage != null) finishForage(0);
            holdHealing("resting with enough hunger to regenerate");
            return true;
        }
        if (!body.hasRecentView()) {
            if (recovering) holdHealing("waiting for a rendered food-search view");
            return recovering;
        }
        boolean surface = player.getBlockY() > 48 && activeTrail() <= 1;
        if (forage == null && !recovering
                && (!surface || !needsTimberKit() || firing != Firing.NONE || foodNutrition() >= FOOD_RESERVE))
            return false;
        boolean scoutHandoff = foodTravelTick == tick - 1 && ordinaryArrival != null && navigator.foodScoutHandoff();
        boolean settled = !traveling && (foodTravelTick != tick - 1 || scoutHandoff
            || foodTravelResult == Result.BLOCKED || foodTravelResult == Result.ARRIVED);
        if ((forage == null || forage == Forage.APPLE_LEAVES || forage == Forage.GROUND)
                && (tick >= forageScan || scoutHandoff || forage == Forage.APPLE_LEAVES)) {
            forageScan = tick + (recovering ? 4 : 12);
            if (!findFood(recovering) && recovering && settled && hands.stableCraftFooting()) {
                if (forage == null || forage == Forage.APPLE_LEAVES) {
                    BlockPos foot = player.getBlockPos();
                    if (!findFoodGround(foot) && forage == null) findAppleStand(foot);
                }
            }
        }
        if (forage != null) {
            if (continueForage(recovering)) return true;
            refuseForage();
            if (recovering && foodTravelTick != tick) holdHealing("released an unsafe, lost or exhausted food source");
            return recovering;
        }
        if (recovering) navigateFood(null, 0);
        return recovering;
    }

    private boolean findFood(boolean recovering) {
        double sight = recovering ? FOOD_SIGHT : REACH - 0.25;
        ItemEntity drop = visibleMealDrop(FOOD, sight, recovering, null);
        if (drop == null && recovering && needsEmergencyFood(c.player.getHungerManager().getFoodLevel()))
            drop = visibleMealDrop(FLESH_MEAL, sight, true, null);
        if (drop != null) {
            startForage(Forage.DROP, drop, null, drop.getPos(), null, 140);
            return true;
        }
        BlockHitResult berries = body.find(RIPE_BERRIES, sight, hit -> foodBlockEligible(hit)
            && (!recovering || Math.abs(hit.getBlockPos().getY() - c.player.getY()) <= 2)).orElse(null);
        if (berries != null) {
            startForage(Forage.BERRIES, null, berries.getBlockPos(), berries.getPos(), AgentFoodWork.ripe(state(berries)), 180);
            return true;
        }
        if (!c.options.attackKey.isUnbound() && huntingWeapon(recovering) >= 0) {
            Entity animal = body.visibleEntity(candidate -> foodEntityEligible(candidate)
                && AgentFoodWork.adult(candidate) != null && dryPrey(candidate)
                && (recovering || criticalHuntContact(candidate)), sight).orElse(null);
            if (animal != null) {
                startForage(Forage.ANIMAL, animal, null, animal.getPos(), AgentFoodWork.adult(animal), 230);
                return true;
            }
        }
        return false;
    }

    private boolean findFoodGround(BlockPos foot) {
        if (!body.ordinaryRouteContact(foot)) return false;
        BlockPos support = c.player.supportingBlockPos.orElse(null);
        if (support == null || !c.world.getBlockState(support).isIn(BlockTags.LEAVES)) return false;
        BlockPos best = null;
        double cost = Double.POSITIVE_INFINITY;
        Vec3d eye = c.player.getEyePos();
        int seen = body.sampleNearGround();
        for (int i = 0; i < seen; i++) {
            var hit = body.nearGroundTop(i);
            if (!foodBlockEligible(hit)) continue;
            BlockPos floor = hit.getBlockPos();
            int drop = foot.getY() - floor.getY() - 1;
            int sideways = Math.abs(foot.getX() - floor.getX()) + Math.abs(foot.getZ() - floor.getZ());
            if (drop < 1 || drop > 3 || sideways < drop) continue;
            BlockState shown = state(hit);
            if (!shown.isIn(BlockTags.DIRT) && !shown.isOf(Blocks.MOSS_BLOCK)) continue;
            double distance = eye.squaredDistanceTo(hit.getPos());
            if (distance < cost) {
                cost = distance;
                best = floor;
            }
        }
        if (best == null) return false;
        var stance = AgentResourceStance.exact(best.up());
        startForage(Forage.GROUND, null, best, stance.point(), null, 115);
        forageStance = stance;
        return true;
    }

    private void confirmMeal(int hunger) {
        if (mealItem == null) return;
        ItemStack selectedFood = c.player.getInventory().getStack(mealSlot);
        int count = selectedFood.isOf(mealItem) ? selectedFood.getCount() : 0;
        if (!AgentFoodWork.mealConfirmed(mealStartHunger, hunger, mealCount, count)) return;
        mealsEaten++;
        lastMealReceipt = Registries.ITEM.getId(mealItem) + " (hunger " + mealStartHunger + " -> " + hunger
            + ", HP " + c.player.getHealth() + ")";
        mealItem = null;
        mealUntil = 0;
    }

    private boolean eatMeal(int hunger) {
        return eatMeal(hunger, null);
    }

    private boolean eatMeal(int hunger, Predicate<ItemStack> allowed) {
        if (mealUntil != 0 && tick >= mealUntil) {
            mealRetry = tick + 45;
            mealUntil = 0;
            mealItem = null;
            return false;
        }
        ItemStack held = c.player.getMainHandStack();
        int slot = mealItem == null || mealItem == Items.ROTTEN_FLESH || !held.isOf(mealItem)
                || allowed != null && !allowed.test(held)
            ? bestMeal(hunger, allowed) : mealSlot;
        if (slot < 0) {
            mealUntil = 0;
            mealItem = null;
            return false;
        }
        if (mealItem == null || slot != mealSlot || !held.isOf(mealItem)) {
            mealItem = null;
            if (mealUntil == 0) mealUntil = tick + 75;
            if (!hands.equipSlot(slot)) {
                if (hands.busy()) {
                    status = "equipping food";
                    return true;
                }
                mealUntil = 0;
                mealRetry = tick + 45;
                return false;
            }
            ItemStack hand = c.player.getMainHandStack();
            mealItem = hand.getItem();
            mealSlot = slot;
            mealCount = hand.getCount();
            mealStartHunger = hunger;
        }
        status = mealItem == Items.ROTTEN_FLESH ? "eating rotten flesh in an emergency"
            : canRefuelHealing(hunger) ? "eating to recover health" : "eating";
        body.turn(c.player.getYaw(), -50);
        body.holdUse();
        return true;
    }

    private int bestMeal(int hunger) {
        return bestMeal(hunger, null);
    }

    private int bestMeal(int hunger, Predicate<ItemStack> allowed) {
        var inv = c.player.getInventory();
        int best = -1;
        int emergency = -1;
        float score = -1;
        boolean allowFlesh = needsEmergencyFood(hunger);
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inv.getStack(slot);
            if (allowed != null && (stack.isEmpty() || !allowed.test(stack))) continue;
            if (allowFlesh && FLESH_MEAL.test(stack)
                && (emergency < 0 || slot == inv.selectedSlot)) emergency = slot;
            if (!FOOD.test(stack)) continue;
            var food = stack.get(DataComponentTypes.FOOD);
            int useful = Math.min(20 - hunger, food.nutrition());
            float rank = 2 * useful + food.saturation() - 0.25f * (food.nutrition() - useful);
            if (rank > score || rank == score && slot == inv.selectedSlot) {
                best = slot;
                score = rank;
            }
        }
        return best >= 0 ? best : emergency;
    }

    private int foodNutrition() {
        var inv = c.player.getInventory();
        int total = 0;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE && total < FOOD_RESERVE; slot++) {
            ItemStack stack = inv.getStack(slot);
            if (!FOOD.test(stack)) continue;
            var food = stack.get(DataComponentTypes.FOOD);
            if (food != null) total += food.nutrition() * stack.getCount();
        }
        return total;
    }

    private void startForage(Forage purpose, Entity entity, BlockPos bush, Vec3d point, AgentFoodWork.Source source,
                             int duration) {
        forage = purpose;
        forageEntity = entity;
        forageBush = bush;
        foragePoint = point;
        forageOrigin = c.player.getPos();
        animalSighting = purpose == Forage.ANIMAL ? point : null;
        forageUntil = tick + duration;
        forageSeen = tick;
        forageSource = source;
        forageStance = null;
        forageDropStock = null;
        forageAction = forageSwings = 0;
        if (entity instanceof ItemEntity drop) watchMealDrop(drop);
    }

    private void watchMealDrop(ItemEntity drop) {
        forage = Forage.DROP;
        forageEntity = drop;
        foragePoint = drop.getPos();
        forageDropStock = drop.getStack().copy();
        forageDropGrounded = drop.isOnGround();
        forageStance = null;
        forageStock = carriedForageStock();
        forageSeen = tick;
    }

    private int carriedForageStock() {
        var inventory = c.player.getInventory();
        int stock = 0;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inventory.getStack(slot);
            if (matchesForageStock(stack)) stock += stack.getCount();
        }
        return stock;
    }

    private boolean matchesForageStock(ItemStack stack) {
        if (forageDropStock != null) return ItemStack.areItemsAndComponentsEqual(stack, forageDropStock);
        return forageSource == null ? stack.isOf(Items.APPLE) : forageSource.matchesDrop(stack) && FOOD.test(stack);
    }

    private void observeForagePickup() {
        if (forage == null || forage != Forage.DROP && forageAction == 0) return;
        int stock = carriedForageStock();
        int gain = 0;
        if (forageEntity instanceof ItemEntity drop) {
            // Count only stock matching the exact sighting, up to the amount no longer on that entity.
            int remaining = forageDropStock.getCount();
            if (drop.getWorld() == c.world) {
                if (drop.isRemoved()) remaining = 0;
                else if (ItemStack.areItemsAndComponentsEqual(drop.getStack(), forageDropStock))
                    remaining = drop.getStack().getCount();
            }
            gain = AgentFoodWork.ordinaryPickupGain(forageStock, stock, forageDropStock.getCount(), remaining);
        } else {
            // Vanilla can collect the source's food before the first frame showing a loose item.
            gain = Math.max(0, stock - forageStock);
        }
        if (gain > 0) {
            foodPickedUp += gain;
            String item = forageDropStock != null ? Registries.ITEM.getId(forageDropStock.getItem()).toString()
                : forageSource == null ? "minecraft:apple" : forageSource.subject;
            lastFoodPickup = "+" + gain + " from " + item;
            finishForage(12);
        } else forageStock = stock;
    }

    private boolean continueForage(boolean recovering) {
        if (tick >= forageUntil || forageOrigin.squaredDistanceTo(c.player.getPos()) > FOOD_LEASH_SQUARED) return false;
        return switch (forage) {
            case DROP -> collectMealDrop(recovering);
            case BERRIES -> harvestBerries(recovering);
            case ANIMAL -> huntMeal(recovering);
            case GROUND -> reachFoodGround();
            case APPLE_LEAVES -> forageLeaf();
        };
    }

    private void refuseForage() {
        if (forageEntity != null) {
            refusedFoodEntity = forageEntity;
            refusedFoodEntityUntil = tick + 100;
        }
        if (forageBush != null && forage != Forage.APPLE_LEAVES) {
            refusedFoodBlock = forageBush;
            refusedFoodBlockUntil = tick + 100;
        }
        finishForage(4);
    }

    private void finishForage(int delay) {
        forage = null;
        forageEntity = null;
        forageBush = null;
        foragePoint = forageOrigin = animalSighting = null;
        forageSource = null;
        forageDropStock = null;
        forageStance = null;
        forageScan = tick + delay;
    }

    private boolean foodEntityEligible(Entity entity) {
        return entity != refusedFoodEntity || tick >= refusedFoodEntityUntil;
    }

    private boolean foodBlockEligible(BlockHitResult hit) {
        return !hit.getBlockPos().equals(refusedFoodBlock) || tick >= refusedFoodBlockUntil;
    }

    private boolean usableMealDrop(ItemEntity drop) {
        if (drop.cannotPickup() || drop.isTouchingWater() || drop.isInLava() || drop.isOnFire()) return false;
        Entity owner = drop.getOwner();
        if (owner != null && owner != c.player) return false;
        var inventory = c.player.getInventory();
        return inventory.getEmptySlot() >= 0 || inventory.getOccupiedSlotWithRoomForStack(drop.getStack()) >= 0;
    }

    private ItemEntity visibleMealDrop(Predicate<ItemStack> matches, double sight, boolean directed, Vec3d near) {
        var player = c.player.getBoundingBox();
        return body.dropped(matches, sight, drop -> foodEntityEligible(drop) && usableMealDrop(drop)
            && (near == null || drop.getPos().squaredDistanceTo(near) <= 9)
            && AgentFoodWork.dropAction(player, drop.getBoundingBox(), drop.isOnGround(), true, directed)
                != AgentFoodWork.SourceAction.REFUSE).orElse(null);
    }

    private boolean collectMealDrop(boolean recovering) {
        if (!(forageEntity instanceof ItemEntity seen)) return false;
        if (!body.seesDrop(seen, FOOD_SIGHT))
            return forageDropGrounded && reacquireFood("food drop", recovering, 0.12);
        Vec3d pos = seen.getPos();
        if (!usableMealDrop(seen) || !ItemStack.areItemsAndComponentsEqual(seen.getStack(), forageDropStock)
                || forageOrigin.squaredDistanceTo(pos) > FOOD_LEASH_SQUARED) return false;
        if (seen.getStack().getCount() > forageDropStock.getCount()) forageDropStock.setCount(seen.getStack().getCount());
        if (!pos.equals(foragePoint)) forageStance = null;
        foragePoint = pos;
        forageDropGrounded = seen.isOnGround();
        forageSeen = tick;
        boolean dry = !dangerInForageLane(pos.add(0, 0.22, 0));
        return switch (AgentFoodWork.dropAction(c.player.getBoundingBox(), seen.getBoundingBox(),
                forageDropGrounded, dry, recovering)) {
            case APPROACH -> {
                if (forageStance == null)
                    forageStance = AgentFoodWork.dropStance(seen.getBoundingBox(), c.player.getHeight());
                yield approachFood(forageStance);
            }
            case CONTACT -> {
                var result = body.pickUpVisible(seen, null, false);
                foodStatus("collecting visible " + Registries.ITEM.getId(forageDropStock.getItem()), recovering);
                yield result != AgentBody.PickupResult.BLOCKED;
            }
            case REFUSE -> false;
        };
    }

    private boolean lookForMealDrop() {
        ItemEntity food = visibleMealDrop(this::matchesForageStock, 6, true, foragePoint);
        if (food == null) return false;
        watchMealDrop(food);
        forageUntil = Math.max(forageUntil, tick + 26);
        return true;
    }

    private boolean harvestBerries(boolean recovering) {
        if (forageAction != 0 && lookForMealDrop()) return collectMealDrop(recovering);
        BlockHitResult hit = perceive(foragePoint, FOOD_SIGHT);
        boolean visible = hit != null && hit.getBlockPos().equals(forageBush);
        if (forageAction != 0 && (!visible || AgentFoodWork.ripe(state(hit)) != forageSource)) {
            if (tick - forageAction > 18) return false;
            body.pauseWork();
            foodStatus("waiting for the visible berry harvest", recovering);
            return true;
        }
        if (!visible) return reacquireFood("berry plant", recovering, 0);
        if (AgentFoodWork.ripe(state(hit)) != forageSource) return false;
        forageSeen = tick;
        double reach = Math.min(REACH, c.player.getBlockInteractionRange()) - 0.08;
        boolean inReach = c.player.getEyePos().squaredDistanceTo(hit.getPos()) <= reach * reach;
        boolean dry = state(hit).getFluidState().isEmpty();
        return switch (AgentFoodWork.sourceAction(dry, inReach, recovering)) {
            case APPROACH -> approachFood(Vec3d.ofBottomCenter(forageBush), 2);
            case CONTACT -> {
                body.aimContact(hit, AgentBody.Contact.INTERACT);
                if ((forageAction == 0 || tick - forageAction >= 9) && body.useContact(hit, AgentBody.Contact.INTERACT)) {
                    if (forageAction == 0) forageStock = carriedForageStock();
                    forageAction = tick;
                }
                foodStatus("harvesting visible ripe berries", recovering);
                yield true;
            }
            case REFUSE -> false;
        };
    }

    private boolean huntMeal(boolean recovering) {
        if (forageAction != 0 && lookForMealDrop()) return collectMealDrop(recovering);
        Entity animal = body.visibleEntity(candidate -> candidate == forageEntity
            && AgentFoodWork.adult(candidate) == forageSource, FOOD_SIGHT).orElse(null);
        if (animal == null) {
            return reacquireFood(forageAction == 0 ? "adult " + forageSource.subject : "meat drops", recovering,
                forageAction == 0 ? 0.65 : 0.1);
        }
        Vec3d pos = animal.getPos();
        if (forageOrigin.squaredDistanceTo(pos) > FOOD_LEASH_SQUARED
                || animalSighting.squaredDistanceTo(pos) > WOUNDED_CHASE_SQUARED
                || recovering && forageSwings >= CRITICAL_HUNT_SWINGS) return false;
        foragePoint = pos;
        forageSeen = tick;
        Vec3d point = animal.getBoundingBox().getCenter();
        boolean dry = dryPrey(animal) && !dangerInForageLane(pos.add(0, 0.18, 0));
        return switch (AgentFoodWork.huntAction(c.player.getEyePos().squaredDistanceTo(point),
                huntReach(), dry, recovering)) {
            case APPROACH -> approachFood(pos, Math.min(2, huntReach() * 0.72));
            case CONTACT -> {
                int weapon = huntingWeapon(recovering);
                if (weapon < 0) yield false;
                foodStatus("hunting visible adult " + forageSource.subject, recovering);
                body.aim(point);
                if (!hands.equipSlot(weapon)) yield hands.busy();
                if (body.renderedMeleeStrike(animal) && c.player.getAttackCooldownProgress(0.5f) >= 0.9f) {
                    if (forageAction == 0) forageStock = carriedForageStock();
                    body.strike(animal);
                    forageAction = tick;
                    forageSwings++;
                }
                yield true;
            }
            case REFUSE -> false;
        };
    }

    private double huntReach() { return Math.min(2.8, c.player.getEntityInteractionRange() - 0.1); }

    private boolean criticalHuntContact(Entity animal) {
        return AgentFoodWork.criticalHuntContact(c.player.getEyePos().squaredDistanceTo(animal.getBoundingBox().getCenter()),
            huntReach(), dryPrey(animal));
    }

    private boolean dryPrey(Entity animal) {
        return animal.isOnGround() && !animal.isTouchingWater() && !animal.isOnFire() && !animal.isInLava()
            && !animal.hasVehicle() && !animal.hasPassengers();
    }

    private boolean safeLeafFace(BlockHitResult leaf, BlockPos foot) {
        BlockPos at = leaf.getBlockPos();
        return !leaf.isInsideBlock() && at.getY() <= foot.getY() + 2
            && AgentFoodWork.leafClearOfStance(foot, c.player.getBoundingBox(), at)
            && !surfaceApproach.protectedCanopyLeaf(at);
    }

    private boolean collectibleLeaf(BlockHitResult leaf, BlockPos foot) {
        if (!safeLeafFace(leaf, foot)) return false;
        BlockPos at = leaf.getBlockPos();
        int x = at.getX(), z = at.getZ(), feetY = foot.getY();
        int sideways = Math.abs(x - foot.getX()) + Math.abs(z - foot.getZ());
        Box player = c.player.getBoundingBox();
        // Above the actual tread or within the envelope of a nearby falling item.
        if ((sideways == 0 || at.getY() >= feetY + 2) && AgentFoodWork.appleCatch(player, x, feetY, z)) return true;
        if (sideways != 1) return false;
        for (int y = Math.min(at.getY(), feetY + 1); y >= feetY - 1; --y) {
            appleCatchProbe.set(x, y, z);
            if (body.ordinaryRouteTop(appleCatchProbe, 6)
                    && (AgentFoodWork.appleCatch(player, x, y, z)
                        || body.ordinaryRouteLane(foot, appleCatchProbe) == AgentBody.DryRouteVeto.CLEAR))
                return true;
        }
        return false;
    }

    private BlockHitResult visibleAppleLeaf(BlockPos foot, BlockPos except, boolean started) {
        double reach = Math.min(REACH, c.player.getBlockInteractionRange()) - 0.10;
        return body.find(AgentFoodWork::appleLeaf, reach, hit -> !hit.getBlockPos().equals(except)
            && (!started || appleStand.canTry(hit.getBlockPos(), tick)) && collectibleLeaf(hit, foot)).orElse(null);
    }

    private boolean findAppleStand(BlockPos foot) {
        if (!appleStand.canStart(foot, tick) || c.options.attackKey.isUnbound()
                || !body.ordinaryRouteContact(foot) || appleHand() < 0) return false;
        BlockHitResult first = visibleAppleLeaf(foot, null, false);
        if (first == null || visibleAppleLeaf(foot, first.getBlockPos(), false) == null) return false;
        appleStand.start(foot, tick);
        startForage(Forage.APPLE_LEAVES, null, first.getBlockPos(), first.getPos(), null,
            AgentFoodWork.AppleStand.STAND_TICKS);
        appleStand.tryFace(first.getBlockPos(), tick);
        return true;
    }

    private int appleHand() {
        var inventory = c.player.getInventory();
        if (inventory.getMainHandStack().isEmpty()) return inventory.selectedSlot;
        for (int slot = 0; slot < PlayerInventory.HOTBAR_SIZE; slot++) {
            if (inventory.getStack(slot).isEmpty() && hands.canEquipSlot(inventory, slot)) return slot;
        }
        return -1;
    }

    private boolean forageLeaf() {
        BlockPos foot = c.player.getBlockPos();
        if (!appleStand.active(foot, tick) || !hands.stableCraftFooting() || !body.ordinaryRouteContact(foot)) return false;
        int slot = appleHand();
        if (slot < 0) return false;
        BlockHitResult leaf = perceive(foragePoint, REACH);
        boolean visible = leaf != null && leaf.getBlockPos().equals(forageBush) && AgentFoodWork.appleLeaf(state(leaf));
        if (!visible || appleStand.faceExpired(tick)) {
            if (!visible && forageAction != 0 && tick - forageAction <= 12) {
                holdHealing("checking for a real apple drop before cutting another face");
                return true;
            }
            if (!visible && forageAction == 0 && !appleStand.faceExpired(tick) && tick - forageSeen <= 5)
                return reacquireFood("apple-bearing leaves", true, 0);
            leaf = visibleAppleLeaf(foot, null, true);
            if (leaf == null) return false;
            forageBush = leaf.getBlockPos();
            foragePoint = leaf.getPos();
            forageAction = 0;
            appleStand.tryFace(forageBush, tick);
        }
        if (!safeLeafFace(leaf, foot)) return false;
        forageSeen = tick;
        healingStatus("foraging visible apple-bearing leaves from this dry tread (face " + appleStand.attempted() + ")");
        if (!hands.equipSlot(slot)) return hands.busy();
        if (body.mine(leaf)) {
            if (forageAction == 0) forageStock = carriedForageStock();
            forageAction = tick;
        }
        return true;
    }

    private boolean reacquireFood(String source, boolean recovering, double height) {
        if (!recovering || tick - forageSeen > (forageAction == 0 ? 16 : 24)) return false;
        body.aim(height == 0 ? foragePoint : foragePoint.add(0, height, 0));
        healingStatus("rechecking the last visible " + source);
        return true;
    }

    private String forageLabel() {
        return switch (forage) {
            case DROP -> Registries.ITEM.getId(forageDropStock.getItem()).toString();
            case ANIMAL, BERRIES -> forageSource.subject;
            case GROUND -> "visible lower foraging ground";
            case APPLE_LEAVES -> "apple-bearing leaves";
        };
    }

    private boolean approachFood(Vec3d point, double arrival) {
        var result = navigateFood(point, arrival);
        return result == AgentOrdinaryNavigator.Result.MOVING || result == AgentOrdinaryNavigator.Result.OBSERVING;
    }

    private boolean approachFood(AgentResourceStance stance) {
        var result = navigateFood(stance.point(), stance.arrival(), stance);
        return result == Result.MOVING || result == Result.OBSERVING;
    }

    private boolean reachFoodGround() {
        var result = navigateFood(forageStance.point(), forageStance.arrival(), forageStance);
        if (result == Result.ARRIVED) {
            lastFoodVantage = c.player.getBlockPos();
            finishForage(0);
            healingStatus("reached the visible lower foraging ground");
        }
        return result != Result.BLOCKED;
    }

    private Result navigateFood(Vec3d point, double arrival) {
        return navigateFood(point, arrival, null);
    }

    private Result navigateFood(Vec3d point, double arrival, AgentResourceStance stance) {
        foodTravelTick = tick;
        foodTravelTarget = point;
        foodTravelArrival = arrival;
        foodTravelBand = stance;
        Result result = foodTravelResult = stance == null ? navigate(Job.FOOD, point, arrival) : navigate(Job.FOOD, stance);
        if (point == null && ordinaryArrival != null) lastFoodVantage = ordinaryArrival.to();
        String detail = point == null ? "scouting for food"
            : forage == null ? "settling after a food approach" : "approaching " + forageLabel();
        healingStatus(detail + " (" + navigator.status() + ")");
        return result;
    }

    private void foodStatus(String detail, boolean recovering) {
        if (recovering) healingStatus(detail);
        else status = detail;
    }

    private boolean dangerInForageLane(Vec3d point) {
        BlockHitResult hit = perceive(point, c.player.getEyePos().distanceTo(point) + 0.1);
        return hit != null && dangerous(state(hit));
    }

    private int huntingWeapon(boolean allowImprovised) {
        int slot = huntingWeaponSlot(false);
        return slot < 0 && allowImprovised ? huntingWeaponSlot(true) : slot;
    }

    private int huntingWeaponSlot(boolean improvised) {
        var inv = c.player.getInventory();
        int best = -1;
        double damage = 0;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inv.getStack(slot);
            if (improvised ? !AgentFoodWork.improvisedWeapon(stack)
                : (!AXE.test(stack) && !stack.isIn(ItemTags.SWORDS)) || stack.getMaxDamage() - stack.getDamage() < 2)
                continue;
            var attributes = stack.get(DataComponentTypes.ATTRIBUTE_MODIFIERS);
            if (attributes == null) continue;
            for (var entry : attributes.modifiers()) {
                if (!entry.attribute().equals(EntityAttributes.ATTACK_DAMAGE)
                    || !entry.slot().matches(EquipmentSlot.MAINHAND)) continue;
                double rank = entry.modifier().value();
                if (rank > damage || rank == damage && slot == inv.selectedSlot) {
                    damage = rank;
                    best = slot;
                }
            }
        }
        return best;
    }

    private void explore() {
        if (ordinarySurfaceWork && !c.player.isTouchingWater() && !c.player.hasVehicle()) {
            if (safePickupStance()) navigate(Job.EXPLORE, null, 0);
            return;
        }
        Vec3d feet = c.player.getPos();
        if (Float.isNaN(heading)) heading = c.player.getYaw();
        if (sweepOrigin != null && horizontalDistance(feet, sweepOrigin) > 2) sweepOrigin = null;
        if (tick >= headingUntil) {
            if (headingUntil != 0 && sweepOrigin == null) heading += (++turns % 2 == 0 ? -1 : 1) * 24;
            headingUntil = tick + 460;
        }
        if (step(forward(heading), sweepOrigin == null, true) == Walk.BLOCKED) {
            if (sweepOrigin == null) {
                sweepOrigin = feet;
                sweepHeading = heading;
                sweepIndex = 0;
            }
            if (sweepIndex >= SCOUT_HEADINGS.length) {
                if (trail.size() <= 1 || !beginReturn())
                    startExitRecovery(directional(forward(sweepHeading)));
                sweepOrigin = null;
                return;
            }
            heading = sweepHeading + SCOUT_HEADINGS[sweepIndex++];
            headingUntil = tick + 270;
            routeLegStart = null;
            directClearTicks = poorFootTicks = 0;
        }
    }

    private Walk walkToward(Vec3d point, boolean sprint, boolean allowWater) {
        return walkToward(point, sprint, allowWater, false);
    }

    private Walk walkToward(Vec3d point, boolean sprint, boolean allowWater, boolean levelOnly) {
        Vec3d horizontal = point.subtract(c.player.getPos()).multiply(1, 0, 1);
        if (horizontal.horizontalLengthSquared() < 0.015) return Walk.BLOCKED;
        return step(horizontal.normalize(), sprint, allowWater, levelOnly);
    }

    /** Advance toward the target along a lane selected from the present view. */
    private Walk approachOrdinary(BlockHitResult witness, Vec3d point, double arrival, boolean wade) {
        Vec3d feet = c.player.getPos();
        boolean continuing = ordinaryApproach != null && ordinaryApproachTick == tick - 1
            && ordinaryApproach.allowWade == wade && ordinaryApproach.arrival == arrival
            && horizontalDistance(point, ordinaryApproach.goal) < 0.55;
        if (!continuing) {
            var cue = witness == null ? null : body.visibleHorizon().target(witness);
            if (cue == null || horizontalDistance(cue.point(), point) > 0.85) return Walk.BLOCKED;
            // Use the ray's bearing, not the stored block center or an unseen adjacent stance.
            ordinaryApproach = new AgentBody.HorizonTravel(cue, new Vec3d(cue.point().x, feet.y, cue.point().z),
                arrival, wade);
            stallGuard.ordinarySetup();
        }
        ordinaryApproachTick = tick;
        return switch (body.driveHorizon(ordinaryApproach, false, false)) {
            case MOVING -> {
                rememberMotion();
                yield Walk.MOVING;
            }
            case SETTLING -> Walk.LOOKING;
            case ARRIVED, BLOCKED -> {
                body.stopHorizonTravel(ordinaryApproach);
                ordinaryApproach = null;
                yield Walk.BLOCKED;
            }
        };
    }

    private Walk approach(Vec3d point, boolean sprint, boolean allowWater) {
        return approach(point, sprint, allowWater, false);
    }

    private Walk approach(Vec3d point, boolean sprint, boolean allowWater, boolean levelOnly) {
        Vec3d feet = c.player.getPos();
        double distance = feet.distanceTo(point);
        if (approachGoal == null || horizontalDistance(point, approachGoal) > 1.15) {
            approachGoal = point;
            routeTick = -10;
            approachNearest = distance;
            approachDeadline = tick + 185;
        } else if (distance < approachNearest - 0.55) {
            approachNearest = distance;
            approachDeadline = tick + 185;
        }
        if (tick >= approachDeadline) return Walk.BLOCKED;
        double sprintDistance = c.player.isSprinting() ? 4 : 5.5;
        return walkToward(point, !levelOnly && (horizontalDistance(feet, point) > sprintDistance
            || sprint && distance > sprintDistance), allowWater, levelOnly);
    }

    /** Fix the gaze on a short route ahead; keep movement contingent on freshly observed footing. */
    private Walk step(Vec3d horizontal, boolean sprint, boolean allowWater) {
        return step(horizontal, sprint, allowWater, false);
    }

    private Walk step(Vec3d horizontal, boolean sprint, boolean allowWater, boolean levelOnly) {
        Vec3d feet = c.player.getPos();
        float requested = yaw(horizontal);
        boolean landingInProgress = !c.player.isOnGround() && !c.player.isTouchingWater()
            && tick - descentTick <= 10;
        if (Float.isNaN(routeRequest) || !landingInProgress && bearingDistance(requested, routeRequest) > 50
            || tick - routeTick > 2 || routeWorld != c.world) {
            routeRequest = routeYaw = requested;
            routeWorld = c.world;
            routeLegStart = null;
            rejectedRouteUntil = directClearTicks = 0;
            descentTick = -10;
            landingInProgress = false;
            routeLanding = lookAhead = null;
            cruisePitch = CRUISE_PITCH;
            inspectingFooting = false;
            poorFootTicks = clearFootTicks = 0;
            sprintClearTick = -10;
        }
        routeTick = tick;
        float facing = c.player.getYaw();
        if (!landingInProgress) {
            if (routeLegStart != null && c.player.isOnGround()
                && horizontalDistance(feet, routeLegStart) >= 1.15 && bearingDistance(routeYaw, facing) <= 8) {
                Footing direct = footing(feet, horizontal, requested, allowWater);
                directClearTicks = ordinaryFooting(direct) ? directClearTicks + 1 : 0;
                if (directClearTicks >= 3) {
                    routeLegStart = null;
                    poorFootTicks = 0;
                }
            } else directClearTicks = 0;
            // Keep a deliberate line; only correct the bearing once the target has shifted visibly.
            if (routeLegStart == null && bearingDistance(requested, routeYaw) > 3) routeYaw = requested;
        } else directClearTicks = 0;
        Vec3d lane = forward(routeYaw);
        Footing planned = footing(feet, lane, routeYaw, allowWater);
        planned = refreshLanding(planned, feet, lane, allowWater);
        BlockHitResult plannedLanding = observedLanding;
        boolean unsure = planned == Footing.UNKNOWN || planned == Footing.EDGE;
        boolean aligned = bearingDistance(routeYaw, facing) <= 8;
        boolean stalled = stuck >= 13;
        if (!landingInProgress && aligned && (stalled || planned == Footing.BLOCKED
                || unsure && poorFootTicks >= 13 && !recentLanding(feet, lane))) {
            // Compare off-center lanes in the same view, before turning toward any of them.
            double best = Double.NEGATIVE_INFINITY;
            float candidate = routeYaw;
            for (float offset : SIDE_LANES) {
                float bearing = requested + offset;
                if (bearingDistance(bearing, routeYaw) < 12 || bearingDistance(bearing, facing) > 64
                    || tick < rejectedRouteUntil && bearingDistance(bearing, rejectedRouteYaw) < 14) continue;
                Vec3d other = forward(bearing);
                Footing ground = footing(feet, other, bearing, allowWater);
                BlockHitResult landing = observedLanding;
                int quality = switch (ground) {
                    case LEVEL -> 5;
                    case DOWN -> 4;
                    case STEEP, JUMP -> 2;
                    case WATER -> 1;
                    default -> -1;
                };
                if (quality < 0 || levelOnly && ground != Footing.LEVEL) continue;
                double score = quality - 0.045 * bearingDistance(bearing, facing)
                    - 0.020 * Math.abs(offset);
                if (supportAhead(feet, other, 3.6, 2.15, 1.65) != null) score += 1.5;
                if (score > best) {
                    best = score;
                    candidate = bearing;
                    planned = ground;
                    plannedLanding = landing;
                }
            }
            if (candidate != routeYaw) {
                rejectedRouteYaw = routeYaw;
                rejectedRouteUntil = tick + 24;
                routeYaw = candidate;
                routeLegStart = feet;
                directClearTicks = poorFootTicks = 0;
                lane = forward(routeYaw);
            } else if (stalled) return Walk.BLOCKED;
        }
        double turn = bearingDistance(routeYaw, facing);
        boolean keepLookAhead = lookAhead != null && tick - lookAheadTick <= 16
            && inLane(feet, lane, lookAhead, 2.8, 6.2, 0.95);
        if (!keepLookAhead) {
            BlockHitResult distant = horizon(feet, lane);
            lookAhead = distant == null ? null : distant.getPos();
            if (lookAhead != null) {
                lookAheadTick = tick;
                float pitch = (float) MathHelper.clamp(Math.toDegrees(Math.atan2(
                    c.player.getEyeY() - lookAhead.y, horizontalDistance(feet, lookAhead))), 25, 32);
                if (Math.abs(cruisePitch - pitch) >= 2) cruisePitch = pitch;
            }
        }
        if (turn > 16) {
            body.lookAlongGait(routeYaw, inspectingFooting ? INSPECT_PITCH : cruisePitch);
            return Walk.LOOKING;
        }

        // W follows actual facing during a smooth turn, not the intended bearing.
        Vec3d actualLane = turn < 3 ? lane : forward(facing);
        Footing actual = planned;
        BlockHitResult landing = plannedLanding;
        if (turn >= 3) {
            actual = footing(feet, actualLane, facing, allowWater);
            actual = refreshLanding(actual, feet, actualLane, allowWater);
            landing = observedLanding;
        }
        if (landing != null) {
            routeLanding = landing.getPos();
            routeLandingTick = tick;
        } else if (actual == Footing.BLOCKED || actual == Footing.WATER || actual == Footing.JUMP) {
            routeLanding = null;
        }
        boolean needsFooting = actual == Footing.UNKNOWN || actual == Footing.EDGE;
        if (!levelOnly && needsFooting && !landingInProgress && turn <= 5 && body.continueSurfaceStep(facing)) {
            rememberMotion();
            body.lookAlongGait(routeYaw, inspectingFooting ? INSPECT_PITCH : cruisePitch);
            return Walk.MOVING;
        }
        poorFootTicks = needsFooting ? poorFootTicks + 1 : 0;
        clearFootTicks = ordinaryFooting(actual) ? clearFootTicks + 1 : 0;
        if (!inspectingFooting && (actual == Footing.STEEP
                || poorFootTicks >= 5 && !recentLanding(feet, actualLane))) {
            inspectingFooting = true;
            inspectUntil = tick + 16;
        } else if (inspectingFooting && tick >= inspectUntil && clearFootTicks >= 8) {
            inspectingFooting = false;
        }
        body.lookAlongGait(routeYaw, inspectingFooting ? INSPECT_PITCH : cruisePitch);
        // A separate witnessed route or tread owns any level change while a return is owed.
        if (levelOnly && actual != Footing.LEVEL)
            return turn > 5 || needsFooting && poorFootTicks < 25 ? Walk.LOOKING : Walk.BLOCKED;
        if (actual == Footing.BLOCKED && (landingInProgress || turn > 5)) return Walk.LOOKING;
        if (actual == Footing.BLOCKED) return Walk.BLOCKED;
        if (actual == Footing.UNKNOWN) {
            return !landingInProgress && poorFootTicks >= 25 && c.player.getPitch() >= INSPECT_PITCH - 4
                ? Walk.BLOCKED : Walk.LOOKING;
        }
        if (actual == Footing.EDGE) {
            // An intermittent near hit is not yet a reason to switch posture.
            if (landingInProgress || turn > 5 || poorFootTicks < 4) return Walk.LOOKING;
            body.sneak();
            walk(false);
            return Walk.MOVING;
        }
        if ((actual == Footing.DOWN || actual == Footing.STEEP) && c.player.isOnGround()) descentTick = tick;
        if (actual == Footing.JUMP || c.player.isTouchingWater()) body.jump();
        // The close proof below is stronger than Body's conservative pitch-dependent edge heuristic.
        boolean running = sprint && ordinaryFooting(actual) && turn <= (c.player.isSprinting() ? 11 : 7)
            && !body.hazardAhead(facing, 3.4) && sprintLane(feet, actualLane, landing == null ? null : landing.getPos());
        if (actual == Footing.LEVEL && !running && turn <= 5) body.rememberSurfaceStep(landing);
        walkDown(running);
        return Walk.MOVING;
    }

    private static float bearingDistance(float a, float b) {
        return Math.abs(MathHelper.wrapDegrees(a - b));
    }

    private static boolean ordinaryFooting(Footing ground) {
        return ground == Footing.LEVEL || ground == Footing.DOWN;
    }

    private BlockHitResult horizon(Vec3d feet, Vec3d lane) {
        return supportAhead(feet, lane, 5.4, 3.15, 2.4);
    }

    private BlockHitResult supportAhead(Vec3d feet, Vec3d lane, double distance, double minimum, double depth) {
        Vec3d ahead = feet.add(lane.multiply(distance));
        Vec3d eye = c.player.getEyePos();
        int probes = depth > 2 ? 3 : 2;
        for (int i = 0; i < probes; i++) {
            Vec3d point = ahead.add(0, i == 0 ? -0.55 : i < probes - 1 ? -1.55 : -depth, 0);
            BlockHitResult floor = terrain(point, eye.distanceTo(point) + 0.2);
            if (floor == null) continue;
            BlockState state = state(floor);
            if (dangerous(state) || !state.getFluidState().isEmpty()) return null;
            if (floor.getSide() == Direction.UP && inLane(feet, lane, floor.getPos(), minimum, distance + 0.2, 0.15)
                && safeSupport(floor)) return floor;
        }
        return null;
    }

    private boolean sprintLane(Vec3d feet, Vec3d lane, Vec3d landing) {
        var player = c.player;
        boolean running = player.isSprinting();
        if (landing == null || !running && !player.isOnGround()
            || player.isUsingItem() || player.isSneaking() || player.horizontalCollision
            || player.getHealth() < (running ? 12 : 14)) return false;
        int hunger = player.getHungerManager().getFoodLevel();
        int reserve = running ? 17 : 18;
        if (hunger < reserve && (hunger < reserve - 2 || !has(FOOD, 1))) return false;
        // Prove a practical braking corridor, not the entire horizon. At a walkable
        // 1-block drop the floor can be visible while far shoulder-height air is outside the frame.
        BlockHitResult corridor = supportAhead(feet, lane, 3.8, 2.05, 1.75);
        if (corridor == null) return false;
        Vec3d floor = corridor.getPos();
        double drop = landing.y - floor.y;
        if (drop < -0.36 || drop > 1.12 || feet.y - floor.y > 1.20) return false;
        Vec3d chest = floor.add(0, 1.25, 0);
        double rightX = 0.34 * lane.z;
        double rightZ = -0.34 * lane.x;
        if (!body.clearTerrain(chest.add(rightX, 0, rightZ))
            || !body.clearTerrain(chest.add(-rightX, 0, -rightZ))) return false;
        if (tick - sprintClearTick > 1) sprintClearFrom = tick;
        sprintClearTick = tick;
        return running || tick - sprintClearFrom >= 2;
    }

    private boolean recentLanding(Vec3d feet, Vec3d lane) {
        return routeLanding != null && tick - routeLandingTick <= 8
            && inLane(feet, lane, routeLanding, 0.58, 1.86, 0.38);
    }

    private static boolean inLane(Vec3d feet, Vec3d lane, Vec3d point, double near, double far, double width) {
        double x = point.x - feet.x;
        double z = point.z - feet.z;
        double forward = x * lane.x + z * lane.z;
        return forward >= near && forward <= far && Math.abs(x * lane.z - z * lane.x) <= width;
    }

    private Footing refreshLanding(Footing footing, Vec3d feet, Vec3d lane, boolean allowWater) {
        if ((footing != Footing.UNKNOWN && footing != Footing.EDGE) || !recentLanding(feet, lane)) return footing;
        // Retry the same world-space point; only a new, camera-admitted ray can authorize a step.
        Vec3d point = routeLanding.add(0, -0.045, 0);
        BlockHitResult floor = terrain(point, c.player.getEyePos().distanceTo(point) + 0.10);
        if (floor == null) return footing;
        BlockState state = state(floor);
        if (dangerous(state)) return Footing.BLOCKED;
        if (state.getFluidState().isIn(FluidTags.WATER)) return allowWater ? Footing.WATER : Footing.BLOCKED;
        Vec3d hit = floor.getPos();
        if (floor.getSide() != Direction.UP || !safeSupport(floor) || hit.squaredDistanceTo(routeLanding) > 0.09) {
            return footing;
        }
        Footing observed = dropFooting(feet.y - hit.y, horizontalDistance(feet, hit));
        if (observed == Footing.UNKNOWN) return footing;
        observedLanding = floor;
        return observed;
    }

    private Footing footing(Vec3d feet, Vec3d heading, float bearing, boolean allowWater) {
        observedLanding = null;
        if (body.hazardAhead(bearing, 2.3)) return Footing.BLOCKED;
        if (c.player.isOnGround() && c.player.horizontalCollision && body.jumpBlocked(bearing)) return Footing.BLOCKED;
        BlockHitResult head = terrain(feet.add(heading.multiply(1.55)).add(0, 1.32, 0), 1.58);
        if (head != null && (dangerous(state(head)) || solid(head))) return Footing.BLOCKED;
        BlockHitResult shin = terrain(feet.add(heading.multiply(1.55)).add(0, 0.32, 0), 1.95);
        if (shin != null && dangerous(state(shin))) return Footing.BLOCKED;
        if (c.player.isTouchingWater()) {
            return Footing.WATER;
        }
        if (shin != null && shin.getPos().getY() > feet.getY() + 0.07 && solid(shin)) {
            double top = shin.getBlockPos().getY() + 1;
            double height = top - feet.getY();
            if (height > 1.05) return Footing.BLOCKED;
            // A deep probe can strike the riser from below and hide a genuinely visible top.
            Vec3d stepTop = Vec3d.ofCenter(shin.getBlockPos(), 0.95);
            BlockHitResult landing = terrain(stepTop, c.player.getEyePos().distanceTo(stepTop) + 0.12);
            if (landing == null || !landing.getBlockPos().equals(shin.getBlockPos())
                || landing.getSide() != Direction.UP || !safeSupport(landing)) return Footing.UNKNOWN;
            Vec3d upper = feet.add(heading.multiply(1.55)).add(0, 2.35, 0);
            BlockHitResult ceiling = terrain(upper, c.player.getEyePos().distanceTo(upper));
            return ceiling == null && !body.jumpBlocked(bearing) ? Footing.JUMP : Footing.BLOCKED;
        }
        Vec3d eye = c.player.getEyePos();
        Footing result = Footing.UNKNOWN;
        BlockHitResult bestLanding = null;
        double bestAhead = Double.POSITIVE_INFINITY;
        for (int i = 0; i < FLOOR_FORWARD.length; ++i) {
            Vec3d point = feet.add(heading.multiply(FLOOR_FORWARD[i])).add(0, -FLOOR_BELOW[i], 0);
            BlockHitResult floor = terrain(point, eye.distanceTo(point) + 0.16);
            if (floor == null) continue;
            BlockState state = state(floor);
            if (dangerous(state)) return Footing.BLOCKED;
            double ahead = horizontalDistance(feet, floor.getPos());
            if (ahead < 0.31 || ahead > 1.86) continue;
            if (state.getFluidState().isIn(FluidTags.WATER)) {
                return allowWater ? Footing.WATER : Footing.BLOCKED;
            }
            if (floor.getSide() != Direction.UP || !safeSupport(floor)) continue;
            double drop = feet.getY() - floor.getPos().getY();
            if (ahead < 0.58) {
                if (result == Footing.UNKNOWN && drop < 0.42) result = Footing.EDGE;
                continue;
            }
            Footing observed = dropFooting(drop, ahead);
            if (observed == Footing.UNKNOWN) continue;
            Vec3d hit = floor.getPos();
            // A lower visible landing warns of descent even if a shallower ray saw the upper lip.
            if (bestLanding == null || hit.y < bestLanding.getPos().y
                || hit.y == bestLanding.getPos().y && ahead < bestAhead) {
                bestLanding = floor;
                bestAhead = ahead;
                result = observed;
            }
        }
        observedLanding = bestLanding;
        return result;
    }

    private Footing dropFooting(double drop, double ahead) {
        // A large drop requires a visible immediate landing, not a distant opposite bank.
        if (drop > 2.65 || drop > 1.05 && ahead > 1.65) return Footing.UNKNOWN;
        return drop > 1.05 ? Footing.STEEP : drop > 0.42 ? Footing.DOWN : Footing.LEVEL;
    }

    private void trackMotion() {
        if (motionTick == tick - 1 && motionPosition != null) {
            if (horizontalDistance(motionPosition, c.player.getPos()) < 0.026) stuck++;
            else stuck = 0;
        } else {
            stuck = 0;
        }
    }

    private void walk(boolean sprint) {
        body.walk(sprint);
        rememberMotion();
    }

    private void walkDown(boolean sprint) {
        body.walkDown(sprint);
        rememberMotion();
    }

    private void rememberMotion() {
        motionTick = tick;
        motionPosition = c.player.getPos();
    }

    private boolean arrived(BlockPos position) {
        return position.equals(c.player.getBlockPos()) && c.player.isOnGround();
    }

    private boolean has(Predicate<ItemStack> predicate, int count) {
        return hands.count(predicate) >= count;
    }

    private BlockHitResult perceive(Vec3d point, double range) {
        return body.perceive(point, range).orElse(null);
    }

    private BlockHitResult terrain(Vec3d point, double range) {
        return body.terrain(point, range).orElse(null);
    }

    /** Only use with a ray hit admitted by the current camera, never with a remembered position. */
    private BlockState state(BlockHitResult hit) {
        return c.world.getBlockState(hit.getBlockPos());
    }

    private boolean solid(BlockHitResult hit) {
        BlockState state = state(hit);
        return !state.isReplaceable() && state.getFluidState().isEmpty();
    }

    private boolean safeSupport(BlockHitResult hit) {
        BlockState state = state(hit);
        return !dangerous(state) && state.getFluidState().isEmpty() && !state.isReplaceable()
            && !state.isIn(BlockTags.CLIMBABLE);
    }

    static boolean dangerous(BlockState state) {
        return state.getFluidState().isIn(FluidTags.LAVA) || state.isOf(Blocks.FIRE)
            || state.isOf(Blocks.SOUL_FIRE) || state.isOf(Blocks.MAGMA_BLOCK) || state.isOf(Blocks.CACTUS)
            || state.isOf(Blocks.SWEET_BERRY_BUSH) || state.isOf(Blocks.CAMPFIRE) || state.isOf(Blocks.SOUL_CAMPFIRE)
            || state.isOf(Blocks.POWDER_SNOW) || state.isOf(Blocks.POINTED_DRIPSTONE);
    }

    private static Predicate<ItemStack> item(Item item) {
        return stack -> stack.isOf(item);
    }

    private static double horizontalDistance(Vec3d a, Vec3d b) {
        double x = a.getX() - b.getX();
        double z = a.getZ() - b.getZ();
        return Math.sqrt(x * x + z * z);
    }

    private static float yaw(Vec3d direction) {
        return (float) Math.toDegrees(MathHelper.atan2(-direction.getX(), direction.getZ()));
    }

    private static Direction directional(Vec3d delta) {
        if (Math.abs(delta.x) > Math.abs(delta.z)) return delta.x > 0 ? Direction.EAST : Direction.WEST;
        return delta.z > 0 ? Direction.SOUTH : Direction.NORTH;
    }

    private static Vec3d forward(float yaw) {
        double radians = Math.toRadians(yaw);
        return new Vec3d(-Math.sin(radians), 0, Math.cos(radians));
    }
}
