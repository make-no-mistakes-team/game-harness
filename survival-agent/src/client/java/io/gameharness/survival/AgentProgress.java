package io.gameharness.survival;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;
import java.util.function.Supplier;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.CaveVines;
import net.minecraft.block.LeavesBlock;
import net.minecraft.block.SweetBerryBushBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityPose;
import net.minecraft.entity.EntityType;
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
    private static final int KIT_WOOD_PICK = 1, KIT_STONE_PICK = 1 << 1, KIT_DEEP_PICK = 1 << 2;
    private static final int KIT_LIGHT = 1 << 3, KIT_IRON = 1 << 4, KIT_STONE = 1 << 5, KIT_WOOD = 1 << 6;
    private static final int KIT_WORKBENCH = 1 << 7, KIT_FURNACE = 1 << 8;
    // Planning for ordinary burnable planks in Java 1.21.4; furnace loading checks the actual stack's fuel value.
    private static final int PLANK_BURN_TICKS = 300;
    private static final int ORE_MEMORY_LIMIT = 18;
    private static final int TIMBER_WORK_TICKS = 190;
    private static final int TIMBER_RECENT = 24;
    private static final Predicate<ItemStack> LOG = stack -> stack.isIn(ItemTags.LOGS);
    private static final Predicate<ItemStack> BURNABLE_LOG = stack -> stack.isIn(ItemTags.LOGS_THAT_BURN);
    private static final Predicate<ItemStack> PLANK = stack -> stack.isIn(ItemTags.PLANKS);
    private static final Predicate<ItemStack> STONE = stack -> stack.isIn(ItemTags.STONE_TOOL_MATERIALS);
    private static final Predicate<ItemStack> FUEL = stack -> stack.isIn(ItemTags.COALS);
    private static final Predicate<ItemStack> STICK = item(Items.STICK);
    private static final Predicate<ItemStack> WOOD_PICK = item(Items.WOODEN_PICKAXE);
    private static final Predicate<ItemStack> STONE_PICK = item(Items.STONE_PICKAXE);
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
    private static final Predicate<ItemStack> BUILDING = stack -> STONE.test(stack) || stack.isOf(Items.DIRT)
        || stack.isOf(Items.COBBLESTONE) || stack.isOf(Items.COBBLED_DEEPSLATE) || PLANK.test(stack);
    private static final Predicate<ItemStack> FOOD = stack -> stack.contains(DataComponentTypes.FOOD)
        && !stack.isOf(Items.ROTTEN_FLESH) && !stack.isOf(Items.SPIDER_EYE)
        && !stack.isOf(Items.POISONOUS_POTATO) && !stack.isOf(Items.PUFFERFISH)
        && !stack.isOf(Items.CHICKEN) && !stack.isOf(Items.SUSPICIOUS_STEW) && !stack.isOf(Items.CHORUS_FRUIT);
    private static final Predicate<BlockState> RIPE_BERRIES = state ->
        state.isOf(Blocks.SWEET_BERRY_BUSH) && state.get(SweetBerryBushBlock.AGE) >= 2
        || (state.isOf(Blocks.CAVE_VINES) || state.isOf(Blocks.CAVE_VINES_PLANT)) && state.get(CaveVines.BERRIES);
    private static final int FOOD_RESERVE = 12; // nutrition points, not stack size
    private static final double FORAGE_LEASH_SQUARED = 36;

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
    enum Dig { LOOKING, CLEAR, BLOCKED, DARK, LIP, RESOURCE }
    private enum Firing { NONE, IRON, CHARCOAL }
    private enum Forage { ANIMAL, BERRIES, DROP }
    private enum WorkshopView {
        CURRENT, GROUND, FIRST_WALL, FIRST_FLOOR, SECOND_WALL, SECOND_FLOOR, EXHAUSTED;

        private static final WorkshopView[] ORDER = values();
        private WorkshopView next() { return ORDER[ordinal() + 1]; }
    }
    private static final Predicate<ItemStack> STATION_OPENING_HAND = stack -> stack.isEmpty()
        || WOOD_PICK.test(stack) || STONE_PICK.test(stack) || DEEP_PICK.test(stack);

    private record OreSight(Resource resource, BlockPos block, Vec3d point, BlockPos stance, Vec3d feet,
                            double rangeSquared) {}

    private record TableReturn(BlockPos workshop, int planks, int sticks) {}

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
    private final AgentTools tools;
    private final AgentStallGuard stallGuard;
    private final AgentOverlandSearch overland;
    private final Runnable stallReplan = this::replanStalledLocalWork;
    private final Supplier<String> stallChoose = this::chooseStallAlternative;
    private final Supplier<AgentStallGuard.Alternative> stallStep = this::workStallAlternative;
    private final Runnable stallRelease = this::releaseStallAlternative;
    private final Set<BlockPos> stallOreTried = new HashSet<>();
    private final Set<BlockPos> stallRouteTried = new HashSet<>();
    private final Set<Integer> stallDropsTried = new HashSet<>();
    private Supplier<AgentStallGuard.Alternative> stallWork;
    private int stallWorkIncident, stallKit;
    private boolean stallTorchTried;
    private final Predicate<BlockPos> protectedHeadroom = this::protectRecoveryBlock;
    private final Predicate<BlockHitResult> returnableOreFace = this::returnableOreReachable;
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
    private TableReturn tableReturn;
    private BlockPos failedTableReturn;
    private Firing firing = Firing.NONE;
    private BlockPos furnaceWitness;
    private FurnaceScreen furnaceScreen;
    private ClientWorld furnaceScreenWorld;
    private int furnaceWarmUntil;
    private int furnaceDemand;
    private boolean furnaceLoaded;
    private boolean furnaceNeedsFuel;
    private boolean furnaceTransferPending;
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
    private Vec3d pickupLook;
    private int pickupBlockedUntil;
    private Predicate<ItemStack> pickupBlockedItem;
    private Entity pickupEntity;
    private Predicate<ItemStack> pickupItem;
    private Vec3d pickupPosition;
    private int pickupCount;
    private int pickupStarted;
    private int pickupSeen;
    private boolean pickupNeedsDetour;
    private boolean timberReady;
    private boolean departureKit;
    private boolean ordinarySurfaceWork;
    private BlockHitResult timberWitness;
    private final Predicate<BlockHitResult> reachableTrunk = hit -> timberCandidate(hit) && timberInReach(hit);
    private BlockPos timberLastCut;
    private final List<BlockPos> exhaustedStems = new ArrayList<>();
    private final List<BlockPos> unreachableTimber = new ArrayList<>();
    private final List<BlockPos> triedTimberFooting = new ArrayList<>();
    private final List<BlockPos> checkedSupplyLandmarks = new ArrayList<>();
    private final List<BlockPos> triedSupplyCuts = new ArrayList<>();
    private BlockPos timberExitFrom;
    private BlockPos timberExitTo;
    private int timberExitUntil;
    private int timberExitCheck;
    private float timberExitYaw;
    private boolean timberHigherShelf;
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
    private int timberApproachSince;
    private final SupplyEgress supplyEgress = new SupplyEgress();
    private Vec3d timberBank;
    private Vec3d timberCanopy;
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
    private BlockPos returnDetour;
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
    private Forage forage;
    private Entity forageEntity;
    private BlockPos forageBush;
    private Vec3d foragePoint, forageOrigin;
    private int forageUntil, forageSeen, forageAction, forageStock, forageFootingWait, forageScan;
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
    private boolean forcedLight;
    private BlockPos darkAttemptFoot;
    private BlockPos pendingStairLight;
    private int pendingStairLightSince, pendingStairTorchCount;
    private BlockPos witnessedStairCut;
    private int witnessedStairCutTick;

    AgentProgress(MinecraftClient c, AgentBody body, AgentHands hands, String goal, AgentMemory memory) {
        this.c = c;
        this.body = body;
        this.hands = hands;
        this.memory = memory;
        tools = new AgentTools(c, hands);
        stallGuard = new AgentStallGuard(c, body, hands, tools, this::protectRecoveryBlock, this::safeSupport,
            this::recordStallFooting, this::tryStallMineHandback);
        overland = new AgentOverlandSearch(c, body, AgentProgress::dangerous);
        caves = new AgentCaves(c, body, hands, tools, this::recordCaveFooting, this::recordDryCaveFooting);
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
        trail.addAll(known);
        int index = trail.lastIndexOf(standing);
        litIndex = index + 1; // Periodic light counts new steps; darkness can still demand a light immediately.
        if (index + 1 < trail.size()) resumeIndex = index + 1;
        digDirection = c.player.getHorizontalFacing();
        useTraveledBearing(index);
        return true;
    }

    void observeMemoryFooting(long observedTick) {
        caves.observeDryContact(observedTick);
        boolean grounded = c.player.isOnGround() && !c.player.isTouchingWater();
        BlockPos standing = c.player.getBlockPos();
        boolean centered = Math.abs(c.player.getX() - standing.getX() - 0.5) <= 0.3
            && Math.abs(c.player.getZ() - standing.getZ() - 0.5) <= 0.3;
        memory.observeLanding(c.world, trail, standing, grounded && centered, observedTick);
        if (!grounded) return;
        supplyExcursion.observe(standing, observedTick);
        boolean routing = nextFoot != null || returnIndex >= 0 || resumeIndex >= 0 || exitStart != null
            || supplyEgress.active()
            || caves.active() || caves.routingDry();
        if (standing.equals(memoryFoot) && trail.size() == memoryTrailSize && routing == memoryRouting) return;
        memoryFoot = standing;
        memoryTrailSize = trail.size();
        memoryRouting = routing;
        var join = memory.rejoin(c.world, standing, trail, routing);
        if (join == null) return;
        if (join.resumeAt() >= 0) {
            trail.clear();
            dugSteps.clear();
            trail.addAll(join.prefix());
            litIndex = join.resumeAt();
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
        body.observeHeadroomBreak(position);
        caves.changedDry(position);
        stallGuard.broken(position, state);
        surfaceApproach.broken(position, state);
        returnableMine.observeBreak(position);
        supplyEgress.observeBreak(position, state);
        overland.changed(position);
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
        if (activeTrail() > 1) {
            beginReturn(false);
            retreatTunnel();
        } else explore();
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
    AgentDryCaveRoute.Survey drySurveyOffer() { return caves.drySurveyOffer(); }
    boolean drySurveyCurrent(AgentDryCaveRoute.Survey offer) { return caves.drySurveyCurrent(offer); }
    AgentDryCaveRoute.SurveyResult surveyDryRoute(AgentDryCaveRoute.Survey offer) { return caves.surveyDryRoute(offer); }
    String drySurveyResult(AgentDryCaveRoute.Survey offer) { return caves.drySurveyResult(offer); }
    void cancelDrySurvey(AgentDryCaveRoute.Survey offer) { caves.cancelDrySurvey(offer); }
    String dryRouteOfferEvidence() { return caves.dryRouteOfferEvidence(); }
    AgentDryCaveRoute.DirectResult followDryRoute(AgentDryCaveRoute.Offer offer) {
        return caves.followDryRoute(offer, tick);
    }
    String dryRouteReason() { return caves.dryRouteReason(); }
    void cancelFollowDryRoute(AgentDryCaveRoute.Offer offer) { caves.cancelFollowDryRoute(offer); }
    boolean dryRouteInFlight(AgentDryCaveRoute.Offer offer) { return caves.dryRouteInFlight(offer); }

    /** A scoped tread landed after the native body proved its exact reverse clearance; no autonomous mining credit. */
    void recordMacroDryTread(BlockPos from, BlockPos to) {
        caves.walkedDry(from, to);
        caves.witnessedDry(to, from);
    }

    /** One remembered edge only; the scoped actor must re-witness its dry lane before movement. */
    BlockPos macroPendingStep(BlockPos from, BlockPos stationFoot) {
        return memory.pendingFlatStep(c.world, trail, from, stationFoot);
    }

    private void recordDryCaveFooting(BlockPos from, BlockPos to) {
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
    }

    private void trimCaveTrail(int keep) {
        if (keep >= trail.size()) return;
        dugSteps.clear(keep, trail.size());
        trail.subList(keep, trail.size()).clear();
        litIndex = Math.min(litIndex, keep);
        if (resumeIndex >= keep) resumeIndex = resumeStep = -1;
        if (returnIndex >= keep) returnIndex = -1;
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

    void afterRespawn() {
        dropReclaim = new DropReclaim();
        status = "looking for nearby drops after respawn";
    }

    void tick(AgentEars ears, AgentMacroControl macro) {
        if (win || c.player == null || c.world == null) return;
        tick++;
        ordinarySurfaceWork = macro == null || !macro.engaged();
        observeStairLight();
        observeFurnaceCook();
        if (portal != null) stallGuard.surveyReceipt(portal.castSurveyEvidence());
        stallGuard.navigationSurveyReceipt(caves.drySurveyEvidence());
        stallGuard.observe(tick, confirmedFrameBlocks(), mealsEaten, status,
            returnableMine.hasProgressLease() || supplyEgress.active() || overland.leased(tick));
        advance(ears, macro);
        BlockPos newCaveLight = caves.takeLightReceipt();
        if (newCaveLight != null) stallGuard.stairLightReceipt(newCaveLight);
        returnableMine.interruptIfSkipped();
        if (returnableMine.active() || caves.routingDry()) stallGuard.navigationWork();
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
            status = stallGuard.status();
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
        boolean escaping = escapeDanger(ears, hurt, macroEngaged, safetySpend);
        if ((hurt || escaping) && dropReclaim != null) dropReclaim.cancel();
        if (escaping) {
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
        if (fall.step(safetySpend)) {
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
        if (defense.rangedActive()) {
            // Macro cancellation can release body commands, so settle ownership before bracing.
            if (macroEngaged) macro.urgent("responding to a nearby ranged threat");
            interruptHands();
            if (dropReclaim != null) dropReclaim.cancel();
            caves.interruptLight();
            if (defense.rangedStep(tick, protectedHeadroom, safetySpend))
                step(forward(defense.rangedRetreatYaw()), false, false);
            if (macroEngaged && defense.confirmedCover()) macro.safetyEffect(defense.status());
            stallGuard.priorityAim();
            status = defense.status();
            return;
        }
        if (!macroEngaged && defense.meleeActive()) {
            interruptHands();
            if (dropReclaim != null) dropReclaim.cancel();
            caves.interruptLight();
            defense.meleeStep(tick, AgentProgress::dangerous);
            stallGuard.priorityAim();
            status = defense.status();
            return;
        }
        if (macroEngaged) {
            if (!hands.busy() && c.currentScreen == null && defense.checkZombieCue(ears, tick,
                    nextFoot != null || c.options.attackKey.isPressed() && c.interactionManager.isBreakingBlock())) {
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
        if (hands.busy()) return;
        if (handleScreen()) return;
        if (dropReclaim != null) {
            dropReclaim.step();
            return;
        }
        if (eatOrHunt()) {
            caves.interruptLight();
            defense.stopZombieLook();
            stallGuard.priorityAim();
            return;
        }
        if (defense.checkZombieCue(ears, tick, nextFoot != null || returnableMine.active()
                || c.options.attackKey.isPressed() && c.interactionManager.isBreakingBlock())) {
            body.prioritizeMovement();
            stallGuard.priorityAim();
            status = defense.status();
            return;
        }
        boolean plannedWater = caves.controlsWater(tick);
        if (stallGuard.takeWaterTurn(plannedWater, stallReplan, stallRelease)) {
            body.prioritizeMovement();
            status = stallGuard.status();
            return;
        }
        // Keep a declared ordinary leg through vanilla momentum. The inventory/craft stage
        // itself correctly refuses moving footing; it cannot own the continuation here.
        if (overland.driving()) {
            stepOverland();
            return;
        }
        if (supplyEgress.step()) return;
        if (workshopReturn == null && !returnableMine.settling() && !stallGuard.ownsRecovery()
                && body.repairHeadroom(tools, protectedHeadroom)) {
            status = body.headroomReport().reason();
            return;
        }
        if (caveRetreat.step()) return;
        if (!returnableMine.surveyingCave() && stallGuard.caveSurveyStalled()) {
            AgentCaves.Opening opening = caves.drySurveyOpening();
            if (opening != null && caveRetreat.begin(opening)) {
                caves.leaveDrySurvey(tick);
                return;
            }
        }
        if (stallGuard.takeTurn(stallReplan, stallChoose, stallStep, stallRelease,
                returnableMine.hasProgressLease(), returnableMine.witnessedLowCeiling())) {
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
            int kitPlanks = fieldReserve + localTableWood() + 2 * stickBatches(torchRecipes + 4)
                + furnacePlanks(fuelLogs) + 4 * fuelLogs;
            boolean shortTimber = hands.count(PLANK) + 4 * hands.count(LOG) < kitPlanks
                || hands.count(BURNABLE_LOG) < fuelLogs;
            // A continuation without a local trail is not necessarily outdoors.
            // Only top up a launch kit at an actual open stance. Underground,
            // the mining and workshop orders request their own missing inputs.
            if (longGoal && surfaceDeparture() && (stonePick || woodPick || ironPick)
                && (pickupItem == LOG || tick < timberDropUntil || shortTimber)) {
                if (pickupItem == LOG || tick < timberDropUntil) seekTimber();
                else if (!has(AXE, 1) && affordsWood(localTableWood(), 2)) {
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
            if (pickupItem == LOG || tick < timberDropUntil) seekTimber();
            else if (has(STONE, 3)) makePick("stone_pickaxe", STONE, 3);
            else makePick("wooden_pickaxe", PLANK, 3);
            return;
        }
        if (!stonePick && !ironPick) {
            if (has(STONE, 3)) makePick("stone_pickaxe", STONE, 3);
            else if (!has(SHOVEL, 1) && affordsWood(table.position != null || has(table.item, 1) ? 1 : 5, 2)) {
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
            acquireIron(3);
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
        overland.interrupt();
        if (nextFoot != null) closeDig(nextFoot);
        nextFoot = cavePeek = climbTo = gaitStep = exitStart = exitTo = null;
        approachGoal = routeLegStart = sweepOrigin = null;
        routeTick = -10;
        heading = Float.NaN;
        headingUntil = 0;
    }

    private void rememberStallWork() {
        int incident = stallGuard.report().incidents();
        if (incident != stallWorkIncident) {
            stallWorkIncident = incident;
            stallOreTried.clear();
            stallRouteTried.clear();
            stallDropsTried.clear();
            stallTorchTried = false;
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
        if (!iron && has(INGOT, 3)) kit |= KIT_IRON;
        if (!iron && !stone && has(STONE, 3)) kit |= KIT_STONE;
        if (!iron && !stone && !wooden && affordsWood(3, 2)) kit |= KIT_WOOD;
        // Count an actual owned station when it can advance this leg, separately from wood
        // that was already convertible in theory. Do not credit spare copies or slot changes.
        if (!iron && has(table.item, 1) && stallWorkbenchNeeded(kit)) kit |= KIT_WORKBENCH;
        if (!iron && stone && has(furnace.item, 1) && stallFurnaceNeeded()) kit |= KIT_FURNACE;
        return kit;
    }

    private boolean stallWorkbenchNeeded(int kit) {
        return (kit & KIT_WOOD) != 0 || (kit & (KIT_STONE | KIT_IRON)) != 0 && affordsWood(0, 2);
    }

    private boolean stallFurnaceNeeded() {
        int missing = 3 - hands.count(INGOT);
        return missing > 0 && has(RAW_IRON, missing)
            && (has(FUEL, 1) || affordsWood(localTableWood() + furnacePlanks(missing), 2));
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
            if (station == null && stallStation != furnace && (kit & (KIT_STONE_PICK | KIT_DEEP_PICK)) == KIT_STONE_PICK
                    && stallFurnaceNeeded()) station = stallVisibleStation(furnace);
            if (station != null) return station;
            if (gained != 0) {
                stallKit |= kit;
                replanStalledLocalWork();
                stallWork = () -> AgentStallGuard.Alternative.REPLAN;
                if ((gained & KIT_WORKBENCH) != 0) return "replanning with an owned crafting table and pickaxe ingredients";
                if ((gained & KIT_FURNACE) != 0) return "replanning with an owned furnace, raw iron and fuel";
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
        if (!affordsWood(0, 3) || !has(WOOD_PICK, 1) && !has(STONE_PICK, 1) && !has(DEEP_PICK, 1)) {
            resource = stallTimber();
            if (resource != null) return resource;
        }
        return stallKnownRoute();
    }

    private String stallVisibleStation(Station station) {
        BlockHitResult other = body.find(state -> state.isOf(station.block), REACH - 0.5,
            hit -> !hit.getBlockPos().equals(station == stallStation ? stallStationPosition : station.position)
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
        BlockHitResult log = body.find(state -> state.isIn(BlockTags.LOGS), REACH - 0.4, seen -> {
            BlockPos block = seen.getBlockPos();
            return !stallOreTried.contains(block) && !timberUnderfoot(block) && !supportsTrail(block)
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
            return collect(LOG, 2, false) || tick < timberDropUntil ? AgentStallGuard.Alternative.WORKING
                : AgentStallGuard.Alternative.REFUSED;
        };
        return "cutting a different reachable log at " + log.getBlockPos().toShortString();
    }

    private String stallPickup(Predicate<ItemStack> drop, String name) {
        Vec3d feet = c.player.getPos();
        Entity sighting = body.visibleEntity(entity -> entity instanceof ItemEntity item && drop.test(item.getStack())
            && !stallDropsTried.contains(entity.getId()) && Math.abs(entity.getY() - feet.y) < 0.55, 1.85).orElse(null);
        if (sighting == null) return null;
        stallDropsTried.add(sighting.getId());
        int before = hands.count(drop);
        stallWork = () -> has(drop, before + 1) ? stallAcquired()
            : collectObserved(drop, body.visibleEntity(entity -> entity == sighting, 1.85).orElse(null), false)
                ? AgentStallGuard.Alternative.WORKING : AgentStallGuard.Alternative.REFUSED;
        return "collecting a newly available visible " + name + " drop";
    }

    private String stallOre(Resource resource) {
        String pickup = stallPickup(resource.drop, resource.label);
        if (pickup != null) return pickup;
        BlockHitResult hit = body.find(resource.block, REACH - 0.4, seen -> {
            BlockPos block = seen.getBlockPos();
            return !stallOreTried.contains(block) && reachableResourceFace(block) && !supportsTrail(block)
                && !body.hazardAhead(yaw(seen.getPos().subtract(c.player.getPos())), 1.5)
                && tools.canHarvest(state(seen));
        }).orElse(null);
        if (hit == null) return null;
        stallOreTried.add(hit.getBlockPos());
        int before = hands.count(resource.drop);
        setTarget(hit, resource);
        stallWork = () -> {
            if (has(resource.drop, before + 1)) return stallAcquired();
            if (target != null) {
                mineTarget(resource);
                return AgentStallGuard.Alternative.WORKING;
            }
            return collect(resource.drop, 2, false) || tick < pickupUntil ? AgentStallGuard.Alternative.WORKING
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
                    || stallRouteTried.contains(step) || stallGuard.triedStallRoute(step)) continue;
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
    boolean macroWorkWalk(Vec3d point) { return approach(point, false, false) != Walk.BLOCKED; }

    private void recordStallFooting(BlockPos reached) {
        if (returnIndex >= 0) {
            int rejoin = trail.lastIndexOf(reached);
            if (rejoin >= returnTo && rejoin <= returnIndex) {
                returnIndex = rejoin;
                returnDetour = null;
                returnAge = tick;
                returnClear = -1;
            } else if (adjacent(reached, trail.get(returnIndex))) {
                returnDetour = reached;
                returnAge = tick;
                returnClear = -1;
            }
        } else if (resumeIndex < 0 && !trail.isEmpty() && adjacent(trail.getLast(), reached) && !trail.contains(reached)) {
            appendGrounded(reached, false);
        }
    }

    /** Only ordinary trail work may continue under a witnessed low ceiling; never widen the pillar. */
    private String tryStallMineHandback(BlockPos standing) {
        if (!arrived(standing) || c.player.isTouchingWater() || returnableMine.unjoined(standing)
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
            if (index < returnTo || index > returnIndex + 1) return null;
            if (index <= returnIndex) returnIndex = index;
            returnDetour = null;
            returnAge = tick;
            returnClear = -1;
            return "resuming the existing supply return on the connected mine trail";
        }
        if (!connectedMine || index != last || resumeIndex >= 0 || returnIndex >= 0 || nextFoot != null) return null;
        if (hands.count(TORCH) <= 2 || pickUses(DEEP_PICK) + pickUses(STONE_PICK) < 4) {
            startReturn(0, true);
            return "returning on the connected mine trail for essential supplies";
        }
        int branch = Math.max(1, index - 3);
        startReturn(branch, false);
        return "backtracking to " + trail.get(branch).toShortString() + " to open a different ordinary mine branch";
    }

    void acquireIron(int desired) {
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
        if (raw >= Math.min(3, desired - ingots)) {
            if (!has(TORCH, 2) && craftTorches(LOCAL_LIGHT)) return;
            if (!has(FUEL, 1)) {
                int heatPlanks = furnacePlanks(Math.min(3, raw));
                if (!affordsWood(localTableWood() + heatPlanks, 2)) {
                    if (!workOre(Resource.COAL, has(TORCH, 2) ? SEARCH : REACH - 0.35, true))
                        seekExpeditionSupplies("furnace fuel");
                    return;
                }
                if (!supplyPlanks(heatPlanks)) return;
            }
            fire(Firing.IRON, desired);
        } else {
            gather(Resource.IRON, surfaceDeparture() ? 115 : 0, 16);
        }
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

        boolean departure = surfaceDeparture();
        int torches = hands.count(TORCH);
        int drop = Math.max(0, c.player.getBlockY() - depth);
        int nextLeg = drop + drop / 9 + 12;
        int needed = departure ? launchLight() : Math.min(LOCAL_LIGHT, 2 + (nextLeg + 6) / 7);
        if (torches < needed) {
            if (craftTorches(needed)) return true;
            if (prepareLight(departure)) return true;
        }

        int deepUses = pickUses(DEEP_PICK);
        int stoneUses = pickUses(STONE_PICK);
        int remaining = deepUses + stoneUses;
        if (depth == DIAMOND_LEVEL && deepUses <= 4) {
            if (has(INGOT, 3) && affordsWood(localTableWood(), 2)) {
                requestTable("iron_pickaxe", null, 0, 2);
                return true;
            }
            if (has(RAW_IRON, 3) && (canSetLocalFurnace() || localStation(furnace, furnaceWitness))) {
                acquireIron(3);
                return true;
            }
            if (workOre(Resource.IRON, torches > 1 ? SEARCH : REACH - 0.35, true)) return true;
        }

        // Break up to three blocks per stair step. Budget the next lit leg and
        // leave uses for exposed ore, but don't require an entire second kit.
        int litLeg = Math.min(nextLeg, 7 * Math.max(1, torches - 1));
        if (remaining < 3 * litLeg + 4 && tick >= refitPickRetry
                && has(STONE, 3) && affordsWood(localTableWood(), 2)) {
            refitPickCount = hands.count(STONE_PICK);
            refitPickUntil = tick + 230;
            return refitMinedPick();
        }
        if (remaining < 4 || depth == DIAMOND_LEVEL && deepUses <= 1 && stoneUses < 4) {
            if (has(STONE, 3)) makePick("stone_pickaxe", STONE, 3);
            else if (depth == DIAMOND_LEVEL && deepUses <= 1
                || !workOre(Resource.STONE, REACH - 0.35, false)) seekExpeditionSupplies("a replacement pickaxe");
            return true;
        }
        if (departure) departureKit = true;
        return false;
    }

    private boolean refitMinedPick() {
        if (refitPickCount < 0) return false;
        if (hands.count(STONE_PICK) > refitPickCount || tick >= refitPickUntil || !has(STONE, 3)
                || !affordsWood(localTableWood(), 2)) {
            refitPickCount = -1;
            refitPickRetry = tick + 150;
            return false;
        }
        requestTable("stone_pickaxe", null, 0, 2);
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
            tableRecipe = null;
            tableExtra = null;
            tableAxe = null;
            status = "crafting " + recipe;
            if (!affordsWood(tablePlanks, tableSticks)) {
                c.currentScreen.close();
                return true;
            }
            boolean addBoat = canAddBoat(recipe);
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
        return screen != null && c.currentScreen == screen && furnaceScreenWorld == c.world
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
            furnaceTransferPending = false;
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
        return torches < 2 && (affordsWood(localTableWood(), 3) || canSpareEmergencyStick(torches));
    }

    private void handleFurnace(FurnaceScreen screen) {
        if (screen != furnaceScreen) {
            BlockPos used = confirmStationUse(furnace);
            if (used == null) {
                screen.close();
                return;
            }
            furnaceScreen = screen;
            furnaceScreenWorld = c.world;
            furnace.openAttempts = 0;
            furnaceWitness = used;
            furnaceWarmUntil = tick + 24;
        }
        if (!ownsFurnaceScreen(screen)) {
            screen.close();
            return;
        }
        if (furnaceTransferPending) {
            // This same screen survived Hands' real slot gestures. Start the sync
            // window now, not before the cursor has even put the fuel and input down.
            furnaceTransferPending = false;
            furnaceWarmUntil = tick + 24;
        }
        status = firing == Firing.IRON ? "smelting iron" : "making charcoal";
        var handler = screen.getScreenHandler();
        ItemStack input = handler.getSlot(0).getStack();
        ItemStack output = handler.getOutputSlot().getStack();
        if (!input.isEmpty() && !furnaceInput(input) || !output.isEmpty() && !output.isOf(furnaceOutput())) {
            finishFire();
            screen.close();
            blockStation(furnace, "the furnace contains another recipe");
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
        int hunger = c.player.getHungerManager().getFoodLevel();
        boolean food = tick >= mealRetry && tick >= mealQuietUntil && (hunger <= 14 || canRefuelHealing(hunger))
            && c.player.isOnGround() && !c.player.isTouchingWater() && bestMeal(hunger) >= 0;
        boolean urgentLight = needsFurnaceLight();
        if (!ready && (food || urgentLight && has(FUEL, 1))) {
            screen.close();
            return;
        }
        boolean cooking = !input.isEmpty() && handler.isBurning();
        boolean deferOutput = ready && output.getCount() < 3 && !urgentLight && !food;
        if (cooking && (!ready || deferOutput)) {
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
        if (hands.smelt(firing == Firing.CHARCOAL, limit)) {
            furnaceTransferPending = true;
            furnaceNeedsFuel = false;
            return;
        }
        String result = hands.status();
        furnaceNeedsFuel = result.equals("smelt: no fuel");
        if (!furnaceNeedsFuel) {
            finishFire();
            if (!result.equals("smelt: no input")) blockStation(furnace, result);
        }
        screen.close();
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
        int logsForPlanks = logBatches(plankCost, stickBatches(tableSticks + torchRecipes + 2));
        return (charcoal == 0 || has(BURNABLE_LOG, charcoal))
            && has(LOG, logsForPlanks + charcoal) && hands.singleBoatWoodStock();
    }

    private void makePick(String recipe, Predicate<ItemStack> ingredient, int quantity) {
        int plankCost = ingredient == PLANK ? quantity : 0;
        if (ingredient != PLANK && !has(ingredient, quantity)) return;
        String extra = null;
        if (!goal.equals("wooden_pickaxe") && !has(SHOVEL, 1)) {
            if (recipe.equals("wooden_pickaxe")) {
                extra = "wooden_shovel";
                plankCost++;
            } else if (recipe.equals("stone_pickaxe") && has(STONE, 4) && !goal.equals("stone_pickaxe")) {
                extra = "stone_shovel";
            }
        }
        int sticks = extra == null ? 2 : 4;
        String axe = null;
        if (needsTimberKit() && !timberReady && !has(AXE, 1)) {
            if (recipe.equals("wooden_pickaxe")) {
                plankCost += 3;
                axe = "wooden_axe";
            } else if (recipe.equals("stone_pickaxe") && has(STONE, quantity + (extra == null ? 3 : 4))) {
                axe = "stone_axe";
            }
        }
        requestTable(recipe, extra, axe, plankCost, sticks + (axe == null ? 0 : 2));
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
                    int batch = Math.min(raw, reserve - ingots);
                    boolean usableFurnace = has(furnace.item, 1) || visibleOrRemembered(furnace);
                    int benchWood = (bucketCost == 0 && usableFurnace) || carriedBench || localBench ? 0 : 4;
                    if ((has(FUEL, 1) || affordsWood(furnacePlanks(batch) + benchWood, 0))
                        && (usableFurnace || has(STONE, 8) && (carriedBench || canMakeBench || localBench))) {
                        returning = false;
                        smelting = true;
                        fire(Firing.IRON, ingots + batch);
                        return true;
                    }
                }
                if (shoreOnly) return false;
                if (returning && resumeIndex > 0) {
                    if (resupplyUntil == 0) resupplyUntil = tick + 120;
                    if (tick < resupplyUntil && fieldWood.step(0, true)) return true;
                    returning = false;
                }
                if (!tripUsed && returnForWorkshop(makeBucket, has(FUEL, 1))) return true;
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
            tripUsed = returning = true;
            startReturn(waypoint, true);
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
            if (collect(GRAVEL_DROPS, 3.5, false)) return true;
            if (tick < dropUntil) {
                status = "watching for the gravel or flint drop";
                body.aim(gravelPoint);
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
                    && tryTableReturn(hint, planks, sticks)) return false;
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

    private boolean tryTableReturn(BlockPos workshop, int planks, int sticks) {
        int last = activeTrail() - 1;
        if (last <= 0 || !arrived(trail.get(last))) return false;
        int waypoint = stationWaypoint(workshop);
        if (waypoint < 0 || last - waypoint > 4) return false;
        for (int i = waypoint + 1; i <= last; i++) {
            if (!adjacent(trail.get(i - 1), trail.get(i))) return false;
        }
        startReturn(waypoint, true);
        tableReturn = new TableReturn(workshop, planks, sticks);
        return true;
    }

    private void releaseTablePosition() {
        fieldBench.leave();
        table.position = table.lastUse = null;
        table.resetSite();
        table.approachUntil = 0;
        table.openAttempts = 0;
    }

    private boolean supplyPlanks(int quantity) {
        if (has(PLANK, quantity)) return true;
        if (ensureWood(quantity, 0)) {
            status = "turning logs into planks";
            hands.craftBatch(woodBatch(quantity, 0));
        }
        return false;
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
        int held = hands.count(TORCH);
        int batches = Math.min(Math.min(3, hands.count(FUEL)), torchBatches(reserve, held));
        while (batches > 0 && !affordsWood(localTableWood(), batches + 2)) batches--;
        if (batches == 0 && held < reserve && has(FUEL, 1) && canSpareEmergencyStick(held)) {
            // In a dark passage the two planks in hand buy four real sticks.
            // Make the affordable batch now instead of waiting for hypothetical bench timber.
            batches = Math.min(Math.min(3, hands.count(FUEL)), torchBatches(reserve, held));
            while (batches > 0 && !affordsWood(0, batches)) --batches;
        }
        if (batches <= 0) return false;
        List<String> recipes = woodBatch(0, batches);
        for (int i = 0; i < batches; i++) recipes.add("torch");
        status = "crafting torches";
        return hands.craftBatch(recipes);
    }

    private boolean prepareLight(boolean departure) {
        int torches = hands.count(TORCH);
        if (!departure && !affordsWood(0, 1) && activeTrail() > 1) {
            if (torches > 2) return false;
            // Coal alone cannot make light. Keep the last two torches for the walked way out.
            seekExpeditionSupplies("wood and light");
            return true;
        }
        boolean canMakeTorch = affordsWood(localTableWood(), 3) || canSpareEmergencyStick(torches);
        double range = torches > 1 || departure ? SEARCH : REACH - 0.35;
        if (canMakeTorch && workOre(Resource.COAL, range, departure || torches <= 3))
            return true;
        // Once inside a lit mine, skip the optional top-up rather than burn the last
        // workshop wood in a furnace while there is still light for another short leg.
        if (!departure && torches >= 4) return false;

        boolean localFurnace = localStation(furnace, furnaceWitness);
        if (!localFurnace) {
            BlockHitResult seen = body.find(state -> state.isOf(furnace.block), 3.75).orElse(null);
            if (seen != null) {
                furnace.position = confirmStation(furnace, seen);
                localFurnace = true;
            }
        }
        if (localFurnace || canSetLocalFurnace() || departure) {
            if (prepareCharcoal()) return true;
        } else if (has(BURNABLE_LOG, 1) && affordsWood(localTableWood() + 2, 3)
            && workOre(Resource.STONE, REACH - 0.35, false)) {
            status = "gathering local furnace stone";
            return true;
        }

        if (!departure && torches >= 3) return false;
        if (canMakeTorch && recallOre(Resource.COAL, range, activeTrail())) return true;
        if (!localFurnace && prepareCharcoalAtKnownFurnace()) return true;
        // No coal or nearby stove. If the player already has the wood for charcoal,
        // a workbench, fuel and sticks, the missing ingredient is furnace stone.
        // The charcoal job keeps the ordinary stone miner active across ticks.
        if (!localFurnace && torches <= 2 && has(BURNABLE_LOG, 1)
            && affordsWood(localTableWood() + 4 + furnacePlanks(1), 3)) {
            int missingStone = 8 - hands.count(STONE);
            if (missingStone > 0 && pickUses(STONE_PICK) + pickUses(WOOD_PICK) >= missingStone
                && prepareCharcoal()) return true;
        }
        if (!departure && activeTrail() <= 1 && surveyLocalLight()) return true;
        seekExpeditionSupplies(canMakeTorch ? "light" : "wood and light");
        return true;
    }

    private boolean canSpareEmergencyStick(int torches) {
        // Convert the available fuel before starting a low-light survey for supplies.
        // A workable pick and the next four torches are worth more than one spare stick.
        return torches <= 3 && (has(STICK, 1) || affordsWood(0, 3))
            && pickUses(DEEP_PICK) + pickUses(STONE_PICK) > 6;
    }

    private boolean surveyLocalLight() {
        BlockPos feet = c.player.getBlockPos();
        if (!feet.equals(lightSurveyFoot)) {
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

    private boolean prepareCharcoalAtKnownFurnace() {
        BlockPos known = furnace.position != null ? furnace.position
            : furnaceWitness != null ? furnaceWitness : memory.station(c.world, true);
        return known != null && stationWaypoint(known) >= 0 && prepareCharcoal();
    }

    private boolean prepareCharcoal() {
        int burnable = hands.count(BURNABLE_LOG);
        if (burnable == 0 || has(FUEL, 1)) return false;
        var inventory = c.player.getInventory();
        var fuels = c.world.getFuelRegistry();
        int batch = 0;
        int plankHeat = 0;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inventory.getStack(slot);
            if (BURNABLE_LOG.test(stack)) batch = Math.max(batch, Math.min(3, stack.getCount()));
            if (PLANK.test(stack)) plankHeat = Math.max(plankHeat, fuels.getFuelTicks(stack) * stack.getCount());
        }
        int timber = hands.count(PLANK) + 4 * hands.count(LOG);
        int heatPlanks = furnacePlanks(batch);
        int protectedWood = localTableWood() + 2 * stickBatches(batch + 2);
        // Hands loads up to three logs from one stack. Converting one safely
        // tightens that limit when only a single log can really be spared.
        boolean fits = timber - 4 * batch >= heatPlanks + protectedWood;
        int heatForTable = !has(furnace.item, 1) && !localStation(furnace, furnaceWitness)
            ? PLANK_BURN_TICKS * localTableWood() : 0;
        if (!fits || plankHeat < 200 * batch + heatForTable) {
            int minimum = 4 + 2 + localTableWood() + 2 * stickBatches(3);
            if (burnable < 2 || timber < minimum) return false;
            status = "reserving workshop wood and preparing charcoal fuel";
            return hands.craft("planks");
        }
        fire(Firing.CHARCOAL, batch);
        return true;
    }

    private static int furnacePlanks(int batch) {
        return (200 * batch + PLANK_BURN_TICKS - 1) / PLANK_BURN_TICKS;
    }

    private void seekExpeditionSupplies(String supplies) {
        seekTimber(supplies);
    }

    private void fire(Firing batch, int demand) {
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
        if (furnace.position == null) {
            BlockHitResult seen = body.find(FURNACE_BLOCK, portalRefit ? 3.75 : 5).orElse(null);
            if (seen != null) furnace.position = confirmStation(furnace, seen);
            else if ((!portalRefit || portalSupplies.localHint(furnace))
                && !(batch == Firing.CHARCOAL && canSetLocalFurnace()) && recoverStation(furnace)) return;
        }
        if (furnace.position != null && c.player.getEyePos().distanceTo(Vec3d.ofCenter(furnace.position)) > 3.75) {
            int bench = stationWaypoint(furnace.position);
            if (!furnaceLoaded && (portalRefit || canSetLocalFurnace()
                && (bench < 0 || activeTrail() - bench > 12))) {
                // Leave the distant furnace in observation memory and use a local replacement.
                furnace.position = furnaceWitness = null;
                furnace.resetSite();
            } else if (bench >= 0) {
                startReturn(bench, true);
                return;
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
            furnaceNeedsFuel = false;
            status = "preparing usable furnace fuel";
            if (!hands.prepareSmeltFuel(firing == Firing.CHARCOAL && !furnaceLoaded)) {
                finishFire();
                if (portalSupplies == null || portalSupplies.stoneBank == null) seekExpeditionSupplies("furnace fuel");
            }
            return;
        }
        if (portalRefit && furnace.position == null) {
            status = "placing the local furnace for portal iron";
            placeStation(furnace);
        } else useStation(furnace, null);
    }

    private boolean canSetLocalFurnace() {
        return has(furnace.item, 1) || has(STONE, 8) && (has(table.item, 1)
            || table.position != null && c.player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(table.position)) < 25
            || affordsWood(4, 0));
    }

    private void finishFire() {
        if (portalSupplies != null) portalSupplies.smelting = false;
        firing = Firing.NONE;
        furnaceLoaded = false;
        furnaceNeedsFuel = false;
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
        if (hint == null) return false;
        Vec3d center = Vec3d.ofCenter(hint);
        if (c.player.getEyePos().squaredDistanceTo(center) > REACH * REACH) {
            station.memoryProbe = 0;
            int bench = stationWaypoint(hint);
            if (bench < 0) return false;
            if (activeTrail() - bench > 12 && (station == table ? affordsWood(4, 0) :
                    !furnaceLoaded && has(STONE, 8) && (table.position != null || affordsWood(4, 0)))) return false;
            startReturn(bench, true);
            return true;
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
                seen = body.find(TABLE_BLOCK, REACH, hit -> hit.getBlockPos().equals(station.position)).orElse(null);
            if (seen == null && (distance > 3.75 || tick < station.approachUntil)) {
                if (approach(center, false, false) == Walk.BLOCKED) {
                    if (station == furnace && station.position.equals(furnaceWitness)) {
                        if (activeTrail() > 1) beginReturn(true);
                        else blockStation(station, "cannot reach the witnessed furnace");
                    } else if (station == table) {
                        failedTableReturn = station.position;
                        releaseTablePosition();
                    } else station.position = null;
                }
                return;
            }
            if (station == furnace)
                seen = body.find(FURNACE_BLOCK, REACH, hit -> hit.getBlockPos().equals(station.position)).orElse(null);
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
        // requestTable already searched for a table from this stance.
        seen = station == furnace ? body.find(FURNACE_BLOCK, 5.0).orElse(null) : null;
        if (seen != null) {
            station.position = confirmStation(station, seen);
            station.placed = 0;
            station.approachUntil = 0;
            approachGoal = null;
            return;
        }
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
        startReturn(index - 1, true);
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
        private Vec3d center, face, drop;
        private Predicate<ItemStack> output;
        private int placedAt, outputBefore, packUntil, before, dropSeen;
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
            Entity seen = body.visibleEntity(nearbyDrop, 4).orElse(null);
            if (seen != null) {
                drop = seen.getPos();
                dropSeen = tick;
            }
            if (drop == null || tick - dropSeen > 9) {
                body.aim(new Vec3d(center.x, Math.min(center.y, c.player.getY() + 0.3), center.z));
                return true;
            }
            Vec3d delta = drop.subtract(c.player.getPos());
            if (delta.y < -0.7 || delta.y > 1.5) return leave();
            if (delta.horizontalLengthSquared() < 0.22) {
                body.aim(drop);
                if (delta.y > 0.55 && c.player.isOnGround()) {
                    if (body.jumpBlocked()) return leave();
                    body.jumpForReach();
                }
                return true;
            }
            if (delta.y < 0.7 && delta.horizontalLengthSquared() <= 2.15 && walkMinedPickup(drop)) return true;
            if (approach(drop, false, false) == Walk.BLOCKED) return leave();
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
            center = face = drop = null;
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
                || target != null || pickupItem != null || timberChop != null || !has(AXE, 1)) return false;
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
                if (pickupItem == LOG && freshHarvest && tick - pickupSeen > 26) clearPickup();
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

            int drop = Math.max(0, deepFoot.getY() - DIAMOND_LEVEL);
            int light = MathHelper.clamp(2 + (drop + drop / 9 + 18) / 7, LOCAL_LIGHT, DEEP_LIGHT);
            int torches = hands.count(TORCH);
            int batches = Math.min(3, Math.min(hands.count(FUEL), torchBatches(light, torches)));
            int handles = handleSticks();
            int bench = portableBenchWood();
            if (batches > 0 && affordsWood(bench, batches + handles) && craftTorches(light)) return true;
            if (bench == 0 && !has(table.item, 1) && fieldBench.pack()) return true;

            if ((torches < light || !affordsWood(bench, handles)) && tick < deepUntil) {
                if (step(light, true)) return true;
                if (target != null && miningResource == Resource.COAL) {
                    mineTarget(Resource.COAL);
                    return true;
                }
                Entity fuel = torches < light ? body.dropped(FUEL, 2.2).orElse(null) : null;
                if (fuel != null && collectOnFooting(deepFoot, fuel.getPos())) {
                    status = "collecting visible coal beside the surface workshop";
                    return true;
                }
                if (miningResource == Resource.COAL && tick < pickupUntil) {
                    body.aim(pickupLook);
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
                    int charcoal = Math.min(3, hands.count(BURNABLE_LOG));
                    if (charcoal > 0 && affordsWood(bench + 4 * charcoal + furnacePlanks(charcoal), charcoal + handles)) {
                        BlockHitResult stove = body.find(state -> state.isOf(furnace.block), 3.5).orElse(null);
                        if (stove != null) {
                            furnace.position = confirmStation(furnace, stove);
                            if (prepareCharcoal()) return true;
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

        private boolean collectOnFooting(BlockPos from, Vec3d drop) {
            double distance = drop.subtract(c.player.getPos()).horizontalLengthSquared();
            if (distance > 2.15 || !adjacent(from, BlockPos.ofFloored(drop)) || drop.y < c.player.getY()) return false;
            if (drop.y > c.player.getY() + 0.45) {
                body.aim(drop);
                return true;
            }
            return distance <= 0.09 || walkMinedPickup(drop);
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
                Entity drop = body.visibleEntity(nearbyDrop, 3).orElse(null);
                status = "collecting a low log beside the mine route";
                if (drop == null) {
                    body.aim(Vec3d.ofBottomCenter(timberLastCut));
                    return true;
                }
                if (collectOnFooting(anchor, drop.getPos())) return true;
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
            int litSteps = 7 * Math.max(1, Math.min(LOCAL_LIGHT, hands.count(TORCH) + 4 * hands.count(FUEL)) - 2);
            return pickUses(DEEP_PICK) + pickUses(STONE_PICK) < 3 * litSteps ? 4 : 2;
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
            if (target != null && miningResource == returnableOre) {
                mineTarget(returnableOre);
                return;
            }
            if (collect(returnableOre.drop, 3.1, false)) return;
            if (miningResource == returnableOre && tick < pickupUntil) {
                body.aim(pickupLook);
                return;
            }
            returnableOre = null;
        }
        if (nextFoot != null) {
            excavate(nextFoot.getY(), digGoal);
            return;
        }
        if (resumeIndex >= 0) {
            if (resource != Resource.STONE && hands.count(TORCH) <= 2) {
                if (craftTorches(LOCAL_LIGHT) || prepareLight(false)) return;
            }
            resumeTunnel();
            return;
        }
        if (surfaceApproach.step(c.player.getBlockPos())) return;
        if (resource != Resource.STONE && fieldWood.step()) return;
        double range = resource != Resource.STONE && (surfaceDeparture() || !has(TORCH, 2))
            ? REACH - 0.35 : SEARCH;
        if (workOre(resource, range, resource != Resource.STONE)) return;
        if (returnableMine.active() && (resource == Resource.DIAMOND || resource == Resource.IRON)) {
            workReturnableMine(c.player.getBlockPos(), depth);
            return;
        }
        if (resource != Resource.STONE && prepareMining(depth)) return;
        if (resource != Resource.STONE && hands.count(TORCH) + 4 * hands.count(FUEL) < LOCAL_LIGHT
            && affordsWood(localTableWood(), 3) && workOre(Resource.COAL, range, false)) return;
        target = null;
        if ((activeTrail() > 1 || resumeIndex >= 0 || tick - soughtSince > onSurfaceTicks)
            && tick >= nextDigStart && (c.player.isOnGround() || activeTrail() > 0) && !c.player.isTouchingWater()) {
            excavate(depth, null);
        } else {
            explore();
        }
    }

    private boolean workOre(Resource resource, double range, boolean remember) {
        if (target != null && miningResource == resource
            && (range > REACH || targetPoint.squaredDistanceTo(c.player.getEyePos()) <= range * range)) {
            mineTarget(resource);
            return true;
        }
        if (collect(resource.drop, Math.min(7, range), resource == Resource.STONE || has(TORCH, 2))) return true;
        if (resource == miningResource && tick < pickupUntil) {
            body.aim(pickupLook);
            return true;
        }
        BlockHitResult hit = findOre(resource, range);
        if (hit != null && (tick >= seekAfter || activeTrail() > 1) && reachableResourceFace(hit.getBlockPos())
            && tools.canHarvest(state(hit))) {
            setTarget(hit, resource);
            mineTarget(resource);
            return true;
        }
        return remember && recallOre(resource, range, 24);
    }

    private BlockHitResult findOre(Resource resource, double range) {
        if (oreWorld != c.world) {
            oreSights.clear();
            rejectedOreSights.clear();
            clearOreProbe();
            oreWorld = c.world;
        }
        BlockHitResult hit = body.find(resource.block, range).orElse(null);
        if (hit == null || resource == Resource.STONE || !c.player.isOnGround()
            || c.player.isTouchingWater() || !reachableResourceFace(hit.getBlockPos())) return hit;
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
            startReturn(waypoint, true);
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
            if (collect(sight.resource.drop, 3.5, false)) return true;
            if (miningResource == sight.resource && tick < pickupUntil) {
                body.aim(pickupLook);
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
                if (!timberCanopyPeeking && horizontalDistance(feet, timberCanopy) > 1.8
                    && approach(new Vec3d(timberCanopy.x, feet.y, timberCanopy.z), false, false) != Walk.BLOCKED) {
                    status = "approaching a visible tree canopy";
                    return true;
                }
                timberCanopyPeeking = true;
                if (timberLeafCuts == 0 && horizontalDistance(feet, timberCanopy) <= 3.5
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
            timberCanopyUntil = tick + 145;
            timberCanopyPeeking = false;
            timberLeafCuts = 0;
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
        var player = c.player;
        if (!body.hasRecentView()) {
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
            overland.interrupt();
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
        if (timberChop != null) {
            chopTimber();
            return;
        }
        if (tick < timberDropUntil || pickupItem == LOG || pickupItem == PLANK) {
            var pickupWood = pickupItem == LOG || pickupItem == PLANK ? pickupItem : timberDropItem;
            if (collect(pickupWood, 7)) return;
            if (tick < timberDropUntil && hands.count(timberDropItem) <= timberDropCount) {
                Vec3d cut = Vec3d.ofCenter(timberLastCut);
                body.aim(new Vec3d(cut.x, Math.min(player.getY() + 0.32, cut.y), cut.z));
                status = timberDropItem == LOG ? "checking the trunk base for dropped logs"
                    : "checking the witnessed cut for dropped planks";
                return;
            }
            timberDropUntil = 0;
        }
        if (timberWitness != null && tendTimber()) return;
        if (collect(LOG, 7)) {
            overland.interrupt();
            return;
        }
        if (startReachableTimber(true)) return;
        if (!overland.owns(player.getBlockPos()) && supplyEgress.seek(supplies)) return;
        BlockHitResult log = body.find(state -> state.isIn(BlockTags.LOGS), 22, this::timberCandidate).orElse(null);
        if (log != null) {
            witnessTimber(log);
            tendTimber();
            return;
        }
        if (surveyTimber()) {
            overland.interrupt();
            return;
        }
        if (!ordinarySurfaceWork) return;
        if (!has(WOOD_PICK, 1) && !has(STONE_PICK, 1) && !has(DEEP_PICK, 1) && seekSurfaceSupply()) return;
        stepOverland();
    }

    private boolean seekSurfaceSupply() {
        if (collect(PLANK, 7)) {
            overland.interrupt();
            return true;
        }
        BlockHitResult plank = body.find(SUPPLY_WOOD, c.player.getBlockInteractionRange(),
            hit -> timberInReach(hit) && !timberUnderfoot(hit.getBlockPos()) && !supportsTrail(hit.getBlockPos())
                && !triedSupplyCuts.contains(hit.getBlockPos())).orElse(null);
        if (plank != null) {
            overland.interrupt();
            rememberTimberSite(triedSupplyCuts, plank.getBlockPos());
            beginTimberChop(plank, false);
            return true;
        }
        if (overland.guiding(tick)) return false;
        var landmark = body.find(SUPPLY_WOOD, 16,
            hit -> !timberInReach(hit) && newSupplyLandmark(hit.getBlockPos())).orElse(null);
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
        overland.guide(block, tick);
        return false;
    }

    private boolean newSupplyLandmark(BlockPos block) {
        for (BlockPos prior : checkedSupplyLandmarks)
            if (prior.getSquaredDistance(block) <= 16) return false;
        return true;
    }

    private void stepOverland() {
        overland.step(tick);
        status = overland.status();
        if (overland.leased(tick)) stallGuard.navigationWork();
        var arrival = overland.takeArrival();
        if (arrival != null) stallGuard.navigationArrival(arrival.from(), arrival.foot());
        if (overland.takeRefusal()) localBlock = status;
    }

    private void witnessTimber(BlockHitResult log) {
        overland.interrupt();
        timberWitness = log;
        timberCanopy = null;
        timberLastCut = null;
        timberNear = false;
        timberLeafCuts = timberScan = timberApproachSince = 0;
        timberWorkUntil = tick + TIMBER_WORK_TICKS;
        approachGoal = null;
    }

    private boolean startReachableTimber(boolean searchView) {
        if (!dryFieldFooting()) return false;
        double reach = c.player.getBlockInteractionRange();
        BlockHitResult wood = null;
        if (c.crosshairTarget instanceof BlockHitResult pointed && pointed.getType() == HitResult.Type.BLOCK
                && state(pointed).isIn(BlockTags.LOGS) && reachableTrunk.test(pointed))
            wood = body.macroMineWitness(pointed, reach);
        if (wood == null && searchView)
            wood = body.find(state -> state.isIn(BlockTags.LOGS), reach, reachableTrunk).orElse(null);
        if (wood == null) return false;
        // The exposed face is in real interaction range from here, including the underside
        // of a canopy trunk. There is no reason to look for its base or a higher foothold.
        witnessTimber(wood);
        beginTimberChop(wood, false);
        status = "preparing to cut the reachable log from this footing";
        return true;
    }

    /** The supply caller retains its job until outside, at reachable wood, or at a physical refusal. */
    private final class SupplyEgress {
        private enum Proof {
            OPENING, LIP, CROWN, HEAD, FOOT, REVERSE_CROWN, LANDING,
            FOOTHOLD_SPACE, FOOTHOLD_ANCHOR, FOOTHOLD_RECEIPT
        }

        private static final int JOB_TICKS = 4800, LOOK_TICKS = 35, CUT_TICKS = 70;
        private static final int MAX_RISE = 48, MAX_LEVEL = 2, MAX_CUTS = 96, MAX_LANE_CUTS = 3;
        private static final int MAX_CONNECTORS = 2, MAX_FOOTHOLDS = 2, FOOTHOLD_RESERVE = 8, ANCHOR_TICKS = 24;
        private static final float SURVEY_PITCH = -42;
        private final List<BlockPos> walked = new ArrayList<>();
        private BlockPos openFoot, unknownFoot, from, to, armedCut, packedBench;
        private Vec3d floor, alternateFloor, aim, buildLow, buildHigh, reverseLeft, reverseRight;
        private Direction bearing, lane;
        private Proof proof;
        private String supplies, surveyActivity, crossingActivity, blocked, firstRefusal, lastRefusal;
        private int deadline, since, view, views, openViews, roofViews, wallViews;
        private int choice, flatBearings, driving, back, backEnd, rises, levels, cuts, laneCuts;
        private int benchBefore, benchCollectUntil, connectors, builds, buildBefore, anchorChoice;
        private long revealedFrame;
        private boolean returning, walkedReturn, enclosed, surveying, sourceProved, lighting, triedLight, triedCraftLight;
        private boolean triedLower, built;

        boolean active() { return from != null; }

        void observeBreak(BlockPos position, BlockState material) {
            if (!position.equals(armedCut)) return;
            armedCut = null;
            revealedFrame = body.renderedFrame();
            since = tick;
            cuts++;
            laneCuts++;
            if (material.isOf(table.block) && memory.ownsWorkbench(c.world, position)) {
                packedBench = position.toImmutable();
                benchCollectUntil = tick + 16;
                memory.forget(c.world, false, position);
                if (position.equals(table.position)) releaseTablePosition();
            }
        }

        boolean outdoors() {
            return dryFieldFooting() && c.player.getBlockPos().equals(openFoot);
        }

        boolean seek(String need) {
            if (!dryFieldFooting() || c.player.hasVehicle()) return false;
            BlockPos standing = c.player.getBlockPos();
            // Continue the ordinary timber traversal across a few recently walked tiles.
            // Only the stance itself, not this short excursion, counts as an outdoor departure.
            if (outdoors() || standing.equals(unknownFoot)) return false;
            if (openFoot != null && Math.abs(standing.getY() - openFoot.getY()) <= 1
                    && standing.getSquaredDistance(openFoot) <= 16) {
                int view = body.supplyPerspective(c.player.getYaw());
                if ((view & (AgentBody.SUPPLY_ROOF | AgentBody.SUPPLY_WALL))
                        != (AgentBody.SUPPLY_ROOF | AgentBody.SUPPLY_WALL)) return false;
            }
            from = standing;
            supplies = need;
            surveyActivity = "supply egress: surveying the rendered roof and opening for " + supplies;
            deadline = tick + JOB_TICKS;
            bearing = c.player.getHorizontalFacing();
            walked.clear();
            walked.add(from);
            blocked = firstRefusal = lastRefusal = null;
            armedCut = packedBench = null;
            revealedFrame = -1;
            rises = levels = cuts = connectors = builds = 0;
            sourceProved = walkedReturn = lighting = triedLight = triedCraftLight = false;
            returning = findReturn();
            enclosed = returning && trail.get(backEnd).getY() >= from.getY() + 2;
            survey(4);
            return step();
        }

        boolean step() {
            if (!active() || c.player.hasVehicle()) return false;
            if (c.player.isTouchingWater()) {
                seekTimber(supplies);
                return true;
            }
            stallGuard.navigationWork();
            if (blocked != null) {
                status = blocked;
                return true;
            }
            if (tick >= deadline) return stop("finite exit search exhausted");
            if (!body.hasRecentView()) {
                if (!surveying && to == null) status = "supply egress: waiting for a rendered view";
                return true;
            }
            if (driving != 0) return drive();
            if (!dryFieldFooting()) return true; // An existing fall or combat owner can interrupt the job.
            if (!from.equals(c.player.getBlockPos()))
                return stop("left the connected footing before the next crossing");
            if (packedBench != null && has(table.item, benchBefore + 1)) {
                packedBench = null;
                status = "supply egress: recovered the obstructing portable crafting table";
                return true;
            }
            if (!settled(from)) {
                status = "supply egress: centering on the witnessed support";
                if (tick - since >= LOOK_TICKS) return stop("no settled full-width takeoff stance");
                body.centerOnSupport(from.down());
                return true;
            }
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
                if (aim == null) aim = Vec3d.ofBottomCenter(from).add(0, -0.035, 0);
                body.aim(aim);
                switch (body.dryRouteTop(aim, from.down())) {
                    case WITNESSED -> { sourceProved = true; aim = null; }
                    case DARK -> {
                        if (!tryLight()) return stop("takeoff top is too dark to verify");
                    }
                    case FLUID, NO_FULL_TOP -> { return stop("takeoff has no stable, dry full top"); }
                    default -> { }
                }
                if (!sourceProved && !lighting && tick - since >= LOOK_TICKS)
                    return stop("could not witness a stable, dry takeoff top");
                status = "supply egress: verifying the takeoff support";
                return true;
            }
            if (to == null && !choose()) return true;
            status = crossingActivity;
            if (body.hazardAhead(lane.getPositiveHorizontalDegrees(), 1.5))
                return refuse("visible lava near the selected crossing");
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

        private boolean findReturn() {
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
            views = count;
            view = openViews = roofViews = wallViews = 0;
            since = tick;
            aim = null;
        }

        private boolean look() {
            if (outdoors()) return ready("confirmed open ground");
            Direction direction = option(view);
            float yaw = direction.getPositiveHorizontalDegrees();
            int age = tick - since;
            float pitch = age < LOOK_TICKS ? SURVEY_PITCH : age < 2 * LOOK_TICKS ? -13 : -73;
            body.turn(yaw, pitch);
            status = surveyActivity;
            boolean aligned = body.renderedDirection(yaw, pitch, 8);
            if (startReachableTimber(aligned)) return ready("reachable timber from connected footing");
            if (!aligned && age < 3 * LOOK_TICKS) return true;
            int scene = body.supplyPerspective(yaw);
            int bit = 1 << view;
            if ((scene & AgentBody.SUPPLY_OPEN) != 0) openViews |= bit;
            if ((scene & AgentBody.SUPPLY_ROOF) != 0) roofViews |= bit;
            if ((scene & AgentBody.SUPPLY_WALL) != 0) wallViews |= bit;
            if (Integer.bitCount(openViews) >= 2) {
                openFoot = from;
                heading = yaw;
                headingUntil = tick + 125;
                approachGoal = null;
                return ready("confirmed open ground");
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
            laneCuts = 0;
            triedLower = built = false;
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
                    if (!walked.contains(candidate)) {
                        if (flat) flatBearings |= 1 << lane.ordinal();
                        to = candidate;
                        break;
                    }
                }
                if (to == null) {
                    stop("no safe inclined continuation from this stance"
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
            aim = null;
        }

        private boolean proveTop() {
            boolean risingLip = proof == Proof.LIP;
            // This is sampled after the visible side face has opened. A previous
            // obstruction or an opaque face is not evidence of what's behind it.
            body.aim(floor);
            BlockPos support = to.down();
            AgentBody.DryRouteTop top = body.dryRouteTop(floor, support);
            if (top != AgentBody.DryRouteTop.WITNESSED && top != AgentBody.DryRouteTop.FLUID) {
                AgentBody.DryRouteTop other = body.dryRouteTop(alternateFloor, support);
                if (other == AgentBody.DryRouteTop.WITNESSED || other == AgentBody.DryRouteTop.FLUID
                        || top == AgentBody.DryRouteTop.OUT_OF_VIEW) top = other;
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
                case FLUID -> { return refuse("fluid covers the observed supporting top at " + support.toShortString()); }
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
                        if (tryFootholdAfterLower()) return true;
                        return refuse("not enough visible light to identify the supporting top at " + support.toShortString());
                    }
                }
                default -> { }
            }
            return tick - since < LOOK_TICKS || tryFootholdAfterLower()
                || refuse("supporting top still occluded after opening the side face at " + support.toShortString());
        }

        private boolean tryFootholdAfterLower() {
            if (!triedLower || returning || to.getY() >= from.getY()) return false;
            to = to.up();
            setCrossing();
            return beginFoothold();
        }

        private boolean beginFoothold() {
            if (builds >= MAX_FOOTHOLDS || hands.count(COBBLE_FOOTHOLD) <= FOOTHOLD_RESERVE)
                return refuse("no stable landing and no spare foothold block within the placement limit");
            if (walked.contains(to) || protectRecoveryBlock(to.down()) || !offWorkshopPassage(to.down()))
                return refuse("no stable landing and the proposed foothold would occupy protected footing");
            buildLow = AgentBody.footholdInterior(to.down(), lane, false);
            buildHigh = AgentBody.footholdInterior(to.down(), lane, true);
            phase(Proof.FOOTHOLD_SPACE);
            return true;
        }

        private boolean proveBuildSpace() {
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

        private boolean confirmFoothold() {
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
                default -> { throw new IllegalStateException("Not a clearance proof: " + proof); }
            }
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
                case FLUID -> { return refuse("fluid in " + area() + " at " + cell.toShortString()); }
                case DARK -> {
                    if (body.renderedAim(aim, 8) && !tryLight()) {
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
                return refuse(hit == null ? "could not witness " + area() + " at " + cell.toShortString()
                    : "occluded " + area() + " behind " + hit.getBlockPos().toShortString());
            }
            if (triedLower && !returning && rise < 0) return tryFootholdAfterLower();
            if (built) return refuse("freshly placed foothold still lacks visible standing clearance");
            if (tick - since >= CUT_TICKS) return refuse("no confirmed break in " + area() + " at " + cell.toShortString());
            return cutFace(cell, hit);
        }

        private String area() {
            return switch (proof) {
                case OPENING -> "side face";
                case CROWN -> "takeoff crown";
                case HEAD -> "landing headroom";
                case FOOT -> "landing foot space";
                default -> "support";
            };
        }

        private boolean cutFace(BlockPos cell, BlockHitResult hit) {
            BlockState material = state(hit);
            boolean ownBench = material.isOf(table.block) && memory.ownsWorkbench(c.world, cell);
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
            if (cover != null && cover.getBlockPos().getY() > cell.getY()
                    && (state(cover).getBlock() instanceof net.minecraft.block.FallingBlock || dangerous(state(cover))
                        || !state(cover).getFluidState().isEmpty()))
                return refuse("visible falling material or fluid over " + cell.toShortString());
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

        private boolean drive() {
            var veto = body.dryRouteVeto(from, to);
            if (veto != AgentBody.DryRouteVeto.CLEAR) return refuse(vetoReason(veto));
            if (settled(to)) {
                BlockPos old = from;
                from = to;
                walked.add(from);
                caves.walkedDry(old, from);
                caves.witnessedDry(from, old);
                if (from.getY() > old.getY()) {
                    rises++;
                    stallGuard.navigationArrival(old, from);
                    status = "supply egress rise " + rises + ": " + old.toShortString()
                        + " -> " + from.toShortString() + " (settled; return connected)";
                } else {
                    if (!returning && from.getY() < old.getY()) connectors++;
                    else if (!returning) levels++;
                    status = "supply egress: settled connected footing at " + from.toShortString();
                }
                walkedReturn |= returning;
                boolean reachedReturnEnd = returning && --back <= backEnd;
                if (reachedReturnEnd) returning = false;
                to = null;
                driving = 0;
                firstRefusal = lastRefusal = null;
                sourceProved = true;
                triedLight = false;
                bearing = lane;
                survey(reachedReturnEnd ? 4 : 1);
                return true;
            }
            if (tick - driving >= 45) return refuse("ordinary jump or walk did not settle on the witnessed top");
            if (dryFieldFooting() && to.equals(c.player.getBlockPos())) {
                body.centerOnSupport(to.down());
                return true;
            }
            boolean jump = to.getY() > from.getY() && dryFieldFooting() && from.equals(c.player.getBlockPos());
            if (jump && body.jumpBlocked(lane.getPositiveHorizontalDegrees()))
                return refuse("the ordinary jump was blocked by headroom");
            body.driveDryRoute(from, to, lane);
            return true;
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
            if (!settled(from) && driving != 0) return stop(lastRefusal);
            to = null;
            armedCut = null;
            driving = 0;
            returning = false;
            status = "supply egress: rejected " + lastRefusal;
            return true;
        }

        private boolean ready(String why) {
            int index = trail.lastIndexOf(from);
            if (walkedReturn && index >= 0 && index + 1 < trail.size()) {
                resumeIndex = index + 1;
                resumeStep = -1;
                supplyExcursion.reset();
            }
            status = "supply egress: " + why + " at " + from.toShortString();
            from = to = null;
            return true;
        }

        private boolean stop(String why) {
            body.pauseWork();
            armedCut = null;
            blocked = status = "supply egress blocked at " + from.toShortString() + ": " + why
                + (packedBench == null ? "" : "; no safe pickup reached for the portable crafting table");
            return true;
        }
    }

    private boolean tendTimber() {
        BlockPos stem = timberWitness.getBlockPos();
        Vec3d feet = c.player.getPos();
        double reach = c.player.getBlockInteractionRange();
        Vec3d base = new Vec3d(stem.getX() + 0.5, feet.y + 0.65, stem.getZ() + 0.5);
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
                beginTimberChop(hit, false);
                return true;
            }
        }
        double distance = horizontalDistance(feet, base);
        if (!timberNear && distance > 2.8) {
            status = "approaching the witnessed trunk";
            if (distance <= 5.3 && timberApproachSince == 0) timberApproachSince = tick;
            if ((timberApproachSince == 0 || tick - timberApproachSince < 48)
                && approach(base, false, false) != Walk.BLOCKED) return true;
            if (distance > 5.3)
                return startTimberReposition(yaw(base.subtract(feet))) || finishTimber("timber target exhausted: approach blocked");
        }
        timberNear = true;
        return scanTimberStem(base, distance);
    }

    private boolean scanTimberStem(Vec3d base, double distance) {
        Vec3d feet = c.player.getPos();
        BlockPos stem = timberWitness.getBlockPos();
        if (timberScan >= 3)
            return startTimberReposition(yaw(base.subtract(feet))) || finishTimber("timber target exhausted: no safe stand");
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
                beginTimberChop(hit, false);
                return true;
            }
            if (timberLeafCuts < 2 && (y == next.getY() || y == next.getY() + 1) && isTimberPassage(hit)
                && hit.getBlockPos().getSquaredDistance(next) <= 4) mask = hit;
        }
        if (timberLastCut == null) {
            Vec3d point = timberAim(timberWitness);
            BlockHitResult hit = perceive(point, eye.distanceTo(point) + 0.06);
            if (hit != null && hit.getBlockPos().equals(stem) && timberInReach(hit) && state(hit).isIn(BlockTags.LOGS)
                && !timberUnderfoot(stem)) {
                beginTimberChop(hit, false);
                return true;
            }
        }
        Vec3d above = Vec3d.ofCenter(next);
        if (timberLastCut != null && eye.squaredDistanceTo(above) < reach * reach
            && body.clearTerrain(above)) return finishTimber(null);
        if (mask != null) {
            beginTimberChop(mask, true);
            return true;
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
        if (!player.isOnGround() || body.jumpBlocked()) return false;
        double eyeHeight = player.getEyePos().y - player.getY();
        double range = player.getBlockInteractionRange();
        BlockHitResult floor = body.find(state -> !state.isOf(Blocks.CRAFTING_TABLE) && !state.isOf(Blocks.FURNACE)
            && !state.isIn(BlockTags.LOGS) && !state.isIn(BlockTags.LEAVES), 3.25, hit -> {
                BlockPos to = hit.getBlockPos().up();
                return hit.getSide() == Direction.UP && to.getY() == from.getY() + 1 && adjacent(from, to)
                    && !triedTimberFooting.contains(to) && safeSupport(hit)
                    && Vec3d.ofBottomCenter(to).add(0, eyeHeight, 0).squaredDistanceTo(log.getPos()) <= range * range;
            }).orElse(null);
        if (floor == null) return false;
        timberExitFrom = from;
        timberExitTo = floor.getBlockPos().up();
        rememberTimberSite(triedTimberFooting, timberExitTo);
        timberHigherShelf = true;
        timberExitCheck = 0;
        timberExitUntil = tick + 44;
        status = "timber reposition: trying one visible higher shelf";
        return true;
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
        timberWitness = null;
        timberLastCut = null;
        timberDropUntil = 0;
    }

    private static void rememberTimberSite(List<BlockPos> sites, BlockPos block) {
        if (sites.size() == TIMBER_RECENT) sites.removeFirst();
        sites.add(block);
    }

    private boolean startTimberReposition(float bearing) {
        if (!c.player.isOnGround()) return false;
        BlockPos from = c.player.getBlockPos();
        if (triedTimberFooting.contains(from)) return false;
        rememberTimberSite(triedTimberFooting, from);
        timberExitFrom = from;
        timberHigherShelf = false;
        float yaw = c.player.getYaw();
        timberExitYaw = yaw + MathHelper.clamp(MathHelper.wrapDegrees(bearing - yaw), -34, 34);
        timberExitUntil = tick + 18;
        return repositionForTimber();
    }

    /** Commit to one observed landing, with at most one glance to bring the floor into view. */
    private boolean repositionForTimber() {
        if (timberExitTo != null && arrived(timberExitTo)) {
            timberExitFrom = timberExitTo = null;
            timberCanopy = null;
            timberNear = false;
            timberScan = timberApproachSince = 0;
            timberWorkUntil = tick + TIMBER_WORK_TICKS;
            approachGoal = null;
            status = "timber reposition: reached verified footing";
            return true;
        }
        if (timberExitTo == null) {
            BlockHitResult floor = body.find(state -> !state.isOf(Blocks.CRAFTING_TABLE) && !state.isOf(Blocks.FURNACE)
                && !state.isIn(BlockTags.LOGS) && !state.isIn(BlockTags.LEAVES), 4.2, this::timberLanding).orElse(null);
            if (floor == null) {
                if (tick >= timberExitUntil) return rejectTimberExit("no visible landing");
                body.turn(timberExitYaw, 36);
                status = "timber reposition: brief look for visible footing";
                return true;
            }
            timberExitTo = floor.getBlockPos().up();
            rememberTimberSite(triedTimberFooting, timberExitTo);
            timberExitCheck = 0;
            timberExitUntil = tick + 72;
            approachGoal = null;
        }
        if (tick >= timberExitUntil) return rejectTimberExit("route deadline");
        boolean rising = timberExitTo.getY() > timberExitFrom.getY();
        Vec3d landing = Vec3d.ofBottomCenter(timberExitTo);
        if (!adjacent(timberExitFrom, timberExitTo)) {
            if (approach(landing, false, false) == Walk.BLOCKED) return rejectTimberExit("open route blocked");
            status = "timber reposition: walking toward observed open ground";
            return true;
        }
        if (timberExitCheck < 3) {
            BlockPos cell = switch (timberExitCheck) {
                case 0 -> timberExitFrom.up(2);
                case 1 -> timberExitTo.up();
                default -> timberExitTo;
            };
            Vec3d point = Vec3d.ofCenter(cell);
            if (timberExitCheck == 0) point = point.add((timberExitTo.getX() - timberExitFrom.getX()) * 0.23, 0,
                (timberExitTo.getZ() - timberExitFrom.getZ()) * 0.23);
            body.aim(point);
            status = "timber reposition: verifying shelf clearance";
            if (body.aligned(point) && body.clearTerrain(point)) {
                timberExitCheck++;
                return true;
            }
            BlockHitResult obstacle = perceive(point, c.player.getEyePos().distanceTo(point) + 0.05);
            if (obstacle == null) return true;
            BlockPos block = obstacle.getBlockPos();
            BlockState material = state(obstacle);
            if (timberHigherShelf || !block.equals(cell) || protectRecoveryBlock(block)
                || !material.isIn(BlockTags.DIRT) && !material.isIn(BlockTags.LEAVES))
                return rejectTimberExit("shelf clearance blocked");
            status = "timber reposition: clearing a visible dirt or leaf obstruction";
            body.aimContact(obstacle, AgentBody.Contact.MINE);
            if (readyForMine(material)) body.mine(obstacle);
            return true;
        }
        Vec3d toward = landing.subtract(c.player.getPos());
        if (toward.horizontalLengthSquared() < 0.075 && !c.player.isOnGround()) return true;
        float bearing = yaw(toward);
        body.turn(bearing, rising ? -6 : 16);
        status = rising ? "timber reposition: jumping onto the verified shelf" : "timber reposition: walking to verified footing";
        if (Math.abs(MathHelper.wrapDegrees(bearing - c.player.getYaw())) > 11) return true;
        if (rising) {
            if (body.jumpBlocked()) return rejectTimberExit("shelf jump obstructed");
            body.jump();
        }
        walkDown(false);
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
        if (timberHigherShelf) clearTimberWitness();
        else if (timberWitness != null) finishTimber(null);
        status = "timber reposition: " + reason;
        return true;
    }

    private boolean isTimberPassage(BlockHitResult hit) {
        return timberInReach(hit) && state(hit).isIn(BlockTags.LEAVES) && !timberUnderfoot(hit.getBlockPos());
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
        timberAttack = 0;
        timberAlignUntil = tick + 34;
        timberChopUntil = tick + 110;
        if (leaves) timberLeafCuts++;
    }

    private boolean continueTimberAttack() {
        if (timberChop == null || timberAttack == 0 || timberAttack != tick - 1
                || tick - timberAttackWitnessTick > 3 || tick >= timberChopUntil) return false;
        BlockPos block = timberChop.getBlockPos();
        if (timberUnderfoot(block) || !body.continueMine(block)) return false;
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
        body.aim(timberChopPoint);
        BlockHitResult hit = perceive(timberChopPoint, c.player.getEyePos().distanceTo(timberChopPoint) + 0.08);
        if (hit != null && hit.getBlockPos().equals(block)) {
            BlockState material = state(hit);
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
                else if (!toolReady) body.awaitingContactEquipment();
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
                timberDropUntil = tick + 19;
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

    private void setTarget(BlockHitResult hit, Resource resource) {
        target = hit.getBlockPos();
        miningResource = resource;
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
        return !ignored(position) && !position.equals(c.player.getBlockPos().down());
    }

    private void mineTarget(Resource resource) {
        status = "mining " + resource.label;
        if (!reachableResourceFace(target)) {
            abandonTarget();
            return;
        }
        double distance = c.player.getEyePos().distanceTo(targetPoint);
        if (distance < targetNearest - 0.55) {
            targetNearest = distance;
            targetDeadline = tick + 200;
        }
        if (tick >= targetDeadline) {
            abandonTarget();
            return;
        }
        if (distance > REACH - 0.35 && c.player.getY() - target.getY() > 1.25
            && (resource == Resource.STONE || has(TORCH, 2))
            && c.player.isOnGround() && tick >= nextDigStart) {
            status = "cutting a staircase toward exposed " + resource.label;
            excavate(target.getY() + 1, targetPoint);
            return;
        }
        if (distance > REACH - 0.35) {
            status = "approaching " + resource.label;
            if (approach(targetPoint, false, false) == Walk.BLOCKED) abandonTarget();
            return;
        }
        body.aim(targetPoint);
        BlockHitResult hit = perceive(targetPoint, REACH);
        BlockState material = hit != null && hit.getBlockPos().equals(target) ? state(hit) : null;
        if (material == null || !resource.block.test(material)) {
            if (!body.aligned(targetPoint)) return;
            if (lastMining != 0 && tick - lastMining < 5) {
                pickupUntil = tick + 19;
                pickupLook = new Vec3d(targetPoint.x, Math.min(c.player.getY() + 0.35, targetPoint.y), targetPoint.z);
                forgetOreTarget();
                target = null;
            } else if (horizontalDistance(c.player.getPos(), targetPoint) > 0.72) {
                // A ramp changes the viewing angle; walk around the masking near face before giving up.
                if (approach(targetPoint, false, false) == Walk.BLOCKED) abandonTarget();
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
        return collect(drop, range, true);
    }

    private boolean collect(Predicate<ItemStack> drop, double range, boolean mayDig) {
        if (tick < pickupBlockedUntil && pickupBlockedItem == drop) return false;
        Entity entity;
        if (drop == LOG && timberWitness != null) {
            BlockPos stem = timberWitness.getBlockPos();
            entity = body.visibleEntity(candidate -> candidate instanceof ItemEntity item && LOG.test(item.getStack())
                && Math.abs(item.getX() - stem.getX() - 0.5) <= 2.5
                && Math.abs(item.getZ() - stem.getZ() - 0.5) <= 2.5, range).orElse(null);
        } else {
            entity = body.dropped(drop, range).orElse(null);
        }
        return collectObserved(drop, entity, mayDig);
    }

    private boolean collectObserved(Predicate<ItemStack> drop, Entity entity, boolean mayDig) {
        if (pickupItem == drop && hands.count(drop) > pickupCount) {
            clearPickup();
            if (entity == null) return false;
        }
        if (entity != null) {
            if (pickupEntity != entity) {
                pickupEntity = entity;
                pickupItem = drop;
                pickupCount = hands.count(drop);
                pickupStarted = tick;
                pickupNeedsDetour = false;
            }
            pickupSeen = tick;
            pickupPosition = entity.getPos();
        }
        if (pickupItem != drop || pickupPosition == null) return false;
        if (tick - pickupStarted > (drop == LOG ? 70 : 180) || tick - pickupSeen > (drop == LOG ? 26 : 95)) {
            abandonPickup(drop, 45);
            return false;
        }
        Vec3d position = pickupPosition;
        Vec3d delta = position.subtract(c.player.getPos());
        if (drop == DIAMOND || drop == RAW_IRON || drop == FUEL || drop == STONE) {
            Walk pickup = walkOreDrop(entity, position, delta);
            if (pickup != Walk.BLOCKED) {
                status = "collecting visible drops on supported ground";
                return true;
            }
            // A loose item is not a route. Leave it for reobservation from a later
            // grounded stance rather than excavating or jumping toward its last position.
            abandonPickup(drop, 45);
            status = "leaving the visible drop until there is a supported approach";
            return true;
        }
        if (delta.getY() > 1.45) {
            if (drop == LOG && tick - pickupSeen < 10 && tick - pickupStarted < 26) {
                body.aim(position);
                status = "watching a visible log fall";
                return true;
            }
            clearPickup();
            return false;
        }
        if (delta.getY() < -1.05 && drop != LOG) {
            if (!mayDig) {
                clearPickup();
                return false;
            }
            if ((has(STONE_PICK, 1) || has(IRON_PICK, 1) || has(WOOD_PICK, 1))
                && tick >= nextDigStart && c.player.isOnGround()) {
                status = "cutting a staircase to visible drops";
                excavate(BlockPos.ofFloored(position).getY(), position);
                return true;
            }
        }
        if (delta.horizontalLengthSquared() < 0.22) {
            if (drop == LOG) {
                if (delta.horizontalLengthSquared() > 0.04 && delta.y > -0.75 && delta.y < 0.55) {
                    walkMinedPickup(position);
                } else {
                    body.aim(position);
                }
                status = "collecting a visible log at the trunk base";
            } else {
                body.turn(c.player.getYaw(), delta.y < 0 ? 68 : 35);
            }
            if (delta.getY() > 0.55) {
                if (body.jumpBlocked()) {
                    abandonPickup(drop, 32);
                    return false;
                }
                body.jumpForReach();
            }
            if (entity != null || tick - pickupSeen < 12) return true;
            clearPickup();
            return false;
        }
        if (!pickupNeedsDetour && delta.getY() < 0.85 && delta.getY() > -0.8
            && delta.horizontalLengthSquared() <= 2.15) {
            if (walkMinedPickup(position)) return true;
            pickupNeedsDetour = true;
        }
        if (approach(position, false, false) == Walk.BLOCKED) {
            abandonPickup(drop, drop == LOG ? 8 : 32);
            return false;
        }
        status = "collecting visible drops";
        return true;
    }

    private Walk walkOreDrop(Entity entity, Vec3d point, Vec3d delta) {
        if (!dryFieldFooting()) return Walk.LOOKING;
        if (delta.y < -0.42 || delta.y > 0.65) return Walk.BLOCKED;
        if (entity == null)
            return tick - pickupSeen <= 8 ? Walk.LOOKING : Walk.BLOCKED;
        double distance = Math.sqrt(delta.horizontalLengthSquared());
        if (distance <= 0.48 || !entity.isOnGround()) {
            body.aim(point);
            return Walk.LOOKING; // Wait for a settled visible item or passive pickup.
        }
        float yaw = yaw(delta);
        body.turn(yaw, 48);
        if (!body.renderedDirection(yaw, 48, 5) || bearingDistance(yaw, c.player.getYaw()) > 4)
            return Walk.LOOKING;
        if (body.hazardAhead(yaw, 1.25) || c.player.horizontalCollision || stuck >= 8) return Walk.BLOCKED;
        Vec3d feet = c.player.getPos();
        Vec3d eye = c.player.getEyePos();
        Vec3d lane = forward(c.player.getYaw());
        // Check both the near and braking portions of the actual body-width lane,
        // not the block under the item, which may be beyond a hole.
        double end = Math.min(0.83, distance);
        for (int sample = 1; sample <= 2; sample++) {
            double ahead = end * (sample == 1 ? 0.65 : 1);
            for (int side = -1; side <= 1; side++) {
                Vec3d foot = feet.add(ahead * lane.x + 0.27 * side * lane.z, 0,
                    ahead * lane.z - 0.27 * side * lane.x);
                Vec3d below = foot.add(0, -0.08, 0);
                BlockHitResult floor = terrain(below, eye.distanceTo(below) + 0.06);
                if (floor == null || floor.getSide() != Direction.UP || !safeSupport(floor)
                        || Math.abs(floor.getPos().y - feet.y) > 0.08
                        || horizontalDistance(floor.getPos(), foot) > 0.13
                        || !body.clearTerrain(foot.add(0, 0.40, 0))
                        || !body.clearTerrain(foot.add(0, 1.02, 0))) return Walk.BLOCKED;
            }
        }
        // Crouch prevents a momentum tick at the brink and disables collision auto-jump.
        body.sneak();
        if (c.player.isSneaking()) walk(false);
        return Walk.MOVING;
    }

    private void clearPickup() {
        pickupEntity = null;
        pickupItem = null;
        pickupPosition = null;
    }

    private void abandonPickup(Predicate<ItemStack> drop, int duration) {
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
        private Vec3d lastPoint, waypoint;

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
                        body.aim(lastPoint); // Never move toward a stale sighting.
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
            lastPoint = seen.getPos();
            status = "collecting nearby visible drops after respawn";
            if (waypoint != null && horizontalDistance(c.player.getPos(), waypoint) <= 0.27) waypoint = null;
            if (walkLocal(waypoint != null ? waypoint : lastPoint, waypoint == null) != Walk.BLOCKED) return;
            if (waypoint == null && !triedWalkedTurn) {
                triedWalkedTurn = true;
                waypoint = walkedTurn(lastPoint);
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

        private Walk walkLocal(Vec3d point, boolean toDrop) {
            Vec3d feet = c.player.getPos();
            double distance = horizontalDistance(feet, point);
            if (toDrop && distance <= 0.38) {
                body.aim(point);
                return Walk.LOOKING; // Vanilla collects on contact.
            }
            float bearing = yaw(point.subtract(feet));
            body.turn(bearing, LOOK_DOWN);
            if (bearingDistance(bearing, c.player.getYaw()) > 4 || Math.abs(c.player.getPitch() - LOOK_DOWN) > 5)
                return Walk.LOOKING;
            float facing = c.player.getYaw();
            if (body.hazardAhead(facing, 1.25) || c.player.horizontalCollision || stuck >= 8) return Walk.BLOCKED;
            Vec3d lane = forward(facing);
            Vec3d step = feet.add(lane.multiply(Math.min(distance, 0.85)));
            for (int side = -1; side <= 1; side++) {
                Vec3d edge = step.add(0.28 * side * lane.z, 0, -0.28 * side * lane.x);
                Vec3d below = edge.add(0, -0.08, 0);
                BlockHitResult floor = terrain(below, c.player.getEyePos().distanceTo(below) + 0.10);
                if (floor == null || floor.getSide() != Direction.UP || !safeSupport(floor)
                        || Math.abs(floor.getPos().y - feet.y) > 0.08
                        || horizontalDistance(floor.getPos(), edge) > 0.14
                        || !body.clearTerrain(edge.add(0, 0.40, 0))
                        || !body.clearTerrain(edge.add(0, 1.05, 0))) return Walk.BLOCKED;
            }
            // Use the normal movement and passive pickup path, but don't jump, descend or detour.
            body.sneak();
            walk(false);
            return Walk.MOVING;
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
            body.turn(c.player.getYaw(), c.player.getPitch());
            status = "re-gearing after respawn: " + reason;
        }
    }

    private boolean walkMinedPickup(Vec3d position) {
        Vec3d floor = position.add(0, -0.16, 0);
        body.aim(floor);
        if (!body.aligned(floor)) return true;
        BlockHitResult hit = terrain(floor, 3.1);
        if (hit == null || hit.getSide() != Direction.UP || !safeSupport(hit)
            || Math.abs(hit.getPos().y - c.player.getY()) > 0.3
            || horizontalDistance(hit.getPos(), position) > 0.36) return false;
        walkDown(false);
        return true;
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
        private final BlockPos[] visited = new BlockPos[24];
        private final List<BlockPos> route = new ArrayList<>(24);
        private final List<BlockPos> rejected = new ArrayList<>(16);
        private final List<BlockPos> triedLeaves = new ArrayList<>(6);
        private BlockPos entrance, from, to;
        private BlockPos cut;
        private Vec3d cutAim;
        private boolean natural;
        private int view, since, proof, cuts, cutSince, visitedCursor, backtracks, equippedCheck;
        private float surveyYaw;

        private boolean findingGround() {
            return from != null && entrance == null && activeTrail() < 4;
        }

        private void abandon() {
            from = to = cut = null;
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
                to = cut = null;
                explore();
                return true;
            }
            if (to != null && proof == 4) return traverse();
            if (!c.player.isOnGround()) return true;
            if (!standing.equals(from)) {
                recordStance(standing);
                rejected.clear();
                from = standing;
                to = cut = null;
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
            if (tools.readyFor(state)) body.mine(obstruction);
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
                    if (tools.readyFor(observed)) body.mine(seen);
                }
            }
            return true;
        }

        private boolean eligibleLeaf(BlockPos leaf, BlockState state) {
            return cuts < 6 && !protectRecoveryBlock(leaf) && state.isIn(BlockTags.LEAVES)
                && state.getFluidState().isEmpty() && state.contains(LeavesBlock.PERSISTENT)
                && !state.get(LeavesBlock.PERSISTENT);
        }

        private boolean traverse() {
            Vec3d landing = Vec3d.ofBottomCenter(to);
            Vec3d delta = landing.subtract(c.player.getPos());
            if (arrived(to)) {
                if (!visited(to)) stallGuard.reachedNewSurfaceFooting(to);
                if (natural) {
                    entrance = to;
                    // Old unverified surface waypoints are not a connected mine entrance.
                    memory.detach(c.world, trail, to);
                    trail.clear();
                    status = "reached natural footing for the mine entrance";
                }
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

        private void reject() {
            rejected.add(to);
            to = null;
            since = tick;
        }

        private void broken(BlockPos position, BlockState state) {
            if (!state.isIn(BlockTags.LEAVES)) return;
            if (position.equals(cut)) {
                cuts++;
                cut = null;
            } else if (to != null && proof < 4 && sameStem(position, to)) cuts++;
        }
    }

    private int stationWaypoint(BlockPos position) {
        Vec3d station = Vec3d.ofCenter(position);
        double nearest = 3.55 * 3.55;
        int bench = -1;
        // Traverse only the prefix between the player's current position and the entrance.
        for (int i = activeTrail() - 2; i >= 0; i--) {
            BlockPos waypoint = trail.get(i);
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
        if (nextFoot == null && (surfaceApproach.step(standing) || !c.player.isOnGround())) return;
        boolean returnableDescent = nextFoot == null && toward == null && !lavaProspecting
            && (standing.getY() > depth || returnableMine.unjoined(standing))
            && (sought == Resource.DIAMOND || sought == Resource.IRON) && (has(DEEP_PICK, 1) || has(STONE_PICK, 1));
        if (returnableDescent && returnableMine.unjoined(standing)) {
            workReturnableMine(standing, depth);
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
            digDirection = c.player.getHorizontalFacing();
            branchTurns = failedDirections = legLength = stairLength = deadEnds = litIndex = 0;
            torchAttempt = torchFace = torchUsed = 0;
            closedDig.clear();
        }
        BlockPos current = trail.getLast();
        if (returnableDescent) {
            workReturnableMine(current, depth);
            return;
        }
        if (current.getY() > depth) status = "descending a mined staircase";
        else status = "branch mining at y=" + current.getY();
        if (nextFoot == null) {
            if (shouldLight(false)) return;
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
            nextStepProved = true;
            if (body.beginObservedStep(hit, floor)) rememberMotion();
            else walkDown(false);
        } else if (followObservedShelf(current, direction)) {
            status = "following a witnessed shelf in the mine";
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
        Direction preferred = digDirection == null ? c.player.getHorizontalFacing() : digDirection;
        AgentReturnableMine.Outcome outcome = returnableMine.step(this, current, depth, preferred);
        if (!returnableMine.surveyingCave()) status = returnableMine.status();
        if (outcome == AgentReturnableMine.Outcome.SUPPLIES) seekExpeditionSupplies("returnable mine supplies");
        else if (outcome == AgentReturnableMine.Outcome.EXHAUSTED
                && !returnableNearbyAnchor(current)) localBlock = status;
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

    boolean continueMineCaveSurvey(Direction bearing) {
        if (caves.active()) return surveyCave(null);
        return surveyDryForMine(c.player.getBlockPos(), bearing);
    }

    boolean endMineCaveSurvey() { return caves.cancelStationaryDrySurvey(tick); }

    boolean mineCaveHandedOff() { return caveRetreat.shaft != null || target != null; }

    private boolean returnableNearbyAnchor(BlockPos current) {
        if (returnableMine.unjoined(current)) return false;
        int index = trail.lastIndexOf(current);
        if (index < 2 || index != activeTrail() - 1 || returnIndex >= 0 || resumeIndex >= 0) return false;
        BlockPos previous = trail.get(index - 1);
        int horizontal = Math.abs(previous.getX() - current.getX()) + Math.abs(previous.getZ() - current.getZ());
        // Do not infer a route across a fall, fluid link, or recovery's vertical pillar.
        // Only an exact previously proved mine pair may seed this fallback.
        if (horizontal != 1 || !dugSteps.get(index)) return false;
        startReturn(index - 1, false);
        if (returnIndex < 0) return false;
        status = "returning on verified mine treads to look for another anchor";
        return true;
    }

    int returnableTorches() { return hands.count(TORCH); }

    int returnableToolUses() { return pickUses(RETURNABLE_PICKS); }

    void rememberReturnableMotion() { rememberMotion(); }

    void recordReturnableDrop(BlockPos from, BlockPos to, Direction bearing) {
        recordReturnableLevel(from, to, bearing);
        returnableDrop = new ReturnableDrop(returnableDrop == null ? 1 : returnableDrop.sequence() + 1,
            from, to, body.actionTick());
        stairLength++;
    }

    void recordReturnableLevel(BlockPos from, BlockPos to, Direction bearing) {
        if (!trail.isEmpty() && from.equals(trail.getLast())) appendGrounded(to, true);
        caves.walkedDry(from, to);
        caves.witnessedDry(to, from);
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
            && c.player.getEyePos().squaredDistanceTo(hit.getPos()) <= (REACH - 0.40) * (REACH - 0.40);
    }

    boolean returnableCutAllowed(BlockHitResult hit) {
        return returnableFace(hit) == AgentReturnableMine.Face.MINEABLE;
    }

    AgentReturnableMine.Face returnableFace(BlockHitResult hit) {
        return returnableFace(hit.getBlockPos(), state(hit));
    }

    private boolean returnableCutAllowed(BlockPos position, BlockState observed) {
        return returnableFace(position, observed) == AgentReturnableMine.Face.MINEABLE;
    }

    private AgentReturnableMine.Face returnableFace(BlockPos position, BlockState observed) {
        if (underMineFootprint(position)) return AgentReturnableMine.Face.FOOTPRINT;
        if (protectRecoveryBlock(position)) return AgentReturnableMine.Face.PROTECTED;
        if (!observed.getFluidState().isEmpty()) return AgentReturnableMine.Face.FLUID;
        if (observed.getBlock() instanceof net.minecraft.block.FallingBlock || dangerous(observed)
                || !(observed.isIn(BlockTags.BASE_STONE_OVERWORLD) || observed.isIn(BlockTags.DIRT)
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
        if (tick - pendingStairLightSince > 8) {
            pendingStairLight = null;
        } else if (hands.count(TORCH) < pendingStairTorchCount) {
            Vec3d point = Vec3d.ofCenter(pendingStairLight, 0.31);
            BlockHitResult hit = perceive(point, c.player.getEyePos().distanceTo(point) + 0.05);
            if (hit != null && hit.getBlockPos().equals(pendingStairLight) && state(hit).isOf(Blocks.TORCH)) {
                stallGuard.stairLightReceipt(pendingStairLight);
                pendingStairLight = null;
            }
        }
    }

    private boolean lightStair(BlockPos current) {
        return lightStair(current, digDirection);
    }

    void startReturnableLight() {
        torchAttempt = tick;
        torchFace = torchUsed = 0;
    }

    Dig lightReturnableStair(BlockPos foot, Direction bearing) {
        if (lightStair(foot, bearing)) return Dig.LOOKING;
        return torchPlacedTick == tick ? Dig.CLEAR : Dig.BLOCKED;
    }

    private boolean lightStair(BlockPos current, Direction bearing) {
        status = "lighting the current stair before cutting further";
        if (torchUsed != 0) {
            if (hands.count(TORCH) < torchBefore) {
                torchAttempt = torchFace = torchUsed = 0;
                litIndex = trail.size();
                torchPlacedTick = tick;
                return false;
            }
            if (tick - torchUsed < 8) return true;
            torchUsed = 0;
        }
        if (tick - torchAttempt >= 50 || !has(TORCH, 1)) {
            torchAttempt = torchFace = 0;
            return false;
        }
        if (!c.player.isOnGround() || !hands.equipForUse(TORCH)) return true;
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
        if (hit != null && hit.getSide() == Direction.UP && hit.getBlockPos().equals(current.down())) {
            // Ground contact proves this support; the rendered outline proves the usable face.
            body.aimContact(hit, mode);
            if (!c.player.isSneaking() || !body.useContact(hit, mode)) return true;
            torchBefore = hands.count(TORCH);
            torchUsed = tick;
            pendingStairLight = current;
            pendingStairLightSince = tick;
            pendingStairTorchCount = torchBefore;
        }
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
        return clear(position, point, lip, false, false);
    }

    Dig clearReturnable(BlockPos position, Vec3d point) {
        return clear(position, point, null, true, true);
    }

    Dig clearReturnableHeadroom(BlockPos position, Vec3d point) {
        return clear(position, point, null, true, false);
    }

    private Dig clear(BlockPos position, Vec3d point, BlockPos lip, boolean returnable, boolean resourceHandoff) {
        if (returnable && underMineFootprint(position)) return Dig.BLOCKED;
        body.aim(point);
        double length = c.player.getEyePos().distanceTo(point);
        BlockHitResult hit = perceive(point, length + 0.18);
        boolean stair = returnable || nextFoot != null;
        if (hit == null) {
            if (stair && position.equals(witnessedStairCut) && tick - witnessedStairCutTick <= 3) {
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
            if (resourceHandoff && handoffReturnableResource(hit)) return Dig.RESOURCE;
            if (state.isReplaceable() && state.getFluidState().isEmpty() && !dangerous(state))
                return returnableClearance(point);
            if (!returnableCutAllowed(position, state)) return Dig.BLOCKED;
            Vec3d above = Vec3d.ofCenter(position.up(), 0.20);
            BlockHitResult cover = perceive(above, c.player.getEyePos().distanceTo(above) + 0.04);
            if (cover != null && cover.getBlockPos().equals(position.up())
                    && state(cover).getBlock() instanceof net.minecraft.block.FallingBlock) return Dig.BLOCKED;
        }
        if (state.isReplaceable() && state.getFluidState().isEmpty() && !state.isOf(Blocks.SNOW)) return Dig.CLEAR;
        if (dangerous(state) || !state.getFluidState().isEmpty()
            || state.getHardness(c.world, position) < 0 || state.isOf(Blocks.OBSIDIAN)
            || state.isOf(Blocks.CRYING_OBSIDIAN) || state.isOf(Blocks.CRAFTING_TABLE)
            || state.isOf(Blocks.FURNACE)) return Dig.BLOCKED;
        if (!tools.canHarvest(state)) return Dig.BLOCKED;
        body.aimContact(hit, AgentBody.Contact.MINE);
        if (!readyForMine(state)) return Dig.LOOKING;
        if (body.mine(hit) && stair) {
            witnessedStairCut = position;
            witnessedStairCutTick = tick;
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
            if (mouths.contains(mouth)) return false;
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
            startReturn(back, false);
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
            returnIndex = -1;
            exitStart = exitTo = null;
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

    private void beginReturn() {
        beginReturn(false);
    }

    private void beginReturn(boolean preserve) {
        startReturn(0, preserve);
    }

    private void startReturn(int index, boolean preserve) {
        int last = activeTrail() - 1;
        if (last < index) return;
        tableReturn = null;
        workshopReturn = null;
        returnIndex = last;
        returnTo = index;
        returnDetour = null;
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

    private void retreatTunnel() {
        status = "returning along traveled steps";
        if (returnIndex < 0) return;
        BlockPos next = trail.get(returnIndex);
        if (arrived(next)) {
            stallGuard.followedMineWaypoint();
            returnAge = tick;
            returnClear = -1;
            climbTo = null;
            returnDetour = null;
            if (returnIndex > returnTo) {
                next = trail.get(--returnIndex);
            } else {
                finishReturn();
                return;
            }
        }
        if (workshopReturn == null && tick - returnAge > 165) {
            if (!replaceTableAfterFailedReturn())
                startExitRecovery(directional(Vec3d.ofBottomCenter(next).subtract(c.player.getPos())));
            return;
        }
        BlockPos current = returnDetour != null ? returnDetour
            : returnIndex + 1 < trail.size() ? trail.get(returnIndex + 1) : c.player.getBlockPos();
        if (workshopReturn != null) {
            Station station = workshopReturn;
            status = "retracing walked footing for " + station.recipe;
            boolean wet = c.player.isTouchingWater();
            boolean expired = tick - returnAge > 55;
            if (!wet && !expired && driveKnownStep(current, next) != Walk.BLOCKED) return;
            String reason = wet ? "the retreat became wet" : expired ? "the retrace did not settle in time"
                : gaitStepProof ? "the witnessed landing could not be reached safely"
                    : "the recorded tread had no visible safe support";
            workshopReturn = null;
            returnIndex = -1;
            body.prioritizeMovement();
            int reached = trail.lastIndexOf(c.player.getBlockPos());
            resumeIndex = reached >= 0 && reached + 1 < trail.size() ? reached + 1 : -1;
            resumeStep = -1;
            blockStation(station, "cannot reposition " + station.recipe + " toward " + next.toShortString()
                + ": " + reason);
            return;
        }
        if (caves.followWater(current, next, tick)) {
            status = caves.status();
            return;
        }
        if (forcedLight) {
            if (shouldLight(true)) return;
            forcedLight = false;
        }
        if (returnDetour == null && returnIndex + 1 < trail.size() && dugSteps.get(returnIndex + 1)
            && driveKnownStep(current, next) != Walk.BLOCKED) return;
        if (next.getY() == current.getY() + 1
            && Math.abs(next.getX() - current.getX()) + Math.abs(next.getZ() - current.getZ()) == 1) {
            status = "climbing a traveled step";
            if (climb(current, next) == Walk.BLOCKED) {
                if (has(TORCH, 1) && returnLitIndex != returnIndex && tick - returnAge < 90) {
                    returnLitIndex = returnIndex;
                    forcedLight = true;
                    climbTo = null;
                    return;
                }
                forcedLight = false;
                if (!replaceTableAfterFailedReturn())
                    startExitRecovery(directional(Vec3d.ofBottomCenter(next).subtract(c.player.getPos())));
            }
            return;
        }
        if (returnClear >= 0) {
            Dig result = clear(next.up(returnClear));
            if (result == Dig.DARK && has(TORCH, 1) && returnLitIndex != returnIndex) {
                returnLitIndex = returnIndex;
                forcedLight = true;
            } else if (result != Dig.LOOKING) returnClear--;
            return;
        }
        if (walkMinedStep(next) == Walk.BLOCKED) returnClear = 1;
    }

    private void finishReturn() {
        int index = returnIndex;
        returnIndex = -1;
        tableReturn = null;
        workshopReturn = null;
        gaitStep = null;
        if (keepTrail) {
            resumeIndex = index + 1;
            resumeStep = -1;
            if (refitPickCount >= 0) refitPickUntil = tick + 180;
            supplyExcursion.reset();
        } else if (index > 0) {
            closeDig(trail.get(index + 1));
            trail.subList(index + 1, trail.size()).clear();
            litIndex = Math.min(litIndex, trail.size());
            failedDirections = stairLength = 0;
            digDirection = c.player.getHorizontalFacing().rotateYClockwise();
        } else {
            trail.clear();
            nextDigStart = tick + 95;
            heading = c.player.getYaw() + 75;
            headingUntil = tick + 150;
        }
    }

    private boolean replaceTableAfterFailedReturn() {
        TableReturn trip = tableReturn;
        if (trip == null) return false;
        tableReturn = null;
        failedTableReturn = trip.workshop;
        if (!hands.stableCraftFooting() || !affordsWood(trip.planks + (has(table.item, 1) ? 0 : 4), trip.sticks))
            return false;
        // Stop the workshop detour, not the mine. Do not invent a connection if the
        // player has left the recorded route during the attempted return.
        int standing = trail.lastIndexOf(c.player.getBlockPos());
        returnIndex = -1;
        returnDetour = climbTo = gaitStep = null;
        resumeIndex = standing >= 0 && standing + 1 < trail.size() ? standing + 1 : -1;
        resumeStep = -1;
        supplyExcursion.reset();
        status = "rechecking local crafting options after the workshop path was blocked";
        return true;
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
        if (!adjacent(from, to) || from.getX() == to.getX() && from.getZ() == to.getZ()) return Walk.BLOCKED;
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
        if (ascending && body.jumpBlocked(heading)) return Walk.BLOCKED;
        if (ascending) body.jump();
        walkDown(false);
        return Walk.MOVING;
    }

    private Walk walkMinedStep(BlockPos next) {
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
        if (body.jumpBlocked(heading) || ++climbDrive > 27) return Walk.BLOCKED;
        body.jump();
        walk(false);
        return Walk.MOVING;
    }

    private void startExitRecovery(Direction heading) {
        if (exitStart != null) return;
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

    private void recoverExit() {
        status = "searching for a visible upward exit";
        if (tick >= exitDeadline) {
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
        if (recoveryVisited.contains(exitLevel ? support : support.up())) {
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
        int rejoin = trail.lastIndexOf(reached);
        boolean rose = reached.getY() > exitFrom.getY();
        if (rose) exitDeadline = tick + 620;
        if (recoveryVisited.size() >= 48) recoveryVisited.removeFirst();
        recoveryVisited.add(reached);
        exitFrom = reached;
        exitTo = null;
        exitSide = pillarStage = pillarStarted = 0;
        exitLevel = false;
        exitClear = 1;
        if (returnIndex >= 0 && rejoin >= 0 && rejoin <= returnIndex) {
            exitStart = null;
            climbTo = null;
            returnIndex = rejoin;
            returnAge = tick;
        } else if (returnIndex > returnTo && rose) {
            // A placed station or a cave lip can occupy one old waypoint. Rejoin from the
            // newly reached support only if the next earlier, traveled cell is a single step away.
            int earlier = returnIndex - 1;
            if (adjacent(reached, trail.get(earlier))) {
                returnDetour = reached;
                returnIndex = earlier;
                returnAge = tick;
                returnClear = -1;
                exitStart = null;
                climbTo = null;
            }
        } else if (returnIndex < 0) {
            exitStart = null;
            climbTo = null;
            sweepOrigin = Vec3d.ofBottomCenter(reached);
            sweepHeading = heading = c.player.getYaw();
            headingUntil = tick + 125;
            sweepIndex = 0;
        }
    }

    private boolean recoverPillar() {
        status = "raising a step on visible support";
        if (pillarStarted == 0) {
            pillarStarted = tick;
            pillarCount = hands.count(BUILDING);
        }
        if (pillarStage == 3 && arrived(exitFrom.up()) && !has(BUILDING, pillarCount)) {
            reachedRecoveryStep(exitFrom.up());
            return true;
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

    private boolean escapeDanger(AgentEars ears, boolean hurt, boolean macroEngaged, Predicate<ItemStack> safetySpend) {
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
                    startReturn(Math.max(0, last - 6), false);
                    for (int i = exit; i <= last; i++) {
                        BlockPos walked = trail.get(i);
                        if (i < last && !adjacent(trail.get(i + 1), walked)) continue;
                        if (body.preferLavaExit(Vec3d.ofBottomCenter(walked))) {
                            // Backtrack from the escape point, not toward the abandoned lip.
                            returnIndex = i;
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
            status = "surfacing for air";
            body.jump();
            body.walk(true);
            return true;
        }
        LivingEntity threat = body.threat(8).orElse(null);
        boolean creeper = threat instanceof CreeperEntity;
        // Defer to the actual fall controller before issuing a ranged brace. Avoid the
        // generic damage turn/backtrack when a ranged shot is the corroborating cue.
        if (!creeper && defense.observeRanged(ears, threat, hurt)) return false;
        if (!macroEngaged && !creeper && tick >= retreatUntil
                && defense.observeMelee(ears, threat, hurt,
                    c.player.getHealth() <= 10 && wantsHealingMeal(), tick)) return false;
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
        boolean flee = threat != null && (creeper || health <= 7 || health <= 10 && wantsHealingMeal()
            || defense.reserveRequiresRetreat(safetySpend));
        if (flee && tick >= retreatUntil - 10) {
            retreatYaw = yaw(c.player.getPos().subtract(threat.getPos()));
            retreatUntil = tick + 15;
        }
        if (tick < retreatUntil) {
            body.prioritizeMovement();
            defense.forgetContact();
            defense.markDanger(tick);
            interruptHands();
            status = creeper ? "backing off a creeper" : flee ? "retreating while hurt" : "clearing room after danger";
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
        if (!(goal.equals("diamond") || portal != null) || nextFoot != null || firing != Firing.NONE
                || !c.player.isOnGround() || c.player.isTouchingWater() || !defense.canPrepare(tick)
                || !has(DEEP_PICK, 1)) return false;
        int reserve = (has(PORTAL_BUCKET, 1) ? 0 : 3) + (has(IGNITER, 1) ? 0 : 1);
        int sparePlanks = hands.count(PLANK) + 4 * hands.count(LOG) - localTableWood();
        boolean beforePortal = !portalStarted && (portal == null || !has(DIAMOND, 3) && !has(DIAMOND_PICK, 1));
        if (!defense.prepare(this, tick, reserve, sparePlanks, hands.count(STICK), beforePortal)) return false;
        if (defense.status() != null) status = defense.status();
        return true;
    }

    private void interruptHands() {
        defense.cancelSelection();
        if (hands.busy()) hands.cancel();
        if (c.currentScreen instanceof HandledScreen<?>) c.currentScreen.close();
    }

    int mealsEaten() { return mealsEaten; }
    int foodPickedUp() { return foodPickedUp; }

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
        int hunger = c.player.getHungerManager().getFoodLevel();
        int before = mealsEaten;
        confirmMeal(hunger);
        if (mealsEaten > before) macro.safetyEffect("emergency meal consumed");
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

    private boolean eatOrHunt() {
        var player = c.player;
        int hunger = player.getHungerManager().getFoodLevel();
        float health = player.getHealth();
        confirmMeal(hunger);
        if (forage != null) {
            int stock = hands.count(FOOD);
            if (stock > forageStock) {
                foodPickedUp += stock - forageStock;
                finishForage(12);
            } else {
                forageStock = stock;
            }
        }
        // The danger handler runs first. A retreat or newly lost health means the
        // lack of a hostile in the current view is not yet a good time to stop.
        if (health < mealHealth) mealQuietUntil = tick + 10;
        if (retreatUntil > 0) mealQuietUntil = Math.max(mealQuietUntil, retreatUntil + 10);
        mealHealth = health;
        if (tick < mealQuietUntil || player.isTouchingWater()) {
            if (forage != null) finishForage(100);
            mealUntil = 0;
            mealItem = null;
            return false;
        }
        if (!player.isOnGround()) return forage != null && tick < forageUntil;
        if (tick >= mealRetry && hunger < 20 && (mealUntil != 0 || hunger <= 14 || canRefuelHealing(hunger))
            && eatMeal(hunger)) return true;
        if ((returnIndex >= 0 || exitStart != null || nextFoot != null || localBlock != null)
                && (!stallGuard.waitingForEvidence() || hunger > 10)) {
            if (forage != null) finishForage(100);
            return false;
        }
        if (forage != null) return continueForage();
        if (tick < forageScan || pickupItem != null && !stallGuard.waitingForEvidence()) return false;
        boolean surface = player.getBlockY() > 48 && activeTrail() <= 1;
        if (hunger > 10 && (!surface || !needsTimberKit() || firing != Firing.NONE)) return false;
        forageScan = tick + 12;
        if (hunger > 10 && foodNutrition() >= FOOD_RESERVE) return false;
        ItemEntity food = visibleMealDrop(false);
        if (food != null) {
            startForage(Forage.DROP, food, null, food.getPos(), 50);
            return continueForage();
        }
        BlockHitResult berries = body.find(RIPE_BERRIES, REACH - 0.25).orElse(null);
        if (berries != null) {
            startForage(Forage.BERRIES, null, berries.getBlockPos(), berries.getPos(), 45);
            return continueForage();
        }
        if (!surface || huntingWeapon() < 0) return false;
        Entity animal = body.visibleEntity(candidate -> edibleAnimal(candidate) && localForagePoint(candidate.getPos())
            && player.getPos().squaredDistanceTo(candidate.getPos()) <= FORAGE_LEASH_SQUARED, 6)
            .orElse(null);
        if (animal == null) return false;
        startForage(Forage.ANIMAL, animal, null, animal.getPos(), 115);
        return continueForage();
    }

    private void confirmMeal(int hunger) {
        if (mealItem == null || hunger <= mealStartHunger) return;
        ItemStack selectedFood = c.player.getInventory().getStack(mealSlot);
        if (selectedFood.isOf(mealItem) && selectedFood.getCount() >= mealCount) return;
        mealsEaten++;
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
            if (allowFlesh && stack.isOf(Items.ROTTEN_FLESH)
                && (emergency < 0 || slot == inv.selectedSlot)) emergency = slot;
            if (!FOOD.test(stack)) continue;
            var food = stack.get(DataComponentTypes.FOOD);
            if (food == null || food.nutrition() <= 0) continue;
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

    private void startForage(Forage purpose, Entity entity, BlockPos bush, Vec3d point, int duration) {
        forage = purpose;
        forageEntity = entity;
        forageBush = bush;
        foragePoint = point;
        forageOrigin = c.player.getPos();
        forageUntil = tick + duration;
        forageSeen = tick;
        forageAction = forageFootingWait = 0;
        forageStock = hands.count(FOOD);
    }

    private boolean continueForage() {
        if (tick >= forageUntil || forage != Forage.BERRIES && !localForagePoint(foragePoint)
            || forageOrigin.squaredDistanceTo(c.player.getPos()) > FORAGE_LEASH_SQUARED) {
            finishForage(100);
            return false;
        }
        boolean active = switch (forage) {
            case DROP -> collectMealDrop();
            case BERRIES -> harvestBerries();
            case ANIMAL -> huntMeal();
        };
        if (!active) finishForage(100);
        return active;
    }

    private void finishForage(int delay) {
        forage = null;
        forageEntity = null;
        forageBush = null;
        foragePoint = forageOrigin = null;
        forageScan = tick + delay;
    }

    private boolean localForagePoint(Vec3d point) {
        return Math.abs(point.y - c.player.getY()) <= 1.2
            && (forageOrigin == null || forageOrigin.squaredDistanceTo(point) <= FORAGE_LEASH_SQUARED);
    }

    private ItemEntity visibleMealDrop(boolean meatOnly) {
        return (ItemEntity) body.visibleEntity(candidate -> candidate instanceof ItemEntity drop
            && localForagePoint(drop.getPos()) && FOOD.test(drop.getStack())
            && (!meatOnly || freshMeat(drop.getStack()))
            && (foragePoint == null || drop.getPos().squaredDistanceTo(foragePoint) <= 9), 6)
            .orElse(null);
    }

    private static boolean freshMeat(ItemStack stack) {
        return stack.isOf(Items.BEEF) || stack.isOf(Items.PORKCHOP) || stack.isOf(Items.MUTTON)
            || stack.isOf(Items.RABBIT) || stack.isOf(Items.COOKED_BEEF) || stack.isOf(Items.COOKED_PORKCHOP)
            || stack.isOf(Items.COOKED_MUTTON) || stack.isOf(Items.COOKED_RABBIT);
    }

    private boolean collectMealDrop() {
        Entity seen = body.visibleEntity(candidate -> candidate == forageEntity, 6).orElse(null);
        if (seen == null) {
            if (tick - forageSeen > 14) return false;
            body.aim(foragePoint);
            status = "looking for the visible food drop";
            return true;
        }
        Vec3d pos = seen.getPos();
        if (!localForagePoint(pos)) return false;
        foragePoint = pos;
        forageSeen = tick;
        status = "collecting visible food";
        double distance = horizontalDistance(c.player.getPos(), pos);
        if (distance <= 0.38) {
            body.aim(pos);
            return true;
        }
        if (distance <= 1.2) {
            if (dangerInForageLane(pos.add(0, 0.25, 0))) return false;
            if (walkMinedPickup(pos)) return true;
        }
        return advanceForage(pos);
    }

    private boolean lookForMealDrop(boolean meatOnly) {
        ItemEntity food = visibleMealDrop(meatOnly);
        if (food == null) return false;
        forage = Forage.DROP;
        forageEntity = food;
        foragePoint = food.getPos();
        forageSeen = tick;
        forageFootingWait = 0;
        forageUntil = Math.max(forageUntil, tick + 26);
        return true;
    }

    private boolean harvestBerries() {
        if (forageAction != 0 && lookForMealDrop(false)) return true;
        BlockHitResult hit = perceive(foragePoint, REACH);
        if (hit != null && hit.getBlockPos().equals(forageBush) && RIPE_BERRIES.test(state(hit))) {
            body.aimContact(hit, AgentBody.Contact.INTERACT);
            if ((forageAction == 0 || tick - forageAction >= 9) && body.useContact(hit, AgentBody.Contact.INTERACT)) {
                forageAction = tick;
            }
        } else {
            if (forageAction != 0 && tick - forageAction > 14) return false;
            body.aim(foragePoint);
        }
        status = forageAction == 0 ? "aiming at visible ripe berries" : "harvesting visible berries";
        return true;
    }

    private boolean huntMeal() {
        if (forageAction != 0 && lookForMealDrop(true)) {
            status = "collecting visible meat";
            return true;
        }
        Entity animal = body.visibleEntity(candidate -> candidate == forageEntity && edibleAnimal(candidate), 8).orElse(null);
        if (animal == null) {
            if (tick - forageSeen > (forageAction == 0 ? 12 : 23)) return false;
            body.aim(foragePoint.add(0, forageAction == 0 ? 0.65 : 0.12, 0));
            status = forageAction == 0 ? "looking for the visible animal" : "looking for visible meat drops";
            return true;
        }
        Vec3d pos = animal.getPos();
        if (!localForagePoint(pos)) return false;
        foragePoint = pos;
        forageSeen = tick;
        status = "hunting a visible animal";
        Vec3d point = animal.getBoundingBox().getCenter();
        double range = Math.min(2.8, c.player.getEntityInteractionRange() - 0.1);
        if (c.player.getEyePos().squaredDistanceTo(point) > range * range) return advanceForage(pos);
        body.aim(point);
        int weapon = huntingWeapon();
        if (weapon < 0) return false;
        if (!hands.equipSlot(weapon)) return hands.busy();
        if (body.strikeTarget(animal) && c.player.getAttackCooldownProgress(0.5f) >= 0.9f) {
            body.strike(animal);
            forageAction = tick;
        }
        return true;
    }

    private boolean advanceForage(Vec3d pos) {
        if (stuck >= 12) return false;
        Vec3d feet = c.player.getPos();
        float bearing = yaw(pos.subtract(feet));
        body.lookAlongGait(bearing, 34);
        float facing = c.player.getYaw();
        if (bearingDistance(bearing, facing) > 7 || c.player.getPitch() < 27) return true;
        Vec3d lane = forward(facing);
        if (dangerInForageLane(feet.add(lane.multiply(1.15)).add(0, 0.35, 0))) return false;
        Footing ground = footing(feet, lane, facing, false);
        if (ordinaryFooting(ground)) {
            forageFootingWait = 0;
            walkDown(false);
            return true;
        }
        // Do not choose a detour or an unproven drop for an optional meal.
        return ground == Footing.UNKNOWN && ++forageFootingWait < 12;
    }

    private boolean dangerInForageLane(Vec3d point) {
        BlockHitResult hit = perceive(point, c.player.getEyePos().distanceTo(point) + 0.1);
        return hit != null && dangerous(state(hit));
    }

    private int huntingWeapon() {
        var inv = c.player.getInventory();
        int best = -1;
        double damage = 0;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inv.getStack(slot);
            if ((!AXE.test(stack) && !stack.isIn(ItemTags.SWORDS)) || stack.getMaxDamage() - stack.getDamage() < 2)
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

    private static boolean edibleAnimal(Entity entity) {
        var type = entity.getType();
        return (type == EntityType.COW || type == EntityType.PIG || type == EntityType.SHEEP
            || type == EntityType.MOOSHROOM || type == EntityType.RABBIT)
            && entity instanceof LivingEntity animal && !animal.isBaby() && !animal.isTouchingWater();
    }

    private void explore() {
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
                if (trail.size() > 1) beginReturn();
                else startExitRecovery(directional(forward(sweepHeading)));
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
        Vec3d horizontal = point.subtract(c.player.getPos()).multiply(1, 0, 1);
        if (horizontal.horizontalLengthSquared() < 0.015) return Walk.BLOCKED;
        return step(horizontal.normalize(), sprint, allowWater);
    }

    /** Advance toward the target along a lane selected from the present view. */
    private Walk approach(Vec3d point, boolean sprint, boolean allowWater) {
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
        return walkToward(point, horizontalDistance(feet, point) > sprintDistance
            || sprint && distance > sprintDistance, allowWater);
    }

    /** Fix the gaze on a short route ahead; keep movement contingent on freshly observed footing. */
    private Walk step(Vec3d horizontal, boolean sprint, boolean allowWater) {
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
                if (quality < 0) continue;
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
        if (needsFooting && !landingInProgress && turn <= 5 && body.continueSurfaceStep(facing)) {
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

    private static boolean dangerous(BlockState state) {
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
