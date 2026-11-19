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
    private static final float[] DETOURS = {38, -38, 68, -68, 108, -108, 155};
    private static final double[] FLOOR_FORWARD = {1.55, 1.95, 2.32, 2.65};
    private static final double[] FLOOR_BELOW = {0.55, 1.45, 2.45, 2.9};
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
    private static final Predicate<ItemStack> RAW_IRON = item(Items.RAW_IRON);
    private static final Predicate<ItemStack> INGOT = item(Items.IRON_INGOT);
    private static final Predicate<ItemStack> TORCH = item(Items.TORCH);
    private static final Predicate<ItemStack> FOOD = stack -> stack.contains(DataComponentTypes.FOOD)
        && !stack.isOf(Items.ROTTEN_FLESH) && !stack.isOf(Items.SPIDER_EYE)
        && !stack.isOf(Items.POISONOUS_POTATO) && !stack.isOf(Items.PUFFERFISH)
        && !stack.isOf(Items.CHICKEN);

    private enum Resource {
        WOOD(state -> state.isIn(BlockTags.LOGS), LOG, "wood"),
        STONE(state -> state.isOf(Blocks.STONE) || state.isOf(Blocks.COBBLESTONE)
            || state.isOf(Blocks.DEEPSLATE) || state.isOf(Blocks.COBBLED_DEEPSLATE)
            || state.isOf(Blocks.BLACKSTONE), PilotProgress.STONE, "stone"),
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
    private enum Dig { LOOKING, CLEAR, BLOCKED }
    private enum Firing { NONE, IRON, CHARCOAL }

    private static final class Station {
        final Block block;
        final Predicate<ItemStack> item;
        final String recipe;
        BlockPos position;
        int attempt;
        int opened;
        int openAttempts;
        float placementYaw = Float.NaN;

        Station(Block block, Item item, String recipe) {
            this.block = block;
            this.item = PilotProgress.item(item);
            this.recipe = recipe;
        }
    }

    private final MinecraftClient c;
    private final PilotBody body;
    private final PilotHands hands;
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
    private Firing firing = Firing.NONE;
    private int furnacePoll;
    private int furnaceDeadline;
    private Resource sought;
    private int soughtSince;
    private Resource miningResource;
    private BlockPos target;
    private Vec3d targetPoint;
    private int targetAge;
    private int lastMining;
    private final BlockPos[] ignored = new BlockPos[6];
    private final int[] ignoredUntil = new int[ignored.length];
    private int ignoreCursor;
    private int seekAfter;
    private int pickupUntil;
    private int pickupBlockedUntil;
    private Entity pickupEntity;
    private int pickupStarted;
    private float heading = Float.NaN;
    private int headingUntil;
    private int turns;
    private Vec3d motionPosition;
    private int motionTick;
    private int stuck;
    private int swimStall;
    private Vec3d approachGoal;
    private Vec3d detourStart;
    private int detourIndex = -1;
    private int detourDeadline;
    private float detourYaw;
    private int retreatUntil;
    private float retreatYaw;
    private float previousHealth = Float.NaN;
    private Direction digDirection;
    private BlockPos nextFoot;
    private int clearIndex;
    private int digAge;
    private int legLength;
    private int branchTurns;
    private int failedDirections;
    private int returnIndex = -1;
    private int returnAge;
    private int returnClear;
    private int nextDigStart;
    private int litIndex;
    private int torchAttempt;

    PilotProgress(MinecraftClient c, PilotBody body, PilotHands hands, String goal) {
        this.c = c;
        this.body = body;
        this.hands = hands;
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
        if (has(goalItem, 1)) {
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
        if (returnIndex >= 0) {
            retreatTunnel();
            return;
        }

        boolean ironPick = has(IRON_PICK, 1);
        boolean stonePick = has(STONE_PICK, 1);
        boolean woodPick = has(WOOD_PICK, 1);
        if (!woodPick && !stonePick && !ironPick) {
            if (has(STONE, 3)) makePick("stone_pickaxe", STONE, 3);
            else makePick("wooden_pickaxe", PLANK, 3);
            return;
        }
        if (!stonePick && !ironPick) {
            if (has(STONE, 3)) makePick("stone_pickaxe", STONE, 3);
            else gather(Resource.STONE, 170, 42);
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
        int torchReserve = trail.size() < 3 && c.player.getY() > 24 ? 16 : 2;
        if (!has(TORCH, torchReserve) && has(FUEL, 1) && has(STICK, 1)) {
            status = "crafting torches";
            hands.craft("torch");
            return;
        }
        if (!has(PLANK, trail.isEmpty() ? 12 : 4)) {
            supplyPlanks(trail.isEmpty() ? 12 : 4);
            return;
        }
        if (!has(STICK, 4)) {
            status = "crafting spare sticks";
            hands.craft("stick");
            return;
        }
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
            tableRecipe = null;
            status = "crafting " + recipe;
            if (!hands.craft(recipe)) c.currentScreen.close();
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
        if (!ensureTableItemOrPosition(plankCost + (has(STICK, 2) ? 0 : 2))) return;
        if (!has(STICK, 2)) {
            if (supplyPlanks(plankCost + 2)) {
                status = "crafting sticks";
                hands.craft("stick");
            }
            return;
        }
        if (!has(ingredient, quantity)) {
            if (ingredient == PLANK) supplyPlanks(quantity);
            return;
        }
        tableRecipe = recipe;
        useStation(table);
    }

    private boolean ensureTableItemOrPosition(int reserve) {
        if (table.position != null || has(table.item, 1)) return true;
        if (collect(table.item, 6)) return false;
        if (supplyPlanks(4 + reserve)) {
            status = "crafting a table";
            hands.craft("crafting_table");
        }
        return false;
    }

    private boolean supplyPlanks(int quantity) {
        if (has(PLANK, quantity)) return true;
        if (has(LOG, 1)) {
            status = "turning logs into planks";
            hands.craft("planks");
        } else if (trail.size() > 1) {
            beginReturn();
            retreatTunnel();
        } else {
            gather(Resource.WOOD, Integer.MAX_VALUE, 0);
        }
        return false;
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
                    gather(Resource.STONE, 35, 32);
                    return;
                }
                if (!ensureTableItemOrPosition(0)) return;
                tableRecipe = "furnace";
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
            if (distance > 3.75) {
                if (distance > 9 || tick - station.attempt > 95
                    || approach(center, false, false) == Walk.BLOCKED) {
                    station.position = null;
                }
                return;
            }
            body.aim(center);
            if (!body.aligned(center)) return;
            BlockHitResult hit = perceive(center, REACH);
            if (hit != null && hit.getBlockPos().equals(station.position) && state(hit).isOf(station.block)) {
                station.attempt = tick;
                if (station.openAttempts >= 5 && distance > 2.2) {
                    station.openAttempts = 0;
                    walkToward(center, false, false);
                    return;
                }
                if (tick - station.opened > 7) {
                    body.use(hit.getBlockPos(), hit.getSide());
                    station.opened = tick;
                    station.openAttempts++;
                }
            } else if (tick - station.attempt > 16) {
                station.position = null;
            }
            return;
        }
        BlockHitResult seen = body.find(state -> state.isOf(station.block), 5.0).orElse(null);
        if (seen != null) {
            station.position = seen.getBlockPos();
            station.attempt = tick;
            return;
        }
        if (!hold(station.item)) return;
        if (Float.isNaN(station.placementYaw)) station.placementYaw = c.player.getYaw();
        Vec3d point = c.player.getPos().add(forward(station.placementYaw).multiply(1.95)).add(0, -0.25, 0);
        body.sneak();
        body.aim(point);
        if (!body.aligned(point) || !c.player.isSneaking()) return;
        BlockHitResult support = perceive(point, REACH);
        if (support != null && support.getSide() == Direction.UP && safeSupport(support)) {
            BlockPos placement = support.getBlockPos().up();
            if (!c.player.getBoundingBox().intersects(new Box(placement))) {
                body.use(support.getBlockPos(), Direction.UP);
                station.position = placement;
                station.attempt = tick;
                station.openAttempts = 0;
            }
        }
        // Turn for another ordinary placement angle if this one is blocked.
        station.placementYaw += 90;
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
        if (tick < pickupUntil) return;
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
        if (resource != Resource.WOOD && (trail.size() > 1 || tick - soughtSince > onSurfaceTicks)
            && tick >= nextDigStart && (c.player.isOnGround() || !trail.isEmpty()) && !c.player.isTouchingWater()) {
            excavate(depth);
        } else {
            explore();
        }
    }

    private void setTarget(BlockHitResult hit, Resource resource) {
        target = hit.getBlockPos();
        miningResource = resource;
        // A tiny inset retains the known face direction even after a small perspective change.
        targetPoint = hit.getPos().lerp(Vec3d.ofCenter(target), 0.045);
        targetAge = tick;
        lastMining = 0;
        approachGoal = null;
    }

    private void mineTarget(Resource resource) {
        status = "mining " + resource.label;
        if (tick - targetAge > 230) {
            abandonTarget();
            return;
        }
        if (c.player.getEyePos().distanceTo(targetPoint) > REACH - 0.45) {
            status = "approaching " + resource.label;
            if (approach(targetPoint, false, false) == Walk.BLOCKED) abandonTarget();
            return;
        }
        body.aim(targetPoint);
        if (!body.aligned(targetPoint)) return;
        BlockHitResult hit = perceive(targetPoint, REACH);
        if (hit == null || !hit.getBlockPos().equals(target) || !resource.block.test(state(hit))) {
            if (lastMining != 0 && tick - lastMining < 5) {
                pickupUntil = tick + 13;
                target = null;
            } else {
                abandonTarget();
            }
            return;
        }
        Predicate<ItemStack> tool = toolFor(state(hit));
        if (tool != null && !hold(tool)) {
            if (!has(tool, 1)) abandonTarget();
            return;
        }
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
        if (entity == null) return false;
        Vec3d position = entity.getPos();
        Vec3d delta = position.subtract(c.player.getPos());
        if (delta.getY() > 1.3 || delta.getY() < -1.35) return false;
        if (pickupEntity != entity) {
            pickupEntity = entity;
            pickupStarted = tick;
        }
        if (tick - pickupStarted > 45) {
            pickupEntity = null;
            pickupBlockedUntil = tick + 45;
            return false;
        }
        if (delta.horizontalLengthSquared() < 0.22) {
            if (delta.getY() > 0.55) body.jump();
            return true;
        }
        if (approach(position, false, false) == Walk.BLOCKED) {
            pickupBlockedUntil = tick + 32;
            return false;
        }
        status = "collecting visible drops";
        return true;
    }

    private void excavate(int depth) {
        if (trail.size() == 1
            && horizontalDistance(Vec3d.ofBottomCenter(trail.getFirst()), c.player.getPos()) > 1.2) {
            trail.clear();
            nextFoot = null;
        }
        if (trail.isEmpty()) {
            trail.add(c.player.getBlockPos());
            digDirection = c.player.getHorizontalFacing();
            branchTurns = failedDirections = legLength = litIndex = 0;
        }
        BlockPos current = trail.getLast();
        if (current.getY() > depth) status = "descending a mined staircase";
        else status = "branch mining at y=" + current.getY();
        if (nextFoot == null) {
            if (shouldLight()) return;
            if (current.getY() <= depth && legLength >= 22) {
                digDirection = (branchTurns++ & 1) == 0
                    ? digDirection.rotateYClockwise() : digDirection.rotateYCounterclockwise();
                legLength = 0;
            }
            nextFoot = current.offset(digDirection);
            if (current.getY() > depth) nextFoot = nextFoot.down();
            clearIndex = nextFoot.getY() < current.getY() ? 2 : 1;
            digAge = tick;
        }
        if (tick - digAge > 205 || horizontalDistance(Vec3d.ofBottomCenter(current), c.player.getPos()) > 2.1) {
            blockedTunnel();
            return;
        }
        if (clearIndex >= 0) {
            Dig result = clear(nextFoot.up(clearIndex));
            if (result == Dig.CLEAR) clearIndex--;
            else if (result == Dig.BLOCKED) blockedTunnel();
            return;
        }
        if (arrived(nextFoot)) {
            trail.add(nextFoot);
            nextFoot = null;
            failedDirections = 0;
            legLength++;
            return;
        }
        Vec3d support = Vec3d.ofCenter(nextFoot.down(), 0.48);
        body.aim(support);
        if (!body.aligned(support)) return;
        BlockHitResult hit = perceive(support, REACH);
        if (hit == null || !hit.getBlockPos().equals(nextFoot.down()) || hit.getSide() != Direction.UP
            || !safeSupport(hit)) {
            blockedTunnel();
            return;
        }
        if (nextFoot.getY() < current.getY()) walkDown(false);
        else walk(false);
    }

    private Dig clear(BlockPos position) {
        Vec3d point = Vec3d.ofCenter(position);
        body.aim(point);
        if (!body.aligned(point)) return Dig.LOOKING;
        double length = c.player.getEyePos().distanceTo(point);
        BlockHitResult hit = perceive(point, length + 0.18);
        if (hit == null) {
            if (!body.outlined(position)) return Dig.CLEAR;
            // The vanilla target outline permits breaking an intended face, not identifying it.
            Predicate<ItemStack> tool = has(IRON_PICK, 1) ? IRON_PICK : has(STONE_PICK, 1) ? STONE_PICK : WOOD_PICK;
            if (!hold(tool)) return has(tool, 1) ? Dig.LOOKING : Dig.BLOCKED;
            body.mine(position);
            return Dig.LOOKING;
        }
        if (!hit.getBlockPos().equals(position)) {
            return c.player.getEyePos().distanceTo(hit.getPos()) < length - 0.17 ? Dig.BLOCKED : Dig.CLEAR;
        }
        BlockState state = state(hit);
        if (state.isReplaceable() && state.getFluidState().isEmpty()) return Dig.CLEAR;
        if (dangerous(state) || !state.getFluidState().isEmpty()
            || state.getHardness(c.world, position) < 0 || state.isOf(Blocks.OBSIDIAN)
            || state.isOf(Blocks.CRYING_OBSIDIAN)
            || state.isOf(Blocks.FURNACE) && firing != Firing.NONE) return Dig.BLOCKED;
        Predicate<ItemStack> tool = toolFor(state);
        if (tool != null && !hold(tool)) return has(tool, 1) ? Dig.LOOKING : Dig.BLOCKED;
        body.mine(position);
        return Dig.LOOKING;
    }

    private boolean shouldLight() {
        if (trail.size() - litIndex < 7 || !has(TORCH, 1)) return false;
        if (torchAttempt == 0) torchAttempt = tick;
        if (tick - torchAttempt > 17) {
            torchAttempt = 0;
            litIndex = trail.size();
            return false;
        }
        if (!hold(TORCH)) return true;
        Direction wall = digDirection.rotateYClockwise();
        Vec3d point = Vec3d.ofCenter(c.player.getBlockPos().offset(wall));
        body.aim(point);
        if (!body.aligned(point)) return true;
        BlockHitResult hit = perceive(point, 2.2);
        if (hit != null && safeSupport(hit)) body.use(hit.getBlockPos(), hit.getSide());
        torchAttempt = 0;
        litIndex = trail.size();
        return true;
    }

    private void blockedTunnel() {
        nextFoot = null;
        if (++failedDirections == 4) {
            beginReturn();
        } else {
            digDirection = digDirection.rotateYClockwise();
            legLength = 0;
        }
    }

    private void beginReturn() {
        returnIndex = trail.size() - 1;
        returnAge = tick;
        returnClear = -1;
        nextFoot = null;
    }

    private void retreatTunnel() {
        status = "returning along traveled steps";
        if (returnIndex < 0) return;
        BlockPos next = trail.get(returnIndex);
        if (arrived(next)) {
            returnAge = tick;
            returnClear = -1;
            if (--returnIndex >= 0) return;
            trail.clear();
            nextDigStart = tick + 170;
            headingUntil = tick;
            return;
        }
        if (tick - returnAge > 165) {
            // Don't assert an unobserved route is still available after a collapse or detour.
            trail.clear();
            returnIndex = -1;
            nextDigStart = tick + 150;
            headingUntil = tick;
            return;
        }
        if (returnClear >= 0) {
            if (clear(next.up(returnClear)) != Dig.LOOKING) returnClear--;
            return;
        }
        if (walkToward(Vec3d.ofBottomCenter(next), false, false) == Walk.BLOCKED) returnClear = 1;
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
        if (Float.isNaN(heading)) heading = c.player.getYaw();
        if (tick >= headingUntil) {
            if (headingUntil != 0) heading += (++turns % 2 == 0 ? -1 : 1) * 24;
            headingUntil = tick + 460;
        }
        if (step(forward(heading), false, true) == Walk.BLOCKED) {
            heading += (++turns % 5 == 0 ? -1 : 1) * 68;
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
        if (approachGoal == null || horizontalDistance(point, approachGoal) > 1.15) {
            approachGoal = point;
            detourIndex = -1;
        }
        if (detourIndex >= 0 && horizontalDistance(feet, detourStart) >= 1.15) detourIndex = -1;
        if (detourIndex < 0) {
            Walk result = walkToward(point, sprint, allowWater);
            if (result != Walk.BLOCKED) return result;
        }
        if (detourIndex >= 0 && tick < detourDeadline) {
            Walk result = step(forward(detourYaw), false, allowWater);
            if (result != Walk.BLOCKED) return result;
        }
        if (++detourIndex >= DETOURS.length) {
            approachGoal = null;
            return Walk.BLOCKED;
        }
        detourYaw = yaw(point.subtract(feet)) + DETOURS[detourIndex];
        detourStart = feet;
        detourDeadline = tick + 43;
        body.turn(detourYaw, 37);
        return Walk.LOOKING;
    }

    /** Forward movement requires a fresh floor/step observation, never a hidden navigation grid. */
    private Walk step(Vec3d horizontal, boolean sprint, boolean allowWater) {
        Vec3d feet = c.player.getPos();
        Vec3d look = feet.add(horizontal.multiply(2.2)).add(0, -0.05, 0);
        body.aim(look);
        if (!body.aligned(look)) return Walk.LOOKING;
        if (stuck >= 13) return Walk.BLOCKED;
        BlockHitResult shin = terrain(feet.add(horizontal.multiply(1.45)).add(0, 0.24, 0), 2.15);
        BlockHitResult head = terrain(feet.add(horizontal.multiply(1.45)).add(0, 1.35, 0), 1.5);
        if (shin != null && dangerous(state(shin)) || head != null && dangerous(state(head))) return Walk.BLOCKED;
        BlockHitResult near = perceive(feet.add(horizontal.multiply(1.4)).add(0, 0.15, 0), 1.6);
        if (near != null && dangerous(state(near))) return Walk.BLOCKED;
        if (c.player.isTouchingWater()) {
            body.jump();
            if (head != null && solid(head)) return ++swimStall < 18 ? Walk.LOOKING : Walk.BLOCKED;
            swimStall = 0;
            walk(sprint);
            return Walk.MOVING;
        }
        swimStall = 0;
        if (head != null && solid(head)) return Walk.BLOCKED;
        if (shin != null && shin.getPos().getY() > feet.getY() + 0.07 && solid(shin)) {
            double height = shin.getBlockPos().getY() + 1 - feet.getY();
            if (height > 1.05) return Walk.BLOCKED;
            body.jump();
            walk(false);
            return Walk.MOVING;
        }
        Vec3d eye = c.player.getEyePos();
        for (int i = 0; i < FLOOR_FORWARD.length; ++i) {
            Vec3d point = feet.add(horizontal.multiply(FLOOR_FORWARD[i])).add(0, -FLOOR_BELOW[i], 0);
            BlockHitResult floor = terrain(point, eye.distanceTo(point) + 0.16);
            if (floor == null) continue;
            BlockState state = state(floor);
            if (dangerous(state)) return Walk.BLOCKED;
            double ahead = horizontalDistance(feet, floor.getPos());
            if (ahead < 0.46 || ahead > 2.33) continue;
            if (state.getFluidState().isIn(FluidTags.WATER)) {
                if (!allowWater) return Walk.BLOCKED;
                walkDown(false);
                return Walk.MOVING;
            }
            if (floor.getSide() != Direction.UP || !safeSupport(floor)) continue;
            double drop = feet.getY() - floor.getPos().getY();
            // A further surface may be on the opposite side of a gap, not the landing.
            if (drop > 2.65 || drop > 1.05 && ahead > 2.05) continue;
            if (drop > 0.38) walkDown(false);
            else walk(sprint);
            return Walk.MOVING;
        }
        return Walk.BLOCKED;
    }

    private void trackMotion() {
        if (motionTick == tick - 1 && motionPosition != null) {
            if (horizontalDistance(motionPosition, c.player.getPos()) < 0.045) stuck++;
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
        return horizontalDistance(c.player.getPos(), Vec3d.ofBottomCenter(position)) < 0.37
            && Math.abs(c.player.getY() - position.getY()) < 0.25 && c.player.isOnGround();
    }

    private Predicate<ItemStack> toolFor(BlockState state) {
        if (Resource.DIAMOND.block.test(state)) return IRON_PICK;
        if (Resource.IRON.block.test(state)) return has(STONE_PICK, 1) ? STONE_PICK : IRON_PICK;
        if (!state.isIn(BlockTags.PICKAXE_MINEABLE)) return null;
        if (has(STONE_PICK, 1)) return STONE_PICK;
        if (has(WOOD_PICK, 1)) return WOOD_PICK;
        return IRON_PICK;
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

    private static Vec3d forward(float yaw) {
        double radians = Math.toRadians(yaw);
        return new Vec3d(-Math.sin(radians), 0, Math.cos(radians));
    }
}
