package io.gameharness.pilot;

import java.util.ArrayList;
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
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.mob.CreeperEntity;
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
    private static final float[] DETOURS = {34, 62, -34, -62};
    private static final float[] SCOUT_HEADINGS = {35, 65, 100, 145, 180, 235, 280, 320};
    private static final double[] FLOOR_FORWARD = {1.55, 2.2, 2.0};
    private static final double[] FLOOR_BELOW = {0.65, 1.55, 2.9};
    // Work above the deep lava seas, leaving more than a block of margin below the floor.
    private static final int DIAMOND_LEVEL = -52;
    private static final Predicate<ItemStack> LOG = stack -> stack.isIn(ItemTags.LOGS);
    private static final Predicate<ItemStack> BURNABLE_LOG = stack -> stack.isIn(ItemTags.LOGS_THAT_BURN);
    private static final Predicate<ItemStack> PLANK = stack -> stack.isIn(ItemTags.PLANKS);
    private static final Predicate<ItemStack> STONE = stack -> stack.isIn(ItemTags.STONE_TOOL_MATERIALS);
    private static final Predicate<ItemStack> FUEL = stack -> stack.isIn(ItemTags.COALS);
    private static final Predicate<ItemStack> STICK = item(Items.STICK);
    private static final Predicate<ItemStack> WOOD_PICK = item(Items.WOODEN_PICKAXE);
    private static final Predicate<ItemStack> STONE_PICK = item(Items.STONE_PICKAXE);
    private static final Predicate<ItemStack> IRON_PICK = item(Items.IRON_PICKAXE);
    private static final Predicate<ItemStack> SHOVEL = stack -> stack.isOf(Items.WOODEN_SHOVEL)
        || stack.isOf(Items.STONE_SHOVEL) || stack.isOf(Items.IRON_SHOVEL) || stack.isOf(Items.DIAMOND_SHOVEL)
        || stack.isOf(Items.NETHERITE_SHOVEL) || stack.isOf(Items.GOLDEN_SHOVEL);
    private static final Predicate<ItemStack> RAW_IRON = item(Items.RAW_IRON);
    private static final Predicate<ItemStack> INGOT = item(Items.IRON_INGOT);
    private static final Predicate<ItemStack> TORCH = item(Items.TORCH);
    private static final Predicate<ItemStack> FOOD = stack -> stack.contains(DataComponentTypes.FOOD)
        && !stack.isOf(Items.ROTTEN_FLESH) && !stack.isOf(Items.SPIDER_EYE)
        && !stack.isOf(Items.POISONOUS_POTATO) && !stack.isOf(Items.PUFFERFISH)
        && !stack.isOf(Items.CHICKEN);

    private enum Resource {
        WOOD(state -> state.isIn(BlockTags.LOGS), LOG, "wood"),
        IRON(state -> state.isOf(Blocks.IRON_ORE) || state.isOf(Blocks.DEEPSLATE_IRON_ORE), RAW_IRON, "iron"),
        DIAMOND(state -> state.isOf(Blocks.DIAMOND_ORE) || state.isOf(Blocks.DEEPSLATE_DIAMOND_ORE),
            item(Items.DIAMOND), "diamond"),
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
    private enum Dig { LOOKING, CLEAR, BLOCKED, DARK }
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
        BlockHitResult face;
        BlockPos rejected, niche, underfoot;
        int siteSince, stageSince, stage;

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
    private final String goal;
    private final Predicate<ItemStack> goalItem;
    private final Station table = new Station(Blocks.CRAFTING_TABLE, Items.CRAFTING_TABLE, "crafting_table");
    private final Station furnace = new Station(Blocks.FURNACE, Items.FURNACE, "furnace");
    // Only points the player has reached. Retreat never consults terrain behind the camera.
    private final List<BlockPos> trail = new ArrayList<>();
    private int tick;
    private boolean win;
    private String status = "starting";
    private String tableRecipe;
    private String tableExtra;
    private Firing firing = Firing.NONE;
    private int furnacePoll;
    private int furnaceDeadline;
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
    private Entity pickupEntity;
    private Predicate<ItemStack> pickupItem;
    private Vec3d pickupPosition;
    private int pickupCount;
    private int pickupStarted;
    private int pickupSeen;
    private int timberSurveyUntil;
    private boolean timberReady;
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
    private BlockPos climbTo;
    private int climbCheck;
    private int climbDrive;
    private int climbDeadline;
    private Vec3d motionPosition;
    private int motionTick;
    private int stuck;
    private float routeRequest = Float.NaN;
    private float routeYaw;
    private int routeUntil;
    private int routeTick;
    private Vec3d approachGoal;
    private Vec3d detourStart;
    private int detourIndex = -1;
    private int detourDeadline;
    private int approachDeadline;
    private double approachNearest;
    private double detourDistance;
    private float detourYaw;
    private int retreatUntil;
    private float retreatYaw;
    private float previousHealth = Float.NaN;
    private Direction digDirection;
    private Direction digPrimary;
    private BlockPos nextFoot;
    private int clearIndex;
    private int digAge;
    private Vec3d digGoal;
    private int legLength;
    private int branchTurns;
    private int failedDirections;
    private int returnIndex = -1;
    private int returnAge;
    private int returnClear;
    private int nextDigStart;
    private int litIndex;
    private int torchAttempt;
    private int torchFace;
    private int torchBefore;
    private int torchUsed;
    private int torchPlacedTick;
    private boolean forcedLight;

    PilotProgress(MinecraftClient c, PilotBody body, PilotHands hands, String goal) {
        this.c = c;
        this.body = body;
        this.hands = hands;
        tools = new PilotTools(c, hands);
        this.goal = goal;
        goalItem = switch (goal) {
            case "wooden_pickaxe" -> WOOD_PICK;
            case "stone_pickaxe" -> STONE_PICK;
            case "iron_pickaxe" -> IRON_PICK;
            case "diamond" -> item(Items.DIAMOND);
            default -> throw new IllegalArgumentException("Unsupported survival goal: " + goal);
        };
    }

    boolean won() {
        return win;
    }

    String failure() {
        return stopped;
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
        if (!hands.busy() && c.currentScreen == null && has(goalItem, 1)) {
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

        boolean ironPick = has(IRON_PICK, 1);
        boolean stonePick = has(STONE_PICK, 1);
        boolean woodPick = has(WOOD_PICK, 1);
        if (nextFoot != null && (woodPick || stonePick || ironPick)) {
            excavate(nextFoot.getY(), digGoal);
            return;
        }
        if (!timberReady) {
            boolean longGoal = goal.equals("iron_pickaxe") || goal.equals("diamond");
            int timber = hands.count(PLANK) + 4 * hands.count(LOG);
            if (longGoal && woodPick && !stonePick && !ironPick && trail.isEmpty() && timber < 20) {
                gather(Resource.WOOD, Integer.MAX_VALUE, 0);
                return;
            }
            timberReady = !longGoal || woodPick || stonePick || ironPick;
        }
        if (!woodPick && !stonePick && !ironPick) {
            if (has(STONE, 3)) makePick("stone_pickaxe", STONE, 3);
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
        if (!ironPick && has(INGOT, 3)) {
            firing = Firing.NONE;
            makePick("iron_pickaxe", INGOT, 3);
            return;
        }
        if (firing != Firing.NONE) {
            fire(firing);
            return;
        }
        if (!ironPick && hands.count(RAW_IRON) + hands.count(INGOT) >= 3) {
            fire(Firing.IRON);
            return;
        }
        int torchReserve = trail.size() < 3 && c.player.getY() > 24 ? 12 : 2;
        if (!has(TORCH, torchReserve) && craftTorches(torchReserve)) return;
        if (ironPick && !stonePick && has(STONE, 3)) {
            makePick("stone_pickaxe", STONE, 3);
            return;
        }
        if (!has(TORCH, torchReserve)) {
            prepareLight();
            return;
        }
        gather(ironPick ? Resource.DIAMOND : Resource.IRON, ironPick ? 40 : 210, ironPick ? DIAMOND_LEVEL : 16);
    }

    private boolean handleScreen() {
        if (c.currentScreen == null) return false;
        if (c.currentScreen instanceof CraftingScreen && tableRecipe != null) {
            table.openAttempts = 0;
            String recipe = tableRecipe;
            String extra = tableExtra;
            tableRecipe = null;
            tableExtra = null;
            status = "crafting " + recipe;
            int planks = recipe.equals("wooden_pickaxe") ? 3 : recipe.equals("wooden_shovel") ? 1 : 0;
            if ("wooden_shovel".equals(extra)) planks++;
            int sticks = recipe.equals("furnace") ? 0 : extra == null ? 2 : 4;
            if (!affordsWood(planks, sticks)) {
                c.currentScreen.close();
                return true;
            }
            List<String> recipes = woodBatch(planks, sticks);
            recipes.add(recipe);
            if (extra != null) recipes.add(extra);
            if (!hands.craftBatch(recipes)) c.currentScreen.close();
        } else if (c.currentScreen instanceof FurnaceScreen && firing != Firing.NONE) {
            furnace.openAttempts = 0;
            status = firing == Firing.IRON ? "smelting iron" : "making charcoal";
            if (hands.smelt(firing == Firing.CHARCOAL)) {
                furnacePoll = tick + 16;
            } else {
                String result = hands.status();
                furnacePoll = tick + (result.equals("smelt: cooking") ? 65 : 24);
                if (result.equals("smelt: no input")) firing = Firing.NONE;
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
        requestTable(recipe, extra, plankCost, extra == null ? 2 : 4);
    }

    private void requestTable(String recipe, String extra, int planks, int sticks) {
        if (!ensureTable(planks, sticks)) return;
        if (table.position != null && trail.size() > 1 && trail.size() <= 14
            && table.position.getY() - c.player.getY() >= 2
            && Vec3d.ofCenter(table.position).distanceTo(Vec3d.ofBottomCenter(trail.getFirst())) < 4) {
            beginReturn();
            return;
        }
        tableRecipe = recipe;
        tableExtra = extra;
        useStation(table);
    }

    private boolean ensureTable(int planks, int sticks) {
        if (table.position == null && !has(table.item, 1)) {
            BlockHitResult visible = body.find(state -> state.isOf(table.block), 4.1).orElse(null);
            if (visible != null) {
                table.position = visible.getBlockPos();
                table.placed = 0;
                table.approachUntil = 0;
                approachGoal = null;
            }
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
        if (trail.size() > 1) {
            beginReturn();
            retreatTunnel();
        } else {
            gather(Resource.WOOD, Integer.MAX_VALUE, 0);
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

    private void prepareLight() {
        if (collect(FUEL, 6)) return;
        BlockHitResult coal = body.find(Resource.COAL.block, 4.1).orElse(null);
        if ((target != null && miningResource == Resource.COAL) || coal != null && !ignored(coal.getBlockPos())) {
            if (target == null || miningResource != Resource.COAL) setTarget(coal, Resource.COAL);
            mineTarget(Resource.COAL);
            return;
        }
        if (trail.size() > 2) {
            beginReturn();
            return;
        }
        if (!has(BURNABLE_LOG, 3)) {
            gather(Resource.WOOD, Integer.MAX_VALUE, 0);
            return;
        }
        fire(Firing.CHARCOAL);
    }

    private void fire(Firing batch) {
        if (batch == Firing.CHARCOAL && has(FUEL, 3)) {
            firing = Firing.NONE;
            return;
        }
        if (firing == Firing.NONE) {
            if (!has(FUEL, 1) && !supplyPlanks(3)) return;
            if (furnace.position == null && !has(furnace.item, 1)) {
                if (collect(furnace.item, 6)) return;
                if (!has(STONE, 8)) {
                    gatherStone();
                    return;
                }
                if (!ensureTable(0, 0)) return;
                tableRecipe = "furnace";
                tableExtra = null;
                useStation(table);
                return;
            }
            firing = batch;
            furnacePoll = tick;
            furnaceDeadline = tick + 1_550;
        }
        if (tick > furnaceDeadline || (furnace.position == null && !has(furnace.item, 1))) {
            firing = Firing.NONE;
            return;
        }
        // Inputs are no longer in inventory once loaded. Preserve custody until output settles.
        if (tick < furnacePoll) {
            status = "waiting for furnace";
            return;
        }
        if (hands.status().equals("smelt: no fuel") && !has(FUEL, 1) && !supplyPlanks(3)) return;
        useStation(furnace);
    }

    private void useStation(Station station) {
        status = "using " + station.recipe;
        if (station.position != null) {
            Vec3d center = Vec3d.ofCenter(station.position);
            double distance = c.player.getEyePos().distanceTo(center);
            if (distance > 3.75 || tick < station.approachUntil) {
                if (approach(center, false, false) == Walk.BLOCKED) station.position = null;
                return;
            }
            body.aim(center);
            if (!body.aligned(center)) return;
            BlockHitResult hit = perceive(center, REACH);
            boolean visible = hit != null && hit.getBlockPos().equals(station.position);
            BlockHitResult selected = body.selectedFace();
            boolean remembered = selected != null && selected.getBlockPos().equals(station.position)
                && (station.placed == 0 || !has(station.item, station.placementCount));
            if (visible || remembered) {
                if (visible && !state(hit).isOf(station.block)) {
                    station.position = null;
                    return;
                }
                station.placed = 0;
                station.siteSince = station.stage = 0;
                station.niche = station.underfoot = station.rejected = null;
                if (station.openAttempts >= 5) {
                    station.openAttempts = 0;
                    station.approachUntil = tick + 12;
                    return;
                }
                if (tick - station.opened > 7) {
                    BlockHitResult targetFace = visible ? hit : selected;
                    body.use(targetFace.getBlockPos(), targetFace.getSide());
                    station.opened = tick;
                    station.openAttempts++;
                }
            } else if (hit != null && c.player.getEyePos().distanceTo(hit.getPos()) > distance + 0.25
                || station.placed != 0 && tick - station.placed > 16 && has(station.item, station.placementCount)) {
                // A ray through the center, or unchanged inventory after our own placement, refutes this position.
                station.rejected = station.position;
                station.position = null;
            } else if (station.placed == 0 || tick - station.placed > 16) {
                station.approachUntil = tick + 24;
            }
            return;
        }
        BlockHitResult seen = body.find(state -> state.isOf(station.block), 5.0).orElse(null);
        if (seen != null) {
            station.position = seen.getBlockPos();
            station.placed = 0;
            station.approachUntil = 0;
            approachGoal = null;
            return;
        }
        placeStation(station);
    }

    private void placeStation(Station station) {
        if (station.siteSince == 0) station.siteSince = station.stageSince = tick;
        if (tick - station.siteSince > 190) {
            stopped = "stopped: no reachable placement face for " + station.recipe;
            return;
        }
        if (station.face == null) station.face = body.stationFace(station.rejected);
        if (station.face != null) {
            var face = station.face;
            if (!hold(station.item)) return;
            body.sneak();
            Vec3d point = face.getPos().lerp(Vec3d.ofCenter(face.getBlockPos()), 0.015);
            body.aim(point);
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
            station.niche = c.player.getBlockPos().offset(c.player.getHorizontalFacing()).up();
        }
        if (station.stage == 1) {
            // Cut one bench-sized recess in an observed wall when the passage is only one block wide.
            status = "making room for " + station.recipe;
            Dig result = clear(station.niche);
            if (result == Dig.LOOKING && tick - station.stageSince < 76) return;
            station.stage = 2;
            station.stageSince = tick;
        }
        // A shaft may have no side face outside our body. Vanilla permits jump-placing on the
        // floor we stand on; the real player must rise completely above the destination first.
        if (!hold(station.item)) return;
        if (station.underfoot == null) {
            if (!c.player.isOnGround()) return;
            station.underfoot = c.player.getBlockPos().down();
        }
        var base = station.underfoot;
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
            sought = resource;
            soughtSince = tick;
            target = null;
            pickupUntil = 0;
        }
        status = "seeking " + resource.label;
        if (target != null) {
            mineTarget(miningResource);
            return;
        }
        if (collect(resource.drop, 7)) return;
        if (tick < pickupUntil) {
            if (pickupLook != null) body.aim(pickupLook);
            return;
        }
        if (tick >= seekAfter || trail.size() > 1) {
            BlockHitResult hit = body.find(resource.block, resource == Resource.WOOD ? 22 : SEARCH).orElse(null);
            if (hit != null && !ignored(hit.getBlockPos())) {
                setTarget(hit, resource);
                mineTarget(resource);
                return;
            }
            if ((resource == Resource.IRON || resource == Resource.DIAMOND) && !has(TORCH, 4)) {
                if (collect(FUEL, 5)) return;
                hit = body.find(Resource.COAL.block, 4.0).orElse(null);
                if (hit != null && !ignored(hit.getBlockPos())) {
                    setTarget(hit, Resource.COAL);
                    mineTarget(Resource.COAL);
                    return;
                }
            }
        }
        if (resource == Resource.WOOD && tick < timberSurveyUntil && pickupLook != null) {
            Vec3d feet = c.player.getPos();
            Vec3d stem = Vec3d.ofCenter(BlockPos.ofFloored(pickupLook));
            if (horizontalDistance(feet, stem) > 0.5) body.aim(new Vec3d(stem.x, feet.y + 2.65, stem.z));
            return;
        }
        if (resource != Resource.WOOD && (trail.size() > 1 || tick - soughtSince > onSurfaceTicks)
            && tick >= nextDigStart && (c.player.isOnGround() || !trail.isEmpty()) && !c.player.isTouchingWater()) {
            excavate(depth, null);
        } else {
            explore();
        }
    }

    private void gatherStone() {
        status = "gathering stone from the staircase";
        if (nextFoot == null && collect(STONE, 5)) return;
        if (c.player.isTouchingWater() || tick < nextDigStart) {
            explore();
            return;
        }
        if (c.player.isOnGround()) excavate(42, null);
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
        if (resource != Resource.WOOD && c.player.getY() - target.getY() > 1.25
            && c.player.isOnGround() && tick >= nextDigStart) {
            status = "cutting a staircase toward exposed " + resource.label;
            excavate(target.getY() + 1, targetPoint);
            return;
        }
        if (distance > REACH - 0.45) {
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
                pickupLook = new Vec3d(targetPoint.x, Math.min(c.player.getY() + 0.2, targetPoint.y), targetPoint.z);
                if (resource == Resource.WOOD) timberSurveyUntil = tick + 30;
                target = null;
            } else if (resource != Resource.WOOD && horizontalDistance(c.player.getPos(), targetPoint) > 0.72) {
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
        if (!tools.readyFor(material)) return;
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
        if (tick < pickupBlockedUntil) return false;
        var entity = body.dropped(drop, range).orElse(null);
        if (pickupItem == drop && hands.count(drop) > pickupCount) clearPickup();
        if (entity != null) {
            if (pickupEntity != entity) {
                pickupEntity = entity;
                pickupItem = drop;
                pickupCount = hands.count(drop);
                pickupStarted = tick;
            }
            pickupSeen = tick;
            pickupPosition = entity.getPos();
        }
        if (pickupItem != drop || pickupPosition == null) return false;
        if (tick - pickupStarted > 180 || tick - pickupSeen > 95) {
            clearPickup();
            pickupBlockedUntil = tick + 45;
            return false;
        }
        Vec3d position = pickupPosition;
        Vec3d delta = position.subtract(c.player.getPos());
        if (delta.getY() > 1.45) {
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
            body.turn(c.player.getYaw(), delta.y < 0 ? 68 : 35);
            if (delta.getY() > 0.55) body.jump();
            if (entity != null || tick - pickupSeen < 12) return true;
            clearPickup();
            return false;
        }
        if (approach(position, false, false) == Walk.BLOCKED) {
            clearPickup();
            pickupBlockedUntil = tick + 32;
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

    private void excavate(int depth, Vec3d toward) {
        BlockPos standing = c.player.getBlockPos();
        if (nextFoot != null && arrived(nextFoot)) {
            if (!nextFoot.equals(trail.getLast())) trail.add(nextFoot);
            nextFoot = null;
            failedDirections = 0;
            legLength++;
            return;
        }
        if (nextFoot == null && !c.player.isOnGround()) return;
        if (nextFoot == null && !trail.isEmpty() && !standing.equals(trail.getLast())) {
            if (Vec3d.ofBottomCenter(trail.getLast()).distanceTo(c.player.getPos()) > 2.45) trail.clear();
            else trail.add(standing);
        }
        if (trail.isEmpty()) {
            trail.add(standing);
            digDirection = c.player.getHorizontalFacing();
            branchTurns = failedDirections = legLength = litIndex = 0;
            torchAttempt = torchFace = torchUsed = 0;
        }
        BlockPos current = trail.getLast();
        if (current.getY() > depth) status = "descending a mined staircase";
        else status = "branch mining at y=" + current.getY();
        if (nextFoot == null) {
            if (shouldLight(false)) return;
            if (toward != null && failedDirections == 0) {
                Vec3d delta = toward.subtract(Vec3d.ofBottomCenter(current));
                if (delta.horizontalLengthSquared() > 0.36) digDirection = directional(delta);
            } else if (current.getY() <= depth && legLength >= 22) {
                digDirection = (branchTurns++ & 1) == 0
                    ? digDirection.rotateYClockwise() : digDirection.rotateYCounterclockwise();
                legLength = 0;
            }
            if (failedDirections == 0) digPrimary = digDirection;
            nextFoot = current.offset(digDirection);
            if (current.getY() > depth) nextFoot = nextFoot.down();
            clearIndex = nextFoot.getY() < current.getY() ? 2 : 1;
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
            Dig result = clear(nextFoot.up(clearIndex));
            if (result == Dig.CLEAR) clearIndex--;
            else if (result == Dig.DARK) {
                if (has(TORCH, 1)) forcedLight = true;
                else blockedTunnel();
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
            if (nextFoot.getY() < current.getY()) walkDown(false);
            else walk(false);
        } else if (hit != null && hit.getBlockPos().equals(current.down()) && hit.getSide() == Direction.UP) {
            // Crouch toward the lip on the proven current support to reveal the next one.
            body.sneak();
            walk(false);
            if (stuck >= 13) blockedTunnel();
        } else if (hit == null && has(TORCH, 1)) {
            forcedLight = true;
        } else {
            blockedTunnel();
        }
    }

    private Dig clear(BlockPos position) {
        return clear(position, Vec3d.ofCenter(position));
    }

    private Dig clear(BlockPos position, Vec3d point) {
        body.aim(point);
        if (!body.aligned(point)) return Dig.LOOKING;
        double length = c.player.getEyePos().distanceTo(point);
        BlockHitResult hit = perceive(point, length + 0.18);
        if (hit == null) {
            return body.outlined(position) ? Dig.DARK : Dig.CLEAR;
        }
        if (!hit.getBlockPos().equals(position)) {
            return c.player.getEyePos().distanceTo(hit.getPos()) < length - 0.17 ? Dig.BLOCKED : Dig.CLEAR;
        }
        BlockState state = state(hit);
        if (state.isReplaceable() && state.getFluidState().isEmpty()) return Dig.CLEAR;
        if (dangerous(state) || !state.getFluidState().isEmpty()
            || state.getHardness(c.world, position) < 0 || state.isOf(Blocks.OBSIDIAN)
            || state.isOf(Blocks.CRYING_OBSIDIAN) || state.isOf(Blocks.CRAFTING_TABLE)
            || state.isOf(Blocks.FURNACE) && firing != Firing.NONE) return Dig.BLOCKED;
        if (!tools.canHarvest(state)) return Dig.BLOCKED;
        if (!tools.readyFor(state)) return Dig.LOOKING;
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
        if (torchFace >= 3) {
            torchFace = torchAttempt = 0;
            // Recheck after reaching another spot, not for several dark staircase steps.
            litIndex = trail.size() - 6;
            return false;
        }
        if (!hold(TORCH)) return true;
        Vec3d point;
        if (torchFace < 2) {
            Direction wall = torchFace == 0 ? digDirection.rotateYClockwise() : digDirection.rotateYCounterclockwise();
            point = Vec3d.ofCenter(c.player.getBlockPos().offset(wall));
        } else {
            Vec3d feet = c.player.getPos();
            point = feet.add(-0.75 * digDirection.getOffsetX(), -0.22, -0.75 * digDirection.getOffsetZ());
        }
        body.aim(point);
        if (!body.aligned(point)) return true;
        BlockHitResult hit = perceive(point, 2.2);
        if (hit != null && safeSupport(hit)) {
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
        nextFoot = null;
        forcedLight = false;
        if (++failedDirections == 3) {
            beginReturn();
        } else {
            digDirection = failedDirections == 1 ? digPrimary.rotateYClockwise() : digPrimary.rotateYCounterclockwise();
            legLength = 0;
        }
    }

    private void beginReturn() {
        returnIndex = trail.size() - 1;
        returnAge = tick;
        returnClear = -1;
        climbTo = null;
        nextFoot = null;
        forcedLight = false;
    }

    private void retreatTunnel() {
        status = "returning along traveled steps";
        if (returnIndex < 0) return;
        BlockPos next = trail.get(returnIndex);
        if (arrived(next)) {
            returnAge = tick;
            returnClear = -1;
            climbTo = null;
            if (--returnIndex >= 0) return;
            trail.clear();
            nextDigStart = tick + 170;
            headingUntil = tick;
            return;
        }
        if (tick - returnAge > 165) {
            startExitRecovery(directional(Vec3d.ofBottomCenter(next).subtract(c.player.getPos())));
            return;
        }
        BlockPos current = returnIndex + 1 < trail.size() ? trail.get(returnIndex + 1) : c.player.getBlockPos();
        if (next.getY() == current.getY() + 1
            && Math.abs(next.getX() - current.getX()) + Math.abs(next.getZ() - current.getZ()) == 1) {
            status = "climbing a traveled step";
            if (climb(current, next) == Walk.BLOCKED) {
                startExitRecovery(directional(Vec3d.ofBottomCenter(next).subtract(c.player.getPos())));
            }
            return;
        }
        if (returnClear >= 0) {
            if (forcedLight) {
                if (shouldLight(true)) return;
                forcedLight = false;
                if (torchPlacedTick != tick) returnClear--;
                return;
            }
            Dig result = clear(next.up(returnClear));
            if (result == Dig.DARK && has(TORCH, 1)) forcedLight = true;
            else if (result != Dig.LOOKING) returnClear--;
            return;
        }
        if (walkToward(Vec3d.ofBottomCenter(next), false, false) == Walk.BLOCKED) returnClear = 1;
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
        exitDeadline = tick + 430;
        climbTo = null;
    }

    private void recoverExit() {
        status = "searching for a visible upward exit";
        if (tick >= exitDeadline || exitSide >= 4 || c.player.getY() - exitStart.getY() > 7) {
            stopped = "stopped: no reachable visible exit";
            status = stopped;
            return;
        }
        if (exitTo != null) {
            if (arrived(exitTo)) {
                int rejoin = trail.lastIndexOf(exitTo);
                exitFrom = exitTo;
                exitTo = null;
                exitSide = 0;
                if (returnIndex >= 0 && rejoin >= 0 && rejoin <= returnIndex) {
                    exitStart = null;
                    climbTo = null;
                    returnIndex = rejoin;
                    returnAge = tick;
                } else if (returnIndex < 0 && exitFrom.getY() > exitStart.getY()) {
                    exitStart = null;
                    climbTo = null;
                    sweepOrigin = Vec3d.ofBottomCenter(exitFrom);
                    sweepHeading = heading = c.player.getYaw();
                    sweepIndex = 0;
                }
            } else if (climb(exitFrom, exitTo) == Walk.BLOCKED) {
                exitTo = null;
                climbTo = null;
                exitSide++;
            }
            return;
        }
        if (!c.player.isOnGround()) return;
        Direction direction = switch (exitSide) {
            case 0 -> exitHeading;
            case 1 -> exitHeading.rotateYClockwise();
            case 2 -> exitHeading.rotateYCounterclockwise();
            default -> exitHeading.getOpposite();
        };
        BlockPos support = exitFrom.offset(direction);
        Vec3d point = Vec3d.ofCenter(support, 0.33);
        body.aim(point);
        if (!body.aligned(point)) return;
        BlockHitResult hit = terrain(point, 2.7);
        if (hit == null || !hit.getBlockPos().equals(support) || !safeSupport(hit)) {
            exitSide++;
            return;
        }
        exitTo = support.up();
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
        if (hunger > 10 || !trail.isEmpty()) return false;
        if (collect(FOOD, 8)) return true;
        Entity animal = body.visibleEntity(PilotProgress::edibleAnimal, 12).orElse(null);
        if (animal == null) return false;
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
        if (step(forward(heading), false, true) == Walk.BLOCKED) {
            if (sweepOrigin == null) {
                sweepOrigin = feet;
                sweepHeading = heading;
                sweepIndex = 0;
            }
            if (sweepIndex >= SCOUT_HEADINGS.length) {
                if (trail.size() > 1) beginReturn();
                else if (has(WOOD_PICK, 1) || has(STONE_PICK, 1) || has(IRON_PICK, 1) || has(SHOVEL, 1)) {
                    startExitRecovery(directional(forward(sweepHeading)));
                } else {
                    stopped = "stopped: no reachable route from this stance";
                }
                sweepOrigin = null;
                return;
            }
            heading = sweepHeading + SCOUT_HEADINGS[sweepIndex++];
            headingUntil = tick + 270;
        }
    }

    private Walk walkToward(Vec3d point, boolean sprint, boolean allowWater) {
        Vec3d horizontal = point.subtract(c.player.getPos()).multiply(1, 0, 1);
        if (horizontal.horizontalLengthSquared() < 0.015) return Walk.BLOCKED;
        return step(horizontal.normalize(), sprint, allowWater);
    }

    /** Pick a short, committed sidestep rather than fighting the same face every tick. */
    private Walk approach(Vec3d point, boolean sprint, boolean allowWater) {
        Vec3d feet = c.player.getPos();
        double distance = feet.distanceTo(point);
        if (approachGoal == null || horizontalDistance(point, approachGoal) > 1.15) {
            approachGoal = point;
            detourIndex = -1;
            approachNearest = distance;
            approachDeadline = tick + 185;
        } else if (distance < approachNearest - 0.55) {
            approachNearest = distance;
            approachDeadline = tick + 185;
        }
        if (tick >= approachDeadline) return Walk.BLOCKED;
        if (detourIndex >= 0 && distance < detourDistance - 0.66) detourIndex = -1;
        if (detourIndex < 0) {
            Walk result = walkToward(point, sprint, allowWater);
            if (result != Walk.BLOCKED) return result;
        }
        if (detourIndex >= 0 && tick < detourDeadline && horizontalDistance(feet, detourStart) < 1.65) {
            Walk result = step(forward(detourYaw), false, allowWater);
            if (result != Walk.BLOCKED) return result;
        }
        if (++detourIndex >= DETOURS.length) {
            approachDeadline = tick;
            return Walk.BLOCKED;
        }
        detourYaw = yaw(point.subtract(feet)) + DETOURS[detourIndex];
        detourStart = feet;
        detourDistance = distance;
        detourDeadline = tick + 43;
        body.turn(detourYaw, 20);
        return Walk.LOOKING;
    }

    /** Look well ahead; drive only down a lane whose near support is visible from the current camera. */
    private Walk step(Vec3d horizontal, boolean sprint, boolean allowWater) {
        Vec3d feet = c.player.getPos();
        float requested = yaw(horizontal);
        if (Float.isNaN(routeRequest) || Math.abs(MathHelper.wrapDegrees(requested - routeRequest)) > 24
            || tick - routeTick > 2) {
            routeRequest = routeYaw = requested;
            routeUntil = tick;
        }
        routeTick = tick;
        if (tick >= routeUntil) routeYaw = requested;
        if (stuck >= 13) return Walk.BLOCKED;
        float facing = c.player.getYaw();
        Vec3d lane = forward(routeYaw);
        boolean closeLook = c.player.getPitch() > 32;
        Footing planned = footing(feet, lane, allowWater, closeLook);
        if (planned == Footing.UNKNOWN || planned == Footing.BLOCKED || planned == Footing.EDGE) {
            // Compare already-visible near lanes before committing to a recovery turn.
            int best = 0;
            float candidate = routeYaw;
            for (int side = -1; side <= 1; side += 2) {
                float bearing = requested + side * 23;
                Vec3d other = forward(bearing);
                Footing ground = footing(feet, other, allowWater, closeLook);
                int score = switch (ground) {
                    case LEVEL -> 4;
                    case DOWN -> 3;
                    case JUMP, WATER -> 2;
                    case STEEP -> 1;
                    default -> 0;
                };
                if (score != 0 && horizon(feet, other) != null) score++;
                if (score > best) {
                    best = score;
                    candidate = bearing;
                    planned = ground;
                }
            }
            if (best > 0) {
                routeYaw = candidate;
                routeUntil = tick + 14;
                lane = forward(routeYaw);
            }
        }
        double turn = Math.abs(MathHelper.wrapDegrees(routeYaw - facing));
        BlockHitResult distant = horizon(feet, lane);
        float pitch = 17;
        if (distant != null) {
            pitch = (float) MathHelper.clamp(Math.toDegrees(Math.atan2(
                c.player.getEyeY() - distant.getPos().y, horizontalDistance(feet, distant.getPos()))), 10, 23);
        }
        if (planned == Footing.STEEP || planned == Footing.UNKNOWN || planned == Footing.EDGE) pitch = 39;
        else if (planned == Footing.BLOCKED) pitch = 25;
        body.turn(routeYaw, pitch);
        if (turn > 16) return Walk.LOOKING;

        // W follows actual facing during a smooth turn, not the intended bearing.
        Footing actual = turn < 3 ? planned : footing(feet, forward(facing), allowWater, closeLook);
        if (actual == Footing.UNKNOWN && !closeLook && planned != Footing.BLOCKED) return Walk.LOOKING;
        if (actual == Footing.BLOCKED && turn > 5) return Walk.LOOKING;
        if (actual == Footing.BLOCKED || actual == Footing.UNKNOWN) return Walk.BLOCKED;
        if (actual == Footing.EDGE) {
            if (turn > 5) return Walk.LOOKING;
            body.sneak();
            walk(false);
            return Walk.MOVING;
        }
        if (actual == Footing.JUMP || c.player.isTouchingWater()) body.jump();
        // The close proof below is stronger than Body's conservative pitch-dependent edge heuristic.
        walkDown(sprint && actual == Footing.LEVEL);
        return Walk.MOVING;
    }

    private BlockHitResult horizon(Vec3d feet, Vec3d lane) {
        Vec3d ahead = feet.add(lane.multiply(5.4));
        Vec3d eye = c.player.getEyePos();
        for (int i = 0; i < 2; i++) {
            Vec3d point = ahead.add(0, i == 0 ? -0.55 : -2.4, 0);
            BlockHitResult floor = terrain(point, eye.distanceTo(point) + 0.2);
            if (floor != null && floor.getSide() == Direction.UP
                && horizontalDistance(feet, floor.getPos()) > 2.7 && safeSupport(floor)) return floor;
        }
        return null;
    }

    private Footing footing(Vec3d feet, Vec3d heading, boolean allowWater, boolean closeLook) {
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
        for (int i = 0; i < (closeLook ? FLOOR_FORWARD.length : FLOOR_FORWARD.length - 1); ++i) {
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
            // A large drop requires a close view of the immediate landing, not a distant opposite bank.
            if (drop > 2.65 || drop > 1.05 && (!closeLook || ahead > 1.65)) continue;
            result = drop > 1.05 ? Footing.STEEP : drop > 0.42 ? Footing.DOWN : Footing.LEVEL;
        }
        return result;
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
