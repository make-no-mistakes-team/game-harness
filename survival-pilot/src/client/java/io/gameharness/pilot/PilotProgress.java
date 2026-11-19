package io.gameharness.pilot;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.mob.CreeperEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

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
    private static final int IRON_TIMBER = 8;
    private static final int DEEP_TIMBER = 16;
    private static final int TIMBER_WORK_TICKS = 190;
    private static final float[] TIMBER_STAND_TURNS = {65, -65, 0, 135, -135, 180};
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
    private static final Predicate<ItemStack> PORTAL_BUCKET = s -> s.isOf(Items.BUCKET) || s.isOf(Items.WATER_BUCKET);
    private static final Predicate<ItemStack> IGNITER = item(Items.FLINT_AND_STEEL);
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
        && !stack.isOf(Items.CHICKEN);

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
    private final PilotPortal portal;
    private final PilotMemory memory;
    private boolean memoryAttached;
    private boolean portalStarted;
    private final String goal;
    private final Predicate<ItemStack> goalItem;
    private final Station table = new Station(Blocks.CRAFTING_TABLE, Items.CRAFTING_TABLE, "crafting_table");
    private final Station furnace = new Station(Blocks.FURNACE, Items.FURNACE, "furnace");
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
    private boolean furnaceNeedsWood;
    private boolean furnaceNeedsFuel;
    private int workshopSweep;
    private float workshopHeading = Float.NaN;
    private Resource sought;
    private int soughtSince;
    private Resource miningResource;
    private BlockPos target;
    private Vec3d targetPoint;
    private int targetDeadline;
    private double targetNearest;
    private int lastMining;
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
    private BlockHitResult timberWitness;
    private BlockPos timberLastCut;
    private BlockPos exhaustedStem;
    private BlockHitResult timberChop;
    private Vec3d timberChopPoint;
    private boolean timberCuttingLeaves;
    private int timberAttack;
    private int timberChopUntil;
    private int timberWorkUntil;
    private int timberSeekTick;
    private int timberDropUntil;
    private int timberDropCount;
    private boolean timberNear;
    private int timberScan;
    private int timberLeafCuts;
    private Vec3d timberStand;
    private int timberStandIndex;
    private int timberApproachSince;
    private float timberStandYaw;
    private Direction timberAscent;
    private Vec3d timberBank;
    private Vec3d timberCanopy;
    private int timberCanopyUntil;
    private boolean timberCanopyPeeking;
    private BlockPos exhaustedCanopy;
    private int timberLookAt;
    private int timberLookStep;
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
    private int miningReserve;
    private int deadEnds;
    private int returnTo;
    private BlockPos returnDetour;
    private int returnIndex = -1;
    private int resumeIndex = -1;
    private boolean keepTrail;
    private boolean foraging;
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
    private boolean forcedLight;
    private BlockPos darkAttemptFoot;

    PilotProgress(MinecraftClient c, PilotBody body, PilotHands hands, String goal, PilotMemory memory) {
        this.c = c;
        this.body = body;
        this.hands = hands;
        this.memory = memory;
        tools = new PilotTools(c, hands);
        this.goal = goal;
        portal = goal.equals("nether_portal") ? new PilotPortal(c, body, hands, tools) : null;
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
        if (index + 1 < trail.size()) resumeIndex = index + 1;
        digDirection = c.player.getHorizontalFacing();
        return true;
    }

    void saveMemory(boolean force) {
        memory.save(c.world, trail, force);
    }

    boolean won() {
        return win;
    }

    String failure() {
        return stopped != null || portal == null ? stopped : portal.failure();
    }

    int confirmedFrameBlocks() { return portal == null ? 0 : portal.confirmedFrameBlocks(); }
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
        if (!prepareMining(16)) excavate(DIAMOND_LEVEL, null);
    }

    String status() {
        return status;
    }

    void tick() {
        if (win || c.player == null || c.world == null) return;
        tick++;
        if (!c.player.isAlive() || c.currentScreen instanceof DeathScreen) {
            status = "died before " + goal;
            return;
        }
        if (portalStarted && portal.updateArrival()) {
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
        boolean hurtInScreen = health < previousHealth && c.currentScreen instanceof HandledScreen<?>;
        previousHealth = health;
        if (hurtInScreen) {
            interruptHands();
            retreatYaw = c.player.getYaw() + 130;
            retreatUntil = tick + 10;
            status = "interrupting the screen after damage";
            return;
        }
        if (escapeDanger()) return;
        if (hands.busy()) return;
        if (handleScreen()) return;
        if (eatOrHunt()) return;
        if (stopped != null) {
            status = stopped;
            return;
        }
        if (exitStart != null) {
            recoverExit();
            return;
        }
        if (returnIndex >= 0) {
            retreatTunnel();
            return;
        }

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
            int timberReserve = goal.equals("iron_pickaxe") ? IRON_TIMBER : DEEP_TIMBER;
            int timber = hands.count(PLANK) + 4 * hands.count(LOG);
            boolean enoughFuel = hands.count(TORCH) + 4 * hands.count(FUEL) >= 24;
            boolean workingUnderground = stonePick && c.player.getY() < 48
                && (has(BURNABLE_LOG, 1) || has(PLANK, 4)) && (has(TORCH, 1) || has(FUEL, 1));
            if (longGoal && !workingUnderground && !ironPick && trail.isEmpty() && (stonePick || woodPick)
                && (timberWitness != null || pickupItem == LOG || timber < 4 * timberReserve
                    || !enoughFuel && !has(BURNABLE_LOG, timberReserve))) {
                if (pickupItem == LOG || tick < timberDropUntil) seekTimber();
                else if (timber < 4 * timberReserve && !has(AXE, 1)) {
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
        if (portal != null) {
            int reserve = (has(PORTAL_BUCKET, 1) ? 0 : 3) + (has(IGNITER, 1) ? 0 : 1);
            if (!has(INGOT, reserve)) {
                acquireIron(reserve);
                return;
            }
        }
        mineDiamonds(goal.equals("nether_portal") ? 3 : 1);
    }

    void acquireIron(int desired) {
        if (firing != Firing.NONE) {
            fire(firing, furnaceDemand);
            return;
        }
        int ingots = hands.count(INGOT);
        if (ingots >= desired) return;
        int raw = hands.count(RAW_IRON);
        if (raw >= Math.min(3, desired - ingots)) {
            fire(Firing.IRON, desired);
        } else if (!prepareMining(12)) {
            gather(Resource.IRON, 115, 16);
        }
    }

    boolean mineDiamonds(int count) {
        if (has(DIAMOND, count)) return true;
        if (firing != Firing.NONE) {
            fire(firing, furnaceDemand);
        } else if (!prepareMining(36)) {
            gather(Resource.DIAMOND, 0, DIAMOND_LEVEL);
        }
        return false;
    }

    private boolean prepareMining(int reserve) {
        if (nextFoot != null) {
            excavate(nextFoot.getY(), digGoal);
            return true;
        }
        // A reattached actor already standing deep in its own lit shaft is not
        // departing from the surface again. Do not walk 70 steps back for a fresh
        // "departure kit" while carrying enough light to prospect locally.
        if (miningReserve == 0 && c.player.getY() <= 48 && hands.count(TORCH) + 4 * hands.count(FUEL) >= 4)
            miningReserve = reserve;
        boolean departure = miningReserve < reserve || resumeIndex == 1;
        int sparePlanks = reserve >= 24 ? 16 : 8;
        int spareSticks = reserve >= 24 ? 8 : 4;
        if (departure && has(TORCH, reserve) && !affordsWood(sparePlanks, spareSticks)) {
            ensureWood(sparePlanks, spareSticks);
            return true;
        }
        int remaining = pickUses(STONE_PICK);
        if (remaining < 10 && has(STONE, 3)) {
            makePick("stone_pickaxe", STONE, 3);
            return true;
        }
        if (remaining == 0) {
            gatherStone();
            return true;
        }
        if (target != null && (miningResource == sought || miningResource == Resource.COAL)
            || pickupItem != null && (pickupItem == FUEL || sought != null && pickupItem == sought.drop)) return false;
        int needed = departure ? reserve : 4;
        if (has(TORCH, needed)) {
            miningReserve = Math.max(miningReserve, reserve);
            return false;
        }
        if (craftTorches(Math.min(reserve, Math.max(needed, 12)))) return true;
        // A small supply can cover the next ore search, but not entry into a long dark route.
        if (!departure && has(TORCH, 2)) return false;
        prepareLight(needed);
        return true;
    }

    private boolean handleScreen() {
        if (c.currentScreen == null) return false;
        if (c.currentScreen instanceof CraftingScreen && tableRecipe != null) {
            confirmStationUse(table);
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
            List<String> recipes = woodBatch(tablePlanks, tableSticks);
            recipes.add(recipe);
            if (extra != null) recipes.add(extra);
            if (axe != null) recipes.add(axe);
            if (!hands.craftBatch(recipes)) c.currentScreen.close();
        } else if (c.currentScreen instanceof FurnaceScreen screen && firing != Firing.NONE) {
            confirmStationUse(furnace);
            furnace.openAttempts = 0;
            furnaceWitness = furnace.position;
            status = firing == Firing.IRON ? "smelting iron" : "making charcoal";
            var handler = screen.getScreenHandler();
            boolean input = !handler.getSlot(0).getStack().isEmpty();
            boolean output = !handler.getOutputSlot().getStack().isEmpty();
            if (!input && !output
                && has(firing == Firing.IRON ? INGOT : FUEL, furnaceDemand)) {
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
                if (result.equals("smelt: no input")) {
                    furnaceNeedsWood = firing == Firing.CHARCOAL && !has(BURNABLE_LOG, 1);
                    finishFire();
                }
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

    void requestTable(String recipe, String extra, int planks, int sticks) {
        requestTable(recipe, extra, null, planks, sticks);
    }

    private void requestTable(String recipe, String extra, String axe, int planks, int sticks) {
        if (table.position != null && c.player.getEyePos().distanceTo(Vec3d.ofCenter(table.position)) > 4.0) {
            int bench = stationWaypoint(table.position);
            if (bench >= 0 && activeTrail() - bench <= 14) {
                startReturn(bench, true);
                return;
            }
            if (activeTrail() > 0 || resumeIndex >= 0
                || c.player.getEyePos().distanceTo(Vec3d.ofCenter(table.position)) > 7) {
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
        int batches = Math.min(hands.count(FUEL), (reserve - hands.count(TORCH) + 3) / 4);
        if (batches <= 0) return false;
        if (!affordsWood(0, batches)) {
            ensureWood(0, batches);
            return true;
        }
        List<String> recipes = woodBatch(0, batches);
        for (int i = 0; i < batches; i++) recipes.add("torch");
        status = "crafting torches";
        hands.craftBatch(recipes);
        return true;
    }

    private void prepareLight(int needed) {
        if (target != null && miningResource != Resource.COAL) target = null;
        if (collect(FUEL, 6)) return;
        BlockHitResult coal = body.find(Resource.COAL.block, 6).orElse(null);
        if ((target != null && miningResource == Resource.COAL) || coal != null && reachableResourceFace(coal.getBlockPos())) {
            if (target == null || miningResource != Resource.COAL) setTarget(coal, Resource.COAL);
            mineTarget(Resource.COAL);
            return;
        }
        if (activeTrail() > 1 && furnaceWitness == null && furnace.position == null) {
            if (recoverStation(furnace)) return;
            if (furnace.position == null && !canSetLocalFurnace()) {
                miningReserve = 0;
                beginReturn(true);
                return;
            }
        }
        fire(Firing.CHARCOAL, Math.min(3, (needed - hands.count(TORCH) + 3) / 4));
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
            else if (recoverStation(furnace)) return;
        }
        if (furnace.position == null && !has(furnace.item, 1) && activeTrail() < 2 && surveyWorkshop()) return;
        if (furnace.position != null && c.player.getEyePos().distanceTo(Vec3d.ofCenter(furnace.position)) > 3.75) {
            int bench = stationWaypoint(furnace.position);
            if (bench >= 0) {
                if (!furnaceLoaded && activeTrail() - bench > 12 && canSetLocalFurnace()) {
                    // Cobblestone and a local table are cheaper than a round trip up a long shaft.
                    // Keep the observed distant furnace in memory; don't confuse it with an active batch.
                    furnace.position = furnaceWitness = null;
                    furnace.face = null;
                    furnace.siteSince = furnace.stageSince = furnace.stage = 0;
                } else {
                    if (batch == Firing.CHARCOAL) miningReserve = 0;
                    startReturn(bench, true);
                    return;
                }
            }
        }
        if (furnace.position == null && !has(furnace.item, 1)) {
            if (collect(furnace.item, 6)) return;
            if (!has(STONE, 8)) gatherStone();
            else requestTable("furnace", null, 0, 0);
            return;
        }
        if (!furnaceLoaded && batch == Firing.CHARCOAL && furnaceNeedsWood && !has(BURNABLE_LOG, 1)) {
            if (activeTrail() > 1) beginReturn(true);
            else seekTimber();
            return;
        }
        if (tick < furnacePoll) {
            status = "waiting for furnace";
            return;
        }
        if (furnaceNeedsFuel && !has(FUEL, 1) && !supplyPlanks(3)) return;
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

    private boolean surveyWorkshop() {
        if (workshopSweep >= 4) return false;
        if (table.position == null) {
            BlockHitResult seen = body.find(state -> state.isOf(table.block), 5).orElse(null);
            if (seen != null) table.position = confirmStation(table, seen);
        }
        if (Float.isNaN(workshopHeading)) workshopHeading = c.player.getYaw();
        float heading = workshopHeading + 90 * workshopSweep;
        body.turn(heading, 28);
        if (Math.abs(MathHelper.wrapDegrees(heading - c.player.getYaw())) < 8
            && Math.abs(c.player.getPitch() - 28) < 7) workshopSweep++;
        status = "surveying for a nearby workshop";
        return true;
    }

    private BlockPos confirmStation(Station station, BlockHitResult visible) {
        BlockPos position = visible.getBlockPos();
        memory.confirm(c.world, station == furnace, position);
        station.memoryProbe = 0;
        return position;
    }

    private void confirmStationUse(Station station) {
        BlockPos position = station.lastUse;
        if (position != null && position.equals(station.position) && tick - station.opened <= 10)
            memory.confirm(c.world, station == furnace, position);
        station.lastUse = null;
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
                    } else station.position = null;
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
            if (!hold(station.item)) return;
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
                        if (!hold(TORCH)) return;
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
            if (!hold(station.item)) return;
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
        if (!hold(station.item)) return;
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

    private void gather(Resource resource, int onSurfaceTicks, int depth) {
        if (sought != resource) {
            if (target != null && miningResource != resource && miningResource != Resource.COAL) target = null;
            if (pickupItem != resource.drop && pickupItem != FUEL) clearPickup();
            sought = resource;
            soughtSince = tick;
            pickupUntil = 0;
        }
        status = "seeking " + resource.label;
        if (target != null) {
            mineTarget(miningResource);
            return;
        }
        if (pickupItem == FUEL && collect(FUEL, 5)) return;
        if (collect(resource.drop, 7)) return;
        if (tick < pickupUntil) {
            if (pickupLook != null) body.aim(pickupLook);
            return;
        }
        if (tick >= seekAfter || activeTrail() > 1) {
            BlockHitResult hit = body.find(resource.block, SEARCH).orElse(null);
            if (hit != null && reachableResourceFace(hit.getBlockPos())) {
                setTarget(hit, resource);
                mineTarget(resource);
                return;
            }
            if ((resource == Resource.IRON || resource == Resource.DIAMOND)
                && hands.count(TORCH) + 4 * hands.count(FUEL) < 28) {
                if (collect(FUEL, 5)) return;
                hit = body.find(Resource.COAL.block, 4.0).orElse(null);
                if (hit != null && reachableResourceFace(hit.getBlockPos())) {
                    setTarget(hit, Resource.COAL);
                    mineTarget(Resource.COAL);
                    return;
                }
            }
        }
        if ((activeTrail() > 1 || resumeIndex >= 0 || tick - soughtSince > onSurfaceTicks)
            && tick >= nextDigStart && (c.player.isOnGround() || activeTrail() > 0) && !c.player.isTouchingWater()) {
            excavate(depth, null);
        } else {
            explore();
        }
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
            exhaustedCanopy = BlockPos.ofFloored(timberCanopy);
            timberCanopy = null;
            timberLookAt = tick + 75;
        }
        if (tick < timberLookAt) return false;
        if (timberLookStep == 0) timberLookYaw = c.player.getYaw();
        BlockHitResult leaf = body.find(state -> state.isIn(BlockTags.LEAVES), 22).orElse(null);
        if (leaf != null && leaf.getPos().y >= feet.y + 1
            && horizontalDistance(feet, leaf.getPos()) > 1.3
            && (exhaustedCanopy == null || leaf.getBlockPos().getSquaredDistance(exhaustedCanopy) > 16)) {
            timberCanopy = timberAim(leaf);
            timberCanopyUntil = tick + 145;
            timberCanopyPeeking = false;
            timberLeafCuts = 0;
            timberLookStep = 0;
            approachGoal = null;
            return true;
        }
        float look = timberLookYaw + switch (timberLookStep) {
            case 0 -> 0;
            case 1 -> 55;
            case 2 -> -55;
            default -> 145;
        };
        body.turn(look, -1);
        if (Math.abs(MathHelper.wrapDegrees(c.player.getYaw() - look)) < 7 && Math.abs(c.player.getPitch() + 1) < 6
            && ++timberLookStep >= 4) {
            timberLookStep = 0;
            timberLookAt = tick + 150;
        }
        status = "looking for visible timber";
        return true;
    }

    private void seekTimber() {
        var player = c.player;
        if (timberWitness != null && timberSeekTick != 0 && tick - timberSeekTick > 1) {
            // Real inventory work and hunger can interrupt the current tree; retain its witness.
            timberWorkUntil += tick - timberSeekTick - 1;
            if (timberChop != null) timberChopUntil += tick - timberSeekTick - 1;
        }
        timberSeekTick = tick;
        if (player.isTouchingWater()) {
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
                timberLookStep = 0;
                heading = player.getYaw() + (++timberBankTurns % 2 == 0 ? 75 : -75);
                headingUntil = tick + 180;
            }
        }
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
        BlockHitResult log = body.find(state -> state.isIn(BlockTags.LOGS), 22).orElse(null);
        if (log != null && !sameStem(log.getBlockPos(), exhaustedStem)) {
            timberWitness = log;
            timberCanopy = null;
            timberLastCut = null;
            timberNear = false;
            timberLeafCuts = timberScan = timberStandIndex = timberApproachSince = 0;
            timberWorkUntil = tick + TIMBER_WORK_TICKS;
            approachGoal = null;
            tendTimber();
            timberAscent = null;
            return;
        }
        if (log == null && timberCanopy == null && player.getY() < 62
            && body.find(state -> state.isIn(BlockTags.LEAVES) || state.isOf(Blocks.GRASS_BLOCK)
                || state.isOf(Blocks.SAND) || state.isOf(Blocks.SNOW), 12).isEmpty()) {
            status = "finding a visible way back up for timber";
            if (timberAscent == null) timberAscent = player.getHorizontalFacing();
            startExitRecovery(timberAscent);
            return;
        }
        timberAscent = null;
        if (!surveyTimber()) explore();
    }

    private boolean tendTimber() {
        BlockPos stem = timberWitness.getBlockPos();
        Vec3d feet = c.player.getPos();
        Vec3d base = new Vec3d(stem.getX() + 0.5, feet.y + 0.65, stem.getZ() + 0.5);
        if (tick >= timberWorkUntil) return finishTimber();
        if (timberStand != null) {
            if (tick - timberApproachSince < 65 && horizontalDistance(feet, timberStand) > 0.42
                && approach(timberStand, false, false) != Walk.BLOCKED) {
                status = "walking to observed footing next to the timber";
                return true;
            }
            timberStand = null;
            timberScan = 0;
        }
        double distance = horizontalDistance(feet, base);
        if (!timberNear && distance > 2.8) {
            status = "approaching the witnessed trunk";
            if (distance <= 5.3 && timberApproachSince == 0) timberApproachSince = tick;
            if ((timberApproachSince == 0 || tick - timberApproachSince < 48)
                && approach(base, false, false) != Walk.BLOCKED) return true;
            if (distance > 5.3) return finishTimber();
        }
        timberNear = true;
        return scanTimberStem(base, distance);
    }

    private boolean scanTimberStem(Vec3d base, double distance) {
        Vec3d feet = c.player.getPos();
        BlockPos stem = timberWitness.getBlockPos();
        if (timberScan >= 3) return findTimberStand(base);
        Vec3d probe = switch (timberScan) {
            case 0 -> base;
            case 1 -> base.add(0, 1.65, 0);
            default -> base.add(0, 3.25, 0);
        };
        body.aim(probe);
        status = "checking the witnessed trunk from the base upward";
        if (!body.aligned(probe)) return true;
        Vec3d eye = c.player.getEyePos();
        int low = c.player.getBlockY() - 2;
        int high = MathHelper.floor(eye.y + Math.sqrt(Math.max(0, REACH * REACH - distance * distance)));
        if (timberScan == 0 && timberLastCut == null) high = Math.min(high, c.player.getBlockY() + 2);
        BlockPos next = timberLastCut == null ? stem : timberLastCut.up();
        BlockHitResult mask = null;
        for (int y = low; y <= high; y++) {
            Vec3d center = new Vec3d(base.x, y + 0.5, base.z);
            if (center.squaredDistanceTo(eye) > (REACH + 0.35) * (REACH + 0.35)) continue;
            BlockHitResult hit = perceive(center, Math.min(REACH, eye.distanceTo(center) + 0.03));
            if (hit == null) continue;
            if (sameStem(hit.getBlockPos(), stem) && state(hit).isIn(BlockTags.LOGS) && !timberUnderfoot(hit.getBlockPos())) {
                beginTimberChop(hit, false);
                return true;
            }
            if (timberLeafCuts < 2 && (y == next.getY() || y == next.getY() + 1) && isTimberPassage(hit)
                && hit.getBlockPos().getSquaredDistance(next) <= 4) mask = hit;
        }
        if (timberLastCut == null && timberScan > 0) {
            Vec3d point = timberAim(timberWitness);
            BlockHitResult hit = perceive(point, REACH);
            if (hit != null && hit.getBlockPos().equals(stem) && state(hit).isIn(BlockTags.LOGS) && !timberUnderfoot(stem)) {
                beginTimberChop(hit, false);
                return true;
            }
        }
        Vec3d above = Vec3d.ofCenter(next);
        if (timberLastCut != null && eye.squaredDistanceTo(above) < REACH * REACH
            && body.clearTerrain(above)) return finishTimber();
        if (mask != null) {
            beginTimberChop(mask, true);
            return true;
        }
        if (++timberScan == 3) {
            if (timberStandIndex == 0) timberStandYaw = distance > 0.45
                ? yaw(feet.subtract(base)) : c.player.getYaw();
        }
        return true;
    }

    private boolean findTimberStand(Vec3d base) {
        if (timberStandIndex >= TIMBER_STAND_TURNS.length) return finishTimber();
        Vec3d feet = c.player.getPos();
        Vec3d around = forward(timberStandYaw + TIMBER_STAND_TURNS[timberStandIndex]);
        Vec3d toe = new Vec3d(base.x + 1.85 * around.x, feet.y - 0.65, base.z + 1.85 * around.z);
        status = "looking for safe footing beside the witnessed trunk";
        if (horizontalDistance(feet, toe) < 0.7) {
            timberStandIndex++;
            return true;
        }
        body.aim(toe);
        if (!body.aligned(toe)) return true;
        BlockHitResult floor = terrain(toe, Math.min(5.5, c.player.getEyePos().distanceTo(toe) + 0.28));
        timberStandIndex++;
        if (floor == null || floor.getSide() != Direction.UP || !safeSupport(floor)
            || Math.abs(floor.getPos().y - feet.y) > 1.15 || horizontalDistance(floor.getPos(), toe) > 0.75
            || state(floor).isIn(BlockTags.LEAVES) || state(floor).isIn(BlockTags.LOGS)) return true;
        BlockPos square = floor.getBlockPos();
        timberStand = new Vec3d(square.getX() + 0.5, floor.getPos().y, square.getZ() + 0.5);
        timberApproachSince = tick;
        status = "choosing observed footing beside the witnessed trunk";
        approachGoal = null;
        return true;
    }

    private boolean finishTimber() {
        exhaustedStem = timberWitness.getBlockPos();
        timberWitness = null;
        timberLastCut = null;
        timberStand = null;
        return false;
    }

    private boolean isTimberPassage(BlockHitResult hit) {
        return hit.getPos().squaredDistanceTo(c.player.getEyePos()) < (REACH - 0.15) * (REACH - 0.15)
            && state(hit).isIn(BlockTags.LEAVES) && !timberUnderfoot(hit.getBlockPos());
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
        timberChopUntil = tick + 110;
        if (leaves) timberLeafCuts++;
    }

    private void chopTimber() {
        status = timberCuttingLeaves ? "opening a visible passage through leaves" : "chopping the witnessed trunk";
        BlockPos block = timberChop.getBlockPos();
        if (tick >= timberChopUntil || timberUnderfoot(block)
            || c.player.getEyePos().distanceTo(timberChopPoint) > REACH) {
            timberChop = null;
            timberScan = 0;
            return;
        }
        body.aim(timberChopPoint);
        if (!body.aligned(timberChopPoint)) return;
        BlockHitResult hit = perceive(timberChopPoint, REACH);
        if (hit != null && hit.getBlockPos().equals(block)) {
            BlockState material = state(hit);
            if (material.isIn(timberCuttingLeaves ? BlockTags.LEAVES : BlockTags.LOGS)) {
                if (readyForMine(material)) {
                    if (body.outlined(block)) timberAttack = tick;
                    body.mine(block);
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
            timberStandIndex = timberScan = 0;
            timberChop = null;
        } else if (hit != null || cleared || timberAttack != 0 && tick - timberAttack > 10) {
            timberChop = null;
            // Re-observe the column before changing position or choosing another leaf.
            timberScan = 0;
        }
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
        // A tiny inset retains the known face direction even after a small perspective change.
        targetPoint = hit.getPos().lerp(Vec3d.ofCenter(target), 0.045);
        targetDeadline = tick + 200;
        targetNearest = c.player.getEyePos().distanceTo(targetPoint);
        lastMining = 0;
        approachGoal = null;
    }

    private boolean reachableResourceFace(BlockPos position) {
        return !ignored(position) && !position.equals(c.player.getBlockPos().down());
    }

    private void mineTarget(Resource resource) {
        status = "mining " + resource.label;
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
        lastMining = tick;
        body.mine(target);
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
        if (delta.getY() < -1.05 && drop != LOG && (has(STONE_PICK, 1) || has(IRON_PICK, 1) || has(WOOD_PICK, 1))
            && tick >= nextDigStart && c.player.isOnGround()) {
            status = "cutting a staircase to visible drops";
            excavate(BlockPos.ofFloored(position).getY(), position);
            return true;
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
            if (delta.getY() > 0.55) body.jump();
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
        if (nextFoot == null && !c.player.isOnGround()) return;
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
            if (shouldLight(true)) return;
            forcedLight = false;
            if (torchPlacedTick != tick) blockedTunnel();
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
            nextStepProved = true;
            walkDown(false);
        } else if (hit != null && hit.getBlockPos().equals(current.down()) && hit.getSide() == Direction.UP) {
            // Crouch toward the lip on the proven current support to reveal the next one.
            creepToLip();
        } else if (hit != null || !body.outlined(nextFoot.down()) || !lightDigOnce(current)) {
            blockedTunnel();
        }
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
            BlockHitResult outline = body.selectedFace();
            return body.outlined(position) || outline != null && c.player.getEyePos().distanceTo(outline.getPos()) < length
                ? Dig.DARK : Dig.CLEAR;
        }
        if (!hit.getBlockPos().equals(position)) {
            if (hit.getBlockPos().equals(lip) && hit.getSide() == Direction.UP && safeSupport(hit)) return Dig.LIP;
            return c.player.getEyePos().distanceTo(hit.getPos()) < length - 0.17 ? Dig.BLOCKED : Dig.CLEAR;
        }
        BlockState state = state(hit);
        if (state.isReplaceable() && state.getFluidState().isEmpty() && !state.isOf(Blocks.SNOW)) return Dig.CLEAR;
        if (dangerous(state) || !state.getFluidState().isEmpty()
            || state.getHardness(c.world, position) < 0 || state.isOf(Blocks.OBSIDIAN)
            || state.isOf(Blocks.CRYING_OBSIDIAN) || state.isOf(Blocks.CRAFTING_TABLE)
            || state.isOf(Blocks.FURNACE)) return Dig.BLOCKED;
        if (!tools.canHarvest(state)) return Dig.BLOCKED;
        if (!readyForMine(state)) return Dig.LOOKING;
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
        if (!hold(TORCH)) return true;
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
        if (hit != null && hit.getSide() != Direction.DOWN && (visibleSupport || forced && shown == hit)
            && (nextFoot == null || !hit.getBlockPos().offset(hit.getSide()).equals(nextFoot))) {
            body.use(hit.getBlockPos(), hit.getSide());
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
            return;
        }
        if (resumeStep != resumeIndex) {
            resumeStep = resumeIndex;
            returnAge = tick;
            climbTo = null;
        }
        BlockPos next = trail.get(resumeIndex);
        BlockPos current = c.player.getBlockPos();
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
        if (++climbDrive > 27) return Walk.BLOCKED;
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
        if (!hold(BUILDING)) return true;
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

    private boolean escapeDanger() {
        if (c.player.isInLava() || c.player.isTouchingWater() && c.player.getAir() < 70) {
            interruptHands();
            status = c.player.isInLava() ? "escaping lava" : "surfacing for air";
            body.jump();
            body.walk(true);
            return true;
        }
        LivingEntity threat = body.threat(7).orElse(null);
        if (threat != null) {
            interruptHands();
            double distance = c.player.getPos().distanceTo(threat.getPos());
            boolean flee = threat instanceof CreeperEntity || c.player.getHealth() <= 7;
            if (flee) {
                status = threat instanceof CreeperEntity ? "backing off a creeper" : "retreating while hurt";
                if (tick >= retreatUntil - 10) {
                    Vec3d away = c.player.getPos().subtract(threat.getPos());
                    retreatYaw = yaw(away);
                    retreatUntil = tick + 15;
                }
            } else {
                status = "defending against a visible hostile";
                if (distance > 2.9) {
                    walkToward(threat.getPos(), false, false);
                } else {
                    Vec3d point = threat.getBoundingBox().getCenter();
                    body.aim(point);
                    if (body.aligned(point) && c.player.getAttackCooldownProgress(0.5f) >= 0.85f) body.strike(threat);
                }
                return true;
            }
        }
        if (tick < retreatUntil) {
            if (step(forward(retreatYaw), true, true) == Walk.BLOCKED) retreatYaw += 65;
            return true;
        }
        return false;
    }

    private void interruptHands() {
        if (hands.busy()) hands.cancel();
        if (c.currentScreen instanceof HandledScreen<?>) c.currentScreen.close();
    }

    private boolean eatOrHunt() {
        int hunger = c.player.getHungerManager().getFoodLevel();
        if (hunger > 14 && !c.player.isUsingItem()) return false;
        if (has(FOOD, 1) && hunger < 20) {
            status = "eating";
            if (hold(FOOD)) {
                body.turn(c.player.getYaw(), -35);
                body.holdUse();
            }
            return true;
        }
        if (hunger > 10) {
            foraging = false;
            return false;
        }
        if (hunger <= 7 && activeTrail() > 1 && returnIndex < 0 && exitStart == null) {
            foraging = true;
            beginReturn(true);
            return true;
        }
        if (activeTrail() > 1 || returnIndex >= 0 || exitStart != null) return false;
        if (collect(FOOD, 8)) return true;
        Entity animal = body.visibleEntity(PilotProgress::edibleAnimal, 12).orElse(null);
        if (animal == null) {
            if (!foraging) return false;
            status = "searching above ground for food";
            explore();
            return true;
        }
        status = "foraging for food";
        if (c.player.getPos().distanceTo(animal.getPos()) > 2.75) {
            return approach(animal.getPos(), false, false) != Walk.BLOCKED;
        }
        Vec3d point = animal.getBoundingBox().getCenter();
        body.aim(point);
        if (body.aligned(point) && c.player.getAttackCooldownProgress(0.5f) >= 0.85f) body.strike(animal);
        return true;
    }

    private static boolean edibleAnimal(Entity entity) {
        return entity.getType() == EntityType.COW || entity.getType() == EntityType.PIG
            || entity.getType() == EntityType.SHEEP || entity.getType() == EntityType.MOOSHROOM
            || entity.getType() == EntityType.RABBIT;
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
            Vec3d stepTop = Vec3d.ofCenter(shin.getBlockPos(), 0.48);
            BlockHitResult landing = terrain(stepTop, c.player.getEyePos().distanceTo(stepTop) + 0.12);
            if (landing == null || !landing.getBlockPos().equals(shin.getBlockPos())
                || landing.getSide() != Direction.UP || !safeSupport(landing)) return Footing.UNKNOWN;
            Vec3d upper = feet.add(heading.multiply(1.55)).add(0, 2.35, 0);
            BlockHitResult ceiling = terrain(upper, c.player.getEyePos().distanceTo(upper));
            return ceiling == null ? Footing.JUMP : Footing.BLOCKED;
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

    private boolean hold(Predicate<ItemStack> predicate) {
        if (predicate.test(c.player.getMainHandStack())) return true;
        hands.equip(predicate);
        return false;
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
