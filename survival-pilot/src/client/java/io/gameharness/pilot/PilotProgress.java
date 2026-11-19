package io.gameharness.pilot;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;
import java.util.function.Predicate;
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
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.World;

/** Inventory-driven decisions; coordinates are observations, traveled waypoints or dig intentions. */
final class PilotProgress {
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
    private static final int ORE_MEMORY_LIMIT = 18;
    private static final int TIMBER_WORK_TICKS = 190;
    private static final int TIMBER_RECENT = 24;
    private static final float[] TIMBER_SHELF_BEARINGS = {0, -68, 68};
    private static final int TIMBER_SHELF_LOOK_TICKS = 20;
    private static final int TRAIL_LIMIT = 1024;
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
    private static final Predicate<ItemStack> IGNITER = item(Items.FLINT_AND_STEEL);
    private static final Predicate<ItemStack> FLINT = item(Items.FLINT);
    private static final Predicate<ItemStack> GRAVEL = item(Items.GRAVEL);
    private static final Predicate<ItemStack> GRAVEL_DROPS = s -> GRAVEL.test(s) || FLINT.test(s);
    private static final Predicate<BlockState> GRAVEL_BLOCK = s -> s.isOf(Blocks.GRAVEL);
    private static final Predicate<ItemStack> BOAT = stack -> stack.isIn(ItemTags.BOATS) && !stack.isIn(ItemTags.CHEST_BOATS);
    private static final Predicate<ItemStack> EMPTY_BUCKET = item(Items.BUCKET);
    private static final Predicate<ItemStack> DEEP_PICK = stack -> stack.isOf(Items.IRON_PICKAXE)
        || stack.isOf(Items.DIAMOND_PICKAXE) || stack.isOf(Items.NETHERITE_PICKAXE);
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
            || state.isOf(Blocks.COBBLED_DEEPSLATE) || state.isOf(Blocks.BLACKSTONE), PilotProgress.STONE, "stone"),
        IRON(state -> state.isOf(Blocks.IRON_ORE) || state.isOf(Blocks.DEEPSLATE_IRON_ORE), RAW_IRON, "iron"),
        DIAMOND(state -> state.isOf(Blocks.DIAMOND_ORE) || state.isOf(Blocks.DEEPSLATE_DIAMOND_ORE),
            PilotProgress.DIAMOND, "diamond"),
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
    private enum Dig { LOOKING, CLEAR, BLOCKED, DARK, LIP }
    private enum Firing { NONE, IRON, CHARCOAL }
    private enum Forage { ANIMAL, BERRIES, DROP }

    private record OreSight(Resource resource, BlockPos block, Vec3d point, BlockPos stance, Vec3d feet,
                            double rangeSquared) {}

    private static final class Station {
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
        BlockHitResult face;
        BlockPos rejected, niche, underfoot;
        int siteSince, stageSince, stage;
        int lampBefore, lampUsed;

        Station(Block block, Item item, String recipe) {
            this.block = block;
            this.item = PilotProgress.item(item);
            this.recipe = recipe;
        }
    }

    private final MinecraftClient c;
    private final PilotBody body;
    private final PilotHands hands;
    private final PilotTools tools;
    private final PilotStallGuard stallGuard;
    private final Predicate<BlockPos> protectedHeadroom = this::protectRecoveryBlock;
    private final PilotCaves caves;
    private final SurfaceApproach surfaceApproach = new SurfaceApproach();
    private final PilotFall fall;
    private BlockHitResult fieldWater;
    private Vec3d fieldWaterPoint;
    private int fieldWaterUntil, waterRetry;
    private Resource caveGoal;
    private boolean lavaProspecting, caveLava;
    private BlockPos cavePeek;
    private int caveLookUntil, caveOpenings, caveFootsteps;
    private final PilotDefense defense;
    private final PilotPortal portal;
    private final FieldIgnition fieldIgnition;
    private final PilotMemory memory;
    private boolean memoryAttached;
    private boolean portalStarted;
    private final String goal;
    private final Predicate<ItemStack> goalItem;
    private final Station table = new Station(Blocks.CRAFTING_TABLE, Items.CRAFTING_TABLE, "crafting_table");
    private final Station furnace = new Station(Blocks.FURNACE, Items.FURNACE, "furnace");
    private final FieldBench fieldBench = new FieldBench();
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
    private Firing firing = Firing.NONE;
    private BlockPos furnaceWitness;
    private int furnaceDemand;
    private int furnacePoll;
    private boolean furnaceLoaded;
    private boolean furnaceNeedsFuel;
    private Resource sought;
    private int soughtSince;
    private Resource miningResource;
    private BlockPos target;
    private Vec3d targetPoint;
    private int targetDeadline;
    private double targetNearest;
    private int lastMining;
    private final List<OreSight> oreSights = new ArrayList<>(ORE_MEMORY_LIMIT);
    private ClientWorld oreWorld;
    private OreSight oreProbe;
    private int oreProbeSince;
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
    private BlockHitResult timberWitness;
    private BlockPos timberLastCut;
    private final List<BlockPos> exhaustedStems = new ArrayList<>();
    private final List<BlockPos> unreachableTimber = new ArrayList<>();
    private final List<BlockPos> triedTimberFooting = new ArrayList<>();
    private BlockPos timberExitFrom;
    private BlockPos timberExitTo;
    private int timberExitUntil;
    private int timberExitCheck;
    private float timberExitYaw;
    private boolean timberHigherShelf;
    private int timberShelfLook = TIMBER_SHELF_BEARINGS.length;
    private int timberShelfLookUntil;
    private float timberShelfYaw;
    private BlockHitResult timberChop;
    private Vec3d timberChopPoint;
    private boolean timberCuttingLeaves;
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
    private Direction timberAscent;
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
    private String stopped;
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
    private Vec3d observedLanding;
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
    private BlockPos witnessedStairCut;
    private int witnessedStairCutTick;

    PilotProgress(MinecraftClient c, PilotBody body, PilotHands hands, String goal, PilotMemory memory) {
        this.c = c;
        this.body = body;
        this.hands = hands;
        this.memory = memory;
        tools = new PilotTools(c, hands);
        stallGuard = new PilotStallGuard(c, body, hands, tools, this::protectRecoveryBlock, this::safeSupport,
            this::recordStallFooting);
        caves = new PilotCaves(c, body, hands, tools, this::recordCaveFooting);
        fall = new PilotFall(c, body, hands);
        defense = new PilotDefense(c, body, hands);
        this.goal = goal;
        portal = goal.equals("nether_portal") ? new PilotPortal(c, body, hands, tools) : null;
        fieldIgnition = portal != null ? new FieldIgnition() : null;
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

    String failure() {
        String recoveryFailure = stallGuard.failure();
        if (recoveryFailure != null) return recoveryFailure;
        return stopped != null || portal == null ? stopped : portal.failure();
    }

    PilotStallGuard.Report stallReport() { return stallGuard.report(); }
    void observeOwnBreak(BlockPos position, BlockState state) {
        body.observeHeadroomBreak(position);
        stallGuard.broken(position, state);
        surfaceApproach.broken(position, state);
    }

    int confirmedFrameBlocks() { return portal == null ? 0 : portal.confirmedFrameBlocks(); }
    int castFrameBlocks() { return portal == null ? 0 : portal.confirmedCastFrameBlocks(); }
    int castPassiveBlocks() { return portal == null ? 0 : portal.passiveFrameBlocks(); }
    int castLavaDeposits() { return portal == null ? 0 : portal.depositedLavaSources(); }
    PilotShoreCast.Report shoreCastReport() { return portal == null ? null : portal.shoreCastReport(); }
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
    PilotFall fall() { return fall; }

    private void recordCaveFooting(BlockPos reached) {
        if (c.player == null || !c.player.isOnGround() || !reached.equals(c.player.getBlockPos())) return;
        if (trail.isEmpty() || !reached.equals(trail.getLast())) {
            // Water crossings retain their real endpoints in-session. PilotMemory saves
            // only the connected grounded suffix, never imaginary steps through the air.
            appendGrounded(reached, false);
            caveFootsteps++;
        }
    }

    private boolean surveyCave(BlockPos planned) {
        boolean continuing = caves.active();
        if (!continuing) {
            if (planned == null || digDirection == null) return false;
            caveLava = lavaProspecting;
            caveGoal = sought == Resource.DIAMOND || sought == Resource.IRON || sought == Resource.COAL ? sought
                : has(DEEP_PICK, 1) ? Resource.DIAMOND : Resource.IRON;
        }
        if (caves.step(tick, planned, digDirection, caveLava ? null : caveGoal.block)) {
            if (!continuing) { caveOpenings++; nextFoot = null; cavePeek = null; }
            status = caves.status();
            return true;
        }
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
        return false;
    }

    String status() {
        return status;
    }

    void tick(PilotEars ears) {
        if (win || c.player == null || c.world == null) return;
        tick++;
        if (portal != null) stallGuard.surveyReceipt(portal.castSurveyEvidence());
        stallGuard.observe(tick, confirmedFrameBlocks(), mealsEaten, status);
        advance(ears);
        if (stopped != null) {
            stallGuard.skillBlocked(stopped);
            stopped = null;
            status = stallGuard.status();
        }
    }

    private void advance(PilotEars ears) {
        if (!c.player.isAlive() || c.currentScreen instanceof DeathScreen) {
            status = "died before " + goal;
            return;
        }
        if (portal != null && portal.updateArrival()) {
            win = true;
            status = "entered the Nether through constructed portal";
            return;
        }
        if (goalItem != null && !hands.busy() && c.currentScreen == null && has(goalItem, 1)) {
            win = true;
            status = "obtained " + goal;
            return;
        }
        trackMotion();
        float health = c.player.getHealth();
        boolean hurt = health < previousHealth;
        previousHealth = health;
        if (escapeDanger(hurt)) {
            stallGuard.priorityAim();
            return;
        }
        if (fall.step()) {
            defense.stopZombieLook();
            body.prioritizeMovement();
            stallGuard.priorityAim();
            status = fall.status();
            return;
        }
        if (hands.busy()) return;
        if (handleScreen()) return;
        if (eatOrHunt()) {
            defense.stopZombieLook();
            stallGuard.priorityAim();
            return;
        }
        if (defense.checkZombieCue(ears, tick, nextFoot != null
                || c.options.attackKey.isPressed() && c.interactionManager.isBreakingBlock())) {
            body.prioritizeMovement();
            stallGuard.priorityAim();
            status = defense.status();
            return;
        }
        if (!stallGuard.ownsRecovery() && body.repairHeadroom(tools, protectedHeadroom)) {
            status = body.headroomReport().reason();
            return;
        }
        if (stallGuard.takeTurn(this::replanStalledLocalWork)) {
            body.prioritizeMovement();
            status = stallGuard.status();
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
            return;
        }
        if (caves.active() && surveyCave(null)) return;
        if (fieldBench.packUntil != 0 && fieldBench.pack()) return;
        if (prepareDefense()) return;

        if (fieldIgnition != null && fieldIgnition.active() && fieldIgnition.step()) return;
        if (portal != null && portal.castEligible()) {
            portal.stepCast(this);
            status = portal.status();
            return;
        }
        if (fieldIgnition != null && !portalStarted && !has(DIAMOND, 3) && !has(DIAMOND_PICK, 1)
            && has(IRON_PICK, 1) && fieldIgnition.start()) return;
        if (needsTimberKit() && has(DEEP_PICK, 1) && prepareFieldBucket()) return;
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
        if (!timberReady) {
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
            if (longGoal && surfaceDeparture() && (stonePick || woodPick || ironPick)
                && (pickupItem == LOG || tick < timberDropUntil || shortTimber)) {
                if (pickupItem == LOG || tick < timberDropUntil) seekTimber();
                else if (!has(AXE, 1)) {
                    if (has(STONE, stonePick ? 3 : 6)) requestTable("stone_axe", null, 0, 2);
                    else requestTable("wooden_axe", null, 3, 2);
                } else seekTimber();
                return;
            }
            timberReady = !longGoal || woodPick || stonePick || ironPick;
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
        if (portal != null && nextFoot == null) {
            // The bucket costs three; the dry-bank route sets a fourth ingot aside for ignition.
            int reserve = (has(PORTAL_BUCKET, 1) ? 0 : 3) + (has(IGNITER, 1) ? 0 : 1);
            int missing = reserve - hands.count(INGOT);
            if (missing > 0) {
                // Take exposed iron on the way down. Do not spend the whole expedition
                // branch-mining the iron layer for four spare ingots once the pick is ready.
                int raw = hands.count(RAW_IRON);
                if (raw >= Math.min(3, missing)
                        && (canSetLocalFurnace() || localStation(furnace, furnaceWitness))) {
                    acquireIron(reserve);
                    return;
                }
                if (workOre(Resource.DIAMOND, REACH, false)
                        || raw < missing && workOre(Resource.IRON, SEARCH, true)) return;
            }
        }
        mineDiamonds(goal.equals("nether_portal") ? 3 : 1);
    }

    private void replanStalledLocalWork() {
        surfaceApproach.abandon();
        if (fieldIgnition != null && fieldIgnition.active()) fieldIgnition.finish();
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
        timberShelfLook = TIMBER_SHELF_BEARINGS.length;
        if (nextFoot != null) closeDig(nextFoot);
        nextFoot = cavePeek = climbTo = gaitStep = exitStart = exitTo = null;
        approachGoal = routeLegStart = sweepOrigin = null;
        routeTick = -10;
        heading = Float.NaN;
        headingUntil = 0;
    }

    private boolean protectRecoveryBlock(BlockPos block) {
        return supportsTrail(block) || timberUnderfoot(block) || block.equals(table.position)
            || block.equals(furnace.position) || block.equals(furnaceWitness) || block.up().equals(table.position)
            || block.up().equals(furnace.position) || block.up().equals(furnaceWitness);
    }

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
            gather(Resource.IRON, 115, 16);
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
        int height = c.player.getBlockY();
        if (departureKit || height <= 48 || resumeIndex >= 0) return false;
        if (height < 64 && has(DEEP_PICK, 1) && (has(RAW_IRON, 1) || has(STONE, 32))) return false;
        return !has(DEEP_PICK, 1) || trail.size() < 2
            || trail.size() < 8 && trail.getFirst().getY() - height < 3;
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
        if (remaining < 3 * litLeg + 4 && has(STONE, 3) && affordsWood(localTableWood(), 2)) {
            requestTable("stone_pickaxe", null, 0, 2);
            return true;
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

    private boolean handleScreen() {
        if (c.currentScreen == null) {
            fieldBench.confirmCraft();
            return false;
        }
        if (c.currentScreen instanceof CraftingScreen && tableRecipe != null) {
            BlockPos used = confirmStationUse(table);
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
            boolean addBoat = !recipe.equals("boat") && needsTimberKit() && !has(BOAT, 1)
                && has(BURNABLE_LOG, 8) && affordsWood(tablePlanks + 5 + 12, tableSticks + 4)
                && hands.singleBoatWoodStock();
            List<String> recipes = woodBatch(tablePlanks + (addBoat ? 5 : 0), tableSticks);
            recipes.add(recipe);
            if (extra != null) recipes.add(extra);
            if (axe != null) recipes.add(axe);
            if (addBoat) recipes.add("boat");
            if (hands.craftBatch(recipes)) fieldBench.awaitCraft(used, recipe);
            else c.currentScreen.close();
        } else if (c.currentScreen instanceof FurnaceScreen screen && firing != Firing.NONE) {
            confirmStationUse(furnace);
            furnace.openAttempts = 0;
            furnaceWitness = furnace.position;
            status = firing == Firing.IRON ? "smelting iron" : "making charcoal";
            var handler = screen.getScreenHandler();
            ItemStack inputStack = handler.getSlot(0).getStack();
            boolean input = !inputStack.isEmpty();
            boolean output = !handler.getOutputSlot().getStack().isEmpty();
            if (handler.isBurning() && !output && (firing == Firing.IRON ? RAW_IRON : BURNABLE_LOG).test(inputStack))
                stallGuard.cooking(tick, furnace.position, handler.getCookProgress());
            if (!input && !output && (has(firing == Firing.IRON ? INGOT : FUEL, furnaceDemand)
                || firing == Firing.CHARCOAL && furnaceLoaded)) {
                finishFire();
                c.currentScreen.close();
                return true;
            }
            furnaceLoaded = input || output;
            if (hands.smelt(firing == Firing.CHARCOAL)) {
                furnaceLoaded = true;
                furnacePoll = tick + 16;
            } else {
                String result = hands.status();
                furnacePoll = tick + (result.equals("smelt: cooking") ? 65 : 24);
                furnaceNeedsFuel = result.equals("smelt: no fuel");
                if (result.equals("smelt: no input")) finishFire();
                c.currentScreen.close();
            }
        } else if (c.currentScreen instanceof HandledScreen<?>) {
            c.currentScreen.close();
        } else {
            status = "waiting for game view";
        }
        return true;
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
            fieldWater = body.visibleFluid(false, true, REACH - 0.25);
            if (fieldWater == null || !isWaterSource(fieldWater)) {
                fieldWater = null;
                return false;
            }
            fieldWaterPoint = inward(fieldWater);
            fieldWaterUntil = tick + 48;
        }
        if (tick > fieldWaterUntil
            || c.player.getEyePos().squaredDistanceTo(fieldWater.getPos()) > REACH * REACH) {
            fieldWater = null;
            waterRetry = tick + 100;
            return false;
        }
        status = "filling the field bucket from visible water";
        if (!hands.equipForUse(EMPTY_BUCKET)) return true;
        BlockPos source = fieldWater.getBlockPos();
        body.aim(fieldWaterPoint);
        if (!body.aligned(fieldWaterPoint)) return true;
        BlockHitResult current = perceive(fieldWaterPoint, REACH);
        if (current != null) {
            if (source.equals(current.getBlockPos()) && isWaterSource(current)) body.useWaterSource(source);
            else {
                fieldWater = null;
                waterRetry = tick + 100;
                return false;
            }
        }
        return true;
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
        private PilotPortal.Place placement;
        private int bankCount, gravelAttempts, nextProbe, until, gravelUntil, dropUntil;
        private int scanTurn, scanFrames;
        private float bankBearing;
        private boolean waterReady, attacked;

        boolean active() { return bank != null; }

        boolean start() {
            if (bankCount >= BANK_LIMIT || gravelAttempts >= GRAVEL_LIMIT || tick < nextProbe
                || nextFoot != null || firing != Firing.NONE || !World.OVERWORLD.equals(c.world.getRegistryKey())
                || !dryFieldFooting() || !has(PORTAL_BUCKET, 1) || !has(INGOT, 1)
                || has(IGNITER, 1) || has(FLINT, 1)) return false;
            BlockPos feet = c.player.getBlockPos();
            if (Math.abs(c.player.getY() - feet.getY()) > 0.06) return false;
            for (int i = 0; i < bankCount; i++) {
                if (feet.getSquaredDistance(checkedBanks[i]) <= 6 * 6) return false;
            }
            nextProbe = tick + 8;
            BlockHitResult lava = body.visibleFluid(true, true, REACH);
            if (lava == null || lava.getSide() != Direction.UP || lava.getBlockPos().getY() != feet.getY() - 1)
                return false;
            var fluid = state(lava).getFluidState();
            if (!fluid.isStill() || !fluid.isIn(FluidTags.LAVA)) return false;
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
                    placement = new PilotPortal.Place(floor.getBlockPos(), Direction.UP, inward(floor), Items.GRAVEL, tick);
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
            } else if (body.aligned(gravelPoint)) {
                BlockHitResult seen = perceive(gravelPoint, REACH);
                BlockState block = seen != null && gravelBlock.equals(seen.getBlockPos()) ? state(seen) : null;
                if (block != null && block.isOf(Blocks.GRAVEL)) {
                    BlockHitResult selected = body.selectedFace();
                    if (selected != null && gravelBlock.equals(selected.getBlockPos()) && tools.readyFor(block)) {
                        body.mine(gravelBlock);
                        attacked = true;
                    }
                } else if (seen != null || body.clearTerrain(gravelPoint)) {
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

    private void requestTable(String recipe, String extra, String axe, int planks, int sticks) {
        if (fieldBench.packUntil != 0) fieldBench.leave();
        if (table.position != null && c.player.getEyePos().distanceTo(Vec3d.ofCenter(table.position)) > 4.0) {
            int bench = stationWaypoint(table.position);
            if (bench >= 0 && activeTrail() - bench <= 14) {
                startReturn(bench, true);
                return;
            }
            if (activeTrail() > 0 || resumeIndex >= 0
                || c.player.getEyePos().distanceTo(Vec3d.ofCenter(table.position)) > 7) {
                fieldBench.leave();
                table.position = null;
                table.face = null;
                table.niche = table.underfoot = table.rejected = null;
                table.siteSince = table.stage = 0;
            }
        }
        if (!ensureTable(planks, sticks)) return;
        tableRecipe = recipe;
        tableExtra = extra;
        tableAxe = axe;
        tablePlanks = planks;
        tableSticks = sticks;
        useStation(table);
    }

    private boolean ensureTable(int planks, int sticks) {
        if (table.position == null && !has(table.item, 1)) {
            BlockHitResult visible = body.find(state -> state.isOf(table.block), 4.1).orElse(null);
            if (visible != null) {
                table.position = confirmStation(table, visible);
                table.placed = 0;
                table.approachUntil = 0;
                approachGoal = null;
            } else if (recoverStation(table)) return false;
        }
        if (table.position != null || has(table.item, 1)) return ensureWood(planks, sticks);
        if (collect(table.item, 6)) return false;
        if (ensureWood(planks + 4, sticks)) {
            status = "preparing a crafting table";
            List<String> recipes = woodBatch(planks + 4, sticks);
            recipes.add("crafting_table");
            hands.craftBatch(recipes);
        }
        return false;
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
        if (activeTrail() > 1) {
            beginReturn(true);
            retreatTunnel();
        } else {
            seekTimber();
        }
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

        boolean localFurnace = localStation(furnace, furnaceWitness);
        if (!localFurnace) {
            BlockHitResult seen = body.find(state -> state.isOf(furnace.block), 3.75).orElse(null);
            if (seen != null) {
                furnace.position = confirmStation(furnace, seen);
                localFurnace = true;
            }
        }
        if (localFurnace || canSetLocalFurnace() || departure || activeTrail() <= 1 && c.player.getBlockY() > 48) {
            if (prepareCharcoal()) return true;
        } else if (has(BURNABLE_LOG, 1) && affordsWood(localTableWood() + 2, 3)
            && workOre(Resource.STONE, REACH - 0.35, false)) {
            status = "gathering local furnace stone";
            return true;
        }

        if (!departure && torches >= 2) return false;
        if (!departure && surveyLocalLight()) return true;
        if (canMakeTorch && recallOre(Resource.COAL, range, activeTrail())) return true;
        if (!localFurnace && prepareCharcoalAtKnownFurnace()) return true;
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
        int heatForTable = !has(furnace.item, 1) && !localStation(furnace, furnaceWitness) ? 150 * localTableWood() : 0;
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
        // Vanilla smelts in 200 ticks; one burnable plank supplies 150 ticks.
        return (4 * batch + 2) / 3;
    }

    private void seekExpeditionSupplies(String supplies) {
        if (activeTrail() > 1) {
            status = "returning along traveled steps for " + supplies;
            beginReturn(true);
        } else {
            seekTimber();
        }
    }

    private void fire(Firing batch, int demand) {
        if (firing == Firing.NONE) {
            firing = batch;
            furnaceDemand = demand;
            furnacePoll = tick;
            furnaceLoaded = false;
        }
        if (nextFoot != null) {
            excavate(nextFoot.getY(), digGoal);
            return;
        }
        if (furnace.position == null && furnaceWitness != null) furnace.position = furnaceWitness;
        if (furnace.position == null) {
            BlockHitResult seen = body.find(state -> state.isOf(furnace.block), 5).orElse(null);
            if (seen != null) furnace.position = confirmStation(furnace, seen);
            else if (!(batch == Firing.CHARCOAL && canSetLocalFurnace()) && recoverStation(furnace)) return;
        }
        if (furnace.position != null && c.player.getEyePos().distanceTo(Vec3d.ofCenter(furnace.position)) > 3.75) {
            int bench = stationWaypoint(furnace.position);
            if (!furnaceLoaded && canSetLocalFurnace()
                && (bench < 0 || activeTrail() - bench > 12)) {
                // Leave the distant furnace in observation memory and use a local replacement.
                furnace.position = furnaceWitness = null;
                furnace.face = null;
                furnace.siteSince = furnace.stageSince = furnace.stage = 0;
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
        if (tick < furnacePoll) {
            status = "waiting for furnace";
            return;
        }
        if (furnaceNeedsFuel && !has(FUEL, 1) && !supplyPlanks(4)) return;
        useStation(furnace);
    }

    private boolean canSetLocalFurnace() {
        return has(furnace.item, 1) || has(STONE, 8) && (has(table.item, 1)
            || table.position != null && c.player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(table.position)) < 25
            || affordsWood(4, 0));
    }

    private void finishFire() {
        firing = Firing.NONE;
        furnaceLoaded = false;
        furnaceNeedsFuel = false;
    }

    private BlockPos confirmStation(Station station, BlockHitResult visible) {
        BlockPos position = visible.getBlockPos();
        if (station == table) fieldBench.observe(visible);
        memory.confirm(c.world, station == furnace, position);
        station.memoryProbe = 0;
        return position;
    }

    private BlockPos confirmStationUse(Station station) {
        BlockPos position = station.lastUse;
        station.lastUse = null;
        if (position == null || !position.equals(station.position) || tick - station.opened > 10) return null;
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

    private void useStation(Station station) {
        status = "using " + station.recipe;
        if (station.position != null) {
            Vec3d center = Vec3d.ofCenter(station.position);
            double distance = c.player.getEyePos().distanceTo(center);
            if (station.placed != 0) {
                if (!has(station.item, station.placementCount)) {
                    if (station == table) fieldBench.placementConsumed(station.position);
                    if (station == furnace) furnaceWitness = station.position;
                    station.placed = 0;
                    station.underfoot = null;
                    station.siteSince = station.stageSince = station.stage = station.lampUsed = 0;
                    station.niche = station.rejected = null;
                } else if (tick - station.placed > 14) {
                    station.rejected = station.position;
                    station.underfoot = station.position = null;
                    station.placed = 0;
                    return;
                } else return;
            }
            if (distance > 3.75 || tick < station.approachUntil) {
                if (approach(center, false, false) == Walk.BLOCKED) {
                    if (station == furnace && station.position.equals(furnaceWitness)) {
                        if (activeTrail() > 1) beginReturn(true);
                        else stopped = "stopped: cannot reach the witnessed furnace";
                    } else {
                        if (station == table) fieldBench.leave();
                        station.position = null;
                    }
                }
                return;
            }
            BlockHitResult seen = body.find(state -> state.isOf(station.block), REACH).orElse(null);
            if (seen != null && !seen.getBlockPos().equals(station.position)) seen = null;
            if (seen != null) confirmStation(station, seen);
            Vec3d point = seen == null ? center : seen.getPos().lerp(center, 0.055);
            BlockHitResult selected = body.selectedFace();
            if (selected != null && selected.getBlockPos().equals(station.position)) {
                body.aim(selected.getPos().lerp(center, 0.055));
                if (seen == null) {
                    BlockHitResult lit = perceive(selected.getPos().lerp(center, 0.055), REACH);
                    if (lit != null && lit.getBlockPos().equals(station.position)) {
                        if (state(lit).isOf(station.block)) confirmStation(station, lit);
                        else {
                            forgetStation(station);
                            return;
                        }
                    }
                }
                if (tick - station.opened > 7) {
                    body.use(selected.getBlockPos(), selected.getSide());
                    station.opened = tick;
                    station.lastUse = selected.getBlockPos();
                    station.openAttempts++;
                }
                if (station.openAttempts > 8) {
                    stopped = "stopped: vanilla " + station.recipe + " interaction did not open its screen";
                }
            } else {
                body.aim(point);
                if (!body.aligned(point)) return;
                BlockHitResult hit = perceive(point, REACH);
                if (hit != null && hit.getBlockPos().equals(station.position)) {
                    if (state(hit).isOf(station.block)) confirmStation(station, hit);
                    else forgetStation(station);
                } else station.approachUntil = tick + 15;
            }
            return;
        }
        BlockHitResult seen = body.find(state -> state.isOf(station.block), 5.0).orElse(null);
        if (seen != null) {
            station.position = confirmStation(station, seen);
            station.placed = 0;
            station.approachUntil = 0;
            approachGoal = null;
            return;
        }
        placeStation(station);
    }

    private void forgetStation(Station station) {
        memory.forget(c.world, station == furnace, station.position);
        if (station == furnace && station.position.equals(furnaceWitness)) furnaceWitness = null;
        if (station == table && !fieldBench.removed) fieldBench.leave();
        station.position = null;
        station.lastUse = null;
    }

    private void placeStation(Station station) {
        if (station.siteSince == 0) station.siteSince = station.stageSince = tick;
        if (tick - station.siteSince > 245) {
            stopped = "stopped: no reachable placement face for " + station.recipe;
            return;
        }
        // Once excavation or pillar placement starts it owns the gesture.
        // Rescanning mid-jump used to select a different face during the few
        // ticks in which the destination was clear of the player's body.
        if (station.stage == 0 && station.face == null) station.face = body.stationFace(station.rejected);
        if (station.face != null) {
            var face = station.face;
            if (!hands.equipForUse(station.item)) return;
            body.sneak();
            Vec3d point = face.getPos().lerp(Vec3d.ofCenter(face.getBlockPos()), 0.015);
            body.aim(point);
            if (c.player.getBoundingBox().intersects(new Box(face.getBlockPos().offset(face.getSide())))) {
                station.rejected = face.getBlockPos().offset(face.getSide());
                station.face = null;
                return;
            }
            if (!body.aligned(point) || !c.player.isSneaking()) return;
            var actual = body.selectedFace();
            if (actual != null && actual.getBlockPos().equals(face.getBlockPos()) && actual.getSide() == face.getSide()) {
                pressPlace(station, actual);
            } else {
                station.rejected = face.getBlockPos().offset(face.getSide());
                station.face = null;
            }
            return;
        }
        if (station.stage == 0) {
            // In open terrain look at the ground once; never rotate around an empty set of faces.
            body.turn(c.player.getYaw(), 27);
            if (tick - station.stageSince < 10) return;
            station.stage = 1;
            station.stageSince = tick;
            Direction lane = digDirection != null && activeTrail() > 1 ? digDirection : c.player.getHorizontalFacing();
            station.niche = c.player.getBlockPos().offset(lane.rotateYClockwise()).up();
        }
        if (station.stage == 1) {
            // Light the opposite wall, leaving the intended workshop recess free.
            Vec3d reflected = c.player.getEyePos().multiply(2).subtract(Vec3d.ofCenter(station.niche));
            if (has(TORCH, 1) && tick - station.stageSince <= 45) {
                if (station.lampUsed == 0) {
                    body.aim(reflected);
                    if (!body.aligned(reflected)) return;
                    var face = body.selectedFace();
                    if (face != null && face.getSide() != Direction.DOWN) {
                        if (!hands.equipForUse(TORCH)) return;
                        station.lampBefore = hands.count(TORCH);
                        station.lampUsed = tick;
                        body.use(face.getBlockPos(), face.getSide());
                        return;
                    }
                } else if (has(TORCH, station.lampBefore) && tick - station.lampUsed < 8) return;
            }
            station.stage = 2;
            station.stageSince = tick;
        }
        if (station.stage == 2) {
            // Cut one bench-sized recess in an observed wall when the passage is only one block wide.
            status = "making room for " + station.recipe;
            Dig result = clear(station.niche);
            if (result == Dig.LOOKING && tick - station.stageSince < 76) return;
            station.stage = result == Dig.CLEAR ? 3 : 4;
            station.stageSince = tick;
        }
        if (station.stage == 3) {
            status = "placing " + station.recipe + " in the recess";
            if (!hands.equipForUse(station.item)) return;
            boolean floor = tick - station.stageSince >= 14;
            Vec3d center = Vec3d.ofCenter(station.niche);
            Vec3d aim = floor ? center.add(0, -0.52, 0) : center;
            body.aim(aim);
            if (body.aligned(aim)) {
                var hit = body.selectedFace();
                if (hit != null && hit.getBlockPos().offset(hit.getSide()).equals(station.niche)) {
                    pressPlace(station, hit);
                    return;
                }
            }
            if (tick - station.stageSince < 32) return;
            station.stage = 4;
            station.stageSince = tick;
        }
        if (station.stage == 4) {
            Dig headroom = clear(c.player.getBlockPos().up(2));
            if (headroom == Dig.LOOKING && tick - station.stageSince < 45) return;
            station.stage = 5;
        }
        // A shaft may have no side face outside our body. Vanilla permits jump-placing on the
        // floor we stand on; the real player must rise completely above the destination first.
        if (!hands.equipForUse(station.item)) return;
        if (station.underfoot == null) {
            if (!c.player.isOnGround()) return;
            station.underfoot = c.player.getBlockPos().down();
        }
        var base = station.underfoot;
        status = "lining up jump placement of " + station.recipe;
        body.turn(c.player.getYaw(), 90);
        var actual = body.selectedFace();
        if (actual == null || actual.getSide() != Direction.UP || !actual.getBlockPos().equals(base)) return;
        status = "jump-placing " + station.recipe;
        if (c.player.getBoundingBox().intersects(new Box(base.up()))) body.jump();
        else pressPlace(station, actual);
    }

    private void pressPlace(Station station, BlockHitResult support) {
        BlockPos dest = support.getBlockPos().offset(support.getSide());
        if (c.player.getBoundingBox().intersects(new Box(dest))) return;
        body.use(support.getBlockPos(), support.getSide());
        station.face = null;
        station.position = dest;
        station.placed = tick;
        station.placementCount = hands.count(station.item);
        station.approachUntil = station.openAttempts = 0;
        approachGoal = null;
    }

    /** Ownership is local to this pilot: remembering or using a pre-existing table never claims it. */
    private final class FieldBench {
        private ClientWorld world;
        private BlockPos position;
        private Vec3d center, face, drop;
        private Predicate<ItemStack> output;
        private int placedAt, outputBefore, packUntil, before, dropSeen;
        private boolean crafted, triedAxe, attacked, removed;
        private final Predicate<Entity> nearbyDrop = entity -> entity instanceof ItemEntity item
            && table.item.test(item.getStack()) && item.getPos().squaredDistanceTo(center) <= 2.25;

        private void placementConsumed(BlockPos placed) {
            leave();
            world = c.world;
            position = placed;
            center = Vec3d.ofCenter(placed);
            placedAt = tick;
        }

        private void observe(BlockHitResult hit) {
            if (world != c.world || !hit.getBlockPos().equals(position)) return;
            if (face == null && tick - placedAt > 30) {
                leave();
                return;
            }
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
                if (!body.aligned(face)) return true;
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
                    BlockHitResult selected = body.selectedFace();
                    if (c.player.isOnGround() && selected != null && selected.getBlockPos().equals(position)) {
                        body.mine(position);
                        attacked = true;
                    }
                    return true;
                }
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
            crafted = triedAxe = attacked = removed = false;
            return false;
        }
    }

    private void gather(Resource resource, int onSurfaceTicks, int depth) {
        if (sought != resource) {
            sought = resource;
            soughtSince = tick;
        }
        status = "seeking " + resource.label;
        if (nextFoot != null) {
            excavate(nextFoot.getY(), digGoal);
            return;
        }
        if (surfaceApproach.step(c.player.getBlockPos())) return;
        double range = resource != Resource.STONE && (surfaceDeparture() || !has(TORCH, 2))
            ? REACH - 0.35 : SEARCH;
        if (workOre(resource, range, resource != Resource.STONE)) return;
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
            oreProbe = null;
            oreWorld = c.world;
        }
        BlockHitResult hit = body.find(resource.block, range).orElse(null);
        if (hit == null || resource == Resource.STONE || !c.player.isOnGround()
            || c.player.isTouchingWater() || !reachableResourceFace(hit.getBlockPos())) return hit;
        BlockPos block = hit.getBlockPos();
        BlockPos stance = c.player.getBlockPos();
        double rangeSquared = hit.getPos().squaredDistanceTo(c.player.getEyePos());
        for (int i = 0; i < oreSights.size(); i++) {
            OreSight old = oreSights.get(i);
            if (!old.block.equals(block)) continue;
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
            if (sight.resource != resource || !reachableResourceFace(sight.block)) continue;
            if (range <= REACH && sight.rangeSquared > range * range) continue;
            int route = -1;
            double cost;
            if (standing.equals(sight.stance)) {
                cost = 0;
            } else if (Vec3d.ofBottomCenter(sight.stance).squaredDistanceTo(c.player.getPos()) <= 4
                && Math.abs(standing.getY() - sight.stance.getY()) <= 1) {
                cost = 2;
            } else {
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
        }
        status = "rechecking witnessed " + resource.label;
        if (waypoint >= 0) {
            startReturn(waypoint, true);
            // Travel has its own deadline; the viewpoint probe begins on arrival.
            oreProbeSince = 0;
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
                oreProbe = null;
                setTarget(hit, resource);
                mineTarget(resource);
                return true;
            }
            if (tick - oreProbeSince < 32) return true;
        }
        oreSights.remove(best);
        oreProbe = null;
        return false;
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
            timberShelfLook = TIMBER_SHELF_BEARINGS.length;
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
        if (tick < timberDropUntil || pickupItem == LOG) {
            if (collect(LOG, 7)) return;
            if (tick < timberDropUntil && hands.count(LOG) <= timberDropCount) {
                Vec3d cut = Vec3d.ofCenter(timberLastCut);
                body.aim(new Vec3d(cut.x, Math.min(player.getY() + 0.32, cut.y), cut.z));
                status = "checking the trunk base for dropped logs";
                return;
            }
            timberDropUntil = 0;
        }
        if (timberWitness != null && tendTimber()) return;
        if (collect(LOG, 7)) return;
        BlockHitResult log = body.find(state -> state.isIn(BlockTags.LOGS), player.getBlockInteractionRange(),
            hit -> hit.getBlockPos().getY() <= player.getBlockY() + 1 && timberCandidate(hit) && timberInReach(hit)).orElse(null);
        if (log == null) log = body.find(state -> state.isIn(BlockTags.LOGS), 22, this::timberCandidate).orElse(null);
        if (log != null) {
            timberShelfLook = TIMBER_SHELF_BEARINGS.length;
            timberWitness = log;
            timberCanopy = null;
            timberLastCut = null;
            timberNear = false;
            timberLeafCuts = timberScan = timberApproachSince = 0;
            timberWorkUntil = tick + TIMBER_WORK_TICKS;
            approachGoal = null;
            tendTimber();
            timberAscent = null;
            return;
        }
        if (timberCanopy == null && player.getY() < 62
            && body.find(state -> state.isIn(BlockTags.LEAVES) || state.isOf(Blocks.GRASS_BLOCK)
                || state.isOf(Blocks.SAND) || state.isOf(Blocks.SNOW), 12).isEmpty()) {
            status = "finding a visible way back up for timber";
            if (timberAscent == null) timberAscent = player.getHorizontalFacing();
            startExitRecovery(timberAscent);
            return;
        }
        timberAscent = null;
        if (surveyTimber()) {
            timberShelfLook = TIMBER_SHELF_BEARINGS.length;
            return;
        }
        if (searchTimberFromShelf() || startTimberReposition(player.getYaw())) return;
        if (Float.isNaN(heading)) heading = player.getYaw();
        status = step(forward(heading), false, false) == Walk.BLOCKED
            ? "timber search: local routes exhausted" : "seeking timber along open ground";
    }

    private boolean searchTimberFromShelf() {
        if (timberShelfLook >= TIMBER_SHELF_BEARINGS.length) return false;
        float bearing = timberShelfYaw + TIMBER_SHELF_BEARINGS[timberShelfLook];
        Walk route = Walk.LOOKING;
        if (bearingDistance(c.player.getYaw(), bearing) > 12) body.turn(bearing, 7);
        else route = step(forward(bearing), false, false);
        if (route == Walk.MOVING) {
            heading = bearing;
            timberShelfLook = TIMBER_SHELF_BEARINGS.length;
            status = "seeking timber from the new shelf";
            return true;
        }
        if (route == Walk.BLOCKED || tick >= timberShelfLookUntil) {
            timberShelfLook++;
            timberShelfLookUntil = tick + TIMBER_SHELF_LOOK_TICKS;
        }
        status = "timber search: surveying from the new shelf";
        return true;
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
            if (timberWitness == null && timberExitTo.getY() > timberExitFrom.getY()) {
                // This footprint is already remembered. Survey it rather than retrying the old heading.
                timberShelfYaw = c.player.getYaw();
                timberShelfLook = 0;
                timberShelfLookUntil = tick + TIMBER_SHELF_LOOK_TICKS;
                timberLookAt = tick;
            }
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
            if (!body.aligned(point)) return true;
            if (body.clearTerrain(point)) {
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
            if (readyForMine(material)) body.mine(block);
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
        timberAttack = 0;
        timberAlignUntil = tick + 34;
        timberChopUntil = tick + 110;
        if (leaves) timberLeafCuts++;
    }

    private boolean continueTimberAttack() {
        if (timberChop == null || timberAttack == 0 || timberAttack != tick - 1
                || tick - timberAttackWitnessTick > 3 || tick >= timberChopUntil) return false;
        BlockPos block = timberChop.getBlockPos();
        if (timberUnderfoot(block) || !body.outlined(block)) return false;
        // Bridge a short render gap only for the exact target already being mined.
        timberSeekTick = tick;
        body.aim(timberChopPoint);
        attackTimber(block);
        return true;
    }

    private void attackTimber(BlockPos block) {
        timberAttack = tick;
        timberAlignUntil = tick + 8;
        status = timberCuttingLeaves ? "opening a visible passage through leaves" : "chopping the witnessed trunk";
        body.mine(block);
    }

    private void chopTimber() {
        status = timberCuttingLeaves ? "aligning on visible leaves" : "aligning on a reachable log";
        BlockPos block = timberChop.getBlockPos();
        if (tick >= timberChopUntil || timberUnderfoot(block)) {
            timberChop = null;
            timberScan = 0;
            return;
        }
        body.aim(timberChopPoint);
        if (!body.aligned(timberChopPoint)) {
            stopUnalignedTimber();
            return;
        }
        BlockHitResult hit = perceive(timberChopPoint, c.player.getEyePos().distanceTo(timberChopPoint) + 0.08);
        if (hit != null && hit.getBlockPos().equals(block)) {
            BlockState material = state(hit);
            if (material.isIn(timberCuttingLeaves ? BlockTags.LEAVES : BlockTags.LOGS)) {
                if (!timberInReach(hit)) {
                    if (!timberCuttingLeaves) unavailableTimber(hit, "log face outside vanilla reach", hit.getPos().y > c.player.getEyePos().y);
                    else timberChop = null;
                    return;
                }
                BlockHitResult crosshair = body.selectedFace();
                if (crosshair == null || !crosshair.getBlockPos().equals(block) || !timberInReach(crosshair)) {
                    stopUnalignedTimber();
                    return;
                }
                if (readyForMine(material)) {
                    timberAttackWitnessTick = tick;
                    attackTimber(block);
                }
                return;
            }
        }
        boolean cleared = hit != null && hit.getBlockPos().equals(block) || body.clearTerrain(timberChopPoint);
        if (cleared && timberAttack != 0 && tick - timberAttack <= 10) {
            if (!timberCuttingLeaves) {
                timberLastCut = block;
                timberDropUntil = tick + 19;
                timberDropCount = hands.count(LOG);
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
        if (!body.aligned(targetPoint)) return;
        BlockHitResult hit = perceive(targetPoint, REACH);
        BlockState material = hit != null && hit.getBlockPos().equals(target) ? state(hit) : null;
        if (material == null || !resource.block.test(material)) {
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
        if (!readyForMine(material)) return;
        BlockHitResult selected = body.selectedFace();
        if (selected == null || !selected.getBlockPos().equals(target) || selected.getSide() != hit.getSide()) return;
        // An exposed block can also support a step of the escape route.
        if (lastMining == 0 && supportsTrail(target)) {
            abandonTarget();
            return;
        }
        lastMining = tick;
        body.mine(target);
    }

    private boolean supportsTrail(BlockPos block) {
        for (int i = trail.size() - 1; i >= 0; i--) {
            BlockPos step = trail.get(i);
            if (step.getY() == block.getY() + 1 && step.getX() == block.getX() && step.getZ() == block.getZ()) return true;
        }
        return false;
    }

    private void forgetOreTarget() {
        for (int i = 0; i < oreSights.size(); i++) {
            if (oreSights.get(i).block.equals(target)) {
                oreSights.remove(i);
                return;
            }
        }
    }

    private void abandonTarget() {
        ignored[ignoreCursor] = target;
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
        private int view, since, proof, cuts, cutSince, visitedCursor, backtracks;
        private float surveyYaw;

        private boolean findingGround() {
            return from != null && entrance == null && activeTrail() < 4 && c.player.getY() > 48;
        }

        private void abandon() {
            from = to = cut = null;
        }

        private boolean step(BlockPos standing) {
            if (to == null && (standing.getY() <= 48 || activeTrail() >= 4 || entrance != null
                    && (entrance.equals(standing) || !trail.isEmpty() && entrance.equals(trail.getFirst())))) return false;
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
                    boolean seen = false;
                    for (BlockPos prior : visited) {
                        if (foot.equals(prior)) { seen = true; break; }
                    }
                    if (seen || rejected.contains(foot)) continue;
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
            if (!body.aligned(point)) return;
            if (body.clearTerrain(point)) {
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
            if (tools.readyFor(state)) body.mine(leaf);
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
            if (!body.aligned(cutAim)) return true;
            BlockHitResult seen = perceive(cutAim, c.player.getEyePos().distanceTo(cutAim) + 0.04);
            if (seen != null && seen.getBlockPos().equals(cut)) {
                BlockState observed = state(seen);
                if (eligibleLeaf(cut, observed) && tools.readyFor(observed)) body.mine(cut);
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
                if (natural) {
                    entrance = to;
                    // Old unverified surface waypoints are not a connected mine entrance.
                    trail.clear();
                    resumeIndex = -1;
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
            walkDown(false);
        } else if (followObservedShelf(current, direction)) {
            status = "following a witnessed shelf in the mine";
        } else if (hit != null && hit.getBlockPos().equals(current.down()) && hit.getSide() == Direction.UP) {
            // Crouch toward the lip on the proven current support to reveal the next one.
            creepToLip();
        } else if (!lightDigOnce(current)) {
            if (!nextFoot.equals(cavePeek)) {
                cavePeek = nextFoot;
                caveLookUntil = tick + 16;
            } else blockedTunnel();
        }
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
        if (trail.size() == TRAIL_LIMIT) {
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

    private boolean lightStair(BlockPos current) {
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
            0.36 * digDirection.getOffsetX(), -0.06, 0.36 * digDirection.getOffsetZ());
        body.aim(point);
        body.sneak();
        if (!body.aligned(point)) return true;
        BlockHitResult hit = body.selectedFace();
        if (hit != null && hit.getSide() == Direction.UP && hit.getBlockPos().equals(current.down())) {
            // Ground contact proves this support; the rendered outline proves the usable face.
            if (!c.player.isSneaking()) return true;
            body.use(hit.getBlockPos(), hit.getSide());
            torchBefore = hands.count(TORCH);
            torchUsed = tick;
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
            if (trail.contains(candidate) || closedDig.contains(candidate)) continue;
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
        body.aim(point);
        if (!body.aligned(point)) return Dig.LOOKING;
        double length = c.player.getEyePos().distanceTo(point);
        BlockHitResult hit = perceive(point, length + 0.18);
        if (hit == null) {
            if (body.clearTerrain(point)) return Dig.CLEAR;
            if (nextFoot != null && position.equals(witnessedStairCut)
                    && tick - witnessedStairCutTick <= 3 && body.outlined(position)) {
                // Missing one render does not make the same vanilla outlined crack go dark.
                body.mine(position);
                return Dig.LOOKING;
            }
            BlockHitResult outline = body.selectedFace();
            return outline != null && (outline.getBlockPos().equals(position)
                || c.player.getEyePos().distanceTo(outline.getPos()) < length) ? Dig.DARK : Dig.LOOKING;
        }
        if (!hit.getBlockPos().equals(position)) {
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
        if (state.isReplaceable() && state.getFluidState().isEmpty() && !state.isOf(Blocks.SNOW)) return Dig.CLEAR;
        if (dangerous(state) || !state.getFluidState().isEmpty()
            || state.getHardness(c.world, position) < 0 || state.isOf(Blocks.OBSIDIAN)
            || state.isOf(Blocks.CRYING_OBSIDIAN) || state.isOf(Blocks.CRAFTING_TABLE)
            || state.isOf(Blocks.FURNACE)) return Dig.BLOCKED;
        if (!tools.canHarvest(state)) return Dig.BLOCKED;
        if (!readyForMine(state)) return Dig.LOOKING;
        if (nextFoot != null) {
            witnessedStairCut = position;
            witnessedStairCutTick = tick;
        }
        body.mine(position);
        return Dig.LOOKING;
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
        if (!hands.equipForUse(TORCH)) return true;
        Direction forward = digDirection == null ? c.player.getHorizontalFacing() : digDirection;
        Direction wall = torchFace == 1 ? forward.rotateYClockwise()
            : torchFace == 2 ? forward.rotateYCounterclockwise() : forward.getOpposite();
        BlockPos feet = c.player.getBlockPos();
        Vec3d point = torchFace == 0 ? Vec3d.ofCenter(feet.offset(wall).down(), 0.80)
            : torchFace == 3 ? Vec3d.ofCenter(feet.down(), 0.83) : Vec3d.ofCenter(feet.offset(wall), 0.58);
        body.aim(point);
        if (!body.aligned(point)) return true;
        BlockHitResult shown = body.selectedFace();
        BlockHitResult hit = perceive(point, 2.6);
        boolean visibleSupport = hit != null && safeSupport(hit);
        // In darkness the rendered outline still proves a real face; let vanilla decide if it accepts a torch.
        if (hit == null && forced) hit = shown;
        if (hit != null && (shown == null || !shown.getBlockPos().equals(hit.getBlockPos())
            || shown.getSide() != hit.getSide())) return true;
        if (hit != null && hit.getSide() != Direction.DOWN && (visibleSupport || forced && shown == hit)
            && (nextFoot == null || !hit.getBlockPos().offset(hit.getSide()).equals(nextFoot))) {
            body.use(shown.getBlockPos(), shown.getSide());
            torchBefore = remaining;
            torchUsed = tick;
        } else {
            torchFace++;
            torchAttempt = tick;
        }
        return true;
    }

    private void blockedTunnel() {
        if (nextFoot != null) closeDig(nextFoot);
        nextFoot = null;
        forcedLight = false;
        failedDirections++;
        legLength = 0;
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
        if (tick - returnAge > 165) {
            startExitRecovery(directional(Vec3d.ofBottomCenter(next).subtract(c.player.getPos())));
            return;
        }
        BlockPos current = returnDetour != null ? returnDetour
            : returnIndex + 1 < trail.size() ? trail.get(returnIndex + 1) : c.player.getBlockPos();
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
        gaitStep = null;
        if (keepTrail) {
            resumeIndex = index + 1;
            resumeStep = -1;
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

    private void resumeTunnel() {
        status = "resuming a traveled mine";
        if (resumeIndex < trail.size() && arrived(trail.get(resumeIndex))) resumeIndex++;
        if (resumeIndex >= trail.size()) {
            resumeIndex = -1;
            useTraveledBearing(trail.size() - 1);
            return;
        }
        if (resumeStep != resumeIndex) {
            resumeStep = resumeIndex;
            returnAge = tick;
            climbTo = null;
        }
        BlockPos next = trail.get(resumeIndex);
        BlockPos current = c.player.getBlockPos();
        if (resumeIndex > 0 && caves.followWater(trail.get(resumeIndex - 1), next, tick)) {
            status = caves.status();
            return;
        }
        if (resumeIndex > 0 && dugSteps.get(resumeIndex)
            && driveKnownStep(trail.get(resumeIndex - 1), next) != Walk.BLOCKED) return;
        if (tick - returnAge > 155 || !adjacent(current, next)) {
            // Workshop movement can leave us a few blocks away from the entry bench.
            if (tick - returnAge <= 155 && resumeIndex <= 1 && !current.equals(trail.getFirst())
                && c.player.getPos().distanceTo(Vec3d.ofBottomCenter(trail.getFirst())) < 5
                && approach(Vec3d.ofBottomCenter(trail.getFirst()), false, false) != Walk.BLOCKED) return;
            trail.subList(resumeIndex, trail.size()).clear();
            resumeIndex = -1;
            return;
        }
        Walk result = next.getY() > current.getY() ? climb(current, next) : walkMinedStep(next);
        if (result == Walk.BLOCKED) {
            trail.subList(resumeIndex, trail.size()).clear();
            resumeIndex = -1;
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
            BlockHitResult support = terrain(point, 3.4);
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
                walkDown(false);
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
        if (climbCheck == 3) {
            Vec3d lip = Vec3d.ofCenter(to.down(), 0.29);
            body.aim(lip);
            if (!body.aligned(lip)) return Walk.LOOKING;
            BlockHitResult hit = terrain(lip, 2.75);
            if (hit == null || !hit.getBlockPos().equals(to.down()) || !safeSupport(hit)) return Walk.BLOCKED;
            climbCheck++;
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
            stopped = "stopped: no reachable visible exit";
            status = stopped;
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
                stopped = "stopped: no reachable visible exit";
                status = stopped;
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
        if (rose) {
            exitDeadline = tick + 620;
            if (timberAscent != null && (reached.getX() != exitFrom.getX() || reached.getZ() != exitFrom.getZ()))
                timberAscent = directional(Vec3d.ofBottomCenter(reached).subtract(Vec3d.ofBottomCenter(exitFrom)));
        }
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
        } else if (returnIndex < 0 && (timberAscent == null || rose)) {
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
        body.turn(c.player.getYaw(), 90);
        BlockHitResult hit = body.selectedFace();
        if (hit == null || hit.getSide() != Direction.UP || !hit.getBlockPos().equals(support)) return true;
        BlockHitResult floor = terrain(hit.getPos().add(0, -0.04, 0), 3.5);
        if (floor == null || !floor.getBlockPos().equals(support) || !safeSupport(floor)) return false;
        if (c.player.getBoundingBox().intersects(new Box(exitFrom))) body.jump();
        else {
            body.use(support, Direction.UP);
            pillarStage = 3;
        }
        return true;
    }

    private boolean escapeDanger(boolean hurt) {
        if (hurt) defense.markDanger(tick);
        if (nextFoot != null && body.lavaBreachesDig(nextFoot)) body.beginLavaEscape();
        if (body.lavaEmergency()) {
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
            defense.markDanger(tick);
            interruptHands();
            status = "surfacing for air";
            body.jump();
            body.walk(true);
            return true;
        }
        if (hurt && c.currentScreen instanceof HandledScreen<?>) {
            interruptHands();
            retreatYaw = c.player.getYaw() + 130;
            retreatUntil = tick + 12;
            status = "closing the screen after damage";
            step(forward(retreatYaw), true, true);
            return true;
        }

        boolean selecting = defense.combatSelecting();
        LivingEntity threat = body.threat(8).orElse(null);
        boolean creeper = threat instanceof CreeperEntity;
        boolean exposedSurface = surfaceApproach.findingGround();
        if (exposedSurface && threat != null && !creeper
                && c.player.squaredDistanceTo(threat) > 3.2 * 3.2) return false;
        float health = c.player.getHealth();
        boolean flee = threat != null && (creeper || health <= 7 || health <= 10 && wantsHealingMeal());
        if (flee && tick >= retreatUntil - 10) {
            retreatYaw = yaw(c.player.getPos().subtract(threat.getPos()));
            retreatUntil = tick + 15;
        }
        if (tick < retreatUntil) {
            body.prioritizeMovement();
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
            if (defense.fight(threat, tick) && !exposedSurface) {
                Vec3d target = threat.getPos();
                if (walkToward(target, false, false) == Walk.MOVING
                        && bearingDistance(routeYaw, yaw(target.subtract(c.player.getPos()))) <= 12) {
                    defense.face();
                }
            }
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
        return canRefuelHealing(c.player.getHungerManager().getFoodLevel()) && has(FOOD, 1);
    }

    private boolean canRefuelHealing(int hunger) {
        float health = c.player.getHealth();
        float max = c.player.getMaxHealth();
        return hunger < 20 && health < max && (hunger < 18 || health <= max / 2);
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
        if (returnIndex >= 0 || exitStart != null || nextFoot != null || stopped != null) {
            if (forage != null) finishForage(100);
            return false;
        }
        if (forage != null) return continueForage();
        if (tick < forageScan || pickupItem != null) return false;
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
        if (mealUntil != 0 && tick >= mealUntil) {
            mealRetry = tick + 45;
            mealUntil = 0;
            mealItem = null;
            return false;
        }
        if (mealItem == null || !c.player.getMainHandStack().isOf(mealItem)) {
            int slot = bestMeal(hunger);
            if (slot < 0) return false;
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
        status = canRefuelHealing(hunger) ? "eating to recover health" : "eating";
        body.turn(c.player.getYaw(), -50);
        body.holdUse();
        return true;
    }

    private int bestMeal(int hunger) {
        var inv = c.player.getInventory();
        int best = -1;
        float score = -1;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            ItemStack stack = inv.getStack(slot);
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
        return best;
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
            if (body.aligned(foragePoint) && (forageAction == 0 || tick - forageAction >= 9)) {
                body.use(forageBush, hit.getSide());
                forageAction = tick;
            }
        } else if (forageAction != 0 && tick - forageAction > 14) return false;
        body.aim(foragePoint);
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
        Vec3d plannedLanding = observedLanding;
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
                Vec3d landing = observedLanding;
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
        Vec3d landing = plannedLanding;
        if (turn >= 3) {
            actual = footing(feet, actualLane, facing, allowWater);
            actual = refreshLanding(actual, feet, actualLane, allowWater);
            landing = observedLanding;
        }
        if (landing != null) {
            routeLanding = landing;
            routeLandingTick = tick;
        } else if (actual == Footing.BLOCKED || actual == Footing.WATER || actual == Footing.JUMP) {
            routeLanding = null;
        }
        boolean needsFooting = actual == Footing.UNKNOWN || actual == Footing.EDGE;
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
            if (landingInProgress || turn > 5) return Walk.LOOKING;
            body.sneak();
            walk(false);
            return Walk.MOVING;
        }
        if ((actual == Footing.DOWN || actual == Footing.STEEP) && c.player.isOnGround()) descentTick = tick;
        if (actual == Footing.JUMP || c.player.isTouchingWater()) body.jump();
        // The close proof below is stronger than Body's conservative pitch-dependent edge heuristic.
        walkDown(sprint && ordinaryFooting(actual) && turn <= (c.player.isSprinting() ? 11 : 7)
            && !body.hazardAhead(facing, 3.4) && sprintLane(feet, actualLane, landing));
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
        observedLanding = hit;
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
        Vec3d bestLanding = null;
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
            if (bestLanding == null || hit.y < bestLanding.y || hit.y == bestLanding.y && ahead < bestAhead) {
                bestLanding = hit;
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
